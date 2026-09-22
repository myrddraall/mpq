import { inflateSync, unzlibSync } from 'fflate';
import { CorruptDataError } from '../errors.js';

/**
 * Inflate a zlib (RFC 1950) or raw deflate (RFC 1951) stream.
 *
 * This path **threw outright** in @heroesbrowser/mpq 0.1.3
 * (`Unsupported compression type "zlib"`), which was the library's largest
 * functional gap: zlib is one of the two methods Blizzard actually uses.
 *
 * StormLib calls zlib's `inflate()` with default window bits, so the payload
 * normally carries the 2-byte RFC 1950 header. A few third-party packers emit
 * headerless deflate, so fall back to raw inflate rather than failing.
 */
export function decompressZlib(input: Uint8Array, expectedSize: number): Uint8Array {
  let out: Uint8Array;
  try {
    out = unzlibSync(input);
  } catch {
    try {
      out = inflateSync(input);
    } catch (cause) {
      throw new CorruptDataError(
        `zlib: the sector is neither a valid zlib nor a valid raw deflate stream ` +
          `(${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
  }

  // Every sector's output size is known in advance, so this is a free
  // integrity check -- and a free decompression-bomb guard for a library that
  // routinely parses untrusted uploads.
  if (expectedSize > 0 && out.byteLength !== expectedSize) {
    throw new CorruptDataError(
      `zlib: expected ${expectedSize} byte(s) of output, produced ${out.byteLength}`,
    );
  }

  return out;
}
