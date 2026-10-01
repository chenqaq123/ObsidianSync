import esbuild from "esbuild";
import process from "process";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(await readFile(path.join(root, "versions.json"), "utf8"));
const notices = await Promise.all(["LICENSE", "THIRD_PARTY_NOTICES.md"].map(file => readFile(path.join(root, file), "utf8")));
if (pkg.version !== manifest.version || versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error("package.json、manifest.json 与 versions.json 的版本信息不一致");
}

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2021",
  platform: "node",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  // Keep published code readable for community review; include licenses in the
  // single file downloaded by Obsidian's installer, not only in the repository.
  minify: false,
  banner: { js: `/*!\n${notices.join("\n\n").replaceAll("*/", "* /")}\n*/` },
  metafile: true,
  outfile: "main.js",
});

if (prod) {
  try {
    const result = await context.rebuild();
    const bundledDependencies = Object.keys(result.metafile.inputs).filter(file => file.includes("node_modules/"));
    if (bundledDependencies.length) {
      throw new Error(`新增运行依赖需要审查并保留许可声明：${bundledDependencies.join(", ")}`);
    }
    const target = path.join(root, "dist", manifest.id);
    await mkdir(target, { recursive: true });
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      await copyFile(path.join(root, file), path.join(target, file));
    }
    console.log(`已构建 ${manifest.id} ${manifest.version} → dist/${manifest.id}/`);
  } finally {
    await context.dispose();
  }
} else {
  await context.watch();
}
