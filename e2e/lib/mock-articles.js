'use strict';

const http = require('node:http');
const zlib = require('node:zlib');

/* ------------------------------------------------------------------ */
/* Tiny PNG encoder so the image bed serves a real, visible picture.   */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
};

const png = (width, height, pixel) => {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixel(x, y);
      const offset = rowStart + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const GRADIENT_PNG = png(240, 140, (x, y) => {
  const r = Math.round(70 + (x / 240) * 150);
  const g = Math.round(90 + (y / 140) * 110);
  const b = Math.round(200 - (x / 240) * 90);
  return [r, g, b, 255];
});

/* ------------------------------------------------------------------ */
/* Mock article API (shape: root-level {edges,pageInfo}).   */
/* ------------------------------------------------------------------ */

const article = (id, title, content, updatedAt) => ({
  id,
  title,
  url: `https://example.test/articles/${id}`,
  originalArticleUrl: `https://example.test/articles/${id}`,
  slug: id,
  author: 'E2E 测试作者',
  savedAt: updatedAt,
  updatedAt,
  publishedAt: updatedAt,
  archivedAt: null,
  readAt: null,
  pageType: 'ARTICLE',
  contentReader: 'WEB',
  description: `${title}（E2E mock 数据）`,
  image: null,
  wordsCount: content.length,
  readingProgressPercent: 0,
  isArchived: false,
  siteName: 'E2E 测试站点',
  content,
  highlights: [],
  labels: [{ name: 'E2E' }],
});

const baseArticles = (imageBase) => [
  article(
    'mock-e2e-0001',
    'E2E 同步：图片本地化',
    [
      '## 图片本地化',
      '',
      '这张图片来自允许跨域的图床，同步后应当变成 EdgeEver 内部资源。',
      '',
      `![可下载的图片](${imageBase}/img/ok.png)`,
      '',
      '图片下面的正文必须完整保留。',
    ].join('\n'),
    '2026-10-28T02:00:00.000Z',
  ),
  article(
    'mock-e2e-0002',
    'E2E 同步：图床不可用',
    [
      '## 无法本地化的图片',
      '',
      '下面第一张图不回跨域头，第二张图返回 404；两张都只能保留远程链接。',
      '',
      `![没有跨域头](${imageBase}/img/no-cors.png)`,
      '',
      `![图片不存在](${imageBase}/img/missing.png)`,
      '',
      '正文不受图片失败影响。',
    ].join('\n'),
    '2026-10-28T02:01:00.000Z',
  ),
  article(
    'mock-e2e-0003',
    'E2E 同步：分页文章',
    [
      '## 第二页',
      '',
      '这篇文章在 `after=2` 的第二页里，用来验证分页循环。',
    ].join('\n'),
    '2026-10-28T02:02:00.000Z',
  ),
];

const incrementalArticle = (imageBase) => [
  article(
    'mock-e2e-0004',
    'E2E 增量：新文章',
    [
      '## 增量拉取',
      '',
      `带 \`scenario:incremental\` 的查询只返回这一篇。![增量图片](${imageBase}/img/ok.png)`,
    ].join('\n'),
    '2026-10-28T03:00:00.000Z',
  ),
];

/**
 * @returns {Promise<{endpoint:string,imageBase:string,requests:Array<object>,close:()=>Promise<void>,articles:()=>Array<object>}>}
 */
const startMockArticles = () => new Promise((resolve, reject) => {
  let imageBase = '';
  let scenario = 'batch';
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-api-key, authorization',
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }

    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/__requests') {
      response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify(requests));
      return;
    }

    if (url.pathname.startsWith('/img/')) {
      if (url.pathname === '/img/ok.png') {
        response.writeHead(200, {
          'content-type': 'image/png',
          'content-length': GRADIENT_PNG.length,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        });
        response.end(GRADIENT_PNG);
        return;
      }
      if (url.pathname === '/img/no-cors.png') {
        // Deliberately no access-control-allow-origin: the browser must reject it,
        // and the host's public relay rejects http://localhost as non-public.
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': GRADIENT_PNG.length });
        response.end(GRADIENT_PNG);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/api/graphql') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunkText) => { raw += chunkText; });
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      const variables = body.variables || {};
      const queryText = String(variables.query || '');
      // `updated:` keeps returning the same batch so the dedupe case (second
      // run must not create new notes) stays deterministic; the incremental
      // shape is opt-in through a `scenario:incremental` token.
      const incremental = scenario === 'incremental' || /scenario:incremental/.test(queryText);
      const all = incremental ? incrementalArticle(imageBase) : baseArticles(imageBase);
      const after = Math.max(0, Number(variables.after) || 0);
      // Page at 2 regardless of the requested size so every client exercises
      // the pagination loop, not just clients that happen to ask for 2.
      const requestedFirst = Math.max(1, Number(variables.first) || 15);
      const first = Math.min(requestedFirst, 2);
      const page = all.slice(after, after + first);
      requests.push({
        method: 'POST',
        path: url.pathname,
        hasApiKey: Boolean(request.headers['x-api-key']),
        incremental,
        after,
        first,
        totalCount: all.length,
        receivedAt: new Date().toISOString(),
      });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({
        edges: page.map((node) => ({ node })),
        pageInfo: {
          hasNextPage: after + first < all.length,
          hasPreviousPage: after > 0,
          startCursor: String(after),
          endCursor: String(after + page.length),
          totalCount: all.length,
        },
      }));
    });
  });

  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    imageBase = `http://127.0.0.1:${port}`;
    resolve({
      endpoint: imageBase,
      imageBase,
      requests,
      setScenario: (next) => { scenario = next === 'incremental' ? 'incremental' : 'batch'; },
      articles: () => baseArticles(imageBase),
      incrementalArticles: () => incrementalArticle(imageBase),
      close: () => new Promise((done) => server.close(done)),
    });
  });
});

const MOCK_ROUTE_PATTERN = /^https:\/\/(?:relay-1\.bijitongbu\.site\/helper|relay-2\.bijitongbu\.site|graph\.bijitongbu\.site|obsidian\.notebooksyncer\.com)\/api\/graphql$/;

/**
 * Real plugins validate that a cached endpoint is one of the official hosts
 * (`isOfficialBase`), so a local mock URL can never be selected from storage.
 * Until the plugin exposes a dev endpoint, route the official GraphQL URLs at
 * the browser level and forward them to the mock, which keeps request logging
 * and response shaping in one place.
 */
const installMockArticleRoutes = async (context, mock) => {
  await context.route(MOCK_ROUTE_PATTERN, async (route, request) => {
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-api-key',
          'access-control-max-age': '600',
        },
        body: '',
      });
      return;
    }
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    // Force a small page size so the plugin's pagination loop is exercised
    // regardless of the page size it asks for.
    let postData = request.postData() || '';
    try {
      const parsed = JSON.parse(postData);
      parsed.variables = { ...(parsed.variables || {}), first: 2 };
      postData = JSON.stringify(parsed);
    } catch {
      // Forward malformed bodies untouched; the mock answers with 400.
    }
    const response = await route.fetch({
      url: `${mock.endpoint}/api/graphql`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(request.headers()['x-api-key'] ? { 'x-api-key': request.headers()['x-api-key'] } : {}),
      },
      postData,
    });
    await route.fulfill({
      status: response.status(),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
      body: await response.text(),
    });
  });
};

module.exports = { startMockArticles, installMockArticleRoutes, GRADIENT_PNG };
