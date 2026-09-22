/**
 * A BigInt mirror of the EXACT operation sequence @heroesbrowser/mpq 0.1.3 ran
 * through `long@4`.
 *
 * This exists so the uint32 rewrite can be checked differentially rather than
 * only against captured vectors: BigInt is arbitrary-precision, so it cannot
 * silently lose the high bits that were the whole reason the original used a
 * 64-bit Long class. If production and this model agree over random inputs,
 * the `>>> 0` reduction is doing exactly what `.and(0xFFFFFFFF)` did.
 *
 * Kept deliberately literal — one BigInt operation per original Long call, in
 * the original order — rather than tidied up. Its value is fidelity, not
 * elegance.
 */

const M32 = (1n << 32n) - 1n;

/** Mirror of the 2018 `_encryptionTable` IIFE. */
export function encryptionTableModel(): number[] {
  const table = new Array<number>(0x500);
  let seed = 0x00100001n;

  for (let i = 0; i < 0x100; i++) {
    let index = i;
    for (let j = 0; j < 5; j++) {
      seed = (seed * 125n + 3n) % 0x2aaaabn;
      const t1 = (seed & 0xffffn) << 0x10n;
      seed = (seed * 125n + 3n) % 0x2aaaabn;
      const t2 = seed & 0xffffn;
      table[index] = Number((t1 | t2) & M32);
      index += 0x100;
    }
  }

  return table;
}

/**
 * Mirror of the 2018 `_hash`.
 *
 * Note it reproduces the original's `value.toUpperCase()` rather than the
 * byte-wise upper-casing production now uses, and it does NOT reproduce the
 * inverted `isNaN(parseInt(ch))` guard — that guard simply threw, so there is
 * no behaviour to mirror. Callers must therefore compare only over names whose
 * `toUpperCase()` is byte-identical to ASCII upper-casing and that contain no
 * `/`.
 */
export function hashStringModel(value: string, type: number, table: number[]): number {
  let seed1 = 0x7fed7fedn;
  let seed2 = 0xeeeeeeeen;

  for (const c of value.toUpperCase()) {
    const ch = BigInt(c.codePointAt(0)!);
    const result = BigInt(table[(type << 8) + Number(ch)]!);
    seed1 = (result ^ ((seed1 + seed2) & M32)) & M32;
    seed2 = (seed1 + seed2 + ch + (seed2 << 5n) + 3n) & M32;
  }

  return Number(seed1);
}

/**
 * Mirror of the 2018 `_decrypt`, including its big-endian output.
 *
 * Reads ciphertext little-endian and writes plaintext BIG-endian, exactly as
 * 0.1.3 did. Production now writes little-endian (StormLib's actual byte
 * order), so a comparison against this model must byte-swap each output word —
 * which is precisely the bug-B6 coupling made explicit and testable.
 */
export function decryptBlockModel(
  bytes: Uint8Array,
  key: number,
  table: number[],
): { plainWordsLE: number[]; bigEndianBytes: Uint8Array } {
  const words = bytes.byteLength >>> 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(bytes.byteLength);
  const outView = new DataView(out.buffer);
  const plain: number[] = [];

  let seed1 = BigInt(key >>> 0);
  let seed2 = 0xeeeeeeeen;

  for (let i = 0; i < words; i++) {
    // The original wrote `seed1 & 0xFF` where seed1 was a Long OBJECT. That
    // coerced via toString() -> Number -> ToInt32, which is exact below 2^53,
    // so it equalled `seed1.and(0xFF)`. Mirrored here as the masked value it
    // actually produced.
    seed2 = (seed2 + BigInt(table[0x400 + Number(seed1 & 0xffn)]!)) & M32;

    let value = BigInt(view.getUint32(i * 4, true));
    value = (value ^ ((seed1 + seed2) & M32)) & M32;

    seed1 = (((seed1 ^ 0xffffffffffffffffn) << 0x15n) + 0x11111111n) | (seed1 >> 0x0bn);
    seed1 &= M32;

    seed2 = (value + seed2 + (seed2 << 5n) + 3n) & M32;

    plain.push(Number(value));
    outView.setUint32(i * 4, Number(value), false); // BIG-endian, as in 0.1.3
  }

  return { plainWordsLE: plain, bigEndianBytes: out };
}
