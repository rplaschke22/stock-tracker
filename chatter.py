"""
Chatter layer (Phase 2) - BLOCKED pending a decision, see README.md.

Before writing any scraping code, stocktwits.com's robots.txt and Terms
of Use were reviewed (2026-08-15), the same way stockanalysis.com's
were reviewed before Phase 1:

  - robots.txt (https://stocktwits.com/robots.txt) does not block a
    generic user agent from individual symbol/discussion pages.
  - The Terms of Use (https://stocktwits.com/terms), Section 5 "No
    Unauthorized Managed, Automated, or Scraping Access", explicitly
    prohibits it:

        "scrape, harvest, mirror, frame, deep-link to, data-mine, or
        otherwise extract data or content from the Service by
        automated means except as expressly authorized by us in
        writing or through an approved API"

    Their official API is not currently accepting new registrations,
    so there is no "approved API" path available right now, and no
    written authorization has been sought. That makes this different
    from stockanalysis.com, whose Terms of Use were silent on
    automated access - here it's an explicit contractual prohibition.

Given that, this module does NOT contain any code that fetches data
from stocktwits.com. get_chatter_level() below is a placeholder that
always returns "normal" so the rest of the pipeline (CSV schema,
dashboard chatter badges) can be built and tested end-to-end. Swap in
a real implementation only once one of these is true:

  1. StockTwits reopens API registration and you get a key, or
  2. You get written permission from StockTwits for this use, or
  3. You pick a different chatter/activity data source with terms
     that actually allow automated reads (e.g. Reddit's read-only API
     under its own developer terms - would need its own robots.txt/ToS
     review first, same as this one), or
  4. You knowingly decide to accept the ToS risk yourself and want
     this built anyway - that's your call to make explicitly, not
     something to default into.
"""

from __future__ import annotations

CHATTER_LEVELS = ("elevated", "normal", "low")


def get_chatter_level(ticker: str) -> str:
    """
    Placeholder chatter signal. Always returns "normal" - see the
    module docstring for why real StockTwits data isn't wired in.
    """
    return "normal"


def get_chatter_levels(tickers) -> dict:
    """Bulk convenience wrapper around get_chatter_level()."""
    return {t: get_chatter_level(t) for t in tickers}
