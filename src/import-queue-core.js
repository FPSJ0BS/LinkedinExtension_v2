// Pure state machine for the LinkedIn connections import queue.
// Every function is side-effect free and takes an explicit `now` so tests stay
// deterministic. Persistence lives in queue-db.js; orchestration in background.ts.

export const ITEM_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped"
});

export const SESSION_STATUS = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped"
});

/**
 * Why a session is paused. Only COOLDOWN and INTERRUPTION may ever resume on their
 * own (decision D2/D3); CHALLENGE, USER, and NAVIGATION always wait for a human.
 */
export const PAUSED_BY = Object.freeze({
  NONE: "",
  USER: "user",
  CHALLENGE: "challenge",
  COOLDOWN: "cooldown",
  NAVIGATION: "navigation",
  /** The collector page is hidden, so LinkedIn is not rendering it. */
  VISIBILITY: "visibility",
  ERROR: "error"
});

/**
 * The explicit collection state machine.
 *
 * Loose booleans (`discoveryRunning`, `autoDiscover`, `discoveryExhausted`) let a
 * service-worker wake-up start a second discovery while the first was still
 * walking, and left no state that meant "discovery finished, extraction may
 * begin" — which is why extraction only ever started after a manual Stop/Start.
 */
export const COLLECTION_STATE = Object.freeze({
  IDLE: "idle",
  /** Steps 1-3: remember the home tab, open/reuse the Connections tab, activate it. */
  OPENING_CONNECTIONS: "opening_connections",
  /** Steps 4-5: walk the list until stable-bottom and reconciliation are satisfied. */
  DISCOVERING_CONNECTIONS: "discovering_connections",
  /** The list is enumerated and reconciled. Extraction follows automatically. */
  CONNECTIONS_COMPLETE: "connections_complete",
  /** Steps 6-7: create/reuse the single profile collector tab and activate it. */
  OPENING_PROFILE_COLLECTOR: "opening_profile_collector",
  /** Step 9: reading one profile, top to stable bottom, in the collector tab. */
  EXTRACTING_PROFILE: "extracting_profile",
  /** The scan settled; the record is being written to IndexedDB. */
  SAVING_PROFILE: "saving_profile",
  /** Step 8: the same tab is being navigated to the next queued profile. */
  MOVING_TO_NEXT_PROFILE: "moving_to_next_profile",
  /** Step 11: the collector tab is not being painted, so nothing may be saved. */
  PAUSED_HIDDEN: "paused_hidden",
  PAUSED_CHALLENGE: "paused_challenge",
  STOPPED: "stopped",
  COMPLETED: "completed",
  COMPLETED_WITH_GAP: "completed_with_gap",
  FAILED: "failed"
});

const TERMINAL_COLLECTION_STATES = Object.freeze([
  COLLECTION_STATE.STOPPED,
  COLLECTION_STATE.COMPLETED,
  COLLECTION_STATE.COMPLETED_WITH_GAP,
  COLLECTION_STATE.FAILED
]);

const ABORT_STATES = [
  COLLECTION_STATE.PAUSED_HIDDEN,
  COLLECTION_STATE.PAUSED_CHALLENGE,
  COLLECTION_STATE.STOPPED,
  COLLECTION_STATE.FAILED
];

const FINISH_STATES = [COLLECTION_STATE.COMPLETED, COLLECTION_STATE.COMPLETED_WITH_GAP];

/** The three states a profile cycles through, over and over, in one tab. */
const EXTRACTION_CYCLE = [
  COLLECTION_STATE.EXTRACTING_PROFILE,
  COLLECTION_STATE.SAVING_PROFILE,
  COLLECTION_STATE.MOVING_TO_NEXT_PROFILE
];

/**
 * Which moves are legal. Everything else is refused, which is what makes a
 * repeated wake-up idempotent instead of a second worker.
 *
 * The path a full run takes is a single line with no manual step in it:
 *
 *   idle -> opening_connections -> discovering_connections -> connections_complete
 *        -> opening_profile_collector -> extracting_profile -> saving_profile
 *        -> moving_to_next_profile -> extracting_profile -> ... -> completed
 *
 * `connections_complete -> opening_profile_collector` is the transition that used
 * to require a manual Stop followed by Start Extraction. It is now taken by the
 * worker itself, and a test asserts there is no path from discovery to extraction
 * that passes through `stopped` or `idle`.
 */
