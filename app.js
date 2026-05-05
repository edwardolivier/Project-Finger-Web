// ═══════════════════════════════════════════════════════════════════════════
// Password Dongle — Setup Wizard
// Communicates with the Pico over WebSerial (Chrome / Edge required).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  port:       null,
  writer:     null,
  readBuffer: '',
  encKey:     '',
  passwords:  [],   // [{label, password, steps:[slotId, ...]}]
  nextSlot:   1,    // next slot id for new enrollments
};

// ── Message bus ──────────────────────────────────────────────────────────────
// Listeners receive every complete line coming from the device.
const _listeners = new Set();

function onLine(fn)  { _listeners.add(fn); return () => _listeners.delete(fn); }

function _emitLine(line) { _listeners.forEach(fn => fn(line)); }

function waitFor(prefix, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`Timeout waiting for "${prefix}"`)); }, timeoutMs);
    const off = onLine(line => {
      if (line.startsWith(prefix)) { clearTimeout(timer); off(); resolve(line); }
    });
  });
}

function waitForAny(prefixes, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Timeout waiting for device response')); }, timeoutMs);
    const off = onLine(line => {
      if (prefixes.some(p => line.startsWith(p))) { clearTimeout(timer); off(); resolve(line); }
    });
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

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

document.getElementById('btn-pw-generate').addEventListener('click', () => {
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
  const pwInput = document.getElementById('pw-password');
  pwInput.value = pw;
  pwInput.type  = 'text';
  document.querySelector('[data-target="pw-password"]').textContent = 'Hide';
  document.getElementById('gen-panel').style.display = 'none';
});

// ── Wizard navigation ─────────────────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step-${n}`).classList.add('active');

  const bar = document.getElementById('progress-bar');
  bar.style.display = n >= 1 && n <= 5 ? '' : 'none';

  const pbMap = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4, 6: 5 };
  const active = pbMap[n] || 0;
  [1, 2, 3, 4, 5].forEach(i => {
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
    _renderPwList();
    _initTriggerCountRow();
  } catch (e) {
    showAlert('key-error', `Device error: ${e.message}`);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Continue';
  }
});

// ── Step 2: Password setup ────────────────────────────────────────────────────
let _pwTriggerCount = 0;
let _pwTriggerSteps = [];
let _pwScanGen      = 0;   // increment to cancel stale scan handlers

function _initTriggerCountRow() {
  const row = document.getElementById('trigger-count-row');
  row.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button');
    btn.className   = 'trigger-count-btn';
    btn.dataset.count = i;
    btn.textContent = i;
    btn.type        = 'button';
    btn.addEventListener('click', () => {
      document.querySelectorAll('.trigger-count-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _pwTriggerCount = i;
      _pwTriggerSteps = [];
      _pwScanGen++;
      hideAlert('trigger-scan-error');
      hideAlert('pw-builder-error');
      document.getElementById('btn-pw-save').style.display        = 'none';
      document.getElementById('trigger-sensor-area').style.display = 'none';
      document.getElementById('trigger-scan-section').style.display = '';
      _updateTriggerDisplay();
      _startNextTriggerScan(_pwScanGen);
    });
    row.appendChild(btn);
  }
}

function _updateTriggerDisplay() {
  const stepsEl = document.getElementById('trigger-scan-steps');
  const emptyEl = document.getElementById('trigger-scan-empty');
  if (_pwTriggerSteps.length === 0) {
    stepsEl.innerHTML     = '';
    emptyEl.style.display = '';
  } else {
    emptyEl.style.display = 'none';
    stepsEl.innerHTML = _pwTriggerSteps
      .map(s => `<span class="seq-dot">F${s}</span>`)
      .join('<span class="seq-arrow"> → </span>');
  }
  const remaining = _pwTriggerCount - _pwTriggerSteps.length;
  document.getElementById('trigger-scan-prompt').textContent =
    remaining > 0
      ? `Scan finger ${_pwTriggerSteps.length + 1} of ${_pwTriggerCount} on the device.`
      : `All ${_pwTriggerCount} finger${_pwTriggerCount > 1 ? 's' : ''} set — ready to save.`;
}

