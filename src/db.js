import { PROFILE_FIELDS, normalizeProfile, validateProfile } from "./profile-utils.js";

const DB_NAME = "profile-table-collector"; // Preserve data from the earlier extension release.
const DB_VERSION = 6; // v6 indexes an applicant by the application it belongs to.
const STORE = "profiles";
export const QUEUE_STORE = "importQueue";
export const SESSION_STORE = "importSession";
/** One record per applicant per job (3.7.0). */
export const APPLICANT_STORE = "applicants";
/** One record per job the applicants were collected from (3.7.0). */
export const JOB_STORE = "jobs";
/** The application an applicant record belongs to (v6) — see the upgrade below. */
export const APPLICATION_INDEX = "applicationId";

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      let store;
      if (!db.objectStoreNames.contains(STORE)) {
        store = db.createObjectStore(STORE, { keyPath: "id" });
      } else {
        store = request.transaction.objectStore(STORE);
      }
      for (const [name, keyPath] of [
        ["profileUrl", "profileUrl"],
        ["updatedAt", "updatedAt"],
        // v4: the two columns a run is judged by.
        ["status", "status"],
        ["lastCollectedAt", "lastCollectedAt"]
      ]) {
        if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
      }
      // v4: `currentCompany` and `location` index fields the record no longer
      // has. Left in place they index nothing, so they are removed rather than
      // kept as a promise the schema cannot keep. The rows themselves are
      // migrated lazily — `normalizeProfile` drops the retired fields on read,
      // and `repairStoredProfiles` writes the corrected rows back.
      for (const name of ["currentCompany", "location"]) {
        if (store.indexNames.contains(name)) store.deleteIndex(name);
      }

      // v3: persistent connections import queue. The database name is unchanged so
      // profiles saved by earlier releases remain available.
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        const queue = db.createObjectStore(QUEUE_STORE, { keyPath: "url" });
        queue.createIndex("status", "status", { unique: false });
        queue.createIndex("addedAt", "addedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "key" });
      }

      // v5: the recruiter hiring surface. Two new stores rather than new fields
      // on `profiles` — an applicant is a person *on a job*, so the same person
      // applying to two jobs is two records, and neither of them is a saved
      // LinkedIn connection. Nothing in the existing stores is touched, so a
      // rollback of 3.7.0 leaves every profile and every queue row intact.
      if (!db.objectStoreNames.contains(APPLICANT_STORE)) {
        const applicants = db.createObjectStore(APPLICANT_STORE, { keyPath: "id" });
        applicants.createIndex("jobId", "job.id", { unique: false });
        applicants.createIndex("updatedAt", "updatedAt", { unique: false });
        applicants.createIndex("applicationStatus", "applicant.applicationStatus", { unique: false });
      }
      if (!db.objectStoreNames.contains(JOB_STORE)) {
        const jobs = db.createObjectStore(JOB_STORE, { keyPath: "id" });
        jobs.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      // v6: find an applicant by the APPLICATION they are, not only by the id
      // their record happens to be stored under.
      //
      // `applicantId` hashes `jobId|profileUrl|name|applicationId`, so how much
      // of a person was known when they were written decides their key — and a
      // pass that reads only the list row knows no profile URL, while a pass
      // that opens the panel does. The same application therefore hashes two
      // ways and would be stored twice. The application id is what actually
      // identifies "this person on this job", so it is indexed and consulted
      // before a second record can be created.
      //
      // Additive only: one index on an existing store, nothing dropped and no
      // field removed, so rolling back to v5 costs this lookup and not one
      // applicant, profile or queue row.
      if (db.objectStoreNames.contains(APPLICANT_STORE)) {
        const applicants = request.transaction.objectStore(APPLICANT_STORE);
        if (!applicants.indexNames.contains(APPLICATION_INDEX)) {
          applicants.createIndex(APPLICATION_INDEX, "applicationId", { unique: false });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open IndexedDB."));
  });
}

export function requestAsPromise(request) {
  return requestToPromise(request);
}

export async function withNamedStore(storeName, mode, callback) {
  const db = await openDatabase();
  try {
    const tx = db.transaction(storeName, mode);
    const result = await callback(tx.objectStore(storeName));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction was aborted."));
    });
    return result;
  } finally {
    db.close();
  }
}

async function withStore(mode, callback) {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, mode);
    const result = await callback(tx.objectStore(STORE));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction was aborted."));
    });
    return result;
  } finally {
    db.close();
  }
}

export async function getAllProfiles() {
  const raw = await withStore("readonly", (store) => requestToPromise(store.getAll()));
  const valid = [];
  const invalid = [];
  for (const record of raw) {
    const normalized = normalizeProfile(record);
    const validation = validateProfile(normalized);
    if (validation.valid) valid.push(normalized);
    else invalid.push({ id: record?.id || "unknown", errors: validation.errors });
  }
  return { profiles: valid, invalid };
}

export async function getProfile(id) {
  const value = await withStore("readonly", (store) => requestToPromise(store.get(id)));
  return value ? normalizeProfile(value) : null;
}

export async function saveProfile(input) {
  const profile = normalizeProfile(input);
  const validation = validateProfile(profile);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  await withStore("readwrite", (store) => requestToPromise(store.put(profile)));
  return profile;
}

export async function saveManyProfiles(profiles) {
  return withStore("readwrite", async (store) => {
    for (const input of profiles) {
      const profile = normalizeProfile(input);
      const validation = validateProfile(profile);
      if (!validation.valid) throw new Error(validation.errors.join(" "));
      await requestToPromise(store.put(profile));
    }
  });
}

export async function deleteProfile(id) {
  return withStore("readwrite", (store) => requestToPromise(store.delete(id)));
}

export async function clearProfiles() {
  return withStore("readwrite", (store) => requestToPromise(store.clear()));
}

/** The fields a stored row is compared on. `updatedAt` is always restamped. */
const REPAIR_FIELDS = [...PROFILE_FIELDS, "schemaVersion"];

/**
 * Bring stored rows up to the current schema.
 *
 * This is the migration. `normalizeProfile` is the whole of it: it drops the
 * fields 3.6.0 retired, drops a mobile number that is really the digits of the
 * member's own vanity URL, and fills in `status`, `cvFileName`, `cvAvailable`
 * and `lastCollectedAt` for a record written before they existed. Reading a
 * profile already shows the corrected record; this persists it, and only for
 * the rows that actually differ, so an already-migrated table writes nothing.
 *
 * Retired values are not recoverable afterwards — that is the point of the
 * change — so anything worth keeping must be exported before upgrading.
 */
export async function repairStoredProfiles() {
  const raw = await withStore("readonly", (store) => requestToPromise(store.getAll()));
  const repaired = [];
  for (const record of raw) {
    const normalized = normalizeProfile(record);
    if (!validateProfile(normalized).valid) continue;
    const changed = REPAIR_FIELDS.some((field) => JSON.stringify(record?.[field] ?? null) !== JSON.stringify(normalized[field] ?? null))
      // A row still carrying a retired field is a row that has not been migrated.
      || Object.keys(record || {}).some((key) => !(key in normalized));
    if (changed) repaired.push(normalized);
  }
  if (repaired.length) await saveManyProfiles(repaired);
  return repaired.length;
}

export async function findByProfileUrl(profileUrl) {
  if (!profileUrl) return null;
  const { profiles } = await getAllProfiles();
  return profiles.find((profile) => profile.profileUrl === profileUrl) || null;
}