export const COLLECTION_TRANSITIONS = Object.freeze({
  [COLLECTION_STATE.IDLE]: [
    COLLECTION_STATE.OPENING_CONNECTIONS, COLLECTION_STATE.DISCOVERING_CONNECTIONS,
    COLLECTION_STATE.CONNECTIONS_COMPLETE, COLLECTION_STATE.OPENING_PROFILE_COLLECTOR,
    COLLECTION_STATE.EXTRACTING_PROFILE, ...ABORT_STATES, ...FINISH_STATES
  ],
  [COLLECTION_STATE.OPENING_CONNECTIONS]: [COLLECTION_STATE.DISCOVERING_CONNECTIONS, ...ABORT_STATES],
  [COLLECTION_STATE.DISCOVERING_CONNECTIONS]: [
    COLLECTION_STATE.CONNECTIONS_COMPLETE, ...ABORT_STATES, ...FINISH_STATES
  ],
  // Automatic hand-over: discovery finishing opens the profile collector itself.
  [COLLECTION_STATE.CONNECTIONS_COMPLETE]: [
    COLLECTION_STATE.OPENING_PROFILE_COLLECTOR, COLLECTION_STATE.IDLE, ...ABORT_STATES, ...FINISH_STATES
  ],
  [COLLECTION_STATE.OPENING_PROFILE_COLLECTOR]: [
    COLLECTION_STATE.EXTRACTING_PROFILE, ...ABORT_STATES, ...FINISH_STATES
  ],
  [COLLECTION_STATE.EXTRACTING_PROFILE]: [
    COLLECTION_STATE.SAVING_PROFILE, COLLECTION_STATE.MOVING_TO_NEXT_PROFILE,
    COLLECTION_STATE.OPENING_PROFILE_COLLECTOR, ...ABORT_STATES, ...FINISH_STATES
  ],
  [COLLECTION_STATE.SAVING_PROFILE]: [
    COLLECTION_STATE.MOVING_TO_NEXT_PROFILE, ...ABORT_STATES, ...FINISH_STATES
  ],
  [COLLECTION_STATE.MOVING_TO_NEXT_PROFILE]: [
    COLLECTION_STATE.EXTRACTING_PROFILE, COLLECTION_STATE.OPENING_PROFILE_COLLECTOR,
    // A queue that drains while the list is still settling goes back for more.
    COLLECTION_STATE.DISCOVERING_CONNECTIONS, ...ABORT_STATES, ...FINISH_STATES
  ],
  // Step 12: a hidden collector resumes into whichever half of the run it left.
  [COLLECTION_STATE.PAUSED_HIDDEN]: [
    COLLECTION_STATE.OPENING_CONNECTIONS, COLLECTION_STATE.DISCOVERING_CONNECTIONS,
    COLLECTION_STATE.CONNECTIONS_COMPLETE, COLLECTION_STATE.OPENING_PROFILE_COLLECTOR,
    ...EXTRACTION_CYCLE,
    COLLECTION_STATE.PAUSED_CHALLENGE, COLLECTION_STATE.STOPPED, COLLECTION_STATE.FAILED
  ],
  [COLLECTION_STATE.PAUSED_CHALLENGE]: [
    COLLECTION_STATE.IDLE, COLLECTION_STATE.OPENING_CONNECTIONS,
    COLLECTION_STATE.DISCOVERING_CONNECTIONS, COLLECTION_STATE.CONNECTIONS_COMPLETE,
    COLLECTION_STATE.OPENING_PROFILE_COLLECTOR, ...EXTRACTION_CYCLE,
    COLLECTION_STATE.STOPPED, COLLECTION_STATE.FAILED
  ],
  // A terminal state is left only by explicitly starting over.
  [COLLECTION_STATE.STOPPED]: [COLLECTION_STATE.IDLE],
  [COLLECTION_STATE.COMPLETED]: [COLLECTION_STATE.IDLE],
  [COLLECTION_STATE.COMPLETED_WITH_GAP]: [COLLECTION_STATE.IDLE],
  [COLLECTION_STATE.FAILED]: [COLLECTION_STATE.IDLE]
});

/**
 * States in which the worker is still allowed to do work.
 *
 * Requirement 13: once the run reaches a terminal state, nothing may keep
 * processing. The loop, the heartbeat and the alarm all consult this, so
 * "completed" really means stopped rather than merely labelled.
 */
export function isActiveCollectionState(state) {
  const value = String(state || COLLECTION_STATE.IDLE);
  return !TERMINAL_COLLECTION_STATES.includes(value) && value !== COLLECTION_STATE.IDLE;
}

/** What the importer page shows for each state. Shown verbatim, so it is plain. */
export const COLLECTION_STATE_TEXT = Object.freeze({
  [COLLECTION_STATE.IDLE]: "Idle.",
  [COLLECTION_STATE.OPENING_CONNECTIONS]: "Opening your Connections page…",
  [COLLECTION_STATE.DISCOVERING_CONNECTIONS]: "Reading your connections list…",
  [COLLECTION_STATE.CONNECTIONS_COMPLETE]: "Connections list complete. Starting extraction…",
  [COLLECTION_STATE.OPENING_PROFILE_COLLECTOR]: "Opening the profile collector tab…",
  [COLLECTION_STATE.EXTRACTING_PROFILE]: "Reading a profile…",
  [COLLECTION_STATE.SAVING_PROFILE]: "Saving a profile…",
  [COLLECTION_STATE.MOVING_TO_NEXT_PROFILE]: "Moving to the next profile…",
  [COLLECTION_STATE.PAUSED_HIDDEN]: "Paused — the collector tab is not visible. Switch back to it to continue.",
  [COLLECTION_STATE.PAUSED_CHALLENGE]: "Paused — LinkedIn asked for a check. Complete it, then start again.",
  [COLLECTION_STATE.STOPPED]: "Stopped.",
  [COLLECTION_STATE.COMPLETED]: "Finished. Every connection was collected.",
  [COLLECTION_STATE.COMPLETED_WITH_GAP]: "Finished, but some connections could not be collected.",
  [COLLECTION_STATE.FAILED]: "Stopped after an error."
});

export function collectionStateText(state) {
  return COLLECTION_STATE_TEXT[String(state || COLLECTION_STATE.IDLE)] || "";
}

export function isTerminalCollectionState(state) {
  return TERMINAL_COLLECTION_STATES.includes(String(state || ""));
}

export function canTransitionCollection(from, to) {
  const allowed = COLLECTION_TRANSITIONS[String(from || COLLECTION_STATE.IDLE)] || [];
  return allowed.includes(String(to || ""));
}

/**
 * Move the session to `next`, or refuse.
 *
 * `changed` is the guard the worker uses: it only ever starts discovery or
 * extraction when it actually won the transition, so a wake-up that arrives
 * while the previous run is still going is a no-op rather than a duplicate.
 */
export function transitionCollection(session, next, now = "", patch = {}) {
  const current = String(session?.collectionState || COLLECTION_STATE.IDLE);
  const target = String(next || "");
  if (current === target) return { session, changed: false, reason: "already-in-state" };
  if (!canTransitionCollection(current, target)) {
    return { session, changed: false, reason: `refused:${current}->${target}` };
  }
  return {
    session: { ...session, ...patch, collectionState: target, collectionStateAt: now, updatedAt: now },
    changed: true,
    reason: `${current}->${target}`
  };
}

export const VISIBILITY_PAUSE_MESSAGE =
  "Collector paused because LinkedIn is not rendering the hidden page. Keep the collector window open and non-minimized.";

export const FAILURE_KIND = Object.freeze({ TRANSIENT: "transient", PERMANENT: "permanent" });

/**
 * Why the run is not running. Surfaced verbatim on the importer page so a finished
 * run, a challenge, and a silent early stop can never look the same.
 */
export const STOP_REASON = Object.freeze({
  NONE: "",
  QUEUE_COMPLETE: "queue-complete",
  DISCOVERY_COMPLETE: "discovery-complete",
  USER_STOPPED: "user-stopped",
  QUEUE_CLEARED: "queue-cleared",
  CHALLENGE: "challenge",
  LOGIN_REQUIRED: "login-required",
  VISIBILITY: "collector-hidden",
  NAVIGATION: "navigation-failures",
  ERROR: "error",
  BATCH_COOLDOWN: "batch-cooldown"
});

