// Acceptance coverage for the automatic collector workflow.
//
//   Start Collecting -> check the LinkedIn session -> redirect the ONE collector
//   tab to the Connections page -> discover every connection -> automatically
//   extract them -> stop when the queue is done.
//
// There is no jsdom in this repo, so the page mechanics live in the pure cores
// and are exercised here against simulated pages and fixture data. Source-level
// assertions prove the content scripts and the service worker still route
// through those cores instead of re-implementing the policy.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

await import("../src/connections-core.js");
import * as Queue from "../src/import-queue-core.js";

const Connections = globalThis.ProfileVaultConnections;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

// ===========================================================================
// A. Authentication — session detection only, never a credential
// ===========================================================================

test("a rendered member page counts as signed in", () => {
  const verdict = Connections.classifyAuthState({
    url: BASE,
    title: "My Network | LinkedIn",
    bodyText: "67 Connections",
    memberMarkers: 3
  });
  assert.equal(verdict.state, Connections.AUTH_STATE.SIGNED_IN);
  assert.equal(verdict.signedIn, true);
});

test("a sign-in wall is reported as login required, not as an unknown state", () => {
  for (const url of [
    "https://www.linkedin.com/login",
    "https://www.linkedin.com/uas/login?session_redirect=%2Fmynetwork",
    "https://www.linkedin.com/authwall"
  ]) {
    const verdict = Connections.classifyAuthState({ url, memberMarkers: 0 });
    assert.equal(verdict.state, Connections.AUTH_STATE.LOGIN_REQUIRED, `${url} must require sign-in`);
    assert.equal(verdict.signedIn, false);
  }

  const fromText = Connections.classifyAuthState({
    url: BASE,
    bodyText: "Sign in to see who you know",
    memberMarkers: 0
  });
  assert.equal(fromText.state, Connections.AUTH_STATE.LOGIN_REQUIRED);
});

test("a checkpoint or CAPTCHA is reported as a checkpoint, never as signed in", () => {
  const checkpoint = Connections.classifyAuthState({ url: "https://www.linkedin.com/checkpoint/challenge/", memberMarkers: 5 });
  assert.equal(checkpoint.state, Connections.AUTH_STATE.CHECKPOINT);

  const captcha = Connections.classifyAuthState({
    url: BASE,
    bodyText: "Please solve this puzzle so we know you are a human",
    memberMarkers: 5
  });
  assert.equal(captcha.state, Connections.AUTH_STATE.CHECKPOINT);
  assert.equal(captcha.kind, "captcha");
});

test("a page with no member evidence is unknown rather than optimistically signed in", () => {
  const blank = Connections.classifyAuthState({ url: BASE, bodyText: "", memberMarkers: 0 });
  assert.equal(blank.state, Connections.AUTH_STATE.UNKNOWN, "an empty page must never read as signed in");

  const unreachable = Connections.classifyAuthState({ url: BASE, memberMarkers: 4, reachable: false });
  assert.equal(unreachable.state, Connections.AUTH_STATE.UNKNOWN);
});

// ===========================================================================
// B. The 67-card fixture: every advertised connection is accounted for
// ===========================================================================

async function loadFixture() {
  const html = await readFile(resolve(root, "tests/fixtures/linkedin-connections-67.html"), "utf8");
  const match = /<script id="pv-fixture" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "the fixture must publish its card manifest as JSON");
  return { html, fixture: JSON.parse(match[1]) };
}

/** Rebuild exactly the cards the fixture renders, as raw anchors and text. */
function fixtureCards(fixture) {
  const cards = [];
  let person = 0;
  for (let index = 0; index < fixture.plainCards; index += 1) {
    person += 1;
    cards.push({ links: [`/in/person-${person}/`], text: `Person ${person} Message Connect` });
  }
  // The same person behind a photo link and a name link.
  for (let index = 0; index < fixture.doubleLinkedCards; index += 1) {
    person += 1;
    cards.push({ links: [`/in/person-${person}/`, `/in/person-${person}/`], text: `Person ${person} Message Connect` });
  }
  for (let index = 0; index < fixture.restrictedCards; index += 1) {
    cards.push({ links: [], text: "LinkedIn Member — this profile is unavailable" });
  }
  return cards;
}

