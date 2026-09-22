import { CorruptDataError } from '../errors.js';

/**
 * Sparse / RLE decompression (mask 0x20), per StormLib's `sparse.cpp`.
 *
 * Layout: a 4-byte BIG-endian uncompressed size, then a stream of control
 * bytes. A control byte with the high bit set copies `(ctrl & 0x7F) + 1`
 * literal bytes; otherwise it emits `(ctrl & 0x7F) + 3` zero bytes.
 *
 * The zero-run branch is a no-op beyond advancing the cursor, because
 * `new Uint8Array(n)` is already zero-filled.
 *
 * Caveat worth knowing: no Blizzard replay ships sparse sectors, so this
 * implementation is exercised only by synthetic fixtures and by hand-computed
 * literal vectors in `test/compression.test.ts`. It is implemented because it
 * is cheap and appears in other MPQs, not because it is well covered by real
 * data.
 */
export function decompressSparse(input: Uint8Array, expectedSize: number): Uint8Array {
  if (input.byteLength < 4) {
    throw new CorruptDataError('sparse: truncated before the 4-byte size prefix');
  }

  // Big-endian, unlike every other integer in the format.
  const size = ((input[0]! << 24) | (input[1]! << 16) | (input[2]! << 8) | input[3]!) >>> 0;

  if (expectedSize > 0 && size !== expectedSize) {
    throw new CorruptDataError(
      `sparse: header declares ${size} byte(s) but ${expectedSize} were expected`,
    );
  }

  const out = new Uint8Array(size);
  let ip = 4;
  let op = 0;

  while (ip < input.byteLength && op < size) {
    const ctrl = input[ip++]!;

    if ((ctrl & 0x80) !== 0) {
      const count = (ctrl & 0x7f) + 1;
      if (ip + count > input.byteLength) {
        throw new CorruptDataError(`sparse: literal run of ${count} overruns the input`);
      }
      if (op + count > size) {
        throw new CorruptDataError(`sparse: literal run of ${count} overruns the output`);
      }
      out.set(input.subarray(ip, ip + count), op);
      ip += count;
      op += count;
    } else {
      const count = (ctrl & 0x7f) + 3;
      if (op + count > size) {
        throw new CorruptDataError(`sparse: zero run of ${count} overruns the output`);
      }
      // out is already zero-filled; only the cursor moves.
      op += count;
    }
  }

  if (op !== size) {
    throw new CorruptDataError(`sparse: produced ${op} byte(s), expected ${size}`);
  }

  return out;
}
