# Trading — Deployment Instructions

## Quick Start (Local Development)

```bash
npm install
npm run dev
```

## Build Command

```bash
npm run build   # next build
```

## Deploy Target

| Field       | Value                          |
|-------------|--------------------------------|
| Platform    | Not deployed (local only)      |
| URL         | N/A                            |
| Branch      | master                         |

## Environment Variables (names only)

Check `.env.local` for required variables. Typical:
- Database connection strings
- API keys for data providers

## Verification Steps

1. Local build: `npm run build` (should complete without errors)
2. Dev server: `npm run dev` then visit http://localhost:3000

## Troubleshooting

- **SWC lockfile warning**: Run `npm install` twice to patch lockfile
- **Multiple lockfile warning**: Add `turbopack.root` to `next.config.ts` to suppress

## Last Verified

- **Date**: 2026-04-09
- **Build**: PASSES (Next.js 16.1.6, 29 static pages)
- **Deploy**: NOT DEPLOYED (local development only)
