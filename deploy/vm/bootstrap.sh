#!/usr/bin/env bash
#
# Eurisko Hub - one-shot deployment to a fresh always-on VM.
#
#   sudo bash deploy/vm/bootstrap.sh
#
# Turns a bare Ubuntu (or Oracle Linux) VM into the permanent public deployment:
# installs Docker, opens the firewall, clones this repository, generates secrets,
# builds the single production container, starts it behind Caddy with automatic
# HTTPS, and waits until the app actually answers.
#
# The result is a URL that does not depend on your laptop: it survives your PC
# being switched off, and Docker restarts the whole stack after a reboot.
#
# Settings are read from deploy/vm/vm.env (see vm.env.example). Everything is
# optional - anything left out is generated or derived. The script is idempotent:
# re-run it to redeploy the current revision.
#
# Environment overrides (or set the same names in vm.env):
#   SITE_ADDRESS    public hostname to serve (default: <dashed-public-ip>.sslip.io)
#   ADMIN_EMAIL     seeded admin account (default: admin@eurisko.com)
#   ADMIN_PASSWORD  seeded admin password (default: generated and printed once)
#   ACME_EMAIL      Let's Encrypt contact address (optional)
#   GIT_REF         revision to deploy (default: repository default branch)
#   REPO_URL        git remote (default: the GitHub origin of this project)
#   INSTALL_DIR     where to keep the checkout (default: /opt/eurisko-hub)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MichelKarmesty/Eurisko-Hub.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/eurisko-hub}"
PORTS=(80 443 8080)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_CYAN=$'\033[1;36m'
  C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_OFF=$'\033[0m'
else
  C_DIM=; C_BOLD=; C_CYAN=; C_YELLOW=; C_RED=; C_GREEN=; C_OFF=
fi

step() { printf '\n%s==>%s %s\n' "$C_CYAN" "$C_OFF" "$*"; }
info() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
ok()   { printf '    %s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '\n%serror:%s %s\n\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "run this with sudo:  sudo bash deploy/vm/bootstrap.sh"

[ -f /etc/os-release ] || die "cannot identify this operating system (/etc/os-release is missing)"
# shellcheck disable=SC1091
. /etc/os-release
info "host: ${PRETTY_NAME:-unknown}"

# Our own directory, so the script works whether it is run from the repo or from
# a copy that was scp'd onto the VM.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Settings: defaults, then vm.env, then existing .env, then the environment
# ---------------------------------------------------------------------------

if [ -f "$SCRIPT_DIR/vm.env" ]; then
  step "Reading settings"
  info "deploy/vm/vm.env"
  # shellcheck disable=SC1091
  set -a; . "$SCRIPT_DIR/vm.env"; set +a
fi

SITE_ADDRESS="${SITE_ADDRESS:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@eurisko.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
GIT_REF="${GIT_REF:-}"

# ---------------------------------------------------------------------------
# 1. Base packages
# ---------------------------------------------------------------------------

step "Installing base packages"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git openssl >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q ca-certificates curl git openssl >/dev/null
else
  die "unsupported distribution: need apt-get (Ubuntu/Debian) or dnf (Oracle Linux)"
fi
ok "ca-certificates, curl, git, openssl"

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------

step "Installing Docker"

if command -v docker >/dev/null 2>&1; then
  ok "already installed: $(docker --version)"
else
  info "running the official convenience script (get.docker.com)"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh >/dev/null 2>&1 || die "Docker installation failed"
  rm -f /tmp/get-docker.sh
  ok "$(docker --version)"
fi

systemctl enable --now docker >/dev/null 2>&1 || true

# Compose: the plugin ships with modern Docker; fall back to a standalone binary.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "docker compose is unavailable after installing Docker"
fi
ok "${COMPOSE[*]}"

# ---------------------------------------------------------------------------
# 3. Local firewall
# ---------------------------------------------------------------------------
#
# Opening the cloud provider's own firewall (the VCN Security List on Oracle, the
# VPC firewall rules on GCP) is a separate, console-side step - see README.md.

step "Opening the host firewall"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  for p in "${PORTS[@]}"; do ufw allow "$p/tcp" >/dev/null 2>&1 || true; done
  ok "ufw: allowed 22, ${PORTS[*]}"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=ssh >/dev/null 2>&1 || true
  for p in "${PORTS[@]}"; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null 2>&1 || true; done
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "firewalld: allowed 22, ${PORTS[*]}"
else
  # Oracle's Ubuntu images ship an iptables ruleset whose INPUT chain ends in
  # REJECT, so ports stay closed even once the VCN allows them. Insert our
  # accepts ahead of that rule and persist them.
  if command -v iptables >/dev/null 2>&1; then
    for p in "${PORTS[@]}"; do
      iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null \
        || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
    done
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save >/dev/null 2>&1 || true
    elif command -v iptables-save >/dev/null 2>&1 && [ -d /etc/iptables ]; then
      iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    fi
    ok "iptables: allowed ${PORTS[*]}"
  else
    warn "no ufw, firewalld or iptables found - assuming the firewall is managed elsewhere"
  fi
fi

# ---------------------------------------------------------------------------
# 4. The repository
# ---------------------------------------------------------------------------

step "Fetching the application"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "repository already present at $INSTALL_DIR"
  if [ -n "$GIT_REF" ]; then
    git -C "$INSTALL_DIR" fetch --all --tags --prune --quiet
    git -C "$INSTALL_DIR" checkout --force "$GIT_REF" >/dev/null 2>&1
    ok "checked out $GIT_REF"
  else
    ok "using the revision already checked out ($(git -C "$INSTALL_DIR" rev-parse --short HEAD))"
  fi
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR" || die "git clone failed"
  if [ -n "$GIT_REF" ]; then
    git -C "$INSTALL_DIR" checkout --force "$GIT_REF" >/dev/null 2>&1
  fi
  ok "$INSTALL_DIR at $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi

# The compose files must exist. When this script is run from an scp'd copy that
# has not been committed yet, place them next to the checkout.
VM_DIR="$INSTALL_DIR/deploy/vm"
mkdir -p "$VM_DIR"
for f in docker-compose.yml Caddyfile; do
  if [ ! -f "$VM_DIR/$f" ] && [ -f "$SCRIPT_DIR/$f" ]; then
    cp "$SCRIPT_DIR/$f" "$VM_DIR/$f"
    info "installed $f from the script directory"
  fi
done
[ -f "$VM_DIR/docker-compose.yml" ] || die "deploy/vm/docker-compose.yml is missing"
[ -f "$VM_DIR/Caddyfile" ] || die "deploy/vm/Caddyfile is missing"

# ---------------------------------------------------------------------------
# 5. Public IP and hostname
# ---------------------------------------------------------------------------

step "Determining the public address"

public_ip=""
for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
  public_ip="$(curl -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]')" || true
  case "$public_ip" in
    *[!0-9.]*|'') public_ip="" ;;   # keep only a bare IPv4 dotted quad
    *) break ;;
  esac
