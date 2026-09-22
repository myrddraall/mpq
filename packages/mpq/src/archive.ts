import {
  HASH_ENTRY_DELETED,
  HASH_ENTRY_EMPTY,
  MAX_SECTOR_COUNT,
  MAX_TABLE_ENTRIES,
  MPQ_FILE_COMPRESS,
  MPQ_FILE_DELETE_MARKER,
  MPQ_FILE_ENCRYPTED,
  MPQ_FILE_EXISTS,
  MPQ_FILE_FIX_KEY,
  MPQ_FILE_IMPLODE,
  MPQ_FILE_PATCH_FILE,
  MPQ_FILE_SECTOR_CRC,
  MPQ_FILE_SINGLE_UNIT,
} from './constants.js';
import { decompressSector } from './compression/index.js';
import { decryptBlock, decryptBlockInPlace } from './crypto/block-cipher.js';
import { HashType, fileKey, fixFileKey, hashString } from './crypto/hash.js';
import { CorruptDataError, UnsupportedCompressionError, UnsupportedFormatError } from './errors.js';
import { readHeader } from './headers.js';
import { ByteReader } from './io/byte-reader.js';
import { decodeUtf8, subarrayChecked } from './io/bytes.js';
import { BLOCK_ENTRY_SIZE, parseBlockTable } from './tables/block-table.js';
import { HASH_ENTRY_SIZE, parseHashTable } from './tables/hash-table.js';
import { parseListfile } from './tables/listfile.js';
import type { MPQBlockTableEntry, MPQFileHeader, MPQFileInfo, MPQHashTableEntry } from './types.js';

/** The internal file every archive uses to record its own contents. */
const LISTFILE = '(listfile)';

export interface MPQArchiveOptions {
  /**
   * @deprecated The file list is now parsed lazily on first access to
   * {@link MPQArchive.files}, so eagerly reading it has no benefit. Accepted
   * for source compatibility with 0.1.3 and otherwise ignored.
   */
  readonly listFiles?: boolean;
}

/**
 * A read-only view over an MPQ archive.
 *
 * Construction parses the header and both tables; file contents are read on
 * demand. The whole archive must be in memory, as in 0.1.3, but nothing is
 * copied that does not have to be: `subarray` views are used throughout, so
 * opening a 10 MB replay allocates only the tables.
 */
export class MPQArchive {
  private readonly data: Uint8Array;
  private readonly _header: MPQFileHeader;
  private readonly hashTable: readonly MPQHashTableEntry[];
  private readonly blockTable: readonly MPQBlockTableEntry[];
  private readonly sectorSize: number;

  /** Parsed on first access to {@link files}; `null` until then. */
  private _files: string[] | null = null;

  public constructor(
    mpqData: ArrayBuffer | ArrayBufferView,
    options: boolean | MPQArchiveOptions = {},
  ) {
    void options; // see MPQArchiveOptions.listFiles

    this.data =
      mpqData instanceof ArrayBuffer
        ? new Uint8Array(mpqData)
        : new Uint8Array(mpqData.buffer, mpqData.byteOffset, mpqData.byteLength);

    this._header = readHeader(this.data);
    this.sectorSize = 512 << this._header.sectorSizeShift;

    this.hashTable = this.readTable('hash');
    this.blockTable = this.readTable('block');
  }

  public get header(): MPQFileHeader {
    return this._header;
  }

  /** Sector size in bytes, `512 << sectorSizeShift`. */
  public get sectorSizeBytes(): number {
    return this.sectorSize;
  }

  /**
   * The names in `(listfile)`, or an empty array if the archive has none.
   *
   * Lazy: 0.1.3 read and decompressed the listfile in the constructor, so
   * every archive paid for it even when only one known file was wanted.
   */
  public get files(): string[] {
    if (this._files === null) {
      const listfile = this.readFile(LISTFILE);
      this._files = listfile === null ? [] : parseListfile(listfile);
    }
    return this._files;
  }

  /** Whether a file exists, without reading it. */
  public has(name: string): boolean {
    const hash = this.findHashEntry(name);
    if (hash === null) return null !== null;
    const block = this.blockTable[hash.blockTableIndex];
    return block !== undefined && this.isPresent(block.flags);
  }

