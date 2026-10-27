// 설정: 환경변수(SM_*, .env 참고)와 services.json(관리할 서비스 목록)을 읽어 검증한다.
// 잘못된 설정은 여기서 시작 전에 예외로 막는다 — 이후 코드는 검증된 값만 받는다고 가정한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 프로젝트 루트(public/, services.json 위치 기준)
const ROOT = path.resolve(import.meta.dirname, '..');
// 화면에서 실행할 수 있는 제어 동작(허용 목록). 서비스마다 이 중 일부만 services.json 의 actions 로 열어준다.
export const ACTIONS = ['start', 'stop', 'restart'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// 유닛 이름은 execFile 인자로 들어가므로 '-' 로 시작(옵션 주입)하거나 특수문자를 가진 값은 거부한다.
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]*$/;

// logFile 에 "~/..." 로 적은 경로를 실행 계정의 홈으로 풀어준다
const expandHome = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

// services.json 의 각 항목을 검증하고 기본값을 채워 정규화한다.
//   id: 화면/API 식별자 · scope: user(systemctl --user)|system · unit: systemd 유닛 이름
//   port: 있으면 TCP 점검 · http: 있으면 그 경로로 GET 점검(port 필요) · logFile: 있으면 journal 대신 파일 tail
//   actions: 화면에서 허용할 제어 동작(start/stop/restart 중). 없으면 읽기 전용
export function validateServices(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('services 는 비어 있지 않은 배열이어야 합니다');
  const seen = new Set();
  return list.map((s, i) => {
    const at = `services[${i}]`;
    if (!ID_RE.test(s?.id ?? '')) throw new Error(`${at}.id 형식 오류 (소문자/숫자/-)`);
    if (seen.has(s.id)) throw new Error(`${at}.id 중복: ${s.id}`);
    seen.add(s.id);
    if (s.scope !== 'user' && s.scope !== 'system') throw new Error(`${at}.scope 는 user|system`);
    if (!UNIT_RE.test(s.unit ?? '')) throw new Error(`${at}.unit 형식 오류`);
    if (s.port != null && !(Number.isInteger(s.port) && s.port > 0 && s.port < 65536)) throw new Error(`${at}.port 오류`);
    if (s.http != null && !(typeof s.http === 'string' && s.http.startsWith('/') && s.port != null)) {
      throw new Error(`${at}.http 는 '/' 로 시작해야 하고 port 가 필요합니다`);
    }
    if (s.actions != null && !(Array.isArray(s.actions) && s.actions.every((a) => ACTIONS.includes(a)))) {
      throw new Error(`${at}.actions 는 ${ACTIONS.join('|')} 중에서 고른 배열이어야 합니다`);
    }
    return {
      id: s.id,
      label: s.label ?? s.id,
      scope: s.scope,
      unit: s.unit,
      port: s.port ?? null,
      http: s.http ?? null,
      // 허용할 제어 동작. 지정하지 않으면 빈 배열 = 읽기 전용(안전한 기본값).
      actions: [...new Set(s.actions ?? [])],
      logFile: s.logFile ? expandHome(String(s.logFile)) : null,
    };
  });
}

export function loadConfig(env = process.env) {
  const servicesPath = env.SM_SERVICES || path.join(ROOT, 'services.json');
  const services = validateServices(JSON.parse(fs.readFileSync(servicesPath, 'utf8')));
  return {
    root: ROOT,
    host: env.SM_HOST || '127.0.0.1',
    port: Number(env.SM_PORT || 3200),
    demo: env.SM_DEMO === '1', // 가짜 데이터로 UI 확인(맥 개발용)
    password: env.SM_PASSWORD || '',
    // 세션 쿠키 서명 키. 지정하지 않으면 시작할 때마다 새로 만들어 재시작 시 모두 로그아웃된다.
    secret: env.SM_SECRET || crypto.randomBytes(32).toString('hex'),
    // nginx 뒤에서만 1: X-Forwarded-For/Proto 를 믿는다. 직접 노출 상태에서 켜면 IP 위조가 가능하므로 금지.
    trustProxy: env.SM_TRUST_PROXY === '1',
    intervalMs: Math.max(2000, Number(env.SM_INTERVAL_MS || 10000)), // 너무 짧게 잡아 systemctl 을 과하게 부르지 않도록 하한 2초
    // HTTPS 인증서 만료일을 볼 도메인(nginx 가 같은 서버 443 에서 서비스하는 이름). 비우면 점검 안 함.
    tlsHost: env.SM_TLS_HOST || '',
    disks: (env.SM_DISKS || '/').split(',').map((d) => d.trim()).filter(Boolean),
    services,
  };
}
