/**
 * bzip2's CRC-32.
 *
 * Not the common zlib/PNG CRC-32: bzip2 uses the same polynomial but feeds
 * bits most-significant-first and does not reflect the input or output. A
 * zlib CRC table will silently produce a different value, which is why this is
 * implemented separately rather than borrowed.
 *
 * Ported from seek-bzip's `crc32.js` (MIT) -- see NOTICE.
 */
const TABLE: Uint32Array = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x80000000) !== 0 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export class Crc32 {
  private crc = 0xffffffff;

  public updateByte(byte: number): void {
    this.crc = ((this.crc << 8) ^ TABLE[((this.crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }

  public update(bytes: Uint8Array, length: number = bytes.byteLength): void {
    for (let i = 0; i < length; i++) this.updateByte(bytes[i]!);
  }

  public get value(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}
