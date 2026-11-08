#!/usr/bin/env bash
# factory shared functions. Sourced by run.sh and sync.sh; has no side effects of its own
# beyond defining names, so the pure parts can be tested on any machine with bash and jq
# (orchestrator/test/).
#
# Every path can be overridden from the environment; that is how the tests run against a temp
# directory and how nothing here ever needs a real /var/lib on a developer machine.
#
# Contract: contracts/SCHEMA.md. If something here needs a shape that file does not have,
# change the file first.

REPO=${REPO:-acme/shop}
BASE_DIR=${BASE_DIR:-/opt/factory}
STATE=${STATE:-/var/lib/factory}
UI=${UI:-/var/lib/factory-ops/ui}
CTL=${CTL:-/var/lib/factory-ops/ctl}
LOGDIR=${LOGDIR:-/var/log/factory}
H=${H:-/home/factory}
MIRROR=${MIRROR:-$BASE_DIR/mirror.git}
SANDBOX=${SANDBOX:-$BASE_DIR/sandbox.sh}
GH=${GH:-$BASE_DIR/bin/gh}
# HEALTH_URL: checked after each deploy (MERGE_MODE=auto). Empty (the default): no deploy watch.
HEALTH_URL=${HEALTH_URL:-}
# A second instance (another repo, same code, its own EnvironmentFile) owns other lane slots of the
# same sandbox user: the first instance 1 2 3, the "blog" example 4 5. Slot 9 stays the gates'
# (sandbox.sh, SB_GATE).
# AGENT_UNIT is the systemd template of the lanes (<AGENT_UNIT>@<slot>.service), which is how a
# claim proves its lane is still running (claim_stale_file).
SLOTS=${SLOTS:-1 2 3}
AGENT_UNIT=${AGENT_UNIT:-factory}
# Group that may read ui/ and the log dirs (the console runs in it). Empty: leave the group alone.
FILE_GROUP=${FILE_GROUP-factory-ops}
LOCKS=$STATE/locks
STATS=$UI/stats.jsonl
# Root-only ledger of what the paid (OpenCode Go) turns cost: one line per turn.
SPEND=$STATE/spend.jsonl
# Budgets in USD, under OpenCode Go's own caps ($16 / 5 h, $40 / week, $80 / month). The room left
# below each cap is for turns already in flight when a budget is reached: three lanes x one 300-min
# turn (~$1.40 at the $0.43 the costliest 90-min turn cost) ~ $4. If the account is also used
# elsewhere, spend.jsonl undercounts; then OpenCode's own cap rejects turns first, and the model
# cools down instead of the lanes halting.
GO_BUDGET_5H=${GO_BUDGET_5H:-14}
GO_BUDGET_WEEK=${GO_BUDGET_WEEK:-36}
GO_BUDGET_MONTH=${GO_BUDGET_MONTH:-76}
# A second OpenCode Go account (virtual model id opencode-go@2/<model>) has its own caps and its own budgets
# ($16 / 5 h, $40 / week, $80 / 30 d per account), counted only over that account's spend rows.
# Account N reads GO<N>_BUDGET_{5H,WEEK,MONTH}, defaulting to account 1's values.
# No ":" in the expansion: an instance that must never pay sets GO_ACCOUNTS= (empty) and gets none.
GO_ACCOUNTS=${GO_ACCOUNTS-1 2}
# Adopting a human PR (label agent-adopt): at most this many adoption runs on the same PR head
# (a new human push resets it), and the cap on the PR diff that goes into the plan prompt.
ADOPT_MAX_RUNS=${ADOPT_MAX_RUNS:-2}
ADOPT_DIFF_MAX=${ADOPT_DIFF_MAX:-60000}
EMPTY_OBJ='{}'
CONTROL_DEFAULT='{"v":1,"agents":1,"models":["opencode/deepseek-v4.1-flash-free"],"model_mode":"ordered","paused":false,"queue":[],"skip":[],"resume_ack":null}'
CONTROL=$CONTROL_DEFAULT
export LC_ALL=C.UTF-8

now() { printf '%s\n' "${NOW:-$(date +%s)}"; }

# health_host: the host (and port, if any) of HEALTH_URL, for the messages that name the site.
health_host() { local h=${HEALTH_URL#*://}; printf '%s' "${h%%[/?#]*}"; }

# slot_valid <k>: rc 0 when k is one of this instance's SLOTS (string match, so "01" is not slot 1).
slot_valid() {
  local s
  for s in $SLOTS; do [[ $1 == "$s" ]] && return 0; done
  return 1
}
# slot_index <k>: the 1-based position of k in SLOTS, rc 1 when it is not a slot. control.json's
# `agents` counts lanes, not slot numbers: slot 4 is lane 1 of an instance whose SLOTS are "4 5".
slot_index() {
  local s i=0
  for s in $SLOTS; do
    i=$(( i + 1 ))
    if [[ $1 == "$s" ]]; then echo "$i"; return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- files
# atomic_write <dest> [mode]: stdin -> dest through a temp file in the same directory, so a
# reader never sees half a file.
atomic_write() {
  local dest=$1 mode=${2:-640} tmp
  tmp=$(dirname "$dest")/.$(basename "$dest").$$.$RANDOM
  if ! cat > "$tmp"; then rm -f "$tmp"; return 1; fi
  chmod "$mode" "$tmp"
  if [[ -n $FILE_GROUP ]]; then chgrp "$FILE_GROUP" "$tmp" 2>/dev/null || true; fi
  mv -f "$tmp" "$dest"
}

ui_write() { atomic_write "$UI/$1" 640; }  # ui_write <relative-path>: stdin

# ctl_file_ok <file>: what root accepts from the console's directory. A symlink would make root
# read a file of the console's choosing; a huge file is a memory attack.
ctl_file_ok() {
  [[ -f $1 && ! -L $1 ]] || return 1
  local sz; sz=$(stat -c %s "$1" 2>/dev/null) || return 1
  [[ $sz =~ ^[0-9]+$ ]] && (( sz <= 65536 ))
}

# ---------------------------------------------------------------- logging
log() {
  local line; line="$(date -u +%FT%TZ) $*"
  printf '%s\n' "$line" >&2
  if [[ -n ${run:-} && -d ${run:-} ]]; then printf '%s\n' "$line" >> "$run/run.log"; fi
  return 0
}

# opencode --format json writes one event per line; skip anything that is not JSON.
events() { jq -c -R 'fromjson? // empty' "$1" 2>/dev/null; }

# ---------------------------------------------------------------- locks
# Order, outer to inner: merge -> claim -> mirror -> stats/cooldown/consumed/halt. Rank 0 locks
# (sync, slot-K) are per-process and never nest with the others. Taking a lock whose rank is
# not above everything already held is refused: that is how a deadlock would start.
HELD_LOCKS=""
declare -A LOCKFD=()

lock_rank() {
  case $1 in
    sync|slot-*) echo 0 ;;
    merge) echo 1 ;;
    claim) echo 2 ;;
    mirror) echo 3 ;;
    stats|cooldown|consumed|halt|spend) echo 4 ;;
    *) echo 9 ;;
  esac
}

lock_order_ok() {  # lock_order_ok "<held names>" <name>
  local h r; r=$(lock_rank "$2")
  for h in $1; do
    if [[ $h == "$2" ]] || (( $(lock_rank "$h") >= r )); then return 1; fi
  done
  return 0
}

# lk <lock> <cmd...>: run a command (a shell function is fine) in a subshell under the lock.
# For short critical sections; anything it computes must come back on stdout or in a file.
lk() {
  local name=$1; shift
  lock_order_ok "$HELD_LOCKS" "$name" || { echo "lock order violation: $name while holding:$HELD_LOCKS" >&2; return 99; }
  mkdir -p "$LOCKS"
  (
    exec 8>"$LOCKS/$name" || exit 98
    flock -w "${LOCK_WAIT:-120}" 8 || exit 97
    HELD_LOCKS="$HELD_LOCKS $name"
    "$@"
  )
}

