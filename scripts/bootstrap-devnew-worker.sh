#!/usr/bin/env bash
set -euo pipefail

# Bootstrap + run một VMOS producer worker trên host Ubuntu (ephemeral, ~60 phút).
# Yêu cầu env: DATABASE_URL (Postgres pool dùng chung, bảng vmos).
# Tuỳ chọn: VMOS_REPO (mặc định Quan3s/VMOS), VMOS_REF (branch/tag/commit),
#           WORKDIR (mặc định /app/vmos-worker), VMOS_MAX_ACCOUNTS (300),
#           VMOS_DB_TABLE (vmos), INSTALL_CHROME=1.
#
# Ví dụ:
#   DATABASE_URL='postgres://...' bash bootstrap-devnew-worker.sh

log() { printf '[bootstrap] %s\n' "$*" >&2; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

: "${DATABASE_URL:?DATABASE_URL is required}"
VMOS_REPO="${VMOS_REPO:-https://github.com/Quan3s/VMOS.git}"
VMOS_REF="${VMOS_REF:-main}"
WORKDIR="${WORKDIR:-/app/vmos-worker}"
VMOS_DB_TABLE="${VMOS_DB_TABLE:-vmos}"
VMOS_MAX_ACCOUNTS="${VMOS_MAX_ACCOUNTS:-300}"
INSTALL_CHROME="${INSTALL_CHROME:-1}"

export DEBIAN_FRONTEND=noninteractive

if command -v apt-get >/dev/null 2>&1; then
  log "Cài packages hệ thống (xvfb, deps chromium, git, curl, ca-certificates)..."
  apt-get update -y
  apt-get install -y --no-install-recommends \
    git curl ca-certificates xvfb \
    fonts-liberation libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 \
    libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 \
    libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 \
    libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
    libxrandr2 libxshmfence1 xdg-utils \
    2>/dev/null || apt-get install -y --no-install-recommends \
    git curl ca-certificates xvfb \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 \
    libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
    libxrandr2 libxshmfence1 xdg-utils || true
fi

# Node.js (>=18)
if ! command -v node >/dev/null 2>&1; then
  log "Node chưa có — cài qua mise (hoặc fallback nodesource)..."
  if ! command -v mise >/dev/null 2>&1; then
    curl -fsSL https://mise.run | sh || true
    export PATH="$HOME/.local/bin:$PATH"
  fi
  if command -v mise >/dev/null 2>&1; then
    mise use -g node@lts
    eval "$(mise activate bash)" || true
    export PATH="$HOME/.local/share/mise/shims:$PATH"
  else
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - || true
    apt-get install -y nodejs || die "Không cài được Node.js"
  fi
fi
log "Node: $(node -v), npm: $(npm -v)"

mkdir -p "$(dirname "$WORKDIR")"
if [ ! -d "$WORKDIR/.git" ]; then
  log "Clone $VMOS_REPO ($VMOS_REF) -> $WORKDIR"
  rm -rf "$WORKDIR"
  git clone --depth 1 --branch "$VMOS_REF" "$VMOS_REPO" "$WORKDIR"
else
  log "Repo đã có tại $WORKDIR — fetch/update"
  git -C "$WORKDIR" fetch --depth 1 origin "$VMOS_REF" || true
  git -C "$WORKDIR" checkout "$VMOS_REF" || true
  git -C "$WORKDIR" reset --hard "origin/$VMOS_REF" 2>/dev/null || git -C "$WORKDIR" pull --ff-only || true
fi

cd "$WORKDIR"
log "npm install..."
npm install --no-audit --no-fund

# Chrome for Testing (headed, để bypass Cloudflare)
BROWSER_PATH="${BROWSER_PATH:-}"
if [ -z "$BROWSER_PATH" ]; then
  for c in \
    "$HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome" \
    /root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome \
    /opt/chrome-for-testing/chrome-linux64/chrome \
    /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -x "$c" ] && BROWSER_PATH="$c" && break
  done
fi
if [ -z "$BROWSER_PATH" ] && [ "$INSTALL_CHROME" = "1" ]; then
  log "Cài Chrome for Testing..."
  npx --yes @puppeteer/browsers install chrome@stable --path "$HOME/.cache/chrome-for-testing" >/tmp/chrome-install.log 2>&1 || true
  BROWSER_PATH="$(find "$HOME/.cache/chrome-for-testing" -type f -name chrome -perm -111 2>/dev/null | head -1 || true)"
fi
[ -n "$BROWSER_PATH" ] && [ -x "$BROWSER_PATH" ] || die "Không tìm thấy Chrome/Chromium. Set BROWSER_PATH hoặc cài browser."
log "Browser: $BROWSER_PATH"

# .env (không commit secrets)
cat > .env <<EOF
BROWSER=auto
BROWSER_PATH=$BROWSER_PATH
HEADLESS=false
DATABASE_URL=$DATABASE_URL
VMOS_DB_TABLE=$VMOS_DB_TABLE
VMOS_MAX_ACCOUNTS=$VMOS_MAX_ACCOUNTS
PORT=3000
WARP_ENABLED=false
AUTO_XVFB=true
EOF
chmod 600 .env

# Tránh chạy chồng
pkill -f 'node producer.js' 2>/dev/null || true
pkill -f '/tmp/vmos-worker-watchdog.sh' 2>/dev/null || true
sleep 1

cat > /tmp/vmos-worker-watchdog.sh <<'SH'
#!/bin/bash
while sleep 30; do
  if ! pgrep -f 'node producer.js' >/dev/null 2>&1; then
    cd "__WORKDIR__" && setsid -f node producer.js >> /var/log/vmos-producer.log 2>&1 < /dev/null
  fi
done
SH
sed -i "s#__WORKDIR__#$WORKDIR#g" /tmp/vmos-worker-watchdog.sh
chmod +x /tmp/vmos-worker-watchdog.sh

log "Start producer + watchdog..."
cd "$WORKDIR"
: >> /var/log/vmos-producer.log
nohup node producer.js >> /var/log/vmos-producer.log 2>&1 < /dev/null &
nohup /bin/bash /tmp/vmos-worker-watchdog.sh >/dev/null 2>&1 < /dev/null &

sleep 3
log "Processes:"
pgrep -af 'producer.js|vmos-worker-watchdog.sh' || true
log "Log: tail -f /var/log/vmos-producer.log"
log "Xong. Worker sẽ chạy trong phiên này (~60 phút)."
