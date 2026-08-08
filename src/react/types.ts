export type StatusKind = "" | "success" | "error";

/**
 * The stored record.
 *
 * What the scan reads is what the record keeps. `yearsOfExperience`,
 * `currentRole`, `currentCompany`, `currentEmploymentDates`, `totalExperience`,
 * `websites`, `certifications`, `languages` and `profileImageUrl` stay retired —
 * they were derived or unread, and a derived field that disagrees with the roles
 * beside it is worse than no field at all.
 */
export interface ProfileRecord {
  id?: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  /** The member's own one-line summary, from the top card. */
  headline: string;
  /** The place the top card shows, never a place read from a role. */
  location: string;
  /** The About paragraph, line breaks and all. */
  about: string;
  /** Primary address; `emails` holds every one that was found. */
  email: string;
  emails: string[];
  /** Primary number; `phones` holds every one that was found. */
  mobile: string;
  phones: string[];
  /** The best CV/resume link found, or "" when the profile has none. */
  cvUrl: string;
  /** The document's own file name, when the CV is a file rather than a page. */
  cvFileName: string;
  cvAvailable: boolean;
  cvLinks: string[];
  /** One labelled line per field of the member's own Open to work panel. */
  openToWorkDetails: string[];
  /** Institution names, deduplicated, in the order the profile renders them. */
  education: string[];
  /** The whole of each education card — degree, field, dates, details. */
  educationDetails: string[];
  /** One readable line per role, grouped by company. */
  experience: string[];
  skills: string[];
  /** The companies, newsletters, schools and groups the member follows. */
  interests: string[];
  profileUrl: string;
  /** "collected" | "partial" | "failed" — see PROFILE_STATUS. */
  status: string;
  /** When a collection last wrote this record. A hand edit does not change it. */
  lastCollectedAt: string;
  notes: string;
  tags: string[];
  source?: string;
  extractionConfidence?: number;
  missingFields?: string[];
  partialSections?: string[];
  collectedAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export const EMPTY_PROFILE: ProfileRecord = {
  fullName: "",
  headline: "",
  location: "",
  about: "",
  email: "",
  emails: [],
  mobile: "",
  phones: [],
  cvUrl: "",
  cvFileName: "",
  cvAvailable: false,
  cvLinks: [],
  openToWorkDetails: [],
  education: [],
  educationDetails: [],
  experience: [],
  skills: [],
  interests: [],
  profileUrl: "",
  status: "",
  lastCollectedAt: "",
  notes: "",
  tags: []
};

// Must list the same arrays as ARRAY_FIELDS in src/profile-utils.js.
export const ARRAY_FIELDS = new Set([
  "cvLinks",
  "emails",
  "phones",
  "skills",
  "education",
  "educationDetails",
  "experience",
  "interests",
  "openToWorkDetails",
  "tags"
]);
