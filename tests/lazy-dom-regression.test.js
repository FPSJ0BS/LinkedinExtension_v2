// Regression coverage for the two live LinkedIn failures:
//
//   1. Connections discovery stopped after the first ~10 rendered cards.
//   2. Profile extraction saved a profile that had never been scrolled through.
//
// Both had the same root cause: the code decided where "the bottom" was from
// `window.scrollY` / `document.scrollingElement` (plus, on the connections page, a
// scrollable *descendant* of the list). LinkedIn's scaffold layout scrolls a
// wrapper that is an *ancestor* of the list, so the real scroll range was never
// found, `maxScrollTop()` collapsed to 0, the very first read looked like the
// bottom of the list, and the scan settled immediately.
//
// There is no jsdom in this repo, so the page mechanics live in the pure cores
// and are exercised here against simulated virtualized pages. The content scripts
// are thin adapters; source-level assertions below prove they still call these
// functions rather than re-implementing the policy.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

await import("../src/connections-core.js");
await import("../src/extraction-core.js");
import * as Queue from "../src/import-queue-core.js";

const Connections = globalThis.ProfileVaultConnections;
const Extraction = globalThis.ProfileVaultCore;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BASE = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

function people(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    href: `/in/person-${index + offset + 1}/`,
    text: `Person ${index + offset + 1}\n· 1st\nSenior Engineer at Acme`
  }));
}

// ---------------------------------------------------------------------------
// A simulated connections page.
//
// It models the three things that broke live: the page scrolls an element that
// is not the document, only a window of rows is ever in the DOM, and more rows
// only arrive once the sentinel at the bottom is reached.
// ---------------------------------------------------------------------------

function makeConnectionsPage(all, options = {}) {
  const {
    initial = 10,
    chunk = 10,
    rowHeight = 120,
    viewport = 900,
    windowRows = 12,
    mode = "infinite",
    pageSize = 50,
    // "document"  – the page itself scrolls (the easy layout)
    // "wrapper"   – an ancestor of the list scrolls, body is height:100vh (live)
    // "list"      – the list container itself scrolls
    layout = "wrapper",
    virtualize = true
  } = options;

  const trueScroller = layout === "document" ? "scrollingElement" : layout === "list" ? "listRoot" : "wrapper";
  const state = {
    loaded: Math.min(initial, all.length),
    limit: mode === "paginated" ? Math.min(pageSize, all.length) : all.length,
    top: 0,
    mutations: 0
  };

  const contentHeight = () => Math.max(viewport, state.loaded * rowHeight);
  const maxTop = () => Math.max(0, contentHeight() - viewport);
  const usable = (target) => Boolean(target) && target.id === trueScroller;

  function loadMore() {
    // In paginated mode scrolling still reveals the rest of the current page;
    // only crossing into the next page needs the allowlisted control.
    const ceiling = Math.min(state.limit, all.length);
    if (state.loaded >= ceiling) return false;
    state.loaded = Math.min(state.loaded + chunk, ceiling);
    state.mutations += 1;
    return true;
  }

  return {
    get mutations() { return state.mutations; },
    get loaded() { return state.loaded; },

    /** What `document.scrollingElement` and every candidate container look like. */
    candidates() {
      const documentScrolls = layout === "document";
      const list = [
        {
          id: "scrollingElement",
          isScrollingElement: true,
          overflowY: documentScrolls ? "visible" : "hidden",
          scrollHeight: documentScrolls ? contentHeight() : viewport,
          clientHeight: viewport,
          containsList: true,
          depth: 0
        },
        {
          id: "wrapper",
          overflowY: layout === "wrapper" ? "auto" : "visible",
          scrollHeight: layout === "wrapper" ? contentHeight() : viewport,
          clientHeight: viewport,
          containsList: true,
          depth: 2
        },
        {
          id: "listRoot",
          overflowY: layout === "list" ? "auto" : "visible",
          scrollHeight: contentHeight(),
          clientHeight: layout === "list" ? viewport : contentHeight(),
          containsList: true,
          depth: 4
        },
        // The decoy that the old descendant-only heuristic latched onto: a tall
        // scrollable filter panel *inside* the list root that scrolls nothing.
        {
          id: "filterDropdown",
          overflowY: "auto",
          scrollHeight: 4000,
          clientHeight: 200,
          containsList: false,
          depth: 6
        }
      ];
      return list;
    },

    /**
     * Only the rows LinkedIn currently has in the DOM: the rows covering the
     * viewport plus a small buffer either side. Anything else has been recycled.
     */
    rendered() {
      const loadedRows = all.slice(0, state.loaded);
      if (!virtualize) return loadedRows;
      const span = Math.max(windowRows, Math.ceil(viewport / rowHeight) + 2);
      const first = Math.max(0, Math.floor(state.top / rowHeight) - 1);
      return loadedRows.slice(first, first + span);
    },

    atBottom(target) {
      if (!usable(target)) return true; // a page that never moves always looks finished
      return state.top >= maxTop() - 8;
    },

    scrollTop(target) {
      return usable(target) ? state.top : 0;
    },

    scrollTo(target, top) {
      if (!usable(target)) return;
      state.top = Math.max(0, Math.min(Number(top) || 0, maxTop()));
      state.mutations += 1;
      if (state.top >= maxTop() - 8) loadMore();
    },

    step(target) {
      this.scrollTo(target, this.scrollTop(target) + Math.round(viewport * 0.8));
    },

    /** Waiting at the bottom: the sentinel fires and the next slice arrives. */
    settle(target) {
      if (!usable(target)) return false;
      state.top = maxTop();
      return loadMore();
    },

    paginationAvailable() {
      return mode === "paginated" && state.limit < all.length;
    },

    paginate() {
      state.limit = Math.min(state.limit + pageSize, all.length);
      state.loaded = Math.min(state.loaded + chunk, state.limit);
      state.mutations += 1;
    }
  };
}

