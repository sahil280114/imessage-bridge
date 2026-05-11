# Amber iMessage bridge

Tiny HTTP service that runs on a Mac signed into the **Amber Apple ID**.
Wraps [`imsg`](https://github.com/openclaw/imsg) so the Amber backend (on
Railway) can send + receive iMessages over Tailscale.

```
Amber backend ──Tailscale──▶ bridge (this) ──imsg──▶ Messages.app
                                  │
                                  └──webhook──▶ Amber backend
```

---

## 1. One-time Mac setup

You should already have done these in the dedicated-Mac onboarding:

- [x] Signed into the **Amber Apple ID** in System Settings → Apple ID
- [x] Messages.app signed in, iMessage activated, conversations confirmed working
- [x] Installed `imsg`:  `brew install steipete/tap/imsg`
- [x] Granted **Terminal** (or whichever shell launches the bridge) Full Disk Access
      in System Settings → Privacy & Security → Full Disk Access
- [x] Installed Tailscale and noted the Mac's tailnet IP (e.g. `100.78.34.3`)
- [x] `caffeinate -dimsu` (or Amphetamine) keeping the Mac awake

Quick sanity test:
```bash
imsg send --to "you@icloud.com" --text "ping from amber bridge"
imsg watch --json     # leave running, send yourself a message, see JSON
```

---

## 2. Install the bridge

```bash
cd /path/to/amber/imessage-bridge
npm install
cp .env.example .env
```

Edit `.env`:

```bash
BRIDGE_PORT=4720
BRIDGE_TOKEN=<openssl rand -hex 24>             # 48+ char random string
AMBER_WEBHOOK_URL=https://api.your-amber.com/imessage/webhook
IMSG_FROM=amber@example.com                      # the Amber Apple ID handle
```

Save the same `BRIDGE_TOKEN` — you'll set it on Railway too.

Test it interactively:
```bash
node bridge.js
# In another shell:
curl http://localhost:4720/health
curl -X POST http://localhost:4720/send \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"your-phone-or-email","text":"hello from the bridge"}'
```

You should see Messages.app deliver the text, and `imsg watch` lines should
arrive on stdout as you receive replies.

---

## 3. Run it on boot (launchd)

```bash
# Edit the plist — replace the two PLACEHOLDER paths with your absolute paths.
$EDITOR com.amber.imessage-bridge.plist

# Install + load
cp com.amber.imessage-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.amber.imessage-bridge.plist

# Verify
launchctl list | grep amber
tail -f /tmp/amber-imessage-bridge.out.log
```

Reload after editing the plist:
```bash
launchctl unload ~/Library/LaunchAgents/com.amber.imessage-bridge.plist
launchctl load   ~/Library/LaunchAgents/com.amber.imessage-bridge.plist
```

If the bridge can't reach `imsg`, double-check that the **node binary path**
in `ProgramArguments` is correct (`which node`) and that Terminal — or the
launchd context — has Full Disk Access.

---

## 4. Backend env (Railway)

Set on the `amber-backend` service:

| Key | Value |
| --- | --- |
| `IMESSAGE_BRIDGE_URL`   | `http://<mac-tailscale-ip>:4720` (e.g. `http://100.78.34.3:4720`) |
| `IMESSAGE_BRIDGE_TOKEN` | same value as `BRIDGE_TOKEN` above |
| `IMESSAGE_FROM`         | the Amber Apple ID handle (display only) |
| `TS_AUTHKEY`            | a Tailscale auth key — see Tailscale section below |

---

## 5. Tailscale on Railway

`start.sh` boots Tailscale in **userspace mode** before launching Node. You
need:

1. Generate a reusable, ephemeral auth key:
   <https://login.tailscale.com/admin/settings/keys>
2. Set `TS_AUTHKEY` on Railway.
3. Tell Railway to use `./start.sh`. Easiest:
   - `Procfile` in `amber-backend/` already declares `web: ./start.sh`.
   - On Railway: Settings → Deploy → **Start Command** = `./start.sh`
     (or leave blank if your buildpack honors `Procfile`).
4. After the first deploy, confirm both nodes appear on
   <https://login.tailscale.com/admin/machines>:
   - `amber-api` (Railway)
   - your Mac

If `amber-api` is up but pings fail, check Tailscale ACLs — both devices
should be in the same tailnet with no deny rules between them.

---

## 6. Smoke test end-to-end

1. Open the Amber web app → **Settings → iMessage** → tap **Link iMessage**.
2. Messages opens prefilled with `link 123456` to the Amber handle. Send it.
3. Within a few seconds the panel flips to "linked to <your-handle>".
4. From the same iMessage thread, send "hey amber" — you should get a reply
   in iMessage (and the message + reply should appear in the Amber web chat
   under a new `channel='imessage'` session).

---

## Troubleshooting

- **bridge logs `[forward] 401`** — `BRIDGE_TOKEN` mismatch between Mac and
  Railway. They must be identical.
- **Sends 200 OK but message never arrives** — handle isn't an iMessage user
  *and* the Amber Apple ID doesn't have SMS forwarding from a paired iPhone.
  Either pair an iPhone for SMS or only message Apple IDs for now.
- **`imsg watch` exits immediately** — Terminal (or the launchd process) is
  missing Full Disk Access. Re-grant and reload.
- **Webhook never fires** — confirm `AMBER_WEBHOOK_URL` points at the public
  API (Railway domain), not `localhost`. The Mac calls *out* to the API;
  it's the API that calls *in* over Tailscale.
- **Multiple replies from Amber** — every inbound goes through dedupe via
  `event_id`; if you're hammering the bridge in dev, restart it to clear
  any state.

---

## Files

| File | Purpose |
| --- | --- |
| `bridge.js`                            | Express server + `imsg watch` supervisor |
| `package.json`                         | deps: express, dotenv, node-fetch |
| `.env.example`                         | template for `.env` |
| `com.amber.imessage-bridge.plist`      | launchd agent (RunAtLoad + KeepAlive) |
