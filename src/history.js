// 최근 샘플을 메모리에 보관(링 버퍼). 기본 360개 × 10초 = 1시간. 재시작하면 비워진다.
export function createHistory(ids, capacity = 360) {
  const t = []; const cpu = []; const mem = [];
  const svcMem = Object.fromEntries(ids.map((id) => [id, []]));
  const svcMs = Object.fromEntries(ids.map((id) => [id, []])); // 서비스별 HTTP 점검 응답 시간(ms)
  const push = (arr, v) => { arr.push(v); if (arr.length > capacity) arr.shift(); };
  return {
    // 샘플에서 차트에 필요한 값만 뽑아 쌓는다: 전체 CPU%, 메모리 사용률%, 서비스별 메모리(바이트)·응답 시간(ms).
    add(sample) {
      const { mem: m, cpu: c } = sample.system;
      push(t, sample.ts);
      push(cpu, Math.round(c * 10) / 10);
      push(mem, m.total ? Math.round(((m.total - m.available) / m.total) * 1000) / 10 : null);
      for (const s of sample.services) {
        if (svcMem[s.id]) push(svcMem[s.id], s.memory);
        if (svcMs[s.id]) push(svcMs[s.id], s.checks?.http?.ms ?? null); // HTTP 점검을 안 했으면 null
      }
    },
    // 컬럼 배열로 내려 JSON 크기를 줄인다
    toJSON: () => ({ t, cpu, mem, svcMem, svcMs }),
  };
}
