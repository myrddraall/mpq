import { ByteReader } from './io/byte-reader.js';
import { InvalidArchiveError, UnsupportedFormatError } from './errors.js';
import { MAGIC_MPQ_HEADER, MAGIC_MPQ_USERDATA } from './constants.js';
import type { MPQFileHeader, MPQUserDataHeader } from './types.js';

/** Parse the 16-byte `MPQ\x1b` user-data header and its payload. */
export function readUserDataHeader(bytes: Uint8Array): MPQUserDataHeader {
  const r = new ByteReader(bytes);
  const magic = r.u32();
  if (magic !== MAGIC_MPQ_USERDATA) {
    throw new InvalidArchiveError(
      `expected the MPQ user-data signature 0x${MAGIC_MPQ_USERDATA.toString(16)}, ` +
        `found 0x${magic.toString(16)}`,
    );
  }
  const userDataSize = r.u32();
  const mpqHeaderOffset = r.u32();
  const userDataHeaderSize = r.u32();

  // The payload runs from just past this 16-byte header. Clamp to what is
  // actually present: a truncated replay should still expose a parseable
  // header rather than throwing here.
  const available = Math.max(0, Math.min(userDataHeaderSize, bytes.byteLength - 16));
  const content = bytes.subarray(16, 16 + available);

  return { magic, userDataSize, mpqHeaderOffset, userDataHeaderSize, content };
}

/**
 * Parse the `MPQ\x1a` archive header at `offset` within `bytes`.
 *
 * Handles format versions 0 through 3. Versions 2 and 3 extend the header with
 * 64-bit sizes and the HET/BET acceleration tables, but they **still carry the
 * classic 32-bit hash and block tables**, which is all this reader needs. Every
 * modern `.StormReplay` and `.SC2Replay` is in fact version 3, so refusing them
 * would refuse the format's main real-world use.
 *
 * Fixes two crashes in the 2018 version:
 *
 *  - `MPQFileHeaderExt` read the 64-bit `extendedBlockTableOffset` with
 *    `readIntLE(0, 8)`, which Node rejects outright (6-byte cap). Every
 *    `formatVersion === 1` archive threw on Node.
 *  - `hashTableOffsetHigh` and `blockTableOffsetHigh` were read with
 *    `readInt8`, but they are 16-bit fields (`wHashTablePosHi`,
 *    `wBlockTablePosHi`).
 *
 * The 2018 version also ignored the version-2 and -3 extensions entirely and
 * read only the first 32 bytes. That happened to work, because the fields it
 * needed sit at the same offsets in every version -- but it also meant the
 * high-order table offsets were silently discarded, so an archive above 4 GB
 * would have read from the wrong place. They are composed properly here.
 */
export function readFileHeader(bytes: Uint8Array, offset: number): MPQFileHeader {
  const r = new ByteReader(bytes).seek(offset);

  const magic = r.u32();
  if (magic !== MAGIC_MPQ_HEADER) {
    throw new InvalidArchiveError(
      `expected the MPQ archive signature 0x${MAGIC_MPQ_HEADER.toString(16)} at offset ` +
        `${offset}, found 0x${magic.toString(16)}`,
    );
  }

  const headerSize = r.u32();
  const archiveSize = r.u32();
  const formatVersion = r.u16();
  const sectorSizeShift = r.u16();
  const hashTableOffsetLow = r.u32();
  const blockTableOffsetLow = r.u32();
  const hashTableEntries = r.u32();
  const blockTableEntries = r.u32();

  if (formatVersion > 3) {
    throw new UnsupportedFormatError(
      `MPQ format version ${formatVersion} is not supported; @myrddraall/mpq reads versions 0 ` +
        `through 3`,
    );
  }

  // An archive built with only the HET/BET tables has no classic hash table for
  // this reader to use. Say so plainly rather than failing later on a
  // zero-length table read.
  if (hashTableEntries === 0) {
    throw new UnsupportedFormatError(
      `this archive declares no classic hash table entries, so it stores its file index only in ` +
        `the HET/BET tables introduced in format version 2. @myrddraall/mpq reads the classic ` +
        `hash and block tables, which every .StormReplay and .SC2Replay also carries.`,
    );
  }

  let hashTableOffsetHigh: number | undefined;
  let blockTableOffsetHigh: number | undefined;
  let extendedBlockTableOffset: number | undefined;
  let archiveSize64: number | undefined;
  let betTableOffset: number | undefined;
  let hetTableOffset: number | undefined;

  if (formatVersion >= 1 && headerSize >= 0x2c) {
    extendedBlockTableOffset = r.u64();
    hashTableOffsetHigh = r.u16();
    blockTableOffsetHigh = r.u16();
  }

  if (formatVersion >= 2 && headerSize >= 0x44) {
    archiveSize64 = r.u64();
    betTableOffset = r.u64();
    hetTableOffset = r.u64();
  }

  // Compose the full 64-bit table offsets. Both high words are zero in every
  // archive seen in practice, but discarding them -- as the 2018 version did --
  // would silently read the wrong location in an archive above 4 GB.
  const hashTableOffset = (hashTableOffsetHigh ?? 0) * 0x100000000 + hashTableOffsetLow;
  const blockTableOffset = (blockTableOffsetHigh ?? 0) * 0x100000000 + blockTableOffsetLow;

  return {
    magic,
    headerSize,
    archiveSize,
    formatVersion,
    sectorSizeShift,
    hashTableOffset,
    blockTableOffset,
    hashTableEntries,
    blockTableEntries,
    offset,
    ...(extendedBlockTableOffset !== undefined ? { extendedBlockTableOffset } : {}),
    ...(hashTableOffsetHigh !== undefined ? { hashTableOffsetHigh } : {}),
    ...(blockTableOffsetHigh !== undefined ? { blockTableOffsetHigh } : {}),
    ...(archiveSize64 !== undefined ? { archiveSize64 } : {}),
    ...(betTableOffset !== undefined ? { betTableOffset } : {}),
    ...(hetTableOffset !== undefined ? { hetTableOffset } : {}),
  };
}

/**
 * Locate and parse the archive header, following a user-data header if present.
 *
 * `MPQ\x1a` means the archive starts at byte 0. `MPQ\x1b` means a user-data
 * block comes first and names where the archive really begins — which is what
 * every `.StormReplay` and `.SC2Replay` uses.
 */
export function readHeader(bytes: Uint8Array): MPQFileHeader {
  const r = new ByteReader(bytes);
  const magic = r.u32();

  if (magic === MAGIC_MPQ_HEADER) {
    return readFileHeader(bytes, 0);
  }

  if (magic === MAGIC_MPQ_USERDATA) {
    const userDataHeader = readUserDataHeader(bytes);
    const header = readFileHeader(bytes, userDataHeader.mpqHeaderOffset);
    return { ...header, userDataHeader };
  }

  throw new InvalidArchiveError(
    `not an MPQ archive: expected the file to begin with "MPQ\\x1a" or "MPQ\\x1b", ` +
      `found 0x${magic.toString(16).padStart(8, '0')}`,
  );
}
