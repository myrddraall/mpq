import { deflateSync, zlibSync } from 'fflate';
import {
  HASH_ENTRY_EMPTY,
  MPQ_COMPRESSION_SPARSE,
  MPQ_COMPRESSION_ZLIB,
  MPQ_FILE_COMPRESS,
  MPQ_FILE_ENCRYPTED,
  MPQ_FILE_EXISTS,
  MPQ_FILE_FIX_KEY,
  MPQ_FILE_SECTOR_CRC,
  MPQ_FILE_SINGLE_UNIT,
} from '../../src/constants.js';
import { HashType, fileKey, fixFileKey, hashString } from '../../src/crypto/hash.js';
import { encryptBlock } from './encrypt-block.js';
import { compressSparse } from './sparse-encoder.js';

/**
 * A minimal MPQ *writer*, for building fixtures.
 *
 * Test-only: the library itself is read-only and will stay that way. This
 * exists so archive-level behaviour can be tested over cases that no real
 * replay happens to contain -- a file whose size is an exact multiple of the
 * sector size, a sector the packer chose to store raw, an encrypted file with
 * FIX_KEY, a v0 header with no user-data block -- each of which corresponds to
 * a specific bug in the 2018 implementation.
 *
 * Its obvious weakness is that a writer and a reader written by the same hand
 * can share a misreading and agree with each other. That is why the suite also
 * checks real Blizzard archives and per-codec vectors produced by the system
 * `bzip2`.
 */

export type SectorCompression = 'store' | 'zlib' | 'sparse' | 'bzip2-fixture' | 'raw-per-sector';

export interface FileSpec {
  readonly name: string;
  readonly data: Uint8Array;
  /** How to store it. `raw-per-sector` stores sectors that do not shrink. */
  readonly compression?: SectorCompression;
  readonly singleUnit?: boolean;
  readonly encrypted?: boolean;
  readonly fixKey?: boolean;
  readonly sectorCrc?: boolean;
  /** Pre-made bzip2 payloads, one per sector, for `bzip2-fixture`. */
  readonly bzip2Sectors?: readonly Uint8Array[];
}

export interface ArchiveSpec {
  readonly files: readonly FileSpec[];
  readonly formatVersion?: 0 | 1;
  readonly sectorSizeShift?: number;
  /** Emit an `MPQ\x1b` user-data header, as every replay does. */
  readonly userData?: Uint8Array | false;
  /** Hash table slots. Must be a power of two; defaults to the next one up. */
  readonly hashTableEntries?: number;
  /** Add a `(listfile)` naming every other file. Defaults to true. */
  readonly includeListfile?: boolean;
}

const MAGIC_HEADER = [0x4d, 0x50, 0x51, 0x1a]; // 'MPQ\x1a'
const MAGIC_USERDATA = [0x4d, 0x50, 0x51, 0x1b]; // 'MPQ\x1b'

class Writer {
  private parts: number[] = [];