/** The old rule: the tallest scrollable element inside the list root wins. */
function legacyInnerScroller(candidates) {
  return candidates
    .filter((candidate) => candidate.depth > 3 && /auto|scroll/.test(candidate.overflowY))
    .filter((candidate) => candidate.scrollHeight > candidate.clientHeight + 40)
    .sort((left, right) => right.scrollHeight - left.scrollHeight)[0] || null;
}

/**
 * Run the real discovery policy over a simulated page.
 *
 * This mirrors connections.js exactly: pick the scroll target, read every
 * rendered card, merge into the cumulative collector, ask the planner what to do
 * next, and never replace the accumulator with the current batch.
 */
function discover(page, options = {}) {
  const { maxSteps = 4000, chooseTarget = Connections.chooseScrollTarget, cursor = 0, collector: given } = options;
  const collector = given || Connections.createEntryCollector(BASE);
  const target = chooseTarget(page.candidates());

  const diagnostics = {
    scrollTarget: target?.id || "",
    scans: 0,
    newUrls: 0,
    quietScans: 0,
    paginationClicks: 0,
    mutations: 0,
    stopReason: ""
  };

  if (cursor) page.scrollTo(target, cursor);

  const scan = () => {
    diagnostics.scans += 1;
    const before = collector.size;
    // Every rendered card at this position, merged into what is already known.
    collector.absorb(page.rendered());
    const added = collector.size - before;
    diagnostics.newUrls += added;
    diagnostics.quietScans = added ? 0 : diagnostics.quietScans + 1;
    return added;
  };

  scan();
  let idleAtBottom = 0;
  let grew = false;
  let steps = 0;

  for (;;) {
    const plan = Connections.planDiscoveryStep({
      atBottom: page.atBottom(target),
      grew,
      idleAtBottom,
      paginationAvailable: page.paginationAvailable(),
      steps,
      maxSteps
    });
    idleAtBottom = plan.idleAtBottom;

    if (plan.action === Connections.DISCOVERY_ACTION.DONE) {
      diagnostics.stopReason = plan.reason;
      diagnostics.mutations = page.mutations;
      return { collector, diagnostics, exhausted: plan.exhausted, cursor: page.scrollTop(target), target };
    }

    if (plan.action === Connections.DISCOVERY_ACTION.SCROLL) page.step(target);
    else if (plan.action === Connections.DISCOVERY_ACTION.PAGINATE) {
      page.paginate();
      diagnostics.paginationClicks += 1;
    } else page.settle(target);

    steps += 1;
    grew = scan() > 0;
  }
}

// ===========================================================================
// A. Connection-list discovery
// ===========================================================================

test("the scroll container is found when LinkedIn scrolls a wrapper above the list", () => {
  const page = makeConnectionsPage(people(35));
  const chosen = Connections.chooseScrollTarget(page.candidates());

  assert.ok(chosen, "a scrollable container must be found on the live scaffold layout");
  assert.equal(chosen.id, "wrapper", "the ancestor wrapper that actually scrolls must win");
});

test("a tall scrollable panel that does not contain the list is never used as the scroller", () => {
  const page = makeConnectionsPage(people(35));
  assert.equal(
    legacyInnerScroller(page.candidates())?.id,
    "filterDropdown",
    "this is the decoy the old descendant-only heuristic picked"
  );
  assert.notEqual(
    Connections.chooseScrollTarget(page.candidates()).id,
    "filterDropdown",
    "a container that does not hold the list must never be scrolled"
  );
});

test("the document scroller is used when the page itself scrolls", () => {
  const page = makeConnectionsPage(people(35), { layout: "document" });
  assert.equal(Connections.chooseScrollTarget(page.candidates()).id, "scrollingElement");
});

test("a list container that scrolls itself is detected", () => {
  const page = makeConnectionsPage(people(35), { layout: "list" });
  assert.equal(Connections.chooseScrollTarget(page.candidates()).id, "listRoot");
});

test("a page with nothing scrollable yields no target instead of a wrong one", () => {
  assert.equal(Connections.chooseScrollTarget([
    { id: "scrollingElement", isScrollingElement: true, overflowY: "visible", scrollHeight: 900, clientHeight: 900, containsList: true, depth: 0 }
  ]), null);
  assert.equal(Connections.chooseScrollTarget([]), null);
});

test("10 initially visible connections plus 25 loaded while scrolling are all discovered", () => {
  const page = makeConnectionsPage(people(35), { initial: 10, chunk: 5 });
  const run = discover(page);

  assert.equal(run.collector.size, 35, "all 35 connections must be discovered, not the first 10");
  assert.equal(run.exhausted, true);
  assert.equal(run.diagnostics.paginationClicks, 0, "an infinite-scroll list needs no clicks");
});

