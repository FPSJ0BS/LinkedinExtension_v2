/**
 * Persistence for the recruiter applicant records.
 *
 * A thin adapter over the shared database, exactly as
 * [queue-db.js](./queue-db.js) is for the import queue: the shape and every
 * merge rule live in the pure core, and this file only reads and writes. The
 * database name is unchanged — `profile-table-collector`, as rule 14 requires —
 * and the two stores this uses were added in schema v5 without touching the
 * profile or queue stores, so removing 3.7.0 loses applicants and nothing else.
 *
 * Records are normalized on the way in AND on the way out. A record written by
 * an older build is therefore repaired lazily on read, the same lazy-migration
 * arrangement `normalizeProfile` gives the saved profiles.
 */
import "./applicants-core.js";
import { APPLICANT_STORE, JOB_STORE, requestAsPromise, withNamedStore } from "./db.js";

const Applicants = /** @type {any} */ (globalThis).ProfileVaultApplicants;

function normalize(record) {
  return Applicants.normalizeApplicantRecord(record);
}

/**
 * Every stored applicant, newest first — ordered by when each was **collected**,
 * never by when it was last written.
 *
 * THE DEFECT THIS FIXES: the sort key used to be `updatedAt`, and
 * `normalizeApplicantRecord` restamps `updatedAt` to *now* on every single write
 * (`updatedAt: now`, applicants-core.js). A run streams each finished applicant
 * to the store as it goes, and the Job Applicants page re-reads the store every
 * three seconds — so on every poll the applicant just saved jumped to row one
 * and pushed every row below it down. Re-collecting somebody already in the
 * table moved them from wherever they were to the top for the same reason. From
 * the recruiter's side that is a table whose rows swap places while they are
 * trying to read it, having touched nothing: exactly the reported jitter.
 *
 * `collectedAt` is the right key because it is **preserved** across writes —
 * `normalizeApplicantRecord` keeps an existing value (`cleanText(source.collectedAt) || now`)
 * and `saveApplicant` merges over the stored record — so a row's position is
 * decided once, when it is first collected, and never moves afterwards. `id`
 * breaks ties so two applicants saved in the same millisecond still have one
 * definite order rather than whatever `getAll()` happened to return.
 */
export async function getAllApplicants() {
  const raw = await withNamedStore(APPLICANT_STORE, "readonly", (store) => requestAsPromise(store.getAll()));
  return (raw || [])
    .map((record) => normalize(record))
    .sort((a, b) =>
      String(b.collectedAt).localeCompare(String(a.collectedAt))
      || String(a.id).localeCompare(String(b.id)));
}

export async function getApplicant(id) {
  if (!id) return null;
  const value = await withNamedStore(APPLICANT_STORE, "readonly", (store) => requestAsPromise(store.get(id)));
  return value ? normalize(value) : null;
}

/**
 * Save one applicant, merged over whatever is already stored for them.
 *
 * The merge is the core's, so a second visit that saw a collapsed section adds
 * to the record rather than replacing it, and a resume already downloaded keeps
 * its filename and its `downloaded` status.
 */
export async function saveApplicant(input) {
  const incoming = normalize(input);
  const existing = await getApplicant(incoming.id);
  const record = existing ? Applicants.mergeApplicantRecord(existing, incoming) : incoming;
  await withNamedStore(APPLICANT_STORE, "readwrite", (store) => requestAsPromise(store.put(record)));
  if (record.job?.id) await saveJob(record.job);
  return record;
}

export async function saveManyApplicants(records) {
  const saved = [];
  for (const record of records || []) saved.push(await saveApplicant(record));
  return saved;
}

export async function deleteApplicant(id) {
  return withNamedStore(APPLICANT_STORE, "readwrite", (store) => requestAsPromise(store.delete(id)));
}

export async function clearApplicants() {
  await withNamedStore(APPLICANT_STORE, "readwrite", (store) => requestAsPromise(store.clear()));
  await withNamedStore(JOB_STORE, "readwrite", (store) => requestAsPromise(store.clear()));
}

/** The job an applicant belongs to, stored once and enriched as views differ. */
export async function saveJob(job) {
  const id = String(job?.id ?? "").trim();
  if (!id) return null;
  const existing = await withNamedStore(JOB_STORE, "readonly", (store) => requestAsPromise(store.get(id)));
  const merged = {
    ...Applicants.mergeJob(existing || {}, job || {}),
    id,
    updatedAt: new Date().toISOString(),
    collectedAt: existing?.collectedAt || new Date().toISOString()
  };
  await withNamedStore(JOB_STORE, "readwrite", (store) => requestAsPromise(store.put(merged)));
  return merged;
}

export async function getAllJobs() {
  const raw = await withNamedStore(JOB_STORE, "readonly", (store) => requestAsPromise(store.getAll()));
  return raw || [];
}

/** Applicants grouped by the job they applied to, for the table's grouping. */
export async function getApplicantsByJob() {
  const applicants = await getAllApplicants();
  const groups = new Map();
  for (const record of applicants) {
    const key = record.job?.id || record.job?.title || "unknown";
    if (!groups.has(key)) groups.set(key, { job: record.job, applicants: [] });
    groups.get(key).applicants.push(record);
  }
  return [...groups.values()];
}

/**
 * Has this resume already been saved to disk?
 *
 * The duplicate-download guard that survives a service-worker restart: the
 * content script's own in-memory set covers one tab, and this covers everything
 * else. A URL that any stored record already reports as downloaded is not
 * downloaded again.
 */
export async function resumeAlreadyDownloaded(url) {
  const wanted = String(url ?? "").trim();
  if (!wanted) return false;
  const applicants = await getAllApplicants();
  return applicants.some(
    (record) => record.applicant.resume.url === wanted
      && record.applicant.resume.downloadStatus === Applicants.RESUME_STATUS.DOWNLOADED
  );
}
