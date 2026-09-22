import { ByteReader } from '../io/byte-reader.js';
import type { MPQHashTableEntry } from '../types.js';

/** Bytes per hash table entry. */
export const HASH_ENTRY_SIZE = 16;

/**
 * Parse a decrypted hash table.
 *
 * LITTLE-endian, unlike the 2018 `MPQHashTableEntry`, which read big-endian to
 * compensate for `_decrypt` writing its output big-endian. That pair was
 * self-consistent for tables but left the cipher unusable for file payloads.
 * The cipher now emits StormLib's real little-endian byte order, so these
 * reads had to flip with it — the two changes only make sense together.
 */
export function parseHashTable(bytes: Uint8Array, entries: number): MPQHashTableEntry[] {
  const r = new ByteReader(bytes);
  const out: MPQHashTableEntry[] = new Array<MPQHashTableEntry>(entries);

  for (let i = 0; i < entries; i++) {
    r.seek(i * HASH_ENTRY_SIZE);
    out[i] = {
      hashA: r.u32(),
      hashB: r.u32(),
      locale: r.u16(),
      platform: r.u16(),
      blockTableIndex: r.u32(),
    };
  }

  return out;
}