/** What connections.js does per scan: read cards, tally them, merge the URLs. */
function readCards(cards, ledger, collector) {
  for (const card of cards) {
    const canonical = card.links.map((href) => Connections.canonicalizeConnectionUrl(href, BASE)).filter(Boolean);
    const url = canonical[0] || "";
    ledger.noteCard({
      url,
      text: card.text,
      restricted: !url && /unavailable|linkedin member/i.test(card.text)
    });
    for (const value of canonical) ledger.noteLink(value);
    if (url) collector.absorb([{ url, name: card.text }]);
  }
}

test("a 67-card list reconciles as 66 usable, 1 without a URL, and 3 duplicate links", async () => {
  const { fixture } = await loadFixture();
  const cards = fixtureCards(fixture);
  assert.equal(cards.length, 67, "the fixture must render exactly 67 cards");

  const ledger = Connections.createCardLedger();
  const collector = Connections.createEntryCollector(BASE);
  readCards(cards, ledger, collector);

  assert.equal(collector.size, fixture.expected.uniqueUrls, "66 unique profile URLs must be collected");
  assert.equal(ledger.cardsSeen, fixture.expected.cardsSeen);
  assert.equal(ledger.usableCards, fixture.expected.uniqueUrls);
  assert.equal(ledger.cardsWithoutUrl, fixture.expected.cardsWithoutUrl, "the restricted card must be counted, not ignored");
  assert.equal(ledger.restrictedCards, fixture.expected.restrictedCards);
  assert.equal(ledger.duplicateLinks, fixture.expected.duplicateLinks, "photo and name links to one person are one connection");

  const report = Connections.reconcileDiscovery({
    advertisedTotal: fixture.advertisedTotal,
    totalReliable: fixture.totalReliable,
    uniqueUrls: collector.size,
    duplicateLinks: ledger.duplicateLinks,
    cardsWithoutUrl: ledger.cardsWithoutUrl,
    restrictedCards: ledger.restrictedCards
  });

  assert.equal(report.accountedFor, fixture.expected.accountedFor, "66 usable + 1 unusable must account for all 67");
  assert.equal(report.unexplained, fixture.expected.unexplained);
  assert.equal(report.balanced, fixture.expected.balanced);
  assert.ok(
    report.explanation.some((line) => /67 connection\(s\); 66 have a usable profile URL/.test(line)),
    "the report must state the difference in plain words"
  );
  assert.ok(report.explanation.some((line) => /restricted, out of network, or no longer available/.test(line)));
  assert.ok(report.explanation.some((line) => /Every connection LinkedIn advertised is accounted for/.test(line)));
});

test("re-reading the same virtualized cards does not inflate any count", async () => {
  const { fixture } = await loadFixture();
  const cards = fixtureCards(fixture);
  const ledger = Connections.createCardLedger();
  const collector = Connections.createEntryCollector(BASE);

  // Five scans over the same rendered window, exactly as a stalled list produces.
  for (let scan = 0; scan < 5; scan += 1) readCards(cards, ledger, collector);

  assert.equal(collector.size, 66);
  assert.equal(ledger.cardsSeen, 67, "a repeated read must not count a card twice");
  assert.equal(ledger.cardsWithoutUrl, 1);
  // Anchor identity is the content script's job; the ledger counts every call,
  // so this is what proves connections.js must dedupe by element (it does).
  assert.ok(ledger.duplicateLinks > 0, "repeat links are still visible to the ledger");
});

test("an unaccounted-for remainder is called out instead of looking like success", () => {
  const short = Connections.reconcileDiscovery({
    advertisedTotal: 67,
    totalReliable: true,
    uniqueUrls: 10,
    duplicateLinks: 0,
    cardsWithoutUrl: 0,
    restrictedCards: 0
  });
  assert.equal(short.balanced, false);
  assert.equal(short.unexplained, 57);
  assert.ok(
    short.explanation.some((line) => /57 connection\(s\) are still unaccounted for/.test(line)),
    "an early stop must be stated, not hidden"
  );
});

test("a rounded advertised total never claims to be balanced arithmetic", () => {
  const rounded = Connections.reconcileDiscovery({
    advertisedTotal: 500,
    totalReliable: false,
    uniqueUrls: 512,
    duplicateLinks: 4,
    cardsWithoutUrl: 0,
    restrictedCards: 0
  });
  assert.equal(rounded.totalReliable, false);
  assert.ok(rounded.explanation[0].includes("500+"), "a rounded total must be shown as rounded");
  assert.ok(rounded.explanation.some((line) => /more card\(s\) were found than LinkedIn advertised/.test(line)));
});

