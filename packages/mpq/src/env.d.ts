// TextDecoder is declared ambiently rather than pulled in via `lib: ["DOM"]` or
// `@types/node`. Both exist in every target runtime (browsers, Node >= 11,
// workers), but naming either in `lib`/`types` would leak that whole global
// surface into consumers of the emitted .d.ts.
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}
