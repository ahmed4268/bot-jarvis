# TunisieFreelance Project Monitor 🔔

A tiny bot that watches [tunisiefreelance.tn](https://tunisiefreelance.tn) and sends
you a **Telegram** notification the moment a new project is posted in your
categories (default: **Mobile Development** + **Web Development**).

Each notification includes: title, budget, exact time posted, skills, a description
snippet, the detected language (🇫🇷 French / 🇬🇧 English / 🇹🇳 Arabic), and a direct link.

- ✅ No login, no headless browser, no paid API.
- ✅ Runs **24/7 for free** on GitHub Actions (works even when your PC is off).
- ✅ Never notifies you twice — it remembers what it has seen in `seen.json`.

---

## How it works

1. Fetches your category pages and collects every listed project's id + link.
2. Compares against `seen.json` to find the **new** ones.
3. For each new project, reads its page's embedded `JobPosting` data (full title,
   description, budget, post time, skills) and sends a Telegram message.

The very first run **learns** the current board silently (so you don't get 20
pings at once) and sends one "Monitor started" confirmation.

---

## Setup (about 10 minutes, one time)

### 1. Create your Telegram bot

1. In Telegram, open **@BotFather** → send `/newbot` → follow prompts.
2. Copy the **bot token** it gives you (looks like `123456789:AAª...`).
3. Open your new bot and send it any message (e.g. `hi`) so it can message you back.

### 2. Get your chat id

On your PC (Node 18+ installed):

```bash
node get-chat-id.js <YOUR_BOT_TOKEN>
```

It prints your **chat id** (a number). Keep the token + chat id handy.

> Want the bot to post to a group? Add the bot to the group, send a message there,
> then run the command — the group id (often negative) will show up.

### 3. Test it locally (optional but recommended)

```bash
cp .env.example .env       # then edit .env with your token + chat id
node scraper.js            # first run = "Monitor started" message
```

Without a token it runs in **dry-run** mode and just prints what it would send.

### 4. Deploy free on GitHub Actions (24/7)

1. Create a **new GitHub repository** (private is fine) and push these files:
   ```bash
   git init
   git add .
   git commit -m "TunisieFreelance monitor"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
   > Don't commit your `.env` — it's already git-ignored.

2. In the repo: **Settings → Secrets and variables → Actions → New repository secret**.
   Add two secrets:
   - `TELEGRAM_TOKEN` → your bot token
   - `TELEGRAM_CHAT_ID` → your chat id

3. Go to the **Actions** tab, enable workflows if prompted, open
   **“TunisieFreelance monitor”**, and click **Run workflow** once to bootstrap.

Done. It now checks every ~5 minutes, forever, for free.

---

## Configuration

Set these as env vars locally (`.env`) or as extra secrets/vars in the workflow:

| Variable           | Default                              | Meaning                                         |
| ------------------ | ------------------------------------ | ----------------------------------------------- |
| `TELEGRAM_TOKEN`   | —                                    | Your bot token (required to actually send).     |
| `TELEGRAM_CHAT_ID` | —                                    | Where to send the messages.                     |
| `CATEGORIES`       | `mobile-development,web-development`  | Comma-separated category slugs to watch.        |
| `MAX_AGE_DAYS`     | `0` (off)                            | Ignore projects older than N days (safety net). |

**Available category slugs:** `mobile-development`, `web-development`,
`design`, `data-science`, `marketing`, `writing`, `video`, `business`.

---

## Files

| File                            | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `scraper.js`                    | The whole bot: fetch → parse → diff → notify.       |
| `get-chat-id.js`                | One-time helper to find your Telegram chat id.      |
| `seen.json`                     | Auto-managed memory of projects already seen.       |
| `.github/workflows/monitor.yml` | The free 24/7 scheduler (runs every 5 min).         |
| `.env.example`                  | Template for local testing.                         |

---

## Notes & limits

- GitHub's cron can lag a few minutes under load; dedup means you never miss or
  double-get a project.
- If the site changes its page structure, parsing may need a small update — the
  logic is isolated in `parseCategoryList` / `extractJobPosting` in `scraper.js`.
- Please keep the polling interval reasonable (5 min is already gentle).
