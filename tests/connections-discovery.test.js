// Discovery and profile-scan coverage.
//
// There is no DOM in the Node test runner, so the decisions that used to be
// buried in the content scripts now live in the export-free cores and are
// exercised here against simulated LinkedIn lists and profile pages. The content
// scripts are only thin adapters over these functions, and separate assertions in
// import-integration.test.js prove they still call them.

import test from "node:test";
import assert from "node:assert/strict";

await import("../src/connections-core.js");
await import("../src/extraction-core.js");
import * as Queue from "../src/import-queue-core.js";

const Connections = globalThis.ProfileVaultConnections;
const Extraction = globalThis.ProfileVaultCore;

const BASE = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

function people(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    href: `/in/person-${index + offset + 1}/`,
    text: `Person ${index + offset + 1}\n· 1st\nSenior Engineer at Acme`
  }));
}

/**
 * A simulated connections list.
 *
 * `infinite` reveals more rows whenever discovery waits at the bottom.
 * `paginated` reveals a fixed page and then requires an allowlisted control.
 */
function makeList(all, { chunk = 10, mode = "infinite", pageSize = 50 } = {}) {
  const state = {
    rendered: Math.min(chunk, all.length),
    limit: mode === "infinite" ? Math.min(chunk, all.length) : Math.min(pageSize, all.length)
  };
  return {
    visible: () => all.slice(0, state.rendered),
    atBottom: () => state.rendered >= state.limit,
    scroll() {
      state.rendered = Math.min(state.rendered + chunk, state.limit);
    },
    lazyLoad() {
      if (mode !== "infinite") return;
      state.limit = Math.min(state.limit + chunk, all.length);
      state.rendered = Math.min(state.rendered + chunk, state.limit);
    },
    paginationAvailable: () => mode === "paginated" && state.limit < all.length,
    paginate() {
      state.limit = Math.min(state.limit + pageSize, all.length);
      state.rendered = Math.min(state.rendered + chunk, state.limit);
    }
  };
}

/** Run the real discovery policy against a simulated list until it is exhausted. */
function enumerateList(list, { maxSteps = 4000 } = {}) {
  const collector = Connections.createEntryCollector(BASE);
  collector.absorb(list.visible());

  let idleAtBottom = 0;
  let grew = false;
  let steps = 0;
  let paginationClicks = 0;

  for (;;) {
    const plan = Connections.planDiscoveryStep({
      atBottom: list.atBottom(),
      grew,
      idleAtBottom,
      paginationAvailable: list.paginationAvailable(),
      steps,
      maxSteps
    });
    idleAtBottom = plan.idleAtBottom;
    if (plan.action === Connections.DISCOVERY_ACTION.DONE) {
      return { collector, steps, paginationClicks, exhausted: plan.exhausted, reason: plan.reason };
    }

    const before = collector.size;
    if (plan.action === Connections.DISCOVERY_ACTION.SCROLL) list.scroll();
    else if (plan.action === Connections.DISCOVERY_ACTION.PAGINATE) {
      list.paginate();
      paginationClicks += 1;
    } else list.lazyLoad();

    steps += 1;
    collector.absorb(list.visible());
    grew = collector.size > before;
  }
}

// ------------------------------------------------- reading one rendered page

test("every card rendered on a page is read, not just the first", () => {
  const entries = Connections.collectEntriesFromLinks(people(10), BASE);
  assert.equal(entries.length, 10, "all ten rendered connection cards must be collected");
  assert.equal(entries[0].url, "https://www.linkedin.com/in/person-1");
  assert.equal(entries[9].url, "https://www.linkedin.com/in/person-10");
  assert.equal(entries[0].name, "Person 1", "the visible name must come along with the URL");
});

