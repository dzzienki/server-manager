import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { promisify } from 'node:util';

// 서버 상태 수집. 세 부분으로 나뉜다.
//   1) 순수 함수  : 출력 파싱·상태 판정 (외부 호출 없음 → 단위 테스트 대상)
//   2) 외부 호출  : systemctl, TCP/HTTP 점검, 파일 tail
//   3) createCollector : 위를 묶어 sample()(전체 스냅샷)과 readLog()(로그) 를 제공
// 모든 외부 명령은 execFile(셸 미사용)로 부르고, 인자는 검증된 설정 값만 사용한다.
const run = promisify(execFile);

// sudo 로 부를 systemctl 의 절대 경로. sudoers 규칙도 이 경로로 만든다(scripts/gen-sudoers.js) — 둘이 일치해야 허용된다.
const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const ACTION_LABEL = { start: '시작', stop: '중지', restart: '재시작' };

// `systemctl show -p` 로 요청할 속성. 각각의 의미:
//   LoadState  유닛 파일을 찾았는지(not-found 면 등록 안 된 유닛)
//   ActiveState/SubState  active·failed·inactive / running·dead 등
//   MainPID  주 프로세스 PID        MemoryCurrent  cgroup 전체 메모리(자식 프로세스 포함, 바이트)
//   CPUUsageNSec  누적 CPU 시간(나노초) — 두 샘플의 차이로 사용률을 구한다
//   NRestarts  자동 재시작 횟수     Result  마지막 종료 결과     ActiveEnterTimestamp  마지막 시작 시각
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

// 두 시점의 누적 CPU 시간(a→b)으로 그 사이의 전체 CPU 사용률(0~100)을 구한다. 첫 샘플은 직전 값이 없어 부정확할 수 있다.
export function cpuPercent(a, b) {
  const dt = b.total - a.total;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - (b.idle - a.idle) / dt)));
}

// 인증서 만료까지 남은 일수(내림). 이미 만료됐으면 음수.
export function certDaysLeft(validToMs, now = Date.now()) {
  return Math.floor((validToMs - now) / 86_400_000);
}

// 서비스 한 줄의 종합 상태: ok | warn | down | unknown
//   unknown  유닛이 등록되어 있지 않음(이름 오타나 미설치)
//   warn     시작/재로드 중이거나, 켜져 있는데 포트·HTTP 점검이 실패
//   down     active 가 아님(failed/inactive 등)
//   ok       위에 해당하지 않음
// 판정 순서가 곧 우선순위다: 유닛이 없으면 다른 값은 의미가 없으므로 가장 먼저 본다.
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

// 같은 scope 의 유닛들을 systemctl 한 번 호출로 가져온다(유닛마다 부르면 프로세스 생성 비용이 커진다).
// exec 를 주입받는 이유: 테스트에서 실제 systemctl 없이 출력만 흉내낼 수 있게 하려는 것.
// 반환: Map<유닛이름, 속성 객체>
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

// 로컬 포트에 TCP 연결이 되는지만 본다(프로세스는 떠 있는데 포트를 못 여는 경우를 잡는다).
function tcpCheck(port, timeout = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// 로컬 포트에 GET 을 보내 상태 코드와 응답 시간(ms)을 잰다. status 0 은 무응답/타임아웃.
// 응답 헤더만 받고 바로 끊는다 — 큰 페이지를 매번 내려받지 않기 위해.
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

// 이 서버의 HTTPS(443) 인증서 만료 시각을 읽는다. 로컬 nginx 에 SNI(host)로 접속해 인증서만 확인하고 바로 끊는다.
// 검증은 하지 않는다(rejectUnauthorized:false) — 만료 직전·만료된 인증서도 날짜를 읽어야 하기 때문. 실패하면 null.
export function certCheck(host, port = 443, timeout = 3000) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: '127.0.0.1', port, servername: host, rejectUnauthorized: false });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout, () => done(null));
    sock.once('error', () => done(null));
    sock.once('secureConnect', () => {
      const validTo = Date.parse(sock.getPeerCertificate()?.valid_to ?? '');
      done(Number.isFinite(validTo) ? { host, validTo } : null);
    });
  });
}

// 파일의 마지막 n 줄. 큰 로그를 통째로 읽지 않도록 끝에서 maxBytes 만 읽는다.
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

