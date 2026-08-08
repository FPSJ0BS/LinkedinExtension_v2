/**
 * The applicant export and the page that offers it.
 *
 * The export is a separate column set from the connections one but shares every
 * rule that makes a CSV open correctly, so the tests here check both: that the
 * shared rules are actually shared, and that the applicant-specific formatting
 * says what the recruiter screen said.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await import("../src/extraction-core.js");
await import("../src/applicants-core.js");
const Applicants = globalThis.ProfileVaultApplicants;
const Csv = await import("../src/applicant-csv.js");

/** One fully populated applicant, from the reference recruiter screen. */
function sampleApplicant(overrides = {}) {
  const accumulator = Applicants.createApplicantAccumulator();
  accumulator.addJob({ id: "4277798308", title: "Human Resources Executive", applicantCount: 665 });
  accumulator.addHeader({
    name: "Mahak Ayani",
    headline: "HR Head | Talent Acquisition | Employer Branding",
    location: "Delhi, India",
    appliedAt: "12mo ago",
    contactedAt: "12mo ago",
    profileUrl: "https://www.linkedin.com/in/mahak-ayani"
  });
  accumulator.addQualification(Applicants.parseQualificationBlock({
    category: "must_have",
    lines: [
      "Bachelor's degree in HR, Business Administration, or related field.",
      "Mahak Ayani answered 'Yes' to having completed a Bachelor's Degree.",
      "Based on the applicant's responses to the screening questions"
    ]
  }));
  accumulator.addQualification(Applicants.parseQualificationBlock({
    category: "must_have",
    lines: ["Knowledge of employment laws.", "Information cannot be provided or evaluated for this qualification"]
  }));
  accumulator.addQualification(Applicants.parseQualificationBlock({
    category: "preferred",
    lines: ["Strong communication and interpersonal skills.", "Information cannot be provided or evaluated for this qualification"]
  }));
  accumulator.addScreening(Applicants.parseScreeningBlock({
    lines: ["Have you completed the following level of education: Bachelor's Degree?", "Ideal answer: Yes", "Yes"]
  }));
  accumulator.addExperience(Applicants.parseExperienceBlock(["HR Manager", "Naad Wellness • 2026-Present", "Experience verified"]));
  accumulator.addExperience(Applicants.parseExperienceBlock(["Human Resources Manager", "Healthtrip • 2022-2025"]));
  accumulator.addEducation(Applicants.parseEducationBlock(["University of Delhi", "Bachelor of Arts, Psychology", "2018-2021"]));
  accumulator.addSkill("Talent Acquisition");
  accumulator.addContactPanel({ emails: ["mahak@example.com"], phones: ["04423456789"], websites: [] });
  accumulator.setResume({ available: true, filename: "mahak-ayani.pdf", fileType: "pdf", url: "https://media.licdn.com/dms/x.pdf", downloadStatus: "downloaded" });

  const record = Applicants.buildApplicantRecord({
    snapshot: accumulator.snapshot(),
    context: { jobId: "4277798308", applicationId: "25550787924" },
    sourceUrl: "https://www.linkedin.com/hiring/applicants/?applicationId=25550787924&jobId=4277798308",
    buildId: "test"
  });
  return Applicants.normalizeApplicantRecord({ ...record, ...overrides });
}

function parseRows(text) {
  return text.replace(/^﻿/, "").split("\r\n");
}

