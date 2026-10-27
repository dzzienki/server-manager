// 서버에서 받은 값은 전부 텍스트 노드로만 넣는다(innerHTML 미사용) — 로그에 HTML 이 섞여 있어도 실행되지 않는다.
// 화면 로직 (프레임워크 없는 바닐라 JS). 흐름:
//   poll() 이 5초마다 /api/overview 를 불러 → renderTiles()/renderServices() 로 화면을 다시 그린다.
//   401 이 오면 로그인 화면(showLogin)으로, 로그인에 성공하면 다시 poll() 한다.
//   서비스 행의 [로그] 버튼은 openLog() 로 로그 창을 연다.
// URL 은 "./api/..." 처럼 상대 경로를 쓴다 → /manager/ 같은 하위 경로 뒤에 둬도 그대로 동작한다.
const POLL_MS = 5000; // 화면 갱신 주기. 서버 수집 주기(기본 10초)보다 짧아도 캐시를 받을 뿐이라 부담이 없다.
const $ = (sel) => document.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';

// DOM 생성 도우미: h('div', { class: 'x', onclick: fn }, 자식...) — 자식 문자열은 텍스트 노드로 들어간다.
// innerHTML 을 쓰지 않으므로 서버가 준 값에 HTML 이 섞여 있어도 코드로 실행되지 않는다.
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
// h() 의 SVG 버전. SVG 는 네임스페이스가 달라서 createElementNS 가 필요하다.
function s(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// ---- 포맷 ---------------------------------------------------------------------
// ---- 포맷 도우미: 값이 없으면(null) 항상 '—' 로 표시 ----
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

// 상태 표시. 색(.ico.ok 등, style.css)만으로 구분하지 않도록 아이콘 글자와 한글 이름을 항상 같이 보여준다.
const STATUS = {
  ok: { icon: '✓', text: '정상' },
  warn: { icon: '!', text: '경고' },
  down: { icon: '✕', text: '중지' },
  unknown: { icon: '?', text: '없음' },
};
// "● 정상" / "▲ 경고 · 설명" 형태의 상태 배지. detail 은 중지 사유 등 보충 설명.
function badge(status, detail) {
  const st = STATUS[status] ?? STATUS.unknown;
  return h('span', { class: 'badge' }, h('span', { class: `ico ${status}`, 'aria-hidden': 'true' }, st.icon), detail ? `${st.text} · ${detail}` : st.text);
}

// ---- 툴팁 + 스파크라인 ------------------------------------------------------------
// 툴팁은 페이지에 하나만 두고 모든 차트가 공유한다. 화면 밖으로 나가지 않게 위치를 보정한다.
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

// 사용률 막대. 80% 이상 노랑, 90% 이상 빨강으로 바뀐다(숫자는 옆 텍스트로 항상 함께 표시).
function meter(pct) {
  const level = pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : '';
  const fill = h('i', { class: level });
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  return h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) }, fill);
}

// ---- 렌더 ---------------------------------------------------------------------
// 위쪽 서버 전체 타일 4개(CPU / 메모리 / 디스크 / 가동 시간)를 다시 그린다.
// 메모리 사용량 = 전체 - "사용 가능(available)" (캐시로 쓰는 메모리는 사용 중으로 치지 않는다).
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

// "점검" 열: 포트 열림 여부와 HTTP 응답. 문제가 있는 항목은 굵게(.bad) 표시한다.
// 서버가 점검하지 않은 항목(꺼진 서비스 등)은 '—'.
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

// 요약 줄(정상 n개·경고 n개…)과 서비스 표를 다시 그린다. 개수가 0 인 상태는 요약에서 생략한다.
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
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => openLog(sv) }, '로그'),
        controlButtons(sv))));
  });
  $('#services tbody').replaceChildren(...rows);
}

// ---- 서비스 제어 (시작/중지/재시작) ----------------------------------------------
let busyId = null;   // 동작이 진행 중인 서비스 id — 그 행의 버튼을 잠가 중복 클릭을 막는다
let lastData = null; // 마지막으로 받은 데이터(버튼 잠금 상태를 바꿀 때 다시 그리는 데 쓴다)

// 서비스 상태에 맞는 버튼만 보여준다. 서버가 허용한 동작(sv.actions)만 나타나며, 실제 허용 여부는 서버가 다시 검사한다.
//   켜져 있음 → [재시작] [중지]   /   꺼져 있음 → [시작]  (start 가 허용되지 않고 restart 만 허용되면 [재시작]이 그 역할)
function controlButtons(sv) {
  const acts = sv.actions ?? [];
  const running = sv.active === 'active' || sv.active === 'activating';
  const defs = [];
  if (running) {
    if (acts.includes('restart')) defs.push(['restart', '재시작']);
    if (acts.includes('stop')) defs.push(['stop', '중지']);
  } else if (acts.includes('start')) {
    defs.push(['start', '시작']);
  } else if (acts.includes('restart')) {
    defs.push(['restart', '시작']);
  }
  return defs.map(([action, label]) => h('button', {
    class: `btn${action === 'stop' ? ' danger' : ''}`,
    type: 'button',
    disabled: busyId === sv.id,
    onclick: () => confirmAndRun(sv, action, label),
  }, label));
}