function _setTriggerSensor(s, msg) {
  const el    = document.getElementById('trigger-sensor');
  const icon  = document.getElementById('trigger-sensor-icon');
  const msgEl = document.getElementById('trigger-sensor-msg');
  el.className = 'sensor';
  const map = {
    waiting: { cls: 'waiting', sym: '&#9632;' },
    placing: { cls: 'placing', sym: '&#8679;' },
    lifting: { cls: 'lifting', sym: '&#8679;' },
    again:   { cls: 'placing', sym: '&#8679;' },
    success: { cls: 'success', sym: '&#10003;' },
    fail:    { cls: 'fail',    sym: '&#10007;' },
  };
  const cfg = map[s] || { cls: '', sym: '&#9632;' };
  if (cfg.cls) el.classList.add(cfg.cls);
  icon.innerHTML    = cfg.sym;
  msgEl.textContent = msg;
}

async function _startNextTriggerScan(gen) {
  if (gen !== _pwScanGen) return;
  if (_pwTriggerSteps.length >= _pwTriggerCount) return;

  hideAlert('trigger-scan-error');
  document.getElementById('trigger-sensor-area').style.display = '';
  _setTriggerSensor('waiting', `Place finger ${_pwTriggerSteps.length + 1} on the sensor.`);

  let result;
  try {
    await send('SCAN_FINGER');
    result = await waitForAny(['SCANNED:', 'SCAN_UNENROLLED', 'FAIL:'], 20000);
  } catch (e) {
    if (gen !== _pwScanGen) return;
    showAlert('trigger-scan-error', `Scan error: ${e.message}`);
    _setTriggerSensor('fail', 'Error — check connection.');
    return;
  }
  if (gen !== _pwScanGen) return;

  if (result.startsWith('SCANNED:')) {
    const slot = +result.split(':')[1];
    _pwTriggerSteps.push(slot);
    _setTriggerSensor('success', `Finger ${_pwTriggerSteps.length} recognised (slot ${slot}).`);
    _updateTriggerDisplay();
    await delay(800);
    if (gen !== _pwScanGen) return;
    if (_pwTriggerSteps.length < _pwTriggerCount) {
      _startNextTriggerScan(gen);
    } else {
      _onTriggerComplete();
    }

  } else if (result === 'SCAN_UNENROLLED') {
    _setTriggerSensor('fail', 'New finger — lift finger and scan again to enroll it.');
    await delay(900);
    if (gen !== _pwScanGen) return;
    await _enrollForTrigger(gen);

  } else {
    const reason = result.split(':')[1] || '';
    _setTriggerSensor('fail', reason === 'timeout' ? 'No finger detected — try again.' : 'Scan failed — try again.');
    await delay(1500);
    _startNextTriggerScan(gen);
  }
}

async function _enrollForTrigger(gen) {
  if (gen !== _pwScanGen) return;
  const slot = state.nextSlot;
  _setTriggerSensor('placing', 'Place same finger on the sensor (scan 1 of 2).');

  let ok = false;
  try {
    await send(`ENROLL:${slot}`);
    ok = await new Promise(resolve => {
      const off = onLine(line => {
        if (line === `PLACE_FINGER:${slot}`) {
          _setTriggerSensor('placing', 'Place your finger on the sensor.');
        } else if (line === `LIFT_FINGER:${slot}`) {
          _setTriggerSensor('lifting', 'Lift your finger off the sensor.');
        } else if (line === `PLACE_AGAIN:${slot}`) {
          _setTriggerSensor('again', 'Place the same finger on the sensor again.');
        } else if (line === `OK:${slot}`) {
          off(); resolve(true);
        } else if (line.startsWith('FAIL:')) {
          off(); resolve(false);
        }
      });
    });
  } catch (e) {
    if (gen !== _pwScanGen) return;
    showAlert('trigger-scan-error', `Enrollment error: ${e.message}`);
    _setTriggerSensor('fail', 'Error — check connection.');
    return;
  }
  if (gen !== _pwScanGen) return;

  if (ok) {
    state.nextSlot++;
    _pwTriggerSteps.push(slot);
    _setTriggerSensor('success', `Finger ${_pwTriggerSteps.length} enrolled!`);
    _updateTriggerDisplay();
    await delay(800);
    if (gen !== _pwScanGen) return;
    if (_pwTriggerSteps.length < _pwTriggerCount) {
      _startNextTriggerScan(gen);
    } else {
      _onTriggerComplete();
    }
  } else {
    _setTriggerSensor('fail', 'Enrollment failed — tap the finger count to retry.');
  }
}

