import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// 단일 공유 비밀번호 + HMAC 서명 쿠키 세션. 토큰 = "<만료ms>.<서명>"
export function makeAuth({ password, secret, ttlMs = 12 * 3600e3, now = Date.now }) {
  const key = Buffer.from(secret);
  const mac = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
  const passHash = sha(password);
  return {
    ttlMs,
    // 해시끼리 상수 시간 비교 (길이 노출/타이밍 차이 방지)
    checkPassword: (input) => crypto.timingSafeEqual(sha(input), passHash),
    issue() {
      const exp = String(now() + ttlMs);
      return `${exp}.${mac(exp)}`;
    },
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
