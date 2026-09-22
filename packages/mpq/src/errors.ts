/** Base class for every error this library raises deliberately. */
export class MPQError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MPQError';
  }
}

/** The bytes are not an MPQ archive at all, or the header magic is unknown. */
export class InvalidArchiveError extends MPQError {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidArchiveError';
  }
}

/** Structurally valid but self-inconsistent: offsets or sizes out of range. */
export class CorruptDataError extends MPQError {
  public constructor(message: string) {
    super(message);
    this.name = 'CorruptDataError';
  }
}

/** A read ran past the end of the buffer. */
export class OutOfBoundsError extends CorruptDataError {
  public constructor(offset: number, length: number, available: number) {
    super(
      `read of ${length} byte(s) at offset ${offset} exceeds the available ${available} byte(s)`,
    );
    this.name = 'OutOfBoundsError';
  }
}

/** A real archive format this library has not implemented. */
export class UnsupportedFormatError extends MPQError {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

/**
 * A compression method that exists in the format but is not implemented here.
 * Carries the method name and the raw mask so callers can report precisely.
 */
export class UnsupportedCompressionError extends UnsupportedFormatError {
  public readonly method: string;
  public readonly mask: number;

  public constructor(method: string, mask: number) {
    super(
      `MPQ compression method "${method}" (mask 0x${mask.toString(16).padStart(2, '0')}) is not ` +
        `implemented by @myrddraall/mpq. Supported: store, zlib/deflate (0x02), bzip2 (0x10), ` +
        `sparse (0x20), and any bitmask combination of those.`,
    );
    this.name = 'UnsupportedCompressionError';
    this.method = method;
    this.mask = mask;
  }
}

/**
 * The file is encrypted and its key cannot be derived, because the key comes
 * from the file's own name and the name is not known. Recovering it needs
 * StormLib's known-plaintext attack, which is out of scope.
 */
export class FileKeyUnknownError extends UnsupportedFormatError {
  public constructor(fileName: string) {
    super(
      `cannot derive the decryption key for "${fileName}": an MPQ file key is derived from the ` +
        `file's real name, which this archive does not record. Recovering it requires a ` +
        `known-plaintext attack, which @myrddraall/mpq does not implement.`,
    );
    this.name = 'FileKeyUnknownError';
  }
}

/**
 * A file name that cannot be hashed. MPQ hashes bytes, so a code point above
 * 0xFF has no row in the encryption table.
 */
export class InvalidFileNameError extends MPQError {
  public constructor(name: string, index: number) {
    super(
      `file name ${JSON.stringify(name)} contains a non-ASCII character at index ${index}; ` +
        `MPQ name hashing operates on single bytes and has no mapping for it`,
    );
    this.name = 'InvalidFileNameError';
  }
}