test("the applicant CSV is UTF-8, quoted, CRLF and formula-safe", () => {
  const csv = Csv.applicantsToCsv([sampleApplicant()]);
  assert.ok(csv.startsWith("﻿"), "the BOM is what stops Excel mis-decoding an accented name");
  assert.ok(csv.includes("\r\n"), "rows are CRLF separated");

  const [header, row] = parseRows(csv);
  assert.ok(header.split(",").every((cell) => cell.startsWith('"') && cell.endsWith('"')), "every header cell is quoted");
  assert.ok(row.startsWith('"'), "every value cell is quoted");

  // A cell that begins with a formula character is neutralized.
  const dangerous = Csv.applicantsToCsv([sampleApplicant({
    applicant: { ...sampleApplicant().applicant, name: "=cmd|'/c calc'!A1" }
  })]);
  assert.match(dangerous, /"'=cmd/, "a formula must be neutralized with a leading apostrophe");
});

test("a phone number survives a spreadsheet round trip", () => {
  const csv = Csv.applicantsToCsv([sampleApplicant()]);
  // Without the text marker Excel turns 04423456789 into 4423456789.
  assert.match(csv, /"'04423456789"/, "the mobile column must be marked as text");
  const mobileAt = Csv.APPLICANT_CSV_COLUMNS.findIndex(([label]) => label === "mobile");
  assert.ok(mobileAt >= 0, "there must be a mobile column");
});

test("the file IS the applicants table — the same columns, in the same order, and no others", async () => {
  // Requested outright in 3.7.15, against a screenshot of the rendered table:
  // "the downloaded CSV or Excel file contains ONLY these columns in this exact
  // order — #, Applicant Name, Email, Mobile, Resume File, Current Role,
  // Current Company, Total Experience, Education ... keep all extra data stored
  // internally". So this is not "the export LEADS with the table" any more; it
  // is "the export IS the table", and that is a much cheaper thing to check.
  const page = await readFile(resolve(root, "src/react/applicants-dashboard.tsx"), "utf8");
  const head = page.slice(page.indexOf("<thead>"), page.indexOf("</thead>"));
  const headers = [...head.matchAll(/<th(?:\s[^>]*)?>([^<]+)<\/th>/g)]
    .map((match) => match[1].trim())
    // Actions is a pair of buttons, not a value. The select box holds an
    // <input> rather than text, so it never matches in the first place.
    .filter((label) => label !== "Actions")
    .map((label) => label.toLowerCase().replace(/ /g, "_"));

  assert.deepEqual(
    Csv.APPLICANT_CSV_COLUMNS.map(([label]) => label),
    headers,
    "every column of the file is a column of the table, and every column of the table is in the file"
  );
  assert.deepEqual(headers, [
    "#", "applicant_name", "email", "mobile", "resume_file",
    "current_role", "current_company", "total_experience", "education"
  ], "and this is the set that was asked for, in the order it was asked for");

  // `#` is the only one that is not an `APPLICANT_TABLE_COLUMNS` entry, because
  // it is a position rather than a field of the record.
  assert.deepEqual([...Csv.APPLICANT_TABLE_COLUMNS], headers.slice(1), "the shared list is the table minus its row number");

  const source = await readFile(resolve(root, "src/applicant-csv.js"), "utf8");
  assert.match(source, /export const APPLICANT_TABLE_COLUMNS/, "the shared list must be exported, not duplicated");
});

test("the row number counts this file's rows, and is never the record's identity", () => {
  const csv = Csv.applicantsToCsv([
    sampleApplicant(),
    Applicants.normalizeApplicantRecord({ applicant: { name: "Second Person" } }),
    Applicants.normalizeApplicantRecord({ applicant: { name: "Third Person" } })
  ]);
  const [header, ...rows] = parseRows(csv).filter(Boolean);
  assert.equal(header.split(",")[0], '"#"', "the row number leads the header");
  assert.deepEqual(rows.map((row) => row.split(",")[0]), ['"1"', '"2"', '"3"'],
    "numbered from one, in the order the rows were exported");

  // It is derived from where the row lands, never read off the record — which
  // is the whole reason it may not be confused with `applicant_id`. Exporting a
  // filtered or selected subset renumbers from one, and that is correct for a
  // serial number and would be a defect for a key.
  const alone = parseRows(Csv.applicantsToCsv([Applicants.normalizeApplicantRecord({ applicant: { name: "Third Person" } })]))[1];
  assert.match(alone, /^"1","Third Person"/, "the same person is row 1 of an export that contains only them");
  assert.ok(!Csv.APPLICANT_CSV_COLUMNS.some(([label]) => label === "applicant_id"),
    "and the identity it is not is no longer exported at all");
});

test("the resume is one column in the file, and the rest of it stays on the record", () => {
  const labels = Csv.APPLICANT_CSV_COLUMNS.map(([label]) => label);

  // 3.7.1: the applicant's own name leads the record's own columns — the export
  // is read per person, not per posting. `#` sits in front of it from 3.7.15
  // because the table has always painted a row number and the file was asked to
  // match the table.
  assert.deepEqual(labels.slice(0, 5), [
    "#", "applicant_name", "email", "mobile", "resume_file"
  ], "the position, the name, both ways to reach them, then which file we actually have");
  // 3.7.4 had five resume columns, 3.7.6 cut them to two and 3.7.9 to one in
  // the table. 3.7.15 makes the file agree: `resume_link` was the last of them
  // still exporting and it goes with the other detail columns.
  for (const gone of ["resume_status", "resume_viewer", "resume_saved_as", "resume_link", "resume_file_type", "resume_pages"]) {
    assert.ok(!labels.includes(gone), `${gone} must no longer be a column of the file`);
  }

  const record = Applicants.normalizeApplicantRecord({
    applicant: {
      name: "Anamika Singh",
      resume: {
        available: true,
        filename: "anamika-singh.pdf",
        url: "https://media.licdn.com/dms/document/ABC/anamika-singh.pdf",
        viewerUrl: "https://www.linkedin.com/hiring/applicants/?applicationId=31754123946",
        localReference: "profile-vault-resumes/anamika-singh.pdf",
        downloadStatus: "downloaded"
      }
    }
  });
  const read = (label) => Csv.APPLICANT_CSV_COLUMNS.find(([name]) => name === label)[1](record);
  // The saved copy wins the one cell there is: "which file on disk is theirs".
  assert.equal(read("resume_file"), "profile-vault-resumes/anamika-singh.pdf");
  // The link is still derivable, still exported as a function, and still what
  // the details drawer renders — it simply is not a column any more.
  assert.equal(Csv.resumeLink(record), "https://media.licdn.com/dms/document/ABC/anamika-singh.pdf",
    "the document wins the link when there is one");

  // A record with only a viewer still has one link, rather than nothing — the
  // viewer page exists on almost every applicant even when the document address
  // does not, and it is what opens the CV.
  const viewerOnly = Applicants.normalizeApplicantRecord({
    applicant: {
      name: "X",
      resume: { available: true, filename: "x.pdf", viewerUrl: "https://www.linkedin.com/hiring/applicants/?applicationId=1" }
    }
  });
  const readOne = (label) => Csv.APPLICANT_CSV_COLUMNS.find(([name]) => name === label)[1](viewerOnly);
  assert.equal(Csv.resumeLink(viewerOnly), "https://www.linkedin.com/hiring/applicants/?applicationId=1", "the viewer is the fallback link");
  assert.equal(readOne("resume_file"), "x.pdf", "and the file name stands in until a copy is saved");

  // Nothing at all stays empty. Never a guess, never "unavailable" in a link.
  const none = Applicants.normalizeApplicantRecord({ applicant: { name: "Nobody" } });
  assert.equal(Csv.resumeLink(none), "");
  assert.equal(Csv.resumeFile(none), "");

  // ⚠ The columns went; the RECORD did not, and that is the whole of 3.7.15.
  // `downloadStatus` is what stops the same file being fetched twice on the
  // next run, and `url`/`viewerUrl` are what a page address may never become.
  // Dropping these from the record would break collection, not just the export.
  assert.equal(record.applicant.resume.downloadStatus, "downloaded");
  assert.equal(record.applicant.resume.url, "https://media.licdn.com/dms/document/ABC/anamika-singh.pdf");
  assert.equal(record.applicant.resume.viewerUrl, "https://www.linkedin.com/hiring/applicants/?applicationId=31754123946");
  assert.equal(record.applicant.resume.localReference, "profile-vault-resumes/anamika-singh.pdf");

  // The details drawer is where all of it is still shown, so the formatters it
  // renders through must stay exported however few columns there are.
  for (const helper of ["resumeLink", "resumeSummary", "formatQualification", "formatScreening", "formatExperience", "formatEducation"]) {
    assert.equal(typeof Csv[helper], "function", `${helper} backs the details drawer and may not be dropped with its column`);
  }
});

test("the detail columns are gone from the file, and every one of them is still on the record", () => {
  const labels = Csv.APPLICANT_CSV_COLUMNS.map(([label]) => label);

  // Requested outright: "do not download any extra fields such as
  // qualifications, status, additional emails or numbers, profile URL,
  // headline, dates, screening responses, full experience history, skills,
  // resume metadata, job details, warnings, timestamps, applicant ID, or
  // internal data." Every column that carried one of those is named here, so a
  // reinstated column fails rather than silently widening the file again.
  for (const gone of [
    "qualifications", "must_have_qualifications", "preferred_qualifications",
    "screening_responses", "experience", "skills",
    "application_status", "collected_at", "last_updated",
    "all_emails", "all_phone_numbers", "website",
    "profile_url", "headline", "applied", "contacted",
    "job_id", "job_url", "warnings", "source_url", "applicant_id",
    // And the ones dropped earlier, which must not come back either.
    "job_title", "location", "job_location", "job_company", "job_description"
  ]) {
    assert.ok(!labels.includes(gone), `${gone} must not be a column of the downloaded file`);
  }
  assert.equal(labels.length, 9, "nine columns, and a tenth is a deliberate change to the table as well");

  // The table ENDS with education, and so therefore does the file.
  assert.deepEqual(
    [...Csv.APPLICANT_TABLE_COLUMNS].slice(4),
    ["current_role", "current_company", "total_experience", "education"],
    "the last columns are what the shortlist is actually read for"
  );
  assert.equal(labels.filter((label) => label === "education").length, 1, "education is one column, not two");

  // ⚠ The other half, and the half that matters: the data is still collected,
  // still stored and still reachable. "Keep all extra data stored internally."
  const record = sampleApplicant();
  assert.equal(record.applicant.qualifications.length, 3, "every requirement the platform judged is still stored");
  assert.equal(record.applicant.screeningResponses.length, 1);
  assert.equal(record.applicant.experience.length, 2, "the full history is still on the record");
  assert.ok(record.applicant.skills.length);
  assert.equal(record.applicant.profileUrl, "https://www.linkedin.com/in/mahak-ayani");
  assert.ok(record.applicant.headline);
  assert.equal(record.job.id, "4277798308");
  assert.ok(record.id, "and it still has an identity — it is simply not a column");

  // And still formattable, because the details drawer renders through exactly
  // these functions. A column that leaves must not take its formatter with it.
  const rows = Csv.qualificationRows(record);
  assert.equal(rows.length, 3, "every requirement, none dropped");
  assert.match(rows[0], /^must-have: matched · Bachelor's degree/);
  assert.match(rows[1], /^must-have: unknown · Knowledge of employment laws/);
  assert.match(rows[2], /^preferred: unknown · Strong communication/);
  // A requirement LinkedIn filed under neither still prints — it was displayed.
  assert.equal(
    Csv.formatQualificationRow({ requirement: "Something", category: "", result: "matched", explanation: null, source: "" }),
    "matched · Something"
  );
  assert.equal(Csv.formatQualifications(record, "must_have").length, 2, "and each category can still be read out on its own");
  assert.equal(Csv.formatQualifications(record, "preferred").length, 1);

  const read = (label) => Csv.APPLICANT_CSV_COLUMNS.find(([name]) => name === label)[1](record);
  assert.deepEqual(read("education"), ["University of Delhi — Bachelor of Arts, Psychology (2018-2021)"]);
  assert.deepEqual(Csv.educationRows({ applicant: { education: [] } }), [], "nobody's education is never invented");
  assert.deepEqual(Csv.qualificationRows({}), [], "and neither is anybody's qualifications");

  // The file itself carries none of it. Checked against the text, because a
  // column list that looks right and a file that leaks are different failures.
  const csv = Csv.applicantsToCsv([record]);
  assert.ok(!csv.includes("must-have: matched"), "no verdict reaches the file");
  assert.ok(!csv.includes("linkedin.com/in/mahak-ayani"), "and no profile URL");
  assert.ok(!csv.includes("Talent Acquisition"), "and no skills");
  assert.ok(!csv.includes("4277798308"), "and no job id");
  assert.ok(!csv.includes(record.id), "and not the record's own id");
  assert.match(csv, /University of Delhi — Bachelor of Arts/, "what was asked for is still there");
});

test("the extra addresses and numbers stay on the record and out of the file", () => {
  const record = Applicants.normalizeApplicantRecord({
    applicant: {
      name: "Mahak Ayani",
      contact: {
        email: "mahak@example.com",
        phone: "04423456789",
        other: ["email: alt@example.com", "phone: +919876543210", "website: https://example.com"]
      }
    }
  });

  // Still collected, still labelled, still reachable — `allOf` is kept for
  // exactly this reason even though no column calls it any more.
  assert.deepEqual(Csv.allOf(record, "email"), ["mahak@example.com", "alt@example.com"]);
  assert.deepEqual(Csv.allOf(record, "phone"), ["04423456789", "+919876543210"]);
  // A duplicate between the primary and the extras is not counted twice.
  const duplicated = Applicants.normalizeApplicantRecord({
    applicant: { name: "X", contact: { email: "a@b.com", other: ["email: A@B.com"] } }
  });
  assert.deepEqual(Csv.allOf(duplicated, "email"), ["a@b.com"]);

  // The file carries the primary two only — "additional emails or numbers" was
  // named outright in the request.
  const csv = Csv.applicantsToCsv([record]);
  assert.match(csv, /"mahak@example\.com"/, "the primary address is a column");
  assert.ok(!csv.includes("alt@example.com"), "the second address is not");
  assert.ok(!csv.includes("+919876543210"), "and neither is the second number");
  assert.ok(!csv.includes("https://example.com"), "nor the website");
  // The one that IS exported is still marked as text, or the leading zero goes.
  assert.match(csv, /"'04423456789"/, "the mobile column is still protected from Excel");
});

test("total experience is computed, including from the applicant card's spaceless range", () => {
  // The live defect: `totalExperienceFrom` handed `calculateTotalExperience` a
  // `{ dates }` object, which matches neither key it reads, so the column was
  // always empty. And the recruiter card renders "2026-Present" with no spaces,
  // which the shared parser deliberately refuses to split.
  const entries = [
    Applicants.parseExperienceBlock(["HR Manager", "Naad Wellness • 2022-Present"]),
    Applicants.parseExperienceBlock(["Human Resources Manager", "Healthtrip • 2019-2022"])
  ];
  const total = Applicants.totalExperienceFrom(entries);
  assert.match(String(total), /year/, `a real range must produce a real total, got ${JSON.stringify(total)}`);

  // The stored range keeps the platform's own wording — only the lookup is
  // normalized.
  assert.equal(entries[0].dateRange, "2022-Present");
  assert.equal(Applicants.normalizeDateRange("2022-Present"), "2022 - Present");
  assert.equal(Applicants.normalizeDateRange("Jan 2019 - Mar 2023"), "Jan 2019 - Mar 2023", "the spaced form is untouched");
  // Only a hyphen after a four-digit year is a separator, so nothing else can
  // be turned into a range by this.
  assert.equal(Applicants.normalizeDateRange("3-5 years"), "3-5 years");

  assert.equal(Applicants.totalExperienceFrom([{ title: "Intern", dateRange: "2019-2022" }]), null, "internships are excluded");
  assert.equal(Applicants.totalExperienceFrom([{ title: "X", dateRange: "sometime" }]), null, "an unparseable range is null, not zero");
});

test("the applicant export shares the connections export's safety rules rather than copying them", async () => {
  const applicant = await readFile(resolve(root, "src/applicant-csv.js"), "utf8");
  assert.match(applicant, /import \{ buildCsvFile, downloadCsvText, escapeCell \} from "\.\/csv\.js"/,
    "one implementation of the escaping, shared");
  assert.ok(!/neutralizeFormula\s*\(/.test(applicant.replace(/\/\*[\s\S]*?\*\//g, "")),
    "the applicant export must not re-implement formula neutralization");

  const csv = await readFile(resolve(root, "src/csv.js"), "utf8");
  assert.match(csv, /export function buildCsvFile/, "the primitives must be exported for reuse");
  assert.match(csv, /export function escapeCell/);
  assert.match(csv, /export function downloadCsvText/);
});

test("a qualification line says the verdict, the requirement, the reason and the source", () => {
  const record = sampleApplicant();

  // It is no longer a CSV cell — it is what the details drawer renders — but
  // the formatting rule is unchanged and is still the one place it lives.
  assert.equal(
    Csv.formatQualification(record.applicant.qualifications[0]),
    "matched · Bachelor's degree in HR, Business Administration, or related field. — Mahak Ayani answered 'Yes' to having completed a Bachelor's Degree. [screening_response]"
  );
  // A requirement the platform could not evaluate still prints, as unknown.
  assert.match(Csv.formatQualification(record.applicant.qualifications[1]), /^unknown · Knowledge of employment laws\./);

  // The row-level tally is a count, not a colour.
  assert.equal(Csv.qualificationTally(record, "must_have"), "1 of 2");
  assert.equal(Csv.qualificationTally(record, "preferred"), "0 of 1");
  assert.equal(Csv.qualificationTally(record, "nothing"), "");
});

test("screening, experience, education and resume cells read as sentences", () => {
  const record = sampleApplicant();
  assert.equal(
    Csv.formatScreening(record.applicant.screeningResponses[0]),
    "Have you completed the following level of education: Bachelor's Degree? · ideal: Yes · answered: Yes · met"
  );
  // Tri-state: "not stated" is not the same as "not met".
  assert.match(Csv.formatScreening({ question: "Salary?", idealAnswer: null, answer: "12 LPA", met: null }), /not stated$/);
  assert.match(Csv.formatScreening({ question: "5 years?", idealAnswer: "Yes", answer: "No", met: false }), /not met$/);

  assert.equal(Csv.formatExperience(record.applicant.experience[0]), "HR Manager — Naad Wellness (2026-Present) [verified]");
  assert.equal(Csv.formatExperience(record.applicant.experience[1]), "Human Resources Manager — Healthtrip (2022-2025)");
  assert.equal(Csv.formatEducation(record.applicant.education[0]), "University of Delhi — Bachelor of Arts, Psychology (2018-2021)");

  assert.equal(Csv.resumeSummary(record), "mahak-ayani.pdf (downloaded)");
  const none = Applicants.normalizeApplicantRecord({ applicant: { name: "Nobody" } });
  assert.equal(Csv.resumeSummary(none), "none");
});

test("an applicant with nothing but a name still exports a full, empty row", () => {
  const csv = Csv.applicantsToCsv([Applicants.normalizeApplicantRecord({ applicant: { name: "Aanchal Sharma" } })]);
  const [header, row] = parseRows(csv);
  assert.equal(
    row.split('","').length,
    header.split('","').length,
    "a sparse record must not produce a short row — the columns are fixed"
  );
  assert.match(row, /"Aanchal Sharma"/);
  // Absent values are empty cells, never the string "null" or "undefined".
  assert.ok(!/"null"|"undefined"|\[object Object\]/.test(csv), "nothing may leak an internal representation");
});

test("an empty export is refused rather than producing a header-only file", () => {
  assert.throws(() => Csv.downloadApplicantCsv([]), /no applicants to export/i);
  assert.throws(() => Csv.downloadApplicantCsv(null), /no applicants to export/i);
});

test("the applicants page is a React TypeScript entry point with no hooks", async () => {
  const source = await readFile(resolve(root, "src/react/applicants-dashboard.tsx"), "utf8");
  assert.match(source, /ReactDOM\.render\(<ApplicantsApp/);
  assert.match(source, /class ApplicantsApp extends React\.Component/);
  assert.match(source, /const React: any = \(globalThis as any\)\.React/);
  assert.ok(
    !/\buse(?:State|Effect|Ref|Memo|Callback|Context|Reducer|LayoutEffect)\s*\(/.test(source),
    "the vendored React 16.0.0 has no hooks"
  );
  assert.ok(!/from ["']react(?:-dom)?["']/.test(source), "React is a global, not an import");
  // 16.0 predates Fragments, so neither form may appear.
  assert.ok(!/<>|React\.Fragment/.test(source), "React 16.0.0 has no Fragments");
});

test("the applicants page offers every control the surface needs", async () => {
  const source = await readFile(resolve(root, "src/react/applicants-dashboard.tsx"), "utf8");
  for (const label of [
    "Collect This Applicant",
    "Collect Applicant List",
    "Stop",
    "Download CSV",
    "Download Selected",
    "Clear Applicants",
    "View details",
    "Saved Profiles"
  ]) {
    assert.ok(source.includes(label), `the applicants page must offer "${label}"`);
  }
  assert.match(source, /type="search"/, "a search box is required");
  assert.match(source, /Filter by job/, "grouping by job is the point of the page");
  assert.match(source, /Filter by status/);
  assert.match(source, /Filter by resume/);
  assert.match(source, /Showing \{total \? start \+ 1 : 0\}–\{Math\.min\(start \+ pageSize, total\)\} of \{total\}/, "the total must be visible");
  assert.match(source, /PAGE_SIZES\.map/, "the 25/50 row choice must be offered");
  assert.match(source, /STOP_ALL/, "Stop must be the universal one, not a page-local flag");

  // The details drawer is where the full verdicts live.
  const details = source.slice(source.indexOf("renderDetails()"));
  assert.match(details, /Must-have qualifications/);
  assert.match(details, /Preferred qualifications/);
  assert.match(details, /Screening responses/);
  assert.match(details, /Extraction warnings/, "a failed field must be visible to the user, not only in a log");
});

test("the applicants page is reachable and loads React locally", async () => {
  const html = await readFile(resolve(root, "extension/pages/applicants.html"), "utf8");
  assert.match(html, /vendor\/react\.production\.min\.js/);
  assert.match(html, /vendor\/react-dom\.production\.min\.js/);
  assert.match(html, /src\/react\/applicants-dashboard\.js/);
  assert.ok(!/src=["']https?:\/\//i.test(html), "Manifest V3 CSP forbids a remote script");

  const dashboard = await readFile(resolve(root, "src/react/dashboard.tsx"), "utf8");
  assert.match(dashboard, />Open Job Applicants</, "the saved-profiles page must link to it");

  const build = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
  assert.match(build, /"applicants\.html"/, "the page must be copied into dist");
  assert.match(build, /"applicants\.css"/);
});
