import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import * as Queue from "../src/import-queue-core.js";
import * as QueueDb from "../src/queue-db.js";
import { normalizeProfile, replaceProfile } from "../src/profile-utils.js";
import { csvToProfiles, filterProfilesByUrls, profilesToCsv } from "../src/csv.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONNECTION_URL = "https://www.linkedin.com/in/example-person";

function extractedProfile(patch = {}) {
  return normalizeProfile({
    fullName: "Example Person",
    profileUrl: CONNECTION_URL,
    email: "example.person@work.com",
    mobile: "+919876543210",
    cvUrl: "https://example.com/example-person-cv.pdf",
    openToWorkDetails: ["Open to work: Yes", "Job titles: Senior Engineer"],
    skills: ["React", "TypeScript"],
    education: ["Example University", "Second College"],
    ...patch
  });
}

test("importing an already-saved profile replaces details but keeps id, collectedAt, notes and tags", () => {
  const existing = normalizeProfile({
    fullName: "Example Person",
    profileUrl: CONNECTION_URL,
    email: "stale@old.example",
    education: ["Old School"],
    notes: "Met at a conference.",
    tags: ["priority", "referral"],
    collectedAt: "2026-01-01T00:00:00.000Z"
  });

  const replaced = replaceProfile(existing, extractedProfile());

  assert.equal(replaced.id, existing.id, "record identity must survive a re-import");
  assert.equal(replaced.collectedAt, existing.collectedAt);
  assert.equal(replaced.notes, "Met at a conference.", "user notes must survive a re-import");
  assert.deepEqual(replaced.tags, ["priority", "referral"], "user tags must survive a re-import");
  assert.equal(replaced.email, "example.person@work.com", "extracted fields must be replaced");
  assert.equal(replaced.mobile, "+919876543210", "the mobile number must be replaced too");
  assert.equal(replaced.cvUrl, "https://example.com/example-person-cv.pdf", "and so must the CV");
  assert.ok(!replaced.emails.includes("stale@old.example"), "a stale address must not survive a re-import");
  assert.equal(replaced.education.length, 2);
  assert.ok(!replaced.education.some((entry) => /Old School/.test(entry)), "stale education must be dropped");
});

test("a re-import keeps every institution and the open-to-work panel", () => {
  const existing = normalizeProfile({ fullName: "Example Person", profileUrl: CONNECTION_URL, notes: "keep me" });
  const replaced = replaceProfile(existing, extractedProfile());

  assert.deepEqual(replaced.education, ["Example University", "Second College"], "one entry per institution");
  assert.deepEqual(replaced.openToWorkDetails, ["Open to work: Yes", "Job titles: Senior Engineer"]);
  assert.equal(replaced.status, "collected");
  assert.equal(replaced.notes, "keep me");
});

test("notes and tags typed after an import are not wiped by the next import", () => {
  const first = replaceProfile(null, extractedProfile());
  const annotated = normalizeProfile({ ...first, notes: "Follow up in Q3", tags: ["warm"] });
  const second = replaceProfile(annotated, extractedProfile({ email: "new.address@work.com" }));

  assert.equal(second.email, "new.address@work.com");
  assert.equal(second.notes, "Follow up in Q3");
  assert.deepEqual(second.tags, ["warm"]);
  assert.equal(second.id, annotated.id);
});

