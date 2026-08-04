import test from "node:test";
import assert from "node:assert/strict";
await import("../src/connections-core.js");
const Core = globalThis.ProfileVaultConnections;

const BASE = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

test("canonicalizes connection links to a bare /in/ profile URL", () => {
  assert.equal(
    Core.canonicalizeConnectionUrl("https://www.linkedin.com/in/example-person/?trk=connections#top"),
    "https://www.linkedin.com/in/example-person"
  );
  assert.equal(
    Core.canonicalizeConnectionUrl("/in/example-person/details/experience/", BASE),
    "https://www.linkedin.com/in/example-person"
  );
  assert.equal(
    Core.canonicalizeConnectionUrl("https://in.linkedin.com/in/example-person"),
    "https://www.linkedin.com/in/example-person"
  );
});

test("rejects links that are not member profiles", () => {
  for (const href of [
    "https://www.linkedin.com/company/acme/",
    "https://www.linkedin.com/school/example/",
    "https://www.linkedin.com/feed/",
    "https://example.com/in/example-person",
    "javascript:void(0)",
    "/in/me",
    ""
  ]) {
    assert.equal(Core.canonicalizeConnectionUrl(href, BASE), "", `expected "${href}" to be rejected`);
  }
});

test("deduplicates discovered profiles and preserves first-seen order", () => {
  const urls = Core.dedupeProfileUrls([
    "/in/alpha-person/",
    "https://www.linkedin.com/in/beta-person?trk=x",
    "/in/ALPHA-PERSON",
    "https://www.linkedin.com/company/acme",
    "/in/beta-person/details/skills/",
    "/in/gamma-person"
  ], BASE);

  assert.deepEqual(urls, [
    "https://www.linkedin.com/in/alpha-person",
    "https://www.linkedin.com/in/beta-person",
    "https://www.linkedin.com/in/gamma-person"
  ]);
});

test("recognizes both connections page URL shapes", () => {
  assert.equal(Core.isConnectionsPage("https://www.linkedin.com/mynetwork/invite-connect/connections/"), true);
  assert.equal(Core.isConnectionsPage("https://www.linkedin.com/mynetwork/connections/"), true);
  assert.equal(Core.isConnectionsPage("https://www.linkedin.com/feed/"), false);
  assert.equal(Core.isConnectionsPage("https://example.com/mynetwork/connections/"), false);
});

test("detects a CAPTCHA challenge from visible text", () => {
  const result = Core.detectChallenge({
    url: "https://www.linkedin.com/in/example-person",
    title: "Security Verification",
    bodyText: "Let's do a quick security verification before you continue."
  });
  assert.equal(result.challenged, true);
  assert.equal(result.kind, "captcha");
});

test("detects checkpoint and login URLs before reading page text", () => {
  const checkpoint = Core.detectChallenge({ url: "https://www.linkedin.com/checkpoint/challenge/", bodyText: "" });
  assert.equal(checkpoint.challenged, true);
  assert.equal(checkpoint.kind, "checkpoint");

  const login = Core.detectChallenge({ url: "https://www.linkedin.com/authwall?trk=x", bodyText: "" });
  assert.equal(login.challenged, true);
  assert.equal(login.kind, "login");
});

test("detects unusual activity, restriction, and unavailable profiles", () => {
  assert.equal(
    Core.detectChallenge({ url: "https://www.linkedin.com/feed/", bodyText: "We noticed some unusual activity on your account." }).kind,
    "unusual-activity"
  );
  assert.equal(
    Core.detectChallenge({ url: "https://www.linkedin.com/feed/", bodyText: "Your account has been restricted." }).kind,
    "restriction"
  );
  assert.equal(
    Core.detectChallenge({ url: "https://www.linkedin.com/in/gone", bodyText: "This page doesn't exist" }).kind,
    "unavailable"
  );
});

test("detects rate-limit warnings as a challenge", () => {
  const result = Core.detectChallenge({
    url: "https://www.linkedin.com/mynetwork/invite-connect/connections/",
    bodyText: "You've reached the weekly limit for this feature."
  });
  assert.equal(result.challenged, true);
  assert.equal(result.kind, "rate-limit");
});

