import type * as NodeHttp from "http";
import type { Logger } from "../log";
import { API_BASE, parseEnvelope, FeishuAuthRequiredError, requestWithBudget } from "./client";

export type AuthMode = "user" | "tenant";

export interface UserTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scope?: string;
}

export interface AuthSettings {
  mode: AuthMode;
  appId: string;
  appSecret: string;
  oauthScope: string;
  redirectUri: string;
}

const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
const REFRESH_MARGIN_MS = 120_000;

function oauthErrorHint(code: number | undefined, message: string): string {
  const hints: Record<number, string> = {
    20010: "当前飞书账号不在这个应用的可用范围内：请到开发者后台的「应用发布 → 版本管理与发布」把可用范围设为全员或包含你自己，并发布版本",
    20027: "请求了应用尚未开通的权限：请到开发者后台「权限管理」开通 drive:drive、wiki:wiki、docs:document.media:download、offline_access，并确认插件里的授权范围与之一致",
    20029: "重定向 URL 不匹配：请确认开发者后台「安全设置 → 重定向 URL」里登记的地址与插件设置里的完全一致",
  };
  const hinted = code === undefined ? undefined : hints[code];
  const hint = hinted ?? (/revoked|invalid_grant/i.test(message)
    ? "refresh token 一次性有效：通常是同一个飞书应用在别处（另一台设备、另一个 Obsidian 实例，或命令行工具）刷新过 token，导致这里这份被作废。重新授权即可"
    : undefined);
  return hint ? `${message}（${hint}）` : message;
}

function loadHttp(): typeof NodeHttp | null {
  const requireFn = (globalThis as unknown as { require?: (module: string) => unknown }).require;
  if (!requireFn) return null;
  try {
    return requireFn("http") as typeof NodeHttp;
  } catch {
    return null;
  }
}

export function openExternal(url: string): void {
  const requireFn = (globalThis as unknown as { require?: (module: string) => unknown }).require;
  try {
    const electron = requireFn?.("electron") as { shell?: { openExternal?: (target: string) => void } } | undefined;
    if (electron?.shell?.openExternal) {
      electron.shell.openExternal(url);
      return;
    }
  } catch {
    // fall through to window.open
  }
  window.open(url);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
  data?: TokenResponse;
}

export class AuthManager {
  private tenant?: { token: string; expiresAt: number };
  private callbackServer?: { close: () => void };
  private userRefresh?: Promise<string>;
  private tenantKey?: string;

  constructor(
    private readonly config: () => AuthSettings,
    private readonly readTokens: () => UserTokens | undefined,
    private readonly writeTokens: (tokens: UserTokens | undefined) => Promise<void>,
    private readonly log: Logger,
  ) {}

  hasValidUserGrant(): boolean {
    const tokens = this.readTokens();
    if (!tokens?.refreshToken) return false;
    return tokens.refreshExpiresAt > Date.now();
  }

  async getToken(forceRefresh = false): Promise<string> {
    const config = this.config();
    if (!config.appId || !config.appSecret) {
      throw new FeishuAuthRequiredError("请先在插件设置里填写飞书应用的 App ID 与 App Secret");
    }
    return config.mode === "tenant" ? this.tenantToken(forceRefresh) : this.userToken(forceRefresh);
  }

