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
git checkout e3a078cc8aeb0f024672a169eeac6a5799634973
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
activity detector has nothing to answer. A real conversation on Windows still
requires a camera and microphone — a phone on the same LAN against
`HOST=0.0.0.0` with the token in the URL, or a machine with recording hardware.
