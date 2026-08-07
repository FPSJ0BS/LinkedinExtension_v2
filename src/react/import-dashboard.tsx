import { getAllProfiles } from "../db.js";
import { downloadCsv, downloadJson, filterProfilesByUrls } from "../csv.js";
import {
  PAGE_SIZES,
  SELECTION_SCOPE,
  filterItems,
  pageNumbers,
  paginate,
  selectItemUrls
} from "../import-queue-core.js";
import {
  IMPORT_MESSAGES,
  type AuthVerdict,
  type ImportSummary,
  type QueueItem,
  type ReconciliationReport,
  type SelectionScope
} from "../messages.js";
import { type StatusKind } from "./types.js";

const React: any = (globalThis as any).React;
const ReactDOM: any = (globalThis as any).ReactDOM;

const POLL_INTERVAL_MS = 1500;

const EMPTY_SUMMARY: ImportSummary = {
  total: 0, pending: 0, processing: 0, completed: 0, failed: 0, skipped: 0,
  progress: 0, status: "idle", pausedBy: "", currentUrl: "", currentName: "",
  autoDiscover: true, discoveryExhausted: false, sessionLimit: 100,
  cooldownMs: 90000, cooldownUntil: "", batchNumber: 0, processedInSession: 0,
  processedTotal: 0, refreshMaxAgeDays: 30, forceRefresh: false,
  scope: "all", scopeCount: 0, discoveryRunning: false,
  collectionState: "idle", collectionStateAt: "",
  authState: "unknown", authMessage: "",
  lastError: "", pauseReason: "", challengeKind: "",
  stopReason: "", stopReasonDetail: "", stopReasonText: "",
  coverage: {
    discovered: 0, processed: 0, remaining: 0, failed: 0, skipped: 0,
    totalCount: null, totalReliable: false, coverage: "unknown", coverageConfirmed: false,
    discoveryPasses: 0, paginationClicks: 0, paginationAvailable: false, exhausted: false,
    cardsSeen: 0, cardsWithoutUrl: 0, restrictedCards: 0, duplicateLinks: 0,
    accountedFor: 0, gap: 0, discoveryStopReason: ""
  }
};

/** What each collection state means to the user, in their words. */
/** One label per COLLECTION_STATE in src/import-queue-core.js. */
const COLLECTION_LABELS: Record<string, string> = {
  idle: "Idle",
  opening_connections: "Opening your Connections tab…",
  discovering_connections: "Reading your connections list…",
  connections_complete: "Starting extraction…",
  opening_profile_collector: "Opening the profile collector tab…",
  extracting_profile: "Reading a profile…",
  saving_profile: "Saving a profile…",
  moving_to_next_profile: "Moving to the next profile…",
  paused_hidden: "Paused — collector tab is not visible",
  paused_challenge: "Paused — LinkedIn asked for a check",
  stopped: "Stopped",
  completed: "Completed",
  completed_with_gap: "Completed with a gap",
  failed: "Failed"
};

/** States in which the run is working, so Start must stay disabled. */
const BUSY_COLLECTION_STATES = [
  "opening_connections", "discovering_connections", "connections_complete",
  "opening_profile_collector", "extracting_profile", "saving_profile", "moving_to_next_profile"
];

const AUTH_LABELS: Record<string, string> = {
  "signed-in": "Signed in",
  "login-required": "Login required",
  checkpoint: "Checkpoint detected",
  unknown: "Not checked yet"
};

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" }
];

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  processing: "Collecting…",
  completed: "Collected",
  failed: "Failed",
  skipped: "Skipped"
};

interface ImportState {
  summary: ImportSummary;
  items: QueueItem[];
  reconciliation: ReconciliationReport | null;
  auth: AuthVerdict | null;
  message: string;
  messageKind: StatusKind;
  busy: boolean;
  search: string;
  statusFilter: string;
  page: number;
  pageSize: number;
  scope: SelectionScope;
  selected: string[];
  refreshDays: number;
  /** True once the user edits the refresh window, so polling stops overwriting it. */
  touchedDays: boolean;
}

