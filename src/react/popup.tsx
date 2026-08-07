import { findByProfileUrl, saveProfile } from "../db.js";
import { arrayToLines, linesToArray, normalizeProfile, replaceProfile } from "../profile-utils.js";
import { ARRAY_FIELDS, type ProfileRecord, type StatusKind } from "./types.js";
import { APPLICANT_MESSAGES, IMPORT_MESSAGES, STOP_ALL, type ImportSummary } from "../messages.js";

const React: any = (globalThis as any).React;
const ReactDOM: any = (globalThis as any).ReactDOM;
const EXPECTED_BUILD_ID = "2026-08-03-react-v3.7.8";

interface PopupState {
  profile: ProfileRecord | null;
  originalProfile: ProfileRecord | null;
  status: string;
  statusKind: StatusKind;
  loading: boolean;
  saving: boolean;
  diagnostics: any | null;
  buildInfo: string;
  importSummary: ImportSummary | null;
  importBusy: boolean;
  /** Which LinkedIn surface the active tab is on, so the popup offers what fits. */
  surface: "profile" | "applicants" | "other";
  /** How many applicants are stored, shown next to the applicant controls. */
  applicantsStored: number;
  stopping: boolean;
}

const IMPORT_POLL_MS = 2000;

function cooldownText(untilIso: string): string {
  if (!untilIso) return "";
  const remaining = Date.parse(untilIso) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "resuming…";
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function cloneProfile(profile: ProfileRecord): ProfileRecord {
  return JSON.parse(JSON.stringify(profile));
}

function sendTabMessage(tabId: number, message: any, timeout = 4000): Promise<any> {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => setTimeout(() => reject(new Error("The content script did not respond in time.")), timeout))
  ]);
}

async function getActiveTab(): Promise<any> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("No active browser tab was found.");
  if (!/^https:\/\/(?:www\.)?linkedin\.com\/in\//i.test(tab.url || "")) {
    throw new Error("Open a LinkedIn profile URL containing /in/.");
  }
  return tab;
}

async function ping(tabId: number): Promise<any> {
  return sendTabMessage(tabId, { type: "PV_PING" }, 1800);
}

async function ensureContentScript(tab: any): Promise<any> {
  try {
    const response = await ping(tab.id);
    if (response?.ok && response.buildId === EXPECTED_BUILD_ID) return response;
  } catch {
    // The recovery injection below handles absent or stale content scripts.
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/extraction-core.js", "src/connections-core.js", "content.js"]
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    try {
      const response = await ping(tab.id);
      if (response?.ok && response.buildId === EXPECTED_BUILD_ID) return response;
    } catch {
      // Retry a bounded number of times.
    }
  }

  throw new Error("Profile Vault could not connect to this LinkedIn tab. Reload the profile tab once, then try again.");
}

function Field(props: {
  label: string;
  name: string;
  value: string;
  onChange: (name: string, value: string) => void;
  wide?: boolean;
  type?: string;
}) {
  return (
    <label className={props.wide ? "wide" : ""}>
      {props.label}
      <input
        name={props.name}
        type={props.type || "text"}
        value={props.value}
        autoComplete="off"
        onChange={(event: any) => props.onChange(props.name, event.target.value)}
      />
    </label>
  );
}

function TextAreaField(props: {
  label: string;
  name: string;
  value: string;
  onChange: (name: string, value: string) => void;
  rows: number;
  placeholder?: string;
  children?: any;
}) {
  return (
    <label className="wide">
      {props.label}
      <textarea
        name={props.name}
        rows={props.rows}
        value={props.value}
        placeholder={props.placeholder || ""}
        onChange={(event: any) => props.onChange(props.name, event.target.value)}
      />
      {props.children}
    </label>
  );
}

class PopupApp extends React.Component {
  state: PopupState = {
    profile: null,
    originalProfile: null,
    status: "Open a LinkedIn /in/ profile, then extract it.",
    statusKind: "",
    loading: false,
    saving: false,
    diagnostics: null,
    buildInfo: "Visible LinkedIn data only",
    importSummary: null,
    importBusy: false,
    surface: "other",
    applicantsStored: 0,
    stopping: false
  };

