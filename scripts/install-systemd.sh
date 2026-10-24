#!/usr/bin/env bash
# install-systemd.sh — install Merlin as a systemd --user service (Linux).
#
# Renders system/systemd/merlin.service into ~/.config/systemd/user/, enables
# lingering so it runs without an open login session, and starts it. Idempotent:
# re-run after moving the checkout or changing Node.
#
#   ./scripts/install-systemd.sh              # install + enable + start
#   ./scripts/install-systemd.sh --no-start   # install + enable only
#   ./scripts/install-systemd.sh --uninstall  # stop, disable, remove the unit

set -euo pipefail

MERLIN_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=merlin.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TEMPLATE="$MERLIN_HOME/system/systemd/$UNIT"

die() { echo "✘ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }

[[ "$(uname -s)" == "Linux" ]] || die "systemd install is Linux-only. On macOS use the LaunchAgent in docs/installer.md."
command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this host doesn't run systemd."
systemctl --user show-environment >/dev/null 2>&1 \
  || die "no systemd user manager reachable. Log in via a real session (ssh, not su/sudo) or set XDG_RUNTIME_DIR=/run/user/$(id -u)."

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_DIR/$UNIT"
  systemctl --user daemon-reload
  ok "removed $UNIT (checkout at $MERLIN_HOME untouched)"
  exit 0
fi

NODE="$(command -v node)" || die "node not on PATH — install Node 22.5+ first."
command -v claude >/dev/null 2>&1 || [[ -x "$HOME/.local/bin/claude" ]] \
  || echo "! claude CLI not found — agents won't start until it's installed and logged in."

# PATH for the service: wherever node lives now, plus the usual tool dirs
# (claude installs to ~/.local/bin; hookdeck/gog/ollama often in /usr/local/bin).
SVC_PATH="$(dirname "$NODE"):$HOME/.local/bin:$MERLIN_HOME/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$UNIT_DIR" "$MERLIN_HOME/agent/logs"
sed -e "s|@MERLIN_HOME@|$MERLIN_HOME|g" \
    -e "s|@NODE@|$NODE|g" \
    -e "s|@PATH@|$SVC_PATH|g" \
    "$TEMPLATE" > "$UNIT_DIR/$UNIT"
ok "wrote $UNIT_DIR/$UNIT"

if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  if loginctl enable-linger "$(id -un)" 2>/dev/null; then
    ok "enabled lingering for $(id -un)"
  else
    echo "! could not enable lingering. Without it the service stops when you log out. Run:"
    echo "    sudo loginctl enable-linger $(id -un)"
  fi
fi

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null
ok "enabled $UNIT"

if [[ "${1:-}" != "--no-start" ]]; then
  systemctl --user restart "$UNIT"
  ok "started $UNIT — check with: systemctl --user status $UNIT  (or: ./bin/merlin status)"
fi