export const STOP_REASON_TEXT = Object.freeze({
  [STOP_REASON.QUEUE_COMPLETE]: "Every queued connection has been collected, failed, or skipped.",
  [STOP_REASON.DISCOVERY_COMPLETE]: "Discovery finished. The whole connections list has been saved.",
  [STOP_REASON.USER_STOPPED]: "Stopped by you.",
  [STOP_REASON.QUEUE_CLEARED]: "The queue was cleared. Saved profiles were not touched.",
  [STOP_REASON.CHALLENGE]: "LinkedIn asked for a check. Complete it yourself, then start again.",
  [STOP_REASON.LOGIN_REQUIRED]: "You are not signed in to LinkedIn.",
  [STOP_REASON.VISIBILITY]: VISIBILITY_PAUSE_MESSAGE,
  [STOP_REASON.NAVIGATION]: "Repeated navigation failures.",
  [STOP_REASON.ERROR]: "Stopped after an error.",
  [STOP_REASON.BATCH_COOLDOWN]: "Resting between batches — the next batch starts automatically."
});

export function stopReasonText(reason, detail = "") {
  const base = STOP_REASON_TEXT[String(reason || "")] || "";
  const extra = String(detail || "").trim();
  if (!base) return extra;
  return extra && extra !== base ? `${base} ${extra}` : base;
}

/**
 * Which discovered connections a run is allowed to touch. Discovery always keeps
 * the full list; the scope only narrows what extraction claims from it.
 */
export const SELECTION_SCOPE = Object.freeze({
  ALL: "all",
  SELECTED: "selected",
  UNCOLLECTED: "uncollected",
  FAILED: "failed",
  STALE: "stale"
});

/** Row counts the connections list may be paginated at. */
export const PAGE_SIZES = Object.freeze([25, 50]);
export const DEFAULT_PAGE_SIZE = 25;

