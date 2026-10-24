#!/bin/bash
# trigger-context-sync.sh — cron entry point for the "context-sync" task in system/tasks.json.
# Direct script — no webhook, no agent: runs bin/context-sync and logs the result.
#
# Log: agent/logs/watchdog.log

: "${MERLIN_HOME:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export MERLIN_HOME
source "$(dirname "$0")/lib/portable.sh"
portable_path
source "$(dirname "$0")/lib/trigger-helpers.sh"

trigger_direct context-sync "${MERLIN_HOME}/bin/context-sync" all
