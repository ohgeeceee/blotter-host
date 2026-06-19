#!/usr/bin/env python3
"""
blotter.host News Source Discovery Agent
========================================

Finds local news-station RSS feeds and homepages for a given U.S. state,
validates them, and proposes additions to the blotter-host news_sources table.

Usage:
    ./venv/bin/python discover.py --state idaho
    ./venv/bin/python discover.py --state Idaho --propose
    ./venv/bin/python discover.py --state Montana --output proposed.json

The agent does not write to the control DB unless --propose is passed.
Without --propose it prints a JSON preview to stdout.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sqlite3
import sys
import urllib.parse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

import feedparser
import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CONTROL_DB_PATH = "/root/blotter-host/data/control.db"
USER_AGENT = "blotter.host news-source discovery agent"
REQUEST_TIMEOUT = 20
SEARCH_RESULTS = 10

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
logger = logging.getLogger("news-source-discovery")


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class DiscoveredSource:
    state_slug: str
    source_name: str
    source_url: str
    source_type: str
    strategy: str
    confidence: str  # 'high', 'medium', 'low'
    reason: str
    sample_title: str | None = None
    sample_date: str | None = None


# ---------------------------------------------------------------------------
# State names
# ---------------------------------------------------------------------------

STATE_NAMES: dict[str, str] = {
    "al": "Alabama", "ak": "Alaska", "az": "Arizona", "ar": "Arkansas",
    "ca": "California", "co": "Colorado", "ct": "Connecticut", "de": "Delaware",
    "fl": "Florida", "ga": "Georgia", "hi": "Hawaii", "id": "Idaho",
    "il": "Illinois", "in": "Indiana", "ia": "Iowa", "ks": "Kansas",
    "ky": "Kentucky", "la": "Louisiana", "me": "Maine", "md": "Maryland",
    "ma": "Massachusetts", "mi": "Michigan", "mn": "Minnesota", "ms": "Mississippi",
    "mo": "Missouri", "mt": "Montana", "ne": "Nebraska", "nv": "Nevada",
    "nh": "New Hampshire", "nj": "New Jersey", "nm": "New Mexico", "ny": "New York",
    "nc": "North Carolina", "nd": "North Dakota", "oh": "Ohio", "ok": "Oklahoma",
    "or": "Oregon", "pa": "Pennsylvania", "ri": "Rhode Island", "sc": "South Carolina",
    "sd": "South Dakota", "tn": "Tennessee", "tx": "Texas", "ut": "Utah",
    "vt": "Vermont", "va": "Virginia", "wa": "Washington", "wv": "West Virginia",
    "wi": "Wisconsin", "wy": "Wyoming", "dc": "District of Columbia",
}


def state_name(slug: str) -> str:
    return STATE_NAMES.get(slug.lower(), slug.title())


# ---------------------------------------------------------------------------
# Existing sources from control DB
# ---------------------------------------------------------------------------

def ensure_news_sources_table(db_path: str) -> None:
    """Create the news_sources table if it does not already exist."""
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS news_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            state_slug TEXT NOT NULL,
            source_name TEXT NOT NULL,
            source_url TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'rss',
            strategy TEXT NOT NULL DEFAULT 'rssBulletin',
            is_enabled INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 100,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_sources_state ON news_sources(state_slug)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_news_sources_enabled ON news_sources(is_enabled)")
    conn.commit()
    conn.close()


def load_existing_sources(db_path: str, state_slug: str | None = None) -> set[str]:
    """Return normalized URLs already in the news_sources table."""
    existing: set[str] = set()
    try:
        ensure_news_sources_table(db_path)
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        if state_slug:
            cursor.execute(
                "SELECT source_url FROM news_sources WHERE state_slug = ?",
                (state_slug.lower(),),
            )
        else:
            cursor.execute("SELECT source_url FROM news_sources")
        for row in cursor.fetchall():
            existing.add(normalize_url(row[0]))
        conn.close()
    except sqlite3.Error as exc:
        logger.warning("Could not read control DB (%s): %s", db_path, exc)
    return existing


def normalize_url(url: str) -> str:
    parsed = urllib.parse.urlparse(str(url).lower().strip())
    netloc = parsed.netloc.replace("www.", "")
    path = parsed.path.rstrip("/")
    return f"{netloc}{path}"


# ---------------------------------------------------------------------------
# Search & discovery
# ---------------------------------------------------------------------------

def search_duckduckgo(query: str, limit: int = SEARCH_RESULTS) -> list[str]:
    """Fetch DuckDuckGo lite results and return candidate URLs."""
    urls: list[str] = []
    try:
        params = {"q": query, "kl": "us-en"}
        resp = requests.get(
            "https://duckduckgo.com/html/",
            params=params,
            headers={"User-Agent": USER_AGENT},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        for a in soup.select("a.result__a")[:limit]:
            href = a.get("href")
            if href:
                urls.append(urllib.parse.urljoin("https://duckduckgo.com/", href))
    except Exception as exc:
        logger.warning("DuckDuckGo search failed: %s", exc)
    return urls


def discover_candidate_homepages(state_slug: str) -> list[tuple[str, str]]:
    """
    Return list of (homepage_url, source_name_hint) candidates.
    Tries Wikipedia's "List of newspapers in <State>" first, then falls back
    to a DuckDuckGo web search if the page is unavailable or empty.
    """
    state = state_name(state_slug)
    candidates: list[tuple[str, str]] = []
    seen: set[str] = set()

    # Primary source: Wikipedia list of newspapers in the state.
    wiki_url = f"https://en.wikipedia.org/wiki/List_of_newspapers_in_{state.replace(' ', '_')}"
    status, _content_type, html = fetch_page(wiki_url)
    if status == 200 and html:
        soup = BeautifulSoup(html, "html.parser")
        for table in soup.find_all("table", {"class": "wikitable"}):
            # Try to locate a Website column index.
            header_row = table.find("tr")
            website_index: int | None = None
            if header_row:
                headers = [th.get_text(strip=True).lower() for th in header_row.find_all(["th", "td"])]
                for idx, h in enumerate(headers):
                    if "website" in h or "url" in h or "link" in h:
                        website_index = idx
                        break

            for row in table.find_all("tr")[1:]:
                cells = row.find_all(["td", "th"])
                if len(cells) < 2:
                    continue
                name_cell = cells[0]
                link = name_cell.find("a", href=True)
                title = link.get_text(strip=True) if link else name_cell.get_text(strip=True)
                if not title or title.startswith("["):
                    continue

                homepage: str | None = None
                if website_index is not None and website_index < len(cells):
                    website_cell = cells[website_index]
                    website_link = website_cell.find("a", {"class": "external"}, href=True)
                    if website_link:
                        homepage = normalize_homepage(website_link["href"])

                if not homepage and link:
                    # No website column; follow the article page to find the official URL.
                    article_url = urllib.parse.urljoin("https://en.wikipedia.org/", link["href"])
                    homepage = resolve_wikipedia_external_url(article_url)

                if not homepage or homepage in seen:
                    continue
                if not looks_like_news_domain(homepage):
                    continue
                seen.add(homepage)
                candidates.append((homepage, title))
                if len(candidates) >= 12:
                    break
            if len(candidates) >= 12:
                break

    # Fallback to web search if Wikipedia yielded nothing.
    if not candidates:
        queries = [
            f"{state} local news station",
            f"{state} newspaper",
            f"{state} news RSS feed",
        ]
        for query in queries:
            for url in search_duckduckgo(query):
                parsed = urllib.parse.urlparse(url)
                if parsed.scheme not in ("http", "https"):
                    continue
                homepage = f"{parsed.scheme}://{parsed.netloc}"
                if homepage in seen:
                    continue
                seen.add(homepage)
                name_hint = parsed.netloc.replace("www.", "").split(":")[0]
                candidates.append((homepage, name_hint))

    return candidates


def normalize_homepage(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return url
    return f"{parsed.scheme}://{parsed.netloc}"


def looks_like_news_domain(url: str) -> bool:
    """Filter out obvious non-news sites (social, gov, etc.)."""
    parsed = urllib.parse.urlparse(url)
    netloc = parsed.netloc.lower()
    blocked = {
        "facebook.com", "twitter.com", "x.com", "instagram.com",
        "linkedin.com", "youtube.com", "tiktok.com",
        "wikipedia.org", "wikimedia.org",
        "google.com", "bing.com", "yahoo.com",
        "worldcat.org", "issn.org", "loc.gov",
    }
    for bad in blocked:
        if bad in netloc:
            return False
    return True


def resolve_wikipedia_external_url(article_url: str) -> str | None:
    """Follow a Wikipedia article's official website link, if present."""
    status, _content_type, html = fetch_page(article_url, timeout=8)
    if status != 200 or not html:
        return None
    try:
        soup = BeautifulSoup(html, "html.parser")
        for a in soup.find_all("a", {"class": "external"}, href=True):
            href = a["href"]
            title = (a.get("title") or "").lower()
            text = (a.get_text(strip=True) or "").lower()
            if "official" in title or "official" in text:
                return href
        infobox = soup.find("table", {"class": "infobox"})
        if infobox:
            for a in infobox.find_all("a", {"class": "external"}, href=True):
                return a["href"]
    except Exception as exc:
        logger.debug("Could not resolve Wikipedia external URL: %s", exc)
    return None


