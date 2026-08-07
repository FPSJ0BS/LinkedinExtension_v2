// The collector tab workflow — the eight behaviours the tab design has to
// guarantee, driven against a fake Chrome.
//
//   1  Start Full Collection activates the Connections tab
//   2  Discovery completing opens AND activates the profile collector tab
//   3  Only one profile collector tab is ever created
//   4  The same tab is reused for every profile in the queue
//   5  A hidden collector tab pauses without saving partial data
//   6  Returning to the collector tab resumes extraction
//   7  Queue completion activates the Saved Profiles table
//   8  Nothing keeps processing after completion
//
// There is no Chrome and no jsdom in `npm test`, which is exactly why
// src/collector-tabs-core.js takes its Chrome APIs by injection: the controller
// under test here is the identical code src/background.ts runs in the browser.
// Source-level assertions at the end prove the worker actually routes through
// it rather than reaching for `chrome.tabs` on its own.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

await import("../src/collector-tabs-core.js");
import * as Queue from "../src/import-queue-core.js";

const TabsCore = globalThis.ProfileVaultTabs;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const DASHBOARD_URL = "chrome-extension://abc/dashboard.html";
const PROFILES = [
  "https://www.linkedin.com/in/person-1",
  "https://www.linkedin.com/in/person-2",
  "https://www.linkedin.com/in/person-3"
];

// ===========================================================================
// A fake Chrome window: tabs, windows, and storage, recording every call.
// ===========================================================================

function fakeChrome({ homeWindowId = 100, homeTabId = 1 } = {}) {
  const tabs = new Map();
  const windows = new Map();
  const store = new Map();
  const log = [];
  let nextTabId = homeTabId;

  windows.set(homeWindowId, { id: homeWindowId, state: "normal", focused: true });
  tabs.set(homeTabId, { id: homeTabId, windowId: homeWindowId, url: DASHBOARD_URL, active: true, status: "complete" });

  function deactivateSiblings(tabId, windowId) {
    for (const tab of tabs.values()) {
      if (tab.windowId === windowId && tab.id !== tabId) tab.active = false;
    }
  }

  const env = {
    tabs: {
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id ${id}`);
        return { ...tab };
      },
      async create(properties) {
        nextTabId += 1;
        const windowId = properties.windowId || homeWindowId;
        const tab = {
          id: nextTabId,
          windowId,
          url: properties.url || "",
          active: properties.active !== false,
          status: "complete"
        };
        tabs.set(tab.id, tab);
        if (tab.active) deactivateSiblings(tab.id, windowId);
        log.push({ call: "create", tabId: tab.id, url: tab.url, windowId });
        return { ...tab };
      },
      async update(id, properties) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id ${id}`);
        if (properties.url !== undefined) tab.url = properties.url;
        if (properties.active) {
          tab.active = true;
          deactivateSiblings(tab.id, tab.windowId);
        }
        log.push({ call: "update", tabId: id, url: properties.url, active: properties.active });
        return { ...tab };
      },
      async remove(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id ${id}`);
        tabs.delete(id);
        log.push({ call: "remove", tabId: id });
      },
      async query() {
        return [...tabs.values()].map((tab) => ({ ...tab }));
      }
    },
    windows: {
      async get(id) {
        const found = windows.get(id);
        if (!found) throw new Error(`No window with id ${id}`);
        return { ...found };
      },
      async update(id, properties) {
        const found = windows.get(id);
        if (!found) throw new Error(`No window with id ${id}`);
        Object.assign(found, properties);
        log.push({ call: "window.update", windowId: id, ...properties });
        return { ...found };
      }
    },
    storage: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of wanted) if (store.has(key)) out[key] = store.get(key);
        return out;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) store.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      }
    }
  };

  return {
    env,
    log,
    tabs,
    windows,
    store,
    homeWindowId,
    homeTabId,
    createdTabs: () => log.filter((entry) => entry.call === "create"),
    activeTabIn: (windowId = homeWindowId) =>
      [...tabs.values()].find((tab) => tab.windowId === windowId && tab.active)?.id ?? null,
    /** Simulate the user switching to some other tab in the same window. */
    switchAwayTo(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id ${tabId}`);
      tab.active = true;
      deactivateSiblings(tabId, tab.windowId);
    },
    minimize(windowId = homeWindowId) {
      windows.get(windowId).state = "minimized";
    }
  };
}

