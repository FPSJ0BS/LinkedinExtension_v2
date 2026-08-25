/**
 * Message recipients, and the templates an audience makes impossible.
 *
 * Two different failures are under test here and the file is organised around
 * keeping them apart. One is per-person: this applicant has no current company,
 * so this one message would arrive with a hole in it. The other is structural:
 * a connection has no job application, so `{{job_title}}` cannot resolve for
 * ANYBODY in that audience, and a batch pointed at connections would send the
 * same broken sentence to every one of them. The second is knowable before a
 * record is read, which is the whole reason the module exists.
 *
 * The record fixtures are the shapes the two stores actually hold -
 * `normalizeApplicantRecord` for an applicant, `normalizeProfile` for a saved
 * connection - including "RAHUL Mishra", which is a live value and is why a
 * title-cased variable exists at all.
 *
 * The profile core is loaded beside the other two because the dashboards load
 * it: `canonicalizeProfileUrl` decides part of a recipient's identity, and
 * asserting ids against a fallback that is not what ships would assert nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await import("../src/extraction-core.js");
await import("../src/message-templates-core.js");
await import("../src/message-recipients.js");
const Templates = globalThis.ProfileVaultMessageTemplates;
const Recipients = globalThis.ProfileVaultMessageRecipients;

/**
 * Source with its comments removed, as in the applicants core's own tests: this
 * file explains in prose exactly which fields it refuses to read, and a check
 * that a name is absent would otherwise be failed by the sentence explaining
 * its absence. Line endings are normalised first so a CRLF checkout answers the
 * same as an LF one.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

// --------------------------------------------------------------- the fixtures

/** A record of the shape `normalizeApplicantRecord` returns, live values. */
const RAHUL_ON_FRONTEND = Object.freeze({
  id: "applicant_1a2b3c",
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
    contact: { email: null, phone: null, website: null, other: [] },
    resume: { available: true },
    experience: [],
    education: [
      // The first entry names a qualification and no school, exactly as a
      // compressed Insights card renders one.
      { institution: "", degree: "BBA" },
      { institution: "University of Lucknow", degree: "B.Com" }
    ],
    skills: []
  }
});

/**
 * The same live shape with the employer never disclosed - the commonest thin
 * record the hiring surface produces, and the reason `missing` exists.
 */
const PRIYA_NO_COMPANY = Object.freeze({
  applicationId: "25550788001",
  job: { id: "4277798308", title: "Senior Frontend Engineer", company: "Acme Technologies" },
  applicant: {
    name: "Priya Singh",
    profileUrl: "https://www.linkedin.com/in/priya-singh",
    headline: "Frontend Engineer",
    location: "Pune, Maharashtra, India",
    currentRole: "Frontend Engineer",
    currentCompany: null,
    totalExperience: null,
    appliedAt: "3 days ago",
    education: []
  }
});

/** A record of the shape `normalizeProfile` returns. */
const SAVED_CONNECTION = Object.freeze({
  id: "profile_9f8e7d",
  fullName: "RAHUL Mishra",
  firstName: "RAHUL",
  lastName: "Mishra",
  headline: "Business Development Executive at Brevity Software Solutions",
  location: "Lucknow, Uttar Pradesh, India",
  about: "I build things.",
  profileUrl: "https://www.linkedin.com/in/rahul-mishra",
  // Stored as one institution name per line, which is what the table leads its
  // Education cell with.
  education: ["", "University of Lucknow"],
  experience: ["Business Development Executive - Brevity Software Solutions"],
  skills: ["Sales"],
  status: "collected"
});

const CONNECTION_NO_HEADLINE = Object.freeze({
  id: "profile_1122aa",
  fullName: "Aisha Khan",
  headline: "",
  location: "",
  profileUrl: "https://www.linkedin.com/in/aisha-khan",
  education: [],
  experience: []
});

// ------------------------------------------------------------- the file itself

