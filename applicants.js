/**
 * Content-script adapter for LinkedIn's recruiter hiring surface.
 *
 * Framework-free, exactly like [content.js](content.js) and
 * [connections.js](connections.js): this file supplies observations and performs
 * the four gated clicks, and every decision it makes is made for it by
 * [src/applicants-core.js](src/applicants-core.js) or by the profile core it
 * reuses. React is never imported here.
 *
 * What it collects, per applicant, is the record the request specified: the job,
 * the person, their contact details, their resume, their history, the platform's
 * own qualification verdicts, and their screening answers. It works only with
 * what the recruiter's own logged-in account already renders on screen. It sends
 * nothing, contacts nobody, and changes no state on LinkedIn — every control it
 * is allowed to touch is a disclosure control that reveals something already
 * addressed to this recruiter.
 *
 * The clicks, and there are four kinds and no others:
 *   1. The applicant's own contact disclosure, gated by
 *      `classifyApplicantControl({ purpose: "contact" })` and proven inside the
 *      applicant panel.
 *   2. Their resume, gated by `purpose: "resume"` — and only when the control
 *      carries no href to read directly.
 *   3. A collapsed section's own expander, gated by `purpose: "disclosure"` and
 *      proven inside the panel, capped per scan.
 *   4. A row of the applicant list, gated by `purpose: "applicant-row"` and
 *      proven inside the list, which is how "collect every applicant" advances.
 * Plus the one shared dismiss that closes whichever overlay was opened.
 * Shortlist, Move to, Reject, Interview, Message, Send and Rate are refused by
 * the denylist before any allowlist is consulted.
 */
