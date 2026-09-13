/**
 * Web UI for the Promotion Management API.
 *
 *   npm run ui        then open http://localhost:5173
 *
 * Serves the static page and proxies /api/* to the API (API_URL, default
 * http://localhost:3000), so the page is same-origin and the API needs no
 * CORS. Everything the page shows and changes goes through the API.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';

const here = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const UI_PORT = Number(process.env.UI_PORT ?? 5173);
const API_URL = new URL(process.env.API_URL ?? 'http://localhost:3000');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function proxy(req, res, url) {
  const target = new URL(url.pathname.slice('/api'.length) + url.search, API_URL);
  const upstream = http.request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    send(
      res,
      502,
      JSON.stringify({ error: { code: 'API_UNREACHABLE', message: `API is not reachable at ${API_URL.origin}` } }),
      'application/json',
    );
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://ui.local');
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url);

  const file = STATIC[url.pathname];
  if (file && req.method === 'GET') return send(res, 200, await readFile(path.join(here, file[0])), file[1]);

  send(res, 404, 'Not found', 'text/plain');
});

server.listen(UI_PORT, () => {
  logger.info({ url: `http://localhost:${UI_PORT}`, api: API_URL.origin }, 'ui server listening');
});
