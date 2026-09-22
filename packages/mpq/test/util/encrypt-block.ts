import { ENCRYPTION_TABLE } from '../../src/crypto/encryption-table.js';

/**
 * The exact inverse of `decryptBlockInPlace`, for building fixtures.
 *
 * Test-only — an MPQ reader never needs to encrypt. It lives here so the
 * synthetic archive writer can produce genuinely encrypted hash tables, block
 * tables and file sectors, and so the round-trip property
 * `decrypt(encrypt(x, k), k) === x` can be asserted over random input.
 *
 * The seed recurrence is identical to the decrypting loop; the only difference
 * is which value is XORed out. Note that `seed2` is advanced from the
 * PLAINTEXT word in both directions, which is what makes the two loops
 * symmetric.
 */
export function encryptBlockInPlace(bytes: Uint8Array, key: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = bytes.byteLength >>> 2;

  let seed1 = key >>> 0;
  let seed2 = 0xeeeeeeee;

  for (let i = 0; i < words; i++) {
    seed2 = (seed2 + ENCRYPTION_TABLE[0x400 + (seed1 & 0xff)]!) >>> 0;

    const at = i << 2;
    const plain = view.getUint32(at, true);
    const cipher = (plain ^ (seed1 + seed2)) >>> 0;

    seed1 = (((~seed1 << 21) + 0x11111111) | (seed1 >>> 11)) >>> 0;
    seed2 = (plain + seed2 + seed2 * 32 + 3) >>> 0;

    view.setUint32(at, cipher, true);
  }
}

export function encryptBlock(bytes: Uint8Array, key: number): Uint8Array {
  const out = bytes.slice();
  encryptBlockInPlace(out, key);
  return out;
}
