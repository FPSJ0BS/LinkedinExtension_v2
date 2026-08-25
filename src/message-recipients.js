/**
 * Who a message is going to, and which templates are safe to point at them.
 *
 * Same contract as the other cores: an export-free IIFE that publishes
 * `globalThis.ProfileVaultMessageRecipients`, touches nothing at load, and must
 * keep working three ways - classic content script, ESM side-effect import, and
 * a Node `await import()` in a test. It reads
 * `globalThis.ProfileVaultMessageTemplates` and `globalThis.ProfileVaultCore`
 * LAZILY, inside functions, so load order cannot break it.
 *
 * [message-templates-core.js](./message-templates-core.js) answers "what will
 * this text say about this one person". This file answers the two questions
 * that come before it: WHO are the people, and is this template even the right
 * shape for the kind of people it is pointed at.
 *
 * IT RE-IMPLEMENTS NO EXTRACTION. Every value on a recipient comes out of
 * `applicantVariableValues`; a stored record is mapped into the shape that
 * function already takes and is handed straight to it. A second reader would be
 * a second answer to the same question, and the two would drift.
 *
 * THE PART THIS FILE EXISTS FOR is `validateTemplateForAudience`.
 * `{{job_title}}`, `{{job_company}}` and `{{applied_at}}` are read off a JOB
 * APPLICATION. A saved connection has no application - not a blank one, none -
 * so for the connections audience those three can never resolve, for anybody,
 * ever. Without this check a recruiter writes "about your application for
 * {{job_title}}", points it at their connections, and every message in the
 * batch reads "about your application for " - the extension speaking in their
 * name and saying something false. That is rule 1 exactly: a wrong value is
 * worse than a blank one.
 *
 * So there are two different failures here and they are deliberately kept
 * apart. "This one person happens to have no current company" is per-person,
 * is answered by `missing` and `isRecipientReady`, and is a property of the
 * record. "This variable cannot exist for this audience" is structural, is
 * knowable before a single record is read, and blocks the template itself.
 *
 * NOTHING HERE SENDS ANYTHING. This file maps records and returns arrays. It
 * has no notion of a click, a control or a keystroke, and it never will.
 */
