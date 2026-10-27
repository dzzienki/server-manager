#!/usr/bin/env bash
# server-manager 를 서버에 배포/재시작한다.
#
#   ./scripts/deploy.sh            git pull 후 유닛 설치·재시작
#   ./scripts/deploy.sh --no-pull  pull 없이 현재 체크아웃 그대로 재시작
#
# 의존성이 없어 npm install/빌드는 필요 없다. systemd 사용자 유닛(server-manager)으로 돈다.
#   직접 제어:  systemctl --user {status|restart|stop} server-manager   /   journalctl --user -u server-manager -f
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="$(pwd -P)"
UNIT_NAME="server-manager"
UNIT_TPL="$DIR/systemd/$UNIT_NAME.service"
UNIT_DST="$HOME/.config/systemd/user/$UNIT_NAME.service"
PULL=1
[ "${1:-}" = "--no-pull" ] && PULL=0

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

step "Checking environment"
command -v node >/dev/null || fail "node is not installed"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node.js 22+ is required (found $(node -v))"
command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 \
  || fail "systemctl --user is not available (log in via SSH/console so the user session exists)"
[ -f .env ] || fail ".env is missing. Run: cp .env.example .env  and set SM_PASSWORD (12+ chars)"
PW_LEN="$(grep -E '^SM_PASSWORD=' .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' | wc -c)"
[ "$PW_LEN" -ge 2 ] || fail "SM_PASSWORD is empty in .env"
chmod 600 .env

if [ "$PULL" -eq 1 ]; then
  step "Pulling latest code"
  git pull --ff-only
fi

step "Running tests"
node --test >/dev/null || fail "tests failed — run 'npm test' to see why"

step "Installing systemd user unit"
mkdir -p "$(dirname "$UNIT_DST")"
TMP_UNIT="$(mktemp)"
sed -e "s|@DIR@|$DIR|g" -e "s|@NODE_BIN@|$(dirname "$(command -v node)")|g" "$UNIT_TPL" > "$TMP_UNIT"
if ! cmp -s "$TMP_UNIT" "$UNIT_DST"; then
  install -m 644 "$TMP_UNIT" "$UNIT_DST"
  systemctl --user daemon-reload
  echo "installed: $UNIT_DST"
fi
rm -f "$TMP_UNIT"
systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "WARN: to keep it running after logout/reboot, run once: sudo loginctl enable-linger $USER"
fi

step "Restarting"
systemctl --user restart "$UNIT_NAME"
sleep 2
systemctl --user is-active --quiet "$UNIT_NAME" || {
  systemctl --user status "$UNIT_NAME" --no-pager -n 20 || true
  fail "$UNIT_NAME failed to start"
}
systemctl --user status "$UNIT_NAME" --no-pager -n 5 || true

PORT="$(grep -E '^SM_PORT=' .env | tail -n1 | cut -d= -f2- || true)"
step "Done — http://127.0.0.1:${PORT:-3200}  (SSH 터널: ssh -p <ssh포트> -L ${PORT:-3200}:localhost:${PORT:-3200} <서버>)"
