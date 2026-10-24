# Installer — 24/7 deployment

The quickstart runs Merlin in the foreground of a terminal. For an always-on agent that survives reboots, install it as a system service.

## macOS — launchd

A LaunchAgent plist lives in `~/Library/LaunchAgents/` and is owned by your user. Process-manager runs in your GUI session (required because some agent tools depend on UI permissions — Apple Notes, iMessage, AppleScript, Chrome automation).

### 1. Create the plist

Save the following as `~/Library/LaunchAgents/ai.merlin.session.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.merlin.session</string>

    <key>ProgramArguments</key>
    <array>
        <string>node</string>
        <string>YOUR_MERLIN_HOME/agent/bin/process-manager.mjs</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>MERLIN_HOME</key>
        <string>YOUR_MERLIN_HOME</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>YOUR_MERLIN_HOME/agent/logs/launchagent.log</string>

    <key>StandardErrorPath</key>
    <string>YOUR_MERLIN_HOME/agent/logs/launchagent.err.log</string>
</dict>
</plist>
```

Replace `YOUR_MERLIN_HOME` with your absolute path (e.g. `/Users/alice/Dev/merlin`). The `node` path should match `which node`.

### 2. Pre-flight host setup

Some macOS settings make a real difference for an always-on host:

- **Auto-login** — System Settings → Users & Groups. The LaunchAgent needs a GUI session to use UI-permission tools.
- **Disable sleep**: `sudo pmset -a sleep 0 disksleep 0 displaysleep 180`. (Display can sleep; processes keep running.)
- **FileVault**: off, if you want auto-restart-after-power-cycle. (FileVault prompts for credentials at boot, blocking the GUI session.)
- **Hostname**: pick a stable one — `sudo scutil --set HostName myhost`. The agent's identity in launchd labels uses this.

### 3. Load and start

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.merlin.session.plist
launchctl kickstart gui/$(id -u)/ai.merlin.session
```

Verify it's running:

```bash
launchctl print gui/$(id -u)/ai.merlin.session | head -20
```

Look for `state = running` and a `pid = <number>`. Then check from the user side:

```bash
./bin/merlin status
```

### Stop / restart

```bash
# Stop just the inner claude child (supervisor stays up)
curl -X POST http://localhost:9093/restart   # ops
curl -X POST http://localhost:9094/restart   # chat

# Restart the whole tree
launchctl kickstart -k gui/$(id -u)/ai.merlin.session
```

### Heartbeat + resilience-test (optional)

If you want the periodic Firebase RTDB heartbeat or scheduled crash-recovery kill-tests, set up additional LaunchAgents. See `system/services.json` for the canonical list of labels and their corresponding scripts.

## Linux — systemd (user unit)

A systemd-user service runs as your user without root. Any 64-bit distro with systemd works (tested targets: Ubuntu 22.04+, Debian 12).

### 1. Pre-flight host setup

- **Packages**: Node 22.5+, `curl`, `jq`, `python3`, `cron` (Debian/Ubuntu: `apt install curl jq python3 cron`), then `./scripts/bootstrap.sh`.
- **Claude Code**: `npm install -g @anthropic-ai/claude-code` (or the native installer, which puts `claude` in `~/.local/bin`), then run `claude` once over SSH to log in. On a headless VM, the login flow prints a URL to open on another machine.
- **Ollama**: install per Ollama's Linux docs (it registers a system `ollama.service`), then `ollama pull gemma3:4b && ollama pull nomic-embed-text`. The watchdog restarts it only if your user may do so without a password (a user unit, or a polkit rule) — it never uses sudo.
- **Tailscale or equivalent**: if you want to reach the host's wiki UI at `:9096` from elsewhere on your network.
- **Config**: `./bin/merlin init` (writes `.env`, the webhook token, and seeds `data/` from `examples/`). Set `MERLIN_WEATHER_LAT` / `MERLIN_WEATHER_LON` in `.env` for weather — on Linux `bin/weather-now` uses Open-Meteo (no key).
- **Gmail push (optional)**: `npm install -g hookdeck-cli` — process-manager runs Hookdeck only when it's on PATH. See [`integrations/gmail.md`](integrations/gmail.md).

What doesn't exist on Linux: Apple Notes / iMessage sources (`context-sync` skips them), `ioreg` idle time in `merlin context`, and the companion-app builds. Everything else — supervisors, channels, jobs, watchdog, memory, wiki — is the same code on both platforms.

### 2. Install the units

```bash
./scripts/install-systemd.sh
```

This renders `system/systemd/merlin.service` plus `merlin-heartbeat.{service,timer}` into `~/.config/systemd/user/` with your checkout path and current `node`, enables lingering (`loginctl enable-linger`, so the service runs with nobody logged in — if that needs root it prints the `sudo` command for you), enables + starts them, and installs the scheduled-jobs crontab block (`merlin cron install`, step 4). Re-run it after moving the checkout or switching Node versions. The units deliberately have no `EnvironmentFile=`: process-manager loads `.env` itself.

Run it from a real login session (SSH), not `su`/`sudo -u`, so `systemctl --user` can reach your user manager.

### 3. Check

```bash
systemctl --user status merlin.service
./bin/merlin status
tail -f agent/logs/claude-launchagent.err.log   # process-manager's own log
```

### 4. Scheduled jobs + watchdog

Cron runs the trigger scripts listed in `system/tasks.json`, plus the watchdog (every 5 min), log rotation (03:00) and — once Gmail is set up — the daily Gmail watch renewal. `install-systemd.sh` already did this; to regenerate after editing `tasks.json` or setting up Gmail:

```bash
./bin/merlin cron install      # (re)writes one marked block; your own crontab lines are untouched
./bin/merlin cron              # what's installed, mapped to tasks.json
./bin/merlin doctor            # flags tasks.json ↔ crontab drift
./bin/merlin cron uninstall    # removes only the merlin block
```

The block pins `MERLIN_HOME` and a `PATH` that includes your current `node`, so cron's minimal environment is enough. Works on macOS too.

### Stop / restart

```bash
systemctl --user restart merlin.service     # full restart (process-manager + all children)
./bin/merlin restart ops                     # one supervisor (process-manager respawns it)
curl -X POST http://localhost:9093/restart   # inner claude child only (fastest)
```

## Verifying it's working

After the service is running, dispatch a test job and watch it execute end-to-end:

```bash
./bin/merlin dispatch morning-digest
./bin/merlin tail ops
```

You should see the agent process the dispatch and either email the digest (if SMTP is wired) or just log the output. If the dispatch fails with `connection refused`, the supervisor isn't listening on :9092 — check that process-manager started cleanly.

## Updating

```bash
cd ~/Dev/merlin
git pull
./scripts/bootstrap.sh        # re-runs npm install + creates any new dirs

# macOS
launchctl kickstart -k gui/$(id -u)/ai.merlin.session

# Linux
systemctl --user restart merlin.service
```

For playbook-only changes (`agent/ops-agent/jobs/*.md`), no restart is needed — the supervisor reads the playbook fresh at each dispatch.

## Uninstall

### macOS
```bash
launchctl bootout gui/$(id -u)/ai.merlin.session
rm ~/Library/LaunchAgents/ai.merlin.session.plist
```

### Linux
```bash
./scripts/install-systemd.sh --uninstall
```

Both leave the `~/Dev/merlin` clone untouched. Delete that directory separately to fully remove.
