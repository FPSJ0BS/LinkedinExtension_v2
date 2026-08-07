import { APPLICANT_MESSAGES, IMPORT_MESSAGES, PROFILE_MESSAGES, CONNECTION_MESSAGES, STOP_ALL } from "./messages.js";
import * as Queue from "./import-queue-core.js";
import { loadState, saveSession, replaceItems, putItem } from "./queue-db.js";
import { findByProfileUrl, saveProfile } from "./db.js";
import { normalizeProfile, replaceProfile } from "./profile-utils.js";
import { clearApplicants, getAllApplicants, resumeAlreadyDownloaded, saveApplicant } from "./applicant-db.js";
// Side-effect import: the connections core is an export-free IIFE that publishes
// itself on globalThis. The worker needs its pure URL, auth, and reconciliation
// helpers, and importing it here keeps exactly one implementation of each.
import "./connections-core.js";
// Side-effect import: the collector tab workflow is an export-free IIFE for the
// same reason the other cores are. It owns every tab decision in the run, over an
// injected Chrome API, so the whole policy is testable without a browser.
import "./collector-tabs-core.js";

const Connections: any = (globalThis as any).ProfileVaultConnections;
const TabsCore: any = (globalThis as any).ProfileVaultTabs;
// Published by the side-effect import inside `applicant-db.js`. The worker uses
// it for one thing only: deciding whether a stored applicant counts as already
// collected, so that rule has exactly one implementation.
const Applicants: any = (globalThis as any).ProfileVaultApplicants;

const BUILD_ID = "2026-08-03-react-v3.7.8";

const PROFILE_SCRIPTS = ["src/extraction-core.js", "src/connections-core.js", "content.js"];
const CONNECTION_SCRIPTS = ["src/connections-core.js", "connections.js"];
/** 3.7.0: the recruiter hiring surface, injected on demand as the others are. */
const APPLICANT_SCRIPTS = [
  "src/extraction-core.js",
  "src/connections-core.js",
  "src/applicants-core.js",
  "applicants.js"
];
const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const LOGIN_URL = "https://www.linkedin.com/login";
/** Step 13: where a finished run sends the user. */
const SAVED_PROFILES_URL = "dashboard.html";

/**
 * The one collector-tab controller.
 *
 * Everything about which tab exists, which window it lives in, and which tab is
 * being painted goes through here. Chrome's APIs are injected rather than
 * referenced globally so `tests/collector-tabs.test.js` can drive the identical
 * code against a fake window.
 */
const Tabs = TabsCore.createTabController({
  tabs: {
    get: (id: number) => chrome.tabs.get(id),
    create: (properties: any) => chrome.tabs.create(properties),
    update: (id: number, properties: any) => chrome.tabs.update(id, properties),
    remove: (id: number) => chrome.tabs.remove(id),
    query: (info: any) => chrome.tabs.query(info)
  },
  windows: {
    get: (id: number) => chrome.windows.get(id),
    update: (id: number, properties: any) => chrome.windows.update(id, properties)
  },
  storage: {
    get: (keys: any) => chrome.storage.local.get(keys),
    set: (values: any) => chrome.storage.local.set(values),
    remove: (keys: any) => chrome.storage.local.remove(keys)
  }
});

const NAVIGATION_TIMEOUT_MS = 45000;
// Extraction and discovery now wait properly for LinkedIn's lazy loading, so these
// budgets must be generous enough not to cut a healthy run short.
const EXTRACT_TIMEOUT_MS = 150000;
const DISCOVERY_TIMEOUT_MS = 240000;
const PING_TIMEOUT_MS = 2500;
// `tab.status === "complete"` fires before LinkedIn hydrates the profile, so give the
// page a moment to start rendering before asking the content script to read it.
const PROFILE_SETTLE_MS = 2500;
// LinkedIn only renders lazy content for a page it is actually painting, so the
// run lives in exactly two reused, activated tabs of the user's own window: one
// Connections tab and one profile collector tab. Both ids are persisted by
// collector-tabs-core.js, because the worker is suspended constantly and must
// never respond to that by opening another tab.

// Phase 25 / decision D2: a heartbeat keeps long runs alive across service-worker
// suspension. The alarm only ever *resumes normal processing*; a challenge pause is
// never cleared by it.
const HEARTBEAT_ALARM = "profile-vault-import-heartbeat";
const HEARTBEAT_PERIOD_MINUTES = 1;

const MAX_DISCOVERY_PASSES = 400;

let loopRunning = false;
/** Newest diagnostics from each surface, for the downloadable JSON report. */
const diagnostics: { discovery: any; profile: any } = { discovery: null, profile: null };
/** Serializes streamed progress writes so two batches cannot interleave. */
let progressChain: Promise<unknown> = Promise.resolve();
/** Automatic state-machine moves, for the diagnostics report. */
const transitionLog: Array<{ at: string; from: string; to: string; changed: boolean; reason: string }> = [];

/**
 * Abort token for everything long-running.
 *
 * Stop and Clear Queue have to end work that is already in flight — a discovery
 * pass can walk a list for minutes, and Clear Queue is specified to stop the
 * active process. Both bump this counter; every loop checks it and returns
 * instead of writing over the state the user just cleared.
 */
let runGeneration = 0;
/** True while the automatic Start Collecting workflow is running. */
let workflowRunning = false;

function abortRunningWork(): number {
  runGeneration += 1;
  return runGeneration;
}

function isCurrent(generation: number): boolean {
  return generation === runGeneration;
}

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Randomized pacing so the run never looks like a fixed-interval machine. */
function itemDelayMs(): number {
  const spread = Queue.MAX_ITEM_DELAY_MS - Queue.MIN_ITEM_DELAY_MS;
  return Queue.MIN_ITEM_DELAY_MS + Math.floor(Math.random() * Math.max(1, spread));
}

// ---------------------------------------------------------------- persistence

async function readState(): Promise<any> {
  const state = await loadState();
  return { items: state.items, session: state.session };
}

async function writeState(state: any): Promise<any> {
  await replaceItems(state.items || []);
  await saveSession(state.session);
  return state;
}

/** Phase 28: persist only the row that changed plus the session. */
async function writeItemAndSession(state: any, url: string): Promise<any> {
  const item = Queue.findItem(state.items || [], url);
  if (item) await putItem(item);
  await saveSession(state.session);
  return state;
}

// ------------------------------------------------------------------ tab reuse
// Two surfaces, both in the user's own window, both reused for the whole run:
// ONE Connections tab and ONE profile collector tab. Neither is ever replaced,
// and no third tab is ever opened.

/**
 * Step 1: remember the window and the extension tab the run was started from.
 *
 * The importer page supplies its own sender tab. The popup has no tab of its
 * own, so the last focused window's active tab stands in for "where the user
 * is" — that is the window the collector tabs are created in.
 */
async function rememberOrigin(sender: any): Promise<void> {
  const tabId = Number(sender?.tab?.id) || 0;
  const windowId = Number(sender?.tab?.windowId) || 0;
  if (tabId && windowId) {
    await Tabs.rememberHome({ tabId, windowId });
    return;
  }
  try {
    const focused = await chrome.windows.getLastFocused({ populate: true });
    const active = (focused?.tabs || []).find((tab: any) => tab.active) || focused?.tabs?.[0];
    await Tabs.rememberHome({ tabId: Number(active?.id) || null, windowId: Number(focused?.id) || null });
  } catch {
    // With no window to anchor to, tabs.create falls back to the current window.
  }
}

/** Steps 2-3: the one Connections tab, in the same window, activated and waited on. */
async function resolveConnectionsTab(): Promise<number> {
  const before = await Tabs.getConnectionsTabId();
  const { tabId } = await Tabs.ensureConnectionsTab(CONNECTIONS_URL);
  // Wait for the page only when this call actually moved the tab; a tab already
  // sitting on the Connections page must not be reloaded, or the list LinkedIn
  // has already rendered is thrown away.
  if (!before || before !== tabId) await waitForTabComplete(tabId, CONNECTIONS_URL);
  return tabId;
}

/**
 * Put a collector tab in a state LinkedIn will actually render.
 *
 * Chrome throttles a background tab and paints nothing in a minimized window, so
 * an inactive collector produces a frozen DOM — which every "has it finished?"
 * signal reads as finished. Activating is therefore part of collecting. The
 * window is un-minimized but deliberately never focused.
 */
async function prepareCollectorStep(tabId: number): Promise<void> {
  await Tabs.activate(tabId).catch(() => false);
}

/** Requirement 11: is the profile collector being painted right now? */
async function collectorIsRenderable(): Promise<boolean> {
  return Tabs.isProfileTabRenderable().catch(() => false);
}

/** Everything the diagnostics report needs to say about the collector surfaces. */
async function collectorDiagnostics(): Promise<any> {
  return Tabs.describe().catch(() => ({ policy: TabsCore.COMPLETION_POLICY }));
}

/** Record that a collector page was hidden, and pause rather than finish. */
async function pauseForHiddenCollector(): Promise<void> {
  const state = await readState();
  await writeState(Queue.pauseForVisibility(state, nowIso()));
}

/**
 * Step 13: one completion policy, applied in exactly one place.
 *
 * Alarms off, loop generation burned so nothing already in flight can write
 * again, both collector tabs closed, Saved Profiles opened or activated.
 */
async function finishRun(terminalState: string): Promise<void> {
  abortRunningWork();
  await clearHeartbeat();
  await Tabs.closeCollectorTabs().catch(() => undefined);
  await Tabs.openSavedProfilesTab(chrome.runtime.getURL(SAVED_PROFILES_URL)).catch(() => undefined);
  await moveCollectionTo(terminalState);
}

/** Move the persisted state machine, or report that the move was refused. */
async function moveCollectionTo(next: string, patch: any = {}): Promise<boolean> {
  const state = await readState();
  const at = nowIso();
  const result = Queue.transitionCollection(state.session, next, at, patch);
  transitionLog.push({
    at,
    from: String(state.session.collectionState || Queue.COLLECTION_STATE.IDLE),
    to: String(next),
    changed: result.changed,
    reason: result.reason
  });
  if (transitionLog.length > 200) transitionLog.splice(0, transitionLog.length - 200);
  if (!result.changed) return false;
  await saveSession(result.session);
  return true;
}

/** Stop and Clear Queue: shut both collector tabs, leave the user's own alone. */
async function closeCollectorTabs(): Promise<void> {
  await Tabs.closeCollectorTabs().catch(() => undefined);
}

/** Same page, ignoring query, hash, and a trailing slash. */
function sameTarget(current: string, expected: string): boolean {
  if (!expected) return true;
  try {
    const left = new URL(String(current || ""));
    const right = new URL(expected);
    const path = (value: string) => value.replace(/\/+$/, "").toLowerCase();
    return left.origin === right.origin && path(left.pathname) === path(right.pathname);
  } catch {
    return false;
  }
}

/**
 * Wait for the collector tab to finish loading.
 *
 * `expectedUrl` matters: right after `chrome.tabs.update` the tab still reports
 * the PREVIOUS page as `complete`, so a bare status check returns immediately and
 * the next profile is read off the page before it exists. A "complete" that is
 * still showing the old URL is therefore ignored.
 */
