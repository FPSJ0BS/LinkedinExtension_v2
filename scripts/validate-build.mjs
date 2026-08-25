import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
const required = new Set([
  manifest.action.default_popup,
  manifest.background.service_worker,
  "dashboard.html",
  "import.html",
  "applicants.html",
  "messages.html",
  "theme.css",
  "popup.css",
  "dashboard.css",
  "import.css",
  "applicants.css",
  "messages.css",
  "vendor/react.production.min.js",
  "vendor/react-dom.production.min.js",
  "src/react/popup.js",
  "src/react/dashboard.js",
  "src/react/import-dashboard.js",
  "src/react/applicants-dashboard.js",
  "src/react/messages-dashboard.js",
  "src/applicant-csv.js",
  "src/extraction-core.js",
  "src/connections-core.js",
  "src/collector-tabs-core.js",
  "src/import-queue-core.js",
  "src/queue-db.js",
  "src/messages.js",
  "src/profile-utils.js",
  "src/db.js",
  "src/csv.js",
  "content.js",
  "connections.js",
  // 3.7.0: the recruiter hiring surface.
  "src/applicants-core.js",
  "src/applicant-db.js",
  "applicants.js"
]);
for (const script of manifest.content_scripts || []) for (const file of script.js || []) required.add(file);
for (const file of required) await access(path.join(dist, file));

for (const htmlFile of ["popup.html", "dashboard.html", "import.html", "applicants.html", "messages.html"]) {
  const html = await readFile(path.join(dist, htmlFile), "utf8");
  if (!html.includes("vendor/react.production.min.js") || !html.includes("vendor/react-dom.production.min.js")) {
    throw new Error(`${htmlFile} does not load the local React runtime.`);
  }
}

const REACT_ENTRIES = [
  "src/react/popup.js",
  "src/react/dashboard.js",
  "src/react/import-dashboard.js",
  "src/react/applicants-dashboard.js",
  "src/react/messages-dashboard.js"
];
for (const entry of REACT_ENTRIES) {
  const source = await readFile(path.join(dist, entry), "utf8");
  if (!source.includes("ReactDOM.render")) throw new Error(`${entry} is not rendered through ReactDOM.`);
}

// The service worker must be able to resolve its relative ESM imports from dist/src/.
const worker = await readFile(path.join(dist, manifest.background.service_worker), "utf8");
for (const dependency of ["./queue-db.js", "./import-queue-core.js", "./db.js", "./messages.js", "./collector-tabs-core.js"]) {
  if (!worker.includes(dependency)) throw new Error(`Service worker does not import ${dependency}.`);
  await access(path.join(dist, "src", dependency.replace("./", "")));
}

// No extension page or module may pull React from a remote origin.
for (const file of ["popup.html", "dashboard.html", "import.html", "applicants.html", "messages.html"]) {
  const html = await readFile(path.join(dist, file), "utf8");
  if (/src=["']https?:\/\//i.test(html)) throw new Error(`${file} loads a remote script, which Manifest V3 CSP forbids.`);
}

console.log(`Validated ${required.size} build files, ${REACT_ENTRIES.length} React entry points, and service-worker imports.`);
