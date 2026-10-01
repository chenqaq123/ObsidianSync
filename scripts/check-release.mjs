import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFile(path.join(root, file), "utf8");
const manifest = JSON.parse(await read("manifest.json"));
const pkg = JSON.parse(await read("package.json"));
const lock = JSON.parse(await read("package-lock.json"));
const versions = JSON.parse(await read("versions.json"));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
assert.match(manifest.version, semver, "插件版本必须为 x.y.z");
assert.match(manifest.minAppVersion, semver, "最低 Obsidian 版本必须为 x.y.z");
assert.equal(pkg.version, manifest.version, "package.json 版本不一致");
assert.equal(lock.version, manifest.version, "锁文件版本不一致");
assert.equal(lock.packages[""].version, manifest.version, "锁文件根包版本不一致");
assert.equal(versions[manifest.version], manifest.minAppVersion, "versions.json 缺少当前兼容版本");
assert.match(manifest.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.ok(!manifest.id.includes("obsidian"), "插件 ID 不能包含 obsidian");
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith("."), "描述须在 250 字符内并以句号结尾");
assert.equal(manifest.isDesktopOnly, true, "当前实现依赖 Node.js / Electron，必须仅限桌面");
assert.equal(pkg.license, "MIT");
assert.ok((await read("LICENSE")).includes("MIT License"), "缺少许可证");
assert.ok((await read("THIRD_PARTY_NOTICES.md")).includes("Lark Technologies"), "缺少上游许可");
assert.ok((await read("README.md")).includes("## 隐私与网络访问"), "缺少账户和联网说明");

// Optional exact tag check for publishing; never strip a leading v.
const args = process.argv.slice(2);
assert.ok(args.length <= 1, "用法：npm run check:release -- 0.1.2");
const tag = args[0] ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (tag !== undefined) assert.equal(tag, manifest.version, "Release 标签必须完全等于 manifest.version，不能加 v");
console.log(`发布元数据与许可检查通过：${manifest.id} ${manifest.version} / Obsidian >= ${manifest.minAppVersion}${tag ? ` / tag ${tag}` : ""}`);
