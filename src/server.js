// HTTP 서버: 정적 화면 제공 + 로그인/조회 API.
//   POST /api/login, /api/logout   세션 쿠키 발급·삭제 (로그인 필요 없음)
//   GET  /api/overview             최신 샘플 + 최근 이력 (로그인 필요)
//   GET  /api/logs?id=&n=          서비스 로그 (로그인 필요)
// 수집은 요청과 무관하게 주기적으로 돌며 결과를 캐시해 두고, API 는 캐시만 돌려준다
// → 접속자가 많아도 systemctl 호출 횟수는 늘지 않는다.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { makeAuth, makeLimiter } from './auth.js';
import { createHistory } from './history.js';

const COOKIE = 'sm_session';

// 제공할 정적 파일 허용 목록(요청 경로 → [public/ 안의 파일, Content-Type]).
// 경로를 파일 시스템에 그대로 붙이지 않고 이 표로만 찾으므로 "../" 같은 경로 조작이 통하지 않는다.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
// 모든 응답에 붙는 보안 헤더.
//   CSP        같은 출처의 스크립트/스타일만 허용(주입된 스크립트 차단), iframe 삽입 금지(frame-ancestors)
//   nosniff    브라우저가 Content-Type 을 멋대로 추측하지 못하게 함
//   no-referrer / no-store   주소 유출 방지, 로그·상태 데이터가 캐시에 남지 않게 함
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

// "a=1; b=2" 형태의 Cookie 헤더를 객체로 파싱
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 요청 본문을 JSON 으로 읽는다. limit(바이트)을 넘으면 연결을 끊는다(로그인 본문은 작아서 1KB 면 충분).
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

