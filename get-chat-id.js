#!/usr/bin/env node
/**
 * One-time helper: prints your Telegram chat id.
 *
 * Usage:
 *   1. Create a bot with @BotFather, copy its token.
 *   2. Open your bot in Telegram and send it any message (e.g. "hi").
 *   3. Run:  node get-chat-id.js <BOT_TOKEN>
 *      (or set TELEGRAM_TOKEN in .env and run: node get-chat-id.js)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

try {
  const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {}

const token = process.argv[2] || process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('Provide your bot token: node get-chat-id.js <BOT_TOKEN>');
  process.exit(1);
}

https.get(`https://api.telegram.org/bot${token}/getUpdates`, (res) => {
  let d = '';
  res.on('data', (c) => (d += c));
  res.on('end', () => {
    try {
      const j = JSON.parse(d);
      if (!j.ok) return console.error('Telegram error:', j.description);
      const ids = new Set();
      for (const u of j.result || []) {
        const chat = u.message && u.message.chat;
        if (chat) ids.add(`${chat.id}  (${chat.first_name || chat.title || 'chat'})`);
      }
      if (ids.size === 0) {
        console.log('No messages found. Send your bot a message first, then re-run.');
      } else {
        console.log('Your chat id(s):');
        for (const id of ids) console.log('  ' + id);
      }
    } catch (e) {
      console.error('Failed to parse response:', e.message);
    }
  });
}).on('error', (e) => console.error(e.message));