  private importTimer: any = null;

  /**
   * Set the instant this popup is on its way out.
   *
   * `window.close()` does not tear the document down synchronously, so every
   * `setState` still queued behind an in-flight promise would run against a
   * component Chrome is dismantling. Nothing writes state once this is set.
   */
  private closing = false;

  componentDidMount() {
    chrome.runtime.sendMessage({ type: "PV_GET_BUILD_INFO" })
      .then((response: any) => {
        if (response?.ok) this.setState({ buildInfo: `Extension ${response.version} · ${response.buildId}` });
      })
      .catch(() => undefined);
    this.detectSurface();
    // Unconditional, because the applicant panel is now always shown: the count
    // beside it has to be right whatever tab the popup was opened over.
    this.refreshApplicants();
    this.refreshImport();
    this.importTimer = setInterval(this.refreshImport, IMPORT_POLL_MS);
  }

  /**
   * Which page the user is actually looking at.
   *
   * The popup is one window onto three surfaces, so it offers the profile
   * controls on a profile and the applicant controls on a hiring page rather
   * than showing every button everywhere. The Stop button is the exception —
   * it is always offered, because "stop" must never depend on being on the
   * right page.
   */
  detectSurface = async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = String(tabs[0]?.url || "");
      const surface = /^https:\/\/(?:www\.)?linkedin\.com\/(?:hiring|talent)\//i.test(url) ? "applicants"
        : /^https:\/\/(?:www\.)?linkedin\.com\/in\//i.test(url) ? "profile"
        : "other";
      this.setState({ surface });
    } catch {
      // A popup opened over a page the extension cannot see is simply "other".
    }
  };

  refreshApplicants = () => {
    chrome.runtime.sendMessage({ type: APPLICANT_MESSAGES.STATUS })
      .then((response: any) => {
        if (this.closing) return;
        if (response?.ok) this.setState({ applicantsStored: Number(response.stored) || 0 });
      })
      .catch(() => undefined);
  };

  componentWillUnmount() {
    if (this.importTimer) clearInterval(this.importTimer);
  }

  /**
   * Dismiss the popup, having first stopped everything that would write to it.
   *
   * The poller is cleared before the close rather than after, because a timer
   * that fires into a closing document is a console error the user cannot act
   * on. Closing the popup never stops the run: the walk lives in the content
   * script and the worker dispatched it before it replied.
   */
  closePopup = () => {
    this.closing = true;
    if (this.importTimer) {
      clearInterval(this.importTimer);
      this.importTimer = null;
    }
    window.close();
  };

  refreshImport = () => {
    chrome.runtime.sendMessage({ type: IMPORT_MESSAGES.STATUS })
      .then((response: any) => {
        if (this.closing) return;
        if (response?.ok) this.setState({ importSummary: response.summary });
      })
      .catch(() => undefined);
  };

  runImport = async (type: string, startedMessage: string, doneMessage: string) => {
    this.setState({ importBusy: true });
    this.setStatus(startedMessage);
    try {
      const response = await chrome.runtime.sendMessage({ type });
      if (response?.ok === false) throw new Error(response.error || "The import command failed.");
      if (response?.summary) this.setState({ importSummary: response.summary });
      this.setStatus(doneMessage, "success");
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ importBusy: false });
      this.refreshImport();
    }
  };

  /**
   * The whole workflow: check the LinkedIn session, redirect the collector tab to
   * the Connections page, discover every connection, then extract them. The
   * service worker runs it detached, so this popup may be closed right away.
   */
  startCollecting = () => this.runImport(
    IMPORT_MESSAGES.START_COLLECTING,
    "Checking your LinkedIn session, then opening your Connections page…",
    "Finding all your connections, then collecting them one at a time. You can close this popup — it keeps running."
  );

  /**
   * The universal Stop.
   *
   * One button that ends everything: a connections discovery pass, the profile
   * queue, an applicant run, and any content script mid-scan. It is always
   * rendered and always enabled — a Stop that only appears once the extension
   * has noticed it is busy is exactly the Stop a user cannot find when they
   * need it, and pressing it when nothing is running is harmless.
   *
   * It never discards anything already collected.
   */
  stopEverything = async () => {
    this.setState({ stopping: true });
    this.setStatus("Stopping everything…");
    try {
      const response = await chrome.runtime.sendMessage({ type: STOP_ALL });
      if (response?.ok === false) throw new Error(response.error || "Stop failed.");
      this.setStatus("Stopped. Everything already collected stays saved.", "success");
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ stopping: false });
      this.refreshImport();
    }
  };

  collectApplicant = () => this.runImport(
    APPLICANT_MESSAGES.COLLECT_CURRENT,
    "Reading the applicant open in this tab…",
    "Collected. Open Job Applicants to review and export."
  );

  /**
   * Collect every applicant on this job, then get out of the recruiter's way.
   *
   * This is the one command that closes the popup itself. The run happens on the
   * hiring tab, which the worker has just activated and focused, so a popup left
   * hanging over it is covering the very thing the user pressed the button to
   * watch.
   *
   * **Closed only once the run has actually started, never before.** The worker
   * answers `{ ok: true, started: true }` only after it has resolved the hiring
   * tab, revealed it, confirmed a matching-build content script answered
   * `PV_APPLICANT_PING`, armed the standing auto-run instruction and dispatched
   * `PV_APPLICANT_EXTRACT_ALL`. Anything short of that — a tab that could not be
   * resolved, a content script that never answered — replies `ok: false`, and
   * then the popup **stays open and shows the error**, because a window that
   * vanishes on failure is a button that silently did nothing.
   *
   * It deliberately does not use `runImport`: that helper is shared with
   * Start Collecting and Collect This Applicant, neither of which should close.
   */
  collectEveryApplicant = () => this.runApplicantJob(
    {},
    "Collecting every applicant on this job, one at a time…"
  );

  /**
   * Every applicant's NAME, across every page, opening nobody.
   *
   * The same command and the same walk, with the panel step not taken — see
   * "The list pass" in CLAUDE.md. It is here as well as on the Applicants page
   * because the popup is what the recruiter has open while they are *on* the
   * hiring tab, which is the one place a list pass is started from.
   */
  collectApplicantList = () => this.runApplicantJob(
    { listOnly: true },
    "Reading the applicant list, page by page…"
  );

  /**
   * Start a whole-job applicant command, then get out of the recruiter's way.
   *
   * These are the commands that close the popup themselves. The run happens on
   * the hiring tab, which the worker has just activated and focused, so a popup
   * left hanging over it is covering the very thing the user pressed the button
   * to watch.
   *
   * **Closed only once the run has actually started, never before.** The worker
   * answers `{ ok: true, started: true }` only after it has resolved the hiring
   * tab, revealed it, confirmed a matching-build content script answered
   * `PV_APPLICANT_PING`, armed the standing auto-run instruction and dispatched
   * `PV_APPLICANT_EXTRACT_ALL`. Anything short of that — a tab that could not be
   * resolved, a content script that never answered — replies `ok: false`, and
   * then the popup **stays open and shows the error**, because a window that
   * vanishes on failure is a button that silently did nothing.
   *
   * It deliberately does not use `runImport`: that helper is shared with
   * Start Collecting and Collect This Applicant, neither of which should close.
   */
  runApplicantJob = async (options: Record<string, unknown>, startedMessage: string) => {
    this.setState({ importBusy: true });
    this.setStatus(startedMessage);
    try {
      const response = await chrome.runtime.sendMessage({ type: APPLICANT_MESSAGES.COLLECT_ALL, options });
      if (response?.ok === false) throw new Error(response.error || "The import command failed.");
      if (response?.started) {
        this.closePopup();
        return;
      }
      // Reached only if the worker ever answers `ok` without `started`. The run
      // is not confirmed, so the popup stays where the user can see it.
      this.setStatus("Running. You can close this popup — each applicant is saved as it finishes.", "success");
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (!this.closing) {
        this.setState({ importBusy: false });
        this.refreshImport();
      }
    }
  };

  /**
   * The applicant controls, always shown.
   *
   * Through 3.7.7 this returned null unless the active tab was already a hiring
   * page, so the section the recruiter came to the popup for was simply absent
   * most of the time. It is now unconditional, and that is safe because the
   * worker does not depend on the popup's tab: `resolveApplicantTab()` finds a
   * live hiring tab in any window, and failing that re-opens the last hiring
   * page the extension was actually on. When it has neither it says so, and the
   * popup shows that message — which is a better answer than a missing panel.
   */
  renderApplicantPanel() {
    const busy = this.state.importBusy;
    return (
      <section className="import-panel" aria-label="Job applicants">
        <div className="import-head">
          <strong>Job applicants</strong>
          <span className="import-pill">{this.state.applicantsStored} saved</span>
        </div>
        <div className="import-actions">
          <button className="primary" type="button" disabled={busy} onClick={this.collectApplicant}>
            Collect This Applicant
          </button>
          <button className="primary" type="button" disabled={busy} onClick={this.collectApplicantList}>
            Collect Applicant List
          </button>
          <button className="primary" type="button" disabled={busy} onClick={this.collectEveryApplicant}>
            Collect Every Applicant
          </button>
          <button className="secondary" type="button" onClick={this.openApplicants}>Review &amp; Export</button>
        </div>
      </section>
    );
  }

  signIn = async () => {
    try {
      await chrome.runtime.sendMessage({ type: IMPORT_MESSAGES.OPEN_LOGIN });
      this.setStatus("LinkedIn's sign-in page is open. Sign in there, then press Start Collecting again.");
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  };

  renderImportPanel() {
    const summary = this.state.importSummary;
    if (!summary) return null;
    const busy = this.state.importBusy;
    const running = summary.status === "running";
    const paused = summary.status === "paused";
    const cooling = paused && summary.pausedBy === "cooldown";
    const challenged = paused && summary.pausedBy === "challenge";
    const discovering = summary.discoveryRunning;
    const needsLogin = summary.authState === "login-required" || summary.challengeKind === "login";
    const label = running ? "Collecting…"
      : discovering ? "Finding connections…"
      : challenged || (summary.completed && summary.pending) ? "Continue Collection"
      : "Start Full Collection";

    return (
      <section className="import-panel" aria-label="All connections">
        <div className="import-head">
          <strong>Connections collector</strong>
          <span className={`import-pill ${summary.status}`}>{summary.status}</span>
        </div>

        {summary.total ? (
          <div className="import-progress">
            <div className="import-track"><div className="import-fill" style={{ width: `${summary.progress}%` }} /></div>
            <span>
              {summary.completed} of {summary.total} collected
              {summary.failed ? ` · ${summary.failed} failed` : ""}
              {summary.pending ? ` · ${summary.pending} left` : ""}
            </span>
          </div>
        ) : null}

        {running && (summary.currentName || summary.currentUrl)
          ? <p className="import-hint current">Now: {summary.currentName || summary.currentUrl}</p>
          : null}
        {cooling ? <p className="import-hint">Cooling down between batches — resumes automatically in {cooldownText(summary.cooldownUntil)}.</p> : null}
        {challenged ? (
          <p className="import-hint warn">
            Paused: {summary.pauseReason} Solve it in the LinkedIn tab yourself, then press Continue extraction.
          </p>
        ) : null}

        <div className="import-actions">
          <button className="primary" type="button" disabled={busy || running || discovering} onClick={this.startCollecting}>
            {label}
          </button>
          {needsLogin ? (
            <button className="secondary" type="button" onClick={this.signIn}>Sign in to LinkedIn</button>
          ) : null}
        </div>
        <p className="import-hint">
          One click opens your Connections page in a dedicated collector window, finds every connection, then collects
          them. Keep that window open and not minimized — collecting continues after you close this popup.
        </p>
      </section>
    );
  }

  setStatus = (status: string, statusKind: StatusKind = "") => {
    if (this.closing) return;
    this.setState({ status, statusKind });
  };

  updateField = (name: string, value: string) => {
    this.setState((previous: PopupState) => {
      if (!previous.profile) return null;
      const profile = { ...previous.profile } as ProfileRecord;
      (profile as any)[name] = ARRAY_FIELDS.has(name) ? linesToArray(value) : value;
      return { profile };
    });
  };

  extractProfile = async () => {
    this.setState({ loading: true });
    this.setStatus("Connecting and reading visible profile sections…");
    try {
      const tab = await getActiveTab();
      const pingResponse = await ensureContentScript(tab);
      const response = await sendTabMessage(tab.id, { type: "PV_EXTRACT", options: { lazyScroll: true } }, 35000);
      if (!response?.ok) throw new Error(response?.error || "Profile extraction failed.");
      const normalized = normalizeProfile(response.profile) as ProfileRecord;
      this.setState({
        profile: cloneProfile(normalized),
        originalProfile: cloneProfile(normalized),
        diagnostics: response.diagnostics || null,
        buildInfo: `Content build ${pingResponse.buildId || "unknown"}`,
        status: "Extraction completed. Review every field before saving.",
        statusKind: "success"
      });
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ loading: false });
    }
  };

  save = async (event: any) => {
    event.preventDefault();
    const current = this.state.profile;
    if (!current) return;
    this.setState({ saving: true });
    try {
      let profile = normalizeProfile(current) as ProfileRecord;
      if (!profile.fullName && !profile.profileUrl) {
        throw new Error("Enter at least a name or profile URL before saving.");
      }
      const existing = await findByProfileUrl(profile.profileUrl);
      if (existing) profile = replaceProfile(existing, profile) as ProfileRecord;
      await saveProfile(profile);
      this.setState({
        profile: null,
        originalProfile: null,
        diagnostics: null,
        status: existing
          ? "Profile updated successfully. Previous saved details were removed and replaced with the new extraction."
          : "Profile saved successfully. The review details were cleared.",
        statusKind: "success"
      });
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ saving: false });
    }
  };

  reset = () => {
    if (!this.state.originalProfile) return;
    this.setState({ profile: cloneProfile(this.state.originalProfile) });
    this.setStatus("Review values reset to the latest extraction.");
  };

  cancel = () => {
    this.setState({ profile: null, originalProfile: null });
    this.setStatus("Review cancelled. No profile was saved.");
  };

  downloadDiagnostics = () => {
    if (!this.state.diagnostics) return;
    const blob = new Blob([JSON.stringify(this.state.diagnostics, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url, filename: `profile-vault-diagnostics-${Date.now()}.json`, saveAs: true },
      () => setTimeout(() => URL.revokeObjectURL(url), 15000)
    );
  };

  openDashboard = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });

  openImport = () => chrome.tabs.create({ url: chrome.runtime.getURL("import.html") });

  openApplicants = () => chrome.tabs.create({ url: chrome.runtime.getURL("applicants.html") });

  renderQuality(profile: ProfileRecord) {
    const missing = profile.missingFields?.length ? ` Missing: ${profile.missingFields.join(", ")}.` : "";
    const partial = profile.partialSections?.length ? ` Partial: ${profile.partialSections.join(", ")}.` : "";
    return `Confidence ${profile.extractionConfidence || 0}%.${missing}${partial}`;
  }

  render() {
    const { profile, status, statusKind, loading, saving, diagnostics, buildInfo, stopping } = this.state;
    const textValue = (key: string): string => String((profile as any)?.[key] ?? "");
    const listValue = (key: string): string => arrayToLines((profile as any)?.[key] || []);

    return (
      <main className="popup-shell">
        <header className="app-header">
          <div>
            <h1>Profile Vault</h1>
            <p>{buildInfo}</p>
          </div>
          <div className="header-buttons">
            <button className="secondary" type="button" onClick={this.openImport}>Connections Collector</button>
            <button className="secondary" type="button" onClick={this.openApplicants}>Job Applicants</button>
            <button className="secondary" type="button" onClick={this.openDashboard}>Saved Profiles</button>
          </div>
        </header>

        {/*
          The universal Stop. Always rendered, always enabled, and never behind
          a state check — the whole point is that it is in the same place
          whatever the extension happens to be doing, including nothing.
        */}
        <button className="stop-all" type="button" disabled={stopping} onClick={this.stopEverything}>
          {stopping ? "Stopping…" : "Stop Everything"}
        </button>

        <div className={`status ${statusKind}`.trim()} role="status">{status}</div>
        <div className="top-actions">
          <button className="primary" type="button" disabled={loading} onClick={this.extractProfile}>
            {loading ? "Extracting…" : "Extract Profile"}
          </button>
          <button className="secondary" type="button" disabled={!diagnostics} onClick={this.downloadDiagnostics}>
            Diagnostics
          </button>
        </div>

        {this.renderApplicantPanel()}
        {this.renderImportPanel()}

        {profile ? (
          <form onSubmit={this.save}>
            <div className="quality">{this.renderQuality(profile)}</div>
            <div className="grid">
              <Field label="Full name" name="fullName" value={textValue("fullName")} onChange={this.updateField} />
              <Field label="Email" name="email" type="email" value={textValue("email")} onChange={this.updateField} />
              <Field label="Mobile number" name="mobile" value={textValue("mobile")} onChange={this.updateField} />
              <Field label="Status" name="status" value={textValue("status")} onChange={this.updateField} />
              <Field label="CV / resume URL" name="cvUrl" type="url" value={textValue("cvUrl")} onChange={this.updateField} wide />
              <Field label="Profile URL" name="profileUrl" type="url" value={textValue("profileUrl")} onChange={this.updateField} wide />
              <TextAreaField
                label="Open to work"
                name="openToWorkDetails"
                rows={5}
                value={listValue("openToWorkDetails")}
                onChange={this.updateField}
                placeholder="One labelled line per field, e.g. Job titles: Software Engineer"
              />
              <TextAreaField
                label="Education"
                name="education"
                rows={4}
                value={listValue("education")}
                onChange={this.updateField}
                placeholder="One institution name per line"
              />
              <TextAreaField label="Skills" name="skills" rows={4} value={listValue("skills")} onChange={this.updateField} placeholder="One skill per line" />
              <TextAreaField label="All email addresses" name="emails" rows={2} value={listValue("emails")} onChange={this.updateField} placeholder="One address per line" />
              <TextAreaField label="All phone numbers" name="phones" rows={2} value={listValue("phones")} onChange={this.updateField} placeholder="One number per line" />
              <TextAreaField label="CV / resume links" name="cvLinks" rows={2} value={listValue("cvLinks")} onChange={this.updateField} placeholder="One link per line" />
              <TextAreaField label="Notes" name="notes" rows={2} value={textValue("notes")} onChange={this.updateField} />
              <TextAreaField label="Tags" name="tags" rows={2} value={listValue("tags")} onChange={this.updateField} placeholder="One tag per line" />
            </div>
            <div className="actions">
              <button type="button" className="secondary" onClick={this.cancel}>Cancel</button>
              <button type="button" className="secondary" onClick={this.reset}>Reset</button>
              <button type="button" className="secondary" disabled={loading} onClick={this.extractProfile}>Re-extract</button>
              <button type="submit" className="primary" disabled={saving}>{saving ? "Saving…" : "Save Profile"}</button>
            </div>
          </form>
        ) : null}
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Popup root element is missing.");
ReactDOM.render(<PopupApp />, root);
