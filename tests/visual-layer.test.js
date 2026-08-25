/**
 * The visual layer.
 *
 * There is no jsdom in this repo and no browser in the test run, so nothing here
 * claims a screen looks right — that is a load-`dist/`-in-Chrome step (rule 17).
 * What these tests DO hold is everything about the styling that can go silently
 * wrong in a text file:
 *
 *   - a class the React files emit that no stylesheet has a rule for, which
 *     renders as an unstyled element and looks like a bug in the component;
 *   - the four surfaces drifting back into four private palettes, which is the
 *     state this redesign replaced;
 *   - a remote font or stylesheet, which Manifest V3's CSP forbids outright;
 *   - a stray tag in a CSS file, which error recovery swallows together with
 *     the rule that follows it — exactly how `.notice.info` came to be dead.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = (file) => file.endsWith(".css")
  ? resolve(root, "extension", "styles", file)
  : file.endsWith(".html")
    ? resolve(root, "extension", "pages", file)
    : resolve(root, file);
const read = (file) => readFile(sourcePath(file), "utf8");

const SHEETS = ["theme.css", "popup.css", "dashboard.css", "import.css", "applicants.css", "messages.css"];

/**
 * The declarations only.
 *
 * These files document themselves heavily, and several of the comments name the
 * very things the rules below forbid — "no @font-face, no url(), no @import",
 * and the `</content>` tag whose removal one of them records. A check that
 * cannot tell a rule from a note about a rule is a check that fires on its own
 * documentation.
 */
function withoutCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Every page, the stylesheets it loads, and the values its template-literal
 * class names can take.
 *
 * The dynamic list is written out rather than derived because that is the
 * point: `className={`state-pill ${collectionState}`}` can produce any state in
 * the machine, and a state nobody wrote a rule for renders as bare text.
 */
const PAGES = [
  {
    tsx: "src/react/popup.tsx",
    sheets: ["theme.css", "popup.css"],
    dynamic: ["error", "success", "running", "paused", "stopped"]
  },
  {
    tsx: "src/react/dashboard.tsx",
    sheets: ["theme.css", "dashboard.css"],
    dynamic: ["error", "success", "collected", "partial", "failed", "summary-cell", "wide"]
  },
  {
    tsx: "src/react/import-dashboard.tsx",
    sheets: ["theme.css", "import.css"],
    dynamic: [
      "error", "success", "info", "current", "unresolved",
      "pending", "processing", "completed", "failed", "skipped",
      "idle", "discovering", "extracting", "reconciling", "navigating_to_connections",
      "completed_with_gap", "paused_visibility", "paused_challenge", "stopped",
      "challenge", "login-required", "navigation-failures",
      "discovered", "selected", "missing", "reported"
    ]
  },
  {
    tsx: "src/react/applicants-dashboard.tsx",
    sheets: ["theme.css", "applicants.css"],
    // `matched`, `not_matched` and `unknown` were here for the verdict mark in
    // the Qualifications cell. That column was removed in 3.7.9, so nothing
    // emits them any more and their rules went with it — leaving them listed
    // would assert a stylesheet must keep rules for a class no page can produce.
    dynamic: ["error", "success", "selected"]
  },
  {
    // The Messages page (3.13.0). Its own sheet, plus the shared layer.
    tsx: "src/react/messages-dashboard.tsx",
    sheets: ["theme.css", "messages.css"],
    // Only the status-banner kinds, which are interpolated. The page's
    // ready/blocked states are spelled as whole class names in a ternary
    // (`msg-var-unavailable` and friends), so the scanner already sees them and
    // listing them here would demand rules for names nothing emits.
    dynamic: ["error", "success", "info"]
  },
  {
    // The shared navigation is a component rather than a page, and it is listed
    // here for the reason the pages are: it emits classes, and a class with no
    // rule is invisible markup. Its styles live in the shared layer because
    // every page renders it, so `theme.css` is the only sheet it may rely on —
    // which this entry is what proves. A rule added to one page's sheet instead
    // would style the bar on that page alone, and this would catch it.
    tsx: "src/react/nav.tsx",
    sheets: ["theme.css"],
    dynamic: []
  }
];

