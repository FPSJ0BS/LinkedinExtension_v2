/**
 * Messaging the applicant (3.10.0, rule 9k) — the composer is OPENED, never SENT.
 *
 * The feature this file guards is one applicant, one composer, one human pressing
 * Enter. The recruiter's own reviewed text is typed into LinkedIn's own message
 * box on the hiring page and left there; nothing in this extension finds, or
 * classifies as allowed, a control that would deliver it.
 *
 * Exactly ONE new control became clickable — the applicant panel's own `Message`
 * button — and it became clickable by lifting a token off the denylist, which is
 * the most dangerous kind of change this codebase makes. The tests below are
 * therefore weighted towards the REFUSALS rather than the one permission, and
 * two of them are written as properties over every purpose in `CONTROL_PURPOSE`
 * rather than as examples, because an example only proves the labels somebody
 * happened to think of.
 *
 * Everything runs against the pure core: there is no jsdom in this repository,
 * so the policy lives where it can be tested and the adapter only asks it.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The profile core first — the applicants core reuses its text cleaning, and
// `normalizeLabel`/`cleanText` fall back to their own copies without it, so
// loading it in the same order the adapter does is what makes these assertions
// describe the shipped behaviour rather than the fallback's.
await import("../src/extraction-core.js");
await import("../src/applicants-core.js");
const Applicants = globalThis.ProfileVaultApplicants;
const PURPOSE = Applicants.CONTROL_PURPOSE;
const MATCH = Applicants.COMPOSER_MATCH;

/** Ask the classifier for the composer, from inside the panel unless told otherwise. */
function forCompose(options = {}) {
  return Applicants.classifyApplicantControl({
    purpose: PURPOSE.MESSAGE_COMPOSE,
    inContainer: true,
    ...options
  });
}

// --------------------------------------------------------------- A. the one control

test("the panel's own Message button is the one control this feature adds, and it is allowed only from inside the panel", () => {
  const plain = forCompose({ text: "Message" });
  assert.equal(plain.allowed, true);
  assert.equal(plain.forbidden, false);
  assert.equal(plain.reason, "message-compose");
  assert.equal(plain.purpose, PURPOSE.MESSAGE_COMPOSE);

  // The accessible-name idiom this file already documents for the overflow menu:
  // the button reads `Message` on screen and names the applicant to a screen
  // reader. Both halves are read, and the person's own name must not disqualify
  // the control that exists to message them.
  const named = forCompose({ text: "Message", ariaLabel: "Message Gaurang Agarwal" });
  assert.equal(named.allowed, true);
  assert.equal(named.reason, "message-compose");

  // The same control on a layout that paints no visible text at all: the
  // accessible name is then the only string there is, and it still reads as this
  // applicant's own composer.
  const ariaOnly = forCompose({ text: "", ariaLabel: "Message Gaurang Agarwal" });
  assert.equal(ariaOnly.allowed, true);
  assert.equal(ariaOnly.reason, "message-compose");
});

test("`Message` outside the applicant panel is refused, because the global nav and the messaging overlay both render that exact label", () => {
  // The panel is the proof of WHO the composer would be addressed to. Without
  // it, `Message` is the nav item, the overlay's own compose button, or a
  // control in a row of some other recruiter tool — none of them this applicant.
  const outside = forCompose({ text: "Message", inContainer: false });
  assert.equal(outside.allowed, false);
  assert.equal(outside.reason, "outside-applicant-panel");
  // Refused, but not as a forbidden ACTION: the label is fine, the location is
  // not, and the two failures have different fixes.
  assert.equal(outside.forbidden, false);
});

test("every control that would actually deliver a message is refused as a forbidden action, Send and InMail above all", () => {
  for (const label of ["Send", "Send message", "InMail", "Send InMail"]) {
    const verdict = forCompose({ text: label });
    assert.equal(verdict.allowed, false, `${label} must never be allowed`);
    assert.equal(verdict.forbidden, true, `${label} must be refused BY THE DENYLIST`);
    assert.equal(verdict.reason, "forbidden-action", `${label} must say why`);
  }
});

