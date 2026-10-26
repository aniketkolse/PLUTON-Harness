#!/usr/bin/env bash
# End-to-end self-test for landlock-run. Run on Linux (or WSL) as any user that
# can create user namespaces. No Docker involved.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/landlock-run-linux-x64"
ROOT="${PLUTON_HELPER_TEST_ROOT:-$HOME/pluton-landlock-selftest}"
REQUEST="$ROOT/request.json"
READY="$ROOT/ready.json"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$HELPER" ] || fail "helper not built: $HELPER"

rm -rf "$ROOT"
mkdir -p "$ROOT/proj" "$ROOT/work" "$ROOT/tmp" "$ROOT/outside"
chmod 700 "$ROOT"
printf 'hello\n' > "$ROOT/proj/in.txt"
printf 'topsecret\n' > "$ROOT/outside/secret"
printf 'work\n' > "$ROOT/work/w.txt"

request() {
  local mode="$1" network="$2" bridge_json="$3" private_tmp="$4" write_roots="$5" argv_json="$6"
  cat > "$REQUEST" <<EOF
{
  "helper_abi": 1,
  "mode": "$mode",
  "network": "$network",
  "cwd": "$ROOT/work",
  "argv": $argv_json,
  "env": {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "$ROOT/tmp",
    "TMPDIR": "$ROOT/tmp",
    "LANG": "C.UTF-8",
    "SELFTEST_ROOT": "$ROOT"
  },
  "read_roots": ["$ROOT/proj", "$ROOT/work", "$ROOT/tmp", "/usr", "/bin", "/lib", "/lib64", "/etc"],
  "write_roots": $write_roots,
  "exec_roots": ["/usr", "/bin"],
  "tmp_dir": "$ROOT/tmp",
  "private_tmp": $private_tmp,
  "bridge": $bridge_json,
  "session_id": "selftest"
}
EOF
}

run_helper() {
  local rc=0
  "$HELPER" run "$REQUEST" 3>"$READY" || rc=$?
  if ! grep -q '"ready":true' "$READY"; then
    echo "ready file:" >&2
    cat "$READY" >&2 || true
    fail "helper did not report ready (exit $rc)"
  fi
  return "$rc"
}

echo "== probe =="
PROBE="$("$HELPER" --probe)"
echo "$PROBE"
case "$PROBE" in
  *'"landlockAbi":'*) ;;
  *) fail "probe has no Landlock ABI" ;;
esac

cat > "$ROOT/work/script-ro.sh" <<'EOF'
set -u
fail() { echo "FAIL: $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || fail "not uid 0 in the user namespace"
[ "$(cat /proc/1/comm)" = "sh" ] || fail "engine is not PID 1"
MAXPID="$(ls /proc | grep -E '^[0-9]+$' | sort -n | tail -1)"
[ "${MAXPID:-0}" -lt 100 ] || fail "host PIDs are visible (max $MAXPID)"
[ "$(cat "$SELFTEST_ROOT/proj/in.txt")" = "hello" ] || fail "read inside project denied"
if [ "$(cat "$SELFTEST_ROOT/outside/secret" 2>/dev/null)" = "topsecret" ]; then fail "outside read allowed"; fi
if (echo x > "$SELFTEST_ROOT/proj/out.txt") 2>/dev/null; then fail "read-only project write allowed"; fi
echo ok > "$SELFTEST_ROOT/tmp/t.txt" || fail "session tmp not writable"
[ -s "$SELFTEST_ROOT/tmp/t.txt" ] || fail "session tmp write was lost"
[ "$(cat "$SELFTEST_ROOT/work/w.txt")" = "work" ] || fail "work read denied"
if env | grep -q '^PLUTON_SECRET='; then fail "host environment leaked"; fi
echo RO_OK
EOF

request "read-only" "restricted" "null" "false" "[\"$ROOT/tmp\"]" "[\"/bin/sh\", \"$ROOT/work/script-ro.sh\"]"
echo "== read-only + restricted =="
run_helper
[ -f "$ROOT/tmp/t.txt" ] && fail "session tmp leaked to the host filesystem"
[ ! -f "$ROOT/proj/out.txt" ] || fail "read-only project was written"

cat > "$ROOT/work/script-rw.sh" <<'EOF'
set -u
fail() { echo "FAIL: $*" >&2; exit 1; }
echo ok > "$SELFTEST_ROOT/work/new.txt" || fail "workspace write denied"
if (echo x > "$SELFTEST_ROOT/proj/out.txt") 2>/dev/null; then fail "write outside workspace allowed"; fi
[ "$(cat "$SELFTEST_ROOT/outside/secret" 2>/dev/null)" = "" ] || fail "outside read allowed"
echo RW_OK
EOF

request "workspace-write" "open" "null" "false" "[\"$ROOT/work\", \"$ROOT/tmp\"]" "[\"/bin/sh\", \"$ROOT/work/script-rw.sh\"]"
echo "== workspace-write + open =="
run_helper
[ -f "$ROOT/work/new.txt" ] || fail "workspace-write did not create the file"

echo "== restricted network + loopback proxy =="
python3 - "$ROOT/bridge.sock" <<'PY' &
import os
import socket
import sys

path = sys.argv[1]
try:
    os.unlink(path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path)
server.listen(8)
while True:
    conn, _ = server.accept()
    try:
        conn.recv(16)
        conn.sendall(b"PONG")
    finally:
        conn.close()
PY
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -S "$ROOT/bridge.sock" ] && break; sleep 0.1; done

