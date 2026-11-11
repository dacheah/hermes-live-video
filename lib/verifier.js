// The watch verifier, out of band and silent: it answers one question about one
// frame and never speaks. Two transports, because they draw on different quotas:
//
//   live     — a short-lived Live session (the same model already carrying the
//              conversation), read from its output transcription. Measured
//              0.78–3.29 s per look on a VPS, and it does not touch the
//              generateContent free tier that watch mode used to exhaust.
//   generate — one generateContent call to a vision model. Slower (3.1–6.9 s)
//              and metered per request; kept as the fallback and for hosts that
//              prefer an explicit, stateless call.
//
// Default mode is 'auto': try live, fall back to generate on a transport or
// quota failure, so a single exhausted quota never blinds a watch.
'use strict';

const WebSocket = require('ws');

const LIVE_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function verdictPrompt(sentence) {
  return `You are a visual verifier for a live camera feed. The user asked to be told when: "${sentence}"\n` +
    'Look only at this image. Answer with exactly one word, nothing else:\n' +
    'YES - the thing asked about is visible in this image now\n' +
    'NO - it is not visible in this image';
}

// A 429 carries its own retry hint ("16h55m31.19s"); honour it rather than
// retrying blind. Google uses h/m/s components, often with a fractional second.
function retryDelayMs(body) {
  const details = body && body.error && body.error.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    if (typeof d.retryDelay === 'string') {
      const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(d.retryDelay.trim());
      if (m && (m[1] || m[2] || m[3])) {
        return Math.round(((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (parseFloat(m[3]) || 0)) * 1000);
      }
    }
  }
  return null;
}

// One look through a throwaway Live session. The setup frame must be bare: any
// generationConfig at setup is refused with close code 1007 by this model, and
// the transcript arrives as outputTranscription because the reply is audio.
function liveLook({ apiKey, model, sentence, frameB64, timeoutMs, wsUrl = LIVE_WS_URL }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let text = '';
    let finished = false;
    let setupSeen = false;
    let ws;
    const done = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch (_) {}
      resolve({ ...payload, ms: Date.now() - started, model: 'live' });
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout', text }), timeoutMs);

    try {
      ws = new WebSocket(`${wsUrl}?key=${apiKey}`);
    } catch (err) {
      return done({ ok: false, error: err.message, text });
    }

    ws.on('open', () => ws.send(JSON.stringify({ setup: { model } })));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.error) return done({ ok: false, error: msg.error.message || 'api error', text });
      if (msg.setupComplete !== undefined && !setupSeen) {
        setupSeen = true;
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: verdictPrompt(sentence) }, { inlineData: { mimeType: 'image/jpeg', data: frameB64 } }] }],
            turnComplete: true
          }
        }));
        return;
      }
      if (!msg.serverContent) return;
      for (const p of (msg.serverContent.modelTurn?.parts || [])) if (p.text) text += p.text;
      if (msg.serverContent.outputTranscription?.text) text += msg.serverContent.outputTranscription.text;
      if (msg.serverContent.turnComplete) {
        const clean = text.trim().toUpperCase();
        done({ ok: true, text: text.trim(), visible: clean.startsWith('YES') });
      }
    });

    ws.on('error', (err) => done({ ok: false, error: err.message, text }));
    ws.on('close', (code) => { if (!finished) done({ ok: false, error: `closed ${code}`, text }); });
  });
}

// One look through generateContent, across the configured models in order.
async function generateLook({ apiKey, models, sentence, frameB64, timeoutMs, fetchImpl = fetch }) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: verdictPrompt(sentence) }, { inlineData: { mimeType: 'image/jpeg', data: frameB64 } }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } }
  });
  for (const model of models) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetchImpl(`${GENERATE_URL}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body,
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.status === 429) {
        const json = await res.json().catch(() => null);
        return { rateLimited: true, waitMs: retryDelayMs(json) ?? 120000, model };
      }
      if (!res.ok) continue;
      const json = await res.json();
      const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      return { visible: text.toUpperCase().startsWith('YES'), ms: Date.now() - started, model, text };
    } catch (err) {
      clearTimeout(timer);
    }
  }
  return null;
}

function createVerifier({
  getApiKey,
  mode = 'auto',
  models = ['gemini-3-flash-preview'],
  liveModel = 'models/gemini-3.8-live',
  timeoutMs = 8000,
  log = console,
  fetchImpl = fetch
}) {
  async function look(sentence, frameB64) {
    const apiKey = getApiKey();
    if (!apiKey) return null;

    if (mode === 'live' || mode === 'auto') {
      const live = await liveLook({ apiKey, model: liveModel, sentence, frameB64, timeoutMs });
      if (live && live.ok) return live;
      if (live && live.error) log.warn(`[live-video] verifier (live) failed: ${live.error}`);
      if (mode === 'live') return null;
    }

    const generated = await generateLook({ apiKey, models, sentence, frameB64, timeoutMs, fetchImpl });
    return generated;
  }

  return { look, mode };
}

module.exports = { createVerifier, liveLook, generateLook, verdictPrompt, retryDelayMs, LIVE_WS_URL };
