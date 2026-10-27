// 최근 기록(로그인 성공/실패, 서비스 제어)을 메모리에 보관한다. 최신이 앞. 서버를 재시작하면 비워진다
// (영구 기록은 journal 에 남는다: journalctl --user -u server-manager | grep -E '\[(login|action)\]').
//
// 같은 IP 가 같은 이유로 연달아 실패하면 한 줄로 합치고 count 를 올린다 —
// 비밀번호를 계속 찍어보는 봇이 있어도 기록이 그 줄로 가득 차 제어 기록을 밀어내지 않게 하려는 것.
export function createEvents(capacity = 100) {
  const list = [];
  return {
    // e: { type: 'login'|'action', ok: boolean, ip: string, text: string }
    add(e) {
      const ts = Date.now();
      const last = list[0];
      if (e.type === 'login' && !e.ok && last?.type === 'login' && !last.ok && last.ip === e.ip && last.text === e.text) {
        last.count += 1;
        last.ts = ts;
        return;
      }
      list.unshift({ ts, count: 1, ...e });
      if (list.length > capacity) list.pop();
    },
    toJSON: () => list,
  };
}
