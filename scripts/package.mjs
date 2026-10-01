import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
// Store-only ZIP: fixed timestamps, no platform utility or runtime dependency.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
const checksums = [];
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const bytes = await readFile(path.join(root, "dist", manifest.id, file));
  const name = Buffer.from(`${manifest.id}/${file}`);
  const crc = crc32(bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x21, 12); // 1980-01-01
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  header.copy(directory, 6, 4, 28);
  directory.writeUInt32LE(offset, 42);
  local.push(header, name, bytes);
  central.push(directory, name);
  offset += header.length + name.length + bytes.length;
  checksums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${manifest.id}/${file}`);
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(3, 8);
end.writeUInt16LE(3, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, directory, end]);
const filename = `${manifest.id}-${manifest.version}.zip`;
await writeFile(path.join(root, "dist", filename), archive);
checksums.push(`${createHash("sha256").update(archive).digest("hex")}  ${filename}`);
await writeFile(path.join(root, "dist", "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(`已打包 dist/${filename}（仅包含插件运行必需的三个文件）`);
