#!/usr/bin/env bash
# 대시보드가 system 유닛(mome, 가계부, valkey)을 제어할 수 있도록 sudoers 규칙을 설치한다.
#   ./scripts/install-sudoers.sh
# user 유닛(fconline, mytree 등)은 sudo 가 필요 없으므로 이 스크립트와 무관하다.
# services.json 의 actions 를 바꿨다면 다시 실행해서 규칙을 갱신한다.
set -euo pipefail

cd "$(dirname "$0")/.."
TARGET=/etc/sudoers.d/server-manager

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
node scripts/gen-sudoers.js "$USER" > "$TMP"

echo "---- 설치할 규칙 ($TARGET)"
cat "$TMP"
echo "----"

# 설치 전에 문법 검사: 잘못된 sudoers 파일은 sudo 전체를 못 쓰게 만들 수 있다.
sudo visudo -cf "$TMP" >/dev/null || { echo "sudoers 문법 오류 — 설치하지 않았습니다."; exit 1; }
sudo install -m 440 -o root -g root "$TMP" "$TARGET"
echo "설치 완료. 확인: sudo -l | grep systemctl"
