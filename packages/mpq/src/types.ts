/**
 * Header and table shapes.
 *
 * These are `interface`s, where the 2018 version used classes that parsed
 * themselves in their constructors. The change removes twelve
 * `strictPropertyInitialization` errors at a stroke, and it is invisible to
 * consumers, who only ever used them as types. Parsing now lives in explicit
 * functions, which is also what makes the little-endian fix testable in
 * isolation.
 */

/** The `MPQ\x1b` block that precedes the archive proper in a replay file. */
export interface MPQUserDataHeader {
  /** Raw magic dword, `MPQ\x1b`. */
  readonly magic: number;
  readonly userDataSize: number;
  /** Where the real MPQ header starts, relative to the start of the file. */
  readonly mpqHeaderOffset: number;
  readonly userDataHeaderSize: number;
  /**
   * The user-data payload. For a StormReplay this is the serialised replay
   * header (version and elapsed game loops).
   *
   * A `Uint8Array` rather than a `Buffer` — see the README's migration note.
   */
  readonly content: Uint8Array;
}

/** The `MPQ\x1a` archive header, format v0 with the v1 extension folded in. */
export interface MPQFileHeader {
  readonly magic: number;
  readonly headerSize: number;
  readonly archiveSize: number;
  /** 0 = original, 1 = Burning Crusade / extended. 2 and 3 are rejected. */
  readonly formatVersion: number;
  /** Sector size is `512 << sectorSizeShift`. */
  readonly sectorSizeShift: number;
  readonly hashTableOffset: number;
  readonly blockTableOffset: number;
  readonly hashTableEntries: number;
  readonly blockTableEntries: number;
  /** Where this header sits in the file; 0 unless a user-data header precedes it. */
  readonly offset: number;
  /** Present only on `formatVersion >= 1`. */
  readonly extendedBlockTableOffset?: number;
  /** Present only on `formatVersion >= 1`. 16-bit, not 8-bit. */
  readonly hashTableOffsetHigh?: number;
  /** Present only on `formatVersion >= 1`. 16-bit, not 8-bit. */
  readonly blockTableOffsetHigh?: number;
  /** Present only on `formatVersion >= 2`. */
  readonly archiveSize64?: number;
  /**
   * Present only on `formatVersion >= 2`. Offset of the BET table, an optional
   * acceleration structure this library does not read.
   */
  readonly betTableOffset?: number;
  /** Present only on `formatVersion >= 2`. Offset of the optional HET table. */
  readonly hetTableOffset?: number;
  readonly userDataHeader?: MPQUserDataHeader;
}

export interface MPQHashTableEntry {
  readonly hashA: number;
  readonly hashB: number;
  readonly locale: number;
  readonly platform: number;
  readonly blockTableIndex: number;
}

export interface MPQBlockTableEntry {
  /** Relative to the MPQ header, not to the start of the file. */
  readonly offset: number;
  readonly archivedSize: number;
  readonly size: number;
  readonly flags: number;
}

/** What {@link MPQArchive.stat} reports about a stored file. */
export interface MPQFileInfo {
  readonly name: string;
  /**
   * Where the stored bytes begin, relative to the MPQ header. Add
   * `header.offset` for a position within the file.
   *
   * Exposed because it is the only way to inspect a block's compression mask
   * byte without re-deriving the tables, which diagnostics and tests
   * legitimately want.
   */
  readonly offset: number;
  /** Size once decompressed. */
  readonly size: number;
  /** Size as stored in the archive. */
  readonly archivedSize: number;
  readonly flags: number;
  readonly compressed: boolean;
  readonly encrypted: boolean;
  readonly singleUnit: boolean;
}
