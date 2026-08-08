/**
 * Build the installer: one versioned archive that installs Profile Vault React
 * on any other device.
 *
 * ⚠ Why this is a ZIP and not a .exe, .msi or .crx, since that is the first
 * question anyone asks. Chrome deliberately refuses to install an extension
 * from a file. Drag-and-drop of a .crx has been blocked outside the Web Store
 * since Chrome 33, and a desktop installer cannot get round that either — the
 * browser, not the operating system, is what declines. The one supported route
 * for an extension distributed outside the store is **Load unpacked**, which
 * takes a folder. So the installer is that folder, packed for transport, with
 * the instructions inside it. Nothing here is a limitation of this project.
 *
 * What it produces, in releases/:
 *
 *   profile-vault-react-<version>.zip
 *     profile-vault-react-<version>/
 *       INSTALL.md      the instructions, next to the thing they describe
 *       extension/      a byte-for-byte copy of dist/ — the folder Chrome loads
 *   profile-vault-react-<version>.zip.sha256
 *
 * The extension is nested under `extension/` rather than being the top-level
 * folder so the instruction is unambiguous: the folder to select is the one
 * called `extension`. A recipient who picks the wrong folder gets "Manifest
 * file is missing or unreadable", which reads like a broken download.
 *
 * It packages `dist/` and nothing else. dist/ is what Chrome loads (rule 4), so
 * the archive cannot contain sources, tests, the Time Machine or node_modules —
 * not because they are filtered out, but because they were never in the folder
 * being read. `npm run package` runs `npm run check` first, so an archive can
 * only ever be cut from a tree that typechecks, builds, passes its tests and
 * validates.
 */
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZip, readZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const releasesDir = path.join(root, "releases");

const manifest = await readJson(
  path.join(distDir, "manifest.json"),
  "dist/manifest.json is missing. Run `npm run build` first — dist/ is the folder Chrome loads, and it is the only thing packaged."
);
const buildMeta = await readJson(
  path.join(distDir, "build-meta.json"),
  "dist/build-meta.json is missing, so dist/ was not produced by `npm run build`. Run it, then package."
);
if (manifest.version !== buildMeta.version) {
  throw new Error(`dist/ is inconsistent: the manifest says ${manifest.version} and build-meta.json says ${buildMeta.version}.`);
}

// Everything the manifest promises must actually be in the box. `npm run
// validate` checks far more than this and runs first, but the packager is also
// usable on its own, and shipping an archive whose declared service worker is
// absent is the one failure that cannot be diagnosed from the receiving end.
const promised = [
  "manifest.json",
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((script) => script.js || [])
].filter(Boolean);
for (const file of promised) {
  await access(path.join(distDir, file)).catch(() => {
    throw new Error(`dist/${file} is declared in the manifest but is not in dist/. Run \`npm run build\`.`);
  });
}

const slug = String(manifest.name || "extension").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const stem = `${slug}-${manifest.version}`;
const archiveName = `${stem}.zip`;

const files = (await walk(distDir)).sort();
if (files.length === 0) throw new Error("dist/ is empty. Run `npm run build`.");

const install = await readFile(path.join(root, "docs", "INSTALL.md"));

const entries = [{ name: `${stem}/INSTALL.md`, data: install }];
for (const file of files) {
  entries.push({ name: `${stem}/extension/${file}`, data: await readFile(path.join(distDir, file)) });
}

// Explicit directory entries, so an extractor that does not create parents from
// file paths still produces a loadable folder.
const directories = new Set([`${stem}/`, `${stem}/extension/`]);
for (const file of files) {
  const parts = file.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) directories.add(`${stem}/extension/${parts.slice(0, depth).join("/")}/`);
}
for (const directory of directories) entries.push({ name: directory, data: Buffer.alloc(0) });

// A directory sorts immediately before everything inside it, so one plain sort
// puts every parent ahead of its children.
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const archive = createZip(entries);

// Read back what was written, exactly as an unzipper would, before it is called
// an installer. Every CRC is checked by readZip; the comparison below is the
// stronger question — are these the same bytes Chrome was going to load?
const unpacked = new Map(readZip(archive).map((entry) => [entry.name, entry.data]));
for (const file of files) {
  const packed = unpacked.get(`${stem}/extension/${file}`);
  const original = await readFile(path.join(distDir, file));
  if (!packed || !packed.equals(original)) throw new Error(`The archive does not round-trip ${file}.`);
}
if (!unpacked.has(`${stem}/INSTALL.md`)) throw new Error("The archive carries no install instructions.");
const packedManifest = JSON.parse(unpacked.get(`${stem}/extension/manifest.json`).toString("utf8"));
if (packedManifest.version !== manifest.version) throw new Error("The packaged manifest is not the built one.");

await mkdir(releasesDir, { recursive: true });
const archivePath = path.join(releasesDir, archiveName);
const replaced = await exists(archivePath);
await writeFile(archivePath, archive);

const digest = createHash("sha256").update(archive).digest("hex");
// The `<digest>  <name>` shape `sha256sum -c` expects, so it is checkable with
// the standard tool as well as by eye.
await writeFile(path.join(releasesDir, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`);

const kilobytes = (archive.length / 1024).toFixed(0);
console.log(`Packaged ${manifest.name} ${manifest.version} — ${files.length} extension files, ${kilobytes} KB`);
console.log(`  ${path.relative(root, archivePath)}${replaced ? "  (replaced)" : ""}`);
console.log(`  ${path.relative(root, archivePath)}.sha256`);
console.log(`  sha256  ${digest}`);
console.log("");
console.log("To install on another device: copy the .zip across, unzip it, then follow INSTALL.md inside —");
console.log(`chrome://extensions -> Developer mode -> Load unpacked -> select ${stem}/extension`);

async function walk(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walk(path.join(directory, entry.name), relative)));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

async function readJson(file, absent) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(absent);
    throw error;
  }
}

async function exists(file) {
  return stat(file).then(() => true, () => false);
}
