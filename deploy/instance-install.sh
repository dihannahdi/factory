#!/usr/bin/env bash
# Second orchestrator instance (the "blog" example: another repo on the same box): idempotent root
# install of its units, EnvironmentFile, directories and an initial control.json. It reuses the code,
# the prompts, the sandbox user and the factory-ops group that deploy/orchestrator-install.sh already
# put in place. An instance that wants its own prompts sets PROMPTS=<dir> in its env file.
#
#   sudo deploy/instance-install.sh [instance]        (instance defaults to blog)
#
# What it does NOT do: enable or start any unit, create a token, clone the mirror (the instance's first
# sync does, with its own token), touch a unit, file, directory or setting of the first instance, or replace an
# /etc/blog-agent/instance.env that is already there (an operator edits that one; a differing copy
# is reported, not overwritten). Run it again any time: what is already right is reported "unchanged".
#
# Overridable for tests (a temp tree and no root needed): BASE, UNITS, ETC_ROOT, AGENT_HOME, and
# OWN_ROOT / OWN_OPS / OWN_AGENT (the `install -o -g` pairs; empty = leave ownership alone).
set -euo pipefail

INSTANCE=${1:-blog}
[[ $INSTANCE == blog ]] || { echo "unknown instance '$INSTANCE' (only blog has files in instances/)" >&2; exit 2; }
if [[ -z ${OWN_ROOT+x} ]]; then [[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }; fi
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../orchestrator" && pwd)
BASE=${BASE:-/opt/factory}
UNITS=${UNITS:-/etc/systemd/system}
ETC_DIR=${ETC_ROOT:-/etc}/$INSTANCE-agent
ENVF=$ETC_DIR/instance.env
AGENT_HOME=${AGENT_HOME:-/home/factory}
OWN_ROOT=${OWN_ROOT--o root -g root}
OWN_OPS=${OWN_OPS--o root -g factory-ops}
OWN_AGENT=${OWN_AGENT--o factory -g factory}
GROUP_OPS=factory-ops
FIRST_STATE=/var/lib/factory FIRST_UI=/var/lib/factory-ops/ui
FIRST_CTL=/var/lib/factory-ops/ctl FIRST_LOG=/var/log/factory
DID=()

say() { echo "[instance-install] $*"; }
did() { DID+=("$*"); say "$*"; }
die() { echo "[instance-install] ERROR: $*" >&2; exit 1; }
# shellcheck disable=SC2086   # the OWN_* pairs are meant to split
idir() {   # idir <mode> "<-o u -g g>" <dir>...: create, then chmod (install -m is not trusted with the setgid bit)
  local mode=$1 own=$2 d; shift 2
  install -d $own "$@"
  for d in "$@"; do chmod "$mode" "$d"; done
}

UNIT_FILES=(blog-agent@.service blog-agent@.timer blog-agent-sync.service blog-agent-sync.timer
            factory-s4.slice factory-s5.slice)

# ---------------------------------------------------------------- preflight
for c in jq cmp install systemctl; do command -v "$c" >/dev/null || die "$c is required"; done
for u in "${UNIT_FILES[@]}"; do [[ -f $SRC/systemd/$u ]] || die "missing $SRC/systemd/$u"; done
for f in instances/blog.env instances/blog.control.json; do [[ -f $SRC/$f ]] || die "missing $SRC/$f"; done
jq -e . "$SRC/instances/blog.control.json" >/dev/null || die "instances/blog.control.json is not valid JSON"
# The code the lanes run is /opt/factory's. If that is the old orchestrator (no SLOTS), a blog
# lane would refuse slot 4 at best; refuse here instead, before anything is created.
for f in lib.sh run.sh sync.sh sandbox.sh; do [[ -f $BASE/$f ]] || die "$BASE/$f is missing: install the orchestrator first (deploy/orchestrator-install.sh)"; done
grep -q '^SLOTS=' "$BASE/lib.sh" || die "$BASE/lib.sh has no SLOTS: deploy this version of the orchestrator to $BASE first (deploy/orchestrator-install.sh, INSTALL_NO_START=1 keeps the timers as they are)"
grep -q 'SLOTS' "$BASE/sandbox.sh" || die "$BASE/sandbox.sh does not know SLOTS: deploy this version of the orchestrator first"
if [[ -n $OWN_OPS ]]; then getent group "$GROUP_OPS" >/dev/null || die "group $GROUP_OPS does not exist: run deploy/orchestrator-install.sh first"; fi
if [[ -n $OWN_AGENT ]]; then id factory >/dev/null 2>&1 || die "unix user factory does not exist"; fi

# put <mode> <src> <dst>: install when different, say so either way
put() {
  if [[ -f $3 ]] && cmp -s "$2" "$3"; then
    say "unchanged  $3"
  else
    # shellcheck disable=SC2086
    install -D -m "$1" $OWN_ROOT "$2" "$3"
    did "installed  $3"
  fi
}

# envval <KEY>: the value of KEY in the instance's env file (quotes stripped), read as text, never sourced.
envval() { sed -n "s/^$1=//p" "$ENVF" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }

# ---------------------------------------------------------------- the EnvironmentFile
idir 750 "$OWN_ROOT" "$ETC_DIR"
if [[ -f $ENVF ]]; then
  if cmp -s "$SRC/instances/blog.env" "$ENVF"; then say "unchanged  $ENVF"
  else say "kept       $ENVF (differs from the repo's instances/blog.env; yours wins, diff them if unsure)"; fi
else
  put 640 "$SRC/instances/blog.env" "$ENVF"
fi

# What the env file says decides which directories exist, so check it before creating any. Two instances
# sharing a state directory or a lane slot would corrupt each other's claims and sandboxes.
STATE=$(envval STATE) UI=$(envval UI) CTL=$(envval CTL) LOGDIR=$(envval LOGDIR) SLOTS=$(envval SLOTS) AGENT_UNIT=$(envval AGENT_UNIT)
for v in STATE UI CTL LOGDIR; do [[ ${!v} == /* ]] || die "$ENVF: $v must be an absolute path (got '${!v}')"; done
[[ $STATE != "$FIRST_STATE" && $UI != "$FIRST_UI" && $CTL != "$FIRST_CTL" && $LOGDIR != "$FIRST_LOG" ]] \
  || die "$ENVF points STATE, UI, CTL or LOGDIR at the first instance's own directories"
[[ -n $SLOTS ]] || die "$ENVF has no SLOTS"
for s in $SLOTS; do
  [[ $s =~ ^[0-9]+$ ]] || die "$ENVF: SLOTS entry '$s' is not a number"
  case $s in 1|2|3|9) die "$ENVF: slot $s belongs to the first instance or to the gates" ;; esac
done
[[ -n $AGENT_UNIT && $AGENT_UNIT != factory ]] || die "$ENVF: AGENT_UNIT must be set and not factory"
# The lines must be there: unset GO_MODELS means the default paid Go models, and a missing
# WHITELIST_WRITE means this sync would rewrite the shared /etc/opencode/opencode.json.
grep -qE '^GO_MODELS=("")?$' "$ENVF" && grep -qE '^GO_ACCOUNTS=("")?$' "$ENVF" && grep -qE '^WHITELIST_WRITE=0$' "$ENVF" \
  || die "$ENVF must have the lines GO_MODELS= and GO_ACCOUNTS= (empty) and WHITELIST_WRITE=0: this instance only uses free models and must not rewrite the first instance's whitelist"

# ---------------------------------------------------------------- directories (same owners and modes as the first instance's)
idir 700 "$OWN_ROOT" "$STATE" "$STATE/sessions" "$STATE/blocked" "$STATE/claims" "$STATE/cooldown" "$STATE/adopt" "$STATE/locks"
OPS=$(dirname "$UI")
[[ $(dirname "$CTL") == "$OPS" ]] || die "$ENVF: UI and CTL must share a parent directory (got $UI and $CTL)"
idir 750 "$OWN_OPS" "$OPS"
for d in "$UI" "$UI/slots" "$LOGDIR"; do idir 2750 "$OWN_OPS" "$d"; done
idir 2770 "$OWN_OPS" "$CTL"
for s in $SLOTS; do idir 750 "$OWN_AGENT" "$AGENT_HOME/s$s"; done
say "directories and modes in place (state 700; ops 750; ui/logs 2750; ctl 2770; slots $SLOTS under $AGENT_HOME for the agent)"

# ---------------------------------------------------------------- units
for u in "${UNIT_FILES[@]}"; do put 644 "$SRC/systemd/$u" "$UNITS/$u"; done
# daemon-reload only makes systemd read the new files; it starts and enables nothing.
systemctl daemon-reload

# ---------------------------------------------------------------- initial control.json
if [[ -e $CTL/control.json ]]; then
  say "ctl/control.json exists: left alone"
else
  # shellcheck disable=SC2086
  install -m 660 $OWN_OPS "$SRC/instances/blog.control.json" "$CTL/control.json"
  did "wrote initial $CTL/control.json ($(jq -c '[.agents, .model_mode, .paused]' "$CTL/control.json"): agents, mode, paused)"
fi

echo
echo "[instance-install] done. What this run did:"
if (( ${#DID[@]} == 0 )); then echo "  nothing: everything was already in place"; else printf '  - %s\n' "${DID[@]}"; fi
echo "[instance-install] nothing was enabled or started. Still to do by hand (see the report): the gh token at $ETC_DIR/gh-token,"
echo "  the repo's agent labels, then: systemctl enable --now $AGENT_UNIT-sync.timer, then $AGENT_UNIT@<slot>.timer for each of: $SLOTS"
