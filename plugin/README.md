# live-video

The Hermes control surface for the Live Video relay: a phone-camera conversation
with duplex voice, a local frame-change tracker, and a verifier-backed watch mode.

One tool, `live_video`, six actions:

- **start** — launch the relay if it is not already up. Returns the local and LAN
  URLs, the pid and `/healthz`. The Gemini key is read through Hermes' secret scope
  and passed to the child in its environment; it is never written to disk.
- **stop** — stop a relay this plugin started. A relay run as a systemd service is
  left to systemd, and `stop` says so rather than killing it.
- **url** — the address to open on the phone, plus health.
- **status** — `/healthz`, the systemd unit's state and restart count, whether a
  tracker is running, transcript size, and the watch state. `watch.state` follows the
  **last** `WATCH_*` event (`armed` / `fired` / `expired` / `none`); `watch.armed` is
  true only if that event is ARMED/REARMED, a tracker is running, and the age is
  inside the window.
- **session** — the last N transcript lines, parsed into tag counts, the covered
  window, user and model turns, and every `WATCH_*` event.
- **checks** — how the watch verifier behaved, **grouped per armed window**: sentence,
  `armed_at`, outcome (`sighted`, `ended: <reason>`, `open`), VISIBLE / not yet /
  unavailable / rate-limited counts, triggers and latency stats. `since` (ISO-8601)
  keeps only windows at or after a cutoff.

Nothing here joins the relay's audio path or reconfigures it.

## Watch mode and how a check is answered

A watch asks one question — is the thing you named in frame now? — and answers it by
opening a **short Live session** (`lib/verifier.js`, mode `live`), sending the frame and
a one-line question, and reading the reply. The same model that is already holding the
frames answers, so a check costs no extra REST quota, and it measured **0.8–3.3 s** per
verdict against 3.1–6.9 s through generate-content.

`auto` is the default: live first, then one generate-content call if the live transport
fails. `generate` pins the REST path; `live` pins the Live path. A 429 carries its own
retry hint, which is honoured — one rate-limited request, then no further calls until
the hint expires, each blocked check logged as `rate limited` rather than stalling twice.

Every check is stamped into the transcript as well as stdout, because `server.log` has
no clocks and a check cannot otherwise be attributed to the window it belongs to:

```
[2026-11-12T16:03:32.874Z] WATCH_CHECK: n=1 trigger=scene change verdict=visible model=live ms=1126
```

`checks` returns those per window, including an `events` array that names the transport
behind each verdict.

On a free key, cap the spend with a systemd drop-in:

```
~/.config/systemd/user/hermes-live-video.service.d/quota-free-tier.conf
  Environment=WATCH_HEARTBEAT_MS=0     # scene-change only, no heartbeat
  Environment=WATCH_MAX_CHECKS=3       # hard cap per watch window
```

Delete it and `systemctl --user daemon-reload` once the key is billed. The startup log
states the live configuration on every restart:

```
[live-video] watch mode: window=90s settle=1000ms heartbeat=disabled (scene change only)
             max_checks=3 verifier=auto(gemini-3-flash-preview) live=models/gemini-3.8-live
```

## Config

Optional entries under `plugins.entries.live-video` in `config.yaml`:

| key | default |
|---|---|
| `relay_dir` | `~/hermes-live-video` (expanded per user; `$VARS` also expanded) |
| `port` | `8098` |
| `bind` | `0.0.0.0` (set `127.0.0.1` to keep a started relay loopback-only) |
| `node_bin` | `""` — `node` on PATH, then Hermes' bundled node |
| `unit` | `hermes-live-video` (systemd **user** unit) |
| `default_lines` | `40` |
| `max_lines` | `200` |
| `window_s` | `90` |

`LIVE_VIDEO_RELAY_DIR`, `LIVE_VIDEO_PORT` and `LIVE_VIDEO_STATE_DIR` override for tests.

## Running it against your own relay

Nothing here is tied to one deployment. The plugin reads local files and probes
`http://127.0.0.1:<port>/healthz` — it never calls out to anyone's website, and its
default `relay_dir` is a path inside *your* home directory. Point `relay_dir` at your
own checkout and your own `GEMINI_API_KEY` pays for your watches.

It does assume the shape of this relay: `transcript.log` and `server.log` in the
checkout, and a `vision_tracker.py` process for the tracker count. If your relay
differs, those are what to change — and if your relay is not a systemd unit at all,
`status` reports the unit as absent rather than failing.

If the checkout is missing, every action answers with the path it looked for and the
setting to change, rather than an empty result.

## Tests

```bash
cd plugin && python3 tests/test_handlers.py    # 25 tests, stdlib only
hermes plugins validate .                     # manifest, capabilities, security scan
```

Fixtures are real relay log lines: window grouping, `since`, undated windows,
rate-limited and pre-empted verdicts, watch state after a sighting and after expiry,
and the lifecycle paths (already running, missing checkout, missing key, nothing to
stop).

## Deliberately absent

Arming or disarming a watch from chat still needs a small control API in `server.js`
(`POST /watch`, `DELETE /watch`). That is a relay change, and it is the next slice
rather than part of this one. Watch mode is armed by voice, in session.

## Rollback

```bash
hermes plugins disable live-video
```
