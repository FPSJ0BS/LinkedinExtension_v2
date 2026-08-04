// Regression coverage for the problems observed live in 3.3.0.
//
//   1. Collection only worked while the collector tab was visible.
//   2. LinkedIn reported 67 connections; only 66 were saved and the run never
//      reached a terminal state because of the missing one.
//   3. Discovery ran forever once no more connections could be found.
//   4. Discovery never handed over to extraction.
//   5. Extraction only started after a manual Stop / Start.
//   6. Profiles were saved before their lazy sections had been collected.
//   7. Role, company, duration, and employment type were mixed together.
//   8. "Full-time", "9 mos" and "Endorse" were saved as companies/roles/skills.
//
// Everything here drives the pure cores, which is where the policy lives; the
// content scripts and the worker are adapters and are asserted at source level.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

await import("../src/connections-core.js");
await import("../src/extraction-core.js");
import * as Queue from "../src/import-queue-core.js";

const Core = globalThis.ProfileVaultCore;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ===========================================================================
// A. Parser contamination — the values visible in the live screenshots
// ===========================================================================

test("a company merged with its duration never becomes the role title", () => {
  // LinkedIn's entity innerText collapses "TechMatrix Consulting · Full-time"
  // and "9 mos" into one line when the separator span is not rendered.
  const record = Core.parseExperienceLines([
    "Associate Software Engineer",
    "TechMatrix Consulting 9 mos",
    "Full-time",
    "Jan 2024 - Present · 9 mos",
    "Jaipur, Rajasthan, India"
  ]);

  assert.equal(record.title, "Associate Software Engineer", "the role title must be only the title");
  assert.equal(record.company, "TechMatrix Consulting", "the duration must not stay glued to the company");
  assert.ok(!/9 mos/i.test(record.title), "a duration must never appear in the role title");
  assert.ok(!/9 mos/i.test(record.company), "a duration must never appear in the company name");
  assert.equal(record.employmentType, "Full-time");
});

test("the role title never carries the company name appended to it", () => {
  const record = Core.parseExperienceLines([
    "Associate Software Engineer at TechMatrix Consulting",
    "TechMatrix Consulting · Full-time",
    "Jan 2024 - Present"
  ]);
  assert.equal(record.title, "Associate Software Engineer", "the trailing company must be stripped from the title");
  assert.equal(record.company, "TechMatrix Consulting");
});

test("an employment type is never accepted as a company name", () => {
  for (const value of ["Full-time", "Part-time", "Internship", "Freelance", "Remote", "9 mos", "1 yr 2 mos", "Jan 2024 - Present"]) {
    assert.equal(Core.sanitizeCompanyName(value), "", `"${value}" must never be a company`);
  }
  assert.equal(Core.sanitizeCompanyName("TechMatrix Consulting · Full-time"), "TechMatrix Consulting");
  assert.equal(Core.sanitizeCompanyName("TechMatrix Consulting 9 mos"), "TechMatrix Consulting");
});

test("experience grouping never creates a company card called Full-time", () => {
  const groups = Core.groupExperienceByCompany([
    "Title: Associate Software Engineer | Company: Full-time | Dates: Jan 2024 - Present",
    "Title: Intern | Company: 9 mos | Dates: Jan 2023 - Sep 2023",
    "Title: Engineer | Company: TechMatrix Consulting | Dates: Jan 2024 - Present"
  ]);
  for (const group of groups) {
    assert.ok(!/^(?:full[- ]time|part[- ]time|remote|\d+\s*(?:yrs?|mos?))$/i.test(group.company),
      `"${group.company}" is employment metadata, not a company`);
  }
  assert.ok(groups.some((group) => group.company === "TechMatrix Consulting"), "the real company must survive");
});

test("the accumulator rejects employment metadata as an experience company", () => {
  const accumulator = Core.createProfileAccumulator();
  accumulator.addExperience("Title: Associate Software Engineer | Company: Full-time | Dates: Jan 2024 - Present");
  const records = accumulator.experience();
  assert.ok(!records.some((record) => /^full[- ]time$/i.test(record.company)), "Full-time must never be stored as a company");
});

test("endorsement controls and role sentences are never saved as skills", () => {
  const accumulator = Core.createProfileAccumulator();
  for (const value of [
    "Endorse",
    "Endorsements",
    "Associate Software Engineer at TechMatrix Consulting Endorse",
    "Associated with TechMatrix Consulting",
    "Endorsed by 3 colleagues",
    "Show all 27 skills",
    "9 mos",
    "Full-time"
  ]) {
    accumulator.addSkill(value);
  }
  accumulator.addSkill("React");
  accumulator.addSkill("Amazon Web Services (AWS)");

  assert.deepEqual(accumulator.skills(), ["React", "Amazon Web Services (AWS)"], "only real skills may be stored");
});

