// The LAN token gate has to keep the page usable: the HTML is opened once with
// ?token=…, and every request after it — script tags, the worklet, the socket —
// cannot carry that query string. This asserts the cookie bridge that makes a
// token-gated bind behave like loopback once the page has been opened.
//
// Measured symptom it guards: a phone on the LAN loaded the page, but the start
// button did nothing, because /client.js was refused with 403 and no handler was
// ever attached.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const HOST = '127.0.0.2';
const PORT = 8096;
const TOKEN = 'test-token-123';
const RELAY = path.join(__dirname, '..', 'server.js');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForListen(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`relay did not listen in 10s: ${out}`)), 10000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`relay exited ${code}: ${out}`)));
  });
}

(async () => {
  const child = spawn(process.execPath, [RELAY], {
    env: {
      ...process.env,
      HOST,
      PORT: String(PORT),
      LIVE_TOKEN: TOKEN,
      GEMINI_API_KEY: 'not-a-real-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForListen(child);

    const page = await get(`/?token=${TOKEN}`);
    check('page loads with the token', page.status === 200, `status ${page.status}`);
    check('page sets the token cookie',
      String(page.headers['set-cookie'] || '').includes(`live_token=${TOKEN}`),
      JSON.stringify(page.headers['set-cookie'] || ''));
    const cookie = `live_token=${TOKEN}`;

    const bare = await get('/');
    check('page without a token is refused', bare.status === 403, `status ${bare.status}`);

    const script = await get('/client.js?v=13', { cookie });
    check('client.js is served to the page that holds the cookie', script.status === 200, `status ${script.status}`);
    check('client.js is the real script', script.body.includes('pendingPlayback'),
      `${script.body.length} bytes`);

    const scriptNoCookie = await get('/client.js?v=13');
    check('client.js without a token or cookie is refused', scriptNoCookie.status === 403,
      `status ${scriptNoCookie.status}`);

    const worklet = await get('/mic-worklet.js?v=4', { cookie });
    check('the audio worklet is served too', worklet.status === 200, `status ${worklet.status}`);

    const health = await get('/healthz');
    check('healthz stays open', health.status === 200, `status ${health.status}`);
  } catch (err) {
    check('relay started', false, err.message);
  } finally {
    child.kill('SIGTERM');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