test("with no advertised total the report still explains what was collected", () => {
  const report = Connections.reconcileDiscovery({ advertisedTotal: null, uniqueUrls: 12, cardsWithoutUrl: 1 });
  assert.equal(report.unexplained, null);
  assert.equal(report.balanced, false);
  assert.ok(report.explanation[0].includes("did not advertise a connection total"));
});

test("the connections script tallies every rendered card through the tested ledger", async () => {
  const source = await readFile(resolve(root, "connections.js"), "utf8");
  assert.match(source, /Core\.createCardLedger\(\)/, "card counting must use the tested pure ledger");
  assert.match(source, /Core\.reconcileDiscovery\(/, "the pass must report reconciled counts");
  assert.match(source, /function tallyCards/, "every card must be tallied, not just the working ones");
  assert.match(source, /UNAVAILABLE_CARD_PATTERN/, "restricted members must be recognized");
  assert.match(source, /ledger\.noteCard\(\{ url: "", text: cardText\(element\), restricted: true \}\)/);
  assert.match(source, /countedAnchors\.get\(anchor\) !== url/, "an anchor must not be counted twice across scans");
  assert.match(source, /tallyCards\(current, ledger, countedAnchors\)/, "the tally must run on every scan");
});

test("both content scripts answer the session check without touching a credential", async () => {
  for (const file of ["connections.js", "content.js"]) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.match(source, /message\?\.type === "PV_CHECK_LOGIN"/, `${file} must answer the session check`);
    assert.match(source, /classifyAuthState\(/, `${file} must use the tested classifier`);
  }
});

test("the 67-card reconciliation fixture exists for the manual browser check", async () => {
  const { html, fixture } = await loadFixture();
  assert.equal(fixture.advertisedTotal, 67);
  assert.equal(fixture.plainCards + fixture.doubleLinkedCards + fixture.restrictedCards, 67);
  assert.match(html, /id="scaffold"/, "the fixture must reproduce the wrapper-scrolling layout");
  assert.match(html, /people-filter/, "the decoy scrollable panel must be present");
  assert.match(html, /LinkedIn Member/, "the restricted card must be rendered");
  assert.match(html, /src="\.\.\/\.\.\/connections\.js"/, "the fixture must exercise the real content script");
});

// ===========================================================================
// C. Discovery terminates — no infinite loops
// ===========================================================================

/** A page that renders a fixed set of cards and never loads another one. */
function stalledPage() {
  return {
    top: 0,
    max: 400,
    atBottom() { return this.top >= this.max - 8; },
    step() { this.top = Math.min(this.top + 300, this.max); }
  };
}

test("discovery over a list that never grows stops on its own in a bounded number of steps", () => {
  const page = stalledPage();
  let idleAtBottom = 0;
  let steps = 0;
  let done = null;

  for (let guard = 0; guard < 500; guard += 1) {
    const plan = Connections.planDiscoveryStep({
      atBottom: page.atBottom(),
      grew: false,
      idleAtBottom,
      paginationAvailable: false,
      steps,
      maxSteps: Connections.DISCOVERY_STEPS_PER_PASS
    });
    idleAtBottom = plan.idleAtBottom;
    if (plan.action === Connections.DISCOVERY_ACTION.DONE) {
      done = plan;
      break;
    }
    if (plan.action === Connections.DISCOVERY_ACTION.SCROLL) page.step();
    steps += 1;
  }

  assert.ok(done, "the planner must reach a terminal state");
  assert.equal(done.reason, "list-end");
  assert.equal(done.exhausted, true);
  assert.ok(steps < 40, `it must not spin: took ${steps} steps`);
});

test("a pass can never run past its step budget", () => {
  const plan = Connections.planDiscoveryStep({
    atBottom: false,
    grew: true,
    steps: Connections.DISCOVERY_STEPS_PER_PASS,
    maxSteps: Connections.DISCOVERY_STEPS_PER_PASS
  });
  assert.equal(plan.action, Connections.DISCOVERY_ACTION.DONE);
  assert.equal(plan.reason, "step-budget");
  assert.equal(plan.exhausted, false, "a budget stop must never claim the list is finished");
});

test("navigation waits for the new page, not the previous page's completed status", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /function waitForTabComplete\(tabId: number, expectedUrl = ""/, "the wait must know where it is going");
  assert.match(worker, /function sameTarget/, "a stale URL must be distinguishable from the target");
  assert.match(worker, /await waitForTabComplete\(tabId, item\.url\)/, "each profile must wait for its own URL");
  assert.match(
    worker,
    /await waitForTabComplete\(tabId, CONNECTIONS_URL\)/,
    "the Connections redirect must wait for the Connections page"
  );

  const body = worker.slice(worker.indexOf("const onUpdated = (updatedTabId: number"), worker.indexOf("const onRemoved ="));
  assert.match(body, /sameTarget\(current, previousUrl\)/, "a redirect away from the old page must still count as arriving");
});

