import { ByteReader } from '../io/byte-reader.js';
import type { MPQBlockTableEntry } from '../types.js';

/** Bytes per block table entry. */
export const BLOCK_ENTRY_SIZE = 16;

/** Parse a decrypted block table. Little-endian; see {@link parseHashTable}. */
export function parseBlockTable(bytes: Uint8Array, entries: number): MPQBlockTableEntry[] {
  const r = new ByteReader(bytes);
  const out: MPQBlockTableEntry[] = new Array<MPQBlockTableEntry>(entries);

  for (let i = 0; i < entries; i++) {
    r.seek(i * BLOCK_ENTRY_SIZE);
    out[i] = {
      offset: r.u32(),
      archivedSize: r.u32(),
      size: r.u32(),
      flags: r.u32(),
    };
  }

  return out;
}
