#!/bin/bash
# trigger-morning-digest.sh — cron entry point for the "morning-digest" task in system/tasks.json.
# Dispatches the job via the ops-supervisor webhook (:9092); the playbook is
# agent/ops-agent/jobs/morning-digest.md.
#
# Log: agent/logs/watchdog.log

: "${MERLIN_HOME:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export MERLIN_HOME
source "$(dirname "$0")/lib/portable.sh"
portable_path
source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/trigger-helpers.sh"

trigger_job morning-digest
