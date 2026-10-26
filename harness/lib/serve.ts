import { createServer, type Server } from 'node:http';
import { statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { shippedSource } from './strip.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wgsl': 'text/plain; charset=utf-8',
  '.css': 'text/css',
  '.png': 'image/png',
  '.bin': 'application/octet-stream',
};

// Static file server for the repository root. No caching, so every bench
// iteration pays the full load cost a first-time visitor would. A .ts file
// is sent as the JavaScript left after stripping its types.
export function serve(root: string, port = 0, host = '127.0.0.1'): Promise<Server> {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path);
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      const body = shippedSource(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
        // Cross-origin isolation: performance.now() gets 5 us resolution
        // instead of 100 us, which sub-millisecond frame times need.
        // Remote data must then be fetched with CORS.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
