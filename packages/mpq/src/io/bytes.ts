import { OutOfBoundsError } from '../errors.js';

/**
 * A bounds-checked `subarray`.
 *
 * NOTE `subarray`, not `slice`. This is the single most important distinction
 * in the port away from `Buffer`: `Buffer#slice` returns a VIEW, whereas
 * `Uint8Array#slice` COPIES. A mechanical rename of the 2018 code would have
 * compiled, passed tests, and silently added a copy of every sector of every
 * file. Copies happen only where one is explicitly wanted.
 */
export function subarrayChecked(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
    throw new OutOfBoundsError(offset, length, bytes.byteLength);
  }
  if (offset + length > bytes.byteLength) {
    throw new OutOfBoundsError(offset, length, bytes.byteLength);
  }
  return bytes.subarray(offset, offset + length);
}

// One decoder, created lazily so merely importing the library does not touch a
// global that might be absent in an exotic runtime.
let utf8Decoder: TextDecoder | undefined;

/** Decode UTF-8. Invalid sequences become U+FFFD, matching `Buffer#toString`. */
export function decodeUtf8(bytes: Uint8Array): string {
  utf8Decoder ??= new TextDecoder('utf-8');
  return utf8Decoder.decode(bytes);
}

/**
 * Compare the first bytes against an ASCII signature without decoding.
 *
 * The 2018 code did `data.toString('utf-8', 0, 4) === 'MPQ\\x1a'`, which
 * allocates a string and runs UTF-8 validation on bytes that are not text.
 */
export function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/** Concatenate without the O(n^2) repeated-reallocation the 2018 loop had. */
export function concatBytes(parts: readonly Uint8Array[], totalLength?: number): Uint8Array {
  const total = totalLength ?? parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