test("the old descendant-only scroll heuristic is what limited discovery to the first slice", () => {
  const page = makeConnectionsPage(people(35), { initial: 10, chunk: 5 });
  const run = discover(page, { chooseTarget: legacyInnerScroller });

  assert.ok(
    run.collector.size <= 12,
    `scrolling the wrong element must reproduce the live symptom, found ${run.collector.size}`
  );
});

test("a 35-connection virtualized list keeps the cards LinkedIn removed from the DOM", () => {
  const page = makeConnectionsPage(people(35), { initial: 10, chunk: 5, rowHeight: 120, viewport: 600 });
  const run = discover(page);

  assert.equal(run.collector.size, 35, "every connection must survive virtualization");
  assert.ok(page.rendered().length < 35, "the page must genuinely have recycled its cards");
  const urls = run.collector.urls();
  assert.ok(urls.includes("https://www.linkedin.com/in/person-1"), "the very first card must not be lost");
  assert.ok(urls.includes("https://www.linkedin.com/in/person-35"), "the very last card must be found");
  assert.equal(new Set(urls).size, 35, "no duplicates may accumulate");
});

test("a Load more control is used to reach every page of a paginated list", () => {
  const page = makeConnectionsPage(people(137), { mode: "paginated", pageSize: 50, chunk: 10 });
  const run = discover(page);

  assert.equal(run.collector.size, 137, "every page must be enumerated");
  assert.equal(run.diagnostics.paginationClicks, 2, "137 connections at 50 per page needs two clicks");
  assert.equal(run.exhausted, true);
});

test("a Next-page control is followed across several Connections pages", () => {
  // 120 connections behind a Next control that reveals 40 at a time.
  const page = makeConnectionsPage(people(120), { mode: "paginated", pageSize: 40, chunk: 10 });
  const run = discover(page);

  assert.equal(run.collector.size, 120, "every page behind the Next control must be reached");
  assert.equal(run.diagnostics.paginationClicks, 2, "120 connections at 40 per page needs two Next clicks");
  assert.equal(Connections.classifyControl({ text: "Next", inConnectionsList: true }).reason, "pagination");
});

test("only allowlisted Load more / Next controls may ever be clicked", () => {
  const allowed = ["Load more", "Load more results", "Show more results", "Next", "Next page"];
  for (const label of allowed) {
    assert.equal(
      Connections.classifyControl({ text: label, inConnectionsList: true }).allowed,
      true,
      `${label} must be usable pagination`
    );
  }
  // "Contact info" is deliberately absent: since 3.5.0 it is the one other
  // clickable control, on profile pages only. It is still never clickable in the
  // connections list, which the next assertion pins down.
  const forbidden = [
    "Connect", "Follow", "Message", "InMail", "Remove connection",
    "Endorse", "Withdraw", "Invite", "Report", "Block", "Send", "Share", "Save", "Accept", "Ignore"
  ];
  for (const label of forbidden) {
    const verdict = Connections.classifyControl({ text: label, inConnectionsList: true });
    assert.equal(verdict.allowed, false, `${label} must never be clicked`);
    assert.equal(verdict.forbidden, true, `${label} must be denylisted, not merely unlisted`);
  }
  assert.equal(
    Connections.classifyControl({ text: "Contact info", inConnectionsList: true }).allowed,
    false,
    "the contact control is never clicked to reveal more connections"
  );
  // The denylist beats the allowlist even when a control is dressed up as paging.
  assert.equal(
    Connections.classifyControl({ text: "Load more", ariaLabel: "Connect with Asha Rao", inConnectionsList: true }).allowed,
    false,
    "a forbidden aria-label must disqualify an otherwise allowlisted label"
  );
});

test("discovery finishes only after five consecutive scans find nothing new", () => {
  const quiet = (idleAtBottom) => Connections.planDiscoveryStep({
    atBottom: true, grew: false, idleAtBottom, paginationAvailable: false
  });
  for (let idle = 0; idle < Connections.DISCOVERY_QUIET_SCANS - 1; idle += 1) {
    assert.equal(quiet(idle).action, Connections.DISCOVERY_ACTION.WAIT_GROWTH, `scan ${idle + 1} must keep waiting`);
  }
  const finished = quiet(Connections.DISCOVERY_QUIET_SCANS - 1);
  assert.equal(finished.action, Connections.DISCOVERY_ACTION.DONE);
  assert.equal(finished.exhausted, true);
  assert.ok(Connections.DISCOVERY_QUIET_SCANS >= 5, "the requirement is at least five quiet scans");
});

test("a remaining pagination control prevents discovery from finishing", () => {
  const plan = Connections.planDiscoveryStep({
    atBottom: true, grew: false, idleAtBottom: Connections.DISCOVERY_QUIET_SCANS + 3, paginationAvailable: true
  });
  assert.equal(plan.action, Connections.DISCOVERY_ACTION.PAGINATE, "an available control must be used, never skipped");
  assert.equal(plan.exhausted, false);
});

