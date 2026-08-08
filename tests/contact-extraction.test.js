// Contact reachability and the CV — the fields this release is collected for.
//
// The whole policy is pure: what counts as an address, what counts as a phone
// number rather than a date range, what makes a link a CV, and what the Contact
// info overlay is allowed to be clicked for. Source-level assertions prove
// content.js routes through it instead of re-deciding any of it against the DOM.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

await import("../src/extraction-core.js");
await import("../src/connections-core.js");
import { findSharedContactValues, normalizeProfile, stripSharedContactValues } from "../src/profile-utils.js";
import { CSV_COLUMNS, CSV_TABLE_COLUMNS, profilesToCsv, csvToProfiles } from "../src/csv.js";

const Core = globalThis.ProfileVaultCore;
const Connections = globalThis.ProfileVaultConnections;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ===========================================================================
// A. Email
// ===========================================================================

test("addresses are found in running text and normalized to lower case", () => {
  assert.deepEqual(
    Core.extractEmails("Reach me at Nihal.Sharma+jobs@Example.CO.in any time."),
    ["nihal.sharma+jobs@example.co.in"]
  );
  assert.deepEqual(
    Core.extractEmails("a@b.com, a@b.com and second@c.org"),
    ["a@b.com", "second@c.org"],
    "the same address twice is one address"
  );
  assert.deepEqual(Core.extractEmails("no address here at all"), []);
});

test("a mailto: link becomes an address and a bare word never does", () => {
  assert.equal(Core.normalizeEmail("mailto:Someone@Example.com?subject=hi"), "someone@example.com");
  assert.equal(Core.normalizeEmail("someone at example dot com"), "");
  assert.equal(Core.normalizeEmail(""), "");
});

// ===========================================================================
// B. Phone — the numbers that are NOT phone numbers matter most
// ===========================================================================

test("phone numbers survive every separator LinkedIn renders", () => {
  assert.equal(Core.normalizePhone("+91 98765-43210"), "+919876543210");
  assert.equal(Core.normalizePhone("+1 (415) 555-0132"), "+14155550132");
  assert.equal(Core.normalizePhone("(044) 2345 6789"), "04423456789");
  assert.equal(Core.normalizePhone("tel:+442071838750"), "+442071838750");
});

test("a date range, a count, and a placeholder are never saved as a mobile number", () => {
  for (const value of ["2019 - 2023", "2019 – 2023", "2019 to 2023", "2019"]) {
    assert.equal(Core.normalizePhone(value), "", `${value} must not become a phone number`);
  }
  assert.equal(Core.normalizePhone("1,204 followers"), "", "text is not a number");
  assert.equal(Core.normalizePhone("0000000000"), "", "a placeholder is not a number");
  assert.equal(Core.normalizePhone("12345"), "", "too short to be a phone number");
  assert.equal(Core.normalizePhone("1234567890123456"), "", "too long to be a phone number");
});

test("a date range inside a sentence does not contaminate the numbers found", () => {
  assert.deepEqual(
    Core.extractPhones("Worked there 2019 - 2023. Call +91 98765 43210."),
    ["+919876543210"]
  );
});

test("two renderings of one number are stored once, keeping the fuller form", () => {
  const accumulator = Core.createProfileAccumulator();
  accumulator.addPhone("9876543210");
  accumulator.addPhone("+91 98765 43210");
  assert.deepEqual(accumulator.phones(), ["+919876543210"], "the international form wins");

  const reversed = Core.createProfileAccumulator();
  reversed.addPhone("+91 98765 43210");
  reversed.addPhone("9876543210");
  assert.deepEqual(reversed.phones(), ["+919876543210"], "and it wins whichever order they arrive in");
});

// --- live defect: a vanity URL's member id was being saved as a mobile --------
//
// Every LinkedIn profile address ends in the member's numeric id, and that id
// sits squarely inside the 7-15 digit window a phone number occupies. Profile
// after profile came back with a "mobile number" that was the end of its own
// URL: linkedin.com/in/paarth-khandelwal-264954380 → 264954380.

test("digits taken from a LinkedIn URL are never a phone number", () => {
  for (const text of [
    "linkedin.com/in/paarth-khandelwal-264954380",
    "www.linkedin.com/in/jhalak-agrawal-4a2248351",
    "https://www.linkedin.com/in/dishu-choudhary-008a40328/",
    "Contact me on linkedin.com/in/nihal-sharma-987654321"
  ]) {
    assert.deepEqual(Core.extractPhones(text), [], `${text} must yield no phone number`);
  }
  assert.equal(Core.normalizePhone("linkedin.com/in/paarth-khandelwal-264954380"), "");
  assert.equal(Core.normalizePhone("paarth-khandelwal-264954380"), "", "a bare vanity slug is not a number either");
  assert.equal(Core.normalizePhone("/in/nihal-2248351"), "", "nor is a path");
});

test("an identifier welded to a word is not a phone number", () => {
  assert.equal(Core.normalizePhone("ID2938471"), "");
  assert.equal(Core.normalizePhone("credential-12345678"), "");
  assert.deepEqual(Core.extractPhones("Certificate ABC-98765432 issued 2021"), []);
});

test("a real number still survives everything the scrubbing removes", () => {
  assert.deepEqual(
    Core.extractPhones("linkedin.com/in/nihal-264954380 · me@x.com · +91 98765 43210"),
    ["+919876543210"],
    "the URL and the address go, the number stays"
  );
  assert.deepEqual(Core.extractPhones("Call (044) 2345 6789 today"), ["04423456789"]);
});

// --- live defect: the Interests block put a stranger on the record -----------
//
// "Interests" renders Top Voices — other members, with their own addresses and
// numbers in plain text. Sweeping the whole page for anything shaped like a
// contact detail saved those onto the profile being collected.

test("an address or number in running text is not a contact detail", () => {
  const interests = [
    "Interests",
    "Top Voices",
    "Dr. Vivek Bindra · 3rd",
    "Monk-Turned-Entrepreneur | CEO & Founder, Bada Business",
    "collab@badabusiness.com 9560278611",
    "269,037 followers"
  ].join("\n");
  const scanned = Core.scanLabelledContacts(interests);
  assert.deepEqual(scanned.emails, [], "a stranger's address is not this member's address");
  assert.deepEqual(scanned.phones, [], "nor is their number");
});

test("a value is taken only from the field that says what it is", () => {
  const scanned = Core.scanLabelledContacts([
    "Contact info",
    "Your Profile",
    "www.linkedin.com/in/paarth-khandelwal-264954380",
    "Email",
    "paarth@example.com",
    "Phone",
    "+91 98765 43210",
    "Mobile",
    "Website",
    "portfolio.dev 9876500000"
  ].join("\n"));
  assert.deepEqual(scanned.emails, ["paarth@example.com"]);
  assert.deepEqual(scanned.phones, ["+919876543210"], "the number under Website is not a phone field");
});

test("a label carrying its value on the same line is read too", () => {
  const scanned = Core.scanLabelledContacts("Email: nihal@example.com\nMobile number: +91 98765 43210");
  assert.deepEqual(scanned.emails, ["nihal@example.com"]);
  assert.deepEqual(scanned.phones, ["+919876543210"]);
});

