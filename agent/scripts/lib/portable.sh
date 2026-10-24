#!/bin/bash
# portable.sh — macOS/Linux shims for agent/scripts/*.sh.
#
# The scripts were written against BSD userland + launchd. Source this file and
# use the helpers below instead of calling stat/date/launchctl/brew directly so
# the same script runs on macOS and Linux (GNU coreutils + systemd --user).
#
# Overridable:
#   MERLIN_LAUNCHD_LABEL   launchd label of the process-manager agent (macOS)
#   MERLIN_SYSTEMD_UNIT    systemd --user unit of the process-manager (Linux)

MERLIN_OS="$(uname -s)"
: "${MERLIN_LAUNCHD_LABEL:=ai.claude.session}"
: "${MERLIN_SYSTEMD_UNIT:=merlin.service}"

is_macos() { [ "$MERLIN_OS" = "Darwin" ]; }

# Standard PATH for cron-launched scripts: claude installs to ~/.local/bin,
# Homebrew to /opt/homebrew (Apple Silicon) or /usr/local (Intel). Missing
# entries are harmless.
portable_path() {
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
}

# file_mtime <path> — modification time, epoch seconds.
file_mtime() {
  if is_macos; then stat -f %m "$1"; else stat -c %Y "$1"; fi
}

# file_age <path> — seconds since last modification.
file_age() {
  echo $(( $(date +%s) - $(file_mtime "$1") ))
}

# iso_utc_to_epoch <YYYY-MM-DDTHH:MM:SSZ> — prints epoch seconds, or nothing
# (non-zero exit) when the timestamp doesn't parse.
iso_utc_to_epoch() {
  if is_macos; then
    date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null
  else
    date -u -d "$1" +%s 2>/dev/null
  fi
}

# date_ago <N><unit> [date args...] — `date` shifted N units into the past.
# Units match BSD `date -v`: d (days), H (hours), M (minutes).
#   date_ago 1d '+%Y-%m-%d'
#   date_ago 4H -Iseconds
date_ago() {
  local spec="$1"; shift
  if is_macos; then
    date -v-"$spec" "$@"
  else
    local n="${spec%?}" unit
    case "${spec: -1}" in
      d) unit=day ;;
      H) unit=hour ;;
      M) unit=minute ;;
      *) echo "date_ago: unsupported unit in '$spec'" >&2; return 2 ;;
    esac
    date -d "-$n $unit" "$@"
  fi
}

# restart_process_manager — ask init to restart the whole Merlin tree.
restart_process_manager() {
  if is_macos; then
    launchctl kickstart -k "gui/$(id -u)/$MERLIN_LAUNCHD_LABEL"
  else
    systemctl --user restart "$MERLIN_SYSTEMD_UNIT"
  fi
}

# restart_ollama — best effort, never sudo. macOS: Homebrew service. Linux: a
# user unit if one exists, else the system unit (only succeeds when polkit
# lets this user restart it without a password).
restart_ollama() {
  if is_macos; then
    command -v brew >/dev/null 2>&1 || { echo "brew not found" >&2; return 1; }
    brew services restart ollama
  elif systemctl --user cat ollama.service >/dev/null 2>&1; then
    systemctl --user restart ollama.service
  else
    systemctl --no-ask-password restart ollama.service
  fi
}

# restart_user_service <launchd-label> <systemd-unit> — restart a helper agent.
restart_user_service() {
  if is_macos; then
    launchctl kickstart -k "gui/$(id -u)/$1"
  else
    systemctl --user restart "$2"
  fi
}
