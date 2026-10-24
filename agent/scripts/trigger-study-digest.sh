#!/bin/bash
# trigger-study-digest.sh — dispatch the evening study digest (jobs/study-digest.md).
#
# Install via crontab (host timezone; 20:00 = evening review before tomorrow):
#   0 20 * * * ${MERLIN_HOME}/agent/scripts/trigger-study-digest.sh
#
# Registered in system/tasks.json as "study-digest".

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${MERLIN_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)}"
export MERLIN_HOME
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

source "$SCRIPT_DIR/lib/webhook-auth.sh"
source "$SCRIPT_DIR/lib/trigger-helpers.sh"

trigger_job study-digest
