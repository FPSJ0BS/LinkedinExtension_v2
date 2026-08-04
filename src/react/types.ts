export type StatusKind = "" | "success" | "error";

/**
 * The stored record, in the order the Saved Profiles table shows it.
 *
 * 3.6.0 cut the record down to what a run is for. `experience`,
 * `yearsOfExperience`, `currentRole`, `currentCompany`, `currentEmploymentDates`,
 * `totalExperience`, `websites` and `profileImageUrl` were removed — they are no
 * longer extracted, stored, exported, or editable. `headline`, `location`,
 * `about`, `certifications` and `languages` went the same way in 3.5.0.
 */
export interface ProfileRecord {
  id?: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
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
  skills: string[];
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
  skills: [],
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
  "openToWorkDetails",
  "tags"
]);