  private async tenantToken(forceRefresh: boolean): Promise<string> {
    const now = Date.now();
    const config = this.config();
    const key = `${config.appId}:${config.appSecret}`;
    if (!forceRefresh && this.tenantKey === key && this.tenant && this.tenant.expiresAt - REFRESH_MARGIN_MS > now) {
      return this.tenant.token;
    }
    const response = await requestWithBudget({
      url: `${API_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
      throw: false,
    });
    const payload = parseEnvelope(response.text) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number } | undefined;
    if (response.status >= 400 || !payload || payload.code !== 0 || !payload.tenant_access_token) {
      throw new FeishuAuthRequiredError(`获取 tenant_access_token 失败：${payload?.msg ?? `HTTP ${response.status}`}`);
    }
    const expiresIn = payload.expire ?? 7200;
    this.tenant = { token: payload.tenant_access_token, expiresAt: Date.now() + expiresIn * 1000 };
    this.tenantKey = key;
    return this.tenant.token;
  }

  private async userToken(forceRefresh: boolean): Promise<string> {
    if (this.userRefresh) return this.userRefresh;
    const tokens = this.readTokens();
    if (!tokens?.refreshToken) {
      throw new FeishuAuthRequiredError("尚未完成用户授权，请在插件设置里点击「授权飞书账号」");
    }
    const now = Date.now();
    if (!forceRefresh && tokens.accessToken && tokens.accessExpiresAt - REFRESH_MARGIN_MS > now) {
      return tokens.accessToken;
    }
    if (tokens.refreshExpiresAt - REFRESH_MARGIN_MS <= now) {
      throw new FeishuAuthRequiredError("用户授权的 refresh token 已过期，请重新授权");
    }
    this.userRefresh = this.refreshUserToken(tokens);
    try {
      return await this.userRefresh;
    } finally {
      this.userRefresh = undefined;
    }
  }

  private async refreshUserToken(tokens: UserTokens): Promise<string> {
    const config = this.config();
    const payload = await this.postToken({
      grant_type: "refresh_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      refresh_token: tokens.refreshToken,
    });
    const refreshed = this.toTokens(payload, tokens);
    if (this.readTokens() !== tokens || this.config().appId !== config.appId || this.config().appSecret !== config.appSecret) {
      throw new FeishuAuthRequiredError("授权配置在刷新期间已改变，请重新授权");
    }
    await this.writeTokens(refreshed);
    this.log.debug("已刷新 user_access_token");
    return refreshed.accessToken;
  }

  buildAuthorizeUrl(state: string): string {
    const config = this.config();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", config.appId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    if (config.oauthScope.trim()) url.searchParams.set("scope", config.oauthScope.trim());
    return url.toString();
  }

  async exchangeCode(code: string): Promise<UserTokens> {
    const config = this.config();
    const payload = await this.postToken({
      grant_type: "authorization_code",
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
      redirect_uri: config.redirectUri,
    });
    const tokens = this.toTokens(payload, undefined);
    await this.writeTokens(tokens);
    return tokens;
  }

  startCallbackServer(expectedState?: string): { waitForCode: () => Promise<string>; close: () => void } {
    this.cancelAuthorization();
    const http = loadHttp();
    if (!http) {
      throw new Error("当前环境无法启动本地回调服务，请使用「手动粘贴授权码」方式");
    }
    const config = this.config();
    const redirect = new URL(config.redirectUri);
    if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)) {
      throw new Error("自动授权需要 http://localhost、127.0.0.1 或 [::1] 回调地址；其他地址请用手动授权");
    }
    const port = redirect.port ? Number(redirect.port) : 80;
    const expectedPath = redirect.pathname || "/callback";

    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // Cancellation can happen before waitForCode is attached (for example during plugin unload).
    void codePromise.catch(() => undefined);

    const server = http.createServer((req, res) => {
      const requestUrlValue = req.url ?? "/";
      const parsed = new URL(requestUrlValue, `http://localhost:${port}`);
      if (parsed.pathname !== expectedPath) {
        res.writeHead(404).end("not found");
        return;
      }
      const code = parsed.searchParams.get("code");
      const error = parsed.searchParams.get("error");
      const receivedState = parsed.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (expectedState && receivedState !== expectedState) {
        res.end("<html><body><h3>授权失败：state 校验不通过，请重新发起授权。</h3></body></html>");
        rejectCode(new Error("授权失败：state 校验不通过"));
        return;
      }
      if (code) {
        res.end("<html><body><h3>授权成功，可以关闭本页面并回到 Obsidian。</h3></body></html>");
        resolveCode(code);
      } else {
        res.end("<html><body><h3>授权未完成，请返回 Obsidian 查看错误。</h3></body></html>");
        rejectCode(new Error(`授权失败：${error ?? "未收到 code"}`));
      }
    });

    const timeout = window.setTimeout(() => rejectCode(new Error("等待授权超时（5 分钟），请重试")), 5 * 60 * 1000);
    server.on("error", (error) => rejectCode(error instanceof Error ? error : new Error(String(error))));

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      window.clearTimeout(timeout);
      server.close();
      rejectCode(new Error("授权已取消"));
    };

    server.listen(port, redirect.hostname === "[::1]" ? "::1" : redirect.hostname);
    this.callbackServer = { close };

    return {
      waitForCode: async () => {
        try {
          return await codePromise;
        } finally {
          close();
        }
      },
      close,
    };
  }

  closeCallbackServer(): void {
    this.callbackServer?.close();
    this.callbackServer = undefined;
  }

  cancelAuthorization(): void {
    this.closeCallbackServer();
  }

  private async postToken(body: Record<string, string>): Promise<TokenResponse> {
    const form = new URLSearchParams(body).toString();
    const response = await requestWithBudget({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: form,
      throw: false,
    });
    const parsed = (parseEnvelope(response.text) ?? {}) as TokenResponse;
    const merged = parsed.data ?? parsed;
    if (response.status >= 400 || (typeof parsed.code === "number" && parsed.code !== 0) || !merged.access_token) {
      const code = typeof parsed.code === "number" ? parsed.code : undefined;
      const reason = parsed.error_description ?? parsed.error ?? parsed.msg ?? `HTTP ${response.status}`;
      throw new FeishuAuthRequiredError(`获取用户授权失败：${oauthErrorHint(code, reason)}`);
    }
    return merged;
  }

  private toTokens(payload: TokenResponse, previous: UserTokens | undefined): UserTokens {
    const now = Date.now();
    return {
      accessToken: payload.access_token ?? "",
      refreshToken: payload.refresh_token ?? previous?.refreshToken ?? "",
      accessExpiresAt: now + (payload.expires_in ?? 7200) * 1000,
      refreshExpiresAt: payload.refresh_token_expires_in ? now + payload.refresh_token_expires_in * 1000 : (previous?.refreshExpiresAt ?? now + 30 * 24 * 3600 * 1000),
      scope: payload.scope ?? previous?.scope,
    };
  }
}
