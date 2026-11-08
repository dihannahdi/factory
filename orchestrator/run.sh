#!/usr/bin/env bash
# factory, one lane. Up to three lanes run at once (factory@1..3); each invocation does
# exactly ONE unit of work and exits, and the timer brings it back 2 minutes later:
#
#   either  shepherd one unclaimed agent PR:   CI -> (fix) -> merge -> deploy -> health
#   or      pick one issue and take it end to end:
#           pick -> plan -> build -> verify -> review -> verify -> PR -> CI -> merge -> deploy -> health
#
# Free by default: model calls go to zero-retention free models in OpenCode Zen. Money is only
# ever spent on opencode-go/ models (the Go subscription), each turn is written to the root
# ledger $STATE/spend.jsonl, and the GO_BUDGET_* budgets send the lanes back to the free models
# listed in control.models (none listed: the lanes back off until the budget window frees).
# A step_finish with cost > 0 from any other model halts every lane.
#
# Trust boundary: this script runs as root and holds the GitHub token; the agent runs as
# factory inside sandbox.sh and holds nothing. Root never runs git inside the agent's
# checkout and never reads a file there directly (a symlink would make root read it for the
# agent): every look inside goes through the sandbox, and commits come out as a git bundle.
#
# Sessions: the author's plan, build and fix turns share one opencode session, so nothing it
# has read is paid for twice. The review is a fresh session on purpose: a reviewer that
# inherits the author's reasoning tends to agree with it. No PR merges without the
# agent-reviewed label, which only review_branch sets.
#
# Tests: the sandbox runs CI's steps; Playwright is a second sandbox call with its own network
# namespace (SB_PRIVATE_NET=1, see sandbox.sh), only when frontend/ changed. Without it most failed
# PR CI runs were the PR's own e2e, found ~35 min later in CI. CI still runs Playwright and stays the
# gate of record. Postgres in CI is the lane's own server here (pg_start).
# Playwright can be made a non-gate in CI (a CI job whose only failed steps are Playwright counts as
# passed) until the issue PLAYWRIGHT_GATE_AFTER names is closed as completed (playwright_gate_on).
# A deploy blocked only by Playwright is then re-dispatched with skip_tests.
#
# Control plane: the console's files (ctl/control.json, ctl/interrupt-K.json) are only ever
# READ here, validated, and never echoed. Status for the console goes to ui/slots/K.json.
#
# usage: run.sh --slot K               one unit of work (what the timer runs)
#        run.sh --slot K <issue>       work that issue now (manual)
#        run.sh --cleanup K            ExecStopPost: stop the lane's sandboxes, release its claims
#        DRY_PICK=1 run.sh --slot K    print the issue that would be picked, change nothing
set -euo pipefail
umask 027

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

PLAN_TIMEOUT=${PLAN_TIMEOUT:-1200}
IDLE_TIMEOUT=${IDLE_TIMEOUT:-900}
RATE_LIMIT_GRACE=${RATE_LIMIT_GRACE:-20}
# 300 min per model turn: at 90 min, 44 of 464 turns (2026-10-24) were cut off at the limit.
AGENT_TIMEOUT=${AGENT_TIMEOUT:-18000}
VERIFY_TIMEOUT=${VERIFY_TIMEOUT:-3600}
# The Playwright pass of verify() is its own sandbox call with its own limit, so it does not eat
# into VERIFY_TIMEOUT. Measured 2026-10-26 under load average 20: 10m47 for the 140-test suite.
E2E_TIMEOUT=${E2E_TIMEOUT:-2700}
FIX_ROUNDS=${FIX_ROUNDS:-2}
COMPLETE_ROUNDS=${COMPLETE_ROUNDS:-4}
CI_FIX_ROUNDS=${CI_FIX_ROUNDS:-2}
CI_TIMEOUT=${CI_TIMEOUT:-5400}
DEPLOY_TIMEOUT=${DEPLOY_TIMEOUT:-3600}
MERGE_LOCK_WAIT=${MERGE_LOCK_WAIT:-5400}
MAX_UPDATE_ROUNDS=${MAX_UPDATE_ROUNDS:-5}
TARGET_MAX_GB=${TARGET_MAX_GB:-15}
# prune-target.sh runs at every checkout (the lane is idle then): it drops stale hash-suffixed test
# executables, and above this many GB also rlib/rmeta untouched for 3 days. Below TARGET_MAX_GB on
# purpose, so the blunt wipe of target/ below is the last resort and not the routine.
PRUNE_CEILING_GB=${PRUNE_CEILING_GB:-12}
# PRUNE_KEEP: "name=N ..." test executables to keep more than one variant of (see prune-target.sh).
PRUNE_KEEP=${PRUNE_KEEP:-}
# AGENT_CRED=<name>:<root-only file>: handed to model turns and verify (isb) as
# $CREDENTIALS_DIRECTORY/<name>, only while the file exists. Use it for a data-source key the
# issues genuinely need (e.g. a dataset API key). Whatever the agent can read reaches the model and
# the lane logs, so put nothing here worth more than the data it unlocks. Empty (the default): the
# agent gets no credential at all.
AGENT_CRED=${AGENT_CRED:-}
PROMPTS=${PROMPTS:-$BASE_DIR/prompts}
# What verify() runs, and how the lane's messages describe it: cargo (a Rust workspace, plus an npm
# frontend/ when there is one: cargo build/test, the frontend build, Playwright when frontend/
# changed) or node (a plain npm project, e.g. an Astro site: npm ci, check, build, test, and
# Playwright only when package.json has an e2e script).
VERIFY_KIND=${VERIFY_KIND:-cargo}
# Existing migrations are never edited by the agent (guard, pre_export_guards). Another repo keeps
# them elsewhere (db/migrations).
MIGRATIONS_DIR=${MIGRATIONS_DIR:-migrations}
# MERGE_MODE: what happens once CI is green and the separate review session has signed off.
#   pr   (default) leave the PR open, labelled agent-ready, for a human to merge. No deploy watch.
#   auto merge it, then watch the deploy workflow and HEALTH_URL (when there are any).
MERGE_MODE=${MERGE_MODE:-pr}

K="" RUN_ID="" MANUAL="" WORK="" OUT="" SLOTDIR=""
n="" run="" run_started=0 sid="" impl_model="" pr="" title="" issue_text="" used=()
plan="" review_text="" verified_head="" VERIFY_DIGEST="" RUN_COST=0 pgnote="" last_out="" last_model="" base=""
CUR_STAGE="" CUR_STAGE_T0=0
STEER_MSG="" STEER_ID="" STEER_TAKEN="" STEER_QUOTES=()
STOP_PENDING=0 STOP_ID="" STOP_SKIP=false NOINT=0 LAST_INTR_ID="" INTR_SIG=""
EFF_MODELS=() COOLING=() EFF_LAST=0 ISB_KIND=turn ISB_UNIT="" ISB_EVENTS="" ISB_ERR=""
WAIT_RESULT="" CI_STATE="" MERGEABLE="" UPD_ROUNDS=0 MERGE_RESULT="" PRS_CACHE="" PRS_CACHE_AT=0
# Adoption of a human PR (label agent-adopt): ADOPTED=1 while this run works one (adopt() or the
# shepherd of a PR that has an adoption record); EXPORT_MOVED=1 when the PR head moved under us.
ADOPTED=0 adopt_pr="" adopt_branch="" CHECKOUT_SHA="" EXPORT_MOVED=0 FAIL_DETAIL=""

# ---------------------------------------------------------------- sandbox calls
# sb <timeout> <cmd...>: run inside the sandbox, in the agent's checkout. Short calls only (<= 60 s
# in practice); they cannot be interrupted. Safe inside $(...).
sb() { "$SANDBOX" "$WORK" "$@" </dev/null 9>&-; }

# watchdog_init / watchdog_poll: for model turns only (ISB_EVENTS = the turn's JSON-lines file,
# ISB_ERR = its stderr, which carries opencode's own log because of --print-logs). Two things
# opencode does silently, and that otherwise burn the whole AGENT_TIMEOUT:
#   rate limit: it logs the error to stderr and retries forever, with nothing on stdout.
#   stall:      no event for IDLE_TIMEOUT (default 900 s) and no CPU either.
# A rate-limit line only counts when no event follows it for RATE_LIMIT_GRACE seconds (a retry
# that worked produces events again). A long tool call (cargo build) is silent too, so CPU
# time of the unit counts as life.
WD_RESULT="" WD_SIZE=0 WD_LAST=0 WD_RL_AT=0 WD_OFF=0 WD_CPU_NS=0 WD_CPU_AT=0
watchdog_init() {
  WD_RESULT="" WD_SIZE=0 WD_LAST=$(now) WD_RL_AT=0 WD_OFF=0 WD_CPU_NS=0 WD_CPU_AT=$(now)
}
unit_cpu_ns() { systemctl show -p CPUUsageNSec --value "$1.service" 2>/dev/null || true; }
watchdog_poll() {  # watchdog_poll <unit>: sets WD_RESULT to "", rate_limit, usage_cap or stalled
  local t sz cpu esz
  WD_RESULT=""
  t=$(now)
  sz=$(stat -c %s "$ISB_EVENTS" 2>/dev/null || echo 0)
  if (( sz != WD_SIZE )); then
    WD_SIZE=$sz WD_LAST=$t
    if (( WD_RL_AT > 0 )); then   # recovered: forget what the log said so far
      WD_RL_AT=0 WD_OFF=$(stat -c %s "$ISB_ERR" 2>/dev/null || echo 0)
    fi
  fi
  if (( WD_RL_AT == 0 )) && [[ $(err_log_class "$ISB_ERR" "$WD_OFF") != none ]]; then WD_RL_AT=$t; fi
  if (( WD_RL_AT > 0 )) && (( t - WD_RL_AT >= RATE_LIMIT_GRACE )) && (( t - WD_LAST >= RATE_LIMIT_GRACE )); then
    # usage_cap wins over rate_limit when the log has both (the cap is the cause, not a burst).
    WD_RESULT=$(err_log_class "$ISB_ERR" "$WD_OFF")
    [[ $WD_RESULT == usage_cap ]] || WD_RESULT=rate_limit
    return 0
  fi
  if (( t - WD_CPU_AT >= 30 )); then
    cpu=$(unit_cpu_ns "$1")
    if [[ $cpu =~ ^[0-9]+$ ]]; then
      if (( WD_CPU_NS > 0 )) && (( cpu - WD_CPU_NS >= 2000000000 )); then WD_LAST=$t; fi
      WD_CPU_NS=$cpu
    fi
    WD_CPU_AT=$t
  fi
  if (( t - WD_LAST >= IDLE_TIMEOUT )); then WD_RESULT=stalled; fi
  return 0
}

# isb <timeout> <cmd...>: the interruptible sandbox call, for model turns and verify only (they
# run in the main shell, never inside $(...), because stop_now exits the shell). The sandbox
# runs in the background under a name we know; every 2 s we look at ctl/interrupt-K.json.
# Returns the command's code, 75 when a steer cut a model turn short, 76 when the watchdog
# stopped a rate-limited turn, 77 when it stopped a stalled one (ISB_KIND=turn with ISB_EVENTS
# and ISB_ERR set; the turn is ended with SIGTERM so the session survives).
isb() {
  local tmo=$1 pid rc=0 unit wd=0 cred=""
  shift
  unit=factory-sb-$K-$(date +%s)-$RANDOM$RANDOM
  ISB_UNIT=$unit
  if [[ $ISB_KIND == turn && -n ${ISB_EVENTS:-} && -n ${ISB_ERR:-} ]]; then wd=1; watchdog_init; fi
  if [[ -n $AGENT_CRED && -f ${AGENT_CRED#*:} ]]; then cred=$AGENT_CRED; fi
  # ISB_CRED_EXTRA: more name:path credentials for THIS unit only (a turn on Go account N gets its key).
  if [[ -n ${ISB_CRED_EXTRA:-} ]]; then cred+="${cred:+ }$ISB_CRED_EXTRA"; fi
  SB_CRED=$cred SB_UNIT=$unit "$SANDBOX" "$WORK" "$tmo" "$@" </dev/null 9>&- &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    intr_poll
    if (( STOP_PENDING )) && (( ! NOINT )); then
      # Stopping the slice, not the client: the unit outlives a killed systemd-run --wait.
      systemctl stop "factory-s$K.slice" >/dev/null 2>&1 || true
      wait "$pid" 2>/dev/null || true
      stop_now
    fi
    if [[ -n $STEER_MSG && $ISB_KIND == turn ]]; then
      soft_kill "$unit" "$pid"
      wait "$pid" 2>/dev/null || true
      return 75
    fi
    if (( wd )); then
      watchdog_poll "$unit"
      if [[ -n $WD_RESULT ]]; then
        log "watchdog: $WD_RESULT, ending the turn"
        soft_kill "$unit" "$pid"
        wait "$pid" 2>/dev/null || true
        if [[ $WD_RESULT == rate_limit || $WD_RESULT == usage_cap ]]; then return 76; else return 77; fi
      fi
    fi
    st_beat
    sleep 2
  done
  wait "$pid" || rc=$?
  return "$rc"
}

# soft_kill <unit> <client-pid>: SIGTERM to the unit's main process, 10 s of grace, then stop the
# unit. TERM, not INT: gate G3 on the box showed opencode 1.18.35 exits on INT before writing
# any event (no session id, nothing to resume), while on TERM it flushes the session and
# `opencode run -s <sid>` resumes without an error.
soft_kill() {
  local i
  systemctl kill --kill-whom=main -s TERM "$1" >/dev/null 2>&1 || true
  for i in 1 2 3 4 5; do
    kill -0 "$2" 2>/dev/null || return 0
    sleep 2
  done
  systemctl stop "$1" >/dev/null 2>&1 || true
  return 0
}

# isleep <seconds>: sleep in 2 s steps; every step looks at the interrupt file and beats the
# status heartbeat. Replaces every plain sleep in the waits.
isleep() {
  local until=$(( $(now) + $1 )) left
  while (( $(now) < until )); do
    intr_poll
    if (( STOP_PENDING )) && (( ! NOINT )); then stop_now; fi
    st_beat
    left=$(( until - $(now) ))
    if (( left > 2 )); then left=2; fi
    if (( left > 0 )); then sleep "$left"; fi
  done
  return 0
}

safe_dir() { [[ -d $1 && ! -L $1 ]]; }

# target_trim: a lane's cargo target grows with every branch it builds (14-20 GB per lane on
# 2026-10-18, which filled the shared disk). Over TARGET_MAX_GB it is emptied before the next
# issue; it holds only build output, so the cost is one cold build. The lane's own directories
# are checked first, because the agent owns its home and could plant a symlink there.
TARGET_MAX_GB=${TARGET_MAX_GB:-10}
target_trim() {
  local t=$SLOTDIR/target gb
  safe_dir "$SLOTDIR" && safe_dir "$t" || return 0
  gb=$(du -s --block-size=1G --one-file-system "$t" 2>/dev/null | cut -f1)
  [[ $gb =~ ^[0-9]+$ ]] || return 0
  if (( gb > TARGET_MAX_GB )); then
    log "cargo target of lane $K is ${gb} GB (> ${TARGET_MAX_GB}): emptied"
    rm -rf --one-file-system "$t" && mkdir -p "$t" && chmod 750 "$t" 2>/dev/null
    chown "${AGENT_OWNER:-factory:factory}" "$t" 2>/dev/null || true
  fi
  return 0
}

# unit_hit_memory_cap <unit>: rc 0 when the sandbox unit was OOM-killed or peaked at its
# MemoryMax (sandbox.sh, 10G). The unit is collected by then, so the journal is the only record.
# A child killed for memory (rustc, a test binary) can leave opencode exiting 1 with no model
# error, which used to read as "no_commit" and label the issue agent-failed.
SB_MEMORY_MAX_GB=${SB_MEMORY_MAX_GB:-10}
unit_hit_memory_cap() {
  local j peak i
  [[ -n ${1:-} ]] || return 1
  for i in 1 2 3; do
    j=$(journalctl -u "$1.service" --no-pager -o cat -n 40 2>/dev/null) || j=""
    if grep -q "memory peak\|oom-kill" <<<"$j"; then break; fi
    sleep 1
  done
  if grep -q "Failed with result 'oom-kill'" <<<"$j"; then return 0; fi
  peak=$(grep -oE "[0-9.]+G memory peak" <<<"$j" | tail -n1 | grep -oE "^[0-9.]+")
  [[ -n $peak ]] && awk -v p="$peak" -v m="$SB_MEMORY_MAX_GB" 'BEGIN { exit !(p >= m - 0.05) }'
}

# ---------------------------------------------------------------- status and stages
st_beat() {
  local t; t=$(now)
  if (( t - EFF_LAST >= 60 )); then refresh_effective; fi
  if (( t - ST_LAST >= 30 )); then st_flush; fi
  return 0
}

stage_end() {  # stage_end [ok|fail|stopped|timeout]
  if [[ -n $CUR_STAGE ]]; then
    record --arg kind stage --arg stage "$CUR_STAGE" --argjson secs "$(( $(now) - CUR_STAGE_T0 ))" --arg result "${1:-ok}"
    CUR_STAGE=""
  fi
  return 0
}

stage() {  # stage <name> [sub]: a new stage closes the previous one in stats.jsonl
  if [[ $CUR_STAGE != "$1" ]]; then
    stage_end ok
    CUR_STAGE=$1 CUR_STAGE_T0=$(now)
    ST_STAGE=$1 ST_STAGE_STARTED=$CUR_STAGE_T0 ST_SUB=${2:-}
    case $1 in ci|merge) ;; *) ST_CI_JSON=null ;; esac   # `ci` is only reported during ci and merge
  elif [[ $# -ge 2 ]]; then
    ST_SUB=$2
  fi
  if (( STOP_PENDING && NOINT )); then ST_SUB="stop deferred"; fi
  st_flush
}

turn_begin() {  # turn_begin <phase> <events-file> <model>
  ST_TURN_JSON=$(jq -nc --arg p "$1" --argjson t "$(now)" --arg e "$2" '{phase: $p, started: $t, events: $e}')
  ST_MODEL=$3
  st_flush
}
turn_end() { ST_TURN_JSON=null; st_flush; }

# Stage of a model turn, by phase name. Empty: keep the current stage (a steer turn).
phase_stage() {
  case $1 in
    plan|replan) echo plan ;;
    build|complete*) echo build ;;
    fix-build-*|fix-complete*) echo verify ;;
    review|fix-review-*) echo review ;;
    merge[0-9]*|fix-merge*) echo pr ;;
    ci[0-9]*|fix-ci*) echo ci ;;
    *) echo "" ;;
  esac
}

