import "./extraction-core.js";

const Core = globalThis.ProfileVaultCore;

// Kept in step with ARRAY_FIELDS in src/react/types.ts — that copy drives form
// editing and this one drives validation, and they must list the same arrays.
export const ARRAY_FIELDS = [
  "cvLinks", "emails", "phones", "skills", "education", "openToWorkDetails",
  "tags", "partialSections", "missingFields"
];

/**
 * The stored record, in the order the table and the CSV show it.
 *
 * 3.6.0 cut it down to what the run is actually for. `experience`,
 * `yearsOfExperience`, `currentRole`, `currentCompany`, `currentEmploymentDates`,
 * `totalExperience`, `websites` and `profileImageUrl` are gone: they are no
 * longer extracted into the record, no longer exported, and no longer editable,
 * and a profile saved by an earlier version loses them the next time it is
 * written. Experience is still *read* during the scan — a late-hydrating
 * Experience section is real page change and the quiet count has to see it — it
 * is simply not stored.
 */
export const PROFILE_FIELDS = [
  "fullName", "firstName", "lastName", "email", "emails", "mobile", "phones",
  "cvUrl", "cvFileName", "cvAvailable", "cvLinks",
  "openToWorkDetails", "education", "skills",
  "profileUrl", "status", "lastCollectedAt", "notes", "tags"
];

/**
 * What the Status column says about a record.
 *
 * `collected` — the scan finished and produced at least one thing the run is
 * for. `partial` — it finished but the profile rendered none of them, which is
 * a real answer and not a failure. `failed` is written by the importer when the
 * profile could not be read at all.
 */
export const PROFILE_STATUS = Object.freeze({
  COLLECTED: "collected",
  PARTIAL: "partial",
  FAILED: "failed"
});

/** The value fields the Status column is judged on. */
const PRIORITY_FIELDS = ["email", "mobile", "cvUrl", "skills", "education", "openToWorkDetails"];

function deriveStatus(record) {
  const carries = PRIORITY_FIELDS.some((field) => Array.isArray(record[field]) ? record[field].length > 0 : Boolean(record[field]));
  return carries ? PROFILE_STATUS.COLLECTED : PROFILE_STATUS.PARTIAL;
}

/**
 * The file name shown for a CV, taken from its URL.
 * Empty when the link is a page rather than a document — the column then shows
 * the link itself, and never a guessed name.
 */
export function cvFileNameFrom(url) {
  const text = cleanText(url);
  if (!text) return "";
  try {
    const name = decodeURIComponent(new URL(text).pathname.split("/").filter(Boolean).pop() || "");
    return /\.(?:pdf|docx?|odt|rtf|pages)$/i.test(name) ? name : "";
  } catch {
    return "";
  }
}

export function cleanText(value) {
  return String(value ?? "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").trim();
}

/**
 * The member's page, and nothing about which part of it is open — see the copy
 * in [extraction-core.js](./extraction-core.js) for why. `/in/slug/overlay/...`
 * and `/in/slug/details/...` all canonicalize to `/in/slug`.
 */
export function canonicalizeProfileUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    if (/(?:^|\.)linkedin\.com$/i.test(parsed.hostname)) {
      const member = /^(\/in\/[^/]+)(?:\/.*)?$/i.exec(parsed.pathname);
      if (member) parsed.pathname = member[1];
    }
    return parsed.toString();
  } catch {
    return cleanText(url);
  }
}

