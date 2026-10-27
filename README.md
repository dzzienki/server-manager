# server-manager

서버 1대에서 도는 서비스(systemd 유닛)의 상태·메모리·CPU·로그를 한 화면에서 보는 가벼운 대시보드.
의존성 없음(Node 내장 모듈만), 단일 프로세스, 힙 64MB 제한.

**모니터링 + 제어(시작/중지/재시작).** 제어는 `services.json` 의 `actions` 에 적어 준 서비스·동작만 가능하다(기본은 읽기 전용).

## 보여주는 것
- 서버: CPU, 메모리/스왑, 디스크, 부하, 가동 시간 (최근 1시간 추이는 메모리에만 보관)
- 서비스별: 상태(정상/경고/중지), 메모리, CPU, 가동 시간, 재시작 횟수, 포트·HTTP 점검과 **응답 시간 추이**, 로그 보기
- **HTTPS 인증서 만료일**(`SM_TLS_HOST` 를 설정하면 타일로 표시. 14일 미만 경고, 7일 미만 위험)
- **최근 기록**: 로그인 성공/실패(접속 IP 포함)와 서비스 제어 결과. 메모리에만 보관(재시작하면 초기화)하며 영구 기록은 journal 의 `[login]` `[action]` 줄
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
| `actions` | 화면에서 허용할 제어 동작 `["start","stop","restart"]` 중 일부. 없으면 읽기 전용 |

로그 파일에 쓰는 서비스(fconline, mayhemdex)는 `logFile` 을 지정해야 로그가 보인다.
`system` 유닛의 journal 을 읽으려면 실행 계정이 `systemd-journal`(또는 `wheel`/`adm`) 그룹이어야 한다.

## 서비스 제어 (시작/중지/재시작 버튼)
서비스 행의 버튼을 누르면 확인 창이 뜨고, 확인하면 실행된다. 켜져 있으면 [재시작][중지], 꺼져 있으면 [시작]이 보인다.

- **user 유닛**(fconline, mytree, mayhemdex 등): 추가 설정 없이 `systemctl --user` 로 실행된다.
- **system 유닛**(mome, 가계부, valkey): `sudo` 가 필요하다. 서버에서 **한 번** 실행한다.
  ```bash
  ./scripts/install-sudoers.sh     # services.json 의 actions 로 sudoers 규칙을 만들고 문법 검사 후 설치
  ```
  규칙은 `/usr/bin/systemctl restart mome-backend.service` 처럼 **정확히 그 명령만** 허용한다(와일드카드 없음).
  `actions` 를 바꾸면 이 스크립트를 다시 실행한다. 설치 전 규칙은 `node scripts/gen-sudoers.js <사용자>` 로 미리 볼 수 있다.
- 기본으로 제어를 막아 둔 것: `nginx`(설정 오류 시 사이트 전체가 내려감), `server-manager`(자기 자신).
- 빌드/배포는 하지 않는다. 코드 반영은 각 프로젝트의 배포 스크립트로 하고, 여기서는 프로세스만 다룬다.
- 모든 시도는 접속자 IP 와 함께 journal 에 남는다: `journalctl --user -u server-manager | grep '\[action\]'`

## 보안
- 비밀번호 필수(없으면 시작 거부). HMAC 서명 쿠키(HttpOnly, SameSite=Strict, 12시간), 로그인 5회 실패 시 10분 잠금.
- 기본은 로컬 전용 바인딩. nginx 뒤에 둘 때는 `SM_TRUST_PROXY=1` 과 HTTPS 를 함께 쓴다.
- 제어 API 는 로그인 필수이며, 다른 출처(Origin)의 요청·JSON 이 아닌 요청을 거절한다(CSRF 방어). 같은 서비스에 동작이 겹치면 거절한다.
- **제어 기능이 있으므로 인터넷에 열 때는 비밀번호를 길게 쓰고, 가능하면 nginx 에서 IP 를 제한(`allow`/`deny`)하는 것을 권장한다.**
- 서비스 이름은 `services.json` 의 값만 사용하고 셸을 거치지 않는다(execFile). 화면의 값·로그는 텍스트로만 렌더링한다.

## 구조
```
src/collect.js   systemctl/df/proc 수집, 상태 판정, 로그 읽기
src/server.js    HTTP, 인증, API(/api/overview, /api/logs)
src/auth.js      비밀번호·세션·로그인 제한
public/          대시보드 화면(바닐라 JS)
systemd/         유닛 템플릿        scripts/deploy.sh  배포
```