test("a control offering to message a SET of applicants is refused before `inContainer` is even consulted — bulk messaging is the thing this feature is built not to do", () => {
  for (const label of ["Message all", "Message everyone", "Message selected", "Message all applicants"]) {
    const verdict = forCompose({ text: label });
    assert.equal(verdict.allowed, false, `${label} must never be allowed`);
    assert.equal(verdict.forbidden, true, `${label} must stay on the denylist`);
    assert.equal(verdict.reason, "forbidden-action");
  }

  // The dangerous shape, and the reason the tail is asked of the accessible name
  // as well as the text: the button reads a harmless `Message` and only its
  // aria-label admits it addresses the whole list.
  const bulkAria = forCompose({ text: "Message", ariaLabel: "Message all 665 applicants" });
  assert.equal(bulkAria.allowed, false, "a bulk control must not be rescued by sitting in the right panel");
  assert.equal(bulkAria.forbidden, true);
  assert.equal(bulkAria.reason, "forbidden-action");
});

test("every ATS action sitting inches from the Message button stays refused — pressing one writes to the recruiter's own hiring pipeline", () => {
  for (const label of ["Rate as", "Reject", "Shortlist", "Move to", "Archive", "Hire", "Save", "Add note", "Add a note"]) {
    const verdict = forCompose({ text: label });
    assert.equal(verdict.allowed, false, `${label} must never be allowed`);
    assert.equal(verdict.forbidden, true, `${label} must be refused by the denylist`);
    assert.equal(verdict.reason, "forbidden-action", `${label} must say why`);
  }
});

test("`See full profile` is refused as navigating away, because leaving the applicants page takes the panel, the list and the pager with it", () => {
  const verdict = forCompose({ text: "See full profile" });
  assert.equal(verdict.allowed, false);
  // The same reason string the disclosure branch uses, so the two branches
  // cannot disagree about what that control is.
  assert.equal(verdict.reason, "navigates-away");
});

test("the overflow menu opener is refused as not-a-message-control rather than mistaken for the composer", () => {
  for (const label of ["More...", "More…"]) {
    const verdict = forCompose({ text: label });
    assert.equal(verdict.allowed, false, `${label} must not open the composer`);
    assert.equal(verdict.reason, "not-a-message-control", `${label} must say what it is not`);
  }
});

// ------------------------------------------- B. the central safety property

test("the `message` token is exempted for MESSAGE_COMPOSE and for NOTHING ELSE — every other purpose still refuses `Message` as a forbidden action", () => {
  const purposes = Object.entries(PURPOSE).filter(([, value]) => value !== PURPOSE.MESSAGE_COMPOSE);
  assert.ok(purposes.length >= 6, "the loop must actually cover the other purposes");

  for (const [name, value] of purposes) {
    const verdict = Applicants.classifyApplicantControl({
      text: "Message",
      purpose: value,
      inContainer: true,
      // Supplied so the pagination branch has its proof and cannot be refused
      // for the wrong reason: the point is that the DENYLIST stops it first.
      currentPage: 1
    });
    assert.equal(verdict.allowed, false, `${name} must not open a Message control`);
    assert.equal(verdict.forbidden, true, `${name} must refuse Message by the denylist`);
    assert.equal(verdict.reason, "forbidden-action", `${name} must say forbidden-action`);
  }

  // …and the exemption is still there for the one purpose that needs it, so this
  // test fails if somebody "fixes" it by removing the exemption altogether.
  assert.equal(forCompose({ text: "Message" }).allowed, true);
});

test("NO purpose, including MESSAGE_COMPOSE, ever allows Send or InMail — this is the mechanism behind \"the extension never sends\", not a promise in a comment", () => {
  const senders = ["Send", "Send message", "InMail", "Send InMail", "Press Enter to Send"];
  const purposes = Object.entries(PURPOSE);
  assert.ok(purposes.length >= 7, "the loop must cover every purpose the core defines");

  for (const [name, value] of purposes) {
    for (const label of senders) {
      const byText = Applicants.classifyApplicantControl({
        text: label, purpose: value, inContainer: true, currentPage: 1
      });
      assert.equal(byText.allowed, false, `${name} must never allow "${label}"`);
      assert.equal(byText.forbidden, true, `${name} must refuse "${label}" by the denylist`);

      // The same control named only to a screen reader — a paper-plane glyph
      // whose accessible name is `Send` is exactly the shape this must catch.
      const byAria = Applicants.classifyApplicantControl({
        text: "", ariaLabel: label, purpose: value, inContainer: true, currentPage: 1
      });
      assert.equal(byAria.allowed, false, `${name} must never allow aria-label "${label}"`);
      assert.equal(byAria.forbidden, true, `${name} must refuse aria-label "${label}" by the denylist`);
    }
  }
});

