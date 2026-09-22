import { decodeUtf8 } from '../io/bytes.js';

/**
 * Parse `(listfile)` into file names.
 *
 * The 2018 version split on `'\r\n'` only. Real archives are produced by a
 * range of tools and use CRLF, LF or even a trailing separator, so split on
 * either and drop the empties — otherwise a single stray `\n` yields a phantom
 * entry whose hash lookup then fails.
 */
export function parseListfile(bytes: Uint8Array): string[] {
  return decodeUtf8(bytes)
    .split(/\r\n|\r|\n|;/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
