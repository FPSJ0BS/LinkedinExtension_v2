/**
 * A minimal ZIP writer and reader, in the two directions the packager needs.
 *
 * Node has no archiver and this project has no build dependencies — `npm test`
 * runs on the built-in runner precisely so a fresh clone needs nothing but Node.
 * Pulling in a zip library to ship a zip would be the first exception to that,
 * so the format is written out by hand instead. It is a small, stable format:
 * a local header and the bytes for every entry, a central directory describing
 * them all, and an end-of-central-directory record pointing at it.
 *
 * `readZip` exists so the packager can verify the archive it just produced by
 * reading it back the way an unzipper does — through the central directory,
 * inflating every entry and checking every CRC — rather than trusting that the
 * bytes it wrote were the bytes it meant. An installer nobody can open is worse
 * than no installer, and that failure is invisible until it reaches the device
 * it was made for.
 *
 * Deliberately not implemented: Zip64, encryption, data descriptors and split
 * archives. None of them can arise from a folder of extension files, and each
 * one is refused loudly below rather than written wrongly.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const STORED = 0;
const DEFLATED = 8;

const UTF8_NAMES = 0x0800; // General-purpose bit 11: the name is UTF-8, not CP437.
const MSDOS_DIRECTORY = 0x10; // External attribute bit that marks an entry as a folder.

// The DOS timestamp every entry carries. ZIP cannot represent anything before
// 1980, and a fixed stamp keeps the archive's own metadata out of the diff
// between two builds. It does NOT make the archive byte-reproducible — the
// build writes a `generatedAt` into build-meta.json — so nothing here or in the
// documentation claims that it does.
const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive.
 *
 * `entries` are `{ name, data }` in the order they should appear, with POSIX
 * separators in the name and a trailing slash marking a directory. Directory
 * entries are written explicitly because the alternative — relying on the
 * extractor to create parent folders from the file paths — is true of most
 * unzippers and not all of them, and a missing `vendor/` folder is an extension
 * that will not load.
 */
export function createZip(entries) {
  if (entries.length > MAX_ENTRIES) throw new Error(`A ZIP without Zip64 holds at most ${MAX_ENTRIES} entries.`);

  const chunks = [];
  const directory = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const directoryEntry = entry.name.endsWith("/");
    const data = directoryEntry ? Buffer.alloc(0) : Buffer.from(entry.data);
    if (data.length > MAX_SIZE) throw new Error(`${entry.name} is too large for a ZIP without Zip64.`);

    // Store rather than deflate when compression does not pay. The icons and
    // the vendored React builds are already compressed, and a "compressed"
    // entry that grew is a larger download for nothing.
    const deflated = data.length > 0 ? deflateRawSync(data, { level: 9 }) : Buffer.alloc(0);
    const compress = deflated.length > 0 && deflated.length < data.length;
    const method = compress ? DEFLATED : STORED;
    const payload = compress ? deflated : data;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4); // Version needed: 2.0, which is what deflate requires.
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // No extra field.

    chunks.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4); // Version made by: 2.0, MS-DOS, which is the most widely accepted.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // No extra field.
    central.writeUInt16LE(0, 32); // No comment.
    central.writeUInt16LE(0, 34); // Disk number.
    central.writeUInt16LE(0, 36); // Internal attributes.
    central.writeUInt32LE(directoryEntry ? MSDOS_DIRECTORY : 0, 38);
    central.writeUInt32LE(offset, 42);

    directory.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4); // This disk.
  end.writeUInt16LE(0, 6); // The disk the central directory starts on.
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // No archive comment.

  return Buffer.concat([...chunks, centralDirectory, end]);
}

/**
 * Read an archive back the way an extractor does: find the end record, walk the
 * central directory, and inflate each entry against its own recorded CRC. Every
 * malformed case throws rather than returning something partly right, because
 * the caller's whole reason for reading is to find out whether the file is
 * sound.
 */
export function readZip(buffer) {
  const end = findEndRecord(buffer);
  const total = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = [];

  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) throw new Error("Corrupt archive: central directory entry expected.");
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error(`Corrupt archive: no local header for ${name}.`);
    // The local header's own name and extra lengths are what locate the bytes;
    // the central directory's copy of the extra field may differ in length.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const stored = buffer.subarray(start, start + compressedSize);

    let data;
    if (method === STORED) data = Buffer.from(stored);
    else if (method === DEFLATED) data = inflateRawSync(stored);
    else throw new Error(`${name} uses unsupported compression method ${method}.`);

    if (data.length !== size) throw new Error(`${name} unpacked to ${data.length} bytes, not the ${size} recorded.`);
    if (crc32(data) !== checksum) throw new Error(`${name} failed its CRC check.`);

    entries.push({ name, data, method, compressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndRecord(buffer) {
  // The end record is last, but a trailing comment can push it back by up to
  // 64 KB, so it is searched for rather than assumed to be the final 22 bytes.
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= earliest; at -= 1) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new Error("Not a ZIP archive: no end-of-central-directory record.");
}
