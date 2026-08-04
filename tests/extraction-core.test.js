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