test("isSkillValue accepts skills and rejects controls, sentences, and metadata", () => {
  for (const good of ["React", "Node.js", "Amazon Web Services (AWS)", "Data Structures", "C++"]) {
    assert.equal(Core.isSkillValue(good), true, `"${good}" is a skill`);
  }
  for (const bad of [
    "Endorse",
    "Associate Software Engineer at TechMatrix Consulting Endorse",
    "Associated with TechMatrix Consulting",
    "Jan 2024 - Present",
    "Full-time",
    "9 mos",
    "Endorsed by 3 colleagues"
  ]) {
    assert.equal(Core.isSkillValue(bad), false, `"${bad}" is not a skill`);
  }
});

test("the current role and current company stay separate fields", () => {
  const accumulator = Core.createProfileAccumulator();
  accumulator.addExperience({
    title: "Associate Software Engineer",
    company: "TechMatrix Consulting",
    employmentType: "Full-time",
    dateRange: "Jan 2024 - Present",
    duration: "9 mos",
    isCurrent: true
  });
  const current = accumulator.experience().find((record) => record.isCurrent);
  assert.equal(current.title, "Associate Software Engineer");
  assert.equal(current.company, "TechMatrix Consulting");
  assert.equal(current.duration, "9 mos", "the duration keeps its own field");
  assert.equal(current.employmentType, "Full-time", "the employment type keeps its own field");
  assert.ok(!current.title.includes(current.company), "the company must not be inside the title");
});

// ===========================================================================
// B. The 67-versus-66 gap must reach a terminal state
// ===========================================================================

test("67 reported with 66 usable URLs and 1 unusable card is fully accounted for", () => {
  const session = Queue.createSession();
  const discovery = Queue.applyDiscoveryPass(session, {
    total: 67,
    totalReliable: true,
    atBottom: true,
    paginationAvailable: false,
    cursorY: 4200,
    cards: { cardsSeen: 67, cardsWithoutUrl: 1, restrictedCards: 1, duplicateLinks: 3 }
  }, 66, "t1");

  assert.equal(discovery.discovered, 66);
  assert.equal(discovery.cardsWithoutUrl, 1);
  assert.equal(
    discovery.accountedFor, 67,
    "66 usable URLs plus 1 card with no usable URL accounts for all 67"
  );
  assert.equal(discovery.coverageConfirmed, true, "the list is provably fully enumerated");
  assert.equal(discovery.exhausted, true, "discovery must stop, not keep hunting for a 67th URL");
  assert.equal(discovery.gap, 1, "the exact unresolved difference must be recorded");
});

test("a run that accounts for every connection but cannot collect one ends completed_with_gap", () => {
  const state = {
    items: Queue.enqueueUrls([], ["https://www.linkedin.com/in/a"], "t0").items,
    session: Queue.createSession({
      discovery: Queue.createDiscoveryState({
        totalCount: 67, totalReliable: true, discovered: 66,
        cardsWithoutUrl: 1, restrictedCards: 1, exhausted: true, coverageConfirmed: true
      })
    })
  };
  assert.equal(Queue.terminalStateFor(state), Queue.COLLECTION_STATE.COMPLETED_WITH_GAP);

  const clean = {
    items: state.items,
    session: Queue.createSession({
      discovery: Queue.createDiscoveryState({
        totalCount: 66, totalReliable: true, discovered: 66, exhausted: true, coverageConfirmed: true
      })
    })
  };
  assert.equal(Queue.terminalStateFor(clean), Queue.COLLECTION_STATE.COMPLETED);
});

test("an unreliable rounded total can still not confirm coverage", () => {
  const discovery = Queue.applyDiscoveryPass(Queue.createSession(), {
    total: 500, totalReliable: false, atBottom: true, paginationAvailable: false,
    cards: { cardsSeen: 500, cardsWithoutUrl: 0 }
  }, 500, "t1");
  assert.equal(discovery.coverageConfirmed, false, "a 500+ total can never confirm coverage");
});

// ===========================================================================
// C. Discovery must terminate — it must not run forever
// ===========================================================================

