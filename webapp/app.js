// ═══════════════════════════════════════════════════════════════════════════
// Password Dongle — Setup Wizard
// Communicates with the Pico over WebSerial (Chrome / Edge required).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  port:         null,
  writer:       null,
  readBuffer:   '',
  encKey:       '',
  currentSlot:  1,         // 1-5
  fingers: Array.from({ length: 5 }, (_, i) => ({
    slot:     i + 1,
    label:    '',
    password: '',
    enrolled: false,
    skipped:  false,
  })),
};

// ── Message bus ──────────────────────────────────────────────────────────────
// Listeners receive every complete line coming from the device.
const _listeners = new Set();

function onLine(fn)  { _listeners.add(fn); return () => _listeners.delete(fn); }

function _emitLine(line) { _listeners.forEach(fn => fn(line)); }

/**
 * Returns a Promise that resolves with the first line whose text starts with
 * `prefix`.  Rejects after `timeoutMs` ms.
 */
function waitFor(prefix, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`Timeout waiting for "${prefix}"`)); }, timeoutMs);
    const off = onLine(line => {
      if (line.startsWith(prefix)) { clearTimeout(timer); off(); resolve(line); }
    });
  });
}

// ── Serial connection ─────────────────────────────────────────────────────────
async function connectSerial() {
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  state.port   = port;
  state.writer = port.writable.getWriter();

  // Start background read loop (runs until port closes)
  _readLoop(port).catch(() => _onDisconnect());
}