test("the worker bounds its own discovery passes and honours an abort", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const budget = /MAX_DISCOVERY_PASSES = (\d+)/.exec(worker);
  assert.ok(budget && Number(budget[1]) > 0 && Number(budget[1]) <= 1000, "pass count must be bounded");
  assert.match(worker, /for \(let pass = 0; pass < maxPasses; pass \+= 1\)/, "the pass loop must be bounded");
  assert.match(worker, /if \(!isCurrent\(generation\)\)/, "Stop and Clear must be able to end a running pass");
});

// ===========================================================================
// D. Clear Queue, stop reasons, and surviving a closed popup
// ===========================================================================

function queued(urls, now = "2026-07-01T00:00:00.000Z") {
  return { items: Queue.enqueueUrls([], urls, now).items, session: Queue.createSession() };
}

test("Clear Queue empties the queue and its counters without touching saved profiles", () => {
  let state = Queue.startSession(queued(["https://www.linkedin.com/in/a", "https://www.linkedin.com/in/b"]), "t0");
  const claimed = Queue.claimNext(state, "t1");
  state = Queue.markCompleted({ items: claimed.items, session: claimed.session }, "https://www.linkedin.com/in/a", "t1", "profile-a");
  assert.equal(state.session.processedTotal, 1);

  const cleared = Queue.clearQueue(state, "t2");
  assert.deepEqual(cleared.items, [], "the discovered list must be emptied");
  assert.equal(cleared.session.status, Queue.SESSION_STATUS.IDLE);
  assert.equal(cleared.session.processedTotal, 0, "counters must reset");
  assert.equal(cleared.session.processedInSession, 0);
  assert.equal(cleared.session.discovery.discovered, 0, "discovery progress must reset");
  assert.equal(cleared.session.stopReason, Queue.STOP_REASON.QUEUE_CLEARED);

  // Nothing in the pure state machine can reach the saved-profile store; the
  // completed record's id survives in the caller's hands, not in the queue.
  assert.ok(!Object.keys(cleared.session).some((key) => /profile(?!Id)/i.test(key)));
});

test("a cleared queue cannot claim the work it used to hold", () => {
  const cleared = Queue.clearQueue(Queue.startSession(queued(["https://www.linkedin.com/in/a"]), "t0"), "t1");
  const claim = Queue.claimNext(cleared, "t2");
  assert.equal(claim.item, null);
  assert.equal(claim.reason, "not-running");
});

test("the queue keeps running after the popup and importer page are closed", () => {
  // Closing a page changes nothing: the loop is driven by the worker over
  // persisted state. A suspension mid-profile is the real risk, and recovery
  // returns the in-flight row to pending and continues.
  let state = Queue.startSession(queued(["https://www.linkedin.com/in/a", "https://www.linkedin.com/in/b"]), "t0");
  const claimed = Queue.claimNext(state, "t1");
  assert.equal(claimed.item.status, Queue.ITEM_STATUS.PROCESSING);

  const recovered = Queue.recoverAfterInterruption({ items: claimed.items, session: claimed.session }, "t2");
  assert.equal(recovered.resumed, true, "an interrupted run must continue on its own");
  assert.equal(recovered.reason, "interrupted-run");
  assert.ok(recovered.items.every((item) => item.status !== Queue.ITEM_STATUS.PROCESSING));

  const next = Queue.claimNext(recovered, "t3");
  assert.ok(next.item, "work must continue with no UI open");
});

