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
  sequences: [],           // [{steps:[1,3,2], label:'', password:''}]
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

// ── Password Generator ────────────────────────────────────────────────────────
const _WORDS = [
  'able','also','arch','area','army','atom','away','baby','back','ball',
  'band','bank','base','bath','bear','bell','best','bird','blue','boat',
  'body','bold','bone','book','bowl','calm','camp','card','care','cash',
  'cave','cell','chip','city','club','coal','coat','code','coin','cold',
  'cook','cool','core','corn','cost','cube','cure','dark','data','date',
  'dawn','deal','deck','deep','desk','diet','disk','dock','door','draw',
  'drop','drum','duck','dusk','dust','each','earn','east','edge','exam',
  'exit','face','fact','fail','fair','fall','farm','fast','feat','feel',
  'feet','file','fill','film','find','fire','firm','fish','flag','flat',
  'flip','flow','foam','fold','font','food','foot','fork','form','fort',
  'free','fuel','full','fund','fuse','gain','game','gate','gear','gift',
  'give','glad','glow','glue','goal','gold','good','grab','gray','grid',
  'grip','grow','gulf','gust','half','hall','hand','hard','harp','haze',
  'head','heal','heap','heat','heel','help','hero','high','hike','hill',
  'hint','hold','hole','home','hook','hope','horn','hour','hull','hunt',
  'hurt','idea','idle','inch','iron','item','join','jump','just','keen',
  'keep','kind','king','knee','knot','lake','lamp','land','lane','last',
  'late','lava','lawn','lead','leaf','lean','leap','left','lend','lift',
  'lime','link','lion','list','live','load','lock','loft','lone','long',
  'loop','lose','loud','love','luck','lung','mail','main','make','many',
  'mark','mask','mass','mast','mate','math','meal','mean','meat','meet',
  'melt','mesh','mild','milk','mill','mind','mint','miss','mist','mode',
  'mold','moon','move','much','must','nail','name','navy','need','nest',
  'next','nice','node','noon','norm','note','oath','open','oval','pace',
  'pack','page','pain','pale','palm','park','part','past','path','peak',
  'pick','pier','pile','pine','pink','pipe','plan','play','plot','plow',
  'plug','pole','pond','pool','port','pose','post','pour','prey','pull',
  'pump','pure','push','race','rack','raid','rail','rain','ramp','rank',
  'rate','read','real','reef','rely','rent','rest','rice','rich','ride',
  'ring','rise','risk','road','rock','role','roll','roof','root','rope',
  'rose','rude','rule','rush','rust','safe','sail','sale','salt','sand',
  'save','scan','seal','seat','seed','seek','sell','ship','shop','shot',
  'show','shut','silk','sing','site','size','skin','skip','slow','snap',
  'snow','soft','soil','sold','sole','song','sort','soul','span','spin',
  'spot','star','stay','stem','step','stir','stop','such','suit','sure',
  'swap','swim','tail','take','tale','talk','tall','tank','tape','task',
  'team','tear','tell','tend','tent','term','text','tide','tile','time',
  'tiny','toll','tone','tool','toss','tour','town','tree','trim','trip',
  'true','tube','tune','turf','turn','twin','type','unit','used','user',
  'vale','vary','vast','verb','view','vine','void','wade','wage','wake',
  'walk','wall','warm','warn','wave','weld','well','wide','wild','will',
  'wind','wine','wing','wipe','wire','wise','wish','wolf','wood','word',
  'work','worm','wrap','yard','year','zero','zone',
];

const _SAFE_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+?';
const _SAFE_SETS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  '!@#$%^&*-_=+?',
];

function _randInt(max) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % max;
}

