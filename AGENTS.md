# Trading

## Session Start Protocol

1. Read `.claude/deploy-instructions.md` for deployment details
2. Read this full `AGENTS.md` for project rules and conventions
3. Read `.claude/SYSTEM.md` — system model, table relationships, API cheatsheet, gotchas from prior sessions. This is the single place to skim before touching paper-trading / matrix / surveillance code
4. Skim top 3 entries of `.claude/agent-log.md` for recent context
5. Report to user: "I've read the deployment instructions, system manual, and all important notices for **trading**. Deploy target: Railway (web + worker + MySQL). Local dev still uses VPS MySQL via SSH tunnel. Last verified: 2026-04-21. Build status: OK."
6. Run `git status` and report current branch and any uncommitted changes

---

## Project Structure

- Next.js 16.2.3 trading/analysis platform
- Default branch: `master`
- Two runtime environments:
  - **Local dev** — Next.js + `.env.local` + SSH tunnel to VPS MySQL on `localhost:3319` (see `scripts/tunnel-db.sh`)
  - **Production** — Railway project `TRADING` with 3 services: `web`, `worker`, `MySQL`. Public URL: `trading-production-06fe.up.railway.app`

## Production DB recovery

If Railway's MySQL is ever wiped or drifts, the VPS MySQL at `89.167.42.128:3320` (inside `docker-mysql-1`) is the accumulating source of truth for `reversal_entries`, `paper_signals`, `paper_position_prices`, `paper_trades`, `paper_orders`, `surveillance_logs`, `surveillance_failures`, `paper_strategies`. Restore playbook: `scripts/railway-restore-prelude.sql` + VPS `mysqldump --no-create-info` of those 8 tables, piped through `docker run --rm -i mysql:8.0 mysql` against the Railway public proxy.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
