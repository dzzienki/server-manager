import { loadConfig } from './config.js';
import { createCollector } from './collect.js';
import { createDemoCollector } from './demo.js';
import { createApp } from './server.js';

const config = loadConfig();

if (config.demo) {
  config.password ||= 'demo';
  console.log('⚠️  데모 모드: 가짜 데이터입니다 (로그인 비밀번호: demo)');
} else if (!config.password) {
  console.error('SM_PASSWORD 가 비어 있어 시작하지 않습니다. .env 에 비밀번호를 설정하세요 (.env.example 참고).');
  process.exit(1);
} else if (config.password.length < 12) {
  console.warn('⚠️  SM_PASSWORD 가 12자보다 짧습니다. 더 긴 값을 권장합니다.');
}

const collector = config.demo ? createDemoCollector(config) : createCollector(config);
const app = createApp({ config, collector });

// CPU 사용률은 두 샘플 사이의 차이라서, 첫 샘플 전에 잠깐 기다린다.
await new Promise((r) => setTimeout(r, 1000));
await app.startSampling();

app.server.listen(config.port, config.host, () => {
  console.log(`server-manager 대기 중: http://${config.host}:${config.port}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('⚠️  로컬 전용이 아닌 주소에 바인딩되었습니다. 방화벽/프록시 인증을 확인하세요.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.stop(); process.exit(0); });
