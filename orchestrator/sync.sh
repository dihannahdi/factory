#!/usr/bin/env bash
# factory sync: root, every 60 s, must finish in under 50 s (every step has its own timeout
# and optional steps are skipped when the budget is gone). The single writer of:
#
#   ui/github.json   issues classified exactly the way a lane would pick them, open PRs, runner
#                    queue, main + last deploy, site health            (every run)
#   ui/models.json   free models (Zen /zen/v1/models ∩ models.dev cost 0) with their data policy,
#                    paid OpenCode Go models (only while /etc/opencode/go.key is installed and
#                    safe), cooldowns and Go spend vs budget (cooldowns, paid and spend every
#                    run; the free list every 30 min)
#   /etc/opencode/opencode.json   whitelist rewritten to exactly the free set; the opencode-go
#                    provider (key by {file:} reference, never by value) only with a safe key
#   agent-blocked labels, lifted once every dependency is closed        (was run.sh's unblock)
#   split epics (agent-skip + a "Split into" comment), closed once every child is completed
#   ui/halt.json     removed once the console acknowledged it; raised when the box would pay
#                    (no free model left, or a Zen key found on the agent's side)
#
# Reads ctl/control.json the way lanes do: validated, never echoed.
set -euo pipefail
umask 027

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

OPENCODE_CONF=${OPENCODE_CONF:-/etc/opencode/opencode.json}
OPENCODE_TEMPLATE=${OPENCODE_TEMPLATE:-$BASE_DIR/opencode.json}
ZEN_URL=${ZEN_URL:-https://opencode.ai/zen/v1/models}
MODELSDEV_URL=${MODELSDEV_URL:-https://models.dev/api.json}
MODELS_EVERY=${MODELS_EVERY:-1800}
BUDGET=${BUDGET:-50}
export GH_TIMEOUT=${GH_TIMEOUT:-15} MG_TIMEOUT=${MG_TIMEOUT:-20}
# Data policy of the free models, from opencode.ai/docs/zen (read 2026-10-16). First match wins:
#   TRAINS_RE         the provider may train on / improve its product with prompts   -> trains true,  zero_retention false
#   RETAINED_RE       kept (30 days) but documented as not trained on               -> trains false, zero_retention false
#   ZERO_RETENTION_RE documented zero retention and no training                     -> trains false, zero_retention true
# Anything else that is free is unknown (null, null). For a private repo, unknown is not "safe".
TRAINS_RE=${TRAINS_RE:-^opencode/(muse-spark-.*-contributor-|big-pickle$|nemotron-|ll-alpha-|exo-|mimo-)}
RETAINED_RE=${RETAINED_RE:-^opencode/cat-jam-}
ZERO_RETENTION_RE=${ZERO_RETENTION_RE:-^opencode/(deepseek|space-bunny|longcat)-}
# OpenCode Go (paid, flat fee). The key is referenced from the config, never copied into it.
GO_KEY_FILE=${GO_KEY_FILE:-/etc/opencode/go.key}
GO_KEY_OWNER=${GO_KEY_OWNER:-root}
GO_KEY_GROUP=${GO_KEY_GROUP:-factory}
# Second Go account: virtual model id opencode-go@2/<model> = provider opencode-go, account 2. Its key is
# /etc/factory/opencode2.key (root:root 0600), handed to that turn's unit as a systemd credential by
# run.sh; the managed config keeps pointing at account 1's go.key for everything else.
GO2_KEY_FILE=${GO2_KEY_FILE:-/etc/factory/opencode2.key}
# No ":" in the expansion: GO_MODELS= (empty) offers no paid model at all, which is how an instance that
# must stay on the free models is configured (nothing in models.json paid, so no lane can pick one).
GO_MODELS=${GO_MODELS-opencode-go/deepseek-v4.1-flash opencode-go@2/deepseek-v4.1-flash}
# Go models whose ZDR / no-training terms are documented (OpenCode Go, ZDR valid through 2026-10-31).
GO_ZERO_RETENTION_RE=${GO_ZERO_RETENTION_RE:-^opencode-go(@[0-9]+)?/deepseek-v4[.]1-flash$}
SPEND_FN=${SPEND_FN:-spend_summary}
T0=$(date +%s)

budget_left() { (( BUDGET - ($(date +%s) - T0) >= ${1:-0} )); }  # budget_left <seconds-still-needed>

# ---------------------------------------------------------------- github.json
IFS= read -r -d '' PRS_JQ <<'EOF' || true
def ci_of: (.statusCheckRollup // []) as $r
  | if ($r | length) == 0 then "pending"
    elif any($r[]; ((.status // "COMPLETED") != "COMPLETED") or ((.state // "") == "PENDING")) then "pending"
    elif any($r[]; ((.conclusion // .state // "") | IN("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"))) then "fail"
    else "pass" end;
map({n: .number,
     issue: ((.headRefName | capture("^agent/issue-(?<i>[0-9]+)$")? | .i | tonumber)
             // ((.body // "") | capture("#(?<i>[0-9]+)")? | .i | tonumber) // null),
     title: .title, head: .headRefOid, agent: (.labels | any(.name == "agent")), adopt: (.labels | any(.name == "agent-adopt")), ci: ci_of,
     mergeable: .mergeable, created: (.createdAt | fromdateiso8601), url: .url})
EOF

step_mirror() {
  mirror_init
  mirror_fetch
}

# adopt_gc <prs.json>: forget the adoption state of PRs that are no longer open.
adopt_gc() {
  local f m
  for f in "$STATE"/adopt/*.json; do
    [[ -e $f ]] || continue
    m=${f##*/}; m=${m%.json}; [[ $m =~ ^[0-9]+$ ]] || continue
    if ! jq -e --argjson m "$m" 'any(.[]; .number == $m)' "$1" >/dev/null 2>&1; then rm -f "$f"; fi
  done
  return 0
}

# unblock <open-numbers-json>: lift agent-blocked from issues whose dependencies are all closed.
unblock() {
  local f m lifted=0
  for f in "$STATE"/blocked/*; do
    [[ -e $f ]] || continue
    m=${f##*/}; [[ $m =~ ^[0-9]+$ ]] || continue
    if jq -e --argjson open "$1" 'all(.[]; . as $d | any($open[]; . == $d) | not)' "$f" >/dev/null 2>&1; then
      budget_left 8 || break
      timeout "$GH_TIMEOUT" "$GH" issue edit "$m" -R "$REPO" --remove-label agent-blocked >/dev/null 2>&1 || true
      rm -f "$f"
      log "issue #$m unblocked: everything it waited for is closed"
      lifted=$(( lifted + 1 ))
      (( lifted < 5 )) || break
    fi
  done
  return 0
}

# epic_children: stdin = a comment body; prints the issue numbers named on its "Split into" line
# (the Indonesian "Dipecah menjadi" works too), up to "Parent closes" / "Induk ditutup", one per
# line. Nothing when the line is absent.
EPIC_MARK_RE='Split into|Dipecah menjadi'
epic_children() {
  grep -m1 -E "$EPIC_MARK_RE" | sed -E "s/.*($EPIC_MARK_RE)//; s/(Parent closes|Induk ditutup).*//" | grep -oE '#[0-9]+' | tr -d '#' | sort -un || true
}

# epic_close <open-issues.json> <done.json>: an epic that was split says so in a comment, "Split
# into #a (...), #b (...). Parent closes once every child is done." Once every child it names is
# closed as completed, the epic is closed as completed with a comment listing them, so what waits
# on it unblocks without a human (an issue once waited a day on an epic whose five children were
# all merged). Only open issues labelled agent-skip are looked at (epics carry it so no lane picks them),
# only comments by the repo's owner, members or collaborators count (comments are untrusted text), a
# child closed as not_planned keeps the epic open, and comments are read at most every EPIC_TTL s.
EPIC_TTL=${EPIC_TTL:-900}
epic_close() {
  local issues=$1 done=$2 stamp=$STATE/epic-check n text kids k closed=0 open_kids list
  if [[ -f $stamp ]] && (( $(now) - $(stat -c %Y "$stamp" 2>/dev/null || echo 0) < EPIC_TTL )); then return 0; fi
  touch "$stamp"
  for n in $(jq -r '.[] | select(any(.labels[]?; .name == "agent-skip")) | .number' "$issues" 2>/dev/null); do
    [[ $n =~ ^[0-9]+$ ]] || continue
    budget_left 12 || break
    text=$(timeout "$GH_TIMEOUT" "$GH" issue view "$n" -R "$REPO" --json comments \
      -q '[.comments[] | select(.authorAssociation == "OWNER" or .authorAssociation == "MEMBER" or .authorAssociation == "COLLABORATOR") | .body | select(test("Split into|Dipecah menjadi"))] | last // ""' 2>/dev/null) || continue
    kids=$(epic_children <<<"$text")
    [[ -n $kids ]] || continue
    open_kids=""
    for k in $kids; do
      [[ $k == "$n" ]] && { open_kids="self"; break; }
      jq -e --argjson k "$k" 'any(.[]; .n == $k and .reason == "completed")' "$done" >/dev/null 2>&1 || open_kids="$open_kids #$k"
    done
    if [[ -n $open_kids ]]; then continue; fi
    list=$(for k in $kids; do jq -r --argjson k "$k" '.[] | select(.n == $k) | "- #\(.n) \(.tag // "")"' "$done"; done)
    if timeout "$GH_TIMEOUT" "$GH" issue close "$n" -R "$REPO" --reason completed --comment "Every child named in the \"Split into\" comment is done, so factory sync closed this parent automatically:

$list" >/dev/null 2>&1; then
      log "epic #$n closed: every child ($(echo $kids)) is closed as completed"
      closed=$(( closed + 1 ))
      (( closed < 3 )) || break
    fi
  done
  return 0
}

github_failed() {  # keep the last good github.json, mark it stale
  local f=$UI/github.json
  if [[ -f $f ]] && jq -e 'type == "object"' "$f" >/dev/null 2>&1; then
    jq -c --arg e "$1" --argjson now "$(now)" '.ok = false | .error = $e' "$f" | ui_write github.json
  else
    jq -nc --arg e "$1" --argjson now "$(now)" \
      '{v: 1, updated: $now, ok: false, error: $e, issues: [], prs: [], adopt_ignored: [], runner: {queued: 0, in_progress: 0},
        main: {sha: null, deploy: null}, health: {ok: false, checked: $now}}' | ui_write github.json
  fi
  return 0
}

# done_issues: the closed issues for the console's dependency map (SCHEMA 3.2 `done`): number, title,
# tag, milestone, closed time, state reason and the dependencies its text declares. Bodies never reach
# github.json. Fetched at most every DONE_TTL seconds: the bodies of every closed issue are the
# heaviest call sync makes, and a closed issue rarely changes. A failed fetch keeps the last list.
DONE_TTL=${DONE_TTL:-600}
done_issues() {
  local f=$STATE/done-issues.json tmp mtime
  mtime=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  if (( $(now) - mtime >= DONE_TTL )) && budget_left 20; then
    tmp=$(mktemp "${TMPDIR:-/tmp}/factory-done.XXXXXX")
    if timeout "$GH_TIMEOUT" "$GH" issue list -R "$REPO" --state closed -L 1000 \
         --json number,title,body,milestone,closedAt,stateReason > "$tmp" 2>/dev/null \
       && jq -e 'type == "array"' "$tmp" >/dev/null 2>&1 \
       && jq -c "$TAGOF_DEF$DECLARED_DEF"'
           [ .[] | {n: .number, title, tag: tagof, milestone: (.milestone.title // null),
                    closed_at: (try (.closedAt | fromdateiso8601) catch null),
                    reason: ((.stateReason // "completed") | ascii_downcase), deps: declared_deps} ] | sort_by(.n)' \
            "$tmp" > "$f.tmp" 2>/dev/null; then
      mv -f "$f.tmp" "$f"
    else
      rm -f "$f.tmp"
      log "closed issues not refreshed; the map keeps the last list"
    fi
    rm -f "$tmp"
  fi
  if [[ -f $f && ! -L $f ]] && jq -e 'type == "array"' "$f" >/dev/null 2>&1; then cat "$f"; else echo '[]'; fi
}

step_github() {
  local d queued=0 inprog=0 main_sha="" deploy="null" health=false
  d=$(mktemp -d "${TMPDIR:-/tmp}/factory-sync.XXXXXX")
  if ! gather_gh "$d"; then github_failed "gh could not fetch issues/PRs"; rm -rf "$d"; return 0; fi
  gather_local "$d"
  if ! classify_run "$d" > "$d/classified.json"; then github_failed "classify failed"; rm -rf "$d"; return 0; fi
  jq -c "$PRS_JQ" "$d/prs.json" > "$d/prs-out.json"
  adopt_report "$d" | jq -c '.ignored' > "$d/adopt-ignored.json" || echo '[]' > "$d/adopt-ignored.json"
  adopt_gc "$d/prs.json"
  if budget_left 15; then
    queued=$(timeout 10 "$GH" api "repos/$REPO/actions/runs?status=queued&per_page=1" -q .total_count 2>/dev/null || echo 0)
    inprog=$(timeout 10 "$GH" api "repos/$REPO/actions/runs?status=in_progress&per_page=1" -q .total_count 2>/dev/null || echo 0)
    deploy=$(timeout 10 "$GH" run list -R "$REPO" --workflow deploy.yml -L 1 --json headSha,status,conclusion,url \
      -q '.[0] // null | if . == null then null else {sha: .headSha, status, conclusion, url} end' 2>/dev/null || echo null)
  fi
  [[ $queued =~ ^[0-9]+$ ]] || queued=0
  [[ $inprog =~ ^[0-9]+$ ]] || inprog=0
  [[ -n $deploy ]] || deploy=null
  done_issues > "$d/done.json"
  jq -c "$DECLARED_ALL_JQ" "$d/issues.json" > "$d/deps-all.json" 2>/dev/null || echo '{}' > "$d/deps-all.json"
  main_sha=$(mg rev-parse refs/heads/main 2>/dev/null || true)
  # No HEALTH_URL (no deploy watch): nothing to be unhealthy, so the console shows the site as fine.
  if [[ -z ${HEALTH_URL:-} ]]; then health=true
  elif budget_left 10 && curl -fsS -m 8 -o /dev/null "$HEALTH_URL" 2>/dev/null; then health=true; fi
  jq -nc --argjson now "$(now)" --slurpfile iss "$d/classified.json" --slurpfile prs "$d/prs-out.json" --slurpfile ign "$d/adopt-ignored.json" \
    --slurpfile done "$d/done.json" --slurpfile da "$d/deps-all.json" \
    --argjson q "$queued" --argjson ip "$inprog" --arg sha "$main_sha" --argjson deploy "$deploy" --argjson health "$health" '
    {v: 1, updated: $now, ok: true, error: null,
     issues: ($iss[0] | map({n, title, tag, family, milestone, priority, labels, class, reason, deps, taken_by, claimed_by, order, url, size}
                              + {deps_all: ((($da[0][(.n | tostring)]) // []) + .deps | unique)}
                              + (if .adopt_pr != null then {adopt_pr} else {} end))),
     done: ($done[0] // []),
     prs: $prs[0], adopt_ignored: ($ign[0] // []), runner: {queued: $q, in_progress: $ip},
     main: {sha: (if $sha == "" then null else $sha end), deploy: $deploy},
     health: {ok: $health, checked: $now}}' | ui_write github.json
  unblock "$(jq -c '[.[].number]' "$d/issues.json")"
  epic_close "$d/issues.json" "$d/done.json"
  rm -rf "$d"
  return 0
}

# ---------------------------------------------------------------- models.json and the whitelist
IFS= read -r -d '' FREE_JQ <<'EOF' || true
def policy($id):
  if   ($id | test($trains))   then {trains_on_data: true,  zero_retention: false}
  elif ($id | test($retained)) then {trains_on_data: false, zero_retention: false}
  elif ($id | test($zero))     then {trains_on_data: false, zero_retention: true}
  else                              {trains_on_data: null,  zero_retention: null} end;
($zen[0].data // []) | map(.id) as $ids
| ($md[0].opencode.models // {}) | to_entries
| map(select(.value.cost.input == 0 and .value.cost.output == 0 and (.key as $k | $ids | any(. == $k))))
| map(("opencode/" + .key) as $id
      | {id: $id, name: (.value.name // .key), context: (.value.limit.context // null),
         output: (.value.limit.output // null)} + policy($id))
| sort_by(.id)
EOF

# The configured Go models that models.dev lists under opencode-go, in GO_MODELS order. A model
# models.dev does not know is dropped (a typo in GO_MODELS must not reach the whitelist).
IFS= read -r -d '' PAID_JQ <<'EOF' || true
($md[0]["opencode-go"].models // {}) as $m
| ($want | map(select(test("^opencode-go(@[0-9]+)?/"))) | reduce .[] as $w ([]; if any(.[]; . == $w) then . else . + [$w] end))
| map(. as $id | ($id | sub("^opencode-go(@[0-9]+)?/"; "")) as $k | select($m[$k] != null)
     | {id: $id, name: ($m[$k].name // $k), context: ($m[$k].limit.context // null), output: ($m[$k].limit.output // null)}
       + (if ($id | test($zero)) then {trains_on_data: false, zero_retention: true} else {trains_on_data: null, zero_retention: null} end))
EOF

# go2_key_status: ok | absent | unsafe:<why> for the second account's key: a regular file owned by
# root:root with mode 0600 (only root and, through LoadCredential, the one turn unit can read it).
# Metadata only, never the content.
go2_key_status() {
  local f=$GO2_KEY_FILE o g m s
  if [[ -L $f ]]; then echo "unsafe:symlink"; return 0; fi
  [[ -e $f ]] || { echo absent; return 0; }
  [[ -f $f ]] || { echo "unsafe:not a regular file"; return 0; }
  read -r o g m s < <(stat -c '%U %G %a %s' "$f" 2>/dev/null) || { echo "unsafe:stat failed"; return 0; }
  [[ $o == root && $g == root ]] || { echo "unsafe:owner is not root:root"; return 0; }
  [[ $m == 600 ]] || { echo "unsafe:mode is not 0600"; return 0; }
  if [[ $s =~ ^[0-9]+$ ]] && (( s >= 20 && s <= 512 )); then echo ok; else echo "unsafe:size outside 20..512 bytes"; fi
}

# go_key_status: ok | absent | unsafe:<why>. Looks at the file's metadata only, never its content.
go_key_status() {
  local f=$GO_KEY_FILE o g m s
  if [[ -L $f ]]; then echo "unsafe:symlink"; return 0; fi
  [[ -e $f ]] || { echo absent; return 0; }
  [[ -f $f ]] || { echo "unsafe:not a regular file"; return 0; }
  read -r o g m s < <(stat -c '%U %G %a %s' "$f" 2>/dev/null) || { echo "unsafe:stat failed"; return 0; }
  [[ $o == "$GO_KEY_OWNER" ]] || { echo "unsafe:owner is not $GO_KEY_OWNER"; return 0; }
  [[ $g == "$GO_KEY_GROUP" ]] || { echo "unsafe:group is not $GO_KEY_GROUP"; return 0; }
  [[ $m == 640 ]] || { echo "unsafe:mode is not 0640"; return 0; }
  if [[ $s =~ ^[0-9]+$ ]] && (( s >= 20 && s <= 512 )); then echo ok; else echo "unsafe:size outside 20..512 bytes"; fi
}

# /etc/opencode/opencode.json is one file for every instance on the box (the sandbox user is shared),
# so exactly one sync may own it: two writers would undo each other every minute (one with the Go
# provider, one without). An instance that is not the owner sets WHITELIST_WRITE=0; the owner's list
# is the same free set, which already covers it.
WHITELIST_WRITE=${WHITELIST_WRITE:-1}
write_whitelist() {  # whitelist = exactly the free set; Go provider only while models.json has paid; every other key stays
  local names cur new tmp go go_names
  names=$(jq -c '[.free[].id | ltrimstr("opencode/")]' "$UI/models.json")
  go_names=$(jq -c '[(.paid // [])[].id | sub("^opencode-go(@[0-9]+)?/"; "")] | unique' "$UI/models.json")
  go=false; [[ $go_names != "[]" ]] && go=true
  if [[ -f $OPENCODE_CONF ]]; then cur=$(cat "$OPENCODE_CONF"); elif [[ -f $OPENCODE_TEMPLATE ]]; then cur=$(cat "$OPENCODE_TEMPLATE"); else return 0; fi
  new=$(jq --argjson w "$names" --argjson go "$go" --argjson gw "$go_names" --arg key "{file:$GO_KEY_FILE}" '
    .provider.opencode.whitelist = $w
    | if $go
      then .enabled_providers = ["opencode", "opencode-go"]
           | .provider["opencode-go"] = {options: {apiKey: $key}, whitelist: $gw}
      else .enabled_providers = ["opencode"] | del(.provider["opencode-go"]) end
    | if ($w | length) > 0 and ((.model // "" | ltrimstr("opencode/")) as $m | $w | any(. == $m) | not)
      then .model = "opencode/" + $w[0] | .small_model = .model else . end' <<<"$cur") || return 0
  if [[ -f $OPENCODE_CONF && $new == "$cur" ]]; then return 0; fi
  tmp=$(dirname "$OPENCODE_CONF")/.opencode.json.$$
  printf '%s\n' "$new" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$OPENCODE_CONF"
  log "whitelist rewritten: free=$names go=$go_names"
}

# spend_json: {"h5","week","month","budget":{...}} from the shell function lib.sh provides, or null.
spend_json() {
  local raw b acc
  declare -F "$SPEND_FN" >/dev/null || { echo null; return 0; }
  raw=$("$SPEND_FN" 2>/dev/null) || { echo null; return 0; }
  b=$(jq -nc --arg a "$GO_BUDGET_5H" --arg w "$GO_BUDGET_WEEK" --arg m "$GO_BUDGET_MONTH" \
    '{h5: ($a | tonumber? // 14), week: ($w | tonumber? // 36), month: ($m | tonumber? // 76)}')  # lib.sh defaults
  acc='{}'; if declare -F spend_accounts >/dev/null; then acc=$(spend_accounts 2>/dev/null) || acc='{}'; fi
  jq -c --argjson b "$b" --argjson acc "$acc" 'if type == "object" and (.h5 | type) == "number" and (.week | type) == "number" and (.month | type) == "number"
                          then {h5, week, month, budget: $b, accounts: $acc} else null end' <<<"$raw" 2>/dev/null || echo null
}

step_models() {
  local stamp=$STATE/.models-stamp gocache=$STATE/go-models.json zen md d free src_zen=false src_md=false prev='{"v":1,"updated":0,"free":[],"cooldown":{},"source_ok":{"zen":false,"modelsdev":false}}' ids cd
  local want gstat gprev gstat2 gprev2 okaccts paid spend new
  [[ -f $UI/models.json ]] && prev=$(cat "$UI/models.json")
  jq -e 'type == "object" and (.free | type == "array")' <<<"$prev" >/dev/null 2>&1 || prev='{"v":1,"updated":0,"free":[],"cooldown":{},"source_ok":{"zen":false,"modelsdev":false}}'
  if [[ ! -f $UI/models.json || ! -f $stamp || ! -f $gocache ]] || (( $(now) - $(stat -c %Y "$stamp" 2>/dev/null || echo 0) >= MODELS_EVERY )); then
    if budget_left 20; then
      d=$(mktemp -d "${TMPDIR:-/tmp}/factory-models.XXXXXX")
      if curl -fsS -m 15 "$ZEN_URL" -o "$d/zen.json" 2>/dev/null && jq -e '.data | type == "array"' "$d/zen.json" >/dev/null 2>&1; then src_zen=true; fi
      if curl -fsS -m 20 "$MODELSDEV_URL" -o "$d/md.json" 2>/dev/null && jq -e 'type == "object"' "$d/md.json" >/dev/null 2>&1; then src_md=true; fi
      if [[ $src_zen == true && $src_md == true ]]; then
        free=$(jq -c --arg trains "$TRAINS_RE" --arg retained "$RETAINED_RE" --arg zero "$ZERO_RETENTION_RE" \
          --slurpfile zen "$d/zen.json" --slurpfile md "$d/md.json" -n "$FREE_JQ")
        touch "$stamp"
      else
        free=$(jq -c .free <<<"$prev")   # a source is down: keep what we knew, do not conclude anything
      fi
      if [[ $src_md == true ]]; then   # Go candidates, kept whether or not the key is installed yet
        want=$(jq -nc --arg s "$GO_MODELS" '$s | [splits("[ ,]+")] | map(select(length > 0))')
        jq -c --argjson want "$want" --arg zero "$GO_ZERO_RETENTION_RE" --slurpfile md "$d/md.json" -n "$PAID_JQ" > "$gocache.tmp" \
          && mv -f "$gocache.tmp" "$gocache"
      fi
      rm -rf "$d"
      jq -c --argjson free "$free" --argjson now "$(now)" --argjson z "$src_zen" --argjson m "$src_md" \
        '.v = 1 | .updated = $now | .free = $free | .source_ok = {zen: $z, modelsdev: $m}' <<<"$prev" | ui_write models.json
      prev=$(cat "$UI/models.json")
      if [[ $src_zen == true && $src_md == true && $free == "[]" ]]; then
        halt_raise free-model-gone "OpenCode Zen no longer offers a single free model"
      fi
    fi
  fi
  # Every run: Go key state -> paid, spend, cooldowns; the rest of the file does not change.
  gstat=$(go_key_status)
  gprev=$(cat "$STATE/.gokey-status" 2>/dev/null || true)
  if [[ $gstat != "$gprev" ]]; then
    printf '%s' "$gstat" > "$STATE/.gokey-status"
    log "go key: $gstat"
  fi
  gstat2=$(go2_key_status)
  gprev2=$(cat "$STATE/.go2key-status" 2>/dev/null || true)
  if [[ $gstat2 != "$gprev2" ]]; then
    printf '%s' "$gstat2" > "$STATE/.go2key-status"
    log "go account 2 key: $gstat2"
  fi
  paid='[]'
  if [[ -s $gocache ]] && jq -e 'type == "array"' "$gocache" >/dev/null 2>&1; then
    # an account's models are offered only while that account's key file is in place and safe
    okaccts=$(jq -nc --arg g1 "$gstat" --arg g2 "$gstat2" '[(if $g1 == "ok" then "1" else empty end), (if $g2 == "ok" then "2" else empty end)]')
    paid=$(jq -c --argjson ok "$okaccts" '[.[] | select(((.id | capture("^opencode-go(@(?<n>[0-9]+))?/") | .n) // "1") as $n | $ok | index($n))]' "$gocache")
  fi
  spend=$(spend_json)
  mapfile -t ids < <(jq -r '.free[].id' <<<"$prev"; jq -r '.[].id' <<<"$paid")
  cd=$(cooldown_json "${ids[@]}")
  new=$(jq -c --argjson cd "$cd" --argjson paid "$paid" --argjson spend "$spend" '
    .cooldown = $cd
    | if ($paid | length) > 0 then .paid = $paid else del(.paid) end
    | if $spend != null then .spend = $spend else del(.spend) end' <<<"$prev")
  if [[ $new != "$(jq -c . <<<"$prev")" ]]; then
    printf '%s\n' "$new" | ui_write models.json
    prev=$new
  fi
  # Idempotent: rewrites the managed config only when it differs (also when the key appears or goes).
  if [[ $WHITELIST_WRITE == 1 && $(jq '.free | length' <<<"$prev") -gt 0 ]]; then write_whitelist; fi
  return 0
}

# ---------------------------------------------------------------- the rest
step_halt_ack() {
  local f=$UI/halt.json id ack
  [[ -f $f && ! -L $f ]] || return 0
  id=$(jq -r '.id // empty' "$f" 2>/dev/null || true)
  ack=$(jq -r '.resume_ack // empty' <<<"$CONTROL")
  if [[ -n $id && $ack == "$id" ]]; then
    lk halt rm -f "$f" || true
    log "halt $id acknowledged from the console"
  fi
  return 0
}

# auth_has_zen_key <auth.json content>: an opencode credential means paid models would answer.
auth_has_zen_key() { jq -e 'type == "object" and has("opencode")' <<<"$1" >/dev/null 2>&1; }

# Looks inside the agent's home through the sandbox (root never reads it directly). Every 5 min.
step_zen_key() {
  local stamp=$STATE/.authcheck out auth k=${SLOTS%% *}   # the first slot of THIS instance: sandbox.sh refuses any other
  if [[ -f $stamp ]] && (( $(now) - $(stat -c %Y "$stamp" 2>/dev/null || echo 0) < 300 )); then return 0; fi
  budget_left 20 || return 0
  [[ -d $H/s$k && -x $SANDBOX ]] || return 0
  touch "$stamp"
  auth=$(SB_SLOT=$k "$SANDBOX" "$H/s$k" 15 cat "$H/.local/share/opencode/auth.json" </dev/null 2>/dev/null || true)
  if [[ -n $auth ]] && auth_has_zen_key "$auth"; then
    halt_raise zen-key "an opencode credential (Zen key) is in the factory user's auth.json"
  fi
  out=$(SB_SLOT=$k "$SANDBOX" "$H/s$k" 15 sh -c '
    for f in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.zshenv" "$HOME/.config/environment.d"/*; do
      if [ -f "$f" ] && grep -q OPENCODE_API_KEY "$f"; then echo "$f"; fi
    done
    env | grep -q "^OPENCODE_API_KEY=" && echo env' </dev/null 2>/dev/null || true)
  if [[ -n $out ]]; then halt_raise zen-key "OPENCODE_API_KEY found in the factory user's environment"; fi
  return 0
}

_gc_mirror() { timeout 40 git -C "$MIRROR" gc --quiet; }
step_gc() {  # nightly, under the mirror lock (gc.auto is 0 on purpose: no gc under a lane's feet)
  local stamp=$STATE/.gc-stamp
  [[ -d $MIRROR ]] || return 0
  [[ $(date +%H) == 03 ]] || return 0
  if [[ -f $stamp ]] && (( $(now) - $(stat -c %Y "$stamp" 2>/dev/null || echo 0) < 72000 )); then return 0; fi
  budget_left 42 || return 0
  touch "$stamp"
  LOCK_WAIT=5 lk mirror _gc_mirror || true
  return 0
}

main() {
  mkdir -p "$STATE" "$STATE/blocked" "$STATE/claims" "$STATE/cooldown" "$LOCKS"
  chmod 700 "$STATE" "$STATE/blocked" "$STATE/claims" "$STATE/cooldown" "$LOCKS" 2>/dev/null || true
  exec 7>"$LOCKS/sync"
  flock -n 7 || { echo "previous sync still running"; exit 0; }
  load_token
  control_load
  claim_gc
  step_mirror || log "mirror fetch failed"
  step_github || log "github step failed"
  step_models || log "models step failed"
  step_halt_ack
  step_zen_key || true
  step_gc || true
  return 0
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