req_refresh() {  # requirements done/total from .git/agent-checklist.json, read through the sandbox
  local j
  j=$(sb 20 cat .git/agent-checklist.json 2>/dev/null) || return 0
  jq -e 'type == "array"' <<<"$j" >/dev/null 2>&1 || return 0
  ST_REQ_TOTAL=$(jq 'length' <<<"$j")
  ST_REQ_DONE=$(jq '[.[] | select(.done == true)] | length' <<<"$j")
  # The console's inspect drawer reads the same checklist from the run's log dir (SCHEMA 6.1).
  # atomic_write: tmp + mv in the same dir, mode 640, group factory-ops (the dir is setgid, umask 027).
  if [[ -n ${run:-} && -d ${run:-} ]]; then
    printf '%s\n' "$j" | atomic_write "$run/checklist.json" 640 2>/dev/null || true
  fi
  st_flush
  return 0
}

# lane_pos: this lane's 1-based position in SLOTS. control.json's `agents` counts lanes, so the
# comparison with the effective count uses this, not the slot number (slot 4 is lane 1 of an
# instance with SLOTS="4 5"). With the default SLOTS the two are the same number. A K outside
# SLOTS (only a test sets one) keeps its own number.
lane_pos() { slot_index "$K" || echo "${K:-0}"; }

refresh_effective() {  # D2/D4: how many lanes may work right now
  local agents q disk rl=0
  control_load
  agents=$(jq -r .agents <<<"$CONTROL")
  models_refresh
  if (( ${#EFF_MODELS[@]} > 0 )) && rl_recent_all "$STATS" 900 "${EFF_MODELS[@]}"; then rl=1; fi
  q=$(jq -r '.runner.queued // 0' "$UI/github.json" 2>/dev/null || echo 0)
  [[ $q =~ ^[0-9]+$ ]] || q=0
  disk=$(df -BG --output=avail "$H" 2>/dev/null | tail -n1 | tr -dc 0-9 || true)
  disk=${disk:-999}
  ST_EFF=$(effective_agents_calc "$agents" "$rl" "$disk" "$q")
  DRAIN=0
  if (( $(lane_pos) > ST_EFF )); then DRAIN=1; fi
  EFF_LAST=$(now)
  return 0
}

prs_by_issue() {  # {"<issue>": "MERGED"|"OPEN"|...} for the model ranking, cached 10 min
  if [[ -z $PRS_CACHE ]] || (( $(now) - PRS_CACHE_AT > 600 )); then
    PRS_CACHE=$(timeout 40 "$GH" pr list -R "$REPO" --label agent --state all -L 300 --json headRefName,state 2>/dev/null \
      | jq -c 'map(select(.headRefName | test("^agent/issue-[0-9]+$"))
                 | {key: (.headRefName | ltrimstr("agent/issue-")), value: .state}) | from_entries' 2>/dev/null) || PRS_CACHE='{}'
    [[ -n $PRS_CACHE ]] || PRS_CACHE='{}'
    PRS_CACHE_AT=$(now)
  fi
  echo "$PRS_CACHE"
}

# models_refresh: EFF_MODELS = control.models that are free (else the first free one), ranked
# when model_mode is auto, cooling ones last. Cooldowns come from STATE/cooldown/.
models_refresh() {
  local free ids cool="[]" m
  # free = every eligible id: zero-retention only, Go (paid) first, then free (models_eligible).
  free=$(models_eligible "$UI/models.json")
  [[ -n $free ]] || free='[]'
  # Go over its budget cools like a rate limit: the lane falls back to the free models in
  # control.models, or backs off when it lists none (models_effective adds no fallback then).
  budget_sync $(jq -r '.[]' <<<"$free")
  ids=$(jq -c .models <<<"$CONTROL")
  if [[ $(jq -r .model_mode <<<"$CONTROL") == auto ]] && (( $(jq length <<<"$ids") > 1 )); then
    ids=$(rank_models "$ids" "$(prs_by_issue)") || ids=$(jq -c .models <<<"$CONTROL")
  fi
  for m in $(jq -r '.[]' <<<"$free"); do
    if is_cooling "$m"; then cool=$(jq -c --arg m "$m" '. + [$m]' <<<"$cool"); fi
  done
  mapfile -t EFF_MODELS < <(models_effective "$ids" "$free" "$cool" | jq -r '.[]')
  mapfile -t COOLING < <(jq -r '.[]' <<<"$cool")
  return 0
}

# earliest_cooldown_note: "until HH:MMZ" for the soonest model to come back, from EFF_MODELS.
earliest_cooldown_note() {
  local m u min=0 minm="" n=0 parts=""
  for m in "${EFF_MODELS[@]}"; do
    if (( $(cooldown_until "$m") > $(now) )); then n=$(( n + 1 )); fi
  done
  if (( n > 1 )); then   # several accounts cooling: say when each one returns
    for m in "${EFF_MODELS[@]}"; do
      u=$(cooldown_until "$m")
      if (( u > $(now) )); then
        parts+="${parts:+; }account $(go_account "$m") until $(date -u -d "@$u" '+%a %F %H:%MZ' 2>/dev/null || echo "$u")"
        if [[ $(cooldown_reason "$m") == usage_cap ]]; then parts+=" (weekly Go quota used up)"; fi
      fi
    done
    printf '%s' "$parts"
    return 0
  fi
  for m in "${EFF_MODELS[@]}"; do
    u=$(cooldown_until "$m")
    if (( u > $(now) )) && { (( min == 0 )) || (( u < min )); }; then min=$u minm=$m; fi
  done
  if (( min > 0 )); then
    if [[ $(cooldown_reason "$minm") == usage_cap ]]; then
      printf 'until %s (weekly OpenCode Go quota used up, resets Monday 00:00Z)' "$(date -u -d "@$min" '+%a %F %H:%MZ' 2>/dev/null || echo "$min")"
    else
      printf 'until %s' "$(date -u -d "@$min" +%H:%MZ 2>/dev/null || echo "$min")"
    fi
  fi
  return 0
}

# ---------------------------------------------------------------- exits
# lane_exit <state> <note>: end this run with a state the console shows (parked, backoff, idle ...).
lane_exit() {
  stage_end ok
  ST_STATE=$1 ST_NOTE=${2:-} ST_STAGE="" ST_SUB="" ST_TURN_JSON=null
  st_flush
  exit 0
}

# halt <slug> <reason>: halt every lane (ui/halt.json + a GitHub issue) and end this one.
halt() {
  halt_raise "$1" "$2"
  stage_end fail
  ST_STATE=halted ST_NOTE=$2 ST_STAGE="" ST_SUB="" ST_TURN_JSON=null
  st_flush
  exit 0
}

gate_halt() {  # every lane checks this at pick, before each turn, and inside the merge lock
  control_load
  if halted; then
    stage_end stopped
    ST_STATE=halted ST_NOTE=$(jq -r '.reason // "halt"' "$UI/halt.json" 2>/dev/null || echo halt)
    ST_STAGE="" ST_SUB="" ST_TURN_JSON=null
    st_flush
    exit 0
  fi
  return 0
}

gate_pause() {  # paused: no new work; what runs finishes its step and parks
  if [[ -z $MANUAL && $(jq -r .paused <<<"$CONTROL") == true ]]; then lane_exit parked "paused from the console"; fi
  return 0
}

gate_cooldown() {  # every effective model cooling: back off, saying when the first one returns
  local p
  for p in "${EFF_MODELS[@]}"; do if ! is_cooling "$p"; then return 0; fi; done
  lane_exit backoff "every model is cooling down $(earliest_cooldown_note)"
}

gate_stop() {  # apply a stop that was deferred (merge+deploy) or arrived between calls
  intr_poll
  if (( STOP_PENDING )) && (( ! NOINT )); then stop_now; fi
  return 0
}

# ---------------------------------------------------------------- interrupts
# intr_poll: look at ctl/interrupt-K.json. Acts only on a valid file for THIS run that we have
# not handled yet. Root never deletes or writes it. Main shell only.
intr_poll() {
  local f=$CTL/interrupt-$K.json sig j id action msg
  sig=$(stat -c '%y.%s.%i' "$f" 2>/dev/null) || return 0
  [[ $sig != "$INTR_SIG" ]] || return 0
  INTR_SIG=$sig
  j=$(intr_validate "$f") || return 0
  intr_should_act "$j" "$RUN_ID" "$LAST_INTR_ID" || return 0
  id=$(jq -r .id <<<"$j") action=$(jq -r .action <<<"$j")
  LAST_INTR_ID=$id
  ST_INTR_JSON=$(jq -nc --arg id "$id" --arg a "$action" --argjson t "$(now)" '{last_id: $id, action: $a, handled_at: $t}')
  case $action in
    stop)
      STOP_PENDING=1 STOP_ID=$id STOP_SKIP=$(jq -r .skip <<<"$j")
      log "interrupt: stop"
      if (( NOINT )); then ST_SUB="stop deferred"; fi
      ;;
    steer)
      msg=$(jq -j .message <<<"$j")
      if [[ -n $STEER_MSG ]]; then msg="$STEER_MSG

$msg"; fi
      STEER_MSG=${msg:0:4000} STEER_ID=$id
      ST_STEER_PENDING=$(jq -nc --arg id "$id" --arg m "$STEER_MSG" --argjson t "$(now)" '{id: $id, message: $m, received_at: $t}')
      log "interrupt: steer (${#STEER_MSG} chars)"
      ;;
  esac
  st_flush
  return 0
}

# steer_take: move the pending steer into STEER_TAKEN, record it as applied, and quote it
# verbatim: in the PR body when no PR exists yet, else as a PR comment.
steer_take() {
  STEER_TAKEN=$STEER_MSG
  ST_STEER_LAST=$(jq -nc --arg id "$STEER_ID" --arg m "$STEER_TAKEN" --argjson t "$(now)" \
    '{id: $id, message: $m, applied_at: $t, outcome: "applied"}')
  ST_STEER_PENDING=null
  STEER_MSG="" STEER_ID=""
  record --arg kind steer --arg phase "${CUR_STAGE:-}" --arg outcome applied
  if [[ -n $pr ]]; then
    "$GH" pr comment "$pr" -R "$REPO" --body "**Steer from a human (quoted verbatim):**

$(printf '%s\n' "$STEER_TAKEN" | sed 's/^/> /')" >/dev/null 2>&1 || true
  else
    STEER_QUOTES+=("$STEER_TAKEN")
  fi
  st_flush
  return 0
}

steer_section() {  # the PR body's quote of every steer applied before the PR existed
  local q
  (( ${#STEER_QUOTES[@]} > 0 )) || return 0
  echo
  echo "**Steers from a human during the work (quoted verbatim):**"
  echo
  for q in "${STEER_QUOTES[@]}"; do
    printf '%s\n' "$q" | sed 's/^/> /'
    echo
  done
  return 0
}

# stop_now: the console said Stop. Takes the sandboxes down, records outcome `stopped` (never
# agent-failed), releases the claim, and ends the run with exit 0 so nothing upstream ever sees
# a failure. Called from the main shell only.
stop_now() {
  systemctl stop "factory-s$K.slice" >/dev/null 2>&1 || true
  stage_end stopped
  record --arg kind outcome --arg outcome stopped --arg model "${impl_model:-}"
  claim_release_run
  ST_STATE=stopped ST_STAGE="" ST_SUB="" ST_NOTE="stopped from the console" ST_TURN_JSON=null
  if [[ $STOP_SKIP == true ]]; then ST_NOTE="stopped from the console (skip)"; fi
  st_flush
  log "stopped from the console"
  exit 0
}

# test_hint: how a turn may run only the tests of its own change, by VERIFY_KIND. Said in the review
# turn's contract; the full verify runs before and after it either way.
test_hint() {
  if [[ $VERIFY_KIND == node ]]; then printf '%s' 'npm run build, or npm test -- <filter> when there is a test script'; else printf '%s' 'cargo test -p <crate> <filter>'; fi
}

# decision_docs: what a PR may not contradict besides the issue, by VERIFY_KIND (adopt_context).
decision_docs() {
  if [[ $VERIFY_KIND == node ]]; then printf '%s' 'docs/DESIGN.md or docs/PLAN.md'; else printf '%s' 'a written design decision (ADR)'; fi
}

# Every steered turn repeats the output contract of the phase it interrupted: a steer must not be
# able to make a plan lose its ```json block or a build lose its commit and checklist.
phase_contract() {
  case $1 in
    plan|replan) printf '%s' 'The output contract of the PLAN step still applies: change no file, and end your answer with one ```json block shaped {"decision","reason","requirements","slice","files","tests"} (or "blocked" with "depends_on"), because the plan is read automatically from this last answer of yours.' ;;
    build|complete*|fix-build-*|fix-complete*|steer-*) printf '%s' 'The contract of the BUILD step still applies: finish every requirement of the issue, run the build and tests until they pass, commit every change (clean working tree), update .git/agent-checklist.json honestly, and write the PR summary to .git/agent-pr-body.md. Do not push and do not change the remote.' ;;
    review|fix-review-*) printf '%s' 'The contract of the REVIEW step still applies: write the proven findings to .git/agent-review.md, fix them, update .git/agent-checklist.json, run only the build and tests relevant to your fix ('"$(test_hint)"'; the full verify passed before the review and root runs it again afterwards), then commit with the message "Apply review findings".' ;;
    *) printf '%s' 'Run the build and tests until they pass, update .git/agent-checklist.json if it changed, then commit. Do not push and do not change the remote.' ;;
  esac
}

# ---------------------------------------------------------------- logs, records, issue state
start_log() {  # start_log <issue>: one artifact directory per issue per invocation
  if [[ $run != "$LOGDIR/issue-$1-"* ]]; then
    run_started=$(now)
    run=$LOGDIR/issue-$1-$(date -u -d "@$run_started" +%Y%m%dT%H%M%SZ)-s$K
    mkdir -p "$run"
    chmod 2750 "$run"
    if [[ -n $FILE_GROUP ]]; then chgrp "$FILE_GROUP" "$run" 2>/dev/null || true; fi
    ST_LOGDIR=$run
    if (( ST_ISSUE_STARTED == 0 )); then ST_ISSUE_STARTED=$run_started; fi
    st_flush
  fi
}

issue_begin() {  # issue_begin <n> <title>
  ST_ISSUE_JSON=$(issue_json "$1" "$2")
  st_flush
}

