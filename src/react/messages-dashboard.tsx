/**
 * Messages — write one message, and see what it would actually say to each of
 * the people it names.
 *
 * THIS PAGE SENDS, AND THAT IS NEW IN 3.14.0. Until this release the only ways
 * text left here were the clipboard and a CSV, both of which put the recruiter
 * between the extension and the person. A run now opens each selected
 * applicant's composer on LinkedIn, types the message, and presses Send — with
 * nobody reading it in between. That was asked for explicitly, with the
 * trade-off stated, and rules 5 and 6 were amended in the same task to allow
 * the two clicks it needs.
 *
 * WHICH MAKES EVERY REFUSAL BELOW LOAD-BEARING RATHER THAN ADVISORY. A blocked
 * message used to be a Copy button the recruiter could not press, and they
 * would have seen the gap before pasting it. There is no such reader now, so
 * BLOCKED is the last thing standing between a hole in a template and a hundred
 * people receiving it. A blocked person cannot be selected, cannot be swept up
 * by select-all, and cannot enter a run — not because it would look untidy, but
 * because a sent message cannot be recalled.
 *
 * WHAT IT IS FOR, and it is one thing. A mail merge fails silently: the run
 * completes, every message goes out, and the defect is a hundred people who
 * received "Hi ," or a sentence about the role they applied to when they never
 * applied to anything. Rule 1 of this project says a missing value stays empty
 * and a wrong value is worse than a blank one, and this screen is that rule
 * given a face. Every refusal it renders comes from a pure core, and this file
 * has no authority to argue with any of them:
 *
 *   - `previewTemplate(...).blocked` is a boolean this file may not override.
 *     Blocked means the message cannot be used, so the Copy control for that
 *     person is disabled rather than merely discouraged, and the export writes
 *     an empty message cell.
 *   - `validateTemplateForAudience` answers the other question entirely: not
 *     "is this person missing a value" but "can this variable EVER resolve for
 *     anyone in this audience". A connection has no job application, so
 *     `{{job_title}}` is empty for every connection alive, and that costs the
 *     whole audience rather than one card. It is stated at the top, loudly, and
 *     the repair named beside it is a fallback: `{{job_title|the role}}`.
 *   - Nothing is ever substituted for a missing value. There is no "[name]", no
 *     "there" and no "N/A" anywhere in this file. A variable that resolved to
 *     nothing renders as the gap it is, which is exactly what makes it visible.
 *
 * The three cores hold every decision. This file renders them, and wires up the
 * two IndexedDB reads that supply real people to test a message against.
 */

import { getAllApplicants } from "../applicant-db.js";
import { getAllProfiles } from "../db.js";
import { buildCsvFile, downloadCsvText, escapeCell } from "../csv.js";
// `STOP_ALL` is imported rather than spelled, deliberately: there is exactly one
// declaration of that literal in the codebase and `tests/universal-stop.test.js`
// asserts every surface carrying a Stop reaches it through the constant. A page
// that hard-codes the string is a page whose Stop silently stops working the
// day the literal changes.
import { MESSAGE_RUN_MESSAGES, STOP_ALL, type ApplicantRecord } from "../messages.js";
import { NavBar } from "./nav.js";
import { type ProfileRecord, type StatusKind } from "./types.js";

// Export-free IIFEs that publish onto `globalThis`, imported for their side
// effect exactly as the service worker imports its own cores. This page's HTML
// loads only this module, so these three imports are the whole reason the cores
// are on the page at all — and the order matters, because the recipients core
// and the store both read the templating core lazily out of `globalThis`.
import "../message-templates-core.js";
import "../template-store.js";
import "../message-recipients.js";
// The queue engine, for its limits and its recipient states. This page does not
// drive the queue — the worker owns it, because an extension page is allowed to
// close mid-run and a run that dies with its tab is a run that stops halfway
// through a list. What is read here is vocabulary, not authority.
import "../message-queue-core.js";

// React 16.0.0 is a global, not an import, and it has no hooks, no Fragments
// and no createRoot. Class components only — see CLAUDE.md.
const React: any = (globalThis as any).React;
const ReactDOM: any = (globalThis as any).ReactDOM;

const Templates: any = (globalThis as any).ProfileVaultMessageTemplates;
const TemplateStore: any = (globalThis as any).ProfileVaultTemplateStore;
const Recipients: any = (globalThis as any).ProfileVaultMessageRecipients;
const Queue: any = (globalThis as any).ProfileVaultMessageQueue;

/**
 * The two limits, read from the queue core rather than restated here.
 *
 * They are shown to the recruiter before a run starts, and the numbers on
 * screen have to be the numbers the worker will actually enforce — a page that
 * promises a 30-second gap while the engine uses five has told a lie about the
 * thing most likely to get the account throttled. Falling back to the engine's
 * own defaults keeps that true even if the core fails to load.
 */
const QUEUE_LIMITS: any = (Queue && Queue.QUEUE_LIMITS) || { MIN_GAP_MS: 30000, DAILY_CAP: 50 };

/** How often a live run is asked what it is doing. There is no push channel. */
const RUN_POLL_MS = 2000;

/**
 * The store, built once at load.
 *
 * `createTemplateStore({})` binds to `chrome.storage.local` LAZILY — it resolves
 * the area when an operation runs, not when the factory is called — so building
 * it here costs nothing and cannot throw on a page that is still loading.
 */
const store: any = TemplateStore && typeof TemplateStore.createTemplateStore === "function"
  ? TemplateStore.createTemplateStore({})
  : null;

/**
 * The two audiences, taken from the recipients core where it is loaded.
 *
 * The fallback is the documented pair of ids and nothing else. It is not a
 * second copy of the policy: with the core absent this page reports itself
 * broken rather than answering audience questions out of its own head.
 */
const AUDIENCE: { APPLICANTS: string; CONNECTIONS: string } =
  (Recipients && Recipients.AUDIENCE) || { APPLICANTS: "applicants", CONNECTIONS: "connections" };

const AUDIENCE_IDS: string[] = [AUDIENCE.APPLICANTS, AUDIENCE.CONNECTIONS];

/** How many people the list renders before asking to be shown more. */
const PAGE_STEP = 25;

/** How many names the preview picker offers before it stops being a picker. */
const PREVIEW_CHOICES = 200;

interface Problem {
  field?: string;
  code?: string;
  message?: string;
  variable?: string;
}