test("the allowlist pattern is anchored on the whole label, which is WHY no Send control can match it", () => {
  // Asserted on the predicate rather than only through the classifier, because
  // this anchoring is the load-bearing part: a pattern that merely CONTAINED
  // `message` would allow the composer's own `Send message` button.
  assert.equal(Applicants.isApplicantMessageControlLabel("Message"), true);
  assert.equal(Applicants.isApplicantMessageControlLabel("Message Gaurang Agarwal"), true);
  assert.equal(Applicants.isApplicantMessageControlLabel("Send message"), false);
  assert.equal(Applicants.isApplicantMessageControlLabel("Send"), false);
  assert.equal(Applicants.isApplicantMessageControlLabel("Message via InMail"), false);
  assert.equal(Applicants.isApplicantMessageControlLabel("Next: Message"), false);
  assert.equal(Applicants.isApplicantMessageControlLabel(""), false);
  // The bulk tail is refused on the label and on the accessible name alike.
  assert.equal(Applicants.isApplicantMessageControlLabel("Message all"), false);
  assert.equal(Applicants.isApplicantMessageControlLabel("Message", "message message all 665 applicants"), false);
});

// ------------------------------------------------- C. who the composer is addressed to

test("a composer is only this applicant's when it says so itself — the profile URL is the identity, and a tracking query cannot make one person look like two", () => {
  const verdict = Applicants.verifyComposerRecipient({
    expected: { profileUrl: "https://www.linkedin.com/in/gaurang-agarwal", name: "Gaurang Agarwal" },
    observed: { profileUrls: ["https://www.linkedin.com/in/Gaurang-Agarwal?trk=hiring_messaging"], names: ["Gaurang Agarwal"] }
  });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.reason, MATCH.PROFILE);
  assert.equal(verdict.on, "/in/gaurang-agarwal");
});

test("the recipient pill's name is accepted when there is no profile link, and whitespace in it is not a different person", () => {
  const verdict = Applicants.verifyComposerRecipient({
    expected: { name: "Gaurang Agarwal" },
    observed: { names: ["Gaurang  Agarwal"] }
  });
  assert.equal(verdict.matched, true);
  assert.equal(verdict.reason, MATCH.NAME);
});

test("a composer left open on the PREVIOUS applicant is refused as a different recipient — this is the failure that would send one applicant's message to another", () => {
  const byUrl = Applicants.verifyComposerRecipient({
    expected: { profileUrl: "/in/gaurang-agarwal", name: "Gaurang Agarwal" },
    observed: { profileUrls: ["/in/komal-sharma"], names: ["Komal Sharma"] }
  });
  assert.equal(byUrl.matched, false);
  assert.equal(byUrl.reason, MATCH.MISMATCH);
  assert.equal(byUrl.on, "/in/komal-sharma");

  const byName = Applicants.verifyComposerRecipient({
    expected: { name: "Gaurang Agarwal" },
    observed: { names: ["Komal Sharma"] }
  });
  assert.equal(byName.matched, false);
  assert.equal(byName.reason, MATCH.MISMATCH);
});

test("a group thread is refused outright — this feature addresses one applicant at a time, and a second recipient is a stranger reading the message", () => {
  const names = Applicants.verifyComposerRecipient({
    expected: { name: "Gaurang Agarwal" },
    observed: { names: ["Gaurang Agarwal", "Komal Sharma"] }
  });
  assert.equal(names.matched, false);
  assert.equal(names.reason, MATCH.MULTIPLE);

  // Refused even when the intended applicant IS one of them: being present in a
  // group is not being the recipient.
  const urls = Applicants.verifyComposerRecipient({
    expected: { profileUrl: "/in/gaurang-agarwal" },
    observed: { profileUrls: ["/in/gaurang-agarwal", "/in/komal-sharma"] }
  });
  assert.equal(urls.matched, false);
  assert.equal(urls.reason, MATCH.MULTIPLE);
});