test("a card's name is read without its degree badge or trailing metadata", () => {
  assert.equal(Connections.cleanConnectionName("Asha Rao\n· 1st\nCTO"), "Asha Rao");
  assert.equal(Connections.cleanConnectionName("Asha Rao · 2nd"), "Asha Rao");
  assert.equal(Connections.cleanConnectionName(""), "");
});

test("duplicate links for the same person collapse into one connection", () => {
  const entries = Connections.collectEntriesFromLinks([
    { href: "/in/asha-rao/", text: "" },                                   // photo link, no text
    { href: "https://www.linkedin.com/in/asha-rao?trk=list", text: "Asha Rao · 1st" },
    { href: "/in/asha-rao/details/experience/", text: "Asha Rao" },
    { href: "/in/ASHA-RAO", text: "Asha Rao" },
    { href: "https://www.linkedin.com/company/acme", text: "Acme" },
    { href: "/in/bo-chen/", text: "Bo Chen" }
  ], BASE);

  assert.deepEqual(entries.map((entry) => entry.url), [
    "https://www.linkedin.com/in/asha-rao",
    "https://www.linkedin.com/in/bo-chen"
  ], "duplicates must collapse and first-seen order must hold");
  assert.equal(entries[0].name, "Asha Rao", "a later read may fill in a name the first read missed");
});

test("the same connection seen across several passes is only queued once", () => {
  const collector = Connections.createEntryCollector(BASE);
  assert.equal(collector.absorb(people(10)), 10);
  assert.equal(collector.absorb(people(10)), 0, "a repeated pass must add nothing");
  assert.equal(collector.absorb(people(10, 10)), 10, "genuinely new cards must still be added");
  assert.equal(collector.size, 20);
  assert.equal(collector.has("https://www.linkedin.com/in/person-7/"), true);
});

// ------------------------------------------------------- lazy-loaded scrolling

test("lazy-loaded connection cards are all discovered, not just the first slice", () => {
  const run = enumerateList(makeList(people(137), { chunk: 10, mode: "infinite" }));

  assert.equal(run.collector.size, 137, "every lazily loaded connection must be found");
  assert.equal(run.exhausted, true, "the list must end up provably exhausted");
  assert.equal(run.paginationClicks, 0, "an infinite-scroll list needs no clicks at all");
});

test("discovery never stops at the first bottom it sees", () => {
  // A list whose first screenful is the whole rendered page but which keeps
  // loading: stopping at the first quiet bottom would report 10 of 40.
  const run = enumerateList(makeList(people(40), { chunk: 10, mode: "infinite" }));
  assert.equal(run.collector.size, 40);

  const firstBottom = Connections.planDiscoveryStep({ atBottom: true, grew: false, idleAtBottom: 0, paginationAvailable: false });
  assert.notEqual(firstBottom.action, Connections.DISCOVERY_ACTION.DONE, "one quiet bottom read must not end the list");
  assert.equal(firstBottom.action, Connections.DISCOVERY_ACTION.WAIT_GROWTH);
});

// --------------------------------------------------------- multiple pages

test("a paginated connections list is followed across every page", () => {
  const run = enumerateList(makeList(people(137), { chunk: 10, mode: "paginated", pageSize: 50 }));

  assert.equal(run.collector.size, 137, "every page of the list must be enumerated");
  assert.equal(run.exhausted, true);
  assert.equal(run.paginationClicks, 2, "137 connections at 50 per page needs two Load more clicks");
});

test("complete pagination discovery ends only when no control and no growth remain", () => {
  const paginate = Connections.planDiscoveryStep({
    atBottom: true, grew: false, idleAtBottom: 1, paginationAvailable: true
  });
  assert.equal(paginate.action, Connections.DISCOVERY_ACTION.PAGINATE, "an available control must be used before finishing");
  assert.equal(paginate.exhausted, false);

  const stillWaiting = Connections.planDiscoveryStep({
    atBottom: true, grew: false, idleAtBottom: 1, paginationAvailable: false
  });
  assert.equal(stillWaiting.action, Connections.DISCOVERY_ACTION.WAIT_GROWTH, "two quiet reads are not enough to finish");

  const finished = Connections.planDiscoveryStep({
    atBottom: true, grew: false, idleAtBottom: Connections.DISCOVERY_QUIET_SCANS - 1, paginationAvailable: false
  });
  assert.equal(finished.action, Connections.DISCOVERY_ACTION.DONE);
  assert.equal(finished.exhausted, true, "no control and no growth at the bottom means the list is finished");
});

