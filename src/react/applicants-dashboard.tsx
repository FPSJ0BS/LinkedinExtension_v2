import { clearApplicants, deleteApplicant, getAllApplicants } from "../applicant-db.js";
import { APPLICANT_TABLE_COLUMNS, downloadApplicantCsv, formatEducation, formatExperience, formatQualification, formatScreening, resumeFile, resumeLink, resumeSummary } from "../applicant-csv.js";
import { downloadJson } from "../csv.js";
import { APPLICANT_MESSAGES, MESSAGING_MESSAGES, STOP_ALL, type ApplicantRecord } from "../messages.js";
import { type StatusKind } from "./types.js";
// The two messaging cores are export-free IIFEs that publish themselves on
// `globalThis`, so they are imported for their side effect exactly the way a
// content script loads them with a <script> tag. An ESM import is evaluated
// before this module's own body, so the globals below are already there.
import "../message-templates-core.js";
import "../template-store.js";

// React 16.0.0 is a global, not an import, and it has no hooks, no Fragments
// and no createRoot. Class components only — see CLAUDE.md.
const React: any = (globalThis as any).React;
const ReactDOM: any = (globalThis as any).ReactDOM;

/** The pure templating engine: the palette, the parser, the preview, the block. */
const Templates: any = (globalThis as any).ProfileVaultMessageTemplates || null;

/**
 * The recruiter's saved templates.
 *
 * `createTemplateStore({})` binds to `chrome.storage.local` at CALL time, so
 * building it here costs nothing and touches no Chrome API until an operation
 * actually runs.
 */
const templateStore: any = (globalThis as any).ProfileVaultTemplateStore
  ? (globalThis as any).ProfileVaultTemplateStore.createTemplateStore({})
  : null;

const PAGE_SIZES = [25, 50];
const POLL_MS = 3000;
/** Long enough to write a real opener without the box swallowing the page. */
const MESSAGE_ROWS = 9;

interface ApplicantsState {
  applicants: ApplicantRecord[];
  search: string;
  jobFilter: string;
  statusFilter: string;
  resumeFilter: string;
  pageSize: number;
  currentPage: number;
  selectedIds: string[];
  details: ApplicantRecord | null;
  message: string;
  messageKind: StatusKind;
  busy: boolean;
  runningLabel: string;
  /** Off by default: a run resumes rather than repeating what it already has. */
  recollect: boolean;

  // ------------------------------------------------------------- messaging
  // One applicant at a time, always. There is no multi-select here and no
  // list-wide action: `messageTargetId` holds exactly one record id, the
  // probe answers for exactly that person, and one insertion is sent per
  // press. A "message everyone on this page" control is out of scope by
  // design, not by omission.
  messagingOpen: boolean;
  templates: MessageTemplate[];
  /** "" while a one-off message is being written, which is a body with no template. */
  templateId: string;
  templateName: string;
  messageBody: string;
  templateProblems: TemplateProblem[];
  confirmDeleteId: string;
  messageTargetId: string;
  probe: ComposerProbe | null;
  probing: boolean;
  inserting: boolean;
  messagingStatus: string;
  messagingStatusKind: StatusKind;
}

/** One stored template, as `ProfileVaultTemplateStore` hands it back. */
interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** One refusal from `validateTemplate`, shown against the field that caused it. */
interface TemplateProblem {
  field: string;
  code: string;
  message: string;
}

/** What the hiring page reports about the control the composer is reached by. */
interface ComposerControl {
  found?: boolean;
  label?: string;
  allowed?: boolean;
  reason?: string;
}

/** The observation-only answer to `MESSAGING_MESSAGES.PROBE`. Presses nothing. */
interface ComposerProbe {
  ok?: boolean;
  panel?: boolean;
  panelMatches?: boolean;
  panelReason?: string;
  identity?: Record<string, unknown> | null;
  control?: ComposerControl | null;
  composerOpen?: boolean;
  composerEmpty?: boolean;
  reason?: string;
  error?: string;
}

/**
 * A reason code, said the way a recruiter would say it.
 *
 * Every one of these is a state of somebody else's page, not a fault in the
 * message — so each sentence names the thing to go and do rather than the code
 * that was returned. An unmapped code is quoted verbatim instead of being
 * smoothed into a guess: a wrong explanation is worse than an awkward one.
 */
function reasonSentence(reason: string, who: string): string {
  const person = who || "that applicant";
  switch (reason) {
    case "inserted":
      return `The message is in LinkedIn's composer for ${person}.`;
    case "panel-shows-other-applicant":
      return `The hiring page is showing a different applicant. Open ${person} there first.`;
    case "no-panel":
      return "Open the applicant on the hiring page first.";
    case "composer-not-empty":
      return "There's already text in the composer — clear it or send it first.";
    case "different-recipient":
      return "The composer is addressed to someone else.";
    case "no-message-control":
      return "No Message button was found on that applicant's panel.";
    case "read-back-mismatch":
      return "The text didn't land correctly. Check the composer before sending.";
    case "control-not-allowed":
      return "The only control on that panel is one this extension is not allowed to press.";
    case "no-hiring-tab":
      return "No LinkedIn hiring tab is open. Open your job's Applicants page and try again.";
    case "":
      return "";
    default:
      return `The hiring page answered "${reason}".`;
  }
}

