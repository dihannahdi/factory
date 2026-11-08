#!/usr/bin/env bash
# deploy/instance-install.sh in a temp tree (its paths and ownership are overridable): what it
# creates, that it is idempotent, that it starts and enables nothing, touches no file of the first
# instance, keeps an edited env file, and refuses an env file that would share state or slots with it.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
INSTALL=$ORCH/../deploy/instance-install.sh
export FAKE_SYSTEMCTL_LOG=$T/systemctl.log

# Nothing outside the temp tree may be written: note what exists on this machine now, check after.
real_before=$(ls -d /etc/blog-agent /var/lib/blog-agent /var/lib/blog-ops /var/log/blog-agent 2>/dev/null | paste -sd' ' -)

mk_tree() {  # mk_tree <name>: a fresh fake box under $T/<name> with the deployed orchestrator and the first instance's units
  local r=$T/$1
  mkdir -p "$r/opt" "$r/units" "$r/etc" "$r/home/factory"
  cp "$ORCH/lib.sh" "$ORCH/run.sh" "$ORCH/sync.sh" "$ORCH/sandbox.sh" "$r/opt/"
  for u in factory@.service factory@.timer factory.slice factory-s1.slice factory-s2.slice factory-s3.slice factory-sync.service factory-sync.timer; do
    cp "$ORCH/systemd/$u" "$r/units/$u"
  done
  mkdir -p "$r/opt/prompts" "$r/home/factory/s1"; cp "$ORCH/prompts/"*.md "$r/opt/prompts/"
  : > "$FAKE_SYSTEMCTL_LOG"
}
first_sum() { ( cd "$1" && find opt/prompts units home/factory/s1 -type f ! -name 'blog*' ! -name 'factory-s[45].slice' -exec cksum {} + | sort ) ; }
run_install() {  # run_install <tree> [env-var=value ...]: runs the installer against that tree; output in $T/out
  local r=$T/$1; shift
  env BASE="$r/opt" UNITS="$r/units" ETC_ROOT="$r/etc" AGENT_HOME="$r/home/factory" OWN_ROOT= OWN_OPS= OWN_AGENT= "$@" \
    bash "$INSTALL" > "$T/out" 2>&1
}
# The repo's env file, with its /var paths moved into the tree (the installer reads them from it).
put_env() {  # put_env <tree> [sed-expr]
  local r=$T/$1
  mkdir -p "$r/etc/blog-agent"
  sed -e "s|=/var/|=$r/var/|" -e "s|/etc/blog-agent|$r/etc/blog-agent|" ${2:+-e "$2"} "$ORCH/instances/blog.env" > "$r/etc/blog-agent/instance.env"
}

echo "a fresh install"
mk_tree a; before=$(first_sum "$T/a")
put_env a
run_install a; rc=$?
assert_eq "exit 0" 0 "$rc"
R=$T/a
for u in blog-agent@.service blog-agent@.timer blog-agent-sync.service blog-agent-sync.timer factory-s4.slice factory-s5.slice; do
  assert_true "unit $u installed, identical to the repo's" cmp -s "$ORCH/systemd/$u" "$R/units/$u"
