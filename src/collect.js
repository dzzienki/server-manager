import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PROPS = 'Id,LoadState,ActiveState,SubState,MainPID,MemoryCurrent,CPUUsageNSec,NRestarts,Result,ActiveEnterTimestamp';

// ---- 순수 함수(테스트 대상) -------------------------------------------------

// `systemctl show` 출력: 유닛마다 빈 줄로 구분된 key=value 블록
export function parseShow(text) {
  return text
    .split(/\n\n+/)
    .map((block) => Object.fromEntries(
      block.split('\n').filter((l) => l.includes('=')).map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    ))
    .filter((o) => o.Id);
}

// "[not set]", uint64 최대값(미지원) 등은 null
export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 2 ** 53 ? n : null;
}

// --timestamp=unix 형식: "@1761533051"
export function parseUnixTs(v) {
  const m = /^@(\d+)/.exec(v ?? '');
  return m ? Number(m[1]) : null;
}

export function parseMeminfo(text) {
  const m = {};
  for (const line of text.split('\n')) {
    const x = /^(\w+):\s+(\d+) kB/.exec(line);
    if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  return { total: m.MemTotal ?? 0, available: m.MemAvailable ?? 0, swapTotal: m.SwapTotal ?? 0, swapFree: m.SwapFree ?? 0 };
}

// df -Pk 출력의 첫 데이터 줄들
export function parseDf(text) {
  return text.trim().split('\n').slice(1).map((line) => {
    const c = line.trim().split(/\s+/);
    return { mount: c[5], total: Number(c[1]) * 1024, used: Number(c[2]) * 1024 };
  }).filter((d) => d.mount && d.total > 0);
}

export function cpuPercent(a, b) {
  const dt = b.total - a.total;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - (b.idle - a.idle) / dt)));
}

// 서비스 한 줄의 종합 상태: ok | warn | down | unknown
export function judge(svc) {
  if (svc.load === 'not-found') return 'unknown';
  if (svc.active === 'activating' || svc.active === 'reloading') return 'warn';
  if (svc.active !== 'active') return 'down';
  if (svc.checks.tcp === false) return 'warn';
  const h = svc.checks.http;
  // 401/403/404 도 앱이 응답한다는 뜻이므로 정상. 5xx 나 무응답(0)만 경고.
  if (h && (h.status === 0 || h.status >= 500)) return 'warn';
  return 'ok';
}

// ---- 외부 호출 ----------------------------------------------------------------

export async function systemctlShow(scope, units, exec = run) {
  const base = scope === 'user' ? ['--user'] : [];
  const args = (ts) => [...base, ...(ts ? ['--timestamp=unix'] : []), 'show', '-p', PROPS, ...units];
  let out;
  try {
    ({ stdout: out } = await exec('systemctl', args(true), { timeout: 5000 }));
  } catch {
    // 오래된 systemd 는 --timestamp=unix 를 모른다 → 시각 없이 재시도
    ({ stdout: out } = await exec('systemctl', args(false), { timeout: 5000 }));
  }
  return new Map(parseShow(out).map((o) => [o.Id, o]));
}

function tcpCheck(port, timeout = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function httpCheck(port, path, timeout = 2000) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', timeout, headers: { 'user-agent': 'server-manager', connection: 'close' } },
      (res) => { resolve({ status: res.statusCode, ms: ms() }); res.destroy(); }, // 본문은 받지 않는다
    );
    req.once('timeout', () => { req.destroy(); resolve({ status: 0, ms: timeout }); });
    req.once('error', () => resolve({ status: 0, ms: ms() }));
    req.end();
  });
}

async function tailFile(file, n, maxBytes = 256 * 1024) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // 잘린 첫 줄
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-n);
  } finally {
    await fh.close();
  }
}

// ---- 수집기 ---------------------------------------------------------------------