function _onTriggerComplete() {
  document.getElementById('trigger-sensor-area').style.display = 'none';
  document.getElementById('btn-pw-save').style.display         = '';
}

function _closePwBuilder() {
  _pwScanGen++;
  _pwTriggerCount = 0;
  _pwTriggerSteps = [];
  document.getElementById('pw-builder').style.display          = 'none';
  document.getElementById('btn-add-pw').style.display          = '';
  document.getElementById('trigger-scan-section').style.display = 'none';
  document.getElementById('trigger-sensor-area').style.display  = 'none';
  document.getElementById('btn-pw-save').style.display          = 'none';
  document.getElementById('gen-panel').style.display            = 'none';
  document.querySelectorAll('.trigger-count-btn').forEach(b => b.classList.remove('active'));
  hideAlert('pw-builder-error');
  hideAlert('trigger-scan-error');
}

function _renderPwList() {
  const list   = document.getElementById('pw-list');
  const noneEl = document.getElementById('pw-list-empty');
  if (state.passwords.length === 0) {
    list.innerHTML       = '';
    noneEl.style.display = '';
  } else {
    noneEl.style.display = 'none';
    list.innerHTML = state.passwords.map((pw, i) => `
      <div class="seq-item">
        <div class="seq-item-steps">
          ${pw.steps.map(s => `<span class="seq-dot">F${s}</span>`).join('<span class="seq-arrow"> → </span>')}
        </div>
        <span class="seq-item-label">${pw.label || '<em>no label</em>'}</span>
        <button class="btn-seq-remove" data-idx="${i}" type="button">Remove</button>
      </div>
    `).join('');
    list.querySelectorAll('.btn-seq-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        state.passwords.splice(+btn.dataset.idx, 1);
        _renderPwList();
      });
    });
  }
}

