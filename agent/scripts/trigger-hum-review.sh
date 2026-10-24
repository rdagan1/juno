#!/bin/bash
# trigger-hum-review.sh — cron entry point for the "hum-review" task in system/tasks.json.
# Dispatches via the ops-supervisor webhook (:9092). No jobs/hum-review.md —
# the ops agent runs it from the "Hum Review" section of agent/ops-agent/CLAUDE.md.
#
# Log: agent/logs/watchdog.log

: "${MERLIN_HOME:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export MERLIN_HOME
source "$(dirname "$0")/lib/portable.sh"
portable_path
source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/trigger-helpers.sh"

trigger_job hum-review '{"task": "HUM REVIEW", "source": "hum-review"}'
