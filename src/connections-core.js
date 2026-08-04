(() => {
  "use strict";

  // Pure helpers for connection discovery, pagination policy, and challenge detection.
  // No DOM access at load time: this file is imported directly by Node tests.

  const PROFILE_PATH_PATTERN = /^\/in\/([^/?#]+)/i;
  const CONNECTIONS_PATH_PATTERN = /^\/mynetwork\/(?:invite-connect\/)?connections\/?/i;

  /** LinkedIn's own sign-in page. The extension only ever opens this URL. */
  const LOGIN_URL = "https://www.linkedin.com/login";
  const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

  const CHALLENGE_URL_RULES = [
    { kind: "checkpoint", pattern: /\/checkpoint\//i, message: "LinkedIn security checkpoint detected." },
    { kind: "login", pattern: /\/(?:uas\/)?login|\/authwall|\/signup/i, message: "LinkedIn sign-in wall detected." }
  ];

  const CHALLENGE_TEXT_RULES = [
    { kind: "captcha", pattern: /(?:are you a human|security verification|please solve this puzzle|verify you(?:'|’)?re a human|recaptcha|hcaptcha)/i, message: "A CAPTCHA or human-verification challenge is being shown." },
    { kind: "unusual-activity", pattern: /(?:unusual activity|suspicious activity|automated activity|we noticed some unusual)/i, message: "LinkedIn reported unusual activity on this account." },
    { kind: "rate-limit", pattern: /(?:you(?:'|’)?ve reached the (?:weekly|monthly|daily|commercial use) limit|too many requests|slow down)/i, message: "LinkedIn is rate-limiting this account." },
    { kind: "restriction", pattern: /(?:your account has been restricted|we(?:'|’)?ve restricted|temporarily restricted|account is restricted)/i, message: "LinkedIn has restricted this account." },
    { kind: "login", pattern: /(?:sign in to see|join linkedin to see|please sign in|sign in to continue)/i, message: "LinkedIn is asking the user to sign in." },
    { kind: "unavailable", pattern: /(?:this page doesn(?:'|’)?t exist|page not found|profile is not available|this profile is unavailable|member no longer|user not found)/i, message: "The requested profile is unavailable." }
  ];

  // ---------------------------------------------------------------- D1 policy
  // Only controls that page through the user's own connections list may be clicked.
  // Anything that contacts, follows, endorses, or mutates a relationship is banned
  // permanently and the ban always wins over the allowlist.

  const PAGINATION_ALLOWLIST = [
    /^load more$/i,
    /^load more results$/i,
    /^load more connections$/i,
    /^show more$/i,
    /^show more results$/i,
    /^see more results$/i,
    /^more results$/i,
    /^next$/i,
    /^next page$/i,
    /^view more$/i
  ];

  const FORBIDDEN_CONTROL_PATTERN =
    /\b(?:connect|connexion|follow|unfollow|message|inmail|endorse|endorsement|recommend|remove connection|withdraw|invite|invitation|accept|ignore|decline|report|block|share|send|like|comment|repost|subscribe|save|apply|add note|schedule|book)\b/i;

  /**
   * The profile page's "Contact info" control.
   *
   * This is the SECOND clickable control in the extension, alongside connections
   * pagination. It was previously on the denylist; contact reachability (email and
   * mobile) is now the point of the collected record, and LinkedIn renders those
   * values only behind this control. It opens the member's own overlay, reads it,
   * and closes it — it sends nothing, contacts nobody, and changes no state on
   * LinkedIn. Every other control on the denylist above stays permanently
   * forbidden, and the denylist still beats every allowlist.
   */
  const CONTACT_CONTROL_PATTERN = /\b(?:contact info(?:rmation)?|see contact info)\b/i;

  /**
   * The profile page's "Show details" control inside the Open to work card.
   *
   * This is the THIRD and last clickable control in the extension. It opens the
   * member's own job-preferences panel, reads it, and closes it — nothing is
   * sent, nobody is contacted, and no state changes on LinkedIn. "Show details"
   * appears in several places on a profile, so the label alone is never enough:
   * the caller has to prove the control is inside the Open to work card, exactly
   * as connections pagination has to be proven inside the connections list.
   */
  const OPEN_TO_WORK_CONTROL_PATTERN = /^(?:show details|see details|view details|show all details)$/i;

  /** Labels for the control that dismisses an overlay this extension opened. */
  const CONTACT_DISMISS_PATTERN = /\b(?:dismiss|close|back)\b/i;

  function cleanUrlText(value) {
    return String(value ?? "").trim();
  }

  function normalizeLabel(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Decide whether a control may be clicked to reveal more connections.
   * `inConnectionsList` must be proven by the caller (the element has to live inside
   * the connections list container on a connections page). Forbidden wins over allowed.
   */
  function classifyControl({ text = "", ariaLabel = "", inConnectionsList = false } = {}) {
    const label = normalizeLabel(text) || normalizeLabel(ariaLabel);
    const combined = `${normalizeLabel(text)} ${normalizeLabel(ariaLabel)}`.trim();

    if (!label) return { allowed: false, forbidden: false, label, reason: "no-label" };
    if (FORBIDDEN_CONTROL_PATTERN.test(combined)) {
      return { allowed: false, forbidden: true, label, reason: "forbidden-action" };
    }
    if (!inConnectionsList) return { allowed: false, forbidden: false, label, reason: "outside-connections-list" };
    if (!PAGINATION_ALLOWLIST.some((pattern) => pattern.test(label))) {
      return { allowed: false, forbidden: false, label, reason: "not-allowlisted" };
    }
    return { allowed: true, forbidden: false, label, reason: "pagination" };
  }

  function isPaginationLabel(label) {
    return PAGINATION_ALLOWLIST.some((pattern) => pattern.test(normalizeLabel(label)));
  }

  function isForbiddenLabel(label) {
    return FORBIDDEN_CONTROL_PATTERN.test(normalizeLabel(label));
  }

  /**
   * May this control be clicked to reveal the member's contact details?
   *
   * Only on a profile page, and only when the label really is the contact control.
   * The denylist is still consulted first, so a button labelled
   * "Message · Contact info" is refused rather than clicked.
   */
  function classifyContactControl({ text = "", ariaLabel = "", onProfilePage = false } = {}) {
    const label = normalizeLabel(text) || normalizeLabel(ariaLabel);
    const combined = `${normalizeLabel(text)} ${normalizeLabel(ariaLabel)}`.trim();
    if (!label) return { allowed: false, forbidden: false, label, reason: "no-label" };
    if (FORBIDDEN_CONTROL_PATTERN.test(combined)) {
      return { allowed: false, forbidden: true, label, reason: "forbidden-action" };
    }
    if (!CONTACT_CONTROL_PATTERN.test(combined)) {
      return { allowed: false, forbidden: false, label, reason: "not-contact-control" };
    }
    if (!onProfilePage) return { allowed: false, forbidden: false, label, reason: "not-a-profile-page" };
    return { allowed: true, forbidden: false, label, reason: "contact-info" };
  }

  function isContactControlLabel(label) {
    return CONTACT_CONTROL_PATTERN.test(normalizeLabel(label));
  }

  /**
   * May this control be clicked to reveal the member's job preferences?
   *
   * `inOpenToWorkCard` must be proven by the caller — the element has to live
   * inside the card that says "Open to work". The denylist is consulted first,
   * so a "Show details" that also says Message or Connect is refused.
   */
  function classifyOpenToWorkControl({ text = "", ariaLabel = "", onProfilePage = false, inOpenToWorkCard = false } = {}) {
    const label = normalizeLabel(text) || normalizeLabel(ariaLabel);
    const combined = `${normalizeLabel(text)} ${normalizeLabel(ariaLabel)}`.trim();
    if (!label) return { allowed: false, forbidden: false, label, reason: "no-label" };
    if (FORBIDDEN_CONTROL_PATTERN.test(combined)) {
      return { allowed: false, forbidden: true, label, reason: "forbidden-action" };
    }
    if (!OPEN_TO_WORK_CONTROL_PATTERN.test(label)) {
      return { allowed: false, forbidden: false, label, reason: "not-a-details-control" };
    }
    if (!onProfilePage) return { allowed: false, forbidden: false, label, reason: "not-a-profile-page" };
    if (!inOpenToWorkCard) return { allowed: false, forbidden: false, label, reason: "outside-open-to-work-card" };
    return { allowed: true, forbidden: false, label, reason: "open-to-work-details" };
  }

  // ------------------------------------------------------------ phase 21: total

  /**
   * Read the advertised connection total, e.g. "1,234 connections".
   * A "+" suffix ("500+ connections") means LinkedIn is rounding, so the number is
   * recorded but marked unreliable and must never be used to declare full coverage.
   */
  function parseConnectionCount(text) {
    const source = String(text ?? "").replace(/ /g, " ");
    const patterns = [
      /([\d][\d,\s]*?)\s*(\+?)\s*connections?\b/i,
      /\bconnections?\b[^\d]{0,24}?([\d][\d,\s]*?)\s*(\+?)(?:\D|$)/i
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (!match) continue;
      const digits = String(match[1]).replace(/[,\s]/g, "");
      if (!digits) continue;
      const total = Number(digits);
      if (!Number.isFinite(total) || total <= 0) continue;
      return { total, reliable: match[2] !== "+" };
    }
    return { total: null, reliable: false };
  }

  // ------------------------------------------------------------------- URLs

  /**
   * Reduce any LinkedIn profile link to `https://www.linkedin.com/in/<slug>`.
   * Query, hash, trailing slash, and sub-paths such as /details/experience are removed.
   * Returns "" when the input is not a profile link.
   */
  function canonicalizeConnectionUrl(href, base = "https://www.linkedin.com/") {
    const raw = cleanUrlText(href);
    if (!raw) return "";
    let parsed;
    try {
      parsed = new URL(raw, base);
    } catch {
      return "";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    const hostname = parsed.hostname.toLowerCase();
    if (!/^(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com$/i.test(hostname)) return "";
    const match = PROFILE_PATH_PATTERN.exec(parsed.pathname);
    if (!match) return "";
    let slug = "";
    try {
      slug = decodeURIComponent(match[1]);
    } catch {
      slug = match[1];
    }
    slug = slug.trim();
    if (!slug || slug === "me" || /^[.]+$/.test(slug)) return "";
    return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
  }

  function isProfileUrl(value) {
    return Boolean(canonicalizeConnectionUrl(value));
  }

  function isConnectionsPage(url) {
    try {
      const parsed = new URL(String(url ?? ""));
      if (!/^(?:www\.)?linkedin\.com$/i.test(parsed.hostname)) return false;
      return CONNECTIONS_PATH_PATTERN.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  /** Canonicalize, drop non-profile links, and remove duplicates, preserving order. */
  function dedupeProfileUrls(hrefs, base = "https://www.linkedin.com/") {
    const seen = new Set();
    const output = [];
    for (const href of hrefs || []) {
      const canonical = canonicalizeConnectionUrl(href, base);
      if (!canonical) continue;
      const key = canonical.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(canonical);
    }
    return output;
  }

  // --------------------------------------------------------- connection entries
  // The connections page renders many cards per screen and reuses the DOM as the
  // list scrolls, so discovery has to accumulate across every read instead of
  // trusting whatever happens to be on screen at one moment. All of that
  // bookkeeping is pure and lives here; connections.js only supplies raw anchors.

  const NAME_BADGE_PATTERN = /\s*[·•]\s*(?:1st|2nd|3rd)(?:\+)?\s*$/i;

  /** Reduce a connection card's visible text to a person's name. */
  function cleanConnectionName(value) {
    const first = String(value ?? "")
      .replace(/ /g, " ")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)[0] || "";
    return first
      .replace(NAME_BADGE_PATTERN, "")
      .replace(/\s*[·•].*$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function entryHref(entry) {
    if (typeof entry === "string") return entry;
    return entry?.url ?? entry?.href ?? "";
  }

  function entryLabel(entry) {
    if (typeof entry === "string") return "";
    return entry?.name ?? entry?.text ?? "";
  }

  /**
   * Deduplicating store for discovered connections.
   *
   * Keyed by canonical profile URL, first-seen order preserved. A later read may
   * only fill in a name that was missing; it never overwrites one, because the
   * same person can appear both as a photo link (no text) and a name link.
   */
  function createEntryCollector(base = "https://www.linkedin.com/") {
    const seen = new Map();

    function add(entry) {
      const url = canonicalizeConnectionUrl(entryHref(entry), base);
      if (!url) return false;
      const key = url.toLowerCase();
      const name = cleanConnectionName(entryLabel(entry));
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, { url, name });
        return true;
      }
      if (!existing.name && name) seen.set(key, { url, name });
      return false;
    }

    return {
      /** Merge a batch of raw anchors. Returns how many were new. */
      absorb(entries = []) {
        let added = 0;
        for (const entry of entries || []) if (add(entry)) added += 1;
        return added;
      },
      has(url) {
        const canonical = canonicalizeConnectionUrl(url, base);
        return Boolean(canonical) && seen.has(canonical.toLowerCase());
      },
      get size() {
        return seen.size;
      },
      entries() {
        return [...seen.values()];
      },
      urls() {
        return [...seen.values()].map((entry) => entry.url);
      }
    };
  }

  /** One-shot canonicalize + dedupe of `{ href, text }` anchors from one read. */
  function collectEntriesFromLinks(links, base = "https://www.linkedin.com/") {
    const collector = createEntryCollector(base);
    collector.absorb(links);
    return collector.entries();
  }

  // ------------------------------------------------------- the scroll container
  // Finding the element that actually scrolls is the whole ballgame. LinkedIn's
  // scaffold layout pins the document at `height: 100vh; overflow: hidden` and
  // scrolls a wrapper *above* the connections list, so `document.scrollingElement`
  // reports a scroll range of zero. Code that measured the bottom from the window
  // - or from the tallest scrollable element *inside* the list, which on this page
  // is a filter panel that scrolls nothing - concluded that the first rendered
  // screenful was the entire list and stopped there. That is the "only 10
  // connections" bug, and the identical mistake truncated profile extraction.
  //
  // The choice is pure: the caller describes every candidate element it can see
  // and this picks one. Descriptor fields:
  //   id                  caller's handle for the element (opaque here)
  //   scrollHeight        element.scrollHeight
  //   clientHeight        element.clientHeight
  //   overflowY           computed overflow-y
  //   containsList        true when the element contains the content being read
  //   isScrollingElement  true for document.scrollingElement
  //   depth               distance from the document root (0 = outermost)

  const SCROLLABLE_EPSILON = 24;

  function chooseScrollTarget(candidates = []) {
    let best = null;
    let bestScore = -Infinity;

    for (const candidate of candidates || []) {
      if (!candidate || candidate.id === undefined || candidate.id === null) continue;
      const scrollHeight = Number(candidate.scrollHeight) || 0;
      const clientHeight = Number(candidate.clientHeight) || 0;
      const range = scrollHeight - clientHeight;
      // An element that cannot move is never the scroller, whatever its overflow.
      if (range <= SCROLLABLE_EPSILON) continue;

      const overflow = String(candidate.overflowY ?? "");
      const scrollable = Boolean(candidate.isScrollingElement) || /auto|scroll|overlay/i.test(overflow);
      if (!scrollable) continue;

      // A container that does not hold the content being read is disqualified
      // outright: scrolling it moves nothing and pins discovery to one screenful.
      if (!candidate.containsList) continue;

      let score = 0;
      if (candidate.isScrollingElement) score += 60;
      score += Math.min(40, Math.round(range / 500));
      // Prefer the outermost qualifying container; an inner one usually scrolls a
      // sub-panel rather than the list.
      score -= Math.min(30, Math.max(0, Number(candidate.depth) || 0));

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best ? { ...best, range: (Number(best.scrollHeight) || 0) - (Number(best.clientHeight) || 0) } : null;
  }

  // ------------------------------------------------- phase 22/23: pass planner
  // The decision of what discovery should do next is pure so it can be tested
  // against a simulated list without a DOM. connections.js supplies the observed
  // page facts and performs whatever action comes back.

  const DISCOVERY_ACTION = Object.freeze({
    SCROLL: "scroll",
    WAIT_GROWTH: "wait-growth",
    PAGINATE: "paginate",
    DONE: "done"
  });

  // How many consecutive bottom reads with no growth are needed before an
  // allowlisted pagination control is used. Reaching the bottom once is never the
  // end of the list.
  const IDLE_BOTTOM_LIMIT = 2;
  // How many consecutive scans must find no new profile URL before the list may be
  // declared finished. Much stricter than the pagination threshold: pressing Next
  // too eagerly costs a click, but stopping too early silently loses connections.
  const DISCOVERY_QUIET_SCANS = 5;
  const DISCOVERY_STEPS_PER_PASS = 120;

  /**
   * Decide the next discovery action from what the page currently looks like.
   *
   * `grew` is the outcome of the previous action, not a prediction. The list is
   * only ever declared finished when ALL of these hold at once:
   *   - the scroll container is at its bottom;
   *   - DISCOVERY_QUIET_SCANS consecutive scans found no new profile URL;
   *   - no allowlisted Load more / Next control is left to use.
   * An available control always wins over finishing, so a page that still offers
   * one can never be mistaken for the end of the list.
   */
  function planDiscoveryStep({
    atBottom = false,
    grew = false,
    idleAtBottom = 0,
    paginationAvailable = false,
    steps = 0,
    maxSteps = DISCOVERY_STEPS_PER_PASS
  } = {}) {
    if (steps >= maxSteps) {
      return { action: DISCOVERY_ACTION.DONE, reason: "step-budget", idleAtBottom, exhausted: false };
    }
    if (!atBottom) {
      return { action: DISCOVERY_ACTION.SCROLL, reason: "more-below", idleAtBottom: 0, exhausted: false };
    }
    if (grew) {
      return { action: DISCOVERY_ACTION.WAIT_GROWTH, reason: "still-loading", idleAtBottom: 0, exhausted: false };
    }
    const idle = Math.max(0, Number(idleAtBottom) || 0) + 1;
    // Lazy loading has stalled for long enough that a control is worth using.
    if (paginationAvailable && idle >= IDLE_BOTTOM_LIMIT) {
      return { action: DISCOVERY_ACTION.PAGINATE, reason: "pagination", idleAtBottom: 0, exhausted: false };
    }
    if (idle < DISCOVERY_QUIET_SCANS) {
      return { action: DISCOVERY_ACTION.WAIT_GROWTH, reason: "retry-bottom", idleAtBottom: idle, exhausted: false };
    }
    return { action: DISCOVERY_ACTION.DONE, reason: "list-end", idleAtBottom: idle, exhausted: true };
  }

  // ------------------------------------------------------------ authentication
  // The extension never sees, asks for, or stores a credential. All it does is
  // read whether the browser already has a live LinkedIn session, so it can send
  // the user to LinkedIn's own sign-in page instead of driving a signed-out tab
  // in circles. "Signed in" is only ever concluded from evidence that a member
  // page actually rendered - never from the absence of a login wall, because a
  // blank or still-loading page has no login wall either.

  const AUTH_STATE = Object.freeze({
    SIGNED_IN: "signed-in",
    LOGIN_REQUIRED: "login-required",
    CHECKPOINT: "checkpoint",
    UNKNOWN: "unknown"
  });

  const MEMBER_PATH_PATTERN = /^\/(?:feed|mynetwork|in|messaging|notifications|jobs|search)\b/i;

  function isLinkedInUrl(url) {
    try {
      const parsed = new URL(String(url ?? ""));
      return /^(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com$/i.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  function linkedInPathname(url) {
    try {
      return new URL(String(url ?? "")).pathname;
    } catch {
      return "";
    }
  }

  /**
   * Decide what the browser's LinkedIn session looks like right now.
   *
   * `memberMarkers` is a count the caller takes from the rendered page (member
   * navigation, the profile-photo control, the connections list itself). It is
   * what separates "signed in" from "we could not tell": a signed-out page and a
   * page that has not finished rendering look identical without it.
   */
  function classifyAuthState({ url = "", title = "", bodyText = "", memberMarkers = 0, reachable = true } = {}) {
    const challenge = detectChallenge({ url, title, bodyText });
    if (challenge.challenged) {
      if (challenge.kind === "login") {
        return {
          state: AUTH_STATE.LOGIN_REQUIRED,
          kind: challenge.kind,
          signedIn: false,
          message: "You are not signed in to LinkedIn. Sign in in the browser, then start again."
        };
      }
      return { state: AUTH_STATE.CHECKPOINT, kind: challenge.kind, signedIn: false, message: challenge.message };
    }

    if (!reachable) {
      return { state: AUTH_STATE.UNKNOWN, kind: "", signedIn: false, message: "Could not read the LinkedIn tab to check the session." };
    }
    if (!isLinkedInUrl(url)) {
      return { state: AUTH_STATE.UNKNOWN, kind: "", signedIn: false, message: "The collector tab is not on LinkedIn." };
    }
    if (Number(memberMarkers) > 0 && MEMBER_PATH_PATTERN.test(linkedInPathname(url))) {
      return { state: AUTH_STATE.SIGNED_IN, kind: "", signedIn: true, message: "Signed in to LinkedIn." };
    }
    return {
      state: AUTH_STATE.UNKNOWN,
      kind: "",
      signedIn: false,
      message: "LinkedIn has not finished rendering a signed-in page yet."
    };
  }

  // -------------------------------------------------------- count reconciliation
  // LinkedIn's advertised total and the number of usable profile URLs rarely
  // agree exactly, and an unexplained gap is indistinguishable from discovery
  // having quietly stopped early. Every card the list rendered is therefore
  // accounted for as one of: a unique usable profile URL, a duplicate link to a
  // person already found, or a card that carries no usable profile link at all
  // (a restricted, out-of-network, or deleted member). The arithmetic is pure so
  // the report can be tested against a fixture.

  function createCardLedger() {
    // Usable cards are keyed by canonical URL and cards with no usable link by a
    // fingerprint of their visible text: a virtualized list shows the same card
    // again on a later scan, and neither counter may drift because of that.
    const usable = new Set();
    const unusable = new Map();
    const linkCounts = new Map();

    return {
      /** One rendered connection card. `url` is "" when it carried no usable link. */
      noteCard({ url = "", text = "", restricted = false } = {}) {
        if (url) {
          usable.add(String(url).toLowerCase());
          return "usable";
        }
        const key = normalizeLabel(text).toLowerCase().slice(0, 160);
        if (!key) return "ignored";
        const existing = unusable.get(key);
        if (existing) {
          if (restricted) existing.restricted = true;
          return "repeat";
        }
        unusable.set(key, { text: normalizeLabel(text).slice(0, 160), restricted: Boolean(restricted) });
        return "unusable";
      },
      /**
       * One profile anchor. Returns true when it points at a person who already
       * has a link — LinkedIn renders a photo link and a name link per card.
       */
      noteLink(url) {
        const key = String(url ?? "").toLowerCase();
        if (!key) return false;
        const count = (linkCounts.get(key) || 0) + 1;
        linkCounts.set(key, count);
        return count > 1;
      },
      get cardsSeen() { return usable.size + unusable.size; },
      get usableCards() { return usable.size; },
      get cardsWithoutUrl() { return unusable.size; },
      get restrictedCards() { return [...unusable.values()].filter((entry) => entry.restricted).length; },
      get duplicateLinks() {
        let extra = 0;
        for (const count of linkCounts.values()) extra += Math.max(0, count - 1);
        return extra;
      },
      samples(limit = 20) { return [...unusable.values()].slice(0, limit); },
      toJSON() {
        return {
          cardsSeen: this.cardsSeen,
          usableCards: this.usableCards,
          duplicateLinks: this.duplicateLinks,
          cardsWithoutUrl: this.cardsWithoutUrl,
          restrictedCards: this.restrictedCards,
          unusableSamples: this.samples()
        };
      }
    };
  }

  /** Fold two card ledgers' numbers together across passes. */
  function mergeCardCounts(left = {}, right = {}) {
    return {
      cardsSeen: Math.max(Number(left.cardsSeen) || 0, Number(right.cardsSeen) || 0),
      duplicateLinks: Math.max(Number(left.duplicateLinks) || 0, Number(right.duplicateLinks) || 0),
      cardsWithoutUrl: Math.max(Number(left.cardsWithoutUrl) || 0, Number(right.cardsWithoutUrl) || 0),
      restrictedCards: Math.max(Number(left.restrictedCards) || 0, Number(right.restrictedCards) || 0)
    };
  }

  /**
   * Explain the difference between what LinkedIn advertises and what was
   * actually collected — the "67 reported, 66 usable" question.
   *
   * `balanced` is true when every advertised connection is accounted for. When it
   * is false, `unexplained` is the number discovery cannot account for, which is
   * exactly the signal that the list was not fully enumerated.
   */
  function reconcileDiscovery({
    advertisedTotal = null,
    totalReliable = false,
    uniqueUrls = 0,
    duplicateLinks = 0,
    cardsWithoutUrl = 0,
    restrictedCards = 0
  } = {}) {
    const unique = Math.max(0, Number(uniqueUrls) || 0);
    const duplicates = Math.max(0, Number(duplicateLinks) || 0);
    const withoutUrl = Math.max(0, Number(cardsWithoutUrl) || 0);
    const restricted = Math.min(withoutUrl, Math.max(0, Number(restrictedCards) || 0));
    const total = Number.isFinite(Number(advertisedTotal)) && Number(advertisedTotal) > 0 ? Number(advertisedTotal) : null;
    const accountedFor = unique + withoutUrl;
    const unexplained = total === null ? 0 : total - accountedFor;

    const explanation = [];
    if (total === null) {
      explanation.push(`LinkedIn did not advertise a connection total. ${unique} unique profile URL(s) were collected.`);
    } else {
      explanation.push(
        `LinkedIn reports ${total}${totalReliable ? "" : "+"} connection(s); ` +
        `${unique} have a usable profile URL.`
      );
    }
    if (duplicates) explanation.push(`${duplicates} extra link(s) pointed at a person already collected (photo and name links to the same card).`);
    if (withoutUrl) {
      explanation.push(
        `${withoutUrl} card(s) carried no usable profile link` +
        (restricted ? `, of which ${restricted} were restricted, out of network, or no longer available.` : ".")
      );
    }
    if (total !== null && unexplained > 0) {
      explanation.push(`${unexplained} connection(s) are still unaccounted for — discovery may not have reached the end of the list.`);
    }
    if (total !== null && unexplained < 0) {
      explanation.push(`${Math.abs(unexplained)} more card(s) were found than LinkedIn advertised, which happens when the advertised total is stale or rounded.`);
    }
    if (total !== null && unexplained === 0) {
      explanation.push("Every connection LinkedIn advertised is accounted for.");
    }

    return {
      advertisedTotal: total,
      totalReliable: Boolean(totalReliable),
      uniqueUrls: unique,
      duplicateLinks: duplicates,
      cardsWithoutUrl: withoutUrl,
      restrictedCards: restricted,
      accountedFor,
      unexplained: total === null ? null : unexplained,
      balanced: total !== null && unexplained === 0,
      explanation
    };
  }

  // -------------------------------------------------------------- challenges

  function detectChallenge({ url = "", title = "", bodyText = "" } = {}) {
    const location = cleanUrlText(url);
    for (const rule of CHALLENGE_URL_RULES) {
      if (rule.pattern.test(location)) return { challenged: true, kind: rule.kind, message: rule.message };
    }
    const haystack = `${cleanUrlText(title)}\n${String(bodyText ?? "")}`.slice(0, 20000);
    for (const rule of CHALLENGE_TEXT_RULES) {
      if (rule.pattern.test(haystack)) return { challenged: true, kind: rule.kind, message: rule.message };
    }
    return { challenged: false, kind: "", message: "" };
  }

  const api = {
    PROFILE_PATH_PATTERN,
    CONNECTIONS_PATH_PATTERN,
    LOGIN_URL,
    CONNECTIONS_URL,
    AUTH_STATE,
    classifyAuthState,
    isLinkedInUrl,
    createCardLedger,
    mergeCardCounts,
    reconcileDiscovery,
    PAGINATION_ALLOWLIST,
    FORBIDDEN_CONTROL_PATTERN,
    DISCOVERY_ACTION,
    IDLE_BOTTOM_LIMIT,
    DISCOVERY_QUIET_SCANS,
    DISCOVERY_STEPS_PER_PASS,
    SCROLLABLE_EPSILON,
    chooseScrollTarget,
    canonicalizeConnectionUrl,
    isProfileUrl,
    isConnectionsPage,
    dedupeProfileUrls,
    cleanConnectionName,
    createEntryCollector,
    collectEntriesFromLinks,
    planDiscoveryStep,
    detectChallenge,
    classifyControl,
    isPaginationLabel,
    isForbiddenLabel,
    CONTACT_CONTROL_PATTERN,
    CONTACT_DISMISS_PATTERN,
    classifyContactControl,
    isContactControlLabel,
    OPEN_TO_WORK_CONTROL_PATTERN,
    classifyOpenToWorkControl,
    parseConnectionCount,
    normalizeLabel
  };

  globalThis.ProfileVaultConnections = api;
})();
