// 今日のニュース — 依存パッケージなしの小さなサーバー
// NHK / Yahoo!ニュースのRSSを取得してJSONで返し、public/ の画面を配信する。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CATEGORIES, fetchCategory, pickBrief } = require('./lib/news');

const PORT = Number(process.env.PORT) || 3000;
const CACHE_MS = 10 * 60 * 1000; // 10分キャッシュ

const cache = new Map();

async function getCategory(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await fetchCategory(key);
  if (key === 'top') data.brief = pickBrief(data.items);
  cache.set(key, { at: Date.now(), data });
  return data;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // GitHub Pages 版 (scripts/build.js) と同じ data/*.json の形で返す
  if (url.pathname === '/data/categories.json') {
    return sendJson(res, 200, Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label })));
  }

  const m = url.pathname.match(/^\/data\/([a-z]+)\.json$/);
  if (m) {
    const key = m[1];
    if (!CATEGORIES[key]) return sendJson(res, 404, { error: 'unknown category' });
    try {
      return sendJson(res, 200, await getCategory(key));
    } catch (e) {
      const stale = cache.get(key);
      if (stale) return sendJson(res, 200, { ...stale.data, stale: true });
      return sendJson(res, 502, { error: 'ニュースを取得できませんでした' });
    }
  }

  const publicDir = path.join(__dirname, 'public');
  const file = path.normalize(path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`今日のニュース: http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`スマホから (同じWi-Fi): http://${a.address}:${PORT}`);
    }
  }
});
