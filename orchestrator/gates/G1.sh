#!/usr/bin/env bash
# G1: a sandbox unit survives the death of its systemd-run client, is created in the lane's
# slice (Slice= and ControlGroup= asserted, not assumed), stopping the slice removes it, SIGINT
# to the main process reaches it, and lane isolation hides the other lanes' directories.
# Root, on the box. Uses scratch lane 9; cleans up.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

S=$H/s9
install -d -o factory -g factory "$S"
cleanup() {
  systemctl stop factory-s9.slice >/dev/null 2>&1
  systemctl reset-failed 'factory-sb-9-*' >/dev/null 2>&1
  rm -rf "$S" "$EVID"
}
trap cleanup EXIT

start_sb() {  # start_sb <unit> -> pid of the systemd-run client; the unit sleeps 600 s
  SB_GATE=1 SB_SLOT=9 SB_UNIT=$1 "$SANDBOX" "$S" 700 sleep 600 </dev/null >/dev/null 2>&1 &
  echo $!
}
wait_active() { local i; for i in $(seq 1 20); do systemctl is-active --quiet "$1.service" && return 0; sleep 0.5; done; return 1; }

stamp=$(date +%s)
A=factory-sb-9-$stamp-g1a
B=factory-sb-9-$stamp-g1b

echo "== placement: Slice= and ControlGroup="
pidA=$(start_sb "$A")
if wait_active "$A"; then
  sl=$(systemctl show -p Slice --value "$A.service")
  cg=$(systemctl show -p ControlGroup --value "$A.service")
  note "Slice=$sl ControlGroup=$cg"
  [[ $sl == factory-s9.slice ]] && pass "unit runs in factory-s9.slice" || fail "Slice= is '$sl', expected factory-s9.slice"
  [[ $cg == /factory.slice/factory-s9.slice/$A.service ]] && pass "ControlGroup nests under factory.slice" \
    || fail "ControlGroup is '$cg', expected /factory.slice/factory-s9.slice/$A.service"
  parent=$(systemctl show -p Slice --value factory-s9.slice)
  note "factory-s9.slice has Slice=$parent"
  [[ $parent == factory.slice ]] && pass "implicit lane slice nests under factory.slice by name" || fail "lane slice parent is '$parent'"
  for k in 1 2 3; do
    if systemctl cat "factory-s$k.slice" >/dev/null 2>&1 && [[ -n $(systemctl show -p FragmentPath --value "factory-s$k.slice") ]]; then
      pass "explicit factory-s$k.slice is installed ($(systemctl show -p Slice --value "factory-s$k.slice"))"
    else
      fail "factory-s$k.slice is not installed (run deploy/orchestrator-install.sh)"
    fi
  done
  note "limits on the sandbox unit: $(systemctl show -p CPUQuotaPerSecUSec -p MemoryMax "$A.service" | tr '\n' ' ')"
else
  fail "unit $A never became active (is factory.slice installed? journalctl -u $A)"
fi

echo "== the unit survives the death of its client (systemd-run --wait)"
kill -9 "$pidA" 2>/dev/null
sleep 3
if systemctl is-active --quiet "$A.service"; then
  pass "unit still active after the client was SIGKILLed"
  note "procs in cgroup: $(cat "/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$A.service")/cgroup.procs" 2>/dev/null | tr '\n' ' ')"
else
  fail "unit stopped with its client: the slice-stop design is not needed, but the A1 assumption is wrong. State: $(systemctl is-active "$A.service")"
fi

echo "== SIGINT to the main process only"
pidB=$(start_sb "$B")
if wait_active "$B"; then
  systemctl kill --kill-whom=main -s INT "$B.service"
  gone=1
  for i in $(seq 1 20); do systemctl is-active --quiet "$B.service" || { gone=0; break; }; sleep 0.5; done
  note "journal: $(journalctl -u "$B.service" -n 6 --no-pager -o cat 2>/dev/null | tr '\n' '|')"
  if (( gone == 0 )); then pass "kill --kill-whom=main -s INT reached the main process (unit ended within 10 s)"; else fail "unit B still active 10 s after SIGINT to main"; fi
else
  fail "unit $B never became active"
fi
kill -9 "$pidB" 2>/dev/null

echo "== stopping the slice removes every unit in it"
if systemctl is-active --quiet "$A.service"; then
  systemctl stop factory-s9.slice
  sleep 1
  left=$(systemctl list-units --all --no-legend "factory-sb-9-*" | grep -c . || true)
  procs=$(pgrep -u factory -x sleep | wc -l)
  note "units left: $left; sleep processes of factory: $procs; slice: $(systemctl is-active factory-s9.slice)"
  [[ $left -eq 0 && $procs -eq 0 ]] && pass "no unit and no process left after stopping the slice" || fail "units=$left procs=$procs left after stopping the slice"
else
  fail "unit A was already gone: cannot prove the slice stop"
fi

echo "== lane isolation (A8): lane 9 sees its own directory and the shared caches, not s1..s3"
for k in 1 2 3; do install -d -o factory -g factory "$H/s$k"; done
seen=$(SB_GATE=1 SB_SLOT=9 "$SANDBOX" "$S" 30 ls -A "$H" </dev/null 2>&1 | tr '\n' ' ')
note "lane 9 sees in /home/factory: $seen"
if grep -qw s9 <<<"$seen" && ! grep -Eqw 's[123]' <<<"$seen"; then pass "only its own s9 is visible"; else fail "wrong directory view: $seen"; fi
for d in .cargo .local .config .cache; do
  if [[ -d $H/$d ]] && ! grep -qw -- "$d" <<<"$seen"; then fail "shared cache $d is missing inside the sandbox"; fi
done
if SB_GATE=1 SB_SLOT=9 "$SANDBOX" "$S" 30 ls "$H/s1" </dev/null >/dev/null 2>&1; then fail "lane 9 could list /home/factory/s1"; else pass "lane 9 cannot list s1"; fi
if SB_GATE=1 SB_SLOT=9 "$SANDBOX" "$S" 30 touch "$S/probe" </dev/null >/dev/null 2>&1 && [[ -e $S/probe ]]; then pass "lane 9 can write its own directory"; else fail "lane 9 cannot write s9"; fi
if SB_GATE=1 SB_SLOT=1 "$SANDBOX" "$S" 30 true </dev/null >/dev/null 2>&1; then fail "sandbox accepted a workdir outside its own lane"; else pass "sandbox refuses a workdir outside the lane"; fi

finish
