import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Externalize react/ink so they resolve from node_modules at runtime
  external: ['react', 'ink', 'ink-text-input'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