function waitForTabComplete(tabId: number, expectedUrl = "", timeoutMs = NAVIGATION_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (updatedTabId: number, info: any, tab: any) => {
      if (updatedTabId !== tabId || info?.status !== "complete") return;
      const current = String(tab?.url || "");
      if (!expectedUrl) return finish();
      if (sameTarget(current, expectedUrl)) return finish();
      // LinkedIn redirects a signed-out request to its login wall, and arriving
      // there is a real arrival. Only the page we were already on is stale.
      if (!sameTarget(current, previousUrl)) return finish();
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(new Error("The collector tab was closed."));
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the page to load.")), timeoutMs);
    let previousUrl = "";
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((tab: any) => {
      previousUrl = String(tab?.url || "");
      // Already there and already loaded: nothing to wait for.
      if (tab?.status === "complete" && (!expectedUrl || sameTarget(previousUrl, expectedUrl))) finish();
    }).catch(() => finish(new Error("The collector tab is unavailable.")));
  });
}

function sendTabMessage(tabId: number, message: any, timeoutMs: number): Promise<any> {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => setTimeout(() => reject(new Error("The content script did not respond in time.")), timeoutMs))
  ]);
}

/**
 * Ping, and inject the framework-free scripts only if the tab has no live
 * listener. `pingType` exists because each surface answers to its own ping —
 * the applicants script must never be mistaken for a stale profile script and
 * re-injected on top of a run that is already going.
 */
async function ensureContentScript(tabId: number, files: string[], pingType: string = PROFILE_MESSAGES.PING): Promise<any> {
  try {
    const response = await sendTabMessage(tabId, { type: pingType }, PING_TIMEOUT_MS);
    if (response?.ok && response.buildId === BUILD_ID) return response;
  } catch {
    // Fall through to a bounded injection below.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await delay(300 * (attempt + 1));
    try {
      const response = await sendTabMessage(tabId, { type: pingType }, PING_TIMEOUT_MS);
      if (response?.ok && response.buildId === BUILD_ID) return response;
    } catch {
      // Retry a bounded number of times, then give up.
    }
  }
  throw new Error("Could not reach the Profile Vault content script on this tab.");
}

// -------------------------------------------------------- phases 21-24: discover

// ------------------------------------------------------------ authentication
// The extension never sees a credential. It only asks the page whether the
// browser already has a LinkedIn session, and if not, opens LinkedIn's own
// sign-in page and stops.

/** Open LinkedIn's official sign-in page in the Connections tab. Nothing else. */
async function openLoginPage(): Promise<number> {
  const { tabId } = await Tabs.ensureConnectionsTab(LOGIN_URL);
  // Signing in is the one step that genuinely needs the user, so this is also
  // the one place the collector window is allowed to take focus.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // Focusing is a courtesy; the tab is already active either way.
  }
  return tabId;
}

/** The URL of whichever LinkedIn surface the auth check should read. */
async function authTabUrl(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return String(tab?.url || tab?.pendingUrl || "");
  } catch {
    return "";
  }
}

/**
 * Which tab answers "is the browser signed in?".
 *
 * The profile collector when a run is mid-profile — checking the login must
 * never drag an extraction off the page it is reading — otherwise the
 * Connections tab, opening it if this is the start of a run.
 */
async function resolveAuthTab(): Promise<number> {
  const profileTabId = await Tabs.getProfileTabId();
  if (profileTabId && Connections.isLinkedInUrl(await authTabUrl(profileTabId))) return profileTabId;
  const connectionsTabId = await Tabs.getConnectionsTabId();
  if (connectionsTabId && Connections.isLinkedInUrl(await authTabUrl(connectionsTabId))) return connectionsTabId;
  return resolveConnectionsTab();
}

