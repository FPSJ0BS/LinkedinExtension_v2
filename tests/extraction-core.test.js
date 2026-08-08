import test from "node:test";
import assert from "node:assert/strict";
await import("../src/extraction-core.js");
const Core = globalThis.ProfileVaultCore;

test("experience parser requires Present or Current for active roles", () => {
  const current = Core.parseExperienceLines(["Software Engineer", "Acme · Full-time", "Jan 2024 – Present", "Jaipur, India"]);
  const past = Core.parseExperienceLines(["Intern", "Acme · Internship", "Jan 2023 – Jun 2023", "Jaipur, India"]);
  assert.equal(current.isCurrent, true);
  assert.equal(past.isCurrent, false);
  assert.equal(current.company, "Acme");
  assert.equal(current.employmentType, "Full-time");
});

test("total experience excludes internships and merges overlap", () => {
  const records = [
    { title: "Engineer", dateRange: "Jan 2022 – Dec 2023" },
    { title: "Consultant", dateRange: "Jan 2023 – Dec 2024" },
    { title: "Intern", dateRange: "Jan 2021 – Dec 2021" }
  ];
  assert.equal(Core.calculateTotalExperience(records, new Date("2026-07-31")), "3 years");
});

test("noise filtering rejects interface controls", () => {
  assert.equal(Core.isNoiseText("Connect"), true);
  assert.equal(Core.isNoiseText("Machine Learning"), false);
});

test("headline commas are not mistaken for a geographic location", () => {
  assert.equal(Core.looksLikeLocation("Head - WhatsApp, Founder - CRED, curious."), false);
  assert.equal(Core.looksLikeLocation("Bengaluru, Karnataka, India"), true);
});

test("current LinkedIn-style experience lines produce role and company", () => {
  const record = Core.parseExperienceLines([
    "Head",
    "WhatsApp",
    "Jun 2022 – Present · 4 yrs 2 mos"
  ]);
  assert.equal(record.title, "Head");
  assert.equal(record.company, "WhatsApp");
  assert.equal(record.isCurrent, true);
});


test("segregates Tallento experience into labeled fields without duplicate parent text", () => {
  const record = Core.parseExperienceLines([
    "SDE-3 Mobile",
    "Tallento.ai (formerly FPSJOB.com) · Full-time",
    "Jun 2023 - Present · 3 yrs 2 mos",
    "Jaipur, Rajasthan, India · On-site",
    "Architected and led the development of production-grade Android and Kotlin Multiplatform applications for HR and recruitment platforms.",
    "• Developed shared business logic modules for both Android and iOS, enhancing delivery speed by 35%.",
    "… more Architected and led the development of production-grade Android and Kotlin Multiplatform applications for HR and recruitment platforms."
  ]);
  assert.equal(record.title, "SDE-3 Mobile");
  assert.equal(record.company, "Tallento.ai (formerly FPSJOB.com)");
  assert.equal(record.employmentType, "Full-time");
  assert.equal(record.dateRange, "Jun 2023 - Present");
  assert.equal(record.duration, "3 yrs 2 mos");
  assert.equal(record.location, "Jaipur, Rajasthan, India");
  assert.equal(record.workMode, "On-site");
  assert.equal((record.description.match(/Architected and led/g) || []).length, 1);
  assert.match(Core.formatExperience(record), /^Title: SDE-3 Mobile \| Company: Tallento\.ai/);
});

test("segregates and deduplicates education fields", () => {
  const record = Core.parseEducationLines([
    "Poornima University",
    "BCA, BCA",
    "2018 – 2021",
    "Poornima University",
    "Bachelor of Computer Applications Bachelor of Computer Applications"
  ]);
  assert.deepEqual(record, {
    institution: "Poornima University",
    degree: "BCA",
    fieldOfStudy: "",
    dates: "2018 – 2021",
    details: "Bachelor of Computer Applications"
  });
  assert.equal(Core.formatEducation(record), "Institution: Poornima University | Degree: BCA | Dates: 2018 – 2021 | Details: Bachelor of Computer Applications");
});


test("groups multiple roles from one company into one company block", () => {
  const records = [
    Core.parseExperienceLines(["Senior Android Application Developer", "ECOWRAP · Full-time", "Oct 2020 - Jun 2023 · 2 yrs 9 mos", "Jaipur, Rajasthan, India"]),
    Core.parseExperienceLines(["Android Application Developer", "Ecowrap Impact Pvt. Ltd.", "Jan 2021 - Jun 2022 · 1 yr 6 mos", "India"])
  ];
  const groups = Core.groupExperienceByCompany(records);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].roles.length, 2);
  assert.equal(groups[0].company, "Ecowrap Impact Pvt. Ltd.");
  const formatted = Core.formatExperienceGroup(groups[0]);
  assert.match(formatted, /^Company: Ecowrap Impact Pvt\. Ltd\. \| Roles:/);
  const parsed = Core.parseExperienceGroup(formatted);
  assert.equal(parsed.roles.length, 2);
  assert.equal(parsed.roles[0].company, "Ecowrap Impact Pvt. Ltd.");
});


