import { context } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, watch } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';

const staticFiles = [
  ['src/renderer/index.html', 'dist/renderer/index.html'],
  ['src/renderer/styles.css', 'dist/renderer/styles.css'],
];

function copyStatic() {
  for (const [src, dest] of staticFiles) {
    const destDir = dirname(dest);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
  }
}

const logPlugin = {
  name: 'log-rebuild',
  setup(build) {
    build.onEnd((result) => {
      copyStatic();
      const time = new Date().toLocaleTimeString();
      if (result.errors.length) {
        console.log(`[${time}] Build failed with ${result.errors.length} error(s).`);
      } else {
        console.log(`[${time}] Build complete.`);
      }
    });
  },
};

// Main process (with plugin to copy static files + log)
const mainCtx = await context({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outdir: 'dist/main',
  external: ['electron'],
  sourcemap: true,
  format: 'cjs',
  plugins: [logPlugin],
});

// Renderer process
const rendererCtx = await context({
  entryPoints: ['src/renderer/renderer.ts'],
  bundle: true,
  platform: 'browser',
  target: 'chrome130',
  outdir: 'dist/renderer',
  sourcemap: true,
  format: 'iife',
});

// Initial build
await mainCtx.rebuild();
await rendererCtx.rebuild();

// Start watching TS sources
await mainCtx.watch();
await rendererCtx.watch();

// Watch static files and copy on change
for (const [src] of staticFiles) {
  watch(src, () => {
    copyStatic();
    console.log(`[${new Date().toLocaleTimeString()}] Static files updated.`);
  });
}

console.log('Watching for changes...');

// Launch electronmon (watches dist/ and restarts Electron automatically)
const child = spawn('npx', ['electronmon', '.'], {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', () => {
  mainCtx.dispose();
  rendererCtx.dispose();
  process.exit();
});