test("SILENCE IS NEVER A MATCH: a composer that names nobody is unknown-recipient, never assumed to be the applicant on screen", () => {
  const nothing = Applicants.verifyComposerRecipient({
    expected: { profileUrl: "/in/gaurang-agarwal", name: "Gaurang Agarwal" },
    observed: {}
  });
  assert.equal(nothing.matched, false);
  assert.equal(nothing.reason, MATCH.UNKNOWN);
  assert.equal(nothing.on, "");

  // Empty lists, blank strings and whitespace are all the same silence.
  const blank = Applicants.verifyComposerRecipient({
    expected: { name: "Gaurang Agarwal" },
    observed: { profileUrls: [], names: ["", "   "] }
  });
  assert.equal(blank.matched, false);
  assert.equal(blank.reason, MATCH.UNKNOWN);

  // Nothing expected either — an unknown intended applicant cannot be matched
  // against an unknown observed one and call the result agreement.
  const neither = Applicants.verifyComposerRecipient({ expected: {}, observed: {} });
  assert.equal(neither.matched, false);
  assert.equal(neither.reason, MATCH.UNKNOWN);

  // No arguments at all still refuses rather than throwing.
  assert.equal(Applicants.verifyComposerRecipient().matched, false);
});

// ------------------------------------------------------ D. may the text be typed?