test("preserves a role when the company is unavailable", () => {
  const groups = Core.groupExperienceByCompany([{ title: "Consultant", dateRange: "Jan 2024 - Present", company: "" }]);
  const formatted = Core.formatExperienceGroup(groups[0]);
  assert.match(formatted, /^Roles: Role 1:/);
  const parsed = Core.parseExperienceGroup(formatted);
  assert.equal(parsed.company, "");
  assert.equal(parsed.roles[0].title, "Consultant");
});


test("keeps three different companies as three separate experience cards", () => {
  const records = [
    Core.parseExperienceLines(["Founder & Director HR", "Alike Consulting Services · Full-time", "Aug 2022 - Present · 4 yrs", "Mohali district, India · On-site"]),
    Core.parseExperienceLines(["Marketing Project Management Specialist", "HCLTech · Full-time", "Oct 2015 - Jul 2022 · 6 yrs 10 mos", "New Delhi, Delhi, India · On-site"]),
    Core.parseExperienceLines(["Software Support Engineer", "HP · Full-time", "Jul 2011 - Sep 2015 · 4 yrs 3 mos", "Gurugram, Haryana, India", "Project Hindustan Coca-Cola Beverages Pvt. Ltd"])
  ];
  const groups = Core.groupExperienceByCompany(records);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.company), ["Alike Consulting Services", "HCLTech", "HP"]);
  assert.equal(groups[0].roles[0].title, "Founder & Director HR");
  assert.equal(groups[1].roles[0].dateRange, "Oct 2015 - Jul 2022");
  assert.match(groups[2].roles[0].description, /Project Hindustan Coca-Cola Beverages/);
});

// ---------------------------------------------------------------------------
// Who the page is about.
//
// Live defect: a connection was saved under the name "Aakash Educational
// Services Limited" — a company on a followed-companies tile, not the member.
// Every shape test the scorer had said yes: letters only, four words, no digits.
// The one identifier no re-render can move is the member's OWN URL, and the
// slug LinkedIn built out of their name is right there in it.

test("a name candidate is checked against the profile's own URL", () => {
  const url = "https://www.linkedin.com/in/isha-sharma-264954380";
  assert.equal(Core.nameSlugAgreement("Isha Sharma", url), "exact");
  assert.equal(Core.nameSlugAgreement("Isha .", url), "exact", "a one-word display name still agrees");
  assert.equal(Core.nameSlugAgreement("Isha Verma", url), "partial", "a changed surname is not a stranger");
  assert.equal(
    Core.nameSlugAgreement("Aakash Educational Services Limited", url),
    "conflict",
    "the live defect: a followed company shares no word with the member's slug"
  );
});

test("the slug is read for its words, never for its position", () => {
  assert.deepEqual(
    Core.profileSlugTokens("https://www.linkedin.com/in/isha-sharma-264954380"),
    ["isha", "sharma"],
    "the numeric uniquifier is not a name"
  );
  assert.equal(
    Core.nameSlugAgreement("Nihal Sharma", "https://www.linkedin.com/in/nihalsharma-9a1"),
    "exact",
    "a slug that runs the words together is still the same name"
  );
});

test("a name with no latin form is given no opinion rather than a wrong one", () => {
  // Rule 1: a missing value is better than a wrong one, and a Devanagari display
  // name against a transliterated slug can only be guessed at.
  assert.equal(Core.nameSlugAgreement("निहाल शर्मा", "https://www.linkedin.com/in/nihal-sharma"), "unknown");
  // An opaque member URN names nobody.
  assert.equal(Core.nameSlugAgreement("Anyone At All", "https://www.linkedin.com/in/ACoAAB1x2Y3z"), "unknown");
  assert.equal(Core.nameSlugAgreement("Anyone At All", "https://example.com/nothing"), "unknown");
});

test("an organization is not a person, however name-shaped it reads", () => {
  for (const value of [
    "Aakash Educational Services Limited",
    "Motion Education Pvt Ltd",
    "The Narayana Group",
    "Khan Global Studies",
    "Poornima Institute"
  ]) {
    assert.equal(Core.looksLikeOrganizationName(value), true, `${value} names an organization`);
  }
  for (const value of ["Isha .", "Aarti Pathak", "Nihal Sharma", "Prashant Kirad"]) {
    assert.equal(Core.looksLikeOrganizationName(value), false, `${value} names a person`);
  }
});

