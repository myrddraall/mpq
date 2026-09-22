/** Block table flags (`MPQBlockTableEntry.flags`). */
export const MPQ_FILE_IMPLODE: number = 0x00000100;
export const MPQ_FILE_COMPRESS: number = 0x00000200;
export const MPQ_FILE_ENCRYPTED: number = 0x00010000;
export const MPQ_FILE_FIX_KEY: number = 0x00020000;
export const MPQ_FILE_PATCH_FILE: number = 0x00080000;
export const MPQ_FILE_SINGLE_UNIT: number = 0x01000000;
export const MPQ_FILE_DELETE_MARKER: number = 0x02000000;
export const MPQ_FILE_SECTOR_CRC: number = 0x04000000;
/**
 * Note this is 0x80000000, which as a signed int32 is negative. Always compare
 * with `(flags & MPQ_FILE_EXISTS) !== 0` rather than relying on truthiness.
 */
export const MPQ_FILE_EXISTS: number = 0x80000000;

/**
 * Compression methods, as they appear in a sector's leading mask byte.
 *
 * The byte is a BITMASK: several methods can be chained (0x22 is sparse+zlib).
 * LZMA is the exception — 0x12 is an exclusive sentinel, not BZIP2|ZLIB — which
 * is why it must be tested for equality before any bit is examined.
 */
export const MPQ_COMPRESSION_HUFFMANN: number = 0x01;
export const MPQ_COMPRESSION_ZLIB: number = 0x02;
export const MPQ_COMPRESSION_PKWARE: number = 0x08;
export const MPQ_COMPRESSION_BZIP2: number = 0x10;
export const MPQ_COMPRESSION_SPARSE: number = 0x20;
export const MPQ_COMPRESSION_ADPCM_MONO: number = 0x40;
export const MPQ_COMPRESSION_ADPCM_STEREO: number = 0x80;
export const MPQ_COMPRESSION_LZMA: number = 0x12;

/** Hash table sentinels for an unused / freed slot. */
export const HASH_ENTRY_EMPTY: number = 0xffffffff;
export const HASH_ENTRY_DELETED: number = 0xfffffffe;

/** `MPQ\x1a` — the archive header. */
export const MAGIC_MPQ_HEADER: number = 0x1a51504d;
/** `MPQ\x1b` — the user-data header that precedes the archive in a replay. */
export const MAGIC_MPQ_USERDATA: number = 0x1b51504d;

/**
 * Guard rails for untrusted input. A hostile header can claim 2^32 table
 * entries; at 16 bytes each that is a 64 GB allocation request. These caps are
 * far above any real archive (a StormReplay has a handful of files).
 */
export const MAX_TABLE_ENTRIES: number = 1 << 22;
export const MAX_SECTOR_COUNT: number = 1 << 22;