function sendCommand(type: string, payload: any = {}): Promise<any> {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function shortUrl(url: string): string {
  return String(url || "").replace(/^https:\/\/(?:www\.)?linkedin\.com\/in\//, "");
}

function formatDate(value: string): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

class ImportApp extends React.Component {
  private timer: any = null;

  state: ImportState = {
    summary: EMPTY_SUMMARY,
    items: [],
    reconciliation: null,
    auth: null,
    message: "",
    messageKind: "",
    busy: false,
    search: "",
    statusFilter: "",
    page: 1,
    pageSize: PAGE_SIZES[0],
    scope: "all",
    selected: [],
    refreshDays: 30,
    touchedDays: false
  };

  componentDidMount() {
    this.refresh();
    this.timer = setInterval(this.refresh, POLL_INTERVAL_MS);
  }

  componentWillUnmount() {
    if (this.timer) clearInterval(this.timer);
  }

  refresh = async () => {
    try {
      const response = await sendCommand(IMPORT_MESSAGES.STATUS);
      if (!response?.ok) return;
      this.setState((previous: ImportState) => ({
        summary: response.summary,
        items: response.items || [],
        reconciliation: response.reconciliation || null,
        // The saved setting wins until the user edits it in this page.
        refreshDays: previous.touchedDays ? previous.refreshDays : response.summary.refreshMaxAgeDays
      }));
    } catch {
      // The service worker may be restarting; the next poll picks it up.
    }
  };

  setMessage(message: string, messageKind: StatusKind = "") {
    this.setState({ message, messageKind });
  }

  // ------------------------------------------------------------------ actions

  /**
   * The whole automatic workflow behind one button: check the LinkedIn session,
   * send the collector tab to the Connections page, discover every connection,
   * then start extracting on its own. The service worker runs it detached, so
   * this page and the popup may both be closed while it works.
   */
  startCollecting = async () => {
    this.setState({ busy: true });
    this.setMessage("Checking your LinkedIn session, then opening your Connections page…");
    try {
      const response = await sendCommand(IMPORT_MESSAGES.START_COLLECTING, {
        refreshMaxAgeDays: this.state.refreshDays
      });
      if (response?.ok === false) throw new Error(response.error || "Could not start collecting.");
      this.setMessage(
        "Collecting. Your connections are being discovered first, then extracted one at a time. You can close this page.",
        "success"
      );
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ busy: false });
      this.refresh();
    }
  };

  findAllConnections = async () => {
    this.setMessage("Scanning your whole Connections list. Keep the collector window open — this can take a while.");
    try {
      const response = await sendCommand(IMPORT_MESSAGES.DISCOVER_ALL);
      if (response?.ok === false) throw new Error(response.discoveryError || response.error || "Discovery failed.");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.refresh();
    }
  };

  startExtraction = async () => {
    this.setState({ busy: true });
    this.setMessage("Starting extraction. Profiles are opened one at a time in a single tab.");
    try {
      const response = await sendCommand(IMPORT_MESSAGES.START, {
        scope: this.state.scope,
        urls: this.state.selected,
        refreshMaxAgeDays: this.state.refreshDays
      });
      if (response?.ok === false) throw new Error(response.error || "Could not start extraction.");
      this.setMessage(`Extracting ${response?.selected ?? 0} connection(s). You can close this page — it keeps running.`, "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ busy: false });
      this.refresh();
    }
  };

  stop = async () => {
    this.setState({ busy: true });
    try {
      await sendCommand(IMPORT_MESSAGES.STOP);
      this.setMessage("Stopped. Everything already discovered stays saved.");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ busy: false });
      this.refresh();
    }
  };

  /**
   * Clear Queue stops whatever is running and wipes the discovered list, queue
   * state, counters, and session progress. Profiles already saved to the vault
   * are in a different store and are never touched.
   */
  clearQueue = async () => {
    this.setState({ busy: true });
    try {
      const response = await sendCommand(IMPORT_MESSAGES.CLEAR);
      if (response?.ok === false) throw new Error(response.error || "Could not clear the queue.");
      this.setMessage("Queue cleared and collecting stopped. Your saved profiles were not deleted.", "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ busy: false });
      this.refresh();
    }
  };

  /** Opens LinkedIn's official sign-in page. The extension never sees a password. */
  signIn = async () => {
    try {
      await sendCommand(IMPORT_MESSAGES.OPEN_LOGIN);
      this.setMessage("LinkedIn's sign-in page is open in the collector window. Sign in there, then press Check Login.");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  checkLogin = async () => {
    this.setState({ busy: true });
    this.setMessage("Checking the LinkedIn session in this browser…");
    try {
      const response = await sendCommand(IMPORT_MESSAGES.CHECK_LOGIN);
      const auth: AuthVerdict | null = response?.auth || null;
      this.setState({ auth });
      const label = AUTH_LABELS[auth?.state || "unknown"] || "Not checked yet";
      this.setMessage(`${label}. ${auth?.message || ""}`.trim(), auth?.state === "signed-in" ? "success" : "error");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ busy: false });
      this.refresh();
    }
  };

  retryFailed = async () => {
    this.setState({ busy: true });
    try {
      const response = await sendCommand(IMPORT_MESSAGES.RETRY_FAILED);
      if (response?.ok === false) throw new Error(response.error || "Could not requeue the failed connections.");
      this.setMessage("Failed connections were returned to the queue.", "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ busy: false });
      this.refresh();
    }
  };

  openSavedTable = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  };

  downloadCsvFile = async () => {
    try {
      const { profiles } = await getAllProfiles();
      const response = await sendCommand(IMPORT_MESSAGES.COMPLETED_URLS);
      const collected = filterProfilesByUrls(profiles, response?.urls || []);
      const selected = collected.length ? collected : profiles;
      if (!selected.length) throw new Error("There is nothing to download yet.");
      downloadCsv(selected, collected.length ? "linkedin-connections" : "profile-vault");
      this.setMessage(`Downloading ${selected.length} profile(s).`, "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  /**
   * Live diagnostics for the last discovery pass and the last profile scan.
   *
   * This is the evidence trail for the failures this page exists to avoid: which
   * container was detected as the results list and which one was scrolled, how
   * many scans ran, how many new URLs each one added, how many scans in a row
   * found nothing, whether a pagination control was seen, and why the walk
   * stopped. A one-shot scan, an overwritten accumulator, a wrong scroll
   * container, an early stop, and missed pagination all look different here.
   */
  downloadDiagnostics = async () => {
    try {
      const response = await sendCommand(IMPORT_MESSAGES.DIAGNOSTICS);
      if (response?.ok === false) throw new Error(response.error || "Diagnostics are not available yet.");
      if (!response?.discovery && !response?.profile) {
        throw new Error("Nothing to report yet. Run Find All Connections or extract a profile first.");
      }
      downloadJson(response, "profile-vault-diagnostics");
      this.setMessage("Diagnostics report downloaded.", "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  // ------------------------------------------------------------------ filters

  onSearch = (event: any) => this.setState({ search: event.target.value, page: 1 });
  onStatusFilter = (event: any) => this.setState({ statusFilter: event.target.value, page: 1 });
  onScope = (event: any) => this.setState({ scope: event.target.value });
  onPageSize = (event: any) => this.setState({ pageSize: Number(event.target.value) || PAGE_SIZES[0], page: 1 });
  onRefreshDays = (event: any) => {
    const days = Math.max(0, Math.floor(Number(event.target.value) || 0));
    this.setState({ refreshDays: days, touchedDays: true });
  };
  goToPage = (page: number) => this.setState({ page });

  toggleRow = (url: string) => {
    this.setState((previous: ImportState) => {
      const chosen = previous.selected.filter((value) => value !== url);
      if (chosen.length === previous.selected.length) chosen.push(url);
      return { selected: chosen, scope: "selected" as SelectionScope };
    });
  };

  toggleVisible = (urls: string[], allSelected: boolean) => {
    this.setState((previous: ImportState) => {
      const keep = previous.selected.filter((value) => !urls.includes(value));
      return { selected: allSelected ? keep : [...keep, ...urls], scope: "selected" as SelectionScope };
    });
  };

  clearSelection = () => this.setState({ selected: [], scope: "all" as SelectionScope });

  // ------------------------------------------------------------------- render

  /**
   * One compact session control instead of three competing ones.
   *
   * Signed out shows a single Sign in button; signed in shows a green status
   * with a small Recheck; a checkpoint says so. LinkedIn's own session is used —
   * the extension never sees a credential.
   */
  renderSession(authState: string, message: string) {
    if (authState === "signed-in") {
      return (
        <div className="session signed-in">
          <span className="session-dot" aria-hidden="true" />
          <strong>LinkedIn connected</strong>
          <button className="link-button" type="button" onClick={this.checkLogin}>Recheck</button>
        </div>
      );
    }
    if (authState === "checkpoint") {
      return (
        <div className="session checkpoint" role="status">
          <span className="session-dot" aria-hidden="true" />
          <strong>LinkedIn verification required</strong>
          <button className="link-button" type="button" onClick={this.checkLogin}>Recheck</button>
        </div>
      );
    }
    return (
      <div className="session logged-out" role="status">
        <span className="session-dot" aria-hidden="true" />
        <strong>{authState === "login-required" ? "Login required" : "LinkedIn session not checked"}</strong>
        <button className="secondary small" type="button" onClick={this.signIn}>Sign in to LinkedIn</button>
        <button className="link-button" type="button" onClick={this.checkLogin}>Recheck</button>
        {message ? <span className="session-note">{message}</span> : null}
      </div>
    );
  }

  renderCounts(summary: ImportSummary, selectionCount: number) {
    const coverage = summary.coverage;
    const advertised = coverage.totalCount;
    const tiles = [
      {
        key: "reported",
        label: "LinkedIn reported total",
        value: advertised === null ? "—" : `${advertised}${coverage.totalReliable ? "" : "+"}`,
        hint: advertised !== null && !coverage.totalReliable ? "rounded, cannot confirm coverage" : ""
      },
      { key: "discovered", label: "Total discovered", value: summary.total, hint: coverage.duplicateLinks ? `${coverage.duplicateLinks} duplicate link(s) collapsed` : "" },
      {
        key: "missing",
        label: "Missing / inaccessible",
        value: coverage.cardsWithoutUrl,
        hint: coverage.restrictedCards ? `${coverage.restrictedCards} restricted or unavailable` : ""
      },
      { key: "selected", label: "Selected", value: selectionCount, hint: "" },
      { key: "pending", label: "Pending", value: summary.pending, hint: "" },
      { key: "processing", label: "Processing", value: summary.processing, hint: "" },
      { key: "completed", label: "Completed", value: summary.completed, hint: "" },
      { key: "failed", label: "Failed", value: summary.failed, hint: "" },
      { key: "skipped", label: "Skipped", value: summary.skipped, hint: "" }
    ];
    return (
      <section className="counts-grid" aria-label="Connection counts">
        {tiles.map((tile) => (
          <div className={`count-tile ${tile.key}`} key={tile.key}>
            <b>{tile.value}</b>
            <span>{tile.label}</span>
            {tile.hint ? <em>{tile.hint}</em> : null}
          </div>
        ))}
      </section>
    );
  }

  /**
   * Why LinkedIn's advertised total and the collected list differ — the "67
   * reported, 66 usable" question. An unexplained remainder is called out
   * explicitly, because that is the one case that means discovery stopped early.
   */
  renderReconciliation(reconciliation: ReconciliationReport | null) {
    if (!reconciliation || !reconciliation.explanation.length) return null;
    const unresolved = reconciliation.unexplained !== null && reconciliation.unexplained > 0;
    return (
      <section className={`reconciliation${unresolved ? " unresolved" : ""}`} aria-label="Count reconciliation">
        <h2>Where every connection went</h2>
        <ul>
          {reconciliation.explanation.map((line: string, index: number) => (
            <li key={`why-${index}`}>{line}</li>
          ))}
        </ul>
      </section>
    );
  }

  renderPager(page: number, pages: number, total: number, start: number, end: number) {
    if (!total) return null;
    return (
      <nav className="pager" aria-label="Connection list pages">
        <span className="pager-range">Showing {start}–{end} of {total}</span>
        <div className="pager-buttons">
          <button type="button" className="page-button" disabled={page <= 1} onClick={() => this.goToPage(page - 1)}>
            Previous
          </button>
          {pageNumbers(page, pages).map((value: number, index: number) => (
            value === 0
              ? <span className="page-gap" key={`gap-${index}`}>…</span>
              : (
                <button
                  type="button"
                  key={`page-${value}`}
                  className={`page-button${value === page ? " current" : ""}`}
                  aria-current={value === page ? "page" : undefined}
                  onClick={() => this.goToPage(value)}
                >
                  {value}
                </button>
              )
          ))}
          <button type="button" className="page-button" disabled={page >= pages} onClick={() => this.goToPage(page + 1)}>
            Next
          </button>
        </div>
      </nav>
    );
  }

  renderRows(rows: QueueItem[], selectedSet: any) {
    if (!rows.length) {
      return (
        <tr className="empty-row">
          <td colSpan={6}>No connections match this search or filter yet.</td>
        </tr>
      );
    }
    return rows.map((item) => (
      <tr key={item.url} className={item.status}>
        <td className="pick">
          <input
            type="checkbox"
            checked={selectedSet.has(item.url)}
            aria-label={`Select ${item.name || shortUrl(item.url)}`}
            onChange={() => this.toggleRow(item.url)}
          />
        </td>
        <td className="who">{item.name || shortUrl(item.url)}</td>
        <td className="link">
          <a href={item.url} target="_blank" rel="noreferrer">{shortUrl(item.url)}</a>
        </td>
        <td className="status"><span className={`state ${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span></td>
        <td className="collected">{formatDate(item.lastCollectedAt)}</td>
        <td className="error">{item.error ? <span title={item.error}>{item.error}</span> : ""}</td>
      </tr>
    ));
  }

  render() {
    const { summary, items, reconciliation, auth, message, messageKind, busy, search, statusFilter, pageSize, scope, selected, refreshDays } = this.state;
    const running = summary.status === "running";
    const discovering = summary.discoveryRunning;
    const challenged = summary.pausedBy === "challenge";
    const resting = summary.pausedBy === "cooldown";
    const current = summary.currentName || shortUrl(summary.currentUrl);
    const authState = auth?.state || summary.authState || "unknown";
    const needsLogin = authState === "login-required";
    const collectionState = summary.collectionState || "idle";
    // The state machine, not a pile of booleans, decides whether work is running.
    const working = BUSY_COLLECTION_STATES.indexOf(collectionState) >= 0;
    const hiddenPause = collectionState === "paused_hidden";
    const busyAnywhere = busy || discovering;

    const filtered = filterItems(items, { search, status: statusFilter });
    const view = paginate(filtered, this.state.page, pageSize);
    const selectedSet = new Set(selected);
    const visibleUrls = view.rows.map((item: QueueItem) => item.url);
    const allVisibleSelected = visibleUrls.length > 0 && visibleUrls.every((url: string) => selectedSet.has(url));
    const selectionCount = selectItemUrls(items, {
      scope,
      urls: selected,
      refreshMaxAgeDays: refreshDays,
      now: new Date().toISOString()
    }).length;

    return (
      <main className="import-shell">
        <header className="import-header">
          <h1>My LinkedIn Connections</h1>
        </header>

        <div className="notice info collector-warning" role="note">
          <strong>Keep the collector tab in front.</strong>
          <p>
            Collecting uses two tabs in this window: one Connections tab, then one reusable profile tab that every
            profile is loaded into. <b>LinkedIn stops rendering a tab you switch away from</b>, so the run pauses
            itself the moment the collector tab is hidden and continues as soon as you switch back. Nothing
            half-read is ever saved.
          </p>
        </div>

        {challenged ? (
          <div className="notice stop" role="alert">
            <strong>LinkedIn asked for a check.</strong>
            <p>{summary.pauseReason}</p>
          </div>
        ) : null}

        {needsLogin ? (
          <div className="notice stop" role="alert">
            <strong>Login required.</strong>
            <p>{auth?.message || summary.authMessage}</p>
          </div>
        ) : null}

        {message ? <div className={`notice ${messageKind}`.trim()} role="status">{message}</div> : null}
        {summary.lastError && !message ? <div className="notice error" role="status">{summary.lastError}</div> : null}

        {this.renderSession(authState, needsLogin ? "" : summary.authMessage)}

        <section className="toolbar" aria-label="Connection actions">
          <button className="primary" type="button" disabled={busyAnywhere || working} onClick={this.startCollecting}>
            {working ? COLLECTION_LABELS[collectionState] : "Start Full Collection"}
          </button>
          <button className="primary" type="button" disabled={busyAnywhere || working} onClick={this.findAllConnections}>
            {discovering ? "Discovering connections…" : "Discover Connections Only"}
          </button>
          <button className="primary" type="button" disabled={busyAnywhere || running || !summary.total} onClick={this.startExtraction}>
            Start Profile Extraction
          </button>
          <button className="danger" type="button" disabled={busy || (!running && !resting && !working)} onClick={this.stop}>Stop</button>
          <button className="danger" type="button" disabled={busy || !summary.total} onClick={this.clearQueue}>Clear Queue</button>
          <button className="secondary" type="button" onClick={this.openSavedTable}>Saved Profiles</button>
          <button className="success" type="button" onClick={this.downloadCsvFile}>Download CSV</button>
        </section>

        <details className="advanced">
          <summary>Advanced</summary>
          <div className="advanced-actions">
            <button className="secondary" type="button" disabled={busy || !summary.failed} onClick={this.retryFailed}>Retry Failed</button>
            <button className="secondary" type="button" onClick={this.downloadDiagnostics}>Download Diagnostics</button>
            <button className="secondary" type="button" disabled={busy} onClick={this.checkLogin}>Recheck Login</button>
          </div>
        </details>

        <section className="settings" aria-label="Extraction settings">
          <label className="setting">
            Extract
            <select value={scope} onChange={this.onScope}>
              <option value={SELECTION_SCOPE.ALL}>All connections</option>
              <option value={SELECTION_SCOPE.SELECTED}>Selected connections ({selected.length})</option>
              <option value={SELECTION_SCOPE.UNCOLLECTED}>Connections not collected yet</option>
              <option value={SELECTION_SCOPE.FAILED}>Failed connections</option>
              <option value={SELECTION_SCOPE.STALE}>Not collected within the refresh window</option>
            </select>
          </label>
          <label className="setting">
            Skip if collected within
            <input type="number" min={0} max={3650} value={refreshDays} onChange={this.onRefreshDays} />
            days
          </label>
          {selected.length ? (
            <button className="link-button" type="button" onClick={this.clearSelection}>Clear selection</button>
          ) : null}
        </section>

        {this.renderCounts(summary, selectionCount)}

        {hiddenPause ? (
          <div className="notice stop" role="alert">
            <strong>Collector paused.</strong>
            <p>{summary.pauseReason}</p>
          </div>
        ) : null}

        <section className="progress-block" aria-label="Progress">
          <div className="state-line">
            <span className={`state-pill ${collectionState}`}>{COLLECTION_LABELS[collectionState] || collectionState}</span>
            {summary.coverage.gap > 0 ? (
              <span className="gap-pill" title="Connections LinkedIn advertised that no profile URL exists for">
                {summary.coverage.gap} unresolved
              </span>
            ) : null}
          </div>
          <div className="bar"><div className="bar-fill" style={{ width: `${summary.progress}%` }} /></div>
          <p className="now">
            {discovering ? <span>Finding connections — the whole list is scanned before extraction starts.</span> : null}
            {running && current ? <span>Current profile: <b>{current}</b></span> : null}
            {resting ? <span>Resting between batches — extraction resumes automatically.</span> : null}
            {!running && !resting && !working && summary.total ? (
              <span>{summary.completed} of {summary.total} collected ({summary.progress}%).</span>
            ) : null}
            {!summary.total && !discovering ? <span>Nothing discovered yet. Press <b>Start Full Collection</b> to do everything, or <b>Discover Connections Only</b> to just scan.</span> : null}
          </p>
          {summary.stopReasonText && !running && !discovering ? (
            <p className={`stop-reason ${summary.stopReason}`} role="status">
              <b>Stopped because:</b> {summary.stopReasonText}
            </p>
          ) : null}
        </section>

        {this.renderReconciliation(reconciliation)}

        <section className="list-wrap">
          <div className="list-head">
            <h2>Discovered connections ({filtered.length}{filtered.length === items.length ? "" : ` of ${items.length}`})</h2>
            <div className="list-filters">
              <input
                className="search"
                type="search"
                value={search}
                placeholder="Search by name or profile URL"
                aria-label="Search connections"
                onChange={this.onSearch}
              />
              <select value={statusFilter} onChange={this.onStatusFilter} aria-label="Filter by status">
                {STATUS_FILTERS.map((option) => (
                  <option value={option.value} key={option.value || "any"}>{option.label}</option>
                ))}
              </select>
              <select value={pageSize} onChange={this.onPageSize} aria-label="Rows per page">
                {PAGE_SIZES.map((size: number) => (
                  <option value={size} key={size}>{size} per page</option>
                ))}
              </select>
            </div>
          </div>

          <table className="connection-list">
            <thead>
              <tr>
                <th className="pick">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    aria-label="Select every connection on this page"
                    onChange={() => this.toggleVisible(visibleUrls, allVisibleSelected)}
                  />
                </th>
                <th>Name</th>
                <th>Profile URL</th>
                <th>Status</th>
                <th>Last collected</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>{this.renderRows(view.rows, selectedSet)}</tbody>
          </table>

          {this.renderPager(view.page, view.pages, view.total, view.start, view.end)}
        </section>
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Import root element is missing.");
ReactDOM.render(<ImportApp />, root);