test("the rendered page may contribute an address but never a number", () => {
  const panel = Core.parseContactPanel({
    text: "Email\nnihal@example.com\nPhone\n+91 98765 43210",
    links: [],
    allow: ["email"]
  });
  assert.deepEqual(panel.emails, ["nihal@example.com"]);
  assert.deepEqual(panel.phones, [], "a number outside the overlay needs a tel: link");
});

test("a panel the extension opened itself yields every address and number in it", () => {
  // 3.7.1. The recruiter's contact disclosure and the member's Contact info
  // overlay both put the address and the number together, and both are that
  // person's own card — there is no Interests block inside them. Requiring a
  // recognised heading in there lost the number whenever LinkedIn's wording or
  // the account's locale did not match `CONTACT_FIELD_LABELS`.
  const trusted = Core.parseContactPanel({
    text: "Mahak Ayani\nmahak@example.com\n+91 98765 43210",
    links: [],
    trusted: true
  });
  assert.deepEqual(trusted.emails, ["mahak@example.com"]);
  assert.deepEqual(trusted.phones, ["+919876543210"], "an unlabelled number in our own panel is still theirs");

  // The same text outside such a panel still yields nothing but the address.
  const untrusted = Core.parseContactPanel({
    text: "Mahak Ayani\nmahak@example.com\n+91 98765 43210",
    links: [],
    allow: ["email"]
  });
  assert.deepEqual(untrusted.phones, [], "the rendered page is unchanged — this relaxation is scoped");

  // And the scrubbing still applies inside a trusted panel: the two live
  // defects must not come back through this door.
  const scrubbed = Core.parseContactPanel({
    text: "linkedin.com/in/paarth-khandelwal-264954380\nFollowers 12345678\n2019 - 2023",
    links: [],
    trusted: true
  });
  assert.deepEqual(scrubbed.phones, [], "a vanity URL, a count and a date range are still not phone numbers");

  const labelled = Core.parseContactPanel({
    text: "Email\nnihal@example.com\nPhone\n+91 98765 43210",
    links: [],
    trusted: true
  });
  assert.deepEqual(labelled.emails, ["nihal@example.com"]);
  assert.deepEqual(labelled.phones, ["+919876543210"], "a labelled panel still reads the same way");
});

test("both content scripts mark their own opened panel as trusted", async () => {
  const profile = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  const dialog = profile.slice(profile.indexOf("function readContactDialog"));
  assert.match(dialog.slice(0, dialog.indexOf("\n  }")), /trusted: true/, "the Contact info overlay is our own panel");

  const applicants = await readFile(resolve(root, "extension/content-scripts/applicants.js"), "utf8");
  assert.match(applicants, /Core\.parseContactPanel\(\{ text, links, trusted: true \}\)/, "so is the applicant disclosure");
  assert.ok(!/already-visible/.test(applicants), "and it is opened on every applicant");
});

test("a tel: or mailto: link always carries its own provenance", () => {
  const panel = Core.parseContactPanel({
    text: "",
    links: [{ href: "tel:+919876543210" }, { href: "mailto:nihal@example.com" }],
    allow: ["email"]
  });
  assert.deepEqual(panel.phones, ["+919876543210"], "a tel: link says what it is");
  assert.deepEqual(panel.emails, ["nihal@example.com"]);
});

// ===========================================================================
// C. The CV — the highest-priority field
// ===========================================================================

test("a link is a CV when its label, its URL, its file type, or its host says so", () => {
  const cases = [
    { href: "https://example.com/x", label: "My Resume" },
    { href: "https://example.com/x", label: "CV" },
    { href: "https://example.com/curriculum-vitae" },
    { href: "https://example.com/nihal.pdf" },
    { href: "https://example.com/nihal.docx?dl=1" },
    { href: "https://read.cv/nihal" },
    { href: "https://standardresume.co/r/nihal" },
    // A general document host, with something that actually says CV next to it.
    { href: "https://drive.google.com/file/d/abc/view", label: "Resume" },
    { href: "https://www.dropbox.com/s/abc/file", context: "My CV is here" }
  ];
  for (const link of cases) {
    assert.equal(Core.looksLikeCvLink(link), true, `${JSON.stringify(link)} must read as a CV`);
  }
});

// Live defect: the CV column was filling up with links that were not CVs, and
// with the person's own LinkedIn page. The CV field carries CVs and resumes.

test("the member's own LinkedIn page is never their CV", () => {
  for (const href of [
    "https://www.linkedin.com/in/nihal",
    "https://www.linkedin.com/in/nihal/overlay/contact-info/",
    "https://www.linkedin.com/in/nihal/details/experience/",
    "https://linkedin.com/posts/nihal-activity-123",
    // The word "cv" inside a vanity slug used to be enough to promote it.
    "https://www.linkedin.com/in/john-cv-sharma"
  ]) {
    assert.equal(Core.looksLikeCvLink({ href, label: "Resume" }), false, `${href} must never be a CV`);
    assert.equal(Core.classifyContactLink({ href }).kind, "", `${href} is navigation, not a contact detail`);
  }
});

test("an ordinary link on a shared-document host is not a resume", () => {
  assert.equal(
    Core.looksLikeCvLink({ href: "https://drive.google.com/file/d/abc/view" }),
    false,
    "a bare Drive link says nothing about being a CV"
  );
  assert.equal(Core.looksLikeCvLink({ href: "https://www.dropbox.com/s/abc/file" }), false);
  assert.equal(
    Core.classifyContactLink({ href: "https://drive.google.com/file/d/abc/view", label: "Photos" }).kind,
    "website",
    "it is kept, just not as the CV"
  );
});

test("a portfolio is a website, not a CV", () => {
  assert.equal(
    Core.looksLikeCvLink({ href: "https://nihal.dev", context: "Website (Portfolio)" }),
    false,
    "a portfolio is a personal site"
  );
  assert.equal(Core.classifyContactLink({ href: "https://nihal.dev", label: "Portfolio" }).kind, "website");
});

test("one mention of the word in a section does not claim every link in it", () => {
  // `context` is the whole surrounding list item or section, so on its own it is
  // far too loose — it used to promote any link that happened to sit near it.
  assert.equal(
    Core.looksLikeCvLink({ href: "https://twitter.com/nihal", context: "Ask me for my CV or follow me" }),
    false
  );
});

test("a CV behind LinkedIn's redirector is found, and stored unwrapped", () => {
  const wrapped =
    "https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fexample.com%2Fnihal-cv.pdf&urlhash=abcd";
  assert.equal(Core.unwrapRedirectUrl(wrapped), "https://example.com/nihal-cv.pdf");
  assert.deepEqual(Core.classifyContactLink({ href: wrapped, label: "Resume" }), {
    kind: "cv",
    value: "https://example.com/nihal-cv.pdf"
  });
  assert.equal(
    Core.unwrapRedirectUrl("https://www.linkedin.com/in/nihal"),
    "https://www.linkedin.com/in/nihal",
    "an ordinary LinkedIn URL is left alone"
  );
});

