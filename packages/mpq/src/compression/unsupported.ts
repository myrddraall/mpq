import { UnsupportedCompressionError } from '../errors.js';

/**
 * Build a codec that refuses, naming the method.
 *
 * These methods are real parts of the MPQ format that this library does not
 * implement. They get explicit entries in the dispatch table rather than being
 * lumped into "unknown mask" so that the error says *which* method was needed:
 * "huffman (mask 0x01) is not implemented" is actionable, "unknown compression"
 * is not.
 */
export function unsupported(method: string, mask: number): () => never {
  return () => {
    throw new UnsupportedCompressionError(method, mask);
  };
}