test("repeated fruitless discovery attempts are bounded, not retried forever", () => {
  let session = Queue.createSession({ autoDiscover: true });
  let attempts = 0;
  // Simulate the worker's drain loop: discovery returns nothing and never
  // reports itself exhausted. This is the shape that spun forever live.
  while (Queue.shouldContinueAutoDiscovery(session) && attempts < 1000) {
    session = Queue.registerFruitlessDiscovery(session, "t1");
    attempts += 1;
  }
  assert.ok(attempts < 1000, "the drain loop must give up instead of spinning");
  assert.ok(attempts <= Queue.MAX_FRUITLESS_DISCOVERY, `bounded to ${Queue.MAX_FRUITLESS_DISCOVERY} attempts, took ${attempts}`);
  assert.equal(session.discoveryExhausted, true, "giving up must mark discovery finished");
});

test("a pagination click that reveals nothing cannot reset the quiet counter forever", () => {
  let session = Queue.createSession();
  // A control that is allowlisted but does nothing: clicked every pass, no growth.
  for (let pass = 0; pass < 12; pass += 1) {
    session = { ...session, discovery: Queue.applyDiscoveryPass(session, {
      total: null, atBottom: true, paginationAvailable: true, clickedPagination: true,
      cards: { cardsSeen: 10 }
    }, 0, "t1") };
  }
  assert.equal(session.discovery.exhausted, true, "a click that never grows the list must stop counting as progress");
});

