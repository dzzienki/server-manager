// 맥/로컬에서 UI 를 확인하기 위한 가짜 수집기 (SM_DEMO=1). 실제 서버에서는 쓰지 않는다.
const GB = 2 ** 30;
const MB = 2 ** 20;

export function createDemoCollector(config) {
  let tick = 0;
  const walk = (base, amp, phase) => Math.max(0, base + amp * Math.sin(tick / 6 + phase) + (Math.random() - 0.5) * amp * 0.4);

  async function sample() {
    tick += 1;
    const total = 13 * GB;
    const used = walk(4.1 * GB, 0.3 * GB, 1);
    const services = config.services.map((cfg, i) => {
      const down = cfg.id === 'valkey';
      const warn = cfg.id === 'mome';
      const base = [180, 65, 210, 140, 850, 320, 12, 8, 48][i % 9] * MB;
      const active = down ? 'failed' : 'active';
      const checks = { tcp: null, http: null };
      if (!down && cfg.port != null) {
        checks.tcp = true;
        if (cfg.http) checks.http = { status: warn ? 502 : cfg.http === '/' ? 404 : 200, ms: Math.round(walk(18, 10, i)) };
      }
      const svc = {
        id: cfg.id, label: cfg.label, scope: cfg.scope, unit: cfg.unit, port: cfg.port, hasLog: true,
        load: 'loaded', active, sub: down ? 'failed' : 'running', result: down ? 'exit-code' : 'success',
        pid: down ? null : 1000 + i * 111,
        memory: down ? null : walk(base, base * 0.04, i),
        cpu: down ? null : Math.max(0, walk(i % 3 === 0 ? 4 : 0.6, 1.5, i)),
        restarts: cfg.id === 'mayhemdex-crawl' ? 3 : 0,
        uptime: down ? null : 3600 * (5 + i * 9) + tick * 10,
        checks,
      };
      svc.status = down ? 'down' : warn ? 'warn' : 'ok';
      return svc;
    });
    return {
      ts: Date.now(),
      services,
      system: {
        cpu: Math.min(100, walk(14, 9, 0)), cores: 8, load: [0.42, 0.38, 0.31], uptime: 86400 * 41 + tick * 10,
        mem: { total, available: total - used, swapTotal: 4 * GB, swapFree: 4 * GB - 0.2 * GB },
        disks: [{ mount: '/', total: 100 * GB, used: 62 * GB }, { mount: '/home', total: 400 * GB, used: 352 * GB }],
      },
    };
  }

  async function readLog(id) {
    const cfg = config.services.find((s) => s.id === id);
    if (!cfg) return null;
    const now = Date.now();
    const lines = Array.from({ length: 60 }, (_, i) => {
      const ts = new Date(now - (60 - i) * 4000).toISOString();
      return `${ts} ${cfg.unit}[${1000 + i}]: ${i % 17 === 0 ? 'WARN slow request 1240ms GET /api/items' : 'GET /api/health 200 3ms'}`;
    });
    return { source: `demo (${cfg.unit})`, lines };
  }

  return { sample, readLog };
}
