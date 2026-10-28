'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the plugin package over plain HTTP with permissive CORS.
 * EdgeEver accepts `http:` manifest URLs (apps/web/src/lib/plugins/plugin-host.ts:649-654)
 * but reads manifest.json / main.js / styles.css with `window.fetch`, so the browser
 * still enforces CORS: every response must carry `access-control-allow-origin: *`.
 */
const resolvePluginPackage = ({ e2eDir, projectRoot, forceStub = false }) => {
  const built = path.join(projectRoot, 'plugin', 'dist');
  if (!forceStub && fs.existsSync(path.join(built, 'manifest.json'))) {
    return { dir: built, kind: 'dist' };
  }
  return { dir: path.join(e2eDir, 'fixtures', 'stub-plugin'), kind: 'stub' };
};

const startStaticServer = ({ rootDir }) => new Promise((resolve, reject) => {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405);
      response.end('method not allowed');
      return;
    }
    const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relative = requestPath === '/' ? '/manifest.json' : requestPath;
    const file = path.resolve(rootDir, `.${relative}`);
    if (!file.startsWith(path.resolve(rootDir) + path.sep)) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    fs.readFile(file, (error, bytes) => {
      if (error) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
        'content-length': bytes.length,
      });
      if (request.method === 'HEAD') response.end();
      else response.end(bytes);
    });
  });
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      origin: `http://127.0.0.1:${port}`,
      manifestUrl: `http://127.0.0.1:${port}/manifest.json`,
      dir: rootDir,
      close: () => new Promise((done) => server.close(done)),
    });
  });
});

module.exports = { startStaticServer, resolvePluginPackage };
