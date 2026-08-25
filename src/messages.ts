// Typed message contract shared by the React UI and the service worker.
// Content scripts are framework-free classic scripts and use the same literals.

export const PROFILE_MESSAGES = {
  PING: "PV_PING",
  CHECK_PAGE: "PV_CHECK_PAGE",
  EXTRACT: "PV_EXTRACT",
  GET_DIAGNOSTICS: "PV_GET_DIAGNOSTICS"
} as const;

export const CONNECTION_MESSAGES = {
  DISCOVER: "PV_DISCOVER_CONNECTIONS",
  TOTAL: "PV_CONNECTION_TOTAL",
  /** Session detection only — never a credential prompt. */
  CHECK_LOGIN: "PV_CHECK_LOGIN",
  DIAGNOSTICS: "PV_GET_DIAGNOSTICS"
} as const;

export const IMPORT_MESSAGES = {
  GET_BUILD_INFO: "PV_GET_BUILD_INFO",
  STATUS: "PV_IMPORT_STATUS",
  DISCOVER: "PV_IMPORT_DISCOVER",
  /** Find All Connections: enumerate the whole list, without extracting anything. */
  DISCOVER_ALL: "PV_IMPORT_DISCOVER_ALL",
  RUN_ALL: "PV_IMPORT_RUN_ALL",
  START_COLLECTING: "PV_IMPORT_START_COLLECTING",
  ENQUEUE: "PV_IMPORT_ENQUEUE",
  START: "PV_IMPORT_START",
  PAUSE: "PV_IMPORT_PAUSE",
  RESUME: "PV_IMPORT_RESUME",
  STOP: "PV_IMPORT_STOP",
  SKIP: "PV_IMPORT_SKIP",
  RETRY_FAILED: "PV_IMPORT_RETRY_FAILED",
  /** Stops the active process and wipes the queue. Saved profiles are untouched. */
  CLEAR: "PV_IMPORT_CLEAR",
  /** Reports Signed in / Login required / Checkpoint detected. */
  CHECK_LOGIN: "PV_IMPORT_CHECK_LOGIN",
  /** Opens LinkedIn's official sign-in page in the collector tab. */
  OPEN_LOGIN: "PV_IMPORT_OPEN_LOGIN",
  COMPLETED_URLS: "PV_IMPORT_COMPLETED_URLS",
  /** Streamed from the connections page mid-pass so rows reach IndexedDB early. */
  DISCOVERY_PROGRESS: "PV_IMPORT_DISCOVERY_PROGRESS",
  /** Live diagnostics for the last discovery pass and the last profile scan. */
  DIAGNOSTICS: "PV_IMPORT_DIAGNOSTICS"
} as const;

/**
 * The recruiter hiring surface (3.7.0).
 *
 * `PING`/`CHECK_PAGE`/`EXTRACT`/`EXTRACT_ALL`/`STOP`/`STATUS` are sent to the
 * applicants content script. `COLLECT_CURRENT`/`COLLECT_ALL`/`LIST`/`CLEAR` are
 * sent to the service worker, which drives the tab and does the saving.
 * `DOWNLOAD_RESUME` travels the other way — a content script has no
 * `chrome.downloads`, so it asks the worker to fetch the file.
 */
