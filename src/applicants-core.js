/**
 * Pure policy and parsing for LinkedIn's recruiter hiring surface.
 *
 * Same contract as the other cores: an export-free IIFE that publishes
 * `globalThis.ProfileVaultApplicants`, touches no `document` or `window` at
 * load, and holds every decision the DOM adapter in [applicants.js] is not
 * allowed to make for itself. It must keep working three ways — classic content
 * script, ESM side-effect import, and Node `await import()` in a test.
 *
 * It reads `globalThis.ProfileVaultCore` LAZILY, inside functions, because the
 * hiring surface reuses the profile core's text cleaning, contact provenance and
 * settle policy rather than growing a second copy of them. Every use is guarded,
 * so the module still loads and parses when the profile core is absent.
 *
 * What this file is for, in one sentence: a recruiter looking at their own job's
 * applicants sees a job, a person, a set of qualification verdicts and a set of
 * screening answers, and this turns the words on that screen into a record
 * without ever inventing one.
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

  /** Deduplicated, cleaned, in reading order. */
  function uniqueText(values) {
    const core = CORE();
    if (core?.uniqueText) return core.uniqueText(values);
    const seen = new Set();
    const output = [];
    for (const value of values || []) {
      const text = cleanText(value);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      output.push(text);
    }
    return output;
  }

  /** Split a block of rendered text into clean, non-empty lines. */
  function toLines(value) {
    return String(value ?? "")
      .split(/\r?\n/)
      .map((line) => cleanText(line))
      .filter(Boolean);
  }

  // ------------------------------------------------------------------- pages
  // The recruiter surface has several addresses for the same thing. The
  // applicant being looked at is identified by `applicationId` and the job by
  // `jobId` — both of which LinkedIn puts in the query string on the modern
  // /hiring/ pages and in the path on the older /talent/ ones. Neither is ever
  // guessed: an address that carries no id yields null, and the record then
  // falls back to the job title as its only identity.

  const HIRING_PATH_PATTERN = /^\/(?:hiring|talent)(?:\/|$)/i;
  const APPLICANT_PATH_PATTERN = /\/(?:applicants|applicant|manage)(?:\/|$)/i;

  /** Is this address part of the recruiter hiring surface at all? */
  function isHiringPage(url) {
    try {
      const parsed = new URL(String(url ?? ""));
      if (!/^(?:www\.)?linkedin\.com$/i.test(parsed.hostname)) return false;
      return HIRING_PATH_PATTERN.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  /** Is this the applicants view specifically, rather than the hiring plan? */
  function isApplicantsPage(url) {
    if (!isHiringPage(url)) return false;
    try {
      const parsed = new URL(String(url ?? ""));
      if (APPLICANT_PATH_PATTERN.test(parsed.pathname)) return true;
      // /hiring/jobs/<id>/applicants and /hiring/applicants?applicationId=…
      return parsed.searchParams.has("applicationId") || parsed.searchParams.has("applicantId");
    } catch {
      return false;
    }
  }

  /**
   * The job AND the view within it, as one key — what an "arrival" is measured
   * against.
   *
   * 3.7.6 keyed an arrival on the job alone, for a good reason: opening a row is
   * how a run *advances*, and every one of those changes the address bar, so
   * keying on the whole URL would restart the run on every row it opened. But
   * the job alone is too coarse in the other direction. `/hiring/jobs/<id>/
   * manage`, `/hiring/jobs/<id>/applicants` and `/hiring/applicants/?jobId=<id>`
   * are all `job:<id>`, so moving between a job's own views in LinkedIn's app
   * and landing back on its Applicants list was never an arrival at all — and
   * that is one of the two reasons the restart only ever worked after a reload,
   * which resets the remembered key to "".
   *
   * The section is the pathname with its ids removed, so it is stable across
   * exactly the thing that must not count — opening a row, which either only
   * adds `applicationId` to the query or appends the application's id to the
   * path — and it changes for the thing that must count: a different view of
   * the same job.
   *
   * Returns "" for anything that is not an applicants view, so leaving the
   * surface entirely is always observable as a key that went blank.
   */
  function applicantsViewKey(url) {
    if (!isApplicantsPage(url)) return "";
    let section = "";
    try {
      section = new URL(String(url ?? "")).pathname
        // Every id is at least three digits; a real LinkedIn job or application
        // id is ten. Nothing else in these paths is numeric.
        .replace(/\/\d{3,}(?=\/|$)/g, "")
        .replace(/\/+$/, "")
        .toLowerCase();
    } catch {
      section = "";
    }
    return `job:${parseHiringContext(url).jobId || ""}@${section}`;
  }

  /** The first of these query keys that carries a value, cleaned. */
  function paramOf(parsed, keys) {
    for (const key of keys) {
      const value = cleanText(parsed.searchParams.get(key));
      if (value) return value;
    }
    return "";
  }

  /**
   * The job and applicant this address is pointing at.
   *
   * Both halves are optional and both are `null` when the address does not carry
   * them — an applicant panel opened from a list that has not yet written the id
   * into the URL is a real state, and inventing an id there would file the
   * record under the wrong job.
   */
  function parseHiringContext(url) {
    const empty = { jobId: null, applicationId: null, applicantsPage: false, hiringPage: false, url: cleanText(url) };
    try {
      const parsed = new URL(String(url ?? ""));
      if (!/^(?:www\.)?linkedin\.com$/i.test(parsed.hostname)) return empty;
      const path = parsed.pathname;
      const pathJob = /\/(?:jobs|hire)\/(\d{4,})/i.exec(path);
      const pathApplication = /\/applicants?\/(\d{4,})/i.exec(path);
      return {
        jobId: paramOf(parsed, ["jobId", "currentJobId", "jobPostingId"]) || (pathJob ? pathJob[1] : "") || null,
        applicationId:
          paramOf(parsed, ["applicationId", "applicantId", "profileUrn"]) || (pathApplication ? pathApplication[1] : "") || null,
        applicantsPage: isApplicantsPage(url),
        hiringPage: HIRING_PATH_PATTERN.test(path),
        url: cleanText(url)
      };
    } catch {
      return empty;
    }
  }

  // ------------------------------------------------- the columns that scroll
  // The hiring surface inverts the connections list's rule, and getting that
  // backwards is what made the collector read one screenful of everything.
  //
  // On the connections list the document is the real scroller and the tallest
  // inner container is a filter panel, so `Connections.chooseScrollTarget`
  // scores `isScrollingElement` at +60 and *penalises* depth. Here the page
  // itself barely moves — it scrolls the global nav and the job header and
  // nothing else — while the applicant list and the applicant detail panel are
  // each an independently scrolling column. So the moment the page had any
  // range at all it won, the run scrolled the page, the column never moved,
  // `maxPosition` was reached on the first read and the scan settled having seen
  // only what was already on screen. That is both live symptoms at once: an
  // applicant saved without the Experience section that sits below the fold, and
  // a run over a 665-applicant job that finds the first handful of rows.
  //
  // This chooser is the mirror image and is consulted first: it refuses the page
  // outright and takes the INNERMOST container that still carries the content
  // being read. When no such column exists — a layout where the page really is
  // the scroller — it returns null and the adapter falls back to the tested
  // general chooser, which is what handles the document.

  const COLUMN_SCROLL_EPSILON = 8;

  function chooseColumnScrollTarget(candidates = []) {
    let best = null;
    let bestScore = -Infinity;

    for (const candidate of candidates || []) {
      if (!candidate || candidate.id === undefined || candidate.id === null) continue;
      // The page is never a column; handling it is the fallback's job.
      if (candidate.isScrollingElement || candidate.isDocumentRoot) continue;

      const range = (Number(candidate.scrollHeight) || 0) - (Number(candidate.clientHeight) || 0);
      // An element that cannot move is not a scroller, whatever its overflow.
      if (range <= COLUMN_SCROLL_EPSILON) continue;
      if (!/auto|scroll|overlay/i.test(String(candidate.overflowY ?? ""))) continue;
      // And it has to hold what is being read, or scrolling it moves nothing.
      if (!(candidate.carriesContent ?? candidate.containsList)) continue;

      // Depth is a bonus here, not a penalty: an outer qualifying container on
      // this surface is the page shell, which scrolls the header and leaves the
      // column exactly where it was.
      let score = Math.min(120, Math.max(0, Number(candidate.depth) || 0) * 2);
      score += Math.min(30, Math.round(range / 500));
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best ? { ...best, range: (Number(best.scrollHeight) || 0) - (Number(best.clientHeight) || 0) } : null;
  }

  // ------------------------------------------------------------ click policy
  // The same discipline as the connections list and the Contact info overlay:
  // an allowlist per purpose, a denylist that always beats it, and the caller
  // having to PROVE the element sits inside the container it claims to belong
  // to. On this surface that matters more, not less — the applicant panel puts
  // "Shortlist", "Move to", "Reject", "Interview with AI" and a "Contact"
  // dropdown that can send a message within a few pixels of each other, and
  // three of those four change something in the recruiter's ATS.

  /**
   * Labels that act on the applicant or on someone else's behalf.
   *
   * Every one of these is refused outright, whatever else the label says, and
   * the test runs before any allowlist. A control reading "Message · Contact"
   * is a message button that happens to mention contact, and is refused.
   */
  const FORBIDDEN_APPLICANT_CONTROL_PATTERN =
    /\b(?:connect|follow|unfollow|message|inmail|send|email\s+applicant|endorse|recommend|reject|decline|archive|shortlist|move\s+to|advance|hire|hired|offer|interview|schedule|book|rate|rating|good\s+fit|maybe|not\s+a\s+fit|withdraw|invite|invitation|accept|ignore|report|block|share|like|comment|repost|subscribe|save|unsave|add\s+note|template|delete|remove|apply|purchase|upgrade|try\s+premium)\b/i;

  /** The applicant's own contact-details disclosure. */
  const APPLICANT_CONTACT_CONTROL_PATTERN =
    /^(?:contact\s*info(?:rmation)?|contact\s*details|contact|show\s+contact\s*info(?:rmation)?|view\s+contact\s*info(?:rmation)?)$/i;

  /**
   * The opened viewer's own Download control (3.7.9, rule 9i).
   *
   * THE DEFECT: the viewer's document address is not always the document. On a
   * recruiter account the address the viewer fetches is a **descriptor** — it
   * answers with JSON naming the asset, a `transcribedDocumentUrl` and a set of
   * image manifests — and that JSON is what was written to disk and reported as
   * the applicant's CV. It has a `/dms/` path and a `linkedin.com` host, so
   * every refusal `isResumeDocumentUrl` applies passed it. The recruiter got a
   * file full of `{"asset":"urn:li:digitalmediaAsset:…"}` named after a person.
   *
   * Pressing the control LinkedIn put there for exactly this purpose is the
   * direct answer: the page resolves its own descriptor and fetches the real
   * file, with its own session, exactly as it would if the recruiter clicked it.
   *
   * Anchored on the WHOLE label, so a "download" inside a sentence is not a
   * control, and the denylist is still consulted first — "Save" is refused, and
   * so is anything that pairs a download with an action on the applicant.
   */
  const RESUME_DOWNLOAD_CONTROL_PATTERN =
    // `documents?` rather than `document` on purpose, twice over: it matches the
    // plural too, and the bare token would trip this file's own DOM check, which
    // greps for `\bdocument\b` after stripping comments and cannot tell a word
    // in an allowlist from a reference to the global.
    /^(?:download|download\s+(?:resume|résumé|cv|curriculum\s+vitae|file|documents?|attachment|pdf|original))$/i;

  /** The applicant's attached CV. "Download" is a read, not an action on them. */
  const RESUME_CONTROL_PATTERN =
    /\b(?:resume|résumé|cv|curriculum\s+vitae)\b/i;

  /** A collapsed section's own expander. */
  const DISCLOSURE_CONTROL_PATTERN =
    /^(?:show\s+(?:more|all|details|full)|see\s+(?:more|all|details|full)|view\s+(?:more|all|details)|read\s+more|expand|more)\b/i;

  /** What a caller may ask permission for. Anything else is refused. */
  const CONTROL_PURPOSE = Object.freeze({
    CONTACT: "contact",
    RESUME: "resume",
    /**
     * The opened viewer's own Download control (3.7.9, rule 9i).
     *
     * A read of a file the recruiter's account already has, pressed inside a
     * viewer this extension opened itself, and the only reliable way to get the
     * FILE rather than the descriptor that names it. It sends nothing and
     * changes nothing on LinkedIn.
     */
    RESUME_DOWNLOAD: "resume-download",
    DISCLOSURE: "disclosure",
    APPLICANT_ROW: "applicant-row",
    /**
     * The applicant list's own next-page control (3.7.8, rule 9h).
     *
     * The list is paginated and the run only ever saw the first page: scrolling
     * to the bottom of page one is indistinguishable from the end of the list
     * unless something looks for the pager. This reveals more of the same list
     * the recruiter is already looking at and changes nothing on LinkedIn —
     * the same standard every other allowed control is held to.
     */
    PAGINATION: "pagination"
  });

  /**
   * The pager, by name.
   *
   * Deliberately not `Connections.PAGINATION_ALLOWLIST` reused blind: that list
   * is anchored on whole labels like `^next$` for a text button, and a hiring
   * pager is often an icon whose only name is an `aria-label` ("Next page",
   * "Next 25 applicants"). Still an allowlist, still beaten by the denylist,
   * and still required to be proven inside the list.
   */
  const APPLICANT_PAGINATION_PATTERN =
    /^(?:next(?: page| \d+| \d+ applicants?)?|show more|load more|see more applicants?|more applicants?|page \d+)$/i;

  /**
   * Chevrons and arrows a pager welds onto its own name.
   *
   * THE LIVE DEFECT, measured from the recruiter's own screen: the pager on a
   * 665-applicant job renders as `Next ›`, and `textContent` on that control
   * includes the glyph. The allowlist is anchored on the WHOLE label — on
   * purpose, so `Next: Message` can never match — so `next ›` was refused as
   * `not-a-pagination-control` and the run never left page one. Worse than
   * stopping: with no pager found the walk reports `settled`, which is a
   * CONCLUSIVE stop, so the job was marked COMPLETED at 25 of 665 and could not
   * restart.
   *
   * Stripped rather than added to the pattern, so the anchor keeps its meaning:
   * `Next: Message` still fails because removing a glyph leaves `next: message`,
   * not `next`. The denylist is still consulted first, before any of this.
   */
  const PAGINATION_GLYPH_PATTERN = /[›»〉⟩❯⟫>→⇒▶►]/;

  /**
   * The pager's name with its glyphs removed, or `next` when the glyph IS the
   * whole name.
   *
   * A control named only `›` is accepted **solely** because every caller has
   * already proven it is inside the applicant list — `inContainer` is checked
   * immediately after this, and a bare chevron anywhere else on a hiring page
   * would be refused there. Numbered buttons are deliberately NOT covered: a
   * bare `2` stays refused, because any numeric control in the list would
   * otherwise qualify.
   */
  function paginationLabel(value) {
    const raw = String(value ?? "");
    const stripped = normalizeLabel(raw.replace(/[›»〉⟩❯⟫>→⇒▶►]+/g, " "));
    if (stripped) return stripped;
    return PAGINATION_GLYPH_PATTERN.test(raw) ? "next" : "";
  }

  function normalizeLabel(value) {
    const core = CORE();
    if (core?.cleanText) return core.cleanText(value).toLowerCase();
    return cleanText(value).toLowerCase();
  }

  /**
   * May this element be clicked, and why.
   *
   * `purpose` says what the caller wants it for; `inContainer` is the caller's
   * proof that the element was enumerated from inside the right container, not
   * found by label anywhere on the page. "Show details" labels half a dozen
   * unrelated controls on this surface, so the proof is mandatory for every
   * purpose except the resume link, which is unambiguous by name.
   */
  function classifyApplicantControl({ text = "", ariaLabel = "", purpose = "", inContainer = false } = {}) {
    const label = normalizeLabel(text) || normalizeLabel(ariaLabel);
    const combined = `${normalizeLabel(text)} ${normalizeLabel(ariaLabel)}`.trim();
    const refuse = (reason, forbidden = false) => ({ allowed: false, forbidden, label, purpose, reason });

    if (!label) return refuse("no-label");
    // The denylist always wins, and it is consulted first.
    if (FORBIDDEN_APPLICANT_CONTROL_PATTERN.test(combined)) return refuse("forbidden-action", true);

    if (purpose === CONTROL_PURPOSE.CONTACT) {
      if (!APPLICANT_CONTACT_CONTROL_PATTERN.test(label)) return refuse("not-a-contact-control");
      if (!inContainer) return refuse("outside-applicant-panel");
      return { allowed: true, forbidden: false, label, purpose, reason: "contact-info" };
    }
    if (purpose === CONTROL_PURPOSE.RESUME) {
      if (!RESUME_CONTROL_PATTERN.test(combined)) return refuse("not-a-resume-control");
      return { allowed: true, forbidden: false, label, purpose, reason: "resume" };
    }
    if (purpose === CONTROL_PURPOSE.RESUME_DOWNLOAD) {
      if (!RESUME_DOWNLOAD_CONTROL_PATTERN.test(label)) return refuse("not-a-download-control");
      // Proven inside the viewer this extension opened, exactly as pagination is
      // proven inside the list. A "Download" elsewhere on a hiring page belongs
      // to something that is not this applicant's CV — an export of the whole
      // applicant list, for one.
      if (!inContainer) return refuse("outside-resume-viewer");
      return { allowed: true, forbidden: false, label, purpose, reason: "resume-download" };
    }
    if (purpose === CONTROL_PURPOSE.DISCLOSURE) {
      if (!DISCLOSURE_CONTROL_PATTERN.test(label)) return refuse("not-a-disclosure-control");
      if (!inContainer) return refuse("outside-applicant-panel");
      return { allowed: true, forbidden: false, label, purpose, reason: "expand-section" };
    }
    if (purpose === CONTROL_PURPOSE.APPLICANT_ROW) {
      if (!inContainer) return refuse("outside-applicant-list");
      return { allowed: true, forbidden: false, label, purpose, reason: "applicant-row" };
    }
    if (purpose === CONTROL_PURPOSE.PAGINATION) {
      if (!APPLICANT_PAGINATION_PATTERN.test(paginationLabel(label))) return refuse("not-a-pagination-control");
      // Proven inside the list, exactly as connections pagination is: a "Next"
      // anywhere else on a hiring page belongs to something that is not the
      // applicant list, and pressing it would leave the run somewhere else.
      if (!inContainer) return refuse("outside-applicant-list");
      return { allowed: true, forbidden: false, label, purpose, reason: "pagination" };
    }
    return refuse("unknown-purpose");
  }

  // -------------------------------------------------------- qualifications
  // The recruiter screen shows, per requirement: the requirement itself, a
  // verdict icon, the platform's own sentence explaining the verdict, and a
  // smaller line saying where that came from. All four are stored verbatim.
  // Nothing is re-derived: if LinkedIn says it cannot evaluate a requirement,
  // the record says unknown rather than quietly reading it as a miss.

  const QUALIFICATION_CATEGORY = Object.freeze({
    MUST_HAVE: "must_have",
    PREFERRED: "preferred"
  });

  const QUALIFICATION_RESULT = Object.freeze({
    MATCHED: "matched",
    NOT_MATCHED: "not_matched",
    UNKNOWN: "unknown"
  });

  const QUALIFICATION_SOURCE = Object.freeze({
    PROFILE: "applicant_profile",
    RESUME: "resume",
    SCREENING: "screening_response",
    UNKNOWN: ""
  });

  const MUST_HAVE_HEADING = /^must[-\s]?have(?:s)?\b/i;
  const PREFERRED_HEADING = /^preferred\b|^nice[-\s]to[-\s]have\b/i;

  /** The line that says where a verdict came from. */
  const SOURCE_NOTE_PATTERN = /^based on\b/i;

  /** LinkedIn's own wording for "we could not evaluate this". */
  const NOT_EVALUATED_PATTERN =
    /information cannot be (?:provided|evaluated)|cannot be (?:provided or )?evaluated|not enough information|no information/i;

  /** Chrome inside the qualifications card that is never part of a requirement. */
  const QUALIFICATION_NOISE_PATTERN =
    /^(?:qualifications?|must[-\s]?haves?|preferred|nice[-\s]to[-\s]have|rate this ai[-\s]generated content|show more|show less|see more|see less|good fit|maybe|not a fit)$/i;

  /** Which heading a line is, or "". */
  function qualificationCategoryOf(line) {
    const text = cleanText(line);
    if (MUST_HAVE_HEADING.test(text)) return QUALIFICATION_CATEGORY.MUST_HAVE;
    if (PREFERRED_HEADING.test(text)) return QUALIFICATION_CATEGORY.PREFERRED;
    return "";
  }

  /**
   * The verdict, from the icon first and the wording second.
   *
   * The icon is what the recruiter actually sees, so its accessible name is
   * trusted when there is one. The wording is the fallback, and it is
   * deliberately conservative: only an explicit negative reads as a miss, and
   * anything the platform declined to evaluate stays unknown. A requirement
   * with no explanation at all is unknown too — a blank is not a pass.
   */
  function classifyQualificationResult({ iconLabel = "", explanation = "" } = {}) {
    const icon = normalizeLabel(iconLabel);
    if (icon) {
      if (/\b(?:not met|does not meet|unmet|fail(?:ed|s)?|no match|mismatch|error|cross|close|dismiss|negative)\b/.test(icon)) {
        return QUALIFICATION_RESULT.NOT_MATCHED;
      }
      if (/\b(?:met|meets|match(?:ed|es)?|success|check|tick|complete|yes|positive)\b/.test(icon)) {
        return QUALIFICATION_RESULT.MATCHED;
      }
      if (/\b(?:unknown|question|unclear|cannot|not evaluated|help)\b/.test(icon)) {
        return QUALIFICATION_RESULT.UNKNOWN;
      }
    }

    const text = cleanText(explanation);
    if (!text) return QUALIFICATION_RESULT.UNKNOWN;
    if (NOT_EVALUATED_PATTERN.test(text)) return QUALIFICATION_RESULT.UNKNOWN;
    if (/\b(?:does not|doesn't|did not|didn't|has not|hasn't|is not|isn't|no experience|not located|less than)\b/i.test(text)) {
      return QUALIFICATION_RESULT.NOT_MATCHED;
    }
    if (/answered '?no'?/i.test(text)) return QUALIFICATION_RESULT.NOT_MATCHED;
    return QUALIFICATION_RESULT.MATCHED;
  }

  /** Where the platform says the verdict came from. */
  function classifyQualificationSource(note) {
    const text = cleanText(note);
    if (!text) return QUALIFICATION_SOURCE.UNKNOWN;
    if (/screening question/i.test(text)) return QUALIFICATION_SOURCE.SCREENING;
    if (/resume|cv\b/i.test(text)) return QUALIFICATION_SOURCE.RESUME;
    if (/profile/i.test(text)) return QUALIFICATION_SOURCE.PROFILE;
    return QUALIFICATION_SOURCE.UNKNOWN;
  }

  /**
   * One rendered qualification block into a record.
   *
   * The block is three lines at most: the requirement, the platform's sentence,
   * and the "Based on …" note. Anything else in it is chrome and is dropped.
   * `raw` keeps the block verbatim so a layout change is debuggable from the
   * stored record rather than only from a live page.
   */
  function parseQualificationBlock({ lines = [], category = "", iconLabel = "" } = {}) {
    const cleaned = (Array.isArray(lines) ? lines : toLines(lines))
      .map((line) => cleanText(line))
      .filter((line) => line && !QUALIFICATION_NOISE_PATTERN.test(line));
    if (!cleaned.length) return null;

    const requirement = cleaned[0];
    const rest = cleaned.slice(1);
    const note = rest.find((line) => SOURCE_NOTE_PATTERN.test(line)) || "";
    const explanation = rest.filter((line) => line !== note).join(" ");

    return {
      requirement,
      category: category || "",
      result: classifyQualificationResult({ iconLabel, explanation }),
      explanation: explanation || null,
      source: classifyQualificationSource(note),
      sourceNote: note || null,
      raw: cleaned.join("\n")
    };
  }

  /** Two qualifications are the same when the requirement text is the same. */
  function qualificationKey(record) {
    return `${cleanText(record?.category).toLowerCase()}|${cleanText(record?.requirement).toLowerCase()}`;
  }

  // ---------------------------------------------------- screening responses
  // "Have you completed …?" / "Ideal answer: Yes" / "Yes". The ideal answer and
  // the answer are stored separately and `met` is only decided when both are
  // present — a supplementary question with no ideal answer is not a failure.

  const IDEAL_ANSWER_PATTERN = /^ideal answer\s*[:\-]\s*(.*)$/i;
  const SCREENING_NOISE_PATTERN =
    /^(?:screening question responses?|screening questions?|supplementary|required|show more|show less|see more|see less)$/i;

  function parseScreeningBlock({ lines = [], iconLabel = "" } = {}) {
    const cleaned = (Array.isArray(lines) ? lines : toLines(lines))
      .map((line) => cleanText(line))
      .filter((line) => line && !SCREENING_NOISE_PATTERN.test(line));
    if (!cleaned.length) return null;

    const question = cleaned[0];
    let idealAnswer = null;
    const answers = [];
    for (const line of cleaned.slice(1)) {
      const ideal = IDEAL_ANSWER_PATTERN.exec(line);
      if (ideal) {
        idealAnswer = cleanText(ideal[1]) || null;
        continue;
      }
      answers.push(line);
    }
    const answer = answers.join(" ") || null;

    // Only ever a real comparison. Absent either half, the platform did not say.
    let met = null;
    if (idealAnswer && answer) met = idealAnswer.toLowerCase() === answer.toLowerCase();
    else if (iconLabel) {
      const verdict = classifyQualificationResult({ iconLabel });
      met = verdict === QUALIFICATION_RESULT.MATCHED ? true : verdict === QUALIFICATION_RESULT.NOT_MATCHED ? false : null;
    }

    return { question, idealAnswer, answer, met, raw: cleaned.join("\n") };
  }

  function screeningKey(record) {
    return cleanText(record?.question).toLowerCase();
  }

  // ------------------------------------------------------------- experience
  // The applicant panel renders a compressed experience card:
  //   HR Manager
  //   Naad Wellness • 2026-Present
  //   Experience verified
  // The company and the date range share one line separated by a middot that
  // does not always render, which is the same collapsed-metadata problem the
  // profile core solves with `stripEntityMeta` — so that is reused rather than
  // re-invented, and the split falls back to a date-range match when the
  // separator is missing entirely.

  const DATE_RANGE_PATTERN =
    /((?:19|20)\d{2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(?:19|20)?\d{0,4})\s*[-–—]\s*((?:19|20)\d{2}|present|current|now|[a-z]{3,9}\.?\s*(?:19|20)?\d{0,4})/i;

  const PRESENT_PATTERN = /\b(?:present|current|now|till date|to date)\b/i;
  const VERIFIED_PATTERN = /\b(?:experience verified|verified)\b/i;
  /**
   * Lines that are chrome rather than any field of a card.
   *
   * The section names of the applicant's OTHER sections are in here on purpose:
   * when a root spans more than one section, or the text fallback runs over a
   * range that reaches the next heading, "Education" would otherwise become a
   * job title with the school beneath it as the employer. A wrong entry is worse
   * than an empty one (rule 6).
   */
  const EXPERIENCE_NOISE_PATTERN =
    /^(?:experiences?|work experience|education(?:al background)?|skills?|top skills|about|summary|licenses? (?:&|and) certifications?|projects?|languages?|recommendations?|interests?|view full profile|see full profile|show (?:more|less|all)|see (?:more|less)|experience verified|verified)$/i;

  /** Split "Naad Wellness • 2026-Present" into its two halves. */
  function splitCompanyAndDates(line) {
    const text = cleanText(line);
    if (!text) return { company: "", dateRange: "" };
    const parts = text.split(/\s*[•·|]\s*/).map((part) => cleanText(part)).filter(Boolean);
    if (parts.length > 1) {
      const dateAt = parts.findIndex((part) => DATE_RANGE_PATTERN.test(part) || PRESENT_PATTERN.test(part));
      if (dateAt > 0) {
        return { company: parts.slice(0, dateAt).join(" · "), dateRange: parts.slice(dateAt).join(" · ") };
      }
      return { company: parts[0], dateRange: parts.slice(1).join(" · ") };
    }
    // No separator rendered: cut at the date range itself.
    const match = DATE_RANGE_PATTERN.exec(text);
    if (match && match.index > 0) {
      return { company: cleanText(text.slice(0, match.index)), dateRange: cleanText(text.slice(match.index)) };
    }
    return { company: text, dateRange: "" };
  }

  /**
   * One experience card into a record.
   *
   * `title` is the first line, the company/date line is the next one that
   * carries either, and everything else is kept as `details`. Nothing is
   * inferred: a card with no dates stores an empty range rather than a guess.
   */
  function parseExperienceBlock(lines = []) {
    const cleaned = (Array.isArray(lines) ? lines : toLines(lines))
      .map((line) => cleanText(line))
      .filter(Boolean);
    const meaningful = cleaned.filter((line) => !EXPERIENCE_NOISE_PATTERN.test(line));
    if (!meaningful.length) return null;

    const core = CORE();
    const title = core?.sanitizeRoleTitle ? core.sanitizeRoleTitle(meaningful[0]) || meaningful[0] : meaningful[0];
    const rest = meaningful.slice(1);
    const companyLineAt = rest.findIndex((line) => DATE_RANGE_PATTERN.test(line) || PRESENT_PATTERN.test(line));
    const companyLine = companyLineAt >= 0 ? rest[companyLineAt] : rest[0] || "";
    const { company, dateRange } = splitCompanyAndDates(companyLine);
    const details = rest.filter((line) => line !== companyLine);

    return {
      title,
      company: core?.sanitizeCompanyName ? core.sanitizeCompanyName(company) || company : company,
      dateRange: dateRange || "",
      current: PRESENT_PATTERN.test(dateRange),
      verified: cleaned.some((line) => VERIFIED_PATTERN.test(line)),
      details: uniqueText(details),
      raw: cleaned.join("\n")
    };
  }

  function experienceKey(record) {
    return [
      cleanText(record?.title).toLowerCase(),
      cleanText(record?.company).toLowerCase(),
      cleanText(record?.dateRange).toLowerCase()
    ].join("|");
  }

  /**
   * The role the applicant is in right now.
   *
   * The card marked Present wins; failing that the first card, because the panel
   * renders them most recent first. The headline is never used for this — the
   * headline in the live defect that prompted the rule read
   * "HR Head | Talent Acquisition | Employer Branding | …", which is a personal
   * banner and names no employer at all.
   */
  function deriveCurrentPosition(entries) {
    const list = (entries || []).filter(Boolean);
    if (!list.length) return { currentRole: null, currentCompany: null };
    const chosen = list.find((entry) => entry.current) || list[0];
    return {
      currentRole: cleanText(chosen.title) || null,
      currentCompany: cleanText(chosen.company) || null
    };
  }

  /**
   * A range in the form the profile core's parser accepts.
   *
   * `parseDateRange` refuses to treat a hyphen glued between two digits as a
   * range separator — that guard is what stops "3-5 years" and "2019-03" being
   * read as ranges on a profile, where LinkedIn renders "Jan 2019 - Mar 2023"
   * with spaces. The recruiter applicant card renders "2026-Present" and
   * "2022-2025" with **no** spaces, so the separator has to be restored before
   * the shared parser sees it. Only a hyphen immediately after a four-digit year
   * is touched, so nothing else can be turned into a range by this.
   */
  function normalizeDateRange(value) {
    return cleanText(value).replace(/((?:19|20)\d{2})\s*-\s*/g, "$1 - ");
  }

  /**
   * Total experience, in the profile core's own words, or null.
   *
   * The entries are handed over whole rather than reduced to date strings:
   * `calculateTotalExperience` reads `dateRange` **and** `title`, because it
   * excludes internships and merges overlapping ranges rather than summing them.
   * Passing a `{ dates }` object instead — as this did until 3.7.1 — matched
   * neither key, so every range was skipped and the column was always empty.
   */
  function totalExperienceFrom(entries) {
    const core = CORE();
    if (!core?.calculateTotalExperience) return null;
    const records = (entries || [])
      .filter((entry) => cleanText(entry?.dateRange))
      .map((entry) => ({ title: cleanText(entry?.title), dateRange: normalizeDateRange(entry?.dateRange) }));
    if (!records.length) return null;
    return cleanText(core.calculateTotalExperience(records)) || null;
  }

  // -------------------------------------------------------------- education
  // Stored in full here, unlike the connections record: a recruiter comparing
  // applicants needs the degree, not only the school.

  const EDUCATION_NOISE_PATTERN =
    /^(?:education|show more|show less|see more|see less|view full profile)$/i;

  function parseEducationBlock(lines = []) {
    const cleaned = (Array.isArray(lines) ? lines : toLines(lines))
      .map((line) => cleanText(line))
      .filter((line) => line && !EDUCATION_NOISE_PATTERN.test(line));
    if (!cleaned.length) return null;

    const institution = cleaned[0];
    const rest = cleaned.slice(1);
    const dateLine = rest.find((line) => DATE_RANGE_PATTERN.test(line)) || "";
    const degreeLine = rest.find((line) => line !== dateLine) || "";
    const [degree, field] = degreeLine.split(/\s*[,·•]\s*/).map((part) => cleanText(part));

    return {
      institution,
      degree: degree || null,
      field: field || null,
      dateRange: dateLine ? cleanText(dateLine.replace(/^[^0-9a-z]*/i, "")) : null,
      raw: cleaned.join("\n")
    };
  }

  function educationKey(record) {
    return [
      cleanText(record?.institution).toLowerCase(),
      cleanText(record?.degree).toLowerCase(),
      cleanText(record?.dateRange).toLowerCase()
    ].join("|");
  }

  // ------------------------------------------------------------------- job
  // The job header carries the title and the applicant count. Company and
  // location are only present on some of the hiring views, so both are null
  // until a view that actually renders them is read — never derived from the
  // recruiter's own account, which is not the same thing as the job's company.

  const APPLICANT_COUNT_PATTERN = /applicants?\s*\((\d[\d,]*)\)/i;

  function parseJobHeader({ text = "", title = "", url = "" } = {}) {
    const lines = toLines(text);
    const context = parseHiringContext(url);
    const countLine = lines.find((line) => APPLICANT_COUNT_PATTERN.test(line)) || cleanText(text);
    const countMatch = APPLICANT_COUNT_PATTERN.exec(countLine);
    // The heading is the first line that is not one of the view tabs.
    const tab = /^(?:hiring plan|candidate search|applicants?|manage coworkers|job details?|settings)\b/i;
    const heading = lines.find((line) => line && !tab.test(line) && line.length <= 160) || "";

    return {
      id: context.jobId,
      title: heading || cleanText(title).replace(/\s*\|\s*linkedin\s*$/i, "") || null,
      company: null,
      location: null,
      description: null,
      applicantCount: countMatch ? Number(countMatch[1].replace(/,/g, "")) : null,
      url: context.url || null
    };
  }

  /** Merge a later, more hydrated read of the job over an earlier one. */
  function mergeJob(existing, incoming) {
    const merged = { ...(existing || {}) };
    for (const [key, value] of Object.entries(incoming || {})) {
      if (value === null || value === undefined || value === "") continue;
      if (merged[key] === null || merged[key] === undefined || merged[key] === "") merged[key] = value;
    }
    return merged;
  }

  // -------------------------------------------------------------- applicant
  // The panel header: name, verification badge, degree, headline, location, and
  // the application timeline. The degree badge and the verification word are
  // stripped from the name — "Mahak Ayani ✓ · 2nd" is not somebody's name.

  const APPLIED_PATTERN = /\bapplied\s+([^\n•·|]+)/i;
  const CONTACTED_PATTERN = /\bcontacted\s+([^\n•·|]+)/i;
  const DEGREE_BADGE_PATTERN = /\s*(?:[·•]\s*)?(?:1st|2nd|3rd)(?:\+)?\s*$/i;
  const NAME_NOISE_PATTERN = /\b(?:verified|verification|premium|open to work|hiring)\b/gi;

  function cleanApplicantName(value) {
    return cleanText(String(value ?? "").replace(NAME_NOISE_PATTERN, " ")).replace(DEGREE_BADGE_PATTERN, "").trim();
  }

  /**
   * Page chrome that is never somebody's name.
   *
   * The live defect this exists for: the detail panel was resolved to a
   * container that also held the applicant list, and the first line of that
   * container's text is the list's own heading — so every record was saved with
   * the name "Applicants". Taking "the first line" was never a name rule; this
   * is.
   */
  const NAME_CHROME_PATTERN =
    /^(?:applicants?|candidates?|qualifications?|must[-\s]?haves?|preferred|nice[-\s]to[-\s]have|experience|education|skills?|screening question(?: response)?s?|supplementary|required|hiring plan|candidate search|manage coworkers|job details?|top fit|all applicants|filter(?: and sort)?|sort|search|resume|résumé|cv|share|shortlist|move to|contact|contact info(?:rmation)?|interview with ai|rate this ai[-\s]generated content|view full profile|see full profile|messaging|notifications|home|my network|jobs|advertise|for business|show more|show less|see more|see less|open to work|premium)\b/i;

  /** A word that could be part of a person's name: it starts with a capital. */
  const NAME_WORD_PATTERN = /^[A-ZÀ-ɏ][\w''À-ɏ.-]*$/u;

  /**
   * An imperative control label — a thing to press, not a person.
   *
   * THE LIVE DEFECT: applicants were saved as **"Edit qualifications"**.
   * `NAME_CHROME_PATTERN` is anchored at the start and does list `qualifications`,
   * but the label leads with `Edit`, so it never reached that term; two
   * capitalised words then satisfied every remaining test and the panel heading
   * became the person. Exactly the failure that once saved six people as
   * "Applicants", one verb further along.
   *
   * Matched as **verb + at least one more word**, which is what makes it a
   * control phrase rather than a name. A bare `Edit` is deliberately still
   * allowed: it is a real given name in Hungarian, and refusing it outright
   * would trade a wrong name for a missing one on a real person. The verbs are
   * only those that are not themselves given names — `Mark`, `Grant`, `Will`,
   * `Rose` and `Art` are deliberately absent.
   */
  const NAME_CONTROL_PHRASE_PATTERN =
    /^(?:edit|add|view|manage|download|upload|remove|delete|send|share|save|open|close|show|hide|see|filter|sort|select|deselect|expand|collapse|apply|invite|message|report|block|dismiss|refresh|update|create|copy|print|export|import|schedule|rate|compare|assign|archive|shortlist|reject|withdraw|advertise|post|browse|explore|discover|learn|start|continue|skip|back|next|previous|cancel|confirm|submit|search)\s+\S/i;

  /**
   * Could this text be the applicant's name?
   *
   * Deliberately conservative. A wrong name is worse than an empty one: it is
   * the column the whole export is read by, and "Applicants" on six rows is
   * indistinguishable at a glance from six real records.
   */
  function isApplicantNameCandidate(value) {
    const text = cleanApplicantName(value);
    if (!text || text.length > 80) return false;
    if (NAME_CHROME_PATTERN.test(text)) return false;
    // A control phrase is a thing to press, not a person: "Edit qualifications"
    // led with a verb the chrome list could not see and became six people's name.
    if (NAME_CONTROL_PHRASE_PATTERN.test(text)) return false;
    // An address, a count, a date or a duration is not a name.
    if (/@/.test(text) || /\d{3,}/.test(text)) return false;
    if (!/[A-Za-zÀ-ɏ]/.test(text)) return false;
    const words = text.split(/\s+/);
    if (words.length > 5) return false;
    return NAME_WORD_PATTERN.test(words[0]);
  }

  /**
   * The name the platform's own explanations are written about.
   *
   * LinkedIn writes each qualification verdict as a sentence starting with the
   * applicant: "Mahak Ayani answered 'Yes' …", "Mahak Ayani has 3 years …",
   * "Mahak Ayani is located in Delhi …". The words those sentences share at the
   * front are the name, stated by the platform itself — which makes this the
   * strongest corroboration available and the one signal no layout change can
   * take away, because it is prose rather than markup.
   *
   * Needs two sentences to agree. One sentence is a prefix of itself and would
   * hand back its own first few words.
   */
  function nameFromExplanations(explanations) {
    const sentences = (explanations || []).map((entry) => cleanText(entry)).filter(Boolean);
    if (sentences.length < 2) return "";

    let prefix = sentences[0].split(/\s+/);
    for (const sentence of sentences.slice(1)) {
      const words = sentence.split(/\s+/);
      let index = 0;
      while (index < prefix.length && index < words.length
        && prefix[index].toLowerCase() === words[index].toLowerCase()) index += 1;
      prefix = prefix.slice(0, index);
      if (!prefix.length) return "";
    }

    // Only the leading capitalised run: a shared "has" or "answered" after the
    // name is a verb, not part of it.
    const name = [];
    for (const word of prefix.slice(0, 5)) {
      if (!NAME_WORD_PATTERN.test(word)) break;
      name.push(word);
    }
    const text = cleanApplicantName(name.join(" "));
    // Two words or more: a single leading capital is as likely to be the first
    // word of a sentence as a mononym.
    return name.length >= 2 && isApplicantNameCandidate(text) ? text : "";
  }

  /**
   * Choose the applicant's name from everything that claims to be it.
   *
   * `candidates` are `{ value, source }` in the caller's preference order, and
   * `corroboration` is the name the explanations were written about. A candidate
   * the explanations agree with wins outright; otherwise the first candidate
   * that survives `isApplicantNameCandidate` does. If nothing survives, the
   * corroborated name is used on its own — and if there is none of that either,
   * the answer is "" rather than a guess.
   */
  function chooseApplicantName(candidates = [], corroboration = "") {
    const agreed = cleanApplicantName(corroboration);
    const usable = (candidates || [])
      .map((entry) => ({ ...entry, value: cleanApplicantName(entry?.value) }))
      .filter((entry) => isApplicantNameCandidate(entry.value));

    if (agreed) {
      const match = usable.find((entry) => entry.value.toLowerCase() === agreed.toLowerCase());
      if (match) return { name: match.value, source: match.source, corroborated: true };
      // The explanations name somebody the markup did not offer. Trust the
      // platform's own prose over a heading we guessed at.
      return { name: agreed, source: "explanations", corroborated: true };
    }
    if (usable.length) return { name: usable[0].value, source: usable[0].source, corroborated: false };
    return { name: "", source: "", corroborated: false };
  }

  /**
   * The application's own status line.
   *
   * Kept verbatim rather than mapped onto an enum: LinkedIn's own vocabulary
   * here ("Shortlisted", "Reviewed", "Not a fit", "Interviewing") is the answer
   * the recruiter is looking at, and folding it into three buckets would lose
   * the distinction the screen is making.
   */
  const APPLICATION_STATUS_PATTERN =
    /\b(?:shortlisted|not a fit|maybe|good fit|reviewed|in review|interviewing|interviewed|offer|hired|rejected|declined|withdrawn|new|pending|contacted|archived)\b/i;

  function parseApplicantHeader({ text = "" } = {}) {
    const lines = toLines(text);
    const applied = APPLIED_PATTERN.exec(text);
    const contacted = CONTACTED_PATTERN.exec(text);
    // The timeline line is not a status line. "Applied 12mo ago · Contacted 12mo
    // ago" contains the word "Contacted" and would otherwise be reported as the
    // application's status, which is a different thing entirely.
    const statusLine = lines.find(
      (line) => APPLICATION_STATUS_PATTERN.test(line) && !APPLIED_PATTERN.test(line) && !CONTACTED_PATTERN.test(line)
    ) || "";
    const status = statusLine ? APPLICATION_STATUS_PATTERN.exec(statusLine) : null;

    // The first line only counts as the name when it could actually BE one.
    // Taking it unconditionally is what saved the list's own heading,
    // "Applicants", as six different people's names.
    const first = lines.length ? cleanApplicantName(lines[0]) : "";
    return {
      name: isApplicantNameCandidate(first) ? first : "",
      headline: lines[1] ? cleanText(lines[1]) : "",
      location: lines[2] && !APPLIED_PATTERN.test(lines[2]) ? cleanText(lines[2]) : "",
      appliedAt: applied ? cleanText(applied[1]) : "",
      contactedAt: contacted ? cleanText(contacted[1]) : "",
      applicationStatus: status ? cleanText(status[0]) : ""
    };
  }

  // ------------------------------------------------------------- the record
  // The schema is the one the request specified, kept literally: absent values
  // are `null`, never "" and never a guess, and `extraction.rawData` holds the
  // verbatim text every parsed field came from so a layout change is diagnosable
  // from the export alone.

  /** A hash that is stable for the same applicant on the same job. */
  function applicantId(jobId, profileUrl, name, applicationId = "") {
    const core = CORE();
    const canonical = core?.canonicalizeProfileUrl ? core.canonicalizeProfileUrl(profileUrl) : cleanText(profileUrl);
    const input = `${cleanText(jobId)}|${canonical}|${cleanText(name)}|${cleanText(applicationId)}`.toLowerCase();
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `applicant_${(hash >>> 0).toString(16)}`;
  }

  const RESUME_STATUS = Object.freeze({
    NOT_ATTEMPTED: "not_attempted",
    DOWNLOADED: "downloaded",
    ALREADY_SAVED: "already_saved",
    LINK_ONLY: "link_only",
    UNAVAILABLE: "unavailable",
    FAILED: "failed"
  });

  /** File types a resume is actually delivered as. */
  const RESUME_EXTENSION_PATTERN = /\.(?:pdf|docx?|odt|rtf|txt|pages)(?:$|[?#])/i;

  /**
   * Hosts and paths that serve the document rather than a page about it.
   *
   * LinkedIn's media CDN, and the storage routes it proxies through. An id with
   * no extension on `media.licdn.com` IS the file; the same id under
   * `linkedin.com/hiring/...` is the page that displays it.
   */
  const RESUME_MEDIA_PATTERN =
    /^https?:\/\/(?:[a-z0-9-]+\.)*(?:licdn\.com|licdn\.cn)\//i;
  const RESUME_MEDIA_PATH_PATTERN = /\/(?:dms|ambry|media-proxy|documents?|attachments?)\//i;

  /**
   * A LinkedIn media address that is emphatically NOT the document.
   *
   * THE HOLE THIS CLOSES, and it threatened the no-open path specifically.
   * `RESUME_MEDIA_PATTERN` accepts a licdn host on the HOST ALONE — no path, no
   * extension — because an opaque `/dms/document/<id>` with no extension really
   * is the file. But the pre-click sweep `findResumeDocumentUrl(null)` reads
   * `meta[content]`, `[data-src]` and `[data-delayed-url]` across the whole
   * `document`, `<head>` included, so an `og:image` or a portrait satisfied
   * "the address is already known": nothing was opened, and a JPEG was written to
   * `profile-vault-resumes/` under the applicant's name and reported
   * `downloaded`. Nothing downstream could catch it either — the descriptor check
   * only refuses JSON, the page fetch only refuses HTML, and the worker's host
   * check passes `media.licdn.com` happily.
   *
   * This file already knew the distinction: `imageManifestUrl` is deliberately
   * excluded from `DESCRIPTOR_URL_FIELDS` because it "names the page IMAGES the
   * viewer paints, not the file". The same reasoning, applied to the address.
   *
   * Consulted AFTER `RESUME_EXTENSION_PATTERN`, so a genuine `.pdf`/`.docx` wins
   * however it is served, and before the host and path accepts, which are the two
   * that cannot tell a picture from a CV.
   */
  const NON_DOCUMENT_MEDIA_PATTERN = new RegExp([
    "/dms/(?:image|video|audio)/",
    "profile-displayphoto",
    "profile-originalphoto",
    "company-logo",
    "\\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|mp4|webm|mov|mp3|wav|css|js)(?:$|[?#])"
  ].join("|"), "i");

  /** A LinkedIn page — an address bar destination, never a file. */
  const LINKEDIN_PAGE_PATTERN =
    /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/(?:hiring|talent|in|jobs|feed|company|school|mynetwork|messaging)\b/i;

  /**
   * Is this URL the resume FILE?
   *
   * The live defect this exists for: the resume control's `href` on the hiring
   * surface is a route — `linkedin.com/hiring/applicants/...` — not the
   * document. It was stored as `resume.url`, so "Open resume" reopened the
   * applicants page, and worse, the worker fetched that HTML page and saved it
   * as somebody's CV while reporting `downloaded`.
   *
   * A file is a document extension, or a media-CDN address, or a storage path.
   * A LinkedIn page address is never a file, whatever else it looks like — that
   * test is applied FIRST, exactly as `looksLikeCvLink` refuses a linkedin.com
   * address before it considers anything else.
   */
  function isResumeDocumentUrl(value) {
    const url = cleanText(value);
    if (!url || !/^https?:\/\//i.test(url)) return false;
    if (LINKEDIN_PAGE_PATTERN.test(url)) return false;
    if (RESUME_EXTENSION_PATTERN.test(url)) return true;
    // A picture, a video or a stylesheet is not a CV, however LinkedIn serves it.
    if (NON_DOCUMENT_MEDIA_PATTERN.test(url)) return false;
    if (RESUME_MEDIA_PATTERN.test(url)) return true;
    return RESUME_MEDIA_PATH_PATTERN.test(url);
  }

  /**
   * Fields a viewer descriptor writes the real document's address into.
   *
   * `imageManifestUrl` is deliberately absent: it names the page IMAGES the
   * viewer paints, not the file, and saving those would be the same class of
   * mistake as saving the descriptor itself.
   */
  const DESCRIPTOR_URL_FIELDS = Object.freeze([
    "transcribedDocumentUrl", "downloadUrl", "documentUrl", "fileUrl", "assetUrl", "url"
  ]);

  /**
   * The document's address hiding inside a viewer descriptor.
   *
   * THE LIVE DEFECT this exists for. On a recruiter account the address the
   * document viewer fetches is not the document: it answers with JSON —
   * `{"asset":"urn:li:digitalmediaAsset:…","transcribedDocumentUrl":"…",
   * "scanRequiredForDownload":true,"perResolutions":[…]}` — and every refusal in
   * `isResumeDocumentUrl` passes it, correctly, because it IS a `/dms/` path on
   * a LinkedIn host. So that JSON was written to disk under the applicant's name
   * and reported as `downloaded`. The recruiter's CV was a metadata blob.
   *
   * Nothing here is guessed or constructed. It reads the address out of the
   * field LinkedIn's own descriptor names it in, and the result must still pass
   * `isResumeDocumentUrl` — so a descriptor pointing at a page route yields
   * nothing, exactly as an attribute holding one does. Returns "" when the body
   * is not a descriptor at all, which is the common case and costs one parse.
   */
  function documentUrlFromDescriptor(body) {
    let parsed = body;
    if (typeof body === "string") {
      const text = body.trim();
      if (!text.startsWith("{") && !text.startsWith("[")) return "";
      try {
        parsed = JSON.parse(text);
      } catch {
        return "";
      }
    }
    if (!parsed || typeof parsed !== "object") return "";

    const seen = new Set();
    const queue = [parsed];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      for (const field of DESCRIPTOR_URL_FIELDS) {
        if (isResumeDocumentUrl(node[field])) return cleanText(node[field]);
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") queue.push(value);
      }
    }
    return "";
  }

  // ------------------------------------------------- naming the saved resume
  // The file on disk is named after the person, because that is the only thing
  // the recruiter can search their downloads folder for. LinkedIn's own name for
  // the file is an opaque media id on most accounts, and where it is not, it is
  // whatever the applicant happened to call it.
  //
  // Every rule here is pure and lives in the core rather than in the worker, so
  // the cases that actually break a save — a name with a slash in it, a name
  // that is a Windows device name, a name that is nothing but dots — are tested
  // rather than hoped for. The worker owns `chrome.downloads`; it does not own
  // the policy.

  /** Characters no filesystem this extension can land on will accept. */
  const INVALID_FILENAME_PATTERN = /[/\\:*?"<>|]/g;
  /** C0 controls, which Windows refuses and every other system regrets. */
  const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/g;
  /**
   * Names Windows reserves for devices, with or without an extension.
   *
   * `CON.pdf` is not a file on Windows — the download fails or silently lands
   * somewhere else. Rare in a person's name and catastrophic when it happens,
   * so it is handled rather than hoped away.
   */
  const RESERVED_FILENAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  /** Well short of every filesystem's limit, with room for a suffix and a type. */
  const MAX_FILENAME_STEM = 100;

  /**
   * A person's name, as a filename stem. Never a path, never empty.
   *
   * Only the stem: no extension, no directory, no suffix. Those are added by
   * `resumeFileName()`, so there is exactly one place a separator can be
   * introduced and exactly one place it is stripped.
   */
  function sanitizeFileName(value) {
    const stem = cleanText(value)
      .replace(CONTROL_CHARACTER_PATTERN, "")
      .replace(INVALID_FILENAME_PATTERN, " ")
      // A leading dot hides the file on Unix and a trailing dot or space is
      // silently dropped by Windows, which is how "John." becomes "John" on one
      // machine and a broken write on another.
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+/, "")
      .replace(/[.\s]+$/, "")
      .slice(0, MAX_FILENAME_STEM)
      .trim();
    if (!stem) return "";
    return RESERVED_FILENAME_PATTERN.test(stem) ? `${stem} file` : stem;
  }

  /** `pdf` from `pdf`, `.PDF`, `application/pdf` or `resume.pdf`. Never invented. */
  function resumeFileExtension(fileType, filename, url) {
    const direct = cleanText(fileType).toLowerCase().replace(/^\.|^[a-z]+\//, "");
    if (/^[a-z0-9]{1,8}$/.test(direct)) return direct;
    for (const candidate of [filename, url]) {
      const match = /\.([a-z0-9]{1,8})(?:$|[?#])/i.exec(cleanText(candidate));
      if (match) return match[1].toLowerCase();
    }
    return "";
  }

  /**
   * What this applicant's resume is saved as.
   *
   * `John Smith.pdf`, and `John Smith (2).pdf` for the **second different
   * person** of that name — `index` is the caller's count of distinct
   * applicants already given this name, so the same applicant collected twice
   * keeps their own file rather than growing a `(2)` on every visit. Numbering
   * starts at 2 because the first `John Smith` is simply `John Smith`.
   *
   * An unknown type yields **no extension** rather than a guessed `.pdf`: rule 6
   * applies to a name written to the recruiter's disk exactly as it applies to a
   * field, and a `.pdf` that is really a `.docx` is worse than no suffix at all.
   * A nameless applicant falls back to whatever LinkedIn called the file, and
   * only then to a stamped name the caller supplies.
   */
  function resumeFileName({ name = "", fileType = "", filename = "", url = "", index = 0, fallback = "resume" } = {}) {
    const stem = sanitizeFileName(name) || sanitizeFileName(String(filename).replace(/\.[a-z0-9]{1,8}$/i, "")) || sanitizeFileName(fallback) || "resume";
    const suffix = Number.isFinite(index) && index > 0 ? ` (${index + 1})` : "";
    const extension = resumeFileExtension(fileType, filename, url);
    return `${stem}${suffix}${extension ? `.${extension}` : ""}`;
  }

  /** "" and undefined both become null. Anything else keeps its own value. */
  function orNull(value) {
    const text = cleanText(value);
    return text || null;
  }

  function normalizeList(values, keyOf) {
    const seen = new Set();
    const output = [];
    for (const value of values || []) {
      if (!value) continue;
      const key = keyOf ? keyOf(value) : cleanText(value).toLowerCase();
      if (!key || key === "||" || seen.has(key)) continue;
      seen.add(key);
      output.push(value);
    }
    return output;
  }

  /**
   * The stored record, in the shape the request specified.
   *
   * Every call is idempotent — normalizing an already-normalized record returns
   * the same thing — so it is safe to run on read as well as on write, which is
   * what lets a record written by an older build be repaired lazily.
   */
  function normalizeApplicantRecord(input = {}) {
    const now = new Date().toISOString();
    const source = input || {};
    const job = mergeJob(
      { id: null, title: null, company: null, location: null, description: null, applicantCount: null, url: null },
      source.job || {}
    );
    const applicant = source.applicant || {};
    const contact = applicant.contact || {};
    const resume = applicant.resume || {};
    const extraction = source.extraction || {};

    const experience = normalizeList(applicant.experience, experienceKey);
    const derived = deriveCurrentPosition(experience);
    const name = cleanApplicantName(applicant.name);
    const core = CORE();
    const profileUrl = core?.canonicalizeProfileUrl
      ? core.canonicalizeProfileUrl(applicant.profileUrl)
      : cleanText(applicant.profileUrl);

    return {
      id: source.id || applicantId(job.id, profileUrl, name, source.applicationId),
      applicationId: orNull(source.applicationId),
      job: {
        id: orNull(job.id),
        title: orNull(job.title),
        company: orNull(job.company),
        location: orNull(job.location),
        description: orNull(job.description),
        applicantCount: Number.isFinite(job.applicantCount) ? job.applicantCount : null,
        url: orNull(job.url),
        mustHaveQualifications: normalizeList(job.mustHaveQualifications || [], (entry) => cleanText(entry).toLowerCase()),
        preferredQualifications: normalizeList(job.preferredQualifications || [], (entry) => cleanText(entry).toLowerCase()),
        screeningQuestions: normalizeList(job.screeningQuestions || [], (entry) => cleanText(entry?.question).toLowerCase())
      },
      applicant: {
        name,
        profileUrl: profileUrl || null,
        headline: orNull(applicant.headline),
        location: orNull(applicant.location),
        currentRole: orNull(applicant.currentRole) || derived.currentRole,
        currentCompany: orNull(applicant.currentCompany) || derived.currentCompany,
        totalExperience: orNull(applicant.totalExperience) || totalExperienceFrom(experience),
        appliedAt: orNull(applicant.appliedAt),
        contactedAt: orNull(applicant.contactedAt),
        contact: {
          email: orNull(contact.email),
          phone: orNull(contact.phone),
          website: orNull(contact.website),
          other: normalizeList(contact.other || [])
        },
        resume: {
          available: Boolean(resume.available),
          filename: orNull(resume.filename),
          fileType: orNull(resume.fileType),
          // What the opened viewer said, when it said anything. Never guessed
          // from the file size or the URL — a viewer that shows no page count
          // leaves this null.
          pages: Number.isFinite(resume.pages) && resume.pages > 0 ? Math.round(resume.pages) : null,
          // The document, and only ever the document. A LinkedIn page address
          // arriving here from an older record, a hand edit or a route that was
          // mistaken for a file is moved to `viewerUrl` rather than offered as
          // the CV — the same defence in depth `normalizeProfile` applies to
          // `cvUrl`.
          url: isResumeDocumentUrl(resume.url) ? cleanText(resume.url) : null,
          // Where LinkedIn shows it. Useful to open, useless to download.
          viewerUrl: orNull(resume.viewerUrl) || (isResumeDocumentUrl(resume.url) ? null : orNull(resume.url)),
          localReference: orNull(resume.localReference),
          downloadStatus: cleanText(resume.downloadStatus) || RESUME_STATUS.NOT_ATTEMPTED
        },
        experience,
        education: normalizeList(applicant.education, educationKey),
        skills: uniqueText(applicant.skills),
        screeningResponses: normalizeList(applicant.screeningResponses, screeningKey),
        qualifications: normalizeList(applicant.qualifications, qualificationKey),
        applicationStatus: orNull(applicant.applicationStatus)
      },
      extraction: {
        timestamp: cleanText(extraction.timestamp) || now,
        sourceUrl: orNull(extraction.sourceUrl),
        buildId: orNull(extraction.buildId),
        warnings: uniqueText(extraction.warnings),
        rawData: extraction.rawData && typeof extraction.rawData === "object" ? extraction.rawData : {}
      },
      collectedAt: cleanText(source.collectedAt) || now,
      updatedAt: now,
      schemaVersion: 1
    };
  }

  /**
   * Merge a fresh collection over a stored record.
   *
   * Merge-only for the lists, exactly like the profile accumulator, because a
   * panel that was collapsed on one visit and expanded on the next must add to
   * the record rather than replace it. A resume that was already downloaded
   * keeps its filename and status — the point of the dedupe is that the second
   * visit does not download it again and does not forget that it has it.
   */
  function mergeApplicantRecord(existing, incoming) {
    if (!existing) return normalizeApplicantRecord(incoming);
    const before = normalizeApplicantRecord(existing);
    const after = normalizeApplicantRecord(incoming);

    const keepDownload =
      before.applicant.resume.downloadStatus === RESUME_STATUS.DOWNLOADED &&
      after.applicant.resume.downloadStatus !== RESUME_STATUS.DOWNLOADED;

    return normalizeApplicantRecord({
      ...after,
      id: before.id,
      collectedAt: before.collectedAt,
      job: mergeJob(after.job, before.job),
      applicant: {
        ...after.applicant,
        contact: {
          email: after.applicant.contact.email || before.applicant.contact.email,
          phone: after.applicant.contact.phone || before.applicant.contact.phone,
          website: after.applicant.contact.website || before.applicant.contact.website,
          other: [...before.applicant.contact.other, ...after.applicant.contact.other]
        },
        resume: keepDownload ? before.applicant.resume : { ...before.applicant.resume, ...after.applicant.resume },
        experience: [...before.applicant.experience, ...after.applicant.experience],
        education: [...before.applicant.education, ...after.applicant.education],
        skills: [...before.applicant.skills, ...after.applicant.skills],
        screeningResponses: [...before.applicant.screeningResponses, ...after.applicant.screeningResponses],
        qualifications: [...before.applicant.qualifications, ...after.applicant.qualifications]
      },
      extraction: {
        ...after.extraction,
        warnings: [...before.extraction.warnings, ...after.extraction.warnings],
        rawData: { ...before.extraction.rawData, ...after.extraction.rawData }
      }
    });
  }

  // ---------------------------------------------------------- the accumulator
  // The applicant panel virtualizes exactly like a profile does: a section
  // scrolled past is unmounted, so a scan that replaced what it held would lose
  // the sections it had already read. Merge-only, and its `signature()` feeds
  // the scan's quiet count so a section that hydrates late restarts it.

  function createApplicantAccumulator() {
    const state = {
      job: {},
      header: {},
      qualifications: new Map(),
      screening: new Map(),
      experience: new Map(),
      education: new Map(),
      skills: new Map(),
      contact: { emails: [], phones: [], websites: [], other: [] },
      resume: null,
      warnings: [],
      raw: {}
    };

    /** Add to a keyed map without ever overwriting a filled field with a blank. */
    const addKeyed = (map, key, record) => {
      const id = cleanText(key);
      if (!id || id === "||") return "skipped";
      const existing = map.get(id);
      if (!existing) {
        map.set(id, record);
        return "added";
      }
      let enriched = false;
      for (const [field, value] of Object.entries(record || {})) {
        const empty = existing[field] === null || existing[field] === undefined || existing[field] === "";
        if (empty && value !== null && value !== undefined && value !== "") {
          existing[field] = value;
          enriched = true;
        }
      }
      return enriched ? "enriched" : "unchanged";
    };

    return {
      addJob(job) {
        state.job = mergeJob(state.job, job || {});
      },
      addHeader(header) {
        for (const [key, value] of Object.entries(header || {})) {
          // `name` has its own rule — see `addName`.
          if (key === "name") continue;
          if (cleanText(value) && !cleanText(state.header[key])) state.header[key] = cleanText(value);
        }
      },
      /**
       * The name, which is the one header field that may be replaced.
       *
       * Every other field is first-wins, because a later read is only ever a
       * more hydrated version of the same thing. The name is different: the
       * strongest evidence for it — the platform's own explanation sentences —
       * only exists once the qualifications have been read, which is after the
       * first snapshot on a slow panel. First-wins would freeze whatever the
       * markup offered before that arrived. So a corroborated name replaces an
       * uncorroborated one, once, and nothing replaces a corroborated one.
       */
      addName(name, corroborated = false) {
        const text = cleanText(name);
        if (!text) return "skipped";
        const existing = cleanText(state.header.name);
        if (existing && (state.header.nameCorroborated || !corroborated)) return "unchanged";
        state.header.name = text;
        state.header.nameCorroborated = Boolean(corroborated);
        return existing ? "replaced" : "added";
      },
      addQualification(record) {
        return record ? addKeyed(state.qualifications, qualificationKey(record), record) : "skipped";
      },
      addScreening(record) {
        return record ? addKeyed(state.screening, screeningKey(record), record) : "skipped";
      },
      addExperience(record) {
        return record ? addKeyed(state.experience, experienceKey(record), record) : "skipped";
      },
      addEducation(record) {
        return record ? addKeyed(state.education, educationKey(record), record) : "skipped";
      },
      addSkill(value) {
        const text = cleanText(value);
        if (!text) return "skipped";
        return addKeyed(state.skills, text.toLowerCase(), { name: text });
      },
      addContactPanel(panel) {
        const before = state.contact.emails.length + state.contact.phones.length + state.contact.websites.length;
        state.contact.emails = uniqueText([...state.contact.emails, ...(panel?.emails || [])]);
        state.contact.phones = uniqueText([...state.contact.phones, ...(panel?.phones || [])]);
        state.contact.websites = uniqueText([...state.contact.websites, ...(panel?.websites || []), ...(panel?.cvLinks || [])]);
        return state.contact.emails.length + state.contact.phones.length + state.contact.websites.length - before;
      },
      setResume(resume) {
        state.resume = resume ? { ...(state.resume || {}), ...resume } : state.resume;
      },
      addWarning(message) {
        const text = cleanText(message);
        if (text && !state.warnings.includes(text)) state.warnings.push(text);
      },
      addRaw(key, value) {
        const text = cleanText(value);
        if (!text) return;
        const name = cleanText(key) || "section";
        state.raw[name] = text.length > 20000 ? `${text.slice(0, 20000)}…` : text;
      },
      counts() {
        return {
          qualifications: state.qualifications.size,
          screening: state.screening.size,
          experience: state.experience.size,
          education: state.education.size,
          skills: state.skills.size,
          contacts: state.contact.emails.length + state.contact.phones.length + state.contact.websites.length,
          warnings: state.warnings.length
        };
      },
      /** Everything the scan's quiet count has to notice arriving. */
      signature() {
        const counts = this.counts();
        return [
          counts.qualifications, counts.screening, counts.experience, counts.education,
          counts.skills, counts.contacts, state.resume ? 1 : 0, cleanText(state.header.name).length
        ].join(":");
      },
      snapshot() {
        return {
          job: { ...state.job },
          header: { ...state.header },
          qualifications: [...state.qualifications.values()],
          screening: [...state.screening.values()],
          experience: [...state.experience.values()],
          education: [...state.education.values()],
          skills: [...state.skills.values()].map((entry) => entry.name),
          contact: {
            emails: [...state.contact.emails],
            phones: [...state.contact.phones],
            websites: [...state.contact.websites]
          },
          resume: state.resume ? { ...state.resume } : null,
          warnings: [...state.warnings],
          raw: { ...state.raw }
        };
      }
    };
  }

  /**
   * Fold a finished accumulator into the stored record.
   *
   * This is the only place the two shapes meet, so a field that the panel reads
   * but the schema has no home for fails loudly here rather than silently
   * vanishing somewhere in the adapter.
   */
  function buildApplicantRecord({ snapshot, context = {}, sourceUrl = "", buildId = "" } = {}) {
    const data = snapshot || createApplicantAccumulator().snapshot();
    const header = data.header || {};
    const contact = data.contact || { emails: [], phones: [], websites: [] };
    const qualifications = data.qualifications || [];
    const screening = data.screening || [];

    // The job's own requirements are the requirement half of the verdicts: the
    // panel states them once per applicant, so they are recorded on the job as
    // well as on the person, which is what makes the job row meaningful on its
    // own rather than only as a foreign key.
    const requirementsOf = (category) => qualifications
      .filter((entry) => entry.category === category)
      .map((entry) => entry.requirement);

    return normalizeApplicantRecord({
      applicationId: context.applicationId || null,
      job: {
        ...(data.job || {}),
        id: data.job?.id || context.jobId || null,
        mustHaveQualifications: requirementsOf(QUALIFICATION_CATEGORY.MUST_HAVE),
        preferredQualifications: requirementsOf(QUALIFICATION_CATEGORY.PREFERRED),
        // The questions, with the ideal answer, but never this applicant's own
        // answer — that belongs to the person, not to the posting.
        screeningQuestions: screening.map((entry) => ({
          question: entry.question,
          idealAnswer: entry.idealAnswer ?? null,
          answer: null,
          met: null,
          raw: ""
        }))
      },
      applicant: {
        name: header.name || "",
        profileUrl: header.profileUrl || "",
        headline: header.headline || "",
        location: header.location || "",
        appliedAt: header.appliedAt || "",
        contactedAt: header.contactedAt || "",
        applicationStatus: header.applicationStatus || "",
        contact: {
          email: contact.emails[0] || null,
          phone: contact.phones[0] || null,
          website: contact.websites[0] || null,
          // Every additional value, labelled, so nothing found is thrown away.
          other: [
            ...contact.emails.slice(1).map((value) => `email: ${value}`),
            ...contact.phones.slice(1).map((value) => `phone: ${value}`),
            ...contact.websites.slice(1).map((value) => `website: ${value}`)
          ]
        },
        resume: data.resume || { available: false, downloadStatus: RESUME_STATUS.NOT_ATTEMPTED },
        experience: data.experience || [],
        education: data.education || [],
        skills: data.skills || [],
        screeningResponses: data.screening || [],
        qualifications: data.qualifications || []
      },
      extraction: {
        timestamp: new Date().toISOString(),
        sourceUrl,
        buildId,
        warnings: data.warnings || [],
        rawData: data.raw || {}
      }
    });
  }

  // ------------------------------------------------------------ the run queue
  // Collecting every applicant on a job is the same shape of problem as the
  // connections queue but small enough to live in memory: a list of rows, an
  // index, and a stop flag that anything may set. Pure, so the loop the adapter
  // and the worker run is tested without a browser.

  const RUN_STATE = Object.freeze({
    IDLE: "idle",
    RUNNING: "running",
    STOPPED: "stopped",
    COMPLETED: "completed",
    FAILED: "failed"
  });

  /**
   * Lifecycle persisted by the worker for a whole-job applicant run.
   *
   * This is deliberately separate from `RUN_STATE`: the content script's run
   * object disappears with its document, while this lease survives navigation
   * and decides whether returning to the job may start work again.
   */
  const AUTO_RUN_STATE = Object.freeze({
    RUNNING: "running",
    INTERRUPTED: "interrupted",
    COMPLETED: "completed"
  });

  function createAutoRunEntry({ options = {}, now = "", runId = "", tabId = 0 } = {}) {
    return {
      options: options || {},
      armedAt: cleanText(now),
      updatedAt: cleanText(now),
      runId: cleanText(runId),
      attempt: 1,
      tabId: Number(tabId) || 0,
      state: AUTO_RUN_STATE.RUNNING
    };
  }

  /**
   * Claim the next execution of an unfinished instruction.
   *
   * A completed entry is final. A running entry may only be reclaimed by the
   * same tab: that is a replacement document or reinjection taking over after
   * the old closure was retired. Another tab must not create a second driver.
   */
  function claimAutoRun(entry, { now = "", tabId = 0 } = {}) {
    if (!entry || typeof entry !== "object") return { armed: false, reason: "not-collected-before", entry: null };
    const state = cleanText(entry.state) || AUTO_RUN_STATE.INTERRUPTED;
    if (state === AUTO_RUN_STATE.COMPLETED) return { armed: false, reason: "completed", entry };
    const owner = Number(entry.tabId) || 0;
    const claimant = Number(tabId) || 0;
    if (state === AUTO_RUN_STATE.RUNNING && owner && claimant && owner !== claimant) {
      return { armed: false, reason: "running-in-another-tab", entry };
    }
    const claimed = {
      ...entry,
      updatedAt: cleanText(now),
      tabId: claimant || owner,
      attempt: Math.max(0, Number(entry.attempt) || 0) + 1,
      state: AUTO_RUN_STATE.RUNNING
    };
    return {
      armed: true,
      reason: "unfinished",
      entry: claimed,
      tracking: { runId: cleanText(claimed.runId), attempt: claimed.attempt }
    };
  }

  /** Apply a terminal report only when it belongs to the newest execution. */
  function settleAutoRun(entry, { runId = "", attempt = 0, state = "", now = "" } = {}) {
    if (!entry || typeof entry !== "object") return { changed: false, reason: "missing", entry };
    if (!cleanText(runId) || cleanText(entry.runId) !== cleanText(runId)) {
      return { changed: false, reason: "stale-run", entry };
    }
    if ((Number(entry.attempt) || 0) !== (Number(attempt) || 0)) {
      return { changed: false, reason: "stale-attempt", entry };
    }
    const next = state === AUTO_RUN_STATE.COMPLETED
      ? AUTO_RUN_STATE.COMPLETED
      : AUTO_RUN_STATE.INTERRUPTED;
    return {
      changed: true,
      reason: next,
      entry: { ...entry, state: next, updatedAt: cleanText(now) }
    };
  }

  function createRunState(patch = {}) {
    return {
      state: RUN_STATE.IDLE,
      total: 0,
      index: 0,
      collected: 0,
      failed: 0,
      skipped: 0,
      /** Of the skipped, how many were skipped because they were already saved. */
      alreadyCollected: 0,
      currentName: "",
      stopRequested: false,
      lastError: "",
      startedAt: "",
      updatedAt: "",
      ...patch
    };
  }

  /**
   * Does this stored record carry anything a second pass would only repeat?
   *
   * The test a run uses to decide it may skip somebody, and deliberately not
   * "a record exists": a row saved with nothing but a name is a run that failed
   * on that applicant, and skipping it would make the failure permanent. One
   * substantive field — a way to reach them, a verdict, a history, or a resume —
   * is what counts as collected, which is the same bar `status: "collected"`
   * sets on the profile record.
   */
  function isCollectedApplicant(record) {
    const applicant = record?.applicant || {};
    const contact = applicant.contact || {};
    const resume = applicant.resume || {};
    const filled = (value) => Array.isArray(value) && value.length > 0;
    return Boolean(
      cleanText(contact.email)
      || cleanText(contact.phone)
      || filled(contact.emails)
      || filled(contact.phones)
      || filled(applicant.qualifications)
      || filled(applicant.screeningResponses)
      || filled(applicant.experience)
      || filled(applicant.education)
      || filled(applicant.skills)
      || resume.available === true
    );
  }

  /**
   * Which applicants a run is allowed to skip, keyed by what a list row knows.
   *
   * The live complaint: a run stopped half way and started again went back to
   * the first applicant and collected all of them a second time. It had no way
   * not to — the loop walked the rows from index 0 and asked nothing about what
   * was already saved.
   *
   * The key is the `applicationId` in the row's own href, because that is the
   * only identifier a row carries **before** it has been opened; the record's
   * own id needs the profile URL, which only the panel shows, so keying on it
   * would mean opening every applicant to discover it may be skipped. The name
   * is a second key for a layout whose rows carry no id at all.
   *
   * Scoped to the job, because an applicant is a person *on a job*: the same
   * person applying to a second job is a second record and must still be
   * collected. A stored record that names no job is trusted for any job rather
   * than none, since dropping it would re-collect everything saved before the
   * id was captured.
   *
   * Takes either a whole record or the lean `{applicationId, jobId, name,
   * collected}` entry the worker sends over the message channel, so the same
   * policy serves both without a second copy of the "is it collected" rule.
   */
  function createCollectedIndex(records = [], { jobId = "" } = {}) {
    const applications = new Set();
    const names = new Set();
    const wantedJob = cleanText(jobId).toLowerCase();

    for (const record of records || []) {
      const judged = typeof record?.collected === "boolean" ? record.collected : isCollectedApplicant(record);
      if (!judged) continue;
      const recordJob = cleanText(record?.job?.id ?? record?.jobId ?? "").toLowerCase();
      if (wantedJob && recordJob && recordJob !== wantedJob) continue;
      const application = cleanText(record?.applicationId ?? "").toLowerCase();
      if (application) applications.add(application);
      const name = cleanText(record?.applicant?.name ?? record?.name ?? "").toLowerCase();
      if (name) names.add(name);
    }

    return {
      jobId: wantedJob,
      applications,
      names,
      get size() {
        return applications.size || names.size;
      },
      /** The id decides when the row has one; the name only ever stands in. */
      has({ applicationId = "", name = "" } = {}) {
        const id = cleanText(applicationId).toLowerCase();
        if (id) return applications.has(id);
        const value = cleanText(name).toLowerCase();
        return Boolean(value) && names.has(value);
      }
    };
  }

  /** Stable identity available on a row before its applicant is opened. */
  function applicantRowKey(row = {}) {
    const applicationId = parseHiringContext(row.href || "").applicationId;
    if (applicationId) return `id:${applicationId.toLowerCase()}`;
    if (row.href) return `href:${String(row.href).toLowerCase()}`;
    return `name:${cleanText(row.name).toLowerCase()}`;
  }

  /** Position-free queue selection for a paginated or virtualized row window. */
  function unprocessedApplicantRows(rows = [], processed = new Set()) {
    return (rows || []).filter((row) => !processed.has(applicantRowKey(row)));
  }

  // ------------------------------------------------------------ panel arrival
  /**
   * Has the applicant we asked for actually mounted?
   *
   * **THE DEFECT THIS REPLACES: the panel was identified by its own text.** The
   * fingerprint was `applicationId | text.length | text.slice(0, 300)`, and the
   * caller's whole test was "that string is not what it was before the click".
   * Two of those three fields are text, and the hiring surface is a single-page
   * app that **re-mounts the detail column** — not on a browser reload, which
   * would take the content script with it, but by tearing the old applicant's
   * subtree out and building a new one in its place, several applicants into a
   * run.
   *
   * A teardown changes the text. So does an empty panel, a spinner, a skeleton
   * and a re-render of the *same* person. Every one of those satisfied "the
   * fingerprint changed", and the run then scanned whatever was on screen: a
   * half-mounted shell, or — when nothing scored two sections and the resolver
   * fell back — a container holding the applicant *list*, which is how a record
   * once came back named "Applicants".
   *
   * The question the caller is actually asking has an exact answer and it is not
   * a diff: **is the panel now showing the application this row leads to, and has
   * it finished mounting?** Both halves are structural. The id comes from the
   * panel's own application link and from the address, never from prose; the
   * mounting test is the same "at least two applicant sections" bar the panel
   * resolver itself qualifies on, so a shell that has painted nothing cannot
   * pass it.
   *
   * `identity` is the fallback for a row whose href carries no parseable id: a
   * fingerprint built from links (the application id and the member's `/in/`
   * slug) and still never from text, compared against the identity the panel had
   * before the click. It can only ever say "somebody else is here now", which is
   * weaker than the id test and is why the id test is preferred — but it is not a
   * guess either, and a run must not stall on a layout that numbers its rows
   * differently.
   */
  const PANEL_ARRIVAL = Object.freeze({
    /** Nothing is mounted: the old applicant has gone and the new one has not arrived. */
    TORN_DOWN: "torn-down",
    /** A shell is up but the sections have not hydrated. */
    MOUNTING: "mounting",
    /** Still the applicant that was showing before the click. */
    PREVIOUS: "previous",
    /** Somebody, but not the person this row leads to. */
    OTHER: "other",
    ARRIVED: "arrived"
  });

  /**
   * How many distinct applicant sections make a panel "mounted".
   *
   * The same bar the panel resolver scores on, deliberately: a container that
   * would not qualify as the panel cannot be a panel that has arrived.
   */
  const PANEL_MIN_SECTIONS = 2;

  function describePanelArrival({
    expected = "",
    applicationId = "",
    identity = "",
    previousIdentity = "",
    sections = 0,
    connected = false,
    minSections = PANEL_MIN_SECTIONS
  } = {}) {
    const verdict = (state, reason) => ({ state, reason, arrived: state === PANEL_ARRIVAL.ARRIVED });
    if (!connected) return verdict(PANEL_ARRIVAL.TORN_DOWN, "no panel is mounted");

    const want = cleanText(expected).toLowerCase();
    const has = cleanText(applicationId).toLowerCase();
    const now = cleanText(identity).toLowerCase();
    const was = cleanText(previousIdentity).toLowerCase();

    if (want && has) {
      // The authoritative test, and the only one that can tell "this is the
      // wrong person" from "this person has not finished rendering".
      if (has !== want) {
        return now && now === was
          ? verdict(PANEL_ARRIVAL.PREVIOUS, "the panel is still showing the previous applicant")
          : verdict(PANEL_ARRIVAL.OTHER, "the panel is showing a different applicant");
      }
    } else if (was && now && now === was) {
      // No id to compare, so the most that can be said is that nobody new is
      // here yet. Deliberately not treated as arrival: a re-mount of the same
      // person is exactly what this guard exists to notice.
      return verdict(PANEL_ARRIVAL.PREVIOUS, "the panel has not changed applicant");
    }

    if (Number(sections) < Number(minSections)) {
      return verdict(PANEL_ARRIVAL.MOUNTING, "the panel has not finished mounting");
    }
    if (want && !has) return verdict(PANEL_ARRIVAL.ARRIVED, "mounted, and no id was rendered to check it against");
    return verdict(PANEL_ARRIVAL.ARRIVED, "mounted, and it is the applicant that was asked for");
  }

  /**
   * Why a list walk stopped, and whether that answer is worth believing.
   *
   * **Only a walk that reached the end of the list may complete a run**, and that
   * is what makes "keep collecting as long as I am on this tab, even if the page
   * reloads" possible at all. `claimAutoRun` refuses to re-arm a job whose
   * execution reported `COMPLETED` — deliberately, so a finished job is not
   * walked again forever — so a run that claims completion it has not earned does
   * not merely stop, it **permanently disables its own restart**. A reload then
   * does nothing, which is precisely the reported behaviour.
   *
   * The growth walk stops for six reasons and they are not the same kind of fact.
   * `settled` and `pagination-retired` are *verdicts*: the container reached its
   * bottom, stayed quiet for `LIST_QUIET_PASSES`, and either offered no pager or
   * offered one that revealed nobody three times. Everything else is an *excuse* —
   * the pass budget ran out mid-scroll, the list was momentarily unmounted, the
   * pager was refused by the click policy — and means only "I could not tell yet".
   * A 16-pass budget covers roughly 8000px of scrolling, so on any longer list a
   * walk that was working simply ran out of passes and the run declared itself
   * finished somewhere in the middle.
   *
   * An inconclusive stop must leave the run restartable instead — the same
   * distinction `revealPanelContent` already draws when it reports
   * `complete: stoppedBy === "settled"` rather than trusting any stop at all.
   */
  const LIST_STOP_CONCLUSIVE = Object.freeze(["settled", "pagination-retired"]);

  function isConclusiveListStop(stoppedBy = "") {
    return LIST_STOP_CONCLUSIVE.includes(cleanText(stoppedBy));
  }

  /**
   * What the runner should do next.
   *
   * The stop flag is checked before anything else and before every single row,
   * which is what makes the universal Stop button take effect within one
   * applicant rather than at the end of the list.
   */
  function nextRunStep(run = createRunState(), { total = 0 } = {}) {
    const state = createRunState(run);
    if (state.stopRequested) return { action: "stop", reason: "user-stopped" };
    if (state.state === RUN_STATE.STOPPED) return { action: "stop", reason: "already-stopped" };
    if (total <= 0) return { action: "done", reason: "nothing-to-collect" };
    if (state.index >= total) return { action: "done", reason: "queue-complete" };
    return { action: "collect", reason: "next-applicant", index: state.index };
  }

  const api = {
    // pages
    HIRING_PATH_PATTERN, isHiringPage, isApplicantsPage, parseHiringContext, applicantsViewKey,
    // the columns that scroll
    COLUMN_SCROLL_EPSILON, chooseColumnScrollTarget,
    // click policy
    CONTROL_PURPOSE, FORBIDDEN_APPLICANT_CONTROL_PATTERN, APPLICANT_CONTACT_CONTROL_PATTERN,
    RESUME_CONTROL_PATTERN, RESUME_DOWNLOAD_CONTROL_PATTERN, DISCLOSURE_CONTROL_PATTERN,
    APPLICANT_PAGINATION_PATTERN, classifyApplicantControl,
    // qualifications and screening
    QUALIFICATION_CATEGORY, QUALIFICATION_RESULT, QUALIFICATION_SOURCE,
    qualificationCategoryOf, classifyQualificationResult, classifyQualificationSource,
    parseQualificationBlock, qualificationKey, parseScreeningBlock, screeningKey,
    // history
    splitCompanyAndDates, parseExperienceBlock, experienceKey, deriveCurrentPosition,
    normalizeDateRange, totalExperienceFrom, parseEducationBlock, educationKey,
    // job and applicant headers
    parseJobHeader, mergeJob, parseApplicantHeader, cleanApplicantName,
    NAME_CHROME_PATTERN, isApplicantNameCandidate, nameFromExplanations, chooseApplicantName,
    // the record
    RESUME_STATUS, RESUME_EXTENSION_PATTERN, isResumeDocumentUrl, documentUrlFromDescriptor,
    // naming the saved file
    sanitizeFileName, resumeFileExtension, resumeFileName,
    applicantId, normalizeApplicantRecord, mergeApplicantRecord,
    createApplicantAccumulator, buildApplicantRecord,
    // the run
    RUN_STATE, createRunState, nextRunStep, isCollectedApplicant, createCollectedIndex,
    applicantRowKey, unprocessedApplicantRows,
    PANEL_ARRIVAL, PANEL_MIN_SECTIONS, describePanelArrival,
    LIST_STOP_CONCLUSIVE, isConclusiveListStop,
    AUTO_RUN_STATE, createAutoRunEntry, claimAutoRun, settleAutoRun,
    // shared helpers the adapter needs and must not re-implement
    cleanText, uniqueText, toLines
  };

  globalThis.ProfileVaultApplicants = api;
})();
