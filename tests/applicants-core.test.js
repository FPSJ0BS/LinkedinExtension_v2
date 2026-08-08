/**
 * The recruiter hiring surface (3.7.0).
 *
 * Everything here runs against the pure core or against the source of the
 * adapter — there is no jsdom in this repository, so DOM-resident logic cannot
 * be tested at all and the policy therefore lives in the core where it can be.
 * The fixtures are the text the attached recruiter screens actually render.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The profile core first: the applicants core reuses its text cleaning, its
// contact provenance and its settle policy rather than growing a second copy.
await import("../src/extraction-core.js");
await import("../src/applicants-core.js");
const Applicants = globalThis.ProfileVaultApplicants;

/** The address in the attached screenshot, verbatim. */
const APPLICANTS_URL =
  "https://www.linkedin.com/hiring/applicants/?applicationId=25550787924&rating=GOOD_FIT&jobId=4277798308";

/**
 * Source with its comments removed.
 *
 * Every "this file must never mention X" assertion below runs against this
 * rather than the raw source: these files explain in prose exactly why they do
 * not use React, the DOM at load, or `chrome.downloads`, and a check that the
 * word is absent would otherwise be failed by the sentence explaining its
 * absence. `//` is only treated as a comment at a line start or after
 * whitespace, so a `https://` inside a string or a `\/\/` inside a regex
 * survives.
 *
 * **Line endings are normalised first, and that is not cosmetic.** The repo is
 * LF-canonical, but Git checks the tree out as CRLF wherever `core.autocrlf` is
 * true — every Windows clone. `.` does not match `\r`, so on such a checkout
 * `(^|\s)\/\/.*$` never reaches the `$` of a `// …\r` line and the comment is
 * left in place. Three "this file must never mention X" assertions then read the
 * sentence explaining the absence as the thing itself, and failed on a tree
 * whose committed content is byte-for-byte correct. A check that passes only on
 * one platform's checkout is worse than no check: it reports a defect nobody can
 * find and hides the real one.
 */
function withoutComments(source) {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

test("the applicants core stays an export-free, DOM-free, framework-free IIFE", async () => {
  const source = await readFile(resolve(root, "src/applicants-core.js"), "utf8");
  assert.ok(!/^\s*(?:import|export)\s/m.test(source), "it must stay an export-free IIFE");
  assert.ok(!/React/.test(source), "it must not reference React");
  assert.match(source, /globalThis\.ProfileVaultApplicants/, "it must publish its API on globalThis");
  // Nothing may touch `document` or `window` anywhere in this file — it is the
  // pure half, and the adapter is the only place a DOM exists.
  const code = withoutComments(source);
  assert.ok(!/\bdocument\b|\bwindow\b/.test(code), "nothing in the core may touch the DOM");
});

test("the job and the applicant are read out of the address bar, never guessed", () => {
  const context = Applicants.parseHiringContext(APPLICANTS_URL);
  assert.equal(context.jobId, "4277798308");
  assert.equal(context.applicationId, "25550787924");
  assert.equal(context.applicantsPage, true);
  assert.equal(context.hiringPage, true);

  // The older path-based address.
  const path = Applicants.parseHiringContext("https://www.linkedin.com/hiring/jobs/4277798308/applicants/25550787924");
  assert.equal(path.jobId, "4277798308");
  assert.equal(path.applicationId, "25550787924");

  // An address that carries no ids yields null rather than an invented one —
  // an applicant filed under the wrong job is worse than one filed under none.
  const bare = Applicants.parseHiringContext("https://www.linkedin.com/hiring/");
  assert.equal(bare.jobId, null);
  assert.equal(bare.applicationId, null);

  assert.equal(Applicants.isHiringPage("https://www.linkedin.com/in/someone"), false);
  assert.equal(Applicants.isHiringPage("https://example.com/hiring/applicants/"), false);
  assert.equal(Applicants.isApplicantsPage(APPLICANTS_URL), true);
});

test("every control that acts on the applicant is refused before any allowlist", () => {
  // These sit within a few pixels of the controls this extension does open, and
  // three of the four change something in the recruiter's own ATS.
  const forbidden = [
    "Shortlist", "Move to", "Reject", "Interview with AI", "Message", "Send InMail",
    "Rate this AI-generated content", "Good fit", "Not a fit", "Archive", "Share",
    "Save", "Schedule interview", "Add note"
  ];
  for (const label of forbidden) {
    for (const purpose of Object.values(Applicants.CONTROL_PURPOSE)) {
      const verdict = Applicants.classifyApplicantControl({ text: label, purpose, inContainer: true });
      assert.equal(verdict.allowed, false, `"${label}" must never be clicked (purpose ${purpose})`);
      assert.equal(verdict.forbidden, true, `"${label}" must be refused by the denylist, not merely unmatched`);
    }
  }

  // The denylist beats the allowlist, so a compound label loses.
  const compound = Applicants.classifyApplicantControl({
    text: "Message · Contact info",
    purpose: Applicants.CONTROL_PURPOSE.CONTACT,
    inContainer: true
  });
  assert.equal(compound.allowed, false);
  assert.equal(compound.reason, "forbidden-action");

  // And an aria-label that says it, when the visible text does not.
  const hidden = Applicants.classifyApplicantControl({
    text: "Contact",
    ariaLabel: "Send a message to Mahak Ayani",
    purpose: Applicants.CONTROL_PURPOSE.CONTACT,
    inContainer: true
  });
  assert.equal(hidden.forbidden, true);
});

test("a disclosure control is only allowed when it is proven inside its container", () => {
  const inside = Applicants.classifyApplicantControl({
    text: "Contact info",
    purpose: Applicants.CONTROL_PURPOSE.CONTACT,
    inContainer: true
  });
  assert.equal(inside.allowed, true);
  assert.equal(inside.reason, "contact-info");

  // The same label, found anywhere else on the page, is refused — exactly as
  // pagination has to be proven inside the connections list.
  const outside = Applicants.classifyApplicantControl({
    text: "Contact info",
    purpose: Applicants.CONTROL_PURPOSE.CONTACT,
    inContainer: false
  });
  assert.equal(outside.allowed, false);
  assert.equal(outside.reason, "outside-applicant-panel");

  // "Show details" labels several unrelated controls, so the proof is mandatory.
  assert.equal(
    Applicants.classifyApplicantControl({ text: "Show more", purpose: Applicants.CONTROL_PURPOSE.DISCLOSURE, inContainer: false }).allowed,
    false
  );
  assert.equal(
    Applicants.classifyApplicantControl({ text: "Show more", purpose: Applicants.CONTROL_PURPOSE.DISCLOSURE, inContainer: true }).allowed,
    true
  );

  // A resume link is unambiguous by name and needs no container proof.
  assert.equal(
    Applicants.classifyApplicantControl({ text: "Resume", purpose: Applicants.CONTROL_PURPOSE.RESUME }).allowed,
    true
  );
  // An unknown purpose is refused rather than defaulted.
  assert.equal(Applicants.classifyApplicantControl({ text: "Resume", purpose: "anything" }).allowed, false);
  assert.equal(Applicants.classifyApplicantControl({ text: "", purpose: "contact", inContainer: true }).reason, "no-label");
});

test("a qualification is stored exactly as the platform displayed it", () => {
  const matched = Applicants.parseQualificationBlock({
    category: Applicants.QUALIFICATION_CATEGORY.MUST_HAVE,
    lines: [
      "Bachelor's degree in HR, Business Administration, or related field.",
      "Mahak Ayani answered 'Yes' to having completed a Bachelor's Degree.",
      "Based on the applicant's responses to the screening questions"
    ]
  });
  assert.equal(matched.requirement, "Bachelor's degree in HR, Business Administration, or related field.");
  assert.equal(matched.category, "must_have");
  assert.equal(matched.result, Applicants.QUALIFICATION_RESULT.MATCHED);
  assert.equal(matched.explanation, "Mahak Ayani answered 'Yes' to having completed a Bachelor's Degree.");
  assert.equal(matched.source, Applicants.QUALIFICATION_SOURCE.SCREENING);
  assert.match(matched.raw, /Based on the applicant's responses/, "the block is kept verbatim for debugging");

  // "Information cannot be provided or evaluated" is unknown, never a miss.
  const unknown = Applicants.parseQualificationBlock({
    category: Applicants.QUALIFICATION_CATEGORY.PREFERRED,
    lines: [
      "Strong communication and interpersonal skills.",
      "Information cannot be provided or evaluated for this qualification"
    ]
  });
  assert.equal(unknown.result, Applicants.QUALIFICATION_RESULT.UNKNOWN);
  assert.equal(unknown.category, "preferred");
  assert.equal(unknown.source, Applicants.QUALIFICATION_SOURCE.UNKNOWN);

  const fromProfile = Applicants.parseQualificationBlock({
    lines: [
      "3-5 years of experience in human resources.",
      "Mahak Ayani has 3 years of experience as a Human Resources Manager at Healthtrip.",
      "Based on the applicant's profile"
    ]
  });
  assert.equal(fromProfile.source, Applicants.QUALIFICATION_SOURCE.PROFILE);
  assert.equal(fromProfile.result, Applicants.QUALIFICATION_RESULT.MATCHED);

  // A stated negative is a miss; a blank is not a pass.
  assert.equal(
    Applicants.parseQualificationBlock({ lines: ["Knowledge of employment laws.", "Mahak Ayani does not have this qualification."] }).result,
    Applicants.QUALIFICATION_RESULT.NOT_MATCHED
  );
  assert.equal(
    Applicants.parseQualificationBlock({ lines: ["Knowledge of employment laws."] }).result,
    Applicants.QUALIFICATION_RESULT.UNKNOWN
  );

  // The icon is what the recruiter sees, so it wins over the wording.
  assert.equal(
    Applicants.classifyQualificationResult({ iconLabel: "Does not meet qualification", explanation: "Mahak Ayani has 3 years." }),
    Applicants.QUALIFICATION_RESULT.NOT_MATCHED
  );

  assert.equal(Applicants.qualificationCategoryOf("Must-have"), "must_have");
  assert.equal(Applicants.qualificationCategoryOf("Preferred"), "preferred");
  assert.equal(Applicants.qualificationCategoryOf("Qualifications"), "");
});

test("a screening response keeps the question, the ideal answer and the answer apart", () => {
  const response = Applicants.parseScreeningBlock({
    lines: [
      "Have you completed the following level of education: Bachelor's Degree?",
      "Ideal answer: Yes",
      "Yes"
    ]
  });
  assert.equal(response.question, "Have you completed the following level of education: Bachelor's Degree?");
  assert.equal(response.idealAnswer, "Yes");
  assert.equal(response.answer, "Yes");
  assert.equal(response.met, true);

  const missed = Applicants.parseScreeningBlock({ lines: ["Do you have 5 years of experience?", "Ideal answer: Yes", "No"] });
  assert.equal(missed.met, false);

  // No ideal answer means the platform did not say, which is not a failure.
  const open = Applicants.parseScreeningBlock({ lines: ["What are your salary expectations?", "12 LPA"] });
  assert.equal(open.idealAnswer, null);
  assert.equal(open.answer, "12 LPA");
  assert.equal(open.met, null);
});

test("an experience card splits into role, employer and dates even with no separator", () => {
  const current = Applicants.parseExperienceBlock([
    "HR Manager",
    "Naad Wellness • 2026-Present",
    "Experience verified"
  ]);
  assert.equal(current.title, "HR Manager");
  assert.equal(current.company, "Naad Wellness");
  assert.equal(current.dateRange, "2026-Present");
  assert.equal(current.current, true);
  assert.equal(current.verified, true);

  const past = Applicants.parseExperienceBlock(["Human Resources Manager", "Healthtrip • 2022-2025"]);
  assert.equal(past.company, "Healthtrip");
  assert.equal(past.dateRange, "2022-2025");
  assert.equal(past.current, false);
  assert.equal(past.verified, false);

  // The middot does not always render — the same collapsed-metadata problem the
  // profile core solves — so the split falls back to the date range itself.
  const welded = Applicants.splitCompanyAndDates("Healthtrip 2022-2025");
  assert.equal(welded.company, "Healthtrip");
  assert.equal(welded.dateRange, "2022-2025");

  // The current role comes from the card marked Present, never from the
  // headline: the live headline here names no employer at all.
  const derived = Applicants.deriveCurrentPosition([past, current]);
  assert.equal(derived.currentRole, "HR Manager");
  assert.equal(derived.currentCompany, "Naad Wellness");
  assert.deepEqual(Applicants.deriveCurrentPosition([]), { currentRole: null, currentCompany: null });
});

test("education keeps the degree, which the connections record deliberately drops", () => {
  const record = Applicants.parseEducationBlock(["University of Delhi", "Bachelor of Arts, Psychology", "2018-2021"]);
  assert.equal(record.institution, "University of Delhi");
  assert.equal(record.degree, "Bachelor of Arts");
  assert.equal(record.field, "Psychology");
  assert.equal(record.dateRange, "2018-2021");

  // 3.7.22: the degree and the years share ONE line at least as often as they
  // get two — "Bachelor of Laws - LLB • 2021-2024" is what the live card
  // renders. There was no line left over for the degree, so it came back
  // `null` and the whole line was stored as the date range.
  const welded = Applicants.parseEducationBlock(["CHANDIGARH UNIVERSITY", "Bachelor of Laws - LLB • 2021-2024"]);
  assert.equal(welded.institution, "CHANDIGARH UNIVERSITY");
  assert.equal(welded.degree, "Bachelor of Laws - LLB");
  assert.equal(welded.dateRange, "2021-2024");
});

test("an education card is never a job, a job is never a school, and a question is neither", () => {
  // THE DEFECT, from one live run and reported with both halves of the record:
  // Experience held the applicant's two jobs AND their two degrees, and
  // Education held the same four, plus the screening question as a third job.
  //
  // Two causes, one on each side. Structurally, a resolved root spanned both
  // sections and `blocksIn` handed the two readers the same cards. And neither
  // parser refused anything: both are shape-only — first line, then the line
  // with the dates — so two lines are two lines whatever they say.
  const degree = ["CHANDIGARH UNIVERSITY", "Bachelor of Laws - LLB • 2021-2024", "Education verified"];
  const job = ["Legal Assistant", "Bhatia and Khatri Law Office • 2024-Present"];
  const intern = ["Legal Intern", "Adv Sanjay Garg Law Office • 2022-2022"];
  const question = ["We must fill this position urgently. Can you start immediately?", "Ideal answer: Yes", "Yes"];

  assert.equal(Applicants.parseExperienceBlock(degree), null, "a degree at a university is not a job");
  assert.equal(Applicants.parseEducationBlock(job), null, "a law office is not a school");
  assert.equal(Applicants.parseEducationBlock(intern), null, "and neither is an internship with no education signal at all");
  assert.equal(Applicants.parseExperienceBlock(question), null, "no role is phrased as a question");
  assert.equal(Applicants.parseEducationBlock(question), null, "and no school is either");

  // Neither refusal may cost a section its own cards.
  const school = Applicants.parseEducationBlock(degree);
  assert.equal(school.institution, "CHANDIGARH UNIVERSITY");
  assert.equal(school.degree, "Bachelor of Laws - LLB");
  // "Education verified" is a line LinkedIn renders under a verified school.
  // EDUCATION_NOISE_PATTERN had four entries and did not know it, so it was
  // stored as an institution of its own, while "Experience verified" — on the
  // list the experience reader has used since 3.7.6 — was correctly discarded.
  assert.ok(!/verified/i.test(school.institution), "a verification badge is not a second school");
  assert.equal(Applicants.parseEducationBlock(["Education verified"]), null);

  const role = Applicants.parseExperienceBlock(job);
  assert.equal(role.title, "Legal Assistant");
  assert.equal(role.company, "Bhatia and Khatri Law Office");
  assert.equal(role.current, true);

  // THE ASYMMETRY, and why the experience refusal is the stricter of the two.
  // `deriveCurrentPosition` and `totalExperienceFrom` read the experience list
  // and nothing else, so a job dropped here empties three exported columns —
  // which makes a lost job as wrong as an invented one (rule 6). It therefore
  // takes a spelled-out qualification, which no employer is named, or an
  // institution corroborated by one. Working AT a university is still a job,
  // and an abbreviation that is also a company name still cannot refuse it.
  const professor = Applicants.parseExperienceBlock(["Assistant Professor", "Chandigarh University • 2020-Present"]);
  assert.equal(professor.company, "Chandigarh University");
  const aviation = Applicants.parseExperienceBlock(["Ground Engineer", "BBA Aviation • 2019-2023"]);
  assert.equal(aviation.company, "BBA Aviation");
});

test("one list of section titles, so both readers know where a section ends", () => {
  // The list lived on the experience reader and the education reader had four
  // entries of its own, which is the whole of why the two behaved differently
  // on identical input. It now names every section on the surface, because a
  // root that spans one boundary routinely spans the next as well.
  for (const title of [
    "Experience", "Work experience", "Education", "Educational background", "Skills", "Top skills",
    "Screening question responses", "Supplementary", "Qualifications", "Must-have qualifications",
    "Preferred qualifications", "Resume", "Contact info", "About", "Experience verified",
    "Education verified", "View full profile", "Show more",
    // A title is still a title with a count, a middot list or a colon after it.
    "Experience (5)", "Education:", "Skills · 12"
  ]) {
    assert.ok(Applicants.isSectionTitleLine(title), `"${title}" is a section title`);
  }
  // ...and content is not.
  for (const line of [
    "Legal Assistant", "Bhatia and Khatri Law Office • 2024-Present", "CHANDIGARH UNIVERSITY",
    "Bachelor of Laws - LLB", "Experience Cloud Consultant", "Education First"
  ]) {
    assert.ok(!Applicants.isSectionTitleLine(line), `"${line}" is content, not a title`);
  }
});

test("the job header reads the title and the applicant count off the screen", () => {
  const job = Applicants.parseJobHeader({
    text: ["Human Resources Executive", "Hiring plan", "Candidate search", "Applicants (665)", "Manage coworkers"].join("\n"),
    title: "Top fit | LinkedIn",
    url: APPLICANTS_URL
  });
  assert.equal(job.id, "4277798308");
  assert.equal(job.title, "Human Resources Executive");
  assert.equal(job.applicantCount, 665);
  // Not rendered on this view, so not invented on this view.
  assert.equal(job.company, null);
  assert.equal(job.location, null);
  assert.equal(job.description, null);
});

test("the job title is the header bar's one line that is not a view tab", () => {
  // The live bar, as it renders above both columns:
  // "Human resource recruiters · Hiring plan · Candidate search ·
  //  Applicants (1,005) · Manage coworkers".
  const bar = ["Human resource recruiters", "Hiring plan", "Candidate search", "Applicants (1,005)", "Manage coworkers"];
  assert.equal(Applicants.jobTitleFromHeader(bar.join("\n")), "Human resource recruiters");

  // Two distinct tabs is what identifies the bar at all, and a count never
  // makes one tab into two.
  assert.equal(Applicants.countJobViewTabs(bar.join("\n")), 4);
  assert.equal(Applicants.countJobViewTabs(["Applicants (1,005)", "Applicants (25)"].join("\n")), 1);
  assert.ok(Applicants.countJobViewTabs("Human resource recruiters") < 2, "the title alone does not identify a bar");

  // The tab LIST on its own renders every tab and no title, which is why
  // "holds the tabs" is not enough to be the header.
  const tabsOnly = ["Hiring plan", "Candidate search", "Applicants (1,005)", "Manage coworkers"].join("\n");
  assert.ok(Applicants.countJobViewTabs(tabsOnly) >= 2);
  assert.equal(Applicants.jobTitleFromHeader(tabsOnly), "", "and it carries no title to read");

  // Individual labels, so the container walk can be built on the same rule.
  assert.ok(Applicants.isJobViewTabLabel("Applicants (1,005)"));
  assert.ok(Applicants.isJobViewTabLabel("Manage coworkers"));
  assert.ok(!Applicants.isJobViewTabLabel("Human resource recruiters"));

  // And the whole point: the title reaches the record.
  const job = Applicants.parseJobHeader({ text: bar.join("\n"), title: "Top fit | LinkedIn", url: APPLICANTS_URL });
  assert.equal(job.title, "Human resource recruiters");
  assert.equal(job.applicantCount, 1005);
});

test("the job header is found by its own tabs, resolved once, and written to every applicant", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // THE DEFECT (3.7.23). The bar carrying the job title is a TAB bar, and the
  // sweep dropped anything inside a `nav` — so on markup that renders it as one
  // the single element holding the answer was excluded, and the title fell back
  // to `document.title` minus "| LinkedIn", which on this view names the tab
  // rather than the job. Where it was not excluded, "the four shortest matching
  // elements, joined" still let LinkedIn's own global header sort ahead of it.
  const find = source.slice(source.indexOf("function findJobViewHeader"), source.indexOf("function jobViewHeader"));
  assert.match(find, /Applicants\.isJobViewTabLabel\(cleanText\(element\.textContent\)\)/,
    "the bar is identified by the tabs it renders, never by a class name or a position (rule 7)");
  assert.match(find, /if \(Applicants\.countJobViewTabs\(text\) < 2\) continue;/, "two tabs, so one stray label is not a bar");
  assert.match(find, /if \(Applicants\.jobTitleFromHeader\(text\)\) return node;/,
    "and it has to hold a line that is NOT a tab — the tab list alone holds no title");
  assert.match(find, /if \(list && node\.contains\(list\)\) return null;/, "a container holding the applicant list is the page");
  assert.ok(!/isExcludedContext/.test(find),
    "a nav is allowed here because the element was proven by its own content rather than guessed at");

  // Resolved ONCE. `readJob` is called from `snapshotPanel`, which runs on every
  // pass of every applicant's scan, so a page-wide query there is paid hundreds
  // of times for an answer that cannot change while the list is walked.
  const cache = source.slice(source.indexOf("function jobViewHeader"), source.indexOf("function readJob"));
  assert.match(cache, /if \(cached && cached\.isConnected && isVisible\(cached\)\) return cached;/,
    "re-resolved only when the element has left the document");
  assert.match(source, /state\.jobHeader = null;/, "and dropped by beginRun, so another job never inherits this one's title");

  // Written to every applicant, and "once" means "once it answered".
  assert.match(source, /if \(!listJob\?\.title\) \{\s*\n\s*listJob = attempt\("read job"/,
    "a bar that had not hydrated when the run started must not title the whole job null");
  assert.match(source, /job: listJob,/, "and the one job read is what every row carries");
});

test("the location is a rendered place, never whatever the third line happened to be", () => {
  // THE LIVE DEFECT: every applicant's location was saved as
  // **"Filter and sort"** — a button in the *list* column. `location` was
  // `lines[2]` and nothing else, so whatever landed in that position became the
  // location. Array-position guessing, which rule 7 forbids, and the same class
  // of mistake that once saved six people as "Applicants" by taking the first
  // line as the name. The answer then was a rule about what a name IS.
  const panel = ["PRAVESH KOTIYAL · 1st", "Human Resource", "Noida, Uttar Pradesh, India", "Applied 13mo ago • Contacted 10mo ago"];
  assert.equal(Applicants.parseApplicantHeader({ text: panel.join("\n") }).location, "Noida, Uttar Pradesh, India");

  // Chrome in front of the real location no longer costs it — the place is
  // found, rather than the position being trusted.
  const withChrome = ["PRAVESH KOTIYAL · 1st", "Human Resource", "Filter and sort", "Noida, Uttar Pradesh, India", "Applied 13mo ago"];
  const fixed = Applicants.parseApplicantHeader({ text: withChrome.join("\n") });
  assert.equal(fixed.location, "Noida, Uttar Pradesh, India");
  assert.equal(fixed.headline, "Human Resource", "and the headline is untouched");

  // And when nothing on the panel looks like a place, the field stays EMPTY
  // rather than taking the line that was there (rule 1).
  assert.equal(
    Applicants.parseApplicantHeader({ text: ["PRAVESH KOTIYAL · 1st", "Human Resource", "Filter and sort", "Applied 13mo ago"].join("\n") }).location,
    "",
    "a wrong location is worse than a blank one"
  );

  for (const place of ["Noida, Uttar Pradesh, India", "New Delhi, Delhi, India", "Delhi, India", "Greater Delhi Area"]) {
    assert.ok(Applicants.looksLikeApplicantLocation(place), `"${place}" is a place`);
  }
  // Every one of these was on the live panel or beside it.
  for (const chrome of [
    "Filter and sort", "Shortlist", "Move to", "Contact", "Interview with AI", "Applicants (1,005)",
    "Human Resource", '"Innovator | Change Maker | Entrepreneurial Spirit in Action"',
    "Applied 13mo ago • Contacted 10mo ago"
  ]) {
    assert.ok(!Applicants.looksLikeApplicantLocation(chrome), `"${chrome}" is not a place`);
  }
});

test("the applicant header strips the badges and never reads the timeline as a status", () => {
  const header = Applicants.parseApplicantHeader({
    text: [
      "Mahak Ayani · 2nd",
      "HR Head | Talent Acquisition | Employer Branding | Digital Growth Strategist",
      "Delhi, India",
      "Applied 12mo ago • Contacted 12mo ago"
    ].join("\n")
  });
  assert.equal(header.name, "Mahak Ayani", "the degree badge is not part of somebody's name");

  // THE LIVE DEFECT: applicants saved as "Komal Sharma graphic" and "Harshita
  // Singh graphic". LinkedIn's portrait carries its accessible name as
  // `alt="<name> graphic"`, and only a LEADING "photo of" was ever stripped.
  //
  // Not merely cosmetic: `applicantId` hashes the name, so "Komal Sharma" and
  // "Komal Sharma graphic" are two records for one person — which is the
  // duplicate rows that were reported alongside it.
  assert.equal(Applicants.cleanApplicantName("Komal Sharma graphic"), "Komal Sharma");
  assert.equal(Applicants.cleanApplicantName("Harshita Singh graphic"), "Harshita Singh");
  assert.equal(
    Applicants.applicantId("1", "https://www.linkedin.com/in/komal", Applicants.cleanApplicantName("Komal Sharma graphic"), "9"),
    Applicants.applicantId("1", "https://www.linkedin.com/in/komal", "Komal Sharma", "9"),
    "the two spellings must hash to one record"
  );

  // Every shape LinkedIn puts on a portrait, in either order and repeated.
  for (const [raw, expected] of [
    ["Mahak Ayani photo", "Mahak Ayani"],
    ["Mahak Ayani's profile photo", "Mahak Ayani"],
    ["Mahak Ayani’s profile picture", "Mahak Ayani"],
    ["Mahak Ayani image", "Mahak Ayani"],
    ["Mahak Ayani logo", "Mahak Ayani"],
    ["Mahak Ayani graphic · 2nd", "Mahak Ayani"],
    ["Mahak Ayani · 2nd graphic", "Mahak Ayani"]
  ]) {
    assert.equal(Applicants.cleanApplicantName(raw), expected, `"${raw}" is not somebody's name`);
  }

  // A value that is NOTHING but the artifact collapses to "", and the candidate
  // policy then refuses it — the right answer for an image whose alt text names
  // nobody at all.
  assert.equal(Applicants.cleanApplicantName("graphic"), "");
  assert.equal(Applicants.isApplicantNameCandidate("graphic"), false);
  // And a real name is never shortened: the artifact is only ever stripped from
  // the END, and none of these words is a surname.
  assert.equal(Applicants.cleanApplicantName("Neeshu Kalkhanday"), "Neeshu Kalkhanday");
  assert.equal(Applicants.cleanApplicantName("Sharmila Dash"), "Sharmila Dash");
  assert.equal(header.location, "Delhi, India");
  assert.equal(header.appliedAt, "12mo ago");
  assert.equal(header.contactedAt, "12mo ago");
  // "Contacted 12mo ago" contains the word, and is not the application status.
  assert.equal(header.applicationStatus, "");

  const shortlisted = Applicants.parseApplicantHeader({
    text: ["Aanchal Sharma · 1st", "Talent Acquisition Specialist", "Gurugram, Haryana, India", "Shortlisted"].join("\n")
  });
  assert.equal(shortlisted.applicationStatus, "Shortlisted");
  assert.equal(Applicants.cleanApplicantName("Gargi Kumari Verified · 2nd"), "Gargi Kumari");
});

test("page chrome is never saved as somebody's name", () => {
  // The live defect, verbatim: the detail panel resolved to a container that
  // also held the applicant list, so the first line of its text was the list's
  // own heading — and every record came back named "Applicants".
  for (const chrome of [
    "Applicants", "Qualifications", "Must-have", "Preferred", "Experience", "Education",
    "Screening question responses", "Supplementary", "Hiring plan", "Candidate search",
    "Manage coworkers", "Top fit", "Filter and sort", "Resume", "Share", "Shortlist",
    "Interview with AI", "Rate this AI-generated content", "View full profile", "Messaging"
  ]) {
    assert.equal(Applicants.isApplicantNameCandidate(chrome), false, `"${chrome}" must never be a name`);
  }

  // The SECOND live defect of the same shape, reported from the saved table:
  // every applicant came back named "Edit qualifications". The chrome list is
  // anchored at the start and does contain `qualifications`, but the label leads
  // with a verb, so it never reached that term — and two capitalised words then
  // passed every remaining test. A control phrase is a thing to press.
  for (const control of [
    "Edit qualifications", "Edit screening questions", "Add note", "Download resume",
    "Send message", "Manage coworkers", "Rate this candidate", "Schedule interview",
    "Export applicants", "Search candidates", "Next page"
  ]) {
    assert.equal(Applicants.isApplicantNameCandidate(control), false, `"${control}" is a control, not a person`);
  }

  // Real names still pass — including every one from the reference account.
  for (const name of [
    "Mahak Ayani", "Aanchal Sharma", "Gargi Kumari", "Jean-Luc Picard", "Ana María López",
    "Vandana Singh", "Sufia Najeeb", "Kumari Ashu", "Sumika Tiwari", "Aman Sharma",
    "Sachindra N. Roy", "Akash Srivastaava", "Ajit Kumar Giri", "Anil Kumar Yadav",
    "Neeshu Kalkhanday"
  ]) {
    assert.equal(Applicants.isApplicantNameCandidate(name), true, `"${name}" is a name`);
  }

  // The verb list holds only words that are not themselves given names, and the
  // phrase needs a SECOND word — so a bare "Edit", a real Hungarian given name,
  // is still accepted rather than trading a wrong name for a missing one.
  assert.equal(Applicants.isApplicantNameCandidate("Edit"), true, "a bare given name survives");
  for (const given of ["Mark Zuckerberg", "Grant Mitchell", "Will Smith", "Rose Byrne", "Art Garfunkel"]) {
    assert.equal(Applicants.isApplicantNameCandidate(given), true, `"${given}" is a person`);
  }

  // Neither is an address, a count, a date, or a sentence.
  assert.equal(Applicants.isApplicantNameCandidate("ayanimahak99@gmail.com"), false);
  assert.equal(Applicants.isApplicantNameCandidate("665 applicants"), false);
  assert.equal(Applicants.isApplicantNameCandidate("applied 12mo ago"), false, "a lowercase first word is not a name");
  assert.equal(Applicants.isApplicantNameCandidate("Mahak Ayani has three years of experience at Healthtrip"), false, "too many words");
  assert.equal(Applicants.isApplicantNameCandidate(""), false);

  // And the parser no longer takes the first line on trust.
  const header = Applicants.parseApplicantHeader({ text: "Applicants\nHR Head | Talent Acquisition\nDelhi, India" });
  assert.equal(header.name, "", "an unusable first line yields no name rather than a wrong one");
});

test("the platform's own explanation sentences say who the applicant is", () => {
  // LinkedIn writes every verdict as a sentence about the applicant, so the
  // words those sentences share at the front are the name — stated by the
  // platform, in prose, where no markup change can move it.
  const name = Applicants.nameFromExplanations([
    "Mahak Ayani answered 'Yes' to having completed a Bachelor's Degree.",
    "Mahak Ayani has 3 years of experience as a Human Resources Manager at Healthtrip.",
    "Mahak Ayani is located in Delhi, India, which is commutable to Noida."
  ]);
  assert.equal(name, "Mahak Ayani");

  // A shared verb after the name is not part of it.
  assert.equal(
    Applicants.nameFromExplanations([
      "Aanchal Sharma has 5 years of experience.",
      "Aanchal Sharma has a Bachelor's Degree."
    ]),
    "Aanchal Sharma"
  );

  // One sentence is a prefix of itself and proves nothing.
  assert.equal(Applicants.nameFromExplanations(["Mahak Ayani answered 'Yes'."]), "");
  assert.equal(Applicants.nameFromExplanations([]), "");
  // Sentences about different people agree on nothing.
  assert.equal(
    Applicants.nameFromExplanations(["Mahak Ayani has 3 years.", "Gargi Kumari has 4 years."]),
    ""
  );
  // A shared opener that is not a name is refused.
  assert.equal(
    Applicants.nameFromExplanations([
      "Information cannot be provided for this qualification",
      "Information cannot be evaluated for this qualification"
    ]),
    "",
    "shared chrome is not a name"
  );
});

test("the name the explanations agree with wins over the name the markup offered", () => {
  const candidates = [
    { value: "Applicants", source: "first-line" },
    { value: "Mahak Ayani", source: "list-row" }
  ];

  // Corroborated: the explanations settle it, whatever order the markup gave.
  const corroborated = Applicants.chooseApplicantName(candidates, "Mahak Ayani");
  assert.equal(corroborated.name, "Mahak Ayani");
  assert.equal(corroborated.source, "list-row");
  assert.equal(corroborated.corroborated, true);

  // Uncorroborated: the first candidate that could be a name at all. Note that
  // "Applicants" is filtered out before preference order is even consulted.
  const guessed = Applicants.chooseApplicantName(candidates, "");
  assert.equal(guessed.name, "Mahak Ayani");
  assert.equal(guessed.corroborated, false);

  // The explanations name somebody the markup never offered: trust the prose.
  const unseen = Applicants.chooseApplicantName([{ value: "Applicants", source: "first-line" }], "Gargi Kumari");
  assert.equal(unseen.name, "Gargi Kumari");
  assert.equal(unseen.source, "explanations");

  // Nothing usable anywhere is an empty name, never a guess.
  assert.deepEqual(
    Applicants.chooseApplicantName([{ value: "Qualifications", source: "panel-heading" }], ""),
    { name: "", source: "", corroborated: false }
  );
});

test("a corroborated name replaces a guessed one, and nothing replaces a corroborated one", () => {
  // The name is the one header field that may be replaced: its strongest
  // evidence only exists once the qualifications have been read, which on a
  // slow panel is after the first snapshot.
  const accumulator = Applicants.createApplicantAccumulator();
  assert.equal(accumulator.addName("Mahak"), "added");
  assert.equal(accumulator.addName("Mahak Ayani", true), "replaced");
  assert.equal(accumulator.snapshot().header.name, "Mahak Ayani");
  assert.equal(accumulator.addName("Somebody Else", true), "unchanged", "a corroborated name is final");
  assert.equal(accumulator.addName("Guess"), "unchanged");
  assert.equal(accumulator.snapshot().header.name, "Mahak Ayani");

  // Every other header field stays first-wins.
  const other = Applicants.createApplicantAccumulator();
  other.addHeader({ location: "Delhi, India" });
  other.addHeader({ location: "Noida" });
  assert.equal(other.snapshot().header.location, "Delhi, India");
});

test("an absent value is null, never an empty string and never a guess", () => {
  const record = Applicants.normalizeApplicantRecord({
    applicant: { name: "Mahak Ayani" },
    job: { id: "4277798308" }
  });
  assert.equal(record.applicant.contact.email, null);
  assert.equal(record.applicant.contact.phone, null);
  assert.equal(record.applicant.contact.website, null);
  assert.deepEqual(record.applicant.contact.other, []);
  assert.equal(record.applicant.resume.available, false);
  assert.equal(record.applicant.resume.filename, null);
  assert.equal(record.applicant.resume.downloadStatus, Applicants.RESUME_STATUS.NOT_ATTEMPTED);
  assert.equal(record.applicant.currentRole, null);
  assert.equal(record.applicant.totalExperience, null);
  assert.equal(record.applicant.applicationStatus, null);
  assert.equal(record.job.company, null);

  // The specified schema, key for key.
  assert.deepEqual(Object.keys(record.applicant.contact).sort(), ["email", "other", "phone", "website"]);
  for (const key of ["available", "filename", "fileType", "localReference", "downloadStatus"]) {
    assert.ok(key in record.applicant.resume, `resume.${key} is part of the specified schema`);
  }
  for (const key of ["timestamp", "sourceUrl", "warnings", "rawData"]) {
    assert.ok(key in record.extraction, `extraction.${key} is part of the specified schema`);
  }
  // Idempotent, so it is safe on read as well as on write.
  const twice = Applicants.normalizeApplicantRecord(record);
  assert.equal(twice.id, record.id);
  assert.deepEqual(twice.applicant, record.applicant);
});

test("the same applicant on two different jobs is two different records", () => {
  const first = Applicants.applicantId("4277798308", "https://www.linkedin.com/in/mahak", "Mahak Ayani", "25550787924");
  const second = Applicants.applicantId("9999999999", "https://www.linkedin.com/in/mahak", "Mahak Ayani", "111");
  assert.notEqual(first, second, "an applicant is a person ON A JOB");
  // Stable, and blind to which sub-view of the profile the URL happened to be.
  assert.equal(
    Applicants.applicantId("4277798308", "https://www.linkedin.com/in/mahak/overlay/contact-info/", "Mahak Ayani", "25550787924"),
    first
  );
});

test("re-collecting an applicant enriches the record and never re-downloads the resume", () => {
  const stored = Applicants.normalizeApplicantRecord({
    job: { id: "4277798308" },
    applicant: {
      name: "Mahak Ayani",
      skills: ["Recruitment"],
      contact: { email: "mahak@example.com" },
      resume: { available: true, filename: "mahak.pdf", url: "https://media.licdn.com/x.pdf", downloadStatus: "downloaded" }
    }
  });
  const again = Applicants.normalizeApplicantRecord({
    job: { id: "4277798308" },
    applicant: {
      name: "Mahak Ayani",
      skills: ["Onboarding"],
      contact: { phone: "+919876543210" },
      resume: { available: true, url: "https://media.licdn.com/x.pdf", downloadStatus: "not_attempted" }
    }
  });
  const merged = Applicants.mergeApplicantRecord(stored, again);

  assert.deepEqual(merged.applicant.skills, ["Recruitment", "Onboarding"], "a second pass adds, it does not replace");
  assert.equal(merged.applicant.contact.email, "mahak@example.com", "a value already found is never lost");
  assert.equal(merged.applicant.contact.phone, "+919876543210", "and a new one is kept");
  assert.equal(merged.applicant.resume.downloadStatus, "downloaded", "a saved resume stays saved");
  assert.equal(merged.applicant.resume.filename, "mahak.pdf", "so the second visit does not download it again");
  assert.equal(merged.collectedAt, stored.collectedAt, "record identity survives");
  assert.equal(merged.id, stored.id);
});

test("a thinner later read never erases a fuller stored one", () => {
  // THE DEFECT. "Never overwrites a filled field with a blank" was true of the
  // lists, of `contact` and of `job` — each merged field by field — and NOT of
  // the applicant's own scalars, which arrived by `...after.applicant`. So a
  // second visit that saw less than the first deleted the difference, silently,
  // and the record then looked exactly like somebody with no current role.
  //
  // Not hypothetical, and not only about the list pass: rule 12a pauses a scan
  // the moment the tab is hidden, `revealPanelContent` gives up on a column it
  // cannot move, and a re-mount can leave a section unread. A later read is more
  // hydrated *usually*, never *reliably*.
  const stored = Applicants.normalizeApplicantRecord({
    applicationId: "25550787924",
    job: { id: "4277798308", title: "Human Resources Executive" },
    applicant: {
      name: "Mahak Ayani",
      profileUrl: "https://www.linkedin.com/in/mahak-ayani",
      headline: "HR Head",
      location: "Delhi, India",
      currentRole: "HR Manager",
      currentCompany: "Naad Wellness",
      totalExperience: "4 yrs",
      appliedAt: "12mo ago",
      contactedAt: "12mo ago",
      applicationStatus: "Reviewed",
      resume: { available: true, filename: "mahak.pdf", fileType: "pdf", pages: 3, url: "https://media.licdn.com/x.pdf", downloadStatus: "downloaded" }
    }
  });

  // A pass that read the row and nothing else — every scalar null.
  const thin = Applicants.normalizeApplicantRecord({
    applicationId: "25550787924",
    job: { id: "4277798308" },
    applicant: { name: "Mahak Ayani" }
  });

  const merged = Applicants.mergeApplicantRecord(stored, thin);
  for (const field of Applicants.APPLICANT_SCALAR_FIELDS) {
    assert.equal(merged.applicant[field], stored.applicant[field], `${field} must survive a thinner read`);
  }
  assert.equal(merged.job.title, "Human Resources Executive", "and so must the job header");
  assert.equal(merged.applicationId, "25550787924");

  // The resume had the identical hole: `{...before, ...after}` let a pass that
  // found no file write `filename: null` over a stored name.
  assert.equal(merged.applicant.resume.filename, "mahak.pdf");
  assert.equal(merged.applicant.resume.fileType, "pdf");
  assert.equal(merged.applicant.resume.pages, 3);
  assert.equal(merged.applicant.resume.available, true, "a resume seen once exists");
  assert.equal(merged.applicant.resume.downloadStatus, "downloaded");

  // "I did not look" must never overwrite "I looked, and here is what I found"
  // — which generalises `keepDownload` rather than replacing it.
  const linkOnly = Applicants.normalizeApplicantRecord({
    applicant: { name: "A", resume: { available: true, viewerUrl: "https://www.linkedin.com/hiring/x", downloadStatus: "link_only" } }
  });
  const notLooked = Applicants.normalizeApplicantRecord({ applicant: { name: "A" } });
  assert.equal(
    Applicants.mergeApplicantRecord(linkOnly, notLooked).applicant.resume.downloadStatus,
    "link_only",
    "not_attempted is 'I did not look', never 'there is nothing'"
  );
  // But a real later verdict still wins, or a wrong answer could never be fixed.
  const failed = Applicants.normalizeApplicantRecord({
    applicant: { name: "A", resume: { available: true, downloadStatus: "failed" } }
  });
  assert.equal(
    Applicants.mergeApplicantRecord(linkOnly, failed).applicant.resume.downloadStatus,
    "failed",
    "a pass that did look may correct the record"
  );

  // A FULLER read still wins, in both directions — this is prefer-filled, not
  // prefer-stored. Otherwise a corrected name or a changed role could never land.
  const fuller = Applicants.normalizeApplicantRecord({
    applicant: { name: "Mahak Ayani", currentRole: "Head of HR", location: "Gurugram, India" }
  });
  const forward = Applicants.mergeApplicantRecord(stored, fuller);
  assert.equal(forward.applicant.currentRole, "Head of HR", "a newer value that exists still wins");
  assert.equal(forward.applicant.location, "Gurugram, India");
  assert.equal(forward.applicant.headline, "HR Head", "and what it did not mention is kept");

  // `false` and `0` are values, not absences.
  assert.equal(Applicants.APPLICANT_SCALAR_FIELDS.includes("name"), true,
    "a re-read that resolved no name must not blank the stored one");
});

test("the accumulator is merge-only, so a section scrolled past is not lost", () => {
  const accumulator = Applicants.createApplicantAccumulator();
  accumulator.addName("Mahak Ayani");
  accumulator.addHeader({ location: "Delhi, India" });
  accumulator.addExperience(Applicants.parseExperienceBlock(["HR Manager", "Naad Wellness • 2026-Present"]));
  const afterFirst = accumulator.signature();

  // The panel unmounts Experience and mounts Education as the scan moves on.
  accumulator.addEducation(Applicants.parseEducationBlock(["University of Delhi", "Bachelor of Arts", "2018-2021"]));
  assert.notEqual(accumulator.signature(), afterFirst, "new content must restart the quiet count");

  // A later, emptier read of a header field must not blank what is already there.
  accumulator.addHeader({ location: "" });
  accumulator.addName("");
  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.header.name, "Mahak Ayani");
  assert.equal(snapshot.experience.length, 1, "the unmounted section is still in the record");
  assert.equal(snapshot.education.length, 1);

  // The same card read twice is one entry.
  accumulator.addExperience(Applicants.parseExperienceBlock(["HR Manager", "Naad Wellness • 2026-Present"]));
  assert.equal(accumulator.snapshot().experience.length, 1);
});

test("the finished record carries the job's requirements as well as the verdicts", () => {
  const accumulator = Applicants.createApplicantAccumulator();
  accumulator.addHeader({ name: "Mahak Ayani" });
  accumulator.addQualification(Applicants.parseQualificationBlock({
    category: "must_have",
    lines: ["Bachelor's degree in HR.", "Mahak Ayani answered 'Yes'.", "Based on the applicant's responses to the screening questions"]
  }));
  accumulator.addQualification(Applicants.parseQualificationBlock({
    category: "preferred",
    lines: ["Strong communication and interpersonal skills.", "Information cannot be provided or evaluated for this qualification"]
  }));
  accumulator.addScreening(Applicants.parseScreeningBlock({
    lines: ["Have you completed a Bachelor's Degree?", "Ideal answer: Yes", "Yes"]
  }));
  accumulator.addContactPanel({ emails: ["mahak@example.com", "second@example.com"], phones: ["+919876543210"], websites: [] });

  const record = Applicants.buildApplicantRecord({
    snapshot: accumulator.snapshot(),
    context: { jobId: "4277798308", applicationId: "25550787924" },
    sourceUrl: APPLICANTS_URL,
    buildId: "test"
  });

  assert.deepEqual(record.job.mustHaveQualifications, ["Bachelor's degree in HR."]);
  assert.deepEqual(record.job.preferredQualifications, ["Strong communication and interpersonal skills."]);
  assert.equal(record.job.screeningQuestions.length, 1);
  assert.equal(record.job.screeningQuestions[0].idealAnswer, "Yes");
  assert.equal(record.job.screeningQuestions[0].answer, null, "the job carries the question, the person carries the answer");
  assert.equal(record.applicant.screeningResponses[0].answer, "Yes");
  assert.equal(record.applicant.contact.email, "mahak@example.com");
  assert.equal(record.applicant.contact.phone, "+919876543210");
  // Nothing found is thrown away: the second address is kept, labelled.
  assert.deepEqual(record.applicant.contact.other, ["email: second@example.com"]);
  assert.equal(record.applicationId, "25550787924");
  assert.equal(record.extraction.sourceUrl, APPLICANTS_URL);
  assert.equal(record.job.id, "4277798308");
});

test("Stop takes effect before the next applicant, not at the end of the list", () => {
  const running = Applicants.createRunState({ state: "running", index: 3 });
  assert.deepEqual(Applicants.nextRunStep(running, { total: 10 }), {
    action: "collect", reason: "next-applicant", index: 3
  });

  const stopping = Applicants.createRunState({ ...running, stopRequested: true });
  assert.equal(Applicants.nextRunStep(stopping, { total: 10 }).action, "stop");
  // The flag is checked before the total, so Stop wins even mid-list.
  assert.equal(Applicants.nextRunStep(stopping, { total: 0 }).action, "stop");

  assert.equal(Applicants.nextRunStep(Applicants.createRunState({ index: 10 }), { total: 10 }).action, "done");
  assert.equal(Applicants.nextRunStep(Applicants.createRunState(), { total: 0 }).action, "done");
});

test("a run knows who is already saved and walks past them", () => {
  const saved = (patch) => Applicants.normalizeApplicantRecord({
    applicationId: patch.applicationId,
    job: { id: patch.jobId || "4277798308" },
    applicant: { name: patch.name, ...patch.applicant }
  });

  const records = [
    saved({ applicationId: "31754123946", name: "Anamika Singh", applicant: { contact: { email: "a@example.com" } } }),
    saved({ applicationId: "25550787924", name: "Mahak Ayani", applicant: { skills: ["Recruitment"] } }),
    // A row that was reached but produced nothing but a name is a run that
    // FAILED on that applicant. Skipping it would make the failure permanent.
    saved({ applicationId: "99999999999", name: "Gargi Kumari" }),
    // Another job entirely: the same person there is still a second record.
    saved({ applicationId: "11111111111", jobId: "9999", name: "Deepika Kukreja", applicant: { skills: ["HRMS"] } })
  ];

  const index = Applicants.createCollectedIndex(records, { jobId: "4277798308" });
  assert.equal(index.has({ applicationId: "31754123946" }), true);
  assert.equal(index.has({ applicationId: "25550787924" }), true);
  assert.equal(index.has({ applicationId: "99999999999" }), false, "a name-only record is not a collected one");
  assert.equal(index.has({ applicationId: "11111111111" }), false, "another job's record must not skip this job's row");

  // The id decides whenever the row has one, so two people with the same name
  // on one job are still two rows.
  assert.equal(index.has({ applicationId: "40000000000", name: "Anamika Singh" }), false);
  // The name only ever stands in for a row that carries no id at all.
  assert.equal(index.has({ name: "Anamika Singh" }), true);
  assert.equal(index.has({ name: "Nobody At All" }), false);
  assert.equal(index.has({}), false);

  // What the run asks for when the recruiter wants the whole list again.
  const forced = Applicants.createCollectedIndex([], { jobId: "4277798308" });
  assert.equal(forced.size, 0);
  assert.equal(forced.has({ applicationId: "31754123946" }), false);

  // The lean entry the worker actually sends carries the verdict already made,
  // so the same policy serves both shapes without a second copy of the rule.
  const lean = Applicants.createCollectedIndex(
    [{ applicationId: "31754123946", jobId: "4277798308", name: "Anamika Singh", collected: true },
      { applicationId: "77777777777", jobId: "4277798308", name: "Someone", collected: false }],
    { jobId: "4277798308" }
  );
  assert.equal(lean.has({ applicationId: "31754123946" }), true);
  assert.equal(lean.has({ applicationId: "77777777777" }), false);
});

test("only a record carrying something counts as collected", () => {
  const of = (applicant) => Applicants.normalizeApplicantRecord({ applicant: { name: "X", ...applicant } });
  assert.equal(Applicants.isCollectedApplicant(of({})), false, "a name alone is a failed pass");
  assert.equal(Applicants.isCollectedApplicant(of({ contact: { email: "a@b.com" } })), true);
  assert.equal(Applicants.isCollectedApplicant(of({ contact: { phone: "+918896437748" } })), true);
  assert.equal(Applicants.isCollectedApplicant(of({ skills: ["HRMS"] })), true);
  assert.equal(Applicants.isCollectedApplicant(of({ experience: [{ title: "Talent Partner" }] })), true);
  assert.equal(Applicants.isCollectedApplicant(of({ education: [{ institution: "Gautam Buddha University" }] })), true);
  assert.equal(
    Applicants.isCollectedApplicant(of({ qualifications: [{ requirement: "Bachelor's degree", result: "matched" }] })),
    true
  );
  assert.equal(Applicants.isCollectedApplicant(of({ resume: { available: true } })), true);
  assert.equal(Applicants.isCollectedApplicant(of({ resume: { available: false } })), false);
  assert.equal(Applicants.isCollectedApplicant(null), false);
  assert.equal(Applicants.isCollectedApplicant({}), false);

  // The counter the run reports it against.
  assert.equal(Applicants.createRunState().alreadyCollected, 0);
});

// ------------------------------------------------------------ the adapter
// Source assertions, the same way the profile and connections adapters are
// held to their click budget.

test("the applicants adapter clicks only its gated controls", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const clicks = source.match(/\.click\(\)/g) || [];
  // Six gated opens — contact, resume, a collapsed section, the next row, the
  // list's own next-page control (3.7.8, rule 9h) and the opened viewer's own
  // Download (3.7.9, rule 9i) — plus the one shared dismiss that closes
  // whichever overlay was opened.
  //
  // The pager has TWO callers since the list became on-demand, and deliberately
  // one call site: a second site for a control rule 9 already names would raise
  // this number without adding a control, and the number is only worth asserting
  // while it counts controls.
  assert.equal(clicks.length, 7, `only six gated controls and one dismiss may be clicked, found ${clicks.length}`);
  assert.equal(
    (source.match(/control\.element\.click\(\)/g) || []).length,
    5,
    "every open must go through a classified verdict"
  );
  assert.match(source, /pager\.element\.click\(\);/, "and so must the pager");
  const dismiss = source.slice(source.indexOf("async function closeOpenedOverlay"), source.indexOf("/** The disclosure LinkedIn mounted"));
  assert.match(dismiss, /element\.click\(\)/, "and one dismiss closes whichever overlay was opened");
  assert.equal((dismiss.match(/\.click\(\)/g) || []).length, 1, "the dismiss is one click, retried — never several controls");
  assert.match(source, /Applicants\.classifyApplicantControl\(/, "the policy decides which element that is");
  // The proof, not the assumption: every verdict is given a container test.
  assert.match(source, /inContainer: container\.contains\(element\)/, "a control must be proven inside its container");
});

test("the applicants adapter stays framework-free and restores the scroll position", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  assert.ok(!/\bReact\b/.test(withoutComments(source)), "no React in a content script");
  assert.match(source, /finally \{[\s\S]*?scrollPanelTo\(originalY, target\)/, "the panel must be handed back where it was");
  assert.match(source, /Applicants\.chooseColumnScrollTarget\?\.\(candidates\)/, "the column policy must pick the container");
  assert.match(source, /Connections\.chooseScrollTarget\(candidates\)/, "with the tested general chooser as the fallback");
  assert.match(source, /document\.scrollingElement/, "the document must always be offered as a candidate");
  assert.match(source, /for \(let current = root; current; current = current\.parentElement\)/, "and every ancestor of the panel");
  assert.match(source, /document\.visibilityState === "visible"/, "a hidden page must never be read");
});

test("the column that scrolls is the panel's own, never the page around it", () => {
  // The live defect: the hiring page scrolls its own header a little, so the
  // connections chooser's +60 for `isScrollingElement` beat the applicant
  // column every time. The run then scrolled the page, the column never moved,
  // the first read was already "the bottom", and the scan settled having seen
  // one screenful — no Experience section, and a 665-applicant list that
  // produced a handful of rows.
  const page = {
    id: "document", isScrollingElement: true, isDocumentRoot: true,
    overflowY: "auto auto", scrollHeight: 1400, clientHeight: 900,
    containsList: true, carriesContent: true, depth: 0
  };
  const shell = {
    id: "div#4", isScrollingElement: false, isDocumentRoot: false,
    overflowY: "visible visible", scrollHeight: 900, clientHeight: 900,
    containsList: true, carriesContent: true, depth: 4
  };
  const column = {
    id: "div#9", isScrollingElement: false, isDocumentRoot: false,
    overflowY: "auto auto", scrollHeight: 9000, clientHeight: 700,
    containsList: true, carriesContent: true, depth: 9
  };

  const chosen = Applicants.chooseColumnScrollTarget([page, shell, column]);
  assert.equal(chosen.id, "div#9", "the applicant column is what has to move");
  assert.equal(chosen.range, 8300);

  // The page is refused however much range it has, because handling it is the
  // fallback chooser's job and not this one's.
  assert.equal(Applicants.chooseColumnScrollTarget([page]), null);
  assert.equal(Applicants.chooseColumnScrollTarget([page, shell]), null, "an element that cannot move is not a scroller");
  assert.equal(Applicants.chooseColumnScrollTarget([]), null);

  // A scroll box that carries a filter rather than the content being read is
  // refused outright — the same rule the connections chooser applies.
  const filter = { ...column, id: "div#11", depth: 11, carriesContent: false, containsList: false };
  assert.equal(Applicants.chooseColumnScrollTarget([filter]), null);
  assert.equal(Applicants.chooseColumnScrollTarget([filter, column]).id, "div#9");

  // Innermost wins: an outer qualifying container here is the page shell.
  const outer = { ...column, id: "div#2", depth: 2 };
  assert.equal(Applicants.chooseColumnScrollTarget([outer, column]).id, "div#9");

  // A candidate with no `carriesContent` falls back to `containsList`, so the
  // descriptor the connections chooser already produces still works.
  const legacy = { id: "div#7", overflowY: "scroll scroll", scrollHeight: 5000, clientHeight: 800, containsList: true, depth: 7 };
  assert.equal(Applicants.chooseColumnScrollTarget([legacy]).id, "div#7");
});

test("the panel is re-resolved and the whole column is walked, not one screenful", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // A detached node keeps answering `innerText` with what it held when it was
  // unmounted, so a scan that held one reference re-read its first screenful.
  assert.match(source, /function livePanel\(panel\)/, "the panel must be re-resolvable");
  assert.match(source, /panel && panel\.isConnected \? panel : applicantPanel\(\)/, "a detached panel is not the panel");

  const scan = source.slice(source.indexOf("async function scanApplicantPanel"), source.indexOf("// ---------------------------------------------------------- extraction"));
  assert.match(scan, /live = livePanel\(live\)[\s\S]*?snapshotPanel\(live/, "every read must be of the live column");
  assert.match(scan, /target = chooseScrollTarget\(live\) \|\| target/, "and the target re-chosen once the column has content");
  assert.match(scan, /viewportHeight: viewportOf\(target\)/, "the viewport must be read live, not remembered");

  // Sections below the fold only exist once the walk has reached them, so the
  // expander runs again there — inside one shared budget, not a second eight.
  assert.match(scan, /await expandCollapsedSections\(live, diagnostics, budget\)/, "what mounted late may still be collapsed");
  assert.match(source, /function createExpansionBudget\(\)/, "the expansion budget must be shared");
  assert.match(source, /for \(; budget\.used < MAX_EXPANSIONS; \)/, "and it must still be eight clicks in total");

  // `scrollHeight` is live, so `clientHeight` has to be too.
  const max = source.slice(source.indexOf("function maxScrollPosition"), source.indexOf("function scrollPanelTo"));
  assert.match(max, /target\.element\.scrollHeight - viewportOf\(target\)/, "a remembered height ends the walk early");
});

test("a scroll box inside the panel is offered as well as every ancestor", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const candidates = source.slice(source.indexOf("function scrollCandidates"), source.indexOf("/**\n   * The container that actually moves"));

  // Which side of the scroller `applicantPanel()` lands on is markup's choice.
  assert.match(candidates, /root\.querySelectorAll\("div,section,main,ul,ol,\[role='list'\]"\)/, "descendants must be offered too");
  assert.match(candidates, /COLUMN_TEXT_SHARE/, "but only ones that carry essentially the whole panel");
  assert.match(candidates, /Applicants\.COLUMN_SCROLL_EPSILON/, "and only ones that can actually move");
  assert.match(source, /carriesContent: carriesContent === null \? holdsRoot : Boolean\(carriesContent\)/,
    "a descendant holds no ancestor, so it has to be told that it carries the content");
});

test("the panel is walked to the bottom before any overlay is opened", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const extract = source.slice(source.indexOf("async function extractApplicant"));
  const scanAt = extract.indexOf("await scanApplicantPanel(");
  const contactAt = extract.indexOf("await openContactAndCollect(");
  const resumeAt = extract.indexOf("await collectResume(");
  const buildAt = extract.indexOf("const record = Applicants.buildApplicantRecord(");
  assert.ok(scanAt > 0, "the panel must be scanned");
  assert.ok(contactAt > scanAt, "a modal opened mid-scan would stop the lazy walk dead");
  assert.ok(resumeAt > contactAt, "and the resume comes after the contact disclosure");
  assert.ok(buildAt > resumeAt, "the record is assembled only after everything has been read");

  // A failing section is a warning, not the end of the extraction.
  assert.match(source, /function attempt\(/, "each reader must be individually recoverable");
  assert.match(source, /accumulator\.addWarning\(/, "a failed field must be logged, not thrown away");
  // Explicit conditions rather than fixed sleeps wherever one exists.
  assert.match(source, /async function waitFor\(/, "waits must be on conditions");
  assert.match(source, /waitForDomQuiet\(/, "and on the DOM settling");
});

test("every loop in the applicants adapter can be stopped", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  assert.match(source, /function assertRunnable\(/, "one place decides whether work may continue");
  assert.match(source, /if \(state\.aborted\) throw stoppedError\(\)/, "and Stop is the first thing it checks");
  assert.match(source, /PV_STOP_ALL/, "the universal Stop must reach this surface");
  assert.match(source, /Applicants\.nextRunStep\(/, "the run loop must use the tested step policy");
  // A stop is an interruption, never a failed applicant.
  assert.match(source, /error\?\.stopped/, "a stop must be distinguished from a failure");
});

test("each finished applicant is persisted immediately, not at the end of the run", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  assert.match(source, /type: "PV_APPLICANT_SAVE", record/, "records must stream to the worker as they finish");
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /APPLICANT_MESSAGES\.SAVE/, "the worker must accept the streamed record");
  assert.match(worker, /await saveApplicant\(/, "and persist it through the merging adapter");
});

test("the resume is fetched by the worker, only from LinkedIn, and only once", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const download = worker.slice(worker.indexOf("async function downloadResume"), worker.indexOf("async function stopAllContentScripts"));
  assert.match(download, /RESUME_HOST_PATTERN\.test\(url\)/, "a non-LinkedIn host must be refused");
  assert.match(download, /refused-non-linkedin-host/, "and said so, rather than silently skipped");
  assert.match(download, /await resumeAlreadyDownloaded\(url\)/, "an already-saved resume must not download twice");
  assert.match(download, /saveAs: false/, "a 600-applicant run must not ask 600 questions");
  assert.match(download, /conflictAction: "uniquify"/, "and two applicants' files must not collide");
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  assert.ok(!/chrome\.downloads/.test(withoutComments(source)),
    "a content script has no downloads API and must not pretend to");

  // The other half of the guard lives in the tab, for the same run.
  assert.match(source, /state\.downloadedResumes\.has\(key\)/, "the tab keeps its own set for the current run");
  assert.match(source, /RESUME_STATUS\.UNAVAILABLE/, "no control means unavailable, never a guessed link");
});

test("a saved resume is named after the applicant, and the name is made safe first", () => {
  const { sanitizeFileName, resumeFileName, resumeFileExtension } = Applicants;

  // A folder of `AQHb3kJ2...` media ids is a folder nobody can use, so the file
  // is named after the person.
  assert.equal(resumeFileName({ name: "John Smith", fileType: "pdf" }), "John Smith.pdf");

  // Every character a filesystem refuses, gone — and gone as a separator, not
  // deleted, so "Ann/Marie" does not silently become "AnnMarie".
  assert.equal(sanitizeFileName('An/na\\Ma:ri*a?"<>|'), "An na Ma ri a");
  assert.equal(sanitizeFileName("  Priya   Sharma  "), "Priya Sharma", "runs of whitespace collapse and the ends trim");
  // A leading dot hides the file on Unix; a trailing dot or space is silently
  // dropped by Windows, so the same name writes differently on two machines.
  assert.equal(sanitizeFileName("...John."), "John");
  assert.equal(sanitizeFileName(".hidden"), "hidden");
  // Windows device names are not files. `CON.pdf` fails or lands somewhere else.
  assert.equal(sanitizeFileName("CON"), "CON file");
  assert.equal(sanitizeFileName("nul"), "nul file");
  assert.equal(sanitizeFileName("Connie"), "Connie", "only the exact reserved word, never a name that starts with it");
  // A control character in a scraped name is not a filename character.
  assert.equal(sanitizeFileName("Jo\u0000hn\u001f Sm\u007fith"), "John Smith");
  assert.equal(sanitizeFileName("   "), "", "nothing usable is empty, never a stray separator");
  assert.ok(sanitizeFileName("x".repeat(400)).length <= 100, "and it is bounded well under any filesystem limit");
  // It is a stem and only a stem: no path can ever come out of it.
  for (const value of ["../../etc/passwd", "C:\\Windows\\System32\\x", "a/b/c"]) {
    assert.ok(!/[/\\]/.test(sanitizeFileName(value)), `${value} must not yield a path separator`);
    assert.ok(!sanitizeFileName(value).startsWith("."), `${value} must not yield a relative path`);
  }

  // The extension is the real one or none at all — a `.pdf` on a `.docx` is a
  // lie written to the recruiter's disk (rule 6).
  assert.equal(resumeFileExtension("pdf", "", ""), "pdf");
  assert.equal(resumeFileExtension(".PDF", "", ""), "pdf");
  assert.equal(resumeFileExtension("application/pdf", "", ""), "pdf");
  assert.equal(resumeFileExtension("", "mahak-ayani.docx", ""), "docx");
  assert.equal(resumeFileExtension("", "", "https://media.licdn.com/dms/x.doc?e=1"), "doc");
  assert.equal(resumeFileExtension("", "", "https://media.licdn.com/dms/AQHb3kJ2"), "", "an opaque media id yields none");
  assert.equal(resumeFileName({ name: "John Smith" }), "John Smith", "and no extension is invented");
  assert.equal(resumeFileName({ name: "John Smith", filename: "cv.docx" }), "John Smith.docx");

  // The second DIFFERENT person of that name gets " (2)". The first is just the
  // name, and numbering starts at 2 because that is what a human would write.
  assert.equal(resumeFileName({ name: "John Smith", fileType: "pdf", index: 0 }), "John Smith.pdf");
  assert.equal(resumeFileName({ name: "John Smith", fileType: "pdf", index: 1 }), "John Smith (2).pdf");
  assert.equal(resumeFileName({ name: "John Smith", fileType: "pdf", index: 2 }), "John Smith (3).pdf");

  // A nameless applicant falls back rather than writing a file called ".pdf".
  assert.equal(resumeFileName({ name: "", filename: "AQHb3kJ2.pdf" }), "AQHb3kJ2.pdf");
  assert.equal(resumeFileName({ name: "", filename: "", fallback: "applicant_1a2b" }), "applicant_1a2b");
  assert.equal(resumeFileName({}), "resume", "and there is always a name");
});

test("the worker names the file after the person and reports the file it wrote", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const download = worker.slice(worker.indexOf("async function downloadResume"), worker.indexOf("/** Tell every LinkedIn tab"));

  // The policy is the core's, tested above. The worker owns `chrome.downloads`
  // and nothing else — it must not grow a second copy of the sanitizing.
  assert.match(download, /Applicants\.resumeFileName\(\{/, "the name must come from the tested rule");
  assert.match(download, /Applicants\.sanitizeFileName\(message\?\.applicantName\)/, "and so must the stem it is claimed under");
  assert.ok(!/replace\(\/\[\\\\\/:\*\?"<>\|\]/.test(download), "the old local sanitizer must be gone, not left alongside");

  // Same name, different people -> " (2)". Same person twice -> the same file.
  assert.match(worker, /async function claimResumeName\(stem: string, applicantKey: string\)/, "the suffix must be decided per applicant");
  const claim = worker.slice(worker.indexOf("async function claimResumeName"), worker.indexOf("async function downloadedFilePath"));
  assert.match(claim, /const existing = owners\.indexOf\(owner\);\s*\n\s*if \(existing >= 0\) return existing;/,
    "the same applicant must keep their own file rather than growing a suffix on every visit");
  assert.match(claim, /if \(!nameKey \|\| !owner\) return 0;/, "an unkeyed record cannot be told from the next one");

  // `resume_file` means the file on disk, so it is read back, not assumed:
  // `uniquify` renames, and an assumed path would name a file that is not there.
  assert.match(worker, /async function downloadedFilePath\(downloadId: number, requested: string\)/, "the real path must be read back");
  assert.match(download, /const actual = await downloadedFilePath\(downloadId, requested\)/, "and used as the reference");
  assert.match(download, /localReference: actual/, "which is what the resume_file column shows");

  // Clearing the applicants must clear the register, or the next John Smith
  // becomes "John Smith (2)" with no John Smith anywhere.
  const clear = worker.slice(worker.indexOf("APPLICANT_MESSAGES.CLEAR) {"), worker.indexOf("APPLICANT_MESSAGES.DIAGNOSTICS"));
  assert.match(clear, /chrome\.storage\.local\.remove\(RESUME_NAMES_KEY\)/, "the filename register must be cleared with the records");
});

test("the resume is downloaded, not previewed, whenever the page already has the address", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const step = source.slice(source.indexOf("async function collectResume"), source.indexOf("// ------------------------------------------------------------- the scan"));

  // Rule 9e: a link needs no click at all. The recruiter asked for the file, so
  // the document address is looked for BEFORE anything is opened, and the viewer
  // is only opened when the page has not rendered it.
  assert.match(step, /const rendered = linkedUrl \|\| findResumeDocumentUrl\(null\)/, "the page is asked before the control is clicked");
  assert.ok(
    step.indexOf("const rendered =") < step.indexOf("control.element.click()"),
    "nothing may be opened until the page has been asked"
  );
  assert.match(step, /if \(!url\) \{\s*\n\s*\/\/ The page did not render it/, "the viewer is the fallback, not the method");
  assert.match(step, /diagnostics\.resume\.foundWithoutOpening = Boolean\(rendered\)/, "and it is reported which path was taken");
  // Whichever path ran, a viewer that was opened is closed again — and the close
  // is VERIFIED. Discarding the result is how a preview could be left on screen
  // without the extension ever mentioning it, which is the whole complaint.
  assert.ok(!/if \(overlay\) await closeOpenedOverlay\(overlay\)/.test(step),
    "the close result must not be discarded");
  assert.equal((step.match(/await dismissResumeViewer\(overlay, accumulator, diagnostics\)/g) || []).length, 3,
    "every one of the three exits from this step closes the viewer");
  const dismiss = source.slice(source.indexOf("async function dismissResumeViewer"), source.indexOf("const MAX_RESUME_BYTES"));
  assert.match(dismiss, /the resume viewer would not close/, "and a viewer that refuses to go says so on the record");

  // The person's name reaches the worker; the path never leaves this file.
  assert.match(step, /applicantName,\s*\n\s*applicantKey/, "the applicant's name must be sent to the downloader");
  assert.match(step, /fileType,/, "and the type, so the saved copy keeps the right extension");
  assert.match(source, /await collectResume\(panel, accumulator, diagnostics, applicantKey, header\.name \|\| ""\)/,
    "the name the record carries is the name the file is saved under");
  assert.ok(!/RESUME_FOLDER|profile-vault-resumes/.test(step), "a content script must never build the download path");
});

test("the detail panel can never be a container that holds the applicant list", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const panel = source.slice(source.indexOf("function mountedApplicantPanel()"), source.indexOf("/**\n   * The applicant list column"));

  // The live defect: a wrapper around both columns satisfies "two sections", so
  // it won, and the first line of its text was the list's heading.
  assert.match(panel, /if \(rowLinksIn\(element\) > 1\) continue/, "a container holding the list must be refused");

  // The scoring resolver may answer NULL, and that is what makes "nothing is
  // mounted" expressible. Without it, everything asking WHO the panel shows had
  // to accept the loose fallback's answer — a container holding the list.
  assert.match(panel, /let best = null;[\s\S]*?return best;\s*\}\s*function applicantPanel\(\)/,
    "the strict resolver returns null when nothing qualifies");
  assert.match(panel, /function applicantPanel\(\) \{\s*const mounted = mountedApplicantPanel\(\);/,
    "and the loose one is built on it, so there is one scoring rule");
  assert.match(panel, /score < Applicants\.PANEL_MIN_SECTIONS/,
    "with the same section bar the arrival policy judges a mounted panel by");
  assert.ok(!/return best \|\| document\.querySelector\("main"\) \|\| document\.body;\s*\n\s*}\s*\n\s*\/\*\* A link/.test(source),
    "the fallback must not be document.body, which always contains the list");
  assert.match(panel, /rowLinksIn\(element\) <= 1/, "even the fallback must exclude the list");

  // One row link is fine — the panel legitimately links to the application it
  // is showing. Two or more is a list.
  assert.match(source, /function rowLinksIn\(element\)/, "the count must be a named, reusable rule");
});

test("the applicant's name is chosen by policy, corroborated by the platform's own prose", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const finder = source.slice(source.indexOf("function findApplicantName"), source.indexOf("function readApplicantHeader"));

  // Every claim to the name, in order of how far the markup can be trusted.
  for (const [signal, why] of [
    ["list-row", "the applicant's own row in the list"],
    ["profile-link", "the link to their profile"],
    ["portrait-alt", "the portrait's alt text"],
    ["panel-heading", "a heading that names no section"],
    ["first-line", "and the first line, last of all"]
  ]) {
    assert.ok(finder.includes(signal), `${why} must be a candidate`);
  }
  assert.match(finder, /Applicants\.nameFromExplanations\(explanations\)/, "the explanations arbitrate");
  assert.match(finder, /Applicants\.chooseApplicantName\(candidates,/, "and the tested policy decides");

  // The row is matched on the applicationId in the address bar, not on which
  // row happens to look highlighted.
  const selected = source.slice(source.indexOf("function selectedApplicantRow"), source.indexOf("function findApplicantName"));
  assert.match(selected, /row\.href\.includes\(applicationId\)/, "the id in the address bar identifies the row");

  // Qualifications are read before the header so the arbiter exists on the very
  // first snapshot.
  const snapshot = source.slice(source.indexOf("function snapshotPanel"), source.indexOf("async function scanApplicantPanel"));
  assert.ok(
    snapshot.indexOf("readQualifications") < snapshot.indexOf("readApplicantHeader"),
    "the explanations must be read before the name that is checked against them"
  );
  assert.match(snapshot, /readApplicantHeader\(panel, sections, accumulator, diagnostics\)/,
    "the chosen name must be reported in diagnostics");
});

test("the header starts at the open applicant's own name, not at the top of the panel", async () => {
  // THE LIVE DEFECT: every applicant was saved with the SAME location. Refusing
  // "Filter and sort" (3.7.24) moved the symptom rather than ending it, which is
  // what identified the real cause: `applicantPanel()` resolving wide enough to
  // include the applicant LIST column — the same failure that once saved six
  // people as "Applicants" — and the header then taking the panel's first twelve
  // lines, which on that container are the list's.
  //
  // First, the defect in the pure core, where it can be shown. These are the
  // live panel's lines in order.
  const wide = [
    "Applicants",
    "All",
    "Filter and sort",
    "Here are all applicants to your job. Edit qualifications",
    "Adnan Ahmed · 2nd",
    '"Innovator | Change Maker | Entrepreneurial Spirit in Action"',
    "New Delhi, Delhi, India",
    "Applied 2w ago",
    "PRAVESH KOTIYAL · 1st",
    "Human Resource",
    "Noida, Uttar Pradesh, India",
    "Applied 13mo ago • Contacted 10mo ago"
  ];

  // Read from the top — today's behaviour — and PRAVESH is saved with Adnan's
  // location and Adnan's headline. Adnan is the first row, so every applicant
  // got the same two values.
  const fromTop = Applicants.parseApplicantHeader({ text: wide.join("\n") });
  assert.equal(fromTop.location, "New Delhi, Delhi, India", "the first ROW's location is what was being saved");
  assert.notEqual(fromTop.location, "Noida, Uttar Pradesh, India");

  // Read from the applicant's own name, and every field is theirs. Nothing in
  // the parser changed — the starting point did.
  const anchored = Applicants.parseApplicantHeader({ text: wide.slice(8).join("\n") });
  assert.equal(anchored.location, "Noida, Uttar Pradesh, India", "anchoring on the name is what fixes it");
  assert.equal(anchored.headline, "Human Resource");
  assert.equal(anchored.appliedAt, "13mo ago");

  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const header = source.slice(source.indexOf("function readApplicantHeader"), source.indexOf("function readQualifications"));

  // The ordering IS the fix: the name is resolved by policy first, and the
  // header is then cut from where that name is rendered.
  assert.ok(
    header.indexOf("findApplicantName(panel, accumulator)") < header.indexOf("Applicants.parseApplicantHeader"),
    "the name must be chosen before the lines the rest of the header is parsed from"
  );
  assert.match(header, /Applicants\.cleanApplicantName\(all\[index\]\) === wanted/,
    "the header must start where the chosen name appears");
  assert.match(header, /all\.slice\(start\)/, "and the lines must be taken from there, not from 0");

  // The last occurrence, not the first: the list column precedes the detail
  // column, and a row only matches when it is this applicant's own row, so the
  // later one is the fuller rendering of the same person and never a stranger.
  assert.match(header, /=== wanted\) start = index;\r?\n/,
    "the loop records the match and keeps going — the last one wins, not the first");
  assert.match(header, /let start = 0;/, "an unfound name falls back to the top of the panel, as today");

  // The same exposure on the profile link, which is worse to get wrong: it is
  // hashed into `applicantId`, so one link off the wrong column turns two
  // applicants into one record. The link that names the resolved applicant wins.
  assert.match(header, /profileLinks\.find\(/, "the applicant's own link must be preferred");
  assert.match(header, /\) === wanted\s*\n?\s*\)/, "and 'own' means it names the applicant we resolved");
  assert.match(header, /named \|\| profileLinks\[0\] \|\| null/,
    "falling back to today's answer rather than to no link at all");
  // Free: no page-wide query, which is what `state.jobHeader` was introduced to
  // remove from this per-snapshot path, and no layout flush per anchor.
  assert.ok(!/applicantList\(\)/.test(header), "the header must not scan the document once per snapshot");
  assert.ok(!/anchor\.innerText/.test(header), "textContent — a name getter that forces layout per anchor is the trap");

  // And the shape that caused it is gone.
  assert.ok(!/for \(const line of toLines\(panel\.innerText \|\| ""\)\)/.test(header),
    "the header must never again be read from the top of the panel unconditionally");
});

test("the next applicant is only scanned once the panel is showing them", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const select = source.slice(source.indexOf("async function selectApplicantRow"), source.indexOf("* Scroll the applicant list until it stops producing new rows"));

  // The live defect: waiting for the address to change and the DOM to go quiet
  // meant the scan started on the previous applicant's panel or on an empty one.
  assert.ok(!/waitFor\(\(\) => location\.href !== before/.test(select), "a route change is not a rendered panel");
  assert.match(select, /waitForDomQuiet\(PANEL_SETTLE_QUIET_MS, PANEL_SETTLE_TIMEOUT_MS\)/,
    "and it must then be given time to mount");
  // Short, deliberately. It used to be (450, 4000), immediately followed by the
  // scan's own waitForDomQuiet(400, 2600) — six and a half seconds of a page
  // visibly doing nothing per applicant, which is the reported "it looks like
  // the extension is frozen". This settle only has to notice a re-mount during
  // itself; the scan keeps the generous one, because the read depends on it.
  assert.match(source, /const PANEL_SETTLE_TIMEOUT_MS = (\d+);/, "the settle is a named budget");
  const settleMs = Number(/const PANEL_SETTLE_TIMEOUT_MS = (\d+);/.exec(source)[1]);
  assert.ok(settleMs <= 1500, `the post-arrival settle must stay short (found ${settleMs}ms)`);

  // And the defect after it, which cost every applicant their name: a TEXT
  // fingerprint, satisfied by the teardown alone.
  assert.match(source, /function panelIdentity\(panel = arrivalPanel\(\)\)/,
    "the panel's identity must be asked of a panel that can be identified");
  const identity = source.slice(source.indexOf("function panelIdentity(panel"), source.indexOf("function arrivalPanel()"));
  assert.ok(!/innerText/.test(identity), "identity must never be built from the panel's text");
  assert.match(identity, /application \? `id:\$\{application\}` : ""/, "the application id is the identity");
  assert.match(identity, /profile \? `in:\$\{profile\}` : ""/, "with the member's own slug beside it");

  // Arrival is "this applicant, mounted", decided by the tested pure policy.
  assert.match(select, /const expected = Applicants\.parseHiringContext\(row\.href\)\.applicationId \|\| ""/,
    "the row states which applicant is expected, from its own href");
  assert.match(select, /describeApplicantArrival\(expected, before\)/, "and arrival is judged against it");
  // "Nothing identifiable is on screen" must stay expressible, so the resolver
  // may answer null — but it must be one this markup can actually satisfy.
  // Requiring the STRICT resolver here is what made arrival unanswerable and
  // stopped the run opening anybody after the first: it needs two hydrated
  // section headings inside one container, and this surface routinely puts them
  // outside the panel, which is why `buildSectionMap` widens page-wide at all.
  assert.match(source, /const panel = arrivalPanel\(\);[\s\S]{0,700}?connected: Boolean\(panel\)/,
    "arrival is asked of a panel that can be identified, and null is still an answer");

  // Three steps, in order: teardown, then arrival, then settle-and-confirm.
  assert.ok(
    select.indexOf("applicant-panel-teardown") < select.indexOf("const arrival = await waitFor"),
    "teardown is waited for first, so arrival cannot be satisfied by the panel already on screen"
  );
  assert.ok(
    select.indexOf("await waitForDomQuiet(PANEL_SETTLE_QUIET_MS") < select.indexOf("const settled = describeApplicantArrival"),
    "and the verdict is re-read AFTER the settle, because a re-mount during it is the whole point"
  );
  // And the verdict the caller acts on. Not "did the wait succeed" — that was
  // the regression: `torn-down` and `mounting` mean "I could not tell", and
  // treating them as "not here" skipped every applicant on markup whose section
  // headings the strict panel resolver cannot see. Only a panel positively
  // showing somebody else refuses the row; the record is guarded separately.
  assert.match(select, /const refused = settled\.state === Applicants\.PANEL_ARRIVAL\.OTHER/,
    "a third party refuses the row");
  assert.match(select, /\|\| settled\.state === Applicants\.PANEL_ARRIVAL\.PREVIOUS;/,
    "and so does the applicant that was already showing");
  assert.match(select, /return !refused;/, "and nothing else does");

  // A row that came up as somebody else is never SCANNED — scanning anyway would
  // save that applicant a second time under this row's identity. There is one
  // per-row path since 3.7.13, so this is `collectVisibleApplicant`: a row that
  // would not open returns before the panel is ever read.
  const open = source.slice(source.indexOf("async function collectVisibleApplicant"), source.indexOf("async function extractAllApplicants"));
  assert.match(open, /if \(!\(await selectApplicantRow\(row\)\)\) return \{ opened: false, record: null \};/,
    "the result must be checked, and a failure must return");
  assert.ok(
    open.indexOf("selectApplicantRow") < open.indexOf("await extractApplicant("),
    "before the panel is read, or the applicant still showing is scanned under this row"
  );
  // And what the walk then saves for that row is the row's OWN name — never a
  // reading of whoever the panel was left on.
  const run = source.slice(source.indexOf("async function extractAllApplicants"));
  assert.match(run, /if \(!opened && !state\.run\.lastError\) \{/, "a row that would not open is recorded as such");
  assert.match(run, /record: fromRow/, "and only its own name is saved for it");
});

test("a run that stopped short on the job it is still showing continues itself", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // THE GAP. Every restart path on this surface answers "did we ARRIVE
  // somewhere" — a route change, a tab return, a reload. None of them fires
  // when a run simply ends early while the recruiter is sitting on the page
  // watching it, which is exactly what an inconclusive stop is: the growth
  // budget spent on a list that was being re-mounted leaves RUN_STATE.STOPPED,
  // the worker is correctly told INTERRUPTED so the job stays restartable, and
  // then nothing restarts it because no address changed and no tab was switched.
  const runner = source.slice(source.indexOf("async function runEveryApplicant"), source.indexOf("function applicantsPageKey"));
  assert.match(runner, /await report\(lifecycle\);[\s\S]{0,300}?continueInterruptedRun\(result\);/,
    "the lifecycle is reported BEFORE the continuation, or claimAutoRun refuses a still-running lease");

  // NOT on the throw path. A throw out of the walk is a challenge, a checkpoint
  // or a page that stayed hidden past the wait, and rule 13 says those pause and
  // wait for a person — retrying them in a loop turns a rate limit into a worse
  // one.
  // The runner's own body, which ends where the continuation is defined.
  const body = runner.slice(0, runner.indexOf("const CONTINUE_DELAY_MS"));
  const thrown = body.slice(body.indexOf("} catch (error) {"));
  assert.ok(thrown.length > 50, "the throw path must be found, not an empty slice");
  assert.ok(!/continueInterruptedRun/.test(thrown), "a challenge or a checkpoint must never be retried in a loop");

  const cont = source.slice(source.indexOf("function continueInterruptedRun"), source.indexOf("// -------------------------------------------------- coming back to a job"));
  assert.ok(cont.length > 200, "the continuation must be its own named step");

  // Every bound, and this is the one place on the surface where a missing bound
  // is a run that walks a recruiter's job forever.
  assert.match(cont, /if \(state\.autoRun\.disabled \|\| state\.aborted\) return;/, "Stop is checked first (rule 13a)");
  assert.match(cont, /if \(result\?\.run\?\.state === Applicants\.RUN_STATE\.COMPLETED\) return;/,
    "the end of the list ends it");
  assert.match(cont, /if \(result\?\.run\?\.stopRequested\) return;/, "and so does a stop already recorded on the run");
  assert.match(cont, /const key = applicantsPageKey\(location\.href\);\s*if \(!key\) return;/,
    "leaving the surface blanks the key");
  assert.match(cont, /state\.autoRun\.fruitlessReturns >= MAX_FRUITLESS_RETURNS/,
    "an attempt that collected nobody new does not earn another");

  // It goes through pumpAutoRun, so every guard that path already has applies
  // unchanged — the worker is still asked whether the job is armed.
  assert.match(cont, /setTimeout\(\(\) => pumpAutoRun\(\), CONTINUE_DELAY_MS\)/,
    "the continuation is deferred and routed through the existing arrival path");
  assert.ok(!/runEveryApplicant\(/.test(cont), "it must never call the runner directly, or every guard is bypassed");

  // Deferred because it runs INSIDE the promise the caller assigned to
  // `state.running`, and `startAutoRun` refuses to start on top of a run in
  // flight.
  assert.match(source, /if \(state\.running \|\| state\.extracting\) return abandonAutoRun\("a run is already in flight"\)/,
    "which is the guard the delay exists for");
});

test("the list pass opens every applicant across every page and takes what the panel renders", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const ui = await readFile(resolve(root, "src/react/applicants-dashboard.tsx"), "utf8");

  // The record: the name and the two ids, and deliberately nothing else. The row
  // also renders a headline and a location, and taking them would mean deciding
  // that line two is the headline and line three is the location — positional
  // guessing on generated markup, which rule 11 refuses.
  const record = Applicants.buildApplicantListRecord({
    name: "Neeshu Kalkhanday · 2nd",
    href: "https://www.linkedin.com/hiring/applicants/?applicationId=35141729733&jobId=4277798308",
    job: { id: "4277798308", title: "Human Resources Executive" },
    sourceUrl: APPLICANTS_URL,
    buildId: "test"
  });
  assert.equal(record.applicant.name, "Neeshu Kalkhanday", "the degree badge is stripped as it is everywhere else");
  assert.equal(record.applicationId, "35141729733", "keyed on the application the row leads to");
  assert.equal(record.job.id, "4277798308");
  assert.equal(record.job.title, "Human Resources Executive", "the job header read once is carried");
  assert.equal(record.applicant.profileUrl, null, "a row shows no profile URL, so none is invented");
  assert.equal(record.applicant.currentRole, null);
  assert.equal(record.applicant.resume.available, false);
  assert.deepEqual(record.applicant.experience, []);
  // Provenance, so a name-only record is distinguishable from a full extraction
  // that found nothing — the two call for opposite responses.
  assert.equal(record.extraction.rawData.list_row, "Neeshu Kalkhanday");

  // THE LIVE DEFECT: the extension saved an applicant called "Edit
  // qualifications". The list renders that link in its own header — "Here are
  // all applicants to your job. Edit qualifications" — and its href carries the
  // same applicationId the page is on, so it is structurally indistinguishable
  // from the open applicant's row. Nothing about the LINK can catch it; the
  // text can, and `isApplicantNameCandidate` already refused this exact phrase
  // for the panel path a release earlier. The list pass simply never asked.
  const chrome_ = Applicants.buildApplicantListRecord({
    name: "Edit qualifications",
    href: "https://www.linkedin.com/hiring/applicants/?applicationId=35141729733&jobId=4277798308",
    job: { id: "4277798308" },
    sourceUrl: APPLICANTS_URL,
    buildId: "test"
  });
  assert.equal(chrome_, null, "a control phrase is a thing to press, not a person");
  // Every other label the policy already refuses is refused here too, because
  // this asks the ONE policy rather than growing a second list of its own.
  for (const label of ["Applicants", "Filter and sort", "View full profile", "Show more", "Resume"]) {
    assert.equal(
      Applicants.buildApplicantListRecord({ name: label, href: "?applicationId=1234567890", job: { id: "1" } }),
      null,
      `"${label}" must never become an applicant`
    );
  }
  // And a row that rendered no name at all is no record, rather than a nameless
  // one: the name is the column the whole export is read by.
  assert.equal(Applicants.buildApplicantListRecord({ name: "   ", href: "?applicationId=1234567890" }), null);
  // The trade-off TASK-0082 made when it wrote this policy, restated here
  // because the list pass now depends on it: a **bare** `Edit` is accepted,
  // since it is a real Hungarian given name and refusing it outright would
  // trade a wrong name for a missing one on a real person. `Edit <anything>` is
  // refused, which does cost a surname — the verb list is deliberately free of
  // words that are themselves given names (Mark, Grant, Will, Rose, Art) to
  // keep that cost as small as it can be.
  assert.ok(Applicants.buildApplicantListRecord({ name: "Edit", href: "?applicationId=1234567890" }),
    "a bare given name that happens to be a verb elsewhere is still a name");
  assert.ok(Applicants.buildApplicantListRecord({ name: "Mark Sullivan", href: "?applicationId=1234567890" }),
    "and a name whose first word is a given name is never treated as a control");

  // A name-only record is NOT collected, deliberately: `isCollectedApplicant`
  // needs one substantive field, so a later full run still visits this person
  // rather than walking past them forever.
  assert.equal(Applicants.isCollectedApplicant(record), false,
    "a listed applicant is not a collected one — the full pass must still open them");

  // And a blank field can never erase a full one, which is what makes running
  // the list pass first safe. (Locked in its own right by "a thinner later read
  // never erases a fuller stored one"; asserted here because this feature is
  // what would otherwise trigger it on every row.)
  const enriched = Applicants.mergeApplicantRecord(
    Applicants.normalizeApplicantRecord({
      ...record,
      applicant: { ...record.applicant, currentRole: "HR Executive" }
    }),
    record
  );
  assert.equal(enriched.applicant.currentRole, "HR Executive", "a later blank must not wipe what is stored");

  // The walk. Since 3.7.13 there is no second per-row path to be a branch of:
  // Collect Every Applicant was removed and this is what the one loop does.
  const run = source.slice(source.indexOf("async function extractAllApplicants"), source.indexOf("async function runEveryApplicant"));
  const pass = run.slice(run.indexOf("const rowId = Applicants.parseHiringContext(row.href)"));
  assert.ok(pass.length > 200, "the per-row work must be found, not an empty slice");
  assert.match(pass, /assertRunnable\(\)/, "a hidden tab and a Stop are still honoured inside the loop");

  // Each applicant is opened, the panel walked to the bottom, and what it
  // RENDERED is taken: name, current role, current company, total experience,
  // education. Not a second reading rule — `extractApplicant` is the one the
  // full collection uses, with the button-gated steps switched off.
  assert.match(pass, /await collectVisibleApplicant\(row, rowId\)/, "each applicant is opened and read");
  const reveal = source.slice(source.indexOf("const VISIBLE_ONLY_OPTIONS"), source.indexOf("async function extractAllApplicants"));
  // Requested outright: "I want the extension to be able to get contact info
  // from the contact info button given in the profile AND I WANT THE RESUME TO
  // BE DOWNLOADED IN THE DISK WITH THE NAME OF THE PROFILE OWNER." Both steps
  // were already built and both were switched OFF here, which is the whole of
  // why neither happened. Only the section expander stays off.
  assert.match(reveal, /const VISIBLE_ONLY_OPTIONS = Object\.freeze\(\{ expand: false \}\)/,
    "the contact disclosure and the resume are on; only the section expander is not");
  assert.match(reveal, /await extractApplicant\(\{ \.\.\.VISIBLE_ONLY_OPTIONS, expectApplicationId: rowId \}\)/,
    "and the reading rule is the shared one, told which applicant it is for");
  assert.match(reveal, /await selectApplicantRow\(row\)/, "through the one gated row control (rule 9g)");
  assert.match(reveal, /if \(!\(await panelAlreadyShowing\(rowId\)\)\) \{/,
    "and not re-clicked when the PANEL says it already shows them — never when only the address bar does");
  assert.match(source, /const LIST_PROFILE_PACE_MS = \d+/, "and a pass paces itself between applicants");

  // `expand: false` is also the flag `extractApplicant` turns into a null
  // expansion budget, so the second expander pass at the bottom of the walk is
  // skipped too — one flag, both passes.
  const extract = source.slice(source.indexOf("async function extractApplicant"), source.indexOf("// ------------------------------------------------------- every applicant"));
  assert.match(extract, /options\.expand === false \? null : expansion/,
    "expand:false must reach the scan's expansion budget, not only the first pass");
  assert.match(extract, /if \(options\.contact !== false\)/, "the contact disclosure is opt-out");
  assert.match(extract, /if \(options\.resume !== false\)/, "and so is the resume viewer");

  // So a list pass reaches both steps: neither flag is set, and both are opt-out.
  assert.ok(!/contact: false/.test(reveal), "a list pass must reach the contact disclosure");
  assert.ok(!/resume: false/.test(reveal), "and must reach the resume");
  // And the file it saves is named after the person, not after LinkedIn's media
  // id — the record's own resolved name, which is settled before this runs.
  assert.match(extract, /await collectResume\(panel, accumulator, diagnostics, applicantKey, header\.name \|\| ""\)/,
    "the resume is saved under the applicant's own name");
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /Applicants\.resumeFileName\(\{\s*\n?\s*name: message\?\.applicantName/,
    "and the worker builds the filename from it");

  // The derived columns come from the SAME rules a full collection uses, so
  // there is one definition of "current role" on this surface.
  const derived = Applicants.normalizeApplicantRecord({
    applicant: {
      name: "Komal Sharma",
      experience: [
        { title: "Human Resources Manager", company: "GTECH LLC", dateRange: "2026-Present", current: true },
        { title: "Human Resources Executive", company: "FCS Software Solutions Ltd", dateRange: "2025-2026" }
      ],
      education: [{ institution: "Dr. A.P.J. Abdul Kalam Technical University" }]
    }
  });
  assert.equal(derived.applicant.currentRole, "Human Resources Manager", "current role is the Present card");
  assert.equal(derived.applicant.currentCompany, "GTECH LLC");
  assert.ok(derived.applicant.totalExperience, "and total experience is derived from the cards");
  assert.equal(derived.applicant.education[0].institution, "Dr. A.P.J. Abdul Kalam Technical University");
  // Every one of those is a column of the table this pass fills.
  const Csv = await import("../src/applicant-csv.js");
  for (const column of ["applicant_name", "current_role", "current_company", "total_experience", "education"]) {
    assert.ok(Csv.APPLICANT_TABLE_COLUMNS.includes(column), `${column} must be a table column`);
  }

  // The row's name is the FLOOR, and only when it is needed: a row that never
  // opened, or a panel that resolved no name, would otherwise leave the column
  // the whole export is read by empty.
  assert.match(pass, /const named = cleanText\(record\?\.applicant\?\.name\);/, "the panel's name is preferred");
  assert.match(pass, /if \(!named\) await chrome\.runtime\.sendMessage\(\{ type: "PV_APPLICANT_SAVE", record: fromRow \}\)/,
    "and the row's name only fills a gap");
  assert.match(pass, /opened = false;/, "a profile that would not open still reaches the floor save");
  // And a hidden page is a pause with the SAME bound the full run applies, or a
  // panel that reliably hides the tab re-runs one applicant forever.
  assert.match(pass, /if \(error\?\.hidden\) \{[\s\S]{0,900}?hiddenRetries > MAX_HIDDEN_RETRIES/,
    "a hidden page pauses, bounded");
  assert.match(pass, /processed\.add\(key\)/, "and the row is retired by identity, like every other outcome");
  // A row the policy refused is skipped, never opened and never saved.
  assert.match(pass, /if \(!fromRow\) \{[\s\S]{0,300}?state\.run\.skipped \+= 1;[\s\S]{0,300}?continue;/,
    "a link that is not a person is skipped rather than saved");
  assert.ok(
    pass.indexOf("if (!fromRow) {") < pass.indexOf("await collectVisibleApplicant"),
    "and refused before the row is even opened, not after"
  );

  // The profile extraction is the SHARED one: the same `extractApplicant` a
  // single applicant is collected through, so there is one reading rule here.
  assert.match(source, /async function extractApplicant\(options = \{\}\)/, "the extraction must still exist");
  assert.equal((source.match(/async function extractApplicant/g) || []).length, 1,
    "and there must be exactly one of it");

  // The job header is read ONCE and reused. It sits above both columns and does
  // not change as the list is walked, so reading it per row would be hundreds of
  // forced layouts for one unchanging answer.
  //
  // 3.7.23 made "once" mean "once it ANSWERED": the bar hydrates on its own
  // schedule, and a run that started before it rendered used to title the whole
  // job `null`. The retry is gated on there being no title, so a run whose first
  // read succeeded still reads exactly once — and `readJob` now works off a
  // cached element, so even the retry is not a page-wide query.
  assert.match(run, /let listJob = attempt\("read job", jobAccumulator/, "the job is read once per run");
  assert.match(run, /if \(!listJob\?\.title\) \{/, "and re-read only while it has no answer to reuse");
  assert.equal((run.match(/readJob\(jobAccumulator\)/g) || []).length, 2,
    "the initial read and that one guarded retry — never a read per row");
  // The only read inside the loop is the guarded one: every occurrence is
  // preceded either by the `let` that opens the run or by the no-title gate.
  for (const before of run.split(/readJob\(jobAccumulator\)/).slice(0, -1)) {
    assert.match(before.slice(-160), /let listJob = attempt\("read job", jobAccumulator, \(\) => $|if \(!listJob\?\.title\) \{[\s\S]*$/,
      "a read of the job header must be the opening one or the no-title retry");
  }

  // Its own button, exactly as the connections surface has always had "Find All
  // Connections" beside "Start Profile Extraction".
  assert.match(ui, /Collect Applicant List/, "the whole-job walk needs its own control");
  assert.match(ui, /collectList = \(\) => this\.command\([\s\S]{0,600}?\{ options: \{ listOnly: true, recollect: this\.state\.recollect \} \}/,
    "which asks for the walk, and carries the run's own re-collect setting");
  // `listOnly` travels with the armed options rather than being dropped, so a
  // run armed by the previous build resumes instead of falling into the branch
  // 3.7.13 removed.
  assert.match(ui, /APPLICANT_MESSAGES\.COLLECT_ALL,\s*\n?\s*this\.state\.recollect/,
    "and rides the same command, so the auto-run remembers it");
});

test("a record may only be built from the applicant that was asked for", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const ARRIVAL = Applicants.PANEL_ARRIVAL;

  // THE DEFECT, from the recruiter's own table: three different people in the
  // list (Komal Sharma, Neha Singh, Mahak Ayani) all stored as "Komal Sharma",
  // the one open when the run started.
  //
  // The chain, and the last link is the surprising one. The row click routes the
  // address bar at once, so each record was keyed to the RIGHT application —
  // that is why there were three rows and not one. But the panel had not
  // re-rendered, and the wait was "the text differs from before the click",
  // which the TEARDOWN alone satisfies. So the scan read the stale panel;
  // `chooseApplicantName` then arbitrated with `nameFromExplanations` —
  // LinkedIn's qualification prose — which on that panel says "Komal Sharma
  // has…" repeatedly. The wrong name therefore won as the CORROBORATED one, and
  // `addName` latches a corroborated name against every later read.
  const stale = Applicants.chooseApplicantName(
    [
      { value: "Neha Singh", source: "list-row" },
      { value: "Komal Sharma", source: "portrait-alt" }
    ],
    Applicants.nameFromExplanations([
      "Komal Sharma holds a Bachelor of Business Administration.",
      "Komal Sharma has knowledge of employment laws."
    ])
  );
  assert.equal(stale.name, "Komal Sharma", "the policy trusts the prose — correctly, on the right panel");
  assert.equal(stale.corroborated, true, "and marks it corroborated, which then latches it");
  const latched = Applicants.createApplicantAccumulator();
  latched.addName(stale.name, true);
  latched.addName("Neha Singh", false);
  assert.equal(latched.snapshot().header.name, "Komal Sharma",
    "so no later read can correct it — the panel has to be right in the first place");

  // Hence the fix is upstream of the name policy, and it is identity.
  assert.equal(Applicants.describePanelArrival({
    expected: "111", applicationId: "222", identity: "id:222", previousIdentity: "id:222",
    sections: 6, connected: true
  }).state, ARRIVAL.PREVIOUS, "a fully hydrated panel is still the WRONG panel if it is the previous applicant");
  assert.equal(Applicants.describePanelArrival({
    expected: "111", applicationId: "999", identity: "id:999", previousIdentity: "id:222",
    sections: 6, connected: true
  }).state, ARRIVAL.OTHER, "and a third party is nameable as such");
  assert.equal(Applicants.describePanelArrival({
    expected: "111", applicationId: "111", identity: "id:111", previousIdentity: "id:222",
    sections: 6, connected: true
  }).arrived, true);
  // Torn down and half-mounted are WAITS, not arrivals — the two states the old
  // text fingerprint reported as "a new applicant is here".
  assert.equal(Applicants.describePanelArrival({ expected: "111", connected: false }).state, ARRIVAL.TORN_DOWN);
  assert.equal(Applicants.describePanelArrival({
    expected: "111", applicationId: "111", sections: 1, connected: true
  }).state, ARRIVAL.MOUNTING);

  // Waiting is a race that can be lost, so the record is refused as well.
  assert.match(source, /function wrongApplicantError\(reason\)/, "a wrong panel is its own kind of error");
  assert.match(source, /function assertExpectedApplicant\(expected\)/, "and the check is one named rule");
  const guard = source.slice(source.indexOf("function assertExpectedApplicant"), source.indexOf("* Collect the applicant currently open"));
  assert.match(guard, /if \(!cleanText\(expected\)\) return;/, "a caller that named nobody asserts nothing");
  assert.match(guard, /if \(seen\.state !== Applicants\.PANEL_ARRIVAL\.OTHER\) return;/,
    "only a DIFFERENT applicant throws — torn-down and mounting are waits");

  // Checked at every point where the panel could have changed underneath it,
  // and the last one is immediately before the record is built.
  const extract = source.slice(source.indexOf("async function extractApplicant"), source.indexOf("// ------------------------------------------------------- every applicant"));
  assert.ok((extract.match(/assertExpectedApplicant\(expected\)/g) || []).length >= 3,
    "before the scan, after it, and before the record is built");
  assert.match(extract, /assertExpectedApplicant\(expected\);\s*const record = Applicants\.buildApplicantRecord\(\{/,
    "the last word is immediately before the record exists");
  // And the record is keyed to the applicant that was ASKED for, not to a read
  // of location.href taken when the scan started.
  assert.match(extract, /context: expected \? \{ \.\.\.context, applicationId: expected \} : context/,
    "the record carries the expected application id");

  // THE REGRESSION THAT FOLLOWED, and it is the other half of this rule: "it
  // scrolls one profile, then stops at the second and does not even scroll it."
  //
  // Arrival was asked of `mountedApplicantPanel()` alone, which needs one
  // container holding PANEL_MIN_SECTIONS *hydrated* section headings — and this
  // surface routinely does not put them there, which is the whole reason
  // `buildSectionMap()` widens page-wide. The strict resolver then answers null,
  // every poll reads `torn-down`, arrival never happens, and `Boolean(arrival)
  // && settled.arrived` skipped the applicant after the full timeout: unopened,
  // unscrolled, saved as a bare name. The first applicant survived only because
  // they were already on screen and so were never clicked.
  const select = source.slice(source.indexOf("async function selectApplicantRow"), source.indexOf("const LIST_QUIET_PASSES"));
  // Comments stripped for the two refusals: this function explains the defect in
  // the very words the check greps for, so the prose would read as the code.
  const selectCode = withoutComments(select);
  assert.match(select, /const heldPanel = arrivalPanel\(\);/,
    "the wait must start from a panel this markup can actually resolve");
  assert.ok(!/mountedApplicantPanel\(\)/.test(selectCode),
    "and never from the strict resolver alone, which answers null on the live markup");
  assert.ok(!/Boolean\(arrival\) && settled\.arrived/.test(selectCode),
    "an unconfirmed arrival must never be what skips a person");
  assert.match(select, /const refused = settled\.state === Applicants\.PANEL_ARRIVAL\.OTHER\s*\n?\s*\|\| settled\.state === Applicants\.PANEL_ARRIVAL\.PREVIOUS;/,
    "only a panel positively showing SOMEBODY ELSE refuses the row");
  assert.match(select, /return !refused;/, "everything else is read, and the record guard decides");
  // The panel's own id must not fall back to the address bar, which routes ahead
  // of the render — that fallback is what made the id test vacuous and left the
  // section count as the only thing deciding arrival.
  const ownId = source.slice(source.indexOf("function panelOwnApplicationId"), source.indexOf("function panelMemberUrl"));
  assert.ok(!/location\.href/.test(ownId), "the panel's own id is the panel's, never the address bar's");
  assert.match(ownId, /return "";/, "and it says so rather than guessing");
  // `arrivalPanel()` accepts the loose panel when it carries an identifier, and
  // still refuses anything holding the list.
  const arrivalPanel = source.slice(source.indexOf("function arrivalPanel()"), source.indexOf("/** How many distinct applicant sections"));
  assert.match(arrivalPanel, /rowLinksIn\(loose\) > 1/, "the list must never look like an arrived applicant");
  assert.match(arrivalPanel, /panelOwnApplicationId\(loose\) \|\| panelMemberUrl\(loose\)/,
    "a loose panel qualifies only when it can be identified");

  // Bounded: refusing forever would let one unresolvable row hold the job.
  const run = source.slice(source.indexOf("const processed = new Set();"), source.indexOf("if (state.run.state === Applicants.RUN_STATE.RUNNING)"));
  assert.match(run, /const MAX_WRONG_APPLICANT_RETRIES = 2;/, "the retry is bounded");
  // One per-row path since 3.7.13, so one handler — it used to be two, one per
  // branch, and they had to agree.
  assert.equal((run.match(/if \(error\?\.wrongApplicant\)/g) || []).length, 1,
    "and the one per-row path handles it");
  assert.match(run, /state\.run\.failed \+= 1;[\s\S]{0,300}?rather than save the wrong name/,
    "exhausting the retries is a failure, never a save");
});

test("the resume viewer is opened, scrolled and read rather than only linked", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const step = source.slice(source.indexOf("async function collectResume"), source.indexOf("// ------------------------------------------------------------- the scan"));

  // The viewer is the FALLBACK, not the method (3.7.7) — it is opened only when
  // the page has not rendered the address — but when it is opened it is read
  // properly, because the file name only exists inside it.
  assert.match(step, /control\.element\.click\(\)/, "the viewer must be openable");
  assert.match(step, /await scrollResumeViewer\(overlay\)/, "a PDF viewer renders its pages lazily");
  assert.match(step, /readResumeViewerDetails\(overlay\)/, "and its own details must be read");
  assert.match(step, /details\.filename \|\| fileNameFrom\(url\)/, "the viewer's name beats one derived from the URL");
  assert.match(step, /dismissResumeViewer\(overlay, accumulator, diagnostics\)/, "and it must be closed again on every path");
  // A viewer that mounted only once the document arrived still has to be closed.
  assert.match(step, /if \(!overlay\) overlay = findResumeViewer\(\);/, "the viewer is re-resolved before the close");

  // Still nothing guessed: a viewer that shows no name and no document URL
  // records what it did show and says the file was not saved.
  assert.match(step, /RESUME_STATUS\.LINK_ONLY/, "no document URL is a state, not a guess");
  assert.match(step, /RESUME_STATUS\.UNAVAILABLE/, "no control at all means unavailable");

  const scroller = source.slice(source.indexOf("async function scrollResumeViewer"));
  assert.match(scroller.slice(0, scroller.indexOf("\n  }")), /finally \{[\s\S]*?scrollPanelTo\(startY, target\)/,
    "the viewer must be handed back where it was, on the failure path too");

  // `pages` is part of the stored resume, and null when the viewer said nothing.
  const record = Applicants.normalizeApplicantRecord({
    applicant: { name: "Mahak Ayani", resume: { available: true, filename: "cv.pdf", pages: 3 } }
  });
  assert.equal(record.applicant.resume.pages, 3);
  assert.equal(
    Applicants.normalizeApplicantRecord({ applicant: { name: "X", resume: { available: true } } }).applicant.resume.pages,
    null,
    "a viewer that showed no page count leaves it null"
  );
});

test("a LinkedIn page is never stored or downloaded as a resume", () => {
  // The live defect, verbatim: the resume control's href on the hiring surface
  // is a route, so "Open resume" reopened the applicants page — and the worker
  // fetched that HTML page and saved it as somebody's CV while reporting
  // `downloaded`.
  for (const route of [
    "https://www.linkedin.com/hiring/applicants/?applicationId=25550787924&jobId=4277798308",
    "https://www.linkedin.com/hiring/jobs/4277798308/applicants/25550787924",
    "https://www.linkedin.com/in/mahak-ayani",
    "https://www.linkedin.com/talent/hire/123/manage/all"
  ]) {
    assert.equal(Applicants.isResumeDocumentUrl(route), false, `${route} is a page, not a file`);
  }

  // A real document is one, whether it says so by extension, by host, or by path.
  for (const document of [
    "https://media.licdn.com/dms/document/ABC123/resume.pdf",
    "https://media.licdn.com/dms/document/ABC123",
    "https://example.com/cv/mahak-ayani.docx",
    "https://files.example.com/ambry/abcd1234"
  ]) {
    assert.equal(Applicants.isResumeDocumentUrl(document), true, `${document} is a file`);
  }
  // A LinkedIn MEDIA address is not a document either, and this is the hole that
  // threatened the no-open path specifically. The pre-click sweep
  // (`findResumeDocumentUrl(null)`) reads `meta[content]`, `[data-delayed-url]`
  // and `[data-src]` across the whole `document` — which includes `<head>` — and
  // `RESUME_MEDIA_PATTERN` accepted ANY licdn host on the host alone, with no
  // path and no extension. So an `og:image` or a portrait satisfied "the address
  // is already known", nothing was opened, and a JPEG was written to
  // `profile-vault-resumes/` under the applicant's name and reported
  // `downloaded`. Rule 6, on the exact path this surface is meant to prefer.
  for (const media of [
    "https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_400_400/0/1700000000000",
    "https://media.licdn.com/dms/image/C4E0BAQ/company-logo_200_200/0/1600000000000",
    "https://static.licdn.com/aero-v1/sc/h/abc.png",
    "https://media.licdn.com/dms/video/D4E05AQ/mp4-720p/0/1700000000000.mp4",
    "https://media.licdn.com/dms/document/ABC123/preview.jpg"
  ]) {
    assert.equal(Applicants.isResumeDocumentUrl(media), false, `${media} is media, not a document`);
  }

  assert.equal(Applicants.isResumeDocumentUrl(""), false);
  assert.equal(Applicants.isResumeDocumentUrl("javascript:void(0)"), false);

  // Defence in depth: a route arriving on `url` — from an older record, a hand
  // edit, or a route mistaken for a file — is moved to `viewerUrl`, exactly as
  // `normalizeProfile` moves a linkedin.com address off `cvUrl`.
  const repaired = Applicants.normalizeApplicantRecord({
    applicant: {
      name: "Mahak Ayani",
      resume: { available: true, url: "https://www.linkedin.com/hiring/applicants/?applicationId=1", downloadStatus: "downloaded" }
    }
  });
  assert.equal(repaired.applicant.resume.url, null, "a page must never be offered as the file");
  assert.equal(repaired.applicant.resume.viewerUrl, "https://www.linkedin.com/hiring/applicants/?applicationId=1");

  const real = Applicants.normalizeApplicantRecord({
    applicant: { name: "X", resume: { available: true, url: "https://media.licdn.com/dms/document/A/cv.pdf" } }
  });
  assert.equal(real.applicant.resume.url, "https://media.licdn.com/dms/document/A/cv.pdf");
  assert.equal(real.applicant.resume.viewerUrl, null);
});

test("the adapter and the worker both refuse a page route as a resume", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const step = source.slice(source.indexOf("async function collectResume"));
  assert.match(step, /const linkedUrl = Applicants\.isResumeDocumentUrl\(controlHref\) \? controlHref : ""/,
    "the control's href is only the file when it is one");
  assert.match(step, /const viewerUrl = linkedUrl \? "" : controlHref/, "otherwise it is the viewer address");
  assert.match(step, /viewerUrl: viewerUrl \|\| location\.href/, "and a viewer with no document still records where to look");

  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const download = worker.slice(worker.indexOf("async function downloadResume"), worker.indexOf("async function stopAllContentScripts"));
  assert.match(download, /RESUME_PAGE_PATTERN\.test\(url\)/, "the worker must refuse a page route");
  assert.match(download, /refused-page-not-a-document/, "and say so rather than report it downloaded");
  // The host check alone passed it, because the host genuinely is LinkedIn.
  assert.ok(
    download.indexOf("RESUME_PAGE_PATTERN") < download.indexOf("resumeAlreadyDownloaded"),
    "the page check must run before anything is fetched"
  );

  // And a picture is refused as firmly as a page. The host check passes
  // `media.licdn.com` on its own, so without this a portrait picked up by the
  // page-side sweep lands on disk under the applicant's name as their CV.
  assert.match(download, /RESUME_NON_DOCUMENT_PATTERN\.test\(url\)/, "the worker must refuse a media address");
  assert.match(download, /refused-media-not-a-document/, "and name that refusal distinctly");
  assert.ok(
    download.indexOf("RESUME_NON_DOCUMENT_PATTERN") < download.indexOf("resumeAlreadyDownloaded"),
    "the media check must also run before anything is fetched"
  );
});

test("the applicant list is grown when the run needs a row, never walked up front", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const loader = source.slice(source.indexOf("async function loadEveryApplicantRow"), source.indexOf("async function extractAllApplicants"));
  assert.ok(loader.length > 200, "loading the list must be its own step");

  // Trap 3 on a new surface: a virtualized list read once gives a screenful,
  // and a run over a screenful reports itself complete after ten people.
  // Growth is measured in ROW IDENTITIES, never in a count. A paginated list
  // swaps 25 rows for 25 different people, so the count is unchanged by a whole
  // page of progress; a virtualized list recycles, so the count is a window size
  // that never rises at all. `rows > seen` was false in both regimes forever.
  assert.match(loader, /quiet = takeNewRows\(\) > 0 \? 0 : quiet \+ 1/, "growth must mean new rows, never a scroll that happened");
  assert.match(loader, /const seenKeys = new Set\(applicantRows\(\)\.map\(rowKey\)\)/, "and it remembers who, not how many");
  assert.match(loader, /LIST_QUIET_PASSES/, "it must stop on repeated passes that reveal nothing");
  assert.match(loader, /LIST_MAX_PASSES/, "and it must be bounded so it cannot run forever");
  assert.match(loader, /waitForDomQuiet\(/, "the next slice is fetched over the network and must be waited for");
  assert.match(loader, /finally \{[\s\S]*?scrollPanelTo\(startY, target\)/, "the list must be handed back where it was");
  assert.match(loader, /assertRunnable\(\)/, "and Stop must end it");

  // THE REPORT: "you do not need to scroll [the applicant list] in the start,
  // scroll when needed". A run over a 665-applicant job used to walk the whole
  // list to the end across every page before opening the first person — minutes
  // of scrolling with nothing collected, and the recruiter's own list dragged
  // away from wherever they had left it.
  //
  // The on-demand growth carries the SAME three bounds as the full walk, because
  // the failure mode it protects against is the same one: growth counts new
  // rows, a fruitless pager is retired, and the attempt is capped.
  const grow = source.slice(source.indexOf("async function growApplicantList"), source.indexOf("async function extractAllApplicants"));
  assert.ok(grow.length > 200, "growing the list on demand must be its own step");
  assert.match(grow, /LIST_GROW_PASSES/, "one attempt must be bounded");
  assert.match(grow, /walk\.fruitless < MAX_FRUITLESS_PAGINATION/, "a settled page is still not a settled list");
  assert.match(grow, /walk\.fruitless = produced \? 0 : walk\.fruitless \+ 1/, "growth must mean new rows, never a click");
  // And "produced" is the CALLER's question — is there a row the run has not
  // done — so a pager that replaces a page is scored as the progress it is.
  // `arrived` is the same question asked with a deadline: `waitFor(() => wanted())`.
  // Quiet was the wrong thing to wait on in both directions — the DOM is quiet
  // while the next page is still in flight, and a re-mount never falls quiet
  // inside the timeout at all — so the rows are waited for directly.
  assert.match(grow, /const produced = Boolean\(arrived\) \|\| wanted\(\);/,
    "the pager is judged by what the run can now collect");
  assert.match(grow, /const arrived = await waitFor\(\(\) => wanted\(\), \{[\s\S]{0,160}?PAGE_ARRIVAL_TIMEOUT_MS/,
    "and the page is waited for by its rows, not by the DOM falling quiet");
  assert.match(grow, /async function growApplicantList\(diagnostics, hasWork\)/, "the caller supplies the question");
  assert.match(grow, /assertRunnable\(\)/, "and Stop must end it");

  // THE REPORT: "it stops after going to the next page." Pressing the pager
  // re-mounts the whole hiring view, and for those milliseconds
  // `applicantList()` answers null — so the walk fell back to the container it
  // was holding, which by then is DETACHED. A detached node reports no scroll
  // range (every pass reads as "already at the bottom"), and
  // `findApplicantPaginationControl` searches its subtree and finds the PREVIOUS
  // page's pager, which does nothing when clicked. Three presses later the walk
  // concludes `pagination-retired`, or finds nothing and concludes `settled` —
  // and both are CONCLUSIVE, so the run reports COMPLETED, `claimAutoRun`
  // refuses to re-arm a completed job, and nothing can ever restart it.
  assert.ok(!/const live = applicantList\(\) \|\| list;/.test(grow),
    "falling back to the held container walks a detached list");
  assert.match(grow, /const live = await waitForApplicantList\(\);\s*if \(!live\) \{\s*walk\.stoppedBy = "no-list";/,
    "a missing list is waited for, and otherwise ends the call INCONCLUSIVELY");
  assert.equal(Applicants.isConclusiveListStop("no-list"), false,
    "so a re-mount can never complete a run");
  // And the position handed to the new page must address the new page.
  assert.match(grow, /const paged = applicantList\(\);\s*if \(paged\) scrollPanelTo\(0, chooseScrollTarget\(paged\)\)/,
    "the scrolled container is replaced with the page it belonged to");

  const waiter = source.slice(source.indexOf("function waitForApplicantList"), source.indexOf("function createListWalk"));
  assert.match(waiter, /const live = applicantList\(\);\s*if \(live\) return Promise\.resolve\(live\)/,
    "the common case must cost nothing");
  assert.match(waiter, /waitFor\(\(\) => applicantList\(\), \{ timeoutMs, pollMs: 200/,
    "and the wait is `waitFor`, so Stop and a hidden tab still come first");

  // THE REPORT: "it automatically stops working ... make sure it works until the
  // whole list is completed." The on-demand walk took ONE observation as the
  // verdict — a single pass that ended at the bottom having revealed nothing
  // consulted the pager, and with no pager in sight it broke out, after which
  // `extractAllApplicants` saw no further row and marked the run COMPLETED. A
  // slice still in flight, or a scroll target with no range, therefore finished
  // a 665-applicant job in the first dozen rows and called it done.
  assert.match(grow, /quiet \+= 1;\s*\n\s*if \(quiet < LIST_QUIET_PASSES\) continue;/,
    "the bottom has to be confirmed, not believed on sight");
  assert.ok(
    grow.indexOf("if (quiet < LIST_QUIET_PASSES) continue;") < grow.indexOf("const pager ="),
    "and confirmed BEFORE the pager is consulted, or the confirmation buys nothing"
  );
  assert.match(grow, /quiet = 0;/, "a fruitless page click earns the same confirmation over again");
  // Re-resolved per pass — a detached container reports the range it had when it
  // was unmounted. Written `applicantList() || list` until 3.7.10, and that
  // fallback WAS the detached container: see the re-mount assertions above.
  assert.match(grow, /const live = await waitForApplicantList\(\);/,
    "the list is re-resolved per pass, and never fallen back to a held node");

  // The other half, and the one no amount of confirming fixes: the container
  // being driven is a guess. When it is wrong `maxScrollPosition` answers 0,
  // every pass reads as "already at the bottom", and no row ever arrives.
  assert.match(grow, /nudgeListToLastRow\(\)/, "the bottom must be reachable without knowing which container scrolls");
  const nudge = source.slice(source.indexOf("function nudgeListToLastRow"), source.indexOf("/** The walk ledger"));
  assert.match(nudge, /last\.scrollIntoView\(\{ block: "end", inline: "nearest" \}\)/,
    "scrollIntoView scrolls every scrollable ancestor the row needs");
  assert.ok(!/\.click\(\)/.test(nudge), "it is a read: it presses nothing");
  // The full walk shares the defect, so it shares the escape.
  assert.match(loader, /else nudgeListToLastRow\(\);/, "the full walk uses it too");

  const run = source.slice(source.indexOf("async function extractAllApplicants"));
  assert.doesNotMatch(run, /^\s*(?:const [\w.]+ = )?await loadEveryApplicantRow\(listDiagnostics\);$/m,
    "the run must not walk the whole list unconditionally");
  assert.match(run, /if \(options\.loadAll === true\) await loadEveryApplicantRow\(listDiagnostics\)/,
    "the full walk stays available, but only when it is asked for");
  assert.match(run, /if \(!pending\.length\) \{[\s\S]{0,1800}?grown = await growApplicantList\(listDiagnostics, \(\) => unprocessedRows\(\)\.length > 0\)/,
    "the list is scrolled only when the run has run out of rows it has not done");
  assert.equal((run.match(/await growApplicantList\(/g) || []).length, 1,
    "and from exactly one place, so no path can scroll the list unconditionally");
  // ONE list scan per turn. `applicantRows()` walks every row link in the list,
  // and a resumed run spends most of its turns skipping already-saved rows, so
  // scanning twice per turn cost a mostly-collected 665-applicant job over a
  // thousand full scans to decide it had nothing to do.
  assert.match(run, /let pending = unprocessedRows\(\);/, "the turn takes one scan");
  assert.match(run, /known = Math\.max\(known, processed\.size \+ pending\.length\);/, "and every answer comes from it");
  // Already-saved rows are retired in BULK from that one scan, rather than
  // costing a whole turn - and another scan - each.
  assert.match(run, /for \(const candidate of pending\) \{/, "collected rows are retired in bulk");
  assert.match(run, /const saved = candidateId\s*\n\s*\? collected\.has\(\{ applicationId: candidateId \}\)/,
    "decided from the row's own href, so no row has to be opened to find out");
  assert.match(run, /: collected\.has\(\{ name: candidate\.name \}\);/,
    "and the name - which forces a layout - is consulted only when there is no id");
  assert.match(run, /scrollPanelTo\(listStartY,/, "and it is handed back where the recruiter left it when the run ends");
});

test("the run walks the list by identity, so a position can never address the wrong person", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const run = source.slice(source.indexOf("async function extractAllApplicants"), source.indexOf("// -------------------------------------------------- coming back to a job"));

  // THE REPORT: "it is not working for all the list of applicants ... it stops
  // again and again". The walk was `for (let index = 0; ; index += 1)` over a
  // freshly re-queried `applicantRows()`, reading `live[index]` as "applicant
  // number index". Position means nothing on this list, in either regime it can
  // be in:
  //   - PAGINATED (rule 9h): page two renders 25 DIFFERENT people at positions
  //     0-24, so index 25 addresses nobody and the run ends at COMPLETED; had
  //     page two rendered 26 rows, live[25] would have been applicant #51 and
  //     #26-#50 would never have been opened.
  //   - VIRTUALIZED: rows are recycled out of the DOM, so applicantRows() is a
  //     moving window of about a dozen. The index runs off the end of it after a
  //     dozen people, no scrolling can make length exceed it, and 665 applicants
  //     are reported complete having collected twelve.
  // Comments first, and for once that is not a formality: this file documents
  // the defect it fixed in the very words the check greps for, so a prose
  // description of the old walk would read as the old walk.
  const code = withoutComments(run);
  assert.ok(!/for \(let index = 0; ; index \+= 1\)/.test(code), "the positional walk must not come back");
  assert.ok(!/live\[index\]/.test(code), "and a position must never be used to address a person");

  // What replaces it: a ledger of what has been finished with, and "the first
  // rendered row I have not finished with".
  assert.match(run, /const processed = new Set\(\);/, "the run keeps its own ledger");
  // "Which row next" is the roster's answer, not the DOM's. The ledger says what
  // is finished with; the roster says where each row sits on the page, and
  // without it the walk takes whichever unfinished row the mounted window
  // happens to render first — which is how it kept stepping back to an applicant
  // it had already passed.
  assert.match(run, /const roster = Applicants\.createApplicantRoster\(\);/, "and a roster of the page it is on");
  assert.match(run, /pending = roster\.sort\(pending\);/, "which is what puts the mounted window back into page order");
  assert.match(run, /const row = pending\[0\];/, "so the next row is the next row on the page");
  assert.match(source, /function rowKey\(row\)/, "identity must be a named, single rule");
  const key = source.slice(source.indexOf("function rowKey(row)"), source.indexOf("How many scroll attempts"));
  assert.match(key, /Applicants\.applicantRowKey\(row\)/,
    "the adapter delegates identity to the pure policy exercised against recycled rows");
  assert.equal(Applicants.applicantRowKey({ href: APPLICANTS_URL }), "id:25550787924",
    "keyed on the only identifier a row carries before it is opened");
  assert.equal(Applicants.applicantRowKey({ href: "https://www.linkedin.com/hiring/applicants/custom" }),
    "href:https://www.linkedin.com/hiring/applicants/custom", "with the href as the fallback");
  assert.equal(Applicants.applicantRowKey({ name: "  Asha Rao  " }), "name:asha rao",
    "and the name last, because a row with no key at all would be walked forever");

  // The name is read LAZILY, and that is a performance rule rather than a style
  // one: innerText forces a synchronous layout flush, and applicantRows() used to
  // take it for every rendered row on every call while the walk keys on `href`
  // alone. The `text` field it also built was read by nothing.
  const rows = source.slice(source.indexOf("function applicantRows()"), source.indexOf("// ------------------------------------------------------------- sections"));
  assert.match(rows, /Object\.defineProperty\(entry, "name", \{/, "the row's name must be a lazy getter");
  assert.ok(!/text: lines\.join/.test(rows), "and the dead text field must not come back");
  assert.ok(!/const lines = toLines\(row\.innerText/.test(rows), "no eager innerText per rendered row");

  // Every TERMINAL outcome records the row; a pause deliberately does not,
  // because a paused row still has to be done.
  const terminal = [...run.matchAll(/processed\.add\(key\)/g)].length;
  assert.ok(terminal >= 4, `every terminal outcome must record the row (found ${terminal}: collected, already-saved, could-not-open, failed)`);

  // Completion means "no unprocessed row can be produced AND the walk reached the
  // end of the list" — never "the mounted window ran out", and never "the scroll
  // budget ran out". Growing the list and finding nothing is necessary, not
  // sufficient: see the PERMANENT conclusive-stop test.
  assert.match(
    run,
    /if \(!pending\.length\) \{[\s\S]{0,1800}?if \(Applicants\.isConclusiveListStop\(stoppedBy\)\) \{\s*\n\s*state\.run\.state = Applicants\.RUN_STATE\.COMPLETED;/,
    "the run ends only when growing the list yields nothing AND the walk reached the list's end"
  );
  // And the total handed to nextRunStep cannot itself declare the queue complete
  // at the end of page one — the old `total: known` was a rendered-row count.
  assert.match(run, /Applicants\.nextRunStep\(state\.run, \{ total: processed\.size \+ 1 \}\)/,
    "the step check must not be able to complete a run the list has not exhausted");

  // The first row is no longer assumed to be the one already open.
  assert.ok(!/if \(index > 0\) \{/.test(run), "`index > 0` assumed the open panel was row zero");
  assert.match(source, /if \(!\(await panelAlreadyShowing\(rowId\)\)\) \{/,
    "the panel is opened unless the PANEL ITSELF already says it shows this row");
  assert.ok(!/rowId !== openId/.test(withoutComments(source)),
    "the address bar can no longer decide on its own that an applicant is already open");
  // Still exactly seven click call sites: this adds no control (rule 9).
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7, "the click budget is unchanged");
});

test("a control in the list header can never retire the open applicant's row", async () => {
  // THE REPORT, with the recruiter's own table beside the live list: "in every
  // page's list the first name is being skipped every time ... as soon as I
  // start the extension the first profile gets skipped."
  //
  // The list renders a control INSIDE itself — "Here are all applicants to your
  // job. Edit qualifications" — whose href carries the applicationId the page is
  // currently on. `applicantRowKey` keys a row on exactly that id, so the
  // control and the OPEN APPLICANT'S OWN ROW hash to one key. The control
  // renders above the rows, so the walk reaches it first, every terminal outcome
  // retires the key, and `unprocessedApplicantRows` then filters the real row
  // out as already finished with. One person lost per page, in silence.
  const openId = "25550787924";
  const control = { href: `https://www.linkedin.com/hiring/jobs/4123/applicants/${openId}/`, name: "Edit qualifications" };
  const openRow = { href: `https://www.linkedin.com/hiring/jobs/4123/applicants/${openId}/`, name: "Komal Sharma" };
  const nextRow = { href: "https://www.linkedin.com/hiring/jobs/4123/applicants/25550787925/", name: "Neha Singh" };

  // The collision itself, stated rather than assumed — this is why the label has
  // to decide, and why the href never can.
  assert.equal(Applicants.applicantRowKey(control), Applicants.applicantRowKey(openRow),
    "the control and the open applicant's row are the same address, so they are one key");

  // The defect, reproduced: let the control in and the applicant it collides
  // with is never offered again.
  const processed = new Set([Applicants.applicantRowKey(control)]);
  assert.deepEqual(
    Applicants.unprocessedApplicantRows([control, openRow, nextRow], processed).map((row) => row.name),
    ["Neha Singh"],
    "a control that takes a turn takes the open applicant's turn with it"
  );

  // The fix: it is refused before it can ever become a row.
  assert.equal(Applicants.isApplicantRowLabel("Edit qualifications"), false, "a control phrase is a thing to press");
  assert.equal(Applicants.isApplicantRowLabel("Resume"), false, "and so is chrome rendered inside a row");
  assert.equal(Applicants.isApplicantRowLabel("Contact info"), false);
  assert.equal(Applicants.isApplicantRowLabel("Komal Sharma"), true, "a person is a row");
  assert.equal(Applicants.isApplicantRowLabel("Komal Sharma · 2nd"), true, "degree badge and all");
  // A row's own link carries the whole card, which is longer than any name and
  // is a row by construction. It must never be judged as a label.
  assert.equal(
    Applicants.isApplicantRowLabel(
      "Komal Sharma · 2nd Human Resource Manager | MBA in HR & Marketing Noida, Uttar Pradesh, India 7/7 Must-have 2/2 Preferred"
    ),
    true,
    "the whole card is not a control label"
  );
  // Losing a real applicant is the failure this fixes, so a link with nothing to
  // read is judged by its href exactly as before — never refused.
  assert.equal(Applicants.isApplicantRowLabel(""), true, "an unlabelled link keeps the old verdict");
  assert.equal(Applicants.isApplicantRowLabel("   "), true);
  // A bare verb stays a row: `Edit` is a real given name, and the control
  // pattern deliberately needs a second word before it calls something a control.
  assert.equal(Applicants.isApplicantRowLabel("Edit"), true, "a bare verb may still be a person");

  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const link = source.slice(source.indexOf("function isApplicantRowLink"), source.indexOf("function rowLinksIn"));
  assert.match(link, /Applicants\.isApplicantRowLabel\(cleanText\(anchor\.textContent\)\)/,
    "the adapter delegates to the one policy rather than growing a second list of controls");
  // Comments stripped before the two refusals below, because this file explains
  // the defect in the very words the check greps for — the prose naming what
  // must not be read would otherwise read as reading it.
  const code = withoutComments(link);
  // `innerText` would force a layout for every anchor of every list scan, which
  // is the exact cost the row's lazy name getter exists to avoid.
  assert.ok(!/innerText/.test(code), "no forced layout per anchor per scan");
  // And never the accessible name: "View Komal Sharma's application" is an
  // entirely plausible aria-label for a row, and it leads with a verb — judging
  // it would refuse every row on the page rather than one control.
  assert.ok(!/aria-label/.test(code), "the accessible name must not be judged");

  // The label rule is a ROW rule and must not leak into "does this address name
  // an application". The panel's own application link is the arrival test's best
  // source, and it is labelled whatever LinkedIn labels it — `View full profile`,
  // `Resume`, or an icon with no text at all. Judging it as a row would refuse
  // it and drop `panelApplicationId` back to the address bar, which on this
  // surface moves ahead of the render: exactly the source that cannot be trusted.
  assert.match(source, /function hasApplicationHref\(anchor\)/, "the address test stands on its own");
  assert.match(link, /if \(!hasApplicationHref\(anchor\)\) return false;/,
    "and the row test is built on top of it rather than duplicating it");
  const panelId = source.slice(source.indexOf("function panelOwnApplicationId"), source.indexOf("function panelMemberUrl"));
  assert.match(panelId, /if \(!hasApplicationHref\(anchor\)\) continue;/,
    "the panel's own id is read from the address, never through the row policy");
});

test("the bottom of the panel is reached without knowing which container scrolls", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // Every position-based walk in this codebase depends on having correctly
  // identified the one container that scrolls, and getting it wrong is silent:
  // the walk runs, the position never moves, the first read is already "the
  // bottom", and one screenful is saved as the whole applicant.
  assert.match(source, /async function revealPanelContent\(/, "there must be a container-agnostic pass");
  const reveal = source.slice(source.indexOf("async function revealPanelContent"), source.indexOf("async function scanApplicantPanel"));
  assert.match(reveal, /step\.element\.scrollIntoView\(\{ block: step\.block, inline: "nearest" \}\)/,
    "scrollIntoView scrolls every ancestor the element needs, so it need not know");
  assert.match(reveal, /quiet = added > 0 \|\| grown > size \? 0 : quiet \+ 1/,
    "growth must mean new content, never a scroll that happened");
  assert.match(reveal, /REVEAL_QUIET_PASSES/, "it must stop on passes that reveal nothing");
  assert.match(reveal, /REVEAL_MAX_PASSES/, "and it must be bounded so it cannot run forever");
  assert.match(reveal, /assertRunnable\(\)/, "and Stop must end it");

  // THE REPORT: "you are scrolling the profile side only once." The reveal used
  // to scroll to the LAST rendered element on every pass, so pass one jumped to
  // the bottom and passes two and three had nowhere left to go — three passes,
  // one movement, and a lazy panel never asked for anything between the top and
  // wherever the first screenful's markup happened to end.
  const step = source.slice(source.indexOf("function nextRevealStep"), source.indexOf("const REVEAL_MAX_PASSES"));
  assert.match(step, /getBoundingClientRect\(\)\.top > fold - 8/,
    "a step is the first box that STARTS below the fold, which advances about one screenful");
  assert.match(step, /mode: "step", block: "start"/, "aligned to the top, so the step is a step and not a jump");
  assert.match(step, /mode: "tail", block: "end"/,
    "and only once nothing begins below the fold does it confirm the end by reaching it");
  // Measured in viewport coordinates on purpose: that is what makes the step
  // blind to which container scrolls, exactly as scrollIntoView is.
  assert.ok(!/scrollTop|scrollHeight/.test(step), "the step must not depend on having identified a scroller");

  // The floor under the quiet rule. Without it the quiet rule cannot tell "there
  // is nothing below this" from "nothing has mounted below this yet", and on a
  // panel rebuilt in place per applicant the second is the common case.
  // THE REPORT: "the scroll stops partway down, and restarting stops at the same
  // place". The walk had NO notion of the bottom at all — its only exit was the
  // quiet counter, and that counter measures CONTENT, not PROGRESS. `added` is an
  // accumulator-count delta and `grown` is the panel's text length, so a pass
  // that steps a full screenful CORRECTLY still counts as quiet whenever the
  // screenful it uncovered was already in the DOM or holds nothing new to parse.
  // Three of those plus the floor ends the walk at exactly pass four — about four
  // screenfuls down — while the panel scrolls perfectly the whole time. No timing
  // is involved, which is why a restart reproduced it exactly.
  assert.match(reveal, /if \(moved\) quiet = 0;/,
    "a pass that MOVED the panel is progress, even when it uncovered nothing new");
  assert.match(reveal, /const moved = shifted > REVEAL_MOVED_PX \|\| step\.element !== lastAnchor;/,
    "and movement is measured on the anchor itself, in viewport coordinates");
  // The end condition the walk never had. `mode: "tail"` is what nextRevealStep
  // returns once nothing begins below the fold — this function's honest
  // equivalent of atBottom, needing no scroller identification.
  assert.match(reveal, /if \(reachedTail && quiet >= REVEAL_QUIET_PASSES/,
    "quiet may only end the walk once the bottom has actually been reached");
  // An immovable anchor is retired rather than re-picked for ever.
  assert.match(reveal, /if \(!moved && step\.mode === "step"\) stuck\.add\(step\.element\);/,
    "an anchor that did not budge must not be offered again");
  assert.match(step, /if \(stuck\?\.has\(element\)\) continue;/, "and nextRevealStep must honour that");
  assert.match(step, /if \(placement === "fixed" \|\| placement === "sticky"\) continue;/,
    "a box positioned against the viewport can never be moved by scrolling an ancestor");
  // A walk that never reached the bottom must say so instead of reporting
  // "settled", which is what hid this for as long as it did.
  assert.match(reveal, /if \(!reachedTail && record\.stoppedBy === "settled"\) record\.stoppedBy = "no-movement";/,
    "an unfinished walk must not report itself settled");
  assert.match(reveal, /record\.stoppedBy = "time-budget";/, "and the walk needs a wall-clock bound, not only a pass count");

  assert.match(source, /const REVEAL_MIN_PASSES = 4/, "at least four passes, as asked for");
  assert.match(reveal, /quiet >= REVEAL_QUIET_PASSES && record\.passes >= REVEAL_MIN_PASSES/,
    "the quiet rule must not be able to end the walk before the floor is met");
  // The nested region that holds Experience and Education is walked under the
  // same floor: it is rebuilt per applicant too, and a region that has not
  // mounted yet reads as "no range, already at the bottom" on its first pass.
  const region = source.slice(source.indexOf("async function revealRegion"), source.indexOf("async function revealNestedRegions"));
  assert.match(region, /const settled = pass \+ 1 >= REVEAL_MIN_PASSES/, "the region walk shares the floor");
  assert.match(region, /if \(settled && position >= max/, "so neither early exit can fire on the first pass");
  assert.match(region, /if \(settled && quiet >= REVEAL_QUIET_PASSES\) break/, "including the quiet one");

  // It runs after the position walk and before the record is assembled.
  const scan = source.slice(source.indexOf("async function scanApplicantPanel"), source.indexOf("// ---------------------------------------------------------- extraction"));
  assert.match(scan, /live = await revealPanelContent\(live, accumulator, diagnostics\) \|\| live/, "the walk must use it");
  assert.ok(
    scan.indexOf("revealPanelContent") < scan.indexOf("expandCollapsedSections"),
    "what it reveals may itself be collapsed"
  );
  // It scrolls arbitrary ancestors, so the page's own position is restored too.
  assert.match(scan, /const originalWindowY = window\.scrollY/, "the page position must be remembered");
  assert.match(scan, /finally \{[\s\S]*?window\.scrollTo\(\{ top: originalWindowY/, "and handed back on every path");
});

test("the reveal walk scrolls the applicant's column and never the recruiter's list", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const step = source.slice(source.indexOf("function nextRevealStep"), source.indexOf("const REVEAL_MAX_PASSES"));

  // THE REPORT: "the left applicant list sometimes moves while the right profile
  // is being read", and "do not scroll the left applicant list while extracting
  // the right-side profile".
  //
  // `scrollableRegions` has excluded the list since it was written — walking it
  // belongs to the list walk, and dragging it here moves the row the run is
  // standing on. `nextRevealStep`, which is the pass that actually scrolls, did
  // not, and its `root` is routinely BOTH columns: `applicantPanel()` resolves a
  // strict panel only when one container carries PANEL_MIN_SECTIONS *hydrated*
  // section headings, which on this surface it routinely does not — the whole
  // reason buildSectionMap widens page-wide — and the fallback refuses a `main`
  // holding more than one row link, landing on `document.querySelector("main")
  // || document.body`. From there the last rendered element, which is the tail
  // this walk aims at, is usually the last list row.
  assert.match(step, /if \(avoid && \(avoid\.contains\(element\) \|\| element\.contains\(avoid\)\)\) continue;/,
    "the other column is never an anchor for this one");
  // Resolved once for the whole pass: applicantList() is a document-wide scan
  // with an isVisible per candidate, and this loop runs over every element.
  assert.match(step, /const list = applicantList\(\);/, "and the list is resolved once per pass, not per element");

  // ⚠ THE GUARD MAY REFUSE AN ANCHOR; IT MAY NEVER LEAVE THE WALK WITHOUT ONE.
  // Reported the first time it shipped, in three words: "it stopped scrolling the
  // profile." applicantList() is a RESOLVER, not a fact — it takes the container
  // carrying the most row links and its candidates include main and [role=main].
  // Let it answer with something holding the panel's content too and every
  // candidate is refused, nextRevealStep returns null, and revealPanelContent
  // breaks on its first pass with "nothing-to-reveal": the profile column never
  // moves, so everything below its fold is never rendered and never read.
  assert.match(step, /const other = list && !list\.contains\(root\) \? list : null;/,
    "a list that also holds the root is this resolver reaching too wide, not the other column");
  assert.match(step, /return revealStepIn\(root, stuck, other\) \|\| \(other \? revealStepIn\(root, stuck, null\) : null\);/,
    "and a guarded pass that found nothing is retried unguarded, so the guard can never cost the walk");

  // Nothing readable is given up by refusing it, and that is what makes the
  // guard safe rather than merely faster: a list row is not the open applicant's
  // content, and every section collector already refuses a heading or a root
  // inside the list.
  const map = source.slice(source.indexOf("function collectSections"), source.indexOf("/** Visible entity blocks"));
  assert.match(map, /if \(list && list\.contains\(heading\.element\)\) continue/,
    "the section search refuses the list too, so the reveal is not the only thing keeping it out");

  // The guard the region walk has always had must stay: both are the same rule.
  const regions = source.slice(source.indexOf("function scrollableRegions"), source.indexOf("async function revealRegion"));
  assert.match(regions, /if \(list && \(list\.contains\(element\) \|\| element\.contains\(list\)\)\) continue;/,
    "and revealing a nested region still refuses it in the same both-directions form");
});

test("revealing costs no forced layout per candidate and no panel re-resolve per pass", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const step = withoutComments(source.slice(source.indexOf("function nextRevealStep"), source.indexOf("const REVEAL_MAX_PASSES")));

  // `isVisible` costs a getComputedStyle and two rect reads, and `innerText` is
  // layout-aware — it consults style and line breaking over the element's whole
  // subtree. Both were paid for EVERY div, section, li, p and heading under the
  // panel, on every one of up to REVEAL_MAX_PASSES passes, twice per applicant,
  // on a run that walks a job one applicant at a time.
  //
  // `textContent` answers the only question asked here — is there any text at
  // all — without consulting style or geometry. It is the rule sectionLabelsIn
  // already follows and the one applicantRows() was corrected to, and it can
  // only widen the candidate set, by a visible box whose text is all inside a
  // hidden child. A candidate is an ANCHOR: it decides where the walk scrolls,
  // never what is read, so a wider set cannot cost a field.
  assert.ok(!/innerText/.test(step), "no forced layout per candidate per reveal pass");
  assert.match(step, /const text = element\.textContent;/, "the text test must not consult style or geometry");
  assert.ok(
    step.indexOf("element.textContent") < step.indexOf("isVisible(element)"),
    "and it must be asked before isVisible, so the common case costs no layout"
  );

  // The same rule, on the read inside the region walk. `livePanel(null)` resolves
  // the panel from scratch every pass, and that resolve is one of the most
  // expensive calls in the file: a document-wide querySelectorAll, then per
  // candidate an isVisible, a rowLinksIn, a headingsIn and the whole column's
  // innerText. Paid up to REGION_MAX_PASSES times per region, per region, per
  // round, per applicant. Every other walk threads its panel through instead, and
  // livePanel() is what makes that identical: the same node while it is
  // connected, a fresh resolve once it is detached.
  const walk = withoutComments(source.slice(source.indexOf("async function revealRegion"), source.indexOf("async function revealNestedRegions")));
  assert.match(walk, /async function revealRegion\(region, accumulator, diagnostics, panel = null\)/,
    "the region walk is given the panel it is reading");
  assert.match(walk, /snapshotPanel\(livePanel\(panel\), accumulator, diagnostics\)/,
    "and reuses it while it is connected instead of re-deriving it every pass");
  assert.ok(!/livePanel\(null\)/.test(walk), "no page-wide panel resolve inside the pass loop");
  const nested = withoutComments(source.slice(source.indexOf("async function revealNestedRegions"), source.indexOf("async function revealPanelContent")));
  assert.match(nested, /const host = livePanel\(panel\) \|\| document\.body;/, "resolved once per round");
  assert.match(nested, /revealRegion\(region, accumulator, diagnostics, host\)/, "and handed down rather than looked up again");

  // What must NOT change: this is a cost fix, so every bound that decides when a
  // walk ENDS stays exactly where it was. The floor, the quiet rule and the
  // bottom test are what stop a panel being read half way.
  assert.match(source, /const REVEAL_MIN_PASSES = 4/, "the floor is untouched");
  assert.match(source, /const REVEAL_QUIET_PASSES = 3/, "so is the quiet rule");
  const region = source.slice(source.indexOf("async function revealRegion"), source.indexOf("async function revealNestedRegions"));
  assert.match(region, /const settled = pass \+ 1 >= REVEAL_MIN_PASSES/, "and the region walk still shares the floor");
});

test("a section outside the resolved panel is still the open applicant's", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const map = source.slice(source.indexOf("function collectSections"), source.indexOf("/** Visible entity blocks"));

  // `applicantPanel()` picks the smallest container carrying the most section
  // headings, and a heading that has not hydrated does not count — so a panel
  // resolved early can be a sub-container of the real detail column, and
  // Experience, Education and Skills were then invisible for the whole
  // extraction. That is the "current role and company are empty on every row"
  // report.
  assert.match(map, /collectSections\(page, map, \{ excludeList: true, source: "page" \}\)/,
    "a section the panel did not hold must still be searched for");
  // ...and only when one is actually missing. 3.9.0 asks that of
  // `REQUIRED_SECTION_KEYS` — the keys a READER consumes — rather than of the
  // whole table, so a key added for diagnostics or for marking a boundary can
  // never schedule an extra page-wide search for a section nothing will read.
  assert.match(map, /if \(REQUIRED_SECTION_KEYS\.some\(\(key\) => !map\[key\]\)\)/, "and only when one is actually missing");
  assert.match(map, /const missing = \(\) => new Set\(REQUIRED_SECTION_KEYS\.filter/,
    "and the label passes are scheduled off the same list");
  assert.match(source, /const page = document\.querySelector\("main"\) \|\| document\.body/,
    "and the page-wide root is the page, never the applicant list");

  // The widening stays honest: never the list, and never a container that
  // swallows a second section, whose blocks would belong to the wrong one.
  assert.match(map, /if \(list && list\.contains\(heading\.element\)\) continue/, "never a heading inside the applicant list");
  assert.match(map, /if \(list && list\.contains\(element\)\) continue/, "and never a root inside it either");
  assert.match(map, /element\.contains\(other\.element\)\)\) continue/, "a root swallowing another section is refused");

  // 3.7.6: the root a heading owns is bounded by EVERY other heading, not only
  // by the one that follows it. An ancestor reaching back over the section
  // above contains that section's heading — which is precisely what the
  // widened pass refuses — so Experience, the section most often outside the
  // resolved panel, resolved to nothing at all and every derived column was
  // empty.
  const rootFor = source.slice(source.indexOf("function sectionRootFor"), source.indexOf("function collectSections"));
  assert.match(rootFor, /const others = allHeadings\.filter\(/, "the bound must be every other heading");
  assert.match(rootFor, /if \(others\.some\(\(entry\) => node\.contains\(entry\.element\)\)\) break/,
    "an ancestor that swallows another heading is not this section's root");
  assert.ok(!/DOCUMENT_POSITION_FOLLOWING/.test(rootFor), "bounding on the next heading alone is what left the root too wide");
});

test("a section root has to carry the section, and a useless one never blocks a better one", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // THE DEFECT, reported four times. LinkedIn renders the applicant's section
  // title in its own header row — the word plus a collapse chevron — with the
  // entries in a SIBLING container. `sectionRootFor` walked only upwards and
  // seeded `best` with the heading's parent, so on that markup it returned the
  // header row: a root whose entire text is "Experience". `blocksIn` found
  // nothing, the text fallback parsed the single word, EXPERIENCE_NOISE_PATTERN
  // correctly discarded it, and the applicant was saved with no experience —
  // which is exactly how current_role, current_company AND education came back
  // empty on a row that plainly showed all three.
  const rootFor = source.slice(source.indexOf("function carriesSectionContent"), source.indexOf("function collectSections"));
  assert.match(rootFor, /if \(carriesSectionContent\(node, heading\)\) best = node;/,
    "an ancestor is only this section's root if it holds more than the heading");
  assert.ok(!/let best = heading\.element\.parentElement;/.test(rootFor),
    "the heading's own parent must not be accepted sight unseen — that is the bare header row");
  assert.match(rootFor, /return best \|\| siblingSectionFor\(heading, allHeadings\) \|\| null;/,
    "and when no ancestor qualifies, the section is the heading's following siblings");

  // The sibling range holds the LIVE nodes; the wrapper is detached and must
  // never move them out of the page.
  // The construction moved into `rangeWrapper` in 3.7.22 so the shared-root
  // narrowing could reuse it; the rule it encodes is unchanged.
  const siblings = source.slice(source.indexOf("function rangeWrapper"), source.indexOf("function sectionBoundaries"));
  assert.match(siblings, /wrapper\.__pvSectionNodes = nodes;/, "the real nodes are referenced, not copied");
  assert.ok(!/appendChild|append\(/.test(siblings), "appending would move the live nodes out of the page");
  assert.match(source, /const range = section\.element\.__pvSectionNodes;/, "and the block reader has to know about them");

  // THE AMPLIFIER, and why three releases of widening the search changed
  // nothing: once the panel pass had stored ANY root for `experience`, every
  // later and better pass was skipped for it.
  const map = source.slice(source.indexOf("function sectionIsUseful"), source.indexOf("/** Visible entity blocks"));
  assert.match(map, /function sectionIsUseful\(section\)/, "a stored section can be useless");
  assert.match(map, /const stored = map\[heading\.key\];\s*\n\s*if \(stored && sectionIsUseful\(stored\)\) continue;/,
    "only a USEFUL stored section blocks a later pass");
  assert.match(map, /if \(stored && !sectionIsUseful\(candidate\)\) continue;/,
    "and a useless candidate never replaces a useful one");
  assert.ok(!/if \(!heading\.key \|\| map\[heading\.key\]\) continue;/.test(map),
    "presence alone must not count as an answer");
});

test("no two sections are handed the same cards", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // THE DEFECT (3.7.22): one live applicant came back with their two jobs AND
  // their two degrees under Experience, the same four under Education, and the
  // screening question as a third job.
  //
  // `sectionRootFor` and `siblingSectionFor` are each bounded by the headings
  // THEIR OWN PASS was given, which is not the same set as "the section titles
  // on this page". A label pass never sees the real headings and a heading pass
  // never sees the labels; worse, the label passes are asked only for the keys
  // nothing else produced, so a pass looking for one missing section is handed
  // one candidate, `others` is empty, the upward walk never breaks — and the
  // root it returns is the whole detail column.
  const boundaries = source.slice(source.indexOf("function sectionBoundaries"), source.indexOf("function ownSectionNodes"));
  assert.match(boundaries, /const wanted = new Set\(SECTION_PATTERNS\.map\(\(entry\) => entry\.key\)\)/,
    "the boundary set is every section, never only the ones a pass still wants");
  assert.match(boundaries, /\[\.\.\.headingsIn\(root\), \.\.\.sectionLabelsIn\(root, wanted\)\]/,
    "headings AND labels — a title found either way ends a section either way");

  // The partition is a descent, because the two titles are routinely at
  // different depths — which is precisely what a sibling walk cannot answer.
  const own = source.slice(source.indexOf("function ownSectionNodes"), source.indexOf("function narrowSharedSections"));
  assert.match(own, /const mixed = children\.find\(\(child\) => holdsOwn\(child\) && holdsForeign\(child\)\)/,
    "a child holding both titles is descended into, not chosen");
  assert.match(own, /if \(holdsForeign\(child\)\) break;/, "and the section ends at the next section's title");

  // It may only ever take another section's cards away, never this section's
  // own: a narrowed range that carries nothing is discarded, and the section is
  // left exactly as the passes above resolved it.
  const narrow = source.slice(source.indexOf("function narrowSharedSections"), source.indexOf("function sectionRootFor"));
  assert.match(narrow, /if \(!foreign\.length\) continue;/, "a root holding no foreign title is untouched");
  assert.match(narrow, /if \(!carriesSectionContent\(narrowed, \{ text: section\.heading, element: title \}\)\) continue;/,
    "and a narrowed range that carries nothing is never taken");
  assert.match(source, /narrowSharedSections\(map, sectionBoundaries\(\[panel, page\]\)\);/,
    "run once the whole map exists, because only then is every boundary known");

  // The other half: every reader falls back to reading the section's text
  // LINEARLY when the markup offered no blocks, and a flat string has none of
  // the structure the narrowing works on. That is where the screening question
  // became a job title with the ideal answer beneath it as the employer.
  const lines = source.slice(source.indexOf("function ownSectionLines"), source.indexOf("function categoryBefore"));
  assert.match(lines, /return Boolean\(key\) && key !== section\.key;/,
    "the cut is at a DIFFERENT section's title");
  assert.ok(!/isSectionTitleLine/.test(lines),
    "and at nothing else — cutting on any noise line would end the section at its first verified card");
  for (const reader of ["readQualifications", "readScreeningResponses", "readExperience", "readEducation", "readSkills"]) {
    const body = source.slice(source.indexOf(`function ${reader}(`), source.indexOf(`function ${reader}(`) + 2600);
    assert.match(body, /ownSectionLines\(section\)/, `${reader}'s text fallback has to stop at the next section`);
  }
  assert.ok(!/for \(const line of toLines\(section\.element\.innerText \|\| ""\)\)/.test(source.slice(source.indexOf("function readQualifications"))),
    "no reader may still walk the whole root's text");
});

test("every nested scroller is revealed, not only the one the walk chose", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const regions = source.slice(source.indexOf("function scrollableRegions"), source.indexOf("async function revealRegion"));

  // `scrollCandidates` refuses a descendant carrying less than COLUMN_TEXT_SHARE
  // (60%) of the panel's text, so that a filter or a menu is never mistaken for
  // the column. Right there, wrong here: the applicant's profile preview —
  // Experience, Education, "View full profile" — is its own nested scroller and
  // carries well under 60% once qualifications and screening are counted. It was
  // refused as a scroll target, and `revealPanelContent` only ever calls
  // scrollIntoView on the panel's last element, which moves that element's
  // ANCESTORS. So nothing ever scrolled it, only its first screenful rendered,
  // and the two sections below its fold were never read.
  assert.ok(!/COLUMN_TEXT_SHARE/.test(regions), "revealing must not inherit the scroll-target text-share gate");
  assert.match(regions, /element\.scrollHeight - element\.clientHeight <= Applicants\.COLUMN_SCROLL_EPSILON\) continue/,
    "a region that cannot move is not a region");
  assert.match(regions, /if \(!\/auto\|scroll\|overlay\/i\.test/, "and it has to actually be scrollable");
  assert.match(regions, /if \(list && \(list\.contains\(element\) \|\| element\.contains\(list\)\)\) continue;/,
    "the applicant list is walked by loadEveryApplicantRow, never dragged from here");
  assert.match(regions, /sort\(\(a, b\) => elementDepth\(b\) - elementDepth\(a\)\)/, "innermost first");

  const walk = source.slice(source.indexOf("async function revealRegion"), source.indexOf("async function revealNestedRegions"));
  assert.match(walk, /const startTop = region\.scrollTop;/, "the region is handed back where it was");
  assert.match(walk, /finally \{[\s\S]{0,200}region\.scrollTop = startTop;/, "on the failure path as well");
  assert.match(walk, /assertRunnable\(\);/, "and a Stop ends it at the next step");

  // And it runs where it can do any good: after the panel walk and after the
  // scrollIntoView pass, because a section that only exists once its own region
  // has moved cannot be found by either of them.
  const scan = source.slice(source.indexOf("async function scanApplicantPanel"));
  const revealAt = scan.indexOf("await revealPanelContent(");
  const regionsAt = scan.indexOf("await revealNestedRegions(");
  assert.ok(revealAt >= 0 && regionsAt > revealAt, "nested regions are revealed after the panel itself");
});

test("a section that produced nothing prints the markup it was read from", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // Asked for explicitly after the fourth report: a heading and a block count
  // say a section was FOUND, and it was. The question that needed answering was
  // what that root actually contained, and only the real HTML says that.
  assert.match(source, /function sectionMarkup\(section\)/, "the markup must be capturable");
  assert.match(source, /SECTION_HTML_LIMIT/, "bounded — a panel's outerHTML is hundreds of kilobytes");
  assert.match(source, /html: sectionMarkup\(section\)/, "and carried on the diagnostics, not only the console");
  const log = source.slice(source.indexOf("function logSectionScan"), source.indexOf("/** Visible entity blocks"));
  assert.match(log, /for \(const key of \["experience", "education"\]\)/, "both sections that came back empty");
  assert.match(log, /if \(diagnostics\?\.totals\?\.\[key\]\) continue;/, "and only when they actually produced nothing");
  assert.match(log, /no section resolved\. Headings seen:/, "not-found and found-but-empty are different reports");
});

test("a section title is still a section title with a count, a qualifier or a colon after it", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // The live report: current_role, current_company and total_experience empty on
  // every row. All three are derived from the Experience section and nothing
  // else, so an empty column means no experience card was ever read — and
  // `^experiences?$` matched only when the account rendered that exact word.
  //
  // 3.9.0 moved the table into the pure core, so this is now asserted by CALLING
  // it rather than by reading its source. That is strictly stronger: the old
  // form proved a regex was present in a file, this proves the wordings resolve.
  assert.equal(Applicants.sectionKeyFor("Experience"), "experience", "Experience is still matched");
  for (const wording of ["Work experience", "Professional experience", "Employment experience", "Career experience"]) {
    assert.equal(Applicants.sectionKeyFor(wording), "experience", `"${wording}" is the Experience section`);
  }
  assert.equal(Applicants.sectionKeyFor("Education"), "education", "Education likewise");
  assert.equal(Applicants.sectionKeyFor("Educational background"), "education");

  assert.equal(Applicants.sectionKeyFor("Experience (5)"), "experience", '"Experience (5)" is the Experience section');
  assert.equal(Applicants.sectionKeyFor("Skills (12+)"), "skills");
  assert.equal(Applicants.sectionKeyFor("Experience 5"), "experience", 'and so is "Experience 5"');
  assert.equal(Applicants.sectionKeyFor("Experience:"), "experience", 'and "Experience:"');
  assert.equal(Applicants.sectionKeyFor("Experience · 3 roles"), "experience", "and a middot list of metadata after it");

  // A section LinkedIn did not mark up as a heading at all is the last resort,
  // asked only for what nothing else found — never a class name (rule 11).
  assert.match(source, /function sectionLabelsIn\(root, wanted\)/, "a non-heading title must still be findable");
  const labels = source.slice(source.indexOf("function sectionLabelsIn"), source.indexOf("/** A link that opens another application"));
  assert.match(labels, /if \(!key \|\| !wanted\.has\(key\)\) continue/, "and only for a section nothing else produced");
  assert.match(labels, /if \(!raw \|\| raw\.length > 60\) continue/, "text is measured before layout is");
  assert.ok(!/class\*?=/.test(labels), "a section may never be identified by a generated class name");

  // Blocks that yielded nothing must not silence the text on screen — but a
  // re-read that parsed the same records again is not "nothing", it is the same
  // answer, and running the whole-section text fallback over it is how a root
  // spanning Experience and Education manufactured jobs out of school names.
  const experience = source.slice(source.indexOf("function readExperience"), source.indexOf("function readEducation"));
  assert.match(experience, /if \(parsed\) return added;/, "the text fallback runs when the blocks PARSED nothing");
  assert.match(experience, /if \(!record\) continue;\s*\n\s*parsed \+= 1;/, "parsing and storing are counted separately");
  assert.ok(!/if \(added \|\| blocks\.length\) return added;/.test(experience),
    "a section whose list items are chrome used to return 0 and never read its own text");
});

test("the qualifications card is found even when only its subheadings name it", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // `Qualifications` is what LinkedIn labels the must-have / preferred verdict
  // card, and the pattern gets the same widening Experience got in 3.7.6.
  // Asserted by calling the table since 3.9.0 moved it into the core.
  for (const wording of ["Screening qualifications", "Job qualifications", "Candidate qualifications", "Applicant qualifications"]) {
    assert.equal(Applicants.sectionKeyFor(wording), "qualifications", `"${wording}" is the qualifications card`);
  }
  for (const wording of ["Qualifications summary", "Qualifications overview", "Qualifications match"]) {
    assert.equal(Applicants.sectionKeyFor(wording), "qualifications", `"${wording}" too`);
  }

  // The real gap: plenty of accounts render only `Must-have qualifications` and
  // `Preferred qualifications` and never the plain word, so no section key
  // matched and the whole card was invisible — no requirements, both tallies
  // blank, and nothing saying why.
  assert.match(source, /function collectQualificationSubsections\(root, map, /, "the subheadings must be able to name the section");
  const subs = source.slice(source.indexOf("function collectQualificationSubsections"), source.indexOf("function buildSectionMap"));
  assert.match(subs, /if \(map\.qualifications \|\| !root\) return map;/, "and only when nothing else named it");
  assert.match(subs, /Applicants\.qualificationCategoryOf\(heading\.text\)/,
    "the same rule that files a requirement under a category, not a second copy of it");
  assert.match(subs, /container = commonAncestor\(container, sectionRootFor\(heading, root, all\)\)/,
    "the card is the smallest element holding every subheading");
  assert.match(subs, /if \(all\.some\(\(other\) => other\.key && container\.contains\(other\.element\)\)\) return map;/,
    "a container swallowing a different section is refused — a wrong qualification is worse than an absent one");
  assert.match(subs, /if \(list && list\.contains\(container\)\) return map;/, "and never the applicant list");

  // Consulted last, after every other way of naming the section has been tried.
  const build = source.slice(source.indexOf("function buildSectionMap"), source.indexOf("/** `div#applicant-detail"));
  assert.ok(
    build.indexOf("collectQualificationSubsections") > build.indexOf("page-label"),
    "the subheading fallback is the last resort, not the first"
  );
  assert.match(build, /collectQualificationSubsections\(page, map, \{ excludeList: true, source: "page-subheadings" \}\)/,
    "and it is tried page-wide too, with the list refused");
});

test("an empty column is explicable from the page it was read on", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // Rule 19 in spirit: "current_role is empty" is not actionable, and a live
  // page is the only place the answer exists. So the extraction records what it
  // looked for and what the DOM answered, and says so in the page's console.
  assert.match(source, /function recordSectionScan\(map, panel, page, diagnostics\)/, "the section search must report itself");
  const scan = source.slice(source.indexOf("function recordSectionScan"), source.indexOf("function logSectionScan"));
  assert.match(scan, /headingSelector: HEADING_SELECTOR/, "the selector that was targeted");
  assert.match(scan, /wanted: SECTION_PATTERNS\.map/, "the patterns it was matched against");
  assert.match(scan, /key: heading\.key \|\| ""/, "every heading the page rendered, matched or not");
  assert.match(scan, /foundIn: section\.source \|\| "panel"/, "where each section was actually found");
  assert.match(scan, /blocks: blocksIn\(section\)\.length/, "and how many blocks came out of it");
  assert.match(scan, /missing: SECTION_PATTERNS/, "and which sections nothing named");

  // Once per applicant, not once per snapshot — it reads innerText page-wide and
  // a scan takes dozens of snapshots.
  assert.match(source, /diagnostics\.sections = Object\.keys\(buildSectionMap\(panel, diagnostics\)\)/,
    "the full scan is recorded once, after the walk");
  assert.match(source, /if \(diagnostics\) recordSectionScan\(map, panel, page, diagnostics\)/, "and only when asked for");
  assert.match(source, /logSectionScan\(diagnostics\)/, "and it reaches the console the recruiter can open");

  // One map per snapshot, shared by every reader: seven page-wide heading scans
  // per read is both slow and seven chances to disagree about where a section is.
  const snapshot = source.slice(source.indexOf("function snapshotPanel"), source.indexOf("/** The last element inside"));
  assert.match(snapshot, /const sections = buildSectionMap\(panel\);/, "the map is built once per read");
  assert.match(snapshot, /readExperience\(sections, accumulator\)/, "and handed to the readers");
  assert.match(snapshot, /diagnostics\.sectionsFound = Object\.keys\(sections\)/, "each read says what it could see");
});

test("the resume document is found wherever the viewer rendered it", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const finder = source.slice(source.indexOf("function findResumeDocumentUrl"), source.indexOf("/** The viewer LinkedIn mounted"));

  // Every applicant came back `link_only` with no file and no link: the search
  // looked at four tag shapes and decided with a local extension regex, so a
  // viewer handing its document to a plugin through `data-source-url`, or a
  // media host with no extension in the path, produced nothing.
  assert.match(finder, /DOCUMENT_URL_ATTRIBUTES/, "the address may be in more than one attribute");
  assert.match(finder, /for \(const root of \[scope, applicantPanel\(\), document\]\)/, "nearest first, then the page");

  // The widening cannot return a route: the decision is the tested rule, which
  // refuses a linkedin.com page address before it considers anything else.
  assert.match(finder, /Applicants\.isResumeDocumentUrl\(url\)/, "one rule decides what a file is");
  assert.ok(!/DOCUMENT_EXTENSION_PATTERN\.test\(url\)/.test(finder), "not a second local copy of it");

  // And it is waited for, not sampled on the frame the viewer appeared.
  const step = source.slice(source.indexOf("async function collectResume"));
  assert.match(step, /waitFor\(\s*\n\s*\(\) => findResumeDocumentUrl\(overlay\) \|\| requests\.url\(\) \|\| fetchedResumeDocumentUrl\(openedAt\),\s*\n\s*\{ timeoutMs: RESUME_DOCUMENT_TIMEOUT_MS/,
    "the viewer mounts its shell before it fetches the document, within the fast resume budget");

  // The saved file is reported by where it is, not by Chrome's download id.
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const download = worker.slice(worker.indexOf("async function downloadResume"), worker.indexOf("async function stopAllContentScripts"));
  // 3.7.7: not the requested path either, but the one Chrome actually wrote.
  assert.match(download, /localReference: actual\.path/, "an integer told the recruiter nothing, and a guessed path little more");
  assert.match(download, /downloadId: String\(downloadId\)/, "the id is kept, just not as the reference");
});

test("a viewer that never writes the address down is still read, from what it fetched", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const finder = source.slice(source.indexOf("function fetchedResumeDocumentUrl"), source.indexOf("/** The viewer LinkedIn mounted"));

  // The remaining way to open a viewer and save no file: LinkedIn's document
  // viewer fetches the bytes in JavaScript and paints them into a <canvas>, or
  // hands them to a plugin as a `blob:` URL — which `resumeUrlFrom` refuses,
  // correctly, because the worker could never fetch it. So the attribute sweep
  // finds nothing and every applicant comes back `link_only`.
  assert.match(finder, /performance\.getEntriesByType\("resource"\)/,
    "what the page actually requested is an observation, not a guess");
  assert.match(finder, /Applicants\.isResumeDocumentUrl\(url\)/, "and the same one rule still decides what a file is");

  // THE SAFETY. The entry buffer belongs to the document and a run walks
  // hundreds of applicants through one without ever navigating, so consulted
  // unbounded this would hand applicant two applicant one's CV — under the wrong
  // person's name, which is worse than no file at all (rule 6).
  assert.match(finder, /if \(!Number\.isFinite\(since\)\) return "";/, "it must refuse to answer without a floor");
  assert.match(finder, /if \(!entry \|\| !\(entry\.startTime >= since\)\) continue;/, "and only ever see this applicant's own requests");
  const step = source.slice(source.indexOf("async function collectResume"), source.indexOf("// ------------------------------------------------------------- the scan"));
  assert.match(step, /const openedAt = performance\.now\(\);[\s\S]{0,600}?control\.element\.click\(\)/,
    "the floor is stamped before the click, so nothing earlier can be picked up");
  assert.ok(!/fetchedResumeDocumentUrl\(\)/.test(source), "it is never called without one");

  // THE DEFECT, reported as "it saved the resume for seven profiles but not
  // after that": no budget of ours stops at seven. The resource timing buffer
  // holds 250 entries and SILENTLY stops recording when it is full, and a run
  // walks hundreds of applicants through one document without ever navigating.
  // A few dozen requests per applicant exhausts it around the seventh, after
  // which `fetchedResumeDocumentUrl` can never see the document again and every
  // applicant comes back `link_only` — a link, a file name and no file.
  const watcher = source.slice(source.indexOf("function watchResumeRequests"), source.indexOf("/** The viewer LinkedIn mounted"));
  assert.ok(watcher.length > 200, "observing the requests must be its own step");
  assert.match(watcher, /new PerformanceObserver\(/,
    "an observer is delivered every entry, so it cannot stop working part way through a run");
  assert.match(watcher, /Applicants\.isResumeDocumentUrl\(url\)/,
    "and the same one rule still decides what a file is, so it can no more return a route");
  // The safety, and it is structurally stronger than the `since` floor rather
  // than a relaxation of it: a buffered observer replays what is already in the
  // timeline, which is the PREVIOUS applicant's document — one person's CV under
  // another person's name, worse than no file at all (rule 6).
  assert.match(watcher, /observer\.observe\(\{ type: "resource", buffered: false \}\)/,
    "unbuffered, so it can only ever see requests made after this applicant's viewer was opened");
  assert.match(watcher, /observer\?\.disconnect\(\)/, "and it must be stoppable");
  // Started before the click, and always disconnected — a run walks hundreds of
  // applicants through one document, so a leaked observer grows with the job.
  assert.match(step, /const requests = watchResumeRequests\(\);[\s\S]{0,400}?control\.element\.click\(\)/,
    "the watch starts before the click that makes the page fetch the file");
  assert.match(step, /\} finally \{\s*\n\s*requests\.stop\(\);\s*\n\s*\}/,
    "and ends on every path out, including a Stop or a hidden page thrown out of a wait");
  // The log stays as the fallback for a browser with no observer, still floored.
  assert.match(step, /requests\.url\(\) \|\| fetchedResumeDocumentUrl\(openedAt\)/,
    "the observer answers first; the buffer is the fallback, and keeps its floor");
});

test("a resume that did not land is never recorded as saved", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // The defect: `downloadedFilePath` returned the REQUESTED path when Chrome
  // reported the download interrupted, and the caller still answered
  // `downloaded` — so an expired signed media address, a 403, or an HTML error
  // body was written onto the record as a saved file with a path that is not on
  // disk. `mergeApplicantRecord`'s `keepDownload` then protected that wrong
  // answer from ever being corrected by a later collection.
  const path = worker.slice(worker.indexOf("async function downloadedFilePath"), worker.indexOf("async function downloadResume"));
  assert.match(path, /if \(item && item\.state === "interrupted"\) \{\s*\n\s*return \{ path: "", interrupted: true/,
    "an interrupted download must report itself as one");
  const download = worker.slice(worker.indexOf("async function downloadResume"), worker.indexOf("async function stopAllContentScripts"));
  assert.match(download, /if \(actual\.interrupted\) \{[\s\S]{0,320}?status: "failed"/, "and must never be answered as downloaded");

  // Second attempt, from the tab that rendered it. A content script still never
  // touches chrome.downloads — it hands back bytes, and the worker writes them.
  assert.match(download, /retryFromPage: !dataUrl/, "the page is asked exactly once, never in a loop");
  assert.match(download, /url: dataUrl \|\| url/, "the direct download is still tried first, every time");
  assert.match(download, /if \(dataUrl && !\/\^data:\/i\.test\(dataUrl\)\)/, "and only page-fetched bytes are accepted");
  assert.ok(!/RESUME_HOST_PATTERN[\s\S]{0,200}dataUrl/.test(download),
    "the address is still what is checked — the bytes are what was found at it");

  const fetcher = source.slice(source.indexOf("async function fetchResumeBytes"), source.indexOf("async function collectResume"));
  assert.match(fetcher, /credentials: "include"/, "the page's own session is the point of fetching it there");
  assert.match(fetcher, /\^text\\\/html\|\^application\\\/xhtml/, "an HTML answer is never written to disk as a CV");
  assert.match(fetcher, /MAX_RESUME_BYTES/, "and the size is bounded before it becomes a message");
  assert.ok(!/chrome\.downloads/.test(withoutComments(source)),
    "a content script has no chrome.downloads (rule: the worker owns it)");

  // An applicant collected twice still says which file on disk is theirs.
  assert.match(source, /downloadedResumes: new Map\(\)/, "the register remembers where each file landed");
  assert.match(source, /localReference: state\.downloadedResumes\.get\(key\) \|\| null/,
    "so `already_saved` names the file instead of leaving the column empty");
});

test("a stopped run can be started again without reloading the page", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // The live defect: `wentHidden` is latched the instant the recruiter switches
  // tab — which is how they reach the extension's own Applicants page — and was
  // only ever cleared several steps inside `extractApplicant`. So the next run
  // threw "the applicants page is hidden" out of `loadEveryApplicantRow` before
  // reading a row, and only a page reload (a fresh content script, a fresh
  // `state`) ever cleared it.
  assert.match(source, /function beginRun\(\)/, "starting work must be one named step");
  // Re-derived from the page rather than left latched — and CLEAR-ONLY.
  // `assertRunnable` tests `!isPageVisible() || state.wentHidden`, whose first
  // half is self-clearing and whose second is not, so sampling the live question
  // into the latch writes a permanent answer to a temporary one. A page that is
  // genuinely hidden is still refused by the half that asks live.
  assert.match(source, /function clearHiddenLatchIfVisible\(\)/, "clearing the latch must be one named rule");
  assert.match(source, /if \(isPageVisible\(\)\) state\.wentHidden = false;/,
    "the hidden flag must be re-derived from the page, not left latched");
  assert.ok(
    !/state\.wentHidden = !isPageVisible\(\)/.test(withoutComments(source)),
    "and nothing may SET it from a sample — that is how a lost race poisoned an applicant permanently"
  );
  const run = source.slice(source.indexOf("async function extractAllApplicants"));
  assert.match(run, /^\s*async function extractAllApplicants\(options = \{\}\) \{\s*\n\s*beginRun\(\);/,
    "a run must begin by clearing both flags");
  assert.ok(!/async function extractAllApplicants\(options = \{\}\) \{\s*\n\s*state\.aborted = false;\s*\n/.test(source),
    "clearing the stop flag alone is what left the run unstartable");
  assert.match(source, /if \(type === "PV_APPLICANT_EXTRACT"\) \{\s*\n\s*beginRun\(\);/,
    "and so must a single applicant");

  // A second press while a run is genuinely in flight is answered at once
  // rather than left hanging on the first run's promise for up to an hour.
  assert.match(source, /if \(state\.running\) \{[\s\S]*?alreadyRunning: true/, "a run already in flight must say so");

  // The other half: the hiring tab is a different tab from the page the button
  // was pressed on, so it is hidden the moment it is clicked and LinkedIn stops
  // rendering it. Rule 12a, and rule 12 keeps the tab decision in the controller.
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /async function revealApplicantTab\(tab: any\)/, "the hiring tab must be made renderable");
  assert.match(worker, /await Tabs\.activate\(tab\.id, \{ focusWindow: true \}\)/,
    "through the controller that owns every tab decision, and raising the window a button press asked for");
  for (const command of ["COLLECT_CURRENT", "COLLECT_ALL"]) {
    const branch = worker.slice(worker.indexOf(`APPLICANT_MESSAGES.${command}) {`));
    assert.ok(
      branch.indexOf("await revealApplicantTab(tab)") < branch.indexOf("ensureContentScript"),
      `${command} must reveal the tab before it asks the page to read itself`
    );
  }
  assert.ok(!/chrome\.tabs\.update\(/.test(worker.slice(worker.indexOf("async function revealApplicantTab"))),
    "the worker must never activate a tab itself");
});

test("a run resumes over the applicants it has not collected yet", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const run = source.slice(source.indexOf("async function extractAllApplicants"));

  // The live complaint: a run stopped half way went back to the first applicant
  // and collected all of them again.
  assert.match(source, /async function loadCollectedIndex\(jobId\) \{/,
    "the run must ask what is already saved");
  assert.match(source, /type: "PV_APPLICANT_COLLECTED"/, "of the worker, which is the only thing with a store");
  assert.match(run, /Applicants\.createCollectedIndex\(\[\], \{ jobId \}\)\s*:\s*await loadCollectedIndex\(jobId\)/,
    "and `recollect` is how the whole list is asked for on purpose");

  // ONE question, asked the same way by both commands. The list pass used to ask
  // its own — "do I already HAVE them" — for one reason: it wrote name-only
  // records, which `isCollectedApplicant` correctly refuses to call collected.
  // Once it started writing full records that reason evaporated, and what was
  // left was the reported "even if I click the extension to start again it does
  // not scroll the profile": every thin record a broken run left behind counted
  // as done, so the applicants it FAILED on were exactly the ones the next run
  // walked straight past, unreachable by any number of button presses.
  assert.ok(!/createListedIndex/.test(source), "the have-them index must not come back");
  assert.ok(!/const listed = options\.listOnly === true;/.test(run), "and neither must the flag that chose it");
  assert.match(source, /return Applicants\.createCollectedIndex\(reply\?\.entries \|\| \[\], \{ jobId: jobId \|\| "" \}\);/,
    "both commands ask whether the person was actually collected");

  // The worker still sends every stored entry with the verdict beside it rather
  // than filtering on it: the index applies the verdict, the worker only reports.
  const workerSource = await readFile(resolve(root, "src/background.ts"), "utf8");
  const collectedBranch = workerSource.slice(
    workerSource.indexOf("if (type === APPLICANT_MESSAGES.COLLECTED) {"),
    workerSource.indexOf("if (type === APPLICANT_MESSAGES.AUTO_RUN) {")
  );
  assert.match(collectedBranch, /collected: Applicants\.isCollectedApplicant\(record\)/, "the verdict still travels");
  assert.ok(!/\.filter\(\(entry: any\) => entry\.collected\)/.test(collectedBranch),
    "but it must not be applied as a filter, or only one of the two questions can be answered");

  // A thin record is never a reason to skip somebody — that is the whole rule.
  const entries = [
    { applicationId: "1", jobId: "9", name: "Name Only", collected: false },
    { applicationId: "2", jobId: "9", name: "Fully Collected", collected: true }
  ];
  const index = Applicants.createCollectedIndex(entries, { jobId: "9" });
  assert.equal(index.has({ applicationId: "1" }), false, "a floor-name row is a FAILED read, and is tried again");
  assert.equal(index.has({ applicationId: "2" }), true, "a real one is walked past");
  // And judged from the record itself when the worker sent no verdict, so the
  // rule holds however the payload was produced.
  const judged = Applicants.createCollectedIndex([
    { applicationId: "3", jobId: "9", applicant: { name: "Floor Only" } },
    { applicationId: "4", jobId: "9", applicant: { name: "Read", education: ["Delhi University"] } }
  ], { jobId: "9" });
  assert.equal(judged.has({ applicationId: "3" }), false, "a record carrying only a name is not collected");
  assert.equal(judged.has({ applicationId: "4" }), true, "one substantive field is");
  // Still scoped to the job — an applicant is a person on a job.
  assert.equal(Applicants.createCollectedIndex(entries, { jobId: "8" }).has({ applicationId: "2" }), false);

  // Decided from the row's own href, before anything is opened.
  assert.match(run, /const rowId = Applicants\.parseHiringContext\(row\.href\)\.applicationId \|\| ""/,
    "the id in the row's href is all a row knows before it is opened");
  // Retired in BULK on one scan, before anybody is opened. The per-row copy of
  // this check went with the second path in 3.7.13; this one always did the
  // work for both, which is why removing that one changed no behaviour.
  assert.match(run, /\? collected\.has\(\{ applicationId: candidateId \}\)/,
    "an applicant already saved is judged from their row's own id");
  assert.match(run, /if \(!saved\) continue;[\s\S]{0,240}?alreadyCollected \+= 1/,
    "and walked past, not opened");
  assert.ok(
    run.indexOf("const saved = candidateId") < run.indexOf("await collectVisibleApplicant"),
    "and that verdict is reached before anybody is opened"
  );
  assert.match(run, /collected\.applications\.add\(rowId\.toLowerCase\(\)\)/,
    "and one collected in this run must not be collected again in it");

  // A worker that cannot answer must never mean "collect everything again".
  const loader = source.slice(source.indexOf("async function loadCollectedIndex"), source.indexOf("async function extractAllApplicants"));
  assert.match(loader, /catch \{[\s\S]*?return Applicants\.createCollectedIndex\(\[\], \{ jobId: jobId \|\| "" \}\)/,
    "an unreachable worker skips nobody");

  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const branch = worker.slice(worker.indexOf("APPLICANT_MESSAGES.COLLECTED"), worker.indexOf("APPLICANT_MESSAGES.CLEAR"));
  assert.match(branch, /Applicants\.isCollectedApplicant\(record\)/, "one copy of the rule, in the core");
  assert.ok(!/applicants,\s*total/.test(branch), "the reply must be lean, not every stored record");
});

test("coming back to an unfinished job run resumes it, but a completed run stays finished", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");

  // A navigation destroys the content script and everything it knew, so coming
  // back to a job left the surface idle until the button was pressed again. The
  // worker is the only thing that outlives the navigation, so it is what holds
  // the instruction — and it holds it only for a job the recruiter themselves
  // asked to collect, with the options they asked with.
  assert.match(worker, /async function armAutoRun\(jobId: string, options: any, tabId = 0\)/, "the worker must remember the job and owning tab");
  const collectAllStart = worker.indexOf("APPLICANT_MESSAGES.COLLECT_ALL) {");
  const collectAll = worker.slice(collectAllStart, worker.indexOf("return { ok: false, error", collectAllStart));
  assert.match(collectAll, /await armAutoRun\(/, "and only the whole-job command arms it");
  assert.ok(
    collectAll.indexOf("APPLICANT_MESSAGES.STATUS") < collectAll.indexOf("await armAutoRun("),
    "a second press must detect the live run before it can replace that run's lifecycle token"
  );
  const collectOne = worker.slice(worker.indexOf("APPLICANT_MESSAGES.COLLECT_CURRENT) {"), worker.indexOf("APPLICANT_MESSAGES.COLLECT_ALL) {"));
  assert.ok(!/armAutoRun/.test(collectOne), "collecting one applicant is not asking for the whole list");

  // A Stop that a navigation could undo is not a Stop (rule 13a).
  const stopAll = worker.slice(worker.indexOf("async function stopEverything"), worker.indexOf("async function handleApplicantCommand"));
  assert.match(stopAll, /await disarmAutoRuns\(\)/, "the universal Stop must clear the standing instruction");
  assert.match(worker, /APPLICANT_MESSAGES\.STOP\) \{\s*\n[\s\S]{0,200}?await disarmAutoRuns\(\)/, "and so must the page's own Stop");

  // Nothing is remembered forever: a job collected last week must not restart
  // itself because the page happened to be opened.
  assert.match(worker, /AUTO_RUN_TTL_MS/, "an armed job must expire");
  assert.match(worker, /return \{ ok: true, armed: false, reason: "not-collected-before" \}/,
    "a job that was never collected is never started");

  // The page asks on arrival, and an arrival is a change of VIEW within a job —
  // opening a row changes the address bar, and keying on the URL would restart
  // the run on every row it opened.
  assert.match(source, /function applicantsPageKey\(url\)/, "the arrival must be keyed on something stable");
  assert.match(source, /return Applicants\.applicantsViewKey\(url\)/,
    "one key rule, in the core where it is tested against real addresses");
  const arrival = source.slice(source.indexOf("function checkAutoRunArrival"), source.indexOf("function resumeAutoRun"));
  assert.match(arrival, /if \(key && key !== previous\) \{/, "moving within one view is not an arrival");
  assert.match(source, /\/\/ And once now[\s\S]{0,200}checkAutoRunArrival\(\);/, "a full page load is an arrival too");

  // It restarts from the first row — a fresh run state, never a stale index —
  // and it is still the recruiter's own instruction being replayed.
  const start = source.slice(source.indexOf("async function startAutoRun"), source.indexOf("function pumpAutoRun"));
  assert.match(start, /type: "PV_APPLICANT_AUTO_RUN", jobId/, "the worker is asked, never assumed");
  assert.match(start, /if \(!verdict\?\.armed\) return abandonAutoRun\(/, "and an unarmed job is left alone");
  assert.match(start, /runEveryApplicant\(verdict\.options \|\| \{\}, verdict\.tracking \|\| null\)/,
    "with the options and execution token the worker issued");
  assert.match(start, /if \(state\.running \|\| state\.extracting\) return abandonAutoRun\(/,
    "never on top of a run already in flight");
  // A pending arrival is still acted on the moment the tab is rendering again.
  // The handler grew a second branch in 3.7.9 — a return to the tab with no
  // arrival pending is now an arrival in its own right — so this asserts the
  // pending path specifically rather than the shape of the whole handler.
  const visibility = source.slice(source.indexOf("state.visibilityHandler = "), source.indexOf('document.addEventListener("visibilitychange"'));
  assert.match(visibility, /if \(state\.autoRun\.pendingKey\) resumeAutoRun\(\);/, "and starts when it is visible again");

  // 3.7.8: the page no longer explains this in prose — the explanatory text was
  // removed from every surface on request. The behaviour is unchanged and is
  // documented in CLAUDE.md and README.md instead.
  const page = await readFile(resolve(root, "src/react/applicants-dashboard.tsx"), "utf8");
  assert.ok(!/<p className="page-note">/.test(page), "the page carries no explanatory prose");

  // And it costs no new click: the restart replays the run, it does not invent
  // a control.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7, "the click budget is unchanged");
});

test("the worker lifecycle admits one newest execution and never reopens a completed run", async () => {
  const now = "2026-08-03T12:00:00.000Z";
  const entry = Applicants.createAutoRunEntry({
    options: { recollect: false }, now, runId: "run-1", tabId: 41
  });
  assert.equal(entry.state, Applicants.AUTO_RUN_STATE.RUNNING);
  assert.equal(entry.attempt, 1);

  // A different tab cannot become a second driver while the owner is running.
  const otherTab = Applicants.claimAutoRun(entry, { now, tabId: 99 });
  assert.equal(otherTab.armed, false);
  assert.equal(otherTab.reason, "running-in-another-tab");

  // The same tab may replace its destroyed/reinjected document. It gets a new
  // attempt token, so the old closure can no longer settle the successor.
  const replacement = Applicants.claimAutoRun(entry, { now, tabId: 41 });
  assert.equal(replacement.armed, true);
  assert.equal(replacement.entry.attempt, 2);
  const stale = Applicants.settleAutoRun(replacement.entry, {
    runId: "run-1", attempt: 1, state: Applicants.AUTO_RUN_STATE.INTERRUPTED, now
  });
  assert.equal(stale.changed, false);
  assert.equal(stale.reason, "stale-attempt");

  const finished = Applicants.settleAutoRun(replacement.entry, {
    ...replacement.tracking, state: Applicants.AUTO_RUN_STATE.COMPLETED, now
  });
  assert.equal(finished.changed, true);
  assert.equal(finished.entry.state, Applicants.AUTO_RUN_STATE.COMPLETED);
  assert.equal(Applicants.claimAutoRun(finished.entry, { now, tabId: 41 }).armed, false,
    "reload, route return and tab return must all leave a completed run finished");

  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  assert.match(source, /PV_APPLICANT_RUN_LIFECYCLE/, "the adapter must report its terminal lifecycle");
  assert.match(source, /runEveryApplicant\(verdict\.options \|\| \{\}, verdict\.tracking \|\| null\)/,
    "an automatic continuation must carry the worker's attempt token");
  assert.match(source, /runEveryApplicant\(message\.options \|\| \{\}, message\.tracking \|\| null\)/,
    "the deliberately started run must carry the first attempt token too");

  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /Applicants\.settleAutoRun\(/, "the worker must reject stale lifecycle reports through the pure policy");
  assert.match(worker, /reason: claimed\.reason \|\| "not-restartable"/,
    "completed or conflicting work must be refused rather than restarted");
});

test("a virtualized run advances by application id and never selects a finished row again", () => {
  const jobId = "4277798308";
  const ids = ["25550787924", "31813284466", "31780909456", "31770484956", "31761124316", "31759007336", "31758132116"];
  const row = (applicationId) => ({
    name: `Applicant ${applicationId}`,
    href: `https://www.linkedin.com/hiring/applicants/?applicationId=${applicationId}&jobId=${jobId}`
  });
  const processed = new Set();
  const selected = [];

  // The mounted DOM recycles: the second applicant remains visible in every
  // window, exactly like the repeated id in the supplied recording.
  const windows = [
    ids.slice(0, 3),
    [ids[1], ids[2], ids[3]],
    [ids[1], ids[3], ids[4]],
    [ids[1], ids[4], ids[5]],
    [ids[1], ids[5], ids[6]]
  ];
  for (const mounted of windows) {
    for (;;) {
      const next = Applicants.unprocessedApplicantRows(mounted.map(row), processed)[0];
      if (!next) break;
      const key = Applicants.applicantRowKey(next);
      assert.ok(!processed.has(key), `must not reselect ${key}`);
      processed.add(key);
      selected.push(key);
    }
  }

  assert.equal(new Set(selected).size, selected.length, "every selected applicant is unique");
  assert.deepEqual(selected, ids.map((id) => `id:${id}`), "the queue advances in first-seen list order");
});

test("the walk follows the page's own order, and a page is finished before the pager is pressed", () => {
  // THE REPORT, in two halves that turned out to be one cause: "it is saving a
  // profile, going to a specific profile, then to the next, saving, then back to
  // that specific profile, then next" — and "it did not even collect all the
  // applicants in one page."
  //
  // The walk's whole notion of the list was `applicantRows()`: whatever the DOM
  // has mounted at the instant it is asked. That answers neither question it was
  // being used for. It cannot say what ORDER the page is in, because a
  // virtualized window re-centres on the applicant whose panel was just opened
  // and so keeps re-mounting rows above it; and it cannot say who is ON the
  // page, because rows above wherever the list happened to be sitting were never
  // mounted at all and `growApplicantList` only ever scrolls down.
  const jobId = "4277798308";
  const page = ["11", "12", "13", "14", "15", "16"];
  const key = (id) => `id:${id}`;
  const row = (id) => ({
    name: `Applicant ${id}`,
    href: `https://www.linkedin.com/hiring/applicants/?applicationId=${id}&jobId=${jobId}`
  });
  const windowOf = (ids) => ids.map(row);

  // A three-row window that re-centres on the row just opened — the live
  // behaviour, and the reason the old rule went backwards.
  const centredOn = (id) => {
    const at = page.indexOf(id);
    const from = Math.max(0, Math.min(at - 1, page.length - 3));
    return page.slice(from, from + 3);
  };

  // 1. THE OLD RULE, on the recruiter's own starting position: LinkedIn had an
  //    applicant open half way down, so that is where the list was.
  const before = [];
  const beforeDone = new Set();
  let mounted = centredOn("14");
  for (let turn = 0; turn < page.length; turn += 1) {
    const next = Applicants.unprocessedApplicantRows(windowOf(mounted), beforeDone)[0];
    if (!next) break;
    const chosen = Applicants.applicantRowKey(next);
    beforeDone.add(chosen);
    before.push(chosen);
    mounted = centredOn(chosen.slice(3));
  }
  assert.deepEqual(before, ["id:13", "id:12", "id:11"],
    "the first mounted unfinished row walks the page BACKWARDS as the window re-centres");
  assert.ok(before.every((chosen, at) => at === 0 || chosen < before[at - 1]),
    "which is the reported 'goes to the next, then back to that specific profile'");
  assert.ok(before.length < page.length,
    "and it then runs out of mounted rows with half the page never opened, which is "
    + "'it did not even collect all the applicants in one page'");

  // 2. THE ROSTER. Settling the page is one walk of it, top to bottom, before
  //    anybody is opened — so the slices arrive in page order and the roster IS
  //    the page. `remaining` is then a fact about the page rather than about the
  //    window, which is what the pager press is gated on.
  const roster = Applicants.createApplicantRoster();
  for (const slice of [["11", "12", "13"], ["12", "13", "14"], ["14", "15", "16"]]) {
    roster.add(windowOf(slice));
  }
  assert.deepEqual(roster.keys(), page.map(key), "the roster holds the whole page, in the page's order");

  // 3. And the walk follows it: `next` is the next row of the PAGE, mounted or
  //    not, so a window showing somebody else is a reason to go and find them
  //    rather than to open whoever is on screen instead.
  const after = [];
  const done = new Set();
  for (let turn = 0; turn < page.length; turn += 1) {
    const owed = roster.next(done);
    if (!owed) break;
    after.push(owed);
    done.add(owed);
  }
  assert.deepEqual(after, page.map(key), "every applicant, in the order the page lists them");
  assert.equal(roster.remaining(done), 0, "and only then is the page finished");

  // A row still owed keeps the page unfinished even when nothing is mounted —
  // the difference between 'no unprocessed row is on screen' and 'no
  // unprocessed row is left', which is what pressed the pager too early.
  const half = new Set([key("11"), key("12")]);
  assert.equal(roster.remaining(half), 4, "rows recycled out of the DOM are still on the page");
  assert.equal(roster.next(half), key("13"), "and the next one is still the next one");

  // 4. A row that mounts late belongs where the slice that showed it puts it,
  //    between the rows it rendered between. Appending it would place it after
  //    rows that come after it — the ordering defect in a different costume.
  const late = Applicants.createApplicantRoster();
  late.add(windowOf(["11", "13", "15"]));
  assert.equal(late.add(windowOf(["11", "12", "13"])), 1, "growth counts rows never seen before");
  late.add(windowOf(["13", "14", "15"]));
  assert.deepEqual(late.keys(), ["11", "12", "13", "14", "15"].map(key), "merge-insert, never append");
  assert.equal(late.add(windowOf(["13", "14"])), 0, "and a window of nothing new gains nothing");

  // 5. A mounted window is sorted back into page order, with a row the roster
  //    has never seen sorting LAST — a row of unknown position guessed to the
  //    front is how the walk jumped backwards to begin with.
  const stranger = { name: "Stranger", href: "https://www.linkedin.com/hiring/applicants/stranger" };
  const sorted = late.sort([row("14"), stranger, row("12"), row("13")]);
  assert.deepEqual(sorted.map(Applicants.applicantRowKey), [key("12"), key("13"), key("14"), "href:https://www.linkedin.com/hiring/applicants/stranger"],
    "page order, and an unknown row last");

  // 6. A new page is a new roster: nothing about the old one survives the pager.
  late.reset();
  assert.equal(late.size, 0);
  assert.equal(late.next(new Set()), "", "so page two is walked in page two's order, from page two's first row");
});

test("the page is settled before anybody on it is opened, and the pager waits for it", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // "Make sure it is working in a sequence, collecting all applicants before
  // moving to next page." Both clauses are one step: the page the run has just
  // arrived at is walked end to end BEFORE its first applicant is opened, which
  // is what makes "the next row" and "this page is done" answerable at all.
  const sweep = source.slice(source.indexOf("async function sweepCurrentPage"), source.indexOf("* Reveal more rows"));
  assert.ok(sweep.length > 200, "settling a page must be its own step");
  assert.match(sweep, /scrollPanelTo\(0, chooseScrollTarget\(list\)\)/,
    "it starts at the TOP: the rows it exists to find are the ones above wherever the list was left");
  assert.match(sweep, /const gained = roster\.add\(applicantRows\(\)\)/,
    "and every pass feeds the roster, in the order the page rendered them");
  assert.match(sweep, /quiet = gained > 0 \? 0 : quiet \+ 1/,
    "growth means rows never seen before, never a scroll that happened");
  assert.match(sweep, /if \(atBottom && quiet >= LIST_QUIET_PASSES\)/,
    "the bottom is confirmed rather than believed on sight");
  assert.match(sweep, /pass < LIST_PAGE_PASSES/, "one page, one budget");
  assert.match(sweep, /assertRunnable\(\)/, "and Stop ends it");
  assert.match(sweep, /const live = await waitForApplicantList\(\);/,
    "the list is re-resolved per pass, never a detached node");
  // It settles a PAGE. Pressing the pager stays the caller's decision, made only
  // once the roster this settled has been finished with — that IS "all the
  // applicants before the next page".
  assert.ok(!/\.click\(\)/.test(sweep), "settling a page presses nothing, least of all the pager");
  assert.ok(!/findApplicantPaginationControl/.test(sweep), "and it never even looks for the pager");
  // Handed back at the top, so the page starts at its first row rather than its
  // last and then sweeping back up for every row above it.
  assert.match(sweep, /scrollPanelTo\(0, chooseScrollTarget\(\(await waitForApplicantList\(\)\) \|\| live\)\)/,
    "a settled page is handed back at its top");

  // THE REPORT: "it saves the list upside down — it collects the list top to
  // down, the first name gets saved first, so while saving data it starts from
  // the bottom."
  //
  // `roster.add()` places an unknown window relative to the first row of it the
  // roster already knows, and with no known row it has nothing to anchor on, so
  // it appends. That rule is sound while the page is walked DOWNWARD FROM THE
  // TOP, which is what this function does — every step overlaps the last, so
  // every window anchors. But the run's first act is `unprocessedRows()`, which
  // feeds the roster too, BEFORE this settle, with the list wherever LinkedIn
  // left it: scrolled to the applicant whose panel is open, i.e. the middle. Those
  // middle rows became positions 0..n; this settle then scrolled to the top and
  // added a window sharing no row with them, which anchored on nothing and was
  // appended AFTER them. The page order became "the middle, then the top", so
  // roster.next() handed back a middle row and the first name was reached last.
  assert.match(sweep, /if \(typeof wanted !== "function"\) roster\.reset\(\);/,
    "a settle DEFINES the page's order, so it may not inherit one guessed from an arbitrary scroll position");
  assert.ok(
    sweep.indexOf("roster.reset()") < sweep.indexOf("scrollPanelTo(0, chooseScrollTarget(list))"),
    "and it clears before it walks, or the first window from the top lands after the middle again"
  );
  // Scoped to a settle on purpose: a sweep asked to find one owed row must keep
  // the membership this page already established, which is what it searches
  // within. And it clears ORDER, never PROGRESS — the run's own ledger of
  // finished rows is a separate object, so nothing already collected is
  // collected twice.
  //
  // Comments stripped first: the prose above explains the defect in the very
  // words the check greps for, exactly as the row-label check has to.
  assert.ok(!/processed/.test(withoutComments(sweep)),
    "settling a page must not touch the run's own ledger of finished rows");

  const run = source.slice(source.indexOf("const processed = new Set();"), source.indexOf("// Retire EVERY already-saved row"));
  assert.match(run, /if \(!pageSettled\) \{\s*\n\s*await sweepCurrentPage\(roster, listDiagnostics\);\s*\n\s*pageSettled = true;/,
    "the page is settled before the walk opens anybody on it");
  // The next row is the page's next row, mounted or not — and when it is not,
  // the run goes and finds THAT row rather than opening whoever is on screen.
  assert.match(run, /const owed = roster\.next\(processed\);/, "which row is next is the roster's answer");
  assert.match(run, /const ready = pending\.length > 0 && rowKey\(pending\[0\]\) === owed;/,
    "and the run only proceeds when that row is the one it is about to open");
  assert.match(run, /await sweepCurrentPage\(roster, listDiagnostics, \(\) => mounted\(target\)\)/,
    "a row recycled out of the DOM is brought back, not skipped past");
  // Only a row that survives a confirmed walk of the whole page is retired, and
  // one at a time, so a single vanished row cannot condemn the rest.
  assert.match(run, /if \(!mounted\(target\)\) \{[\s\S]{0,400}?processed\.add\(target\);[\s\S]{0,400}?continue;/,
    "and only a row that is genuinely gone is skipped");

  // The pager is reached only after all of that, and a page it moves to is
  // settled in its turn before its first applicant is opened.
  assert.ok(
    run.indexOf("const owed = roster.next(processed);") < run.indexOf("await growApplicantList("),
    "the roster is consulted before anything may page forward"
  );
  assert.match(run, /if \(listDiagnostics\.listScroll\.paged !== pagedBefore\) \{\s*\n\s*roster\.reset\(\);\s*\n\s*pageSettled = false;\s*\n\s*await sweepCurrentPage\(roster, listDiagnostics\);/,
    "a pager press is a new page: a new roster, settled before it is walked");

  // The roster learns from every list read the run already makes, so a row
  // LinkedIn mounts late is merged into its own place at no extra scan.
  assert.match(run, /const unprocessedRows = \(\) => \{\s*\n\s*const rendered = applicantRows\(\);\s*\n\s*roster\.add\(rendered\);/,
    "every list scan feeds the roster");

  // Rule 9: this adds no control, on any path.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7, "the click budget is unchanged");
});

test("a roster seeded before the page is settled walks it from the middle, not the top", () => {
  // The defect DRIVEN rather than asserted about, because the roster is pure and
  // this is the half of the report that can be PROVEN in Node: "it saves the list
  // upside down — it collects the list top to down, the first name gets saved
  // first, so while saving data it starts from the bottom."
  //
  // The address shape the live rows carry, so the keys are the `id:` form the run
  // keys on rather than the `href:` fallback.
  const row = (id) => ({
    href: `https://www.linkedin.com/hiring/applicants/?applicationId=2555078792${id}&jobId=4277798308`,
    name: `Applicant ${id}`
  });
  const key = (id) => Applicants.applicantRowKey(row(id));
  const top = [row(1), row(2), row(3)];
  const middle = [row(7), row(8), row(9)];

  // What the run actually did, in order: `unprocessedRows()` feeds the roster on
  // the first turn, with the list wherever LinkedIn left it — scrolled to the
  // applicant whose panel is open — and only THEN did the settle scroll to the
  // top and walk down.
  const seeded = Applicants.createApplicantRoster();
  seeded.add(middle);
  seeded.add(top);

  // The middle window anchored on nothing, so it took positions 0..n; the window
  // from the top shared no row with it, anchored on nothing either, and was
  // appended AFTER it. The page order became "the middle, then the top".
  assert.equal(seeded.next(new Set()), key(7),
    "seeded first, the walk starts from the middle of the page — exactly the report");
  assert.deepEqual(seeded.keys().slice(0, 4), [key(7), key(8), key(9), key(1)],
    "and the page's first row sorts after the last one the middle window held");

  // The fix: a settle DEFINES the order, so it clears first and rebuilds walking
  // down from the top. Every step of a real sweep overlaps the last, which is
  // what gives `add` something to anchor on, so the order it builds is the page's.
  const settled = Applicants.createApplicantRoster();
  settled.add(middle);
  settled.reset();
  settled.add(top);
  settled.add([row(3), row(4), row(5)]);
  settled.add([row(5), row(6), row(7)]);
  settled.add([row(7), row(8), row(9)]);

  assert.equal(settled.next(new Set()), key(1),
    "cleared first, the walk starts at the page's first row");
  assert.deepEqual(settled.keys(), [1, 2, 3, 4, 5, 6, 7, 8, 9].map(key),
    "and the whole page is in the order the page renders it");

  // Clearing ORDER must not clear PROGRESS: the run's own ledger of finished rows
  // is a separate object, so a reset cannot make the run collect anybody twice.
  // Driven here so the source-text check above has a behaviour behind it.
  const done = new Set([key(1), key(2)]);
  assert.equal(settled.next(done), key(3),
    "a reset roster still walks past the rows the run had already finished with");
  assert.equal(settled.remaining(done), 7, "and reports only what is genuinely left");
});

test("an applicant is opened, read and saved exactly once, and 'already open' is the panel's answer", async () => {
  // THE REPORT, in two halves that are one cause: "after extracting one
  // applicant the extension opens a specific/previous profile again before
  // moving to the next", and "the first applicant on every page is saved twice".
  //
  // `collectVisibleApplicant` decided "this row is already open" from
  // `location.href` (`rowId !== openId`), and on that answer it skipped the click
  // AND every wait in `selectApplicantRow`. LinkedIn routes **ahead of the
  // render** — the whole reason `panelOwnApplicationId` refuses the address bar
  // outright — so the claim is true while the column is still showing the
  // PREVIOUS applicant. It is true exactly once per page: at the start of a run,
  // and after the pager press, which selects the new page's first applicant and
  // writes their id into the address before mounting them. Once per page is
  // precisely "the first applicant on every page".

  // 1. Why reading the stale panel was SILENT rather than caught. A panel that
  //    renders no application link of its own cannot contradict the id that was
  //    asked for, so the arrival verdict is ARRIVED and the record guard
  //    (`assertExpectedApplicant`, which only ever fires on OTHER) cannot save it.
  const stale = "in:https://www.linkedin.com/in/previous-applicant";
  const blind = Applicants.describePanelArrival({
    expected: "25550787924", applicationId: "", identity: stale, sections: 3, connected: true
  });
  assert.equal(blind.state, Applicants.PANEL_ARRIVAL.ARRIVED,
    "a panel carrying no id of its own answers ARRIVED whoever it is actually showing");

  // 2. Which is why the run has to say who it last finished with: a panel
  //    identical to the one the previous applicant was read off IS that
  //    applicant, whatever else cannot be read from it.
  const known = Applicants.describePanelArrival({
    expected: "25550787924", applicationId: "", identity: stale, previousIdentity: stale,
    sections: 3, connected: true
  });
  assert.equal(known.state, Applicants.PANEL_ARRIVAL.PREVIOUS,
    "and that same panel, named as the one just read, is the previous applicant");

  // 3. A stale panel that DOES carry its id is somebody else outright — the
  //    noisier half of the same defect, and the one that cost a visible re-open.
  const other = Applicants.describePanelArrival({
    expected: "25550787924", applicationId: "25550700000", identity: "id:25550700000",
    sections: 3, connected: true
  });
  assert.equal(other.state, Applicants.PANEL_ARRIVAL.OTHER, "a different id is a different applicant");

  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // 4. So the address bar is a HINT and the panel is the ANSWER.
  const ask = source.slice(
    source.indexOf("async function panelAlreadyShowing"),
    source.indexOf("async function collectVisibleApplicant")
  );
  assert.ok(ask.length > 200, "the already-open test must be its own step");
  assert.match(ask, /if \(claimed !== wanted\) return false;/,
    "a row the address bar does not even claim is certainly not open");
  assert.match(ask, /const seen = await waitFor\(\(\) => \{[\s\S]{0,200}?describeApplicantArrival\(rowId, previous\)/,
    "and a row it does claim is waited for on the panel, exactly as the click path waits");
  assert.match(ask, /verdict\.state === Applicants\.PANEL_ARRIVAL\.OTHER/, "somebody else ends the wait");
  assert.match(ask, /verdict\.state === Applicants\.PANEL_ARRIVAL\.PREVIOUS/,
    "and so does the applicant this run last finished with");
  assert.match(ask, /return Boolean\(seen\?\.arrived\);/,
    "only a positive arrival may skip the click; 'I could not tell' opens the row");
  assert.ok(!/\.click\(\)/.test(ask), "asking the panel presses nothing");

  // 5. And all it decides is whether the row is CLICKED — never whether the
  //    applicant is read. A panel that cannot be confirmed is opened.
  const open = source.slice(
    source.indexOf("async function collectVisibleApplicant"),
    source.indexOf("async function extractAllApplicants")
  );
  assert.match(open, /if \(!\(await panelAlreadyShowing\(rowId\)\)\) \{\s*\n\s*if \(!\(await selectApplicantRow\(row\)\)\) return \{ opened: false, record: null \};/,
    "an unconfirmed panel is opened by clicking the row the walk is owed");
  assert.match(open, /state\.lastPanelIdentity = panelIdentity\(\);/,
    "and who was on screen when this applicant was finished with is recorded for the next row");
  assert.equal((open.match(/extractApplicant\(/g) || []).length, 1, "one read per applicant");
  assert.equal((open.match(/selectApplicantRow/g) || []).length, 1, "and one row click per applicant");

  // 6. Why deduplication alone could never have fixed this. The record is keyed
  //    to the application that was ASKED for, so a scan that read the wrong panel
  //    writes the WRONG PERSON under the RIGHT id — which is not a duplicate key
  //    and no store-side reconciliation can catch it. The braces have to be that
  //    the wrong panel is never read.
  const extract = source.slice(
    source.indexOf("async function extractApplicant"),
    source.indexOf("// ------------------------------------------------------- every applicant")
  );
  assert.match(extract, /context: expected \? \{ \.\.\.context, applicationId: expected \} : context,/,
    "the record is keyed to the applicant that was asked for");
  assert.equal((extract.match(/assertExpectedApplicant\(expected\)/g) || []).length, 3,
    "and the panel is checked three times — none of which a panel rendering no id can fail");

  // 7. A new page resets the PAGE's membership and never the RUN's ledger: that
  //    is what makes the first applicant of page two a new person rather than a
  //    repeat, and what stops page one being walked a second time.
  const run = source.slice(
    source.indexOf("async function extractAllApplicants"),
    source.indexOf("async function runEveryApplicant")
  );
  assert.match(run, /roster\.reset\(\);\s*\n\s*pageSettled = false;/, "a pager press is a new page");
  assert.ok(!/processed\.clear\(\)/.test(run), "but the run's ledger of finished rows survives every page");
  assert.match(run, /processed\.add\(key\);\s*\n\s*state\.run\.index = processed\.size;/,
    "and a collected row joins that ledger before the walk moves on");

  // Rule 9: none of this adds a control.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7, "the click budget is unchanged");
});

test("returning to a job's applicant list is an arrival; opening a row is not", () => {
  const view = Applicants.applicantsViewKey;
  const JOB = "4277798308";

  // The live reference address, and the same address with a row opened on it.
  const list = `https://www.linkedin.com/hiring/applicants/?jobId=${JOB}`;
  const row = `https://www.linkedin.com/hiring/applicants/?applicationId=25550787924&rating=GOOD_FIT&jobId=${JOB}`;
  assert.equal(view(list), view(row),
    "opening a row is how a run ADVANCES — it must never read as arriving somewhere new");
  assert.match(view(list), new RegExp(`^job:${JOB}@`), "the job is still what an arrival is keyed on");

  // The same job in the path, with and without the application appended.
  const pathList = `https://www.linkedin.com/hiring/jobs/${JOB}/applicants`;
  const pathRow = `https://www.linkedin.com/hiring/jobs/${JOB}/applicants/25550787924`;
  assert.equal(view(pathList), view(pathRow), "an id in the path is still just a row being opened");

  // ...but a DIFFERENT view of the same job is somewhere else, which is what
  // makes LinkedIn's own in-app navigation back to the list a return.
  assert.notEqual(view(`https://www.linkedin.com/hiring/jobs/${JOB}/manage`), view(pathList),
    "the pipeline view and the applicant list are not the same place");

  // A different job is a different key even from the same view.
  assert.notEqual(view(`https://www.linkedin.com/hiring/applicants/?jobId=999${JOB}`), view(list));

  // Anything that is not an applicants view is blank, so LEAVING is observable.
  for (const away of [
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/my-items/posted-jobs/",
    `https://www.linkedin.com/hiring/jobs/${JOB}/detail`,
    "",
    "not a url"
  ]) {
    assert.equal(view(away), "", `${away || "(blank)"} is not an applicant list`);
  }
});

test("an arrival survives a lost race, a back button and a bfcache restore", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // ROOT CAUSE 1. 3.7.6 wrote `lastKey` before it tried to start, and starting
  // is async and fire-and-forget with several silent bails — so one lost race
  // lost the restart for good, and only a reload (a fresh `state`) got it back.
  // An arrival is now RECORDED, then retried until it is fulfilled or abandoned.
  const arrival = source.slice(source.indexOf("function checkAutoRunArrival"), source.indexOf("function resumeAutoRun"));
  assert.match(arrival, /state\.autoRun\.pendingKey = key;/, "an arrival is recorded, not consumed");
  assert.match(arrival, /pumpAutoRun\(\);/, "and acting on it is a separate, repeatable step");
  const pump = source.slice(source.indexOf("function pumpAutoRun"), source.indexOf("function checkAutoRunArrival"));
  assert.match(pump, /state\.autoRun\.attempts \+= 1;/, "retrying must be bounded");
  assert.match(pump, /AUTO_RUN_MAX_ATTEMPTS/, "by a stated number of attempts");
  assert.match(source, /\}, 800\);/, "the poller retries as well as watches");

  // The transient bails must NOT abandon: a list that has not mounted after an
  // in-app route, and a worker that was asleep, are the two that actually happen.
  const start = source.slice(source.indexOf("async function startAutoRun"), source.indexOf("function pumpAutoRun"));
  assert.match(start, /if \(!\(await waitForApplicantRows\(\)\)\) return;\s*\n/,
    "a list that has not mounted yet is tried again, never given up on");
  assert.match(start, /\/\/ retried rather than read as "no instruction"|retried rather than/,
    "a worker that did not answer is not an instruction to do nothing");
  // ...while a Stop and a run already in flight are final.
  assert.match(start, /if \(state\.autoRun\.disabled\) return abandonAutoRun\(/, "a Stop is final (rule 13a)");
  assert.match(source, /function abandonAutoRun\(reason\)/, "and giving up says why");

  // ROOT CAUSE 2. A poller only samples. These are the three things it misses.
  assert.match(source, /window\.addEventListener\("popstate", state\.navigationHandler\)/, "back and forward");
  assert.match(source, /window\.addEventListener\("hashchange", state\.navigationHandler\)/, "and a hash route");
  assert.match(source, /window\.addEventListener\("pageshow", state\.pageShowHandler\)/, "and a restored document");
  assert.match(source, /new MutationObserver\([\s\S]{0,400}routeCheckScheduled/,
    "and a pushState route, which is only observable through the re-render that follows it");

  // A bfcache restore is the reported case: the SAME document comes back still
  // holding the key it was frozen on, so the return reads as "already here".
  const pageShow = source.slice(source.indexOf("state.pageShowHandler = "), source.indexOf('window.addEventListener("pageshow"'));
  assert.match(pageShow, /if \(!event\?\.persisted\) return;/, "only a genuine restore");
  assert.match(pageShow, /state\.autoRun\.lastKey = "";/, "the stale key must not suppress the return");
  assert.match(pageShow, /clearHiddenLatchIfVisible\(\);/,
    "and the freeze latched wentHidden, which would throw 'the page is hidden' before a row was read");

  // Re-injection must not leave two watchers arguing over one page — nor two
  // RUNS. Replacing the listeners and the `state` object left any run already in
  // flight alive inside the old closure, still walking the list and still
  // pressing rows, and unstoppable from outside because Stop sets `aborted` on
  // the new state while the old loop reads its own. The worker re-injects on a
  // build-id mismatch and after a single ping timeout, so a busy page is enough.
  assert.match(source, /if \(previous\) \{\s*\n\s*previous\.aborted = true;/, "the previous copy's run must be retired");
  assert.match(source, /if \(previous\.run\) previous\.run\.stopRequested = true;/, "through the flags it already honours");
  assert.match(source, /if \(previous\.autoRun\) previous\.autoRun\.disabled = true;/, "and it must not restart itself either");
  assert.match(source, /if \(previous\?\.routeObserver\) previous\.routeObserver\.disconnect\(\);/);
  assert.match(source, /window\.removeEventListener\("popstate", previous\.navigationHandler\)/);
  assert.match(source, /if \(previous\?\.pageShowHandler\) window\.removeEventListener\("pageshow", previous\.pageShowHandler\)/);

  // And none of it costs a click: the restart replays the run, it invents no control.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7, "the click budget is unchanged");
});

test("coming back to the tab restarts the run, and the page says so", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // THE GAP. Every watcher on this page asks "did we ARRIVE somewhere new", and
  // `applicantsViewKey` is built so that opening a row does not count. A tab
  // switch changes no address at all, so that test could never fire for it —
  // while a run interrupted by the tab going hidden gives up for good once
  // VISIBILITY_WAIT_MS passes. Glance at another window for five minutes, come
  // back, and the surface has quietly decided the run was over. Reloading was
  // the only cure, because a reload re-injects this script with a fresh state.
  const visibility = source.slice(source.indexOf("state.visibilityHandler = "), source.indexOf('document.addEventListener("visibilitychange"'));
  assert.match(visibility, /else noteReturnToTab\(\);/, "returning to the tab must be watched for in its own right");

  const note = source.slice(source.indexOf("function noteReturnToTab"), source.indexOf("// ------------------------------------------------------------- messaging"));
  // The guard rails are the whole reason this stays inside "after a direct user
  // action" — it replays the recruiter's own instruction and invents nothing.
  assert.match(note, /if \(state\.running \|\| state\.extracting\) return;/,
    "a run already in flight continues in place, which is better than restarting it");
  assert.match(note, /if \(state\.autoRun\.disabled\) return;/, "a Stop is still final (rule 13a)");
  assert.match(note, /state\.autoRun\.pendingKey = key;/, "the return is RECORDED, then retried like any other arrival");

  // ...and a view already run to completion is NOT restarted again.
  //
  // THE LOOP THIS ENDS: the worker keeps a job armed for twelve hours and is
  // never told a run finished, and `state.running` is null the moment one does.
  // So the ordinary way of using this — press Collect Every Applicant, switch to
  // the Applicants page to watch the rows arrive, switch back — restarted the
  // whole 665-row walk from the first row, every glance, for twelve hours.
  assert.match(note, /if \(key === state\.autoRun\.ranKey\) return;/, "a completed view is not walked again");
  const start = source.slice(source.indexOf("async function startAutoRun"), source.indexOf("function pumpAutoRun"));
  assert.match(start, /if \(state\.run\?\.state === Applicants\.RUN_STATE\.COMPLETED\) \{\s*\n\s*state\.autoRun\.ranKey = key;/,
    "and it is remembered only for a run that genuinely finished");
  // The distinction is load-bearing: an INTERRUPTED run is exactly the one a
  // return to the tab should pick up, so STOPPED must not be remembered.
  assert.ok(!/RUN_STATE\.STOPPED\) state\.autoRun\.ranKey/.test(start), "an interrupted run stays restartable");
  assert.match(source, /state\.autoRun\.ranKey = "";/, "and a deliberate press clears it, so asking again always runs");

  // A tick that cannot try must not spend an attempt: the 800 ms poller beats
  // throughout the twenty seconds startAutoRun may spend waiting for the list,
  // and each of those returned at the `busy` guard having already burnt one.
  const pump = source.slice(source.indexOf("function pumpAutoRun"), source.indexOf("function checkAutoRunArrival"));
  assert.ok(
    pump.indexOf("state.autoRun.busy || !isPageVisible()") < pump.indexOf("AUTO_RUN_MAX_ATTEMPTS"),
    "the cannot-try bails must come before the budget check"
  );
  assert.match(note, /pumpAutoRun\(\);/, "and fulfilled by the same bounded, retryable step");
  // It records an arrival; it does not decide to run. `startAutoRun` still asks
  // the worker whether this job was armed by Collect Every Applicant.
  assert.ok(!/extractAllApplicants/.test(note), "it must not start a run behind the arming check");

  // The notice. A run resuming in silence is indistinguishable from a dead one,
  // which is what made pressing F5 look like the fix.
  assert.match(source, /function showPageNotice\(text\)/, "there must be an on-page notice");
  const notice = source.slice(source.indexOf("function showPageNotice"), source.indexOf("function hiddenPageError"));
  assert.match(notice, /pointer-events:none/, "it must never come between the recruiter and their own page");
  assert.match(notice, /setAttribute\("role", "status"\)/, "announced without stealing focus");
  assert.match(notice, /clearTimeout\(state\.noticeTimer\)/, "and it must take itself away again");
  assert.ok(!/\.click\(\)/.test(notice), "it is a banner, not a control");

  // Said only where work actually resumes — a banner over a surface that then
  // does nothing is worse than no banner.
  const restart = source.slice(source.indexOf("async function startAutoRun"), source.indexOf("function pumpAutoRun"));
  assert.match(restart, /showPageNotice\("Profile Vault resumed[\s\S]{0,80}"\);/, "the restart says so");
  assert.ok(
    restart.indexOf("verdict?.armed") < restart.indexOf("showPageNotice"),
    "and only after the job is known to be armed"
  );
  const run = source.slice(source.indexOf("async function extractAllApplicants"));
  assert.match(run, /const resumed = await waitForVisibleAgain\(\);[\s\S]{0,400}?showPageNotice\(/,
    "a run continuing after a hidden pause says so too");

  // Re-injection must not strand a banner with no timer left alive to remove it.
  assert.match(source, /if \(previous\?\.noticeTimer\) clearTimeout\(previous\.noticeTimer\);/);
  assert.match(source, /previous\.noticeElement\.remove\(\)/);

  // Still no new control.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7, "the click budget is unchanged");
});

test("the run collects every page of the applicant list, not only the first", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // Through 3.7.7 the walk scrolled and nothing else, so "the scroll container
  // reached its bottom and stopped growing" WAS "the list has ended" — and the
  // end of page one is indistinguishable from that. A job with more applicants
  // than fit on one page was collected one page deep and reported complete.
  const walk = source.slice(source.indexOf("async function loadEveryApplicantRow"), source.indexOf("function logListWalk"));
  assert.match(walk, /const pager = fruitless < MAX_FRUITLESS_PAGINATION/, "a settled page is not a settled list");
  assert.match(walk, /pager\.element\.click\(\);/, "the next page is asked for");
  assert.match(walk, /if \(!pager\) \{/, "and a list with no pager still ends");

  // Three bounds, each of which alone stops a run that never terminates.
  assert.match(walk, /fruitless = gained > 0 \? 0 : fruitless \+ 1;/,
    "growth counts NEW ROWS, never a click that happened");
  // NEW ROWS by identity. A pager that swaps page one's 25 people for page two's
  // 25 leaves the count untouched, so a count-based test scored a whole page of
  // progress as nothing, pressed the pager until it was retired, and returned
  // having walked past pages two, three and four in silence.
  assert.match(walk, /const gained = takeNewRows\(\);/, "and it asks who arrived, not how many rows there are");
  assert.match(source, /const MAX_FRUITLESS_PAGINATION = 3;/, "a pager revealing nothing is retired");
  assert.match(walk, /passes < LIST_MAX_PASSES/, "and the whole walk is capped");

  // The policy decides which element that is, and the denylist is consulted first.
  const finder = source.slice(source.indexOf("function findApplicantPaginationControl"), source.indexOf("/**\n   * Every row, across every page."));
  assert.match(finder, /purpose: Applicants\.CONTROL_PURPOSE\.PAGINATION/, "gated like every other control");
  assert.match(finder, /inContainer: scope\.contains\(element\)/, "and proven inside the list, not assumed");
  assert.match(finder, /if \(element\.disabled \|\| element\.getAttribute\("aria-disabled"\) === "true"\) continue;/,
    "a disabled pager is the last page — clicking it forever is how a walk stops terminating");

  const core = await readFile(resolve(root, "src/applicants-core.js"), "utf8");
  const policy = core.slice(core.indexOf("function classifyApplicantControl"), core.indexOf("return refuse(\"unknown-purpose\")"));
  // Still an allowlist by name; since 3.7.9 the label has its chevron glyphs
  // stripped first, because the live pager renders `Next ›` and the anchor is on
  // the whole label. Stripping rather than widening the pattern keeps the anchor
  // meaningful — `Next: Message` still fails it.
  assert.match(policy, /if \(!APPLICANT_PAGINATION_PATTERN\.test\(paginationLabel\(label\)\)\) return refuse\("not-a-pagination-control"\)/,
    "an allowlist, by name, on the de-glyphed label");
  assert.match(policy, /purpose === CONTROL_PURPOSE\.PAGINATION[\s\S]{0,400}?if \(!inContainer\) return refuse\("outside-applicant-list"\)/,
    "and the container proof is mandatory");
  // The denylist still wins: it is tested before any purpose branch.
  assert.ok(
    policy.indexOf("FORBIDDEN_APPLICANT_CONTROL_PATTERN") < policy.indexOf("CONTROL_PURPOSE.PAGINATION"),
    "the denylist is consulted before pagination, as before every other purpose"
  );

  // And the walk says what it did, so "why only 25?" is answerable from the page.
  assert.match(source, /applicant list — \$\{walk\.rows\} row\(s\) across \$\{walk\.pages\} page\(s\)/);
});

/**
 * PERMANENT. Requested outright: "when it opens the resume I need the extension
 * to click download and save the resume to disk and save that link as the resume
 * link — and make sure to never remove this feature in future."
 *
 * Every link of that chain is asserted here, so removing ANY of them fails the
 * build rather than quietly reverting the behaviour: open the viewer, press the
 * viewer's own Download control, resolve the address that produces to a real
 * document, record it as the resume link, and save the file through the worker.
 * Rule 9i names the control; this is what stops the code drifting away from it.
 *
 * Do not delete or weaken this test. If the feature must genuinely change, the
 * rule in CLAUDE.md changes first, in its own task, and this test changes with it.
 */
test("PERMANENT: the opened resume is downloaded by pressing Download, and its link is kept", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const core = await readFile(resolve(root, "src/applicants-core.js"), "utf8");

  // 1. The control exists as a named, gated step — not an inline click.
  const press = source.slice(source.indexOf("async function clickResumeDownload"), source.indexOf("* Prove a candidate address is the DOCUMENT"));
  assert.ok(press, "clickResumeDownload must exist");
  assert.match(press, /findControl\(viewer, Applicants\.CONTROL_PURPOSE\.RESUME_DOWNLOAD\)/,
    "the control is chosen by the tested policy, never by a local selector");
  assert.match(press, /control\.element\.click\(\);/, "and it is actually pressed");
  assert.match(press, /diagnostics\.resume\.downloadClicked = true;/, "and says so, so a silent no-op is visible");

  // 2. The policy still gates it: whole-label allowlist, proven inside the
  //    viewer, denylist first. A wider match here would press something else.
  const policy = core.slice(core.indexOf("function classifyApplicantControl"), core.indexOf('return refuse("unknown-purpose")'));
  assert.match(policy, /if \(!RESUME_DOWNLOAD_CONTROL_PATTERN\.test\(label\)\) return refuse\("not-a-download-control"\)/);
  assert.match(policy, /purpose === CONTROL_PURPOSE\.RESUME_DOWNLOAD[\s\S]{0,500}?if \(!inContainer\) return refuse\("outside-resume-viewer"\)/,
    "proven inside the viewer this extension opened, exactly as pagination is proven inside the list");
  assert.ok(
    policy.indexOf("FORBIDDEN_APPLICANT_CONTROL_PATTERN") < policy.indexOf("CONTROL_PURPOSE.RESUME_DOWNLOAD"),
    "the denylist is still consulted first, so Save and ATS actions stay refused"
  );
  assert.equal(Applicants.classifyApplicantControl({
    text: "Download", purpose: Applicants.CONTROL_PURPOSE.RESUME_DOWNLOAD, inContainer: true
  }).allowed, true, "the viewer's own Download is allowed");
  assert.equal(Applicants.classifyApplicantControl({
    text: "Download", purpose: Applicants.CONTROL_PURPOSE.RESUME_DOWNLOAD, inContainer: false
  }).allowed, false, "a Download outside the viewer is not");
  assert.equal(Applicants.classifyApplicantControl({
    text: "Save", purpose: Applicants.CONTROL_PURPOSE.RESUME_DOWNLOAD, inContainer: true
  }).allowed, false, "Save remains forbidden");

  // 3. It is pressed when the resume is opened, and BEFORE the document address
  //    is looked for — pressing it is what makes the page resolve its own
  //    descriptor and request the real file, which is what puts that address in
  //    the entry log at all.
  const step = source.slice(source.indexOf("async function collectResume"), source.indexOf("// ------------------------------------------------------------- the scan"));
  assert.match(step, /await clickResumeDownload\(overlay, diagnostics\);/, "the opened viewer's Download is pressed");
  assert.ok(
    step.indexOf("await clickResumeDownload(") < step.indexOf("label: \"resume-document\""),
    "and pressed before the document address is waited for"
  );

  // 4. The address is proven to be a document, then kept as the resume link —
  //    before the download, so a failed download still leaves a usable link.
  assert.match(step, /url = await resolveResumeDocumentUrl\(url, diagnostics\)/,
    "a descriptor is resolved to the file it names, never saved as the CV");
  assert.match(step, /accumulator\.setResume\(\{[\s\S]{0,320}?url,[\s\S]{0,320}?downloadStatus: Applicants\.RESUME_STATUS\.LINK_ONLY/,
    "the verified link is recorded as the resume link");
  assert.ok(
    step.indexOf("linkSavedBeforeDownload = true") < step.indexOf("sendRuntimeMessageWithTimeout(request)"),
    "the link is kept before the file is attempted"
  );

  // 5. The file is saved to disk by the worker, and the final record carries the
  //    link, the saved copy and the outcome together.
  assert.match(step, /type: "PV_APPLICANT_DOWNLOAD_RESUME"/, "the worker owns chrome.downloads");
  assert.match(step, /accumulator\.setResume\(\{[\s\S]{0,600}?localReference: result\?\.localReference \|\| null,\s*\n\s*downloadStatus: status/,
    "the saved file and its status land on the record with the link");
});

/**
 * PERMANENT. Requested outright: "I want to download the resume without opening
 * the resume — both link and download on disk."
 *
 * The viewer is a fallback, never the first move. When the document's address is
 * already available — on the resume control's own `href`, or rendered anywhere on
 * the page — the file is fetched and the link recorded with **nothing opened and
 * nothing clicked**. Opening only happens when the page names no document address
 * at all, which on this surface means LinkedIn gave a route and the address does
 * not exist anywhere until its own viewer resolves it.
 *
 * Do not delete or weaken this test, and do not let the click escape the `!url`
 * guard: that guard IS the feature.
 */
test("PERMANENT: the resume is downloaded without opening it whenever the address is already known", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const step = source.slice(source.indexOf("async function collectResume"), source.indexOf("// ------------------------------------------------------------- the scan"));

  // The address is looked for BEFORE anything is opened: the control's own href
  // when it really is a document, then the whole page.
  assert.match(step, /const linkedUrl = Applicants\.isResumeDocumentUrl\(controlHref\) \? controlHref : "";/,
    "the control's own href counts only when it is a document, never a route");
  assert.match(step, /const rendered = linkedUrl \|\| findResumeDocumentUrl\(null\);/,
    "and the page is swept for the address before any click");
  assert.match(step, /diagnostics\.resume\.foundWithoutOpening = Boolean\(rendered\);/,
    "and the surface records that it did not need to open anything");
  assert.match(step, /let url = rendered;/, "the found address is the one the rest of the step uses");

  // THE GUARD. Opening is inside `if (!url)`, so an address that was already
  // known means the viewer is never opened and the resume control never clicked.
  //
  // Proven by SLICING the guarded block rather than by how few characters
  // separate the guard from the click, which is what this asserted until 3.7.12.
  // A distance is a proxy for "nothing intervenes" and it fails the wrong way:
  // adding a comment or a statement inside the block — where it is safe — breaks
  // it, while a click moved just outside the block, where it is not, would still
  // sit within the distance. This asks the question the rule actually makes.
  const guardedOpen = step.slice(step.indexOf("if (!url) {"), step.indexOf("// However the address was found"));
  assert.ok(guardedOpen.length > 200, "the guarded block must be findable");
  assert.match(guardedOpen, /control\.element\.click\(\);/,
    "the resume is opened ONLY when no address was found");
  assert.ok(!/control\.element\.click\(\);/.test(step.replace(guardedOpen, "")),
    "and there is no path outside that guard which opens it");
  assert.ok(
    step.indexOf("const rendered =") < step.indexOf("control.element.click()"),
    "the address is looked for before the control is ever pressed"
  );
  assert.equal((step.match(/\.click\(\)/g) || []).length, 1,
    "exactly one click in this step, and it is the guarded fallback open");

  // Both halves still happen on the no-open path, because they live after the
  // guarded block: the address is proven, kept as the link, and saved to disk.
  assert.ok(
    step.indexOf("url = await resolveResumeDocumentUrl(url, diagnostics)") > step.indexOf("if (!url) {"),
    "the descriptor resolve is outside the open-only block, so it runs either way"
  );
  assert.ok(
    step.indexOf('type: "PV_APPLICANT_DOWNLOAD_RESUME"') > step.indexOf("if (!url) {"),
    "and so is the download, so not opening never means not saving"
  );
});

/**
 * PERMANENT. The required flow, stated by the user:
 *
 *   click applicant in left list -> wait for right panel -> scroll right panel
 *   completely -> extract -> save -> click next applicant
 *
 * with the page and the left list mounted throughout, only the right panel
 * updating, only the right column scrolling, and never a second click while a
 * profile is still loading.
 */
test("PERMANENT: one click per applicant, wait for the right panel, scroll only that column", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // 1. The page is never navigated or reloaded: the run changes applicants by
  //    clicking, and LinkedIn swaps the right panel underneath.
  assert.ok(!/location\.(?:reload|assign|replace)\s*\(/.test(source), "the applicants page is never reloaded");
  assert.ok(!/location\.href\s*=[^=]/.test(source), "and never navigated away from");

  // 2. Applicants change by clicking a row of the left list, gated and proven
  //    inside that list — never by building an address.
  const select = source.slice(source.indexOf("async function selectApplicantRow"), source.indexOf("* Scroll the applicant list until it stops producing new rows"));
  assert.match(select, /purpose: Applicants\.CONTROL_PURPOSE\.APPLICANT_ROW/, "the row is a gated control");
  assert.match(select, /inContainer: Boolean\(list && list\.contains\(row\.control\)\)/, "proven inside the left list");
  assert.equal((select.match(/\.click\(\)/g) || []).length, 1, "and clicked exactly once per applicant");

  // 3 + 5. After the click it WAITS for the right panel to become a different
  //    applicant, then lets it finish mounting. No second click can happen while
  //    a profile is still loading, because the caller only advances on the
  //    resolved value.
  // Amended in 3.7.10 with rule 9g, which this locks: "wait for the right panel"
  // is unchanged and is the permanent clause — what changed is that a text
  // fingerprint was never a way to tell whether the right panel was there, since
  // the teardown alone satisfied it.
  assert.match(select, /const before = panelIdentity\(heldPanel\);[\s\S]{0,120}?click\(\)/,
    "the panel's identity is taken before the click");
  assert.ok(!/panelIdentity\(\) !== before/.test(select),
    "and 'the fingerprint differs' must not come back: a teardown satisfies it");
  assert.match(select, /const arrival = await waitFor\(\(\) => \{[\s\S]{0,300}?describeApplicantArrival\(expected, before\)/,
    "the click is followed by waiting for THIS applicant to be mounted");
  assert.match(select, /await waitForDomQuiet\(PANEL_SETTLE_QUIET_MS, PANEL_SETTLE_TIMEOUT_MS\);\s*\n\s*const settled = describeApplicantArrival\(expected, before\);/,
    "then the panel is allowed to finish mounting, and is asked again");

  // Amended again in 3.7.11, and the permanent clause is untouched: the wait is
  // still every bit of "wait for the right panel". What changed is what an
  // UNANSWERABLE wait means. `Boolean(arrival) && settled.arrived` treated the
  // two "I could not tell" verdicts — `torn-down` from a panel this cannot
  // resolve, `mounting` from one whose headings it cannot see — as proof the
  // applicant was not there, and skipped them. The run then opened nobody after
  // the first and scrolled nothing. Only a panel positively showing SOMEBODY
  // ELSE refuses the row now; "never scanned as somebody else" is enforced where
  // it belongs, on the record, by a guard that checks three times.
  assert.match(select, /settled\.state === Applicants\.PANEL_ARRIVAL\.OTHER/, "a third party refuses the row");
  assert.match(select, /settled\.state === Applicants\.PANEL_ARRIVAL\.PREVIOUS/, "and so does the previous applicant");
  assert.ok(!/Boolean\(arrival\) && settled\.arrived/.test(withoutComments(select)),
    "but an unconfirmed arrival must never be what throws a person away");
  assert.match(source, /function assertExpectedApplicant\(expected\)/,
    "because the record - not the click - is what refuses the wrong applicant");

  // The caller does not re-click an applicant already shown, and a row that
  // would not come up is never scanned as whoever the panel is still showing.
  // One per-row path since 3.7.13, so this is `collectVisibleApplicant` — the
  // permanent clause is untouched, only where it lives.
  const open = source.slice(source.indexOf("async function collectVisibleApplicant"), source.indexOf("async function extractAllApplicants"));
  assert.match(open, /if \(!\(await panelAlreadyShowing\(rowId\)\)\) \{/,
    "an applicant already open is not clicked again — and 'already open' is the panel's answer, never the URL's");
  assert.match(open, /if \(!\(await selectApplicantRow\(row\)\)\) return \{ opened: false, record: null \};/,
    "a row that would not open returns, never scanned as them");
  assert.equal((open.match(/selectApplicantRow/g) || []).length, 1,
    "and exactly one row click per applicant");

  // 4. Scrolling moves a column, never the recruiter's page.
  assert.match(source, /function anchorPage\(run\)/, "there is one helper that holds the page still");
  assert.match(source, /anchorPage\(\(\) => step\.element\.scrollIntoView\(/,
    "the detail-panel reveal scrolls inside the page anchor");
  assert.match(source, /anchorPage\(\(\) => last\.scrollIntoView\(/,
    "and so does growing the left list");
  const scrollCalls = source.split("\n").filter((line) => /\.scrollIntoView\(\{/.test(line));
  assert.equal(scrollCalls.length, 2, "exactly two columns are scrolled: the detail panel and the list");
  for (const line of scrollCalls) {
    assert.match(line, /anchorPage\(\(\) =>/,
      `every scrollIntoView must be inside the page anchor, or it moves the whole page: ${line.trim()}`);
  }

  // And progress is measured against the panel, so holding the page still cannot
  // be mistaken for a column that refused to scroll.
  assert.match(source, /const offsetInPanel = \(\) => \{[\s\S]{0,220}?rect\.top - frame\.top/,
    "movement is measured relative to the panel, not the viewport");

  // 6. The order: the scan completes before the record is built and saved.
  const extract = source.slice(source.indexOf("async function extractApplicant"));
  assert.ok(
    extract.indexOf("scanApplicantPanel") < extract.indexOf("buildApplicantRecord"),
    "the panel is scrolled and read before the record is built"
  );
});

/**
 * PERMANENT. Requested outright: "keep going once I start, as long as I am on
 * that tab, even if the page reloads."
 *
 * That is only possible if a run never claims a completion it has not earned.
 * `claimAutoRun` refuses to re-arm a job whose execution reported COMPLETED — on
 * purpose, so a finished job is not walked forever — so a false completion does
 * not merely stop the run, it permanently disables the reload-resume.
 */
test("PERMANENT: only a walk that reached the list end may complete a run", async () => {
  const { isConclusiveListStop, LIST_STOP_CONCLUSIVE, RUN_STATE, AUTO_RUN_STATE, claimAutoRun } = Applicants;

  // A verdict: the container reached its bottom, stayed quiet, and had no working pager.
  assert.equal(isConclusiveListStop("settled"), true);
  assert.equal(isConclusiveListStop("pagination-retired"), true);
  assert.deepEqual([...LIST_STOP_CONCLUSIVE], ["settled", "pagination-retired"]);

  // An excuse. Every one of these used to finish the run — and with it the job.
  for (const excuse of ["grow-budget", "no-list", "pagination-refused", "list-exhausted", "running", ""]) {
    assert.equal(isConclusiveListStop(excuse), false, `${excuse || "(empty)"} must not complete a run`);
  }

  // The consequence this protects, proven rather than asserted in prose: a
  // completed execution cannot be re-armed, an unfinished one can.
  const base = { runId: "r1", options: {}, tabId: 7, attempt: 1 };
  assert.equal(claimAutoRun({ ...base, state: AUTO_RUN_STATE.COMPLETED }, { tabId: 7 }).armed, false,
    "a completed job never restarts — which is why completion must be earned");
  assert.equal(claimAutoRun({ ...base, state: AUTO_RUN_STATE.INTERRUPTED }, { tabId: 7 }).armed, true,
    "an interrupted one does, which is what a reload picks up");

  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const loop = source.slice(source.indexOf("const processed = new Set();"), source.indexOf("// Retire EVERY already-saved row"));

  assert.match(loop, /if \(Applicants\.isConclusiveListStop\(stoppedBy\)\) \{\s*\n\s*state\.run\.state = Applicants\.RUN_STATE\.COMPLETED;/,
    "only a conclusive stop may complete the run");
  assert.match(loop, /inconclusive \+= 1;\s*\n\s*if \(inconclusive < MAX_INCONCLUSIVE_GROWTHS\) continue;/,
    "an inconclusive stop is retried, from the position the walk reached");
  assert.match(source, /const MAX_INCONCLUSIVE_GROWTHS = 3;/, "and the retry is bounded");
  assert.match(loop, /inconclusive = 0;/, "a growth that produced work starts the allowance over");
  assert.match(loop, /state\.run\.state = Applicants\.RUN_STATE\.STOPPED;/,
    "exhausting the retries stops the run, leaving it restartable");
  assert.match(loop, /The run is not complete/, "and says so, rather than reporting a finished list");

  // The verdict must describe the call that just ran, now that it is read twice.
  const grow = source.slice(source.indexOf("async function growApplicantList"), source.indexOf("function logListWalk"));
  assert.match(grow, /walk\.stoppedBy = "running";/, "each growth call clears the previous call's verdict");
  void RUN_STATE;
});

test("a Next pager is still the pager when its label carries a chevron", () => {
  const P = Applicants.CONTROL_PURPOSE.PAGINATION;
  const verdict = (text) => Applicants.classifyApplicantControl({ text, purpose: P, inContainer: true });

  // THE LIVE DEFECT, read off the recruiter's own screen: the pager on a
  // 665-applicant job renders `Next ›` and `textContent` includes the glyph.
  // The allowlist is anchored on the whole label, so `next ›` was refused and the
  // run never left page one — and because no pager was found the walk reported
  // `settled`, a CONCLUSIVE stop, so the job was marked COMPLETED at 25 of 665.
  for (const label of ["Next", "Next ›", "Next >", "Next →", "next  ❯", "Next page", "Show more", "Load more", "Page 2"]) {
    assert.equal(verdict(label).allowed, true, `${label} is the pager`);
  }

  // A control whose whole name IS the glyph is accepted too — but only because
  // every caller has proven it is inside the list, which is asserted next.
  for (const glyph of ["›", "❯", "»"]) {
    assert.equal(verdict(glyph).allowed, true, `${glyph} is a pager inside the list`);
    assert.equal(
      Applicants.classifyApplicantControl({ text: glyph, purpose: P, inContainer: false }).reason,
      "outside-applicant-list",
      "and is refused the moment that proof is missing"
    );
  }

  // Numbers stay refused: any numeric control in the list would otherwise
  // qualify. This was the deliberate half of the widening.
  for (const number of ["2", "3", "10"]) {
    assert.equal(verdict(number).allowed, false, `a bare ${number} is not a pager`);
  }

  // And stripping a glyph must not smuggle anything past the anchor or the
  // denylist — removing `›` from `Next: Message` leaves `next: message`.
  for (const forbidden of ["Next: Message", "Message · Next", "Next › Reject", "Save", "Shortlist"]) {
    const result = verdict(forbidden);
    assert.equal(result.allowed, false, `${forbidden} must never be pressed`);
  }
  assert.equal(verdict("Next: Message").forbidden, true, "the denylist is still consulted first");
});

test("the panel Download probe observes and never presses", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const probe = source.slice(source.indexOf("function probePanelDownloadControls"), source.indexOf("const DISMISS_SELECTOR"));

  // The safety property, and the whole reason this can exist without amending
  // rule 9: `inContainer: false` means the verdict can NEVER come back allowed,
  // so no path can press what the probe finds. It reports labels, not elements.
  assert.match(probe, /inContainer: false/, "the probe can never produce an allowed verdict");
  assert.match(probe, /verdict\.reason !== "outside-resume-viewer"/,
    "only a label the denylist and the allowlist both cleared is reported");
  assert.ok(!/\.click\(\)/.test(probe), "the probe must never press anything");
  assert.ok(!/return \{ element/.test(probe), "and must not hand an element back to be pressed");

  // The click budget is untouched: rule 9 governs controls that are pressed.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7, "still exactly seven clicks");

  // And what it found reaches the recruiter's console, which is the point.
  assert.match(source, /panelDownloadLabels: resume\.panelDownloadLabels \|\| \[\]/,
    "the finding is logged per applicant");

  // Only walked when the viewer would otherwise be opened — that is the case a
  // panel-level Download would remove, and the only case worth the DOM walk.
  const step = source.slice(source.indexOf("async function collectResume"));
  assert.match(step, /panelDownloadLabels = rendered \? \[\] : probePanelDownloadControls\(panel\)/,
    "no cost on the path that already downloads without opening");
});

test("a page that hides while the list grows pauses the run, it does not kill it", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const run = source.slice(source.indexOf("const processed = new Set();"), source.indexOf("// Retire EVERY already-saved row"));

  // THE DEFECT. `growApplicantList` calls `assertRunnable()` every pass, which
  // throws on a hidden page — and `state.wentHidden` stays latched until
  // `beginRun()`. Outside a try/catch that throw escaped the row loop and
  // `extractAllApplicants` entirely, so the run died and `noteReturnToTab`
  // restarted it from the first row. That is the "stops after N profiles and
  // starts over": N was however many rows were rendered before growth was first
  // needed, never a counter.
  // Every step that scrolls the list — settling the page the run has arrived at,
  // sweeping it for a row it still owes, and growing past it — shares the ONE
  // try/catch, because every one of them calls `assertRunnable()` per pass and so
  // every one of them can throw on a hidden page.
  const guarded = run.slice(run.indexOf("try {"), run.indexOf("} catch (error) {"));
  assert.match(guarded, /grown = await growApplicantList\(/,
    "growing the list must be inside the same pause handling the row work has");
  assert.match(guarded, /await sweepCurrentPage\(roster, listDiagnostics\);/,
    "and so must settling the page, which scrolls it end to end");
  assert.ok(!/await sweepCurrentPage\(/.test(run.slice(run.indexOf("} catch (error) {"))),
    "no list walk may sit outside the pause handling and kill the run");
  assert.match(run, /if \(!error\?\.hidden\) throw error;[\s\S]{0,400}?await waitForVisibleAgain\(\)/,
    "a hidden page during growth is a pause, exactly as it is during extraction");
  assert.match(run, /await waitForVisibleAgain\(\);[\s\S]{0,600}?beginRun\(\);\s*\n\s*continue;/,
    "and the run continues where it left off rather than unwinding");

  // A Stop is still a Stop, and a real error is still a real error.
  assert.match(run, /if \(error\?\.stopped\) \{\s*\n\s*state\.run\.state = Applicants\.RUN_STATE\.STOPPED;/,
    "Stop during growth still ends the run as an interruption");
  assert.ok(/if \(!error\?\.hidden\) throw error;/.test(run),
    "anything that is not a pause is still allowed to surface");
});

test("a tab switch cannot restart the same walk forever", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const note = source.slice(source.indexOf("function noteReturnToTab"), source.indexOf("// ------------------------------------------------------------- messaging"));

  // THE LOOP. `ranKey` is set only when a run reaches COMPLETED, so an
  // interrupted one — and the tab going hidden is what interrupts it, which is
  // exactly what a tab switch does — left every return restarting the whole walk
  // from the first row, only to be interrupted by the next switch away.
  assert.match(note, /if \(key === state\.autoRun\.ranKey\) return;/, "a completed view is still not restarted");
  assert.match(note, /state\.autoRun\.fruitlessReturns >= MAX_FRUITLESS_RETURNS/,
    "and an interrupted one is bounded too, or the common case is unbounded");
  assert.match(source, /const MAX_FRUITLESS_RETURNS = 2;/, "two, so one slow start does not lose the resume feature");

  // Scored by what it collected, never by the fact that it ran.
  const start = source.slice(source.indexOf("async function startAutoRun"), source.indexOf("function pumpAutoRun"));
  assert.match(start, /state\.autoRun\.fruitlessReturns = state\.run\?\.collected\s*\n?\s*\? 0\s*\n?\s*: state\.autoRun\.fruitlessReturns \+ 1;/,
    "a restart earns the next one by collecting somebody");
  assert.match(start, /if \(state\.run\?\.state === Applicants\.RUN_STATE\.COMPLETED\) \{[\s\S]{0,200}?ranKey = key;/,
    "an interrupted run still does not set ranKey — it is the one a return should pick up");

  // A real navigation is intent; a tab regaining focus is not. Only the former clears it.
  const arrival = source.slice(source.indexOf("function checkAutoRunArrival"), source.indexOf("function resumeAutoRun"));
  assert.match(arrival, /state\.autoRun\.fruitlessReturns = 0;/, "a genuine arrival clears the budget");

  // And pressing the button always runs, whatever this document quietened.
  const press = source.slice(source.indexOf('if (type === "PV_APPLICANT_EXTRACT_ALL")'), source.indexOf("state.running = runEveryApplicant(message.options"));
  assert.match(press, /state\.autoRun\.fruitlessReturns = 0;/, "a deliberate press re-arms the surface");
});

test("the resume link is saved first and downloading cannot stop the applicant run", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const step = source.slice(source.indexOf("async function collectResume"), source.indexOf("// ------------------------------------------------------------- the scan"));

  // The verified document link becomes part of the record before any worker
  // download is awaited. A timeout therefore loses only the local file, not the
  // applicant or the link needed to retry it.
  assert.match(step, /accumulator\.setResume\(\{[\s\S]{0,320}?url,[\s\S]{0,320}?downloadStatus: Applicants\.RESUME_STATUS\.LINK_ONLY/,
    "the verified resume link must be recorded before downloading");
  assert.match(step, /diagnostics\.resume\.linkSavedBeforeDownload = true/);
  assert.ok(
    step.indexOf("linkSavedBeforeDownload = true") < step.indexOf("sendRuntimeMessageWithTimeout(request)"),
    "saving the link must happen before the download request"
  );

  // The normal path uses chrome.downloads directly through the worker. It never
  // opens a document tab, so LinkedIn cannot mark the hiring page hidden and end
  // the row loop. The old tab cycle remains only as a compatibility handler.
  assert.match(step, /type: "PV_APPLICANT_DOWNLOAD_RESUME"/);
  assert.ok(!/PV_APPLICANT_OPEN_AND_SAVE_RESUME/.test(step), "the collector must not open a resume tab");
  assert.ok(!/resumeCycle/.test(source), "no visibility bypass is needed when no tab is opened");
  const download = worker.slice(worker.indexOf("async function downloadResume"), worker.indexOf("async function stopAllContentScripts"));
  assert.match(download, /chrome\.downloads\.download\(\{/);

  // Every potentially slow boundary is bounded. The PDF is not walked end to end
  // merely to obtain a link, and a sleeping worker cannot pin the applicant.
  assert.match(source, /const RESUME_VIEWER_TIMEOUT_MS = 4500/);
  assert.match(source, /const RESUME_DOCUMENT_TIMEOUT_MS = 4500/);
  assert.match(source, /const RESUME_MESSAGE_TIMEOUT_MS = 8000/);
  assert.match(source, /for \(; steps < 3; steps \+= 1\)/, "resume metadata scrolling is shallow");
  assert.match(source, /sendRuntimeMessageWithTimeout\(request\)/);
  assert.match(worker, /const RESUME_TAB_TIMEOUT_MS = 6000/, "the compatibility tab path is also bounded tightly");

  // A hidden page is still a pause for the profile scan itself, not an automatic
  // terminal stop, and the lifecycle token prevents a stale replacement loop.
  const loop = source.slice(source.indexOf("async function extractAllApplicants"));
  assert.match(loop, /const resumed = await waitForVisibleAgain\(\);/);
  assert.match(source, /async function runEveryApplicant\(options = \{\}, tracking = null\)/);
  assert.match(source, /PV_APPLICANT_RUN_LIFECYCLE/);
});

test("the popup closes itself once the whole-job command has actually started", async () => {
  const popup = await readFile(resolve(root, "src/react/popup.tsx"), "utf8");

  // The run happens on the hiring tab, which the worker has just activated and
  // focused. A popup left hanging over it is covering the one thing the
  // recruiter pressed the button to watch.
  assert.match(popup, /collectApplicantList = \(\) => this\.runApplicantJob\(\s*\{ listOnly: true \}/,
    "Collect Applicant List walks the whole job");
  assert.match(popup, /Collect Applicant List\s*<\/button>/, "and the popup offers it");
  const handler = popup.slice(popup.indexOf("runApplicantJob = async"), popup.indexOf("renderApplicantPanel()"));
  assert.match(handler, /if \(response\?\.started\) \{\s*\n\s*this\.closePopup\(\);/,
    "closed on the worker's own proof that the run started");
  assert.match(handler, /if \(response\?\.ok === false\) throw new Error/,
    "and a failure is raised before anything closes");
  const startedAt = handler.indexOf("response?.started");
  const closedAt = handler.indexOf("this.closePopup()");
  const sentAt = handler.indexOf("await chrome.runtime.sendMessage");
  assert.ok(sentAt >= 0 && sentAt < startedAt && startedAt < closedAt,
    "the reply is awaited first — a popup that closes before the command lands cannot report that it failed");

  // A window that vanishes on failure is a button that silently did nothing.
  assert.match(handler, /this\.setStatus\(error instanceof Error \? error\.message : String\(error\), "error"\)/,
    "an error keeps the popup open and shows it");
  assert.match(handler, /if \(!this\.closing\) \{/, "and nothing writes state into a closing document");

  // Only this command closes. Start Collecting and Collect This Applicant share
  // `runImport`, and neither of them may take the window away.
  const runImport = popup.slice(popup.indexOf("runImport = async"), popup.indexOf("startCollecting ="));
  assert.ok(!/closePopup|window\.close/.test(runImport), "the shared helper must never close the popup");
  assert.match(popup, /collectApplicant = \(\) => this\.runImport\(/, "collecting one applicant still uses the shared helper");

  assert.match(popup, /clearInterval\(this\.importTimer\);\s*\n\s*this\.importTimer = null;\s*\n\s*\}\s*\n\s*window\.close\(\);/,
    "the poller is cleared before the close, not after");

  // The full-page Applicants dashboard is a different component and must stay open.
  const page = await readFile(resolve(root, "src/react/applicants-dashboard.tsx"), "utf8");
  assert.ok(!/window\.close\(\)/.test(page), "the Job Applicants page is a page, not a popup");
});

test("the hiring surface is a content script entry scoped to LinkedIn hiring pages", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "extension/manifest.json"), "utf8"));
  const entry = manifest.content_scripts.find((script) => (script.js || []).includes("applicants.js"));
  assert.ok(entry, "a content script entry for applicants.js must exist");
  assert.deepEqual(entry.js, [
    "src/extraction-core.js",
    "src/connections-core.js",
    "src/applicants-core.js",
    "applicants.js"
  ], "the cores load before the adapter that reads them");
  for (const pattern of entry.matches) {
    assert.match(pattern, /^https:\/\/(?:www\.)?linkedin\.com\/(?:hiring|talent)\/\*$/, `${pattern} must target the hiring surface only`);
  }
  // No new *permission* was asked for: the surface runs on the existing
  // `downloads`, `scripting`, `storage`, `activeTab` and `alarms`.
  assert.deepEqual(manifest.permissions.slice().sort(), ["activeTab", "alarms", "downloads", "scripting", "storage"]);
  // The host list gained LinkedIn's own media CDN in 3.7.9 (rule 5) so the resume
  // document can be read from the page that rendered it. Still LinkedIn-owned,
  // still an exact list.
  assert.deepEqual(manifest.host_permissions.slice().sort(), [
    "https://linkedin.com/*",
    "https://media.licdn.com/*",
    "https://static.licdn.com/*",
    "https://www.linkedin.com/*"
  ]);
});

test("Collect Every Applicant is gone, and it took nothing else with it", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  const popup = await readFile(resolve(root, "src/react/popup.tsx"), "utf8");
  const page = await readFile(resolve(root, "src/react/applicants-dashboard.tsx"), "utf8");
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");

  // Requested outright: "remove Collect Every Applicant, its code and function
  // and feature ... that will not affect any other button or any other
  // feature." Both halves are asserted here, because the second is the hard one
  // — the command it stood beside rode the SAME message, the SAME walk and the
  // SAME pagination, differing only in a flag.

  // ------------------------------------------------------------------ gone
  // Judged on the rendered LABEL and on the handler, not on the phrase: the
  // comments that explain why it went name it on purpose, and a comment is not
  // a button.
  assert.ok(!/Collect Every Applicant\s*<\/button>/.test(popup), "the popup must not offer it");
  assert.ok(!/Collect Every Applicant\s*<\/button>/.test(page), "and neither must the Applicants page");
  assert.ok(!/collectEveryApplicant/.test(popup), "nor keep the handler that started it");
  assert.ok(!/collectAll = \(\) =>/.test(page), "nor the page's own handler");
  // The second per-row path it was the only caller of. `extractApplicant` is
  // reached through `collectVisibleApplicant` and through PV_APPLICANT_EXTRACT,
  // and no longer by a branch spreading the run's raw options over it.
  assert.ok(!/await extractApplicant\(\{ \.\.\.options, expectApplicationId: rowId \}\)/.test(source),
    "the branch that called the extraction directly must be gone");
  assert.ok(!/if \(options\.listOnly === true\) \{/.test(source),
    "and with it the flag that chose between two paths");
  assert.ok(!/if \(collected\.has\(\{ applicationId: rowId, name: row\.name \}\)\)/.test(source),
    "including its own already-collected check, which the bulk retirement above already makes");

  // ------------------------------------------------- and nothing else moved
  // Collect This Applicant is a different message and a different entry point.
  assert.match(popup, /collectApplicant = \(\) => this\.runImport\(/, "Collect This Applicant must survive");
  assert.match(page, /collectCurrent = \(\) => this\.command\(/, "on both surfaces");
  assert.match(source, /if \(type === "PV_APPLICANT_EXTRACT"\) \{/, "and still reach the extraction");
  assert.match(source, /state\.extracting = extractApplicant\(message\.options \|\| \{\}\)/, "unchanged");

  // The whole-job command, its message, and everything the walk is made of.
  assert.match(popup, /Collect Applicant List/, "the whole-job command must survive");
  assert.match(page, /Collect Applicant List/);
  assert.match(source, /if \(type === "PV_APPLICANT_EXTRACT_ALL"\) \{/, "its content-script entry point");
  assert.match(worker, /if \(type === APPLICANT_MESSAGES\.COLLECT_ALL\) \{/, "and the worker's, untouched");
  for (const kept of [
    "async function sweepCurrentPage",          // the page is settled before anybody is opened
    "createApplicantRoster",                    // the page's own order
    "async function growApplicantList",         // and how it grows
    "clickApplicantPager",                      // rule 9h, the pager's one call site
    "isConclusiveListStop",                     // only a real end may complete a run
    "async function selectApplicantRow",        // rule 9g
    "async function collectResume",             // the PERMANENT resume chain
    "async function openContactAndCollect",     // rule 9d
    "function continueInterruptedRun",          // a run that stops short asks for itself back
    "function pumpAutoRun",                     // and the reload-resume it goes through
    "async function loadCollectedIndex"         // a run resumes; it never starts over
  ]) {
    assert.ok(source.includes(kept), `${kept} is not part of the removed command and must stay`);
  }

  // `recollect` is a property of a RUN, not of the button it was first added
  // beside, so it moved to the command that survived rather than being deleted
  // with the one that did not. Unchecked it sends `false`, which is the walk's
  // own default — so the surviving button's behaviour is unchanged by default.
  assert.match(page, /Re-collect already saved/, "the re-collect control must survive");
  assert.match(page, /options: \{ listOnly: true, recollect: this\.state\.recollect \}/, "and still reach the run");
  assert.match(source, /options\.recollect === true/, "which the walk still honours");

  // The click budget is a count of CONTROLS (rule 9), and no control was
  // removed here — only a caller. Seven: six gated opens plus one shared
  // dismiss.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7,
    "applicants.js must still click exactly seven times");
});

// ------------------------------------------------- pacing the walk to the page
// Requested outright: "slightly faster + fully safe + no missed data ... replace
// fixed delays with adaptive timing ... accuracy > speed always."
//
// Every quiet window in the adapter is a guess about a page nobody measured, and
// it has to be a pessimistic one, so a fast machine pays a struggling machine's
// budget on every pass of every walk of every applicant. The page can be asked
// instead. What these assert is the half that keeps it safe: the bounds at BOTH
// ends, the ceiling that is never scaled, and the floors this must not touch.

test("the quiet window follows the page, within bounds it can never leave", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  const quiet = source.slice(source.indexOf("function quietWindow"), source.indexOf("function waitForDomQuiet"));
  assert.match(quiet, /TEMPO_SCALE\[tempo\.level\]/, "the window is scaled by the tempo the page earned");
  assert.match(quiet, /Math\.max\(floor, Math\.min\(scaled, Math\.round\(quietMs \* TEMPO_SCALE\.slow\)\)\)/,
    "and clamped at both ends, so no tempo can produce an unbounded window");
  assert.match(quiet, /const floor = Math\.min\(MIN_QUIET_MS, quietMs\)/,
    "the floor may never RAISE a window a caller deliberately made short");

  // A floor that can be tuned to nothing is not a floor.
  const minQuiet = Number(/const MIN_QUIET_MS = (\d+);/.exec(source)[1]);
  assert.ok(minQuiet >= 120, `the quiet floor must stay meaningful (found ${minQuiet}ms)`);

  const scale = /const TEMPO_SCALE = Object\.freeze\(\{ fast: ([\d.]+), medium: (\d+), slow: ([\d.]+) \}\)/.exec(source);
  assert.ok(scale, "the three tempos must be named and fixed");
  assert.ok(Number(scale[1]) >= 0.5, `fast must stay a trim, not a gut (found ${scale[1]})`);
  assert.equal(Number(scale[2]), 1, "medium must be exactly the window the source asked for");
  assert.ok(Number(scale[3]) > 1, "and an unsettled page must be given MORE time, not less");

  // The ceiling is the caller's and is never scaled: `timeoutMs` is what stops a
  // page that never settles from holding one applicant, and a tempo that could
  // stretch it would turn a struggling page into a stuck run.
  const domQuiet = source.slice(source.indexOf("function waitForDomQuiet"), source.indexOf("// ---------------------------------------------------------------- the DOM"));
  assert.match(domQuiet, /setTimeout\(\(\) => finish\("unsettled"\), timeoutMs\)/, "the timeout is used exactly as given");
  assert.ok(!/timeoutMs \*/.test(domQuiet), "the caller's ceiling must never be scaled");

  // Only a wait that observed NOTHING may speed the page up. A window that ended
  // after mutations is evidence against slowing down, never evidence for haste.
  assert.match(domQuiet, /finish\(mutated \? "busy" : "still"\)/, "a mutation seen during the window forfeits 'still'");
  const record = source.slice(source.indexOf("function recordTempo"), source.indexOf("function tempoSnapshot"));
  assert.match(record, /if \(tempo\.samples\.includes\("unsettled"\)\) tempo\.level = TEMPO\.SLOW/,
    "one unsettled wait is enough to slow down");
  assert.match(record, /every\(\(entry\) => entry === "still"\)/, "but every sample must agree before it speeds up");

  // A page-condition verdict is never carried across runs — the same rule
  // `wentHidden` is re-derived under, and for the same reason.
  const begin = source.slice(source.indexOf("function beginRun"), source.indexOf("function wait(ms)"));
  assert.match(begin, /resetTempo\(\)/, "a new run must not inherit the last one's verdict about the page");
});

test("adapting the pace changes what a wait costs, never what a walk concludes", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // The floors that decide whether enough of an applicant was READ are untouched
  // by any of this. A shorter window can only take a read a moment early, and an
  // early read costs nothing here — the accumulator is merge-only and every walk
  // re-reads on every pass — but ENDING a walk early would lose sections, so the
  // rules that end one stay exactly as they were.
  assert.match(source, /const REVEAL_MIN_PASSES = 4;/, "the four-pass floor is a correctness floor, not a timing one");
  assert.match(source, /const REVEAL_QUIET_PASSES = 3;/, "and a walk still needs three quiet passes to settle");
  assert.match(source, /if \(reachedTail && quiet >= REVEAL_QUIET_PASSES && record\.passes >= REVEAL_MIN_PASSES\)/,
    "with the bottom reached as well — the tempo has no say in any of it");

  // Polling is how LATE a true condition is noticed, never a wait for anything.
  // Starting short and backing off to the caller's own interval can only see an
  // arrival sooner; the predicate and the timeout are untouched.
  const waiter = source.slice(source.indexOf("async function waitFor"), source.indexOf("* How settled this page has been"));
  assert.match(waiter, /let interval = Math\.min\(FAST_POLL_MS, pollMs\)/, "polling starts short");
  assert.match(waiter, /interval = Math\.min\(pollMs, Math\.round\(interval \* POLL_BACKOFF\)\)/,
    "and backs off to the caller's own interval, so a long wait does not spin");
  assert.match(waiter, /await wait\(Math\.min\(interval, remaining\)\)/, "and never polls past the deadline");
  assert.ok(!/timeoutMs \*/.test(waiter), "the caller's timeout is used exactly as given");

  // The breath between applicants. The medium band still averages the anchor, so
  // a normally-loading page paces as it always did; the slow band is LONGER than
  // the fixed value, because that is a page under strain.
  const anchor = Number(/const LIST_PROFILE_PACE_MS = (\d+);/.exec(source)[1]);
  const bounds = /const PACE_BOUNDS = Object\.freeze\(\{\s*fast: \[(\d+), (\d+)\],\s*medium: \[(\d+), (\d+)\],\s*slow: \[(\d+), (\d+)\]\s*\}\)/.exec(source);
  assert.ok(bounds, "the three bands must be named and fixed");
  const [fastLow, fastHigh, mediumLow, mediumHigh, slowLow, slowHigh] = bounds.slice(1).map(Number);
  assert.ok(fastLow >= 400, `even the fast band must stay a real breath (found ${fastLow}ms)`);
  assert.ok(fastLow < fastHigh && mediumLow < mediumHigh && slowLow < slowHigh, "each band must be a range");
  const mediumAverage = (mediumLow + mediumHigh) / 2;
  assert.ok(mediumAverage >= anchor * 0.9 && mediumAverage <= anchor * 1.1,
    "a normally-loading page must still pace at the anchor it always did");
  assert.ok(slowHigh > anchor, "and a page that will not settle must be given longer than the fixed value, not shorter");
  assert.ok(fastHigh <= mediumHigh && mediumHigh <= slowHigh, "the bands must not cross");

  // Randomised within the band: a run that pauses for exactly the same interval
  // between hundreds of panels is the one shape a human session never has.
  assert.match(source, /Math\.round\(low \+ Math\.random\(\) \* \(high - low\)\)/, "the breath is never the same length twice");

  // Every call site takes the same breath — there is one pacing rule, not three.
  assert.ok(!/await wait\(LIST_PROFILE_PACE_MS\)/.test(source), "no call site may pace itself");
  assert.equal((source.match(/await paceBetweenApplicants\(\)/g) || []).length, 3,
    "the two retry paths and the completed row all pace through the one helper");

  // And the run says which tempo it was held at, because "the run was slow" and
  // "the page never settled" are the same sentence from two ends.
  assert.match(source, /listDiagnostics\.listScroll\.tempo = tempoSnapshot\(\)/, "the walk reports its own tempo");
});

// A resume costs the applicant it belongs to, and nobody else. The tempo asks
// "is this page keeping up" and answers it from whether the DOM went quiet —
// an inference that only holds while the mutations are the page's own hydration.
// A document viewer repaints its pages for as long as it is open, so a wait held
// over one can never observe a quiet window and always ends on `timeoutMs`,
// reporting "unsettled". `recordTempo` is asymmetric by design: ONE such sample
// pins the run to SLOW, and every applicant after it pays a 1.25x window and the
// slow pace band. So opening a single resume made the rest of the job slower, on
// evidence about a PDF renderer rather than about the page.
test("a repainting viewer cannot testify about the page, and one resume cannot slow the rest of the run", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");

  // 1. The opt-out exists, defaults to ON, and withholds only the VERDICT.
  const domQuiet = source.slice(source.indexOf("function waitForDomQuiet"), source.indexOf("// ---------------------------------------------------------------- the DOM"));
  assert.match(domQuiet, /function waitForDomQuiet\(quietMs = 300, timeoutMs = 2500, \{ sample = true \} = \{\}\)/,
    "sampling is opt-OUT, so a new wait testifies unless it is deliberately excused");
  assert.match(domQuiet, /if \(sample\) recordTempo\(verdict\);/, "and only the tempo reading is withheld");
  // The wait itself is unchanged: same window, same ceiling, same condition. An
  // excused wait that also resolved differently would be a second behaviour
  // hiding behind a diagnostics flag.
  assert.match(domQuiet, /const window_ = quietWindow\(quietMs\)/, "an excused wait is still a real window");
  assert.match(domQuiet, /setTimeout\(\(\) => finish\("unsettled"\), timeoutMs\)/, "and still ends on the caller's own ceiling");
  assert.ok(!/timeoutMs \*/.test(domQuiet), "which is never scaled, excused or not");

  // 2. The viewer walk is the one excused, and it is excused where it is held
  //    over the viewer — not globally.
  const viewerWalk = source.slice(source.indexOf("async function scrollResumeViewer"), source.indexOf("* Locate, record and — when permitted — save"));
  assert.match(viewerWalk, /await waitForDomQuiet\(120, 500, \{ sample: false \}\)/,
    "the wait held over the document viewer must not report on the page");

  // 3. Excused waits stay RARE. The tempo is only worth having while almost every
  //    wait feeds it, so this must never become the way to make the run faster.
  const excused = (source.match(/sample: false/g) || []).length;
  assert.ok(excused <= 2, `only a wait held over a continuously repainting element may be excused (found ${excused})`);

  // 4. The fixed sleep after pressing Download is gone. It sat in FRONT of a poll
  //    that catches the same event — `waitFor` over RESUME_DOCUMENT_TIMEOUT_MS,
  //    with `watchResumeRequests()`'s observer live since before the open — so it
  //    could only ever make the answer arrive later than the poll would notice it.
  //    And held over the viewer it was itself a guaranteed "unsettled" sample.
  const press = source.slice(source.indexOf("async function clickResumeDownload"), source.indexOf("* Prove a candidate address is the DOCUMENT"));
  assert.ok(!/await waitForDomQuiet\(/.test(press),
    "pressing Download must not sleep in front of the poll that reads the result");
  // The chain rule 9i marks PERMANENT is untouched: the control is still pressed.
  assert.match(press, /control\.element\.click\(\);/, "the control is still pressed");
  assert.match(press, /diagnostics\.resume\.downloadClicked = true;/, "and still says so");

  // 5. The dismiss polls instead of sleeping — but never through `waitFor`, which
  //    calls `assertRunnable()` and would throw a Stop straight out of a dismiss,
  //    leaving the preview on screen. That is the complaint it exists to answer.
  const dismiss = source.slice(source.indexOf("async function closeOpenedOverlay"), source.indexOf("/** The disclosure LinkedIn mounted"));
  assert.ok(!/waitFor\(/.test(dismiss), "a dismiss must run on the failure path, so it never asserts runnability");
  assert.ok(!/await wait\(250\)/.test(dismiss), "and must not pay the worst case on every applicant");
  assert.match(dismiss, /for \(let waited = 0; waited < DISMISS_CONFIRM_MS; waited \+= DISMISS_POLL_MS\)/,
    "it polls for the close it already tests for");
  const confirm = Number(/const DISMISS_CONFIRM_MS = (\d+);/.exec(source)[1]);
  assert.ok(confirm >= 250, `a modal must still get the time the flat sleep gave it (found ${confirm}ms)`);
  // Still exactly one click: a dismiss is the shared close, never a new control.
  assert.equal((dismiss.match(/\.click\(\)/g) || []).length, 1, "and is still one click, retried");
});

test("reading back where Chrome put the file is answered sooner, never given less time", async () => {
  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");

  const path = worker.slice(worker.indexOf("async function downloadedFilePath"), worker.indexOf("async function downloadResume"));
  assert.match(path, /setTimeout\(resolve, delayMs\)/, "the poll interval must grow rather than stay flat");
  assert.match(path, /delayMs = Math\.min\(DOWNLOAD_POLL_MAX_MS, Math\.round\(delayMs \* DOWNLOAD_POLL_BACKOFF\)\)/,
    "backed off to a ceiling, so a slow download does not spin");

  const start = Number(/const DOWNLOAD_POLL_START_MS = (\d+);/.exec(worker)[1]);
  const backoff = Number(/const DOWNLOAD_POLL_BACKOFF = ([\d.]+);/.exec(worker)[1]);
  const max = Number(/const DOWNLOAD_POLL_MAX_MS = (\d+);/.exec(worker)[1]);
  assert.ok(start < 120, `the first look must be sooner than the flat poll it replaces (found ${start}ms)`);
  assert.ok(backoff > 1, "and the interval must actually back off");

  // THE PROPERTY THAT MATTERS: this is a latency change, not a budget cut. The
  // ten intervals must still sum to at least what the flat 120ms poll spent, or a
  // genuinely slow download would fall back to the REQUESTED path more often —
  // and `resume_file` would name a file that is not on disk.
  let delay = start;
  let total = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    total += delay;
    delay = Math.min(max, Math.round(delay * backoff));
  }
  assert.ok(total >= 10 * 120,
    `a slow download must get at least the budget it had (found ${total}ms against 1200ms)`);

  // And an interrupted download is still reported as one, never as a saved file.
  assert.match(path, /if \(item && item\.state === "interrupted"\) \{\s*\n\s*return \{ path: "", interrupted: true/,
    "an interrupted download must still report itself as one");
});

// ------ Phase 1 of the multiple-LinkedIn-UI support guide: the tripwires
//
// `docs/multiple-linkedin-dom-ui-support-guide.md` asks, before any layout work
// begins, that what already works be *protected* — "create focused fixtures or
// tests for the current layout so future UI support cannot silently break it".
//
// These eleven do exactly that and nothing else: no production line changed in
// this phase. They are deliberately source-level, because the readers they
// guard live in the DOM adapter where there is no jsdom to run them (CLAUDE.md,
// "Things that will bite you"). Each one names the later phase it guards, so a
// failure says which change broke which promise rather than only that something
// moved.
//
// The two that matter most are #7 and #10/#11. A `.click()` COUNT cannot see a
// click that moves house — the same seven calls redistributed across different
// functions would pass every existing budget assertion while pressing something
// new — so #7 pins the OWNER of each one. #10 and #11 are the schema and rule-19
// tripwires for all twelve phases: they are what makes "the applicant record and
// the CSV did not change" a fact rather than a claim.

/** Every top-level function in the adapter, with where it starts. */
function adapterFunctions(source) {
  return [...source.matchAll(/^ {2}(?:async )?function ([A-Za-z0-9_]+)\(/gm)]
    .map((match) => ({ name: match[1], at: match.index }));
}

/** Which of them encloses this offset — the nearest declaration above it. */
function ownerOf(declarations, offset) {
  let owner = "";
  for (const declaration of declarations) {
    if (declaration.at < offset) owner = declaration.name;
    else break;
  }
  return owner;
}

test("Phase 1 tripwire: the panel is read in one fixed order, and qualifications still precede the header", async () => {
  // Guards phases 3 and 4. The order is not cosmetic: `readQualifications` puts
  // the platform's own explanation sentences into the accumulator, and those
  // sentences are the arbiter `findApplicantName` corroborates the name against
  // (see the comment above the call). A layout phase that reorders the readers
  // for any reason must not move this pair.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));
  const snapshot = source.slice(source.indexOf("function snapshotPanel"), source.indexOf("function nextRevealStep"));
  assert.ok(snapshot.length > 200, "the snapshot function must be found, not an empty slice");

  const order = ["job", "qualifications", "applicant header", "screening responses", "experience", "education", "skills", "contacts"];
  let previous = -1;
  for (const label of order) {
    const at = snapshot.indexOf('attempt("' + label + '"');
    assert.ok(at > previous, '"' + label + '" must be read, and in this order');
    previous = at;
  }
  assert.ok(
    snapshot.indexOf('attempt("qualifications"') < snapshot.indexOf('attempt("applicant header"'),
    "qualifications must stay ahead of the header — they are what the name is corroborated against"
  );
});

test("Phase 1 tripwire: the section table is the seven keys the readers consume", async () => {
  // Guards phases 3, 5 and 6. Widening a WORDING is the whole point of the
  // later phases; adding or losing a KEY is not, because every key drives
  // `buildSectionMap`'s pass scheduling and `ownSectionLines`' cut.
  //
  // Phase 3 moved the table out of the adapter and into the core, so this
  // follows it there and asserts the exported list rather than a source slice.
  assert.deepEqual([...Applicants.SECTION_KEYS],
    ["qualifications", "screening", "experience", "education", "skills", "about", "resume"],
    "the seven section keys, in order — a wording may be widened, a key may not be lost");
  assert.deepEqual([...Applicants.REQUIRED_SECTION_KEYS], [...Applicants.SECTION_KEYS],
    "and today every recognised key is one a reader consumes");

  // The count trimming is what lets "Experience (5)" and "Experience · 3 roles"
  // still resolve. It was a live defect for four releases and must not be lost.
  for (const [title, key] of [
    ["Experience · 3 roles", "experience"], ["Experience (5)", "experience"],
    ["Skills (12+)", "skills"], ["Experience 5", "experience"], ["Education:", "education"]
  ]) {
    assert.equal(Applicants.sectionKeyFor(title), key, `"${title}" still names its section`);
  }

  // And the adapter no longer carries a second copy — one table, one place to
  // widen it, one place to test it.
  const source = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  assert.ok(!/const SECTION_PATTERNS = \[/.test(source), "the adapter must not redeclare the table");
  assert.match(source, /const SECTION_PATTERNS = Applicants\.SECTION_PATTERNS;/, "it aliases the core's");
  assert.match(source, /const sectionKeyFor = Applicants\.sectionKeyFor;/, "and the core's lookup");
});

test("Phase 1 tripwire: the name is chosen from five sources in one fixed trust order", async () => {
  // Guards phases 3 and 5. The order IS the policy — `chooseApplicantName`
  // breaks ties by caller order, so a fallback appended in a later phase must
  // go after these, never in front of them.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));
  const chooser = source.slice(source.indexOf("function findApplicantName"), source.indexOf("function readApplicantHeader"));
  assert.ok(chooser.length > 200, "the name reader must be found, not an empty slice");

  let previous = -1;
  for (const label of ["list-row", "profile-link", "portrait-alt", "panel-heading", "first-line"]) {
    const at = chooser.indexOf('"' + label + '"');
    assert.ok(at > previous, '"' + label + '" must be a candidate source, in trust order');
    previous = at;
  }
  assert.match(chooser, /Applicants\.chooseApplicantName\(candidates, Applicants\.nameFromExplanations\(/,
    "and the arbiter stays the platform's own explanation sentences");
});

test("Phase 1 tripwire: the header window starts at the applicant's own name and the profile link names them", async () => {
  // Guards phases 3 and 5. All four of these were live defects. The ordering
  // (name first, THEN the line window) is what put the header on the right
  // person; the named-anchor preference is what stops two applicants hashing to
  // one record, because `profileUrl` is an input to `applicantId`.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));
  const header = source.slice(source.indexOf("function readApplicantHeader"), source.indexOf("function readQualifications"));
  assert.ok(header.length > 400, "the header reader must be found, not an empty slice");

  assert.ok(
    header.indexOf("const chosen = findApplicantName(panel, accumulator)") < header.indexOf("const all = toLines(panel.innerText"),
    "the name must be resolved BEFORE the lines are sliced — that ordering is the fix"
  );
  assert.match(header, /if \(lines\.length >= 12\) break;/, "the window stays bounded at twelve lines");
  assert.match(header, /Applicants\.parseApplicantHeader\(\{ text: lines\.join/,
    "and the window is handed to the pure parser as one joined string");
  assert.match(header, /const named = wanted[\s\S]{0,400}?profileLinks\.find\(/,
    "the profile link that NAMES the applicant is preferred over the first visible one");
  assert.match(header, /const profileAnchor = named \|\| profileLinks\[0\] \|\| null;/,
    "with the first visible one still the fallback, so this is never worse than before");
});

test("Phase 1 tripwire: every section reader is blocks-first with a text fallback that only runs when the markup gave none", async () => {
  // Guards phases 3 and 6. The gate is the load-bearing half: a text fallback
  // that ran unconditionally would re-read the same cards linearly and hand the
  // parsers lines the block reader had already separated.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));

  for (const [reader, next, gate] of [
    ["function readQualifications", "function readScreeningResponses", "if (added || blocks.length) return added;"],
    ["function readScreeningResponses", "function readExperience", "if (added || blocks.length) return added;"],
    ["function readExperience", "function readEducation", "if (parsed) return added;"],
    ["function readEducation", "function readSkills", "if (parsed) return added;"]
  ]) {
    const slice = source.slice(source.indexOf(reader), source.indexOf(next));
    assert.ok(slice.length > 200, reader + " must be found, not an empty slice");
    assert.ok(slice.includes("blocksIn(section)"), reader + " reads the markup's own blocks first");
    assert.ok(slice.includes(gate), reader + " runs its text fallback only when the markup offered nothing");
    assert.ok(slice.includes("ownSectionLines(section)"), reader + " keeps a text fallback for a section with no blocks");
  }

  // Skills is the one written as a ternary rather than an early return; same
  // rule, different shape, and it is pinned in its own shape so a later phase
  // cannot quietly turn it into an unconditional text read.
  const skills = source.slice(source.indexOf("function readSkills"), source.indexOf("function readRenderedContacts"));
  assert.match(skills, /const values = blocks\.length[\s\S]{0,400}?: ownSectionLines\(section\);/,
    "skills reads pill headings when there are blocks, and the section's own lines when there are not");
});

test("Phase 1 tripwire: phone is never taken from the rendered panel, and only one read is trusted", async () => {
  // Guards phase 11. Rule 2, in its exact current shape: the ONE place the
  // labelled-provenance requirement is lifted is inside the disclosure this
  // extension opened itself, because that element is that person's own card by
  // construction. Widening a contact SURFACE in a later phase must not widen
  // this.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));

  assert.equal((source.match(/trusted: true/g) || []).length, 1,
    "exactly one read may lift the provenance rule, and it is the disclosure we opened");
  const declarations = adapterFunctions(source);
  assert.equal(ownerOf(declarations, source.indexOf("trusted: true")), "openContactAndCollect",
    "and that one read is inside the contact disclosure this extension opened itself");

  const rendered = source.slice(source.indexOf("function readRenderedContacts"), source.indexOf("function findControl"));
  assert.match(rendered, /allow: \["email"\]/,
    "a contact rendered on the panel with no click behind it yields an address and never a number");
  assert.ok(!/allow: \[[^\]]*phone/.test(source), "no reader may allow a phone off the click path");
});

test("Phase 1 tripwire: seven clicks, and each one is owned by a named function", async () => {
  // Guards phases 9 and 11, and it is the assertion the existing budget checks
  // cannot make. `.click()` counted seven times says nothing about WHERE the
  // seven are: the same total redistributed — a second press inside the contact
  // path, say, paid for by dropping the dismiss — passes every count in this
  // file while pressing something the allowlist never sanctioned.
  //
  // So the owners are named. Six gated opens plus one shared dismiss, one each.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));
  const owners = [
    "closeOpenedOverlay",      // the dismiss, shared by every overlay we opened
    "openContactAndCollect",   // the contact disclosure
    "expandCollapsedSections", // a collapsed section's own expander
    "clickResumeDownload",     // the resume viewer's own Download
    "collectResume",           // the resume control
    "selectApplicantRow",      // a row of the applicant list
    "clickApplicantPager"      // the list's next-page control
  ];

  assert.equal((source.match(/\.click\(\)/g) || []).length, owners.length,
    "the click budget is seven: six gated opens and one shared dismiss");

  const declarations = adapterFunctions(source);
  const found = [...source.matchAll(/\.click\(\)/g)].map((match) => ownerOf(declarations, match.index));

  assert.deepEqual([...found].sort(), [...owners].sort(),
    "every click is owned by exactly one of the seven sanctioned functions — none may move house");
});

test("Phase 1 tripwire: the panel's column scrolls, the position is always restored, and only three functions move the list", async () => {
  // Guards phase 7. Three separate promises, each one a live defect if broken:
  // the column policy is asked first (rule 8), the scroll position is restored
  // on the failure path too (rule 6), and the recruiter's own list must not move
  // while the applicant's profile is being read (the guide's Phase 7).
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));

  const chooser = source.slice(source.indexOf("function chooseScrollTarget"), source.indexOf("function currentScrollTop"));
  assert.ok(
    chooser.indexOf("Applicants.chooseColumnScrollTarget") < chooser.indexOf("Connections.chooseScrollTarget"),
    "the column policy is asked before the general chooser"
  );

  const scan = source.slice(source.indexOf("function scanApplicantPanel"), source.indexOf("function wrongApplicantError"));
  assert.ok(scan.length > 400, "the panel scan must be found, not an empty slice");
  assert.match(scan, /\} finally \{[\s\S]{0,400}?scrollPanelTo\(originalY, target\);/,
    "the panel's position is restored in a finally, so a thrown read still leaves the page where it was");
  assert.match(scan, /window\.scrollTo\(\{ top: originalWindowY/, "and so is the window's");

  // Every place the LEFT list is scrolled. Two functions settle or grow the
  // page's roster, plus the run's own restore. A profile read is not among them.
  const declarations = adapterFunctions(source);
  const listMovers = new Set();
  const listScroll = /scrollPanelTo\([^;]*(?:chooseScrollTarget\((?:list|applicantList\(\)|paged|\(await waitForApplicantList)|listStartY)/g;
  for (const match of source.matchAll(listScroll)) listMovers.add(ownerOf(declarations, match.index));
  assert.deepEqual([...listMovers].sort(), ["extractAllApplicants", "growApplicantList", "sweepCurrentPage"],
    "only the roster builders and the run's own restore may move the applicant list");
});

test("Phase 1 tripwire: a record may only be built from the applicant that was asked for, checked three times", async () => {
  // Guards every phase. Before the scan, after it, and immediately before the
  // record is built — the three moments LinkedIn can remount the panel under a
  // read. Any later phase needing its own identity check must make it
  // NON-THROWING rather than adding a fourth call, because the count is what
  // proves no path was added that saves without checking.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));
  const extract = source.slice(source.indexOf("async function extractApplicant"), source.indexOf("const VISIBLE_ONLY_OPTIONS"));
  assert.ok(extract.length > 400, "the extraction must be found, not an empty slice");

  assert.equal((extract.match(/assertExpectedApplicant\(expected\)/g) || []).length, 3,
    "three checks: before the scan, after it, and before the record is built");
  assert.match(extract, /assertExpectedApplicant\(expected\);\s*const record = Applicants\.buildApplicantRecord\(\{/,
    "and the last one is the line before the record exists");

  // Identity is read from LINKS, never from the address bar, which on this
  // surface moves ahead of the render.
  const identity = source.slice(source.indexOf("function panelOwnApplicationId"), source.indexOf("function panelMemberUrl"));
  assert.ok(!/location\.href/.test(identity), "the address bar is never a fallback for who the panel is showing");
});

test("Phase 1 tripwire: the applicant record is exactly seventeen fields, and every layout must produce them", () => {
  // Guards phases 2, 3 and 5, and it is the guide's "all layouts produce the
  // same applicant schema" made mechanical. `normalizeApplicantRecord` DROPS any
  // key not in its literal, so a reader that invents a field fails here rather
  // than silently vanishing — and a reader that loses one fails here too.
  const record = Applicants.normalizeApplicantRecord({});

  assert.deepEqual(Object.keys(record.applicant), [
    "name", "profileUrl", "headline", "location",
    "currentRole", "currentCompany", "totalExperience",
    "appliedAt", "contactedAt",
    "contact", "resume", "experience", "education", "skills",
    "screeningResponses", "qualifications", "applicationStatus"
  ], "the applicant's own seventeen fields, in order");

  assert.deepEqual(Object.keys(record), ["id", "applicationId", "job", "applicant", "extraction", "collectedAt", "updatedAt", "schemaVersion"]);
  assert.deepEqual(Object.keys(record.job), [
    "id", "title", "company", "location", "description", "applicantCount", "url",
    "mustHaveQualifications", "preferredQualifications", "screeningQuestions"
  ]);
  assert.deepEqual(Object.keys(record.applicant.contact).sort(), ["email", "other", "phone", "website"]);
  assert.deepEqual(Object.keys(record.applicant.resume), [
    "available", "filename", "fileType", "pages", "url", "viewerUrl", "localReference", "downloadStatus"
  ]);

  // The scalar list is maintained by hand and is what `mergeApplicantRecord`
  // walks — a new scalar missing from it is erased by the next thin re-read.
  assert.deepEqual(Applicants.APPLICANT_SCALAR_FIELDS, [
    "name", "profileUrl", "headline", "location",
    "currentRole", "currentCompany", "totalExperience",
    "appliedAt", "contactedAt", "applicationStatus"
  ], "every scalar the merge must protect");
});

test("Phase 1 tripwire: the CSV is the same nine columns in the same order, whatever the layout", async () => {
  // Guards every phase, and rule 19 outright: append columns, never reorder.
  // Diagnostics, capture payloads, layout labels and confidence scores are all
  // arriving in later phases and NONE of them may become a column.
  const { APPLICANT_CSV_COLUMNS, APPLICANT_TABLE_COLUMNS, applicantsToCsv } =
    await import("../src/applicant-csv.js");

  assert.deepEqual([...APPLICANT_TABLE_COLUMNS], [
    "applicant_name", "email", "mobile", "resume_file",
    "current_role", "current_company", "total_experience", "education"
  ], "the eight table columns, in order");
  assert.deepEqual(APPLICANT_CSV_COLUMNS.map((column) => column[0]), ["#", ...APPLICANT_TABLE_COLUMNS],
    "and the CSV is those eight behind the row number");

  // The header row as bytes, so a reorder cannot pass by renaming.
  const csv = applicantsToCsv([]);
  assert.equal(
    csv.replace(/^﻿/, "").split("\r\n")[0],
    '"#","applicant_name","email","mobile","resume_file","current_role","current_company","total_experience","education"',
    "the exported header, verbatim"
  );
  assert.ok(csv.startsWith("﻿"), "and the BOM stays, so a spreadsheet reads it as UTF-8");
});

// ------ Phase 2 of the multiple-LinkedIn-UI support guide: one shared schema
//
// The guide's Phase 2 is "all UIs must write into the same existing applicant
// record", with field-by-field merging and "never replace valid data with empty
// data". Auditing the current code against that sentence found the rule already
// true everywhere except two places, and both are load-bearing for every phase
// after this one:
//
//   1. `setResume` was a spread, so the LAST writer won — blanks included.
//   2. `buildApplicantRecord` had no route for `currentRole`, `currentCompany`
//      or `totalExperience`, even though `normalizeApplicantRecord` reads them
//      as `orNull(explicit) || derived`.
//
// These tests pin both, and the last one is the proof Phase 4 is built on.

test("Phase 2: a second resume write fills what the first one missed and erases nothing", () => {
  // THE HOLE: `collectResume` writes TWICE by design — the link is saved before
  // the download is attempted, so a failed download still leaves a usable
  // address, and the second write carries whatever the attempt produced. Under
  // a spread, a second write that did not carry `filename` set it to `null`
  // over the first one's, and `resume_file` was then empty for a file that was
  // sitting on disk.
  const accumulator = Applicants.createApplicantAccumulator();

  accumulator.setResume({
    available: true,
    url: "https://media.licdn.com/dms/document/abc/resume.pdf",
    filename: "Nihal Sharma.pdf",
    fileType: "pdf",
    pages: 2,
    viewerUrl: "https://www.linkedin.com/hiring/applicants/?applicationId=1",
    downloadStatus: Applicants.RESUME_STATUS.LINK_ONLY
  });

  // The download reports back. It knows the status and where the file landed,
  // and it knows nothing about the page count or the viewer.
  accumulator.setResume({
    available: true,
    localReference: "downloads/Nihal Sharma.pdf",
    downloadStatus: Applicants.RESUME_STATUS.DOWNLOADED
  });

  const resume = accumulator.snapshot().resume;
  assert.equal(resume.filename, "Nihal Sharma.pdf", "the name the first write found survives the second");
  assert.equal(resume.pages, 2, "and so does the page count");
  assert.equal(resume.viewerUrl, "https://www.linkedin.com/hiring/applicants/?applicationId=1");
  assert.equal(resume.url, "https://media.licdn.com/dms/document/abc/resume.pdf");
  assert.equal(resume.localReference, "downloads/Nihal Sharma.pdf", "what the second write knew is added");
  assert.equal(resume.downloadStatus, Applicants.RESUME_STATUS.DOWNLOADED,
    "and the VERDICT is the one field a later write must be able to move — that is the point of writing twice");

  // An explicit blank is "I did not find it", never "there is nothing".
  accumulator.setResume({ filename: null, pages: null, url: "" });
  const after = accumulator.snapshot().resume;
  assert.equal(after.filename, "Nihal Sharma.pdf", "null does not erase");
  assert.equal(after.pages, 2);
  assert.equal(after.url, "https://media.licdn.com/dms/document/abc/resume.pdf", '"" does not erase either');

  // `available` is OR-ed for the reason it has always been OR-ed one layer up:
  // a resume seen once exists, whatever a later pass managed to see.
  accumulator.setResume({ available: false });
  assert.equal(accumulator.snapshot().resume.available, true, "a resume seen once exists");
});

test("Phase 2: a page that states the current role outright is believed, and one that does not still derives it", () => {
  // The guide's chain is "explicit current-role field → top-card headline →
  // applicant summary → latest valid Experience title". Only the last link
  // existed, and the first had no route into the record at all: anything an
  // adapter wrote to `header.currentRole` was dropped by
  // `buildApplicantRecord`, which never mentioned it.
  const experience = [{ title: "Legal Assistant", company: "Bhatia and Khatri", dateRange: "2024 - Present", current: true, verified: false, details: [], raw: "" }];

  // With no explicit value the derivation is untouched — this is the proof the
  // change is a no-op for the layout that works today.
  const derived = Applicants.buildApplicantRecord({
    snapshot: { ...Applicants.createApplicantAccumulator().snapshot(), header: { name: "Nihal Sharma" }, experience },
    context: { jobId: "1", applicationId: "2" }
  });
  assert.equal(derived.applicant.currentRole, "Legal Assistant", "still derived from the newest current role");
  assert.equal(derived.applicant.currentCompany, "Bhatia and Khatri");

  // With one, the page's own statement wins — it is evidence, and the
  // derivation is an inference.
  const stated = Applicants.buildApplicantRecord({
    snapshot: {
      ...Applicants.createApplicantAccumulator().snapshot(),
      header: { name: "Nihal Sharma", currentRole: "Senior Legal Counsel", currentCompany: "Khatri LLP", totalExperience: "6 years" },
      experience
    },
    context: { jobId: "1", applicationId: "2" }
  });
  assert.equal(stated.applicant.currentRole, "Senior Legal Counsel", "an explicit field outranks the derivation");
  assert.equal(stated.applicant.currentCompany, "Khatri LLP");
  assert.equal(stated.applicant.totalExperience, "6 years");

  // And the schema did not move: `normalizeApplicantRecord` drops any key it
  // does not name, so this is a route into an existing field, not a new one.
  assert.equal(Object.keys(stated.applicant).length, 17, "seventeen fields, exactly as before");
});

test("Phase 2: every scalar the merge protects survives a thinner second read", () => {
  // The merge matrix, stated once for all ten. Rule 17: merging never
  // overwrites a filled field with a blank — and every UI added in a later
  // phase re-collects applicants that are already stored.
  const full = Applicants.normalizeApplicantRecord({
    job: { id: "4277798308" },
    applicationId: "25550787924",
    applicant: {
      name: "Nihal Sharma", profileUrl: "https://www.linkedin.com/in/nihal", headline: "Human Resource",
      location: "Noida, Uttar Pradesh, India", currentRole: "HR Lead", currentCompany: "Acme",
      totalExperience: "6 years", appliedAt: "13mo ago", contactedAt: "10mo ago", applicationStatus: "Shortlisted"
    }
  });

  // A re-collection that saw a mounting panel: the name only.
  const thin = Applicants.normalizeApplicantRecord({
    job: { id: "4277798308" },
    applicationId: "25550787924",
    applicant: { name: "Nihal Sharma" }
  });

  const merged = Applicants.mergeApplicantRecord(full, thin);
  for (const field of Applicants.APPLICANT_SCALAR_FIELDS) {
    assert.equal(merged.applicant[field], full.applicant[field], `${field} survives a thinner later read`);
  }

  // And the other direction: a blank stored value takes the newer one.
  const filled = Applicants.mergeApplicantRecord(thin, full);
  for (const field of Applicants.APPLICANT_SCALAR_FIELDS) {
    assert.equal(filled.applicant[field], full.applicant[field], `${field} is filled by a fuller later read`);
  }
});

test("Phase 2: the order the readers run in cannot change the record they produce", () => {
  // THE PROOF PHASE 4 IS BUILT ON. The guide's Phase 4 permits layout detection
  // to "decide which reader runs first" and forbids it from changing the
  // schema, the workflow or the record. That is only safe if reader order is
  // genuinely immaterial — so this asserts it directly, over every order the
  // independent readers can run in.
  //
  // The first three are NOT permuted and never will be: `job` seeds the record,
  // and `qualifications` must precede the header because their explanation
  // sentences are what the name is corroborated against. The five that follow
  // write to five disjoint maps, and those are permuted exhaustively — 120
  // orders, each asserted byte-identical.
  const work = {
    screening: () => Applicants.parseScreeningBlock(["Do you have 3 years of experience?", "Ideal answer: Yes", "Yes"]),
    experience: () => Applicants.parseExperienceBlock(["Legal Assistant", "Bhatia and Khatri Law Office • 2024 - Present", "Drafted contracts"]),
    education: () => Applicants.parseEducationBlock(["CHANDIGARH UNIVERSITY", "Bachelor of Laws - LLB", "2019 - 2024"]),
    skills: () => "Contract Drafting",
    contacts: () => ({ emails: ["nihal@example.com"], phones: ["+91 90000 00000"], websites: [] })
  };

  const build = (order) => {
    const accumulator = Applicants.createApplicantAccumulator();
    accumulator.addJob({ id: "4277798308", title: "Legal Associate" });
    accumulator.addQualification(Applicants.parseQualificationBlock({
      category: Applicants.QUALIFICATION_CATEGORY.MUST_HAVE,
      lines: ["3+ years of legal experience", "Nihal Sharma has 6 years of experience"]
    }));
    accumulator.addName("Nihal Sharma", true);
    accumulator.addHeader({ headline: "Human Resource", location: "Noida, Uttar Pradesh, India" });
    for (const reader of order) {
      if (reader === "screening") accumulator.addScreening(work.screening());
      if (reader === "experience") accumulator.addExperience(work.experience());
      if (reader === "education") accumulator.addEducation(work.education());
      if (reader === "skills") accumulator.addSkill(work.skills());
      if (reader === "contacts") accumulator.addContactPanel(work.contacts());
    }
    const record = Applicants.buildApplicantRecord({
      snapshot: accumulator.snapshot(),
      context: { jobId: "4277798308", applicationId: "25550787924" },
      sourceUrl: APPLICANTS_URL,
      buildId: "test"
    });
    // Two fields are wall-clock and are not what this is about.
    return JSON.stringify({ ...record, collectedAt: "", updatedAt: "", extraction: { ...record.extraction, timestamp: "" } });
  };

  const permutations = (list) => list.length <= 1 ? [list] : list.flatMap(
    (item, index) => permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])
  );

  const orders = permutations(["screening", "experience", "education", "skills", "contacts"]);
  assert.equal(orders.length, 120, "every order of the five independent readers");

  const expected = build(orders[0]);
  for (const order of orders) {
    assert.equal(build(order), expected, `reading in the order ${order.join(" → ")} must produce the same record`);
  }

  // And the record it produces is a real one, so this is not 120 comparisons of
  // an empty object.
  const record = JSON.parse(expected);
  assert.equal(record.applicant.name, "Nihal Sharma");
  assert.equal(record.applicant.currentRole, "Legal Assistant");
  assert.equal(record.applicant.contact.email, "nihal@example.com");
  assert.equal(record.applicant.education.length, 1);
  assert.equal(record.applicant.skills.length, 1);
});

// ------ Phase 3 of the multiple-LinkedIn-UI support guide: the seams
//
// "Keep the current selectors and add semantic fallbacks after them", with each
// reader returning a value, its source and its confidence. Three additions, and
// the important property of all three is that they are inert on the layout that
// works today.

test("Phase 3: the section table is now testable, which is the whole reason it moved", () => {
  // It was the most consequential untestable thing in the extension: a heading
  // wording the table does not recognise makes a section invisible, and
  // `current_role`, `current_company` and `total_experience` are derived from
  // one section and nothing else — so a wording nobody thought of emptied three
  // columns at once, silently, for four consecutive releases.
  //
  // Every wording each of the seven patterns accepts, stated once.
  const accepts = {
    qualifications: ["Qualifications", "Qualification", "Screening qualifications", "Job qualifications",
      "Candidate qualifications", "Applicant qualifications", "Qualifications summary", "Qualifications overview", "Qualifications match"],
    screening: ["Screening questions", "Screening question", "Screening question responses", "Screening question response"],
    experience: ["Experience", "Experiences", "Work experience", "Professional experience", "Employment experience", "Career experience"],
    education: ["Education", "Educational background"],
    skills: ["Skills", "Skill", "Top skills", "Skills & endorsements", "Skills and endorsements"],
    about: ["About", "Summary"],
    resume: ["Resume", "CV", "Curriculum vitae", "Attachments", "Attachment"]
  };
  for (const [key, wordings] of Object.entries(accepts)) {
    for (const wording of wordings) {
      assert.equal(Applicants.sectionKeyFor(wording), key, `"${wording}" names the ${key} section`);
      // ...and so does every rendering of it LinkedIn adds metadata to.
      assert.equal(Applicants.sectionKeyFor(`${wording} (5)`), key, `"${wording} (5)" too`);
      assert.equal(Applicants.sectionKeyFor(`${wording}:`), key, `"${wording}:" too`);
      assert.equal(Applicants.sectionKeyFor(`${wording} · 3 items`), key, `"${wording} · 3 items" too`);
    }
  }

  // And what it must NOT match. A section key is what hands a reader a set of
  // cards, so a wrong key hands one section's cards to another reader — the
  // failure `narrowSharedSections` exists to prevent.
  for (const line of [
    "Legal Assistant", "Bhatia and Khatri Law Office • 2024-Present", "CHANDIGARH UNIVERSITY",
    "Bachelor of Laws - LLB", "Experience Cloud Consultant", "Education First",
    "Filter and sort", "Shortlist", "Move to", "Noida, Uttar Pradesh, India", "Applied 13mo ago"
  ]) {
    assert.equal(Applicants.sectionKeyFor(line), "", `"${line}" is content, not a section title`);
  }
  assert.equal(Applicants.sectionKeyFor(""), "");
  assert.equal(Applicants.sectionKeyFor(null), "");

  // The trimming is shared with `isSectionTitleLine`, which had its own
  // identical copy and a comment saying it was "the same trimming sectionKeyFor
  // applies on the page". Now it literally is.
  assert.equal(Applicants.normalizeSectionTitle("Experience · 3 roles"), "Experience");
  assert.equal(Applicants.normalizeSectionTitle("Skills (12+)"), "Skills");
  assert.equal(Applicants.normalizeSectionTitle("Education:"), "Education");
  assert.ok(Applicants.isSectionTitleLine("Experience (5)"), "and both sides of it agree");
  assert.ok(!Applicants.isSectionTitleLine("Legal Assistant"));
});

test("Phase 3: a field is chosen by what kind of evidence it is, never by where it sat", () => {
  const E = Applicants.FIELD_EVIDENCE;

  // The tie-break is the CALLER'S order, which is what puts a fallback behind
  // the working reader by construction.
  const first = Applicants.resolveField([
    { value: "Human Resource", source: "header-window", evidence: E.TEXT },
    { value: "Talent Partner", source: "list-row", evidence: E.TEXT }
  ]);
  assert.equal(first.value, "Human Resource", "equal evidence is broken by the caller's preference order");
  assert.equal(first.source, "header-window");

  // Stronger evidence wins wherever it sits in that order — that is the point
  // of the ladder. A label the page rendered outranks a line we found by
  // position, and rule 7 is why: the position is what a redesign moves.
  const stronger = Applicants.resolveField([
    { value: "Human Resource", source: "header-window", evidence: E.TEXT },
    { value: "Talent Partner", source: "panel-label", evidence: E.LABELLED }
  ]);
  assert.equal(stronger.value, "Talent Partner");
  assert.equal(stronger.evidence, E.LABELLED);
  assert.ok(stronger.confidence > first.confidence, "and it says so");

  // Two different sources agreeing is corroboration in miniature.
  const agreed = Applicants.resolveField([
    { value: "Nihal Sharma", source: "list-row", evidence: E.TEXT },
    { value: "Nihal Sharma", source: "portrait-alt", evidence: E.TEXT }
  ]);
  assert.equal(agreed.agreed, 1, "the second reading is counted");
  assert.ok(agreed.confidence > first.confidence, "and the answer is held more firmly");

  // A refusal is recorded rather than thrown away: "the panel showed it and we
  // discarded it" is the one thing a diagnostics report cannot reconstruct.
  const refused = Applicants.resolveField(
    [{ value: "Filter and sort", source: "header-window" }, { value: "Noida, Delhi, India", source: "panel-label" }],
    { accept: Applicants.looksLikeApplicantLocation }
  );
  assert.equal(refused.value, "Noida, Delhi, India");
  assert.equal(refused.rejected.length, 1);
  assert.equal(refused.rejected[0].value, "Filter and sort");

  // Nothing acceptable is "", never the least-bad candidate (rule 1).
  const nothing = Applicants.resolveField(
    [{ value: "Filter and sort", source: "header-window" }],
    { accept: Applicants.looksLikeApplicantLocation }
  );
  assert.equal(nothing.value, "", "a blank beats a wrong value");
  assert.equal(nothing.confidence, 0);
  assert.deepEqual(Applicants.resolveField([]).value, "");
  assert.deepEqual(Applicants.resolveField(null).value, "");
  assert.deepEqual(Applicants.resolveField(undefined).value, "");

  // A confidence floor means the same thing: below it, the field stays empty.
  const floored = Applicants.resolveField(
    [{ value: "Human Resource", source: "header-window", evidence: E.TEXT }],
    { minConfidence: 0.7 }
  );
  assert.equal(floored.value, "", "a value we do not hold firmly enough is not reported at all");
});

test("Phase 3: the name reader goes through the shared primitive and behaves exactly as it did", () => {
  // `chooseApplicantName` is now `resolveField` with a normalizer and an accept
  // rule. Name candidates carry no evidence, so every one lands on the same
  // rung, the strongest-evidence step is a no-op, and the tie-break is caller
  // order — which is first-wins, which is what it has always been.
  const candidates = [
    { value: "Applicants", source: "list-row" },
    { value: "Nihal Sharma", source: "profile-link" },
    { value: "Nihal Sharma", source: "portrait-alt" }
  ];

  const guessed = Applicants.chooseApplicantName(candidates, "");
  assert.equal(guessed.name, "Nihal Sharma", "page chrome is refused and the first survivor wins");
  assert.equal(guessed.source, "profile-link");
  assert.equal(guessed.corroborated, false,
    "two sources agreeing is not the platform agreeing — only the explanations set this");

  // The platform's own prose still wins outright.
  const corroborated = Applicants.chooseApplicantName(candidates, "Nihal Sharma");
  assert.equal(corroborated.name, "Nihal Sharma");
  assert.equal(corroborated.corroborated, true);
  assert.equal(corroborated.source, "profile-link", "and it names the candidate it agreed with");

  // A name the markup never offered is still taken from the prose.
  const unmatched = Applicants.chooseApplicantName([{ value: "Applicants", source: "list-row" }], "Komal Sharma");
  assert.equal(unmatched.name, "Komal Sharma");
  assert.equal(unmatched.source, "explanations");
  assert.equal(unmatched.corroborated, true);

  // Nothing at all is "", not a guess.
  const none = Applicants.chooseApplicantName([{ value: "Filter and sort", source: "list-row" }], "");
  assert.deepEqual(none, { name: "", source: "", corroborated: false });

  // The return shape is exactly three keys — no `evidence`, no `confidence`, no
  // `rejected`. Nothing downstream has to learn a new shape.
  assert.deepEqual(Object.keys(guessed).sort(), ["corroborated", "name", "source"]);
});

test("Phase 3: a reader result is unwrapped at the accumulator's door, so provenance cannot reach the record", () => {
  // `cleanText` is `String(value ?? "")`, so a `{ value }` wrapper that leaked
  // through would be stored as "[object Object]" — a garbage record rather than
  // an empty one. `fieldValue` is why that cannot happen, and it is wired into
  // `addHeader` and `addName` rather than left as a convention a reader can
  // forget.
  assert.equal(Applicants.fieldValue("Human Resource"), "Human Resource");
  assert.equal(Applicants.fieldValue({ value: "Human Resource", source: "panel-label", confidence: 0.8 }), "Human Resource");
  assert.equal(Applicants.fieldValue({ value: "" }), "");
  assert.equal(Applicants.fieldValue(null), "");
  assert.equal(Applicants.fieldValue(undefined), "");

  const accumulator = Applicants.createApplicantAccumulator();
  accumulator.addName({ value: "Nihal Sharma", source: "list-row" }, true);
  accumulator.addHeader({
    headline: { value: "Human Resource", source: "panel-label", evidence: "labelled", confidence: 0.8 },
    location: "Noida, Uttar Pradesh, India"
  });

  const header = accumulator.snapshot().header;
  assert.equal(header.name, "Nihal Sharma");
  assert.equal(header.headline, "Human Resource", "a wrapper is unwrapped, never stringified");
  assert.equal(header.location, "Noida, Uttar Pradesh, India", "and a plain string still works");

  const record = Applicants.buildApplicantRecord({
    snapshot: accumulator.snapshot(),
    context: { jobId: "1", applicationId: "2" }
  });
  assert.equal(record.applicant.headline, "Human Resource");
  assert.ok(!JSON.stringify(record).includes("panel-label"), "the source never reaches the record");
  assert.ok(!JSON.stringify(record).includes("confidence"), "and neither does the confidence");
  assert.ok(!JSON.stringify(record).includes("[object Object]"), "and nothing is stringified");
});

test("Phase 3: the three columns that have no reader can now be read from a label the page renders", () => {
  // `currentRole`, `currentCompany` and `totalExperience` are derived from the
  // Experience entries and from nothing else. The guide's chain starts with an
  // "explicit current-role field", and this is the vocabulary for it.
  for (const [label, field] of [
    ["Current role", "currentRole"], ["Current title", "currentRole"], ["Current position", "currentRole"],
    ["Current job title", "currentRole"], ["Current designation", "currentRole"],
    ["Current company", "currentCompany"], ["Current employer", "currentCompany"], ["Current organisation", "currentCompany"],
    ["Total experience", "totalExperience"], ["Years of experience", "totalExperience"], ["Total work experience", "totalExperience"],
    ["Headline", "headline"], ["Location", "location"], ["Based in", "location"], ["Status", "applicationStatus"]
  ]) {
    assert.equal(Applicants.applicantFieldForLabel(label), field, `"${label}" names ${field}`);
    assert.equal(Applicants.applicantFieldForLabel(`${label}:`), field, "and the rendering with a colon after it");
  }

  // Deliberately narrow. A loose list is how the Experience section HEADING
  // becomes the experience FIELD, and a wrong value is worse than a blank one.
  for (const line of [
    "Experience", "Education", "Skills", "Company", "Role", "Applied", "Qualifications",
    "Nihal Sharma", "Legal Assistant", "Noida, Uttar Pradesh, India", "Message", "Shortlist"
  ]) {
    assert.equal(Applicants.applicantFieldForLabel(line), "", `"${line}" is not a field label`);
  }

  // `totalExperience` is the one where a wrong value is silently plausible: it
  // lands in a column of durations beside numbers this extension computed
  // itself, and an explicit value OUTRANKS the computed one. So it is gated on
  // looking like a length of service, not merely on sitting under the label.
  for (const stated of ["6 years", "6 yrs", "6.5 years", "10+ years", "6 years 3 months", "1 year"]) {
    assert.ok(Applicants.looksLikeTotalExperience(stated), `"${stated}" is a length of service`);
  }
  for (const other of [
    "Senior Legal Counsel", "2019 - 2024", "Present", "Noida, Uttar Pradesh, India",
    "", "yes", "several years", "3 roles", "a very long sentence that goes on and on about experience"
  ]) {
    assert.ok(!Applicants.looksLikeTotalExperience(other), `"${other}" is not`);
  }
});

test("Phase 3: the labelled reader runs last, writes only through the accumulator, and is inert on today's layout", async () => {
  // The safety argument for every fallback in this series, checked mechanically
  // for the first one: it runs AFTER every reader it backs up, and it writes
  // only through `addHeader`, which is first-wins per field. Those two facts
  // together make it incapable of regressing the working layout whether or not
  // its selectors are right.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));
  const snapshot = source.slice(source.indexOf("function snapshotPanel"), source.indexOf("function nextRevealStep"));
  assert.ok(snapshot.length > 200, "the snapshot function must be found, not an empty slice");

  assert.ok(
    snapshot.indexOf('attempt("labelled fields"') > snapshot.indexOf('attempt("contacts"'),
    "the labelled reader runs after every other one"
  );

  // Ended on a declaration rather than on a banner comment: `withoutComments`
  // has already removed every banner, and an `indexOf` of -1 silently slices to
  // the end of the file, which would make every "must not contain" below vacuous.
  const reader = source.slice(source.indexOf("function readLabelledFields"), source.indexOf("const OVERLAY = Core.CONTACT_OVERLAY"));
  assert.ok(reader.length > 400 && reader.length < 8000, "the labelled reader must be found, and only it");
  assert.match(reader, /accumulator\.addHeader\(filled\)/, "it writes through the merge-only header");
  for (const forbidden of ["addExperience", "addEducation", "setResume", "addContactPanel", "addSkill"]) {
    assert.ok(!reader.includes(forbidden), `it must not write through ${forbidden}`);
  }
  assert.match(reader, /if \(!wanted\.length\) return 0;/,
    "and it skips the sweep entirely once the fields are filled — it runs once per snapshot, and there are dozens");

  // Rule 7: resolved by rendered text and structure, never by a class name and
  // never by an index into unknown markup.
  const sweep = source.slice(source.indexOf("function labelledValuesIn"), source.indexOf("function readLabelledFields"));
  assert.ok(sweep.length > 400, "the label sweep must be found, not an empty slice");
  assert.ok(!/class\*?=/.test(sweep), "a label may never be identified by a generated class name");
  assert.match(sweep, /if \(measured >= LABEL_SWEEP_LIMIT\) break;/, "the sweep is bounded");
  assert.match(sweep, /raw\.length > LABEL_MAX_LENGTH/, "and text is measured before layout is");
  assert.match(sweep, /if \(!value \|\| Applicants\.applicantFieldForLabel\(value\)\) continue;/,
    "a second label is never taken as a value");

  // Provenance goes to diagnostics and nowhere else.
  assert.match(reader, /diagnostics\.readers/, "the source and confidence are reported");
  assert.ok(!/record\.|buildApplicantRecord/.test(reader), "and never written into the record");
});

// ------ Phase 4 of the multiple-LinkedIn-UI support guide: layout detection
//
// The guide's constraint is the whole design: "The detected UI may only decide
// which reader runs first. It must not change the applicant schema, workflow,
// save format, pagination, or current UI behaviour."
//
// `describeApplicantLayout` returns a PERMUTATION of a fixed list and nothing
// else — there is nowhere in its return shape to put a value, a selector, a
// threshold or a field. These four assertions are what make that mechanical
// rather than aspirational, and the fourth is the one that actually matters.

test("Phase 4: detection can only ever reorder the readers, never add or drop one", () => {
  // Over every layout it can report, and over inputs no adapter would ever
  // produce: garbage, empty, null, undefined, wrong types.
  const inputs = [
    {},
    null,
    undefined,
    "not an object",
    42,
    { sectionKeys: null, labelKeys: 7, contactSurface: {}, topCardShape: [] },
    { sectionKeys: ["qualifications", "screening", "experience", "education", "skills"], topCardShape: "name-headline-location", hasContactControl: true },
    { sectionKeys: ["experience"], labelKeys: ["currentCompany"], contactSurface: "drawer", topCardShape: "labelled" },
    { sectionKeys: ["experience", "education"], contactSurface: "popover" },
    { qualificationSubheadings: 2, sectionKeys: ["screening", "experience", "education"], topCardShape: "name-headline-location" }
  ];

  const everyReader = [...Applicants.APPLICANT_READERS].sort();
  for (const signals of inputs) {
    const verdict = Applicants.describeApplicantLayout(signals);

    assert.deepEqual([...verdict.readerOrder].sort(), everyReader,
      `every reader runs exactly once, whatever the signals (${JSON.stringify(signals)})`);
    assert.deepEqual([...verdict.readerOrder].slice(0, 3), [...Applicants.APPLICANT_READER_PREFIX],
      "and the frozen prefix is never reordered: qualifications must precede the header");
    assert.deepEqual(Object.keys(verdict).sort(), ["contradicted", "layout", "matched", "readerOrder"],
      "the verdict can hold no value, no selector, no threshold and no field");
    assert.ok(Object.values(Applicants.APPLICANT_LAYOUT).includes(verdict.layout), "and the layout is one of the three");
  }

  // The prefix is not merely conventional — it is why the name has an arbiter.
  assert.deepEqual([...Applicants.APPLICANT_READER_PREFIX], ["job", "qualifications", "header"]);
});

test("Phase 4: an unrecognised layout is a safe default, not a failure", () => {
  const L = Applicants.APPLICANT_LAYOUT;

  // The screen this extension was written against: the qualifications card, the
  // screening section, two or more profile sections, a stacked top card, and a
  // contact control. Three of five is the bar, because a slow panel routinely
  // has not hydrated all of them.
  const current = Applicants.describeApplicantLayout({
    sectionKeys: ["qualifications", "screening", "experience", "education", "skills"],
    topCardShape: "name-headline-location",
    hasContactControl: true,
    rowLinkCount: 1
  });
  assert.equal(current.layout, L.CURRENT);
  assert.equal(current.contradicted.length, 0);
  assert.ok(current.matched.length >= 3);

  // An account that renders only the two qualification subheadings and never
  // the word — the case `collectQualificationSubsections` exists for — is still
  // the current layout.
  const subheadings = Applicants.describeApplicantLayout({
    sectionKeys: ["screening", "experience", "education"],
    qualificationSubheadings: 2,
    topCardShape: "name-headline-location"
  });
  assert.equal(subheadings.layout, L.CURRENT);

  // A CONTRADICTION is a signal positively asserting a different shape — never
  // merely the absence of one, which is what a half-hydrated panel looks like.
  for (const signals of [
    { topCardShape: "labelled" },
    { contactSurface: "drawer" },
    { contactSurface: "popover" },
    { contactSurface: "inline" },
    { labelKeys: ["currentCompany"] }
  ]) {
    const verdict = Applicants.describeApplicantLayout({
      sectionKeys: ["qualifications", "screening", "experience", "education", "skills"],
      hasContactControl: true,
      ...signals
    });
    assert.equal(verdict.layout, L.ALTERNATIVE, `${JSON.stringify(signals)} asserts a different shape`);
    assert.ok(verdict.contradicted.length > 0, "and it says which signal did");
  }

  // Nothing recognised at all is generic, and generic is safe for a STRUCTURAL
  // reason rather than an optimistic one: it runs the same readers, promoting
  // only the labelled one, and every writer downstream is fill-empty. So an
  // unrecognised layout can produce the same record or a fuller one — never a
  // worse one.
  assert.equal(Applicants.describeApplicantLayout({}).layout, L.GENERIC);
  assert.equal(Applicants.describeApplicantLayout(undefined).layout, L.GENERIC);
  assert.equal(Applicants.describeApplicantLayout({ sectionKeys: ["experience"] }).layout, L.GENERIC);

  // A half-hydrated panel is generic, not alternative: absence contradicts
  // nothing, which is what keeps a slow render from being called a new layout.
  const half = Applicants.describeApplicantLayout({ sectionKeys: ["experience"], hasContactControl: false });
  assert.equal(half.layout, L.GENERIC);
  assert.equal(half.contradicted.length, 0);

  // The only difference any of it makes: where the labelled reader sits.
  assert.equal(current.readerOrder[current.readerOrder.length - 1], "labelled",
    "on today's layout it runs last, where it costs a bounded sweep and finds nothing");
  assert.equal(Applicants.describeApplicantLayout({}).readerOrder[3], "labelled",
    "and on anything else it runs first of the tail, before the derivation");
});

test("Phase 4: reordering the readers cannot change the record, over every order there is", () => {
  // THE PROOF. Phase 2 established it for the five independent readers; this
  // restates it against the list detection actually permutes, so the two can
  // never drift apart — and it is the assertion that makes the guide's "must
  // not change the applicant schema, workflow, save format or current UI
  // behaviour" a fact rather than a promise.
  //
  // The tail is six readers, so exhaustive is 720 orders. The prefix is not
  // permuted at all, and assertion #1 above is what guarantees detection can
  // never touch it.
  const apply = {
    screening: (a) => a.addScreening(Applicants.parseScreeningBlock(["Do you have 3 years of experience?", "Ideal answer: Yes", "Yes"])),
    experience: (a) => a.addExperience(Applicants.parseExperienceBlock(["Legal Assistant", "Bhatia and Khatri Law Office • 2024 - Present", "Drafted contracts"])),
    education: (a) => a.addEducation(Applicants.parseEducationBlock(["CHANDIGARH UNIVERSITY", "Bachelor of Laws - LLB", "2019 - 2024"])),
    skills: (a) => a.addSkill("Contract Drafting"),
    contacts: (a) => a.addContactPanel({ emails: ["nihal@example.com"], phones: [], websites: [] }),
    // The labelled reader, which is the one detection actually moves.
    labelled: (a) => a.addHeader({ currentRole: "Senior Legal Counsel", currentCompany: "Khatri LLP" })
  };

  const build = (order) => {
    const accumulator = Applicants.createApplicantAccumulator();
    accumulator.addJob({ id: "4277798308", title: "Legal Associate" });
    accumulator.addQualification(Applicants.parseQualificationBlock({
      category: Applicants.QUALIFICATION_CATEGORY.MUST_HAVE,
      lines: ["3+ years of legal experience", "Nihal Sharma has 6 years of experience"]
    }));
    accumulator.addName("Nihal Sharma", true);
    accumulator.addHeader({ headline: "Human Resource", location: "Noida, Uttar Pradesh, India" });
    for (const reader of order) apply[reader](accumulator);
    const record = Applicants.buildApplicantRecord({
      snapshot: accumulator.snapshot(),
      context: { jobId: "4277798308", applicationId: "25550787924" },
      sourceUrl: APPLICANTS_URL,
      buildId: "test"
    });
    return JSON.stringify({ ...record, collectedAt: "", updatedAt: "", extraction: { ...record.extraction, timestamp: "" } });
  };

  const permutations = (list) => list.length <= 1 ? [list] : list.flatMap(
    (item, index) => permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])
  );

  const orders = permutations([...Applicants.APPLICANT_READER_TAIL]);
  assert.equal(orders.length, 720, "every order of the six readers detection is allowed to permute");

  const expected = build(orders[0]);
  for (const order of orders) {
    assert.equal(build(order), expected, `reading in the order ${order.join(" → ")} must produce the same record`);
  }

  // And it is a real record, so this is not 720 comparisons of an empty object.
  const record = JSON.parse(expected);
  assert.equal(record.applicant.name, "Nihal Sharma");
  assert.equal(record.applicant.currentRole, "Senior Legal Counsel", "the labelled reader's value, wherever it ran");
  assert.equal(record.applicant.contact.email, "nihal@example.com");
  assert.equal(Object.keys(record.applicant).length, 17, "and the schema did not move");
});

test("Phase 4: the layout verdict reaches the dispatch and the diagnostics, and nothing else", async () => {
  // The one thing a pure test cannot see: whether the adapter USES the verdict
  // for anything other than order. So the identifier is bounded by source.
  const source = withoutComments(await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8"));

  const snapshot = source.slice(source.indexOf("function snapshotPanel"), source.indexOf("function nextRevealStep"));
  assert.ok(snapshot.length > 400, "the snapshot function must be found, not an empty slice");
  assert.match(snapshot, /for \(const reader of verdict\.readerOrder\) readers\[reader\]\(\);/,
    "the readers run in the order the verdict gives, and the verdict gives an order");
  assert.match(snapshot, /diagnostics\.layout = \{/, "and the verdict is reported");

  // Nothing may branch on the layout inside a reader, a save path, a click
  // guard or an identity check. That is what would turn "which reader runs
  // first" into "what this layout is allowed to do".
  const uses = [...source.matchAll(/describeApplicantLayout|verdict\.layout/g)].length;
  assert.ok(uses <= 3, `the layout verdict is consulted in one place, not ${uses}`);
  assert.ok(!/if \(.*layout === /.test(source), "no reader may branch on the layout");
  assert.ok(!/layout/.test(source.slice(source.indexOf("async function extractApplicant"), source.indexOf("const VISIBLE_ONLY_OPTIONS"))),
    "and the extraction — where the record is built and saved — never mentions it");

  // The signals are content, never a class name (rule 7), and no element
  // escapes into them, which is what keeps the decision pure.
  const signals = source.slice(source.indexOf("function applicantLayoutSignals"), source.indexOf("function snapshotPanel"));
  assert.ok(signals.length > 400, "the signal reader must be found, not an empty slice");
  assert.ok(!/class\*?=/.test(signals), "a layout may never be identified by a generated class name");
  assert.ok(!/\.click\(\)/.test(signals), "and measuring it presses nothing");
  assert.match(signals, /state\.layoutSignals/, "it is measured once per applicant, not once per snapshot");
  assert.match(signals, /held\.identity === identity/, "keyed on who the panel is showing, so it invalidates itself");
  // ...and on the element when the panel names nobody, which is exactly the
  // markup a layout phase exists for. Without it, the one layout we cannot
  // recognise would pay for four sweeps on every snapshot.
  assert.match(signals, /held\.panel === live/, "and on the panel itself when there is no identity to key on");
  assert.match(signals, /held\.panel\?\.isConnected/, "a remount re-measures rather than answering from a detached node");

  // The click budget is untouched by any of this.
  assert.equal((source.match(/\.click\(\)/g) || []).length, 7, "the click budget is still seven");
});