test("duplicate profile URLs and non-profile links never enter the discovered list", () => {
  const collector = Connections.createEntryCollector(BASE);
  collector.absorb([
    { href: "/in/asha-rao/", text: "" },
    { href: "https://www.linkedin.com/in/asha-rao?miniProfileUrn=x", text: "Asha Rao · 1st" },
    { href: "/in/asha-rao/details/skills/", text: "Asha Rao" },
    { href: "https://in.linkedin.com/in/asha-rao/", text: "Asha Rao" },
    { href: "/company/acme/", text: "Acme" },
    { href: "/school/example-university/", text: "Example University" },
    { href: "/feed/update/12345/", text: "A post" },
    { href: "/mynetwork/invite-connect/connections/", text: "Connections" },
    { href: "/in/me", text: "Me" },
    { href: "mailto:someone@example.com", text: "Email" },
    { href: "/in/bo-chen/", text: "Bo Chen" }
  ]);

  assert.deepEqual(collector.urls(), [
    "https://www.linkedin.com/in/asha-rao",
    "https://www.linkedin.com/in/bo-chen"
  ]);
});

test("the accumulator is never replaced by the currently rendered batch", () => {
  const collector = Connections.createEntryCollector(BASE);
  collector.absorb(people(10));
  collector.absorb(people(10, 10));
  // LinkedIn recycles back to the top of the list: only the first rows render.
  collector.absorb(people(3));
  assert.equal(collector.size, 20, "a later scan showing fewer cards must not shrink the list");
  collector.absorb(people(15, 20));
  assert.equal(collector.size, 35);
});

test("discovery resumes from its persisted cursor after an interruption", () => {
  const all = people(60);
  const page = makeConnectionsPage(all, { initial: 10, chunk: 5 });

  // Pass one is cut short — a tab reload, a suspended worker, a closed popup.
  const first = discover(page, { maxSteps: 6 });
  assert.ok(first.collector.size > 0 && first.collector.size < 60, "the interrupted pass must have found some, not all");

  // Only what was persisted survives; the cursor comes back from the session.
  let state = { items: Queue.enqueueUrls([], first.collector.entries(), "t0").items, session: Queue.createSession() };
  state.session = { ...state.session, discovery: Queue.applyDiscoveryPass(state.session, { ...first.diagnostics, cursorY: first.cursor, atBottom: false }, state.items.length, "t0") };
  assert.equal(state.session.discovery.cursorY, first.cursor, "the cursor must be persisted with the session");

  // A brand-new collector, exactly as a fresh content script would start.
  const resumed = discover(page, { cursor: state.session.discovery.cursorY });
  const merged = Queue.enqueueUrls(state.items, resumed.collector.entries(), "t1");

  assert.equal(merged.items.length, 60, "resuming must complete the list, not restart it");
  assert.ok(merged.duplicates > 0, "the resumed pass must re-see rows that were already saved");
  assert.equal(new Set(merged.items.map((item) => item.url)).size, 60);
});

test("new connections are persisted as they are found, not only at the end", () => {
  const all = people(40);
  const page = makeConnectionsPage(all, { initial: 10, chunk: 5 });
  const collector = Connections.createEntryCollector(BASE);

  // The content script streams progress; the worker folds each batch into the
  // queue. Interrupting after any batch must leave that batch saved.
  let items = [];
  const writes = [];
  for (let slice = 0; slice < 12; slice += 1) {
    discover(page, { maxSteps: 3, collector });
    const enqueued = Queue.enqueueUrls(items, collector.entries(), `t${slice}`);
    items = enqueued.items;
    writes.push(items.length);
    if (items.length >= 40) break;
  }

  assert.ok(writes.length > 1, "discovery must write more than once");
  assert.ok(writes[0] > 0 && writes[0] < 40, "the first write must land long before the list is complete");
  assert.equal(items.length, 40);
  assert.ok(writes.every((count, index) => index === 0 || count >= writes[index - 1]), "a write must never shrink the saved list");
});

test("the React list pages through every discovered connection regardless of LinkedIn's page size", () => {
  const discovered = Array.from({ length: 137 }, (_, index) =>
    Queue.createItem(`https://www.linkedin.com/in/person-${index + 1}`, "t0", `Person ${index + 1}`));

  for (const size of Queue.PAGE_SIZES) {
    const seen = new Set();
    const pages = Queue.pageCount(discovered.length, size);
    for (let page = 1; page <= pages; page += 1) {
      for (const row of Queue.paginate(discovered, page, size).rows) seen.add(row.url);
    }
    assert.equal(seen.size, 137, `${size} rows per page must still show all 137 connections`);
  }

  const view = Queue.paginate(discovered, 1, 25);
  assert.equal(view.total, 137, "the total must reflect everything discovered, not one LinkedIn page");
  assert.equal(view.pages, 6);
});

// ===========================================================================
// B. Profile extraction
// ===========================================================================

/**
 * A simulated profile page.
 *
 * Sections mount when their offset comes near the viewport and unmount once the
 * viewport has moved well past them, which is what made data disappear from the
 * final record even though it had been on screen.
 */