done
assert_eq "no per-instance prompts dir: the shared prompts/ serve both" no "$(test -e "$R/opt/prompts-blog" && echo yes || echo no)"
assert_eq "the shared prompts dir is untouched" "$(ls "$ORCH/prompts" | paste -sd' ' -)" "$(ls "$R/opt/prompts" | paste -sd' ' -)"
mode() { stat -c %a "$1"; }
assert_eq "state 700" 700 "$(mode "$R/var/lib/blog-agent")"
for d in sessions blocked claims cooldown adopt locks; do assert_eq "state/$d 700" 700 "$(mode "$R/var/lib/blog-agent/$d")"; done
assert_eq "ops 750" 750 "$(mode "$R/var/lib/blog-ops")"
assert_eq "ui 2750" 2750 "$(mode "$R/var/lib/blog-ops/ui")"
assert_eq "ui/slots 2750" 2750 "$(mode "$R/var/lib/blog-ops/ui/slots")"
assert_eq "log 2750" 2750 "$(mode "$R/var/log/blog-agent")"
assert_eq "ctl 2770" 2770 "$(mode "$R/var/lib/blog-ops/ctl")"
assert_eq "/etc dir 750" 750 "$(mode "$R/etc/blog-agent")"
assert_eq "agent slot dirs s4, s5 750" "750 750" "$(mode "$R/home/factory/s4") $(mode "$R/home/factory/s5")"
assert_eq "no s6" no "$(test -e "$R/home/factory/s6" && echo yes || echo no)"
assert_eq "control.json written, mode 660" 660 "$(mode "$R/var/lib/blog-ops/ctl/control.json")"
assert_eq "...from the repo's example" "$(jq -S -c . "$ORCH/instances/blog.control.json")" "$(jq -S -c . "$R/var/lib/blog-ops/ctl/control.json")"
assert_eq "the lanes will read it as 0 agents (nothing starts until raised), the free model" "0 opencode/deepseek-v4.1-flash-free" "$(bash -c 'source "$1"; control_validate "$2" | jq -r "\"\(.agents) \(.models[0])\""' _ "$ORCH/lib.sh" "$R/var/lib/blog-ops/ctl/control.json")"
assert_eq "the only systemctl call is daemon-reload: nothing enabled, nothing started" "daemon-reload" "$(cat "$FAKE_SYSTEMCTL_LOG")"
assert_eq "no file of the first instance changed" "$before" "$(first_sum "$T/a")"
assert_true "it says what is still to do by hand" grep -q 'nothing was enabled or started' "$T/out"

echo "run again: idempotent"
cp -a "$R" "$T/a.snap"
run_install a; rc=$?
assert_eq "exit 0" 0 "$rc"
assert_true "says nothing was needed" grep -q 'nothing: everything was already in place' "$T/out"
assert_eq "same tree" "" "$(diff -r "$T/a.snap" "$R" 2>&1)"
assert_eq "again only daemon-reload" "daemon-reload daemon-reload" "$(paste -sd' ' "$FAKE_SYSTEMCTL_LOG")"

echo "an edited env file and an edited control.json are kept"
echo "# operator" >> "$R/etc/blog-agent/instance.env"
jq '.agents = 1' "$R/var/lib/blog-ops/ctl/control.json" > "$T/c.json" && cp "$T/c.json" "$R/var/lib/blog-ops/ctl/control.json"
run_install a; rc=$?
assert_eq "exit 0" 0 "$rc"
assert_true "env file kept, and said so" grep -q 'kept .*instance.env' "$T/out"
assert_eq "...with the edit" 1 "$(grep -c '^# operator' "$R/etc/blog-agent/instance.env")"
assert_eq "control.json kept: agents still 1" 1 "$(jq .agents "$R/var/lib/blog-ops/ctl/control.json")"
assert_true "unit changed in the repo: reinstalled" bash -c "echo '# x' >> '$R/units/blog-agent@.timer'; env BASE='$R/opt' UNITS='$R/units' ETC_ROOT='$R/etc' AGENT_HOME='$R/home/factory' OWN_ROOT= OWN_OPS= OWN_AGENT= bash '$INSTALL' | grep -q 'installed  .*blog-agent@.timer'"
assert_true "...and equal to the repo's again" cmp -s "$ORCH/systemd/blog-agent@.timer" "$R/units/blog-agent@.timer"

