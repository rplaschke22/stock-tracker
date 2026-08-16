# Ignition — small/mid cap breakout screener

Daily scan of stockanalysis.com's screener for small/mid-cap growth
names, scored and ranked in a React dashboard (adapted from
`ignition_screener.jsx`).

## Status (2026-08-16)

Repo home: https://github.com/rplaschke22/stock-tracker

| Phase | Status |
|---|---|
| 1. Screener filters (market cap band + sector allowlist) | ✅ Done, verified live |
| 2. StockTwits chatter layer | 🛑 Blocked — see below |
| 3. CSV schema | ✅ Done, verified live |
| 3B. Simulation tab | ⏸️ Waiting on spec — see "2026-08-16 session" below |
| 3C. Analyst consensus (backend columns) | ✅ Done, verified live (frontend display still pending) |
| 4. Dashboard → deployable Vite app | ✅ Done, builds and runs locally with real data |
| 5. Scheduled workflow | ✅ Files written, committed to this repo |
| 6. Deployment | ⏳ Not started — needs your account access (GitHub Pages toggle or Vercel import) |

### 2026-08-16 session

Picked up as a continuation, asked to point at this GitHub repo and add
a Simulation tab + analyst consensus display. Findings, in the order
they came up:

1. **`git clone` of this repo came back completely empty** — no
   commits, no branches. That contradicted "Phases 1-5 are already
   built and verified" here specifically. What actually happened: that
   work was built and verified locally in a prior session, but was
   never pushed, because that environment had no GitHub credentials
   (same blocker as Phase 6 below). This session copied that verified
   local work into this repo and committed it here — see the earlier
   sections of this README for what Phases 1-5 actually are.
2. **The two files mentioned as attached (updated `ignition_screener.jsx`
   and a Phase 3B/3C instructions doc) didn't come through** — nothing
   new on disk, nothing in the conversation. Phase 3B (the Simulation
   tab, `simulation-log.json`) needs "the exact schema and rules" from
   that missing document, so it wasn't built - fabricating a schema
   would risk building the wrong thing. Still waiting on that content.
3. **Phase 3C (analyst consensus) was buildable without the missing
   files** — the three columns and their meaning were specified
   directly in chat, and it only needed real-site verification, the
   same way the screener's structure was checked in Phase 1. Done, see
   below.
4. **Frontend display of the new analyst columns is not done yet** —
   that's part of the same `ignition_screener.jsx` update that didn't
   come through (Step 2), so `App.jsx` still only shows Ignition's
   technical score. The CSV already has the data; wiring it into the
   UI is a small, fast follow-up once that file arrives.
5. **Deployment (Phase 6) is still blocked** on the same thing as
   before: this environment has no `gh` CLI and no stored GitHub
   credentials, so nothing could actually be pushed to
   `rplaschke22/stock-tracker`, and no Pages/Vercel setup could be
   completed. Everything is committed locally, ready to push - see
   "What's left" at the bottom.

#### Phase 3C — analyst consensus data (done)

Checked `stockanalysis.com/stocks/{ticker}/forecast/` (there's also a
near-duplicate `/ratings/` page under the same nav; `/forecast/` was
used since it has rating, count, and price target together) before
writing any parsing logic, same as the screener in Phase 1. It renders
a plain sentence, not a JS-hydrated data blob like the screener:

> "According to 46 analysts polled by S&P Global, Apple stock has a
> consensus rating of "Buy" and an average price target of $322.28."

Verified against 8 real screener candidates (HTFL, ABCL, NVTS, NN,
BILL, DOCS, CSQR, XNDU) plus AAPL for a sanity check — stable format
across mega and small caps.

**What didn't match expectations, flagging same as the screener
finding in Phase 1**: tickers with no analyst coverage don't get an
empty-state message on this page — the page **404s entirely**.
Confirmed against two real tickers from this screener's own candidate
pool (AUDC, VUZI). `get_analyst_data()` in `stock_scanner.py` treats a
404 as "no coverage" and returns `None` for all three fields rather
than raising, so the CSV row just has blank AnalystRating/
AnalystCount/PriceTarget for those tickers rather than failing the run.