function makeProfilePage(sections, options = {}) {
  const { viewport = 900, height = 7000, layout = "wrapper", keepAlive = 1400 } = options;
  const trueScroller = layout === "document" ? "scrollingElement" : "wrapper";
  const state = { top: 0, mutations: 0 };

  const usable = (target) => Boolean(target) && target.id === trueScroller;

  return {
    get mutations() { return state.mutations; },
    candidates() {
      const documentScrolls = layout === "document";
      return [
        {
          id: "scrollingElement",
          isScrollingElement: true,
          overflowY: documentScrolls ? "visible" : "hidden",
          scrollHeight: documentScrolls ? height : viewport,
          clientHeight: viewport,
          containsList: true,
          depth: 0
        },
        {
          id: "wrapper",
          overflowY: layout === "wrapper" ? "auto" : "visible",
          scrollHeight: layout === "wrapper" ? height : viewport,
          clientHeight: viewport,
          containsList: true,
          depth: 2
        },
        { id: "profileRoot", overflowY: "visible", scrollHeight: height, clientHeight: height, containsList: true, depth: 3 }
      ];
    },
    max: (target) => (usable(target) ? Math.max(0, height - viewport) : 0),
    top: (target) => (usable(target) ? state.top : 0),
    scrollTo(target, top) {
      if (!usable(target)) return;
      state.top = Math.max(0, Math.min(Number(top) || 0, Math.max(0, height - viewport)));
      state.mutations += 1;
    },
    /** Only the sections currently mounted in the DOM. */
    rendered() {
      return sections.filter((section) => {
        const top = section.offset;
        const bottom = section.offset + (section.height || 600);
        return bottom >= state.top - keepAlive && top <= state.top + viewport + keepAlive;
      });
    },
    viewport
  };
}

function runProfileScan(page, accumulator, options = {}) {
  const { chooseTarget = Connections.chooseScrollTarget } = options;
  const target = chooseTarget(page.candidates());
  const originalTop = page.top(target);
  const diagnostics = { scrollTarget: target?.id || "", scans: 0, stopReason: "", mutations: 0 };
  let scan = Extraction.createScanState();

  const read = () => {
    diagnostics.scans += 1;
    for (const section of page.rendered()) {
      if (section.kind === "experience") accumulator.addExperience(section.value);
      else if (section.kind === "education") accumulator.addEducation(section.value);
      else if (section.kind === "skill") accumulator.addSkill(section.value);
      else if (section.kind === "certification") accumulator.addCertification(section.value);
      else if (section.kind === "language") accumulator.addLanguage(section.value);
      else if (section.kind === "about") accumulator.addAbout(section.value);
      else if (section.kind === "identity") accumulator.addIdentity(section.value);
    }
  };

  try {
    page.scrollTo(target, 0);
    read();
    for (let guard = 0; guard < 600; guard += 1) {
      scan = Extraction.nextScanStep(scan, {
        position: page.top(target),
        maxPosition: page.max(target),
        viewportHeight: page.viewport,
        signature: accumulator.signature()
      });
      if (scan.done) {
        diagnostics.stopReason = scan.reason;
        break;
      }
      page.scrollTo(target, scan.position);
      read();
    }
  } finally {
    page.scrollTo(target, originalTop);
    diagnostics.mutations = page.mutations;
  }
  return { scan, diagnostics, restoredTo: page.top(target) };
}

function experience(offset, patch) {
  return { kind: "experience", offset, height: 400, value: patch };
}

test("profile sections that render only after scrolling are all captured", () => {
  const sections = [
    { kind: "identity", offset: 0, height: 400, value: { name: "Asha Rao", headline: "CTO at Acme", location: "Jaipur, India", score: 30 } },
    { kind: "about", offset: 500, height: 300, value: "Builds developer platforms." },
    experience(1200, { title: "CTO", company: "Acme", companyUrl: "https://www.linkedin.com/company/acme", dateRange: "Jan 2023 - Present" }),
    experience(1700, { title: "Head of Engineering", company: "Acme", companyUrl: "https://www.linkedin.com/company/acme", dateRange: "Jan 2021 - Dec 2022" }),
    { kind: "education", offset: 2800, height: 400, value: { institution: "Example University", degree: "BSc", dates: "2015 - 2019" } },
    { kind: "skill", offset: 3800, height: 200, value: "TypeScript" },
    { kind: "skill", offset: 4000, height: 200, value: "Kubernetes" },
    { kind: "certification", offset: 5000, height: 200, value: { name: "CKA", issuer: "CNCF", date: "Issued Mar 2022" } },
    { kind: "language", offset: 6200, height: 200, value: "English" }
  ];
  const page = makeProfilePage(sections);
  const accumulator = Extraction.createProfileAccumulator();
  const run = runProfileScan(page, accumulator);

  assert.equal(run.diagnostics.scrollTarget, "wrapper", "the profile scroll container must be detected");
  assert.equal(run.scan.reason, "settled");
  assert.equal(accumulator.counts().experience, 2, "both roles must be captured");
  assert.equal(accumulator.counts().education, 1);
  assert.equal(accumulator.counts().skills, 2, "skills render far below the fold");
  assert.equal(accumulator.counts().certifications, 1);
  assert.equal(accumulator.counts().languages, 1);
  assert.equal(accumulator.about, "Builds developer platforms.");
  assert.equal(accumulator.identity.name, "Asha Rao");
});