export const APPLICANT_MESSAGES = {
  PING: "PV_APPLICANT_PING",
  CHECK_PAGE: "PV_APPLICANT_CHECK_PAGE",
  EXTRACT: "PV_APPLICANT_EXTRACT",
  EXTRACT_ALL: "PV_APPLICANT_EXTRACT_ALL",
  STATUS: "PV_APPLICANT_STATUS",
  STOP: "PV_APPLICANT_STOP",
  DOWNLOAD_RESUME: "PV_APPLICANT_DOWNLOAD_RESUME",
  /**
   * Open the resume in a tab this extension owns, save it from there, close the
   * tab and hand focus back — all of it in the worker, so the page never goes
   * hidden underneath a tab it cannot see and the run is never left stranded.
   */
  OPEN_AND_SAVE_RESUME: "PV_APPLICANT_OPEN_AND_SAVE_RESUME",
  /**
   * Streamed from the applicants page as each record is finished, so a run that
   * the user walks away from has already persisted everything it collected.
   * The worker's save is a merge, so re-sending a record is harmless.
   */
  SAVE: "PV_APPLICANT_SAVE",
  COLLECT_CURRENT: "PV_APPLICANT_COLLECT_CURRENT",
  COLLECT_ALL: "PV_APPLICANT_COLLECT_ALL",
  LIST: "PV_APPLICANT_LIST",
  /**
   * The lean half of LIST: one small entry per stored applicant, which is all a
   * run needs to know who it may skip. A whole job's records would be megabytes
   * over the message channel for a question that is answered by three fields.
   */
  COLLECTED: "PV_APPLICANT_COLLECTED",
  /**
   * "Does this job have an unfinished recruiter-started run, and with which options?"
   *
   * Asked by the applicants page every time it arrives on a job, and answered
   * only for a job the recruiter themselves started a run on. It is what makes
   * navigating back to a job's applicants page resume interrupted work rather
   * than sit idle — the content script is destroyed by the navigation, so the
   * worker is the only thing that can remember. A completed lifecycle is not
   * restartable. Cleared by the universal Stop, so a Stop can never be undone by
   * walking away and coming back.
   */
  AUTO_RUN: "PV_APPLICANT_AUTO_RUN",
  /**
   * Reports that the newest execution of an armed whole-job run completed or
   * was interrupted. The worker rejects stale run/attempt tokens, so a replaced
   * content-script loop cannot overwrite the lifecycle of its successor.
   */
  RUN_LIFECYCLE: "PV_APPLICANT_RUN_LIFECYCLE",
  /**
   * "How many times has this job already reloaded the page chasing resumes
   * LinkedIn was still virus-scanning?" — and, with `spend: true`, "record that
   * it is about to do so again."
   *
   * LinkedIn's own remedy for a stale attachment session is to refresh the page,
   * so the run does exactly that and comes back for the applicants it still
   * owes. The budget that stops it looping cannot live in the run: a reload
   * destroys the document and every counter in it, so a limit held there would
   * be reset by the very act it bounds. It rides on the auto-run lease instead,
   * which already survives navigation and is already cleared by the universal
   * Stop — so a Stop takes the reload budget with it and no reload can fire
   * after one.
   *
   * A job with no lease is answered with zero and nothing is written: an
   * unarmed job has no run to bound, and writing an entry would arm one.
   */
  RESUME_RELOAD: "PV_APPLICANT_RESUME_RELOAD",
  CLEAR: "PV_APPLICANT_CLEAR",
  DIAGNOSTICS: "PV_APPLICANT_DIAGNOSTICS",
  /**
   * Capture the open applicant's LAYOUT — not the applicant.
   *
   * Read-only: no click, no scroll, nothing saved. What comes back is the
   * section scan, the header window, the line arrays each reader consumed and
   * the KIND of every link, with names replaced by stable pseudonyms and every
   * address, number, token and credential taken out. It is what turns "this
   * layout reads wrong" into a fixture.
   */
  CAPTURE_UI: "PV_APPLICANT_CAPTURE_UI"
} as const;

/**
 * Messaging one applicant (3.10.0).
 *
 * `PROBE` and `INSERT` are sent to the worker, which relays them to the
 * applicants content script as `PV_APPLICANT_MESSAGE_PROBE` and
 * `PV_APPLICANT_MESSAGE_INSERT`.
 *
 * **There is no SEND, and there is deliberately no room for one.** LinkedIn's
 * composer says "Press Enter to Send" and the human presses it; this extension
 * types the recruiter's own reviewed text into the box and stops. `send` is on
 * the applicant denylist for every purpose, so no Send control can be
 * classified as clickable by any caller — the absence of a message type here is
 * the *second* line of that defence, not the first.
 *
 * There is also no BULK: one request names one applicant, and the worker relays
 * exactly one insertion per request with no loop, queue or retry.
 */
export const MESSAGING_MESSAGES = {
  /** Observation only: what a compose request would find. Presses nothing. */
  PROBE: "PV_MESSAGE_PROBE",
  INSERT: "PV_MESSAGE_INSERT"
} as const;

/**
 * The universal Stop.
 *
 * One message that ends every kind of work this extension can be doing: the
 * connections discovery pass, the profile queue, and an applicant run — and it
 * reaches the content scripts too, so a scan already walking a page stops
 * within one step instead of at the end of the list.
 */
export const STOP_ALL = "PV_STOP_ALL";

export type ResumeDownloadStatus =
  | "not_attempted"
  | "downloaded"
  | "already_saved"
  | "link_only"
  | "unavailable"
  | "failed";

export type QualificationCategory = "must_have" | "preferred" | "";
export type QualificationResult = "matched" | "not_matched" | "unknown";
export type QualificationSource = "applicant_profile" | "resume" | "screening_response" | "";

export interface ApplicantQualification {
  requirement: string;
  category: QualificationCategory;
  result: QualificationResult;
  explanation: string | null;
  source: QualificationSource;
  sourceNote: string | null;
  raw: string;
}

export interface ApplicantScreeningResponse {
  question: string;
  idealAnswer: string | null;
  answer: string | null;
  met: boolean | null;
  raw: string;
}

