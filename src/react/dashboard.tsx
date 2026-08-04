import { clearProfiles, deleteProfile, getAllProfiles, getProfile, repairStoredProfiles, saveProfile } from "../db.js";
import { csvToProfiles, downloadCsv } from "../csv.js";
import {
  arrayToLines,
  findSharedContactValues,
  linesToArray,
  mergeProfiles,
  normalizeProfile,
  stripSharedContactValues
} from "../profile-utils.js";
import { ARRAY_FIELDS, EMPTY_PROFILE, type ProfileRecord, type StatusKind } from "./types.js";

const React: any = (globalThis as any).React;
const ReactDOM: any = (globalThis as any).ReactDOM;
const PAGE_SIZE = 25;

interface DashboardState {
  profiles: ProfileRecord[];
  invalidRecords: any[];
  search: string;
  /** Narrow to rows whose collection ended a particular way. */
  statusFilter: string;
  /** Narrow to rows that actually carry the value the run is for. */
  contactFilter: string;
  sortBy: string;
  currentPage: number;
  selectedIds: string[];
  editorProfile: ProfileRecord | null;
  /** The row whose full company and education cards are open. */
  detailsProfile: ProfileRecord | null;
  message: string;
  messageKind: StatusKind;
}

/**
 * Summaries for the main table.
 *
 * The table used to render every card inside its cells, which made rows metres
 * tall and the page unusable. Every cell is now a short summary with a "See
 * more" into the details view, which is where the whole value lives.
 */
function summarizeList(values: string[] = [], shownCount: number): { shown: string[]; extra: number } {
  const shown = values.slice(0, shownCount);
  return { shown, extra: Math.max(0, values.length - shown.length) };
}

function summarizeSkills(skills: string[] = []) {
  return summarizeList(skills, 3);
}

/** The first institution, and how many more there are. */
function summarizeEducation(entries: string[] = []) {
  return summarizeList(entries, 1);
}

function isOpenToWork(profile: ProfileRecord): boolean {
  return (profile.openToWorkDetails || []).length > 0;
}

function compact(value: unknown): string {
  return Array.isArray(value) ? value.join("\n") : String(value ?? "");
}

function formatDate(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return "—";
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : text;
}

/** The CV cell's label: the file name when there is one, otherwise "CV". */
function cvLabel(profile: ProfileRecord): string {
  return String(profile.cvFileName || "") || "CV";
}

/**
 * A cell that shows a little and offers the rest.
 *
 * `See more` is the same affordance everywhere — it opens the row's details
 * panel — so a long skill list, a long note and a full Open to work panel are
 * all reachable without any of them making the row taller.
 */
function CompactCell(props: { children?: any; more?: boolean; onMore: () => void; className?: string; label?: string }) {
  return (
    // `data-label` is what the cell is called. It is presentation only — below
    // 860px the table becomes one card per row and the stylesheet reads it back
    // out as the field name, because a horizontal scrollbar on a narrow window
    // is not a table anybody can read.
    // The content is wrapped in `.cell-clip` because the three-line clamp needs
    // a box display, and a `<td>` given one stops being a table cell and takes
    // its whole column out of the table's layout. The wrapper is not a cell.
    <td className={props.className || "summary-cell"} data-label={props.label}>
      <span className="cell-clip">
        {props.children}
        {props.more ? (
          <button className="link-button" type="button" onClick={props.onMore}>See more</button>
        ) : null}
      </span>
    </td>
  );
}

function InputField(props: {
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
        onChange={(event: any) => props.onChange(props.name, event.target.value)}
      />
    </label>
  );
}