def extract_rss_links(page_url: str, html: str) -> list[tuple[str, str]]:
    """Extract RSS/Atom feed links from a page's <link> tags."""
    feeds: list[tuple[str, str]] = []
    try:
        soup = BeautifulSoup(html, "html.parser")
        for link in soup.find_all("link"):
            rel = " ".join(link.get("rel", [])).lower()
            type_ = (link.get("type") or "").lower()
            href = link.get("href")
            if not href:
                continue
            if "alternate" in rel and (type_ in ("application/rss+xml", "application/atom+xml", "application/feed+json") or "rss" in href.lower()):
                absolute = urllib.parse.urljoin(page_url, href)
                title = link.get("title") or "RSS feed"
                feeds.append((absolute, title))
    except Exception as exc:
        logger.debug("Could not extract feeds from %s: %s", page_url, exc)
    return feeds


COMMON_RSS_PATHS = [
    "/feed",
    "/rss",
    "/feeds/posts/default",
    "/news/feed",
    "/feed/rss",
    "/index.rss",
    "/rss.xml",
    "/atom.xml",
    "/feed.xml",
]


def guess_rss_feeds(homepage: str) -> list[tuple[str, str]]:
    """Generate likely RSS feed URLs from a homepage."""
    feeds: list[tuple[str, str]] = []
    parsed = urllib.parse.urlparse(homepage)
    for p in COMMON_RSS_PATHS:
        feeds.append((urllib.parse.urljoin(homepage, p), "Guessed RSS feed"))
    return feeds