// 확인 창. 확인 버튼이면 true, 취소/Esc 면 false. (window.confirm 대신 <dialog> 를 써서 화면 스타일과 맞추고 브라우저 차단을 피한다)
const confirmDlg = $('#confirm-dialog');
function confirmDialog(message, warning, okLabel, danger) {
  $('#confirm-msg').textContent = message;
  $('#confirm-warn').textContent = warning;
  const ok = $('#confirm-ok');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'danger-fill' : 'primary'}`;
  confirmDlg.returnValue = '';
  confirmDlg.showModal();
  return new Promise((resolve) => {
    confirmDlg.addEventListener('close', () => resolve(confirmDlg.returnValue === 'ok'), { once: true });
  });
}

// 화면 아래 알림. kind: info(진행 중, 계속 표시) | ok | error (5초 뒤 사라짐)
const toastEl = $('#toast');
let toastTimer = null;
function toast(message, kind = 'ok') {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  if (kind !== 'info') toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5000);
}

// 확인 → 서버에 요청 → 결과 알림 → 즉시 다시 갱신. 요청은 시간이 걸릴 수 있다(서비스 종료/시작 대기).
async function confirmAndRun(sv, action, label) {
  const warning = action === 'stop'
    ? '중지하면 서비스가 내려가고, 다시 시작하기 전까지 접속할 수 없습니다.'
    : label === '시작'
      ? '서비스를 시작합니다.' // 꺼져 있는 서비스를 켜는 경우(restart 만 허용된 서비스 포함)
      : `${sv.scope === 'system' ? '시스템 서비스입니다. ' : ''}재시작하는 동안 잠시 접속이 끊길 수 있습니다.`;
  if (!(await confirmDialog(`${sv.label}을(를) ${label}할까요?`, warning, label, action === 'stop'))) return;

  busyId = sv.id;
  if (lastData) renderServices(lastData); // 버튼 잠금 반영
  toast(`${sv.label} ${label} 중…`, 'info');
  try {
    const r = await api('./api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sv.id, action }),
    });
    toast(r.message, 'ok');
  } catch (err) {
    if (err instanceof AuthError) { busyId = null; showLogin(); return; }
    toast(err.message, 'error');
  }
  busyId = null;
  poll();
}

// ---- API / 폴링 -----------------------------------------------------------------
// 401(로그인 필요/세션 만료)을 일반 오류와 구분하기 위한 표시용 에러
class AuthError extends Error {}
// fetch 래퍼: 401 이면 AuthError, 그 외 실패는 서버가 준 error 메시지를 담은 Error 를 던진다.
// (로그인 요청 자체의 401 은 "비밀번호 틀림" 이므로 AuthError 로 취급하지 않는다)
async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401 && !path.endsWith('/login')) throw new AuthError();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

let pollTimer = null;
// 로그인 화면으로 전환하고 갱신을 멈춘다.
function showLogin() {
  clearTimeout(pollTimer);
  $('#dash').hidden = true; $('#login').hidden = false; $('#logout').hidden = true;
  $('#pw').focus();
}
// 데이터를 한 번 받아 화면을 그리고 다음 poll 을 예약한다. setInterval 이 아니라 "끝난 뒤 예약"이라 요청이 겹치지 않는다.
// 실패(서버 재시작 중 등)해도 멈추지 않고 계속 재시도하며, 상단에 실패 사유만 표시한다.
async function poll() {
  clearTimeout(pollTimer);
  try {
    const d = await api('./api/overview');
    $('#login').hidden = true; $('#dash').hidden = false; $('#logout').hidden = false;
    $('#host').textContent = d.host;
    $('#demo-banner').hidden = !d.demo;
    $('#interval').textContent = `${Math.round(d.intervalMs / 1000)}초`;
    $('#updated').textContent = `갱신 ${fmtTime(d.ts)}`;
    lastData = d;
    renderTiles(d);
    renderServices(d);
  } catch (err) {
    if (err instanceof AuthError) { showLogin(); return; }
    $('#updated').textContent = `갱신 실패: ${err.message}`;
  }
  pollTimer = setTimeout(poll, POLL_MS);
}
// 탭이 가려져 있는 동안은 갱신을 멈추고(서버 부하·배터리 절약), 다시 보이면 즉시 한 번 갱신한다.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#dash').hidden) poll(); else if (document.hidden) clearTimeout(pollTimer); });

// 로그인 제출: 성공하면 서버가 세션 쿠키를 심어주므로 바로 poll() 로 대시보드를 연다. 실패 사유(틀림/잠금)는 폼 아래에 표시.
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
// ---- 로그 보기 창 (<dialog>) ----
// logSvc: 지금 보고 있는 서비스, logTimer: 자동 갱신(5초) 타이머. 창을 닫으면 둘 다 정리한다.
const dlg = $('#log-dialog');
let logSvc = null; let logTimer = null;
// 로그를 불러와 표시한다. 사용자가 위로 스크롤해 읽는 중이면 새 로그가 와도 맨 아래로 끌어내리지 않는다.
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
// "자동 갱신" 체크 상태에 따라 5초 뒤 loadLog 를 예약한다(창이 닫혀 있으면 예약하지 않음).
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