set_pr() {  # set_pr <number> <head-sha>
  pr=$1
  ST_PR_JSON=$(jq -nc --argjson n "$1" --arg url "https://github.com/$REPO/pull/$1" --arg head "$2" '{n: $n, url: $url, head: $head}')
  st_flush
}

fail_issue() {  # fail_issue <outcome> <reason>: no PR for this issue; label it and move on
  local detail=""
  log "issue #$n: $1: $2"
  stage_end fail
  record --arg kind outcome --arg outcome "$1" --arg model "${impl_model:-}"
  "$GH" issue edit "$n" -R "$REPO" --add-label agent-failed >/dev/null || true
  # The next run starts from main and learns about this one only through load_issue, which reads
  # the comments. Without the failing lines it knew just "CI failed" and walked into the same wall
  # again (five issues in a row on one benchmark gate, one of them twice).
  if [[ -n $FAIL_DETAIL ]]; then
    detail=$(printf '\n\nFailing lines (filtered from the log):\n\n````\n%s\n````' "${FAIL_DETAIL:0:6000}")
  fi
  "$GH" issue comment "$n" -R "$REPO" --body-file - >/dev/null <<EOF || true
factory did not finish this issue: $2$detail

Log: \`$run\` on the host. Remove the \`agent-failed\` label (or queue it from the console) to have it picked up again.
EOF
  if [[ -n $adopt_pr ]]; then
    "$GH" pr comment "$adopt_pr" -R "$REPO" --body "factory stopped working on this PR ($1): $2

This PR was not changed and stays open. Log: \`$run\` on the host." >/dev/null 2>&1 || true
  fi
  exit 0
}

# block_issue <deps-json> <reason>: the issue waits for other issues; that is not a failure.
# Only deps that are still open count; if none are, the wait could never end, so a human has to
# look (fail_issue). A dep that itself waits for this issue (declared in its text or recorded by a
# plan, directly or through others) is dropped too: that wait could never end either (one such
# pair once held about twenty issues behind it). When every dep is such a cycle, block_issue returns with
# CYCLE_DEPS set instead of exiting, and plan_step plans once more. sync.sh lifts the label once
# every dep is closed (single writer).
CYCLE_DEPS="[]"
block_issue() {
  local d deps waiters note=""
  CYCLE_DEPS="[]"
  d=$(mktemp -d "${TMPDIR:-/tmp}/factory-block.XXXXXX")
  if ! timeout "${GH_TIMEOUT:-40}" "$GH" issue list -R "$REPO" --state open -L 500 --json number,body > "$d/issues.json" \
     || ! jq -e 'type == "array"' "$d/issues.json" >/dev/null 2>&1; then
    rm -rf "$d"
    record --arg kind outcome --arg outcome retry --arg model "${impl_model:-}"
    lane_exit backoff "could not read the open issues while recording the dependencies of #$n"
  fi
  wait_graph "$d"
  waiters=$(waiters_of "$n" < "$d/blocked.json")
  deps=$(jq -c --slurpfile iss "$d/issues.json" --argjson self "$n" \
    '[.[] | tonumber? | select(. != $self) | . as $d | select(any($iss[0][].number; . == $d))] | unique' <<<"$1")
  rm -rf "$d"
  CYCLE_DEPS=$(jq -c --argjson w "$waiters" '[.[] | . as $x | select(any($w[]; . == $x))]' <<<"$deps")
  deps=$(jq -c --argjson w "$waiters" '[.[] | . as $x | select(any($w[]; . == $x) | not)]' <<<"$deps")
  if [[ $deps == "[]" && $CYCLE_DEPS != "[]" ]]; then
    log "the plan of #$n waits for $CYCLE_DEPS, which wait for #$n themselves; planning again"
    return 0
  fi
  [[ $deps != "[]" ]] || fail_issue blocked "$2"
  if [[ $CYCLE_DEPS != "[]" ]]; then
    note="

$(jq -r 'map("#\(.)") | join(", ")' <<<"$CYCLE_DEPS") not waited for: that issue itself waits for this one."
  fi
  printf '%s\n' "$deps" > "$STATE/blocked/$n"
  stage_end ok
  record --arg kind outcome --arg outcome waiting --arg model "${impl_model:-}"
  log "issue #$n waits for $deps: $2"
  "$GH" issue edit "$n" -R "$REPO" --add-label agent-blocked >/dev/null || true
  "$GH" issue comment "$n" -R "$REPO" --body-file - >/dev/null <<EOF || true
factory put this issue on hold until $(jq -r 'map("#\(.)") | join(", ")' <<<"$deps") is closed: $2$note

The \`agent-blocked\` label is removed automatically once those issues are closed, and this issue is tried again.
EOF
  exit 0
}

give_up_pr() {  # give_up_pr <pr> <outcome> <reason>: close the PR unmerged, label the issue
  if (( ADOPTED )); then
    # A human's PR is never closed and its branch never deleted: the lane lets go of it instead.
    "$GH" pr edit "$1" -R "$REPO" --remove-label agent --remove-label agent-reviewed --remove-label agent-adopt >/dev/null 2>&1 || true
    adopt_forget "$1"
    fail_issue "$2" "$3 (PR #$1 stays open; the agent and agent-adopt labels were removed)"
  fi
  "$GH" pr close "$1" -R "$REPO" --delete-branch --comment "factory closed this PR without merging: $3" >/dev/null || true
  fail_issue "$2" "$3 (PR #$1 closed)"
}

# leave_pr <outcome> <note>: stop working on a PR without closing it (a CI wait that ran out).
leave_pr() {
  log "PR #$pr left open: $2"
  stage_end timeout
  record --arg kind outcome --arg outcome "$1" --arg model "${impl_model:-}"
  lock_drop merge
  exit 0
}

# ---------------------------------------------------------------- the agent's checkout
# checkout <branch> <sha>: fresh agent checkout with main at $base and no remote.
# --no-hardlinks matters: chown -R on hardlinked objects would chown the mirror's too.
# The agent owns its home, so it could replace s<K> or s<K>/work with a symlink to a root path.
# Removal therefore runs as the agent inside the sandbox (a planted link can then only hurt the
# agent), and root re-checks that the directories are real before it creates anything.
checkout() {
  local gb
  safe_dir "$H" && safe_dir "$SLOTDIR" || { log "slot directory $SLOTDIR is not a plain directory"; exit 1; }
  if [[ -e $WORK || -L $WORK || -e $OUT || -L $OUT ]]; then
    "$SANDBOX" "$SLOTDIR" 300 rm -rf -- "$WORK" "$OUT" </dev/null
  fi
  if [[ -e $WORK || -L $WORK || -e $OUT || -L $OUT ]]; then log "could not clear $SLOTDIR"; exit 1; fi
  # The same prune a self-hosted CI runner can use as its job-completed hook, run as factory in the sandbox (/opt is
  # hidden there, so the script travels on stdin; as a bash -c argument systemd would expand its ${...}). Never fails a run.
  if [[ -f $BASE_DIR/prune-target.sh && -d $SLOTDIR/target ]]; then
    prune_out=$("$SANDBOX" "$SLOTDIR" 300 bash -s -- "$SLOTDIR/target" "$PRUNE_CEILING_GB" "$PRUNE_KEEP" <"$BASE_DIR/prune-target.sh" 2>&1) || true
    while IFS= read -r prune_line; do if [[ -n $prune_line ]]; then log "$prune_line"; fi; done <<<"$prune_out"
  fi
  gb=$(( $(du -s --block-size=1G "$SLOTDIR/target" 2>/dev/null | cut -f1 || echo 0) ))
  if (( gb > TARGET_MAX_GB )); then
    log "target/ is ${gb}G, wiping"
    "$SANDBOX" "$SLOTDIR" 600 rm -rf -- "$SLOTDIR/target" </dev/null || true
  fi
  safe_dir "$SLOTDIR" || exit 1
  CHECKOUT_SHA=$2
  lk mirror git clone --quiet --no-hardlinks --no-checkout "$MIRROR" "$WORK"
  git -C "$WORK" checkout --quiet -B "$1" "$2"
  git -C "$WORK" branch --quiet -f main "$base"
  git -C "$WORK" remote remove origin
  git -C "$WORK" config user.name "factory"
  git -C "$WORK" config user.email "factory@users.noreply.github.com"
  echo ".opencode/" >> "$WORK/.git/info/exclude"
  [[ ! -L $OUT ]] || exit 1
  install -d -m 700 -o factory -g factory "$OUT"
  chown -R factory:factory "$WORK"
  # From here on root does not touch $WORK except through sb.
}

_export_locked() {  # <branch> <head> <bundle>: fetch -> verify -> push, one mirror critical section
  mg fetch --quiet "$3" "+refs/heads/$1:refs/heads/$1" || return 1
  [[ $(mg rev-parse "refs/heads/$1") == "$2" ]] || return 3
  # --force: agent/issue-N may survive from an earlier merged slice. Only agent/* is pushed.
  mg push --quiet --force origin "refs/heads/$1:refs/heads/$1"
}

# Adopted PR: the human's branch is only ever fast-forwarded. The bundle goes into a private ref
# (refs/adopt/<pr>, never the mirror's own branch), the remote head must still be the one we
# checked out ($4), and the push has no --force, so git itself refuses anything but a descendant.
# rc 5: the remote head is not $4 any more (the human pushed): nothing was pushed.
_export_adopt_locked() {  # <branch> <head> <bundle> <expected-remote-head>
  local ref=refs/adopt/${adopt_pr:-0} remote
  mg fetch --quiet "$3" "+refs/heads/$1:$ref" || return 1
  [[ $(mg rev-parse "$ref") == "$2" ]] || return 3
  remote=$(mg ls-remote origin "refs/heads/$1" | cut -f1)
  [[ $remote == "$4" ]] || return 5
  if ! mg push --quiet origin "$ref:refs/heads/$1"; then
    remote=$(mg ls-remote origin "refs/heads/$1" | cut -f1)
    [[ $remote == "$4" ]] || return 5
    return 6
  fi
  mg update-ref -d "$ref" >/dev/null 2>&1 || true
  return 0
}

# export_branch <branch>: sandbox HEAD -> git bundle (data) -> mirror -> GitHub. For an adopted PR
# it is fast-forward only and a moved head sets EXPORT_MOVED=1 instead of ending the run.
export_branch() {
  local head bundle=$OUT/branch.bundle rc=0
  EXPORT_MOVED=0
  head=$(sb 60 git rev-parse HEAD)
  sb 300 git bundle create "$bundle" "$1" "^$base"
  [[ -f $bundle && ! -L $bundle ]] || { log "bundle missing or a symlink"; exit 1; }
  if (( ADOPTED )); then
    lk mirror _export_adopt_locked "$1" "$head" "$bundle" "$CHECKOUT_SHA" || rc=$?
    if (( rc == 5 )); then
      log "the head of $1 moved on GitHub since ${CHECKOUT_SHA:0:12}: not overwriting it"
      EXPORT_MOVED=1
      return 0
    fi
  else
    lk mirror _export_locked "$1" "$head" "$bundle" || rc=$?
  fi
  (( rc == 0 )) || { log "export of $1 failed (rc $rc)"; exit 1; }
}

# guard <rev>: what this path must never ship, judged on the branch's own changes.
guard() {
  local hit
  hit=$(mg diff --no-renames --name-only "$base...$1" | grep -E '^(\.github/|deploy/)' | head -n 3 | paste -sd ' ' - || true)
  if [[ -n $hit ]]; then
    echo "changes .github/ or deploy/ ($hit)"; return 1
  fi
  if [[ -n $(mg diff --no-renames --name-only --diff-filter=MD "$base...$1" -- "$MIGRATIONS_DIR") ]]; then
    echo "changes an existing migration"; return 1
  fi
}

# ---------------------------------------------------------------- model turns
# agent <phase> <timeout> <message>: one turn of the session in $sid (empty: a new session,
# whose id is kept in $sid). Tries $impl_model first when set (same model, warm cache), then the
# others; a model that is cooling is skipped. A model error (non-zero exit plus an error event; a
# timeout is not one) cools that model and moves to the next; when none is left the lane exits
# in state `backoff`. A pending steer is prepended; a steer that arrives mid-turn cuts the turn
# (return 75 from isb), resumes the same session with the steer, and carries on.
agent() {
  local phase=$1 tmo=$2 msg=$3 orig stg i m rc out t0 merr cls rl stl tok cost cur carry="" resumed=0 steers=0 order=() resume=()
  gate_halt
  gate_stop
  stg=$(phase_stage "$phase")
  if [[ -n $stg ]]; then stage "$stg"; fi
  if [[ -n $STEER_MSG ]]; then
    steer_take
    msg="Steer from a human: $STEER_TAKEN

$msg"
  fi
  orig=$msg
  models_refresh
  if [[ -n $impl_model ]] && ! is_cooling "$impl_model" && printf '%s\n' "${EFF_MODELS[@]}" | grep -qxF "$impl_model"; then
    order+=("$impl_model")
  fi
  for m in "${EFF_MODELS[@]}"; do
    if [[ $m != "${impl_model:-}" ]] && ! is_cooling "$m"; then order+=("$m"); fi
  done
  if (( ${#order[@]} == 0 )); then
    record --arg kind outcome --arg outcome retry --arg model ""
    lane_exit backoff "every model is cooling down $(earliest_cooldown_note)"
  fi
  for (( i = 0; i < ${#order[@]}; i++ )); do
    m=${order[i]} cur=${carry:-$msg} steers=0 resumed=0 carry=""
    while :; do
      out=$run/$phase-$i
      if (( steers > 0 )); then out+="-s$steers"; fi
      resume=()
      if [[ -n $sid ]]; then resume=(-s "$sid"); fi
      log "$phase: ${m#opencode/}${sid:+ (session $sid)}"
      turn_begin "$phase" "$out.jsonl" "$m"
      rc=0 t0=$(now)
      pg_sweep
      # --print-logs --log-level WARN: opencode's own errors (a rate limit it retries silently)
      # go to stderr, which the watchdog in isb reads.
      ISB_CRED_EXTRA=$(go_credential "$m") ISB_KIND=turn ISB_EVENTS="$out.jsonl" ISB_ERR="$out.err" isb "$tmo" factory-opencode run --auto --format json \
        --print-logs --log-level WARN -m "$(go_real_model "$m")" --title "issue #$n" "${resume[@]}" "$cur" \
        > "$out.jsonl" 2> "$out.err" || rc=$?
      turn_end
      if (( rc != 0 && rc != 75 && rc != 76 && rc != 77 )) && unit_hit_memory_cap "$ISB_UNIT"; then
        # Not the model's fault and not the issue's: the sandbox ran out of memory. Park; the
        # claim is released and the issue stays pickable, never labelled agent-failed.
        record --arg kind outcome --arg outcome oom --arg model "$m"
        log "$phase: sandbox $ISB_UNIT hit its memory cap (${SB_MEMORY_MAX_GB}G); parking, issue #$n not failed"
        lane_exit backoff "the sandbox ran out of memory in $phase; issue #$n released, not failed"
      fi
      tok=$(jsonl_tokens "$out.jsonl")
      ST_TOK_IN=$(( ST_TOK_IN + $(jq .input <<<"$tok") )); ST_TOK_OUT=$(( ST_TOK_OUT + $(jq .output <<<"$tok") ))
      ST_TOK_REASON=$(( ST_TOK_REASON + $(jq .reasoning <<<"$tok") )); ST_TOK_CACHE=$(( ST_TOK_CACHE + $(jq .cache_read <<<"$tok") ))
      # Money guard. Free models must cost nothing: cost > 0 from one of them means the box is
      # spending money, so every lane halts. Only opencode-go/ models may cost; each of their
      # turns goes to the root ledger $STATE/spend.jsonl (the budgets are enforced in models_refresh).
      cost=$(jsonl_cost_sum "$out.jsonl"); [[ $cost =~ ^[0-9.eE+-]+$ ]] || cost=0
      RUN_COST=$(jq -n "$RUN_COST + $cost | . * 1000000 | round / 1000000")
      if is_go_model "$m"; then
        spend_record "$m" "$cost"
      elif jsonl_cost_positive "$out.jsonl"; then
        record --arg kind call --arg phase "$phase" --arg model "$m" --argjson rc "$rc" --argjson model_error false \
          --argjson rate_limited false --argjson stalled false --argjson cost "$cost" --argjson secs "$(( $(now) - t0 ))" --argjson tokens "$tok"
        halt cost "step_finish with cost > 0 from $m ($phase, issue #$n)"
      fi
      if (( rc == 75 )); then
        steers=$(( steers + 1 ))
        steer_take
        sb 10 rm -f .git/index.lock || true
        if [[ -z $sid ]]; then
          sid=$(jsonl_first_session "$out.jsonl")
          ST_SESSION=$sid
        fi
        record --arg kind call --arg phase "$phase" --arg model "$m" --argjson rc 75 --argjson model_error false \
          --argjson rate_limited false --argjson stalled false --argjson cost "$cost" --argjson secs "$(( $(now) - t0 ))" --argjson tokens "$tok"
        if (( steers > 8 )); then log "more than 8 steers in one turn; carrying on without resuming"; break; fi
        if [[ -n $sid ]]; then
          cur="Steer from a human: $STEER_TAKEN

$(phase_contract "$phase")

Carry on from where things stand; what you have done so far is still in the working tree."
          resumed=1
        else
          cur="Steer from a human: $STEER_TAKEN

$orig"
          resumed=0
        fi
        continue
      fi
      merr=false cls=none rl=false stl=false
      if (( rc == 76 )); then
        merr=true cls=rate_limit rl=true     # the watchdog saw the rate limit in opencode's log
        if [[ ${WD_RESULT:-} == usage_cap ]]; then cls=usage_cap; fi   # ... or the weekly Go cap
      elif (( rc == 77 )); then
        merr=true cls=stalled stl=true       # no events and no CPU for IDLE_TIMEOUT
      elif (( rc != 0 )) && events "$out.jsonl" | jq -e -s 'any(.[]; .type == "error")' >/dev/null; then
        merr=true
        cls=$(err_class "$out.jsonl")
        if [[ $cls == rate_limit || $cls == usage_cap ]]; then rl=true; fi
      fi
      record --arg kind call --arg phase "$phase" --arg model "$m" --argjson rc "$rc" --argjson model_error "$merr" \
        --argjson rate_limited "$rl" --argjson stalled "$stl" --argjson cost "$cost" --argjson secs "$(( $(now) - t0 ))" --argjson tokens "$tok"
      if [[ $merr == false ]]; then
        if (( rc != 0 )); then log "opencode exited $rc without a model error (timeout?)"; fi
        if [[ -z $sid ]]; then sid=$(jsonl_first_session "$out.jsonl"); fi
        ST_SESSION=$sid ST_MODEL=$m
        last_out=$out.jsonl last_model=$m used+=("$phase=${m#opencode/}")
        cooldown_reset "$m"
        req_refresh
        return 0
      fi
      if (( rc == 76 || rc == 77 )); then
        log "watchdog: ${m#opencode/} $cls; cooling it and moving on"
      else
        log "model error from ${m#opencode/} ($cls): $(events "$out.jsonl" | jq -r -s '[.[] | select(.type == "error") | .error.data.message // .error.name] | first' | head -c 200)"
      fi
      if (( resumed )) && (( rc != 76 && rc != 77 )); then
        # The resumed session failed: start a fresh one from the working tree, with the steer.
        resumed=0 sid="" ST_SESSION=""
        cur="$issue_text

Steer from a human: $STEER_TAKEN

Carry on from the working tree as it is: part of the work may already be in commits and in uncommitted files (see git status and git log $base..HEAD). Do not start from scratch.

$orig"
        continue
      fi
      cooldown_hit "$m" "$cls"
      if [[ $cls == usage_cap ]]; then
        # Cooled until the next Monday 00:00 UTC: say what matched, so a wrong detection can be seen
        # and undone (rm "$(cooldown_file <model>)" = /var/lib/factory/cooldown/<model>).
        ev=$(err_log_usage_cap_line "$out.err" 0 | head -c 300) || ev=""
        if [[ -z $ev ]]; then ev=$(events "$out.jsonl" | jq -r -s '[.[] | select(.type == "error") | .error.data.message // .error.name] | first' | head -c 300); fi
        log "usage_cap: Go quota used up; ${m#opencode/} cools down until $(date -u -d "@$(cooldown_until "$m")" '+%a %F %H:%MZ') (weekly reset, the payload carries no reset time). Matching line: $ev"
      fi
      if (( rc == 76 || rc == 77 )); then
        # Not the issue's fault: the model is cooled, and the NEXT model resumes THE SAME session
        # (-s <sid>) from the working tree. Without a session id (nothing was printed) the next
        # model simply starts the turn again.
        if [[ -z $sid ]]; then sid=$(jsonl_first_session "$out.jsonl"); ST_SESSION=$sid; fi
        if [[ -n $sid ]]; then
          sb 10 rm -f .git/index.lock || true
          carry="$(phase_contract "$phase")

The previous turn was cut off because of model ${m#opencode/} ($cls). Carry on from where things stand; what you have done so far is still in the working tree."
        fi
        models_refresh
      fi
      break
    done
  done
  record --arg kind outcome --arg outcome retry --arg model ""
  models_refresh
  lane_exit backoff "every model failed in $phase; models return $(earliest_cooldown_note)"
}

# ---------------------------------------------------------------- per-lane Postgres
# DB integration tests (typically: read $PG_TEST_ENV, TEST_DATABASE_URL by default, create one throwaway
# database per test, migrated fresh) skip without a server, and the sandbox cannot reach any: it denies
# localhost and private IPs. So each lane gets its own Postgres on a UNIX SOCKET only
# (listen_addresses = ''), as a transient unit in the lane's slice (stopping the slice kills it
# too), running as factory with its data under s<K>/pg. Everything that touches the agent's
# files is done as the agent through the sandbox (root never follows paths the agent can plant);
# root's only act there is `systemd-run` of the server binary, which is root-owned.
# The server binaries (postgresql-16 deb unpacked, no service) live in PG_BIN; missing = no DB,
# tests skip exactly as before. Whatever fails here is logged and never fails an issue.
# The environment variable that carries the lane's database URL to the tests (sandbox.sh sets it).
# Set to empty (the "-" form of the expansion keeps it empty): the repo has no database
# tests yet, so no per-lane Postgres is started at all.
PG_TEST_ENV=${PG_TEST_ENV-TEST_DATABASE_URL}
PG_BIN=${PG_BIN:-/usr/local/lib/factory-pg16/usr/lib/postgresql/16/bin}
PG_ISREADY=${PG_ISREADY:-/usr/lib/postgresql/16/bin/pg_isready}
PG_PSQL=${PG_PSQL:-/usr/lib/postgresql/16/bin/psql}

# pg_sweep: drop the per-test databases a test harness left behind. A harness that creates one
# database per test (<PG_SWEEP_PREFIX><test>_<32 hex>) and drops it only when the test reaches its
# cleanup leaks one per failing test; during a long build/fix loop that reached 7-10 GB per lane.
# Called before every model turn and before verify, i.e. when no test of this lane runs. Runs as
# the agent inside the sandbox, against the lane's own socket only. PG_SWEEP_PREFIX must be a plain
# [a-z0-9_] prefix; empty switches the sweep off.
PG_SWEEP_PREFIX=${PG_SWEEP_PREFIX-test_}
pg_sweep() {
  pg_ensure
  [[ -n ${SB_PG_URL:-} && -x $PG_PSQL && $PG_SWEEP_PREFIX =~ ^[a-z0-9_]+$ ]] || return 0
  "$SANDBOX" "$SLOTDIR" 120 bash -c '
    "$1" -h "$2" -U factory -d postgres -X -q -At -c "select format(\$q\$DROP DATABASE IF EXISTS %I;\$q\$, datname) from pg_database where datname ~ \$q\$^$3[a-z0-9_]+_[0-9a-f]{32}\$\$q\$" \
      | "$1" -h "$2" -U factory -d postgres -X -q >/dev/null 2>&1' pgsweep "$PG_PSQL" "$SLOTDIR/pg" "$PG_SWEEP_PREFIX" </dev/null 9>&- >/dev/null 2>&1 || true
  return 0
}
PG_WAIT=${PG_WAIT:-30}
pg_unit() { echo "factory-pg-s$K"; }
pg_stop() {
  systemctl stop "$(pg_unit).service" >/dev/null 2>&1 || true
  unset SB_PG_URL
  return 0
}

# pg_ensure: the lane's server must still be up whenever a turn or verify is about to use it (pg_sweep
# calls this first, and pg_sweep runs before every model turn and every verify). It has been taken
# away mid-run: a test suite run as root on the host stopped a lane's server, and one lane's agent,
# working around that, killed another lane's postmaster by PID (every lane runs as factory).
# SB_PG_URL still pointed at the dead socket, pg_start returned early, verify failed every DB test
# with "No such file or directory", and the issue was labelled agent-failed for something no turn
# could fix. Down: a fresh cluster, exactly as at the start of the run (tests create their own
# databases; nothing in it outlives a run on purpose).
pg_ensure() {
  [[ -n ${SB_PG_URL:-} ]] || return 0
  if [[ $(systemctl show -p ActiveState --value "$(pg_unit).service" 2>/dev/null) == active && -e $SLOTDIR/pg/.s.PGSQL.5432 ]]; then
    return 0
  fi
  log "per-lane Postgres $(pg_unit) went away mid-run: starting a fresh one"
  unset SB_PG_URL
  pg_start
}

# pg_fix_hint: the sentence about the lane's database in the CI-failure prompt, or nothing when the
# instance has none (PG_TEST_ENV empty). Ends in a space so it can sit in front of the next sentence.
pg_fix_hint() {
  local cmd='cargo test -p <crate> <name>'
  [[ -n $PG_TEST_ENV ]] || return 0
  if [[ $VERIFY_KIND == node ]]; then cmd='npm test -- <name>'; fi
  printf 'If the failing test needs Postgres: this sandbox has its own Postgres through %s (unix socket) while the lane runs, so run that test directly (%s) to reproduce it. ' "$PG_TEST_ENV" "$cmd"
}
pg_start() {
  local dir=$SLOTDIR/pg unit enc i ready=0
  if [[ -n ${SB_PG_URL:-} ]]; then return 0; fi   # already up in this run
  [[ ${PG_ENABLE:-1} == 1 && -n $PG_TEST_ENV ]] || return 0
  if [[ ! -x $PG_BIN/initdb || ! -x $PG_BIN/postgres ]]; then
    log "per-lane Postgres: no server binaries in $PG_BIN; DB tests will skip"
    return 0
  fi
  safe_dir "$H" && safe_dir "$SLOTDIR" || { log "per-lane Postgres: $SLOTDIR is not a plain directory"; return 0; }
  unit=$(pg_unit)
  pg_stop
  # A fresh cluster per run: no state leaks from one issue to the next.
  if ! "$SANDBOX" "$SLOTDIR" 180 bash -c 'rm -rf pg && mkdir -m 700 pg && "$1/initdb" -D pg/data -U factory --auth=trust --locale=C.UTF-8 -E UTF8 -N >/dev/null' pg "$PG_BIN" </dev/null 9>&-; then
    log "per-lane Postgres: initdb failed; DB tests will skip"
    return 0
  fi
  if ! systemd-run --quiet --collect --unit="$unit" --slice="factory-s$K.slice" --uid=factory --gid=factory \
      -p ProtectSystem=strict -p "ReadWritePaths=$dir" -p PrivateTmp=yes -p NoNewPrivileges=yes \
      -p RestrictAddressFamilies=AF_UNIX -p IPAddressDeny=any -p MemoryMax=4G -p CPUQuota=200% -p TasksMax=512 -p Nice=10 \
      "$PG_BIN/postgres" -D "$dir/data" -c listen_addresses= -c "unix_socket_directories=$dir" -c unix_socket_permissions=0700 \
      -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c shared_buffers=256MB -c max_connections=400 \
      </dev/null 9>&-; then
    log "per-lane Postgres: could not start $unit; DB tests will skip"
    return 0
  fi
  for (( i = 0; i < PG_WAIT; i++ )); do
    if "$SANDBOX" "$SLOTDIR" 15 "$PG_ISREADY" -q -h "$dir" -U factory </dev/null 9>&-; then ready=1; break; fi
    sleep 1
  done
  if (( ! ready )); then
    log "per-lane Postgres: not ready after ${PG_WAIT}s; DB tests will skip"
    pg_stop
    return 0
  fi
  # The socket directory, percent-encoded into the authority: the tests split the URL at its last
  # "/" to reach the maintenance database, so the path must not contain one (a ?host=/... would).
  enc=$(printf '%s' "$dir" | sed 's|/|%2F|g')
  export SB_PG_URL="postgres://factory@$enc/postgres"
  log "per-lane Postgres up: $unit"
  return 0
}

# VERIFY_KIND=cargo; mirror your ci.yml. Playwright is a second sandbox call (below): it needs
# loopback, which the normal sandbox denies. A repo can add its own checks in an executable
# scripts/verify-extra.sh, run first (e.g. a lint that keeps logic out of the UI layer). Postgres tests run against the lane's own server (pg_start,
# $PG_TEST_ENV via sandbox.sh) and skip, as in CI without a database, when there is none.
verify() {
  pg_sweep
  if [[ $VERIFY_KIND == node ]]; then verify_node; return $?; fi
  ISB_KIND=verify isb "$VERIFY_TIMEOUT" bash -c '
    fail=0
    step() { echo "### $*"; "$@" || { echo "### FAILED: $*"; fail=1; }; }
    if [[ -n $(git status --porcelain) ]]; then echo "### FAILED: working tree not clean"; git status --short; fail=1; fi
    if [[ -x scripts/verify-extra.sh ]]; then step scripts/verify-extra.sh; fi
    step cargo build --workspace --locked
    step cargo test --workspace --locked
    if [[ -f frontend/package.json ]] && ! git diff --quiet "$1...HEAD" -- frontend; then
      # The browser download needs the network, so it happens here and not in the private-net run.
      cd frontend && step npm ci --no-audit --no-fund && step npm run typecheck --if-present && step npm run build \
        && step npx playwright install chromium
    fi
    exit $fail' verify "$base" || return $?
  # Playwright: CI's "frontend e2e" step, same CI=1. SB_PRIVATE_NET=1 gives this one unit its own
  # network namespace, so astro preview on 127.0.0.1:4322 is reachable from the browser while the
  # host's loopback (Postgres, the host's other services, ...) is not. npm ci and the browser download ran above.
  if ! sb 60 git diff --quiet "$base...HEAD" -- frontend && sb 60 test -f frontend/package.json; then
    SB_PRIVATE_NET=1 ISB_KIND=verify isb "$E2E_TIMEOUT" bash -c '
      cd frontend
      echo "### CI=1 npm run test:e2e"
      CI=1 npm run test:e2e || { echo "### FAILED: npm run test:e2e"; exit 1; }'
  fi
}

# VERIFY_KIND=node. A Node project has one npm tree at the repo root, so the steps are CI's, in the
# sandbox: npm ci, `check` and `test` when package.json has them (--if-present), build, and the
# Playwright suite only when there is an `e2e` script. The sandbox sees package.json through
# node, which is on every box that has npm (jq is not promised inside it).
NODE_HAS_SCRIPT_JS='process.exit((require("./package.json").scripts || {})[process.argv[1]] ? 0 : 1)'
node_has_script() { sb 60 node -e "$NODE_HAS_SCRIPT_JS" "$1"; }
verify_node() {
  ISB_KIND=verify isb "$VERIFY_TIMEOUT" bash -c '
    fail=0 js=$1
    step() { echo "### $*"; "$@" || { echo "### FAILED: $*"; fail=1; return 1; }; }
    has_script() { node -e "$js" "$1"; }
    # A script the project does not have is said so in the log, because the PR text lists what ran.
    optional() { if has_script "$1"; then step "${@:2}"; else echo "### skipped: npm run $1 (package.json has no $1 script)"; fi; }
    if [[ -n $(git status --porcelain) ]]; then echo "### FAILED: working tree not clean"; git status --short; fail=1; fi
    # Each step needs the one before it: step returns 1 on failure, so the first one ends the chain
    # and the fix turn is shown one error, not the noise behind it.
    step npm ci --no-audit --no-fund \
      && optional check npm run check --if-present \
      && step npm run build \
      && optional test npm test --if-present \
      && { ! has_script e2e || step npx playwright install chromium; }
    exit $fail' verify "$NODE_HAS_SCRIPT_JS" || return $?
  # Playwright, same as for cargo: its own sandbox call with a private network namespace (the browser
  # reaches the preview server on the unit's own loopback, nothing of the host's). npm ci and the
  # browser download ran above, in the call that has the network.
  if node_has_script e2e; then
    SB_PRIVATE_NET=1 ISB_KIND=verify isb "$E2E_TIMEOUT" bash -c '
      echo "### CI=1 npm run e2e"
      CI=1 npm run e2e || { echo "### FAILED: npm run e2e"; exit 1; }'
  fi
}

# node_steps <verify-log>: "ran|skipped": the steps verify_node's log shows, comma-separated, for the
# summaries posted to PRs and handed to the reviewer.
node_steps() {
  local ran skipped
  ran=$(grep -E '^### ' "$1" 2>/dev/null | grep -vE '^### (FAILED|skipped)' | sed -E 's/^### //; s/ --no-audit --no-fund$//; s/ --if-present$//' \
    | sed -E 's/^CI=1 npm run e2e$/Playwright (npm run e2e)/; s/^npx playwright install chromium$/download Chromium/' | paste -sd, - | sed 's/,/, /g' || true)
  skipped=$(sed -nE 's/^### skipped: (npm run [^ ]+) .*/\1/p' "$1" 2>/dev/null | paste -sd, - | sed 's/,/, /g' || true)
  printf '%s|%s' "$ran" "$skipped"
}

# verify_digest_node <log> <head>: verify_digest for VERIFY_KIND=node. Says what the log shows ran,
# nothing about cargo or a database.
verify_digest_node() {
  local steps ran skipped
  steps=$(node_steps "$1"); ran=${steps%%|*}; skipped=${steps#*|}
  printf '%s\n' "--- root verify result (already run, PASSED) ---" \
    "HEAD ${2:0:12}: ${ran:-no steps recorded}${skipped:+ (skipped, package.json has no script for: $skipped)}. Last 25 lines of its log:" '```'
  tail -n 25 "$1" 2>/dev/null
  printf '%s\n' '```' "--- end of verify result ---"
}

