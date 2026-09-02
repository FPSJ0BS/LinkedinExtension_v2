import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "extension");
const buildDir = path.join(root, ".build");
const distDir = path.join(root, "dist");

await rm(buildDir, { recursive: true, force: true });
await rm(distDir, { recursive: true, force: true });

// The project path is passed RELATIVE to cwd, never absolute: shell is true on
// Windows, the shell re-splits the command line on spaces, and a checkout under
// a path like "linkdin version v2" turned -p <abs> into a project plus two stray
// source files ("error TS5042: Option 'project' cannot be mixed with source
// files"). dist/ and .build/ are already deleted by the time that fires.
const tsc = spawnSync("tsc", ["-p", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
});
if (tsc.status !== 0) process.exit(tsc.status || 1);

await mkdir(distDir, { recursive: true });
// The service worker stays at dist/src/background.js so its relative ESM imports
// of ./queue-db.js, ./db.js and ./messages.js resolve at runtime.
await cp(path.join(buildDir, "src"), path.join(distDir, "src"), { recursive: true });

for (const [source, destination] of [
  ["manifest.json", "manifest.json"],
  ["pages/popup.html", "popup.html"],
  ["pages/dashboard.html", "dashboard.html"],
  ["pages/import.html", "import.html"],
  ["pages/applicants.html", "applicants.html"],
  ["pages/messages.html", "messages.html"],
  // The shared visual layer is still emitted first for all four pages.
  ["styles/theme.css", "theme.css"],
  ["styles/popup.css", "popup.css"],
  ["styles/dashboard.css", "dashboard.css"],
  ["styles/import.css", "import.css"],
  ["styles/applicants.css", "applicants.css"],
  ["styles/messages.css", "messages.css"],
  ["content-scripts/content.js", "content.js"],
  ["content-scripts/connections.js", "connections.js"],
  ["content-scripts/applicants.js", "applicants.js"]
]) {
  await cp(path.join(extensionDir, source), path.join(distDir, destination));
}
await cp(path.join(extensionDir, "icons"), path.join(distDir, "icons"), { recursive: true });
await cp(path.join(extensionDir, "vendor"), path.join(distDir, "vendor"), { recursive: true });

const buildMeta = {
  version: "3.14.0",
  buildId: "2026-08-26-react-v3.14.0",
  ui: "React + TypeScript",
  generatedAt: new Date().toISOString()
};
await writeFile(path.join(distDir, "build-meta.json"), `${JSON.stringify(buildMeta, null, 2)}\n`);

const manifest = JSON.parse(await readFile(path.join(distDir, "manifest.json"), "utf8"));
if (manifest.version !== buildMeta.version) throw new Error("Manifest and build version do not match.");
console.log(`Built Profile Vault React ${buildMeta.version} into ${distDir}`);