test("the recipients core stays an export-free, DOM-free IIFE that publishes on globalThis", async () => {
  const source = await readFile(resolve(root, "src/message-recipients.js"), "utf8");
  const code = withoutComments(source);
  assert.ok(!/^\s*(?:import|export)\s/m.test(source), "it must stay an export-free IIFE");
  assert.ok(!/\b(?:document|window|chrome)\b/.test(code), "it must not touch the DOM or the extension APIs");
  assert.ok(!/React/.test(code), "it must not reference React");
  assert.ok(/globalThis\.ProfileVaultMessageRecipients = api;/.test(code), "it must publish on globalThis");
  assert.equal(typeof Recipients, "object");
});

test("it re-implements no extraction: no record field behind a variable is read here", async () => {
  const code = withoutComments(await readFile(resolve(root, "src/message-recipients.js"), "utf8"));
  // The values map is `applicantVariableValues`' answer and nobody else's. A
  // second reader for any of these would be a second answer to the same
  // question, and the two would drift the moment one of them was fixed.
  for (const field of ["currentRole", "currentCompany", "totalExperience", "appliedAt"]) {
    assert.ok(!code.includes(field), `${field} must be read by the templates core, never here`);
  }
  // One call site - `valuesAndMissing` - and nowhere else, so both mappers get
  // their values from the same place and cannot answer differently.
  assert.equal((code.match(/templates\.applicantVariableValues\(/g) || []).length, 1);
});

test("it reads the templates core lazily, so load order cannot break it", async () => {
  const code = withoutComments(await readFile(resolve(root, "src/message-recipients.js"), "utf8"));
  assert.ok(/const TEMPLATES = \(\) => globalThis\.ProfileVaultMessageTemplates/.test(code));
  assert.ok(/const CORE = \(\) => globalThis\.ProfileVaultCore/.test(code));
  // Exactly one mention each, both inside those accessors: a module-level
  // `const Templates = globalThis...` would capture whatever was loaded first.
  assert.equal((code.match(/globalThis\.ProfileVaultMessageTemplates/g) || []).length, 1);
  assert.equal((code.match(/globalThis\.ProfileVaultCore/g) || []).length, 1);
});

// ------------------------------------------------------------ applicants in

test("an applicant record becomes a recipient carrying the palette's own values", () => {
  const recipient = Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND);
  assert.equal(recipient.source, Recipients.AUDIENCE.APPLICANTS);
  assert.equal(recipient.name, "RAHUL Mishra");
  assert.equal(recipient.profileUrl, "https://www.linkedin.com/in/rahul-mishra");
  assert.equal(recipient.applicationId, "25550787924");
  // Delegated, not re-derived - so the shouted live name is un-shouted by the
  // one function that knows how, and the first entry with no school is skipped.
  assert.equal(recipient.values.first_name_titled, "Rahul");
  assert.equal(recipient.values.education, "University of Lucknow");
  assert.equal(recipient.values.job_title, "Senior Frontend Engineer");
  assert.equal(recipient.values.job_company, "Acme Technologies");
  assert.deepEqual(recipient.missing, []);
});

test("an applicant with no current company reports it missing and never invents one", () => {
  const recipient = Recipients.toApplicantRecipient(PRIYA_NO_COMPANY);
  assert.equal(recipient.values.current_company, "", "a missing value stays empty");
  assert.equal(recipient.values.current_role, "Frontend Engineer", "a value that is there is still read");
  assert.ok(recipient.missing.includes("current_company"));
  assert.ok(recipient.missing.includes("total_experience"));
  assert.ok(recipient.missing.includes("education"));
  assert.ok(!recipient.missing.includes("current_role"));
});

