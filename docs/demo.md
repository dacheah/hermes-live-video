# 90-second demo

The hackathon asks for a video strictly under 90 seconds that shows the plugin
working. This is the shot list, timed. Read the "Pre-flight" list before recording.

## Pre-flight

1. Relay is up: `curl -s http://127.0.0.1:8098/healthz` → `{"ok":true,…,"tracker":true}`.
2. Phone on the same Wi-Fi as the machine running the relay, page open, camera and
   microphone allowed (a secure origin — HTTPS tunnel or `localhost` — or the browser
   will refuse the camera).
3. One prop that produces a large scene change: a blue image full-screen on a laptop,
   a blue folder, a bright cloth.
4. Desktop Hermes session open, font size up, and the repo page open in a tab.
5. Watch verification needs quota. On a free key, check it once before recording; a
   429 means the sighting will not be voiced.

## The shot list

| Time | On screen | Say / do |
|---|---|---|
| 0:00–0:06 | Phone, the Live page, thumb on **Start** | "This is Hermes. Live." |
| 0:06–0:16 | Start the session; camera shows the desk | "What are you seeing?" — the agent names real objects |
| 0:16–0:24 | Slow pan across the room | Nothing: the agent stays quiet unless asked |
| 0:24–0:40 | Back to the desk | "Let me know when the screen turns blue." It agrees. Bring the blue into frame |
| 0:40–0:50 | The blue in frame, agent speaking | It says the blue is showing — once, then quiet |
| 0:50–1:05 | Desktop, same session | "How did that watch go?" → the `checks` receipt: window, verdict, latency |
| 1:05–1:20 | Desktop | "Start live video" → URL, pid, health; "what happened in the last session?" → counts and turns |
| 1:20–1:28 | Repo page | "Open source, MIT — the relay and the plugin." |

## Recording notes

- The phone's own screen recorder captures the agent's voice; that is the cleanest
  audio, because the model audio plays on the phone.
- Expect 3–7 seconds between the blue appearing and the agent speaking: it verifies
  the frame with a second model before claiming the sighting. Do not cut it out — say
  nothing and let it land.
- If the video runs long, cut 0:16–0:24 first. Keep the watch, the receipt, and the
  `start` action.
- Export at 1080p, under 90 seconds exactly. Check the duration before posting.