function _genRandom(len) {
  const chars = _SAFE_SETS.map(s => s[_randInt(s.length)]);
  while (chars.length < len) chars.push(_SAFE_POOL[_randInt(_SAFE_POOL.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = _randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function _genPassphrase(wordCount) {
  return Array.from({ length: wordCount }, () => _WORDS[_randInt(_WORDS.length)]).join('-');
}

let _genMode = 'random';

function _doGenerate() {
  const len = +document.getElementById('gen-length').value;
  document.getElementById('gen-output').value =
    _genMode === 'random' ? _genRandom(len) : _genPassphrase(len);
}

function _resetGenPanel() {
  _genMode = 'random';
  document.querySelectorAll('.gen-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === 'random'));
  const slider = document.getElementById('gen-length');
  slider.min = 8; slider.max = 32; slider.value = 16;
  document.getElementById('gen-length-val').textContent  = '16';
  document.getElementById('gen-length-unit').textContent = 'characters';
  const out = document.getElementById('gen-output');
  out.value = ''; out.type = 'password';
  document.getElementById('btn-gen-show').textContent = 'Show';
  document.getElementById('gen-panel').style.display = 'none';
}

document.getElementById('btn-generate').addEventListener('click', () => {
  const panel   = document.getElementById('gen-panel');
  const showing = panel.style.display !== 'none';
  panel.style.display = showing ? 'none' : '';
  if (!showing) _doGenerate();
});

document.querySelectorAll('.gen-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.gen-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _genMode = tab.dataset.mode;
    const slider = document.getElementById('gen-length');
    if (_genMode === 'random') { slider.min = 8; slider.max = 32; slider.value = 16; }
    else                        { slider.min = 3; slider.max = 6;  slider.value = 4;  }
    document.getElementById('gen-length-val').textContent  = slider.value;
    document.getElementById('gen-length-unit').textContent = _genMode === 'random' ? 'characters' : 'words';
    _doGenerate();
  });
});

document.getElementById('gen-length').addEventListener('input', () => {
  document.getElementById('gen-length-val').textContent = document.getElementById('gen-length').value;
  _doGenerate();
});

document.getElementById('btn-gen-show').addEventListener('click', () => {
  const out    = document.getElementById('gen-output');
  const btn    = document.getElementById('btn-gen-show');
  const hidden = out.type === 'password';
  out.type     = hidden ? 'text' : 'password';
  btn.textContent = hidden ? 'Hide' : 'Show';
});

document.getElementById('btn-gen-regen').addEventListener('click', _doGenerate);

document.getElementById('btn-gen-use').addEventListener('click', () => {
  const pw = document.getElementById('gen-output').value;
  if (!pw) return;
  const pwInput = document.getElementById('finger-password');
  pwInput.value = pw;
  pwInput.type  = 'text';
  document.querySelector('[data-target="finger-password"]').textContent = 'Hide';
  document.getElementById('gen-panel').style.display = 'none';
});

// ── Wizard navigation ─────────────────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step-${n}`).classList.add('active');

  // Progress bar — '2b' is part of step 2
  const bar  = document.getElementById('progress-bar');
  const numN = n === '2b' ? 2.5 : +n;
  bar.style.display = (numN >= 1 && numN <= 4) ? '' : 'none';

  const pbMap = { 1: 1, 2: 2, '2b': 2, 3: 3, 4: 3, 5: 4 };
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

    // Retry PING to handle the case where opening the port triggers a
    // CircuitPython restart (device takes ~2s to reboot).
    // Attempt 1: immediately (device already running)
    // Attempts 2-4: after growing delays (device just reset)
    const delays = [0, 1500, 2000, 2500];
    let ponged = false;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
      try {
        await send('PING');
        await waitFor('PONG', 2000);
        ponged = true;
        break;
      } catch (_) {
        if (i < delays.length - 1) {
          btn.textContent = `Connecting… (${i + 2}/${delays.length})`;
        }
      }
    }
    if (!ponged) throw new Error('Timeout waiting for "PONG"');

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

    const maxFails = document.getElementById('input-max-fails').value;
    await send(`SET_MAX_FAILS:${maxFails}`);
    await waitFor('OK:MAX_FAILS_SET', 6000);

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

  // Reset generator and sensor
  _resetGenPanel();
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
  goToSeqStep();
});

function _advanceFinger() {
  if (state.currentSlot < 5) {
    _renderFingerStep(state.currentSlot + 1);
  } else {
    goToSeqStep();
  }
}

// ── Step 2b: Sequences ────────────────────────────────────────────────────────
let _seqBuilderLen = 2;

function goToSeqStep() {
  goToStep('2b');
  document.getElementById('seq-builder').style.display = 'none';
  document.getElementById('btn-add-seq').style.display = '';
  hideAlert('seq-send-error');
  _renderSeqList();
}

function _renderSeqList() {
  const list = document.getElementById('seq-list');
  const none = document.getElementById('seq-none');
  if (state.sequences.length === 0) {
    list.innerHTML = '';
    none.style.display = '';
  } else {
    none.style.display = 'none';
    list.innerHTML = state.sequences.map((seq, i) => `
      <div class="seq-item">
        <div class="seq-item-steps">
          ${seq.steps.map(s => `<span class="seq-dot">F${s}</span>`).join('<span class="seq-arrow"> → </span>')}
        </div>
        <span class="seq-item-label">${seq.label || '<em>no label</em>'}</span>
        <button class="btn-seq-remove" data-idx="${i}" type="button">Remove</button>
      </div>
    `).join('');
    list.querySelectorAll('.btn-seq-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        state.sequences.splice(+btn.dataset.idx, 1);
        _renderSeqList();
      });
    });
  }
}

function _renderSeqFingerPickers() {
  const container = document.getElementById('seq-finger-pickers');
  container.innerHTML = '';
  for (let i = 0; i < _seqBuilderLen; i++) {
    const div = document.createElement('div');
    div.className = 'seq-step-row';
    div.innerHTML = `
      <span class="seq-step-label">Step ${i + 1}</span>
      <select class="seq-finger-sel">
        <option value="">— pick finger —</option>
        ${[1,2,3,4,5].map(n => `<option value="${n}">Finger ${n}</option>`).join('')}
      </select>
    `;
    container.appendChild(div);
  }
}