# lock_take <name> <wait-seconds|0>: hold a lock in the main shell across many steps (the merge
# critical section). 0 = try once. lock_drop releases; on_exit drops whatever is left.
lock_take() {
  local name=$1 wait=${2:-120} fd
  lock_order_ok "$HELD_LOCKS" "$name" || { echo "lock order violation: $name while holding:$HELD_LOCKS" >&2; return 99; }
  mkdir -p "$LOCKS"
  exec {fd}>"$LOCKS/$name"
  if [[ $wait == 0 ]]; then
    flock -n "$fd" || { exec {fd}>&-; return 1; }
  else
    flock -w "$wait" "$fd" || { exec {fd}>&-; return 1; }
  fi
  LOCKFD[$name]=$fd
  HELD_LOCKS="$HELD_LOCKS $name"
  return 0
}

lock_drop() {
  local name=$1 fd=${LOCKFD[$1]:-}
  [[ -n $fd ]] || return 0
  exec {fd}>&-
  unset 'LOCKFD[$name]'
  HELD_LOCKS=${HELD_LOCKS/ $name/}
  return 0
}

lock_drop_all() {
  local k
  for k in "${!LOCKFD[@]}"; do lock_drop "$k"; done
  return 0
}

# ---------------------------------------------------------------- stats
_record() { jq -nc --argjson ts "$(now)" --argjson issue "${n:-0}" --argjson slot "${K:-1}" "$@" '$ARGS.named' >> "$STATS"; }
# record --arg k v ... : one stats line (flocked; every line carries "slot").
record() { lk stats _record "$@" || true; return 0; }

