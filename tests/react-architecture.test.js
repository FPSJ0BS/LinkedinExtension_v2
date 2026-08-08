import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("popup and dashboard are React TypeScript entry points", async () => {
  const popup = await readFile(resolve(root, "src/react/popup.tsx"), "utf8");
  const dashboard = await readFile(resolve(root, "src/react/dashboard.tsx"), "utf8");
  assert.match(popup, /ReactDOM\.render\(<PopupApp/);
  assert.match(dashboard, /ReactDOM\.render\(<DashboardApp/);
  assert.match(popup, /class PopupApp extends React\.Component/);
  assert.match(dashboard, /class DashboardApp extends React\.Component/);
});

test("the popup exposes a single Start Collecting control", async () => {
  const source = await readFile(resolve(root, "src/react/popup.tsx"), "utf8");
  assert.match(source, /Start Collecting/, "the popup must offer one primary action");
  assert.match(source, /IMPORT_MESSAGES\.START_COLLECTING/, "it must trigger the one-click collect command");
  assert.match(source, /renderImportPanel/, "the panel must render inside the popup");
  for (const removed of ["Find Connections", "Collect All", "Retry Failed", "Clear Queue"]) {
    assert.ok(!source.includes(removed), `the popup must not surface "${removed}"`);
  }
});

test("the connections page exposes every required control", async () => {
  const source = await readFile(resolve(root, "src/react/import-dashboard.tsx"), "utf8");
  // The primary actions, in the order the user needs them.
  for (const label of [
    "Start Full Collection",
    "Discover Connections Only",
    "Start Profile Extraction",
    "Stop",
    "Clear Queue",
    "Saved Profiles",
    "Download CSV"
  ]) {
    assert.ok(source.includes(label), `the connections page must offer "${label}"`);
  }
  // Secondary actions live behind Advanced so the toolbar stays readable.
  const advanced = source.slice(source.indexOf('<details className="advanced">'), source.indexOf("</details>"));
  for (const label of ["Retry Failed", "Download Diagnostics", "Recheck Login"]) {
    assert.ok(advanced.includes(label), `"${label}" belongs in the Advanced area`);
  }
  // One compact session control, not three competing ones.
  assert.match(source, /renderSession\(/, "the session state must be one component");
  assert.match(source, /LinkedIn connected/, "a live session must read as connected");
  assert.match(source, /Login required/, "a signed-out browser must say so");
  assert.match(source, /LinkedIn verification required/, "a checkpoint must say so");
  assert.ok(!source.includes("auth-pill"), "the separate signed-in pill must be gone");

  assert.match(source, /type="search"/, "a search box is required");
  assert.match(source, /Filter by status/, "a status filter is required");
  assert.match(source, /Skip if collected within/, "the refresh window must stay editable");
  assert.match(source, /Total discovered/, "the discovered total must be shown");
  assert.match(source, /LinkedIn reported total/, "LinkedIn's own total must be shown");
  assert.match(source, /Missing \/ inaccessible/, "cards without a usable profile URL must be shown");
  assert.match(source, /label: "Skipped"/, "the skipped count must be shown");
  assert.match(source, /Current profile/, "the profile being extracted must be named");
  assert.match(source, /stopReasonText/, "the final stop reason must be shown");
  assert.match(source, /LinkedIn stops rendering a tab you switch away from/i, "the hidden-collector warning is required");
  // The completion policy is unchanged; its prose description was removed in
  // 3.7.8 along with every other explanatory paragraph. The behaviour is
  // asserted where it lives, in tests/collector-tabs.test.js.
  assert.match(source, /COMPLETION_POLICY|Saved Profiles/, "the policy itself is unchanged");
  assert.match(source, /COLLECTION_LABELS\[collectionState\]/, "the collection state must be visible");
  assert.match(source, /summary\.coverage\.gap > 0/, "an unresolved difference must be shown");
});

test("the navigation labels say what the pages are", async () => {
  const popup = await readFile(resolve(root, "src/react/popup.tsx"), "utf8");
  assert.match(popup, />Connections Collector</, "Import must be named for what it does");
  assert.match(popup, />Saved Profiles</, "Table must be named for what it holds");
  assert.ok(!/>Import</.test(popup), "the unclear Import label must be gone");
  assert.ok(!/>Table</.test(popup), "the unclear Table label must be gone");

  const dashboard = await readFile(resolve(root, "src/react/dashboard.tsx"), "utf8");
  assert.match(dashboard, />Open Connections Collector</, "the saved-profiles page must link out clearly");
});

test("the saved-profiles table shows the specified columns in the specified order", async () => {
  const source = await readFile(resolve(root, "src/react/dashboard.tsx"), "utf8");
  const head = source.slice(source.indexOf("<thead>"), source.indexOf("</thead>"));
  const headers = [...head.matchAll(/<th(?:\s[^>]*)?>([^<]+)<\/th>/g)].map((match) => match[1].trim());
  assert.deepEqual(
    headers,
    ["Name", "Email", "Mobile", "CV", "Open to Work", "Education", "Skills",
      "Profile URL", "Status", "Last Collected", "Notes", "Tags", "Actions"],
    "the column order is part of the specification"
  );

  const body = source.slice(source.indexOf("<tbody>"), source.indexOf("</tbody>"));
  assert.match(body, /summarizeEducation\(/, "education shows the first institution plus +N more");
  assert.match(body, /summarizeSkills\(/, "skills are capped with a +N more");
  assert.match(body, /<CompactCell/, "every long cell must be compact");
  assert.match(body, /View details/, "a details affordance is required");
  assert.match(source, />See more</, "and each compact cell must offer the rest");

  // The whole value lives in the details view only.
  const details = source.slice(source.indexOf("renderDetails()"), source.indexOf("renderEditor()"));
  assert.match(details, /profile\.openToWorkDetails\.map/, "the full open-to-work panel belongs there");
  assert.match(details, /profile\.education\.map/, "and every institution");
  assert.match(details, /profile\.skills\.map/, "and every skill");
});

test("the CSV columns are the table columns", async () => {
  const csv = await readFile(resolve(root, "src/csv.js"), "utf8");
  const dashboard = await readFile(resolve(root, "src/react/dashboard.tsx"), "utf8");
  const head = dashboard.slice(dashboard.indexOf("<thead>"), dashboard.indexOf("</thead>"));
  const headers = [...head.matchAll(/<th(?:\s[^>]*)?>([^<]+)<\/th>/g)]
    .map((match) => match[1].trim())
    .filter((label) => label !== "Actions")
    .map((label) => label.toLowerCase().replace(/ /g, "_"));
  // The table calls two of them by a friendlier name than the file does.
  const expected = headers.map((label) => (label === "cv" ? "cv_url" : label === "profile_url" ? "profile_url" : label));
  const module = await import("../src/csv.js");
  assert.deepEqual([...module.CSV_TABLE_COLUMNS], expected, "the exported list must match the rendered header");
  assert.match(csv, /export const CSV_TABLE_COLUMNS/, "the shared list must be exported, not duplicated");
});

test("finding connections and extracting them are separate buttons", async () => {
  const source = await readFile(resolve(root, "src/react/import-dashboard.tsx"), "utf8");
  assert.match(source, /findAllConnections = async[\s\S]*?IMPORT_MESSAGES\.DISCOVER_ALL/, "Find All Connections must only discover");
  assert.match(source, /startExtraction = async[\s\S]*?IMPORT_MESSAGES\.START/, "Start Extraction must only extract");

  const discovery = source.slice(source.indexOf("findAllConnections = async"), source.indexOf("startExtraction = async"));
  assert.ok(!discovery.includes("IMPORT_MESSAGES.START"), "discovery must never kick off extraction");

  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const branch = worker.slice(worker.indexOf("IMPORT_MESSAGES.DISCOVER_ALL"), worker.indexOf("IMPORT_MESSAGES.START_COLLECTING"));
  assert.ok(!/Queue\.startSession/.test(branch), "the discover command must not start a session");
});

test("the connections list is paginated, searchable and filterable", async () => {
  const source = await readFile(resolve(root, "src/react/import-dashboard.tsx"), "utf8");
  assert.match(source, /filterItems\(/, "search and status filtering must use the tested helper");
  assert.match(source, /paginate\(/, "the list must be paginated");
  assert.match(source, /pageNumbers\(/, "page numbers must be rendered");
  assert.match(source, /Previous\s*<\/button>/, "a Previous control is required");
  assert.match(source, /Next\s*<\/button>/, "a Next control is required");
  assert.match(source, /Showing \{start\}–\{end\} of \{total\}/, "the total row count must be visible");
  assert.match(source, /PAGE_SIZES\.map/, "the 25/50 row choice must be offered");

  const core = await readFile(resolve(root, "src/import-queue-core.js"), "utf8");
  assert.match(core, /export const PAGE_SIZES = Object\.freeze\(\[25, 50\]\)/, "pagination sizes are 25 and 50 rows");
});

test("each connection row shows name, URL, status, last collected date and error", async () => {
  const source = await readFile(resolve(root, "src/react/import-dashboard.tsx"), "utf8");
  assert.match(source, /item\.name \|\| shortUrl\(item\.url\)/, "the row must show a name");
  assert.match(source, /<a href=\{item\.url\}/, "the row must link to the profile URL");
  assert.match(source, /STATUS_LABELS\[item\.status\]/, "the row must show collection status");
  assert.match(source, /formatDate\(item\.lastCollectedAt\)/, "the row must show when it was last collected");
  assert.match(source, /\{item\.error \?/, "the row must show an error when there is one");
});

test("every selection scope is offered on the connections page", async () => {
  const source = await readFile(resolve(root, "src/react/import-dashboard.tsx"), "utf8");
  for (const scope of ["ALL", "SELECTED", "UNCOLLECTED", "FAILED", "STALE"]) {
    assert.match(source, new RegExp(`SELECTION_SCOPE\\.${scope}`), `the ${scope} selection must be offered`);
  }
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /Queue\.selectItemUrls/, "the worker must resolve the selection scope");
  assert.match(worker, /Queue\.prepareRun/, "the worker must arm only the selected connections");
});

test("Start Collecting checks the session, redirects to Connections, discovers, then extracts", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /IMPORT_MESSAGES\.START_COLLECTING/, "the worker must handle the single-click command");

  const workflow = worker.slice(
    worker.indexOf("async function startCollectingWorkflow"),
    worker.indexOf("async function discoveryOnlyWorkflow")
  );
  assert.ok(workflow.length > 200, "the automatic workflow must exist as its own function");

  // The specified order: login gate, then Connections, then discovery, then extraction.
  const authAt = workflow.indexOf("checkLoginState()");
  const discoverAt = workflow.indexOf("runDiscovery(");
  const startAt = workflow.indexOf("Queue.startSession");
  assert.ok(authAt > 0, "it must check whether the browser is signed in to LinkedIn");
  assert.ok(discoverAt > authAt, "discovery must happen after the login check");
  assert.ok(startAt > discoverAt, "extraction must start only after discovery has finished");

  assert.match(workflow, /openLoginPage\(\)/, "a signed-out browser must be sent to LinkedIn's sign-in page");
  assert.match(workflow, /AUTH_STATE\.LOGIN_REQUIRED/, "it must pause instead of driving a signed-out tab");
  assert.match(workflow, /PAUSED_BY\.CHALLENGE/, "it must refuse to start into a challenge");
  assert.match(workflow, /autoDiscover: true/, "a queue that drains early must keep paging the list");

  // Detached: the popup and the importer page may both close while it runs.
  const branch = worker.slice(worker.indexOf("if (type === IMPORT_MESSAGES.START_COLLECTING"));
  const body = branch.slice(0, branch.indexOf("IMPORT_MESSAGES.ENQUEUE"));
  assert.match(body, /startCollectingWorkflow\(/, "the command must launch the workflow");
  assert.ok(!/await startCollectingWorkflow/.test(body), "the reply must not wait for the whole run to finish");
  assert.match(body, /started: true/, "the caller is told the run started, not that it completed");
});

test("discovery and extraction each reuse one tab, and no tab is opened per profile", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const resolveTab = worker.slice(
    worker.indexOf("async function resolveConnectionsTab"),
    worker.indexOf("async function prepareCollectorStep")
  );
  assert.match(resolveTab, /Tabs\.ensureConnectionsTab\(CONNECTIONS_URL\)/, "discovery must reuse the Connections tab");
  assert.ok(!/chrome\.tabs\.create/.test(resolveTab), "discovery must never create its own tab");

  // Since 3.5.0 the run uses two tabs of the USER'S window rather than a
  // separate collector window, and every tab decision lives in the tab core.
  assert.ok(!/chrome\.windows\.create/.test(worker), "no separate collector window may be created");
  const withoutInjection = worker.replace(/create: \(properties: any\) => chrome\.tabs\.create\(properties\)/, "");
  assert.ok(!/chrome\.tabs\.create\(/.test(withoutInjection), "the worker must not open tabs outside the controller");
  assert.match(worker, /Tabs\.ensureProfileTab\(/, "one reusable profile collector tab must be opened");
  assert.match(worker, /await Tabs\.navigateProfileTab\(item\.url\)/, "each profile must reuse that same tab");

  // And the controller itself creates a tab in exactly three places: the
  // reusable collector tab, the Saved Profiles page, and — since 3.7.8 — the
  // short-lived background tab a resume is opened and saved from, which is not
  // a collector tab and is closed by the same call that opened it.
  const tabsCore = await readFile(resolve(root, "src/collector-tabs-core.js"), "utf8");
  const creates = tabsCore.match(/await tabs\.create\(/g) || [];
  assert.equal(creates.length, 3, "only ensureTab, openSavedProfilesTab and openDocumentTab may create a tab");
  const document_ = tabsCore.slice(tabsCore.indexOf("async openDocumentTab("), tabsCore.indexOf("async closeDocumentTab("));
  assert.match(document_, /active: false/, "a resume tab must never take the screen from the recruiter");
  assert.ok(!/writeKey|KEYS\./.test(document_), "and it is never tracked — closeCollectorTabs must not know about it");
});

test("the loop reveals more connections when the queue drains", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /async function discoverNextPage/, "the loop must be able to page forward");
  const emptyBranch = worker.slice(worker.indexOf(`claim.reason === "empty"`));
  const body = emptyBranch.slice(0, emptyBranch.indexOf(`claim.reason === "backoff"`));
  assert.match(body, /Queue\.shouldContinueAutoDiscovery\(/, "draining the queue must trigger more discovery");
  assert.match(body, /discoverNextPage\(\)/, "it must load the next connections");
  assert.match(body, /discoveryExhausted: true/, "it must stop when nothing remains");
  // The live bug: this branch retried every two seconds, forever, whenever a
  // pass reported neither growth nor exhaustion.
  assert.match(body, /Queue\.registerFruitlessDiscovery\(/, "a fruitless attempt must be counted, not retried blindly");
  assert.match(body, /Queue\.terminalStateFor\(/, "a drained queue must land in a terminal state");
});

test("the connections import dashboard is a React TypeScript entry point", async () => {
  const source = await readFile(resolve(root, "src/react/import-dashboard.tsx"), "utf8");
  assert.match(source, /ReactDOM\.render\(<ImportApp/);
  assert.match(source, /class ImportApp extends React\.Component/);
  assert.match(source, /const React: any = \(globalThis as any\)\.React/);
});

test("local React runtime is bundled for Manifest V3 CSP", async () => {
  await access(resolve(root, "extension/vendor/react.production.min.js"));
  await access(resolve(root, "extension/vendor/react-dom.production.min.js"));
  for (const file of ["popup.html", "dashboard.html", "import.html"]) {
    const html = await readFile(resolve(root, "extension/pages", file), "utf8");
    assert.match(html, /vendor\/react\.production\.min\.js/);
    assert.match(html, /vendor\/react-dom\.production\.min\.js/);
    assert.ok(!/src=["']https?:\/\//i.test(html), `${file} must not load a remote script`);
  }
});

test("React 16.0 has no hooks, so no React UI file may use one", async () => {
  const files = [
    "src/react/popup.tsx",
    "src/react/dashboard.tsx",
    "src/react/import-dashboard.tsx"
  ];
  for (const file of files) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.ok(
      !/\buse(?:State|Effect|Ref|Memo|Callback|Context|Reducer|LayoutEffect)\s*\(/.test(source),
      `${file} uses a React hook, which the vendored React 16.0.0 runtime does not support`
    );
    assert.ok(!/from ["']react(?:-dom)?["']/.test(source), `${file} must read React from globalThis, not a bare import`);
  }
});

test("extraction and connection cores stay framework-free and DOM-free at load", async () => {
  for (const file of ["src/extraction-core.js", "src/connections-core.js"]) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.ok(!/^\s*(?:import|export)\s/m.test(source), `${file} must stay an export-free IIFE`);
    assert.ok(!/React/.test(source), `${file} must not reference React`);
    assert.match(source, /globalThis\.ProfileVault/, `${file} must publish its API on globalThis`);
  }
});
