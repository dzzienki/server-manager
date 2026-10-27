// 서버에서 받은 값은 전부 텍스트 노드로만 넣는다(innerHTML 미사용) — 로그에 HTML 이 섞여 있어도 실행되지 않는다.
const POLL_MS = 5000;
const $ = (sel) => document.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}
function s(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// ---- 포맷 ---------------------------------------------------------------------
const GB = 2 ** 30; const MB = 2 ** 20;
const fmtBytes = (n) => (n == null ? '—' : n >= GB ? `${(n / GB).toFixed(1)} GB` : n >= MB ? `${Math.round(n / MB)} MB` : `${Math.round(n / 1024)} KB`);
const fmtPct = (n) => (n == null ? '—' : `${n < 10 ? n.toFixed(1) : Math.round(n)}%`);
function fmtDur(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}일 ${hh}시간`;
  if (hh) return `${hh}시간 ${m}분`;
  return m ? `${m}분` : `${Math.floor(sec)}초`;
}
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour12: false });

const STATUS = {
  ok: { icon: '✓', text: '정상' },
  warn: { icon: '!', text: '경고' },
  down: { icon: '✕', text: '중지' },
  unknown: { icon: '?', text: '없음' },
};
function badge(status, detail) {
  const st = STATUS[status] ?? STATUS.unknown;
  return h('span', { class: 'badge' }, h('span', { class: `ico ${status}`, 'aria-hidden': 'true' }, st.icon), detail ? `${st.text} · ${detail}` : st.text);
}

// ---- 툴팁 + 스파크라인 ------------------------------------------------------------
const tooltip = $('#tooltip');
function showTip(x, y, lines) {
  tooltip.replaceChildren(...lines.map((l, i) => h(i ? 'div' : 'strong', {}, l)));
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.min(x + 12, window.innerWidth - r.width - 8)}px`;
  tooltip.style.top = `${Math.max(8, y - r.height - 10)}px`;
}
const hideTip = () => { tooltip.hidden = true; };

// values: 숫자/null 배열, times: 같은 길이의 ms 배열. 선 2px, 끝점 8px 마커, 0 기준선.
// zero=false 면 값 범위에 맞춰 그린다(서서히 늘어나는 메모리 누수가 보이도록). 최소 폭은 최대값의 10%.
function spark({ values, times, fmt, label, w = 120, hgt = 30, minTop = 0, zero = true }) {
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, role: 'img', 'aria-label': label });
  const pts = values.map((v, i) => (v == null ? null : [i, v])).filter(Boolean);
  if (pts.length < 2) return svg;
  const mx = Math.max(...pts.map((p) => p[1]));
  const mn = Math.min(...pts.map((p) => p[1]));
  let lo = 0;
  let top = Math.max(minTop, mx * 1.15) || 1;
  if (!zero) {
    const span = Math.max(mx - mn, mx * 0.1) || 1;
    lo = mn - (span - (mx - mn)) / 2;
    top = lo + span;
  }
  const pad = 5;
  const x = (i) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = (v) => hgt - 3 - ((v - lo) / (top - lo)) * (hgt - 8);
  if (zero) svg.append(s('line', { class: 'base', x1: 0, x2: w, y1: hgt - 3, y2: hgt - 3 }));
  svg.append(s('polyline', { class: 'line', points: pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ') }));
  const last = pts.at(-1);
  svg.append(s('circle', { class: 'dot', cx: x(last[0]).toFixed(1), cy: y(last[1]).toFixed(1), r: 4 }));
  const cross = s('line', { class: 'cross', y1: 0, y2: hgt, visibility: 'hidden' });
  svg.append(cross);
  svg.append(s('rect', { class: 'hit', x: 0, y: 0, width: w, height: hgt }));
  svg.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const rel = (ev.clientX - box.left) / box.width;
    const idx = Math.round(Math.min(1, Math.max(0, (rel * w - pad) / (w - pad * 2))) * (values.length - 1));
    const v = values[idx];
    if (v == null) { hideTip(); cross.setAttribute('visibility', 'hidden'); return; }
    cross.setAttribute('x1', x(idx)); cross.setAttribute('x2', x(idx)); cross.setAttribute('visibility', 'visible');
    showTip(ev.clientX, ev.clientY, [fmt(v), fmtTime(times[idx])]);
  });
  svg.addEventListener('pointerleave', () => { hideTip(); cross.setAttribute('visibility', 'hidden'); });
  return svg;
}

