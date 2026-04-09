#!/bin/bash
# SSH tunnel: maps local port 3319 to VPS MySQL (port 3320)
# This lets the web app (.env.local DATABASE_URL=localhost:3319) connect to VPS MySQL.
#
# Usage: bash scripts/tunnel-db.sh
# Then run: npm run dev
#
# Ctrl+C to stop the tunnel.

set -e

VPS="${TRADING_VPS:-root@89.167.42.128}"
LOCAL_PORT=3319
REMOTE_PORT=3320

echo "Tunneling localhost:${LOCAL_PORT} -> VPS MySQL (${REMOTE_PORT})..."
echo "Press Ctrl+C to stop."
ssh -N -L ${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT} ${VPS}
