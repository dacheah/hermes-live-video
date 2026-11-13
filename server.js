#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const { createVerifier } = require('./lib/verifier');

const PORT = Number(process.env.PORT || 8098);
const HOST = process.env.HOST || '127.0.0.1';

// --- Access control ----------------------------------------------------------
// Loopback is the default and needs no credential. The moment the relay is
// bound beyond it, anyone who can route to the port could open the page, run a
// Gemini session on the user's key and have their speech written to the
// transcript the model later reads. So a non-loopback bind requires a token,
// and the token is minted per start and handed back in the URL.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const TOKEN_REQUIRED = !LOOPBACK_HOSTS.has(HOST);
let LIVE_TOKEN = (process.env.LIVE_TOKEN || '').trim();
if (TOKEN_REQUIRED && !LIVE_TOKEN) {
  LIVE_TOKEN = crypto.randomBytes(24).toString('base64url');
  console.log('[live-video] no LIVE_TOKEN supplied for a non-loopback bind; minted one for this process');
}

function tokenMatches(req, url) {
  if (!TOKEN_REQUIRED) return true;
  const supplied = String(
    url.searchParams.get('token') || req.headers['x-live-token'] || ''
  );
  const a = Buffer.from(supplied);
  const b = Buffer.from(LIVE_TOKEN);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// A browser sends Origin; a cross-site page would carry a foreign one. Compare
// against the host the request was actually addressed to.
function originMatches(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host || '');
  } catch (_) {
    return false;
  }
}
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Persona -----------------------------------------------------------------
// Deployment-specific identity lives in the environment or in a file beside the
// relay, never hardcoded in the source: a catalogue install must not inherit
// anyone's name. Set LIVE_USER_NAME (used in relay-injected context) and either
// LIVE_SYSTEM_PROMPT_FILE or LIVE_SYSTEM_PROMPT (the model's instruction).
const USER_NAME = process.env.LIVE_USER_NAME || 'the user';
const USER_ADDRESS = process.env.LIVE_USER_ADDRESS || 'sir';

const DEFAULT_PERSONA = [
  'You are a voice assistant with a live camera.',
  'Speak concisely and naturally, in complete sentences.',
  `Hard language pin: reply strictly and exclusively in English, whatever language the user speaks or however their speech is transcribed. Address the user as '${USER_ADDRESS}'.`,
  'Only comment on what is genuinely visible in the camera feed; if the image is absent, dark, unclear or not in frame, state plainly that you cannot see it rather than guessing or fabricating visual details.',
  'Respond in sub-second duplex.',
  'You cannot watch the feed between turns or speak unprompted, but the relay watches for you when the user asks: it checks the view every few seconds and tells you the moment the thing appears, and it puts a question to you at the window\'s end if nothing did.',
  'So if the user asks to be told when something comes into view, agree briefly — that promise is kept.',
  'Never claim to be monitoring anything yourself, and never repeat an alert twice.'
].join(' ');

function getSystemPrompt() {
  const file = process.env.LIVE_SYSTEM_PROMPT_FILE;
  if (file) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    } catch (_) {}
  }
  const inline = (process.env.LIVE_SYSTEM_PROMPT || '').trim();
  return inline || DEFAULT_PERSONA;
}

const SYSTEM_PROMPT = getSystemPrompt();

// --- Local frame-change tracker ----------------------------------------------
// vision_tracker.py needs numpy, Pillow and torch. Resolve an interpreter that
// has them rather than assuming one machine's virtualenv path.
function resolvePython() {
  const candidates = [
    process.env.PYTHON_BIN,
    path.join(__dirname, '.venv', 'bin', 'python3'),
    'python3',
    '/usr/bin/python3'
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      const probe = spawnSync(bin, ['-c', 'import numpy, PIL, torch'], { timeout: 20000 });
      if (probe.status === 0) return bin;
    } catch (_) {}
  }
  return null;
}
const PYTHON_BIN = resolvePython();
if (!PYTHON_BIN) {
  console.log('[live-video] no python with numpy+Pillow+torch found — running without local frame-change detection (set PYTHON_BIN to fix)');
}


function getApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  // The relay reads its own key: environment first (the Hermes plugin passes it
  // from the agent's secret scope), then this app's own config file. It never
  // reads another application's credential store.
  const paths = [
    path.join(process.env.HOME || os.homedir(), '.hermes', 'hermes-live', 'config.env'),
    path.join(__dirname, 'config.env')
  ];
  for (const p of paths) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      for (let line of content.split('\n')) {
        line = line.trim();
        if (line.startsWith('#')) continue;
        const m = /^GEMINI_API_KEY=\s*[\"']?([^\"'\s]+)[\"']?/.exec(line);
        if (m && m[1] && !m[1].includes('your_gemini')) {
          return m[1].trim();
        }
      }
    } catch (_) {}
  }
  return '';
}

const GEMINI_BASE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Visual scene-change alerts are silent by default: the context turn keeps the
// model's view current but asks for no spoken answer. Set VISION_VOICE_ALERTS=1
// to have JARVIS acknowledge each change aloud (testing only).
const VISION_VOICE_ALERTS = process.env.VISION_VOICE_ALERTS === '1';
const VISION_CONTEXT_TEXT = VISION_VOICE_ALERTS
  ? '[SYSTEM CONTEXT: Significant visual scene change detected in the camera feed. In one brief, natural sentence, acknowledge what has changed or what you now see in view, sir.]'
  : '[SYSTEM CONTEXT: The camera view has changed. Update your understanding of what is now in frame. Do not comment on it unless asked.]';

// --- Watch mode ---------------------------------------------------------------
// The upstream model cannot watch the feed between turns, so when Dan asks to be
// told when something comes into view the relay arms itself: the next settled
// scene change is injected as a voiced turn, the model answers once, and the
// watch disarms. One request, one answer — never per-change narration.
const WATCH_WINDOW_SECONDS = Number(process.env.WATCH_WINDOW_SECONDS || 90);
const WATCH_SETTLE_MS = Number(process.env.WATCH_SETTLE_MS || 1000);
const WATCH_HEARTBEAT_MS = Number(process.env.WATCH_HEARTBEAT_MS ?? 5000);   // 0 disables it
const WATCH_CHECK_MIN_INTERVAL_MS = Number(process.env.WATCH_CHECK_MIN_INTERVAL_MS || 4000);
// A hard cap per watch window. The free tier allows 20 generate-content calls a
// day for the verifier model, so an uncapped watch could eat a whole day's quota.
const WATCH_MAX_CHECKS = Number(process.env.WATCH_MAX_CHECKS || 18);

