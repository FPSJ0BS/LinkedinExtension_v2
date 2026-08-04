/**
 * The applicant export.
 *
 * A separate column set from the connections export, because it is a separate
 * record — but it shares every rule that makes a CSV open correctly: the UTF-8
 * BOM, CRLF endings, every cell quoted, formula neutralization, and a leading
 * apostrophe on the columns a spreadsheet would otherwise turn into a number.
 * Those all live in [csv.js](./csv.js) and are imported rather than copied, so
 * a fix to one file fixes both exports.
 *
 * **The column order is the table's column order**, exactly as the connections
 * export mirrors the Saved Profiles table, and `APPLICANT_TABLE_COLUMNS` is
 * exported so a test holds the two in step. The structured columns follow.
 *
 * **The resume is two columns, since 3.7.6, and this is a deliberate removal.**
 * 3.7.4 gave it five — `resume_file`, `resume_status`, `resume_link`,
 * `resume_viewer`, `resume_saved_as` — and five columns to answer one question
 * is a table nobody can read across. The two that were asked for are the two
 * that are acted on: **where the resume is** and **which file we have**.
 * `resume_link` is now the address to reach it — the document when one was
 * found, the LinkedIn viewer page when that is all there is, because the point
 * of the cell is that clicking it opens the CV. `resume_file` is the file
 * itself — the saved copy's path when there is one, and the file name LinkedIn
 * showed when there is not. `resume_status`, `resume_viewer` and
 * `resume_saved_as` are gone as columns; every one of the underlying record
 * fields is kept, because `downloadStatus` is what stops the same file being
 * fetched twice and `viewerUrl`/`localReference` are what these two columns are
 * built out of. The details drawer still shows all three.
 *
 * **`qualifications` left the table the same way, and for the same reason.**
 * It was a table column in 3.7.7–3.7.8 and is detail from 3.7.9: a cell holding
 * one line per requirement is a paragraph in a table, and on a job with seven
 * must-haves it was the widest thing on every row. It is **demoted, not
 * dropped** — the whole list still exports, with each requirement's category,
 * verdict, explanation and source, and the details drawer still shows the
 * must-have and preferred lists in full.
 *
 * From here on the usual rule applies again: **append columns, never reorder.**
 */
import "./applicants-core.js";
import { buildCsvFile, downloadCsvText, escapeCell } from "./csv.js";

const Applicants = /** @type {any} */ (globalThis).ProfileVaultApplicants;

/**
 * The columns the applicants table shows, in the table's order.
 *
 * Restructured in 3.7.1 around what the export is actually read for. The
 * applicant's own **name** leads, then the two ways to reach them, then the
 * resume in **two** columns — where it is, and which file we have.
 * `job_title` and `location` were **dropped**: the job is a filter on the page,
 * not a column on every row, and the applicant's location is detail rather than
 * a reason to pick them.
 */
export const APPLICANT_TABLE_COLUMNS = Object.freeze([
  "applicant_name", "email", "mobile",
  "resume_link", "resume_file",
  "current_role", "current_company", "total_experience",
  "education"
]);

/**
 * Where to click to read this applicant's resume.
 *
 * The document when the page rendered one, and the LinkedIn viewer page when it
 * did not — which is most of the time, because the control's `href` on this
 * surface is a route and the file lives behind an opaque media address the
 * viewer fetches. The record keeps the two apart forever (`url` is only ever a
 * document; `isResumeDocumentUrl` refuses a linkedin.com address first, and the
 * worker refuses to download one) — this is a *cell*, and the question a cell
 * answers is "where do I click".
 */
export function resumeLink(record) {
  const resume = record?.applicant?.resume || {};
  return resume.url || resume.viewerUrl || "";
}

/**
 * The file itself.
 *
 * The saved copy's path under the downloads folder when the worker fetched one,
 * because that is the answer to "which file on disk is this person's CV". When
 * nothing was saved it falls back to the file name LinkedIn showed, which is
 * still worth having — it is what the applicant called their own resume.
 * Never invented: an applicant with neither exports an empty cell.
 */
export function resumeFile(record) {
  const resume = record?.applicant?.resume || {};
  return resume.localReference || resume.filename || "";
}

/**
 * Every column, in order: the table first, then the detail behind it.
 *
 * `read` takes the record and returns the cell's value. A list is returned as
 * an array and becomes one value per line inside the cell, which is what makes
 * five qualifications readable in a spreadsheet instead of one run-on string.
 */
