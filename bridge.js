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

// Load .env from an ABSOLUTE path, never the process cwd. Under launchd the cwd
// is unpredictable, so a bare dotenv.config() can silently fail to find .env —
// which flushes every config var (including the self-echo guard) and is exactly
// what triggered the self-messaging loop after a Mac restart. We try a few
// well-known absolute locations and load the first that exists, so wherever you
// keep the file among these it's found regardless of how the bridge is started:
//   1. $BRIDGE_ENV_PATH        explicit override (e.g. set in the launchd plist)
//   2. ~/.amber-bridge/.env    the bridge's persistent state dir
//   3. <script dir>/.env       next to bridge.js
//   4. <script dir>/../.env    one level up (repo root)
(function loadEnv() {
  const p = require('path');
  const fs = require('fs');
  const os = require('os');
  const candidates = [
    process.env.BRIDGE_ENV_PATH,
    p.join(os.homedir(), '.amber-bridge', '.env'),
    p.join(__dirname, '.env'),
    p.join(__dirname, '..', '.env'),
  ].filter(Boolean);
  for (const path of candidates) {
    if (fs.existsSync(path)) {
      require('dotenv').config({ path });
      console.log(`[env] loaded ${path}`);
      return;
    }
  }
  console.warn(`[env] no .env found in: ${candidates.join(', ')} — using hardcoded/shell values only`);
})();
const express = require('express');
const { spawn, execFile } = require('child_process');
const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.BRIDGE_PORT || '4720', 10);
const TOKEN = process.env.BRIDGE_TOKEN;
const WEBHOOK_URL = process.env.AMBER_WEBHOOK_URL;
const IMSG_BIN = process.env.IMSG_BIN || 'imsg';
const WATCH_ARGS = (process.env.IMSG_WATCH_ARGS || '--json').split(/\s+/).filter(Boolean);

// ── Self-handle guard ───────────────────────────────────────────────────────
// ALL of Amber's own iMessage handles — email(s) AND phone number(s). Any
// message whose sender is one of these is Amber talking to itself and must
// never be forwarded (echo-loop prevention). Set SELF_HANDLES to a
// comma-separated list; IMSG_FROM is folded in for back-compat.
function normalizeHandle(h) {
  const s = String(h || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) return s; // email — compare as-is
  const digits = s.replace(/[^0-9]/g, ''); // phone — compare by digits
  // Use the last 10 digits so +1 (555) 123-4567 == +15551234567 == 5551234567.
  return digits.length >= 10 ? digits.slice(-10) : digits;
}
// Hardcoded baseline — ALL of Amber's own iMessage handles. Kept in code (not
// only .env) so the self-echo guard is ALWAYS active even if .env fails to load
// after a restart. Add every alias Messages can be reached at: email + phone.
const HARDCODED_SELF_HANDLES = [
  'kuhu@ambermind.ai',
  // TODO: add Amber's iMessage phone number in E.164, e.g. '+15551234567'
];
const SELF_HANDLES = new Set(
  [...HARDCODED_SELF_HANDLES, process.env.SELF_HANDLES, process.env.IMSG_FROM]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map(normalizeHandle)
    .filter(Boolean)
);
function isSelfHandle(h) {
  const n = normalizeHandle(h);
  return !!n && SELF_HANDLES.has(n);
}

if (!TOKEN) {
  console.error('BRIDGE_TOKEN is required. Set it in .env.');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.warn('AMBER_WEBHOOK_URL not set — inbound events will only be logged.');
}
// The hardcoded baseline guarantees this is never empty, so the guard is always
// on — even if .env fails to load after a restart (which triggered the loop).
console.log(`[watch] self-echo guard active for ${SELF_HANDLES.size} handle(s): ${[...SELF_HANDLES].join(', ')}`);

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

// ── Auto-add senders to Contacts ────────────────────────────────────────────
//
// iMessage's "Share Name and Photo" only has Ask / Contacts-only. To get auto
// sharing, set the Messages setting to Contacts-only and ensure every sender
// is in the Mac's Contacts. We do that here: once per new handle, drop an
// entry into Contacts with the handle as both display name and email/phone.
//
// Permission note: the first run will prompt macOS for Contacts access for
// whatever shell launched bridge.js (Terminal, iTerm, tmux, etc). Approve it
// in System Settings → Privacy & Security → Contacts.

