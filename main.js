"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => FeishuWikiSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian15 = require("obsidian");

// src/feishu/auth.ts
var import_obsidian2 = require("obsidian");

// src/feishu/client.ts
var import_obsidian = require("obsidian");
var API_BASE = "https://open.feishu.cn";
var AUTH_CODES = /* @__PURE__ */ new Set([99991661, 99991663, 99991664, 99991668, 99991677, 20005]);
var RETRY_CODES = /* @__PURE__ */ new Set([99991400, 1061045, 233523001]);
var MAX_ATTEMPTS = 4;
var REQUEST_TIMEOUT_MS = 6e4;
var SLOW_REQUEST_TIMEOUT_MS = 5 * 6e4;
var SLOW_PATH_PREFIX = "/open-apis/docs_ai/";
var RequestTimeoutError = class extends Error {
};
var budgetOverrideForTest;
function requestBudget(path, multipart) {
  if (budgetOverrideForTest !== void 0)
    return budgetOverrideForTest;
  return multipart || path.startsWith(SLOW_PATH_PREFIX) ? SLOW_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}
async function requestWithBudget(options, budgetMs) {
  let timer;
  try {
    return await Promise.race([
      (0, import_obsidian.requestUrl)(options),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new RequestTimeoutError(`\u8D85\u8FC7 ${Math.round(budgetMs / 1e3)} \u79D2\u6CA1\u6709\u54CD\u5E94`)),
          budgetMs
        );
      })
    ]);
  } finally {
    if (timer !== void 0)
      clearTimeout(timer);
  }
}
var FeishuError = class extends Error {
  constructor(message, init) {
    super(message);
    this.name = "FeishuError";
    this.code = init.code ?? -1;
    this.status = init.status ?? 0;
    this.endpoint = init.endpoint;
    this.logId = init.logId;
    this.authRelated = this.status === 401 || AUTH_CODES.has(this.code);
  }
  describe() {
    const parts = [this.message];
    if (this.code !== -1)
      parts.push(`code=${this.code}`);
    if (this.status)
      parts.push(`HTTP ${this.status}`);
    if (this.logId)
      parts.push(`log_id=${this.logId}`);
    return parts.join(" \xB7 ");
  }
};
var FeishuAuthRequiredError = class extends Error {
  constructor(message = "\u98DE\u4E66\u6388\u6743\u5DF2\u5931\u6548\uFF0C\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u91CD\u65B0\u6388\u6743") {
    super(message);
    this.name = "FeishuAuthRequiredError";
  }
};
function buildUrl(path, query) {
  const url = new URL(path.startsWith("http") ? path : `${API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === void 0)
        continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
function encodeSegment(segment) {
  return encodeURIComponent(segment);
}
function pathSegment(segment) {
  return encodeSegment(segment);
}
function concatChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
function escapeMultipartValue(value) {
  return value.replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, " ");
}
function sanitizeMultipartFieldValue(value) {
  return value.replace(/\r/g, "").replace(/\n/g, " ");
}
function buildMultipart(spec) {
  const boundary = `----obsidianfeishu${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const encoder = new TextEncoder();
  const chunks = [];
  for (const [name, value] of Object.entries(spec.fields)) {
    chunks.push(
      encoder.encode(`--${boundary}\r
Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r
\r
${sanitizeMultipartFieldValue(value)}\r
`)
    );
  }
  chunks.push(
    encoder.encode(
      `--${boundary}\r
Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(spec.file.name)}"\r
Content-Type: application/octet-stream\r
\r
`
    )
  );
  chunks.push(new Uint8Array(spec.file.data));
  chunks.push(encoder.encode(`\r
--${boundary}--\r
`));
  return { body: concatChunks(chunks).buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
function parseEnvelope(text) {
  if (!text)
    return void 0;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
    return void 0;
  } catch {
    return void 0;
  }
}
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
var FeishuClient = class {
  constructor(getToken, log) {
    this.getToken = getToken;
    this.log = log;
  }
  async json(method, path, options = {}) {
    const response = await this.send(method, path, options);
    if (response.status >= 400 || response.payload && response.payload.code !== 0) {
      throw this.buildError(path, response);
    }
    const payload = response.payload;
    if (!payload) {
      throw new FeishuError(`${path} \u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94\uFF08HTTP ${response.status}\uFF09\uFF1A${(response.text || "").slice(0, 120)}`, {
        status: response.status,
        endpoint: path
      });
    }
    return payload.data ?? payload;
  }
  async binary(path, query) {
    return (await this.binaryResponse(path, query)).data;
  }
  /** 下载类请求需要 Content-Type / Content-Disposition 来推断扩展名（图片素材没有文件名）。 */
  async binaryResponse(path, query) {
    const response = await this.send("GET", path, { query });
    if (response.status < 200 || response.status >= 300) {
      throw this.buildError(path, response);
    }
    const payload = response.payload;
    if (payload && typeof payload.code === "number" && payload.code !== 0) {
      throw this.buildError(path, response);
    }
    const headers = response.headers ?? {};
    const contentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
    return { data: response.arrayBuffer, headers, contentType: contentTypeKey ? headers[contentTypeKey] : void 0 };
  }
  buildError(path, response) {
    const payload = response.payload;
    const code = typeof payload?.code === "number" ? payload.code : void 0;
    const message = typeof payload?.msg === "string" && payload.msg || (response.text || "").slice(0, 300) || "\u8BF7\u6C42\u5931\u8D25";
    return new FeishuError(`${path} \u8FD4\u56DE\u9519\u8BEF\uFF1A${message}`, {
      code,
      status: response.status,
      endpoint: path,
      logId: typeof payload?.log_id === "string" ? payload.log_id : void 0
    });
  }
  async send(method, path, options) {
    const url = buildUrl(path, options.query);
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let headers;
      let body;
      try {
        headers = { Authorization: `Bearer ${await this.getToken(attempt > 1)}` };
      } catch (error) {
        throw error;
      }
      if (options.multipart) {
        const built = buildMultipart(options.multipart);
        headers["Content-Type"] = built.contentType;
        body = built.body;
      } else if (options.body !== void 0) {
        headers["Content-Type"] = "application/json; charset=utf-8";
        body = JSON.stringify(options.body);
      }
      try {
        const response = await requestWithBudget(
          { url, method, headers, body, throw: false },
          requestBudget(path, options.multipart !== void 0)
        );
        const raw = {
          status: response.status,
          text: response.text,
          arrayBuffer: response.arrayBuffer,
          headers: response.headers ?? {},
          payload: parseEnvelope(response.text)
        };
        const code = typeof raw.payload?.code === "number" ? raw.payload.code : void 0;
        const authRelated = raw.status === 401 || code !== void 0 && AUTH_CODES.has(code);
        if (authRelated && attempt < 2) {
          this.log.debug(`${path} \u547D\u4E2D\u9274\u6743\u9519\u8BEF\uFF0C\u5237\u65B0 token \u540E\u91CD\u8BD5`);
          continue;
        }
        const uncertainRetryAllowed = !options.multipart;
        const refusedRetry = raw.status === 429 || code !== void 0 && RETRY_CODES.has(code);
        const retryable = refusedRetry || (raw.status >= 500 || raw.status === 429) && uncertainRetryAllowed;
        if (retryable && attempt < MAX_ATTEMPTS) {
          const delay = Math.min(8e3, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
          this.log.debug(`${path} \u547D\u4E2D\u53EF\u91CD\u8BD5\u9519\u8BEF\uFF08status=${raw.status} code=${code}\uFF09\uFF0C${delay}ms \u540E\u91CD\u8BD5`);
          await sleep(delay);
          continue;
        }
        return raw;
      } catch (error) {
        lastError = error;
        if (options.multipart && error instanceof RequestTimeoutError) {
          throw new FeishuError(`${path} \u8BF7\u6C42\u8D85\u65F6\uFF1A${String(error)}`, { endpoint: path });
        }
        if (!options.multipart && attempt < MAX_ATTEMPTS) {
          const delay = Math.min(8e3, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
          this.log.debug(`${path} \u7F51\u7EDC\u5F02\u5E38\uFF0C${delay}ms \u540E\u91CD\u8BD5\uFF1A${String(error)}`);
          await sleep(delay);
          continue;
        }
      }
    }
    throw new FeishuError(`${path} \u8BF7\u6C42\u5931\u8D25\uFF1A${String(lastError)}`, { endpoint: path });
  }
};

// src/feishu/auth.ts
var AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
var TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
var REFRESH_MARGIN_MS = 12e4;
function oauthErrorHint(code, message) {
  const hints = {
    20010: "\u5F53\u524D\u98DE\u4E66\u8D26\u53F7\u4E0D\u5728\u8FD9\u4E2A\u5E94\u7528\u7684\u53EF\u7528\u8303\u56F4\u5185\uFF1A\u8BF7\u5230\u5F00\u53D1\u8005\u540E\u53F0\u7684\u300C\u5E94\u7528\u53D1\u5E03 \u2192 \u7248\u672C\u7BA1\u7406\u4E0E\u53D1\u5E03\u300D\u628A\u53EF\u7528\u8303\u56F4\u8BBE\u4E3A\u5168\u5458\u6216\u5305\u542B\u4F60\u81EA\u5DF1\uFF0C\u5E76\u53D1\u5E03\u7248\u672C",
    20027: "\u8BF7\u6C42\u4E86\u5E94\u7528\u5C1A\u672A\u5F00\u901A\u7684\u6743\u9650\uFF1A\u8BF7\u5230\u5F00\u53D1\u8005\u540E\u53F0\u300C\u6743\u9650\u7BA1\u7406\u300D\u5F00\u901A drive:drive\u3001wiki:wiki\u3001docs:document.media:download\u3001offline_access\uFF0C\u5E76\u786E\u8BA4\u63D2\u4EF6\u91CC\u7684\u6388\u6743\u8303\u56F4\u4E0E\u4E4B\u4E00\u81F4",
    20029: "\u91CD\u5B9A\u5411 URL \u4E0D\u5339\u914D\uFF1A\u8BF7\u786E\u8BA4\u5F00\u53D1\u8005\u540E\u53F0\u300C\u5B89\u5168\u8BBE\u7F6E \u2192 \u91CD\u5B9A\u5411 URL\u300D\u91CC\u767B\u8BB0\u7684\u5730\u5740\u4E0E\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u7684\u5B8C\u5168\u4E00\u81F4"
  };
  const hinted = code === void 0 ? void 0 : hints[code];
  const hint = hinted ?? (/revoked|invalid_grant/i.test(message) ? "refresh token \u4E00\u6B21\u6027\u6709\u6548\uFF1A\u901A\u5E38\u662F\u540C\u4E00\u4E2A\u98DE\u4E66\u5E94\u7528\u5728\u522B\u5904\uFF08\u53E6\u4E00\u53F0\u8BBE\u5907\u3001\u53E6\u4E00\u4E2A Obsidian \u5B9E\u4F8B\uFF0C\u6216\u547D\u4EE4\u884C\u5DE5\u5177\uFF09\u5237\u65B0\u8FC7 token\uFF0C\u5BFC\u81F4\u8FD9\u91CC\u8FD9\u4EFD\u88AB\u4F5C\u5E9F\u3002\u91CD\u65B0\u6388\u6743\u5373\u53EF" : void 0);
  return hint ? `${message}\uFF08${hint}\uFF09` : message;
}
function loadHttp() {
  const requireFn = globalThis.require;
  if (!requireFn)
    return null;
  try {
    return requireFn("http");
  } catch {
    return null;
  }
}
function openExternal(url) {
  const requireFn = globalThis.require;
  try {
    const electron = requireFn?.("electron");
    if (electron?.shell?.openExternal) {
      electron.shell.openExternal(url);
      return;
    }
  } catch {
  }
  window.open(url);
}
var AuthManager = class {
  constructor(config, readTokens, writeTokens, log) {
    this.config = config;
    this.readTokens = readTokens;
    this.writeTokens = writeTokens;
    this.log = log;
  }
  hasValidUserGrant() {
    const tokens = this.readTokens();
    if (!tokens?.refreshToken)
      return false;
    return tokens.refreshExpiresAt > Date.now();
  }
  async getToken(forceRefresh = false) {
    const config = this.config();
    if (!config.appId || !config.appSecret) {
      throw new FeishuAuthRequiredError("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u586B\u5199\u98DE\u4E66\u5E94\u7528\u7684 App ID \u4E0E App Secret");
    }
    return config.mode === "tenant" ? this.tenantToken(forceRefresh) : this.userToken(forceRefresh);
  }
  async tenantToken(forceRefresh) {
    const now = Date.now();
    if (!forceRefresh && this.tenant && this.tenant.expiresAt - REFRESH_MARGIN_MS > now) {
      return this.tenant.token;
    }
    const config = this.config();
    const response = await (0, import_obsidian2.requestUrl)({
      url: `${API_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
      throw: false
    });
    const payload = parseEnvelope(response.text);
    if (response.status >= 400 || !payload || payload.code !== 0 || !payload.tenant_access_token) {
      throw new FeishuAuthRequiredError(`\u83B7\u53D6 tenant_access_token \u5931\u8D25\uFF1A${payload?.msg ?? `HTTP ${response.status}`}`);
    }
    const expiresIn = payload.expire ?? 7200;
    this.tenant = { token: payload.tenant_access_token, expiresAt: Date.now() + expiresIn * 1e3 };
    return this.tenant.token;
  }
  async userToken(forceRefresh) {
    const tokens = this.readTokens();
    if (!tokens?.refreshToken) {
      throw new FeishuAuthRequiredError("\u5C1A\u672A\u5B8C\u6210\u7528\u6237\u6388\u6743\uFF0C\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u70B9\u51FB\u300C\u6388\u6743\u98DE\u4E66\u8D26\u53F7\u300D");
    }
    const now = Date.now();
    if (!forceRefresh && tokens.accessToken && tokens.accessExpiresAt - REFRESH_MARGIN_MS > now) {
      return tokens.accessToken;
    }
    if (tokens.refreshExpiresAt - REFRESH_MARGIN_MS <= now) {
      throw new FeishuAuthRequiredError("\u7528\u6237\u6388\u6743\u7684 refresh token \u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u6388\u6743");
    }
    return this.refreshUserToken(tokens);
  }
  async refreshUserToken(tokens) {
    const config = this.config();
    const payload = await this.postToken({
      grant_type: "refresh_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      refresh_token: tokens.refreshToken
    });
    const refreshed = this.toTokens(payload, tokens);
    await this.writeTokens(refreshed);
    this.log.debug("\u5DF2\u5237\u65B0 user_access_token");
    return refreshed.accessToken;
  }
  buildAuthorizeUrl(state) {
    const config = this.config();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", config.appId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    if (config.oauthScope.trim())
      url.searchParams.set("scope", config.oauthScope.trim());
    return url.toString();
  }
  async exchangeCode(code) {
    const config = this.config();
    const payload = await this.postToken({
      grant_type: "authorization_code",
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
      redirect_uri: config.redirectUri
    });
    const tokens = this.toTokens(payload, void 0);
    await this.writeTokens(tokens);
    return tokens;
  }
  startCallbackServer(expectedState) {
    const http = loadHttp();
    if (!http) {
      throw new Error("\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u542F\u52A8\u672C\u5730\u56DE\u8C03\u670D\u52A1\uFF0C\u8BF7\u4F7F\u7528\u300C\u624B\u52A8\u7C98\u8D34\u6388\u6743\u7801\u300D\u65B9\u5F0F");
    }
    const config = this.config();
    let port = 7634;
    let expectedPath = "/callback";
    try {
      const parsed = new URL(config.redirectUri);
      port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
      expectedPath = parsed.pathname || "/callback";
    } catch {
    }
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
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
        res.end("<html><body><h3>\u6388\u6743\u5931\u8D25\uFF1Astate \u6821\u9A8C\u4E0D\u901A\u8FC7\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u6388\u6743\u3002</h3></body></html>");
        rejectCode(new Error("\u6388\u6743\u5931\u8D25\uFF1Astate \u6821\u9A8C\u4E0D\u901A\u8FC7"));
        return;
      }
      if (code) {
        res.end("<html><body><h3>\u6388\u6743\u6210\u529F\uFF0C\u53EF\u4EE5\u5173\u95ED\u672C\u9875\u9762\u5E76\u56DE\u5230 Obsidian\u3002</h3></body></html>");
        resolveCode(code);
      } else {
        res.end(`<html><body><h3>\u6388\u6743\u5931\u8D25\uFF1A${error ?? "\u672A\u6536\u5230 code"}</h3></body></html>`);
        rejectCode(new Error(`\u6388\u6743\u5931\u8D25\uFF1A${error ?? "\u672A\u6536\u5230 code"}`));
      }
    });
    const timeout = window.setTimeout(() => rejectCode(new Error("\u7B49\u5F85\u6388\u6743\u8D85\u65F6\uFF085 \u5206\u949F\uFF09\uFF0C\u8BF7\u91CD\u8BD5")), 5 * 60 * 1e3);
    server.on("error", (error) => rejectCode(error instanceof Error ? error : new Error(String(error))));
    const close = () => {
      window.clearTimeout(timeout);
      server.close();
    };
    server.listen(port);
    this.callbackServer = { close };
    return {
      waitForCode: async () => {
        try {
          return await codePromise;
        } finally {
          close();
        }
      },
      close
    };
  }
  closeCallbackServer() {
    this.callbackServer?.close();
    this.callbackServer = void 0;
  }
  cancelAuthorization() {
    this.closeCallbackServer();
  }
  async postToken(body) {
    const form = new URLSearchParams(body).toString();
    const response = await (0, import_obsidian2.requestUrl)({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: form,
      throw: false
    });
    const parsed = parseEnvelope(response.text) ?? {};
    const merged = parsed.data ?? parsed;
    if (response.status >= 400 || typeof parsed.code === "number" && parsed.code !== 0 || !merged.access_token) {
      const code = typeof parsed.code === "number" ? parsed.code : void 0;
      const reason = parsed.error_description ?? parsed.error ?? parsed.msg ?? `HTTP ${response.status}`;
      throw new FeishuAuthRequiredError(`\u83B7\u53D6\u7528\u6237\u6388\u6743\u5931\u8D25\uFF1A${oauthErrorHint(code, reason)}`);
    }
    return merged;
  }
  toTokens(payload, previous) {
    const now = Date.now();
    return {
      accessToken: payload.access_token ?? "",
      refreshToken: payload.refresh_token ?? previous?.refreshToken ?? "",
      accessExpiresAt: now + (payload.expires_in ?? 7200) * 1e3,
      refreshExpiresAt: payload.refresh_token_expires_in ? now + payload.refresh_token_expires_in * 1e3 : previous?.refreshExpiresAt ?? now + 30 * 24 * 3600 * 1e3,
      scope: payload.scope ?? previous?.scope
    };
  }
};

// src/log.ts
var import_obsidian3 = require("obsidian");
var LOG_DIR = ".obsidian/feishu-sync";
var LOG_PATH = `${LOG_DIR}/sync.log`;
var MAX_LOG_BYTES = 256 * 1024;
function describeError(error) {
  if (error instanceof Error) {
    const candidate = error;
    return typeof candidate.describe === "function" ? candidate.describe() : error.message;
  }
  return String(error);
}
var Logger = class {
  constructor(app, verbose) {
    this.app = app;
    this.verbose = verbose;
    this.pending = [];
  }
  info(message) {
    this.write("INFO", message);
  }
  warn(message) {
    this.write("WARN", message);
    console.warn("[feishu-wiki-sync]", message);
  }
  error(message) {
    this.write("ERROR", message);
    console.error("[feishu-wiki-sync]", message);
  }
  debug(message) {
    if (this.verbose())
      this.write("DEBUG", message);
  }
  write(level, message) {
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${level} ${message}`;
    console.log("[feishu-wiki-sync]", line);
    if (this.verbose())
      this.pending.push(line);
  }
  async flush() {
    if (!this.verbose() || this.pending.length === 0) {
      this.pending = [];
      return;
    }
    const lines = this.pending;
    this.pending = [];
    const adapter = this.app().vault.adapter;
    try {
      await ensureFolder(adapter, LOG_DIR);
      const path = (0, import_obsidian3.normalizePath)(LOG_PATH);
      const existing = await adapter.exists(path) ? await adapter.read(path) : "";
      const merged = `${existing}${lines.join("\n")}
`;
      await adapter.write(path, merged.length > MAX_LOG_BYTES ? merged.slice(merged.length - MAX_LOG_BYTES) : merged);
    } catch (error) {
      console.warn("[feishu-wiki-sync] failed to write log", error);
    }
  }
};
async function ensureFolder(adapter, folderPath) {
  const segments = (0, import_obsidian3.normalizePath)(folderPath).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!await adapter.exists(current)) {
      try {
        await adapter.mkdir(current);
      } catch (error) {
        if (!await adapter.exists(current))
          throw error;
      }
    }
  }
}

// src/settings-tab.ts
var import_obsidian5 = require("obsidian");

// src/sync/hash.ts
function loadNodeCrypto() {
  const requireFn = globalThis.require;
  if (!requireFn)
    return null;
  try {
    return requireFn("crypto");
  } catch {
    return null;
  }
}
function toHex(bytes) {
  let out = "";
  for (const byte of bytes)
    out += byte.toString(16).padStart(2, "0");
  return out;
}
async function sha256Hex(data) {
  const nodeCrypto = loadNodeCrypto();
  if (nodeCrypto) {
    return nodeCrypto.createHash("sha256").update(new Uint8Array(data)).digest("hex");
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(digest));
  }
  throw new Error("\u5F53\u524D\u73AF\u5883\u6CA1\u6709\u53EF\u7528\u7684 SHA-256 \u5B9E\u73B0");
}

// src/roundtrip.ts
var ROUNDTRIP_REPORT_PATH = "feishu-sync-roundtrip-report.md";
var MAX_DIFF_LINES = 40;
var SYNTAX_SAMPLE = [
  "<!-- \u5F80\u8FD4\u6D4B\u8BD5\u8BED\u6CD5\u6837\u672C\uFF1A\u7531\u300C\u6D4B\u8BD5\uFF1AMarkdown \u5F80\u8FD4\u8F6C\u6362\u300D\u547D\u4EE4\u8FFD\u52A0\uFF0C\u7528\u4E8E\u6D4B\u91CF\u5B98\u65B9\u8F6C\u6362\u7684\u4FDD\u771F\u5EA6 -->",
  "",
  "---",
  "",
  "roundtrip_probe: true",
  "roundtrip_note: \u8BED\u6CD5\u6837\u672C",
  "roundtrip_tags:",
  "  - \u5F80\u8FD4\u6D4B\u8BD5",
  "",
  "---",
  "",
  "## \u5F80\u8FD4\u6D4B\u8BD5\u8BED\u6CD5\u6837\u672C",
  "",
  "- [ ] \u5F85\u529E\uFF1A\u786E\u8BA4\u8FD9\u4E00\u884C\u662F\u5426\u539F\u6837\u56DE\u6765",
  "- [x] \u5DF2\u5B8C\u6210\uFF1A\u786E\u8BA4\u52FE\u9009\u72B6\u6001",
  "",
  "- \u65E0\u5E8F\u5217\u8868\u4E00\u7EA7",
  "  - \u65E0\u5E8F\u5217\u8868\u4E8C\u7EA7",
  "    1. \u6709\u5E8F\u5217\u8868\u4E09\u7EA7",
  "       - \u65E0\u5E8F\u5217\u8868\u56DB\u7EA7",
  "",
  "**\u52A0\u7C97\u6587\u672C** / *\u659C\u4F53\u6587\u672C* / ~~\u5220\u9664\u7EBF\u6587\u672C~~ / `\u884C\u5185\u4EE3\u7801`",
  "",
  "> [!note] \u63D0\u793A",
  "> callout \u6B63\u6587\uFF1A\u786E\u8BA4 callout \u7C7B\u578B\u4E0E\u6B63\u6587\u90FD\u4FDD\u7559",
  "",
  "\u884C\u5185\u516C\u5F0F $E = mc^2$\uFF0C\u4EE5\u53CA\u884C\u5185\u516C\u5F0F $\\alpha + \\beta = \\gamma$\u3002",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "| \u8BED\u6CD5 | \u672C\u5730\u539F\u6587 | \u98DE\u4E66\u53D6\u56DE |",
  "| --- | --- | --- |",
  "| \u8868\u683C | \u4E09\u5217\u4E24\u884C | \u5F85\u6838\u5BF9 |",
  "",
  "```js",
  'const roundtrip = "\u8BED\u6CD5\u6837\u672C";',
  "console.log(roundtrip);",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A[\u672C\u5730 Markdown] --> B[\u98DE\u4E66 docx]",
  "  B --> C[\u53D6\u56DE Markdown]",
  "```",
  "",
  "\u53CC\u94FE\u5F15\u7528\uFF1A[[\u5F80\u8FD4\u6D4B\u8BD5\u76EE\u6807\u7B14\u8BB0]]",
  "",
  "\u6807\u7B7E\uFF1A#\u5F80\u8FD4\u6D4B\u8BD5/\u8BED\u6CD5\u6837\u672C",
  "",
  "\u56FE\u7247\u5F15\u7528\uFF08Wiki \u5D4C\u5165\uFF09\uFF1A![[Pasted image 20260921000000.png]]",
  "",
  "\u56FE\u7247\u5F15\u7528\uFF08\u6807\u51C6 Markdown\uFF09\uFF1A![\u793A\u4F8B\u56FE\u7247](attachments/roundtrip-sample.png)",
  "",
  "\u811A\u6CE8\u5F15\u7528[^roundtrip]\uFF0C\u786E\u8BA4\u811A\u6CE8\u5B9A\u4E49\u80FD\u5426\u4FDD\u7559\u3002",
  "",
  "[^roundtrip]: \u811A\u6CE8\u6B63\u6587\uFF1A\u786E\u8BA4\u5B9A\u4E49\u80FD\u5426\u4FDD\u7559\u3002",
  "",
  "> \u666E\u901A\u5F15\u7528\u5757\uFF1A\u786E\u8BA4\u4E0E callout \u7684\u533A\u5206"
].join("\n");
var SYNTAX_CHECKS = [
  { label: "\u5F85\u529E\uFF08\u672A\u5B8C\u6210\uFF09", needle: "- [ ] \u5F85\u529E\uFF1A\u786E\u8BA4\u8FD9\u4E00\u884C\u662F\u5426\u539F\u6837\u56DE\u6765" },
  { label: "\u5F85\u529E\uFF08\u5DF2\u5B8C\u6210\uFF09", needle: "- [x] \u5DF2\u5B8C\u6210\uFF1A\u786E\u8BA4\u52FE\u9009\u72B6\u6001" },
  { label: "\u591A\u7EA7\u5217\u8868\uFF08\u7B2C\u56DB\u7EA7\uFF09", needle: "- \u65E0\u5E8F\u5217\u8868\u56DB\u7EA7" },
  { label: "\u52A0\u7C97 / \u659C\u4F53 / \u5220\u9664\u7EBF", needle: "**\u52A0\u7C97\u6587\u672C** / *\u659C\u4F53\u6587\u672C* / ~~\u5220\u9664\u7EBF\u6587\u672C~~" },
  { label: "\u884C\u5185\u516C\u5F0F", needle: "$E = mc^2$" },
  { label: "\u5757\u7EA7\u516C\u5F0F", needle: "\\int_0^1 x^2 \\, dx = \\frac{1}{3}" },
  { label: "callout", needle: "> [!note] \u63D0\u793A" },
  { label: "\u8868\u683C", needle: "| \u8BED\u6CD5 | \u672C\u5730\u539F\u6587 | \u98DE\u4E66\u53D6\u56DE |" },
  { label: "\u4EE3\u7801\u5757\uFF08js\uFF09", needle: 'const roundtrip = "\u8BED\u6CD5\u6837\u672C";' },
  { label: "mermaid \u4EE3\u7801\u5757", needle: "A[\u672C\u5730 Markdown] --> B[\u98DE\u4E66 docx]" },
  { label: "\u53CC\u94FE", needle: "[[\u5F80\u8FD4\u6D4B\u8BD5\u76EE\u6807\u7B14\u8BB0]]" },
  { label: "\u6807\u7B7E", needle: "#\u5F80\u8FD4\u6D4B\u8BD5/\u8BED\u6CD5\u6837\u672C" },
  { label: "frontmatter \u5757", needle: "roundtrip_probe: true" },
  { label: "\u56FE\u7247\uFF08Wiki \u5D4C\u5165\uFF09", needle: "![[Pasted image 20260921000000.png]]" },
  { label: "\u56FE\u7247\uFF08\u6807\u51C6 Markdown\uFF09", needle: "![\u793A\u4F8B\u56FE\u7247](attachments/roundtrip-sample.png)" },
  { label: "\u811A\u6CE8", needle: "[^roundtrip]: \u811A\u6CE8\u6B63\u6587\uFF1A\u786E\u8BA4\u5B9A\u4E49\u80FD\u5426\u4FDD\u7559\u3002" }
];
function appendSyntaxSample(markdown) {
  return `${markdown}

${SYNTAX_SAMPLE}`;
}
function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function checkSyntaxPresence(content, checks = SYNTAX_CHECKS) {
  const lines = content.split("\n");
  return checks.map((check) => {
    const index = lines.findIndex((line) => line.includes(check.needle));
    return { ...check, line: index >= 0 ? index + 1 : void 0, sampleMissing: false };
  });
}
function markMissingSamples(sent, results) {
  const sentLines = sent.split("\n");
  return results.map((result) => ({
    ...result,
    sampleMissing: !sentLines.some((line) => line.includes(result.needle))
  }));
}
function countLines(lines) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of lines)
    counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}
function diffLines(first, second) {
  const firstLines = first.split("\n");
  const secondLines = second.split("\n");
  const budgetForFirst = countLines(secondLines);
  const onlyInFirst = [];
  for (const line of firstLines) {
    const left = budgetForFirst.get(line) ?? 0;
    if (left > 0)
      budgetForFirst.set(line, left - 1);
    else
      onlyInFirst.push(line);
  }
  const budgetForSecond = countLines(firstLines);
  const onlyInSecond = [];
  for (const line of secondLines) {
    const left = budgetForSecond.get(line) ?? 0;
    if (left > 0)
      budgetForSecond.set(line, left - 1);
    else
      onlyInSecond.push(line);
  }
  return { onlyInFirst, onlyInSecond, firstLineCount: firstLines.length, secondLineCount: secondLines.length };
}
function visibleLine(line) {
  if (line === "")
    return "\uFF08\u7A7A\u884C\uFF09";
  if (line.trim() === "")
    return `\uFF08\u7A7A\u767D\u884C\uFF1A${line.length} \u4E2A\u7A7A\u683C/\u5236\u8868\u7B26\uFF09`;
  return line;
}
function renderLineList(title, lines) {
  if (lines.length === 0)
    return [`**${title}**\uFF1A\u65E0`, ""];
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const out = [`**${title}**\uFF1A\u5171 ${lines.length} \u884C${lines.length > shown.length ? `\uFF08\u53EA\u5217\u51FA\u524D ${MAX_DIFF_LINES} \u884C\uFF09` : ""}`, ""];
  const fence = fenceFor(shown.join("\n"));
  out.push(`${fence}text`, ...shown.map(visibleLine), fence, "");
  return out;
}
function renderDiffBlock(label, first, second) {
  const diff = diffLines(first, second);
  const out = [`### ${label}`, ""];
  if (diff.onlyInFirst.length === 0 && diff.onlyInSecond.length === 0) {
    out.push(`\u4E24\u4FA7\u884C\u5185\u5BB9\u4E00\u81F4\uFF08\u6309\u884C\u591A\u91CD\u96C6\u6BD4\u8F83\uFF0C\u5FFD\u7565\u987A\u5E8F\uFF09\uFF1A\u5404 ${diff.firstLineCount} / ${diff.secondLineCount} \u884C\u3002`, "");
    return out;
  }
  out.push(`- \u884C\u6570\uFF1A\u5DE6\u4FA7 ${diff.firstLineCount} \u884C\uFF0C\u53F3\u4FA7 ${diff.secondLineCount} \u884C`);
  out.push(`- \u53EA\u6709\u5DE6\u4FA7\u6709\uFF1A${diff.onlyInFirst.length} \u884C\uFF1B\u53EA\u6709\u53F3\u4FA7\u6709\uFF1A${diff.onlyInSecond.length} \u884C`, "");
  out.push(...renderLineList("\u53EA\u6709\u5DE6\u4FA7\u6709\u7684\u884C", diff.onlyInFirst));
  out.push(...renderLineList("\u53EA\u6709\u53F3\u4FA7\u6709\u7684\u884C", diff.onlyInSecond));
  return out;
}
function fenceFor(content) {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}
function renderCodeBlock(content) {
  const fence = fenceFor(content);
  return [`${fence}text`, content, fence];
}
async function fingerprint(text) {
  const encoded = new TextEncoder().encode(text);
  return {
    chars: text.length,
    bytes: encoded.byteLength,
    lines: text.split("\n").length,
    sha256: await sha256Hex(encoded.buffer)
  };
}
async function renderRoundtripReport(input) {
  const [note, local, sent, first, second] = await Promise.all([
    fingerprint(input.noteText),
    fingerprint(input.localContent),
    fingerprint(input.sentContent),
    fingerprint(input.firstFetch),
    fingerprint(input.secondFetch)
  ]);
  const firstChecks = markMissingSamples(input.sentContent, checkSyntaxPresence(input.firstFetch));
  const secondChecks = markMissingSamples(input.sentContent, checkSyntaxPresence(input.secondFetch));
  const stable = input.firstFetch === input.secondFetch;
  const lines = [];
  lines.push("# \u98DE\u4E66 Markdown \u5F80\u8FD4\u8F6C\u6362\u5B9E\u6D4B\u62A5\u544A", "");
  lines.push("\u672C\u62A5\u544A\u7531\u63D2\u4EF6\u547D\u4EE4\u300C\u6D4B\u8BD5\uFF1AMarkdown \u5F80\u8FD4\u8F6C\u6362\u300D\u751F\u6210\uFF1A\u628A\u5F53\u524D\u7B14\u8BB0\uFF08\u53EA\u8BFB\uFF09+ \u4E00\u6BB5\u56FA\u5B9A\u8BED\u6CD5\u6837\u672C\uFF0C");
  lines.push("\u7ECF `docs_ai` \u63A5\u53E3\u5199\u6210\u98DE\u4E66\u65B0\u7248\u6587\u6863\uFF08docx\uFF09\uFF0C\u518D\u53D6\u56DE Markdown\uFF0C\u7528\u6765\u770B\u5B98\u65B9\u8F6C\u6362\u7684\u4FDD\u771F\u5EA6\u3002", "");
  lines.push("## \u57FA\u672C\u4FE1\u606F", "");
  lines.push(`- \u751F\u6210\u65F6\u95F4\uFF1A${formatTimestamp(input.finishedAt)}\uFF08\u672C\u5730\u65F6\u95F4\uFF0C\u8017\u65F6 ${Math.round((input.finishedAt.getTime() - input.startedAt.getTime()) / 1e3)} \u79D2\uFF09`);
  lines.push(`- \u6837\u672C\u7B14\u8BB0\uFF1A\`${input.notePath}\`\uFF08\u53EA\u8BFB\uFF0C\u672A\u505A\u4EFB\u4F55\u4FEE\u6539\uFF09`);
  lines.push(`- \u6837\u672C\u7B14\u8BB0\u539F\u6587\uFF1A${note.chars} \u5B57\u7B26 / ${note.bytes} \u5B57\u8282 UTF-8 / sha256 \`${note.sha256}\`\uFF08\u7528\u6765\u6838\u5BF9\u7B14\u8BB0\u6CA1\u6709\u88AB\u6539\u52A8\uFF09`);
  lines.push(`- \u6587\u6863\u6807\u9898\uFF1A${input.documentTitle}`);
  lines.push(`- document_id\uFF1A\`${input.documentId}\``);
  lines.push(`- \u6587\u6863 URL\uFF1A${input.documentUrl ? input.documentUrl : "\uFF08\u670D\u52A1\u7AEF\u672A\u8FD4\u56DE\uFF0C\u7528 document_id \u5728\u98DE\u4E66\u91CC\u641C\uFF09"}`);
  lines.push(`- \u77E5\u8BC6\u7A7A\u95F4\uFF1A\`${input.spaceId}\``);
  lines.push(`- \u6D4B\u8BD5\u9875\u4F4D\u7F6E\uFF1A\u77E5\u8BC6\u7A7A\u95F4\u9876\u5C42\u9875\u9762\u300C${input.containerTitle}\u300D\uFF08node_token \`${input.containerNodeToken}\`\uFF09\u4E0B\u7684\u5B50\u9875\u9762\u300C${input.documentTitle}\u300D`);
  lines.push(
    input.wikiNodeToken ? `- \u77E5\u8BC6\u5E93\u8282\u70B9\uFF1Anode_token \`${input.wikiNodeToken}\`\uFF08\u94FE\u63A5\u5F62\u5982 https://<\u4F60\u7684\u98DE\u4E66\u57DF\u540D>/wiki/${input.wikiNodeToken}\uFF09` : "- \u77E5\u8BC6\u5E93\u8282\u70B9\uFF1A\u79FB\u52A8\u540E\u6CA1\u80FD\u67E5\u5230\u8282\u70B9 token\uFF0C\u8BF7\u5728\u77E5\u8BC6\u7A7A\u95F4\u91CC\u6309\u6807\u9898\u67E5\u627E"
  );
  lines.push("- \u6D4B\u8BD5\u9875\u4E0E\u6D4B\u8BD5\u6587\u6863\u4E0D\u4F1A\u81EA\u52A8\u6E05\u7406\uFF0C\u770B\u5B8C\u53EF\u4EE5\u624B\u52A8\u5220\u9664\u3002", "");
  lines.push("## \u8FD9\u4E00\u8D9F\u8C03\u7528\u7684\u63A5\u53E3", "");
  for (const entry of input.apiLog)
    lines.push(`- ${entry}`);
  lines.push("");
  lines.push("## \u2460 \u539F\u59CB\u672C\u5730\u5185\u5BB9\uFF08\u5F53\u524D\u7B14\u8BB0 + \u8FFD\u52A0\u7684\u8BED\u6CD5\u6837\u672C\uFF09");
  lines.push("");
  lines.push(...renderCodeBlock(input.localContent));
  lines.push("");
  lines.push("## \u2461 \u5B9E\u9645\u53D1\u7ED9\u98DE\u4E66\u7684 content\uFF08\u542B `<title>`\uFF09");
  lines.push("");
  lines.push(...renderCodeBlock(input.sentContent));
  lines.push("");
  lines.push("## \u2462 \u7B2C\u4E00\u6B21\u53D6\u56DE\uFF08\u521B\u5EFA\u540E\u7ACB\u523B fetch\uFF09");
  lines.push("");
  lines.push(...renderCodeBlock(input.firstFetch));
  lines.push("");
  lines.push("## \u2463 \u7B2C\u4E8C\u6B21\u53D6\u56DE\uFF08\u7528\u540C\u4E00\u4EFD content \u518D overwrite \u66F4\u65B0\u4E00\u6B21\u540E fetch\uFF09");
  lines.push("");
  lines.push(...renderCodeBlock(input.secondFetch));
  lines.push("");
  lines.push("## \u9010\u884C\u5DEE\u5F02\u6458\u8981", "");
  lines.push(...renderDiffBlock("\u2461 \u53D1\u7ED9\u98DE\u4E66\u7684 content \u2192 \u2462 \u7B2C\u4E00\u6B21\u53D6\u56DE", input.sentContent, input.firstFetch));
  lines.push(...renderDiffBlock("\u2461 \u53D1\u7ED9\u98DE\u4E66\u7684 content \u2192 \u2463 \u7B2C\u4E8C\u6B21\u53D6\u56DE", input.sentContent, input.secondFetch));
  lines.push(...renderDiffBlock("\u2462 \u7B2C\u4E00\u6B21\u53D6\u56DE \u2192 \u2463 \u7B2C\u4E8C\u6B21\u53D6\u56DE\uFF08\u66F4\u65B0\u8DEF\u5F84\u662F\u5426\u7A33\u5B9A\uFF09", input.firstFetch, input.secondFetch));
  lines.push("## \u5185\u5BB9\u6307\u7EB9", "");
  lines.push("| \u6BB5\u843D | \u5B57\u7B26\u6570 | UTF-8 \u5B57\u8282 | \u884C\u6570 | sha256 |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push(`| \u2460 \u539F\u59CB\u672C\u5730\u5185\u5BB9 | ${local.chars} | ${local.bytes} | ${local.lines} | \`${local.sha256}\` |`);
  lines.push(`| \u2461 \u53D1\u7ED9\u98DE\u4E66\u7684 content | ${sent.chars} | ${sent.bytes} | ${sent.lines} | \`${sent.sha256}\` |`);
  lines.push(`| \u2462 \u7B2C\u4E00\u6B21\u53D6\u56DE | ${first.chars} | ${first.bytes} | ${first.lines} | \`${first.sha256}\` |`);
  lines.push(`| \u2463 \u7B2C\u4E8C\u6B21\u53D6\u56DE | ${second.chars} | ${second.bytes} | ${second.lines} | \`${second.sha256}\` |`);
  lines.push("");
  lines.push(`- \u2462 \u4E0E \u2463 ${stable ? "\u9010\u5B57\u8282\u4E00\u81F4\uFF08\u66F4\u65B0\u8DEF\u5F84\u7A33\u5B9A\uFF09" : "\u4E0D\u4E00\u81F4\uFF08\u66F4\u65B0\u540E\u518D\u53D6\u56DE\u7684\u5185\u5BB9\u6709\u53D8\u5316\uFF09"}`);
  lines.push(`- \u2461 \u4E0E \u2462 ${sent.sha256 === first.sha256 ? "\u9010\u5B57\u8282\u4E00\u81F4\uFF08\u8FD9\u4E00\u8D9F\u6CA1\u6709\u4EFB\u4F55\u635F\u5931\uFF09" : "\u4E0D\u4E00\u81F4\uFF08\u8F6C\u6362\u6709\u635F\u5931\uFF0C\u5DEE\u5F02\u89C1\u4E0A\uFF09"}`, "");
  lines.push("## \u8BED\u6CD5\u6837\u672C\u9010\u884C\u6838\u5BF9", "");
  lines.push("\u5224\u5B9A\u65B9\u5F0F\uFF1A\u5728\u53D6\u56DE\u5185\u5BB9\u91CC\u9010\u884C\u67E5\u627E\u6837\u672C\u539F\u6587\uFF0C\u67D0\u4E00\u884C\u5305\u542B\u8BE5\u539F\u6587\u5373\u89C6\u4E3A\u9010\u5B57\u4FDD\u7559\uFF08\u884C\u53F7\u662F\u53D6\u56DE\u5185\u5BB9\u91CC\u7684\u884C\u53F7\uFF09\u3002", "");
  lines.push("| \u8BED\u6CD5 | \u6837\u672C\u539F\u6587 | \u7B2C\u4E00\u6B21\u53D6\u56DE | \u7B2C\u4E8C\u6B21\u53D6\u56DE |");
  lines.push("| --- | --- | --- | --- |");
  for (let index = 0; index < firstChecks.length; index += 1) {
    const firstCheck = firstChecks[index];
    const secondCheck = secondChecks[index];
    const cell = (result) => result.sampleMissing ? "\u26A0 \u6837\u672C\u91CC\u6CA1\u6709" : result.line ? `\u2705 \u7B2C ${result.line} \u884C` : "\u274C \u672A\u627E\u5230";
    lines.push(`| ${firstCheck.label} | \`${firstCheck.needle.replace(/\|/g, "\\|")}\` | ${cell(firstCheck)} | ${cell(secondCheck)} |`);
  }
  lines.push("");
  lines.push("## \u8BF4\u660E\u4E0E\u5C40\u9650", "");
  lines.push("- \u672C\u547D\u4EE4\u53EA\u8BFB\u672C\u5730\u7B14\u8BB0\uFF0C\u4E0D\u4F1A\u5199\u56DE\u6216\u5220\u9664\u4EFB\u4F55\u7B14\u8BB0\uFF1B\u4E5F\u4E0D\u4F1A\u6539\u52A8\u540C\u6B65\u72B6\u6001\u3002");
  lines.push("- \u56FE\u7247\u6CA1\u6709\u4E0A\u4F20\uFF1A\u5B98\u65B9 CLI \u4F1A\u5148\u628A\u672C\u5730\u56FE\u7247\u5F15\u7528\u6362\u6210\u5185\u90E8\u6807\u8BB0\u3001\u521B\u5EFA\u6587\u6863\u540E\u518D\u4E0A\u4F20\u5E76\u7ED1\u5B9A\uFF1B\u672C\u547D\u4EE4\u628A\u56FE\u7247\u5F15\u7528\u539F\u6837\u53D1\u7ED9\u670D\u52A1\u7AEF\uFF0C\u6240\u4EE5\u56FE\u7247\u90A3\u4E00\u884C\u53CD\u6620\u7684\u662F\u300C\u88F8\u4F20 Markdown\u300D\u7684\u7ED3\u679C\u3002");
  lines.push("- \u6837\u672C\u662F\u8FFD\u52A0\u5728\u7B14\u8BB0\u6B63\u6587\u4E4B\u540E\u7684\uFF0C\u6240\u4EE5\u90A3\u4E2A `---` \u5757\u4E0D\u662F\u6587\u4EF6\u5934 frontmatter\uFF08Obsidian \u53EA\u8BA4\u6587\u4EF6\u5934\u7684\uFF09\uFF0C\u4F46\u5B83\u540C\u6837\u80FD\u6D4B\u51FA\u8F6C\u6362\u5668\u5BF9 `---` \u5206\u9694\u5757\u7684\u5904\u7406\u3002");
  lines.push("- \u62A5\u544A\u5199\u5728 vault \u6839\u76EE\u5F55\uFF0C\u4F1A\u88AB\u5F53\u6210\u666E\u901A\u7B14\u8BB0\u53C2\u4E0E\u540E\u7EED\u540C\u6B65\u3002");
  lines.push("");
  return lines.join("\n");
}

// src/sync/types.ts
var ACTION_LABELS = {
  skip: "\u5DF2\u540C\u6B65",
  push: "\u4E0A\u4F20\u8986\u76D6",
  "create-remote": "\u4E0A\u4F20\u65B0\u5EFA",
  pull: "\u62C9\u53D6\u8986\u76D6",
  "create-local": "\u62C9\u53D6\u65B0\u5EFA",
  link: "\u5EFA\u7ACB\u6620\u5C04",
  conflict: "\u51B2\u7A81",
  "delete-remote": "\u5220\u9664\u8FDC\u7AEF",
  "delete-local": "\u5220\u9664\u672C\u5730",
  "local-deleted": "\u672C\u5730\u5DF2\u5220\u9664",
  "remote-deleted": "\u8FDC\u7AEF\u5DF2\u5220\u9664",
  "empty-local": "\u8DF3\u8FC7\u7A7A\u6587\u4EF6",
  "dirty-editor": "\u8DF3\u8FC7\uFF08\u7F16\u8F91\u4E2D\uFF09",
  forget: "\u6E05\u7406\u6620\u5C04"
};
function emptyState() {
  return { records: {}, folders: {}, conflicts: {}, docRecords: {}, images: {}, imageUploads: {} };
}
var CONFLICT_DIR = ".obsidian/feishu-sync/conflicts";
var DEFAULT_SETTINGS = {
  authMode: "user",
  appId: "",
  appSecret: "",
  oauthScope: "drive:drive wiki:wiki docs:document.media:download docs:document.media:upload docx:document offline_access",
  redirectUri: "http://localhost:7634/callback",
  spaceId: "",
  rootNodeToken: "",
  rootPageTitle: "",
  syncMode: "md",
  folderMode: "nodes",
  flatSeparator: "__",
  excludePatterns: ".trash/**",
  recreateRemoteIfDeleted: false,
  propagateLocalDelete: false,
  propagateRemoteDelete: false,
  attachmentFolder: "attachments",
  docVerifyRemoteByContent: false,
  attachmentLinkStyle: "shortest",
  showPlanBeforeSync: true,
  autoSyncMinutes: 0,
  debugLog: false,
  state: emptyState()
};
function summarize(items) {
  const counts = {};
  for (const item3 of items) {
    counts[item3.action] = (counts[item3.action] ?? 0) + 1;
  }
  return counts;
}
function dirnameOf(relPath) {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "" : relPath.slice(0, index);
}
function basenameOf(relPath) {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? relPath : relPath.slice(index + 1);
}
function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

// src/convert/rules.ts
var import_obsidian4 = require("obsidian");

// src/feishu/docImages.ts
var IMAGE_BLOCK_TYPE = 27;
var MAX_SINGLE_PART_UPLOAD_BYTES = 20 * 1024 * 1024;
function asRecord(value) {
  return value && typeof value === "object" ? value : void 0;
}
function readString(source, key) {
  const value = source?.[key];
  if (typeof value === "string" && value)
    return value;
  if (typeof value === "number")
    return String(value);
  return void 0;
}
function readNewBlocks(data) {
  const document = asRecord(asRecord(data)?.document);
  const blocks = document?.new_blocks;
  if (!Array.isArray(blocks))
    return [];
  const out = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    const blockId = readString(block, "block_id");
    if (!blockId)
      continue;
    out.push({ blockId, blockToken: readString(block, "block_token"), blockType: block?.block_type });
  }
  return out;
}
function readRevisionId(data) {
  const document = asRecord(asRecord(data)?.document);
  const value = document?.revision_id;
  if (typeof value === "number")
    return value;
  if (typeof value === "string" && /^\d+$/.test(value))
    return Number(value);
  return void 0;
}
function isImageBlock(blockType) {
  if (typeof blockType === "number")
    return blockType === IMAGE_BLOCK_TYPE;
  if (typeof blockType === "string") {
    const trimmed = blockType.trim();
    if (/^\d+$/.test(trimmed))
      return Number(trimmed) === IMAGE_BLOCK_TYPE;
    return trimmed.toLowerCase() === "image";
  }
  return false;
}
function correlateImageBlocks(blocks, markers) {
  const wanted = new Set(markers);
  const byMarker = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    if (!block.blockToken || !wanted.has(block.blockToken))
      continue;
    const list = byMarker.get(block.blockToken) ?? [];
    list.push(block);
    byMarker.set(block.blockToken, list);
  }
  const result = /* @__PURE__ */ new Map();
  for (const marker of markers) {
    const matches = (byMarker.get(marker) ?? []).filter((block) => isImageBlock(block.blockType));
    if (matches.length === 1)
      result.set(marker, matches[0].blockId);
  }
  return result;
}
function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(buffer);
  } else {
    for (let index = 0; index < buffer.length; index += 1)
      buffer[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function newImageMarker() {
  return `@lcli_img_${randomHex(16)}`;
}
function newClientToken() {
  const hex = randomHex(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function uploadDocImage(client, options) {
  if (options.bytes.byteLength > MAX_SINGLE_PART_UPLOAD_BYTES) {
    throw new Error(`\u56FE\u7247 ${options.fileName} \u8D85\u8FC7 20MB\uFF0C\u5355\u6B21\u4E0A\u4F20\u63A5\u53E3\u4E0D\u652F\u6301\uFF08\u5B98\u65B9 CLI \u8D70\u5206\u7247\u4E0A\u4F20\uFF0C\u672C\u63D2\u4EF6\u6682\u672A\u5B9E\u73B0\uFF09`);
  }
  const data = await client.json("POST", "/open-apis/drive/v1/medias/upload_all", {
    multipart: {
      fields: {
        file_name: options.fileName,
        parent_type: "docx_image",
        parent_node: options.blockId,
        size: String(options.bytes.byteLength),
        extra: JSON.stringify({ drive_route_token: options.documentId })
      },
      file: { name: options.fileName, data: options.bytes }
    }
  });
  const fileToken = readString(data, "file_token");
  if (!fileToken)
    throw new Error(`\u4E0A\u4F20\u56FE\u7247 ${options.fileName} \u540E\u6CA1\u6709\u62FF\u5230 file_token`);
  return fileToken;
}
async function bindDocImages(client, documentId, requests) {
  if (requests.length === 0)
    return;
  await client.json(
    "PATCH",
    `/open-apis/docx/v1/documents/${pathSegment(documentId)}/blocks/batch_update`,
    {
      query: { client_token: newClientToken() },
      body: { requests: requests.map((item3) => ({ block_id: item3.blockId, replace_image: { token: item3.fileToken } })) }
    }
  );
}
async function getDocBlockToken(client, documentId, blockId) {
  const data = await client.json(
    "GET",
    `/open-apis/docx/v1/documents/${pathSegment(documentId)}/blocks/${pathSegment(blockId)}`
  );
  const block = asRecord(data?.block);
  if (!block)
    return void 0;
  const image = asRecord(block.image);
  return readString(image, "token") ?? readString(block, "token");
}
async function deleteDocBlocks(client, documentId, blockIds, revisionId) {
  if (blockIds.length === 0)
    return;
  await client.json("PUT", `/open-apis/docs_ai/v1/documents/${pathSegment(documentId)}`, {
    body: {
      format: "xml",
      command: "block_delete",
      block_id: blockIds.join(","),
      revision_id: revisionId ?? -1
    }
  });
}
async function listDocImageBlocks(client, documentId) {
  const blocks = [];
  let pageToken;
  do {
    const data = await client.json(
      "GET",
      `/open-apis/docx/v1/documents/${pathSegment(documentId)}/blocks`,
      { query: { page_size: 500, document_revision_id: -1, page_token: pageToken } }
    );
    for (const raw of data?.items ?? []) {
      const block = asRecord(raw);
      if (!block || !isImageBlock(block.block_type))
        continue;
      const image = asRecord(block.image);
      blocks.push({
        blockId: readString(block, "block_id") ?? "",
        fileToken: readString(image, "token"),
        marker: readString(block, "block_token")
      });
    }
    pageToken = data?.has_more ? data.page_token : void 0;
  } while (pageToken);
  return blocks;
}
async function downloadDocMedia(client, fileToken) {
  const response = await client.binaryResponse(`/open-apis/drive/v1/medias/${pathSegment(fileToken)}/download`);
  if (response.data.byteLength === 0) {
    throw new FeishuError(`\u7D20\u6750 ${fileToken} \u4E0B\u8F7D\u5F97\u5230 0 \u5B57\u8282\uFF0C\u5DF2\u653E\u5F03`, { endpoint: `/open-apis/drive/v1/medias/${fileToken}/download` });
  }
  return { bytes: response.data, contentType: response.contentType };
}

// src/convert/markdown.ts
function escapedAt(text, pos) {
  let count = 0;
  for (let i = pos - 1; i >= 0 && text[i] === "\\"; i -= 1)
    count += 1;
  return count % 2 === 1;
}
function codeLineMask(lines, includeIndentedCode = true) {
  let fence;
  let frontmatter = lines[0]?.replace(/\r$/, "") === "---";
  return lines.map((line, index) => {
    if (frontmatter) {
      if (index > 0 && /^(---|\.\.\.)\r?$/.test(line))
        frontmatter = false;
      return true;
    }
    const unquoted = line.replace(/^(?:[\t ]*>[\t ]?)+/, "");
    const match = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(unquoted.replace(/\r$/, ""));
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim())
        fence = void 0;
      return true;
    }
    if (match) {
      fence = match[1];
      return true;
    }
    return includeIndentedCode && /^(?: {4}|\t)/.test(unquoted);
  });
}
function mathSpans(text) {
  const lines = text.split("\n");
  const code = codeLineMask(lines);
  const spans = [];
  let offset = 0;
  let blockStart;
  let xmlUntil = 0;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (code[row] && blockStart === void 0) {
      offset += line.length + 1;
      continue;
    }
    if (blockStart !== void 0 && /^[\t ]*(`{3,}|~{3,})/.test(line)) {
      blockStart = void 0;
      offset += line.length + 1;
      continue;
    }
    for (let i = 0; i < line.length; ) {
      if (offset + i < xmlUntil) {
        i = Math.min(line.length, xmlUntil - offset);
        continue;
      }
      if (blockStart === void 0 && line.startsWith("<latex>", i) && !escapedAt(line, i)) {
        const close2 = text.indexOf("</latex>", offset + i + 7);
        if (close2 !== -1) {
          xmlUntil = close2 + 8;
          continue;
        }
      }
      if (blockStart === void 0 && line[i] === "`" && !escapedAt(line, i)) {
        const ticks = /^`+/.exec(line.slice(i))[0];
        let close2 = text.indexOf(ticks, offset + i + ticks.length);
        while (close2 !== -1 && (text[close2 - 1] === "`" || text[close2 + ticks.length] === "`"))
          close2 = text.indexOf(ticks, close2 + ticks.length);
        if (close2 !== -1)
          xmlUntil = close2 + ticks.length;
        i += ticks.length;
        continue;
      }
      if (blockStart === void 0 && line.startsWith("](", i)) {
        let depth = 1;
        let end = i + 2;
        for (; end < line.length && depth > 0; end += 1) {
          if (escapedAt(line, end))
            continue;
          if (line[end] === "(")
            depth += 1;
          if (line[end] === ")")
            depth -= 1;
        }
        if (depth === 0) {
          i = end;
          continue;
        }
      }
      if (blockStart === void 0 && line.startsWith("[[", i)) {
        const end = line.indexOf("]]", i + 2);
        if (end !== -1) {
          i = end + 2;
          continue;
        }
      }
      if (line[i] !== "$" || escapedAt(line, i)) {
        i += 1;
        continue;
      }
      const dollarRun = /^\$+/.exec(line.slice(i))[0].length;
      if (dollarRun > 2) {
        i += dollarRun;
        continue;
      }
      if (line.startsWith("$$", i)) {
        if (blockStart === void 0)
          blockStart = offset + i;
        else {
          spans.push({ start: blockStart, end: offset + i + 2, body: text.slice(blockStart + 2, offset + i), block: true });
          blockStart = void 0;
        }
        i += 2;
        continue;
      }
      if (blockStart !== void 0) {
        i += 1;
        continue;
      }
      let close = i + 1;
      while (close < line.length && (line[close] !== "$" || escapedAt(line, close)))
        close += 1;
      const body = line.slice(i + 1, close);
      const amount = /^-?\d[\d,.]*(.*)$/.exec(body);
      if (amount && /[\p{L};；]/u.test(amount[1]) && !/[\\^_=<>+*/{}()-]/.test(amount[1])) {
        i += 1;
        continue;
      }
      if (close < line.length && close > i + 1 && line[close + 1] !== "$" && !/\d/.test(line[close + 1] ?? "")) {
        spans.push({ start: offset + i, end: offset + close + 1, body, block: false });
        i = close + 1;
      } else
        i += 1;
    }
    offset += line.length + 1;
  }
  return spans;
}
function trimInlineMathBody(body) {
  let end = body.length;
  while (end > 0 && /\s/.test(body[end - 1])) {
    if (body[end - 1] === " " && escapedAt(body, end - 1)) {
      return body.slice(0, end - 2).trimStart() + "\\space{}";
    }
    end -= 1;
  }
  return body.slice(0, end).trimStart();
}
function mapMath(text, rewrite) {
  const out = [];
  let from = 0;
  for (const span of mathSpans(text)) {
    out.push(text.slice(from, span.start), rewrite(span));
    from = span.end;
  }
  out.push(text.slice(from));
  return out.join("");
}
function mapNativeMath(text, rewrite) {
  const lines = text.split("\n");
  const code = codeLineMask(lines);
  const protectedRanges = [];
  let offset = 0;
  for (let row = 0; row < lines.length; row += 1) {
    if (code[row])
      protectedRanges.push({ start: offset, end: offset + lines[row].length });
    offset += lines[row].length + 1;
  }
  const ticks = /`+/g;
  let tick;
  while (tick = ticks.exec(text)) {
    if (escapedAt(text, tick.index) || protectedRanges.some((r) => tick.index >= r.start && tick.index < r.end))
      continue;
    let close = text.indexOf(tick[0], ticks.lastIndex);
    while (close !== -1 && (text[close - 1] === "`" || text[close + tick[0].length] === "`"))
      close = text.indexOf(tick[0], close + tick[0].length);
    if (close !== -1) {
      protectedRanges.push({ start: tick.index, end: close + tick[0].length });
      ticks.lastIndex = close + tick[0].length;
    }
  }
  return text.replace(
    /<p align="center">\s*<latex>([\s\S]*?)<\/latex>\s*<\/p>|<latex>([\s\S]*?)<\/latex>/g,
    (raw, blockBody, inlineBody, start) => {
      if (escapedAt(text, start) || protectedRanges.some((r) => start < r.end && start + raw.length > r.start))
        return raw;
      return rewrite(blockBody ?? inlineBody ?? "", blockBody !== void 0);
    }
  );
}
function decodeXmlText(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (entity[1] !== "#")
      return named[entity.toLowerCase()] ?? entity;
    const value = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return value > 0 && value <= 1114111 && !(value >= 55296 && value <= 57343) ? String.fromCodePoint(value) : entity;
  });
}
function encodeFeishuMath(markdown) {
  const compensate = (body) => body.replace(/\\(?=[#$*_~\[\]&:<>+=`-])/g, "\\\\");
  const native = mapNativeMath(markdown, (body, block) => {
    const value = compensate(decodeXmlText(body));
    const escaped = block ? value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : value;
    const latex = `<latex>${escaped}</latex>`;
    return block ? `<p align="center">${latex}</p>` : latex;
  });
  return mapMath(native, (span) => {
    const delimiter = span.block ? "$$" : "$";
    return `${delimiter}${compensate(span.body)}${delimiter}`;
  });
}

// src/convert/rules.ts
var RULES_PATH = ".obsidian/feishu-sync/rules.json";
var RULES_VERSION = 3;
var PUBLISH_RULES_REVISION = 3;
var IMAGE_LINK = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
var FENCE = /^\s*(```|~~~)/;
var WIKI_IMAGE = /!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
var MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
var XML_IMAGE = /<img\b[^>]*\/?>/gi;
var HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
function mapOutsideFences(text, transform) {
  const lines = text.split("\n");
  const code = codeLineMask(lines, false);
  return lines.map((line, index) => code[index] ? line : transform(line)).join("\n");
}
var imageRefNormalize = {
  id: "image-ref-normalize",
  description: "\u4E0A\u884C\uFF1A\u628A\u6807\u51C6 Markdown \u56FE\u7247 ![alt](\u76F8\u5BF9\u8DEF\u5F84) \u6362\u6210 Obsidian \u7684 ![[\u76F8\u5BF9\u8DEF\u5F84]]\u3002\u5B9E\u6D4B\u6807\u51C6\u56FE\u7247\u5F15\u7528\u4F1A\u88AB\u98DE\u4E66\u6574\u884C\u4E22\u5F03\uFF0C![[...]] \u80FD\u539F\u6837\u4FDD\u7559\u3002http(s) \u56FE\u7247\u5730\u5740\u4E0D\u6539\u3002",
  defaultEnabled: true,
  apply: (input) => mapOutsideFences(
    input,
    (line) => line.replace(IMAGE_LINK, (raw, target) => /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? raw : `![[${target}]]`)
  )
};
var tabIndentToSpaces = {
  id: "tab-indent-to-spaces",
  description: "\u4E0A\u884C\uFF1A\u884C\u9996 Tab \u6309 2 \u7A7A\u683C\u6362\u7B97\u3002\u5B9E\u6D4B\u98DE\u4E66\u4F1A\u628A Tab \u7F29\u8FDB\u89C4\u8303\u6210\u7A7A\u683C\uFF0C\u5148\u8F6C\u8FC7\u6765\u80FD\u51CF\u5C11\u300C\u53D1\u51FA vs \u53D6\u56DE\u300D\u7684\u65E0\u8C13\u5DEE\u5F02\u3002\u56F4\u680F\u4EE3\u7801\u5757\u5185\u90E8\u4E0D\u52A8\u3002",
  defaultEnabled: true,
  apply: (input) => mapOutsideFences(input, (line) => {
    const match = /^[\t ]+/.exec(line);
    if (!match || !match[0].includes("	"))
      return line;
    return match[0].replace(/\t/g, "  ") + line.slice(match[0].length);
  })
};
var MATH_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
var MATH_TABLE_ROW = /^\s*\|/;
var MATH_STRUCTURED_LINE = /^(?:[\t ]|>|#{1,6}\s)/;
function rewriteMathBodies(input, rewrite) {
  return mapMath(input, (span) => {
    const delimiter = span.block ? "$$" : "$";
    return `${delimiter}${rewrite(span.body, span.block)}${delimiter}`;
  });
}
var mathEscapeHash = {
  id: "math-escape-hash",
  description: "\u53CC\u5411\uFF1A\u6570\u5B66\u73AF\u5883\u91CC\u7684\u88F8 # \u5199\u6210 \\#\uFF0C\u907F\u514D\u516C\u5F0F\u6E32\u67D3\u5931\u8D25\uFF1B\u5DF2\u8F6C\u4E49\u7684 # \u4E0D\u91CD\u590D\u8F6C\u4E49\uFF0C\u4EE3\u7801\u793A\u4F8B\u4E0D\u52A8\uFF0C\u8DE8\u884C\u7684 $$ \u516C\u5F0F\u540C\u6837\u5904\u7406\u3002",
  defaultEnabled: true,
  apply: (input) => rewriteMathBodies(input, (body) => body.replace(/#/g, (_char, index) => escapedAt(body, index) ? "#" : "\\#"))
};
var mathTrimInlineSpaces = {
  id: "math-trim-inline-spaces",
  description: "\u53CC\u5411\uFF1A\u53EA\u6E05\u7406\u884C\u5185\u516C\u5F0F\u5B9A\u754C\u7B26\u5185\u4FA7\u7684\u7A7A\u767D\uFF08$ x $ \u2192 $x$\uFF09\uFF0C\u786E\u4FDD Obsidian \u53EF\u8BC6\u522B\u3002\u4FDD\u7559\u516C\u5F0F\u6B63\u6587\u3001\\text{Agent Memory} \u5185\u7684\u7A7A\u683C\uFF0C\u4EE5\u53CA\u5757\u7EA7 $$...$$ \u7684\u7A7A\u683C\u548C\u6362\u884C\uFF1B\u4EE3\u7801\u3001\u4EF7\u683C\u4E0E\u8F6C\u4E49\u7F8E\u5143\u7B26\u53F7\u4E0D\u52A8\u3002",
  defaultEnabled: true,
  apply: (input) => rewriteMathBodies(input, (body, block) => block || !body.trim() ? body : trimInlineMathBody(body))
};
var FORMULA_TAIL_CONNECTOR = /^(?:和|与|及|以及|或者|或|还是|暨|and|or)[\s。，、；：！？.,;:!?]*$/i;
var inlineFormulaToBlock = {
  id: "inline-formula-to-block",
  description: "\u4E0A\u884C\uFF1A\u666E\u901A\u6BB5\u843D\u4E2D\u72EC\u5360\u4E00\u884C\u7684\u884C\u5185\u516C\u5F0F\u6539\u6210\u5757\u7EA7\u516C\u5F0F\uFF1B\u5C3E\u968F\u8FDE\u63A5\u8BCD\u53E6\u8D77\u4E00\u6BB5\u3002\u4FDD\u7559\u6B63\u6587\u3001\u6807\u70B9\u548C\u5217\u8868/\u5F15\u7528/\u4EE3\u7801\u7ED3\u6784\u3002",
  defaultEnabled: true,
  apply: (input) => mapMath(input, (span) => {
    if (span.block)
      return input.slice(span.start, span.end);
    const lineStart = input.lastIndexOf("\n", span.start - 1) + 1;
    const newline = input.indexOf("\n", span.end);
    const lineEnd = newline === -1 ? input.length : newline;
    const prefix = input.slice(lineStart, span.start);
    const tail = input.slice(span.end, lineEnd).trim();
    if (prefix !== "" || tail && !FORMULA_TAIL_CONNECTOR.test(tail))
      return input.slice(span.start, span.end);
    return `$$
${span.body.trim()}
$$${tail ? "\n\n" : ""}`;
  })
};
var blockFormulaOwnParagraph = {
  id: "block-formula-own-paragraph",
  description: "\u4E0A\u884C\uFF1A\u666E\u901A\u6B63\u6587\u91CC\u7684\u5757\u7EA7\u516C\u5F0F\u72EC\u5360\u6BB5\u843D\uFF0C\u524D\u540E\u7559\u7A7A\u884C\uFF1B\u5217\u8868\u3001\u8868\u683C\u3001\u5F15\u7528\u548C\u7F29\u8FDB\u7ED3\u6784\u91CC\u7684\u516C\u5F0F\u4FDD\u7559\u4F4D\u7F6E\u5E76\u63D0\u793A\u3002",
  defaultEnabled: true,
  apply: (input, ctx) => {
    const out = [];
    let from = 0;
    for (const span of mathSpans(input)) {
      if (!span.block)
        continue;
      const lineStart = input.lastIndexOf("\n", span.start - 1) + 1;
      const prefix = input.slice(lineStart, span.start);
      if (MATH_STRUCTURED_LINE.test(prefix) || MATH_LIST_ITEM.test(prefix) || MATH_TABLE_ROW.test(prefix)) {
        ctx.warnings?.push(`\u7B2C ${input.slice(0, span.start).split("\n").length} \u884C\u7684\u5757\u7EA7\u516C\u5F0F\u5728\u7F29\u8FDB/\u5217\u8868\u9879/\u8868\u683C/\u5F15\u7528/\u6807\u9898\u91CC\uFF0C\u672A\u62C6\u6210\u72EC\u7ACB\u6BB5\u843D`);
        continue;
      }
      const before = input.slice(from, span.start).replace(/[ \t]+$/, "");
      out.push(before);
      const joined = out.join("");
      if (joined && !joined.endsWith("\n\n"))
        out.push(joined.endsWith("\n") ? "\n" : "\n\n");
      out.push(input.slice(span.start, span.end));
      from = span.end;
      while (input[from] === " " || input[from] === "	")
        from += 1;
      if (from < input.length && !input.slice(from).startsWith("\n\n"))
        out.push(input[from] === "\n" ? "\n" : "\n\n");
    }
    out.push(input.slice(from));
    return out.join("");
  }
};
var nativeMath = {
  id: "native-math",
  description: "\u4E0A\u884C\uFF1A\u516C\u5F0F\u4F7F\u7528\u98DE\u4E66\u539F\u751F <latex> \u6807\u7B7E\uFF1B\u72EC\u7ACB\u5757\u7EA7\u516C\u5F0F\u653E\u5165\u5C45\u4E2D\u6BB5\u843D\uFF0C\u4FDD\u7559\u516C\u5F0F\u4E0E\u6B63\u6587\u7684\u8FB9\u754C\u3002",
  defaultEnabled: true,
  apply: (input) => mapMath(input, (span) => {
    if (!span.body.trim())
      return input.slice(span.start, span.end);
    const body = span.body.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const latex = `<latex>${body}</latex>`;
    if (!span.block)
      return latex;
    const before = input.slice(input.lastIndexOf("\n", span.start - 1) + 1, span.start);
    const end = input.indexOf("\n", span.end);
    const after = input.slice(span.end, end === -1 ? input.length : end);
    return !before.trim() && !after.trim() ? `<p align="center">${latex}</p>` : latex;
  })
};
var restoreNativeMath = {
  id: "restore-native-math",
  description: "\u4E0B\u884C\uFF1A\u628A\u98DE\u4E66\u6B8B\u7559\u7684\u539F\u751F\u516C\u5F0F\u6807\u7B7E\u8FD8\u539F\u4E3A Obsidian \u6570\u5B66\u8BED\u6CD5\uFF1B\u5C45\u4E2D\u516C\u5F0F\u7528 $$...$$\uFF0C\u884C\u5185\u516C\u5F0F\u7528 $...$\uFF0C\u4E0D\u628A XML \u6807\u7B7E\u5199\u5165\u7B14\u8BB0\u3002",
  defaultEnabled: true,
  apply: (input) => mapNativeMath(input, (body, block) => {
    const decoded = decodeXmlText(body);
    return block ? `$$
${decoded}
$$` : `$${trimInlineMathBody(decoded) || "{}"}$`;
  })
};
var listExitAfterHardbreak = {
  id: "list-exit-after-hardbreak",
  description: "\u4E0A\u884C\uFF1A\u5217\u8868\u9879\u4EE5\u4E24\u4E2A\u7A7A\u683C\u786C\u6362\u884C\u7ED3\u675F\uFF0C\u4E0B\u4E00\u884C\u53C8\u662F\u65E0\u7F29\u8FDB\u6B63\u6587\u65F6\uFF0C\u8865\u7A7A\u884C\u7ED3\u675F\u5217\u8868\uFF1B\u7F29\u8FDB\u7684\u7EED\u884C\u3001\u5B50\u5217\u8868\u548C\u4EE3\u7801\u4FDD\u6301\u539F\u6837\u3002",
  defaultEnabled: true,
  apply: (input) => {
    const lines = input.split("\n");
    const code = codeLineMask(lines);
    return lines.map((line, index) => {
      if (!index || code[index] || code[index - 1])
        return line;
      const previous = lines[index - 1];
      const list = /^[ \t]*(?:[-*+]|\d+[.)])\s/.test(previous);
      const hardbreak = / {2,}\r?$/.test(previous);
      const plain = /^[^\s>#|`~]/.test(line) && !/^(?:[-*+]|\d+[.)])\s/.test(line);
      return list && hardbreak && plain ? `
${line}` : line;
    }).join("\n");
  }
};
function sourceFormatWarnings(input) {
  const lines = input.split("\n");
  const code = codeLineMask(lines);
  const masked = mapMath(input, (span) => input.slice(span.start, span.end).replace(/[^\n]/g, " ")).split("\n");
  const warnings = [];
  let previousHeading = 0;
  for (let row = 0; row < lines.length; row += 1) {
    if (!code[row]) {
      const outside = masked[row];
      const label = `\u539F\u7A3F\u7B2C ${row + 1} \u884C`;
      if (/^\\\$\\\$/.test(outside.trim()))
        warnings.push(`${label}\uFF1A\u5757\u7EA7\u516C\u5F0F\u5B9A\u754C\u7B26\u5DF2\u88AB\u8F6C\u4E49\uFF0C\u4F1A\u663E\u793A\u4E3A\u5B57\u9762 $$\uFF1B\u8BF7\u786E\u8BA4\u539F\u7A3F\uFF0C\u672A\u81EA\u52A8\u53CD\u8F6C\u4E49`);
      if (/^(?:#{1,6}\s+)?(?:[A-Za-z]\\?_\{|\\(?:text|rightarrow|left|frac)\b)/.test(outside.trim()))
        warnings.push(`${label}\uFF1ALaTeX \u7591\u4F3C\u843D\u5728\u516C\u5F0F\u73AF\u5883\u5916\uFF0C\u5C06\u663E\u793A\u6E90\u7801\uFF1B\u8BF7\u4FEE\u590D\u539F\u7A3F\u4E2D\u7684\u5B9A\u754C\u7B26`);
      const heading = /^(#{1,6})\s/.exec(outside);
      if (heading) {
        const level = heading[1].length;
        if (!previousHeading && level > 1 || level > previousHeading + 1)
          warnings.push(`${label}\uFF1A\u6807\u9898\u5C42\u7EA7\u8DF3\u5230 H${level}\uFF1B\u4FDD\u7559\u539F\u7A3F\u5C42\u7EA7\uFF0C\u8BF7\u68C0\u67E5\u6587\u7AE0\u7ED3\u6784`);
        if (level === 1 && previousHeading > 1)
          warnings.push(`${label}\uFF1A\u6B63\u6587\u4E2D\u51FA\u73B0 H1 \u5927\u6807\u9898\uFF0C\u8BF7\u786E\u8BA4\u662F\u5426\u8BEF\u52A0\u4E86 #`);
        previousHeading = level;
      }
      if (/(^|[^\\])\$\$/.test(outside))
        warnings.push(`${label}\uFF1A\u516C\u5F0F\u5B9A\u754C\u7B26\u4E0D\u5B8C\u6574\uFF0C\u5DF2\u4FDD\u7559\u539F\u6587`);
    }
    if (warnings.length >= 30) {
      warnings.push("\u539F\u7A3F\u683C\u5F0F\u63D0\u793A\u8FC7\u591A\uFF0C\u5DF2\u7701\u7565\u540E\u7EED\u63D0\u793A");
      break;
    }
  }
  return warnings;
}
var sourceDiagnostics = {
  id: "source-format-diagnostics",
  description: "\u4E0A\u884C\uFF1A\u53EF\u9009\u7684\u539F\u7A3F\u683C\u5F0F\u68C0\u67E5\uFF0C\u9ED8\u8BA4\u5173\u95ED\u3002\u5F00\u542F\u540E\u63D0\u793A\u8F6C\u4E49\u7684\u516C\u5F0F\u5B9A\u754C\u7B26\u3001\u7591\u4F3C\u88F8\u9732 LaTeX\u3001\u6807\u9898\u8DF3\u7EA7\u7B49\u95EE\u9898\uFF1B\u53EA\u63D0\u793A\uFF0C\u4E0D\u731C\u6D4B\u6216\u6539\u5199\u539F\u610F\u3002",
  defaultEnabled: false,
  apply: (input, ctx) => {
    ctx.warnings?.push(...sourceFormatWarnings(input));
    return input;
  }
};
var footnoteDowngrade = {
  id: "footnote-downgrade",
  description: "\u4E0A\u884C\uFF1A\u811A\u6CE8\u964D\u7EA7\u6210\u666E\u901A\u6587\u672C\u2014\u2014\u5F15\u7528\u6807\u8BB0 [^x] \u5220\u6389\uFF0C\u5B9A\u4E49\u884C [^x]: \u6B63\u6587 \u53D8\u6210\u300C\u811A\u6CE8 x\uFF1A\u6B63\u6587\u300D\u3002\u5B9E\u6D4B\u98DE\u4E66\u4F1A\u4E22\u6389\u811A\u6CE8\uFF0C\u9ED8\u8BA4\u5173\u95ED\uFF1A\u5173\u7740\u65F6\u811A\u6CE8\u4F1A\u539F\u6837\u53D1\u51FA\u53BB\uFF08\u98DE\u4E66\u4FA7\u4ECD\u4F1A\u4E22\uFF09\uFF0C\u5F00\u7740\u5219\u81F3\u5C11\u6B63\u6587\u80FD\u7559\u5728\u98DE\u4E66\u91CC\uFF0C\u4F46\u56DE\u5199\u65F6\u65E0\u6CD5\u8FD8\u539F\u6210\u811A\u6CE8\u8BED\u6CD5\u3002",
  defaultEnabled: false,
  apply: (input) => {
    const definitions = /* @__PURE__ */ new Set();
    for (const line of input.split("\n")) {
      const match = /^\[\^([^\]]+)\]:/.exec(line);
      if (match)
        definitions.add(match[1]);
    }
    return input.split("\n").map((line) => {
      const definition = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
      if (definition)
        return `\u811A\u6CE8 ${definition[1]}\uFF1A${definition[2]}`;
      return line.replace(/\[\^([^\]]+)\]/g, (raw, id) => definitions.has(id) ? "" : raw);
    }).join("\n");
  }
};
var dropTitleHeading = {
  id: "drop-title-heading",
  description: "\u4E0B\u884C\uFF1A\u53D6\u56DE\u5185\u5BB9\u9996\u884C\u82E5\u662F\u300C# \u6587\u6863\u6807\u9898\u300D\u5C31\u5220\u6389\u2014\u2014\u98DE\u4E66\u628A <title> \u53D6\u56DE\u6210\u4E86\u9996\u884C H1\uFF0C\u76F4\u63A5\u5199\u56DE\u4F1A\u628A\u6807\u9898\u5F53\u6B63\u6587\u590D\u5236\u8FDB\u7B14\u8BB0\u3002\u672C\u5730\u73B0\u6709\u5185\u5BB9\u672C\u6765\u5C31\u4EE5\u8FD9\u884C\u5F00\u5934\u65F6\u4FDD\u7559\uFF08\u8BF4\u660E\u6807\u9898\u672C\u6765\u5C31\u662F\u7B14\u8BB0\u6B63\u6587\u7684\u4E00\u90E8\u5206\uFF09\u3002",
  defaultEnabled: true,
  apply: (input, ctx) => {
    const title = ctx.documentTitle.trim();
    if (!title)
      return input;
    const heading = `# ${title}`;
    const xmlTitle = /^<title>([\s\S]*?)<\/title>(?:\r?\n)?(?:\r?\n)?/.exec(input);
    if (xmlTitle && decodeXmlText(xmlTitle[1]).trim() === title)
      return input.slice(xmlTitle[0].length);
    const lines = input.split("\n");
    if ((lines[0] ?? "").trim() !== heading)
      return input;
    if ((ctx.localContent.split("\n")[0] ?? "").trim() === heading)
      return input;
    const rest = lines.slice(1);
    if (rest.length > 0 && rest[0].trim() === "")
      rest.shift();
    return rest.join("\n");
  }
};
var restoreImageRef = {
  id: "restore-image-ref",
  description: "\u4E0B\u884C\uFF1A\u628A\u98DE\u4E66\u4FA7\u7684\u56FE\u7247\u8FD8\u539F\u6210\u6807\u51C6 Markdown \u56FE\u7247\u5F15\u7528\u3002\u7B49\u56FE\u7247\u4E0A\u4F20\u94FE\u8DEF\uFF08medias/upload_all + reference_map\uFF09\u505A\u597D\u540E\u518D\u542F\u7528\uFF0C\u73B0\u5728\u6253\u5F00\u4E5F\u662F\u7A7A\u64CD\u4F5C\u3002",
  defaultEnabled: false,
  apply: (input) => input
};
function escapeXmlAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;");
}
function isLocalImageTarget(target) {
  const value = target.trim();
  if (!value)
    return false;
  if (HAS_SCHEME.test(value))
    return false;
  return true;
}
function rewriteLocalImageLine(line, ctx) {
  const resolve = ctx.resolveImage;
  const uploads = ctx.imageUploads;
  if (!resolve || !uploads)
    return line;
  const replaceWith = (raw, target, caption) => {
    if (!isLocalImageTarget(target))
      return raw;
    const linkpath = target.trim().replace(/^<|>$/g, "");
    const resolved = resolve(linkpath, ctx.relPath);
    if (!resolved) {
      ctx.warnings?.push(`\u56FE\u7247 ${linkpath} \u5728 vault \u91CC\u627E\u4E0D\u5230\uFF0C\u5DF2\u539F\u6837\u4FDD\u7559`);
      return raw;
    }
    const marker = newImageMarker();
    uploads.push({
      raw,
      marker,
      vaultPath: resolved.path,
      fileName: linkpath.split("/").filter(Boolean).pop() ?? "image",
      size: resolved.size
    });
    const captionAttr = caption.trim() ? ` caption="${escapeXmlAttr(caption.trim())}"` : "";
    return `<img path="${marker}"${captionAttr}/>`;
  };
  let out = line.replace(WIKI_IMAGE, (raw, linkpath) => replaceWith(raw, linkpath, "")).replace(MARKDOWN_IMAGE, (raw, alt, target) => replaceWith(raw, target, alt));
  return out;
}
var imageUpload = {
  id: "image-upload",
  description: "\u4E0A\u884C\uFF1A\u628A vault \u5185\u7684\u672C\u5730\u56FE\u7247\uFF08![[x.png]] \u6216 ![alt](attachments/x.png)\uFF09\u6362\u6210\u5B98\u65B9\u7684\u5360\u4F4D\u6807\u8BB0\uFF0C\u5EFA/\u66F4\u65B0\u6587\u6863\u540E\u4E0A\u4F20\u7D20\u6750\u5E76\u7ED1\u5B9A\u6210\u771F\u6B63\u7684\u56FE\u7247\u5757\u3002\u9700\u8981 docs:document.media:upload \u6743\u9650\uFF1Bhttp(s) \u5916\u94FE\u4E0E vault \u91CC\u627E\u4E0D\u5230\u7684\u6587\u4EF6\u4FDD\u6301\u539F\u6837\uFF08\u4F1A\u5728\u62A5\u544A\u91CC\u5217\u51FA\uFF09\u3002",
  defaultEnabled: true,
  apply: (input, ctx) => mapOutsideFences(input, (line) => rewriteLocalImageLine(line, ctx))
};
function extractMediaToken(rawUrl) {
  let url = rawUrl.trim();
  try {
    url = decodeURIComponent(url);
  } catch {
  }
  const patterns = [
    /\/file\/([A-Za-z0-9_-]+)/,
    /\/medias\/([A-Za-z0-9_-]+)\/(?:download|preview_download)/,
    /[?&]file_token=([A-Za-z0-9_-]+)/,
    /\/medias\/([A-Za-z0-9_-]+)(?:[?#/]|$)/
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match?.[1])
      return match[1];
  }
  return void 0;
}
function collectRemoteImages(content) {
  const refs = [];
  const lines = content.split("\n");
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced)
      continue;
    MARKDOWN_IMAGE.lastIndex = 0;
    let match = MARKDOWN_IMAGE.exec(line);
    while (match) {
      const url = match[2];
      refs.push({ raw: match[0], url, token: extractMediaToken(url), alt: match[1], index: refs.length });
      match = MARKDOWN_IMAGE.exec(line);
    }
    XML_IMAGE.lastIndex = 0;
    let xml = XML_IMAGE.exec(line);
    while (xml) {
      const tag = xml[0];
      const url = /(?:href|src|url)="([^"]*)"/.exec(tag)?.[1] ?? "";
      const token = /token="([^"]*)"/.exec(tag)?.[1] ?? (url ? extractMediaToken(url) : void 0);
      if (url || token) {
        const alt = /(?:caption|alt)="([^"]*)"/.exec(tag)?.[1] ?? "";
        refs.push({ raw: tag, url, token: token || void 0, alt, index: refs.length });
      }
      xml = XML_IMAGE.exec(line);
    }
  }
  return refs;
}
function normalizeRemoteImageUrls(content) {
  let out = content;
  for (const ref of collectRemoteImages(content)) {
    if (!ref.token)
      continue;
    out = out.split(ref.raw).join(ref.raw.replace(ref.url, `media:${ref.token}`));
  }
  return out;
}
var unescapeImageMarkup = {
  id: "unescape-image-markup",
  description: "\u4E0B\u884C\uFF1A\u98DE\u4E66\u628A\u5B83\u89E3\u6790\u4E0D\u4E86\u7684\u56FE\u7247\u5F15\u7528\u8F6C\u4E49\u6210 !\\[\\](\u8DEF\u5F84) \u8FD9\u6837\u7684\u5F62\u6001\uFF0C\u76F4\u63A5\u5199\u56DE\u672C\u5730\u4F1A\u53D8\u6210\u6E32\u67D3\u4E0D\u51FA\u6765\u7684\u574F\u5F15\u7528\u3002\u8FD9\u6761\u89C4\u5219\u628A\u56FE\u7247\u5F15\u7528\u91CC\u7684\u8F6C\u4E49\u65B9\u62EC\u53F7\u8FD8\u539F\uFF08\u53EA\u5904\u7406\u56FE\u7247\u8BED\u6CD5\uFF0C\u4E0D\u52A8\u666E\u901A\u94FE\u63A5\u4E0E\u6B63\u6587\uFF09\u3002",
  defaultEnabled: true,
  apply: (input) => input.replace(/!\\\[\\\[([^\]]*?)\\\]\\\]/g, "![[$1]]").replace(/!\\\[\\\]\(/g, "![](")
};
var imageDownload = {
  id: "image-download",
  description: "\u4E0B\u884C\uFF1A\u628A\u53D6\u56DE\u5185\u5BB9\u91CC\u7684\u98DE\u4E66\u56FE\u7247\u4E0B\u8F7D\u5230\u672C\u5730\u9644\u4EF6\u76EE\u5F55\uFF0C\u5E76\u628A\u5F15\u7528\u6539\u5199\u6210 ![[\u9644\u4EF6\u76EE\u5F55/\u6587\u4EF6\u540D]]\u3002\u9700\u8981 docs:document.media:download \u6743\u9650\uFF1B\u4E0B\u8F7D\u5931\u8D25\u65F6\u4FDD\u7559\u539F\u59CB\u5F15\u7528\u5E76\u5728\u62A5\u544A\u91CC\u8BF4\u660E\uFF0C\u4E0D\u4F1A\u8BA9\u6574\u6B21\u62C9\u53D6\u5931\u8D25\u3002",
  defaultEnabled: true,
  apply: (input, ctx) => {
    const downloads = ctx.imageDownloads;
    if (!downloads || downloads.size === 0)
      return input;
    let out = input;
    for (const [raw, localPath] of downloads) {
      if (!localPath)
        continue;
      const target = ctx.attachmentLinkStyle === "path" ? localPath : localPath.split("/").pop() ?? localPath;
      out = out.split(raw).join(`![[${target}]]`);
    }
    return out;
  }
};
var BUILT_IN_RULES = {
  toFeishu: [
    sourceDiagnostics,
    imageRefNormalize,
    tabIndentToSpaces,
    mathEscapeHash,
    mathTrimInlineSpaces,
    inlineFormulaToBlock,
    blockFormulaOwnParagraph,
    listExitAfterHardbreak,
    nativeMath,
    footnoteDowngrade,
    imageUpload
  ],
  toObsidian: [unescapeImageMarkup, dropTitleHeading, restoreNativeMath, mathEscapeHash, mathTrimInlineSpaces, imageDownload, restoreImageRef]
};
function entryOf(rule) {
  return { id: rule.id, enabled: rule.defaultEnabled, description: rule.description };
}
function defaultRulesFile() {
  return {
    version: RULES_VERSION,
    toFeishu: BUILT_IN_RULES.toFeishu.map(entryOf),
    toObsidian: BUILT_IN_RULES.toObsidian.map(entryOf)
  };
}
function mergeDirection(direction, raw, warnings) {
  const builtIns = BUILT_IN_RULES[direction];
  const byId = new Map(builtIns.map((rule) => [rule.id, rule]));
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  if (Array.isArray(raw)) {
    for (const item3 of raw) {
      const id = typeof item3?.id === "string" ? item3.id : "";
      if (!id)
        continue;
      const builtIn = byId.get(id);
      if (!builtIn) {
        warnings.push(`\u89C4\u5219\u6587\u4EF6\u91CC ${direction} \u7684 "${id}" \u4E0D\u662F\u5185\u7F6E\u89C4\u5219\uFF0C\u5DF2\u5FFD\u7565`);
        continue;
      }
      if (seen.has(id))
        continue;
      seen.add(id);
      const enabled = typeof item3.enabled === "boolean" ? item3.enabled : builtIn.defaultEnabled;
      merged.push({ id, enabled, description: builtIn.description });
    }
  }
  for (const rule of builtIns) {
    if (seen.has(rule.id))
      continue;
    warnings.push(`\u89C4\u5219\u6587\u4EF6\u91CC ${direction} \u7F3A\u5C11 "${rule.id}"\uFF0C\u5DF2\u6309\u9ED8\u8BA4\u503C\uFF08${rule.defaultEnabled ? "\u5F00" : "\u5173"}\uFF09\u8865\u4E0A`);
    merged.push(entryOf(rule));
  }
  return merged;
}
function mergeRulesFile(raw, warnings = []) {
  const source = raw ?? {};
  return {
    version: typeof source.version === "number" ? source.version : RULES_VERSION,
    toFeishu: mergeDirection("toFeishu", source.toFeishu, warnings),
    toObsidian: mergeDirection("toObsidian", source.toObsidian, warnings)
  };
}
function parseRulesFile(text, warnings = []) {
  return mergeRulesFile(JSON.parse(text), warnings);
}
async function writeRulesFile(adapter, rules) {
  const path = (0, import_obsidian4.normalizePath)(RULES_PATH);
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir)
    await ensureFolder(adapter, dir);
  await adapter.write(path, `${JSON.stringify(rules, null, 2)}
`);
}
async function loadRules(adapter, logger) {
  const path = (0, import_obsidian4.normalizePath)(RULES_PATH);
  if (!await adapter.exists(path)) {
    const rules = defaultRulesFile();
    try {
      await writeRulesFile(adapter, rules);
      logger?.info(`\u5DF2\u5199\u5165\u9ED8\u8BA4\u8F6C\u6362\u89C4\u5219\uFF1A${RULES_PATH}`);
    } catch (error) {
      logger?.warn(`\u5199\u5165\u9ED8\u8BA4\u8F6C\u6362\u89C4\u5219\u5931\u8D25\uFF08\u7EE7\u7EED\u7528\u5185\u7F6E\u9ED8\u8BA4\u503C\uFF09\uFF1A${String(error)}`);
    }
    return rules;
  }
  try {
    const warnings = [];
    const rules = parseRulesFile(await adapter.read(path), warnings);
    for (const warning of warnings)
      logger?.warn(`\u8F6C\u6362\u89C4\u5219\uFF1A${warning}`);
    return rules;
  } catch (error) {
    logger?.warn(`\u8F6C\u6362\u89C4\u5219\u6587\u4EF6\u65E0\u6CD5\u89E3\u6790\uFF0C\u672C\u6B21\u4F7F\u7528\u5185\u7F6E\u9ED8\u8BA4\u503C\uFF08\u6587\u4EF6\u672A\u6539\u52A8\uFF09\uFF1A${String(error)}`);
    return defaultRulesFile();
  }
}
function applyRules(direction, input, ctx, rules) {
  const enabled = new Set(rules[direction].filter((entry) => entry.enabled).map((entry) => entry.id));
  let output = input;
  for (const rule of BUILT_IN_RULES[direction]) {
    if (!enabled.has(rule.id))
      continue;
    output = rule.apply(output, ctx);
  }
  return output;
}
var COSMETIC_PUBLISH_RULE_IDS = [
  "math-escape-hash",
  "math-trim-inline-spaces",
  "inline-formula-to-block",
  "block-formula-own-paragraph",
  "list-exit-after-hardbreak",
  "native-math"
];
function sameAfterCosmeticRules(a, b, ctx, rules) {
  const enabled = new Set(rules.toFeishu.filter((entry) => entry.enabled).map((entry) => entry.id));
  const normalize = (text) => {
    let output = text;
    for (const rule of BUILT_IN_RULES.toFeishu) {
      if (!COSMETIC_PUBLISH_RULE_IDS.includes(rule.id) || !enabled.has(rule.id))
        continue;
      output = rule.apply(output, ctx);
    }
    return output;
  };
  return normalize(a) === normalize(b);
}
function ruleEnabled(rules, direction, id) {
  return rules[direction].some((entry) => entry.id === id && entry.enabled);
}
function normalizeObsidianMath(input, rules) {
  let out = input;
  for (const rule of [restoreNativeMath, mathEscapeHash, mathTrimInlineSpaces]) {
    if (ruleEnabled(rules, "toObsidian", rule.id))
      out = rule.apply(out, { relPath: "", documentTitle: "", localContent: input });
  }
  return out;
}
function publishRulesFingerprint(rules) {
  const enabled = new Set(rules.toFeishu.filter((entry) => entry.enabled).map((entry) => entry.id));
  return JSON.stringify([PUBLISH_RULES_REVISION, BUILT_IN_RULES.toFeishu.filter((rule) => rule.id !== "source-format-diagnostics" && enabled.has(rule.id)).map((rule) => rule.id)]);
}
function pullRulesFingerprint(rules) {
  const enabled = new Set(rules.toObsidian.filter((entry) => entry.enabled).map((entry) => entry.id));
  return JSON.stringify([1, BUILT_IN_RULES.toObsidian.filter((rule) => enabled.has(rule.id)).map((rule) => rule.id)]);
}

