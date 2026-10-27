# server-manager

서버 1대에서 도는 서비스(systemd 유닛)의 상태·메모리·CPU·로그를 한 화면에서 보는 가벼운 대시보드.
의존성 없음(Node 내장 모듈만), 단일 프로세스, 힙 64MB 제한.

**1단계(현재): 읽기 전용 모니터링.** 재시작/중지 같은 제어 기능은 아직 없다.

## 보여주는 것
- 서버: CPU, 메모리/스왑, 디스크, 부하, 가동 시간 (최근 1시간 추이는 메모리에만 보관)
- 서비스별: 상태(정상/경고/중지), 메모리, CPU, 가동 시간, 재시작 횟수, 포트·HTTP 점검, 로그 보기
- 상태 판정: 유닛이 active 이고 포트가 열려 있고 HTTP 가 5xx/무응답이 아니면 **정상**. 401·403·404 는 앱이 응답하는 것이므로 정상으로 본다.

## 로컬에서 UI 확인 (데모)
```bash
npm run dev          # http://127.0.0.1:3200  비밀번호: demo (가짜 데이터)
npm test
```

## 서버 설치
```bash
git clone <repo> ~/projects/server-manager && cd ~/projects/server-manager
cp .env.example .env && vi .env        # SM_PASSWORD 설정 (12자 이상)
./scripts/deploy.sh                    # 유닛 설치 + 시작 (이후 업데이트도 같은 명령)
sudo loginctl enable-linger "$USER"    # 로그아웃/재부팅 후에도 유지 (최초 1회)
```

접속은 **SSH 터널**로 한다 (기본 바인딩이 127.0.0.1 이라 외부에 열리지 않는다).
```bash
ssh -p <ssh포트> -L 3200:localhost:3200 mjchoi@<서버>     # 그 상태에서 http://localhost:3200
```

## 서비스 목록 수정
`services.json` 을 고치고 `systemctl --user restart server-manager`.

| 키 | 설명 |
|---|---|
| `id`, `label` | 화면 식별자(소문자/숫자/-), 표시 이름 |
| `scope` | `user`(systemctl --user) 또는 `system` |
| `unit` | systemd 유닛 이름 |
| `port` | 있으면 TCP 점검 |
| `http` | 있으면 `127.0.0.1:port` 로 GET 점검 (경로, `/` 로 시작) |
| `logFile` | 있으면 이 파일의 마지막 줄을 로그로 표시 (없으면 journalctl) |

로그 파일에 쓰는 서비스(fconline, mayhemdex)는 `logFile` 을 지정해야 로그가 보인다.
`system` 유닛의 journal 을 읽으려면 실행 계정이 `systemd-journal`(또는 `wheel`/`adm`) 그룹이어야 한다.

## 보안
- 비밀번호 필수(없으면 시작 거부). HMAC 서명 쿠키(HttpOnly, SameSite=Strict, 12시간), 로그인 5회 실패 시 10분 잠금.
- 기본은 로컬 전용 바인딩. nginx 뒤에 둘 때는 `SM_TRUST_PROXY=1` 과 HTTPS 를 함께 쓴다.
- 서비스 이름은 `services.json` 의 값만 사용하고 셸을 거치지 않는다(execFile). 화면의 값·로그는 텍스트로만 렌더링한다.

## 구조
```
src/collect.js   systemctl/df/proc 수집, 상태 판정, 로그 읽기
src/server.js    HTTP, 인증, API(/api/overview, /api/logs)
src/auth.js      비밀번호·세션·로그인 제한
public/          대시보드 화면(바닐라 JS)
systemd/         유닛 템플릿        scripts/deploy.sh  배포
```