  /** Metadata for one file, or `null` if it is not in the archive. */
  public stat(name: string): MPQFileInfo | null {
    const hash = this.findHashEntry(name);
    if (hash === null) return null;
    const block = this.blockTable[hash.blockTableIndex];
    if (block === undefined || !this.isPresent(block.flags)) return null;

    return {
      name,
      offset: block.offset,
      size: block.size,
      archivedSize: block.archivedSize,
      flags: block.flags,
      compressed: (block.flags & MPQ_FILE_COMPRESS) !== 0,
      encrypted: (block.flags & MPQ_FILE_ENCRYPTED) !== 0,
      singleUnit: (block.flags & MPQ_FILE_SINGLE_UNIT) !== 0,
    };
  }

  /** Read a file and decode it as UTF-8. */
  public readFileText(name: string): string | null {
    const bytes = this.readFile(name);
    return bytes === null ? null : decodeUtf8(bytes);
  }

  /**
   * Read and decompress one file.
   *
   * Returns `null` when the name is not in the archive, or names a deleted
   * entry, or has no stored data. (0.1.3 declared `: Buffer` but fell off the
   * end of the function returning `undefined` for a missing
   * `MPQ_FILE_EXISTS`, so callers saw both `null` and `undefined` depending on
   * which branch was taken. There is now one absent value.)
   *
   * @param forceDecompress Attempt decompression even when the stored size
   *   suggests the data is already uncompressed. Rarely needed; retained from
   *   0.1.3.
   */
  public readFile(name: string, forceDecompress = false): Uint8Array | null {
    const hash = this.findHashEntry(name);
    if (hash === null) return null;

    const block = this.blockTable[hash.blockTableIndex];
    if (block === undefined) {
      throw new CorruptDataError(
        `hash entry for "${name}" points at block ${hash.blockTableIndex}, but the block table ` +
          `has only ${this.blockTable.length} entries`,
      );
    }

    if (!this.isPresent(block.flags)) return null;

    // A zero-length file genuinely exists -- real replays ship an empty
    // `replay.sync.history` -- so it gets an empty array. `null` means absent,
    // and nothing else. (0.1.3 returned null for both, so callers could not
    // tell "no such file" from "file is empty".)
    if (block.archivedSize === 0 || block.size === 0) return new Uint8Array(0);

    this.rejectUnsupportedFlags(name, block.flags);

    const start = block.offset + this._header.offset;
    const stored = subarrayChecked(this.data, start, block.archivedSize);

    let key = 0;
    if ((block.flags & MPQ_FILE_ENCRYPTED) !== 0) {
      key = this.deriveKey(name, block);
    }

    return (block.flags & MPQ_FILE_SINGLE_UNIT) !== 0
      ? this.readSingleUnit(stored, block, key, forceDecompress)
      : this.readSectored(stored, block, key, forceDecompress);
  }

  // ---------------------------------------------------------------- internals

  private isPresent(flags: number): boolean {
    if ((flags & MPQ_FILE_EXISTS) === 0) return false;
    // 0.1.3 checked only MPQ_FILE_EXISTS, so a deleted entry -- which keeps
    // EXISTS set -- returned whatever bytes still happened to be on disk.
    if ((flags & MPQ_FILE_DELETE_MARKER) !== 0) return false;
    return true;
  }

  private rejectUnsupportedFlags(name: string, flags: number): void {
    if ((flags & MPQ_FILE_PATCH_FILE) !== 0) {
      throw new UnsupportedFormatError(
        `"${name}" is an incremental patch file (MPQ_FILE_PATCH_FILE); applying patch archives ` +
          `is not implemented`,
      );
    }
    // MPQ_FILE_IMPLODE sectors are raw PKWARE-imploded data with NO leading
    // mask byte, so they must never reach decompressSector -- it would read
    // the first data byte as a compression mask and produce garbage. 0.1.3
    // declared this flag and then ignored it entirely.
    if ((flags & MPQ_FILE_IMPLODE) !== 0 && (flags & MPQ_FILE_COMPRESS) === 0) {
      throw new UnsupportedCompressionError('pkware-implode (MPQ_FILE_IMPLODE)', MPQ_FILE_IMPLODE);
    }
  }