echo "refusals: nothing is created"
refuse() {  # refuse <name> <sed-expr-on-env | @drop:<regex> | @oldcode> <message-regex>
  mk_tree "$1"; local r=$T/$1
  case $2 in
    @oldcode) put_env "$1"; sed -i '/^SLOTS=/d' "$r/opt/lib.sh" ;;
    @drop:*) put_env "$1"; sed -i "/${2#@drop:}/d" "$r/etc/blog-agent/instance.env" ;;
    *) put_env "$1" "$2" ;;
  esac
  run_install "$1"; local rc=$?
  assert_eq "$1: exit 1" 1 "$rc"
  assert_true "$1: says why" grep -Eq "$3" "$T/out"
  assert_eq "$1: no state directory" no "$(ls -d "$r/var" 2>/dev/null >/dev/null && echo yes || echo no)"
  assert_eq "$1: no unit installed" 0 "$(ls "$r/units" | grep -c blog)"
  assert_eq "$1: no systemctl call" 0 "$(wc -l < "$FAKE_SYSTEMCTL_LOG")"
}
refuse r1 's|^STATE=.*|STATE=/var/lib/factory|' "the first instance's own directories"
refuse r2 's|^UI=.*|UI=/var/lib/factory-ops/ui|' "the first instance's own directories"
refuse r3 's|^SLOTS=.*|SLOTS="3 4"|' "slot 3 belongs to the first instance"
refuse r4 's|^SLOTS=.*|SLOTS="4 9"|' "slot 9 belongs to"
refuse r5 's|^AGENT_UNIT=.*|AGENT_UNIT=factory|' "AGENT_UNIT must be set and not factory"
refuse r6 '@drop:^GO_MODELS=' "must have the lines GO_MODELS="
refuse r7 's|^WHITELIST_WRITE=.*|WHITELIST_WRITE=1|' "WHITELIST_WRITE=0"
refuse r8 's|^STATE=.*|STATE=relative/dir|' "absolute path"
refuse r9 '@oldcode' "has no SLOTS"

echo "nothing outside the temp tree was written"
real_after=$(ls -d /etc/blog-agent /var/lib/blog-agent /var/lib/blog-ops /var/log/blog-agent 2>/dev/null | paste -sd' ' -)
assert_eq "the real /etc, /var, /opt paths are as they were" "$real_before" "$real_after"

echo "the units mirror the first instance's, plus the EnvironmentFile"
strip() {  # strip <file>: without comments and blank lines, names normalised, and the lines that are meant to differ
  grep -vE '^(#|$)' "$1" | grep -vE '^(EnvironmentFile=|OnBootSec=|Description=)' | sed -E 's/blog-agent/factory/g; s/blog/factory/g'
}
assert_eq "agent@.service = the first instance's, apart from the EnvironmentFile" "$(strip "$ORCH/systemd/factory@.service")" "$(strip "$ORCH/systemd/blog-agent@.service")"
assert_eq "agent@.timer = the first instance's" "$(strip "$ORCH/systemd/factory@.timer")" "$(strip "$ORCH/systemd/blog-agent@.timer")"
assert_eq "sync.service = the first instance's, apart from the EnvironmentFile" "$(strip "$ORCH/systemd/factory-sync.service")" "$(strip "$ORCH/systemd/blog-agent-sync.service")"
assert_eq "sync.timer = the first instance's, apart from the start offset" "$(strip "$ORCH/systemd/factory-sync.timer")" "$(strip "$ORCH/systemd/blog-agent-sync.timer")"
for k in 4 5; do assert_eq "slice s$k = the first instance's s1" "$(strip "$ORCH/systemd/factory-s1.slice")" "$(strip "$ORCH/systemd/factory-s$k.slice")"; done
for u in blog-agent@.service blog-agent-sync.service; do
  assert_eq "$u: EnvironmentFile=/etc/blog-agent/instance.env, required (no '-')" 1 "$(grep -c '^EnvironmentFile=/etc/blog-agent/instance.env$' "$ORCH/systemd/$u")"
done
assert_true "lane service starts the shared run.sh for its slot" grep -q '^ExecStart=/opt/factory/run.sh --slot %i$' "$ORCH/systemd/blog-agent@.service"
assert_true "...and cleans up with the same environment" grep -q '^ExecStopPost=/opt/factory/run.sh --cleanup %i$' "$ORCH/systemd/blog-agent@.service"
assert_false "no unit name of the first instance is reused for a blog one" bash -c "ls '$ORCH/systemd' | grep -E '^factory(@|-sync)' | grep -E 'blog'"