test("a separate job record supplements the record's own job and never blanks it", () => {
  const bare = { ...RAHUL_ON_FRONTEND, job: { id: "4277798308" } };
  const supplemented = Recipients.toApplicantRecipient(bare, {
    id: "4277798308",
    title: "Senior Frontend Engineer",
    company: "Acme Technologies"
  });
  assert.equal(supplemented.values.job_title, "Senior Frontend Engineer");
  assert.equal(supplemented.values.job_company, "Acme Technologies");
  // And the other way round: a job record with nothing on it cannot empty a
  // title the applicant record already carried.
  const kept = Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND, { id: "4277798308" });
  assert.equal(kept.values.job_title, "Senior Frontend Engineer");
});

test("a bare applicant object is accepted beside the nested record shape", () => {
  const recipient = Recipients.toApplicantRecipient({
    name: "Priya Singh",
    profileUrl: "https://www.linkedin.com/in/priya-singh",
    headline: "Frontend Engineer"
  });
  assert.equal(recipient.name, "Priya Singh");
  assert.equal(recipient.values.headline, "Frontend Engineer");
  assert.equal(recipient.applicationId, "");
});

// -------------------------------------------------------------- identity

test("an applicant is a person ON A JOB, so the same person on two posts is two recipients", () => {
  const frontend = Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND);
  const backend = Recipients.toApplicantRecipient({
    ...RAHUL_ON_FRONTEND,
    id: "applicant_4d5e6f",
    applicationId: "25550999111",
    job: { id: "4277799999", title: "Senior Backend Engineer", company: "Acme Technologies" }
  });
  assert.equal(frontend.name, backend.name);
  assert.notEqual(frontend.id, backend.id, "one person on two jobs is two recipients (rule 17)");
});

test("the same person applying twice to one job is two recipients", () => {
  const first = Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND);
  const second = Recipients.toApplicantRecipient({ ...RAHUL_ON_FRONTEND, applicationId: "25551111222" });
  assert.notEqual(first.id, second.id, "two applications are two records and two recipients");
});

test("a recipient id is stable: the same record mapped twice answers the same id", () => {
  const once = Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND);
  const twice = Recipients.toApplicantRecipient({ ...RAHUL_ON_FRONTEND });
  assert.equal(once.id, twice.id);
  assert.ok(once.id.startsWith("recipient_applicants_"));
  const connection = Recipients.toConnectionRecipient(SAVED_CONNECTION);
  assert.equal(connection.id, Recipients.toConnectionRecipient({ ...SAVED_CONNECTION }).id);
  assert.ok(connection.id.startsWith("recipient_connections_"));
});

test("the same member as an applicant and as a connection is never the same recipient", () => {
  // Same name, same page, two stores: a batch aimed at one must never pick up
  // the record from the other, so the source is part of the identity.
  const applicant = Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND);
  const connection = Recipients.toConnectionRecipient(SAVED_CONNECTION);
  assert.equal(applicant.profileUrl, connection.profileUrl);
  assert.notEqual(applicant.id, connection.id);
  assert.notEqual(applicant.source, connection.source);
});

// ----------------------------------------------------------- connections in

test("a connection becomes a recipient with no application at all", () => {
  const recipient = Recipients.toConnectionRecipient(CONNECTION_NO_HEADLINE);
  assert.equal(recipient.source, Recipients.AUDIENCE.CONNECTIONS);
  assert.equal(recipient.name, "Aisha Khan");
  assert.equal(recipient.applicationId, "", "a connection has no application - not a blank one, none");
  assert.equal(recipient.values.job_title, "");
  assert.equal(recipient.values.job_company, "");
  assert.equal(recipient.values.applied_at, "");
  // In palette order, so two recipients' lists are comparable at a glance.
  assert.deepEqual(recipient.missing, [
    "headline", "location", "current_role", "current_company",
    "total_experience", "education", "job_title", "job_company", "applied_at"
  ]);
});

test("a connection with no headline keeps it empty rather than reaching for the About text", () => {
  const recipient = Recipients.toConnectionRecipient(CONNECTION_NO_HEADLINE);
  assert.equal(recipient.values.headline, "");
  assert.ok(recipient.missing.includes("headline"));
  // And one that has a headline still reads it.
  assert.equal(
    Recipients.toConnectionRecipient(SAVED_CONNECTION).values.headline,
    "Business Development Executive at Brevity Software Solutions"
  );
});