cat > "$ROOT/work/script-net.sh" <<'EOF'
set -u
fail() { echo "FAIL: $*" >&2; exit 1; }
python3 - <<'PY'
import socket
s = socket.socket()
s.settimeout(1.0)
rc = s.connect_ex(("1.1.1.1", 80))
print("EXT_RC", rc)
if rc == 0:
    raise SystemExit("external network reachable")
PY
python3 - <<'PY'
import socket
s = socket.socket()
s.settimeout(2.0)
s.connect(("127.0.0.1", 43871))
s.sendall(b"ping")
reply = s.recv(16)
print("PROXY_REPLY", reply.decode())
if reply != b"PONG":
    raise SystemExit("proxy did not forward to the host bridge")
PY
echo NET_OK
EOF

request "workspace-write" "restricted" "{\"unix_path\": \"$ROOT/bridge.sock\", \"port\": 43871}" "false" "[\"$ROOT/work\", \"$ROOT/tmp\"]" "[\"/bin/sh\", \"$ROOT/work/script-net.sh\"]"
run_helper
grep -q '"bridgePort":43871' "$READY" || fail "ready did not report the bridge port"

echo "== network none =="
cat > "$ROOT/work/script-none.sh" <<'EOF'
set -u
fail() { echo "FAIL: $*" >&2; exit 1; }
if /usr/sbin/ip -o addr show lo | grep -q 127.0.0.1; then fail "loopback is up under network none"; fi
python3 - <<'PY'
import socket
s = socket.socket()
s.settimeout(1.0)
rc = s.connect_ex(("127.0.0.1", 1))
print("LOOPBACK_RC", rc)
if rc == 0:
    raise SystemExit("loopback reachable under network none")
PY
echo NONE_OK
EOF
request "read-only" "none" "null" "false" "[\"$ROOT/tmp\"]" "[\"/bin/sh\", \"$ROOT/work/script-none.sh\"]"
run_helper

echo "== private /tmp =="
touch /tmp/pluton-host-marker
cat > "$ROOT/work/script-tmp.sh" <<'EOF'
set -u
fail() { echo "FAIL: $*" >&2; exit 1; }
[ -e /tmp/pluton-host-marker ] && fail "host /tmp leaked into private tmp"
echo x > /tmp/inside.txt || fail "private /tmp not writable"
echo TMP_OK
EOF
request "workspace-write" "open" "null" "true" "[\"$ROOT/work\", \"$ROOT/tmp\"]" "[\"/bin/sh\", \"$ROOT/work/script-tmp.sh\"]"
run_helper
rm -f /tmp/pluton-host-marker

echo "== exit code and environment =="
request "workspace-write" "open" "null" "false" "[\"$ROOT/work\", \"$ROOT/tmp\"]" "[\"/bin/sh\", \"-c\", \"exit 7\"]"
set +e
PLUTON_SECRET=leak "$HELPER" run "$REQUEST" 3>"$READY"
RC=$?
set -e
[ "$RC" = "7" ] || fail "helper did not preserve the engine exit code (got $RC)"

echo "ALL LANDLOCK-RUN SELFTESTS PASSED"
