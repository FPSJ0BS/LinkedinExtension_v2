/**
 * Pure message templating for the applicant messaging surface.
 *
 * Same contract as the other cores: an export-free IIFE that publishes
 * `globalThis.ProfileVaultMessageTemplates`, touches no DOM at load, and holds
 * every decision the composer adapter is not allowed to make for itself. It
 * must keep working three ways — classic content script, ESM side-effect
 * import, and Node `await import()` in a test.
 *
 * It reads `globalThis.ProfileVaultCore` LAZILY, inside functions, so it can
 * reuse the profile core's text cleaning where one is loaded and still parse,
 * load and answer correctly where one is not.
 *
 * What this file is for, in one sentence: a recruiter writes one message with
 * `{{variables}}` in it, and this turns that text plus one already-collected
 * applicant record into the exact characters that will be typed into LinkedIn's
 * own composer — or refuses, loudly, to produce them at all.
 *
 * THE REFUSAL IS THE POINT. Rule 1 of this project is that a missing value
 * stays empty and a wrong value is worse than a blank one. Everywhere else that
 * rule produces a blank column in a CSV the recruiter can see. Here the blank
 * would be sent to a human being: "Hi ," is not a cosmetic defect, it is the
 * extension speaking in the recruiter's name and getting the person wrong. So a
 * known variable with no value and no fallback is `unresolved`, an unrecognised
 * variable is `unknown`, and either one sets `blocked`. There is deliberately
 * no severity dial and no "insert anyway" flag in this file: the UI is given a
 * boolean it cannot argue with.
 *
 * NOTHING HERE SENDS ANYTHING. This file produces a string. It has no notion of
 * a click, a control, a keystroke or a recipient, and it never will.
 */
