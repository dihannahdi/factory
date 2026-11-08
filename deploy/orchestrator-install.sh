#!/usr/bin/env bash
# factory orchestrator: idempotent root install of the lanes, the sync, their units and directories.
# Re-running it is safe: files that did not change are reported as such.
#
#   sudo deploy/orchestrator-install.sh
#
# Expects (see the README): the unix user factory, the GitHub CLI at /opt/factory/bin/gh, a token
# in /etc/factory/gh-token, opencode installed for the factory user.
#
# Environment:
#   INSTALL_NO_START=1   enable the timers but do not start anything
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../orchestrator" && pwd)
BASE=/opt/factory
STATE=/var/lib/factory
OPS=/var/lib/factory-ops
UI=$OPS/ui
CTL=$OPS/ctl
LOGDIR=/var/log/factory
AGENT_HOME=/home/factory
UNITS=/etc/systemd/system
OPENCODE_CONF=/etc/opencode/opencode.json
DID=()

say() { echo "[install] $*"; }
did() { DID+=("$*"); say "$*"; }
die() { echo "[install] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
for c in jq flock systemd-run systemctl curl cmp install; do command -v "$c" >/dev/null || die "$c is required"; done
[[ -x $BASE/bin/gh ]] || die "$BASE/bin/gh (GitHub CLI) is missing"
[[ -s /etc/factory/gh-token ]] || die "/etc/factory/gh-token is missing"
id factory >/dev/null 2>&1 || die "unix user factory does not exist"

# /etc/factory/instance.env: which repository this instance works. Created from the template on the
# first run, which then stops so nothing starts against a placeholder.
ENVF=/etc/factory/instance.env
if [[ ! -f $ENVF ]]; then
  install -D -m 600 -o root -g root "$SRC/instances/factory.env.example" "$ENVF"
  echo "[install] created $ENVF. Set REPO=owner/name in it (and read the other settings), then run this again." >&2
  exit 3
fi
repo=$(sed -n 's/^REPO=//p' "$ENVF" | tail -n1 | tr -d '"'"'"' ')
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "$ENVF: REPO must be owner/name, not '$repo'"
[[ $repo != acme/* ]] || die "$ENVF: REPO is still the example ($repo)"
say "instance: $repo"
for f in lib.sh run.sh sync.sh sandbox.sh prune-target.sh factory-opencode opencode.json prompts/prompt.md prompts/triage.md prompts/review.md prompts/adopt.md\
         systemd/factory@.service systemd/factory@.timer systemd/factory.slice \
         systemd/factory-s1.slice systemd/factory-s2.slice systemd/factory-s3.slice \
         systemd/factory-sync.service systemd/factory-sync.timer; do
  [[ -f $SRC/$f ]] || die "missing $SRC/$f"
done
for f in lib.sh run.sh sync.sh sandbox.sh; do bash -n "$SRC/$f" || die "syntax error in $f: nothing was installed"; done
jq -e . "$SRC/opencode.json" >/dev/null || die "opencode.json is not valid JSON"

# put <mode> <src> <dst>: install when different, say so either way
put() {
  if [[ -f $3 ]] && cmp -s "$2" "$3"; then
    say "unchanged  $3"
  else
    install -D -m "$1" -o root -g root "$2" "$3"
    did "installed  $3"
  fi
}

# ---------------------------------------------------------------- group and directories
if ! getent group factory-ops >/dev/null; then groupadd --system factory-ops; did "created group factory-ops"; fi

install -d -m 700 -o root -g root "$STATE" "$STATE/sessions" "$STATE/blocked" "$STATE/claims" "$STATE/cooldown" "$STATE/locks"
install -d -m 750 -o root -g factory-ops "$OPS"
for d in "$UI" "$UI/slots" "$LOGDIR"; do install -d -o root -g factory-ops "$d"; chmod 2750 "$d"; done
install -d -o root -g factory-ops "$CTL"; chmod 2770 "$CTL"
# The console reads the logs through the group.
chgrp -R factory-ops "$LOGDIR" 2>/dev/null || true
chmod -R g+rX,o-rwx "$LOGDIR" 2>/dev/null || true
for k in 1 2 3; do install -d -m 750 -o factory -g factory "$AGENT_HOME/s$k"; done
say "directories and modes in place (state 700; ops 750; ui/logs 2750; ctl 2770; s1..s3 for the agent)"

# ---------------------------------------------------------------- files
install -d -m 755 "$BASE" "$BASE/prompts" "$BASE/gates"
put 755 "$SRC/lib.sh" "$BASE/lib.sh"
put 755 "$SRC/run.sh" "$BASE/run.sh"
put 755 "$SRC/sync.sh" "$BASE/sync.sh"
put 755 "$SRC/sandbox.sh" "$BASE/sandbox.sh"
put 755 "$SRC/prune-target.sh" "$BASE/prune-target.sh"
put 644 "$SRC/opencode.json" "$BASE/opencode.json"
# The lanes run opencode through this wrapper (it picks the Go account a turn was given).
put 755 "$SRC/factory-opencode" /usr/local/bin/factory-opencode
for p in prompt triage review adopt; do put 644 "$SRC/prompts/$p.md" "$BASE/prompts/$p.md"; done
for g in "$SRC"/gates/*.sh; do [[ -f $g ]] && put 755 "$g" "$BASE/gates/$(basename "$g")"; done

# /etc/opencode/opencode.json: the template, but the whitelist (and the default model) already on
# the box win: sync.sh owns them from now on, and the box must never be left with a template
# whitelist that names a model Zen no longer offers. Likewise enabled_providers and the opencode-go
# block (sync.sh adds them only while /etc/opencode/go.key is safe).
install -d -m 755 /etc/opencode
if [[ -f $OPENCODE_CONF ]] && jq -e . "$OPENCODE_CONF" >/dev/null 2>&1; then
  merged=$(jq -n --slurpfile t "$SRC/opencode.json" --slurpfile c "$OPENCODE_CONF" '
    $t[0]
    | if ($c[0].provider.opencode.whitelist // null) != null then .provider.opencode.whitelist = $c[0].provider.opencode.whitelist else . end
    | if ($c[0].enabled_providers // null) != null then .enabled_providers = $c[0].enabled_providers else . end
    | if ($c[0].provider["opencode-go"] // null) != null then .provider["opencode-go"] = $c[0].provider["opencode-go"] else . end
    | if ($c[0].model // null) != null then .model = $c[0].model else . end
    | if ($c[0].small_model // null) != null then .small_model = $c[0].small_model else . end')
else
  merged=$(cat "$SRC/opencode.json")
fi
tmp=$(mktemp "/etc/opencode/.opencode.json.XXXXXX")
printf '%s\n' "$merged" > "$tmp"; chmod 644 "$tmp"
if [[ -f $OPENCODE_CONF ]] && cmp -s "$tmp" "$OPENCODE_CONF"; then rm -f "$tmp"; say "unchanged  $OPENCODE_CONF"; else mv -f "$tmp" "$OPENCODE_CONF"; did "wrote      $OPENCODE_CONF (template + existing whitelist; snapshot=false, pkill/killall denied)"; fi

# ---------------------------------------------------------------- systemd units
for u in factory@.service factory@.timer factory.slice factory-s1.slice factory-s2.slice factory-s3.slice \
         factory-sync.service factory-sync.timer; do
  put 644 "$SRC/systemd/$u" "$UNITS/$u"
done
systemctl daemon-reload

# ---------------------------------------------------------------- default control.json
if [[ -e $CTL/control.json ]]; then
  say "ctl/control.json exists: left alone"
else
  jq -n --arg t "$(date -u +%FT%TZ)" '{v:1, agents:0, models:["opencode/deepseek-v4.1-flash-free"], model_mode:"ordered", paused:false, queue:[], skip:[], resume_ack:null, updated_at:$t}' > "$CTL/control.json"
  chown root:factory-ops "$CTL/control.json"; chmod 660 "$CTL/control.json"
  did "wrote default $CTL/control.json (1 agent, ordered, not paused)"
fi

# ---------------------------------------------------------------- timers
if [[ ${INSTALL_NO_START:-} == 1 ]]; then
  systemctl enable factory-sync.timer factory@1.timer >/dev/null
  did "enabled factory-sync.timer and factory@1.timer (not started: INSTALL_NO_START=1)"
else
  # models.json and github.json must exist before a lane looks for them.
  say "running one sync so ui/ is populated before lane 1 starts"
  systemctl start factory-sync.service || say "sync failed (journalctl -u factory-sync); continuing"
  systemctl enable --now factory-sync.timer factory@1.timer >/dev/null
  did "enabled and started factory-sync.timer and factory@1.timer"
fi
for k in 2 3; do
  say "factory@$k.timer: $(systemctl is-enabled "factory@$k.timer" 2>/dev/null || echo disabled) (installed; enable at rollout: systemctl enable --now factory@$k.timer)"
done

echo
echo "[install] done. What this run did:"
if (( ${#DID[@]} == 0 )); then echo "  nothing: everything was already in place"; else printf '  - %s\n' "${DID[@]}"; fi
echo "[install] next: run $BASE/gates/G1.sh .. G4.sh as root, then raise agents from 0 in the console."
