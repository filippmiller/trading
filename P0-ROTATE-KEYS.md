# P0 — Rotate Leaked Secrets (URGENT — Do This Today)

The following credentials appeared in committed git history (`.claude/sessions/*.md` and `.claude/agent-log.md`).
They must be rotated at the vendor **before** any further use of this repository.

---

## Checklist

### 1. Rotate TwelveData API Key

- [ ] Go to: https://twelvedata.com/account/api-keys
- [ ] Revoke the key ending in `...8c8c2` (full value was in session notes)
- [ ] Generate a new key
- [ ] Update Railway env var `TWELVEDATA_API_KEY` → new value
- [ ] Update your local `.env.local` → new value
- [ ] Confirm the old key returns 401 from `https://api.twelvedata.com/time_series?apikey=<OLD_KEY>&symbol=AAPL&interval=1min&outputsize=1`

### 2. Rotate Finnhub API Key

- [ ] Go to: https://finnhub.io/dashboard
- [ ] Revoke the key ending in `...6pcg...` (full value was in session notes)
- [ ] Generate a new key
- [ ] Update Railway env var `FINNHUB_API_KEY` → new value
- [ ] Update your local `.env.local` → new value

### 3. Rotate FMP (Financial Modeling Prep) API Key

- [ ] Go to: https://financialmodelingprep.com/developer/docs/dashboard
- [ ] Revoke the key ending in `...GY61` (full value was in session notes)
- [ ] Generate a new key
- [ ] Update Railway env var `FMP_API_KEY` → new value
- [ ] Update your local `.env.local` → new value

### 4. Rotate MySQL Root Password

The password `trading123` appeared in 20+ committed files and must be replaced in all environments.

**Local dev (Docker):**
- [ ] Generate a new password: `openssl rand -base64 32`
- [ ] Update `docker/.env` (gitignored) with new `MYSQL_ROOT_PASSWORD`
- [ ] Restart the MySQL container: `docker compose -f docker/docker-compose.surveillance.yml up -d --force-recreate mysql`
- [ ] Verify: `mysql -h127.0.0.1 -P3320 -uroot -p"<NEW_PASSWORD>" trading -e "SELECT 1"`

**Railway production:**
- [ ] Go to Railway dashboard → TRADING project → MySQL service → Variables
- [ ] Update `MYSQL_ROOT_PASSWORD` to new value
- [ ] Update `DATABASE_URL` in the web and worker services to use new password
- [ ] Redeploy all three services (web, worker, MySQL)
- [ ] Verify health: `curl https://trading-production-06fe.up.railway.app/api/healthz`

**VPS accumulator DB (89.167.42.128:3320):**
- [ ] SSH in: `ssh root@89.167.42.128`
- [ ] Change the MySQL root password:
  ```sql
  docker exec -i docker-mysql-1 mysql -uroot -p"trading123" \
    -e "ALTER USER 'root'@'%' IDENTIFIED BY '<NEW_PASSWORD>'; FLUSH PRIVILEGES;"
  ```
- [ ] Update any scripts that connect to this host with the new password via env var

### 5. Purge Secrets from Git History

The `.claude/sessions/` and `.claude/agent-log.md` files are now untracked (removed from git index in commit `security/p0-hardening`). However, the **git history** still contains these files with the plaintext keys.

If this repository is or may become public, you must rewrite history:

```bash
# BACKUP FIRST
git bundle create ../trading-backup-$(date +%Y%m%d).bundle --all

# Install git-filter-repo if needed
pip install git-filter-repo

# Remove the session files from ALL history
git filter-repo --path .claude/sessions/ --invert-paths --force
git filter-repo --path .claude/agent-log.md --invert-paths --force

# Force-push (coordinate with all collaborators first)
git push origin master --force-with-lease
```

> **Warning:** `git filter-repo` rewrites all commit SHAs. Collaborators must
> re-clone or reset their local branches. Do this during a maintenance window.

If the repository is private and will remain private, you can defer the history
rewrite — but you should still rotate the keys today (the leak is the credential
being valid, not just the history containing it).

---

## After Rotation

- [ ] Verify all Railway services pass health checks
- [ ] Confirm old keys are inactive (test each API with the old key — expect 401/403)
- [ ] Run `git log --all --oneline | head -10` to confirm the history rewrite worked (if done)
- [ ] Enable gitleaks pre-commit hook: `npm install --save-dev lefthook && npx lefthook install`
- [ ] Add GitHub Actions CI with `gitleaks detect` on every PR (see `lefthook.yml` for the command)

---

## Files Modified in This PR (security/p0-hardening)

All hardcoded `trading123` fallbacks in tracked scripts have been removed and
replaced with a mandatory env-var read that fails loudly if `DATABASE_URL` is
not set. The session notes are now untracked. A `.env.example` with placeholder
values has been added.

**Scope of this PR (P0 only):**
- Secrets hygiene (gitignore, untrack, remove hardcoded fallbacks)
- Admin bootstrap fix (SEC-18: no longer overwrites on cold start)
- `.env.example` with safe placeholders
- `gitleaks` config + `lefthook` pre-commit config

**Not in scope (P1/P2 backlog):**
- Rate limiting on /api/auth/login (SEC-05)
- CSRF token / Origin check (SEC-07)
- Security headers / CSP (SEC-08)
- Session token format (SEC-03)
- SYNC_SECRET fail-closed (SEC-04) — one-liner, can be done quickly
- Error message redaction (SEC-09)
- Docker USER node (SEC-22)