test("a challenge pause survives a worker restart and is never auto-resumed", () => {
  const paused = Queue.pauseSession(
    Queue.startSession(queued(["https://www.linkedin.com/in/a"]), "t0"),
    "t1",
    "A CAPTCHA is being shown.",
    "captcha"
  );
  assert.equal(paused.session.stopReason, Queue.STOP_REASON.CHALLENGE);

  const recovered = Queue.recoverAfterInterruption(paused, "t2");
  assert.equal(recovered.resumed, false, "a challenge must always wait for a human");
});

test("every way a run can end reports a distinct reason", () => {
  const started = Queue.startSession(queued(["https://www.linkedin.com/in/a"]), "t0");
  assert.equal(started.session.stopReason, "", "a running session has no stop reason");

  assert.equal(Queue.stopSession(started, "t1").session.stopReason, Queue.STOP_REASON.USER_STOPPED);
  assert.equal(Queue.clearQueue(started, "t1").session.stopReason, Queue.STOP_REASON.QUEUE_CLEARED);
  assert.equal(
    Queue.pauseSession(started, "t1", "Not signed in.", "login").session.stopReason,
    Queue.STOP_REASON.LOGIN_REQUIRED
  );
  assert.equal(
    Queue.pauseSession(started, "t1", "boom", "", Queue.PAUSED_BY.ERROR).session.stopReason,
    Queue.STOP_REASON.ERROR
  );

  // Draining the queue is a completion, not a silent stop.
  const claimed = Queue.claimNext(started, "t1");
  const completed = Queue.markCompleted({ items: claimed.items, session: claimed.session }, "https://www.linkedin.com/in/a", "t1", "id");
  const drained = Queue.claimNext(completed, "t2");
  assert.equal(drained.reason, "empty");
  assert.equal(drained.session.stopReason, Queue.STOP_REASON.QUEUE_COMPLETE);
  assert.match(Queue.stopReasonText(drained.session.stopReason), /Every queued connection/);
});

test("repeated navigation failures stop the run with their own reason", () => {
  let state = Queue.startSession(queued(["https://www.linkedin.com/in/a"]), "t0");
  for (let attempt = 0; attempt < Queue.MAX_NAVIGATION_FAILURES; attempt += 1) {
    state = Queue.registerNavigationFailure(state, "t1", "Timed out waiting for the page to load.");
  }
  assert.equal(state.session.status, Queue.SESSION_STATUS.PAUSED);
  assert.equal(state.session.stopReason, Queue.STOP_REASON.NAVIGATION);
});

// ===========================================================================
// E. Manual controls stay independent of the automatic workflow
// ===========================================================================

