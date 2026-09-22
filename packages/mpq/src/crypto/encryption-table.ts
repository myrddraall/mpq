/**
 * The MPQ encryption table: five 256-entry uint32 rows.
 *
 *   0x000  hash type 0 — hash-table index
 *   0x100  hash type 1 — name hash A
 *   0x200  hash type 2 — name hash B
 *   0x300  hash type 3 — per-file encryption key
 *   0x400  the block cipher's S-box
 *
 * Why plain Numbers are exact here, replacing the `long` dependency the 2018
 * version used:
 *
 *  - `seed` is reduced mod 0x2AAAAB every step, so `seed <= 0x2AAAAA`
 *    (2,796,202 < 2^22). The initial 0x00100001 already satisfies that.
 *  - Therefore `seed * 125 + 3` peaks at 349,394,253 — under 2^29, measured
 *    rather than estimated. `*`, `+` and `%` are all exact on doubles there.
 *    No Math.imul, no BigInt, no explicit `% 0x100000000`.
 *  - `seed & 0xFFFF` is safe because `seed < 2^31`, so ToInt32 does not
 *    truncate it.
 *  - `(x & 0xFFFF) << 0x10` CAN set bit 31, and JavaScript `<<` yields a
 *    SIGNED int32 (`0xFFFF << 16 === -65536`). The `>>> 0` below is what
 *    renormalises it. Storing into a Uint32Array would apply ToUint32 anyway,
 *    so it is strictly redundant — but it is kept because it makes the
 *    expression correct in isolation and marks the one genuinely signed
 *    operation in the whole crypto layer.
 *
 * Built once at module load, not per archive: the 2018 version rebuilt all 1280
 * entries in every `MPQArchive` constructor.
 */
export const ENCRYPTION_TABLE: Uint32Array = /* @__PURE__ */ (() => {
  const table = new Uint32Array(0x500);
  let seed = 0x00100001;

  for (let i = 0; i < 0x100; i++) {
    let index = i;
    for (let j = 0; j < 5; j++) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const high = (seed & 0xffff) << 0x10;
      seed = (seed * 125 + 3) % 0x2aaaab;
      const low = seed & 0xffff;
      table[index] = (high | low) >>> 0;
      index += 0x100;
    }
  }

  return table;
})();