test("growth at the bottom keeps discovery waiting instead of paginating", () => {
  const plan = Connections.planDiscoveryStep({ atBottom: true, grew: true, idleAtBottom: 1, paginationAvailable: true });
  assert.equal(plan.action, Connections.DISCOVERY_ACTION.WAIT_GROWTH);
  assert.equal(plan.idleAtBottom, 0, "growth must reset the idle counter");
});

test("only the pagination control the classifier approved is ever used", () => {
  // The planner asks for pagination; the classifier decides whether the page's
  // control qualifies. A relationship action can never satisfy it.
  const plan = Connections.planDiscoveryStep({ atBottom: true, grew: false, idleAtBottom: 1, paginationAvailable: true });
  assert.equal(plan.action, Connections.DISCOVERY_ACTION.PAGINATE);
  assert.equal(Connections.classifyControl({ text: "Load more", inConnectionsList: true }).allowed, true);
  assert.equal(Connections.classifyControl({ text: "Connect", inConnectionsList: true }).allowed, false);
  assert.equal(Connections.classifyControl({ text: "Load more", inConnectionsList: false }).allowed, false);
});

// -------------------------------------------------- persisting the full list

test("the full discovered list is persisted across passes before extraction", () => {
  const all = people(137);
  const list = makeList(all, { chunk: 10, mode: "paginated", pageSize: 50 });

  // Three separate discovery passes, each folded into the queue exactly as the
  // service worker does it, so an interrupted enumeration keeps what it found.
  let state = { items: [], session: Queue.createSession() };
  let discovered = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const run = enumerateList(list, { maxSteps: 8 });
    const enqueued = Queue.enqueueUrls(state.items, run.collector.entries(), `t${pass}`);
    discovered += enqueued.added;
    state = {
      items: enqueued.items,
      session: { ...state.session, discovery: Queue.applyDiscoveryPass(state.session, { ...run, atBottom: run.exhausted }, enqueued.added, `t${pass}`) }
    };
  }
  const final = enumerateList(list);
  const enqueued = Queue.enqueueUrls(state.items, final.collector.entries(), "t9");
  state = { items: enqueued.items, session: state.session };

  assert.equal(state.items.length, 137, "every discovered connection must be in the saved queue");
  assert.equal(new Set(state.items.map((item) => item.url)).size, 137, "the saved queue must not contain duplicates");
  assert.ok(discovered > 0, "early passes must contribute rows of their own");
  assert.equal(state.items[0].name, "Person 1", "names discovered on the page must be saved too");
  assert.ok(state.items.every((item) => item.status === Queue.ITEM_STATUS.PENDING), "the saved list starts out pending");
});

test("a rounded advertised total can never confirm coverage", () => {
  const session = Queue.createSession();
  const rounded = Queue.applyDiscoveryPass(session, {
    total: 500, totalReliable: false, atBottom: true, paginationAvailable: false, cursorY: 0
  }, 500, "t1");
  assert.equal(rounded.coverageConfirmed, false, "500+ must never be treated as a confirmed total");

  const exact = Queue.applyDiscoveryPass(session, {
    total: 137, totalReliable: true, atBottom: true, paginationAvailable: false, cursorY: 0
  }, 137, "t1");
  assert.equal(exact.coverageConfirmed, true);
});

// ------------------------------------------------------ profile page scanning

