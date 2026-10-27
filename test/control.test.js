import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createCollector } from '../src/collect.js';
import { validateServices } from '../src/config.js';
import { createDemoCollector } from '../src/demo.js';
import { createApp } from '../src/server.js';

const services = validateServices([
  { id: 'web', label: '웹', scope: 'user', unit: 'web.service', actions: ['start', 'stop', 'restart'] },
  { id: 'db', label: '디비', scope: 'system', unit: 'db.service', actions: ['restart'] },
  { id: 'ro', label: '읽기전용', scope: 'user', unit: 'ro.service' },
]);

// ---- 설정 검증 ----------------------------------------------------------------

test('config: actions 는 허용 목록 안에서만, 기본은 읽기 전용([])', () => {
  assert.deepEqual(services.find((s) => s.id === 'ro').actions, []);
  const ok = { id: 'a', scope: 'user', unit: 'a.service' };
  assert.deepEqual(validateServices([{ ...ok, actions: ['restart', 'restart'] }])[0].actions, ['restart']); // 중복 제거
  assert.throws(() => validateServices([{ ...ok, actions: ['reboot'] }]), /actions/);
  assert.throws(() => validateServices([{ ...ok, actions: 'restart' }]), /actions/);
});

// ---- 수집기의 제어 동작 -----------------------------------------------------------

const collectorWith = (exec) => createCollector({ services, disks: ['/'] }, { exec });

test('control: user 유닛은 systemctl --user 로 실행', async () => {
  const calls = [];
  const c = collectorWith(async (cmd, args) => { calls.push([cmd, args]); return { stdout: '' }; });
  const r = await c.control('web', 'restart');
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [['systemctl', ['--user', 'restart', 'web.service']]]);
});

test('control: system 유닛은 sudo -n 과 절대 경로로 실행(sudoers 규칙과 일치)', async () => {
  const calls = [];
  const c = collectorWith(async (cmd, args) => { calls.push([cmd, args]); return { stdout: '' }; });
  await c.control('db', 'restart');
  assert.deepEqual(calls, [['sudo', ['-n', '/usr/bin/systemctl', 'restart', 'db.service']]]);
});

test('control: 허용되지 않은 동작/서비스는 실행하지 않는다', async () => {
  const calls = [];
  const c = collectorWith(async (...a) => { calls.push(a); return { stdout: '' }; });
  assert.equal((await c.control('db', 'stop')).status, 403);    // db 는 restart 만 허용
  assert.equal((await c.control('ro', 'restart')).status, 403); // 읽기 전용
  assert.equal((await c.control('nope', 'restart')).status, 404);
  assert.equal((await c.control('web', 'reboot')).status, 403); // 허용 목록 밖의 동작
  assert.equal(calls.length, 0);
});

test('control: sudo 권한이 없으면 안내 문구, 그 외 실패는 사유를 담는다', async () => {
  const noPerm = collectorWith(async () => { throw Object.assign(new Error('x'), { stderr: 'sudo: a password is required\n' }); });
  const r1 = await noPerm.control('db', 'restart');
  assert.equal(r1.ok, false);
  assert.match(r1.message, /sudoers/);
  const failed = collectorWith(async () => { throw Object.assign(new Error('x'), { stderr: 'Unit web.service not found.\n' }); });
  const r2 = await failed.control('web', 'start');
  assert.match(r2.message, /not found/);
});

// ---- HTTP 레벨 (데모 수집기로) ---------------------------------------------------

const config = {
  root: new URL('..', import.meta.url).pathname, host: '127.0.0.1', port: 0, demo: true,
  password: 'pw-for-tests-123', secret: 'y'.repeat(32), trustProxy: false, intervalMs: 60000, disks: ['/'], services,
};
let app; let base; let cookie;

before(async () => {
  app = createApp({ config, collector: createDemoCollector(config) });
  await app.tick();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: config.password }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { app.server.close(); });

const act = (body, headers = {}) => fetch(`${base}/api/action`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body),
});
const overview = async () => (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();

test('action: 로그인 없이는 401', async () => {
  const res = await fetch(`${base}/api/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'web', action: 'restart' }),
  });
  assert.equal(res.status, 401);
});

test('action: 다른 출처(Origin)에서 온 요청은 403 — CSRF 방어', async () => {
  const res = await act({ id: 'web', action: 'restart' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  // 같은 출처는 통과
  assert.equal((await act({ id: 'web', action: 'restart' }, { origin: base })).status, 200);
});

test('action: JSON 이 아니면 415, 형식이 틀리면 400', async () => {
  const text = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'content-type': 'text/plain', cookie }, body: 'id=web' });
  assert.equal(text.status, 415);
  assert.equal((await act({ id: 1, action: 'restart' })).status, 400);
});

test('action: 허용 목록 밖은 403/404, 허용된 동작은 상태가 바뀐다', async () => {
  assert.equal((await act({ id: 'ro', action: 'restart' })).status, 403);
  assert.equal((await act({ id: 'zzz', action: 'restart' })).status, 404);

  const stop = await act({ id: 'web', action: 'stop' });
  assert.equal(stop.status, 200);
  assert.equal((await overview()).services.find((s) => s.id === 'web').status, 'down'); // 즉시 다시 수집되어 반영

  assert.equal((await act({ id: 'web', action: 'start' })).status, 200);
  assert.equal((await overview()).services.find((s) => s.id === 'web').status, 'ok');
});

test('action: 같은 서비스에 동작이 겹치면 409', async () => {
  const [a, b] = await Promise.all([act({ id: 'web', action: 'restart' }), act({ id: 'web', action: 'restart' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

// ---- 자기 자신(self) 재시작 -----------------------------------------------------------

test('config: self 서비스는 restart 만 허용할 수 있다', () => {
  const me = { id: 'me', scope: 'user', unit: 'me.service', self: true };
  assert.equal(validateServices([{ ...me, actions: ['restart'] }])[0].self, true);
  assert.throws(() => validateServices([{ ...me, actions: ['stop'] }]), /self/);
  assert.throws(() => validateServices([{ ...me, actions: ['start', 'restart'] }]), /self/);
  assert.equal(validateServices([{ id: 'x', scope: 'user', unit: 'x.service' }])[0].self, false);
});

test('control: self 재시작은 응답을 먼저 돌려주고, 잠시 뒤 --no-block 으로 실행', async () => {
  const me = validateServices([{ id: 'me', scope: 'user', unit: 'me.service', self: true, actions: ['restart'] }]);
  const calls = [];
  const c = createCollector({ services: me, disks: ['/'] }, { exec: async (cmd, args) => { calls.push([cmd, args]); return { stdout: '' }; } });
  const r = await c.control('me', 'restart');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0); // 응답 시점에는 아직 실행하지 않았다
  await new Promise((res) => setTimeout(res, 1000));
  assert.deepEqual(calls, [['systemctl', ['--user', '--no-block', 'restart', 'me.service']]]);
});