function EditorTextArea(props: {
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

class DashboardApp extends React.Component {
  private fileInput: HTMLInputElement | null = null;
  private messageTimer: any = null;

  state: DashboardState = {
    profiles: [],
    invalidRecords: [],
    search: "",
    statusFilter: "",
    contactFilter: "",
    sortBy: "updatedDesc",
    currentPage: 1,
    selectedIds: [],
    editorProfile: null,
    detailsProfile: null,
    message: "",
    messageKind: ""
  };

  componentDidMount() {
    this.repairThenReload();
  }

  /**
   * Migrate what is already stored before showing it.
   *
   * A record written by an earlier release still carries the fields 3.6.0
   * retired, has no `status`, `cvFileName` or `lastCollectedAt`, and may hold a
   * mobile number that is really the digits at the end of the member's own
   * vanity URL. `normalizeProfile` fixes all of that on read, so this only has
   * to persist the rows it changed.
   */
  repairThenReload = async () => {
    let repaired = 0;
    try {
      repaired = await repairStoredProfiles();
    } catch {
      // A migration that cannot run must never stop the table from loading.
    }
    await this.reload();
    if (repaired) this.showMessage(`Updated ${repaired} saved profile(s) to the current record format.`, "success");
  };

  /**
   * The second half of the cleanup, and the half that needs a decision.
   *
   * An address or number that appears on three or more different people came
   * from a block that renders other members, not from any of them. Which values
   * those are can only be seen across the whole table, and removing somebody's
   * real details would be worse than leaving a wrong one, so it is shown and
   * confirmed rather than done silently.
   */
  cleanSharedContacts = async () => {
    const shared = findSharedContactValues(this.state.profiles, 3);
    if (!shared.length) return this.showMessage("No address or number is shared across profiles.", "success");
    const preview = shared.slice(0, 8).map((entry) => `${entry.value} (on ${entry.sharedBy})`).join("\n");
    const extra = shared.length > 8 ? `\n…and ${shared.length - 8} more` : "";
    if (!confirm(`Remove ${shared.length} contact value(s) that appear on 3 or more different profiles?\n\n${preview}${extra}`)) return;
    try {
      let changed = 0;
      for (const profile of this.state.profiles) {
        const stripped = stripSharedContactValues(profile, shared);
        if (!stripped) continue;
        await saveProfile(stripped);
        changed += 1;
      }
      await this.reload();
      this.showMessage(`Removed shared contact values from ${changed} profile(s).`, "success");
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  componentWillUnmount() {
    if (this.messageTimer) clearTimeout(this.messageTimer);
  }

  showMessage = (message: string, messageKind: StatusKind = "") => {
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.setState({ message, messageKind });
    this.messageTimer = setTimeout(() => this.setState({ message: "", messageKind: "" }), 3500);
  };

  reload = async () => {
    try {
      const result = await getAllProfiles();
      this.setState({ profiles: result.profiles, invalidRecords: result.invalid });
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  filteredProfiles(): ProfileRecord[] {
    const { profiles, statusFilter, contactFilter, search, sortBy } = this.state;
    const query = search.trim().toLowerCase();
    const result = profiles.filter((profile) => {
      if (statusFilter && String(profile.status || "") !== statusFilter) return false;
      // The run exists to produce reachable people, so "who has an email?" and
      // "who has a CV?" are first-class filters rather than a search string.
      if (contactFilter === "hasCv" && !profile.cvUrl) return false;
      if (contactFilter === "hasEmail" && !profile.email) return false;
      if (contactFilter === "hasMobile" && !profile.mobile) return false;
      if (contactFilter === "openToWork" && !isOpenToWork(profile)) return false;
      if (contactFilter === "missingContact" && (profile.email || profile.mobile)) return false;
      if (!query) return true;
      return Object.values(profile).some((value) => compact(value).toLowerCase().includes(query));
    });

    const compareText = (left: ProfileRecord, right: ProfileRecord, key: string) =>
      String((left as any)[key] || "").localeCompare(String((right as any)[key] || ""));

    if (sortBy === "nameAsc") result.sort((a, b) => compareText(a, b, "fullName"));
    else if (sortBy === "statusAsc") result.sort((a, b) => compareText(a, b, "status"));
    else if (sortBy === "collectedDesc") {
      result.sort((a, b) => String(b.lastCollectedAt || "").localeCompare(String(a.lastCollectedAt || "")));
    }
    else result.sort((a, b) => String(b.updatedAt || b.collectedAt).localeCompare(String(a.updatedAt || a.collectedAt)));
    return result;
  }

  pageData() {
    const filtered = this.filteredProfiles();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const currentPage = Math.min(this.state.currentPage, pages);
    const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    return { filtered, pages, currentPage, pageRows };
  }

  setFilter = (name: string, value: string) => {
    this.setState({ [name]: value, currentPage: 1 } as any);
  };

  toggleSelected = (id: string, selected: boolean) => {
    const selectedIds = new Set(this.state.selectedIds);
    if (selected) selectedIds.add(id);
    else selectedIds.delete(id);
    this.setState({ selectedIds: [...selectedIds] });
  };

  toggleVisible = (selected: boolean) => {
    const selectedIds = new Set(this.state.selectedIds);
    for (const profile of this.pageData().pageRows) {
      if (selected) selectedIds.add(String(profile.id));
      else selectedIds.delete(String(profile.id));
    }
    this.setState({ selectedIds: [...selectedIds] });
  };

  openEditor = async (profile?: ProfileRecord) => {
    try {
      const fullProfile = profile?.id ? await getProfile(profile.id) : null;
      this.setState({ editorProfile: normalizeProfile(fullProfile || { ...EMPTY_PROFILE }) as ProfileRecord });
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  updateEditor = (name: string, value: string) => {
    this.setState((previous: DashboardState) => {
      if (!previous.editorProfile) return null;
      const editorProfile = { ...previous.editorProfile } as ProfileRecord;
      (editorProfile as any)[name] = ARRAY_FIELDS.has(name) ? linesToArray(value) : value;
      return { editorProfile };
    });
  };

  saveEditor = async (event: any) => {
    event.preventDefault();
    if (!this.state.editorProfile) return;
    try {
      await saveProfile(normalizeProfile(this.state.editorProfile));
      this.setState({ editorProfile: null });
      await this.reload();
      this.showMessage("Profile saved.", "success");
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  removeProfile = async (profile: ProfileRecord) => {
    if (!profile.id || !confirm(`Delete ${profile.fullName || "this profile"}?`)) return;
    try {
      await deleteProfile(profile.id);
      this.setState({ selectedIds: this.state.selectedIds.filter((id) => id !== profile.id) });
      await this.reload();
      this.showMessage("Profile deleted.", "success");
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  selectedProfiles(): ProfileRecord[] {
    const selected = new Set(this.state.selectedIds);
    return this.state.profiles.filter((profile) => profile.id && selected.has(profile.id));
  }

  exportAll = () => {
    try {
      downloadCsv(this.state.profiles);
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  exportSelected = () => {
    try {
      const selected = this.selectedProfiles();
      if (!selected.length) throw new Error("Select at least one profile.");
      downloadCsv(selected);
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  deleteSelected = async () => {
    const selected = this.selectedProfiles();
    if (!selected.length) return this.showMessage("Select at least one profile.", "error");
    if (!confirm(`Delete ${selected.length} selected profile(s)?`)) return;
    try {
      for (const profile of selected) if (profile.id) await deleteProfile(profile.id);
      this.setState({ selectedIds: [] });
      await this.reload();
      this.showMessage("Selected profiles deleted.", "success");
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  clearAll = async () => {
    if (!this.state.profiles.length || !confirm("Delete every saved profile? This cannot be undone.")) return;
    try {
      await clearProfiles();
      this.setState({ selectedIds: [] });
      await this.reload();
      this.showMessage("All profiles were removed.", "success");
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    }
  };

  importCsv = async (event: any) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = csvToProfiles(await file.text());
      let created = 0;
      let merged = 0;
      const byUrl = new Map(
        this.state.profiles.filter((profile) => profile.profileUrl).map((profile) => [profile.profileUrl, profile])
      );
      for (const incoming of imported) {
        const existing = incoming.profileUrl ? byUrl.get(incoming.profileUrl) : null;
        if (existing) {
          await saveProfile(mergeProfiles(existing, incoming));
          merged += 1;
        } else {
          await saveProfile(incoming);
          created += 1;
        }
      }
      await this.reload();
      this.showMessage(`CSV imported: ${created} created, ${merged} merged.`, "success");
    } catch (error) {
      this.showMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      event.target.value = "";
    }
  };

  /**
   * The details view. Everything the table deliberately does not render inline —
   * the full company cards with their nested roles, the institution cards, the
   * whole skill list, the about text — lives here.
   */
  renderDetails() {
    const profile = this.state.detailsProfile;
    if (!profile) return null;
    const close = () => this.setState({ detailsProfile: null });
    return (
      <div className="details-backdrop" role="dialog" aria-modal="true" aria-label={`Details for ${profile.fullName}`}>
        <div className="details-panel">
          <header className="details-head">
            <div>
              <h2>{profile.fullName || "Profile"}</h2>
              <p>{[profile.status, isOpenToWork(profile) ? "Open to work" : ""].filter(Boolean).join(" · ")}</p>
            </div>
            <button className="secondary small" type="button" onClick={close}>Close</button>
          </header>

          {/* The record, in the order the table shows it. */}
          <dl className="details-facts">
            <div><dt>Email</dt><dd>{profile.email ? <a href={`mailto:${profile.email}`}>{profile.email}</a> : "—"}</dd></div>
            <div><dt>Mobile</dt><dd>{profile.mobile ? <a href={`tel:${profile.mobile}`}>{profile.mobile}</a> : "—"}</dd></div>
            <div>
              <dt>CV</dt>
              <dd>{profile.cvUrl ? <a href={profile.cvUrl} target="_blank" rel="noreferrer">{cvLabel(profile)}</a> : "—"}</dd>
            </div>
            <div><dt>Profile</dt><dd>{profile.profileUrl ? <a href={profile.profileUrl} target="_blank" rel="noreferrer">Open on LinkedIn</a> : "—"}</dd></div>
            <div><dt>Status</dt><dd>{profile.status || "—"}</dd></div>
            <div><dt>Last collected</dt><dd>{formatDate(profile.lastCollectedAt)}</dd></div>
          </dl>

          {/* Only worth its own block when a profile carried more than one. */}
          {profile.cvLinks.length > 1 || profile.emails.length > 1 || profile.phones.length > 1 ? (
            <section className="details-section">
              <h3>All contact details</h3>
              <ul className="details-list">
                {profile.cvLinks.map((entry) => <li key={`cv-${entry}`}>CV: {entry}</li>)}
                {profile.emails.map((entry) => <li key={`em-${entry}`}>Email: {entry}</li>)}
                {profile.phones.map((entry) => <li key={`ph-${entry}`}>Phone: {entry}</li>)}
              </ul>
            </section>
          ) : null}

          {profile.openToWorkDetails.length ? (
            <section className="details-section">
              <h3>Open to work</h3>
              <ul className="details-list">
                {profile.openToWorkDetails.map((entry) => <li key={entry}>{entry}</li>)}
              </ul>
            </section>
          ) : null}

          <section className="details-section">
            <h3>Education ({profile.education.length})</h3>
            <ul className="details-list">
              {profile.education.length ? profile.education.map((entry) => <li key={entry}>{entry}</li>) : <li>—</li>}
            </ul>
          </section>

          <section className="details-section">
            <h3>Skills ({profile.skills.length})</h3>
            <div className="chip-list">
              {profile.skills.length ? profile.skills.map((skill) => <span className="chip" key={skill}>{skill}</span>) : "—"}
            </div>
          </section>

          {profile.tags.length ? (
            <section className="details-section">
              <h3>Tags</h3>
              <div className="chip-list">{profile.tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}</div>
            </section>
          ) : null}

          {profile.notes ? <section className="details-section"><h3>Notes</h3><p>{profile.notes}</p></section> : null}

          <footer className="details-foot">
            <button className="secondary" type="button" onClick={() => { close(); this.openEditor(profile); }}>Edit</button>
            <button className="secondary" type="button" onClick={close}>Close</button>
          </footer>
        </div>
      </div>
    );
  }

  renderEditor() {
    const profile = this.state.editorProfile;
    if (!profile) return null;
    const textValue = (key: string) => String((profile as any)[key] ?? "");
    const listValue = (key: string) => arrayToLines((profile as any)[key] || []);
    return (
      <div className="modal-backdrop" role="presentation" onMouseDown={(event: any) => {
        if (event.target === event.currentTarget) this.setState({ editorProfile: null });
      }}>
        <section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editorTitle">
          <form onSubmit={this.saveEditor}>
            <h2 id="editorTitle">{profile.id ? "Edit profile" : "Add profile manually"}</h2>
            <div className="editor-grid">
              <InputField label="Full name" name="fullName" value={textValue("fullName")} onChange={this.updateEditor} />
              <InputField label="Email" name="email" type="email" value={textValue("email")} onChange={this.updateEditor} />
              <InputField label="Mobile number" name="mobile" value={textValue("mobile")} onChange={this.updateEditor} />
              <InputField label="Status" name="status" value={textValue("status")} onChange={this.updateEditor} />
              <InputField label="CV / resume URL" name="cvUrl" type="url" value={textValue("cvUrl")} onChange={this.updateEditor} wide />
              <InputField label="Profile URL" name="profileUrl" type="url" value={textValue("profileUrl")} onChange={this.updateEditor} wide />
              <EditorTextArea
                label="Open to work"
                name="openToWorkDetails"
                value={listValue("openToWorkDetails")}
                onChange={this.updateEditor}
                rows={5}
                placeholder="One labelled line per field, e.g. Job titles: Software Engineer"
              />
              <EditorTextArea
                label="Education"
                name="education"
                value={listValue("education")}
                onChange={this.updateEditor}
                rows={4}
                placeholder="One institution name per line"
              />
              <EditorTextArea label="Skills" name="skills" value={listValue("skills")} onChange={this.updateEditor} rows={4} />
              <EditorTextArea label="All email addresses" name="emails" value={listValue("emails")} onChange={this.updateEditor} rows={2} />
              <EditorTextArea label="All phone numbers" name="phones" value={listValue("phones")} onChange={this.updateEditor} rows={2} />
              <EditorTextArea label="CV / resume links" name="cvLinks" value={listValue("cvLinks")} onChange={this.updateEditor} rows={2} />
              <EditorTextArea label="Notes" name="notes" value={textValue("notes")} onChange={this.updateEditor} rows={3} />
              <EditorTextArea label="Tags" name="tags" value={listValue("tags")} onChange={this.updateEditor} rows={2} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => this.setState({ editorProfile: null })}>Cancel</button>
              <button type="submit" className="primary">Save</button>
            </div>
          </form>
        </section>
      </div>
    );
  }

  render() {
    const { profiles, invalidRecords, selectedIds, message, messageKind } = this.state;
    const { filtered, pages, currentPage, pageRows } = this.pageData();
    const selected = new Set(selectedIds);
    const allVisibleSelected = pageRows.length > 0 && pageRows.every((profile) => profile.id && selected.has(profile.id));
    const statuses = [...new Set(profiles.map((profile) => String(profile.status || "")).filter(Boolean))].sort();
    const openDetails = (profile: ProfileRecord) => () => this.setState({ detailsProfile: profile });

    return (
      <main className="dashboard-shell">
        <header className="dashboard-header">
          <div>
            <h1>Saved Profiles</h1>
            <p>
              {profiles.length} profile{profiles.length === 1 ? "" : "s"} saved · {filtered.length} shown
              {invalidRecords.length ? ` · ${invalidRecords.length} invalid record(s) ignored` : ""}
            </p>
          </div>
          <div className="header-actions">
            <button className="secondary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("import.html") })}>Open Connections Collector</button>
            <button className="secondary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("applicants.html") })}>Open Job Applicants</button>
            <button className="secondary" onClick={() => this.openEditor()}>Add manually</button>
            <button className="secondary" onClick={() => this.fileInput?.click()}>Import CSV</button>
            <input
              ref={(element: HTMLInputElement | null) => { this.fileInput = element; }}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={this.importCsv}
            />
            <button className="secondary" onClick={this.exportSelected}>Export selected</button>
            <button className="primary" onClick={this.exportAll}>Export all CSV</button>
          </div>
        </header>

        <section className="toolbar" aria-label="Profile table controls">
          <input
            type="search"
            placeholder="Search name, email, mobile, institution, skill…"
            value={this.state.search}
            onChange={(event: any) => this.setFilter("search", event.target.value)}
          />
          <select value={this.state.statusFilter} onChange={(event: any) => this.setFilter("statusFilter", event.target.value)} aria-label="Filter by status">
            <option value="">Any status</option>
            {statuses.map((status) => <option value={status} key={status}>{status}</option>)}
          </select>
          <select value={this.state.contactFilter} onChange={(event: any) => this.setFilter("contactFilter", event.target.value)} aria-label="Filter by contact details">
            <option value="">Any contact details</option>
            <option value="hasCv">Has a CV</option>
            <option value="hasEmail">Has an email</option>
            <option value="hasMobile">Has a mobile number</option>
            <option value="openToWork">Open to work</option>
            <option value="missingContact">No email or mobile</option>
          </select>
          <select value={this.state.sortBy} onChange={(event: any) => this.setFilter("sortBy", event.target.value)} aria-label="Sort profiles">
            <option value="updatedDesc">Recently updated</option>
            <option value="collectedDesc">Recently collected</option>
            <option value="nameAsc">Name A–Z</option>
            <option value="statusAsc">Status</option>
          </select>
          <button className="secondary" onClick={this.cleanSharedContacts}>Clean shared contacts</button>
          <button className="danger" onClick={this.deleteSelected}>Delete selected</button>
          <button className="danger ghost" onClick={this.clearAll}>Clear all</button>
        </section>

        {/* Reserved, so a message arriving does not move the table below it. */}
        <div className="pv-slot">
          {message ? <div className={`message ${messageKind}`.trim()} role="status">{message}</div> : null}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" checked={allVisibleSelected} onChange={(event: any) => this.toggleVisible(event.target.checked)} aria-label="Select visible profiles" /></th>
                {/* Pinned to the left as a pair with the body cell below it. */}
                <th className="name-cell">Name</th><th>Email</th><th>Mobile</th><th>CV</th><th>Open to Work</th>
                <th>Education</th><th>Skills</th><th>Profile URL</th><th>Status</th>
                <th>Last Collected</th><th>Notes</th><th>Tags</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length ? pageRows.map((profile) => {
                const education = summarizeEducation(profile.education);
                const skills = summarizeSkills(profile.skills);
                const more = openDetails(profile);
                return (
                <tr key={profile.id || profile.profileUrl}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(profile.id && selected.has(profile.id))}
                      onChange={(event: any) => profile.id && this.toggleSelected(profile.id, event.target.checked)}
                      aria-label={`Select ${profile.fullName || "profile"}`}
                    />
                  </td>
                  <td className="name-cell">{profile.fullName}</td>
                  <CompactCell className="contact-cell" label="Email" more={profile.emails.length > 1} onMore={more}>
                    {profile.email ? <a href={`mailto:${profile.email}`}>{profile.email}</a> : "—"}
                  </CompactCell>
                  <CompactCell className="contact-cell" label="Mobile" more={profile.phones.length > 1} onMore={more}>
                    {profile.mobile ? <a href={`tel:${profile.mobile}`}>{profile.mobile}</a> : "—"}
                  </CompactCell>
                  <CompactCell label="CV" more={profile.cvLinks.length > 1} onMore={more}>
                    {profile.cvUrl ? <a href={profile.cvUrl} target="_blank" rel="noreferrer">{cvLabel(profile)}</a> : "—"}
                  </CompactCell>
                  <CompactCell label="Open to Work" more={isOpenToWork(profile)} onMore={more}>
                    {isOpenToWork(profile) ? "Yes" : "—"}
                  </CompactCell>
                  <CompactCell label="Education" more={education.extra > 0} onMore={more}>
                    {education.shown.length ? (
                      <span>
                        {education.shown[0]}
                        {education.extra ? <span className="chip more">+{education.extra} more</span> : null}
                      </span>
                    ) : "—"}
                  </CompactCell>
                  <CompactCell className="skills-cell" label="Skills" more={skills.extra > 0} onMore={more}>
                    {skills.shown.length ? (
                      <div className="chip-list">
                        {skills.shown.map((skill) => <span className="chip" key={skill}>{skill}</span>)}
                        {skills.extra ? <span className="chip more">+{skills.extra} more</span> : null}
                      </div>
                    ) : "—"}
                  </CompactCell>
                  <td className="contact-cell" data-label="Profile URL">
                    <span className="cell-clip">
                      {profile.profileUrl ? <a href={profile.profileUrl} target="_blank" rel="noreferrer">Open</a> : "—"}
                    </span>
                  </td>
                  <td data-label="Status"><span className={`status-pill ${profile.status}`.trim()}>{profile.status || "—"}</span></td>
                  <td data-label="Last Collected">{formatDate(profile.lastCollectedAt)}</td>
                  <CompactCell label="Notes" more={profile.notes.length > 60} onMore={more}>
                    {profile.notes ? profile.notes.slice(0, 60) : "—"}
                  </CompactCell>
                  <CompactCell label="Tags" more={profile.tags.length > 3} onMore={more}>
                    {profile.tags.length ? (
                      <div className="chip-list">
                        {profile.tags.slice(0, 3).map((tag) => <span className="chip" key={tag}>{tag}</span>)}
                      </div>
                    ) : "—"}
                  </CompactCell>
                  <td className="actions-cell">
                    <button className="secondary small" onClick={more}>View details</button>
                    <button className="secondary small" onClick={() => this.openEditor(profile)}>Edit</button>
                    <button className="danger small" onClick={() => this.removeProfile(profile)}>Delete</button>
                  </td>
                </tr>
                );
              }) : (
                <tr><td colSpan={14} className="empty">No profiles match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <nav className="pagination" aria-label="Pagination">
          <button className="secondary" disabled={currentPage <= 1} onClick={() => this.setState({ currentPage: currentPage - 1 })}>Previous</button>
          <span>Page {currentPage} of {pages}</span>
          <button className="secondary" disabled={currentPage >= pages} onClick={() => this.setState({ currentPage: currentPage + 1 })}>Next</button>
        </nav>
        {this.renderDetails()}
        {this.renderEditor()}
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Dashboard root element is missing.");
ReactDOM.render(<DashboardApp />, root);