export const MAX_ATTEMPTS = 3;
export const MAX_NAVIGATION_FAILURES = 3;
export const DEFAULT_SESSION_LIMIT = 100;
export const DEFAULT_COOLDOWN_MS = 90 * 1000;
export const MIN_ITEM_DELAY_MS = 4000;
export const MAX_ITEM_DELAY_MS = 9000;
export const BACKOFF_BASE_MS = 15000;
// A pass must find nothing new this many times in a row before the list is called
// exhausted. Kept above 2 because LinkedIn's lazy loading can stall for one pass and
// then resume, and declaring completion early is the worst failure mode here.
export const DISCOVERY_QUIET_PASSES = 3;
export const DEFAULT_REFRESH_MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function toTime(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoPlus(now, ms) {
  const base = toTime(now);
  return base === null ? "" : new Date(base + ms).toISOString();
}

/** Phase 24: the discovery cursor and coverage ledger, persisted with the session. */
export function createDiscoveryState(patch = {}) {
  return {
    cursorY: 0,
    passes: 0,
    passesWithoutGrowth: 0,
    discovered: 0,
    totalCount: null,
    totalReliable: false,
    atBottom: false,
    paginationAvailable: false,
    paginationClicks: 0,
    exhausted: false,
    coverageConfirmed: false,
    lastRunAt: "",
    // Reconciliation ledger: cards the list rendered that carried no usable
    // profile link, and extra links pointing at somebody already discovered.
    cardsSeen: 0,
    cardsWithoutUrl: 0,
    restrictedCards: 0,
    duplicateLinks: 0,
    /** Unique usable URLs + cards that carried no usable URL. */
    accountedFor: 0,
    /** Connections LinkedIn advertised that no profile URL could be built for. */
    gap: 0,
    /** Allowlisted pagination clicks in a row that revealed nothing. */
    fruitlessPaginationClicks: 0,
    stopReason: "",
    ...patch
  };
}

/** How many consecutive pagination clicks may reveal nothing before it is dead. */
export const MAX_FRUITLESS_PAGINATION = 3;
/** How many times the drain loop may ask for more connections and get none. */
export const MAX_FRUITLESS_DISCOVERY = 3;

/**
 * May the extraction loop ask discovery for more connections again?
 *
 * Without this bound the drain loop retried forever whenever a pass reported
 * neither growth nor exhaustion, which is what made discovery appear to run
 * indefinitely and never hand over to extraction.
 */
export function shouldContinueAutoDiscovery(session) {
  if (!session?.autoDiscover) return false;
  if (session.discoveryExhausted) return false;
  return Number(session.fruitlessDiscoveries || 0) < MAX_FRUITLESS_DISCOVERY;
}

export function registerFruitlessDiscovery(session, now = "") {
  const fruitlessDiscoveries = Number(session?.fruitlessDiscoveries || 0) + 1;
  const spent = fruitlessDiscoveries >= MAX_FRUITLESS_DISCOVERY;
  return {
    ...session,
    fruitlessDiscoveries,
    discoveryExhausted: Boolean(session?.discoveryExhausted) || spent,
    updatedAt: now
  };
}

export function registerDiscoveryGrowth(session, now = "") {
  return { ...session, fruitlessDiscoveries: 0, updatedAt: now };
}

/**
 * Which terminal state a finished run belongs in.
 * A reliable advertised total that the collected URLs cannot reach is a gap, and
 * saying so is the whole point - it is otherwise indistinguishable from success.
 */
export function terminalStateFor(state) {
  const discovery = createDiscoveryState(state?.session?.discovery || {});
  const stats = queueStats(state?.items || []);
  const gap = discovery.totalReliable && discovery.totalCount
    ? Math.max(0, Number(discovery.totalCount) - Number(discovery.discovered || 0))
    : 0;
  if (gap > 0 || stats.failed > 0) return COLLECTION_STATE.COMPLETED_WITH_GAP;
  return COLLECTION_STATE.COMPLETED;
}

export function createSession(patch = {}) {
  return {
    key: "session",
    status: SESSION_STATUS.IDLE,
    pausedBy: PAUSED_BY.NONE,
    currentUrl: "",
    currentName: "",
    autoDiscover: true,
    discoveryExhausted: false,
    /** Explicit state machine; see COLLECTION_STATE. */
    collectionState: COLLECTION_STATE.IDLE,
    collectionStateAt: "",
    /** Where a hidden-collector pause returns to when the tab is visible again. */
    resumeCollectionState: "",
    /** Consecutive drain-loop discovery attempts that produced nothing. */
    fruitlessDiscoveries: 0,
    sessionLimit: DEFAULT_SESSION_LIMIT,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    cooldownUntil: "",
    batchNumber: 0,
    processedInSession: 0,
    processedTotal: 0,
    navigationFailures: 0,
    refreshMaxAgeDays: DEFAULT_REFRESH_MAX_AGE_DAYS,
    forceRefresh: false,
    scope: SELECTION_SCOPE.ALL,
    scopeUrls: [],
    discoveryRunning: false,
    /** The last LinkedIn session verdict, so the page can offer Sign in. */
    authState: "unknown",
    authMessage: "",
    startedAt: "",
    updatedAt: "",
    lastError: "",
    pauseReason: "",
    challengeKind: "",
    stopReason: "",
    stopReasonDetail: "",
    ...patch,
    discovery: createDiscoveryState(patch.discovery || {})
  };
}

export function createItem(url, now = "", name = "") {
  return {
    url,
    name: String(name || ""),
    status: ITEM_STATUS.PENDING,
    attempts: 0,
    addedAt: now,
    updatedAt: now,
    error: "",
    failureKind: "",
    nextAttemptAt: "",
    profileId: "",
    // When this connection's profile was last written to the vault. Drives both
    // the "last collected" column and the skip-if-recent rule.
    lastCollectedAt: "",
    fresh: false
  };
}

export function queueStats(items = []) {
  const stats = { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0 };
  for (const item of items) {
    stats.total += 1;
    if (Object.prototype.hasOwnProperty.call(stats, item.status)) stats[item.status] += 1;
  }
  return stats;
}

export function progressPercent(items = []) {
  const stats = queueStats(items);
  const done = stats.completed + stats.failed + stats.skipped;
  return stats.total ? Math.round((done / stats.total) * 100) : 0;
}

/**
 * Add connections as pending items. Accepts plain URL strings or `{ url, name }`
 * entries. Existing URLs are never duplicated or reset, but a previously unknown
 * name is filled in when a later pass supplies one.
 */
export function enqueueUrls(items = [], urls = [], now = "") {
  const next = [...items];
  const index = new Map();
  next.forEach((item, position) => index.set(String(item.url).toLowerCase(), position));
  let added = 0;
  let duplicates = 0;
  const addedUrls = [];

  for (const candidate of urls) {
    const url = String((typeof candidate === "string" ? candidate : candidate?.url) ?? "").trim();
    if (!url) continue;
    const name = String((typeof candidate === "string" ? "" : candidate?.name) ?? "").trim();
    const key = url.toLowerCase();

    if (index.has(key)) {
      duplicates += 1;
      const position = index.get(key);
      if (name && !next[position].name) next[position] = { ...next[position], name };
      continue;
    }
    index.set(key, next.length);
    next.push(createItem(url, now, name));
    addedUrls.push(url);
    added += 1;
  }
  return { items: next, added, duplicates, addedUrls };
}

function patchItem(items, url, patch) {
  const key = String(url ?? "").toLowerCase();
  return items.map((item) => (String(item.url).toLowerCase() === key ? { ...item, ...patch } : item));
}

export function findItem(items = [], url = "") {
  const key = String(url).toLowerCase();
  return items.find((item) => String(item.url).toLowerCase() === key) || null;
}

export function sessionLimitReached(session) {
  const limit = Number(session?.sessionLimit) || 0;
  return limit > 0 && Number(session?.processedInSession || 0) >= limit;
}

function isReady(item, now) {
  if (!item.nextAttemptAt) return true;
  const ready = toTime(item.nextAttemptAt);
  const current = toTime(now);
  if (ready === null || current === null) return true;
  return current >= ready;
}

// ------------------------------------------------------------------ discovery

/**
 * Phase 22: fold one discovery pass into the ledger.
 * Coverage is only "confirmed" when the advertised total is reliable and reached,
 * or when the list is provably exhausted: bottom reached, no allowlisted pagination
 * control left, and no new URLs across DISCOVERY_QUIET_PASSES consecutive passes.
 */
export function applyDiscoveryPass(session, pass = {}, added = 0, now = "") {
  const previous = createDiscoveryState(session?.discovery || {});
  // Growth means new connections, not activity. Counting a pagination click as
  // growth let a control that revealed nothing reset the quiet counter on every
  // pass, so discovery could never conclude the list had ended.
  const grew = Number(added) > 0;
  const passesWithoutGrowth = grew ? 0 : previous.passesWithoutGrowth + 1;
  const discovered = previous.discovered + Math.max(0, Number(added) || 0);

  const totalCount = pass.total ?? previous.totalCount;
  const totalReliable = pass.total !== null && pass.total !== undefined ? Boolean(pass.totalReliable) : previous.totalReliable;

  // Card counts are cumulative highs across passes: a later pass reads a smaller
  // window of a virtualized list, and the ledger must never shrink because of it.
  const cards = pass.cards || {};
  const highest = (key) => Math.max(Number(previous[key]) || 0, Number(cards[key]) || 0);
  const cardsWithoutUrl = highest("cardsWithoutUrl");

  // Coverage is settled against every card the list rendered, not only the ones
  // that yielded a URL. LinkedIn advertising 67 while one member is restricted
  // means 66 usable URLs IS the whole list; requiring `discovered >= 67` made
  // discovery hunt forever for a 67th URL that can never exist.
  const accountedFor = discovered + cardsWithoutUrl;
  const reachedTotal = Boolean(totalReliable && totalCount && accountedFor >= totalCount);
  const gap = totalReliable && totalCount ? Math.max(0, totalCount - discovered) : 0;

  // An allowlisted control that keeps being clicked and never reveals anything is
  // not progress; treating every click as growth reset the quiet counter forever.
  const fruitlessPaginationClicks = pass.clickedPagination && !grew
    ? previous.fruitlessPaginationClicks + 1
    : (grew ? 0 : previous.fruitlessPaginationClicks);
  const paginationDead = fruitlessPaginationClicks >= MAX_FRUITLESS_PAGINATION;

  const settled =
    Boolean(pass.atBottom) &&
    (!pass.paginationAvailable || paginationDead) &&
    passesWithoutGrowth >= DISCOVERY_QUIET_PASSES;

  return createDiscoveryState({
    cursorY: Number(pass.cursorY) || 0,
    passes: previous.passes + 1,
    passesWithoutGrowth,
    discovered,
    totalCount,
    totalReliable,
    atBottom: Boolean(pass.atBottom),
    paginationAvailable: Boolean(pass.paginationAvailable),
    paginationClicks: previous.paginationClicks + (pass.clickedPagination ? 1 : 0),
    cardsSeen: highest("cardsSeen"),
    cardsWithoutUrl,
    restrictedCards: highest("restrictedCards"),
    duplicateLinks: highest("duplicateLinks"),
    accountedFor,
    gap,
    fruitlessPaginationClicks,
    exhausted: reachedTotal || settled,
    coverageConfirmed: reachedTotal,
    stopReason: String(pass.stopReason || previous.stopReason || ""),
    lastRunAt: now
  });
}

export function resetDiscovery(session) {
  return { ...session, discovery: createDiscoveryState() };
}

/** Phase 24: what the dashboard reports about coverage. */
export function coverageReport(state) {
  const items = state.items || [];
  const session = state.session || createSession();
  const discovery = createDiscoveryState(session.discovery || {});
  const stats = queueStats(items);
  const processed = stats.completed;
  const remaining = stats.pending + stats.processing;

  let coverage = "unknown";
  if (discovery.coverageConfirmed) coverage = "confirmed";
  else if (discovery.exhausted) coverage = "estimated";
  else if (discovery.passes > 0) coverage = "in-progress";

  return {
    discovered: stats.total,
    processed,
    remaining,
    failed: stats.failed,
    skipped: stats.skipped,
    totalCount: discovery.totalCount,
    totalReliable: discovery.totalReliable,
    coverage,
    coverageConfirmed: discovery.coverageConfirmed,
    discoveryPasses: discovery.passes,
    paginationClicks: discovery.paginationClicks,
    paginationAvailable: discovery.paginationAvailable,
    exhausted: discovery.exhausted,
    // What discovery could not turn into a profile URL. Shown on the importer
    // page as "missing / inaccessible", and reconciled against `totalCount`.
    cardsSeen: Number(discovery.cardsSeen) || 0,
    cardsWithoutUrl: Number(discovery.cardsWithoutUrl) || 0,
    restrictedCards: Number(discovery.restrictedCards) || 0,
    duplicateLinks: Number(discovery.duplicateLinks) || 0,
    accountedFor: Number(discovery.accountedFor) || 0,
    gap: Number(discovery.gap) || 0,
    discoveryStopReason: String(discovery.stopReason || "")
  };
}

// -------------------------------------------------------------------- claim

/**
 * Take the next pending item. Returns `item: null` unless the session is running,
 * the batch cap still allows work, and nothing else is already processing —
 * this is what enforces one-profile-at-a-time.
 */
export function claimNext(state, now = "") {
  const items = state.items || [];
  const session = state.session || createSession();
  if (session.status !== SESSION_STATUS.RUNNING) return { ...state, item: null, reason: "not-running" };
  if (items.some((item) => item.status === ITEM_STATUS.PROCESSING)) {
    return { ...state, item: null, reason: "busy" };
  }
  if (sessionLimitReached(session)) {
    // D3: the cap pauses into a cooldown that later resumes on its own.
    return {
      items,
      session: {
        ...session,
        status: SESSION_STATUS.PAUSED,
        pausedBy: PAUSED_BY.COOLDOWN,
        currentUrl: "",
        cooldownUntil: isoPlus(now, Number(session.cooldownMs) || DEFAULT_COOLDOWN_MS),
        pauseReason: `Batch cap of ${session.sessionLimit} reached. Cooling down before the next batch.`,
        stopReason: STOP_REASON.BATCH_COOLDOWN,
        stopReasonDetail: "",
        updatedAt: now
      },
      item: null,
      reason: "limit-reached"
    };
  }

  // Only connections inside the run's selection scope may ever be claimed. An
  // empty scope means "everything discovered".
  const scoped = items.filter((item) => inScope(item, session));
  const ready = scoped.filter((item) => item.status === ITEM_STATUS.PENDING && isReady(item, now));
  const candidate = ready[0];
  if (!candidate) {
    const waiting = scoped.some((item) => item.status === ITEM_STATUS.PENDING);
    if (waiting) return { ...state, item: null, reason: "backoff" };
    return {
      items,
      session: {
        ...session,
        status: SESSION_STATUS.IDLE,
        pausedBy: PAUSED_BY.NONE,
        currentUrl: "",
        stopReason: STOP_REASON.QUEUE_COMPLETE,
        stopReasonDetail: "",
        updatedAt: now
      },
      item: null,
      reason: "empty"
    };
  }
  const claimed = { ...candidate, status: ITEM_STATUS.PROCESSING, attempts: candidate.attempts + 1, updatedAt: now };
  return {
    items: patchItem(items, candidate.url, claimed),
    session: { ...session, currentUrl: candidate.url, currentName: candidate.name || "", updatedAt: now },
    item: claimed,
    reason: "claimed"
  };
}

export function markCompleted(state, url, now = "", profileId = "", fresh = false, collectedAt = "") {
  const session = state.session || createSession();
  return {
    items: patchItem(state.items || [], url, {
      status: ITEM_STATUS.COMPLETED,
      updatedAt: now,
      error: "",
      failureKind: "",
      nextAttemptAt: "",
      profileId,
      // A "fresh" completion re-used an existing record, so it keeps that
      // record's date rather than pretending it was collected just now.
      lastCollectedAt: String(collectedAt || now),
      fresh: Boolean(fresh)
    }),
    session: {
      ...session,
      currentUrl: "",
      currentName: "",
      processedInSession: Number(session.processedInSession || 0) + 1,
      processedTotal: Number(session.processedTotal || 0) + 1,
      navigationFailures: 0,
      lastError: "",
      updatedAt: now
    }
  };
}

/** Phase 29: a permanent failure never retries; a transient one backs off exponentially. */
export function classifyFailure(message = "") {
  const text = String(message || "");
  if (/(?:doesn(?:'|’)?t exist|not available|unavailable|not found|no longer|404|out of your network)/i.test(text)) {
    return FAILURE_KIND.PERMANENT;
  }
  return FAILURE_KIND.TRANSIENT;
}

export function backoffDelayMs(attempts) {
  const exponent = Math.max(0, Number(attempts) - 1);
  return BACKOFF_BASE_MS * Math.pow(2, Math.min(exponent, 4));
}

export function markFailed(state, url, now = "", error = "", kind = "") {
  const items = state.items || [];
  const session = state.session || createSession();
  const item = findItem(items, url);
  const attempts = item?.attempts ?? MAX_ATTEMPTS;
  const failureKind = kind || classifyFailure(error);
  const permanent = failureKind === FAILURE_KIND.PERMANENT;
  const exhausted = permanent || attempts >= MAX_ATTEMPTS;

  return {
    items: patchItem(items, url, {
      status: exhausted ? ITEM_STATUS.FAILED : ITEM_STATUS.PENDING,
      updatedAt: now,
      error: String(error || ""),
      failureKind,
      nextAttemptAt: exhausted ? "" : isoPlus(now, backoffDelayMs(attempts))
    }),
    session: { ...session, currentUrl: "", currentName: "", lastError: String(error || ""), updatedAt: now },
    exhausted,
    failureKind
  };
}

export function markSkipped(state, url, now = "") {
  const session = state.session || createSession();
  return {
    items: patchItem(state.items || [], url, { status: ITEM_STATUS.SKIPPED, updatedAt: now }),
    session: { ...session, currentUrl: "", currentName: "", updatedAt: now }
  };
}

export function registerNavigationFailure(state, now = "", error = "") {
  const session = state.session || createSession();
  const navigationFailures = Number(session.navigationFailures || 0) + 1;
  const tripped = navigationFailures >= MAX_NAVIGATION_FAILURES;
  return {
    items: state.items || [],
    session: {
      ...session,
      navigationFailures,
      lastError: String(error || ""),
      status: tripped ? SESSION_STATUS.PAUSED : session.status,
      pausedBy: tripped ? PAUSED_BY.NAVIGATION : session.pausedBy,
      currentUrl: tripped ? "" : session.currentUrl,
      pauseReason: tripped ? "Repeated navigation failures. Import paused for review." : session.pauseReason,
      stopReason: tripped ? STOP_REASON.NAVIGATION : session.stopReason,
      stopReasonDetail: tripped ? String(error || "") : session.stopReasonDetail,
      updatedAt: now
    },
    tripped
  };
}

/** Phase 27: a profile collected recently is not re-extracted unless forced. */
export function shouldSkipAsFresh(session, updatedAt, now = "") {
  if (!updatedAt) return false;
  if (session?.forceRefresh) return false;
  const maxAgeDays = Number(session?.refreshMaxAgeDays);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return false;
  const saved = toTime(updatedAt);
  const current = toTime(now);
  if (saved === null || current === null) return false;
  return current - saved < maxAgeDays * DAY_MS;
}

// --------------------------------------------------------------- selection

/**
 * True when a connection has never been collected, or was last collected longer
 * than `maxAgeDays` ago. This is the same rule the skip-if-recent setting uses,
 * expressed over a queue row so the user can also *select* by it.
 */
export function isStale(item, maxAgeDays = DEFAULT_REFRESH_MAX_AGE_DAYS, now = "") {
  const collected = toTime(item?.lastCollectedAt);
  if (collected === null) return true;
  const days = Number(maxAgeDays);
  if (!Number.isFinite(days) || days <= 0) return true;
  const current = toTime(now);
  if (current === null) return true;
  return current - collected >= days * DAY_MS;
}

/**
 * Resolve a selection scope to the concrete connections a run should cover.
 * The discovered list itself is never narrowed - only what extraction claims.
 */
export function selectItemUrls(items = [], options = {}) {
  const scope = String(options.scope || SELECTION_SCOPE.ALL);
  const maxAgeDays = Number(options.refreshMaxAgeDays);
  const days = Number.isFinite(maxAgeDays) ? maxAgeDays : DEFAULT_REFRESH_MAX_AGE_DAYS;
  const now = String(options.now || "");
  const chosen = new Set((options.urls || []).map((url) => String(url).toLowerCase()));

  return items
    .filter((item) => {
      if (scope === SELECTION_SCOPE.SELECTED) return chosen.has(String(item.url).toLowerCase());
      if (scope === SELECTION_SCOPE.FAILED) return item.status === ITEM_STATUS.FAILED;
      if (scope === SELECTION_SCOPE.UNCOLLECTED) return item.status !== ITEM_STATUS.COMPLETED || !item.lastCollectedAt;
      if (scope === SELECTION_SCOPE.STALE) return isStale(item, days, now);
      return true;
    })
    .map((item) => item.url);
}

/**
 * Arm the queue for a run over exactly `urls`: those rows go back to pending and
 * the session records the scope so `claimNext` cannot wander outside it. Rows
 * outside the scope keep their status untouched - a narrowed run must never
 * discard the rest of the discovered list.
 */
export function prepareRun(state, urls = [], now = "", scope = String(SELECTION_SCOPE.ALL)) {
  const session = state.session || createSession();
  const wanted = new Set((urls || []).map((url) => String(url).toLowerCase()));
  const items = (state.items || []).map((item) => {
    if (!wanted.has(String(item.url).toLowerCase())) return item;
    if (item.status === ITEM_STATUS.PROCESSING) return item;
    return {
      ...item,
      status: ITEM_STATUS.PENDING,
      attempts: 0,
      error: "",
      failureKind: "",
      nextAttemptAt: "",
      updatedAt: now
    };
  });
  return {
    items,
    session: { ...session, scope: String(scope), scopeUrls: [...wanted], updatedAt: now },
    selected: wanted.size
  };
}

function inScope(item, session) {
  const scopeUrls = session?.scopeUrls;
  if (!Array.isArray(scopeUrls) || !scopeUrls.length) return true;
  return scopeUrls.includes(String(item.url).toLowerCase());
}

// ------------------------------------------------------- list view (pure)

/**
 * Search + status filtering for the connections list. Kept here so the React
 * page renders exactly what the tests exercise.
 */
export function filterItems(items = [], { search = "", status = "" } = {}) {
  const needle = String(search || "").trim().toLowerCase();
  const wantedStatus = String(status || "").trim();
  return items.filter((item) => {
    if (wantedStatus && item.status !== wantedStatus) return false;
    if (!needle) return true;
    return `${item.name || ""} ${item.url || ""}`.toLowerCase().includes(needle);
  });
}

export function pageCount(total, pageSize = DEFAULT_PAGE_SIZE) {
  const size = Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE);
  return Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / size));
}