# ---------------------------------------------------------------- control (ctl/control.json)
IFS= read -r -d '' CONTROL_JQ <<'EOF' || true
def isint: type == "number" and . == floor;
def okmodel: type == "string" and test("^opencode(-go(@[0-9]+)?)?/[a-z0-9][a-z0-9._-]{0,63}$");
def okiso: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
def dedupe: reduce .[] as $m ([]; if any(.[]; . == $m) then . else . + [$m] end);
if type != "object" then error("not an object") else . end
| if .v != 1 then error("v") else . end
| {v: 1,
   agents: ((.agents // 1) | if isint and . >= 0 and . <= 3 then . else error("agents") end),
   models: ((.models // ["opencode/deepseek-v4.1-flash-free"])
            | if type == "array" and length >= 1 and length <= 5 and all(.[]; okmodel) then dedupe else error("models") end),
   model_mode: ((.model_mode // "ordered") | if . == "ordered" or . == "auto" then . else error("model_mode") end),
   paused: ((.paused // false) | if type == "boolean" then . else error("paused") end),
   queue: ((.queue // [])
           | if type == "array" and length <= 50 and all(.[]; type == "object" and (.n | isint and . > 0) and (.at | okiso))
             then map({n, at}) else error("queue") end),
   skip: ((.skip // [])
          | if type == "array" and length <= 200 and all(.[]; isint and . > 0) then unique else error("skip") end),
   resume_ack: (.resume_ack
                | if . == null then null
                  elif type == "string" and test("^[0-9]{1,12}-[a-z0-9-]{1,40}$") then . else error("resume_ack") end)}
EOF

# control_validate <file>: normalized control JSON on stdout, or rc 1. Unknown keys are dropped.
control_validate() {
  ctl_file_ok "$1" || return 1
  jq -c "$CONTROL_JQ" "$1" 2>/dev/null
}

# control_load: sets $CONTROL (and CONTROL_SOURCE) from the console's file, else the last good
# copy, else the defaults. Never prints what the file said.
CONTROL_SOURCE=default
control_load() {
  local v
  if v=$(control_validate "$CTL/control.json"); then
    CONTROL=$v CONTROL_SOURCE=file
    if [[ $(cat "$STATE/control.last-good.json" 2>/dev/null || true) != "$v" ]]; then
      printf '%s\n' "$v" | FILE_GROUP= atomic_write "$STATE/control.last-good.json" 600 || true
    fi
  elif [[ -e $CTL/control.json ]] && v=$(control_validate "$STATE/control.last-good.json"); then
    CONTROL=$v CONTROL_SOURCE=last-good
  else
    CONTROL=$CONTROL_DEFAULT CONTROL_SOURCE=default
  fi
  return 0
}

ctl_get() { jq -r "$1" <<<"$CONTROL"; }  # ctl_get '.agents'

# ---------------------------------------------------------------- halt
# Halted <=> ui/halt.json exists and control.resume_ack != its id.
halted() {
  local f=$UI/halt.json id ack
  [[ -f $f && ! -L $f ]] || return 1
  id=$(jq -r '.id // empty' "$f" 2>/dev/null) || return 1
  [[ -n $id ]] || return 1
  ack=$(jq -r '.resume_ack // empty' <<<"${CONTROL:-$EMPTY_OBJ}")
  [[ $ack != "$id" ]]
}

_halt_write() {  # <slug> <reason> <run-dir>
  local url="" id body
  if halted; then return 0; fi
  id="$(now)-$1"
  body="factory halted itself: $2

Log: \`${3:-$LOGDIR}\` on the host. Every lane stops picking, merging, and starting model turns
until a human presses Resume in the console (resume_ack = \`$id\`)."
  url=$(timeout 40 "$GH" issue create -R "$REPO" --title "factory halted: $2" --body "$body" 2>/dev/null | tail -n1) || url=""
  jq -nc --arg id "$id" --arg reason "$2" --argjson at "$(now)" --arg url "$url" \
    '{id: $id, reason: $reason, at: $at, issue_url: (if $url == "" then null else $url end)}' | ui_write halt.json
}

# halt_raise <slug> <reason>: record the halt (once) and open the GitHub issue. Returns; callers
# that must stop the lane use halt() in run.sh.
halt_raise() {
  local slug=$1
  [[ $slug =~ ^[a-z0-9-]{1,40}$ ]] || slug=halt
  lk halt _halt_write "$slug" "$2" "${run:-}" || true
  log "HALT: $2"
  return 0
}

# ---------------------------------------------------------------- models and cooldowns
valid_model() { [[ $1 =~ ^opencode(-go(@[0-9]+)?)?/[a-z0-9][a-z0-9._-]{0,63}$ ]]; }
# The only models that may cost money: provider opencode-go (account 1) and the virtual ids opencode-go@<N>/<model> (account N, same provider and model).
# A provider id that is not matched here is treated as FREE, and a free model that reports cost > 0
# halts every lane (run.sh money guard), so a new Go account MUST be recognised here.
is_go_model() { [[ $1 == opencode-go/* || $1 == opencode-go@[0-9]*/* ]]; }
# go_real_model <model>: the id opencode is given with -m: opencode-go@N/x is opencode-go/x (same
# provider, so opencode sends exactly the headers and routing it sends for account 1).
go_real_model() { printf '%s' "${1/@[0-9]*\//\/}"; }
# go_credential <model>: "go<N>:<root-only key file>" for an account N >= 2 model whose key file
# exists, else nothing. It is handed to THAT turn's unit only (LoadCredential) as
# $CREDENTIALS_DIRECTORY/go<N>; /usr/local/bin/factory-opencode then points the provider's key
# reference at that file for that one process (the managed config on disk is not touched).
GO_KEY_DIR=${GO_KEY_DIR:-/etc/factory}
go_credential() {
  local a; a=$(go_account "$1")
  if (( a >= 2 )) && [[ -f $GO_KEY_DIR/opencode$a.key && ! -L $GO_KEY_DIR/opencode$a.key ]]; then
    printf 'go%s:%s/opencode%s.key' "$a" "$GO_KEY_DIR" "$a"
  fi
}
go_account() {  # go_account <model>: 1 for opencode-go/..., N for opencode-go@N/...
  if [[ $1 =~ ^opencode-go@([0-9]+)/ ]]; then echo "${BASH_REMATCH[1]}"; else echo 1; fi
}
sanitize_model() { printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/_/g'; }
cooldown_file() { printf '%s/cooldown/%s' "$STATE" "$(sanitize_model "$1")"; }

# cooldown_next <rate_limit|usage_cap|other> <previous-k> <now>: "<until> <k>". Rate limit: 10 min
# doubling to 2 h. Anything else the model did wrong: 20 min doubling to 6 h. usage_cap (OpenCode
# Go's weekly cap, "Go usage limit exceeded"): until the next Monday 00:00 UTC, when the cap resets
# (the same boundary as go_week_start, 345600 = 1970-01-05, a Monday). On 24-25 Oct that message,
# not recognised, kept every lane retrying for 28 h; its payload carries no reset time (96 of 96
# lines are exactly `AI_APICallError: Go usage limit exceeded`), so the weekly boundary is the
# only reset there is. To lift it by hand: rm "$(cooldown_file <model>)".
cooldown_next() {
  local reason=$1 k=$(( ${2:-0} + 1 )) now=$3 base cap shift w
  if [[ $reason == usage_cap ]]; then echo "$(( now - (now - 345600) % 604800 + 604800 )) $k"; return 0; fi
  if [[ $reason == rate_limit ]]; then base=600 cap=7200; else base=1200 cap=21600; fi
  shift=$(( k - 1 )); (( shift <= 20 )) || shift=20
  w=$(( base << shift )); (( w <= cap )) || w=$cap
  echo "$(( now + w )) $k"
}

_cooldown_hit() {  # <model> <reason>
  local f u k=0 reason=$2 next
  f=$(cooldown_file "$1"); mkdir -p "$STATE/cooldown"
  if [[ -s $f ]]; then read -r u k _ < "$f" || true; [[ $k =~ ^[0-9]+$ ]] || k=0; fi
  next=$(cooldown_next "$reason" "$k" "$(now)")
  printf '%s %s\n' "$next" "$reason" > "$f"
}
cooldown_hit() { lk cooldown _cooldown_hit "$1" "$2" || true; return 0; }
_cooldown_reset() { rm -f "$(cooldown_file "$1")"; }
cooldown_reset() { if [[ -e $(cooldown_file "$1") ]]; then lk cooldown _cooldown_reset "$1" || true; fi; return 0; }

cooldown_until() {  # prints the epoch until which the model cools (0 = not cooling)
  local f u=0; f=$(cooldown_file "$1")
  if [[ -s $f ]]; then read -r u _ < "$f" || u=0; fi
  [[ $u =~ ^[0-9]+$ ]] || u=0
  echo "$u"
}
cooldown_reason() {  # the reason word stored with the cooldown (usage_cap, rate_limit, stalled, other)
  local f u k r=""; f=$(cooldown_file "$1")
  if [[ -s $f ]]; then read -r u k r < "$f" || r=""; fi
  echo "${r:-other}"
}
is_cooling() { (( $(cooldown_until "$1") > $(now) )); }

# cooldown_json <model...>: {"<id>": {"until":..,"reason":..}} for the ones still cooling.
cooldown_json() {
  local m f u k r out='{}'
  for m in "$@"; do
    f=$(cooldown_file "$m"); [[ -s $f ]] || continue
    read -r u k r < "$f" || continue
    [[ $u =~ ^[0-9]+$ ]] && (( u > $(now) )) || continue
    out=$(jq -c --arg m "$m" --argjson u "$u" --arg r "${r:-other}" '. + {($m): {until: $u, reason: $r}}' <<<"$out")
  done
  echo "$out"
}

# err_class <opencode-jsonl>: usage_cap | rate_limit | other | none, from the error events. A rate
# limit is statusCode 429 or a message that says so. "rate" alone is not enough: it is inside
# "generate" and "separate". usage_cap is the weekly Go cap ("usage limit"); "free usage limit" is
# the older free-tier message and stays a rate limit.
err_class() {
  events "$1" | jq -r -s '
    [.[] | select(.type == "error")] as $e
    | if ($e | length) == 0 then "none" else
        ($e | map([(.error.name // ""), (.error.data.message // ""), ((.error.data.statusCode // "") | tostring),
                   ((.error.data.responseBody // "") | tostring)] | join(" ") | ascii_downcase)) as $txt
        | if any($txt[]; test("usage[ _-]?limit") and (test("free[ _-]?usage[ _-]?limit") | not)) then "usage_cap"
          elif any($e[]; ((.error.data.statusCode // "") | tostring) == "429")
             or any($txt[]; (" " + . + " ") | (contains("rate limit") or contains("rate_limit") or contains("ratelimit")
                  or contains("rate-limit") or contains(" rate ") or contains("429") or contains("quota")
                  or contains("freeusagelimit") or contains("too many")))
          then "rate_limit" else "other" end
      end'
}

jsonl_cost_positive() { events "$1" | jq -e -s 'any(.[]; .type == "step_finish" and ((.part.cost // 0) > 0))' >/dev/null; }

# jsonl_cost_sum <opencode-jsonl>: the turn's cost in USD (sum of step_finish.cost).
jsonl_cost_sum() { events "$1" | jq -s '[.[] | select(.type == "step_finish") | (.part.cost // 0)] | add // 0'; }

# ---------------------------------------------------------------- watchdog (pure parts)
# A rate limit that opencode retries silently shows up only in its own log (stderr, because run.sh
# passes --print-logs --log-level WARN), never as an event on stdout. Real line:
#   level=ERROR ... message="stream error" ... error.error="AI_APICallError: Rate limit exceeded. ..."
# "rate" alone is not enough ("generate"), and a bare 429 must be a whole number.
RATE_LIMIT_RE='rate[ _-]?limit|too many requests|statuscode[^0-9]{0,4}429|(^|[^0-9])429([^0-9]|$)|quota (exceeded|exhausted)|free[ _-]?usage[ _-]?limit'
# err_log_rate_limited <stderr-file> [from-byte-offset]: rc 0 when the log says rate limit.
err_log_rate_limited() {
  [[ -s $1 ]] || return 1
  tail -c "+$(( ${2:-0} + 1 ))" "$1" 2>/dev/null | grep -qiE "$RATE_LIMIT_RE"
}

# usage_cap: the weekly Go cap. Stricter than a rate limit on purpose, because a hit cools the model
# until Monday: the line must be opencode's own ERROR line from the API client (a tool's output or the model's text can
# say "usage limit" too) and must not be the free-tier message. Real line:
#   level=ERROR ... message="stream error" ... error.error="AI_APICallError: Go usage limit exceeded"
USAGE_CAP_RE='usage[ _-]?limit'
# err_log_usage_cap_line <stderr-file> [from-byte-offset]: the first matching line (rc 0), else rc 1.
err_log_usage_cap_line() {
  [[ -s $1 ]] || return 1
  tail -c "+$(( ${2:-0} + 1 ))" "$1" 2>/dev/null | grep -E 'level=ERROR' | grep -E 'AI_APICallError|APIError|stream error' | grep -iE "$USAGE_CAP_RE" \
    | grep -viE 'free[ _-]?usage[ _-]?limit' | head -n 1 | grep .
}
# err_log_class <stderr-file> [from-byte-offset]: usage_cap | rate_limit | none.
err_log_class() {
  if err_log_usage_cap_line "$@" >/dev/null; then echo usage_cap
  elif err_log_rate_limited "$@"; then echo rate_limit
  else echo none; fi
}

# ---------------------------------------------------------------- spend (OpenCode Go)
# Free models never cost anything (cost > 0 on one of them halts every lane). Models under
# opencode-go/ may: every such turn appends {"ts","slot","issue","model","cost"} to $SPEND, and
# the budgets below decide when the lanes fall back to the free zero-retention models listed in
# control.models (none listed: the lanes back off).
_spend_append() {  # <model> <cost>
  jq -nc --argjson ts "$(now)" --argjson slot "${K:-1}" --argjson issue "${n:-0}" --arg model "$1" --argjson cost "$2" \
    '{ts: $ts, slot: $slot, issue: $issue, model: $model, cost: $cost}' >> "$SPEND"
}
spend_record() {  # spend_record <model> <cost>
  [[ $2 =~ ^[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$ ]] || return 0
  lk spend _spend_append "$1" "$2" || true
  return 0
}

_spend_rows() { [[ -f $SPEND ]] && jq -c -R 'fromjson? // empty' "$SPEND" 2>/dev/null; return 0; }

# go_week_start: the epoch of the last Monday 00:00 UTC (345600 is 1970-01-05, a Monday). OpenCode's
# weekly cap resets then, not on a trailing 7 d window: a trailing window kept counting last week's
# spend after OpenCode had reset it, and idled every lane with half the week's quota left.
go_week_start() { local t; t=$(now); echo $(( t - (t - 345600) % 604800 )); }

# go_budget <account> <5H|WEEK|MONTH>: the budget of that account (GO<N>_BUDGET_*, else account 1's).
# go_budget <account> <5H|WEEK|MONTH>: a number, always. A value that is not one (a typo in the env
# file) falls back to the default, so jq never sees junk: before, it made spend null in models.json
# and broke spend_blocked_until, the function that enforces the budgets.
go_budget() {
  local v1="GO_BUDGET_$2" vn="GO$1_BUDGET_$2" v d num='^-?[0-9]+([.][0-9]+)?$'
  case $2 in 5H) d=14 ;; WEEK) d=36 ;; MONTH) d=76 ;; *) d=0 ;; esac
  v=${!v1:-}; [[ $v =~ $num ]] || v=$d
  if [[ $1 != 1 && ${!vn:-} =~ $num ]]; then v=${!vn}; fi
  echo "$v"
}

# A spend row belongs to the account its model id names: opencode-go@N/... is account N, anything
# else (opencode-go/..., and every row written before accounts existed) is account 1.
SPEND_ACCT_JQ='def acct: (.model // "") | (capture("^opencode-go@(?<n>[0-9]+)/") // {n: "1"}) | .n;'

# spend_summary [account]: {"h5":x,"week":y,"month":z}, USD over the trailing 5 h, the OpenCode week
# (since go_week_start) and the trailing 30 d, for one account (default 1). sync.sh publishes this.
spend_summary() {
  _spend_rows | jq -c -s --argjson now "$(now)" --argjson ws "$(go_week_start)" --arg a "${1:-1}" "$SPEND_ACCT_JQ"'
    def since($t): [.[] | select(acct == $a and .ts >= $t) | (.cost // 0)] | add // 0 | . * 1000000 | round / 1000000;
    {h5: since($now - 18000), week: since($ws), month: since($now - 2592000)}'
}

# spend_accounts: {"1": {h5, week, month, budget: {h5, week, month}}, "2": {...}} for GO_ACCOUNTS.
spend_accounts() {
  local a out='{}' s
  for a in $GO_ACCOUNTS; do
    [[ $a =~ ^[0-9]+$ ]] || continue
    s=$(spend_summary "$a") || continue
    out=$(jq -c --arg a "$a" --argjson s "$s" --argjson b5 "$(go_budget "$a" 5H)" --argjson bw "$(go_budget "$a" WEEK)" --argjson bm "$(go_budget "$a" MONTH)" \
      '. + {($a): ($s + {budget: {h5: $b5, week: $bw, month: $bm}})}' <<<"$out")
  done
  echo "$out"
}

# spend_blocked_until [account]: the epoch at which that account's Go spend (default 1) is back under
# every budget of its own; 0 when it is under them all now. The week frees only at the next Monday
# 00:00 UTC. A budget of 0 (or less) switches Go off: re-checked every hour.
spend_blocked_until() {
  local a=${1:-1}
  _spend_rows | jq -s -r --argjson now "$(now)" --argjson ws "$(go_week_start)" --arg a "$a" \
    --argjson b5 "$(go_budget "$a" 5H)" --argjson bw "$(go_budget "$a" WEEK)" --argjson bm "$(go_budget "$a" MONTH)" "$SPEND_ACCT_JQ"'
    def freeat($w; $b):
      if $b <= 0 then $now + 3600 else
        ([.[] | select(acct == $a and ($now - .ts) < $w)] | sort_by(.ts)) as $e
        | ($e | map(.cost // 0) | add // 0) as $tot
        | if $tot < $b then 0
          else (reduce range(0; $e | length) as $i ({sum: $tot, at: 0};
                  if .sum >= $b then {sum: (.sum - ($e[$i].cost // 0)), at: ($e[$i].ts + $w)} else . end)).at
          end
      end;
    def weekat($b):
      if $b <= 0 then $now + 3600
      elif ([.[] | select(acct == $a and .ts >= $ws) | (.cost // 0)] | add // 0) < $b then 0
      else $ws + 604800 end;
    [freeat(18000; $b5), weekat($bw), freeat(2592000; $bm)] | max'
}

# _budget_cool <go-model>: over budget -> the model cools until the window frees (cooldown file,
# reason "budget", no escalation); back under budget -> a budget cooldown is lifted.
_budget_cool() {
  local f u until k r
  f=$(cooldown_file "$1"); until=$(spend_blocked_until "$(go_account "$1")")
  [[ $until =~ ^[0-9]+$ ]] || until=0
  if (( until > $(now) )); then
    u=0 k=0 r=""
    if [[ -s $f ]]; then read -r u k r < "$f" || true; fi
    [[ $u =~ ^[0-9]+$ ]] || u=0
    if (( u < until )); then mkdir -p "$STATE/cooldown"; printf '%s 0 budget\n' "$until" > "$f"; fi
  elif [[ -s $f ]]; then
    read -r u k r < "$f" || true
    if [[ ${r:-} == budget ]]; then rm -f "$f"; fi
  fi
}
budget_sync() {  # budget_sync <model...>: apply the Go budgets to the cooldown files
  local m
  for m in "$@"; do
    if is_go_model "$m"; then lk cooldown _budget_cool "$m" || true; fi
  done
  return 0
}
jsonl_first_session() { events "$1" | jq -r -s 'map(.sessionID // .part.sessionID // empty) | first // empty'; }
jsonl_tokens() {
  events "$1" | jq -c -s '[.[] | select(.type == "step_finish") | .part.tokens]
    | {input: (map(.input // 0) | add // 0), output: (map(.output // 0) | add // 0),
       reasoning: (map(.reasoning // 0) | add // 0), cache_read: (map(.cache.read // 0) | add // 0)}'
}

# models_eligible <models.json>: ids a lane may use, JSON array, fallback order (paid first, then
# free). Contract (SCHEMA 3.3): only entries of free + paid with zero_retention == true; null and
# false are out (the provider may train on or log our prompts). paid counts only for opencode-go/
# ids. Old shape (no entry carries a zero_retention key at all): every free id, as before.
models_eligible() {
  jq -c '
    def okid($p): .id | type == "string" and startswith($p) and test("^opencode(-go(@[0-9]+)?)?/[a-z0-9][a-z0-9._-]{0,63}$");
    ([.paid[]? | select(.id | type == "string" and test("^opencode-go(@[0-9]+)?/[a-z0-9][a-z0-9._-]{0,63}$"))]) as $p
    | ([.free[]? | select(okid("opencode/"))]) as $f
    | ($p + $f) as $all
    | if any($all[]; has("zero_retention")) then [$all[] | select(.zero_retention == true) | .id]
      else [$f[] | .id] end' "$1" 2>/dev/null || echo '[]'
}

# models_effective <control-models-json> <eligible-ids-json> <cooling-ids-json>: control.models
# that are eligible (control order), else the first eligible one that is not cooling (paid first, as models_eligible
# orders them); cooling ones moved last (stable).
models_effective() {
  jq -nc --argjson m "$1" --argjson f "$2" --argjson c "$3" '
    def inl($l): . as $x | any($l[]; . == $x);
    ([$m[] | select(inl($f))]) as $i
    | (if ($i | length) > 0 then $i elif ($f | length) > 0 then [(([$f[] | select(inl($c) | not)] | first) // $f[0])] else [] end) as $e
    | [$e[] | select(inl($c) | not)] + [$e[] | select(inl($c))]'
}

IFS= read -r -d '' RANK_JQ <<'EOF' || true
# Models, ranked by what they have delivered: merged PR = 1 win, open PR = 0.5, anything else
# = 0, score = (wins + 1) / (attempts + 2); a model that errored in the last 2 h goes last.
. as $stats
| ($stats | map(select(.kind == "outcome" and (.model // "") != "" and (.outcome | IN("pr", "verify_failed", "no_commit"))))) as $o
| [$stats[] | select(.kind == "call" and .model_error and ($now - .ts) < 7200) | .model] as $down
| [ $models | to_entries[] | .value as $m | .key as $i
    | [$o[] | select(.model == $m)] as $mine
    | ([$mine[] | if .outcome != "pr" then 0
                  else ($prs[.issue | tostring] // "OPEN") as $s
                       | if $s == "MERGED" then 1 elif $s == "OPEN" then 0.5 else 0 end end] | add // 0) as $wins
    | {model: $m, i: $i, down: any($down[]; . == $m), attempts: ($mine | length),
       score: ((($wins + 1) / (($mine | length) + 2)) * 1000 | round / 1000)} ]
| sort_by([.down, -.score, .i]) | map(.model)
EOF

# rank_models <models-json> <prs-by-issue-json> [stats-file]: ids, best first.
rank_models() {
  tail -n 4000 "${3:-$STATS}" 2>/dev/null | jq -c -R 'fromjson? // empty' \
    | jq -c -s --argjson now "$(now)" --argjson models "$1" --argjson prs "$2" "$RANK_JQ"
}

# rl_recent_all <stats-file> <window-s> <model...>: rc 0 when every model had a rate-limited call
# inside the window.
rl_recent_all() {
  local file=$1 win=$2; shift 2
  (( $# > 0 )) || return 1
  local models; models=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
  tail -n 3000 "$file" 2>/dev/null | jq -c -R 'fromjson? // empty' \
    | jq -e -s --argjson now "$(now)" --argjson win "$win" --argjson models "$models" '
        . as $l | $models | all(.[]; . as $m | any($l[]; .kind == "call" and .model == $m and .rate_limited == true and ($now - .ts) <= $win))' >/dev/null
}

# effective_agents_calc <agents> <all-rate-limited 0|1> <disk-free-gb> <runner-queued>
effective_agents_calc() {
  local a=$1 rl=$2 disk=$3 q=$4
  (( a <= 3 )) || a=3
  # The box may also carry production databases. A lane that kept building at < 20 GB once filled
  # the disk and a shared Postgres PANICked: below DISK_STOP_GB nothing builds at all.
  if (( disk < ${DISK_STOP_GB:-20} )); then echo 0; return 0; fi
  if (( a > 1 )) && { (( rl == 1 )) || (( disk < ${DISK_ONE_GB:-40} )) || (( q >= 3 )); }; then a=1; fi
  echo "$a"
}

# ---------------------------------------------------------------- claims (STATE/claims/<issue>)
# {slot, run_id, at, state: active|done, until?, pid?}. Stale <=> the slot's unit is not the
# invocation that wrote it. A manual run has no unit, so it proves itself by its pid instead.
claim_is_stale() {  # <claim-json> <current-invocation-id ("" if the unit is not active)> <pid-alive 0|1> <now>
  local rc=0
  jq -e -n --argjson c "$1" --arg cur "$2" --argjson pa "$3" --argjson now "$4" '
    if $c.state == "done" then ($c.until // 0) <= $now
    elif ($c.run_id // "" | startswith("manual-")) then $pa == 0
    else $c.run_id != $cur end' >/dev/null 2>&1 || rc=$?
  (( rc >= 2 )) && return 0   # unreadable claim (jq error): treat as stale
  return "$rc"
}

claim_stale_file() {  # rc 0 = stale (or unreadable)
  local c slot cur="" pid pa=0 active
  c=$(cat "$1" 2>/dev/null) || return 0
  jq -e 'type == "object"' <<<"$c" >/dev/null 2>&1 || return 0
  slot=$(jq -r '.slot // 0' <<<"$c"); pid=$(jq -r '.pid // 0' <<<"$c")
  if slot_valid "$slot"; then
    active=$(systemctl show -p ActiveState --value "$AGENT_UNIT@$slot.service" 2>/dev/null || true)
    if [[ $active == active || $active == activating || $active == deactivating ]]; then
      cur=$(systemctl show -p InvocationID --value "$AGENT_UNIT@$slot.service" 2>/dev/null || true)
    fi
  fi
  if [[ $pid =~ ^[0-9]+$ ]] && (( pid > 0 )) && [[ -d /proc/$pid ]]; then pa=1; fi
  claim_is_stale "$c" "$cur" "$pa" "$(now)"
}

_claim_take() {  # <issue> <slot> <run_id>: rc 0 taken (or already ours), 1 held by someone else
  local f=$STATE/claims/$1
  mkdir -p "$STATE/claims"
  if [[ -e $f ]]; then
    if jq -e --arg r "$3" '.state == "active" and .run_id == $r' "$f" >/dev/null 2>&1; then return 0; fi
    claim_stale_file "$f" || return 1
  fi
  jq -nc --argjson slot "$2" --arg run_id "$3" --argjson at "$(now)" --argjson pid "$$" \
    '{slot: $slot, run_id: $run_id, at: $at, state: "active", pid: $pid}' > "$f.tmp.$$"
  mv -f "$f.tmp.$$" "$f"
}
claim_take() { lk claim _claim_take "$1" "$K" "$RUN_ID"; }  # claim_take <issue>

# _claim_release <slot> <run_id|"">: drop active claims of this slot (of this run when given).
_claim_release() {
  local f
  for f in "$STATE"/claims/*; do
    [[ -e $f ]] || continue
    if jq -e --argjson s "$1" --arg r "$2" '.state == "active" and .slot == $s and ($r == "" or .run_id == $r)' "$f" >/dev/null 2>&1; then
      rm -f "$f"
    fi
  done
}
claim_release_run() { lk claim _claim_release "$K" "$RUN_ID" || true; return 0; }
claim_release_slot() { lk claim _claim_release "$1" "" || true; return 0; }

# A6: after a merge that said "Closes", keep the issue off the pick list until GitHub has closed it.
_claim_tombstone() {  # <issue> <secs>
  mkdir -p "$STATE/claims"
  jq -nc --argjson slot "$K" --arg run_id "$RUN_ID" --argjson at "$(now)" --argjson until "$(( $(now) + $2 ))" \
    '{slot: $slot, run_id: $run_id, at: $at, state: "done", until: $until}' > "$STATE/claims/$1.tmp.$$"
  mv -f "$STATE/claims/$1.tmp.$$" "$STATE/claims/$1"
}
claim_tombstone() { lk claim _claim_tombstone "$1" "${2:-900}" || true; return 0; }

_claim_gc() {
  local f
  for f in "$STATE"/claims/*; do
    [[ -e $f ]] || continue
    if claim_stale_file "$f"; then rm -f "$f"; fi
  done
}
claim_gc() { lk claim _claim_gc || true; return 0; }

# claims_live_json: [{issue, slot, state, until}] for every claim that is not stale.
claims_live_json() {
  local f out='[]' n
  for f in "$STATE"/claims/*; do
    [[ -e $f ]] || continue
    n=${f##*/}; [[ $n =~ ^[0-9]+$ ]] || continue
    if claim_stale_file "$f"; then continue; fi
    out=$(jq -c --argjson n "$n" --slurpfile c "$f"       '. + [{issue: $n, slot: $c[0].slot, state: $c[0].state, until: ($c[0].until // null)}]' <<<"$out")
  done
  echo "$out"
}

# ---------------------------------------------------------------- interrupts (ctl/interrupt-K.json)
sanitize_message() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }  # keeps \n and tab

# intr_validate <file>: {id, run_id, action, skip, message} on stdout, or rc 1. The message has
# control characters stripped except newline and must be 1..2000 chars for a steer.
intr_validate() {
  local f=$1 id run_id action skip msg
  ctl_file_ok "$f" || return 1
  jq -e 'type == "object" and (.id | type == "string") and (.run_id | type == "string")
         and (.action == "stop" or .action == "steer")
         and ((.skip // false) | type == "boolean") and ((.message // "") | type == "string")' "$f" >/dev/null 2>&1 || return 1
  id=$(jq -r .id "$f"); [[ $id =~ ^[A-Za-z0-9_-]{1,64}$ ]] || return 1
  run_id=$(jq -r .run_id "$f"); [[ $run_id =~ ^[A-Za-z0-9_.-]{1,80}$ ]] || return 1
  action=$(jq -r .action "$f")
  skip=$(jq -r '.skip // false' "$f")
  msg=""
  if [[ $action == steer ]]; then
    msg=$(jq -j '.message // ""' "$f" | sanitize_message)
    (( ${#msg} >= 1 && ${#msg} <= 2000 )) || return 1
    [[ $msg =~ [^[:space:]] ]] || return 1
  fi
  jq -nc --arg id "$id" --arg run_id "$run_id" --arg action "$action" --argjson skip "$skip" --arg message "$msg" \
    '{id: $id, run_id: $run_id, action: $action, skip: $skip, message: $message}'
}

# intr_should_act <validated-json> <my-run-id> <last-handled-id>
intr_should_act() {
  jq -e --arg r "$2" --arg l "$3" '.run_id == $r and .id != $l' <<<"$1" >/dev/null
}

# ---------------------------------------------------------------- issue helpers
# issue_json <n> <title>: the "issue" object of the slot status.
issue_json() {
  jq -nc --argjson n "$1" --arg title "$2" --arg repo "$REPO" '
    (if ($title | startswith("[")) and ($title | contains("]")) then ($title | split("]")[0] | ltrimstr("[")) else null end) as $tag
    | {n: $n, title: $title, tag: $tag, family: (if $tag == null then null else ($tag | split("-")[0]) end),
       url: ("https://github.com/" + $repo + "/issues/" + ($n | tostring))}'
}

# ---------------------------------------------------------------- slot status (ui/slots/K.json)
ST_STATE=idle ST_STAGE="" ST_SUB="" ST_NOTE="" ST_MODEL="" ST_SESSION="" ST_RUN=""
ST_ISSUE_JSON=null ST_PR_JSON=null ST_TURN_JSON=null ST_CI_JSON=null
ST_STAGE_STARTED=0 ST_ISSUE_STARTED=0
ST_TOK_IN=0 ST_TOK_OUT=0 ST_TOK_REASON=0 ST_TOK_CACHE=0
ST_REQ_TOTAL=-1 ST_REQ_DONE=0
ST_STEER_PENDING=null ST_STEER_LAST=null ST_INTR_JSON=null
ST_EFF=1 ST_LOGDIR="" ST_LAST=0 DRAIN=0 ST_DISABLED=""

# status_json: the slot file, exactly per the contract, from the ST_* variables.
status_json() {
  local state=$ST_STATE
  if [[ $state == running && $DRAIN == 1 ]]; then state=draining; fi
  jq -nc --argjson slot "${K:-0}" --arg run_id "$ST_RUN" --arg state "$state" --arg stage "$ST_STAGE" \
    --arg sub "$ST_SUB" --argjson issue "$ST_ISSUE_JSON" --argjson pr "$ST_PR_JSON" --arg model "$ST_MODEL" \
    --arg session "$ST_SESSION" --argjson turn "$ST_TURN_JSON" --argjson ss "$ST_STAGE_STARTED" \
    --argjson is "$ST_ISSUE_STARTED" --argjson tin "$ST_TOK_IN" --argjson tout "$ST_TOK_OUT" \
    --argjson trs "$ST_TOK_REASON" --argjson tcr "$ST_TOK_CACHE" --argjson rt "$ST_REQ_TOTAL" --argjson rd "$ST_REQ_DONE" \
    --argjson ci "$ST_CI_JSON" --argjson sp "$ST_STEER_PENDING" --argjson sl "$ST_STEER_LAST" --argjson intr "$ST_INTR_JSON" \
    --arg note "$ST_NOTE" --argjson eff "$ST_EFF" --arg logdir "$ST_LOGDIR" --argjson now "$(now)" '
    def nz: if . == "" then null else . end;
    {v: 1, slot: $slot, run_id: ($run_id | nz), state: $state, stage: ($stage | nz), sub: $sub[0:40],
     issue: $issue, pr: $pr, model: ($model | nz), session: ($session | nz), turn: $turn,
     stage_started: (if $ss > 0 then $ss else null end), issue_started: (if $is > 0 then $is else null end),
     tokens: {input: $tin, output: $tout, reasoning: $trs, cache_read: $tcr},
     requirements: (if $rt < 0 then null else {total: $rt, done: $rd} end),
     ci: $ci, steer: {pending: $sp, last: $sl}, interrupt: $intr, note: $note[0:200],
     effective_agents: $eff, log_dir: ($logdir | nz), updated: $now}'
}

st_flush() {
  ST_LAST=$(now)
  if [[ -n $ST_DISABLED || -z ${K:-} ]]; then return 0; fi
  status_json | atomic_write "$UI/slots/$K.json" 640 2>/dev/null || true
  return 0
}

# st k=v ...: set scalar fields (state stage sub note model session) and write the file.
st() {
  local kv
  for kv in "$@"; do
    case $kv in
      state=*) ST_STATE=${kv#*=} ;;
      stage=*) ST_STAGE=${kv#*=} ;;
      sub=*) ST_SUB=${kv#*=} ;;
      note=*) ST_NOTE=${kv#*=} ;;
      model=*) ST_MODEL=${kv#*=} ;;
      session=*) ST_SESSION=${kv#*=} ;;
    esac
  done
  st_flush
}

# ---------------------------------------------------------------- classifier (pick and sync share it)
# Adoption (SCHEMA 3.2): an open PR labelled agent-adopt, from the base repo itself (not a fork),
# whose body has exactly one closing reference (Closes|Fixes|Resolves #N, any case) makes issue N
# pickable work: class eligible, reason "PR #P adopted", adopt_pr P. The PR does not "take" N.
# Anything else with the label is ignored, and says why in github.json (adopt_ignored). A PR that
# already carries `agent` is an agent PR and is shepherded, not adopted.
IFS= read -r -d '' ADOPT_JQ_DEFS <<'EOF' || true
def closing_refs: [ (.body // "") | scan("\\b(?:closes|fixes|resolves)\\s+#([0-9]+)"; "i") | .[0] | tonumber ] | unique;
# input: the open PRs. $openn: open issue numbers. $st: {"<pr>": {last_head, runs}}. $cap: max runs per head.
def adoptions($openn; $st; $cap):
  [ .[] | select(any(.labels[]?; .name == "agent-adopt")) | select(any(.labels[]?; .name == "agent") | not)
    | . as $p | closing_refs as $c
    | if $p.isCrossRepository != false then {pr: $p.number, reason: "the PR comes from a fork or its origin is not verified"}
      elif ($c | length) == 0 then {pr: $p.number, reason: "the PR body has no Closes/Fixes/Resolves #N reference"}
      elif ($c | length) > 1 then {pr: $p.number, reason: ("more than one closing reference: " + ($c | map("#" + tostring) | join(", ")))}
      elif ($openn | any(. == $c[0])) | not then {pr: $p.number, reason: ("issue #" + ($c[0] | tostring) + " is not open")}
      else {pr: $p.number, issue: $c[0], head: ($p.headRefOid // ""),
            capped: (($st[($p.number | tostring)] // {}) as $s | ($s.runs // 0) >= $cap and ($s.last_head // "") == ($p.headRefOid // ""))} end ]
  | sort_by(.pr) as $all
  | ($all | map(select(.issue != null))) as $ok
  | {adopted: ([$ok | group_by(.issue)[] | (first + {prs: map(.pr)})] | sort_by(.pr)),
     ignored: (([$all[] | select(.issue == null)]
               + [$ok | group_by(.issue)[] | . as $g | $g[1:][] | {pr, reason: ("issue #" + (.issue | tostring) + " is already adopted by PR #" + ($g[0].pr | tostring))}])
              | sort_by(.pr))};
EOF
# The tag in "[LAY-02] title", shared by the classifier and the closed-issue list.
TAGOF_DEF='def tagof: if (.title | startswith("[")) and (.title | contains("]")) then (.title | split("]")[0] | ltrimstr("[")) else null end;'


# Inputs (slurped files): issues (gh issue list), prs (open PRs: number,title,body,labels,...), control
# (normalized), consumed ({"n": iso}), claims (claims_live_json), blocked ({"n":[open deps]}),
# adoptst ({"<pr>": {last_head, runs, complete}}).
IFS= read -r -d '' CLASSIFY_JQ <<'EOF' || true
def famof($t): if $t == null then null else ($t | split("-")[0]) end;
def prio: ([.labels[].name | select(test("^P[0-9]$"))] | first // null);
$issues[0] as $iss | $prs[0] as $prs | $control[0] as $ctl | ($consumed[0] // {}) as $con
| ($claims[0] // []) as $claims | ($blocked[0] // {}) as $blk
| ($ctl.skip // []) as $skip
| ($prs | adoptions([$iss[].number]; ($adoptst[0] // {}); $cap) | .adopted) as $adopted
| [ ($ctl.queue // []) | to_entries[] | select(.value.at > ($con[(.value.n | tostring)] // "")) | {n: .value.n, qi: .key} ] as $queue
| [ $claims[] | select(.state == "active") | .issue as $i
    | $iss[] | select(.number == $i) | famof(tagof) | select(. != null) ] as $busy
| [ $iss[]
    | . as $i | tagof as $tag | .number as $n
    | ([$adopted[] | select(.issue == $n)] | first) as $ad
    # A PR takes an issue when its title names it (tag or #N) or its body says Closes/Fixes/Resolves/Refs
    # #N. A bare mention in prose ("needs #14", "see #22") is a dependency or a note, not a claim:
    # counting it once blocked an issue behind a design-decision PR and another behind the PR that
    # waits for it.
    | ([$prs[] | select(.number as $pn | (((.title | ($tag != null and contains("[" + $tag + "]")) or test("#" + ($n | tostring) + "([^0-9]|$)"))
          or ((.body // "") | test("\\b(?:closes|fixes|resolves|refs)\\s+#" + ($n | tostring) + "([^0-9]|$)"; "i")))
          and (((($ad.prs // []) | any(. == $pn)) | not))))
        | .number]) as $takers
    | ([$claims[] | select(.issue == $n)] | first) as $claim
    | ($queue | map(select(.n == $n)) | first) as $q
    | ($blk[($n | tostring)] // []) as $deps
    | ([.labels[].name]) as $labels
    | {n: $n, title: .title, tag: $tag, family: famof($tag), milestone: (.milestone.title // null), priority: prio,
       labels: $labels, assignees: .assignees, deps: $deps, taken_by: $takers, claimed_by: null, order: null, qi: ($q.qi // null),
       url: ("https://github.com/" + $repo + "/issues/" + ($n | tostring)),
       # Numbers only, never the body: the console sizes the backlog from these (SCHEMA 3.2).
       size: ((.body // "") as $b | ($b | split("\n")) as $ls
         | {chars: ($b | length),
            bullets: ([$ls[] | select(test("^\\s*([-*]|[0-9]+[.)])\\s+\\S"))] | length),
            checkboxes: ([$ls[] | select(test("^\\s*[-*]\\s*\\[[ xX]\\]"))] | length)})}
    | . + (if $ad != null then {adopt_pr: $ad.pr} else {} end)
    | . + (
        if $claim != null and $claim.state == "active" then {class: "running", reason: ("lane " + ($claim.slot | tostring)), claimed_by: $claim.slot}
        elif $claim != null and $claim.state == "done" then {class: "ineligible", reason: "just merged, waiting for GitHub to close it"}
        elif ($skip | any(. == $n)) or ($labels | any(. == "agent-skip")) then {class: "skipped", reason: (if ($skip | any(. == $n)) then "control.skip" else "label agent-skip" end)}
        elif ($takers | length) > 0 then {class: "taken", reason: ("open PR " + ($takers | map("#" + tostring) | join(", ")))}
        elif $q != null then {class: "queued", reason: "console queue"}
        elif ($labels | any(. == "agent-failed")) then {class: "failed", reason: "label agent-failed"}
        elif ($labels | any(. == "agent-blocked")) or ($deps | length) > 0 then
          {class: "blocked", reason: (if ($deps | length) > 0 then "waiting for " + ($deps | map("#" + tostring) | join(", ")) else "label agent-blocked" end)}
        elif $ad != null and $ad.capped then
          {class: "ineligible", reason: ("PR #" + ($ad.pr | tostring) + " adopted: already " + ($cap | tostring) + " attempts on the same head, waiting for a new push")}
        elif $ad != null then {class: "eligible", reason: ("PR #" + ($ad.pr | tostring) + " adopted")}
        elif (.milestone // null) == null then {class: "ineligible", reason: "no milestone"}
        elif (.assignees | length) > 0 then {class: "ineligible", reason: "has an assignee"}
        else {class: "eligible", reason: ""} end) ] as $all
| ([$all[] | select(.class == "queued")] | sort_by(.qi) | map(.n)) as $qorder
| ([$all[] | select(.class == "eligible")
    | . as $x | $x + {busy: (if $x.family != null and ($busy | any(. == $x.family)) then 1 else 0 end)}]
   | sort_by([(if .adopt_pr != null then 0 else 1 end), (.milestone // "~"), (.priority // "P9"), .busy, .n]) | map(.n)) as $eorder
| $all
| map(. as $x | del(.qi, .assignees) + {order: (
      if $x.class == "queued" then ($qorder | index($x.n) + 1)
      elif $x.class == "eligible" then (($qorder | length) + ($eorder | index($x.n)) + 1)
      else null end)})
| sort_by(.n)
EOF
CLASSIFY_JQ="$TAGOF_DEF"$'\n'"$ADOPT_JQ_DEFS"$'\n'"$CLASSIFY_JQ"

_adopt_in() { [[ -s $1/adopt.json ]] || echo '{}' > "$1/adopt.json"; }

# classify_run <dir>: the classified issue list for the files gather_* left in <dir>.
classify_run() {
  _adopt_in "$1"
  jq -c --arg repo "$REPO" --argjson cap "$ADOPT_MAX_RUNS" --slurpfile issues "$1/issues.json" --slurpfile prs "$1/prs.json" \
    --slurpfile control "$1/control.json" --slurpfile consumed "$1/consumed.json" \
    --slurpfile claims "$1/claims.json" --slurpfile blocked "$1/blocked.json" --slurpfile adoptst "$1/adopt.json" -n "$CLASSIFY_JQ"
}

# adopt_report <dir>: {"adopted":[{pr,issue,head,capped}],"ignored":[{pr,reason}]} for github.json.
adopt_report() {
  _adopt_in "$1"
  jq -c --argjson cap "$ADOPT_MAX_RUNS" --slurpfile issues "$1/issues.json" --slurpfile prs "$1/prs.json" --slurpfile adoptst "$1/adopt.json" -n \
    "$ADOPT_JQ_DEFS"' $prs[0] | adoptions([$issues[0][].number]; ($adoptst[0] // {}); $cap)'
}

# ---------------------------------------------------------------- adoption state (STATE/adopt/<pr>.json)
# Root-only. {issue, human_head, last_head, runs, complete}. last_head is the PR head after our
# last run (our own push included); runs counts adoption runs since a head we did not produce
# appeared (a human push resets it). complete: the checklist was full when we handed the PR to
# the shepherd; shepherd merges an adopted PR only then.
adopt_file() { printf '%s/adopt/%s.json' "$STATE" "$1"; }
adopt_known() { [[ -f $(adopt_file "$1") ]]; }
adopt_complete() { jq -e '.complete == true' "$(adopt_file "$1")" >/dev/null 2>&1; }
adopt_get() { cat "$(adopt_file "$1")" 2>/dev/null || echo '{}'; }
_adopt_put() { mkdir -p "$STATE/adopt"; FILE_GROUP= atomic_write "$(adopt_file "$1")" 600; }
# adopt_begin <pr> <issue> <head>: count this run before it starts (a crash must not loop for free).
adopt_begin() {
  adopt_get "$1" | jq -c --argjson issue "$2" --arg head "$3" '
    . as $c | {issue: $issue, complete: ($c.complete // false), last_head: $head,
      human_head: (if ($c.last_head // "") == $head then ($c.human_head // $head) else $head end),
      runs: (if ($c.last_head // "") == $head then (($c.runs // 0) + 1) else 1 end)}' | _adopt_put "$1"
}
# adopt_update <pr> <last-head> <complete true|false>
adopt_update() {
  adopt_get "$1" | jq -c --arg head "$2" --argjson c "$3" '. + {last_head: $head, complete: $c}' | _adopt_put "$1"
}
adopt_forget() { rm -f "$(adopt_file "$1")"; }

# Dependencies an issue declares in its own text ("**Depends on**: #3, #8, #10, #23 ..."; the
# Indonesian "Bergantung pada" / "Tergantung pada" is accepted too). Nothing needs to be planned to
# learn that an issue waits for #23: the plan turns that rediscovered it cost 5 turns (~26 min of
# lane time). Only the first such line counts, up to its first full
# stop; a number after it is prose. `declared_deps` (on one issue object) is the parser; DECLARED_JQ
# keeps the open ones, which is what blocks a pick: {"<n>": [open issue numbers]}. DECLARED_ALL_JQ
# keeps every one, whatever its state, for the console's dependency map: {"<n>": [issue numbers]}.
IFS= read -r -d '' DECLARED_DEF <<'EOF' || true
def declared_deps: .number as $n
  | ((.body // "") | split("\n") | map(select(test("^[[:space:]*_>-]*(Bergantung pada|Tergantung pada|Depends on|Blocked by)[*_]*[[:space:]]*:"; "i"))) | first // "") as $line
  | ($line | sub("^[^:]*:"; "") | sub("[.]([[:space:]]|$).*"; "")) as $txt
  | [$txt | scan("#([0-9]+)") | .[0] | tonumber | select(. != $n)] | unique;
EOF
DECLARED_JQ="$DECLARED_DEF"'
. as $iss | [$iss[].number] as $open
| [ $iss[] | {key: (.number | tostring), value: (declared_deps | map(select(. as $d | $open | any(. == $d))))}
    | select(.value | length > 0) ] | from_entries'
DECLARED_ALL_JQ="$DECLARED_DEF"'
[ .[] | {key: (.number | tostring), value: declared_deps} | select(.value | length > 0) ] | from_entries'


# gather_local <dir>: control, consumed, claims, blocked-deps (needs issues.json for "open").
gather_local() {
  local d=$1 f m declared
  printf '%s\n' "$CONTROL" > "$d/control.json"
  if [[ -f $UI/consumed.json && ! -L $UI/consumed.json ]] && jq -e 'type == "object"' "$UI/consumed.json" >/dev/null 2>&1; then
    cp "$UI/consumed.json" "$d/consumed.json"
  else
    echo '{}' > "$d/consumed.json"
  fi
  claims_live_json > "$d/claims.json"
  echo '{}' > "$d/adopt.json"
  for f in "$STATE"/adopt/*.json; do
    [[ -e $f ]] || continue
    m=${f##*/}; m=${m%.json}; [[ $m =~ ^[0-9]+$ ]] || continue
    jq -c --arg m "$m" --slurpfile cur "$d/adopt.json" '$cur[0] + {($m): {last_head, runs, complete}}' "$f" > "$d/adopt.tmp" 2>/dev/null       && mv "$d/adopt.tmp" "$d/adopt.json" || true
  done
  wait_graph "$d"
  return 0
}

# wait_graph <dir>: $dir/blocked.json = {"<n>": [open issues #n waits for]}, from what plans recorded
# (STATE/blocked) and what issue texts declare. Needs $dir/issues.json (number, body). The classifier
# and block_issue read the same graph, so a lane never refuses a wait the board does not show.
wait_graph() {
  local d=$1 f m declared
  echo '{}' > "$d/blocked.json"
  if [[ -s $d/issues.json ]]; then
    local open; open=$(jq -c '[.[].number]' "$d/issues.json")
    for f in "$STATE"/blocked/*; do
      [[ -e $f ]] || continue
      m=${f##*/}; [[ $m =~ ^[0-9]+$ ]] || continue
      jq -c --argjson open "$open" --arg m "$m" --slurpfile cur "$d/blocked.json" \
        '$cur[0] + {($m): [.[] | . as $x | select($open | any(. == $x))]}' "$f" > "$d/blocked.tmp" 2>/dev/null \
        && mv "$d/blocked.tmp" "$d/blocked.json" || true
    done
    # Declared in the issue text (no plan turn needed), merged with what plans recorded.
    if declared=$(jq -c "$DECLARED_JQ" "$d/issues.json" 2>/dev/null) && [[ -n $declared && $declared != "{}" ]]; then
      jq -c --argjson b "$declared" 'reduce ($b | to_entries[]) as $e (.; .[$e.key] = (((.[$e.key] // []) + $e.value) | unique))' \
        "$d/blocked.json" > "$d/blocked.tmp" 2>/dev/null && mv "$d/blocked.tmp" "$d/blocked.json" || true
    fi
  fi
  return 0
}

# waiters_of <n>: reads a wait graph ({"<m>": [deps]}) on stdin, prints the issues that wait for #n,
# directly or through others, as a JSON array (without #n).
waiters_of() {
  jq -c --argjson n "$1" '. as $g
    | def grow: . as $s | ($s + [$g | to_entries[] | select(any(.value[]?; . as $d | any($s[]; . == $d))) | .key | tonumber]) | unique;
    [$n] | until(grow == .; grow) | map(select(. != $n))'
}

# gather_gh <dir>: open issues and open PRs (title+body only; bodies go through files, not argv).
gather_gh() {
  timeout "${GH_TIMEOUT:-40}" "$GH" issue list -R "$REPO" --state open -L 500 --json number,title,body,labels,milestone,assignees > "$1/issues.json" || return 1
  timeout "${GH_TIMEOUT:-40}" "$GH" pr list -R "$REPO" --state open -L 300 --json number,title,body,labels,headRefName,headRefOid,isCrossRepository,createdAt,mergeable,statusCheckRollup,url > "$1/prs.json" || return 1
  jq -e 'type == "array"' "$1/issues.json" >/dev/null && jq -e 'type == "array"' "$1/prs.json" >/dev/null
}

# pick_issue: "<n> <class>[ <adopt-pr>]" of the first issue in pick order, or nothing. Same program as sync's
# github.json, so what the console shows is what a lane does.
pick_issue() {
  local d rc=0
  d=$(mktemp -d "${TMPDIR:-/tmp}/factory-pick.XXXXXX")
  gather_gh "$d" && gather_local "$d" && classify_run "$d" > "$d/out.json" || rc=1
  if (( rc == 0 )); then
    jq -r '[.[] | select(.order != null)] | sort_by(.order) | first | if . == null then empty else "\(.n) \(.class)" + (if .adopt_pr != null then " \(.adopt_pr)" else "" end) end' "$d/out.json"
  fi
  rm -rf "$d"
  return 0
}

# adopt_lookup <issue>: the PR number adopted for that issue (empty: none). For manual runs.
adopt_lookup() {
  local d rc=0
  d=$(mktemp -d "${TMPDIR:-/tmp}/factory-pick.XXXXXX")
  gather_gh "$d" && gather_local "$d" && classify_run "$d" > "$d/out.json" || rc=1
  if (( rc == 0 )); then jq -r --argjson n "$1" '.[] | select(.n == $n) | .adopt_pr // empty' "$d/out.json"; fi
  rm -rf "$d"
  return 0
}

# ---------------------------------------------------------------- mirror
mg() {  # git in the root-owned bare mirror; the token reaches git through the helper's environment only
  timeout "${MG_TIMEOUT:-120}" git -C "$MIRROR" -c core.hooksPath=/dev/null -c credential.helper= \
    -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' "$@"
}

mirror_init() {
  if [[ ! -d $MIRROR ]]; then
    git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
      clone --quiet --bare "https://github.com/$REPO.git" "$MIRROR"
    git -C "$MIRROR" config remote.origin.fetch '+refs/heads/*:refs/heads/*'
  fi
  git -C "$MIRROR" config gc.auto 0
}
_mirror_fetch() { mg fetch --quiet --prune origin; }
mirror_fetch() { lk mirror _mirror_fetch; }

load_token() {
  GH_TOKEN=$(cat "${GH_TOKEN_FILE:-/etc/factory/gh-token}")
  export GH_TOKEN GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
}
