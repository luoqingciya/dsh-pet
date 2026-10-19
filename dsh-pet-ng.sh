#!/usr/bin/env sh
# ============================================================
#  dsh-petNG local app launcher (macOS / Linux)
#  Run this file to start the desktop pet without DSH.
#  First run: installs deps + builds (needs Node.js 22.12+).
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[dsh-petNG] Node.js 22.12+ is required: https://nodejs.org/"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[dsh-petNG] Installing dependencies (first run only)..."
  npm install --no-audit --no-fund
fi

if [ ! -f lib/app-main.cjs ]; then
  echo "[dsh-petNG] Building..."
  npm run bundle
  npm run build:desktop-core
fi

exec node lib/app-launch.js "$@"