/** Slice a filtered list into one page, clamping an out-of-range page number. */
export function paginate(items = [], page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const size = Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE);
  const pages = pageCount(items.length, size);
  const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  const start = (current - 1) * size;
  return {
    page: current,
    pages,
    pageSize: size,
    total: items.length,
    start: items.length ? start + 1 : 0,
    end: Math.min(start + size, items.length),
    rows: items.slice(start, start + size)
  };
}

/**
 * Page numbers to render around the current page, with `0` marking a gap.
 * Keeps the control usable for a list of several thousand connections.
 */
export function pageNumbers(page = 1, pages = 1, window = 2) {
  const total = Math.max(1, Math.floor(Number(pages) || 1));
  const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), total);
  const span = Math.max(1, Math.floor(Number(window) || 2));
  // A short list is never worth collapsing.
  if (total <= span * 3 + 1) return Array.from({ length: total }, (_, index) => index + 1);
  const wanted = new Set([1, total]);
  for (let offset = -span; offset <= span; offset += 1) {
    const value = current + offset;
    if (value >= 1 && value <= total) wanted.add(value);
  }
  const ordered = [...wanted].sort((left, right) => left - right);
  const output = [];
  let previous = 0;
  for (const value of ordered) {
    if (previous && value - previous > 1) output.push(0);
    output.push(value);
    previous = value;
  }
  return output;
}

