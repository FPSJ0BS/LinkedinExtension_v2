// Phase 10 of `docs/multiple-linkedin-dom-ui-support-guide.md`: fixture-based
// regression tests, one layout per file, all of them replayed through the same
// readers.
//
// **Why these are JSON and not HTML.** The guide offers `linkedom` as a dev
// dependency "if approved", and it was declined for three reasons that are
// disqualifying rather than inconvenient:
//
//   1. `linkedom` has no layout, so `innerText` collapses to `textContent` — and
//      every parser in this codebase consumes `toLines(element.innerText)`. A
//      fixture would have to be crafted so that `textContent` happened to
//      produce the right newlines, which is testing a fiction.
//   2. No layout means no `isVisible`, and `isVisible` gates every heading,
//      every control, every block and every candidate panel. Either nothing is
//      visible and the readers return nothing, or it is stubbed — at which point
//      the program under test is not the program that ships.
//   3. No `scrollHeight`/`clientHeight`/`getBoundingClientRect`, so the scroll
//      chooser and the reveal walk stay untestable regardless.
//
// A green suite that misrepresents live behaviour is worse than no suite, and
// rule 20 already says fixtures are not the live DOM. So a fixture here is the
// capture's **DOM-free projection**: for each section, the exact line arrays the
// readers consumed, plus the heading list with the key each one resolved to.
// That is precisely the half a `linkedom` fixture could not test faithfully, and
// it is replayed through the real pure parsers with no dependencies at all.
//
// A fixture is produced by the Phase 9 capture — `Capture Current Applicant UI`
// on the Applicants page — which sanitizes it before it is ever written: every
// name becomes a stable pseudonym, every address becomes the KIND of thing it
// pointed at, and every number, token and credential is gone.
//
// **Provenance is in the name.** `current-ui` describes the layout this
// extension is written against. `constructed-labelled-ui` is exactly what it
// says: a fixture built by hand from wordings and shapes justified by evidence
// in Phase 5, existing so that the cross-layout assertions have a second shape
// to compare against. It is NOT an observed layout, and nothing here pretends
// otherwise. A real capture of a real second UI replaces it the day one arrives.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await import("../src/extraction-core.js");
await import("../src/applicants-core.js");
const Applicants = globalThis.ProfileVaultApplicants;

const FIXTURE_DIR = resolve(root, "tests/fixtures/applicant-ui");

async function loadFixtures() {
  const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith(".json")).sort();
  const loaded = [];
  for (const name of names) {
    loaded.push({ name, data: JSON.parse(await readFile(resolve(FIXTURE_DIR, name), "utf8")) });
  }
  return loaded;
}

/** Everything a fixture says, folded into a record the same way a live read is. */
function recordFrom(fixture) {
  const accumulator = Applicants.createApplicantAccumulator();
  accumulator.addJob({ id: "4277798308", title: "Legal Associate", company: "Acme Recruiting" });

  for (const lines of fixture.blocks?.qualifications || []) {
    accumulator.addQualification(Applicants.parseQualificationBlock({
      category: Applicants.QUALIFICATION_CATEGORY.MUST_HAVE, lines
    }));
  }
  const explanations = accumulator.snapshot().qualifications.map((entry) => entry.explanation).filter(Boolean);
  const chosen = Applicants.chooseApplicantName(fixture.nameCandidates || [], Applicants.nameFromExplanations(explanations));
  accumulator.addName(chosen.name, chosen.corroborated);
  accumulator.addHeader(Applicants.parseApplicantHeader({
    text: (fixture.headerText || []).join("\n"), name: chosen.name
  }));

  for (const lines of fixture.blocks?.screening || []) accumulator.addScreening(Applicants.parseScreeningBlock(lines));
  for (const lines of fixture.blocks?.experience || []) accumulator.addExperience(Applicants.parseExperienceBlock(lines));
  for (const lines of fixture.blocks?.education || []) accumulator.addEducation(Applicants.parseEducationBlock(lines));
  for (const lines of fixture.blocks?.skills || []) for (const value of lines) accumulator.addSkill(value);

  // The labelled reader's own gates, applied here exactly as the adapter applies
  // them — a fixture must not be able to smuggle a value past a shape rule.
  const labelled = {};
  for (const entry of fixture.labelled || []) {
    const field = entry?.label;
    const value = entry?.value;
    if (!field || !value) continue;
    if (field === "totalExperience" && !Applicants.looksLikeTotalExperience(value)) continue;
    if (field === "location" && !Applicants.looksLikeApplicantLocation(value)) continue;
    if (field === "headline" && !Applicants.looksLikeApplicantHeadline(value, { name: chosen.name })) continue;
    if (field === "currentRole" && !Applicants.isCurrentRoleCandidate(value, { jobTitle: "Legal Associate" })) continue;
    if (field === "currentCompany" && !Applicants.isEmployerCandidate(value, { hiringCompany: "Acme Recruiting" })) continue;
    labelled[field] = value;
  }
  accumulator.addHeader(labelled);

  return Applicants.buildApplicantRecord({
    snapshot: accumulator.snapshot(),
    context: { jobId: "4277798308", applicationId: "25550787924" },
    sourceUrl: "https://www.linkedin.com/hiring/applicants/?applicationId=25550787924&jobId=4277798308",
    buildId: "test"
  });
}