test("without a real scroll target the profile scan saves only the top of the page", () => {
  const sections = [
    { kind: "identity", offset: 0, height: 400, value: { name: "Asha Rao", headline: "CTO", location: "Jaipur, India", score: 30 } },
    { kind: "skill", offset: 4000, height: 200, value: "Kubernetes" }
  ];
  const page = makeProfilePage(sections);
  const accumulator = Extraction.createProfileAccumulator();
  runProfileScan(page, accumulator, { chooseTarget: () => null });

  assert.equal(accumulator.counts().skills, 0, "this is the live bug being fixed");
});

test("profile sections unmounted by later scrolling stay in the saved record", () => {
  const sections = [
    { kind: "identity", offset: 0, height: 300, value: { name: "Bo Chen", headline: "Analyst", location: "Pune, India", score: 30 } },
    experience(400, { title: "Analyst", company: "Northwind", dateRange: "Jan 2019 - Dec 2020" }),
    { kind: "skill", offset: 6000, height: 200, value: "SQL" }
  ];
  const page = makeProfilePage(sections, { keepAlive: 200 });
  const accumulator = Extraction.createProfileAccumulator();
  runProfileScan(page, accumulator);

  // At the bottom, where the scan finished collecting, the early section is gone.
  const target = Connections.chooseScrollTarget(page.candidates());
  page.scrollTo(target, page.max(target));
  assert.equal(page.rendered().some((section) => section.kind === "experience"), false, "the early section must really be unmounted");
  assert.equal(accumulator.counts().experience, 1, "an unmounted section must survive in the accumulator");
  assert.equal(accumulator.counts().skills, 1);
});

test("roles at one company group into a single card and education groups per institution", () => {
  const accumulator = Extraction.createProfileAccumulator();
  accumulator.addExperience({ title: "CTO", company: "Acme Systems Pvt. Ltd.", companyUrl: "https://www.linkedin.com/company/acme", dateRange: "Jan 2023 - Present" });
  accumulator.addExperience({ title: "Head of Engineering", company: "Acme Systems", companyUrl: "https://www.linkedin.com/company/acme", dateRange: "Jan 2021 - Dec 2022" });
  accumulator.addExperience({ title: "Analyst", company: "Northwind", dateRange: "Jan 2019 - Dec 2020" });
  accumulator.addEducation({ institution: "Example University", degree: "MSc", dates: "2019 - 2021" });
  accumulator.addEducation({ institution: "Example University", degree: "BSc", dates: "2015 - 2019" });
  accumulator.addEducation({ institution: "Second College", degree: "Diploma", dates: "2013 - 2015" });

  const groups = Extraction.groupExperienceByCompany(accumulator.experience());
  assert.equal(groups.length, 2, "one card per company");
  assert.equal(groups[0].roles.length, 2, "both Acme roles nest inside the Acme card");

  // Since 3.6.0 the record stores the institution name and nothing else. The
  // degree and dates are still parsed — they are what tells two cards for the
  // same school apart while the page hydrates — they are simply not stored.
  const education = accumulator.education();
  assert.deepEqual(education, ["Example University", "Second College"], "one entry per institution, named");
});

test("education keeps unique institution names in the order the page rendered them", () => {
  const accumulator = Extraction.createProfileAccumulator();
  for (const record of [
    { institution: "Poornima Institute of Engineering & Technology", degree: "B.Tech", dates: "2024 - 2028" },
    { institution: "Kendriya Vidyalaya", degree: "Class XII", dates: "2022 - 2024" },
    // The same school read again as the page hydrates, and a near-duplicate.
    { institution: "Poornima Institute of Engineering & Technology", degree: "B.Tech", dates: "2024 - 2028" },
    { institution: "poornima institute of engineering & technology", degree: "", dates: "" }
  ]) accumulator.addEducation(record);

  assert.deepEqual(
    accumulator.education(),
    ["Poornima Institute of Engineering & Technology", "Kendriya Vidyalaya"],
    "deduplicated, case-insensitively, in visible order"
  );
});

test("entity dedup keys are exactly the ones the requirement specifies", () => {
  // Experience: canonical company URL + normalized title + visible date range.
  const base = { title: "Senior Engineer", company: "Acme", companyUrl: "https://www.linkedin.com/company/acme", dateRange: "Jan 2023 - Present" };
  assert.equal(
    Extraction.experienceKey(base),
    Extraction.experienceKey({ ...base, title: "  senior   ENGINEER ", company: "Acme Systems Pvt Ltd" }),
    "title casing/spacing and the company label must not split one role in two"
  );
  assert.notEqual(Extraction.experienceKey(base), Extraction.experienceKey({ ...base, dateRange: "Jan 2021 - Dec 2022" }));
  assert.notEqual(
    Extraction.experienceKey(base),
    Extraction.experienceKey({ ...base, companyUrl: "https://www.linkedin.com/company/northwind" })
  );

  // Education: normalized institution + normalized degree + visible date range.
  const school = { institution: "Example University", degree: "BSc", dates: "2015 - 2019" };
  assert.equal(Extraction.educationKey(school), Extraction.educationKey({ institution: " example  UNIVERSITY ", degree: "b.sc", dates: "2015 - 2019" }));
  assert.notEqual(Extraction.educationKey(school), Extraction.educationKey({ ...school, dates: "2019 - 2021" }));

  // Skills: lowercase normalized name.
  assert.equal(Extraction.skillKey("  TypeScript "), Extraction.skillKey("typescript"));
  assert.notEqual(Extraction.skillKey("TypeScript"), Extraction.skillKey("JavaScript"));

  // Certifications: name + issuer + issue date.
  const cert = { name: "CKA", issuer: "CNCF", date: "Issued Mar 2022" };
  assert.equal(Extraction.certificationKey(cert), Extraction.certificationKey({ name: " cka ", issuer: "cncf", date: "issued mar 2022" }));
  assert.notEqual(Extraction.certificationKey(cert), Extraction.certificationKey({ ...cert, issuer: "Linux Foundation" }));
});