export function splitName(fullName) {
  const parts = cleanText(fullName).split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function createProfileId(url, name = "", suffix = "") {
  const input = `${canonicalizeProfileUrl(url)}|${cleanText(name)}|${suffix}`.toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `profile_${(hash >>> 0).toString(16)}`;
}

export function linesToArray(value) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);
  const seen = new Set();
  const output = [];
  for (const item of source) {
    const cleaned = cleanText(item);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

export function arrayToLines(value) {
  return Array.isArray(value) ? value.join("\n") : String(value ?? "");
}

/** Is this a linkedin.com address? Those are profile links, never CVs. */
function isLinkedInUrl(value) {
  return /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com(?:[/?#]|$)/i.test(cleanText(value));
}

/** The single value shown in a column, taken from its list when absent. */
function primaryOf(scalar, list) {
  const direct = cleanText(scalar);
  return direct || list[0] || "";
}

/**
 * Drop numbers that are really this profile's own URL.
 *
 * Every LinkedIn vanity URL ends in the member's numeric id, so
 * `/in/paarth-khandelwal-264954380` was being saved as the mobile number
 * `264954380`. The extractor no longer produces those, and this removes the ones
 * already stored: the check is exact — the digits have to appear inside the
 * digits of the record's own URL — so a real number can never match it.
 */
export function dropUrlDerivedPhones(phones, profileUrl) {
  const urlDigits = String(profileUrl ?? "").replace(/\D/g, "");
  if (urlDigits.length < 7) return linesToArray(phones);
  return linesToArray(phones).filter((phone) => {
    const digits = String(phone).replace(/\D/g, "");
    return digits.length >= 7 && !urlDigits.includes(digits);
  });
}

/**
 * Addresses and numbers that turn up on several different people.
 *
 * A block that renders OTHER members — Interests, People also viewed — put one
 * stranger's details onto every profile that scrolled past it, so the same
 * address or number appears on record after record. A personal mobile shared by
 * three separate LinkedIn members is not a personal mobile.
 *
 * Pure and list-in/list-out: it reports, and the caller decides.
 */
export function findSharedContactValues(profiles, minShared = 3) {
  const owners = new Map();
  for (const profile of profiles || []) {
    const key = cleanText(profile?.profileUrl).toLowerCase() || String(profile?.id ?? "");
    for (const field of ["emails", "phones"]) {
      for (const value of linesToArray(profile?.[field])) {
        const bucket = `${field}:${value.toLowerCase()}`;
        if (!owners.has(bucket)) owners.set(bucket, { field, value, profiles: new Set() });
        owners.get(bucket).profiles.add(key);
      }
    }
  }
  return [...owners.values()]
    .filter((entry) => entry.profiles.size >= minShared)
    .map((entry) => ({ field: entry.field, value: entry.value, sharedBy: entry.profiles.size }));
}

/** Remove the reported shared values from a record. Returns null when unchanged. */
export function stripSharedContactValues(profile, shared) {
  const drop = new Set((shared || []).map((entry) => `${entry.field}:${String(entry.value).toLowerCase()}`));
  if (!drop.size) return null;
  const emails = linesToArray(profile?.emails).filter((value) => !drop.has(`emails:${value.toLowerCase()}`));
  const phones = linesToArray(profile?.phones).filter((value) => !drop.has(`phones:${value.toLowerCase()}`));
  if (emails.length === linesToArray(profile?.emails).length && phones.length === linesToArray(profile?.phones).length) {
    return null;
  }
  // The primary is re-derived from what survived rather than kept: dropping the
  // list entry while leaving `email`/`mobile` showing it would fix nothing.
  return normalizeProfile({ ...profile, emails, phones, email: emails[0] || "", mobile: phones[0] || "" });
}

export function normalizeProfile(input = {}) {
  const now = new Date().toISOString();
  const fullName = cleanText(input.fullName);
  const split = splitName(fullName);
  const profileUrl = canonicalizeProfileUrl(input.profileUrl);

  // Contact values are stored as lists and surfaced as a primary scalar, so a
  // profile with two addresses keeps both while the table still shows one.
  const emails = linesToArray(input.emails).map((value) => Core?.normalizeEmail?.(value) || value).filter(Boolean);
  const phones = linesToArray(input.phones).map((value) => Core?.normalizePhone?.(value) || "").filter(Boolean);
  const cvLinks = linesToArray(input.cvLinks);
  // A single `email`/`mobile`/`cvUrl` supplied on its own (a CSV import, a
  // hand-added record) still belongs in the list.
  for (const [scalar, list] of [[input.email, emails], [input.mobile, phones], [input.cvUrl, cvLinks]]) {
    const value = list === phones ? (Core?.normalizePhone?.(scalar) ?? cleanText(scalar)) : cleanText(scalar);
    if (value && !list.some((entry) => entry.toLowerCase() === value.toLowerCase())) list.unshift(value);
  }
  // Self-healing: a number that is really the digits at the end of this member's
  // own vanity URL is removed from records written before that was fixed, so
  // simply opening the table clears it rather than needing a migration pass.
  const realPhones = dropUrlDerivedPhones(phones, profileUrl);
  // The CV field carries CVs. The person's own page is stored once, as
  // `profileUrl`, and a LinkedIn address arriving here from an older record, a
  // CSV or a hand edit is dropped rather than offered as their CV.
  const realCvLinks = cvLinks.filter((entry) => !isLinkedInUrl(entry));
  const cvUrl = isLinkedInUrl(input.cvUrl) ? "" : cleanText(input.cvUrl);

  const resolvedCvUrl = primaryOf(cvUrl, realCvLinks);

  const normalized = {
    id: input.id || createProfileId(profileUrl, fullName),
    fullName,
    firstName: cleanText(input.firstName) || split.firstName,
    lastName: cleanText(input.lastName) || split.lastName,
    email: primaryOf(input.email, emails),
    emails: linesToArray(emails),
    mobile: realPhones[0] || "",
    phones: linesToArray(realPhones),
    cvUrl: resolvedCvUrl,
    // Derived, never guessed: a CV that is a hosted page rather than a file has
    // no file name, and the column then shows the link.
    cvFileName: cleanText(input.cvFileName) || cvFileNameFrom(resolvedCvUrl),
    cvAvailable: Boolean(resolvedCvUrl),
    cvLinks: linesToArray(realCvLinks),
    openToWorkDetails: linesToArray(input.openToWorkDetails),
    education: linesToArray(input.education),
    skills: linesToArray(input.skills),
    profileUrl,
    status: cleanText(input.status),
    // The last time a collection actually wrote this record. A hand edit in the
    // table restamps `updatedAt` and leaves this alone, which is what makes the
    // importer's `stale` scope mean "not collected recently" rather than
    // "not touched recently".
    lastCollectedAt: cleanText(input.lastCollectedAt) || cleanText(input.collectedAt) || now,
    notes: String(input.notes ?? "").trim(),
    tags: linesToArray(input.tags),
    source: cleanText(input.source) || "LinkedIn",
    extractionConfidence: Math.max(0, Math.min(100, Number(input.extractionConfidence) || 0)),
    missingFields: linesToArray(input.missingFields),
    partialSections: linesToArray(input.partialSections),
    collectedAt: input.collectedAt || now,
    updatedAt: now,
    schemaVersion: 5
  };
  normalized.status = normalized.status || deriveStatus(normalized);
  return normalized;
}

export function validateProfile(profile) {
  const errors = [];
  if (!profile.fullName && !profile.profileUrl) errors.push("A profile must have a name or URL.");
  if (profile.profileUrl) {
    try { new URL(profile.profileUrl); } catch { errors.push("The profile URL is invalid."); }
  }
  for (const field of ARRAY_FIELDS) if (!Array.isArray(profile[field])) errors.push(`${field} must be an array.`);
  return { valid: errors.length === 0, errors };
}

export function mergeProfiles(existing, incoming) {
  const merged = { ...existing };
  const replaceWhenPresent = new Set(["education", "openToWorkDetails", "partialSections", "missingFields"]);
  // Contact lists concatenate: a CSV that carries one address must not drop the
  // second one already on the record.
  for (const [key, value] of Object.entries(incoming)) {
    if (["id", "collectedAt"].includes(key)) continue;
    if (Array.isArray(value)) {
      if (replaceWhenPresent.has(key) && value.length) merged[key] = linesToArray(value);
      else merged[key] = linesToArray([...(existing[key] || []), ...value]);
    } else if (value !== "" && value !== null && value !== undefined) merged[key] = value;
  }
  return normalizeProfile({ ...merged, id: existing.id, collectedAt: existing.collectedAt });
}


/**
 * Replace previously extracted details with a fresh extraction.
 * Record identity (`id`, `collectedAt`) and user-authored data (`notes`, `tags`)
 * survive; every extracted field is taken from `incoming`.
 */
export function replaceProfile(existing, incoming) {
  const incomingNotes = String(incoming?.notes ?? "").trim();
  const incomingTags = linesToArray(incoming?.tags);
  return normalizeProfile({
    ...incoming,
    notes: incomingNotes || String(existing?.notes ?? "").trim(),
    tags: incomingTags.length ? incomingTags : linesToArray(existing?.tags),
    id: existing?.id || incoming.id,
    collectedAt: existing?.collectedAt || incoming.collectedAt
  });
}

export function makeSeparateCopy(profile) {
  const now = Date.now().toString();
  return normalizeProfile({ ...profile, id: createProfileId(profile.profileUrl, profile.fullName, now), collectedAt: new Date().toISOString() });
}
