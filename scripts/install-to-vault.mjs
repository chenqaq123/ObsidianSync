import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultInput = process.argv[2] || process.env.OBSIDIAN_VAULT;
if (!vaultInput) throw new Error('请指定仓库路径：npm run install:vault -- "/path/to/vault"');
const vault = path.resolve(vaultInput);
const configDir = process.env.OBSIDIAN_CONFIG_DIR || ".obsidian";
if (path.isAbsolute(configDir) || configDir.split(/[\\/]/).some(part => !part || part === ".." || part === ".")) {
  throw new Error("OBSIDIAN_CONFIG_DIR 必须是仓库内的相对目录");
}
if (!(await fs.stat(path.join(vault, configDir)).catch(() => null))?.isDirectory()) {
  throw new Error(`未找到 ${configDir}：请先用 Obsidian 打开此仓库，确认路径正确：${vault}`);
}
const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const files = ["main.js", "manifest.json", "styles.css"];
const source = path.join(root, "dist", manifest.id);
// Validate all required files before touching an installed plugin.
const assets = await Promise.all(files.map(file => fs.readFile(path.join(source, file))));
if (JSON.parse(assets[1].toString()).version !== manifest.version) throw new Error("构建版本不一致，请重新构建");
const target = path.join(vault, configDir, "plugins", manifest.id);
await fs.mkdir(target, { recursive: true });
const backup = path.join(target, `.backup-${Date.now()}`);
let savedBackup = false;
for (const file of files) {
  if (await fs.stat(path.join(target, file)).catch(() => null)) {
    await fs.mkdir(backup, { recursive: true });
    await fs.copyFile(path.join(target, file), path.join(backup, file));
    savedBackup = true;
  }
}
for (let index = 0; index < files.length; index++) {
  const destination = path.join(target, files[index]);
  await fs.writeFile(`${destination}.installing`, assets[index]);
  await fs.rename(`${destination}.installing`, destination);
}
console.log(`已安装 ${manifest.name} ${manifest.version}：${target}`);
if (savedBackup) console.log(`旧安装文件备份：${backup}`);
console.log("data.json 与转换规则已保留。请重启 Obsidian，再启用插件。");