test("a later, fuller read of the same entity enriches it instead of being discarded", () => {
  const accumulator = Extraction.createProfileAccumulator();
  // The first read happens before the company logo and link have hydrated.
  accumulator.addExperience({ title: "Senior Engineer", company: "Acme", dateRange: "Jan 2023 - Present" });
  accumulator.addExperience({
    title: "Senior Engineer",
    company: "Acme Systems Pvt. Ltd.",
    companyUrl: "https://www.linkedin.com/company/acme",
    dateRange: "Jan 2023 - Present",
    location: "Jaipur, India",
    description: "Runs the platform team."
  });

  const records = accumulator.experience();
  assert.equal(records.length, 1, "the same role must not be stored twice");
  assert.equal(records[0].companyUrl, "https://www.linkedin.com/company/acme", "a value that arrived late must be kept");
  assert.equal(records[0].location, "Jaipur, India");
  assert.equal(records[0].description, "Runs the platform team.");
});

test("a missing value stays empty and is never guessed", () => {
  const accumulator = Extraction.createProfileAccumulator();
  accumulator.addExperience({ title: "Engineer", company: "Acme", dateRange: "2020 - 2022" });
  const record = accumulator.experience()[0];
  assert.equal(record.location, "", "an absent location must stay empty");
  assert.equal(record.description, "");
  assert.equal(accumulator.about, "");
  assert.equal(accumulator.identity.headline, "");
});

test("the profile is only complete after the bottom stops producing new entities for five scans", () => {
  assert.ok(Extraction.PROFILE_SCAN.QUIET_PASSES >= 5, "the requirement is at least five quiet scans");

  let scan = Extraction.createScanState();
  // Mid-page quiet never finishes the scan.
  for (let pass = 0; pass < 8; pass += 1) {
    scan = Extraction.nextScanStep(scan, { position: 900, maxPosition: 7000, viewportHeight: 900, signature: "same" });
    assert.equal(scan.done, false, "a still page part-way down must never end the scan");
  }
  // Arriving at the bottom with new content restarts the count.
  scan = Extraction.nextScanStep(scan, { position: 7000, maxPosition: 7000, viewportHeight: 900, signature: "new" });
  assert.equal(scan.done, false);
  for (let pass = 0; pass < Extraction.PROFILE_SCAN.QUIET_PASSES - 1; pass += 1) {
    scan = Extraction.nextScanStep(scan, { position: 7000, maxPosition: 7000, viewportHeight: 900, signature: "new" });
    assert.equal(scan.done, false, `quiet scan ${pass + 1} at the bottom is not enough`);
  }
  scan = Extraction.nextScanStep(scan, { position: 7000, maxPosition: 7000, viewportHeight: 900, signature: "new" });
  assert.equal(scan.done, true);
  assert.equal(scan.reason, "settled");
});

test("the scroll position is restored even when extraction throws", () => {
  const page = makeProfilePage([{ kind: "identity", offset: 0, height: 300, value: { name: "Cara Diaz", score: 30 } }]);
  const target = Connections.chooseScrollTarget(page.candidates());
  page.scrollTo(target, 2400);

  assert.throws(() => {
    try {
      page.scrollTo(target, 5000);
      throw new Error("LinkedIn showed a checkpoint mid-scan.");
    } finally {
      page.scrollTo(target, 2400);
    }
  }, /checkpoint/);
  assert.equal(page.top(target), 2400, "the user's scroll position must come back on the failure path");
});

// ===========================================================================
// C. Diagnostics
// ===========================================================================

test("discovery diagnostics can distinguish every candidate failure mode", () => {
  const page = makeConnectionsPage(people(35), { initial: 10, chunk: 5 });
  const run = discover(page);
  const report = run.diagnostics;

  for (const field of ["scrollTarget", "scans", "newUrls", "quietScans", "paginationClicks", "mutations", "stopReason"]) {
    assert.ok(field in report, `discovery diagnostics must report ${field}`);
  }
  assert.ok(report.scans > 1, "a one-shot scan must be distinguishable from a real walk");
  assert.equal(report.stopReason, "list-end");
  assert.equal(report.scrollTarget, "wrapper");
});

test("the content scripts expose the diagnostics the requirement lists", async () => {
  const connections = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  for (const field of [
    "resultsContainer", "scrollContainer", "scrollTop", "clientHeight", "scrollHeight",
    "visibleCards", "linksInScan", "newUrls", "totalUrls", "mutations",
    "quietScans", "page", "paginationControl", "advertisedTotal", "stopReason"
  ]) {
    assert.ok(connections.includes(field), `connections.js diagnostics must report ${field}`);
  }

  const profile = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  for (const field of [
    "profileRoot", "scrollContainer", "scrollStep", "sectionHeadings",
    "newExperience", "newEducation", "newSkills", "newCertifications",
    "totals", "mutations", "quietScans", "stopReason", "missingFields", "partialSections"
  ]) {
    assert.ok(profile.includes(field), `content.js diagnostics must report ${field}`);
  }
});

