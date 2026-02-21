import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';

// Build main process
await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outdir: 'dist/main',
  external: ['electron'],
  sourcemap: true,
  format: 'cjs',
});

// Build renderer process
await build({
  entryPoints: ['src/renderer/renderer.ts'],
  bundle: true,
  platform: 'browser',
  target: 'chrome130',
  outdir: 'dist/renderer',
  sourcemap: true,
  format: 'iife',
});

// Copy static files to dist
const staticFiles = [
  ['src/renderer/index.html', 'dist/renderer/index.html'],
  ['src/renderer/styles.css', 'dist/renderer/styles.css'],
];

for (const [src, dest] of staticFiles) {
  const destDir = dirname(dest);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
}

console.log('Build complete.');
