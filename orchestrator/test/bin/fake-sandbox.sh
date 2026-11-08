#!/usr/bin/env bash
# Test stand-in for sandbox.sh: args are <workdir> <timeout> <cmd...>. Logs every call to
# $FAKE_LOG and plays `opencode run` according to $FAKE_MODE. Anything that is not `opencode run`
# (rm, cat, git ...) just succeeds with no output.
workdir=$1 tmo=$2; shift 2
log=${FAKE_LOG:-/dev/null}
flat=$(printf '%s ' "$@" | tr '\n' ' ')
# The log shows the model command as `opencode run`, whichever of the two names run.sh used.
flat=${flat/#factory-opencode /opencode }
printf 'unit=%s cmd=%s\n' "${SB_UNIT:-}" "$flat" >> "$log"
printf '%s\n' "${SB_CRED:-}" >> "${FAKE_CRED_LOG:-/dev/null}"
# run.sh runs the model through the factory-opencode wrapper (feat/agent-cred); the fake plays both names.
if [[ ${1:-} != opencode && ${1:-} != factory-opencode ]]; then
  if [[ ${1:-} == sleepy ]]; then sleep "${FAKE_SLEEP:-3}"; exit "${FAKE_RC:-0}"; fi
  exit 0
fi
resume=0; msg=${*: -1}
for a in "$@"; do if [[ $a == -s ]]; then resume=1; fi; done
steered=0; if [[ $msg == *"Steer from a human"* ]]; then steered=1; fi
# fake_sleep <default-seconds>: a turn that runs until FAKE_SLEEP runs out, or until the fake
# systemctl kills or stops this unit (it drops $FAKE_KILL_DIR/<unit>). With FAKE_KILL_DIR set, a
# watchdog test no longer races a turn that ends on its own while the box is busy.
fake_sleep() {
  local end=$(( SECONDS + ${FAKE_SLEEP:-$1} ))
  if [[ -z ${FAKE_KILL_DIR:-} || -z ${SB_UNIT:-} ]]; then sleep "${FAKE_SLEEP:-$1}"; return 0; fi
  while (( SECONDS < end )); do
    if [[ -e $FAKE_KILL_DIR/$SB_UNIT ]]; then exit 143; fi
    sleep 0.2
  done
}
ev_session() { echo '{"type":"step_start","timestamp":1,"sessionID":"ses_fake1","part":{"type":"step-start"}}'; }
ev_ok() { echo '{"type":"text","timestamp":2,"sessionID":"ses_fake1","part":{"type":"text","text":"done"}}'
          echo '{"type":"step_finish","timestamp":3,"sessionID":"ses_fake1","part":{"type":"step-finish","cost":0,"tokens":{"input":10,"output":5,"reasoning":1,"cache":{"read":20,"write":0}}}}'; }
case ${FAKE_MODE:-ok} in
  ok) ev_session; ev_ok ;;
  steer_sid)        # a session exists before the steer; the resume works
    if (( resume )); then ev_ok; else ev_session; sleep "${FAKE_SLEEP:-4}"; fi ;;
  steer_nosid)      # the steer arrives before opencode printed anything: restart with the message
    if (( steered )); then ev_session; ev_ok; else sleep "${FAKE_SLEEP:-4}"; fi ;;
  steer_resume_err) # the resumed session answers with a model error: a fresh session must follow
    if (( resume )); then echo '{"type":"error","timestamp":2,"error":{"name":"APIError","data":{"message":"boom","statusCode":400}}}'; exit 1
    elif (( steered )); then ev_session; ev_ok
    else ev_session; sleep "${FAKE_SLEEP:-4}"; fi ;;
  wd_rl)            # a silent rate limit in opencode's log; a resumed run works
    if (( resume )); then ev_ok; else ev_session; echo "level=ERROR service=llm message=\"stream error\" error.error=\"AI_APICallError: Rate limit exceeded. Please try again later.\"" >&2; fake_sleep 8; fi ;;
  wd_stall)         # silence: no events, no log
    if (( resume )); then ev_ok; else ev_session; fake_sleep 8; fi ;;
  wd_stall_all)     # every model stalls
    ev_session; fake_sleep 8 ;;
  go_cost)          # a turn that costs money
    ev_session; echo '{"type":"step_finish","timestamp":3,"sessionID":"ses_fake1","part":{"cost":0.25,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}' ;;
  rate) echo '{"type":"error","timestamp":2,"error":{"name":"APIError","data":{"message":"Rate limit exceeded","statusCode":429}}}'; exit 1 ;;
  cost) ev_session; echo '{"type":"step_finish","timestamp":3,"sessionID":"ses_fake1","part":{"cost":0.5,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}' ;;
esac
exit 0