// A 429 carries its own retry hint ("16h55m31.19s"); use it rather than guessing.
function retryDelayMs(body) {
  const details = (body && body.error && body.error.details) || [];
  for (const detail of details) {
    if (typeof detail.retryDelay === 'string') {
      const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(detail.retryDelay);
      if (m) return ((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (parseFloat(m[3]) || 0)) * 1000;
    }
  }
  return null;
}

const WATCH_CUE = /(?:let me know|tell me|notify me|alert me|inform me|keep an eye out)\s+(?:when|if|once|as soon)\b/i;
// "Yes, keep watching" after the window-end prompt re-arms the same watch.
const WATCH_CONTINUE = /^(?:yes|yeah|yep|sure|please|okay|ok|go on|keep (?:watching|going|an eye)|continue|carry on)\b/i;
// The verifier answers YES/NO about a single frame; it is a different job from
// the conversational model, which is why it runs out of band and never speaks.
// One model only: the old fallback gemini-3.8-flash hung past 180s on an image
// prompt (measured 2026-11-12), so a "fallback" there was a delay, not a rescue.
const VERIFIER_MODELS = (process.env.WATCH_VERIFIER_MODELS || 'gemini-3-flash-preview').split(',');
const VERIFIER_TIMEOUT_MS = Number(process.env.WATCH_VERIFIER_TIMEOUT_MS || 8000);

// Watch verification runs on the Live session by default: the same model already
// holds the frames, it answers in 0.8–3.3 s, and it draws on a different quota
// from generateContent, which the free tier rations to 20 calls a day.
// 'live' | 'generate' | 'auto' (live first, generate as the fallback).
const WATCH_VERIFIER_MODE = (process.env.WATCH_VERIFIER_MODE || 'auto').toLowerCase();
const LIVE_MODEL = process.env.LIVE_MODEL || 'models/gemini-3.8-live';
const verifier = createVerifier({
  getApiKey,
  mode: ['live', 'generate', 'auto'].includes(WATCH_VERIFIER_MODE) ? WATCH_VERIFIER_MODE : 'auto',
  models: VERIFIER_MODELS,
  liveModel: LIVE_MODEL,
  timeoutMs: VERIFIER_TIMEOUT_MS,
  log: console
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') {
    const key = getApiKey();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, port: PORT, hasKey: Boolean(key), tracker: Boolean(PYTHON_BIN) }));
  }

  if (!originMatches(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('cross-origin request refused');
  }
  if (!tokenMatches(req, url)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('token required: open the URL the plugin returned');
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws' || !originMatches(req) || !tokenMatches(req, url)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    console.log('[live-video] client connected, opening upstream to Gemini Live...');
    const key = getApiKey();
    const upstream = new WebSocket(GEMINI_BASE_WS, {
      headers: { 'x-goog-api-key': key }
    });
    const queuedMessages = [];
    let setupReady = false;
    let audioCount = 0;
    const unknownTypes = new Set();
    let lastHealthShape = null;

    // --- Watch mode state (per connection) -----------------------------------
    // armed -> verifier asks a vision model of each settled frame "is it there
    // yet?" -> YES fires one voiced alert; window end with no sighting asks
    // whether to keep watching.
    let watch = null;        // { sentence, armedAt, timer, heartbeat, checks, evalBusy, fired, pendingScene }
    let watchExpiry = null;
    let pendingContinue = null;
    let lastFrameB64 = null;
    let lastFrameAt = 0;
    let verifierBlockedUntil = 0;   // set from a 429's retry hint; no calls until then

    let audioOutParts = 0;
    let audioOutBytes = 0;
    let audioOutStamped = false;

    function appendTranscript(line) {
      fs.appendFileSync(path.join(__dirname, 'transcript.log'), `[${new Date().toISOString()}] ${line}\n`);
    }

    function clearWatchTimers() {
      if (watchExpiry) { clearTimeout(watchExpiry); watchExpiry = null; }
      if (watch) {
        if (watch.timer) { clearTimeout(watch.timer); watch.timer = null; }
        if (watch.heartbeat) { clearInterval(watch.heartbeat); watch.heartbeat = null; }
      }
    }

    function disarmWatch(reason, { prompt = false } = {}) {
      const sentence = watch ? watch.sentence : null;
      const fired = watch ? watch.fired : false;
      clearWatchTimers();
      watch = null;
      if (!sentence || fired) return;
      console.log(`[live-video] watch ended without a sighting: ${reason}`);
      appendTranscript(`WATCH_EXPIRED: ${reason}`);
      if (prompt && upstream.readyState === WebSocket.OPEN && setupReady) {
        pendingContinue = sentence;
        upstream.send(JSON.stringify({
          clientContent: {
            turns: [{
              role: 'user',
              parts: [{
                text: `[SYSTEM CONTEXT: ${USER_NAME} asked you to be told when ${sentence}. The monitoring window has now ended and it has not appeared. Ask them briefly whether they would like you to keep watching for another ${WATCH_WINDOW_SECONDS} seconds.]`
              }]
            }],
            turnComplete: true
          }
        }));
      }
    }

    function armWatch(sentence) {
      disarmWatch('superseded by a new request');
      pendingContinue = null;
      watch = { sentence, armedAt: Date.now(), timer: null, heartbeat: null, checks: 0, evalBusy: false, fired: false, pendingScene: false, budgetLogged: false };
      console.log(`[live-video] watch armed for ${WATCH_WINDOW_SECONDS}s: ${sentence}`);
      appendTranscript(`WATCH_ARMED: ${sentence}`);
      watchExpiry = setTimeout(() => disarmWatch('window elapsed', { prompt: true }), WATCH_WINDOW_SECONDS * 1000);
      // A small object can enter frame without moving the anchor past its
      // threshold, so check on a slow heartbeat as well as on scene changes.
      // Set WATCH_HEARTBEAT_MS=0 on a metered quota: scene changes still fire.
      if (WATCH_HEARTBEAT_MS > 0) {
        watch.heartbeat = setInterval(() => evaluateWatch('heartbeat'), WATCH_HEARTBEAT_MS);
      }
    }

    // A pan raises a burst of events; the last of them is the view he is
    // actually holding, so wait for it to settle before asking the verifier.
    function noteSceneChange() {
      if (!watch || watch.fired) return;
      if (watch.timer) clearTimeout(watch.timer);
      watch.timer = setTimeout(() => evaluateWatch('scene change'), WATCH_SETTLE_MS);
    }

    // The verifier now lives in lib/verifier.js so it can be tested directly.
    // This wrapper keeps the watch loop's logging and rate-limit state exactly
    // as they were, and translates a 429 into the block the loop honours.
    async function askVerifier(sentence, frameB64) {
      const result = await verifier.look(sentence, frameB64);
      if (result && result.rateLimited) {
        verifierBlockedUntil = Date.now() + Math.min(result.waitMs ?? 120000, 600000);
        console.warn(`[live-video] verifier rate limited — next look in ${Math.round((verifierBlockedUntil - Date.now()) / 1000)}s`);
      }
      return result;
    }

    async function evaluateWatch(trigger) {
      if (!watch || watch.fired) return;
      if (!lastFrameB64 || Date.now() - lastFrameAt > 3000) return;
      const isScene = trigger.startsWith('scene change');
      // A heartbeat already in flight must not swallow a real scene change: queue
      // it and run the moment the current check returns. This was the defect that
      // let two vision events in one session pass with no scene-change check.
      if (watch.evalBusy) {
        if (isScene) watch.pendingScene = true;
        return;
      }
      if (watch.checks >= WATCH_MAX_CHECKS) {
        if (!watch.budgetLogged) {
          watch.budgetLogged = true;
          console.log(`[live-video] watch budget spent (${WATCH_MAX_CHECKS} checks) — window stays open, no further looks`);
          appendTranscript(`WATCH_BUDGET: ${WATCH_MAX_CHECKS} checks used`);
        }
        return;
      }
      if (Date.now() < verifierBlockedUntil) {
        watch.checks++;
        console.log(`[live-video] watch check ${watch.checks} (${trigger}): rate limited`);
        return;
      }
      const now = Date.now();
      if (!isScene && now - (watch.lastEvalAt || 0) < WATCH_CHECK_MIN_INTERVAL_MS) return;
      watch.lastEvalAt = now;
      watch.evalBusy = true;
      watch.checks++;
      const checkNo = watch.checks;
      const sentence = watch.sentence;
      const frame = lastFrameB64;
      let result = null;
      try {
        result = await askVerifier(sentence, frame);
      } finally {
        if (watch) {
          watch.evalBusy = false;
          if (watch.pendingScene && !watch.fired) {
            watch.pendingScene = false;
            setImmediate(() => evaluateWatch('scene change (queued)'));
          }
        }
      }
      if (result && result.rateLimited) {
        console.log(`[live-video] watch check ${checkNo} (${trigger}): rate limited`);
        appendTranscript(`WATCH_CHECK: n=${checkNo} trigger=${trigger} verdict=rate_limited model=none ms=0`);
        return;
      }
      if (!result) {
        console.log(`[live-video] watch check ${checkNo} (${trigger}): verifier unavailable`);
        appendTranscript(`WATCH_CHECK: n=${checkNo} trigger=${trigger} verdict=unavailable model=none ms=0`);
        return;
      }
      console.log(`[live-video] watch check ${checkNo} (${trigger}): ${result.visible ? 'VISIBLE' : 'not yet'} — ${result.model} ${result.ms}ms`);
      // Stamped into the transcript as well as stdout: server.log has no clocks,
      // so per-window receipts can only be attributed reliably from here.
      appendTranscript(`WATCH_CHECK: n=${checkNo} trigger=${trigger} verdict=${result.visible ? 'visible' : 'not_yet'} model=${result.model} ms=${result.ms}`);
      if (result.visible && watch && !watch.fired) {
        fireWatch(result, checkNo);
      }
    }

    function fireWatch(result, checkNo) {
      if (!watch || watch.fired) return;
      if (upstream.readyState !== WebSocket.OPEN || !setupReady) return;
      watch.fired = true;
      const sentence = watch.sentence;
      clearWatchTimers();
      console.log(`[live-video] watch sighted — voiced turn requested (check ${checkNo}, ${result.model} ${result.ms}ms)`);
      appendTranscript(`WATCH_FIRED: visible (check ${checkNo}, ${result.ms}ms)`);
      pendingContinue = null;
      watch = null;
      upstream.send(JSON.stringify({
        clientContent: {
          turns: [{
            role: 'user',
            parts: [{
              text: `[SYSTEM CONTEXT: ${USER_NAME} asked you to be told when ${sentence}. It is visible in the frame now. Tell them immediately and briefly, describing it in one sentence.]`
            }]
          }],
          turnComplete: true
        }
      }));
    }

    const pythonBin = PYTHON_BIN;
    const trackerScript = path.join(__dirname, 'vision_tracker.py');
    let trackerProc = null;
    try {
      if (!pythonBin) throw new Error('no interpreter with numpy+Pillow+torch');
      trackerProc = spawn(pythonBin, [trackerScript], { stdio: ['pipe', 'pipe', 'inherit'] });
      trackerProc.stdout.on('data', (d) => {
        const lines = d.toString().split('\n').filter(Boolean);
        for (const l of lines) {
          try {
            const ev = JSON.parse(l);
            if (ev.significant_change) {
              console.log(`[live-video] Significant visual change detected (dist=${ev.distance})`);
              fs.appendFileSync(path.join(__dirname, 'transcript.log'), `[${new Date().toISOString()}] VISION_EVENT: Significant visual change (dist=${ev.distance})\n`);
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'vision_change', distance: ev.distance, frameIndex: ev.frame_index }));
              }
              // Inject testing context prompt into Gemini Live turn
              if (upstream.readyState === WebSocket.OPEN && setupReady) {
                const contextTurn = {
                  clientContent: {
                    turns: [{
                      role: 'user',
                      parts: [{ text: VISION_CONTEXT_TEXT }]
                    }],
                    // Silent by default: context only, no model turn requested.
                    turnComplete: VISION_VOICE_ALERTS
                  }
                };
                upstream.send(JSON.stringify(contextTurn));
                console.log(`[live-video] Visual context ${VISION_VOICE_ALERTS ? 'injected (voiced)' : 'updated (silent)'}`);
              }
              // An armed watch checks the settled view against the request.
              noteSceneChange();
            }
          } catch (_) {}
        }
      });
      trackerProc.on('error', (err) => console.warn('[live-video] tracker error:', err.message));
    } catch (e) {
      console.warn('[live-video] tracker spawn failed:', e.message);
    }

    upstream.on('open', () => {
      console.log('[live-video] upstream connected to Gemini Live API, sending setup frame...');
      const setup = {
        setup: {
          model: LIVE_MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Charon' }
              }
            }
          },
          systemInstruction: {
            parts: [{
              text: SYSTEM_PROMPT
            }]
          },
          realtimeInputConfig: {
            automaticActivityDetection: { silenceDurationMs: 500 },
            activityHandling: 'START_OF_ACTIVITY_INTERRUPTS'
          }
        }
      };
      upstream.send(JSON.stringify(setup));
    });

    upstream.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.setupComplete) {
          console.log('[live-video] Gemini setupComplete confirmed! Draining queued frames/audio...');
          setupReady = true;
          while (queuedMessages.length > 0) {
            upstream.send(queuedMessages.shift());
          }
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'status', state: 'listening' }));
          }
          // Deaf-client detector: the relay can forward a perfect stream of
          // video whilst the microphone never sends a byte, and nothing in the
          // log says so. Say so.
          setTimeout(() => {
            if (audioCount === 0) {
              console.warn('[live-video] no audio from client 10s after setup — microphone is not sending');
              fs.appendFileSync(path.join(__dirname, 'transcript.log'), `[${new Date().toISOString()}] AUDIO_ABSENT: no audio packets 10s after setup\n`);
            }
          }, 10000);
          return;
        }
        const sc = msg.serverContent;
        if (!sc) return;

        if (sc.interrupted) {
          console.log('[live-video] Gemini turn interrupted by user speech');
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'interrupted' }));
            clientWs.send(JSON.stringify({ type: 'status', state: 'listening' }));
          }
        }

        if (sc.inputTranscription?.text) {
          const text = sc.inputTranscription.text;
          process.stdout.write(`[live-video] USER: ${text}\n`);
          fs.appendFileSync(path.join(__dirname, 'transcript.log'), `[${new Date().toISOString()}] USER: ${text}\n`);
          // "Let me know when…" arms a verifier-backed watch: the relay checks
          // each settled frame and voices one alert only when the thing in the
          // question is actually visible, or asks to continue at window end.
          if (WATCH_CUE.test(text)) {
            armWatch(text.trim().replace(/\s+/g, ' ').slice(0, 240));
          } else if (pendingContinue && WATCH_CONTINUE.test(text.trim())) {
            const sentence = pendingContinue;
            pendingContinue = null;
            appendTranscript(`WATCH_REARMED: ${USER_NAME} asked to keep watching`);
            armWatch(sentence);
          }
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'transcription', role: 'user', text }));
            clientWs.send(JSON.stringify({ type: 'status', state: 'thinking' }));
          }
        }

        if (sc.outputTranscription?.text) {
          const text = sc.outputTranscription.text;
          process.stdout.write(`[live-video] JARVIS: ${text}\n`);
          fs.appendFileSync(path.join(__dirname, 'transcript.log'), `[${new Date().toISOString()}] JARVIS: ${text}\n`);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'transcription', role: 'model', text }));
            clientWs.send(JSON.stringify({ type: 'status', state: 'speaking' }));
          }
        }

        const parts = sc.modelTurn?.parts || [];
        for (const p of parts) {
          if (p.inlineData?.data) {
            audioOutParts++;
            audioOutBytes += p.inlineData.data.length;
            // One line per model turn, so "the reply was silent" can be settled
            // from the transcript: audio sent but unheard is a client problem,
            // no line at all is ours.
            if (!audioOutStamped) {
              audioOutStamped = true;
              // The first part of a turn is frequently a 3-byte placeholder, so
              // record whether it carries signal at all; the turn's real volume
              // is summed at turnComplete.
              const n = p.inlineData.data.length;
              appendTranscript(
                `AUDIO_OUT: first model audio parts=1 bytes=${n} ` +
                `placeholder=${n < 64 ? 1 : 0} mime=${p.inlineData.mimeType || 'unknown'}`
              );
            }
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'audio',
                mimeType: p.inlineData.mimeType,
                data: p.inlineData.data
              }));
              clientWs.send(JSON.stringify({ type: 'status', state: 'speaking' }));
            }
          }
        }

        if (sc.turnComplete) {
          if (audioOutParts > 0) {
            appendTranscript(`AUDIO_OUT_SUM: parts=${audioOutParts} bytes=${audioOutBytes}`);
          }
          audioOutParts = 0;
          audioOutBytes = 0;
          audioOutStamped = false;
          console.log('[live-video] Gemini completed speaking turn');
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'status', state: 'listening' }));
          }
        }
      } catch (err) {
        console.error('[live-video] upstream parse error:', err.message);
      }
    });

    upstream.on('close', (code, reason) => {
      const rStr = reason ? reason.toString() : '';
      console.warn(`[live-video] upstream closed: ${code} ${rStr}`);
      try { clientWs.close(1008, rStr.slice(0, 120) || 'Upstream closed'); } catch (_) {}
    });
    upstream.on('error', (err) => {
      console.error('[live-video] upstream error:', err);
      try { clientWs.close(1011, (err.message || '').slice(0, 120)); } catch (_) {}
    });

    clientWs.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        let chunk = null;

        if (parsed.type === 'client_health') {
          const h = `packets=${parsed.packets} ctx=${parsed.ctx} rate=${parsed.rate} track=${parsed.track} vis=${parsed.vis}` +
            (parsed.pctx ? ` pctx=${parsed.pctx} pqueue=${parsed.pqueue ?? 0}` : '');
          // Log only the first report and any change: an unchanged heartbeat
          // every 5s buries the conversation in the transcript.
          const shape = `ctx=${parsed.ctx} rate=${parsed.rate} track=${parsed.track} vis=${parsed.vis}`;
          if (lastHealthShape !== shape) {
            lastHealthShape = shape;
            console.log(`[live-video] client health: ${h}`);
            fs.appendFileSync(path.join(__dirname, 'transcript.log'), `[${new Date().toISOString()}] CLIENT_HEALTH: ${h}\n`);
          }
        } else if (parsed.type === 'audio' && parsed.data) {
          audioCount++;
          if (audioCount === 1 || audioCount % 250 === 0) {
            console.log(`[live-video] received audio packets from client (count=${audioCount})`);
          }
          if (audioCount === 1) {
            fs.appendFileSync(path.join(__dirname, 'transcript.log'), `[${new Date().toISOString()}] AUDIO_START: first audio packet from client\n`);
          }
          chunk = {
            realtimeInput: {
              audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: parsed.data
              }
            }
          };
        } else if (parsed.type === 'image' && parsed.data) {
          console.log(`[live-video] received video frame from client (${parsed.data.length} b64 chars)`);
          lastFrameB64 = parsed.data;
          lastFrameAt = Date.now();
          if (trackerProc && trackerProc.stdin && !trackerProc.stdin.destroyed) {
            try { trackerProc.stdin.write(JSON.stringify({ type: 'frame', data: parsed.data }) + '\n'); } catch (_) {}
          }
          chunk = {
            realtimeInput: {
              video: {
                mimeType: 'image/jpeg',
                data: parsed.data
              }
            }
          };
        }

        if (chunk) {
          const str = JSON.stringify(chunk);
          if (upstream.readyState === WebSocket.OPEN && setupReady) {
            upstream.send(str);
          } else {
            if (queuedMessages.length < 100) queuedMessages.push(str);
          }
        } else if (parsed.type && parsed.type !== 'client_health' && !unknownTypes.has(parsed.type)) {
          unknownTypes.add(parsed.type);
          console.warn(`[live-video] ignoring client message type '${parsed.type}' — not handled by this relay`);
        }
      } catch (e) {
        console.error('[live-video] bad client message:', e.message);
      }
    });

    clientWs.on('error', (err) => {
      console.warn('[live-video] client socket error:', err.message);
    });

    clientWs.on('close', () => {
      console.log('[live-video] client disconnected');
      disarmWatch('session ended');
      if (trackerProc) {
        try { trackerProc.kill(); } catch (_) {}
      }
      try { upstream.close(); } catch (_) {}
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[live-video] listening on http://${HOST}:${PORT}`);
  console.log(`[live-video] access: ${TOKEN_REQUIRED ? 'token required (non-loopback bind)' : 'loopback only, no token needed'}`);
  console.log(`[live-video] watch mode: window=${WATCH_WINDOW_SECONDS}s settle=${WATCH_SETTLE_MS}ms ` +
    `heartbeat=${WATCH_HEARTBEAT_MS > 0 ? WATCH_HEARTBEAT_MS + 'ms' : 'disabled (scene change only)'} ` +
    `max_checks=${WATCH_MAX_CHECKS} verifier=${WATCH_VERIFIER_MODE}(${VERIFIER_MODELS.join(',')}) live=${LIVE_MODEL}`);
});