# verify_digest <log> <head>: what the reviewer is told about the verify that just passed.
verify_digest() {
  local log=$1 head=${2:-} passed failed ignored db="no"
  if [[ $VERIFY_KIND == node ]]; then verify_digest_node "$log" "$head"; return 0; fi
  read -r passed failed ignored < <(grep -oE 'test result: [a-zA-Z]+\. [0-9]+ passed; [0-9]+ failed; [0-9]+ ignored' "$log" 2>/dev/null \
    | awk '{p += $4; f += $6; i += $8} END {print p + 0, f + 0, i + 0}')
  if [[ -n ${SB_PG_URL:-} ]]; then db="yes"; fi
  printf '%s\n' "--- root verify result (already run, PASSED) ---" \
    "HEAD ${head:0:12}: scripts/verify-extra.sh if present, cargo build --workspace, cargo test --workspace (${passed:-0} passed, ${failed:-0} failed, ${ignored:-0} ignored; Postgres for DB tests: $db)," \
    "the frontend build, and Playwright (e2e) when frontend/ changed. Last 25 lines of its log:" '```'
  tail -n 25 "$log" 2>/dev/null
  printf '%s\n' '```' "--- end of verify result ---"
}

# fix_loop <label> <stage>: verify; on failure give the current session up to FIX_ROUNDS turns.
fix_loop() {
  local r label=$1 stg=${2:-verify}
  FAIL_DETAIL=""
  for (( r = 1; r <= FIX_ROUNDS + 1; r++ )); do
    stage "$stg" ""
    if verify > "$run/verify-$label-$r.log" 2>&1; then
      verified_head=$(sb 60 git rev-parse HEAD)
      VERIFY_DIGEST=$(verify_digest "$run/verify-$label-$r.log" "$verified_head")
      ST_SUB=""
      req_refresh
      return 0
    fi
    log "verify $label/$r failed"
    (( r <= FIX_ROUNDS )) || { FAIL_DETAIL=$(fail_lines 40 < "$run/verify-$label-$r.log") || true; return 1; }
    stage "$stg" "fix $r/$FIX_ROUNDS"
    agent "fix-$label-$r" "$AGENT_TIMEOUT" "The automatic verify failed. These are the last 150 lines of its log:

\`\`\`
$(tail -n 150 "$run/verify-$label-$r.log")
\`\`\`

Fix the cause, not the symptom. Run the failing command again until it passes, then commit."
  done
}

# steer_point <label> <stage>: a steer that arrived with no turn left to carry it is applied now
# (a steer turn, then verify). Nothing pending: no-op.
steer_point() {
  gate_stop
  [[ -n $STEER_MSG ]] || return 0
  agent "steer-$1" "$AGENT_TIMEOUT" "Apply the human's steer above to the work already on this branch.

$(phase_contract steer-)"
  fix_loop "steer-$1" "$2"
}

# checklist_todo: requirements in .git/agent-checklist.json not yet done, as a JSON array.
# A missing or malformed checklist counts as one undone item, so it cannot pass by absence.
checklist_todo() {
  sb 60 cat .git/agent-checklist.json 2>/dev/null \
    | jq -c '[.[] | select(.done != true) | .item]' 2>/dev/null \
    || echo '["write a valid .git/agent-checklist.json: one {item, done, evidence} object per requirement"]'
}

# complete_loop: give the author more turns, in the same session, until every requirement of the
# issue is done, or COMPLETE_ROUNDS run out. Each round must pass verify.
complete_loop() {
  local r todo
  for (( r = 1; r <= COMPLETE_ROUNDS; r++ )); do
    todo=$(checklist_todo)
    if [[ $todo == "[]" ]]; then return 0; fi
    log "completion $r: $(jq -r length <<<"$todo") requirement(s) not done"
    stage build "complete $r/$COMPLETE_ROUNDS"
    agent "complete$r" "$AGENT_TIMEOUT" "This issue is not finished yet. Still open according to the checklist:

$(jq -r '.[] | "- " + .' <<<"$todo")

Do all of it now, wired to where the issue asks for it and covered by tests. Run the build and tests until they pass, commit, then update .git/agent-checklist.json honestly."
    fix_loop "complete$r" verify || return 1
  done
}

load_issue() {  # load_issue <n>: $title and $issue_text, plus earlier merged slices
  "$GH" issue view "$1" -R "$REPO" --json number,title,body,labels,milestone,comments,state > "$run/issue.json"
  title=$(jq -r .title "$run/issue.json")
  issue_begin "$1" "$title"
  issue_text=$(jq -r '
    "Issue #\(.number): \(.title)\n"
    + "Label: \([.labels[].name] | join(", "))\n"
    + "Milestone: \(.milestone.title // "-")\n\n"
    + "--- issue body ---\n\(.body)\n"
    + "--- comments ---\n\([.comments[] | "[\(.author.login)]\n\(.body)"] | join("\n\n"))\n"
    + "--- end of issue ---"' "$run/issue.json")
  local slices
  slices=$("$GH" pr list -R "$REPO" --state merged --head "agent/issue-$1" -L 50 --json number,title,body \
    | jq -r 'map("#\(.number) \(.title)\n\(.body | .[0:1500])") | join("\n\n")')
  if [[ -n $slices ]]; then
    issue_text+="

--- slices of this issue that were already merged ---
$slices
--- end of slices ---"
  fi
}

# review_branch: a fresh session reviews the checked-out branch against main and fixes what it
# can prove, then the author's session repairs anything that broke. Sets $review_text. Only
# after this may a PR carry agent-reviewed.
review_branch() {
  local author_sid=$sid before
  before=$(sb 60 git rev-parse HEAD)
  sid=""
  agent review "$AGENT_TIMEOUT" "$issue_text

$(cat "$PROMPTS/review.md")
${VERIFY_DIGEST:+
$VERIFY_DIGEST}"
  sid=$author_sid
  review_text=$(sb 60 head -c 8000 .git/agent-review.md 2>/dev/null || echo "_(the reviewer wrote no findings)_")
  # A review that changed nothing leaves the HEAD that already passed verify: skip the rebuild
  # and retest. Anything it touched, committed or not, is verified again.
  if [[ $(sb 60 git rev-parse HEAD) == "$before" && -z $(sb 60 git status --porcelain) && ${verified_head:-} == "$before" ]]; then
    log "review changed nothing; $before already verified"
    return 0
  fi
  fix_loop review review || return 1
}

# ---------------------------------------------------------------- CI and deploy
# playwright_gate_on: whether a CI job that fails only in Playwright fails the PR. On by default.
# A repo whose e2e suite is red on main can set PLAYWRIGHT_GATE_AFTER=<issue number> (the issue that
# makes the suite green again): Playwright is then not a gate until that issue is closed as
# completed, since gating on a red suite would fail every PR. sync's github.json `done` says when it
# closed. PLAYWRIGHT_GATE=1 or 0 forces it either way.
PLAYWRIGHT_GATE_AFTER=${PLAYWRIGHT_GATE_AFTER:-}
playwright_gate_on() {
  case ${PLAYWRIGHT_GATE:-} in 1) return 0 ;; 0) return 1 ;; esac
  [[ -n $PLAYWRIGHT_GATE_AFTER ]] || return 0
  [[ -f $UI/github.json && ! -L $UI/github.json ]] || return 1
  jq -e --argjson n "$PLAYWRIGHT_GATE_AFTER" 'any(.done[]?; .n == $n and .reason == "completed")' "$UI/github.json" >/dev/null 2>&1
}

# ci_poll <sha>: CI_STATE = pass | fail | pending, keyed on the commit so an older head's checks
# never answer for a newer one. A failed job whose only failed steps are Playwright passes while
# playwright_gate_on is false.
# Main shell (it updates the status); never inside $(...).
ci_poll() {
  local runs id steps
  CI_STATE=pending
  runs=$("$GH" api "repos/$REPO/commits/$1/check-runs?per_page=100" -q '[.check_runs[] | {id, name, status, conclusion}]' 2>/dev/null) || return 0
  [[ -n $runs ]] || return 0
  ST_CI_JSON=$(jq -c --arg head "$1" '{head: $head, checks: map({name, status, conclusion})}' <<<"$runs")
  if jq -e 'length > 0 and all(.[]; .status == "queued")' <<<"$runs" >/dev/null; then
    ST_SUB="waiting runner"
  elif [[ $ST_SUB == "waiting runner" ]]; then
    ST_SUB=""
  fi
  if jq -e 'length == 0 or any(.[]; .status != "completed")' <<<"$runs" >/dev/null; then return 0; fi
  for id in $(jq -r '.[] | select(.conclusion | IN("failure", "cancelled", "timed_out", "action_required")) | .id' <<<"$runs"); do
    steps=$("$GH" api "repos/$REPO/actions/jobs/$id" -q '[.steps[] | select(.conclusion == "failure") | .name]' 2>/dev/null || echo '[]')
    if ! playwright_gate_on && jq -e 'length > 0 and all(.[]; test("playwright"; "i"))' <<<"$steps" >/dev/null; then
      log "check run $id failed only in Playwright: not a gate (yet, see playwright_gate_on)"
    else
      CI_STATE=fail
      return 0
    fi
  done
  CI_STATE=pass
  return 0
}

# main_ci_red: true when the newest COMPLETED push run of deploy.yml on main has a failed `ci` job
# (failure or timed_out; skipped and cancelled do not count). Then a CI failure on a PR is not
# necessarily the PR's: one red spec on main once hit 33 runs of 15 branches, and every lane spent
# its fix rounds on it. Limit, on purpose: this catches only failures that also turned main
# red. An environment fault that leaves main green (the runner short of disk or memory at that
# moment, a test that happened to pass on main) is not seen, and those PRs still get fix rounds.
# A failed GitHub lookup counts as "not red": the guard never blocks on a call that errored.
MAIN_RED_RUN=""
main_ci_red() {
  local id
  id=$("$GH" run list -R "$REPO" --workflow deploy.yml --event push --branch main --status completed -L 1 \
    --json databaseId -q '.[0].databaseId' 2>/dev/null) || return 1
  [[ $id =~ ^[0-9]+$ ]] || return 1
  "$GH" api "repos/$REPO/actions/runs/$id/jobs?per_page=100" \
    -q '[.jobs[] | select((.name == "ci" or (.name | startswith("ci /"))) and (.conclusion | IN("failure", "timed_out")))] | length' 2>/dev/null \
    | grep -qx '[1-9][0-9]*' || return 1
  MAIN_RED_RUN=$id
  return 0
}

# ci_rerun <sha>: re-run the failed jobs of <sha> once, before a fix round is spent on them, and wait
# until GitHub has registered the new attempt. Two flaky e2e specs once failed both Playwright
# attempts on PRs that never touched them; main stayed green because its own retries happened to
# pass, so main_ci_red did not fire, and each lane burnt CI_FIX_ROUNDS on a test it did not break
# and labelled four issues agent-failed.
# A re-run costs one CI run and is done once per head (the caller keeps that), so a real failure
# still reaches the fix turn, one run later. Returns 1 when nothing was re-run (CI_RERUN=0, no
# Actions run behind the failed checks, GitHub refused), and the caller goes on to the fix round.
CI_RERUN=${CI_RERUN:-1}
CI_RERUN_REGISTER=${CI_RERUN_REGISTER:-180}
ci_rerun() {
  local failed runs r ok=1 t0 now_ids
  (( CI_RERUN )) || return 1
  failed=$("$GH" api "repos/$REPO/commits/$1/check-runs?per_page=100" \
    -q '[.check_runs[] | select(.conclusion | IN("failure", "timed_out", "cancelled"))
         | {id, run: ((((.details_url // "") | capture("/actions/runs/(?<r>[0-9]+)(/|$)")?) | .r) // null)}]' 2>/dev/null) || return 1
  runs=$(jq -r '[.[].run | select(. != null)] | unique | .[]' <<<"${failed:-[]}" 2>/dev/null) || return 1
  for r in $runs; do
    [[ $r =~ ^[0-9]+$ ]] || continue
    if "$GH" api -X POST "repos/$REPO/actions/runs/$r/rerun-failed-jobs" >/dev/null 2>&1; then ok=0
    else log "re-run of Actions run $r refused by GitHub"; fi
  done
  (( ok == 0 )) || return 1
  # The commit's latest check runs keep showing the old failures until the new attempt exists; a
  # poll before that would read the stale failure as the re-run's verdict.
  t0=$(now)
  while (( $(now) - t0 < CI_RERUN_REGISTER )); do
    isleep 10
    now_ids=$("$GH" api "repos/$REPO/commits/$1/check-runs?per_page=100" -q '[.check_runs[].id]' 2>/dev/null) || continue
    if jq -e --argjson old "$(jq -c '[.[].id]' <<<"$failed")" '. as $now | $old | map(. as $o | $now | any(.[]; . == $o)) | any | not' <<<"$now_ids" >/dev/null 2>&1; then
      return 0
    fi
  done
  log "re-run requested for $1 but GitHub did not show new check runs within ${CI_RERUN_REGISTER}s"
  return 0
}

# wait_ci <sha>: WAIT_RESULT = pass | fail | timeout | steer (a steer arrived: go apply it).
wait_ci() {
  local t0; t0=$(now)
  while :; do
    ci_poll "$1"
    st_flush
    if [[ $CI_STATE != pending ]]; then WAIT_RESULT=$CI_STATE; return 0; fi
    if [[ -n $STEER_MSG ]]; then WAIT_RESULT=steer; return 0; fi
    if (( $(now) - t0 > CI_TIMEOUT )); then WAIT_RESULT=timeout; return 0; fi
    isleep 30
  done
}

# job_log <job id>: one CI job's log, colour codes removed. --allow-escape-sequences is required:
# gh 2.102 refuses to print an API response that contains terminal escapes (Playwright and cargo
# colour their logs), prints nothing on stdout and says why on stderr. Without it every failed job
# came back empty, so a CI fix turn saw no log at all (and once "fixed" a spec that was not the red
# one) and the agent-failed comment named only the job.
job_log() {
  "$GH" api --allow-escape-sequences "repos/$REPO/actions/jobs/$1/logs" 2>/dev/null \
    | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' || true
}

ci_log() {  # ci_log <sha>: tails of the failed jobs' logs
  local id name out
  while IFS=$'\t' read -r id name; do
    [[ $id =~ ^[0-9]+$ ]] || continue
    echo "### job $id ($name)"
    out=$(job_log "$id" | tail -n 120)
    if [[ -n $out ]]; then printf '%s\n' "$out"; else echo "(this job's log could not be fetched from GitHub)"; fi
  done < <("$GH" api "repos/$REPO/commits/$1/check-runs?per_page=100" \
    -q '.check_runs[] | select(.conclusion == "failure") | "\(.id)\t\(.name)"' 2>/dev/null || true)
}

# fail_lines [max]: stdin (a CI job log or a verify log) -> the lines that name what failed, for
# FAIL_DETAIL. Strips GitHub's timestamp prefix and colour codes. Patterns are the ones seen in
# real failures: cargo test/rustc/doctest, the bench gate ("FAIL: fastest of 51 runs"), Playwright,
# verify's "### FAILED" markers. No match: the last 15 lines, so a failure never comes back empty.
fail_lines() {
  local max=${1:-25} all sel
  all=$(sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //; s/\x1b\[[0-9;]*m//g' | grep -v '^[[:space:]]*$' || true)
  [[ -n $all ]] || return 0
  # A "-->" location is kept only right after an error line: every rustc warning carries one too.
  # A verdict ending in ": FAIL" (e.g. a benchmark gate) keeps the indented lines after it, which
  # carry the numbers; without this the fallback below sent only post-job cleanup.
  # "##[error]" is a script's own ::error:: message, kept unless it is the generic exit-code line.
  sel=$(awk '
    /^error(\[E[0-9]+\])?: / { print; err = 1; next }
    /^ +--> / { if (err) print; err = 0; next }
    { err = 0 }
    /: FAIL$/ { print; detail = 8; next }
    detail > 0 && /^[[:space:]]+[^[:space:]]/ { print; detail--; next }
    { detail = 0 }
    /^##\[error\]/ && !/^##\[error\]Process completed with exit code/ { print; next }
    /### FAILED|\.\.\. FAILED$|^---- .+ stdout ----$|panicked at|test result: FAILED|^FAIL|^ +(left|right): |^ *✘ |^ +[0-9]+\) \[[a-z]+\] › |^ *Error: / { print }' <<<"$all" || true)
  [[ -n $sel ]] || sel=$(tail -n 15 <<<"$all")
  awk '!seen[$0]++' <<<"$sel" | cut -c1-300 | head -n "$max" || true
}

# ci_digest <sha>: each failed job of <sha> by name, with its fail_lines.
ci_digest() {
  local id name
  while IFS=$'\t' read -r id name; do
    [[ $id =~ ^[0-9]+$ ]] || continue
    printf '### %s\n' "$name"
    job_log "$id" | fail_lines 20 || true
  done < <("$GH" api "repos/$REPO/commits/$1/check-runs?per_page=100" \
    -q '.check_runs[] | select(.conclusion == "failure") | "\(.id)\t\(.name)"' 2>/dev/null || true)
}

# mergeable <pr>: MERGEABLE = MERGEABLE | CONFLICTING | UNKNOWN (GitHub computes it lazily)
mergeable() {
  local m i
  MERGEABLE=UNKNOWN
  for i in 1 2 3 4 5 6; do
    m=$("$GH" pr view "$1" -R "$REPO" --json mergeable -q .mergeable)
    if [[ $m != UNKNOWN ]]; then MERGEABLE=$m; return 0; fi
    isleep 20
  done
  return 0
}

# wait_run <run-id>: WAIT_RESULT = its conclusion once completed, or "timeout" once no job of the
# run has started or finished for DEPLOY_TIMEOUT. The deadline restarts on progress because
# deploy.yml may share a single self-hosted runner with PR CI: one run spent 26 min in its own CI
# and 24 min queued behind a PR's CI, so a deadline from the start halted every lane 9 s before
# the run succeeded. A running job is already bounded by its timeout-minutes; what is left to
# catch is a run that stopped moving, such as one queued on an offline runner.
wait_run() {
  local t0 s p last=""; t0=$(now)
  while :; do
    s=$("$GH" run view "$1" -R "$REPO" --json status,conclusion,jobs \
      -q '"\(.status) \([.jobs[].status] | join(",")) \(.conclusion)"')
    if [[ $s == completed* ]]; then WAIT_RESULT=${s##* }; return 0; fi
    p=${s#* }
    if [[ $p != "$last" ]]; then last=$p t0=$(now); fi
    if (( $(now) - t0 > DEPLOY_TIMEOUT )); then WAIT_RESULT=timeout; return 0; fi
    isleep 30
  done
}

only_playwright_failed() {  # only_playwright_failed <run-id>
  "$GH" api "repos/$REPO/actions/runs/$1/jobs?per_page=100" \
    -q '[.jobs[] | select(.conclusion == "failure") | .steps[] | select(.conclusion == "failure") | .name]' \
    | jq -e 'length > 0 and all(.[]; test("playwright"; "i"))' >/dev/null
}

# superseded_deploy <sha>: deploy.yml's concurrency group keeps one running and one pending run;
# a newer push replaces the pending one, so a run for <sha> can end `cancelled` while a later main
# commit (a descendant of <sha>) deploys it anyway. WAIT_RESULT = success once a deploy run of a
# descendant succeeded, failure if one of them failed for real, timeout if none ever showed up.
superseded_deploy() {
  local t0 rows id head st concl pend
  t0=$(now)
  while :; do
    mirror_fetch || true
    rows=$("$GH" run list -R "$REPO" --workflow deploy.yml --event push -L 30 --json databaseId,headSha,status,conclusion \
      -q '.[] | "\(.databaseId) \(.headSha) \(.status) \(.conclusion)"' 2>/dev/null) || rows=""
    pend=0
    while read -r id head st concl; do
      [[ -n ${id:-} && $head != "$1" ]] || continue
      mg merge-base --is-ancestor "$1" "$head" 2>/dev/null || continue
      if [[ $st != completed ]]; then pend=1; continue; fi
      if [[ $concl == success ]]; then
        log "deploy of $1 was superseded; run $id for ${head:0:12} deployed it"
        WAIT_RESULT=success; return 0
      fi
      if [[ $concl != cancelled ]]; then
        log "deploy run $id for ${head:0:12} (contains $1) ended $concl"
        WAIT_RESULT=failure; return 0
      fi
    done <<<"$rows"
    if (( pend == 0 )) && (( $(now) - t0 > 600 )); then WAIT_RESULT=timeout; return 0; fi
    if (( $(now) - t0 > DEPLOY_TIMEOUT )); then WAIT_RESULT=timeout; return 0; fi
    isleep 20
  done
}

# deploy <merge-sha> <pr>: wait for deploy.yml on that commit, then check the site (HEALTH_URL).
# A failed deploy or an unhealthy site halts every lane. Without a HEALTH_URL there is nothing to
# watch (a repo that does not deploy on push): the merge is the end of the line, no halt.
deploy() {
  local id="" c t0 since
  if [[ -z ${HEALTH_URL:-} ]]; then
    log "no HEALTH_URL: deploy watch off, merge of $1 is the last step"; stage live; return 0
  fi
  stage deploy
  if ! "$GH" pr view "$2" -R "$REPO" --json files -q '.files[].path' | grep -qvE '(\.md$|^docs/|^\.gitignore$)'; then
    log "docs-only merge: deploy.yml skips it"; stage live; return 0
  fi
  t0=$(now)
  while [[ -z $id ]]; do
    id=$("$GH" run list -R "$REPO" --workflow deploy.yml --event push -L 20 --json databaseId,headSha \
      -q "[.[] | select(.headSha == \"$1\")] | first | .databaseId // empty")
    if [[ -z $id ]]; then
      (( $(now) - t0 < 600 )) || halt deploy "the deploy for $1 never showed up"
      isleep 20
    fi
  done
  wait_run "$id"; c=$WAIT_RESULT
  if [[ $c != success ]] && only_playwright_failed "$id"; then
    log "deploy run $id blocked only by Playwright: re-dispatching with skip_tests"
    since=$(date -u +%FT%TZ)
    "$GH" workflow run deploy.yml -R "$REPO" --ref main -f ref="$1" -f skip_tests=true
    id="" t0=$(now)
    while [[ -z $id ]]; do
      id=$("$GH" run list -R "$REPO" --workflow deploy.yml --event workflow_dispatch -L 5 --json databaseId,createdAt \
        -q "[.[] | select(.createdAt >= \"$since\")] | first | .databaseId // empty")
      if [[ -z $id ]]; then
        (( $(now) - t0 < 300 )) || halt deploy "the re-deploy without Playwright for $1 never showed up"
        isleep 15
      fi
    done
    wait_run "$id"; c=$WAIT_RESULT
  fi
  if [[ $c == cancelled ]]; then
    log "deploy run $id for $1 was cancelled by a newer push"
    superseded_deploy "$1"; c=$WAIT_RESULT
  fi
  [[ $c == success ]] || halt deploy "deploy of $1 failed ($c), run $id"
  curl -fsS -m 20 "$HEALTH_URL" >/dev/null || halt health "$(health_host) is not healthy after the deploy of $1"
  log "deployed $1; $(health_host) healthy"
  stage live
}

# ---------------------------------------------------------------- one issue
# plan_step <extra-context>: the plan turn (issue text, optional extra context, triage.md), its
# parsed JSON in $plan, and the `blocked` outcome. Shared by implement and adopt.
plan_step() {
  local msg=$issue_text replanned=0 cyc
  if [[ -n ${1:-} ]]; then msg+="

$1"; fi
  msg+="

$(cat "$PROMPTS/triage.md")"
  agent plan "$PLAN_TIMEOUT" "$msg"
  [[ -n $sid ]] || { log "no session id in the plan output"; exit 1; }
  echo "$sid $K" > "$STATE/sessions/$n"
  impl_model=$last_model
  while :; do
    # Last ```json block of the turn, by splitting rather than a regex: the JSON itself carries
    # single backticks (`temperature.rs`), which broke a [^`]* pattern. last_out is the file of
    # the turn that finished the plan, which after a steer is the steered turn.
    plan=$(events "$last_out" | jq -c -s '[.[] | select(.type == "text") | .part.text] | join("\n")
      | split("```json") | if length < 2 then empty else last | split("```") | first | try fromjson catch empty end')
    if [[ -n $plan ]]; then printf '%s\n' "$plan" > "$run/plan.json"; fi
    if [[ -z $plan ]]; then
      log "plan turn gave no parsable JSON; building without a checked plan"
    elif [[ $(jq -r .decision <<<"$plan") == blocked ]]; then
      block_issue "$(jq -c '.depends_on // []' <<<"$plan")" "$(jq -r .reason <<<"$plan")"
      # Back here only when every dependency the plan named waits for this issue itself.
      cyc=$(jq -r 'map("#\(.)") | join(", ")' <<<"$CYCLE_DEPS")
      if (( replanned )); then
        fail_issue blocked "the plan still waits for $cyc, while $cyc itself waits for #$n. A human has to break this dependency cycle."
      fi
      replanned=1
      agent replan "$PLAN_TIMEOUT" "Your plan waits for $cyc, but $cyc itself waits for this issue (stated in its text or in an earlier plan). Waiting on each other never ends, so this issue goes first. Plan again without waiting for $cyc: do every requirement that does not need it, and for the parts that touch $cyc provide an interface or an optional input tested with synthetic data, so $cyc only has to plug in. If another dependency genuinely does not exist yet, you may still answer \"blocked\" with that dependency.

$(phase_contract plan)"
      continue
    else
      log "plan: $(jq -r .slice <<<"$plan" | head -c 300)"
    fi
    return 0
  done
}

# pre_export_guards: what the branch must never ship (judged on its own changes); fail_issue on a hit.
pre_export_guards() {
  local reason
  reason=$(sb 60 git diff --no-renames --name-only "$base...HEAD" | grep -E '^(\.github/|deploy/)' | head -3 || true)
  [[ -z $reason ]] || fail_issue guard "the agent changed $reason, which may not go through this path."
  [[ -z $(sb 60 git diff --no-renames --name-only --diff-filter=MD "$base...HEAD" -- "$MIGRATIONS_DIR") ]] \
    || fail_issue guard "the agent changed an existing migration."
  return 0
}

# pr_verify_note_node: the PR's line about verification for VERIFY_KIND=node: the steps the newest
# verify log of this run shows, not a fixed list (a project may have no `check` or `test` script).
pr_verify_note_node() {
  local f steps ran skipped
  f=$(ls -t "$run"/verify-*.log 2>/dev/null | head -n 1 || true)
  if [[ -z $f ]]; then
    echo "No npm verify in the sandbox was recorded in this run."
  else
    steps=$(node_steps "$f"); ran=${steps%%|*}; skipped=${steps#*|}
    echo "The sandbox ran: ${ran:-no steps recorded}${skipped:+ (skipped, package.json has no script for: $skipped)}."
  fi
  echo "CI on GitHub is still required before merge."
}

# pr_body_common <checklist-json>: what an agent PR body (and an adoption comment) says about the
# work: the agent's summary, plan, checklist with evidence, review, steer quotes, cost line, log dir.
pr_body_common() {
  local checklist=$1
  sb 60 head -c 20000 .git/agent-pr-body.md 2>/dev/null || echo "_(the agent wrote no summary)_"
  if [[ -n $plan ]]; then echo; echo "**Plan:** $(jq -r .slice <<<"$plan")"; fi
  echo
  echo "**Checklist of what the issue asks for:**"
  echo
  jq -r '.[] | "- [\(if .done == true then "x" else " " end)] \(.item)\(if .evidence then " — " + .evidence else "" end)"' <<<"$checklist"
  echo
  echo "**Review (a separate model session; its findings are already applied):**"
  echo
  echo "$review_text"
  steer_section
  echo
  echo "---"
  echo "Done automatically by factory (lane $K): $(printf '`%s` ' "${used[@]}")."
  echo "Tokens: $ST_TOK_IN input, $ST_TOK_OUT output, $ST_TOK_CACHE from cache; cost \$$RUN_COST."
  if [[ $VERIFY_KIND == node ]]; then
    pr_verify_note_node
  else
    if [[ -n ${SB_PG_URL:-} ]]; then pgnote="with the lane's own Postgres"; else pgnote="without Postgres (DB tests skipped)"; fi
    echo "The sandbox ran scripts/verify-extra.sh (if present), \`cargo build\`, \`cargo test\` $pgnote, and the"
    echo "frontend build plus Playwright (private network, no access to the host) when \`frontend/\` changed."
    if playwright_gate_on; then
      echo "CI runs its own checks too, and all of them are required before merge."
    else
      echo "CI runs its own checks too; Playwright in CI is not required before merge yet (until #$PLAYWRIGHT_GATE_AFTER is done)."
    fi
  fi
  echo "Log: \`$run\` on the host."
}

# commit_or_resume: after the build turn there must be a commit. A turn can also end with the work
# done but uncommitted: the model stopped mid-task or looped on one sentence until its turn ran
# out. Failing then threw away up to 40 minutes of edits, so when the work
# tree has changes the same session gets one more turn to finish and commit. A clean tree, or a
# second turn that still leaves no commit, fails the issue as before.
commit_or_resume() {
  [[ $(sb 60 git rev-list --count "$base..HEAD") -gt 0 ]] && return 0
  if [[ -n $(sb 60 git status --porcelain 2>/dev/null | head -n 1) ]]; then
    log "build ended without a commit but the work tree has changes; one more turn to finish and commit"
    agent complete-commit "$AGENT_TIMEOUT" "The previous turn ended without a commit, yet the working tree has changes. Carry on from where things stand: check \`git status\` and \`git diff\`, finish what is missing, run the relevant build and tests, then commit everything. Do not repeat the same sentence; if you are stuck, write the reason to .git/agent-blocked.md.

$(phase_contract complete-commit)"
    if sb 60 test -e .git/agent-blocked.md; then
      fail_issue blocked "the agent says this issue cannot be done: $(sb 60 head -c 2000 .git/agent-blocked.md)"
    fi
  fi
  [[ $(sb 60 git rev-list --count "$base..HEAD") -gt 0 ]] || fail_issue no_commit "the agent produced no commit."
  return 0
}

# implement <issue>: plan, build, verify, review, verify, then open the PR. Sets $pr.
implement() {
  n=$1 sid="" impl_model="" used=()
  start_log "$n"
  pg_start
  load_issue "$n"
  [[ $(jq -r .state "$run/issue.json") == OPEN ]] || { log "issue #$n is not open"; exit 0; }
  log "implementing issue #$n on $base"
  stage plan
  checkout "agent/issue-$n" "$base"

  plan_step ""

  agent build "$AGENT_TIMEOUT" "$(cat "$PROMPTS/prompt.md")"
  impl_model=$last_model
  if sb 60 test -e .git/agent-blocked.md; then
    fail_issue blocked "the agent says this issue cannot be done: $(sb 60 head -c 2000 .git/agent-blocked.md)"
  fi
  commit_or_resume
  fix_loop build verify || fail_issue verify_failed "verify failed after $FIX_ROUNDS fix rounds."
  complete_loop || fail_issue verify_failed "a completion round did not pass verify."
  stage review
  review_branch || fail_issue verify_failed "the fixes from the review did not pass verify."

  # Last chance for a steer that found no turn to ride on: apply it before the branch leaves.
  steer_point impl review || fail_issue verify_failed "the human's steer did not pass verify."
  stage pr

  pre_export_guards
  export_branch "agent/issue-$n"

  # Only a checklist with nothing left, after the reviewer checked its claims, may close the
  # issue. Anything left means "Refs", and the next run continues from the merged part.
  local completes=false url checklist
  checklist=$(sb 60 cat .git/agent-checklist.json 2>/dev/null | jq -c 'if type == "array" then . else [] end' 2>/dev/null || echo '[]')
  if [[ $(checklist_todo) == "[]" ]]; then completes=true; fi
  if [[ $completes != true ]]; then title="$title (partial)"; fi
  {
    if [[ $completes == true ]]; then
      echo "Closes #$n"
    else
      echo "Refs #$n. This change does not finish the issue yet; the issue stays open for the next slice."
    fi
    echo
    pr_body_common "$checklist"
  } > "$run/pr-body.md"
  url=$("$GH" pr create -R "$REPO" --base main --head "agent/issue-$n" --title "$title" \
    --body-file "$run/pr-body.md" --label agent --label agent-reviewed)
  set_pr "${url##*/}" "$(sb 60 git rev-parse HEAD)"
  record --arg kind outcome --arg outcome pr --arg model "$impl_model" --arg url "$url"
  log "PR opened: $url"
}

# ---------------------------------------------------------------- adopting a human PR
# A PR labelled agent-adopt (same repo, exactly one `Closes #N`) is put through the same machine
# as an issue: plan -> build (audit first, then only what is missing) -> complete_loop -> verify
# -> review -> export. Differences from implement(), and why:
#   - the checkout is the PR's head (refs/pull/P/head), with main merged in when it is behind
#     (a merge, never a rebase; a conflict is an agent turn);
#   - the human's branch is only fast-forwarded: a head that moved meanwhile ends the run
#     (adopt_moved) and nothing is overwritten;
#   - no new PR and no body replacement: one comment carries the agent's summary;
#   - the `agent` label (what makes shepherd/open_agent_prs pick the PR up) is added only when the
#     checklist is full; otherwise the PR stays open with agent-adopt (adopt_incomplete) and the
#     issue is NOT labelled agent-failed;
#   - at most ADOPT_MAX_RUNS runs per PR head (STATE/adopt/<pr>.json); a human push resets it.

conflict_prompt() {
  printf '%s' 'This branch conflicts with the latest main. Run `git merge main`, resolve the conflicts keeping the intent of both sides, run the build and tests until they pass, then commit the merge.'
}

# _adopt_fetch <pr> <branch>: the PR head into the mirror under a private ref; prints its sha.
_adopt_fetch() {
  mg fetch --quiet origin "+refs/pull/$1/head:refs/adopt/$1-head" \
    || mg fetch --quiet origin "+refs/heads/$2:refs/adopt/$1-head" || return 1
  mg rev-parse "refs/adopt/$1-head"
}

# adopt_context <pr> <branch> <title>: what the plan turn is told about the human's work.
adopt_context() {
  local stat diff note=""
  stat=$(sb 60 git diff --no-renames --stat main...HEAD 2>/dev/null | tail -n 80 || true)
  diff=$(sb 60 bash -c 'git diff --no-renames main...HEAD | head -c "$1"' adopt "$(( ADOPT_DIFF_MAX + 1 ))" 2>/dev/null || true)
  if (( ${#diff} > ADOPT_DIFF_MAX )); then
    diff=${diff:0:ADOPT_DIFF_MAX}
    note=" (cut at $ADOPT_DIFF_MAX characters; read the rest with git diff main...HEAD -- <file>)"
  fi
  printf '%s\n' "--- the human PR being adopted: #$1 (branch $2) \"$3\" ---" \
    "A human already started on this issue, and their work IS ALREADY on the active branch (the latest main is merged into it)." \
    "You do not start from scratch: judge that work against every requirement of the issue, and plan only what is still missing or wrong." \
    "Requirements still come from the issue, not from the PR. Keep the author's design unless it breaks the issue or $(decision_docs)." \
    "" "git diff --stat main...HEAD:" '```' "$stat" '```' "" "git diff main...HEAD$note:" '```diff' "$diff" '```' "--- end of the human PR ---"
}

# adopt <issue> <pr>: see above. Returns (PR labelled agent, ready for shepherd) only when the
# checklist is full; every other ending exits the run.
adopt() {
  local info head fetched branch ptitle newhead checklist todo complete=false
  n=$1 adopt_pr=$2 ADOPTED=1 sid="" impl_model="" used=()
  start_log "$n"
  pg_start
  info=$("$GH" pr view "$adopt_pr" -R "$REPO" --json state,title,body,labels,headRefName,headRefOid,isCrossRepository) \
    || { log "adopt: cannot read PR #$adopt_pr"; lane_exit idle "adopting PR #$adopt_pr: gh could not read the PR"; }
  if ! jq -e --argjson n "$n" "$ADOPT_JQ_DEFS"'
      .state == "OPEN" and .isCrossRepository == false
      and any(.labels[]; .name == "agent-adopt") and (any(.labels[]; .name == "agent") | not)
      and (closing_refs == [$n])' <<<"$info" >/dev/null; then
    log "adopt: PR #$adopt_pr no longer qualifies for issue #$n"
    lane_exit idle "adopting PR #$adopt_pr no longer applies"
  fi
  branch=$(jq -r .headRefName <<<"$info") ptitle=$(jq -r .title <<<"$info") head=$(jq -r .headRefOid <<<"$info")
  adopt_branch=$branch
  # The head as GitHub serves it right now, in the mirror, whatever the branch is called.
  if fetched=$(lk mirror _adopt_fetch "$adopt_pr" "$branch") && [[ -n $fetched ]]; then head=$fetched; fi
  set_pr "$adopt_pr" "$head"
  adopt_begin "$adopt_pr" "$n" "$head"
  load_issue "$n"
  [[ $(jq -r .state "$run/issue.json") == OPEN ]] || { log "issue #$n is not open"; exit 0; }
  ST_NOTE="adopting PR #$adopt_pr ($branch)"
  log "adopting PR #$adopt_pr (issue #$n, $branch @ ${head:0:12}) on $base"
  stage plan "adopt"
  checkout "$branch" "$head"
  lk mirror mg update-ref -d "refs/adopt/$adopt_pr-head" >/dev/null 2>&1 || true   # the checkout has its own copy now

  if ! sb 60 git merge-base --is-ancestor main HEAD; then
    stage pr "merge main"
    log "PR #$adopt_pr is behind main: merging main into it (a merge, never a rebase)"
    if sb 300 git merge --no-edit main; then
      log "main merged cleanly"
    else
      sb 60 git merge --abort || true
      agent merge0 "$AGENT_TIMEOUT" "$(conflict_prompt)"
      sid="" ST_SESSION=""   # the plan gets a session of its own
      fix_loop merge0 pr || fail_issue conflict "the conflict with main was not resolved, or the merge did not pass verify."
    fi
    stage plan "adopt"
  fi

  plan_step "$(adopt_context "$adopt_pr" "$branch" "$ptitle")"

  agent build "$AGENT_TIMEOUT" "$(cat "$PROMPTS/adopt.md")

$(cat "$PROMPTS/prompt.md")"
  impl_model=$last_model
  if sb 60 test -e .git/agent-blocked.md; then
    fail_issue blocked "the agent says this issue cannot be done: $(sb 60 head -c 2000 .git/agent-blocked.md)"
  fi
  fix_loop build verify || fail_issue verify_failed "verify failed after $FIX_ROUNDS fix rounds."
  complete_loop || fail_issue verify_failed "a completion round did not pass verify."
  stage review
  review_branch || fail_issue verify_failed "the fixes from the review did not pass verify."
  steer_point impl review || fail_issue verify_failed "the human's steer did not pass verify."
  stage pr

  pre_export_guards
  newhead=$(sb 60 git rev-parse HEAD)
  EXPORT_MOVED=0
  if [[ $newhead != "$head" ]]; then export_branch "$branch"; fi
  if (( EXPORT_MOVED )); then
    record --arg kind outcome --arg outcome adopt_moved --arg model "${impl_model:-}"
    lane_exit idle "PR #$adopt_pr changed on GitHub during the run: not overwritten, will retry from the new head"
  fi
  adopt_update "$adopt_pr" "$newhead" false
  set_pr "$adopt_pr" "$newhead"

  checklist=$(sb 60 cat .git/agent-checklist.json 2>/dev/null | jq -c 'if type == "array" then . else [] end' 2>/dev/null || echo '[]')
  todo=$(checklist_todo)
  if [[ $todo == "[]" ]]; then complete=true; fi
  {
    echo "**factory adopted this PR** (lane $K) for issue #$n: the existing work was judged against every requirement, and only what was missing was done."
    echo
    if [[ $complete == true ]]; then
      echo "The issue checklist is complete. This PR is now handled as an agent PR: CI, review, then merge as MERGE_MODE says."
    else
      echo "**Not finished; this PR is not merged.** Still open:"
      echo
      jq -r '.[] | "- [ ] " + .' <<<"$todo"
      echo
      echo "The \`agent-adopt\` label stays; this PR is picked up again after a new push (at most $ADOPT_MAX_RUNS attempts per head)."
    fi
    echo
    pr_body_common "$checklist"
  } > "$run/adopt-comment.md"
  "$GH" pr comment "$adopt_pr" -R "$REPO" --body-file "$run/adopt-comment.md" >/dev/null || log "could not comment on PR #$adopt_pr"

  if [[ $complete == true ]]; then
    adopt_update "$adopt_pr" "$newhead" true
    "$GH" pr edit "$adopt_pr" -R "$REPO" --add-label agent --add-label agent-reviewed >/dev/null
    record --arg kind outcome --arg outcome adopted --arg model "$impl_model" --arg url "https://github.com/$REPO/pull/$adopt_pr"
    log "PR #$adopt_pr adopted: checklist complete, handing it to the shepherd"
    return 0
  fi
  record --arg kind outcome --arg outcome adopt_incomplete --arg model "$impl_model" --arg url "https://github.com/$REPO/pull/$adopt_pr"
  log "PR #$adopt_pr: $(jq -r length <<<"$todo") requirement(s) still open; not merging"
  lane_exit idle "adopting PR #$adopt_pr is not finished: $(jq -r length <<<"$todo") requirement(s) left"
}


# merge_pr <head>: the merge critical section. MERGE_RESULT = merged | again | ci_wait | conflict.
# Held under the `merge` lock: fetch; if main moved past the PR, GitHub updates the branch, the
# lock is released and we wait for CI on the new head (max MAX_UPDATE_ROUNDS rounds); otherwise
# CI is re-checked on that exact head, the PR is squash-merged with --match-head-commit, and the
# deploy of the merge commit is waited for before anyone else may merge. Nothing is interrupted
# inside the lock: a stop shows `stop deferred` and applies right after.
merge_pr() {
  local head=$1 cur main_sha sha closes=false i
  MERGE_RESULT=again
  stage merge "waiting merge lock"
  local waited=0
  until lock_take merge 0; do
    if [[ -n $STEER_MSG ]]; then MERGE_RESULT=again; return 0; fi
    isleep 5
    waited=$(( waited + 5 ))
    if (( waited >= MERGE_LOCK_WAIT )); then log "merge lock still busy after ${waited}s"; return 0; fi
  done
  NOINT=1
  ST_SUB=""
  gate_halt   # a halt raised while we waited must stop this merge (it exits; on_exit drops the lock)
  mirror_fetch
  main_sha=$(mg rev-parse refs/heads/main)
  cur=$("$GH" pr view "$pr" -R "$REPO" --json headRefOid -q .headRefOid)
  if [[ $cur != "$head" ]]; then
    log "PR head moved while waiting for the merge lock"
    NOINT=0; lock_drop merge; return 0
  fi
  if ! mg merge-base --is-ancestor "$main_sha" "$cur"; then
    UPD_ROUNDS=$(( UPD_ROUNDS + 1 ))
    if (( UPD_ROUNDS > MAX_UPDATE_ROUNDS )); then
      NOINT=0; lock_drop merge; MERGE_RESULT=ci_wait; return 0
    fi
    stage merge "update-branch"
    log "main moved past the PR: update-branch (round $UPD_ROUNDS)"
    if ! "$GH" api -X PUT "repos/$REPO/pulls/$pr/update-branch" -f expected_head_sha="$cur" >/dev/null 2>&1; then
      NOINT=0; lock_drop merge; MERGE_RESULT=conflict; return 0
    fi
    NOINT=0; lock_drop merge
    # GitHub applies the update asynchronously: wait until the PR head is a new commit.
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do
      isleep 5
      if [[ $("$GH" pr view "$pr" -R "$REPO" --json headRefOid -q .headRefOid) != "$cur" ]]; then break; fi
    done
    MERGE_RESULT=again
    return 0
  fi
  ci_poll "$cur"
  if [[ $CI_STATE != pass ]]; then NOINT=0; lock_drop merge; MERGE_RESULT=again; return 0; fi
  if "$GH" pr view "$pr" -R "$REPO" --json body -q .body | head -n1 | grep -q '^Closes #'; then closes=true; fi
  if (( ADOPTED )); then closes=true; fi   # a human's PR closes its issue with whatever wording it had
  if ! "$GH" pr merge "$pr" -R "$REPO" --squash --delete-branch --match-head-commit "$cur" >/dev/null; then
    log "merge refused (head changed?)"
    NOINT=0; lock_drop merge; MERGE_RESULT=again; return 0
  fi
  sha=$("$GH" pr view "$pr" -R "$REPO" --json mergeCommit -q .mergeCommit.oid)
  stage_end ok
  record --arg kind outcome --arg outcome merged --arg model "${impl_model:-}" --arg sha "$sha" --arg url "https://github.com/$REPO/pull/$pr"
  log "merged PR #$pr as $sha"
  rm -f "$STATE/sessions/$n"
  if (( ADOPTED )); then adopt_forget "$pr"; fi
  # A6: GitHub closes the issue a few seconds after the merge; until then it must not be re-picked.
  if [[ $closes == true ]]; then claim_tombstone "$n" 900; fi
  # The merge is done and recorded: the lock protects "main moved under my PR", not the deploy.
  # Waiting for the deploy (minutes) outside it lets the next lane merge meanwhile; deploy.yml's
  # concurrency group queues the deploys. Still uninterruptible (NOINT) until health is known.
  lock_drop merge
  deploy "$sha" "$pr"
  NOINT=0
  MERGE_RESULT=merged
  gate_stop
  return 0
}

# lane_session <issue>: the issue's saved session, only if this lane made it. opencode ties a session
# to the directory it was made in and the sandbox shows a lane only its own s<K>, so resuming another
# lane's session fails with ENOENT on that lane's work dir. That read as a model error and cooled the
# only model for every lane. A file without a lane (older runs) is not resumed.
lane_session() {
  local s="" k=""
  [[ -f $STATE/sessions/$1 ]] || return 0
  read -r s k _ < "$STATE/sessions/$1" || true
  if [[ -n $s && $k == "$K" ]]; then printf '%s\n' "$s"; fi
  return 0
}

# shepherd <pr>: review if it never was, then CI (fixing what breaks), conflicts with main, merge,
# deploy, health. Fix rounds of any kind share CI_FIX_ROUNDS; update-branch rounds are separate.
# The claim on the issue is already held.
shepherd() {
  local branch head s fixes=0 iter=0 reason state rerun_head=""
  pr=$1
  branch=$("$GH" pr view "$pr" -R "$REPO" --json headRefName -q .headRefName)
  if adopt_known "$pr"; then
    # An adopted human PR: only once its checklist was full (adopt() sets that before it labels it).
    ADOPTED=1 adopt_pr=$pr
    adopt_complete "$pr" || { log "PR #$pr is an adoption whose checklist is not complete: not shepherding it"; return 0; }
    n=$(adopt_get "$pr" | jq -r '.issue // empty')
    [[ $n =~ ^[0-9]+$ ]] || { log "adoption record of PR #$pr has no issue"; return 0; }
  elif [[ $branch =~ ^agent/issue-[0-9]+$ ]]; then
    n=${branch#agent/issue-}
  else
    log "PR #$pr is not an agent/issue-N branch and was not adopted"; return 0
  fi
  start_log "$n"
  if [[ -z $sid ]]; then sid=$(lane_session "$n"); fi
  ST_SESSION=$sid
  pg_start
  log "shepherding PR #$pr (issue #$n)"
  for (( iter = 1; iter <= 40; iter++ )); do
    gate_halt
    gate_stop
    control_load
    if jq -e --argjson n "$n" '.skip | any(. == $n)' <<<"$CONTROL" >/dev/null; then log "issue #$n is in control.skip: leaving PR #$pr alone"; return 0; fi
    state=$("$GH" pr view "$pr" -R "$REPO" --json state -q .state)
    [[ $state == OPEN ]] || { log "PR #$pr is $state"; return 0; }
    mirror_fetch
    base=$(mg rev-parse refs/heads/main)
    head=$(mg rev-parse "refs/heads/$branch")
    set_pr "$pr" "$head"
    if [[ -z $title ]]; then title=$("$GH" issue view "$n" -R "$REPO" --json title -q .title); issue_begin "$n" "$title"; fi
    reason=$(guard "$head") || give_up_pr "$pr" guard "this PR $reason"

    # A steer waiting for a turn: apply it, push, and go round again (CI starts over).
    if [[ -n $STEER_MSG ]]; then
      stage pr
      load_issue "$n"
      checkout "$branch" "$head"
      steer_point shepherd pr || give_up_pr "$pr" verify_failed "the human's steer did not pass verify"
      export_branch "$branch"
      continue
    fi

    if ! "$GH" pr view "$pr" -R "$REPO" --json labels -q '.labels[].name' | grep -qx agent-reviewed; then
      stage review
      load_issue "$n"
      checkout "$branch" "$head"
      review_branch || give_up_pr "$pr" verify_failed "the fixes from the review did not pass verify"
      if [[ $(sb 60 git rev-parse HEAD) != "$head" ]]; then export_branch "$branch"; fi
      "$GH" pr comment "$pr" -R "$REPO" --body "**Review (a separate model session; its findings are already applied):**

$review_text" >/dev/null
      "$GH" pr edit "$pr" -R "$REPO" --add-label agent-reviewed >/dev/null
      continue
    fi

    stage ci
    mergeable "$pr"
    if [[ $MERGEABLE == CONFLICTING ]]; then
      (( fixes < CI_FIX_ROUNDS )) || give_up_pr "$pr" conflict "the conflict with main was not resolved"
      stage pr "conflict"
      load_issue "$n"
      checkout "$branch" "$head"
      agent "merge$fixes" "$AGENT_TIMEOUT" "$(conflict_prompt)"
      fix_loop "merge$fixes" pr || give_up_pr "$pr" conflict "the merge with main did not pass verify"
      fixes=$(( fixes + 1 ))
      export_branch "$branch"; continue
    fi

    stage ci
    wait_ci "$head"; s=$WAIT_RESULT
    if [[ $s == steer ]]; then continue; fi
    if [[ $s == timeout ]]; then leave_pr ci_wait "CI did not finish within ${CI_TIMEOUT}s"; fi
    if [[ $s != pass ]]; then
      # Main itself is red: this failure may not be the PR's, so do not spend a fix round on it.
      if main_ci_red; then leave_pr main_red "CI failed ($s) but the latest deploy run on main ($MAIN_RED_RUN) is red too: lane released, the PR is retried later"; fi
      # Once per head: re-run the failed jobs before believing them (flaky specs, see ci_rerun).
      if [[ $rerun_head != "$head" ]]; then
        rerun_head=$head
        if ci_rerun "$head"; then
          log "CI failed on ${head:0:7}: re-running the failed jobs once before spending a fix round"
          record --arg kind ci_rerun --arg head "$head" --arg pr "$pr"
          continue
        fi
      fi
      if (( fixes >= CI_FIX_ROUNDS )); then
        FAIL_DETAIL=$(ci_digest "$head") || true
        give_up_pr "$pr" ci_failed "CI still fails ($s) after $CI_FIX_ROUNDS fix rounds"
      fi
      load_issue "$n"
      checkout "$branch" "$head"
      agent "ci$fixes" "$AGENT_TIMEOUT" "CI on GitHub failed ($s) for this branch. Logs of the failed jobs:

\`\`\`
$(ci_log "$head" | tail -n 200)
\`\`\`

Fix the cause, not the symptom. $(pg_fix_hint)Run the build and tests, then commit."
      fix_loop "ci$fixes" ci || give_up_pr "$pr" ci_failed "the CI fix did not pass the local verify"
      fixes=$(( fixes + 1 ))
      export_branch "$branch"; continue
    fi

    # Merge gate for an adopted PR: only with a complete checklist (SCHEMA 3.2).
    if (( ADOPTED )) && ! adopt_complete "$pr"; then leave_pr adopt_incomplete "the adopted PR's checklist is not complete: not merging"; fi
    if [[ $MERGE_MODE != auto ]]; then ready_pr "$head"; return 0; fi
    merge_pr "$head"
    case $MERGE_RESULT in
      merged) return 0 ;;
      ci_wait) leave_pr ci_wait "main keeps moving: $MAX_UPDATE_ROUNDS update-branch rounds were not enough" ;;
      *) continue ;;   # again, or conflict: GitHub then reports CONFLICTING and the next round resolves it
    esac
  done
  leave_pr ci_wait "40 rounds without a result"
}

# ready_pr <head>: MERGE_MODE=pr. CI is green on <head> and the review is applied: hand the PR to a
# human instead of merging it. The agent-ready label takes it out of open_agent_prs, so no lane
# touches it again; removing the label hands it back to the lanes (after a human pushed, say).
ready_pr() {
  "$GH" label create agent-ready -R "$REPO" --color 0E8A16 \
    --description "factory: CI green and reviewed, ready for a human to merge" >/dev/null 2>&1 || true
  if ! "$GH" pr edit "$pr" -R "$REPO" --add-label agent-ready >/dev/null 2>&1; then
    log "could not label PR #$pr agent-ready"; return 0
  fi
  "$GH" pr comment "$pr" -R "$REPO" --body "CI is green on \`${1:0:12}\` and the review is applied: ready for a human to merge (MERGE_MODE=pr). Remove the \`agent-ready\` label to hand this PR back to factory." >/dev/null 2>&1 || true
  stage_end ok
  record --arg kind outcome --arg outcome ready --arg model "${impl_model:-}" --arg url "https://github.com/$REPO/pull/$pr"
  log "PR #$pr is ready for a human to merge (MERGE_MODE=pr)"
  rm -f "$STATE/sessions/$n"
  return 0
}

# open_agent_prs: "<pr> <issue>" per open agent PR, oldest first. A PR labelled agent-ready is
# waiting for a human (MERGE_MODE=pr) and is not listed. An agent/issue-N branch, or a
# human's branch (same repo, exactly one closing reference) that carries `agent`. A PR with an
# adoption record is listed only once its checklist is complete: until then adopt() owns it, and a
# human who put `agent` on a PR that was never adopted does not get it shepherded (no record).
open_agent_prs() {
  local rows p i b
  rows=$(timeout 40 "$GH" pr list -R "$REPO" --state open --label agent -L 50 --json number,headRefName,createdAt,body,isCrossRepository,labels 2>/dev/null     | jq -r "$ADOPT_JQ_DEFS"' sort_by(.createdAt) | .[] | select(any(.labels[]?; .name == "agent-ready") | not) | closing_refs as $c
        | if (.headRefName | test("^agent/issue-[0-9]+$")) then "\(.number) \(.headRefName | ltrimstr("agent/issue-")) agent"
          elif .isCrossRepository == false and ($c | length) == 1 then "\(.number) \($c[0]) human"
          else empty end') || true
  while read -r p i b; do
    [[ -n ${p:-} ]] || continue
    if adopt_known "$p"; then
      adopt_complete "$p" || continue
    elif [[ $b == human ]]; then
      continue
    fi
    echo "$p $i"
  done <<<"$rows"
  return 0
}

_consume() {  # a queued entry is one-shot: remember when root started it
  local f=$UI/consumed.json cur='{}'
  if [[ -f $f && ! -L $f ]] && jq -e 'type == "object"' "$f" >/dev/null 2>&1; then cur=$(cat "$f"); fi
  jq -c --arg n "$1" --arg t "$(date -u +%FT%TZ)" '. + {($n): $t}' <<<"$cur" | ui_write consumed.json
}

# consume_queue <n>: E5. A queued pick ignores agent-failed / agent-blocked; take them off so the
# issue is an ordinary open issue again.
consume_queue() {
  lk consumed _consume "$1" || true
  "$GH" issue edit "$1" -R "$REPO" --remove-label agent-failed >/dev/null 2>&1 || true
  "$GH" issue edit "$1" -R "$REPO" --remove-label agent-blocked >/dev/null 2>&1 || true
  rm -f "$STATE/blocked/$1"
  return 0
}

# ---------------------------------------------------------------- cleanup (ExecStopPost)
cleanup_slot() {
  # A manual run (run.sh --slot K <issue>) holds the slot lock and has no unit: leave it alone.
  # Every process of a finished unit is gone by ExecStopPost, so a held lock means someone else.
  mkdir -p "$LOCKS"
  exec 9>"$LOCKS/slot-$K"
  if ! flock -n 9; then log "lane $K is in use by another run: cleanup skipped"; return 0; fi
  systemctl stop "factory-pg-s$K.service" >/dev/null 2>&1 || true
  systemctl stop "factory-s$K.slice" >/dev/null 2>&1 || true
  claim_release_slot "$K"
  local f=$UI/slots/$K.json cur
  if [[ -f $f ]] && cur=$(jq -c 'if .run_id == null then empty else . end' "$f" 2>/dev/null) && [[ -n $cur ]]; then
    jq -c --argjson now "$(now)" '.run_id = null | .turn = null | .updated = $now
      | (if (.state | IN("running", "draining", "stopping")) then .state = "stopped" | .stage = null | .sub = "" else . end)' <<<"$cur" \
      | atomic_write "$f" 640 || true
  fi
  return 0
}

# ---------------------------------------------------------------- exit
on_exit() {
  local rc=$?
  trap - EXIT
  if [[ -n ${DRY_PICK:-} || -z $K ]]; then exit "$rc"; fi
  if [[ -n $STEER_MSG ]]; then
    ST_STEER_LAST=$(jq -nc --arg id "$STEER_ID" --arg m "$STEER_MSG" --argjson t "$(now)" \
      '{id: $id, message: $m, applied_at: null, outcome: "dropped"}')
    ST_STEER_PENDING=null
    record --arg kind steer --arg phase "${CUR_STAGE:-}" --arg outcome dropped
    STEER_MSG=""
  fi
  if (( rc != 0 )); then ST_NOTE="run.sh exited with code $rc"; stage_end fail; else stage_end ok; fi
  pg_stop
  lock_drop_all
  claim_release_run
  ST_RUN="" ST_TURN_JSON=null ST_SUB=""
  case $ST_STATE in
    parked|backoff|halted|stopped) ;;
    *) ST_STATE=idle ;;
  esac
  ST_STAGE="" ST_CI_JSON=null
  case $ST_STATE in
    idle|parked|backoff)   # nothing in flight: the console shows an empty lane
      ST_ISSUE_JSON=null ST_PR_JSON=null ST_MODEL="" ST_SESSION="" ST_REQ_TOTAL=-1 ST_LOGDIR=""
      ST_STAGE_STARTED=0 ST_ISSUE_STARTED=0 ST_TOK_IN=0 ST_TOK_OUT=0 ST_TOK_REASON=0 ST_TOK_CACHE=0 ;;
  esac
  st_flush
  exit "$rc"
}

# ---------------------------------------------------------------- main
main() {
  local mode=${1:-} cand out p i attempt cand_n cand_class cand_adopt="" skip prs=()
  case $mode in
    --cleanup) K=${2:-}; slot_valid "$K" || exit 2; cleanup_slot; exit 0 ;;
    --slot) K=${2:-}; MANUAL=${3:-} ;;
    *) echo "usage: run.sh --slot K [issue] | --cleanup K" >&2; exit 2 ;;
  esac
  slot_valid "$K" || { echo "slot must be one of: $SLOTS" >&2; exit 2; }
  # A typo here would silently run the cargo steps on a Node repo.
  case $VERIFY_KIND in cargo|node) ;; *) echo "VERIFY_KIND must be cargo or node, not '$VERIFY_KIND'" >&2; exit 2 ;; esac
  case $MERGE_MODE in pr|auto) ;; *) echo "MERGE_MODE must be pr or auto, not '$MERGE_MODE'" >&2; exit 2 ;; esac
  [[ -z $MANUAL || $MANUAL =~ ^[0-9]+$ ]] || { echo "issue must be a number" >&2; exit 2; }
  RUN_ID=${INVOCATION_ID:-manual-$$-$RANDOM}
  SLOTDIR=$H/s$K WORK=$SLOTDIR/work OUT=$SLOTDIR/out
  export SB_SLOT=$K
  mkdir -p "$STATE" "$STATE/sessions" "$STATE/blocked" "$STATE/claims" "$STATE/cooldown" "$STATE/adopt" "$LOCKS"
  chmod 700 "$STATE" "$STATE/sessions" "$STATE/blocked" "$STATE/claims" "$STATE/cooldown" "$STATE/adopt" "$LOCKS" 2>/dev/null || true
  mkdir -p "$LOGDIR"
  load_token
  control_load

  if [[ -n ${DRY_PICK:-} ]]; then
    ST_DISABLED=1
    out=$(pick_issue)
    echo "would pick #${out%% *}"
    exit 0
  fi

  # One lane, one process. systemd's template instance already guarantees it for the timer; this
  # also keeps a manual run from starting beside the timer's.
  exec 9>"$LOCKS/slot-$K"
  flock -n 9 || { echo "lane $K is busy"; exit 0; }
  trap on_exit EXIT
  trap 'exit 143' TERM INT HUP
  ST_RUN=$RUN_ID
  st state=running stage= sub= note=
  stage pick

  gate_halt
  refresh_effective
  if [[ -z $MANUAL ]]; then
    if (( $(lane_pos) > ST_EFF )); then lane_exit parked "lane $K is above the effective number of agents ($ST_EFF)"; fi
    gate_pause
  fi
  if (( ${#EFF_MODELS[@]} == 0 )); then lane_exit idle "no free model in ui/models.json yet (has sync run?)"; fi
  gate_cooldown

  mirror_init
  mirror_fetch
  base=$(mg rev-parse refs/heads/main)

  if [[ -n $MANUAL ]]; then
    n=$MANUAL
    claim_take "$n" || lane_exit idle "issue #$n is being worked by another lane"
    cand_adopt=$(adopt_lookup "$n")
    target_trim
    if [[ -n $cand_adopt ]]; then adopt "$n" "$cand_adopt"; else implement "$n"; fi
    shepherd "$pr"
  else
    # 1. One unclaimed agent PR, oldest first. Claiming it is what keeps two lanes off one PR.
    mapfile -t prs < <(open_agent_prs)
    for cand in "${prs[@]}"; do
      read -r p i <<<"$cand"
      if jq -e --argjson n "$i" '.skip | any(. == $n)' <<<"$CONTROL" >/dev/null; then continue; fi
      if claim_take "$i"; then
        shepherd "$p"
        finish_lane
        return 0
      fi
    done
    # 2. Otherwise one new issue, end to end.
    cand_n=""
    for attempt in 1 2 3; do
      out=$(pick_issue)
      [[ -n $out ]] || lane_exit idle "no issue qualifies"
      read -r cand_n cand_class cand_adopt <<<"$out"
      if claim_take "$cand_n"; then break; fi
      cand_n=""
    done
    [[ -n $cand_n ]] || lane_exit idle "the picked issue was taken by another lane"
    if [[ $cand_class == queued ]]; then consume_queue "$cand_n"; fi
    gate_pause
    target_trim
    if [[ -n ${cand_adopt:-} ]]; then adopt "$cand_n" "$cand_adopt"; else implement "$cand_n"; fi
    shepherd "$pr"
  fi
  finish_lane
}

# finish_lane: healthy after a deploy shows `live` for 60 s, then idle. The claim goes first so
# the next lane need not wait for the display.
finish_lane() {
  if [[ $ST_STAGE == live ]]; then
    claim_release_run
    ST_TURN_JSON=null
    st_flush
    sleep 60
  fi
  return 0
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
