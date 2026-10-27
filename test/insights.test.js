import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { certDaysLeft } from '../src/collect.js';
import { validateServices } from '../src/config.js';
import { createDemoCollector } from '../src/demo.js';
import { createEvents } from '../src/events.js';
import { createHistory } from '../src/history.js';
import { createApp } from '../src/server.js';

test('certDaysLeft: 남은 일수는 내림, 만료되면 음수', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(certDaysLeft(now + 10.9 * 86_400_000, now), 10);
  assert.equal(certDaysLeft(now - 3600_000, now), -1);
});

test('events: 최신이 앞, 용량을 넘으면 오래된 것부터 버린다', () => {
  const ev = createEvents(3);
  for (let i = 0; i < 5; i++) ev.add({ type: 'action', ok: true, ip: '1.1.1.1', text: `a${i}` });
  assert.deepEqual(ev.toJSON().map((e) => e.text), ['a4', 'a3', 'a2']);
});

test('events: 같은 IP 의 연속 로그인 실패는 한 줄로 합친다(제어 기록을 밀어내지 않게)', () => {
  const ev = createEvents(10);
  ev.add({ type: 'action', ok: true, ip: '1.1.1.1', text: '재시작 완료' });
  for (let i = 0; i < 4; i++) ev.add({ type: 'login', ok: false, ip: '9.9.9.9', text: '로그인 실패' });
  ev.add({ type: 'login', ok: false, ip: '8.8.8.8', text: '로그인 실패' }); // 다른 IP 는 따로
  const list = ev.toJSON();
  assert.equal(list.length, 3);
  assert.equal(list[1].count, 4);
  assert.equal(list[2].type, 'action');
});

test('history: HTTP 점검 응답 시간(ms)을 서비스별로 쌓고, 점검이 없으면 null', () => {
  const h = createHistory(['a', 'b'], 2);
  const mk = (ms) => ({
    ts: 1, system: { cpu: 1, mem: { total: 10, available: 5 } },
    services: [{ id: 'a', memory: 1, checks: { http: { status: 200, ms } } }, { id: 'b', memory: 1, checks: { http: null } }],
  });
  h.add(mk(10)); h.add(mk(20)); h.add(mk(30));
  assert.deepEqual(h.toJSON().svcMs, { a: [20, 30], b: [null, null] });
});

// ---- HTTP: 로그인/제어가 최근 기록에 남는다 -----------------------------------------

const services = validateServices([{ id: 'web', scope: 'user', unit: 'web.service', port: 3000, http: '/', actions: ['restart'] }]);
const config = {
  root: new URL('..', import.meta.url).pathname, host: '127.0.0.1', port: 0, demo: true,
  password: 'pw-for-tests-123', secret: 'z'.repeat(32), trustProxy: false, intervalMs: 60000, disks: ['/'], services,
};
let app; let base;
before(async () => {
  app = createApp({ config, collector: createDemoCollector(config) });
  await app.tick();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); });

test('overview.events: 로그인 실패/성공과 제어 결과가 IP 와 함께 기록된다', async () => {
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  assert.equal((await post('/api/login', { password: 'nope' })).status, 401);
  const ok = await post('/api/login', { password: config.password });
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/action', { id: 'web', action: 'restart' }, { cookie })).status, 200);
  assert.equal((await post('/api/action', { id: 'web', action: 'stop' }, { cookie })).status, 403); // 허용 안 된 동작도 기록

  const ov = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
  assert.deepEqual(ov.events.map((e) => [e.type, e.ok]), [['action', false], ['action', true], ['login', true], ['login', false]]);
  assert.ok(ov.events.every((e) => e.ip));
  assert.ok(ov.system.cert.validTo > Date.now()); // 데모 수집기의 인증서 정보
  assert.ok('svcMs' in ov.history);
});
