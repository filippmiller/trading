#!/bin/bash
# Deploy surveillance cron to Hetzner VPS
# Usage: bash scripts/deploy-surveillance.sh

set -e

VPS="${TRADING_VPS:-root@89.167.42.128}"
REMOTE_DIR="/opt/trading-surveillance"

echo "=== Deploying Trading Surveillance to VPS ==="

# 1. Create remote directory
echo "[1/5] Creating remote directory..."
ssh "$VPS" "mkdir -p $REMOTE_DIR/scripts $REMOTE_DIR/docker"

# 2. Copy required files
echo "[2/5] Copying files..."
scp docker/docker-compose.surveillance.yml "$VPS":$REMOTE_DIR/docker/
scp docker/Dockerfile.cron "$VPS":$REMOTE_DIR/docker/
scp docker/package.cron.json "$VPS":$REMOTE_DIR/docker/
scp docker/init-db.sql "$VPS":$REMOTE_DIR/docker/
scp scripts/surveillance-cron.ts "$VPS":$REMOTE_DIR/scripts/
scp tsconfig.json "$VPS":$REMOTE_DIR/

# 3. Ensure .env exists on VPS (don't overwrite if present)
echo "[3/5] Checking .env..."
ssh "$VPS" "test -f $REMOTE_DIR/docker/.env || { echo 'ERROR: Create $REMOTE_DIR/docker/.env with MYSQL_ROOT_PASSWORD and MYSQL_DATABASE before deploying.'; exit 1; }"

# 4. Build and start
echo "[4/5] Building and starting containers..."
ssh "$VPS" "cd $REMOTE_DIR && docker compose -f docker/docker-compose.surveillance.yml --env-file docker/.env up -d --build"

# 5. Verify
echo "[5/5] Verifying..."
sleep 10
ssh "$VPS" "docker compose -f $REMOTE_DIR/docker/docker-compose.surveillance.yml ps" || true
ssh "$VPS" "docker logs trading-surveillance-cron --tail=20" || true

echo ""
echo "=== Deployment complete ==="
echo "View logs: ssh \$TRADING_VPS 'docker logs -f trading-surveillance-cron'"
