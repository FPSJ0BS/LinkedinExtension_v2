import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeProfileUrl, linesToArray, mergeProfiles, normalizeProfile, replaceProfile } from "../src/profile-utils.js";

test("canonicalizes LinkedIn profile URLs", () => {
  assert.equal(canonicalizeProfileUrl("https://www.linkedin.com/in/example/?trk=test#about"), "https://www.linkedin.com/in/example");
});

test("normalizes arrays and derives name parts", () => {
  const profile = normalizeProfile({ fullName: "Nihal Sharma", profileUrl: "https://linkedin.com/in/nihal/", skills: "React\nNode.js\nReact" });
  assert.equal(profile.firstName, "Nihal");
  assert.equal(profile.lastName, "Sharma");
  assert.deepEqual(profile.skills, ["React", "Node.js"]);
});

test("merges non-empty scalar and array values", () => {
  const existing = normalizeProfile({ fullName: "A Person", profileUrl: "https://linkedin.com/in/a", notes: "Old", skills: ["JS"] });
  const incoming = normalizeProfile({ fullName: "A Person", profileUrl: "https://linkedin.com/in/a", notes: "New", skills: ["TS"] });
  const merged = mergeProfiles(existing, incoming);
  assert.equal(merged.notes, "New");
  assert.deepEqual(merged.skills.sort(), ["JS", "TS"]);
});

test("merging keeps every contact detail from both records", () => {
  const existing = normalizeProfile({
    fullName: "A Person", profileUrl: "https://linkedin.com/in/a", emails: ["first@example.com"]
  });
  const incoming = normalizeProfile({
    fullName: "A Person", profileUrl: "https://linkedin.com/in/a", emails: ["second@example.com"], mobile: "+919876543210"
  });
  const merged = mergeProfiles(existing, incoming);
  assert.deepEqual(merged.emails.sort(), ["first@example.com", "second@example.com"]);
  assert.equal(merged.mobile, "+919876543210");
});

test("converts editable lines to a deduplicated array", () => {
  assert.deepEqual(linesToArray("One; Two\nOne"), ["One; Two", "One"]);
});


test("merge replaces newly extracted institutions instead of retaining stale ones", () => {
  const existing = normalizeProfile({ fullName: "A Person", profileUrl: "https://linkedin.com/in/a", education: ["Old fragment", "More old fragment"] });
  const incoming = normalizeProfile({ fullName: "A Person", profileUrl: "https://linkedin.com/in/a", education: ["NIT Jaipur"] });
  const merged = mergeProfiles(existing, incoming);
  assert.deepEqual(merged.education, ["NIT Jaipur"]);
});


// A section is read whole or not at all, so a fresh read of one replaces it.
// Concatenating would produce the same card twice the moment one read caught the
// section mid-hydration — which is exactly what every scan's first pass does.
test("a fresh read replaces a whole section and never concatenates two copies of it", () => {
  const url = "https://linkedin.com/in/a";
  const existing = normalizeProfile({
    fullName: "A Person",
    profileUrl: url,
    educationDetails: ["BIT Sindri"],
    experience: ["Lecturer — The Narayana Group"],
    interests: ["Stale Interest"]
  });
  const incoming = normalizeProfile({
    fullName: "A Person",
    profileUrl: url,
    educationDetails: ["BIT Sindri — BTEC, Chemical Engineering · 2019 – 2023"],
    experience: ["Senior Lecturer — The Narayana Group · Jun 2023 - Present"],
    interests: ["Motion Education Pvt Ltd"]
  });
  const merged = mergeProfiles(existing, incoming);
  assert.deepEqual(merged.educationDetails, ["BIT Sindri — BTEC, Chemical Engineering · 2019 – 2023"]);
  assert.deepEqual(merged.experience, ["Senior Lecturer — The Narayana Group · Jun 2023 - Present"]);
  assert.deepEqual(merged.interests, ["Motion Education Pvt Ltd"]);
});

test("a profile that rendered only its About and location is collected, not partial", () => {
  // The Status column judges the record on what the run is FOR, and this release
  // widened what that is: a member with no email and no CV who nonetheless
  // rendered a location, an About and three roles is a collected profile.
  const profile = normalizeProfile({
    fullName: "A Person",
    profileUrl: "https://linkedin.com/in/a",
    location: "India",
    about: "A paragraph."
  });
  assert.equal(profile.status, "collected");
  const empty = normalizeProfile({ fullName: "A Person", profileUrl: "https://linkedin.com/in/b" });
  assert.equal(empty.status, "partial", "and a profile that rendered nothing still says so");
});

test("replaceProfile removes previous extracted details while preserving record identity", () => {
  const existing = normalizeProfile({
    fullName: "Old Name",
    profileUrl: "https://linkedin.com/in/person",
    email: "old@example.com",
    education: ["Old School"],
    skills: ["COBOL"],
    notes: "Kept by hand",
    tags: ["shortlist"]
  });
  const incoming = normalizeProfile({
    fullName: "New Name",
    profileUrl: "https://linkedin.com/in/person",
    email: "new@example.com",
    education: ["Alike Consulting Institute", "HCL Academy"]
  });
  const replaced = replaceProfile(existing, incoming);
  assert.equal(replaced.id, existing.id);
  assert.equal(replaced.collectedAt, existing.collectedAt);
  assert.equal(replaced.email, "new@example.com");
  assert.deepEqual(replaced.education, ["Alike Consulting Institute", "HCL Academy"]);
  assert.equal(replaced.skills.length, 0, "an extracted field the new read did not carry is cleared");
  assert.equal(replaced.notes, "Kept by hand", "and what the user wrote survives");
  assert.deepEqual(replaced.tags, ["shortlist"]);
});
