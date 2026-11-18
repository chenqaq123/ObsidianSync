/**
 * 真实环境检查：用插件同一套引擎代码（同一批 src 模块、esbuild 打包时把 obsidian
 * 别名到垫片），读取真实仓库的真实笔记与真实飞书知识库，生成只读的同步计划预览。
 * 默认 dry-run 不写入任何一边；--execute 才执行，且执行前会自动备份 data.json。
 *
 * 用法：npm run real:check -- "/完整路径/你的仓库" [--mode=both|pull|push] [--execute]
 */
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthManager } from "../../src/feishu/auth";
import { DocSyncEngine } from "../../src/sync/docEngine";
import { SyncEngine } from "../../src/sync/engine";
import type { Logger } from "../../src/log";
import { ACTION_LABELS, DEFAULT_SETTINGS, type PluginSettings } from "../../src/sync/types";
import { createVaultApp } from "./obsidian-shim";

// 引擎代码在 sleep/超时预算里用 window.setTimeout，Node 里直接指向全局即可
(globalThis as unknown as { window: unknown }).window = globalThis;

interface Args {
  vault: string;
  mode: "both" | "pull" | "push";
  execute: boolean;
}

function parseArgs(): Args {
  const args: Args = { vault: "", mode: "both", execute: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--execute") args.execute = true;
    else if (arg.startsWith("--mode=")) args.mode = arg.slice(7) as Args["mode"];
    else args.vault = arg;
  }
  if (!args.vault) {
    console.error('用法：npm run real:check -- "/完整路径/你的仓库" [--mode=both|pull|push] [--execute]');
    process.exit(1);
  }
  return args;
}

const logger = {
  info: (message: string) => console.log(`[INFO] ${message}`),
  warn: (message: string) => console.warn(`[WARN] ${message}`),
  error: (message: string) => console.error(`[ERROR] ${message}`),
  debug: (message: string) => console.log(`[DEBUG] ${message}`),
  flush: async () => undefined,
} as unknown as Logger;

async function main(): Promise<void> {
  const options = parseArgs();
  const vaultRoot = path.resolve(options.vault);
  const dataPath = path.join(vaultRoot, ".obsidian", "plugins", "feishu-wiki-sync", "data.json");

  const raw = JSON.parse(await readFile(dataPath, "utf8")) as Partial<PluginSettings> & { state?: Partial<PluginSettings["state"]> };
  const settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    state: { records: {}, folders: {}, conflicts: {}, docRecords: {}, images: {}, imageUploads: {}, ...raw.state },
  } as PluginSettings;

  console.log(`仓库：${vaultRoot}`);
  console.log(`模式：${settings.syncMode === "doc" ? "文档模式（docx）" : "文件镜像（md）"} · 本次${options.execute ? "【执行】" : "只读预览"}（${options.mode}）`);

  if (settings.authMode === "user") {
    const tokens = settings.userTokens;
    if (!tokens?.refreshToken) throw new Error("该仓库尚未完成用户授权，请先在 Obsidian 插件设置里授权");
    if (tokens.refreshExpiresAt <= Date.now()) throw new Error("refresh token 已过期，请在 Obsidian 插件设置里重新授权后再跑");
    const accessValid = tokens.accessExpiresAt - 120_000 > Date.now();
    console.log(accessValid ? "授权令牌仍有效，直接使用（不会写 data.json）" : "access token 已过期，将刷新令牌并写回 data.json（跑完建议重启 Obsidian 让它重读）");
  }

  // 首次写入前（令牌刷新或状态落盘）先备份 data.json
  let backedUp = false;
  let backupPath = "";
  const persist = async (): Promise<void> => {
    if (!backedUp) {
      backupPath = `${dataPath}.before-realcheck-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await copyFile(dataPath, backupPath);
      backedUp = true;
    }
    await writeFile(dataPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  };

  const auth = new AuthManager(
    () => ({
      mode: settings.authMode,
      appId: settings.appId,
      appSecret: settings.appSecret,
      oauthScope: settings.oauthScope,
      redirectUri: settings.redirectUri,
    }),
    () => settings.userTokens,
    async (tokens) => {
      settings.userTokens = tokens;
      await persist();
    },
    logger,
  );

  const app = createVaultApp(vaultRoot);
  type EngineDeps = ConstructorParameters<typeof DocSyncEngine>[0];
  const deps = {
    app,
    getSettings: () => settings,
    saveSettings: persist,
    auth,
    logger,
  } as unknown as EngineDeps;

  const engine = settings.syncMode === "doc" ? new DocSyncEngine(deps) : new SyncEngine(deps);
  const startedAt = Date.now();
  const result = await engine.run({
    mode: options.mode,
    dryRun: !options.execute,
    allowDeletes: false,
    forcePush: false,
    onProgress: (message) => console.log(`…… ${message}`),
    confirm: options.execute ? async () => "all" : undefined,
  });

  const plan = result.plan;
  console.log(`\n===== 同步计划 =====`);
  console.log(`本地 ${plan.localNoteCount} 篇 · 远端 ${plan.remoteNoteCount} 篇`);
  for (const [action, count] of Object.entries(plan.counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ACTION_LABELS[action as keyof typeof ACTION_LABELS] ?? action}：${count}`);
  }
  const interesting = plan.items.filter((item) => item.action !== "skip");
  const listed = interesting.slice(0, 80);
  for (const item of listed) {
    console.log(`  [${ACTION_LABELS[item.action] ?? item.action}] ${item.relPath}${item.reason ? ` — ${item.reason}` : ""}`);
  }
  if (interesting.length > listed.length) console.log(`  …（还有 ${interesting.length - listed.length} 项未逐条列出）`);
  if (plan.warnings?.length) {
    console.log(`警告 ${plan.warnings.length} 条：`);
    for (const warning of plan.warnings) console.log(`  ${warning.relPath}：${warning.message}`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n耗时 ${elapsed} 秒 · ${result.executed ? "已执行" : "只读预览，未写入任何一边"}`);
  if (backedUp) console.log(`data.json 在运行中有更新（令牌刷新/状态落盘），原文件备份：${backupPath}`);
}

main().catch((error) => {
  console.error(`\n真实环境检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