document.getElementById('btn-add-seq').addEventListener('click', () => {
  _seqBuilderLen = 2;
  document.querySelectorAll('.seq-len-btn').forEach(b => b.classList.toggle('active', b.dataset.len === '2'));
  document.getElementById('seq-label').value    = '';
  document.getElementById('seq-password').value = '';
  hideAlert('seq-builder-error');
  _renderSeqFingerPickers();
  document.getElementById('seq-builder').style.display = '';
  document.getElementById('btn-add-seq').style.display = 'none';
});

document.getElementById('btn-seq-cancel').addEventListener('click', () => {
  document.getElementById('seq-builder').style.display = 'none';
  document.getElementById('btn-add-seq').style.display = '';
});

document.querySelectorAll('.seq-len-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seq-len-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _seqBuilderLen = +btn.dataset.len;
    _renderSeqFingerPickers();
  });
});

document.getElementById('btn-seq-add').addEventListener('click', () => {
  hideAlert('seq-builder-error');
  const sels  = document.querySelectorAll('.seq-finger-sel');
  const steps = Array.from(sels).map(s => +s.value);

  if (steps.some(s => !s)) {
    return showAlert('seq-builder-error', 'Please select a finger for each step.');
  }
  if (!document.getElementById('seq-password').value) {
    return showAlert('seq-builder-error', 'Please enter a password for this sequence.');
  }
  const startSlot = steps[0];
  if (state.fingers[startSlot - 1].enrolled) {
    return showAlert('seq-builder-error',
      `Finger ${startSlot} is already a single-finger trigger. Choose a different starting finger.`);
  }
  if (new Set(steps).size !== steps.length) {
    return showAlert('seq-builder-error', 'A sequence cannot use the same finger twice.');
  }
  const key = steps.join(',');
  if (state.sequences.some(s => s.steps.join(',') === key)) {
    return showAlert('seq-builder-error', 'This exact sequence is already defined.');
  }

  state.sequences.push({
    steps,
    label:    document.getElementById('seq-label').value.trim(),
    password: document.getElementById('seq-password').value,
  });

  document.getElementById('seq-builder').style.display = 'none';
  document.getElementById('btn-add-seq').style.display = '';
  _renderSeqList();
});

document.getElementById('btn-seq-back').addEventListener('click', () => {
  const lastSlot = state.fingers.findLast(f => !f.enrolled && !f.skipped)?.slot
                || state.fingers.findLast(f => f.enrolled)?.slot
                || 1;
  goToStep(2);
  _renderFingerStep(lastSlot);
});

document.getElementById('btn-seq-continue').addEventListener('click', async () => {
  hideAlert('seq-send-error');

  if (state.sequences.length === 0) {
    goToStep(3);
    _renderReview();
    return;
  }

  const btn = document.getElementById('btn-seq-continue');
  btn.disabled    = true;
  btn.textContent = 'Saving...';

  try {
    for (const seq of state.sequences) {
      const key = seq.steps.join(',');
      await send(`SET_SEQ_PASSWORD:${key}:${seq.password}`);
      await waitFor(`OK:SEQ_PASSWORD:${key}`, 6000);
    }
    goToStep(3);
    _renderReview();
  } catch (e) {
    showAlert('seq-send-error', `Error saving sequences: ${e.message}`);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Continue to Review';
  }
});

// ── Step 3: Review ────────────────────────────────────────────────────────────
function _renderReview() {
  const enrolled   = state.fingers.filter(f => f.enrolled);
  const tbody      = document.getElementById('review-body');
  const none       = document.getElementById('review-none');
  const hasContent = enrolled.length > 0 || state.sequences.length > 0;

  if (!hasContent) {
    tbody.innerHTML = '';
    none.style.display = '';
    document.getElementById('btn-lockdown').disabled = true;
  } else {
    none.style.display = 'none';
    document.getElementById('btn-lockdown').disabled = false;
    tbody.innerHTML = [
      ...enrolled.map(f => `
        <tr>
          <td>Finger ${f.slot}</td>
          <td>${f.label || '<em style="color:#94a3b8">no label</em>'}</td>
          <td style="font-family:monospace">${'•'.repeat(Math.min(f.password.length, 10))}</td>
        </tr>
      `),
      ...state.sequences.map(seq => `
        <tr>
          <td>${seq.steps.map(s => `F${s}`).join(' → ')}</td>
          <td>${seq.label || '<em style="color:#94a3b8">no label</em>'}</td>
          <td style="font-family:monospace">${'•'.repeat(Math.min(seq.password.length, 10))}</td>
        </tr>
      `),
    ].join('');
  }
}

document.getElementById('btn-back-to-fingers').addEventListener('click', () => {
  goToSeqStep();
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