function meter(pct) {
  const level = pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : '';
  const fill = h('i', { class: level });
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  return h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) }, fill);
}

// ---- 렌더 ---------------------------------------------------------------------
function renderTiles(d) {
  const { system: sys, history: hist } = d;
  const used = sys.mem.total - sys.mem.available;
  const memPct = sys.mem.total ? (used / sys.mem.total) * 100 : 0;
  const swapUsed = sys.mem.swapTotal - sys.mem.swapFree;

  const cpu = h('article', { class: 'tile card' },
    h('div', { class: 'label' }, 'CPU'),
    h('div', { class: 'value' }, fmtPct(sys.cpu)),
    spark({ values: hist.cpu, times: hist.t, fmt: (v) => `CPU ${fmtPct(v)}`, label: 'CPU 사용률 추이', w: 200, minTop: 20 }),
    h('div', { class: 'sub' }, `부하 ${sys.load.map((l) => l.toFixed(2)).join(' / ')} · ${sys.cores}코어`));

  const mem = h('article', { class: 'tile card' },
    h('div', { class: 'label' }, '메모리'),
    h('div', { class: 'value' }, fmtBytes(used), h('small', {}, ` / ${fmtBytes(sys.mem.total)}`)),
    meter(memPct),
    spark({ values: hist.mem, times: hist.t, fmt: (v) => `메모리 ${fmtPct(v)}`, label: '메모리 사용률 추이', w: 200, minTop: 30 }),
    h('div', { class: 'sub' }, `사용 가능 ${fmtBytes(sys.mem.available)} · 스왑 ${fmtBytes(swapUsed)} / ${fmtBytes(sys.mem.swapTotal)}`));

  const disk = h('article', { class: 'tile card' },
    h('div', { class: 'label' }, '디스크'),
    ...sys.disks.flatMap((dk) => {
      const pct = (dk.used / dk.total) * 100;
      return [h('div', { class: 'disk' },
        h('div', { class: 'row' }, h('span', {}, dk.mount), h('span', {}, `${fmtBytes(dk.used)} / ${fmtBytes(dk.total)} · ${fmtPct(pct)}`)),
        meter(pct))];
    }),
    sys.disks.length ? null : h('div', { class: 'sub' }, '디스크 정보를 읽지 못했습니다'));

  const up = h('article', { class: 'tile card' },
    h('div', { class: 'label' }, '서버 가동 시간'),
    h('div', { class: 'value' }, fmtDur(sys.uptime)));

  $('#tiles').replaceChildren(cpu, mem, disk, up);
}

function checksCell(svc) {
  const c = svc.checks;
  const items = [];
  if (svc.port != null) {
    if (c.tcp == null) items.push(h('span', {}, `:${svc.port} —`));
    else items.push(h('span', { class: c.tcp ? '' : 'bad' }, `:${svc.port} ${c.tcp ? '열림' : '닫힘'}`));
  }
  if (c.http) {
    const bad = c.http.status === 0 || c.http.status >= 500;
    items.push(h('span', { class: bad ? 'bad' : '' }, c.http.status === 0 ? 'HTTP 무응답' : `HTTP ${c.http.status} · ${c.http.ms}ms`));
  }
  if (!items.length) items.push(h('span', {}, '—'));
  return h('div', { class: 'checks' }, items);
}