interface TemplateRecord {
  id: string;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One person this message could be written to.
 *
 * `recipient` is the recipients core's own record — `{ id, source, name,
 * profileUrl, applicationId, values, missing }` — built by that core and never
 * assembled here. `applicant` and `job` are what `previewTemplate` reads, and
 * they are the stored record's own fields rather than a second mapping of them.
 */
interface Person {
  id: string;
  name: string;
  subtitle: string;
  recipient: any;
  applicant: Record<string, unknown>;
  job: Record<string, unknown>;
}

interface Preview {
  text: string;
  unresolved: string[];
  unknown: string[];
  length: number;
  warnings: Array<{ code?: string; message?: string }>;
  blocked: boolean;
}

interface Verdict {
  person: Person;
  preview: Preview;
  ready: boolean;
}

/** One person's progress inside a live run, as the worker reports it. */
interface RunPerson {
  id: string;
  name: string;
  /** A `RECIPIENT_STATE` — pending, opening, awaiting-send, sent, skipped, failed. */
  state: string;
  reason: string;
}

/**
 * What a live run looks like from here.
 *
 * Pulled, never pushed: an extension page has no channel a service worker can
 * shout down, so this is the shape of the last `STATUS` reply and it is always
 * a moment old. Nothing on this page may act on it as though it were current —
 * in particular the Stop button is rendered whatever this says, because a run
 * this page believes has finished may still be mid-composer.
 */
interface RunView {
  /** A `QUEUE_STATE` — idle, running, paused, stopped, done. */
  state: string;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  pending: number;
  /** Milliseconds still owed on the gap between two people, if it is waiting. */
  waitMs: number;
  currentName: string;
  entries: RunPerson[];
}

interface MessagesState {
  templates: TemplateRecord[];
  templateId: string;
  draftName: string;
  draftBody: string;
  dirty: boolean;
  problems: Problem[];
  audience: string;
  applicants: ApplicantRecord[];
  profiles: ProfileRecord[];
  search: string;
  visibleCount: number;
  previewId: string;
  copiedId: string;
  message: string;
  messageKind: StatusKind;
  busy: boolean;
  /** Who a run would go to. Only ever holds the ids of READY people. */
  selectedIds: string[];
  /**
   * The armed confirmation. A run is two deliberate acts, not one click,
   * because it is the only irreversible thing this extension does.
   */
  confirming: boolean;
  starting: boolean;
  /** The last `STATUS` reply, or null when no run has been seen. */
  run: RunView | null;
}

/** `{{name}}`, whatever form the core reported the reference in. */
function token(name: unknown): string {
  const text = String(name ?? "");
  return text.startsWith("{{") ? text : `{{${text}}}`;
}

function formatDate(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "—";
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joined(parts: unknown[]): string {
  return parts.map((part) => String(part ?? "").trim()).filter(Boolean).join(" · ");
}

/**
 * Every problem the store refused a save with.
 *
 * `save` throws ONE error carrying the whole list on `error.problems`, so the
 * form can show all of them at once beside the fields that caused them. An
 * error with no list is still an error the user has to see, so it becomes a
 * single form-level problem — a raw exception reaching the console while
 * nothing reaches the screen is the failure this converts.
 */
function problemsFrom(error: any): Problem[] {
  const list = error && Array.isArray(error.problems) ? error.problems : [];
  if (list.length) return list as Problem[];
  return [{ field: "form", code: "refused", message: errorText(error) || "The template was refused." }];
}

/** The audience's own description; a bare label only where the core is absent. */
function describeAudience(id: string): { id: string; label: string; unavailable: string[] } {
  if (Recipients && typeof Recipients.describeAudience === "function") {
    // Answers null for an audience it does not know, which is a refusal to
    // guess and not a value to paper over.
    const described = Recipients.describeAudience(id);
    if (described && typeof described === "object") {
      return {
        id: String(described.id ?? id),
        label: String(described.label ?? id),
        unavailable: Array.isArray(described.unavailable) ? described.unavailable.map(String) : []
      };
    }
  }
  return { id, label: id === AUDIENCE.CONNECTIONS ? "Connections" : "Applicants", unavailable: [] };
}

/**
 * The variables that can never resolve for this audience.
 *
 * An empty list where the core is missing, never a guessed one: this page says
 * out loud that it cannot check rather than quietly reporting all is well.
 */
function unavailableFor(audience: string): string[] {
  if (Recipients && typeof Recipients.unavailableVariablesFor === "function") {
    const list = Recipients.unavailableVariablesFor(audience);
    if (Array.isArray(list)) return list.map(String);
  }
  return [];
}

/** The audience-level verdict on the body itself, before any person is read. */
function audienceProblems(body: string, audience: string): Problem[] {
  if (!body.trim()) return [];
  if (!Recipients || typeof Recipients.validateTemplateForAudience !== "function") return [];
  const problems = Recipients.validateTemplateForAudience({ body, audience });
  return Array.isArray(problems) ? (problems as Problem[]) : [];
}

/**
 * A collected applicant as a person.
 *
 * The recipient half is built by the recipients core, which decides identity
 * (an applicant is a person ON A JOB, rule 17) and which fields are readable.
 * That core answers null for a record naming nobody at all, and a record it
 * refuses is dropped here rather than shown as a nameless card.
 */
function applicantPerson(record: ApplicantRecord): Person | null {
  const applicant: any = record.applicant || {};
  const job: any = record.job || {};
  const recipient = Recipients && typeof Recipients.toApplicantRecipient === "function"
    ? Recipients.toApplicantRecipient(record)
    : null;
  if (Recipients && typeof Recipients.toApplicantRecipient === "function" && !recipient) return null;
  const name = recipient ? String(recipient.name ?? "") : String(applicant.name ?? "").trim();
  return {
    id: recipient ? String(recipient.id) : String(record.id ?? ""),
    name,
    subtitle: joined([applicant.headline, job.title]),
    recipient,
    applicant,
    job
  };
}

/**
 * A saved profile as a person.
 *
 * `job` is EMPTY, and empty is the truthful answer: a connection has not
 * applied to anything, so there is no title, no company and no applied-at date
 * to read. That is what makes `{{job_title}}` come back blank for every one of
 * them, which is what `validateTemplateForAudience` reports before a single
 * card is rendered.
 *
 * The education list is re-shaped — the profile store keeps one institution
 * NAME per entry and the palette's reader wants an entry that names a school —
 * and nothing else is translated. `currentRole`, `currentCompany` and
 * `totalExperience` are not read even from a record that happens to carry them:
 * they were retired as derived-and-unread, and a derived role that disagrees
 * with the experience lines beside it is worse than no role.
 */
function connectionPerson(profile: ProfileRecord): Person | null {
  const recipient = Recipients && typeof Recipients.toConnectionRecipient === "function"
    ? Recipients.toConnectionRecipient(profile)
    : null;
  if (Recipients && typeof Recipients.toConnectionRecipient === "function" && !recipient) return null;
  const education = (Array.isArray(profile.education) ? profile.education : [])
    .map((institution: string) => ({ institution }));
  const name = recipient ? String(recipient.name ?? "") : String(profile.fullName ?? "").trim();
  return {
    id: recipient ? String(recipient.id) : String(profile.id ?? profile.profileUrl ?? ""),
    name,
    subtitle: joined([profile.headline, profile.location]),
    recipient,
    applicant: {
      name: profile.fullName,
      profileUrl: profile.profileUrl,
      headline: profile.headline,
      location: profile.location,
      education
    },
    job: {}
  };
}

/** What this message says to this person, and whether it may be used at all. */
function previewFor(person: Person, body: string): Preview {
  const preview = Templates.previewTemplate({ body, applicant: person.applicant, job: person.job });
  return {
    text: String(preview.text ?? ""),
    unresolved: Array.isArray(preview.unresolved) ? preview.unresolved.map(String) : [],
    unknown: Array.isArray(preview.unknown) ? preview.unknown.map(String) : [],
    length: Number(preview.length ?? 0),
    warnings: Array.isArray(preview.warnings) ? preview.warnings : [],
    blocked: preview.blocked === true
  };
}

/**
 * READY or BLOCKED — and both cores have to agree before it is READY.
 *
 * `blocked` is the templating core's answer about this exact rendering, limits
 * included; `isRecipientReady` is the recipients core's answer about this
 * person on this audience, read off the value map that core built itself.
 * Either one refusing is a refusal, and a core that throws is a refusal too,
 * because an exception is not a yes. Consulting both can only ever block more,
 * never less, which is the only direction it is safe to be wrong in here.
 */
function readyFor(person: Person, body: string, preview: Preview): boolean {
  if (preview.blocked) return false;
  if (person.recipient && Recipients && typeof Recipients.isRecipientReady === "function") {
    try {
      return Recipients.isRecipientReady(person.recipient, body) === true;
    } catch {
      return false;
    }
  }
  return true;
}

/** Why this person is blocked, in the words the recruiter has to act on. */
function blockReasons(preview: Preview, ready: boolean): string[] {
  const reasons: string[] = [];
  if (preview.unresolved.length) {
    reasons.push(
      `No value for ${preview.unresolved.map(token).join(", ")} on this person. `
      + "Give the variable a fallback, or take it out."
    );
  }
  if (preview.unknown.length) {
    reasons.push(`${preview.unknown.map(token).join(", ")} is not a variable this extension can fill.`);
  }
  if (!preview.text.trim()) reasons.push("The message renders empty.");
  const max = Number(Templates && Templates.TEMPLATE_LIMITS ? Templates.TEMPLATE_LIMITS.BODY_MAX : 0);
  if (max && preview.length > max) {
    reasons.push(`The message is ${preview.length} characters. The ceiling is ${max}.`);
  }
  if (!reasons.length && !ready) {
    reasons.push("This person cannot receive this message on the chosen audience.");
  }
  return reasons;
}

/**
 * A recipient state, as a class name and as words.
 *
 * Written as whole literal class names in one place rather than composed from
 * the state string, because `tests/visual-layer.test.js` finds class names by
 * scanning for a quoted class attribute and cannot see a name that is built at
 * runtime. Every value on the right of this map is therefore also listed in
 * that test's `dynamic` array for this page — if the two ever disagree, an
 * element ships with no rule and the suite stays green. Adding a state here
 * means adding it there.
 *
 * (That scanner reads comments too, so this one deliberately does not spell the
 * attribute out — writing the example literally registered the ellipsis inside
 * it as a class name the stylesheet was then required to define.)
 */
const RUN_STATE_CLASS: Record<string, string> = {
  pending: "msg-run-state msg-run-pending",
  opening: "msg-run-state msg-run-opening",
  "awaiting-send": "msg-run-state msg-run-awaiting",
  sent: "msg-run-state msg-run-sent",
  skipped: "msg-run-state msg-run-skipped",
  failed: "msg-run-state msg-run-failed"
};

const RUN_STATE_LABEL: Record<string, string> = {
  pending: "Queued",
  opening: "Opening",
  // Deliberately not "Sending". The composer holds the text and the send has
  // not been pressed yet, and a recruiter reading "Sending" would believe the
  // message had gone when Stop could still catch it.
  "awaiting-send": "In composer",
  sent: "Sent",
  skipped: "Skipped",
  failed: "Failed"
};

function runStateClass(state: string): string {
  return RUN_STATE_CLASS[state] || "msg-run-state";
}

function runStateLabel(state: string): string {
  return RUN_STATE_LABEL[state] || state;
}

/** Whole seconds still owed on the gap, for a countdown that reads honestly. */
function secondsLeft(waitMs: number): number {
  return Math.max(0, Math.ceil(Number(waitMs || 0) / 1000));
}

class MessagesApp extends React.Component {
  state: MessagesState = {
    templates: [],
    templateId: "",
    draftName: "",
    draftBody: "",
    dirty: false,
    problems: [],
    audience: AUDIENCE.APPLICANTS,
    applicants: [],
    profiles: [],
    search: "",
    visibleCount: PAGE_STEP,
    previewId: "",
    copiedId: "",
    message: "",
    messageKind: "",
    busy: false,
    selectedIds: [],
    confirming: false,
    starting: false,
    run: null
  };

  /** The `STATUS` poll while a run is live. Cleared on unmount — see below. */
  private runTimer: any = null;

  /**
   * The body textarea, so a palette press can land a token at the caret.
   * React 16.0.0 has no `createRef`, so this is a callback ref.
   */
  private bodyField: any = null;

  componentDidMount() {
    this.loadTemplates();
    this.loadPeople();
    // Asked once on arrival, before anything is polled: a run started from a
    // tab the recruiter has since closed is still running in the worker, and a
    // page that opened blank next to a live run would offer to start a second.
    this.pollRun();
  }

  componentWillUnmount() {
    this.stopPolling();
  }

  setMessage = (message: string, messageKind: StatusKind = "") => {
    this.setState({ message, messageKind });
  };

  // ------------------------------------------------------------------ loading

  loadTemplates = async () => {
    if (!store) return;
    try {
      const templates = await store.list();
      this.setState({ templates: Array.isArray(templates) ? templates : [] });
    } catch (error) {
      this.setMessage(`Templates could not be read: ${errorText(error)}`, "error");
    }
  };

  loadPeople = async () => {
    try {
      const applicants = await getAllApplicants();
      this.setState({ applicants: Array.isArray(applicants) ? applicants : [] });
    } catch (error) {
      this.setMessage(`Applicants could not be read: ${errorText(error)}`, "error");
    }
    try {
      // `getAllProfiles` answers `{ profiles, invalid }` — the valid records and
      // the ones that failed validation, which are deliberately not messaged.
      const result: any = await getAllProfiles();
      this.setState({ profiles: result && Array.isArray(result.profiles) ? result.profiles : [] });
    } catch (error) {
      this.setMessage(`Saved profiles could not be read: ${errorText(error)}`, "error");
    }
  };

  refresh = () => {
    this.setMessage("");
    this.loadTemplates();
    this.loadPeople();
  };

  // ---------------------------------------------------------------- templates

  /**
   * Load a template into the editor, re-read from the store rather than taken
   * from the list already in state: another page may have changed it since this
   * one loaded, and editing a stale body would quietly write the stale one back.
   */
  selectTemplate = async (id: string) => {
    if (!id) {
      this.setState({ templateId: "", draftName: "", draftBody: "", dirty: false, problems: [] });
      this.setMessage("");
      return;
    }
    if (!store) return;
    try {
      const record = await store.get(id);
      if (!record) {
        this.setMessage("That template is no longer stored.", "error");
        this.loadTemplates();
        return;
      }
      this.setState({
        templateId: record.id,
        draftName: record.name,
        draftBody: record.body,
        dirty: false,
        problems: []
      });
      this.setMessage("");
    } catch (error) {
      this.setMessage(errorText(error), "error");
    }
  };

  /**
   * Create, or update. `asNew` writes a copy under a fresh id, which is how an
   * edited template becomes a variant instead of replacing what it came from.
   *
   * Every refusal arrives as a list of problems and every one of them is shown
   * against its own field. Nothing here surfaces a raw exception.
   */
  saveTemplate = async (asNew: boolean) => {
    if (!store) {
      this.setMessage("Templates cannot be stored: the template store is not loaded.", "error");
      return;
    }
    const id = asNew ? "" : this.state.templateId;
    this.setState({ busy: true });
    try {
      const record = await store.save({ id, name: this.state.draftName, body: this.state.draftBody });
      this.setState({
        templateId: record.id,
        draftName: record.name,
        draftBody: record.body,
        dirty: false,
        problems: []
      });
      this.setMessage(`Saved "${record.name}".`, "success");
      await this.loadTemplates();
    } catch (error) {
      this.setState({ problems: problemsFrom(error) });
      this.setMessage("The template was not saved.", "error");
    } finally {
      this.setState({ busy: false });
    }
  };

  /** Renaming leaves the body alone, which is why it is not a save. */
  renameTemplate = async (record: TemplateRecord) => {
    if (!store) return;
    const next = window.prompt(`Rename "${record.name}" to:`, record.name);
    if (next === null) return;
    try {
      const saved = await store.rename(record.id, next);
      if (this.state.templateId === record.id) this.setState({ draftName: saved.name });
      this.setMessage(`Renamed to "${saved.name}".`, "success");
      await this.loadTemplates();
    } catch (error) {
      this.setMessage(this.problemLine(error), "error");
    }
  };

  duplicateTemplate = async (record: TemplateRecord) => {
    if (!store) return;
    try {
      const copy = await store.duplicate(record.id);
      this.setMessage(`Copied to "${copy.name}".`, "success");
      await this.loadTemplates();
    } catch (error) {
      this.setMessage(this.problemLine(error), "error");
    }
  };

  /** Confirmed first, always: a template is the user's own writing. */
  removeTemplate = async (record: TemplateRecord) => {
    if (!store) return;
    if (!window.confirm(`Delete the template "${record.name}"? This cannot be undone.`)) return;
    try {
      const removed = await store.remove(record.id);
      // The body stays in the editor. Deleting a template must not also throw
      // away the message the user is in the middle of writing.
      if (this.state.templateId === record.id) this.setState({ templateId: "", dirty: true });
      this.setMessage(
        removed ? `Deleted "${record.name}".` : "That template was already gone.",
        removed ? "success" : ""
      );
      await this.loadTemplates();
    } catch (error) {
      this.setMessage(errorText(error), "error");
    }
  };

  /** A refusal as one line, for the places with no field to sit beside. */
  problemLine(error: unknown): string {
    return problemsFrom(error).map((problem) => problem.message).filter(Boolean).join(" ");
  }

  // ------------------------------------------------------------------- editor

  editName = (value: string) => {
    this.setState({ draftName: value, dirty: true, problems: [] });
  };

  editBody = (value: string) => {
    this.setState({ draftBody: value, dirty: true, problems: [] });
  };

  /**
   * Put a token where the caret is, and leave the caret after it.
   *
   * Appending at the end instead would make the palette useless for anything
   * but the last line, and losing the caret after every insert makes writing a
   * sentence around a variable impossible.
   */
  insertToken = (text: string) => {
    const field = this.bodyField;
    const body = this.state.draftBody;
    const start = field && typeof field.selectionStart === "number" ? field.selectionStart : body.length;
    const end = field && typeof field.selectionEnd === "number" ? field.selectionEnd : start;
    const next = body.slice(0, start) + text + body.slice(end);
    const caret = start + text.length;
    this.setState({ draftBody: next, dirty: true, problems: [] }, () => {
      if (!field) return;
      field.focus();
      field.setSelectionRange(caret, caret);
    });
  };

  // --------------------------------------------------------------- recipients

  /** The chosen audience's people, filtered by the search box. */
  people(): Person[] {
    const { audience, applicants, profiles, search } = this.state;
    const all = audience === AUDIENCE.CONNECTIONS
      ? profiles.map(connectionPerson)
      : applicants.map(applicantPerson);
    const found = all.filter((person: Person | null): boolean => Boolean(person)) as Person[];
    const term = search.trim().toLowerCase();
    if (!term) return found;
    return found.filter((person) => `${person.name} ${person.subtitle}`.toLowerCase().includes(term));
  }

  /** Every person with their rendered message and the verdict on it. */
  verdicts(): Verdict[] {
    const body = this.state.draftBody;
    return this.people().map((person) => {
      const preview = previewFor(person, body);
      return { person, preview, ready: readyFor(person, body, preview) };
    });
  }

  // ---------------------------------------------------------------- selection

  /**
   * The people a run would actually go to.
   *
   * Recomputed from the CURRENT verdicts every time rather than trusted from
   * `selectedIds`, and that is the whole point of it being a method. A tick is
   * recorded against a person, but readiness belongs to the person AND the
   * template together — editing one word of the body can turn a ready person
   * blocked while their box stays ticked. Filtering on `ready` here means the
   * stale tick cannot survive into a payload, so the worst an out-of-date
   * selection can do is send to fewer people than the box implies. Never more.
   */
  selectedVerdicts(): Verdict[] {
    const wanted = new Set(this.state.selectedIds);
    return this.verdicts().filter((entry) =>
      // A person with no recipient record has no value map, and the text would
      // have to be rendered from something other than what READY was judged
      // against. `readyFor` lets them through — for Copy, where a human reads
      // the result before it goes anywhere — so sending has to refuse them
      // here. In practice this only happens when the recipients core failed to
      // load, which the page already says loudly at the top.
      entry.ready && entry.person.recipient && wanted.has(entry.person.id));
  }

  toggleSelected = (id: string) => {
    this.setState((previous: MessagesState) => ({
      selectedIds: previous.selectedIds.includes(id)
        ? previous.selectedIds.filter((value) => value !== id)
        : [...previous.selectedIds, id]
    }));
  };

  /**
   * Select-all over the people currently on screen — and only the ready ones.
   *
   * A blocked person is not merely skipped by the payload builder; they are
   * never ticked in the first place, so the count beside the Start button is
   * the count that will be messaged. A select-all that silently gathered people
   * it would later drop is how a recruiter comes to believe forty went out when
   * thirty-one did.
   */
  toggleAllReady = (entries: Verdict[]) => {
    const ids = entries.filter((entry) => entry.ready).map((entry) => entry.person.id);
    const all = ids.length > 0 && ids.every((id) => this.state.selectedIds.includes(id));
    this.setState((previous: MessagesState) => ({
      selectedIds: all
        ? previous.selectedIds.filter((id) => !ids.includes(id))
        : [...new Set([...previous.selectedIds, ...ids])]
    }));
  };

  // --------------------------------------------------------------------- runs

  /**
   * One person, in the shape the queue engine takes.
   *
   * `renderTemplate` rather than `previewTemplate`, because the preview adds a
   * length verdict and warnings this does not need, and because the text has to
   * come off `recipient.values` — the value map the recipients core built — so
   * that what is sent is what the READY verdict was computed against. Rendering
   * a second time from a different source is how the screen and the message
   * come to disagree.
   */
  runRecipients(): Array<Record<string, unknown>> {
    const body = this.state.draftBody;
    return this.selectedVerdicts().map((entry) => {
      const recipient = entry.person.recipient;
      const rendered = Templates.renderTemplate({ body, values: recipient.values });
      return {
        id: recipient.id,
        name: recipient.name,
        profileUrl: recipient.profileUrl,
        applicationId: recipient.applicationId,
        text: String(rendered.text ?? "")
      };
    });
  }

  /** Arm the confirmation. Nothing is sent by this. */
  askToStart = () => this.setState({ confirming: true });

  cancelStart = () => this.setState({ confirming: false });

  /**
   * Start the run — the second of the two deliberate acts.
   *
   * The payload is rebuilt here rather than carried from `askToStart`, so the
   * list that goes out is the list as it stands at the moment of confirming and
   * not as it stood when the dialog opened.
   */
  startRun = async () => {
    const recipients = this.runRecipients();
    if (!recipients.length) {
      this.setState({ confirming: false });
      this.setMessage("Nobody is selected, so there is nothing to send.", "error");
      return;
    }
    this.setState({ confirming: false, starting: true });
    this.setMessage(`Starting a run to ${recipients.length} people…`);
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_RUN_MESSAGES.START,
        recipients,
        audience: this.state.audience
      });
      if (response?.ok === false) throw new Error(response.error || "The run could not be started.");
      if (response?.alreadyRunning) {
        this.setMessage("A run is already going. This one was not started.", "error");
      } else {
        this.setMessage(`Running. ${recipients.length} people, one at a time.`, "success");
      }
      this.startPolling();
    } catch (error) {
      this.setMessage(errorText(error), "error");
    } finally {
      this.setState({ starting: false });
    }
  };

  /**
   * Stop, and it stops everything — rule 12.
   *
   * Not narrowed to this run: the rule is that Stop ends all work, and a
   * recruiter pressing it in the middle of a send is not asking for a
   * distinction between which subsystem they meant. What it never does is
   * discard what the run produced — everyone already sent stays sent, and the
   * worker records whoever was mid-composer rather than abandoning them.
   */
  stopRun = async () => {
    this.setMessage("Stopping…");
    try {
      const response = await chrome.runtime.sendMessage({ type: STOP_ALL });
      if (response?.ok === false) throw new Error(response.error || "Stop failed.");
      this.setMessage("Stopped. Everyone already messaged stays messaged.", "success");
    } catch (error) {
      this.setMessage(errorText(error), "error");
    }
    this.pollRun();
  };

  startPolling = () => {
    if (this.runTimer) return;
    this.runTimer = setInterval(this.pollRun, RUN_POLL_MS);
  };

  stopPolling = () => {
    if (!this.runTimer) return;
    clearInterval(this.runTimer);
    this.runTimer = null;
  };

  /**
   * Ask the worker what the run is doing.
   *
   * A failure here is deliberately silent. The worker sleeps after about thirty
   * seconds idle and a poll that arrives while it is waking gets nothing back;
   * turning that into a red banner every two seconds would train the recruiter
   * to ignore the one banner that matters. The previous view is kept instead.
   */
  pollRun = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGE_RUN_MESSAGES.STATUS });
      if (!response?.ok || !response.run) return;
      const run = response.run as RunView;
      this.setState({ run });
      if (run.state !== "running" && run.state !== "paused") this.stopPolling();
      else this.startPolling();
    } catch {
      // The worker is asleep or the page is mid-teardown. Neither is news.
    }
  };

  /** This person's state inside the live run, or "" if they are not in one. */
  runStateFor(id: string): string {
    const entries = this.state.run?.entries;
    if (!Array.isArray(entries)) return "";
    const found = entries.find((entry) => entry.id === id);
    return found ? String(found.state || "") : "";
  }

  /** Is a run live enough that starting another would be wrong? */
  runIsLive(): boolean {
    const state = this.state.run?.state || "";
    return state === "running" || state === "paused";
  }

  copyText = async (text: string, copiedId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copiedId });
      this.setMessage("Copied to the clipboard.", "success");
    } catch (error) {
      this.setState({ copiedId: "" });
      this.setMessage(`Nothing was copied: ${errorText(error)}`, "error");
    }
  };

  copyAll = () => {
    const ready = this.verdicts().filter((entry) => entry.ready);
    if (!ready.length) {
      this.setMessage("There is no ready message to copy.", "error");
      return;
    }
    const text = ready
      .map((entry) => `${entry.person.name || "(no name collected)"}\n${entry.preview.text}`)
      .join("\n\n----\n\n");
    this.copyText(text, "all");
  };

  /**
   * The whole audience as a CSV: who, whether it is usable, and why not.
   *
   * A BLOCKED row exports an EMPTY message cell. The rendering exists and the
   * screen shows it, gap and all, because seeing the hole is how the template
   * gets fixed — but a file is a thing that gets pasted, and exporting a message
   * this page has refused would hand somebody the one text it spent all its
   * effort refusing to hand them.
   */
  exportCsv = () => {
    const entries = this.verdicts();
    if (!entries.length) {
      this.setMessage("There is nobody to export.", "error");
      return;
    }
    const label = describeAudience(this.state.audience).label;
    const rows = entries.map((entry) => [
      entry.person.name,
      label,
      entry.ready ? "Ready" : "Blocked",
      entry.ready ? "" : blockReasons(entry.preview, entry.ready).join(" "),
      entry.ready ? entry.preview.text : ""
    ].map((cell) => escapeCell(cell)).join(","));
    try {
      downloadCsvText(
        buildCsvFile(["Recipient", "Audience", "Status", "Why it is blocked", "Message"], rows),
        "profile-vault-messages"
      );
      this.setMessage("Exported. A blocked row carries the reason and no message.", "success");
    } catch (error) {
      this.setMessage(errorText(error), "error");
    }
  };

  // ---------------------------------------------------------------- renderers

  renderCoreWarning() {
    const missing: string[] = [];
    if (!Templates) missing.push("the message templating core");
    if (!store) missing.push("the template store");
    if (!Recipients) missing.push("the audience rules core");
    if (!missing.length) return null;
    return (
      <div className="notice error" role="alert">
        <strong>This page is not fully wired.</strong>{" "}
        {missing.join(" and ")} did not load, so the checks that depend on it cannot run. Nothing
        here is safe to rely on until that is fixed.
      </div>
    );
  }

  renderProblems(field: string) {
    const list = this.state.problems.filter((problem) => (problem.field || "form") === field);
    if (!list.length) return null;
    return (
      <ul className="msg-problems">
        {list.map((problem: Problem, index: number) => (
          <li className="msg-problem" key={`${problem.code || "problem"}-${index}`}>
            {problem.message || problem.code}
          </li>
        ))}
      </ul>
    );
  }

  renderTemplates() {
    const { templates, templateId } = this.state;
    return (
      <section className="pv-panel msg-panel">
        <div className="msg-panel-head">
          <h2>Templates</h2>
          <button className="secondary small" type="button" onClick={() => this.selectTemplate("")}>
            New message
          </button>
        </div>
        {templates.length ? (
          <ul className="msg-template-list">
            {templates.map((record: TemplateRecord) => (
              <li
                className={record.id === templateId
                  ? "msg-template-item msg-template-item-current"
                  : "msg-template-item"}
                key={record.id}
              >
                <button
                  className="link-button msg-template-name"
                  type="button"
                  aria-current={record.id === templateId ? "true" : undefined}
                  onClick={() => this.selectTemplate(record.id)}
                >
                  {record.name}
                </button>
                <span className="msg-template-actions">
                  <button className="secondary small" type="button" onClick={() => this.renameTemplate(record)}>
                    Rename
                  </button>
                  <button className="secondary small" type="button" onClick={() => this.duplicateTemplate(record)}>
                    Duplicate
                  </button>
                  <button className="danger ghost small" type="button" onClick={() => this.removeTemplate(record)}>
                    Delete
                  </button>
                </span>
                <span className="msg-template-meta">Updated {formatDate(record.updatedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="msg-empty">
            No saved templates yet. Write a message below and save it, or leave it unsaved and use it once.
          </p>
        )}
      </section>
    );
  }

  renderPalette() {
    const variables: any[] = Templates && Array.isArray(Templates.TEMPLATE_VARIABLES)
      ? Templates.TEMPLATE_VARIABLES
      : [];
    const unavailable = unavailableFor(this.state.audience);
    return (
      <div className="msg-palette">
        <span className="pv-label">Insert a variable</span>
        <div className="msg-palette-list">
          {variables.map((entry: any) => {
            const impossible = unavailable.indexOf(entry.name) !== -1;
            return (
              <button
                className={impossible ? "msg-var msg-var-unavailable" : "msg-var"}
                type="button"
                key={entry.name}
                title={impossible
                  ? `${entry.label} — never available for this audience. Insert it with a fallback.`
                  : `${entry.label} — from ${entry.source}. For example: ${entry.example}`}
                onClick={() => this.insertToken(entry.token)}
              >
                <span className="msg-var-label">{entry.label}</span>
                <span className="msg-var-token">{entry.token}</span>
              </button>
            );
          })}
        </div>
        <p className="msg-hint">
          A variable with no value blocks the message for that person rather than filling the gap. The
          repair is a fallback — <code className="msg-code">{"{{job_title|the role}}"}</code> — which is
          wording you chose, not a value this extension invented.
        </p>
      </div>
    );
  }

  renderEditor() {
    const { draftName, draftBody, templateId, dirty, busy } = this.state;
    const max = Number(Templates && Templates.TEMPLATE_LIMITS ? Templates.TEMPLATE_LIMITS.BODY_MAX : 0);
    return (
      <section className="pv-panel msg-panel">
        <div className="msg-panel-head">
          <h2>{templateId ? "Edit template" : "Compose"}</h2>
          {dirty ? <span className="msg-dirty">Unsaved</span> : null}
        </div>

        <label className="msg-field">
          <span className="pv-label">Template name</span>
          <input
            className="msg-input"
            type="text"
            value={draftName}
            placeholder="Only needed if you want to keep this message"
            onChange={(event: any) => this.editName(event.target.value)}
          />
        </label>
        {this.renderProblems("name")}

        <label className="msg-field">
          <span className="pv-label">Message</span>
          <textarea
            className="msg-textarea"
            value={draftBody}
            placeholder="Hi {{first_name_titled}}, I saw your application for {{job_title|the role}}."
            ref={(element: any) => { this.bodyField = element; }}
            onChange={(event: any) => this.editBody(event.target.value)}
          />
        </label>
        {this.renderProblems("body")}
        {this.renderProblems("id")}
        {this.renderProblems("form")}
        <p className="msg-counter">{draftBody.length}{max ? ` / ${max}` : ""} characters</p>

        {this.renderPalette()}

        <div className="msg-actions">
          <button className="primary" type="button" disabled={busy} onClick={() => this.saveTemplate(false)}>
            {templateId ? "Save template" : "Save as template"}
          </button>
          {templateId ? (
            <button className="secondary" type="button" disabled={busy} onClick={() => this.saveTemplate(true)}>
              Save as new
            </button>
          ) : null}
          <button className="secondary" type="button" onClick={() => this.selectTemplate("")}>Clear</button>
        </div>
        <p className="msg-note">
          A message does not have to be saved to be used. An unsaved one-off previews and copies exactly
          like a stored template.
        </p>
      </section>
    );
  }

  /**
   * The audience-level refusal, which is the whole reason this page exists.
   *
   * Not "this person is missing a value" — that is per-person, and the list
   * below reports it there. This is "this variable can never resolve for
   * anybody here", said once, at the top, before a single card is read.
   */
  renderAudienceWarning() {
    const { draftBody, audience } = this.state;
    const problems = audienceProblems(draftBody, audience);
    const described = describeAudience(audience);
    if (!problems.length) {
      if (!described.unavailable.length) return null;
      return (
        <p className="msg-unavailable-note">
          Never available for {described.label}: {described.unavailable.map(token).join(", ")}. Used
          without a fallback, any of them blocks every person in this audience.
        </p>
      );
    }
    return (
      <div className="notice error msg-audience-warning" role="alert">
        <strong>These variables can never resolve for {described.label}.</strong>
        <ul className="msg-audience-warning-list">
          {problems.map((problem: Problem, index: number) => (
            <li key={`${problem.code || "audience"}-${index}`}>{problem.message || problem.code}</li>
          ))}
        </ul>
        <p>
          This is not one person missing a value. It is a field this audience does not have, so every
          message here stays blocked until it is repaired, and the repair is a fallback:
          {" "}<code className="msg-code">{"{{job_title|the role}}"}</code>. Nothing is ever substituted
          for you, because a value that reads like the truth and is not is worse than a blank.
        </p>
      </div>
    );
  }

  renderAudience() {
    const { audience, applicants, profiles } = this.state;
    const counts: Record<string, number> = {};
    counts[AUDIENCE.APPLICANTS] = applicants.length;
    counts[AUDIENCE.CONNECTIONS] = profiles.length;
    return (
      <section className="pv-panel msg-panel">
        <div className="msg-panel-head">
          <h2>Audience</h2>
        </div>
        <div className="msg-audience">
          {AUDIENCE_IDS.map((id: string) => {
            const described = describeAudience(id);
            return (
              <button
                className={id === audience
                  ? "msg-audience-option msg-audience-option-current"
                  : "msg-audience-option"}
                type="button"
                key={id}
                aria-pressed={id === audience}
                onClick={() => this.setState({ audience: id, visibleCount: PAGE_STEP, previewId: "", copiedId: "" })}
              >
                <span className="msg-audience-label">{described.label}</span>
                <span className="msg-audience-count">{counts[id] || 0} collected</span>
              </button>
            );
          })}
        </div>
        {this.renderAudienceWarning()}
      </section>
    );
  }

  renderReasons(preview: Preview, ready: boolean) {
    const reasons = ready ? [] : blockReasons(preview, ready);
    if (!reasons.length) return null;
    return (
      <ul className="msg-reasons">
        {reasons.map((reason: string, index: number) => (
          <li className="msg-reason" key={index}>{reason}</li>
        ))}
      </ul>
    );
  }

  renderWarnings(preview: Preview) {
    if (!preview.warnings.length) return null;
    return (
      <ul className="msg-warnings">
        {preview.warnings.map((warning: any, index: number) => (
          <li className="msg-warning" key={`${warning.code || "warning"}-${index}`}>
            {warning.message || warning.code}
          </li>
        ))}
      </ul>
    );
  }

  /** One person, chosen, rendered in full. */
  renderPreview() {
    const entries = this.verdicts();
    if (!entries.length) {
      return (
        <section className="pv-panel msg-panel">
          <div className="msg-panel-head"><h2>Preview</h2></div>
          <p className="msg-empty">
            Nobody in this audience has been collected yet, so there is nothing to render this message
            against.
          </p>
        </section>
      );
    }
    const chosen = entries.filter((entry) => entry.person.id === this.state.previewId)[0] || entries[0];
    return (
      <section className="pv-panel msg-panel">
        <div className="msg-panel-head"><h2>Preview</h2></div>
        <div className="msg-preview-head">
          <span className="pv-label">Rendered for</span>
          <select
            className="msg-select"
            value={chosen.person.id}
            onChange={(event: any) => this.setState({ previewId: event.target.value })}
          >
            {entries.slice(0, PREVIEW_CHOICES).map((entry) => (
              <option value={entry.person.id} key={entry.person.id}>
                {entry.person.name || "(no name collected)"}
              </option>
            ))}
          </select>
          <span className={chosen.ready ? "msg-status msg-status-ready" : "msg-status msg-status-blocked"}>
            {chosen.ready ? "Ready" : "Blocked"}
          </span>
        </div>
        {this.renderReasons(chosen.preview, chosen.ready)}
        {this.renderWarnings(chosen.preview)}
        <p className="msg-preview-text">{chosen.preview.text}</p>
        <p className="msg-note">
          What you see is what it says. A variable that found no value leaves a gap here, and that gap
          is why the message is blocked — it is never filled in with a stand-in.
        </p>
      </section>
    );
  }

  renderPerson(entry: Verdict) {
    const { person, preview, ready } = entry;
    const copied = this.state.copiedId === person.id;
    const checked = this.state.selectedIds.includes(person.id);
    const runState = this.runStateFor(person.id);
    return (
      <li className={ready ? "msg-recipient" : "msg-recipient msg-recipient-blocked"} key={person.id}>
        <div className="msg-recipient-head">
          <span className="msg-recipient-who">
            {/* Disabled rather than hidden for a blocked person: the box being
                visibly un-tickable is what explains why select-all passed them
                over. A hidden control looks like an oversight. */}
            <input
              className="msg-recipient-pick"
              type="checkbox"
              checked={checked && ready}
              disabled={!ready || this.runIsLive()}
              aria-label={ready
                ? `Send to ${person.name || "this person"}`
                : `${person.name || "This person"} is blocked and cannot be sent to`}
              title={ready ? "Include this person in a run" : "A blocked message cannot be sent"}
              onChange={() => this.toggleSelected(person.id)}
            />
            <span className="msg-recipient-name">{person.name || "(no name collected)"}</span>
            {person.subtitle ? <span className="msg-recipient-sub">{person.subtitle}</span> : null}
          </span>
          <span className="msg-recipient-actions">
            {runState ? <span className={runStateClass(runState)}>{runStateLabel(runState)}</span> : null}
            <span className={ready ? "msg-status msg-status-ready" : "msg-status msg-status-blocked"}>
              {ready ? "Ready" : "Blocked"}
            </span>
            <button
              className="secondary small"
              type="button"
              disabled={!ready}
              title={ready ? "Copy this message" : "A blocked message cannot be used"}
              onClick={() => this.copyText(preview.text, person.id)}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        </div>
        {this.renderReasons(preview, ready)}
        <p className="msg-recipient-body">{preview.text}</p>
      </li>
    );
  }

  renderPeople() {
    const { search, visibleCount, audience, selectedIds } = this.state;
    const entries = this.verdicts();
    const readyEntries = entries.filter((entry) => entry.ready);
    const ready = readyEntries.length;
    const allReadyPicked = ready > 0 && readyEntries.every((entry) => selectedIds.includes(entry.person.id));
    const described = describeAudience(audience);
    const visible = entries.slice(0, visibleCount);
    return (
      <section className="pv-panel msg-panel">
        <div className="msg-panel-head">
          <h2>{described.label}</h2>
          <span className="msg-count">
            {ready} ready · {entries.length - ready} blocked · {entries.length} total
          </span>
        </div>
        <div className="msg-toolbar">
          <input
            className="msg-search"
            type="search"
            value={search}
            placeholder="Search these people"
            onChange={(event: any) => this.setState({ search: event.target.value, visibleCount: PAGE_STEP })}
          />
          {/* Scoped to everyone the search matches, not to the slice currently
              painted — the list grows with "Show more" rather than paging, so
              "all" meaning "the first 25" would be a trap. */}
          <button
            className="secondary small"
            type="button"
            disabled={!ready || this.runIsLive()}
            onClick={() => this.toggleAllReady(entries)}
          >
            {allReadyPicked ? `Clear ${ready} selected` : `Select ${ready} ready`}
          </button>
          <button className="secondary small" type="button" disabled={!ready} onClick={this.copyAll}>
            Copy every ready message
          </button>
          <button className="secondary small" type="button" disabled={!entries.length} onClick={this.exportCsv}>
            Export CSV
          </button>
        </div>
        {entries.length ? (
          <ul className="msg-recipients">
            {visible.map((entry: Verdict) => this.renderPerson(entry))}
          </ul>
        ) : (
          <p className="msg-empty">Nobody here matches. Collect people first, or clear the search.</p>
        )}
        {entries.length > visible.length ? (
          <button
            className="secondary msg-more"
            type="button"
            onClick={() => this.setState({ visibleCount: visibleCount + PAGE_STEP })}
          >
            Show {Math.min(PAGE_STEP, entries.length - visible.length)} more
          </button>
        ) : null}
        <p className="msg-note">
          Blocked people cannot be ticked and are never swept up by Select. A message with a hole in
          it stays here rather than going out with the gap in it.
        </p>
      </section>
    );
  }

  /**
   * The live run's own numbers.
   *
   * Rendered only when a run has been seen, and it outlives the run itself on
   * purpose: after a walk finishes the counts are the only record the recruiter
   * has of what went out, and clearing them the moment the state turns `done`
   * would answer "did that work?" with a blank panel.
   */
  renderRunProgress() {
    const run = this.state.run;
    if (!run) return null;
    const waiting = secondsLeft(run.waitMs);
    return (
      <div className="msg-run-progress">
        <span className="msg-count">
          {run.sent} sent · {run.skipped} skipped · {run.failed} failed · {run.pending} left
        </span>
        {run.state === "running" && run.currentName ? (
          <p className="msg-run-current">Open now: {run.currentName}</p>
        ) : null}
        {/* A queue honouring its gap looks identical to a queue that has hung.
            Saying which, with the number counting down, is the difference
            between waiting and pressing Stop on something that was working. */}
        {waiting > 0 ? (
          <p className="msg-run-waiting">
            Waiting {waiting}s before the next person — the gap between messages.
          </p>
        ) : null}
        {run.state === "stopped" ? (
          <p className="msg-run-waiting">Stopped. Everyone already messaged stays messaged.</p>
        ) : null}
        {run.state === "done" ? <p className="msg-run-waiting">Finished.</p> : null}
      </div>
    );
  }

  /**
   * Start, Stop, and the confirmation between the recruiter and a hundred
   * messages they cannot recall.
   *
   * Stop is rendered unconditionally — rule 12 — and never disabled. It is not
   * gated on `runIsLive()` because that reads a status reply that is always a
   * moment old, and the one moment a Stop must work is the moment this page is
   * wrong about whether anything is running.
   */
  renderRun() {
    const { selectedIds, confirming, starting } = this.state;
    const count = this.selectedVerdicts().length;
    const stale = selectedIds.length - count;
    const gap = Math.round(Number(QUEUE_LIMITS.MIN_GAP_MS || 30000) / 1000);
    const cap = Number(QUEUE_LIMITS.DAILY_CAP || 50);
    const live = this.runIsLive();
    return (
      <section className="pv-panel msg-panel">
        <div className="msg-panel-head">
          <h2>Send</h2>
          <span className="msg-count">{count} selected</span>
        </div>

        {/* Ticked, then edited out of readiness. Said plainly, because the
            number beside Start silently shrinking is the kind of thing a
            recruiter notices afterwards and cannot explain. */}
        {stale > 0 ? (
          <p className="msg-note">
            {stale} ticked {stale === 1 ? "person is" : "people are"} no longer ready for this
            template and will be left out.
          </p>
        ) : null}

        <p className="msg-note">
          A run opens each person on LinkedIn, types the message and sends it. It waits {gap}s
          between people and stops after {cap} in a day.
        </p>

        {confirming ? (
          <div className="msg-confirm" role="alertdialog" aria-label="Confirm this run">
            <p className="msg-confirm-text">
              Send to {count} {count === 1 ? "person" : "people"}? Messages cannot be recalled once
              sent.
            </p>
            <div className="msg-actions">
              <button className="danger" type="button" onClick={this.startRun}>
                Send to {count}
              </button>
              <button className="secondary" type="button" onClick={this.cancelStart}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="msg-actions">
            <button
              className="primary"
              type="button"
              disabled={!count || live || starting}
              title={live ? "A run is already going" : ""}
              onClick={this.askToStart}
            >
              {live ? "Running…" : `Start a run${count ? ` (${count})` : ""}`}
            </button>
            <button className="danger" type="button" onClick={this.stopRun}>
              Stop
            </button>
          </div>
        )}

        {this.renderRunProgress()}
      </section>
    );
  }

  render() {
    const { message, messageKind } = this.state;
    return (
      <main className="dashboard-shell">
        <NavBar current="messages" />
        <header className="dashboard-header">
          <div>
            <h1>Messages</h1>
            <p>
              Write one message, then read it back as each person would receive it. A message missing a
              value is blocked rather than patched, because a wrong value is worse than a blank one.
              Ticked people can be sent to in a run, one at a time, and a sent message cannot be
              recalled.
            </p>
          </div>
          <div className="header-actions">
            <button className="secondary" type="button" onClick={this.refresh}>Refresh</button>
          </div>
        </header>

        {/* The slot holds its height whether or not it has anything to say, so a
            message arriving does not move everything below it. */}
        <div className="pv-slot">
          {message ? <div className={`message ${messageKind}`.trim()} role="status">{message}</div> : null}
        </div>

        {this.renderCoreWarning()}

        <div className="msg-layout">
          <div className="msg-column">
            {this.renderTemplates()}
            {this.renderEditor()}
          </div>
          <div className="msg-column">
            {this.renderAudience()}
            {this.renderPreview()}
            {this.renderRun()}
            {this.renderPeople()}
          </div>
        </div>
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Messages root element is missing.");
ReactDOM.render(<MessagesApp />, root);
