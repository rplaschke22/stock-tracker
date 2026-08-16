"""
Breakout candidate scanner - pulls screener results and price history
from stockanalysis.com, tags each candidate with a StockTwits chatter
level, and writes a CSV formatted for the Ignition dashboard.

STATUS: verified against the live site on 2026-08-16 (analyst data
added; screener/history verified 2026-08-15, re-checked below).

robots.txt (https://stockanalysis.com/robots.txt) disallows only /e/
and /p/ for a generic user agent; /screener/, /stocks/*/history/, and
/stocks/*/forecast/ (analyst data, added 2026-08-16) are not blocked.
The Terms of Use prohibit republishing full site content without
permission but say nothing about automated/programmatic access; this
script only extracts numeric OHLCV/screener/analyst fields (not
editorial content) and rate-limits itself.

StockTwits (see fetch_chatter.py / README for the robots.txt + ToS
review) is used read-only, unauthenticated, for a rough activity count
only - not a sentiment score. See CHATTER section below and README.md
for the reasoning.

Site markup (and the shape of the embedded JSON blob the screener page
ships for client-side hydration) changes over time, so this needs to be
checked periodically, not treated as fire and forget.

Requirements:
    pip install -r requirements.txt

Output:
    breakout-scan-YYYY-MM-DD.csv with columns:
    Ticker, Date, Open, High, Low, Close, Volume, Chatter,
    AnalystRating, AnalystCount, PriceTarget
"""

import io
import os
import re
import sys
import time
import datetime
import requests
import pandas as pd

from chatter import get_chatter_level

# ---------------------------------------------------------------------
# Filters (Phase 1)
# ---------------------------------------------------------------------
MARKET_CAP_MIN = 250_000_000
MARKET_CAP_MAX = 5_000_000_000  # keeps mega caps out even if sector tagging is fuzzy
PRICE_MAX = 50.0
LOOKBACK_DAYS = 30
TOP_N = 40
REQUEST_DELAY_SECONDS = 1.5  # be polite, do not hammer the site

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; personal-research-script/1.0)"
}

SCREENER_URL = "https://stockanalysis.com/screener/"
STOCK_HISTORY_URL_TEMPLATE = "https://stockanalysis.com/stocks/{ticker}/history/"
STOCK_FORECAST_URL_TEMPLATE = "https://stockanalysis.com/stocks/{ticker}/forecast/"

# stockanalysis.com's /stocks/{ticker}/forecast/ page (confirmed live,
# 2026-08-16; also has a near-duplicate /ratings/ page under the same
# nav, forecast/ was used since it has consensus rating, count, and
# price target together) renders analyst consensus as a plain sentence,
# not a JS-hydrated data blob like the screener:
#   "According to 46 analysts polled by S&P Global, Apple stock has a
#   consensus rating of "Buy" and an average price target of $322.28."
# Verified against 8 real screener candidates (HTFL, ABCL, NVTS, NN,
# BILL, DOCS, CSQR, XNDU) plus AAPL - format is stable across mega and
# small caps. IMPORTANT edge case found while verifying: tickers with
# no analyst coverage at all (checked AUDC, VUZI - both real small caps
# from this screener's own candidate pool) don't get a "no analysts"
# message, they simply 404 on /forecast/ entirely. Handled below by
# returning Nones rather than raising.
ANALYST_SENTENCE_RE = re.compile(
    r'According to (?P<count>\d+) analysts? polled by [^,]+, .*? has a '
    r'consensus rating of "(?P<rating>[^"]+)" and an average price '
    r'target of \$(?P<target>[\d,]+(?:\.\d+)?)'
)

