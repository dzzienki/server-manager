import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeAuth, makeLimiter } from '../src/auth.js';
import { validateServices } from '../src/config.js';

test('auth: 발급한 토큰은 검증되고, 변조/만료/쓰레기 값은 거부', () => {
  let t = 1_000_000;
  const auth = makeAuth({ password: 'correct horse', secret: 'k'.repeat(32), ttlMs: 1000, now: () => t });
  const token = auth.issue();
  assert.equal(auth.verify(token), true);
  const [exp, sig] = token.split('.');
  assert.equal(auth.verify(`${Number(exp) + 99999}.${sig}`), false); // 만료 시각 변조
  assert.equal(auth.verify(`${exp}.${sig.slice(0, -1)}x`), false);
  assert.equal(auth.verify('garbage'), false);
  assert.equal(auth.verify(undefined), false);
  t += 1001;
  assert.equal(auth.verify(token), false); // 만료
  const other = makeAuth({ password: 'x', secret: 'z'.repeat(32), now: () => t });
  assert.equal(other.verify(auth.issue()), false); // 다른 키로 서명
});

test('auth: 비밀번호 비교', () => {
  const auth = makeAuth({ password: 'correct horse', secret: 's'.repeat(32) });
  assert.equal(auth.checkPassword('correct horse'), true);
  assert.equal(auth.checkPassword('correct horse '), false);
  assert.equal(auth.checkPassword(''), false);
});

test('limiter: 5번 실패하면 잠기고, 시간이 지나면 풀린다', () => {
  let t = 0;
  const lim = makeLimiter({ max: 5, windowMs: 1000, now: () => t });
  for (let i = 0; i < 4; i++) lim.fail('ip');
  assert.equal(lim.blockedFor('ip'), 0);
  lim.fail('ip');
  assert.ok(lim.blockedFor('ip') > 0);
  assert.equal(lim.blockedFor('other'), 0);
  t += 1001;
  assert.equal(lim.blockedFor('ip'), 0);
});

test('config: 잘못된 서비스 정의는 거부 (옵션 주입 방지 포함)', () => {
  const ok = { id: 'a', scope: 'user', unit: 'a.service', port: 80, http: '/' };
  assert.equal(validateServices([ok])[0].label, 'a');
  assert.throws(() => validateServices([]));
  assert.throws(() => validateServices([{ ...ok, unit: '--all' }]), /unit/);
  assert.throws(() => validateServices([{ ...ok, unit: 'a b' }]), /unit/);
  assert.throws(() => validateServices([{ ...ok, scope: 'root' }]), /scope/);
  assert.throws(() => validateServices([{ ...ok, id: 'A_B' }]), /id/);
  assert.throws(() => validateServices([ok, ok]), /중복/);
  assert.throws(() => validateServices([{ ...ok, port: 70000 }]), /port/);
  assert.throws(() => validateServices([{ ...ok, port: undefined }]), /http/);
});