test("a connection's education lines become the school the palette names", () => {
  const recipient = Recipients.toConnectionRecipient(SAVED_CONNECTION);
  // Stored as strings rather than entries, and the first one names nothing.
  assert.equal(recipient.values.education, "University of Lucknow");
  assert.equal(recipient.values.first_name_titled, "Rahul");
});

test("a connection's retired role fields are left empty rather than derived", () => {
  // 3.6.0 retired `currentRole`/`currentCompany`/`totalExperience` from the
  // stored profile because a derived role that disagrees with the experience
  // lines beside it is worse than no role. A record that happens to carry one -
  // an older write, a hand edit, a CSV - must not resurrect it.
  const recipient = Recipients.toConnectionRecipient({
    ...SAVED_CONNECTION,
    currentRole: "Business Development Executive",
    currentCompany: "Brevity Software Solutions PVT. LTD.",
    totalExperience: "3 years"
  });
  assert.equal(recipient.values.current_role, "");
  assert.equal(recipient.values.current_company, "");
  assert.equal(recipient.values.total_experience, "");
  for (const name of ["current_role", "current_company", "total_experience"]) {
    assert.ok(recipient.missing.includes(name), `${name} is reported missing, not filled`);
  }
});

// --------------------------------------------------- the audience refusal

test("the unavailable lists name only variables the templates core actually knows", () => {
  assert.deepEqual(
    Object.keys(Recipients.AUDIENCE_UNAVAILABLE_VARIABLES).sort(),
    Object.values(Recipients.AUDIENCE).sort(),
    "every audience has a list and no list names an audience that does not exist"
  );
  for (const [audience, names] of Object.entries(Recipients.AUDIENCE_UNAVAILABLE_VARIABLES)) {
    for (const name of names) {
      assert.ok(Templates.isKnownVariable(name), `${name} on ${audience} is not a variable at all`);
    }
  }
  assert.deepEqual(Recipients.unavailableVariablesFor(Recipients.AUDIENCE.APPLICANTS), []);
  assert.deepEqual(Recipients.unavailableVariablesFor(Recipients.AUDIENCE.CONNECTIONS), [
    "job_title", "job_company", "applied_at"
  ]);
});

test("every audience-unavailable variable blocks a connections template, by name", () => {
  const unavailable = Recipients.unavailableVariablesFor(Recipients.AUDIENCE.CONNECTIONS);
  assert.ok(unavailable.length > 0, "the whole point is that this list is not empty");
  for (const name of unavailable) {
    const problems = Recipients.validateTemplateForAudience({
      body: `Hi {{first_name}}, following up on {{${name}}}.`,
      audience: Recipients.AUDIENCE.CONNECTIONS
    });
    assert.equal(problems.length, 1, `${name} must be reported exactly once`);
    assert.equal(problems[0].field, "body");
    assert.equal(problems[0].code, Recipients.RECIPIENT_PROBLEM.VARIABLE_UNAVAILABLE_FOR_AUDIENCE);
    assert.equal(problems[0].variable, name, "the problem names the offending variable");
    assert.ok(problems[0].message.includes(`{{${name}}}`));
    // And the reason it is not merely a per-person blank: nobody in the
    // audience can fill it.
    assert.equal(Recipients.isVariableAvailableFor(name, Recipients.AUDIENCE.CONNECTIONS), false);
  }
});

test("the same variables are free for applicants, where they come from the record", () => {
  for (const name of ["job_title", "job_company", "applied_at"]) {
    assert.deepEqual(
      Recipients.validateTemplateForAudience({
        body: `Hi {{first_name}}, about {{${name}}}.`,
        audience: Recipients.AUDIENCE.APPLICANTS
      }),
      [],
      `${name} is exactly what an applicant record holds`
    );
    assert.equal(Recipients.isVariableAvailableFor(name, Recipients.AUDIENCE.APPLICANTS), true);
  }
});