  /**
   * The per-file decryption key.
   *
   * The key derives from the file's own name, which is why an archive whose
   * listfile is missing cannot decrypt files addressed by pseudo-name.
   */
  private deriveKey(name: string, block: MPQBlockTableEntry): number {
    const base = fileKey(name);
    // FIX_KEY mixes in the block's offset RELATIVE TO THE MPQ HEADER -- not
    // its absolute position in the file. Adding header.offset here is the
    // classic way to get this wrong on a replay, where the archive does not
    // start at byte 0.
    return (block.flags & MPQ_FILE_FIX_KEY) !== 0
      ? fixFileKey(base, block.offset, block.size)
      : base;
  }

  private readSingleUnit(
    stored: Uint8Array,
    block: MPQBlockTableEntry,
    key: number,
    forceDecompress: boolean,
  ): Uint8Array {
    let data = stored;

    if (key !== 0 || (block.flags & MPQ_FILE_ENCRYPTED) !== 0) {
      data = decryptBlock(data, key);
    }

    const isCompressed =
      (block.flags & MPQ_FILE_COMPRESS) !== 0 &&
      (forceDecompress || block.size > block.archivedSize);

    return isCompressed ? decompressSector(data, block.size) : data.subarray(0, block.size);
  }

  private readSectored(
    stored: Uint8Array,
    block: MPQBlockTableEntry,
    key: number,
    forceDecompress: boolean,
  ): Uint8Array {
    const encrypted = (block.flags & MPQ_FILE_ENCRYPTED) !== 0;
    const hasSectorCrc = (block.flags & MPQ_FILE_SECTOR_CRC) !== 0;

    // Sector count is ceil(size / sectorSize).
    //
    // 0.1.3 used `trunc(size / sectorSize) + 1`, which is one too many when
    // the size is an exact multiple of the sector size. The surplus iteration
    // read an "offset" from inside real sector data and appended garbage to
    // the file.
    const sectorCount = Math.ceil(block.size / this.sectorSize);
    if (sectorCount > MAX_SECTOR_COUNT) {
      throw new CorruptDataError(
        `file claims ${sectorCount} sectors, above the ${MAX_SECTOR_COUNT} sanity limit`,
      );
    }

    // One offset per sector plus a terminator, plus one more when per-sector
    // CRCs are stored.
    const offsetCount = sectorCount + 1 + (hasSectorCrc ? 1 : 0);
    const offsetTableBytes = offsetCount * 4;

    let offsetTable = subarrayChecked(stored, 0, offsetTableBytes);
    if (encrypted) {
      // The offset table is encrypted with key - 1, each sector with key + i.
      offsetTable = decryptBlock(offsetTable, (key - 1) >>> 0);
    }

    const offsetReader = new ByteReader(offsetTable);
    const offsets = new Array<number>(offsetCount);
    for (let i = 0; i < offsetCount; i++) offsets[i] = offsetReader.u32();

    // StormLib's own consistency check, and a free independent verification of
    // the sector-count fix above: the first offset must point just past the
    // offset table itself. If the count were wrong, this would not line up.
    if (offsets[0] !== offsetTableBytes) {
      throw new CorruptDataError(
        `sector offset table is inconsistent: first offset is ${offsets[0]}, expected ` +
          `${offsetTableBytes} (${offsetCount} entries)`,
      );
    }

    const out = new Uint8Array(block.size);
    let written = 0;

    for (let i = 0; i < sectorCount; i++) {
      const from = offsets[i]!;
      const to = offsets[i + 1]!;
      if (to < from || to > stored.byteLength) {
        throw new CorruptDataError(
          `sector ${i} spans ${from}..${to}, outside the ${stored.byteLength}-byte block`,
        );
      }

      let sector = stored.subarray(from, to);
      if (encrypted) {
        sector = decryptBlock(sector, (key + i) >>> 0);
      }

      // This sector's expected output length -- the last sector is short.
      //
      // 0.1.3 decided "compressed" by comparing the REMAINING TOTAL against
      // this sector's stored length, which is almost always true for a
      // non-final sector. So a sector the packer chose to store raw had its
      // first byte misread as a compression mask. StormLib's rule is
      // per-sector: compressed iff stored < expected.
      const expected = Math.min(this.sectorSize, block.size - written);
      const storedLen = sector.byteLength;
      const isCompressed =
        (block.flags & MPQ_FILE_COMPRESS) !== 0 && (forceDecompress || storedLen < expected);

      const plain = isCompressed ? decompressSector(sector, expected) : sector;

      if (plain.byteLength !== expected) {
        throw new CorruptDataError(
          `sector ${i} produced ${plain.byteLength} byte(s), expected ${expected}`,
        );
      }

      out.set(plain, written);
      written += plain.byteLength;
    }

    if (written !== block.size) {
      throw new CorruptDataError(`assembled ${written} byte(s), expected ${block.size}`);
    }

    return out;
  }