async function _readLoop(port) {
  const decoder = new TextDecoderStream();
  port.readable.pipeTo(decoder.writable);
  const reader  = decoder.readable.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      state.readBuffer += value;
      const parts = state.readBuffer.split('\n');
      state.readBuffer = parts.pop();   // keep incomplete tail
      for (const part of parts) {
        const line = part.replace(/\r/g, '').trim();
        if (line) _emitLine(line);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function _onDisconnect() {
  showAlert('connect-error', 'Device disconnected. Refresh the page and try again.');
}

async function send(cmd) {
  if (!state.writer) throw new Error('Not connected');
  await state.writer.write(new TextEncoder().encode(cmd + '\n'));
}

// ── Wizard navigation ─────────────────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step-${n}`).classList.add('active');

  // Progress bar
  const bar = document.getElementById('progress-bar');
  bar.style.display = n >= 1 && n <= 4 ? '' : 'none';

  // Steps 1-3 map to pb-1..3; step 5 = done = pb-4
  const pbMap = { 1: 1, 2: 2, 3: 3, 4: 3, 5: 4 };
  const active = pbMap[n] || 0;
  [1, 2, 3, 4].forEach(i => {
    const el = document.getElementById(`pb-${i}`);
    el.classList.remove('active', 'done');
    if (i < active)  el.classList.add('done');
    if (i === active) el.classList.add('active');
  });
}

function showAlert(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

function hideAlert(id) { showAlert(id, ''); }

// ── Step 0: Connect ───────────────────────────────────────────────────────────
document.getElementById('btn-connect').addEventListener('click', async () => {
  hideAlert('connect-error');

  if (!('serial' in navigator)) {
    document.getElementById('no-serial-warning').style.display = '';
    return;
  }

  const btn = document.getElementById('btn-connect');
  btn.disabled  = true;
  btn.textContent = 'Connecting...';

  try {
    await connectSerial();

    // Ping the device to confirm it is in setup mode
    await send('PING');
    await waitFor('PONG', 5000);

    goToStep(1);
  } catch (e) {
    btn.disabled    = false;
    btn.textContent = 'Connect Dongle';
    if (e.name !== 'NotFoundError') {          // user cancelled picker = silent
      showAlert('connect-error', `Could not connect: ${e.message}. Make sure the dongle LED is yellow and try again.`);
    }
  }
});

// ── Step 1: Secret key ────────────────────────────────────────────────────────
document.getElementById('btn-key-next').addEventListener('click', async () => {
  hideAlert('key-error');
  const key     = document.getElementById('input-key').value.trim();
  const confirm = document.getElementById('input-key-confirm').value.trim();

  if (!key)             return showAlert('key-error', 'Please enter a secret key.');
  if (key.length < 6)   return showAlert('key-error', 'Key must be at least 6 characters.');
  if (key !== confirm)  return showAlert('key-error', 'Keys do not match. Please re-enter.');

  const btn = document.getElementById('btn-key-next');
  btn.disabled    = true;
  btn.textContent = 'Saving...';

  try {
    await send(`SET_KEY:${key}`);
    await waitFor('OK:KEY_SET', 6000);
    state.encKey = key;
    goToStep(2);
    _renderFingerStep(1);
  } catch (e) {
    showAlert('key-error', `Device error: ${e.message}`);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Continue';
  }
});

// ── Step 2: Finger setup ──────────────────────────────────────────────────────
function _renderFingerStep(slot) {
  state.currentSlot = slot;
  document.getElementById('finger-heading').textContent = `Set Up Finger ${slot}`;
  document.getElementById('finger-label').value    = state.fingers[slot - 1].label    || '';
  document.getElementById('finger-password').value = state.fingers[slot - 1].password || '';

  // Reset sensor
  _setSensor('idle', 'Press "Enroll Finger" to scan your fingerprint.');
  document.getElementById('sensor-area').style.display     = 'none';
  document.getElementById('btn-enroll').style.display      = '';
  document.getElementById('btn-enroll').disabled           = false;
  document.getElementById('btn-enroll').textContent        = 'Enroll Finger';
  document.getElementById('btn-next-finger').style.display = 'none';
  hideAlert('enroll-error');

  // Dot indicators
  for (let i = 1; i <= 5; i++) {
    const dot = document.getElementById(`fd-${i}`);
    dot.classList.remove('current', 'done', 'skipped');
    const f = state.fingers[i - 1];
    if (f.enrolled)     dot.classList.add('done');
    else if (f.skipped) dot.classList.add('skipped');
    else if (i === slot) dot.classList.add('current');
  }
}

function _setSensor(state, msg) {
  const el   = document.getElementById('sensor');
  const icon = document.getElementById('sensor-icon');
  const msgEl= document.getElementById('sensor-msg');

  el.className = 'sensor';

  const map = {
    idle:    { cls: '',        sym: '&#9632;' },   // square = ready
    waiting: { cls: 'waiting', sym: '&#9632;' },
    placing: { cls: 'placing', sym: '&#8679;' },   // up arrow
    lifting: { cls: 'lifting', sym: '&#8679;' },
    again:   { cls: 'placing', sym: '&#8679;' },
    success: { cls: 'success', sym: '&#10003;' },  // checkmark
    fail:    { cls: 'fail',    sym: '&#10007;' },  // X
  };

  const cfg = map[state] || map.idle;
  if (cfg.cls) el.classList.add(cfg.cls);
  icon.innerHTML = cfg.sym;
  msgEl.textContent = msg;
}

async function _runEnrollment(slot) {
  document.getElementById('sensor-area').style.display = '';
  document.getElementById('btn-enroll').disabled = true;

  _setSensor('waiting', 'Starting...');

  return new Promise((resolve) => {
    const off = onLine(line => {
      if (line === `PLACE_FINGER:${slot}`) {
        _setSensor('placing', 'Place your finger on the sensor.');
      } else if (line === `LIFT_FINGER:${slot}`) {
        _setSensor('lifting', 'Lift your finger off the sensor.');
      } else if (line === `PLACE_AGAIN:${slot}`) {
        _setSensor('again', 'Place the same finger on the sensor again.');
      } else if (line === `OK:${slot}`) {
        off();
        _setSensor('success', 'Finger enrolled successfully!');
        resolve(true);
      } else if (line.startsWith('FAIL:')) {
        off();
        const reason = line.split(':')[1] || 'unknown';
        const msgs = {
          timeout:   'Timed out — no finger detected.',
          image1:    'Could not read the fingerprint. Try again.',
          image2:    'Second scan failed. Try again.',
          no_match:  'The two scans did not match. Keep your finger still.',
          store:     'Could not save the fingerprint. Try again.',
        };
        _setSensor('fail', msgs[reason] || `Failed (${reason}). Try again.`);
        resolve(false);
      }
    });
  });
}

document.getElementById('btn-enroll').addEventListener('click', async () => {
  hideAlert('enroll-error');
  const slot     = state.currentSlot;
  const label    = document.getElementById('finger-label').value.trim();
  const password = document.getElementById('finger-password').value;

  if (!password) {
    return showAlert('enroll-error', 'Please enter the password this finger should type.');
  }

  // Save to local state
  state.fingers[slot - 1].label    = label;
  state.fingers[slot - 1].password = password;

  try {
    // Store password on device first (so retry also re-saves cleanly)
    await send(`SET_PASSWORD:${slot}:${password}`);
    await waitFor(`OK:PASSWORD:${slot}`, 6000);

    // Run fingerprint enrollment
    await send(`ENROLL:${slot}`);
    const ok = await _runEnrollment(slot);

    if (ok) {
      state.fingers[slot - 1].enrolled = true;
      document.getElementById('btn-enroll').style.display      = 'none';
      document.getElementById('btn-next-finger').style.display = '';
      document.getElementById(`fd-${slot}`).classList.replace('current', 'done');
    } else {
      // Re-enable enroll button for retry
      document.getElementById('btn-enroll').disabled    = false;
      document.getElementById('btn-enroll').textContent = 'Try Again';
    }
  } catch (e) {
    showAlert('enroll-error', `Error: ${e.message}`);
    document.getElementById('btn-enroll').disabled = false;
  }
});

document.getElementById('btn-next-finger').addEventListener('click', () => {
  _advanceFinger();
});

document.getElementById('btn-skip-finger').addEventListener('click', () => {
  state.fingers[state.currentSlot - 1].skipped = true;
  document.getElementById(`fd-${state.currentSlot}`).classList.replace('current', 'skipped');
  _advanceFinger();
});

document.getElementById('btn-skip-all').addEventListener('click', () => {
  goToStep(3);
  _renderReview();
});

function _advanceFinger() {
  if (state.currentSlot < 5) {
    _renderFingerStep(state.currentSlot + 1);
  } else {
    goToStep(3);
    _renderReview();
  }
}

// ── Step 3: Review ────────────────────────────────────────────────────────────
function _renderReview() {
  const enrolled = state.fingers.filter(f => f.enrolled);
  const tbody    = document.getElementById('review-body');
  const none     = document.getElementById('review-none');

  if (enrolled.length === 0) {
    tbody.innerHTML = '';
    none.style.display = '';
    document.getElementById('btn-lockdown').disabled = true;
  } else {
    none.style.display = 'none';
    document.getElementById('btn-lockdown').disabled = false;
    tbody.innerHTML = enrolled.map(f => `
      <tr>
        <td>Finger ${f.slot}</td>
        <td>${f.label || '<em style="color:#94a3b8">no label</em>'}</td>
        <td style="font-family:monospace">${'•'.repeat(Math.min(f.password.length, 10))}</td>
      </tr>
    `).join('');
  }
}

document.getElementById('btn-back-to-fingers').addEventListener('click', () => {
  const lastSlot = state.fingers.findLast(f => !f.enrolled && !f.skipped)?.slot
                || state.fingers.findLast(f => f.enrolled)?.slot
                || 1;
  goToStep(2);
  _renderFingerStep(lastSlot);
});

document.getElementById('btn-lockdown').addEventListener('click', async () => {
  hideAlert('lockdown-error');
  const enrolled = state.fingers.filter(f => f.enrolled);
  if (enrolled.length === 0) return;

  const btn = document.getElementById('btn-lockdown');
  btn.disabled    = true;
  btn.textContent = 'Locking...';

  try {
    await send('LOCK_DOWN');
    await waitFor('LOCKING', 8000);
    goToStep(4);
    // Device reboots after ~300ms; show locking screen briefly then done
    setTimeout(() => goToStep(5), 2500);
  } catch (e) {
    showAlert('lockdown-error', `Lock failed: ${e.message}`);
    btn.disabled    = false;
    btn.textContent = 'Lock Down Device';
  }
});

// ── Toggle password visibility ────────────────────────────────────────────────
document.querySelectorAll('.toggle-pw').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (input.type === 'password') {
      input.type      = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type      = 'password';
      btn.textContent = 'Show';
    }
  });
});

// ── Browser check on load ─────────────────────────────────────────────────────
if (!('serial' in navigator)) {
  document.getElementById('no-serial-warning').style.display = '';
  document.getElementById('btn-connect').disabled = true;
}