test("manual discovery saves the list without starting any extraction", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const start = worker.indexOf("async function discoveryOnlyWorkflow");
  assert.ok(start > 0, "the discovery-only workflow must exist as its own function");
  // Everything up to the next top-level section banner is this function's body.
  const rest = worker.slice(start);
  const body = rest.slice(0, rest.indexOf("\n// ---"));
  assert.match(body, /runDiscovery\(/, "Find All Connections must enumerate the list");
  assert.ok(!/Queue\.startSession/.test(body), "Find All Connections must never start extraction");
  assert.ok(
    !/Tabs\.ensureProfileTab\(/.test(body),
    "Find All Connections must never open the profile collector tab either"
  );
  assert.match(body, /checkLoginState\(\)/, "it must still refuse to scan a signed-out browser");

  // And the command that triggers it must not start a session either.
  const branch = worker.slice(worker.indexOf("if (type === IMPORT_MESSAGES.DISCOVER "));
  const commandBody = branch.slice(0, branch.indexOf("IMPORT_MESSAGES.START_COLLECTING"));
  assert.match(commandBody, /discoveryOnlyWorkflow\(/);
  assert.ok(!/Queue\.startSession/.test(commandBody), "the discover command must never start extraction");
});

// Reported as "nothing is happening": after the first run ended, BOTH connections
// buttons were permanent no-ops. All four terminal states move to exactly one
// place — idle — so `moveCollectionTo(OPENING_CONNECTIONS)` was refused, and both
// workflows opened with a bare `if (!(await ...)) return`, a SILENT return. The
// command branch had already replied `started: true` and the page said
// "Collecting…". The only escape was Clear Queue, which throws away the whole
// discovered list to unstick a state machine.
test("a finished, stopped or failed run can be started again without clearing the queue", () => {
  // The state machine's own rule, unchanged: a terminal state goes to idle and
  // nowhere else. This is what made the bare guard a dead button.
  for (const terminal of [
    Queue.COLLECTION_STATE.COMPLETED,
    Queue.COLLECTION_STATE.COMPLETED_WITH_GAP,
    Queue.COLLECTION_STATE.STOPPED,
    Queue.COLLECTION_STATE.FAILED
  ]) {
    assert.ok(Queue.isTerminalCollectionState(terminal), `${terminal} must be terminal`);
    assert.ok(
      !Queue.canTransitionCollection(terminal, Queue.COLLECTION_STATE.OPENING_CONNECTIONS),
      `${terminal} -> opening_connections must stay refused; that is the guard`
    );
    assert.ok(
      Queue.canTransitionCollection(terminal, Queue.COLLECTION_STATE.IDLE),
      `${terminal} -> idle is the "explicitly starting over" move the button now makes`
    );

    // Starting over is that move followed by the one the guard wanted, and it
    // carries the queue with it: resetting touches the collection state only.
    const session = { ...Queue.createSession(), collectionState: terminal, discoveryExhausted: true };
    const idle = Queue.transitionCollection(session, Queue.COLLECTION_STATE.IDLE, "t1");
    assert.equal(idle.changed, true, `${terminal} must be resettable`);
    const opening = Queue.transitionCollection(idle.session, Queue.COLLECTION_STATE.OPENING_CONNECTIONS, "t2");
    assert.equal(opening.changed, true, `${terminal} must then be able to start a run`);
    assert.equal(opening.session.discoveryExhausted, true, "and the queue's own fields ride along untouched");
  }

  // A state that is genuinely mid-run is NOT reset: that refusal is what makes a
  // service-worker wake-up idempotent instead of a second discovery.
  for (const active of [
    Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS,
    Queue.COLLECTION_STATE.EXTRACTING_PROFILE
  ]) {
    assert.ok(!Queue.isTerminalCollectionState(active), `${active} must not be treated as terminal`);
  }
});

test("a connections command resets a terminal run and never refuses in silence", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");

  const start = worker.indexOf("async function beginConnectionsRun");
  assert.ok(start > 0, "the direct-command entry must exist as its own function");
  const body = worker.slice(start, worker.indexOf("\n/**", start + 1));

  assert.match(body, /Queue\.isTerminalCollectionState\(from\)/,
    "a finished, stopped or failed run is what gets reset");
  assert.match(body, /await moveCollectionTo\(Queue\.COLLECTION_STATE\.IDLE\)/,
    "and it is reset through the state machine, not by writing the field");
  assert.match(body, /await moveCollectionTo\(Queue\.COLLECTION_STATE\.OPENING_CONNECTIONS\)/,
    "then it takes the transition the guard always wanted");
  assert.match(body, /lastError:/, "and a refusal names the state that refused it");
  assert.ok(!/clearQueue|Queue\.clearQueue|deleteProfile/.test(body),
    "starting over must never throw the discovered list away — Clear Queue is a separate action");

  // Both buttons take it, and the bare silent guard is gone from both.
  for (const workflow of ["startCollectingWorkflow", "discoveryOnlyWorkflow"]) {
    const at = worker.indexOf(`async function ${workflow}`);
    assert.ok(at > 0, `${workflow} must exist`);
    const rest = worker.slice(at);
    const workflowBody = rest.slice(0, rest.indexOf("\n// ---"));
    assert.match(workflowBody, /if \(!\(await beginConnectionsRun\(\)\)\) return;/,
      `${workflow} must enter through beginConnectionsRun`);
    assert.ok(
      !/moveCollectionTo\(Queue\.COLLECTION_STATE\.OPENING_CONNECTIONS\)/.test(workflowBody),
      `${workflow} must not keep its own bare guard, which is what returned in silence`
    );
  }
});

// Reported against a 19,000-connection account: enumerating the whole list before
// reading a single profile is hours of scrolling with nothing collected, and an
// interruption in that window leaves a long list and no profiles.
test("Start Full Collection hands over to extraction as soon as there is a batch, and keeps discovering", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");

  assert.match(worker, /const HANDOVER_PENDING_ROWS = \d+;/, "how little is enough to begin must be named");
  assert.match(worker, /handoverAtPending = 0/, "and it must be OFF unless a caller asks for it");
  // Checked after the pass is persisted, so nothing handed over is only in memory.
  assert.match(
    worker,
    /Queue\.queueStats\(enqueued\.items\)\.pending >= handoverAtPending[\s\S]{0,120}?stoppedBy = "handover"/,
    "the handover is decided on rows already written to the queue"
  );

  const full = worker.slice(worker.indexOf("async function startCollectingWorkflow"));
  const fullBody = full.slice(0, full.indexOf("\n// ---"));
  assert.match(fullBody, /handoverAtPending: HANDOVER_PENDING_ROWS/,
    "Start Full Collection must stop discovering once it has enough to start");
  assert.match(fullBody, /autoDiscover: true/,
    "and must leave the rest of the list to the drain loop");

  // Discover Connections Only is the command whose whole purpose is the full
  // list, so it must NOT take the shortcut.
  const only = worker.slice(worker.indexOf("async function discoveryOnlyWorkflow"));
  const onlyBody = only.slice(0, only.indexOf("\n// ---"));
  assert.ok(!/handoverAtPending/.test(onlyBody),
    "Discover Connections Only must still enumerate the whole list");
});