// src/settings-tab.ts
var SpacePickerModal = class extends import_obsidian5.FuzzySuggestModal {
  constructor(app, spaces, onChoose) {
    super(app);
    this.spaces = spaces;
    this.onChoose = onChoose;
    this.setPlaceholder("\u9009\u62E9\u8981\u540C\u6B65\u7684\u77E5\u8BC6\u7A7A\u95F4");
  }
  getItems() {
    return this.spaces;
  }
  getItemText(space) {
    return `${space.name} \xB7 ${space.space_id}`;
  }
  onChooseItem(space) {
    this.onChoose(space);
  }
};
var FeishuWikiSyncSettingTab = class extends import_obsidian5.PluginSettingTab {
  constructor(app, host) {
    super(app, host);
    this.host = host;
  }
  display() {
    const { containerEl } = this;
    const settings = this.host.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Feishu Wiki Sync" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "\u628A vault \u4E0E\u98DE\u4E66\u77E5\u8BC6\u5E93\u91CC\u7684\u539F\u751F Markdown \u6587\u4EF6\u505A\u53CC\u5411\u540C\u6B65\u3002\u5185\u5BB9\u6309\u5B57\u8282\u5F80\u8FD4\uFF0C\u53CC\u94FE\u3001frontmatter\u3001\u4EE3\u7801\u5757\u90FD\u4F1A\u539F\u6837\u4FDD\u7559\u3002"
    });
    this.renderAuth(containerEl, settings);
    this.renderTarget(containerEl, settings);
    this.renderSyncMode(containerEl, settings);
    this.renderRules(containerEl);
    this.renderBehaviour(containerEl, settings);
    this.renderProbe(containerEl, settings);
    this.renderState(containerEl, settings);
  }
  renderSyncMode(containerEl, settings) {
    containerEl.createEl("h3", { text: "\u540C\u6B65\u6A21\u5F0F" });
    new import_obsidian5.Setting(containerEl).setName("\u7B14\u8BB0\u540C\u6B65\u5F62\u6001").setDesc(
      "\u6587\u4EF6\u955C\u50CF\uFF1A\u7B14\u8BB0\u539F\u6837\u5B58\u6210\u77E5\u8BC6\u5E93\u91CC\u7684 .md \u6587\u4EF6\uFF0C\u5B57\u8282\u65E0\u635F\uFF08\u53CC\u94FE\u3001frontmatter\u3001\u4EE3\u7801\u5757\u539F\u6837\u5F80\u8FD4\uFF09\uFF0C\u98DE\u4E66\u4FA7\u6E32\u67D3\u6734\u7D20\u3002\u6587\u6863\u6A21\u5F0F\uFF1A\u7B14\u8BB0\u5B58\u6210\u98DE\u4E66\u65B0\u7248\u6587\u6863\uFF0C\u5F85\u529E/\u8868\u683C/\u4EE3\u7801/\u516C\u5F0F/callout \u90FD\u662F\u539F\u751F\u5757\uFF0C\u98DE\u4E66\u4FA7\u7F16\u8F91\u80FD\u540C\u6B65\u56DE\u6765\uFF0C\u4F46\u5185\u5BB9\u4F1A\u7ECF\u8FC7\u98DE\u4E66\u683C\u5F0F\u5316\uFF08Tab\u2192\u7A7A\u683C\u3001\u5217\u8868\u95F4\u63D2\u7A7A\u884C\u3001\u516C\u5F0F\u538B\u6210\u5355\u884C\u3001\u6807\u9898\u53D8\u6210\u6B63\u6587\u91CC\u7684 H1\uFF09\uFF0C\u6807\u51C6 Markdown \u56FE\u7247\u5F15\u7528\u4F1A\u88AB\u98DE\u4E66\u4E22\u6389\uFF08\u9ED8\u8BA4\u7531\u4E0A\u884C\u89C4\u5219\u5148\u8F6C\u6210 ![[...]]\uFF09\u3002\u5207\u6362\u6A21\u5F0F\u4E0D\u4F1A\u8986\u76D6\u672C\u5730\uFF1A\u6587\u6863\u6A21\u5F0F\u7B2C\u4E00\u6B21\u8DD1\u4F1A\u6309\u300C\u9996\u6B21\u5BF9\u63A5\u300D\u91CD\u65B0\u5224\u5B9A\uFF08\u4E24\u8FB9\u5185\u5BB9\u4E00\u81F4\u5C31\u53EA\u5EFA\u7ACB\u6620\u5C04\uFF0C\u4E0D\u4E00\u81F4\u5219\u4FDD\u7559\u53CC\u65B9\uFF09\u3002"
    ).addDropdown(
      (dropdown) => dropdown.addOption("md", "\u6587\u4EF6\u955C\u50CF\uFF08\u539F\u751F Markdown\uFF09").addOption("doc", "\u6587\u6863\u6A21\u5F0F\uFF08\u98DE\u4E66\u65B0\u7248\u6587\u6863\uFF09").setValue(settings.syncMode).onChange(async (value) => {
        const next = value === "doc" ? "doc" : "md";
        if (next === settings.syncMode)
          return;
        settings.syncMode = next;
        await this.host.saveSettings();
        this.host.refreshAutoSync();
        new import_obsidian5.Notice(
          next === "doc" ? "\u5DF2\u5207\u5230\u6587\u6863\u6A21\u5F0F\uFF1A\u4E0B\u4E00\u6B21\u540C\u6B65\u6309\u300C\u9996\u6B21\u5BF9\u63A5\u300D\u5224\u5B9A\uFF0C\u4E0D\u4F1A\u76F4\u63A5\u8986\u76D6\u672C\u5730" : "\u5DF2\u5207\u5230\u6587\u4EF6\u955C\u50CF\u6A21\u5F0F\uFF1A\u4E0B\u4E00\u6B21\u540C\u6B65\u6309\u300C\u9996\u6B21\u5BF9\u63A5\u300D\u5224\u5B9A\uFF0C\u4E0D\u4F1A\u76F4\u63A5\u8986\u76D6\u672C\u5730"
        );
        this.display();
      })
    );
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `\u5F53\u524D\uFF1A${settings.syncMode === "doc" ? "\u6587\u6863\u6A21\u5F0F\uFF08\u98DE\u4E66\u65B0\u7248\u6587\u6863 docx\uFF09" : "\u6587\u4EF6\u955C\u50CF\uFF08\u539F\u751F Markdown \u6587\u4EF6\uFF09"} \xB7 \u6587\u6863\u6A21\u5F0F\u7684\u8F6C\u6362\u89C4\u5219\u5728 ${RULES_PATH}`
    });
  }
  renderRules(containerEl) {
    containerEl.createEl("h3", { text: "\u8F6C\u6362\u89C4\u5219\uFF08\u6587\u6863\u6A21\u5F0F\uFF09" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `\u89C4\u5219\u6587\u4EF6\uFF1A${RULES_PATH}\uFF0C\u6BCF\u6761\u89C4\u5219\u90FD\u6709 enabled \u5F00\u5173\u4E0E description \u8BF4\u660E\u3002\u4E0A\u884C\u89C4\u5219\u5728\u53D1\u7ED9\u98DE\u4E66\u4E4B\u524D\u4F5C\u7528\u4E8E\u672C\u5730 Markdown\uFF0C\u4E0B\u884C\u89C4\u5219\u5728\u5199\u56DE\u672C\u5730\u4E4B\u524D\u4F5C\u7528\u4E8E\u53D6\u56DE\u7684 Markdown\u3002\u6587\u4EF6\u4E0D\u5B58\u5728\u65F6\u4F1A\u81EA\u52A8\u5199\u5165\u4E00\u4EFD\u5B8C\u6574\u9ED8\u8BA4\u89C4\u5219\uFF1B\u52A0\u8F7D\u65F6\u4E0E\u5185\u7F6E\u9ED8\u8BA4\u6309 id \u5408\u5E76\uFF0C\u6539\u8FC7\u7684\u4EE5\u6587\u4EF6\u4E3A\u51C6\u3002\u4E0A\u884C\u89C4\u5219\u66F4\u65B0\u540E\uFF0C\u65E7\u6587\u6863\u4F1A\u8FDB\u5165\u5237\u65B0\u8BA1\u5212\uFF1B\u98DE\u4E66\u6709\u65B0\u6539\u52A8\u65F6\u4F18\u5148\u5904\u7406\u6539\u52A8\u3002\u539F\u7A3F\u683C\u5F0F\u95EE\u9898\u4F1A\u663E\u793A\u5728\u9884\u89C8\u548C\u62A5\u544A\u4E2D\u3002`
    });
    new import_obsidian5.Setting(containerEl).setName("\u6253\u5F00\u89C4\u5219\u6587\u4EF6").setDesc("\u7528\u7CFB\u7EDF\u9ED8\u8BA4\u7A0B\u5E8F\u6253\u5F00 rules.json\uFF0C\u6539\u5B8C\u4FDD\u5B58\uFF0C\u4E0B\u6B21\u540C\u6B65\u751F\u6548").addButton(
      (button) => button.setButtonText("\u6253\u5F00").onClick(async () => {
        const adapter = this.host.app.vault.adapter;
        const path = (0, import_obsidian5.normalizePath)(RULES_PATH);
        try {
          if (!await adapter.exists(path))
            await writeRulesFile(adapter, defaultRulesFile());
          const app = this.host.app;
          if (typeof app.openWithDefaultApp === "function") {
            await app.openWithDefaultApp(path);
          } else {
            new import_obsidian5.Notice(`\u8BF7\u5728\u6587\u4EF6\u7CFB\u7EDF\u91CC\u6253\u5F00 ${path}`);
          }
        } catch (error) {
          new import_obsidian5.Notice(`\u6253\u5F00\u89C4\u5219\u6587\u4EF6\u5931\u8D25\uFF1A${String(error)}\u3002\u6587\u4EF6\u4F4D\u7F6E\uFF1A${path}`, 8e3);
        }
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u91CD\u5EFA\u4E3A\u9ED8\u8BA4\u89C4\u5219").setDesc("\u7528\u5185\u7F6E\u9ED8\u8BA4\u89C4\u5219\u8986\u76D6 rules.json\uFF08\u4F1A\u4E22\u6389\u4F60\u5728\u6587\u4EF6\u91CC\u7684\u6539\u52A8\uFF09\uFF0C\u5E76\u505A\u4E00\u6B21\u89E3\u6790\u68C0\u67E5").addButton(
      (button) => button.setButtonText("\u91CD\u5EFA").onClick(async () => {
        try {
          const adapter = this.host.app.vault.adapter;
          await writeRulesFile(adapter, defaultRulesFile());
          const rules = await loadRules(adapter, this.host.logger);
          const enabled = (list) => list.filter((entry) => entry.enabled).length;
          new import_obsidian5.Notice(
            `\u5DF2\u91CD\u5EFA ${RULES_PATH}\uFF1A\u4E0A\u884C ${enabled(rules.toFeishu)} \u6761\u3001\u4E0B\u884C ${enabled(rules.toObsidian)} \u6761\u89C4\u5219\u5F00\u542F`,
            8e3
          );
          this.display();
        } catch (error) {
          new import_obsidian5.Notice(`\u91CD\u5EFA\u89C4\u5219\u6587\u4EF6\u5931\u8D25\uFF1A${String(error)}`, 8e3);
        }
      })
    );
  }
  renderAuth(containerEl, settings) {
    containerEl.createEl("h3", { text: "\u98DE\u4E66\u5E94\u7528\u4E0E\u6388\u6743" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "\u9700\u8981\u4E00\u4E2A\u98DE\u4E66\u4F01\u4E1A\u81EA\u5EFA\u5E94\u7528\u3002\u5EFA\u8BAE\u5F00\u901A\u7684\u6743\u9650\uFF1Adrive:drive\uFF08\u4E91\u7A7A\u95F4\u6587\u4EF6\u8BFB\u5199\uFF09\u3001wiki:wiki\uFF08\u77E5\u8BC6\u5E93\uFF09\u3001docs:document.media:download\uFF08\u4E0B\u8F7D\u7D20\u6750\uFF09\u3002\u7528\u300C\u7528\u6237\u6388\u6743\u300D\u65F6\u8FD8\u8981\u5728\u5F00\u653E\u5E73\u53F0\u767B\u8BB0\u4E0B\u65B9\u91CD\u5B9A\u5411\u5730\u5740\uFF0C\u5E76\u5305\u542B offline_access \u4EE5\u81EA\u52A8\u7EED\u671F\u3002"
    });
    new import_obsidian5.Setting(containerEl).setName("\u8EAB\u4EFD\u6A21\u5F0F").setDesc("\u7528\u6237\u6388\u6743\uFF1A\u4EE5\u4F60\u672C\u4EBA\u7684\u8EAB\u4EFD\u8BBF\u95EE\u4E2A\u4EBA\u77E5\u8BC6\u5E93\uFF08\u63A8\u8350\uFF09\u3002\u5E94\u7528\u8EAB\u4EFD\uFF1A\u9700\u8981\u628A\u5E94\u7528\u6DFB\u52A0\u4E3A\u77E5\u8BC6\u5E93\u6210\u5458\u3002").addDropdown(
      (dropdown) => dropdown.addOption("user", "\u7528\u6237\u6388\u6743\uFF08user_access_token\uFF09").addOption("tenant", "\u5E94\u7528\u8EAB\u4EFD\uFF08tenant_access_token\uFF09").setValue(settings.authMode).onChange(async (value) => {
        settings.authMode = value;
        await this.host.saveSettings();
        this.display();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("App ID").setDesc("\u98DE\u4E66\u5F00\u653E\u5E73\u53F0 \u2192 \u51ED\u8BC1\u4E0E\u57FA\u7840\u4FE1\u606F").addText(
      (text) => text.setValue(settings.appId).onChange(async (value) => {
        settings.appId = value.trim();
        await this.host.saveSettings();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("App Secret").setDesc("\u4FDD\u5B58\u5728\u63D2\u4EF6\u7684 data.json \u91CC\uFF0C\u8BF7\u52FF\u628A\u8BE5\u6587\u4EF6\u540C\u6B65\u5230\u516C\u5F00\u4ED3\u5E93").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(settings.appSecret).onChange(async (value) => {
        settings.appSecret = value.trim();
        await this.host.saveSettings();
      });
    });
    if (settings.authMode === "user") {
      new import_obsidian5.Setting(containerEl).setName("\u91CD\u5B9A\u5411\u5730\u5740").setDesc("\u9700\u8981\u4E0E\u5F00\u653E\u5E73\u53F0\u91CC\u767B\u8BB0\u7684\u56DE\u8C03\u5730\u5740\u5B8C\u5168\u4E00\u81F4").addText(
        (text) => text.setValue(settings.redirectUri).onChange(async (value) => {
          settings.redirectUri = value.trim();
          await this.host.saveSettings();
        })
      );
      new import_obsidian5.Setting(containerEl).setName("\u6388\u6743\u8303\u56F4").setDesc("\u7A7A\u683C\u5206\u9694\uFF0C\u5FC5\u987B\u90FD\u662F\u5E94\u7528\u5DF2\u5F00\u901A\u7684\u6743\u9650\uFF1Boffline_access \u7528\u4E8E\u81EA\u52A8\u7EED\u671F").addText(
        (text) => text.setValue(settings.oauthScope).onChange(async (value) => {
          settings.oauthScope = value.trim();
          await this.host.saveSettings();
        })
      );
      const tokens = settings.userTokens;
      new import_obsidian5.Setting(containerEl).setName("\u6388\u6743\u72B6\u6001").setDesc(
        tokens?.refreshToken ? `\u5DF2\u6388\u6743\uFF0Crefresh token \u6709\u6548\u81F3 ${new Date(tokens.refreshExpiresAt).toLocaleString()}` : "\u5C1A\u672A\u6388\u6743"
      ).addButton(
        (button) => button.setButtonText(tokens?.refreshToken ? "\u91CD\u65B0\u6388\u6743" : "\u6388\u6743\u98DE\u4E66\u8D26\u53F7").setCta().onClick(async () => {
          try {
            await this.host.startAuthorization();
            this.display();
          } catch (error) {
            new import_obsidian5.Notice(`\u6388\u6743\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
          }
        })
      ).addButton(
        (button) => button.setButtonText("\u624B\u52A8\u7C98\u8D34\u6388\u6743\u7801").onClick(async () => {
          try {
            await this.host.startManualAuthorization();
            this.display();
          } catch (error) {
            new import_obsidian5.Notice(`\u6388\u6743\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
          }
        })
      ).addButton(
        (button) => button.setButtonText("\u64A4\u9500\u6388\u6743").onClick(async () => {
          await this.host.revokeAuthorization();
          this.display();
        })
      );
    }
    new import_obsidian5.Setting(containerEl).setName("\u8FDE\u63A5\u6D4B\u8BD5").setDesc("\u62C9\u53D6\u5F53\u524D\u8EAB\u4EFD\u53EF\u89C1\u7684\u77E5\u8BC6\u7A7A\u95F4\u5217\u8868").addButton(
      (button) => button.setButtonText("\u6D4B\u8BD5").onClick(async () => {
        try {
          const spaces = await this.host.engine.listSpaces();
          new import_obsidian5.Notice(spaces.length > 0 ? `\u8FDE\u63A5\u6210\u529F\uFF0C\u53EF\u89C1\u77E5\u8BC6\u7A7A\u95F4 ${spaces.length} \u4E2A` : "\u8FDE\u63A5\u6210\u529F\uFF0C\u4F46\u6CA1\u6709\u53EF\u89C1\u7684\u77E5\u8BC6\u7A7A\u95F4");
        } catch (error) {
          new import_obsidian5.Notice(`\u8FDE\u63A5\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`, 8e3);
        }
      })
    );
  }
  renderTarget(containerEl, settings) {
    containerEl.createEl("h3", { text: "\u540C\u6B65\u76EE\u6807" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "\u672C\u5730 vault \u6839\u76EE\u5F55 \u2194 \u77E5\u8BC6\u7A7A\u95F4\u3002\u53EA\u6709 .md \u6587\u4EF6\u53C2\u4E0E\u540C\u6B65\uFF1B\u540C\u6B65\u4F1A\u5728\u77E5\u8BC6\u5E93\u91CC\u6309\u672C\u5730\u76EE\u5F55\u5C42\u7EA7\u521B\u5EFA\u9875\u9762\u3002"
    });
    new import_obsidian5.Setting(containerEl).setName("\u77E5\u8BC6\u7A7A\u95F4 space_id").setDesc("\u53EF\u7C98\u8D34\u77E5\u8BC6\u5E93\u94FE\u63A5\uFF0C\u4E5F\u53EF\u4EE5\u76F4\u63A5\u62C9\u53D6\u5217\u8868\u9009\u62E9").addText(
      (text) => text.setValue(settings.spaceId).onChange(async (value) => {
        settings.spaceId = value.trim();
        await this.host.saveSettings();
      })
    ).addButton(
      (button) => button.setButtonText("\u62C9\u53D6\u5217\u8868").onClick(async () => {
        try {
          const spaces = await this.host.engine.listSpaces();
          if (spaces.length === 0) {
            new import_obsidian5.Notice("\u5F53\u524D\u8EAB\u4EFD\u770B\u4E0D\u5230\u4EFB\u4F55\u77E5\u8BC6\u7A7A\u95F4");
            return;
          }
          new SpacePickerModal(this.app, spaces, async (space) => {
            settings.spaceId = space.space_id;
            await this.host.saveSettings();
            new import_obsidian5.Notice(`\u5DF2\u9009\u62E9\u77E5\u8BC6\u7A7A\u95F4\uFF1A${space.name}`);
            this.display();
          }).open();
        } catch (error) {
          new import_obsidian5.Notice(`\u62C9\u53D6\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`, 8e3);
        }
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u540C\u6B65\u6839\u8282\u70B9\uFF08\u53EF\u7559\u7A7A\uFF09").setDesc(
      "\u7559\u7A7A = \u4EE5\u77E5\u8BC6\u7A7A\u95F4\u9876\u5C42\u4E3A\u540C\u6B65\u6839\uFF1Avault \u7684\u4E00\u7EA7\u76EE\u5F55\u4F1A\u53D8\u6210\u77E5\u8BC6\u5E93\u91CC\u7684\u4E00\u7EA7\u9875\u9762\uFF08vault \u6839\u76EE\u5F55\u4E0B\u7684\u6563\u88C5\u7B14\u8BB0\u4F1A\u653E\u8FDB\u4E0B\u65B9\u90A3\u4E2A\u9876\u5C42\u9875\u9762\u91CC\uFF09\u3002\u586B\u8282\u70B9\u94FE\u63A5\u6216 node_token \u5219\u6240\u6709\u5185\u5BB9\u90FD\u6302\u5230\u8BE5\u8282\u70B9\u4E0B\u9762\uFF0C\u98DE\u4E66\u4FA7\u4E0D\u4F1A\u591A\u51FA\u4E00\u4E2A\u6839\u9875\u9762\u3002\u6CE8\u610F\uFF1A\u7559\u7A7A\u65F6\uFF0C\u77E5\u8BC6\u5E93\u9876\u5C42\u5DF2\u6709\u7684 .md \u6587\u4EF6\u4F1A\u88AB\u62C9\u53D6\u5230\u4F60\u7684 vault \u6839\u76EE\u5F55\u3002"
    ).addText(
      (text) => text.setValue(settings.rootNodeToken).onChange(async (value) => {
        settings.rootNodeToken = value.trim();
        await this.host.saveSettings();
        this.display();
      })
    );
    if (!settings.rootNodeToken.trim()) {
      new import_obsidian5.Setting(containerEl).setName("\u6839\u76EE\u5F55\u9875\u9762\u6807\u9898").setDesc("\u5B58\u653E vault \u6839\u76EE\u5F55\u4E0B\u7B14\u8BB0\u7684\u90A3\u4E2A\u77E5\u8BC6\u5E93\u4E00\u7EA7\u9875\u9762\u7684\u540D\u79F0\uFF0C\u7559\u7A7A\u5219\u7528 vault \u7684\u540D\u5B57\uFF08\u5F53\u524D\uFF1A" + this.app.vault.getName() + "\uFF09").addText(
        (text) => text.setValue(settings.rootPageTitle).onChange(async (value) => {
          settings.rootPageTitle = value.trim();
          await this.host.saveSettings();
        })
      );
    }
  }
  renderBehaviour(containerEl, settings) {
    containerEl.createEl("h3", { text: "\u540C\u6B65\u884C\u4E3A" });
    new import_obsidian5.Setting(containerEl).setName("\u9644\u4EF6\u76EE\u5F55").setDesc("\u6587\u6863\u6A21\u5F0F\u4E0B\u884C\u65F6\uFF0C\u4ECE\u98DE\u4E66\u4E0B\u8F7D\u7684\u56FE\u7247\u653E\u5230\u8FD9\u4E2A\u76EE\u5F55\uFF08\u76F8\u5BF9 vault \u6839\uFF0C\u586B attachments \u8FD9\u7C7B\u76F8\u5BF9\u8DEF\u5F84\uFF1B\u76EE\u5F55\u4E0D\u5B58\u5728\u4F1A\u81EA\u52A8\u521B\u5EFA\uFF09\u3002").addText(
      (text) => text.setValue(settings.attachmentFolder).onChange(async (value) => {
        settings.attachmentFolder = value.trim() || "attachments";
        await this.host.saveSettings();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u9644\u4EF6\u94FE\u63A5\u5199\u6CD5").setDesc("\u4ECE\u98DE\u4E66\u4E0B\u8F7D\u56FE\u7247\u540E\uFF0C\u7B14\u8BB0\u91CC\u5F15\u7528\u5199\u6210\u54EA\u79CD\u5F62\u5F0F\u3002\u6700\u77ED\u8DEF\u5F84 = \u53EA\u5199\u6587\u4EF6\u540D\uFF08\u5982 ![[image-xxx.png]]\uFF0C\u4E0E Obsidian\u300C\u6700\u77ED\u8DEF\u5F84\u300D\u94FE\u63A5\u683C\u5F0F\u4E00\u81F4\uFF09\uFF1B\u5E26\u76EE\u5F55 = \u5199 ![[\u9644\u4EF6\u76EE\u5F55/\u6587\u4EF6\u540D]]\u3002").addDropdown(
      (dropdown) => dropdown.addOption("shortest", "\u53EA\u5199\u6587\u4EF6\u540D\uFF08\u6700\u77ED\u8DEF\u5F84\uFF09").addOption("path", "\u5E26\u9644\u4EF6\u76EE\u5F55\u524D\u7F00").setValue(settings.attachmentLinkStyle).onChange(async (value) => {
        settings.attachmentLinkStyle = value;
        await this.host.saveSettings();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u76EE\u5F55\u5C42\u7EA7").setDesc("\u955C\u50CF\u76EE\u5F55\uFF1A\u4E3A\u6BCF\u4E2A\u672C\u5730\u6587\u4EF6\u5939\u5EFA\u4E00\u4E2A\u77E5\u8BC6\u5E93\u8282\u70B9\uFF08\u4F1A\u591A\u51FA\u4E00\u4E9B\u7A7A\u6587\u6863\u9875\uFF09\u3002\u6241\u5E73\uFF1A\u6240\u6709\u7B14\u8BB0\u6302\u5728\u6839\u8282\u70B9\u4E0B\uFF0C\u6587\u4EF6\u540D\u7528\u5206\u9694\u7B26\u7F16\u7801\u8DEF\u5F84\u3002").addDropdown(
      (dropdown) => dropdown.addOption("nodes", "\u955C\u50CF\u76EE\u5F55\uFF08\u63A8\u8350\uFF09").addOption("flat", "\u6241\u5E73\u5316").setValue(settings.folderMode).onChange(async (value) => {
        settings.folderMode = value;
        await this.host.saveSettings();
        this.display();
      })
    );
    if (settings.folderMode === "flat") {
      new import_obsidian5.Setting(containerEl).setName("\u6241\u5E73\u5206\u9694\u7B26").setDesc("\u7528\u8BE5\u5B57\u7B26\u4E32\u66FF\u6362\u8DEF\u5F84\u91CC\u7684 /").addText(
        (text) => text.setValue(settings.flatSeparator).onChange(async (value) => {
          settings.flatSeparator = value || "__";
          await this.host.saveSettings();
        })
      );
    }
    new import_obsidian5.Setting(containerEl).setName("\u6392\u9664\u89C4\u5219").setDesc("\u6BCF\u884C\u4E00\u6761 glob\uFF0C\u652F\u6301 * \u4E0E **\u3002.obsidian/ \u4E0E .trash/ \u59CB\u7EC8\u6392\u9664\uFF0C\u51B2\u7A81\u526F\u672C\u76EE\u5F55\u4E5F\u59CB\u7EC8\u6392\u9664\u3002").addTextArea((area) => {
      area.setValue(settings.excludePatterns).onChange(async (value) => {
        settings.excludePatterns = value;
        await this.host.saveSettings();
      });
      area.inputEl.rows = 4;
    });
    new import_obsidian5.Setting(containerEl).setName("\u8FDC\u7AEF\u5DF2\u5220\u9664\u65F6\u81EA\u52A8\u91CD\u5EFA").setDesc("\u5173\u95ED\u65F6\uFF08\u63A8\u8350\uFF09\u53EA\u4F1A\u63D0\u793A\uFF0C\u4E0D\u4F1A\u628A\u672C\u5730\u6709\u4FEE\u6539\u7684\u7B14\u8BB0\u91CD\u65B0\u4F20\u4E0A\u53BB").addToggle(
      (toggle) => toggle.setValue(settings.recreateRemoteIfDeleted).onChange(async (value) => {
        settings.recreateRemoteIfDeleted = value;
        await this.host.saveSettings();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u6587\u6863\u6A21\u5F0F\uFF1A\u6BCF\u8F6E\u53D6\u56DE\u5168\u6587\u6821\u9A8C").setDesc(
      "\u5173\u95ED\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u5148\u7528\u98DE\u4E66\u8FD4\u56DE\u7684\u300C\u6700\u540E\u4FEE\u6539\u65F6\u95F4\u300D\uFF08\u79D2\u7EA7\uFF09\u5224\u65AD\u8FDC\u7AEF\u6709\u6CA1\u6709\u53D8\uFF0C\u6CA1\u53D8\u5C31\u4E0D\u53D6\u56DE\u5168\u6587\uFF0C\u4E00\u8F6E\u53EA\u591A\u4E00\u6B21\u6279\u91CF\u5143\u6570\u636E\u8BF7\u6C42\u3002\u4EE3\u4EF7\u662F\u7406\u8BBA\u4E0A\u5B58\u5728\u6781\u7AEF\u60C5\u51B5\u2014\u2014\u540C\u4E00\u79D2\u5185\u7684\u8FDC\u7AEF\u6539\u52A8\u53EF\u80FD\u88AB\u6F0F\u5224\u5230\u4E0B\u4E00\u6B21\u65F6\u95F4\u6233\u53D8\u5316\u3002\u6253\u5F00\uFF1A\u5FFD\u7565\u65F6\u95F4\u6233\uFF0C\u6BCF\u8F6E\u5BF9\u6BCF\u7BC7\u5DF2\u8BB0\u5F55\u6587\u6863\u90FD\u53D6\u56DE\u5168\u6587\u9010\u7BC7\u6821\u9A8C\uFF0C\u6700\u7A33\uFF0C\u4F46\u8BF7\u6C42\u6570\u4E0E\u6D41\u91CF\u660E\u663E\u66F4\u9AD8\u3002"
    ).addToggle(
      (toggle) => toggle.setValue(settings.docVerifyRemoteByContent).onChange(async (value) => {
        settings.docVerifyRemoteByContent = value;
        await this.host.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "\u5220\u9664\u4F20\u64AD\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF09" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "\u4E24\u4E2A\u5F00\u5173\u90FD\u5173\u7740\u65F6\uFF0C\u4EFB\u4F55\u4E00\u8FB9\u5220\u9664\u90FD\u53EA\u5728\u540C\u6B65\u7ED3\u679C\u91CC\u63D0\u793A\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u5220\u53E6\u4E00\u8FB9\u3002\u6253\u5F00\u540E\u5220\u9664\u4F1A\u51FA\u73B0\u5728\u8BA1\u5212\u9884\u89C8\u7684\u72EC\u7ACB\u5206\u7EC4\u91CC\uFF0C\u9700\u8981\u4F60\u5728\u9884\u89C8\u6846\u91CC\u786E\u8BA4\u624D\u4F1A\u6267\u884C\u3002"
    });
    new import_obsidian5.Setting(containerEl).setName("\u672C\u5730\u5220\u9664\u540E\u540C\u65F6\u5220\u9664\u8FDC\u7AEF").setDesc(
      "\u672C\u5730\u5220\u6389\u7684\u7B14\u8BB0\uFF0C\u540C\u6B65\u65F6\u628A\u8FDC\u7AEF\u5BF9\u5E94\u7684\u6587\u4EF6/\u6587\u6863\u4E00\u8D77\u5220\u6389\uFF08\u8D70\u4E91\u7A7A\u95F4\u63A5\u53E3\uFF0C\u5220\u9664\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\uFF0C\u53EF\u4EE5\u6062\u590D\uFF09\u3002\u8FDC\u7AEF\u81EA\u4E0A\u6B21\u540C\u6B65\u540E\u88AB\u6539\u8FC7\u3001\u6216\u8BE5\u8DEF\u5F84\u547D\u4E2D\u6392\u9664\u89C4\u5219\u65F6\uFF0C\u90FD\u4E0D\u4F1A\u5220\uFF0C\u4ECD\u7136\u6309\u51B2\u7A81/\u5FFD\u7565\u5904\u7406\u3002\u98CE\u9669\uFF1A\u548C\u300C\u5B9A\u65F6\u81EA\u52A8\u540C\u6B65\u300D\u4E00\u8D77\u6253\u5F00\uFF0C\u5C31\u7B49\u4E8E\u6309\u672C\u5730\u72B6\u6001\u65E0\u4EBA\u590D\u6838\u5730\u5220\u8FDC\u7AEF\u3002"
    ).addToggle(
      (toggle) => toggle.setValue(settings.propagateLocalDelete).onChange(async (value) => {
        settings.propagateLocalDelete = value;
        await this.host.saveSettings();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u8FDC\u7AEF\u5220\u9664\u540E\u540C\u65F6\u5220\u9664\u672C\u5730").setDesc(
      "\u8FDC\u7AEF\u5220\u6389\u7684\u6587\u4EF6/\u6587\u6863\uFF0C\u540C\u6B65\u65F6\u628A\u672C\u5730\u7B14\u8BB0\u79FB\u8FDB vault \u7684 .trash\uFF08\u4E0D\u662F\u6C38\u4E45\u5220\u9664\uFF09\uFF0C\u5E76\u6E05\u6389\u6620\u5C04\u5173\u7CFB\u3002\u672C\u5730\u81EA\u4E0A\u6B21\u540C\u6B65\u540E\u88AB\u6539\u8FC7\u65F6\u4E0D\u4F1A\u5220\uFF0C\u53EA\u4F1A\u63D0\u793A\u3002\u6CE8\u610F\uFF1A\u8FD9\u6761\u4F1A\u771F\u7684\u52A8\u4F60\u672C\u5730\u7684\u6587\u4EF6\uFF0C\u540C\u6837\u4F1A\u5728\u8BA1\u5212\u9884\u89C8\u91CC\u5355\u72EC\u5217\u51FA\u7B49\u4F60\u786E\u8BA4\u3002"
    ).addToggle(
      (toggle) => toggle.setValue(settings.propagateRemoteDelete).onChange(async (value) => {
        settings.propagateRemoteDelete = value;
        await this.host.saveSettings();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u540C\u6B65\u524D\u9884\u89C8\u8BA1\u5212").setDesc("\u6BCF\u6B21\u540C\u6B65\u5148\u5F39\u51FA\u8BA1\u5212\u786E\u8BA4\u6846").addToggle(
      (toggle) => toggle.setValue(settings.showPlanBeforeSync).onChange(async (value) => {
        settings.showPlanBeforeSync = value;
        await this.host.saveSettings();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u5B9A\u65F6\u81EA\u52A8\u540C\u6B65").setDesc("\u5355\u4F4D\u5206\u949F\uFF0C0 \u8868\u793A\u5173\u95ED\u3002\u81EA\u52A8\u540C\u6B65\u4E0D\u4F1A\u5F39\u51FA\u9884\u89C8\u6846\uFF0C\u51B2\u7A81\u4ECD\u7136\u53EA\u751F\u6210\u526F\u672C\u3002").addText(
      (text) => text.setValue(String(settings.autoSyncMinutes)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        settings.autoSyncMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        await this.host.saveSettings();
        this.host.refreshAutoSync();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u8C03\u8BD5\u65E5\u5FD7").setDesc(`\u5199\u5165 .obsidian/feishu-sync/sync.log`).addToggle(
      (toggle) => toggle.setValue(settings.debugLog).onChange(async (value) => {
        settings.debugLog = value;
        await this.host.saveSettings();
      })
    );
  }
  renderProbe(containerEl, settings) {
    containerEl.createEl("h3", { text: "Markdown \u5F80\u8FD4\u8F6C\u6362\u5B9E\u6D4B" });
    new import_obsidian5.Setting(containerEl).setName("\u6D4B\u8BD5\uFF1AMarkdown \u5F80\u8FD4\u8F6C\u6362").setDesc(
      `\u547D\u4EE4\u9762\u677F\u91CC\u7684\u53EA\u8BFB\u63A2\u6D4B\u3002\u53D6\u5F53\u524D\u6253\u5F00\u7684\u7B14\u8BB0\uFF08\u6CA1\u6709\u6253\u5F00\u7684\u7B14\u8BB0\u65F6\u5F39\u5217\u8868\u6311\u4E00\u7BC7\uFF0C\u53EA\u8BFB\u4E0D\u6539\uFF09\uFF0C\u5728\u540E\u9762\u8FFD\u52A0\u4E00\u6BB5\u56FA\u5B9A\u8BED\u6CD5\u6837\u672C\uFF0C\u7528 docs_ai \u63A5\u53E3\u5199\u6210\u98DE\u4E66\u65B0\u7248\u6587\u6863\uFF08docx\uFF09\u3001\u7ACB\u523B\u53D6\u56DE Markdown\uFF0C\u518D\u7528\u5B8C\u5168\u4E00\u6837\u7684\u5185\u5BB9\u8986\u76D6\u66F4\u65B0\u4E00\u6B21\u5E76\u7B2C\u4E8C\u6B21\u53D6\u56DE\uFF1B\u6700\u540E\u628A\u539F\u59CB\u5185\u5BB9 / \u5B9E\u9645\u53D1\u9001\u7684 content / \u4E24\u6B21\u53D6\u56DE\u3001\u9010\u884C\u5DEE\u5F02\u3001sha256 \u4E0E\u9010\u6761\u8BED\u6CD5\u6838\u5BF9\u7ED3\u679C\u5199\u6210 ${ROUNDTRIP_REPORT_PATH}\u3002\u6D4B\u8BD5\u9875\u4E0E\u6D4B\u8BD5\u6587\u6863\u4E0D\u4F1A\u81EA\u52A8\u6E05\u7406\uFF0C\u4F4D\u7F6E\u5199\u5728\u62A5\u544A\u91CC\u3002\u62A5\u544A\u662F\u666E\u901A\u7B14\u8BB0\uFF0C\u4F1A\u88AB\u4E0B\u4E00\u6B21\u540C\u6B65\u5F53\u4F5C\u65B0\u7B14\u8BB0\u4E0A\u4F20\u3002`
    );
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `\u5F53\u524D\u77E5\u8BC6\u7A7A\u95F4\uFF1A${settings.spaceId || "\uFF08\u672A\u914D\u7F6E\uFF0C\u547D\u4EE4\u4F1A\u76F4\u63A5\u63D0\u793A\u53BB\u8BBE\u7F6E\u91CC\u9009\uFF09"}`
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "\u9700\u8981\u52FE\u9009\u7684\u6743\u9650\uFF08\u4E0E\u5B98\u65B9 CLI \u540C\u4E00\u5957\u63A5\u53E3\u4E00\u81F4\uFF09\uFF1Adocx:document:create\uFF08\u521B\u5EFA\u6587\u6863\uFF09\u3001docx:document:readonly\uFF08\u53D6\u56DE Markdown\uFF09\u3001docx:document:write_only\uFF08\u8986\u76D6\u66F4\u65B0\uFF09\uFF1B\u5728\u77E5\u8BC6\u7A7A\u95F4\u91CC\u5EFA\u9875\u9762\u5E76\u79FB\u52A8\u6587\u6863\u8FD8\u9700\u8981 wiki:wiki\uFF08\u6216 wiki:node:move + wiki:node:read + wiki:space:read\uFF09\u3002\u6743\u9650\u6539\u52A8\u540E\u5FC5\u987B\u5728\u5F00\u653E\u5E73\u53F0\u91CD\u65B0\u53D1\u5E03\u7248\u672C\uFF0C\u5426\u5219\u65B0\u6743\u9650\u4E0D\u4F1A\u751F\u6548\u3002"
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "\u672C\u547D\u4EE4\u4E0D\u4E0A\u4F20\u672C\u5730\u56FE\u7247\uFF1A\u56FE\u7247\u5F15\u7528\u4F1A\u539F\u6837\u53D1\u7ED9\u670D\u52A1\u7AEF\uFF08\u5B98\u65B9 CLI \u4F1A\u5148\u628A\u672C\u5730\u56FE\u7247\u6362\u6210\u6807\u8BB0\u518D\u4E0A\u4F20\u7ED1\u5B9A\uFF0C\u90A3\u4E00\u6B65\u9700\u8981 docs:document.media:upload\uFF09\u3002"
    });
  }
  renderState(containerEl, settings) {
    containerEl.createEl("h3", { text: "\u72B6\u6001" });
    const records = Object.keys(settings.state.records).length;
    const folders = Object.keys(settings.state.folders).length;
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `\u4E0A\u6B21\u540C\u6B65\uFF1A${settings.state.lastSyncAt ? new Date(settings.state.lastSyncAt).toLocaleString() : "\u4ECE\u672A\u540C\u6B65"} \xB7 \u5DF2\u6620\u5C04\u7B14\u8BB0 ${records} \u7BC7 \xB7 \u5DF2\u5EFA\u76EE\u5F55\u8282\u70B9 ${folders} \u4E2A`
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `\u51B2\u7A81\u526F\u672C\u76EE\u5F55\uFF1A${CONFLICT_DIR}/\uFF08\u672C\u5730\u4E0E\u8FDC\u7AEF\u90FD\u4E0D\u6539\u52A8\uFF0C\u526F\u672C\u4EC5\u4F5C\u53C2\u8003\uFF09`
    });
    new import_obsidian5.Setting(containerEl).setName("\u6E05\u7A7A\u540C\u6B65\u72B6\u6001").setDesc("\u6E05\u6389\u6620\u5C04\u8868\u3002\u4E0B\u6B21\u540C\u6B65\u4F1A\u6309\u5185\u5BB9\u91CD\u65B0\u5224\u5B9A\uFF0C\u4E0D\u4F1A\u8986\u76D6\u5185\u5BB9\u4E00\u81F4\u7684\u6587\u4EF6\u3002").addButton(
      (button) => button.setWarning().setButtonText("\u6E05\u7A7A").onClick(async () => {
        if (this.host.engine.isSyncing()) {
          new import_obsidian5.Notice("\u540C\u6B65\u6B63\u5728\u8FDB\u884C\u4E2D\uFF0C\u8BF7\u7B49\u5B83\u7ED3\u675F\u540E\u518D\u6E05\u7A7A\u72B6\u6001");
          return;
        }
        settings.state.records = {};
        settings.state.folders = {};
        settings.state.conflicts = {};
        await this.host.saveSettings();
        new import_obsidian5.Notice("\u540C\u6B65\u72B6\u6001\u5DF2\u6E05\u7A7A");
        this.display();
      })
    );
    containerEl.createEl("h3", { text: "\u5DF2\u77E5\u8FB9\u754C" });
    const list = containerEl.createEl("ul", { cls: "setting-item-description" });
    list.createEl("li", { text: "\u98DE\u4E66\u4E0D\u63A5\u53D7 0 \u5B57\u8282 Markdown\uFF0C\u7A7A\u6587\u4EF6\u5728\u6587\u4EF6\u955C\u50CF\u6A21\u5F0F\u4E0B\u4F1A\u88AB\u8DF3\u8FC7\u5E76\u63D0\u793A\uFF1B\u6587\u6863\u6A21\u5F0F\u4E0B\u7A7A\u7B14\u8BB0\u4E5F\u4F1A\u540C\u6B65\uFF08\u6B63\u6587\u4E3A\u7A7A\uFF0C\u98DE\u4E66\u4FA7\u53EA\u6709\u6807\u9898\uFF09\u3002" });
    list.createEl("li", { text: "\u6587\u6863\u6A21\u5F0F\u4F1A\u4E0A\u4F20\u672C\u5730\u56FE\u7247\uFF08\u5199\u8FDB\u6587\u6863\u7684\u56FE\u7247\u5757\uFF09\u5E76\u4E0B\u8F7D\u98DE\u4E66\u91CC\u7684\u56FE\u7247\u5230\u9644\u4EF6\u76EE\u5F55\uFF1B\u89C4\u5219\u6587\u4EF6\u91CC image-upload / image-download \u53EF\u5173\u3002\u6587\u4EF6\u955C\u50CF\u6A21\u5F0F\u4E0D\u505A\u56FE\u7247\u5904\u7406\uFF0C\u56FE\u7247\u53EA\u662F\u7B14\u8BB0\u91CC\u7684\u6587\u672C\u3002" });
    list.createEl("li", { text: "\u5220\u9664\u9ED8\u8BA4\u4E0D\u4F1A\u4F20\u64AD\uFF0C\u53EA\u5728\u7ED3\u679C\u91CC\u63D0\u793A\uFF1B\u8981\u4F20\u64AD\u5C31\u5728\u4E0A\u9762\u6253\u5F00\u5BF9\u5E94\u7684\u5220\u9664\u5F00\u5173\uFF08\u8FDC\u7AEF\u5220\u9664\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\uFF0C\u672C\u5730\u5220\u9664\u8FDB .trash\uFF09\u3002" });
    list.createEl("li", { text: "\u4E24\u8FB9\u540C\u65F6\u4FEE\u6539\u540C\u4E00\u7BC7\u65F6\u6309\u51B2\u7A81\u5904\u7406\uFF1A\u8FDC\u7AEF\u7248\u672C\u53E6\u5B58\u4E3A\u526F\u672C\uFF0C\u672C\u5730\u4E0E\u8FDC\u7AEF\u90FD\u4E0D\u52A8\u3002" });
  }
};

// src/sync/engine.ts
var import_obsidian8 = require("obsidian");

// src/feishu/wiki.ts
var PAGE_SIZE = 50;
var MAX_DEPTH = 20;
async function listSpaces(client) {
  const spaces = [];
  let pageToken;
  do {
    const page = await client.json("GET", "/open-apis/wiki/v2/spaces", {
      query: { page_size: PAGE_SIZE, page_token: pageToken }
    });
    spaces.push(...page.items ?? []);
    pageToken = page.has_more ? page.page_token : void 0;
  } while (pageToken);
  return spaces;
}
async function listNodes(client, spaceId, parentNodeToken) {
  const nodes = [];
  let pageToken;
  do {
    const page = await client.json("GET", `/open-apis/wiki/v2/spaces/${pathSegment(spaceId)}/nodes`, {
      query: { page_size: PAGE_SIZE, parent_node_token: parentNodeToken, page_token: pageToken }
    });
    nodes.push(...page.items ?? []);
    pageToken = page.has_more ? page.page_token : void 0;
  } while (pageToken);
  return nodes;
}
async function getNodeByToken(client, token, objType) {
  const data = await client.json("GET", "/open-apis/wiki/v2/spaces/node_by_token", {
    query: { token, obj_type: objType }
  });
  return data?.node;
}
async function walkWikiTree(client, spaceId, rootNodeToken, options = {}) {
  const entries = [];
  const queue = [{ nodeToken: rootNodeToken, relDir: "", depth: 0 }];
  const visited = new Set(rootNodeToken ? [rootNodeToken] : []);
  const onProgress = options.onProgress;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth > MAX_DEPTH)
      continue;
    const nodes = await listNodes(client, spaceId, current.nodeToken);
    for (const node of nodes) {
      const title = (node.title ?? "").trim();
      if (node.node_type === "shortcut")
        continue;
      if (visited.has(node.node_token))
        continue;
      visited.add(node.node_token);
      if (node.obj_type === "file") {
        if (!/\.md$/i.test(title))
          continue;
        entries.push({
          nodeToken: node.node_token,
          objToken: node.obj_token,
          objType: node.obj_type,
          parentNodeToken: node.parent_node_token,
          title,
          relDir: current.relDir,
          depth: current.depth + 1
        });
        continue;
      }
      const childDir = node.node_token === options.rootContainerNode ? "" : current.relDir ? `${current.relDir}/${title}` : title;
      entries.push({
        nodeToken: node.node_token,
        objToken: node.obj_token,
        objType: node.obj_type,
        parentNodeToken: node.parent_node_token,
        title,
        relDir: current.relDir,
        depth: current.depth + 1
      });
      if (node.has_child === false)
        continue;
      queue.push({ nodeToken: node.node_token, relDir: childDir, depth: current.depth + 1 });
    }
    onProgress?.(entries.length, current.relDir);
  }
  return entries;
}
async function createContainerNode(client, spaceId, parentNodeToken, title) {
  const body = {
    obj_type: "docx",
    node_type: "origin",
    title
  };
  if (parentNodeToken)
    body.parent_node_token = parentNodeToken;
  const data = await client.json("POST", `/open-apis/wiki/v2/spaces/${pathSegment(spaceId)}/nodes`, { body });
  if (!data?.node?.node_token) {
    throw new Error(`\u521B\u5EFA\u77E5\u8BC6\u5E93\u8282\u70B9\u5931\u8D25\uFF1A${title}`);
  }
  return data.node;
}
async function moveDocToWiki(client, spaceId, parentNodeToken, objToken, objType) {
  const body = {
    obj_type: objType,
    obj_token: objToken,
    apply: true
  };
  if (parentNodeToken)
    body.parent_wiki_token = parentNodeToken;
  await client.json("POST", `/open-apis/wiki/v2/spaces/${pathSegment(spaceId)}/nodes/move_docs_to_wiki`, { body });
}

// src/feishu/files.ts
var META_CHUNK = 50;
function pickString(source, keys) {
  if (!source)
    return void 0;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value)
      return value;
    if (typeof value === "number")
      return String(value);
  }
  return void 0;
}
async function batchQueryMetas(client, tokens, docType = "file") {
  const result = /* @__PURE__ */ new Map();
  for (let index = 0; index < tokens.length; index += META_CHUNK) {
    const chunk = tokens.slice(index, index + META_CHUNK);
    const data = await client.json("POST", "/open-apis/drive/v1/metas/batch_query", {
      body: {
        request_docs: chunk.map((token) => ({ doc_token: token, doc_type: docType })),
        with_url: true
      }
    });
    for (const meta of data?.metas ?? []) {
      const token = pickString(meta, ["doc_token", "token"]);
      if (!token)
        continue;
      result.set(token, {
        token,
        title: pickString(meta, ["title", "name"]),
        url: pickString(meta, ["url"]),
        modifiedTime: pickString(meta, ["latest_modify_time", "modified_time", "latest_modify_time_ms"])
      });
    }
  }
  return result;
}
async function uploadMarkdown(client, options) {
  const fields = {
    file_name: options.fileName,
    parent_type: options.parentType,
    parent_node: options.parentNode,
    size: String(options.data.byteLength)
  };
  if (options.fileToken)
    fields.file_token = options.fileToken;
  const data = await client.json("POST", "/open-apis/drive/v1/files/upload_all", {
    multipart: { fields, file: { name: options.fileName, data: options.data } }
  });
  const fileToken = pickString(data, ["file_token"]) ?? options.fileToken;
  if (!fileToken)
    throw new Error(`\u4E0A\u4F20 ${options.fileName} \u540E\u672A\u8FD4\u56DE file_token`);
  return { fileToken, version: pickString(data, ["version"]) };
}
async function downloadFile(client, fileToken, version) {
  const bytes = await client.binary(`/open-apis/drive/v1/medias/${pathSegment(fileToken)}/preview_download`, version ? { version } : void 0);
  if (bytes.byteLength === 0) {
    throw new Error(`\u8FDC\u7AEF ${fileToken} \u8FD4\u56DE\u4E86\u7A7A\u5185\u5BB9\uFF0C\u5DF2\u653E\u5F03\u672C\u6B21\u8986\u76D6`);
  }
  return bytes;
}
async function deleteDriveFile(client, token, type) {
  await client.json("DELETE", `/open-apis/drive/v1/files/${pathSegment(token)}`, { query: { type } });
}
async function uploadMarkdownToWiki(client, options, onFallback) {
  const driveThenMove = async () => {
    const uploaded = await uploadMarkdown(client, {
      fileName: options.fileName,
      data: options.data,
      parentType: "explorer",
      parentNode: ""
    });
    await moveDocToWiki(client, options.spaceId, options.parentNode, uploaded.fileToken, "file");
    return uploaded;
  };
  if (!options.fileToken && !options.parentNode) {
    return driveThenMove();
  }
  try {
    return await uploadMarkdown(client, {
      fileName: options.fileName,
      data: options.data,
      parentType: "wiki",
      parentNode: options.parentNode ?? "",
      fileToken: options.fileToken
    });
  } catch (error) {
    if (error instanceof FeishuError && error.authRelated)
      throw error;
    if (options.fileToken)
      throw error;
    onFallback?.(error instanceof Error ? error.message : String(error));
    return driveThenMove();
  }
}

// src/sync/executor.ts
var import_obsidian7 = require("obsidian");

// src/sync/scanner.ts
var import_obsidian6 = require("obsidian");
var ALWAYS_EXCLUDED = [".obsidian/**", ".trash/**", `${CONFLICT_DIR}/**`, "**/.DS_Store"];
function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += ".";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}
var PathFilter = class {
  constructor(userPatterns) {
    const raw = userPatterns.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => line.endsWith("/") ? `${line}**` : line).map((line) => line.replace(/^\.\//, "").replace(/^\//, ""));
    this.patterns = [...ALWAYS_EXCLUDED, ...raw].map(globToRegExp);
  }
  isExcluded(relPath) {
    return this.patterns.some((pattern) => pattern.test(relPath));
  }
};
function scanLocalNotes(app, filter) {
  const notes = /* @__PURE__ */ new Map();
  for (const file of app.vault.getMarkdownFiles()) {
    if (filter.isExcluded(file.path))
      continue;
    const stat = file.stat;
    notes.set(file.path, { relPath: file.path, size: stat?.size ?? 0, mtime: stat?.mtime ?? 0 });
  }
  return notes;
}
async function readLocalBytes(app, relPath) {
  const file = app.vault.getAbstractFileByPath(relPath);
  if (!(file instanceof import_obsidian6.TFile)) {
    throw new Error(`\u627E\u4E0D\u5230\u672C\u5730\u6587\u4EF6\uFF1A${relPath}`);
  }
  return app.vault.readBinary(file);
}
function localStat(app, relPath) {
  const file = app.vault.getAbstractFileByPath(relPath);
  if (!(file instanceof import_obsidian6.TFile))
    return { size: 0, mtime: 0 };
  return { size: file.stat?.size ?? 0, mtime: file.stat?.mtime ?? 0 };
}
async function writeLocalBytes(app, relPath, data) {
  const existing = app.vault.getAbstractFileByPath(relPath);
  if (existing instanceof import_obsidian6.TFile) {
    await app.vault.modifyBinary(existing, data);
    return;
  }
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  if (dir && !app.vault.getAbstractFileByPath(dir)) {
    await app.vault.createFolder(dir).catch(() => void 0);
  }
  await app.vault.createBinary(relPath, data);
}

// src/sync/executor.ts
function describeError2(error) {
  if (error instanceof Error) {
    const withDescribe = error;
    return typeof withDescribe.describe === "function" ? withDescribe.describe() : error.message;
  }
  return String(error);
}
function two(value) {
  return String(value).padStart(2, "0");
}
function conflictCopyRelPath(relPath) {
  const now = /* @__PURE__ */ new Date();
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, "0")}`;
  const base = relPath.replace(/\.md$/i, "");
  return `${CONFLICT_DIR}/${base}.${stamp}.md`;
}
function existsLocally(app, relPath) {
  return app.vault.getAbstractFileByPath(relPath) instanceof import_obsidian7.TFile;
}
async function hashLocalFile(app, relPath) {
  return sha256Hex(await readLocalBytes(app, relPath));
}
async function executePlan(plan, ctx, options) {
  const reports = [];
  const { state, settings } = ctx;
  const folderNodes = /* @__PURE__ */ new Map();
  let rootContainerToken;
  const ensureRootContainer = async () => {
    if (ctx.rootNodeToken)
      return ctx.rootNodeToken;
    if (rootContainerToken)
      return rootContainerToken;
    const cached = state.folders[""];
    if (cached?.nodeToken) {
      rootContainerToken = cached.nodeToken;
      return rootContainerToken;
    }
    const title = settings.rootPageTitle.trim() || ctx.app.vault.getName();
    const topLevel = await listNodes(ctx.client, ctx.spaceId).catch(() => []);
    const found = topLevel.find((node2) => node2.title === title && node2.obj_type !== "file");
    if (found?.node_token) {
      state.folders[""] = { nodeToken: found.node_token };
      rootContainerToken = found.node_token;
      ctx.logger.info(`\u590D\u7528\u77E5\u8BC6\u5E93\u9876\u5C42\u9875\u9762\u300C${title}\u300D\u5B58\u653E vault \u6839\u76EE\u5F55\u4E0B\u7684\u7B14\u8BB0`);
      return rootContainerToken;
    }
    const node = await createContainerNode(ctx.client, ctx.spaceId, void 0, title);
    state.folders[""] = { nodeToken: node.node_token };
    rootContainerToken = node.node_token;
    ctx.logger.info(`\u5728\u77E5\u8BC6\u5E93\u9876\u5C42\u521B\u5EFA\u9875\u9762\u300C${title}\u300D\u5B58\u653E vault \u6839\u76EE\u5F55\u4E0B\u7684\u7B14\u8BB0`);
    return rootContainerToken;
  };
  const resolveFolderNode = async (relDir, needFileParent) => {
    if (settings.folderMode === "flat" || relDir === "") {
      return needFileParent ? ensureRootContainer() : ctx.rootNodeToken;
    }
    const cached = folderNodes.get(relDir);
    if (cached)
      return cached;
    const existing = state.folders[relDir];
    if (existing?.nodeToken) {
      folderNodes.set(relDir, existing.nodeToken);
      return existing.nodeToken;
    }
    const parentDir = dirnameOf(relDir);
    const parentNode = await resolveFolderNode(parentDir, false);
    const node = await createContainerNode(ctx.client, ctx.spaceId, parentNode, basenameOf(relDir));
    state.folders[relDir] = { nodeToken: node.node_token, parentNodeToken: parentNode };
    folderNodes.set(relDir, node.node_token);
    ctx.logger.info(`\u521B\u5EFA\u77E5\u8BC6\u5E93\u76EE\u5F55\u8282\u70B9 ${relDir} -> ${node.node_token}`);
    return node.node_token;
  };
  const remoteFileName = (relPath) => settings.folderMode === "flat" ? relPath.split("/").join(settings.flatSeparator) : basenameOf(relPath);
  const writeConflictCopy = async (relPath, bytes, localHash, remoteHash) => {
    const copyPath = conflictCopyRelPath(relPath);
    const adapter = ctx.app.vault.adapter;
    await ensureFolder(adapter, dirnameOf(copyPath));
    await adapter.writeBinary(copyPath, bytes);
    state.conflicts[relPath] = { remoteHash, localHash, copyPath, at: Date.now() };
    return copyPath;
  };
  const pushes = plan.items.filter((entry) => entry.action === "push" || entry.action === "create-remote");
  const pulls = plan.items.filter((entry) => entry.action === "pull" || entry.action === "create-local");
  const links = plan.items.filter((entry) => entry.action === "link");
  const conflicts = plan.items.filter((entry) => entry.action === "conflict");
  const remoteDeletes = plan.items.filter((entry) => entry.action === "delete-remote");
  const localDeletes = plan.items.filter((entry) => entry.action === "delete-local");
  const observed = plan.items.filter(
    (entry) => ["local-deleted", "remote-deleted", "empty-local", "dirty-editor", "forget"].includes(entry.action)
  );
  const steps = [];
  let stepIndex = 0;
  const totalSteps = (options.allowPush ? pushes.length + remoteDeletes.length : 0) + (options.allowPull ? pulls.length + localDeletes.length : 0) + links.length + conflicts.length;
  const tick = (message) => {
    stepIndex += 1;
    options.onProgress?.(message, stepIndex, totalSteps);
  };
  if (options.allowPush) {
    for (const entry of pushes) {
      steps.push(async () => {
        try {
          const statBefore = localStat(ctx.app, entry.relPath);
          const bytes = await readLocalBytes(ctx.app, entry.relPath);
          const parentNode = await resolveFolderNode(entry.parentDir, true);
          const record = state.records[entry.relPath];
          const previousToken = entry.action === "push" ? record?.fileToken : void 0;
          const result = await uploadMarkdownToWiki(
            ctx.client,
            {
              spaceId: ctx.spaceId,
              parentNode,
              fileName: remoteFileName(entry.relPath),
              data: bytes,
              fileToken: previousToken
            },
            (reason) => ctx.logger.warn(`\u76F4\u63A5\u4E0A\u4F20\u5230\u77E5\u8BC6\u5E93\u8282\u70B9\u5931\u8D25\uFF0C\u6539\u7528\u4E91\u7A7A\u95F4\u4E2D\u8F6C\uFF1A${reason}`)
          );
          const hash = await sha256Hex(bytes);
          const statAfter = localStat(ctx.app, entry.relPath);
          const stable = statAfter.size === statBefore.size && statAfter.mtime === statBefore.mtime;
          let nodeToken = record?.nodeToken;
          if (result.fileToken !== record?.fileToken) {
            const node = await getNodeByToken(ctx.client, result.fileToken, "file").catch(() => void 0);
            nodeToken = node?.node_token;
          }
          state.records[entry.relPath] = {
            fileToken: result.fileToken,
            nodeToken,
            parentNodeToken: parentNode,
            baseHash: hash,
            localSize: stable ? statAfter.size : -1,
            localMtime: stable ? statAfter.mtime : -1,
            remoteModifiedTime: void 0,
            remoteVersion: result.version,
            lastSyncedAt: Date.now()
          };
          delete state.conflicts[entry.relPath];
          reports.push({ relPath: entry.relPath, action: entry.action, ok: true });
          tick(`\u4E0A\u4F20 ${entry.relPath}`);
        } catch (error) {
          ctx.logger.error(`\u4E0A\u4F20 ${entry.relPath} \u5931\u8D25\uFF1A${describeError2(error)}`);
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError2(error) });
          tick(`\u4E0A\u4F20\u5931\u8D25 ${entry.relPath}`);
        }
      });
    }
  }
  if (options.allowPull) {
    for (const entry of pulls) {
      steps.push(async () => {
        const record = state.records[entry.relPath];
        const fileToken = entry.fileToken ?? record?.fileToken;
        if (!fileToken) {
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: "\u7F3A\u5C11\u8FDC\u7AEF file_token" });
          tick(`\u8DF3\u8FC7 ${entry.relPath}`);
          return;
        }
        try {
          const present = existsLocally(ctx.app, entry.relPath);
          if (entry.action === "pull" && !present) {
            reports.push({
              relPath: entry.relPath,
              action: entry.action,
              ok: true,
              message: "\u751F\u6210\u8BA1\u5212\u540E\u672C\u5730\u6587\u4EF6\u5DF2\u88AB\u5220\u9664\uFF0C\u672A\u91CD\u65B0\u521B\u5EFA\uFF08\u5982\u9700\u6062\u590D\u8BF7\u518D\u8DD1\u4E00\u6B21\u540C\u6B65\uFF09"
            });
            tick(`\u8DF3\u8FC7 ${entry.relPath}`);
            return;
          }
          if (present && (entry.localSize !== void 0 || entry.localMtime !== void 0)) {
            const before = localStat(ctx.app, entry.relPath);
            const movedSincePlan = before.size !== entry.localSize || before.mtime !== entry.localMtime;
            if (movedSincePlan) {
              const remoteBytes = await downloadFile(ctx.client, fileToken);
              const remoteHash = await sha256Hex(remoteBytes);
              const currentLocalHash = await hashLocalFile(ctx.app, entry.relPath);
              if (currentLocalHash !== remoteHash) {
                const copyPath = await writeConflictCopy(entry.relPath, remoteBytes, currentLocalHash, remoteHash);
                reports.push({
                  relPath: entry.relPath,
                  action: "conflict",
                  ok: true,
                  message: "\u8BA1\u5212\u751F\u6210\u540E\u672C\u5730\u53C8\u6709\u65B0\u6539\u52A8\uFF0C\u5DF2\u6539\u4E3A\u4FDD\u7559\u53CC\u65B9\uFF0C\u672C\u5730\u4E0E\u8FDC\u7AEF\u90FD\u672A\u6539\u52A8",
                  copyPath
                });
                ctx.logger.warn(`\u62C9\u53D6\u524D\u53D1\u73B0\u672C\u5730\u5DF2\u6539\u52A8\uFF0C\u8F6C\u4E3A\u51B2\u7A81\uFF1A${entry.relPath}`);
                tick(`\u51B2\u7A81 ${entry.relPath}`);
                return;
              }
              state.records[entry.relPath] = {
                fileToken,
                nodeToken: entry.nodeToken ?? record?.nodeToken,
                parentNodeToken: record?.parentNodeToken,
                baseHash: currentLocalHash,
                localSize: before.size,
                localMtime: before.mtime,
                remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
                remoteVersion: record?.remoteVersion,
                lastSyncedAt: Date.now()
              };
              delete state.conflicts[entry.relPath];
              reports.push({ relPath: entry.relPath, action: "link", ok: true, message: "\u4E24\u8FB9\u5185\u5BB9\u4E00\u81F4\uFF0C\u53EA\u66F4\u65B0\u4E86\u57FA\u7EBF" });
              tick(`\u5EFA\u7ACB\u6620\u5C04 ${entry.relPath}`);
              return;
            }
          }
          if (present && await options.isEditorDirty(entry.relPath)) {
            reports.push({ relPath: entry.relPath, action: "dirty-editor", ok: true, message: "\u6587\u4EF6\u6B63\u5728\u7F16\u8F91\u4E14\u672A\u4FDD\u5B58\uFF0C\u672A\u8986\u76D6" });
            tick(`\u8DF3\u8FC7\u7F16\u8F91\u4E2D\u7684 ${entry.relPath}`);
            return;
          }
          const bytes = await downloadFile(ctx.client, fileToken);
          if (entry.action === "create-local" && present) {
            const currentLocalHash = await hashLocalFile(ctx.app, entry.relPath);
            const remoteHash = await sha256Hex(bytes);
            if (currentLocalHash !== remoteHash) {
              const copyPath = await writeConflictCopy(entry.relPath, bytes, currentLocalHash, remoteHash);
              reports.push({
                relPath: entry.relPath,
                action: "conflict",
                ok: true,
                message: "\u672C\u5730\u5728\u8BA1\u5212\u751F\u6210\u540E\u51FA\u73B0\u4E86\u540C\u540D\u6587\u4EF6\u4E14\u5185\u5BB9\u4E0D\u540C\uFF0C\u5DF2\u4FDD\u7559\u53CC\u65B9",
                copyPath
              });
              tick(`\u51B2\u7A81 ${entry.relPath}`);
              return;
            }
          }
          await writeLocalBytes(ctx.app, entry.relPath, bytes);
          const hash = await sha256Hex(bytes);
          const stat = localStat(ctx.app, entry.relPath);
          state.records[entry.relPath] = {
            fileToken,
            nodeToken: entry.nodeToken ?? record?.nodeToken,
            parentNodeToken: record?.parentNodeToken,
            baseHash: hash,
            localSize: stat.size,
            localMtime: stat.mtime,
            remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
            remoteVersion: record?.remoteVersion,
            lastSyncedAt: Date.now()
          };
          delete state.conflicts[entry.relPath];
          reports.push({ relPath: entry.relPath, action: entry.action, ok: true });
          tick(`\u4E0B\u8F7D ${entry.relPath}`);
        } catch (error) {
          ctx.logger.error(`\u4E0B\u8F7D ${entry.relPath} \u5931\u8D25\uFF1A${describeError2(error)}`);
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError2(error) });
          tick(`\u4E0B\u8F7D\u5931\u8D25 ${entry.relPath}`);
        }
      });
    }
  }
  for (const entry of links) {
    steps.push(async () => {
      try {
        const statBefore = localStat(ctx.app, entry.relPath);
        const bytes = await readLocalBytes(ctx.app, entry.relPath);
        const hash = await sha256Hex(bytes);
        const statAfter = localStat(ctx.app, entry.relPath);
        const stable = statAfter.size === statBefore.size && statAfter.mtime === statBefore.mtime;
        const existing = state.records[entry.relPath];
        state.records[entry.relPath] = {
          fileToken: entry.fileToken ?? existing?.fileToken ?? "",
          nodeToken: entry.nodeToken ?? existing?.nodeToken,
          parentNodeToken: existing?.parentNodeToken,
          baseHash: hash,
          localSize: stable ? statAfter.size : -1,
          localMtime: stable ? statAfter.mtime : -1,
          remoteModifiedTime: entry.remoteModifiedTime,
          remoteVersion: entry.remoteVersion ?? existing?.remoteVersion,
          lastSyncedAt: Date.now()
        };
        delete state.conflicts[entry.relPath];
        reports.push({ relPath: entry.relPath, action: entry.action, ok: true, message: entry.reason });
        tick(`\u5EFA\u7ACB\u6620\u5C04 ${entry.relPath}`);
      } catch (error) {
        reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError2(error) });
        tick(`\u5EFA\u7ACB\u6620\u5C04\u5931\u8D25 ${entry.relPath}`);
      }
    });
  }
  for (const entry of conflicts) {
    steps.push(async () => {
      const record = state.records[entry.relPath];
      const fileToken = entry.fileToken ?? record?.fileToken;
      const previous = state.conflicts[entry.relPath];
      if (entry.duplicateConflict && previous) {
        reports.push({
          relPath: entry.relPath,
          action: "conflict",
          ok: true,
          message: "\u4ECD\u662F\u4E0A\u6B21\u672A\u5904\u7406\u7684\u51B2\u7A81\uFF0C\u672A\u91CD\u590D\u751F\u6210\u526F\u672C",
          copyPath: previous.copyPath
        });
        tick(`\u51B2\u7A81 ${entry.relPath}`);
        return;
      }
      if (!fileToken) {
        reports.push({ relPath: entry.relPath, action: "conflict", ok: false, message: "\u7F3A\u5C11\u8FDC\u7AEF file_token\uFF0C\u65E0\u6CD5\u53D6\u51FA\u51B2\u7A81\u7248\u672C" });
        tick(`\u51B2\u7A81 ${entry.relPath}`);
        return;
      }
      try {
        const bytes = await downloadFile(ctx.client, fileToken);
        const remoteHash = await sha256Hex(bytes);
        const present = existsLocally(ctx.app, entry.relPath);
        const localHash = present ? await hashLocalFile(ctx.app, entry.relPath) : "";
        if (previous && previous.remoteHash === remoteHash && previous.localHash === localHash) {
          reports.push({
            relPath: entry.relPath,
            action: "conflict",
            ok: true,
            message: "\u4ECD\u662F\u4E0A\u6B21\u672A\u5904\u7406\u7684\u51B2\u7A81\uFF0C\u672A\u91CD\u590D\u751F\u6210\u526F\u672C",
            copyPath: previous.copyPath
          });
          tick(`\u51B2\u7A81 ${entry.relPath}`);
          return;
        }
        const copyPath = await writeConflictCopy(entry.relPath, bytes, localHash, remoteHash);
        reports.push({
          relPath: entry.relPath,
          action: "conflict",
          ok: true,
          message: "\u8FDC\u7AEF\u7248\u672C\u5DF2\u53E6\u5B58\u4E3A\u526F\u672C\uFF0C\u672C\u5730\u4E0E\u8FDC\u7AEF\u90FD\u672A\u6539\u52A8",
          copyPath
        });
        ctx.logger.warn(`\u51B2\u7A81\uFF1A${entry.relPath} -> ${copyPath}`);
        tick(`\u51B2\u7A81 ${entry.relPath}`);
      } catch (error) {
        reports.push({ relPath: entry.relPath, action: "conflict", ok: false, message: describeError2(error) });
        tick(`\u51B2\u7A81\u5904\u7406\u5931\u8D25 ${entry.relPath}`);
      }
    });
  }
  for (const step of steps) {
    await step();
  }
  if (options.allowPush) {
    for (const entry of remoteDeletes) {
      const record = state.records[entry.relPath];
      const fileToken = entry.fileToken ?? record?.fileToken;
      const title = entry.remoteTitle ?? entry.relPath;
      if (!fileToken) {
        reports.push({ relPath: entry.relPath, action: "delete-remote", ok: false, message: "\u7F3A\u5C11\u8FDC\u7AEF file_token\uFF0C\u672A\u5220\u9664" });
        tick(`\u8DF3\u8FC7\u5220\u9664 ${entry.relPath}`);
        continue;
      }
      try {
        await deleteDriveFile(ctx.client, fileToken, "file");
        delete state.records[entry.relPath];
        delete state.conflicts[entry.relPath];
        ctx.logger.info(`\u5DF2\u5220\u9664\u8FDC\u7AEF\u6587\u4EF6 ${title}\uFF08${fileToken}\uFF09\uFF0C\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\u53EF\u6062\u590D`);
        reports.push({
          relPath: entry.relPath,
          action: "delete-remote",
          ok: true,
          message: `\u5DF2\u5220\u9664\u8FDC\u7AEF\u300C${title}\u300D\uFF08\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\uFF0C\u53EF\u6062\u590D\uFF09`
        });
        tick(`\u5220\u9664\u8FDC\u7AEF ${entry.relPath}`);
      } catch (error) {
        ctx.logger.error(`\u5220\u9664\u8FDC\u7AEF ${entry.relPath} \u5931\u8D25\uFF1A${describeError2(error)}`);
        reports.push({ relPath: entry.relPath, action: "delete-remote", ok: false, message: describeError2(error) });
        tick(`\u5220\u9664\u8FDC\u7AEF\u5931\u8D25 ${entry.relPath}`);
      }
    }
  }
  if (options.allowPull) {
    for (const entry of localDeletes) {
      try {
        const file = existsLocally(ctx.app, entry.relPath) ? ctx.app.vault.getAbstractFileByPath(entry.relPath) : null;
        if (file) {
          await ctx.app.vault.trash(file, false);
        }
        delete state.records[entry.relPath];
        delete state.conflicts[entry.relPath];
        reports.push({
          relPath: entry.relPath,
          action: "delete-local",
          ok: true,
          message: file ? "\u8FDC\u7AEF\u5DF2\u5220\u9664\uFF0C\u672C\u5730\u7B14\u8BB0\u5DF2\u79FB\u5165 .trash" : "\u8FDC\u7AEF\u5DF2\u5220\u9664\uFF0C\u672C\u5730\u6587\u4EF6\u5DF2\u4E0D\u5B58\u5728\uFF0C\u53EA\u6E05\u7406\u4E86\u6620\u5C04"
        });
        tick(`\u5220\u9664\u672C\u5730 ${entry.relPath}`);
      } catch (error) {
        ctx.logger.error(`\u5220\u9664\u672C\u5730 ${entry.relPath} \u5931\u8D25\uFF1A${describeError2(error)}`);
        reports.push({ relPath: entry.relPath, action: "delete-local", ok: false, message: describeError2(error) });
        tick(`\u5220\u9664\u672C\u5730\u5931\u8D25 ${entry.relPath}`);
      }
    }
  }
  if (options.allowPush && pushes.length > 0) {
    await refreshRemoteModifiedTime(ctx, pushes);
  }
  for (const entry of observed) {
    if (entry.action === "forget") {
      delete state.records[entry.relPath];
      delete state.conflicts[entry.relPath];
    }
    reports.push({ relPath: entry.relPath, action: entry.action, ok: true, message: entry.reason });
  }
  state.lastSyncAt = Date.now();
  return reports;
}
async function refreshRemoteModifiedTime(ctx, entries) {
  const tokens = [];
  for (const entry of entries) {
    const record = ctx.state.records[entry.relPath];
    if (record?.fileToken)
      tokens.push(record.fileToken);
  }
  if (tokens.length === 0)
    return;
  try {
    const metas = await batchQueryMetas(ctx.client, tokens);
    for (const entry of entries) {
      const record = ctx.state.records[entry.relPath];
      if (!record)
        continue;
      const meta = metas.get(record.fileToken);
      if (meta?.modifiedTime)
        record.remoteModifiedTime = meta.modifiedTime;
    }
  } catch (error) {
    ctx.logger.warn(`\u5237\u65B0\u8FDC\u7AEF\u5143\u6570\u636E\u5931\u8D25\uFF08\u4E0B\u6B21\u540C\u6B65\u4F1A\u91CD\u65B0\u6821\u9A8C\u5185\u5BB9\uFF09\uFF1A${describeError2(error)}`);
  }
}

// src/sync/planner.ts
function item(relPath, action, reason, extra = {}) {
  return { relPath, action, reason, parentDir: dirnameOf(relPath), ...extra };
}
function remoteFields(remote) {
  return {
    remoteTitle: remote.entry.title,
    fileToken: remote.entry.objToken,
    nodeToken: remote.entry.nodeToken,
    remoteModifiedTime: remote.modifiedTime
  };
}
function conflictItem(relPath, state, reason, extra, localHash, remoteHash) {
  const previous = state.conflicts[relPath];
  const duplicate = !!previous && previous.remoteHash === remoteHash && previous.localHash === localHash;
  return item(relPath, "conflict", duplicate ? "\u4E0E\u4E0A\u6B21\u76F8\u540C\u7684\u51B2\u7A81\uFF0C\u672A\u91CD\u590D\u751F\u6210\u526F\u672C" : reason, {
    ...extra,
    localHash,
    remoteHash,
    duplicateConflict: duplicate
  });
}
async function buildPlan(input) {
  const { state, local, remote } = input;
  const items = [];
  const relPaths = /* @__PURE__ */ new Set([...local.keys(), ...remote.keys(), ...Object.keys(state.records)]);
  for (const relPath of Array.from(relPaths).sort()) {
    if (input.isExcluded(relPath))
      continue;
    const localNote = local.get(relPath);
    const remoteNote = remote.get(relPath);
    const record = state.records[relPath];
    if (!record) {
      if (localNote && remoteNote) {
        if (localNote.size === 0) {
          items.push(item(relPath, "empty-local", "\u7A7A\u6587\u4EF6\u4E0D\u4F1A\u88AB\u4E0A\u4F20\uFF08\u98DE\u4E66\u4E0D\u63A5\u53D7 0 \u5B57\u8282 Markdown\uFF09", remoteFields(remoteNote)));
          continue;
        }
        const [localHash2, remoteHash2] = await Promise.all([
          input.hashLocal(relPath),
          input.hashRemote(remoteNote.entry.objToken)
        ]);
        if (localHash2 === remoteHash2) {
          items.push(item(relPath, "link", "\u4E24\u8FB9\u5185\u5BB9\u4E00\u81F4\uFF0C\u53EA\u5EFA\u7ACB\u6620\u5C04", { ...remoteFields(remoteNote), localHash: localHash2, remoteHash: remoteHash2 }));
        } else {
          items.push(
            conflictItem(relPath, state, "\u9996\u6B21\u5BF9\u63A5\uFF1A\u540C\u540D\u6587\u4EF6\u4E24\u8FB9\u5185\u5BB9\u4E0D\u540C\uFF0C\u5DF2\u4FDD\u7559\u53CC\u65B9", remoteFields(remoteNote), localHash2, remoteHash2)
          );
        }
        continue;
      }
      if (localNote) {
        if (localNote.size === 0) {
          items.push(item(relPath, "empty-local", "\u7A7A\u6587\u4EF6\u4E0D\u4F1A\u88AB\u4E0A\u4F20\uFF08\u98DE\u4E66\u4E0D\u63A5\u53D7 0 \u5B57\u8282 Markdown\uFF09"));
        } else {
          items.push(item(relPath, "create-remote"));
        }
        continue;
      }
      if (remoteNote) {
        items.push(item(relPath, "create-local", void 0, remoteFields(remoteNote)));
      }
      continue;
    }
    if (!localNote && !remoteNote) {
      items.push(item(relPath, "forget", "\u4E24\u8FB9\u90FD\u5DF2\u4E0D\u5B58\u5728\uFF0C\u6E05\u7406\u6620\u5C04"));
      continue;
    }
    if (!localNote) {
      if (!remoteNote) {
        items.push(item(relPath, "forget", "\u4E24\u8FB9\u90FD\u5DF2\u4E0D\u5B58\u5728\uFF0C\u6E05\u7406\u6620\u5C04"));
        continue;
      }
      const remoteState2 = await checkRemoteChanged(input, record, remoteNote);
      if (remoteState2.changed) {
        items.push(
          conflictItem(
            relPath,
            state,
            "\u672C\u5730\u5DF2\u5220\u9664\u3001\u8FDC\u7AEF\u88AB\u4FEE\u6539\uFF1A\u4E3A\u907F\u514D\u4E22\u5185\u5BB9\uFF0C\u672A\u81EA\u52A8\u5904\u7406",
            { ...remoteFields(remoteNote), fileToken: record.fileToken },
            "",
            remoteState2.hash ?? ""
          )
        );
      } else if (input.propagateLocalDelete) {
        items.push(
          item(relPath, "delete-remote", "\u672C\u5730\u5DF2\u5220\u9664\uFF0C\u6309\u8BBE\u7F6E\u5220\u9664\u8FDC\u7AEF\uFF08\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\uFF0C\u53EF\u6062\u590D\uFF09", {
            ...remoteFields(remoteNote),
            fileToken: record.fileToken
          })
        );
      } else {
        items.push(item(relPath, "local-deleted", "\u672C\u5730\u5DF2\u5220\u9664\u3001\u8FDC\u7AEF\u672A\u53D8\uFF08\u672A\u81EA\u52A8\u5220\u9664\u8FDC\u7AEF\uFF09", remoteFields(remoteNote)));
      }
      continue;
    }
    if (!remoteNote) {
      const localChanged2 = await isLocalChanged(input, record, localNote);
      if (!localChanged2) {
        if (input.propagateRemoteDelete) {
          items.push(item(relPath, "delete-local", "\u8FDC\u7AEF\u5DF2\u5220\u9664\u4E14\u672C\u5730\u672A\u53D8\uFF0C\u6309\u8BBE\u7F6E\u628A\u672C\u5730\u7B14\u8BB0\u79FB\u8FDB .trash", {
            fileToken: record.fileToken,
            localSize: localNote.size,
            localMtime: localNote.mtime
          }));
        } else {
          items.push(item(relPath, "remote-deleted", "\u8FDC\u7AEF\u5DF2\u5220\u9664\u3001\u672C\u5730\u672A\u53D8\uFF08\u672A\u81EA\u52A8\u5220\u9664\u672C\u5730\uFF09"));
        }
      } else if (input.recreateRemoteIfDeleted) {
        items.push(item(relPath, "create-remote", "\u8FDC\u7AEF\u5DF2\u5220\u9664\u4F46\u672C\u5730\u6709\u4FEE\u6539\uFF0C\u6309\u8BBE\u7F6E\u91CD\u65B0\u4E0A\u4F20"));
      } else {
        items.push(item(relPath, "remote-deleted", "\u8FDC\u7AEF\u5DF2\u5220\u9664\u3001\u672C\u5730\u6709\u4FEE\u6539\uFF1A\u4E3A\u907F\u514D\u8BEF\u6062\u590D\uFF0C\u672A\u81EA\u52A8\u91CD\u5EFA"));
      }
      continue;
    }
    if (localNote.size === 0) {
      items.push(item(relPath, "empty-local", "\u7A7A\u6587\u4EF6\u4E0D\u53C2\u4E0E\u540C\u6B65", remoteFields(remoteNote)));
      continue;
    }
    const localChanged = await isLocalChanged(input, record, localNote);
    const remoteState = await checkRemoteChanged(input, record, remoteNote);
    const remoteChanged = remoteState.changed;
    if (!localChanged && !remoteChanged) {
      items.push(item(relPath, "skip"));
      continue;
    }
    if (localChanged && !remoteChanged) {
      items.push(item(relPath, "push", void 0, remoteFields(remoteNote)));
      continue;
    }
    if (!localChanged && remoteChanged) {
      items.push(item(relPath, "pull", void 0, { ...remoteFields(remoteNote), localSize: localNote.size, localMtime: localNote.mtime }));
      continue;
    }
    const [localHash, remoteHash] = await Promise.all([input.hashLocal(relPath), input.hashRemote(remoteNote.entry.objToken)]);
    if (localHash === remoteHash) {
      items.push(item(relPath, "link", "\u4E24\u8FB9\u5185\u5BB9\u4E00\u81F4\uFF0C\u53EA\u66F4\u65B0\u57FA\u7EBF", { ...remoteFields(remoteNote), localHash, remoteHash }));
      continue;
    }
    if (localHash === record.baseHash) {
      items.push(
        item(relPath, "pull", "\u672C\u5730\u5185\u5BB9\u672A\u53D8\uFF0C\u8FDC\u7AEF\u624D\u662F\u65B0\u7248\u672C", {
          ...remoteFields(remoteNote),
          localHash,
          remoteHash,
          localSize: localNote.size,
          localMtime: localNote.mtime
        })
      );
      continue;
    }
    if (remoteHash === record.baseHash) {
      items.push(item(relPath, "push", "\u8FDC\u7AEF\u5185\u5BB9\u672A\u53D8\uFF0C\u672C\u5730\u624D\u662F\u65B0\u7248\u672C", { ...remoteFields(remoteNote), localHash, remoteHash }));
      continue;
    }
    items.push(
      conflictItem(relPath, state, "\u4E24\u8FB9\u90FD\u6539\u8FC7\u4E14\u5185\u5BB9\u4E0D\u540C\uFF0C\u5DF2\u4FDD\u7559\u53CC\u65B9", remoteFields(remoteNote), localHash, remoteHash)
    );
  }
  return {
    items,
    counts: summarize(items),
    localNoteCount: local.size,
    remoteNoteCount: remote.size
  };
}
async function isLocalChanged(input, record, localNote) {
  if (record.localSize === localNote.size && record.localMtime === localNote.mtime && record.baseHash) {
    return false;
  }
  const hash = await input.hashLocal(localNote.relPath);
  return hash !== record.baseHash;
}
async function checkRemoteChanged(input, record, remoteNote) {
  if (record.remoteModifiedTime && remoteNote.modifiedTime && record.remoteModifiedTime === remoteNote.modifiedTime) {
    return { changed: false };
  }
  const hash = await input.hashRemote(remoteNote.entry.objToken);
  return { changed: hash !== record.baseHash, hash };
}

// src/sync/engine.ts
function parseTokenFromInput(input) {
  const value = input.trim();
  if (!value)
    return "";
  if (!/^https?:\/\//i.test(value))
    return value;
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : value;
  } catch {
    return value;
  }
}
var SyncEngine = class {
  constructor(deps) {
    this.deps = deps;
    this.syncing = false;
  }
  isSyncing() {
    return this.syncing;
  }
  createClient() {
    return new FeishuClient((force) => this.deps.auth.getToken(force), this.deps.logger);
  }
  async listSpaces() {
    const client = this.createClient();
    return listSpaces(client);
  }
  async run(options) {
    if (this.syncing)
      throw new Error("\u5DF2\u6709\u540C\u6B65\u4EFB\u52A1\u5728\u6267\u884C\u4E2D");
    this.syncing = true;
    try {
      return await this.runInternal(options);
    } finally {
      this.syncing = false;
    }
  }
  async runInternal(options) {
    const settings = this.deps.getSettings();
    const spaceId = parseTokenFromInput(settings.spaceId);
    const rootNodeToken = parseTokenFromInput(settings.rootNodeToken) || void 0;
    if (!spaceId)
      throw new Error("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u586B\u5199\u77E5\u8BC6\u5E93 space_id");
    const client = this.createClient();
    const logger = this.deps.logger;
    const filter = new PathFilter(settings.excludePatterns);
    const previousTarget = settings.state.target;
    if (!previousTarget || previousTarget.spaceId !== spaceId || previousTarget.rootNodeToken !== (rootNodeToken ?? "")) {
      if (previousTarget) {
        logger.warn(
          `\u540C\u6B65\u76EE\u6807\u5DF2\u53D8\u66F4\uFF08${previousTarget.spaceId}/${previousTarget.rootNodeToken || "\u9876\u5C42"} \u2192 ${spaceId}/${rootNodeToken ?? "\u9876\u5C42"}\uFF09\uFF0C\u5DF2\u6E05\u7A7A\u6620\u5C04\u8868\uFF0C\u672C\u8F6E\u6309"\u9996\u6B21\u5BF9\u63A5"\u91CD\u65B0\u5224\u5B9A\uFF0C\u4E0D\u4F1A\u76F4\u63A5\u8986\u76D6\u672C\u5730`
        );
        settings.state.records = {};
        settings.state.folders = {};
        settings.state.conflicts = {};
      }
      settings.state.target = { spaceId, rootNodeToken: rootNodeToken ?? "" };
    }
    try {
      let plan;
      if (options.preApprovedPlan) {
        plan = filterPlan(options.preApprovedPlan, options.mode);
      } else {
        if (!rootNodeToken && !settings.state.folders[""]?.nodeToken) {
          const title = settings.rootPageTitle.trim() || this.deps.app.vault.getName();
          try {
            const topLevel = await listNodes(client, spaceId);
            const found = topLevel.find((node) => node.title === title && node.obj_type !== "file");
            if (found?.node_token) {
              settings.state.folders[""] = { nodeToken: found.node_token };
              logger.info(`\u8BC6\u522B\u5230\u5DF2\u6709\u7684\u77E5\u8BC6\u5E93\u9876\u5C42\u9875\u9762\u300C${title}\u300D\uFF0C\u590D\u7528\u5B83\u5B58\u653E vault \u6839\u76EE\u5F55\u4E0B\u7684\u7B14\u8BB0`);
            }
          } catch (error) {
            logger.warn(`\u67E5\u627E\u77E5\u8BC6\u5E93\u9876\u5C42\u9875\u9762\u5931\u8D25\uFF0C\u6839\u76EE\u5F55\u4E0B\u7684\u7B14\u8BB0\u53EF\u80FD\u88AB\u8BC6\u522B\u6210\u65B0\u6587\u4EF6\uFF1A${String(error)}`);
          }
        }
        options.onProgress?.("\u626B\u63CF\u672C\u5730\u7B14\u8BB0\u2026");
        const local = scanLocalNotes(this.deps.app, filter);
        options.onProgress?.("\u8BFB\u53D6\u98DE\u4E66\u77E5\u8BC6\u5E93\u8282\u70B9\u6811\u2026");
        const tree = await walkWikiTree(client, spaceId, rootNodeToken, {
          rootContainerNode: settings.state.folders[""]?.nodeToken,
          onProgress: (visited) => {
            if (visited % 50 === 0)
              options.onProgress?.(`\u8BFB\u53D6\u98DE\u4E66\u77E5\u8BC6\u5E93\u8282\u70B9\u6811\u2026\uFF08\u5DF2\u89C1 ${visited} \u4E2A\u8282\u70B9\uFF09`);
          }
        });
        const remote = /* @__PURE__ */ new Map();
        const seenPaths = /* @__PURE__ */ new Map();
        for (const entry of tree) {
          if (entry.objType !== "file")
            continue;
          if (entry.relDir && filter.isExcluded(entry.relDir))
            continue;
          const raw = joinPath(entry.relDir, entry.title);
          const relPath = settings.folderMode === "flat" ? raw.split(settings.flatSeparator).join("/") : raw;
          if (filter.isExcluded(relPath))
            continue;
          if (relPath.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
            logger.warn(`\u8FDC\u7AEF\u6807\u9898\u5305\u542B\u975E\u6CD5\u8DEF\u5F84\u7247\u6BB5\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${raw}`);
            continue;
          }
          if (settings.folderMode === "flat" && entry.title.includes(settings.flatSeparator)) {
            logger.warn(`\u8FDC\u7AEF\u6807\u9898\u91CC\u542B\u6709\u6241\u5E73\u5206\u9694\u7B26 "${settings.flatSeparator}"\uFF0C\u65E0\u6CD5\u8FD8\u539F\u8DEF\u5F84\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${entry.title}`);
            continue;
          }
          const normalized = relPath.normalize("NFC").toLowerCase();
          const clash = seenPaths.get(normalized);
          if (clash === relPath) {
            logger.warn(`\u8FDC\u7AEF\u5B58\u5728\u591A\u4E2A\u540C\u540D\u8282\u70B9\uFF0C\u53EA\u5904\u7406\u5176\u4E2D\u4E00\u4E2A\uFF1A${relPath}\uFF08\u53EF\u80FD\u662F\u8986\u76D6\u672A\u751F\u6548\u7559\u4E0B\u7684\u91CD\u590D\u6587\u4EF6\uFF0C\u5EFA\u8BAE\u5728\u77E5\u8BC6\u5E93\u91CC\u6E05\u7406\uFF09`);
            continue;
          }
          if (clash && clash !== relPath) {
            logger.warn(`\u8FDC\u7AEF\u5B58\u5728\u4EC5\u5927\u5C0F\u5199\u6216 Unicode \u5F62\u5F0F\u4E0D\u540C\u7684\u540C\u540D\u6587\u4EF6\uFF0C\u5DF2\u8DF3\u8FC7\u5176\u4E2D\u4E00\u4E2A\uFF1A${relPath}\uFF08\u4E0E ${clash} \u51B2\u7A81\uFF09`);
            continue;
          }
          seenPaths.set(normalized, relPath);
          remote.set(relPath, { relPath, entry });
        }
        const modifiedTimes = /* @__PURE__ */ new Map();
        if (remote.size > 0) {
          options.onProgress?.("\u8BFB\u53D6\u8FDC\u7AEF\u5143\u6570\u636E\u2026");
          const tokens = Array.from(remote.values()).map((note) => note.entry.objToken);
          try {
            const metas = await batchQueryMetas(client, tokens);
            for (const [token, meta] of metas) {
              if (meta.modifiedTime)
                modifiedTimes.set(token, meta.modifiedTime);
            }
          } catch (error) {
            logger.warn(`\u6279\u91CF\u8BFB\u53D6\u8FDC\u7AEF\u5143\u6570\u636E\u5931\u8D25\uFF0C\u5C06\u9010\u6587\u4EF6\u6821\u9A8C\u5185\u5BB9\uFF1A${String(error)}`);
          }
        }
        for (const note of remote.values()) {
          note.modifiedTime = modifiedTimes.get(note.entry.objToken);
        }
        const localHashCache = /* @__PURE__ */ new Map();
        const remoteHashCache = /* @__PURE__ */ new Map();
        plan = await buildPlan({
          state: settings.state,
          local,
          remote,
          isExcluded: (relPath) => filter.isExcluded(relPath),
          recreateRemoteIfDeleted: settings.recreateRemoteIfDeleted,
          propagateLocalDelete: settings.propagateLocalDelete,
          propagateRemoteDelete: settings.propagateRemoteDelete,
          hashLocal: async (relPath) => {
            const cached = localHashCache.get(relPath);
            if (cached)
              return cached;
            const bytes = await readLocalBytes(this.deps.app, relPath);
            const hash = await sha256Hex(bytes);
            localHashCache.set(relPath, hash);
            return hash;
          },
          hashRemote: async (fileToken) => {
            const cached = remoteHashCache.get(fileToken);
            if (cached)
              return cached;
            const bytes = await downloadFile(client, fileToken);
            const hash = await sha256Hex(bytes);
            remoteHashCache.set(fileToken, hash);
            return hash;
          }
        });
        plan = filterPlan(plan, options.mode);
      }
      if (options.dryRun) {
        return { plan, report: [], executed: false };
      }
      let allowPush = options.mode !== "pull";
      const allowPull = options.mode !== "push";
      let planForRun = plan;
      if (options.confirm) {
        const decision = await options.confirm(plan);
        if (decision === "cancel")
          return { plan, report: [], executed: false };
        if (decision === "pull-only") {
          allowPush = false;
          planForRun = filterPlan(plan, "pull");
        }
      }
      try {
        const report = await executePlan(
          planForRun,
          {
            app: this.deps.app,
            client,
            settings,
            state: settings.state,
            logger,
            spaceId,
            rootNodeToken
          },
          {
            allowPush,
            allowPull,
            isEditorDirty: (relPath) => this.isEditorDirty(relPath),
            onProgress: (message, done, total) => options.onProgress?.(`${message}\uFF08${done}/${total}\uFF09`)
          }
        );
        return { plan: planForRun, report, executed: true };
      } finally {
        await this.deps.saveSettings();
      }
    } catch (error) {
      await this.deps.saveSettings();
      throw error;
    }
  }
  async isEditorDirty(relPath) {
    for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view?.file?.path !== relPath || !view.editor)
        continue;
      const value = view.editor.getValue();
      const file = this.deps.app.vault.getAbstractFileByPath(relPath);
      if (file instanceof import_obsidian8.TFile) {
        const disk = await this.deps.app.vault.cachedRead(file);
        return value !== disk;
      }
      return value.length > 0;
    }
    return false;
  }
};
function filterPlan(plan, mode) {
  if (mode === "both")
    return plan;
  const items = plan.items.filter((entry) => {
    if (mode === "pull")
      return entry.action !== "push" && entry.action !== "create-remote" && entry.action !== "delete-remote";
    return entry.action !== "pull" && entry.action !== "create-local" && entry.action !== "delete-local";
  });
  const counts = {};
  for (const entry of items)
    counts[entry.action] = (counts[entry.action] ?? 0) + 1;
  return { ...plan, items, counts };
}

// src/sync/docEngine.ts
var import_obsidian10 = require("obsidian");

// src/feishu/docs.ts
var CREATE_EXTRA_PARAM = '{"open_create_async":true}';
var FETCH_EXTRA_PARAM = '{"enable_user_cite_reference_map":true,"include_comments":true,"return_html5_block_data":true}';
var ASYNC_MAX_WAIT_MS = 10 * 60 * 1e3;
var ASYNC_DEFAULT_POLL_MS = 3e3;
var ASYNC_MIN_POLL_MS = 100;
var ASYNC_MAX_POLL_MS = 1e4;
function sleep2(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function readString2(source, key) {
  const value = source?.[key];
  if (typeof value === "string" && value)
    return value;
  if (typeof value === "number")
    return String(value);
  return void 0;
}
function escapeTitleText(title) {
  return title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;").replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");
}
function buildMarkdownContent(title, markdown) {
  const tag = `<title>${escapeTitleText(title.trim())}</title>`;
  return markdown === "" ? tag : `${tag}
${encodeFeishuMath(markdown)}`;
}
function warningsText(data) {
  const warnings = data?.warnings;
  if (!Array.isArray(warnings) || warnings.length === 0)
    return "";
  return `\uFF1B\u670D\u52A1\u7AEF warnings\uFF1A${warnings.map((item3) => String(item3)).join(" / ")}`;
}
function assertOperationSucceeded(endpoint, data) {
  if (typeof data?.result === "string" && data.result.toLowerCase() === "failed") {
    throw new FeishuError(`docs_ai ${endpoint} \u8FD4\u56DE result=failed${warningsText(data)}`, { endpoint });
  }
}
function pollInterval(pollAfterMs) {
  if (!pollAfterMs || pollAfterMs <= 0)
    return ASYNC_DEFAULT_POLL_MS;
  return Math.min(ASYNC_MAX_POLL_MS, Math.max(ASYNC_MIN_POLL_MS, pollAfterMs));
}
function decodeTaskResult(endpoint, task) {
  const raw = task.result?.create_document;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new FeishuError(`docs_ai ${endpoint} \u7684\u5F02\u6B65\u4EFB\u52A1\u6210\u529F\u4F46\u7F3A\u5C11 result.create_document`, { endpoint });
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      throw new Error("\u4E0D\u662F JSON \u5BF9\u8C61");
    return parsed;
  } catch (error) {
    throw new FeishuError(`docs_ai ${endpoint} \u7684 result.create_document \u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${String(error)}`, { endpoint });
  }
}
async function waitForAsyncTask(client, task, options) {
  const taskId = (task.task_id ?? "").trim();
  if (!taskId) {
    throw new FeishuError(`docs_ai ${options.endpoint} \u8FD4\u56DE\u4E86\u6CA1\u6709 task_id \u7684\u5F02\u6B65\u4EFB\u52A1`, { endpoint: options.endpoint });
  }
  const path = `/open-apis/docs_ai/v1/async_tasks/${pathSegment(taskId)}`;
  const deadline = Date.now() + ASYNC_MAX_WAIT_MS;
  let current = task;
  let delay = 0;
  let polls = 0;
  for (; ; ) {
    const status = (current.status ?? "").trim().toLowerCase();
    if (status === "succeeded")
      return decodeTaskResult(options.endpoint, current);
    if (status === "failed" || status === "expired") {
      const code = current.failure?.code ? `\uFF08code: ${current.failure.code}\uFF09` : "";
      const message = current.failure?.message || status;
      throw new FeishuError(`docs_ai \u6587\u6863\u5904\u7406\u5931\u8D25\uFF1A${message}${code}`, { endpoint: path });
    }
    if (status !== "" && status !== "processing") {
      throw new FeishuError(`docs_ai ${path} \u8FD4\u56DE\u4E86\u672A\u77E5\u4EFB\u52A1\u72B6\u6001 ${current.status}`, { endpoint: path });
    }
    if (Date.now() >= deadline) {
      throw new FeishuError(`docs_ai \u7B49\u5F85\u6587\u6863\u5904\u7406\u8D85\u8FC7 ${Math.round(ASYNC_MAX_WAIT_MS / 6e4)} \u5206\u949F\uFF0C\u8BF7\u7A0D\u540E\u7528\u300C\u53D6\u56DE\u300D\u91CD\u8BD5`, {
        endpoint: path
      });
    }
    if (delay > 0)
      await sleep2(delay);
    polls += 1;
    options.onProgress?.(`\u7B49\u5F85\u98DE\u4E66\u5904\u7406\u6587\u6863\uFF08\u7B2C ${polls} \u6B21\u8F6E\u8BE2\uFF09\u2026`);
    const data = await client.json("GET", path);
    const next = data?.task;
    if (!next)
      throw new FeishuError(`docs_ai ${path} \u7684\u54CD\u5E94\u91CC\u6CA1\u6709 task`, { endpoint: path });
    const returnedId = (next.task_id ?? "").trim();
    if (returnedId && returnedId !== taskId) {
      throw new FeishuError(`docs_ai ${path} \u8FD4\u56DE\u7684 task_id \u4E0E\u8BF7\u6C42\u4E0D\u4E00\u81F4`, { endpoint: path });
    }
    current = next;
    delay = pollInterval(current.poll_after_ms);
  }
}
async function createDocumentFromMarkdown(client, options) {
  const title = options.title.trim();
  if (!title)
    throw new Error("\u521B\u5EFA\u6587\u6863\u9700\u8981\u975E\u7A7A\u6807\u9898");
  const path = "/open-apis/docs_ai/v1/documents";
  const body = {
    format: "markdown",
    content: buildMarkdownContent(title, options.markdown),
    extra_param: CREATE_EXTRA_PARAM
  };
  if (options.parentToken)
    body.parent_token = options.parentToken;
  options.onProgress?.("\u521B\u5EFA\u98DE\u4E66\u6587\u6863\u2026");
  const initial = await client.json("POST", path, { body });
  assertOperationSucceeded(path, initial);
  const taskId = (initial?.task?.task_id ?? "").trim();
  const ready = taskId ? await waitForAsyncTask(client, initial.task, { endpoint: path, onProgress: options.onProgress }) : initial;
  assertOperationSucceeded(path, ready);
  const created = ready?.document;
  const asRecord2 = ready;
  const documentId = readString2(created, "document_id") ?? readString2(asRecord2, "document_id");
  if (!documentId) {
    throw new FeishuError(`docs_ai \u521B\u5EFA\u6587\u6863\u6210\u529F\u4F46\u6CA1\u6709\u8FD4\u56DE document_id`, { endpoint: path });
  }
  return {
    documentId,
    url: readString2(created, "url") ?? readString2(asRecord2, "url"),
    newBlocks: readNewBlocks(ready),
    revisionId: readRevisionId(ready)
  };
}
async function updateDocumentFromMarkdown(client, documentId, options) {
  const id = documentId.trim();
  if (!id)
    throw new Error("\u66F4\u65B0\u6587\u6863\u9700\u8981 document_id");
  const path = `/open-apis/docs_ai/v1/documents/${pathSegment(id)}`;
  const content = options.includeTitle === false ? encodeFeishuMath(options.markdown) : buildMarkdownContent(options.title, options.markdown);
  const data = await client.json("PUT", path, {
    body: { format: "markdown", command: "overwrite", revision_id: -1, content }
  });
  assertOperationSucceeded(path, data);
  return { newBlocks: readNewBlocks(data), revisionId: readRevisionId(data) };
}
async function fetchDocumentMarkdown(client, documentId) {
  const id = documentId.trim();
  if (!id)
    throw new Error("\u53D6\u56DE\u6587\u6863\u9700\u8981 document_id");
  const path = `/open-apis/docs_ai/v1/documents/${pathSegment(id)}/fetch`;
  const data = await client.json("POST", path, {
    body: {
      format: "markdown",
      extra_param: FETCH_EXTRA_PARAM,
      // CLI 默认 --detail simple：不导出 block id / 样式属性
      export_option: { export_block_id: false, export_style_attrs: false, export_cite_extra_data: false }
    }
  });
  const content = data?.document?.content;
  if (typeof content !== "string") {
    throw new FeishuError(`docs_ai \u53D6\u56DE\u6587\u6863 ${id} \u7684\u54CD\u5E94\u91CC\u6CA1\u6709 document.content`, { endpoint: path });
  }
  return content;
}

// src/sync/docPlanner.ts
function documentTitleFor(relPath, settings) {
  const name = basenameOf(relPath).replace(/\.md$/i, "");
  if (settings.folderMode !== "flat")
    return name;
  const dir = dirnameOf(relPath);
  if (!dir)
    return name;
  return `${dir.split("/").join(settings.flatSeparator)}${settings.flatSeparator}${name}`;
}
function uniqueDocumentTitle(title, taken) {
  if (!taken.has(title))
    return { title, renamed: false };
  let candidate = `${title} (note)`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${title} (note ${index})`;
    index += 1;
  }
  return { title: candidate, renamed: true };
}
function illegalSegments(relPath) {
  return relPath.split("/").some((segment) => segment === ".." || segment === "." || segment === "");
}
function deriveRelPath(entry, options, warnings) {
  if (options.folderMode === "flat") {
    const relPath2 = `${entry.title.split(options.flatSeparator).join("/")}.md`;
    if (illegalSegments(relPath2)) {
      warnings.push(`\u8FDC\u7AEF\u6807\u9898\u91CC\u7684\u8DEF\u5F84\u7247\u6BB5\u975E\u6CD5\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${entry.title}`);
      return void 0;
    }
    return relPath2;
  }
  const relPath = joinPath(entry.relDir, `${entry.title.replace(/\.md$/i, "")}.md`);
  if (illegalSegments(relPath)) {
    warnings.push(`\u8FDC\u7AEF\u6807\u9898\u5305\u542B\u975E\u6CD5\u8DEF\u5F84\u7247\u6BB5\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${entry.title}`);
    return void 0;
  }
  return relPath;
}
function buildDocRemoteIndex(options) {
  const warnings = [];
  const containerTokens = /* @__PURE__ */ new Set();
  for (const folder of Object.values(options.state.folders)) {
    if (folder.nodeToken)
      containerTokens.add(folder.nodeToken);
  }
  if (options.rootContainerNode)
    containerTokens.add(options.rootContainerNode);
  const parentTokens = /* @__PURE__ */ new Set();
  for (const entry of options.entries) {
    if (entry.parentNodeToken)
      parentTokens.add(entry.parentNodeToken);
  }
  for (const entry of options.entries) {
    if (entry.objType === "file")
      continue;
    if (containerTokens.has(entry.nodeToken) || parentTokens.has(entry.nodeToken))
      containerTokens.add(entry.nodeToken);
  }
  const containers = /* @__PURE__ */ new Map();
  const containerTitles = /* @__PURE__ */ new Set();
  for (const entry of options.entries) {
    if (!containerTokens.has(entry.nodeToken))
      continue;
    const relDir = entry.nodeToken === options.rootContainerNode ? "" : joinPath(entry.relDir, entry.title);
    if (options.folderMode === "nodes" && !containers.has(relDir)) {
      containers.set(relDir, { nodeToken: entry.nodeToken, title: entry.title, parentNodeToken: entry.parentNodeToken });
    }
    containerTitles.add(entry.title);
  }
  const knownDocumentPaths = /* @__PURE__ */ new Map();
  for (const [relPath, record] of Object.entries(options.state.docRecords)) {
    knownDocumentPaths.set(record.documentId, relPath);
  }
  const notes = /* @__PURE__ */ new Map();
  const seenPaths = /* @__PURE__ */ new Map();
  for (const entry of options.entries) {
    if (entry.objType !== "docx" || containerTokens.has(entry.nodeToken))
      continue;
    const relPath = knownDocumentPaths.get(entry.objToken) ?? deriveRelPath(entry, options, warnings);
    if (!relPath)
      continue;
    if (options.isExcluded(relPath))
      continue;
    const normalized = relPath.normalize("NFC").toLowerCase();
    const clash = seenPaths.get(normalized);
    if (clash === relPath) {
      warnings.push(`\u8FDC\u7AEF\u5B58\u5728\u591A\u4E2A\u540C\u540D\u6587\u6863\uFF0C\u53EA\u5904\u7406\u5176\u4E2D\u4E00\u4E2A\uFF1A${relPath}`);
      continue;
    }
    if (clash && clash !== relPath) {
      warnings.push(`\u8FDC\u7AEF\u5B58\u5728\u4EC5\u5927\u5C0F\u5199\u6216 Unicode \u5F62\u5F0F\u4E0D\u540C\u7684\u540C\u540D\u6587\u6863\uFF0C\u5DF2\u8DF3\u8FC7\u5176\u4E2D\u4E00\u4E2A\uFF1A${relPath}\uFF08\u4E0E ${clash} \u51B2\u7A81\uFF09`);
      continue;
    }
    seenPaths.set(normalized, relPath);
    notes.set(relPath, {
      relPath,
      documentId: entry.objToken,
      nodeToken: entry.nodeToken,
      parentNodeToken: entry.parentNodeToken,
      title: entry.title
    });
  }
  return { notes, containers, containerTitles, warnings };
}
function createDocPlanCache() {
  return {
    localText: /* @__PURE__ */ new Map(),
    localHash: /* @__PURE__ */ new Map(),
    fetched: /* @__PURE__ */ new Map(),
    fetchedHash: /* @__PURE__ */ new Map(),
    pulled: /* @__PURE__ */ new Map(),
    fetchCount: 0
  };
}
function item2(relPath, action, reason, extra = {}) {
  return { relPath, action, reason, parentDir: dirnameOf(relPath), ...extra };
}
function conflictItem2(relPath, state, reason, extra, localHash, remoteHash) {
  const previous = state.conflicts[relPath];
  const duplicate = !!previous && previous.remoteHash === remoteHash && previous.localHash === localHash;
  return item2(relPath, "conflict", duplicate ? "\u4E0E\u4E0A\u6B21\u76F8\u540C\u7684\u51B2\u7A81\uFF0C\u672A\u91CD\u590D\u751F\u6210\u526F\u672C" : reason, {
    ...extra,
    localHash,
    remoteHash,
    duplicateConflict: duplicate
  });
}
async function readLocalCached(input, relPath) {
  const cached = input.cache.localText.get(relPath);
  if (cached !== void 0)
    return cached;
  const text = await input.readLocal(relPath);
  input.cache.localText.set(relPath, text);
  return text;
}
async function hashLocalCached(input, relPath) {
  const cached = input.cache.localHash.get(relPath);
  if (cached !== void 0)
    return cached;
  const hash = await input.hashText(await readLocalCached(input, relPath));
  input.cache.localHash.set(relPath, hash);
  return hash;
}
async function fetchCached(input, documentId) {
  const cached = input.cache.fetched.get(documentId);
  if (cached !== void 0)
    return cached;
  input.cache.fetchCount += 1;
  const text = await input.fetchMarkdown(documentId);
  input.cache.fetched.set(documentId, text);
  return text;
}
async function remoteChangedState(input, record, documentId, verifyContent = false) {
  const metaTime = input.remoteModifiedTimes.get(documentId);
  if (!verifyContent && !input.verifyRemoteByContent && record.remoteModifiedTime) {
    if (metaTime !== void 0 && metaTime === record.remoteModifiedTime)
      return { changed: false, metaTime };
  }
  const hash = await fetchedHash(input, documentId);
  return { changed: hash !== record.baseRemoteHash, hash, metaTime };
}
async function fetchedHash(input, documentId) {
  const cached = input.cache.fetchedHash.get(documentId);
  if (cached !== void 0)
    return cached;
  const hash = await input.hashFetched(await fetchCached(input, documentId));
  input.cache.fetchedHash.set(documentId, hash);
  return hash;
}
async function pulledContent(input, relPath, remoteNote, localNote) {
  const cached = input.cache.pulled.get(relPath);
  if (cached !== void 0)
    return cached;
  const fetched = await fetchCached(input, remoteNote.documentId);
  const localText = localNote ? await readLocalCached(input, relPath) : "";
  const pulled = applyRules(
    "toObsidian",
    fetched,
    { relPath, documentTitle: documentTitleFor(relPath, input.settings), localContent: localText },
    input.rules
  );
  input.cache.pulled.set(relPath, pulled);
  return pulled;
}
async function isLocalChanged2(input, record, localNote) {
  if (record.localSize === localNote.size && record.localMtime === localNote.mtime && record.baseLocalHash) {
    return false;
  }
  const hash = await hashLocalCached(input, localNote.relPath);
  return hash !== record.baseLocalHash;
}
async function buildDocPlan(input) {
  const { state, local, remote } = input;
  const items = [];
  const fingerprint2 = publishRulesFingerprint(input.rules);
  const warnings = [];
  const relPaths = /* @__PURE__ */ new Set([...local.keys(), ...remote.notes.keys(), ...Object.keys(state.docRecords)]);
  for (const relPath of Array.from(relPaths).sort()) {
    if (input.isExcluded(relPath))
      continue;
    const localNote = local.get(relPath);
    const remoteNote = remote.notes.get(relPath);
    const record = state.docRecords[relPath];
    if (localNote && ruleEnabled(input.rules, "toFeishu", "source-format-diagnostics")) {
      for (const message of sourceFormatWarnings(await readLocalCached(input, relPath)))
        warnings.push({ relPath, message });
    }
    const remoteFields2 = remoteNote ? { remoteTitle: remoteNote.title, nodeToken: remoteNote.nodeToken, documentId: remoteNote.documentId } : {};
    if (input.forcePush && localNote && localNote.size > 0) {
      items.push(
        item2(relPath, remoteNote ? "push" : "create-remote", "\u5F3A\u5236\u91CD\u63A8\uFF1A\u5FFD\u7565\u57FA\u7EBF", {
          ...remoteFields2,
          localSize: localNote.size,
          localMtime: localNote.mtime
        })
      );
      continue;
    }
    if (!record) {
      if (localNote && remoteNote) {
        const [pulled2, localText2, localHash2, hash2] = await Promise.all([
          pulledContent(input, relPath, remoteNote, localNote),
          readLocalCached(input, relPath),
          hashLocalCached(input, relPath),
          fetchedHash(input, remoteNote.documentId)
        ]);
        const extra2 = { ...remoteFields2, localHash: localHash2, remoteHash: hash2, localSize: localNote.size, localMtime: localNote.mtime };
        if (pulled2 === localText2) {
          items.push(item2(relPath, "link", "\u4E24\u8FB9\u5185\u5BB9\u4E00\u81F4\uFF0C\u53EA\u5EFA\u7ACB\u6620\u5C04", extra2));
        } else {
          items.push(conflictItem2(relPath, state, "\u9996\u6B21\u5BF9\u63A5\uFF1A\u540C\u540D\u6587\u6863\u4E24\u8FB9\u5185\u5BB9\u4E0D\u540C\uFF0C\u5DF2\u4FDD\u7559\u53CC\u65B9", extra2, localHash2, hash2));
        }
        continue;
      }
      if (localNote) {
        items.push(
          item2(
            relPath,
            "create-remote",
            localNote.size === 0 ? "\u7A7A\u7B14\u8BB0\u5728\u6587\u6863\u6A21\u5F0F\u4E0B\u4E5F\u4F1A\u540C\u6B65\uFF08<title> \u4FDD\u8BC1 content \u975E\u7A7A\uFF09" : void 0
          )
        );
        continue;
      }
      if (remoteNote) {
        items.push(item2(relPath, "create-local", void 0, remoteFields2));
      }
      continue;
    }
    if (!localNote && !remoteNote) {
      items.push(item2(relPath, "forget", "\u4E24\u8FB9\u90FD\u5DF2\u4E0D\u5B58\u5728\uFF0C\u6E05\u7406\u6620\u5C04"));
      continue;
    }
    if (!localNote) {
      const remoteState2 = await remoteChangedState(input, record, remoteNote.documentId);
      const hash2 = remoteState2.hash ?? record.baseRemoteHash;
      const stamp = remoteState2.metaTime ? { remoteModifiedTime: remoteState2.metaTime } : {};
      if (remoteState2.changed) {
        items.push(
          conflictItem2(
            relPath,
            state,
            "\u672C\u5730\u5DF2\u5220\u9664\u3001\u8FDC\u7AEF\u88AB\u4FEE\u6539\uFF1A\u4E3A\u907F\u514D\u4E22\u5185\u5BB9\uFF0C\u672A\u81EA\u52A8\u5904\u7406",
            { ...remoteFields2, localHash: "", remoteHash: hash2 },
            "",
            hash2
          )
        );
      } else if (input.propagateLocalDelete) {
        items.push(
          item2(relPath, "delete-remote", "\u672C\u5730\u5DF2\u5220\u9664\uFF0C\u6309\u8BBE\u7F6E\u5220\u9664\u8FDC\u7AEF\u6587\u6863\uFF08\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\uFF0C\u53EF\u6062\u590D\uFF09", {
            ...remoteFields2,
            ...stamp
          })
        );
      } else {
        items.push(item2(relPath, "local-deleted", "\u672C\u5730\u5DF2\u5220\u9664\u3001\u8FDC\u7AEF\u672A\u53D8\uFF08\u672A\u81EA\u52A8\u5220\u9664\u8FDC\u7AEF\uFF09", { ...remoteFields2, ...stamp }));
      }
      continue;
    }
    if (!remoteNote) {
      const localChanged2 = await isLocalChanged2(input, record, localNote);
      if (!localChanged2) {
        if (input.propagateRemoteDelete) {
          items.push(
            item2(relPath, "delete-local", "\u8FDC\u7AEF\u5DF2\u5220\u9664\u4E14\u672C\u5730\u672A\u53D8\uFF0C\u6309\u8BBE\u7F6E\u628A\u672C\u5730\u7B14\u8BB0\u79FB\u8FDB .trash", {
              localSize: localNote.size,
              localMtime: localNote.mtime
            })
          );
        } else {
          items.push(item2(relPath, "remote-deleted", "\u8FDC\u7AEF\u5DF2\u5220\u9664\u3001\u672C\u5730\u672A\u53D8\uFF08\u672A\u81EA\u52A8\u5220\u9664\u672C\u5730\uFF09"));
        }
      } else if (input.recreateRemoteIfDeleted) {
        items.push(item2(relPath, "create-remote", "\u8FDC\u7AEF\u5DF2\u5220\u9664\u4F46\u672C\u5730\u6709\u4FEE\u6539\uFF0C\u6309\u8BBE\u7F6E\u91CD\u65B0\u4E0A\u4F20"));
      } else {
        items.push(item2(relPath, "remote-deleted", "\u8FDC\u7AEF\u5DF2\u5220\u9664\u3001\u672C\u5730\u6709\u4FEE\u6539\uFF1A\u4E3A\u907F\u514D\u8BEF\u6062\u590D\uFF0C\u672A\u81EA\u52A8\u91CD\u5EFA"));
      }
      continue;
    }
    const localChanged = await isLocalChanged2(input, record, localNote);
    const rulesChanged = record.publishRulesFingerprint !== fingerprint2;
    const remoteState = await remoteChangedState(input, record, remoteNote.documentId, rulesChanged);
    const remoteChanged = remoteState.changed;
    const hash = remoteState.hash;
    const localHash = await hashLocalCached(input, relPath);
    const extra = {
      ...remoteFields2,
      localHash,
      remoteHash: hash,
      localSize: localNote.size,
      localMtime: localNote.mtime,
      remoteModifiedTime: remoteState.metaTime
    };
    if (!localChanged && !remoteChanged) {
      items.push(rulesChanged ? item2(relPath, "push", "\u8F6C\u6362\u89C4\u5219\u5DF2\u66F4\u65B0\uFF1A\u5237\u65B0\u98DE\u4E66\u6392\u7248\uFF0C\u672C\u5730\u6B63\u6587\u4E0D\u53D8", { ...extra, rulesRefresh: true }) : item2(relPath, "skip", void 0, extra));
      continue;
    }
    if (localChanged && !remoteChanged) {
      items.push(item2(relPath, "push", void 0, extra));
      continue;
    }
    if (!localChanged && remoteChanged) {
      items.push(item2(relPath, "pull", void 0, extra));
      continue;
    }
    const [pulled, localText] = await Promise.all([
      pulledContent(input, relPath, remoteNote, localNote),
      readLocalCached(input, relPath)
    ]);
    if (pulled === localText) {
      items.push(item2(relPath, "link", "\u4E24\u8FB9\u5185\u5BB9\u4E00\u81F4\uFF0C\u53EA\u66F4\u65B0\u57FA\u7EBF", extra));
      continue;
    }
    items.push(conflictItem2(relPath, state, "\u4E24\u8FB9\u90FD\u6539\u8FC7\u4E14\u5185\u5BB9\u4E0D\u540C\uFF0C\u5DF2\u4FDD\u7559\u53CC\u65B9", extra, localHash, hash ?? localHash));
  }
  return {
    items,
    counts: summarize(items),
    localNoteCount: local.size,
    remoteNoteCount: remote.notes.size,
    publishRulesFingerprint: fingerprint2,
    pullRulesFingerprint: pullRulesFingerprint(input.rules),
    warnings
  };
}

// src/sync/docExecutor.ts
var import_obsidian9 = require("obsidian");
function describeError3(error) {
  if (error instanceof Error) {
    const withDescribe = error;
    return typeof withDescribe.describe === "function" ? withDescribe.describe() : error.message;
  }
  return String(error);
}
function two2(value) {
  return String(value).padStart(2, "0");
}
function conflictCopyRelPath2(relPath) {
  const now = /* @__PURE__ */ new Date();
  const stamp = `${now.getFullYear()}${two2(now.getMonth() + 1)}${two2(now.getDate())}-${two2(now.getHours())}${two2(now.getMinutes())}${two2(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, "0")}`;
  const base = relPath.replace(/\.md$/i, "");
  return `${CONFLICT_DIR}/${base}.${stamp}.md`;
}
function encodeText(text) {
  return new TextEncoder().encode(text).buffer;
}
async function readLocalText(app, relPath) {
  const file = app.vault.getAbstractFileByPath(relPath);
  if (!(file instanceof import_obsidian9.TFile))
    throw new Error(`\u627E\u4E0D\u5230\u672C\u5730\u6587\u4EF6\uFF1A${relPath}`);
  return app.vault.read(file);
}
function existsLocally2(app, relPath) {
  return app.vault.getAbstractFileByPath(relPath) instanceof import_obsidian9.TFile;
}
async function executeDocPlan(plan, ctx, options) {
  const reports = [];
  const { state, settings } = ctx;
  const folderNodes = /* @__PURE__ */ new Map();
  let rootContainerToken;
  const ensureRootContainer = async () => {
    if (ctx.rootNodeToken)
      return ctx.rootNodeToken;
    if (rootContainerToken)
      return rootContainerToken;
    const cached = state.folders[""];
    if (cached?.nodeToken) {
      rootContainerToken = cached.nodeToken;
      return rootContainerToken;
    }
    const title = settings.rootPageTitle.trim() || ctx.app.vault.getName();
    const topLevel = await listNodes(ctx.client, ctx.spaceId).catch(() => []);
    const found = topLevel.find((node2) => node2.title === title && node2.obj_type !== "file");
    if (found?.node_token) {
      state.folders[""] = { nodeToken: found.node_token };
      rootContainerToken = found.node_token;
      ctx.logger.info(`\u590D\u7528\u77E5\u8BC6\u5E93\u9876\u5C42\u9875\u9762\u300C${title}\u300D\u5B58\u653E vault \u6839\u76EE\u5F55\u4E0B\u7684\u7B14\u8BB0`);
      return rootContainerToken;
    }
    const node = await createContainerNode(ctx.client, ctx.spaceId, void 0, title);
    state.folders[""] = { nodeToken: node.node_token };
    rootContainerToken = node.node_token;
    ctx.logger.info(`\u5728\u77E5\u8BC6\u5E93\u9876\u5C42\u521B\u5EFA\u9875\u9762\u300C${title}\u300D\u5B58\u653E vault \u6839\u76EE\u5F55\u4E0B\u7684\u7B14\u8BB0`);
    return rootContainerToken;
  };
  const resolveFolderNode = async (relDir, needNoteParent) => {
    if (settings.folderMode === "flat" || relDir === "") {
      return needNoteParent ? ensureRootContainer() : ctx.rootNodeToken;
    }
    const cached = folderNodes.get(relDir);
    if (cached)
      return cached;
    const existing = state.folders[relDir];
    if (existing?.nodeToken) {
      folderNodes.set(relDir, existing.nodeToken);
      return existing.nodeToken;
    }
    const parentDir = dirnameOf(relDir);
    const parentNode = await resolveFolderNode(parentDir, false);
    const node = await createContainerNode(ctx.client, ctx.spaceId, parentNode, basenameOf(relDir));
    state.folders[relDir] = { nodeToken: node.node_token, parentNodeToken: parentNode };
    folderNodes.set(relDir, node.node_token);
    ctx.logger.info(`\u521B\u5EFA\u77E5\u8BC6\u5E93\u76EE\u5F55\u8282\u70B9 ${relDir} -> ${node.node_token}`);
    return node.node_token;
  };
  const fetchFresh = async (documentId) => {
    const fetched = await fetchDocumentMarkdown(ctx.client, documentId);
    ctx.cache.fetched.set(documentId, fetched);
    ctx.cache.fetchedHash.set(documentId, await ctx.hashText(fetched));
    return fetched;
  };
  const fetchedFor = async (documentId) => {
    const cached = ctx.cache.fetched.get(documentId);
    if (cached !== void 0)
      return cached;
    return fetchFresh(documentId);
  };
  const writeConflictCopy = async (relPath, remoteText, localHash, remoteHash) => {
    const copyPath = conflictCopyRelPath2(relPath);
    await ensureFolder(ctx.app.vault.adapter, dirnameOf(copyPath));
    await ctx.app.vault.adapter.write(copyPath, remoteText);
    state.conflicts[relPath] = { remoteHash, localHash, copyPath, at: Date.now() };
    return copyPath;
  };
  const pulls = plan.items.filter((entry) => entry.action === "pull" || entry.action === "create-local");
  const pushes = plan.items.filter((entry) => entry.action === "push" || entry.action === "create-remote");
  const links = plan.items.filter((entry) => entry.action === "link");
  const conflicts = plan.items.filter((entry) => entry.action === "conflict");
  const remoteDeletes = plan.items.filter((entry) => entry.action === "delete-remote");
  const localDeletes = plan.items.filter((entry) => entry.action === "delete-local");
  const observed = plan.items.filter(
    (entry) => ["local-deleted", "remote-deleted", "dirty-editor", "forget"].includes(entry.action)
  );
  const steps = [];
  let stepIndex = 0;
  const totalSteps = (options.allowPush ? pushes.length + remoteDeletes.length : 0) + (options.allowPull ? pulls.length + localDeletes.length : 0) + links.length + conflicts.length;
  const tick = (message) => {
    stepIndex += 1;
    options.onProgress?.(message, stepIndex, totalSteps);
  };
  const reportProgress = (message) => options.onProgress?.(message, stepIndex, totalSteps);
  if (options.allowPush) {
    for (const entry of pushes) {
      steps.push(async () => {
        try {
          const statBefore = localStat(ctx.app, entry.relPath);
          const localText = await readLocalText(ctx.app, entry.relPath);
          const record = state.docRecords[entry.relPath];
          if (entry.rulesRefresh && record) {
            if (await options.isEditorDirty(entry.relPath))
              throw new Error("\u7B14\u8BB0\u6B63\u5728\u7F16\u8F91\uFF0C\u8BF7\u4FDD\u5B58\u540E\u91CD\u65B0\u9884\u89C8\u89C4\u5219\u5237\u65B0\u8BA1\u5212");
            if (await ctx.hashText(localText) !== entry.localHash)
              throw new Error("\u9884\u89C8\u540E\u672C\u5730\u6B63\u6587\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u89C4\u5219\u5237\u65B0\u8BA1\u5212");
            const remoteNow = await fetchFresh(record.documentId);
            if (await ctx.hashFetched(remoteNow) !== entry.remoteHash)
              throw new Error("\u9884\u89C8\u540E\u98DE\u4E66\u6B63\u6587\u5DF2\u6539\u53D8\uFF0C\u5DF2\u505C\u6B62\u8986\u76D6\uFF0C\u8BF7\u91CD\u65B0\u540C\u6B65\u5904\u7406\u8FDC\u7AEF\u6539\u52A8");
          }
          const decided = record?.documentTitle ? { title: record.documentTitle, renamed: false } : uniqueDocumentTitle(documentTitleFor(entry.relPath, settings), ctx.containerTitles);
          const ruleContext = {
            relPath: entry.relPath,
            documentTitle: decided.title,
            localContent: localText,
            resolveImage: ctx.resolveImage,
            imageUploads: [],
            attachmentLinkStyle: settings.attachmentLinkStyle,
            warnings: []
          };
          const sent = applyRules("toFeishu", localText, ruleContext, ctx.rules);
          const parentNode = await resolveFolderNode(entry.parentDir, true);
          let documentId;
          let newBlocks = [];
          let revisionId;
          if (entry.action === "push" && record) {
            const updated = await updateDocumentFromMarkdown(ctx.client, record.documentId, { title: decided.title, markdown: sent });
            documentId = record.documentId;
            newBlocks = updated.newBlocks;
            revisionId = updated.revisionId;
          } else {
            const created = await createDocumentFromMarkdown(ctx.client, {
              title: decided.title,
              markdown: sent,
              onProgress: reportProgress
            });
            await moveDocToWiki(ctx.client, ctx.spaceId, parentNode, created.documentId, "docx");
            documentId = created.documentId;
            newBlocks = created.newBlocks;
            revisionId = created.revisionId;
            if (decided.renamed) {
              ctx.logger.info(`\u7B14\u8BB0 ${entry.relPath} \u4E0E\u540C\u540D\u76EE\u5F55\u649E\u540D\uFF0C\u6587\u6863\u6807\u9898\u6539\u4E3A\u300C${decided.title}\u300D`);
            }
          }
          const images = await finalizeDocumentImages(ctx, {
            relPath: entry.relPath,
            documentId,
            newBlocks,
            revisionId,
            uploads: ruleContext.imageUploads ?? []
          });
          for (const warning of ruleContext.warnings ?? [])
            ctx.logger.warn(`\u8F6C\u6362\uFF1A${entry.relPath} ${warning}`);
          const fetched = await fetchFresh(documentId);
          const remoteHash = await ctx.hashFetched(fetched);
          ctx.logger.debug(
            `${entry.relPath}: \u53D6\u56DE\u5F62\u6001\u4E0E\u53D1\u9001\u5F62\u6001${fetched === buildMarkdownContent(decided.title, sent) ? "\u4E00\u81F4" : "\u4E0D\u540C\uFF08\u98DE\u4E66\u505A\u4E86\u683C\u5F0F\u5316\uFF0C\u57FA\u7EBF\u4EE5\u53D6\u56DE\u5F62\u6001\u4E3A\u51C6\uFF09"}`
          );
          const statAfter = localStat(ctx.app, entry.relPath);
          const stable = statAfter.size === statBefore.size && statAfter.mtime === statBefore.mtime;
          const nodeToken = record?.nodeToken ?? (await getNodeByToken(ctx.client, documentId, "docx").catch(() => void 0))?.node_token;
          state.docRecords[entry.relPath] = {
            documentId,
            nodeToken,
            parentNodeToken: parentNode,
            documentTitle: decided.title,
            baseLocalHash: await ctx.hashText(localText),
            baseRemoteHash: remoteHash,
            publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
            remoteModifiedTime: entry.remoteModifiedTime,
            localSize: stable ? statAfter.size : -1,
            localMtime: stable ? statAfter.mtime : -1,
            lastSyncedAt: Date.now()
          };
          delete state.conflicts[entry.relPath];
          reports.push({
            relPath: entry.relPath,
            action: entry.action,
            ok: true,
            message: buildUploadMessage(localText, images, ruleContext.warnings ?? [])
          });
          tick(`\u4E0A\u4F20 ${entry.relPath}`);
        } catch (error) {
          ctx.logger.error(`\u4E0A\u4F20 ${entry.relPath} \u5931\u8D25\uFF1A${describeError3(error)}`);
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError3(error) });
          tick(`\u4E0A\u4F20\u5931\u8D25 ${entry.relPath}`);
        }
      });
    }
  }
  if (options.allowPull) {
    for (const entry of pulls) {
      steps.push(async () => {
        const record = state.docRecords[entry.relPath];
        const documentId = entry.documentId ?? record?.documentId;
        if (!documentId) {
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: "\u7F3A\u5C11\u8FDC\u7AEF document_id" });
          tick(`\u8DF3\u8FC7 ${entry.relPath}`);
          return;
        }
        try {
          const present = existsLocally2(ctx.app, entry.relPath);
          if (entry.action === "pull" && !present) {
            reports.push({
              relPath: entry.relPath,
              action: entry.action,
              ok: true,
              message: "\u751F\u6210\u8BA1\u5212\u540E\u672C\u5730\u6587\u4EF6\u5DF2\u88AB\u5220\u9664\uFF0C\u672A\u91CD\u65B0\u521B\u5EFA\uFF08\u5982\u9700\u6062\u590D\u8BF7\u518D\u8DD1\u4E00\u6B21\u540C\u6B65\uFF09"
            });
            tick(`\u8DF3\u8FC7 ${entry.relPath}`);
            return;
          }
          const fetched = await fetchedFor(documentId);
          const localTextBefore = present ? await readLocalText(ctx.app, entry.relPath) : "";
          const imageWarnings = [];
          const imageDownloads = await prepareRemoteImages(ctx, fetched, {
            documentId,
            relPath: entry.relPath,
            warnings: imageWarnings
          });
          const pulled = applyRules(
            "toObsidian",
            fetched,
            {
              relPath: entry.relPath,
              documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
              localContent: localTextBefore,
              attachmentLinkStyle: settings.attachmentLinkStyle,
              imageDownloads,
              warnings: imageWarnings
            },
            ctx.rules
          );
          const remoteHash = await ctx.hashFetched(fetched);
          for (const warning of imageWarnings)
            ctx.logger.warn(`\u56FE\u7247\uFF1A${entry.relPath} ${warning}`);
          if (present && (entry.localSize !== void 0 || entry.localMtime !== void 0)) {
            const before = localStat(ctx.app, entry.relPath);
            const movedSincePlan = before.size !== entry.localSize || before.mtime !== entry.localMtime;
            if (movedSincePlan) {
              const currentText = await readLocalText(ctx.app, entry.relPath);
              if (currentText !== pulled) {
                const copyPath = await writeConflictCopy(
                  entry.relPath,
                  fetched,
                  await ctx.hashText(currentText),
                  remoteHash
                );
                reports.push({
                  relPath: entry.relPath,
                  action: "conflict",
                  ok: true,
                  message: "\u8BA1\u5212\u751F\u6210\u540E\u672C\u5730\u53C8\u6709\u65B0\u6539\u52A8\uFF0C\u5DF2\u6539\u4E3A\u4FDD\u7559\u53CC\u65B9\uFF0C\u672C\u5730\u4E0E\u8FDC\u7AEF\u90FD\u672A\u6539\u52A8",
                  copyPath
                });
                ctx.logger.warn(`\u62C9\u53D6\u524D\u53D1\u73B0\u672C\u5730\u5DF2\u6539\u52A8\uFF0C\u8F6C\u4E3A\u51B2\u7A81\uFF1A${entry.relPath}`);
                tick(`\u51B2\u7A81 ${entry.relPath}`);
                return;
              }
              state.docRecords[entry.relPath] = {
                documentId,
                nodeToken: entry.nodeToken ?? record?.nodeToken,
                parentNodeToken: record?.parentNodeToken,
                documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
                baseLocalHash: await ctx.hashText(currentText),
                baseRemoteHash: remoteHash,
                publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
                remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
                localSize: before.size,
                localMtime: before.mtime,
                lastSyncedAt: Date.now()
              };
              delete state.conflicts[entry.relPath];
              reports.push({ relPath: entry.relPath, action: "link", ok: true, message: "\u4E24\u8FB9\u5185\u5BB9\u4E00\u81F4\uFF0C\u53EA\u66F4\u65B0\u4E86\u57FA\u7EBF" });
              tick(`\u5EFA\u7ACB\u6620\u5C04 ${entry.relPath}`);
              return;
            }
          }
          if (present && await options.isEditorDirty(entry.relPath)) {
            reports.push({ relPath: entry.relPath, action: "dirty-editor", ok: true, message: "\u6587\u4EF6\u6B63\u5728\u7F16\u8F91\u4E14\u672A\u4FDD\u5B58\uFF0C\u672A\u8986\u76D6" });
            tick(`\u8DF3\u8FC7\u7F16\u8F91\u4E2D\u7684 ${entry.relPath}`);
            return;
          }
          if (present && localTextBefore !== pulled && sameAfterCosmeticRules(
            localTextBefore,
            pulled,
            {
              relPath: entry.relPath,
              documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
              localContent: localTextBefore
            },
            ctx.rules
          )) {
            const localText = normalizeObsidianMath(localTextBefore, ctx.rules);
            const repaired = localText !== localTextBefore;
            if (repaired)
              await writeLocalBytes(ctx.app, entry.relPath, encodeText(localText));
            const stat2 = localStat(ctx.app, entry.relPath);
            state.docRecords[entry.relPath] = {
              documentId,
              nodeToken: entry.nodeToken ?? record?.nodeToken,
              parentNodeToken: record?.parentNodeToken,
              documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
              baseLocalHash: await ctx.hashText(localText),
              baseRemoteHash: remoteHash,
              publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
              remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
              localSize: stat2.size,
              localMtime: stat2.mtime,
              lastSyncedAt: Date.now()
            };
            delete state.conflicts[entry.relPath];
            reports.push({
              relPath: entry.relPath,
              action: repaired ? "pull" : "link",
              ok: true,
              message: repaired ? "\u5DF2\u4FEE\u590D Obsidian \u516C\u5F0F\u5B9A\u754C\u7B26\u5185\u4FA7\u7A7A\u767D\u6216\u8F6C\u4E49\uFF0C\u4FDD\u7559\u672C\u5730\u6BB5\u843D\u6392\u7248" : "\u8FDC\u7AEF\u5DEE\u5F02\u53EA\u662F\u6392\u7248\u5F52\u4E00\u5316\uFF0C\u672C\u5730\u672A\u6539\u52A8"
            });
            tick(`${repaired ? "\u4FEE\u590D\u516C\u5F0F" : "\u8DF3\u8FC7"} ${entry.relPath}`);
            return;
          }
          if (entry.action === "create-local" && present) {
            const currentText = await readLocalText(ctx.app, entry.relPath);
            if (currentText !== pulled) {
              const copyPath = await writeConflictCopy(
                entry.relPath,
                fetched,
                await ctx.hashText(currentText),
                remoteHash
              );
              reports.push({
                relPath: entry.relPath,
                action: "conflict",
                ok: true,
                message: "\u672C\u5730\u5728\u8BA1\u5212\u751F\u6210\u540E\u51FA\u73B0\u4E86\u540C\u540D\u6587\u4EF6\u4E14\u5185\u5BB9\u4E0D\u540C\uFF0C\u5DF2\u4FDD\u7559\u53CC\u65B9",
                copyPath
              });
              tick(`\u51B2\u7A81 ${entry.relPath}`);
              return;
            }
          }
          await writeLocalBytes(ctx.app, entry.relPath, encodeText(pulled));
          const stat = localStat(ctx.app, entry.relPath);
          state.docRecords[entry.relPath] = {
            documentId,
            nodeToken: entry.nodeToken ?? record?.nodeToken,
            parentNodeToken: record?.parentNodeToken,
            documentTitle: record?.documentTitle ?? documentTitleFor(entry.relPath, settings),
            baseLocalHash: await ctx.hashText(pulled),
            baseRemoteHash: remoteHash,
            publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
            remoteModifiedTime: entry.remoteModifiedTime ?? record?.remoteModifiedTime,
            localSize: stat.size,
            localMtime: stat.mtime,
            lastSyncedAt: Date.now()
          };
          delete state.conflicts[entry.relPath];
          reports.push({
            relPath: entry.relPath,
            action: entry.action,
            ok: true,
            message: imageWarnings.length > 0 ? imageWarnings.join("\uFF1B") : void 0
          });
          tick(`\u4E0B\u8F7D ${entry.relPath}`);
        } catch (error) {
          ctx.logger.error(`\u4E0B\u8F7D ${entry.relPath} \u5931\u8D25\uFF1A${describeError3(error)}`);
          reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError3(error) });
          tick(`\u4E0B\u8F7D\u5931\u8D25 ${entry.relPath}`);
        }
      });
    }
  }
  for (const entry of links) {
    steps.push(async () => {
      try {
        const statBefore = localStat(ctx.app, entry.relPath);
        const localText = await readLocalText(ctx.app, entry.relPath);
        const statAfter = localStat(ctx.app, entry.relPath);
        const stable = statAfter.size === statBefore.size && statAfter.mtime === statBefore.mtime;
        const existing = state.docRecords[entry.relPath];
        const documentId = entry.documentId ?? existing?.documentId ?? "";
        state.docRecords[entry.relPath] = {
          documentId,
          nodeToken: entry.nodeToken ?? existing?.nodeToken,
          parentNodeToken: existing?.parentNodeToken,
          documentTitle: existing?.documentTitle ?? documentTitleFor(entry.relPath, settings),
          baseLocalHash: entry.localHash ?? await ctx.hashText(localText),
          baseRemoteHash: entry.remoteHash ?? existing?.baseRemoteHash ?? "",
          publishRulesFingerprint: publishRulesFingerprint(ctx.rules),
          remoteModifiedTime: entry.remoteModifiedTime ?? existing?.remoteModifiedTime,
          localSize: stable ? statAfter.size : -1,
          localMtime: stable ? statAfter.mtime : -1,
          lastSyncedAt: Date.now()
        };
        delete state.conflicts[entry.relPath];
        reports.push({ relPath: entry.relPath, action: entry.action, ok: true, message: entry.reason });
        tick(`\u5EFA\u7ACB\u6620\u5C04 ${entry.relPath}`);
      } catch (error) {
        reports.push({ relPath: entry.relPath, action: entry.action, ok: false, message: describeError3(error) });
        tick(`\u5EFA\u7ACB\u6620\u5C04\u5931\u8D25 ${entry.relPath}`);
      }
    });
  }
  for (const entry of conflicts) {
    steps.push(async () => {
      const record = state.docRecords[entry.relPath];
      const documentId = entry.documentId ?? record?.documentId;
      const previous = state.conflicts[entry.relPath];
      if (entry.duplicateConflict && previous) {
        reports.push({
          relPath: entry.relPath,
          action: "conflict",
          ok: true,
          message: "\u4ECD\u662F\u4E0A\u6B21\u672A\u5904\u7406\u7684\u51B2\u7A81\uFF0C\u672A\u91CD\u590D\u751F\u6210\u526F\u672C",
          copyPath: previous.copyPath
        });
        tick(`\u51B2\u7A81 ${entry.relPath}`);
        return;
      }
      if (!documentId) {
        reports.push({ relPath: entry.relPath, action: "conflict", ok: false, message: "\u7F3A\u5C11\u8FDC\u7AEF document_id\uFF0C\u65E0\u6CD5\u53D6\u51FA\u51B2\u7A81\u7248\u672C" });
        tick(`\u51B2\u7A81 ${entry.relPath}`);
        return;
      }
      try {
        const fetched = await fetchedFor(documentId);
        const remoteHash = await ctx.hashText(fetched);
        const present = existsLocally2(ctx.app, entry.relPath);
        const localText = present ? await readLocalText(ctx.app, entry.relPath) : "";
        const localHash = present ? await ctx.hashText(localText) : "";
        if (previous && previous.remoteHash === remoteHash && previous.localHash === localHash) {
          reports.push({
            relPath: entry.relPath,
            action: "conflict",
            ok: true,
            message: "\u4ECD\u662F\u4E0A\u6B21\u672A\u5904\u7406\u7684\u51B2\u7A81\uFF0C\u672A\u91CD\u590D\u751F\u6210\u526F\u672C",
            copyPath: previous.copyPath
          });
          tick(`\u51B2\u7A81 ${entry.relPath}`);
          return;
        }
        const copyPath = await writeConflictCopy(entry.relPath, fetched, localHash, remoteHash);
        if (record)
          record.conflict = true;
        reports.push({
          relPath: entry.relPath,
          action: "conflict",
          ok: true,
          message: "\u8FDC\u7AEF\u7248\u672C\u5DF2\u53E6\u5B58\u4E3A\u526F\u672C\uFF0C\u672C\u5730\u4E0E\u8FDC\u7AEF\u90FD\u672A\u6539\u52A8",
          copyPath
        });
        ctx.logger.warn(`\u51B2\u7A81\uFF1A${entry.relPath} -> ${copyPath}`);
        tick(`\u51B2\u7A81 ${entry.relPath}`);
      } catch (error) {
        reports.push({ relPath: entry.relPath, action: "conflict", ok: false, message: describeError3(error) });
        tick(`\u51B2\u7A81\u5904\u7406\u5931\u8D25 ${entry.relPath}`);
      }
    });
  }
  for (const step of steps) {
    await step();
  }
  if (options.allowPush) {
    for (const entry of remoteDeletes) {
      const record = state.docRecords[entry.relPath];
      const documentId = entry.documentId ?? record?.documentId;
      const title = entry.remoteTitle ?? record?.documentTitle ?? entry.relPath;
      if (!documentId) {
        reports.push({ relPath: entry.relPath, action: "delete-remote", ok: false, message: "\u7F3A\u5C11\u8FDC\u7AEF document_id\uFF0C\u672A\u5220\u9664" });
        tick(`\u8DF3\u8FC7\u5220\u9664 ${entry.relPath}`);
        continue;
      }
      try {
        await deleteDriveFile(ctx.client, documentId, "docx");
        delete state.docRecords[entry.relPath];
        delete state.conflicts[entry.relPath];
        ctx.logger.info(`\u5DF2\u5220\u9664\u8FDC\u7AEF\u6587\u6863 ${title}\uFF08${documentId}\uFF09\uFF0C\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\u53EF\u6062\u590D`);
        reports.push({
          relPath: entry.relPath,
          action: "delete-remote",
          ok: true,
          message: `\u5DF2\u5220\u9664\u8FDC\u7AEF\u6587\u6863\u300C${title}\u300D\uFF08\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\uFF0C\u53EF\u6062\u590D\uFF09`
        });
        tick(`\u5220\u9664\u8FDC\u7AEF ${entry.relPath}`);
      } catch (error) {
        ctx.logger.error(`\u5220\u9664\u8FDC\u7AEF ${entry.relPath} \u5931\u8D25\uFF1A${describeError3(error)}`);
        reports.push({ relPath: entry.relPath, action: "delete-remote", ok: false, message: describeError3(error) });
        tick(`\u5220\u9664\u8FDC\u7AEF\u5931\u8D25 ${entry.relPath}`);
      }
    }
  }
  if (options.allowPull) {
    for (const entry of localDeletes) {
      try {
        const file = existsLocally2(ctx.app, entry.relPath) ? ctx.app.vault.getAbstractFileByPath(entry.relPath) : null;
        if (file) {
          await ctx.app.vault.trash(file, false);
        }
        delete state.docRecords[entry.relPath];
        delete state.conflicts[entry.relPath];
        reports.push({
          relPath: entry.relPath,
          action: "delete-local",
          ok: true,
          message: file ? "\u8FDC\u7AEF\u5DF2\u5220\u9664\uFF0C\u672C\u5730\u7B14\u8BB0\u5DF2\u79FB\u5165 .trash" : "\u8FDC\u7AEF\u5DF2\u5220\u9664\uFF0C\u672C\u5730\u6587\u4EF6\u5DF2\u4E0D\u5B58\u5728\uFF0C\u53EA\u6E05\u7406\u4E86\u6620\u5C04"
        });
        tick(`\u5220\u9664\u672C\u5730 ${entry.relPath}`);
      } catch (error) {
        ctx.logger.error(`\u5220\u9664\u672C\u5730 ${entry.relPath} \u5931\u8D25\uFF1A${describeError3(error)}`);
        reports.push({ relPath: entry.relPath, action: "delete-local", ok: false, message: describeError3(error) });
        tick(`\u5220\u9664\u672C\u5730\u5931\u8D25 ${entry.relPath}`);
      }
    }
  }
  for (const entry of observed) {
    if (entry.action === "forget") {
      delete state.docRecords[entry.relPath];
      delete state.conflicts[entry.relPath];
    }
    reports.push({ relPath: entry.relPath, action: entry.action, ok: true, message: entry.reason });
  }
  state.lastSyncAt = Date.now();
  for (const entry of plan.items) {
    const record = state.docRecords[entry.relPath];
    if (entry.action === "skip" && record && entry.remoteModifiedTime && entry.remoteHash === record.baseRemoteHash) {
      record.remoteModifiedTime = entry.remoteModifiedTime;
    }
  }
  return reports;
}
var REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
var IMAGE_MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/webp": ".webp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg"
};
async function finalizeDocumentImages(ctx, options) {
  const result = { uploaded: 0, reused: 0, failures: [], cleaned: 0 };
  if (options.uploads.length === 0)
    return result;
  const byMarker = correlateImageBlocks(options.newBlocks, options.uploads.map((upload) => upload.marker));
  const failedBlocks = [];
  for (const upload of options.uploads) {
    const blockId = byMarker.get(upload.marker);
    if (!blockId) {
      result.failures.push(`${upload.fileName}\uFF1A\u670D\u52A1\u7AEF\u6CA1\u6709\u8FD4\u56DE\u5BF9\u5E94\u7684\u56FE\u7247\u5360\u4F4D\u5757`);
      continue;
    }
    try {
      const bytes = await ctx.readBinary(upload.vaultPath);
      const hash = await ctx.hashBytes(bytes);
      const cacheKey = `${hash}:${options.documentId}`;
      const cached = ctx.state.imageUploads[cacheKey];
      if (cached?.fileToken) {
        try {
          await bindDocImages(ctx.client, options.documentId, [{ blockId, fileToken: cached.fileToken }]);
          const bound = await getDocBlockToken(ctx.client, options.documentId, blockId);
          if (bound === cached.fileToken) {
            result.reused += 1;
            continue;
          }
          ctx.logger.warn(`\u56FE\u7247 ${upload.fileName} \u590D\u7528\u5DF2\u4E0A\u4F20\u7D20\u6750\u5931\u8D25\uFF08\u56DE\u8BFB\u5230\u7684 token \u4E0D\u4E00\u81F4\uFF09\uFF0C\u6539\u4E3A\u91CD\u65B0\u4E0A\u4F20`);
        } catch (error) {
          ctx.logger.warn(`\u56FE\u7247 ${upload.fileName} \u590D\u7528\u5DF2\u4E0A\u4F20\u7D20\u6750\u62A5\u9519\uFF0C\u6539\u4E3A\u91CD\u65B0\u4E0A\u4F20\uFF1A${describeError3(error)}`);
        }
        delete ctx.state.imageUploads[cacheKey];
      }
      const fileToken = await uploadDocImage(ctx.client, {
        documentId: options.documentId,
        blockId,
        fileName: upload.fileName,
        bytes
      });
      await bindDocImages(ctx.client, options.documentId, [{ blockId, fileToken }]);
      ctx.state.imageUploads[cacheKey] = { fileToken, documentId: options.documentId, hash, path: upload.vaultPath, at: Date.now() };
      ctx.state.images[fileToken] = { path: upload.vaultPath, token: fileToken, hash, at: Date.now() };
      result.uploaded += 1;
    } catch (error) {
      ctx.logger.error(`\u56FE\u7247 ${upload.fileName} \u4E0A\u4F20/\u7ED1\u5B9A\u5931\u8D25\uFF1A${describeError3(error)}`);
      result.failures.push(`${upload.fileName}\uFF1A${describeError3(error)}`);
      failedBlocks.push(blockId);
    }
  }
  if (failedBlocks.length > 0) {
    try {
      await deleteDocBlocks(ctx.client, options.documentId, failedBlocks, options.revisionId);
      result.cleaned = failedBlocks.length;
      ctx.logger.warn(`\u5DF2\u6E05\u7406 ${failedBlocks.length} \u4E2A\u56FE\u7247\u5360\u4F4D\u5757\uFF08\u5BF9\u5E94\u56FE\u7247\u6CA1\u4E0A\u4F20\u6210\u529F\uFF0C\u672C\u5730\u5F15\u7528\u4E0D\u53D7\u5F71\u54CD\uFF09`);
    } catch (error) {
      ctx.logger.warn(`\u6E05\u7406\u56FE\u7247\u5360\u4F4D\u5757\u5931\u8D25\uFF0C\u6587\u6863\u91CC\u53EF\u80FD\u6B8B\u7559\u5360\u4F4D\uFF1A${describeError3(error)}`);
    }
  }
  return result;
}
function buildUploadMessage(localText, images, warnings) {
  const parts = [];
  if (localText.length === 0)
    parts.push("\u7A7A\u7B14\u8BB0\u5728\u6587\u6863\u6A21\u5F0F\u4E5F\u4F1A\u540C\u6B65\uFF1A\u6B63\u6587\u4E3A\u7A7A\uFF0C\u98DE\u4E66\u4FA7\u53EA\u6709\u6807\u9898\uFF08md \u6A21\u5F0F\u4F1A\u8DF3\u8FC7\u7A7A\u6587\u4EF6\uFF09");
  if (images.uploaded > 0 || images.reused > 0)
    parts.push(`\u56FE\u7247\uFF1A\u65B0\u4E0A\u4F20 ${images.uploaded} \u5F20\u3001\u590D\u7528\u5DF2\u4E0A\u4F20 ${images.reused} \u5F20`);
  if (images.failures.length > 0) {
    parts.push(`\u56FE\u7247\u5931\u8D25 ${images.failures.length} \u5F20\uFF08\u5DF2\u6E05\u7406\u5360\u4F4D\u5757 ${images.cleaned} \u4E2A\uFF09\uFF1A${images.failures.join("\uFF1B")}`);
  }
  if (warnings.length > 0)
    parts.push(warnings.join("\uFF1B"));
  return parts.length > 0 ? parts.join(" \xB7 ") : void 0;
}
function extensionFor(contentType, url, alt) {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (IMAGE_MIME_EXT[mime])
    return IMAGE_MIME_EXT[mime];
  for (const candidate of [url, alt]) {
    const match = /\.(png|jpe?g|gif|bmp|webp|tiff?|svg)(?:[?#]|$)/i.exec(candidate);
    if (match)
      return `.${match[1].toLowerCase().replace(/^jpeg$/, "jpg")}`;
  }
  return ".png";
}
function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength)
    return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index])
      return false;
  }
  return true;
}
function attachmentName(token, alt, ext) {
  const altName = alt.trim();
  if (altName && !altName.includes("/") && /\.(png|jpe?g|gif|bmp|webp|tiff?|svg)$/i.test(altName))
    return altName;
  return `image-${token.slice(-8)}${ext}`;
}
function withSuffix(name, index) {
  const match = /^(.*?)(\.[^.]*)?$/.exec(name);
  const stem = match?.[1] ?? name;
  const suffix = match?.[2] ?? "";
  return `${stem}-${index}${suffix}`;
}
async function resolveAttachmentPath(ctx, folder, name, bytes) {
  const join = (fileName) => folder ? `${folder}/${fileName}` : fileName;
  const primary = join(name);
  if (!existsLocally2(ctx.app, primary))
    return primary;
  try {
    if (bytesEqual(await ctx.readBinary(primary), bytes))
      return primary;
  } catch (error) {
    ctx.logger.warn(`\u8BFB\u53D6\u5DF2\u6709\u9644\u4EF6 ${primary} \u5931\u8D25\uFF0C\u6309\u65B0\u6587\u4EF6\u5904\u7406\uFF1A${describeError3(error)}`);
  }
  for (let index = 1; index < 100; index += 1) {
    const candidate = join(withSuffix(name, index));
    if (!existsLocally2(ctx.app, candidate))
      return candidate;
  }
  return void 0;
}
function knownImagePath(ctx, hash) {
  for (const record of Object.values(ctx.state.images)) {
    if (record.hash === hash && record.path && existsLocally2(ctx.app, record.path))
      return record.path;
  }
  for (const record of Object.values(ctx.state.imageUploads)) {
    if (record.hash === hash && record.path && existsLocally2(ctx.app, record.path))
      return record.path;
  }
  return void 0;
}
async function downloadRemoteImage(ctx, options) {
  try {
    const downloaded = await downloadDocMedia(ctx.client, options.token);
    if (downloaded.bytes.byteLength > REMOTE_IMAGE_MAX_BYTES) {
      options.warnings.push(`\u7D20\u6750 ${options.token} \u8D85\u8FC7 20MB\uFF0C\u5DF2\u8DF3\u8FC7\uFF08\u5F15\u7528\u4FDD\u6301\u539F\u6837\uFF09`);
      return void 0;
    }
    const hash = await ctx.hashBytes(downloaded.bytes);
    const known = knownImagePath(ctx, hash);
    if (known) {
      ctx.state.images[options.token] = { path: known, token: options.token, hash, at: Date.now() };
      ctx.logger.debug(`\u8FDC\u7AEF\u56FE\u7247 ${options.token} \u4E0E\u672C\u5730\u5DF2\u6709\u6587\u4EF6\u5185\u5BB9\u4E00\u81F4\uFF0C\u590D\u7528 ${known}`);
      return known;
    }
    const folder = ctx.settings.attachmentFolder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const ext = extensionFor(downloaded.contentType, options.url, options.alt);
    const name = attachmentName(options.token, options.alt, ext);
    const path = await resolveAttachmentPath(ctx, folder, name, downloaded.bytes);
    if (!path) {
      options.warnings.push(`\u9644\u4EF6 ${name} \u540C\u540D\u6587\u4EF6\u8FC7\u591A\uFF0C\u672A\u843D\u76D8\uFF08\u5F15\u7528\u4FDD\u6301\u539F\u6837\uFF09`);
      return void 0;
    }
    if (!existsLocally2(ctx.app, path))
      await writeLocalBytes(ctx.app, path, downloaded.bytes);
    ctx.state.images[options.token] = { path, token: options.token, hash, at: Date.now() };
    ctx.logger.info(`\u5DF2\u4E0B\u8F7D\u8FDC\u7AEF\u56FE\u7247 ${options.token} \u2192 ${path}`);
    return path;
  } catch (error) {
    ctx.logger.warn(`\u4E0B\u8F7D\u7D20\u6750 ${options.token} \u5931\u8D25\uFF1A${describeError3(error)}`);
    options.warnings.push(`\u7B2C ${options.token} \u5F20\u56FE\u4E0B\u8F7D\u5931\u8D25\uFF08${describeError3(error)}\uFF09\uFF0C\u5F15\u7528\u4FDD\u6301\u539F\u6837`);
    return void 0;
  }
}
async function prepareRemoteImages(ctx, fetched, options) {
  const map = /* @__PURE__ */ new Map();
  if (!ruleEnabled(ctx.rules, "toObsidian", "image-download"))
    return map;
  const refs = collectRemoteImages(fetched);
  if (refs.length === 0)
    return map;
  let blocks;
  if (refs.some((ref) => !ref.token)) {
    try {
      const listed = await listDocImageBlocks(ctx.client, options.documentId);
      if (listed.length === refs.length) {
        blocks = listed;
      } else {
        options.warnings.push(
          `\u53D6\u56DE\u5185\u5BB9\u91CC\u6709 ${refs.length} \u5F20\u56FE\uFF0C\u4F46\u6587\u6863\u91CC\u8BFB\u5230 ${listed.length} \u4E2A\u56FE\u7247\u5757\uFF0C\u6570\u91CF\u4E0D\u4E00\u81F4\uFF0C\u672A\u6309\u987A\u5E8F\u5339\u914D\uFF08\u8FD9\u4E9B\u56FE\u7247\u4FDD\u6301\u539F\u6837\uFF09`
        );
      }
    } catch (error) {
      options.warnings.push(`\u8BFB\u53D6\u6587\u6863\u56FE\u7247\u5757\u5931\u8D25\uFF0C\u65E0\u6CD5\u89E3\u6790\u56FE\u7247\u7D20\u6750\uFF1A${describeError3(error)}`);
    }
  }
  const pathByToken = /* @__PURE__ */ new Map();
  for (const ref of refs) {
    const token = ref.token ?? blocks?.[ref.index]?.fileToken;
    if (!token) {
      options.warnings.push(`\u7B2C ${ref.index + 1} \u5F20\u56FE\u62FF\u4E0D\u5230\u7D20\u6750 token\uFF0C\u5F15\u7528\u4FDD\u6301\u539F\u6837`);
      continue;
    }
    let localPath = pathByToken.get(token);
    if (!localPath) {
      const known = ctx.state.images[token];
      if (known && existsLocally2(ctx.app, known.path)) {
        localPath = known.path;
      } else {
        localPath = await downloadRemoteImage(ctx, { token, alt: ref.alt, url: ref.url, warnings: options.warnings });
      }
      if (localPath)
        pathByToken.set(token, localPath);
    }
    if (localPath)
      map.set(ref.raw, localPath);
  }
  return map;
}

// src/sync/docEngine.ts
var DocSyncEngine = class {
  constructor(deps) {
    this.deps = deps;
    this.syncing = false;
  }
  isSyncing() {
    return this.syncing;
  }
  createClient() {
    return new FeishuClient((force) => this.deps.auth.getToken(force), this.deps.logger);
  }
  async listSpaces() {
    return listSpaces(this.createClient());
  }
  async run(options) {
    if (this.syncing)
      throw new Error("\u5DF2\u6709\u540C\u6B65\u4EFB\u52A1\u5728\u6267\u884C\u4E2D");
    this.syncing = true;
    try {
      return await this.runInternal(options);
    } finally {
      this.syncing = false;
    }
  }
  async runInternal(options) {
    const settings = this.deps.getSettings();
    const logger = this.deps.logger;
    const spaceId = parseTokenFromInput(settings.spaceId);
    const rootNodeToken = parseTokenFromInput(settings.rootNodeToken) || void 0;
    if (!spaceId)
      throw new Error("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u586B\u5199\u77E5\u8BC6\u5E93 space_id");
    const client = this.createClient();
    const filter = new PathFilter(settings.excludePatterns);
    const previousTarget = settings.state.target;
    if (!previousTarget || previousTarget.spaceId !== spaceId || previousTarget.rootNodeToken !== (rootNodeToken ?? "") || previousTarget.syncMode !== "doc") {
      if (previousTarget) {
        logger.warn(
          `\u6587\u6863\u6A21\u5F0F\u7684\u540C\u6B65\u76EE\u6807\u5DF2\u53D8\u66F4\uFF08${previousTarget.spaceId}/${previousTarget.rootNodeToken || "\u9876\u5C42"}/${previousTarget.syncMode ?? "md"} \u2192 ${spaceId}/${rootNodeToken ?? "\u9876\u5C42"}/doc\uFF09\uFF0C\u5DF2\u6E05\u7A7A\u6587\u6863\u6620\u5C04\u8868\uFF0C\u672C\u8F6E\u6309"\u9996\u6B21\u5BF9\u63A5"\u91CD\u65B0\u5224\u5B9A\uFF0C\u4E0D\u4F1A\u76F4\u63A5\u8986\u76D6\u672C\u5730`
        );
        settings.state.docRecords = {};
        settings.state.conflicts = {};
      }
      settings.state.target = { spaceId, rootNodeToken: rootNodeToken ?? "", syncMode: "doc" };
    }
    try {
      const rules = await this.rules();
      if (options.preApprovedPlan) {
        if (options.preApprovedPlan.publishRulesFingerprint !== publishRulesFingerprint(rules) || options.preApprovedPlan.pullRulesFingerprint !== pullRulesFingerprint(rules)) {
          throw new Error("\u9884\u89C8\u540E\u8F6C\u6362\u89C4\u5219\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u540C\u6B65\u8BA1\u5212");
        }
        const plan2 = filterPlan2(options.preApprovedPlan, options.mode);
        return await this.execute(plan2, options, { settings, client, spaceId, rootNodeToken, filter, rules });
      }
      if (!rootNodeToken && !settings.state.folders[""]?.nodeToken) {
        const title = settings.rootPageTitle.trim() || this.deps.app.vault.getName();
        try {
          const topLevel = await listNodes(client, spaceId);
          const found = topLevel.find((node) => node.title === title && node.obj_type !== "file");
          if (found?.node_token) {
            settings.state.folders[""] = { nodeToken: found.node_token };
            logger.info(`\u8BC6\u522B\u5230\u5DF2\u6709\u7684\u77E5\u8BC6\u5E93\u9876\u5C42\u9875\u9762\u300C${title}\u300D\uFF0C\u590D\u7528\u5B83\u5B58\u653E vault \u6839\u76EE\u5F55\u4E0B\u7684\u7B14\u8BB0`);
          }
        } catch (error) {
          logger.warn(`\u67E5\u627E\u77E5\u8BC6\u5E93\u9876\u5C42\u9875\u9762\u5931\u8D25\uFF0C\u6839\u76EE\u5F55\u4E0B\u7684\u7B14\u8BB0\u53EF\u80FD\u88AB\u8BC6\u522B\u6210\u65B0\u6587\u6863\uFF1A${String(error)}`);
        }
      }
      options.onProgress?.("\u626B\u63CF\u672C\u5730\u7B14\u8BB0\u2026");
      const local = scanLocalNotes(this.deps.app, filter);
      options.onProgress?.("\u8BFB\u53D6\u98DE\u4E66\u77E5\u8BC6\u5E93\u8282\u70B9\u6811\u2026");
      const entries = await walkWikiTree(client, spaceId, rootNodeToken, {
        rootContainerNode: settings.state.folders[""]?.nodeToken,
        onProgress: (visited) => {
          if (visited % 50 === 0)
            options.onProgress?.(`\u8BFB\u53D6\u98DE\u4E66\u77E5\u8BC6\u5E93\u8282\u70B9\u6811\u2026\uFF08\u5DF2\u89C1 ${visited} \u4E2A\u8282\u70B9\uFF09`);
        }
      });
      const index = buildDocRemoteIndex({
        entries,
        state: settings.state,
        folderMode: settings.folderMode,
        flatSeparator: settings.flatSeparator,
        rootContainerNode: settings.state.folders[""]?.nodeToken,
        isExcluded: (relPath) => filter.isExcluded(relPath)
      });
      for (const warning of index.warnings)
        logger.warn(`\u6587\u6863\u6A21\u5F0F\uFF1A${warning}`);
      if (settings.folderMode === "nodes") {
        for (const [relDir, container] of index.containers) {
          const known = settings.state.folders[relDir];
          if (!known || known.nodeToken !== container.nodeToken) {
            settings.state.folders[relDir] = { nodeToken: container.nodeToken, parentNodeToken: container.parentNodeToken };
          }
        }
      }
      logger.info(
        `\u6587\u6863\u6A21\u5F0F\uFF1A\u8FDC\u7AEF\u8BC6\u522B\u5230 ${index.notes.size} \u7BC7\u6587\u6863\u3001${index.containers.size} \u4E2A\u76EE\u5F55\u8282\u70B9\uFF1B\u672C\u5730 ${local.size} \u7BC7\u7B14\u8BB0`
      );
      options.onProgress?.("\u8BFB\u53D6\u8FDC\u7AEF\u6587\u6863\u5143\u6570\u636E\u2026");
      const remoteModifiedTimes = settings.docVerifyRemoteByContent ? /* @__PURE__ */ new Map() : await this.batchDocumentModifyTimes(client, settings.state);
      if (remoteModifiedTimes.size === 0 && Object.keys(settings.state.docRecords).length > 0) {
        logger.debug("\u6587\u6863\u6A21\u5F0F\uFF1A\u6CA1\u62FF\u5230\u53EF\u7528\u7684\u8FDC\u7AEF\u4FEE\u6539\u65F6\u95F4\uFF0C\u672C\u8F6E\u9000\u56DE\u9010\u7BC7\u53D6\u56DE\u6821\u9A8C");
      }
      if (settings.docVerifyRemoteByContent) {
        logger.debug("\u6587\u6863\u6A21\u5F0F\uFF1A\u5DF2\u6253\u5F00\u300C\u6BCF\u8F6E\u53D6\u56DE\u5168\u6587\u6821\u9A8C\u300D\uFF0C\u672C\u8F6E\u5FFD\u7565\u4FEE\u6539\u65F6\u95F4\u6233");
      }
      const cache = createDocPlanCache();
      const planned = await buildDocPlan({
        state: settings.state,
        local,
        remote: index,
        settings,
        rules,
        isExcluded: (relPath) => filter.isExcluded(relPath),
        recreateRemoteIfDeleted: settings.recreateRemoteIfDeleted,
        propagateLocalDelete: settings.propagateLocalDelete,
        propagateRemoteDelete: settings.propagateRemoteDelete,
        cache,
        forcePush: options.forcePush === true,
        remoteModifiedTimes,
        verifyRemoteByContent: settings.docVerifyRemoteByContent,
        readLocal: (relPath) => readLocalText(this.deps.app, relPath),
        hashText: (text) => this.hashText(text),
        hashFetched: (text) => this.hashFetched(text),
        fetchMarkdown: (documentId) => this.fetchMarkdown(client, documentId)
      });
      logger.debug(
        `\u6587\u6863\u6A21\u5F0F\uFF1A\u672C\u8F6E fetch \u6587\u6863 ${cache.fetchCount} \u6B21\u3001\u6279\u91CF\u5143\u6570\u636E ${remoteModifiedTimes.size > 0 ? "\u547D\u4E2D" : "\u672A\u547D\u4E2D"}\uFF08${settings.docVerifyRemoteByContent ? "\u5B89\u5168\u9600\u6253\u5F00\uFF1A\u6BCF\u8F6E\u5168\u6587\u6821\u9A8C" : "\u65F6\u95F4\u6233\u5FEB\u8DEF\u5F84"}\uFF09`
      );
      const plan = filterPlan2(planned, options.mode);
      if (options.dryRun) {
        return { plan, report: [], executed: false };
      }
      return await this.execute(plan, options, { settings, client, spaceId, rootNodeToken, filter, rules, cache, index });
    } catch (error) {
      await this.deps.saveSettings();
      throw error;
    }
  }
  async rules() {
    return loadRules(this.deps.app.vault.adapter, this.deps.logger);
  }
  async hashText(text) {
    return sha256Hex(new TextEncoder().encode(text).buffer);
  }
  /** 远端基线用"取回形态 + 图片 URL 归一化"：图片 URL 里可能带会过期的签名，不归一化会天天判成远端变了。 */
  async hashFetched(text) {
    return this.hashText(normalizeRemoteImageUrls(text));
  }
  async hashBytes(bytes) {
    return sha256Hex(bytes);
  }
  /** 上行：用 Obsidian 的链接解析把 ![[x.png]] / ![](path) 还原成 vault 里的真实文件 */
  imageResolver() {
    return (linkpath, sourcePath) => {
      const cache = this.deps.app.metadataCache;
      const target = cache?.getFirstLinkpathDest?.(linkpath, sourcePath);
      if (!target)
        return void 0;
      return { path: target.path, size: target.stat?.size ?? 0 };
    };
  }
  async fetchMarkdown(client, documentId) {
    return fetchDocumentMarkdown(client, documentId);
  }
  async execute(plan, options, context) {
    let allowPush = options.mode !== "pull";
    const allowPull = options.mode !== "push";
    let planForRun = plan;
    if (options.confirm) {
      const decision = await options.confirm(plan);
      if (decision === "cancel")
        return { plan, report: [], executed: false };
      if (decision === "pull-only") {
        allowPush = false;
        planForRun = filterPlan2(plan, "pull");
      }
    }
    const cache = context.cache ?? createDocPlanCache();
    const local = scanLocalNotes(this.deps.app, context.filter);
    const containerTitles = new Set(context.index?.containerTitles ?? []);
    for (const relDir of Object.keys(context.settings.state.folders)) {
      if (relDir)
        containerTitles.add(basenameOf(relDir));
    }
    for (const relPath of local.keys()) {
      for (const segment of dirnameOf(relPath).split("/").filter(Boolean))
        containerTitles.add(segment);
    }
    const execContext = {
      app: this.deps.app,
      client: context.client,
      settings: context.settings,
      state: context.settings.state,
      logger: this.deps.logger,
      spaceId: context.spaceId,
      rootNodeToken: context.rootNodeToken,
      rules: context.rules,
      cache,
      containerTitles,
      hashText: (text) => this.hashText(text),
      hashFetched: (text) => this.hashFetched(text),
      hashBytes: (bytes) => this.hashBytes(bytes),
      resolveImage: this.imageResolver(),
      readBinary: (vaultPath) => readLocalBytes(this.deps.app, vaultPath)
    };
    try {
      const report = await executeDocPlan(planForRun, execContext, {
        allowPush,
        allowPull,
        isEditorDirty: (relPath) => this.isEditorDirty(relPath),
        onProgress: (message, done, total) => options.onProgress?.(`${message}\uFF08${done}/${total}\uFF09`)
      });
      const touched = touchedRelPaths(report);
      if (touched.size > 0)
        await this.refreshDocumentModifyTimes(context.client, context.settings.state, touched);
      return { plan: planForRun, report, executed: true };
    } finally {
      await this.deps.saveSettings();
    }
  }
  /** 批量取「最后修改时间」（Unix 秒字符串）：文档 id → 时间戳。取不到就返回空，调用方退回逐篇取回。 */
  async batchDocumentModifyTimes(client, state) {
    const tokens = Array.from(new Set(Object.values(state.docRecords).map((record) => record.documentId))).filter(Boolean);
    if (tokens.length === 0)
      return /* @__PURE__ */ new Map();
    try {
      const metas = await batchQueryMetas(client, tokens, "docx");
      const times = /* @__PURE__ */ new Map();
      for (const [token, meta] of metas) {
        if (meta.modifiedTime)
          times.set(token, meta.modifiedTime);
      }
      return times;
    } catch (error) {
      this.deps.logger.warn(`\u6279\u91CF\u8BFB\u53D6\u8FDC\u7AEF\u6587\u6863\u5143\u6570\u636E\u5931\u8D25\uFF0C\u672C\u8F6E\u9000\u56DE\u9010\u7BC7\u53D6\u56DE\u6821\u9A8C\uFF1A${String(error)}`);
      return /* @__PURE__ */ new Map();
    }
  }
  async refreshDocumentModifyTimes(client, state, relPaths) {
    const tokens = Array.from(
      new Set([...relPaths].map((relPath) => state.docRecords[relPath]?.documentId).filter((token) => Boolean(token)))
    );
    if (tokens.length === 0)
      return;
    try {
      const metas = await batchQueryMetas(client, tokens, "docx");
      for (const record of Object.values(state.docRecords)) {
        const meta = metas.get(record.documentId);
        if (meta?.modifiedTime)
          record.remoteModifiedTime = meta.modifiedTime;
      }
    } catch (error) {
      this.deps.logger.warn(`\u5237\u65B0\u8FDC\u7AEF\u6587\u6863\u4FEE\u6539\u65F6\u95F4\u5931\u8D25\uFF08\u4E0B\u4E00\u8F6E\u4F1A\u9000\u56DE\u9010\u7BC7\u53D6\u56DE\uFF09\uFF1A${String(error)}`);
    }
  }
  async isEditorDirty(relPath) {
    for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view?.file?.path !== relPath || !view.editor)
        continue;
      const value = view.editor.getValue();
      const file = this.deps.app.vault.getAbstractFileByPath(relPath);
      if (file instanceof import_obsidian10.TFile) {
        const disk = await this.deps.app.vault.cachedRead(file);
        return value !== disk;
      }
      return value.length > 0;
    }
    return false;
  }
};
function touchedRelPaths(report) {
  const touched = /* @__PURE__ */ new Set();
  for (const entry of report) {
    if (!entry.ok)
      continue;
    if (["push", "create-remote", "pull", "create-local", "link"].includes(entry.action))
      touched.add(entry.relPath);
  }
  return touched;
}
function filterPlan2(plan, mode) {
  if (mode === "both")
    return plan;
  const items = plan.items.filter((entry) => {
    if (mode === "pull")
      return entry.action !== "push" && entry.action !== "create-remote" && entry.action !== "delete-remote";
    return entry.action !== "pull" && entry.action !== "create-local" && entry.action !== "delete-local";
  });
  const counts = {};
  for (const entry of items)
    counts[entry.action] = (counts[entry.action] ?? 0) + 1;
  return { ...plan, items, counts };
}