async function checkLoginState(): Promise<any> {
  let tabId: number;
  try {
    tabId = await resolveAuthTab();
  } catch (error) {
    return {
      state: Connections.AUTH_STATE.UNKNOWN,
      signedIn: false,
      kind: "",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const url = await authTabUrl(tabId);
  // A redirect to the sign-in wall or a checkpoint is decisive on its own.
  const fromUrl = Connections.classifyAuthState({ url, memberMarkers: 0, reachable: true });
  if (fromUrl.state === Connections.AUTH_STATE.LOGIN_REQUIRED || fromUrl.state === Connections.AUTH_STATE.CHECKPOINT) {
    await rememberAuthState(fromUrl);
    return fromUrl;
  }

  try {
    // Whichever content script belongs to the page the collector tab is on.
    await ensureContentScript(tabId, /linkedin\.com\/in\//i.test(url) ? PROFILE_SCRIPTS : CONNECTION_SCRIPTS);
    const response = await sendTabMessage(tabId, { type: CONNECTION_MESSAGES.CHECK_LOGIN }, PING_TIMEOUT_MS * 2);
    const auth = response?.auth || { state: Connections.AUTH_STATE.UNKNOWN, signedIn: false, kind: "", message: "" };
    await rememberAuthState(auth);
    return auth;
  } catch (error) {
    const auth = Connections.classifyAuthState({
      url,
      reachable: false,
      memberMarkers: 0
    });
    auth.message = error instanceof Error ? error.message : auth.message;
    await rememberAuthState(auth);
    return auth;
  }
}

async function rememberAuthState(auth: any): Promise<void> {
  const state = await readState();
  await saveSession({
    ...state.session,
    authState: String(auth?.state || "unknown"),
    authMessage: String(auth?.message || ""),
    updatedAt: nowIso()
  });
}

/**
 * Phase 22: repeat resumable discovery passes until coverage settles.
 * Each pass resumes from the persisted cursor, so a long list is enumerated across
 * many passes without ever restarting from the top. The loop ends when the reliable
 * advertised total is reached, or the list is provably exhausted.
 */
/**
 * Reveal the next set of connections: scroll on to the end of what is rendered,
 * wait for LinkedIn to load more, and use an allowlisted pagination control if one
 * is present. Returns how many new connections were queued.
 */
async function discoverNextPage(): Promise<{ added: number; challenge?: any; hidden?: boolean; exhausted: boolean }> {
  const state = await readState();
  const discovery = Queue.createDiscoveryState(state.session.discovery || {});
  const tabId = await resolveConnectionsTab();
  await ensureContentScript(tabId, CONNECTION_SCRIPTS);
  await prepareCollectorStep(tabId);

  const result = await sendTabMessage(
    tabId,
    { type: CONNECTION_MESSAGES.DISCOVER, options: { cursorY: discovery.cursorY, mode: "advance" } },
    DISCOVERY_TIMEOUT_MS
  );
  if (!result?.ok) throw new Error(result?.error || "Connection discovery failed.");
  diagnostics.discovery = result.diagnostics || diagnostics.discovery;
  if (result.hidden) return { added: 0, hidden: true, exhausted: false };
  if (result.challenge?.challenged) return { added: 0, challenge: result.challenge, exhausted: false };

  const current = await readState();
  const enqueued = Queue.enqueueUrls(current.items, result.entries || result.urls || [], nowIso());
  const nextDiscovery = Queue.applyDiscoveryPass(current.session, result, enqueued.added, nowIso());
  await writeState({
    items: enqueued.items,
    session: { ...current.session, discovery: nextDiscovery, discoveryExhausted: nextDiscovery.exhausted }
  });
  return { added: enqueued.added, exhausted: nextDiscovery.exhausted };
}

/**
 * Find All Connections.
 *
 * Repeats resumable discovery passes until the whole list has been enumerated:
 * every pass reads the rendered cards, scrolls on, waits for LinkedIn's lazy
 * loading, and uses an allowlisted pagination control when one is offered. The
 * accumulated list is written to IndexedDB after every pass, so the full set is
 * persisted before any extraction is allowed to start.
 */
async function runDiscovery(maxPasses = MAX_DISCOVERY_PASSES, generation = runGeneration): Promise<any> {
  const tabId = await resolveConnectionsTab();
  await ensureContentScript(tabId, CONNECTION_SCRIPTS);

  let totalAdded = 0;
  let totalDuplicates = 0;
  let passes = 0;
  let stoppedBy = "settled";

  for (let pass = 0; pass < maxPasses; pass += 1) {
    // Stop and Clear Queue must end an enumeration that is already walking.
    if (!isCurrent(generation)) {
      return { ok: true, added: totalAdded, duplicates: totalDuplicates, passes, stoppedBy: "aborted", aborted: true };
    }
    const state = await readState();
    const discovery = Queue.createDiscoveryState(state.session.discovery || {});

    // LinkedIn must be painting the page before the pass is allowed to conclude
    // anything about how much of the list exists.
    await prepareCollectorStep(tabId);

    const result = await sendTabMessage(
      tabId,
      { type: CONNECTION_MESSAGES.DISCOVER, options: { cursorY: discovery.cursorY, mode: "advance" } },
      DISCOVERY_TIMEOUT_MS
    );
    passes += 1;

    if (!result?.ok) throw new Error(result?.error || "Connection discovery failed.");
    diagnostics.discovery = result.diagnostics || diagnostics.discovery;
    if (!isCurrent(generation)) {
      return { ok: true, added: totalAdded, duplicates: totalDuplicates, passes, stoppedBy: "aborted", aborted: true };
    }

    if (result.hidden) {
      // The page went hidden. This is an interruption, never the end of the list.
      await pauseForHiddenCollector();
      return { ok: false, hidden: true, added: totalAdded, duplicates: totalDuplicates, passes, stoppedBy: "hidden" };
    }

    if (result.challenge?.challenged) {
      await writeState(Queue.pauseSession(state, nowIso(), result.challenge.message, result.challenge.kind));
      return { ok: false, challenge: result.challenge, added: totalAdded, duplicates: totalDuplicates, passes, stoppedBy: "challenge" };
    }

    // `entries` carries the name alongside the URL; `urls` is the fallback for a
    // content script that predates it.
    const enqueued = Queue.enqueueUrls(state.items, result.entries || result.urls || [], nowIso());
    totalAdded += enqueued.added;
    totalDuplicates += enqueued.duplicates;

    const nextDiscovery = Queue.applyDiscoveryPass(state.session, result, enqueued.added, nowIso());
    // Persisted every pass: an interrupted enumeration never loses what it found.
    await writeState({
      items: enqueued.items,
      session: { ...state.session, discovery: nextDiscovery, discoveryExhausted: nextDiscovery.exhausted }
    });

    if (nextDiscovery.coverageConfirmed) {
      stoppedBy = "total-reached";
      break;
    }
    if (nextDiscovery.exhausted) {
      stoppedBy = "settled";
      break;
    }
    if (pass + 1 >= maxPasses) stoppedBy = "pass-budget";

    // Brief pause between passes so the page can settle.
    await delay(900);
  }

  const finalState = await readState();
  // Record why enumeration ended so the importer page can show a real reason
  // rather than leaving a silent early stop indistinguishable from completion.
  await saveSession({
    ...finalState.session,
    discovery: { ...finalState.session.discovery, stopReason: stoppedBy },
    updatedAt: nowIso()
  });
  return {
    ok: true,
    added: totalAdded,
    duplicates: totalDuplicates,
    passes,
    stoppedBy,
    coverage: Queue.coverageReport(finalState),
    reconciliation: reconcileState(finalState)
  };
}

/** Explain LinkedIn's advertised total against what discovery could actually use. */
function reconcileState(state: any): any {
  const coverage = Queue.coverageReport(state);
  return Connections.reconcileDiscovery({
    advertisedTotal: coverage.totalCount,
    totalReliable: coverage.totalReliable,
    uniqueUrls: coverage.discovered,
    duplicateLinks: coverage.duplicateLinks,
    cardsWithoutUrl: coverage.cardsWithoutUrl,
    restrictedCards: coverage.restrictedCards
  });
}

/**
 * Persist connections streamed out of a discovery pass while it is still running.
 *
 * A pass can walk a long list for minutes. Writing only at the end meant a tab
 * reload, a closed popup, or a suspended worker threw all of it away. Rows are
 * written one at a time so a multi-thousand-row queue stays cheap, and the writes
 * are chained so concurrent batches cannot clobber each other.
 */
async function persistDiscoveredEntries(entries: any[]): Promise<number> {
  if (!Array.isArray(entries) || !entries.length) return 0;
  const state = await readState();
  const enqueued = Queue.enqueueUrls(state.items, entries, nowIso());
  if (!enqueued.added) return 0;
  const added = new Set(enqueued.addedUrls.map((url: string) => String(url).toLowerCase()));
  for (const item of enqueued.items) {
    if (added.has(String(item.url).toLowerCase())) await putItem(item);
  }
  return enqueued.added;
}

function queueDiscoveryProgress(message: any): void {
  diagnostics.discovery = { ...(diagnostics.discovery || {}), ...(message?.diagnostics || {}), updatedAt: nowIso() };
  progressChain = progressChain
    .then(() => persistDiscoveredEntries(message?.entries || []))
    .catch(() => 0);
}

/** Mark discovery busy/idle so the page can disable Find All Connections. */
async function setDiscoveryRunning(running: boolean): Promise<void> {
  const state = await readState();
  await saveSession({ ...state.session, discoveryRunning: running, updatedAt: nowIso() });
}

// ------------------------------------------------------------------- one item

/** Replace an existing record by canonical URL, keeping id, collectedAt, notes, tags. */
async function persistProfile(rawProfile: any): Promise<string> {
  // The importer stamps both columns the table shows for a run: when this
  // collection happened, and how it ended. `normalizeProfile` derives the status
  // from what the scan actually produced when nothing is stated here.
  let profile = normalizeProfile({ ...rawProfile, lastCollectedAt: nowIso() });
  const existing = await findByProfileUrl(profile.profileUrl);
  if (existing) profile = replaceProfile(existing, profile);
  const saved = await saveProfile(profile);
  return saved.id;
}

async function processItem(item: any, session: any): Promise<{ ok: boolean; profileId?: string; error?: string; challenge?: any; navigation?: boolean; hidden?: boolean; fresh?: boolean; collectedAt?: string }> {
  // Phase 27: skip a profile that was collected within the configured number of days.
  try {
    const existing = await findByProfileUrl(item.url);
    if (existing && Queue.shouldSkipAsFresh(session, existing.updatedAt, nowIso())) {
      return { ok: true, profileId: existing.id, fresh: true, collectedAt: existing.updatedAt };
    }
  } catch {
    // A lookup failure is not fatal; fall through and extract normally.
  }

  let tabId: number;
  try {
    // Step 8: THE SAME collector tab, navigated straight to the next profile.
    // Never a new tab — `navigateProfileTab` only creates one when the user has
    // closed the collector, and a test drives a whole queue through it asserting
    // exactly one tab is ever created.
    await moveCollectionTo(Queue.COLLECTION_STATE.MOVING_TO_NEXT_PROFILE);
    const target = await Tabs.navigateProfileTab(item.url);
    tabId = target.tabId;
    // The expected URL matters: a bare status check returns on the PREVIOUS
    // profile's "complete" and the next profile is read before it exists.
    await waitForTabComplete(tabId, item.url);
    // Requirement 9: active tab, non-minimized window. LinkedIn renders nothing
    // otherwise, and an unrendered profile would be saved as an empty one.
    await prepareCollectorStep(tabId);
    await delay(PROFILE_SETTLE_MS);
  } catch (error) {
    return { ok: false, navigation: true, error: error instanceof Error ? error.message : String(error) };
  }

  // Requirement 9, first clause: do not begin reading until Chrome is actually
  // painting this tab. Starting on a hidden tab produces a profile with nothing
  // below the fold in it.
  if (!(await collectorIsRenderable())) {
    return { ok: false, hidden: true, error: Queue.VISIBILITY_PAUSE_MESSAGE };
  }

  try {
    await ensureContentScript(tabId, PROFILE_SCRIPTS);
  } catch (error) {
    return { ok: false, navigation: true, error: error instanceof Error ? error.message : String(error) };
  }

  const page = await sendTabMessage(tabId, { type: PROFILE_MESSAGES.CHECK_PAGE }, PING_TIMEOUT_MS * 2).catch(() => null);
  if (page?.challenge?.challenged) {
    return { ok: false, challenge: page.challenge, error: page.challenge.message };
  }

  let response: any;
  try {
    await moveCollectionTo(Queue.COLLECTION_STATE.EXTRACTING_PROFILE);
    response = await sendTabMessage(tabId, { type: PROFILE_MESSAGES.EXTRACT, options: { lazyScroll: true } }, EXTRACT_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  diagnostics.profile = response?.diagnostics || diagnostics.profile;

  if (!response?.ok) {
    if (response?.challenge?.challenged) return { ok: false, challenge: response.challenge, error: response.challenge.message };
    // A hidden page is an interruption, not a bad profile: the connection goes
    // back to pending and nothing partial is written.
    if (response?.hidden) return { ok: false, hidden: true, error: response.error || "The collector page was hidden." };
    return { ok: false, error: response?.error || "Extraction failed." };
  }

  // Requirement 11, restated at the save boundary: the content script only
  // returns `ok` after a stable bottom, but the tab can go hidden between that
  // moment and this one. A record read from a page the user has switched away
  // from is refused rather than written.
  if (!(await collectorIsRenderable())) {
    return { ok: false, hidden: true, error: Queue.VISIBILITY_PAUSE_MESSAGE };
  }

  try {
    await moveCollectionTo(Queue.COLLECTION_STATE.SAVING_PROFILE);
    const profileId = await persistProfile(response.profile);
    return { ok: true, profileId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ------------------------------------------------------------------- the loop

async function runLoop(generation = runGeneration): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  try {
    // Strictly sequential: exactly one profile is in flight at any time.
    for (;;) {
      // Stop and Clear Queue end the run here rather than letting an in-flight
      // profile write its result back over a queue the user just cleared.
      if (!isCurrent(generation)) return;
      const state = await readState();
      const claim = Queue.claimNext(state, nowIso());

      if (!claim.item) {
        if (claim.reason === "limit-reached") {
          // D3: cooldown starts now; the heartbeat restarts the next batch.
          await writeState({ items: claim.items, session: claim.session });
          return;
        }
        if (claim.reason === "empty") {
          // The queue drained. Ask discovery for more, but only a bounded number
          // of times: a pass that reports neither growth nor exhaustion used to
          // be retried forever here, which is what made collection never finish.
          if (Queue.shouldContinueAutoDiscovery(state.session)) {
            let next;
            try {
              next = await discoverNextPage();
            } catch (error) {
              await writeState(Queue.pauseSession(
                await readState(), nowIso(),
                error instanceof Error ? error.message : String(error), "", Queue.PAUSED_BY.ERROR
              ));
              return;
            }
            if (next.hidden) {
              await pauseForHiddenCollector();
              return;
            }
            if (next.challenge?.challenged) {
              await writeState(Queue.pauseSession(await readState(), nowIso(), next.challenge.message, next.challenge.kind));
              return;
            }
            const current = await readState();
            if (next.added > 0) {
              await saveSession(Queue.registerDiscoveryGrowth(current.session, nowIso()));
              continue;
            }
            // Nothing new. Count the attempt; after MAX_FRUITLESS_DISCOVERY the
            // list is treated as finished instead of being asked again.
            const spent = Queue.registerFruitlessDiscovery(current.session, nowIso());
            await saveSession(spent);
            if (Queue.shouldContinueAutoDiscovery(spent) && !next.exhausted) {
              await delay(2000);
              continue;
            }
          }

          // Requirement 13. Every queued connection is completed, failed, or
          // skipped and discovery has nothing left to offer, so the run is over:
          // the session is marked finished, the alarms and the loop stop, the
          // two collector tabs are closed, and Saved Profiles is opened.
          const done = await readState();
          const finished = {
            items: done.items,
            session: { ...claim.session, ...done.session, discoveryExhausted: true, currentUrl: "", currentName: "" }
          };
          await writeState(finished);
          await finishRun(Queue.terminalStateFor(finished));
          return;
        }
        if (claim.reason === "backoff") {
          // Every pending item is waiting out an exponential backoff.
          await delay(Queue.BACKOFF_BASE_MS);
          continue;
        }
        return;
      }

      await writeItemAndSession({ items: claim.items, session: claim.session }, claim.item.url);

      const item = claim.item;
      const result = await processItem(item, claim.session);
      if (!isCurrent(generation)) return;
      const current = await readState();

      if (result.challenge?.challenged) {
        // Stop the moment LinkedIn shows a challenge. The item returns to pending
        // and only a human may resume from here.
        const requeued = current.items.map((entry: any) =>
          entry.url === item.url ? { ...entry, status: Queue.ITEM_STATUS.PENDING, updatedAt: nowIso() } : entry
        );
        await writeState(Queue.pauseSession({ items: requeued, session: current.session }, nowIso(), result.challenge.message, result.challenge.kind));
        return;
      }

      if (result.hidden) {
        // Put the connection back and pause. Nothing partial is ever saved.
        const requeued = current.items.map((entry: any) =>
          entry.url === item.url ? { ...entry, status: Queue.ITEM_STATUS.PENDING, updatedAt: nowIso() } : entry
        );
        await writeState(Queue.pauseForVisibility({ items: requeued, session: current.session }, nowIso()));
        return;
      }

      if (result.ok) {
        const next = Queue.markCompleted(
          current, item.url, nowIso(), result.profileId || "", Boolean(result.fresh), result.collectedAt || ""
        );
        await writeItemAndSession(next, item.url);
      } else if (result.navigation) {
        const navState = Queue.registerNavigationFailure(current, nowIso(), result.error || "");
        const failed = Queue.markFailed({ items: navState.items, session: navState.session }, item.url, nowIso(), result.error || "");
        const session = navState.session.status === Queue.SESSION_STATUS.PAUSED ? navState.session : failed.session;
        await writeItemAndSession({ items: failed.items, session }, item.url);
        if (navState.tripped) return;
      } else {
        const failed = Queue.markFailed(current, item.url, nowIso(), result.error || "");
        await writeItemAndSession(failed, item.url);
      }

      const after = await readState();
      if (after.session.status !== Queue.SESSION_STATUS.RUNNING) return;
      // Deliberate randomized pacing between profiles - this is not a bulk scraper.
      if (!result.fresh) await delay(itemDelayMs());
    }
  } finally {
    loopRunning = false;
  }
}

function kickLoop(): void {
  const generation = runGeneration;
  runLoop(generation).catch(async (error) => {
    if (!isCurrent(generation)) return;
    const state = await readState();
    await writeState(Queue.pauseSession(state, nowIso(), error instanceof Error ? error.message : String(error), "", Queue.PAUSED_BY.ERROR));
  });
}

// ------------------------------------------------- the automatic workflow
// Start Full Collection is one click and then nothing else:
//
//   1  remember the window and the extension tab it was clicked from
//   2  open or reuse the Connections tab in that same window
//   3  activate it and keep it visible
//   4  walk the whole connections list
//   5  stop on stable bottom + reconciliation
//   6  open or reuse the ONE profile collector tab in the same window
//   7  activate it
//   8  navigate that one tab to each queued profile in turn
//
// Steps 5 -> 6 used to require a manual Stop followed by Start Extraction. The
// worker now takes that transition itself, and a test asserts the hand-over
// happens without passing through `stopped` or `idle`.
//
// It runs detached from the message that started it, because the popup and the
// importer page are both allowed to close while it works.

async function startCollectingWorkflow(options: any = {}): Promise<void> {
  const generation = runGeneration;
  // Idempotent entry. The transition is persisted, so a service-worker wake-up
  // that re-issues the command cannot start a second discovery.
  if (!(await moveCollectionTo(Queue.COLLECTION_STATE.OPENING_CONNECTIONS))) return;

  workflowRunning = true;
  await setDiscoveryRunning(true);
  try {
    // Signed in? If not, open LinkedIn's own login page and stop here.
    const auth = await checkLoginState();
    if (!isCurrent(generation)) return;
    if (auth.state === Connections.AUTH_STATE.LOGIN_REQUIRED) {
      await openLoginPage();
      const state = await readState();
      await writeState(Queue.pauseSession(state, nowIso(), auth.message, "login"));
      await moveCollectionTo(Queue.COLLECTION_STATE.PAUSED_CHALLENGE);
      return;
    }
    if (auth.state === Connections.AUTH_STATE.CHECKPOINT) {
      const state = await readState();
      await writeState(Queue.pauseSession(state, nowIso(), auth.message, auth.kind || "checkpoint"));
      await moveCollectionTo(Queue.COLLECTION_STATE.PAUSED_CHALLENGE);
      return;
    }

    // Steps 2-3. The Connections tab is opened or reused in the user's window
    // and made the active tab before a single card is read.
    await resolveConnectionsTab();

    // Steps 4-5. Enumerate the whole list. Every pass is persisted as it goes.
    await moveCollectionTo(Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS);
    const discovery = await runDiscovery(Number(options.maxPasses) || MAX_DISCOVERY_PASSES, generation);
    if (!isCurrent(generation) || discovery.aborted) return;
    if (discovery.hidden) {
      await moveCollectionTo(Queue.COLLECTION_STATE.PAUSED_HIDDEN);
      return;
    }

    const afterDiscovery = await readState();
    if (afterDiscovery.session.pausedBy === Queue.PAUSED_BY.CHALLENGE) {
      await moveCollectionTo(Queue.COLLECTION_STATE.PAUSED_CHALLENGE);
      return;
    }

    // The list is enumerated and reconciled against LinkedIn's advertised total.
    await moveCollectionTo(Queue.COLLECTION_STATE.CONNECTIONS_COMPLETE);
    const reconciled = await readState();
    if (options.discoveryOnly) {
      await finishRun(Queue.terminalStateFor(reconciled));
      return;
    }

    // Steps 6-7. The automatic hand-over: create or reuse the ONE profile
    // collector tab, in the same window, and activate it. No user action.
    await moveCollectionTo(Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR);
    await Tabs.ensureProfileTab(CONNECTIONS_URL);

    // Steps 8-10. Extraction starts by itself, over exactly what was discovered.
    await writeState(Queue.startSession(await readState(), nowIso(), {
      sessionLimit: options.sessionLimit,
      cooldownMs: options.cooldownMs,
      refreshMaxAgeDays: options.refreshMaxAgeDays,
      forceRefresh: options.forceRefresh,
      scope: Queue.SELECTION_SCOPE.ALL,
      scopeUrls: [],
      // If the queue drains while the list has not settled, the loop keeps
      // paging forward rather than declaring the account finished.
      autoDiscover: true
    }));
    await moveCollectionTo(Queue.COLLECTION_STATE.EXTRACTING_PROFILE);
    await ensureHeartbeat();
    kickLoop();
  } catch (error) {
    if (!isCurrent(generation)) return;
    const state = await readState();
    await writeState(Queue.pauseSession(
      state, nowIso(), error instanceof Error ? error.message : String(error), "", Queue.PAUSED_BY.ERROR
    ));
    await moveCollectionTo(Queue.COLLECTION_STATE.FAILED);
  } finally {
    workflowRunning = false;
    await setDiscoveryRunning(false).catch(() => undefined);
  }
}

/** Find All Connections, detached from the message that requested it. */
async function discoveryOnlyWorkflow(options: any = {}): Promise<void> {
  const generation = runGeneration;
  if (!(await moveCollectionTo(Queue.COLLECTION_STATE.OPENING_CONNECTIONS))) return;
  await setDiscoveryRunning(true);
  try {
    const auth = await checkLoginState();
    if (!isCurrent(generation)) return;
    if (auth.state === Connections.AUTH_STATE.LOGIN_REQUIRED) {
      await openLoginPage();
      const state = await readState();
      await writeState(Queue.pauseSession(state, nowIso(), auth.message, "login"));
      await moveCollectionTo(Queue.COLLECTION_STATE.PAUSED_CHALLENGE);
      return;
    }
    await resolveConnectionsTab();
    await moveCollectionTo(Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS);
    const discovery = await runDiscovery(Number(options.maxPasses) || MAX_DISCOVERY_PASSES, generation);
    if (!isCurrent(generation) || discovery.aborted) return;
    if (discovery.hidden) {
      await moveCollectionTo(Queue.COLLECTION_STATE.PAUSED_HIDDEN);
      return;
    }
    // Discovery only: reconcile, then stop in a terminal state. It must never
    // open the profile collector — extraction is a separate, explicit action in
    // this mode, and a test asserts this branch never starts a session.
    await moveCollectionTo(Queue.COLLECTION_STATE.CONNECTIONS_COMPLETE);
    await finishRun(Queue.terminalStateFor(await readState()));
  } catch (error) {
    if (!isCurrent(generation)) return;
    const state = await readState();
    await saveSession({
      ...state.session,
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: nowIso()
    });
    await moveCollectionTo(Queue.COLLECTION_STATE.FAILED);
  } finally {
    await setDiscoveryRunning(false).catch(() => undefined);
  }
}

// ------------------------------------------------------------- phase 25: alarms

async function ensureHeartbeat(): Promise<void> {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM).catch(() => null);
  if (!existing) await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
}

async function clearHeartbeat(): Promise<void> {
  await chrome.alarms.clear(HEARTBEAT_ALARM).catch(() => undefined);
}

/**
 * Fires roughly every minute. It resumes normal interrupted processing and starts
 * the next batch once a cooldown has elapsed. It never clears a pause caused by a
 * challenge, a restriction, a navigation trip, or the user.
 */
async function onHeartbeat(): Promise<void> {
  const state = await readState();
  const session = state.session;

  // Requirement 13: a finished run keeps no machinery alive. A terminal
  // collection state outranks whatever the session status happens to say.
  if (Queue.isTerminalCollectionState(session.collectionState)) {
    await clearHeartbeat();
    return;
  }

  if (session.status === Queue.SESSION_STATUS.RUNNING) {
    if (!loopRunning) kickLoop();
    return;
  }

  // Requirement 12: a hidden-collector pause clears itself. Bring the collector
  // tab back to the front of its window and continue once Chrome is painting it.
  if (Queue.canResumeFromVisibility(session)) {
    await resumeFromHidden();
    return;
  }

  if (Queue.cooldownElapsed(session, nowIso())) {
    const resumed = Queue.resumeSession(state, nowIso());
    await writeState(resumed);
    kickLoop();
    return;
  }

  if (session.status !== Queue.SESSION_STATUS.PAUSED || session.pausedBy !== Queue.PAUSED_BY.COOLDOWN) {
    // Nothing is waiting to continue on its own.
    if (session.status === Queue.SESSION_STATUS.IDLE || session.status === Queue.SESSION_STATUS.STOPPED) {
      await clearHeartbeat();
    }
  }
}

/**
 * Requirement 12: come back from a hidden-collector pause.
 *
 * Driven both by the minute heartbeat and, much sooner, by the tab and window
 * events below — switching back to the collector tab should continue the run in
 * about a second, not on the next alarm. It resumes into whichever half of the
 * workflow was interrupted, so a pause during discovery does not restart
 * extraction and vice versa.
 */
async function resumeFromHidden(): Promise<boolean> {
  const state = await readState();
  if (!Queue.canResumeFromVisibility(state.session)) return false;

  const target = String(state.session.resumeCollectionState || Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR);
  const key = target === Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS ||
    target === Queue.COLLECTION_STATE.OPENING_CONNECTIONS
    ? TabsCore.KEYS.CONNECTIONS_TAB
    : TabsCore.KEYS.PROFILE_TAB;

  const tabId = key === TabsCore.KEYS.CONNECTIONS_TAB
    ? await Tabs.getConnectionsTabId()
    : await Tabs.getProfileTabId();
  if (tabId) await prepareCollectorStep(tabId);
  if (!(await Tabs.isRenderable(key))) return false;

  await writeState(Queue.resumeSession(await readState(), nowIso()));
  await moveCollectionTo(target);
  kickLoop();
  return true;
}

chrome.alarms.onAlarm.addListener((alarm: any) => {
  if (alarm?.name === HEARTBEAT_ALARM) {
    onHeartbeat().catch(() => undefined);
  }
});

// ------------------------------------------------- requirements 11 and 12
// Switching away from the collector tab must pause the run rather than let it
// read a frozen page, and switching back must continue it. The alarm alone is
// too coarse for that — it fires once a minute — so the tab and window events
// drive the same two functions directly.

/** The user activated some other tab: is the collector still being painted? */
async function onSurfaceChanged(): Promise<void> {
  const state = await readState();
  const session = state.session;

  if (Queue.canResumeFromVisibility(session)) {
    await resumeFromHidden();
    return;
  }

  if (session.status !== Queue.SESSION_STATUS.RUNNING) return;
  if (!Queue.isActiveCollectionState(session.collectionState)) return;

  // Only the surface the run is currently using matters: the Connections tab
  // going background after discovery finished is not a reason to pause.
  const usingConnections = session.collectionState === Queue.COLLECTION_STATE.DISCOVERING_CONNECTIONS ||
    session.collectionState === Queue.COLLECTION_STATE.OPENING_CONNECTIONS;
  const renderable = usingConnections
    ? await Tabs.isConnectionsTabRenderable()
    : await Tabs.isProfileTabRenderable();
  if (renderable) return;

  // Requirement 11: pause instead of saving whatever the hidden page shows.
  abortRunningWork();
  await pauseForHiddenCollector();
}

chrome.tabs.onActivated.addListener(() => {
  onSurfaceChanged().catch(() => undefined);
});

chrome.windows.onFocusChanged.addListener(() => {
  onSurfaceChanged().catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  // A collector tab the user closed must be forgotten, or the next step reuses a
  // dead id and the run stalls instead of reopening one tab.
  Tabs.forgetClosedTab(tabId).catch(() => undefined);
});

// ------------------------------------------------------------------- commands

async function statusResponse(): Promise<any> {
  const state = await readState();
  return {
    ok: true,
    summary: Queue.summarize(state),
    items: state.items,
    // Why LinkedIn's advertised total and the collected URLs differ.
    reconciliation: reconcileState(state),
    workflowRunning,
    buildId: BUILD_ID
  };
}

async function handleCommand(type: string, message: any, sender: any = null): Promise<any> {
  const state = await readState();
  const now = nowIso();

  if (type === IMPORT_MESSAGES.STATUS) return statusResponse();

  if (type === IMPORT_MESSAGES.CHECK_LOGIN) {
    // Session detection only. No credential is ever requested or stored.
    const auth = await checkLoginState();
    return { ...(await statusResponse()), auth };
  }

  if (type === IMPORT_MESSAGES.OPEN_LOGIN) {
    // Opens LinkedIn's official sign-in page and nothing else.
    await openLoginPage();
    return { ...(await statusResponse()), opened: LOGIN_URL };
  }

  if (type === IMPORT_MESSAGES.DISCOVER || type === IMPORT_MESSAGES.DISCOVER_ALL) {
    // Find All Connections. Discovery never starts extraction: the full list is
    // enumerated and saved, and the user starts collecting as a separate step.
    // It runs detached so the page may be closed while it works.
    if (state.session.discoveryRunning) {
      return { ...(await statusResponse()), ok: false, error: "A scan of your connections is already running." };
    }
    await rememberOrigin(sender);
    discoveryOnlyWorkflow({ maxPasses: message?.maxPasses }).catch(() => undefined);
    return { ...(await statusResponse()), started: true };
  }

  if (type === IMPORT_MESSAGES.START_COLLECTING || type === IMPORT_MESSAGES.RUN_ALL) {
    // One click, the whole way through: remember this window and tab, open and
    // activate the Connections tab in it, enumerate everything, then open and
    // activate the profile collector tab and extract. Detached from this message
    // so neither the popup nor the importer page has to stay open while it runs.
    if (workflowRunning || state.session.discoveryRunning) {
      return { ...(await statusResponse()), ok: false, error: "Collecting is already running." };
    }
    // Step 1, and it must happen before the workflow is detached: `sender` is
    // only meaningful while this message is being handled.
    await rememberOrigin(sender);
    startCollectingWorkflow({
      maxPasses: message?.maxPasses,
      sessionLimit: message?.sessionLimit,
      cooldownMs: message?.cooldownMs,
      refreshMaxAgeDays: message?.refreshMaxAgeDays,
      forceRefresh: message?.forceRefresh
    }).catch(() => undefined);
    return { ...(await statusResponse()), started: true };
  }

  if (type === IMPORT_MESSAGES.ENQUEUE) {
    const enqueued = Queue.enqueueUrls(state.items, message?.urls || [], now);
    await writeState({ items: enqueued.items, session: state.session });
    return { ...(await statusResponse()), added: enqueued.added, duplicates: enqueued.duplicates };
  }

  if (type === IMPORT_MESSAGES.START) {
    // Start Extraction. Runs over the connections already discovered and saved -
    // it never enumerates the list itself, so the two steps stay separate.
    const refreshMaxAgeDays = Number(message?.refreshMaxAgeDays) >= 0
      ? Number(message.refreshMaxAgeDays)
      : state.session.refreshMaxAgeDays;
    const scope = String(message?.scope || Queue.SELECTION_SCOPE.ALL);
    const urls = Queue.selectItemUrls(state.items, {
      scope,
      urls: message?.urls || [],
      refreshMaxAgeDays,
      now
    });
    if (!urls.length) {
      return { ...(await statusResponse()), ok: false, error: "No connections match that selection. Find your connections first, or widen the selection." };
    }

    // Manual extraction is the recovery path for a discovery-only run, so it
    // takes the same hand-over the automatic workflow does: connections done ->
    // open and activate the ONE profile collector tab -> extract.
    await rememberOrigin(sender);
    await moveCollectionTo(Queue.COLLECTION_STATE.CONNECTIONS_COMPLETE);
    await moveCollectionTo(Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR);
    await Tabs.ensureProfileTab(CONNECTIONS_URL);
    const prepared = Queue.prepareRun(state, urls, now, scope);
    await writeState(Queue.startSession(prepared, now, {
      sessionLimit: message?.sessionLimit,
      cooldownMs: message?.cooldownMs,
      refreshMaxAgeDays,
      forceRefresh: message?.forceRefresh,
      scope,
      scopeUrls: urls,
      // Discovery is an explicit, separate action, so a run never pages the
      // connections list on its own.
      autoDiscover: false
    }));
    await moveCollectionTo(Queue.COLLECTION_STATE.EXTRACTING_PROFILE);
    await ensureHeartbeat();
    kickLoop();
    return { ...(await statusResponse()), selected: prepared.selected };
  }

  if (type === IMPORT_MESSAGES.PAUSE) {
    abortRunningWork();
    await writeState(Queue.pauseSession(state, now, "Paused by the user.", "", Queue.PAUSED_BY.USER));
    return statusResponse();
  }

  if (type === IMPORT_MESSAGES.RESUME) {
    await writeState(Queue.resumeSession(state, now));
    // Resuming always re-opens and re-activates the collector tab first, which is
    // also what makes it visible again after a hidden pause.
    await moveCollectionTo(Queue.COLLECTION_STATE.OPENING_PROFILE_COLLECTOR);
    await Tabs.ensureProfileTab(CONNECTIONS_URL);
    await moveCollectionTo(Queue.COLLECTION_STATE.EXTRACTING_PROFILE);
    await ensureHeartbeat();
    kickLoop();
    return statusResponse();
  }

  if (type === IMPORT_MESSAGES.STOP) {
    // Ends discovery and extraction that are already in flight, not just the
    // next iteration of them.
    abortRunningWork();
    await setDiscoveryRunning(false);
    await writeState(Queue.stopSession(await readState(), now));
    await moveCollectionTo(Queue.COLLECTION_STATE.STOPPED);
    await clearHeartbeat();
    await closeCollectorTabs();
    return statusResponse();
  }

  if (type === IMPORT_MESSAGES.SKIP) {
    const target = message?.url || state.session.currentUrl;
    if (target) await writeState(Queue.markSkipped(state, target, now));
    return statusResponse();
  }

  if (type === IMPORT_MESSAGES.RETRY_FAILED) {
    const retried = Queue.retryFailed(state, now);
    // Clear any narrowed selection so the requeued rows are actually claimable.
    await writeState({ items: retried.items, session: { ...retried.session, scopeUrls: [] } });
    if (retried.session.status === Queue.SESSION_STATUS.RUNNING) kickLoop();
    return statusResponse();
  }

  if (type === IMPORT_MESSAGES.CLEAR) {
    // Clear Queue stops the active process and wipes the discovered list, queue
    // state, counters, and session progress. Saved profiles live in a different
    // store and are deliberately left completely untouched.
    abortRunningWork();
    await setDiscoveryRunning(false);
    const stopped = Queue.stopSession(await readState(), now);
    const cleared = Queue.clearQueue(stopped, now);
    // Back to a clean idle machine so a later Start Full Collection is allowed.
    await writeState({
      items: cleared.items,
      session: {
        ...cleared.session,
        collectionState: Queue.COLLECTION_STATE.IDLE,
        collectionStateAt: now,
        resumeCollectionState: "",
        fruitlessDiscoveries: 0
      }
    });
    diagnostics.discovery = null;
    diagnostics.profile = null;
    await clearHeartbeat();
    await closeCollectorTabs();
    await Tabs.forgetAll().catch(() => undefined);
    return statusResponse();
  }

  if (type === IMPORT_MESSAGES.DIAGNOSTICS) {
    // Everything needed to tell a wrong scroll container from one-shot scanning,
    // an overwritten accumulator, an early stop, or missed pagination.
    return {
      ok: true,
      buildId: BUILD_ID,
      generatedAt: now,
      discovery: diagnostics.discovery,
      profile: diagnostics.profile,
      // The collector surface itself: window/tab ids, whether the tab is active,
      // and whether the window is minimized. A "nothing rendered" report is
      // meaningless without it.
      collector: await collectorDiagnostics(),
      collectionState: state.session.collectionState,
      collectionStateAt: state.session.collectionStateAt,
      collectionStateText: Queue.collectionStateText(state.session.collectionState),
      resumeCollectionState: state.session.resumeCollectionState || "",
      completionPolicy: TabsCore.COMPLETION_POLICY,
      transitions: transitionLog.slice(-40),
      // The arithmetic behind "LinkedIn says 67, we collected 66".
      reconciliation: reconcileState(state),
      summary: Queue.summarize(state)
    };
  }

  if (type === IMPORT_MESSAGES.COMPLETED_URLS) {
    return {
      ok: true,
      urls: state.items.filter((item: any) => item.status === Queue.ITEM_STATUS.COMPLETED).map((item: any) => item.url)
    };
  }

  return { ok: false, error: `Unknown import command: ${type}` };
}

// ------------------------------------------------------ the recruiter surface
// Collecting job applicants is a different shape of run from the connections
// import and deliberately does not share its queue: it happens in the tab the
// recruiter already has open, on a job they already have open, and it never
// navigates anywhere on its own. The worker's job here is small — resolve the
// tab, inject if needed, relay the command, persist what comes back, and stop
// everything when asked.

const RESUME_FOLDER = "profile-vault-resumes";
/** Hosts a resume may be fetched from. Anything else is refused outright. */
const RESUME_HOST_PATTERN = /^https:\/\/(?:[a-z0-9-]+\.)*(?:linkedin\.com|licdn\.com)\//i;
/**
 * A LinkedIn page is not a file.
 *
 * The live defect: the resume control's `href` on the hiring surface is a route,
 * so `linkedin.com/hiring/applicants/…` was handed to `chrome.downloads`, which
 * happily fetched the HTML page and saved it as somebody's CV — and the record
 * then reported `downloaded`. The host check alone passed it, because the host
 * genuinely is LinkedIn.
 */
const RESUME_PAGE_PATTERN =
  /^https:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/(?:hiring|talent|in|jobs|feed|company|school|mynetwork|messaging)\b/i;

/**
 * A LinkedIn media address that is not a document, refused here as well as in
 * the core's `isResumeDocumentUrl`.
 *
 * Defence in depth, for the same reason `RESUME_PAGE_PATTERN` exists next to it:
 * the host check alone passes `media.licdn.com`, so a portrait or an `og:image`
 * picked up by the page-side sweep would be written to disk under an applicant's
 * name and reported `downloaded`. The core refuses it first; this is what stops a
 * future caller — or a stored record written before that refusal existed — from
 * reaching `chrome.downloads` with one anyway.
 */
const RESUME_NON_DOCUMENT_PATTERN = new RegExp([
  "/dms/(?:image|video|audio)/",
  "profile-displayphoto",
  "profile-originalphoto",
  "company-logo",
  "\\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|mp4|webm|mov|mp3|wav|css|js)(?:$|[?#])"
].join("|"), "i");
const APPLICANT_EXTRACT_TIMEOUT_MS = 180000;
/** A whole-job run is bounded only by the list; the reply is not awaited. */
const APPLICANT_RUN_TIMEOUT_MS = 3600000;

/** The newest applicant diagnostics, for the downloadable report. */
let applicantDiagnostics: any = null;

const HIRING_URL_PATTERN = /^https:\/\/(?:www\.)?linkedin\.com\/(?:hiring|talent)\//i;
/** The last hiring page actually seen, so a later command can return to it. */
const LAST_HIRING_URL_KEY = "profileVaultLastHiringUrl";

/**
 * Remember where the recruiter's applicants live.
 *
 * Only ever a page this extension has genuinely been on — the address of a
 * resolved hiring tab, or the `sourceUrl` of a record that was actually
 * collected. Nothing is constructed: a job id welded into a guessed path would
 * be the same class of mistake as guessing a resume link.
 */
async function rememberHiringUrl(url: unknown): Promise<void> {
  const value = String(url || "").trim();
  if (!HIRING_URL_PATTERN.test(value)) return;
  await chrome.storage.local.set({ [LAST_HIRING_URL_KEY]: value }).catch(() => undefined);
}

async function lastHiringUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(LAST_HIRING_URL_KEY);
    const value = String(stored?.[LAST_HIRING_URL_KEY] || "").trim();
    return HIRING_URL_PATTERN.test(value) ? value : "";
  } catch {
    return "";
  }
}

// ------------------------------------------------------- coming back to a job
// The applicants page is a page the recruiter leaves and returns to constantly —
// to the extension's own table, to the job's settings, to another job — and a
// content script does not survive that. Every navigation destroys `state`, its
// run, and everything it knew about what it had been asked to do. So returning
// to a job left the surface idle until the recruiter went and pressed the button
// again, which is the report.
//
// The worker is the only thing that outlives the navigation, so it is what
// remembers. **Only a job the recruiter themselves started a run on** is
// remembered, with the options they started it with, so the restart is a
// continuation of their own instruction rather than the extension deciding on
// its own to start clicking — which is the line the whole project is built on.

/** Jobs a run was started on, and the options it was started with. */
const AUTO_RUN_KEY = "profileVaultApplicantAutoRun";
/** Long enough to survive a lunch break, short enough not to be a surprise. */
const AUTO_RUN_TTL_MS = 12 * 60 * 60 * 1000;

function createApplicantRunId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readAutoRuns(): Promise<Record<string, any>> {
  try {
    const stored = await chrome.storage.local.get(AUTO_RUN_KEY);
    const value = stored?.[AUTO_RUN_KEY];
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/**
 * Remember that this job was collected on purpose.
 *
 * Keyed by job id, because an applicant is a person *on a job* and so is a run.
 * A job with no id is not remembered at all rather than remembered under a
 * blank key that would arm every other job with one.
 */
async function armAutoRun(jobId: string, options: any, tabId = 0): Promise<any> {
  const key = String(jobId || "").trim();
  if (!key) return null;
  const runs = await readAutoRuns();
  const now = nowIso();
  const runId = createApplicantRunId();
  runs[key] = Applicants.createAutoRunEntry({ options, now, runId, tabId });
  await chrome.storage.local.set({ [AUTO_RUN_KEY]: runs }).catch(() => undefined);
  return runs[key];
}

/**
 * What the applicants page should do on arriving at this job.
 *
 * An entry older than the TTL is treated as absent and swept, so a job
 * collected last week does not restart itself because the recruiter happened to
 * open it.
 */
async function autoRunFor(jobId: string, tabId = 0): Promise<any> {
  const key = String(jobId || "").trim();
  if (!key) return { ok: true, armed: false, reason: "no-job-id" };
  const runs = await readAutoRuns();
  const entry = runs[key];
  if (!entry) return { ok: true, armed: false, reason: "not-collected-before" };

  const armedAt = Date.parse(entry.armedAt || "");
  if (Number.isFinite(armedAt) && Date.now() - armedAt > AUTO_RUN_TTL_MS) {
    delete runs[key];
    await chrome.storage.local.set({ [AUTO_RUN_KEY]: runs }).catch(() => undefined);
    return { ok: true, armed: false, reason: "expired" };
  }
  // Entries written before lifecycle tracking had only options + armedAt.
  // Upgrade one in memory before claiming it so its first resumed execution can
  // report completion and stop the old twelve-hour restart behaviour.
  let candidate = entry.runId
    ? entry
    : Applicants.createAutoRunEntry({
        options: entry.options || {},
        now: entry.armedAt || nowIso(),
        runId: createApplicantRunId(),
        tabId
      });
  // A browser restart or a closed/navigated owner tab leaves a persisted
  // `running` lease with nobody capable of finishing it. Only then may another
  // tab claim it; a live owner on the same job is still protected from a second
  // driver.
  if (
    candidate.state === Applicants.AUTO_RUN_STATE.RUNNING
    && Number(candidate.tabId)
    && Number(candidate.tabId) !== Number(tabId)
  ) {
    const ownerAlive = await chrome.tabs.get(Number(candidate.tabId)).then((owner: any) => {
      const ownerUrl = String(owner?.url || "");
      return HIRING_URL_PATTERN.test(ownerUrl)
        && Applicants.parseHiringContext(ownerUrl).jobId === key;
    }).catch(() => false);
    if (!ownerAlive) candidate = { ...candidate, state: Applicants.AUTO_RUN_STATE.INTERRUPTED };
  }
  const claimed = Applicants.claimAutoRun(candidate, { now: nowIso(), tabId });
  if (!claimed.armed) return { ok: true, armed: false, reason: claimed.reason || "not-restartable" };
  runs[key] = claimed.entry;
  await chrome.storage.local.set({ [AUTO_RUN_KEY]: runs }).catch(() => undefined);
  return {
    ok: true,
    armed: true,
    options: claimed.entry.options || {},
    armedAt: claimed.entry.armedAt || "",
    tracking: claimed.tracking
  };
}

/**
 * Persist only the newest execution's terminal state.
 *
 * A replaced content-script closure can unwind after its successor has already
 * started. The attempt token prevents that stale report from changing a live or
 * completed successor back to interrupted.
 */
async function settleAutoRunFor(jobId: string, report: any): Promise<any> {
  const key = String(jobId || "").trim();
  if (!key) return { ok: true, changed: false, reason: "no-job-id" };
  const runs = await readAutoRuns();
  const settled = Applicants.settleAutoRun(runs[key], { ...report, now: nowIso() });
  if (!settled.changed) return { ok: true, changed: false, reason: settled.reason };
  runs[key] = settled.entry;
  await chrome.storage.local.set({ [AUTO_RUN_KEY]: runs }).catch(() => undefined);
  return { ok: true, changed: true, state: settled.entry.state };
}

/**
 * Forget every armed job.
 *
 * Called by the universal Stop, and this is not incidental: a Stop that could be
 * undone by navigating away and back is not a Stop. Rule 13a says Stop ends
 * everything, so it ends the standing instruction too.
 */
async function disarmAutoRuns(): Promise<void> {
  await chrome.storage.local.remove(AUTO_RUN_KEY).catch(() => undefined);
}

/**
 * The tab the recruiter has their applicants open in.
 *
 * The active tab first, because a command from the popup means "this page";
 * then any hiring tab, so a command from the applicants page still finds it.
 *
 * If there is none, the last hiring page this extension was actually on is
 * **re-opened**, in the window the command came from. That is a change from
 * 3.7.0–3.7.4, which raised an error and left the recruiter to find the page
 * themselves: they press a button on the extension's own page and expect to be
 * taken to the work, not told to go and set it up. Only a remembered address is
 * used — never a guessed one — so the very first run still needs the page to
 * have been opened once.
 */
async function resolveApplicantTab(): Promise<any> {
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const current = (active || []).find((tab: any) => HIRING_URL_PATTERN.test(String(tab?.url || "")));
  if (current?.id) {
    await Tabs.rememberApplicantTab(current.id).catch(() => null);
    await rememberHiringUrl(current.url);
    return current;
  }

  const all = await chrome.tabs.query({
    url: [
      "https://www.linkedin.com/hiring/*",
      "https://linkedin.com/hiring/*",
      "https://www.linkedin.com/talent/*",
      "https://linkedin.com/talent/*"
    ]
  }).catch(() => []);
  const found = (all || []).find((tab: any) => tab?.id);
  if (found?.id) {
    await Tabs.rememberApplicantTab(found.id).catch(() => null);
    await rememberHiringUrl(found.url);
    return found;
  }

  const remembered = await lastHiringUrl();
  if (!remembered) {
    throw new Error(
      "Open your job's Applicants page in LinkedIn once, and after that this button will take you straight back to it."
    );
  }
  // Rule 12: the controller owns every tab that is created or activated.
  const { tabId, created } = await Tabs.ensureApplicantTab(remembered);
  if (created) await waitForTabComplete(tabId, remembered);
  return await chrome.tabs.get(tabId);
}

/**
 * Make the hiring tab the one Chrome is actually painting.
 *
 * Rule 12a on this surface. Both applicant commands are usually pressed from
 * the extension's own Applicants page, which is a *different tab* — so the
 * hiring tab is hidden the instant the button is clicked, LinkedIn stops
 * rendering it, and the content script correctly refuses to read a page it
 * cannot see. From the recruiter's side that is a button that does nothing.
 *
 * Activation goes through the collector-tab controller, because rule 12 gives
 * it every tab decision; the worker never touches `chrome.tabs` itself.
 *
 * The window is **focused** as well as the tab activated. Activating a tab in a
 * window the recruiter is not looking at changes nothing they can see, so from
 * their side the button did nothing — and they still have to go and find the
 * page by hand, which is what this exists to stop. This is a direct command,
 * not the heartbeat-driven import run, which still never takes focus.
 */
async function revealApplicantTab(tab: any): Promise<void> {
  if (!tab?.id) return;
  await Tabs.activate(tab.id, { focusWindow: true }).catch(() => false);
}

// ------------------------------------------------- one file, one person, one name
// The saved resume is named after the applicant, because a folder of
// `AQHb3kJ2...` media ids is a folder nobody can use. Two people really can be
// called the same thing, so the second one gets ` (2)` — and the *same* person
// collected twice must keep their own file rather than growing a suffix on
// every visit, which is why the register is keyed by applicant and not by name.

/** Which applicants have claimed which filename stems, in the order they claimed them. */
const RESUME_NAMES_KEY = "profileVaultResumeNames";

async function readResumeNames(): Promise<Record<string, string[]>> {
  try {
    const stored = await chrome.storage.local.get(RESUME_NAMES_KEY);
    const value = stored?.[RESUME_NAMES_KEY];
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/**
 * This applicant's position in the queue of people sharing their name.
 *
 * 0 for the first, 1 for the second — `resumeFileName()` turns that into the
 * ` (2)` suffix. **Stable per applicant**: asked twice for the same person it
 * returns the same number, so a re-collection overwrites their own file instead
 * of littering the folder with copies. An applicant with no key is not
 * registered at all and is left to Chrome's `uniquify`, because an unkeyed
 * record cannot be told apart from the next one.
 */
async function claimResumeName(stem: string, applicantKey: string): Promise<number> {
  const nameKey = String(stem || "").trim().toLowerCase();
  const owner = String(applicantKey || "").trim().toLowerCase();
  if (!nameKey || !owner) return 0;
  const names = await readResumeNames();
  const owners = Array.isArray(names[nameKey]) ? names[nameKey] : [];
  const existing = owners.indexOf(owner);
  if (existing >= 0) return existing;
  owners.push(owner);
  names[nameKey] = owners;
  await chrome.storage.local.set({ [RESUME_NAMES_KEY]: names }).catch(() => undefined);
  return owners.length - 1;
}

/**
 * Where Chrome actually put the file.
 *
 * `chrome.downloads.download()` resolves with an id, not a path, and the path it
 * finally uses is **not** the one that was asked for whenever `uniquify` had to
 * step in or the platform rewrote something. `resume_file` is meant to be the
 * file on disk, so it is read back rather than assumed. Bounded and best-effort:
 * a download that has not been given a filename yet within the budget falls back
 * to the requested one, which is still the truth in the overwhelming majority.
 */
const PATH_POLLS = 10;

async function downloadedFilePath(downloadId: number, requested: string): Promise<any> {
  let interval = 25;
  for (let attempt = 0; attempt < PATH_POLLS; attempt += 1) {
    try {
      const [item] = (await chrome.downloads.search({ id: downloadId })) || [];
      // Interrupted is checked FIRST and reported as what it is. Through 3.7.6
      // this returned the requested path and the caller still answered
      // `downloaded`, so a download Chrome refused — an expired signed media
      // address, a 403, an HTML error body — was written onto the record as a
      // saved file, `resume_file` named a path that was not on disk, and
      // `mergeApplicantRecord`'s `keepDownload` then protected that wrong answer
      // from ever being corrected by a later collection.
      if (item && item.state === "interrupted") {
        return { path: "", interrupted: true, reason: String(item.error || "interrupted") };
      }
      if (item?.filename) return { path: String(item.filename), interrupted: false, reason: "" };
    } catch {
      return { path: requested, interrupted: false, reason: "" };
    }
    // Escalating, and never after the last look. Chrome usually has the filename
    // within a frame or two of accepting the download, and a flat 120 ms floor
    // meant the common case waited ~5x longer than it needed to — awaited by the
    // content script, so it was spent once per applicant, in front of the next
    // one. The ceiling is unchanged in spirit: the same ~1.2 s budget, spent
    // where the answer actually is rather than evenly.
    if (attempt < PATH_POLLS - 1) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(200, Math.round(interval * 1.6));
    }
  }
  // Still in flight when the budget ran out. It was accepted and is downloading,
  // so the requested path is the truth in the overwhelming majority.
  return { path: requested, interrupted: false, reason: "" };
}

/**
 * Save the applicant's resume, named after the applicant.
 *
 * The recruiter's own browser session fetches it, exactly as it would if they
 * clicked the link themselves. Three refusals before anything is downloaded: a
 * URL that is not on LinkedIn's own hosts, a URL already saved by an earlier
 * run, and a URL the page never offered in the first place — this is only ever
 * reached with a link the applicant panel rendered.
 *
 * The name, the sanitizing and the ` (2)` are all `Applicants.resumeFileName()`,
 * which is pure and tested. This function owns `chrome.downloads` and nothing
 * else; it does not own the policy.
 */
async function downloadResume(message: any): Promise<any> {
  const url = String(message?.url || "").trim();
  if (!url) return { ok: false, status: "failed", reason: "no-url" };
  if (!RESUME_HOST_PATTERN.test(url)) {
    return { ok: false, status: "failed", reason: "refused-non-linkedin-host" };
  }
  // The bytes the page fetched for itself, offered only after a direct download
  // came back interrupted. Every refusal above and below still applies to `url`,
  // which is the address that was checked — the data is what was found AT it,
  // never a substitute for checking it.
  const dataUrl = String(message?.dataUrl || "");
  if (dataUrl && !/^data:/i.test(dataUrl)) {
    return { ok: false, status: "failed", reason: "refused-not-page-data" };
  }
  // A page route is refused as firmly as a foreign host. Saving one produces a
  // file that opens as the applicants page, under a name that says it is a CV.
  if (RESUME_PAGE_PATTERN.test(url)) {
    return { ok: false, status: "link_only", reason: "refused-page-not-a-document" };
  }
  // A picture is refused as firmly as a page: saving one produces a JPEG under a
  // person's name, reported as their CV.
  if (RESUME_NON_DOCUMENT_PATTERN.test(url)) {
    return { ok: false, status: "link_only", reason: "refused-media-not-a-document" };
  }
  if (await resumeAlreadyDownloaded(url).catch(() => false)) {
    return { ok: true, status: "already_saved", reason: "already-downloaded" };
  }

  // The person, not LinkedIn's media id. The stem is claimed first so the index
  // is decided before the extension is welded on — two people called John Smith
  // whose resumes are a .pdf and a .docx are still John Smith and John Smith (2).
  const applicantKey = String(message?.applicantKey || "").trim();
  const stem = Applicants.sanitizeFileName(message?.applicantName)
    || Applicants.sanitizeFileName(String(message?.filename || "").replace(/\.[a-z0-9]{1,8}$/i, ""));
  const index = stem ? await claimResumeName(stem, applicantKey) : 0;
  const named = Applicants.resumeFileName({
    name: message?.applicantName,
    fileType: message?.fileType,
    filename: message?.filename,
    url,
    index,
    fallback: applicantKey || "resume"
  });
  const requested = `${RESUME_FOLDER}/${named}`;

  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl || url,
      filename: requested,
      // Never a save dialog per applicant: a run over 600 applicants must not
      // ask 600 questions. `uniquify` is the on-disk backstop for a file this
      // browser profile already has from a previous session — the register
      // above is what stops two *different* people colliding in the first place.
      saveAs: false,
      conflictAction: "uniquify"
    });
    // `localReference` is where the file actually is, not Chrome's download id:
    // an integer told the recruiter nothing about which file on disk is whose.
    // Read back rather than assumed, because `uniquify` may have renamed it.
    const actual = await downloadedFilePath(downloadId, requested);
    if (actual.interrupted) {
      // Say so, and — unless this WAS the second attempt — ask the page to fetch
      // it with its own credentials and hand back the bytes. A file that did not
      // land must never be recorded as one that did.
      return {
        ok: false,
        status: "failed",
        reason: `download-interrupted:${actual.reason}`,
        retryFromPage: !dataUrl
      };
    }
    return {
      ok: true,
      status: "downloaded",
      filename: actual.path.split(/[\\/]/).pop() || named,
      localReference: actual.path,
      downloadId: String(downloadId),
      reason: dataUrl ? "downloaded-from-page" : "downloaded"
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      retryFromPage: !dataUrl
    };
  }
}

/** Long enough for a signed media URL to commit; short enough not to stall a run. */
const RESUME_TAB_TIMEOUT_MS = 6000;

/**
 * Read the document this tab is showing, as bytes.
 *
 * Injected into the resume tab and run there, so the request carries that tab's
 * own origin, cookies and referrer — the three things a worker-initiated fetch
 * cannot reproduce, and the usual reason a signed media address refuses one.
 * Returns "" rather than throwing, because a failure here is a fallback that
 * did not help, not an error the run should care about.
 */
async function readOpenDocumentAsDataUrl(): Promise<string> {
  try {
    const response = await fetch(location.href, { credentials: "include" });
    if (!response.ok) return "";
    const blob = await response.blob();
    if (!blob.size || blob.size > 25 * 1024 * 1024) return "";
    if (/^text\/html|^application\/xhtml/i.test(blob.type)) return "";
    // A descriptor is refused as firmly as a page. LinkedIn's document addresses
    // answer with JSON naming the asset and its `transcribedDocumentUrl`, and
    // that blob was landing on disk as somebody's CV — a `/dms/` path on a
    // LinkedIn host passes every address-shaped refusal there is, so the only
    // thing that catches it is what the address actually answers with.
    if (/^application\/json|^text\/json|\+json/i.test(blob.type)) return "";
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  } catch {
    return "";
  }
}

/**
 * Open the resume, save it, close it, and put the recruiter back where they were.
 *
 * **The whole cycle is driven from here, and never from the page.** The content
 * script used to press the resume control and hope; when that control was an
 * `<a target="_blank">` LinkedIn opened a real tab, the
 * applicants tab went hidden, `assertRunnable()` threw `hiddenPageError`, and
 * `extractAllApplicants` broke out of its row loop — so the run was not merely
 * stuck, it was dead, and it stayed dead after the recruiter closed the tab by
 * hand. Nothing observed tab creation at all: repo-wide there was no
 * `chrome.tabs.onCreated`, no `openerTabId`, no `window.open` shim.
 *
 * Now the tab is one this extension created and therefore knows the id of. It is
 * opened **inactive**, so nothing is taken away from the recruiter while it
 * loads; the load is what makes the session and referrer right for the download;
 * the file is saved under the applicant's own name; and the tab is closed and
 * the hiring tab re-activated on every path, including the failure ones. The
 * content script waits for one reply and never sees a hidden page.
 */
async function openAndSaveResume(message: any, sender: any): Promise<any> {
  const url = String(message?.url || "").trim();
  if (!url) return { ok: false, status: "failed", reason: "no-url" };
  if (!RESUME_HOST_PATTERN.test(url)) return { ok: false, status: "failed", reason: "refused-non-linkedin-host" };

  const returnTo = Number(sender?.tab?.id) || 0;
  let tabId = 0;
  try {
    // Through the one controller that is allowed to create a tab (rule 12), and
    // inactive, because the point is that this is autonomous rather than visible.
    tabId = Number(await Tabs.openDocumentTab(url)) || 0;
    if (!tabId) return { ok: false, status: "failed", reason: "resume-tab-refused" };
    await waitForTabComplete(tabId, "", RESUME_TAB_TIMEOUT_MS).catch(() => undefined);

    // Saved from the opened document. The direct download is tried first because
    // it costs no memory; the in-tab read is the fallback for an address the
    // browser will only serve to the page that asked for it.
    let result = await downloadResume({ ...message, url });
    if (result?.retryFromPage) {
      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        func: readOpenDocumentAsDataUrl
      }).catch(() => []);
      const dataUrl = String(injected?.[0]?.result || "");
      if (dataUrl) result = await downloadResume({ ...message, url, dataUrl });
    }
    return { ...result, openedTab: true };
  } catch (error) {
    return { ok: false, status: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    // Closed and handed back on EVERY path — a resume tab the recruiter has to
    // close themselves is the whole complaint this function answers.
    if (tabId) await Tabs.closeDocumentTab(tabId).catch(() => undefined);
    if (returnTo) await Tabs.activate(returnTo, { focusWindow: true }).catch(() => undefined);
  }
}

/** Tell every LinkedIn tab to stop whatever it is doing, right now. */
async function stopAllContentScripts(): Promise<number> {
  const tabs = await chrome.tabs.query({
    url: ["https://www.linkedin.com/*", "https://linkedin.com/*"]
  }).catch(() => []);
  let reached = 0;
  for (const tab of tabs || []) {
    if (!tab?.id) continue;
    try {
      await sendTabMessage(tab.id, { type: STOP_ALL }, PING_TIMEOUT_MS);
      reached += 1;
    } catch {
      // A tab with no listener is a tab with nothing to stop.
    }
  }
  return reached;
}

/**
 * The universal Stop.
 *
 * Everything, in one command: the in-flight discovery or extraction (via the
 * generation token, not merely by flipping a status), the queue session, the
 * heartbeat, the collector tabs, and every content script that might be
 * mid-scan. Saved profiles and saved applicants are never touched — Stop ends
 * work, it does not discard what that work already produced.
 */
async function stopEverything(): Promise<any> {
  abortRunningWork();
  const now = nowIso();
  // Before anything else that can fail: the standing instruction to restart an
  // applicant run on return. A Stop that a navigation could undo is not a Stop.
  await disarmAutoRuns();
  const reached = await stopAllContentScripts();
  await setDiscoveryRunning(false).catch(() => undefined);
  try {
    await writeState(Queue.stopSession(await readState(), now));
    await moveCollectionTo(Queue.COLLECTION_STATE.STOPPED);
  } catch {
    // An empty queue has no session to stop, which is not a failure.
  }
  await clearHeartbeat().catch(() => undefined);
  await closeCollectorTabs().catch(() => undefined);
  return { ok: true, stopped: true, contentScriptsReached: reached, stoppedAt: now };
}

async function handleApplicantCommand(type: string, message: any, sender?: any): Promise<any> {
  if (type === APPLICANT_MESSAGES.DOWNLOAD_RESUME) return downloadResume(message);
  if (type === APPLICANT_MESSAGES.OPEN_AND_SAVE_RESUME) return openAndSaveResume(message, sender);

  if (type === APPLICANT_MESSAGES.SAVE) {
    // Streamed mid-run. Merged, so the same applicant arriving twice enriches
    // the stored record instead of duplicating or truncating it.
    const saved = await saveApplicant(message?.record || {});
    // The surest address there is: a page an applicant was actually read from.
    await rememberHiringUrl(saved?.extraction?.sourceUrl);
    return { ok: true, id: saved.id };
  }

  if (type === APPLICANT_MESSAGES.LIST) {
    const applicants = await getAllApplicants();
    return { ok: true, applicants, total: applicants.length };
  }

  if (type === APPLICANT_MESSAGES.COLLECTED) {
    // What a run needs to know before it opens anybody: who is already saved.
    // Three fields per record rather than the whole record, because a job with
    // 600 collected applicants would otherwise put megabytes through the
    // message channel to answer one question per row.
    //
    // **Every stored record, and the verdict beside it — never only the
    // collected ones.** The index applies the verdict; the worker only reports
    // it. Filtering here would make the payload answer exactly one question and
    // leave the page unable to tell "I have a thin record for this person" from
    // "I have never seen them" — and the difference between those two decides
    // whether a run that failed on somebody can ever reach them again. The extra
    // entries cost three small fields each: a job with 665 applicants is tens of
    // kilobytes, the same order as the answer it already sent.
    const applicants = await getAllApplicants();
    const wanted = String(message?.jobId || "").trim();
    return {
      ok: true,
      entries: applicants
        .filter((record: any) => !wanted || !record.job?.id || String(record.job.id) === wanted)
        .map((record: any) => ({
          applicationId: record.applicationId ?? null,
          jobId: record.job?.id ?? null,
          name: record.applicant?.name ?? "",
          // The one judgement, made by the core so there is one copy of it.
          collected: Applicants.isCollectedApplicant(record)
        }))
    };
  }

  if (type === APPLICANT_MESSAGES.AUTO_RUN) {
    // Asked by the applicants page as it arrives on a job. It never *starts*
    // anything from here — it answers whether the recruiter already asked for
    // this job, and with what.
    return autoRunFor(String(message?.jobId || ""), Number(sender?.tab?.id) || 0);
  }

  if (type === APPLICANT_MESSAGES.RUN_LIFECYCLE) {
    return settleAutoRunFor(String(message?.jobId || ""), message?.tracking || {});
  }

  if (type === APPLICANT_MESSAGES.CLEAR) {
    await clearApplicants();
    applicantDiagnostics = null;
    // The stored applicants are what a restarted run walks past. With them gone
    // there is nothing to come back to, so the standing instruction goes too.
    await disarmAutoRuns();
    // And the register of who claimed which filename: it exists to keep two
    // different people apart, and with no records left there is nobody to keep
    // apart. Leaving it would make the next John Smith "John Smith (2)" with no
    // John Smith anywhere.
    await chrome.storage.local.remove(RESUME_NAMES_KEY).catch(() => undefined);
    return { ok: true, cleared: true };
  }

  if (type === APPLICANT_MESSAGES.DIAGNOSTICS) {
    return { ok: true, buildId: BUILD_ID, generatedAt: nowIso(), applicant: applicantDiagnostics };
  }

  if (type === APPLICANT_MESSAGES.STATUS) {
    const applicants = await getAllApplicants();
    let page: any = null;
    try {
      const tab = await resolveApplicantTab();
      page = await sendTabMessage(tab.id, { type: APPLICANT_MESSAGES.CHECK_PAGE }, PING_TIMEOUT_MS);
    } catch {
      page = null;
    }
    return { ok: true, buildId: BUILD_ID, stored: applicants.length, page };
  }

  if (type === APPLICANT_MESSAGES.STOP) {
    // A Stop that a navigation could undo is not a Stop.
    await disarmAutoRuns();
    const tab = await resolveApplicantTab().catch(() => null);
    if (tab?.id) await sendTabMessage(tab.id, { type: APPLICANT_MESSAGES.STOP }, PING_TIMEOUT_MS).catch(() => undefined);
    return { ok: true, stopped: true };
  }

  if (type === APPLICANT_MESSAGES.COLLECT_CURRENT) {
    // Anchor "the same window" to the window the button was actually pressed in
    // before any tab is opened, exactly as the import workflow's step 1 does.
    await rememberOrigin(sender);
    const tab = await resolveApplicantTab();
    await revealApplicantTab(tab);
    await ensureContentScript(tab.id, APPLICANT_SCRIPTS, APPLICANT_MESSAGES.PING);
    const response = await sendTabMessage(
      tab.id,
      { type: APPLICANT_MESSAGES.EXTRACT, options: message?.options || {} },
      APPLICANT_EXTRACT_TIMEOUT_MS
    );
    if (!response?.ok) throw new Error(response?.error || "The applicant could not be collected.");
    applicantDiagnostics = response.diagnostics || applicantDiagnostics;
    // The record was already persisted by the streamed save; this reply is what
    // the popup shows, not what makes it durable.
    return { ok: true, record: response.record, diagnostics: response.diagnostics };
  }

  if (type === APPLICANT_MESSAGES.COLLECT_ALL) {
    await rememberOrigin(sender);
    const tab = await resolveApplicantTab();
    await revealApplicantTab(tab);
    await ensureContentScript(tab.id, APPLICANT_SCRIPTS, APPLICANT_MESSAGES.PING);
    // Do not replace the lifecycle token underneath a run already executing in
    // this document. Its eventual completion report carries the current token;
    // arming a new one first would make that report stale and leave the job
    // falsely restartable after it had actually finished.
    const live = await sendTabMessage(tab.id, { type: APPLICANT_MESSAGES.STATUS }, PING_TIMEOUT_MS);
    if (live?.run?.state === Applicants.RUN_STATE.RUNNING) {
      return { ok: true, started: true, alreadyRunning: true };
    }
    // The recruiter asked for this job's whole list. Remembered, with the
    // options they asked with, so returning to the page restarts the same run
    // instead of leaving the surface idle. This is the only thing that arms it:
    // a single-applicant collection never does.
    const jobId = Applicants.parseHiringContext(String(tab?.url || "")).jobId || "";
    const armed = await armAutoRun(jobId, message?.options || {}, Number(tab.id) || 0);
    // Detached, exactly like Start Full Collection: a whole job's applicants can
    // take an hour and the popup is allowed to close the moment it is clicked.
    sendTabMessage(
      tab.id,
      {
        type: APPLICANT_MESSAGES.EXTRACT_ALL,
        options: message?.options || {},
        tracking: armed ? { runId: armed.runId, attempt: armed.attempt } : null
      },
      APPLICANT_RUN_TIMEOUT_MS
    ).catch(() => undefined);
    return { ok: true, started: true };
  }

  return { ok: false, error: `Unknown applicant command: ${type}` };
}

// ------------------------------------------------------------------- lifecycle

/**
 * Runs on every service-worker start, including after suspension and browser
 * restart. Normal interrupted processing continues automatically (D2); a session
 * paused by a challenge, restriction, or the user stays paused for a human.
 */
async function recoverOnStart(): Promise<void> {
  try {
    const state = await readState();
    const recovered = Queue.recoverAfterInterruption(state, nowIso());
    await writeState({ items: recovered.items, session: recovered.session });
    if (recovered.resumed) {
      await ensureHeartbeat();
      kickLoop();
    }
  } catch {
    // A missing database simply means there is nothing to recover.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ profileVaultVersion: chrome.runtime.getManifest().version, profileVaultBuildId: BUILD_ID });
  recoverOnStart();
});

chrome.runtime.onStartup.addListener(() => {
  recoverOnStart();
});

recoverOnStart();

chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (response: any) => void) => {
  if (message?.type === IMPORT_MESSAGES.GET_BUILD_INFO) {
    sendResponse({ ok: true, buildId: BUILD_ID, version: chrome.runtime.getManifest().version });
    return true;
  }

  if (message?.type === IMPORT_MESSAGES.DISCOVERY_PROGRESS) {
    // Fire-and-forget from the connections page: persist without making the
    // content script wait, so streaming never slows the pass down.
    queueDiscoveryProgress(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === STOP_ALL) {
    // The universal Stop. Handled before every other branch so it is never
    // queued behind the work it is trying to end.
    stopEverything()
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (typeof message?.type === "string" && message.type.startsWith("PV_APPLICANT_")) {
    // `_sender` is the only place the window the button was pressed in is
    // available, and it is what "open it in the same window" is anchored to.
    handleApplicantCommand(message.type, message, _sender)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (typeof message?.type === "string" && message.type.startsWith("PV_IMPORT_")) {
    // `_sender` carries the window and tab the command came from — step 1 of the
    // workflow depends on it, and it is only available here.
    handleCommand(message.type, message, _sender)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  return false;
});