echo "the env file means what the task says, as the code reads it"
E=$ORCH/instances/blog.env
ev() { env -i PATH="$PATH" bash -c 'set -a; source "$1"; printf "%s" "${!2-@@unset@@}"' _ "$E" "$1"; }
assert_eq "REPO" acme/blog "$(ev REPO)"
assert_eq "STATE" /var/lib/blog-agent "$(ev STATE)"
assert_eq "UI" /var/lib/blog-ops/ui "$(ev UI)"
assert_eq "CTL" /var/lib/blog-ops/ctl "$(ev CTL)"
assert_eq "LOGDIR" /var/log/blog-agent "$(ev LOGDIR)"
assert_eq "MIRROR" /opt/factory/mirror-blog.git "$(ev MIRROR)"
assert_eq "HEALTH_URL" https://blog.example.com/api/health "$(ev HEALTH_URL)"
assert_eq "SLOTS" "4 5" "$(ev SLOTS)"
assert_eq "VERIFY_KIND" node "$(ev VERIFY_KIND)"
assert_eq "MIGRATIONS_DIR" db/migrations "$(ev MIGRATIONS_DIR)"
assert_eq "PG_TEST_ENV is set, and empty" "" "$(ev PG_TEST_ENV)"
assert_eq "PROMPTS not set: the shared prompts" @@unset@@ "$(ev PROMPTS)"
assert_eq "AGENT_UNIT" blog-agent "$(ev AGENT_UNIT)"
for v in GO_MODELS GO_ACCOUNTS AGENT_CRED; do assert_eq "$v is set, and empty" "" "$(ev $v)"; done
assert_eq "WHITELIST_WRITE" 0 "$(ev WHITELIST_WRITE)"
assert_eq "Go budgets are zero" "0 0 0" "$(ev GO_BUDGET_5H) $(ev GO_BUDGET_WEEK) $(ev GO_BUDGET_MONTH)"
assert_eq "no state path is the first instance's" "" "$(for v in STATE UI CTL LOGDIR MIRROR; do case $(ev $v) in /var/lib/factory*|/var/lib/factory-ops*|/var/log/factory*|/opt/factory/mirror.git) echo $v;; esac; done)"
assert_false "no slot is the first instance's or the gates'" bash -c "for s in $(ev SLOTS); do case \$s in 1|2|3|9) exit 0;; esac; done; exit 1"
assert_eq "the Go key paths point at nothing under /etc/blog-agent" "yes" "$(case "$(ev GO_KEY_FILE) $(ev GO2_KEY_FILE)" in "/etc/blog-agent/"*" /etc/blog-agent/"*) echo yes ;; esac)"
for k in $(grep -oE '^[A-Z0-9_]+' "$E" | sort -u); do
  assert_true "$k is a setting some script reads" grep -qE "(^|[^A-Z0-9_])$k([^A-Z0-9_]|\$)" "$ORCH/lib.sh" "$ORCH/run.sh" "$ORCH/sync.sh" "$ORCH/sandbox.sh"
done
# Loaded the way systemd would (exported), the real code agrees.
got=$(env -i PATH="$PATH" bash -c 'set -a; source "$1"; set +a; source "$2" >/dev/null 2>&1; set +eu; printf "%s|%s|%s|%s|%s" "$(health_host)" "$(slot_index 4)$(slot_index 5)" "$MIGRATIONS_DIR" "$VERIFY_KIND" "$PG_TEST_ENV"' _ "$E" "$ORCH/run.sh")
assert_eq "lib and run.sh, loaded with it: host, lanes, migrations, kind, no database" "blog.example.com|12|db/migrations|node|" "$got"

echo "the repo's env file itself"
assert_true "parses as KEY=VALUE lines and comments only" bash -c "! grep -vE '^(#.*|[A-Z0-9_]+=.*|)\$' '$ORCH/instances/blog.env'"
assert_false "no inline comments (systemd would keep them in the value)" bash -c "grep -E '^[A-Z0-9_]+=.*[[:space:]]#' '$ORCH/instances/blog.env'"

finish