/** A simulated profile page that renders more content as it is scrolled. */
function makeProfilePage({ height = 6400, viewport = 900, growsUntil = 0, virtualizedAtBottom = 0 } = {}) {
  const state = { height, reads: 0, bottomReads: 0, collected: 0 };
  return {
    get viewport() { return viewport; },
    max: () => Math.max(0, state.height - viewport),
    /** Reading the page at `position`; returns the signature the scan sees. */
    read(position) {
      state.reads += 1;
      if (state.reads <= growsUntil) state.height += 1200;
      const atBottom = position >= Math.max(0, state.height - viewport) - 8;
      if (atBottom) {
        state.bottomReads += 1;
        // A virtualized section keeps yielding new records for a few reads even
        // though the page has stopped getting taller.
        if (state.bottomReads <= virtualizedAtBottom) state.collected += 7;
      }
      return `${state.height}:${state.collected}`;
    },
    stats: () => ({ ...state })
  };
}

function runProfileScan(page, { startAt = 0 } = {}) {
  let scan = Extraction.createScanState();
  let position = startAt;
  const visited = [position];
  for (let guard = 0; guard < 500; guard += 1) {
    scan = Extraction.nextScanStep(scan, {
      position,
      maxPosition: page.max(),
      viewportHeight: page.viewport,
      signature: page.read(position)
    });
    if (scan.done) return { scan, visited, position };
    position = scan.position;
    visited.push(position);
  }
  throw new Error("the profile scan never finished");
}

test("the profile scan walks the whole page from the top to the bottom", () => {
  const page = makeProfilePage({ height: 6400, viewport: 900 });
  const { scan, visited } = runProfileScan(page);

  assert.equal(visited[0], 0, "the scan must start at the top");
  assert.equal(scan.atBottom, true, "the scan must reach the bottom");
  assert.equal(visited.at(-1), page.max(), "the last position must be the bottom of the page");
  assert.ok(visited.length >= 8, `a 6400px page must take several steps, took ${visited.length}`);

  // No step may skip more than one viewport, or sections would never render.
  for (let index = 1; index < visited.length; index += 1) {
    assert.ok(visited[index] - visited[index - 1] <= page.viewport, "the scan must move gradually");
  }
});

test("a page that keeps growing keeps the scan going", () => {
  const page = makeProfilePage({ height: 3000, viewport: 900, growsUntil: 6 });
  const { scan } = runProfileScan(page);
  assert.equal(scan.atBottom, true);
  assert.ok(page.stats().height >= 10000, "the simulated page must actually have grown");
  assert.equal(scan.reason, "settled", "the scan must settle rather than run out of steps");
});

test("virtualized profile sections are not lost: the scan waits for them to settle", () => {
  const page = makeProfilePage({ height: 2000, viewport: 900, virtualizedAtBottom: 5 });
  const { scan } = runProfileScan(page);

  assert.equal(scan.reason, "settled");
  assert.ok(
    page.stats().bottomReads >= 5 + Extraction.PROFILE_SCAN.QUIET_PASSES,
    "the scan must keep reading while a virtualized section is still producing records"
  );
  assert.equal(page.stats().collected, 35, "every batch the virtualized section produced must have been read");
});

