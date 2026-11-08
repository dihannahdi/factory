#!/usr/bin/env bash
# Run a command as an unprivileged factory user inside a transient systemd unit.
#
# Whatever the agent can read can reach the model provider (and a free model's provider may train
# on it), so anything it can read can leak. Assume the box is shared with production: world-readable
# .env files under /opt, and dozens of services listening on 127.0.0.1 (Postgres, Redis, other
# apps). The unit therefore sees only its own home, /usr and /etc, and cannot open a socket to
# localhost, the private ranges (docker bridges, tailscale), or the addresses in SB_DENY_EXTRA (set
# it to the box's own public IP, e.g. "203.0.113.7/32", so the agent cannot reach the host through
# it).
#
# Lanes: up to three agents per instance run at once (another instance has its own SLOTS), each in its
# own s<K> directory of the agent's home. The home is rebuilt as a tmpfs with a bind mount for every
# top-level entry EXCEPT the other lanes' s<N> directories, so lane 1 cannot read, let alone write,
# lane 2's checkout. The shared caches (.cargo, .rustup, .npm-global, .local, .config, .cache, .npm)
# stay shared on purpose: opencode sessions in .local must be resumable from any lane.
#
# Every unit is named (factory-sb-<K>-<epoch>-<rand>) and placed in factory-s<K>.slice. That is
# not tidiness: `systemd-run --wait` does NOT stop the transient unit when its client is killed
# (systemd 256, verified in the source), so a killed run.sh would leave a build running with no
# one to wait for it. Stopping the slice is how a lane takes its sandboxes down.
#
# factory-review (Claude /code-review) runs the same way under its own uid, so its Claude
# login can never be read by factory. SB_CRED=name:/path hands one root-only file to
# this unit alone, at $CREDENTIALS_DIRECTORY/name.
#
# usage: SB_SLOT=<one of SLOTS, default 1 2 3> [SB_UNIT=name] sandbox.sh <workdir> <timeout-s> <cmd> [args...]
#        SB_USER=factory-review [SB_CRED=name:/path] sandbox.sh <workdir> <timeout-s> <cmd> [args...]
#        (factory-review has no lanes: SB_SLOT is ignored and its whole home is bound)
#
# SB_PRIVATE_NET=1 (opt-in, factory only; verify's Playwright run): the unit gets its OWN network
# namespace (PrivateNetwork=yes) holding nothing but its own loopback, and only then are 127.0.0.0/8
# and ::1/128 taken out of IPAddressDeny. That loopback is the unit's, not the host's: Postgres on
# 127.0.0.1, the host's other services and every other host listener stay unreachable, and there is no
# route to the internet either (no interface). It exists so `astro preview` on 127.0.0.1 can be
# reached by the browser inside the same unit. Everything else is unchanged; unset (the default)
# the unit's properties are exactly what they were.
set -euo pipefail

