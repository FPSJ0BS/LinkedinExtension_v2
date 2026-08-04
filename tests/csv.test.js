import test from "node:test";
import assert from "node:assert/strict";
import { csvToProfiles, profilesToCsv } from "../src/csv.js";
import { normalizeProfile } from "../src/profile-utils.js";

test("CSV round trip preserves Unicode and multiline arrays", () => {
  const input = normalizeProfile({
    fullName: "निहाल शर्मा",
    profileUrl: "https://linkedin.com/in/example",
    skills: ["Node.js", "Data Science"],
    notes: "Line 1\nLine 2",
    source: "LinkedIn",
    collectedAt: "2026-07-31T00:00:00.000Z"
  });
  const parsed = csvToProfiles(profilesToCsv([input]));
  assert.equal(parsed[0].fullName, input.fullName);
  assert.deepEqual(parsed[0].skills, input.skills);
  assert.equal(parsed[0].notes, input.notes);
});

test("CSV neutralizes spreadsheet formulas", () => {
  const profile = normalizeProfile({ fullName: "=HYPERLINK(\"x\")", profileUrl: "https://linkedin.com/in/formula" });
  const csv = profilesToCsv([profile]);
  assert.match(csv, /'=HYPERLINK/);
});

test("CSV round trip preserves every institution and every skill", () => {
  const input = normalizeProfile({
    fullName: "A Person",
    profileUrl: "https://linkedin.com/in/grouped",
    education: ["Poornima Institute of Engineering & Technology", "Kendriya Vidyalaya", "NIT Jaipur"],
    skills: ["React", "Node.js", "TypeScript", "SQL", "Docker"],
    source: "LinkedIn",
    collectedAt: "2026-07-31T00:00:00.000Z"
  });
  const parsed = csvToProfiles(profilesToCsv([input]));
  assert.deepEqual(parsed[0].education, input.education, "all three institutions, in order");
  assert.deepEqual(parsed[0].skills, input.skills, "and every skill, not the three the table shows");
});
