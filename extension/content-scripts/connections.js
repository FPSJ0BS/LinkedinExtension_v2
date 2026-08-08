(() => {
  "use strict";

  const BUILD_ID = "2026-08-03-react-v3.7.8";
  const Core = globalThis.ProfileVaultConnections;
  if (!Core) throw new Error("Profile Vault connections core is unavailable.");

  // Re-injection safety: drop the previous listener before installing a new one.
  const previous = globalThis.__PROFILE_VAULT_CONNECTIONS__;
  if (previous?.handler) chrome.runtime.onMessage.removeListener(previous.handler);

  // `aborted` is the universal Stop's foothold on this page: the worker
  // broadcasts PV_STOP_ALL to every LinkedIn tab, and a pass already walking the
  // list has to end at its next step rather than when its own budget runs out.
  const state = { buildId: BUILD_ID, handler: null, discovering: null, lastDiagnostics: null, wentHidden: false, aborted: false };
  globalThis.__PROFILE_VAULT_CONNECTIONS__ = state;

  // ------------------------------------------------------------- visibility
  // Chrome throttles a background tab and LinkedIn does not render a hidden
  // page at all: the list stops growing, mutations stop, and every "is it
  // finished?" signal reads as finished. A hidden page must therefore abort the
  // pass rather than let it conclude the list has ended.

  function isPageVisible() {
    return document.visibilityState === "visible";
  }

  if (previous?.visibilityHandler) document.removeEventListener("visibilitychange", previous.visibilityHandler);
  state.visibilityHandler = () => {
    if (!isPageVisible()) state.wentHidden = true;
  };
  document.addEventListener("visibilitychange", state.visibilityHandler);

  // LinkedIn fetches the next slice of the connections list over the network, which
  // routinely takes 2-4 seconds. These windows must stay generous: waiting too little
  // is exactly what makes discovery believe a 10-row page is the whole list.
  const STEPS_PER_PASS = Core.DISCOVERY_STEPS_PER_PASS;
  const STEP_QUIET_MS = 400;
  const STEP_TIMEOUT_MS = 3000;
  const BOTTOM_WAIT_MS = 8000;
  const GROWTH_POLL_MS = 350;
  // How many quiet bottom reads are needed before paging forward, and how many
  // before the list may be declared finished, live in the core as
  // IDLE_BOTTOM_LIMIT / DISCOVERY_QUIET_SCANS and are applied by
  // Core.planDiscoveryStep below.
  const MAX_SCROLL_CANDIDATES = 400;

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element.hidden) return false;
    if (element.closest(".visually-hidden,[class*='visually-hidden'],[class*='screen-reader']")) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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
   * The container that actually holds the connections results.
   *
   * `main` is the usual answer but several LinkedIn layouts render the list
   * outside it, so every plausible container is enumerated with querySelectorAll
   * and the one carrying the most profile links wins. A single querySelector here
   * is how discovery ends up reading one card - or none - on those layouts.
   */
  const rootCache = { at: 0, value: null };

  function listRoot() {
    // Memoized: this counts profile links across several containers, and the
    // growth poll asks for it several times a second.
    const now = Date.now();
    if (rootCache.value?.isConnected && now - rootCache.at < 750) return rootCache.value;
    rootCache.at = now;
    rootCache.value = resolveListRoot();
    return rootCache.value;
  }

  function resolveListRoot() {
    const candidates = [
      ...document.querySelectorAll("main,[role='main'],[class*='scaffold-layout__main'],[class*='mn-connections'],[componentkey*='connections' i]"),
      document.body
    ].filter((element) => element instanceof Element && !isExcludedContext(element));

    let best = null;
    let bestCount = -1;
    for (const element of candidates) {
      const count = element.querySelectorAll("a[href*='/in/']").length;
      // Ties go to the tighter container: it excludes more sidebar noise.
      if (count > bestCount) {
        best = element;
        bestCount = count;
      }
    }
    return best || document.body;
  }

  function visibleBodyText() {
    return String(listRoot()?.innerText || "").slice(0, 20000);
  }

  function currentChallenge() {
    return Core.detectChallenge({ url: location.href, title: document.title, bodyText: visibleBodyText() });
  }

  /** Phase 21: read the advertised total from the connections list header. */
  function readConnectionTotal() {
    const root = listRoot();
    const headings = [...root.querySelectorAll("h1,h2,h3,[role='heading'],p,span,div")]
      .filter((element) => isVisible(element) && !isExcludedContext(element))
      .map((element) => String(element.textContent || ""))
      .filter((text) => text && text.length <= 160 && /connections?/i.test(text));

    for (const text of headings) {
      const parsed = Core.parseConnectionCount(text);
      if (parsed.total !== null) return parsed;
    }
    return { total: null, reliable: false };
  }

  // ------------------------------------------------------- the scroll container
  // Everything below hangs off finding the element that genuinely scrolls. On the
  // live scaffold layout the document is pinned at `height: 100vh` and a wrapper
  // *above* the list scrolls, so measuring from `window.scrollY` reported a scroll
  // range of zero and the first screenful looked like the whole list. Candidates
  // therefore include the document, every ancestor of the list, and the list
  // itself; scrollable descendants are only considered if nothing else qualifies,
  // because on this page the tallest one is a filter panel that scrolls nothing.

  function elementDepth(element) {
    let depth = 0;
    for (let current = element?.parentElement; current; current = current.parentElement) depth += 1;
    return depth;
  }

  function describeScrollCandidate(element, list, isScrollingElement = false) {
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
      containsList: Boolean(list) && (element === list || element.contains(list)),
      depth: elementDepth(element)
    };
  }

  /**
   * Every element that could be the scroller, outermost first.
   * `deep` adds scrollable descendants of the list, which is a last resort.
   */
  function scrollCandidates(list, deep = false) {
    const seen = new Set();
    const output = [];
    const add = (element, isScrollingElement = false) => {
      if (!(element instanceof Element) || seen.has(element)) return;
      seen.add(element);
      const described = describeScrollCandidate(element, list, isScrollingElement);
      if (described) output.push(described);
    };

    const scrolling = document.scrollingElement || document.documentElement;
    add(scrolling, true);
    add(document.documentElement);
    add(document.body);
    // The ancestors are the ones that matter: LinkedIn scrolls one of them.
    for (let current = list; current; current = current.parentElement) add(current);

    if (deep && list) {
      let budget = MAX_SCROLL_CANDIDATES;
      for (const element of list.querySelectorAll("div,section,ul,main")) {
        if (budget-- <= 0) break;
        if (element.scrollHeight <= element.clientHeight + Core.SCROLLABLE_EPSILON) continue;
        add(element);
      }
    }
    return output;
  }

  const targetCache = { at: 0, value: null };

  /**
   * The element discovery scrolls. Re-resolved as LinkedIn swaps the layout while
   * the list grows, but cached briefly: this runs on every growth poll, and only a
   * page where nothing above the list scrolls pays for the deep descendant scan.
   */
  function scrollTarget(list) {
    const now = Date.now();
    // The cached element must still be in the document: LinkedIn replaces the
    // wrapper on some navigations, and writing scrollTop to a detached node
    // silently does nothing, which would stall the walk at its current position.
    if (targetCache.value?.element?.isConnected && now - targetCache.at < 750) return targetCache.value;
    const root = list || listRoot();
    const chosen = Core.chooseScrollTarget(scrollCandidates(root, false))
      || Core.chooseScrollTarget(scrollCandidates(root, true));
    targetCache.at = now;
    targetCache.value = chosen;
    return chosen;
  }

  function anchorPayload(anchor) {
    return {
      href: anchor.getAttribute("href") || anchor.href || "",
      text: anchor.innerText || anchor.textContent || ""
    };
  }

  // ------------------------------------------------------------- card ledger
  // Counting only the URLs that worked hides the ones that did not. A card for a
  // restricted, out-of-network, or deleted member renders with no usable profile
  // link at all, which is exactly why LinkedIn can advertise 67 connections while
  // only 66 profile URLs exist. Every rendered card is therefore tallied so the
  // difference can be explained instead of looking like an early stop.

  const CARD_SELECTOR = [
    "li",
    "[componentkey]",
    "[data-view-name*='connection' i]",
    ".mn-connection-card",
    ".artdeco-list__item"
  ].join(",");

  const UNAVAILABLE_CARD_PATTERN =
    /(?:linkedin member|profile (?:is )?unavailable|this profile is not available|out of (?:your )?network|no longer available|account (?:has been )?restricted|member no longer)/i;

  function cardText(element) {
    return String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function canonicalFromAnchor(anchor) {
    return Core.canonicalizeConnectionUrl(anchor?.getAttribute?.("href") || anchor?.href || "", location.href);
  }

  /**
   * Fold the rendered cards and profile anchors into the pass ledger.
   *
   * A usable card is identified by the person it links to, not by its container:
   * a wrapper holding several people would otherwise count as one card and open
   * a phantom gap against LinkedIn's total. A card with no usable link has no
   * such identity, so those are taken from the innermost matching container and
   * deduplicated by their visible text.
   *
   * Anchors are remembered by element identity, so re-reading the same scroll
   * position cannot inflate the duplicate-link count, and the ledger itself
   * deduplicates cards, so a virtualized re-render cannot inflate the card count.
   */
  function tallyCards(root, ledger, countedAnchors) {
    const linkedCards = new Set();
    for (const anchor of root.querySelectorAll("a[href*='/in/']")) {
      const url = canonicalFromAnchor(anchor);
      if (!url) continue;
      if (countedAnchors.get(anchor) !== url) {
        countedAnchors.set(anchor, url);
        ledger.noteLink(url);
      }
      const card = anchor.closest(CARD_SELECTOR) || anchor;
      linkedCards.add(card);
      ledger.noteCard({ url, text: cardText(card) });
    }

    // Restricted, out-of-network, and deleted members: rendered as a card with
    // no profile link at all. These are the difference between "67 reported" and
    // "66 collected", so they are counted rather than silently dropped.
    const unavailable = [...root.querySelectorAll(CARD_SELECTOR)].filter((element) => {
      if (!(element instanceof Element) || element.hidden || isExcludedContext(element)) return false;
      if (linkedCards.has(element) || element.querySelector("a[href*='/in/']")) return false;
      const text = cardText(element);
      return Boolean(text) && text.length <= 400 && UNAVAILABLE_CARD_PATTERN.test(text);
    });
    const innermost = unavailable.filter((element) => !unavailable.some((other) => other !== element && element.contains(other)));
    for (const element of innermost) {
      ledger.noteCard({ url: "", text: cardText(element), restricted: true });
    }
  }

  /**
   * Evidence that a signed-in LinkedIn page actually rendered. Used only to tell
   * "signed in" apart from "could not tell" — never to read anything about the
   * member, and never to touch a credential.
   */
  function memberMarkerCount() {
    const selectors = [
      ".global-nav",
      "[class*='global-nav']",
      "nav a[href*='/feed']",
      "a[href*='/mynetwork']",
      "img[class*='global-nav__me']",
      "[data-view-name*='navigation']"
    ];
    let count = 0;
    for (const selector of selectors) {
      try {
        count += document.querySelectorAll(selector).length ? 1 : 0;
      } catch {
        // A selector an older Chrome cannot parse simply contributes nothing.
      }
    }
    // The connections list itself is the strongest marker there is.
    if (listRoot().querySelectorAll("a[href*='/in/']").length) count += 2;
    return count;
  }

  function currentAuthState() {
    return Core.classifyAuthState({
      url: location.href,
      title: document.title,
      bodyText: visibleBodyText(),
      memberMarkers: memberMarkerCount(),
      reachable: true
    });
  }

  /**
   * Every connection card rendered right now, as canonical `{ url, name }`.
   *
   * A card that is below the fold is still "rendered" and must be read: only
   * genuinely hidden and out-of-context anchors are dropped. If the strict
   * visibility test rejects everything while profile links clearly exist, the
   * relaxed pass is used instead - a layout quirk must not reduce a whole list to
   * the handful of rows that happen to satisfy getComputedStyle.
   */
  function collectVisibleEntries(root = listRoot()) {
    const anchors = [...root.querySelectorAll("a[href*='/in/']")].filter((anchor) => !isExcludedContext(anchor));
    const strict = anchors.filter(isVisible).map(anchorPayload);
    const links = strict.length ? strict : anchors.filter((anchor) => !anchor.hidden).map(anchorPayload);
    return { entries: Core.collectEntriesFromLinks(links, location.href), links: links.length, anchors: anchors.length };
  }

  /** Raw count of profile anchors, used as the growth signal for lazy loading. */
  function profileLinkCount() {
    return listRoot().querySelectorAll("a[href*='/in/']").length;
  }

  function documentHeight() {
    const target = scrollTarget();
    if (target) return target.scrollHeight;
    const scrolling = document.scrollingElement || document.documentElement;
    return scrolling.scrollHeight;
  }

  /**
   * Where the list is scrolled to.
   *
   * Read from the one element that actually scrolls. Mixing the window's position
   * with an inner container's - the previous behaviour - produced a cursor that
   * belonged to neither, so the bottom was reported at the wrong moment.
   */
  function currentScrollTop(target = scrollTarget()) {
    if (!target?.element) return window.scrollY;
    return target.isScrollingElement ? Math.max(window.scrollY, target.element.scrollTop) : target.element.scrollTop;
  }

  function maxScrollTop(target = scrollTarget()) {
    if (!target?.element) {
      const scrolling = document.scrollingElement || document.documentElement;
      return Math.max(0, scrolling.scrollHeight - window.innerHeight);
    }
    return Math.max(0, target.element.scrollHeight - target.clientHeight);
  }

  function scrollListTo(top, target = scrollTarget()) {
    const limit = maxScrollTop(target);
    const value = Math.max(0, Math.min(Number(top) || 0, limit));
    if (!target?.element) {
      window.scrollTo({ top: value, behavior: "auto" });
      return;
    }
    if (target.isScrollingElement) window.scrollTo({ top: value, behavior: "auto" });
    target.element.scrollTop = value;
  }

  function atDocumentBottom(target = scrollTarget()) {
    return currentScrollTop(target) >= maxScrollTop(target) - 8;
  }

  /**
   * Wait for LinkedIn to actually render more rows. Polls the profile-link count and
   * the page height rather than trusting a DOM-quiet heuristic, because a loading
   * spinner alone makes the DOM look "settled" while the real rows are still in flight.
   */
  async function waitForGrowth(baselineLinks, baselineHeight, timeoutMs = BOTTOM_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, GROWTH_POLL_MS));
      if (profileLinkCount() > baselineLinks) return true;
      if (documentHeight() > baselineHeight + 40) return true;
      if (currentChallenge().challenged) return false;
    }
    return false;
  }

  /**
   * Scroll up briefly and back down. Intersection-observer based loaders often need
   * the sentinel to leave and re-enter the viewport before they fetch the next page.
   */
  async function nudge(target = scrollTarget()) {
    const y = currentScrollTop(target);
    scrollListTo(Math.max(0, y - 420), target);
    await new Promise((resolve) => setTimeout(resolve, 260));
    scrollListTo(Math.min(y + 420, maxScrollTop(target)), target);
  }

  /**
   * Phase 23 / decision D1: find a control that pages the connections list.
   * A control is only eligible when it is inside the connections list container on a
   * connections page AND its label is on the pagination allowlist. Any label matching
   * a forbidden action disqualifies it permanently, whatever else it looks like.
   */
  function findPaginationControl(root = listRoot()) {
    if (!Core.isConnectionsPage(location.href)) return null;
    for (const element of root.querySelectorAll("button,a[role='button'],[role='button']")) {
      if (!isVisible(element) || isExcludedContext(element)) continue;
      if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
      // Proven containment: the control must live inside the list we are enumerating.
      const inConnectionsList = root.contains(element) && !isExcludedContext(element);
      const verdict = Core.classifyControl({
        text: element.innerText || element.textContent || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        inConnectionsList
      });
      if (verdict.allowed) return { element, label: verdict.label };
    }
    return null;
  }

  /** Counts DOM churn for the whole pass so diagnostics can prove the page moved. */
  function createMutationCounter() {
    let count = 0;
    const observer = new MutationObserver((records) => { count += records.length; });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return {
      get count() { return count; },
      stop() { observer.disconnect(); }
    };
  }

  function waitForDomQuiet(quietMs = STEP_QUIET_MS, timeoutMs = STEP_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let quietTimer;
      let timeoutTimer;
      const finish = () => {
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(timeoutTimer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      quietTimer = setTimeout(finish, quietMs);
      timeoutTimer = setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Stream newly discovered connections to the service worker so they reach
   * IndexedDB while discovery is still running. A content script cannot write the
   * extension's database itself, and a pass can walk a long list for minutes - a
   * tab reload or a suspended worker must not throw that work away.
   */
  function reportProgress(entries, diagnostics) {
    if (!entries.length) return;
    try {
      chrome.runtime.sendMessage({
        type: "PV_IMPORT_DISCOVERY_PROGRESS",
        buildId: BUILD_ID,
        entries,
        diagnostics
      });
    } catch {
      // The worker may be restarting; the pass result carries the same rows.
    }
  }

  /**
   * Phase 22: run ONE resumable discovery pass starting from `cursorY`.
   * The service worker calls this repeatedly until coverage converges, so this
   * function never tries to enumerate the whole list on its own.
   *
   * The loop is: read every rendered card -> canonicalize -> merge into the
   * cumulative collector -> stream the new ones out for persistence -> scroll one
   * gradual step -> wait for the DOM to go quiet -> read again. The collector is
   * never replaced by the currently rendered batch, so cards LinkedIn recycles out
   * of the DOM stay discovered.
   *
   * Only scrolling and allowlisted pagination clicks happen here. No other control
   * is ever activated. The original scroll position is restored on every exit path.
   */
  async function discoveryPass(options = {}) {
    const challenge = currentChallenge();
    if (challenge.challenged) {
      return { entries: [], urls: [], challenge, cursorY: Number(options.cursorY) || 0, atBottom: false, clickedPagination: false, paginationAvailable: false, steps: 0, total: null, totalReliable: false, diagnostics: null };
    }
    // Refuse to start on a hidden page: LinkedIn will not render it, so the pass
    // would read an empty list and report the account as fully enumerated.
    if (!isPageVisible()) {
      return {
        entries: [], urls: [], hidden: true, visibilityState: document.visibilityState,
        challenge: { challenged: false, kind: "", message: "" },
        cursorY: Number(options.cursorY) || 0, atBottom: false, clickedPagination: false,
        paginationAvailable: false, steps: 0, total: null, totalReliable: false, diagnostics: null
      };
    }
    state.wentHidden = false;
    state.aborted = false;

    const root = listRoot();
    let target = scrollTarget(root);
    const originalY = currentScrollTop(target);
    const startY = Math.max(0, Number(options.cursorY) || 0);
    const maxSteps = Math.max(1, Math.min(Number(options.maxSteps) || STEPS_PER_PASS, STEPS_PER_PASS));
    const mode = options.mode === "current" ? "current" : "advance";

    const found = Core.createEntryCollector(location.href);
    const ledger = Core.createCardLedger();
    const countedAnchors = new WeakMap();
    const mutations = createMutationCounter();

    const diagnostics = {
      buildId: BUILD_ID,
      startedAt: new Date().toISOString(),
      // What the detectors chose. A wrong answer here is the root cause of every
      // "only the first screenful" failure, so it is reported first.
      resultsContainer: `${root.tagName.toLowerCase()}${root.id ? `#${root.id}` : ""}`,
      resultsContainerLinks: root.querySelectorAll("a[href*='/in/']").length,
      scrollContainer: target?.id || "none",
      scrollContainerFound: Boolean(target),
      scrollTop: 0,
      clientHeight: target?.clientHeight || window.innerHeight,
      scrollHeight: target?.scrollHeight || 0,
      visibleCards: 0,
      linksInScan: 0,
      newUrls: 0,
      totalUrls: 0,
      mutations: 0,
      quietScans: 0,
      maxQuietScans: 0,
      page: 1,
      pageUrl: location.href,
      paginationControl: "",
      paginationClicks: 0,
      advertisedTotal: null,
      advertisedTotalReliable: false,
      // Reconciliation: every rendered card ends up in exactly one of these.
      cardsSeen: 0,
      cardsWithoutUrl: 0,
      restrictedCards: 0,
      duplicateLinks: 0,
      unusableSamples: [],
      scans: [],
      stopReason: ""
    };

    /** One read of the page at the current position, merged into the collector. */
    function scan() {
      // Re-resolved (and memoized) each time: LinkedIn can replace the list
      // container mid-pass, and reading a detached one returns nothing.
      const current = listRoot();
      const reading = collectVisibleEntries(current);
      const before = found.size;
      const added = found.absorb(reading.entries);
      tallyCards(current, ledger, countedAnchors);
      const control = findPaginationControl(current);

      diagnostics.visibleCards = reading.entries.length;
      diagnostics.linksInScan = reading.links;
      diagnostics.newUrls += added;
      diagnostics.totalUrls = found.size;
      diagnostics.scrollTop = currentScrollTop(target);
      diagnostics.scrollHeight = maxScrollTop(target) + (target?.clientHeight || window.innerHeight);
      diagnostics.mutations = mutations.count;
      diagnostics.quietScans = added ? 0 : diagnostics.quietScans + 1;
      diagnostics.maxQuietScans = Math.max(diagnostics.maxQuietScans, diagnostics.quietScans);
      diagnostics.paginationControl = control?.label || "";
      if (diagnostics.scans.length < 200) {
        diagnostics.scans.push({
          scrollTop: diagnostics.scrollTop,
          visibleCards: reading.entries.length,
          linksInScan: reading.links,
          newUrls: added,
          totalUrls: found.size,
          mutations: mutations.count
        });
      }

      // Persist as we go, not once at the end.
      if (added) reportProgress(found.entries().slice(before), { totalUrls: found.size, scans: diagnostics.scans.length });
      return added;
    }

    const finish = (extra) => {
      const totals = readConnectionTotal();
      diagnostics.advertisedTotal = totals.total;
      diagnostics.advertisedTotalReliable = totals.reliable;
      diagnostics.cardsSeen = ledger.cardsSeen;
      diagnostics.cardsWithoutUrl = ledger.cardsWithoutUrl;
      diagnostics.restrictedCards = ledger.restrictedCards;
      diagnostics.duplicateLinks = ledger.duplicateLinks;
      diagnostics.unusableSamples = ledger.samples();
      const reconciliation = Core.reconcileDiscovery({
        advertisedTotal: totals.total,
        totalReliable: totals.reliable,
        uniqueUrls: found.size,
        duplicateLinks: ledger.duplicateLinks,
        cardsWithoutUrl: ledger.cardsWithoutUrl,
        restrictedCards: ledger.restrictedCards
      });
      diagnostics.reconciliation = reconciliation;
      diagnostics.finishedAt = new Date().toISOString();
      state.lastDiagnostics = diagnostics;
      return {
        entries: found.entries(),
        urls: found.urls(),
        total: totals.total,
        totalReliable: totals.reliable,
        cards: ledger.toJSON(),
        reconciliation,
        diagnostics,
        ...extra
      };
    };

    try {
      // "current" simply reads the connections already on screen. It never scrolls
      // or pages, so Start Collecting can queue the visible page and begin at once.
      if (mode === "current") {
        await waitForDomQuiet();
        scan();
        diagnostics.stopReason = "current-page";
        return finish({
          challenge: { challenged: false, kind: "", message: "" },
          cursorY: currentScrollTop(target),
          atBottom: atDocumentBottom(target),
          clickedPagination: false,
          paginationAvailable: Boolean(findPaginationControl()),
          steps: 0
        });
      }

      let cursorY = startY;
      let steps = 0;
      let atBottom = false;
      let clickedPagination = false;
      let idleAtBottom = 0;
      let grew = false;

      // Resume exactly where the previous pass stopped.
      scrollListTo(startY, target);
      await waitForDomQuiet();
      scan();

      for (;;) {
        // The universal Stop, checked before anything else and before every
        // step. `atBottom: false` is what stops the worker reading a stopped
        // pass as a finished list — a stop is an interruption, never an answer.
        if (state.aborted) {
          diagnostics.stopReason = "user-stopped";
          return finish({
            stopped: true,
            challenge: { challenged: false, kind: "", message: "" },
            cursorY: currentScrollTop(target),
            atBottom: false,
            clickedPagination,
            paginationAvailable: Boolean(findPaginationControl(root)),
            steps
          });
        }
        const midChallenge = currentChallenge();
        if (midChallenge.challenged) {
          diagnostics.stopReason = `challenge:${midChallenge.kind}`;
          return finish({ challenge: midChallenge, cursorY: currentScrollTop(target), atBottom: false, clickedPagination, paginationAvailable: false, steps });
        }
        // The user switched away mid-pass. Stop and report it as an interruption:
        // `atBottom: false` guarantees the worker cannot read this as the end.
        if (!isPageVisible() || state.wentHidden) {
          diagnostics.stopReason = "hidden";
          return finish({
            hidden: true,
            visibilityState: document.visibilityState,
            challenge: { challenged: false, kind: "", message: "" },
            cursorY: currentScrollTop(target),
            atBottom: false,
            clickedPagination,
            paginationAvailable: Boolean(findPaginationControl(root)),
            steps
          });
        }

        // The layout can change under us as the list grows, so re-resolve both.
        const currentRoot = listRoot();
        target = scrollTarget(currentRoot) || target;
        diagnostics.scrollContainer = target?.id || "none";
        diagnostics.scrollContainerFound = Boolean(target);
        diagnostics.clientHeight = target?.clientHeight || window.innerHeight;

        const control = findPaginationControl(currentRoot);
        const plan = Core.planDiscoveryStep({
          atBottom: atDocumentBottom(target),
          grew,
          idleAtBottom,
          paginationAvailable: Boolean(control),
          steps,
          maxSteps
        });
        idleAtBottom = plan.idleAtBottom;

        if (plan.action === Core.DISCOVERY_ACTION.DONE) {
          atBottom = plan.exhausted;
          diagnostics.stopReason = plan.reason;
          break;
        }

        const baselineLinks = profileLinkCount();
        const baselineHeight = documentHeight();

        if (plan.action === Core.DISCOVERY_ACTION.SCROLL) {
          // Gradual: never jump to the bottom, or the rows in between never mount.
          const viewport = target?.clientHeight || window.innerHeight;
          const stepSize = Math.max(600, Math.round(viewport * 0.8));
          scrollListTo(currentScrollTop(target) + stepSize, target);
          steps += 1;
          await waitForDomQuiet();
        } else if (plan.action === Core.DISCOVERY_ACTION.PAGINATE) {
          // Nothing loaded on its own: page the list forward. This is the only
          // control the extension is ever allowed to activate.
          control.element.click();
          clickedPagination = true;
          diagnostics.paginationClicks += 1;
          diagnostics.page += 1;
          steps += 1;
          await waitForGrowth(baselineLinks, baselineHeight);
        } else {
          // At the bottom of what is rendered so far. This is NOT the end of the
          // list: LinkedIn fetches the next slice here, so wait for real growth
          // before concluding anything.
          steps += 1;
          await nudge(target);
          await waitForGrowth(baselineLinks, baselineHeight);
        }

        const added = scan();
        cursorY = currentScrollTop(target);
        grew = added > 0 || profileLinkCount() > baselineLinks || documentHeight() > baselineHeight + 40;
      }

      return finish({
        challenge: { challenged: false, kind: "", message: "" },
        cursorY,
        atBottom,
        clickedPagination,
        paginationAvailable: Boolean(findPaginationControl(root)),
        steps
      });
    } finally {
      scrollListTo(originalY, target);
      mutations.stop();
    }
  }

  state.handler = (message, _sender, sendResponse) => {
    if (message?.type === "PV_PING") {
      sendResponse({ ok: true, buildId: BUILD_ID, surface: "connections", url: location.href, connectionsPage: Core.isConnectionsPage(location.href) });
      return false;
    }

    if (message?.type === "PV_CHECK_PAGE") {
      sendResponse({ ok: true, buildId: BUILD_ID, surface: "connections", url: location.href, challenge: currentChallenge() });
      return false;
    }

    if (message?.type === "PV_CHECK_LOGIN") {
      // Session detection only: no credential is read, requested, or stored.
      sendResponse({ ok: true, buildId: BUILD_ID, surface: "connections", url: location.href, auth: currentAuthState() });
      return false;
    }

    if (message?.type === "PV_CONNECTION_TOTAL") {
      const totals = readConnectionTotal();
      sendResponse({ ok: true, buildId: BUILD_ID, ...totals });
      return false;
    }

    if (message?.type === "PV_GET_DIAGNOSTICS") {
      sendResponse({ ok: true, buildId: BUILD_ID, surface: "connections", diagnostics: state.lastDiagnostics });
      return false;
    }

    if (message?.type === "PV_STOP_ALL") {
      // The universal Stop. A pass already walking the list ends at its next
      // step; everything it already streamed to the worker stays saved.
      state.aborted = true;
      sendResponse({ ok: true, buildId: BUILD_ID, surface: "connections", stopped: true });
      return false;
    }

    if (message?.type === "PV_DISCOVER_CONNECTIONS") {
      if (!Core.isConnectionsPage(location.href)) {
        sendResponse({ ok: false, error: "Open your LinkedIn Connections page before discovering profiles.", buildId: BUILD_ID });
        return false;
      }
      if (!state.discovering) {
        state.discovering = discoveryPass(message.options || {}).finally(() => { state.discovering = null; });
      }
      state.discovering
        .then((result) => sendResponse({ ok: true, buildId: BUILD_ID, ...result }))
        .catch((error) => sendResponse({ ok: false, buildId: BUILD_ID, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    return false;
  };

  chrome.runtime.onMessage.addListener(state.handler);
})();
