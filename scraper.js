#!/usr/bin/env node
/**
 * TunisieFreelance project monitor.
 *
 * 1. Fetches each watched category page and collects the id + url of every
 *    project currently listed (this data is always inline and reliable).
 * 2. Diffs against seen.json so each project is only ever handled once.
 * 3. For each NEW project, fetches its detail page and parses the embedded
 *    schema.org JobPosting JSON (full title, description, exact post time,
 *    budget, skills, category) — then pushes a rich Telegram notification.
 *
 * No login, no headless browser, no site API key. State lives in seen.json.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Load a local .env (for testing on your PC). No dependency, ignored in cloud.
(function loadDotEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* no .env, fine */ }
})();

// ---- Config -----------------------------------------------------------------

const BASE = 'https://tunisiefreelance.tn';

// Categories to watch -> /en/categories/<slug>. Override with CATEGORIES env.
const CATEGORIES = (process.env.CATEGORIES || 'mobile-development,web-development')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Optional safety net: ignore projects older than this many days even if unseen
// (protects you from a flood if seen.json is ever lost). 0 = disabled.
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 0);

const SEEN_FILE = path.join(__dirname, 'seen.json');
const MAX_SEEN = 5000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---- HTTPS helpers ----------------------------------------------------------

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8,ar;q=0.7',
          Accept: 'text/html,application/xhtml+xml',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return resolve(httpGet(new URL(res.headers.location, url).href, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`POST ${url} -> HTTP ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Flight / JSON-LD parsing ----------------------------------------------

/** Rebuild the Next.js RSC flight text from the self.__next_f.push chunks. */
function extractFlight(html) {
  const re = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/gs;
  let m;
  let out = '';
  while ((m = re.exec(html))) {
    try {
      out += JSON.parse('"' + m[1] + '"');
    } catch (_) {
      /* skip malformed chunk */
    }
  }
  return out;
}

/**
 * From a category page, return every listed project as { id, url }.
 * Job cards are <li> items keyed by a 24-hex id whose link points at /en/jobs/.
 */
function parseCategoryList(flight) {
  const re = /\["\$","li","([a-f0-9]{24})",\{[^]*?"href":"(\/en\/jobs\/[^"]+)"/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(flight))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: BASE + m[2] });
  }
  return out;
}

/** Extract the schema.org JobPosting object from a detail page's flight text. */
function extractJobPosting(flight) {
  const key = '"@type":"JobPosting"';
  const k = flight.indexOf(key);
  if (k < 0) return null;
  const start = flight.lastIndexOf('{', k);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < flight.length; i++) {
    const c = flight[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(flight.slice(start, i + 1)); }
        catch (_) { return null; }
      }
    }
  }
  return null;
}

function formatBudget(baseSalary) {
  try {
    const cur = baseSalary.currency || '';
    const v = baseSalary.value;
    const amount = v && (v.value != null ? v.value : v.minValue);
    if (amount == null) return 'Not specified';
    const unit = v.unitText ? ` / ${String(v.unitText).toLowerCase()}` : '';
    return `${Number(amount).toLocaleString('en-US')} ${cur}${unit}`.trim();
  } catch (_) {
    return 'Not specified';
  }
}

function detectLang(text) {
  const t = (text || '').toLowerCase();
  if (/[؀-ۿ]/.test(text)) return { flag: '🇹🇳', name: 'Arabic' };
  const fr = (t.match(/\b(le|la|les|une|des|pour|avec|vous|je|nous|est|besoin|recherche|projet|développement|application|réaliser|cette|qui)\b/g) || []).length;
  const en = (t.match(/\b(the|and|for|with|you|need|looking|project|app|website|develop|want|please|that|this|have|would)\b/g) || []).length;
  if (fr > en) return { flag: '🇫🇷', name: 'French' };
  return { flag: '🇬🇧', name: 'English' };
}

function relTime(iso) {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

/** Turn a JobPosting + url into the normalized job we notify about. */
function buildJob(posting, url) {
  const skills = (posting.skills || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: (posting.identifier && posting.identifier.value) || url,
    title: posting.title || '(untitled)',
    description: posting.description || '',
    url: posting.url || url,
    category: posting.occupationalCategory || '',
    datePosted: posting.datePosted || '',
    budget: posting.baseSalary ? formatBudget(posting.baseSalary) : 'Not specified',
    skills,
    lang: detectLang(`${posting.title} ${posting.description}`),
  };
}

// ---- State ------------------------------------------------------------------

function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    return { bootstrapped: !!raw.bootstrapped, ids: new Set(raw.ids || []) };
  } catch (_) {
    return { bootstrapped: false, ids: new Set() };
  }
}

function saveSeen(state) {
  const ids = [...state.ids].slice(-MAX_SEEN);
  fs.writeFileSync(
    SEEN_FILE,
    JSON.stringify({ bootstrapped: true, updatedAt: new Date().toISOString(), ids }, null, 0)
  );
}

// ---- Notifications ----------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMessage(job) {
  const catNice = (job.category || 'project').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const rel = relTime(job.datePosted);
  const lines = [
    `🆕 <b>${esc(job.title)}</b>`,
    `${job.lang.flag} ${job.lang.name} · 🗂 ${esc(catNice)}`,
    `💰 <b>${esc(job.budget)}</b>${rel ? ` · 🕒 ${rel}` : ''}`,
  ];
  if (job.skills.length) lines.push(`🏷 ${esc(job.skills.slice(0, 10).join(', '))}`);
  if (job.description) {
    const d = job.description.length > 400 ? job.description.slice(0, 397) + '…' : job.description;
    lines.push('', `<i>${esc(d)}</i>`);
  }
  lines.push('', `🔗 ${job.url}`);
  return lines.join('\n');
}

async function sendTelegram(text, preview = true) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[dry-run]\n' + text + '\n');
    return;
  }
  await httpPostJson(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: !preview,
  });
}

// ---- Main -------------------------------------------------------------------

async function main() {
  const state = loadSeen();

  // 1. Collect all currently-listed project ids across categories.
  const listed = new Map(); // id -> url
  for (const cat of CATEGORIES) {
    const url = `${BASE}/en/categories/${cat}`;
    try {
      const items = parseCategoryList(extractFlight(await httpGet(url)));
      for (const it of items) if (!listed.has(it.id)) listed.set(it.id, it.url);
      console.log(`[${cat}] ${items.length} projects listed`);
    } catch (e) {
      console.error(`[${cat}] failed: ${e.message}`);
    }
  }

  const freshIds = [...listed.keys()].filter((id) => !state.ids.has(id));

  // First ever run: learn the current board silently (no notification spam).
  if (!state.bootstrapped) {
    for (const id of listed.keys()) state.ids.add(id);
    saveSeen(state);
    await sendTelegram(
      `✅ <b>Monitor started.</b>\nWatching: ${CATEGORIES.map((c) => c.replace(/-/g, ' ')).join(', ')}.\n` +
        `Learned ${listed.size} existing projects. You'll now get a ping for each new one.`,
      false
    );
    console.log(`Bootstrapped with ${listed.size} projects (no pings sent).`);
    return;
  }

  if (freshIds.length === 0) {
    console.log('No new projects.');
    return;
  }

  console.log(`Found ${freshIds.length} candidate new project(s). Enriching…`);

  // 2. Enrich each new project from its detail page, then notify.
  const jobs = [];
  for (const id of freshIds) {
    const url = listed.get(id);
    try {
      const posting = extractJobPosting(extractFlight(await httpGet(url)));
      jobs.push(posting ? buildJob(posting, url) : { id, title: '(new project)', url, description: '', category: '', datePosted: '', budget: 'Not specified', skills: [], lang: { flag: '🌐', name: '' } });
    } catch (e) {
      console.error(`enrich failed for ${url}: ${e.message}`);
      jobs.push({ id, title: '(new project)', url, description: '', category: '', datePosted: '', budget: 'Not specified', skills: [], lang: { flag: '🌐', name: '' } });
    }
    await sleep(400); // be polite to the server
  }

  // Optional age guard, then notify oldest-first so newest sits on top.
  const cutoff = MAX_AGE_DAYS > 0 ? Date.now() - MAX_AGE_DAYS * 86400000 : 0;
  jobs.sort((a, b) => new Date(a.datePosted) - new Date(b.datePosted));

  let sent = 0;
  for (const job of jobs) {
    const tooOld = cutoff && job.datePosted && new Date(job.datePosted).getTime() < cutoff;
    if (!tooOld) {
      try {
        await sendTelegram(formatMessage(job));
        sent++;
      } catch (e) {
        console.error(`notify failed for ${job.title}: ${e.message}`);
        continue; // don't mark as seen if we couldn't tell the user
      }
    }
    state.ids.add(job.id);
  }
  saveSeen(state);
  console.log(`Done. Sent ${sent} notification(s).`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}

module.exports = { extractFlight, parseCategoryList, extractJobPosting, buildJob, formatMessage, detectLang };