# stockanalysis.com's screener embed exposes "industry" (GICS-style
# sub-industry, e.g. "Semiconductors") not "sector" (the broader group,
# e.g. "Technology"). There's no single filter that maps directly onto
# the requested sector list, so this is an explicit industry allowlist,
# checked against https://stockanalysis.com/stocks/industry/ (the
# site's canonical industry list) and spot-verified against individual
# stock pages (which show both Sector and Industry) on 2026-08-15:
#
#   Requested bucket          -> stockanalysis.com industry/industries
#   -----------------------------------------------------------------
#   Technology (sector)       -> Software - Application,
#                                 Software - Infrastructure,
#                                 Information Technology Services,
#                                 Computer Hardware,
#                                 Communication Equipment,
#                                 Electronic Components,
#                                 Scientific & Technical Instruments,
#                                 Consumer Electronics
#                                 (this is most of stockanalysis.com's
#                                 "Technology" sector; excludes
#                                 "Electronics & Computer Distribution",
#                                 a low-margin reseller business, not a
#                                 growth story)
#   Semiconductors             -> Semiconductors,
#                                 Semiconductor Equipment & Materials
#   Software/Internet Services -> (Software - * above, plus)
#                                 Internet Content & Information
#                                 (Communication Services sector on this
#                                 site, but clearly "internet services")
#   Biotechnology               -> Biotechnology
#   Healthcare Technology       -> Health Information Services
#                                 (stockanalysis.com has no industry
#                                 literally named "Healthcare
#                                 Technology"; Health Information
#                                 Services - health IT/data/software
#                                 companies - is the closest match,
#                                 verified via spot checks)
#   Clean/Renewable Energy      -> Solar (verified: sector "Technology"
#                                 on this site, e.g. FSLR, ENPH),
#                                 Utilities - Renewable (verified:
#                                 sector "Utilities", e.g. NEP, ORA -
#                                 an explicit carve-out from the
#                                 Utilities exclusion below, since the
#                                 brief calls for renewable energy by
#                                 name)
#   Electric Vehicles            -> Auto Manufacturers (verified: sector
#                                 "Consumer Discretionary", e.g. TSLA,
#                                 RIVN). stockanalysis.com has no
#                                 EV-specific industry code, so this is
#                                 a proxy - it also nets non-EV
#                                 automakers, but combined with the
#                                 $5B market-cap ceiling this mostly
#                                 leaves smaller EV-focused names in
#                                 practice.
#
# Explicitly NOT covered even though "clean energy" adjacent in name:
# hydrogen/fuel-cell and grid-tech names such as PLUG and AMSC are
# classified by the site under Industrials (Electrical Equipment &
# Parts / Specialty Industrial Machinery), so they fall outside this
# allowlist. Flag to revisit if that's a gap you care about.
INDUSTRY_ALLOWLIST = {
    "Software - Application",
    "Software - Infrastructure",
    "Information Technology Services",
    "Computer Hardware",
    "Communication Equipment",
    "Electronic Components",
    "Scientific & Technical Instruments",
    "Consumer Electronics",
    "Semiconductors",
    "Semiconductor Equipment & Materials",
    "Internet Content & Information",
    "Biotechnology",
    "Health Information Services",
    "Solar",
    "Utilities - Renewable",
    "Auto Manufacturers",
}

# The screener page (https://stockanalysis.com/screener/) is a SvelteKit
# app. Its server-rendered HTML only contains a static <table> with the
# default view (top ~20 stocks by market cap, unfiltered) - pd.read_html
# against that table can never see the rest of the ~5600 listed stocks,
# and the site does not honor filter query params server-side. The full
# dataset is instead embedded as a JS object literal (not quite valid
# JSON - unquoted keys, bare numbers) in a hydration <script> tag, e.g.:
#   {type:"data",data:{count:5610,data:[{s:"NVDA",n:"NVIDIA Corporation",
#   marketCap:5453493459661,price:225.16,change:-.06,
#   industry:"Semiconductors",volume:75694928,peRatio:34.48},...]}}
# So we regex that blob out directly instead of parsing an HTML table.
SCREENER_RECORD_RE = re.compile(
    r'\{s:"(?P<ticker>[^"]*)",n:"(?P<name>(?:[^"\\]|\\.)*)",'
    r'marketCap:(?P<market_cap>null|-?[\d.]+),'
    r'price:(?P<price>null|-?[\d.]+),'
    r'change:(?P<change>null|-?[\d.]+),'
    r'industry:(?:"(?P<industry>(?:[^"\\]|\\.)*)"|null),'
    r'volume:(?P<volume>null|-?[\d.]+),'
    r'peRatio:(?:null|-?[\d.]+)\}'
)


def get_screener_candidates(verbose=False):
    """Pull the screener page and filter for market cap, price, and sector."""
    resp = requests.get(SCREENER_URL, headers=HEADERS, timeout=20)
    resp.raise_for_status()

    matches = list(SCREENER_RECORD_RE.finditer(resp.text))
    if not matches:
        raise RuntimeError(
            "Could not find embedded screener data in the page - "
            "stockanalysis.com's markup/hydration format likely changed."
        )

    df = pd.DataFrame(
        {
            "Ticker": m.group("ticker"),
            "Name": m.group("name"),
            "Price": _to_float(m.group("price")),
            "MarketCap": _to_float(m.group("market_cap")),
            "Industry": m.group("industry"),
        }
        for m in matches
    )

    if verbose:
        print(f"  Screener returned {len(df)} total listed stocks.")

    filtered = df[
        (df["MarketCap"] >= MARKET_CAP_MIN)
        & (df["MarketCap"] <= MARKET_CAP_MAX)
        & (df["Price"] <= PRICE_MAX)
        & (df["Industry"].isin(INDUSTRY_ALLOWLIST))
    ]
    # Keep highest market cap first among qualifying candidates.
    filtered = filtered.sort_values("MarketCap", ascending=False)

    if verbose:
        print(f"  {len(filtered)} candidates pass market cap + price + sector filters.")

    return filtered.head(TOP_N)[["Ticker", "Name", "Price", "MarketCap", "Industry"]].reset_index(drop=True)


def _to_float(value):
    return None if value == "null" else float(value)


