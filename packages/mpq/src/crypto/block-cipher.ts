import { ENCRYPTION_TABLE } from './encryption-table.js';

/**
 * Decrypt `bytes` in place, as little-endian uint32 words.
 *
 * Trailing 1-3 bytes are left untouched, matching StormLib, which processes
 * `dwLength / 4` dwords and ignores the tail. The 2018 version used
 * `data.length / 4` as a non-integer loop bound, so for any length that is not
 * a multiple of 4 it ran one iteration too many and threw off the end of the
 * buffer.
 *
 * ENDIANNESS — a deliberate behaviour change from @heroesbrowser/mpq 0.1.3.
 * That version wrote plaintext BIG-endian and its hash/block table parsers
 * compensated by reading big-endian. The pair was self-consistent for tables,
 * but it made the cipher unusable for file payloads, which is what encrypted
 * file support needs. This version writes little-endian — byte-for-byte what
 * StormLib produces — so the table parsers read little-endian to match. Those
 * two decisions are a matched pair; changing one alone silently breaks every
 * archive.
 */
export function decryptBlockInPlace(bytes: Uint8Array, key: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = bytes.byteLength >>> 2;

  let seed1 = key >>> 0;
  let seed2 = 0xeeeeeeee;

  for (let i = 0; i < words; i++) {
    // `seed1 & 0xFF` is simply seed1's low byte, because seed1 is a plain
    // uint32 here.
    //
    // Worth recording: in 0.1.3 seed1 was a `Long` OBJECT and this same
    // expression coerced it Object -> toString() -> Number -> ToInt32. Because
    // seed1 < 2^32 < 2^53 that decimal round-trip is exact, so it happened to
    // yield precisely `seed1.and(0xFF)`. The 2018 output was CORRECT; it was a
    // type error, not a value error, and it survived only because
    // `noImplicitAny` was off.
    seed2 = (seed2 + ENCRYPTION_TABLE[0x400 + (seed1 & 0xff)]!) >>> 0;

    const at = i << 2;
    const cipher = view.getUint32(at, true);

    // seed1 + seed2 < 2^33 is exact; `^` truncates exactly mod 2^32.
    const plain = (cipher ^ (seed1 + seed2)) >>> 0;

    // The Long original was:
    //   seed1.xor(-1).shiftLeft(0x15).add(0x11111111)
    //        .or(seed1.shiftRight(0x0B)).and(0xFFFFFFFF)
    //
    //  - `~seed1` as an int32 is congruent mod 2^32 to the 64-bit `~seed1`;
    //    `<< 21` and `+ 0x11111111` preserve that congruence, so the low 32
    //    bits are identical. `|` then reads exactly those low bits via ToInt32.
    //  - The Long version's arithmetic `shiftRight(0x0B)` behaved as a logical
    //    shift because seed1's high word was always zero, so `>>> 11` on a
    //    uint32 reproduces it.
    //  - The parentheses matter: in JavaScript `+` binds TIGHTER than `<<`, so
    //    `~seed1 << 21 + 0x11111111` would parse as `~seed1 << (21 + ...)`.
    seed1 = (((~seed1 << 21) + 0x11111111) | (seed1 >>> 11)) >>> 0;

    // plain + seed2 + seed2 * 32 + 3 < 2^37 + 2^33 is exact; `>>> 0` reduces
    // mod 2^32. Note this consumes the PLAINTEXT word, which is what makes the
    // encrypting counterpart a symmetric mirror of this loop.
    seed2 = (plain + seed2 + seed2 * 32 + 3) >>> 0;

    view.setUint32(at, plain, true);
  }
}

/**
 * Copying form of {@link decryptBlockInPlace}.
 *
 * `slice()` COPIES, unlike `Buffer#slice` and unlike `subarray()`. That is
 * intentional here and is the one place in this library where a copy is wanted.
 */
export function decryptBlock(bytes: Uint8Array, key: number): Uint8Array {
  const out = bytes.slice();
  decryptBlockInPlace(out, key);
  return out;
}