done

# Oracle's metadata service is the last resort, and the most authoritative.
if [ -z "$public_ip" ] && command -v curl >/dev/null 2>&1; then
  meta="$(curl -fsS --max-time 3 -H 'Authorization: Bearer Oracle' \
    http://169.254.169.254/opc/v2/vnics/ 2>/dev/null || true)"
  public_ip="$(printf '%s' "$meta" | grep -o '"publicIp"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 | sed 's/.*"\([0-9.]*\)"$/\1/')" || true
fi

[ -n "$public_ip" ] || die "could not determine this VM's public IPv4 address - set SITE_ADDRESS in deploy/vm/vm.env"
info "public IPv4: $public_ip"

if [ -z "$SITE_ADDRESS" ]; then
  dashed="$(printf '%s' "$public_ip" | tr '.' '-')"
  SITE_ADDRESS="${dashed}.sslip.io"
  info "no SITE_ADDRESS set - using $SITE_ADDRESS"
fi

# ---------------------------------------------------------------------------
# 6. Secrets and application environment
# ---------------------------------------------------------------------------

ENV_FILE="$VM_DIR/.env"

step "Writing $ENV_FILE"

generated_password=""
if [ -f "$ENV_FILE" ] && grep -q '^JWT_SECRET=' "$ENV_FILE"; then
  info "keeping the existing secrets (delete the file to rotate them)"
  # Reuse the stored password rather than silently reseeding a different one.
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(grep -m1 '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)"
  fi
else
  JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
  if [ -z "$ADMIN_PASSWORD" ]; then
    # Alphanumeric only: compose interpolates `$` in .env values.
    ADMIN_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
    generated_password="$ADMIN_PASSWORD"
  fi

  umask 077
  cat > "$ENV_FILE" <<EOF
# Generated by deploy/vm/bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Git-ignored. Contains the JWT signing key and the seeded admin password.

# --- public identity -------------------------------------------------------
SITE_ADDRESS=$SITE_ADDRESS
APP_BASE_URL=https://$SITE_ADDRESS

# --- required by the API in production -------------------------------------
NODE_ENV=production
PORT=8080
API_PORT=3000
JWT_SECRET=$JWT_SECRET

# --- seeded admin (ADR-004: there is no public registration) ---------------
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD

# --- persistence -----------------------------------------------------------
# Must be on the mounted volume, or every restart starts from an empty database.
DB_FILE=/data/hub.sqlite
# This project ships no migrations, so the schema is created on first boot.
TYPEORM_SYNCHRONIZE=true

# --- AI intake (advisory only) ---------------------------------------------
# Points at the shared demo proxy, so no API key is needed. With no provider
# reachable the app falls back to the labelled offline classifier (ADR-006).
AI_ENABLED=true
AI_PROVIDER_URL=https://eurisko-hub-demo-ai.eurisko-hub.workers.dev/v1
AI_MODEL=openai/gpt-oss-20b
AI_OFFLINE_FALLBACK=true
EOF

  if [ -n "$ACME_EMAIL" ]; then
    printf '\n# Let'"'"'s Encrypt contact address.\nACME_EMAIL=%s\n' "$ACME_EMAIL" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  ok "secrets generated"
fi

# Keep SITE_ADDRESS/APP_BASE_URL current even when the file already existed.
if grep -q '^SITE_ADDRESS=' "$ENV_FILE"; then
  sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$SITE_ADDRESS|" "$ENV_FILE"
  sed -i "s|^APP_BASE_URL=.*|APP_BASE_URL=https://$SITE_ADDRESS|" "$ENV_FILE"
fi
ok "SITE_ADDRESS=$SITE_ADDRESS"

# ---------------------------------------------------------------------------
# 7. Build and start
# ---------------------------------------------------------------------------

step "Building and starting the containers"
info "the first build compiles the API and the web client - expect a few minutes"

cd "$VM_DIR"
"${COMPOSE[@]}" up -d --build

# ---------------------------------------------------------------------------
# 8. Wait for the application
# ---------------------------------------------------------------------------

step "Waiting for the app to answer"

healthy=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 5
done

if [ "$healthy" -ne 1 ]; then
  warn "the app is not answering on 127.0.0.1:8080 yet"
  warn "recent logs:"
  "${COMPOSE[@]}" logs --tail 40 app >&2 || true
  die "deployment did not come up - see the logs above"
fi
ok "the API reports healthy"

# ---------------------------------------------------------------------------
# 9. Wait for the certificate (best effort)
# ---------------------------------------------------------------------------
#
# Reaching our own public hostname from the instance depends on the provider
# supporting hairpin NAT, which not all of them do. A failure here does not mean
# the URL is broken, so it is reported and not treated as fatal.

step "Waiting for the HTTPS certificate"

https_ok=0
for _ in $(seq 1 36); do
  if curl -fsS --max-time 8 "https://$SITE_ADDRESS/api/health" >/dev/null 2>&1; then
    https_ok=1; break
  fi
  sleep 5
done

if [ "$https_ok" -eq 1 ]; then
  ok "https://$SITE_ADDRESS is serving a valid certificate"
else
  warn "not verified from this VM yet (hairpin NAT or a slow ACME order)"
  warn "check it from your own machine:  curl -I https://$SITE_ADDRESS/"
  warn "certificate progress:  ${COMPOSE[*]} -f $VM_DIR/docker-compose.yml logs caddy | tail -30"
fi

# ---------------------------------------------------------------------------
# 10. Keepalive
# ---------------------------------------------------------------------------
#
# Oracle may reclaim an Always Free instance that looks idle for 7 days. Tiny as
# this is, a regular request keeps the instance demonstrably in use.

step "Installing the keepalive timer"

cat > /etc/systemd/system/eurisko-keepalive.service <<EOF
[Unit]
Description=Eurisko Hub keepalive - keeps the Always Free instance active
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/curl -fsS --max-time 10 http://127.0.0.1:8080/api/health
EOF

cat > /etc/systemd/system/eurisko-keepalive.timer <<'EOF'
[Unit]
Description=Run the Eurisko Hub keepalive every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now eurisko-keepalive.timer >/dev/null 2>&1 || true
ok "eurisko-keepalive.timer every 5 minutes"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

cat <<EOF

${C_BOLD}${C_GREEN}Eurisko Hub is deployed.${C_OFF}

  ${C_BOLD}Live URL${C_OFF}       https://$SITE_ADDRESS
  ${C_BOLD}Fallback${C_OFF}       http://$public_ip:8080   (plain HTTP, no certificate)
  ${C_BOLD}Health${C_OFF}         https://$SITE_ADDRESS/api/health

  Admin email    $ADMIN_EMAIL
  Admin password $ADMIN_PASSWORD
EOF

if [ -n "$generated_password" ]; then
  printf '\n  %sThis password was generated now and will not be shown again. Save it.%s\n' "$C_YELLOW" "$C_OFF"
fi

cat <<EOF

  Manage it:
    cd $VM_DIR
    ${COMPOSE[*]} ps
    ${COMPOSE[*]} logs -f app
    ${COMPOSE[*]} up -d --build      # redeploy after a git pull

  Verify it from another machine:
    node scripts/final-smoke.mjs --api https://$SITE_ADDRESS/api
    node scripts/pre-defense.mjs --sha "\$(git rev-parse HEAD)" --live https://$SITE_ADDRESS

EOF
