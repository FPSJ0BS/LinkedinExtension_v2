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

test("CSV round trip preserves the whole of education, experience and interests", () => {
  const input = normalizeProfile({
    fullName: "Isha Sharma",
    profileUrl: "https://linkedin.com/in/isha-sharma",
    headline: "working with Narayana Institute",
    location: "India",
    about: "A paragraph.\nAnd a second line.",
    education: ["BIT Sindri"],
    educationDetails: ["BIT Sindri — BTEC, Chemical Engineering · 2019 – 2023"],
    experience: [
      "Senior Lecturer — The Narayana Group · Full-time · Jun 2023 - Present · 3 yrs 3 mos · Hyderabad, Telangana, India"
    ],
    interests: ["Motion Education Pvt Ltd", "Khan Global Studies"],
    skills: ["Quality Control"],
    source: "LinkedIn",
    collectedAt: "2026-08-08T00:00:00.000Z"
  });
  const parsed = csvToProfiles(profilesToCsv([input]));
  assert.equal(parsed[0].headline, input.headline);
  assert.equal(parsed[0].location, input.location);
  assert.equal(parsed[0].about, input.about, "a paragraph survives the file with its line breaks");
  assert.deepEqual(parsed[0].educationDetails, input.educationDetails);
  assert.deepEqual(parsed[0].experience, input.experience);
  assert.deepEqual(parsed[0].interests, input.interests);
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
