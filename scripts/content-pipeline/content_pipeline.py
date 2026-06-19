#!/usr/bin/env python3
"""
blotter.host Autonomous Content Pipeline
========================================
Fetches raw news inputs (RSS feeds, public APIs, etc.), sends them to the
Kimi/Moonshot API using a structured journalist prompt, and publishes the
formatted output to a CMS (WordPress REST API by default, webhook fallback).

Intended to run on a schedule via cron or systemd timer.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlparse

import feedparser
import requests
from dateutil import parser as date_parser
from dotenv import load_dotenv
from openai import OpenAI

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

load_dotenv()

KIMI_API_KEY = os.environ.get("KIMI_API_KEY", "").strip()
KIMI_BASE_URL = os.environ.get("KIMI_BASE_URL", "https://api.moonshot.cn/v1").strip()
KIMI_MODEL = os.environ.get("KIMI_MODEL", "moonshot-v1-8k").strip()

CMS_TYPE = os.environ.get("CMS_TYPE", "wordpress").strip().lower()
CMS_BASE_URL = os.environ.get("CMS_BASE_URL", "").rstrip("/")
CMS_USERNAME = os.environ.get("CMS_USERNAME", "").strip()
CMS_PASSWORD = os.environ.get("CMS_PASSWORD", "").strip()
CMS_WEBHOOK_URL = os.environ.get("CMS_WEBHOOK_URL", "").strip()

# Comma-separated list of RSS feed URLs to monitor
RSS_FEED_URLS = [u.strip() for u in os.environ.get("RSS_FEED_URLS", "").split(",") if u.strip()]

# Optional: state/region slug injected into every article (e.g. "Montana")
DEFAULT_REGION = os.environ.get("DEFAULT_REGION", "").strip()

# How many feed entries to process per run (keep low to control cost)
MAX_ENTRIES_PER_RUN = int(os.environ.get("MAX_ENTRIES_PER_RUN", "5"))

# Local sqlite-like dedupe store (plain JSON file)
SEEN_ITEMS_FILE = os.environ.get("SEEN_ITEMS_FILE", "/var/lib/blotter-host/seen_items.json")

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s | %(levelname)s | %(message)s",
)
logger = logging.getLogger("blotter-pipeline")


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class RawSource:
    title: str
    summary: str
    link: str
    published_at: str | None
    source_name: str
    source_url: str


@dataclass
class FormattedArticle:
    primary_category: str
    primary_tag: str
    geographic_tag: str
    headline: str
    article_brief: str
    source_url: str
    published_at: str | None


# ---------------------------------------------------------------------------
# Deduplication store
# ---------------------------------------------------------------------------

def _ensure_seen_file() -> None:
    os.makedirs(os.path.dirname(SEEN_ITEMS_FILE), exist_ok=True)
    if not os.path.exists(SEEN_ITEMS_FILE):
        with open(SEEN_ITEMS_FILE, "w", encoding="utf-8") as fh:
            json.dump({}, fh)


def _load_seen() -> dict[str, str]:
    _ensure_seen_file()
    try:
        with open(SEEN_ITEMS_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not read seen-items store: %s. Starting fresh.", exc)
        return {}


def _save_seen(seen: dict[str, str]) -> None:
    _ensure_seen_file()
    with open(SEEN_ITEMS_FILE, "w", encoding="utf-8") as fh:
        json.dump(seen, fh, indent=2, sort_keys=True)


def _item_id(url: str, title: str) -> str:
    return hashlib.sha256(f"{url}|{title}".encode("utf-8")).hexdigest()[:32]


# ---------------------------------------------------------------------------
# Source ingestion
# ---------------------------------------------------------------------------

def fetch_rss_feeds(urls: list[str], max_entries: int = MAX_ENTRIES_PER_RUN) -> list[RawSource]:
    """Parse RSS/Atom feeds and return the most recent entries."""
    sources: list[RawSource] = []
    for url in urls:
        try:
            logger.info("Fetching RSS feed: %s", url)
            parsed = feedparser.parse(url)
            source_name = parsed.feed.get("title", urlparse(url).netloc)
            for entry in parsed.entries[:max_entries]:
                published = None
                if getattr(entry, "published", None):
                    try:
                        published = date_parser.parse(entry.published).isoformat()
                    except (ValueError, TypeError):
                        published = None
                sources.append(
                    RawSource(
                        title=_clean_text(entry.get("title", "")),
                        summary=_clean_text(entry.get("summary", entry.get("description", ""))),
                        link=entry.get("link", ""),
                        published_at=published,
                        source_name=source_name,
                        source_url=url,
                    )
                )
        except Exception as exc:
            logger.error("Failed to parse feed %s: %s", url, exc)
    return sources


def fetch_police_blotter(api_url: str) -> list[RawSource]:
    """
    Example adapter for a JSON police blotter API.
    Override the response mapping to match the actual API schema.
    """
    try:
        logger.info("Fetching police blotter API: %s", api_url)
        resp = requests.get(api_url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        sources: list[RawSource] = []
        for item in data.get("incidents", [])[:MAX_ENTRIES_PER_RUN]:
            sources.append(
                RawSource(
                    title=_clean_text(item.get("incident_type", "")),
                    summary=_clean_text(item.get("narrative", "")),
                    link=item.get("report_url", api_url),
                    published_at=item.get("date_reported"),
                    source_name="Police Blotter",
                    source_url=api_url,
                )
            )
        return sources
    except Exception as exc:
        logger.error("Failed to fetch police blotter %s: %s", api_url, exc)
        return []


def _clean_text(text: str) -> str:
    if not text:
        return ""
    # Strip HTML tags and collapse whitespace
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Kimi / Moonshot formatting
# ---------------------------------------------------------------------------

JOURNALIST_PROMPT = """You are the Lead Content Developer and automated AI journalist for "blotter.host", a hyper-local, state-level news aggregator.