// ===========================================================================
// Adapter contracts — the content scripts must not re-implement the policy.
// ===========================================================================

test("the connections script drives the detected scroll container, not window.scrollY", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  assert.match(source, /Core\.chooseScrollTarget\(/, "the scroll container must come from the tested chooser");
  assert.match(source, /scrollCandidates/, "candidates must include ancestors, not just descendants");
  assert.ok(!/function innerScroller/.test(source), "the descendant-only heuristic must be gone");
  assert.ok(
    !/Math\.max\(window\.scrollY, inner \? inner\.scrollTop : 0\)/.test(source),
    "mixing two scrollers' positions is what broke bottom detection"
  );
  assert.match(source, /querySelectorAll/, "cards must be read with querySelectorAll, never a single querySelector");
});

test("the connections script streams new connections out during the pass", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/connections.js"), "utf8");
  assert.match(source, /chrome\.runtime\.sendMessage/, "found connections must be reported before the pass ends");
  assert.match(source, /PV_IMPORT_DISCOVERY_PROGRESS/, "progress goes to the worker, which owns IndexedDB");

  const worker = await readFile(resolve(root, "src/background.ts"), "utf8");
  assert.match(worker, /DISCOVERY_PROGRESS/, "the worker must persist streamed progress");
  assert.match(worker, /putItem/, "streamed rows must be written one at a time");
});

test("the profile script drives the detected scroll container too", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  assert.match(source, /chooseScrollTarget\(/, "the profile scroll container must be detected, not assumed");
  assert.match(source, /createProfileAccumulator\(/, "sections must merge into the tested accumulator");
  assert.match(source, /Core\.nextScanStep\(/, "the scan must use the tested planner");
  assert.ok(!/window\.scrollTo\(\{ top: scan\.position/.test(source), "the scan must not assume the window scrolls");
});

test("the connections page keeps every existing control and adds the diagnostics download", async () => {
  const source = await readFile(resolve(root, "src/react/import-dashboard.tsx"), "utf8");
  for (const label of [
    "Start Full Collection", "Discover Connections Only", "Start Profile Extraction", "Stop",
    "Retry Failed", "Clear Queue", "Saved Profiles", "Download CSV", "Download Diagnostics",
    "Sign in to LinkedIn", "Recheck"
  ]) {
    assert.ok(source.includes(label), `the connections page must offer "${label}"`);
  }
  assert.match(source, /type="search"/, "search must stay");
  assert.match(source, /Filter by status/, "the status filter must stay");
  assert.match(source, /Skip if collected within/, "the 30-day recollection rule must stay editable");
  assert.match(source, /formatDate\(item\.lastCollectedAt\)/, "the last collected date must stay");
  assert.match(source, /paginate\(/, "extension-side pagination must stay");
  assert.match(source, /IMPORT_MESSAGES\.DIAGNOSTICS/, "the download must ask the worker for diagnostics");
});

test("the sanitized live-layout fixtures exist for the manual browser check", async () => {
  const connections = await readFile(resolve(root, "tests/fixtures/linkedin-connections-virtualized-35.html"), "utf8");
  assert.match(connections, /overflow: hidden/, "the document must be pinned, as it is live");
  assert.match(connections, /id="scaffold"/, "an ancestor wrapper must be the real scroller");
  assert.match(connections, /people-filter/, "the decoy scrollable panel must be present");
  assert.match(connections, /TOTAL = 35/, "the fixture must hold 35 connections");

  const profile = await readFile(resolve(root, "tests/fixtures/linkedin-profile-scaffold-scroll.html"), "utf8");
  assert.match(profile, /id="scaffold"/, "the profile fixture must scroll a wrapper too");
  assert.match(profile, /data-virtual/, "sections must mount and unmount while scrolling");
  assert.match(profile, /Second College/, "a second education institution must be present");
});

test("the profile script clicks only its two gated controls and rejects non-profile context", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  // Exactly three clicks exist in the whole content script: the member's own
  // Contact info overlay, the Open to work card's own Show details, and the one
  // dismiss that closes whichever was opened. Anything else appearing here is a
  // regression — see tests/contact-extraction.test.js.
  const clicks = source.match(/\.click\(\)/g) || [];
  assert.equal(clicks.length, 3, `only the two gated overlays may be clicked, found ${clicks.length}`);
  assert.equal((source.match(/control\.element\.click\(\)/g) || []).length, 2, "both opens go through a verdict");
  assert.match(source, /dismiss\.click\(\)/, "and one dismiss closes them");
  assert.match(source, /Connections\.classifyContactControl/, "and the policy decides which element that is");
  assert.match(source, /Connections\.classifyOpenToWorkControl/, "for the open-to-work control too");
  for (const context of ["aside", "footer", "nav", "[role='complementary']", "msg-overlay", "data-test-modal"]) {
    assert.ok(source.includes(context), `${context} must be rejected as profile context`);
  }
  assert.match(source, /visually-hidden|screen-reader/, "accessibility-duplicate text must be rejected");
});
