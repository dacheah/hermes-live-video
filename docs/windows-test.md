# Testing on Windows (PowerShell)

This exercises the plugin's Windows process handling on a real host, without
installing Hermes. It proves the parts that Linux cannot: that the relay is
spawned into its own process group, that liveness does not terminate the process
it is checking, and that `stop` kills the relay *and* its Python tracker.

Run each line on its own — one command per paste.

## 1. Check what is already installed

```powershell
node -v
```

```powershell
py --version
```

```powershell
git --version
```

Anything that errors is missing; install it with the line below and open a **new**
PowerShell window afterwards so `PATH` is refreshed.

```powershell
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
```

```powershell
winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
```

## 2. Get the plugin at the pinned commit

```powershell
git clone https://github.com/dacheah/hermes-live-video "$env:USERPROFILE\hlv"
```

```powershell
cd "$env:USERPROFILE\hlv"
```

```powershell
git checkout 66c5479d0bdb3964375801d4e49990c83908ac05
```

## 3. Install the relay's dependencies

```powershell
npm ci
```

```powershell
py -m pip install --quiet numpy pillow torch
```

```powershell
py -c "import numpy, PIL, torch; print('deps ok', torch.__version__)"
```

The torch download is a few hundred MB; the tracker runs it on CPU and downloads
no weights.

## 4. Give the relay a key for this shell

The key is read from the environment in this test mode, and is never written to
disk by the plugin.

```powershell
$env:GEMINI_API_KEY = Read-Host 'Paste Gemini API key'
```

## 5. Run the self-test

Port 8097 so it cannot collide with a relay already on 8098.

```powershell
$env:LIVE_VIDEO_PORT = "8097"
```

```powershell
py tools.py --selftest
```

Expected shape of the output:

```
platform      : win32 (IS_WINDOWS=True)
node          : C:\Program Files\nodejs\node.exe
relay dir     : C:\Users\<you>\hlv
port          : 8097  bind: 127.0.0.1
  PASS  start reports ok
  url: http://127.0.0.1:8097/
  PASS  /healthz answers
  PASS  relay sees a key
  tracker available in relay: True
  PASS  stop reports ok
  PASS  pid no longer alive
  PASS  no tracker left behind
  PASS  port is free

self-test passed
```

Two lines to look at closely: `IS_WINDOWS=True` (so the Windows branch is the one
being exercised) and `no tracker left behind` (so `taskkill /T` reached the child,
not just node).

## 6. Optional: a real session in Edge

This is the end-to-end version — camera, audio and a live Gemini session on
Windows. Leave this window running while you use the page.

```powershell
$env:PORT = "8098"
```

```powershell
node server.js
```

Then open <http://127.0.0.1:8098/> in Edge, tap to start, allow camera and
microphone, and say hello. Loopback is a secure context, so the camera works
without a certificate or a firewall rule. Press `Ctrl+C` in the PowerShell window
to stop the relay when finished.

## What this does and does not prove

- **Proves:** the node binary resolution, the detached spawn, the liveness check,
  `taskkill /T` teardown, the relay's HTTP surface and (with step 6) a live session
  with camera and audio on Windows.
- **Does not prove:** the Hermes plugin loader path on Windows. That needs a native
  Hermes install, which this test deliberately avoids. If the self-test passes and
  step 6 works, the remaining risk is confined to the loader, not to the relay.

## Result on the reference host (Windows 11, 13 November 2026)

Run from `C:\Users\dache\hlv` at 1.3.3 with Node 24.18.0, Python 3.14.6 and
torch 2.12.1+cpu: eight checks passing — start, `/healthz` answering
`{"ok":true,"port":8097,"hasKey":true,"tracker":true}`, key seen, tracker
available, stop, pid gone, port free, no tracker orphaned. Two earlier attempts at
the same run found the `SystemRoot` defect and the self-matching scan; both are
fixed and covered by tests.

### Session run (1.3.4, same host)

