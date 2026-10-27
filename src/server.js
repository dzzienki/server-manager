import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeAuth, makeLimiter } from './auth.js';
import { createHistory } from './history.js';

const COOKIE = 'sm_session';
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJson(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function createApp({ config, collector }) {
  const auth = makeAuth({ password: config.password, secret: config.secret });
  const limiter = makeLimiter();
  const history = createHistory(config.services.map((s) => s.id));
  const publicDir = path.join(config.root, 'public');
  let latest = null;
  let timer = null;

  async function tick() {
    try {
      latest = await collector.sample();
      history.add(latest);
    } catch (err) {
      console.error('샘플 수집 실패:', err.message);
    }
  }

  const send = (res, status, body, headers = {}) => {
    const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...(isObj ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    });
    res.end(isObj ? JSON.stringify(body) : body);
  };

  const clientIp = (req) => (config.trustProxy
    ? (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress
    : req.socket.remoteAddress);

  const isHttps = (req) => config.trustProxy && req.headers['x-forwarded-proto'] === 'https';
  const sessionCookie = (req, value, maxAgeSec) => [
    `${COOKIE}=${encodeURIComponent(value)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`,
    ...(isHttps(req) ? ['Secure'] : []),
  ].join('; ');

  const authed = (req) => auth.verify(parseCookies(req.headers.cookie)[COOKIE]);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(publicDir, file)), { 'content-type': type });
    }

    if (route === 'POST /api/login') {
      const ip = clientIp(req);
      const wait = limiter.blockedFor(ip);
      if (wait) return send(res, 429, { error: `시도가 너무 많습니다. ${wait}초 후 다시 시도하세요` }, { 'retry-after': String(wait) });
      let body;
      try { body = await readJson(req); } catch { return send(res, 400, { error: '잘못된 요청' }); }
      if (typeof body.password !== 'string' || !auth.checkPassword(body.password)) {
        limiter.fail(ip);
        return send(res, 401, { error: '비밀번호가 맞지 않습니다' });
      }
      limiter.reset(ip);
      return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, auth.issue(), Math.floor(auth.ttlMs / 1000)) });
    }

    if (route === 'POST /api/logout') {
      return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: '로그인이 필요합니다' });

      if (route === 'GET /api/overview') {
        if (!latest) return send(res, 503, { error: '수집 중입니다' });
        return send(res, 200, {
          host: os.hostname(), demo: config.demo, intervalMs: config.intervalMs,
          ts: latest.ts, system: latest.system, services: latest.services, history: history.toJSON(),
        });
      }

      if (route === 'GET /api/logs') {
        const result = await collector.readLog(url.searchParams.get('id'), url.searchParams.get('n'));
        if (!result) return send(res, 404, { error: '알 수 없는 서비스' });
        return send(res, 200, result);
      }
    }

    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('요청 처리 오류:', err);
      if (!res.headersSent) send(res, 500, { error: '서버 오류' }); else res.end();
    });
  });

  return {
    server,
    tick,
    startSampling() {
      const loop = async () => { await tick(); timer = setTimeout(loop, config.intervalMs); timer.unref?.(); };
      return loop();
    },
    stop() { clearTimeout(timer); server.close(); },
  };
}
