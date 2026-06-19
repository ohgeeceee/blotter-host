# blotter.host News Source Discovery Agent

Finds local news-station RSS feeds and homepages for a U.S. state, validates
feeds, and proposes additions to the `news_sources` table in
`/root/blotter-host/data/control.db`.

## Setup

Use the existing content-pipeline virtual environment (it already has the
dependencies) or create a fresh one:

```bash
cd /root/blotter-host/scripts/news-source-discovery
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Usage

Preview sources for a state without writing anything:

```bash
./venv/bin/python discover.py --state idaho
```

Only show high-confidence results:

```bash
./venv/bin/python discover.py --state montana --min-confidence high
```

Write proposed sources to the control DB as **disabled** entries for operator
review:

```bash
./venv/bin/python discover.py --state idaho --propose
```

Save the JSON preview to a file:

```bash
./venv/bin/python discover.py --state idaho --output idaho-proposed.json
```

## How it works

1. Searches DuckDuckGo Lite for local news stations/newspapers in the state.
2. Visits each candidate homepage.
3. Looks for `<link rel="alternate" type="application/rss+xml">` tags.
4. Validates any RSS links with `feedparser`.
5. De-duplicates against URLs already in `news_sources`.
6. Scores each candidate as `high`, `medium`, or `low` confidence.

## Scheduling

Add to cron to run weekly for every state you want to keep discovering:

```cron
# Every Sunday at 03:17
17 3 * * 0 root cd /root/blotter-host/scripts/news-source-discovery && ./venv/bin/python discover.py --state idaho --propose >> /var/log/blotter-discovery.log 2>&1
```

Review proposed sources in the admin panel under **News Sources**, enable the
ones you want, and the regular scraper will pick them up on its next run.