const KNOWN_HANDLES_FILE = path.join(
  process.env.AMBER_BRIDGE_STATE_DIR || path.join(os.homedir(), '.amber-bridge'),
  'known-handles.json',
);
const KNOWN_HANDLES = new Set();

function loadKnownHandles() {
  try {
    const raw = fs.readFileSync(KNOWN_HANDLES_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((h) => KNOWN_HANDLES.add(h));
  } catch {
    // missing/empty/corrupt — fine, start fresh
  }
}

function persistKnownHandles() {
  try {
    fs.mkdirSync(path.dirname(KNOWN_HANDLES_FILE), { recursive: true });
    fs.writeFileSync(
      KNOWN_HANDLES_FILE,
      JSON.stringify([...KNOWN_HANDLES]),
      'utf8',
    );
  } catch (err) {
    console.error('[contacts] persist failed:', err.message);
  }
}

function isPhoneHandle(handle) {
  // Apple writes phone handles as E.164 (e.g. +15551234567).
  return /^\+?\d[\d\s\-()]*$/.test(handle);
}

function ensureContact(rawHandle) {
  const handle = String(rawHandle || '').trim();
  if (!handle) return;
  if (KNOWN_HANDLES.has(handle)) return;
  // Mark optimistically so concurrent inbound messages don't queue up
  // multiple osascript runs for the same person.
  KNOWN_HANDLES.add(handle);
  persistKnownHandles();

  const phone = isPhoneHandle(handle);
  // AppleScript string escaping: backslash + double-quote only.
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const value = esc(handle);
  const propType = phone ? 'phone' : 'email';
  const propLabel = phone ? 'mobile' : 'iMessage';

  // Display name: keep it identifiable in Contacts. iMessage only needs the
  // handle to match — the name doesn't matter for Share Name/Photo.
  const displayName = `iMessage ${handle}`;
  const escName = esc(displayName);

  const script = `
    tell application "Contacts"
      set newPerson to make new person with properties {first name:"${escName}"}
      make new ${propType} at end of ${propType}s of newPerson with properties {label:"${propLabel}", value:"${value}"}
      save
    end tell
  `;

  execFile('osascript', ['-e', script], { timeout: 10000 }, (err, _stdout, stderr) => {
    if (err) {
      const msg = stderr?.toString().trim() || err.message;
      console.error(`[contacts] add failed for ${handle}: ${msg}`);
      // Allow a retry on the next message from this sender.
      KNOWN_HANDLES.delete(handle);
      persistKnownHandles();
    } else {
      console.log(`[contacts] added ${handle}`);
    }
  });
}

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

  // Belt and suspenders: if the sender is one of OUR OWN handles, it can't be a
  // real inbound message — drop it. This is what prevents self-echo loops when
  // Amber ends up in a thread with its own address: the self-message can arrive
  // on a different alias than it was sent from (email vs phone), marked
  // is_from_me=false, so we must match against ALL of Amber's handles, not one.
  if (isSelfHandle(from)) {
    console.log(`[watch] dropping self-addressed message from ${from}`);
    return;
  }
  // Alias-agnostic self-thread guard: if the sender equals the handle this Mac
  // RECEIVED on (destination_caller_id), it's Amber talking to Amber — drop it,
  // no matter which handle that is. This catches the loop even if a specific
  // alias isn't in HARDCODED_SELF_HANDLES.
  const dest = obj.destination_caller_id ?? obj.chat_identifier ?? obj.chat?.identifier ?? null;
  if (dest && normalizeHandle(dest) === normalizeHandle(from)) {
    console.log('[watch] dropping self-thread message (sender == destination)');
    return;
  }

  const senderHandle = String(from).trim();

  // Fire-and-forget: make sure this sender exists in Mac Contacts so the
  // iMessage "Share Name and Photo" auto-share (Contacts-only mode) works.
  ensureContact(senderHandle);

  forwardToAmber({
    event_id: String(eventId),
    from: senderHandle,
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
loadKnownHandles();
app.listen(PORT, () => {
  console.log(`Amber iMessage bridge listening on :${PORT}`);
  startWatcher();
});