def fetch_page(url: str, timeout: int = REQUEST_TIMEOUT) -> tuple[int, str, str]:
    """Return (status, content_type, text) for a URL."""
    try:
        resp = requests.get(
            url,
            headers={"User-Agent": USER_AGENT},
            timeout=timeout,
            allow_redirects=True,
        )
        return resp.status_code, resp.headers.get("content-type", ""), resp.text
    except Exception as exc:
        logger.debug("Fetch failed for %s: %s", url, exc)
        return 0, "", ""


def validate_rss_feed(url: str) -> tuple[bool, dict[str, Any] | None]:
    """Try to parse the URL as an RSS/Atom feed."""
    try:
        resp = requests.get(
            url,
            headers={"User-Agent": USER_AGENT},
            timeout=10,
            allow_redirects=True,
        )
        if resp.status_code != 200:
            return False, None
        content_type = resp.headers.get("content-type", "").lower()
        if not (content_type.startswith("application/rss") or content_type.startswith("application/atom") or content_type.startswith("application/xml") or content_type.startswith("text/xml") or "rss" in resp.text[:200].lower() or "<feed" in resp.text[:200].lower()):
            return False, None
        parsed = feedparser.parse(resp.text)
        if not parsed.entries:
            return False, None
        latest = parsed.entries[0]
        return True, {
            "title": parsed.feed.get("title") or latest.get("title"),
            "latest_entry": latest.get("title"),
            "latest_date": latest.get("published") or latest.get("updated"),
        }
    except Exception as exc:
        logger.debug("RSS validation failed for %s: %s", url, exc)
        return False, None


def clean_source_name(name: str) -> str:
    """Clean up a source name extracted from Wikipedia or a feed."""
    name = re.sub(r"\s+", " ", str(name)).strip()
    # Strip common SEO suffixes, but only if the result remains meaningful.
    for sep in ("|", " - ", " -- ", ":"):
        if sep in name:
            candidate = name.split(sep, 1)[0].strip()
            if len(candidate) >= 10:
                name = candidate
                break
    return name[:120]


# ---------------------------------------------------------------------------
# Scoring / deduplication
# ---------------------------------------------------------------------------

def score_source(source_type: str, feed_meta: dict[str, Any] | None, is_known_domain: bool = False) -> tuple[str, str]:
    if source_type == "rss" and feed_meta:
        return ("high", "Valid RSS feed with recent entries")
    if source_type == "rss":
        return ("medium", "RSS link found but not validated")
    if is_known_domain:
        return ("medium", "Known news-domain homepage")
    return ("low", "Candidate homepage, no RSS detected")


# ---------------------------------------------------------------------------
# Main discovery pipeline
# ---------------------------------------------------------------------------