test("an ordinary website, a mailto and a LinkedIn URL are not CVs", () => {
  assert.equal(Core.looksLikeCvLink({ href: "https://myblog.dev", label: "Blog" }), false);
  assert.equal(Core.looksLikeCvLink({ href: "mailto:a@b.com" }), false);
  assert.equal(Core.looksLikeCvLink({ href: "" }), false);
  assert.equal(
    Core.classifyContactLink({ href: "https://www.linkedin.com/in/someone" }).kind,
    "",
    "a LinkedIn link is navigation, not a contact detail"
  );
});

test("the profile link is stored on its own field, and the overlay cannot change it", () => {
  // Opening Contact info routes LinkedIn to /in/slug/overlay/contact-info/, and
  // the profile URL is read after that click.
  for (const opened of [
    "https://www.linkedin.com/in/nihal/overlay/contact-info/",
    "https://www.linkedin.com/in/nihal/details/skills/",
    "https://www.linkedin.com/in/nihal/?originalSubdomain=in"
  ]) {
    assert.equal(
      Core.canonicalizeProfileUrl(opened),
      "https://www.linkedin.com/in/nihal",
      `${opened} must canonicalize to the member's page`
    );
  }

  const profile = normalizeProfile({
    fullName: "Nihal Sharma",
    profileUrl: "https://www.linkedin.com/in/nihal/overlay/contact-info/",
    // An older record, a CSV, or a hand edit offering the profile as the CV.
    cvUrl: "https://www.linkedin.com/in/nihal",
    cvLinks: ["https://www.linkedin.com/in/nihal", "https://example.com/nihal-cv.pdf"]
  });

  assert.equal(profile.profileUrl, "https://www.linkedin.com/in/nihal", "the profile link is kept, canonically");
  assert.equal(profile.cvUrl, "https://example.com/nihal-cv.pdf", "and only the real CV is in the CV field");
  assert.deepEqual(profile.cvLinks, ["https://example.com/nihal-cv.pdf"]);
});

test("a profile with no CV keeps the field empty rather than falling back to the page", () => {
  const profile = normalizeProfile({
    fullName: "No CV",
    profileUrl: "https://www.linkedin.com/in/nocv",
    cvLinks: ["https://www.linkedin.com/in/nocv"]
  });
  assert.equal(profile.cvUrl, "", "missing stays empty — never invented, never the profile link");
  assert.deepEqual(profile.cvLinks, []);
});

test("links are sorted into the bucket they belong in", () => {
  assert.deepEqual(Core.classifyContactLink({ href: "mailto:A@B.com" }), { kind: "email", value: "a@b.com" });
  assert.deepEqual(Core.classifyContactLink({ href: "tel:+91 98765 43210" }), { kind: "phone", value: "+919876543210" });
  assert.deepEqual(Core.classifyContactLink({ href: "https://x.com/cv.pdf", label: "CV" }), {
    kind: "cv",
    value: "https://x.com/cv.pdf"
  });
  assert.deepEqual(Core.classifyContactLink({ href: "https://myblog.dev", label: "Blog" }), {
    kind: "website",
    value: "Blog: https://myblog.dev"
  });
  assert.equal(Core.classifyContactLink({ href: "javascript:void(0)" }).kind, "");
});

// ===========================================================================
// D. The Contact info overlay
// ===========================================================================

test("a rendered contact panel is read into structured values", () => {
  const panel = Core.parseContactPanel({
    text: [
      "Contact info",
      "Your Profile",
      "linkedin.com/in/nihal",
      "Email",
      "nihal@example.com",
      "Phone",
      "+91 98765 43210 (Mobile)",
      "Birthday",
      "12 June"
    ].join("\n"),
    links: [
      { href: "https://www.linkedin.com/in/nihal", label: "linkedin.com/in/nihal" },
      { href: "https://example.com/nihal-cv.pdf", label: "Resume" },
      { href: "https://myblog.dev", label: "Blog" }
    ]
  });

  assert.deepEqual(panel.emails, ["nihal@example.com"]);
  assert.deepEqual(panel.phones, ["+919876543210"]);
  assert.deepEqual(panel.cvLinks, ["https://example.com/nihal-cv.pdf"]);
  assert.deepEqual(panel.websites, ["Blog: https://myblog.dev"]);
});

test("the field labels in the panel are never stored as values", () => {
  const panel = Core.parseContactPanel({ text: "Email\nPhone\nWebsite\nContact info\nAddress" });
  assert.deepEqual(panel.emails, []);
  assert.deepEqual(panel.phones, []);
});

// --- the overlay is fetched, so it has to be given time to arrive ------------
//
// Live defect: the click opened the overlay and the panel was read on the very
// next frame, which is the modal shell with nothing in it yet. Every profile
// came back with no email and no phone number even though both were on screen a
// moment later. The wait is a settle loop now, and this is its decision half.

/** Drive the pure policy over a scripted sequence of observations. */
function driveOverlay(observations) {
  let state = Core.createContactOverlayState();
  let polls = 0;
  for (const observation of observations) {
    state = Core.nextContactOverlayStep(state, {
      waitedMs: polls * Core.CONTACT_OVERLAY.POLL_MS,
      present: true,
      visible: true,
      ...observation
    });
    polls += 1;
    if (state.done) break;
  }
  return { state, polls };
}

/** A read of a fully loaded panel showing one address. */
const LOADED = { loading: false, carriesValue: true, signature: "email-only" };

test("a skeleton overlay is never mistaken for a loaded one", () => {
  const skeleton = { loading: true, carriesValue: false, signature: "skeleton" };
  const { state } = driveOverlay(Array.from({ length: 8 }, () => skeleton));
  assert.equal(state.settled, false, "placeholders must never settle the wait");
  assert.equal(state.done, false, "and the wait must still be running");
});

test("the overlay is read repeatedly until its content stops changing", () => {
  const { state, polls } = driveOverlay([LOADED, LOADED, LOADED, LOADED, LOADED]);
  assert.equal(state.settled, true);
  assert.equal(state.reason, "settled");
  assert.equal(polls, Core.CONTACT_OVERLAY.QUIET_PASSES + 1, "one read to fingerprint, then agreeing reads");
  assert.ok(state.reads >= 2, "the panel is read more than once");
});

test("a phone number arriving after the address restarts the count", () => {
  // The exact live sequence: shell, address, then the number a beat later.
  const { state } = driveOverlay([
    { loading: true, carriesValue: false, signature: "skeleton" },
    { loading: false, carriesValue: true, signature: "email" },
    { loading: false, carriesValue: true, signature: "email" },
    { loading: false, carriesValue: true, signature: "email+phone" },
    { loading: false, carriesValue: true, signature: "email+phone" },
    { loading: false, carriesValue: true, signature: "email+phone" },
    { loading: false, carriesValue: true, signature: "email+phone" }
  ]);
  assert.equal(state.settled, true, "it settles only once the fuller panel has held steady");
  assert.equal(state.lastSignature, "email+phone", "on the panel that had both, not the one that had one");
});

