# Managing News Sources

The blotter.host control panel lets you add RSS feeds and news-station
homepages for each state. Once enabled, the scraper pulls articles, the LLM
processor turns them into blotter summaries, and they appear in the moderation
feed at `/admin/dashboard`.

## Adding a source

1. Sign in at `https://admin.blotter.host/admin`.
2. Click **News Sources** in the left sidebar.
3. Fill in the form:
   - **State** — the tenant/state this source belongs to.
   - **Source name** — human-readable label (e.g. "Idaho Statesman").
   - **URL** — RSS feed URL or homepage URL.
   - **Type** — `RSS feed` or `Website / homepage`.
   - **Strategy** — auto-selected; `rssBulletin` for RSS, `staticBulletin` or
     `dynamicBulletin` for websites.
   - **Priority** — lower numbers run first (default 100).
   - **Enabled** — only enabled sources are scraped.
4. Click **Save source**.
5. Use the **Test** button to verify the URL is reachable and looks like RSS
   (for RSS feeds).

## Running the scraper manually

Select a state from the **Filter by state** dropdown and click **Run scraper
for state**. The scraper will process every enabled source for that state and
insert new articles into `raw_records` (deduplicated by state + content
fingerprint).

The scheduled cron job also runs news sources automatically every 3 hours
(alongside the hardcoded sources).

## Publishing articles

After the scraper runs, the LLM processor generates `generated_articles` rows
with `publication_status = 'draft'`. Review them on the **Wire Room** dashboard
and click **Publish all drafts** or publish individually.

## Discovery agent

To automatically find news sources for a state:

```bash
cd /root/blotter-host/scripts/news-source-discovery
./venv/bin/python discover.py --state idaho
```

This prints a JSON preview. To write proposed sources to the control DB as
disabled entries for your review:

```bash
./venv/bin/python discover.py --state idaho --propose
```

Then enable the ones you want in the **News Sources** admin panel.

## Data model

Sources are stored in the SQLite `data/control.db` table `news_sources`:

```sql
CREATE TABLE news_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_slug TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL,     -- 'rss' | 'website'
  strategy TEXT NOT NULL,        -- 'rssBulletin' | 'staticBulletin' | 'dynamicBulletin'
  is_enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);
```

## Troubleshooting

- **Source not scraped**: check that `is_enabled = 1` and the state slug
  matches a tenant in `tenants.json`.
- **RSS feed times out**: some feeds block certain IP ranges. Use the **Test**
  button to confirm reachability.
- **Duplicate articles**: the pipeline deduplicates by a SHA-256 fingerprint of
  the raw text scoped to the state. Identical articles in different states are
  allowed.
