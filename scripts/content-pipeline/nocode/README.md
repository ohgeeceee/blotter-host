# blotter.host — No-Code Automation Blueprint

If you prefer not to manage Python scripts, servers, or cron jobs, you can build the same autonomous content pipeline using visual automation tools.

Below are ready-to-build recipes for **Make.com**, **Zapier**, and **n8n**.

---

## Option 1: Make.com (Easiest, Hosted)

### Modules needed
1. **RSS > Watch RSS Feed Items**
2. **OpenAI > Create a Completion** (Kimi is OpenAI-compatible)
3. **WordPress > Create a Post** (or **HTTP > Make a Request** for webhooks)

### Step-by-step

1. **Create a new scenario.**
2. **Add RSS module**
   - URL: `https://news.google.com/rss/search?q=Montana+local+news`
   - Trigger: `Every hour`
   - Max items: `5`
3. **Add OpenAI module**
   - Connection: choose `Create a connection`
   - API Key: your Moonshot API key
   - Base URL: `https://api.moonshot.cn/v1`
   - Model: `moonshot-v1-8k`
   - Messages:
     - **System:** `You are an objective state-news journalist for blotter.host.`
     - **User:** paste the prompt below, mapping RSS fields into it
4. **Add JSON > Parse JSON**
   - Parse the OpenAI completion output into structured fields
5. **Add WordPress > Create a Post**
   - Title: `headline`
   - Content: `article_brief`
   - Status: `publish`
   - Categories/Tags: map `primary_category`, `primary_tag`, `geographic_tag`

### Prompt for the OpenAI module

```text
You are the Lead Content Developer for "blotter.host", a hyper-local state-level news aggregator.

Read the source material and return ONLY a valid JSON object with these keys:
- primary_category: one of [Public Safety & Justice, Statehouse & Policy, Business & Development, Community & Culture, Health & Environment]
- primary_tag: one hashtag-style tag
- geographic_tag: one hashtag-style county/city/region tag
- headline: punchy, professional, max 75 characters
- article_brief: 3-4 objective sentences

Source title: {{1.title}}
Source summary: {{1.description}}
Source link: {{1.link}}
Default region: Montana
```

---

## Option 2: Zapier (Simple, Hosted)

### Zaps needed
1. **RSS by Zapier > New Item in Feed**
2. **OpenAI > Send Prompt**
3. **WordPress > Create Post** (or **Webhooks by Zapier > POST**)

### Step-by-step

1. **Trigger:** RSS by Zapier
   - Feed URL: your RSS feed
2. **Action:** OpenAI
   - Choose `Send Prompt`
   - Account: add Moonshot with base URL `https://api.moonshot.cn/v1`
   - Model: `moonshot-v1-8k`
   - Prompt: use the same prompt as Make.com, mapping `Title`, `Description`, `Link`
3. **Action:** Code by Zapier (JavaScript)
   - Parse the OpenAI text output into JSON so later steps can map fields
4. **Action:** WordPress > Create Post
   - Map headline, brief, category, tags

> Zapier does not always expose the `base_url` field for OpenAI. If not, use **Webhooks by Zapier > POST** to call Kimi directly instead.

---

## Option 3: n8n (Self-Hosted, Most Control)

n8n is the best no-code alternative if you want to run it on your own VPS.

### High-level workflow

```
Schedule Trigger (hourly)
    │
    ▼
RSS Read
    │
    ▼
HTTP Request → Kimi API
    │
    ▼
Code Node → parse JSON
    │
    ▼
WordPress / Webhook POST
```

### Installation on the VPS

```bash
# Docker (simplest)
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

Then open `http://your-server-ip:5678` and import the workflow from `n8n-workflow.json`.

### Direct Kimi HTTP Request node settings

- **Method:** POST
- **URL:** `https://api.moonshot.cn/v1/chat/completions`
- **Headers:**
  - `Authorization`: `Bearer YOUR_KIMI_API_KEY`
  - `Content-Type`: `application/json`
- **Body (JSON):**

```json
{
  "model": "moonshot-v1-8k",
  "messages": [
    {
      "role": "system",
      "content": "You are an objective state-news journalist for blotter.host."
    },
    {
      "role": "user",
      "content": "Turn this into a JSON object with keys: primary_category, primary_tag, geographic_tag, headline, article_brief.\n\nTitle: {{ $json.title }}\nSummary: {{ $json.description }}\nLink: {{ $json.link }}\nDefault region: Montana"
    }
  ],
  "temperature": 0.3
}
```

### Advantages of n8n
- Runs on your own server
- No per-operation cost beyond API usage
- Easy to add branching logic (e.g., only publish if confidence is high)
- Built-in error handling and retries

---

## Security notes for no-code setups

- Store API keys in the platform’s built-in credential vault, never in plain text.
- Use WordPress Application Passwords, not your main password.
- Start with `draft` status while testing, then switch to `publish`.

## When to choose which

| Tool | Best for | Cost |
|---|---|---|
| **Make.com** | Non-technical users, fast setup | Free tier + paid plans |
| **Zapier** | Teams already using Zapier ecosystem | Per-task pricing |
| **n8n** | Technical users who want self-hosting | Free (self-hosted) + server cost |
| **Python script** | Maximum control, scale, and customization | Free + server cost |
