// 최근 샘플을 메모리에 보관(링 버퍼). 기본 360개 × 10초 = 1시간. 재시작하면 비워진다.
export function createHistory(ids, capacity = 360) {
  const t = []; const cpu = []; const mem = [];
  const svcMem = Object.fromEntries(ids.map((id) => [id, []]));
  const push = (arr, v) => { arr.push(v); if (arr.length > capacity) arr.shift(); };
  return {
    add(sample) {
      const { mem: m, cpu: c } = sample.system;
      push(t, sample.ts);
      push(cpu, Math.round(c * 10) / 10);
      push(mem, m.total ? Math.round(((m.total - m.available) / m.total) * 1000) / 10 : null);
      for (const s of sample.services) if (svcMem[s.id]) push(svcMem[s.id], s.memory);
    },
    // 컬럼 배열로 내려 JSON 크기를 줄인다
    toJSON: () => ({ t, cpu, mem, svcMem }),
  };
}
