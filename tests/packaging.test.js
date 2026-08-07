/**
 * The installer.
 *
 * `npm run package` turns dist/ into one archive that installs the extension on
 * any other device. Two things can go wrong with that and neither one is
 * visible from the machine that built it: the archive can be malformed, and the
 * instructions inside it can be wrong. A recipient hits both as the same
 * symptom — "it does not install" — with no way to tell them apart.
 *
 * So the format is round-tripped here rather than trusted, and the load-bearing
 * sentences of INSTALL.md are asserted. The one about keeping the folder is not
 * documentation politeness: Chrome loads an unpacked extension from that folder
 * at every startup and derives its storage identity from the path, so a dropped
 * warning is a lost vault.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createZip, readZip } from "../scripts/zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(resolve(root, file), "utf8");

// A deterministic fill with nothing for deflate to exploit, so the "store it
// instead" branch is exercised by the same bytes on every run. A chained digest
// rather than a linear generator, whose low bits deflate can and does compress.
function incompressibleBytes(length) {
  const chunks = [];
  let block = createHash("sha256").update("profile-vault").digest();
  for (let total = 0; total < length; total += block.length) {
    chunks.push(block);
    block = createHash("sha256").update(block).digest();
  }
  return Buffer.concat(chunks, length);
}

test("an archive the packager writes can be read back the way an unzipper reads it", () => {
  const manifest = Buffer.from(JSON.stringify({ manifest_version: 3, version: "3.7.8" }), "utf8");
  const blob = incompressibleBytes(4096);
  const source = Buffer.from("globalThis.ProfileVaultCore = {};\n".repeat(200), "utf8");

  const archive = createZip([
    { name: "profile-vault-react-3.7.8/", data: Buffer.alloc(0) },
    { name: "profile-vault-react-3.7.8/INSTALL.md", data: Buffer.from("# Installing\n", "utf8") },
    { name: "profile-vault-react-3.7.8/extension/", data: Buffer.alloc(0) },
    { name: "profile-vault-react-3.7.8/extension/icons/", data: Buffer.alloc(0) },
    { name: "profile-vault-react-3.7.8/extension/icons/icon16.png", data: blob },
    { name: "profile-vault-react-3.7.8/extension/manifest.json", data: manifest },
    { name: "profile-vault-react-3.7.8/extension/src/", data: Buffer.alloc(0) },
    { name: "profile-vault-react-3.7.8/extension/src/applicants-core.js", data: source }
  ]);

  const entries = readZip(archive);
  assert.equal(entries.length, 8, "every entry, directories included");

  // Order is preserved, and every parent directory arrives before its contents —
  // which is what lets the packager get away with one plain lexicographic sort.
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort(), "a directory sorts immediately before what is inside it");
  for (const name of names) {
    if (!name.endsWith("/")) continue;
    assert.ok(names.indexOf(name) < names.findIndex((other) => other !== name && other.startsWith(name)),
      `${name} must be written before its contents`);
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assert.ok(byName.get("profile-vault-react-3.7.8/extension/manifest.json").data.equals(manifest), "bytes survive intact");
  assert.ok(byName.get("profile-vault-react-3.7.8/extension/src/applicants-core.js").data.equals(source));
  assert.ok(byName.get("profile-vault-react-3.7.8/extension/icons/icon16.png").data.equals(blob));
  assert.equal(byName.get("profile-vault-react-3.7.8/extension/").data.length, 0, "a directory entry carries no bytes");

  // Compressed where it pays, stored where it does not — an "compressed" entry
  // that grew is a bigger download for nothing.
  assert.equal(byName.get("profile-vault-react-3.7.8/extension/src/applicants-core.js").method, 8, "repetitive source deflates");
  assert.equal(byName.get("profile-vault-react-3.7.8/extension/icons/icon16.png").method, 0, "already-compressed bytes are stored");
  assert.ok(byName.get("profile-vault-react-3.7.8/extension/src/applicants-core.js").compressedSize < source.length);
});

test("a damaged archive is refused rather than half-read", () => {
  const blob = incompressibleBytes(2048);
  const archive = createZip([{ name: "blob.bin", data: blob }]);

  // The payload of a stored entry begins after its 30-byte local header and its
  // name, so this corrupts the file's contents and nothing else.
  const damaged = Buffer.from(archive);
  damaged[30 + "blob.bin".length] ^= 0xff;
  assert.throws(() => readZip(damaged), /failed its CRC check/, "a flipped byte must not pass as the file");

  assert.throws(() => readZip(Buffer.alloc(512)), /no end-of-central-directory record/, "and a non-archive is not an archive");
});

test("the packager ships dist/ and could not ship anything else", async () => {
  const source = await read("scripts/package.mjs");

  // dist/ is the folder Chrome loads (rule 4). The archive cannot contain
  // sources, tests, node_modules or the Time Machine because the packager never
  // reads anywhere else — it is not a filter that could be got wrong.
  assert.match(source, /const distDir = path\.join\(root, "dist"\)/);
  assert.match(source, /await walk\(distDir\)/, "the file list comes from dist/");
  assert.ok(!/walk\(root\)/.test(source), "the packager must never walk the repository");

  // The extension is nested so the folder to select is unambiguously named.
  assert.match(source, /\$\{stem\}\/extension\/\$\{file\}/, "dist/ is packaged under extension/");
  assert.match(source, /\$\{stem\}\/INSTALL\.md/, "and the instructions travel with it");

  // The archive is named from the built manifest, so it can never claim a
  // version that is not the one inside it.
  assert.match(source, /const stem = `\$\{slug\}-\$\{manifest\.version\}`/);
  assert.match(source, /packedManifest\.version !== manifest\.version/, "and that is verified from the packed bytes");

  // Missing or hand-assembled output is refused by name, because "run the
  // build" is the whole of the fix and guessing it wastes the user's time.
  assert.match(source, /dist\/manifest\.json is missing[\s\S]{0,120}npm run build/);
  assert.match(source, /build-meta\.json is missing[\s\S]{0,160}npm run build/);
  assert.match(source, /manifest\.version !== buildMeta\.version/, "a mismatched dist/ is not packaged");

  // Everything the manifest promises has to be in the box; an absent service
  // worker is the one failure the receiving end cannot diagnose.
  assert.match(source, /manifest\.background\?\.service_worker/);
  assert.match(source, /content_scripts \|\| \[\]\)\.flatMap/);

  // What was written is read back and compared against dist/ before it is
  // called an installer.
  assert.match(source, /readZip\(archive\)/);
  assert.match(source, /does not round-trip/);
  assert.match(source, /createHash\("sha256"\)/, "and it ships a checksum for the transfer");
});

test("an installer can only be cut from a tree that passed its checks", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.equal(manifest.scripts.package, "npm run check && node scripts/package.mjs",
    "typecheck, build, tests and validate all run before an archive is produced");

  const ignore = await read(".gitignore");
  assert.match(ignore, /^releases\/$/m, "the archives are derived output and are never committed");
});

test("the installer carries instructions that survive the trip", async () => {
  const install = await read("INSTALL.md");

  // The five steps that actually install it. Chrome has no other route for an
  // extension distributed outside the Web Store.
  assert.match(install, /chrome:\/\/extensions/);
  assert.match(install, /edge:\/\/extensions/, "and the same steps in the other Chromium browsers");
  assert.match(install, /Developer mode/);
  assert.match(install, /Load unpacked/);
  assert.match(install, /`extension` folder/, "naming the folder to select, since picking the wrong one looks like a broken download");
  assert.match(install, /Manifest file is missing or unreadable/, "and saying so when they do pick the wrong one");

  // Chrome loads the extension from that folder at every startup and derives
  // its storage identity from the path. Both halves have to be stated or the
  // recipient loses the extension, or the vault, later and silently.
  assert.match(install, /leave it there|Leave it there/);
  assert.match(install, /deleted, moved or renamed/);
  assert.match(install, /Keep the folder in the same place/);

  // A fresh install starts empty, and the way across is an export the UI
  // actually offers — asserted against the labels the pages render.
  assert.match(install, /does \*\*not\*\* travel with the installer/);
  const dashboard = await read("src/react/dashboard.tsx");
  for (const label of ["Export all CSV", "Import CSV"]) {
    assert.ok(install.includes(label), `INSTALL.md must name the control the page renders: ${label}`);
    assert.ok(dashboard.includes(`>${label}<`), `and Saved Profiles must still render ${label}`);
  }
  // Applicants export but do not import, so the guide must not promise a way back in.
  assert.match(install, /no applicant CSV import/);

  // Every host the manifest asks for is explained, because an unexplained
  // permission prompt is what makes someone abandon the install.
  const manifest = JSON.parse(await read("manifest.json"));
  for (const host of manifest.host_permissions) {
    const bare = host.replace("https://", "").replace("/*", "").replace(/^www\./, "");
    assert.ok(install.includes(bare), `INSTALL.md must account for host access to ${bare}`);
  }
});