test("an overlay that really is empty settles instead of costing the whole timeout", () => {
  const empty = { loading: false, carriesValue: false, signature: "empty" };
  const { state } = driveOverlay(Array.from({ length: 40 }, () => empty));
  assert.equal(state.settled, true, "an empty panel must not hold the queue for the full timeout");
  assert.ok(
    state.waited >= Core.CONTACT_OVERLAY.MIN_LOAD_MS,
    "but it is never called empty before the fetch has had a fair chance"
  );
  assert.ok(state.waited < Core.CONTACT_OVERLAY.LOAD_TIMEOUT_MS, "and well before the timeout");
});

test("a panel that never stops changing gives up at the timeout rather than looping", () => {
  const state = Core.nextContactOverlayStep(Core.createContactOverlayState(), {
    waitedMs: Core.CONTACT_OVERLAY.LOAD_TIMEOUT_MS,
    present: true,
    visible: true,
    loading: true,
    carriesValue: false,
    signature: "still-loading"
  });
  assert.equal(state.done, true);
  assert.equal(state.settled, false);
  assert.equal(state.reason, "load-timeout");
});

test("a hidden page or a dismissed overlay stops the wait without claiming it settled", () => {
  const hidden = Core.nextContactOverlayStep(Core.createContactOverlayState(), { present: true, visible: false });
  assert.equal(hidden.done, true);
  assert.equal(hidden.settled, false);
  assert.equal(hidden.reason, "page-hidden");

  const gone = Core.nextContactOverlayStep(Core.createContactOverlayState(), { present: false, visible: true });
  assert.equal(gone.done, true);
  assert.equal(gone.settled, false);
  assert.equal(gone.reason, "overlay-closed-early");
});

test("the overlay is given a realistic amount of time on a throttled tab", () => {
  assert.ok(Core.CONTACT_OVERLAY.OPEN_TIMEOUT_MS >= 8000, "the modal is fetched; 3s was not enough live");
  assert.ok(Core.CONTACT_OVERLAY.LOAD_TIMEOUT_MS >= 8000, "and so is its content");
  assert.ok(Core.CONTACT_OVERLAY.QUIET_PASSES >= 2, "one agreeing read is not a settled panel");
});

test("Contact info is now clickable, and nothing else on the denylist is", () => {
  const allowed = Connections.classifyContactControl({ text: "Contact info", onProfilePage: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "contact-info");
  assert.equal(
    Connections.classifyContactControl({ ariaLabel: "See contact info", onProfilePage: true }).allowed,
    true
  );

  // The denylist still beats it: a combined control is refused, not clicked.
  const combined = Connections.classifyContactControl({
    text: "Contact info",
    ariaLabel: "Message Nihal",
    onProfilePage: true
  });
  assert.equal(combined.allowed, false);
  assert.equal(combined.forbidden, true, "the denylist must always win");

  for (const label of [
    "Connect", "Follow", "Message", "InMail", "Endorse", "Remove connection",
    "Withdraw", "Invite", "Report", "Block", "Send", "Share", "Accept", "Ignore", "Save"
  ]) {
    assert.equal(Connections.isForbiddenLabel(label), true, `${label} must stay permanently forbidden`);
    assert.equal(
      Connections.classifyContactControl({ text: label, onProfilePage: true }).allowed,
      false,
      `${label} must never be clicked as a contact control`
    );
  }
});

test("the contact control is not clickable off a profile page", () => {
  const verdict = Connections.classifyContactControl({ text: "Contact info", onProfilePage: false });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "not-a-profile-page");
});

test("connections pagination is unaffected by the contact change", () => {
  const paginate = Connections.classifyControl({ text: "Next", inConnectionsList: true });
  assert.equal(paginate.allowed, true);
  assert.equal(
    Connections.classifyControl({ text: "Contact info", inConnectionsList: true }).allowed,
    false,
    "the contact control is not a pagination control"
  );
});

// ===========================================================================
// E. Years of experience
// ===========================================================================

test("years of experience is a number derived from the merged role intervals", () => {
  const records = [{ title: "Engineer", dateRange: "Jan 2020 - Jul 2025" }];
  assert.equal(Core.calculateExperienceYears(records, new Date("2026-01-01")), "5.6");
  assert.equal(Core.calculateTotalExperience(records, new Date("2026-01-01")), "5 years 7 months");
});

test("an unknown length of experience stays empty rather than becoming zero", () => {
  assert.equal(Core.calculateExperienceYears([]), "");
  assert.equal(Core.calculateExperienceYears([{ title: "Engineer", dateRange: "" }]), "");
});

// ===========================================================================
// F. The record: the new shape, and the fields that are gone
// ===========================================================================

test("the stored record is the name, the ways to reach the person, and what they can do", () => {
  const profile = normalizeProfile({
    fullName: "Nihal Sharma",
    profileUrl: "https://www.linkedin.com/in/nihal/",
    cvLinks: ["https://example.com/cv.pdf", "https://drive.google.com/file/d/x/view"],
    emails: ["Nihal@Example.com", "nihal.work@example.com"],
    phones: ["+91 98765 43210"],
    skills: ["React", "react", "TypeScript"],
    education: ["NIT Jaipur", "nit jaipur", "PIET"],
    openToWorkDetails: ["Open to work: Yes", "Job titles: Software Engineer"]
  });

  assert.equal(profile.cvUrl, "https://example.com/cv.pdf", "the primary CV is the first one found");
  assert.equal(profile.cvFileName, "cv.pdf", "the file name is derived from the link, never guessed");
  assert.equal(profile.cvAvailable, true);
  assert.equal(profile.cvLinks.length, 2, "every CV link is kept");
  assert.equal(profile.email, "nihal@example.com");
  assert.deepEqual(profile.emails, ["nihal@example.com", "nihal.work@example.com"]);
  assert.equal(profile.mobile, "+919876543210");
  assert.deepEqual(profile.skills, ["React", "TypeScript"], "arrays still dedupe case-insensitively");
  assert.deepEqual(profile.education, ["NIT Jaipur", "PIET"], "institutions dedupe too");
  assert.equal(profile.status, "collected", "a record carrying priority data reads as collected");
  assert.ok(profile.lastCollectedAt, "every record records when it was collected");
  assert.equal(profile.schemaVersion, 5);
});

test("a profile that rendered none of the priority fields is partial, not failed", () => {
  const profile = normalizeProfile({ fullName: "Nobody", profileUrl: "https://www.linkedin.com/in/nobody" });
  assert.equal(profile.status, "partial");
  assert.equal(profile.cvAvailable, false);
  assert.equal(profile.cvFileName, "");
  assert.equal(
    normalizeProfile({ fullName: "X", profileUrl: "https://www.linkedin.com/in/x", status: "failed" }).status,
    "failed",
    "a status the importer states outright is never overwritten"
  );
});

test("a CV that is a hosted page has no file name, and the record says so", () => {
  const profile = normalizeProfile({
    fullName: "Test", profileUrl: "https://www.linkedin.com/in/test", cvUrl: "https://read.cv/nihal"
  });
  assert.equal(profile.cvAvailable, true);
  assert.equal(profile.cvFileName, "", "a page is not a file, and a name is never invented for it");
});

