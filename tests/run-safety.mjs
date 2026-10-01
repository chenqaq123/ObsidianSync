import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "feishu-safety-"));
try {
  const outfile = path.join(temp, "tests.cjs");
  await esbuild.build({
    entryPoints: [path.join(root, "tests/safety-regression.ts")],
    bundle: true, platform: "node", format: "cjs", target: "node20",
    alias: { obsidian: path.join(root, "tests/obsidian-stub.ts") },
    outfile, logLevel: "warning",
  });
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit", timeout: 60_000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