// 앱을 만든다. 반환: { server, tick, startSampling, stop }
//   tick()          샘플 1회 수집(테스트에서 직접 호출)
//   startSampling() intervalMs 주기로 계속 수집
export function createApp({ config, collector }) {
  const auth = makeAuth({ password: config.password, secret: config.secret });
  const limiter = makeLimiter();
  const history = createHistory(config.services.map((s) => s.id));
  const publicDir = path.join(config.root, 'public');
  let latest = null; // 가장 최근 샘플(API 가 이것만 돌려준다)
  let timer = null;
  const busy = new Set(); // 제어 동작이 진행 중인 서비스 id (같은 서비스에 동작이 겹치지 않게 막는다)

  // 샘플 1회 수집. 실패해도 서버가 죽지 않고 이전 값을 유지한다.
  async function tick() {
    try {
      latest = await collector.sample();
      history.add(latest);
    } catch (err) {
      console.error('샘플 수집 실패:', err.message);
    }
  }

  // 응답 보내기. body 가 객체면 JSON 으로, 아니면 그대로(파일 내용 등). 보안 헤더는 항상 붙는다.
  const send = (res, status, body, headers = {}) => {
    const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...(isObj ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    });
    res.end(isObj ? JSON.stringify(body) : body);
  };

  // 로그인 잠금에 쓰는 접속자 IP. 프록시를 신뢰하는 설정(trustProxy)일 때만 X-Forwarded-For 를 본다.
  // (직접 노출 상태에서 이 헤더를 믿으면 접속자가 IP 를 위조해 잠금을 피할 수 있다.
  //  nginx 는 이 헤더를 $remote_addr 로 "덮어써서" 넘기도록 설정해야 한다.)
  const clientIp = (req) => (config.trustProxy
    ? (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress
    : req.socket.remoteAddress);

  // 세션 쿠키: HttpOnly(스크립트에서 못 읽음), SameSite=Strict(다른 사이트가 보낸 요청에는 안 실림),
  // HTTPS 로 들어온 요청이면 Secure(평문 전송 금지). maxAgeSec=0 이면 삭제.
  const isHttps = (req) => config.trustProxy && req.headers['x-forwarded-proto'] === 'https';
  const sessionCookie = (req, value, maxAgeSec) => [
    `${COOKIE}=${encodeURIComponent(value)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`,
    ...(isHttps(req) ? ['Secure'] : []),
  ].join('; ');

  // 쿠키의 서명·만료를 검증해 로그인된 요청인지 판단
  const authed = (req) => auth.verify(parseCookies(req.headers.cookie)[COOKIE]);

  // CSRF 방어(쿠키의 SameSite=Strict 에 더한 두 번째 방어선): 브라우저가 Origin 을 보냈다면
  // 이 서버의 Host 와 같아야 한다. 다른 사이트의 스크립트가 쿠키를 실어 보내는 요청을 거절한다.
  // (nginx 는 Host 를 $host 로 넘기도록 설정되어 있어야 한다)
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // 같은 출처의 일부 요청은 Origin 이 없다
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  };

  // 요청 라우팅. 순서: 정적 파일 → 로그인/로그아웃(인증 불필요) → 나머지 /api/*(인증 필수) → 404
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(publicDir, file)), { 'content-type': type });
    }

    // 로그인: 잠긴 IP 는 비밀번호 확인 전에 429 로 거절(맞는 비밀번호도 잠금 동안은 거부),
    // 틀리면 실패 횟수 기록, 맞으면 기록을 지우고 서명된 세션 쿠키 발급
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

    // 여기부터의 모든 API 는 로그인 필수. 새 API 를 추가하면 자동으로 이 보호를 받는다.
    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: '로그인이 필요합니다' });

      // 화면이 주기적으로 부르는 API: 최신 스냅샷 + 차트용 이력(컬럼 배열). 첫 수집 전이면 503.
      if (route === 'GET /api/overview') {
        if (!latest) return send(res, 503, { error: '수집 중입니다' });
        return send(res, 200, {
          host: os.hostname(), demo: config.demo, intervalMs: config.intervalMs,
          ts: latest.ts, system: latest.system, services: latest.services, history: history.toJSON(),
        });
      }

      // 서비스 제어: body { id, action }. 검사 순서 — 출처(CSRF) → JSON 형식 → 동작 중복 → 허용 목록(수집기) → 실행.
      // 허용 여부는 services.json 의 actions 가 결정하고, 모든 시도를 접속자 IP 와 함께 로그(journal)에 남긴다.
      if (route === 'POST /api/action') {
        if (!sameOrigin(req)) return send(res, 403, { error: '허용되지 않은 요청 출처입니다' });
        if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'JSON 요청이 필요합니다' });
        let body;
        try { body = await readJson(req); } catch { return send(res, 400, { error: '잘못된 요청' }); }
        const { id, action } = body;
        if (typeof id !== 'string' || typeof action !== 'string') return send(res, 400, { error: 'id 와 action 이 필요합니다' });
        if (busy.has(id)) return send(res, 409, { error: '이 서비스는 이미 처리 중입니다' });

        busy.add(id);
        try {
          const result = await collector.control(id, action);
          console.log(`[action] ip=${clientIp(req)} service=${id} action=${action} -> ${result.ok ? 'ok' : `FAIL(${result.message})`}`);
          if (!result.ok) return send(res, result.status ?? 500, { error: result.message });
          await tick(); // 바뀐 상태가 화면에 바로 보이도록 즉시 다시 수집
          return send(res, 200, { ok: true, message: result.message });
        } finally {
          busy.delete(id);
        }
      }

      if (route === 'GET /api/logs') {
        const result = await collector.readLog(url.searchParams.get('id'), url.searchParams.get('n'));
        if (!result) return send(res, 404, { error: '알 수 없는 서비스' });
        return send(res, 200, result);
      }
    }

    return send(res, 404, { error: 'not found' });
  }

  // 처리 중 예외가 나도 프로세스가 죽지 않게 여기서 500 으로 변환한다.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('요청 처리 오류:', err);
      if (!res.headersSent) send(res, 500, { error: '서버 오류' }); else res.end();
    });
  });

  return {
    server,
    tick,
    // setInterval 대신 "끝난 뒤 다음 예약"으로 돌려, 수집이 느려져도 샘플이 겹쳐 쌓이지 않는다.
    // unref: 이 타이머만 남았을 때 프로세스 종료를 막지 않음(테스트가 끝나도록).
    startSampling() {
      const loop = async () => { await tick(); timer = setTimeout(loop, config.intervalMs); timer.unref?.(); };
      return loop();
    },
    stop() { clearTimeout(timer); server.close(); },
  };
}
