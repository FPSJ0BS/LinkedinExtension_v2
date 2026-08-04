import { normalizeProfile } from "./profile-utils.js";

/**
 * The export, column for column with the Saved Profiles table.
 *
 * 3.6.0 REPLACED this list rather than appending to it, and the order here is
 * the order of the table: name, email, mobile, cv, open to work, education,
 * skills, profile url, status, last collected, notes, tags. Every column that
 * carried experience, current role, current company, years, websites or the
 * portrait is gone, so a CSV written by 3.5.0 or earlier no longer round-trips
 * those values — they are ignored on import and are not recoverable from the
 * file. `all_emails`, `all_phone_numbers` and `cv_links` follow the twelve as
 * extra detail; the importer reads them when they are there and does not need
 * them when they are not.
 *
 * `csvToProfiles` needs `name`, `profile_url` and `last_collected` to recognise
 * a Profile Vault file. `full_name`, `source` and `collected_at` are still
 * accepted as aliases so a 3.5.0 export still imports.
 */
export const CSV_COLUMNS = [
  ["fullName", "name"],
  ["email", "email"],
  ["mobile", "mobile"],
  ["cvUrl", "cv_url"],
  ["openToWorkDetails", "open_to_work"],
  ["education", "education"],
  ["skills", "skills"],
  ["profileUrl", "profile_url"],
  ["status", "status"],
  ["lastCollectedAt", "last_collected"],
  ["notes", "notes"],
  ["tags", "tags"],
  // Detail the table keeps behind "See more".
  ["emails", "all_emails"],
  ["phones", "all_phone_numbers"],
  ["cvFileName", "cv_file_name"],
  ["cvLinks", "cv_links"],
  ["source", "source"],
  ["collectedAt", "collected_at"]
];

/** The twelve columns the table shows, in the table's order. */
export const CSV_TABLE_COLUMNS = Object.freeze([
  "name", "email", "mobile", "cv_url", "open_to_work", "education", "skills",
  "profile_url", "status", "last_collected", "notes", "tags"
]);

/** Columns whose cells hold one value per line. */
const CSV_LIST_COLUMNS = new Set([
  "cvLinks", "emails", "phones", "skills", "education", "openToWorkDetails", "tags"
]);

/** Labels an older export used for a column that still exists. */
const CSV_LABEL_ALIASES = new Map([
  ["full_name", "fullName"],
  ["all_emails", "emails"],
  ["all_phone_numbers", "phones"]
]);

export function neutralizeFormula(value) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/**
 * One cell's text.
 *
 * A list becomes one value per line; anything else becomes its string. An object
 * that reached here would print as `[object Object]`, so it is refused outright
 * rather than exported as noise — the record holds strings and lists of strings.
 */
export function serializeValue(value) {
  if (Array.isArray(value)) return value.map((entry) => serializeValue(entry)).join("\n");
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value);
}

/**
 * Columns a spreadsheet must not treat as a number.
 *
 * `9876543210` opened in Excel becomes 9.87654E+09 and the leading zero of
 * `04423456789` disappears entirely, so the number that comes back out of the
 * file is not the number that went in. A leading apostrophe is the marker every
 * spreadsheet reads as "this cell is text", and `csvToProfiles` strips it again.
 */
const CSV_TEXT_COLUMNS = new Set(["mobile", "phones"]);

export function escapeCell(value, { asText = false } = {}) {
  const text = serializeValue(value);
  const marked = asText && text ? `'${text}` : neutralizeFormula(text);
  return `"${marked.replace(/"/g, '""')}"`;
}

/**
 * A whole CSV file from a header row and already-serialized cells.
 *
 * The four things that make a file open correctly everywhere live here and
 * nowhere else, so any export the extension grows inherits all four: the UTF-8
 * BOM (without it Excel mis-decodes accented names), CRLF line endings, every
 * cell quoted, and formula neutralization. `applicant-csv.js` builds its rows
 * differently and shares this.
 */
export function buildCsvFile(headerLabels, rows) {
  const header = headerLabels.map((label) => escapeCell(label)).join(",");
  return `\uFEFF${[header, ...rows].join("\r\n")}`;
}

/** Hand a finished CSV string to the browser as a download. */
export function downloadCsvText(text, prefix) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  chrome.downloads.download(
    { url, filename: `${prefix}-${stamp}.csv`, saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 15000)
  );
}

export function profilesToCsv(profiles) {
  const rows = (profiles || []).map((profile) =>
    CSV_COLUMNS.map(([key]) => escapeCell(profile?.[key], { asText: CSV_TEXT_COLUMNS.has(key) })).join(",")
  );
  return buildCsvFile(CSV_COLUMNS.map(([, label]) => label), rows);
}

export function parseCsv(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  row.push(cell.replace(/\r$/, ""));
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export function csvToProfiles(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("The CSV does not contain profile rows.");
  const headers = rows[0].map((value) => value.trim().toLowerCase());
  // A profile needs a URL and a name. `full_name` is 3.5.0's label for the same
  // column, so an export from the previous release still imports.
  const named = headers.includes("name") || headers.includes("full_name");
  if (!named || !headers.includes("profile_url")) {
    throw new Error("This is not a compatible Profile Vault CSV file.");
  }
  const labelToKey = new Map([
    ...CSV_COLUMNS.map(([key, label]) => [label, key]),
    ...CSV_LABEL_ALIASES
  ]);
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row) => {
    const record = {};
    headers.forEach((label, index) => {
      const key = labelToKey.get(label);
      if (!key) return;
      let value = row[index] ?? "";
      // Both markers this exporter writes: the formula guard and the text guard.
      if (/^'[=+\-@\t\r]/.test(value) || (CSV_TEXT_COLUMNS.has(key) && value.startsWith("'"))) value = value.slice(1);
      if (CSV_LIST_COLUMNS.has(key)) {
        value = value.split(/\r?\n/)
          .map((entry) => (CSV_TEXT_COLUMNS.has(key) && entry.startsWith("'") ? entry.slice(1) : entry))
          .filter(Boolean);
      }
      record[key] = value;
    });
    return normalizeProfile(record);
  });
}

/**
 * Select saved profiles whose canonical URL appears in `urls`.
 * Used for a partial export limited to what an import session actually completed.
 * Comparison is case-insensitive and ignores a trailing slash.
 */
export function filterProfilesByUrls(profiles, urls) {
  const normalize = (value) => String(value ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const wanted = new Set((urls || []).map(normalize).filter(Boolean));
  if (!wanted.size) return [];
  return (profiles || []).filter((profile) => wanted.has(normalize(profile?.profileUrl)));
}

/**
 * Save an arbitrary object as a JSON file. Used for the live diagnostics report,
 * which is the only way to tell a wrong scroll container from a one-shot scan
 * once the extension is running against the real LinkedIn DOM.
 */
export function downloadJson(data, prefix = "profile-vault-diagnostics") {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  chrome.downloads.download({ url, filename: `${prefix}-${stamp}.json`, saveAs: true }, () => setTimeout(() => URL.revokeObjectURL(url), 15000));
}

export function downloadCsv(profiles, prefix = "profile-vault") {
  if (!profiles.length) throw new Error("There are no profiles to export.");
  downloadCsvText(profilesToCsv(profiles), prefix);
}
