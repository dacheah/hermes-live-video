(() => {
  let ws = null;
  let audioCtx = null;
  let micAudioCtx = null;
  let micSource = null;
  let micStream = null;
  let micWorklet = null;
  let cameraStream = null;
  let frameTimer = null;
  let userHangup = false;
  let facingMode = 'environment';
  let nextPlayTime = 0;
  let activeSources = [];

  const startBtn = document.getElementById('start-btn');
  const toggleCamBtn = document.getElementById('toggle-cam');
  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const overlay = document.getElementById('overlay');
  const videoEl = document.getElementById('preview');
  const subtitlesEl = document.getElementById('subtitles');
  const subtitlesRole = document.getElementById('subtitles-role');
  const subtitlesText = document.getElementById('subtitles-text');

  let currentSubtitleRole = null;
  let currentSubtitleText = '';
  let subtitleClearTimeout = null;
  let audioPacketsSent = 0;
  let healthTimer = null;
  let micWarned = false;
  let silentTicks = 0;

  function appendSubtitle(role, text) {
    if (!subtitlesEl || !subtitlesRole || !subtitlesText) return;
    if (currentSubtitleRole !== role) {
      currentSubtitleRole = role;
      currentSubtitleText = text;
    } else {
      currentSubtitleText += text;
    }
    if (subtitleClearTimeout) {
      clearTimeout(subtitleClearTimeout);
      subtitleClearTimeout = null;
    }
    subtitlesEl.style.display = 'flex';
    if (role === 'user') {
      subtitlesRole.className = 'subtitles-role role-user';
      subtitlesRole.textContent = 'You';
    } else {
      subtitlesRole.className = 'subtitles-role role-jarvis';
      subtitlesRole.textContent = 'JARVIS';
    }
    subtitlesText.textContent = currentSubtitleText;
    subtitlesEl.scrollTop = subtitlesEl.scrollHeight;
    subtitleClearTimeout = setTimeout(() => {
      if (subtitlesEl) subtitlesEl.style.display = 'none';
      currentSubtitleRole = null;
      currentSubtitleText = '';
    }, 8000);
  }

  let currentState = 'standby';
  let voiceResetTimeout = null;

  function updateState(state, activeSpeech = false) {
    currentState = state;
    if (statusBadge) {
      statusBadge.className = 'badge ' + state + (activeSpeech ? ' receiving' : '');
    }
    if (statusText) {
      statusText.textContent = state.charAt(0).toUpperCase() + state.slice(1);
    } else if (statusBadge) {
      statusBadge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
    }
    if (overlay) {
      overlay.className = 'overlay-status ' + state + (activeSpeech ? ' receiving' : '');
      if (state === 'listening') {
        overlay.textContent = activeSpeech ? 'Listening · Receiving speech...' : 'Listening (Ready)';
      } else if (state === 'thinking') {
        overlay.textContent = 'Thinking...';
      } else if (state === 'speaking') {
        overlay.textContent = 'JARVIS Speaking...';
      }
    }
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  toggleCamBtn.addEventListener('click', async () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    if (cameraStream) {
      stopCamera();
      await startCamera();
    }
  });

  function unlockAudioContexts() {
    // Mobile browsers only honour a user gesture if the AudioContext is created
    // and resumed synchronously inside it. Creating the capture context after
    // an await (getUserMedia, camera start) loses the gesture, so the context is
    // born suspended and no audio ever flows.
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    try {
      if (!audioCtx) {
        try { audioCtx = new AudioContextClass({ sampleRate: 24000 }); }
        catch (_) { audioCtx = new AudioContextClass(); }
      }
      if (!micAudioCtx) {
        try { micAudioCtx = new AudioContextClass({ sampleRate: 16000 }); }
        catch (_) { micAudioCtx = new AudioContextClass(); }
      }
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      if (micAudioCtx.state === 'suspended') micAudioCtx.resume().catch(() => {});
    } catch (err) {
      console.error('Audio unlock failed:', err);
    }
  }

  // Any touch, click or key anywhere resumes capture — the user should never
  // have to hunt for the right element to make the microphone live.
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, () => { if (ws) unlockAudioContexts(); }, { passive: true })
  );

  startBtn.addEventListener('click', () => {
    unlockAudioContexts();
    if (ws) {
      stopSession();
    } else {
      startSession();
    }
  });

  async function startCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 15 }
        }
      });
      videoEl.srcObject = cameraStream;
      await videoEl.play();
    } catch (err) {
      console.error('Camera error:', err);
      overlay.textContent = 'Camera permission denied';
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
  }

  function micHealth() {
    const track = micStream ? micStream.getAudioTracks()[0] : null;
    return {
      packets: audioPacketsSent,
      ctx: micAudioCtx ? micAudioCtx.state : 'none',
      rate: micAudioCtx ? micAudioCtx.sampleRate : 0,
      track: track ? track.readyState + (track.muted ? '/muted' : '') : 'none',
      vis: document.visibilityState
    };
  }

  function startHealthReporting() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // A context suspended by the OS (screen lock, background, another app
      // taking the mic) stops the worklet without an error. Try to revive it
      // before reporting, then report what actually happened.
      if (micAudioCtx && micAudioCtx.state === 'suspended') {
        micAudioCtx.resume().catch(() => {});
      }
      const h = micHealth();
      try { ws.send(JSON.stringify({ type: 'client_health', ...h })); } catch (_) {}
      // Two consecutive silent ticks (10s) before saying anything: one tick of
      // zero is normal in the first seconds whilst the worklet spins up.
      if (h.packets === 0) {
        silentTicks++;
        if (silentTicks >= 2 && !micWarned) {
          micWarned = true;
          if (overlay) {
            overlay.textContent = 'Microphone not sending (context ' + h.ctx + ', track ' + h.track + ')';
          }
        }
      } else if (micWarned) {
        silentTicks = 0;
        micWarned = false;
        updateState('listening', false);
      } else {
        silentTicks = 0;
      }
    }, 5000);
  }

  function captureAndSendFrame() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !cameraStream) return;
    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return;

    canvas.width = 640;
    canvas.height = 480;
    ctx.drawImage(videoEl, 0, 0, 640, 480);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const reader = new FileReader();
      reader.onloadend = () => {
        const b64 = reader.result.split(',')[1];
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'image', data: b64 }));
        }
      };
      reader.readAsDataURL(blob);
    }, 'image/jpeg', 0.6);
  }

  async function startSession() {
    userHangup = false;
    overlay.textContent = 'Initialising audio & camera...';
    startBtn.textContent = 'Connecting...';
    startBtn.disabled = true;

    try {
      await startCamera();

      unlockAudioContexts();
      if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (_) {} }

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });

      unlockAudioContexts();
      if (micAudioCtx.state === 'suspended') { try { await micAudioCtx.resume(); } catch (_) {} }

      await micAudioCtx.audioWorklet.addModule('/mic-worklet.js?v=4');
      micSource = micAudioCtx.createMediaStreamSource(micStream);
      micWorklet = new AudioWorkletNode(micAudioCtx, 'pcm-capture');
      micSource.connect(micWorklet);

      try {
        const dummyGain = micAudioCtx.createGain();
        dummyGain.gain.value = 0;
        micWorklet.connect(dummyGain);
        dummyGain.connect(micAudioCtx.destination);
      } catch (_) {}

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);

      ws.onopen = () => {
        updateState('listening');
        startBtn.textContent = 'End Call';
        startBtn.className = 'danger';
        startBtn.disabled = false;

        // Paced video uplink: 2.5 frames per second (400ms)
        frameTimer = setInterval(captureAndSendFrame, 400);

        // Microphone watchdog: a suspended audio context, a muted track or an
        // OS-level privacy toggle all stop the worklet silently, which leaves
        // JARVIS deaf with no visible symptom. Report health and try to revive.
        startHealthReporting();
      };

      micWorklet.port.onmessage = (event) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const u8 = new Uint8Array(event.data);
          const b64 = btoa(String.fromCharCode(...u8));
          ws.send(JSON.stringify({ type: 'audio', data: b64 }));
          audioPacketsSent++;

          // Detect user speech volume to drive live 'Listening' indicator
          const int16 = new Int16Array(event.data);
          let sumSquares = 0;
          for (let i = 0; i < int16.length; i++) {
            sumSquares += int16[i] * int16[i];
          }
          const rms = Math.sqrt(sumSquares / int16.length);
          if (rms > 650 && currentState === 'listening') {
            updateState('listening', true);
            if (voiceResetTimeout) clearTimeout(voiceResetTimeout);
            voiceResetTimeout = setTimeout(() => {
              if (currentState === 'listening') {
                updateState('listening', false);
              }
            }, 600);
          }
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status' && msg.state) {
          if (msg.state === 'listening' && activeSources.length > 0) {
            // Keep speaking status while local audio buffers are draining
          } else {
            updateState(msg.state, false);
          }
        } else if (msg.type === 'transcription') {
          if (msg.role && msg.text) {
            appendSubtitle(msg.role, msg.text);
          }
        } else if (msg.type === 'interrupted') {
          // Cancel buffered audio immediately on barge-in
          activeSources.forEach(src => { try { src.stop(); } catch (_) {} });
          activeSources = [];
          nextPlayTime = audioCtx ? audioCtx.currentTime : 0;
          if (subtitlesEl) subtitlesEl.style.display = 'none';
          updateState('listening', false);
        } else if (msg.type === 'audio' && msg.data) {
          updateState('speaking', false);
          playPcm24k(msg.data);
        }
      };

      ws.onclose = (ev) => {
        console.warn('WS onclose:', ev.code, ev.reason);
        if (!userHangup) {
          overlay.textContent = `Closed: code=${ev.code}${ev.reason ? ' (' + ev.reason + ')' : ''}`;
        }
        stopSession(false);
      };

      ws.onerror = (e) => {
        console.error('WS error:', e);
        overlay.textContent = 'WS connection error';
        stopSession(false);
      };

    } catch (err) {
      console.error('Init error:', err);
      overlay.textContent = 'Err: ' + (err.name || '') + ' - ' + err.message;
      statusBadge.textContent = 'Error';
      statusBadge.classList.remove('active');
      startBtn.textContent = 'Start Session';
      startBtn.className = 'primary';
      startBtn.disabled = false;
      if (ws) { try { ws.close(); } catch(_) {} ws = null; }
    }
  }

  function playPcm24k(base64Data) {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    const binaryStr = atob(base64Data);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);

    const samples = len / 2;
    const float32 = new Float32Array(samples);
    const dataView = new DataView(bytes.buffer);
    for (let i = 0; i < samples; i++) {
      float32[i] = dataView.getInt16(i * 2, true) / 32768.0;
    }

    const buffer = audioCtx.createBuffer(1, samples, 24000);
    buffer.getChannelData(0).set(float32);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (nextPlayTime < now) nextPlayTime = now;
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;

    activeSources.push(source);
    source.onended = () => {
      const idx = activeSources.indexOf(source);
      if (idx !== -1) activeSources.splice(idx, 1);
      if (activeSources.length === 0 && ws && ws.readyState === WebSocket.OPEN) {
        updateState('listening');
      }
    };
  }

  function stopSession(clearOverlay = true) {
    if (clearOverlay) userHangup = true;
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    micWarned = false;
    silentTicks = 0;
    audioPacketsSent = 0;
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (ws) { const s = ws; ws = null; try { s.close(); } catch (_) {} }
    if (micWorklet) { try { micWorklet.disconnect(); } catch (_) {} micWorklet = null; }
    if (micSource) { try { micSource.disconnect(); } catch (_) {} micSource = null; }
    if (micAudioCtx) { try { micAudioCtx.close(); } catch (_) {} micAudioCtx = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
    stopCamera();

    statusBadge.className = 'badge';
    if (statusText) statusText.textContent = 'Standby';
    else statusBadge.textContent = 'Standby';
    if (subtitlesEl) subtitlesEl.style.display = 'none';
    if (clearOverlay) overlay.textContent = 'Session ended';
    startBtn.textContent = 'Start Session';
    startBtn.className = 'primary';
    startBtn.disabled = false;
  }
})();