user=${SB_USER:-factory}
[[ $user == factory || $user == factory-review ]] || { echo "sandbox: unknown user $user" >&2; exit 2; }
H=/home/$user
workdir=$1; timeout=$2; shift 2
[[ $timeout =~ ^[0-9]+$ ]] || { echo "sandbox: bad timeout" >&2; exit 2; }
[[ $workdir == "$H" || $workdir == "$H"/* ]] || { echo "sandbox: workdir must be under $H" >&2; exit 2; }
case $workdir in *..*|*[[:space:],:]*) echo "sandbox: refusing workdir $workdir" >&2; exit 2 ;; esac

slot=${SB_SLOT:-}
slice=""
binds=()
if [[ $user == factory ]]; then
  # SLOTS: the lanes of the instance that called us (lib.sh has the same default; run.sh's
  # environment carries it here). Every entry must be a plain number and never 9, which is the
  # gates' scratch lane (orchestrator/gates), allowed only when asked for explicitly.
  slot_ok=0
  for s in ${SLOTS:-1 2 3}; do
    [[ $s =~ ^[0-9]+$ && $s != 9 ]] || { echo "sandbox: bad SLOTS entry '$s'" >&2; exit 2; }
    [[ $slot == "$s" ]] && slot_ok=1
  done
  if (( ! slot_ok )) && ! { [[ ${SB_GATE:-} == 1 && $slot == 9 ]]; }; then
    echo "sandbox: SB_SLOT must be one of: ${SLOTS:-1 2 3}" >&2; exit 2
  fi
  [[ $workdir == "$H/s$slot" || $workdir == "$H/s$slot"/* ]] \
    || { echo "sandbox: workdir must be under $H/s$slot" >&2; exit 2; }
  slice=factory-s$slot.slice
  # Bind every top-level entry of the home except the other lanes' directories. Symlinks are
  # skipped: the agent owns its home and could point one at a root path.
  shopt -s dotglob nullglob
  for e in "$H"/*; do
    b=${e##*/}
    [[ $b =~ ^s[0-9]+$ ]] && continue
    [[ -L $e ]] && continue
    [[ $b == *[[:space:],:]* ]] && continue
    binds+=("$e")
  done
  shopt -u dotglob nullglob
  binds+=("$H/s$slot")
else
  slot=""
  binds=("$H")
fi
target=$H/target
[[ -n $slot ]] && target=$H/s$slot/target
bind_list="${binds[*]}"

unit=${SB_UNIT:-factory-sb-${slot:-r}-$(date +%s)-$RANDOM$RANDOM}
[[ $unit =~ ^factory-sb-[A-Za-z0-9_-]+$ ]] || { echo "sandbox: bad unit name" >&2; exit 2; }

# TemporaryFileSystem= has no "-" (ignore-missing) prefix, so list only what exists.
hide=()
for d in /opt /www /srv /mnt /media /var/lib /var/log /var/www /var/spool /var/backups /var/mail /var/opt /var/cache; do
  [[ -d $d ]] && hide+=("$d:ro")
done
deny_extra=${SB_DENY_EXTRA:-}
[[ -z $deny_extra || $deny_extra =~ ^[0-9a-fA-F.:/\ ]+$ ]] || { echo "sandbox: bad SB_DENY_EXTRA" >&2; exit 2; }
deny="127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10${deny_extra:+ $deny_extra}"
netopt=()
if [[ -n ${SB_PRIVATE_NET:-} ]]; then
  [[ $SB_PRIVATE_NET == 1 && $user == factory ]] || { echo "sandbox: SB_PRIVATE_NET must be 1 (factory only)" >&2; exit 2; }
  netopt=(-p PrivateNetwork=yes)
  deny="169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10${deny_extra:+ $deny_extra}"
fi
cred=()
# SB_CRED: one or more space-separated name:/abs/path entries, each handed to this unit alone as
# $CREDENTIALS_DIRECTORY/name (the key never goes through argv of the command, env or the journal).
for c in ${SB_CRED:-}; do
  [[ $c =~ ^[A-Za-z0-9_-]+:/[^[:space:]]+$ ]] || { echo "sandbox: bad SB_CRED entry" >&2; exit 2; }
  cred+=(-p "LoadCredential=$c")
done
sliceopt=()
[[ -n $slice ]] && sliceopt=(--slice="$slice")
# The lane's own Postgres (run.sh pg_start): a UNIX socket in s<K>/pg, percent-encoded into the URL
# authority. Only that exact shape for THIS slot is passed on; anything else is refused. The variable
# it arrives in is PG_TEST_ENV (run.sh has the same default); empty means no database for this instance.
pgenv=()
pg_env=${PG_TEST_ENV-TEST_DATABASE_URL}
[[ -z $pg_env || $pg_env =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "sandbox: bad PG_TEST_ENV" >&2; exit 2; }
if [[ -n ${SB_PG_URL:-} && -n $pg_env && $user == factory ]]; then
  [[ $SB_PG_URL == "postgres://factory@%2Fhome%2Ffactory%2Fs${slot}%2Fpg/postgres" ]] \
    || { echo "sandbox: refusing SB_PG_URL" >&2; exit 2; }
  pgenv=(-p "Environment=$pg_env=$SB_PG_URL")
fi

# InaccessiblePaths: /etc/factory (this instance's tokens and keys) and the console's /etc dir are
# always hidden. Another instance on the same box keeps its EnvironmentFile and token in its own
# /etc/<name>-agent (deploy/instance-install.sh): every such directory is hidden too, found at
# startup. SB_HIDE_EXTRA replaces that list (space-separated; a "-" prefix means "fine if missing").
if [[ -z ${SB_HIDE_EXTRA+x} ]]; then
  SB_HIDE_EXTRA=""
  for d in /etc/*-agent; do [[ -d $d && ! -L $d ]] && SB_HIDE_EXTRA+=" -$d"; done
fi
SB_HIDE_EXTRA=${SB_HIDE_EXTRA# }
[[ -z $SB_HIDE_EXTRA || $SB_HIDE_EXTRA =~ ^(-?/[A-Za-z0-9._/-]+)( -?/[A-Za-z0-9._/-]+)*$ ]] || { echo "sandbox: bad SB_HIDE_EXTRA" >&2; exit 2; }
exec systemd-run --quiet --wait --pipe --collect \
  --unit="$unit" "${sliceopt[@]}" \
  --uid="$user" --gid="$user" \
  --working-directory="$workdir" \
  -p RuntimeMaxSec="$timeout" \
  -p NoNewPrivileges=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes \
  -p ProtectSystem=strict -p ProtectHome=tmpfs -p BindPaths="$bind_list" \
  -p PrivateTmp=yes -p PrivateDevices=yes \
  -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectKernelLogs=yes \
  -p ProtectControlGroups=yes -p ProtectClock=yes -p ProtectHostname=yes \
  -p ProtectProc=invisible -p ProcSubset=pid \
  -p "TemporaryFileSystem=${hide[*]}" \
  -p "InaccessiblePaths=/etc/factory${SB_HIDE_EXTRA:+ $SB_HIDE_EXTRA} -/etc/factory-console -/run/docker.sock -/run/containerd -/run/postgresql -/run/mysqld -/run/redis" \
  -p "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK" \
  -p "IPAddressDeny=$deny" \
  "${netopt[@]}" \
  -p CPUQuota=300% -p MemoryHigh=7G -p MemoryMax=10G -p TasksMax=2048 -p Nice=10 \
  "${cred[@]}" "${pgenv[@]}" \
  -p Environment="HOME=$H" \
  -p Environment="PATH=$H/.cargo/bin:$H/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" \
  -p Environment="CARGO_BUILD_JOBS=2" \
  -p Environment="CARGO_INCREMENTAL=0" \
  -p Environment="RUST_TEST_THREADS=4" \
  -p Environment="CARGO_PROFILE_DEV_DEBUG=line-tables-only" \
  -p Environment="CARGO_PROFILE_TEST_DEBUG=line-tables-only" \
  -p Environment="CARGO_TARGET_DIR=$target" \
  -p Environment="OPENCODE_DISABLE_AUTOUPDATE=1" \
  -p Environment="LANG=C.UTF-8" \
  -- /usr/bin/env "$@"   # env, so the command is looked up in the PATH above, not systemd's
