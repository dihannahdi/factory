#!/usr/bin/env bash
# epic_close (sync): an agent-skip epic whose "Split into" comment names children closes itself
# once every child is closed as completed, and only then. gh is a stub that serves raw comment JSON
# and applies the real -q filter with jq, so the author filter in sync.sh is exercised.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
setup_env
source "$ORCH/sync.sh"
set +e
set +u
REPO=o/r GH_TIMEOUT=10
budget_left() { return 0; }
log() { :; }

mkdir -p "$T/c"
cat > "$T/gh-epic" <<'G'
#!/usr/bin/env bash
q=. n= cmd="$1 $2"
[[ $cmd == "issue view" || $cmd == "issue close" ]] && n=$3
shift 2
while (( $# )); do case $1 in -q) q=$2; shift ;; esac; shift; done
case $cmd in
  "issue view") jq -r "$q" "$FAKE_C/$n.json" ;;
  "issue close") echo "$n" >> "$FAKE_C/closed" ;;
esac
exit 0
G
chmod +x "$T/gh-epic"
export GH=$T/gh-epic FAKE_C=$T/c

split='Split into #272 (LAY-09a, module status), #273 (LAY-09b, orphan overrides), #274 (LAY-09c, align). Parent closes once every child is done, including #999 named after that.'
split_id='Dipecah menjadi #272 (LAY-09a), #273 (LAY-09b), #274 (LAY-09c). Induk ditutup setelah semua anak selesai, termasuk #999.'
jq -n --arg b "$split" '{comments: [{authorAssociation: "OWNER", body: "another note #5"}, {authorAssociation: "OWNER", body: $b}]}' > "$T/c/34.json"
jq -n --arg b "$split" '{comments: [{authorAssociation: "NONE", body: $b}]}' > "$T/c/40.json"
jq -n '{comments: [{authorAssociation: "OWNER", body: "not split"}]}' > "$T/c/39.json"
echo '[{"number":34,"labels":[{"name":"agent-skip"}]},{"number":40,"labels":[{"name":"agent-skip"}]},
       {"number":39,"labels":[{"name":"agent-skip"}]},{"number":50,"labels":[{"name":"P1"}]}]' > "$T/issues.json"
done_with() { jq -n --argjson r "$1" '[{n:272,tag:"LAY-09a",reason:"completed"},{n:273,tag:"LAY-09b",reason:"completed"},{n:274,tag:"LAY-09c",reason:$r}]' > "$T/done.json"; }
run_epic() { rm -f "$STATE/epic-check" "$T/c/closed"; epic_close "$T/issues.json" "$T/done.json"; cat "$T/c/closed" 2>/dev/null | tr '\n' ' '; }

echo "epic_children reads the Split into line up to 'Parent closes'"
assert_eq "children of the split comment" "272 273 274" "$(epic_children <<<"$split" | tr '\n' ' ' | sed 's/ $//')"
assert_eq "the Indonesian marker works the same" "272 273 274" "$(epic_children <<<"$split_id" | tr '\n' ' ' | sed 's/ $//')"
assert_eq "no Split into line: nothing" "" "$(epic_children <<<"not split #5")"

echo "every child closed as completed: the epic closes, nothing else does"
done_with '"completed"'
assert_eq "only #34 closed (#40's comment is by a non-member, #39 has no split, #50 is no epic)" "34 " "$(run_epic)"

echo "one child still open: the epic stays open"
jq 'map(select(.n != 274))' "$T/done.json" > "$T/d2" && mv "$T/d2" "$T/done.json"
assert_eq "#274 open: nothing closed" "" "$(run_epic)"

echo "a child closed as not_planned keeps the epic open"
done_with '"not_planned"'
assert_eq "#274 not_planned: nothing closed" "" "$(run_epic)"

echo "EPIC_TTL: comments are read at most every EPIC_TTL seconds"
done_with '"completed"'
rm -f "$T/c/closed"; touch "$STATE/epic-check"
epic_close "$T/issues.json" "$T/done.json"
assert_eq "fresh stamp: no GitHub call, nothing closed" "" "$(cat "$T/c/closed" 2>/dev/null)"

finish
