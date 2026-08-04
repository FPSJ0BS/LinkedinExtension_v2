import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function sourcePathForManifestFile(file) {
  if (file === "src/background.js") return resolve(root, "src", "background.ts");
  return resolve(root, file);
}

async function loadManifest() {
  return JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
}

test("manifest references existing extension source files", async () => {
  const manifest = await loadManifest();
  const files = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...Object.values(manifest.icons)
  ];
  await Promise.all(files.map(async (file) => access(await sourcePathForManifestFile(file))));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, "module");
});

test("host access is limited to LinkedIn", async () => {
  const manifest = await loadManifest();
  assert.deepEqual(manifest.host_permissions.sort(), ["https://linkedin.com/*", "https://www.linkedin.com/*"].sort());
});

test("permissions stay minimal", async () => {
  const manifest = await loadManifest();
  // `alarms` was added under decision D2 for the long-run heartbeat and nothing else.
  assert.deepEqual(manifest.permissions.slice().sort(), ["activeTab", "alarms", "downloads", "scripting", "storage"]);
  for (const forbidden of ["tabs", "webRequest", "webNavigation", "cookies", "history", "<all_urls>", "unlimitedStorage", "background", "clipboardRead"]) {
    assert.ok(!manifest.permissions.includes(forbidden), `${forbidden} must not be requested`);
  }
});

test("the connections content script is scoped to the connections pages only", async () => {
  const manifest = await loadManifest();
  const entry = manifest.content_scripts.find((script) => (script.js || []).includes("connections.js"));
  assert.ok(entry, "a content script entry for connections.js must exist");
  assert.deepEqual(entry.js, ["src/connections-core.js", "connections.js"]);
  for (const pattern of entry.matches) {
    assert.match(pattern, /^https:\/\/(?:www\.)?linkedin\.com\/mynetwork\//, `${pattern} must target LinkedIn connections pages`);
  }
});

test("the profile content script loads the extraction and challenge cores in order", async () => {
  const manifest = await loadManifest();
  const entry = manifest.content_scripts.find((script) => (script.js || []).includes("content.js"));
  assert.deepEqual(entry.js, ["src/extraction-core.js", "src/connections-core.js", "content.js"]);
  for (const pattern of entry.matches) assert.match(pattern, /linkedin\.com\/in\/\*$/);
});

test("the service worker stays a module inside src so its relative imports resolve", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.background.service_worker, "src/background.js");
  const source = await readFile(resolve(root, "src/background.ts"), "utf8");
  for (const dependency of ["./queue-db.js", "./import-queue-core.js", "./db.js", "./messages.js"]) {
    assert.ok(source.includes(dependency), `background.ts must import ${dependency}`);
  }
});