  public u8(v: number): void {
    this.parts.push(v & 0xff);
  }
  public u16(v: number): void {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
  }
  public u32(v: number): void {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  public bytes(b: Uint8Array | readonly number[]): void {
    for (const x of b) this.parts.push(x & 0xff);
  }
  public padTo(length: number): void {
    while (this.parts.length < length) this.parts.push(0);
  }
  public get length(): number {
    return this.parts.length;
  }
  public finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

interface BuiltBlock {
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly flags: number;
}

/** Compress one sector, returning the mask-prefixed payload. */
function compressSector(
  data: Uint8Array,
  compression: SectorCompression,
  bzip2Payload?: Uint8Array,
): Uint8Array {
  switch (compression) {
    case 'zlib': {
      const body = zlibSync(data, { level: 9 });
      const out = new Uint8Array(body.byteLength + 1);
      out[0] = MPQ_COMPRESSION_ZLIB;
      out.set(body, 1);
      return out;
    }
    case 'sparse': {
      const body = compressSparse(data);
      const out = new Uint8Array(body.byteLength + 1);
      out[0] = MPQ_COMPRESSION_SPARSE;
      out.set(body, 1);
      return out;
    }
    case 'bzip2-fixture': {
      if (bzip2Payload === undefined) throw new Error('bzip2-fixture needs a payload');
      return bzip2Payload;
    }
    default:
      return data;
  }
}

/** Build the stored bytes for one file. */
function buildBlock(spec: FileSpec, sectorSize: number): BuiltBlock {
  const compression = spec.compression ?? 'store';
  const compresses = compression !== 'store';
  let flags = MPQ_FILE_EXISTS;
  if (compresses) flags |= MPQ_FILE_COMPRESS;
  if (spec.encrypted) flags |= MPQ_FILE_ENCRYPTED;
  if (spec.encrypted && spec.fixKey) flags |= MPQ_FILE_FIX_KEY;
  if (spec.singleUnit) flags |= MPQ_FILE_SINGLE_UNIT;
  if (!spec.singleUnit && spec.sectorCrc) flags |= MPQ_FILE_SECTOR_CRC;

  if (spec.singleUnit) {
    const body = compresses
      ? compressSector(spec.data, compression, spec.bzip2Sectors?.[0])
      : spec.data;
    // Only claim compression if it actually shrank; the reader decides by
    // comparing sizes, exactly as StormLib does.
    const stored = compresses && body.byteLength >= spec.data.byteLength ? spec.data : body;
    const effectiveFlags = stored === spec.data && compresses ? flags & ~MPQ_FILE_COMPRESS : flags;
    return { bytes: stored, size: spec.data.byteLength, flags: effectiveFlags };
  }

  const sectorCount = Math.ceil(spec.data.byteLength / sectorSize);
  const sectors: Uint8Array[] = [];

  for (let i = 0; i < sectorCount; i++) {
    const from = i * sectorSize;
    const raw = spec.data.subarray(from, Math.min(from + sectorSize, spec.data.byteLength));

    if (!compresses) {
      sectors.push(raw);
      continue;
    }

    const packed = compressSector(raw, compression, spec.bzip2Sectors?.[i]);
    // A real packer stores the sector raw when compression does not help. The
    // reader must then detect "not compressed" per sector rather than from the
    // file-level flag -- which is precisely what 0.1.3 got wrong.
    sectors.push(packed.byteLength < raw.byteLength ? packed : raw);
  }

  const hasCrc = spec.sectorCrc === true;
  const offsetCount = sectorCount + 1 + (hasCrc ? 1 : 0);
  const offsetTableBytes = offsetCount * 4;

  const offsets: number[] = [offsetTableBytes];
  let at = offsetTableBytes;
  for (const s of sectors) {
    at += s.byteLength;
    offsets.push(at);
  }
  if (hasCrc) {
    // A CRC sector must exist for the extra offset to point at; its contents
    // are not validated by this reader, only skipped.
    at += sectorCount * 4;
    offsets.push(at);
  }

  const w = new Writer();
  for (const o of offsets) w.u32(o);
  for (const s of sectors) w.bytes(s);
  if (hasCrc) for (let i = 0; i < sectorCount; i++) w.u32(0);

  return { bytes: w.finish(), size: spec.data.byteLength, flags };
}

/** Encrypt a built block in place of its plaintext form. */
function encryptBlockData(
  block: BuiltBlock,
  spec: FileSpec,
  blockOffset: number,
  sectorSize: number,
): Uint8Array {
  const base = fileKey(spec.name);
  const key =
    (block.flags & MPQ_FILE_FIX_KEY) !== 0 ? fixFileKey(base, blockOffset, block.size) : base;

  if ((block.flags & MPQ_FILE_SINGLE_UNIT) !== 0) {
    return encryptBlock(block.bytes, key);
  }

  const hasCrc = (block.flags & MPQ_FILE_SECTOR_CRC) !== 0;
  const sectorCount = Math.ceil(block.size / sectorSize);
  const offsetCount = sectorCount + 1 + (hasCrc ? 1 : 0);
  const offsetTableBytes = offsetCount * 4;

  // Offsets are read from the *plaintext* table before it is encrypted.
  const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength);
  const offsets: number[] = [];
  for (let i = 0; i < offsetCount; i++) offsets.push(view.getUint32(i * 4, true));

  const out = new Uint8Array(block.bytes.byteLength);
  // The offset table uses key - 1; sector i uses key + i.
  out.set(encryptBlock(block.bytes.subarray(0, offsetTableBytes), (key - 1) >>> 0), 0);
  for (let i = 0; i < sectorCount; i++) {
    const from = offsets[i]!;
    const to = offsets[i + 1]!;
    out.set(encryptBlock(block.bytes.subarray(from, to), (key + i) >>> 0), from);
  }
  if (hasCrc) {
    const from = offsets[sectorCount]!;
    out.set(block.bytes.subarray(from), from);
  }
  return out;
}

/** Assemble a complete MPQ archive. */
export function buildArchive(spec: ArchiveSpec): Uint8Array {
  const formatVersion = spec.formatVersion ?? 1;
  const sectorSizeShift = spec.sectorSizeShift ?? 3; // 512 << 3 = 4096
  const sectorSize = 512 << sectorSizeShift;
  const headerSize = formatVersion >= 1 ? 0x2c : 0x20;

  const files: FileSpec[] = [...spec.files];
  if (spec.includeListfile !== false) {
    const names = spec.files.map((f) => f.name).join('\r\n');
    files.push({
      name: '(listfile)',
      data: new TextEncoder().encode(names),
      compression: 'store',
    });
  }

  // --- user-data header, as every replay has ---
  const userDataPayload =
    spec.userData === false ? null : (spec.userData ?? new TextEncoder().encode('fixture'));

  const pre = new Writer();
  let mpqHeaderOffset = 0;
  if (userDataPayload !== null) {
    mpqHeaderOffset = 512;
    pre.bytes(MAGIC_USERDATA);
    pre.u32(userDataPayload.byteLength);
    pre.u32(mpqHeaderOffset);
    pre.u32(userDataPayload.byteLength);
    pre.bytes(userDataPayload);
    pre.padTo(mpqHeaderOffset);
  }

  // --- file data, laid out immediately after the header ---
  const dataStart = headerSize;
  const blocks: BuiltBlock[] = [];
  const blockOffsets: number[] = [];
  let cursor = dataStart;

  for (const file of files) {
    const block = buildBlock(file, sectorSize);
    const offset = cursor;
    const bytes = file.encrypted ? encryptBlockData(block, file, offset, sectorSize) : block.bytes;
    blocks.push({ ...block, bytes });
    blockOffsets.push(offset);
    cursor += bytes.byteLength;
  }

  const hashTableOffset = cursor;
  const hashTableEntries = spec.hashTableEntries ?? nextPowerOfTwo(Math.max(files.length * 2, 4));
  const blockTableOffset = hashTableOffset + hashTableEntries * 16;
  const blockTableEntries = files.length;

  // --- hash table: every slot starts EMPTY, then linear-probe insert ---
  const hash = new Writer();
  const slots: Array<{ a: number; b: number; block: number } | null> = new Array(
    hashTableEntries,
  ).fill(null);

  files.forEach((file, index) => {
    const mask = hashTableEntries - 1;
    let slot = hashString(file.name, HashType.TableOffset) & mask;
    let probes = 0;
    while (slots[slot] !== null) {
      slot = (slot + 1) & mask;
      if (++probes > hashTableEntries) throw new Error('hash table full');
    }
    slots[slot] = {
      a: hashString(file.name, HashType.NameA),
      b: hashString(file.name, HashType.NameB),
      block: index,
    };
  });

  for (const slot of slots) {
    if (slot === null) {
      hash.u32(HASH_ENTRY_EMPTY);
      hash.u32(HASH_ENTRY_EMPTY);
      hash.u16(0xffff);
      hash.u16(0xffff);
      hash.u32(HASH_ENTRY_EMPTY);
    } else {
      hash.u32(slot.a);
      hash.u32(slot.b);
      hash.u16(0);
      hash.u16(0);
      hash.u32(slot.block);
    }
  }

  const blockW = new Writer();
  blocks.forEach((block, i) => {
    blockW.u32(blockOffsets[i]!);
    blockW.u32(block.bytes.byteLength);
    blockW.u32(block.size);
    blockW.u32(block.flags);
  });

  const encryptedHash = encryptBlock(hash.finish(), hashString('(hash table)', HashType.FileKey));
  const encryptedBlock = encryptBlock(
    blockW.finish(),
    hashString('(block table)', HashType.FileKey),
  );

  const archiveSize = blockTableOffset + blockTableEntries * 16;

  // --- header ---
  const h = new Writer();
  h.bytes(MAGIC_HEADER);
  h.u32(headerSize);
  h.u32(archiveSize);
  h.u16(formatVersion);
  h.u16(sectorSizeShift);
  h.u32(hashTableOffset);
  h.u32(blockTableOffset);
  h.u32(hashTableEntries);
  h.u32(blockTableEntries);
  if (formatVersion >= 1) {
    h.u32(0); // extendedBlockTableOffset, low  -- 64-bit field
    h.u32(0); // extendedBlockTableOffset, high
    h.u16(0); // hashTableOffsetHigh  (16-bit, not 8 -- bug B2)
    h.u16(0); // blockTableOffsetHigh
  }
  h.padTo(headerSize);

  // --- concatenate ---
  const out = new Writer();
  out.bytes(pre.finish());
  out.bytes(h.finish());
  for (const block of blocks) out.bytes(block.bytes);
  out.bytes(encryptedHash);
  out.bytes(encryptedBlock);

  return out.finish();
}

/** Raw deflate variant, for the packers that emit headerless streams. */
export function rawDeflateSector(data: Uint8Array): Uint8Array {
  const body = deflateSync(data, { level: 9 });
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = MPQ_COMPRESSION_ZLIB;
  out.set(body, 1);
  return out;
}
