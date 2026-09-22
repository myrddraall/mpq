import { ENCRYPTION_TABLE } from './encryption-table.js';
import { InvalidFileNameError } from '../errors.js';

/** Which row of {@link ENCRYPTION_TABLE} a name hash draws from. */
export const HashType = {
  /** Slot index in the hash table. */
  TableOffset: 0,
  /** First name-verification hash. */
  NameA: 1,
  /** Second name-verification hash. */
  NameB: 2,
  /** Per-file encryption key. */
  FileKey: 3,
} as const;

export type HashType = (typeof HashType)[keyof typeof HashType];

/**
 * StormLib's `AsciiToUpperTable`, inlined: byte-wise ASCII upper-casing with
 * `/` folded to `\`.
 *
 * Deliberately NOT `String.prototype.toUpperCase()`, which the 2018 version
 * used:
 *
 *  - `toUpperCase()` is Unicode-aware and can change the string LENGTH
 *    (`'ß'` becomes `"SS"`), which silently changes the hash.
 *  - MPQ hashes bytes, not code points, so a code point above 0xFF has no
 *    table row at all.
 *
 * The `/` to `\` fold is what StormLib does and what real archives were built
 * with. mpyq — and so the 2018 port — omitted it. No StormReplay internal name
 * contains a slash, so adding it is a strict improvement with no effect on any
 * existing vector.
 */
function normalizeChar(code: number): number {
  if (code === 0x2f) return 0x5c; // '/' -> '\'
  if (code >= 0x61 && code <= 0x7a) return code - 0x20; // 'a'-'z' -> 'A'-'Z'
  // Bytes 0x80-0xFF pass through unchanged. StormLib's real table also
  // upper-cases some accented Latin-1 characters; that is not reproduced here
  // because the correct mapping depends on the archive's ANSI code page, which
  // an MPQ does not record. Every internal name in a StormReplay or SC2Replay
  // is pure ASCII, so the divergence is unreachable for this library's purpose.
  return code;
}

/**
 * The MPQ string hash. Returns a uint32.
 *
 * Fixes a crash in the 2018 implementation, which guarded with
 * `if (isNaN(parseInt(ch, 10))) ch = ch.codePointAt(0)`. The test is inverted:
 * for a digit, `parseInt` SUCCEEDS, so `ch` stayed a one-character string and
 * `(hashType << 8) + ch` produced a string key (`768 + "5"` is `"7685"`),
 * which indexed nothing and threw. Any file name containing a digit was
 * unhashable; it stayed latent only because no StormReplay internal name has
 * one.
 */
export function hashString(name: string, type: HashType): number {
  // seed1 and seed2 are uint32 in [0, 2^32) at every loop boundary.
  let seed1 = 0x7fed7fed;
  let seed2 = 0xeeeeeeee;
  const row = type << 8; // 0x000 / 0x100 / 0x200 / 0x300

  for (let i = 0; i < name.length; i++) {
    const ch = normalizeChar(name.charCodeAt(i));
    if (ch > 0xff) throw new InvalidFileNameError(name, i);

    const value = ENCRYPTION_TABLE[row + ch]!;

    // seed1 + seed2 <= 2 * (2^32 - 1) < 2^33, which is exactly representable
    // as a double; `^` then applies ToInt32, an exact truncation mod 2^32 for
    // any exactly-representable integer. So no intermediate mask is needed
    // before the xor, and `>>> 0` renormalises the signed result.
    seed1 = (value ^ (seed1 + seed2)) >>> 0;

    // `seed2 * 32` is the 64-bit `seed2.shiftLeft(5)` of the Long original.
    // The total stays below 2^37 + 2^33 + 0xFF + 3, far under 2^53, so the sum
    // is exact and `>>> 0` reduces it mod 2^32 exactly. (`seed2 << 5` is
    // equally correct here — it differs only in bits >= 32, which `>>> 0`
    // discards — but `* 32` keeps the 64-bit provenance visible.)
    seed2 = (ch + seed1 + seed2 + seed2 * 32 + 3) >>> 0;
  }

  return seed1;
}

/** The last path component, splitting on either separator. */
function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i < 0 ? path : path.slice(i + 1);
}

/** StormLib `DecryptFileKey`: the file key is the base name's FileKey hash. */
export function fileKey(fileName: string): number {
  return hashString(baseName(fileName), HashType.FileKey);
}

/**
 * StormLib `DecryptFileKey`, the `MPQ_FILE_FIX_KEY` branch:
 *
 *     dwFileKey = (dwFileKey + dwMpqPos) ^ dwFileSize
 *
 * `blockOffset` is the block table's `offset` field, i.e. relative to the MPQ
 * HEADER. Do not add the archive's own offset within the file (the user-data
 * prefix) — that is the most common way to get FIX_KEY wrong.
 *
 * `key + blockOffset < 2^33` is exact, `>>> 0` reduces it mod 2^32, then xor.
 */
export function fixFileKey(key: number, blockOffset: number, fileSize: number): number {
  return (((key + blockOffset) >>> 0) ^ fileSize) >>> 0;
}
