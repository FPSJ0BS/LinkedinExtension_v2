import test from "node:test";
import assert from "node:assert/strict";
import * as Queue from "../src/import-queue-core.js";

const URLS = [
  "https://www.linkedin.com/in/alpha-person",
  "https://www.linkedin.com/in/beta-person",
  "https://www.linkedin.com/in/gamma-person"
];

const T0 = "2026-08-02T00:00:00.000Z";
function at(minutes) {
  return new Date(Date.parse(T0) + minutes * 60000).toISOString();
}
const T1 = at(1);

function seeded(urls = URLS, sessionPatch = {}) {
  const { items } = Queue.enqueueUrls([], urls, T0);
  return { items, session: Queue.createSession(sessionPatch) };
}

function running(urls = URLS, options = {}) {
  return Queue.startSession(seeded(urls), T0, options);
}

// ------------------------------------------------------------------ enqueueing

test("enqueue adds new URLs once and reports duplicates", () => {
  const first = Queue.enqueueUrls([], [URLS[0], URLS[1]], T0);
  assert.equal(first.added, 2);
  assert.equal(first.duplicates, 0);
  assert.deepEqual(first.addedUrls, [URLS[0], URLS[1]]);

  const second = Queue.enqueueUrls(first.items, [URLS[1], URLS[2], ""], T0);
  assert.equal(second.added, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(second.items.length, 3);
});

test("deduplication holds across passes and restarts, ignoring case", () => {
  const first = Queue.enqueueUrls([], [URLS[0]], T0);
  const second = Queue.enqueueUrls(first.items, ["HTTPS://WWW.LINKEDIN.COM/IN/ALPHA-PERSON"], T1);
  assert.equal(second.added, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(second.items.length, 1);
});

test("re-enqueuing a completed URL does not reset it to pending", () => {
  const state = Queue.markCompleted(running([URLS[0]]), URLS[0], T1, "profile_x");
  const again = Queue.enqueueUrls(state.items, [URLS[0]], T1);
  assert.equal(again.added, 0);
  assert.equal(Queue.findItem(again.items, URLS[0]).status, Queue.ITEM_STATUS.COMPLETED);
});

// ------------------------------------------------------- one-at-a-time claiming

test("claimNext processes exactly one profile at a time", () => {
  const first = Queue.claimNext(running(), T0);
  assert.equal(first.item.url, URLS[0]);
  assert.equal(first.item.status, Queue.ITEM_STATUS.PROCESSING);

  const second = Queue.claimNext({ items: first.items, session: first.session }, T0);
  assert.equal(second.item, null);
  assert.equal(second.reason, "busy");
  assert.equal(Queue.queueStats(second.items).processing, 1);
});

test("claimNext refuses to run unless the session is running", () => {
  for (const status of [Queue.SESSION_STATUS.IDLE, Queue.SESSION_STATUS.PAUSED, Queue.SESSION_STATUS.STOPPED]) {
    const claim = Queue.claimNext(seeded(URLS, { status }), T0);
    assert.equal(claim.item, null);
    assert.equal(claim.reason, "not-running");
  }
});

test("a completed profile advances the session and frees the slot", () => {
  const claim = Queue.claimNext(running(), T0);
  const done = Queue.markCompleted({ items: claim.items, session: claim.session }, URLS[0], T1, "profile_a");
  assert.equal(Queue.findItem(done.items, URLS[0]).status, Queue.ITEM_STATUS.COMPLETED);
  assert.equal(done.session.processedInSession, 1);
  assert.equal(done.session.processedTotal, 1);
  assert.equal(Queue.claimNext(done, T1).item.url, URLS[1]);
});

test("an empty queue returns the session to idle", () => {
  const claim = Queue.claimNext(running([URLS[0]]), T0);
  const done = Queue.markCompleted({ items: claim.items, session: claim.session }, URLS[0], T1, "");
  const drained = Queue.claimNext(done, T1);
  assert.equal(drained.reason, "empty");
  assert.equal(drained.session.status, Queue.SESSION_STATUS.IDLE);
});

// ------------------------------------------- phase 29: failure kinds and backoff

test("a permanent failure never retries", () => {
  const claim = Queue.claimNext(running([URLS[0]]), T0);
  const failed = Queue.markFailed({ items: claim.items, session: claim.session }, URLS[0], T1, "This profile is unavailable.");
  assert.equal(failed.failureKind, Queue.FAILURE_KIND.PERMANENT);
  assert.equal(failed.exhausted, true);
  const item = Queue.findItem(failed.items, URLS[0]);
  assert.equal(item.status, Queue.ITEM_STATUS.FAILED);
  assert.equal(item.attempts, 1, "a permanent failure must not burn three attempts");
});

test("a transient failure retries with exponential backoff, then gives up", () => {
  let state = running([URLS[0]]);
  let exhausted = false;
  for (let attempt = 0; attempt < Queue.MAX_ATTEMPTS; attempt += 1) {
    const claim = Queue.claimNext(state, at(attempt * 10));
    assert.ok(claim.item, `attempt ${attempt + 1} should claim the item`);
    const failed = Queue.markFailed({ items: claim.items, session: claim.session }, URLS[0], at(attempt * 10), "Timed out waiting for the page to load.");
    assert.equal(failed.failureKind, Queue.FAILURE_KIND.TRANSIENT);
    exhausted = failed.exhausted;
    state = { items: failed.items, session: failed.session };
  }
  assert.equal(exhausted, true);
  assert.equal(Queue.findItem(state.items, URLS[0]).status, Queue.ITEM_STATUS.FAILED);
  assert.equal(Queue.claimNext(state, at(600)).item, null);
});

test("an item inside its backoff window is not claimed yet", () => {
  const claim = Queue.claimNext(running([URLS[0]]), T0);
  const failed = Queue.markFailed({ items: claim.items, session: claim.session }, URLS[0], T0, "Timed out.");
  const item = Queue.findItem(failed.items, URLS[0]);
  assert.equal(item.status, Queue.ITEM_STATUS.PENDING);
  assert.ok(item.nextAttemptAt, "a transient retry must schedule a next attempt");

  const tooSoon = Queue.claimNext({ items: failed.items, session: failed.session }, T0);
  assert.equal(tooSoon.item, null);
  assert.equal(tooSoon.reason, "backoff");

  const later = Queue.claimNext({ items: failed.items, session: failed.session }, at(5));
  assert.equal(later.item.url, URLS[0]);
});

test("backoff grows with each attempt", () => {
  assert.ok(Queue.backoffDelayMs(2) > Queue.backoffDelayMs(1));
  assert.ok(Queue.backoffDelayMs(3) > Queue.backoffDelayMs(2));
});

test("retryFailed clears attempts, errors, and backoff", () => {
  const claim = Queue.claimNext(running([URLS[0]]), T0);
  const failed = Queue.markFailed({ items: claim.items, session: claim.session }, URLS[0], T0, "This page doesn't exist");
  const retried = Queue.retryFailed(failed, T1);
  const item = Queue.findItem(retried.items, URLS[0]);
  assert.equal(item.status, Queue.ITEM_STATUS.PENDING);
  assert.equal(item.attempts, 0);
  assert.equal(item.nextAttemptAt, "");
  assert.equal(item.failureKind, "");
});

// --------------------------------------- D3: batch cap, cooldown, auto-continue

test("reaching the batch cap pauses into a cooldown, not a stop", () => {
  let state = running(URLS, { sessionLimit: 2, cooldownMs: 60000 });
  for (let index = 0; index < 2; index += 1) {
    const claim = Queue.claimNext(state, T0);
    state = Queue.markCompleted({ items: claim.items, session: claim.session }, claim.item.url, T0, "");
  }
  const blocked = Queue.claimNext(state, T0);
  assert.equal(blocked.item, null);
  assert.equal(blocked.reason, "limit-reached");
  assert.equal(blocked.session.status, Queue.SESSION_STATUS.PAUSED);
  assert.equal(blocked.session.pausedBy, Queue.PAUSED_BY.COOLDOWN);
  assert.ok(blocked.session.cooldownUntil, "a cooldown deadline must be recorded");
  assert.match(blocked.session.pauseReason, /cap of 2/i);
});

test("a cooldown elapses on its own and the next batch starts", () => {
  const session = Queue.createSession({
    status: Queue.SESSION_STATUS.PAUSED,
    pausedBy: Queue.PAUSED_BY.COOLDOWN,
    cooldownUntil: at(5),
    batchNumber: 1
  });
  assert.equal(Queue.cooldownElapsed(session, at(4)), false, "must not resume early");
  assert.equal(Queue.cooldownElapsed(session, at(6)), true);

  const recovered = Queue.recoverAfterInterruption({ items: [], session }, at(6));
  assert.equal(recovered.resumed, true);
  assert.equal(recovered.reason, "cooldown-elapsed");
  assert.equal(recovered.session.status, Queue.SESSION_STATUS.RUNNING);
  assert.equal(recovered.session.batchNumber, 2);
  assert.equal(recovered.session.processedInSession, 0);
});

test("a challenge pause never auto-resumes even if a cooldown deadline exists", () => {
  const session = Queue.createSession({
    status: Queue.SESSION_STATUS.PAUSED,
    pausedBy: Queue.PAUSED_BY.CHALLENGE,
    challengeKind: "captcha",
    cooldownUntil: at(1)
  });
  assert.equal(Queue.cooldownElapsed(session, at(99)), false);
  const recovered = Queue.recoverAfterInterruption({ items: [], session }, at(99));
  assert.equal(recovered.resumed, false);
  assert.equal(recovered.session.status, Queue.SESSION_STATUS.PAUSED);
});

// ------------------------------------------------- D2: suspension vs challenge

test("an interrupted run resumes automatically after service-worker suspension", () => {
  const claim = Queue.claimNext(running(), T0);
  const recovered = Queue.recoverAfterInterruption({ items: claim.items, session: claim.session }, T1);

  assert.equal(recovered.resumed, true);
  assert.equal(recovered.reason, "interrupted-run");
  assert.equal(recovered.session.status, Queue.SESSION_STATUS.RUNNING);
  assert.equal(Queue.queueStats(recovered.items).processing, 0, "nothing may be left stranded in processing");
  assert.equal(Queue.findItem(recovered.items, URLS[0]).status, Queue.ITEM_STATUS.PENDING);
  assert.equal(Queue.claimNext(recovered, T1).item.url, URLS[0]);
});

test("recovery never resumes a user pause, a challenge, or a navigation trip", () => {
  const cases = [
    Queue.pauseSession(seeded(), T0, "Paused by the user.", "", Queue.PAUSED_BY.USER),
    Queue.pauseSession(seeded(), T0, "CAPTCHA shown.", "captcha"),
    Queue.pauseSession(seeded(), T0, "Repeated navigation failures.", "", Queue.PAUSED_BY.NAVIGATION),
    Queue.stopSession(seeded(), T0)
  ];
  for (const state of cases) {
    const recovered = Queue.recoverAfterInterruption(state, at(120));
    assert.equal(recovered.resumed, false, `${state.session.pausedBy || state.session.status} must not auto-resume`);
    assert.equal(Queue.claimNext(recovered, at(120)).item, null);
  }
});

test("a challenge pause records why and blocks claiming", () => {
  const claim = Queue.claimNext(running(), T0);
  const paused = Queue.pauseSession({ items: claim.items, session: claim.session }, T1, "CAPTCHA shown.", "captcha");
  assert.equal(paused.session.pausedBy, Queue.PAUSED_BY.CHALLENGE);
  assert.equal(paused.session.challengeKind, "captcha");
  assert.equal(Queue.claimNext(paused, T1).item, null);

  const resumed = Queue.resumeSession(paused, T1);
  assert.equal(resumed.session.status, Queue.SESSION_STATUS.RUNNING);
  assert.equal(resumed.session.challengeKind, "");
  assert.equal(Queue.findItem(resumed.items, URLS[0]).status, Queue.ITEM_STATUS.PENDING);
});

test("stop and skip behave as before", () => {
  const claim = Queue.claimNext(running(), T0);
  const stopped = Queue.stopSession({ items: claim.items, session: claim.session }, T1);
  assert.equal(stopped.session.status, Queue.SESSION_STATUS.STOPPED);
  assert.equal(Queue.findItem(stopped.items, URLS[0]).status, Queue.ITEM_STATUS.PENDING);

  const claimAgain = Queue.claimNext(running(), T0);
  const skipped = Queue.markSkipped({ items: claimAgain.items, session: claimAgain.session }, URLS[0], T1);
  assert.equal(Queue.findItem(skipped.items, URLS[0]).status, Queue.ITEM_STATUS.SKIPPED);
  assert.equal(Queue.claimNext(skipped, T1).item.url, URLS[1]);
});

test("repeated navigation failures pause the session", () => {
  let state = running();
  let tripped = false;
  for (let attempt = 0; attempt < Queue.MAX_NAVIGATION_FAILURES; attempt += 1) {
    const result = Queue.registerNavigationFailure(state, T1, "Timed out waiting for the page to load.");
    tripped = result.tripped;
    state = { items: result.items, session: result.session };
  }
  assert.equal(tripped, true);
  assert.equal(state.session.status, Queue.SESSION_STATUS.PAUSED);
  assert.equal(state.session.pausedBy, Queue.PAUSED_BY.NAVIGATION);
});

// -------------------------------------------- phase 27: refresh / freshness

test("a recently collected profile is skipped as fresh unless forced", () => {
  const session = Queue.createSession({ refreshMaxAgeDays: 30 });
  assert.equal(Queue.shouldSkipAsFresh(session, at(-60 * 24 * 5), T0), true, "5 days old is fresh");
  assert.equal(Queue.shouldSkipAsFresh(session, at(-60 * 24 * 45), T0), false, "45 days old is stale");
  assert.equal(Queue.shouldSkipAsFresh(session, "", T0), false, "never collected is not fresh");

  const forced = Queue.createSession({ refreshMaxAgeDays: 30, forceRefresh: true });
  assert.equal(Queue.shouldSkipAsFresh(forced, at(-60 * 24 * 5), T0), false, "force refresh overrides freshness");

  const disabled = Queue.createSession({ refreshMaxAgeDays: 0 });
  assert.equal(Queue.shouldSkipAsFresh(disabled, at(-60), T0), false, "a zero window disables skipping");
});

test("a fresh completion is marked and still counts as processed", () => {
  const claim = Queue.claimNext(running([URLS[0]]), T0);
  const done = Queue.markCompleted({ items: claim.items, session: claim.session }, URLS[0], T1, "profile_a", true);
  assert.equal(Queue.findItem(done.items, URLS[0]).fresh, true);
  assert.equal(done.session.processedInSession, 1);
});

// ---------------------------------- phases 21-24: discovery ledger and coverage

test("a discovery pass that finds nothing increments the quiet counter", () => {
  let session = Queue.createSession();
  session = { ...session, discovery: Queue.applyDiscoveryPass(session, { cursorY: 400, atBottom: false, paginationAvailable: false }, 0, T0) };
  assert.equal(session.discovery.passesWithoutGrowth, 1);
  assert.equal(session.discovery.passes, 1);
  assert.equal(session.discovery.cursorY, 400);
  assert.equal(session.discovery.exhausted, false);
});

test("growth or a pagination click resets the quiet counter", () => {
  let session = Queue.createSession();
  session = { ...session, discovery: Queue.applyDiscoveryPass(session, { atBottom: true, paginationAvailable: false }, 0, T0) };
  assert.equal(session.discovery.passesWithoutGrowth, 1);
  session = { ...session, discovery: Queue.applyDiscoveryPass(session, { atBottom: true, paginationAvailable: false }, 7, T0) };
  assert.equal(session.discovery.passesWithoutGrowth, 0);
  assert.equal(session.discovery.discovered, 7);

  // A pagination click is activity, not progress. Counting it as growth let a
  // control that revealed nothing reset the quiet counter on every pass, so
  // discovery could never conclude the list had ended — it ran forever live.
  session = { ...session, discovery: Queue.applyDiscoveryPass(session, { atBottom: true, clickedPagination: true }, 0, T0) };
  assert.equal(session.discovery.passesWithoutGrowth, 1, "a click that reveals nothing is not progress");
  assert.equal(session.discovery.paginationClicks, 1, "the click is still recorded");
  assert.equal(session.discovery.fruitlessPaginationClicks, 1);

  session = { ...session, discovery: Queue.applyDiscoveryPass(session, { atBottom: true, clickedPagination: true }, 4, T0) };
  assert.equal(session.discovery.passesWithoutGrowth, 0, "a click that reveals connections is progress");
  assert.equal(session.discovery.fruitlessPaginationClicks, 0);
});

test("a pagination control that never reveals anything stops counting as available", () => {
  let session = Queue.createSession();
  for (let index = 0; index < Queue.MAX_FRUITLESS_PAGINATION + Queue.DISCOVERY_QUIET_PASSES; index += 1) {
    session = {
      ...session,
      discovery: Queue.applyDiscoveryPass(session, { atBottom: true, paginationAvailable: true, clickedPagination: true }, 0, T0)
    };
  }
  assert.equal(session.discovery.exhausted, true, "a dead control must not keep discovery alive forever");
});

test("the list is only exhausted at the bottom, with no pagination, after quiet passes", () => {
  let session = Queue.createSession();
  for (let index = 0; index < Queue.DISCOVERY_QUIET_PASSES; index += 1) {
    session = { ...session, discovery: Queue.applyDiscoveryPass(session, { atBottom: true, paginationAvailable: false }, 0, T0) };
  }
  assert.equal(session.discovery.exhausted, true);
  assert.equal(session.discovery.coverageConfirmed, false, "exhaustion without a reliable total is only an estimate");

  let withPagination = Queue.createSession();
  for (let index = 0; index < Queue.DISCOVERY_QUIET_PASSES + 2; index += 1) {
    withPagination = { ...withPagination, discovery: Queue.applyDiscoveryPass(withPagination, { atBottom: true, paginationAvailable: true }, 0, T0) };
  }
  assert.equal(withPagination.discovery.exhausted, false, "a remaining pagination control means more work");
});

test("a reliable advertised total confirms full coverage", () => {
  let session = Queue.createSession();
  session = { ...session, discovery: Queue.applyDiscoveryPass(session, { total: 3, totalReliable: true, atBottom: false }, 3, T0) };
  assert.equal(session.discovery.coverageConfirmed, true);
  assert.equal(session.discovery.exhausted, true);
});

test("a rounded total such as 500+ never confirms coverage", () => {
  let session = Queue.createSession();
  session = { ...session, discovery: Queue.applyDiscoveryPass(session, { total: 500, totalReliable: false, atBottom: true }, 500, T0) };
  assert.equal(session.discovery.coverageConfirmed, false);
  assert.equal(session.discovery.totalCount, 500);
  assert.equal(session.discovery.totalReliable, false);
});

test("coverageReport describes discovered, processed, remaining, failed and confidence", () => {
  let state = running();
  const first = Queue.claimNext(state, T0);
  state = Queue.markCompleted({ items: first.items, session: first.session }, URLS[0], T0, "");
  const second = Queue.claimNext(state, T0);
  state = Queue.markFailed({ items: second.items, session: second.session }, URLS[1], T0, "This profile is unavailable.");
  state = { items: state.items, session: { ...state.session, discovery: Queue.applyDiscoveryPass(state.session, { total: 3, totalReliable: true, atBottom: true }, 3, T0) } };

  const report = Queue.coverageReport(state);
  assert.equal(report.discovered, 3);
  assert.equal(report.processed, 1);
  assert.equal(report.remaining, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.totalCount, 3);
  assert.equal(report.coverage, "confirmed");
  assert.equal(report.coverageConfirmed, true);
});

test("coverage is reported as estimated when the total is unusable", () => {
  let session = Queue.createSession();
  for (let index = 0; index < Queue.DISCOVERY_QUIET_PASSES; index += 1) {
    session = { ...session, discovery: Queue.applyDiscoveryPass(session, { atBottom: true, paginationAvailable: false }, 0, T0) };
  }
  const report = Queue.coverageReport({ items: [], session });
  assert.equal(report.coverage, "estimated");
  assert.equal(report.coverageConfirmed, false);
});

test("clearQueue resets the discovery ledger as well as the queue", () => {
  let state = running();
  state = { items: state.items, session: { ...state.session, discovery: Queue.applyDiscoveryPass(state.session, { total: 9, totalReliable: true, atBottom: true }, 9, T0) } };
  const cleared = Queue.clearQueue(state, T1);
  assert.deepEqual(cleared.items, []);
  assert.equal(cleared.session.discovery.passes, 0);
  assert.equal(cleared.session.discovery.discovered, 0);
  assert.equal(cleared.session.discovery.totalCount, null);
  assert.equal(cleared.session.processedTotal, 0);
});

test("summarize exposes cap, cooldown, batch and coverage to the dashboard", () => {
  const state = running(URLS, { sessionLimit: 25, cooldownMs: 120000 });
  const summary = Queue.summarize(state);
  assert.equal(summary.sessionLimit, 25);
  assert.equal(summary.cooldownMs, 120000);
  assert.equal(summary.batchNumber, 1);
  assert.equal(summary.status, Queue.SESSION_STATUS.RUNNING);
  assert.equal(summary.coverage.discovered, 3);
  assert.equal(summary.coverage.coverage, "unknown");
  assert.equal(summary.progress, 0);
});
