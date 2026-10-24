#!/bin/bash
# heartbeat-sender.sh — post a system-health snapshot every 2 minutes.
#
# Runs from the merlin-heartbeat.timer systemd unit (Linux) or the
# com.example.merlin-heartbeat LaunchAgent (macOS) — see system/services.json.
#
# Always appends one JSON line to logs/heartbeat.log (`merlin status` reads its
# age). Also sends the snapshot to:
#   MERLIN_HEARTBEAT_URL      — POST JSON to any endpoint, if set; else
#   MERLIN_FIREBASE_PROJECT   — PUT to Firebase RTDB at
#                               /merlin/heartbeat/<host>.json, if set.
# A remote failure goes to logs/heartbeat.err.log; it never fails the timer,
# so an off-box dashboard showing a stale heartbeat is the alert.

set -uo pipefail
: "${MERLIN_HOME:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "$(dirname "$0")/lib/portable.sh"
portable_path
if [ -f "$MERLIN_HOME/.env" ]; then
  # Only the two vars this script reads; values go through the same parser as the kernel.
  eval "$(node -e '
    const { loadEnv } = require(process.argv[1]); loadEnv(process.argv[2]);
    for (const k of ["MERLIN_HEARTBEAT_URL", "MERLIN_FIREBASE_PROJECT"])
      if (process.env[k]) console.log(`${k}=${JSON.stringify(process.env[k])}`);
  ' "$MERLIN_HOME/lib/load-env.js" "$MERLIN_HOME/.env")"
fi

LOG_DIR="$MERLIN_HOME/logs"
mkdir -p "$LOG_DIR"
HOST="${MERLIN_HOST:-$(hostname -s)}"

probe() { curl -sf --max-time 3 "http://127.0.0.1:$1/health" 2>/dev/null || echo null; }

SNAPSHOT=$(jq -cn \
  --arg host "$HOST" \
  --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --arg os "$MERLIN_OS" \
  --argjson pm "$(probe 9095)" \
  --argjson ops "$(probe 9093)" \
  --argjson chat "$(probe 9094)" \
  '{host:$host, ts:$ts, os:$os,
    process_manager: (if $pm then {pid:$pm.pid, uptime_ms:$pm.uptimeMs,
                                   children:[$pm.children[] | {name, alive, restarts}]} else null end),
    ops:  (if $ops  then {child_alive:$ops.childAlive,  queue:$ops.queueDepth}  else null end),
    chat: (if $chat then {child_alive:$chat.childAlive, queue:$chat.queueDepth} else null end)}' 2>>"$LOG_DIR/heartbeat.err.log")

[ -n "$SNAPSHOT" ] || { echo "$(date '+%F %T') snapshot build failed (jq missing?)" >> "$LOG_DIR/heartbeat.err.log"; exit 0; }
echo "$SNAPSHOT" >> "$LOG_DIR/heartbeat.log"

send() {
  local method="$1" url="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "$method" \
    -H 'Content-Type: application/json' -d "$SNAPSHOT" "$url")
  case "$code" in
    2*) ;;
    *) echo "$(date '+%F %T') $method $url → HTTP $code" >> "$LOG_DIR/heartbeat.err.log" ;;
  esac
}

if [ -n "${MERLIN_HEARTBEAT_URL:-}" ]; then
  send POST "$MERLIN_HEARTBEAT_URL"
elif [ -n "${MERLIN_FIREBASE_PROJECT:-}" ]; then
  send PUT "https://${MERLIN_FIREBASE_PROJECT}-default-rtdb.firebaseio.com/merlin/heartbeat/${HOST}.json"
fi
exit 0