export function retryFailed(state, now = "") {
  const items = (state.items || []).map((item) =>
    item.status === ITEM_STATUS.FAILED
      ? { ...item, status: ITEM_STATUS.PENDING, attempts: 0, error: "", failureKind: "", nextAttemptAt: "", updatedAt: now }
      : item
  );
  return { items, session: { ...(state.session || createSession()), lastError: "", updatedAt: now } };
}

export function clearQueue(state, now = "") {
  const session = state.session || createSession();
  return {
    items: [],
    session: {
      ...session,
      status: SESSION_STATUS.IDLE,
      pausedBy: PAUSED_BY.NONE,
      currentUrl: "",
      processedInSession: 0,
      processedTotal: 0,
      batchNumber: 0,
      navigationFailures: 0,
      cooldownUntil: "",
      lastError: "",
      pauseReason: "",
      challengeKind: "",
      scope: SELECTION_SCOPE.ALL,
      scopeUrls: [],
      stopReason: STOP_REASON.QUEUE_CLEARED,
      stopReasonDetail: "",
      updatedAt: now,
      discovery: createDiscoveryState()
    }
  };
}

export function startSession(state, now = "", options = {}) {
  const session = state.session || createSession();
  const sessionLimit = Number(options.sessionLimit) > 0 ? Number(options.sessionLimit) : session.sessionLimit || DEFAULT_SESSION_LIMIT;
  const cooldownMs = Number(options.cooldownMs) >= 0 ? Number(options.cooldownMs) : session.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  return {
    items: state.items || [],
    session: {
      ...session,
      status: SESSION_STATUS.RUNNING,
      pausedBy: PAUSED_BY.NONE,
      sessionLimit,
      cooldownMs,
      cooldownUntil: "",
      batchNumber: 1,
      processedInSession: 0,
      navigationFailures: 0,
      refreshMaxAgeDays: Number(options.refreshMaxAgeDays) >= 0 ? Number(options.refreshMaxAgeDays) : session.refreshMaxAgeDays,
      forceRefresh: Boolean(options.forceRefresh),
      autoDiscover: options.autoDiscover === false ? false : true,
      scope: options.scope ? String(options.scope) : session.scope || SELECTION_SCOPE.ALL,
      scopeUrls: Array.isArray(options.scopeUrls) ? options.scopeUrls.map((url) => String(url).toLowerCase()) : session.scopeUrls || [],
      discoveryExhausted: false,
      currentName: "",
      startedAt: now,
      updatedAt: now,
      lastError: "",
      pauseReason: "",
      challengeKind: "",
      stopReason: STOP_REASON.NONE,
      stopReasonDetail: ""
    }
  };
}