// src/ui/auth-modal.ts
var import_obsidian11 = require("obsidian");
var AuthCodeModal = class extends import_obsidian11.Modal {
  constructor(app, authorizeUrl, onSubmit, onCancel) {
    super(app);
    this.authorizeUrl = authorizeUrl;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.value = "";
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "\u624B\u52A8\u5B8C\u6210\u98DE\u4E66\u6388\u6743" });
    contentEl.createEl("p", {
      text: "\u5982\u679C\u672C\u5730\u56DE\u8C03\u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u53EF\u4EE5\u624B\u52A8\u5B8C\u6210\u6388\u6743\uFF1A\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00\u4E0B\u9762\u7684\u94FE\u63A5\u5E76\u540C\u610F\u6388\u6743\uFF0C\u9875\u9762\u53EF\u80FD\u663E\u793A\u65E0\u6CD5\u8BBF\u95EE\uFF0C\u4F46\u5730\u5740\u680F\u91CC\u5E26\u6709 code \u53C2\u6570\uFF0C\u628A\u6574\u6761\u5730\u5740\u6216 code \u7C98\u8D34\u5230\u4E0B\u9762\u5373\u53EF\u3002"
    });
    const link = contentEl.createEl("div", { cls: "feishu-sync-path" });
    link.createEl("a", { text: this.authorizeUrl, href: this.authorizeUrl });
    new import_obsidian11.Setting(contentEl).setName("\u6388\u6743\u7801\u6216\u56DE\u8C03\u5730\u5740").setDesc("\u7C98\u8D34 code \u53C2\u6570\uFF0C\u6216\u76F4\u63A5\u7C98\u8D34\u6D4F\u89C8\u5668\u5730\u5740\u680F\u91CC\u7684\u5B8C\u6574\u56DE\u8C03\u5730\u5740").addText(
      (text) => text.onChange((value) => {
        this.value = value;
      })
    );
    new import_obsidian11.Setting(contentEl).addButton(
      (button) => button.setButtonText("\u53D6\u6D88").onClick(() => {
        this.onCancel();
        this.close();
      })
    ).addButton(
      (button) => button.setButtonText("\u63D0\u4EA4\u6388\u6743\u7801").setCta().onClick(async () => {
        const raw = this.value.trim();
        if (!raw)
          return;
        const code = extractCode(raw);
        await this.onSubmit(code);
        this.close();
      })
    );
  }
  onClose() {
    this.contentEl.empty();
  }
};
function extractCode(input) {
  const value = input.trim();
  if (!/^https?:\/\//i.test(value))
    return value;
  try {
    const url = new URL(value);
    return url.searchParams.get("code") ?? value;
  } catch {
    return value;
  }
}

// src/ui/plan-modal.ts
var import_obsidian12 = require("obsidian");

// src/ui/format-warnings.ts
function renderFormatWarnings(container, plan) {
  if (!plan.warnings?.length)
    return;
  const section = container.createEl("div", { cls: "feishu-sync-section" });
  section.createEl("h4", { text: `\u539F\u7A3F\u683C\u5F0F\u63D0\u793A\uFF08${plan.warnings.length}\uFF09` });
  for (const warning of plan.warnings.slice(0, 100)) {
    section.createEl("div", { cls: "feishu-sync-reason", text: `${warning.relPath}\uFF1A${warning.message}` });
  }
  if (plan.warnings.length > 100)
    section.createEl("div", { text: "\u4EC5\u663E\u793A\u524D 100 \u6761\u683C\u5F0F\u63D0\u793A" });
}

// src/ui/plan-modal.ts
var GROUPS = [
  { key: "push", title: "\u4F1A\u4E0A\u4F20\u5230\u98DE\u4E66", actions: ["push", "create-remote"] },
  { key: "pull", title: "\u4F1A\u62C9\u53D6\u5230\u672C\u5730", actions: ["pull", "create-local"] },
  { key: "delete-remote", title: "\u4F1A\u5220\u9664\u8FDC\u7AEF\uFF08\u8FDB\u98DE\u4E66\u56DE\u6536\u7AD9\uFF0C\u53EF\u6062\u590D\uFF09", actions: ["delete-remote"] },
  { key: "delete-local", title: "\u4F1A\u5220\u9664\u672C\u5730\u6587\u4EF6\uFF08\u79FB\u5165 .trash\uFF09", actions: ["delete-local"] },
  { key: "conflict", title: "\u51B2\u7A81\uFF08\u4FDD\u7559\u53CC\u65B9\uFF0C\u4E0D\u81EA\u52A8\u8986\u76D6\uFF09", actions: ["conflict"] },
  { key: "link", title: "\u53EA\u5EFA\u7ACB\u6620\u5C04", actions: ["link"] },
  { key: "observe", title: "\u4EC5\u63D0\u793A\uFF0C\u4E0D\u4F1A\u6539\u52A8\u4EFB\u4F55\u4E00\u8FB9", actions: ["local-deleted", "remote-deleted", "empty-local", "dirty-editor", "forget"] }
];
var PlanModal = class extends import_obsidian12.Modal {
  constructor(app, plan, resolve) {
    super(app);
    this.plan = plan;
    this.resolve = resolve;
    this.decided = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "\u98DE\u4E66\u540C\u6B65\u8BA1\u5212" });
    const summary = contentEl.createEl("div", { cls: "feishu-sync-summary" });
    const counts = Object.entries(this.plan.counts).filter(([action]) => action !== "skip").map(([action, count]) => `${ACTION_LABELS[action] ?? action} ${count}`).join(" \xB7 ");
    summary.createEl("div", {
      text: `\u672C\u5730 ${this.plan.localNoteCount} \u7BC7 \xB7 \u8FDC\u7AEF ${this.plan.remoteNoteCount} \u7BC7${counts ? ` \xB7 ${counts}` : " \xB7 \u65E0\u5F85\u5904\u7406\u6539\u52A8"}`
    });
    const skipped = this.plan.counts.skip ?? 0;
    if (skipped > 0) {
      summary.createEl("div", { text: `\u5DF2\u540C\u6B65\u4E14\u65E0\u53D8\u5316\uFF1A${skipped} \u7BC7`, cls: "feishu-sync-reason" });
    }
    renderFormatWarnings(contentEl, this.plan);
    for (const group of GROUPS) {
      const items = this.plan.items.filter((entry) => group.actions.includes(entry.action));
      if (items.length === 0)
        continue;
      const section = contentEl.createEl("div", { cls: "feishu-sync-section" });
      section.createEl("h4", { text: `${group.title}\uFF08${items.length}\uFF09` });
      const list = section.createEl("div", { cls: "feishu-sync-list" });
      for (const entry of items.slice(0, 200)) {
        renderItem(list, entry);
      }
      if (items.length > 200) {
        list.createEl("div", { text: `\u2026\u8FD8\u6709 ${items.length - 200} \u9879`, cls: "feishu-sync-reason" });
      }
    }
    new import_obsidian12.Setting(contentEl).addButton(
      (button) => button.setButtonText("\u53D6\u6D88").onClick(() => {
        this.decide("cancel");
        this.close();
      })
    ).addButton(
      (button) => button.setButtonText("\u4EC5\u62C9\u53D6\uFF08\u4E0D\u63A8\u9001\uFF09").onClick(() => {
        this.decide("pull-only");
        this.close();
      })
    ).addButton(
      (button) => button.setButtonText("\u6267\u884C\u5168\u90E8").setCta().onClick(() => {
        this.decide("all");
        this.close();
      })
    );
  }
  onClose() {
    this.contentEl.empty();
    this.decide("cancel");
  }
  decide(decision) {
    if (this.decided)
      return;
    this.decided = true;
    this.resolve(decision);
  }
};
function renderItem(container, entry) {
  const row = container.createEl("div", { cls: "feishu-sync-plan-item" });
  const badge = row.createEl("span", { cls: `feishu-sync-badge is-${badgeClass(entry.action)}`, text: ACTION_LABELS[entry.action] ?? entry.action });
  badge.setAttr("title", entry.action);
  row.createEl("span", { cls: "feishu-sync-path", text: entry.relPath });
  if (entry.reason) {
    row.createEl("span", { cls: "feishu-sync-reason", text: entry.reason });
  }
}
function badgeClass(action) {
  if (action === "push" || action === "create-remote")
    return "push";
  if (action === "pull" || action === "create-local")
    return "pull";
  if (action === "conflict")
    return "conflict";
  if (action === "delete-remote" || action === "delete-local")
    return "delete";
  return "other";
}

