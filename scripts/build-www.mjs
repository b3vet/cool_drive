// Assemble the web assets into ./www for Capacitor (webDir) / static export.
// Zero-build game, so this just copies the files the browser needs.
import { cp, rm, mkdir } from 'node:fs/promises';

const dst = 'www';
const items = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-180.png', 'src', 'vendor', 'audio', 'models'];

await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });
// Don't bundle the raw (pre-optimization) Tripo car models — they're huge and dev-only.
const exclude = (src) => !/(^|\/)models\/_raw(\/|$)/.test(src);

for (const f of items) {
  try {
    await cp(f, `${dst}/${f}`, { recursive: true, filter: exclude });
  } catch (e) {
    console.warn('skip (missing):', f);
  }
}
console.log('Built ./www — ready for `npx cap sync` or static hosting.');
