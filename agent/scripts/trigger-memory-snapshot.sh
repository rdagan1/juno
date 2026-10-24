#!/bin/bash
# trigger-memory-snapshot.sh — cron entry point for the "memory-snapshot" task in system/tasks.json.
# Direct script — no webhook, no agent: runs bin/memory-snapshot and logs the result.
#
# Log: agent/logs/watchdog.log

: "${MERLIN_HOME:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export MERLIN_HOME
source "$(dirname "$0")/lib/portable.sh"
portable_path
source "$(dirname "$0")/lib/trigger-helpers.sh"

trigger_direct memory-snapshot "${MERLIN_HOME}/bin/memory-snapshot" --quiet
rc=$?
# Exit 2 = the memory dir isn't a git repo yet (no backup configured,
# docs/memory.md). That's a supported setup, not a failure.
[ $rc -eq 2 ] && exit 0
exit $rc
