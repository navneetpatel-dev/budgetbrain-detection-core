import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'corpus/index': 'src/corpus/index.ts',
    'bench/index': 'src/bench/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // ES2020 keeps BigInt (needed by Ed25519) and runs on Hermes, Node 20 and modern browsers.
  target: 'es2020',
  // @noble/* is ESM-only; bundling it gives consumers zero runtime dependencies and lets the
  // CommonJS backend require this package on Node 20 without require(esm).
  noExternal: [/^@noble\//],
});