/** A controller with its home window and tab already remembered (step 1). */
async function startedController(fake = fakeChrome()) {
  const controller = TabsCore.createTabController(fake.env);
  await controller.rememberHome({ tabId: fake.homeTabId, windowId: fake.homeWindowId });
  return { fake, controller };
}

// ===========================================================================
// 1. Start Full Collection activates the Connections tab
// ===========================================================================

test("Start Full Collection opens the Connections tab in the same window and activates it", async () => {
  const { fake, controller } = await startedController();

  const result = await controller.ensureConnectionsTab(CONNECTIONS_URL);

  assert.equal(result.created, true, "the first call must open the Connections tab");
  const tab = fake.tabs.get(result.tabId);
  assert.equal(tab.url, CONNECTIONS_URL);
  assert.equal(tab.windowId, fake.homeWindowId, "it must live in the window the run was started from");
  assert.equal(tab.active, true, "requirement 3: the Connections tab must be visible");
  assert.equal(fake.activeTabIn(), result.tabId, "it must be THE active tab of that window");
  assert.equal(await controller.isConnectionsTabRenderable(), true);
});

test("a second Start reuses the Connections tab instead of opening another", async () => {
  const { fake, controller } = await startedController();
  const first = await controller.ensureConnectionsTab(CONNECTIONS_URL);
  fake.switchAwayTo(fake.homeTabId);

  const second = await controller.ensureConnectionsTab(CONNECTIONS_URL);

  assert.equal(second.tabId, first.tabId, "there is only ever one Connections tab");
  assert.equal(second.created, false);
  assert.equal(fake.createdTabs().length, 1, "no second Connections tab may be created");
  assert.equal(fake.activeTabIn(), first.tabId, "reusing it must re-activate it");
});

test("a Connections tab already on the page is re-activated, never reloaded", async () => {
  const { fake, controller } = await startedController();
  const first = await controller.ensureConnectionsTab(CONNECTIONS_URL);
  fake.log.length = 0;
  fake.switchAwayTo(fake.homeTabId);

  await controller.ensureConnectionsTab(CONNECTIONS_URL);

  const navigations = fake.log.filter((entry) => entry.call === "update" && entry.url !== undefined);
  assert.equal(navigations.length, 0, "reloading would discard the list LinkedIn already rendered");
  assert.equal(fake.activeTabIn(), first.tabId);
});

// ===========================================================================
// 2 & 3. Discovery completing opens and activates ONE profile collector tab
// ===========================================================================

test("discovery completing opens and activates a separate profile collector tab", async () => {
  const { fake, controller } = await startedController();
  const connections = await controller.ensureConnectionsTab(CONNECTIONS_URL);

  const collector = await controller.ensureProfileTab(PROFILES[0]);

  assert.equal(collector.created, true, "the hand-over must open the collector tab by itself");
  assert.notEqual(collector.tabId, connections.tabId, "it must be a SEPARATE tab from the Connections tab");
  const tab = fake.tabs.get(collector.tabId);
  assert.equal(tab.windowId, fake.homeWindowId, "requirement 6: the same window");
  assert.equal(tab.active, true, "requirement 7: activate the profile collector tab");
  assert.equal(fake.activeTabIn(), collector.tabId);
  assert.equal(await controller.isProfileTabRenderable(), true);
  // Both surfaces exist at once, and neither replaced the other.
  assert.equal(fake.tabs.size, 3, "home tab + connections tab + collector tab");
});

test("only one profile collector tab is ever created, however many times it is ensured", async () => {
  const { fake, controller } = await startedController();
  await controller.ensureConnectionsTab(CONNECTIONS_URL);

  const ids = new Set();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // A suspended service worker re-entering the workflow looks exactly like this.
    const result = await controller.ensureProfileTab(PROFILES[0]);
    ids.add(result.tabId);
  }

  assert.equal(ids.size, 1, "every ensure must resolve to the same collector tab");
  const profileCreates = fake.createdTabs().filter((entry) => entry.url !== CONNECTIONS_URL);
  assert.equal(profileCreates.length, 1, "exactly one profile collector tab may be created");
});

// ===========================================================================
// 4. The same tab is reused for every profile
// ===========================================================================