test("a fallback is the repair, so the fallback form is not blocked - and it renders", () => {
  const body = "Hi {{first_name}}, about {{job_title|the role we discussed}}.";
  assert.deepEqual(
    Recipients.validateTemplateForAudience({ body, audience: Recipients.AUDIENCE.CONNECTIONS }),
    [],
    "the recruiter has said what the sentence reads when there is no job"
  );
  const recipient = Recipients.toConnectionRecipient(SAVED_CONNECTION);
  const rendered = Templates.renderTemplate({ body, values: recipient.values });
  assert.equal(rendered.text, "Hi RAHUL, about the role we discussed.");
  assert.deepEqual(rendered.unresolved, [], "no hole is left in the message");
  assert.equal(Recipients.isRecipientReady(recipient, body), true);
});

test("one variable reports one problem, but a bare use beside a fallback use still blocks", () => {
  const twice = Recipients.validateTemplateForAudience({
    body: "About {{job_title}} - yes, {{job_title}}.",
    audience: Recipients.AUDIENCE.CONNECTIONS
  });
  assert.equal(twice.length, 1, "one defect reported once, not once per keystroke of it");

  const mixed = Recipients.validateTemplateForAudience({
    body: "About {{job_title|the role}}, and again {{job_title}}.",
    audience: Recipients.AUDIENCE.CONNECTIONS
  });
  assert.equal(mixed.length, 1, "the bare use is the clause that would arrive with a hole in it");
  assert.equal(mixed[0].variable, "job_title");
});

test("an unknown variable is still caught here, under the templates core's own code", () => {
  // One defect must not arrive under two names depending on which validator saw
  // it, so the two constants are asserted equal rather than merely similar.
  assert.equal(
    Recipients.RECIPIENT_PROBLEM.BODY_UNKNOWN_VARIABLE,
    Templates.TEMPLATE_PROBLEM.BODY_UNKNOWN_VARIABLE
  );
  for (const audience of Object.values(Recipients.AUDIENCE)) {
    const problems = Recipients.validateTemplateForAudience({
      body: "Hi {{first_name}}, your {{salary_expectation}}.",
      audience
    });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, Recipients.RECIPIENT_PROBLEM.BODY_UNKNOWN_VARIABLE);
    assert.equal(problems[0].variable, "salary_expectation");
  }
  // Both kinds at once, in the order the body uses them.
  const both = Recipients.validateTemplateForAudience({
    body: "{{job_title}} then {{salary_expectation}}",
    audience: Recipients.AUDIENCE.CONNECTIONS
  });
  assert.deepEqual(both.map((problem) => problem.variable), ["job_title", "salary_expectation"]);
});