/**
 * The shape of a record, ignoring what is in it.
 *
 * A list is `key[]` and is not descended into. That is deliberate: descending
 * would compare the shape of the FIRST entry, so a layout whose Screening
 * section is empty would report a different "schema" from one whose is not —
 * which is a fact about the applicant, not about the schema, and the first
 * version of this test failed on exactly that. The schema is the record's own
 * keys, and every entry shape is pinned by its parser's own tests.
 */
function deepKeys(value, prefix = "") {
  if (Array.isArray(value)) return [`${prefix}[]`];
  if (!value || typeof value !== "object") return [prefix];
  return Object.keys(value).sort().flatMap((key) => deepKeys(value[key], prefix ? `${prefix}.${key}` : key));
}

/** A pseudonym, which every fixture assigns independently starting at A. */
const PSEUDONYM = /^(?:Person|Company|University) [A-Z]+$/;

test("every captured layout is replayed through the same readers", async () => {
  const fixtures = await loadFixtures();
  assert.ok(fixtures.length >= 2, "at least two layouts, or there is nothing to compare");

  for (const { name, data } of fixtures) {
    assert.equal(data.capture.schemaVersion, Applicants.CAPTURE_SCHEMA_VERSION, `${name} is a capture this build understands`);
    assert.equal(data.capture.surface, "hiring-applicants", `${name} is a hiring capture`);

    // THE ALIAS REGRESSION TEST, and the whole reason a capture is worth
    // taking: every heading the layout rendered, resolved the same way the live
    // reader resolved it. A wording that stops resolving fails here.
    for (const heading of data.sectionScan.headings) {
      assert.equal(Applicants.sectionKeyFor(heading.text), heading.key,
        `${name}: "${heading.text}" must still name ${heading.key || "no section"}`);
      if (heading.bounds) {
        assert.equal(Applicants.anySectionKeyFor(heading.text), heading.bounds,
          `${name}: "${heading.text}" must still bound ${heading.bounds}`);
        assert.equal(Applicants.sectionKeyFor(heading.text), "",
          `${name}: a section that only bounds is never collected`);
      }
    }
    for (const key of data.sectionScan.missing || []) {
      assert.ok(Applicants.REQUIRED_SECTION_KEYS.includes(key), `${name}: only a readable section can be missing`);
    }
  }
});

test("Experience and Education stay separate on every layout", async () => {
  // The guide's own final check, made executable over real captured wordings
  // rather than over hand-written lines.
  for (const { name, data } of await loadFixtures()) {
    for (const lines of data.blocks?.experience || []) {
      const record = Applicants.parseExperienceBlock(lines);
      assert.ok(record, `${name}: an experience card must parse`);
      assert.ok(!Applicants.SPELLED_DEGREE_PATTERN.test(record.title), `${name}: "${record.title}" is a degree, not a job title`);
      assert.ok(!Applicants.INSTITUTION_PATTERN.test(record.company || ""), `${name}: "${record.company}" is a school, not an employer`);
    }
    for (const lines of data.blocks?.education || []) {
      const record = Applicants.parseEducationBlock(lines);
      assert.ok(record, `${name}: an education card must parse`);
      assert.ok(!/\bPresent\b/i.test(record.institution), `${name}: an employment line is not an institution`);
      assert.ok(!Applicants.isSectionTitleLine(record.institution), `${name}: a section title is not an institution`);
    }
    // And the cross-refusal both ways, over this layout's own cards.
    for (const lines of data.blocks?.education || []) {
      assert.equal(Applicants.parseExperienceBlock(lines), null, `${name}: a school is never read as a job`);
    }
  }
});