Your task: read the raw source material below and produce a single, publication-ready news item formatted as JSON.

Categories (choose exactly one):
- Public Safety & Justice
- Statehouse & Policy
- Business & Development
- Community & Culture
- Health & Environment

Output strictly valid JSON with these keys:
- primary_category: string
- primary_tag: string (one hashtag-style tag, e.g. #PoliceBlotter)
- geographic_tag: string (one hashtag-style tag for county/city/region, e.g. #LewisAndClarkCounty or #Statewide)
- headline: string, punchy and professional, max 75 characters
- article_brief: string, 3-4 sentences, objective, factual, no fluff

Rules:
- Use 2026 for any temporal references if needed.
- Do not invent facts not present in the source.
- If the source is too thin to write a full brief, say so in article_brief and still choose the best category.
- Return ONLY the JSON object. No markdown fences, no commentary.

Raw source material:
Title: {title}
Source: {source_name}
Summary: {summary}
Link: {link}
Published: {published_at}
Default region (use or refine): {region}
"""


def format_with_kimi(source: RawSource) -> FormattedArticle | None:
    """Send a raw source to Kimi and parse the structured JSON response."""
    if not KIMI_API_KEY:
        logger.error("KIMI_API_KEY is not set. Skipping Kimi formatting.")
        return None

    client = OpenAI(api_key=KIMI_API_KEY, base_url=KIMI_BASE_URL)
    prompt = JOURNALIST_PROMPT.format(
        title=source.title,
        source_name=source.source_name,
        summary=source.summary,
        link=source.link,
        published_at=source.published_at or "Unknown",
        region=DEFAULT_REGION or "Statewide",
    )

    try:
        response = client.chat.completions.create(
            model=KIMI_MODEL,
            messages=[
                {"role": "system", "content": "You are an objective state-news journalist."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
            max_tokens=600,
        )
        raw_content = response.choices[0].message.content or ""
        # Strip accidental markdown fences
        raw_content = re.sub(r"^```json\s*", "", raw_content.strip())
        raw_content = re.sub(r"\s*```$", "", raw_content.strip())
        parsed = json.loads(raw_content)

        return FormattedArticle(
            primary_category=parsed.get("primary_category", "Community & Culture"),
            primary_tag=parsed.get("primary_tag", "#LocalNews"),
            geographic_tag=parsed.get("geographic_tag", f"#{DEFAULT_REGION}" if DEFAULT_REGION else "#Statewide"),
            headline=parsed.get("headline", source.title)[:120],
            article_brief=parsed.get("article_brief", source.summary),
            source_url=source.link,
            published_at=source.published_at,
        )
    except json.JSONDecodeError as exc:
        logger.error("Kimi returned non-JSON output for '%s': %s", source.title, exc)
        logger.debug("Raw output: %s", raw_content)
    except Exception as exc:
        logger.error("Kimi API call failed for '%s': %s", source.title, exc)
    return None


# ---------------------------------------------------------------------------
# CMS publishing
# ---------------------------------------------------------------------------

def publish_to_wordpress(article: FormattedArticle) -> dict[str, Any] | None:
    """Publish the formatted article to WordPress via REST API."""
    if not all([CMS_BASE_URL, CMS_USERNAME, CMS_PASSWORD]):
        logger.error("WordPress CMS credentials are not fully configured.")
        return None

    wp_url = urljoin(CMS_BASE_URL, "/wp-json/wp/v2/posts")
    payload = {
        "title": article.headline,
        "content": f"<p>{article.article_brief}</p><p><a href='{article.source_url}' target='_blank'>Read original source &rarr;</a></p>",
        "status": os.environ.get("WP_POST_STATUS", "publish"),
        "categories": [_wp_category_id(article.primary_category)],
        "tags": [_wp_tag_id(article.primary_tag), _wp_tag_id(article.geographic_tag)],
    }

    try:
        resp = requests.post(wp_url, json=payload, auth=(CMS_USERNAME, CMS_PASSWORD), timeout=30)
        resp.raise_for_status()
        logger.info("Published to WordPress: %s", article.headline)
        return resp.json()
    except requests.RequestException as exc:
        logger.error("WordPress publish failed: %s", exc)
    return None


def publish_via_webhook(article: FormattedArticle) -> dict[str, Any] | None:
    """Publish the formatted article to a generic webhook (Webflow, Supabase, etc.)."""
    if not CMS_WEBHOOK_URL:
        logger.error("CMS_WEBHOOK_URL is not configured.")
        return None

    payload = {
        "headline": article.headline,
        "brief": article.article_brief,
        "primary_category": article.primary_category,
        "primary_tag": article.primary_tag,
        "geographic_tag": article.geographic_tag,
        "source_url": article.source_url,
        "published_at": article.published_at,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        resp = requests.post(CMS_WEBHOOK_URL, json=payload, timeout=30)
        resp.raise_for_status()
        logger.info("Published via webhook: %s", article.headline)
        return resp.json() if resp.text else {"status": resp.status_code}
    except requests.RequestException as exc:
        logger.error("Webhook publish failed: %s", exc)
    return None


def publish_to_blotter(article: FormattedArticle) -> dict[str, Any] | None:
    """Publish the formatted article to the blotter.host Flask CMS."""
    if not CMS_BASE_URL:
        logger.error("CMS_BASE_URL is not configured.")
        return None
    if not CMS_PASSWORD:
        logger.error("CMS_PASSWORD (API key) is not configured.")
        return None

    endpoint = f"{CMS_BASE_URL.rstrip('/')}/api/blog/posts"
    payload = {
        "title": article.headline,
        "body": f"<p>{article.article_brief}</p>",
        "excerpt": article.article_brief[:240],
        "author": "blotter.host pipeline",
        "published": True,
        "source_url": article.source_url,
        "primary_category": article.primary_category,
        "tags": [article.primary_tag, article.geographic_tag],
    }

    try:
        resp = requests.post(
            endpoint,
            json=payload,
            headers={"Authorization": f"Bearer {CMS_PASSWORD}"},
            timeout=30,
        )
        resp.raise_for_status()
        logger.info("Published to blotter.host CMS: %s", article.headline)
        return resp.json()
    except requests.RequestException as exc:
        logger.error("blotter.host CMS publish failed: %s", exc)
    return None


def publish(article: FormattedArticle) -> dict[str, Any] | None:
    if CMS_TYPE == "wordpress":
        return publish_to_wordpress(article)
    if CMS_TYPE == "webhook":
        return publish_via_webhook(article)
    if CMS_TYPE == "blotter":
        return publish_to_blotter(article)
    logger.error("Unknown CMS_TYPE: %s", CMS_TYPE)
    return None


# WordPress helpers (naive name-to-id; expand if needed)

def _wp_category_id(category_name: str) -> int:
    mapping = {
        "Public Safety & Justice": 1,
        "Statehouse & Policy": 2,
        "Business & Development": 3,
        "Community & Culture": 4,
        "Health & Environment": 5,
    }
    return mapping.get(category_name, 1)


def _wp_tag_id(tag: str) -> int:
    # In production, resolve/create tags via /wp-json/wp/v2/tags
    # Here we return a stable fake ID derived from the tag name.
    return abs(hash(tag)) % 1_000_000


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_pipeline() -> int:
    """Main entry point. Returns number of articles published."""
    seen = _load_seen()
    raw_sources: list[RawSource] = []

    if RSS_FEED_URLS:
        raw_sources.extend(fetch_rss_feeds(RSS_FEED_URLS))

    # Optional: fetch from a police-blotter API if configured
    blotter_api = os.environ.get("POLICE_BLOTTER_API_URL", "").strip()
    if blotter_api:
        raw_sources.extend(fetch_police_blotter(blotter_api))

    if not raw_sources:
        logger.info("No raw sources found. Nothing to do.")
        return 0

    published_count = 0
    for source in raw_sources:
        item_id = _item_id(source.link, source.title)
        if item_id in seen:
            logger.info("Skipping already-processed item: %s", source.title)
            continue

        article = format_with_kimi(source)
        if article is None:
            seen[item_id] = "failed"
            continue

        result = publish(article)
        if result:
            seen[item_id] = "published"
            published_count += 1
        else:
            seen[item_id] = "publish_failed"

    _save_seen(seen)
    logger.info("Pipeline complete. Published %d new article(s).", published_count)
    return published_count


if __name__ == "__main__":
    try:
        count = run_pipeline()
        sys.exit(0 if count >= 0 else 1)
    except Exception as exc:
        logger.exception("Pipeline crashed: %s", exc)
        sys.exit(1)