(() => {
  "use strict";

  const TEMPLATES = () => globalThis.ProfileVaultMessageTemplates || null;
  const CORE = () => globalThis.ProfileVaultCore || null;

  /** `cleanText`, from whichever core is loaded, with a standalone fallback. */
  function cleanText(value) {
    const templates = TEMPLATES();
    if (templates?.cleanText) return templates.cleanText(value);
    return String(value ?? "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  /** `/in/<slug>`, where a profile core is loaded to do it properly. */
  function canonicalUrl(value) {
    const core = CORE();
    return core?.canonicalizeProfileUrl ? core.canonicalizeProfileUrl(value) : cleanText(value);
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  // ----------------------------------------------------------------- audience
  // An audience is a STORE, not a filter: `applicants` is the applicants store,
  // where a record is a person on a job, and `connections` is the profiles
  // store, where a record is a saved member. Which store a recipient came out
  // of decides what can be said to them, so it travels on the recipient as
  // `source` rather than being remembered by the caller.

  const AUDIENCE = Object.freeze({
    APPLICANTS: "applicants",
    CONNECTIONS: "connections"
  });

  const AUDIENCES = Object.freeze([
    Object.freeze({ id: AUDIENCE.APPLICANTS, label: "Applicants" }),
    Object.freeze({ id: AUDIENCE.CONNECTIONS, label: "Connections" })
  ]);

  /**
   * Variables that cannot resolve for an audience however good the record is.
   *
   * WHAT IS ON THIS LIST AND WHAT IS NOT is the whole judgement, so it is worth
   * stating: a variable belongs here only when the audience makes it
   * IMPOSSIBLE, never when it merely happens to be uncollected today.
   *
   * `job_title`, `job_company` and `applied_at` are impossible for a
   * connection. They are properties of an application, and a connection has not
   * applied to anything; no future reader can recover them, because there is
   * nothing to read.
   *
   * `current_role`, `current_company` and `total_experience` are NOT on this
   * list, even though today's stored profile record carries none of them - 3.6.0
   * retired those fields as derived-and-unread. A connection does have a current
   * role; this extension simply does not keep it. That is a per-person blank
   * (`missing`, `isRecipientReady`) which a later reader could fill, not a
   * structural impossibility, and blocking a template on it would refuse a
   * message the recruiter is entitled to write.
   */
  const AUDIENCE_UNAVAILABLE_VARIABLES = Object.freeze({
    [AUDIENCE.APPLICANTS]: Object.freeze([]),
    [AUDIENCE.CONNECTIONS]: Object.freeze(["job_title", "job_company", "applied_at"])
  });

  /** Is this one of the audiences, spelled exactly? */
  function isAudience(audience) {
    return Object.prototype.hasOwnProperty.call(AUDIENCE_UNAVAILABLE_VARIABLES, String(audience ?? ""));
  }

  /**
   * The variables this audience can never fill.
   *
   * An unrecognised audience answers `[]` rather than guessing at a list -
   * `validateTemplateForAudience` is what refuses it, and it refuses loudly.
   * The array is a fresh copy so a caller may sort or filter it.
   */
  function unavailableVariablesFor(audience) {
    const list = AUDIENCE_UNAVAILABLE_VARIABLES[String(audience ?? "")];
    return list ? list.slice() : [];
  }

  /** Can this variable ever be filled for this audience? */
  function isVariableAvailableFor(name, audience) {
    return !unavailableVariablesFor(audience).includes(String(name ?? ""));
  }

  /** The audience, for a UI that has an id and wants its label. `null` if unknown. */
  function describeAudience(audience) {
    const id = String(audience ?? "");
    const entry = AUDIENCES.find((candidate) => candidate.id === id);
    if (!entry) return null;
    return { id: entry.id, label: entry.label, unavailable: unavailableVariablesFor(id) };
  }

  // --------------------------------------------------------------- recipients
  // A recipient is `{ id, source, name, profileUrl, applicationId, values,
  // missing }` and every scalar on it is a string. A value this extension does
  // not hold is "" - never "N/A", never "there", never the variable name.

  /**
   * FNV-1a over the identity parts, the same hash `createProfileId` and
   * `applicantId` use.
   *
   * Re-stated here rather than borrowed because neither is reachable: one lives
   * in an ESM module this IIFE cannot import, and the other hashes a different
   * tuple, so an applicant record and the recipient built from it would carry
   * the same string and a log could not tell which was which.
   */
  function hashIdentity(parts) {
    const input = parts.map((part) => String(part ?? "")).join("|").toLowerCase();
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * The recipient's id: stable for the same record, distinct per person per
   * source.
   *
   * The source is hashed in AND spelled in the prefix, so a person who is both
   * an applicant and a saved connection is two recipients that can be told
   * apart by eye, and a batch aimed at one store can never pick up a record
   * from the other.
   */
  function recipientId(source, parts) {
    return `recipient_${source}_${hashIdentity([source, ...parts])}`;
  }

  /**
   * The flat value map, plus the names that came back empty.
   *
   * Delegated whole to `applicantVariableValues` - this file never reads a
   * field off a record for a variable. With no templates core loaded there is
   * no palette to fill, so the answer is an empty map and an empty `missing`,
   * and `isRecipientReady` refuses on it rather than approving a message it
   * could not render.
   */
  function valuesAndMissing(applicant, job) {
    const templates = TEMPLATES();
    if (!templates?.applicantVariableValues) return { values: {}, missing: [] };
    const values = templates.applicantVariableValues({ applicant, job });
    const names = templates.TEMPLATE_VARIABLE_NAMES || Object.keys(values);
    // Palette order, so two recipients' `missing` lists are comparable.
    const missing = names.filter((name) => !cleanText(values[name]));
    return { values, missing };
  }

  /**
   * One applicant record - and optionally the job record it belongs to - as a
   * recipient.
   *
   * Takes a record from `normalizeApplicantRecord` (`{ applicant, job }`) or a
   * bare applicant object, and `jobRecord` supplements rather than replaces:
   * each job field is taken from the separate record when it has one and from
   * the record's own nested job otherwise, so handing over the fuller record
   * from the jobs store can only add, never blank.
   *
   * AN APPLICANT IS A PERSON ON A JOB (rule 17). The job id and the application
   * id are both part of the identity, so the same person on two posts is two
   * recipients and the same person applying twice is two recipients - which is
   * exactly what the applicants store already holds.
   *
   * Returns `null` when the record names nobody at all: no name, no profile URL
   * and no application id is not a person with missing fields, it is not a
   * person, and a recipient nothing can address is worse than no recipient.
   */
  function toApplicantRecipient(record, jobRecord) {
    if (!isObject(record)) return null;
    const applicant = isObject(record.applicant) ? record.applicant : record;
    const nested = isObject(record.job) ? record.job : {};
    const supplied = isObject(jobRecord) ? jobRecord : {};
    const job = {
      id: cleanText(supplied.id) || cleanText(nested.id),
      title: cleanText(supplied.title) || cleanText(nested.title),
      company: cleanText(supplied.company) || cleanText(nested.company)
    };

    const name = cleanText(applicant.name) || cleanText(record.name);
    const profileUrl = canonicalUrl(applicant.profileUrl || record.profileUrl);
    const applicationId = cleanText(record.applicationId) || cleanText(applicant.applicationId);
    if (!name && !profileUrl && !applicationId) return null;

    const filled = valuesAndMissing(applicant, job);
    return {
      id: recipientId(AUDIENCE.APPLICANTS, [job.id, applicationId, profileUrl, name]),
      source: AUDIENCE.APPLICANTS,
      name,
      profileUrl,
      applicationId,
      values: filled.values,
      missing: filled.missing
    };
  }

  /**
   * One saved profile record as a recipient.
   *
   * The stored connection is mapped into the shape `applicantVariableValues`
   * already takes, with NO job beside it, because there is no application. That
   * is what makes `job_title`, `job_company` and `applied_at` come back "" for
   * every connection and land in `missing` - and it is why
   * `validateTemplateForAudience` blocks them before the mapping is ever run.
   *
   * `education` is stored on a profile as one institution name per line, so
   * each line is presented as an entry naming a school and the palette's own
   * reader picks the first that names one. That is a change of shape, not a
   * second reader.
   *
   * `currentRole`, `currentCompany` and `totalExperience` are deliberately NOT
   * read, even off a record that happens to carry them: 3.6.0 retired those
   * fields because a derived role that disagrees with the experience lines
   * beside it is worse than no role. They resolve to "" and are reported as
   * missing, which is rule 1 working as intended.
   *
   * Returns `null` when the record names nobody - no name and no profile URL.
   */
  function toConnectionRecipient(record) {
    if (!isObject(record)) return null;

    const name = cleanText(record.fullName) || cleanText(record.name);
    const profileUrl = canonicalUrl(record.profileUrl);
    if (!name && !profileUrl) return null;

    const education = (Array.isArray(record.education) ? record.education : [])
      .map((entry) => (isObject(entry) ? entry : { institution: cleanText(entry) }));

    const filled = valuesAndMissing(
      { name, profileUrl, headline: record.headline, location: record.location, education },
      {}
    );

    return {
      // A profile's identity is its page. A hand-added record with no URL falls
      // back to its stored id, which is the only thing the table itself keys it
      // by either.
      id: recipientId(AUDIENCE.CONNECTIONS, [profileUrl || cleanText(record.id), name]),
      source: AUDIENCE.CONNECTIONS,
      name,
      profileUrl,
      // A connection has no application. Not a blank one - none.
      applicationId: "",
      values: filled.values,
      missing: filled.missing
    };
  }

  // --------------------------------------------------------------- validation
  // Problems are `{ field, code, message }` and arrive as a LIST, the same
  // shape and for the same reason as `validateTemplate`: the form shows them
  // inline beside the field that caused them, and a recruiter fixing three
  // problems one refusal at a time gives up on the third.

  const RECIPIENT_PROBLEM = Object.freeze({
    AUDIENCE_UNKNOWN: "audience_unknown",
    VARIABLE_UNAVAILABLE_FOR_AUDIENCE: "variable_unavailable_for_audience",
    // Deliberately the same string as the templates core's own code: one defect
    // reported by two validators must not arrive under two names. A test
    // asserts the two constants are equal.
    BODY_UNKNOWN_VARIABLE: "body_unknown_variable",
    TEMPLATES_UNAVAILABLE: "templates_core_unavailable"
  });

  /** `{{token}}`, whatever form the reference reached us in. */
  function asToken(name) {
    const text = String(name ?? "");
    return text.startsWith("{{") ? text : `{{${text}}}`;
  }

  /**
   * Is this body safe to point at this audience? An empty array means yes.
   *
   * Reports, in the order the body uses them:
   * - an audience this file does not know, because "unavailable for what?" has
   *   no answer and approving it would be a guess;
   * - a variable this extension cannot fill at all, the same defect
   *   `validateTemplate` reports, repeated here so a caller that validates only
   *   against an audience is not the one caller that misses it;
   * - a variable that CANNOT RESOLVE for this audience - structurally, for
   *   everybody - used with no fallback.
   *
   * A FALLBACK IS NOT BLOCKED, and that is the point rather than a leniency.
   * `{{job_title|the role}}` on a connection renders "the role": the recruiter
   * has said what the sentence should read when there is no job, which is
   * precisely the repair, and the message is then whole for every recipient.
   *
   * What is NOT checked here: whether the body is empty, too long, or named -
   * those are `validateTemplate`'s questions, asked once when the template is
   * stored. This asks only about the pairing of a body with an audience, so a
   * caller may run both and concatenate the answers.
   */
  function validateTemplateForAudience({ body, audience } = {}) {
    const problems = [];

    if (!isAudience(audience)) {
      problems.push({
        field: "audience",
        code: RECIPIENT_PROBLEM.AUDIENCE_UNKNOWN,
        audience: String(audience ?? ""),
        message: `"${String(audience ?? "")}" is not an audience this extension can send to.`
      });
    }

    const templates = TEMPLATES();
    if (!templates?.parseTemplateBody) {
      problems.push({
        field: "body",
        code: RECIPIENT_PROBLEM.TEMPLATES_UNAVAILABLE,
        message: "The message template core is not loaded, so this body cannot be checked."
      });
      return problems;
    }

    const unavailable = unavailableVariablesFor(audience);
    const described = describeAudience(audience);
    const audienceLabel = described ? described.label.toLowerCase() : "this audience";
    const parsed = templates.parseTemplateBody(body);
    const reportedUnknown = [];
    const reportedUnavailable = [];

    for (const reference of parsed.variables) {
      const label = reference.name || reference.raw;
      if (!reference.known) {
        if (reportedUnknown.includes(label)) continue;
        reportedUnknown.push(label);
        problems.push({
          field: "body",
          code: RECIPIENT_PROBLEM.BODY_UNKNOWN_VARIABLE,
          variable: label,
          message: `${asToken(label)} is not a variable this extension can fill.`
        });
        continue;
      }
      // A fallback repairs it, so only a bare use blocks - and a second, bare
      // use of a variable that was given a fallback elsewhere still blocks,
      // because that is the clause that would arrive with a hole in it.
      if (reference.fallback) continue;
      if (!unavailable.includes(reference.name)) continue;
      if (reportedUnavailable.includes(reference.name)) continue;
      reportedUnavailable.push(reference.name);
      problems.push({
        field: "body",
        code: RECIPIENT_PROBLEM.VARIABLE_UNAVAILABLE_FOR_AUDIENCE,
        variable: reference.name,
        audience: String(audience ?? ""),
        message:
          `${asToken(reference.name)} is read off a job application, so it can never be filled ` +
          `for ${audienceLabel}. Give it a fallback - {{${reference.name}|your wording}} - or remove it.`
      });
    }

    return problems;
  }

  /**
   * Would this body reach THIS person whole?
   *
   * The per-person half of `previewTemplate`'s `blocked`, asked without the
   * template's own limits: true only when every variable used resolves from
   * this recipient's values or from its own fallback, nothing referenced is
   * unknown, and what comes out is not empty. A body that renders to nothing is
   * not a message, so it is never ready.
   *
   * A recipient whose values could not be filled answers false: not being able
   * to render is not the same as rendering cleanly, and the safe direction here
   * is always to refuse.
   */
  function isRecipientReady(recipient, body) {
    const templates = TEMPLATES();
    if (!templates?.renderTemplate) return false;
    if (!isObject(recipient)) return false;
    const rendered = templates.renderTemplate({ body, values: recipient.values });
    if (rendered.unresolved.length > 0 || rendered.unknown.length > 0) return false;
    return rendered.text.trim().length > 0;
  }

  const api = {
    // who a message can be aimed at
    AUDIENCE, AUDIENCES, isAudience, describeAudience,
    // what that choice makes impossible, before any record is read
    AUDIENCE_UNAVAILABLE_VARIABLES, unavailableVariablesFor, isVariableAvailableFor,
    // stored records as people
    toApplicantRecipient, toConnectionRecipient, recipientId,
    // the refusals
    RECIPIENT_PROBLEM, validateTemplateForAudience, isRecipientReady
  };

  globalThis.ProfileVaultMessageRecipients = api;
})();