def discover(state_slug: str, db_path: str) -> list[DiscoveredSource]:
    state_slug = state_slug.lower().strip()
    existing = load_existing_sources(db_path, state_slug)
    candidates = discover_candidate_homepages(state_slug)
    discovered: list[DiscoveredSource] = []
    seen_urls: set[str] = set()

    for homepage, name_hint in candidates:
        if not looks_like_news_domain(homepage):
            continue

        status, content_type, html = fetch_page(homepage)
        if status != 200 or not html:
            continue

        source_name = clean_source_name(name_hint)
        rss_links = extract_rss_links(homepage, html)
        guessed_links = guess_rss_feeds(homepage)
        all_feeds = rss_links + guessed_links

        best_feed: tuple[str, dict[str, Any] | None] | None = None
        for feed_url, _feed_title in all_feeds:
            norm = normalize_url(feed_url)
            if norm in existing or norm in seen_urls:
                continue
            ok, meta = validate_rss_feed(feed_url)
            if ok and meta:
                best_feed = (feed_url, meta)
                break

        if best_feed:
            feed_url, meta = best_feed
            seen_urls.add(normalize_url(feed_url))
            discovered.append(DiscoveredSource(
                state_slug=state_slug,
                source_name=source_name,
                source_url=feed_url,
                source_type="rss",
                strategy="rssBulletin",
                confidence="high",
                reason="Valid RSS feed with recent entries",
                sample_title=meta.get("latest_entry") if meta else None,
                sample_date=meta.get("latest_date") if meta else None,
            ))
        else:
            # Add as a website source if no working RSS feed found.
            norm = normalize_url(homepage)
            if norm in existing or norm in seen_urls:
                continue
            seen_urls.add(norm)
            discovered.append(DiscoveredSource(
                state_slug=state_slug,
                source_name=source_name,
                source_url=homepage,
                source_type="website",
                strategy="staticBulletin",
                confidence="low",
                reason="Candidate homepage, no working RSS detected",
            ))

    # Sort by confidence then name.
    confidence_rank = {"high": 0, "medium": 1, "low": 2}
    discovered.sort(key=lambda s: (confidence_rank.get(s.confidence, 9), s.source_name.lower()))
    return discovered


# ---------------------------------------------------------------------------
# Propose / persist
# ---------------------------------------------------------------------------

def propose_to_db(sources: list[DiscoveredSource], db_path: str) -> list[dict[str, Any]]:
    """Insert proposed sources with is_enabled=0 for operator review."""
    saved: list[dict[str, Any]] = []
    try:
        ensure_news_sources_table(db_path)
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        for src in sources:
            cursor.execute(
                """
                INSERT INTO news_sources
                (state_slug, source_name, source_url, source_type, strategy, is_enabled, priority, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 0, 100, ?, datetime('now'), datetime('now'))
                """,
                (
                    src.state_slug,
                    src.source_name,
                    src.source_url,
                    src.source_type,
                    src.strategy,
                    json.dumps({
                        "discovered_at": datetime.now(timezone.utc).isoformat(),
                        "confidence": src.confidence,
                        "reason": src.reason,
                        "sample_title": src.sample_title,
                        "sample_date": src.sample_date,
                    }),
                ),
            )
            saved.append({"id": cursor.lastrowid, **asdict(src)})
        conn.commit()
        conn.close()
    except sqlite3.Error as exc:
        logger.error("Failed to write proposals to control DB: %s", exc)
        raise
    return saved


def main() -> int:
    parser = argparse.ArgumentParser(description="Discover news sources for a U.S. state.")
    parser.add_argument("--state", required=True, help="State slug, e.g. 'idaho' or 'ID'")
    parser.add_argument("--db", default=CONTROL_DB_PATH, help="Path to control.db")
    parser.add_argument("--propose", action="store_true", help="Write discovered sources to control DB as disabled proposals")
    parser.add_argument("--output", help="Write JSON preview to file instead of stdout")
    parser.add_argument("--min-confidence", choices=["high", "medium", "low"], default="low", help="Minimum confidence to include")
    args = parser.parse_args()

    confidence_rank = {"high": 0, "medium": 1, "low": 2}
    min_rank = confidence_rank[args.min_confidence]

    discovered = discover(args.state, args.db)
    discovered = [s for s in discovered if confidence_rank[s.confidence] <= min_rank]

    payload = {
        "state": args.state.lower(),
        "discovered_at": datetime.now(timezone.utc).isoformat(),
        "count": len(discovered),
        "sources": [asdict(s) for s in discovered],
    }

    if args.propose:
        saved = propose_to_db(discovered, args.db)
        payload["proposed_count"] = len(saved)
        logger.info("Proposed %d new source(s) for %s", len(saved), args.state)

    output = json.dumps(payload, indent=2, default=str)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(output)
        logger.info("Wrote preview to %s", args.output)
    else:
        print(output)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        logger.exception("Discovery failed: %s", exc)
        sys.exit(1)
