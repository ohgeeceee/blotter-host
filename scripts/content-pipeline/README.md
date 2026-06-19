# blotter.host Autonomous Content Pipeline

A production-ready Python script that fetches raw news inputs, sends them to the Kimi/Moonshot AI API for structured formatting, and publishes the results to WordPress or a generic webhook.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  RSS / Public   │────▶│  content_pipeline │────▶│  Kimi/Moonshot  │
│     APIs        │     │     (Python)      │     │      AI         │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │  WordPress /    │
                        │  Webhook CMS    │
                        └─────────────────┘
```

## Setup

### 1. Install dependencies

```bash
cd /root/blotter-host/scripts/content-pipeline
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure environment variables

```bash
cp .env.example .env
nano .env
```

Fill in at least:
- `KIMI_API_KEY`
- `CMS_BASE_URL`, `CMS_USERNAME`, `CMS_PASSWORD` (for WordPress)
- `RSS_FEED_URLS`
- `DEFAULT_REGION`

For WordPress, generate an **Application Password** under your user profile and use that instead of your login password.

### 3. Test the pipeline manually

```bash
source venv/bin/activate
python content_pipeline.py
```

Watch the logs. On success you should see `Pipeline complete. Published N new article(s).`

## Scheduling with Cron

Run the pipeline every hour.

### Option A: User crontab

```bash
# Open your crontab
crontab -e

# Add this line (adjust path to Python and script)
0 * * * * cd /root/blotter-host/scripts/content-pipeline && ./venv/bin/python content_pipeline.py >> /var/log/blotter-pipeline.log 2>&1
```

### Option B: System cron (recommended for production servers)

```bash
sudo nano /etc/cron.d/blotter-pipeline
```

Add:

```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
KIMI_API_KEY=your_moonshot_api_key_here
CMS_BASE_URL=https://blotter.host
CMS_USERNAME=wp_username
CMS_PASSWORD=wp_app_password
RSS_FEED_URLS=https://news.google.com/rss/search?q=Montana+local+news
DEFAULT_REGION=Montana

0 * * * * root cd /root/blotter-host/scripts/content-pipeline && ./venv/bin/python content_pipeline.py >> /var/log/blotter-pipeline.log 2>&1
```

Create the log directory:

```bash
sudo mkdir -p /var/log/blotter-host
sudo touch /var/log/blotter-pipeline.log
```

## Scheduling with systemd timer (alternative to cron)

For better logging and failure handling, use a systemd timer.

### 1. Create the service unit

`/etc/systemd/system/blotter-pipeline.service`:

```ini
[Unit]
Description=blotter.host content pipeline
After=network.target

[Service]
Type=oneshot
User=root
WorkingDirectory=/root/blotter-host/scripts/content-pipeline
EnvironmentFile=/root/blotter-host/scripts/content-pipeline/.env
ExecStart=/root/blotter-host/scripts/content-pipeline/venv/bin/python content_pipeline.py
```

### 2. Create the timer unit

`/etc/systemd/system/blotter-pipeline.timer`:

```ini
[Unit]
Description=Run blotter.host content pipeline every hour

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

### 3. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now blotter-pipeline.timer
sudo systemctl list-timers --all | grep blotter-pipeline
```

## Deduplication

The script stores processed item IDs in `/var/lib/blotter-host/seen_items.json` (configurable via `SEEN_ITEMS_FILE`). This prevents the same RSS item from being processed twice.

## Security notes

- Never commit `.env` to git.
- Use WordPress Application Passwords, not your main account password.
- Restrict file permissions: `chmod 600 .env`.
- For production, run the script under a dedicated non-root user.

## Extending the pipeline

- Add more feed URLs to `RSS_FEED_URLS`.
- Implement a real police-blotter API mapping in `fetch_police_blotter()`.
- Replace `_wp_category_id()` and `_wp_tag_id()` with live lookups against the WordPress REST API.
- Switch to `CMS_TYPE=webhook` to push into Webflow, Supabase, or a custom backend.