/** Map a pause into the stop reason the importer page shows. */
function pauseStopReason(pausedBy, challengeKind) {
  if (challengeKind === "login") return STOP_REASON.LOGIN_REQUIRED;
  if (challengeKind) return STOP_REASON.CHALLENGE;
  if (pausedBy === PAUSED_BY.VISIBILITY) return STOP_REASON.VISIBILITY;
  if (pausedBy === PAUSED_BY.NAVIGATION) return STOP_REASON.NAVIGATION;
  if (pausedBy === PAUSED_BY.ERROR) return STOP_REASON.ERROR;
  if (pausedBy === PAUSED_BY.COOLDOWN) return STOP_REASON.BATCH_COOLDOWN;
  return STOP_REASON.USER_STOPPED;
}

export function pauseSession(state, now = "", reason = "", challengeKind = "", pausedBy = String(PAUSED_BY.USER)) {
  const session = state.session || createSession();
  const resolvedPausedBy = challengeKind ? PAUSED_BY.CHALLENGE : pausedBy;
  return {
    items: state.items || [],
    session: {
      ...session,
      status: SESSION_STATUS.PAUSED,
      pausedBy: resolvedPausedBy,
      currentUrl: "",
      cooldownUntil: "",
      pauseReason: String(reason || "Paused."),
      challengeKind: String(challengeKind || ""),
      stopReason: pauseStopReason(resolvedPausedBy, String(challengeKind || "")),
      stopReasonDetail: String(reason || ""),
      updatedAt: now
    }
  };
}

/**
 * The collector page is hidden, so LinkedIn has stopped rendering it.
 *
 * This is a pause, never a completion: a hidden page stops changing, and reading
 * that as "nothing new appeared" is exactly how a partial profile gets saved and
 * how a half-enumerated list looks finished.
 */
export function pauseForVisibility(state, now = "") {
  const paused = pauseSession(state, now, VISIBILITY_PAUSE_MESSAGE, "", PAUSED_BY.VISIBILITY);
  return {
    items: paused.items,
    session: {
      ...paused.session,
      collectionState: COLLECTION_STATE.PAUSED_HIDDEN,
      collectionStateAt: now,
      // Where to go back to when the tab is visible again (requirement 12).
      resumeCollectionState: resumeTargetFor(state?.session?.collectionState)
    }
  };
}

