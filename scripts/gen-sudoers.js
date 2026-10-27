// services.json 에서 system 유닛의 허용 동작을 읽어 sudoers 규칙을 출력한다.
//   node scripts/gen-sudoers.js <사용자명>
// 규칙은 "정확히 그 명령"만 허용한다(예: /usr/bin/systemctl restart mome-backend.service).
// 와일드카드를 쓰지 않으므로 다른 유닛이나 다른 동작은 sudo 로 실행할 수 없다.
import { loadConfig } from '../src/config.js';

const user = process.argv[2];
if (!user || !/^[a-z_][a-z0-9_-]*$/.test(user)) {
  console.error('사용법: node scripts/gen-sudoers.js <사용자명>');
  process.exit(1);
}

const { services } = loadConfig(process.env);
// src/collect.js 의 SYSTEMCTL_PATH 와 같은 경로여야 sudo 가 허용한다.
const rules = services
  .filter((s) => s.scope === 'system')
  .flatMap((s) => s.actions.map((a) => `/usr/bin/systemctl ${a} ${s.unit}`));

console.log('# server-manager: 대시보드가 제어할 수 있는 시스템 유닛 (services.json 의 actions 에서 생성)');
if (rules.length === 0) {
  console.log('# (허용된 system 유닛 동작이 없습니다)');
} else {
  console.log(`${user} ALL=(root) NOPASSWD: ${rules.join(', \\\n    ')}`);
}
