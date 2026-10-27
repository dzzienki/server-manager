// 인증: 사용자 계정 없이 "공유 비밀번호 1개"만 쓰는 단순한 구조.
//   makeAuth    비밀번호 확인 + 서명된 세션 토큰 발급/검증 (서버에 세션 저장소가 필요 없다)
//   makeLimiter 로그인 무차별 대입 방지(IP 별 실패 횟수 제한)
import crypto from 'node:crypto';

// 비밀번호 비교용 SHA-256 (길이가 달라도 같은 크기로 만들어 timingSafeEqual 에 쓰기 위함)
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// 단일 공유 비밀번호 + HMAC 서명 쿠키 세션. 토큰 = "<만료ms>.<서명>"
export function makeAuth({ password, secret, ttlMs = 12 * 3600e3, now = Date.now }) {
  const key = Buffer.from(secret);
  // HMAC 서명: 키(secret)를 아는 서버만 만들 수 있어서, 만료 시각을 바꾸면 서명이 어긋나 거부된다.
  const mac = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
  const passHash = sha(password);
  return {
    ttlMs,
    // 해시끼리 상수 시간 비교 (길이 노출/타이밍 차이 방지)
    checkPassword: (input) => crypto.timingSafeEqual(sha(input), passHash),
    // 만료 시각(ms)과 그 서명을 "."로 이어 붙인 토큰을 만든다.
    issue() {
      const exp = String(now() + ttlMs);
      return `${exp}.${mac(exp)}`;
    },
    // 형식 → 서명 일치(상수 시간 비교) → 만료 여부 순으로 확인. 하나라도 어긋나면 false.
    verify(token) {
      if (typeof token !== 'string') return false;
      const [exp, sig] = token.split('.');
      if (!exp || !sig) return false;
      const good = mac(exp);
      if (sig.length !== good.length) return false;
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
      return Number(exp) > now();
    },
  };
}

// 로그인 실패 제한: windowMs 안에 max 번 틀리면 잠금
export function makeLimiter({ max = 5, windowMs = 10 * 60e3, now = Date.now } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  // 창(window)이 지난 기록은 지우고 돌려준다 → 시간이 지나면 잠금이 자동으로 풀린다.
  const live = (key) => {
    const h = hits.get(key);
    if (h && h.resetAt <= now()) { hits.delete(key); return null; }
    return h ?? null;
  };
  return {
    // 잠겨 있으면 남은 초, 아니면 0
    blockedFor(key) {
      const h = live(key);
      return h && h.count >= max ? Math.ceil((h.resetAt - now()) / 1000) : 0;
    },
    fail(key) {
      const h = live(key) ?? { count: 0, resetAt: now() + windowMs };
      h.count += 1;
      hits.set(key, h);
    },
    reset: (key) => hits.delete(key),
  };
}
