# How it works

```
phone browser                 relay (Node, :8098)                     Google
─────────────                 ───────────────────                     ──────
mic worklet ──16 kHz PCM─────► WebSocket ──────────────────────────► Gemini Live
camera ──JPEG @4 fps─────────►   │                                      (duplex
                                 │                                       audio)
                                 ├──► vision_tracker.py (stdin/stdout)
                                 │      seeded random-projection sketch
                                 │      anchor-frame drift → VISION_EVENT
                                 │
                                 ├──► watch verifier ───────────────► vision model
                                 │      "is the thing there yet?"       (per look)
                                 │
                                 └──► transcript.log + server.log
                                          ▲
                                          │ read-only
                                    Hermes plugin (live_video)
```

## The audio path

The browser captures 16 kHz mono PCM in an `AudioWorklet`, posts it over a WebSocket,
and the relay forwards base64 chunks to the Gemini Live bidirectional endpoint. Model
audio comes back on the same socket and is scheduled through a single `AudioContext`
so playback is continuous rather than per-message. The context is unlocked
synchronously inside the user's Start gesture — a resumed-from-idle context silently
drops audio, which is the classic failure of this design.

Activity detection is server-side (`silenceDurationMs: 500`, barge-in enabled), so
the user can interrupt a reply simply by speaking.

## Frames and the change detector

The browser sends a JPEG frame every 400 ms. Each frame goes to `vision_tracker.py`
over stdin; it returns one JSON line per frame with the distance to an **anchor**
frame — the last scene it considered settled — rather than to the previous frame. A
purely pairwise delta is blind to slow re-entry: an object returning over several
frames changes each step by less than the threshold. Drift against an anchor
accumulates across the whole interval and sees the arrival.

Two thresholds (0.35 major / 0.22 moderate) with different refractory periods, plus a
slow anchor blend while the scene is settled, absorb lighting drift. Scenes described
in the last 30 seconds are remembered, so a glance back at one does not produce a
second description.

The sketch itself is random by design and seeded, so it is identical on every host; the
semantic judgement belongs to the model, not to a convolution.

## Watch mode

A user request ("let me know when …") arms a 90-second window with the sentence. Each
settled frame is shown to the verifier with the sentence, and the verifier answers
VISIBLE / not yet. On VISIBLE the relay injects a single context turn telling the model
to say so, and the window closes. If the window ends empty, it asks whether to keep
watching; a yes re-arms it with the same sentence.

Scene changes are privileged: they bypass the minimum check interval, and if a check is
already in flight they queue behind it rather than aborting it (aborting was measured
worse — it burned quota and delayed the sighting from 7.2 s to 14 s).

A 429 is terminal for the window: the relay reads the response's own retry hint, blocks
until then, and logs `rate limited` instead of retrying every few seconds.
`WATCH_MAX_CHECKS` caps the spend per window and gates the request, not just the log.

## The plugin

`live_video` is one tool with six actions. It reads the relay's own artefacts
(`/healthz`, `transcript.log`, `server.log`, `systemctl --user show`) and can spawn the
relay with the key taken from Hermes' secret scope. It never joins the audio path and
never restarts a service it did not start.