function renderServices(d) {
  const { services, history: hist } = d;
  const counts = { ok: 0, warn: 0, down: 0, unknown: 0 };
  for (const sv of services) counts[sv.status] += 1;
  $('#summary').replaceChildren(
    ...['ok', 'warn', 'down', 'unknown'].filter((k) => counts[k] > 0).map((k) => badge(k, `${counts[k]}개`)));

  const rows = services.map((sv) => {
    const detail = sv.status === 'down' ? sv.sub || sv.active : sv.status === 'warn' && sv.active !== 'active' ? sv.active : '';
    return h('tr', {},
      h('td', {}, badge(sv.status, detail)),
      h('td', {}, h('span', { class: 'name' }, sv.label), h('span', { class: 'unit' }, `${sv.scope === 'user' ? '사용자' : '시스템'} · ${sv.unit}`)),
      h('td', { class: 'num' }, h('div', { class: 'mem' },
        h('span', {}, fmtBytes(sv.memory)),
        spark({ values: hist.svcMem[sv.id] ?? [], times: hist.t, fmt: (v) => `${sv.label} ${fmtBytes(v)}`, label: `${sv.label} 메모리 추이`, w: 90, hgt: 24, zero: false }))),
      h('td', { class: 'num hide-sm' }, fmtPct(sv.cpu)),
      h('td', { class: 'num hide-sm' }, fmtDur(sv.uptime)),
      h('td', { class: 'num hide-sm' }, sv.restarts ? String(sv.restarts) : '0'),
      h('td', {}, checksCell(sv)),
      h('td', {}, h('button', { class: 'btn', type: 'button', onclick: () => openLog(sv) }, '로그')));
  });
  $('#services tbody').replaceChildren(...rows);
}

// ---- API / 폴링 -----------------------------------------------------------------
class AuthError extends Error {}
async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401 && !path.endsWith('/login')) throw new AuthError();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

let pollTimer = null;
function showLogin() {
  clearTimeout(pollTimer);
  $('#dash').hidden = true; $('#login').hidden = false; $('#logout').hidden = true;
  $('#pw').focus();
}
async function poll() {
  clearTimeout(pollTimer);
  try {
    const d = await api('./api/overview');
    $('#login').hidden = true; $('#dash').hidden = false; $('#logout').hidden = false;
    $('#host').textContent = d.host;
    $('#demo-banner').hidden = !d.demo;
    $('#interval').textContent = `${Math.round(d.intervalMs / 1000)}초`;
    $('#updated').textContent = `갱신 ${fmtTime(d.ts)}`;
    renderTiles(d);
    renderServices(d);
  } catch (err) {
    if (err instanceof AuthError) { showLogin(); return; }
    $('#updated').textContent = `갱신 실패: ${err.message}`;
  }
  pollTimer = setTimeout(poll, POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#dash').hidden) poll(); else if (document.hidden) clearTimeout(pollTimer); });

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('./api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
    $('#pw').value = '';
    poll();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => { await api('./api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

// ---- 로그 보기 ------------------------------------------------------------------
const dlg = $('#log-dialog');
let logSvc = null; let logTimer = null;
async function loadLog() {
  if (!logSvc) return;
  try {
    const r = await api(`./api/logs?id=${encodeURIComponent(logSvc.id)}&n=200`);
    $('#log-source').textContent = r.source;
    $('#log-error').textContent = r.error ?? '';
    const body = $('#log-body');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.textContent = r.lines.length ? r.lines.join('\n') : '(로그가 없습니다)';
    if (atBottom) body.scrollTop = body.scrollHeight;
  } catch (err) {
    if (err instanceof AuthError) { dlg.close(); showLogin(); return; }
    $('#log-error').textContent = err.message;
  }
}
function scheduleLog() {
  clearTimeout(logTimer);
  if (dlg.open && $('#log-auto').checked) logTimer = setTimeout(async () => { await loadLog(); scheduleLog(); }, 5000);
}
async function openLog(sv) {
  logSvc = sv;
  $('#log-title').textContent = `${sv.label} 로그`;
  $('#log-body').textContent = '불러오는 중…';
  dlg.showModal();
  await loadLog();
  $('#log-body').scrollTop = $('#log-body').scrollHeight;
  scheduleLog();
}
$('#log-close').addEventListener('click', () => dlg.close());
$('#log-refresh').addEventListener('click', loadLog);
$('#log-auto').addEventListener('change', scheduleLog);
dlg.addEventListener('close', () => { clearTimeout(logTimer); logSvc = null; });

poll();
