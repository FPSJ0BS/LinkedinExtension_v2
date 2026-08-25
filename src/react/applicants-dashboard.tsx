import { clearApplicants, deleteApplicant, getAllApplicants } from "../applicant-db.js";
import { APPLICANT_TABLE_COLUMNS, downloadApplicantCsv, formatEducation, formatExperience, formatQualification, formatScreening, resumeFile, resumeLink, resumeSummary } from "../applicant-csv.js";
import { downloadJson } from "../csv.js";
import { APPLICANT_MESSAGES, STOP_ALL, type ApplicantRecord } from "../messages.js";
import { NavBar } from "./nav.js";
import { type StatusKind } from "./types.js";

// React 16.0.0 is a global, not an import, and it has no hooks, no Fragments
// and no createRoot. Class components only — see CLAUDE.md.
const React: any = (globalThis as any).React;
const ReactDOM: any = (globalThis as any).ReactDOM;

const PAGE_SIZES = [25, 50];
const POLL_MS = 3000;

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
    recollect: false
  };

  private timer: any = null;

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
          <button className="danger ghost small" type="button" onClick={() => this.removeApplicant(record)}>Remove</button>
        </td>
      </tr>
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
        <NavBar current="applicants" />
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
