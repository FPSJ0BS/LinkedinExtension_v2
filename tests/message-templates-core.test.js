/**
 * Applicant message templating (TASK-0181).
 *
 * The whole feature turns on one refusal — a message with a hole in it must be
 * impossible to insert — so most of what follows is an assertion about what the
 * core will NOT produce. The record fixtures are the shapes the live hiring
 * surface has actually stored, including "RAHUL Mishra", which is why a
 * title-cased companion variable exists at all.
 *
 * The core is loaded on its own here, with no profile core beside it: it must
 * answer identically as a lone content script, so its `cleanText` fallback is
 * exercised by every test in this file rather than by none of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await import("../src/message-templates-core.js");
const Templates = globalThis.ProfileVaultMessageTemplates;

/**
 * Source with its comments removed, as in the applicants core's own tests: this
 * file explains in prose exactly which things it refuses to touch, and a check
 * that a word is absent would otherwise be failed by the sentence explaining
 * its absence.
 */
function withoutComments(source) {
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** A record of the shape `normalizeApplicantRecord` returns, live values. */
const RAHUL = {
  id: "job-4277798308::rahul",
  applicationId: "25550787924",
  job: {
    id: "4277798308",
    title: "Senior Frontend Engineer",
    company: "Acme Technologies",
    location: "Remote"
  },
  applicant: {
    name: "RAHUL Mishra",
    profileUrl: "https://www.linkedin.com/in/rahul-mishra",
    headline: "Business Development Executive at Brevity Software Solutions",
    location: "Lucknow, Uttar Pradesh, India",
    currentRole: "Business Development Executive",
    currentCompany: "Brevity Software Solutions PVT. LTD.",
    totalExperience: "3 years",
    appliedAt: "2 weeks ago",
    contactedAt: null,
    contact: { email: null, phone: null, website: null, other: [] },
    resume: { available: true },
    experience: [],
    // The first entry names a qualification and no school, exactly as a
    // compressed Insights card renders one.
    education: [
      { institution: "", degree: "BBA" },
      { institution: "University of Lucknow", degree: "B.Com" }
    ],
    skills: [],
    screeningResponses: [],
    qualifications: [],
    applicationStatus: null
  },
  extraction: { timestamp: "2026-08-25T00:00:00.000Z" }
};

/** The same shape with nothing in it — the record a thin list row produces. */
const EMPTY = { job: {}, applicant: {} };

test("the message templates core stays an export-free, DOM-free, framework-free IIFE", async () => {
  const source = await readFile(resolve(root, "src/message-templates-core.js"), "utf8");
  assert.ok(!/^\s*(?:import|export)\s/m.test(source), "it must stay an export-free IIFE");
  assert.ok(!/React/.test(source), "it must not reference React");
  assert.match(source, /globalThis\.ProfileVaultMessageTemplates/, "it must publish its API on globalThis");

  const code = withoutComments(source);
  assert.ok(!/\bdocument\b|\bwindow\b/.test(code), "nothing in the core may touch the DOM");
  // The lastIndex hazard, closed at the source rather than argued about: a
  // `/g` regex driven by `.test()` or `.exec()` carries its cursor between
  // calls and silently skips every other match, and a template is parsed on
  // every keystroke of a preview. This file drives no regex that way at all —
  // the scanner has no state to leak.
  assert.ok(!/\.(?:test|exec)\(/.test(code), "no regex may be driven by .test() or .exec() in this core");
});

test("the ceilings are the ones the messaging surface actually has", () => {
  assert.deepEqual(Templates.TEMPLATE_LIMITS, { NAME_MAX: 80, BODY_MAX: 8000, BODY_INMAIL_WARN: 1900 });
});

test("the variable palette is self-describing, and every token it offers has a reader behind it", () => {
  const palette = Templates.TEMPLATE_VARIABLES;
  assert.ok(palette.length >= 12, "the palette must offer every variable the spec lists");
  for (const entry of palette) {
    assert.equal(typeof entry.name, "string");
    assert.equal(entry.token, `{{${entry.name}}}`, "the token is the name in braces, so the UI can insert it verbatim");
    assert.ok(entry.label, `${entry.name} needs a label the recruiter can read`);
    assert.ok(entry.source, `${entry.name} must say which record field it comes from`);
    assert.ok(entry.example, `${entry.name} needs an example so the shape is visible before insertion`);
    assert.equal(Templates.describeVariable(entry.name), entry);
    assert.equal(Templates.isKnownVariable(entry.name), true);
  }

  const names = palette.map((entry) => entry.name);
  assert.deepEqual(names, Templates.TEMPLATE_VARIABLE_NAMES);
  assert.equal(new Set(names).size, names.length, "no token may be offered twice");
  // The palette and the reader table are two lists, so this is the assertion
  // that stops them drifting: a token with no reader would render empty for
  // everybody and look like missing data instead of a missing reader.
  assert.deepEqual(Object.keys(Templates.applicantVariableValues(RAHUL)), names);

  assert.equal(Templates.isKnownVariable("salary"), false);
  assert.equal(Templates.isKnownVariable(""), false);
  assert.equal(Templates.describeVariable("salary"), null);
});

test("an applicant record fills every variable, and the first entry that names a school is the education", () => {
  const values = Templates.applicantVariableValues(RAHUL);
  assert.equal(values.full_name, "RAHUL Mishra");
  assert.equal(values.first_name, "RAHUL");
  assert.equal(values.first_name_titled, "Rahul");
  assert.equal(values.headline, "Business Development Executive at Brevity Software Solutions");
  assert.equal(values.location, "Lucknow, Uttar Pradesh, India");
  assert.equal(values.current_role, "Business Development Executive");
  assert.equal(values.current_company, "Brevity Software Solutions PVT. LTD.");
  assert.equal(values.total_experience, "3 years");
  // Not `education[0]`, which holds a degree and no institution: answering ""
  // for somebody whose record names their university is a missing value where
  // a real one exists.
  assert.equal(values.education, "University of Lucknow");
  assert.equal(values.job_title, "Senior Frontend Engineer");
  assert.equal(values.job_company, "Acme Technologies");
  assert.equal(values.applied_at, "2 weeks ago");
});

test("a field the record does not hold is an empty string, never a placeholder", () => {
  const values = Templates.applicantVariableValues(EMPTY);
  for (const name of Templates.TEMPLATE_VARIABLE_NAMES) {
    assert.equal(values[name], "", `${name} must be blank, not invented`);
  }
  // Rule 1 at the level of the value itself: nothing here may read as a real
  // answer. "N/A", "there" and "Unknown" are all wrong values, and a wrong
  // value in a message reaches a person.
  assert.deepEqual(Templates.applicantVariableValues(), values);
  assert.deepEqual(Templates.applicantVariableValues(null), values);
  assert.deepEqual(Templates.applicantVariableValues({ applicant: null, job: null }), values);
  // A record holding nulls rather than missing keys answers the same way.
  assert.equal(Templates.applicantVariableValues({ applicant: { name: null, education: null }, job: {} }).full_name, "");
});

test("the stored record is handed over exactly as it was stored, never taken apart by the caller", () => {
  // `normalizeApplicantRecord` returns `{ id, applicationId, job, applicant,
  // extraction }`, so the record IS a valid argument and a caller cannot get
  // the destructuring subtly wrong.
  assert.deepEqual(
    Templates.applicantVariableValues(RAHUL),
    Templates.applicantVariableValues({ applicant: RAHUL.applicant, job: RAHUL.job })
  );
});

test("a shouted first name is un-shouted, because live records really do hold 'RAHUL Mishra'", () => {
  assert.equal(Templates.titleCaseName("RAHUL"), "Rahul");
  assert.equal(Templates.titleCaseName("rahul"), "Rahul");
  assert.equal(Templates.titleCaseName("RAHUL MISHRA"), "Rahul Mishra");
  assert.equal(Templates.firstNameFrom("RAHUL Mishra"), "RAHUL");
  assert.equal(Templates.firstNameFrom("  RAHUL   Mishra "), "RAHUL");
  assert.equal(Templates.firstNameFrom(""), "");
  assert.equal(Templates.titleCaseName(null), "");
  assert.equal(Templates.titleCaseName("   "), "");
});

test("a name that carries its own capitalisation is never re-cased", () => {
  // Mixed case is the person's own spelling. Rule 1 applies to a name as much
  // as to a phone number: "Mcdonald" is a wrong value, and a wrong value is
  // worse than the untouched one we already had.
  for (const name of ["McDonald", "de Souza", "O'Brien", "van der Berg", "Rahul Mishra", "RAHUL Mishra"]) {
    assert.equal(Templates.titleCaseName(name), name, `${name} must survive untouched`);
  }
});

test("an all-lower or all-caps name is title-cased through its hyphens, apostrophes and stops", () => {
  assert.equal(Templates.titleCaseName("O'BRIEN"), "O'Brien");
  assert.equal(Templates.titleCaseName("mary-jane"), "Mary-Jane");
  assert.equal(Templates.titleCaseName("j.k. rowling"), "J.K. Rowling");
  // The one thing a shouted name cannot recover, stated rather than hidden:
  // "MCDONALD" has no signal left in it, which is why `{{first_name}}` still
  // exists beside `{{first_name_titled}}`.
  assert.equal(Templates.titleCaseName("MCDONALD"), "Mcdonald");
  // Nothing that is not a letter is touched.
  assert.equal(Templates.titleCaseName("123"), "123");
});

test("a body splits into literal text and variable references, in reading order", () => {
  const parsed = Templates.parseTemplateBody("Hi {{first_name}}, about {{job_title}}.");
  assert.deepEqual(parsed.segments.map((segment) => segment.type), ["text", "variable", "text", "variable", "text"]);
  assert.deepEqual(parsed.segments[0], { type: "text", value: "Hi " });
  assert.deepEqual(parsed.segments[1], {
    type: "variable",
    name: "first_name",
    fallback: "",
    raw: "{{first_name}}",
    known: true
  });
  assert.deepEqual(parsed.names, ["first_name", "job_title"]);
  assert.deepEqual(parsed.unknown, []);
  assert.equal(parsed.variables.length, 2);

  // A name repeated is one name and two references — the palette shows it once,
  // the renderer fills it twice.
  const twice = Templates.parseTemplateBody("{{first_name}} {{first_name}}");
  assert.deepEqual(twice.names, ["first_name"]);
  assert.equal(twice.variables.length, 2);
});

test("a variable may carry a fallback, and only the first pipe divides it", () => {
  const parsed = Templates.parseTemplateBody("Hi {{ first_name | there|friend }}!");
  assert.equal(parsed.variables[0].name, "first_name", "the name is trimmed, so spacing inside the braces is free");
  assert.equal(parsed.variables[0].fallback, "there|friend", "a pipe inside the fallback is part of the fallback");
  assert.equal(parsed.variables[0].known, true);
});

test("an escaped brace renders a literal brace and never opens a reference", () => {
  const parsed = Templates.parseTemplateBody("Use \\{\\{first_name\\}\\} to insert a name.");
  assert.deepEqual(parsed.variables, [], "an escaped reference is not a reference");
  const rendered = Templates.renderTemplate({ body: "Use \\{\\{first_name\\}\\} to insert a name.", values: {} });
  assert.equal(rendered.text, "Use {{first_name}} to insert a name.");
  assert.deepEqual(rendered.unresolved, []);
  assert.deepEqual(rendered.unknown, []);
  // A backslash before anything else is a backslash the recruiter typed.
  assert.equal(Templates.renderTemplate({ body: "C:\\path\\to", values: {} }).text, "C:\\path\\to");
});

test("an unterminated reference is text a recruiter is still typing, not a broken variable", () => {
  const parsed = Templates.parseTemplateBody("Hi {{first_name");
  assert.deepEqual(parsed.variables, []);
  assert.deepEqual(parsed.unknown, [], "no error may flash under the cursor mid-keystroke");
  assert.equal(Templates.renderTemplate({ body: "Hi {{first_name", values: {} }).text, "Hi {{first_name");
});

test("parsing keeps no cursor between calls, so the same body answers identically every time", () => {
  // The lastIndex hazard, executed rather than asserted about: a `/g` regex
  // driven by `.test()`/`.exec()` would find the references on the first call
  // and skip half of them on the second.
  const body = "{{first_name}} {{job_title}} {{location}} {{salary}}";
  const first = Templates.parseTemplateBody(body);
  const second = Templates.parseTemplateBody(body);
  const third = Templates.parseTemplateBody(body);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.deepEqual(first.names, ["first_name", "job_title", "location", "salary"]);

  const values = Templates.applicantVariableValues(RAHUL);
  assert.deepEqual(Templates.renderTemplate({ body, values }), Templates.renderTemplate({ body, values }));
  assert.deepEqual(
    Templates.validateTemplate({ name: "Outreach", body }),
    Templates.validateTemplate({ name: "Outreach", body })
  );
});

test("an unknown variable is reported and rendered as nothing — never as its own literal", () => {
  const rendered = Templates.renderTemplate({
    body: "Hi {{first_name}}, we pay {{salary}}.",
    values: Templates.applicantVariableValues(RAHUL)
  });
  // A literal `{{salary}}` arriving in a real conversation tells the applicant
  // they were mail-merged and tells the recruiter nothing until it is too late.
  assert.equal(rendered.text, "Hi RAHUL, we pay .");
  assert.deepEqual(rendered.unknown, ["salary"]);
  assert.deepEqual(rendered.unresolved, [], "an unknown name is not an unresolved value — they are different repairs");

  // A reference with no name at all reports itself rather than an empty string,
  // so the UI has something to show.
  assert.deepEqual(Templates.parseTemplateBody("Hi {{}}").unknown, ["{{}}"]);
});

test("a value fills its variable; an empty value with a fallback resolves to the fallback", () => {
  const values = Templates.applicantVariableValues(RAHUL);
  const filled = Templates.renderTemplate({ body: "Hi {{first_name_titled}}, re {{job_title}}.", values });
  assert.equal(filled.text, "Hi Rahul, re Senior Frontend Engineer.");
  assert.deepEqual(filled.unresolved, []);

  const fallback = Templates.renderTemplate({
    body: "Hi {{first_name|there}}, about your application.",
    values: Templates.applicantVariableValues(EMPTY)
  });
  assert.equal(fallback.text, "Hi there, about your application.");
  assert.deepEqual(fallback.unresolved, [], "a fallback RESOLVES — that is the whole point of writing one");
});

test("a whitespace-only fallback is not a fallback", () => {
  const rendered = Templates.renderTemplate({
    body: "Hi {{first_name|   }},",
    values: Templates.applicantVariableValues(EMPTY)
  });
  // Resolving to " " would put "Hi  ," in front of a person and report the
  // message as fine — the exact failure this core exists to prevent, wearing a
  // disguise.
  assert.equal(rendered.text, "Hi ,");
  assert.deepEqual(rendered.unresolved, ["first_name"]);
});

test("a message that would read 'Hi ,' is BLOCKED, never merely warned about", () => {
  // This is the assertion the feature rests on. Rule 1 says a missing value
  // stays empty and a wrong value is worse than a blank — and here the blank is
  // not a column in a CSV the recruiter can inspect, it is a sentence sent to a
  // person in the recruiter's own name.
  const preview = Templates.previewTemplate({ body: "Hi {{first_name}},", applicant: {}, job: {} });
  assert.equal(preview.text, "Hi ,", "the preview still shows exactly what would have been sent");
  assert.deepEqual(preview.unresolved, ["first_name"]);
  assert.equal(preview.blocked, true, "an unresolved variable blocks insertion outright");
  assert.deepEqual(preview.warnings, [], "this is not a warning — there is no severity dial to turn down");

  // And the repair, in the same test, so the block is provably not a dead end:
  // give the variable a fallback, or an applicant who has the value.
  assert.equal(Templates.previewTemplate({ body: "Hi {{first_name|there}},", applicant: {}, job: {} }).blocked, false);
  assert.equal(Templates.previewTemplate({ body: "Hi {{first_name}},", ...RAHUL }).blocked, false);
});

test("one unresolved variable blocks a message in which everything else resolved", () => {
  const preview = Templates.previewTemplate({
    body: "Hi {{first_name_titled}}, I saw you studied at {{education}} and work at {{current_company}}.",
    applicant: { name: "Priya Sharma", currentCompany: "Acme" },
    job: RAHUL.job
  });
  assert.equal(preview.text, "Hi Priya, I saw you studied at  and work at Acme.");
  assert.deepEqual(preview.unresolved, ["education"]);
  assert.equal(preview.blocked, true, "a hole anywhere is still a hole");
});

test("an unknown variable blocks the message even when every known one resolved", () => {
  const preview = Templates.previewTemplate({ body: "Hi {{first_name}} — {{salary}}", ...RAHUL });
  assert.deepEqual(preview.unknown, ["salary"]);
  assert.deepEqual(preview.unresolved, []);
  assert.equal(preview.blocked, true);
});

test("a fully resolved message is not blocked, and reports its own length and values", () => {
  const preview = Templates.previewTemplate({
    body: "Hi {{first_name_titled}},\n\nI'm hiring a {{job_title}} at {{job_company}} and your {{total_experience}} at {{current_company}} stood out.",
    ...RAHUL
  });
  assert.equal(
    preview.text,
    "Hi Rahul,\n\nI'm hiring a Senior Frontend Engineer at Acme Technologies and your 3 years at Brevity Software Solutions PVT. LTD. stood out."
  );
  assert.equal(preview.length, preview.text.length);
  assert.equal(preview.blocked, false);
  assert.deepEqual(preview.warnings, []);
  assert.deepEqual(preview.unresolved, []);
  assert.deepEqual(preview.unknown, []);
  assert.equal(preview.values.first_name_titled, "Rahul", "the preview carries the values it used, for a UI that shows them");
  // Line breaks are the recruiter's own and survive: a body is never cleaned
  // the way a collected value is.
  assert.ok(preview.text.includes("\n\n"));
});

test("a message with nothing left in it is blocked, because an empty insertion is not a message", () => {
  assert.equal(Templates.previewTemplate({ body: "   ", ...RAHUL }).blocked, true);
  assert.equal(Templates.previewTemplate({ body: "", ...RAHUL }).blocked, true);
  assert.equal(Templates.previewTemplate({}).blocked, true);
  const empty = Templates.previewTemplate({ body: "{{first_name}}", applicant: {}, job: {} });
  assert.equal(empty.text, "");
  assert.equal(empty.blocked, true);
});

test("the InMail ceiling warns and the message ceiling blocks — the extension cannot tell which thread this is", () => {
  const long = `Hi {{first_name_titled}}. ${"x".repeat(1900)}`;
  const warned = Templates.previewTemplate({ body: long, ...RAHUL });
  assert.equal(warned.blocked, false, "the InMail limit is a caution; refusing on a guess costs a message they may send");
  assert.equal(warned.warnings.length, 1);
  assert.equal(warned.warnings[0].code, Templates.PREVIEW_WARNING.INMAIL_LENGTH);
  assert.match(warned.warnings[0].message, /1900/);

  const short = Templates.previewTemplate({ body: `Hi {{first_name}}. ${"x".repeat(1000)}`, ...RAHUL });
  assert.deepEqual(short.warnings, []);

  const over = Templates.previewTemplate({ body: "x".repeat(8001), ...RAHUL });
  assert.equal(over.blocked, true);
  assert.equal(over.length, 8001);
  assert.deepEqual(over.warnings, [], "a blocked message is not also warned about — it is not going anywhere");
});

test("a template with no name and no body reports both problems at once, never one refusal at a time", () => {
  const problems = Templates.validateTemplate({ name: "  ", body: "\n \n" });
  assert.deepEqual(problems.map((problem) => [problem.field, problem.code]), [
    ["name", Templates.TEMPLATE_PROBLEM.NAME_REQUIRED],
    ["body", Templates.TEMPLATE_PROBLEM.BODY_REQUIRED]
  ]);
  for (const problem of problems) assert.ok(problem.message, "every problem carries a sentence the form can show");
  assert.deepEqual(Templates.validateTemplate().map((problem) => problem.code), [
    Templates.TEMPLATE_PROBLEM.NAME_REQUIRED,
    Templates.TEMPLATE_PROBLEM.BODY_REQUIRED
  ]);
});

test("a name over 80 characters and a body over 8000 are each refused, and at their own ceilings", () => {
  assert.deepEqual(Templates.validateTemplate({ name: "n".repeat(80), body: "x".repeat(8000) }), []);
  const problems = Templates.validateTemplate({ name: "n".repeat(81), body: "x".repeat(8001) });
  assert.deepEqual(problems.map((problem) => problem.code), [
    Templates.TEMPLATE_PROBLEM.NAME_TOO_LONG,
    Templates.TEMPLATE_PROBLEM.BODY_TOO_LONG
  ]);
  // Trimmed, so trailing whitespace never costs a template that fits.
  assert.deepEqual(Templates.validateTemplate({ name: `  ${"n".repeat(80)}  `, body: `  ${"x".repeat(8000)}  ` }), []);
});

test("a duplicate name is a duplicate whatever its case, but a template is not a duplicate of itself", () => {
  const existing = ["First outreach", "Follow up"];
  const problems = Templates.validateTemplate({ name: "  first OUTREACH ", body: "Hi.", existingNames: existing });
  assert.deepEqual(problems.map((problem) => problem.code), [Templates.TEMPLATE_PROBLEM.NAME_DUPLICATE]);
  assert.match(problems[0].message, /already exists/);
  assert.deepEqual(Templates.validateTemplate({ name: "Second outreach", body: "Hi.", existingNames: existing }), []);

  // The store keeps records, not bare strings, so both are accepted — and
  // re-saving a template under its own name must not accuse it of colliding
  // with itself.
  const records = [{ id: "t1", name: "First outreach" }, { id: "t2", name: "Follow up" }];
  assert.deepEqual(Templates.validateTemplate({ id: "t1", name: "First outreach", body: "Hi.", existingNames: records }), []);
  assert.equal(
    Templates.validateTemplate({ id: "t2", name: "First outreach", body: "Hi.", existingNames: records })[0].code,
    Templates.TEMPLATE_PROBLEM.NAME_DUPLICATE
  );
  assert.deepEqual(Templates.validateTemplate({ name: "Anything", body: "Hi.", existingNames: null }), []);
});

test("an unknown variable in the body is a validation problem that names the token it refuses", () => {
  const problems = Templates.validateTemplate({ name: "Outreach", body: "Hi {{first_name}}, {{salary}} {{notice_period}}" });
  assert.deepEqual(problems.map((problem) => problem.code), [
    Templates.TEMPLATE_PROBLEM.BODY_UNKNOWN_VARIABLE,
    Templates.TEMPLATE_PROBLEM.BODY_UNKNOWN_VARIABLE
  ]);
  assert.deepEqual(problems.map((problem) => problem.variable), ["salary", "notice_period"]);
  assert.match(problems[0].message, /\{\{salary\}\}/);
  assert.equal(problems[0].field, "body");
});

test("a valid template returns an empty list, and a bare variable is legal in a STORED template", () => {
  // Whether `{{first_name}}` resolves depends on the applicant, which is
  // `previewTemplate`'s question and is asked again for every person. Refusing
  // to store the template would refuse it for the applicants it fits.
  assert.deepEqual(
    Templates.validateTemplate({
      name: "First outreach",
      body: "Hi {{first_name_titled}},\n\nI'm hiring a {{job_title}}. {{education|Your background}} caught my eye.",
      existingNames: ["Follow up"]
    }),
    []
  );
  assert.ok(Array.isArray(Templates.validateTemplate({ name: "x", body: "y" })), "validation is always a list, never a boolean");
});
