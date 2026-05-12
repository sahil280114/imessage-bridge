// Amber iMessage bridge
//
// Runs on the Mac that has `imsg` installed and Messages.app signed into the
// Amber Apple ID. Exposes a tiny HTTP API so the Amber backend (over Tailscale)
// can send outbound iMessages, and streams inbound messages back to the
// backend's /imessage/webhook endpoint.
//
// Env (.env or shell):
//   BRIDGE_PORT          Listen port (default 4720)
//   BRIDGE_TOKEN         Shared secret. Required on every inbound and outbound
//                        request. Picked any random ~32-char string.
//   AMBER_WEBHOOK_URL    Where to POST inbound messages, e.g.
//                          https://api.your-amber.com/imessage/webhook
//   IMSG_BIN             Path to imsg (default: `imsg` on PATH)
//   IMSG_WATCH_ARGS      Extra args for `imsg watch` (default: --json)
//   IMSG_FROM            Optional: Apple ID handle the bridge expects to be
//                        sending from (used only for logging/sanity).
//
// Auth model:
//   Outbound (Amber → bridge):  Authorization: Bearer <BRIDGE_TOKEN>
//   Inbound  (bridge → Amber):  Authorization: Bearer <BRIDGE_TOKEN>

require('dotenv').config();
const express = require('express');
const { spawn, execFile } = require('child_process');
const fetch = require('node-fetch');
const crypto = require('crypto');

const PORT = parseInt(process.env.BRIDGE_PORT || '4720', 10);
const TOKEN = process.env.BRIDGE_TOKEN;
const WEBHOOK_URL = process.env.AMBER_WEBHOOK_URL;
const IMSG_BIN = process.env.IMSG_BIN || 'imsg';
const WATCH_ARGS = (process.env.IMSG_WATCH_ARGS || '--json').split(/\s+/).filter(Boolean);

if (!TOKEN) {
  console.error('BRIDGE_TOKEN is required. Set it in .env.');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.warn('AMBER_WEBHOOK_URL not set — inbound events will only be logged.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Auth middleware ─────────────────────────────────────────────────────────
function requireToken(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m || m[1] !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, from: process.env.IMSG_FROM || null }));

// ── Outbound send ───────────────────────────────────────────────────────────
//   POST /send { to: "+15551234567" | "user@icloud.com", text: "hello" }
app.post('/send', requireToken, async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to and text required' });
  if (text.length > 4000) return res.status(400).json({ error: 'text too long' });

  try {
    const stdout = await runImsg(['send', '--to', to, '--text', text]);
    res.json({ ok: true, raw: stdout.slice(0, 500) });
  } catch (err) {
    console.error('[send] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function runImsg(args) {
  return new Promise((resolve, reject) => {
    execFile(IMSG_BIN, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.toString().trim() || err.message;
        return reject(new Error(msg));
      }
      resolve(stdout?.toString() || '');
    });
  });
}

// ── Inbound watcher ─────────────────────────────────────────────────────────
//
// `imsg watch --json` emits NDJSON. We tolerate unknown shapes; we look for
// the fields we need (handle, text, fromMe) and ignore everything else.
function startWatcher() {
  console.log(`[watch] starting: ${IMSG_BIN} watch ${WATCH_ARGS.join(' ')}`);
  const proc = spawn(IMSG_BIN, ['watch', ...WATCH_ARGS], { stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      handleWatchLine(line);
    }
  });

  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[watch:stderr] ${chunk}`);
  });

  proc.on('exit', (code, signal) => {
    console.error(`[watch] exited (code=${code}, signal=${signal}). Restarting in 5s…`);
    setTimeout(startWatcher, 5000);
  });

  proc.on('error', (err) => {
    console.error('[watch] spawn error:', err.message);
  });
}

function handleWatchLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }

  // Normalize: extract the fields we care about across plausible shapes.
  // imsg's JSON output uses keys like `text`, `from`, `chat`, `isFromMe`.
  const text = obj.text ?? obj.body ?? obj.message?.text ?? null;
  const fromMe =
    obj.isFromMe ?? obj.fromMe ?? obj.from_me ?? obj.is_from_me ??
    obj.message?.isFromMe ?? obj.message?.is_from_me ?? false;

  // Sender handle: phone or email of the message originator.
  const from =
    obj.from ??
    obj.handle ??
    obj.sender ??
    obj.message?.from ??
    obj.chat?.handle ??
    null;

  // Event id for dedupe — use whatever imsg gives us, fall back to a hash.
  const eventId =
    obj.id ??
    obj.guid ??
    obj.message?.guid ??
    obj.message?.id ??
    crypto.createHash('sha1').update(line).digest('hex');

  // Only forward inbound text-message events.
  if (fromMe === true) return;
  if (!text || !from) return;

  // Belt and suspenders: if the sender handle matches our own bridge handle,
  // it can't be an inbound message — drop it. This prevents echo loops if a
  // future imsg release renames the is_from_me field again.
  const selfHandle = (process.env.IMSG_FROM || '').trim().toLowerCase();
  if (selfHandle && String(from).trim().toLowerCase() === selfHandle) return;

  forwardToAmber({
    event_id: String(eventId),
    from: String(from).trim(),
    text: String(text),
    received_at: new Date().toISOString(),
  });
}

async function forwardToAmber(payload) {
  if (!WEBHOOK_URL) {
    console.log('[inbound]', payload);
    return;
  }
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(payload),
      timeout: 15000,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[forward] ${r.status} ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error('[forward] error:', err.message);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Amber iMessage bridge listening on :${PORT}`);
  startWatcher();
});
