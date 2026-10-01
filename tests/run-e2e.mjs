// 用 esbuild 把 tests/e2e-fake-feishu.ts 打包成 CJS（alias 把 `obsidian` 指到 tests/obsidian-stub.ts），再用 node 跑。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-e2e-build-"));
const outfile = path.join(outDir, "e2e.cjs");

fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(projectRoot, "tests", "e2e-fake-feishu.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  alias: { obsidian: path.join(projectRoot, "tests", "obsidian-stub.ts") },
  outfile,
  logLevel: "warning",
});

const result = spawnSync(process.execPath, [outfile], { stdio: "inherit", cwd: projectRoot });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
fs.rmSync(outDir, { recursive: true, force: true });
process.exitCode = result.status ?? 1;