`Ticker, Date, Open, High, Low, Close, Volume, Chatter, AnalystRating,
AnalystCount, PriceTarget` — verified with a full 40-ticker run,
2026-08-16 (all 40 happened to have coverage; the 404 path was
verified separately against AUDC/VUZI).

## Phase 1 — screener filters

`stock_scanner.py` filters stockanalysis.com's screener (fetched from
the page's embedded hydration JSON, not an HTML table — see the long
comment at the top of the file for why) to:

- Market cap: $250M–$5B
- Price: under $50
- Industry allowlist mapped from your sector list — **stockanalysis.com
  has no single field that matches your bucket names exactly**, so
  this is a documented, editable allowlist in `stock_scanner.py`
  (`INDUSTRY_ALLOWLIST`), verified against the site's own sector/industry
  taxonomy on 2026-08-15. Notable judgment calls, all called out inline
  in the code:
  - "Healthcare Technology" → mapped to stockanalysis.com's "Health
    Information Services" (closest match, no exact name on their site).
  - "Clean/Renewable Energy" → "Solar" (their own Technology sector) +
    "Utilities - Renewable" (an explicit carve-out from your Utilities
    exclusion, since you asked for renewable energy by name).
  - "Electric Vehicles" → "Auto Manufacturers" is the closest available
    industry (no EV-specific code exists on the site); this also nets
    non-EV automakers, though the $5B cap ceiling limits that in practice.
  - Hydrogen/fuel-cell/grid-tech names (e.g. PLUG, AMSC) are classified
    as Industrials on this site and are **not** included — flag if you
    want that changed.

**Test run, 2026-08-15**: 5,610 stocks screened → 502 pass all filters →
top 40 by market cap written to the CSV. Spot-checked output is clean
small/mid-cap growth names (biotech, software, semiconductors, health
IT) — no mega-caps, no financials/energy/telecom/utilities/staples
slipped through.

## Phase 2 — chatter layer: BLOCKED

Before writing any code, `stocktwits.com/robots.txt` and
`stocktwits.com/terms` were reviewed the same way stockanalysis.com's
were before Phase 1.

- **robots.txt**: doesn't block a generic user agent from individual
  symbol pages.