// The DERIVED fields stay retired; the READ ones came back.
//
// 3.6.0 retired both kinds together, and that was the mistake: the scan was
// still walking Experience, About and the top card on every pass and throwing
// the result away at the last step. A field the page renders is kept. A field
// nothing renders — a "total experience" summed out of date ranges, a "current
// role" picked out of a list — stays gone, because a derived value that
// disagrees with the roles printed beside it is worse than no value (rule 1).
test("the derived fields stay retired, and the ones the page renders are kept", () => {
  const profile = normalizeProfile({
    fullName: "Test",
    profileUrl: "https://www.linkedin.com/in/test",
    experience: ["Engineer — Acme · Jan 2024 - Present"],
    yearsOfExperience: "5.6",
    currentRole: "Engineer",
    currentCompany: "Acme",
    currentEmploymentDates: "Jan 2024 - Present",
    totalExperience: "5 years",
    websites: ["https://example.com"],
    profileImageUrl: "https://media.licdn.com/x.jpg"
  });
  for (const gone of [
    "yearsOfExperience", "currentRole", "currentCompany",
    "currentEmploymentDates", "totalExperience", "websites", "profileImageUrl"
  ]) {
    assert.equal(profile[gone], undefined, `${gone} must not be on the record any more`);
  }
  assert.deepEqual(
    profile.experience,
    ["Engineer — Acme · Jan 2024 - Present"],
    "the roles the page rendered are what the record keeps"
  );
});

test("a scalar email, mobile or CV supplied alone still lands in its list", () => {
  const profile = normalizeProfile({
    fullName: "Test",
    profileUrl: "https://www.linkedin.com/in/test",
    email: "solo@example.com",
    mobile: "+919876543210",
    cvUrl: "https://example.com/solo.pdf"
  });
  assert.deepEqual(profile.emails, ["solo@example.com"]);
  assert.deepEqual(profile.phones, ["+919876543210"]);
  assert.deepEqual(profile.cvLinks, ["https://example.com/solo.pdf"]);
});

test("the member's own top card is stored, and the sections nothing reads are not", () => {
  const profile = normalizeProfile({
    fullName: "Test",
    profileUrl: "https://www.linkedin.com/in/test",
    headline: "Senior Engineer at Acme",
    location: "Chennai, India",
    about: "A paragraph about me.",
    interests: ["Anthropic", "Anthropic", "Some Newsletter"],
    certifications: ["CKA"],
    languages: ["English"]
  });

  assert.equal(profile.headline, "Senior Engineer at Acme");
  assert.equal(profile.location, "Chennai, India");
  assert.equal(profile.about, "A paragraph about me.");
  assert.deepEqual(profile.interests, ["Anthropic", "Some Newsletter"], "interests dedupe like every other list");

  // Certifications and Languages are parsed during the scan but not stored: no
  // column asks for them, and a stored field nothing shows is a field nothing
  // keeps honest.
  for (const field of ["certifications", "languages", "contactInfo"]) {
    assert.equal(profile[field], undefined, `${field} must not be on the record`);
  }
});

// The About section is prose the member wrote. Its line breaks are part of what
// they wrote, so the paragraph normalizer is not `cleanText`.
test("About keeps its line breaks and loses only the blank runs", () => {
  const profile = normalizeProfile({
    fullName: "Test",
    profileUrl: "https://www.linkedin.com/in/test",
    about: "  First line.  \n\n\n\nSecond line.\n\tThird line.  "
  });
  assert.equal(profile.about, "First line.\n\nSecond line.\nThird line.");
});

// Rule 19: append columns, never reorder. A file written by any release since
// 3.6.0 still opens against the same first eighteen headers, and everything this
// release added comes after them.
test("the CSV appends its new columns and never reorders the old ones", () => {
  const labels = CSV_COLUMNS.map(([, label]) => label);
  assert.deepEqual(
    labels.slice(0, 18),
    ["name", "email", "mobile", "cv_url", "open_to_work", "education", "skills",
      "profile_url", "status", "last_collected", "notes", "tags",
      "all_emails", "all_phone_numbers", "cv_file_name", "cv_links", "source", "collected_at"],
    "the columns 3.6.0 wrote, exactly where it left them"
  );
  assert.deepEqual(
    labels.slice(18),
    ["location", "headline", "about", "experience", "education_details", "interests"],
    "and the whole of what the scan now keeps, appended"
  );

  // The table's columns are a different list in a different order — see
  // react-architecture.test.js. Every one of them is still in the file.
  for (const label of CSV_TABLE_COLUMNS) {
    assert.ok(labels.includes(label), `${label} is on the table and must be in the file`);
  }

  for (const gone of [
    "certifications", "languages", "contact_information",
    "years_of_experience", "total_experience", "current_role", "current_company",
    "current_employment_dates", "websites", "profile_image_url"
  ]) {
    assert.ok(!labels.includes(gone), `${gone} must not be exported`);
  }
});

test("a profile survives a CSV round trip with every stored field intact", () => {
  const profile = normalizeProfile({
    fullName: "Nihal Sharma",
    profileUrl: "https://www.linkedin.com/in/nihal",
    cvUrl: "https://example.com/cv.pdf",
    email: "nihal@example.com",
    mobile: "+919876543210",
    emails: ["nihal@example.com", "second@example.com"],
    skills: ["React", "TypeScript"],
    education: ["NIT Jaipur", "Poornima Institute"],
    openToWorkDetails: ["Open to work: Yes", "Job titles: Software Engineer, Frontend Developer"],
    notes: "Referred by Aditi",
    tags: ["shortlist"]
  });

  const [restored] = csvToProfiles(profilesToCsv([profile]));

  assert.equal(restored.fullName, "Nihal Sharma");
  assert.equal(restored.cvUrl, "https://example.com/cv.pdf");
  assert.equal(restored.email, "nihal@example.com");
  assert.deepEqual(restored.emails, ["nihal@example.com", "second@example.com"]);
  assert.equal(restored.mobile, "+919876543210", "the text marker is stripped on the way back in");
  assert.deepEqual(restored.skills, ["React", "TypeScript"]);
  assert.deepEqual(restored.education, ["NIT Jaipur", "Poornima Institute"], "every institution is exported");
  assert.deepEqual(restored.openToWorkDetails, profile.openToWorkDetails);
  assert.equal(restored.status, profile.status);
  assert.equal(restored.lastCollectedAt, profile.lastCollectedAt);
  assert.equal(restored.notes, "Referred by Aditi");
  assert.deepEqual(restored.tags, ["shortlist"]);
});

test("a mobile number is exported as text and never as a number", () => {
  const csv = profilesToCsv([
    normalizeProfile({ fullName: "T", profileUrl: "https://www.linkedin.com/in/t", mobile: "04423456789" })
  ]);
  assert.ok(csv.includes('"\'04423456789"'), "the leading zero must survive a spreadsheet");
  const [restored] = csvToProfiles(csv);
  assert.equal(restored.mobile, "04423456789");
});