export interface ApplicantExperience {
  title: string;
  company: string;
  dateRange: string;
  current: boolean;
  verified: boolean;
  details: string[];
  raw: string;
}

export interface ApplicantEducation {
  institution: string;
  degree: string | null;
  field: string | null;
  dateRange: string | null;
  raw: string;
}

export interface ApplicantJob {
  id: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  applicantCount: number | null;
  url: string | null;
  mustHaveQualifications: string[];
  preferredQualifications: string[];
  screeningQuestions: ApplicantScreeningResponse[];
}

/** The stored applicant record. Absent values are `null`, never a guess. */
export interface ApplicantRecord {
  id: string;
  applicationId: string | null;
  job: ApplicantJob;
  applicant: {
    name: string;
    profileUrl: string | null;
    headline: string | null;
    location: string | null;
    currentRole: string | null;
    currentCompany: string | null;
    totalExperience: string | null;
    appliedAt: string | null;
    contactedAt: string | null;
    contact: {
      email: string | null;
      phone: string | null;
      website: string | null;
      other: string[];
    };
    resume: {
      available: boolean;
      filename: string | null;
      fileType: string | null;
      /** What the opened viewer said, when it said anything. Never derived. */
      pages: number | null;
      /** The document itself. `null` when only a viewer route is known. */
      url: string | null;
      /** The LinkedIn page that displays it. Never downloadable. */
      viewerUrl: string | null;
      localReference: string | null;
      downloadStatus: ResumeDownloadStatus;
    };
    experience: ApplicantExperience[];
    education: ApplicantEducation[];
    skills: string[];
    screeningResponses: ApplicantScreeningResponse[];
    qualifications: ApplicantQualification[];
    applicationStatus: string | null;
  };
  extraction: {
    timestamp: string;
    sourceUrl: string | null;
    buildId: string | null;
    warnings: string[];
    rawData: Record<string, string>;
  };
  collectedAt: string;
  updatedAt: string;
  schemaVersion: number;
}

export type ApplicantRunState = "idle" | "running" | "stopped" | "completed" | "failed";

export interface ApplicantRunSummary {
  state: ApplicantRunState;
  total: number;
  index: number;
  collected: number;
  failed: number;
  skipped: number;
  currentName: string;
  stopRequested: boolean;
  lastError: string;
  startedAt: string;
  updatedAt: string;
}

/** What the diagnostics download contains. Fields mirror the live checks. */
export interface DiscoveryDiagnostics {
  resultsContainer: string;
  scrollContainer: string;
  scrollContainerFound: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  visibleCards: number;
  linksInScan: number;
  newUrls: number;
  totalUrls: number;
  mutations: number;
  quietScans: number;
  page: number;
  pageUrl: string;
  paginationControl: string;
  paginationClicks: number;
  advertisedTotal: number | null;
  advertisedTotalReliable: boolean;
  /** Reconciliation: every rendered card lands in exactly one of these. */
  cardsSeen: number;
  cardsWithoutUrl: number;
  restrictedCards: number;
  duplicateLinks: number;
  unusableSamples: Array<{ text: string; restricted: boolean }>;
  reconciliation: ReconciliationReport | null;
  stopReason: string;
  scans: Array<Record<string, number>>;
}

/** Why LinkedIn's advertised total and the collected profile URLs differ. */
export interface ReconciliationReport {
  advertisedTotal: number | null;
  totalReliable: boolean;
  uniqueUrls: number;
  duplicateLinks: number;
  cardsWithoutUrl: number;
  restrictedCards: number;
  accountedFor: number;
  unexplained: number | null;
  balanced: boolean;
  explanation: string[];
}

export type AuthState = "signed-in" | "login-required" | "checkpoint" | "unknown";

/**
 * The deterministic collection state machine the worker runs on.
 * Must match COLLECTION_STATE in src/import-queue-core.js exactly.
 */
export type CollectionState =
  | "idle"
  | "opening_connections"
  | "discovering_connections"
  | "connections_complete"
  | "opening_profile_collector"
  | "extracting_profile"
  | "saving_profile"
  | "moving_to_next_profile"
  | "paused_hidden"
  | "paused_challenge"
  | "stopped"
  | "completed"
  | "completed_with_gap"
  | "failed";

export interface AuthVerdict {
  state: AuthState;
  kind: string;
  signedIn: boolean;
  message: string;
}

export type StopReason =
  | ""
  | "queue-complete"
  | "discovery-complete"
  | "user-stopped"
  | "queue-cleared"
  | "challenge"
  | "login-required"
  | "collector-hidden"
  | "navigation-failures"
  | "error"
  | "batch-cooldown";

