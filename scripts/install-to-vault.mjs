import { promises as fs } from "fs";
import path from "path";
import os from "os";

const VAULT = process.env.OBSIDIAN_VAULT ?? path.join(os.homedir(), "Documents", "Obsidian", "MyResearchWiki");
const PLUGIN_ID = "feishu-wiki-sync";
const target = path.join(VAULT, ".obsidian", "plugins", PLUGIN_ID);
const files = ["main.js", "manifest.json", "versions.json", "styles.css"];

if (!(await fs.stat(VAULT).catch(() => null))) {
  console.error(`vault not found: ${VAULT}\nset OBSIDIAN_VAULT to override`);
  process.exit(1);
}

await fs.mkdir(target, { recursive: true });
for (const file of files) {
  if (!(await fs.stat(file).catch(() => null))) {
    console.warn(`skip missing ${file}`);
    continue;
  }
  await fs.copyFile(file, path.join(target, file));
  console.log(`installed ${file} -> ${target}`);
}
