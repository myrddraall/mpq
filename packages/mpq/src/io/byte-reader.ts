import { OutOfBoundsError } from '../errors.js';

/**
 * A bounds-checked cursor over a `Uint8Array`.
 *
 * Every structure in an MPQ is a run of little-endian integers, so parsing is
 * almost entirely sequential. Holding the cursor here keeps the offset
 * arithmetic — the easiest thing to get wrong when hand-porting struct
 * layouts — in one tested place.
 *
 * Bounds are checked on every read. The archive being parsed is frequently an
 * untrusted browser upload, and a truncated file should produce a typed
 * `OutOfBoundsError` naming the offset rather than an opaque `RangeError` from
 * deep inside a DataView.
 */
export class ByteReader {
  private readonly view: DataView;
  private cursor = 0;

  public constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  public get offset(): number {
    return this.cursor;
  }

  public get length(): number {
    return this.bytes.byteLength;
  }

  public get remaining(): number {
    return this.bytes.byteLength - this.cursor;
  }

  public seek(offset: number): this {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.bytes.byteLength) {
      throw new OutOfBoundsError(offset, 0, this.bytes.byteLength);
    }
    this.cursor = offset;
    return this;
  }

  public skip(count: number): this {
    return this.seek(this.cursor + count);
  }

  private require(length: number): number {
    const at = this.cursor;
    if (at + length > this.bytes.byteLength) {
      throw new OutOfBoundsError(at, length, this.bytes.byteLength);
    }
    this.cursor = at + length;
    return at;
  }

  public u8(): number {
    return this.view.getUint8(this.require(1));
  }

  public u16(): number {
    return this.view.getUint16(this.require(2), true);
  }

  public u32(): number {
    return this.view.getUint32(this.require(4), true);
  }

  /**
   * A 64-bit little-endian unsigned value, as a Number.
   *
   * Replaces `data.readIntLE(0, 8)` from the 2018 `MPQFileHeaderExt`, which
   * **threw on Node for every `formatVersion === 1` archive**: Node caps
   * `readIntLE` at 6 bytes (`ERR_OUT_OF_RANGE`). It appeared to work only in a
   * browser bundle, where the `buffer` shim has no such cap and read 8 bytes
   * into a lossy double.
   *
   * Values above 2^53 are rejected rather than silently rounded. No real MPQ
   * has a table beyond 4 GB, so a high dword this large means a corrupt or
   * hostile header.
   */
  public u64(): number {
    const at = this.require(8);
    const low = this.view.getUint32(at, true);
    const high = this.view.getUint32(at + 4, true);
    if (high > 0x001fffff) {
      throw new OutOfBoundsError(at, 8, this.bytes.byteLength);
    }
    return high * 0x100000000 + low;
  }

  /** A view over the next `length` bytes. A view, not a copy. */
  public take(length: number): Uint8Array {
    const at = this.require(length);
    return this.bytes.subarray(at, at + length);
  }
}