test("extraction only completes after the scan reaches the bottom and stops changing", () => {
  // Mid-page, an unchanged signature must never finish the scan, however long
  // the page sits still: a profile is not complete until it has been walked.
  let scan = Extraction.createScanState();
  for (let pass = 0; pass < 8; pass += 1) {
    scan = Extraction.nextScanStep(scan, { position: 400, maxPosition: 6000, viewportHeight: 900, signature: "same" });
    assert.equal(scan.done, false, "a quiet page part-way down must never end the scan");
    assert.equal(scan.atBottom, false);
  }

  // Arriving at the bottom with fresh content restarts the quiet count.
  scan = Extraction.nextScanStep(scan, { position: 6000, maxPosition: 6000, viewportHeight: 900, signature: "bottom-content" });
  assert.equal(scan.done, false, "arriving at the bottom is not the end of the scan");
  assert.equal(scan.unchangedPasses, 0);

  const quietBottomRead = () =>
    Extraction.nextScanStep(scan, { position: 6000, maxPosition: 6000, viewportHeight: 900, signature: "bottom-content" });
  for (let pass = 0; pass < Extraction.PROFILE_SCAN.QUIET_PASSES - 1; pass += 1) {
    scan = quietBottomRead();
    assert.equal(scan.done, false, "one quiet read at the bottom is not enough");
  }
  scan = quietBottomRead();
  assert.equal(scan.done, true, "the scan finishes only when the bottom stops changing");
  assert.equal(scan.reason, "settled");
});

test("the scan is bounded so a pathological page still returns", () => {
  let scan = Extraction.createScanState();
  for (let pass = 0; pass < Extraction.PROFILE_SCAN.MAX_STEPS + 5 && !scan.done; pass += 1) {
    scan = Extraction.nextScanStep(scan, {
      position: 0,
      maxPosition: 100000,
      viewportHeight: 900,
      signature: `changing-${pass}`
    });
  }
  assert.equal(scan.done, true);
  assert.equal(scan.reason, "step-budget", "an endlessly changing page must stop on the step budget");
});

// ------------------------------------------------ selection over the full list

test("a selection scope narrows extraction without discarding the discovered list", () => {
  const now = "2026-07-31T00:00:00.000Z";
  const items = [
    { ...Queue.createItem("https://www.linkedin.com/in/a", "t0", "A"), status: "completed", lastCollectedAt: "2026-07-25T00:00:00.000Z" },
    { ...Queue.createItem("https://www.linkedin.com/in/b", "t0", "B"), status: "completed", lastCollectedAt: "2026-01-01T00:00:00.000Z" },
    { ...Queue.createItem("https://www.linkedin.com/in/c", "t0", "C"), status: "failed", error: "Timed out" },
    Queue.createItem("https://www.linkedin.com/in/d", "t0", "D")
  ];
  const scoped = (scope, urls = []) => Queue.selectItemUrls(items, { scope, urls, refreshMaxAgeDays: 30, now });

  assert.equal(scoped(Queue.SELECTION_SCOPE.ALL).length, 4);
  assert.deepEqual(scoped(Queue.SELECTION_SCOPE.FAILED), ["https://www.linkedin.com/in/c"]);
  assert.deepEqual(scoped(Queue.SELECTION_SCOPE.UNCOLLECTED), [
    "https://www.linkedin.com/in/c",
    "https://www.linkedin.com/in/d"
  ]);
  assert.deepEqual(scoped(Queue.SELECTION_SCOPE.STALE), [
    "https://www.linkedin.com/in/b",
    "https://www.linkedin.com/in/c",
    "https://www.linkedin.com/in/d"
  ], "only the profile collected inside the 30-day window is left out");
  assert.deepEqual(scoped(Queue.SELECTION_SCOPE.SELECTED, ["https://www.linkedin.com/in/a"]), ["https://www.linkedin.com/in/a"]);

  const prepared = Queue.prepareRun({ items, session: Queue.createSession() }, scoped(Queue.SELECTION_SCOPE.FAILED), now, "failed");
  assert.equal(prepared.items.length, 4, "a narrowed run must not delete the rest of the discovered list");
  assert.equal(prepared.items[2].status, Queue.ITEM_STATUS.PENDING, "the selected row is requeued");
  assert.equal(prepared.items[0].status, "completed", "rows outside the scope keep their status");
});

