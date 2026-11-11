// The verifier's real contract, exercised against the live API: a YES when the
// thing is there, a NO when it is not, and a latency figure for each look.
// Run: node tests/test_verifier.js        (needs GEMINI_API_KEY or config.env)
'use strict';

const fs = require('fs');
const path = require('path');
const { createVerifier, retryDelayMs } = require('../lib/verifier');

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  for (const p of [path.join(process.env.HOME, '.hermes', 'hermes-live', 'config.env'), path.join(__dirname, '..', 'config.env')]) {
    if (!fs.existsSync(p)) continue;
    const m = /^GEMINI_API_KEY=\s*["']?([^"'\s]+)["']?/m.exec(fs.readFileSync(p, 'utf8'));
    if (m) return m[1];
  }
  return null;
}

function frame(colour) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', `frame_${colour}.b64`), 'utf8').trim();
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const key = apiKey();
  if (!key) {
    console.error('no GEMINI_API_KEY — cannot exercise the verifier');
    process.exit(2);
  }

  // 1. The retry hint shapes Google actually sends.
  const hint = retryDelayMs({ error: { details: [{ retryDelay: '16h55m31.19s' }] } });
  record('retryDelayMs parses "16h55m31.19s"', hint === 60931190, String(hint));
  record('retryDelayMs parses "31s"', retryDelayMs({ error: { details: [{ retryDelay: '31s' }] } }) === 31000);
  record('retryDelayMs is null without a hint', retryDelayMs({}) === null);

  // 2. Live transport: the default path.
  const live = createVerifier({ getApiKey: () => key, mode: 'live', log: { warn: () => {} } });
  const yes = await live.look('the screen turns blue', frame('blue'));
  record('live: blue frame, asked for blue → visible', Boolean(yes && yes.ok && yes.visible === true), JSON.stringify(yes).slice(0, 130));
  record('live: names the transport used', Boolean(yes && yes.model === 'live'), yes && yes.model);
  record('live: answered inside the 8 s budget', Boolean(yes && yes.ms < 8000), `${yes && yes.ms} ms`);

  const no = await live.look('the screen turns blue', frame('red'));
  record('live: red frame, asked for blue → not visible', Boolean(no && no.ok && no.visible === false), JSON.stringify(no).slice(0, 130));

  const absent = await live.look('a coffee mug appears', frame('blue'));
  record('live: asks about an absent object → not visible', Boolean(absent && absent.ok && absent.visible === false), JSON.stringify(absent).slice(0, 130));

  // 3. A short timeout returns, rather than hanging the watch loop.
  const impatient = createVerifier({ getApiKey: () => key, mode: 'live', timeoutMs: 1, log: { warn: () => {} } });
  record('live: a 1 ms timeout returns null', (await impatient.look('the screen turns blue', frame('blue'))) === null);

  // 4. No key is a clean null, not an exception.
  const keyless = createVerifier({ getApiKey: () => null, mode: 'auto', log: { warn: () => {} } });
  record('no key → null', (await keyless.look('anything', frame('blue'))) === null);

  // 5. Auto mode falls back to generateContent when the live transport fails.
  let generateCalls = 0;
  const fakeFetch = async () => {
    generateCalls += 1;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'NO' }] } }] }) };
  };
  const fallback = createVerifier({
    getApiKey: () => key,
    mode: 'auto',
    liveModel: 'models/does-not-exist',
    fetchImpl: fakeFetch,
    timeoutMs: 3000,
    log: { warn: () => {} }
  });
  const afterFallback = await fallback.look('the screen turns blue', frame('blue'));
  record('auto: falls back to generateContent when live fails',
    generateCalls === 1 && Boolean(afterFallback) && afterFallback.visible === false,
    `generate calls: ${generateCalls}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