/**
 * Where a hidden-pause resumes to.
 *
 * A pause during discovery must resume into discovery, and a pause mid-profile
 * must resume into extraction — resuming into the wrong half either re-walks a
 * list that was already enumerated or extracts before there is a queue.
 */
export function resumeTargetFor(state) {
  const current = String(state || "");
  if (current === COLLECTION_STATE.OPENING_CONNECTIONS) return COLLECTION_STATE.OPENING_CONNECTIONS;
  if (current === COLLECTION_STATE.DISCOVERING_CONNECTIONS) return COLLECTION_STATE.DISCOVERING_CONNECTIONS;
  if (current === COLLECTION_STATE.CONNECTIONS_COMPLETE) return COLLECTION_STATE.CONNECTIONS_COMPLETE;
  // Every extraction-side state resumes by re-opening/activating the collector
  // tab, which is also what makes the tab visible again.
  return COLLECTION_STATE.OPENING_PROFILE_COLLECTOR;
}

/** A visibility pause clears itself once the page is visible again; a challenge never does. */
export function canResumeFromVisibility(session) {
  if (session?.status !== SESSION_STATUS.PAUSED) return false;
  if (session?.challengeKind) return false;
  return session?.pausedBy === PAUSED_BY.VISIBILITY;
}

/** Resume is manual for challenges; automatic only for cooldown, visibility, and interruption. */
export function resumeSession(state, now = "") {
  const session = state.session || createSession();
  const items = (state.items || []).map((item) =>
    item.status === ITEM_STATUS.PROCESSING ? { ...item, status: ITEM_STATUS.PENDING, updatedAt: now } : item
  );
  return {
    items,
    session: {
      ...session,
      status: SESSION_STATUS.RUNNING,
      pausedBy: PAUSED_BY.NONE,
      currentUrl: "",
      cooldownUntil: "",
      navigationFailures: 0,
      processedInSession: 0,
      batchNumber: Number(session.batchNumber || 0) + 1,
      pauseReason: "",
      challengeKind: "",
      stopReason: STOP_REASON.NONE,
      stopReasonDetail: "",
      updatedAt: now
    }
  };
}

/** D3: after the cooldown elapses the next batch starts by itself. */
export function cooldownElapsed(session, now = "") {
  if (session?.status !== SESSION_STATUS.PAUSED) return false;
  if (session?.pausedBy !== PAUSED_BY.COOLDOWN) return false;
  if (session?.challengeKind) return false;
  const until = toTime(session.cooldownUntil);
  const current = toTime(now);
  if (until === null || current === null) return false;
  return current >= until;
}

export function stopSession(state, now = "") {
  const session = state.session || createSession();
  const items = (state.items || []).map((item) =>
    item.status === ITEM_STATUS.PROCESSING ? { ...item, status: ITEM_STATUS.PENDING, updatedAt: now } : item
  );
  return {
    items,
    session: {
      ...session,
      status: SESSION_STATUS.STOPPED,
      pausedBy: PAUSED_BY.NONE,
      currentUrl: "",
      cooldownUntil: "",
      pauseReason: "",
      challengeKind: "",
      stopReason: STOP_REASON.USER_STOPPED,
      stopReasonDetail: "",
      updatedAt: now
    }
  };
}

/**
 * D2: runs on every service-worker start, including after suspension and browser
 * restart. Normal interrupted processing continues automatically; a session paused
 * by a challenge, restriction, navigation trip, or the user stays paused.
 */
export function recoverAfterInterruption(state, now = "") {
  const session = state.session || createSession();
  const items = (state.items || []).map((item) =>
    item.status === ITEM_STATUS.PROCESSING ? { ...item, status: ITEM_STATUS.PENDING, updatedAt: now } : item
  );

  if (session.status === SESSION_STATUS.RUNNING) {
    return {
      items,
      session: { ...session, currentUrl: "", updatedAt: now },
      resumed: true,
      reason: "interrupted-run"
    };
  }

  if (cooldownElapsed(session, now)) {
    return {
      items,
      session: {
        ...session,
        status: SESSION_STATUS.RUNNING,
        pausedBy: PAUSED_BY.NONE,
        currentUrl: "",
        cooldownUntil: "",
        processedInSession: 0,
        batchNumber: Number(session.batchNumber || 0) + 1,
        pauseReason: "",
        updatedAt: now
      },
      resumed: true,
      reason: "cooldown-elapsed"
    };
  }

  return { items, session: { ...session, currentUrl: "" }, resumed: false, reason: session.pausedBy || session.status };
}

export function summarize(state) {
  const items = state.items || [];
  const session = state.session || createSession();
  const coverage = coverageReport(state);
  return {
    ...queueStats(items),
    progress: progressPercent(items),
    status: session.status,
    pausedBy: session.pausedBy,
    currentUrl: session.currentUrl,
    currentName: session.currentName,
    autoDiscover: session.autoDiscover,
    discoveryExhausted: session.discoveryExhausted,
    sessionLimit: session.sessionLimit,
    cooldownMs: session.cooldownMs,
    cooldownUntil: session.cooldownUntil,
    batchNumber: session.batchNumber,
    processedInSession: session.processedInSession,
    processedTotal: session.processedTotal,
    refreshMaxAgeDays: session.refreshMaxAgeDays,
    forceRefresh: session.forceRefresh,
    scope: session.scope || SELECTION_SCOPE.ALL,
    scopeCount: Array.isArray(session.scopeUrls) ? session.scopeUrls.length : 0,
    discoveryRunning: Boolean(session.discoveryRunning),
    collectionState: session.collectionState || COLLECTION_STATE.IDLE,
    collectionStateAt: session.collectionStateAt || "",
    collectionStateText: collectionStateText(session.collectionState),
    resumeCollectionState: session.resumeCollectionState || "",
    collectionActive: isActiveCollectionState(session.collectionState),
    authState: session.authState || "unknown",
    authMessage: session.authMessage || "",
    lastError: session.lastError,
    pauseReason: session.pauseReason,
    challengeKind: session.challengeKind,
    stopReason: session.stopReason || "",
    stopReasonDetail: session.stopReasonDetail || "",
    stopReasonText: stopReasonText(session.stopReason, session.stopReasonDetail),
    coverage
  };
}