test("the worker's drain loop cannot loop without a bound", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const emptyBranch = worker.slice(worker.indexOf('claim.reason === "empty"'));
  const body = emptyBranch.slice(0, emptyBranch.indexOf('claim.reason === "backoff"'));
  assert.match(body, /Queue\.shouldContinueAutoDiscovery\(/, "draining the queue must consult the bounded rule");
  assert.match(body, /Queue\.registerFruitlessDiscovery\(/, "a fruitless attempt must be counted");
  assert.match(body, /Queue\.terminalStateFor\(/, "a drained queue must reach a terminal state");
  // The old shape: retry in two seconds, unconditionally, forever.
  assert.ok(
    !/if \(!next\.exhausted\) \{\s*\n\s*\/\/[^\n]*\n\s*await delay\(2000\);/.test(body),
    "the unconditional retry-forever branch must be gone"
  );
});

// ===========================================================================
// D. The collection state machine
// ===========================================================================

test("every required collection state exists", () => {
  for (const state of [
    "idle", "opening_connections", "discovering_connections", "connections_complete",
    "opening_profile_collector", "extracting_profile", "saving_profile",
    "moving_to_next_profile", "paused_hidden", "paused_challenge", "stopped",
    "completed", "completed_with_gap", "failed"
  ]) {
    assert.ok(
      Object.values(Queue.COLLECTION_STATE).includes(state),
      `the machine must define "${state}"`
    );
  }
});

test("the automatic workflow runs discovery straight through to extraction", () => {
  let session = Queue.createSession();
  const path = [
    Queue.COLLECTION_STATE.OPENING_CONNECTIONS,
    Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS,
    Queue.COLLECTION_STATE.CONNECTIONS_COMPLETE,
    Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR,
    Queue.COLLECTION_STATE.EXTRACTING_PROFILE,
    Queue.COLLECTION_STATE.SAVING_PROFILE,
    Queue.COLLECTION_STATE.MOVING_TO_NEXT_PROFILE,
    Queue.COLLECTION_STATE.COMPLETED
  ];
  for (const next of path) {
    const result = Queue.transitionCollection(session, next, "t1");
    assert.equal(result.changed, true, `${session.collectionState} -> ${next} must be allowed`);
    session = result.session;
  }
  assert.equal(session.collectionState, Queue.COLLECTION_STATE.COMPLETED);
});

test("connections_complete reaches extraction without passing through stopped", () => {
  const ready = Queue.transitionCollection(Queue.createSession(), Queue.COLLECTION_STATE.CONNECTIONS_COMPLETE, "t0").session;
  const opening = Queue.transitionCollection(ready, Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR, "t1");
  assert.equal(opening.changed, true, "the hand-over must not require a manual Stop then Start");
  const extracting = Queue.transitionCollection(opening.session, Queue.COLLECTION_STATE.EXTRACTING_PROFILE, "t2");
  assert.equal(extracting.changed, true, "and it must run straight on into extraction");
});

test("transitions are idempotent so a worker wake-up cannot start a second run", () => {
  const discovering = Queue.transitionCollection(Queue.createSession(), Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS, "t0").session;
  const again = Queue.transitionCollection(discovering, Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS, "t1");
  assert.equal(again.changed, false, "re-entering the same state must be a no-op");
  assert.equal(again.session.collectionState, Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS);

  const extracting = Queue.transitionCollection(discovering, Queue.COLLECTION_STATE.EXTRACTING_PROFILE, "t2");
  assert.equal(extracting.changed, false, "discovery must finish before extraction may begin");
});

test("a terminal state cannot silently roll back into running work", () => {
  const completed = Queue.transitionCollection(Queue.createSession(), Queue.COLLECTION_STATE.COMPLETED, "t0").session;
  assert.equal(Queue.isTerminalCollectionState(completed.collectionState), true);
  assert.equal(Queue.transitionCollection(completed, Queue.COLLECTION_STATE.EXTRACTING_PROFILE, "t1").changed, false);
  // Starting over is explicit.
  assert.equal(Queue.transitionCollection(completed, Queue.COLLECTION_STATE.IDLE, "t1").changed, true);
});

// ===========================================================================
// E. Visibility — a hidden collector must pause, never "finish"
// ===========================================================================

test("a hidden collector page pauses instead of completing", () => {
  const running = Queue.startSession(
    { items: Queue.enqueueUrls([], ["https://www.linkedin.com/in/a"], "t0").items, session: Queue.createSession() },
    "t0"
  );
  const paused = Queue.pauseForVisibility(running, "t1");
  assert.equal(paused.session.collectionState, Queue.COLLECTION_STATE.PAUSED_HIDDEN);
  assert.equal(paused.session.pausedBy, Queue.PAUSED_BY.VISIBILITY);
  assert.match(paused.session.pauseReason, /not rendering the hidden page/i);
  assert.equal(Queue.claimNext(paused, "t2").item, null, "no work may be claimed while hidden");
});

test("a visibility pause resumes by itself once the page is visible again", () => {
  const paused = Queue.pauseForVisibility(
    Queue.startSession({ items: [], session: Queue.createSession() }, "t0"),
    "t1"
  );
  assert.equal(Queue.canResumeFromVisibility(paused.session), true, "the collector may resume itself");

  const challenge = Queue.pauseSession(paused, "t1", "CAPTCHA", "captcha");
  assert.equal(Queue.canResumeFromVisibility(challenge.session), false, "a challenge still needs a human");
});

test("a hidden page is never treated as fully discovered or extracted", async () => {
  for (const file of ["connections.js", "content.js"]) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.match(source, /document\.visibilityState === "visible"/, `${file} must check page visibility`);
    assert.match(source, /addEventListener\("visibilitychange"/, `${file} must react to the page being hidden`);
    assert.match(source, /state\.wentHidden = true/, `${file} must remember that the page went hidden mid-run`);
  }

  // Discovery reports a hidden page as an interruption, never as the list's end.
  const connections = await readFile(resolve(root, "connections.js"), "utf8");
  assert.match(connections, /hidden: true,\s*\n\s*visibilityState/, "a hidden pass must be flagged");
  const hiddenReturns = [...connections.matchAll(/hidden: true[\s\S]{0,320}?atBottom: false/g)];
  assert.ok(hiddenReturns.length >= 2, "every hidden exit must report atBottom: false so it cannot read as finished");

  // Extraction aborts before a profile is ever assembled.
  const content = await readFile(resolve(root, "content.js"), "utf8");
  assert.match(content, /function hiddenPageError/, "a hidden page must abort the scan");
  const scanAbort = content.indexOf("if (!isPageVisible() || state.wentHidden) throw hiddenPageError();");
  const profileBuild = content.indexOf("const profile = {");
  assert.ok(scanAbort > 0 && scanAbort < profileBuild, "the scan must abort before the profile is assembled");
  assert.match(content, /hidden: Boolean\(error\?\.hidden\)/, "the worker must be told it was a hidden page, not a bad profile");
});

test("the worker pauses on a hidden collector and keeps the tab active", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /pauseForVisibility/, "a hidden page must pause the run");
  assert.match(worker, /prepareCollectorStep\(tabId\)/, "the collector tab must be made active per step");
  assert.match(worker, /canResumeFromVisibility/, "it must resume once the page is visible again");
  assert.match(worker, /async function resumeFromHidden/, "and resuming must be its own path");

  // Activating the tab and un-minimizing its window now live in the tab core,
  // which is where tests/collector-tabs.test.js drives them against a fake Chrome.
  const tabsCore = await readFile(resolve(root, "src/collector-tabs-core.js"), "utf8");
  assert.match(tabsCore, /tabs\.update\(id, \{ active: true \}\)/, "the collector tab must be made active");
  assert.match(tabsCore, /windows\.update\(windowId, \{ state: "normal", focused: false \}\)/,
    "the window must be raised out of a minimized state without stealing focus");
});