- **Terms of Use, Section 5 ("No Unauthorized Managed, Automated, or
  Scraping Access")**: explicitly prohibits it —
  > "scrape, harvest, mirror, frame, deep-link to, data-mine, or
  > otherwise extract data or content from the Service by automated
  > means except as expressly authorized by us in writing or through
  > an approved API"

  Their API isn't accepting new registrations, so there's no approved
  path available. This is a real contractual prohibition, not just
  silence (stockanalysis.com's terms were silent on automation, which
  is why Phase 1 was fine). **I did not build a scraper against
  StockTwits.**

`chatter.py` has a documented placeholder (`get_chatter_level()`,
always returns `"normal"`) so the rest of the pipeline works
end-to-end. Options when you're back, your call:
1. Wait for StockTwits API registration to reopen / request written
   permission.
2. Swap in a different activity data source with terms that actually
   allow this (e.g. Reddit's read-only API — would need its own
   robots.txt/ToS check first).
3. Knowingly accept the ToS risk and have this built anyway — that's
   a decision for you to make explicitly.

## Phase 3 — CSV schema

`data/latest.csv` (default; the workflow points this at
`frontend/public/data/latest.csv` — see Phase 5): `Ticker, Date, Open,
High, Low, Close, Volume, Chatter, AnalystRating, AnalystCount,
PriceTarget` (last three added 2026-08-16, see Phase 3C below), one
row per ticker per day, `Chatter`/analyst fields repeat the same value
across a ticker's rows (snapshot, not historical). Verified: 1,191
rows / 40 tickers / exact column match, re-run 2026-08-16 with the new
columns.

## Phase 3C — analyst consensus data

See the "2026-08-16 session" writeup near the top of this README for
the full investigation (real page structure, the 404-on-no-coverage
edge case, verification tickers). Summary: `get_analyst_data()` in
`stock_scanner.py` scrapes `stockanalysis.com/stocks/{ticker}/forecast/`
for consensus rating, analyst count, and average price target, and is
wired into the daily CSV. **Not yet done**: displaying these fields in
the dashboard — that's part of the `ignition_screener.jsx` update
that's still pending (see Phase 3B/3C frontend note above).

## Phase 4 — dashboard

`frontend/` is a Vite + React app built from `ignition_screener.jsx`
with the scoring logic, weight sliders, and detail chart untouched.
Additions (additive, not a redesign):
- **Top 5 hero cards** above the ranked table.
- **Chatter badges** — deliberately styled in a separate blue/gray
  palette from the amber/red score colors, with their own legend panel
  and an explicit "context only, not part of the score" note in both
  the table and the detail panel.
- **Auto-load on mount**: fetches `data/latest.csv` (relative to the
  deployed site) instead of requiring a manual upload. Manual
  upload/sample-data buttons are kept as a fallback if that fetch 404s
  (e.g. before the first scheduled run has ever committed data).

Verified locally 2026-08-15: `npm run dev` and `npm run build` both
succeed; the built `dist/` bundles `data/latest.csv`; loaded the real
40-ticker scan from disk in the browser and confirmed the top-5 cards,
ranked table, chatter column/badges, detail chart, and weight sliders
all render and update correctly.

## Phase 5 — scheduled workflow

`.github/workflows/daily-scan.yml`: runs weekdays at 12:30 UTC
(adjust the cron if you want a different time) and via the manual "Run
workflow" button, installs `requirements.txt`, runs
`python stock_scanner.py --out frontend/public/data/latest.csv`, and
commits the result back to the repo.

**Committed locally to this repo (`~/stock-tracker` in the dev
environment) but not pushed** — this environment still has no `gh`
CLI and no stored GitHub credentials, so it can't authenticate a push
to `github.com/rplaschke22/stock-tracker` even though the remote now
exists (confirmed empty via `git clone`, see the top of this README).
When you're back, from a machine/shell that has your GitHub auth:

```bash
cd ~/stock-tracker   # or wherever you have this repo checked out
git remote add origin https://github.com/rplaschke22/stock-tracker.git  # if not already set
git push -u origin main
```

Then in the repo's GitHub settings: **Settings → Actions → General →
Workflow permissions → "Read and write permissions"** (required for
`daily-scan.yml` to commit results back).

## Phase 6 — deployment

Two deploy targets are pre-configured, pick one:

- **GitHub Pages** (`.github/workflows/deploy-pages.yml`, already
  written): rebuilds and redeploys on every push to `main`, including
  the daily scan's commit. Needs: Settings → Pages → Source = "GitHub
  Actions" (one-time, in the GitHub UI).
- **Vercel** (`vercel.json`, already written): import the repo in the
  Vercel dashboard, it picks up `vercel.json` automatically and
  redeploys on every push, no extra workflow needed. Simpler if you'd
  rather not manage a second Actions workflow.

Neither is deployed yet — both need your account access (GitHub Pages
toggle or Vercel's "Import Project" flow), which isn't something I can
click through without you.

Once deployed: use the "Run workflow" button under the Actions tab to
trigger a full end-to-end run, then confirm the live URL shows that
run's real top-5 candidates (not placeholder/sample data) before
trusting the schedule.

## Local development

```bash
# Scanner
pip install -r requirements.txt
python stock_scanner.py --out frontend/public/data/latest.csv

# Frontend
cd frontend
npm install
npm run dev      # http://localhost:5173, auto-loads data/latest.csv
npm run build    # production build in frontend/dist/
```