// ---------------------------------------------------------------------------
// Interests — the block that renders OTHER entities.

test("an interest is the tile's name, never its follower count or its tab", () => {
  assert.equal(Core.isInterestValue("Motion Education Pvt Ltd"), true);
  assert.equal(Core.isInterestValue("Khan Global Studies"), true);
  for (const noise of ["Companies", "Newsletters", "Schools", "Groups", "69,381 followers", "Follow", "+ Follow", "Following", "Show all"]) {
    assert.equal(Core.isInterestValue(noise), false, `${noise} is chrome, not an interest`);
  }
});

// ---------------------------------------------------------------------------
// The readable forms — what the table cell, the details panel and the CSV show.

test("a role and a school each read as one line a person can read", () => {
  assert.equal(
    Core.describeExperienceRecord({
      title: "Senior Lecturer",
      company: "The Narayana Group",
      employmentType: "Full-time",
      dateRange: "Jun 2023 - Present",
      duration: "3 yrs 3 mos",
      location: "Hyderabad, Telangana, India"
    }),
    "Senior Lecturer — The Narayana Group · Full-time · Jun 2023 - Present · 3 yrs 3 mos · Hyderabad, Telangana, India"
  );
  assert.equal(
    Core.describeEducationRecord({
      institution: "BIT Sindri",
      degree: "BTEC",
      fieldOfStudy: "Chemical Engineering",
      dates: "2019 – 2023"
    }),
    "BIT Sindri — BTEC, Chemical Engineering · 2019 – 2023"
  );
  // A card that rendered only its name still produces its name, not a line of
  // separators around nothing.
  assert.equal(Core.describeEducationRecord({ institution: "BIT Sindri" }), "BIT Sindri");
  assert.equal(Core.describeExperienceRecord({}), "");
});

test("the accumulator keeps the whole of education and experience, not a summary", () => {
  const accumulator = Core.createProfileAccumulator();
  accumulator.addEducation({ institution: "BIT Sindri", degree: "BTEC", fieldOfStudy: "Chemical Engineering", dates: "2019 – 2023" });
  accumulator.addExperience(Core.parseExperienceLines([
    "Senior Lecturer", "The Narayana Group · Full-time", "Jun 2023 - Present · 3 yrs 3 mos", "Hyderabad, Telangana, India"
  ]));
  accumulator.addExperience(Core.parseExperienceLines([
    "Lecturer", "The Narayana Group · Full-time", "Jun 2022 - Jun 2023 · 1 yr", "Hyderabad, Telangana, India"
  ]));

  assert.deepEqual(accumulator.education(), ["BIT Sindri"], "the institution still leads the table's cell");
  assert.deepEqual(
    accumulator.educationEntries(),
    ["BIT Sindri — BTEC, Chemical Engineering · 2019 – 2023"],
    "and the degree, field and dates are kept beside it"
  );

  const roles = accumulator.experienceEntries();
  assert.equal(roles.length, 2, "a promotion inside one company is two roles, not one");
  assert.match(roles[0], /^Senior Lecturer — The Narayana Group/, "the current role leads");
  assert.match(roles[1], /^Lecturer — The Narayana Group/);
});

test("a late Interests block counts as page change, so the scan cannot settle before it", () => {
  const accumulator = Core.createProfileAccumulator();
  const before = accumulator.signature();
  accumulator.addInterest("Motion Education Pvt Ltd");
  assert.notEqual(accumulator.signature(), before, "the quiet count must see the last section on the page");
  accumulator.addInterest("motion education pvt ltd");
  assert.deepEqual(accumulator.interests(), ["Motion Education Pvt Ltd"], "one name, however many times it renders");
  assert.equal(accumulator.addInterest("Companies"), "ignored", "and the tab strip is not an interest");
});

test("company image survives grouped experience formatting", () => {
  const groups = Core.groupExperienceByCompany([{
    title: "Engineer",
    company: "Acme",
    companyUrl: "https://www.linkedin.com/company/acme/",
    companyImageUrl: "https://media.example.com/acme-logo.png?x=1",
    dateRange: "Jan 2024 - Present"
  }]);
  const formatted = Core.formatExperienceGroup(groups[0]);
  const parsed = Core.parseExperienceGroup(formatted);
  assert.equal(parsed.companyImageUrl, "https://media.example.com/acme-logo.png?x=1");
  assert.equal(parsed.roles[0].companyImageUrl, "https://media.example.com/acme-logo.png?x=1");
});
