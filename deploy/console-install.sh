#!/usr/bin/env bash
# Installs the factory console. Run as root on the server, from a checkout or an unpacked release
# that contains console/ (with console/public/ already built) and deploy/.
# Idempotent: running it again upgrades the code and leaves auth.json, secret and certs alone.
#
#   sudo deploy/console-install.sh                 # first run asks for email + password on stdin
#   READONLY=0 sudo deploy/console-install.sh      # enable the control endpoints (default is 1 = read-only)
#   printf 'me@x.com\nlong password\n' | sudo deploy/console-install.sh
#
# By default the console listens on 127.0.0.1:4420 only; reach it with an SSH tunnel
# (ssh -L 4420:127.0.0.1:4420 <server>, then http://127.0.0.1:4420). To publish it on a domain behind
# Apache with a Let's Encrypt certificate:
#   HOST_NAME=factory.example.org CERTBOT_EMAIL=me@x.com sudo -E deploy/console-install.sh
#   (APACHE_BIN, VHOST_DIR and WEBROOT override the Debian/Ubuntu defaults)
#
# Never prints a password, the session secret or the hash.
set -euo pipefail

HOST_NAME=${HOST_NAME:-}
[[ -z $HOST_NAME || $HOST_NAME =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "[console-install] ERROR: bad HOST_NAME" >&2; exit 1; }
SVC_USER=factory-console
OPS_GROUP=factory-ops
APP_DIR=/opt/factory-console
ETC_DIR=/etc/factory-console
UNIT=/etc/systemd/system/factory-console.service
APACHE_BIN=${APACHE_BIN:-$(command -v apachectl || command -v apache2ctl || echo /usr/sbin/apachectl)}
VHOST_DIR=${VHOST_DIR:-/etc/apache2/sites-enabled}
VHOST="$VHOST_DIR/$HOST_NAME.conf"
WEBROOT=${WEBROOT:-/var/www/$HOST_NAME}
CERT_DIR=/etc/letsencrypt/live/$HOST_NAME
EXAMPLE_HOST=factory.example.com
READONLY="${READONLY:-1}"

say()  { printf '[console-install] %s\n' "$*"; }
die()  { printf '[console-install] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$READONLY" = 0 ] || [ "$READONLY" = 1 ] || die "READONLY must be 0 or 1"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC/console/server.mjs" ] || die "console/server.mjs not found under $SRC"
[ -f "$SRC/console/public/index.html" ] || die "console/public/index.html is missing: build the frontend locally (console/web) and ship console/public/ with this release"
[ -f "$SRC/deploy/apache/$EXAMPLE_HOST.conf" ] || die "deploy/apache/$EXAMPLE_HOST.conf not found"
[ -f "$SRC/console/systemd/factory-console.service" ] || die "console/systemd/factory-console.service not found"

NODE=/usr/local/bin/node
[ -x "$NODE" ] || die "$NODE not found (Node 22 is required)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $("$NODE" -v) is too old; need >= 22"

# ---------------------------------------------------------------- user and groups
getent group "$OPS_GROUP" >/dev/null || { groupadd --system "$OPS_GROUP"; say "created group $OPS_GROUP"; }
getent group "$SVC_USER" >/dev/null || groupadd --system "$SVC_USER"
if id "$SVC_USER" >/dev/null 2>&1; then
  usermod -a -G "$OPS_GROUP" "$SVC_USER"
  say "user $SVC_USER exists; ensured membership of $OPS_GROUP"
else
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
    --gid "$SVC_USER" --groups "$OPS_GROUP" "$SVC_USER"
  say "created user $SVC_USER (no shell, no home), member of $OPS_GROUP"
fi

# ---------------------------------------------------------------- code
install -d -m 755 -o root -g root "$APP_DIR"
rm -rf "$APP_DIR/lib" "$APP_DIR/bin" "$APP_DIR/public"
install -m 644 -o root -g root "$SRC/console/server.mjs" "$APP_DIR/server.mjs"
install -m 644 -o root -g root "$SRC/console/package.json" "$APP_DIR/package.json"
cp -r "$SRC/console/lib" "$APP_DIR/lib"
cp -r "$SRC/console/bin" "$APP_DIR/bin"
cp -r "$SRC/console/public" "$APP_DIR/public"
chown -R root:root "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 755 {} +
find "$APP_DIR" -type f -exec chmod 644 {} +
say "installed code to $APP_DIR (public/ has $(find "$APP_DIR/public" -type f | wc -l) files)"

# ---------------------------------------------------------------- credentials
install -d -m 750 -o root -g "$SVC_USER" "$ETC_DIR"
if [ -f "$ETC_DIR/auth.json" ] && [ -f "$ETC_DIR/secret" ]; then
  say "auth.json and secret already present; leaving them alone (rerun bin/passwd.mjs to change the login)"
else
  say "no login configured yet: reading email and password (two lines) from stdin"
  HC_ETC_DIR="$ETC_DIR" HC_GROUP="$SVC_USER" "$NODE" "$APP_DIR/bin/passwd.mjs"
fi
chown root:"$SVC_USER" "$ETC_DIR" "$ETC_DIR/auth.json" "$ETC_DIR/secret"
chmod 750 "$ETC_DIR"
chmod 640 "$ETC_DIR/auth.json" "$ETC_DIR/secret"

# ---------------------------------------------------------------- systemd unit
TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT
if [ -n "$HOST_NAME" ]; then ORIGIN="https://$HOST_NAME"; else ORIGIN="http://127.0.0.1:4420"; fi
sed -e "s/^Environment=HC_READONLY=.*/Environment=HC_READONLY=$READONLY/" \
    -e "s|^Environment=HC_ORIGIN=.*|Environment=HC_ORIGIN=$ORIGIN|" \
  "$SRC/console/systemd/factory-console.service" > "$TMP_UNIT"
install -m 644 -o root -g root "$TMP_UNIT" "$UNIT"
systemctl daemon-reload
if [ -d /var/lib/factory-ops/ctl ]; then
  systemctl enable factory-console >/dev/null 2>&1
  systemctl restart factory-console
  say "unit installed, enabled and (re)started (HC_READONLY=$READONLY)"
  sleep 1
  systemctl is-active --quiet factory-console || { journalctl -u factory-console -n 20 --no-pager >&2; die "factory-console is not active"; }
  "$NODE" -e 'fetch("http://127.0.0.1:4420/api/health").then(r=>r.json()).then(j=>{if(!j.ok)process.exit(1)}).catch(()=>process.exit(1))' \
    && say "health check ok on 127.0.0.1:4420" || die "health check on 127.0.0.1:4420 failed"
else
  systemctl enable factory-console >/dev/null 2>&1
  say "WARNING: /var/lib/factory-ops/ctl does not exist yet (the orchestrator install creates it), so the unit"
  say "         is enabled but NOT started. Install the orchestrator, then: systemctl start factory-console"
fi

# ---------------------------------------------------------------- apache + certificate (only with HOST_NAME)
if [ -z "$HOST_NAME" ]; then
  say "done. No HOST_NAME: the console is on 127.0.0.1:4420 only."
  say "Reach it with: ssh -L 4420:127.0.0.1:4420 <this server>, then open http://127.0.0.1:4420"
  exit 0
fi
[ -x "$APACHE_BIN" ] || die "$APACHE_BIN not found (install Apache 2.4, or set APACHE_BIN)"
install -d -m 755 "$WEBROOT" "$VHOST_DIR"

if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
  command -v certbot >/dev/null || die "certbot not found and $CERT_DIR is missing"
  say "no certificate for $HOST_NAME yet: serving a temporary :80-only vhost to issue one"
  BACKUP=""
  [ -f "$VHOST" ] && { BACKUP="$(mktemp)"; cp -p "$VHOST" "$BACKUP"; }
  restore_vhost() { if [ -n "$BACKUP" ]; then cp -p "$BACKUP" "$VHOST"; else rm -f "$VHOST"; fi; }
  cat > "$VHOST" <<EOF
<VirtualHost *:80>
    ServerName $HOST_NAME
    DocumentRoot $WEBROOT
    <Directory $WEBROOT>
        Require all granted
    </Directory>
</VirtualHost>
EOF
  if ! "$APACHE_BIN" -t 2>/dev/null; then restore_vhost; die "apachectl -t failed with the temporary vhost; nothing changed"; fi
  "$APACHE_BIN" -k graceful
  sleep 2
  CB_ARGS=(certonly --webroot -w "$WEBROOT" -d "$HOST_NAME" --non-interactive --agree-tos)
  if [ -n "${CERTBOT_EMAIL:-}" ]; then CB_ARGS+=(-m "$CERTBOT_EMAIL"); else CB_ARGS+=(--register-unsafely-without-email); fi
  if ! certbot "${CB_ARGS[@]}"; then
    restore_vhost; "$APACHE_BIN" -k graceful || true
    die "certbot failed (DNS for $HOST_NAME must reach this box; behind a proxying CDN, http-01 needs :80 reachable and no forced redirect for /.well-known/acme-challenge/)"
  fi
  [ -n "$BACKUP" ] && rm -f "$BACKUP"
  say "issued certificate for $HOST_NAME"
else
  say "certificate for $HOST_NAME already present"
fi

# Install the real vhost only if apache accepts the whole configuration with it in place.
PREV=""
[ -f "$VHOST" ] && { PREV="$(mktemp)"; cp -p "$VHOST" "$PREV"; }
sed "s/$EXAMPLE_HOST/$HOST_NAME/g; s|/var/www/$HOST_NAME|$WEBROOT|g" "$SRC/deploy/apache/$EXAMPLE_HOST.conf" > "$TMP_UNIT"
install -m 644 -o root -g root "$TMP_UNIT" "$VHOST"
if "$APACHE_BIN" -t 2>/tmp/factory-console-apache-test.err; then
  "$APACHE_BIN" -k graceful
  say "installed $VHOST and reloaded apache gracefully"
  [ -n "$PREV" ] && rm -f "$PREV"
else
  if [ -n "$PREV" ]; then cp -p "$PREV" "$VHOST"; rm -f "$PREV"; else rm -f "$VHOST"; fi
  cat /tmp/factory-console-apache-test.err >&2
  die "apachectl -t rejected the vhost; previous state restored, apache not reloaded"
fi
rm -f /tmp/factory-console-apache-test.err

say "done. Check: curl -s https://$HOST_NAME/api/health"
