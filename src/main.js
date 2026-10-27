// 진입점: 설정 로드 → 수집기 선택(실제/데모) → 샘플링 시작 → HTTP 서버 시작.
// 실행: `npm start`(.env 사용) 또는 `npm run dev`(데모 데이터).
import { loadConfig } from './config.js';
import { createCollector } from './collect.js';
import { createDemoCollector } from './demo.js';
import { createApp } from './server.js';

const config = loadConfig();

// 비밀번호 정책: 데모가 아니면 비밀번호 없이는 시작하지 않는다(실수로 인증 없이 열리는 것을 막는다).
if (config.demo) {
  config.password ||= 'demo';
  console.log('⚠️  데모 모드: 가짜 데이터입니다 (로그인 비밀번호: demo)');
} else if (!config.password) {
  console.error('SM_PASSWORD 가 비어 있어 시작하지 않습니다. .env 에 비밀번호를 설정하세요 (.env.example 참고).');
  process.exit(1);
} else if (config.password.length < 12) {
  console.warn('⚠️  SM_PASSWORD 가 12자보다 짧습니다. 더 긴 값을 권장합니다.');
}

// 수집기는 { sample(), readLog(id, n) } 인터페이스만 맞으면 되므로 데모와 실제를 바꿔 끼울 수 있다.
const collector = config.demo ? createDemoCollector(config) : createCollector(config);
const app = createApp({ config, collector });

// CPU 사용률은 두 샘플 사이의 차이라서, 첫 샘플 전에 잠깐 기다린다.
await new Promise((r) => setTimeout(r, 1000));
await app.startSampling();

// 기본 바인딩은 127.0.0.1(로컬 전용). nginx 프록시나 SSH 터널을 통해서만 접근하게 한다.
app.server.listen(config.port, config.host, () => {
  console.log(`server-manager 대기 중: http://${config.host}:${config.port}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('⚠️  로컬 전용이 아닌 주소에 바인딩되었습니다. 방화벽/프록시 인증을 확인하세요.');
  }
});

// systemctl stop(SIGTERM)이나 Ctrl+C 로 깔끔하게 종료
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.stop(); process.exit(0); });
