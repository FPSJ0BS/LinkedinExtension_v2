(() => {
  "use strict";

  const BUILD_ID = "2026-09-02-react-v3.14.1";
  const Core = globalThis.ProfileVaultCore;
  if (!Core) throw new Error("Profile Vault extraction core is unavailable.");
  // Optional: present on pages where connections-core.js is also injected.
  const Connections = globalThis.ProfileVaultConnections || null;

  const previous = globalThis.__PROFILE_VAULT_CONTENT__;
  if (previous?.handler) chrome.runtime.onMessage.removeListener(previous.handler);
  if (previous?.urlTimer) clearInterval(previous.urlTimer);
  if (previous?.visibilityHandler) document.removeEventListener("visibilitychange", previous.visibilityHandler);

  const state = {
    buildId: BUILD_ID,
    lastUrl: location.href,
    lastDiagnostics: null,
    /** The member this run is about. Stamped by extractProfile, cleared on a route. */
    profileUrl: "",
    extracting: null,
    handler: null,
    urlTimer: null,
    visibilityHandler: null,
    wentHidden: false,
    // The universal Stop's foothold on this page. The worker broadcasts
    // PV_STOP_ALL to every LinkedIn tab, and a scan already walking a profile
    // has to end at its next step rather than when its own budget runs out.
    aborted: false
  };
  globalThis.__PROFILE_VAULT_CONTENT__ = state;

  // ------------------------------------------------------------- visibility
  // LinkedIn does not render a hidden page and Chrome throttles it, so a scan of
  // a background tab sees an unchanging DOM. "Nothing changed for five reads" is
  // the exact signal that means the profile is complete, so a hidden page would
  // save whatever happened to be mounted. It must abort instead.

  function isPageVisible() {
    return document.visibilityState === "visible";
  }

  state.visibilityHandler = () => {
    if (!isPageVisible()) state.wentHidden = true;
  };
  document.addEventListener("visibilitychange", state.visibilityHandler);

  /** Thrown when the collector page is hidden mid-scan. */
  function hiddenPageError() {
    const error = new Error("Collector page is hidden; LinkedIn is not rendering it.");
    error.hidden = true;
    return error;
  }

  /** Thrown when the universal Stop was pressed. An interruption, not a failure. */
  function stoppedError() {
    const error = new Error("Collection was stopped.");
    error.stopped = true;
    return error;
  }

  const {
    cleanText,
    normalizeKey,
    isNoiseText,
    uniqueText,
    cleanEntityLines,
    canonicalizeProfileUrl,
    splitName,
    looksLikeDateRange,
    looksLikeLocation,
    parseExperienceLines,
    formatExperience,
    parseEducationLines
  } = Core;

  const SECTION_ALIASES = {
    about: ["about"],
    experience: ["experience"],
    education: ["education"],
    skills: ["skills"],
    certifications: ["licenses & certifications", "licenses and certifications", "certifications"],
    languages: ["languages"],
    interests: ["interests"]
  };

  /**
   * Headings that are read for nothing but WHERE THEY START.
   *
   * Live defect: a connection was saved under the name "Aakash Educational
   * Services Limited", with an institution and a skill to match — none of which
   * were on that member's profile. They were on the tiles inside Interests, the
   * block that renders OTHER entities. `locateSectionRoot` stops widening a
   * section when the container it is about to take would swallow a second
   * anchor, so a heading the map has never heard of does not stop anything: the
   * section above Interests kept widening straight through it and took its tiles
   * as its own entities.
   *
   * The answer is not a new rule about what an institution is — it is telling
   * the map where the next section begins. These are matched exactly like a real
   * section heading and then never extracted, so each one costs one boundary and
   * promises nothing. Everything LinkedIn renders below the collected sections
   * belongs here, and an unknown heading still costs nothing (rule 1).
   */
  const BOUNDARY_ALIASES = {
    activity: ["activity"],
    featured: ["featured"],
    highlights: ["highlights"],
    projects: ["projects"],
    publications: ["publications"],
    courses: ["courses"],
    honors: ["honors & awards", "honors and awards", "honours & awards", "honours and awards"],
    volunteering: ["volunteering", "volunteer experience"],
    organizations: ["organizations"],
    recommendations: ["recommendations"],
    testScores: ["test scores"],
    causes: ["causes"],
    peopleAlsoViewed: ["people also viewed"],
    peopleYouMayKnow: ["people you may know"],
    moreProfiles: ["more profiles for you", "explore premium profiles"]
  };

  const ALL_ANCHOR_ALIASES = { ...SECTION_ALIASES, ...BOUNDARY_ALIASES };
  const ALL_SECTION_LABELS = Object.values(ALL_ANCHOR_ALIASES).flat();
  const ACTION_PATTERN = /^(?:message|follow|connect|more|contact info|open to|add profile section|enhance profile|resources|show all|see more|show less|visit website|send profile|report|save|view profile)/i;
  const SOCIAL_PATTERN = /\b(?:followers?|connections?|mutual connections?|endorsements?|reactions?|comments?|reposts?|followed by)\b/i;
  const ROLE_PATTERN = /\b(?:developer|engineer|manager|student|founder|co-?founder|consultant|designer|analyst|recruiter|specialist|officer|lead|director|head|president|chief|advisor|board|researcher|freelancer|entrepreneur|owner|partner|architect|product|marketing|sales|operations)\b/i;
  const DEGREE_BADGE_PATTERN = /\s*(?:[·•]\s*)?(?:1st|2nd|3rd)(?:\+)?\s*$/i;
  const DURATION_ONLY_PATTERN = /^\d+\s+(?:yr|yrs|year|years|mo|mos|month|months)(?:\s+\d+\s+(?:mo|mos|month|months))?$/i;

  function isSupportedPage(url = location.href) {
    if (globalThis.__PROFILE_VAULT_TEST_PAGE__ === true) return true;
    try {
      const parsed = new URL(url);
      return /^(?:www\.)?linkedin\.com$/i.test(parsed.hostname) && /^\/in\/[^/]+\/?/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element.hidden) return false;
    if (element.closest(".visually-hidden,[class*='visually-hidden'],[class*='screen-reader']")) return false;
    if (element.getAttribute("aria-hidden") === "true" && !element.matches("span[aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
  }

  function isExcludedContext(element) {
    return Boolean(element?.closest([
      "aside",
      "footer",
      "nav",
      "[role='complementary']",
      "[role='navigation']",
      ".scaffold-layout__aside",
      ".msg-overlay-list-bubble",
      ".msg-overlay-conversation-bubble",
      "[data-test-modal]",
      "dialog:not([open])"
    ].join(",")));
  }

  /**
   * The element that holds the profile itself.
   *
   * Enumerated with querySelectorAll and scored by how many entity blocks it
   * carries, so a layout that renders the profile outside a plain <main> is still
   * found. `document.body` is only ever the answer when there is no main at all -
   * it would otherwise always win on count while dragging in the sidebar.
   */
  function profileRoot() {
    const candidates = [...document.querySelectorAll("main,[role='main'],[class*='scaffold-layout__main']")]
      .filter((element) => element instanceof Element && !isExcludedContext(element));
    let best = null;
    let bestScore = 0;
    for (const element of candidates) {
      const score = element.querySelectorAll(
        "section,[data-view-name*='profile-component-entity'],.pvs-entity,.pvs-list__paged-list-item"
      ).length;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best || document.querySelector("main") || document.body;
  }

  // ------------------------------------------------------- the scroll container
  // Identical root cause to the connections list: LinkedIn's scaffold layout can
  // pin the document at `height: 100vh` and scroll a wrapper above the profile.
  // A scan driven by `window.scrollY` then never moves, `maxScrollTop()` collapses
  // to zero, the very first read looks like the bottom, and the profile is saved
  // from whatever happened to be mounted at the top. The chooser is the pure,
  // tested one from the connections core, which is injected on profile pages too.

  function elementDepth(element) {
    let depth = 0;
    for (let current = element?.parentElement; current; current = current.parentElement) depth += 1;
    return depth;
  }

  function describeScrollCandidate(element, root, isScrollingElement = false) {
    if (!(element instanceof Element)) return null;
    const style = getComputedStyle(element);
    const isRoot = isScrollingElement || element === document.documentElement || element === document.body;
    return {
      element,
      id: isScrollingElement ? "document" : `${element.tagName.toLowerCase()}#${elementDepth(element)}`,
      isScrollingElement,
      overflowY: `${style.overflowY} ${style.overflow}`,
      scrollHeight: element.scrollHeight,
      clientHeight: isRoot ? Math.max(element.clientHeight, window.innerHeight) : element.clientHeight,
      containsList: Boolean(root) && (element === root || element.contains(root)),
      depth: elementDepth(element)
    };
  }

  /** The document, then every ancestor of the profile, then the profile itself. */
  function scrollCandidates(root) {
    const seen = new Set();
    const output = [];
    const add = (element, isScrollingElement = false) => {
      if (!(element instanceof Element) || seen.has(element)) return;
      seen.add(element);
      const described = describeScrollCandidate(element, root, isScrollingElement);
      if (described) output.push(described);
    };
    add(document.scrollingElement || document.documentElement, true);
    add(document.documentElement);
    add(document.body);
    for (let current = root; current; current = current.parentElement) add(current);
    return output;
  }

  function chooseScrollTarget(root) {
    if (!Connections?.chooseScrollTarget) return null;
    return Connections.chooseScrollTarget(scrollCandidates(root));
  }

  function currentScrollTop(target) {
    if (!target?.element) return window.scrollY;
    return target.isScrollingElement ? Math.max(window.scrollY, target.element.scrollTop) : target.element.scrollTop;
  }

  function maxScrollPosition(target) {
    if (!target?.element) return Math.max(0, documentHeight() - window.innerHeight);
    return Math.max(0, target.element.scrollHeight - target.clientHeight);
  }

  function scrollProfileTo(top, target) {
    const value = Math.max(0, Math.min(Number(top) || 0, maxScrollPosition(target)));
    if (!target?.element || target.isScrollingElement) window.scrollTo({ top: value, behavior: "auto" });
    if (target?.element) target.element.scrollTop = value;
  }

  function directText(element) {
    const values = [];
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) values.push(node.nodeValue || "");
      else if (node.nodeName === "BR") values.push("\n");
    }
    return cleanText(values.join(" "));
  }

  function candidateText(element) {
    const own = directText(element);
    if (own) return own;
    if (element.matches("h1,h2,h3,h4,p,a,[role='heading'],span[aria-hidden='true']")) {
      return cleanText(element.innerText || element.textContent);
    }
    if (element.children.length === 0) return cleanText(element.textContent);
    if (element.children.length === 1 && cleanText(element.innerText).length <= 240) return cleanText(element.innerText);
    return "";
  }

  function compareVisual(a, b) {
    const topDelta = a.rect.top - b.rect.top;
    if (Math.abs(topDelta) > 2) return topDelta;
    const leftDelta = a.rect.left - b.rect.left;
    if (Math.abs(leftDelta) > 2) return leftDelta;
    return a.order - b.order;
  }

  function collectCandidates(root, { maxLength = 500, selector = "h1,h2,h3,h4,p,a,span,div,li,[role='heading']" } = {}) {
    if (!root) return [];
    const output = [];
    let order = 0;
    const elements = root.matches?.(selector) ? [root, ...root.querySelectorAll(selector)] : [...root.querySelectorAll(selector)];
    for (const element of elements) {
      order += 1;
      if (!isVisible(element) || isExcludedContext(element)) continue;
      const text = candidateText(element);
      if (!text || text.length > maxLength || isNoiseText(text)) continue;
      if (ACTION_PATTERN.test(text) || /^\d+[,.]?\d*$/.test(text)) continue;
      output.push({
        text,
        element,
        order,
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        rect: element.getBoundingClientRect()
      });
    }

    const byText = new Map();
    for (const item of output) {
      const key = item.text.toLowerCase();
      const existing = byText.get(key);
      const itemDepth = item.element.querySelectorAll("*").length;
      const existingDepth = existing?.element.querySelectorAll("*").length ?? Infinity;
      if (!existing || itemDepth < existingDepth) byText.set(key, item);
    }
    return [...byText.values()].sort(compareVisual);
  }

  function stripDegreeBadge(value) {
    return cleanText(value).replace(DEGREE_BADGE_PATTERN, "").trim();
  }

  function stripTopCardControls(value) {
    return cleanText(value)
      .replace(/\s*[·•]\s*contact info\s*$/i, "")
      .replace(/\s*[·•]\s*(?:1st|2nd|3rd)(?:\+)?\s*$/i, "")
      .trim();
  }

  function scorePortrait(image, fullName = "") {
    if (!isVisible(image) || isExcludedContext(image)) return -100;
    const rect = image.getBoundingClientRect();
    const alt = cleanText(image.alt);
    const src = image.currentSrc || image.src || "";
    let score = 0;
    if (/profile-displayphoto|profile-framedphoto|shrink_\d+_/i.test(src)) score += 14;
    if (/profile|photo|avatar/i.test(`${alt} ${src}`)) score += 4;
    if (fullName && alt.toLowerCase().includes(fullName.toLowerCase())) score += 12;
    if (rect.width >= 72 && rect.height >= 72) score += 5;
    if (rect.top < 1400) score += 3;
    const ratio = rect.height ? rect.width / rect.height : 0;
    if (ratio >= 0.72 && ratio <= 1.4) score += 6;
    if (ratio > 1.8 || /background|banner|cover|logo|icon|company/i.test(`${alt} ${src}`)) score -= 18;
    return score;
  }

  function findBestPortrait(main, fullName = "") {
    return [...main.querySelectorAll("img")]
      .map((image) => ({ image, score: scorePortrait(image, fullName) }))
      .sort((a, b) => b.score - a.score)[0] || null;
  }

  function findTopCard(main) {
    const portrait = findBestPortrait(main);
    const image = portrait?.score > 4 ? portrait.image : null;
    if (image) {
      const semantic = image.closest("section,[data-view-name*='profile-card'],[data-view-name*='profile-top-card']");
      if (semantic && semantic !== main) {
        const length = cleanText(semantic.innerText).length;
        if (length >= 20 && length <= 6000) return { topCard: semantic, portrait: image };
      }
      let current = image.parentElement;
      let best = null;
      for (let depth = 0; depth < 9 && current && current !== main; depth += 1, current = current.parentElement) {
        const text = cleanText(current.innerText);
        if (text.length < 20 || text.length > 6000) continue;
        const hasActions = /\b(?:follow|message|contact info|open to)\b/i.test(text);
        if ((hasActions || current.querySelectorAll("button,a").length >= 2) && !best) best = current;
        if (current.tagName === "SECTION" && best) break;
      }
      if (best) return { topCard: best, portrait: image };
    }

    const sections = [...main.querySelectorAll("section")].filter((section) => {
      if (!isVisible(section) || isExcludedContext(section)) return false;
      const text = cleanText(section.innerText);
      return text.length >= 20 && text.length <= 6000 && /\b(?:follow|message|contact info|followers?|connections?)\b/i.test(text);
    });
    return { topCard: sections[0] || main.firstElementChild || main, portrait: image };
  }

  function looksLikePersonName(value) {
    const text = stripDegreeBadge(value);
    if (!text || text.length < 2 || text.length > 90) return false;
    if (ACTION_PATTERN.test(text) || SOCIAL_PATTERN.test(text) || ROLE_PATTERN.test(text) || looksLikeLocation(text)) return false;
    if (/\b(?:linkedin|premium|profile|activity|experience|education|skills?)\b/i.test(text)) return false;
    if (/\d/.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 7) return false;
    return words.every((word) => /^[\p{L}][\p{L}'’.\-]*$/u.test(word));
  }

  /**
   * The member's own page, as the name check needs it.
   *
   * `state.profileUrl` is stamped once at the start of a run and is what a scan
   * trusts; reading `location.href` is the fallback for a snapshot taken outside
   * one, and is canonicalized because LinkedIn routes an opened overlay into the
   * address bar.
   */
  function currentProfileUrl() {
    return state.profileUrl || canonicalizeProfileUrl(location.href);
  }

  /**
   * Is this candidate the name of THIS member?
   *
   * `looksLikePersonName` answers "is it shaped like a name" — and a company on a
   * followed-companies tile is shaped exactly like one, which is how "Aakash
   * Educational Services Limited" became a saved connection. This adds the only
   * check that can tell them apart without guessing at position: an
   * organization-shaped value is refused unless the profile's OWN URL says that
   * is who this page is about.
   */
  function acceptNameCandidate(value, profileUrl) {
    if (!looksLikePersonName(value)) return false;
    if (!Core.looksLikeOrganizationName(value)) return true;
    return Core.nameSlugAgreement(value, profileUrl) === "exact";
  }

  /**
   * What the profile's own URL is worth to a candidate's score.
   *
   * A conflict is penalized rather than refused: a member who changed their
   * display name after the slug was minted still has a real name on the page,
   * and any candidate the slug DOES agree with will outscore it anyway.
   */
  function slugNameBonus(value, profileUrl) {
    switch (Core.nameSlugAgreement(value, profileUrl)) {
      case "exact": return 30;
      case "partial": return 14;
      case "conflict": return -25;
      default: return 0;
    }
  }

  function normalizePortraitAlt(value) {
    return stripDegreeBadge(cleanText(value)
      .replace(/^profile (?:photo|picture) of\s+/i, "")
      .replace(/[’']s profile (?:photo|picture)$/i, "")
      .replace(/\s+profile (?:photo|picture)$/i, ""));
  }

  function extractName(topCard, portrait, profileUrl = currentProfileUrl()) {
    const candidates = [];
    const add = (value, base, source, element) => {
      if (!acceptNameCandidate(value, profileUrl)) return;
      candidates.push({ value, score: base + slugNameBonus(value, profileUrl), source, element });
    };

    const explicitSelectors = [
      "h1",
      "[role='heading'][aria-level='1']",
      "[data-anonymize='person-name']",
      "[class*='text-heading-xlarge']"
    ];
    for (const selector of explicitSelectors) {
      for (const element of topCard.querySelectorAll(selector)) {
        if (!isVisible(element) || isExcludedContext(element)) continue;
        add(stripDegreeBadge(element.innerText || element.textContent), 30, selector, element);
      }
    }

    add(normalizePortraitAlt(portrait?.alt || ""), 26, "portrait-alt", portrait);

    const lines = collectCandidates(topCard, { maxLength: 140 });
    for (const candidate of lines) {
      const value = stripDegreeBadge(candidate.text);
      let score = 8;
      if (candidate.tag === "H1") score += 20;
      if (/text-heading-xlarge|break-words/i.test(candidate.className)) score += 12;
      const words = value.split(/\s+/).length;
      if (words >= 2 && words <= 4) score += 5;
      if (portrait) {
        const portraitRect = portrait.getBoundingClientRect();
        if (Math.abs(candidate.rect.top - portraitRect.top) < 260) score += 4;
      }
      add(value, score, candidate.tag, candidate.element);
    }

    const titleName = cleanText(document.title).replace(/\s*[|–-]\s*LinkedIn.*$/i, "");
    add(titleName, 12, "document-title", null);

    candidates.sort((a, b) => b.score - a.score);
    return { value: candidates[0]?.value || "", candidates: candidates.slice(0, 10).map(({ value, score, source }) => ({ text: value, score, source })) };
  }

  function isPlausibleHeadline(value, fullName) {
    const text = stripTopCardControls(value);
    if (!text || text === fullName || text.length < 4 || text.length > 280) return false;
    if (ACTION_PATTERN.test(text) || SOCIAL_PATTERN.test(text) || looksLikeLocation(text)) return false;
    if (/^(?:about|activity|experience|education|skills?|interests)$/i.test(text)) return false;
    return true;
  }

  function extractHeadlineAndLocation(topCard, fullName) {
    const candidates = collectCandidates(topCard, { maxLength: 300 });
    const normalizedName = normalizeKey(fullName);
    const lines = candidates
      .map((item) => ({ ...item, cleaned: stripTopCardControls(item.text) }))
      .filter((item) => item.cleaned && normalizeKey(item.cleaned) !== normalizedName);

    const nameIndex = lines.findIndex((item) => normalizeKey(stripDegreeBadge(item.text)) === normalizedName);
    const ordered = nameIndex >= 0 ? lines.slice(nameIndex + 1) : lines;

    const headlineCandidates = [];
    const locationCandidates = [];
    ordered.slice(0, 18).forEach((item, index) => {
      const text = item.cleaned;
      if (isPlausibleHeadline(text, fullName)) {
        let score = 12 - Math.min(index, 10);
        if (ROLE_PATTERN.test(text)) score += 10;
        if (/[|@]|\b(?:at|with)\b|\s[-–—]\s/i.test(text)) score += 3;
        if (/text-body-medium/i.test(item.className)) score += 6;
        if (text.includes("\n")) score -= 5;
        headlineCandidates.push({ text, score, tag: item.tag });
      }

      if (text !== fullName && text.length <= 150 && !ACTION_PATTERN.test(text) && !SOCIAL_PATTERN.test(text) && !ROLE_PATTERN.test(text)) {
        let score = 0;
        if (looksLikeLocation(text)) score += 10;
        if (/\b(?:india|united states|united kingdom|canada|australia|singapore|uae|germany|france|japan)\b/i.test(text)) score += 6;
        if ((text.match(/,/g) || []).length >= 1 && text.split(",").length <= 4) score += 3;
        if (/text-body-small|t-black--light/i.test(item.className)) score += 4;
        if (index > 0 && index < 10) score += 2;
        if (text.includes("\n")) score -= 7;
        locationCandidates.push({ text, score, tag: item.tag });
      }
    });

    headlineCandidates.sort((a, b) => b.score - a.score);
    const headline = headlineCandidates[0]?.score > 0 ? headlineCandidates[0].text : "";

    locationCandidates
      .filter((item) => item.text !== headline)
      .sort((a, b) => b.score - a.score);
    const location = locationCandidates.find((item) => item.text !== headline && item.score >= 8)?.text || "";

    return {
      headline,
      location,
      headlineCandidates: headlineCandidates.slice(0, 10),
      locationCandidates: locationCandidates.sort((a, b) => b.score - a.score).slice(0, 10),
      lines: ordered.slice(0, 24).map((item) => item.cleaned)
    };
  }

  function normalizeSectionLabel(value) {
    return normalizeKey(value)
      .replace(/\s*\(\d+\)\s*$/g, "")
      .replace(/\s+\d+\s*$/g, "")
      .replace(/\s*[·•]\s*$/g, "");
  }

  function matchSectionKey(value) {
    const normalized = normalizeSectionLabel(value);
    // Boundaries are matched here with the collected sections, and dropped again
    // in collectSections — one map of where every section starts, one list of
    // the ones worth reading.
    for (const [key, aliases] of Object.entries(ALL_ANCHOR_ALIASES)) {
      if (aliases.some((alias) => normalized === alias)) return key;
    }
    return "";
  }

  function sectionAnchorText(element) {
    const own = directText(element);
    if (own && own.length <= 100) return own;
    if (element.childElementCount <= 2) {
      const text = cleanText(element.innerText || element.textContent);
      if (text.length <= 100) return text;
    }
    return "";
  }

  function findSectionAnchors(main) {
    const selector = "h2,h3,h4,[role='heading'],div,span,p,a";
    const found = new Map();
    let order = 0;
    for (const element of main.querySelectorAll(selector)) {
      order += 1;
      if (!isVisible(element) || isExcludedContext(element)) continue;
      const text = sectionAnchorText(element);
      const key = matchSectionKey(text);
      if (!key) continue;
      const rect = element.getBoundingClientRect();
      let score = 0;
      if (/^H[2-4]$/.test(element.tagName)) score += 10;
      if (element.getAttribute("role") === "heading") score += 8;
      if (/pvs-header|heading|title/i.test(typeof element.className === "string" ? element.className : "")) score += 4;
      if (element.childElementCount === 0) score += 2;
      const current = found.get(key);
      const candidate = { key, text, element, rect, order, score };
      if (!current || score > current.score || (score === current.score && compareVisual(candidate, current) < 0)) found.set(key, candidate);
    }
    return [...found.values()].sort(compareVisual);
  }

  function locateSectionRoot(anchor, main, allAnchors) {
    const semantic = anchor.element.closest("section,[data-view-name*='profile-section'],[data-view-name*='profile-card']");
    if (semantic && semantic !== main && !isExcludedContext(semantic)) {
      const textLength = cleanText(semantic.innerText).length;
      if (textLength > anchor.text.length + 10 && textLength < 50000) return semantic;
    }

    let current = anchor.element.parentElement;
    let best = null;
    for (let depth = 0; depth < 10 && current && current !== main; depth += 1, current = current.parentElement) {
      const textLength = cleanText(current.innerText).length;
      if (textLength <= anchor.text.length + 10 || textLength > 50000) continue;
      const containedAnchors = allAnchors.filter((item) => current.contains(item.element));
      const entityCount = current.querySelectorAll("li,[data-view-name*='profile-component-entity'],.pvs-entity,.pvs-list__paged-list-item").length;
      if (containedAnchors.length <= 1 && (entityCount > 0 || current.children.length > 1)) {
        best = current;
        if (entityCount > 0 || current.tagName === "SECTION") break;
      }
    }
    return best || anchor.element.parentElement;
  }

  function buildSectionMap(main) {
    const anchors = findSectionAnchors(main);
    const map = {};
    for (const anchor of anchors) {
      map[anchor.key] = { ...anchor, root: locateSectionRoot(anchor, main, anchors) };
    }
    return map;
  }

  function inferEntityBlocksByDate(section) {
    const dateElements = [...section.querySelectorAll("span,p,div,a,time")]
      .filter((element) => isVisible(element) && !isExcludedContext(element))
      .filter((element) => {
        const text = candidateText(element);
        return text && text.length <= 160 && looksLikeDateRange(text);
      });

    const inferred = [];
    for (const dateElement of dateElements) {
      let current = dateElement.parentElement;
      let best = null;
      for (let depth = 0; depth < 7 && current && current !== section; depth += 1, current = current.parentElement) {
        const text = cleanText(current.innerText);
        if (text.length < 18 || text.length > 6000) continue;
        const dateCount = uniqueText(collectCandidates(current, { maxLength: 180 })
          .map((item) => item.text)
          .filter(looksLikeDateRange)).length;
        const lineCount = linesForEntity(current).length;
        if (dateCount === 1 && lineCount >= 3) best = current;
        if (best && current.parentElement === section) break;
      }
      if (best) inferred.push(best);
    }

    const unique = [...new Set(inferred)];
    return unique.filter((element) => !unique.some((other) => other !== element && element.contains(other)));
  }

  function topLevelEntityBlocks(section) {
    if (!section) return [];
    const preferredSelectors = [
      ".pvs-list__paged-list-item",
      "[data-view-name*='profile-component-entity']",
      ".pvs-entity"
    ];
    for (const selector of preferredSelectors) {
      const candidates = [...section.querySelectorAll(selector)]
        .filter((element) => isVisible(element) && !isExcludedContext(element) && cleanText(element.innerText).length > 8);
      const blocks = candidates.filter((element) => !candidates.some((parent) => parent !== element && parent.contains(element)));
      if (blocks.length) return blocks;
    }

    const visibleLis = [...section.querySelectorAll("li")]
      .filter((element) => isVisible(element) && !isExcludedContext(element) && cleanText(element.innerText).length > 8);
    const lis = visibleLis.filter((element) => !visibleLis.some((parent) => parent !== element && parent.contains(element)));
    if (lis.length) return lis;

    const inferred = inferEntityBlocksByDate(section);
    if (inferred.length) return inferred;

    return [...section.children].filter((element) => isVisible(element) && !isExcludedContext(element) && cleanText(element.innerText).length > 20);
  }

  function cleanEntityLine(value) {
    return cleanText(value)
      .replace(/^\s*[·•]\s*/, "")
      .replace(/\s*[·•]\s*(?:full[- ]time|part[- ]time|self-employed|freelance|contract|internship|apprenticeship|seasonal|temporary)\s*$/i, (match) => match)
      .trim();
  }

  function linesForEntity(block, sectionNames = []) {
    const aliases = sectionNames.map(normalizeSectionLabel);
    const candidates = collectCandidates(block, { maxLength: 1400 })
      .map((item) => cleanEntityLine(item.text));
    return cleanEntityLines(candidates)
      .filter((line) => !aliases.includes(normalizeSectionLabel(line)))
      .filter((line) => !ACTION_PATTERN.test(line) && !SOCIAL_PATTERN.test(line))
      .filter((line) => !DURATION_ONLY_PATTERN.test(line));
  }

  function linesForSection(info) {
    if (!info?.root) return [];
    const aliases = SECTION_ALIASES[info.key] || [];
    return linesForEntity(info.root, aliases)
      .filter((line) => !ALL_SECTION_LABELS.some((label) => normalizeSectionLabel(line) === label));
  }

  function findNestedRoleBlocks(block) {
    const nested = [...block.querySelectorAll("li,[data-view-name*='profile-component-entity'],.pvs-entity")]
      .filter((element) => element !== block && isVisible(element) && linesForEntity(element).some(looksLikeDateRange));
    return nested.filter((element) => !nested.some((parent) => parent !== element && parent.contains(element)));
  }

  function isPlausibleExperienceRecord(record) {
    return Boolean(
      record?.title &&
      !looksLikeDateRange(record.title) &&
      !looksLikeLocation(record.title) &&
      !ACTION_PATTERN.test(record.title) &&
      !SOCIAL_PATTERN.test(record.title)
    );
  }

  function parseFlatExperience(lines) {
    const values = cleanEntityLines(lines)
      .filter((line) => !ACTION_PATTERN.test(line) && !SOCIAL_PATTERN.test(line) && !DURATION_ONLY_PATTERN.test(line));
    const records = [];
    const dateIndexes = values.map((line, index) => looksLikeDateRange(line) ? index : -1).filter((index) => index >= 0);
    for (let datePosition = 0; datePosition < dateIndexes.length; datePosition += 1) {
      const dateIndex = dateIndexes[datePosition];
      const previousDate = datePosition > 0 ? dateIndexes[datePosition - 1] : -1;
      const start = Math.max(previousDate + 1, dateIndex - 4);
      const before = values.slice(start, dateIndex)
        .filter((line) => !looksLikeLocation(line) && !DURATION_ONLY_PATTERN.test(line))
        .slice(-3);
      if (!before.length) continue;
      const nextDate = datePosition + 1 < dateIndexes.length ? dateIndexes[datePosition + 1] : values.length;
      const after = values.slice(dateIndex + 1, Math.min(nextDate, dateIndex + 4));
      const parsed = parseExperienceLines([...before, values[dateIndex], ...after]);
      if (isPlausibleExperienceRecord(parsed)) records.push(parsed);
    }
    return records;
  }

  function findCompanyUrl(block) {
    if (!block) return "";
    const anchor = [...block.querySelectorAll("a[href]")].find((element) => {
      if (!isVisible(element) || isExcludedContext(element)) return false;
      try { return /^\/company\//i.test(new URL(element.href, location.href).pathname); } catch { return false; }
    });
    return anchor ? canonicalizeProfileUrl(anchor.href) : "";
  }

  function findCompanyImageUrl(block) {
    if (!block) return "";
    const candidates = [...block.querySelectorAll("img")]
      .filter((image) => isVisible(image) && !isExcludedContext(image))
      .map((image) => {
        const rect = image.getBoundingClientRect();
        const source = image.currentSrc || image.src || "";
        const label = cleanText(image.alt || image.getAttribute("aria-label"));
        let score = 0;
        if (rect.width >= 32 && rect.width <= 120 && rect.height >= 32 && rect.height <= 120) score += 6;
        if (Math.abs(rect.width - rect.height) <= 20) score += 4;
        if (/company|organization|logo/i.test(`${label} ${source}`)) score += 3;
        if (/profile|background|banner|cover|emoji|icon/i.test(`${label} ${source}`)) score -= 8;
        return { source, score };
      })
      .filter((item) => item.source)
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.score > 0 ? candidates[0].source : "";
  }

  function extractExperience(info, diagnostics) {
    const records = [];
    const blocks = topLevelEntityBlocks(info?.root);
    diagnostics.renderedBlocks = Math.max(diagnostics.renderedBlocks || 0, blocks.length);

    for (const block of blocks) {
      const nestedRoles = findNestedRoleBlocks(block);
      if (nestedRoles.length) {
        const outerCandidates = collectCandidates(block).filter((candidate) => !nestedRoles.some((nested) => nested.contains(candidate.element)));
        const outerLines = uniqueText(outerCandidates.map((item) => item.text))
          .filter((line) => !SECTION_ALIASES.experience.some((name) => normalizeSectionLabel(line) === name))
          .filter((line) => !looksLikeDateRange(line) && !SOCIAL_PATTERN.test(line) && !ACTION_PATTERN.test(line));
        // The company card's own label. Employment metadata that shares the
        // header ("Full-time", "9 mos") must never become the company name.
        const company = outerLines
          .filter((line) => line.length <= 180 && !looksLikeLocation(line))
          .map((line) => Core.sanitizeCompanyName(line))
          .find(Boolean) || "";
        const companyUrl = findCompanyUrl(block);
        const companyImageUrl = findCompanyImageUrl(block);
        for (const role of nestedRoles) {
          const parsed = parseExperienceLines(linesForEntity(role, SECTION_ALIASES.experience), company, companyUrl || findCompanyUrl(role));
          if (parsed) parsed.companyImageUrl = companyImageUrl || findCompanyImageUrl(role);
          if (isPlausibleExperienceRecord(parsed)) records.push(parsed);
        }
      } else {
        const parsed = parseExperienceLines(linesForEntity(block, SECTION_ALIASES.experience), "", findCompanyUrl(block));
        if (parsed) parsed.companyImageUrl = findCompanyImageUrl(block);
        if (isPlausibleExperienceRecord(parsed)) records.push(parsed);
      }
    }

    const flatRecords = parseFlatExperience(linesForSection(info));
    records.push(...flatRecords);

    const deduped = [];
    const seen = new Set();
    for (const record of records) {
      const key = [record.title, record.company, record.dateRange].map((value) => cleanText(value).toLowerCase()).join("|");
      if (!key.replace(/\|/g, "") || seen.has(key)) continue;
      seen.add(key);
      deduped.push(record);
    }
    diagnostics.parsedRecords = Math.max(diagnostics.parsedRecords || 0, deduped.length);
    return deduped;
  }

  function parseEducationRecord(lines) {
    const values = cleanEntityLines(lines)
      .filter((line) => !SECTION_ALIASES.education.some((name) => normalizeSectionLabel(line) === name))
      .filter((line) => !ACTION_PATTERN.test(line) && !SOCIAL_PATTERN.test(line));
    if (!values.length) return null;
    const dateIndex = values.findIndex(looksLikeDateRange);
    if (dateIndex > 0) return parseEducationLines(values);
    if (dateIndex === 0) {
      const following = values.slice(1).filter((line) => !looksLikeDateRange(line));
      if (!following.length) return null;
      return {
        institution: following[0] || "",
        degree: following.slice(1, 3).join(" | "),
        dates: values[0],
        details: following.slice(3).join(" ")
      };
    }
    return parseEducationLines(values);
  }

  function parseFlatEducation(lines) {
    const values = cleanEntityLines(lines).filter((line) => !ACTION_PATTERN.test(line) && !SOCIAL_PATTERN.test(line));
    const records = [];
    const dateIndexes = values.map((line, index) => looksLikeDateRange(line) ? index : -1).filter((index) => index >= 0);
    for (const dateIndex of dateIndexes) {
      const before = values.slice(Math.max(0, dateIndex - 4), dateIndex).slice(-3);
      const record = parseEducationRecord([...before, values[dateIndex]]);
      if (record?.institution && !looksLikeDateRange(record.institution)) records.push(record);
    }
    return records;
  }

  function extractEducation(info, diagnostics) {
    const blocks = topLevelEntityBlocks(info?.root);
    const records = blocks.map((block) => parseEducationRecord(linesForEntity(block, SECTION_ALIASES.education)))
      .filter((record) => record?.institution && !looksLikeDateRange(record.institution));
    if (!records.length) records.push(...parseFlatEducation(linesForSection(info)));
    diagnostics.renderedBlocks = Math.max(diagnostics.renderedBlocks || 0, blocks.length);
    diagnostics.parsedRecords = Math.max(diagnostics.parsedRecords || 0, records.length);
    // Records, not formatted strings: the accumulator keys them by institution +
    // degree + dates and groups them into one card per institution at the end.
    return records;
  }

  function isSimpleTitleNoise(line) {
    return ACTION_PATTERN.test(line) || SOCIAL_PATTERN.test(line) || looksLikeDateRange(line) || DURATION_ONLY_PATTERN.test(line) ||
      Core.SKILL_CONTROL_PATTERN.test(line) ||
      /\b(?:endorsed by|proficiency|credential id|issued|expires)\b/i.test(line);
  }

  /**
   * The heading of a skill / language card.
   *
   * A skill card renders its name as a heading or as a link into skill search,
   * and then an "Endorse" button and the role the skill was used in. Reading the
   * card's whole innerText is what saved "Endorse" and "Associate Software
   * Engineer at TechMatrix Consulting Endorse" as skills, so the heading is
   * preferred and the container text is only a last resort.
   */
  function entityHeadingText(block, sectionNames) {
    const headingSelectors = [
      "[data-field='skill_card_skill_topic']",
      "a[href*='/search/results/all/'] span[aria-hidden='true']",
      "a[data-field*='skill'] span[aria-hidden='true']",
      "[class*='pvs-entity__path-node']",
      "[class*='t-bold'] span[aria-hidden='true']",
      "[class*='t-bold']",
      "h3,h4,[role='heading']"
    ];
    for (const selector of headingSelectors) {
      for (const element of block.querySelectorAll(selector)) {
        if (!isVisible(element) || isExcludedContext(element)) continue;
        const text = stripTopCardControls(cleanText(element.innerText || element.textContent));
        if (!text || text.length > 180 || isSimpleTitleNoise(text)) continue;
        if (sectionNames.some((name) => normalizeSectionLabel(text) === name)) continue;
        return text;
      }
    }
    return "";
  }

  function firstEntityTitle(block, sectionNames) {
    const heading = entityHeadingText(block, sectionNames);
    if (heading) return heading;
    return linesForEntity(block, sectionNames)
      .map(stripTopCardControls)
      .filter((line) => line.length <= 180)
      .find((line) => !isSimpleTitleNoise(line) && !sectionNames.some((name) => normalizeSectionLabel(line) === name)) || "";
  }

  function extractSimpleTitles(info, sectionNames, diagnostics, limit = 50) {
    const blocks = topLevelEntityBlocks(info?.root);
    let values = blocks.map((block) => firstEntityTitle(block, sectionNames)).filter(Boolean);
    // The section-wide sweep is a fallback for a layout with no entity blocks at
    // all. Running it unconditionally dragged every button label and role
    // sentence in the section into the skill list.
    if (!values.length) {
      values = linesForSection(info)
        .map(stripTopCardControls)
        .filter((line) => line.length <= 180)
        .filter((line) => !isSimpleTitleNoise(line))
        .filter((line) => !sectionNames.some((name) => normalizeSectionLabel(line) === name));
    }
    values = uniqueText(values).slice(0, limit);
    diagnostics.renderedBlocks = Math.max(diagnostics.renderedBlocks || 0, blocks.length);
    diagnostics.parsedRecords = Math.max(diagnostics.parsedRecords || 0, values.length);
    return values;
  }

  function extractCertifications(info, diagnostics) {
    const blocks = topLevelEntityBlocks(info?.root);
    const records = blocks.map((block) => {
      const lines = linesForEntity(block, SECTION_ALIASES.certifications);
      if (!lines.length) return null;
      const name = lines.find((line) => !isSimpleTitleNoise(line)) || "";
      const issuer = lines.find((line) => line !== name && !looksLikeDateRange(line) && !/credential id/i.test(line)) || "";
      const date = lines.find(looksLikeDateRange) || lines.find((line) => /\bissued\b/i.test(line)) || "";
      const credentialId = lines.find((line) => /credential id/i.test(line)) || "";
      const credentialUrl = [...block.querySelectorAll("a[href]")]
        .filter((anchor) => isVisible(anchor) && !isExcludedContext(anchor))
        .map((anchor) => anchor.href)
        .find((href) => href && !/linkedin\.com\/(?:in|company|school)\//i.test(href)) || "";
      return name ? { name, issuer, date, credentialId, credentialUrl } : null;
    }).filter(Boolean);

    if (!records.length) {
      const lines = linesForSection(info).filter((line) => !isSimpleTitleNoise(line));
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (looksLikeDateRange(line) || /credential id/i.test(line)) continue;
        const next = lines[index + 1] || "";
        const following = lines[index + 2] || "";
        if (next && !looksLikeDateRange(next) && !/credential id/i.test(next)) {
          records.push({ name: line, issuer: next, date: looksLikeDateRange(following) ? following : "", credentialId: "", credentialUrl: "" });
          index += looksLikeDateRange(following) ? 2 : 1;
        }
      }
    }

    const limited = records.slice(0, 60);
    diagnostics.renderedBlocks = Math.max(diagnostics.renderedBlocks || 0, blocks.length);
    diagnostics.parsedRecords = Math.max(diagnostics.parsedRecords || 0, limited.length);
    // Records, not joined strings: the accumulator keys them by name + issuer +
    // issue date, so a re-render cannot produce a near-duplicate certificate.
    return limited;
  }

  function extractAbout(info) {
    if (!info?.root) return { text: "", partial: false };
    const candidates = collectCandidates(info.root, { maxLength: 5000 })
      .map((item) => stripTopCardControls(item.text))
      .filter((text) => !SECTION_ALIASES.about.some((name) => normalizeSectionLabel(text) === name))
      .filter((text) => !ACTION_PATTERN.test(text) && !SOCIAL_PATTERN.test(text))
      .filter((text) => text.length >= 20);
    const unique = uniqueText(candidates)
      .filter((text, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.length > text.length && other.includes(text)));
    const text = unique.sort((a, b) => b.length - a.length)[0] || "";
    const partial = [...info.root.querySelectorAll("button,a")]
      .some((element) => isVisible(element) && /see more|show more/i.test(cleanText(element.innerText || element.getAttribute("aria-label"))));
    return { text, partial };
  }

  function detectPartialSection(info, label) {
    if (!info?.root) return false;
    const controls = [...info.root.querySelectorAll("button,a")]
      .filter(isVisible)
      .map((element) => cleanText(element.innerText || element.getAttribute("aria-label")));
    return controls.some((text) => new RegExp(`(?:show|see) all(?: \\d+)? ${label}`, "i").test(text));
  }

  /**
   * The in-memory profile accumulator plus the DOM handles the scan needs.
   *
   * The accumulator itself is pure and lives in extraction-core.js, keyed exactly
   * as the entity rules require, so a section LinkedIn unmounts as the scan moves
   * past it stays in the record - and a later, more hydrated read of the same
   * entity enriches it instead of being dropped or duplicated.
   */
  function makeCollector() {
    return {
      data: Core.createProfileAccumulator(),
      topCard: null,
      portrait: null,
      snapshots: 0
    };
  }

  function collectSections(main, collector, diagnostics) {
    const sections = buildSectionMap(main);
    const before = collector.data.counts();
    collector.snapshots += 1;
    diagnostics.sectionHeadings = [];

    for (const key of Object.keys(SECTION_ALIASES)) {
      const info = sections[key];
      const sectionDiagnostics = diagnostics.sections[key] ||= {
        found: false,
        renderedBlocks: 0,
        parsedRecords: 0,
        anchorText: "",
        samples: []
      };
      if (!info) continue;
      sectionDiagnostics.found = true;
      sectionDiagnostics.anchorText = info.text;
      diagnostics.sectionHeadings.push(info.text);
      const sampleLines = linesForSection(info).slice(0, 30);
      sectionDiagnostics.samples = uniqueText([...sectionDiagnostics.samples, ...sampleLines]).slice(0, 50);

      if (key === "about") {
        const result = extractAbout(info);
        collector.data.addAbout(result.text);
        if (result.partial) collector.data.addPartialSection("about");
      } else if (key === "experience") {
        for (const record of extractExperience(info, sectionDiagnostics)) collector.data.addExperience(record);
        if (detectPartialSection(info, "experiences?|positions?")) collector.data.addPartialSection("experience");
      } else if (key === "education") {
        for (const record of extractEducation(info, sectionDiagnostics)) collector.data.addEducation(record);
        if (detectPartialSection(info, "education")) collector.data.addPartialSection("education");
      } else if (key === "skills") {
        for (const value of extractSimpleTitles(info, SECTION_ALIASES.skills, sectionDiagnostics, 100)) collector.data.addSkill(value);
        if (detectPartialSection(info, "skills?")) collector.data.addPartialSection("skills");
      } else if (key === "certifications") {
        for (const record of extractCertifications(info, sectionDiagnostics)) collector.data.addCertification(record);
        if (detectPartialSection(info, "licenses|certifications?")) collector.data.addPartialSection("certifications");
      } else if (key === "languages") {
        for (const value of extractSimpleTitles(info, SECTION_ALIASES.languages, sectionDiagnostics, 40)) collector.data.addLanguage(value);
      } else if (key === "interests") {
        // Names only. Every tile in here belongs to somebody who is not this
        // member, so nothing but the name is read from it — rule 2 names this
        // exact block as the one a stranger's details once came out of.
        for (const value of extractSimpleTitles(info, SECTION_ALIASES.interests, sectionDiagnostics, 60)) {
          collector.data.addInterest(value);
        }
      }
    }

    // Contact details and CV links are not a section: they are scattered across
    // the top card, the Featured documents, and the body text, and they hydrate
    // at different times. Reading them on every snapshot is what makes the
    // merge-only accumulator keep them.
    collectRenderedContacts(main, collector);
    collectFeaturedDocuments(main, collector);

    const after = collector.data.counts();
    diagnostics.newExperience = after.experience - before.experience;
    diagnostics.newEducation = after.education - before.education;
    diagnostics.newSkills = after.skills - before.skills;
    diagnostics.newCertifications = after.certifications - before.certifications;
    diagnostics.newInterests = after.interests - before.interests;
    diagnostics.totals = after;
    return diagnostics.newExperience + diagnostics.newEducation + diagnostics.newSkills +
      diagnostics.newCertifications + diagnostics.newInterests;
  }

  /** Counts DOM churn across the whole scan so diagnostics can prove it moved. */
  function createMutationCounter() {
    let count = 0;
    const observer = new MutationObserver((records) => { count += records.length; });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return {
      get count() { return count; },
      stop() { observer.disconnect(); }
    };
  }

  async function waitForDomQuiet(quietMs = 250, timeoutMs = 1000) {
    return new Promise((resolve) => {
      let quietTimer;
      let timeoutTimer;
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      const finish = () => {
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(timeoutTimer);
        resolve();
      };
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
      quietTimer = setTimeout(finish, quietMs);
      timeoutTimer = setTimeout(finish, timeoutMs);
    });
  }

  function documentHeight() {
    return (document.scrollingElement || document.documentElement).scrollHeight;
  }

  /**
   * A cheap fingerprint of "how much of this profile has rendered so far".
   *
   * It covers both the page itself (height, entity blocks) and what has already
   * been captured, so a virtualized section that recycles its DOM but adds new
   * records still counts as growth and keeps the scan going.
   */
  function pageSignature(main, collector, target) {
    const blocks = main.querySelectorAll(
      "section,li,[data-view-name*='profile-component-entity'],.pvs-entity,.pvs-list__paged-list-item"
    ).length;
    return [maxScrollPosition(target), blocks, collector.data.signature()].join(":");
  }

  /**
   * Re-read the top card. The header hydrates after the first paint and is
   * re-rendered while the rest of the profile loads, so reading it once up front
   * is exactly how a name, headline, or location goes missing.
   */
  function collectIdentity(main, collector, diagnostics) {
    const { topCard, portrait } = findTopCard(main);
    if (!topCard) return;
    collector.topCard = topCard;
    if (portrait) collector.portrait = portrait;

    const nameResult = extractName(topCard, portrait || collector.portrait);
    const nameScore = nameResult.candidates[0]?.score ?? -1;
    const before = collector.data.identity;
    if (nameResult.value && nameScore > before.nameScore) diagnostics.candidates.name = nameResult.candidates;
    collector.data.addIdentity({ name: nameResult.value, nameScore });

    const fullName = collector.data.identity.name || nameResult.value;
    const topResult = extractHeadlineAndLocation(topCard, fullName);
    const headlineScore = topResult.headlineCandidates[0]?.score ?? -1;
    if (topResult.headline && headlineScore > before.headlineScore) diagnostics.candidates.headline = topResult.headlineCandidates;
    const locationScore = topResult.locationCandidates.find((item) => item.text === topResult.location)?.score ?? -1;
    if (topResult.location && locationScore > before.locationScore) diagnostics.candidates.location = topResult.locationCandidates;
    collector.data.addIdentity({
      headline: topResult.headline,
      headlineScore,
      location: topResult.location,
      locationScore
    });

    if (topResult.lines.length) diagnostics.topCardLines = topResult.lines;
    diagnostics.topCardTag = topCard.tagName || "";
  }

  function snapshotPage(main, collector, diagnostics) {
    collectIdentity(main, collector, diagnostics);
    return collectSections(main, collector, diagnostics);
  }

  // Kept comfortably under the service worker's extract timeout so a pathological
  // page still returns whatever it managed to collect instead of timing out.
  const SCAN_BUDGET_MS = 115000;

  /**
   * Walk the whole profile from the top to the bottom, collecting as it goes.
   *
   * Nothing is saved from this: it only fills the collector. The walk finishes
   * when the page is at the bottom AND repeated reads there reveal nothing new,
   * which is what guarantees the profile is complete before it is normalized.
   */
  async function performLazyScrollAndCollect(main, collector, diagnostics) {
    const target = chooseScrollTarget(main);
    const originalY = currentScrollTop(target);
    const initialHeight = documentHeight();
    const deadline = Date.now() + SCAN_BUDGET_MS;
    const mutations = createMutationCounter();
    let scan = Core.createScanState();
    let stoppedBy = "settled";
    let quietScans = 0;

    diagnostics.profileRoot = `${main.tagName?.toLowerCase() || "body"}${main.id ? `#${main.id}` : ""}`;
    diagnostics.scrollContainer = target?.id || "none";
    diagnostics.scrollContainerFound = Boolean(target);
    diagnostics.scrollStep = 0;

    try {
      // Always begin at the top - LinkedIn renders the profile in slices from there.
      scrollProfileTo(0, target);
      window.scrollTo({ top: 0, behavior: "auto" });
      await waitForDomQuiet(400, 2600);
      snapshotPage(main, collector, diagnostics);

      for (;;) {
        scan = Core.nextScanStep(scan, {
          position: currentScrollTop(target),
          maxPosition: maxScrollPosition(target),
          viewportHeight: target?.clientHeight || window.innerHeight,
          signature: pageSignature(main, collector, target)
        });
        if (scan.done) {
          stoppedBy = scan.reason;
          break;
        }
        if (Date.now() > deadline) {
          stoppedBy = "time-budget";
          break;
        }
        // Stop first: a scan that has been told to end must not take another
        // step, and it must not be reported as a profile that had nothing.
        if (state.aborted) throw stoppedError();
        // A hidden page stops changing, which the scan would otherwise read as
        // "settled". Abort so a partial profile can never be saved.
        if (!isPageVisible() || state.wentHidden) throw hiddenPageError();
        // One gradual step down the container that actually scrolls.
        diagnostics.scrollStep = scan.position - currentScrollTop(target);
        scrollProfileTo(scan.position, target);
        // LinkedIn renders profile sections lazily over the network; a short wait
        // here is what produces half-empty profiles.
        await waitForDomQuiet(340, 2400);
        const added = snapshotPage(main, collector, diagnostics);
        quietScans = added > 0 ? 0 : quietScans + 1;
        diagnostics.quietScans = quietScans;
        diagnostics.mutations = mutations.count;
      }

      // A final read from the top, once everything below has loaded, so the header
      // is captured in its fully hydrated state.
      scrollProfileTo(0, target);
      await waitForDomQuiet(300, 1600);
      snapshotPage(main, collector, diagnostics);
    } finally {
      // Always hand the page back at the position the user left it at, on the
      // success path and on every failure path alike.
      scrollProfileTo(originalY, target);
      mutations.stop();
    }

    diagnostics.stopReason = stoppedBy;
    diagnostics.mutations = mutations.count;
    diagnostics.lazyScroll = {
      performed: true,
      complete: stoppedBy === "settled",
      stoppedBy,
      steps: scan.steps,
      unchangedPasses: scan.unchangedPasses,
      quietScans,
      reachedBottom: scan.atBottom,
      scrollContainer: diagnostics.scrollContainer,
      initialHeight,
      finalHeight: documentHeight(),
      snapshots: collector.snapshots
    };
  }

  // ------------------------------------------------------ contact details & CV
  // Contact reachability is what this release collects for. Everything LinkedIn
  // already renders is read for free on every scan; the "Contact info" overlay is
  // opened only when the page did not render an address or a number.

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Sections that render OTHER members, not this one.
   *
   * Live defect: "Interests" renders Top Voices with their own addresses and
   * numbers in plain text, and one of them — a stranger's email and mobile —
   * was saved onto the profile being collected.
   */
  const FOREIGN_SECTION_PATTERN =
    /^(?:interests|top voices|companies|groups|newsletters|schools|people also viewed|people you may know|more profiles for you|others viewed|others named|similar profiles|recommendations|recommended|promoted|activity|posts|comments|reactions|explore premium)\b/i;

  /**
   * Does this element sit in a part of the page that belongs to somebody else?
   *
   * Two independent tests, because either one alone misses cases: the section
   * heading names a block of other people, or the surrounding card links to a
   * different member's profile. The second is structural, so it holds on a
   * LinkedIn rendered in any language.
   */
  function isForeignProfileContext(element, ownProfileUrl) {
    if (!(element instanceof Element)) return false;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const heading = node.matches?.("section,[data-view-name*='profile-card']")
        ? cleanText(node.querySelector("h2,h3,[role='heading']")?.textContent || "")
        : "";
      if (heading && FOREIGN_SECTION_PATTERN.test(normalizeSectionLabel(heading))) return true;
    }
    const card = element.closest("li,article,[data-view-name*='profile-component-entity'],.pvs-entity");
    if (!card) return false;
    for (const anchor of card.querySelectorAll("a[href*='/in/']")) {
      const href = anchor.href || anchor.getAttribute("href") || "";
      if (!/\/in\//i.test(href)) continue;
      const canonical = canonicalizeProfileUrl(href);
      if (canonical && ownProfileUrl && canonical !== ownProfileUrl) return true;
    }
    return false;
  }

  /**
   * Every link inside `root` that could carry a contact detail.
   *
   * This runs on EVERY snapshot of the lazy scan, and a profile page has
   * hundreds of anchors, so the expensive checks are ordered last: `isVisible()`
   * forces layout three times per element and `innerText` forces it once, and
   * neither is reached for the ~95% of anchors that are ordinary LinkedIn
   * navigation. Cheap attribute reads decide that first.
   */
  function contactLinksIn(root, { allowModal = false } = {}) {
    const links = [];
    const ownProfileUrl = canonicalizeProfileUrl(location.href);
    for (const anchor of root.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") || "";
      if (!href) continue;

      const direct = /^(?:mailto|tel):/i.test(href);
      // Layout-free triage: navigation within LinkedIn can never be a contact
      // detail, and everything else is rare enough to pay for the real checks.
      if (!direct) {
        if (/^(?:javascript|data|blob|#)/i.test(href)) continue;
        const absolute = anchor.href || href;
        if (!/^https?:\/\//i.test(absolute)) continue;
        if (/^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\//i.test(absolute)) continue;
      }

      if (!isVisible(anchor)) continue;
      if (!allowModal && isExcludedContext(anchor)) continue;
      // The overlay this extension opened is the member's own, so the foreign
      // test is lifted there exactly as the modal test is.
      if (!allowModal && isForeignProfileContext(anchor, ownProfileUrl)) continue;

      // `textContent` rather than `innerText`: the label is only fed to regexes,
      // and it saves a forced layout per surviving anchor.
      const label = cleanText(anchor.getAttribute("aria-label") || anchor.textContent);
      links.push({
        href: anchor.href || href,
        label,
        // The surrounding list item is what says "Website (Portfolio)". Only
        // consulted when the href and label were not already decisive.
        context: direct ? "" : cleanText(anchor.closest("li,section")?.textContent || "").slice(0, 200)
      });
    }
    return links;
  }

  /**
   * Read the contact details LinkedIn already rendered.
   *
   * Runs on every snapshot, so a detail that hydrates late is still captured and
   * a section unmounted by the scan cannot take it away again — the accumulator
   * is merge-only.
   */
  function collectRenderedContacts(main, collector) {
    const counts = collector.data.counts();
    // `innerText` forces a full layout of the profile, and this runs on every one
    // of up to 90 scan steps, so the text sweep is skipped once an address is
    // already in hand. Only `email` is ever taken from the rendered page's text:
    // a labelled "Email:" line in a member's own About is theirs, while a number
    // in running text is indistinguishable from a member id, a follower count or
    // a date range — those come from a `tel:` link or the overlay, or not at all.
    const scanProse = counts.emails === 0;
    const panel = Core.parseContactPanel({
      text: scanProse ? cleanText(main?.innerText || "").slice(0, 20000) : "",
      links: contactLinksIn(main),
      allow: ["email"]
    });
    return collector.data.addContactPanel(panel);
  }

  /**
   * The Featured section is where a CV actually lives when a profile has one.
   * Its documents are ordinary links, so the pure classifier decides.
   */
  function collectFeaturedDocuments(main, collector) {
    let added = 0;
    for (const link of contactLinksIn(main)) {
      if (!Core.looksLikeCvLink(link)) continue;
      if (collector.data.addCvLink(link.href) === "added") added += 1;
    }
    return added;
  }

  /**
   * The profile's own "Contact info" control, or null.
   *
   * Runs once per profile, after the scan, so it can afford to look at every
   * button and anchor — but the label test is still done before `isVisible()`,
   * because that is three forced layouts per candidate.
   */
  function findContactControl(main) {
    if (!Connections?.classifyContactControl) return null;
    const onProfilePage = isSupportedPage();
    const candidates = [
      // The overlay link LinkedIn actually renders, wherever it lives.
      ...document.querySelectorAll("a[href*='overlay/contact-info'],a[href*='contact-info']"),
      ...(main?.querySelectorAll("button,a") || [])
    ];
    for (const element of candidates) {
      const verdict = Connections.classifyContactControl({
        text: cleanText(element.textContent),
        ariaLabel: cleanText(element.getAttribute("aria-label")),
        onProfilePage
      });
      if (!verdict.allowed) continue;
      if (!isVisible(element)) continue;
      return { element, verdict };
    }
    return null;
  }

  // How long the overlay is given, and what counts as settled, is the pure policy
  // in extraction-core; this file only supplies the observations.
  const CONTACT_OVERLAY = Core.CONTACT_OVERLAY;

  /** Markup that means "this modal is still fetching its contents". */
  const CONTACT_LOADING_SELECTOR =
    "[class*='skeleton'],[class*='shimmer'],[class*='loader'],[role='progressbar'],[aria-busy='true']";

  /** Markup that identifies the contact overlay before any of its text exists. */
  const CONTACT_DIALOG_MARKER =
    "[class*='contact-info'],[class*='ci-email'],[class*='ci-phone'],[class*='ci-vanity']";

  /**
   * The opened contact overlay, once LinkedIn has mounted it.
   *
   * The shell mounts before its content, so a marker in the markup has to be
   * enough on its own: requiring the words "Contact info" in `innerText` skips
   * the skeleton frame, and on a slow fetch it skipped the whole wait with it.
   */
  function findContactDialog() {
    for (const dialog of document.querySelectorAll("[role='dialog'],[aria-modal='true'],dialog[open],.artdeco-modal")) {
      if (!isVisible(dialog)) continue;
      if (dialog.querySelector(CONTACT_DIALOG_MARKER)) return dialog;
      // `aria-labelledby` points at the overlay's own heading id — on LinkedIn
      // that id is literally "pv-contact-info", and it is present from the very
      // first frame, before the heading it names has any text.
      const labelledBy = dialog.getAttribute("aria-labelledby") || "";
      const named = [
        dialog.getAttribute("aria-label") || "",
        labelledBy.replace(/[-_]/g, " "),
        cleanText(labelledBy ? document.getElementById(labelledBy)?.textContent : "")
      ].join(" ");
      if (Connections?.isContactControlLabel?.(named)) return dialog;
      if (/contact info/i.test(cleanText(dialog.innerText || ""))) return dialog;
    }
    return null;
  }

  /** Is the overlay still showing placeholders rather than the member's details? */
  function contactDialogIsLoading(dialog) {
    if (!dialog) return true;
    if (dialog.getAttribute("aria-busy") === "true") return true;
    return Boolean(dialog.querySelector(CONTACT_LOADING_SELECTOR));
  }

  /**
   * One read of the overlay: the values in it, plus a fingerprint of what it is
   * currently showing. The fingerprint is what decides whether it is still
   * hydrating; the values are what gets merged into the accumulator.
   */
  function readContactDialog(dialog) {
    const panel = Core.parseContactPanel({
      text: cleanText(dialog.innerText || ""),
      // The overlay IS a modal, so the modal exclusion is deliberately lifted for
      // this one element — it is the element we opened on purpose.
      links: contactLinksIn(dialog, { allowModal: true }),
      // And so is the labelled-provenance rule. This panel is this member's own
      // contact card: both the address and the number in it are theirs, and a
      // heading this build does not recognise must not cost us the number.
      trusted: true
    });
    const found = panel.emails.length + panel.phones.length + panel.cvLinks.length + panel.websites.length;
    return {
      panel,
      carriesValue: found > 0,
      signature: [cleanText(dialog.innerText || "").length, found, panel.emails.length, panel.phones.length].join("|")
    };
  }

  /** Put an overlay away again. Escape first, then the dialog's own dismiss. */
  async function closeOpenedDialog(dialog) {
    for (const key of ["Escape", "Esc"]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key, code: "Escape", keyCode: 27, bubbles: true }));
    }
    await wait(250);
    if (!document.contains(dialog)) return true;
    const dismiss = [...dialog.querySelectorAll("button")].find((button) =>
      Connections?.CONTACT_DISMISS_PATTERN?.test(
        `${cleanText(button.getAttribute("aria-label"))} ${cleanText(button.innerText)}`
      )
    );
    if (dismiss) {
      dismiss.click();
      await wait(250);
    }
    return !document.contains(dialog);
  }

  /**
   * Open "Contact info", read it, and close it again.
   *
   * This is the only click profile extraction ever performs, and it happens after
   * the page scan has settled so it can never disturb the lazy-loading walk. It
   * opens the member's own overlay, reads the values LinkedIn shows there, and
   * dismisses it: nothing is sent, nobody is contacted, and no state changes on
   * LinkedIn. It runs at most once per profile.
   */
  async function openContactInfoAndCollect(main, collector, diagnostics) {
    diagnostics.contact = diagnostics.contact || {
      clicked: false,
      opened: false,
      reason: "",
      added: 0,
      waitedToOpenMs: 0,
      waitedToLoadMs: 0,
      reads: 0,
      loadedFully: false
    };

    // The overlay is now opened on every profile, not only when the rendered
    // page gave up neither an address nor a number. The old condition meant a
    // profile that showed an email in its About never had its overlay read, so
    // the phone number sitting in that overlay was never collected. The
    // accumulator is merge-only, so opening it when the page already showed
    // something can only ever add.
    if (!isPageVisible()) {
      diagnostics.contact.reason = "page-hidden";
      return 0;
    }

    const control = findContactControl(main);
    if (!control) {
      diagnostics.contact.reason = "no-contact-control";
      return 0;
    }

    try {
      control.element.click();
      diagnostics.contact.clicked = true;
    } catch (error) {
      diagnostics.contact.reason = `click-failed:${error?.message || error}`;
      return 0;
    }

    // 1. Wait for the modal to mount. The overlay is fetched, so it appears a
    //    beat after the click — and on a throttled tab that beat is seconds, not
    //    milliseconds.
    let dialog = null;
    while (!dialog && diagnostics.contact.waitedToOpenMs < CONTACT_OVERLAY.OPEN_TIMEOUT_MS) {
      await wait(CONTACT_OVERLAY.POLL_MS);
      diagnostics.contact.waitedToOpenMs += CONTACT_OVERLAY.POLL_MS;
      // A page that stopped being painted mid-wait cannot be read, and a partial
      // read must never be mistaken for the member having no contact details.
      if (!isPageVisible()) {
        diagnostics.contact.reason = "page-hidden-while-opening";
        return 0;
      }
      dialog = findContactDialog();
    }
    if (!dialog) {
      diagnostics.contact.reason = "overlay-did-not-open";
      return 0;
    }
    diagnostics.contact.opened = true;

    // 2. Let it finish loading, reading it on every poll instead of once.
    //    LinkedIn mounts the shell first and fills it in afterwards, so the frame
    //    that satisfied step 1 is usually a skeleton. The accumulator is
    //    merge-only, so re-reading a half-loaded panel can only ever add: a value
    //    that arrives late is captured, and one that was already read is kept.
    //    Whether it has settled is decided by the tested policy, not here.
    let added = 0;
    let step = Core.createContactOverlayState();
    while (!step.done) {
      const live = findContactDialog();
      if (live) dialog = live;
      const present = document.contains(dialog);
      const read = present ? readContactDialog(dialog) : null;
      if (read) added += collector.data.addContactPanel(read.panel);

      step = Core.nextContactOverlayStep(step, {
        waitedMs: diagnostics.contact.waitedToLoadMs,
        present,
        visible: isPageVisible(),
        loading: present ? contactDialogIsLoading(dialog) : true,
        carriesValue: Boolean(read?.carriesValue),
        signature: read?.signature || ""
      });
      diagnostics.contact.reads = step.reads;
      if (step.done) break;

      await wait(CONTACT_OVERLAY.POLL_MS);
      diagnostics.contact.waitedToLoadMs += CONTACT_OVERLAY.POLL_MS;
    }

    diagnostics.contact.added = added;
    diagnostics.contact.loadedFully = step.settled;
    diagnostics.contact.reason =
      step.reason === "page-hidden" ? "page-hidden-while-loading"
        : added ? "collected"
          : step.settled ? "overlay-had-nothing"
            : `overlay-never-finished-loading:${step.reason}`;

    diagnostics.contact.closed = await closeOpenedDialog(dialog);
    return added;
  }

  // ---------------------------------------------------------- open to work
  // The badge on the picture says a member is looking. What they are looking
  // for lives behind that card's own "Show details" — and "Show details" also
  // labels controls that have nothing to do with it, so the card has to be
  // found first and the control proven to be inside it.

  /** The card that advertises "Open to work", or null. */
  function findOpenToWorkCard(main) {
    if (!main) return null;
    const candidates = [
      ...main.querySelectorAll("[class*='open-to'],[class*='opentowork'],[data-view-name*='open-to']"),
      ...main.querySelectorAll("section,li,[data-view-name*='profile-card'],.pvs-entity")
    ];
    for (const element of candidates) {
      if (!isVisible(element) || isExcludedContext(element)) continue;
      const text = cleanText(element.innerText || "");
      if (!text || text.length > 1200) continue;
      if (!Core.looksOpenToWork(text)) continue;
      // The smallest element that still says it: a whole <section> wrapping the
      // top card would drag every unrelated control in with it.
      const inner = [...element.querySelectorAll("section,div,li")]
        .filter((child) => isVisible(child) && Core.looksOpenToWork(cleanText(child.innerText || "")))
        .filter((child) => cleanText(child.innerText || "").length < text.length)
        .sort((a, b) => cleanText(a.innerText || "").length - cleanText(b.innerText || "").length)[0];
      return inner || element;
    }
    return null;
  }

  /** That card's own "Show details" control, once the policy has allowed it. */
  function findOpenToWorkControl(card) {
    if (!card || !Connections?.classifyOpenToWorkControl) return null;
    const onProfilePage = isSupportedPage();
    for (const element of card.querySelectorAll("button,a")) {
      const verdict = Connections.classifyOpenToWorkControl({
        text: cleanText(element.textContent),
        ariaLabel: cleanText(element.getAttribute("aria-label")),
        onProfilePage,
        // Proven, not assumed: the element was enumerated from inside the card.
        inOpenToWorkCard: card.contains(element)
      });
      if (!verdict.allowed) continue;
      if (!isVisible(element)) continue;
      return { element, verdict };
    }
    return null;
  }

  /** The opened job-preferences overlay, once LinkedIn has mounted it. */
  function findOpenToWorkDialog() {
    for (const dialog of document.querySelectorAll("[role='dialog'],[aria-modal='true'],dialog[open],.artdeco-modal")) {
      if (!isVisible(dialog)) continue;
      const named = [
        dialog.getAttribute("aria-label") || "",
        (dialog.getAttribute("aria-labelledby") || "").replace(/[-_]/g, " "),
        cleanText(dialog.innerText || "").slice(0, 400)
      ].join(" ");
      if (Core.looksOpenToWork(named) || /job preferences/i.test(named)) return dialog;
    }
    return null;
  }

  /**
   * Open the Open to work panel, read it, and close it again.
   *
   * Runs after the page scan for the same reason the contact overlay does: a
   * modal mid-scan would stop the lazy walk dead. The card's own text is read
   * first, so a member whose panel never opens is still recorded as open to
   * work with whatever the card itself showed.
   */
  async function openToWorkDetails(main, diagnostics) {
    diagnostics.openToWork = { present: false, clicked: false, opened: false, reason: "", fields: 0 };
    const card = findOpenToWorkCard(main);
    if (!card) {
      diagnostics.openToWork.reason = "not-open-to-work";
      return [];
    }
    diagnostics.openToWork.present = true;

    // What the card itself already says, before anything is clicked.
    let panel = Core.parseOpenToWorkPanel({ text: cleanText(card.innerText || "") });
    const merge = (next) => {
      for (const field of Core.OPEN_TO_WORK_FIELDS) {
        panel[field.key] = Core.uniqueText([...(panel[field.key] || []), ...(next[field.key] || [])]);
      }
    };

    if (!isPageVisible()) {
      diagnostics.openToWork.reason = "page-hidden";
      return Core.formatOpenToWork(panel);
    }

    const control = findOpenToWorkControl(card);
    if (!control) {
      diagnostics.openToWork.reason = "no-details-control";
      return Core.formatOpenToWork(panel);
    }

    try {
      control.element.click();
      diagnostics.openToWork.clicked = true;
    } catch (error) {
      diagnostics.openToWork.reason = `click-failed:${error?.message || error}`;
      return Core.formatOpenToWork(panel);
    }

    let dialog = null;
    let waited = 0;
    while (!dialog && waited < CONTACT_OVERLAY.OPEN_TIMEOUT_MS) {
      await wait(CONTACT_OVERLAY.POLL_MS);
      waited += CONTACT_OVERLAY.POLL_MS;
      if (!isPageVisible()) {
        diagnostics.openToWork.reason = "page-hidden-while-opening";
        return Core.formatOpenToWork(panel);
      }
      dialog = findOpenToWorkDialog();
    }
    if (!dialog) {
      diagnostics.openToWork.reason = "overlay-did-not-open";
      return Core.formatOpenToWork(panel);
    }
    diagnostics.openToWork.opened = true;

    // Same settle policy as the contact overlay: the shell mounts before its
    // content, so it is re-read until what it shows stops changing.
    let step = Core.createContactOverlayState();
    let loadWait = 0;
    while (!step.done) {
      const live = findOpenToWorkDialog();
      if (live) dialog = live;
      const present = document.contains(dialog);
      const text = present ? cleanText(dialog.innerText || "") : "";
      if (text) merge(Core.parseOpenToWorkPanel({ text }));
      const fields = Core.OPEN_TO_WORK_FIELDS.filter((field) => (panel[field.key] || []).length).length;

      step = Core.nextContactOverlayStep(step, {
        waitedMs: loadWait,
        present,
        visible: isPageVisible(),
        loading: present ? contactDialogIsLoading(dialog) : true,
        carriesValue: fields > 0,
        signature: `${text.length}|${fields}`
      });
      if (step.done) break;
      await wait(CONTACT_OVERLAY.POLL_MS);
      loadWait += CONTACT_OVERLAY.POLL_MS;
    }

    const lines = Core.formatOpenToWork(panel);
    diagnostics.openToWork.fields = lines.length;
    diagnostics.openToWork.reason = lines.length > 1 ? "collected" : "overlay-had-nothing";
    diagnostics.openToWork.closed = await closeOpenedDialog(dialog);
    return lines;
  }

  function visibleBodyText() {
    const main = document.querySelector("main") || document.body;
    return String(main?.innerText || "").slice(0, 20000);
  }

  function currentChallenge() {
    if (!Connections?.detectChallenge) return { challenged: false, kind: "", message: "" };
    return Connections.detectChallenge({ url: location.href, title: document.title, bodyText: visibleBodyText() });
  }

  async function extractProfile(options = {}) {
    if (!isSupportedPage()) throw new Error("Open a LinkedIn profile URL containing /in/ before extracting.");
    const challenge = currentChallenge();
    if (challenge.challenged) {
      const error = new Error(challenge.message);
      error.challenge = challenge;
      throw error;
    }
    // Nothing is read from a page LinkedIn is not painting.
    if (options.lazyScroll !== false && !isPageVisible()) throw hiddenPageError();
    state.wentHidden = false;
    state.aborted = false;

    // The member's page, recorded before anything is opened on it. Opening the
    // Contact info overlay routes LinkedIn to /in/slug/overlay/contact-info/, so
    // reading `location.href` afterwards recorded the overlay as the profile.
    const profileUrl = canonicalizeProfileUrl(location.href);
    // Stamped for the whole run so every name candidate is checked against the
    // page this scan started on, never against one LinkedIn routed to mid-scan.
    state.profileUrl = profileUrl;

    const diagnostics = {
      buildId: BUILD_ID,
      url: profileUrl,
      startedAt: new Date().toISOString(),
      adapter: "LinkedInProfileAdapter",
      lazyScroll: { performed: false, steps: 0, snapshots: 0 },
      profileRoot: "",
      scrollContainer: "",
      scrollStep: 0,
      sectionHeadings: [],
      newExperience: 0,
      newEducation: 0,
      newSkills: 0,
      newCertifications: 0,
      newInterests: 0,
      totals: { experience: 0, education: 0, skills: 0, certifications: 0, languages: 0, interests: 0 },
      mutations: 0,
      quietScans: 0,
      stopReason: "",
      sections: {},
      candidates: {}
    };

    const main = profileRoot();
    const collector = makeCollector();

    // Read the whole page first. Nothing is normalized or saved until the scan
    // has walked to the bottom and the page has stopped producing new content.
    if (options.lazyScroll !== false) await performLazyScrollAndCollect(main, collector, diagnostics);
    else snapshotPage(main, collector, diagnostics);

    // Only now, with the page settled, is the contact overlay opened — and only
    // when the rendered page did not already give up an address and a number.
    if (options.contactInfo !== false) {
      try {
        await openContactInfoAndCollect(main, collector, diagnostics);
      } catch (error) {
        // A profile with no reachable contact detail is still a profile worth
        // saving; the overlay failing must never lose the rest of the record.
        diagnostics.contact = { ...(diagnostics.contact || {}), reason: `error:${error?.message || error}` };
      }
    }

    // And then the other panel this member published about themselves.
    let openToWork = [];
    if (options.openToWork !== false) {
      try {
        openToWork = await openToWorkDetails(main, diagnostics);
      } catch (error) {
        diagnostics.openToWork = { ...(diagnostics.openToWork || {}), reason: `error:${error?.message || error}` };
      }
    }

    const identity = collector.data.identity;
    const fullName = identity.name;
    const { firstName, lastName } = splitName(fullName);

    const education = collector.data.education();
    // The whole of what the page rendered, not a summary of it: every education
    // card with its degree, field and dates, and every role with its company,
    // type, dates, duration and location.
    const educationDetails = collector.data.educationEntries();
    const experience = collector.data.experienceEntries();
    const skills = collector.data.skills();
    const interests = collector.data.interests();
    const partialSections = collector.data.partialSections();

    const emails = collector.data.emails();
    const phones = collector.data.phones();
    const cvLinks = collector.data.cvLinks();

    const now = new Date().toISOString();
    const profile = {
      // What the scan read is what the record keeps. 3.6.0 had cut the record
      // back to contact reachability and threw the rest away at the last step —
      // the scan still walked Experience, About and the top card and then
      // dropped them on the floor. Nothing new is read to fill these in; they
      // are the reads that were already happening, now kept.
      fullName,
      firstName,
      lastName,
      headline: identity.headline,
      location: identity.location,
      about: collector.data.about,
      email: emails[0] || "",
      emails,
      mobile: phones[0] || "",
      phones,
      cvUrl: cvLinks[0] || "",
      cvLinks,
      openToWorkDetails: openToWork,
      education,
      educationDetails,
      experience,
      skills,
      interests,
      profileUrl,
      notes: "",
      tags: [],
      source: "LinkedIn",
      partialSections,
      collectedAt: now,
      lastCollectedAt: now
    };

    // Confidence is scored against what this release actually wants, so a profile
    // with no email and no CV no longer reads as a complete extraction.
    const importantFields = ["fullName", "email", "mobile", "skills", "education"];
    const missingFields = importantFields.filter((key) => Array.isArray(profile[key]) ? profile[key].length === 0 : !profile[key]);
    profile.missingFields = missingFields;
    profile.extractionConfidence = Math.max(0, Math.round(((importantFields.length - missingFields.length) / importantFields.length) * 100 - profile.partialSections.length * 3));

    diagnostics.finishedAt = new Date().toISOString();
    diagnostics.selected = {
      fullName: profile.fullName,
      cvUrl: profile.cvUrl,
      email: profile.email,
      mobile: profile.mobile,
      openToWork: profile.openToWorkDetails,
      counts: {
        education: profile.education.length,
        educationDetails: profile.educationDetails.length,
        experience: profile.experience.length,
        skills: profile.skills.length,
        interests: profile.interests.length,
        emails: profile.emails.length,
        phones: profile.phones.length,
        cvLinks: profile.cvLinks.length
      },
      missingFields,
      partialSections: profile.partialSections
    };
    state.lastDiagnostics = diagnostics;
    return { profile, diagnostics };
  }

  state.handler = (message, _sender, sendResponse) => {
    if (message?.type === "PV_PING") {
      sendResponse({ ok: true, buildId: BUILD_ID, supported: isSupportedPage(), url: canonicalizeProfileUrl(location.href) });
      return false;
    }
    if (message?.type === "PV_GET_DIAGNOSTICS") {
      sendResponse({ ok: true, diagnostics: state.lastDiagnostics });
      return false;
    }

    if (message?.type === "PV_STOP_ALL") {
      // The universal Stop. A scan already walking this profile ends at its
      // next step, and nothing partial is saved on the way out.
      state.aborted = true;
      sendResponse({ ok: true, buildId: BUILD_ID, surface: "profile", stopped: true });
      return false;
    }

    if (message?.type === "PV_CHECK_LOGIN") {
      // Session detection only: no credential is read, requested, or stored.
      const auth = Connections?.classifyAuthState
        ? Connections.classifyAuthState({
            url: location.href,
            title: document.title,
            bodyText: visibleBodyText(),
            memberMarkers: document.querySelectorAll("[class*='global-nav'],nav a[href*='/feed'],a[href*='/mynetwork']").length,
            reachable: true
          })
        : { state: "unknown", kind: "", signedIn: false, message: "Session state is unavailable on this page." };
      sendResponse({ ok: true, buildId: BUILD_ID, surface: "profile", url: location.href, auth });
      return false;
    }

    if (message?.type === "PV_CHECK_PAGE") {
      sendResponse({
        ok: true,
        buildId: BUILD_ID,
        surface: "profile",
        supported: isSupportedPage(),
        url: canonicalizeProfileUrl(location.href),
        challenge: currentChallenge()
      });
      return false;
    }
    if (message?.type === "PV_EXTRACT") {
      if (!state.extracting) state.extracting = extractProfile(message.options || {}).finally(() => { state.extracting = null; });
      state.extracting
        .then(({ profile, diagnostics }) => sendResponse({ ok: true, supported: true, profile, diagnostics, buildId: BUILD_ID }))
        .catch((error) => sendResponse({
          ok: false,
          supported: isSupportedPage(),
          // A hidden page is an interruption, never a failed profile: the worker
          // pauses on it instead of marking the connection failed. A stop is the
          // same kind of thing, and is reported separately so the worker never
          // records "the user pressed Stop" as "this profile could not be read".
          hidden: Boolean(error?.hidden),
          stopped: Boolean(error?.stopped),
          visibilityState: document.visibilityState,
          error: error instanceof Error ? error.message : String(error),
          challenge: error?.challenge || currentChallenge(),
          buildId: BUILD_ID
        }));
      return true;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(state.handler);
  state.urlTimer = setInterval(() => {
    if (location.href !== state.lastUrl) {
      state.lastUrl = location.href;
      state.lastDiagnostics = null;
      // A new page is a new member: the old one's URL must never name this one.
      state.profileUrl = "";
    }
  }, 800);
})();
