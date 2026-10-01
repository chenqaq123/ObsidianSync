import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const assets = path.join(root, "dist", manifest.id);
assert.deepEqual(readdirSync(assets).sort(), ["main.js", "manifest.json", "styles.css"]);
for (const file of readdirSync(assets)) assert.deepEqual(readFileSync(path.join(assets, file)), readFileSync(path.join(root, file)));
const code = readFileSync(path.join(assets, "main.js"), "utf8");
assert.ok(!code.includes("sourceMappingURL="), "production bundle must not embed a source map");
assert.ok(!code.includes("roundtrip-probe"), "experimental command must not ship");
assert.ok(code.includes("Copyright (c) 2026 cgx") && code.includes("Copyright (c) 2026 Lark Technologies Pte. Ltd."), "licenses must survive standalone main.js downloads");
const notices = [];
class Base {}
class Notice { constructor(message) { notices.push(message); } hide() {} setMessage() {} }
const dom = { addClass() {}, onClickEvent() {}, setText() {}, setAttr() {} };
class Plugin {
  commands = [];
  app = { vault: { getName: () => "SmokeTest" }, workspace: { onLayoutReady: callback => callback() } };
  async loadData() { return null; }
  async saveData() {}
  addStatusBarItem() { return dom; }
  addCommand(command) { this.commands.push(command); }
  addSettingTab() {}
  addRibbonIcon() {}
  registerDomEvent() {}
  registerInterval(id) { return id; }
}
const hostRequire = createRequire(import.meta.url);
const exports = {};
const context = { module: { exports }, exports, console, setTimeout, clearTimeout,
  require: name => name === "obsidian" ? { Plugin, Notice, PluginSettingTab: Base, Modal: Base, FuzzySuggestModal: Base, Setting: Base } : hostRequire(name) };
vm.runInNewContext(code, context, { timeout: 2000 });
const PluginClass = context.module.exports.default;
assert.equal(typeof PluginClass, "function");
const plugin = new PluginClass();
await plugin.onload();
assert.deepEqual(plugin.commands.map(command => command.id).sort(), ["force-push", "preview-plan", "sync-both", "sync-pull", "sync-push"]);
assert.equal(plugin.settings.showPlanBeforeSync, true);
assert.equal(plugin.settings.autoSyncMinutes, 0);
assert.equal(plugin.settings.propagateLocalDelete, false);
assert.equal(plugin.settings.propagateRemoteDelete, false);
plugin.settings.appId = "synthetic";
plugin.settings.appSecret = "synthetic";
await plugin.runSync("push", { forcePush: true });
assert.ok(notices.some(message => message.includes("仅用于文档模式")));
plugin.onunload();

const vault = mkdtempSync(path.join(os.tmpdir(), "feishu-install-smoke-"));
try {
  const target = path.join(vault, ".obsidian", "plugins", manifest.id);
  mkdirSync(target, { recursive: true });
  mkdirSync(path.join(vault, ".obsidian", "feishu-sync"), { recursive: true });
  writeFileSync(path.join(target, "main.js"), "old installation");
  writeFileSync(path.join(target, "data.json"), '{"testSettings":"preserve"}');
  const rulesPath = path.join(vault, ".obsidian", "feishu-sync", "rules.json");
  writeFileSync(rulesPath, '{"testRules":"preserve"}');
  const env = { ...process.env };
  delete env.OBSIDIAN_VAULT;
  delete env.OBSIDIAN_CONFIG_DIR;
  const installer = path.join(root, "scripts", "install-to-vault.mjs");
  const missing = spawnSync(process.execPath, [installer], { encoding: "utf8", env });
  assert.notEqual(missing.status, 0, "no implicit destination allowed");
  const installed = spawnSync(process.execPath, [installer, vault], { encoding: "utf8", env });
  assert.equal(installed.status, 0, installed.stderr);
  for (const file of ["main.js", "manifest.json", "styles.css"]) assert.deepEqual(readFileSync(path.join(target, file)), readFileSync(path.join(assets, file)));
  assert.equal(readFileSync(path.join(target, "data.json"), "utf8"), '{"testSettings":"preserve"}');
  assert.equal(readFileSync(rulesPath, "utf8"), '{"testRules":"preserve"}');
  const backup = readdirSync(target).find(name => name.startsWith(".backup-"));
  assert.ok(backup);
  assert.equal(readFileSync(path.join(target, backup, "main.js"), "utf8"), "old installation");
  assert.ok(!existsSync(path.join(target, "versions.json")));
} finally {
  rmSync(vault, { recursive: true, force: true });
}
console.log("生产包加载、命令注册、默认配置、安装备份和设置保留验证通过");