// src/ui/report-modal.ts
var import_obsidian13 = require("obsidian");
var ReportModal = class extends import_obsidian13.Modal {
  constructor(app, plan, report, executed) {
    super(app);
    this.plan = plan;
    this.report = report;
    this.executed = executed;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.executed ? "\u98DE\u4E66\u540C\u6B65\u7ED3\u679C" : "\u98DE\u4E66\u540C\u6B65\u8BA1\u5212\uFF08\u672A\u6267\u884C\uFF09" });
    const failed = this.report.filter((entry) => !entry.ok);
    const conflicts = this.report.filter((entry) => entry.action === "conflict");
    const changed = this.report.filter((entry) => entry.ok && isChange(entry.action));
    const summary = contentEl.createEl("div", { cls: "feishu-sync-summary" });
    summary.createEl("div", { text: `\u53D8\u66F4 ${changed.length} \u9879 \xB7 \u51B2\u7A81 ${conflicts.length} \u9879 \xB7 \u5931\u8D25 ${failed.length} \u9879` });
    const planCounts = Object.entries(this.plan.counts).filter(([action, count]) => action !== "skip" && count > 0).map(([action, count]) => `${ACTION_LABELS[action] ?? action} ${count}`).join(" \xB7 ");
    if (planCounts) {
      summary.createEl("div", { cls: "feishu-sync-reason", text: `\u672C\u6B21\u8BA1\u5212\uFF1A${planCounts}` });
    }
    renderFormatWarnings(contentEl, this.plan);
    renderSection(contentEl, "\u51B2\u7A81\u526F\u672C\uFF08\u672C\u5730\u4E0E\u8FDC\u7AEF\u5747\u672A\u6539\u52A8\uFF0C\u526F\u672C\u5728 .obsidian/feishu-sync/conflicts/\uFF09", conflicts, true);
    renderSection(contentEl, "\u5DF2\u6267\u884C", changed, false);
    renderSection(contentEl, "\u9700\u8981\u6CE8\u610F\uFF08\u672A\u81EA\u52A8\u5904\u7406\uFF09", this.report.filter((entry) => !isChange(entry.action) && entry.action !== "conflict"), false);
    renderSection(contentEl, "\u5931\u8D25", failed, false);
    new import_obsidian13.Setting(contentEl).addButton((button) => button.setButtonText("\u5173\u95ED").setCta().onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
};
function isChange(action) {
  return ["push", "create-remote", "pull", "create-local", "link", "delete-remote", "delete-local"].includes(action);
}
function renderSection(container, title, entries, isConflict) {
  if (entries.length === 0)
    return;
  const section = container.createEl("div", { cls: "feishu-sync-section" });
  section.createEl("h4", { text: `${title}\uFF08${entries.length}\uFF09` });
  const list = section.createEl("div", { cls: "feishu-sync-list" });
  for (const entry of entries.slice(0, 300)) {
    const row = list.createEl("div", { cls: "feishu-sync-plan-item" });
    const badge = row.createEl("span", {
      cls: `feishu-sync-badge is-${isConflict ? "conflict" : entry.ok ? "push" : "conflict"}`,
      text: entry.ok ? ACTION_LABELS[entry.action] ?? entry.action : "\u5931\u8D25"
    });
    badge.setAttr("title", entry.action);
    row.createEl("span", { cls: "feishu-sync-path", text: entry.relPath });
    if (entry.copyPath)
      row.createEl("span", { cls: "feishu-sync-reason", text: `\u526F\u672C\uFF1A${entry.copyPath}` });
    if (entry.message)
      row.createEl("span", { cls: "feishu-sync-reason", text: entry.message });
  }
  if (entries.length > 300) {
    list.createEl("div", { text: `\u2026\u8FD8\u6709 ${entries.length - 300} \u9879`, cls: "feishu-sync-reason" });
  }
}