Step 6 was then run with Chromium's synthetic devices, because the machine is a
mini PC with no microphone. The relay console and `transcript.log` recorded:

```
[live-video] client connected, opening upstream to Gemini Live...
[live-video] upstream connected to Gemini Live API, sending setup frame...
[live-video] Gemini setupComplete confirmed! Draining queued frames/audio...
[vision-tracker] Fixed-seed random-projection sketch initialised (anchor-frame drift model).
[live-video] client health: packets=100 ctx=running rate=16000 track=live vis=visible pctx=running pqueue=0
```

That establishes the parts a self-test cannot: the upstream Live handshake, the
WebSocket relay moving both audio packets and JPEG frames, the tracker child
accepting frames under the relay's own spawn with torch on Windows, and a
`taskkill` teardown that left no tracker behind (the process scan after two
sessions returned nothing).

It does **not** establish a spoken exchange. The transcript carried `AUDIO_START`
and `CLIENT_HEALTH` but no `USER:` or `JARVIS:` turn, which is the correct result
for a synthetic microphone: a fake device emits a tone, not speech, so the voice
activity detector has nothing to answer.

### LAN session with a real phone (1.3.4 → 1.3.7, same host)

The same relay was then bound to the LAN and driven from a phone, which is the only
configuration that exercises the token gate (`TOKEN_REQUIRED` is false on loopback)
and the only one with a real camera and microphone. A full spoken exchange worked —
`USER: All right, describe what you see.` answered with a correct description of the
keyboard, speakers and monitor — but it took four defects to get there, and each one
is now fixed and, where a test can reach it, tested.

**1. The page loaded and the start button did nothing (fixed in 1.3.5).**
`tokenMatches()` gated every request, and a `<script src="/client.js?v=13">` cannot
carry the `?token=` from the address bar, so the HTML was served and the JavaScript
was refused with `403 token required`: no handler was ever attached. A valid token on
the page request now also sets a `live_token` cookie, which the scripts, the worklet
and the socket present. Covered by `tests/test_token_gate.js` — 8 assertions driving
a real relay on `127.0.0.2:8096` with no browser and no key.

**2. `1008 Permission denied on the service` (operator error, worth documenting).**
Google answers `Method doesn't allow unregistered callers` for an empty key. The key
had been set in one PowerShell window and the relay was started in another; a fresh
window does not inherit it. `$env:GEMINI_API_KEY.Length` and `/healthz` are the two
checks that separate "no key" from "wrong key".

**3. The first spoken sentence was lost (fixed in 1.3.6).** `CLIENT_HEALTH` read
`packets=0 ctx=suspended` at the first tick whilst the badge already said
"Listening", then `packets=96 ctx=running` one tick later. The capture context had
been suspended by the permission flow; because the badge was unconditional, nothing
said so. Camera and microphone are now requested in a single `getUserMedia`, and the
badge is bound to the real state — "Tap for mic" whenever the context is not running
or the track is not live.

**4. The picture froze mid-session (fixed in 1.3.7).** Every frame in the log arrived
at exactly 58396 base64 characters, first to last: identical bytes mean the `<video>`
element had stopped painting and the canvas kept redrawing its last frame, so the
model described a desk that had stopped moving and contradicted the user about it.
The cause was 1.3.6's own change — the element had been attached to the *combined*
camera-and-microphone stream, and a media element carrying an audio track can be
paused by an audio-focus change whilst its video track still reports `live`. The
element now takes the video track alone and is muted; a paused element is revived on
each capture tick and on any gesture; and identical frames are detected client-side,
announced as "Camera feed frozen — tap the screen to resume", and suppressed to one
every ten seconds so the model is not fed duplicates.

What that session proves: the relay, the token gate, the Live handshake, the tracker,
a real spoken exchange and camera description, all on Windows 11 from a phone on the
LAN. What it does not prove: the Hermes plugin loader on Windows, and the freeze
detection itself has no automated test — it was confirmed by the session that followed.