  /**
   * Find a file's hash table entry.
   *
   * The canonical MPQ probe: start at `hash(name, TableOffset) & (n - 1)` and
   * scan forward, stopping at an EMPTY slot (never written, so the file cannot
   * be further on) but continuing past a DELETED one.
   *
   * 0.1.3 instead scanned the entire table linearly comparing hashA/hashB. That
   * found the right entry, but it also meant every lookup was O(n) and it
   * ignored the sentinels, so a deleted entry whose hashes still matched could
   * be returned.
   */
  private findHashEntry(name: string): MPQHashTableEntry | null {
    const count = this.hashTable.length;
    if (count === 0) return null;

    const wantA = hashString(name, HashType.NameA);
    const wantB = hashString(name, HashType.NameB);

    // The table length is a power of two in every well-formed archive, which
    // makes the mask a valid modulo. Fall back to a full scan if it is not,
    // rather than probing the wrong slots.
    const isPowerOfTwo = (count & (count - 1)) === 0;
    if (!isPowerOfTwo) {
      for (const entry of this.hashTable) {
        if (entry.hashA === wantA && entry.hashB === wantB) return entry;
      }
      return null;
    }

    const mask = count - 1;
    const start = hashString(name, HashType.TableOffset) & mask;

    for (let i = 0; i < count; i++) {
      const entry = this.hashTable[(start + i) & mask]!;

      if (entry.blockTableIndex === HASH_ENTRY_EMPTY) return null;
      if (entry.blockTableIndex === HASH_ENTRY_DELETED) continue;
      if (entry.hashA === wantA && entry.hashB === wantB) return entry;
    }

    return null;
  }

  private readTable(kind: 'hash'): MPQHashTableEntry[];
  private readTable(kind: 'block'): MPQBlockTableEntry[];
  private readTable(kind: 'hash' | 'block'): MPQHashTableEntry[] | MPQBlockTableEntry[] {
    // An explicit switch rather than `header[kind + 'TableOffset']`: the 2018
    // version built field names by string concatenation, which is exactly what
    // `noImplicitAny` rejects and what made the header impossible to type.
    const { offset, entries, entrySize } =
      kind === 'hash'
        ? {
            offset: this._header.hashTableOffset,
            entries: this._header.hashTableEntries,
            entrySize: HASH_ENTRY_SIZE,
          }
        : {
            offset: this._header.blockTableOffset,
            entries: this._header.blockTableEntries,
            entrySize: BLOCK_ENTRY_SIZE,
          };

    // Guard before allocating. A hostile header can claim 2^32 entries, which
    // at 16 bytes each is a 64 GB request -- and this library routinely parses
    // untrusted browser uploads.
    if (entries > MAX_TABLE_ENTRIES) {
      throw new CorruptDataError(
        `${kind} table claims ${entries} entries, above the ${MAX_TABLE_ENTRIES} sanity limit`,
      );
    }

    const bytes = subarrayChecked(this.data, offset + this._header.offset, entries * entrySize);

    // The tables are encrypted with a key derived from a fixed name. Decrypted
    // into a copy so the caller's buffer is never mutated.
    const table = bytes.slice();
    decryptBlockInPlace(table, hashString(`(${kind} table)`, HashType.FileKey));

    return kind === 'hash' ? parseHashTable(table, entries) : parseBlockTable(table, entries);
  }
}