export const APPLICANT_CSV_COLUMNS = [
  // --- the table, column for column -------------------------------------
  ["applicant_name", (record) => record.applicant.name],
  ["email", (record) => record.applicant.contact.email],
  ["mobile", (record) => record.applicant.contact.phone, { asText: true }],
  // The resume, in two columns and no more: where to click, and which file.
  ["resume_link", resumeLink],
  ["resume_file", resumeFile],
  ["current_role", (record) => record.applicant.currentRole],
  ["current_company", (record) => record.applicant.currentCompany],
  ["total_experience", (record) => record.applicant.totalExperience],
  // 3.7.7. Collected all along and buried in the detail block, so the question
  // a recruiter actually scans a shortlist for — "what did they study" — was
  // one the table could not answer. `education` moving up out of the detail
  // block is a **deliberate reorder**, the same kind 3.7.4 made.
  ["education", (record) => record.applicant.education.map(formatEducation)],

  // --- the detail the table keeps behind "View details" -----------------
  // `application_status` and `collected_at` were TABLE columns through 3.7.7 and
  // are detail from 3.7.8: the status was "—" on every row of the reference
  // account, and the timestamp is not something a shortlist is scanned down.
  // The two verdict tallies are gone outright rather than demoted — they are
  // computed from `qualifications`, so the tally was a summary of the column
  // below.
  //
  // `qualifications` was a TABLE column through 3.7.8 and is **detail from
  // here**, on request: one line per requirement made it the widest cell on the
  // row, and a job with seven must-haves turned every row into a paragraph.
  // Demoted, deliberately, and **not dropped** — every requirement, verdict,
  // explanation and source still exports here and still shows in the drawer.
  // The same treatment 3.7.4 gave `resume_status` and its two neighbours: the
  // column goes, the data does not.
  ["qualifications", (record) => qualificationRows(record)],
  ["application_status", (record) => record.applicant.applicationStatus],
  ["collected_at", (record) => record.collectedAt],
  // Every address and every number, not only the primary two: the contact
  // disclosure often shows more than one of each, and an export that kept only
  // the first would throw the rest away.
  ["all_emails", (record) => allOf(record, "email")],
  // Marked per entry rather than per cell: `asText` prefixes the whole cell,
  // which would leave the second number in a multi-line cell unprotected and
  // `04423456789` would lose its leading zero on the way into a spreadsheet.
  ["all_phone_numbers", (record) => allOf(record, "phone").map((value) => `'${value}`)],
  ["website", (record) => record.applicant.contact.website],
  ["profile_url", (record) => record.applicant.profileUrl],
  ["headline", (record) => record.applicant.headline],
  ["applied", (record) => record.applicant.appliedAt],
  ["contacted", (record) => record.applicant.contactedAt],
  ["must_have_qualifications", (record) => formatQualifications(record, "must_have")],
  ["preferred_qualifications", (record) => formatQualifications(record, "preferred")],
  ["screening_responses", (record) => record.applicant.screeningResponses.map(formatScreening)],
  ["experience", (record) => record.applicant.experience.map(formatExperience)],
  ["skills", (record) => record.applicant.skills],
  ["resume_file_type", (record) => record.applicant.resume.fileType],
  ["resume_pages", (record) => record.applicant.resume.pages],
  ["job_id", (record) => record.job.id],
  ["job_url", (record) => record.job.url],
  ["warnings", (record) => record.extraction.warnings],
  ["source_url", (record) => record.extraction.sourceUrl],
  ["last_updated", (record) => record.updatedAt],
  ["applicant_id", (record) => record.id]
];

/**
 * Columns a spreadsheet must not treat as a number.
 *
 * The same reason as the connections export: `9876543210` becomes 9.87654E+09
 * in Excel and `04423456789` silently loses its leading zero, so the number
 * that comes out of the file is not the number that went in.
 */
const TEXT_COLUMNS = new Set(
  APPLICANT_CSV_COLUMNS.filter(([, , options]) => options?.asText).map(([label]) => label)
);

/**
 * Every address, or every number, the record holds.
 *
 * The primary lives on `contact.email` / `contact.phone` and any further ones
 * were labelled into `contact.other` as `email: …` / `phone: …` when the record
 * was built. Both halves are put back together here so the export never drops
 * the second address a contact disclosure showed.
 */