test("partial export covers only completed imports, full export covers every profile", () => {
  const saved = [
    extractedProfile(),
    normalizeProfile({ fullName: "Beta Person", profileUrl: "https://www.linkedin.com/in/beta-person" }),
    normalizeProfile({ fullName: "Gamma Person", profileUrl: "https://www.linkedin.com/in/gamma-person" })
  ];

  let state = Queue.startSession(
    { items: Queue.enqueueUrls([], [CONNECTION_URL, "https://www.linkedin.com/in/beta-person", "https://www.linkedin.com/in/gamma-person"], "t0").items, session: Queue.createSession() },
    "t0"
  );
  const first = Queue.claimNext(state, "t1");
  state = Queue.markCompleted({ items: first.items, session: first.session }, CONNECTION_URL, "t1", saved[0].id);
  const second = Queue.claimNext(state, "t2");
  state = Queue.markFailed({ items: second.items, session: second.session }, "https://www.linkedin.com/in/beta-person", "t2", "nope");

  const completedUrls = state.items.filter((item) => item.status === Queue.ITEM_STATUS.COMPLETED).map((item) => item.url);
  const partial = filterProfilesByUrls(saved, completedUrls);

  assert.equal(partial.length, 1);
  assert.equal(partial[0].profileUrl, CONNECTION_URL);
  assert.equal(saved.length, 3, "the full export still sees every saved profile");

  const roundTripped = csvToProfiles(profilesToCsv(partial));
  assert.equal(roundTripped.length, 1);
  assert.equal(roundTripped[0].fullName, "Example Person");
  assert.deepEqual(roundTripped[0].education, ["Example University", "Second College"], "every institution must survive the partial export");
});

test("URL matching for a partial export ignores case and trailing slashes", () => {
  const saved = [normalizeProfile({ fullName: "Example Person", profileUrl: CONNECTION_URL })];
  assert.equal(filterProfilesByUrls(saved, ["https://www.linkedin.com/in/Example-Person/"]).length, 1);
  assert.equal(filterProfilesByUrls(saved, []).length, 0);
  assert.equal(filterProfilesByUrls(saved, ["https://www.linkedin.com/in/somebody-else"]).length, 0);
});

test("queue-db exposes the persistence surface the orchestrator relies on", () => {
  for (const name of ["loadItems", "loadSession", "loadState", "saveSession", "saveItems", "replaceItems", "saveState", "clearItems"]) {
    assert.equal(typeof QueueDb[name], "function", `queue-db must export ${name}`);
  }
});

test("the import queue uses the existing database under a new schema version", async () => {
  const source = await readFile(resolve(root, "src/db.js"), "utf8");
  assert.match(source, /DB_NAME = "profile-table-collector"/, "the database name must never change");
  assert.match(source, /DB_VERSION = 6/, "v6 indexes an applicant by the application it belongs to");
  assert.match(source, /QUEUE_STORE = "importQueue"/);
  assert.match(source, /SESSION_STORE = "importSession"/);
  assert.match(source, /createObjectStore\(QUEUE_STORE, \{ keyPath: "url" \}\)/, "the queue is keyed by profile URL so duplicates cannot be stored");
});