/** `{{name}}`, built rather than typed, so a brace can never go missing. */
function tokenFor(name: string): string {
  return `{{${name}}}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `problems` array a refused save carries, never the raw exception.
 *
 * `templateStore.save` throws an Error with `error.problems` on it, one entry
 * per thing wrong, precisely so the form can show all of them at once beside
 * the fields that caused them — a recruiter fixing three problems one refusal
 * at a time gives up on the third.
 */
function problemsOf(error: unknown): TemplateProblem[] {
  const raw = (error as any)?.problems;
  if (!Array.isArray(raw)) return [];
  return raw.filter(Boolean).map((problem: any) => ({
    field: String(problem?.field ?? ""),
    code: String(problem?.code ?? ""),
    message: String(problem?.message || problem?.code || "The template was refused.")
  }));
}

function formatDate(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "—";
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : text;
}

/** Anything absent shows as an em dash rather than as an empty cell. */
function show(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "—";
}

function send(type: string, payload: Record<string, unknown> = {}): Promise<any> {
  return chrome.runtime.sendMessage({ type, ...payload });
}


function matchesSearch(record: ApplicantRecord, term: string): boolean {
  if (!term) return true;
  const haystack = [
    record.applicant.name,
    record.applicant.headline,
    record.applicant.location,
    record.applicant.currentRole,
    record.applicant.currentCompany,
    record.applicant.contact.email,
    record.applicant.contact.phone,
    record.job.title,
    ...record.applicant.skills
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(term.toLowerCase());
}

/** A labelled block in the details drawer. Empty sections are not rendered. */
function DetailsSection(props: { title: string; items: string[] }) {
  if (!props.items.length) return null;
  return (
    <section className="details-section">
      <h3>{props.title}</h3>
      <ul className="details-list">
        {props.items.map((item: string, index: number) => <li key={`${index}-${item}`}>{item}</li>)}
      </ul>
    </section>
  );
}

function Fact(props: { label: string; value: string; href?: string | null }) {
  return (
    <div className="fact">
      <dt>{props.label}</dt>
      <dd>{props.href ? <a href={props.href} target="_blank" rel="noreferrer">{props.value}</a> : props.value}</dd>
    </div>
  );
}

class ApplicantsApp extends React.Component {
  state: ApplicantsState = {
    applicants: [],
    search: "",
    jobFilter: "all",
    statusFilter: "all",
    resumeFilter: "all",
    pageSize: PAGE_SIZES[0],
    currentPage: 1,
    selectedIds: [],
    details: null,
    message: "",
    messageKind: "",
    busy: false,
    runningLabel: "",
    recollect: false,
    messagingOpen: false,
    templates: [],
    templateId: "",
    templateName: "",
    messageBody: "",
    templateProblems: [],
    confirmDeleteId: "",
    messageTargetId: "",
    probe: null,
    probing: false,
    inserting: false,
    messagingStatus: "",
    messagingStatusKind: ""
  };

  private timer: any = null;

  /**
   * The compose box itself, so a palette press can put the token where the
   * cursor is rather than at the end. React 16.0.0 predates `createRef`, so
   * this is a callback ref — the only kind that runtime has.
   */
  private bodyBox: any = null;

  /**
   * The order the rows are shown in, held steady for as long as the page is open.
   *
   * The store's own order is stable per record since the sort key became
   * `collectedAt` (see `getAllApplicants`), which stops rows swapping *places*
   * with each other. This is the other half: a run collects people while the
   * recruiter is reading the table, and every new arrival sorts above the rows
   * already on screen, so each three-second poll pushed the whole table down by
   * one. A row that moves because somebody else arrived is still a row that
   * moved.
   *
   * So a row's position is decided once — the first poll that sees it — and
   * never revised. Newcomers are appended at the end, where they disturb
   * nothing. **Refresh re-sorts**, which is what makes this a hold rather than a
   * freeze: the newest-first order is one button away and is what a reload gives.
   */
  private displayOrder: string[] = [];

  componentDidMount() {
    this.load();
    // Templates are read ONCE, not polled: they are the recruiter's own config
    // and nothing else writes them, so re-reading them every three seconds
    // would only risk overwriting the box they are typing in.
    this.readTemplates();
    // A run streams each applicant to storage as it finishes, so the table
    // fills in while the recruiter watches rather than only at the end.
    this.timer = setInterval(this.load, POLL_MS);
  }

  componentWillUnmount() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * The store's records, in the order already on screen.
   *
   * Ids the table is already showing keep their positions, in their existing
   * relative order; anything the store has that the table does not is appended.
   * Deletions fall out on their own, because an id with no record is skipped
   * rather than carried forward — so the order never grows stale entries.
   */
  stabilize(records: ApplicantRecord[]): ApplicantRecord[] {
    const byId = new Map<string, ApplicantRecord>();
    for (const record of records) byId.set(record.id, record);

    const order: string[] = [];
    for (const id of this.displayOrder) if (byId.has(id)) order.push(id);
    const placed = new Set(order);
    for (const record of records) if (!placed.has(record.id)) order.push(record.id);

    this.displayOrder = order;
    return order.map((id) => byId.get(id) as ApplicantRecord);
  }

  load = async () => {
    try {
      const applicants = await getAllApplicants();
      this.setState({ applicants: this.stabilize(applicants) });
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  /**
   * Re-read the store AND re-sort it, which a poll deliberately never does.
   * This is the way back to newest-first once a run has appended to the table.
   */
  refresh = () => {
    this.displayOrder = [];
    this.load();
  };

  setMessage = (message: string, messageKind: StatusKind = "") => this.setState({ message, messageKind });

  command = async (type: string, startedMessage: string, doneMessage: string, payload: Record<string, unknown> = {}) => {
    this.setState({ busy: true, runningLabel: startedMessage });
    this.setMessage(startedMessage);
    try {
      const response = await send(type, payload);
      if (response?.ok === false) throw new Error(response.error || "The command failed.");
      this.setMessage(doneMessage, "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.setState({ busy: false, runningLabel: "" });
      this.load();
    }
  };

  collectCurrent = () => this.command(
    APPLICANT_MESSAGES.COLLECT_CURRENT,
    "Reading the applicant open in your LinkedIn tab…",
    "Collected. The row is in the table below."
  );

  /**
   * Why a column came back empty, from the page it was read on.
   *
   * The one report that answers "the layout reads wrong" without a live
   * debugging session. `sectionScan` lists every heading the panel and the page
   * rendered with the key each one resolved to, and a heading listed with an
   * EMPTY key is a wording the section table does not know yet — which is the
   * whole of the "current_role and current_company are empty on every row"
   * failure mode, in one line. Beside it: which sections nothing named, which
   * ones only BOUND the others, where each was found, how many cards came out of
   * it, the markup it was read from, the layout verdict, the reader order, and
   * the contact, resume and scroll walks.
   *
   * Deliberately not disabled when there is nothing yet: the worker's answer
   * says so in words, and a control that is greyed out for a reason the page
   * cannot explain is worse than one that answers "nothing to report".
   */
  downloadDiagnostics = async () => {
    try {
      const response = await send(APPLICANT_MESSAGES.DIAGNOSTICS);
      if (response?.ok === false) throw new Error(response.error || "Diagnostics are not available yet.");
      if (!response?.applicant) {
        throw new Error("Nothing to report yet. Collect an applicant first, then try again.");
      }
      downloadJson(response, "profile-vault-applicant-diagnostics");
      this.setMessage("Diagnostics report downloaded.", "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  /**
   * The open applicant's LAYOUT, with nobody's details in it.
   *
   * What to press when a column reads wrong on a screen this extension has not
   * seen before. It reads the panel that is already open and reports what the
   * readers would see — every heading and the key it resolved to, the header
   * window, the lines each section handed its parser, which labels the page
   * renders, and the KIND of each link. Read-only: no click, no scroll, nothing
   * saved.
   *
   * Every name becomes `Person A` / `Company A` / `University A`, consistently
   * within one capture so the corroboration the name reader depends on is still
   * exercised; every address, phone number, token and credential is taken out;
   * the wordings stay, because the wordings are the thing being reported.
   */
  captureUi = async () => {
    try {
      const response = await send(APPLICANT_MESSAGES.CAPTURE_UI, { name: "applicant-ui" });
      if (response?.ok === false) throw new Error(response.error || "The applicant UI could not be captured.");
      if (!response?.capture) throw new Error("Nothing to capture. Open an applicant in your LinkedIn tab first.");
      downloadJson(response.capture, "profile-vault-applicant-ui");
      this.setMessage("Captured. The file names no one — send it with a note about which column read wrong.", "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  /**
   * Every applicant on this job, one at a time, across every page.
   *
   * **The whole-job command, and since 3.7.13 the only one.** Collect Every
   * Applicant rode this same `COLLECT_ALL` message, this same walk and this same
   * pagination, differing only in the `listOnly` flag — and by then this pass
   * opened each applicant, walked their panel to the bottom, disclosed their
   * contact details and saved their resume anyway, so the two commands did the
   * same work under two names. The flag still travels with the armed options
   * rather than being dropped, so a run armed by the previous build resumes as
   * what it is instead of falling into a branch that no longer exists.
   *
   * `recollect` travels with it too. It is a property of a *run* — "walk past
   * the people already saved, or open them again" — and never belonged to one
   * button; unchecked it sends `false`, which is the walk's own default.
   */
  collectList = () => this.command(
    APPLICANT_MESSAGES.COLLECT_ALL,
    this.state.recollect
      ? "Reading the applicant list again, page by page, including the ones already saved…"
      : "Reading the applicant list, page by page…",
    "Running. Each applicant is saved as they are read — you can close this page.",
    { options: { listOnly: true, recollect: this.state.recollect } }
  );

  stopEverything = () => this.command(
    STOP_ALL,
    "Stopping…",
    "Stopped. Everything already collected stays saved."
  );

  filtered(): ApplicantRecord[] {
    const { applicants, search, jobFilter, statusFilter, resumeFilter } = this.state;
    return applicants.filter((record) => {
      if (!matchesSearch(record, search)) return false;
      if (jobFilter !== "all" && String(record.job.id || record.job.title || "") !== jobFilter) return false;
      if (statusFilter !== "all" && String(record.applicant.applicationStatus || "") !== statusFilter) return false;
      if (resumeFilter === "with" && !record.applicant.resume.available) return false;
      if (resumeFilter === "without" && record.applicant.resume.available) return false;
      if (resumeFilter === "saved" && record.applicant.resume.downloadStatus !== "downloaded") return false;
      return true;
    });
  }

  jobs(): Array<{ value: string; label: string; count: number }> {
    const groups = new Map<string, { value: string; label: string; count: number }>();
    for (const record of this.state.applicants) {
      const value = String(record.job.id || record.job.title || "");
      if (!value) continue;
      if (!groups.has(value)) groups.set(value, { value, label: record.job.title || value, count: 0 });
      (groups.get(value) as any).count += 1;
    }
    return [...groups.values()];
  }

  statuses(): string[] {
    const found = new Set<string>();
    for (const record of this.state.applicants) {
      const status = String(record.applicant.applicationStatus || "");
      if (status) found.add(status);
    }
    return [...found];
  }

  selectedApplicants(): ApplicantRecord[] {
    const wanted = new Set(this.state.selectedIds);
    return this.state.applicants.filter((record) => wanted.has(record.id));
  }

  toggleSelected = (id: string) => {
    this.setState((previous: ApplicantsState) => ({
      selectedIds: previous.selectedIds.includes(id)
        ? previous.selectedIds.filter((value) => value !== id)
        : [...previous.selectedIds, id]
    }));
  };

  toggleAllOnPage = (ids: string[], allSelected: boolean) => {
    this.setState((previous: ApplicantsState) => ({
      selectedIds: allSelected
        ? previous.selectedIds.filter((id) => !ids.includes(id))
        : [...new Set([...previous.selectedIds, ...ids])]
    }));
  };

  exportCsv = (records: ApplicantRecord[], what: string) => {
    try {
      downloadApplicantCsv(records);
      this.setMessage(`Downloading ${records.length} ${what}.`, "success");
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  removeApplicant = async (record: ApplicantRecord) => {
    try {
      await deleteApplicant(record.id);
      this.setMessage(`Removed ${record.applicant.name || "the applicant"}.`, "success");
      this.setState({ details: null });
      this.load();
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  clearAll = async () => {
    try {
      await clearApplicants();
      this.setState({ selectedIds: [], details: null });
      this.setMessage("Every collected applicant was removed. Saved profiles were not touched.", "success");
      this.load();
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  // ======================================================================
  // Messaging — one applicant, one message, and the human presses Enter
  // ======================================================================
  //
  // THE ONE RULE THIS SECTION EXISTS FOR. `previewTemplate` returns `blocked`,
  // and nothing in this file may argue with it. A message reading "Hi ," is not
  // a cosmetic defect: it is the extension speaking in the recruiter's name and
  // getting the person wrong, in front of that person. So a blocked preview
  // disables Insert, says which variables went unresolved or unknown, and never
  // substitutes a stand-in like "[name]" or "there" for a value the record does
  // not hold — rule 1, at the one place where a blank would reach a human.
  //
  // AND THIS EXTENSION NEVER SENDS. There is no Send control here, no queue and
  // no bulk anything. The text lands in LinkedIn's own composer and stops; the
  // recruiter reads it and presses Enter themselves.

  setMessagingStatus = (messagingStatus: string, messagingStatusKind: StatusKind = "") =>
    this.setState({ messagingStatus, messagingStatusKind });

  /** Newest first, straight from the store. An unreadable store reads as empty. */
  readTemplates = async () => {
    if (!templateStore) return;
    try {
      const templates = await templateStore.list();
      this.setState({ templates });
    } catch (error) {
      this.setMessagingStatus(errorText(error), "error");
    }
  };

  /** The one applicant this message is for, or null while nobody is picked. */
  messageTarget(): ApplicantRecord | null {
    const wanted = this.state.messageTargetId;
    if (!wanted) return null;
    return this.state.applicants.find((record) => record.id === wanted) || null;
  }

  /** The three fields a probe or an insertion names its person by. */
  messageRecipient(record: ApplicantRecord) {
    return {
      name: record.applicant.name || "",
      profileUrl: record.applicant.profileUrl || null,
      applicationId: record.applicationId || null
    };
  }

  /**
   * The message as it would actually be inserted, rendered against the picked
   * applicant's OWN collected record — never against the palette's examples.
   */
  preview(): any {
    if (!Templates) return null;
    const record = this.messageTarget();
    return Templates.previewTemplate({
      body: this.state.messageBody,
      applicant: record ? record.applicant : null,
      job: record ? record.job : null
    });
  }

  problemsFor(field: string): TemplateProblem[] {
    return this.state.templateProblems.filter((problem) => problem.field === field);
  }

  /** A fresh applicant, a fresh body or a fresh template invalidates the probe. */
  composeChanged(next: Record<string, unknown>) {
    this.setState({ ...next, probe: null });
  }

  pickMessageTarget = (id: string) => {
    this.composeChanged({ messageTargetId: id });
    const record = this.state.applicants.find((entry) => entry.id === id) || null;
    this.setMessagingStatus(record
      ? `Composing for ${record.applicant.name || "this applicant"}. Open them on the hiring page, then check it.`
      : "");
  };

  /** The row's own Message button: pick that person and open the panel. */
  messageApplicant = (record: ApplicantRecord) => {
    this.setState({ messagingOpen: true, messageTargetId: record.id, probe: null }, () => {
      const panel = document.getElementById("messaging");
      if (panel && typeof panel.scrollIntoView === "function") panel.scrollIntoView({ block: "start" });
    });
    this.setMessagingStatus(
      `Composing for ${record.applicant.name || "this applicant"}. Open them on the hiring page, then check it.`
    );
  };

  useTemplate = (template: MessageTemplate) => {
    this.setState({
      templateId: template.id,
      templateName: template.name,
      messageBody: template.body,
      templateProblems: [],
      confirmDeleteId: "",
      probe: null
    });
    this.setMessagingStatus(`Composing from "${template.name}".`);
  };

  /** A one-off message is just a body with no template behind it. */
  startCustomMessage = () => {
    this.setState({
      templateId: "",
      templateName: "",
      messageBody: "",
      templateProblems: [],
      confirmDeleteId: "",
      probe: null
    });
    this.setMessagingStatus("Writing a one-off message. Give it a name to keep it as a template.");
  };

  /**
   * Create when `asNew`, update the picked template otherwise.
   *
   * The store validates and THROWS with a `problems` array on the error, which
   * is rendered inline against the name or the body. A raw exception string is
   * never shown: "name_duplicate" tells the recruiter nothing they can act on.
   */
  saveTemplate = async (asNew: boolean) => {
    if (!templateStore) {
      this.setMessagingStatus("Templates cannot be saved — the template store did not load.", "error");
      return;
    }
    try {
      const saved = await templateStore.save({
        id: asNew ? undefined : (this.state.templateId || undefined),
        name: this.state.templateName,
        body: this.state.messageBody
      });
      await this.readTemplates();
      this.setState({ templateId: saved.id, templateName: saved.name, templateProblems: [] });
      this.setMessagingStatus(`Saved "${saved.name}".`, "success");
    } catch (error) {
      const problems = problemsOf(error);
      this.setState({ templateProblems: problems });
      this.setMessagingStatus(
        problems.length ? "The template was not saved — see the notes beside the fields." : errorText(error),
        "error"
      );
    }
  };

  duplicateTemplate = async (template: MessageTemplate) => {
    if (!templateStore) return;
    try {
      const copy = await templateStore.duplicate(template.id);
      await this.readTemplates();
      this.setMessagingStatus(`Copied "${template.name}" to "${copy.name}".`, "success");
    } catch (error) {
      this.setMessagingStatus(errorText(error), "error");
    }
  };

  /** Only ever reached from the inline confirmation below, never from one press. */
  removeTemplate = async (template: MessageTemplate) => {
    if (!templateStore) return;
    try {
      await templateStore.remove(template.id);
      const wasOpen = this.state.templateId === template.id;
      await this.readTemplates();
      this.setState({
        confirmDeleteId: "",
        templateId: wasOpen ? "" : this.state.templateId
      });
      this.setMessagingStatus(`Deleted "${template.name}". The message in the box was left alone.`, "success");
    } catch (error) {
      this.setMessagingStatus(errorText(error), "error");
    }
  };

  /** Put the token where the cursor is, and leave the cursor after it. */
  insertToken = (token: string) => {
    const node = this.bodyBox;
    const body = this.state.messageBody;
    const start = node && typeof node.selectionStart === "number" ? node.selectionStart : body.length;
    const end = node && typeof node.selectionEnd === "number" ? node.selectionEnd : body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    this.setState({ messageBody: next, probe: null }, () => {
      if (!node || typeof node.setSelectionRange !== "function") return;
      const at = start + token.length;
      node.focus();
      node.setSelectionRange(at, at);
    });
  };

  /**
   * What the hiring page would find, without pressing anything.
   *
   * Asked BEFORE Insert is ever enabled, because the panel is a page this
   * extension does not own: LinkedIn routes ahead of the render, so the address
   * bar can already name this applicant while the panel still shows the last
   * one. `panelMatches: false` is that exact case and it is the whole reason
   * this step exists.
   */
  probeComposer = async () => {
    const record = this.messageTarget();
    if (!record) {
      this.setMessagingStatus("Pick the applicant this message is for first.", "error");
      return;
    }
    this.setState({ probing: true });
    try {
      const response = await send(MESSAGING_MESSAGES.PROBE, { applicant: this.messageRecipient(record) });
      this.setState({ probe: (response || null) as ComposerProbe | null });
      const who = record.applicant.name || "this applicant";
      if (response?.ok === false) {
        this.setMessagingStatus(reasonSentence(String(response?.reason || ""), who) || "The hiring page could not be read.", "error");
      } else {
        this.setMessagingStatus("");
      }
    } catch (error) {
      this.setState({ probe: null });
      this.setMessagingStatus(errorText(error), "error");
    } finally {
      this.setState({ probing: false });
    }
  };

  /** Everything the probe said, in sentences, worst thing first. */
  probeReport(record: ApplicantRecord | null): string[] {
    const probe = this.state.probe;
    if (!probe) return [];
    const who = record ? (record.applicant.name || "that applicant") : "that applicant";
    if (probe.ok === false) {
      return [reasonSentence(String(probe.reason || probe.panelReason || ""), who) || "The hiring page could not be read."];
    }

    const lines: string[] = [];
    if (probe.panelMatches === false) lines.push(reasonSentence("panel-shows-other-applicant", who));
    else if (!probe.panel) lines.push(reasonSentence(probe.panelReason || "no-panel", who));

    const control = probe.control;
    if (!control || !control.found) lines.push(reasonSentence("no-message-control", who));
    else if (!control.allowed) lines.push(reasonSentence(control.reason || "control-not-allowed", who));

    if (probe.composerOpen && probe.composerEmpty === false) lines.push(reasonSentence("composer-not-empty", who));

    if (!lines.length) {
      lines.push(`The hiring page is showing ${who}, and the composer can be reached. Insert is ready.`);
    }
    return lines.filter(Boolean);
  }

  /** Insert stays shut until every one of these is true. */
  composerReady(): boolean {
    const probe = this.state.probe;
    if (!probe || probe.ok === false) return false;
    if (!probe.panel || probe.panelMatches === false) return false;
    if (probe.composerOpen && probe.composerEmpty === false) return false;
    const control = probe.control;
    const reachable = Boolean(control && control.found && control.allowed);
    return reachable || Boolean(probe.composerOpen && probe.composerEmpty !== false);
  }

  /**
   * Type the reviewed text into LinkedIn's composer, and stop there.
   *
   * The three guards are re-asserted here rather than trusted to the disabled
   * attribute, because a disabled button is a hint and this is the boundary: a
   * blocked message must be impossible to insert, not merely awkward to.
   */
  insertMessage = async () => {
    const record = this.messageTarget();
    const preview = this.preview();
    const who = record ? (record.applicant.name || "this applicant") : "this applicant";

    if (!record) {
      this.setMessagingStatus("Pick the applicant this message is for first.", "error");
      return;
    }
    if (!preview || preview.blocked) {
      this.setMessagingStatus("This message is blocked, so nothing was inserted.", "error");
      return;
    }
    if (!this.composerReady()) {
      this.setMessagingStatus("Check the hiring page first — Insert stays closed until the panel is showing this applicant.", "error");
      return;
    }

    this.setState({ inserting: true });
    try {
      const response = await send(MESSAGING_MESSAGES.INSERT, {
        applicant: this.messageRecipient(record),
        text: preview.text
      });
      if (response?.inserted) {
        // Re-probe before the next one: the panel moves on, and a stale "ready"
        // is how a message reaches the wrong person.
        this.setState({ probe: null });
        this.setMessagingStatus(
          `The message is now in LinkedIn's composer for ${who}. Read it there and press Enter yourself to send it — this extension does not send anything.`,
          "success"
        );
      } else {
        this.setMessagingStatus(
          reasonSentence(String(response?.reason || ""), who) || "The message was not inserted.",
          "error"
        );
      }
    } catch (error) {
      this.setMessagingStatus(errorText(error), "error");
    } finally {
      this.setState({ inserting: false });
    }
  };

  renderToolbar(total: number) {
    const { busy, search, jobFilter, statusFilter, resumeFilter, pageSize, recollect } = this.state;
    const selected = this.state.selectedIds.length;
    return (
      <div>
        <section className="toolbar primary-actions">
          <button className="primary" type="button" disabled={busy} onClick={this.collectCurrent}>
            Collect This Applicant
          </button>
          {/*
            The whole-job command. "Collect Every Applicant" stood beside it
            until 3.7.13 and was removed there: it sent the same message and ran
            the same walk, and once this pass began opening each applicant,
            disclosing their contact details and saving their resume, the two
            buttons did the same work under two names.
          */}
          <button className="primary" type="button" disabled={busy} onClick={this.collectList}>
            Collect Applicant List
          </button>
          <button className="danger" type="button" onClick={this.stopEverything}>Stop</button>
          <button className="success" type="button" onClick={() => this.exportCsv(this.filtered(), "applicant(s)")}>
            Download CSV
          </button>
          <button
            className="secondary"
            type="button"
            disabled={!selected}
            onClick={() => this.exportCsv(this.selectedApplicants(), "selected applicant(s)")}
          >
            Download Selected{selected ? ` (${selected})` : ""}
          </button>
          {/*
            The report that makes an empty column explicable without a live
            debugging session. The worker has answered PV_APPLICANT_DIAGNOSTICS
            since 3.6, and nothing has ever sent it — CLAUDE.md carried it as a
            known issue. It is the most useful control on this page when a
            layout reads wrong: `sectionScan.headings[]` names every heading the
            panel rendered with the key it resolved to, and an EMPTY key is a
            wording the section table does not know yet, which is the whole of
            the "current_role and current_company are empty on every row"
            failure, stated in one line.

            JSON, never a CSV column: rule 19 says append columns and never
            reorder, and a diagnostics blob is not a column at all.
          */}
          <button className="secondary" type="button" onClick={this.downloadDiagnostics}>
            Download Diagnostics
          </button>
          {/*
            And the one to send when a layout reads wrong. Read-only — no click,
            no scroll, nothing saved — and every name replaced by a stable
            pseudonym, every address reduced to what KIND of destination it had,
            every number, token and credential taken out. What survives is the
            wordings, which are the whole point: a heading this extension does
            not recognise is what empties a column, and this is how one becomes a
            fixture.
          */}
          <button className="secondary" type="button" onClick={this.captureUi}>
            Capture Current Applicant UI
          </button>
          <button className="secondary" type="button" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") })}>
            Saved Profiles
          </button>
          {/*
            A run resumes by default — it walks past anyone already saved for
            this job without opening them. This is how to ask for the whole
            list again anyway, after a fix or a LinkedIn layout change. It
            modifies the run, not any one button, which is why it outlived the
            command it was first added beside.
          */}
          <label className="inline" title="Read every applicant again, including the ones already saved">
            <input
              type="checkbox"
              checked={recollect}
              onChange={(event: any) => this.setState({ recollect: Boolean(event.target.checked) })}
            />
            Re-collect already saved
          </label>
        </section>

        <section className="toolbar">
          <input
            type="search"
            placeholder="Search name, email, job, company or skill"
            value={search}
            onChange={(event: any) => this.setState({ search: event.target.value, currentPage: 1 })}
          />
          <label className="inline">
            Filter by job
            <select value={jobFilter} onChange={(event: any) => this.setState({ jobFilter: event.target.value, currentPage: 1 })}>
              <option value="all">All jobs</option>
              {this.jobs().map((job) => (
                <option key={job.value} value={job.value}>{job.label} ({job.count})</option>
              ))}
            </select>
          </label>
          <label className="inline">
            Filter by status
            <select value={statusFilter} onChange={(event: any) => this.setState({ statusFilter: event.target.value, currentPage: 1 })}>
              <option value="all">Any status</option>
              {this.statuses().map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          <label className="inline">
            Filter by resume
            <select value={resumeFilter} onChange={(event: any) => this.setState({ resumeFilter: event.target.value, currentPage: 1 })}>
              <option value="all">Any resume</option>
              <option value="with">Has a resume</option>
              <option value="saved">Resume saved to disk</option>
              <option value="without">No resume</option>
            </select>
          </label>
          <label className="inline">
            Rows
            <select value={String(pageSize)} onChange={(event: any) => this.setState({ pageSize: Number(event.target.value), currentPage: 1 })}>
              {PAGE_SIZES.map((size) => <option key={size} value={String(size)}>{size}</option>)}
            </select>
          </label>
          <span className="count">{total} applicant(s)</span>
        </section>
      </div>
    );
  }

  renderRow(record: ApplicantRecord, position: number) {
    const checked = this.state.selectedIds.includes(record.id);
    return (
      <tr key={record.id} className={checked ? "selected" : ""}>
        <td className="select-cell">
          <input type="checkbox" checked={checked} onChange={() => this.toggleSelected(record.id)} aria-label={`Select ${record.applicant.name}`} />
        </td>
        <td className="row-number" data-label="#">{position}</td>
        <td className="name-cell">
          {record.applicant.profileUrl
            ? <a href={record.applicant.profileUrl} target="_blank" rel="noreferrer">{show(record.applicant.name)}</a>
            : show(record.applicant.name)}
        </td>
        {/* Every text cell wraps its content in `.cell-clip`. The three-line
            clamp needs a box display, and a `<td>` given one stops being a table
            cell — which is what took six of these columns out of the grid and
            stacked them on top of each other. The wrapper is not a cell, so it
            can carry the clamp safely. */}
        <td className="text-cell" data-label="Email"><span className="cell-clip">{show(record.applicant.contact.email)}</span></td>
        <td className="text-cell" data-label="Mobile"><span className="cell-clip">{show(record.applicant.contact.phone)}</span></td>
        {/* One resume column, and no more: which file we have. The **Resume
            Link** column that stood here was removed on request in 3.7.9 — "we
            can skip the link and remove it from table too" — because what the
            recruiter wants from this row is the CV on disk, not an address to
            click. The link, the status, the viewer address, the file type and
            the page count are all still on the record and still in the details
            drawer below; since 3.7.15 they are no longer in the CSV either,
            which now carries this table and nothing else. */}
        {/* The saved copy's path when there is one, the file name when there is
            not. A file:// link would be blocked, so it is shown as text. */}
        <td className="text-cell" data-label="Resume File"><span className="cell-clip">{show(resumeFile(record))}</span></td>
        <td className="text-cell" data-label="Current Role"><span className="cell-clip">{show(record.applicant.currentRole)}</span></td>
        <td className="text-cell" data-label="Current Company"><span className="cell-clip">{show(record.applicant.currentCompany)}</span></td>
        <td className="summary-cell" data-label="Total Experience">{show(record.applicant.totalExperience)}</td>
        {/* What they studied. Collected all along and buried in the detail
            block until 3.7.7, so the thing a shortlist is actually scanned for
            was the one the table could not answer. The cell scrolls rather than
            growing the row.

            The **Qualifications** column that stood here was removed on
            request. Every requirement, its verdict, its explanation and its
            source are still collected and still stored, and the details drawer
            below still shows all of them — but a cell holding one line per
            requirement is a paragraph in a table, and on a job with seven
            must-haves it was the widest thing on the row while answering a
            question the drawer answers better. Nothing about the record
            changed; only what the table paints, and since 3.7.15 the CSV paints
            exactly the same set. */}
        <td className="list-cell" data-label="Education">
          {record.applicant.education.length
            ? <ul className="cell-list">
                {record.applicant.education.map((entry, index) => (
                  <li key={`${entry.institution}-${index}`} title={formatEducation(entry)}>{entry.institution}</li>
                ))}
              </ul>
            : "—"}
        </td>
        <td className="actions-cell">
          <button className="secondary small" type="button" onClick={() => this.setState({ details: record })}>View details</button>
          {/* Picks this ONE person for the composer below. It opens nothing on
              LinkedIn and sends nothing — it only decides who the next message
              is addressed to. */}
          <button className="secondary small" type="button" onClick={() => this.messageApplicant(record)}>Message</button>
          <button className="danger ghost small" type="button" onClick={() => this.removeApplicant(record)}>Remove</button>
        </td>
      </tr>
    );
  }

  /**
   * The palette, from `TEMPLATE_VARIABLES` — the core's own frozen list, never
   * a second copy kept in step by hand. Each press drops the token at the
   * cursor; the title says where the value is read from and shows one example,
   * so the shape of the thing is visible before it is inserted.
   */
  renderPalette() {
    const variables: any[] = Templates ? Templates.TEMPLATE_VARIABLES : [];
    if (!variables.length) return null;
    return (
      <div className="variable-palette">
        <span className="pv-label">Insert a variable</span>
        <div className="chip-list">
          {variables.map((variable: any) => (
            <button
              key={variable.name}
              className="variable-chip"
              type="button"
              title={`${variable.token} — ${variable.label}, read from ${variable.source}. For example: ${variable.example}`}
              onClick={() => this.insertToken(variable.token)}
            >
              {variable.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  /**
   * Exactly why this message may not be inserted, one variable at a time.
   *
   * Naming them is the whole point. "Blocked" on its own leaves the recruiter
   * hunting; "{{current_company}} has no value on this record" is a thing they
   * can fix — by writing the company in by hand, by giving the variable a
   * fallback, or by collecting that applicant again.
   */
  renderBlocked(preview: any) {
    const unresolved: string[] = preview.unresolved || [];
    const unknown: string[] = preview.unknown || [];
    const neither = !unresolved.length && !unknown.length;
    return (
      <div className="blocked" role="status">
        <strong>This message cannot be inserted.</strong>
        {unresolved.length ? (
          <div className="blocked-group">
            <p>These variables have no value on this applicant's own record:</p>
            <ul className="blocked-list">
              {unresolved.map((name: string) => {
                const described = Templates ? Templates.describeVariable(name) : null;
                return (
                  <li key={name}>
                    <code>{tokenFor(name)}</code>
                    {described ? ` — ${described.label}, read from ${described.source}` : ""}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {unknown.length ? (
          <div className="blocked-group">
            <p>These are not variables this extension can fill:</p>
            <ul className="blocked-list">
              {unknown.map((name: string) => <li key={name}><code>{tokenFor(name)}</code></li>)}
            </ul>
          </div>
        ) : null}
        {neither ? (
          <p>
            {preview.length
              ? "The rendered message is past the length this extension will insert."
              : "There is nothing to insert yet — write the message first."}
          </p>
        ) : null}
        {/* Said out loud, because the tempting "fix" is the defect: a
            placeholder reads as a real value to the person receiving it. */}
        <p>
          Nothing is substituted for a missing value — no <code>[name]</code>, no "there". Type the
          words in yourself, give the variable a fallback such as <code>{"{{first_name|there}}"}</code>,
          or collect this applicant again so the field is filled.
        </p>
      </div>
    );
  }

  /** The message exactly as it would be typed, against this one applicant. */
  renderPreview(record: ApplicantRecord | null, preview: any) {
    if (!preview) {
      return (
        <p className="notice error">
          The templating core did not load, so nothing can be previewed and nothing may be inserted.
        </p>
      );
    }
    const who = record ? (record.applicant.name || "this applicant") : "";
    return (
      <div className="preview">
        <div className="preview-meta">
          <span className="pv-label">{record ? `Preview for ${who}` : "Preview"}</span>
          <span className="count">{preview.length} characters</span>
        </div>
        {record
          ? null
          : (
            <p className="notice info">
              Pick an applicant above. The preview is rendered against that person's own collected
              record, never against the palette's examples.
            </p>
          )}
        {preview.text
          ? <pre className="preview-text">{preview.text}</pre>
          : <p className="messaging-empty">Nothing to preview yet.</p>}
        {preview.warnings.map((warning: any) => (
          <p key={warning.code} className="notice warn">{warning.message}</p>
        ))}
        {preview.blocked ? this.renderBlocked(preview) : null}
      </div>
    );
  }

  /** List, create, edit, delete, duplicate — and a delete always asks first. */
  renderTemplateList() {
    const { templates, templateId, confirmDeleteId } = this.state;
    return (
      <div className="messaging-column">
        <div className="messaging-column-head">
          <h3>Templates</h3>
          <button className="secondary small" type="button" onClick={this.startCustomMessage}>
            New message
          </button>
        </div>
        {templates.length ? (
          <ul className="template-list">
            {templates.map((template) => (
              <li key={template.id} className={`template-item ${template.id === templateId ? "current" : ""}`}>
                <button
                  className="template-pick"
                  type="button"
                  title="Load it into the box below, where it can be edited and saved back"
                  onClick={() => this.useTemplate(template)}
                >
                  {template.name}
                </button>
                <div className="template-actions">
                  <button className="link-button" type="button" onClick={() => this.duplicateTemplate(template)}>
                    Duplicate
                  </button>
                  {/* Never a one-press delete: the confirmation below is the
                      only path to `removeTemplate`. */}
                  <button className="link-button" type="button" onClick={() => this.setState({ confirmDeleteId: template.id })}>
                    Delete
                  </button>
                </div>
                {confirmDeleteId === template.id ? (
                  <div className="template-confirm">
                    <span>Delete "{template.name}"? This cannot be undone.</span>
                    <button className="danger small" type="button" onClick={() => this.removeTemplate(template)}>
                      Delete it
                    </button>
                    <button className="secondary small" type="button" onClick={() => this.setState({ confirmDeleteId: "" })}>
                      Cancel
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="messaging-empty">
            No templates yet. Write a message on the right, name it, and press Save as new template.
          </p>
        )}
      </div>
    );
  }

  renderCompose() {
    const record = this.messageTarget();
    const preview = this.preview();
    const { messageBody, templateName, templateId, probing, inserting } = this.state;
    const nameProblems = this.problemsFor("name");
    const bodyProblems = this.problemsFor("body");
    const report = this.probeReport(record);
    const ready = this.composerReady();
    const blocked = !preview || Boolean(preview.blocked);

    return (
      <div className="messaging-column">
        <div className="messaging-column-head">
          <h3>Compose</h3>
          {templateId ? <span className="pv-label">Editing a saved template</span> : <span className="pv-label">One-off message</span>}
        </div>

        {/* One applicant. There is no multi-select and no list-wide action:
            a message goes to the person the recruiter picked, or to nobody. */}
        <label className="messaging-field">
          Applicant
          <select
            value={this.state.messageTargetId}
            onChange={(event: any) => this.pickMessageTarget(event.target.value)}
          >
            <option value="">Pick one applicant</option>
            {this.filtered().map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.applicant.name || "Unnamed"} — ${entry.job.title || "no job title"}`}
              </option>
            ))}
          </select>
        </label>

        <label className="messaging-field">
          Template name
          <input
            type="text"
            value={templateName}
            placeholder="Name it to keep it as a template"
            onChange={(event: any) => this.setState({ templateName: event.target.value })}
          />
        </label>
        {nameProblems.length ? (
          <ul className="problems">
            {nameProblems.map((problem) => <li key={problem.code} className="problem">{problem.message}</li>)}
          </ul>
        ) : null}

        <label className="messaging-field">
          Message
          <textarea
            rows={MESSAGE_ROWS}
            value={messageBody}
            placeholder="Hi {{first_name_titled}}, thanks for applying to {{job_title}}…"
            ref={(node: any) => { this.bodyBox = node; }}
            onChange={(event: any) => this.composeChanged({ messageBody: event.target.value })}
          />
        </label>
        {bodyProblems.length ? (
          <ul className="problems">
            {bodyProblems.map((problem, index) => (
              <li key={`${problem.code}-${index}`} className="problem">{problem.message}</li>
            ))}
          </ul>
        ) : null}

        {this.renderPalette()}

        <div className="messaging-actions">
          <button className="secondary small" type="button" disabled={!templateStore} onClick={() => this.saveTemplate(true)}>
            Save as new template
          </button>
          <button
            className="secondary small"
            type="button"
            disabled={!templateStore || !templateId}
            onClick={() => this.saveTemplate(false)}
          >
            Update this template
          </button>
        </div>

        {this.renderPreview(record, preview)}

        <div className="messaging-actions">
          <button className="secondary" type="button" disabled={!record || probing} onClick={this.probeComposer}>
            {probing ? "Checking…" : "Check the hiring page"}
          </button>
          {/* Disabled whenever the preview is blocked. That is the load-bearing
              line of this whole screen and it has no override. */}
          <button
            className="primary"
            type="button"
            disabled={blocked || !record || !ready || inserting}
            onClick={this.insertMessage}
          >
            {inserting ? "Inserting…" : "Insert into LinkedIn's composer"}
          </button>
        </div>

        {report.length ? (
          <ul className="probe-report">
            {report.map((line, index) => <li key={`${index}-${line}`} className="probe-line">{line}</li>)}
          </ul>
        ) : (
          <p className="messaging-empty">
            Check the hiring page before inserting — it reads the open panel and presses nothing.
          </p>
        )}
      </div>
    );
  }

  /**
   * The messaging surface: templates on the left, one message on the right.
   *
   * Collapsed by default so the table it was added beneath is untouched for
   * anyone not using it.
   */
  renderMessaging() {
    const { messagingOpen, messagingStatus, messagingStatusKind } = this.state;
    return (
      <section className="messaging pv-panel" id="messaging">
        <header className="messaging-head">
          <h2>Message an applicant</h2>
          <button
            className="secondary"
            type="button"
            onClick={() => this.setState({ messagingOpen: !messagingOpen })}
          >
            {messagingOpen ? "Hide" : "Open"}
          </button>
        </header>
        {messagingOpen ? (
          <div className="messaging-inner">
            {/* Stated on the page, not only in the docs: the extension types
                the text and stops. Nothing here sends, and there is no control
                that could. */}
            <p className="notice info messaging-note">
              This puts your reviewed text into LinkedIn's own composer for one applicant.
              <strong>You press Enter to send it.</strong>
              The extension never sends a message, and never messages more than the one applicant you picked.
            </p>
            <div className="pv-slot">
              {messagingStatus
                ? <div className={`message ${messagingStatusKind}`.trim()} role="status">{messagingStatus}</div>
                : null}
            </div>
            <div className="messaging-body">
              {this.renderTemplateList()}
              {this.renderCompose()}
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  renderDetails() {
    const record = this.state.details;
    if (!record) return null;
    const applicant = record.applicant;
    const mustHave = applicant.qualifications.filter((entry) => entry.category === "must_have");
    const preferred = applicant.qualifications.filter((entry) => entry.category === "preferred");

    return (
      <div className="details-backdrop" onClick={() => this.setState({ details: null })}>
        <aside className="details-panel" onClick={(event: any) => event.stopPropagation()}>
          <header className="details-head">
            <div>
              <h2>{show(applicant.name)}</h2>
              <p>{show(applicant.headline)}</p>
            </div>
            <button className="secondary" type="button" onClick={() => this.setState({ details: null })}>Close</button>
          </header>

          <dl className="details-facts">
            {/* The job and the location left the table in 3.7.1; they are
                detail, and detail lives here. */}
            <Fact label="Job" value={show(record.job.title)} href={record.job.url} />
            <Fact label="Application status" value={show(applicant.applicationStatus)} />
            <Fact label="Location" value={show(applicant.location)} />
            <Fact label="Current role" value={show(applicant.currentRole)} />
            <Fact label="Current company" value={show(applicant.currentCompany)} />
            <Fact label="Total experience" value={show(applicant.totalExperience)} />
            <Fact label="Email" value={show(applicant.contact.email)} />
            <Fact label="Phone" value={show(applicant.contact.phone)} />
            <Fact label="Website" value={show(applicant.contact.website)} href={applicant.contact.website} />
            <Fact label="Applied" value={show(applicant.appliedAt)} />
            <Fact label="Contacted" value={show(applicant.contactedAt)} />
            <Fact label="Profile" value={applicant.profileUrl ? "Open on LinkedIn" : "—"} href={applicant.profileUrl} />
          </dl>

          <section className="details-section">
            <h3>Resume</h3>
            <p className="details-about">
              {applicant.resume.available
                ? `${resumeSummary(record)} · ${applicant.resume.fileType || "unknown type"}${applicant.resume.pages ? ` · ${applicant.resume.pages} pages` : ""}`
                : "This applicant has no resume this account can see."}
            </p>
            {applicant.resume.url
              ? <p className="details-about"><a href={applicant.resume.url} target="_blank" rel="noreferrer">Open the resume file</a></p>
              : null}
            {applicant.resume.viewerUrl
              ? <p className="details-about"><a href={applicant.resume.viewerUrl} target="_blank" rel="noreferrer">View it on LinkedIn</a></p>
              : null}
            {/* The three the table stopped showing in 3.7.6 all still live
                here, so consolidating the columns hid nothing: the download
                status is in the summary line above, and this is where the
                saved copy actually is. */}
            {applicant.resume.localReference
              ? <p className="details-about">Saved as {applicant.resume.localReference}</p>
              : null}
          </section>

          <DetailsSection title="Must-have qualifications" items={mustHave.map(formatQualification)} />
          <DetailsSection title="Preferred qualifications" items={preferred.map(formatQualification)} />
          <DetailsSection title="Screening responses" items={applicant.screeningResponses.map(formatScreening)} />
          <DetailsSection title="Experience" items={applicant.experience.map(formatExperience)} />
          <DetailsSection title="Education" items={applicant.education.map(formatEducation)} />
          <DetailsSection title="Skills" items={applicant.skills} />
          <DetailsSection title="Other contact details" items={applicant.contact.other} />
          <DetailsSection title="Extraction warnings" items={record.extraction.warnings} />

          <footer className="details-foot">
            <button className="success" type="button" onClick={() => this.exportCsv([record], "applicant")}>Download this row</button>
            <button className="danger ghost" type="button" onClick={() => this.removeApplicant(record)}>Remove</button>
          </footer>
        </aside>
      </div>
    );
  }

  render() {
    const { message, messageKind, currentPage, pageSize } = this.state;
    const filtered = this.filtered();
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(currentPage, pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    const pageIds = rows.map((record) => record.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => this.state.selectedIds.includes(id));

    return (
      <main className="dashboard-shell">
        <header className="dashboard-header">
          <div>
            <h1>Job Applicants</h1>
          </div>
          <div className="header-actions">
            <button className="secondary" type="button" onClick={this.refresh}>Refresh</button>
            <button className="danger ghost" type="button" onClick={this.clearAll}>Clear Applicants</button>
          </div>
        </header>

        {/* The slot is always here; only its contents come and go. Rendering the
            banner conditionally moved the entire table every time a message
            arrived or cleared — which, on a three-second poll during a run, is
            the row-shifting the recruiter was seeing. */}
        <div className="pv-slot">
          {message ? <div className={`message ${messageKind}`.trim()} role="status">{message}</div> : null}
        </div>
        {this.renderToolbar(total)}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="select-cell">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => this.toggleAllOnPage(pageIds, allSelected)}
                    aria-label="Select every applicant on this page"
                  />
                </th>
                {/* Position in the filtered list, counted from `start` so it
                    runs continuously across pages rather than restarting at 1 on
                    every page. It is a row number, never stored and never
                    exported: the record's identity is its `id`, and a number
                    that changes when a filter changes must not look like one. */}
                <th className="row-number">#</th>
                {/* The same class as the body cell, because the two are pinned
                    to the left as a pair — a header that scrolls away from the
                    column it names is worse than no pinning at all. */}
                <th className="name-cell">Applicant Name</th>
                <th>Email</th>
                <th>Mobile</th>
                <th>Resume File</th>
                <th>Current Role</th>
                <th>Current Company</th>
                <th>Total Experience</th>
                <th>Education</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length
                ? rows.map((record, index) => this.renderRow(record, start + index + 1))
                : (
                  <tr>
                    {/* +3: the select box, the row number and the actions cell
                        are not table COLUMNS in the export sense. */}
                    <td className="empty" colSpan={APPLICANT_TABLE_COLUMNS.length + 3}>
                      No applicants yet. Open your job's Applicants page on LinkedIn, then press Collect This Applicant.
                    </td>
                  </tr>
                )}
            </tbody>
          </table>
        </div>

        <div className="pagination">
          <button className="secondary" type="button" disabled={page <= 1} onClick={() => this.setState({ currentPage: page - 1 })}>
            Previous
          </button>
          <span>Showing {total ? start + 1 : 0}–{Math.min(start + pageSize, total)} of {total}</span>
          <button className="secondary" type="button" disabled={page >= pages} onClick={() => this.setState({ currentPage: page + 1 })}>
            Next
          </button>
        </div>

        {/* An addition beneath the table, never a replacement for it: the page
            reads and exports exactly as it did with the panel shut. */}
        {this.renderMessaging()}

        {this.renderDetails()}
      </main>
    );
  }
}

// The table header and the CSV are held in step by a test; this is the list it
// compares against, exported through the module the page already imports.
void APPLICANT_TABLE_COLUMNS;

const root = document.getElementById("root");
if (!root) throw new Error("Applicants root element is missing.");
ReactDOM.render(<ApplicantsApp />, root);