// src/ui/roundtrip-command.ts
var import_obsidian14 = require("obsidian");
var NotePickerModal = class extends import_obsidian14.FuzzySuggestModal {
  constructor(app, files, resolve) {
    super(app);
    this.files = files;
    this.resolve = resolve;
    this.chosen = false;
    this.setPlaceholder("\u6CA1\u6709\u6253\u5F00\u7684\u7B14\u8BB0\uFF0C\u9009\u62E9\u4E00\u7BC7\u7528\u6765\u505A\u5F80\u8FD4\u6D4B\u8BD5");
  }
  getItems() {
    return this.files;
  }
  getItemText(file) {
    return file.path;
  }
  onChooseItem(file) {
    this.pick(file);
  }
  onClose() {
    this.pick(void 0);
  }
  pick(file) {
    if (this.chosen)
      return;
    this.chosen = true;
    this.resolve(file);
  }
};
function setNoticeMessage(notice, message) {
  const candidate = notice;
  if (typeof candidate.setMessage === "function")
    candidate.setMessage(message);
}
function pickNote(app) {
  const active = app.workspace.getActiveFile();
  if (active)
    return Promise.resolve(active);
  const files = app.vault.getMarkdownFiles();
  if (files.length === 0)
    return Promise.resolve(void 0);
  return new Promise((resolve) => new NotePickerModal(app, files, resolve).open());
}
async function writeReport(app, content) {
  const path = (0, import_obsidian14.normalizePath)(ROUNDTRIP_REPORT_PATH);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof import_obsidian14.TFile) {
    await app.vault.modify(existing, content);
    return;
  }
  await app.vault.create(path, content);
}
async function runRoundtripProbe(host) {
  const settings = host.getSettings();
  if (!settings.appId || !settings.appSecret) {
    new import_obsidian14.Notice("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u586B\u5199\u98DE\u4E66\u5E94\u7528\u7684 App ID \u4E0E App Secret");
    return;
  }
  const spaceId = parseTokenFromInput(settings.spaceId);
  if (!spaceId) {
    new import_obsidian14.Notice("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u9009\u62E9\u77E5\u8BC6\u7A7A\u95F4\uFF08space_id\uFF09");
    return;
  }
  const file = await pickNote(host.app);
  if (!file) {
    new import_obsidian14.Notice("\u5F80\u8FD4\u6D4B\u8BD5\u5DF2\u53D6\u6D88\uFF1A\u6CA1\u6709\u53EF\u7528\u4F5C\u6837\u672C\u7684\u7B14\u8BB0");
    return;
  }
  const noteText = await host.app.vault.read(file);
  const localContent = appendSyntaxSample(noteText);
  const startedAt = /* @__PURE__ */ new Date();
  const stamp = formatTimestamp(startedAt);
  const documentTitle = `\u540C\u6B65\u5F80\u8FD4\u6D4B\u8BD5 ${stamp}`;
  const containerTitle = `\u540C\u6B65\u5F80\u8FD4\u6D4B\u8BD5 ${stamp}\uFF08\u5BB9\u5668\u9875\u9762\uFF09`;
  const client = new FeishuClient((force) => host.auth.getToken(force), host.logger);
  const notice = new import_obsidian14.Notice("Markdown \u5F80\u8FD4\u6D4B\u8BD5\uFF1A\u51C6\u5907\u4E2D\u2026", 0);
  const progress = (message) => {
    host.logger.info(`\u5F80\u8FD4\u6D4B\u8BD5\uFF1A${message}`);
    setNoticeMessage(notice, `Markdown \u5F80\u8FD4\u6D4B\u8BD5\uFF1A${message}`);
  };
  host.logger.info(`\u5F80\u8FD4\u6D4B\u8BD5\u5F00\u59CB\uFF1A\u6837\u672C ${file.path}\uFF08${localContent.length} \u5B57\u7B26\uFF09\uFF0C\u7A7A\u95F4 ${spaceId}`);
  try {
    progress(`\u521B\u5EFA\u77E5\u8BC6\u7A7A\u95F4\u9876\u5C42\u9875\u9762\u300C${containerTitle}\u300D\u2026`);
    const container = await createContainerNode(client, spaceId, void 0, containerTitle);
    const created = await createDocumentFromMarkdown(client, {
      title: documentTitle,
      markdown: localContent,
      onProgress: progress
    });
    host.logger.info(`\u5F80\u8FD4\u6D4B\u8BD5\uFF1A\u6587\u6863 document_id=${created.documentId}${created.url ? ` url=${created.url}` : ""}`);
    progress("\u628A\u6587\u6863\u79FB\u5230\u6D4B\u8BD5\u9875\u9762\u4E0B\u2026");
    await moveDocToWiki(client, spaceId, container.node_token, created.documentId, "docx");
    let wikiNodeToken;
    try {
      const node = await getNodeByToken(client, created.documentId, "docx");
      wikiNodeToken = node?.node_token;
    } catch (error) {
      host.logger.warn(`\u5F80\u8FD4\u6D4B\u8BD5\uFF1A\u79FB\u52A8\u540E\u67E5\u8BE2\u77E5\u8BC6\u5E93\u8282\u70B9\u5931\u8D25\uFF0C\u62A5\u544A\u91CC\u53EA\u5199\u6807\u9898\uFF1A${describeError(error)}`);
    }
    progress("\u7B2C\u4E00\u6B21\u53D6\u56DE\uFF08fetch\uFF09\u2026");
    const firstFetch = await fetchDocumentMarkdown(client, created.documentId);
    progress("\u7528\u540C\u4E00\u4EFD\u5185\u5BB9\u518D\u66F4\u65B0\u4E00\u6B21\uFF08overwrite\uFF09\u2026");
    await updateDocumentFromMarkdown(client, created.documentId, { title: documentTitle, markdown: localContent });
    progress("\u7B2C\u4E8C\u6B21\u53D6\u56DE\uFF08fetch\uFF09\u2026");
    const secondFetch = await fetchDocumentMarkdown(client, created.documentId);
    const report = await renderRoundtripReport({
      notePath: file.path,
      noteText,
      documentTitle,
      spaceId,
      containerTitle,
      containerNodeToken: container.node_token,
      documentId: created.documentId,
      documentUrl: created.url,
      wikiNodeToken,
      localContent,
      sentContent: buildMarkdownContent(documentTitle, localContent),
      firstFetch,
      secondFetch,
      startedAt,
      finishedAt: /* @__PURE__ */ new Date(),
      apiLog: buildApiLog({ spaceId, documentId: created.documentId, containerNodeToken: container.node_token })
    });
    await writeReport(host.app, report);
    notice.hide();
    host.logger.info(`\u5F80\u8FD4\u6D4B\u8BD5\u5B8C\u6210\uFF1A\u62A5\u544A ${ROUNDTRIP_REPORT_PATH}`);
    new import_obsidian14.Notice(`\u5F80\u8FD4\u6D4B\u8BD5\u62A5\u544A\u5DF2\u5199\u5165 ${ROUNDTRIP_REPORT_PATH}`, 12e3);
  } catch (error) {
    notice.hide();
    host.logger.error(`\u5F80\u8FD4\u6D4B\u8BD5\u5931\u8D25\uFF1A${describeError(error)}`);
    new import_obsidian14.Notice(`\u5F80\u8FD4\u6D4B\u8BD5\u5931\u8D25\uFF1A${describeError(error)}`, 12e3);
  } finally {
    await host.logger.flush();
  }
}
function buildApiLog(input) {
  return [
    '`POST /open-apis/docs_ai/v1/documents`\uFF1Abody `format="markdown"`\u3001`content`=\u2461\uFF08\u6807\u9898\u7528 DocxXML \u7684 `<title>` \u653E\u5728\u6700\u524D\u9762\uFF09\u3001`extra_param="{\\"open_create_async\\":true}"`\uFF08\u662F\u5426\u8D70\u5F02\u6B65\u7531\u670D\u52A1\u7AEF\u51B3\u5B9A\uFF09',
    "\uFF08\u8FD4\u56DE `task_id` \u65F6\uFF09`GET /open-apis/docs_ai/v1/async_tasks/{task_id}`\uFF1A\u8F6E\u8BE2\u5230 status=succeeded\uFF0C\u4ECE `result.create_document` \u91CC\u53D6 `document.document_id`",
    `\`POST /open-apis/wiki/v2/spaces/${input.spaceId}/nodes\`\uFF1A\u5728\u7A7A\u95F4\u9876\u5C42\u5EFA\u5BB9\u5668\u9875\u9762\uFF08\`obj_type=docx\`\u3001\`node_type=origin\`\u3001\u4E0D\u5E26 \`parent_node_token\`\uFF09`,
    `\`POST /open-apis/wiki/v2/spaces/${input.spaceId}/nodes/move_docs_to_wiki\`\uFF1Abody \`obj_type=docx\`\u3001\`obj_token=${input.documentId}\`\u3001\`parent_wiki_token=${input.containerNodeToken}\`\u3001\`apply=true\``,
    `\`GET /open-apis/wiki/v2/spaces/node_by_token\`\uFF1Aquery \`token=${input.documentId}\`\u3001\`obj_type=docx\`\uFF08\u7528\u6765\u786E\u8BA4\u79FB\u52A8\u7ED3\u679C\uFF09`,
    `\`POST /open-apis/docs_ai/v1/documents/${input.documentId}/fetch\`\uFF1Abody \`format="markdown"\`\u3001\`extra_param\`=CLI \u7684\u9ED8\u8BA4\u503C\u3001\`export_option\` \u4E09\u9879\u5168 false`,
    `\`PUT /open-apis/docs_ai/v1/documents/${input.documentId}\`\uFF1Abody \`format="markdown"\`\u3001\`command="overwrite"\`\u3001\`revision_id=-1\`\u3001\`content\`=\u2461`,
    `\`POST /open-apis/docs_ai/v1/documents/${input.documentId}/fetch\`\uFF1A\u540C\u7B2C\u4E00\u6B21`
  ];
}

