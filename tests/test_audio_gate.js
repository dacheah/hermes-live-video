#!/usr/bin/env node
// Proves the playback gate: audio delivered while the AudioContext is suspended
// is queued and then flushed once the context runs, instead of being scheduled
// on a frozen clock and lost. Runs against a real headless Chrome.
//
//   chrome --headless --autoplay-policy=no-user-gesture-required \
//          --remote-debugging-port=9225 http://127.0.0.1:8098/?debug=1
//   node tests/test_audio_gate.js
const WebSocket = require('ws');

const CDP_PORT = process.env.CDP_PORT || 9225;

async function target() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('8098'));
  if (!page) throw new Error('no page target on 8098');
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    ws.on('open', () => resolve({ send, close: () => ws.close() }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const pending = waiting.get(msg.id);
      if (pending) {
        waiting.delete(msg.id);
        msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
      }
    });
    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const msgId = ++id;
        waiting.set(msgId, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'evaluation threw');
  }
  return result.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cdp = await connect(await target());
  // Reload so the page runs the client.js on disk, not the copy it booted with.
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  await cdp.send('Runtime.enable');
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) {
      pass++;
      console.log(`  ok   ${name}`);
    } else {
      fail++;
      console.log(`  FAIL ${name} ${detail}`);
    }
  };

  const present = await evaluate(cdp, 'Boolean(window.__liveAudio)');
  check('debug hook present', present);
  if (!present) process.exit(1);

  // 100 ms of 24 kHz PCM, base64 — the shape the relay sends.
  const chunk = await evaluate(cdp, `(() => {
    const n = 2400, bytes = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 24000));
      bytes[i*2] = v & 0xff; bytes[i*2+1] = (v >> 8) & 0xff;
    }
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  })()`);
  check('chunk encoded', typeof chunk === 'string' && chunk.length > 100);

  await evaluate(cdp, 'window.__liveAudio.unlock()');
  await sleep(300);
  check('context runs after unlock', (await evaluate(cdp, 'window.__liveAudio.state()')) === 'running');

  // The regression: audio arrives while the phone has the context suspended.
  await evaluate(cdp, 'window.__liveAudio.suspend()');
  await sleep(200);
  check('context suspended', (await evaluate(cdp, 'window.__liveAudio.state()')) === 'suspended');

  // A phone that refuses resume() without a fresh gesture: the promise never
  // settles, which is exactly the situation that used to lose the reply.
  await evaluate(cdp, `(() => {
    const c = window.__liveAudio.ctx();
    c.__realResume = c.resume.bind(c);
    c.resume = () => new Promise(() => {});
  })()`);

  await evaluate(cdp, `window.__liveAudio.play(${JSON.stringify(chunk)})`);
  await evaluate(cdp, `window.__liveAudio.play(${JSON.stringify(chunk)})`);
  await sleep(150);
  const queued = await evaluate(cdp, 'window.__liveAudio.pending()');
  check('suspended audio is queued, not dropped', queued === 2, `pending=${queued}`);
  const playedWhileSuspended = await evaluate(cdp, 'window.__liveAudio.diag.played');
  check('nothing scheduled on a frozen clock', playedWhileSuspended === 0, `played=${playedWhileSuspended}`);

  await evaluate(cdp, `(() => {
    const c = window.__liveAudio.ctx();
    c.resume = c.__realResume;
    return c.resume();
  })()`);
  await sleep(600);
  const after = await evaluate(cdp, `({
    state: window.__liveAudio.state(),
    pending: window.__liveAudio.pending(),
    flushed: window.__liveAudio.diag.flushed,
    played: window.__liveAudio.diag.played,
  })`);
  check('queue empties on resume', after.pending === 0, JSON.stringify(after));
  check('both chunks flushed and played', after.flushed === 2 && after.played === 2, JSON.stringify(after));

  // A running context still plays straight through.
  await evaluate(cdp, `window.__liveAudio.play(${JSON.stringify(chunk)})`);
  await sleep(250);
  const live = await evaluate(cdp, '({q: window.__liveAudio.pending(), p: window.__liveAudio.diag.played})');
  check('running context plays immediately', live.q === 0 && live.p === 3, JSON.stringify(live));

  console.log(`\n${pass} passed, ${fail} failed`);
  cdp.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test error:', err.message);
  process.exit(1);
});