def get_price_history(ticker):
    """
    Pull daily OHLCV history for one ticker.

    Verified 2026-08-15: /stocks/{ticker}/history/ still server-renders a
    plain <table> (Date, Open, High, Low, Close, Adj. Close, Change,
    Volume) that pd.read_html can parse directly - unlike the screener,
    no client-side hydration workaround is needed here.
    """
    url = STOCK_HISTORY_URL_TEMPLATE.format(ticker=ticker.lower())
    resp = requests.get(url, headers=HEADERS, timeout=20)
    resp.raise_for_status()

    tables = pd.read_html(io.StringIO(resp.text))
    if not tables:
        return None

    df = tables[0]
    df.columns = [str(c).strip() for c in df.columns]

    rename_map = {}
    for c in df.columns:
        lc = c.lower()
        if lc == "date":
            rename_map[c] = "Date"
        elif lc == "open":
            rename_map[c] = "Open"
        elif lc == "high":
            rename_map[c] = "High"
        elif lc == "low":
            rename_map[c] = "Low"
        elif lc in ("close", "close/last"):
            rename_map[c] = "Close"
        elif lc == "volume":
            rename_map[c] = "Volume"
    df = df.rename(columns=rename_map)

    required = {"Date", "Open", "High", "Low", "Close", "Volume"}
    if not required.issubset(df.columns):
        print(f"  [skip] {ticker}: missing columns, got {df.columns.tolist()}", file=sys.stderr)
        return None

    df = df[list(required)].head(LOOKBACK_DAYS).copy()
    df["Ticker"] = ticker
    return df[["Ticker", "Date", "Open", "High", "Low", "Close", "Volume"]]


def get_analyst_data(ticker):
    """
    Pull consensus analyst rating, analyst count, and average price
    target for one ticker from stockanalysis.com's /forecast/ page.

    Returns (rating, count, price_target) - each None if the ticker has
    no analyst coverage (the page 404s rather than showing an empty
    state; verified against real small caps AUDC and VUZI, both from
    this screener's own candidate pool) or the page format doesn't
    match what's expected.
    """
    url = STOCK_FORECAST_URL_TEMPLATE.format(ticker=ticker.lower())
    resp = requests.get(url, headers=HEADERS, timeout=20)
    if resp.status_code == 404:
        return None, None, None
    resp.raise_for_status()

    m = ANALYST_SENTENCE_RE.search(resp.text)
    if not m:
        print(f"  [warn] {ticker}: forecast page found but consensus sentence didn't match - "
              f"stockanalysis.com's analyst page format may have changed.", file=sys.stderr)
        return None, None, None

    rating = m.group("rating")
    count = int(m.group("count"))
    target = float(m.group("target").replace(",", ""))
    return rating, count, target


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default="data/latest.csv",
        help="Stable path the frontend fetches on load (default: data/latest.csv).",
    )
    parser.add_argument(
        "--no-archive",
        action="store_true",
        help="Skip writing the dated breakout-scan-YYYY-MM-DD.csv archive copy.",
    )
    args = parser.parse_args()

    print("Pulling screener candidates...")
    candidates = get_screener_candidates(verbose=True)
    print(f"Found {len(candidates)} candidates matching market cap, price, and sector filters:")
    print(candidates.to_string(index=False))

    tickers = candidates["Ticker"].tolist()

    all_rows = []
    for i, ticker in enumerate(tickers, 1):
        print(f"  [{i}/{len(tickers)}] {ticker}")
        try:
            hist = get_price_history(ticker)
            if hist is not None:
                # Chatter and analyst fields are snapshots (not daily
                # historical figures) - the same value repeats across
                # all of a ticker's rows. See chatter.py for why Chatter
                # is currently a placeholder rather than live StockTwits
                # data, and get_analyst_data() for the stockanalysis.com
                # /forecast/ page the analyst fields are scraped from.
                hist["Chatter"] = get_chatter_level(ticker)

                time.sleep(REQUEST_DELAY_SECONDS)
                rating, count, target = get_analyst_data(ticker)
                hist["AnalystRating"] = rating
                hist["AnalystCount"] = count
                hist["PriceTarget"] = target

                all_rows.append(hist)
        except Exception as e:
            print(f"  [error] {ticker}: {e}", file=sys.stderr)
        time.sleep(REQUEST_DELAY_SECONDS)

    if not all_rows:
        print("No data collected, aborting write.", file=sys.stderr)
        sys.exit(1)

    result = pd.concat(all_rows, ignore_index=True)
    result = result[[
        "Ticker", "Date", "Open", "High", "Low", "Close", "Volume", "Chatter",
        "AnalystRating", "AnalystCount", "PriceTarget",
    ]]

    out_path = args.out
    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    result.to_csv(out_path, index=False)
    print(f"Saved {out_path} ({len(result)} rows, {result['Ticker'].nunique()} tickers)")

    if not args.no_archive:
        archive_dir = os.path.join(out_dir, "archive") if out_dir else "archive"
        os.makedirs(archive_dir, exist_ok=True)
        archive_path = os.path.join(archive_dir, f"breakout-scan-{datetime.date.today().isoformat()}.csv")
        result.to_csv(archive_path, index=False)
        print(f"Archived {archive_path}")


if __name__ == "__main__":
    main()
