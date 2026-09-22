import { CorruptDataError } from '../../errors.js';

/**
 * MSB-first bit reader. bzip2 is a bit-oriented format: Huffman codes,
 * selectors and the block magic are all read most-significant-bit first and
 * are not byte-aligned.
 *
 * Ported from seek-bzip's `bitreader.js` (MIT) -- see NOTICE.
 */
export class BitReader {
  private bitOffset = 0;

  public constructor(private readonly bytes: Uint8Array) {}

  /** Read `count` bits (1..32) MSB-first as an unsigned value. */
  public read(count: number): number {
    let result = 0;

    for (let i = 0; i < count; i++) {
      const byteIndex = this.bitOffset >>> 3;
      if (byteIndex >= this.bytes.byteLength) {
        throw new CorruptDataError('bzip2: stream ended in the middle of a code');
      }
      const bit = (this.bytes[byteIndex]! >>> (7 - (this.bitOffset & 7))) & 1;
      // `* 2` rather than `<< 1`: a 32-bit read would otherwise overflow into
      // the sign bit on the final step.
      result = result * 2 + bit;
      this.bitOffset++;
    }

    return result;
  }

  /** One bit, as a 0/1 number. */
  public readBit(): number {
    return this.read(1);
  }

  /**
   * Read a 64-bit value as a pair of 32-bit halves. Used only for the block
   * magic, which is 48 bits and so exceeds what a single `read` can hold
   * exactly alongside the sign bit.
   */
  public readHalves(highBits: number, lowBits: number): [number, number] {
    return [this.read(highBits), this.read(lowBits)];
  }

  /** Advance to the next byte boundary. */
  public align(): void {
    this.bitOffset = (this.bitOffset + 7) & ~7;
  }

  public get bitPosition(): number {
    return this.bitOffset;
  }

  public get exhausted(): boolean {
    return this.bitOffset >= this.bytes.byteLength * 8;
  }
}