test("an early handover is 'enough to begin', never 'that is the whole list'", () => {
  // The distinction the interleave rests on: handing over must not mark the list
  // exhausted, or the drain loop would treat a part-read account as finished and
  // the run would stop thousands of connections early.
  let session = { ...Queue.createSession(), autoDiscover: true, discoveryExhausted: false };
  assert.equal(Queue.shouldContinueAutoDiscovery(session), true,
    "a run that handed over early must keep asking for more");

  // Growth resets the fruitless budget; a barren pass spends it. That bound is
  // what stops the top-up looping forever, and it is unchanged by the handover.
  session = Queue.registerDiscoveryGrowth(session, "t1");
  assert.equal(Queue.shouldContinueAutoDiscovery(session), true);
  for (let attempt = 0; attempt < Queue.MAX_FRUITLESS_DISCOVERY; attempt += 1) {
    session = Queue.registerFruitlessDiscovery(session, "t2");
  }
  assert.equal(Queue.shouldContinueAutoDiscovery(session), false,
    "and a list with nothing left to give still ends the run");

  // The drain loop's route back to discovery is what makes the interleave legal.
  assert.ok(
    Queue.canTransitionCollection(
      Queue.COLLECTION_STATE.MOVING_TO_NEXT_PROFILE,
      Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS
    ),
    "extraction must be able to go back for more of the list"
  );
});

test("manual extraction runs over the saved queue without re-enumerating the list", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const branch = worker.slice(worker.indexOf("if (type === IMPORT_MESSAGES.START)"));
  const body = branch.slice(0, branch.indexOf("IMPORT_MESSAGES.PAUSE"));
  assert.match(body, /Queue\.selectItemUrls/, "it must resolve the chosen scope");
  assert.match(body, /Queue\.prepareRun/, "it must arm only the selected rows");
  assert.match(body, /autoDiscover: false/, "manual extraction must not page the connections list");
  assert.ok(!/runDiscovery\(/.test(body), "manual extraction must not enumerate anything");
});

test("a narrowed manual run leaves the rest of the discovered list untouched", () => {
  const urls = ["https://www.linkedin.com/in/a", "https://www.linkedin.com/in/b", "https://www.linkedin.com/in/c"];
  let state = queued(urls);
  const claimed = Queue.claimNext(Queue.startSession(state, "t0"), "t1");
  state = Queue.markCompleted({ items: claimed.items, session: claimed.session }, urls[0], "t1", "id-a");

  const chosen = Queue.selectItemUrls(state.items, { scope: Queue.SELECTION_SCOPE.SELECTED, urls: [urls[2]] });
  assert.deepEqual(chosen, [urls[2]]);

  const prepared = Queue.prepareRun(state, chosen, "t2", Queue.SELECTION_SCOPE.SELECTED);
  assert.equal(prepared.items.length, 3, "the discovered list must keep every row");
  assert.equal(Queue.findItem(prepared.items, urls[0]).status, Queue.ITEM_STATUS.COMPLETED, "rows outside the scope keep their status");

  const running = Queue.startSession(prepared, "t3", { scope: Queue.SELECTION_SCOPE.SELECTED, scopeUrls: chosen });
  const claim = Queue.claimNext(running, "t4");
  assert.equal(claim.item.url, urls[2], "only the selected connection may be claimed");
});
