#!/usr/bin/env bash
# Prune a cargo target dir of stale test executables.
# usage: prune-target.sh <target-dir> [ceiling-gb] ["name=N name=N ..."]
#
# Why: every dependency set / branch layout builds its own hash-suffixed copy of every test binary
# (<name>-<16 hex>), ~40-180 MB each, and nothing removes the old ones. One CI runner's target grew
# 15 -> 47 GB (359 executables, 45 GB) and the disk hit 99%. Rules:
#   - per executable NAME keep the newest variant. The third argument raises that per name, e.g.
#     "myapp=2 it=6": a crate whose lib and main target share one name needs 2, and an integration
#     binary every crate names alike (`it-<hash>`) needs one per crate. Older variants go, with their
#     .d files.
#   - ceiling: if the target is STILL above <ceiling-gb> (default 25), also delete .rlib/.rmeta in
#     debug/deps that neither mtime nor atime touched for 3 days. Third-party rlibs have old mtimes
#     and are still in use, so this runs only when the ceiling is exceeded; the cost is a rebuild of
#     what was deleted. The impact is printed.
#
# MUST exit 0 always and be quick (callers also wrap it in `timeout`): as a CI runner's job-completed
# hook (ACTIONS_RUNNER_HOOK_JOB_COMPLETED), a failing hook fails the job.
# PRUNE_DRY=1 lists what would go and deletes nothing.
{
  set +e
  target=${1:-}
  ceil_gb=${2:-25}
  dry=${PRUNE_DRY:-0}
  declare -A keepn=()
  for kv in ${3:-}; do [[ $kv =~ ^([A-Za-z0-9_]+)=([0-9]+)$ ]] && keepn[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}; done
  say() { echo "factory-prune: $*"; }
  run() {
    local deps=$target/debug/deps
    [[ -n $target && -d $deps ]] || { say "no $deps, nothing to do"; return 0; }
    local before_kb after_kb
    before_kb=$(du -sk "$target" 2>/dev/null | cut -f1)
    local -A seen=()
    local n=0 freed=0 count=0 ts path name keep sz
    # newest first; executables only (no extension, so not .d/.rlib/.rmeta/.so)
    while IFS=' ' read -r ts path; do
      name=${path##*/}
      [[ $name =~ ^(.+)-[0-9a-f]{16}$ ]] || continue
      name=${BASH_REMATCH[1]}
      keep=${keepn[$name]:-1}
      seen[$name]=$(( ${seen[$name]:-0} + 1 ))
      (( ${seen[$name]} > keep )) || continue
      sz=$(stat -c %s "$path" 2>/dev/null || echo 0)
      freed=$(( freed + sz )); count=$(( count + 1 ))
      if [[ $dry == 1 ]]; then echo "would delete $sz ${path##*/}"; else rm -f -- "$path" "$path.d"; fi
    done < <(find "$deps" -maxdepth 1 -type f -perm -u+x ! -name '*.*' -printf '%T@ %p\n' 2>/dev/null | sort -rn)
    say "stage 1: $count stale test executables, $(( freed / 1048576 )) MB ($( [[ $dry == 1 ]] && echo dry-run || echo deleted ))"
    [[ $dry == 1 ]] && return 0
    after_kb=$(du -sk "$target" 2>/dev/null | cut -f1)
    if (( ${after_kb:-0} > ceil_gb * 1048576 )); then
      local rl_kb
      rl_kb=$(find "$deps" -maxdepth 1 -type f \( -name '*.rlib' -o -name '*.rmeta' \) -mtime +3 -atime +3 -printf '%k\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')
      find "$deps" -maxdepth 1 -type f \( -name '*.rlib' -o -name '*.rmeta' \) -mtime +3 -atime +3 -delete 2>/dev/null
      say "stage 2: target still $(( after_kb / 1048576 )) GB > ${ceil_gb} GB; deleted rlib/rmeta untouched >3d: $(( rl_kb / 1024 )) MB (expect a partial dependency rebuild next job)"
      after_kb=$(du -sk "$target" 2>/dev/null | cut -f1)
    fi
    say "target $(( ${before_kb:-0} / 1024 )) MB -> $(( ${after_kb:-0} / 1024 )) MB ($target)"
  }
  run
} 2>&1
exit 0