export type ItemStatus = "pending" | "processing" | "completed" | "failed" | "skipped";
export type SessionStatus = "idle" | "running" | "paused" | "stopped";
export type PausedBy = "" | "user" | "challenge" | "cooldown" | "navigation" | "visibility" | "error";
export type FailureKind = "" | "transient" | "permanent";
export type CoverageState = "unknown" | "in-progress" | "estimated" | "confirmed";
export type SelectionScope = "all" | "selected" | "uncollected" | "failed" | "stale";

export interface QueueItem {
  url: string;
  name: string;
  status: ItemStatus;
  attempts: number;
  addedAt: string;
  updatedAt: string;
  error: string;
  failureKind: FailureKind;
  nextAttemptAt: string;
  profileId: string;
  lastCollectedAt: string;
  fresh: boolean;
}

export interface StartExtractionOptions {
  scope?: SelectionScope;
  urls?: string[];
  refreshMaxAgeDays?: number;
  forceRefresh?: boolean;
  sessionLimit?: number;
  cooldownMs?: number;
}

export interface DiscoveryState {
  cursorY: number;
  passes: number;
  passesWithoutGrowth: number;
  discovered: number;
  totalCount: number | null;
  totalReliable: boolean;
  atBottom: boolean;
  paginationAvailable: boolean;
  paginationClicks: number;
  exhausted: boolean;
  coverageConfirmed: boolean;
  cardsSeen: number;
  cardsWithoutUrl: number;
  restrictedCards: number;
  duplicateLinks: number;
  accountedFor: number;
  gap: number;
  fruitlessPaginationClicks: number;
  stopReason: string;
  lastRunAt: string;
}

export interface CoverageReport {
  discovered: number;
  processed: number;
  remaining: number;
  failed: number;
  skipped: number;
  totalCount: number | null;
  totalReliable: boolean;
  coverage: CoverageState;
  coverageConfirmed: boolean;
  discoveryPasses: number;
  paginationClicks: number;
  paginationAvailable: boolean;
  exhausted: boolean;
  cardsSeen: number;
  /** Cards LinkedIn rendered that carry no usable profile link. */
  cardsWithoutUrl: number;
  restrictedCards: number;
  duplicateLinks: number;
  /** Unique usable URLs + cards that carried no usable URL. */
  accountedFor: number;
  /** Advertised connections no profile URL could be built for. */
  gap: number;
  discoveryStopReason: string;
}

export interface ImportSession {
  key: string;
  status: SessionStatus;
  pausedBy: PausedBy;
  currentUrl: string;
  currentName: string;
  autoDiscover: boolean;
  discoveryExhausted: boolean;
  sessionLimit: number;
  cooldownMs: number;
  cooldownUntil: string;
  batchNumber: number;
  processedInSession: number;
  processedTotal: number;
  navigationFailures: number;
  refreshMaxAgeDays: number;
  forceRefresh: boolean;
  scope: SelectionScope;
  scopeUrls: string[];
  discoveryRunning: boolean;
  collectionState: CollectionState;
  collectionStateAt: string;
  fruitlessDiscoveries: number;
  authState: AuthState;
  authMessage: string;
  startedAt: string;
  updatedAt: string;
  lastError: string;
  pauseReason: string;
  challengeKind: string;
  stopReason: StopReason;
  stopReasonDetail: string;
  discovery: DiscoveryState;
}

export interface ImportSummary {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
  progress: number;
  status: SessionStatus;
  pausedBy: PausedBy;
  currentUrl: string;
  currentName: string;
  autoDiscover: boolean;
  discoveryExhausted: boolean;
  sessionLimit: number;
  cooldownMs: number;
  cooldownUntil: string;
  batchNumber: number;
  processedInSession: number;
  processedTotal: number;
  refreshMaxAgeDays: number;
  forceRefresh: boolean;
  scope: SelectionScope;
  scopeCount: number;
  discoveryRunning: boolean;
  /** The explicit collection state machine; see COLLECTION_STATE. */
  collectionState: CollectionState;
  collectionStateAt: string;
  authState: AuthState;
  authMessage: string;
  lastError: string;
  pauseReason: string;
  challengeKind: string;
  /** The final stop reason, shown verbatim on the importer page. */
  stopReason: StopReason;
  stopReasonDetail: string;
  stopReasonText: string;
  coverage: CoverageReport;
}

export interface ImportStatusResponse {
  ok: boolean;
  summary: ImportSummary;
  items: QueueItem[];
  reconciliation?: ReconciliationReport;
  workflowRunning?: boolean;
  auth?: AuthVerdict;
  error?: string;
}

export interface ChallengeResult {
  challenged: boolean;
  kind: string;
  message: string;
}

export interface ControlVerdict {
  allowed: boolean;
  forbidden: boolean;
  label: string;
  reason: string;
}
