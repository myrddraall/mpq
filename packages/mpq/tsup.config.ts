import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  // fflate stays external rather than inlined: it is already dual-format and
  // zero-dependency, and bundling it would duplicate it for any consumer that
  // also depends on it directly.
  external: ['fflate'],
});
