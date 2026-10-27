import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// 유닛 이름은 execFile 인자로 들어가므로 '-' 로 시작(옵션 주입)하거나 특수문자를 가진 값은 거부한다.
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]*$/;

const expandHome = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

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
    return {
      id: s.id,
      label: s.label ?? s.id,
      scope: s.scope,
      unit: s.unit,
      port: s.port ?? null,
      http: s.http ?? null,
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
    demo: env.SM_DEMO === '1',
    password: env.SM_PASSWORD || '',
    secret: env.SM_SECRET || crypto.randomBytes(32).toString('hex'),
    trustProxy: env.SM_TRUST_PROXY === '1',
    intervalMs: Math.max(2000, Number(env.SM_INTERVAL_MS || 10000)),
    disks: (env.SM_DISKS || '/').split(',').map((d) => d.trim()).filter(Boolean),
    services,
  };
}