test("every layout produces the same applicant schema", async () => {
  // The guide's "all layouts produce the same applicant schema", proven rather
  // than asserted in prose: the shapes are compared key for key, at every depth.
  const fixtures = await loadFixtures();
  const records = fixtures.map(({ name, data }) => ({ name, record: recordFrom(data) }));

  const reference = deepKeys(records[0].record);
  for (const { name, record } of records) {
    assert.deepEqual(deepKeys(record), reference, `${name} produces the same shape as ${records[0].name}`);
    assert.equal(Object.keys(record.applicant).length, 17, `${name}: seventeen applicant fields`);
    assert.equal(record.schemaVersion, 1);
  }

  // And each one is a real record rather than an empty shell.
  for (const { name, record } of records) {
    assert.ok(record.applicant.name, `${name}: somebody was identified`);
    assert.ok(record.applicant.experience.length, `${name}: at least one role was read`);
    assert.ok(record.applicant.education.length, `${name}: at least one school was read`);
    assert.ok(record.applicant.skills.length, `${name}: at least one skill was read`);
    assert.ok(record.applicant.currentRole, `${name}: a current role was resolved`);
    assert.ok(record.applicant.currentCompany, `${name}: and a current company`);
  }
});

test("no layout's data reaches another layout's record", async () => {
  // The guide's "no applicant-data leakage", executable: a value distinctive to
  // one layout must not appear in another's record.
  //
  // PSEUDONYMS ARE EXCLUDED, and that is not a loophole. Every fixture is
  // sanitized independently and each starts numbering at A, so "Person A" and
  // "University A" appear in all of them by construction — comparing those
  // measures the pseudonymiser, not the readers. The first version of this test
  // did exactly that and failed on it. What is compared is everything a layout
  // does NOT share: its job titles, degrees, skills and date lines.
  const fixtures = await loadFixtures();
  const records = fixtures.map(({ name, data }) => ({ name, json: JSON.stringify(recordFrom(data)), data }));

  let compared = 0;
  for (const mine of records) {
    for (const theirs of records) {
      if (mine === theirs) continue;
      const theirValues = [
        ...(theirs.data.blocks?.experience || []).flat(),
        ...(theirs.data.blocks?.education || []).flat(),
        ...(theirs.data.blocks?.skills || []).flat()
      ].filter((value) => value.length > 8 && !PSEUDONYM.test(value));
      for (const value of theirValues) {
        compared += 1;
        assert.ok(!mine.json.includes(value),
          `${mine.name} must not contain "${value}", which belongs to ${theirs.name}`);
      }
    }
  }
  assert.ok(compared > 10, `the comparison must have something to compare (found ${compared})`);
});

test("a capture carries no address, no number and nobody's name", async () => {
  // Phase 9 sanitizes; this is the standing check that every fixture ON DISK
  // actually came out that way, so a hand-edited or hand-added one cannot
  // quietly reintroduce an identifier.
  for (const { name, data } of await loadFixtures()) {
    const serialized = JSON.stringify(data);
    assert.ok(!/https?:\/\/(?!redacted\.example)/.test(serialized), `${name} stores no address`);
    assert.ok(!/@(?!example\.com)/.test(serialized), `${name} stores no email`);
    assert.ok(!/applicationId|jobId|licdn/.test(serialized), `${name} stores no identifier from a hiring or media URL`);
    assert.ok(!/bearer|csrf|jsessionid|li_at|api[-_]?key/i.test(serialized), `${name} stores no credential`);

    // Links survive only as kinds.
    for (const link of data.links || []) {
      assert.deepEqual(Object.keys(link), ["rel"], `${name}: a link is a kind, never an address`);
      assert.ok(Applicants.CAPTURE_LINK_RELATIONS.includes(link.rel), `${name}: "${link.rel}" is a known kind`);
    }

    // People are pseudonyms, and the same person is the same pseudonym.
    const person = data.headerText?.[0] || "";
    assert.match(person, /^Person [A-Z]+$/, `${name}: the applicant is a pseudonym`);
    for (const candidate of data.nameCandidates || []) {
      assert.match(candidate.value, /^Person [A-Z]+$/, `${name}: and so is every candidate for them`);
    }
  }
});