export function createCollector(config, { exec = run } = {}) {
  const readCpu = () => {
    let idle = 0; let total = 0;
    for (const c of os.cpus()) for (const [k, v] of Object.entries(c.times)) { total += v; if (k === 'idle') idle += v; }
    return { idle, total };
  };
  let prevCpu = readCpu();
  const prevSvc = new Map(); // id -> { ns, t }

  async function system() {
    const cur = readCpu();
    const cpu = cpuPercent(prevCpu, cur);
    prevCpu = cur;

    let mem;
    try {
      mem = parseMeminfo(await fs.readFile('/proc/meminfo', 'utf8'));
    } catch { // 리눅스가 아니면(개발용) os 값으로 대체
      mem = { total: os.totalmem(), available: os.freemem(), swapTotal: 0, swapFree: 0 };
    }
    let disks = [];
    try {
      const { stdout } = await exec('df', ['-Pk', ...config.disks], { timeout: 5000 });
      disks = parseDf(stdout);
    } catch { /* 일부 마운트가 없으면 df 가 실패 — 디스크 표시만 생략 */ }

    return { cpu, cores: os.cpus().length, load: os.loadavg(), uptime: os.uptime(), mem, disks };
  }

  async function services() {
    const now = Date.now();
    const byScope = { user: [], system: [] };
    for (const s of config.services) byScope[s.scope].push(s.unit);
    const shown = new Map();
    for (const scope of ['user', 'system']) {
      if (byScope[scope].length === 0) continue;
      try {
        for (const [id, o] of await systemctlShow(scope, byScope[scope], exec)) shown.set(`${scope}:${id}`, o);
      } catch (err) {
        console.error(`systemctl(${scope}) 실패:`, err.message);
      }
    }

    return Promise.all(config.services.map(async (cfg) => {
      const o = shown.get(`${cfg.scope}:${cfg.unit}`);
      const ns = num(o?.CPUUsageNSec);
      let cpu = null;
      const prev = prevSvc.get(cfg.id);
      if (ns != null && prev && now > prev.t) cpu = Math.max(0, (ns - prev.ns) / 1e6 / (now - prev.t) * 100);
      if (ns != null) prevSvc.set(cfg.id, { ns, t: now });

      const checks = { tcp: null, http: null };
      if (o?.ActiveState === 'active' && cfg.port != null) {
        checks.tcp = await tcpCheck(cfg.port);
        if (checks.tcp && cfg.http) checks.http = await httpCheck(cfg.port, cfg.http);
      }
      const since = parseUnixTs(o?.ActiveEnterTimestamp);
      const svc = {
        id: cfg.id,
        label: cfg.label,
        scope: cfg.scope,
        unit: cfg.unit,
        port: cfg.port,
        hasLog: true,
        load: o?.LoadState ?? 'not-found',
        active: o?.ActiveState ?? 'inactive',
        sub: o?.SubState ?? '',
        result: o?.Result ?? '',
        pid: num(o?.MainPID) || null,
        memory: num(o?.MemoryCurrent),
        cpu,
        restarts: num(o?.NRestarts) ?? 0,
        uptime: since && o.ActiveState === 'active' ? Math.max(0, Math.round(now / 1000 - since)) : null,
        checks,
      };
      svc.status = judge(svc);
      return svc;
    }));
  }

  async function sample() {
    const [sys, svcs] = await Promise.all([system(), services()]);
    return { ts: Date.now(), system: sys, services: svcs };
  }

  async function readLog(id, n) {
    const cfg = config.services.find((s) => s.id === id);
    if (!cfg) return null;
    const count = Math.max(1, Math.min(500, Number(n) || 200));
    if (cfg.logFile) {
      try {
        return { source: cfg.logFile, lines: await tailFile(cfg.logFile, count) };
      } catch (err) {
        return { source: cfg.logFile, lines: [], error: err.code === 'ENOENT' ? '로그 파일이 없습니다' : err.message };
      }
    }
    try {
      const args = [...(cfg.scope === 'user' ? ['--user'] : []), '-u', cfg.unit, '-n', String(count), '--no-pager', '-o', 'short-iso'];
      const { stdout } = await exec('journalctl', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      return { source: `journalctl ${cfg.scope === 'user' ? '--user ' : ''}-u ${cfg.unit}`, lines: stdout.split('\n').filter(Boolean) };
    } catch (err) {
      return { source: 'journalctl', lines: [], error: `journal 을 읽지 못했습니다 (권한: systemd-journal 그룹 필요할 수 있음): ${err.message.split('\n')[0]}` };
    }
  }

  return { sample, readLog };
}