(() => {
  "use strict";

  const BUILD_ID = "2026-08-03-react-v3.7.8";
  const Core = globalThis.ProfileVaultCore;
  const Applicants = globalThis.ProfileVaultApplicants;
  if (!Core) throw new Error("Profile Vault extraction core is unavailable.");
  if (!Applicants) throw new Error("Profile Vault applicants core is unavailable.");
  // Optional: supplies the scroll-container chooser and the challenge detector.
  const Connections = globalThis.ProfileVaultConnections || null;

  const previous = globalThis.__PROFILE_VAULT_APPLICANTS__;
  /**
   * Retire the copy this one replaces, through the mechanism it already honours.
   *
   * A re-injection replaces the LISTENERS and the `state` object, and until now
   * that was all it did — but a run already in flight is a promise held by the
   * old closure, and it keeps going: it keeps walking the list, keeps pressing
   * rows, and keeps its own idea of which applicant is open. Two loops then
   * drive one list against each other, each undoing the other's navigation, and
   * to the recruiter that is a page that will not sit still. Worse, the old loop
   * is unstoppable from outside — Stop sets `aborted` on the NEW state, and the
   * old loop reads its own.
   *
   * The worker re-injects on any build-id mismatch and after a single ping
   * timeout, so this is not a rare path; a busy page that answers slowly is
   * enough. Setting the old copy's own flags is all it takes: its next
   * `assertRunnable()` throws `stoppedError`, its `error?.stopped` branch marks
   * the run STOPPED and breaks, and it unwinds. Nothing is discarded (rule 13a)
   * — every applicant it had finished was already persisted by the streamed
   * `PV_APPLICANT_SAVE`.
   */
  if (previous) {
    previous.aborted = true;
    if (previous.autoRun) previous.autoRun.disabled = true;
    if (previous.run) previous.run.stopRequested = true;
  }
  if (previous?.handler) chrome.runtime.onMessage.removeListener(previous.handler);
  if (previous?.urlTimer) clearInterval(previous.urlTimer);
  if (previous?.visibilityHandler) document.removeEventListener("visibilitychange", previous.visibilityHandler);
  // Everything the route watcher installed. A re-injection that left these
  // behind would run two watchers over one page, each with its own idea of
  // where the page had been.
  if (previous?.routeObserver) previous.routeObserver.disconnect();
  if (previous?.navigationHandler) {
    window.removeEventListener("popstate", previous.navigationHandler);
    window.removeEventListener("hashchange", previous.navigationHandler);
  }
  if (previous?.pageShowHandler) window.removeEventListener("pageshow", previous.pageShowHandler);
  // The on-page notice belongs to the injection that created it. Left behind, a
  // re-injection would strand a banner on the recruiter's page with no timer
  // left alive to take it away again.
  if (previous?.noticeTimer) clearTimeout(previous.noticeTimer);
  if (previous?.noticeElement) {
    try {
      previous.noticeElement.remove();
    } catch {
      // The page may already have replaced the subtree it was in.
    }
  }

  const state = {
    buildId: BUILD_ID,
    lastUrl: location.href,
    lastDiagnostics: null,
    extracting: null,
    running: null,
    run: Applicants.createRunState(),
    /** Set by Stop. Every loop checks it before it does anything else. */
    aborted: false,
    /**
     * Resume URLs already saved, mapped to where they landed.
     *
     * A Set through 3.7.6, which is why an applicant collected twice reported
     * `already_saved` with an empty `resume_file`: the file was on disk and the
     * column could not say which one it was.
     */
    downloadedResumes: new Map(),
    handler: null,
    urlTimer: null,
    visibilityHandler: null,
    routeObserver: null,
    navigationHandler: null,
    pageShowHandler: null,
    /** The on-page "resumed" banner, and the timer that removes it. */
    noticeElement: null,
    noticeTimer: null,
    wentHidden: false,
    /**
     * Coming back to a job the recruiter already started a run on.
     *
     * `lastKey` is the view this page was showing the last time it was looked
     * at, so an arrival can be told from a row click. `pendingKey` is an arrival
     * that has **not been fulfilled yet** — not merely one deferred by a hidden
     * tab — and it is what makes a transient failure retryable instead of lost.
     * `attempts` bounds that retrying, `disabled` is a Stop pressed on this
     * page, and `busy` is one attempt at a time.
     */
    autoRun: {
      lastKey: "",
      pendingKey: "",
      /**
       * A view this document has already run to COMPLETION.
       *
       * What stops a return to the tab restarting a walk that has nothing left
       * to do. Per-document on purpose: a reload deliberately restores the
       * restart, because a reload is how a recruiter says "start again".
       */
      ranKey: "",
      /**
       * The view the fruitless-return counter below belongs to, and how many
       * consecutive tab returns have restarted that view's run without
       * collecting anybody new.
       *
       * `ranKey` only ever bounds a run that reached COMPLETION, and an
       * interrupted run is the far more common outcome — the tab going hidden
       * is what interrupts it, and switching tabs is exactly how the recruiter
       * uses this. So every return restarted the entire walk from the first row,
       * the restart was interrupted by the next switch away, and nothing was
       * ever recorded: an unbounded loop of re-paging and re-opening rows, which
       * is what the page is doing when it "keeps reloading".
       *
       * A restart must EARN the next one by collecting somebody. That keeps the
       * feature this exists for — come back to a genuinely interrupted run and
       * it continues — while a run that returns having achieved nothing is not
       * tried again on the next glance.
       */
      returnKey: "",
      fruitlessReturns: 0,
      /** So the "not restarting again" line is said once, not on every switch. */
      quietedReturns: false,
      disabled: false,
      busy: false,
      attempts: 0
    }
  };
  globalThis.__PROFILE_VAULT_APPLICANTS__ = state;

  const { cleanText, uniqueText, toLines } = Applicants;

  // ------------------------------------------------------------- visibility
  // Same reason as the profile scan: LinkedIn does not render a hidden tab, so
  // "nothing changed for N reads" would be satisfied instantly by a background
  // tab and a half-mounted panel would be saved as a finished applicant.

  function isPageVisible() {
    return document.visibilityState === "visible";
  }

  state.visibilityHandler = () => {
    if (!isPageVisible()) {
      state.wentHidden = true;
      return;
    }
    // A job that arrived while the tab was in the background is started the
    // moment LinkedIn is rendering it again — rule 12a, from the other side.
    if (state.autoRun.pendingKey) resumeAutoRun();
    else noteReturnToTab();
  };
  document.addEventListener("visibilitychange", state.visibilityHandler);

  // ------------------------------------------------------- the page notice
  /**
   * One line on the recruiter's own page, when work resumes.
   *
   * Every other surface this extension has is a page it owns, with somewhere to
   * report state. This one is a content script on somebody else's page, so a run
   * that paused because the tab went to the background resumed in **silence** —
   * and from the recruiter's side "silence" and "it died" look identical, which
   * is why the reported workaround was to keep pressing F5. That is the whole
   * gap this closes: "as soon as I switch back to it it should start working
   * with a popup msg like 'extension resumed'".
   *
   * Deliberately inert. `pointer-events: none` so it can never come between the
   * recruiter and a control on their own page, `role="status"` with a polite
   * live region so it is announced without taking focus, and it removes itself.
   * It is **not a control** — nothing in this extension ever clicks it, and rule
   * 9's budget is untouched.
   *
   * Styled inline because a content script has no stylesheet of its own on
   * linkedin.com. MV3's CSP is `script-src 'self'`, which constrains scripts and
   * not the `style` property, so nothing here is loosened by it.
   */
  const NOTICE_VISIBLE_MS = 4200;

  function showPageNotice(text) {
    try {
      if (!document.body) return;
      let element = state.noticeElement;
      if (!element || !document.contains(element)) {
        element = document.createElement("div");
        element.id = "profile-vault-notice";
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        element.style.cssText = [
          "position:fixed", "top:16px", "left:50%", "transform:translateX(-50%)",
          "z-index:2147483647", "padding:10px 18px", "border-radius:10px",
          "background:#1b1a20", "color:#ffffff", "text-align:center",
          "font:600 13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif",
          "box-shadow:0 8px 28px rgba(0,0,0,0.30)", "pointer-events:none",
          "max-width:520px"
        ].join(";");
        document.body.appendChild(element);
        state.noticeElement = element;
      }
      element.textContent = text;
      clearTimeout(state.noticeTimer);
      state.noticeTimer = setTimeout(() => {
        try {
          element.remove();
        } catch {
          // The page may have replaced the subtree it was mounted in.
        }
        if (state.noticeElement === element) state.noticeElement = null;
      }, NOTICE_VISIBLE_MS);
    } catch {
      // A notice is a courtesy. It must never be the thing that ends a run.
    }
  }

  function hiddenPageError() {
    const error = new Error("The applicants page is hidden; LinkedIn is not rendering it.");
    error.hidden = true;
    return error;
  }

  /** Thrown when Stop was pressed. Never a failure — an interruption. */
  function stoppedError() {
    const error = new Error("Collection was stopped.");
    error.stopped = true;
    return error;
  }

  function assertRunnable() {
    if (state.aborted) throw stoppedError();
    if (!isPageVisible() || state.wentHidden) throw hiddenPageError();
  }

  /**
   * Start a piece of work: clear the stop flag, and re-derive the hidden flag
   * from what the page actually is *right now*.
   *
   * The live defect this fixes: `state.wentHidden` is latched by the
   * `visibilitychange` listener the instant the recruiter switches tab — which
   * is the normal way to reach the extension's own Applicants page — and it was
   * only ever cleared inside `extractApplicant`, several steps into a run.
   * `extractAllApplicants` reset `aborted` and nothing else, so it went
   * straight into `loadEveryApplicantRow`, hit `assertRunnable()`, and threw
   * "the applicants page is hidden" before it had read a single row. Every
   * later press did the same. The only thing that cleared the latch was
   * reloading the page, because that re-injects the content script with a fresh
   * `state` — which is exactly the workaround that was being used.
   */
  /**
   * Clear the hidden latch when the page is renderable, and never set it.
   *
   * `assertRunnable` tests `!isPageVisible() || state.wentHidden` — a
   * disjunction whose first half is SELF-CLEARING (ask again a second later and
   * a page that came back answers differently) and whose second half is not.
   * That asymmetry is the whole hazard: sampling `!isPageVisible()` into the
   * latch at a moment the tab happens not to be active writes a permanent
   * answer to a temporary question, and every later `assertRunnable` throws
   * `hidden` on a page that is plainly on screen. The worst offender was the
   * resume cycle's `finally`, which samples across a process boundary it cannot
   * win: the worker closes the document tab and re-activates the hiring tab, and
   * whether that has landed by the time this line runs is a race.
   *
   * Nothing is lost by only ever clearing. A genuinely hidden page is still
   * refused, by the half of the disjunction that asks the question live.
   */
  function clearHiddenLatchIfVisible() {
    if (isPageVisible()) state.wentHidden = false;
  }

  function beginRun() {
    state.aborted = false;
    clearHiddenLatchIfVisible();
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wait for a condition instead of for a duration.
   *
   * Every wait in this file that can be expressed as "until X is true" is
   * expressed that way; the fixed sleeps that remain are the two the platform
   * forces — the beat after a click before a menu can exist, and the poll
   * interval of the settle loop.
   */
  async function waitFor(predicate, { timeoutMs = 8000, pollMs = 150, label = "condition" } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      assertRunnable();
      let value = null;
      try {
        value = predicate();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await wait(pollMs);
    }
  }

  /** Resolves once the DOM has stopped changing, or the timeout elapses. */
  function waitForDomQuiet(quietMs = 300, timeoutMs = 2500) {
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

  // ---------------------------------------------------------------- the DOM
  // Nothing below matches a generated class name as a hard requirement. Class
  // names appear only inside `:is()`-style candidate lists that are always
  // unioned with a semantic selector, so a renamed class costs a bonus, never a
  // match — the same rule the profile extractor is held to.

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
      "footer",
      "nav",
      "[role='navigation']",
      ".msg-overlay-list-bubble",
      ".msg-overlay-conversation-bubble",
      "dialog:not([open])"
    ].join(",")));
  }

  /** The accessible name of an element, for icons that carry the verdict. */
  function accessibleName(element) {
    if (!(element instanceof Element)) return "";
    const labelled = element.getAttribute("aria-labelledby");
    return cleanText([
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.querySelector?.("title")?.textContent,
      labelled ? document.getElementById(labelled)?.textContent : "",
      element.matches?.("[data-test-icon]") ? element.getAttribute("data-test-icon") : ""
    ].filter(Boolean).join(" "));
  }

  /** The verdict icon's accessible name inside a block, or "". */
  function iconLabelIn(block) {
    if (!(block instanceof Element)) return "";
    for (const icon of block.querySelectorAll("svg,[data-test-icon],[role='img'],li-icon,[class*='icon']")) {
      const name = accessibleName(icon);
      if (name) return name;
      const testIcon = icon.getAttribute?.("data-test-icon") || icon.getAttribute?.("type") || "";
      if (testIcon) return cleanText(testIcon).replace(/[-_]/g, " ");
    }
    return "";
  }

  function elementDepth(element) {
    let depth = 0;
    for (let current = element?.parentElement; current; current = current.parentElement) depth += 1;
    return depth;
  }

  function describeScrollCandidate(element, root, isScrollingElement = false, carriesContent = null) {
    if (!(element instanceof Element)) return null;
    const style = getComputedStyle(element);
    const isRoot = isScrollingElement || element === document.documentElement || element === document.body;
    const holdsRoot = Boolean(root) && (element === root || element.contains(root));
    return {
      element,
      id: isScrollingElement ? "document" : `${element.tagName.toLowerCase()}#${elementDepth(element)}`,
      isScrollingElement,
      isDocumentRoot: isRoot,
      overflowY: `${style.overflowY} ${style.overflow}`,
      scrollHeight: element.scrollHeight,
      clientHeight: isRoot ? Math.max(element.clientHeight, window.innerHeight) : element.clientHeight,
      containsList: holdsRoot,
      // A descendant scroller holds no ancestor, so `containsList` cannot speak
      // for it; the caller says whether it carries the content being read.
      carriesContent: carriesContent === null ? holdsRoot : Boolean(carriesContent),
      depth: elementDepth(element)
    };
  }

  /** Does this element carry enough of the root's text to be its scroll box? */
  const COLUMN_TEXT_SHARE = 0.6;

  /**
   * The document, every ancestor of the panel, the panel itself — and any
   * scroll box **inside** it that carries essentially all of its text.
   *
   * This surface makes trap 1 from the connections list the normal case rather
   * than the exception: the applicant detail panel is its own independently
   * scrolling column, so `window.scrollY` never moves and the very first read
   * looks like the bottom. Both directions have to be offered, because which
   * side of the scroller `applicantPanel()` lands on is markup's choice, not
   * ours: if it resolves to a content wrapper the scroller is an ancestor, and
   * if it resolves to the column shell the scroller is a descendant. Offering
   * only ancestors meant the second case fell through to the page.
   */
  function scrollCandidates(root) {
    const seen = new Set();
    const output = [];
    const add = (element, isScrollingElement = false, carriesContent = null) => {
      if (!(element instanceof Element) || seen.has(element)) return;
      seen.add(element);
      const described = describeScrollCandidate(element, root, isScrollingElement, carriesContent);
      if (described) output.push(described);
    };
    add(document.scrollingElement || document.documentElement, true);
    add(document.documentElement);
    add(document.body);
    for (let current = root; current; current = current.parentElement) add(current);

    // Descendants, and only ones that are practically the whole of the root: a
    // sub-panel that scrolls a filter or a menu carries a fraction of the text
    // and is refused, exactly as the connections chooser refuses a container
    // that does not hold the list.
    const wanted = cleanText(root?.innerText || "").length;
    if (root && wanted) {
      for (const element of root.querySelectorAll("div,section,main,ul,ol,[role='list']")) {
        if (seen.has(element)) continue;
        if (element.scrollHeight - element.clientHeight <= Applicants.COLUMN_SCROLL_EPSILON) continue;
        const style = getComputedStyle(element);
        if (!/auto|scroll|overlay/i.test(`${style.overflowY} ${style.overflow}`)) continue;
        if (cleanText(element.innerText || "").length < wanted * COLUMN_TEXT_SHARE) continue;
        add(element, false, true);
      }
    }
    return output;
  }

  /**
   * The container that actually moves the content being read.
   *
   * The column policy first — on this surface the panel and the list each own a
   * scroller and the page moves only its own chrome — and the tested general
   * chooser as the fallback for a layout where the page really is the scroller.
   */
  function chooseScrollTarget(root) {
    const candidates = scrollCandidates(root);
    const column = Applicants.chooseColumnScrollTarget?.(candidates);
    if (column) return column;
    if (!Connections?.chooseScrollTarget) return null;
    return Connections.chooseScrollTarget(candidates);
  }

  function currentScrollTop(target) {
    if (!target?.element) return window.scrollY;
    return target.isScrollingElement ? Math.max(window.scrollY, target.element.scrollTop) : target.element.scrollTop;
  }

  /** How tall the target's own viewport is, read live rather than remembered. */
  function viewportOf(target) {
    if (!target?.element) return window.innerHeight;
    return target.isDocumentRoot || target.isScrollingElement
      ? Math.max(target.element.clientHeight, window.innerHeight)
      : target.element.clientHeight || window.innerHeight;
  }

  function maxScrollPosition(target) {
    if (!target?.element) return Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight);
    // `scrollHeight` is read live, so `clientHeight` has to be as well: mixing a
    // live height against one remembered from before the column had mounted
    // produced a bottom that arrived hundreds of pixels early.
    return Math.max(0, target.element.scrollHeight - viewportOf(target));
  }

  function scrollPanelTo(top, target) {
    const value = Math.max(0, Math.min(Number(top) || 0, maxScrollPosition(target)));
    if (!target?.element || target.isScrollingElement) window.scrollTo({ top: value, behavior: "auto" });
    if (target?.element) target.element.scrollTop = value;
  }

  /**
   * Do a scroll step with the PAGE held exactly where it was.
   *
   * `scrollIntoView` is the right tool for a column whose markup differs per
   * account — the browser scrolls every scrollable ancestor the element needs, so
   * a container this code failed to recognise still moves. Its cost is that "every
   * ancestor" includes the document, so a scan visibly dragged the recruiter's
   * whole page around and only put it back when the applicant was finished.
   *
   * The requirement is that a scan moves the detail column and nothing else. So
   * the mechanism is kept — the guess stays out of it — and the document is simply
   * put back on the same frame, before anything can be painted at the wrong
   * offset. Whatever column actually scrolled keeps its new position; the page
   * never appears to move at all.
   */
  function anchorPage(run) {
    const left = window.scrollX;
    const top = window.scrollY;
    try {
      return run();
    } finally {
      if (window.scrollX !== left || window.scrollY !== top) {
        window.scrollTo({ top, left, behavior: "auto" });
      }
    }
  }

  // ------------------------------------------------------- panel and list
  // Two columns: the applicant list on the left and the detail panel on the
  // right. Both are found by what they contain, never by a class name — the
  // panel is whichever visible container carries the most applicant section
  // headings, and the list is whichever carries the most links to other
  // applications of this job.

  /**
   * The section names, and the wordings LinkedIn actually renders them in.
   *
   * Widened in 3.7.6 after `current_role`, `current_company` and
   * `total_experience` came back empty on every row of a live run. All three are
   * derived from the Experience section and from nothing else (rule 7 and
   * `deriveCurrentPosition`), so an empty column means no experience card was
   * ever read — and the previous `^experiences?$` matched the section's title
   * only when the account rendered it as that exact word, with nothing after it.
   * A count (`Experience (5)`), a qualifier (`Work experience`) or a trailing
   * colon was enough to make the whole section invisible, silently: no heading
   * matched, no section existed, and every reader returned 0 without a warning.
   */
  const SECTION_PATTERNS = [
    // 3.7.7: the same widening, for the section the recruiter screen leads with.
    // `Qualifications` is what LinkedIn labels the must-have / preferred verdict
    // card, but plenty of accounts render only its two subheadings and never the
    // word itself — see `QUALIFICATION_SUBHEADINGS` below, which is what stops
    // that being an empty column rather than an absent section.
    { key: "qualifications", pattern: /^(?:screening |job |candidate |applicant )?qualifications?(?: summary| overview| match)?$/i },
    { key: "screening", pattern: /^screening question(?: response)?s?$/i },
    { key: "experience", pattern: /^(?:work |professional |employment |career )?experiences?$/i },
    { key: "education", pattern: /^education(?:al background)?$/i },
    { key: "skills", pattern: /^(?:top )?skills?(?: (?:&|and) endorsements)?$/i },
    { key: "about", pattern: /^(?:about|summary)$/i },
    { key: "resume", pattern: /^(?:resume|cv|curriculum vitae|attachments?)$/i }
  ];

  /** What a section title may carry after its name without ceasing to be one. */
  function sectionKeyFor(text) {
    const value = cleanText(text)
      // "Experience · 3 roles" — a middot list of metadata after the name.
      .replace(/\s*[·•|].*$/, "")
      // "Experience (5)" and "Skills (12+)" — the count LinkedIn renders inline.
      .replace(/\s*\(\s*\d+\+?\s*\)\s*$/, "")
      // "Experience 5" — the same count with the brackets not rendered.
      .replace(/\s+\d+\+?$/, "")
      .replace(/\s*[:：]\s*$/, "");
    return SECTION_PATTERNS.find((entry) => entry.pattern.test(value))?.key || "";
  }

  /** The elements a section title is allowed to be, stated once so it can be logged. */
  const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6,[role='heading'],[aria-level]";

  /**
   * Elements that are not headings but are the only thing naming a section.
   *
   * Deliberately narrow and only ever consulted for a section nothing else
   * found: a short leaf whose own text *is* the section name. Rule 11 still
   * holds — this matches on rendered text, never on a generated class name.
   */
  const SECTION_LABEL_SELECTOR = "div,span,p,strong,b,dt,summary,legend";

  /** Every heading in `root`, in document order, with the section it names. */
  function headingsIn(root) {
    const output = [];
    for (const element of root.querySelectorAll(HEADING_SELECTOR)) {
      if (!isVisible(element)) continue;
      const text = cleanText(element.innerText || element.textContent);
      if (!text || text.length > 90) continue;
      output.push({ element, text, key: sectionKeyFor(text) });
    }
    return output;
  }

  /**
   * Section titles LinkedIn did not mark up as headings.
   *
   * The last resort, asked only for the keys nothing else produced, because a
   * section that exists on screen and cannot be found is indistinguishable from
   * an applicant who has no experience — and the record would say the second.
   * `textContent` is tested before `isVisible`, so the common case costs no
   * layout: an element whose whole text is longer than a section name is
   * rejected without ever being measured. The innermost match wins, so the
   * wrapper around the label is not mistaken for the label.
   */
  function sectionLabelsIn(root, wanted) {
    if (!root || !wanted?.size) return [];
    const found = [];
    for (const element of root.querySelectorAll(SECTION_LABEL_SELECTOR)) {
      const raw = element.textContent || "";
      if (!raw || raw.length > 60) continue;
      const key = sectionKeyFor(raw);
      if (!key || !wanted.has(key)) continue;
      if (!isVisible(element)) continue;
      found.push({ element, text: cleanText(raw), key });
    }
    return found.filter((entry) => !found.some((other) => other !== entry && entry.element.contains(other.element)));
  }

  /**
   * Does this link's ADDRESS name an application of this same job?
   *
   * Deliberately separate from "is this link a row". They are two questions and
   * conflating them costs the arrival test its best source: `panelApplicationId`
   * asks the panel's own link *who it is showing*, and that link is labelled
   * whatever LinkedIn labels it — `View full profile`, `Resume`, an icon. Judging
   * it as a row would refuse it, and the answer would silently fall back to the
   * address bar, which on this surface moves ahead of the render. So the address
   * test stands alone and the row test is built on top of it.
   */
  function hasApplicationHref(anchor) {
    const href = anchor?.getAttribute?.("href") || anchor?.href || "";
    if (!href) return false;
    return /applicationId=|\/applicants?\/\d/i.test(href);
  }

  /** A link that opens another application of this same job. */
  function isApplicantRowLink(anchor) {
    if (!hasApplicationHref(anchor)) return false;
    // A control is not a row, however applicant-shaped its address is. The list
    // links "Edit qualifications" in its own header at the applicationId the page
    // is on, which is the SAME key the open applicant's row hashes to — so
    // letting it in costs that applicant their turn, once per page and in
    // silence. `isApplicantRowLabel` explains the whole chain.
    //
    // `textContent` rather than `innerText`, and never the `aria-label`. The
    // first is because this runs for every anchor of every list scan and the
    // row's name getter is lazy precisely because a layout flush per row is not.
    // The second is because "View Komal Sharma's application" is an entirely
    // plausible accessible name for a row, and it leads with a verb — judging it
    // would refuse every row on the page rather than one control.
    return Applicants.isApplicantRowLabel(cleanText(anchor.textContent));
  }

  /** How many applicant-list rows live inside this element. */
  function rowLinksIn(element) {
    return [...element.querySelectorAll("a[href]")].filter(isApplicantRowLink).length;
  }

  /**
   * The applicant detail panel.
   *
   * Scored, not selected: the winner is the smallest visible container that
   * still carries at least two of the applicant sections.
   *
   * **A container holding the applicant list is refused outright.** That was the
   * live defect: a wrapper around both columns satisfies "two sections", so it
   * won, and the first line of its text is the list's own heading — every record
   * came back named "Applicants". One row link is allowed, because the panel
   * legitimately links to the application it is showing; two or more is a list.
   */
  /**
   * The panel, **only when one is genuinely mounted** — null while LinkedIn is
   * between applicants.
   *
   * The strict half of `applicantPanel()`, split out because two callers want
   * opposite things from a torn-down panel. A scan already in flight wants
   * *something* to keep reading, so it takes the loose answer below. Anything
   * deciding **who the panel is showing** wants the truth, and "nobody is
   * mounted" is a truth the loose answer cannot express — its last resort is a
   * container that holds the applicant list.
   */
  function mountedApplicantPanel() {
    const candidates = [
      ...document.querySelectorAll("main,[role='main'],section,[class*='applicant'],[class*='profile-card'],[class*='detail']")
    ].filter((element) => element instanceof Element && isVisible(element) && !isExcludedContext(element));

    let best = null;
    let bestScore = 0;
    let bestSize = Infinity;
    for (const element of candidates) {
      if (rowLinksIn(element) > 1) continue;
      const keys = new Set(headingsIn(element).map((heading) => heading.key).filter(Boolean));
      const score = keys.size;
      if (score < Applicants.PANEL_MIN_SECTIONS) continue;
      const size = (element.innerText || "").length;
      if (score > bestScore || (score === bestScore && size < bestSize)) {
        best = element;
        bestScore = score;
        bestSize = size;
      }
    }
    return best;
  }

  function applicantPanel() {
    const mounted = mountedApplicantPanel();
    if (mounted) return mounted;

    // Nothing qualified. Fall back to the widest container that is still not
    // the list, rather than to `document.body`, which always contains it.
    const fallback = [...document.querySelectorAll("main,[role='main']")]
      .filter((element) => isVisible(element) && rowLinksIn(element) <= 1)
      .sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0];
    return fallback || document.querySelector("main") || document.body;
  }

  /**
   * The application the panel's OWN markup names, or `""`.
   *
   * **The address bar is deliberately not a fallback here**, and that was a live
   * regression: it moves *ahead of the render*, so the instant a row is clicked
   * it already says the new id while the column it names is still being torn down
   * and rebuilt. Falling back to it made the arrival test vacuous — "is the panel
   * showing the applicant we asked for" answered yes before the panel had
   * changed at all — so the only thing left deciding arrival was the section
   * count, which is the half this surface cannot be relied on to satisfy.
   *
   * Asked of the **address** (`hasApplicationHref`) rather than of the row policy
   * (`isApplicantRowLink`): the panel's own link is not a list row and is not
   * labelled like one — `View full profile`, `Resume`, or an icon with no text at
   * all — so judging its label would refuse it and leave the panel unidentifiable.
   */
  function panelOwnApplicationId(panel) {
    if (!panel?.isConnected) return "";
    for (const anchor of panel.querySelectorAll("a[href]")) {
      if (!hasApplicationHref(anchor)) continue;
      const id = Applicants.parseHiringContext(anchor.href || anchor.getAttribute("href") || "").applicationId;
      if (id) return id;
    }
    return "";
  }

  /** The member the panel's own markup links to, canonical, or `""`. */
  function panelMemberUrl(panel) {
    if (!panel?.isConnected) return "";
    const anchor = [...panel.querySelectorAll("a[href*='/in/']")].find((element) => isVisible(element));
    if (!anchor) return "";
    return Core.canonicalizeProfileUrl(anchor.href || anchor.getAttribute("href") || "") || "";
  }

  /**
   * Who the panel is showing — built from links, never from its text.
   *
   * The old fingerprint was two thirds `innerText`, so a teardown, a spinner and
   * a re-render of the same person all read as "a different applicant arrived".
   * Everything here is an identifier.
   */
  function panelIdentity(panel = arrivalPanel()) {
    const live = panel?.isConnected ? panel : null;
    const application = panelOwnApplicationId(live);
    const profile = panelMemberUrl(live);
    return [application ? `id:${application}` : "", profile ? `in:${profile}` : ""].filter(Boolean).join("|");
  }

  /**
   * A panel there is something to say about.
   *
   * **THE REGRESSION THIS EXISTS FOR: it scrolled the first profile and then
   * never scrolled another.** Arrival was asked of `mountedApplicantPanel()`
   * alone, which requires one container to hold `PANEL_MIN_SECTIONS` *hydrated*
   * section headings — and this surface routinely does not put them there. That
   * is not a suspicion: it is why `buildSectionMap()` widens page-wide for any
   * section the panel did not hold, and why `deriveCurrentPosition` kept coming
   * back empty before it did. When the strict resolver answers null, `connected`
   * is false, every poll reads `torn-down`, arrival **never** happens, and the
   * row is skipped after the full timeout — unopened, unscrolled, saved as a
   * name and nothing else. The first applicant survived only because they were
   * already on screen and so were never clicked.
   *
   * So the strict resolver is asked first and the loose one is accepted when it
   * carries an identifier of its own — an application link or the member's
   * `/in/` link. That is enough to answer *who* is on screen, which is the only
   * question arrival actually asks; whether their sections have hydrated is a
   * readiness question, and the scan's own reveal walk and quiet count already
   * own it. A candidate holding more than one row link is still refused, so
   * "the list is on screen" can never look like "the applicant arrived".
   */
  function arrivalPanel() {
    const mounted = mountedApplicantPanel();
    if (mounted) return mounted;
    const loose = applicantPanel();
    if (!loose?.isConnected || rowLinksIn(loose) > 1) return null;
    return panelOwnApplicationId(loose) || panelMemberUrl(loose) ? loose : null;
  }

  /** How many distinct applicant sections have hydrated in the panel. */
  function panelSectionCount(panel) {
    if (!panel?.isConnected) return 0;
    return new Set(headingsIn(panel).map((heading) => heading.key).filter(Boolean)).size;
  }

  /**
   * Is the panel showing `expected`, and has it finished mounting?
   *
   * The DOM half of `Applicants.describePanelArrival` — this reads the page, the
   * core decides. `arrivalPanel()` rather than `mountedApplicantPanel()`, because
   * requiring the strict resolver made the verdict unanswerable on markup that
   * does not put its section headings inside the panel; and rather than
   * `applicantPanel()`, whose last resort is a container holding the list.
   */
  function describeApplicantArrival(expected, previousIdentity = "") {
    const panel = arrivalPanel();
    return Applicants.describePanelArrival({
      expected,
      applicationId: panelOwnApplicationId(panel),
      identity: panelIdentity(panel),
      previousIdentity,
      sections: panelSectionCount(panel),
      connected: Boolean(panel)
    });
  }

  /**
   * The panel, re-resolved if LinkedIn has replaced the one we were holding.
   *
   * The hiring surface is a single-page app that re-mounts the detail column as
   * sections hydrate, and a detached node keeps answering `innerText` with
   * whatever it held when it was unmounted. A scan that held one reference for
   * its whole walk therefore kept re-reading the first screenful it ever saw and
   * settled on it, which looks exactly like "it did not scroll".
   */
  function livePanel(panel) {
    return panel && panel.isConnected ? panel : applicantPanel();
  }

  /**
   * The applicant list column.
   *
   * Trap 2 from the connections list applies unchanged: the list is not
   * reliably inside any particular landmark, so it is whichever visible
   * container holds the most rows, counted with `querySelectorAll`.
   */
  function applicantList() {
    const candidates = [
      ...document.querySelectorAll("main,[role='main'],ul,ol,[role='list'],[class*='applicant'],[class*='list']")
    ].filter((element) => element instanceof Element && isVisible(element) && !isExcludedContext(element));

    let best = null;
    let bestCount = 1;
    let bestDepth = -1;
    for (const element of candidates) {
      const rows = [...element.querySelectorAll("a[href]")].filter(isApplicantRowLink).length;
      if (rows < 2 || rows < bestCount) continue;
      const depth = elementDepth(element);
      // The deepest container that still holds them all: the narrowest wrapper
      // around the list, rather than the page that happens to contain it.
      if (rows > bestCount || depth > bestDepth) {
        best = element;
        bestCount = rows;
        bestDepth = depth;
      }
    }
    return best;
  }

  /**
   * The rows of the applicant list, in the order they render.
   *
   * **The name is read lazily, and that is a performance rule, not a style one.**
   * `innerText` forces a synchronous layout flush on every access, and this
   * function used to take it for EVERY rendered row on EVERY call — while the
   * run calls it several times per applicant and skips through hundreds of
   * already-collected rows. On a 665-applicant job that was tens of thousands of
   * forced reflows spent almost entirely on names nothing ever asked for: the
   * walk keys on `href` (`rowKey`), the already-collected check prefers the
   * `applicationId` from `href`, and only the ONE row actually being opened
   * needs a name. A getter costs nothing until something reads it, and the read
   * still happens while the element is attached, exactly as before.
   *
   * The `text` field it also built is gone: nothing ever read it.
   */
  function applicantRows() {
    const list = applicantList();
    if (!list) return [];
    const seen = new Set();
    const rows = [];
    for (const anchor of list.querySelectorAll("a[href]")) {
      if (!isApplicantRowLink(anchor) || !isVisible(anchor)) continue;
      const row = anchor.closest("li,[role='listitem'],article") || anchor;
      if (seen.has(row)) continue;
      seen.add(row);
      const entry = {
        element: row,
        control: anchor,
        href: anchor.href || anchor.getAttribute("href") || ""
      };
      let cachedName;
      Object.defineProperty(entry, "name", {
        enumerable: true,
        get() {
          if (cachedName === undefined) {
            cachedName = Applicants.cleanApplicantName(toLines(this.element.innerText || "")[0] || "");
          }
          return cachedName;
        }
      });
      rows.push(entry);
    }
    return rows;
  }

  // ------------------------------------------------------------- sections
  // A section is a heading plus everything after it up to the next heading.
  // Blocks inside it are list items when the markup provides them and a text
  // fallback when it does not, so a layout with no <li> still parses.

  /**
   * The container a heading owns: the nearest ancestor holding no other heading.
   *
   * Bounded by **every** other heading since 3.7.6, not only by the one that
   * follows. An ancestor that reaches back over the section *above* it was
   * accepted before, and it cost the page-wide search everything: that root
   * contains a previous section's heading, the widened pass refuses exactly
   * that (a root swallowing a second section), and so Experience — the one
   * section most often outside the resolved panel — resolved to nothing at all.
   * A tighter root is also a more honest one: the blocks read out of it can
   * only be this section's.
   */
  /**
   * Does this candidate carry anything beyond the heading that names it?
   *
   * The live defect (3.7.8): LinkedIn renders the applicant's section title in
   * its own header row — the word plus a collapse chevron — and the entries in a
   * *sibling* container. `sectionRootFor` walked only upwards and stopped at the
   * first ancestor holding another heading, so on that markup it returned the
   * header row itself: a root whose entire text is "Experience". `blocksIn` then
   * found nothing, the text fallback parsed the single word and
   * `EXPERIENCE_NOISE_PATTERN` correctly discarded it, and the applicant was
   * saved with no experience at all — which is how `current_role`,
   * `current_company` and `education` came back empty on a row that plainly
   * showed all three.
   */
  function carriesSectionContent(element, heading) {
    if (!element) return false;
    const text = cleanText(element.innerText || element.textContent || "");
    if (text.length <= cleanText(heading?.text || "").length + 10) return false;
    // A sibling range holds the live nodes rather than owning children.
    if (Array.isArray(element.__pvSectionNodes)) return element.__pvSectionNodes.length > 0;
    if (element.querySelector("li,[role='listitem']")) return true;
    return [...element.children].filter(
      (child) => child instanceof Element && child !== heading?.element && cleanText(child.innerText || "")
    ).length > 0;
  }

  /**
   * A range of siblings, as a section.
   *
   * The last resort, and the one that fits the markup above: when no single
   * ancestor is both content-bearing and free of other sections, the section is
   * the heading's own following siblings up to the next one that names a
   * section. Nothing is constructed — the returned element is the real container
   * when it qualifies, and otherwise a detached wrapper holding **references**
   * to the live nodes, so `innerText` reads what is on screen.
   */
  function siblingSectionFor(heading, allHeadings) {
    const start = heading.element;
    const parent = start.parentElement;
    if (!parent) return null;
    const keyed = new Set(allHeadings.filter((entry) => entry.key).map((entry) => entry.element));
    const taken = [];
    for (let node = start.nextElementSibling; node; node = node.nextElementSibling) {
      if (keyed.has(node) || node.querySelector?.(HEADING_SELECTOR) && headingsIn(node).some((h) => h.key)) break;
      if (cleanText(node.innerText || "")) taken.push(node);
    }
    if (!taken.length) return null;
    const wrapper = document.createElement("div");
    // Appending would MOVE the live nodes out of the page. They are only ever
    // read, so the wrapper mirrors their text and keeps the real nodes intact.
    wrapper.textContent = taken.map((node) => node.innerText || "").join("\n");
    wrapper.__pvSectionNodes = taken;
    return wrapper;
  }

  function sectionRootFor(heading, root, allHeadings) {
    const others = allHeadings.filter((entry) => entry.element !== heading.element);
    let best = null;
    for (let node = heading.element.parentElement; node && node !== root.parentElement; node = node.parentElement) {
      // Bounded by every other heading, not only the next one: an ancestor that
      // reaches back over the section above it would hand this section the
      // wrong blocks, and a wrong Experience entry is worse than an empty one.
      if (others.some((entry) => node.contains(entry.element))) break;
      // ...and it has to actually hold the section. Accepting the first
      // ancestor unconditionally is what returned a bare header row.
      if (carriesSectionContent(node, heading)) best = node;
    }
    return best || siblingSectionFor(heading, allHeadings) || null;
  }

  /**
   * @param {Element} root
   * @param {object} map filled in place; a key already present is never replaced.
   * @param {{excludeList?: boolean, source?: string, headings?: Array}} options
   *   `headings` lets a caller supply candidates that are not heading elements;
   *   everything else about the pass is identical, so there is one copy of the
   *   refusals rather than two.
   */
  /**
   * Is what we already stored for this key actually usable?
   *
   * The amplifier behind three releases of fixes that changed nothing: the panel
   * pass stored *something* for `experience`, and because `collectSections`
   * refused to replace a key already present, every later and better pass — the
   * page-wide search of 3.7.4, the label search of 3.7.6 — was skipped for the
   * one section that needed them. A stored section that yields no blocks and no
   * text beyond its own heading is not an answer; it is the absence of one, and
   * it must not outrank a later candidate that carries the entries.
   */
  function sectionIsUseful(section) {
    if (!section?.element) return false;
    return blocksIn(section).length > 0 || carriesSectionContent(section.element, { text: section.heading });
  }

  function collectSections(root, map, { excludeList = false, source = "panel", headings = null } = {}) {
    if (!root) return map;
    const all = headings || headingsIn(root);
    const list = excludeList ? applicantList() : null;
    for (const heading of all) {
      if (!heading.key) continue;
      const stored = map[heading.key];
      if (stored && sectionIsUseful(stored)) continue;
      if (list && list.contains(heading.element)) continue;
      const element = sectionRootFor(heading, root, all);
      if (!element) continue;
      if (list && list.contains(element)) continue;
      // A widened search must not hand back a container that also swallows
      // another section: the blocks read out of it would belong to the wrong
      // one, and a wrong Experience entry is worse than an empty one (rule 6).
      if (excludeList && all.some((other) => other.key && other.key !== heading.key && element.contains(other.element))) continue;
      const candidate = { key: heading.key, heading: heading.text, element, source };
      // Only replace an unusable one with a usable one — never the other way.
      if (stored && !sectionIsUseful(candidate)) continue;
      map[heading.key] = candidate;
    }
    return map;
  }

  /**
   * Every section of the open applicant, wherever the markup actually put it.
   *
   * The panel first. Then, for anything it did not hold, the page — minus the
   * applicant list, and refusing any container that swallows a second section.
   *
   * The reason for the second pass: `applicantPanel()` picks the *smallest*
   * container carrying the most section headings, and headings that have not
   * hydrated yet do not count. So a panel resolved early can be a sub-container
   * of the real detail column, and every section outside it — Experience,
   * Education, Skills — was then silently invisible for the whole extraction,
   * which is exactly the "current role and company are empty on every row"
   * report. Nothing else on a hiring page renders an Experience or Education
   * heading, so widening the search cannot pick up another member's card.
   */
  /** The nearest element that holds both, or null. */
  function commonAncestor(first, second) {
    if (!(first instanceof Element) || !(second instanceof Element)) return first || second || null;
    for (let node = first; node; node = node.parentElement) {
      if (node.contains(second)) return node;
    }
    return null;
  }

  /**
   * The qualifications card, when LinkedIn never writes the word.
   *
   * Plenty of accounts render `Must-have qualifications` and `Preferred
   * qualifications` as the headings and no plain `Qualifications` above them.
   * `qualificationCategoryOf()` already recognises both — it is how a
   * requirement is filed under a category — but they are *sub*headings, so no
   * section key matched and the whole card was invisible: no requirements, both
   * tallies blank, and nothing said why.
   *
   * The card is the smallest element holding every subheading, and it is
   * refused if it also holds a **different** section, exactly as the page-wide
   * pass is: the blocks read out of it would then belong to the wrong section,
   * and a wrong qualification is worse than an absent one (rule 6).
   */
  function collectQualificationSubsections(root, map, { excludeList = false, source = "subheadings" } = {}) {
    if (map.qualifications || !root) return map;
    const all = headingsIn(root);
    const subs = all.filter((heading) => !heading.key && Applicants.qualificationCategoryOf(heading.text));
    if (!subs.length) return map;

    const list = excludeList ? applicantList() : null;
    if (list && subs.some((heading) => list.contains(heading.element))) return map;

    let container = sectionRootFor(subs[0], root, all);
    for (const heading of subs.slice(1)) {
      container = commonAncestor(container, sectionRootFor(heading, root, all));
      if (!container) return map;
    }
    if (!container) return map;
    if (list && list.contains(container)) return map;
    if (all.some((other) => other.key && container.contains(other.element))) return map;

    map.qualifications = {
      key: "qualifications",
      heading: subs.map((heading) => heading.text).join(" / "),
      element: container,
      source
    };
    return map;
  }

  function buildSectionMap(panel, diagnostics = null) {
    const page = document.querySelector("main") || document.body;
    const map = collectSections(panel, {}, { source: "panel" });
    if (Object.keys(map).length < SECTION_PATTERNS.length) {
      collectSections(page, map, { excludeList: true, source: "page" });
    }
    // Only now, for whatever neither pass produced: a section LinkedIn titled
    // with something that is not a heading element. Asked in the same order —
    // the panel, then the page — and held to the same refusals.
    const missing = () => new Set(SECTION_PATTERNS.map((entry) => entry.key).filter((key) => !map[key]));
    let wanted = missing();
    if (wanted.size) {
      collectSections(panel, map, { source: "panel-label", headings: sectionLabelsIn(panel, wanted) });
      wanted = missing();
    }
    if (wanted.size) {
      collectSections(page, map, { excludeList: true, source: "page-label", headings: sectionLabelsIn(page, wanted) });
    }
    // And last, the one section that is routinely named only by its own two
    // subheadings.
    collectQualificationSubsections(panel, map, { source: "panel-subheadings" });
    collectQualificationSubsections(page, map, { excludeList: true, source: "page-subheadings" });
    if (diagnostics) recordSectionScan(map, panel, page, diagnostics);
    return map;
  }

  /** `div#applicant-detail.some-class`, for a diagnostics line a human can act on. */
  function describeElement(element) {
    if (!(element instanceof Element)) return "none";
    const classes = String(element.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return [
      element.tagName.toLowerCase(),
      element.id ? `#${element.id}` : "",
      classes.length ? `.${classes.join(".")}` : "",
      `@${elementDepth(element)}`
    ].join("");
  }

  /**
   * What the section search was looking for, and what the page actually had.
   *
   * The one diagnostic that makes an empty `current_role` explicable without a
   * live debugging session: the selector that was used, every visible heading
   * the panel and the page rendered with the key each one resolved to, where
   * each section was found, how many blocks came out of it, and which sections
   * nothing named. A heading listed here with an empty `key` is a section whose
   * wording `SECTION_PATTERNS` does not match yet — which is the whole of the
   * "the columns are empty" failure mode, stated in one line.
   *
   * Built once per applicant, at the end of the extraction, because it reads
   * `innerText` across the page and the scan takes dozens of snapshots.
   */
  function recordSectionScan(map, panel, page, diagnostics) {
    const seen = [];
    for (const heading of headingsIn(panel)) {
      seen.push({ where: "panel", text: heading.text, key: heading.key || "" });
    }
    for (const heading of headingsIn(page)) {
      if (panel && panel.contains(heading.element)) continue;
      seen.push({ where: "page", text: heading.text, key: heading.key || "" });
    }
    diagnostics.sectionScan = {
      headingSelector: HEADING_SELECTOR,
      labelSelector: SECTION_LABEL_SELECTOR,
      wanted: SECTION_PATTERNS.map((entry) => `${entry.key}: ${entry.pattern}`),
      panel: describeElement(panel),
      panelTextLength: cleanText(panel?.innerText || "").length,
      headings: seen.slice(0, 80),
      resolved: Object.values(map).map((section) => ({
        key: section.key,
        heading: section.heading,
        foundIn: section.source || "panel",
        root: describeElement(section.element),
        blocks: blocksIn(section).length,
        sample: cleanText(section.element?.innerText || "").slice(0, 200),
        // The real markup, so an empty column is diagnosable from the record as
        // well as from the console.
        html: sectionMarkup(section)
      })),
      missing: SECTION_PATTERNS.map((entry) => entry.key).filter((key) => !map[key])
    };
  }

  /**
   * Put the section scan where the recruiter can see it.
   *
   * Rule 19 in spirit: a field that came back empty has to be explicable from
   * the page it was read on. It is one grouped line per applicant, and it is a
   * warning only when something the record depends on is missing.
   */
  /**
   * The markup a section was actually read out of, bounded.
   *
   * Requested explicitly after `current_role`, `current_company` and
   * `education` came back empty for a fourth time: the heading text and a block
   * count say a section was *found*, and it was — the question that needed
   * answering was what that root actually **contained**, and only the real HTML
   * says that. Truncated hard, because an applicant panel's outerHTML is
   * hundreds of kilobytes and this goes to a console a person has to read.
   */
  const SECTION_HTML_LIMIT = 1500;

  function sectionMarkup(section) {
    const element = section?.element;
    if (!element) return "";
    const html = element.__pvSectionNodes
      ? element.__pvSectionNodes.map((node) => node.outerHTML || "").join("\n")
      : element.outerHTML || "";
    return html.length > SECTION_HTML_LIMIT ? `${html.slice(0, SECTION_HTML_LIMIT)}… [${html.length} chars]` : html;
  }

  /**
   * Did the panel walk actually reach the bottom, for THIS applicant?
   *
   * The same discipline as `logSectionScan`: a walk that stops short must be
   * answerable from the recruiter's own console rather than from an empty
   * column three releases later. `reachedTail` is the load-bearing field —
   * a walk that never reached the tail did not finish, whatever its pass count
   * says — and `movedBy` is what distinguishes "there was nothing below" from
   * "nothing I pressed could move the panel": a walk reporting several passes
   * and `movedBy: 0` names that failure in one line.
   */
  function logReveal(diagnostics, name) {
    const walks = [["reveal", diagnostics?.reveal], ["after-regions", diagnostics?.revealAfterRegions]]
      .filter(([, walk]) => walk);
    if (!walks.length) return;
    const short = walks.filter(([, walk]) => !walk.reachedTail);
    const label = `[Profile Vault ${BUILD_ID}] panel reveal — ${name || "applicant"}: `
      + walks.map(([which, walk]) =>
        `${which} ${walk.passes} pass(es), moved ${Math.round(walk.movedBy)}px, `
        + `${walk.reachedTail ? "reached the bottom" : "DID NOT reach the bottom"} (${walk.stoppedBy})`).join("; ");
    if (short.length) console.warn(label, diagnostics.reveal, diagnostics.revealAfterRegions);
    else console.info(label);
  }

  function logSectionScan(diagnostics) {
    const scan = diagnostics?.sectionScan;
    if (!scan) return;
    const missingExperience = !diagnostics?.totals?.experience;
    const label = `[Profile Vault ${BUILD_ID}] applicant sections — found ${scan.resolved.length}, missing ${scan.missing.join(", ") || "none"}`;
    if (missingExperience || scan.missing.length) console.warn(label, scan);
    else console.info(label, scan);

    // When the section that matters produced nothing, print the DOM it was read
    // out of. A block count of 0 with a heading that was found is precisely the
    // case where the next question is "what was in that root?" — so answer it
    // here instead of asking for another round of guessing.
    for (const key of ["experience", "education"]) {
      if (diagnostics?.totals?.[key]) continue;
      const section = scan.resolved.find((entry) => entry.key === key);
      if (!section) {
        console.warn(`[Profile Vault] ${key}: no section resolved. Headings seen:`, scan.headings);
        continue;
      }
      console.warn(
        `[Profile Vault] ${key}: section resolved but produced no entries — the markup it was read from:`,
        { foundIn: section.foundIn, root: section.root, blocks: section.blocks, text: section.sample, html: section.html }
      );
    }
  }

  /**
   * What happened to this applicant's resume, in one line on the hiring page.
   *
   * The same discipline `logSectionScan` was written under in 3.7.6, for the
   * same reason: "the resume is not in the folder" is not a diagnosable report,
   * and the diagnostics blob is not something a recruiter opens. This says
   * whether a control was found, whether anything was clicked, where the address
   * came from, whether the file landed and — if not — why, so the next failure
   * is answerable from the console instead of from another round of guessing.
   */
  /**
   * A signed media address is a credential. Log where it pointed, never the URL.
   *
   * `media.licdn.com/dms/document/…` carries an expiring signature, so printing
   * one into a console the recruiter may screenshot or paste into an issue hands
   * that document to whoever reads it. Host plus the first two path segments is
   * enough to tell a document from an image, which is the whole diagnostic value.
   */
  function safeHost(url) {
    try {
      const parsed = new URL(String(url || ""));
      const segments = parsed.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
      return segments ? `${parsed.host}/${segments}/…` : parsed.host;
    } catch {
      return "(unreadable address)";
    }
  }

  function logResume(diagnostics, name) {
    const resume = diagnostics?.resume;
    if (!resume) return;
    const label = `[Profile Vault ${BUILD_ID}] resume — ${name || "applicant"}: ${resume.status}`;
    const detail = {
      controlFound: resume.found,
      foundWithoutOpening: resume.foundWithoutOpening,
      clicked: resume.clicked,
      openedViewer: resume.openedViewer,
      viewerClosed: resume.viewerClosed,
      addressFrom: resume.foundWithoutOpening ? "page" : resume.foundInRequests ? "viewer-request" : "viewer-markup",
      // Which control was pressed and what the address turned out to be. The two
      // facts that answer "why is there a preview and no file" directly: a
      // viewer with no Download control, and an address that answered with a
      // descriptor rather than a document.
      downloadControl: resume.downloadControl || "none",
      downloadClicked: Boolean(resume.downloadClicked),
      // Download controls the PANEL offers, found without pressing anything. A
      // non-empty list here means the viewer open is removable for this account:
      // there is a control LinkedIn already shows that would fetch the file.
      panelDownloadLabels: resume.panelDownloadLabels || [],
      descriptor: resume.descriptor || "not-checked",
      refetchedFromPage: Boolean(resume.refetchedFromPage),
      savedAs: resume.savedAs || "",
      reason: resume.reason
    };
    const landed = resume.status === Applicants.RESUME_STATUS.DOWNLOADED
      || resume.status === Applicants.RESUME_STATUS.ALREADY_SAVED;
    if (resume.found && !landed) console.warn(label, detail);
    else console.info(label, detail);
  }

  /** Visible entity blocks inside a section, or [] when the markup has none. */
  function blocksIn(section) {
    if (!section?.element) return [];
    // A section resolved as a range of siblings carries the LIVE nodes; the
    // wrapper holding them is detached and has none of its own.
    const range = section.element.__pvSectionNodes;
    if (Array.isArray(range) && range.length) {
      const items = range.flatMap((node) => [...node.querySelectorAll("li,[role='listitem']")]).filter(isVisible);
      if (items.length) return items.filter((item) => !items.some((other) => other !== item && other.contains(item)));
      return range.filter((node) => isVisible(node) && cleanText(node.innerText || ""));
    }
    const items = [...section.element.querySelectorAll("li,[role='listitem']")].filter(isVisible);
    if (items.length) {
      // Only the outermost of any nested pair, so one card is not read twice.
      return items.filter((item) => !items.some((other) => other !== item && other.contains(item)));
    }
    const children = [...section.element.children].filter(
      (child) => child instanceof Element && isVisible(child) && cleanText(child.innerText || "")
    );
    return children.length > 1 ? children : [];
  }

  /** The category heading in force at this element, for the qualifications card. */
  function categoryBefore(element, section) {
    let category = "";
    for (const heading of headingsIn(section.element)) {
      if (!(heading.element.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const found = Applicants.qualificationCategoryOf(heading.text);
      if (found) category = found;
    }
    if (category) return category;
    // Some layouts render "Must-have" as plain text rather than a heading.
    for (const line of toLines(section.element.innerText || "")) {
      const found = Applicants.qualificationCategoryOf(line);
      if (found && cleanText(element.innerText || "").includes(line)) return found;
    }
    return "";
  }

  // ------------------------------------------------------------- the readers
  // One function per part of the record, as the request asked. Every one of them
  // is wrapped by `attempt()` at the call site, so a section that throws is
  // recorded as a warning and the rest of the extraction still completes.

  function attempt(label, accumulator, run) {
    try {
      return run();
    } catch (error) {
      if (error?.hidden || error?.stopped) throw error;
      accumulator.addWarning(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function readJob(accumulator) {
    // The job header sits above both columns, so it is read from the document
    // rather than from the applicant panel.
    const header = [...document.querySelectorAll("header,[class*='topcard'],[class*='job-title'],h1")]
      .filter((element) => isVisible(element) && !isExcludedContext(element))
      .map((element) => cleanText(element.innerText || ""))
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)
      .slice(0, 4)
      .join("\n");
    const job = Applicants.parseJobHeader({ text: header, title: document.title, url: location.href });

    // The description lives on the job-details view rather than the applicants
    // view, so it is read when it happens to be rendered and left null when it
    // is not. A description is never assembled out of the applicant panel.
    const descriptionHeading = [...document.querySelectorAll("h1,h2,h3,[role='heading']")]
      .find((element) => isVisible(element) && /^(?:job description|about the job|description)$/i.test(cleanText(element.innerText || "")));
    if (descriptionHeading) {
      const container = descriptionHeading.parentElement;
      const text = cleanText(container?.innerText || "").replace(/^[^\n]*\n/, "");
      if (text) job.description = text.slice(0, 20000);
    }

    accumulator.addJob(job);
    accumulator.addRaw("job", header);
    return job;
  }

  /**
   * The list row for the applicant currently being shown.
   *
   * The address bar carries `applicationId`, and each row links to its own —
   * so the row is matched on that id rather than on which one happens to look
   * highlighted. The selection attributes are the fallback for a layout that
   * routes without changing the query string.
   */
  function selectedApplicantRow() {
    const rows = applicantRows();
    if (!rows.length) return null;
    const { applicationId } = Applicants.parseHiringContext(location.href);
    if (applicationId) {
      const matched = rows.find((row) => row.href.includes(applicationId));
      if (matched) return matched;
    }
    return rows.find((row) =>
      row.element.matches?.("[aria-current='true'],[aria-current='page'],[aria-selected='true'],[class*='selected'],[class*='active']")
      || row.element.querySelector?.("[aria-current='true'],[aria-selected='true']")
    ) || null;
  }

  /**
   * The applicant's name.
   *
   * Every claim to it, in order of how much the markup can be trusted, and then
   * the platform's own prose as the arbiter. The live defect was that there was
   * no such policy at all: the first line of the panel's text was taken as the
   * name, and when the panel resolved to a container that also held the list,
   * that line was the word "Applicants" — on every record.
   */
  function findApplicantName(panel, accumulator) {
    const candidates = [];
    const push = (value, source) => {
      if (cleanText(value)) candidates.push({ value, source });
    };

    // 1. The list row for this application. It is the applicant's own row and
    //    carries their name as its first line.
    push(selectedApplicantRow()?.name, "list-row");

    // 2. The link to their profile, and the portrait's alt text.
    for (const anchor of panel.querySelectorAll("a[href*='/in/']")) {
      if (!isVisible(anchor)) continue;
      push(cleanText(anchor.innerText || anchor.getAttribute("aria-label")), "profile-link");
    }
    for (const image of panel.querySelectorAll("img[alt]")) {
      if (!isVisible(image)) continue;
      push(cleanText(image.getAttribute("alt")).replace(/^(?:photo of|picture of)\s+/i, ""), "portrait-alt");
    }

    // 3. Headings inside the panel that name no section.
    for (const heading of headingsIn(panel)) {
      if (heading.key) continue;
      push(heading.text, "panel-heading");
    }

    // 4. The first line of the panel, last — it is what used to be trusted first.
    push(toLines(panel.innerText || "")[0], "first-line");

    // The arbiter: LinkedIn writes every qualification verdict as a sentence
    // about the applicant, so the words those sentences share at the front are
    // the name, stated by the platform itself.
    const explanations = accumulator.snapshot().qualifications
      .map((entry) => entry.explanation)
      .filter(Boolean);
    return Applicants.chooseApplicantName(candidates, Applicants.nameFromExplanations(explanations));
  }

  function readApplicantHeader(panel, sections, accumulator, diagnostics = {}) {
    // The header is everything above the first recognised section heading.
    const first = Object.values(sections)[0]?.element || null;
    const lines = [];
    for (const line of toLines(panel.innerText || "")) {
      if (first && cleanText(first.innerText || "").startsWith(line)) break;
      lines.push(line);
      if (lines.length >= 12) break;
    }
    const header = Applicants.parseApplicantHeader({ text: lines.join("\n") });

    // The name is chosen by policy, not taken from wherever it happened to be,
    // and it is the one header field the accumulator will let a later, better
    // read replace.
    const chosen = findApplicantName(panel, accumulator);
    accumulator.addName(chosen.name || header.name, chosen.corroborated);
    delete header.name;
    diagnostics.name = chosen;

    // The profile link is the applicant's own /in/ address, taken from the panel
    // rather than guessed from their name.
    const profileAnchor = [...panel.querySelectorAll("a[href*='/in/']")].find((anchor) => isVisible(anchor));
    if (profileAnchor) header.profileUrl = Core.canonicalizeProfileUrl(profileAnchor.href || profileAnchor.getAttribute("href"));

    accumulator.addHeader(header);
    accumulator.addRaw("applicant_header", lines.join("\n"));
    return header;
  }

  /**
   * The qualification verdicts, exactly as displayed.
   *
   * Element-first so the verdict icon is available, with a text fallback that
   * groups lines into blocks by what a continuation line looks like: the
   * platform's explanation always either starts with the applicant's name, says
   * it could not evaluate the requirement, or starts with "Based on".
   */
  function readQualifications(sections, accumulator, applicantName = "") {
    const section = sections.qualifications;
    if (!section) return 0;
    accumulator.addRaw("qualifications", section.element.innerText || "");

    let added = 0;
    const blocks = blocksIn(section);
    for (const block of blocks) {
      const record = Applicants.parseQualificationBlock({
        lines: toLines(block.innerText || ""),
        category: categoryBefore(block, section),
        iconLabel: iconLabelIn(block)
      });
      if (record && accumulator.addQualification(record) === "added") added += 1;
    }
    if (added || blocks.length) return added;

    // Text fallback.
    let category = "";
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const record = Applicants.parseQualificationBlock({ lines: current, category });
      if (record && accumulator.addQualification(record) === "added") added += 1;
      current = [];
    };
    const continuation = /^based on\b|information cannot be|cannot be (?:provided|evaluated)/i;
    for (const line of toLines(section.element.innerText || "")) {
      const heading = Applicants.qualificationCategoryOf(line);
      if (heading) {
        flush();
        category = heading;
        continue;
      }
      const isContinuation = current.length
        && (continuation.test(line) || (applicantName && line.toLowerCase().startsWith(applicantName.toLowerCase())));
      if (isContinuation) current.push(line);
      else {
        flush();
        current.push(line);
      }
    }
    flush();
    return added;
  }

  function readScreeningResponses(sections, accumulator) {
    const section = sections.screening;
    if (!section) return 0;
    accumulator.addRaw("screening", section.element.innerText || "");

    let added = 0;
    const blocks = blocksIn(section);
    for (const block of blocks) {
      const record = Applicants.parseScreeningBlock({
        lines: toLines(block.innerText || ""),
        iconLabel: iconLabelIn(block)
      });
      if (record && accumulator.addScreening(record) === "added") added += 1;
    }
    if (added || blocks.length) return added;

    // Text fallback: a question line opens a block, everything after it until
    // the next question belongs to it.
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const record = Applicants.parseScreeningBlock({ lines: current });
      if (record && accumulator.addScreening(record) === "added") added += 1;
      current = [];
    };
    for (const line of toLines(section.element.innerText || "")) {
      if (/\?\s*$/.test(line)) {
        flush();
        current.push(line);
      } else if (current.length) current.push(line);
    }
    flush();
    return added;
  }

  function readExperience(sections, accumulator) {
    const section = sections.experience;
    if (!section) return 0;
    accumulator.addRaw("experience", section.element.innerText || "");

    let added = 0;
    let parsed = 0;
    const blocks = blocksIn(section);
    for (const block of blocks) {
      const record = Applicants.parseExperienceBlock(toLines(block.innerText || ""));
      if (!record) continue;
      parsed += 1;
      if (accumulator.addExperience(record) === "added") added += 1;
    }
    // The text fallback runs whenever the blocks produced **nothing**, not only
    // when the markup offered none. A section whose list items are chrome — a
    // media button, an empty virtualized placeholder — used to return 0 here and
    // never read the text that was plainly on screen, which is one of the ways
    // `current_role` came back empty on a row that clearly had a job. The
    // accumulator is keyed, so a card reached both ways is stored once.
    //
    // Gated on whether a RECORD was parsed, not on how many were newly added.
    // Every snapshot after the first re-parses the same blocks, which the keyed
    // accumulator answers "unchanged" — so `added` was 0 and the fallback ran
    // again over the whole section text, which on a root that also spans
    // Education manufactures experience entries out of the school names.
    if (parsed) return added;
    // title above them; anything else opens a new card.
    let current = [];
    const flush = () => {
      if (!current.length) return;
      const record = Applicants.parseExperienceBlock(current);
      if (record && accumulator.addExperience(record) === "added") added += 1;
      current = [];
    };
    const continuation = /[•·|]|\d{4}|\bpresent\b|\bverified\b/i;
    for (const line of toLines(section.element.innerText || "")) {
      if (current.length && continuation.test(line)) current.push(line);
      else {
        flush();
        current.push(line);
      }
    }
    flush();
    return added;
  }

  function readEducation(sections, accumulator) {
    const section = sections.education;
    if (!section) return 0;
    accumulator.addRaw("education", section.element.innerText || "");

    let added = 0;
    let parsed = 0;
    const blocks = blocksIn(section);
    for (const block of blocks) {
      const record = Applicants.parseEducationBlock(toLines(block.innerText || ""));
      if (!record) continue;
      parsed += 1;
      if (accumulator.addEducation(record) === "added") added += 1;
    }
    // Same rule as Experience: blocks that yielded nothing must not silence the
    // text the section is showing — and a re-read that parsed the same records
    // again is not "nothing", it is the same answer.
    if (parsed) return added;

    let current = [];
    const flush = () => {
      if (!current.length) return;
      const record = Applicants.parseEducationBlock(current);
      if (record && accumulator.addEducation(record) === "added") added += 1;
      current = [];
    };
    const continuation = /[•·|,]|\d{4}/;
    for (const line of toLines(section.element.innerText || "")) {
      if (current.length && continuation.test(line)) current.push(line);
      else {
        flush();
        current.push(line);
      }
    }
    flush();
    return added;
  }

  /**
   * Skills, from each pill's own heading rather than the container's text.
   *
   * The same defect the profile extractor had: reading the container's
   * `innerText` saves the endorse control and the surrounding sentence as
   * skills. `isSkillValue` from the profile core rejects counts, headings and
   * control labels, and `collapseRepeatedText` folds the accessibility duplicate.
   */
  function readSkills(sections, accumulator) {
    const section = sections.skills;
    if (!section) return 0;
    accumulator.addRaw("skills", section.element.innerText || "");

    let added = 0;
    const blocks = blocksIn(section);
    const values = blocks.length
      ? blocks.map((block) => {
          const heading = block.querySelector("h3,h4,[role='heading'],strong,a");
          return cleanText((heading || block).innerText || "");
        })
      : toLines(section.element.innerText || "");

    for (const value of values) {
      const collapsed = Core.collapseRepeatedText ? Core.collapseRepeatedText(value) : value;
      if (!collapsed || collapsed === section.heading) continue;
      if (Core.isSkillValue && !Core.isSkillValue(collapsed)) continue;
      if (accumulator.addSkill(collapsed) === "added") added += 1;
    }
    return added;
  }

  /**
   * Contact details LinkedIn already rendered, with the profile core's
   * provenance rules unchanged: a `mailto:`/`tel:` link, or a line under a
   * labelled Email/Phone field. Running text yields nothing.
   */
  function readRenderedContacts(panel, accumulator) {
    const links = [];
    for (const anchor of panel.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") || "";
      if (!href) continue;
      const direct = /^(?:mailto|tel):/i.test(href);
      if (!direct) {
        if (/^(?:javascript|data|blob|#)/i.test(href)) continue;
        const absolute = anchor.href || href;
        if (!/^https?:\/\//i.test(absolute)) continue;
        if (/^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\//i.test(absolute)) continue;
      }
      if (!isVisible(anchor)) continue;
      links.push({
        href: anchor.href || href,
        label: cleanText(anchor.getAttribute("aria-label") || anchor.textContent),
        context: direct ? "" : cleanText(anchor.closest("li,section")?.textContent || "").slice(0, 200)
      });
    }
    const panelText = cleanText(panel.innerText || "").slice(0, 20000);
    return accumulator.addContactPanel(Core.parseContactPanel({ text: panelText, links, allow: ["email"] }));
  }

  // ------------------------------------------------------------ gated clicks

  const OVERLAY = Core.CONTACT_OVERLAY;
  const LOADING_SELECTOR =
    "[class*='skeleton'],[class*='shimmer'],[class*='loader'],[role='progressbar'],[aria-busy='true']";

  function isLoading(element) {
    if (!element) return true;
    if (element.getAttribute("aria-busy") === "true") return true;
    return Boolean(element.querySelector(LOADING_SELECTOR));
  }

  /** Find one control inside `container` that the policy allows for `purpose`. */
  function findControl(container, purpose, { selector = "button,a,[role='button'],[role='menuitem']" } = {}) {
    if (!container) return null;
    for (const element of container.querySelectorAll(selector)) {
      const verdict = Applicants.classifyApplicantControl({
        text: cleanText(element.textContent),
        ariaLabel: cleanText(element.getAttribute("aria-label")),
        purpose,
        // Proven, not assumed: the element was enumerated from inside the
        // container it has to belong to.
        inContainer: container.contains(element)
      });
      if (!verdict.allowed) continue;
      if (!isVisible(element)) continue;
      return { element, verdict };
    }
    return null;
  }

  /**
   * Does the applicant PANEL carry a Download control of its own? Observation
   * only — nothing here is ever pressed.
   *
   * WHY THIS EXISTS. The request is "download the resume without opening it".
   * That already happens whenever the page renders the document's address, but
   * when the resume control carries only a route the address does not exist
   * anywhere until LinkedIn's viewer resolves it, so the viewer is opened as the
   * last resort. The one honest way to remove that open is to press a Download
   * control LinkedIn *already shows on the panel* — and this repo has never
   * looked for one, because rule 9i has only ever searched inside the viewer.
   * Whether such a control exists is a live-DOM question no fixture can answer
   * (rule 17), so it is measured before anything is amended.
   *
   * `inContainer: false` is deliberate and is what makes this safe: the verdict
   * can never come back `allowed`, so no code path can be tempted to press what
   * this finds. A label that cleared the denylist and matched the download
   * allowlist surfaces as `outside-resume-viewer`, which is exactly the signal —
   * "there is a Download here, and only the container proof is refusing it".
   */
  function probePanelDownloadControls(panel) {
    if (!panel) return [];
    const seen = new Set();
    for (const element of panel.querySelectorAll("button,a,[role='button'],[role='menuitem']")) {
      if (!isVisible(element)) continue;
      const verdict = Applicants.classifyApplicantControl({
        text: cleanText(element.textContent),
        ariaLabel: cleanText(element.getAttribute("aria-label")),
        purpose: Applicants.CONTROL_PURPOSE.RESUME_DOWNLOAD,
        inContainer: false
      });
      // Only the container proof refused it, so the label itself qualified.
      if (verdict.reason !== "outside-resume-viewer") continue;
      if (verdict.label) seen.add(verdict.label);
    }
    return [...seen];
  }

  /** Everything a dismiss control is ever marked up as — not `button` alone. */
  const DISMISS_SELECTOR = "button,a,[role='button'],[aria-label]";

  function isDismissControl(element) {
    return Boolean(Connections?.CONTACT_DISMISS_PATTERN?.test(
      `${cleanText(element.getAttribute?.("aria-label"))} ${cleanText(element.innerText)}`
    ));
  }

  /**
   * The one dismiss that closes whichever overlay this file opened.
   *
   * **A viewer left on screen is the whole "it previews instead of downloading"
   * complaint**, so this is written to actually verify it closed rather than to
   * try once and hope. Three things were wrong with trying once:
   *
   * - The Escape it dispatches is synthetic (`isTrusted: false`). Plenty of
   *   overlays listen for it and plenty ignore it; it is worth trying and worth
   *   nothing on its own.
   * - The fallback only looked at `button` elements **inside** the overlay.
   *   LinkedIn's document viewer routinely renders its close control as an `<a>`
   *   or a `[role="button"]`, and often mounts it in the modal *chrome* rather
   *   than inside the element `findResumeViewer()` matched — so there was
   *   nothing to find and the preview stayed up.
   * - The boolean it returns was discarded at every call site, so a viewer that
   *   ignored both was left open silently.
   *
   * It is bounded, and it never counts as one of rule 9's opens: a dismiss is
   * the shared close, not a new control.
   */
  async function closeOpenedOverlay(overlay) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!overlay || !document.contains(overlay) || !isVisible(overlay)) return true;
      for (const key of ["Escape", "Esc"]) {
        for (const target of [overlay, document]) {
          try {
            target.dispatchEvent(new KeyboardEvent("keydown", { key, code: "Escape", keyCode: 27, bubbles: true }));
          } catch {
            // A detached node cannot be dismissed, which is the same as closed.
          }
        }
      }
      await wait(250);
      if (!document.contains(overlay) || !isVisible(overlay)) return true;

      // Inside the overlay first, then its own modal wrapper — the close button
      // of an artdeco modal lives beside the content, not within it.
      const scopes = [overlay];
      const wrapper = overlay.closest?.("[role='dialog'],[aria-modal='true'],dialog,.artdeco-modal-overlay,.artdeco-modal");
      if (wrapper && wrapper !== overlay) scopes.push(wrapper);
      let dismissed = false;
      for (const scope of scopes) {
        for (const element of scope.querySelectorAll(DISMISS_SELECTOR)) {
          if (!isDismissControl(element) || !isVisible(element)) continue;
          try {
            element.click();
            dismissed = true;
          } catch {
            continue;
          }
          await wait(250);
          break;
        }
        if (dismissed) break;
      }
      if (!dismissed) break;
    }
    return !document.contains(overlay) || !isVisible(overlay);
  }

  /** The disclosure LinkedIn mounted after the contact control was clicked. */
  function findContactDisclosure(panel) {
    const candidates = [
      ...document.querySelectorAll("[role='dialog'],[aria-modal='true'],dialog[open],.artdeco-modal,[role='menu'],[class*='dropdown__content'],[class*='contact']")
    ];
    for (const element of candidates) {
      if (!isVisible(element)) continue;
      // Its own text has to look like contact details, or it is some other menu.
      const text = cleanText(element.innerText || "");
      if (!text) continue;
      if (Core.EMAIL_PATTERN?.test(text)) return element;
      if (element.querySelector("a[href^='mailto:'],a[href^='tel:']")) return element;
      if (/contact info|email|phone|mobile/i.test(text) && element !== panel) return element;
    }
    return null;
  }

  /**
   * Open the applicant's contact disclosure, read it, and close it again.
   *
   * Run after the panel scan has settled, for the same reason the profile
   * extractor runs its overlay last: a modal opened mid-scan stops the lazy walk
   * dead. Once per applicant, **always** — the email and the phone number live
   * together behind this one control.
   */
  async function openContactAndCollect(panel, accumulator, diagnostics) {
    diagnostics.contact = {
      clicked: false, opened: false, reason: "", added: 0,
      waitedToOpenMs: 0, waitedToLoadMs: 0, reads: 0, loadedFully: false
    };

    // Opened on every applicant, unconditionally. The recruiter screen puts the
    // email and the phone number together behind this one control, so skipping
    // it because the panel already showed an address is exactly how the number
    // goes missing. The accumulator is merge-only: opening it when something was
    // already found can only ever add.
    assertRunnable();

    const control = findControl(panel, Applicants.CONTROL_PURPOSE.CONTACT);
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

    // 1. Wait for the disclosure to mount. It is fetched, so it appears a beat
    //    after the click, and on a throttled tab that beat is seconds.
    const started = Date.now();
    const overlay = await waitFor(() => findContactDisclosure(panel), {
      timeoutMs: OVERLAY.OPEN_TIMEOUT_MS,
      pollMs: OVERLAY.POLL_MS,
      label: "contact-disclosure"
    });
    diagnostics.contact.waitedToOpenMs = Date.now() - started;
    if (!overlay) {
      diagnostics.contact.reason = "disclosure-did-not-open";
      return 0;
    }
    diagnostics.contact.opened = true;

    // 2. Let it finish loading, re-reading on every poll. The accumulator is
    //    merge-only, so a half-loaded read can only ever add.
    let live = overlay;
    let added = 0;
    let step = Core.createContactOverlayState();
    while (!step.done) {
      assertRunnable();
      const found = findContactDisclosure(panel);
      if (found) live = found;
      const present = document.contains(live);
      let carriesValue = false;
      let signature = "";
      if (present) {
        const text = cleanText(live.innerText || "");
        const links = [...live.querySelectorAll("a[href]")].map((anchor) => ({
          href: anchor.href || anchor.getAttribute("href") || "",
          label: cleanText(anchor.getAttribute("aria-label") || anchor.textContent),
          context: ""
        }));
        // This is the element we opened on purpose, on this applicant, so the
        // labelled-provenance rule is lifted for it: every address and every
        // number this disclosure shows belongs to them, and both are taken.
        const parsed = Core.parseContactPanel({ text, links, trusted: true });
        added += accumulator.addContactPanel(parsed);
        carriesValue = Boolean(parsed.emails.length || parsed.phones.length || parsed.websites.length);
        signature = [text.length, parsed.emails.length, parsed.phones.length, parsed.websites.length].join("|");
      }

      step = Core.nextContactOverlayStep(step, {
        waitedMs: diagnostics.contact.waitedToLoadMs,
        present,
        visible: isPageVisible(),
        loading: present ? isLoading(live) : true,
        carriesValue,
        signature
      });
      diagnostics.contact.reads = step.reads;
      if (step.done) break;
      await wait(OVERLAY.POLL_MS);
      diagnostics.contact.waitedToLoadMs += OVERLAY.POLL_MS;
    }

    diagnostics.contact.added = added;
    diagnostics.contact.loadedFully = step.settled;
    diagnostics.contact.reason = added ? "collected" : step.settled ? "disclosure-had-nothing" : `never-settled:${step.reason}`;
    diagnostics.contact.closed = await closeOpenedOverlay(live);
    return added;
  }

  /**
   * Expand whatever the panel has collapsed.
   *
   * Capped, and each expansion has to reveal something: a "Show more" that keeps
   * revealing nothing is retired rather than clicked again, the same bound the
   * connections pagination has. Every candidate is proven inside the panel.
   */
  const MAX_EXPANSIONS = 8;

  /** One budget for the whole extraction, shared by every expansion pass. */
  function createExpansionBudget() {
    return { clicked: new WeakSet(), used: 0 };
  }

  /**
   * @param {Element} panel
   * @param {object} diagnostics
   * @param {{clicked: WeakSet, used: number}} budget shared across passes, so
   *   running this again after the walk costs the same eight clicks in total.
   */
  async function expandCollapsedSections(panel, diagnostics, budget) {
    diagnostics.expansions = diagnostics.expansions || { clicked: 0, revealed: 0, refused: 0, passes: 0 };
    diagnostics.expansions.passes += 1;
    const clicked = budget.clicked;
    for (; budget.used < MAX_EXPANSIONS; ) {
      assertRunnable();
      const control = (() => {
        for (const element of panel.querySelectorAll("button,a,[role='button']")) {
          if (clicked.has(element)) continue;
          const verdict = Applicants.classifyApplicantControl({
            text: cleanText(element.textContent),
            ariaLabel: cleanText(element.getAttribute("aria-label")),
            purpose: Applicants.CONTROL_PURPOSE.DISCLOSURE,
            inContainer: panel.contains(element)
          });
          if (verdict.forbidden) diagnostics.expansions.refused += 1;
          if (!verdict.allowed || !isVisible(element)) continue;
          return { element, verdict };
        }
        return null;
      })();
      if (!control) break;

      clicked.add(control.element);
      budget.used += 1;
      const before = cleanText(panel.innerText || "").length;
      try {
        control.element.click();
        diagnostics.expansions.clicked += 1;
      } catch {
        continue;
      }
      await waitForDomQuiet(280, 2000);
      if (cleanText(panel.innerText || "").length > before) diagnostics.expansions.revealed += 1;
    }
  }

  // ---------------------------------------------------------------- resume
  // The applicant's own attachment. The viewer is **opened** rather than merely
  // linked: the control's href is often a route, not the document, and the
  // viewer is where the real file name, the file type and the page count are
  // actually shown. So the control is clicked, the viewer is waited for and
  // scrolled to the bottom so every page renders, its details are read, and only
  // then is the document URL handed to the service worker to save — a content
  // script has no `chrome.downloads`.

  const DOCUMENT_EXTENSION_PATTERN = /\.(pdf|docx?|odt|rtf|txt|pages)(?:$|[?#])/i;

  /** Chrome inside the viewer that is never part of the file's own details. */
  const VIEWER_NOISE_PATTERN =
    /^(?:resume|cv|curriculum vitae|download|print|close|dismiss|back|share|zoom|next|previous|page)\b/i;

  function resumeUrlFrom(value) {
    const raw = cleanText(value);
    if (!raw || /^(?:javascript|#)/i.test(raw)) return "";
    const url = Core.unwrapRedirectUrl ? Core.unwrapRedirectUrl(raw) : raw;
    return /^https?:\/\//i.test(url) ? url : "";
  }

  function fileNameFrom(url) {
    try {
      const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
      return DOCUMENT_EXTENSION_PATTERN.test(name) ? name : "";
    } catch {
      return "";
    }
  }

  function fileTypeFrom(url, filename) {
    const match = DOCUMENT_EXTENSION_PATTERN.exec(filename || "") || DOCUMENT_EXTENSION_PATTERN.exec(url || "");
    return match ? match[1].toLowerCase() : "";
  }

  /** Attributes a rendered document address is actually written into. */
  const DOCUMENT_URL_ATTRIBUTES = ["src", "data", "href", "data-src", "data-source-url", "data-delayed-url", "content"];
  const DOCUMENT_URL_SELECTOR = [
    "iframe[src]", "embed[src]", "object[data]", "a[download][href]", "a[href]",
    "[data-src]", "[data-source-url]", "[data-delayed-url]", "meta[content]"
  ].join(",");

  /**
   * The resume FILE's address, wherever on the page it was rendered.
   *
   * Widened in 3.7.4. It used to look only at four tag shapes and decide with a
   * local extension regex, so a viewer that hands its document to a plugin
   * through `data-source-url`, or serves it from a media host with no extension
   * in the path, produced nothing — and every applicant came back `link_only`
   * with no file and no link.
   *
   * Two things keep the widening honest. It reads only attributes the page
   * itself rendered — nothing is constructed or guessed — and the decision is
   * `Applicants.isResumeDocumentUrl()`, the same tested rule the record uses,
   * which refuses a `linkedin.com` page address **first**. So a wider search
   * still cannot return a route, which was the 3.7.1 defect.
   *
   * Searched nearest-first: the opened viewer, then the panel, then the page.
   */
  function findResumeDocumentUrl(scope) {
    const roots = [];
    for (const root of [scope, applicantPanel(), document]) {
      if (root && !roots.includes(root)) roots.push(root);
    }
    for (const root of roots) {
      for (const element of root.querySelectorAll?.(DOCUMENT_URL_SELECTOR) || []) {
        for (const attribute of DOCUMENT_URL_ATTRIBUTES) {
          const url = resumeUrlFrom(element.getAttribute?.(attribute));
          if (url && Applicants.isResumeDocumentUrl(url)) return url;
        }
      }
    }
    return "";
  }

  /**
   * The document address THIS applicant's viewer actually fetched.
   *
   * The gap this closes, and it is the reason a viewer could open and no file
   * ever arrive: LinkedIn's document viewer does not always put the file's
   * address in an attribute. It fetches the bytes in JavaScript and paints them
   * into a `<canvas>`, or hands them to a plugin through a `blob:` URL — and
   * `resumeUrlFrom` refuses a `blob:`, correctly, because it is not an address
   * the service worker could ever fetch. The attribute sweep then finds nothing,
   * the applicant comes back `link_only`, and the recruiter is left looking at a
   * preview of a file that was never saved.
   *
   * `performance.getEntriesByType("resource")` is the browser's own record of
   * every URL this document requested. That keeps the widening inside the rule
   * the rest of this file follows — it is an **observation of what the page
   * did**, not a constructed or guessed address — and the decision is still
   * `Applicants.isResumeDocumentUrl()`, the same tested rule the record uses,
   * which refuses a linkedin.com page address first. So this can no more return
   * a route than the attribute sweep can.
   *
   * **`since` is not optional and is the whole safety of this.** The entry
   * buffer belongs to the DOCUMENT, and a run walks hundreds of applicants
   * through one of them without ever navigating. Consulted unbounded, the first
   * applicant's resume would be returned for the second, and the recruiter would
   * get one person's CV saved under another person's name — which is worse than
   * no file at all (rule 6). So it is only ever asked about requests made after
   * this applicant's own viewer was opened, and only ever from inside that
   * branch. Newest first, because the viewer fetches the document last.
   */
  function fetchedResumeDocumentUrl(since) {
    if (!Number.isFinite(since)) return "";
    let entries = [];
    try {
      entries = performance.getEntriesByType("resource") || [];
    } catch {
      return "";
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry || !(entry.startTime >= since)) continue;
      const url = resumeUrlFrom(entry.name);
      if (url && Applicants.isResumeDocumentUrl(url)) return url;
    }
    return "";
  }

  /** The viewer LinkedIn mounted after the resume control was clicked. */
  function findResumeViewer() {
    for (const element of document.querySelectorAll("[role='dialog'],[aria-modal='true'],dialog[open],.artdeco-modal,[class*='document-viewer'],[class*='resume']")) {
      if (!isVisible(element)) continue;
      if (element.querySelector("iframe[src],embed[src],object[data],canvas")) return element;
      const named = [
        element.getAttribute("aria-label") || "",
        (element.getAttribute("aria-labelledby") || "").replace(/[-_]/g, " "),
        cleanText(element.innerText || "").slice(0, 200)
      ].join(" ");
      if (Applicants.RESUME_CONTROL_PATTERN.test(named)) return element;
    }
    return null;
  }

  /**
   * What the opened viewer says about the file.
   *
   * The file name shown in the viewer's own chrome beats one derived from the
   * URL — LinkedIn's document URLs are opaque media ids, so the URL usually has
   * no name in it at all, and the viewer header is the only place the
   * applicant's actual file name appears. Nothing here is guessed: a viewer that
   * shows no name yields none.
   */
  function readResumeViewerDetails(viewer) {
    const details = { filename: "", fileType: "", pages: null, text: "" };
    if (!viewer) return details;

    const lines = toLines(viewer.innerText || "");
    details.text = lines.join("\n").slice(0, 4000);

    for (const line of lines) {
      if (!details.filename && DOCUMENT_EXTENSION_PATTERN.test(line) && !VIEWER_NOISE_PATTERN.test(line)) {
        // The file name is the part of the line that carries the extension.
        const match = /([^\s/\\|·•]+\.(?:pdf|docx?|odt|rtf|txt|pages))\b/i.exec(line);
        if (match) details.filename = match[1];
      }
      const pages = /\b(?:page\s+\d+\s+of\s+|1\s*\/\s*)(\d+)\b/i.exec(line) || /\b(\d+)\s+pages?\b/i.exec(line);
      if (pages && details.pages === null) details.pages = Number(pages[1]) || null;
    }

    // A download control inside the viewer often carries the real name.
    for (const anchor of viewer.querySelectorAll("a[download],a[href]")) {
      const named = cleanText(anchor.getAttribute("download") || "");
      if (named && DOCUMENT_EXTENSION_PATTERN.test(named)) {
        details.filename = named;
        break;
      }
    }

    details.fileType = fileTypeFrom("", details.filename);
    return details;
  }

  /**
   * Scroll the opened viewer to the bottom so every page renders.
   *
   * A PDF viewer renders pages lazily exactly as the profile does, so a viewer
   * read on the frame it mounted shows page one and nothing else. This is the
   * same walk the panel scan performs, bounded harder because a viewer is not
   * where the record's fields come from — it is only asked for the file's own
   * details.
   */
  // Resume collection must never hold the applicant queue for tens of seconds.
  // The link is the durable evidence; file metadata is best-effort.
  const RESUME_VIEWER_TIMEOUT_MS = 4500;
  const RESUME_DOCUMENT_TIMEOUT_MS = 4500;
  const RESUME_MESSAGE_TIMEOUT_MS = 8000;

  function sendRuntimeMessageWithTimeout(message, timeoutMs = RESUME_MESSAGE_TIMEOUT_MS) {
    return Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => setTimeout(() => reject(new Error("resume-download-timeout")), timeoutMs))
    ]);
  }

  async function scrollResumeViewer(viewer) {
    if (!viewer) return 0;
    const target = chooseScrollTarget(viewer);
    if (!target?.element) return 0;
    const startY = currentScrollTop(target);
    let steps = 0;
    try {
      for (; steps < 3; steps += 1) {
        assertRunnable();
        const max = maxScrollPosition(target);
        const position = currentScrollTop(target);
        if (position >= max - 8) break;
        scrollPanelTo(position + Math.max(400, target.clientHeight * 0.8), target);
        await waitForDomQuiet(120, 500);
      }
    } finally {
      // Handed back where it was, on the failure path as well.
      scrollPanelTo(startY, target);
    }
    return steps;
  }

  /**
   * Locate, record and — when permitted — save the applicant's resume.
   *
   * Nothing here decides whether the recruiter is *allowed* the resume: if the
   * account cannot see it, LinkedIn renders no control and this records
   * `available: false` with `downloadStatus: "unavailable"`. There is no attempt
   * to reach a document the page did not offer.
   *
   * **The viewer is a fallback, not the method** (3.7.7). The point of the step
   * is the *file*, so the document address is looked for on the page **before
   * anything is clicked** — the control's own `href`, then every rendered
   * document attribute across the panel and the page. When that finds it the
   * resume is downloaded straight to disk and no viewer is ever opened, which is
   * both what was asked for and what rule 9e says: a link needs no click at all.
   * Only when the page has not rendered the address is the viewer opened, and it
   * is opened because that is the only place LinkedIn puts it — and it is closed
   * again immediately.
   */
  /**
   * Close the viewer this step opened, and say so if it would not close.
   *
   * The result used to be discarded at every call site, so "the preview is still
   * on screen" was a thing the extension could do without ever mentioning it.
   * Now a viewer that refuses to go is a warning on the record and a line in the
   * diagnostics, which is what makes the next report actionable.
   */
  async function dismissResumeViewer(overlay, accumulator, diagnostics) {
    if (!overlay) return true;
    const closed = await closeOpenedOverlay(overlay);
    diagnostics.resume.viewerClosed = closed;
    if (!closed) {
      accumulator.addWarning("the resume viewer would not close; the preview may still be on screen");
    }
    return closed;
  }

  /** Well above any real CV, well below anything worth sending through a message. */
  const MAX_RESUME_BYTES = 25 * 1024 * 1024;

  /**
   * Fetch the document from the page that rendered it, as bytes.
   *
   * Only ever the second attempt, and only for an address the page itself
   * offered. It runs in the LinkedIn tab, so the request carries that tab's
   * credentials and referrer — the two things a worker-initiated download cannot
   * reproduce and the usual reason a signed media address refuses it.
   *
   * Bounded on purpose: a response that is HTML is refused outright rather than
   * written to disk as somebody's CV (that exact defect is what `RESUME_PAGE_PATTERN`
   * exists for), and anything implausibly large is refused rather than turned
   * into a 33 %-larger base64 string and pushed through a message channel.
   */
  async function fetchResumeBytes(url) {
    try {
      const response = await fetch(url, { credentials: "include", redirect: "follow" });
      if (!response.ok) return { dataUrl: "", reason: `the document answered ${response.status}` };
      const type = String(response.headers.get("content-type") || "").toLowerCase();
      if (/^text\/html|^application\/xhtml/.test(type)) {
        return { dataUrl: "", reason: "the address returned a web page, not a document" };
      }
      const blob = await response.blob();
      if (!blob.size) return { dataUrl: "", reason: "the document was empty" };
      if (blob.size > MAX_RESUME_BYTES) return { dataUrl: "", reason: "the document is too large to save this way" };
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });
      return { dataUrl, reason: dataUrl ? "" : "the document could not be read" };
    } catch (error) {
      return { dataUrl: "", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Press the viewer's own Download control, once (rule 9i).
   *
   * THE REPORT: "I want the extension to click on resume, then click on
   * download, then download the profile and save that link." That is also the
   * only reliable fix for what was actually being saved — the address the viewer
   * fetches is a **descriptor**, not the file, and the JSON it answers with was
   * landing on disk under the applicant's name.
   *
   * Pressing the control LinkedIn provides makes the page resolve its own
   * descriptor with its own session and request the real file, which is both the
   * shortest path to the bytes and the shortest path to the FILE's address: the
   * request shows up in this document's own entry log, and `openedAt` — stamped
   * before the resume was opened — is what keeps it this applicant's.
   *
   * Gated like every other control: the denylist first, the label anchored
   * whole, and proven inside the viewer this extension opened itself.
   */
  async function clickResumeDownload(viewer, diagnostics) {
    diagnostics.resume.downloadControl = "none";
    diagnostics.resume.downloadClicked = false;
    if (!viewer) return false;

    const control = findControl(viewer, Applicants.CONTROL_PURPOSE.RESUME_DOWNLOAD);
    if (!control) return false;
    diagnostics.resume.downloadControl = control.verdict.label || "download";
    try {
      control.element.click();
      diagnostics.resume.downloadClicked = true;
    } catch (error) {
      diagnostics.resume.downloadControl = `click-failed:${error?.message || error}`;
      return false;
    }
    // The file is fetched over the network. Without this wait the request has
    // not been made yet when the entry log is read, and the click buys nothing.
    await waitForDomQuiet(150, 900);
    return true;
  }

  /**
   * Prove a candidate address is the DOCUMENT — or yield nothing at all.
   *
   * `isResumeDocumentUrl` decides what an address LOOKS like, and it cannot tell
   * a file from a descriptor, because both are `/dms/` paths on a LinkedIn host.
   * This asks the address what it actually answers with, from the tab that
   * rendered it, with that tab's own credentials.
   *
   * A JSON answer is a descriptor, and this is the one case where the return is
   * deliberately **empty rather than the input**: an address known to serve
   * metadata must never be handed on to be saved as somebody's CV (rule 6). A
   * failed check is not evidence of anything, so it returns the address
   * unchanged and leaves the worker's own refusals to do their job.
   */
  async function resolveResumeDocumentUrl(url, diagnostics) {
    diagnostics.resume.descriptor = "not-checked";
    if (!url) return "";
    let response;
    try {
      response = await fetch(url, { credentials: "include" });
    } catch (error) {
      // Said out loud rather than swallowed. This catch is where a **missing host
      // permission** lands: the media CDN is a different origin from
      // `linkedin.com`, so without `media.licdn.com` in `host_permissions` the
      // fetch is refused before it leaves the page and the only trace was a
      // `descriptor: "check-failed"` field nobody opens. The address is still
      // returned unchanged — a failed check is not evidence of anything, and the
      // worker's own refusals still apply — but the reason is now on the record
      // and in the console, because "every applicant came back check-failed" is
      // the one sentence that names this cause.
      diagnostics.resume.descriptor = "check-failed";
      diagnostics.resume.descriptorError = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Profile Vault ${BUILD_ID}] resume: could not read ${safeHost(url)} — ${diagnostics.resume.descriptorError}. `
        + "If this is every applicant, the media host is not in manifest host_permissions."
      );
      return url;
    }
    if (!response.ok) {
      diagnostics.resume.descriptor = `http-${response.status}`;
      return url;
    }
    if (!/json/i.test(String(response.headers.get("content-type") || ""))) {
      diagnostics.resume.descriptor = "document";
      return url;
    }

    const body = await response.text().catch(() => "");
    const document_ = Applicants.documentUrlFromDescriptor(body);
    diagnostics.resume.descriptor = document_ ? "resolved-from-descriptor" : "descriptor-named-no-document";
    return document_;
  }

  async function collectResume(panel, accumulator, diagnostics, applicantKey, applicantName = "") {
    diagnostics.resume = {
      found: false, clicked: false, opened: false, scrolledSteps: 0,
      openedViewer: false, viewerClosed: true, foundInRequests: false,
      reason: "", status: Applicants.RESUME_STATUS.NOT_ATTEMPTED
    };

    const control = findControl(panel, Applicants.CONTROL_PURPOSE.RESUME);
    if (!control) {
      accumulator.setResume({ available: false, downloadStatus: Applicants.RESUME_STATUS.UNAVAILABLE });
      diagnostics.resume.reason = "no-resume-control";
      diagnostics.resume.status = Applicants.RESUME_STATUS.UNAVAILABLE;
      return;
    }
    diagnostics.resume.found = true;

    // Whatever the control links to. On this surface it is almost always a
    // ROUTE — `linkedin.com/hiring/applicants/…` — rather than the document, so
    // it is kept as the viewer address and is never mistaken for the file.
    const controlHref = resumeUrlFrom(control.element.getAttribute?.("href"));
    const linkedUrl = Applicants.isResumeDocumentUrl(controlHref) ? controlHref : "";
    const viewerUrl = linkedUrl ? "" : controlHref;

    // Before any click: has the page already rendered the document address? A
    // link needs no click (rule 9e), and the recruiter asked for the file, not
    // for a preview. `isResumeDocumentUrl` still decides, so a route can never
    // be taken for a file here either.
    const rendered = linkedUrl || findResumeDocumentUrl(null);
    diagnostics.resume.foundWithoutOpening = Boolean(rendered);
    // Observation only, and only worth the DOM walk when the viewer is about to
    // be opened — that is the case a panel-level Download would remove.
    diagnostics.resume.panelDownloadLabels = rendered ? [] : probePanelDownloadControls(panel);

    let overlay = null;
    let details = { filename: "", fileType: "", pages: null, text: "" };
    let url = rendered;

    if (!url) {
      // The page did not render it, so the viewer is the only place it exists.
      // Opened, read, and closed — never left open, never a new tab.
      assertRunnable();
      // Stamped BEFORE the click so the request log can be read afterwards
      // without any chance of picking up the previous applicant's document.
      const openedAt = performance.now();
      try {
        control.element.click();
        diagnostics.resume.clicked = true;
      } catch (error) {
        accumulator.setResume({
          available: true,
          url: null,
          viewerUrl: viewerUrl || null,
          downloadStatus: Applicants.RESUME_STATUS.FAILED
        });
        diagnostics.resume.reason = `click-failed:${error?.message || error}`;
        diagnostics.resume.status = Applicants.RESUME_STATUS.FAILED;
        return;
      }

      // Wait on a condition, not a duration: either the viewer mounted or the
      // document URL appeared.
      const viewer = await waitFor(() => findResumeViewer() || (findResumeDocumentUrl(null) ? panel : null), {
        timeoutMs: RESUME_VIEWER_TIMEOUT_MS,
        pollMs: OVERLAY.POLL_MS,
        label: "resume-viewer"
      });
      overlay = findResumeViewer();
      diagnostics.resume.opened = Boolean(viewer);
      diagnostics.resume.openedViewer = Boolean(overlay);

      // Read the header immediately, then press Download immediately. A full PDF
      // walk used to hold each applicant for up to half a minute even though the
      // document link normally appears in the viewer shell or request log.
      details = readResumeViewerDetails(overlay);
      await clickResumeDownload(overlay, diagnostics);

      // Metadata below the fold is optional. Keep this walk shallow and bounded;
      // it must never delay saving the link or advancing the applicant queue.
      if (overlay && !details.filename) {
        diagnostics.resume.scrolledSteps = await scrollResumeViewer(overlay);
        const supplemental = readResumeViewerDetails(overlay);
        details = {
          filename: supplemental.filename || details.filename,
          fileType: supplemental.fileType || details.fileType,
          pages: supplemental.pages ?? details.pages,
          text: supplemental.text || details.text
        };
      }

      // Waited for properly rather than sampled once: the viewer mounts its shell
      // first and fetches the document after, so a three-second look at the frame
      // it appeared on is how every applicant came back `link_only` with no file.
      //
      // Two sources, in order of directness: what the viewer RENDERED, then what
      // it FETCHED. The second is what saves the canvas- and blob-based viewer,
      // where the file's address is never written into any attribute at all.
      url = await waitFor(
        () => findResumeDocumentUrl(overlay) || fetchedResumeDocumentUrl(openedAt),
        { timeoutMs: RESUME_DOCUMENT_TIMEOUT_MS, pollMs: OVERLAY.POLL_MS, label: "resume-document" }
      ) || "";
      diagnostics.resume.foundInRequests = Boolean(url) && !findResumeDocumentUrl(overlay);
      // The viewer may have mounted after the single sample above — a shell that
      // appears only once the document arrives is common. Re-resolved so there is
      // always something to close, because a preview left on screen is the very
      // complaint this step exists to answer.
      if (!overlay) overlay = findResumeViewer();
    }

    // However the address was found — rendered in an attribute, or observed in
    // this document's own request log — it is proven to be a file before
    // anything is written to disk under a person's name. An address that answers
    // with a descriptor resolves to the document it names, or to nothing.
    if (url) url = await resolveResumeDocumentUrl(url, diagnostics);
    diagnostics.resume.documentUrlFound = Boolean(url);

    if (!url) {
      // The viewer opened but never exposed a document URL. What it *said* is
      // still recorded — the file name is worth having even with no file — and
      // the route is stored as the viewer address, not as the CV. Reporting a
      // page route as the file is what made "Open resume" reopen the applicants
      // page and made the worker save an HTML page as somebody's resume.
      accumulator.setResume({
        available: true,
        filename: details.filename || null,
        fileType: details.fileType || null,
        pages: details.pages,
        viewerUrl: viewerUrl || location.href,
        downloadStatus: Applicants.RESUME_STATUS.LINK_ONLY
      });
      diagnostics.resume.reason = "no-document-url";
      diagnostics.resume.status = Applicants.RESUME_STATUS.LINK_ONLY;
      await dismissResumeViewer(overlay, accumulator, diagnostics);
      return;
    }

    // The viewer's own name wins; the URL is the fallback. Neither is guessed.
    const filename = details.filename || fileNameFrom(url);
    const fileType = details.fileType || fileTypeFrom(url, filename);

    // Save the verified link into the record BEFORE starting the download. If
    // Chrome refuses, times out, or the worker restarts, the applicant still has
    // a usable resume link and the queue can continue instead of losing the row.
    accumulator.setResume({
      available: true,
      url,
      viewerUrl: viewerUrl || null,
      filename: filename || null,
      fileType: fileType || null,
      pages: details.pages,
      localReference: null,
      downloadStatus: Applicants.RESUME_STATUS.LINK_ONLY
    });
    diagnostics.resume.linkSavedBeforeDownload = true;

    const key = `${applicantKey}|${url}`;

    // Duplicate prevention, twice over: this tab's own set, and the worker's
    // persisted check, which survives a service-worker restart.
    if (state.downloadedResumes.has(key)) {
      accumulator.setResume({
        available: true, url, viewerUrl: viewerUrl || null,
        filename: filename || null, fileType: fileType || null, pages: details.pages,
        // Where the earlier download of this exact file actually landed. Without
        // it, `resume_file` was empty for every applicant collected twice — the
        // file was on disk and the column said nothing.
        localReference: state.downloadedResumes.get(key) || null,
        downloadStatus: Applicants.RESUME_STATUS.ALREADY_SAVED
      });
      diagnostics.resume.reason = "already-downloaded";
      diagnostics.resume.status = Applicants.RESUME_STATUS.ALREADY_SAVED;
      await dismissResumeViewer(overlay, accumulator, diagnostics);
      return;
    }

    // The file type decides the extension the saved copy gets, and nothing here
    // guesses one: a `.pdf` on a file that is really a `.docx` is a lie written
    // to the recruiter's disk. An unknown type is said so and saved without one.
    if (!fileType) accumulator.addWarning("resume file type unknown; saved without an extension");

    const request = {
      // Start the browser download directly. Opening another tab made the hiring
      // page appear hidden and could stop the applicant run; the page-side fetch
      // below remains the authenticated fallback when the direct request fails.
      type: "PV_APPLICANT_DOWNLOAD_RESUME",
      url,
      // What LinkedIn called it, kept only as the fallback stem and as the
      // last source of an extension.
      filename,
      fileType,
      // What the file is actually saved as: the person. The worker sanitizes
      // it and settles the ` (2)` — this side never builds a path.
      applicantName,
      applicantKey
    };

    let result = null;
    try {
      result = await sendRuntimeMessageWithTimeout(request);
    } catch (error) {
      accumulator.addWarning(`resume download: ${error instanceof Error ? error.message : String(error)}`);
    }

    // The worker hands the bare address to `chrome.downloads`, which fetches it
    // with the browser's own cookie jar — the same request the recruiter would
    // make by clicking the link. When that comes back interrupted, the usual
    // reason is that LinkedIn served the document only to the page that asked
    // for it: a signed media address that has already expired, or one that needs
    // the referrer and credentials of the tab it was rendered in.
    //
    // So the second attempt is made from HERE, where those conditions hold, and
    // the bytes are handed to the worker to write — a content script still never
    // touches `chrome.downloads`. It is only ever a fallback: the direct path
    // costs no memory and is tried first, every time.
    if (result?.retryFromPage) {
      const fetched = await fetchResumeBytes(url);
      if (fetched.dataUrl) {
        try {
          result = await sendRuntimeMessageWithTimeout({ ...request, dataUrl: fetched.dataUrl, url });
        } catch (error) {
          accumulator.addWarning(`resume download: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (fetched.reason) {
        accumulator.addWarning(`resume download: ${fetched.reason}`);
      }
      diagnostics.resume.refetchedFromPage = Boolean(fetched.dataUrl);
    }

    const status = result?.status || Applicants.RESUME_STATUS.FAILED;
    if (status === Applicants.RESUME_STATUS.DOWNLOADED || status === Applicants.RESUME_STATUS.ALREADY_SAVED) {
      state.downloadedResumes.set(key, result?.localReference || "");
    }
    accumulator.setResume({
      available: true,
      url,
      viewerUrl: viewerUrl || null,
      // The saved copy's own name wins: `resume_file` is meant to say which file
      // on disk is this person's, and after a download that is the name the
      // recruiter will actually see in their downloads folder.
      filename: result?.filename || filename || null,
      fileType: fileType || null,
      pages: details.pages,
      localReference: result?.localReference || null,
      downloadStatus: status
    });
    diagnostics.resume.savedAs = result?.localReference || "";
    diagnostics.resume.reason = result?.reason || status;
    diagnostics.resume.status = status;
    // A download that did not land is said so on the record, not only in a
    // diagnostics field nobody opens.
    if (status === Applicants.RESUME_STATUS.FAILED) {
      accumulator.addWarning(`resume was not saved: ${result?.reason || "the download did not complete"}`);
    }
    await dismissResumeViewer(overlay, accumulator, diagnostics);
  }

  // ------------------------------------------------------------- the scan
  // Identical shape to the profile scan and driven by the same tested policy:
  // start at the top, step down the container that actually scrolls, collect on
  // every step, and finish only at the bottom after five consecutive reads that
  // reveal nothing new. Everything read goes into the merge-only accumulator.

  const SCAN_BUDGET_MS = 90000;

  function snapshotPanel(panel, accumulator, diagnostics) {
    const before = accumulator.counts();
    // Resolved once per snapshot and handed to every reader. Each of them used
    // to rebuild the whole map for itself — seven page-wide heading scans per
    // read, dozens of reads per applicant, and seven chances for two readers to
    // disagree about where a section was.
    const sections = buildSectionMap(panel);
    attempt("job", accumulator, () => readJob(accumulator));
    // Qualifications first, and deliberately: their explanation sentences are
    // what the name is corroborated against, so reading the header before them
    // would leave the very first snapshot with no arbiter at all.
    attempt("qualifications", accumulator, () => readQualifications(sections, accumulator, accumulator.snapshot().header.name || ""));
    const header = attempt("applicant header", accumulator, () => readApplicantHeader(panel, sections, accumulator, diagnostics));
    void header;
    attempt("screening responses", accumulator, () => readScreeningResponses(sections, accumulator));
    attempt("experience", accumulator, () => readExperience(sections, accumulator));
    attempt("education", accumulator, () => readEducation(sections, accumulator));
    attempt("skills", accumulator, () => readSkills(sections, accumulator));
    attempt("contacts", accumulator, () => readRenderedContacts(panel, accumulator));
    const after = accumulator.counts();
    diagnostics.totals = after;
    // Which sections this read could see at all. The cheap half of the section
    // scan — no extra DOM work — and the one that shows a section arriving late.
    diagnostics.sectionsFound = Object.keys(sections);
    diagnostics.snapshots = (diagnostics.snapshots || 0) + 1;
    return Object.keys(after).reduce((sum, key) => sum + (after[key] - before[key]), 0);
  }

  /**
   * The next thing to bring into view, and how far to go to reach it.
   *
   * THE DEFECT THIS FIXES. `revealPanelContent` only ever scrolled to the last
   * rendered element — the very bottom of whatever was rendered — so the
   * *first* pass jumped the whole way down and every pass after it had nowhere
   * left to go. Three passes ran, but the panel moved **once**. That is exactly
   * the report: "you are scrolling the profile side only once".
   *
   * Jumping is also the worst way to ask a lazy panel for its content. Sections
   * mount as their neighbourhood is approached, and a single jump from the top
   * to the tail asks for nothing in between: the browser lands at the bottom of
   * the *rendered* box, which is the bottom of the first screenful's worth of
   * markup, and the panel has no reason to build the rest.
   *
   * So a pass is a STEP: the first element that begins below the fold, aligned
   * to the top of the view, which advances roughly one screenful and leaves the
   * page to mount what that uncovers. Only when nothing begins below the fold
   * any more does it fall back to the tail — aligned to the *bottom*, because
   * confirming the end means actually reaching it.
   *
   * Deliberately measured with `getBoundingClientRect`, which is in viewport
   * coordinates and so is blind to WHICH container scrolls — the same reason
   * `scrollIntoView` is used here rather than a position walk. A step whose
   * container this code never identified still steps.
   */
  function nextRevealStep(root, stuck) {
    if (!(root instanceof Element)) return null;
    const fold = window.innerHeight || document.documentElement?.clientHeight || 0;
    let tail = null;
    for (const element of root.querySelectorAll("section,article,div,li,p,h1,h2,h3,h4")) {
      if (!isVisible(element) || !cleanText(element.innerText || "")) continue;
      // The tail is the last rendered element whatever else is true of it, so it
      // is recorded before any of the refusals below.
      tail = element;
      // An anchor a previous pass proved unmovable is not offered again. Without
      // this, an element `scrollIntoView` cannot shift stays the first box past
      // the fold forever and the walk re-picks it every pass.
      if (stuck?.has(element)) continue;
      // The first box that STARTS below the fold. Nested boxes that merely
      // extend past it are already partly on screen and are not a step forward.
      if (element.getBoundingClientRect().top > fold - 8) {
        // A fixed box is positioned against the VIEWPORT, so no ancestor scroll
        // can move it; a stuck sticky one is pinned for the same reason.
        // Choosing either as the step is choosing a step that cannot be taken.
        const placement = getComputedStyle(element).position;
        if (placement === "fixed" || placement === "sticky") continue;
        return { element, mode: "step", block: "start" };
      }
    }
    return tail ? { element: tail, mode: "tail", block: "end" } : null;
  }

  const REVEAL_MAX_PASSES = 40;
  const REVEAL_QUIET_PASSES = 3;
  /**
   * The floor under the quiet rule, and the direct answer to "scroll it at least
   * four times so you reach the bottom".
   *
   * The quiet rule alone cannot tell "there is nothing below this" from "nothing
   * has mounted below this *yet*", and on this surface the second is common: the
   * panel is rebuilt in place for every applicant, so the reads that decide
   * whether it has settled are the reads taken while it is still filling in.
   * Four passes is cheap — a settled panel costs four short waits — and it is
   * the difference between reading a screenful and reading the person.
   */
  const REVEAL_MIN_PASSES = 4;
  /**
   * How far an anchor must shift for the pass to count as having moved.
   *
   * Sub-pixel layout settling and a scrollbar appearing both nudge a rect by a
   * fraction; neither is a screenful of progress.
   */
  const REVEAL_MOVED_PX = 4;
  /**
   * Wall-clock bound on one reveal walk.
   *
   * `REVEAL_MAX_PASSES` bounds the number of steps and not what they cost, and
   * every pass may wait up to 2.4 s for the DOM to settle. This is what stops a
   * panel that keeps mounting content from holding a single applicant for
   * minutes — and, with two reveal walks per applicant, a run of 665 of them.
   */
  const REVEAL_BUDGET_MS = 45000;
  /** Per nested region — they are short next to the panel itself. */
  const REGION_MAX_PASSES = 25;

  /**
   * Every region on this page that can scroll, whatever its size.
   *
   * Deliberately NOT `scrollCandidates()`. That function answers a different
   * question — "which single container should the position walk drive?" — and to
   * answer it, it refuses any descendant carrying less than `COLUMN_TEXT_SHARE`
   * (60 %) of the panel's text, so that a filter or a menu is never mistaken for
   * the column. That refusal is right there and wrong here.
   *
   * The live defect it caused: the applicant's profile preview — Experience,
   * Education, "View full profile" — is its own nested scroller inside the
   * panel, and it carries well under 60 % of the panel's text once
   * qualifications and screening answers are counted. So it was refused as a
   * scroll target, and `revealPanelContent` only ever calls `scrollIntoView` on
   * the panel's LAST element, which scrolls that element's **ancestors** and
   * nothing else. The region was never scrolled by anything, only its first
   * screenful ever rendered, and Experience and Education sat below its fold
   * unread — while Qualifications, which render outside it, came through fine.
   * That is exactly the reported pattern.
   *
   * For revealing, anything that scrolls is worth scrolling. The applicant list
   * is excluded, because walking it is `loadEveryApplicantRow`'s job and
   * dragging it here would move the row the run is standing on.
   */
  function scrollableRegions(root) {
    const list = applicantList();
    const regions = [];
    const scope = root instanceof Element ? root : document.body;
    const candidates = [scope, ...scope.querySelectorAll("div,section,main,article,ul,ol,[role='list'],[role='tabpanel']")];
    for (const element of candidates) {
      if (!(element instanceof Element)) continue;
      if (list && (list.contains(element) || element.contains(list))) continue;
      if (element.scrollHeight - element.clientHeight <= Applicants.COLUMN_SCROLL_EPSILON) continue;
      const style = getComputedStyle(element);
      if (!/auto|scroll|overlay/i.test(`${style.overflowY} ${style.overflow}`)) continue;
      if (!cleanText(element.innerText || "")) continue;
      regions.push(element);
    }
    // Innermost first: scrolling an outer box can change an inner box's own
    // range, and the inner one is the one holding the sections that were missed.
    return regions.sort((a, b) => elementDepth(b) - elementDepth(a)).slice(0, 8);
  }

  /**
   * Drive one nested region to its bottom, collecting on every step.
   *
   * The same "growth means new content, never a scroll that happened" rule the
   * panel walk and discovery both use, so a region that is already at its end
   * costs one pass rather than twenty-five.
   */
  async function revealRegion(region, accumulator, diagnostics) {
    let added = 0;
    const startTop = region.scrollTop;
    let seen = cleanText(region.innerText || "").length;
    let quiet = 0;
    try {
      for (let pass = 0; pass < REGION_MAX_PASSES; pass += 1) {
        assertRunnable();
        const max = region.scrollHeight - region.clientHeight;
        const position = region.scrollTop;
        // The same floor the panel walk uses, and for the same reason: this is
        // the region that holds Experience and Education, it is rebuilt for
        // every applicant, and a region that has not mounted its content yet
        // reads as "no range, already at the bottom" on the first pass. Both
        // early exits are held behind it.
        const settled = pass + 1 >= REVEAL_MIN_PASSES;
        if (settled && position >= max - Applicants.COLUMN_SCROLL_EPSILON && quiet >= 1) break;
        region.scrollTop = Math.min(max, position + Math.max(400, region.clientHeight * 0.85));
        await waitForDomQuiet(300, 2200);
        added += snapshotPanel(livePanel(null), accumulator, diagnostics);
        const grown = cleanText(region.innerText || "").length;
        quiet = grown > seen ? 0 : quiet + 1;
        seen = Math.max(seen, grown);
        if (settled && quiet >= REVEAL_QUIET_PASSES) break;
      }
    } finally {
      // Handed back where it was, on the failure path as well.
      try {
        region.scrollTop = startTop;
      } catch {
        // A region unmounted mid-walk has no position to restore.
      }
    }
    return added;
  }

  /**
   * Reveal every nested region, then read again.
   *
   * Runs after the panel walk and after `revealPanelContent`, because a section
   * that only exists once its own region has been scrolled cannot be found by
   * either of them.
   */
  /** How many times the page is re-scanned for a region that mounted late. */
  const REGION_ROUNDS = 4;

  async function revealNestedRegions(panel, accumulator, diagnostics) {
    diagnostics.regions = { found: 0, walked: 0, added: 0, rounds: 0, appearedLate: 0 };
    const walked = new WeakSet();

    // Re-scanned, not sampled once.
    //
    // THE REPORT: only the FIRST applicant is scrolled to the bottom; every one
    // after it stops at the Preferred block. That is not a parsing difference,
    // it is a timing one, and the boundary names the cause exactly — Preferred
    // renders in the panel itself, while Experience and Education render inside
    // the profile preview, which is its own nested scroller.
    //
    // On the first applicant the page has been open for seconds by the time the
    // walk reaches here, so the preview has hydrated and has scroll range. From
    // the second applicant on, the panel is torn down and rebuilt in place, and
    // the preview acquires its range AFTER this pass has already looked. A
    // single sample finds no region, walks nothing, and everything below the
    // preview's own fold is never rendered — so it is never read.
    //
    // `scrollableRegions` costs a `getComputedStyle` per candidate and nothing
    // else, and a round that finds no new region ends the loop, so the common
    // case is one extra scan.
    for (let round = 0; round < REGION_ROUNDS; round += 1) {
      assertRunnable();
      let regions = scrollableRegions(livePanel(panel) || document.body);

      // Nothing at all on the first look is the case above: wait for the panel
      // to settle and ask once more before concluding there is no region.
      if (!regions.length && round === 0) {
        await waitForDomQuiet(400, 2600);
        regions = scrollableRegions(livePanel(panel) || document.body);
      }

      diagnostics.regions.rounds = round + 1;
      diagnostics.regions.found = Math.max(diagnostics.regions.found, regions.length);

      const fresh = regions.filter((region) => !walked.has(region));
      if (!fresh.length) break;
      if (round > 0) diagnostics.regions.appearedLate += fresh.length;

      for (const region of fresh) {
        if (!document.contains(region)) continue;
        walked.add(region);
        diagnostics.regions.walked += 1;
        diagnostics.regions.added += await revealRegion(region, accumulator, diagnostics);
      }
    }
    return diagnostics.regions.added;
  }

  /**
   * Bring the bottom of the panel into view, over and over, until it stops
   * growing — **whatever** scrolls it.
   *
   * This is the backstop for the whole "it only saved what was already on
   * screen" report, and it exists because every position-based walk in this
   * codebase depends on having correctly identified the one container that
   * scrolls. On the hiring surface that container is a column, its markup
   * differs per account, and getting it wrong is silent: the walk runs, the
   * position never moves, the first read is already "the bottom", and the scan
   * settles having seen one screenful.
   *
   * `scrollIntoView` does not need to know. The browser scrolls **every**
   * scrollable ancestor the element needs, so a column this code failed to
   * recognise still moves, and so does a nested one. Bounded by passes and by
   * the same "growth means new content" rule discovery uses, and the caller's
   * `finally` hands the scroll position back.
   */
  async function revealPanelContent(panel, accumulator, diagnostics, key = "reveal") {
    const record = {
      passes: 0, added: 0, grewTo: 0, stepped: 0, toTail: 0,
      movedBy: 0, reachedTail: false, stoppedBy: "running"
    };
    diagnostics[key] = record;
    let live = livePanel(panel);
    let size = cleanText(live?.innerText || "").length;
    let quiet = 0;
    /**
     * Has the walk ever actually reached the end of the rendered panel?
     *
     * THE DEFECT THIS FIXES — the reported "the scroll stops partway down, and
     * restarting stops at the same place". This walk had **no notion of the
     * bottom at all**. Its only exit was the quiet counter, and the quiet
     * counter measures CONTENT, not PROGRESS: `added` is an accumulator-count
     * delta and `grown` is the panel's text length, so a pass that steps a full
     * screenful *correctly* still counts as quiet whenever the screenful it
     * uncovered was already in the DOM or holds nothing new to parse. Three of
     * those in a row, plus `REVEAL_MIN_PASSES`, ends the walk at exactly pass
     * four — about four screenfuls down — with the panel scrolling perfectly the
     * whole time. Same panel, same four screenfuls, every run: no timing
     * involved, which is exactly why stopping and starting again reproduced it.
     *
     * `mode: "tail"` is this function's honest equivalent of `atBottom`, and it
     * costs nothing to know: it is what `nextRevealStep` returns once no element
     * begins below the fold any more. `revealRegion` and `Core.nextScanStep`
     * both refuse to settle without their own bottom check; this one now does
     * too, so "nothing new appeared" can only end the walk once there is
     * genuinely nothing left below.
     */
    let reachedTail = false;
    /** Anchors a pass proved `scrollIntoView` cannot move. */
    const stuck = new WeakSet();
    let lastAnchor = null;
    const deadline = Date.now() + REVEAL_BUDGET_MS;

    for (let pass = 0; pass < REVEAL_MAX_PASSES; pass += 1) {
      assertRunnable();
      // The pass budget bounds the number of steps but not the time they take,
      // and each one can wait up to 2.4 s. Without this a panel that keeps
      // mounting content could hold one applicant for minutes.
      if (Date.now() > deadline) {
        record.stoppedBy = "time-budget";
        break;
      }
      live = livePanel(live);
      const step = nextRevealStep(live, stuck);
      if (!step) {
        record.stoppedBy = "nothing-to-reveal";
        break;
      }
      // Measured RELATIVE TO THE PANEL, not to the viewport.
      //
      // The viewport measure was blind to which container scrolled, which was the
      // point while the document was allowed to move. Now that the page is held
      // still, a viewport measure would report a page scroll that has just been
      // undone as movement — and, worse, report a column that scrolled correctly
      // underneath a restored page as movement too, which happens to be right but
      // for the wrong reason. The offset from the panel's own top is invariant to
      // the page position and changes exactly when the column scrolls, which is
      // the question this walk is actually asking.
      const offsetInPanel = () => {
        const rect = step.element.getBoundingClientRect();
        const frame = live?.getBoundingClientRect?.();
        return frame ? rect.top - frame.top : rect.top;
      };
      const before = offsetInPanel();
      try {
        anchorPage(() => step.element.scrollIntoView({ block: step.block, inline: "nearest" }));
      } catch {
        record.stoppedBy = "scroll-refused";
        break;
      }
      // Which of the two kinds of pass this was, so a panel that never steps —
      // the signature of a reveal that is jumping straight to the end again —
      // is visible in the diagnostics rather than only in the empty columns.
      if (step.mode === "step") record.stepped += 1;
      else {
        record.toTail += 1;
        reachedTail = true;
      }
      await waitForDomQuiet(320, 2400);

      // Did this pass move the COLUMN? Same panel-relative measure as `before`,
      // so it stays blind to which container inside the panel did the scrolling —
      // the property that makes `scrollIntoView` the right tool — while ignoring
      // the page, which `anchorPage` has already put back.
      const after = step.element.isConnected ? offsetInPanel() : before;
      const shifted = Math.abs(after - before);
      record.movedBy += shifted;
      const moved = shifted > REVEAL_MOVED_PX || step.element !== lastAnchor;
      // An anchor that did not budge is retired, so the next pass steps past it
      // instead of re-picking the same immovable element for ever. Only a
      // "step" anchor: the tail is where the walk is trying to END, and retiring
      // it would leave the walk with nothing to aim at.
      if (!moved && step.mode === "step") stuck.add(step.element);
      lastAnchor = step.element;

      live = livePanel(live);
      const added = snapshotPanel(live, accumulator, diagnostics);
      const grown = cleanText(live?.innerText || "").length;
      record.passes = pass + 1;
      record.added += added;
      record.grewTo = Math.max(record.grewTo, grown);

      // Growth means new content or a new value — never a scroll that happened.
      quiet = added > 0 || grown > size ? 0 : quiet + 1;
      // ...and a pass that MOVED the panel is progress in its own right, even
      // when what it uncovered was already parsed. Conflating those two is the
      // whole defect: it made "I scrolled a screenful and it held nothing new"
      // indistinguishable from "there is nothing below here".
      if (moved) quiet = 0;
      size = Math.max(size, grown);
      // The floor is deliberately checked BEFORE the quiet rule can end the
      // walk: a panel still mounting its sections looks identical to a finished
      // one for the first read or two, and that is the whole failure mode.
      if (reachedTail && quiet >= REVEAL_QUIET_PASSES && record.passes >= REVEAL_MIN_PASSES) {
        record.stoppedBy = "settled";
        break;
      }
      if (pass === REVEAL_MAX_PASSES - 1) record.stoppedBy = "pass-budget";
    }

    record.reachedTail = reachedTail;
    // A walk that never reached the tail did not finish, whatever else it says.
    // Reported rather than smoothed over, so the next report of this is one
    // console line rather than another investigation.
    if (record.stoppedBy === "running") record.stoppedBy = "incomplete";
    if (!reachedTail && record.stoppedBy === "settled") record.stoppedBy = "no-movement";
    return live;
  }

  async function scanApplicantPanel(panel, accumulator, diagnostics, budget) {
    let live = livePanel(panel);
    let target = chooseScrollTarget(live);
    const originalY = currentScrollTop(target);
    const deadline = Date.now() + SCAN_BUDGET_MS;
    // `revealPanelContent` scrolls whatever ancestors an element needs, which
    // can include the document, so the page's own position is remembered too.
    const originalWindowY = window.scrollY;
    let scan = Core.createScanState();
    let stoppedBy = "settled";

    diagnostics.scrollContainer = target?.id || "none";
    diagnostics.scrollContainerFound = Boolean(target);

    try {
      scrollPanelTo(0, target);
      await waitForDomQuiet(400, 2600);
      // Re-chosen once the column has content in it. Before the first paint the
      // panel can have no overflow at all, and a target picked from that state
      // is the page — which is precisely the container that does not move the
      // applicant's sections.
      live = livePanel(live);
      target = chooseScrollTarget(live) || target;
      diagnostics.scrollContainer = target?.id || "none";
      diagnostics.scrollContainerFound = Boolean(target);
      diagnostics.scrollRange = maxScrollPosition(target);
      snapshotPanel(live, accumulator, diagnostics);

      for (;;) {
        scan = Core.nextScanStep(scan, {
          position: currentScrollTop(target),
          maxPosition: maxScrollPosition(target),
          viewportHeight: viewportOf(target),
          signature: [maxScrollPosition(target), accumulator.signature()].join(":")
        });
        if (scan.done) {
          stoppedBy = scan.reason;
          break;
        }
        if (Date.now() > deadline) {
          stoppedBy = "time-budget";
          break;
        }
        assertRunnable();
        scrollPanelTo(scan.position, target);
        await waitForDomQuiet(320, 2400);
        // The column is re-resolved on every step, because a re-mounted panel
        // answers with the text it held when it was detached.
        live = livePanel(live);
        snapshotPanel(live, accumulator, diagnostics);
      }

      // The position walk has done what it can with the container it identified.
      // This pass does not care which container that was: it drags the bottom of
      // the panel into view until the panel stops growing, so a column this code
      // failed to recognise is still walked to the end.
      live = await revealPanelContent(live, accumulator, diagnostics) || live;

      // And every NESTED region, which is the one thing neither pass above can
      // do. `scrollIntoView` moves an element's ancestors; the position walk
      // moves the one container it chose. A profile-preview box with its own
      // `overflow-y` inside the panel is neither, so Experience and Education
      // sat below its fold and were never rendered — while Qualifications,
      // outside it, came through. That is the whole "current role and current
      // company are still empty" report.
      await revealNestedRegions(live, accumulator, diagnostics);
      live = livePanel(live);

      // And the panel again, because a nested region that has just been walked
      // mounts content the panel did not have when it settled — which extends
      // the panel itself. "Scroll it until it cannot be scrolled any more" is
      // only true if the answer is re-checked after something new arrives.
      // Cheap when nothing moved: the quiet rule ends this in three passes.
      live = await revealPanelContent(live, accumulator, diagnostics, "revealAfterRegions") || live;

      // Everything below the fold has now mounted, so anything it left collapsed
      // exists for the first time. The expander pass before the walk could only
      // ever see the first screenful's controls, which is how a "Show all N
      // experiences" further down was never opened.
      if (budget) {
        try {
          await expandCollapsedSections(live, diagnostics, budget);
        } catch (error) {
          if (error?.hidden || error?.stopped) throw error;
          accumulator.addWarning(`expand sections: ${error?.message || error}`);
        }
      }

      // A final read from the top, once everything below has hydrated.
      scrollPanelTo(0, target);
      await waitForDomQuiet(300, 1600);
      live = livePanel(live);
      snapshotPanel(live, accumulator, diagnostics);
    } finally {
      // Hand the panel back where the recruiter left it, on every path.
      scrollPanelTo(originalY, target);
      window.scrollTo({ top: originalWindowY, behavior: "auto" });
    }

    diagnostics.scan = {
      performed: true,
      complete: stoppedBy === "settled",
      stoppedBy,
      steps: scan.steps,
      unchangedPasses: scan.unchangedPasses,
      reachedBottom: scan.atBottom
    };
    // The panel the walk finished on, which may not be the one it started with.
    return { stoppedBy, panel: live };
  }

  // ---------------------------------------------------------- extraction
  function currentChallenge() {
    if (!Connections?.detectChallenge) return { challenged: false, kind: "", message: "" };
    const main = document.querySelector("main") || document.body;
    return Connections.detectChallenge({
      url: location.href,
      title: document.title,
      bodyText: String(main?.innerText || "").slice(0, 20000)
    });
  }

  /** The panel is showing somebody other than the applicant that was asked for. */
  function wrongApplicantError(reason) {
    const error = new Error(`The panel is not showing the applicant that was asked for (${reason}).`);
    error.wrongApplicant = true;
    return error;
  }

  /**
   * Refuse to build a record out of somebody else's panel.
   *
   * The belt to the arrival wait's braces, and it is the one that makes the
   * reported failure *impossible* rather than merely unlikely. Waiting is a
   * race that can be lost — the column re-mounts, the address bar leads the
   * render — and when it is lost the cost is not a thin record but a **wrong**
   * one: three different applicants stored under one person's name, which is
   * indistinguishable at a glance from three real records.
   *
   * So the identity is checked again at the two moments that matter: after the
   * scan, and immediately before the record is built. Only `OTHER` throws — a
   * torn-down or half-mounted panel is a *wait*, which the caller has already
   * done, and a panel with no id rendered cannot contradict anything.
   *
   * Rule 6: no record is better than a wrong one.
   */
  function assertExpectedApplicant(expected) {
    if (!cleanText(expected)) return;
    const seen = describeApplicantArrival(expected);
    if (seen.state !== Applicants.PANEL_ARRIVAL.OTHER) return;
    throw wrongApplicantError(seen.reason);
  }

  /**
   * Collect the applicant currently open in the detail panel.
   *
   * The order is fixed and asserted by a test: expand what is collapsed, walk
   * the panel to the bottom, and only then open the two disclosures. An overlay
   * opened mid-scan would stop the walk dead and the record would be built from
   * whatever had mounted by then.
   */
  async function extractApplicant(options = {}) {
    if (!Applicants.isHiringPage(location.href)) {
      throw new Error("Open a LinkedIn hiring applicants page before collecting.");
    }
    const challenge = currentChallenge();
    if (challenge.challenged) {
      const error = new Error(challenge.message);
      error.challenge = challenge;
      throw error;
    }
    if (!isPageVisible()) throw hiddenPageError();
    state.wentHidden = false;

    const context = Applicants.parseHiringContext(location.href);
    const sourceUrl = location.href;
    const diagnostics = {
      buildId: BUILD_ID,
      url: sourceUrl,
      startedAt: new Date().toISOString(),
      adapter: "LinkedInApplicantAdapter",
      context,
      panel: "",
      snapshots: 0,
      totals: {},
      sections: []
    };

    // WHO this extraction is for. The caller supplies it — the run knows which
    // row it clicked — and it is checked against the panel before anything is
    // kept. Absent (a single "Collect This Applicant"), nothing is asserted,
    // because there is no expectation to contradict.
    const expected = cleanText(options.expectApplicationId);
    diagnostics.expectApplicationId = expected || null;
    assertExpectedApplicant(expected);

    let panel = applicantPanel();
    diagnostics.panel = `${panel.tagName?.toLowerCase() || "body"}${panel.id ? `#${panel.id}` : ""}`;
    const accumulator = Applicants.createApplicantAccumulator();
    // One budget for every expansion pass this extraction makes, so running the
    // expander again after the walk costs the same eight clicks in total.
    const expansion = createExpansionBudget();

    if (options.expand !== false) {
      await attempt("expand sections", accumulator, () => expandCollapsedSections(panel, diagnostics, expansion));
    }
    if (options.scan !== false) {
      const walked = await scanApplicantPanel(panel, accumulator, diagnostics, options.expand === false ? null : expansion);
      panel = walked.panel || panel;
    } else snapshotPanel(panel, accumulator, diagnostics);

    // The scan can run for a minute and a half, and the column re-mounts on this
    // surface. Asked again now rather than trusted from before it.
    assertExpectedApplicant(expected);

    // The overlays are opened on whatever the panel is now, not on the node the
    // extraction started with — a detached one contains no control at all.
    panel = livePanel(panel);
    // The one call that also records the full section scan: what was looked
    // for, every heading the page actually rendered, where each section was
    // found and what nothing named at all.
    diagnostics.sections = Object.keys(buildSectionMap(panel, diagnostics));

    // Only now, with the panel settled, are the disclosures opened.
    //
    // A DISCLOSURE THAT FINDS THE PAGE HIDDEN IS A LOST FIELD, NOT A LOST
    // APPLICANT. Both of these used to re-throw `hidden`, which threw away the
    // whole record — including the panel scan that had *already completed* on
    // line 2813 while the page was plainly visible. The run loop then treated
    // the applicant as unfinished and did the entire thing again, re-opening the
    // same disclosure that hid the page in the first place: three symptoms out
    // of one line, since it loses data, stalls the run, and re-opens one profile
    // over and over.
    //
    // Rule 12a is untouched. It says a hidden page is never READ, and nothing
    // here reads one — the disclosure stops, and what was read while the page
    // was visible is kept. `stopped` is still re-thrown, always: rule 13a means
    // a Stop ends the work, and it is the one interruption that must not be
    // downgraded into a warning on a saved record.
    if (options.contact !== false) {
      try {
        await openContactAndCollect(panel, accumulator, diagnostics);
      } catch (error) {
        if (error?.stopped) throw error;
        if (error?.hidden) accumulator.addWarning("contact: the page was hidden while the disclosure was open");
        else accumulator.addWarning(`contact: ${error?.message || error}`);
      }
    }

    const header = accumulator.snapshot().header;
    const applicantKey = Applicants.applicantId(
      context.jobId,
      header.profileUrl || "",
      header.name || "",
      context.applicationId || ""
    );

    if (options.resume !== false) {
      try {
        // Closing the contact disclosure can re-mount the column underneath it.
        panel = livePanel(panel);
        // The name the record will carry, which is the name the file is saved
        // under. It is settled by now: the qualification explanations that
        // corroborate it were read on the very first snapshot.
        await collectResume(panel, accumulator, diagnostics, applicantKey, header.name || "");
      } catch (error) {
        // Same rule as the contact disclosure above, and this is the site that
        // actually fires: opening the resume viewer is the step most likely to
        // take the tab away. The resume is left as whatever it was resolved to
        // — `link_only` or `not_attempted`, never a guess (rule 6) — and the
        // person, their history and their verdicts are still saved.
        if (error?.stopped) throw error;
        if (error?.hidden) accumulator.addWarning("resume: the page was hidden while the viewer was open");
        else accumulator.addWarning(`resume: ${error?.message || error}`);
      }
    }

    // The last word before anything is kept. Everything above read the page;
    // this asks whether the page was still showing the person the record is
    // about. A record saved under somebody else's name is the failure this
    // whole task exists to make impossible (rule 6).
    assertExpectedApplicant(expected);

    const record = Applicants.buildApplicantRecord({
      snapshot: accumulator.snapshot(),
      // Keyed to the applicant that was ASKED for when the caller named one.
      // `context` is a read of `location.href` taken when the extraction
      // started, and on this surface the address bar moves ahead of the render.
      context: expected ? { ...context, applicationId: expected } : context,
      sourceUrl,
      buildId: BUILD_ID
    });

    diagnostics.finishedAt = new Date().toISOString();
    diagnostics.selected = {
      name: record.applicant.name,
      jobTitle: record.job.title,
      email: record.applicant.contact.email,
      phone: record.applicant.contact.phone,
      resume: record.applicant.resume.downloadStatus,
      counts: {
        qualifications: record.applicant.qualifications.length,
        screening: record.applicant.screeningResponses.length,
        experience: record.applicant.experience.length,
        education: record.applicant.education.length,
        skills: record.applicant.skills.length
      },
      warnings: record.extraction.warnings
    };
    state.lastDiagnostics = diagnostics;
    // One line per applicant in the page's own console, so an empty column can
    // be explained from the page it was read on rather than only from a
    // download. It says which selector was used and what the DOM answered.
    logSectionScan(diagnostics);
    logReveal(diagnostics, record?.applicant?.name);
    logResume(diagnostics, record?.applicant?.name);
    // Persist immediately rather than at the end of the run. A recruiter who
    // closes the popup, switches tab, or presses Stop mid-list keeps every
    // applicant already finished; the worker's save is a merge, so a record
    // arriving twice enriches the stored one instead of duplicating it.
    try {
      await chrome.runtime.sendMessage({ type: "PV_APPLICANT_SAVE", record });
    } catch (error) {
      diagnostics.saveError = error instanceof Error ? error.message : String(error);
    }
    return { record, diagnostics };
  }

  // ------------------------------------------------------- every applicant
  // One at a time, in the recruiter's own tab, advancing by clicking the next
  // row of the list. Never parallel, never a tab per applicant, and the stop
  // flag is checked before every single row.

  /** Long enough for LinkedIn to unmount the old column; not a failure if it never does. */
  const PANEL_TEARDOWN_TIMEOUT_MS = 900;
  /**
   * How long the applicant that was asked for is given to mount.
   *
   * Time given to the panel, never a verdict on the applicant: a row whose
   * arrival cannot be confirmed within it is read anyway (see below). Kept short
   * enough that markup this cannot identify at all costs seconds per row rather
   * than tens of them — a 665-applicant job is walked one at a time, so every
   * second spent waiting for an answer that will not come is spent 665 times.
   *
   * The wait ends the instant the panel's identity changes, so this budget is
   * only ever spent in full when the answer is not coming at all — and then it
   * buys nothing, because the caller proceeds regardless.
   */
  const PANEL_ARRIVAL_TIMEOUT_MS = 6000;
  /**
   * How long the arrived panel is left alone before the verdict is re-read.
   *
   * **Reported: "when the extension goes to the next profile it waits a bit
   * before scrolling — it looks like the extension is frozen."** It was two
   * settles doing one job: this one, and then `scanApplicantPanel`'s own
   * `waitForDomQuiet(400, 2600)` as the very first thing it does, back to back
   * with nothing between them but one identity check. Six and a half seconds of
   * a page that is visibly doing nothing, per applicant, to answer a question
   * the next line asks again anyway.
   *
   * So this one is cut to what it is actually for — noticing a re-mount that
   * happens *during* the settle — and the scan keeps its own, which is the one
   * that has to be generous because the read depends on it. Reading a moment too
   * early costs nothing here: `snapshotPanel` is merge-only, the walk re-reads on
   * every step, and `revealPanelContent` will not stop until the panel has been
   * quiet for `REVEAL_QUIET_PASSES`.
   */
  const PANEL_SETTLE_QUIET_MS = 250;
  const PANEL_SETTLE_TIMEOUT_MS = 1200;

  /**
   * Open the next applicant and wait until the panel is actually showing them.
   *
   * TWO defects, one after the other, and the second is what this replaces.
   *
   * First it waited for the address to change and the DOM to go quiet. Neither
   * means the panel re-rendered — LinkedIn routes without a navigation, and the
   * DOM is briefly quiet *between* tearing the old applicant down and mounting
   * the new one.
   *
   * Then it waited for a **text** fingerprint to differ from the one taken
   * before the click. **The teardown alone satisfies that**, and the cost was
   * not subtle: every applicant was saved under the first applicant's name. The
   * scan read the stale panel; `chooseApplicantName` then arbitrated with
   * LinkedIn's own qualification prose, which on that panel names the previous
   * person over and over — so the wrong name won as the *corroborated* one and
   * `addName` latched it against every later read.
   *
   * What is waited for now is what was always meant: **the applicant this row
   * leads to, mounted.** In three steps, because a re-mount has three phases and
   * conflating them is what went wrong.
   *
   *   1. **Teardown** — the panel we were holding goes away, or stops being that
   *      applicant. Best-effort and short: LinkedIn may swap content in place
   *      fast enough that no torn-down state is observable, and that is not a
   *      failure. It is here so step 2 cannot be satisfied by the panel that was
   *      already on screen.
   *   2. **Arrival** — a panel that can be identified, showing this row's own
   *      application id or a different member from the one before it. Not
   *      "different text".
   *   3. **Settle**, then **ask again**, because a panel that arrives and is
   *      re-mounted underneath the quiet wait is exactly what this surface does.
   *
   * And a **third** defect, which is what the returned value now answers for.
   * Every verdict that was not an arrival skipped the applicant, including the
   * two that mean only "I could not tell" — so on markup whose section headings
   * the strict panel resolver cannot see, the run opened nobody after the first
   * and scrolled nothing. Arrival is a wait; only a panel positively showing
   * **somebody else** refuses the row.
   */
  async function selectApplicantRow(row) {
    const list = applicantList();
    const verdict = Applicants.classifyApplicantControl({
      text: cleanText(row.control.textContent),
      ariaLabel: cleanText(row.control.getAttribute("aria-label")),
      purpose: Applicants.CONTROL_PURPOSE.APPLICANT_ROW,
      inContainer: Boolean(list && list.contains(row.control))
    });
    if (!verdict.allowed) return false;

    const control = { element: row.control, verdict };
    const expected = Applicants.parseHiringContext(row.href).applicationId || "";
    const heldPanel = arrivalPanel();
    const before = panelIdentity(heldPanel);
    control.element.click();

    // 1. Teardown, best-effort: a null result means the column was reused in
    //    place, which the arrival test below handles on its own merits.
    await waitFor(() => {
      if (heldPanel && !heldPanel.isConnected) return true;
      const now = arrivalPanel();
      return !now || panelIdentity(now) !== before;
    }, { timeoutMs: PANEL_TEARDOWN_TIMEOUT_MS, pollMs: 120, label: "applicant-panel-teardown" });

    // 2. Arrival: this applicant, mounted.
    const arrival = await waitFor(() => {
      const seen = describeApplicantArrival(expected, before);
      return seen.arrived ? seen : null;
    }, { timeoutMs: PANEL_ARRIVAL_TIMEOUT_MS, pollMs: 200, label: "applicant-panel" });

    // 3. Let it finish hydrating — a panel that has arrived is not a panel that
    //    is complete — and re-ask, because a re-mount during that wait would
    //    otherwise go unseen. Short, because the scan's own first act is another
    //    settle: see `PANEL_SETTLE_QUIET_MS`.
    await waitForDomQuiet(PANEL_SETTLE_QUIET_MS, PANEL_SETTLE_TIMEOUT_MS);
    const settled = describeApplicantArrival(expected, before);
    state.lastArrival = settled;
    state.lastArrivalConfirmed = Boolean(arrival);

    // **A row is refused ONLY when the panel is positively showing somebody
    // else**, and this is the difference between a guard and a wall.
    //
    // It used to be `Boolean(arrival) && settled.arrived`, so every verdict that
    // is not an arrival skipped the applicant — including the two that mean
    // nothing more than *"I could not tell"*: `torn-down`, which is what an
    // unresolvable panel answers on every single poll, and `mounting`, which is
    // what a panel whose headings this cannot see answers forever. The run then
    // walked the whole job opening nobody, scrolling nobody and saving a bare
    // name per row, and the first applicant looked collected only because they
    // were already on screen and so were never clicked.
    //
    // "I could not tell" is not a reason to throw a person away. It is a reason
    // to read the panel and let `assertExpectedApplicant` refuse the *record* if
    // it turns out to be the wrong person — which it checks three times, and
    // which can only fire on a positive contradiction. So the wait above stays
    // exactly as it was, and is now what it always should have been: time given
    // to the panel, not a verdict on the applicant.
    const refused = settled.state === Applicants.PANEL_ARRIVAL.OTHER
      || settled.state === Applicants.PANEL_ARRIVAL.PREVIOUS;
    return !refused;
  }

  /**
   * Scroll the applicant list until it stops producing new rows.
   *
   * Trap 3 from the connections list, on a new surface: the applicant list is
   * virtualized, so reading it once gives whatever is on screen — about ten rows
   * of a job with 665 applicants — and a run over that list would silently
   * collect ten people and report itself complete. The list is therefore walked
   * to the bottom first, with the same stop rule discovery uses: keep going
   * while the row count grows, stop after `QUIET_PASSES` passes that reveal
   * nothing new, and always hand the list back where it was.
   */
  const LIST_QUIET_PASSES = 3;
  const LIST_MAX_PASSES = 200;
  /** A pager that keeps revealing nothing is retired, exactly as on the connections list. */
  const MAX_FRUITLESS_PAGINATION = 3;

  /**
   * The applicant list's own next-page control, or null (3.7.8, rule 9h).
   *
   * Enumerated from inside the list, so `inContainer` is proven rather than
   * assumed, and gated by `classifyApplicantControl` like every other control on
   * this surface — the denylist is consulted first, so a "Next" that is really
   * "Next: Message" is refused. A disabled control is not offered: on the last
   * page LinkedIn renders the pager and disables it, and clicking it forever is
   * how a walk stops terminating.
   */
  function findApplicantPaginationControl(list) {
    if (!list) return null;
    const scope = list.parentElement || list;
    for (const element of scope.querySelectorAll("button,a,[role='button']")) {
      if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
      const verdict = Applicants.classifyApplicantControl({
        text: cleanText(element.textContent),
        ariaLabel: cleanText(element.getAttribute("aria-label")),
        purpose: Applicants.CONTROL_PURPOSE.PAGINATION,
        inContainer: scope.contains(element)
      });
      if (!verdict.allowed) continue;
      if (!isVisible(element)) continue;
      return { element, verdict };
    }
    return null;
  }

  /**
   * Every row, across every page.
   *
   * Through 3.7.7 this scrolled and nothing else, so "the scroll container
   * reached its bottom and stopped growing" WAS "the list has ended" — and the
   * end of page one is indistinguishable from that. A job with more applicants
   * than fit on a page was collected one page deep and reported complete.
   *
   * The stop rule is now the connections list's, which already solved this:
   * keep going while rows arrive, and when the list has genuinely settled at the
   * bottom, page forward. Three bounds, each of which alone prevents a run that
   * never ends — growth counts NEW ROWS and never a click, a pager that reveals
   * nothing `MAX_FRUITLESS_PAGINATION` times is retired, and the pass budget
   * caps the whole walk.
   */
  async function loadEveryApplicantRow(diagnostics = {}) {
    // Waited for, exactly as the on-demand walk does: a missing list is far
    // more often a list being rebuilt than a list that is not there.
    const list = await waitForApplicantList();
    diagnostics.listScroll = { passes: 0, rows: 0, pages: 1, paged: 0, stoppedBy: "no-list" };
    if (!list) return applicantRows();

    const target = chooseScrollTarget(list);
    const startY = currentScrollTop(target);
    // Every row this walk has ever seen, BY IDENTITY. A count cannot express
    // what this walk needs to know: a paginated list swaps 25 rows for 25 other
    // rows, so the count is unchanged by a whole page of progress, and a
    // virtualized list recycles, so the count is a window size that never rises
    // at all. Either way `rows > seen` is false forever and the walk retires a
    // pager that was working. The set only ever grows, so a page revisited
    // costs nothing and a page revealed is unmistakable.
    const seenKeys = new Set(applicantRows().map(rowKey));
    const takeNewRows = () => {
      let gained = 0;
      for (const row of applicantRows()) {
        const key = rowKey(row);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        gained += 1;
      }
      return gained;
    };
    let quiet = 0;
    let passes = 0;
    let fruitless = 0;

    try {
      for (; passes < LIST_MAX_PASSES; passes += 1) {
        assertRunnable();
        const max = maxScrollPosition(target);
        const position = currentScrollTop(target);
        const atBottom = position >= max - 8;

        if (!atBottom) scrollPanelTo(position + Math.max(500, (target?.clientHeight || 600) * 0.8), target);
        // At the bottom, drag the last row into view as well: "at the bottom" is
        // only as trustworthy as the container `chooseScrollTarget` picked, and
        // a target with no range says it on the first pass. Same escape as the
        // on-demand walk, and the same one the detail panel uses.
        else nudgeListToLastRow();
        // LinkedIn fetches the next slice over the network; this wait is what
        // stops a slow response reading as "the list has ended".
        await waitForDomQuiet(380, 2800);

        // Growth means ROWS NOT SEEN BEFORE, never a scroll that happened and
        // never a bigger number — the same rule that keeps connections
        // discovery from running forever, expressed in the one currency a
        // paginated, virtualized list cannot lie in.
        quiet = takeNewRows() > 0 ? 0 : quiet + 1;
        if (atBottom && quiet >= LIST_QUIET_PASSES) {
          // Settled on THIS page. Is there another one?
          const pager = fruitless < MAX_FRUITLESS_PAGINATION
            ? findApplicantPaginationControl(applicantList() || list)
            : null;
          if (!pager) {
            diagnostics.listScroll.stoppedBy = fruitless >= MAX_FRUITLESS_PAGINATION ? "pagination-retired" : "settled";
            break;
          }
          try {
            clickApplicantPager(pager);
            diagnostics.listScroll.paged += 1;
          } catch {
            diagnostics.listScroll.stoppedBy = "pagination-refused";
            break;
          }
          // A page arrives over the network, and the new page starts at its top.
          await waitForDomQuiet(500, 6000);
          // A pager that revealed nobody new is on its way to being retired; one
          // that did resets the count, so a slow page is not mistaken for a last
          // one. What arrived decides, never the click — and a page of 25 new
          // people is what arriving looks like, whatever the count does.
          const gained = takeNewRows();
          fruitless = gained > 0 ? 0 : fruitless + 1;
          if (gained > 0) diagnostics.listScroll.pages += 1;
          quiet = 0;
          scrollPanelTo(0, target);
          continue;
        }
        if (passes === LIST_MAX_PASSES - 1) diagnostics.listScroll.stoppedBy = "pass-budget";
      }
    } finally {
      scrollPanelTo(startY, target);
    }

    diagnostics.listScroll.passes = passes;
    diagnostics.listScroll.rows = applicantRows().length;
    logListWalk(diagnostics.listScroll);
    return applicantRows();
  }

  /**
   * The one place the applicant list's pager is ever pressed (rule 9h).
   *
   * Two callers need it — the full walk and the on-demand growth — and the click
   * budget is asserted by counting click call sites in this file, deliberately,
   * so that adding a control is something a test notices. A second call site for
   * the SAME already-listed control would raise that count without adding a
   * control, which would make the budget mean less rather than more. One site
   * keeps the count honest: six, and every one of them named in rule 9.
   */
  function clickApplicantPager(pager) {
    pager.element.click();
  }

  /**
   * What a row IS, before anything is opened.
   *
   * The `applicationId` in the row's own href is the only identifier a row
   * carries before it is clicked — the record's `id` needs the profile URL, and
   * only the panel shows that — and it is exactly what `createCollectedIndex`
   * keys on, so the run's own ledger and the store's index speak one vocabulary.
   * The href, and then the cleaned name, stand in for a row whose href carries
   * no id, because a row with no key at all would be walked forever.
   */
  function rowKey(row) {
    return Applicants.applicantRowKey(row);
  }

  /**
   * How many scroll attempts one "I need the next row" may cost.
   *
   * Raised from 6 when the bottom stopped being believed on sight. The budget
   * now has to cover `LIST_QUIET_PASSES` confirmations *plus* a pager click, and
   * that whole cycle again for each of the `MAX_FRUITLESS_PAGINATION` attempts a
   * pager is allowed before it is retired. It is only ever spent in full at the
   * genuine end of the list — every other call returns the moment a row arrives.
   */
  const LIST_GROW_PASSES = 16;

  /**
   * Drag the last rendered row into view.
   *
   * `chooseScrollTarget` is a **guess**, and on this surface getting it wrong is
   * silent in the worst way: `maxScrollPosition` answers 0, every pass reads as
   * "already at the bottom", no row ever arrives, and the end of the first
   * screenful becomes the end of the list — a 665-applicant job reported
   * complete after the dozen rows that happened to be mounted.
   *
   * `scrollIntoView` needs no guess. The browser scrolls every scrollable
   * ancestor the row needs, so a list container this code failed to recognise
   * still moves. It is the same escape `revealPanelContent` uses on the detail
   * panel, applied to the other column, and it is a *read* — it presses nothing.
   */
  function nudgeListToLastRow() {
    const rows = applicantRows();
    const last = rows[rows.length - 1]?.element;
    if (!last) return false;
    try {
      // The list is a column too: revealing more rows must move that column and
      // not the recruiter's page, which stays exactly where they left it.
      anchorPage(() => last.scrollIntoView({ block: "end", inline: "nearest" }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Long enough to cover LinkedIn re-mounting the whole hiring view; short
   * enough that a list which genuinely is not there is still reported.
   */
  const LIST_REMOUNT_TIMEOUT_MS = 8000;
  /** How long a pressed pager has to actually produce its page. */
  const PAGE_ARRIVAL_TIMEOUT_MS = 15000;

  /**
   * The applicant list as it is **now**, waited for while the surface rebuilds.
   *
   * Pressing the pager re-mounts the hiring view — the reported "the whole page
   * flashes" — and for those milliseconds `applicantList()` answers null. Every
   * caller here previously fell back to the container it was already holding,
   * which by then is **detached**, and that is the whole of "it stops after
   * going to the next page":
   *
   *   - a detached container reports `scrollHeight === clientHeight`, so the
   *     walk reads "already at the bottom" on the first pass and every pass
   *     after it;
   *   - `applicantRows()` re-resolves, so no new row is ever seen *through the
   *     stale node*, and the quiet count runs out;
   *   - `findApplicantPaginationControl` then searches that detached subtree,
   *     finds the OLD page's pager, and clicking it does nothing at all.
   *
   * Three fruitless presses later the walk concludes `pagination-retired`, or
   * finds no control and concludes `settled` — and **both of those are
   * conclusive**, so the run reports COMPLETED, `claimAutoRun` refuses to re-arm
   * a completed job, and nothing can restart it. A false completion is worse
   * than a stop precisely here.
   */
  function waitForApplicantList(timeoutMs = LIST_REMOUNT_TIMEOUT_MS) {
    const live = applicantList();
    if (live) return Promise.resolve(live);
    return waitFor(() => applicantList(), { timeoutMs, pollMs: 200, label: "applicant-list" });
  }

  /** The walk ledger, for a run that grows the list instead of pre-walking it. */
  function createListWalk(diagnostics) {
    diagnostics.listScroll = {
      passes: 0, rows: applicantRows().length, pages: 1, paged: 0,
      fruitless: 0, mode: "on-demand", stoppedBy: "running"
    };
    return diagnostics.listScroll;
  }

  /**
   * How many scroll passes settling ONE page of the list may cost.
   *
   * A page is 25 rows — roughly 2000px — so this covers walking it top to bottom
   * about three times over, plus the `LIST_QUIET_PASSES` confirmations. It is
   * deliberately far smaller than `LIST_MAX_PASSES`: this walks a page, never a
   * list, and a budget large enough to walk a list would hide a page that never
   * settles instead of ending it.
   */
  const LIST_PAGE_PASSES = 24;

  /**
   * Settle THIS page: every row it holds, in the order it holds them, before a
   * single applicant on it is opened — and never touching the pager.
   *
   * **THE REPORT: "it did not even collect all the applicants in one page ...
   * make sure it is working in a sequence, collecting all applicants before
   * moving to next page."** Both halves of that came from the same absence. The
   * run knew only which rows were mounted at the instant it looked, so:
   *
   *   - it started wherever the recruiter had left the list, and
   *     `growApplicantList` only ever scrolls DOWN, so every row above that
   *     point was never mounted, never offered and never collected — and the
   *     pager was then pressed on a page that was never finished;
   *   - and "which row next" was "whichever unfinished row is rendered first",
   *     which a virtualized window re-centring on the applicant just opened
   *     re-answers differently every time. That is the reported back-and-forth:
   *     the window re-mounts rows above the one just collected, they are
   *     unprocessed, they render first, and the walk steps backwards.
   *
   * Settling the page fixes both at their root, because it converts "what is
   * mounted" into the two facts the walk actually needs — who is on this page,
   * and in what order (`Applicants.createApplicantRoster`). It starts at the
   * **top** for the first of those reasons and it confirms the bottom for the
   * second, on the same "growth means rows never seen before, never a scroll
   * that happened" rule the rest of this surface is bounded by.
   *
   * It presses nothing. Paging forward stays the caller's decision, made only
   * once the roster it settled here has been finished with, which is the whole
   * of "all applicants before the next page".
   *
   * `wanted` lets a caller stop early — used when the run is looking for rows
   * the page still owes it rather than settling the page for the first time.
   */
  async function sweepCurrentPage(roster, diagnostics, wanted = null) {
    const walk = diagnostics.listScroll || createListWalk(diagnostics);
    const list = await waitForApplicantList();
    if (!list) {
      walk.stoppedBy = "no-list";
      return false;
    }
    // The top, because the rows this is here to find are the ones above wherever
    // the list happens to be sitting. A run resumed on a half-scrolled list, or
    // one LinkedIn scrolled to the open applicant, has them all behind it.
    scrollPanelTo(0, chooseScrollTarget(list));
    await waitForDomQuiet(320, 2000);

    let quiet = 0;
    for (let pass = 0; pass < LIST_PAGE_PASSES; pass += 1) {
      assertRunnable();
      // Re-resolved every pass, for the reason `waitForApplicantList` exists:
      // the hiring view re-mounts, and a detached container keeps answering with
      // the range it had when it was unmounted.
      const live = await waitForApplicantList();
      if (!live) {
        walk.stoppedBy = "no-list";
        return false;
      }
      const target = chooseScrollTarget(live);
      // ONE list scan per pass, and both answers taken from it.
      const gained = roster.add(applicantRows());
      walk.rows = Math.max(walk.rows, roster.size);
      walk.passes += 1;
      // Found what the caller came for. The list is deliberately left where it
      // is, because where it is, is where that row is mounted.
      if (typeof wanted === "function" && wanted()) return true;

      const max = maxScrollPosition(target);
      const position = currentScrollTop(target);
      const atBottom = position >= max - 8;
      quiet = gained > 0 ? 0 : quiet + 1;
      // The bottom is confirmed rather than believed on sight: LinkedIn fetches
      // the rest of the page over the network, and a slice still in flight looks
      // exactly like a page that has ended.
      if (atBottom && quiet >= LIST_QUIET_PASSES) {
        // Settled — and handed back at the TOP, because the first applicant of
        // this page is the next one the run opens. Leaving it at the bottom
        // would start the page at its last row and then need a sweep back up
        // for every row above it: correct, but the slow way round.
        scrollPanelTo(0, chooseScrollTarget((await waitForApplicantList()) || live));
        await waitForDomQuiet(320, 2000);
        roster.add(applicantRows());
        return true;
      }

      if (!atBottom) scrollPanelTo(position + Math.max(500, (target?.clientHeight || 600) * 0.8), target);
      // Either this really is the bottom, or the container being driven is not
      // the one that scrolls. Dragging the last row into view settles it without
      // needing to know which.
      else nudgeListToLastRow();
      await waitForDomQuiet(380, 2800);
    }
    return false;
  }

  /**
   * Reveal more rows — once, and only because the run has just run out of them.
   *
   * THE REPORT: "you do not need to scroll [the applicant list] in the start,
   * scroll when needed". Through 3.7.8 a run began by walking the entire list to
   * the end across every page, so a job with 665 applicants spent minutes
   * scrolling the recruiter's own list before a single person was collected —
   * and dragged that list away from wherever they had left it, for no benefit.
   * The run needs row N when it reaches row N and not before.
   *
   * Same three bounds as the full walk, because the failure mode is identical:
   * growth counts NEW ROWS and never a click, a pager that reveals nothing
   * `MAX_FRUITLESS_PAGINATION` times is retired, and the attempt itself is
   * capped. The difference is only when it runs.
   *
   * Deliberately does NOT restore the scroll position: the run is walking this
   * list, so the list following along is correct. The position it started at is
   * handed back once, when the whole run ends.
   */
  async function growApplicantList(diagnostics, hasWork) {
    const walk = diagnostics.listScroll || createListWalk(diagnostics);
    // The verdict must describe THIS call. `walk` is deliberately shared across
    // calls so `fruitless` can retire a pager over a whole run, but that made
    // `stoppedBy` sticky: a call that returned early on success never cleared it,
    // so the caller could read a "settled" left behind by an earlier attempt and
    // complete a run on a verdict nothing had just reached. It only ever ended
    // the run before, so staleness could not show; now that an inconclusive stop
    // is retried, the value has to mean what it says.
    walk.stoppedBy = "running";
    // Waited for rather than sampled: a missing list is far more often a list
    // being rebuilt than a list that is not there.
    const list = await waitForApplicantList();
    if (!list) {
      walk.stoppedBy = "no-list";
      return applicantRows().length;
    }

    /**
     * "Did that reveal a row the run still has to collect?"
     *
     * THE DEFECT THIS REPLACES, and it is the whole of "it is not working for
     * all the list of applicants". Every growth test in here used to compare a
     * COUNT against a baseline taken on entry (`applicantRows().length > before`).
     * Rule 9h says this list is **paginated**, and a paginated list does not
     * grow — it REPLACES: page one renders 25 rows, page two renders 25
     * different people, and 25 > 25 is false. So a successful page-forward was
     * scored as "revealed nothing", the pager was pressed again and again until
     * `MAX_FRUITLESS_PAGINATION` retired it, and the function returned having
     * silently walked past pages two, three and four. The caller then saw no row
     * it could use and reported the run COMPLETED — 25 collected out of 665.
     *
     * The count is just as blind the other way. On a virtualized list that
     * recycles rows out of the DOM, `applicantRows().length` is the size of the
     * mounted WINDOW, not a total: it sits at about a dozen forever, so no
     * amount of scrolling ever satisfies `> before` either.
     *
     * Identity answers both. The caller knows which rows it has finished with,
     * so it passes the only question that matters, and a page swap, a recycled
     * window and an appended slice are all simply "yes".
     */
    const wanted = typeof hasWork === "function"
      ? hasWork
      : (() => {
        // No ledger supplied (the `loadAll` path): fall back to "a row the list
        // was not already showing when this call started".
        const startedWith = new Set(applicantRows().map(rowKey));
        return () => applicantRows().some((row) => !startedWith.has(rowKey(row)));
      })();
    // How many consecutive passes have ended at the bottom having revealed
    // nothing. One is not an answer: LinkedIn fetches the next slice over the
    // network, and a slice that has not arrived yet looks exactly like a list
    // that has ended.
    let quiet = 0;

    for (let pass = 0; pass < LIST_GROW_PASSES; pass += 1) {
      assertRunnable();
      // Re-resolved every pass, for the reason `livePanel` exists: the list is
      // re-mounted as it pages, and a detached container keeps answering with
      // the range it had when it was unmounted.
      //
      // **`|| list` used to be the fallback here, and it was the bug.** A page
      // change detaches the container this walk is holding; falling back to it
      // means measuring a node that is no longer on the page and, worse, finding
      // the previous page's pager inside it. See `waitForApplicantList`. There
      // is now no fallback at all: either a live list, or an inconclusive stop
      // the caller retries — never a conclusive one reached on a dead node.
      const live = await waitForApplicantList();
      if (!live) {
        walk.stoppedBy = "no-list";
        break;
      }
      const target = chooseScrollTarget(live);
      const max = maxScrollPosition(target);
      const position = currentScrollTop(target);
      const atBottom = position >= max - 8;

      if (!atBottom) {
        scrollPanelTo(position + Math.max(500, (target?.clientHeight || 600) * 0.8), target);
      } else {
        // Either this really is the bottom, or the container being driven is not
        // the one that scrolls. Dragging the last row into view settles it
        // without needing to know which.
        nudgeListToLastRow();
      }
      // LinkedIn fetches the next slice over the network; this wait is what
      // stops a slow response reading as "the list has ended".
      await waitForDomQuiet(380, 2800);
      walk.passes += 1;
      if (wanted()) {
        walk.rows = applicantRows().length;
        // A call that produced work clears the pager's record. Retirement is
        // meant to describe a control that reveals nothing, and three fruitless
        // attempts spread across a long run — three slow slices — should not
        // condemn it for the rest of that run.
        walk.fruitless = 0;
        return walk.rows;
      }
      if (!atBottom) continue;

      // At the bottom, and this pass revealed nothing. THE DEFECT THIS FIXES:
      // that single observation used to be the whole verdict — one pass at the
      // bottom with no pager in sight ended the walk, `extractAllApplicants` saw
      // no further row and marked the run COMPLETED. A slow slice, or a scroll
      // target with no range, therefore finished a 665-applicant job somewhere
      // in the first dozen and reported it as done. The full walk has required
      // `LIST_QUIET_PASSES` consecutive quiet passes since 3.7.8; this is the
      // same rule on the on-demand path, which is the one a run actually uses.
      quiet += 1;
      if (quiet < LIST_QUIET_PASSES) continue;

      // Genuinely settled at the bottom of this page. Is there another one?
      // Without this the end of page one is indistinguishable from the end of
      // the list.
      const pager = walk.fruitless < MAX_FRUITLESS_PAGINATION
        ? findApplicantPaginationControl(live)
        : null;
      if (!pager) {
        walk.stoppedBy = walk.fruitless >= MAX_FRUITLESS_PAGINATION ? "pagination-retired" : "settled";
        break;
      }
      try {
        clickApplicantPager(pager);
        walk.paged += 1;
      } catch {
        walk.stoppedBy = "pagination-refused";
        break;
      }
      // A page arrives over the network and the whole hiring view is re-mounted
      // while it does. **Waiting for the rows is not the same as waiting for
      // quiet**, and quiet was the wrong question twice over: the DOM is quiet
      // while the request is still in flight, so a fast `waitForDomQuiet`
      // returned before page two existed and scored the press as fruitless —
      // and a re-mount then mutates continuously, so the other outcome was the
      // 6 s timeout, spent whether or not the page had already arrived.
      //
      // The rows answer directly, and they are the thing being waited for.
      const arrived = await waitFor(() => wanted(), {
        timeoutMs: PAGE_ARRIVAL_TIMEOUT_MS,
        pollMs: 250,
        label: "applicant-page"
      });
      // Then let the new page finish mounting before it is read or scrolled.
      await waitForDomQuiet(400, 3000);
      // What the click revealed decides, never the click — and "revealed" is a
      // row this run has not collected, not a bigger number. A pager that swaps
      // 25 people for 25 different people moved the list forward by a whole
      // page; scoring that as nothing is what collected one page of 665.
      const produced = Boolean(arrived) || wanted();
      walk.fruitless = produced ? 0 : walk.fruitless + 1;
      if (produced) {
        walk.pages += 1;
        walk.rows = applicantRows().length;
        // The container that was scrolled has been replaced along with the page
        // it belonged to, so the "start the new page at its top" has to address
        // the new one. Handing the position to a detached node silently does
        // nothing, and the next pass then starts half way down page two.
        const paged = applicantList();
        if (paged) scrollPanelTo(0, chooseScrollTarget(paged));
        return walk.rows;
      }
      // A click that revealed nothing earns the same confirmation the first
      // verdict had to earn, rather than letting the next pass press again
      // immediately. `fruitless` still retires the control after three.
      quiet = 0;
    }

    walk.rows = applicantRows().length;
    if (walk.stoppedBy === "running") walk.stoppedBy = "grow-budget";
    return walk.rows;
  }

  /**
   * What the list walk actually did, in the recruiter's own console.
   *
   * The same discipline as `logSectionScan`: a run that collects 25 of 665 must
   * be explicable from the page rather than from a download. These diagnostics
   * were written and then thrown away — the reply that carried them is discarded
   * by the caller and `state.lastListDiagnostics` was read by nothing.
   */
  function logListWalk(walk) {
    if (!walk) return;
    const label = `[Profile Vault ${BUILD_ID}] applicant list — ${walk.rows} row(s) across ${walk.pages} page(s), stopped: ${walk.stoppedBy}`;
    // "list-exhausted" is the on-demand walk's own clean ending: the run asked
    // for another row, the list could neither scroll nor page, so that was all
    // of them. It is a settled end, not a truncated one.
    if (walk.stoppedBy === "settled" || walk.stoppedBy === "list-exhausted") console.info(label, walk);
    else console.warn(label, walk);
  }

  /**
   * Who is already saved, asked of the worker rather than assumed.
   *
   * A run has no store of its own — the content script is thrown away with the
   * page — so "what did the last run already collect" is a question only the
   * worker can answer. The reply is deliberately lean: one small entry per
   * stored applicant rather than the records themselves.
   */
  /**
   * Who this job already has a **usable** record for.
   *
   * **One question, asked the same way by both commands.** The list pass used to
   * ask its own — "do I already *have* them" — and that existed for exactly one
   * reason: it wrote name-only records, which `isCollectedApplicant` correctly
   * refuses to call collected, so a resumed pass would have re-walked the whole
   * job. Once that pass started opening each applicant and writing a full record,
   * the reason evaporated. What was left was actively harmful.
   *
   * **THE DEFECT IT CAUSED, reported directly: "even if I click the extension to
   * start again it does not scroll the profile."** Anything that leaves a thin
   * record behind — a panel that would not open, a scan the tab going to the
   * background interrupted, a run that could not confirm who it was looking at —
   * writes the row's own name as a floor, deliberately, so nobody is lost. A "do
   * I have them" index counts every one of those as done. So the applicants a
   * broken run failed on became precisely the ones the *next* run walked straight
   * past, and no amount of pressing the button could reach them again.
   * `isCollectedApplicant` is the test that tells them apart: it wants one
   * substantive field, so a complete read is skipped and a thin one is tried
   * again. `options.recollect` still asks for the whole list regardless.
   */
  async function loadCollectedIndex(jobId) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "PV_APPLICANT_COLLECTED", jobId: jobId || "" });
      return Applicants.createCollectedIndex(reply?.entries || [], { jobId: jobId || "" });
    } catch {
      // The worker being unreachable must never mean "collect everything
      // again"; an empty index simply skips nobody.
      return Applicants.createCollectedIndex([], { jobId: jobId || "" });
    }
  }

  /** How long a run waits for its tab to come back before it gives up. */
  const VISIBILITY_WAIT_MS = 5 * 60 * 1000;

  /**
   * Hold until LinkedIn is rendering this page again.
   *
   * Rule 12a says a hidden page is never read, and that stays true — this is
   * the other half of it: a hidden page is a reason to WAIT, not a reason to
   * throw the rest of the list away. A Stop still ends it at once, and it is
   * bounded so a tab left in the background overnight does not hold a run open
   * forever.
   */
  async function waitForVisibleAgain(timeoutMs = VISIBILITY_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.aborted) return false;
      if (isPageVisible()) return true;
      await wait(500);
    }
    return false;
  }

  /**
   * A breath between applicants on a list pass.
   *
   * Asked for outright — "slow down on every profile" — and it is also simply
   * politer: a run walks hundreds of panels back to back on the recruiter's own
   * session, and the connections importer has paced itself between profiles
   * since 3.3 for the same reason. Small, because the walk below is already the
   * bulk of the time.
   */
  const LIST_PROFILE_PACE_MS = 900;

  /**
   * What the list pass reads, and what it presses to read it.
   *
   * **Requested outright: "I want the extension to be able to get contact info
   * from the contact info button given in the profile AND I WANT THE RESUME TO
   * BE DOWNLOADED IN THE DISK WITH THE NAME OF THE PROFILE OWNER."** Both were
   * already built and both were switched **off** here, which is the whole of why
   * neither happened: `contact: false` skipped `openContactAndCollect`, the one
   * step that opens the disclosure holding the email and the phone number
   * (rule 9d), and `resume: false` skipped `collectResume`, which is the entire
   * PERMANENT resume chain — find the document address without opening anything,
   * fall back to the viewer and its own Download control, record the link before
   * the download is attempted, and hand the file to the worker, which saves it as
   * `header.name` (`Applicants.resumeFileName`, sanitized and de-duplicated with
   * ` (2)`). The applicant's own name was always what the file would be called;
   * nothing on this surface ever asked for the file.
   *
   * So the two flags are gone and the steps they gated are the ones rule 9
   * already names and gates individually. `expand` stays **off**: it is the one
   * remaining flag, it opens collapsed sections rather than revealing a field
   * this pass is for, and it is worth up to `MAX_EXPANSIONS` (8) clicks per
   * applicant on a walk that is already the slow part.
   *
   * `current_role`, `current_company` and `total_experience` are still
   * `deriveCurrentPosition` and `totalExperienceFrom` over the Experience cards
   * the panel rendered, exactly as in a full collection: **one** definition of
   * "current role" on this surface rather than a second that can drift from it.
   */
  const VISIBLE_ONLY_OPTIONS = Object.freeze({ expand: false });

  /**
   * Open this row's applicant, let the panel load, walk it to the bottom, take
   * what it rendered, disclose their contact details and save their resume.
   *
   * `extractApplicant` owns all of it — the wait for the applicant to be
   * showing, the scan, the disclosure, the resume, the record and the save — so
   * this adds no reading rule of its own and no click rule of its own. It is the
   * full run's own path with the section expander off.
   */
  async function collectVisibleApplicant(row, rowId) {
    const openId = Applicants.parseHiringContext(location.href).applicationId || "";
    // Not re-clicked when the panel is already showing them — the same test the
    // full run makes, and it costs no extra click either way.
    if (!rowId || rowId !== openId) {
      if (!(await selectApplicantRow(row))) return { opened: false, record: null };
    }
    // The row's own id travels with the request, so the extraction can refuse to
    // build a record out of anybody else's panel.
    const { record } = await extractApplicant({ ...VISIBLE_ONLY_OPTIONS, expectApplicationId: rowId });
    return { opened: true, record };
  }

  async function extractAllApplicants(options = {}) {
    beginRun();
    // The list is NOT walked up front any more.
    //
    // It was, from 3.7.1: a virtualized list read once yields a screenful, and a
    // run over a screenful reports itself complete after ten people. That is
    // still true, and it is still solved — but by growing the list **when the
    // run runs out of rows** rather than by walking all 665 of them before
    // collecting anybody. The reported cost of the old order: minutes of
    // scrolling before the first applicant, and the recruiter's own list dragged
    // to the bottom for no reason. `loadAll: true` asks for the old behaviour.
    const listDiagnostics = {};
    createListWalk(listDiagnostics);
    if (options.loadAll === true) await loadEveryApplicantRow(listDiagnostics);
    state.lastListDiagnostics = listDiagnostics;

    // Where the recruiter had the list, handed back when the run ends.
    const listTarget = chooseScrollTarget(applicantList());
    const listStartY = currentScrollTop(listTarget);
    let known = applicantRows().length;

    // A run that was stopped half way used to go back to the first applicant
    // and collect all of them again. It is now told what is already saved and
    // walks past those rows without opening them; `recollect` is the way to ask
    // for the whole list again on purpose.
    const jobId = Applicants.parseHiringContext(location.href).jobId || "";
    const collected = options.recollect === true
      ? Applicants.createCollectedIndex([], { jobId })
      : await loadCollectedIndex(jobId);
    listDiagnostics.alreadyCollected = collected.size;

    // The job header, read ONCE for a list pass and attached to every row.
    //
    // It sits above both columns and does not change as the list is walked, so
    // reading it per row would be hundreds of forced layouts for one unchanging
    // answer — the same reason `applicantRows()` made its name a lazy getter.
    // Without it every name would land under a bare job id; with it the table
    // says which job these people applied to. Read through the same `readJob`
    // the full extraction uses, so there is one rule for what a job header is,
    // and left null if it says nothing rather than assembled (rule 6).
    let listJob = null;
    if (options.listOnly === true) {
      const jobAccumulator = Applicants.createApplicantAccumulator();
      listJob = attempt("read job", jobAccumulator, () => readJob(jobAccumulator));
    }

    state.run = Applicants.createRunState({
      state: Applicants.RUN_STATE.RUNNING,
      total: known,
      startedAt: new Date().toISOString()
    });

    const results = [];

    /**
     * Every row this run has finished with, by identity.
     *
     * THE DEFECT THIS REPLACES. The walk used to be `for (let index = 0; ;
     * index += 1)` over a freshly re-queried `applicantRows()`, taking
     * `live[index]` as "applicant number index". Position means nothing on this
     * list. Under the pagination rule 9h describes, page two renders 25
     * *different* people at positions 0–24, so an index of 25 addresses nobody
     * and the run ends; had page two rendered 26 rows, `live[25]` would have
     * been applicant #51 and #26–#50 would never have been opened at all. Under
     * a virtualized list that recycles rows out of the DOM, `applicantRows()` is
     * a moving WINDOW of about a dozen — the index runs off the end of it after
     * a dozen applicants, no scrolling can ever make `length` exceed the index,
     * and the run reports COMPLETED having collected twelve of 665.
     *
     * An identity ledger has neither failure. "Which row next" becomes "the
     * first rendered row I have not finished with", which is true whatever the
     * list does to positions — replace them, recycle them, re-order them.
     * "The run is over" becomes "no unprocessed row can be produced", which is
     * the question that was actually being asked all along.
     *
     * A key goes in on every TERMINAL outcome — collected, already saved,
     * failed, or could-not-open — and deliberately not on a pause, because a
     * pause is the one case where the row still has to be done.
     */
    const processed = new Set();

    /**
     * Who is on the page being walked, and in what order — settled before
     * anybody on it is opened, and reset when the pager moves to the next one.
     *
     * THE DEFECT THIS REPLACES, reported in two halves that turned out to be one
     * cause. "It saves a profile, goes to a specific profile, then to the next,
     * saves, then back to that specific profile" — and "it did not even collect
     * all the applicants in one page." The ledger above answers "have I finished
     * with this row"; nothing answered "which row is next" or "is this page
     * done", and the DOM was left to imply both. It cannot: `applicantRows()` is
     * whatever is mounted at the instant it is asked, LinkedIn re-centres that
     * window on the applicant whose panel it has just opened, and rows above the
     * scroll position the run happened to start at were never mounted at all.
     * So the walk stepped backwards and forwards through the re-mounted window,
     * and pressed the pager on a page it had only partly opened.
     *
     * See `sweepCurrentPage` for the settle and `Applicants.createApplicantRoster`
     * for the ordering.
     */
    const roster = Applicants.createApplicantRoster();

    /**
     * One list scan, and the roster learns from every one of them.
     *
     * This is the hook that keeps the roster honest between settles: the run
     * reads the list several times per applicant anyway, so a row LinkedIn
     * mounts late is merged into its own place on the page at no extra cost —
     * `roster.add` is a merge-insert, so it lands between the rows it rendered
     * between rather than after everything already known.
     */
    const unprocessedRows = () => {
      const rendered = applicantRows();
      roster.add(rendered);
      return Applicants.unprocessedApplicantRows(rendered, processed);
    };

    /** Has this page been walked end to end, so its roster is its membership? */
    let pageSettled = false;

    /**
     * How many times running the CURRENT row has ended with the page hidden.
     *
     * The old code did `index -= 1; continue;` with no counter anywhere, so any
     * repeatable cause of a hidden page — and a disclosure that opens a tab is
     * exactly that — re-ran the same applicant forever. That is the reported
     * "at some profile keeps refreshing the page": one profile re-opening over
     * and over, each turn costing a full scan, for as long as the tab is left
     * alone. A pause must be able to resume the row; it must not be able to
     * own the run.
     */
    const MAX_HIDDEN_RETRIES = 2;
    let retryingKey = "";
    let hiddenRetries = 0;

    /**
     * How many times this row may be re-opened because the panel came up
     * showing somebody else.
     *
     * Refusing the record is the correct answer — a wrong name is worse than no
     * record — but refusing it forever is not: without a bound, one row whose
     * panel never resolves would hold the run for the rest of the job. So the
     * row is re-opened a few times and then recorded as failed, with the reason
     * on the run, and the walk moves on to somebody it can read.
     */
    const MAX_WRONG_APPLICANT_RETRIES = 2;
    let wrongApplicantKey = "";
    let wrongApplicantRetries = 0;

    /**
     * How many growth attempts in a row may end without telling us where the
     * list ends.
     *
     * Each attempt costs `LIST_GROW_PASSES` and leaves the list further down than
     * it found it, so consecutive attempts genuinely advance rather than
     * repeating — this retries a walk that was working, not one that failed.
     * Bounded because a list that has stopped responding must still end the run,
     * and reset by any attempt that produces a row, so a long run is never
     * condemned by three slow slices spread across it.
     */
    const MAX_INCONCLUSIVE_GROWTHS = 3;
    let inconclusive = 0;

    for (;;) {
      // The one moment the applicant list is scrolled: the run has run out of
      // rows it has not done and needs more. `growApplicantList` is asked the
      // same identity question rather than being left to compare counts, so a
      // page swap counts as progress and the bottom of page one is never
      // mistaken for the end of the list.
      // ONE list scan per turn, and every answer taken from it.
      //
      // Reading the list is not free: `applicantRows()` walks every `a[href]` in
      // the list and, before this, took `innerText` on each — a forced layout
      // per row. The turn used to do that twice (once to pick the next row, and
      // again for the `known` bookkeeping), and a resumed run spends most of its
      // turns skipping rows
      // that are already saved, so a mostly-collected 665-applicant job was
      // paying well over a thousand full list scans to decide it had nothing to
      // do. The DOM cannot change between those two reads — nothing here awaits
      // — so one scan is not merely cheaper, it is the only honest number.
      let pending = unprocessedRows();
      // Back into PAGE order. `pending` is whatever the list has mounted, in
      // whatever order it mounted it; the roster is where those rows sit on the
      // page. Without this the walk takes the first row the window happens to
      // render, which is how it kept stepping back to an applicant it had
      // already passed.
      pending = roster.sort(pending);

      /**
       * The next row of this page, in the PAGE's order — mounted or not.
       *
       * This is the whole of "make sure it is working in a sequence". `pending`
       * can only offer what the list has mounted, and a virtualized window that
       * re-centres on the applicant just opened decides that. Asking the roster
       * instead means the run waits for the row that is genuinely next and
       * refuses to open whoever happens to be on screen in their place.
       *
       * `roster.sort` guarantees that when this row IS mounted it is `pending[0]`
       * — it holds the lowest roster position of anything unprocessed — so the
       * common case costs one string comparison and no scrolling at all.
       */
      const owed = roster.next(processed);
      const ready = pending.length > 0 && rowKey(pending[0]) === owed;
      if (!pageSettled || !ready) {
        /**
         * THE STOP AFTER N PROFILES, and it is not a counter anywhere.
         *
         * `growApplicantList` calls `assertRunnable()` on every pass, which
         * throws `hiddenPageError` the moment the tab is hidden — or merely the
         * moment `state.wentHidden` is still latched from an earlier switch,
         * since only `beginRun()` clears it. This call sat **outside** the
         * try/catch below, so that throw was not a pause: it propagated out of
         * the row loop, out of `extractAllApplicants`, and `runEveryApplicant`
         * rethrew it. The run was dead, and dead runs are restarted from the
         * first row by `noteReturnToTab` — so the recruiter saw it collect the
         * handful of rows that happened to be rendered, stop, and start over.
         * The count was never a limit; it was however many rows were already on
         * screen before the list first needed growing.
         *
         * `extractApplicant` has been treated as a pause since 3.7.7. Growing
         * the list is the same kind of work on the same page and gets the same
         * treatment: wait for the page to come back, clear the latch, and carry
         * on where it left off. `waitForVisibleAgain` is the bound — five
         * minutes hidden ends the run — so nothing here can spin.
         */
        let grown;
        const pagedBefore = listDiagnostics.listScroll.paged;
        try {
          /**
           * THE PAGE BOUNDARY, and it is a step of its own on purpose.
           *
           * **"Make sure it is working in a sequence, collecting all applicants
           * before moving to next page."** Neither half of that was ever
           * decidable before, because the run's only notion of the page was
           * "rows that happen to be mounted". Settling it end to end, from the
           * top, is what turns that into membership: after this the roster IS
           * the page, so "next" means the next row on it and "finished" means
           * all of them — not "nothing unprocessed is on screen".
           *
           * It costs one walk of ~25 rows per page, and it is emphatically not
           * the up-front walk 3.7.8 removed: that one walked the WHOLE list,
           * every page of a 665-applicant job, before a single person was
           * opened. This walks the page the run has just arrived at, and only
           * that page.
           */
          if (!pageSettled) {
            await sweepCurrentPage(roster, listDiagnostics);
            pageSettled = true;
            pending = roster.sort(unprocessedRows());
          }

          /**
           * The row this page owes next is not mounted, so bring THAT row back.
           *
           * A virtualized list recycles, so "the next row is not on screen" is
           * not "the next row is done" — and treating the two as the same thing
           * is both halves of the report at once: the walk opened whoever the
           * window was showing instead (the back-and-forth), and pressed the
           * pager while rows it had never opened were still on the page.
           *
           * The sweep is asked for that one row and stops the moment it mounts.
           * Only a row that survives a confirmed walk of the whole page is
           * retired, because by then it is not on the page any more — and it is
           * retired one at a time, so a single vanished row costs one sweep
           * rather than condemning every row still outstanding.
           */
          const target = roster.next(processed);
          const mounted = (key) => unprocessedRows().some((candidate) => rowKey(candidate) === key);
          if (target && !mounted(target)) {
            await sweepCurrentPage(roster, listDiagnostics, () => mounted(target));
            pending = roster.sort(unprocessedRows());
            if (!mounted(target)) {
              processed.add(target);
              state.run.skipped += 1;
              state.run.index = processed.size;
              state.run.lastError = `A row on this page could not be found again and was skipped (${target}).`;
              console.warn(`[Profile Vault ${BUILD_ID}] a row vanished from the page`, target);
              continue;
            }
          }

          if (!pending.length) {
            grown = await growApplicantList(listDiagnostics, () => unprocessedRows().length > 0);
            // A pager press is a NEW page: nothing about the old roster survives
            // it, and the new one is settled before anybody on it is opened, so
            // page two is walked in its own order from its own first row.
            if (listDiagnostics.listScroll.paged !== pagedBefore) {
              roster.reset();
              pageSettled = false;
              await sweepCurrentPage(roster, listDiagnostics);
              pageSettled = true;
            }
          }
        } catch (error) {
          if (error?.stopped) {
            state.run.state = Applicants.RUN_STATE.STOPPED;
            break;
          }
          if (!error?.hidden) throw error;
          state.run.lastError = error.message;
          const resumed = await waitForVisibleAgain();
          if (!resumed) {
            state.run.state = Applicants.RUN_STATE.STOPPED;
            break;
          }
          showPageNotice("Profile Vault resumed — continuing where it left off.");
          // Nothing was processed and nothing partial was saved, so the next
          // turn simply asks for rows again.
          beginRun();
          continue;
        }
        // `grown` is undefined when the settle — or the sweep for a row this
        // page still owed — produced the work, so the pager was never consulted
        // and there is no verdict to read. Fall through and open somebody.
        if (grown !== undefined) {
          known = grown;
          // The DOM genuinely moved, so this re-scan is the one that is earned —
          // and in page order, because the page it reads may be a new one.
          pending = roster.sort(unprocessedRows());
          if (!pending.length) {
            if (listDiagnostics.listScroll.stoppedBy === "running") {
              listDiagnostics.listScroll.stoppedBy = "list-exhausted";
            }
            const stoppedBy = listDiagnostics.listScroll.stoppedBy;
            // "No new row" is not "no more applicants", and the difference decides
            // whether this job can ever restart: `claimAutoRun` will not re-arm a
            // job whose execution reported COMPLETED, so claiming it here without
            // having reached the end of the list disables the reload-resume too.
            //
            // `list-exhausted` is inconclusive despite the name it is recorded
            // under. Growth only leaves `stoppedBy` at "running" when it returned
            // early because `wanted()` was true — it had found an unprocessed row —
            // so arriving here means that row was recycled out of the DOM between
            // its check and this re-scan. That is a race on a virtualized list, not
            // the end of one, and the retry resolves it on the next pass.
            if (Applicants.isConclusiveListStop(stoppedBy)) {
              state.run.state = Applicants.RUN_STATE.COMPLETED;
              break;
            }
            inconclusive += 1;
            if (inconclusive < MAX_INCONCLUSIVE_GROWTHS) continue;
            // Out of retries and still unable to see the end of the list. This must
            // NOT be COMPLETED: stopping leaves the standing instruction armed, so
            // staying on the tab or reloading picks the run up again.
            state.run.state = Applicants.RUN_STATE.STOPPED;
            state.run.lastError =
              `Stopped after ${processed.size} applicant(s): the list would not reveal more rows (${stoppedBy}). `
              + "The run is not complete — it will continue when this page is reloaded or reopened.";
            break;
          }
        }
        // A pass that produced work starts the allowance over: three slow or
        // budget-bound attempts spread across a long run are not a stuck list.
        inconclusive = 0;
      }

      // Retire EVERY already-saved row on this one scan rather than spending a
      // whole turn — and another scan — on each of them. The verdict needs only
      // the row's own href, so it is decidable in bulk without opening anything
      // and without any assumption about position. This is what makes a resumed
      // run skip past the collected ones instead of stepping through them.
      let retired = 0;
      for (const candidate of pending) {
        const candidateId = Applicants.parseHiringContext(candidate.href).applicationId || "";
        // `has()` consults the name ONLY when the row carries no id, so the name
        // getter — which forces a layout — is read only in that case. Passing
        // both would reintroduce the per-row reflow this task removes.
        const saved = candidateId
          ? collected.has({ applicationId: candidateId })
          : collected.has({ name: candidate.name });
        if (!saved) continue;
        processed.add(rowKey(candidate));
        state.run.skipped += 1;
        state.run.alreadyCollected += 1;
        retired += 1;
      }
      if (retired) {
        pending = pending.filter((candidate) => !processed.has(rowKey(candidate)));
        state.run.index = processed.size;
        state.run.updatedAt = new Date().toISOString();
      }

      // Honest numbers rather than DOM arithmetic: what has been done, and what
      // is known to remain. `known` is still the high-water mark of rendered
      // rows, which is all the DOM can honestly say about a paginated list.
      known = Math.max(known, processed.size + pending.length);
      // And the roster knows more than the DOM does: it holds every row of this
      // page, including the ones currently recycled out of it, so the progress
      // the recruiter watches counts the page rather than the window.
      known = Math.max(known, processed.size + roster.remaining(processed));
      state.run.index = processed.size;
      state.run.total = known;

      // Everything rendered here was already saved. Round again: the next turn
      // grows the list rather than opening anybody.
      const row = pending[0];
      if (!row) continue;

      // Consulted for the STOP semantics. Completion is decided above, by
      // exhaustion, so the total handed over is the one thing that is certainly
      // true — there is at least one more row than have been processed — rather
      // than a rendered-row count that would declare the queue complete at the
      // end of page one.
      const step = Applicants.nextRunStep(state.run, { total: processed.size + 1 });
      if (step.action !== "collect") {
        state.run.state = step.action === "stop" ? Applicants.RUN_STATE.STOPPED : Applicants.RUN_STATE.COMPLETED;
        break;
      }

      const key = rowKey(row);
      // Decided from the row itself, before anything is opened: the id in its
      // own href is all a row knows about who it leads to, and opening every
      // applicant to find out they may be skipped is the cost this avoids.
      const rowId = Applicants.parseHiringContext(row.href).applicationId || "";

      // ---------------------------------------------------------- list pass
      // "Collect all the applicants like we did in connections": the whole
      // list, across every page, one at a time, saving each person's name.
      //
      // Since 3.7.10 it also **opens each applicant, lets the panel load and
      // walks it to the bottom before moving on**, which was asked for
      // outright. Only the name is still saved: the walk is there so every
      // profile is genuinely reached and rendered, not so that more is read
      // from it. `extractApplicant` and everything it drives is untouched and
      // still the only path for the full collection — it is simply not called
      // here.
      //
      // Rows already **collected** were retired in bulk above — one substantive
      // field, `isCollectedApplicant`, so an applicant this pass wrote a full
      // record for is walked past while one left with nothing but a floor name
      // is tried again. That distinction is the whole reason a run that failed
      // on somebody can be fixed by pressing the button rather than only by
      // `options.recollect`, which asks for the whole list regardless.
      if (options.listOnly === true) {
        // Rule 12a and rule 13a inside the loop, not between items: a hidden
        // tab renders nothing, so its rows are not worth reading, and a Stop
        // must land within one row.
        assertRunnable();
        // The row's own name, and the FLOOR for this applicant. The panel scan
        // below is what fills the other columns, but a panel that resolves no
        // name would otherwise leave the column the whole export is read by
        // empty while the row plainly rendered it.
        const fromRow = Applicants.buildApplicantListRecord({
          name: row.name,
          href: row.href,
          job: listJob,
          context: Applicants.parseHiringContext(location.href),
          sourceUrl: location.href,
          buildId: BUILD_ID
        });
        // Not a person. The applicant list renders links that are not rows —
        // the live one is **"Edit qualifications"**, in the list's own header
        // ("Here are all applicants to your job. Edit qualifications"), and its
        // href carries the same `applicationId` the page is on, so nothing about
        // the link tells it apart from the open applicant's row. The text does,
        // and `isApplicantNameCandidate` already refused this exact phrase for
        // the panel path a release earlier. Skipped, never saved: a record with
        // a wrong name in the column the export is read by is worse than no
        // record (rule 6).
        if (!fromRow) {
          processed.add(key);
          state.run.skipped += 1;
          state.run.lastError = `Skipped a list link that is not an applicant${row.name ? `: "${row.name}"` : ""}.`;
          state.run.index = processed.size;
          state.run.updatedAt = new Date().toISOString();
          continue;
        }
        state.run.currentName = fromRow.applicant.name;
        state.run.updatedAt = new Date().toISOString();

        // Open them, let the panel load, walk it to the bottom, take what it
        // rendered — name, current role, current company, total experience and
        // education — then disclose their contact details and save their resume
        // under their own name. `extractApplicant` saves the record it builds,
        // so nothing here re-sends it.
        let opened = true;
        let record = null;
        try {
          const outcome = await collectVisibleApplicant(row, rowId);
          opened = outcome.opened;
          record = outcome.record;
        } catch (error) {
          if (error?.stopped) {
            state.run.state = Applicants.RUN_STATE.STOPPED;
            break;
          }
          if (error?.hidden) {
            // A hidden page is a PAUSE. Left unprocessed and unsaved, so this
            // row is done properly once the page is renderable again — with the
            // same bound the full run applies, because a disclosure or a viewer
            // that reliably hides the tab would otherwise re-run one applicant
            // for as long as the tab is left alone.
            state.run.lastError = error.message;
            const resumed = await waitForVisibleAgain();
            if (!resumed) {
              state.run.state = Applicants.RUN_STATE.STOPPED;
              break;
            }
            showPageNotice("Profile Vault resumed — continuing where it left off.");
            beginRun();
            hiddenRetries = key === retryingKey ? hiddenRetries + 1 : 1;
            retryingKey = key;
            if (hiddenRetries > MAX_HIDDEN_RETRIES) {
              processed.add(key);
              state.run.failed += 1;
              state.run.lastError =
                `The page kept going hidden while reading ${fromRow.applicant.name}; moved on after ${MAX_HIDDEN_RETRIES} retries.`;
              state.run.index = processed.size;
            }
            continue;
          }
          // The panel was showing somebody else. The record was refused rather
          // than written under the wrong person's name — which is the whole
          // point — and the row is left for the next turn to open again, so it
          // is neither lost nor saved wrongly.
          if (error?.wrongApplicant) {
            wrongApplicantRetries = key === wrongApplicantKey ? wrongApplicantRetries + 1 : 1;
            wrongApplicantKey = key;
            if (wrongApplicantRetries > MAX_WRONG_APPLICANT_RETRIES) {
              // Re-opened enough. Recorded as failed rather than saved under
              // whoever the panel insisted on showing, and the walk moves on.
              processed.add(key);
              state.run.failed += 1;
              state.run.lastError =
                `The panel kept showing somebody else when ${fromRow.applicant.name} was opened; `
                + `moved on after ${MAX_WRONG_APPLICANT_RETRIES} retries rather than save the wrong name.`;
              state.run.index = processed.size;
              await wait(LIST_PROFILE_PACE_MS);
              continue;
            }
            state.run.lastError = `${error.message} ${fromRow.applicant.name} will be opened again.`;
            state.run.updatedAt = new Date().toISOString();
            await wait(LIST_PROFILE_PACE_MS);
            continue;
          }
          // A panel that would not open, would not scroll, or would not parse.
          // The NAME came from the list row and is unaffected, so it is still
          // saved below — losing a person from the list because their panel
          // misbehaved would defeat the one thing this pass is for.
          opened = false;
          state.run.lastError = error instanceof Error ? error.message : String(error);
        }
        if (!opened && !state.run.lastError) {
          state.run.lastError =
            `Could not open ${fromRow.applicant.name}'s profile; the name from their list row was still saved.`;
        }

        // `extractApplicant` has already saved whatever the panel gave it. This
        // is the FLOOR, and only when it is needed: a row that never opened, or
        // a panel that resolved no name, would otherwise leave the column the
        // export is read by empty.
        //
        // Safe because both halves of the store are merge-only:
        // `saveApplicant` reconciles on job + applicationId so this lands on the
        // record just written rather than beside it, and `mergeApplicantRecord`
        // never overwrites a filled field with a blank — so a name-only record
        // can only ever fill the gap, never flatten the details.
        const named = cleanText(record?.applicant?.name);
        try {
          if (!named) await chrome.runtime.sendMessage({ type: "PV_APPLICANT_SAVE", record: fromRow });
          results.push(record || fromRow);
          state.run.collected += 1;
          // Added to the index as well as to the store, so a virtualized list
          // that renders the same row twice in one pass is not walked twice.
          if (rowId) collected.applications.add(rowId.toLowerCase());
        } catch (error) {
          state.run.failed += 1;
          state.run.lastError = error instanceof Error ? error.message : String(error);
        }
        processed.add(key);
        state.run.index = processed.size;
        state.run.updatedAt = new Date().toISOString();
        // A breath before the next one, and a Stop lands on the next row's
        // `assertRunnable()` a moment later.
        await wait(LIST_PROFILE_PACE_MS);
        continue;
      }

      if (collected.has({ applicationId: rowId, name: row.name })) {
        processed.add(key);
        state.run.skipped += 1;
        state.run.alreadyCollected += 1;
        state.run.index = processed.size;
        state.run.updatedAt = new Date().toISOString();
        continue;
      }

      state.run.currentName = row.name;
      state.run.updatedAt = new Date().toISOString();
      try {
        // Opened unless the panel is ALREADY showing this row. The old test was
        // `index > 0`, which assumed the open panel was row zero — true only
        // when the recruiter had not opened anybody else first, and meaningless
        // once positions stopped being the walk's vocabulary. Comparing the
        // address bar's `applicationId` to the row's own asks the real question,
        // and it costs no extra click: `selectApplicantRow` is the same single
        // gated control (rule 9g), simply not pressed when it would be a no-op.
        const openId = Applicants.parseHiringContext(location.href).applicationId || "";
        if (!rowId || rowId !== openId) {
          const opened = await selectApplicantRow(row);
          // A row that never brought its applicant up is a skip, not a record:
          // scanning anyway would save the previous applicant's panel a second
          // time under this row's identity.
          if (!opened) {
            processed.add(key);
            state.run.skipped += 1;
            state.run.lastError = `Could not open ${row.name || "the next applicant"}.`;
            state.run.index = processed.size;
            continue;
          }
        }
        // The row's own id travels with the request here too: the full run has
        // exactly the same exposure, and a record saved under the wrong
        // applicant's name is the same defect whichever command produced it.
        const { record } = await extractApplicant({ ...options, expectApplicationId: rowId });
        results.push(record);
        processed.add(key);
        state.run.collected += 1;
        // Added to the index as well as to the store, so a virtualized list
        // that renders the same row twice in one pass is not collected twice.
        if (rowId) collected.applications.add(rowId.toLowerCase());
      } catch (error) {
        if (error?.stopped) {
          state.run.state = Applicants.RUN_STATE.STOPPED;
          break;
        }
        if (error?.wrongApplicant) {
          // Refused rather than saved under whoever the panel was showing, and
          // bounded so one unresolvable row cannot hold the rest of the job.
          wrongApplicantRetries = key === wrongApplicantKey ? wrongApplicantRetries + 1 : 1;
          wrongApplicantKey = key;
          state.run.lastError = error.message;
          if (wrongApplicantRetries > MAX_WRONG_APPLICANT_RETRIES) {
            processed.add(key);
            state.run.failed += 1;
            state.run.lastError =
              `The panel kept showing somebody else when ${row.name || "this applicant"} was opened; `
              + `moved on after ${MAX_WRONG_APPLICANT_RETRIES} retries rather than save the wrong name.`;
            state.run.index = processed.size;
          }
          continue;
        }
        if (error?.hidden) {
          // A hidden page is a PAUSE, not the end of the run. It used to break
          // out of this loop, so the moment anything took the tab away — a
          // resume opening in a new tab, the recruiter glancing at another tab —
          // the run was dead and stayed dead after they came back, which is what
          // "it gets stuck until I close the tab myself" actually was.
          state.run.lastError = error.message;
          const resumed = await waitForVisibleAgain();
          if (!resumed) {
            state.run.state = Applicants.RUN_STATE.STOPPED;
            break;
          }
          // Said out loud, on the page. A run continuing after a pause the
          // recruiter caused by looking at another tab is indistinguishable
          // from a dead one until something says otherwise.
          showPageNotice("Profile Vault resumed — continuing where it left off.");
          // The latch cleared, and the row left unprocessed so it is picked
          // again — nothing partial was saved, so re-reading it is correct.
          beginRun();
          hiddenRetries = key === retryingKey ? hiddenRetries + 1 : 1;
          retryingKey = key;
          if (hiddenRetries > MAX_HIDDEN_RETRIES) {
            // Retried enough. Whatever hides the page on this applicant is
            // reproducible, so repeating it is not a pause any more — it is the
            // loop the recruiter watches one profile spin in. Recorded as a
            // failure, which is honest and invents nothing (rule 6), and the
            // walk moves on to somebody it can read.
            processed.add(key);
            state.run.failed += 1;
            state.run.lastError =
              `The page kept going hidden while reading ${row.name || "this applicant"}; moved on after ${MAX_HIDDEN_RETRIES} retries.`;
            state.run.index = processed.size;
          }
          continue;
        }
        processed.add(key);
        state.run.failed += 1;
        state.run.lastError = error instanceof Error ? error.message : String(error);
      }
      state.run.index = processed.size;
    }

    if (state.run.state === Applicants.RUN_STATE.RUNNING) state.run.state = Applicants.RUN_STATE.COMPLETED;
    state.run.updatedAt = new Date().toISOString();

    // Handed back where the recruiter left it, now that the run has finished
    // with it. During the run it deliberately follows along — the list is what
    // the run is walking, so dragging it back on every row would fight it.
    scrollPanelTo(listStartY, chooseScrollTarget(applicantList()) || listTarget);
    listDiagnostics.listScroll.rows = applicantRows().length;
    logListWalk(listDiagnostics.listScroll);

    return { records: results, run: { ...state.run }, list: listDiagnostics.listScroll || null };
  }

  /**
   * Run the whole list and persist whether this execution truly finished.
   *
   * `tracking` is issued by the worker. The attempt number is as important as
   * the run id: after reinjection the replaced closure may unwind later than its
   * successor, and its stale "interrupted" report must not reopen a completed
   * run or make a second loop eligible to start.
   */
  async function runEveryApplicant(options = {}, tracking = null) {
    const jobId = Applicants.parseHiringContext(location.href).jobId || "";
    const report = async (lifecycle) => {
      if (!jobId || !tracking?.runId || !tracking?.attempt) return;
      // A service worker may be waking at the exact moment the run finishes.
      // Retry the idempotent, token-checked report rather than leaving a truly
      // completed job looking unfinished because one message port was lost.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const reply = await chrome.runtime.sendMessage({
            type: "PV_APPLICANT_RUN_LIFECYCLE",
            jobId,
            tracking: { ...tracking, state: lifecycle }
          });
          if (reply?.ok) return;
        } catch {
          // The next bounded attempt wakes the worker again.
        }
        if (attempt < 2) await wait(200 * (attempt + 1));
      }
    };
    try {
      const result = await extractAllApplicants(options);
      const lifecycle = result.run?.state === Applicants.RUN_STATE.COMPLETED
        ? Applicants.AUTO_RUN_STATE.COMPLETED
        : Applicants.AUTO_RUN_STATE.INTERRUPTED;
      await report(lifecycle);
      // Reported first, then continued: the worker has to see this execution
      // finish before it can hand the job to the next one, and `claimAutoRun`
      // refuses a lease that is still `running`.
      continueInterruptedRun(result);
      return result;
    } catch (error) {
      await report(Applicants.AUTO_RUN_STATE.INTERRUPTED);
      // Deliberately NOT continued. A throw out of the walk is a challenge, a
      // checkpoint or a page that stayed hidden past the wait, and rule 13 says
      // those pause and wait for a person — retrying them in a loop is the one
      // thing that would turn a rate limit into a worse one.
      throw error;
    }
  }

  /** Long enough for the surface to settle after whatever ended the last attempt. */
  const CONTINUE_DELAY_MS = 1500;

  /**
   * A run that stopped short, on a job this page is still sitting on, continues.
   *
   * **THE GAP THIS CLOSES.** Every restart path on this surface answers "did we
   * *arrive* somewhere" — a route change, a tab return, a reload. None of them
   * fires when a run simply ends early *while the recruiter is sitting on the
   * page watching it*, which is precisely what an inconclusive stop is:
   * `MAX_INCONCLUSIVE_GROWTHS` spent on a list that was being re-mounted leaves
   * `RUN_STATE.STOPPED`, the worker is correctly told `INTERRUPTED` so the job
   * stays restartable — and then nothing restarts it, because no address
   * changed and no tab was switched. The surface goes quiet mid-list with the
   * instruction still armed and nobody to act on it.
   *
   * So the run asks for itself back. It is a **continuation of the recruiter's
   * own unfinished instruction**, on the job they started it on, which is the
   * same standing the reload-resume has — the extension still never decides on
   * its own to start reading a page.
   *
   * **What stops it looping**, which matters more here than anywhere else on
   * this surface:
   *   - a COMPLETED run is never continued, so the end of the list ends it;
   *   - Stop latches `autoRun.disabled`, checked first (rule 13a);
   *   - leaving the surface blanks the key;
   *   - and the same `MAX_FRUITLESS_RETURNS` budget a tab return spends: a
   *     continuation that collected nobody new does not earn another. A pass
   *     that collected somebody resets it, which is exactly why walking page
   *     after page is unbounded in *pages* and still bounded in *failures*.
   *
   * It goes through `pumpAutoRun`, so every guard that path already has applies
   * unchanged: the worker is still asked whether this job is armed, a hidden tab
   * still defers, and a run already in flight is still left alone.
   */
  function continueInterruptedRun(result) {
    if (state.autoRun.disabled || state.aborted) return;
    if (result?.run?.state === Applicants.RUN_STATE.COMPLETED) return;
    if (result?.run?.stopRequested) return;
    const key = applicantsPageKey(location.href);
    if (!key) return;
    if (key === state.autoRun.returnKey && state.autoRun.fruitlessReturns >= MAX_FRUITLESS_RETURNS) {
      if (!state.autoRun.quietedReturns) {
        state.autoRun.quietedReturns = true;
        console.info(
          "[Profile Vault] not continuing this job again: "
          + `${state.autoRun.fruitlessReturns} attempt(s) collected nobody new. `
          + "Press Collect Applicant List or Collect Every Applicant to run it again."
        );
      }
      return;
    }
    state.autoRun.pendingKey = key;
    state.autoRun.attempts = 0;
    const why = result?.run?.lastError || result?.list?.stoppedBy || "interrupted";
    console.info(`[Profile Vault] the run stopped short (${why}); continuing on this page.`);
    // Deferred, because this runs INSIDE the promise the caller assigned to
    // `state.running` — `startAutoRun` refuses to start on top of a run in
    // flight, and from in here the current one has not settled yet.
    setTimeout(() => pumpAutoRun(), CONTINUE_DELAY_MS);
  }

  // -------------------------------------------------- coming back to a job
  // A navigation destroys this content script and everything it knew, so
  // returning to a job's applicants page left the surface idle until the
  // recruiter went and pressed the button again. The worker is the only thing
  // that outlives the navigation, so it holds the standing instruction: a job
  // it was asked to collect, and the options it was asked with.
  //
  // Nothing here decides on its own to start reading a page. It restarts a run
  // **the recruiter started themselves**, on the job they started it on, with
  // the options they chose — and a Stop clears the instruction outright, so
  // walking away and coming back can never undo one.

  /**
   * Which job this page is showing, or "" when it is not an applicants page.
   *
   * Keyed on the job and deliberately not on the applicant: opening rows is how
   * a run *advances*, and every one of those changes the address bar. Keying on
   * the whole URL would restart the run on every row it opened.
   */
  function applicantsPageKey(url) {
    return Applicants.applicantsViewKey(url);
  }

  /** How many times one unfulfilled arrival may be retried before it is given up. */
  const AUTO_RUN_MAX_ATTEMPTS = 8;

  /**
   * How many tab returns may restart the same view's run without collecting
   * anybody before the surface stops offering to do it again.
   *
   * Two, not one: the first restart may legitimately be interrupted before it
   * reaches anyone new — a slow list, a glance away a second later — and giving
   * up after a single such attempt would lose the resume feature on exactly the
   * flaky runs it exists for. Two consecutive restarts that collected nobody is
   * a loop, not a slow start.
   */
  const MAX_FRUITLESS_RETURNS = 2;

  /** Bounded wait for the list to exist. A page with no rows has nothing to run over. */
  async function waitForApplicantRows(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (state.autoRun.disabled || !isPageVisible()) return 0;
      const rows = applicantRows().length;
      if (rows) return rows;
      if (Date.now() >= deadline) return 0;
      await waitForDomQuiet(400, 2000);
    }
  }

  /**
   * Ask the worker whether this job was collected on purpose, and if so, run it.
   *
   * From the beginning: `extractAllApplicants` builds a fresh run state and
   * walks the list from the first row, so there is no stale index to pick up.
   * What it does *not* do is collect the same people twice — the collected index
   * is still consulted unless the recruiter ticked "Re-collect already saved",
   * because the options are the ones they started with.
   */
  /** An arrival that cannot be fulfilled, and never will be. Stop retrying it. */
  function abandonAutoRun(reason) {
    if (!state.autoRun.pendingKey) return;
    state.autoRun.pendingKey = "";
    state.autoRun.attempts = 0;
    if (reason) console.info(`[Profile Vault] auto-restart not started: ${reason}`);
  }

  async function startAutoRun(key) {
    // A Stop is final until the recruiter asks again (rule 13a), and a run
    // already in flight is already doing the thing an arrival would ask for.
    if (state.autoRun.disabled) return abandonAutoRun("stopped on this page");
    if (state.running || state.extracting) return abandonAutoRun("a run is already in flight");
    // Everything below this line is TRANSIENT: the arrival stays pending and is
    // tried again on the next tick. That is the whole fix — 3.7.6 consumed the
    // key before the attempt, so a single lost race lost the restart for good.
    if (!isPageVisible()) return;
    if (state.autoRun.busy) return;
    state.autoRun.busy = true;
    try {
      const jobId = Applicants.parseHiringContext(location.href).jobId || "";
      if (!jobId) return abandonAutoRun("this address carries no job id");
      let verdict = null;
      try {
        verdict = await chrome.runtime.sendMessage({ type: "PV_APPLICANT_AUTO_RUN", jobId });
      } catch {
        // A worker that did not answer may simply have been asleep, so this is
        // retried rather than read as "no instruction".
        return;
      }
      if (!verdict?.armed) return abandonAutoRun(verdict?.reason || "this job was not collected on purpose");
      // The page has to be showing the list before a run over it means anything.
      // After an in-app route LinkedIn paints the shell well before the rows, so
      // this is the bail that most often needs a second attempt.
      if (!(await waitForApplicantRows())) return;
      if (state.autoRun.disabled) return abandonAutoRun("stopped on this page");
      if (state.running || state.extracting) return abandonAutoRun("a run is already in flight");
      if (applicantsPageKey(location.href) !== key) return abandonAutoRun("the page moved on before the run could start");

      state.autoRun.pendingKey = "";
      state.autoRun.attempts = 0;
      console.info(`[Profile Vault] returning to job ${jobId} — restarting the run from the first row.`);
      // Only here, where a run is actually about to start. Every bail above this
      // line leaves the page silent on purpose: a banner saying "resumed" over a
      // surface that then does nothing is worse than no banner at all.
      showPageNotice("Profile Vault resumed — collecting the applicants not yet saved.");
      state.running = runEveryApplicant(verdict.options || {}, verdict.tracking || null)
        .finally(() => { state.running = null; });
      await state.running.catch(() => undefined);

      // The standing instruction for this view has now been CARRIED OUT, and
      // this document remembers that. Without it, every later return to the tab
      // started the whole 665-row walk again from the first row — see
      // `noteReturnToTab`.
      //
      // Only on COMPLETED, and the distinction is load-bearing: a run that was
      // interrupted (STOPPED, typically because the tab was hidden past
      // VISIBILITY_WAIT_MS) is exactly the run a return to the tab SHOULD pick
      // up, and marking that one as done would delete the feature.
      //
      // This is only safe because COMPLETED now means what it says. Until the
      // walk was keyed on identity, a run that merely reached the bottom of page
      // one also reported COMPLETED, and remembering that would have switched
      // the restart off in precisely the failure it exists for.
      if (state.run?.state === Applicants.RUN_STATE.COMPLETED) {
        state.autoRun.ranKey = key;
        state.autoRun.fruitlessReturns = 0;
        state.autoRun.quietedReturns = false;
      } else {
        // Interrupted, so `ranKey` is deliberately NOT set — this is the run a
        // return to the tab should pick up. But it must not be picked up
        // forever: score it by what it actually collected, so a restart that
        // achieved nothing is not repeated on every glance at the tab. A
        // restart that collected somebody has earned the next one.
        if (key !== state.autoRun.returnKey) {
          state.autoRun.returnKey = key;
          state.autoRun.fruitlessReturns = 0;
        }
        state.autoRun.fruitlessReturns = state.run?.collected
          ? 0
          : state.autoRun.fruitlessReturns + 1;
      }
    } finally {
      state.autoRun.busy = false;
    }
  }

  /**
   * Try to fulfil an arrival that has not run yet.
   *
   * Called from every watcher, so a transient bail costs one tick rather than
   * the whole feature. `attempts` bounds it: a job whose list never mounts must
   * not be asked about forever.
   */
  function pumpAutoRun() {
    const key = state.autoRun.pendingKey;
    if (!key) return;
    if (applicantsPageKey(location.href) !== key) return abandonAutoRun("");
    // A tick that CANNOT try must not spend an attempt. The 800 ms poller calls
    // this on every beat, including all the beats while `startAutoRun` is
    // already awaiting the worker or waiting up to twenty seconds for the list
    // to mount — so the budget was being spent on ticks that returned at the
    // `busy` guard without attempting anything, reaching eight in about six
    // seconds and logging "the applicant list never appeared" while the run was
    // in fact starting. The bound is meant to be eight real attempts.
    if (state.autoRun.busy || !isPageVisible()) return;
    if (state.autoRun.attempts >= AUTO_RUN_MAX_ATTEMPTS) {
      return abandonAutoRun("the applicant list never appeared");
    }
    state.autoRun.attempts += 1;
    startAutoRun(key);
  }

  /**
   * Did this page just *arrive* at a job's applicant list, as opposed to move
   * within it?
   *
   * An arrival is a view key that differs from the one seen last. Opening a row
   * keeps the key identical — that is the whole reason the key strips the ids
   * out of the address — so a run can never restart itself by advancing through
   * the list it is already collecting. Moving to a different view of the same
   * job and back again *does* change it, which is what makes LinkedIn's own
   * in-app navigation a return rather than a no-op.
   *
   * An arrival is only RECORDED here; fulfilling it is `pumpAutoRun`'s job, and
   * it is retried until it succeeds or is abandoned for a stated reason.
   */
  function checkAutoRunArrival() {
    const key = applicantsPageKey(location.href);
    const previous = state.autoRun.lastKey;
    state.autoRun.lastKey = key;
    if (key && key !== previous) {
      state.autoRun.pendingKey = key;
      state.autoRun.attempts = 0;
      // A genuine arrival is the recruiter navigating, not the tab regaining
      // focus, so it clears the fruitless-return budget `noteReturnToTab` spends.
      state.autoRun.returnKey = key;
      state.autoRun.fruitlessReturns = 0;
      state.autoRun.quietedReturns = false;
    } else if (!key && state.autoRun.pendingKey) {
      // Left the surface before the arrival could be acted on.
      abandonAutoRun("");
    }
    pumpAutoRun();
  }

  function resumeAutoRun() {
    if (!state.autoRun.pendingKey || !isPageVisible()) return;
    pumpAutoRun();
  }

  /**
   * Coming back to this tab is itself a reason to run again.
   *
   * THE GAP THIS CLOSES. Every watcher on this page answers the question "did we
   * *arrive* somewhere new", and `applicantsViewKey` is deliberately built so
   * that opening a row does not count. But switching to another tab and back
   * changes **no address at all** — that is the entire nature of a tab switch —
   * so the arrival test could never fire for it, and nothing else was watching.
   * Meanwhile a run that had been interrupted by the tab going hidden gives up
   * for good once `VISIBILITY_WAIT_MS` passes. Put together: glance at another
   * window for five minutes, come back, and the surface sits there having
   * quietly decided the run was over — which is exactly "it automatically stops
   * working", and exactly why reloading the page was the only thing that helped,
   * since a reload re-injects this script with a fresh `state`.
   *
   * So a return to the tab records an arrival on the view that is already open.
   * Nothing about the guard rails changes, and that is what keeps this inside
   * "after a direct user action": the worker is still asked whether this job was
   * armed by the recruiter's own Collect Every Applicant, a Stop still latches
   * `disabled` and refuses, and a run already in flight is left alone to
   * continue on its own.
   */
  function noteReturnToTab() {
    // A run in flight has its own way back — `waitForVisibleAgain` is holding
    // the loop and will continue it in place, which is better than restarting.
    if (state.running || state.extracting) return;
    if (state.autoRun.disabled) return;
    const key = applicantsPageKey(location.href);
    if (!key) return;
    // A view whose run this document already carried out to COMPLETION is not
    // restarted again.
    //
    // THE LOOP THIS ENDS. Every other watcher asks "did we ARRIVE somewhere
    // new" and gates on `lastKey`; this one deliberately does not, because a tab
    // switch changes no address. But nothing else bounded it either: the worker
    // keeps a job armed for twelve hours and is never told a run finished, and
    // `state.running` is null the moment one does. So the ordinary way of using
    // this extension — press Collect Every Applicant, switch to the Applicants
    // page to watch the rows arrive, switch back — restarted the entire walk
    // from the first row, every single time, for twelve hours. On 665 applicants
    // that is minutes of re-paging and re-opening rows per glance, and with
    // "Re-collect already saved" replayed it re-opens every one of them. That is
    // what the page looked like it was doing when it "kept refreshing".
    if (key === state.autoRun.ranKey) return;
    // And a view whose run this document has already restarted twice without
    // collecting anybody is not restarted a third time on a tab switch.
    //
    // `ranKey` above bounds only the COMPLETED case, which left the common one
    // unbounded: the tab going hidden is what interrupts a run, and switching
    // tabs is how this extension is used, so glance away and back and the whole
    // 665-row walk began again from the first row — then was interrupted by the
    // next glance, recording nothing, forever. A restart has to earn the next
    // one. A real arrival (an actual change of view) clears this, because that
    // is the recruiter navigating rather than the tab merely regaining focus,
    // and Stop / Collect Every Applicant re-arm it outright.
    if (key === state.autoRun.returnKey && state.autoRun.fruitlessReturns >= MAX_FRUITLESS_RETURNS) {
      if (!state.autoRun.quietedReturns) {
        state.autoRun.quietedReturns = true;
        console.info(
          "[Profile Vault] not restarting this job again on a tab switch: "
          + `${state.autoRun.fruitlessReturns} restart(s) collected nobody new. `
          + "Press Collect Every Applicant to run it again."
        );
      }
      return;
    }
    state.autoRun.pendingKey = key;
    pumpAutoRun();
  }

  // ------------------------------------------------------------- messaging
  state.handler = (message, _sender, sendResponse) => {
    const type = message?.type;

    if (type === "PV_APPLICANT_PING") {
      sendResponse({
        ok: true,
        buildId: BUILD_ID,
        surface: "applicants",
        supported: Applicants.isHiringPage(location.href),
        context: Applicants.parseHiringContext(location.href)
      });
      return false;
    }

    if (type === "PV_APPLICANT_CHECK_PAGE") {
      sendResponse({
        ok: true,
        buildId: BUILD_ID,
        surface: "applicants",
        supported: Applicants.isHiringPage(location.href),
        applicantsPage: Applicants.isApplicantsPage(location.href),
        context: Applicants.parseHiringContext(location.href),
        rows: applicantRows().length,
        challenge: currentChallenge()
      });
      return false;
    }

    if (type === "PV_GET_DIAGNOSTICS") {
      sendResponse({ ok: true, surface: "applicants", diagnostics: state.lastDiagnostics });
      return false;
    }

    // Universal stop. Both names, because the popup's button stops everything
    // and the applicants page has its own.
    if (type === "PV_APPLICANT_STOP" || type === "PV_STOP_ALL") {
      state.aborted = true;
      state.run.stopRequested = true;
      state.run.state = Applicants.RUN_STATE.STOPPED;
      // Rule 13a: a Stop ends everything, including the standing instruction to
      // restart on return. The worker clears its own copy; this stops an
      // arrival already in flight on this page from starting after it.
      state.autoRun.disabled = true;
      state.autoRun.pendingKey = "";
      state.autoRun.attempts = 0;
      sendResponse({ ok: true, stopped: true, run: { ...state.run } });
      return false;
    }

    if (type === "PV_APPLICANT_STATUS") {
      sendResponse({ ok: true, buildId: BUILD_ID, run: { ...state.run }, rows: applicantRows().length });
      return false;
    }

    if (type === "PV_APPLICANT_EXTRACT") {
      beginRun();
      if (!state.extracting) {
        state.extracting = extractApplicant(message.options || {}).finally(() => { state.extracting = null; });
      }
      state.extracting
        .then(({ record, diagnostics }) => sendResponse({ ok: true, record, diagnostics, buildId: BUILD_ID }))
        .catch((error) => sendResponse({
          ok: false,
          hidden: Boolean(error?.hidden),
          stopped: Boolean(error?.stopped),
          error: error instanceof Error ? error.message : String(error),
          challenge: error?.challenge || currentChallenge(),
          buildId: BUILD_ID
        }));
      return true;
    }

    if (type === "PV_APPLICANT_EXTRACT_ALL") {
      // Pressed on purpose, so a Stop from earlier in this page's life is over —
      // and this press supersedes any arrival still waiting to be acted on.
      state.autoRun.disabled = false;
      state.autoRun.lastKey = applicantsPageKey(location.href);
      state.autoRun.pendingKey = "";
      state.autoRun.attempts = 0;
      // A deliberate press always runs, including over a view this document has
      // already completed, or one whose tab-return restarts were quietened for
      // achieving nothing — that is the recruiter asking for it again.
      state.autoRun.ranKey = "";
      state.autoRun.returnKey = "";
      state.autoRun.fruitlessReturns = 0;
      state.autoRun.quietedReturns = false;
      // A second press while a run is genuinely in flight is answered at once
      // rather than left hanging on the first run's promise for up to an hour.
      if (state.running) {
        sendResponse({ ok: true, alreadyRunning: true, run: { ...state.run }, buildId: BUILD_ID });
        return false;
      }
      state.running = runEveryApplicant(message.options || {}, message.tracking || null)
        .finally(() => { state.running = null; });
      state.running
        .then((result) => sendResponse({ ok: true, ...result, buildId: BUILD_ID }))
        .catch((error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          buildId: BUILD_ID
        }));
      return true;
    }

    return false;
  };

  chrome.runtime.onMessage.addListener(state.handler);

  // ------------------------------------------------------- watching the route
  // The hiring surface is a single-page app: LinkedIn swaps the applicant, and
  // whole views, without a navigation. So the diagnostics of the previous
  // applicant must not be reported as this one's — and a route back to a job the
  // recruiter asked to collect is the moment that run starts again.
  //
  // 3.7.6 watched with a poller alone, which is why the restart worked after F5
  // and not otherwise: a poller only ever samples, and everything below is here
  // because a sample can miss the thing it is sampling for.
  //
  // **`history.pushState` cannot be hooked from here.** A content script runs in
  // an isolated world with its own `history`, so patching `pushState` in this
  // script would never see LinkedIn's own call to it. What IS observable from
  // here is the re-render that always follows a route change, so the DOM is
  // watched and the address re-read whenever it moves.

  /** Long enough that a burst of re-render costs one check, short enough to feel instant. */
  const ROUTE_SETTLE_MS = 120;

  function onRouteChanged() {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    state.lastDiagnostics = null;
    checkAutoRunArrival();
  }

  let routeCheckScheduled = false;
  state.routeObserver = new MutationObserver(() => {
    // Deliberately the cheapest possible callback on a page that mutates
    // constantly: one boolean, then out. The address is only read on the timer.
    if (routeCheckScheduled) return;
    routeCheckScheduled = true;
    setTimeout(() => {
      routeCheckScheduled = false;
      onRouteChanged();
    }, ROUTE_SETTLE_MS);
  });
  state.routeObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Back and forward. Browser-dispatched, so an isolated world does receive it.
  state.navigationHandler = () => onRouteChanged();
  window.addEventListener("popstate", state.navigationHandler);
  window.addEventListener("hashchange", state.navigationHandler);

  /**
   * Restored from the back/forward cache.
   *
   * This is the case a poller can never see, and the one the recruiter reported:
   * the document is the *same* document, so `state.autoRun.lastKey` comes back
   * still holding the job it was showing when it was frozen, and the arrival is
   * suppressed as "we are already here". Only a reload cleared it — which is
   * exactly the workaround that was being used.
   *
   * `wentHidden` matters just as much: freezing a document fires
   * `visibilitychange`, which latches it, and `assertRunnable()` then throws
   * "the applicants page is hidden" before a single row is read. A restored page
   * is being looked at, so it is re-derived from what the page is right now —
   * the same discipline `beginRun()` applies, for the same reason.
   */
  state.pageShowHandler = (event) => {
    if (!event?.persisted) return;
    clearHiddenLatchIfVisible();
    state.autoRun.lastKey = "";
    state.lastUrl = location.href;
    checkAutoRunArrival();
  };
  window.addEventListener("pageshow", state.pageShowHandler);

  // The backstop, and the only watcher that retries an arrival which has not
  // been fulfilled yet — a list that had not mounted, a worker that was asleep.
  state.urlTimer = setInterval(() => {
    onRouteChanged();
    pumpAutoRun();
  }, 800);

  // And once now, because a full page load re-injects this script with no
  // history at all: from its side, arriving is the only thing that happened.
  checkAutoRunArrival();
})();