// ------------------------------------------- phase 21: advertised total count

test("reads the advertised connection total", () => {
  assert.deepEqual(Core.parseConnectionCount("1,234 connections"), { total: 1234, reliable: true });
  assert.deepEqual(Core.parseConnectionCount("Connections 842"), { total: 842, reliable: true });
  assert.deepEqual(Core.parseConnectionCount("1 connection"), { total: 1, reliable: true });
});

test("a rounded total is captured but marked unreliable", () => {
  const parsed = Core.parseConnectionCount("500+ connections");
  assert.equal(parsed.total, 500);
  assert.equal(parsed.reliable, false, "a rounded total must never be used to confirm coverage");
});

test("text without a usable total returns null", () => {
  for (const text of ["Connections", "Manage your network", "", "Grow your network"]) {
    assert.equal(Core.parseConnectionCount(text).total, null, `"${text}" must not yield a total`);
  }
});

// ------------------------------------ D1: pagination allowlist / action denylist

test("allowlisted pagination controls inside the connections list may be clicked", () => {
  for (const label of ["Load more", "Load more results", "Show more results", "Next", "Next page", "View more"]) {
    const verdict = Core.classifyControl({ text: label, inConnectionsList: true });
    assert.equal(verdict.allowed, true, `"${label}" should be clickable pagination`);
    assert.equal(verdict.forbidden, false);
    assert.equal(verdict.reason, "pagination");
  }
});

test("outreach and relationship controls are permanently forbidden", () => {
  // "Contact info" left this list in 3.5.0 — it is now the second clickable
  // control, on profile pages only, and tests/contact-extraction.test.js covers
  // it. Everything here sends a message, changes a relationship, or contacts
  // somebody, and stays forbidden forever.
  const forbidden = [
    "Connect", "Follow", "Unfollow", "Message", "InMail",
    "Endorse", "Remove connection", "Withdraw", "Invite", "Report", "Block",
    "Send", "Share", "Accept", "Ignore", "Save"
  ];
  for (const label of forbidden) {
    const verdict = Core.classifyControl({ text: label, inConnectionsList: true });
    assert.equal(verdict.allowed, false, `"${label}" must never be clickable`);
    assert.equal(verdict.forbidden, true, `"${label}" must be flagged forbidden`);
  }
});

test("the contact control is still not clickable as connections pagination", () => {
  // Un-forbidding it must not make it a pagination control by accident.
  const verdict = Core.classifyControl({ text: "Contact info", inConnectionsList: true });
  assert.equal(verdict.allowed, false, "it is never clicked to reveal more connections");
  assert.equal(verdict.reason, "not-allowlisted");
});

test("a forbidden action wins even when disguised with a pagination aria-label", () => {
  const verdict = Core.classifyControl({ text: "Connect", ariaLabel: "Load more", inConnectionsList: true });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.forbidden, true);
});

test("pagination outside the connections list is refused", () => {
  const verdict = Core.classifyControl({ text: "Load more", inConnectionsList: false });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "outside-connections-list");
});

test("unknown labels are refused rather than guessed", () => {
  for (const label of ["Continue", "OK", "Open", "Sort by", ""]) {
    const verdict = Core.classifyControl({ text: label, inConnectionsList: true });
    assert.equal(verdict.allowed, false, `"${label}" must not be assumed to be pagination`);
  }
});

test("label helpers agree with the classifier", () => {
  assert.equal(Core.isPaginationLabel("Load more"), true);
  assert.equal(Core.isPaginationLabel("Connect"), false);
  assert.equal(Core.isForbiddenLabel("Send InMail"), true);
  assert.equal(Core.isForbiddenLabel("Load more"), false);
});

test("a normal profile page is not treated as a challenge", () => {
  const result = Core.detectChallenge({
    url: "https://www.linkedin.com/in/example-person",
    title: "Example Person | LinkedIn",
    bodyText: "Experience Education Skills Senior Engineer at Acme"
  });
  assert.equal(result.challenged, false);
  assert.equal(result.kind, "");
});