// src/main.ts
var CHANGE_ACTIONS = /* @__PURE__ */ new Set(["push", "create-remote", "pull", "create-local", "link", "delete-remote", "delete-local"]);
function setNoticeMessage2(notice, message) {
  const candidate = notice;
  if (typeof candidate.setMessage === "function")
    candidate.setMessage(message);
}
var FeishuWikiSyncPlugin = class extends import_obsidian15.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.statusBar = null;
    this.autoSyncHandle = null;
    this.syncInFlight = false;
  }
  /** 按设置里的同步模式选引擎，4 条命令与侧栏按钮都走这里。 */
  get engine() {
    return this.settings.syncMode === "doc" ? this.docEngine : this.mdEngine;
  }
  async onload() {
    await this.loadSettings();
    this.logger = new Logger(
      () => this.app,
      () => this.settings.debugLog
    );
    this.auth = new AuthManager(
      () => ({
        mode: this.settings.authMode,
        appId: this.settings.appId,
        appSecret: this.settings.appSecret,
        oauthScope: this.settings.oauthScope,
        redirectUri: this.settings.redirectUri
      }),
      () => this.settings.userTokens,
      async (tokens) => {
        this.settings.userTokens = tokens;
        await this.saveSettings();
      },
      this.logger
    );
    this.mdEngine = new SyncEngine({
      app: this.app,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      auth: this.auth,
      logger: this.logger
    });
    this.docEngine = new DocSyncEngine({
      app: this.app,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      auth: this.auth,
      logger: this.logger
    });
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.onClickEvent(() => void this.runSync("both"));
    this.updateStatusBar();
    this.addSettingTab(new FeishuWikiSyncSettingTab(this.app, this));
    this.addCommand({ id: "preview-plan", name: "\u9884\u89C8\u540C\u6B65\u8BA1\u5212", callback: () => void this.runSync("both", { preview: true }) });
    this.addCommand({ id: "sync-both", name: "\u53CC\u5411\u540C\u6B65", callback: () => void this.runSync("both") });
    this.addCommand({ id: "sync-pull", name: "\u4ECE\u98DE\u4E66\u62C9\u53D6\u5230\u672C\u5730", callback: () => void this.runSync("pull") });
    this.addCommand({ id: "sync-push", name: "\u628A\u672C\u5730\u63A8\u9001\u5230\u98DE\u4E66", callback: () => void this.runSync("push") });
    this.addCommand({
      id: "force-push",
      name: "\u5F3A\u5236\u91CD\u63A8\uFF08\u5FFD\u7565\u57FA\u7EBF\uFF0C\u5237\u65B0\u6240\u6709\u672C\u5730\u7B14\u8BB0\uFF09",
      callback: () => void this.runSync("push", { forcePush: true })
    });
    this.addCommand({ id: "roundtrip-probe", name: "\u6D4B\u8BD5\uFF1AMarkdown \u5F80\u8FD4\u8F6C\u6362", callback: () => void this.runRoundtrip() });
    this.addRibbonIcon("refresh-cw", "Feishu Wiki Sync\uFF1A\u53CC\u5411\u540C\u6B65", () => void this.runSync("both"));
    this.refreshAutoSync();
    this.app.workspace.onLayoutReady(() => this.updateStatusBar());
  }
  onunload() {
    if (this.autoSyncHandle !== null)
      window.clearInterval(this.autoSyncHandle);
    this.auth?.cancelAuthorization();
  }
  async loadSettings() {
    const raw = await this.loadData();
    const state = raw?.state ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...raw ?? {},
      state: {
        records: state.records ?? {},
        folders: state.folders ?? {},
        conflicts: state.conflicts ?? {},
        docRecords: state.docRecords ?? {},
        images: state.images ?? {},
        imageUploads: state.imageUploads ?? {},
        target: state.target,
        lastSyncAt: state.lastSyncAt
      }
    };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  refreshAutoSync() {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
    const minutes = this.settings.autoSyncMinutes;
    if (!minutes || minutes <= 0)
      return;
    this.autoSyncHandle = window.setInterval(() => {
      if (this.engine.isSyncing())
        return;
      if (this.settings.authMode === "user" && !this.auth.hasValidUserGrant())
        return;
      void this.runSync("both", { quiet: true });
    }, minutes * 6e4);
  }
  async startAuthorization() {
    const state = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const server = this.auth.startCallbackServer(state);
    const authorizeUrl = this.auth.buildAuthorizeUrl(state);
    openExternal(authorizeUrl);
    new import_obsidian15.Notice("\u5DF2\u6253\u5F00\u6D4F\u89C8\u5668\uFF0C\u8BF7\u5728\u98DE\u4E66\u91CC\u5B8C\u6210\u6388\u6743");
    try {
      const code = await server.waitForCode();
      await this.auth.exchangeCode(code);
      new import_obsidian15.Notice("\u98DE\u4E66\u6388\u6743\u6210\u529F");
    } catch (error) {
      server.close();
      throw error;
    }
  }
  async startManualAuthorization() {
    const state = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const authorizeUrl = this.auth.buildAuthorizeUrl(state);
    openExternal(authorizeUrl);
    await new Promise((resolve) => {
      new AuthCodeModal(
        this.app,
        authorizeUrl,
        async (codeOrUrl) => {
          try {
            await this.auth.exchangeCode(codeOrUrl);
            new import_obsidian15.Notice("\u98DE\u4E66\u6388\u6743\u6210\u529F");
          } catch (error) {
            new import_obsidian15.Notice(`\u6388\u6743\u5931\u8D25\uFF1A${describeError(error)}`, 1e4);
          }
          resolve();
        },
        () => resolve()
      ).open();
    });
  }
  async revokeAuthorization() {
    this.settings.userTokens = void 0;
    await this.saveSettings();
    new import_obsidian15.Notice("\u5DF2\u6E05\u9664\u672C\u5730\u4FDD\u5B58\u7684\u98DE\u4E66\u6388\u6743");
  }
  async runSync(mode, options = {}) {
    if (this.engine.isSyncing() || this.syncInFlight) {
      new import_obsidian15.Notice("\u98DE\u4E66\u540C\u6B65\uFF1A\u5DF2\u6709\u4EFB\u52A1\u5728\u6267\u884C\u4E2D");
      return;
    }
    if (!this.settings.appId || !this.settings.appSecret) {
      new import_obsidian15.Notice("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u586B\u5199\u98DE\u4E66\u5E94\u7528\u7684 App ID \u4E0E App Secret");
      return;
    }
    this.syncInFlight = true;
    const label = this.settings.syncMode === "doc" ? "\u98DE\u4E66\u6587\u6863\u540C\u6B65" : "\u98DE\u4E66\u6587\u4EF6\u540C\u6B65";
    const wantPreview = options.preview ?? this.settings.showPlanBeforeSync;
    const forcePush = options.forcePush === true;
    const notice = new import_obsidian15.Notice(`${label}\uFF1A\u51C6\u5907\u4E2D\u2026`, 0);
    const progress = (message) => setNoticeMessage2(notice, `${label}\uFF1A${message}`);
    try {
      if (wantPreview) {
        const preview = await this.engine.run({ mode, dryRun: true, forcePush, onProgress: progress });
        notice.hide();
        const decision = await new Promise((resolve) => new PlanModal(this.app, preview.plan, resolve).open());
        if (decision === "cancel")
          return;
        const running = new import_obsidian15.Notice(`${label}\uFF1A\u6267\u884C\u4E2D\u2026`, 0);
        const result2 = await this.engine.run({
          mode,
          preApprovedPlan: preview.plan,
          onProgress: (message) => setNoticeMessage2(running, `${label}\uFF1A${message}`),
          confirm: async () => decision
        });
        running.hide();
        new ReportModal(this.app, result2.plan, result2.report, result2.executed).open();
        return;
      }
      const result = await this.engine.run({ mode, forcePush, onProgress: progress, confirm: async () => "all" });
      notice.hide();
      const failures = result.report.filter((entry) => !entry.ok).length;
      const conflicts = result.report.filter((entry) => entry.action === "conflict").length;
      const changes = result.report.filter((entry) => entry.ok && CHANGE_ACTIONS.has(entry.action)).length;
      if (options.quiet && failures === 0 && conflicts === 0 && !result.plan.warnings?.length) {
        new import_obsidian15.Notice(`${label}\u5B8C\u6210\uFF1A${changes} \u9879\u53D8\u66F4`);
      } else {
        new ReportModal(this.app, result.plan, result.report, result.executed).open();
      }
    } catch (error) {
      notice.hide();
      this.logger.error(`\u540C\u6B65\u5931\u8D25\uFF1A${describeError(error)}`);
      new import_obsidian15.Notice(`${label}\u5931\u8D25\uFF1A${describeError(error)}`, 12e3);
    } finally {
      this.syncInFlight = false;
      await this.logger.flush();
      this.updateStatusBar();
    }
  }
  /** 只读探测：把当前笔记经 docs_ai 写成飞书文档再取回，报告写进 vault 根目录。旁路，不动同步状态。 */
  async runRoundtrip() {
    if (this.engine.isSyncing() || this.syncInFlight) {
      new import_obsidian15.Notice("\u98DE\u4E66\u540C\u6B65\uFF1A\u5DF2\u6709\u4EFB\u52A1\u5728\u6267\u884C\u4E2D\uFF0C\u8BF7\u7A0D\u540E\u518D\u8DD1\u5F80\u8FD4\u6D4B\u8BD5");
      return;
    }
    await runRoundtripProbe({
      app: this.app,
      getSettings: () => this.settings,
      auth: this.auth,
      logger: this.logger
    });
  }
  updateStatusBar() {
    if (!this.statusBar)
      return;
    const last = this.settings.state.lastSyncAt;
    const docMode = this.settings.syncMode === "doc";
    const count = Object.keys(docMode ? this.settings.state.docRecords : this.settings.state.records).length;
    const stamp = last ? new Date(last).toLocaleString(void 0, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "\u672A\u540C\u6B65";
    this.statusBar.setText(`\u98DE\u4E66${docMode ? "\u6587\u6863" : ""} ${stamp} \xB7 ${count} \u7BC7`);
    this.statusBar.setAttr("aria-label", docMode ? "\u70B9\u51FB\u6267\u884C\u6587\u6863\u6A21\u5F0F\u53CC\u5411\u540C\u6B65" : "\u70B9\u51FB\u6267\u884C\u98DE\u4E66\u53CC\u5411\u540C\u6B65");
  }
};