export function allOf(record, kind) {
  const contact = record?.applicant?.contact || {};
  const primary = kind === "email" ? contact.email : contact.phone;
  const extras = (contact.other || [])
    .filter((entry) => String(entry).toLowerCase().startsWith(`${kind}:`))
    .map((entry) => String(entry).slice(kind.length + 1).trim());
  const seen = new Set();
  return [primary, ...extras].filter((value) => {
    const key = String(value ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "3 of 6" — how many of a category's requirements the platform said were met. */
export function qualificationTally(record, category) {
  const entries = (record?.applicant?.qualifications || []).filter((entry) => entry.category === category);
  if (!entries.length) return "";
  const matched = entries.filter((entry) => entry.result === "matched").length;
  return `${matched} of ${entries.length}`;
}

/** What the resume cell says at a glance. */
export function resumeSummary(record) {
  const resume = record?.applicant?.resume || {};
  if (!resume.available) return "none";
  return resume.filename ? `${resume.filename} (${resume.downloadStatus})` : resume.downloadStatus;
}

/**
 * One qualification per line, verdict first.
 *
 * `matched · <requirement> — <explanation> [source]`, with the source in
 * brackets so the recruiter can see at a glance which verdicts came from a
 * screening answer and which from the profile. Nothing is dropped: a
 * requirement with no explanation still prints, as `unknown`.
 */
export function formatQualification(entry) {
  const parts = [`${entry.result} · ${entry.requirement}`];
  if (entry.explanation) parts.push(`— ${entry.explanation}`);
  if (entry.source) parts.push(`[${entry.source}]`);
  return parts.join(" ");
}

function formatQualifications(record, category) {
  return (record?.applicant?.qualifications || [])
    .filter((entry) => entry.category === category)
    .map(formatQualification);
}

/**
 * One requirement per line, category first, for the combined column.
 *
 * The split `must_have_qualifications` / `preferred_qualifications` columns say
 * which is which by *being* two columns; a single column has to say it in the
 * cell, or a matched preferred and a matched must-have read identically. A
 * requirement LinkedIn filed under neither still prints, without a prefix —
 * it was still displayed to the recruiter, and dropping it would be the record
 * deciding something the platform did not.
 */
export function formatQualificationRow(entry) {
  const category = entry?.category === "must_have" ? "must-have"
    : entry?.category === "preferred" ? "preferred"
      : "";
  const line = formatQualification(entry);
  return category ? `${category}: ${line}` : line;
}

/** Every qualification the platform judged, in the order it displayed them. */
export function qualificationRows(record) {
  return (record?.applicant?.qualifications || []).map(formatQualificationRow);
}

/** The institutions, one per line — the shortlist question, not the full record. */
export function educationRows(record) {
  return (record?.applicant?.education || []).map(formatEducation);
}

/** `question — ideal: Yes · answered: Yes · met`. */
export function formatScreening(entry) {
  const parts = [entry.question];
  if (entry.idealAnswer) parts.push(`ideal: ${entry.idealAnswer}`);
  if (entry.answer) parts.push(`answered: ${entry.answer}`);
  // `met` is tri-state on purpose — "not stated" is not the same as "not met".
  parts.push(entry.met === true ? "met" : entry.met === false ? "not met" : "not stated");
  return parts.join(" · ");
}

/** `HR Manager — Naad Wellness (2026-Present) [verified]`. */
export function formatExperience(entry) {
  const parts = [entry.title];
  if (entry.company) parts.push(`— ${entry.company}`);
  if (entry.dateRange) parts.push(`(${entry.dateRange})`);
  if (entry.verified) parts.push("[verified]");
  return parts.filter(Boolean).join(" ");
}

/** `University of Delhi — Bachelor of Arts, Psychology (2018-2021)`. */
export function formatEducation(entry) {
  const degree = [entry.degree, entry.field].filter(Boolean).join(", ");
  const parts = [entry.institution];
  if (degree) parts.push(`— ${degree}`);
  if (entry.dateRange) parts.push(`(${entry.dateRange})`);
  return parts.filter(Boolean).join(" ");
}

export function applicantsToCsv(applicants) {
  const rows = (applicants || []).map((raw) => {
    // Normalized on the way out too, so a record written by an older build
    // exports with the current column set rather than a row of blanks.
    const record = Applicants.normalizeApplicantRecord(raw);
    return APPLICANT_CSV_COLUMNS
      .map(([label, read]) => escapeCell(read(record), { asText: TEXT_COLUMNS.has(label) }))
      .join(",");
  });
  return buildCsvFile(APPLICANT_CSV_COLUMNS.map(([label]) => label), rows);
}

export function downloadApplicantCsv(applicants, prefix = "linkedin-applicants") {
  if (!applicants?.length) throw new Error("There are no applicants to export yet.");
  downloadCsvText(applicantsToCsv(applicants), prefix);
}