function classesUsedIn(source) {
  const used = new Set();
  for (const match of source.matchAll(/className="([^"]*)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) used.add(name);
  }
  // A template literal contributes its literal parts; the interpolated half is
  // what each page's `dynamic` list enumerates.
  for (const match of source.matchAll(/className=\{`([^`]*)`/g)) {
    for (const name of match[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) if (name) used.add(name);
  }
  return used;
}

function classesDefinedIn(css) {
  return new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((match) => match[1]));
}

test("every class the UI emits has a rule on the page that loads it", async () => {
  for (const page of PAGES) {
    const source = await read(page.tsx);
    let css = "";
    for (const sheet of page.sheets) css += await read(sheet);
    const defined = classesDefinedIn(css);

    const used = classesUsedIn(source);
    for (const name of page.dynamic) used.add(name);

    const missing = [...used].filter((name) => !defined.has(name)).sort();
    assert.deepEqual(missing, [], `${page.tsx} emits ${missing.join(", ")} but ${page.sheets.join(" + ")} styles nothing by that name`);
  }
});

test("all five surfaces load one shared visual layer, first", async () => {
  // The state this replaced: four stylesheets each carrying their own copy of
  // the same primitives and disagreeing about every one of them — four page
  // backgrounds, three inks, two font stacks, and two files defining the SAME
  // custom property names with different values.
  for (const page of ["popup.html", "dashboard.html", "import.html", "applicants.html", "messages.html"]) {
    const html = await read(page);
    assert.match(html, /<link rel="stylesheet" href="theme\.css" \/>/, `${page} must load the shared layer`);
    assert.ok(
      html.indexOf("theme.css") < html.indexOf(`${page.replace(".html", "")}.css`),
      `${page} must load the shared layer before its own, so the page can override it`
    );
  }
  // Every token is defined once, in the shared layer.
  const theme = await read("theme.css");
  assert.match(theme, /--pv-ink:/, "the tokens live in the shared layer");
  assert.match(theme, /--pv-accent:/);
  assert.match(theme, /--pv-hairline:/);

  for (const sheet of ["popup.css", "dashboard.css", "import.css", "applicants.css", "messages.css"]) {
    const css = await read(sheet);
    assert.ok(!/^\s*:root\s*\{/m.test(css), `${sheet} must not open a second :root token block`);
    assert.ok(!/font-family:/.test(css), `${sheet} must not name a second font stack`);
  }
});

test("no stylesheet reaches for a remote resource", async () => {
  // Manifest V3's CSP is `script-src 'self'` and these pages must work offline.
  // The old files named `Inter` first and shipped no Inter, so the four pages
  // could render in different faces on the same machine.
  for (const sheet of SHEETS) {
    const css = withoutCssComments(await read(sheet));
    assert.ok(!/@import/.test(css), `${sheet} must not @import`);
    assert.ok(!/url\(\s*["']?https?:/i.test(css), `${sheet} must not load a remote url()`);
    assert.ok(!/@font-face/.test(css), `${sheet} must not ship a font`);
  }
  const theme = await read("theme.css");
  assert.match(theme, /font-family: ui-sans-serif, system-ui/, "the system stack is the font stack");
  // The one data: URI is the select chevron, which is not a remote resource.
  assert.match(theme, /url\("data:image\/svg\+xml/, "an inline SVG satisfies the CSP");
});

test("no stylesheet contains a stray tag that would swallow the rule after it", async () => {
  // import.css carried a literal `</content>` for three releases. CSS error
  // recovery skips to the end of the next block, so it ate `.notice.info`
  // silently — the informational notice on the importer rendered unstyled and
  // nothing said why.
  for (const sheet of SHEETS) {
    const css = withoutCssComments(await read(sheet));
    assert.ok(!/<\/?[a-z][a-z0-9-]*>/i.test(css), `${sheet} contains an HTML tag`);
  }
});

test("a wide table is navigable, not merely scrollable", async () => {
  const theme = await read("theme.css");
  const table = theme.slice(theme.indexOf(".table-wrap {"), theme.indexOf("/* Pagination"));

  assert.match(table, /position: sticky;\s*\n\s*top: 0;/, "the header stays, so a column is always named");
  // The pinned group is three wide since 3.7.9 — checkbox, row number, name —
  // so the name's offset is the sum of the two before it. Expressed as a calc of
  // the same variables the cells are sized by, so they cannot drift apart.
  assert.match(table, /\.table-wrap \.row-number \{[\s\S]{0,240}?position: sticky;\s*\n\s*left: var\(--pv-pin-1\)/,
    "the row number pins beside the checkbox");
  assert.match(table, /\.table-wrap \.name-cell \{[\s\S]{0,200}?position: sticky;\s*\n\s*left: calc\(var\(--pv-pin-1\) \+ var\(--pv-pin-2\)\)/,
    "and the person pins to the left, so scrolling right never leaves anonymous cells");
  assert.match(table, /background-attachment: local, local, scroll, scroll;/,
    "with a shadow that says there is more to the right, and goes at the end");

  // Below 860px it stops being a table at all.
  const narrow = theme.slice(theme.indexOf("@media (max-width: 860px)"));
  assert.match(narrow, /\.table-wrap thead \{ display: none; \}/, "the header row is not a card");
  assert.match(narrow, /content: attr\(data-label\)/, "each cell names itself instead");

  // And the labels come from the markup, so a renamed column cannot leave a
  // stale label behind in a stylesheet.
  const applicants = await read("src/react/applicants-dashboard.tsx");
  const dashboard = await read("src/react/dashboard.tsx");
  // "Resume Link" was removed as a column in 3.7.9; "Resume File" is the resume
  // cell the table now carries, and it must still name itself when the table
  // becomes cards.
  assert.match(applicants, /<td className="text-cell" data-label="Resume File">/);
  assert.match(applicants, /<td className="summary-cell" data-label="Total Experience">/);
  assert.match(dashboard, /<td className=\{props\.className \|\| "summary-cell"\} data-label=\{props\.label\}>/,
    "the shared compact cell carries the label through");
  assert.match(dashboard, /label="Open to Work"/);
});

test("a row keeps the height it was rendered at", async () => {
  const theme = await read("theme.css");
  const applicants = await read("src/react/applicants-dashboard.tsx");
  const dashboard = await read("src/react/dashboard.tsx");

  // THE REPORT: rows visibly resize while the page is in use. Two causes.
  //
  // (1) The table re-reads the store every three seconds so it fills in while a
  // run walks the list — so a cell goes from "—" to a value, a qualifications
  // list goes from empty to ten entries, and a resume path appears. Each of
  // those changes that row's natural height, and a row that grows shoves every
  // row below it down.
  // Bounded to the table-mode block. It used to run to the end of the file,
  // which swept in the card-mode media query below it — where a `<td>` IS given
  // a block display on purpose, and where the rule this test now enforces
  // correctly does not apply.
  const stableFrom = theme.indexOf("@media (min-width: 861px) {");
  const stable = theme.slice(stableFrom, theme.indexOf("@media", stableFrom + 10));
  assert.match(stable, /\.table-wrap tbody tr \{ height: var\(--pv-row-h\); \}/, "a row is one fixed height");
  assert.match(stable, /\.table-wrap tbody td \{ height: var\(--pv-row-h\); overflow: hidden; \}/, "and each cell clips rather than grows");
  assert.match(stable, /-webkit-line-clamp: 3;/, "long text truncates instead of pushing the row");

  // ...and the height is only actually FIXED because the content is capped.
  //
  // `height` on a `<td>` is a MINIMUM: the table layout algorithm sizes the row
  // to its tallest cell's content and applies `height` as a floor afterwards.
  // Declaring the row 72px therefore never stopped it becoming 120px. It was
  // 72px with one line in it, ~78px once a value wrapped to the full three-line
  // clamp (56.25px of text in a 50px content box), and 120px once the education
  // list filled in — `.cell-list` was capped at 98px, taller than the row that
  // held it. All three heights are reachable while the recruiter is reading,
  // because the page re-reads the store every three seconds during a run.
  assert.match(stable, /\.table-wrap tbody td > \* \{ max-height: var\(--pv-cell-content-h\); \}/,
    "nothing inside a cell may be taller than the cell's content box");
  // Only max-height, never overflow: a cell that scrolls inside itself must keep
  // doing so, which is what `.cell-list` is for.
  const cap = /\.table-wrap tbody td > \* \{([^}]*)\}/.exec(stable);
  assert.ok(cap && !/overflow/.test(cap[1]), "the cap must not take away a list's own scrolling");

  // The geometry is DERIVED, so the parts cannot drift apart again. That drift
  // is the whole defect: three rules each picked their own number.
  assert.match(theme, /--pv-cell-content-h: calc\(var\(--pv-row-h\) - 2 \* var\(--pv-cell-pad-y\)\);/,
    "the content box is derived from the row height and its padding, never typed");
  assert.match(theme, /padding: var\(--pv-cell-pad-y\) 14px;/, "and the padding the cap subtracts is the padding actually used");
  const applicantsCss = await read("applicants.css");
  assert.match(applicantsCss, /max-height: var\(--pv-cell-content-h\);/,
    "the education list is bounded by the row, not by a number of its own");
  assert.ok(!/max-height: 98px/.test(applicantsCss), "the 98px cell inside a 72px row must not come back");

  // AND the clamp is on a box inside the cell, never on the cell.
  //
  // The reported defect: the table's structure was ruined — the email, the phone
  // number and "Open file" stacked vertically inside the EMAIL column with rules
  // drawn between them, while the name sat on a baseline of its own below. The
  // cause was `display: -webkit-box` on `td.text-cell`. A cell given a box
  // display stops being a table cell: it leaves the row, and its column stops
  // participating in the table's column sizing. Six cells carried the rule, so
  // six columns left the grid while the other six laid out as a row beneath.
  //
  // `.actions-cell` documents the identical trap for `display: flex` in a
  // comment. A comment is not a check, so this is the check: above the card
  // breakpoint, no rule may set the display of an element that IS a cell.
  assert.match(stable, /td\.text-cell > \.cell-clip/, "the clamp targets the wrapper, not the cell");
  // Comments first: this file explains itself at length, and prose describing
  // the defect reads as a selector to a brace-matching scan.
  const rules = stable.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declared = /display:\s*([^;]+)/.exec(body);
    if (!declared) continue;
    for (const one of selector.split(",")) {
      const subject = one.trim().split(/\s+|>/).filter(Boolean).pop() || "";
      assert.ok(
        !/^td\b/.test(subject) && !/(^|\.)[a-z-]*cell$/.test(subject),
        `no rule may set the display of a table cell above the card breakpoint — "${one.trim()}" sets display: ${declared[1].trim()}`
      );
    }
  }

  // (2) A row must not move sideways in the list either, and it did — twice over.
  //
  // (2a) The store sorted newest-first by `updatedAt`, and
  // `normalizeApplicantRecord` restamps `updatedAt` to now on EVERY write. A run
  // streams each finished applicant to the store, so on every three-second poll
  // whoever was saved last jumped to row one and pushed the table down. The key
  // has to be one that does not change when a record is written again.
  const db = await read("src/applicant-db.js");
  const sort = /\.sort\(\(a, b\) =>([\s\S]*?)\);/.exec(db);
  assert.ok(sort, "getAllApplicants must state its order explicitly");
  assert.ok(!/updatedAt/.test(sort[1]), "a restamped field can never be a sort key");
  assert.match(sort[1], /collectedAt/, "when it was collected does not change when it is rewritten");
  assert.match(sort[1], /String\(a\.id\)\.localeCompare\(String\(b\.id\)\)/,
    "and ties need a definite order, or getAll()'s order leaks through");

  // (2b) Even with a stable key, a newcomer sorts ABOVE the rows already on
  // screen, so each poll during a run pushed everything down by one. A row's
  // position is decided by the first poll that sees it and never revised.
  assert.match(applicants, /stabilize\(records: ApplicantRecord\[\]\): ApplicantRecord\[\]/,
    "the page must hold its own display order");
  assert.match(applicants, /this\.setState\(\{ applicants: this\.stabilize\(applicants\) \}\)/,
    "and every poll must go through it");
  const stabilize = applicants.slice(applicants.indexOf("stabilize(records"), applicants.indexOf("load = async"));
  assert.match(stabilize, /for \(const id of this\.displayOrder\) if \(byId\.has\(id\)\) order\.push\(id\)/,
    "rows already shown keep their places, and a deleted one falls out rather than lingering");
  assert.match(stabilize, /if \(!placed\.has\(record\.id\)\) order\.push\(record\.id\)/,
    "newcomers are appended, where they disturb nothing");
  // A hold, not a freeze: Refresh is the way back to newest-first.
  assert.match(applicants, /refresh = \(\) => \{\s*\n\s*this\.displayOrder = \[\];/, "Refresh re-sorts");
  assert.match(applicants, /onClick=\{this\.refresh\}>Refresh</, "and the button must call it, not load()");

  // (3) The status banner was rendered conditionally, so every message that
  // arrived or cleared moved everything below it — including the whole table.
  assert.match(theme, /\.pv-slot \{ min-height: 42px; \}/, "the slot is reserved whether or not it has anything to say");
  for (const [name, source] of [["applicants", applicants], ["dashboard", dashboard]]) {
    assert.match(source, /<div className="pv-slot">\s*\n\s*\{message \?/, `${name} must reserve the message slot`);
  }

  // And nothing animates a LAYOUT property, which would be jitter by design.
  for (const sheet of SHEETS) {
    const css = withoutCssComments(await read(sheet));
    for (const [, value] of css.matchAll(/transition:\s*([^;]+);/g)) {
      // `width` is deliberately absent: the two progress bars animate their fill
      // width, which is the one place a growing box is the point rather than a
      // defect. Nothing else may animate geometry.
      assert.ok(
        !/\b(height|padding|margin|font-size|top|left|inset|gap)\b/.test(value),
        `${sheet} animates a layout property: ${value.trim()}`
      );
    }
  }
});
