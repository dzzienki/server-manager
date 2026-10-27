import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDemoCollector } from '../src/demo.js';
import { createApp } from '../src/server.js';
import { validateServices } from '../src/config.js';

const services = validateServices([
  { id: 'web', scope: 'user', unit: 'web.service', port: 3000, http: '/' },
  { id: 'db', scope: 'system', unit: 'db.service' },
]);
const config = {
  root: new URL('..', import.meta.url).pathname, host: '127.0.0.1', port: 0, demo: true,
  password: 'pw-for-tests-123', secret: 'x'.repeat(32), trustProxy: false, intervalMs: 60000, disks: ['/'], services,
};
let app; let base;

before(async () => {
  app = createApp({ config, collector: createDemoCollector(config) });
  await app.tick();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); });

const login = async (password) => fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
});

test('로그인 없이는 API 가 401', async () => {
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  assert.equal((await fetch(`${base}/api/logs?id=web`)).status, 401);
});

test('틀린 비밀번호는 401, 맞으면 쿠키 발급 후 overview/logs 조회', async () => {
  assert.equal((await login('nope')).status, 401);
  const ok = await login(config.password);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const headers = { cookie: cookie.split(';')[0] };
  const ov = await (await fetch(`${base}/api/overview`, { headers })).json();
  assert.equal(ov.services.length, 2);
  assert.ok(ov.history.t.length >= 1);
  assert.ok('cpu' in ov.system);

  const logs = await (await fetch(`${base}/api/logs?id=web`, { headers })).json();
  assert.ok(logs.lines.length > 0);
  assert.equal((await fetch(`${base}/api/logs?id=../../etc/passwd`, { headers })).status, 404);
});

test('정적 파일에 보안 헤더가 붙고, 허용 목록 밖 경로는 404', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/services.json`)).status, 404);
});

test('로그인 5회 실패하면 429', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await login('wrong');
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
  // 잠긴 동안에는 올바른 비밀번호도 거부
  assert.equal((await login(config.password)).status, 429);
});
