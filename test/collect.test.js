import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuPercent, judge, num, parseDf, parseMeminfo, parseShow, parseUnixTs, systemctlShow } from '../src/collect.js';

const SHOW = `Id=mytree.service
LoadState=loaded
ActiveState=active
SubState=running
MainPID=1393033
MemoryCurrent=68157440
CPUUsageNSec=680000000
NRestarts=0
Result=success
ActiveEnterTimestamp=@1761533051

Id=ghost.service
LoadState=not-found
ActiveState=inactive
SubState=dead
MainPID=0
MemoryCurrent=[not set]
CPUUsageNSec=[not set]
NRestarts=0
Result=success
ActiveEnterTimestamp=
`;

test('parseShow 가 유닛별 블록을 나눈다', () => {
  const [a, b] = parseShow(SHOW);
  assert.equal(a.Id, 'mytree.service');
  assert.equal(a.MemoryCurrent, '68157440');
  assert.equal(b.LoadState, 'not-found');
});

test('num: 미지원 값/uint64 최대값은 null', () => {
  assert.equal(num('68157440'), 68157440);
  assert.equal(num('[not set]'), null);
  assert.equal(num('18446744073709551615'), null);
  assert.equal(num(undefined), null);
});

test('parseUnixTs', () => {
  assert.equal(parseUnixTs('@1761533051'), 1761533051);
  assert.equal(parseUnixTs(''), null);
});

test('parseMeminfo / parseDf', () => {
  const m = parseMeminfo('MemTotal:       13000000 kB\nMemAvailable:    9000000 kB\nSwapTotal: 4096 kB\nSwapFree: 4096 kB\n');
  assert.equal(m.total, 13000000 * 1024);
  assert.equal(m.available, 9000000 * 1024);
  const d = parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda2 1000 400 600 40% /\n/dev/sda3 2000 100 1900 5% /home\n');
  assert.deepEqual(d.map((x) => [x.mount, x.used]), [['/', 400 * 1024], ['/home', 100 * 1024]]);
});

test('cpuPercent', () => {
  assert.equal(Math.round(cpuPercent({ idle: 0, total: 0 }, { idle: 75, total: 100 })), 25);
  assert.equal(cpuPercent({ idle: 5, total: 5 }, { idle: 5, total: 5 }), 0);
});

test('judge: 상태 판정', () => {
  const base = { load: 'loaded', active: 'active', checks: { tcp: null, http: null } };
  assert.equal(judge(base), 'ok');
  assert.equal(judge({ ...base, load: 'not-found' }), 'unknown');
  assert.equal(judge({ ...base, active: 'failed' }), 'down');
  assert.equal(judge({ ...base, active: 'activating' }), 'warn');
  assert.equal(judge({ ...base, checks: { tcp: false, http: null } }), 'warn');
  assert.equal(judge({ ...base, checks: { tcp: true, http: { status: 404, ms: 3 } } }), 'ok'); // 404/401 은 앱이 응답한다는 뜻
  assert.equal(judge({ ...base, checks: { tcp: true, http: { status: 502, ms: 3 } } }), 'warn');
  assert.equal(judge({ ...base, checks: { tcp: true, http: { status: 0, ms: 2000 } } }), 'warn');
});

test('systemctlShow: --user 옵션과 폴백', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (args.includes('--timestamp=unix')) throw new Error('unknown option');
    return { stdout: SHOW };
  };
  const m = await systemctlShow('user', ['mytree.service', 'ghost.service'], exec);
  assert.equal(calls.length, 2); // 1차 실패 → 시각 없이 재시도
  assert.ok(calls[0][1].includes('--user'));
  assert.equal(m.get('mytree.service').ActiveState, 'active');
  assert.equal(m.get('ghost.service').LoadState, 'not-found');
  const sys = [];
  await systemctlShow('system', ['nginx.service'], async (c, a) => { sys.push(a); return { stdout: '' }; });
  assert.ok(!sys[0].includes('--user'));
});