test("every profile in the queue is loaded into the same reusable tab", async () => {
  const { fake, controller } = await startedController();
  await controller.ensureConnectionsTab(CONNECTIONS_URL);
  const opened = await controller.ensureProfileTab(PROFILES[0]);

  const visited = [];
  for (const url of PROFILES) {
    const result = await controller.navigateProfileTab(url);
    visited.push(result.tabId);
    assert.equal(result.created, false, `${url} must reuse the tab, not open one`);
    assert.equal(fake.tabs.get(result.tabId).url, url, "the tab must actually be on that profile");
    assert.equal(fake.activeTabIn(), result.tabId, "requirement 10: it stays the active tab");
  }

  assert.deepEqual([...new Set(visited)], [opened.tabId], "one tab for the whole queue");
  assert.equal(fake.tabs.size, 3, "no tab was opened per profile");
  const profileCreates = fake.createdTabs().filter((entry) => entry.url !== CONNECTIONS_URL);
  assert.equal(profileCreates.length, 1, "a tab per profile is the exact bug this prevents");
});

test("a collector tab the user closed is reopened once, not abandoned", async () => {
  const { fake, controller } = await startedController();
  const first = await controller.ensureProfileTab(PROFILES[0]);
  await fake.env.tabs.remove(first.tabId);
  await controller.forgetClosedTab(first.tabId);

  const reopened = await controller.navigateProfileTab(PROFILES[1]);

  assert.notEqual(reopened.tabId, first.tabId);
  assert.equal(reopened.created, true, "a closed collector must be replaced");
  const again = await controller.navigateProfileTab(PROFILES[2]);
  assert.equal(again.tabId, reopened.tabId, "and then reused again from there on");
});

// ===========================================================================
// 5. A hidden collector tab pauses without saving partial data
// ===========================================================================

test("switching away from the collector tab makes it unrenderable", async () => {
  const { fake, controller } = await startedController();
  await controller.ensureProfileTab(PROFILES[0]);
  assert.equal(await controller.isProfileTabRenderable(), true);

  fake.switchAwayTo(fake.homeTabId);
  assert.equal(await controller.isProfileTabRenderable(), false, "a background tab is not being painted");

  fake.switchAwayTo(await controller.getProfileTabId());
  assert.equal(await controller.isProfileTabRenderable(), true);
  fake.minimize();
  assert.equal(await controller.isProfileTabRenderable(), false, "a minimized window paints nothing");
});

test("a hidden collector pauses the run and writes no profile", () => {
  const urls = [...PROFILES];
  let state = Queue.startSession(
    { items: Queue.enqueueUrls([], urls, "t0").items, session: Queue.createSession() },
    "t0"
  );
  state = Queue.transitionCollection(state.session, Queue.COLLECTION_STATE.EXTRACTING_PROFILE, "t0").changed
    ? { items: state.items, session: Queue.transitionCollection(state.session, Queue.COLLECTION_STATE.EXTRACTING_PROFILE, "t0").session }
    : state;

  const claimed = Queue.claimNext(state, "t1");
  assert.equal(claimed.item.url, urls[0]);
  assert.equal(claimed.item.status, Queue.ITEM_STATUS.PROCESSING);

  // The tab went hidden mid-scan. Requirement 11: pause, do not save.
  const paused = Queue.pauseForVisibility({ items: claimed.items, session: claimed.session }, "t2");

  assert.equal(paused.session.status, Queue.SESSION_STATUS.PAUSED);
  assert.equal(paused.session.pausedBy, Queue.PAUSED_BY.VISIBILITY);
  assert.equal(paused.session.collectionState, Queue.COLLECTION_STATE.PAUSED_HIDDEN);
  assert.equal(paused.session.stopReason, Queue.STOP_REASON.VISIBILITY);
  assert.equal(paused.session.processedTotal, 0, "nothing may be counted as collected");
  const item = Queue.findItem(paused.items, urls[0]);
  assert.notEqual(item.status, Queue.ITEM_STATUS.COMPLETED, "a half-read profile must never be saved");
  assert.equal(item.profileId, "", "no record id may be attached to it");
});