(() => {
  "use strict";

  const CORE = () => globalThis.ProfileVaultCore || null;

  /** `cleanText` from the profile core, with a standalone fallback. */
  function cleanText(value) {
    const core = CORE();
    if (core?.cleanText) return core.cleanText(value);
    return String(value ?? "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  // ------------------------------------------------------------------ limits
  // `BODY_MAX` is the ceiling a message may not pass; `BODY_INMAIL_WARN` is the
  // narrower InMail ceiling, which is a WARNING and never a block, because the
  // extension cannot tell from a record whether this thread will be an InMail
  // or an ordinary message, and refusing to compose on a guess would cost the
  // recruiter a message they were entitled to send.

  const TEMPLATE_LIMITS = Object.freeze({
    NAME_MAX: 80,
    BODY_MAX: 8000,
    BODY_INMAIL_WARN: 1900
  });

  // --------------------------------------------------------------- variables
  // This array IS the palette the UI renders — token, what to call it, where
  // the value comes from, and one realistic example so the recruiter can see
  // the shape of the thing before inserting it. Every entry names a field that
  // already exists on a collected applicant record. Nothing here is derived
  // from anything the record does not hold, and nothing here goes looking at
  // the page: by the time a message is composed, the panel that produced the
  // record may be showing somebody else entirely.

  const TEMPLATE_VARIABLES = Object.freeze([
    {
      name: "full_name",
      token: "{{full_name}}",
      label: "Full name",
      source: "applicant.name",
      example: "RAHUL Mishra"
    },
    {
      name: "first_name",
      token: "{{first_name}}",
      label: "First name",
      source: "applicant.name — the first word, exactly as collected",
      example: "RAHUL"
    },
    {
      name: "first_name_titled",
      token: "{{first_name_titled}}",
      label: "First name (title case)",
      source: "applicant.name — the first word, un-shouted",
      example: "Rahul"
    },
    {
      name: "headline",
      token: "{{headline}}",
      label: "Headline",
      source: "applicant.headline",
      example: "Business Development Executive at Brevity Software Solutions"
    },
    {
      name: "location",
      token: "{{location}}",
      label: "Location",
      source: "applicant.location",
      example: "Lucknow, Uttar Pradesh, India"
    },
    {
      name: "current_role",
      token: "{{current_role}}",
      label: "Current role",
      source: "applicant.currentRole",
      example: "Business Development Executive"
    },
    {
      name: "current_company",
      token: "{{current_company}}",
      label: "Current company",
      source: "applicant.currentCompany",
      example: "Brevity Software Solutions PVT. LTD."
    },
    {
      name: "total_experience",
      token: "{{total_experience}}",
      label: "Total experience",
      source: "applicant.totalExperience",
      example: "3 years"
    },
    {
      name: "education",
      token: "{{education}}",
      label: "Education",
      source: "applicant.education — the first entry that names a school",
      example: "University of Lucknow"
    },
    {
      name: "job_title",
      token: "{{job_title}}",
      label: "Job title",
      source: "job.title — the post they applied to",
      example: "Senior Frontend Engineer"
    },
    {
      name: "job_company",
      token: "{{job_company}}",
      label: "Job company",
      source: "job.company",
      example: "Acme Technologies"
    },
    {
      name: "applied_at",
      token: "{{applied_at}}",
      label: "Applied",
      source: "applicant.appliedAt",
      example: "2 weeks ago"
    }
  ].map((entry) => Object.freeze(entry)));

  /** Every supported variable name, in palette order. */
  const TEMPLATE_VARIABLE_NAMES = Object.freeze(TEMPLATE_VARIABLES.map((entry) => entry.name));

  const KNOWN_VARIABLES = new Set(TEMPLATE_VARIABLE_NAMES);

  /**
   * One reader per variable, kept out of `TEMPLATE_VARIABLES` so the palette
   * stays plain data the UI can render and a message can carry. A test asserts
   * the two lists name exactly the same variables, so neither can drift.
   */
  const VARIABLE_READERS = Object.freeze({
    full_name: ({ name }) => name,
    first_name: ({ firstName }) => firstName,
    first_name_titled: ({ firstName }) => titleCaseName(firstName),
    headline: ({ applicant }) => cleanText(applicant.headline),
    location: ({ applicant }) => cleanText(applicant.location),
    current_role: ({ applicant }) => cleanText(applicant.currentRole),
    current_company: ({ applicant }) => cleanText(applicant.currentCompany),
    total_experience: ({ applicant }) => cleanText(applicant.totalExperience),
    education: ({ applicant }) => firstSchool(applicant.education),
    job_title: ({ job }) => cleanText(job.title),
    job_company: ({ job }) => cleanText(job.company),
    applied_at: ({ applicant }) => cleanText(applicant.appliedAt)
  });

  /** Is this a variable this extension can actually fill? */
  function isKnownVariable(name) {
    return KNOWN_VARIABLES.has(String(name ?? ""));
  }

  /** The palette entry, for a UI that has a name and wants its label. */
  function describeVariable(name) {
    return TEMPLATE_VARIABLES.find((entry) => entry.name === String(name ?? "")) || null;
  }

  // ------------------------------------------------------------------ naming
  // Live records hold "RAHUL Mishra" — LinkedIn renders what the member typed,
  // and plenty of members type their own name in capitals. `{{first_name}}`
  // therefore renders "Hi RAHUL," which reads as shouting, so a companion
  // variable un-shouts it.

  /**
   * Title-case a name ONLY where the source offers no capitalisation of its
   * own: a name that is entirely upper case or entirely lower case is being
   * written by a keyboard habit, not by the person's own spelling, and is
   * safe to normalise. A name carrying BOTH cases has already told us how it
   * is spelled — "McDonald", "de Souza", "O'Brien" — and is returned untouched,
   * because rule 1 applies to a name as much as to a phone number: mangling
   * "McDonald" into "Mcdonald" is a wrong value, and a wrong value is worse
   * than the blank we did not even have here.
   *
   * The one thing this cannot recover is a mixed-case name that arrived
   * shouted: "MCDONALD" has no signal left in it and becomes "Mcdonald". That
   * is why `{{first_name}}` still exists beside `{{first_name_titled}}` — the
   * recruiter picks which risk they want, and neither one invents a value.
   */
  function titleCaseName(name) {
    const text = cleanText(name);
    if (!text) return "";
    const hasUpper = text !== text.toLowerCase();
    const hasLower = text !== text.toUpperCase();
    if (hasUpper && hasLower) return text;
    // A letter starts a new word after whitespace, a hyphen, an apostrophe or a
    // full stop, so "O'BRIEN" comes back "O'Brien" and "j.k. rowling" comes
    // back "J.K. Rowling".
    return text.toLowerCase().replace(/(^|[\s'’\-–—.])(\p{L})/gu, (_match, lead, letter) => lead + letter.toUpperCase());
  }

  /** The first whitespace-delimited word of a name, and nothing cleverer. */
  function firstNameFrom(name) {
    const text = cleanText(name);
    if (!text) return "";
    return text.split(/\s+/)[0] || "";
  }

  /**
   * The first education entry that actually names a school.
   *
   * Not simply `education[0]`: an entry may hold a degree and no institution,
   * and answering "" for somebody whose second entry names their university is
   * a missing value where a real one exists. It is still only ever their own
   * record — the applicants core stores the field as `institution`, and
   * `school` is accepted beside it because that is what the same value is
   * called on a hand-built or imported record.
   */
  function firstSchool(education) {
    const entries = Array.isArray(education) ? education : [];
    for (const entry of entries) {
      const school = cleanText(entry?.institution) || cleanText(entry?.school);
      if (school) return school;
    }
    return "";
  }

  /**
   * A collected applicant record, flattened to the map the renderer fills from.
   *
   * Takes either `{ applicant, job }` or a whole record from
   * `normalizeApplicantRecord`, which has exactly those two keys on it, so the
   * caller never has to take the record apart.
   *
   * EVERY value is a string, and a value that is not on the record is "" —
   * never "N/A", never "there", never the variable name. A placeholder is an
   * invented value that reads as a real one, which is the exact failure rule 1
   * exists to prevent; an empty string is what makes the message BLOCK.
   */
  function applicantVariableValues(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const applicant = source.applicant && typeof source.applicant === "object" ? source.applicant : {};
    const job = source.job && typeof source.job === "object" ? source.job : {};
    const name = cleanText(applicant.name);
    const context = { applicant, job, name, firstName: firstNameFrom(name) };

    const values = {};
    for (const entry of TEMPLATE_VARIABLES) {
      const read = VARIABLE_READERS[entry.name];
      values[entry.name] = read ? cleanText(read(context)) : "";
    }
    return values;
  }

  // ------------------------------------------------------------------ syntax
  // `{{variable}}`, `{{variable|fallback text}}`, and `\{` / `\}` for a literal
  // brace.
  //
  // This is a hand-written scanner rather than a regex ON PURPOSE. A
  // module-level `/…/g` regex driven with `.test()` or `.exec()` carries
  // `lastIndex` from one call to the next and silently skips every other match
  // — a hazard this repository has already been bitten by — and a template is
  // parsed on every keystroke of a preview, so it is exactly the shape of code
  // that would hide it. A scanner has no state to leak between calls.

  const OPEN = "{{";
  const CLOSE = "}}";

  /**
   * Split a body into literal text and variable references.
   *
   * Returns `{ segments, variables, names, unknown }`:
   * - `segments` — `{ type: "text", value }` and `{ type: "variable", name,
   *   fallback, raw, known }` in reading order; joining the rendered segments
   *   reproduces the body.
   * - `variables` — one entry per reference, in order, repeats included.
   * - `names` — each referenced name once, in first-seen order.
   * - `unknown` — the referenced names this extension cannot fill.
   *
   * An unterminated `{{` is literal text: it is a recruiter mid-keystroke, not
   * a variable, and inventing a reference out of it would flash a spurious
   * error under their cursor.
   */
  function parseTemplateBody(body) {
    const text = String(body ?? "");
    const segments = [];
    const variables = [];
    const names = [];
    const unknown = [];
    let literal = "";
    let index = 0;

    const flush = () => {
      if (literal) segments.push({ type: "text", value: literal });
      literal = "";
    };

    while (index < text.length) {
      const character = text[index];

      // `\{` and `\}` put a brace in the message instead of opening a
      // reference. Nothing else is escapable — a backslash before anything
      // else is a backslash the recruiter typed.
      if (character === "\\" && (text[index + 1] === "{" || text[index + 1] === "}")) {
        literal += text[index + 1];
        index += 2;
        continue;
      }

      if (character === "{" && text.startsWith(OPEN, index)) {
        const close = text.indexOf(CLOSE, index + OPEN.length);
        if (close === -1) {
          literal += text.slice(index);
          break;
        }
        const raw = text.slice(index, close + CLOSE.length);
        const inner = text.slice(index + OPEN.length, close);
        const pipe = inner.indexOf("|");
        const name = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
        // A fallback that is only whitespace is not a fallback. Resolving to
        // " " would put a message reading "Hi  ," in front of a person, which
        // is the defect this whole file exists to make impossible.
        const fallback = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
        const known = isKnownVariable(name);
        const reference = { type: "variable", name, fallback, raw, known };

        flush();
        segments.push(reference);
        variables.push({ name, fallback, raw, known });
        // A reference with no name at all — `{{}}` — has nothing to report as
        // unknown, so it reports itself. It still blocks: whatever it was meant
        // to be, it is not something this extension can fill.
        const label = name || raw;
        if (!names.includes(label)) names.push(label);
        if (!known && !unknown.includes(label)) unknown.push(label);

        index = close + CLOSE.length;
        continue;
      }

      literal += character;
      index += 1;
    }

    flush();
    return { segments, variables, names, unknown };
  }

  /**
   * Fill a body from a value map.
   *
   * Returns `{ text, unresolved, unknown }`. An unknown reference renders as
   * NOTHING — never as its own literal `{{token}}`, because a literal token
   * arriving in a real conversation tells the applicant they were mail-merged
   * and tells the recruiter nothing until it is too late. It is reported
   * instead, and the report is what blocks the insertion.
   */
  function renderTemplate({ body, values } = {}) {
    const map = values && typeof values === "object" ? values : {};
    const parsed = parseTemplateBody(body);
    const unresolved = [];
    let text = "";

    for (const segment of parsed.segments) {
      if (segment.type === "text") {
        text += segment.value;
        continue;
      }
      if (!segment.known) continue;
      const value = cleanText(map[segment.name]);
      if (value) {
        text += value;
        continue;
      }
      if (segment.fallback) {
        text += segment.fallback;
        continue;
      }
      if (!unresolved.includes(segment.name)) unresolved.push(segment.name);
    }

    return { text, unresolved, unknown: parsed.unknown.slice() };
  }

  // ----------------------------------------------------------------- preview
  const PREVIEW_WARNING = Object.freeze({
    INMAIL_LENGTH: "inmail_length"
  });

  /**
   * What the recruiter is about to insert, and whether they may.
   *
   * `blocked` is the only answer the UI needs and the only one it may not
   * override: true when any variable went unresolved, when any reference was
   * unknown, when the rendered message is empty, or when it is past the
   * ceiling. Warnings are the other kind of thing entirely — the InMail length
   * is a caution, not a refusal, because the extension cannot tell which kind
   * of thread this is and refusing on a guess costs a message the recruiter
   * was entitled to send.
   */
  function previewTemplate({ body, applicant, job } = {}) {
    const values = applicantVariableValues({ applicant, job });
    const rendered = renderTemplate({ body, values });
    const text = rendered.text;
    const length = text.length;
    const warnings = [];

    if (length > TEMPLATE_LIMITS.BODY_INMAIL_WARN && length <= TEMPLATE_LIMITS.BODY_MAX) {
      warnings.push({
        code: PREVIEW_WARNING.INMAIL_LENGTH,
        message: `This message is ${length} characters. An InMail is limited to ${TEMPLATE_LIMITS.BODY_INMAIL_WARN}.`
      });
    }

    const blocked =
      rendered.unresolved.length > 0 ||
      rendered.unknown.length > 0 ||
      text.trim().length === 0 ||
      length > TEMPLATE_LIMITS.BODY_MAX;

    return {
      text,
      unresolved: rendered.unresolved,
      unknown: rendered.unknown,
      length,
      warnings,
      blocked,
      values
    };
  }

  // -------------------------------------------------------------- validation
  // Every problem is `{ field, code, message }` and they arrive as a LIST,
  // never a bare boolean, because the form shows them inline beside the field
  // that caused them and a recruiter fixing three problems one refusal at a
  // time gives up on the third.

  const TEMPLATE_PROBLEM = Object.freeze({
    NAME_REQUIRED: "name_required",
    NAME_TOO_LONG: "name_too_long",
    NAME_DUPLICATE: "name_duplicate",
    BODY_REQUIRED: "body_required",
    BODY_TOO_LONG: "body_too_long",
    BODY_UNKNOWN_VARIABLE: "body_unknown_variable"
  });

  /** `{{token}}`, whatever form the offending reference reached us in. */
  function asToken(name) {
    const text = String(name ?? "");
    return text.startsWith(OPEN) ? text : `${OPEN}${text}${CLOSE}`;
  }

  /**
   * Is this template storable? An empty array means yes.
   *
   * `existingNames` may hold plain strings or whole template records; a record
   * carrying the same `id` as the one being edited is skipped, so renaming a
   * template to its own name is not a duplicate of itself.
   *
   * Note what is NOT validated here: a variable with no fallback is perfectly
   * legal in a stored template — whether it resolves depends on the applicant,
   * which is `previewTemplate`'s question, asked again for every person.
   */
  function validateTemplate({ name, body, existingNames, id } = {}) {
    const problems = [];
    const templateName = cleanText(name);

    if (!templateName) {
      problems.push({ field: "name", code: TEMPLATE_PROBLEM.NAME_REQUIRED, message: "Give the template a name." });
    } else {
      if (templateName.length > TEMPLATE_LIMITS.NAME_MAX) {
        problems.push({
          field: "name",
          code: TEMPLATE_PROBLEM.NAME_TOO_LONG,
          message: `A template name is at most ${TEMPLATE_LIMITS.NAME_MAX} characters.`
        });
      }
      const taken = (Array.isArray(existingNames) ? existingNames : [])
        .filter((entry) => !(id && entry && typeof entry === "object" && entry.id === id))
        .map((entry) => cleanText(entry && typeof entry === "object" ? entry.name : entry).toLowerCase())
        .filter(Boolean);
      if (taken.includes(templateName.toLowerCase())) {
        problems.push({
          field: "name",
          code: TEMPLATE_PROBLEM.NAME_DUPLICATE,
          message: `A template called "${templateName}" already exists.`
        });
      }
    }

    const bodyText = String(body ?? "").trim();
    if (!bodyText) {
      problems.push({ field: "body", code: TEMPLATE_PROBLEM.BODY_REQUIRED, message: "Write the message." });
    } else {
      if (bodyText.length > TEMPLATE_LIMITS.BODY_MAX) {
        problems.push({
          field: "body",
          code: TEMPLATE_PROBLEM.BODY_TOO_LONG,
          message: `A message is at most ${TEMPLATE_LIMITS.BODY_MAX} characters — this one is ${bodyText.length}.`
        });
      }
      for (const unknown of parseTemplateBody(bodyText).unknown) {
        problems.push({
          field: "body",
          code: TEMPLATE_PROBLEM.BODY_UNKNOWN_VARIABLE,
          variable: unknown,
          message: `${asToken(unknown)} is not a variable this extension can fill.`
        });
      }
    }

    return problems;
  }

  const api = {
    // the shape of a template
    TEMPLATE_LIMITS, TEMPLATE_PROBLEM, PREVIEW_WARNING,
    // the palette the UI renders, and the record fields behind it
    TEMPLATE_VARIABLES, TEMPLATE_VARIABLE_NAMES, isKnownVariable, describeVariable,
    applicantVariableValues, titleCaseName, firstNameFrom,
    // the engine
    parseTemplateBody, renderTemplate, previewTemplate, validateTemplate,
    // the shared helper the adapter needs and must not re-implement
    cleanText
  };

  globalThis.ProfileVaultMessageTemplates = api;
})();