// 수집기를 만든다. CPU 사용률은 "이전 샘플과의 차이"로 구하므로 이전 값을 클로저에 들고 있다.
// 그래서 sample() 을 일정 주기로 계속 불러줘야 의미 있는 값이 나온다(server.js 의 샘플링 루프가 담당).
export function createCollector(config, { exec = run } = {}) {
  const readCpu = () => {
    let idle = 0; let total = 0;
    for (const c of os.cpus()) for (const [k, v] of Object.entries(c.times)) { total += v; if (k === 'idle') idle += v; }
    return { idle, total };
  };
  let prevCpu = readCpu();
  const prevSvc = new Map(); // 서비스별 직전 누적 CPU: id -> { ns(나노초), t(측정 시각 ms) }

  // 인증서 만료일은 거의 안 바뀌므로 1시간에 한 번만 확인한다(실패하면 5분 뒤 재시도, 그동안은 직전 값을 유지).
  // config.tlsHost 가 없으면 점검하지 않는다.
  let certCache = null; let certAt = 0;
  async function cert() {
    if (!config.tlsHost) return null;
    const now = Date.now();
    if (now - certAt < (certCache ? 3_600_000 : 300_000)) return certCache;
    certAt = now;
    certCache = (await certCheck(config.tlsHost)) ?? certCache;
    return certCache;
  }

  // 서버 전체: CPU·메모리·디스크·부하·가동 시간
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

    return { cpu, cores: os.cpus().length, load: os.loadavg(), uptime: os.uptime(), mem, disks, cert: await cert() };
  }

  // 서비스별: systemd 상태 + 포트/HTTP 점검을 합쳐 한 줄씩 만든다.
  async function services() {
    const now = Date.now();
    // user/system 은 systemctl 호출 방식이 달라서(--user) 두 번으로 나눠 부른다.
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
      // CPU%: 직전 샘플 이후 늘어난 CPU 시간 ÷ 경과 시간. 코어 1개를 100% 로 본다(멀티스레드면 100 을 넘을 수 있음).
      const ns = num(o?.CPUUsageNSec);
      let cpu = null;
      const prev = prevSvc.get(cfg.id);
      if (ns != null && prev && now > prev.t) cpu = Math.max(0, (ns - prev.ns) / 1e6 / (now - prev.t) * 100);
      if (ns != null) prevSvc.set(cfg.id, { ns, t: now });

      // 점검은 active 일 때만 한다(꺼진 서비스의 포트를 두드려도 의미가 없다).
      // HTTP 는 TCP 가 통했을 때만 보낸다. null = 점검 대상 아님/건너뜀.
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
        actions: cfg.actions, // 화면이 어떤 버튼을 보여줄지 결정하는 데 쓴다(실제 허용 여부는 서버가 다시 검사)
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

  // 서버 + 서비스 스냅샷 한 장. 두 수집은 서로 독립이라 동시에 실행한다.
  async function sample() {
    const [sys, svcs] = await Promise.all([system(), services()]);
    return { ts: Date.now(), system: sys, services: svcs };
  }

  // 서비스 로그 마지막 n 줄(최대 500). logFile 이 지정된 서비스는 파일을, 아니면 journalctl 을 읽는다.
  // id 는 services.json 에 있는 값만 허용(없으면 null → 404)하므로 임의 경로/유닛을 읽을 수 없다.
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

  // 서비스 제어(시작/중지/재시작). 반환: { ok, message, status? } — 던지지 않고 결과 객체로 알려준다.
  //   user 유닛   : systemctl --user <동작> <유닛>   (이 프로세스와 같은 계정이라 권한 문제 없음)
  //   system 유닛 : sudo -n systemctl <동작> <유닛>  (sudoers 에 "그 명령만" 허용해 둬야 함 → scripts/install-sudoers.sh)
  // 서버 쪽 검사와 별개로 여기서도 id·동작을 services.json 허용 목록과 대조한다(방어를 한 겹 더).
  async function control(id, action) {
    const cfg = config.services.find((s) => s.id === id);
    if (!cfg) return { ok: false, status: 404, message: '알 수 없는 서비스입니다' };
    if (!cfg.actions.includes(action)) return { ok: false, status: 403, message: '이 서비스에는 허용되지 않은 동작입니다' };
    const [cmd, args] = cfg.scope === 'user'
      ? ['systemctl', ['--user', action, cfg.unit]]
      : ['sudo', ['-n', SYSTEMCTL_PATH, action, cfg.unit]];
    try {
      await exec(cmd, args, { timeout: 90_000 }); // java 처럼 종료가 느린 서비스를 위해 넉넉히
      return { ok: true, message: `${cfg.label} ${ACTION_LABEL[action]} 완료` };
    } catch (err) {
      const raw = `${err.stderr ?? ''}${err.message ?? ''}`.trim().split('\n')[0];
      const noPerm = /password is required|not allowed|a terminal is required|may not run sudo/i.test(raw);
      return {
        ok: false,
        status: 500,
        message: noPerm ? '권한이 없습니다. sudoers 설정이 필요합니다(scripts/install-sudoers.sh)' : `${ACTION_LABEL[action]} 실패: ${raw}`,
      };
    }
  }

  return { sample, readLog, control };
}
