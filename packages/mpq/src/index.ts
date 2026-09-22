/**
 * @myrddraall/mpq -- read Blizzard MPQ archives in the browser and in Node.
 *
 * Successor to @heroesbrowser/mpq. Descended from a chain of ports:
 *   mpyq (Aku Kotkavuo, Python)
 *     -> mpyqjs (Farof)
 *     -> empeeku (nexus-devtools)
 *     -> @heroesbrowser/mpq (this library's 2018 incarnation)
 */

export { MPQArchive } from './archive.js';
export type { MPQArchiveOptions } from './archive.js';

export type {
  MPQBlockTableEntry,
  MPQFileHeader,
  MPQFileInfo,
  MPQHashTableEntry,
  MPQUserDataHeader,
} from './types.js';

export {
  CorruptDataError,
  FileKeyUnknownError,
  InvalidArchiveError,
  InvalidFileNameError,
  MPQError,
  OutOfBoundsError,
  UnsupportedCompressionError,
  UnsupportedFormatError,
} from './errors.js';

export { HashType, hashString, fileKey, fixFileKey } from './crypto/hash.js';
export { decryptBlock, decryptBlockInPlace } from './crypto/block-cipher.js';
export { ENCRYPTION_TABLE } from './crypto/encryption-table.js';

export { decompressSector, describeCompression } from './compression/index.js';
export type { Codec } from './compression/index.js';

export { readFileHeader, readHeader, readUserDataHeader } from './headers.js';
export { parseListfile } from './tables/listfile.js';

export * from './constants.js';
