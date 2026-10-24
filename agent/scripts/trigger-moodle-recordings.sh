#!/bin/bash
# trigger-moodle-recordings.sh — cron entry for the Moodle lecture-recordings job.
#
# Unlike most triggers, the heavy lifting runs HERE, outside any agent turn:
# `bin/moodle-recordings run` scans Moodle through the automation Chrome (CDP
# :9222), downloads new recordings, transcribes them locally (Hebrew Whisper)
# and writes an exam-aware digest via a one-shot `claude -p`. A 90-minute
# lecture can take 10-30 min to transcribe on CPU, which would trip the
# supervisor's per-turn watchdog if it ran inside the ops-agent.
#
# The ops-agent is dispatched (job "moodle-recordings") only when there is
# something for it to do: digests ready to deliver, recordings whose player
# the scanner could not handle (agent falls back to driving the browser),
# items that failed 3x, or a "log in to Moodle again" alert to send.
#
# Install via crontab (every 30 min, 07:00-23:59 local):
#   */30 7-23 * * * ${MERLIN_HOME}/agent/scripts/trigger-moodle-recordings.sh
#
# Log: agent/logs/watchdog.log (dispatch decisions) + agent/logs/moodle-recordings.log (pipeline stderr)

: "${MERLIN_HOME:=${HOME}/Dev/merlin}"
export MERLIN_HOME
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/trigger-helpers.sh"
TRIGGER_JOB="moodle-recordings"

PIPELINE_LOG="${MERLIN_HOME}/agent/logs/moodle-recordings.log"
mkdir -p "$(dirname "$PIPELINE_LOG")"

if [ ! -f "${MERLIN_HOME}/data/moodle-config.json" ]; then
  exit 0  # feature not configured on this host
fi

# Chrome down is chrome-cdp-watch.sh's alert to send, not ours. Skip quietly.
if ! curl -s --max-time 5 -o /dev/null http://localhost:9222/json/version; then
  trigger_log "skip: Chrome CDP :9222 unreachable"
  exit 0
fi

RESULT=$("${MERLIN_HOME}/bin/moodle-recordings" run --json 2>>"$PIPELINE_LOG")
CODE=$?
if [ "$CODE" = "6" ]; then
  trigger_log "skip: previous run still in progress"
  exit 0
fi
if [ -z "$RESULT" ]; then
  trigger_log "pipeline exited $CODE with no output (see $PIPELINE_LOG)"
  exit 1
fi

SUMMARY=$(echo "$RESULT" | jq -c '{new: (.new|length), processed: (.processed|length), ready: (.ready|length), no_media: (.no_media|length), failed: (.failed|length), auth_required, dispatch}' 2>/dev/null)
DISPATCH=$(echo "$RESULT" | jq -r '.dispatch // false' 2>/dev/null)

if [ "$DISPATCH" = "true" ]; then
  trigger_log "pipeline: $SUMMARY"
  trigger_job "$TRIGGER_JOB"
fi
exit 0