test("an empty value stays empty and Unicode survives the round trip", () => {
  const profile = normalizeProfile({
    fullName: "Ananya Śarmā 中文",
    profileUrl: "https://www.linkedin.com/in/ananya",
    skills: ["Māori", "Français"]
  });
  const [restored] = csvToProfiles(profilesToCsv([profile]));
  assert.equal(restored.fullName, "Ananya Śarmā 中文");
  assert.deepEqual(restored.skills, ["Māori", "Français"]);
  assert.equal(restored.email, "", "an empty column stays empty rather than becoming a placeholder");
  assert.equal(restored.mobile, "");
  assert.deepEqual(restored.openToWorkDetails, []);
});

test("no cell can ever read [object Object]", () => {
  const csv = profilesToCsv([{
    ...normalizeProfile({ fullName: "T", profileUrl: "https://www.linkedin.com/in/t" }),
    // A record shaped like the pre-3.6.0 one, whose education held objects.
    education: [{ institution: "NIT" }],
    openToWorkDetails: { titles: ["Engineer"] }
  }]);
  assert.ok(!csv.includes("[object Object]"), "an object is refused, not printed");
});

test("a CSV written by 3.5.0 still imports", () => {
  const legacy = [
    '"full_name","profile_url","email","skills","source","collected_at"',
    '"Old Record","https://www.linkedin.com/in/old","old@example.com","React","LinkedIn","2026-01-01T00:00:00.000Z"'
  ].join("\r\n");
  const [restored] = csvToProfiles(legacy);
  assert.equal(restored.fullName, "Old Record", "full_name is still accepted as a name column");
  assert.equal(restored.email, "old@example.com");
  assert.deepEqual(restored.skills, ["React"]);
});

test("a formula-shaped contact value is still neutralized in the CSV", () => {
  const csv = profilesToCsv([
    normalizeProfile({ fullName: "=cmd()", profileUrl: "https://www.linkedin.com/in/x", notes: "+1" })
  ]);
  assert.ok(csv.includes('"\'=cmd()"'), "a leading = must be quoted out");
  assert.ok(csv.includes('"\'+1"'), "and so must a leading +");
});

// ===========================================================================
// G. The accumulator keeps contact details across a virtualized scan
// ===========================================================================

test("contact details survive a section being unmounted mid-scan", () => {
  const accumulator = Core.createProfileAccumulator();

  // Scan 1 sees the top card only.
  accumulator.addContactPanel({ emails: ["nihal@example.com"], phones: [], cvLinks: [], websites: [] });
  const afterFirst = accumulator.signature();

  // Scan 2 is further down the page; the top card has been recycled away.
  accumulator.addContactPanel({
    emails: [],
    phones: ["+919876543210"],
    cvLinks: ["https://example.com/cv.pdf"],
    websites: []
  });

  assert.deepEqual(accumulator.emails(), ["nihal@example.com"], "the address read earlier must not be lost");
  assert.deepEqual(accumulator.phones(), ["+919876543210"]);
  assert.deepEqual(accumulator.cvLinks(), ["https://example.com/cv.pdf"]);
  assert.notEqual(accumulator.signature(), afterFirst, "new contact details must count as page change");
});

test("a contact detail arriving late stops the scan settling too early", () => {
  const accumulator = Core.createProfileAccumulator();
  accumulator.addSkill("React");
  const before = accumulator.signature();
  accumulator.addEmail("late@example.com");
  assert.notEqual(accumulator.signature(), before, "the quiet count must restart when contact data appears");
});

// ===========================================================================
// H. content.js routes through the tested policy
// ===========================================================================