test("the worker refuses to save a profile read from a tab that went hidden", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const start = worker.indexOf("async function processItem");
  const body = worker.slice(start, worker.indexOf("// ------------------------------------------------------------------- the loop"));

  // Gated before reading AND again before writing: the tab can go hidden in the
  // window between the content script returning and the record being persisted.
  // `\r?\n` because the repo is LF-canonical but a checkout with core.autocrlf
  // true — every Windows clone — hands this file to the test as CRLF, and a bare
  // `\n` then matches neither guard and reports "found 0" against a worker that
  // has both.
  const guards = body.match(/if \(!\(await collectorIsRenderable\(\)\)\) \{\r?\n\s*return \{ ok: false, hidden: true/g) || [];
  assert.ok(guards.length >= 2, `both the read and the save must be gated on visibility, found ${guards.length}`);
  assert.ok(
    body.indexOf("collectorIsRenderable") < body.indexOf("persistProfile"),
    "the visibility check must come before anything is written"
  );

  const loop = worker.slice(worker.indexOf("async function runLoop"));
  assert.match(loop, /if \(result\.hidden\)/, "a hidden result must be handled distinctly from a failure");
  assert.match(loop, /Queue\.pauseForVisibility\(\{ items: requeued/, "the connection must go back to pending");
});

// ===========================================================================
// 6. Returning to the collector tab resumes extraction
// ===========================================================================

test("a hidden pause resumes automatically, and into the half of the run it left", () => {
  const base = { items: [], session: Queue.createSession() };

  const midExtraction = Queue.pauseForVisibility(
    { ...base, session: { ...base.session, collectionState: Queue.COLLECTION_STATE.EXTRACTING_PROFILE } },
    "t1"
  );
  assert.equal(Queue.canResumeFromVisibility(midExtraction.session), true, "it must clear itself");
  assert.equal(
    midExtraction.session.resumeCollectionState,
    Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR,
    "extraction resumes by re-opening and re-activating the collector tab"
  );

  const midDiscovery = Queue.pauseForVisibility(
    { ...base, session: { ...base.session, collectionState: Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS } },
    "t1"
  );
  assert.equal(
    midDiscovery.session.resumeCollectionState,
    Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS,
    "a pause during discovery must not restart as extraction"
  );

  // And the move back is legal from the paused state.
  assert.equal(
    Queue.transitionCollection(midExtraction.session, Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR, "t2").changed,
    true
  );

  // A challenge, by contrast, always waits for a human.
  const challenged = Queue.pauseSession(base, "t1", "Please solve this puzzle", "captcha");
  assert.equal(Queue.canResumeFromVisibility(challenged.session), false);
});

test("returning to the collector tab makes it renderable again and resume is driven by tab events", async () => {
  const { fake, controller } = await startedController();
  const collector = await controller.ensureProfileTab(PROFILES[0]);
  fake.switchAwayTo(fake.homeTabId);
  assert.equal(await controller.isProfileTabRenderable(), false);

  // Requirement 12: activating the collector is what the worker does on resume.
  await controller.activate(collector.tabId);
  assert.equal(await controller.isProfileTabRenderable(), true);
  assert.equal(fake.activeTabIn(), collector.tabId);

  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /chrome\.tabs\.onActivated\.addListener/, "switching tabs must be noticed at once");
  assert.match(worker, /chrome\.windows\.onFocusChanged\.addListener/, "so must switching windows");
  assert.match(worker, /async function resumeFromHidden/, "resume must be its own tested path");
  assert.match(worker, /resumeCollectionState/, "it must resume into the state it left");
});

// ===========================================================================
// 7 & 8. Completion: activate Saved Profiles, and stop everything
// ===========================================================================

test("queue completion closes both collector tabs and activates the Saved Profiles table", async () => {
  const { fake, controller } = await startedController();
  const connections = await controller.ensureConnectionsTab(CONNECTIONS_URL);
  const collector = await controller.ensureProfileTab(PROFILES[0]);
  assert.equal(fake.tabs.size, 3);

  const closed = await controller.closeCollectorTabs();
  const saved = await controller.openSavedProfilesTab(DASHBOARD_URL);

  assert.equal(closed.policy, "close-collectors-open-saved-profiles", "one named policy, applied in one place");
  assert.equal(closed.closedConnections, true);
  assert.equal(closed.closedProfile, true);
  assert.equal(fake.tabs.has(connections.tabId), false, "the Connections tab must be gone");
  assert.equal(fake.tabs.has(collector.tabId), false, "the collector tab must be gone");

  assert.equal(saved.tabId, fake.homeTabId, "the extension tab the run started from is reused");
  assert.equal(saved.created, false, "finishing must not pile up another tab");
  assert.equal(fake.tabs.get(saved.tabId).url, DASHBOARD_URL);
  assert.equal(fake.tabs.get(saved.tabId).active, true, "requirement 13: Saved Profiles must be activated");
  assert.equal(fake.activeTabIn(), saved.tabId);
  assert.equal(fake.tabs.size, 1, "only the Saved Profiles tab is left");
});

test("Saved Profiles is opened when the home tab is gone, and still activated", async () => {
  const { fake, controller } = await startedController();
  await fake.env.tabs.remove(fake.homeTabId);

  const saved = await controller.openSavedProfilesTab(DASHBOARD_URL);

  assert.equal(saved.created, true);
  assert.equal(fake.tabs.get(saved.tabId).url, DASHBOARD_URL);
  assert.equal(fake.tabs.get(saved.tabId).active, true);
  assert.equal(fake.tabs.get(saved.tabId).windowId, fake.homeWindowId, "in the window the run started from");
});

test("no work continues once the run reaches a terminal state", () => {
  const urls = [PROFILES[0]];
  let state = Queue.startSession({ items: Queue.enqueueUrls([], urls, "t0").items, session: Queue.createSession() }, "t0");
  const claimed = Queue.claimNext(state, "t1");
  state = Queue.markCompleted({ items: claimed.items, session: claimed.session }, urls[0], "t1", "profile-1");

  const drained = Queue.claimNext(state, "t2");
  assert.equal(drained.item, null, "there is nothing left to claim");
  assert.equal(drained.reason, "empty");
  assert.equal(drained.session.stopReason, Queue.STOP_REASON.QUEUE_COMPLETE);

  const terminal = Queue.terminalStateFor({ items: state.items, session: drained.session });
  assert.equal(terminal, Queue.COLLECTION_STATE.COMPLETED);
  assert.equal(Queue.isTerminalCollectionState(terminal), true);
  assert.equal(Queue.isActiveCollectionState(terminal), false, "a finished run is not an active one");

  // And a completed machine refuses to go back to work without starting over.
  const finished = { ...drained.session, collectionState: terminal };
  for (const next of [
    Queue.COLLECTION_STATE.EXTRACTING_PROFILE,
    Queue.COLLECTION_STATE.SAVING_PROFILE,
    Queue.COLLECTION_STATE.MOVING_TO_NEXT_PROFILE,
    Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS,
    Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR
  ]) {
    assert.equal(
      Queue.transitionCollection(finished, next, "t3").changed,
      false,
      `a completed run must refuse to move to ${next}`
    );
  }
  assert.equal(Queue.transitionCollection(finished, Queue.COLLECTION_STATE.IDLE, "t3").changed, true,
    "starting over is the only way out");
});

test("the worker stops its alarms and its loop when the queue finishes", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");

  const start = worker.indexOf("async function finishRun");
  assert.ok(start > 0, "the completion policy must live in one named function");
  const body = worker.slice(start, worker.indexOf("\n}", start));
  assert.match(body, /abortRunningWork\(\)/, "work already in flight must be cut off");
  assert.match(body, /clearHeartbeat\(\)/, "the alarm must be cleared");
  assert.match(body, /closeCollectorTabs\(\)/, "both collector tabs must be closed");
  assert.match(body, /openSavedProfilesTab\(/, "Saved Profiles must be opened");
  assert.match(body, /moveCollectionTo\(terminalState\)/, "the session must be marked finished");

  // The loop's terminal branch has to use it rather than repeat it.
  const loop = worker.slice(worker.indexOf("async function runLoop"));
  assert.match(loop, /await finishRun\(Queue\.terminalStateFor\(finished\)\)/);

  // And the heartbeat must refuse to restart a finished run.
  const heartbeat = worker.slice(worker.indexOf("async function onHeartbeat"));
  assert.match(
    heartbeat,
    /Queue\.isTerminalCollectionState\(session\.collectionState\)[\s\S]{0,120}clearHeartbeat/,
    "a terminal state must clear the alarm before anything else is considered"
  );
});

// ===========================================================================
// The hand-over: discovery to extraction, with no Stop/Start in between
// ===========================================================================

test("connection discovery hands over to profile extraction automatically", () => {
  // The exact path a full run takes, with no manual step anywhere in it.
  const path = [
    Queue.COLLECTION_STATE.OPENING_CONNECTIONS,
    Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS,
    Queue.COLLECTION_STATE.CONNECTIONS_COMPLETE,
    Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR,
    Queue.COLLECTION_STATE.EXTRACTING_PROFILE,
    Queue.COLLECTION_STATE.SAVING_PROFILE,
    Queue.COLLECTION_STATE.MOVING_TO_NEXT_PROFILE,
    Queue.COLLECTION_STATE.EXTRACTING_PROFILE
  ];

  let session = Queue.createSession();
  for (const next of path) {
    const moved = Queue.transitionCollection(session, next, "t");
    assert.equal(moved.changed, true, `${session.collectionState} -> ${next} must be allowed`);
    session = moved.session;
  }

  // The hand-over must not require passing through stopped or idle.
  assert.ok(
    Queue.canTransitionCollection(
      Queue.COLLECTION_STATE.CONNECTIONS_COMPLETE,
      Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR
    ),
    "discovery finishing must reach the collector directly"
  );
  assert.ok(
    !Queue.canTransitionCollection(Queue.COLLECTION_STATE.STOPPED, Queue.COLLECTION_STATE.EXTRACTING_PROFILE),
    "a stopped run must never resume straight into extraction"
  );
});

test("every state the workflow is specified to have exists and is reachable", () => {
  const required = [
    "opening_connections", "discovering_connections", "connections_complete",
    "opening_profile_collector", "extracting_profile", "saving_profile",
    "moving_to_next_profile", "paused_hidden", "paused_challenge",
    "completed", "completed_with_gap", "failed"
  ];
  const declared = Object.values(Queue.COLLECTION_STATE);
  for (const state of required) {
    assert.ok(declared.includes(state), `COLLECTION_STATE must declare ${state}`);
    assert.ok(Queue.COLLECTION_TRANSITIONS[state], `${state} must declare its legal moves`);
    assert.ok(Queue.collectionStateText(state), `${state} must have text the page can show`);
  }
});

// ===========================================================================
// The worker really does route through the tested controller
// ===========================================================================

test("the service worker creates collector tabs only through the tested controller", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");

  assert.match(worker, /import "\.\/collector-tabs-core\.js"/, "the worker must load the tab core");
  assert.match(worker, /const Tabs = TabsCore\.createTabController\(/, "and build one controller over chrome APIs");

  // Every tab is created inside collector-tabs-core.js. The worker may pass
  // chrome.tabs.create IN as an injected dependency, but must never call it.
  const withoutInjection = worker.replace(/create: \(properties: any\) => chrome\.tabs\.create\(properties\)/, "");
  assert.ok(
    !/chrome\.tabs\.create\(/.test(withoutInjection),
    "the worker must not open tabs itself — that is how a tab per profile comes back"
  );
  assert.ok(
    !/chrome\.windows\.create\(/.test(worker),
    "the run lives in the user's own window; no separate collector window is created"
  );

  assert.match(worker, /await Tabs\.navigateProfileTab\(item\.url\)/, "each profile reuses the one collector tab");
  assert.match(worker, /Tabs\.ensureConnectionsTab\(/, "the Connections tab comes from the controller");
  assert.match(worker, /Tabs\.ensureProfileTab\(/, "so does the profile collector tab");
  assert.match(worker, /async function rememberOrigin/, "step 1: the origin window and tab are remembered");
  assert.match(worker, /await rememberOrigin\(sender\)/, "and remembered from the message that started the run");
});

test("the automatic workflow performs the steps in the order the design requires", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const start = worker.indexOf("async function startCollectingWorkflow");
  const body = worker.slice(start, worker.indexOf("/** Find All Connections, detached", start));

  // Steps 2-3 moved AHEAD of the session check in 3.7.17, deliberately and by
  // request: this is a button press, the check costs an injection and a round
  // trip, and a Connections page that arrives seconds later reads as a button
  // that did nothing. The check then reuses the tab that was just revealed, and
  // the signed-out path still sends that same tab to LinkedIn's sign-in page.
  const order = [
    // Step 1 is now beginConnectionsRun(), which owns the move to
    // OPENING_CONNECTIONS and resets a finished or stopped run first — a button
    // press is "explicitly starting over", the one move a terminal state has.
    "beginConnectionsRun()",
    "revealConnectionsTab()",
    "checkLoginState()",
    "COLLECTION_STATE.DISCOVERING_CONNECTIONS",
    "runDiscovery(",
    "COLLECTION_STATE.CONNECTIONS_COMPLETE",
    "COLLECTION_STATE.OPENING_PROFILE_COLLECTOR",
    "Tabs.ensureProfileTab(",
    "Queue.startSession(",
    "COLLECTION_STATE.EXTRACTING_PROFILE",
    "kickLoop()"
  ];

  let cursor = -1;
  for (const step of order) {
    const at = body.indexOf(step, cursor + 1);
    assert.ok(at > cursor, `"${step}" must come after the previous step in startCollectingWorkflow`);
    cursor = at;
  }
});

// ===========================================================================
// The hiring tab: opened or reused in the window the command came from, and
// brought to the front — a button that means "go and do this on that page".
// ===========================================================================

const APPLICANTS_URL = "https://www.linkedin.com/hiring/applicants/?applicationId=31754123946&jobId=4277798308";

test("a direct command focuses the window; the background run still never does", async () => {
  const { fake, controller } = await startedController();

  // The default is unchanged: the heartbeat-driven import run activates the tab
  // but must not steal focus from whatever the user is typing into.
  fake.windows.get(fake.homeWindowId).focused = false;
  await controller.activate(fake.homeTabId);
  assert.equal(fake.windows.get(fake.homeWindowId).focused, false, "a background step must not take focus");

  // A pressed button is the exception: a tab activated in a window the user is
  // not looking at is, to them, a button that did nothing.
  await controller.activate(fake.homeTabId, { focusWindow: true });
  assert.equal(fake.windows.get(fake.homeWindowId).focused, true, "a direct command must raise the window");

  // And a minimized window is restored on the way, not left minimized.
  fake.minimize();
  fake.windows.get(fake.homeWindowId).focused = false;
  await controller.activate(fake.homeTabId, { focusWindow: true });
  assert.equal(fake.windows.get(fake.homeWindowId).state, "normal");
  assert.equal(fake.windows.get(fake.homeWindowId).focused, true);
});

test("the hiring tab is opened once, in the origin window, and reused after that", async () => {
  const { fake, controller } = await startedController();

  const first = await controller.ensureApplicantTab(APPLICANTS_URL);
  assert.equal(first.created, true, "with no hiring tab open, one is opened");
  assert.equal(fake.tabs.get(first.tabId).windowId, fake.homeWindowId, "in the window the command came from");
  assert.equal(fake.activeTabIn(), first.tabId, "and it is the tab being painted");
  assert.equal(fake.windows.get(fake.homeWindowId).focused, true, "in a window the recruiter is looking at");

  // The user wanders off to another tab; the next command brings them back to
  // the SAME hiring tab rather than opening a second one.
  fake.switchAwayTo(fake.homeTabId);
  const second = await controller.ensureApplicantTab(APPLICANTS_URL);
  assert.equal(second.created, false, "a live hiring tab is reused, never duplicated");
  assert.equal(second.tabId, first.tabId);
  assert.equal(fake.activeTabIn(), first.tabId);
  assert.equal(fake.createdTabs().length, 1, "exactly one hiring tab across both commands");

  // A tab already on the applicants page is never reloaded — that would throw
  // away the list LinkedIn has already rendered, exactly as for Connections.
  assert.ok(
    !fake.log.some((entry) => entry.call === "update" && entry.tabId === first.tabId && entry.url),
    "a tab already on the page must not be navigated"
  );

  // It is the recruiter's own working page, not a collector this extension
  // owns, so finishing an import run must never close it.
  await controller.closeCollectorTabs();
  assert.ok(fake.tabs.has(first.tabId), "closeCollectorTabs must not touch the hiring tab");
});

test("a hiring tab the user opened themselves is adopted rather than duplicated", async () => {
  const { fake, controller } = await startedController();
  const theirs = await fake.env.tabs.create({ url: APPLICANTS_URL, windowId: fake.homeWindowId });

  await controller.rememberApplicantTab(theirs.id);
  const resolved = await controller.ensureApplicantTab(APPLICANTS_URL);
  assert.equal(resolved.created, false, "the tab they already had is the tab that is used");
  assert.equal(resolved.tabId, theirs.id);
  assert.equal(fake.createdTabs().length, 1, "no second hiring tab was opened");

  assert.equal(await controller.rememberApplicantTab(0), null, "a missing id remembers nothing");
});

test("the applicant commands take the recruiter to the page instead of refusing", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const resolver = worker.slice(worker.indexOf("async function resolveApplicantTab"), worker.indexOf("* Make the hiring tab"));

  // Through 3.7.4 this raised "Open your job's Applicants page, then try again"
  // and left the recruiter to go and find it. They pressed a button that means
  // "go and do this on that page".
  assert.match(resolver, /const remembered = await lastHiringUrl\(\)/, "the last hiring page must be reopened");
  assert.match(resolver, /await Tabs\.ensureApplicantTab\(remembered\)/, "through the controller that owns every tab");
  assert.match(resolver, /if \(created\) await waitForTabComplete\(tabId, remembered\)/, "and waited for when it is new");

  // Nothing is constructed: a job id welded into a guessed path would be the
  // same class of mistake as guessing a resume link, so the first run still
  // needs the page to have been opened once.
  assert.match(resolver, /if \(!remembered\) \{[\s\S]*?throw new Error\(/, "with no remembered page it still says so");
  assert.match(worker, /HIRING_URL_PATTERN\.test\(value\)/, "and only a real hiring address is ever remembered");

  // Both commands anchor "the same window" to the window they came from.
  for (const command of ["COLLECT_CURRENT", "COLLECT_ALL"]) {
    const branch = worker.slice(worker.indexOf(`APPLICANT_MESSAGES.${command}) {`));
    assert.ok(
      branch.indexOf("await rememberOrigin(sender)") < branch.indexOf("resolveApplicantTab()"),
      `${command} must remember the origin window before any tab is opened`
    );
  }
  assert.match(worker, /handleApplicantCommand\(message\.type, message, _sender\)/, "the sender must reach the handler");
  assert.match(worker, /await Tabs\.activate\(tab\.id, \{ focusWindow: true \}\)/, "and the window is raised, not just the tab");
});

// Reported as "I want these buttons to directly redirect on the connections page
// and start collecting", against a Start Full Collection / Discover Connections
// Only that appeared to do nothing at all. Both already opened or reused the one
// Connections tab and made it ACTIVE — but never raised its window, and the
// importer page is routinely a window of its own while the popup has no sender
// tab at all, so the redirect landed off screen. Rule 12c's third focus point.
test("a connections command brings the Connections page to the front, before the slow part", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");

  // The reveal is its own step, exactly as revealApplicantTab is, and it raises
  // the window through the controller that owns every tab decision (rule 12).
  assert.match(worker, /async function revealConnectionsTab\(\): Promise<number> \{/,
    "the direct-command reveal must exist as its own function");
  const reveal = worker.slice(worker.indexOf("async function revealConnectionsTab"));
  const revealBody = reveal.slice(0, reveal.indexOf("\n}") + 2);
  assert.match(revealBody, /await resolveConnectionsTab\(\)/, "it resolves the one Connections tab");
  assert.match(revealBody, /await Tabs\.activate\(tabId, \{ focusWindow: true \}\)/,
    "and raises its window, because a tab activated out of sight is a button that did nothing");

  // Both buttons take it, and both take it BEFORE the session check: that check
  // costs an injection and a round trip, and a page that arrives seconds later
  // reads as the same dead button.
  for (const workflow of ["startCollectingWorkflow", "discoveryOnlyWorkflow"]) {
    const start = worker.indexOf(`async function ${workflow}`);
    assert.ok(start > 0, `${workflow} must exist`);
    const rest = worker.slice(start);
    const body = rest.slice(0, rest.indexOf("\n// ---"));
    assert.match(body, /await revealConnectionsTab\(\)/, `${workflow} must reveal the Connections tab`);
    assert.ok(
      body.indexOf("await revealConnectionsTab()") < body.indexOf("await checkLoginState()"),
      `${workflow} must redirect before the session check, not after it`
    );
  }

  // And the other half of rule 12c is unchanged: the heartbeat-driven run
  // activates a collector tab without ever stealing focus from whatever the user
  // is typing into. Only a pressed button is allowed to.
  const prepare = worker.slice(worker.indexOf("async function prepareCollectorStep"));
  const prepareBody = prepare.slice(0, prepare.indexOf("\n}") + 2);
  assert.match(prepareBody, /await Tabs\.activate\(tabId\)\.catch/, "the background step activates the tab");
  assert.ok(!/focusWindow/.test(prepareBody), "and the background step must never take focus");
  assert.ok(
    !/focusWindow: true/.test(worker.slice(worker.indexOf("async function runDiscovery"), worker.indexOf("function reconcileState"))),
    "nor may the discovery loop itself, which the heartbeat's resume path also drives"
  );
});
