import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, ".build");
const distDir = path.join(root, "dist");

await rm(buildDir, { recursive: true, force: true });
await rm(distDir, { recursive: true, force: true });

const tsc = spawnSync("tsc", ["-p", path.join(root, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
});
if (tsc.status !== 0) process.exit(tsc.status || 1);

await mkdir(distDir, { recursive: true });
// The service worker stays at dist/src/background.js so its relative ESM imports
// of ./queue-db.js, ./db.js and ./messages.js resolve at runtime.
await cp(path.join(buildDir, "src"), path.join(distDir, "src"), { recursive: true });

for (const file of [
  "manifest.json",
  "popup.html",
  "dashboard.html",
  "import.html",
  "applicants.html",
  // The shared visual layer, loaded first by all four pages.
  "theme.css",
  "popup.css",
  "dashboard.css",
  "import.css",
  "applicants.css",
  "content.js",
  "connections.js",
  "applicants.js"
]) {
  await cp(path.join(root, file), path.join(distDir, file));
}
await cp(path.join(root, "icons"), path.join(distDir, "icons"), { recursive: true });
await cp(path.join(root, "vendor"), path.join(distDir, "vendor"), { recursive: true });

const buildMeta = {
  version: "3.7.8",
  buildId: "2026-08-03-react-v3.7.8",
  ui: "React + TypeScript",
  generatedAt: new Date().toISOString()
};
await writeFile(path.join(distDir, "build-meta.json"), `${JSON.stringify(buildMeta, null, 2)}\n`);

const manifest = JSON.parse(await readFile(path.join(distDir, "manifest.json"), "utf8"));
if (manifest.version !== buildMeta.version) throw new Error("Manifest and build version do not match.");
console.log(`Built Profile Vault React ${buildMeta.version} into ${distDir}`);