test("profile extraction reads contact details on every snapshot, not once", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  assert.match(source, /collectRenderedContacts\(main, collector\)/, "contacts must be read every scan");
  assert.match(source, /collectFeaturedDocuments\(main, collector\)/, "so must CV documents");
  assert.match(source, /Core\.parseContactPanel\(/, "the panel parser must be the tested one");
  assert.match(source, /Core\.looksLikeCvLink\(/, "CV detection must be the tested one");
  assert.match(source, /Core\.parseOpenToWorkPanel\(/, "the open-to-work parser must be the tested one");
});

test("the rendered page is never swept for phone numbers, and never for other people", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  const start = source.indexOf("function collectRenderedContacts");
  const body = source.slice(start, source.indexOf("\n  }", start));
  assert.match(body, /allow: \["email"\]/, "only an address may come from the rendered page's text");

  // The structural half: a card that links to a different member is not this
  // member's card, whatever language the section heading is written in.
  assert.match(source, /function isForeignProfileContext/, "foreign sections must be recognised");
  assert.match(source, /FOREIGN_SECTION_PATTERN/, "the Interests-style sections must be listed");
  const links = source.slice(source.indexOf("function contactLinksIn"));
  assert.match(
    links.slice(0, links.indexOf("\n  }")),
    /isForeignProfileContext\(anchor, ownProfileUrl\)/,
    "a link inside another member's card is not a contact detail"
  );
});

test("a number that is really the profile's own URL is dropped from records already saved", () => {
  const saved = normalizeProfile({
    fullName: "Paarth Khandelwal",
    profileUrl: "https://www.linkedin.com/in/paarth-khandelwal-264954380",
    mobile: "264954380",
    phones: ["264954380", "+919876543210"]
  });
  assert.equal(saved.mobile, "+919876543210", "the surviving number becomes the primary");
  assert.deepEqual(saved.phones, ["+919876543210"]);

  const noneLeft = normalizeProfile({
    fullName: "Jhalak Agrawal",
    profileUrl: "https://www.linkedin.com/in/jhalak-agrawal-4a2248351",
    mobile: "2248351",
    phones: ["2248351"]
  });
  assert.equal(noneLeft.mobile, "", "and an empty mobile is better than a wrong one");
  assert.deepEqual(noneLeft.phones, []);
});

test("one stranger's details spread across many profiles can be found and removed", () => {
  const profiles = ["a", "b", "c", "d"].map((slug) => normalizeProfile({
    fullName: slug.toUpperCase(),
    profileUrl: `https://www.linkedin.com/in/${slug}`,
    emails: ["collab@badabusiness.com"],
    phones: ["9560278611", `98765${slug.charCodeAt(0)}0000`]
  }));
  const shared = findSharedContactValues(profiles, 3);
  assert.deepEqual(
    shared.map((entry) => entry.value).sort(),
    ["9560278611", "collab@badabusiness.com"],
    "only the values that appear on three or more different people"
  );

  const cleaned = stripSharedContactValues(profiles[0], shared);
  assert.deepEqual(cleaned.emails, [], "the stranger's address goes");
  assert.equal(cleaned.email, "", "and so does the primary derived from it");
  assert.equal(cleaned.phones.length, 1, "this member's own number stays");
  assert.equal(stripSharedContactValues(profiles[0], []), null, "nothing to remove reports no change");
});

test("the saved-profiles page repairs stored records and offers the shared-value cleanup", async () => {
  const source = await readFile(resolve(root, "src/react/dashboard.tsx"), "utf8");
  assert.match(source, /repairStoredProfiles\(\)/, "stored rows must be corrected, not only re-displayed");
  assert.match(source, /componentDidMount\(\) \{\s*\n\s*this\.repairThenReload\(\)/, "the repair runs before the table is shown");
  assert.match(source, /findSharedContactValues\(/, "the cross-profile cleanup must use the tested helper");
  assert.match(source, />Clean shared contacts</, "and it must be reachable from the toolbar");
});

test("the contact overlay is opened after the page has settled, on every profile", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");

  const start = source.indexOf("async function openContactInfoAndCollect");
  assert.ok(start > 0, "the overlay step must be its own function");
  const body = source.slice(start, source.indexOf("\n  }", source.indexOf("return added;", start)));

  // 3.7.1: the overlay is opened unconditionally. The old skip meant a profile
  // whose About showed an address never had its overlay read, so the number
  // sitting in that overlay was never collected.
  assert.ok(
    !/counts\.emails > 0 && counts\.phones > 0/.test(body),
    "the overlay must be opened even when the page already showed a contact detail"
  );
  assert.ok(!/already-visible/.test(body), "there is no longer a reason to skip it");
  assert.match(body, /if \(!isPageVisible\(\)\)/, "a hidden page is never clicked");
  assert.match(body, /closeOpenedDialog\(dialog\)/, "the overlay must be closed again");

  // The live defect: the overlay was read on the frame it appeared on, which is
  // the empty shell. It has to be waited for, re-read, and merged every poll.
  assert.match(body, /Core\.nextContactOverlayStep\(/, "the wait must use the tested settle policy");
  assert.match(body, /OPEN_TIMEOUT_MS/, "the modal must be waited for, not sampled a fixed few times");
  const loop = body.slice(body.indexOf("while (!step.done)"));
  assert.ok(loop.length > 0, "the load wait must be a loop");
  assert.match(loop, /collector\.data\.addContactPanel\(read\.panel\)/, "every poll must merge what it read");
  assert.match(loop, /contactDialogIsLoading\(dialog\)/, "a panel still showing placeholders is not finished");

  // The element it clicks comes from the tested policy, never from a selector.
  const finder = source.slice(source.indexOf("function findContactControl"));
  assert.match(
    finder.slice(0, finder.indexOf("\n  }")),
    /Connections\.classifyContactControl\(/,
    "the control must pass the tested policy before it is clicked"
  );

  // The shell mounts before its content, so the dialog has to be recognisable
  // while it is still empty — waiting for the words "Contact info" to appear in
  // innerText skipped the skeleton frame and, on a slow fetch, the whole wait.
  const dialogFinder = source.slice(source.indexOf("function findContactDialog"));
  const dialogFinderBody = dialogFinder.slice(0, dialogFinder.indexOf("\n  }"));
  assert.match(dialogFinderBody, /CONTACT_DIALOG_MARKER/, "a markup marker must identify the overlay on its own");
  assert.ok(
    !/if \(!text\) continue;/.test(dialogFinderBody),
    "an overlay with no text yet must not be skipped — that is the frame it mounts on"
  );

  // Ordering: the lazy scan finishes before anything is clicked.
  const extract = source.slice(source.indexOf("async function extractProfile"));
  const scanAt = extract.indexOf("performLazyScrollAndCollect(main, collector, diagnostics)");
  const clickAt = extract.indexOf("openContactInfoAndCollect(main, collector, diagnostics)");
  assert.ok(scanAt > 0 && clickAt > scanAt, "the click must never disturb the lazy-loading walk");

  // And the profile's own address is taken before the click, because the click
  // routes LinkedIn to /in/slug/overlay/contact-info/.
  const capturedAt = extract.indexOf("const profileUrl = canonicalizeProfileUrl(location.href)");
  assert.ok(capturedAt > 0, "the profile URL must be captured, not re-read at the end");
  assert.ok(capturedAt < clickAt, "and captured before the overlay is opened");
  assert.ok(
    !/profileUrl: canonicalizeProfileUrl\(location\.href\)/.test(extract),
    "the record must use the captured URL, not whatever the address bar shows by then"
  );
});

test("profile extraction still clicks nothing else at all", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  const clicks = source.match(/\.click\(\)/g) || [];
  // Three sites, and no more: the Contact info control, the Open to work card's
  // own Show details, and the one shared dismiss that closes either overlay.
  assert.equal(clicks.length, 3, `only two gated controls and one dismiss may be clicked, found ${clicks.length}`);
  const gated = source.match(/control\.element\.click\(\)/g) || [];
  assert.equal(gated.length, 2, "both openable controls must go through a classified verdict");
  assert.match(source, /dismiss\.click\(\)/, "and one dismiss closes whichever overlay was opened");
});

test("nothing is built until the page has been walked to the bottom and settled", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  const extract = source.slice(source.indexOf("async function extractProfile"));
  const scanAt = extract.indexOf("await performLazyScrollAndCollect(main, collector, diagnostics)");
  const buildAt = extract.indexOf("const profile = {");
  assert.ok(scanAt > 0 && buildAt > scanAt, "the record is assembled only after the whole page has been read");

  // collect -> scroll -> wait for the DOM to go quiet -> collect -> merge.
  const walk = source.slice(source.indexOf("async function performLazyScrollAndCollect"));
  const body = walk.slice(0, walk.indexOf("\n  }"));
  assert.match(body, /scrollProfileTo\(0, target\)/, "the walk starts at the top");
  assert.match(body, /snapshotPage\(main, collector, diagnostics\)/, "and collects before it moves");
  assert.match(body, /Core\.nextScanStep\(/, "each step comes from the tested policy");
  assert.match(body, /await waitForDomQuiet\(/, "and each step waits for the DOM to stop changing");
  assert.match(body, /scrollProfileTo\(originalY, target\)/, "the scroll position is restored");
  assert.match(body, /finally \{/, "even when the walk throws");

  // Five agreeing reads at the bottom, decided purely.
  assert.ok(Core.PROFILE_SCAN.QUIET_PASSES >= 5, "the requirement is at least five quiet scans");
  const atBottom = { position: 100, maxPosition: 100, viewportHeight: 800, signature: "same" };
  const nearly = Core.nextScanStep(
    Core.createScanState({ lastSignature: "same", unchangedPasses: Core.PROFILE_SCAN.QUIET_PASSES - 2 }),
    atBottom
  );
  assert.equal(nearly.done, false, "four agreeing reads at the bottom are not five");
  const settled = Core.nextScanStep(
    Core.createScanState({ lastSignature: "same", unchangedPasses: Core.PROFILE_SCAN.QUIET_PASSES - 1 }),
    atBottom
  );
  assert.equal(settled.done, true, "at the bottom, with five unchanged reads, the scan is finished");
  assert.equal(settled.reason, "settled");

  // And a signature that keeps changing keeps the scan going, however long it
  // has been sitting at the bottom.
  const stillArriving = Core.nextScanStep(
    Core.createScanState({ lastSignature: "same", unchangedPasses: 20 }),
    { ...atBottom, signature: "a phone number just arrived" }
  );
  assert.equal(stillArriving.done, false, "new priority data restarts the count");
});

// ===========================================================================
// I. Skills — every rendered name, and none of the chrome around it
// ===========================================================================

test("skill noise is refused and real skills are kept", () => {
  for (const noise of [
    "Endorse",
    "Endorsed by 12 people",
    "12 endorsements",
    "1,204",
    "Associated with Poornima Institute",
    "Associate Software Engineer at TechMatrix Consulting Endorse",
    "Show all 27 skills",
    "See more",
    "Interests",
    "Skills",
    "Top Voices",
    "Full-time",
    "Jan 2023 - Present"
  ]) {
    assert.equal(Core.isSkillValue(noise), false, `"${noise}" must never be stored as a skill`);
  }
  for (const skill of ["React", "Node.js", "C++", "Data Structures and Algorithms", "Public Speaking", "Adobe Premiere Pro"]) {
    assert.equal(Core.isSkillValue(skill), true, `"${skill}" is a skill`);
  }
});

test("accessibility text duplicated by LinkedIn collapses to one skill", () => {
  const accumulator = Core.createProfileAccumulator();
  accumulator.addSkill("DockerDocker");
  accumulator.addSkill("Docker");
  accumulator.addSkill("docker");
  accumulator.addSkill("Endorse");
  assert.deepEqual(accumulator.skills(), ["Docker"], "one name, however many times the DOM renders it");
  assert.equal(Core.collapseRepeatedText("couscous"), "couscous", "a real word that repeats is not a duplicate");
});

test("skills accumulate across the whole scroll rather than being replaced", () => {
  const accumulator = Core.createProfileAccumulator();
  // Scan 1 is at the top of the skills section; scan 2 is past it, and LinkedIn
  // has unmounted what scan 1 read.
  for (const value of ["React", "TypeScript"]) accumulator.addSkill(value);
  for (const value of ["Docker", "React"]) accumulator.addSkill(value);
  assert.deepEqual(accumulator.skills(), ["React", "TypeScript", "Docker"]);
});

// ===========================================================================
// J. Open to work — what the member says they are looking for
// ===========================================================================

test("the open-to-work panel is read field by field", () => {
  const panel = Core.parseOpenToWorkPanel({
    text: [
      "Job preferences",
      "Open to work",
      "Job titles",
      "Software Engineer, Frontend Developer",
      "Locations",
      "Bengaluru, Karnataka, India",
      "Location types",
      "On-site, Hybrid, Remote",
      "Job types",
      "Full-time, Internship",
      "Start date",
      "Immediately, actively applying",
      "Share with",
      "All LinkedIn members"
    ].join("\n")
  });
  assert.deepEqual(panel.titles, ["Software Engineer", "Frontend Developer"]);
  assert.deepEqual(panel.locations, ["Bengaluru", "Karnataka", "India"]);
  assert.deepEqual(panel.workplaceTypes, ["On-site", "Hybrid", "Remote"], "Location types is the workplace field");
  assert.deepEqual(panel.employmentTypes, ["Full-time", "Internship"]);
  assert.deepEqual(panel.availability, ["Immediately", "actively applying"]);
});

test("the panel becomes one labelled line per field that carried a value", () => {
  const lines = Core.formatOpenToWork({ titles: ["Software Engineer"], workplaceTypes: ["Remote"] });
  assert.deepEqual(lines, ["Open to work: Yes", "Job titles: Software Engineer", "Workplace types: Remote"]);
  assert.deepEqual(
    Core.formatOpenToWork({ titles: ["Engineer"] }, { open: false }),
    [],
    "a member who is not open to work records nothing"
  );
  assert.deepEqual(
    Core.formatOpenToWork({}),
    ["Open to work: Yes"],
    "the badge alone is still worth recording"
  );
});

test("an unrecognised heading closes the field rather than swallowing the next block", () => {
  const panel = Core.parseOpenToWorkPanel({
    text: "Job titles\nSoftware Engineer\nVisible to\nRecruiters only\nAbout this profile\nSomething else entirely"
  });
  assert.deepEqual(panel.titles, ["Software Engineer"]);
  assert.ok(!panel.titles.includes("Something else entirely"));
});

test("only the Open to work card's own Show details may be clicked", () => {
  const inside = {
    text: "Show details",
    onProfilePage: true,
    inOpenToWorkCard: true
  };
  assert.equal(Connections.classifyOpenToWorkControl(inside).allowed, true);
  assert.equal(
    Connections.classifyOpenToWorkControl({ ...inside, inOpenToWorkCard: false }).reason,
    "outside-open-to-work-card",
    "a Show details somewhere else on the page is refused"
  );
  assert.equal(
    Connections.classifyOpenToWorkControl({ ...inside, onProfilePage: false }).reason,
    "not-a-profile-page"
  );
  assert.equal(Connections.classifyOpenToWorkControl({ ...inside, text: "Show all 12 skills" }).allowed, false);
  // The denylist still beats the allowlist.
  const forbidden = Connections.classifyOpenToWorkControl({ ...inside, ariaLabel: "Message Nihal · Show details" });
  assert.equal(forbidden.allowed, false);
  assert.equal(forbidden.forbidden, true);
});

test("the open-to-work step is gated, waited for, and closed again", async () => {
  const source = await readFile(resolve(root, "extension/content-scripts/content.js"), "utf8");
  const start = source.indexOf("async function openToWorkDetails");
  assert.ok(start > 0, "the open-to-work step must be its own function");
  const body = source.slice(start, source.indexOf("\n  function visibleBodyText", start));

  assert.match(body, /findOpenToWorkCard\(main\)/, "the card has to be found before anything is clicked");
  assert.match(body, /findOpenToWorkControl\(card\)/, "and the control taken from inside it");
  assert.match(body, /if \(!isPageVisible\(\)\)/, "a hidden page is never clicked");
  assert.match(body, /Core\.nextContactOverlayStep\(/, "the panel must be waited for, not sampled once");
  assert.match(body, /closeOpenedDialog\(dialog\)/, "and closed again");

  const finder = source.slice(source.indexOf("function findOpenToWorkControl"));
  assert.match(
    finder.slice(0, finder.indexOf("\n  }")),
    /Connections\.classifyOpenToWorkControl\(/,
    "the control must pass the tested policy before it is clicked"
  );
  assert.match(finder, /inOpenToWorkCard: card\.contains\(element\)/, "membership of the card must be proven, not assumed");

  // Ordering: the scan finishes, then the contact overlay, then this.
  const extract = source.slice(source.indexOf("async function extractProfile"));
  const scanAt = extract.indexOf("performLazyScrollAndCollect(main, collector, diagnostics)");
  const openToWorkAt = extract.indexOf("await openToWorkDetails(main, diagnostics)");
  assert.ok(scanAt > 0 && openToWorkAt > scanAt, "a modal mid-scan would stop the lazy walk dead");
});

test("the extension still never touches a credential", async () => {
  for (const file of ["extension/content-scripts/content.js", "extension/content-scripts/connections.js", "src/background.ts", "src/collector-tabs-core.js"]) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.ok(!/document\.cookie/.test(source), `${file} must never read cookies`);
    assert.ok(!/chrome\.cookies/.test(source), `${file} must never use the cookies API`);
    assert.ok(!/type=["']password["']/.test(source), `${file} must never handle a password field`);
  }
});