test("a scoped run only ever claims connections inside its scope", () => {
  const items = Queue.enqueueUrls([], [
    "https://www.linkedin.com/in/a",
    "https://www.linkedin.com/in/b"
  ], "t0").items;
  const started = Queue.startSession({ items, session: Queue.createSession() }, "t1", {
    scope: "selected",
    scopeUrls: ["https://www.linkedin.com/in/b"]
  });

  const first = Queue.claimNext(started, "t2");
  assert.equal(first.item.url, "https://www.linkedin.com/in/b");

  const second = Queue.claimNext(
    Queue.markCompleted({ items: first.items, session: first.session }, first.item.url, "t3", "id-b"),
    "t4"
  );
  assert.equal(second.item, null, "the out-of-scope connection must never be claimed");
  assert.equal(second.reason, "empty");
});

test("a completed connection records when it was collected", () => {
  const items = Queue.enqueueUrls([], ["https://www.linkedin.com/in/a"], "t0").items;
  const started = Queue.startSession({ items, session: Queue.createSession() }, "t0");
  const claimed = Queue.claimNext(started, "2026-07-31T10:00:00.000Z");
  const done = Queue.markCompleted(
    { items: claimed.items, session: claimed.session },
    "https://www.linkedin.com/in/a",
    "2026-07-31T10:05:00.000Z",
    "profile-1"
  );
  assert.equal(done.items[0].lastCollectedAt, "2026-07-31T10:05:00.000Z");

  const reused = Queue.markCompleted(
    { items: done.items, session: done.session },
    "https://www.linkedin.com/in/a",
    "2026-08-02T10:00:00.000Z",
    "profile-1",
    true,
    "2026-07-31T10:05:00.000Z"
  );
  assert.equal(
    reused.items[0].lastCollectedAt,
    "2026-07-31T10:05:00.000Z",
    "a skip-as-fresh completion must keep the real collection date"
  );
});

// ------------------------------------------------------- list view pagination

test("the connections list paginates at 25 or 50 rows with usable page numbers", () => {
  const rows = Array.from({ length: 137 }, (_, index) => Queue.createItem(`https://www.linkedin.com/in/p-${index}`, "t0", `Person ${index}`));

  const first = Queue.paginate(rows, 1, 25);
  assert.equal(first.rows.length, 25);
  assert.equal(first.pages, 6);
  assert.equal(first.start, 1);
  assert.equal(first.end, 25);
  assert.equal(first.total, 137);

  const last = Queue.paginate(rows, 6, 25);
  assert.equal(last.rows.length, 12, "the final page holds the remainder");
  assert.equal(last.end, 137);

  const fifty = Queue.paginate(rows, 3, 50);
  assert.equal(fifty.rows.length, 37);
  assert.equal(fifty.pages, 3);

  assert.equal(Queue.paginate(rows, 99, 25).page, 6, "an out-of-range page clamps to the last one");
  assert.deepEqual(Queue.paginate([], 1, 25).rows, []);
  assert.deepEqual(Queue.pageNumbers(1, 6), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Queue.pageNumbers(10, 40), [1, 0, 8, 9, 10, 11, 12, 0, 40], "0 marks a gap in the page numbers");
});

test("the connections list can be searched and filtered by status", () => {
  const rows = [
    { ...Queue.createItem("https://www.linkedin.com/in/asha-rao", "t0", "Asha Rao"), status: "completed" },
    { ...Queue.createItem("https://www.linkedin.com/in/bo-chen", "t0", "Bo Chen"), status: "failed", error: "Timed out" },
    { ...Queue.createItem("https://www.linkedin.com/in/cara-diaz", "t0", "Cara Diaz"), status: "pending" }
  ];

  assert.equal(Queue.filterItems(rows, { search: "asha" }).length, 1);
  assert.equal(Queue.filterItems(rows, { search: "BO-CHEN" }).length, 1, "the URL is searchable too");
  assert.equal(Queue.filterItems(rows, { status: "failed" }).length, 1);
  assert.equal(Queue.filterItems(rows, { status: "failed", search: "asha" }).length, 0);
  assert.equal(Queue.filterItems(rows, {}).length, 3);
});
