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
      // **Never the recruiter's own applicant list.** The guide's Phase 7 states
      // it outright — the left list may move only while the page's roster is
      // being built, never during a profile read — and `nextRevealStep` has
      // always refused a list-containing ANCHOR while this, the chooser of the
      // container that is actually scrolled, did not. Not a new rule: it is
      // `applicantPanel()`'s own test, reused rather than restated. One row link
      // is the panel legitimately linking to the application it is showing; two
      // or more is a list.
      if ((Number(candidate.rowLinks) || 0) > 1) continue;

      // Depth is a bonus here, not a penalty: an outer qualifying container on
      // this surface is the page shell, which scrolls the header and leaves the
      // column exactly where it was.
      let score = Math.min(120, Math.max(0, Number(candidate.depth) || 0) * 2);
      score += Math.min(30, Math.round(range / 500));
      // How much of what is being read this container actually holds. It used to
      // be a hard 60% gate applied by the adapter before the candidate ever
      // arrived here, which refuses the right container on a layout that splits
      // the panel — a pinned top card plus an independently scrolling detail
      // region — because the region alone falls under the bar. It falls through
      // to the general chooser, the page wins, and the column never moves: the
      // exact silent failure this chooser exists to prevent. A share is a score,
      // and a candidate that does not report one scores as it always did.
      //
      // Weighted to BREAK TIES rather than to decide the choice. At 40 it
      // outweighed depth entirely and a shallow page shell carrying all the text
      // beat the deep region actually doing the scrolling — which is the same
      // wrong answer by a different route. At 20 the innermost real column still
      // wins, and two candidates that both carry the whole read (which is every
      // candidate today) are separated by depth and range exactly as before.
      score += Math.round(Math.min(1, Math.max(0, Number(candidate.share ?? 1))) * 20);
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
  /**
   * Every action this extension may never perform, as ONE list of words.
   *
   * Written once and compiled into the two patterns below, because the same list
   * has to answer two different questions and answering them with two
   * hand-maintained copies is how a denylist rots.
   */
  const FORBIDDEN_APPLICANT_ACTIONS =
    "connect|follow|unfollow|message|inmail|send|email\\s+applicant|endorse|recommend|reject|decline|"
    + "archive|shortlist|move\\s+to|advance|hire|hired|offer|interview|schedule|book|rate|rating|"
    + "good\\s+fit|maybe|not\\s+a\\s+fit|withdraw|invite|invitation|accept|ignore|report|block|share|"
    // `add\s+note` never matched the label LinkedIn actually renders, which is
    // "Add a note" — so the one ATS action with an article in its name was the
    // one the denylist let through. Found while proving this change safe, and
    // fixed here rather than filed: it is a live hole in rule 5, it predates
    // this task, and the row purpose is where it was reachable because a row is
    // the only control with no allowlist of its own to catch it afterwards.
    + "like|comment|repost|subscribe|save|unsave|add\\s+(?:\\w+\\s+){0,2}note|template|delete|remove|apply|purchase|"
    + "upgrade|try\\s+premium";

  /**
   * Does this string CONTAIN a forbidden action? The rule for a control's label.
   *
   * Unchanged in behaviour and unchanged in reach. Every control this extension
   * presses is a button or a menu item, and a button's rendered text IS its own
   * claim about what pressing it does — "Next: Message" is a Message control
   * whatever else it says, so the whole string is tested and the denylist wins.
   */
  const FORBIDDEN_APPLICANT_CONTROL_PATTERN = new RegExp(`\\b(?:${FORBIDDEN_APPLICANT_ACTIONS})\\b`, "i");

  /**
   * WHICH forbidden word fired — the same list, asked to show its evidence.
   *
   * The pattern above answers yes or no, and until 3.14.0 yes was the end of the
   * conversation. It cannot be any more. The user has decided, having been shown
   * what it costs, that this extension may press two controls it has always
   * refused: the applicant panel's `Message`, and the composer's `Send`. Those
   * two words are on the list above and must STAY on it, because every other
   * purpose on this surface must go on refusing them — and a boolean cannot tell
   * "Send", which is the composer's own button, from "Send InMail", which is an
   * InMail control that happens to begin with the word Send. Knowing that the
   * denylist fired says nothing about which of the two it just refused.
   *
   * COMPILED FROM THE SAME STRING, for exactly the reason the comment above that
   * string gives. The exemption below is stated as a list of WORDS, so a word
   * added to `FORBIDDEN_APPLICANT_ACTIONS` tomorrow refuses "Message and poach"
   * inside the composer without anyone having to remember that a second copy of
   * the list exists. A hand-maintained set of alternatives here is how the
   * denylist rots, and it would rot in the one direction that lets a click
   * through.
   *
   * A SEPARATE RegExp OBJECT from the one above, and that is not tidiness. A `g`
   * regex carries `lastIndex` across calls; sharing one object with the boolean
   * test would make each control's verdict depend on the label of the control
   * judged before it — a button refused once and allowed the next time round the
   * list. For a click policy that is the worst failure there is, because it is
   * not reproducible.
   */
  const FIRED_FORBIDDEN_ACTION_PATTERN = new RegExp(`\\b(?:${FORBIDDEN_APPLICANT_ACTIONS})\\b`, "gi");

  /**
   * Every forbidden word in `text`, lowercased, in the order the label says them.
   *
   * `lastIndex` is reset before each sweep as well as the object being its own:
   * `matchAll` reads `lastIndex` to seed the clone it iterates, so a stray write
   * from anywhere else would silently skip the front of a label. Resetting costs
   * nothing and removes the entire class of bug from the one function in this
   * file whose wrong answer ends in a click.
   *
   * Inner whitespace is collapsed so a two-word alternative comes back as the
   * list spells it — `move to`, not `move  to` — because the exemption below
   * compares these against literal words.
   */
  function firedForbiddenWords(text) {
    const value = normalizeLabel(text);
    if (!value) return [];
    FIRED_FORBIDDEN_ACTION_PATTERN.lastIndex = 0;
    return [...value.matchAll(FIRED_FORBIDDEN_ACTION_PATTERN)]
      .map((match) => match[0].toLowerCase().replace(/\s+/g, " "));
  }

  /**
   * Is this string ITSELF a forbidden action? The rule for a proven row.
   *
   * **THE DEFECT THIS EXISTS FOR, reported live with a screenshot of the badge:
   * "from 25 applicants it skipped 11 and only saved their name — the one thing
   * they have in common is the green Good fit mark."** Exactly right, and the
   * cause is a category error rather than a bad pattern.
   *
   * `good\s+fit` is on the list above because the extension must never PRESS the
   * Good fit rating control — that would write to the recruiter's own ATS. But
   * `selectApplicantRow` hands the classifier the whole row card's rendered
   * text, and a rated applicant's card contains the words "Good fit". So a card
   * was matched against a rule written about a button: the row was refused as
   * `forbidden-action`, it was never clicked, and because nothing is read when a
   * row does not open — no panel scan, no contact disclosure, no resume — the
   * run saved the floor record and nothing else. `maybe` and `not a fit` cost
   * every other rated applicant the same way, and `interview`, `offer`, `rate`
   * and `connect` cost anyone whose employer or headline happened to contain
   * one. `textContent` also carries visually-hidden text, and the `aria-label`
   * is folded into the same string, so a card could be refused over words the
   * recruiter could not even see.
   *
   * **A denylist tests what a control CLAIMS TO DO. A card's contents are not a
   * claim.** A row is a person's data — their name, their title, their employer,
   * when they applied, how the recruiter rated them — and none of it says what
   * pressing the row does. What the row does is settled by its address.
   *
   * So for a row whose identity is PROVEN (see `isProvenApplicantRow`) the same
   * words are asked the narrower question: is the label *itself* the action. An
   * `<a href="?applicationId=1">Reject</a>` is still refused, because its whole
   * label is `reject`. A person's card can never be exactly `reject`, which is
   * what makes this safe to state as the user did: **collect every applicant,
   * whatever the row content is.**
   */
  const FORBIDDEN_APPLICANT_ROW_LABEL_PATTERN =
    new RegExp(`^\\s*(?:${FORBIDDEN_APPLICANT_ACTIONS})\\s*$`, "i");

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
    //
    // The third alternative is 3.13.0, and it is what a DOC card's own control
    // is actually called. A card LinkedIn cannot preview offers a download and
    // nothing else, and it names the file it would fetch — `Download
    // Sushmitha.L's resume`. Under the two anchored alternatives above that is
    // not a download control at all, so the one layout where pressing Download
    // is the ONLY way to get the file was the one layout that refused to.
    //
    // It is still a WHOLE-LABEL rule and it is not a widening of what may be
    // pressed. The label must still BEGIN with the verb and END with a resume
    // noun, and everything between the two is a bounded run of NAME characters
    // — letters, digits, apostrophes, dots and hyphens, six words at the most.
    // No punctuation that could join a second clause survives that, so
    // `Download resume, then reject` cannot reach it even before the denylist —
    // which is still consulted first, on the whole label, and still refuses it.
    /^download(?:\s+(?:resume|résumé|cv|curriculum\s+vitae|file|documents?|attachment|pdf|original)|\s+[\p{L}\p{N}'’.-]+(?:\s+[\p{L}\p{N}'’.-]+){0,5}\s+(?:resume|résumé|cv|curriculum\s+vitae))?$/iu;

  /**
   * The applicant panel's own Message control (3.14.0).
   *
   * This is the first control on this surface that CONTACTS somebody. Every
   * other allowed click reveals something LinkedIn is already showing this
   * recruiter; pressing this one opens a composer addressed to a real person,
   * and what goes into it leaves the machine. The user asked for it outright and
   * rule 5 was amended for it, so the question here is not whether to press a
   * Message control but how narrowly to recognise one.
   *
   * ANCHORED ON THE WHOLE LABEL, like the download rule above, and then narrowed
   * again. LinkedIn names this button `Message` or, once the screen-reader half
   * of the label is folded in, `Message <the applicant's name>` — so a bounded
   * run of NAME characters is allowed after the verb and nothing else is.
   *
   * THE LOOKAHEAD IS THE POINT, and it is this rule's version of the sentence
   * the download pattern makes with punctuation. A name is letters and digits,
   * and so are `and`, `or`, `then` and `plus` — so without it "Message and
   * reject" reads as a Message control addressed to somebody called "and
   * reject". The denylist refuses that label anyway, on `reject`, and it is
   * consulted first; this is the second lock, and it is here because the two
   * catch different things. The denylist knows the words that name an ATS
   * action; this knows the words that JOIN A SECOND CLAUSE, whatever that clause
   * turns out to say. Conjunctions are a closed class in English, which is why
   * this list can be written once and left alone.
   *
   * Three tokens at most, because that is a person's name. It is not the only
   * thing standing between this pattern and a control that merely starts with
   * the word Message — `inContainer` still has to prove the button was
   * enumerated from inside the applicant's own panel, exactly as the contact
   * disclosure must.
   */
  const MESSAGE_OPEN_CONTROL_PATTERN =
    /^message(?:\s+(?!(?:and|or|then|plus|also|before|after|to)\b)[\p{L}\p{N}'’.-]+){0,3}$/iu;

  /**
   * The composer's own Send, and nothing that reads like it.
   *
   * The strictest allowlist in this file, deliberately: one literal, no optional
   * tail, no name, no punctuation. Every other control this extension presses
   * can be pressed again if the first press achieved nothing — a viewer reopened,
   * a menu reopened, a page re-paged. **A sent message has no undo.** There is no
   * state on LinkedIn this extension can reach that unsends it, and the person
   * who receives it is a real applicant, so the cost of matching one control too
   * many here is not a wasted click.
   *
   * What that buys, concretely: `Send InMail` and `Send connection request` are
   * not Send controls under this rule, and neither is `Send message to Gaurang`.
   * The first is also refused by the denylist on `inmail` — but the second is
   * NOT, because `\bconnect\b` does not match inside "connection" and `send` is
   * the exempt word at this purpose. **This pattern, on its own, is what refuses
   * it.** That is the whole reason it is a single literal rather than a
   * `^send\b` prefix, and the reason there is a test pinning that exact label.
   */
  const MESSAGE_SEND_CONTROL_PATTERN = /^send$/i;

  /** The applicant's attached CV. "Download" is a read, not an action on them. */
  const RESUME_CONTROL_PATTERN =
    /\b(?:resume|résumé|cv|curriculum\s+vitae)\b/i;

  /**
   * A collapsed section's own expander.
   *
   * **The count is the point of the rewrite (3.9.1).** LinkedIn does not write
   * "Show more" above a list it can count — it writes "Show 5 more experiences".
   * The old pattern required the word after the verb to be one of
   * more/all/details/full, so a digit in between refused it, and the Experience
   * list was never expanded on the surface that matters most. That is not a
   * cosmetic miss: `current_role`, `current_company` and `total_experience` are
   * derived from the Experience section and from nothing else, and all three
   * have come back empty for four consecutive releases (docs/CHECKS.md). An
   * optional count is now allowed between the verb and the noun.
   *
   * Two things this must NOT match, both of them controls sitting within a few
   * pixels of a real expander in the applicant panel:
   *
   *   - **a navigation control.** "See full profile" matched `see\s+full` and
   *     was therefore clicked, which LEAVES THE APPLICANTS PAGE. Everything the
   *     run needs next — the panel, the resume card, the list pager — only
   *     exists there. Refused by `APPLICANT_NAVIGATION_CONTROL_PATTERN`.
   *   - **an overflow menu opener.** A bare "More" / "More..." is not a section
   *     expander; it is the ATS action menu, and every destructive control on
   *     this surface lives inside it. Refused by `APPLICANT_MENU_OPENER_PATTERN`
   *     here, and reached deliberately — for the contact disclosure and nothing
   *     else — through `CONTROL_PURPOSE.CONTACT_MENU`.
   */
  const DISCLOSURE_CONTROL_PATTERN =
    /^(?:show|see|view|read)\s+(?:\d+\s+)?(?:more|all|details|full)\b|^expand\b/i;

  /**
   * A control that takes the tab somewhere else.
   *
   * Not a *forbidden action* — it sends nothing and changes nothing, so it does
   * not belong on the denylist — but it must never be pressed during a run.
   * On profile pages a navigating "Show all N" IS allowed, because that flow
   * captures the profile URL first and navigates back (CLAUDE.md rule 5); this
   * surface has no equivalent return path, so here it is simply refused.
   */
  const APPLICANT_NAVIGATION_CONTROL_PATTERN =
    /\b(?:full\s+profile|view\s+profile|see\s+profile|open\s+profile|profile\s+page|linkedin\s+profile|in\s+new\s+tab)\b/i;

  /**
   * The applicant panel's overflow menu opener.
   *
   * Anchored on the WHOLE label, so "Show 3 more experiences" is untouched —
   * this is only the bare button, however LinkedIn spells its ellipsis.
   */
  const APPLICANT_MENU_OPENER_PATTERN =
    /^(?:more|more\s*(?:\.{2,}|…)|more\s+(?:actions?|options?)|other\s+actions?|options)$/i;
  /**
   * The same control, named the way a real page names it.
   *
   * **Reported live, and this is the whole of the failure:** the applicant
   * panel's overflow menu was never found at all - `diagnostics.contact` came
   * back `reason: "no-contact-menu"`, `menuClicked: false`, `menuLabel: ""`,
   * so nothing was ever pressed and every applicant saved an empty email and
   * an empty mobile. The pattern above is anchored on the WHOLE label, and a
   * LinkedIn control's whole label is not what it paints.
   *
   * The captured markup shows the idiom, in the applicant's own Experience
   * card: `<span class="a11y-text">Years employed from 2025 to Present</span>`
   * beside `<span aria-hidden="true">2025 - Present</span>`. Every control is
   * built the same way, so an overflow menu reads `More options More...` or
   * `More actions for <name> More...` once the screen-reader half is included -
   * and `^more\.\.\.$` matches none of them.
   *
   * So this one matches WITHIN the label - and every alternative is written so
   * that it cannot collide with a section expander, which is the one thing that
   * must never be mistaken for a menu. Each alternative requires either the
   * ellipsis glyph or the words actions/options/menu, so `Show 2 more
   * educations` and `See more` stay expanders on every branch that consults
   * this. That is asserted rather than asserted-in-prose: the six pinned
   * expander negatives are run against this pattern directly.
   */
  const APPLICANT_MENU_OPENER_WITHIN_PATTERN =
    /(?:^|\s)more\s*(?:\.{2,}|…)(?:\s|$)|\bmore\s+(?:actions?|options?)\b|\bother\s+actions?\b|\boverflow\s+menu\b|\bopen\s+menu\b/i;

  /**
   * Is this label an overflow-menu opener, by either reading?
   *
   * Both branches that care ask this rather than either pattern, so the menu
   * route and the expander refusal can never disagree about what a control is.
   */
  function isApplicantMenuOpenerLabel(value) {
    const label = normalizeLabel(value);
    if (!label) return false;
    return APPLICANT_MENU_OPENER_PATTERN.test(label) || APPLICANT_MENU_OPENER_WITHIN_PATTERN.test(label);
  }

  /** What a caller may ask permission for. Anything else is refused. */
  const CONTROL_PURPOSE = Object.freeze({
    CONTACT: "contact",
    /**
     * The applicant panel+s overflow menu, opened ONLY to reach the contact
     * disclosure inside it (3.9.1, rule 9j).
     *
     * On the layout the user captured there is no Contact control in the
     * panel at all — the applicant+s email and phone live behind "More...".
     * Opening that menu renders controls LinkedIn is already offering this
     * recruiter and changes nothing; the menu is closed again immediately.
     * The only item the caller may then press is one this same classifier
     * allows for CONTROL_PURPOSE.CONTACT, so the denylist still governs
     * every destructive action the menu contains.
     */
    CONTACT_MENU: "contact-menu",
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
    PAGINATION: "pagination",
    /**
     * The applicant panel's own Message control (3.14.0, rule 5 amended).
     *
     * Every purpose above this line reveals something LinkedIn is already
     * showing the recruiter. This one does not: it opens a composer addressed
     * to a real applicant, and it exists because the user asked for templated
     * messages to be sent from the walk and accepted, having been shown them,
     * the risks of pressing a control that contacts somebody.
     *
     * What keeps it bounded is that it is a PURPOSE rather than a hole in the
     * denylist. `message` stays on `FORBIDDEN_APPLICANT_ACTIONS` and stays
     * refused for the contact disclosure, the resume, the row, the pager and
     * every purpose ever added after this one; it is forgiven here and only
     * here, and only when it is the only forbidden word the label contains.
     * "Message and reject" is not a Message control.
     */
    MESSAGE_OPEN: "message-open",
    /**
     * The composer's own Send (3.14.0, rule 5 amended).
     *
     * Separated from MESSAGE_OPEN rather than folded into it, because these are
     * the two halves of the amendment and only one of them is irreversible.
     * Opening a composer can be undone by closing it; sending cannot be undone
     * at all. Keeping them apart means `send` is forgiven ONLY at the moment a
     * verified message is being sent, and `message` is forgiven ONLY at the
     * moment a composer is being opened — so a `Send` sitting anywhere in the
     * applicant panel is still refused as the forbidden action it has always
     * been, and so is a `Message` found inside an open composer.
     */
    MESSAGE_SEND: "message-send"
  });

  /**
   * The only words a purpose may forgive, and the whole of the 3.14.0 carve-out.
   *
   * READ THIS AS THE SAFETY ARGUMENT, because it is. The denylist is not being
   * shortened and no word is leaving `FORBIDDEN_APPLICANT_ACTIONS`: `message`
   * and `send` are still refused everywhere, for every caller, at every other
   * purpose, exactly as they were before this release. What changes is that ONE
   * word is forgiven at ONE purpose, and only when the label contains nothing
   * else the list knows. Every other word the same label fires still refuses it.
   *
   * That is what makes the carve-out bounded rather than a door: the exemption
   * is per purpose AND per word AND total — a single unexempt word anywhere in
   * the label is enough. "Send InMail" fires `send` and `inmail`, and `inmail`
   * is on nobody's exemption, so it is refused at MESSAGE_SEND like everywhere
   * else. So is "Message and reject", on `reject`. So is a bare "Message" asked
   * for at MESSAGE_SEND, because the exemption belongs to the purpose and not to
   * the word.
   *
   * Every purpose not named here forgives nothing, and there is a permanent test
   * that walks `CONTROL_PURPOSE` and proves it.
   */
  const PURPOSE_EXEMPT_WORDS = Object.freeze({
    [CONTROL_PURPOSE.MESSAGE_OPEN]: Object.freeze(["message"]),
    [CONTROL_PURPOSE.MESSAGE_SEND]: Object.freeze(["send"])
  });

  /**
   * Does this label still fire a word this purpose may NOT forgive?
   *
   * The question the denylist gate asks after it has already decided the label
   * is forbidden. True means refuse, which is also what it answers to anything
   * it does not understand — every branch that is not "the exemption covers
   * every word that fired" returns true.
   *
   * `Array.isArray` rather than a truthiness check, and that is load-bearing:
   * `purpose` is a caller-supplied string that reaches this object as a property
   * name, so `purpose: "constructor"` would otherwise come back with a function
   * and `exempt.includes` would throw inside the one gate that must never fail
   * open. An inherited key is not an exemption.
   */
  function firesOutsideExemption(purpose, text) {
    const exempt = PURPOSE_EXEMPT_WORDS[purpose];
    if (!Array.isArray(exempt) || !exempt.length) return true;
    const fired = firedForbiddenWords(text);
    // Forbidden, but with nothing to attribute it to. The two patterns compile
    // from one string so today this cannot happen; if a later edit ever makes
    // them disagree, the disagreement is settled by refusing.
    if (!fired.length) return true;
    return fired.some((word) => !exempt.includes(word));
  }

  /**
   * The pager, by name.
   *
   * Deliberately not `Connections.PAGINATION_ALLOWLIST` reused blind: that list
   * is anchored on whole labels like `^next$` for a text button, and a hiring
   * pager is often an icon whose only name is an `aria-label` ("Next page",
   * "Next 25 applicants"). Still an allowlist, still beaten by the denylist,
   * and still required to be proven inside the list.
   */
  /**
   * A control that says it goes to the NEXT page — and nothing that merely names
   * a page.
   *
   * **`page \d+` used to be an alternative here, and it is the defect that made
   * every pager fix from 3.9.3 to 3.9.7 unreachable.** This is the NAMED branch:
   * it is consulted first, it is handed no `currentPage`, and it therefore
   * cannot tell page one from page two. `findApplicantPaginationControl`
   * enumerates in DOCUMENT ORDER and returns the first control this allows, and
   * on a pager labelled `Page 1` / `Page 2` the first one is **the page already
   * being shown**.
   *
   * So the run pressed `1` while sitting on page 1. Nothing happened, because
   * nothing was supposed to happen. `notePageReached` could not even score the
   * press — the named branch reports `page: null`, so it is not an integer and
   * the walk records no step — `fruitless` climbed on every attempt, and three
   * attempts retired the pager as `pagination-retired`, which is CONCLUSIVE. The
   * job was marked COMPLETED at the bottom of page one.
   *
   * **The numbered path was never reached on that layout**, which is why four
   * builds of work on it — the three current-page readers, the group fix, the
   * anchoring fix — changed nothing the recruiter could see.
   *
   * A numbered page is exactly what the numbered branch below exists for, where
   * `currentPage` is supplied by the caller and a number is accepted only when
   * it is exactly `current + 1`. Removing it here does not lose the ability to
   * press `Page 2`; it routes it through the proof that stops `Page 1` being
   * pressed from page one, and `Page 25` from page one along with it.
   */
  const APPLICANT_PAGINATION_PATTERN =
    /^(?:next(?: page| \d+| \d+ applicants?)?|show more|load more|see more applicants?|more applicants?)$/i;

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

  /**
   * The page a numbered pager control offers, or null.
   *
   * THE DEFECT (3.9.4), from the user's screenshot of the live pager: it renders
   * no Next control at all — it renders `1` filled and `2` beside it. A bare
   * number was refused on purpose ("any numeric control in the list would
   * otherwise qualify"), which was right while nothing could prove a number was
   * a PAGE. So the run reached the bottom of page one, found no pager, recorded
   * the CONCLUSIVE stop `settled`, and marked the job completed with every page
   * after the first never opened.
   *
   * Accepts `2` and `page 2`, so the same reader answers for the text and for
   * the accessible name.
   */
  /**
   * A NEXT-PAGE CONTROL WHOSE NAME SAYS MORE THAN "Next".
   *
   * `APPLICANT_PAGINATION_PATTERN` above is anchored `^…$`, so it recognises a
   * next-page control only when the label is `next` or `next page` and nothing
   * else. Executed against real names:
   *
   *     "Go to next page"        -> refused
   *     "Next page of applicants"-> refused
   *     "Next, page 2 of 27"     -> refused
   *
   * Same defect as `pageNumberFrom`, same consequence: with neither reader
   * finding anything, `note.reason` is `no-pager`, which is CONCLUSIVE, and the
   * job completes at the bottom of page one.
   *
   * Added AFTER the working reader rather than replacing it (the multiple-UI
   * guide's one rule), and deliberately NOT the obvious fix of un-anchoring
   * `next`. **Every alternative here requires the word `page`**, and that is
   * what keeps two real neighbours of a pager refused:
   *
   *     "Next applicant" / "Go to next applicant"  — moves the PANEL, not the
   *       list. It would read as a working pager while collecting nobody new.
   *     "Next: Message" / "Next steps"             — the shape the anchored
   *       pattern was written to refuse in the first place.
   *
   * The denylist still runs before any of this, so an ATS action whose label
   * happens to contain "next page" is refused before it is ever considered.
   */
  const APPLICANT_PAGINATION_PHRASE_PATTERN =
    /\bnext\s+page\b|\bnext\s*[,;-]\s*page\s+\d{1,4}\b|\b(?:show|load|see)\s+more\s+(?:results?|applicants?)\b/i;

  function pageNumberFrom(value) {
    const text = normalizeLabel(value);
    // A bare number is a page only when it is the WHOLE label: that is the
    // number a pager paints, and anything around it means the string is a
    // sentence rather than a page.
    if (/^\d{1,4}$/.test(text)) return Number(text);

    /**
     * A NUMBER THE LABEL CALLS A PAGE — found where it sits, not only when it is
     * all the label says.
     *
     * **THE DEFECT (3.9.7), and it is the whole of "there are 2 pages and it
     * stops at the first".** Both readings here were anchored `^…$`, so a page
     * number was recognised only in a label that was `2` or `page 2` and nothing
     * else. Every richer name a real pager gives its controls returned null:
     *
     *     "Page 1, current page"      -> null
     *     "Go to page 2"              -> null
     *     "Page 2, go to page 2"      -> null
     *     "Page 3 of 27, go to page 3"-> null
     *
     * A control that offers no page number is not a member of the pager, so on
     * such a layout the group has ZERO members, it is dropped for having fewer
     * than two, and the search reports `no-pager` — which is CONCLUSIVE. The job
     * is marked COMPLETED at the bottom of page one and `claimAutoRun` refuses
     * to re-arm a completed job.
     *
     * **The three readers added for "which page is being shown" could not
     * possibly have helped**, because all three run only on members of a group
     * that was never formed. Worse, 3.9.5 added `saysCurrentPage` to recognise
     * exactly the string `"Page 1, current page"` — the very string this
     * function rejected — so the two readers contradicted each other and the
     * newer one was unreachable. That contradiction is what this repairs, and
     * the test below asserts the two agree.
     *
     * THE REFUSAL THAT MATTERS IS UNCHANGED AND IS WHY THE WORD IS REQUIRED.
     * `25 of 665` is NOT a page — it is the range the list is showing, it is
     * rendered right beside the pager, and reading it as page 25 would jump the
     * run past 24 pages of applicants. The word `page` immediately before the
     * number is what licenses reading it, so a bare `of` form still returns
     * null. The FIRST occurrence is taken, so `page 2 of 27` is page two rather
     * than page twenty-seven.
     */
    const named = /\bpage\s+(\d{1,4})\b/.exec(text);
    if (named) return Number(named[1]);

    /**
     * The number a control leads with when the only thing beside it is a
     * screen-reader note saying it is the page being shown — `textContent` of
     * `<button>1<span class="visually-hidden">Current page</span></button>` is
     * `1Current page`, with no space for the rule above to find.
     *
     * Deliberately gated on `saysCurrentPage` rather than on the mere presence
     * of the word: it is the one phrase that proves the string is about paging,
     * and it keeps `3 results per page` — a real control that sits beside a real
     * pager — from being read as page three.
     */
    const leading = /^(\d{1,4})(\D[\s\S]*)?$/.exec(text);
    // The note is asked of what follows the number rather than of the whole
    // string, because there is no word boundary between `1` and `Current` — a
    // digit and a letter are both word characters, so `saysCurrentPage` cannot
    // see the phrase while the number is still stuck to the front of it.
    if (leading && saysCurrentPage(leading[2] || "")) return Number(leading[1]);
    return null;
  }

  /**
   * Does this accessible name SAY it is the page being shown?
   *
   * **The second reader for "which page is current", and it exists because the
   * first one has now guessed wrong twice.** 3.9.3 read `aria-current` off the
   * numbered control; 3.9.4 widened that to the two ancestors above it, on the
   * reasoning that a pager marks the `li` rather than the `button`. Neither was
   * ever run against the live pager, the recruiter reported after both that the
   * run still would not leave page one, and a third guess about WHERE the
   * attribute sits would be the same mistake a third time.
   *
   * So this asks a different question. A pager that does not use `aria-current`
   * still has to tell a screen reader which page is showing, and it does that in
   * the accessible name: `Page 1, current page`. That is ARIA too — the
   * accessible name is exactly what rule 7 means by reading the page's own
   * semantics — and it is nothing like a class name: `active` and `selected` are
   * how the page LOOKS, this is what the page SAYS.
   *
   * A word that only means "current" counts. `page 2` on its own never does,
   * because every member of a pager says that about itself.
   */
  // `(?:^|[^a-z])` rather than `\b` in front of the two phrases that can follow a
  // number directly: `textContent` of `<button>1<span
  // class="visually-hidden">Current page</span></button>` is `1Current page`,
  // and there is NO word boundary between `1` and `Current` — a digit and a
  // letter are both word characters. `\b` therefore failed on the one shape a
  // pager most often renders, which is the same class of defect as the anchored
  // `pageNumberFrom` above: a reader that cannot see its own subject.
  const CURRENT_PAGE_NAME_PATTERN =
    /(?:(?:^|[^a-z])current(?:ly)?\s+page\b|\bpage\s+\d{1,4}\s*[,;-]?\s*current\b|\byou(?:'re|\s+are)\s+on\s+page\b|(?:^|[^a-z])selected\s+page\b|\bpage\s+\d{1,4}\s*[,;-]?\s*selected\b)/i;

  function saysCurrentPage(value) {
    const text = normalizeLabel(value);
    return Boolean(text) && CURRENT_PAGE_NAME_PATTERN.test(text);
  }

  /**
   * The next page to press when the pager will not say which page it is on.
   *
   * **The third reader, and the one that needs no mark at all.** Both readers
   * above depend on the pager volunteering something. This one depends only on
   * an arithmetic fact that no layout can take away: *pressing the control
   * labelled N leaves you on page N*. So a pager that says nothing is walked
   * from its lowest offered number, one step at a time, and each press tells the
   * next one where it is.
   *
   * `visited` is what this walk has pressed, in order. Empty means nothing has
   * been pressed yet, and the assumption is then the lowest number the pager
   * offers — 1 on every pager that renders one, and on an elided pager the
   * lowest it renders. That assumption can only ever be too LOW, never too high,
   * which is the direction that is safe: too low costs a page this run walks
   * again for nothing (the identity ledger skips everyone on it), while too high
   * costs a page of applicants nobody ever opens.
   *
   * **Exactly one step, always.** The returned page is `current + 1` and must be
   * one the pager actually offers, so an elided pager showing `1 … 25 26 27` can
   * never be used to jump from 1 to 25. When `current + 1` is not offered the
   * answer is `walked-out` — on a pager walked to its end that is the genuine
   * end of the list, and it is deliberately a different answer from
   * `not-a-pager`, which means only that this reader could not see.
   *
   * Pure, and separated from the DOM for exactly the reason the guide gives:
   * this is the arithmetic that decides which control gets pressed, and it is
   * the one part of a pager that can be executed in a test rather than reasoned
   * about.
   */
  function planPagerOrdinalStep({ offered = [], visited = [] } = {}) {
    const decline = (reason) => ({ ok: false, reason, current: null, next: null });

    // THE SHAPE PROOF, and it is what earns the right to press a control the
    // page never marked. Without a current-page mark, "these numbers are a
    // pager" is the only thing standing between this and pressing an arbitrary
    // numeric button, so the shape is required to be a pager's exactly:
    //
    //   - every member offers a page number, and nothing else is in the group;
    //   - they ASCEND in the order the page rendered them, because a pager is a
    //     row of pages in order and an accidental collection of numbers is not;
    //   - the lowest is page ONE. Every pager LinkedIn renders offers page one,
    //     including an elided one (`1 … 25 26 27`), and a rating, a count or a
    //     year that happens to sit in a row does not start at one and ascend.
    //
    // A group that fails any of these is declined as `not-a-pager`, which the
    // caller must treat as "this reader could not see" — never as the end of the
    // list, because a job completed by mistake can never restart itself.
    const pages = [];
    for (const value of offered || []) {
      if (!Number.isInteger(value) || value <= 0) return decline("not-a-pager");
      if (pages.length && value <= pages[pages.length - 1]) return decline("not-a-pager");
      pages.push(value);
    }
    if (pages.length < 2) return decline("not-a-pager");
    if (pages[0] !== 1) return decline("not-a-pager");

    const walked = [];
    for (const value of visited || []) {
      if (Number.isInteger(value) && value > 0) walked.push(value);
    }
    const current = walked.length ? walked[walked.length - 1] : pages[0];
    const next = current + 1;
    // Nothing after the page being shown. On a pager walked to its end this is
    // the genuine end of the list, and the caller may complete the run on it.
    if (!pages.includes(next)) return { ok: false, reason: "walked-out", current, next: null };
    // Never twice. A pager already asked for page 4 and asked again is not
    // making progress, and repeating the press is how a walk stops terminating.
    if (walked.includes(next)) return { ok: false, reason: "already-visited", current, next: null };
    return { ok: true, reason: "ordinal", current, next };
  }

  function normalizeLabel(value) {
    const core = CORE();
    if (core?.cleanText) return core.cleanText(value).toLowerCase();
    return cleanText(value).toLowerCase();
  }

  /**
   * Is this control PROVABLY one applicant's own row, rather than something else
   * that happens to sit inside the applicant list?
   *
   * Three facts together, and no one of them alone would do:
   *
   *   1. the caller asked for a row — `CONTROL_PURPOSE.APPLICANT_ROW`;
   *   2. it was enumerated from inside the applicant list, which is the same
   *      container proof every other purpose on this surface must supply;
   *   3. **its own address carries an `applicationId`** — it NAVIGATES TO an
   *      application rather than acting on one.
   *
   * The third is the load-bearing one, and it is structural rather than textual,
   * which is the whole reason it can be trusted where a card's words cannot. An
   * ATS action — Reject, Shortlist, Move to, Rate, Message — is something the
   * page DOES; it is a button, and it has no application address to point at. A
   * row is a link to one person's application on this job, and on this surface
   * that address is the only thing that identifies an applicant. That is why a
   * card's contents may be disregarded here and nowhere else.
   *
   * A row offering no `applicationId` earns no proof and falls back to the
   * strict whole-string denylist, unchanged — the multi-UI guide's one rule,
   * which is to add a reader after the working one rather than replace it.
   */
  function isProvenApplicantRow({ purpose = "", inContainer = false, href = "", applicationId = "" } = {}) {
    if (purpose !== CONTROL_PURPOSE.APPLICANT_ROW) return false;
    if (!inContainer) return false;
    if (cleanText(applicationId)) return true;
    return Boolean(cleanText(parseHiringContext(href).applicationId || ""));
  }

  /**
   * May this element be clicked, and why.
   *
   * `purpose` says what the caller wants it for; `inContainer` is the caller's
   * proof that the element was enumerated from inside the right container, not
   * found by label anywhere on the page. "Show details" labels half a dozen
   * unrelated controls on this surface, so the proof is mandatory for every
   * purpose except the resume link, which is unambiguous by name.
   *
   * `currentPage` is a second proof of the same kind, for pagination only: the
   * page the pager itself marks as the one being shown. A numbered pager's
   * controls are named `1`, `2`, `3` and say nothing about what they are, so
   * that number is what makes "the next page" decidable rather than guessed.
   */
  function classifyApplicantControl({
    text = "",
    ariaLabel = "",
    purpose = "",
    inContainer = false,
    currentPage = null,
    // The control's own address, and the id in it. Supplied for an applicant row
    // so the denylist can tell a person's CARD from a control's LABEL; ignored
    // for every other purpose. See `isProvenApplicantRow`.
    href = "",
    applicationId = ""
  } = {}) {
    const label = normalizeLabel(text) || normalizeLabel(ariaLabel);
    const combined = `${normalizeLabel(text)} ${normalizeLabel(ariaLabel)}`.trim();
    const refuse = (reason, forbidden = false) => ({ allowed: false, forbidden, label, purpose, reason });

    if (!label) return refuse("no-label");
    // The denylist always wins, and it is consulted first.
    //
    // WHAT IT IS GIVEN, though, depends on what kind of string the caller has.
    // Every control on this surface is a button or a menu item whose text is its
    // own claim about what pressing it does — every control except the applicant
    // row, which is a CARD of somebody's data. Testing a card for action words
    // refused every rated applicant on the page ("Good fit", "Maybe", "Not a
    // fit") and anyone whose employer or headline contained one, and saved each
    // of them as a bare name. A proven row is therefore asked the narrower
    // question, and the proof is its address rather than its text. Nothing else
    // moves: an unproven row, and every other purpose, is tested exactly as
    // before, on the whole of `combined`, aria-label included.
    //
    // TWO PROOFS, and each closes the other one's gap. The address says the
    // control navigates to an application; `isApplicantRowLabel` says the label
    // reads like a person rather than a command. Without the second, "Send
    // InMail" slips through — neither `send` nor `inmail` is the WHOLE label, so
    // the anchored test below does not catch it, and the same is true of
    // "Schedule interview", "Move to Rejected" and "Rate this AI-generated
    // content". `NAME_CONTROL_PHRASE_PATTERN` catches all of them, because an
    // action phrase LEADS WITH ITS VERB and a person's card never does.
    //
    // Asked of the TEXT and never of the accessible name, for the reason
    // `isApplicantRowLink` already records: "View Komal Sharma's application" is
    // an entirely plausible accessible name for a row and it leads with a verb,
    // so judging it would refuse every row on the page rather than one control.
    // The aria-label is still tested by the anchored rule below, so an
    // `aria-label="Reject"` is refused whatever the visible text says.
    // With no visible text there is no CARD, and the accessible name is then the
    // only string there is — so that is what the proof is taken from. Without
    // this an `aria-label="Send InMail"` on a control with no text of its own
    // was proven a row (an empty label satisfies `isApplicantRowLabel` by
    // design, so that a row whose text has not painted yet is not thrown away)
    // and then slipped past the anchored rule, which sees two tokens rather than
    // one whole label. Judged this way it reads as the command it is and falls
    // to the strict rule, while `aria-label="Komal Sharma, Good fit"` on the
    // same empty-text row still reads as a person and still opens.
    const provenRow = isProvenApplicantRow({ purpose, inContainer, href, applicationId })
      && isApplicantRowLabel(cleanText(text) ? text : ariaLabel);
    const forbidden = provenRow
      ? FORBIDDEN_APPLICANT_ROW_LABEL_PATTERN.test(normalizeLabel(text))
        || FORBIDDEN_APPLICANT_ROW_LABEL_PATTERN.test(normalizeLabel(ariaLabel))
      : FORBIDDEN_APPLICANT_CONTROL_PATTERN.test(combined);
    // THE ONE LINE 3.14.0 CHANGED, and it is still the first gate in the file.
    //
    // `forbidden` above is computed exactly as it always was — the proven row
    // still asks the anchored question, everything else still asks the whole of
    // `combined`, aria-label included. What is new is the second clause, and it
    // can only ever REFUSE MORE than the exemption allows, never less: for every
    // purpose that forgives nothing `firesOutsideExemption` returns true without
    // reading the label at all, so the row branch and all six original purposes
    // behave identically to the release before this one, byte for byte.
    //
    // At the two message purposes it re-asks the same denylist for its evidence
    // and refuses unless every word that fired is one this purpose may forgive.
    // `combined` is what it is given, deliberately: the same widest string the
    // denylist itself judged, so an `aria-label="Message and reject"` on a
    // button whose visible text is a bare "Message" is refused on `reject`.
    if (forbidden && firesOutsideExemption(purpose, combined)) return refuse("forbidden-action", true);

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
      // These two run BEFORE the allowlist, and the order is the point: both
      // sit inside the applicant panel, so `inContainer` cannot tell either of
      // them from a real expander, and both must say WHY they were refused
      // rather than falling through to a generic "not a disclosure". That
      // reason is what `diagnostics.expansions` reports (3.9.1).
      if (APPLICANT_NAVIGATION_CONTROL_PATTERN.test(combined)) return refuse("navigates-away");
      if (isApplicantMenuOpenerLabel(label) || isApplicantMenuOpenerLabel(combined)) {
      return refuse("overflow-menu-not-a-disclosure");
    }
      if (!DISCLOSURE_CONTROL_PATTERN.test(label)) return refuse("not-a-disclosure-control");
      if (!inContainer) return refuse("outside-applicant-panel");
      return { allowed: true, forbidden: false, label, purpose, reason: "expand-section" };
    }
    if (purpose === CONTROL_PURPOSE.CONTACT_MENU) {
      // Opening a menu is not acting on the applicant: it renders controls the
      // recruiter is already being offered and sends nothing. What makes it safe
      // is not the opening but what the caller is then allowed to press —
      // `openContactAndCollect` looks inside the opened menu for a CONTACT
      // control and nothing else, and this classifier's denylist still runs
      // first on that item, so every ATS action in the menu stays refused.
      if (!isApplicantMenuOpenerLabel(label) && !isApplicantMenuOpenerLabel(combined)) {
      return refuse("not-a-menu-opener");
    }
      if (!inContainer) return refuse("outside-applicant-panel");
      return { allowed: true, forbidden: false, label, purpose, reason: "contact-menu" };
    }
    if (purpose === CONTROL_PURPOSE.APPLICANT_ROW) {
      if (!inContainer) return refuse("outside-applicant-list");
      return { allowed: true, forbidden: false, label, purpose, reason: "applicant-row" };
    }
    if (purpose === CONTROL_PURPOSE.PAGINATION) {
      // THE NAME FIRST, and now the ACCESSIBLE name as well as the text. A
      // numbered pager renders `2` as its text and says `Page 2` only in its
      // `aria-label`, and `label` above prefers the text whenever there is one —
      // so the string that actually says what the control is was never read.
      const named = APPLICANT_PAGINATION_PATTERN.test(paginationLabel(normalizeLabel(text)))
        || APPLICANT_PAGINATION_PATTERN.test(paginationLabel(normalizeLabel(ariaLabel)))
        // The same control, named in a full sentence. See the pattern for why
        // every alternative in it requires the word `page`.
        || APPLICANT_PAGINATION_PHRASE_PATTERN.test(normalizeLabel(text))
        || APPLICANT_PAGINATION_PHRASE_PATTERN.test(normalizeLabel(ariaLabel));

      // THE NUMBER SECOND, and only ever with the caller's proof. A bare `2` is
      // still refused on its own — nothing about the string says it is a page.
      // `currentPage` is that proof: the caller read it off the pager itself,
      // from the control the page marks `aria-current`, and a number is accepted
      // only when it is the very NEXT one. So `1` can never be pressed from page
      // one (no forward progress, and an endless run), `5` can never be pressed
      // from page one (skipping three pages of applicants), and a numeric
      // control that is not part of a pager has no current page to be next to.
      const offered = pageNumberFrom(text) ?? pageNumberFrom(ariaLabel);
      const current = Number.isInteger(currentPage) && currentPage > 0 ? currentPage : null;
      const numbered = offered !== null && current !== null && offered === current + 1;

      if (!named && !numbered) return refuse("not-a-pagination-control");
      // Proven inside the list, exactly as connections pagination is: a "Next"
      // anywhere else on a hiring page belongs to something that is not the
      // applicant list, and pressing it would leave the run somewhere else.
      if (!inContainer) return refuse("outside-applicant-list");
      return {
        allowed: true, forbidden: false, label, purpose,
        reason: named ? "pagination" : "pagination-numbered",
        page: numbered ? offered : null
      };
    }
    if (purpose === CONTROL_PURPOSE.MESSAGE_OPEN) {
      if (!MESSAGE_OPEN_CONTROL_PATTERN.test(label)) return refuse("not-a-message-control");
      // Proven inside the applicant's own panel, exactly as the contact
      // disclosure is. This surface renders `Message` in more than one place —
      // the messaging overlay LinkedIn pins to the corner is the obvious one —
      // and a composer opened from anywhere but this applicant's panel is
      // addressed to whoever that other control belongs to. Rule 6 already
      // refuses the overlay by scope; this refuses it by proof as well.
      if (!inContainer) return refuse("outside-applicant-panel");
      return { allowed: true, forbidden: false, label, purpose, reason: "message-open" };
    }
    if (purpose === CONTROL_PURPOSE.MESSAGE_SEND) {
      if (!MESSAGE_SEND_CONTROL_PATTERN.test(label)) return refuse("not-a-send-control");
      // Proven inside the composer this extension opened itself — not the
      // panel, not the page. `Send` is a bare, common label and the only one in
      // this file whose press cannot be taken back, so the container is the
      // difference between sending the message that was just verified and
      // pressing whatever else on a hiring page happens to say Send.
      if (!inContainer) return refuse("outside-message-composer");
      return { allowed: true, forbidden: false, label, purpose, reason: "message-send" };
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

  // 3.9.4. The card above is not the only shape LinkedIn renders. The
  // Insights-from-profile panel puts each of the three on its OWN line:
  //   Business Development Executive
  //   Brevity Software Solutions PVT. LTD.
  //   2023 – 2026
  // and the reader below took the line carrying the dates to be the company
  // line, because on the compressed card it always is. `splitCompanyAndDates`
  // then found the date range at offset 0, had nothing to cut, and returned the
  // whole string as the company — so a live run saved "2023 – 2026",
  // "2025 – 2026" and "Years employed from 2025 to Present" into
  // `current_company` on consecutive rows, with the real employer sitting in
  // `details` and the date range empty (which emptied `total_experience` too,
  // since `totalExperienceFrom` skips an entry with no range).
  //
  // Everything below turns on one question the reader could not previously
  // ask: **is this line dates, or is it an employer?**

  /** Words that are part of how a date line is worded, not part of a name. */
  const DATE_LINE_FILLER_PATTERN =
    /\b(?:years?|yrs?|months?|mos?|employed|employment|working|worked|from|to|until|till|since|present|current|currently|now|date|dates|full[\s-]?time|part[\s-]?time|freelance|contract|permanent|internship)\b/gi;

  const MONTH_WORD_PATTERN = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/gi;

  /**
   * Is this whole line the dates, with no employer anywhere in it?
   *
   * Deliberately answered by ELIMINATION rather than by matching a date
   * wording: strip the months, the connective words a date line is built from
   * and every digit, and a line that has nothing left was only ever dates.
   * A company name survives that stripping — "Brevity Software Solutions PVT.
   * LTD." keeps every word of itself — which is what keeps this from swallowing
   * the value it exists to protect. "Present Solutions • 2020-2024" keeps
   * "Solutions" and is correctly NOT a date line.
   *
   * A line with no letters at all is decided first and on its own: no employer
   * is spelled without letters, which is a rule `isEmployerCandidate` already
   * states for the labelled reader.
   */
  function isDateOnlyLine(text) {
    const value = cleanText(text);
    if (!value) return false;
    if (!/[a-z]/i.test(value)) return /\d/.test(value);
    if (!DATE_RANGE_PATTERN.test(value) && !PRESENT_PATTERN.test(value)) return false;
    const remainder = value
      .replace(MONTH_WORD_PATTERN, " ")
      .replace(DATE_LINE_FILLER_PATTERN, " ")
      .replace(/[^a-z]/gi, " ");
    return !cleanText(remainder);
  }

  // ------------------------------------------------------- the section table
  //
  // Moved here from the DOM adapter in 3.9.0, byte for byte. It is pure
  // string → key policy and it was the single most consequential untestable
  // thing in the extension: `current_role`, `current_company` and
  // `total_experience` came back empty on FOUR consecutive releases, every time
  // because a heading the table did not recognise made the whole Experience
  // section invisible — no heading matched, no section existed, every reader
  // returned 0, and nothing warned. All three fields are derived from that one
  // section and from nothing else.
  //
  // `diagnostics.sectionScan.headings[].key === ""` already names every wording
  // that failed, on every live run. With the table here, acting on one of those
  // reports is a three-line unit test instead of a live-only gamble — which is
  // the whole of the guide's "add safe fallback readers for the new UI".
  //
  // The adapter keeps using it under the same two names, so `buildSectionMap`'s
  // six passes are unchanged: they never spell a wording, they ask this.

  /**
   * The section names, and the wordings LinkedIn actually renders them in.
   *
   * Widened in 3.7.6 after `current_role`, `current_company` and
   * `total_experience` came back empty on every row of a live run. The previous
   * `^experiences?$` matched the section's title only when the account rendered
   * it as that exact word, with nothing after it. A count (`Experience (5)`), a
   * qualifier (`Work experience`) or a trailing colon was enough to make the
   * whole section invisible, silently.
   */
  const SECTION_PATTERNS = Object.freeze([
    // 3.7.7: the same widening, for the section the recruiter screen leads with.
    // `Qualifications` is what LinkedIn labels the must-have / preferred verdict
    // card, but plenty of accounts render only its two subheadings and never the
    // word itself — which is what `collectQualificationSubsections` is for.
    { key: "qualifications", pattern: /^(?:screening |job |candidate |applicant )?qualifications?(?: summary| overview| match)?$/i },
    { key: "screening", pattern: /^screening question(?: response)?s?$/i },
    // 3.9.0 aliases. Every one of them is a wording LinkedIn is documented to
    // render for the same section, every one is anchored `^…$`, and every one
    // was checked against the six content lines the parsers' own negative test
    // pins — "Legal Assistant", "CHANDIGARH UNIVERSITY", "Bachelor of Laws -
    // LLB", "Experience Cloud Consultant", "Education First" and a dated
    // employer line — before it was added. A wrong key hands one section's cards
    // to another reader, which is why this table stays narrow even while it
    // widens.
    { key: "experience", pattern: /^(?:(?:work|professional|employment|career)\s+)?experiences?$|^(?:work|employment|job)\s+history$|^employment$/i },
    { key: "education", pattern: /^(?:education(?:al background)?|academics?|academic background|education (?:&|and) training)$/i },
    { key: "skills", pattern: /^(?:top )?skills?(?: (?:&|and) (?:endorsements|expertise))?$/i },
    { key: "about", pattern: /^(?:about|summary)$/i },
    { key: "resume", pattern: /^(?:resumes?|résumés?|cv|resume\s*\/\s*cv|resume (?:&|and) cv|curriculum vitae|(?:resume |cv )?attachments?)$/i }
  ]);

  /** Every key the table can produce. */
  const SECTION_KEYS = Object.freeze(SECTION_PATTERNS.map((entry) => entry.key));

  /**
   * The keys a READER actually consumes.
   *
   * Identical to `SECTION_KEYS` today and deliberately a separate list. Every
   * pass in `buildSectionMap` is scheduled off "which keys are still missing",
   * so a key added for diagnostics or for boundary-marking alone — a top card, a
   * contact block — would otherwise make the adapter run extra page-wide
   * searches for a section no reader will ever read. This is the list that
   * drives scheduling; `SECTION_KEYS` is the list that drives recognition.
   */
  const REQUIRED_SECTION_KEYS = Object.freeze([...SECTION_KEYS]);

  /**
   * What a section title may carry after its name without ceasing to be one.
   *
   * One copy, shared by the page-side key lookup and the line-side title test.
   * It existed twice, identically, with a comment on the second saying it was
   * "the same trimming `sectionKeyFor` applies on the page" — which is now true
   * rather than aspirational.
   */
  function normalizeSectionTitle(text) {
    return cleanText(text)
      // "Experience · 3 roles" — a middot list of metadata after the name.
      .replace(/\s*[·•|].*$/, "")
      // "Experience (5)" and "Skills (12+)" — the count LinkedIn renders inline.
      .replace(/\s*\(\s*\d+\+?\s*\)\s*$/, "")
      // "Experience 5" — the same count with the brackets not rendered.
      .replace(/\s+\d+\+?$/, "")
      .replace(/\s*[:：]\s*$/, "");
  }

  /** Which section, if any, this heading names. */
  function sectionKeyFor(text) {
    const value = normalizeSectionTitle(text);
    return SECTION_PATTERNS.find((entry) => entry.pattern.test(value))?.key || "";
  }

  /**
   * Sections that BOUND the readable ones without being read themselves.
   *
   * The guide's Phase 6 asks for a section map including a top card, contact,
   * application details and additional information, and forbids merging Contact
   * or Resume text into a profile section. None of these four is read by
   * anything — there is no `readTopCard` and there never will be, because the
   * top card's fields are the header's — but a root that swallowed one was
   * handing its text to a reader that had no business with it.
   *
   * **Deliberately a SEPARATE table, and deliberately narrower in what it may
   * do.** Put in `SECTION_PATTERNS` these four would (a) be scheduled for by
   * `REQUIRED_SECTION_KEYS`, which is page-wide searching for a section nothing
   * reads, and (b) become boundaries for `cutToOwnSection`, the LINE-level cut
   * every reader's text fallback runs through — where a stray "Additional
   * information" inside an experience card would truncate the section at it.
   * So they are used for two things only: cutting an element-level root that had
   * already swallowed a foreign section, and naming themselves in the section
   * scan so a live run can report what is on screen.
   */
  const AUXILIARY_SECTION_PATTERNS = Object.freeze([
    { key: "topCard", pattern: /^(?:top card|profile summary|candidate summary|applicant summary)$/i },
    { key: "contact", pattern: /^contact (?:info(?:rmation)?|details)$/i },
    { key: "applicationDetails", pattern: /^application (?:details|information)$/i },
    { key: "additionalInformation", pattern: /^(?:additional|supplementary) information$/i }
  ]);

  const AUXILIARY_SECTION_KEYS = Object.freeze(AUXILIARY_SECTION_PATTERNS.map((entry) => entry.key));

  /** Which section this heading names, readable or merely bounding. */
  function anySectionKeyFor(text) {
    const key = sectionKeyFor(text);
    if (key) return key;
    const value = normalizeSectionTitle(text);
    return AUXILIARY_SECTION_PATTERNS.find((entry) => entry.pattern.test(value))?.key || "";
  }

  /**
   * The lines of a section's text that are its own.
   *
   * Lifted out of the adapter in 3.9.0 so it can be tested, and it is the single
   * function keeping school data out of Experience whenever the markup offered
   * no blocks: every reader falls back to reading its section's text linearly,
   * and a flat string has none of the structure `narrowSharedSections` works on,
   * so a root still spanning a neighbour hands the fallback the next section
   * whole. That is where "Screening question responses" became a job title and
   * the question beneath it the employer.
   *
   * Cut at the first line naming a **different readable** section, and at
   * nothing else. Not at an auxiliary one — a stray "Additional information"
   * inside a card would truncate the section at its first such line — and not at
   * "Experience verified" or "Show more", which are lines the parsers' own noise
   * filter drops one at a time and which would otherwise end the section at its
   * first verified card.
   */
  function cutToOwnSection(lines = [], key = "") {
    const list = Array.isArray(lines) ? lines : toLines(lines);
    if (!key || !list.length) return list;
    const own = list.findIndex((line) => sectionKeyFor(line) === key);
    const rest = own > 0 ? list.slice(own) : list;
    const cut = rest.findIndex((line, index) => {
      if (index === 0) return false;
      const found = sectionKeyFor(line);
      return Boolean(found) && found !== key;
    });
    return cut < 0 ? rest : rest.slice(0, cut);
  }

  /**
   * Lines that are chrome rather than any field of a card.
   *
   * The section names of the applicant's OTHER sections are in here on purpose:
   * when a root spans more than one section, or the text fallback runs over a
   * range that reaches the next heading, "Education" would otherwise become a
   * job title with the school beneath it as the employer. A wrong entry is worse
   * than an empty one (rule 6).
   */
  /**
   * A line that names a SECTION rather than any field of a card.
   *
   * One list for both readers since 3.7.22, because the failure it answers is
   * symmetrical and it was only ever half-answered. `EXPERIENCE_NOISE_PATTERN`
   * carried this list; `EDUCATION_NOISE_PATTERN` carried four entries. So a root
   * spanning both sections discarded "Experience verified" on the way into the
   * experience list and stored "Education verified" as an **institution** — which
   * is verbatim what a live record showed. It also never knew the titles of the
   * sections that follow, so "Screening question responses" and "Supplementary"
   * became job titles with the question beneath them as the employer.
   *
   * Deliberately the section titles of *every* section on this surface, not only
   * the two: a root that spans one boundary routinely spans the next as well.
   */
  const SECTION_TITLE_NOISE_PATTERN =
    /^(?:(?:work |professional |employment |career )?experiences?|(?:work|employment|job) history|employment|education(?:al background)?|academics?|academic background|education (?:&|and) training|(?:top )?skills?(?: (?:&|and) (?:endorsements|expertise))?|about|summary|licenses? (?:&|and) certifications?|projects?|languages?|recommendations?|interests?|(?:screening |job |candidate |applicant )?qualifications?(?: summary| overview| match)?|must[-\s]?haves?(?: qualifications?)?|preferred(?: qualifications?)?|nice[-\s]to[-\s]haves?|screening question(?: response)?s?|supplementary|required|resumes?|résumés?|cv|resume\s*\/\s*cv|resume (?:&|and) cv|curriculum vitae|(?:resume |cv )?attachments?|contact info(?:rmation)?|contact details|top card|profile summary|candidate summary|application details|application information|additional information|supplementary information|view full profile|see full profile|show (?:more|less|all)|see (?:more|less)|(?:experience|education|skill) verified|verified)$/i;

  const EXPERIENCE_NOISE_PATTERN = SECTION_TITLE_NOISE_PATTERN;

  /**
   * A qualification, spelled out — the half of the education signal that can
   * never be an employer.
   *
   * Anchored on the words rather than on three-letter forms on purpose: no
   * company is called "Bachelor of Laws", while `BBA Aviation` and `MBA Group`
   * are real employers, so an abbreviation alone may never refuse an experience
   * card (rule 6 cuts both ways — a *lost* job is as wrong as an invented one).
   */
  const SPELLED_DEGREE_PATTERN =
    /(?:^|[\s(,\-–—•·|/])(?:bachelor|master)(?:'|’)?s?(?:\s+(?:of|degree|in)\b|\s*$)|(?:^|[\s(,\-–—•·|/])doctor(?:ate|al)\b|^(?:diploma|certificate|associate(?:'|’)?s? degree|higher secondary|secondary school|high school|intermediate|post ?graduate|under ?graduate)\b/i;

  /** Any qualification, abbreviations included — corroboration, never proof. */
  const DEGREE_PATTERN = new RegExp(
    `${SPELLED_DEGREE_PATTERN.source}|(?:^|[\\s(,\\-–—•·|/])(?:b\\.?tech|m\\.?tech|b\\.?sc|m\\.?sc|b\\.?com|m\\.?com|b\\.?ed|m\\.?ed|b\\.?arch|b\\.?pharm|m\\.?pharm|bba|mba|bca|mca|llb|llm|mbbs|bds|ph\\.?d|m\\.?phil)(?:$|[\\s).,\\-–—•·|/])`,
    "i"
  );

  /** A place people study at. */
  const INSTITUTION_PATTERN =
    /\b(?:university|universit(?:e|é|y|à|ä)t|universidad|université|college|institute|institution|school|academy|polytechnic|vidyalaya|vidyapeeth|vishwavidyalaya|mahavidyalaya|gurukul|seminary|conservatory|iit|iim|iiit|nit|bits|aiims|campus|faculty)\b/i;

  /**
   * Does this card carry an education signal at all?
   *
   * The two readers are handed the same blocks whenever a resolved root spans
   * both sections, and neither parser refused anything before 3.7.22 — both are
   * shape-only, so `parseExperienceBlock` turned "CHANDIGARH UNIVERSITY /
   * Bachelor of Laws - LLB · 2021-2024" into a job at a degree, and
   * `parseEducationBlock` turned "Legal Assistant / Bhatia and Khatri Law
   * Office · 2024-Present" into a school called Legal Assistant. Both were
   * saved, on the same applicant, from one live run.
   */
  function educationSignalIn(lines = []) {
    const list = (Array.isArray(lines) ? lines : toLines(lines)).map((line) => cleanText(line)).filter(Boolean);
    if (!list.length) return { institution: false, degree: false, spelledDegree: false };
    return {
      institution: INSTITUTION_PATTERN.test(list[0]),
      degree: list.some((line) => DEGREE_PATTERN.test(line)),
      spelledDegree: list.some((line) => SPELLED_DEGREE_PATTERN.test(line))
    };
  }

  /**
   * Is this unmistakably an education card, and therefore never a job?
   *
   * Asymmetric on purpose. Refusing a real job is worse here than letting an
   * odd school through, because `deriveCurrentPosition` and
   * `totalExperienceFrom` read nothing but this list — so it takes either a
   * spelled-out qualification, which no employer is named, or an institution on
   * the first line *corroborated* by a qualification anywhere in the card.
   */
  function looksLikeEducationBlock(lines = []) {
    const signal = educationSignalIn(lines);
    return signal.spelledDegree || (signal.institution && signal.degree);
  }

  /**
   * A screening question is not a card of anybody's history.
   *
   * The screening section sits between Experience and Education on this
   * surface, so a root spanning one boundary routinely spans the other, and
   * "We must fill this position urgently. Can you start immediately?" was
   * stored as a job title with the ideal answer beneath it. No role and no
   * school is phrased as a question, so the mark is enough on its own — and it
   * is checked here as well as at the section boundary because the boundary is
   * markup and this is not.
   */
  function looksLikeQuestionBlock(lines = []) {
    const list = (Array.isArray(lines) ? lines : toLines(lines)).map((line) => cleanText(line)).filter(Boolean);
    return Boolean(list.length) && /\?$/.test(list[0]);
  }

  /** Is this a card an education section could plausibly have rendered? */
  function looksLikeEducationCandidate(lines = []) {
    const signal = educationSignalIn(lines);
    return signal.institution || signal.degree;
  }

  /** Is this whole line the title of a section rather than content of one? */
  function isSectionTitleLine(text) {
    // The same trimming `sectionKeyFor` applies on the page, and now literally
    // the same function: a title is still a title with a count, a middot list of
    // metadata or a colon after it.
    const value = normalizeSectionTitle(text);
    return Boolean(value) && SECTION_TITLE_NOISE_PATTERN.test(value);
  }

  /** Split "Naad Wellness • 2026-Present" into its two halves. */
  function splitCompanyAndDates(line) {
    const text = cleanText(line);
    if (!text) return { company: "", dateRange: "" };
    // There is no company in this string to find: it is the whole date line of
    // a card that renders the employer above it. Returning `text` as the
    // company here is what wrote a date range into `current_company` on every
    // row of a live run — and rule 1 says a blank beats a wrong value. The
    // leading separator is dropped the same way the education reader drops it.
    if (isDateOnlyLine(text)) {
      return { company: "", dateRange: cleanText(text.replace(/^[^0-9a-z]+/i, "")) };
    }
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
    // An education card is not a job, however job-shaped its two lines are.
    // The structural fix keeps the sections apart; this is what holds when the
    // markup offers no boundary to keep them apart *by*.
    if (looksLikeEducationBlock(meaningful) || looksLikeQuestionBlock(meaningful)) return null;

    const core = CORE();
    const title = core?.sanitizeRoleTitle ? core.sanitizeRoleTitle(meaningful[0]) || meaningful[0] : meaningful[0];
    const rest = meaningful.slice(1);
    const datedLineAt = rest.findIndex((line) => DATE_RANGE_PATTERN.test(line) || PRESENT_PATTERN.test(line));
    const datedLine = datedLineAt >= 0 ? rest[datedLineAt] : rest[0] || "";
    const split = splitCompanyAndDates(datedLine);
    let company = split.company;
    const dateRange = split.dateRange;
    const used = [datedLine];

    // SECOND READER, and it runs only where the first one found nothing: the
    // dated line named no employer, which on the compressed card cannot happen
    // and on the Insights-from-profile card always does. The employer is the
    // line ABOVE the dates there, so that is looked at first; failing that, the
    // first line of the card that is not itself dates. A layout whose dated
    // line does carry the company never reaches this at all, which is the whole
    // of the multi-UI guide's rule — add a reader after the working one.
    if (!company) {
      const above = datedLineAt > 0 ? rest[datedLineAt - 1] : "";
      const named = above && !isDateOnlyLine(above)
        ? above
        : rest.find((line) => line !== datedLine && !isDateOnlyLine(line)) || "";
      if (named) {
        company = named;
        used.push(named);
      }
    }
    const details = rest.filter((line) => !used.includes(line));

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

  /**
   * Does this line continue the experience card being built, or open a new one?
   *
   * The adapter's text fallback — the reader that runs when the section's
   * markup offers no card elements — grouped lines with a regex that spelled
   * what a *compressed* card's second line looks like: a middot, a year, the
   * word Present, the word verified. On the Insights-from-profile card the
   * second line is the bare employer name and matches none of those, so the
   * company opened a card of its own and the title was left as a one-line card
   * with no employer at all.
   *
   * Lives here rather than in the adapter because it is string policy and the
   * adapter cannot be unit-tested — there is no jsdom in this repository.
   *
   * The added clause is bounded to the one case that cannot be a card already:
   * a card holding NOTHING BUT ITS TITLE. Absorbing a line there cannot split
   * or merge anything that used to be whole, and every line the old regex
   * accepted is still accepted first.
   */
  const EXPERIENCE_CONTINUATION_PATTERN = /[•·|]|\d{4}|\bpresent\b|\bverified\b/i;

  function continuesExperienceCard(line, card = []) {
    const text = cleanText(line);
    if (!text) return false;
    const lines = (Array.isArray(card) ? card : toLines(card)).map((entry) => cleanText(entry)).filter(Boolean);
    if (!lines.length) return false;
    if (EXPERIENCE_CONTINUATION_PATTERN.test(text)) return true;
    // A section title or a screening question opens its own thing, never
    // somebody's employer line.
    return lines.length === 1 && !isSectionTitleLine(text) && !/\?\s*$/.test(text);
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
    const company = cleanText(chosen.company);
    return {
      currentRole: cleanText(chosen.title) || null,
      // A date range is never an employer, whatever produced it. The parser
      // above is the reason this column ever held one, and it is fixed — but
      // this column is written from an accumulated entry that may have been
      // stored by an older build or by a reader added later, so the refusal is
      // stated here too, where the value actually leaves for the record.
      currentCompany: company && !isDateOnlyLine(company) ? company : null
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

  // The same list the experience reader uses, and for the same reason. It had
  // four entries, which is why "Education verified" — a line LinkedIn renders
  // under a verified school — was stored as an institution of its own while the
  // experience side correctly discarded "Experience verified".
  const EDUCATION_NOISE_PATTERN = SECTION_TITLE_NOISE_PATTERN;

  function parseEducationBlock(lines = []) {
    const cleaned = (Array.isArray(lines) ? lines : toLines(lines))
      .map((line) => cleanText(line))
      .filter((line) => line && !EDUCATION_NOISE_PATTERN.test(line));
    if (!cleaned.length) return null;
    // A card naming neither a place of study nor a qualification is not one.
    // Looser than the experience refusal above because it is the safer side:
    // education is a list, not the source of a derived column, so an entry
    // missed here costs one line and an entry invented here is a job title
    // filed as a school — which is exactly what a live record showed.
    if (!looksLikeEducationCandidate(cleaned) || looksLikeQuestionBlock(cleaned)) return null;

    const institution = cleaned[0];
    const rest = cleaned.slice(1);
    const dateLine = rest.find((line) => DATE_RANGE_PATTERN.test(line)) || "";
    let degreeLine = rest.find((line) => line !== dateLine) || "";
    let dateRange = dateLine ? cleanText(dateLine.replace(/^[^0-9a-z]*/i, "")) : "";

    // The degree and the years arrive on ONE line at least as often as on two —
    // "Bachelor of Laws - LLB • 2021-2024" is what the live card renders — and
    // there was no line left over for the degree, so it was stored as `null`
    // and the whole line became the date range. The same collapsed-metadata
    // problem the experience card has, answered by the same tested split, and
    // only when nothing else offered a degree: a card that spells the years out
    // on their own line is untouched.
    if (!degreeLine && dateLine) {
      const split = splitCompanyAndDates(dateLine);
      if (split.company && split.dateRange) {
        degreeLine = split.company;
        dateRange = split.dateRange;
      }
    }
    const [degree, field] = degreeLine.split(/\s*[,·•]\s*/).map((part) => cleanText(part));

    return {
      institution,
      degree: degree || null,
      field: field || null,
      dateRange: dateRange || null,
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

  /**
   * The view tabs the hiring header renders beside the job title.
   *
   * Exported since 3.7.23 because the same list answers two questions that were
   * being answered separately: which lines of the header are NOT the title, and
   * — the new one — which element on the page even IS the header. The bar in the
   * screenshot reads "Human resource recruiters · Hiring plan · Candidate search
   * · Applicants (1,005) · Manage coworkers", so the tabs are what identify it,
   * and identifying it by its own rendered text rather than by a class name or a
   * position is what rule 7 asks for.
   */
  const JOB_VIEW_TAB_PATTERN =
    /^(?:hiring plan|candidate search|applicants?|manage coworkers|job details?|settings|top fit|all applicants|rejected|shortlisted)\b/i;

  function isJobViewTabLabel(text) {
    const value = cleanText(text);
    return Boolean(value) && value.length <= 60 && JOB_VIEW_TAB_PATTERN.test(value);
  }

  /** How many DISTINCT view tabs this block of text renders. */
  function countJobViewTabs(text) {
    const seen = new Set();
    for (const line of toLines(text)) {
      if (!isJobViewTabLabel(line)) continue;
      // "Applicants (1,005)" and "Applicants (665)" are one tab, not two.
      seen.add(cleanText(line).toLowerCase().replace(/\s*\(.*$/, ""));
    }
    return seen.size;
  }

  /**
   * Chrome that renders exactly where a job title renders, and is not one.
   *
   * THE DEFECT (3.14.1): "the first line that is not a view tab" is not a
   * definition of a job title — it is a definition of whatever chrome happens to
   * come first. Three separate lines beat the real title to it on a captured
   * recruiter workspace whose bar reads "Overview · Applicants · Job details ·
   * Settings" above an `ACTIVE` eyebrow and an `<h1>`:
   *
   *   - `Overview` — a view tab this build did not know, so it read as the
   *     "line that is not a tab" and made the TAB LIST look like it held a
   *     title. `findJobViewHeader` stopped there and never reached the heading.
   *   - `ACTIVE` — the job's status eyebrow, rendered above the `<h1>`.
   *   - `Job title` — a label, which is what an sr-only caption or a labelled
   *     layout renders above the value. Clipped text is still `innerText`.
   *
   * Each was saved as the job title for every applicant on the job. The list is
   * a small set of EXACT words, never a heuristic, because rule 1 says a wrong
   * value is worse than a blank one and a shape test would eventually refuse a
   * real title. No job is called "Active", "Overview" or "Job title".
   */
  const JOB_TITLE_CHROME_PATTERN =
    /^(?:job\s*titles?|titles?|job\s*names?|names?|roles?|positions?|overview|summary|details?|status|posted|active|inactive|draft|closed|paused|expired|archived|on\s*hold|open|linkedin)$/i;

  /**
   * A line that counts something the page is showing. Never a job title.
   *
   * THE LIVE DEFECT (3.14.2), reported with the extension's own job filter in
   * the screenshot: every applicant on a real posting was saved under the job
   * title **"0 notifications total"** — the screen-reader label LinkedIn paints
   * beside the Notifications icon in its global navigation.
   *
   * Two separate failures put it there, and this pattern answers the second:
   *
   *   - The view renders NO tab bar, so `findJobViewHeader` finds fewer than
   *     two tabs, returns null, and the whole heading path is skipped. The
   *     legacy sweep runs instead, sorts candidates by SHORTEST text and takes
   *     the first line that is not chrome — and LinkedIn's own global header is
   *     not excluded, because `isExcludedContext` refuses a `nav` ANCESTOR and
   *     the global header is the nav's PARENT.
   *   - Nothing could refuse the value once read. It is not one of the exact
   *     chrome words, so `isJobTitleCandidate` said yes; and because it said
   *     yes, `mergeJob`'s narrow repair could not replace it either. The wrong
   *     title was PERMANENT — fill-blanks-only protects a filled value, and
   *     this one was filled. The recruiter's only route back was to clear the
   *     job.
   *
   * So a counted line is refused by shape, which also makes every job already
   * stored under one repairable by the merge on the next read.
   *
   * Every branch is anchored on the count itself rather than on "contains the
   * word", because rule 1 says a wrong value is worse than a blank one and the
   * inverse is just as true — a shape test that is too eager refuses somebody's
   * real job. "Notifications Engineer", "Views Analyst" and "Message Delivery
   * Lead" all still pass; no job is called "0 notifications total" or
   * "649 applicants".
   *
   * FOUND WHILE PROVING THAT, AND DELIBERATELY NOT FIXED HERE: a job whose
   * title BEGINS with "Applicant" is already refused, and has been since
   * 3.7.23 — `JOB_VIEW_TAB_PATTERN` is `^applicants?\b`, so
   * "Applicant Support Specialist" reads as the Applicants tab and
   * `isJobTitleCandidate` answers false. It is a real rule-1 defect (that job
   * saves blank) but it is NOT this defect, and the repair is a tightening of
   * the pattern that decides which element on the page IS the header — load
   * bearing for every layout that currently works. It wants its own task and
   * its own fixtures rather than a drive-by here.
   */
  const CHROME_COUNT_LINE_PATTERN =
    /^\d[\d,]*\s+(?:applicants?|notifications?|messages?|results?|views?|new|unread)\b|^applicants?\s*\(\s*\d/i;

  /**
   * The applicant panel's own heading: "Ashwin Anil's application".
   *
   * THE SECOND LIVE DEFECT (3.14.3). 3.14.2 let a view with no tab bar read the
   * headings the page painted, fenced against the list and the panel — and the
   * fences did not hold: the next run saved every applicant under
   * **"Ashwin Anil's application"**, the heading of the panel beside the list.
   *
   * The lesson is the one rule 1 keeps teaching. A fence is a guess about where
   * an element sits; this is a statement about what the VALUE is. No job is
   * called "somebody's application", on any layout, however the page is built,
   * so it is refused by name rather than by position — and being refused, a job
   * already stored under it repairs itself through `mergeJob` on the next read.
   *
   * Both apostrophes, because LinkedIn renders the curly one.
   */
  const APPLICATION_HEADING_PATTERN = /(?:['’]s|s['’])\s+application$/i;

  /**
   * The job card's own controls, which sit in the card beside the title.
   *
   * The title is read by walking up from one of these to the card that holds it
   * (see `findJobCard`), so the walk passes THROUGH the control's own label on
   * the way — and "Manage job" is not a status word, not a tab and not a count,
   * so nothing above refused it. Whole-string and anchored: a job called
   * "Manage Director" or "Editor" is untouched.
   */
  const JOB_CARD_ACTION_PATTERN =
    /^(?:manage|edit|view|share|promote|close|reopen|repost|preview)\s+(?:this\s+)?job(?:\s+post(?:ing)?)?$/i;

  /**
   * Could this line be somebody's job title at all?
   *
   * One rule, so the reader, the container walk, the re-read and the merge all
   * agree on what "the job has a title" means. A tab label is not a title, a
   * status word is not a title, a caption naming the field is not the field,
   * a count of the applicants is not the job (3.14.2), and — since 3.14.3 — an
   * applicant's own application is not the job they applied to.
   */
  function isJobTitleCandidate(value) {
    const line = cleanText(value);
    if (!line || line.length > 160) return false;
    if (isJobViewTabLabel(line)) return false;
    if (CHROME_COUNT_LINE_PATTERN.test(line)) return false;
    if (APPLICATION_HEADING_PATTERN.test(line)) return false;
    if (JOB_CARD_ACTION_PATTERN.test(line)) return false;
    return !JOB_TITLE_CHROME_PATTERN.test(line);
  }

  /**
   * The job's own title, out of the header bar's text.
   *
   * One definition, used by `parseJobHeader` to read the title and by the
   * content script to decide whether a candidate container even holds one —
   * because the smallest element carrying the tabs is often the tab list alone,
   * which renders every tab and no title at all.
   *
   * Since 3.14.1 it skips chrome rather than only tabs, so it walks PAST an
   * `ACTIVE` eyebrow to the line beneath it instead of stopping on it. That is
   * a tightening of the same rule, never a loosening: every line it accepted
   * before it still accepts, minus the exact words above.
   */
  function jobTitleFromHeader(text) {
    return toLines(text).find((line) => isJobTitleCandidate(line)) || "";
  }

  /**
   * The title out of the headings the page painted, which is the better signal.
   *
   * Rule 7 asks for structure over position, and a job view states its job in a
   * heading — so an `<h1>` is worth more than "whichever line sorted first".
   * The line scan above stays exactly where it was, as the fallback for a bar
   * that renders no heading at all; this only gets to answer first.
   */
  function jobTitleFromHeadings(headings) {
    const list = Array.isArray(headings) ? headings : [headings];
    for (const entry of list) {
      const line = cleanText(entry);
      if (isJobTitleCandidate(line)) return line;
    }
    return "";
  }

  function parseJobHeader({ text = "", title = "", url = "", headings = [] } = {}) {
    const lines = toLines(text);
    const context = parseHiringContext(url);
    const countLine = lines.find((line) => APPLICANT_COUNT_PATTERN.test(line)) || cleanText(text);
    const countMatch = APPLICANT_COUNT_PATTERN.exec(countLine);
    // The heading the page painted, then the first line that is not chrome.
    // `headings` defaults to empty, so a caller that does not pass one gets the
    // line scan and nothing else — exactly what every caller got before 3.14.1.
    const heading = jobTitleFromHeadings(headings) || jobTitleFromHeader(text);

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

  /**
   * Merge a later, more hydrated read of the job over an earlier one.
   *
   * Fill-blanks-only, and that stays true for every field: a filled value is
   * never replaced by another filled value, because "a later read enriches
   * rather than overwrites" (rule 4) is what keeps a half-rendered pass from
   * undoing a good one.
   *
   * ONE NARROW REPAIR, added in 3.14.1 for `title` alone. A job saved under
   * `Overview` or `ACTIVE` was permanent: the stored value is filled, so no
   * later read could replace it, in the accumulator or in `saveJob` — the
   * recruiter's only route back was to clear the job. The repair fires ONLY
   * when what is stored is chrome by the exact-word list above AND what is
   * arriving is a real candidate, so it can never overwrite a genuine title
   * with another genuine title. That is the fill-blanks rule applied to a value
   * that was never a title in the first place, not an exception to it.
   */
  function mergeJob(existing, incoming) {
    const merged = { ...(existing || {}) };
    for (const [key, value] of Object.entries(incoming || {})) {
      if (value === null || value === undefined || value === "") continue;
      if (merged[key] === null || merged[key] === undefined || merged[key] === "") merged[key] = value;
      else if (key === "title" && !isJobTitleCandidate(merged[key]) && isJobTitleCandidate(value)) merged[key] = value;
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

  /**
   * What a **portrait** leaves welded to the end of a name.
   *
   * THE LIVE DEFECT: applicants were saved as **"Komal Sharma graphic"** and
   * **"Harshita Singh graphic"**. LinkedIn's applicant portrait carries its
   * accessible name as `alt="<name> graphic"`, and `findApplicantName` offers
   * that alt text as the `portrait-alt` candidate — which stripped a *leading*
   * `photo of` / `picture of` and nothing from the end.
   *
   * Fixed here rather than at the portrait, deliberately: the same artifact
   * reaches the name through the profile link's `aria-label` too, so stripping
   * it at one of the two sources would leave the other producing a second
   * spelling of the same person. **That is not only cosmetic** — `applicantId`
   * hashes the name, so "Komal Sharma" and "Komal Sharma graphic" are two
   * different records for one applicant, which is exactly the duplicate rows
   * that were reported alongside it.
   *
   * A word ending a name is only ever an artifact when something precedes it,
   * and none of these is a surname; a value that is *nothing but* the artifact
   * collapses to "" and is then refused by `isApplicantNameCandidate`, which is
   * the right answer for an image with no name in its alt text at all.
   */
  const NAME_IMAGE_ARTIFACT_PATTERN =
    /\s*(?:['’]s)?\s*(?:profile\s+)?(?:graphic|image|photo|picture|logo|avatar)s?\s*$/i;

  function cleanApplicantName(value) {
    let text = cleanText(String(value ?? "").replace(NAME_NOISE_PATTERN, " "));
    // Both trailing artifacts, in either order and repeated: LinkedIn renders
    // "Komal Sharma graphic", "Mahak Ayani · 2nd", and sometimes both at once.
    // Bounded rather than `while`, because a pattern that could ever match its
    // own output must not be able to spin.
    for (let pass = 0; pass < 4; pass += 1) {
      const stripped = text.replace(DEGREE_BADGE_PATTERN, "").replace(NAME_IMAGE_ARTIFACT_PATTERN, "").trim();
      if (stripped === text) break;
      text = stripped;
    }
    return text;
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

  // ------------------------------------------------ choosing between readers
  //
  // The guide's Phase 3 asks that each reader "return a value, its source and
  // confidence". `chooseApplicantName` was already that shape for exactly one
  // field, and generalising it is what lets a second layout add a *source*
  // rather than a second copy of a reader.

  /**
   * How a value was learned.
   *
   * Every kind here is answerable from the ACT of reading — never from a class
   * name and never from an index, which is what makes it survive a redesign
   * (rule 7). It is a statement about the evidence, not about the markup.
   */
  const FIELD_EVIDENCE = Object.freeze({
    /** Two independent readings agree, or the platform's own prose agrees. */
    CORROBORATED: "corroborated",
    /** An href — `mailto:`, `tel:`, `/in/`. The address IS the datum. */
    LINK: "link",
    /** An explicit Label → value pairing the page itself rendered. */
    LABELLED: "labelled",
    /** Read inside a container whose heading resolved to a section key. */
    SECTION: "section",
    /** The element was marked up as a heading. */
    HEADING: "heading",
    /** Computed from another accepted field. */
    DERIVED: "derived",
    /** A line of rendered text, in a position we expected it. */
    TEXT: "text"
  });

  const EVIDENCE_CONFIDENCE = Object.freeze({
    corroborated: 1, link: 0.9, labelled: 0.8, section: 0.65, heading: 0.5, derived: 0.4, text: 0.25
  });

  const EVIDENCE_ORDER = Object.freeze(["text", "derived", "heading", "section", "labelled", "link", "corroborated"]);

  /** One step up the evidence ladder, never past corroborated. */
  function strongerEvidence(evidence) {
    const at = EVIDENCE_ORDER.indexOf(evidence);
    return at < 0 ? FIELD_EVIDENCE.TEXT : EVIDENCE_ORDER[Math.min(at + 1, EVIDENCE_ORDER.length - 1)];
  }

  /**
   * Choose one value for a field from everything that claims to be it.
   *
   * `candidates` are `{ value, source, evidence }` **in the caller's preference
   * order**, and that order is the tie-break — so a fallback appended for a
   * second layout sits behind the working reader by construction and can only
   * win where the working reader found nothing or found something weaker.
   *
   * The arbitration, in order:
   *   1. `normalize` and `accept` filter; every refusal is recorded, because
   *      "the panel showed it and we threw it away" is the one thing a
   *      diagnostics report cannot reconstruct afterwards.
   *   2. A `corroboration` a survivor matches wins outright.
   *   3. A `corroboration` nothing matches is used on its own — trust the
   *      platform's own prose over something we guessed at.
   *   4. Otherwise the strongest surviving evidence, ties broken by caller order.
   *   5. Two survivors from DIFFERENT sources that normalize equal are
   *      corroboration in miniature, and move one step up the ladder.
   *   6. Below `minConfidence`, the answer is "" — rule 1, a blank beats a guess.
   */
  function resolveField(candidates = [], policy = {}) {
    const normalize = typeof policy.normalize === "function" ? policy.normalize : cleanText;
    const accept = typeof policy.accept === "function" ? policy.accept : (value) => Boolean(value);
    const minConfidence = Number(policy.minConfidence) || 0;
    const none = { value: "", source: "", evidence: "", confidence: 0, corroborated: false, agreed: 0, considered: 0, rejected: [] };

    const list = Array.isArray(candidates) ? candidates : [];
    const rejected = [];
    const usable = [];
    for (const entry of list) {
      const value = normalize(entry?.value);
      const evidence = EVIDENCE_ORDER.includes(entry?.evidence) ? entry.evidence : FIELD_EVIDENCE.TEXT;
      if (!value) continue;
      if (!accept(value, entry)) {
        if (rejected.length < 8) rejected.push({ value, source: entry?.source || "", reason: "refused" });
        continue;
      }
      usable.push({ value, source: entry?.source || "", evidence, order: usable.length + rejected.length });
    }

    const base = { considered: list.length, rejected };
    const agreed = normalize(policy.corroboration || "");
    if (agreed) {
      const match = usable.find((entry) => entry.value.toLowerCase() === agreed.toLowerCase());
      if (match) {
        return { ...base, value: match.value, source: match.source, evidence: FIELD_EVIDENCE.CORROBORATED, confidence: 1, corroborated: true, agreed: 1 };
      }
      return {
        ...base,
        value: agreed,
        source: policy.corroborationSource || "corroboration",
        evidence: FIELD_EVIDENCE.CORROBORATED,
        confidence: 1,
        corroborated: true,
        agreed: 0
      };
    }
    if (!usable.length) return { ...none, ...base };

    let best = usable[0];
    for (const entry of usable) {
      if (EVIDENCE_CONFIDENCE[entry.evidence] > EVIDENCE_CONFIDENCE[best.evidence]) best = entry;
    }
    const seconding = usable.filter(
      (entry) => entry !== best && entry.source !== best.source && entry.value.toLowerCase() === best.value.toLowerCase()
    );
    const evidence = seconding.length ? strongerEvidence(best.evidence) : best.evidence;
    const confidence = EVIDENCE_CONFIDENCE[evidence] || 0;
    if (confidence < minConfidence) return { ...none, ...base };
    return {
      ...base,
      value: best.value,
      source: best.source,
      evidence,
      confidence,
      corroborated: evidence === FIELD_EVIDENCE.CORROBORATED,
      agreed: seconding.length
    };
  }

  /**
   * The plain string out of a reader result.
   *
   * Wired into `addHeader` and `addName` rather than left as a convention,
   * because `cleanText({ value: "x" })` is `String(value ?? "")` and returns
   * `"[object Object]"` — a leaked wrapper would produce a garbage record rather
   * than an empty one. One unwrap, at the accumulator door. It is also why
   * `source` and `confidence` can never reach the schema: nothing but the value
   * gets past this line.
   */
  function fieldValue(result) {
    if (result === null || result === undefined) return "";
    if (typeof result === "object") return cleanText(result.value);
    return cleanText(result);
  }

  // ------------------------------------------------------- which layout is it
  //
  // The guide's Phase 4: "detect only meaningful layout differences", from
  // several stable features rather than one generated class, and — stated as
  // the hard constraint — "the detected UI may only decide which reader runs
  // first. It must not change the applicant schema, workflow, save format,
  // pagination, or current UI behaviour."
  //
  // The design that makes that constraint mechanical rather than aspirational:
  // this function returns a PERMUTATION of a fixed list and nothing else. It
  // cannot return a value, a selector, a threshold or a field, because there is
  // nowhere in its return shape to put one.

  /**
   * The readers whose order is fixed, and why.
   *
   * `job` seeds the record. `qualifications` must precede `header` because the
   * platform's own verdict sentences are what the name is corroborated against,
   * and reading the header first leaves the very first snapshot with no arbiter
   * at all. No layout may reorder these three.
   */
  const APPLICANT_READER_PREFIX = Object.freeze(["job", "qualifications", "header"]);

  /**
   * The readers whose order genuinely does not matter.
   *
   * Each writes to its own map in the accumulator, none reads another's output,
   * and `buildApplicantRecord` folds them all at the end — which is asserted
   * exhaustively over all 120 orders rather than argued.
   */
  const APPLICANT_READER_TAIL = Object.freeze(["screening", "experience", "education", "skills", "contacts", "labelled"]);

  const APPLICANT_READERS = Object.freeze([...APPLICANT_READER_PREFIX, ...APPLICANT_READER_TAIL]);

  const APPLICANT_LAYOUT = Object.freeze({
    /** The recruiter screen this extension was written against. */
    CURRENT: "current",
    /** Something that positively asserts a different shape. */
    ALTERNATIVE: "alternative",
    /** Anything else — and the safe default, deliberately. */
    GENERIC: "generic"
  });

  /**
   * Which layout the panel is, from signals that are all content.
   *
   * `signals` is a plain object the adapter measured once; nothing here touches
   * a DOM, so the whole decision is unit-testable. Every signal is derived from
   * rendered text, resolved section keys, accessible labels or link counts —
   * never from a generated class name (rule 7).
   *
   * **"generic" is the safe default, and it is safe for a structural reason.**
   * The generic order runs the labelled reader earlier than "current" does and
   * runs every reader either way; `addHeader` is first-wins and `addKeyed` fills
   * blanks only. So an unrecognised layout can only produce the same record or a
   * fuller one — never a worse one. An unrecognised layout is not a failure
   * mode, which is the entire point.
   */
  function describeApplicantLayout(signals = {}) {
    const input = signals && typeof signals === "object" ? signals : {};
    const sectionKeys = new Set((Array.isArray(input.sectionKeys) ? input.sectionKeys : []).filter(Boolean));
    const labelKeys = new Set((Array.isArray(input.labelKeys) ? input.labelKeys : []).filter(Boolean));
    const contactSurface = cleanText(input.contactSurface).toLowerCase();
    const topCardShape = cleanText(input.topCardShape).toLowerCase();

    const matched = [];
    // The five features of the screen this extension reads today. Three of five
    // is the bar, because a slow panel routinely has not hydrated all of them.
    if (sectionKeys.has("qualifications") || Number(input.qualificationSubheadings) >= 2) matched.push("qualifications-card");
    if (sectionKeys.has("screening")) matched.push("screening-section");
    if (["experience", "education", "skills"].filter((key) => sectionKeys.has(key)).length >= 2) matched.push("profile-sections");
    if (topCardShape === "name-headline-location") matched.push("stacked-top-card");
    if (contactSurface === "modal" || (input.hasContactControl && !contactSurface)) matched.push("contact-modal");

    // A contradiction is a signal POSITIVELY asserting the other shape — never
    // merely the absence of one, which is what a half-hydrated panel looks like.
    const contradicted = [];
    if (topCardShape === "labelled") contradicted.push("labelled-top-card");
    if (["drawer", "popover", "inline", "expanded"].includes(contactSurface)) contradicted.push(`contact-${contactSurface}`);
    if (labelKeys.has("currentCompany") || labelKeys.has("currentRole")) contradicted.push("labelled-employment");

    let layout = APPLICANT_LAYOUT.GENERIC;
    if (matched.length >= 3 && !contradicted.length) layout = APPLICANT_LAYOUT.CURRENT;
    else if (contradicted.length) layout = APPLICANT_LAYOUT.ALTERNATIVE;

    // The ONLY output. A permutation of `APPLICANT_READERS`, with the prefix
    // frozen. "current" leaves the labelled reader last, where it costs a
    // bounded sweep and finds nothing; anything else promotes it, so a layout
    // that states its fields outright has them before the derivation runs.
    const tail = layout === APPLICANT_LAYOUT.CURRENT
      ? [...APPLICANT_READER_TAIL]
      : ["labelled", ...APPLICANT_READER_TAIL.filter((reader) => reader !== "labelled")];

    return { layout, matched, contradicted, readerOrder: Object.freeze([...APPLICANT_READER_PREFIX, ...tail]) };
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
   *
   * Expressed through `resolveField` since 3.9.0 and unchanged by it: name
   * candidates carry no `evidence`, so every one defaults to the same kind, the
   * strongest-evidence step is a no-op, and the tie-break is caller order —
   * which is exactly first-wins, which is what this has always been.
   */
  function chooseApplicantName(candidates = [], corroboration = "") {
    const chosen = resolveField(candidates, {
      normalize: cleanApplicantName,
      accept: isApplicantNameCandidate,
      corroboration,
      corroborationSource: "explanations"
    });
    return { name: chosen.value, source: chosen.source, corroborated: chosen.corroborated };
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

  /**
   * A place, as the panel actually renders one.
   *
   * THE LIVE DEFECT (3.7.24): every applicant's location was saved as
   * **"Filter and sort"** — a button in the *list* column. `location` was
   * `lines[2]`, the third line of the header text and nothing else, so whatever
   * landed in that position became the location. That is the array-position
   * guessing rule 7 forbids, and it is the same class of mistake that once saved
   * six people as "Applicants" by taking the first line as the name; the answer
   * then was a rule about what a name IS, and this is the same answer.
   *
   * "City, Region, Country" as the panel writes it — two to four comma-separated
   * parts with no digits, no `@`, no `|` and no quotes — or a "…Area"/"…Region"
   * phrase, which LinkedIn renders without commas. A line that does not look
   * like a place leaves the field **empty** rather than filling it with the line
   * that happened to be there (rule 1).
   */
  const APPLICANT_LOCATION_PATTERN =
    /^[^,\d@|"'()]{2,60}(?:,\s*[^,\d@|"'()]{2,60}){1,3}$|^[^,\d@|"'()]{2,60}\s(?:area|region)$/i;

  function looksLikeApplicantLocation(value) {
    const text = cleanText(value);
    if (!text || text.length > 120) return false;
    // The chrome list already knows "Filter and sort" — the location simply
    // never asked it. Reused rather than copied, so one list stays one list.
    if (NAME_CHROME_PATTERN.test(text) || NAME_CONTROL_PHRASE_PATTERN.test(text)) return false;
    if (APPLIED_PATTERN.test(text) || CONTACTED_PATTERN.test(text)) return false;
    return APPLICANT_LOCATION_PATTERN.test(text);
  }

  /**
   * Is this line ENTIRELY the label of a control?
   *
   * The click denylist knows "Message", "Connect", "Share", "Hire" and the rest,
   * and `NAME_CHROME_PATTERN` deliberately does not — they are two different
   * lists answering two different questions. A wide panel can still put a button
   * label where a field belongs, so the denylist is worth asking here too.
   *
   * **Whole line only, and that is the whole care taken.** The denylist is
   * anchored on word boundaries because it judges a control's label; asking it
   * that way of a VALUE would refuse "Hire Digital" and "Offerpad", which are
   * real employers. A lost employer is as wrong as an invented one (rule 6 cuts
   * both ways), and no employer is called exactly "Hire".
   */
  function isWholeLineControlLabel(value) {
    const text = cleanText(value);
    if (!text) return false;
    const match = FORBIDDEN_APPLICANT_CONTROL_PATTERN.exec(text);
    return Boolean(match) && cleanText(match[0]).toLowerCase() === text.toLowerCase();
  }

  /**
   * A headline, as a panel that renders one writes it.
   *
   * `parseApplicantHeader` reads the headline as `lines[1]`, unconditionally,
   * and that is the last positional guess left in this file. It is the same
   * defect class as the old `location = lines[2]`, whose fix — documented
   * immediately above `APPLICANT_LOCATION_PATTERN` — was a rule about what a
   * location IS rather than a better index. This is that same answer.
   *
   * Deliberately a **refusal** rule rather than an acceptance one. A headline is
   * free text and very nearly anything can be one, so an acceptance rule would
   * either be useless or would drop real headlines. What it refuses is the
   * handful of things that are demonstrably NOT a headline and that a layout
   * which drops the headline puts in that position instead: page chrome, the
   * application timeline, a bare status word, a section title that leaked into
   * the window, a contact detail, and the name repeated.
   *
   * Note what is NOT here: "it looks like a location". A real headline can be
   * three comma-separated words ("Legal, Compliance, Governance") and refusing
   * those would cost a field that is right far more often than it is wrong. The
   * one reading under which `lines[1]` genuinely IS the location — the layout
   * that renders no headline at all — is decided inside `parseApplicantHeader`,
   * where the resolved location is known and the two can be compared.
   */
  function looksLikeApplicantHeadline(value, { name = "" } = {}) {
    const text = cleanText(value);
    if (!text || text.length > 220) return false;
    // The chrome list already knows "Filter and sort" and "Shortlist" — reused
    // rather than copied, exactly as `looksLikeApplicantLocation` reuses it.
    if (NAME_CHROME_PATTERN.test(text) || NAME_CONTROL_PHRASE_PATTERN.test(text)) return false;
    // A button label, whole and entire — a wide panel can still put one here.
    if (isWholeLineControlLabel(text)) return false;
    // "Applied 13mo ago • Contacted 10mo ago" is the timeline, not a headline.
    if (APPLIED_PATTERN.test(text) || CONTACTED_PATTERN.test(text)) return false;
    // A bare verdict word. `APPLICATION_STATUS_PATTERN` is unanchored on purpose
    // — a real headline may well contain "New" or "Offer" — so only a line that
    // is ENTIRELY a status is refused.
    const status = APPLICATION_STATUS_PATTERN.exec(text);
    if (status && cleanText(status[0]).toLowerCase() === text.toLowerCase()) return false;
    // A section title that reached the window because the panel resolved wide.
    if (isSectionTitleLine(text)) return false;
    // A contact detail is a contact detail (rule 2 in spirit: it has a home).
    if (/@/.test(text) || /^\+?[\d\s()\-.]{7,}$/.test(text) || /^https?:\/\//i.test(text)) return false;
    // Digits and punctuation alone say nothing about anybody.
    if (!/[a-z]/i.test(text)) return false;
    // A two-line name rendering puts the name here again.
    const person = cleanApplicantName(name);
    if (person && cleanApplicantName(text).toLowerCase() === person.toLowerCase()) return false;
    return true;
  }

  /**
   * Could this be the applicant's employer?
   *
   * The guide states it as a prohibition — "do not use the hiring company,
   * recruiter company, or school as the applicant's current company" — and this
   * is that prohibition made executable. All three refusals reuse rules that
   * already exist rather than inventing a fourth kind of test.
   */
  function isEmployerCandidate(value, { hiringCompany = "" } = {}) {
    const text = cleanText(value);
    if (!text || text.length > 120) return false;
    if (isSectionTitleLine(text)) return false;
    if (NAME_CHROME_PATTERN.test(text) || NAME_CONTROL_PHRASE_PATTERN.test(text)) return false;
    if (isWholeLineControlLabel(text)) return false;
    // A school is not an employer. `INSTITUTION_PATTERN` is the education
    // reader's own test, so one list stays one list.
    if (INSTITUTION_PATTERN.test(text) || SPELLED_DEGREE_PATTERN.test(text)) return false;
    // The company doing the hiring is on every applicant's screen and belongs to
    // none of them.
    const hiring = cleanText(hiringCompany);
    if (hiring && text.toLowerCase() === hiring.toLowerCase()) return false;
    return true;
  }

  /**
   * Could this be the applicant's current role?
   *
   * The guide again: "do not use the role being applied for as the current role
   * unless LinkedIn clearly labels it as current employment". The job title is
   * rendered on every applicant's screen — `readJob` already puts it on the
   * record — so it is the one string that is guaranteed to be wrong here.
   */
  function isCurrentRoleCandidate(value, { jobTitle = "" } = {}) {
    const text = cleanText(value);
    if (!text || text.length > 120) return false;
    if (isSectionTitleLine(text)) return false;
    if (NAME_CHROME_PATTERN.test(text) || NAME_CONTROL_PHRASE_PATTERN.test(text)) return false;
    if (isWholeLineControlLabel(text)) return false;
    const applied = cleanText(jobTitle);
    if (applied && text.toLowerCase() === applied.toLowerCase()) return false;
    return true;
  }

  // -------------------------------------------- fields the page itself labels
  //
  // The guide's chain for the current role is "explicit current-role field →
  // top-card headline → applicant summary → latest valid Experience title", and
  // only the last link has ever existed. `currentRole`, `currentCompany` and
  // `totalExperience` have no DOM reader at all: all three are derived from the
  // Experience entries, so a layout that words the Experience heading
  // differently empties three columns at once.
  //
  // A reader keyed on a rendered LABEL is the fallback that costs nothing and
  // assumes nothing: it fires on any layout that renders the label and is
  // completely inert on any layout that does not — including the one that works
  // today, which labels none of these. That is the difference between a
  // fallback and a rewrite.
  //
  // Deliberately narrow. A loose label list is how "Experience" the section
  // heading becomes "experience" the labelled field, and a wrong value is worse
  // than a blank one (rule 1).

  const APPLICANT_FIELD_LABEL_PATTERNS = Object.freeze([
    { field: "currentRole", pattern: /^current\s+(?:role|title|position|job\s*title|designation)$/i },
    { field: "currentCompany", pattern: /^current\s+(?:company|employer|organisation|organization)$/i },
    { field: "totalExperience", pattern: /^(?:total\s+(?:work\s+)?experience|years?\s+of\s+experience|work\s+experience\s*\(years\))$/i },
    { field: "headline", pattern: /^(?:headline|professional\s+headline)$/i },
    { field: "location", pattern: /^(?:location|based\s+in|city)$/i },
    { field: "applicationStatus", pattern: /^(?:application\s+)?status$/i }
  ]);

  /** Every label the labelled reader answers to, for a caller that sweeps by name. */
  const APPLICANT_LABELLED_FIELDS = Object.freeze(
    APPLICANT_FIELD_LABEL_PATTERNS.map((entry) => entry.field).filter((field, index, all) => all.indexOf(field) === index)
  );

  /**
   * Which record field, if any, this rendered label names.
   *
   * The label is normalised the way a section title is — a trailing colon is how
   * a label is usually rendered — and anything else is "". Never a guess.
   */
  function applicantFieldForLabel(text) {
    const value = normalizeSectionTitle(text);
    if (!value) return "";
    return APPLICANT_FIELD_LABEL_PATTERNS.find((entry) => entry.pattern.test(value))?.field || "";
  }

  /**
   * A stated length of service, as a page that states one writes it.
   *
   * `totalExperience` is the one labelled field where a wrong value is silently
   * plausible — it lands in a column of years beside numbers the extension
   * computed itself — so it is gated on actually looking like a duration rather
   * than merely sitting under the right label. `orNull(explicit) || derived`
   * means a value accepted here OUTRANKS the computed one, so the gate is tight.
   */
  function looksLikeTotalExperience(value) {
    const text = cleanText(value);
    if (!text || text.length > 40) return false;
    return /^\d{1,2}(?:\.\d)?\+?\s*(?:years?|yrs?)(?:\s+\d{1,2}\s*(?:months?|mos?))?$/i.test(text) ||
      /^\d{1,2}\s*(?:years?|yrs?)\s+(?:and\s+)?\d{1,2}\s*(?:months?|mos?)$/i.test(text);
  }

  /**
   * @param {{ text?: string, name?: string }} input `name` is the name the
   *   adapter already resolved by policy. Optional and backwards compatible —
   *   every existing `{ text }` call keeps working — and it is what lets the
   *   headline refuse a second rendering of the name.
   */
  function parseApplicantHeader({ text = "", name = "" } = {}) {
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

    // The location sits between the headline and the application timeline, and
    // is chosen by looking like a place rather than by its index. Bounded above
    // by the timeline because the location always precedes it, so a panel that
    // resolved too wide cannot reach past it for something place-shaped.
    const appliedAt = lines.findIndex((line) => APPLIED_PATTERN.test(line));
    const beforeTimeline = lines.slice(2, appliedAt > 0 ? appliedAt : lines.length);

    const chosenName = cleanText(name) || (isApplicantNameCandidate(first) ? first : "");
    const location = cleanText(beforeTimeline.find(looksLikeApplicantLocation) || "");

    // The headline: still `lines[1]`, still first, and returned exactly as
    // before whenever it passes. What changed is that it now has to BE one.
    //
    // A line that fails yields "" rather than the next plausible line, and that
    // is deliberate: falling through would re-invent the position guess one line
    // down. `accumulator.addHeader` is first-wins per field, so a later labelled
    // read still fills it — a blank here is an opening, not a loss (rule 1).
    const second = lines[1] ? cleanText(lines[1]) : "";
    // The one reading under which `lines[1]` genuinely is the location: a layout
    // that renders no headline at all, so the place moves up a line and the
    // location search below it finds nothing. Both fields are then left blank
    // rather than the location being stored as the headline — which is the
    // shape of the 3.7.24 defect, one field over.
    const headlineIsTheLocation = Boolean(second) && !location && looksLikeApplicantLocation(second);

    return {
      name: isApplicantNameCandidate(first) ? first : "",
      headline: !headlineIsTheLocation && looksLikeApplicantHeadline(second, { name: chosenName }) ? second : "",
      location,
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
   * LinkedIn is still virus-scanning this attachment, so there is nothing to read
   * yet (3.9.1).
   *
   * THE LIVE SYMPTOM. On a run the recruiter reported that the first two
   * applicants downloaded and every one after them did not; the resume card had
   * been replaced by "Scanning resume for viruses. Please refresh the page now."
   * Doing it by hand on the same account opened the file normally.
   *
   * Nothing in this extension knew that string, so the step behaved as if the
   * page had simply not rendered an address: it waited out the document timeout
   * and saved `link_only` with reason `no-document-url`, which says nothing about
   * what actually happened and reads exactly like a layout it cannot parse.
   *
   * The state is TRANSIENT and the recovery is to wait, not to press anything —
   * so what this pattern buys is the ability to tell "not ready yet" from "not
   * there", and those two want opposite handling: one is retried, the other is
   * recorded as absent.
   *
   * Matched on the message rather than on any container, because the card that
   * carries it is a plain block with no role and no stable name.
   */
  const RESUME_SCANNING_PATTERN =
    /\b(?:scanning\s+(?:this\s+|the\s+)?(?:resume|résumé|cv|documents?|file|attachment)|scanning\s+for\s+(?:a\s+)?virus(?:es)?|virus\s+scan(?:ning)?\s+in\s+progress|being\s+scanned)\b/i;

  /**
   * Does this text say the attachment is still being scanned?
   *
   * A plain predicate rather than a bare regex export so the adapter cannot
   * accidentally test it against a whole panel and match an applicant whose own
   * CV happens to discuss antivirus work. The caller scopes it; this only
   * decides.
   */
  function isResumeScanningText(value) {
    const text = cleanText(value);
    if (!text) return false;
    return RESUME_SCANNING_PATTERN.test(text);
  }

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
  /**
   * What a media type is actually called on disk.
   *
   * **A closed table, and it has to be one.** The line this replaces did the
   * job by string-slicing `^[a-z]+/` off the front of the type, which is right
   * for `application/pdf` by luck and wrong for everything else: it turns
   * `application/msword` into `.msword`, and the single test that ever covered
   * it used the one input that works. The docx type slices to
   * `vnd.openxmlformats-...`, and `application/pdf; charset=binary` slices to
   * nothing at all because the parameter defeats the length guard.
   *
   * So a type this table does not know returns "", and the file keeps no
   * suffix. That is rule 1 applied to a name written on the recruiter's disk:
   * a `.pdf` that is really a `.docx` is worse than no suffix. Notably absent
   * and deliberately so: `application/octet-stream`, which states only that
   * the server does not know either, and every `text/html` variant, which on
   * this CDN means an error page rather than a CV.
   */
  /**
   * The docx media type, split across a concatenation on purpose.
   *
   * It ends in the bare word this file's own tripwire greps for - the check
   * that nothing in the pure core may touch the DOM - and that check cannot
   * tell a MIME type from a reference to the global. Splitting the literal is
   * the same trade `RESUME_SCANNING_PATTERN` made in 3.9.1 when it needed the
   * same word: keep the check strict and pay for it here, rather than weaken
   * the one assertion that keeps this file pure.
   */
  const DOCX_MEDIA_TYPE =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.docum" + "ent";

  const RESUME_MIME_EXTENSIONS = Object.freeze({
    "application/pdf": "pdf",
    "application/x-pdf": "pdf",
    "application/msword": "doc",
    [DOCX_MEDIA_TYPE]: "docx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/rtf": "rtf",
    "text/rtf": "rtf",
    "text/plain": "txt"
  });

  /** The extension a media type names, or "" when it names none we trust. */
  function resumeExtensionForMediaType(value) {
    // Parameters first: `application/pdf; charset=binary` is still a PDF.
    const mime = cleanText(value).toLowerCase().split(";")[0].trim();
    return RESUME_MIME_EXTENSIONS[mime] || "";
  }

  function resumeFileExtension(fileType, filename, url) {
    // A media type is answered from the table, never sliced.
    const fromMedia = resumeExtensionForMediaType(fileType);
    if (fromMedia) return fromMedia;
    const raw = cleanText(fileType).toLowerCase();
    // A bare token - "pdf", ".docx" - is still taken, for the callers that
    // read one out of a filename or a viewer's own label.
    if (!raw.includes("/")) {
      const direct = raw.replace(/^\./, "");
      if (/^[a-z0-9]{1,8}$/.test(direct)) return direct;
    }
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
   * The applicant's own single-valued fields.
   *
   * Kept in step with `normalizeApplicantRecord` by hand, deliberately: this is
   * the list a merge must protect field by field, and deriving it from a sample
   * record would silently include whatever a future field turns out to be. The
   * lists, `contact` and `resume` are merged by their own rules and are not
   * here; `name` is, because a re-read that failed to resolve a name must not
   * blank the one already stored.
   */
  const APPLICANT_SCALAR_FIELDS = Object.freeze([
    "name", "profileUrl", "headline", "location",
    "currentRole", "currentCompany", "totalExperience",
    "appliedAt", "contactedAt", "applicationStatus"
  ]);

  /**
   * A value that is actually there, preferring the newer one.
   *
   * The same three-way test `mergeJob` has always applied — `null`, `undefined`
   * and `""` are all "the page did not show it" — lifted out so the applicant's
   * own fields get it too. `false` and `0` are values and are kept.
   */
  function preferFilled(next, previous) {
    const missing = (value) => value === null || value === undefined || value === "";
    return missing(next) ? previous : next;
  }

  /**
   * Merge a fresh collection over a stored record.
   *
   * Merge-only for the lists, exactly like the profile accumulator, because a
   * panel that was collapsed on one visit and expanded on the next must add to
   * the record rather than replace it. A resume that was already downloaded
   * keeps its filename and status — the point of the dedupe is that the second
   * visit does not download it again and does not forget that it has it.
   *
   * **THE DEFECT THIS FIXES: a thinner later read erased a fuller stored one.**
   * The rule has always been stated as "never overwrites a filled field with a
   * blank", and it was true of the lists, of `contact` and of `job` — every one
   * of those is merged field by field. It was NOT true of the applicant's own
   * scalars, which arrived by `...after.applicant`, so `currentRole`,
   * `currentCompany`, `headline`, `location`, `totalExperience`, `appliedAt`,
   * `contactedAt` and `applicationStatus` were replaced by whatever the newer
   * read had — including `null`.
   *
   * That is not hypothetical and it is not only about the list pass. Every
   * re-collection of an applicant already had it: rule 12a pauses a scan the
   * moment the tab is hidden, `revealPanelContent` gives up on a column it
   * cannot move, and a re-mount can leave a section unread — so a second visit
   * that saw less than the first **deleted the difference**, silently, and the
   * record looked exactly like an applicant who simply has no current role. It
   * is the same class of loss `keepDownload` was added to stop for the resume,
   * and the same reason the profile accumulator is merge-only: a later read is
   * more hydrated *usually*, never *reliably*.
   *
   * `resume` gets the same treatment per field rather than `{...before, ...after}`,
   * which had the identical hole — a pass that found no file set `filename: null`
   * over a stored name. `available` is OR-ed because a resume seen once exists,
   * and `downloadStatus` keeps the stored verdict whenever the newer read did not
   * attempt anything, which generalises `keepDownload` rather than replacing it:
   * `not_attempted` is "I did not look", never "there is nothing".
   */
  function mergeApplicantRecord(existing, incoming) {
    if (!existing) return normalizeApplicantRecord(incoming);
    const before = normalizeApplicantRecord(existing);
    const after = normalizeApplicantRecord(incoming);

    const keepDownload =
      before.applicant.resume.downloadStatus === RESUME_STATUS.DOWNLOADED &&
      after.applicant.resume.downloadStatus !== RESUME_STATUS.DOWNLOADED;

    const scalars = {};
    for (const field of APPLICANT_SCALAR_FIELDS) {
      scalars[field] = preferFilled(after.applicant[field], before.applicant[field]);
    }

    const resume = keepDownload ? before.applicant.resume : {
      ...before.applicant.resume,
      ...after.applicant.resume,
      // A resume seen once exists, whatever a later pass managed to see.
      available: Boolean(before.applicant.resume.available || after.applicant.resume.available),
      filename: preferFilled(after.applicant.resume.filename, before.applicant.resume.filename),
      fileType: preferFilled(after.applicant.resume.fileType, before.applicant.resume.fileType),
      pages: preferFilled(after.applicant.resume.pages, before.applicant.resume.pages),
      url: preferFilled(after.applicant.resume.url, before.applicant.resume.url),
      viewerUrl: preferFilled(after.applicant.resume.viewerUrl, before.applicant.resume.viewerUrl),
      localReference: preferFilled(after.applicant.resume.localReference, before.applicant.resume.localReference),
      // "I did not look" must never overwrite "I looked, and here is what I found".
      downloadStatus: after.applicant.resume.downloadStatus === RESUME_STATUS.NOT_ATTEMPTED
        ? before.applicant.resume.downloadStatus
        : after.applicant.resume.downloadStatus
    };

    return normalizeApplicantRecord({
      ...after,
      id: before.id,
      applicationId: preferFilled(after.applicationId, before.applicationId),
      collectedAt: before.collectedAt,
      job: mergeJob(after.job, before.job),
      applicant: {
        ...after.applicant,
        ...scalars,
        contact: {
          email: after.applicant.contact.email || before.applicant.contact.email,
          phone: after.applicant.contact.phone || before.applicant.contact.phone,
          website: after.applicant.contact.website || before.applicant.contact.website,
          other: [...before.applicant.contact.other, ...after.applicant.contact.other]
        },
        resume,
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
      /**
       * The header, first-wins per field.
       *
       * A value may arrive either as a plain string or as a `resolveField`
       * result, and `fieldValue` is what flattens the two — at this door rather
       * than at each of the growing number of call sites, so a reader that
       * forgets to unwrap produces a blank rather than `"[object Object]"`, and
       * so `source`/`confidence` have no route into the record at all.
       */
      addHeader(header) {
        for (const [key, value] of Object.entries(header || {})) {
          // `name` has its own rule — see `addName`.
          if (key === "name") continue;
          const text = fieldValue(value);
          if (text && !cleanText(state.header[key])) state.header[key] = text;
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
        const text = fieldValue(name);
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
      /**
       * The resume, filled field by field — the one accumulator hole.
       *
       * Every other method here fills an empty field and never replaces a
       * filled one: `addKeyed` tests each field for emptiness, `addHeader` is
       * first-wins, `addName` has its one documented exception. `setResume`
       * was a spread, so it obeyed the opposite rule — the LAST writer won,
       * blanks included.
       *
       * That is not theoretical. `collectResume` writes twice by design: the
       * link is saved BEFORE the download is attempted, so a failed download
       * still leaves a usable address, and the second write then carries
       * whatever that attempt produced. It also writes on several early exits.
       * A second write missing `filename`, `pages` or `viewerUrl` erased the
       * first one's, and the record then read as a resume nobody could name.
       *
       * `mergeApplicantRecord` already fixed exactly this shape at the record
       * level and documents why (`{...before, ...after}` had "the identical
       * hole"); this is the same fix one layer earlier, so a single extraction
       * cannot lose what it already found before it is ever stored. `available`
       * is OR-ed for the same reason it is there: a resume seen once exists.
       * `downloadStatus` is the one field a later write MUST be able to move —
       * it is the verdict on the attempt, and `link_only` becoming `downloaded`
       * is the whole point of the second write.
       */
      setResume(resume) {
        if (!resume) return;
        const previous = state.resume || {};
        const merged = { ...previous };
        for (const [field, value] of Object.entries(resume)) {
          if (field === "available") {
            merged.available = Boolean(previous.available || value);
          } else if (field === "downloadStatus") {
            merged.downloadStatus = preferFilled(value, previous.downloadStatus);
          } else {
            merged[field] = preferFilled(value, previous[field]);
          }
        }
        state.resume = merged;
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
        // The three columns that were empty for four consecutive releases, and
        // the reason they could only ever be empty: they are DERIVED from the
        // Experience entries and from nothing else, so a heading wording the
        // section table did not know emptied all three at once, silently.
        //
        // `normalizeApplicantRecord` has always read them as
        // `orNull(explicit) || derived` — the slot for a page that states them
        // outright was there from the start and had no producer, so anything an
        // adapter wrote to `header.currentRole` was dropped here without a
        // sound. Giving them the route makes the guide's own chain
        // ("explicit current-role field → top-card headline → applicant summary
        // → latest valid Experience title") expressible: an explicit value wins,
        // and the derivation stays exactly as it was whenever there is none.
        //
        // A no-op until a reader fills them, which is Phase 3.
        currentRole: header.currentRole || "",
        currentCompany: header.currentCompany || "",
        totalExperience: header.totalExperience || "",
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

  // ----------------------------------------------------------- the list pass
  /**
   * One applicant, from their list row alone — no panel, no click, no opening.
   *
   * The connections surface has always had two separate commands, and the
   * hiring surface now has the same pair for the same reason: **Find All
   * Connections** enumerates the list and saves rows without extracting
   * anything, and **Start Profile Extraction** reads what was found. Reading
   * 665 applicants' panels takes hours; reading 665 rows takes a walk down the
   * list. Wanting the second without paying for the first is not a shortcut, it
   * is a different question — *who applied* rather than *what is on their
   * profile*.
   *
   * **The name and the two ids, and deliberately nothing else.** The row also
   * renders a headline and a location, and taking them would mean deciding that
   * line two is the headline and line three is the location — positional
   * guessing on generated markup, which rule 11 refuses and rule 6 makes worse
   * than an empty field. `cleanApplicantName` still applies, so LinkedIn's
   * `· 2nd` degree badge is stripped exactly as it is everywhere else.
   *
   * **Returns `null` when the row is not a person, and that is the whole of it.**
   * The live defect: the extension saved an applicant called
   * **"Edit qualifications"**. The applicant list renders that link in its own
   * header — *"Here are all applicants to your job. Edit qualifications"* — and
   * its href carries the same `applicationId` the page is on, so it is
   * structurally indistinguishable from the open applicant's row. Nothing about
   * the *link* can catch it.
   *
   * The *text* can, and the policy for it already existed and already knew this
   * exact phrase: `isApplicantNameCandidate()` refuses a control phrase (verb
   * plus at least one more word) because the panel path was saving people under
   * this same label a release earlier. The list pass simply never asked. It asks
   * now, and a row that fails is **no record at all** rather than a record with
   * a wrong name — rule 6, and the reason that policy is conservative: the name
   * is the column the whole export is read by.
   *
   * **A blank field here can never erase a full one.** `mergeApplicantRecord`
   * protects every scalar field by field (3.7.10), and `saveApplicant`
   * reconciles on `job.id + applicationId` (3.7.9), so a later pass that opens
   * this person's panel enriches *this* record rather than creating a second one
   * under a different hash. Those two together are what make it safe to run the
   * list pass first; neither is incidental to it.
   */
  function buildApplicantListRecord({ name = "", href = "", job = null, context = {}, sourceUrl = "", buildId = "" } = {}) {
    const applicantName = cleanApplicantName(name);
    if (!isApplicantNameCandidate(applicantName)) return null;
    const row = parseHiringContext(href);
    const applicationId = row.applicationId || context.applicationId || null;
    const jobId = cleanText(job?.id) || context.jobId || null;
    return normalizeApplicantRecord({
      applicationId,
      // Carried when the page header supplied one, so the table shows which job
      // these people applied to rather than a bare id. Never assembled.
      job: { ...(job || {}), id: jobId },
      applicant: { name: applicantName },
      extraction: {
        timestamp: new Date().toISOString(),
        sourceUrl,
        buildId,
        warnings: [],
        // Provenance, in the field that exists for exactly this: `rawData` keeps
        // the verbatim text each section was parsed from, and here the section
        // IS the list row. Without it a name-only record is indistinguishable
        // from a full extraction that found nothing — and the two call for
        // opposite responses. `normalizeApplicantRecord` keeps `rawData`
        // verbatim, so this needs no change to the record's own schema.
        rawData: { list_row: applicantName }
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
      /**
       * How many times this job has reloaded the hiring page chasing resumes
       * LinkedIn was still virus-scanning (3.10.0).
       *
       * It lives here, on the lease, because the reload destroys the document
       * and every counter inside it — a budget held in the run would reset on
       * the very act it is meant to bound. Re-arming the job (the recruiter
       * pressing Collect again) deliberately starts a fresh entry with a fresh
       * budget: that is a new deliberate instruction, not a runaway.
       */
      resumeReloads: 0,
      /**
       * Which applicant the last reload was spent ON, and how many it has cost.
       *
       * The per-applicant bound is the thing that lets the page be reloaded the
       * moment the notice appears without a still-scanning file sending it round
       * for ever, so it has to survive the reload exactly as the job total does.
       * One key and one count rather than a map: reloads for one applicant are
       * consecutive by construction — the resumed run goes straight back to the
       * people it still owes — and an unbounded map on a lease is a leak with a
       * recruiter's applicant ids in it.
       */
      resumeReloadKey: "",
      resumeReloadKeyCount: 0,
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

  /**
   * Spend one of this job's resume reloads.
   *
   * Separate from `settleAutoRun` and deliberately not folded into it: settling
   * is a *terminal* report about an execution, and this is the opposite — it is
   * recorded immediately BEFORE the document is destroyed, precisely so the
   * successor can read it. Folding the two together would mean the only way to
   * spend the budget was to end the run.
   *
   * An entry written before 3.10.0 has no counter at all, which reads as zero and
   * is correct: it has never reloaded.
   *
   * **THREE COUNTERS NOW, NOT ONE**, because reloading on sight needs to know
   * more than a total. `applicantKey` is the row key of the applicant this
   * reload is being spent for, and `recovered` is how many resumes the run that
   * is about to be destroyed managed to read:
   *
   *   - `resumeReloadKeyCount` continues while the key is the same applicant and
   *     starts over the moment it is somebody else. That is what stops one
   *     still-scanning file from looping, and it is why the key is stored beside
   *     the count rather than the count alone.
   *   - `resumeReloadFruitless` climbs when the run recovered nothing and resets
   *     to zero when it recovered anything, so it measures reloads that are not
   *     helping rather than reloads that have happened.
   *
   * An end-of-walk reload passes no key — it is for everyone still owed rather
   * than for one person — which clears the key and its count rather than
   * charging it to whoever happened to be last.
   */
  function noteResumeReload(entry, { now = "", applicantKey = "" } = {}) {
    if (!entry || typeof entry !== "object") return { changed: false, reason: "missing", entry };
    const spent = Math.max(0, Number(entry.resumeReloads) || 0) + 1;
    const key = cleanText(applicantKey);
    const sameApplicant = Boolean(key) && key === cleanText(entry.resumeReloadKey);
    const forApplicant = sameApplicant
      ? Math.max(0, Number(entry.resumeReloadKeyCount) || 0) + 1
      : (key ? 1 : 0);
    return {
      changed: true,
      reason: "reloaded",
      entry: {
        ...entry,
        resumeReloads: spent,
        resumeReloadKey: key,
        resumeReloadKeyCount: forApplicant,
        updatedAt: cleanText(now)
      }
    };
  }

  /**
   * How much of the resume-reload budget this lease has left, for one applicant.
   *
   * The read half of the pair above, kept here rather than in the worker so the
   * "is this the same applicant" comparison is written once and cannot drift
   * from the one `noteResumeReload` makes when it spends.
   */
  function readResumeReloadState(entry, { applicantKey = "" } = {}) {
    const key = cleanText(applicantKey);
    const source = entry && typeof entry === "object" ? entry : {};
    const sameApplicant = Boolean(key) && key === cleanText(source.resumeReloadKey);
    return {
      reloads: Math.max(0, Number(source.resumeReloads) || 0),
      applicantReloads: sameApplicant ? Math.max(0, Number(source.resumeReloadKeyCount) || 0) : 0
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
      // A resume that was SEEN but never fetched is not a reason to skip
      // somebody — it is the reason to come back. `available: true` used to
      // count on its own, so an applicant whose CV was still being virus-scanned
      // was marked collected by the very field recording that the file was never
      // read, and no later run would look again. See `hasPendingResume`.
      || (resume.available === true && resume.downloadStatus !== RESUME_STATUS.NOT_ATTEMPTED)
    );
  }

  /**
   * Did this run SEE a resume it could not read, and should it come back?
   *
   * **THE LIVE SYMPTOM: "Scanning resume for viruses. Please refresh the page
   * now."** LinkedIn scans an attachment server-side and puts that notice where
   * the resume card belongs while it does. 3.9.1 taught the run to recognise it
   * and to record `NOT_ATTEMPTED` rather than `UNAVAILABLE` — the applicant has
   * a CV, this pass simply could not see it, and rule 1 says a blank beats a
   * wrong value. That part was right and is untouched.
   *
   * **What was missing is the coming back.** `available: true` is one of the
   * substantive fields `isCollectedApplicant` counts, so an applicant whose
   * resume was left mid-scan was marked COLLECTED on the strength of the very
   * field that says the file was never fetched. Every later run then skipped
   * them, and the page-completion gate did not re-arm them either, because a
   * record with a contact and an employment history is not thin. The scan is
   * TRANSIENT — it is the one failure on this surface that is all but certain to
   * have cleared a minute later — and it was the one nothing ever retried.
   *
   * `NOT_ATTEMPTED` is the whole test, and it is exact: it is the default for a
   * record whose resume step never ran, and the scanning path is the only place
   * that pairs it with `available: true`. `LINK_ONLY`, `FAILED` and
   * `UNAVAILABLE` all mean the resume WAS looked at, so none of them comes back
   * here — this is "I did not look", never "I looked and got nothing".
   */
  function hasPendingResume(record) {
    const resume = record?.applicant?.resume || {};
    return resume.available === true && resume.downloadStatus === RESUME_STATUS.NOT_ATTEMPTED;
  }

  /**
   * May a LATER run skip this applicant entirely?
   *
   * "Do I have a usable record" and "is there nothing left to fetch" are two
   * questions, and conflating them is what made the virus-scan notice permanent.
   * An applicant read in full whose only gap is the CV passes
   * `isCollectedApplicant` on the strength of their contact and their history —
   * correctly, the record IS usable — and was therefore skipped by every run
   * after the one that missed the file, so the transient failure became a
   * permanent hole. The page-completion gate catches it inside a run; this is
   * what makes the refresh-and-run-again that LinkedIn itself asks for actually
   * reach them.
   *
   * The one judgement, in the core, so the worker and the index share a copy.
   */
  function isFullyCollectedApplicant(record) {
    return isCollectedApplicant(record) && !hasPendingResume(record);
  }

  /**
   * How many applicants in a row must meet the scan notice before the page is
   * reloaded. **One. The notice is answered where it appears.**
   *
   * **THE SIGNATURE THAT NAMES THE CAUSE.** Two live reports of this defect
   * share a shape that a per-file virus scan cannot produce. 3.9.1: "the first
   * two applicants downloaded and every one after them did not." 3.10.0: "this is
   * after many applicants profiles are saved." A scan that runs per attachment
   * fails on scattered applicants, because the files were uploaded on different
   * days and are unrelated to each other. **Failing for everyone after applicant
   * N is a property of the document, not of the documents** — the page's own
   * session for fetching attachments has gone stale, and "Please refresh the
   * page now" is LinkedIn telling us exactly that in its own words.
   *
   * That is why waiting never cleared it, and why the end-of-page re-open added
   * by TASK-0180 never cleared it either: both stay on a document whose answer
   * is already decided. Only a reload changes it.
   *
   * **THREE BECAME ONE, AND THE USER WATCHED IT TO GET HERE.** 3.10.0 demanded
   * three consecutive notices before reloading, on the reasoning that one notice
   * is an ordinary per-file scan worth the cheap remedies first. Watching the
   * live run says that reasoning bought nothing and cost the thing it was
   * protecting: *"it never reloads on the same profile it occurs — the extension
   * is reloading after the 2nd or 3rd, and at last it was not even reloading, it
   * kept going through 6 profiles without even reloading."* Three separate
   * failures in one sentence, and only the first is this constant:
   *
   *   1. **The reload never landed on the applicant that showed the notice.**
   *      By the time the streak was earned the walk was two applicants past the
   *      one the recruiter was looking at, so the remedy never visibly answered
   *      the complaint even when it fired.
   *   2. The budget was two, so a third notice could not be answered at all.
   *   3. One reload that recovered nothing ended recovery for the whole job,
   *      permanently — which is what "6 profiles without even reloading" is.
   *
   * **Both of those were then raised, and raising them did not fix them.** A
   * ceiling of twelve went quiet around applicant 100 of a long list; a breaker
   * of three still disarmed the job for every applicant after it fired. They are
   * now DELETED rather than tuned, because the defect was never the number - it
   * is that a count cannot know how long the recruiter's list is. Only the
   * per-applicant rule below survives, and it exists to make the walk move ON to
   * the next person rather than to stop it.
   *
   * **What replaced the streak as the loop-breaker is `MAX_APPLICANT_RESUME_RELOADS`,
   * and that swap is the whole design.** The streak was never really about
   * evidence; it was a crude way of making sure one still-scanning file could
   * not send the page round and round. Bounding the reloads *per applicant* does
   * that job exactly, and does it without making the innocent applicant in front
   * of the recruiter wait for two more people to fail before anything happens.
   * The cheap remedies are not skipped either — `waitForResumeScan` still waits
   * out a genuine per-file scan before any of this is consulted, so what reaches
   * here is a notice that survived the wait.
   */
  const RESUME_SCAN_STREAK_LIMIT = 1;

  /**
   * How many reloads ONE applicant may cost before the walk moves past them.
   *
   * **This is the bound that makes reload-on-sight safe, and it is the one the
   * streak used to stand in for.** The failure a streak of three was really
   * guarding against is not "we reloaded too eagerly", it is *a loop*: a file
   * that is genuinely still being scanned shows the notice, the page reloads,
   * the run comes back to that same applicant, the file is still being scanned,
   * and the page reloads again — forever, because the trigger is satisfied every
   * time round. Counting the reloads against the applicant closes that directly.
   * Two: the first covers a stale attachment session, the second covers a scan
   * that really had not finished when the first one landed.
   *
   * Once spent, the applicant is not abandoned — they stay in `resumesOwed`,
   * `hasPendingResume` keeps them out of the collected index, and the walk
   * carries on to people it can still help. The next run comes back for them.
   *
   * Persisted on the lease with the job total, and keyed by the applicant's own
   * row key, because the reload destroys the document that would otherwise be
   * counting.
   */
  const MAX_APPLICANT_RESUME_RELOADS = 2;

  const RESUME_RECOVERY = Object.freeze({
    CONTINUE: "continue",
    RELOAD: "reload",
    GIVE_UP: "give-up"
  });

  /**
   * What to do about resumes LinkedIn was still virus-scanning.
   *
   * **THE LIVE COMPLAINT, three times now: "Scanning resume for viruses. Please
   * refresh the page now."** 3.9.1 taught the run to recognise the notice, wait,
   * and record `NOT_ATTEMPTED` rather than a wrong `UNAVAILABLE`. TASK-0183
   * taught it to come back — `hasPendingResume` keeps those applicants out of
   * the collected index so a later run returns for them. 3.10.0 taught it to
   * reload the page itself, which is what the notice actually asks for. All
   * three were right and none of them is undone here.
   *
   * **WHAT THIS RELEASE CHANGES IS WHEN, AND IT REVERSES 3.10.0'S CENTRAL
   * JUDGEMENT.** That release considered reloading on sight, named it the
   * obvious reading of the notice, and rejected it for two costs: on a stale
   * page every applicant shows the notice, so it is one reload per applicant
   * rather than one; and on a file whose scan genuinely has not finished, an
   * immediate reload returns to the same notice and asks for another, which is a
   * loop with a page reload in it. It chose a streak of three instead.
   *
   * Then the recruiter watched it run: *"it never reloads on the same profile it
   * occurs. The extension is reloading after the 2nd or 3rd, and at last it was
   * not even reloading, it kept going through 6 profiles without even
   * reloading."*
   *
   * The first cost was real and was accepted deliberately — a page that is
   * genuinely stale SHOULD be reloaded, and being told about it two applicants
   * late helps nobody. The second cost was real and is now paid for properly
   * rather than avoided: **the loop is closed by bounding reloads per applicant
   * (`applicantReloads`), which is exactly the failure the streak was standing
   * in for, and closes it without making two innocent applicants fail first.**
   * A still-scanning file costs that applicant its own two reloads and then the
   * walk moves past them, still owed, for the next run to collect.
   *
   * **THREE BOUNDS NOW, EACH ANSWERING A DIFFERENT WAY THIS COULD RUN AWAY**,
   * and the ceiling is deliberately the least important of them:
   *
   *   - `applicantReloads` vs `maxApplicantReloads` — one applicant may not send
   *     the page round for ever. The loop-breaker.
   *   - `fruitless` vs `maxFruitless` — a page that reloads and recovers nothing,
   *     three times running, has answered the question. The circuit breaker,
   *     and it replaces the old rule that gave up after a single fruitless
   *     reload; that rule is what disarmed the feature for the last six
   *     applicants of the reported run.
   *   - `reloads` vs `maxReloads` — the absolute ceiling, which the two bounds
   *     above should mean is never reached.
   *
   * `canReload` is the caller's, and it carries the rules this file cannot see:
   * a hidden tab (rule 9), a Stop (rule 12), a challenge (rule 10). Passed in
   * rather than assumed, so a refusal there is visible in the verdict instead of
   * silently skipping the whole policy. It outranks all three bounds, because a
   * page that may not be reloaded may not be reloaded for any reason.
   *
   * **`recovered` is gone from the decision and that is not an oversight.** It
   * was this run's own count of resumes read, and a per-run counter cannot say
   * whether reloads are helping *across* reloads — the reload destroys the run
   * that was counting. It is now folded into the persisted `fruitless` streak at
   * the moment a reload is paid for, which is the only place that survives the
   * act it is measuring.
   *
   * No click is added by any of this (rule 5): a reload is not a control, and
   * the nine remain nine.
   */
  function planResumeRecovery({
    phase = "walking",
    owed = 0,
    streak = 0,
    reloads = 0,
    applicantReloads = 0,
    canReload = true,
    maxApplicantReloads = MAX_APPLICANT_RESUME_RELOADS,
    streakLimit = RESUME_SCAN_STREAK_LIMIT
  } = {}) {
    const count = (value) => Math.max(0, Number(value) || 0);
    const owing = count(owed);
    const spent = count(reloads);
    const verdict = (action, reason) => ({ action, reason, owed: owing, reloads: spent });

    const finished = cleanText(phase) === "finished";
    const wanted = finished
      ? owing > 0
      : count(streak) >= Math.max(1, count(streakLimit));
    if (!wanted) return verdict(RESUME_RECOVERY.CONTINUE, "");

    if (!canReload) return verdict(RESUME_RECOVERY.CONTINUE, "the page may not be reloaded right now");

    /**
     * The per-applicant bound is asked FIRST, and only mid-walk.
     *
     * First, because it is the most specific answer available: "this person's
     * file is not coming back however often the page is reloaded" is a better
     * reason to stop than "the job is out of budget", and the run prints the
     * reason it was given. Only mid-walk, because at the end of the walk there
     * is no single applicant the reload is FOR — it is for everyone still owed,
     * and charging that to whichever applicant happened to be last would let one
     * stubborn file veto a reload the other twenty needed.
     */
    if (!finished && count(applicantReloads) >= count(maxApplicantReloads)) {
      return verdict(RESUME_RECOVERY.GIVE_UP, "this applicant's reloads are spent");
    }
    /**
     * AND THAT IS THE LAST BOUND. THERE IS NO CEILING BELOW THIS LINE.
     *
     * **Two used to sit here and both are gone, because both were counts, and a
     * count cannot know how long the recruiter's list is.** The live reports
     * that removed them, in order:
     *
     *   - `MAX_RESUME_RELOADS`, a job-wide lifetime ceiling of twelve. *"for at
     *     least first 100 in my case after it whenever the warning came the
     *     pages were not reloading ... even after 10 applicants it did not
     *     reload"*. Twelve reloads across a hundred applicants is one notice
     *     every eight, which is an ordinary rate — so the ceiling was reached
     *     around applicant 100 and never reset, and every applicant after that
     *     was walked past with the notice on screen. It only ever bit runs where
     *     reloading was WORKING: a hopeless page was stopped earlier by the
     *     breaker below, while a page whose reloads kept succeeding spent all
     *     twelve and then went silent.
     *   - `MAX_FRUITLESS_RESUME_RELOADS`, three reloads in a row recovering
     *     nothing. Also a count, also job-wide, and it disarmed recovery for
     *     every applicant after it fired.
     *
     * **What stops a runaway now is Stop (rule 12), which is a person rather
     * than a counter.** It is rendered unconditionally, matched before every
     * other message branch, honoured inside all three content scripts' loops,
     * and it arrives here as `canReload: false` — which is checked above, before
     * any of this. That is a deliberate trade, made after two releases in which
     * an automatic bound was the thing that broke the feature: a recruiter who
     * can see the page reloading can end it, and a counter that fires at
     * applicant 100 of 500 cannot be argued with at all.
     *
     * The per-applicant rule above is the only bound left, and it is not a cap
     * on the feature — it is what makes the walk MOVE ON to the next person
     * instead of reloading forever on one stuck file. Without it a single
     * permanently-scanning resume stalls the run on applicant N and no applicant
     * after them is ever reached, which is the opposite of collecting every
     * profile.
     */
    return verdict(RESUME_RECOVERY.RELOAD, finished ? "resumes-still-owed" : "page-stale");
  }

  /**
   * What is left to try on a resume card that has not produced a file yet.
   *
   * THE LIVE REPORT, with a screenshot of the card: a `DOC` tile reading
   * "Sushmitha.L's resume", and *"resumes like this are not getting downloaded
   * ... when i hover over this the download appear"*.
   *
   * WHY THAT CARD IS DIFFERENT FROM EVERY OTHER RESUME. This surface's whole
   * resume path is built around the VIEWER: press the resume control, wait for
   * LinkedIn to mount its viewer, and read the file's address out of the viewer
   * or out of what the viewer fetched. LinkedIn can preview a PDF, so that
   * works. It cannot preview a `.doc` or a `.docx` — so it renders a tile with a
   * type badge, mounts no viewer, fetches nothing, and offers exactly one
   * action, revealed on hover: download. The wait times out with no address and
   * the applicant is recorded `link_only` — or `unavailable`, when the tile is
   * not a control the policy recognises at all. Both mean the recruiter has no
   * file for somebody who attached one.
   *
   * THE LADDER, and its order is the whole safety argument:
   *
   *   1. `ADDRESS` — the card already names the file. **A link needs no click**,
   *      and this is the only step that can end with a file and press nothing at
   *      all, so it is asked first and it beats everything below it.
   *   2. `REVEAL` — hover the card and look again. A hover is not a click: it
   *      sends nothing, changes nothing in the recruiter's ATS, and moving the
   *      pointer away undoes it. It exists because a control the page renders on
   *      `mouseenter` is not in the markup to be read until something hovers it.
   *   3. `PRESS` — the card's own Download, once. This is the only step that
   *      presses anything, so it is the LAST one, it is never reached while an
   *      address is known, and it is never reached before the card has been
   *      looked at properly.
   *
   * `pressed` is checked before `downloadLabel` deliberately: a press that
   * produced no address is a finished answer, not an invitation to press again.
   * The reason travels with the verdict because the last two releases each spent
   * a round guessing at a resume defect that one line of diagnostics names.
   */
  const RESUME_CARD_STEP = Object.freeze({
    ADDRESS: "address",
    REVEAL: "reveal",
    PRESS: "press",
    GIVE_UP: "give-up"
  });

  function planResumeCardStep({
    address = "",
    hovered = false,
    downloadLabel = "",
    pressed = false,
    canPress = true
  } = {}) {
    const step = (action, reason) => ({ action, reason });
    if (cleanText(address)) return step(RESUME_CARD_STEP.ADDRESS, "the card already names the file");
    if (!hovered) return step(RESUME_CARD_STEP.REVEAL, "the card has not been hovered yet");
    if (pressed) return step(RESUME_CARD_STEP.GIVE_UP, "the download was pressed and no address followed");
    if (!cleanText(downloadLabel)) return step(RESUME_CARD_STEP.GIVE_UP, "the card offers no download control");
    if (!canPress) return step(RESUME_CARD_STEP.GIVE_UP, "the download may not be pressed right now");
    return step(RESUME_CARD_STEP.PRESS, "the card's own download is the only thing left");
  }

  /**
   * How far a templated message has got, and what may be done next (3.14.0).
   *
   * THE ONE IRREVERSIBLE THING THIS EXTENSION DOES. Every other ladder in this
   * file can be re-run from the top at no cost: a viewer reopened, a menu
   * reopened, a page re-paged, a card hovered twice. A sent message cannot be
   * unsent, it went to a real applicant on the recruiter's own account, and the
   * recruiter's name is on it. So this ladder is written as the argument for why
   * a send is safe rather than as the sequence that produces one, and every rule
   * in it exists to refuse rather than to progress.
   *
   * There is no DOM here and no clock, on purpose and for the reason the whole
   * file is built this way: there is no jsdom in this repository, so the only
   * questions that can be ANSWERED rather than argued are the ones asked of a
   * pure function. The three worth being certain about are can it send to the
   * wrong person, can it send half a message, and can it send twice — and all
   * three are decided here, in Node, rather than by watching a live account.
   *
   * THE ORDER IS THE SAFETY ARGUMENT:
   *
   *   1. `wrongPerson` FIRST, and it beats everything, including a message
   *      already sent. LinkedIn routes ahead of its own render (see the panel
   *      arrival note): the address bar names the next applicant while the panel
   *      still shows the previous one, which is the defect that made
   *      `describePanelArrival` necessary in the first place. A composer opened
   *      on that race belongs to somebody else, and it must never be typed into,
   *      whatever else is true of the run.
   *   2. `confirmed` next, then `sent`. A message already gone is a fact, not a
   *      step: the only thing left to do with it is observe it, and observing it
   *      is what CONFIRM is. This is also why the veto below sits UNDER these
   *      two — Stop ends work, it never discards what that work produced (rule
   *      12), and a send that already happened is not made un-happened by
   *      pressing Stop a moment later. It is recorded instead.
   *   3. `canSend === false` — the caller's veto: Stop, a rate limit, a daily
   *      cap, a person who must not be messaged. Checked BEFORE the composer is
   *      opened, because there is no reason to open a composer this run is not
   *      allowed to send from, and an abandoned composer is the next applicant's
   *      problem exactly as an abandoned menu was.
   *   4. OPEN, INSERT, VERIFY, SEND — and SEND is reachable only through a
   *      read-back that MATCHED.
   *
   * WHY `readBackMatches` IS THREE-VALUED AND NOT TWO. "The text has not been
   * read back yet" and "the text was read back and it was not the message" are
   * different facts with opposite answers, and a boolean cannot hold both: it
   * would either loop on VERIFY for ever or give up before verifying. `null`
   * (the default, and anything that is not a boolean) means not yet asked, so
   * VERIFY. Exactly `false` means asked and answered wrongly, so GIVE UP —
   * a composer holding a truncated message, or a template whose variables did
   * not resolve, is not a message to send at a lower confidence, and re-inserting
   * risks appending a second copy to whatever is already in there. Only exactly
   * `true` reaches SEND.
   *
   * DONE and GIVE_UP are terminal because their causes are sticky: every input
   * that produces one is a fact the caller has recorded, so feeding the same
   * state back produces the same answer. A driven walk therefore always ends.
   */
  const MESSAGE_STEP = Object.freeze({
    OPEN: "open",
    INSERT: "insert",
    VERIFY: "verify",
    SEND: "send",
    CONFIRM: "confirm",
    DONE: "done",
    GIVE_UP: "give-up"
  });

  function planMessageStep({
    composerOpen = false,
    textInserted = false,
    readBackMatches = null,
    sent = false,
    confirmed = false,
    wrongPerson = false,
    canSend = true
  } = {}) {
    const step = (action, reason) => ({ action, reason });
    if (wrongPerson) return step(MESSAGE_STEP.GIVE_UP, "the composer is not this applicant's");
    if (confirmed) return step(MESSAGE_STEP.DONE, "the message was sent and the send was observed");
    if (sent) return step(MESSAGE_STEP.CONFIRM, "send was pressed and nothing has confirmed it yet");
    if (!canSend) return step(MESSAGE_STEP.GIVE_UP, "this run may not send right now");
    if (!composerOpen) return step(MESSAGE_STEP.OPEN, "no composer is open yet");
    if (!textInserted) return step(MESSAGE_STEP.INSERT, "the composer is open and empty");
    if (readBackMatches === false) return step(MESSAGE_STEP.GIVE_UP, "the read-back is not the message");
    if (readBackMatches !== true) return step(MESSAGE_STEP.VERIFY, "the text is in and has not been read back");
    return step(MESSAGE_STEP.SEND, "the read-back matched, so the composer holds the whole message");
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
      const judged = typeof record?.collected === "boolean" ? record.collected : isFullyCollectedApplicant(record);
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

  /**
   * How long a label may be before it is a card rather than a control's name.
   *
   * A row's own link carries the whole card — the person, their headline, their
   * location and the two match counts — so anything longer than a name is a row
   * by construction and is never judged at all.
   */
  const ROW_LABEL_MAX_LENGTH = 80;

  /**
   * Could a link carrying this label be a row of the applicant list?
   *
   * THE LIVE DEFECT, and it is the whole of "the first applicant of every page is
   * skipped". The list renders a control inside its own header — the live one is
   * **"Edit qualifications"**, in "Here are all applicants to your job. Edit
   * qualifications" — and its href carries the `applicationId` the page is
   * currently on. `applicantRowKey` keys a row on exactly that id, because it is
   * the only identifier a row carries before it is opened, so that control and
   * the **open applicant's own row** hash to one key. The control renders above
   * the rows, so the walk takes its turn first; every terminal outcome retires
   * the key; and `unprocessedApplicantRows` then filters the real row out as
   * already finished with. The applicant whose panel was open when the run
   * started is never opened at all — and since a pager click leaves LinkedIn
   * showing the new page's first applicant, it is one lost person per page,
   * silently, with no error anywhere.
   *
   * Refused on the **label**, never on the href, because the two addresses are
   * genuinely the same one: nothing about the link tells them apart. The text
   * does, and this asks the one policy that already knows this exact phrase —
   * `NAME_CONTROL_PHRASE_PATTERN`, written when the *panel* path saved people
   * under this same label — rather than growing a second list of controls beside
   * it. `NAME_CHROME_PATTERN` comes with it for the same reason, so a `Resume` or
   * `Contact info` link rendered inside a row cannot be mistaken for the row.
   *
   * **An unlabelled link is accepted**, and deliberately: it is judged by its
   * href exactly as before. Losing a real applicant is the failure being fixed
   * here, so a link this cannot read is never one it refuses.
   */
  function isApplicantRowLabel(value) {
    const text = cleanText(value);
    if (!text || text.length > ROW_LABEL_MAX_LENGTH) return true;
    return !NAME_CONTROL_PHRASE_PATTERN.test(text) && !NAME_CHROME_PATTERN.test(text);
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

  /**
   * The rows of ONE page of the applicant list, in the order that page renders
   * them, and independent of which of them happen to be mounted right now.
   *
   * **THE TWO DEFECTS THIS EXISTS FOR, reported together.** "The extension is
   * saving a profile, going to a specific profile, then to the next, saving,
   * then back to that specific profile, then next" — and "it did not even
   * collect all the applicants in one page."
   *
   * Both are one cause. The walk asked the DOM "which row have I not finished
   * with", took the first one it was handed, and had no other notion of order or
   * of membership. On a virtualized list `applicantRows()` is a moving WINDOW,
   * and LinkedIn re-centres that window on the applicant whose panel it has just
   * opened — so the window keeps re-mounting rows *above* the one just
   * collected. Those rows are unprocessed, they render first, and the walk
   * therefore keeps stepping backwards and then forwards again: exactly the
   * back-and-forth that was reported. The same blindness loses whole rows: a run
   * that arrives with the list scrolled half way down never sees the rows above
   * that point (`growApplicantList` only ever scrolls DOWN), so the pager is
   * pressed with part of page one never opened, and nothing anywhere notices.
   *
   * A roster answers both, because it is the two things the DOM cannot say:
   * **who is on this page**, and **in what order**. Membership is settled before
   * anybody is opened, so "the page is finished" is a fact rather than "nothing
   * unprocessed happens to be mounted"; and selection is by roster position, so
   * a re-mounted window can no more re-order the walk than it can shorten it.
   *
   * Merge-insert rather than append, for the same reason the accumulator is
   * merge-only: a window is a *slice* of the page, and a row seen for the first
   * time belongs where that slice puts it — between the rows it rendered
   * between — not at the end of everything known. Appending would place a row
   * that mounted late after rows that come after it, which is the ordering
   * defect in a different costume.
   */
  function createApplicantRoster() {
    const order = [];
    const index = new Map();

    const reindexFrom = (at) => {
      for (let position = at; position < order.length; position += 1) index.set(order[position], position);
    };

    return {
      get size() {
        return order.length;
      },
      keys() {
        return [...order];
      },
      has(key) {
        return index.has(cleanText(key));
      },
      /** Where this row sits on the page, or -1 for a row the roster never saw. */
      positionOf(key) {
        const value = cleanText(key);
        return index.has(value) ? index.get(value) : -1;
      },
      /** A new page is a new roster: nothing about the old one survives it. */
      reset() {
        order.length = 0;
        index.clear();
      },
      /**
       * Merge one rendered window, in the order it rendered. Returns how many
       * rows the roster had never seen — the only currency a paginated,
       * virtualized list cannot lie in, and the same one growth is counted in.
       */
      add(rows = []) {
        const keys = [];
        for (const row of rows || []) {
          const key = applicantRowKey(row);
          if (key && key !== "name:") keys.push(key);
        }
        // Where an unknown row goes: just before the first row of this window
        // the roster already knows, because everything ahead of that row in the
        // window is ahead of it on the page. With no known row at all, the
        // window is new ground and belongs at the end.
        let cursor = order.length;
        for (const key of keys) {
          if (!index.has(key)) continue;
          cursor = index.get(key);
          break;
        }
        let gained = 0;
        for (const key of keys) {
          if (index.has(key)) {
            cursor = index.get(key) + 1;
            continue;
          }
          order.splice(cursor, 0, key);
          reindexFrom(cursor);
          cursor += 1;
          gained += 1;
        }
        return gained;
      },
      /** The rows of this page the run has not finished with, in page order. */
      pending(processed = new Set()) {
        return order.filter((key) => !processed.has(key));
      },
      /**
       * The next row of this page, in the page's own order — mounted or not.
       *
       * This is what "in sequence" means, and why it is asked of the roster
       * rather than of the DOM: the run waits for *this* row rather than opening
       * whoever the mounted window happens to be showing instead of them.
       */
      next(processed = new Set()) {
        for (const key of order) if (!processed.has(key)) return key;
        return "";
      },
      /** How many, without building the list — this is asked every turn. */
      remaining(processed = new Set()) {
        let count = 0;
        for (const key of order) if (!processed.has(key)) count += 1;
        return count;
      },
      /**
       * A rendered window, put back into page order.
       *
       * Rows the roster has never seen sort last rather than first: a row that
       * appeared from nowhere is genuinely of unknown position, and guessing it
       * belongs at the front is how the walk jumped backwards in the first
       * place. Ties keep their DOM order, so the sort is stable in both.
       */
      sort(rows = []) {
        return (rows || [])
          .map((row, at) => ({ row, at, position: this.positionOf(applicantRowKey(row)) }))
          .sort((left, right) => {
            const a = left.position < 0 ? Number.MAX_SAFE_INTEGER : left.position;
            const b = right.position < 0 ? Number.MAX_SAFE_INTEGER : right.position;
            return a === b ? left.at - right.at : a - b;
          })
          .map((entry) => entry.row);
      }
    };
  }

  /**
   * How many extra passes over one page its unfinished applicants may cost.
   *
   * Two, for the same reason every other retry on this surface is bounded: a
   * page whose applicants will never read properly must still end, or the run
   * never reaches page two at all — which is the more expensive failure of the
   * two, because the applicants beyond it are not thin, they are absent.
   */
  const MAX_PAGE_COMPLETION_SWEEPS = 2;

  /**
   * Is this page finished, or does it owe another pass?
   *
   * **THE DEFECT THIS EXISTS FOR, reported live: "from 25 applicants it skipped
   * 11 and only saved their name."** The run had no notion of a page being
   * *properly* finished — only of every row having been *reached*. `processed`
   * is added to on every terminal outcome, and a floor record is a terminal
   * outcome, so eleven applicants whose panel never opened were retired with
   * nothing but the name their list row painted and the walk moved on. Worse,
   * the commonest thin outcome was not even one of the bounded failures: a panel
   * that DOES open and renders no section, no contact and no resume returns a
   * record carrying only a name, which the walk counted as a success.
   *
   * The test for "usable" is not new and is deliberately not re-invented here —
   * `isCollectedApplicant` already draws exactly this line, and it is the line a
   * *later* run uses to decide whom to try again. That is the whole absurdity
   * this repairs: the records a second run would come back for were the ones the
   * first run paged straight past.
   *
   * Membership comes from the roster rather than from the DOM, because the DOM
   * cannot answer it: a virtualized list renders a window, and "nothing
   * unprocessed is on screen" is what retired half a page in the first place.
   *
   * Three verdicts, and no fourth:
   *
   *   - `collect` — rows on this page have not been reached at all. Ordinary
   *     walking; the gate has nothing to say yet.
   *   - `rearm` — every row was reached, some saved nothing but a name, and the
   *     sweep allowance is not spent. Those keys go back on the queue in page
   *     order and are opened again before the pager is touched.
   *   - `page` — every row was reached and either read properly or given its
   *     allowance. `thin` says how many were left incomplete, so moving on is
   *     recorded rather than silent (rule 22 in spirit: no quiet truncation).
   *
   * Re-arming is free of side effects for the same reason the open-retry is:
   * the store is merge-only, so a second read of the same applicant can only
   * fill the gaps in the record already written — `mergeApplicantRecord` never
   * overwrites a filled field with a blank, and `saveApplicant` reconciles on
   * job + applicationId, so the enriched read lands ON the thin record rather
   * than beside it (rules 17 and 1).
   */
  function planPageCompletion({
    pageKeys = [],
    processed = new Set(),
    // Rows this page reached but did not FINISH — a record that saved nothing
    // but a name, or one whose resume LinkedIn was still virus-scanning. A Set
    // or a Map; only `has` is asked of it, so the caller may carry the reason.
    thin = new Set(),
    sweepsUsed = 0,
    maxSweeps = MAX_PAGE_COMPLETION_SWEEPS
  } = {}) {
    const keys = [];
    for (const key of pageKeys || []) {
      const value = cleanText(key);
      if (value && !keys.includes(value)) keys.push(value);
    }
    const has = (set, key) => Boolean(set && typeof set.has === "function" && set.has(key));

    const outstanding = keys.filter((key) => !has(processed, key));
    if (outstanding.length) {
      return { action: "collect", rearm: [], thin: 0, outstanding: outstanding.length, reason: "rows-outstanding" };
    }

    // Page order, always: these are re-opened one at a time from the top of the
    // page, exactly as they were the first time, so a re-armed row is never the
    // reason the walk starts jumping around the list again.
    const incomplete = keys.filter((key) => has(thin, key));
    if (!incomplete.length) {
      return { action: "page", rearm: [], thin: 0, outstanding: 0, reason: "page-complete" };
    }
    if (sweepsUsed < Math.max(0, maxSweeps)) {
      return { action: "rearm", rearm: incomplete, thin: incomplete.length, outstanding: 0, reason: "incomplete-records" };
    }
    // Out of allowance. The page moves on — a page that will not read must not
    // hold the pages after it — and says how many it is leaving behind.
    return { action: "page", rearm: [], thin: incomplete.length, outstanding: 0, reason: "sweeps-exhausted" };
  }

  // ------------------------------------------------------------ panel arrival
  /**
   * Has the applicant we asked for actually mounted?
   *
   * **THE DEFECT THIS EXISTS FOR: every applicant was saved under the first
   * applicant's name.** Reported with the recruiter's own table — three rows,
   * three different people in the list (Komal Sharma, Neha Singh, Mahak Ayani),
   * all stored as "Komal Sharma", the one that happened to be open when the run
   * started.
   *
   * The chain is worth writing down, because the last link is the surprising
   * one. The row click routes the address bar immediately, so each record was
   * keyed to the *right* application — that is why there were three rows and not
   * one. But the panel had not re-rendered yet, and the wait before the scan was
   * "the panel's text differs from what it was before the click", which **the
   * teardown alone satisfies**. So the scan read the previous applicant's panel.
   * `findApplicantName` then offered the correct name from the list row *and*
   * the stale panel's own name — and `chooseApplicantName` arbitrates with
   * `nameFromExplanations`, LinkedIn's qualification prose, which on that stale
   * panel says "Komal Sharma has…" over and over. So the wrong name won as the
   * **corroborated** one, and `addName` latches a corroborated name against
   * every later read. The policy did exactly what it was designed to do; it was
   * pointed at the wrong panel.
   *
   * Hence: identity, never text. The id comes from the panel's own application
   * link and from the address, never from prose; "mounted" is the same "at least
   * two applicant sections" bar the panel resolver itself qualifies on, so a
   * shell that has painted nothing cannot pass it. `identity` — the application
   * id plus the member's `/in/` slug — is the fallback for a row whose href
   * carries no parseable id, and is still built from links rather than text.
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

  /**
   * Which "no pager was pressed" answers are the end of the list, and which are
   * only the end of what this reader can see.
   *
   * The distinction was written down in 3.9.4 and then not acted on: every
   * reason arrived at the caller as `settled`, which is CONCLUSIVE, so a pager
   * this build could not read completed the job exactly as a page with no pager
   * at all did — and a completed job is one `claimAutoRun` refuses to re-arm, so
   * the run could not even restart itself to try again.
   *
   * `no-pager` and `no-next-number` are verdicts about the LIST: nothing offers
   * another page, or the pager offers no page after the one being shown. Both
   * are the genuine end. Everything else — a pager that marks two pages current,
   * a control the click policy refused — is a verdict about the READER, and a
   * reader that cannot see must leave the run restartable rather than declare
   * the job done.
   */
  const CONCLUSIVE_PAGER_REASONS = Object.freeze(["no-pager", "no-list", "no-next-number"]);

  function isConclusivePagerReason(reason = "") {
    return CONCLUSIVE_PAGER_REASONS.includes(cleanText(reason));
  }

  /**
   * WHICH nothing the pager search found, decided in one place.
   *
   * **The reason is not a label on the outcome — it IS the outcome**, because
   * `isConclusivePagerReason` reads it back to decide whether the job may be
   * called finished, and a job called finished cannot restart itself. So the
   * mapping from "what the search saw" to "what that means" is pure, executed in
   * a test, and no longer spelled out inline in a function that also walks the
   * DOM.
   *
   * The order is the point, and every clause before the last one is a reader
   * failure rather than a verdict about the list:
   *
   *   1. **the click policy refused** the control that would have been pressed —
   *      the run may not conclude anything from a refusal it caused itself;
   *   2. **the next page is rendered but cannot be pressed.** A pager may paint
   *      the page you are ON as plain text and only the others as controls; if
   *      the one that is plain is the page AFTER this one, there is a next page
   *      and this reader cannot reach it. That is emphatically not "the list has
   *      ended";
   *   3. a group of page numbers WAS proven a pager, so its own answer stands —
   *      `not-a-pager` from the shape proof means this reader could not see,
   *      while anything else means the pager offers nothing after the page being
   *      shown, which is the genuine end;
   *   4. **no group could be formed at all**, and the two cases under that are
   *      the whole reason this function exists.
   *
   * THE LAST ONE IS THE LIVE DEFECT (3.9.6). `no-pager` is CONCLUSIVE — it means
   * "nothing on this page offers another one" — and it was returned whenever
   * fewer than two page numbers could be grouped together. A pager the reader
   * merely failed to GROUP therefore ended the job exactly as a single-page list
   * did, which is the reported "there are 2 pages but it stops at the first" in
   * its most permanent form: `claimAutoRun` refuses to re-arm a completed job,
   * so the run could not restart itself to try again.
   *
   * A pager's fingerprint is asserted rather than assumed, and it is BOTH ends:
   * a page one, and some page after it. Every pager LinkedIn renders offers page
   * one, and a pager with a page two is a list with a second page whatever this
   * reader could make of the markup. A stray `2` on its own is not enough — that
   * is what keeps a genuinely single-page job completing normally instead of
   * stopping for a reader that saw a number somewhere.
   */
  function pagerSearchReason({
    refused = "", numbered = 0, ordinal = "", unpressable = false, seen = []
  } = {}) {
    if (cleanText(refused)) return "pagination-refused";
    if (unpressable) return "next-page-not-pressable";
    if (Number(numbered) > 0) {
      return cleanText(ordinal) === "not-a-pager" ? "unreadable-pager" : "no-next-number";
    }
    const pages = (seen || []).filter((page) => Number.isInteger(page) && page > 0);
    const looksLikeAPager = pages.includes(1) && pages.some((page) => page >= 2);
    return looksLikeAPager ? "unproven-pager" : "no-pager";
  }

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

  // ------------------------------------------------ capturing an unknown layout
  //
  // The guide's Phases 8 and 9: when a layout cannot be read safely, report it
  // rather than returning empty fields — and capture only what is needed to
  // support it, never a cookie, a token, a credential or unrelated storage.
  //
  // The capture is a RE-SHAPING of what the extraction already read, not a
  // second extraction: the section scan, the header window, the line arrays each
  // reader consumed. That is deliberate — a capture path that gathered its own
  // data could diverge from the read path, and then it would describe a page
  // nobody's record came from.

  /** Bumped when the shape changes, so an old capture is still readable. */
  const CAPTURE_SCHEMA_VERSION = 1;

  /** Never stored. Only which KIND of destination a link had. */
  const CAPTURE_LINK_RELATIONS = Object.freeze(["mailto", "tel", "profile", "application", "media", "external", "internal"]);

  const CAPTURE_EMAIL_PLACEHOLDER = "redacted@example.com";
  const CAPTURE_PHONE_PLACEHOLDER = "+00 000 000 0000";

  /**
   * Names, companies and schools, replaced consistently.
   *
   * **The same name must be the same pseudonym everywhere in one capture**, or
   * the capture stops exercising the thing it exists to exercise: the name
   * reader's whole job is deciding which of five candidates the platform's own
   * prose agrees with, and randomising them would make every candidate disagree.
   * One map per capture, handed to every field.
   */
  function createCapturePseudonyms() {
    const assigned = new Map();
    const counts = { person: 0, company: 0, school: 0 };
    const letter = (index) => {
      let name = "";
      let value = index;
      do {
        name = String.fromCharCode(65 + (value % 26)) + name;
        value = Math.floor(value / 26) - 1;
      } while (value >= 0);
      return name;
    };
    return {
      for(value, kind = "person") {
        const text = cleanText(value);
        if (!text) return "";
        const key = `${kind}:${text.toLowerCase()}`;
        if (assigned.has(key)) return assigned.get(key);
        const label = kind === "company" ? "Company" : kind === "school" ? "University" : "Person";
        const pseudonym = `${label} ${letter(counts[kind] ?? 0)}`;
        counts[kind] = (counts[kind] ?? 0) + 1;
        assigned.set(key, pseudonym);
        return pseudonym;
      },
      size: () => assigned.size
    };
  }

  /**
   * A link's KIND, which is the only thing a capture keeps about it.
   *
   * Addresses are never stored. One rule rather than a blocklist, because a
   * blocklist leaks the next parameter nobody thought of: a LinkedIn hiring
   * address carries `applicationId` and `jobId`, a media address carries a
   * signed token, and both carry whatever tracking LinkedIn adds next week.
   */
  function captureLinkRelation(href) {
    const text = cleanText(href);
    if (!text) return "";
    if (/^mailto:/i.test(text)) return "mailto";
    if (/^tel:/i.test(text)) return "tel";
    if (/applicationId=|\/applicants?\/\d/i.test(text)) return "application";
    if (/\/in\//i.test(text)) return "profile";
    if (isResumeDocumentUrl(text)) return "media";
    if (/^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\//i.test(text) || /^[/#]/.test(text)) return "internal";
    if (/^https?:\/\//i.test(text)) return "external";
    return "";
  }

  /**
   * Text with every identifier taken out and every WORDING left in.
   *
   * The wordings are the entire point: headings, section titles, field labels,
   * date ranges and degrees are what a layout is recognised by, and a capture
   * that redacted them would describe nothing. What goes is what identifies a
   * person or authorises a request.
   */
  function sanitizeCaptureText(value, pseudonyms = null) {
    let text = cleanText(value);
    if (!text) return "";
    const core = CORE();
    if (core?.EMAIL_PATTERN) text = text.replace(new RegExp(core.EMAIL_PATTERN.source, "gi"), CAPTURE_EMAIL_PLACEHOLDER);
    // A bare address, whatever it points at. Before the credential rule, because
    // a URL is where a token most often hides.
    text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "https://redacted.example");
    // Anything shaped like a credential, and everything after it to the end of
    // the line — a token is not one word. `Basic YWJj` and `ajax:1234` are two
    // tokens whose second half survived a one-word rule.
    text = text.replace(/\b(?:bearer|token|csrf|jsessionid|session|cookie|authorization|apikey|api[-_]?key)\b.*/gi, "[redacted]");
    // Any run long enough to be a number somebody could be reached on. Broader
    // than the phone reader on purpose: this one may over-redact, and the reader
    // may not (rule 2 in both directions).
    //
    // ...but a DATE RANGE is not a phone number, and dates are exactly what this
    // capture exists to preserve — "2019 - 2024" under a degree is how a fixture
    // proves an education card parsed. Caught by the test that asserted the
    // wordings survive; `DATE_RANGE_PATTERN` is the reader's own rule, reused.
    text = text.replace(/\+?\d[\d\s().-]{6,}\d/g, (match) =>
      DATE_RANGE_PATTERN.test(match) ? match : CAPTURE_PHONE_PLACEHOLDER);
    if (pseudonyms) {
      for (const [name, kind] of pseudonyms.names || []) {
        const clean = cleanText(name);
        if (!clean || clean.length < 3) continue;
        text = text.split(clean).join(pseudonyms.map.for(clean, kind));
      }
    }
    return text;
  }

  /**
   * A capture of one applicant's layout, with nothing in it that names them.
   *
   * Pure: it takes the shapes the adapter already built and returns the payload
   * that is written to disk. Everything excluded is excluded by CONSTRUCTION —
   * a cookie, a token, a credential or a browser store cannot appear here
   * because nothing in this function has any way to reach one, and the adapter's
   * own source is asserted not to read them either.
   */
  function buildApplicantCapture(input = {}) {
    const map = createCapturePseudonyms();
    const names = [];
    for (const name of input.names || []) names.push([name, "person"]);
    for (const name of input.companies || []) names.push([name, "company"]);
    for (const name of input.schools || []) names.push([name, "school"]);
    const pseudonyms = { map, names };
    const clean = (value) => sanitizeCaptureText(value, pseudonyms);
    const cleanLines = (lines) => (Array.isArray(lines) ? lines : toLines(lines)).map(clean).filter(Boolean);

    const scan = input.sectionScan || {};
    return {
      capture: {
        schemaVersion: CAPTURE_SCHEMA_VERSION,
        name: cleanText(input.name) || "applicant-ui",
        buildId: cleanText(input.buildId),
        capturedAt: cleanText(input.capturedAt),
        layout: cleanText(input.layout) || "generic",
        // Never the address bar: it carries the job and application ids.
        surface: "hiring-applicants"
      },
      signals: input.signals ? { ...input.signals, unmatchedHeadings: (input.signals.unmatchedHeadings || []).map(clean) } : {},
      sectionScan: {
        headings: (scan.headings || []).map((heading) => ({
          where: heading.where, text: clean(heading.text), key: heading.key || "", bounds: heading.bounds || ""
        })),
        resolved: (scan.resolved || []).map((section) => ({
          key: section.key, heading: clean(section.heading), foundIn: section.foundIn,
          narrowedFrom: section.narrowedFrom || "", blocks: section.blocks
        })),
        missing: scan.missing || [],
        auxiliary: (scan.auxiliary || []).map((entry) => ({ where: entry.where, text: clean(entry.text), key: entry.key }))
      },
      headerText: cleanLines(input.headerText || []),
      nameCandidates: (input.nameCandidates || []).map((entry) => ({
        value: clean(entry?.value), source: entry?.source || "", evidence: entry?.evidence || ""
      })),
      labelled: (input.labelled || []).map((entry) => ({ label: entry?.label || "", value: clean(entry?.value) })),
      blocks: Object.fromEntries(
        Object.entries(input.blocks || {}).map(([key, list]) => [key, (list || []).map(cleanLines)])
      ),
      // Kinds only. Not one address survives this.
      links: (input.links || []).map((href) => ({ rel: captureLinkRelation(href) })).filter((link) => link.rel),
      readers: input.readers || {},
      pseudonyms: map.size()
    };
  }

  const api = {
    // pages
    HIRING_PATH_PATTERN, isHiringPage, isApplicantsPage, parseHiringContext, applicantsViewKey,
    // the columns that scroll
    COLUMN_SCROLL_EPSILON, chooseColumnScrollTarget,
    // click policy
    CONTROL_PURPOSE, FORBIDDEN_APPLICANT_CONTROL_PATTERN, APPLICANT_CONTACT_CONTROL_PATTERN,
    APPLICANT_NAVIGATION_CONTROL_PATTERN, APPLICANT_MENU_OPENER_PATTERN,
    APPLICANT_MENU_OPENER_WITHIN_PATTERN,
    isApplicantMenuOpenerLabel,
    RESUME_CONTROL_PATTERN, RESUME_DOWNLOAD_CONTROL_PATTERN, DISCLOSURE_CONTROL_PATTERN,
    APPLICANT_PAGINATION_PATTERN, APPLICANT_PAGINATION_PHRASE_PATTERN,
    // the 3.14.0 carve-out, exported whole so a test can walk it rather than
    // trust a sentence about it: which words fired, which purpose forgives
    // which, and the two whole-label rules that still have to match afterwards
    FIRED_FORBIDDEN_ACTION_PATTERN, firedForbiddenWords,
    PURPOSE_EXEMPT_WORDS, firesOutsideExemption,
    MESSAGE_OPEN_CONTROL_PATTERN, MESSAGE_SEND_CONTROL_PATTERN,
    MESSAGE_STEP, planMessageStep,
    classifyApplicantControl, pageNumberFrom, paginationLabel,
    saysCurrentPage, planPagerOrdinalStep,
    // qualifications and screening
    QUALIFICATION_CATEGORY, QUALIFICATION_RESULT, QUALIFICATION_SOURCE,
    qualificationCategoryOf, classifyQualificationResult, classifyQualificationSource,
    parseQualificationBlock, qualificationKey, parseScreeningBlock, screeningKey,
    // history
    splitCompanyAndDates, parseExperienceBlock, experienceKey, deriveCurrentPosition,
    isDateOnlyLine, continuesExperienceCard, EXPERIENCE_CONTINUATION_PATTERN,
    normalizeDateRange, totalExperienceFrom, parseEducationBlock, educationKey,
    // which section a heading names — the adapter's table, here so it is testable
    SECTION_PATTERNS, SECTION_KEYS, REQUIRED_SECTION_KEYS, normalizeSectionTitle, sectionKeyFor,
    // ...and the ones that only bound a section, never supply one
    AUXILIARY_SECTION_PATTERNS, AUXILIARY_SECTION_KEYS, anySectionKeyFor, cutToOwnSection,
    // telling the two apart when the markup does not
    SECTION_TITLE_NOISE_PATTERN, isSectionTitleLine,
    SPELLED_DEGREE_PATTERN, DEGREE_PATTERN, INSTITUTION_PATTERN,
    looksLikeEducationBlock, looksLikeEducationCandidate, looksLikeQuestionBlock,
    // choosing between two readers that both claim to have found a field
    FIELD_EVIDENCE, EVIDENCE_CONFIDENCE, resolveField, fieldValue,
    // which layout the panel is — an answer that may only reorder the readers
    APPLICANT_LAYOUT, APPLICANT_READERS, APPLICANT_READER_PREFIX, APPLICANT_READER_TAIL, describeApplicantLayout,
    // fields a page may state outright instead of leaving to be derived
    APPLICANT_FIELD_LABEL_PATTERNS, APPLICANT_LABELLED_FIELDS, applicantFieldForLabel, looksLikeTotalExperience,
    // job and applicant headers
    parseJobHeader, mergeJob, parseApplicantHeader, cleanApplicantName,
    JOB_VIEW_TAB_PATTERN, isJobViewTabLabel, countJobViewTabs, jobTitleFromHeader,
    JOB_TITLE_CHROME_PATTERN, CHROME_COUNT_LINE_PATTERN, APPLICATION_HEADING_PATTERN,
    JOB_CARD_ACTION_PATTERN, isJobTitleCandidate, jobTitleFromHeadings,
    APPLICANT_LOCATION_PATTERN, looksLikeApplicantLocation,
    looksLikeApplicantHeadline, isEmployerCandidate, isCurrentRoleCandidate, isWholeLineControlLabel,
    NAME_CHROME_PATTERN, NAME_IMAGE_ARTIFACT_PATTERN, isApplicantNameCandidate,
    nameFromExplanations, chooseApplicantName,
    // the record
    RESUME_STATUS, RESUME_EXTENSION_PATTERN,
    RESUME_SCANNING_PATTERN, isResumeScanningText, isResumeDocumentUrl, documentUrlFromDescriptor,
    // naming the saved file
    sanitizeFileName, resumeFileExtension, resumeExtensionForMediaType,
    RESUME_MIME_EXTENSIONS, resumeFileName,
    applicantId, normalizeApplicantRecord, mergeApplicantRecord, APPLICANT_SCALAR_FIELDS,
    createApplicantAccumulator, buildApplicantRecord, buildApplicantListRecord,
    // the run
    RUN_STATE, createRunState, nextRunStep, isCollectedApplicant, hasPendingResume,
    isFullyCollectedApplicant, createCollectedIndex,
    RESUME_SCAN_STREAK_LIMIT, MAX_APPLICANT_RESUME_RELOADS,
    RESUME_RECOVERY, planResumeRecovery,
    RESUME_CARD_STEP, planResumeCardStep,
    isApplicantRowLabel, applicantRowKey, unprocessedApplicantRows, createApplicantRoster,
    isProvenApplicantRow,
    PANEL_ARRIVAL, PANEL_MIN_SECTIONS, describePanelArrival,
    LIST_STOP_CONCLUSIVE, isConclusiveListStop, CONCLUSIVE_PAGER_REASONS, isConclusivePagerReason,
    pagerSearchReason,
    MAX_PAGE_COMPLETION_SWEEPS, planPageCompletion,
    AUTO_RUN_STATE, createAutoRunEntry, claimAutoRun, settleAutoRun, noteResumeReload, readResumeReloadState,
    // capturing a layout nobody has seen, with nobody's details in it
    CAPTURE_SCHEMA_VERSION, CAPTURE_LINK_RELATIONS, createCapturePseudonyms,
    captureLinkRelation, sanitizeCaptureText, buildApplicantCapture,
    // shared helpers the adapter needs and must not re-implement
    cleanText, uniqueText, toLines
  };

  globalThis.ProfileVaultApplicants = api;
})();