document.getElementById('btn-add-pw').addEventListener('click', () => {
  _pwScanGen++;
  _pwTriggerCount = 0;
  _pwTriggerSteps = [];
  document.getElementById('pw-label').value    = '';
  document.getElementById('pw-password').value = '';
  document.querySelectorAll('.trigger-count-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('trigger-scan-section').style.display = 'none';
  document.getElementById('trigger-sensor-area').style.display  = 'none';
  document.getElementById('btn-pw-save').style.display          = 'none';
  document.getElementById('gen-panel').style.display            = 'none';
  hideAlert('pw-builder-error');
  hideAlert('trigger-scan-error');
  document.getElementById('pw-builder').style.display = '';
  document.getElementById('btn-add-pw').style.display = 'none';
});

document.getElementById('btn-pw-cancel').addEventListener('click', () => {
  _closePwBuilder();
});

document.getElementById('btn-pw-save').addEventListener('click', () => {
  hideAlert('pw-builder-error');

  const password = document.getElementById('pw-password').value;
  if (!password)                return showAlert('pw-builder-error', 'Please enter a password.');
  if (_pwTriggerSteps.length === 0) return showAlert('pw-builder-error', 'Please set the trigger fingers first.');

  const startSlot = _pwTriggerSteps[0];
  const conflict  = state.passwords.find(p => p.steps[0] === startSlot);
  if (conflict) {
    return showAlert('pw-builder-error',
      `Finger ${startSlot} already starts "${conflict.label || 'another password'}". ` +
      `Please use a different starting finger.`);
  }

  state.passwords.push({
    label:    document.getElementById('pw-label').value.trim(),
    password,
    steps:    [..._pwTriggerSteps],
  });

  _closePwBuilder();
  _renderPwList();
});

document.getElementById('btn-step2-continue').addEventListener('click', () => {
  hideAlert('step2-error');
  if (state.passwords.length === 0) {
    return showAlert('step2-error', 'Please add at least one password before continuing.');
  }
  goToStep(3);
  _initTestStep();
});

document.getElementById('btn-step2-back').addEventListener('click', () => {
  goToStep(1);
});

// ── Step 3: Test ──────────────────────────────────────────────────────────────
let _testSeqBuf  = [];
let _testScanGen = 0;
let _testHistory = [];

function _initTestStep() {
  _testSeqBuf  = [];
  _testScanGen++;
  _testHistory = [];
  _setTestLED('idle');
  document.getElementById('test-history').innerHTML     = '';
  document.getElementById('btn-test-scan').disabled     = false;
  document.getElementById('btn-test-scan').textContent  = 'Scan Finger';
  document.getElementById('btn-test-continue').disabled = false;
  hideAlert('test-error');
}

function _setTestLED(state) {
  const el    = document.getElementById('test-sensor');
  const msgEl = document.getElementById('test-sensor-msg');
  el.className = 'sensor';
  const map = {
    'idle':         { cls: 'led-idle',         msg: 'Tap Scan Finger when ready.' },
    'scanning':     { cls: 'led-scanning',     msg: 'Place your finger on the sensor…' },
    'flash-blue':   { cls: 'led-flash-blue',   msg: 'Blue flash — password matched.' },
    'flash-yellow': { cls: 'led-flash-yellow', msg: 'Yellow flash — step accepted, scan the next finger.' },
    'flash-red':    { cls: 'led-flash-red',    msg: 'Red flash — no match. Try again from the first finger.' },
  };
  const cfg = map[state] || map['idle'];
  el.classList.add(cfg.cls);
  msgEl.textContent = cfg.msg;
}

function _testMatchSlot(slot) {
  _testSeqBuf.push(slot);
  const key = _testSeqBuf.join(',');

  const match = state.passwords.find(p => p.steps.join(',') === key);
  if (match) {
    _testSeqBuf = [];
    return { type: 'match', pw: match };
  }

  const isPrefix = state.passwords.some(p =>
    p.steps.length > _testSeqBuf.length &&
    _testSeqBuf.every((s, i) => s === p.steps[i])
  );
  if (isPrefix) return { type: 'partial' };

  _testSeqBuf = [];
  return { type: 'no_match' };
}

function _renderTestHistory() {
  const el = document.getElementById('test-history');
  if (_testHistory.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="test-history-label">Recent scans:</p>' +
    _testHistory.map(h =>
      `<span class="test-pill test-pill-${h.cls}">${h.text}</span>`
    ).join('');
}

document.getElementById('btn-test-scan').addEventListener('click', async () => {
  const gen         = ++_testScanGen;
  const scanBtn     = document.getElementById('btn-test-scan');
  const continueBtn = document.getElementById('btn-test-continue');

  scanBtn.disabled     = true;
  scanBtn.textContent  = 'Scanning...';
  continueBtn.disabled = true;
  hideAlert('test-error');
  _setTestLED('scanning');

  let line;
  try {
    await send('SCAN_FINGER_QUIET');
    line = await waitForAny(['SCANNED:', 'SCAN_UNENROLLED', 'FAIL:'], 15000);
  } catch (e) {
    if (gen !== _testScanGen) return;
    _setTestLED('idle');
    showAlert('test-error', `Scan error: ${e.message}`);
    scanBtn.disabled     = false;
    scanBtn.textContent  = 'Scan Finger';
    continueBtn.disabled = false;
    return;
  }
  if (gen !== _testScanGen) return;

  let result;
  if (line.startsWith('SCANNED:')) {
    result = _testMatchSlot(+line.split(':')[1]);
  } else if (line === 'SCAN_UNENROLLED') {
    _testSeqBuf = [];
    result = { type: 'unenrolled' };
  } else {
    result = { type: 'timeout' };
  }

  // Drive the physical LED to match exactly what locked mode would show,
  // then update the on-screen LED widget to the same colour.
  if (result.type === 'match') {
    send('SET_LED:2:2').catch(() => {});          // flash blue
    _setTestLED('flash-blue');
    _testHistory.unshift({ cls: 'match', text: result.pw.label || 'no label' });
  } else if (result.type === 'partial') {
    send('SET_LED:3:2').catch(() => {});          // flash yellow
    _setTestLED('flash-yellow');
  } else if (result.type === 'no_match' || result.type === 'unenrolled') {
    send('SET_LED:1:2').catch(() => {});          // flash red
    _setTestLED('flash-red');
    _testHistory.unshift({ cls: 'fail', text: result.type === 'unenrolled' ? 'not enrolled' : 'no match' });
  } else {
    _setTestLED('idle');
  }

  if (_testHistory.length > 5) _testHistory.length = 5;
  _renderTestHistory();

  // After the flash settles, reset physical LED to setup-idle and screen to idle
  if (result.type !== 'partial' && result.type !== 'timeout') {
    const g = gen;
    setTimeout(() => {
      if (_testScanGen !== g) return;
      send('SET_LED:3:1').catch(() => {});        // setup idle = solid yellow
      _setTestLED('idle');
    }, 1500);
  }

  scanBtn.disabled    = false;
  scanBtn.textContent = result.type === 'partial'
    ? `Scan Finger ${_testSeqBuf.length + 1}`
    : 'Scan Again';
  continueBtn.disabled = false;
});

document.getElementById('btn-test-continue').addEventListener('click', async () => {
  hideAlert('test-error');
  _testScanGen++;  // cancel any in-flight scan

  const btn = document.getElementById('btn-test-continue');
  btn.disabled    = true;
  btn.textContent = 'Saving...';

  try {
    for (const pw of state.passwords) {
      if (pw.steps.length === 1) {
        const slot = pw.steps[0];
        await send(`SET_PASSWORD:${slot}:${pw.password}`);
        await waitFor(`OK:PASSWORD:${slot}`, 6000);
      } else {
        const key = pw.steps.join(',');
        await send(`SET_SEQ_PASSWORD:${key}:${pw.password}`);
        await waitFor(`OK:SEQ_PASSWORD:${key}`, 6000);
      }
    }
    goToStep(4);
    _renderReview();
  } catch (e) {
    showAlert('test-error', `Error saving passwords: ${e.message}`);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Continue to Review';
  }
});

document.getElementById('btn-test-back').addEventListener('click', () => {
  _testScanGen++;
  _testSeqBuf = [];
  goToStep(2);
  _renderPwList();
});

// ── Step 4: Review ────────────────────────────────────────────────────────────
function _renderReview() {
  const tbody = document.getElementById('review-body');
  const none  = document.getElementById('review-none');

  if (state.passwords.length === 0) {
    tbody.innerHTML = '';
    none.style.display = '';
    document.getElementById('btn-lockdown').disabled = true;
  } else {
    none.style.display = 'none';
    document.getElementById('btn-lockdown').disabled = false;
    tbody.innerHTML = state.passwords.map(pw => `
      <tr>
        <td>${pw.steps.map(s => `F${s}`).join(' → ')}</td>
        <td>${pw.label || '<em style="color:#94a3b8">no label</em>'}</td>
        <td style="font-family:monospace">${'•'.repeat(Math.min(pw.password.length, 10))}</td>
      </tr>
    `).join('');
  }
}

document.getElementById('btn-back-to-fingers').addEventListener('click', () => {
  goToStep(3);
  _initTestStep();
});

document.getElementById('btn-lockdown').addEventListener('click', async () => {
  hideAlert('lockdown-error');
  if (state.passwords.length === 0) return;

  const btn = document.getElementById('btn-lockdown');
  btn.disabled    = true;
  btn.textContent = 'Locking...';

  try {
    await send('LOCK_DOWN');
    await waitFor('LOCKING', 8000);
    goToStep(5);
    // Device reboots after ~300ms; show locking screen briefly then done
    setTimeout(() => goToStep(6), 2500);
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