test("an unknown audience is refused rather than guessed at", () => {
  const problems = Recipients.validateTemplateForAudience({
    body: "Hi {{first_name}}.",
    audience: "everyone"
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, "audience");
  assert.equal(problems[0].code, Recipients.RECIPIENT_PROBLEM.AUDIENCE_UNKNOWN);
  // "Unavailable for what?" has no answer, so nothing is approved on a guess.
  assert.deepEqual(Recipients.unavailableVariablesFor("everyone"), []);
  assert.equal(Recipients.describeAudience("everyone"), null);
  assert.equal(Recipients.isAudience("everyone"), false);
});

test("describeAudience answers with a label and a copy of the unavailable list", () => {
  const connections = Recipients.describeAudience(Recipients.AUDIENCE.CONNECTIONS);
  assert.equal(connections.id, "connections");
  assert.equal(connections.label, "Connections");
  assert.deepEqual(connections.unavailable, ["job_title", "job_company", "applied_at"]);
  // A copy: a UI that sorts the list for display must not reorder the policy.
  connections.unavailable.push("first_name");
  assert.deepEqual(Recipients.describeAudience(Recipients.AUDIENCE.CONNECTIONS).unavailable, [
    "job_title", "job_company", "applied_at"
  ]);
  assert.equal(Recipients.describeAudience(Recipients.AUDIENCE.APPLICANTS).label, "Applicants");
});

// -------------------------------------------------------- ready, per person

test("isRecipientReady is asked of THIS person, not of the template", () => {
  const body = "Hi {{first_name_titled}}, about {{job_title}}.";
  const applicant = Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND);
  const connection = Recipients.toConnectionRecipient(SAVED_CONNECTION);
  assert.equal(Recipients.isRecipientReady(applicant, body), true);
  assert.equal(Recipients.isRecipientReady(connection, body), false, "structurally unfillable here");

  // The per-person half: a variable the audience CAN fill, that this one record
  // does not carry.
  const company = "Hi {{first_name}}, still at {{current_company}}?";
  assert.equal(Recipients.isRecipientReady(Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND), company), true);
  assert.equal(Recipients.isRecipientReady(Recipients.toApplicantRecipient(PRIYA_NO_COMPANY), company), false);

  // A message that renders to nothing is not a message.
  assert.equal(Recipients.isRecipientReady(applicant, ""), false);
  assert.equal(Recipients.isRecipientReady(applicant, "   "), false);
  // An unknown reference renders as nothing, which is a hole like any other.
  assert.equal(Recipients.isRecipientReady(applicant, "Hi {{nickname}}."), false);
});

// ------------------------------------------------------------ garbage in

test("garbage in, empty out: nothing throws and nothing is invented", () => {
  for (const input of [undefined, null, "", "nonsense", 7, [], {}, { applicant: {}, job: {} }]) {
    assert.equal(Recipients.toApplicantRecipient(input), null, `${JSON.stringify(input)} names nobody`);
    assert.equal(Recipients.toConnectionRecipient(input), null);
  }
  // A record with nothing but an application id is still somebody the store
  // holds, so it maps - with an empty name rather than an invented one.
  const idOnly = Recipients.toApplicantRecipient({ applicationId: "25550787924" });
  assert.equal(idOnly.name, "");
  assert.equal(idOnly.values.full_name, "");

  assert.deepEqual(Recipients.unavailableVariablesFor(undefined), []);
  assert.equal(Recipients.describeAudience(undefined), null);
  assert.equal(Recipients.isRecipientReady(null, "Hi."), false);
  assert.equal(Recipients.isRecipientReady({ values: {} }, null), false);

  const noArgs = Recipients.validateTemplateForAudience();
  assert.ok(Array.isArray(noArgs));
  assert.equal(noArgs[0].code, Recipients.RECIPIENT_PROBLEM.AUDIENCE_UNKNOWN);
  assert.deepEqual(
    Recipients.validateTemplateForAudience({ body: null, audience: Recipients.AUDIENCE.APPLICANTS }),
    [],
    "an empty body is validateTemplate's question, asked once when the template is stored"
  );
});

test("with no templates core loaded it refuses rather than approving what it cannot check", () => {
  const loaded = globalThis.ProfileVaultMessageTemplates;
  try {
    delete globalThis.ProfileVaultMessageTemplates;
    const recipient = Recipients.toApplicantRecipient(RAHUL_ON_FRONTEND);
    // The person is still identifiable, so they are still a recipient - with no
    // values, because there is no palette to fill.
    assert.equal(recipient.name, "RAHUL Mishra");
    assert.deepEqual(recipient.values, {});
    assert.deepEqual(recipient.missing, []);
    // Not being able to render is not the same as rendering cleanly.
    assert.equal(Recipients.isRecipientReady(recipient, "Hi {{first_name}}."), false);
    const problems = Recipients.validateTemplateForAudience({
      body: "Hi {{first_name}}.",
      audience: Recipients.AUDIENCE.CONNECTIONS
    });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, Recipients.RECIPIENT_PROBLEM.TEMPLATES_UNAVAILABLE);
  } finally {
    globalThis.ProfileVaultMessageTemplates = loaded;
  }
});