test("the v5 upgrade adds the applicant stores without disturbing the existing ones", async () => {
  const source = await readFile(resolve(root, "src/db.js"), "utf8");
  const opener = source.slice(source.indexOf("export function openDatabase"));
  const upgrade = opener.slice(opener.indexOf("request.onupgradeneeded"), opener.indexOf("request.onsuccess"));
  assert.match(source, /APPLICANT_STORE = "applicants"/, "applicants get their own store");
  assert.match(source, /JOB_STORE = "jobs"/, "and the job they applied to gets one too");
  assert.match(upgrade, /createObjectStore\(APPLICANT_STORE, \{ keyPath: "id" \}\)/, "keyed by the applicant id");
  assert.match(upgrade, /createIndex\("jobId", "job\.id"/, "and indexed by the job, which is how the table groups them");
  // The whole point of adding stores rather than fields: rolling 3.7.0 back
  // must not cost a single saved profile or queue row.
  assert.ok(!/deleteObjectStore/.test(upgrade), "v5 must not delete an existing store");
  assert.ok(
    upgrade.indexOf("APPLICANT_STORE") > upgrade.indexOf("SESSION_STORE"),
    "the new stores are added after the existing ones, never in place of them"
  );
});

test("v6 indexes an applicant by the application, so one application is one record", async () => {
  const source = await readFile(resolve(root, "src/db.js"), "utf8");
  const opener = source.slice(source.indexOf("export function openDatabase"));
  const upgrade = opener.slice(opener.indexOf("request.onupgradeneeded"), opener.indexOf("request.onsuccess"));

  assert.match(source, /APPLICATION_INDEX = "applicationId"/, "the index has one named constant");
  assert.match(upgrade, /createIndex\(APPLICATION_INDEX, "applicationId"/, "on the record's own application id");
  // Applied to a store that already exists, not only to a freshly created one:
  // every user who has collected an applicant is on v5 with the store already
  // there, so an index added inside the `!contains(APPLICANT_STORE)` branch
  // would never be created for any of them.
  assert.match(upgrade, /if \(db\.objectStoreNames\.contains\(APPLICANT_STORE\)\) \{[\s\S]{0,400}?createIndex\(APPLICATION_INDEX/,
    "the index must be added to a store that already exists");
  assert.match(upgrade, /if \(!applicants\.indexNames\.contains\(APPLICATION_INDEX\)\)/, "and only once");
  // Additive only. Rolling back to v5 must cost this lookup and nothing else.
  assert.ok(!/deleteObjectStore/.test(upgrade), "v6 must not delete a store either");
  assert.ok(!/deleteIndex/.test(upgrade.slice(upgrade.indexOf("v6:"))), "nor an index");

  // THE DEFECT IT PREVENTS. `applicantId` hashes jobId|profileUrl|name|applicationId,
  // so how much of a person was known when they were written decides their key:
  // a pass reading only the list row knows no profile URL, a pass that opens the
  // panel does. Same person, same application, two hashes, two records.
  await import("../src/extraction-core.js");
  await import("../src/applicants-core.js");
  const Applicants = globalThis.ProfileVaultApplicants;
  const fromRow = Applicants.applicantId("4277798308", "", "Kaushal Kumar", "35141729733");
  const fromPanel = Applicants.applicantId(
    "4277798308", "https://www.linkedin.com/in/kaushal-kumar", "Kaushal Kumar", "35141729733"
  );
  assert.notEqual(fromRow, fromPanel, "the two passes genuinely hash differently — that is the whole problem");

  const db = await readFile(resolve(root, "src/applicant-db.js"), "utf8");
  assert.match(db, /async function findStoredApplication\(record\)/, "so the application is looked up as well as the id");
  assert.match(db, /const existing = \(await getApplicant\(incoming\.id\)\) \|\| \(await findStoredApplication\(incoming\)\)/,
    "before a second record can be created");
  // Scoped to the job: the index is on the application id alone, and an applicant
  // is a person *on a job*.
  assert.match(db, /String\(candidate\?\.job\?\.id \|\| ""\)\.trim\(\) === jobId/, "and matched within the job");
  // A database opened before v6 has the store but not the index. Answering
  // "nothing stored" costs the duplicate this prevents; throwing would cost
  // every save.
  assert.match(db, /if \(!store\.indexNames\.contains\(APPLICATION_INDEX\)\) return Promise\.resolve\(\[\]\)/,
    "a pre-v6 database must not throw on every save");
});

test("the v4 upgrade indexes what the record now has and retires what it does not", async () => {
  const source = await readFile(resolve(root, "src/db.js"), "utf8");
  const opener = source.slice(source.indexOf("export function openDatabase"));
  const upgrade = opener.slice(opener.indexOf("request.onupgradeneeded"), opener.indexOf("request.onsuccess"));
  assert.match(upgrade, /\["status", "status"\]/, "status must be indexed");
  assert.match(upgrade, /\["lastCollectedAt", "lastCollectedAt"\]/, "and so must the last collection");
  assert.match(upgrade, /store\.deleteIndex\(name\)/, "an index over a removed field must be dropped, not left lying");
  assert.match(upgrade, /for \(const name of \["currentCompany", "location"\]\)/, "those two are the removed ones");

  // The rows themselves migrate through the normalizer, on read and on repair.
  assert.match(source, /export async function repairStoredProfiles/, "a migration pass must exist");
  assert.match(source, /await saveManyProfiles\(repaired\)/, "and it must persist what it corrected");
});

test("the service worker never runs profiles in parallel or bypasses a challenge", async () => {
  const source = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(source, /Queue\.claimNext/, "the worker must claim work through the one-at-a-time state machine");
  assert.match(source, /Queue\.pauseSession/, "the worker must be able to pause on a challenge");
  assert.match(source, /recoverAfterInterruption/, "the worker must recover interrupted sessions");
  assert.ok(!/Promise\.all\(.*processItem/s.test(source), "profiles must never be processed concurrently");
  assert.ok(!/\.click\(\)/.test(source), "the worker must never click page controls itself");
});

test("the connections content script clicks only classifier-approved pagination", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  const clicks = source.match(/\.click\(\)/g) || [];
  assert.equal(clicks.length, 1, "there must be exactly one click site, inside pagination handling");
  assert.match(source, /control\.element\.click\(\)/, "the only click must go through the validated control");
  assert.match(source, /Core\.classifyControl\(/, "every candidate control must be classified before clicking");
  assert.match(source, /verdict\.allowed/, "only an allowed verdict may produce a control");
  assert.match(source, /finally \{\s*\n\s*scrollListTo\(originalY, target\)/, "the original scroll position must be restored");
  assert.match(source, /finally \{/, "scroll restoration must survive an error");
});

test("discovery waits for real content growth instead of trusting DOM quiet", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  assert.match(source, /function waitForGrowth/, "a growth wait is required for lazy loading");
  assert.match(source, /profileLinkCount\(\) > baselineLinks/, "growth must be measured by rendered profile links");
  assert.match(source, /documentHeight\(\) > baselineHeight/, "growth must also consider page height");
  assert.match(source, /await nudge\(target\)/, "the sentinel must be re-triggered at the bottom");
  assert.match(source, /function atDocumentBottom/, "bottom detection must account for inner scrollers");
  assert.match(source, /Core\.chooseScrollTarget/, "layouts that scroll a container above the list must be handled");

  // The original bug: a 1.4s ceiling made a 10-row page look like the whole list.
  const bottomWait = /BOTTOM_WAIT_MS = (\d+)/.exec(source);
  assert.ok(bottomWait && Number(bottomWait[1]) >= 5000, "the bottom wait must allow for a slow network fetch");
  const stepTimeout = /STEP_TIMEOUT_MS = (\d+)/.exec(source);
  assert.ok(stepTimeout && Number(stepTimeout[1]) >= 2000, "per-step waits must allow LinkedIn to render");
});

test("reaching the bottom is not treated as the end of the list", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  assert.match(source, /Core\.planDiscoveryStep\(/, "the bottom policy must go through the tested planner");
  assert.ok(
    !/atBottom = target <= window\.scrollY/.test(source),
    "the old single-shot bottom check must be gone"
  );

  const core = await readFile(resolve(root, "src/connections-core.js"), "utf8");
  assert.match(core, /idleAtBottom\) \|\| 0\) \+ 1/, "consecutive empty bottoms must be counted");
  assert.match(core, /IDLE_BOTTOM_LIMIT = 2/, "one quiet bottom read must never end the list");
});

test("discovery drives both the window and an inner scroll container", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  assert.match(source, /function currentScrollTop/, "the cursor must be read from whichever element scrolls");
  assert.match(source, /target\.element\.scrollTop/, "the detected container must supply the cursor");
  assert.match(source, /function maxScrollTop/, "the bottom must be computed from that same container");
  assert.match(source, /function scrollCandidates/, "ancestors of the list must be offered as candidates");
  assert.ok(
    !/window\.scrollY \+ stepSize/.test(source),
    "stepping from window.scrollY pins an inner-scrolling list to its first screenful"
  );
});

test("the connections script reads every card through the tested collector", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  assert.match(source, /Core\.collectEntriesFromLinks\(/, "card reading must go through the tested helper");
  assert.match(source, /Core\.createEntryCollector\(/, "a pass must accumulate across every read");
  assert.match(source, /const strict = anchors\.filter\(isVisible\)/, "rendered cards must be preferred");
  assert.match(source, /strict\.length \? strict :/, "a layout that defeats the visibility test must still be read");
  assert.match(source, /function listRoot/, "the list container must be located, not assumed");
  assert.match(source, /\[role='main'\]/, "layouts that render the list outside <main> must be handled");
});

test("the profile is only built after the page scan has finished", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  const scanAt = source.indexOf("await performLazyScrollAndCollect(main, collector, diagnostics)");
  const buildAt = source.indexOf("const profile = {");
  assert.ok(scanAt > 0 && buildAt > scanAt, "the normalized profile must be assembled after the full-page scan");

  const identityAt = source.indexOf("const fullName = identity.name;");
  assert.ok(identityAt > scanAt, "name, headline and location must be read after the page has settled");
  assert.match(source, /Core\.nextScanStep\(/, "the scan must use the tested planner");
  assert.match(source, /function pageSignature/, "growth must be measured by what has actually rendered");
  assert.match(source, /function collectIdentity/, "the late-hydrating top card must be re-read on every snapshot");
  assert.match(source, /scrollProfileTo\(0, target\)/, "the scan must start at the top of the profile");
  assert.match(source, /finally \{[\s\S]{0,300}scrollProfileTo\(originalY, target\)/, "the user's scroll position must be restored");
});

test("profile extraction allows time for lazily rendered sections", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  const waits = [...source.matchAll(/waitForDomQuiet\((\d+),\s*(\d+)\)/g)].map((match) => Number(match[2]));
  assert.ok(waits.length > 0, "the lazy-scroll pass must wait between steps");
  assert.ok(Math.max(...waits) >= 2000, "at least one wait must allow a slow section to render");
  assert.ok(Math.min(...waits) >= 1000, "no wait may be short enough to read a half-rendered page");
});

test("the importer lets a profile settle before reading it", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /PROFILE_SETTLE_MS/, "tab 'complete' fires before LinkedIn hydrates");
  const settle = /PROFILE_SETTLE_MS = (\d+)/.exec(worker);
  assert.ok(settle && Number(settle[1]) >= 1000, "the settle delay must be meaningful");
  const extract = /EXTRACT_TIMEOUT_MS = (\d+)/.exec(worker);
  assert.ok(extract && Number(extract[1]) >= 120000, "the extract budget must cover the longer waits");
  const discovery = /DISCOVERY_TIMEOUT_MS = (\d+)/.exec(worker);
  assert.ok(discovery && Number(discovery[1]) >= 180000, "the discovery budget must cover a full pass");
});

test("the discovery pass is resumable from a persisted cursor", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  assert.match(source, /options\.cursorY/, "a pass must start from the caller's cursor");
  assert.match(source, /scrollListTo\(startY, target\)/, "a pass must resume where the last one stopped");
  assert.match(source, /cursorY = currentScrollTop\(target\)/, "a pass must report the cursor back");

  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /applyDiscoveryPass/, "the worker must fold each pass into the ledger");
  assert.match(worker, /discovery\.cursorY/, "the worker must feed the persisted cursor back into the next pass");
});

test("the heartbeat only ever resumes normal processing", async () => {
  const source = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(source, /chrome\.alarms\.create/, "a heartbeat alarm is required for long runs");
  assert.match(source, /cooldownElapsed/, "the heartbeat must honour the cooldown deadline");
  assert.ok(
    !/onHeartbeat[\s\S]*?challengeKind\s*=\s*""/.test(source),
    "the heartbeat must never clear a challenge"
  );
});

test("the alarms permission is declared because the heartbeat needs it", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "extension/manifest.json"), "utf8"));
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const usesAlarms = /chrome\.alarms\./.test(worker);
  assert.equal(usesAlarms, manifest.permissions.includes("alarms"), "alarms must be declared if and only if it is used");
});

test("unlimitedStorage is not requested without a demonstrated quota problem", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "extension/manifest.json"), "utf8"));
  assert.ok(!manifest.permissions.includes("unlimitedStorage"), "no storage-quota failure has been demonstrated");
});

test("the queue is written one row at a time so large queues stay cheap", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /writeItemAndSession/, "per-profile writes must not rewrite the whole queue");
  const adapter = await readFile(resolve(root, "src/queue-db.js"), "utf8");
  assert.match(adapter, /export async function putItem/, "the adapter must support single-row writes");
});
