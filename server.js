// Zero-dependency static file server for local dev.
// Usage: node server.js [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webmanifest': 'application/manifest+json',
};

// Static media is cacheable (so a CDN like Cloudflare will actually cache it);
// code/markup stays no-cache so updates are picked up immediately.
const CACHEABLE = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.glb', '.gltf', '.png', '.jpg', '.svg', '.ico']);
const cacheFor = (ext) => (CACHEABLE.has(ext) ? 'public, max-age=604800' : 'no-cache');

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = normalize(join(__dirname, urlPath));
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const ext = extname(filePath);
    const type = MIME[ext] || 'application/octet-stream';
    const cache = cacheFor(ext);
    const data = await readFile(filePath);

    // HTTP Range support (audio/video seeking + streaming)
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const total = data.length;
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = parseInt(s, 10) || 0;
      const end = e ? Math.min(parseInt(e, 10), total - 1) : total - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': cache,
      });
      res.end(data.subarray(start, end + 1));
      return;
    }

    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache });
    res.end(data);
  } catch (err) {
    res.writeHead(500).end('Server error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`);
});