test("a clean insertion into an empty composer addressed to the right person is the only shape that is allowed", () => {
  const plan = Applicants.planComposerInsertion({
    text: "Hi Gaurang, thanks for applying.",
    existingText: "",
    blocked: false,
    recipient: { matched: true, reason: MATCH.PROFILE, on: "/in/gaurang-agarwal" }
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.reason, "insertable");
  // Verbatim: nothing is generated and nothing is rewritten on the way in.
  assert.equal(plan.text, "Hi Gaurang, thanks for applying.");
});

test("a message the preview blocked never reaches the page — an unresolved variable is a wrong value, and a wrong value is worse than a blank one", () => {
  const plan = Applicants.planComposerInsertion({
    text: "Hi {{first_name}}, thanks for applying.",
    blocked: true,
    recipient: { matched: true, reason: MATCH.PROFILE }
  });
  assert.equal(plan.allowed, false);
  assert.equal(plan.reason, "message-blocked");
  assert.equal(plan.text, "");
});

test("a blank or whitespace-only message is refused as empty rather than typed as nothing and reported as sent", () => {
  for (const text of ["", "   ", "\n\n", "\t \r\n "]) {
    const plan = Applicants.planComposerInsertion({
      text,
      recipient: { matched: true, reason: MATCH.NAME }
    });
    assert.equal(plan.allowed, false, `${JSON.stringify(text)} must be refused`);
    assert.equal(plan.reason, "empty-message");
    assert.equal(plan.text, "");
  }
});

test("a composer that already holds the recruiter's own draft is REFUSED — never appended to and never cleared, because a human wrote that text", () => {
  const plan = Applicants.planComposerInsertion({
    text: "Hi Gaurang, thanks for applying.",
    existingText: "Hi — I was half way through writing this",
    recipient: { matched: true, reason: MATCH.PROFILE }
  });
  assert.equal(plan.allowed, false, "it must not proceed");
  assert.equal(plan.reason, "composer-not-empty", "it must say why, so the user can act on it");
  // The two ways this could silently corrupt a human's work, asserted as absent:
  // the plan carries no merged text to append and no empty string to clear with.
  assert.equal(plan.text, "");
  assert.ok(!plan.allowed, "there is no branch where a non-empty composer is written to");
  assert.ok(!("clear" in plan), "the plan must not offer to clear what the user typed");
  assert.ok(!("append" in plan), "the plan must not offer to append to what the user typed");

  // Whitespace in the box is not the user's draft, so it does not block: the
  // refusal is about content, not about a stray newline a contenteditable left.
  const onlyWhitespace = Applicants.planComposerInsertion({
    text: "Hi Gaurang.",
    existingText: "   \n ",
    recipient: { matched: true, reason: MATCH.PROFILE }
  });
  assert.equal(onlyWhitespace.allowed, true);
});

test("the recipient is re-asked at the last point before the text leaves, so no caller can skip the check — and its own reason travels through", () => {
  const mismatch = Applicants.planComposerInsertion({
    text: "Hi Gaurang.",
    recipient: { matched: false, reason: MATCH.MISMATCH, on: "/in/komal-sharma" }
  });
  assert.equal(mismatch.allowed, false);
  assert.equal(mismatch.reason, MATCH.MISMATCH);
  assert.equal(mismatch.text, "");

  const multiple = Applicants.planComposerInsertion({
    text: "Hi Gaurang.",
    recipient: { matched: false, reason: MATCH.MULTIPLE }
  });
  assert.equal(multiple.allowed, false);
  assert.equal(multiple.reason, MATCH.MULTIPLE);

  // A recipient that was never verified at all is the same refusal as one that
  // failed: absence of a check is not a passed check.
  for (const recipient of [null, undefined, {}]) {
    const plan = Applicants.planComposerInsertion({ text: "Hi Gaurang.", recipient });
    assert.equal(plan.allowed, false, `${JSON.stringify(recipient)} must be refused`);
    assert.equal(plan.reason, MATCH.UNKNOWN);
  }

  // `matched` must be exactly true — a truthy string is not a verification.
  const truthy = Applicants.planComposerInsertion({
    text: "Hi Gaurang.",
    recipient: { matched: "yes", reason: MATCH.NAME }
  });
  assert.equal(truthy.allowed, false, "only a real boolean match may insert");

  // No arguments at all refuses rather than throwing.
  assert.equal(Applicants.planComposerInsertion().allowed, false);
});

// --------------------------------------------- E. did the text actually land?

test("the composer's text is compared whitespace-insensitively, because a contenteditable renders its own line breaks", () => {
  assert.equal(
    Applicants.composerTextMatches("Hi Gaurang,\n\n  Thanks for applying.", "Hi Gaurang, Thanks for applying."),
    true
  );
  assert.equal(Applicants.composerTextMatches("Hi Gaurang.", "Hi Gaurang."), true);
  assert.equal(Applicants.composerTextMatches("Hi Gaurang.", "Hi Komal."), false);
});

test("AN EMPTY BOX NEVER MATCHES THE INTENDED TEXT — this is what stops an insertion that silently did nothing from being reported as a success", () => {
  assert.equal(Applicants.composerTextMatches("", "Hi Gaurang, thanks for applying."), false);
  assert.equal(Applicants.composerTextMatches("   ", "Hi Gaurang, thanks for applying."), false);
  // And two blanks are not agreement either: there is no text to have landed, so
  // there is nothing to confirm.
  assert.equal(Applicants.composerTextMatches("", ""), false);
  assert.equal(Applicants.composerTextMatches("Hi Gaurang.", ""), false);
  assert.equal(Applicants.composerTextMatches(null, undefined), false);
});

// -------------------------------------------------------- F. one canonical identity

test("a profile URL is reduced to `/in/<slug>` so a tracking query, a hash or a capital letter cannot make one applicant look like two", () => {
  const canonical = "/in/gaurang-agarwal";
  assert.equal(Applicants.canonicalApplicantProfileUrl("https://www.linkedin.com/in/gaurang-agarwal"), canonical);
  assert.equal(Applicants.canonicalApplicantProfileUrl("https://www.linkedin.com/in/Gaurang-Agarwal/"), canonical);
  assert.equal(Applicants.canonicalApplicantProfileUrl("https://www.linkedin.com/in/gaurang-agarwal?trk=hiring"), canonical);
  assert.equal(Applicants.canonicalApplicantProfileUrl("https://www.linkedin.com/in/gaurang-agarwal#experience"), canonical);
  assert.equal(Applicants.canonicalApplicantProfileUrl("https://www.linkedin.com/in/gaurang-agarwal/details/experience/"), canonical);
  // The bare path a rendered link often carries.
  assert.equal(Applicants.canonicalApplicantProfileUrl("/in/gaurang-agarwal"), canonical);
  assert.equal(Applicants.canonicalApplicantProfileUrl("  /in/Gaurang-Agarwal?trk=x  "), canonical);
});

test("anything that is not a member address canonicalises to an empty string rather than to a guess, so it can never be mistaken for a match", () => {
  for (const junk of ["", "   ", "not a url", "https://www.linkedin.com/hiring/applicants/?jobId=4277798308",
    "https://www.linkedin.com/company/acme/", "https://www.linkedin.com/in/", null, undefined, 42]) {
    assert.equal(
      Applicants.canonicalApplicantProfileUrl(junk),
      "",
      `${JSON.stringify(junk)} must not canonicalise to a slug`
    );
  }

  // And an empty canonical URL is not an identity: two records that both fail to
  // canonicalise are not thereby the same person.
  const verdict = Applicants.verifyComposerRecipient({
    expected: { profileUrl: "not a url" },
    observed: { profileUrls: ["also not a url"] }
  });
  assert.equal(verdict.matched, false);
  assert.equal(verdict.reason, MATCH.UNKNOWN);
});
