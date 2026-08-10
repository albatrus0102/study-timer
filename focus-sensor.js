"use strict";
/* ══════════════════════════════════════════════════════════════════
   FocusSensor — 자습 집중도 측정 센서 모듈
   focus-tracker.html(단독 검증용)과 study-timer mac 버전이 함께 쓴다.
   판정 상수는 근거가 있는 값이므로 임의 변경 금지 (사양서 §5).

   외부 인터페이스 (사양서 §11)
     FocusSensor.init(onCheck)          → 초기화. 체크포인트를 onCheck(key,status,msg)로 흘림
     FocusSensor.calibrate(onProgress)  → {cal} 또는 {error}
     FocusSensor.start(cal, onState, onTick) → session
     FocusSensor.pause(kind) / resume() → kind: 'sleep' | 'break'
     FocusSensor.stop()                 → session 객체
     FocusSensor.report(session, el)    → 지정 엘리먼트에 리포트 렌더
   ══════════════════════════════════════════════════════════════════ */
(function (global) {

const HZ = 10, SAMPLE_MS = 1000 / HZ;

// 사양서가 지정한 0.10.22 는 npm 에 존재하지 않는다 (0.10.21 다음이 0.10.32).
// 실재하는 버전을 앞에서부터 시도한다. 셋 다 FaceLandmarker/FilesetResolver API 동일.
const CDN_VERSIONS = ['0.10.35', '1.0.1', '0.10.21'];
const cdnBase = v => `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${v}`;
let CDN = cdnBase(CDN_VERSIONS[0]);
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/' +
                  'face_landmarker/float16/1/face_landmarker.task';

const LM = {
  left:  [33, 133, 160, 144, 158, 153],   // 외, 내, 상1, 하1, 상2, 하2
  right: [362, 263, 385, 380, 387, 373],
  chin: 152, nose: 1, sideL: 234, sideR: 454,
  mouthU: 13, mouthD: 14, mouthL: 61, mouthR: 291,
  eyeL: 33, eyeR: 263
};

// 0 집중 1 이탈 2 졸음 3 자리비움 4 수면 5 휴식
// 4·5는 둘 다 집중률 분모에서 빠지지만 서로 다른 사건이라 분리해 센다.
const STATE = ['집중', '이탈', '졸음', '자리비움', '수면', '휴식'];
const COLOR = ['#1f6f4a', '#b08a2e', '#c8502f', '#4a4a52', '#3b4a86', '#2a4a55'];
const EXCLUDED = [4, 5];

const DEFAULTS = {
  earFrac: 0.20,      // PERCLOS P80
  perclos: 0.15,      // 60초 창 임계
  headComp: 1.0,      // 고개 숙임 보정 계수
  yawThr: 0.35,
  closedSec: 1.5,     // 마이크로슬립 즉시 판정
  turnSec: 3.0,
  missSec: 10.0,
  perclosWinSec: 60,
  perclosMinValidSec: 20,
  marMul: 2.2, marFloor: 0.35, yawnSec: 0.6,
  alertCooldownSec: 20,
  alerts: true,
  // 졸음으로 찍힌 순간의 128×96 썸네일. 오판을 눈으로 걸러내지 못하면 임계값을 조정할
  // 근거가 없어서 기본값은 켜짐이다 (§8). 이 기기 IndexedDB 에만 남고 어디로도 전송되지 않는다.
  shots: true
};

const CHECKS = [
  ['ctx',   '실행 컨텍스트'],
  ['esm',   'ESM import'],
  ['wasm',  'MediaPipe WASM'],
  ['model', '모델 다운로드'],
  ['task',  'FaceLandmarker 생성'],
  ['perm',  '카메라 권한'],
  ['face',  '첫 얼굴 인식']
];

/* ─────────────────── 유틸 ─────────────────── */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function median(a) { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function pct(a, p) { if (!a.length) return NaN; const s = Float64Array.from(a).sort();
  return s[clamp(Math.round((s.length - 1) * p), 0, s.length - 1)]; }
function hms(sec) { sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
           : `${m}:${String(s).padStart(2,'0')}`; }
function durTxt(sec) { return sec >= 60 ? `${Math.floor(sec/60)}분 ${Math.round(sec%60)}초` : `${sec.toFixed(1)}초`; }
function clockAt(ms) { const d = new Date(ms);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`; }

class Buf {
  constructor(type) { this.T = type || Int16Array; this.a = new this.T(16384); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  slice() { return this.a.slice(0, this.n); }
}

/* ══════════════════════════════════════════════════════════════════
   지표 계산 (사양서 §3)
   랜드마크는 정규화 좌표라 x는 폭, y는 높이로 되돌려야 비율이 맞는다.
   ══════════════════════════════════════════════════════════════════ */
function metricsFrom(lm, W, H) {
  const d = (i, j) => Math.hypot((lm[i].x - lm[j].x) * W, (lm[i].y - lm[j].y) * H);
  const earOf = e => { const w = d(e[0], e[1]); return w < 1e-6 ? NaN : (d(e[2], e[3]) + d(e[4], e[5])) / (2 * w); };
  const ear = (earOf(LM.left) + earOf(LM.right)) / 2;

  const eyeSpan = d(LM.eyeL, LM.eyeR);
  const mx = (lm[LM.eyeL].x + lm[LM.eyeR].x) / 2 * W;
  const my = (lm[LM.eyeL].y + lm[LM.eyeR].y) / 2 * H;
  const faceH = Math.hypot(mx - lm[LM.chin].x * W, my - lm[LM.chin].y * H) / (eyeSpan || 1e-6);

  const dl = Math.hypot((lm[LM.nose].x - lm[LM.sideL].x) * W, (lm[LM.nose].y - lm[LM.sideL].y) * H);
  const dr = Math.hypot((lm[LM.nose].x - lm[LM.sideR].x) * W, (lm[LM.nose].y - lm[LM.sideR].y) * H);
  const yawLog = Math.log(Math.max(dl, 1e-6) / Math.max(dr, 1e-6));

  const mw = d(LM.mouthL, LM.mouthR);
  const mar = mw < 1e-6 ? 0 : d(LM.mouthU, LM.mouthD) / mw;

  return { ear, faceH, yawLog, mar };
}

/* 고개 숙임 보정 (§5.3) — faceH는 보정 계수로만 쓴다 */
function earAdjust(ear, faceH, cal, headComp) {
  const r = clamp(faceH / cal.faceH, 0.55, 1.15);
  return ear * (1 + headComp * (1 / r - 1));
}
function opennessOf(earAdj, cal) {
  const sp = cal.earOpen - cal.earClosed;
  return sp <= 0 ? 0 : clamp((earAdj - cal.earClosed) / sp, 0, 1);
}

/* ══════════════════════════════════════════════════════════════════
   판정 상태기 (§5.4 / §5.7)
   실시간과 사후가 같은 step() 을 쓴다. 실시간은 머신을 유지한 채 샘플마다,
   사후는 새 머신으로 전체를 훑는다. 연속 시간은 (샘플수-1)/HZ 로 잰다.
   ══════════════════════════════════════════════════════════════════ */
function createMachine(cal, opt, sleeps, breaks) {
  const o = Object.assign({}, DEFAULTS, opt || {});
  const win = Math.round(o.perclosWinSec * HZ);
  return {
    o, cal, sleeps: sleeps || [], breaks: breaks || [],
    earThr: cal.earClosed + o.earFrac * (cal.earOpen - cal.earClosed),
    backN: Math.round(o.closedSec * HZ),
    minValid: Math.round(o.perclosMinValidSec * HZ),
    win, ring: new Uint8Array(win), rvalid: new Uint8Array(win),
    rp: 0, sClosed: 0, sValid: 0,
    miss: 0, closedRun: 0, turnRun: 0, micro: false,
    prev: 0, sp: 0, bp: 0, inX: false,
    onEvent: null
  };
}
function machReset(m) {
  m.ring.fill(0); m.rvalid.fill(0); m.rp = 0; m.sClosed = 0; m.sValid = 0;
  m.miss = 0; m.closedRun = 0; m.turnRun = 0; m.micro = false; m.prev = 0;
}
function ringPush(m, valid, closed) {
  m.sValid -= m.rvalid[m.rp]; m.sClosed -= m.ring[m.rp];
  m.rvalid[m.rp] = valid; m.ring[m.rp] = closed;
  m.sValid += valid; m.sClosed += closed;
  m.rp = (m.rp + 1) % m.win;
}
function inRange(list, ptrName, m, i) {
  while (m[ptrName] < list.length && list[m[ptrName]][1] < i) m[ptrName]++;
  const s = list[m[ptrName]];
  return !!(s && i >= s[0] && i <= s[1]);
}

/** 샘플 1개 판정. states[i]에 기록하고 필요하면 소급 백필한다 (§5.5). */
function step(m, i, ok, ear, faceH, yaw, states) {
  const sleeping = inRange(m.sleeps, 'sp', m, i);
  const resting = !sleeping && inRange(m.breaks, 'bp', m, i);
  if (sleeping || resting) {
    if (!m.inX) { machReset(m); m.inX = true; }
    states[i] = sleeping ? 4 : 5;
    return states[i];
  }
  m.inX = false;
  const o = m.o;

  if (!ok) {
    m.miss++;
    ringPush(m, 0, 0);
    const st = ((m.miss - 1) / HZ >= o.missSec) ? 3 : m.prev;
    states[i] = st; m.prev = st; return st;
  }
  m.miss = 0;

  const earAdj = earAdjust(ear, faceH, m.cal, o.headComp);
  const closed = earAdj < m.earThr;
  ringPush(m, 1, closed ? 1 : 0);

  if (closed) m.closedRun++; else { m.closedRun = 0; m.micro = false; }
  if (Math.abs(yaw - m.cal.yawLog) > o.yawThr) m.turnRun++; else m.turnRun = 0;

  let st = 0;
  if (m.closedRun > 0 && (m.closedRun - 1) / HZ >= o.closedSec) {
    st = 2;
    if (!m.micro) {                       // 백필: 판정이 서는 순간 직전 1.5초를 소급
      m.micro = true;
      for (let j = i - 1; j >= 0 && j > i - 1 - m.backN; j--) {
        if (states[j] === 4 || states[j] === 5) break;
        states[j] = 2;
      }
      if (m.onEvent) m.onEvent('drowsy', i);
    }
  } else if (m.sValid >= m.minValid && m.sClosed / m.sValid > o.perclos) {
    st = 2;
    if (m.prev !== 2 && m.onEvent) m.onEvent('drowsy', i);
  } else if (m.turnRun > 0 && (m.turnRun - 1) / HZ >= o.turnSec) {
    st = 1;
  }
  states[i] = st; m.prev = st; return st;
}

/** 사후 전체 재판정 (§5.7) — 슬라이더가 호출한다 */
function rejudge(sess, opt) {
  const st = new Uint8Array(sess.count);
  const m = createMachine(sess.cal, opt, sess.sleeps, sess.breaks || []);
  const { ok, ear, faceH, yaw } = sess;
  for (let i = 0; i < sess.count; i++) step(m, i, ok[i], ear[i] / 1000, faceH[i] / 100, yaw[i] / 100, st);
  return st;
}

function segments(states, want) {
  const out = []; let s = -1;
  for (let i = 0; i < states.length; i++) {
    if (states[i] === want) { if (s < 0) s = i; }
    else if (s >= 0) { out.push([s, i - 1]); s = -1; }
  }
  if (s >= 0) out.push([s, states.length - 1]);
  return out;
}
function mergeSegs(segs, gapSec, minSec) {
  const g = gapSec * HZ, mn = minSec * HZ, out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && s[0] - last[1] - 1 <= g) last[1] = s[1];
    else out.push([s[0], s[1]]);
  }
  return out.filter(s => (s[1] - s[0] + 1) >= mn);
}
/** 집중률 — 수면·휴식 구간은 분모에서 제외 (§6) */
function stats(states) {
  const c = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < states.length; i++) c[states[i]]++;
  const denom = states.length - c[4] - c[5];
  return { c, denom, rate: denom > 0 ? c[0] / denom : 0,
           rateRaw: states.length ? c[0] / states.length : 0 };
}

/* ══════════════════════════════════════════════════════════════════
   알림 (§7) — 선행음이 없으면 블루투스 코덱이 깨는 0.3~0.5초가 잘려나간다
   ══════════════════════════════════════════════════════════════════ */
const Sound = {
  ctx: null, keep: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
    try { this.ctx = new (global.AudioContext || global.webkitAudioContext)(); } catch (e) { return null; }
    return this.ctx;
  },
  beep() {
    const c = this.init(); if (!c) return;
    if (c.state === 'suspended') c.resume();
    const t0 = c.currentTime;
    const o0 = c.createOscillator(), g0 = c.createGain();       // 선행음 (희생타)
    o0.type = 'sine'; o0.frequency.value = 220;
    g0.gain.setValueAtTime(0.0001, t0);
    g0.gain.exponentialRampToValueAtTime(0.03, t0 + 0.45);
    g0.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    o0.connect(g0).connect(c.destination); o0.start(t0); o0.stop(t0 + 0.52);
    for (let k = 0; k < 3; k++) {
      const t = t0 + 0.52 + k * 0.22;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.value = 760;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      g.gain.setValueAtTime(0.3, t + 0.16);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.19);
    }
  },
  flash() {
    let el = document.getElementById('fsFlash');
    if (!el) {
      el = document.createElement('div'); el.id = 'fsFlash';
      el.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:99999';
      document.body.appendChild(el);
    }
    let k = 0;
    const go = () => {
      if (k >= 6) { el.style.opacity = 0; return; }
      el.style.transition = 'opacity .09s';
      el.style.opacity = (k % 2 === 0) ? 0.85 : 0;
      k++; setTimeout(go, 150);
    };
    go();
  },
  alert() { this.beep(); this.flash(); },
  setKeepAlive(on) {
    const c = this.init(); if (!c) return;
    if (on && !this.keep) {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 40; g.gain.value = 0.0006;
      o.connect(g).connect(c.destination); o.start();
      this.keep = { o, g };
    } else if (!on && this.keep) {
      try { this.keep.o.stop(); } catch (e) {}
      this.keep = null;
    }
  }
};

/* ══════════════════════════════════════════════════════════════════
   저장 (§8) — 실패해도 메모리만으로 계속 동작해야 한다.
   타이머와 DB 하나를 공유하되 store 이름을 분리한다 (§11).
   ══════════════════════════════════════════════════════════════════ */
const DB = {
  db: null, dead: false,
  open() {
    if (this.db || this.dead) return Promise.resolve(this.db);
    return new Promise(res => {
      try {
        const rq = indexedDB.open('focusTracker', 1);
        rq.onupgradeneeded = () => {
          const d = rq.result;
          if (!d.objectStoreNames.contains('focusSessions')) d.createObjectStore('focusSessions', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('focusMeta')) d.createObjectStore('focusMeta');
        };
        rq.onsuccess = () => { this.db = rq.result; res(this.db); };
        rq.onerror = () => { this.dead = true; console.warn('[FocusSensor] IDB 열기 실패', rq.error); res(null); };
      } catch (e) { this.dead = true; console.warn('[FocusSensor] IDB 예외', e); res(null); }
    });
  },
  async put(store, val, key) {
    try {
      const d = await this.open(); if (!d) return false;
      return await new Promise(res => {
        const tx = d.transaction(store, 'readwrite');
        tx.objectStore(store).put(val, key);
        tx.oncomplete = () => res(true);
        tx.onerror = () => { console.warn('[FocusSensor] IDB 쓰기 실패', tx.error); res(false); };
      });
    } catch (e) { console.warn('[FocusSensor] IDB 쓰기 예외', e); return false; }
  },
  async get(store, key) {
    try {
      const d = await this.open(); if (!d) return null;
      return await new Promise(res => {
        const tx = d.transaction(store, 'readonly');
        const rq = tx.objectStore(store).get(key);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
      });
    } catch (e) { return null; }
  },
  async all(store) {
    try {
      const d = await this.open(); if (!d) return [];
      return await new Promise(res => {
        const tx = d.transaction(store, 'readonly');
        const rq = tx.objectStore(store).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => res([]);
      });
    } catch (e) { return []; }
  }
};

/* ══════════════════════════════════════════════════════════════════
   센서 본체
   ══════════════════════════════════════════════════════════════════ */
let landmarker = null, stream = null, video = null, ready = false;
let sess = null, mach = null, stateBuf = null;
let running = false, paused = false, pauseKind = null;
let t0 = 0, timer = null, snapTimer = null;
let onStateCb = null, onTickCb = null;
let lastVideoTime = -1, lastMet = null;
let wakeLock = null, lastAlert = -1e9, yawnRun = 0, shotCanvas = null;
// 카메라를 새로 열면 자동 노출·화이트밸런스가 잡힐 때까지 1~2초간 화면이 흔들린다.
// 그 구간의 랜드마크는 못 믿으므로 얼굴 소실(ok=0)로 기록해 판정에서 뺀다.
// 휴식에서 돌아올 때마다 카메라를 다시 열기 때문에 매번 적용된다.
const CAM_WARMUP_MS = 2000;
let camWarmUntil = 0;
let opts = Object.assign({}, DEFAULTS);
let checkCb = null;

function ck(key, status, msg) {
  if (checkCb) checkCb(key, status, msg == null ? '' : String(msg));
  console.log(`[FocusSensor] ${key}: ${status} — ${msg || ''}`);
}

/** 비디오 엘리먼트는 body 최상위에 두고 opacity 로만 숨긴다.
    display:none 서브트리에 있으면 브라우저가 프레임 디코딩을 멈춘다 (§2). */
function ensureVideo() {
  video = document.getElementById('fsCam');
  if (video) return video;
  video = document.createElement('video');
  video.id = 'fsCam';
  video.playsInline = true; video.muted = true; video.autoplay = true;
  video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;' +
    'object-fit:cover;transform:scaleX(-1);z-index:5;pointer-events:none;border-radius:10px';
  document.body.appendChild(video);
  return video;
}
/** 캘리브레이션 중에만 미리보기를 키운다. 렌더 트리에서 빼지 않는다. */
function showPreview(on) {
  if (!video) return;
  if (on) video.style.cssText = video.style.cssText
    .replace(/width:[^;]+;/, 'width:240px;').replace(/height:[^;]+;/, 'height:180px;')
    .replace(/opacity:[^;]+;/, 'opacity:1;').replace(/left:[^;]+;/, 'left:20px;')
    .replace(/top:[^;]+;/, 'top:20px;');
  else video.style.cssText = video.style.cssText
    .replace(/width:[^;]+;/, 'width:2px;').replace(/height:[^;]+;/, 'height:2px;')
    .replace(/opacity:[^;]+;/, 'opacity:.01;');
}

async function init(onCheck) {
  checkCb = onCheck || null;
  if (ready) { ck('face', 'ok', '이미 초기화됨'); return true; }
  ensureVideo();

  // 1) 실행 컨텍스트
  const proto = location.protocol, framed = global.top !== global.self;
  if (proto === 'file:') {
    ck('ctx', 'bad', 'file:// 로 열렸습니다. getUserMedia 가 아예 호출되지 않습니다. localhost 또는 https 로 여세요.');
    return false;
  }
  if (framed) ck('ctx', 'bad', 'iframe 안입니다. 카메라 권한이 차단될 수 있습니다.');
  else if (!global.isSecureContext) { ck('ctx', 'bad', `보안 컨텍스트가 아닙니다 (${proto}). localhost 또는 https 필요.`); return false; }
  else ck('ctx', 'ok', `${proto}//${location.host} · secureContext`);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    ck('ctx', 'bad', 'navigator.mediaDevices 가 없습니다.'); return false;
  }

  // 2) ESM import — 버전을 순서대로 시도
  let vision = null, usedVer = null; const esmErr = [];
  ck('esm', 'run', '불러오는 중…');
  for (const v of CDN_VERSIONS) {
    try {
      const m = await import(`${cdnBase(v)}/vision_bundle.mjs`);
      if (!m.FaceLandmarker || !m.FilesetResolver) throw new Error('FaceLandmarker/FilesetResolver export 없음');
      vision = m; usedVer = v; CDN = cdnBase(v); break;
    } catch (e) { esmErr.push(`${v}: ${e.message}`); }
  }
  if (!vision) {
    ck('esm', 'bad', `모든 버전 실패 — ${esmErr.join(' / ')}. CDN 차단(방화벽/오프라인)이거나 버전이 사라졌습니다.`);
    return false;
  }
  ck('esm', 'ok', `tasks-vision@${usedVer}` + (esmErr.length ? ` (앞선 실패: ${esmErr.join(', ')})` : ''));

  // 3) WASM — ESM 과 같은 버전을 써야 한다
  let fileset;
  ck('wasm', 'run', '다운로드 중…');
  try { fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`); ck('wasm', 'ok', `${CDN}/wasm`); }
  catch (e) { ck('wasm', 'bad', e.message); return false; }

  // 4) 모델 — 직접 fetch 해서 WASM 실패와 구분한다
  let modelBuf;
  ck('model', 'run', '다운로드 중…');
  try {
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    modelBuf = new Uint8Array(await r.arrayBuffer());
    ck('model', 'ok', `face_landmarker.task ${(modelBuf.length / 1048576).toFixed(2)}MB`);
  } catch (e) { ck('model', 'bad', `${e.message} — 모델 CDN 접근 실패`); return false; }

  // 5) FaceLandmarker (GPU → CPU 폴백)
  ck('task', 'run', 'GPU 시도…');
  const mk = delegate => vision.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: modelBuf, delegate },
    runningMode: 'VIDEO', numFaces: 1,
    outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false
  });
  try { landmarker = await mk('GPU'); ck('task', 'ok', 'delegate: GPU'); }
  catch (e1) {
    try { landmarker = await mk('CPU'); ck('task', 'ok', `delegate: CPU (GPU 실패: ${e1.message})`); }
    catch (e2) { ck('task', 'bad', e2.message); return false; }
  }

  // 6) 카메라 권한
  ck('perm', 'run', '권한 요청 중…');
  if (!(await openCamera())) return false;

  // 7) 첫 얼굴 인식
  ck('face', 'run', '얼굴 찾는 중…');
  const t = performance.now(); let got = null;
  while (performance.now() - t < 8000) {
    const r = detectNow();
    if (r) { got = r; break; }
    await new Promise(r2 => setTimeout(r2, 100));
  }
  if (!got) { ck('face', 'bad', '8초 동안 얼굴을 못 찾았습니다. 조명/카메라 각도를 확인하세요.'); return false; }
  ck('face', 'ok', `EAR ${got.ear.toFixed(3)} · faceH ${got.faceH.toFixed(2)} · yaw ${got.yawLog.toFixed(2)}`);
  ready = true;
  return true;
}

async function openCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: { max: 15 } } });
    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise(res => { if (video.videoWidth) return res();
      video.onloadedmetadata = res; setTimeout(res, 4000); });
    lastVideoTime = -1; lastMet = null;
    camWarmUntil = performance.now() + CAM_WARMUP_MS;
    const tr = stream.getVideoTracks()[0];
    ck('perm', 'ok', `${video.videoWidth}×${video.videoHeight} · ${tr ? tr.label : ''}`);
    return true;
  } catch (e) {
    const map = { NotAllowedError: '사용자가 거부했거나 브라우저 설정에서 차단됨',
      NotFoundError: '카메라 장치를 찾을 수 없음', NotReadableError: '다른 앱이 카메라를 점유 중' };
    ck('perm', 'bad', `${e.name}: ${map[e.name] || e.message}`);
    return false;
  }
}

/** 프레임 1회 추론. 영상은 저장하지 않고 지표만 남긴다. */
function detectNow() {
  if (!landmarker || !video || !video.videoWidth) return null;
  if (video.currentTime === lastVideoTime) return lastMet;   // 같은 프레임이면 재사용
  lastVideoTime = video.currentTime;
  let res;
  try { res = landmarker.detectForVideo(video, performance.now()); } catch (e) { return null; }
  const lm = res && res.faceLandmarks && res.faceLandmarks[0];
  if (!lm) { lastMet = null; return null; }
  const m = metricsFrom(lm, video.videoWidth, video.videoHeight);
  lastMet = isFinite(m.ear) ? m : null;
  return lastMet;
}

/* ─────────────────── 캘리브레이션 (§4) ─────────────────── */
const CAL_STAGES = [
  { key: 'A', sec: 45, instr: '실제로 문제를 푸세요',
    hint: '고개를 숙여도 되고 필기해도 됩니다. 지금 자세가 “집중”의 기준선이 됩니다.' },
  { key: 'B', sec: 10, instr: '눈을 편하게 감고 계세요', hint: '꽉 감지 말고 자연스럽게.' },
  { key: 'C', sec: 10, instr: '고개 들고 화면 정면을 보세요', hint: '평소 화면 볼 때 자세로.' }
];
let calAbort = null;

function calibrate(onProgress) {
  return new Promise(resolve => {
    if (!ready) return resolve({ error: '초기화가 끝나지 않았습니다.' });
    showPreview(true);
    const acc = CAL_STAGES.map(() => ({ ear: [], faceH: [], yaw: [], mar: [], n: 0, ok: 0 }));
    let si = 0, ts = performance.now();
    const done = r => { clearInterval(iv); calAbort = null; showPreview(false); resolve(r); };
    const iv = setInterval(() => {
      const st = CAL_STAGES[si], a = acc[si];
      const el = (performance.now() - ts) / 1000;
      const m = detectNow();
      a.n++;
      if (m) { a.ok++; a.ear.push(m.ear); a.faceH.push(m.faceH); a.yaw.push(m.yawLog); a.mar.push(m.mar); }
      if (onProgress) onProgress({ stage: si, key: st.key, instr: st.instr, hint: st.hint,
        left: Math.max(0, st.sec - el), frac: clamp(el / st.sec, 0, 1), okRate: a.ok / a.n, m });
      if (el >= st.sec) {
        si++; ts = performance.now();
        if (si >= CAL_STAGES.length) done(finishCal(acc));
      }
    }, SAMPLE_MS);
    calAbort = () => done({ error: '중단됨' });
  });
}
function finishCal(acc) {
  const [A, B, C] = acc;
  const okRate = (A.ok + B.ok + C.ok) / (A.n + B.n + C.n);
  if (okRate < 0.5) return { error: `얼굴 인식률 ${(okRate*100).toFixed(0)}% — 절반 이상 놓쳤습니다. 조명/각도를 고치고 다시 하세요.` };
  if (!A.ear.length || !B.ear.length || !C.ear.length)
    return { error: '한 단계에서 얼굴을 전혀 못 잡았습니다. 다시 하세요.' };

  const cal = {
    earOpen: pct(A.ear, 0.80),      // 최댓값 아닌 p80 — 깜빡임 배제
    earClosed: median(B.ear),
    faceH: median(A.faceH),         // 실제 자습 자세가 기준
    faceHFront: median(C.faceH),
    yawLog: median(C.yaw),
    mar: median(A.mar),
    at: Date.now(), okRate
  };
  const sep = cal.earOpen - cal.earClosed;
  cal.sep = sep;
  cal.earThr = cal.earClosed + DEFAULTS.earFrac * sep;
  cal.warn = sep < 0.045
    ? `EAR 분리도 ${sep.toFixed(3)} (< 0.045). 뜬 눈과 감은 눈이 붙어 있어 이후 판정이 무의미합니다. 조명을 밝히거나 카메라를 눈높이로 올린 뒤 재측정하세요.`
    : null;
  return { cal };
}

/* ─────────────────── 세션 ─────────────────── */
function newSession(cal) {
  return {
    id: 'S' + Date.now(), startedAt: Date.now(), endedAt: 0, hz: HZ, count: 0, cal,
    _ok: new Buf(), _ear: new Buf(), _faceH: new Buf(), _yaw: new Buf(), _mar: new Buf(),
    sleeps: [], breaks: [], gaps: [], shots: [], yawns: 0,
    get ok() { return this._ok.a; }, get ear() { return this._ear.a; },
    get faceH() { return this._faceH.a; }, get yaw() { return this._yaw.a; }, get mar() { return this._mar.a; }
  };
}
function pushSample(ok, ear, faceH, yaw, mar) {
  sess._ok.push(ok); sess._ear.push(Math.round(ear * 1000));
  sess._faceH.push(Math.round(faceH * 100)); sess._yaw.push(Math.round(yaw * 100));
  sess._mar.push(Math.round(mar * 100));
  if (stateBuf.length <= sess.count) { const b = new Uint8Array(stateBuf.length * 2); b.set(stateBuf); stateBuf = b; }
  const i = sess.count++;
  step(mach, i, ok, ear, faceH, yaw, stateBuf);
  return i;
}

function tick() {
  if (!running) return;
  const now = performance.now();
  let guard = 0;
  while (now >= t0 + sess.count * SAMPLE_MS && guard++ < 20000) {
    const due = t0 + sess.count * SAMPLE_MS;
    const fresh = (now - due) < SAMPLE_MS * 1.5;
    let i;
    if (paused || !fresh || now < camWarmUntil) {
      // 수면·휴식 중이거나 탭이 가려져 놓친 구간 — 인덱스는 계속 증가시켜 시간축을 유지 (§6)
      i = pushSample(0, 0, 0, 0, 0);
    } else {
      const m = detectNow();
      if (m) {
        i = pushSample(1, m.ear, m.faceH, m.yawLog, m.mar);
        const thr = Math.max(sess.cal.mar * opts.marMul, opts.marFloor);
        if (m.mar > thr) { yawnRun++; if (yawnRun === Math.round(opts.yawnSec * HZ)) sess.yawns++; }
        else yawnRun = 0;
      } else { i = pushSample(0, 0, 0, 0, 0); yawnRun = 0; }
    }
    if (onStateCb) onStateCb(stateBuf[i], i, sess);
  }
  if (onTickCb) onTickCb(sess, stateBuf);
  timer = setTimeout(tick, Math.max(2, t0 + sess.count * SAMPLE_MS - performance.now()));
}

function onDrowsyOnset(i) {
  if (opts.alerts && i - lastAlert > opts.alertCooldownSec * HZ) { lastAlert = i; Sound.alert(); }
  // 판정 검증용 썸네일 128×96, 최대 150장 — 오판을 눈으로 못 거르면 임계값 조정 근거가 없다
  if (opts.shots && sess.shots.length < 150 && video && video.videoWidth && !paused) {
    try {
      if (!shotCanvas) { shotCanvas = document.createElement('canvas'); shotCanvas.width = 128; shotCanvas.height = 96; }
      shotCanvas.getContext('2d').drawImage(video, 0, 0, 128, 96);
      sess.shots.push({ i, img: shotCanvas.toDataURL('image/jpeg', 0.5) });
    } catch (e) {}
  }
}

function onVis() {
  if (document.hidden) { if (sess) sess.gaps.push(sess.count); }
  else requestWake();
}
async function requestWake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { console.warn('[FocusSensor] WakeLock 실패', e); }
}

async function start(cal, cbState, cbTick) {
  if (!ready) throw new Error('초기화 필요');
  if (running) return sess;
  sess = newSession(cal);
  stateBuf = new Uint8Array(16384);
  mach = createMachine(cal, opts, sess.sleeps, sess.breaks);
  mach.onEvent = (type, i) => { if (type === 'drowsy') onDrowsyOnset(i); };
  onStateCb = cbState || null; onTickCb = cbTick || null;
  running = true; paused = false; pauseKind = null;
  t0 = performance.now(); lastAlert = -1e9; yawnRun = 0;
  requestWake();
  document.addEventListener('visibilitychange', onVis);
  snapTimer = setInterval(snapshot, 60000);
  tick();
  return sess;
}

/** kind: 'sleep'(수면 버튼) | 'break'(타이머 휴식·일시정지) */
function pause(kind) {
  if (!running || paused) return;
  paused = true; pauseKind = (kind === 'sleep') ? 'sleep' : 'break';
  const list = pauseKind === 'sleep' ? sess.sleeps : sess.breaks;
  list.push([sess.count, 1e12]);
  if (stream) stream.getVideoTracks().forEach(t => t.stop());   // 트랙 완전 정지
}
async function resume() {
  if (!running || !paused) return;
  const list = pauseKind === 'sleep' ? sess.sleeps : sess.breaks;
  const s = list[list.length - 1];
  if (s) s[1] = Math.max(s[0], sess.count - 1);
  await openCamera();
  machReset(mach); mach.sp = 0; mach.bp = 0;   // 실시간 상태기 리셋
  paused = false; pauseKind = null;
}

function exportSession(s) {
  const fix = list => list.map(x => [x[0], Math.min(x[1], Math.max(0, s.count - 1))]);
  return {
    id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, hz: s.hz, count: s.count, cal: s.cal,
    ok: s._ok.slice(), ear: s._ear.slice(), faceH: s._faceH.slice(), yaw: s._yaw.slice(), mar: s._mar.slice(),
    sleeps: fix(s.sleeps), breaks: fix(s.breaks), gaps: s.gaps.slice(), shots: s.shots.slice(), yawns: s.yawns
  };
}
async function snapshot() { if (sess) await DB.put('focusSessions', exportSession(sess)); }

async function stop() {
  if (!running) return sess ? exportSession(sess) : null;
  running = false;
  clearTimeout(timer); clearInterval(snapTimer);
  document.removeEventListener('visibilitychange', onVis);
  if (paused) {
    const list = pauseKind === 'sleep' ? sess.sleeps : sess.breaks;
    const s = list[list.length - 1];
    if (s) s[1] = sess.count - 1;
    paused = false; pauseKind = null;
  }
  if (stream) stream.getVideoTracks().forEach(t => t.stop());
  try { if (wakeLock) await wakeLock.release(); } catch (e) {}
  wakeLock = null;
  sess.endedAt = Date.now();
  const out = exportSession(sess);
  await DB.put('focusSessions', out);
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   리포트 (§9)
   ══════════════════════════════════════════════════════════════════ */
function dl(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportCSV(s, o) {
  const st = rejudge(s, o), cal = s.cal;
  const parts = ['time,elapsed_s,state,ear,ear_adj,openness,face_h,yaw_log,mar\n'];
  let chunk = [];
  for (let i = 0; i < s.count; i++) {
    const ear = s.ear[i] / 1000, fh = s.faceH[i] / 100;
    const ea = s.ok[i] ? earAdjust(ear, fh, cal, o.headComp) : 0;
    chunk.push([clockAt(s.startedAt + i * SAMPLE_MS), (i / HZ).toFixed(1), STATE[st[i]],
      s.ok[i] ? ear.toFixed(4) : '', s.ok[i] ? ea.toFixed(4) : '',
      s.ok[i] ? opennessOf(ea, cal).toFixed(3) : '', s.ok[i] ? fh.toFixed(3) : '',
      s.ok[i] ? (s.yaw[i] / 100).toFixed(3) : '', s.ok[i] ? (s.mar[i] / 100).toFixed(3) : ''].join(','));
    if (chunk.length >= 20000) { parts.push(chunk.join('\n') + '\n'); chunk = []; }
  }
  if (chunk.length) parts.push(chunk.join('\n') + '\n');
  dl(`focus-${s.id}.csv`, new Blob(parts, { type: 'text/csv' }));
}
function exportJSON(s, o) {
  const out = Object.assign({}, s, {
    ok: Array.from(s.ok.slice(0, s.count)), ear: Array.from(s.ear.slice(0, s.count)),
    faceH: Array.from(s.faceH.slice(0, s.count)), yaw: Array.from(s.yaw.slice(0, s.count)),
    mar: Array.from(s.mar.slice(0, s.count)), opts: o });
  dl(`focus-${s.id}.json`, new Blob([JSON.stringify(out)], { type: 'application/json' }));
}

/* 전체 테이프 — 픽셀당 최빈 상태, 단 졸음이 하나라도 있으면 졸음 우선 */
function drawTape(c, states) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(c.getBoundingClientRect().width * dpr));
  c.height = Math.round(56 * dpr);
  const g = c.getContext('2d'), W = c.width, H = c.height, n = states.length;
  g.fillStyle = '#101216'; g.fillRect(0, 0, W, H);
  if (!n) return;
  const per = n / W, cnt = new Int32Array(6);
  for (let x = 0; x < W; x++) {
    const a = Math.floor(x * per), b = Math.min(n, Math.floor((x + 1) * per) + (per < 1 ? 1 : 0));
    cnt.fill(0);
    for (let i = a; i < b; i++) cnt[states[i]]++;
    let pick = 0, mx = -1;
    for (let k = 0; k < 6; k++) if (cnt[k] > mx) { mx = cnt[k]; pick = k; }
    if (cnt[2] > 0) pick = 2;              // 놓치면 안 되는 정보
    g.fillStyle = COLOR[pick]; g.fillRect(x, 0, 1, H);
  }
}
/* 10분 단위 집중률 막대 */
function drawBars(c, states) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(c.getBoundingClientRect().width * dpr));
  c.height = Math.round(150 * dpr);
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = '#101216'; g.fillRect(0, 0, W, H);
  const blk = 10 * 60 * HZ, nb = Math.max(1, Math.ceil(states.length / blk)), bw = W / nb;
  const label = b => {
    if (nb > 40) return;
    g.fillStyle = '#7a7a84'; g.font = `${Math.round(10 * dpr)}px system-ui`; g.textAlign = 'center';
    g.fillText(`${b * 10}m`, b * bw + bw / 2, H - 5);
  };
  for (let b = 0; b < nb; b++) {
    let f = 0, d = 0;
    for (let i = b * blk; i < Math.min(states.length, (b + 1) * blk); i++) {
      if (EXCLUDED.indexOf(states[i]) >= 0) continue;
      d++; if (states[i] === 0) f++;
    }
    if (!d) {                              // 통째로 수면·휴식 — 0%가 아니라 "잰 시간이 없음"
      g.fillStyle = COLOR[4]; g.fillRect(b * bw + 1, H - 22, bw - 2, 4); label(b); continue;
    }
    const r = f / d, h = r * (H - 22);
    g.fillStyle = r >= 0.8 ? COLOR[0] : r >= 0.6 ? '#7d8a3a' : COLOR[2];
    g.fillRect(b * bw + 1, H - 18 - h, bw - 2, h);
    label(b);
  }
}

/* 최근 N분 스트립 — 세로 높이는 눈 열린 정도, 배경색은 그 순간 판정.
   10시간 동안 곁눈질로 보게 되는 유일한 요소라 화면의 주인공이다 (§9). */
const STRIP_PRIO = [5, 4, 3, 1, 2];        // 뒤로 갈수록 셈. 졸음이 가장 세다
function drawStrip(c, s, states, o, spanSec) {
  const g = c.getContext('2d'); if (!g) return;
  const W = c.width, H = c.height, n = s.count;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#050506'; g.fillRect(0, 0, W, H);
  if (!n) return;
  const span = Math.round((spanSec || 600) * HZ), from = Math.max(0, n - span), per = span / W;
  const cal = s.cal, headComp = (o && o.headComp != null) ? o.headComp : DEFAULTS.headComp;
  for (let x = 0; x < W; x++) {
    const a = from + Math.floor(x * per), b = Math.min(n, from + Math.floor((x + 1) * per));
    if (b <= a) continue;
    let best = -1, open = 0, any = false;
    for (let i = a; i < b; i++) {
      const p = STRIP_PRIO.indexOf(states[i]);
      if (p > best) best = p;
      if (s.ok[i]) {
        any = true;
        const v = opennessOf(earAdjust(s.ear[i] / 1000, s.faceH[i] / 100, cal, headComp), cal);
        if (v > open) open = v;
      }
    }
    const st = best < 0 ? 0 : STRIP_PRIO[best];
    g.globalAlpha = 0.30; g.fillStyle = COLOR[st]; g.fillRect(x, 0, 1, H); g.globalAlpha = 1;
    if (any) { const h = Math.max(1, open * (H - 4)); g.fillStyle = COLOR[st]; g.fillRect(x, H - h, 1, h); }
  }
}

/* 고개 방향 분포 — 실제로 자습하는 동안 yaw 가 어디에 몰려 있는지 보여준다.
   캘리브레이션 정면 기준(C단계)과 실제 자습 자세가 어긋나 있으면 여기서 바로 드러난다. */
function drawYawHist(c, s, o) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(c.getBoundingClientRect().width * dpr));
  c.height = Math.round(110 * dpr);
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = '#101216'; g.fillRect(0, 0, W, H);
  const LO = -1.2, HI = 1.2, NB = 96, bins = new Int32Array(NB);
  let total = 0;
  for (let i = 0; i < s.count; i++) {
    if (!s.ok[i]) continue;
    const v = clamp(s.yaw[i] / 100, LO, HI);
    bins[Math.min(NB - 1, Math.floor((v - LO) / (HI - LO) * NB))]++;
    total++;
  }
  if (!total) return;
  let mx = 0; for (let k = 0; k < NB; k++) if (bins[k] > mx) mx = bins[k];
  const xOf = v => (clamp(v, LO, HI) - LO) / (HI - LO) * W;
  const bw = W / NB;
  const lo = s.cal.yawLog - o.yawThr, hi = s.cal.yawLog + o.yawThr;
  g.fillStyle = 'rgba(31,111,74,0.22)';                     // 집중으로 인정되는 폭
  g.fillRect(xOf(lo), 0, xOf(hi) - xOf(lo), H - 14);
  for (let k = 0; k < NB; k++) {
    if (!bins[k]) continue;
    const v = LO + (k + 0.5) / NB * (HI - LO);
    const h = bins[k] / mx * (H - 20);
    g.fillStyle = (v >= lo && v <= hi) ? COLOR[0] : COLOR[1];
    g.fillRect(k * bw, H - 14 - h, Math.max(1, bw - 1), h);
  }
  g.strokeStyle = '#e8e8ea'; g.lineWidth = Math.max(1, dpr);  // 캘리브레이션 정면 기준
  g.beginPath(); g.moveTo(xOf(s.cal.yawLog), 0); g.lineTo(xOf(s.cal.yawLog), H - 14); g.stroke();
  g.fillStyle = '#7a7a84'; g.font = `${Math.round(9 * dpr)}px system-ui`;
  g.textAlign = 'left';   g.fillText('← 왼쪽', 4, H - 4);
  g.textAlign = 'center'; g.fillText('정면 기준', xOf(s.cal.yawLog), H - 4);
  g.textAlign = 'right';  g.fillText('오른쪽 →', W - 4, H - 4);
}
function yawNote(s, o) {
  const vals = [];
  for (let i = 0; i < s.count; i++) if (s.ok[i]) vals.push(s.yaw[i] / 100);
  if (!vals.length) return '얼굴을 잡은 샘플이 없습니다.';
  const med = median(vals), off = med - s.cal.yawLog;
  let out = 0;
  for (const v of vals) if (Math.abs(v - s.cal.yawLog) > o.yawThr) out++;
  const ratio = out / vals.length;
  let msg = `실제 자습 중 고개 중앙값 ${med.toFixed(2)} · 캘리브레이션 정면 기준 ${s.cal.yawLog.toFixed(2)} · ` +
            `어긋남 ${off >= 0 ? '+' : ''}${off.toFixed(2)} · 판정 폭 밖 ${(ratio * 100).toFixed(1)}%`;
  if (Math.abs(off) > o.yawThr * 0.5) {
    msg += `<br><b>기준이 실제 자습 자세와 많이 어긋나 있습니다.</b> 캘리브레이션 C단계(고개 들고 정면)로 잰 기준이라, ` +
      `노트를 보며 고개가 돌아간 채 공부하면 그 자세 전체가 이탈 쪽으로 밀립니다. ` +
      `판정 폭을 ${(Math.abs(off) + 0.3).toFixed(2)} 이상으로 올리면 사라집니다.`;
  }
  return msg;
}

const REPORT_CSS = `
.fsr{color:#e8e8ea;font-size:14px}
.fsr h4{font-size:14px;font-weight:600;margin:22px 0 9px;color:#e8e8ea}
.fsr .big{font-size:64px;font-weight:200;font-variant-numeric:tabular-nums;line-height:1}
.fsr .big small{font-size:20px;color:#8a8a94;margin-left:6px}
.fsr .sub{color:#8a8a94;font-size:12px;line-height:1.6}
.fsr .kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:12px 0}
.fsr .kv div{border:1px solid #22242a;border-radius:9px;padding:8px 10px}
.fsr .kv b{display:block;font-size:11px;color:#8a8a94;font-weight:500;margin-bottom:3px}
.fsr .kv span{font-size:15px;font-variant-numeric:tabular-nums}
.fsr canvas{width:100%;display:block;border-radius:6px;background:#101216}
.fsr .legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:#8a8a94;margin-top:7px}
.fsr .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
.fsr table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.fsr th,.fsr td{text-align:left;padding:6px 8px;border-bottom:1px solid #22242a}
.fsr th{color:#8a8a94;font-weight:500;font-size:11px}
.fsr .shots img{width:56px;height:42px;border-radius:4px;margin-right:3px;vertical-align:middle;background:#000;object-fit:cover}
.fsr .sld{display:grid;grid-template-columns:100px 1fr 52px;gap:10px;align-items:center;margin:10px 0;font-size:12px}
.fsr .sld input{width:100%}
.fsr .sld b{font-variant-numeric:tabular-nums;color:#8a8a94;font-weight:500;text-align:right}
.fsr .warn{border:1px solid #5e4a26;background:#22190c;border-radius:9px;padding:10px 12px;font-size:12px;color:#d8b878;margin:10px 0;line-height:1.6}
.fsr .note{font-size:11px;color:#8a8a94;line-height:1.7}
.fsr button{font:inherit;font-size:12px;color:#e8e8ea;background:#15171c;border:1px solid #22242a;border-radius:8px;padding:7px 13px;cursor:pointer}
`;

function report(s, el) {
  if (!s || !s.count) { el.innerHTML = '<div class="fsr"><div class="note">기록된 샘플이 없습니다.</div></div>'; return; }
  if (!document.getElementById('fsrCss')) {
    const st = document.createElement('style'); st.id = 'fsrCss'; st.textContent = REPORT_CSS;
    document.head.appendChild(st);
  }
  const o = Object.assign({}, DEFAULTS);
  el.innerHTML = `<div class="fsr">
    <div class="sub" id="fsMeta"></div>
    <div id="fsWarn"></div>
    <div style="margin:18px 0 4px"><span class="big" id="fsRate">—</span></div>
    <div class="sub" id="fsRate2"></div>
    <div class="kv" id="fsKv"></div>
    <h4>전체 테이프</h4>
    <canvas id="fsTape" style="height:56px"></canvas>
    <div class="legend" id="fsLeg"></div>
    <h4>10분 단위 집중률</h4>
    <canvas id="fsBars" style="height:150px"></canvas>
    <h4>수면 · 휴식 구간</h4><div id="fsRest"></div>
    <h4>졸음 구간</h4><div id="fsDrowsy"></div>
    <h4>이탈 구간</h4><div id="fsAway"></div>
    <h4>고개 방향 분포</h4><canvas id="fsYaw" style="height:110px"></canvas>
    <div class="note" id="fsYawNote"></div>
    <h4>임계값 조정 — 재측정 없이 즉시 재판정</h4>
    <div id="fsSliders"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
      <button id="fsReset">기본값으로</button><button id="fsCsv">CSV</button><button id="fsJson">JSON</button>
    </div>
    <h4>알려진 한계</h4>
    <div class="note">
      · 눈을 뜨고 딴생각하는 건 잡지 못합니다. 이 숫자는 “몰입도”가 아니라 “안 졸고 자리를 지켰나”입니다.<br>
      · 고개를 <b>뒤로</b> 젖히는 자세는 숙인 것과 구분되지 않습니다 (faceH가 양방향으로 줄어듦).<br>
      · PERCLOS는 60초 창이라 서서히 졸기 시작하면 판정이 40~50초 늦습니다. 즉시 대응은 1.5초 마이크로슬립 경로가 담당합니다.<br>
      · 탭이 가려진 구간의 수치는 신뢰할 수 없습니다.<br>
      · 안경 반사·어두운 조명·카메라가 눈높이보다 많이 낮으면 EAR 신뢰도가 떨어집니다.
    </div></div>`;

  const q = id => el.querySelector('#' + id);
  q('fsLeg').innerHTML = STATE.map((n, i) => `<span><i style="background:${COLOR[i]}"></i>${n}</span>`).join('');

  const SL = [['earFrac', '눈 감김 판정선', 0.10, 0.60, 0.01],
              ['perclos', 'PERCLOS 임계', 0.05, 0.40, 0.01],
              ['headComp', '고개 숙임 보정', 0, 1, 0.05],
              ['yawThr', '이탈 판정 폭', 0.15, 1.20, 0.05]];
  q('fsSliders').innerHTML = SL.map(([k, n, mn, mx, st]) =>
    `<div class="sld"><span>${n}</span>
      <input type="range" id="fsl_${k}" min="${mn}" max="${mx}" step="${st}" value="${o[k]}">
      <b id="fsv_${k}">${o[k].toFixed(2)}</b></div>`).join('');
  for (const [k] of SL) q('fsl_' + k).oninput = e => {
    o[k] = parseFloat(e.target.value); q('fsv_' + k).textContent = o[k].toFixed(2); paint();
  };
  q('fsReset').onclick = () => {
    for (const [k] of SL) { o[k] = DEFAULTS[k]; q('fsl_' + k).value = o[k]; q('fsv_' + k).textContent = o[k].toFixed(2); }
    paint();
  };
  q('fsCsv').onclick = () => exportCSV(s, o);
  q('fsJson').onclick = () => exportJSON(s, o);

  function paint() {
    const t = performance.now();
    const states = rejudge(s, o);
    const ms = performance.now() - t;
    const r = stats(states), sec = i => i / HZ;

    q('fsMeta').textContent = `${new Date(s.startedAt).toLocaleString('ko-KR')} · ${hms(s.count / HZ)} · ` +
      `${s.count.toLocaleString()}샘플 @${HZ}Hz · 재판정 ${ms.toFixed(0)}ms`;
    let w = '';
    if (s.gaps.length) w += `<div class="warn">탭이 가려진 시점이 ${s.gaps.length}회 있습니다 (` +
      s.gaps.slice(0, 8).map(i => hms(sec(i))).join(', ') + (s.gaps.length > 8 ? ' …' : '') +
      `). 해당 구간 수치는 신뢰할 수 없습니다.</div>`;
    if (s.cal.warn) w += `<div class="warn">${s.cal.warn}</div>`;
    q('fsWarn').innerHTML = w;

    q('fsRate').innerHTML = (r.rate * 100).toFixed(1) + '<small>%</small>';
    q('fsRate2').textContent = `집중률 (수면·휴식 제외) · 잰 시간 ${hms(sec(r.denom))} · 판정선 ` +
      (s.cal.earClosed + o.earFrac * (s.cal.earOpen - s.cal.earClosed)).toFixed(3);
    q('fsKv').innerHTML = [['집중', hms(sec(r.c[0]))], ['졸음', hms(sec(r.c[2]))], ['이탈', hms(sec(r.c[1]))],
      ['자리비움', hms(sec(r.c[3]))], ['수면', hms(sec(r.c[4]))], ['휴식', hms(sec(r.c[5]))],
      ['하품', s.yawns + '회']].map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('');

    drawTape(q('fsTape'), states);
    drawBars(q('fsBars'), states);

    const rest = [].concat(
      (s.sleeps || []).filter(x => x[1] >= x[0]).map(x => ['수면', x]),
      (s.breaks || []).filter(x => x[1] >= x[0]).map(x => ['휴식', x])
    ).sort((a, b) => a[1][0] - b[1][0]);
    q('fsRest').innerHTML = rest.length ? `<table><tr><th>종류</th><th>시각</th><th>길이</th></tr>` +
      rest.map(([k, x]) => `<tr><td>${k}</td><td>${clockAt(s.startedAt + x[0] * SAMPLE_MS)}</td>
        <td>${durTxt((x[1]-x[0]+1)/HZ)}</td></tr>`).join('') + `</table>` : '<div class="note">없음</div>';

    // 10초 이내 병합, 1.5초 미만 제외
    const segs = mergeSegs(segments(states, 2), 10, 1.5);
    q('fsDrowsy').innerHTML = segs.length ? `<table>
      <tr><th>시각</th><th>길이</th><th>눈 열림 평균</th><th>썸네일</th></tr>` + segs.map(x => {
        let sum = 0, n = 0;
        for (let i = x[0]; i <= x[1]; i++) if (s.ok[i]) {
          sum += opennessOf(earAdjust(s.ear[i] / 1000, s.faceH[i] / 100, s.cal, o.headComp), s.cal); n++;
        }
        const shots = (s.shots || []).filter(h => h.i >= x[0] - 20 && h.i <= x[1] + 20).slice(0, 3);
        return `<tr><td>${clockAt(s.startedAt + x[0] * SAMPLE_MS)}</td><td>${durTxt((x[1]-x[0]+1)/HZ)}</td>
          <td>${n ? (sum/n*100).toFixed(0)+'%' : '—'}</td>
          <td class="shots">${shots.map(h => `<img src="${h.img}">`).join('')}</td></tr>`;
      }).join('') + `</table>` : '<div class="note">없음</div>';

    // 이탈 구간 — 언제, 얼마나 돌아갔는지. 오탐이면 여기 편차가 임계선 언저리에 몰려 있다.
    const aw = mergeSegs(segments(states, 1), 5, 1.0);
    q('fsAway').innerHTML = aw.length ? `<table>
      <tr><th>시각</th><th>세션 경과</th><th>길이</th><th>평균 고개 편차</th><th>최대</th></tr>` +
      aw.map(x => {
        let sum = 0, n = 0, mx = 0;
        for (let i = x[0]; i <= x[1]; i++) if (s.ok[i]) {
          const dv = Math.abs(s.yaw[i] / 100 - s.cal.yawLog);
          sum += dv; n++; if (dv > mx) mx = dv;
        }
        return `<tr><td>${clockAt(s.startedAt + x[0] * SAMPLE_MS)}</td><td>${hms(x[0] / HZ)}</td>
          <td>${durTxt((x[1]-x[0]+1)/HZ)}</td>
          <td>${n ? (sum / n).toFixed(2) : '—'}</td>
          <td>${n ? mx.toFixed(2) : '—'}</td></tr>`;
      }).join('') + `</table>
      <div class="note">판정 폭 ${o.yawThr.toFixed(2)} 를 넘긴 구간입니다. 편차가 판정 폭 바로 위에 몰려 있으면
      정면 기준(캘리브레이션 C단계)이 실제 자습 자세와 어긋난 것이라 폭을 넓히면 사라집니다.</div>`
      : '<div class="note">없음</div>';

    drawYawHist(q('fsYaw'), s, o);
    q('fsYawNote').innerHTML = yawNote(s, o);
  }
  paint();
}

/* ══════════════════════════════════════════════════════════════════
   §10 검증 테스트 — 합성 데이터로 판정 로직을 직접 친다
   ══════════════════════════════════════════════════════════════════ */
function synth(n, fn, cal) {
  const s = { count: n, hz: HZ, cal, sleeps: [], breaks: [], gaps: [], shots: [], yawns: 0,
    ok: new Int16Array(n), ear: new Int16Array(n), faceH: new Int16Array(n),
    yaw: new Int16Array(n), mar: new Int16Array(n) };
  for (let i = 0; i < n; i++) {
    const v = fn(i) || {};
    s.ok[i] = v.ok === 0 ? 0 : 1;
    s.ear[i] = Math.round((v.ear != null ? v.ear : cal.earOpen) * 1000);
    s.faceH[i] = Math.round((v.faceH != null ? v.faceH : cal.faceH) * 100);
    s.yaw[i] = Math.round((v.yaw != null ? v.yaw : cal.yawLog) * 100);
    s.mar[i] = Math.round((v.mar != null ? v.mar : cal.mar) * 100);
  }
  return s;
}
function runTests() {
  const cal = { earOpen: 0.30, earClosed: 0.09, faceH: 1.55, faceHFront: 1.55, yawLog: 0, mar: 0.05 };
  const earThr = cal.earClosed + 0.20 * (cal.earOpen - cal.earClosed);   // 0.132
  const OPEN = 0.30, SHUT = 0.05;
  const R = [], L = [];
  const T = (no, name, cond, detail) => {
    R.push(cond); L.push(`${cond ? '✅' : '❌'} ${no}. ${name}${detail ? '\n      ' + detail : ''}`);
  };
  const secOf = (st, k) => { let c = 0; for (const v of st) if (v === k) c++; return c / HZ; };

  L.push(`캘리브레이션 가정: earOpen=${cal.earOpen} earClosed=${cal.earClosed} faceH=${cal.faceH}`);
  L.push(`→ earThr = ${earThr.toFixed(3)}\n`);

  { const n = 240 * HZ;
    const st = rejudge(synth(n, i => ({ ear: (i % 40 < 3) ? SHUT : OPEN }), cal), {});
    T(1, '정상 깜빡임 4분 (감김률 7.5%)', secOf(st, 2) === 0, `졸음 ${secOf(st,2)}초 (기대 0)`); }

  { const st = rejudge(synth(60 * HZ, i => ({ ear: (i >= 100 && i < 118) ? SHUT : OPEN }), cal), {});
    T(2, '눈 감김 1.8초', secOf(st, 2) > 0, `졸음 ${secOf(st,2).toFixed(1)}초`); }

  { const st = rejudge(synth(180 * HZ, i => ({ ear: (i % 40 < 8) ? SHUT : OPEN }), cal), {});
    T(3, 'PERCLOS 20% 3분', secOf(st, 2) > 60, `졸음 ${secOf(st,2).toFixed(1)}초`); }

  // PERCLOS 창이 다 찬 뒤에 둔다. 50/600 = 8.3% 라 규칙 5는 안 걸리고 백필만 검증된다.
  { const a = 100 * HZ;
    const st = rejudge(synth(180 * HZ, i => ({ ear: (i >= a && i < a + 50) ? SHUT : OPEN }), cal), {});
    const segs = segments(st, 2), len = segs.length ? (segs[0][1] - segs[0][0] + 1) / HZ : 0;
    T(4, '5초 눈 감김 → 구간 길이 정확히 5.0초 (백필)',
      segs.length === 1 && len === 5.0 && segs[0][0] === a,
      `구간 ${segs.length}개, 길이 ${len.toFixed(1)}초, 시작 ${segs.length?segs[0][0]:'-'} (기대 ${a})`); }

  // 창 미충전 구간에서는 규칙 5가 이어받는다. 사양서 §5.4 "유효 샘플 20초 이상" 단서상 정상.
  { const a = 200;
    const segs = segments(rejudge(synth(60 * HZ, i => ({ ear: (i >= a && i < a + 50) ? SHUT : OPEN }), cal), {}), 2);
    const len = segs.length ? (segs[0][1] - segs[0][0] + 1) / HZ : 0;
    T('4b', '창 미충전 구간(20초 지점)의 같은 5초 감김 — 규칙 5가 이어받음',
      segs.length === 1 && segs[0][0] === a && len > 5.0,
      `길이 ${len.toFixed(1)}초. 백필로 시작점은 ${a}로 정확하나 PERCLOS 창이 덜 차 50/333>15% 로 연장됨 (참고용)`); }

  { const s = synth(120 * HZ, () => ({ ear: 0.12, faceH: 0.93 }), cal);
    const f1 = secOf(rejudge(s, { headComp: 1 }), 0), d0 = secOf(rejudge(s, { headComp: 0 }), 2);
    T(5, '깊은 필기 자세 (faceH 0.93, EAR 0.12) 2분 — 가장 중요', f1 === 120 && d0 === 120,
      `headComp=1 → 집중 ${f1}초 (기대 120) / headComp=0 → 졸음 ${d0}초 (기대 120)`); }

  { const st = rejudge(synth(10 * HZ, () => ({ ear: OPEN, yaw: 0.9 }), cal), {});
    T(6, 'yawLog 0.9 유지 10초', secOf(st, 0) === 3.0 && secOf(st, 1) === 7.0,
      `집중 ${secOf(st,0).toFixed(1)}초 / 이탈 ${secOf(st,1).toFixed(1)}초 (기대 3.0 / 7.0)`); }

  { const st = rejudge(synth(40 * HZ, i => i < 100 ? { ear: OPEN } : { ok: 0 }, cal), {});
    T(7, '얼굴 소실 30초', secOf(st, 3) === 20.0 && secOf(st, 0) === 20.0,
      `자리비움 ${secOf(st,3).toFixed(1)}초 (기대 20.0) / 집중 ${secOf(st,0).toFixed(1)}초 (기대 20.0 = 앞 10초 + 유지 10초)`); }

  { const n = 45 * 60 * HZ, a = 10 * 60 * HZ, b = a + 20 * 60 * HZ - 1;
    const s = synth(n, i => (i >= a && i <= b) ? { ok: 0 } : { ear: OPEN }, cal);
    s.sleeps = [[a, b]];
    const st = rejudge(s, {}), r = stats(st);
    T(8, '45분 중 수면 20분 — 분모에서 제외',
      Math.abs(secOf(st, 4) - 1200) < 0.05 && r.rate > 0.99 && Math.abs(r.rate - r.rateRaw) > 0.3,
      `수면 ${secOf(st,4)}초 / 집중률(제외) ${(r.rate*100).toFixed(1)}% vs (포함) ${(r.rateRaw*100).toFixed(1)}%`); }

  { const n = 360000;
    const s = synth(n, i => (i % 40 < 3) ? { ear: SHUT } : { ear: OPEN }, cal);
    const t = performance.now(); const st = rejudge(s, {}); const ms = performance.now() - t;
    T(9, '36만 샘플 전체 재판정', ms < 100, `${ms.toFixed(1)}ms (기대 <100), 집중 ${secOf(st,0).toFixed(0)}초`); }

  { const n = 120 * HZ;
    const s = synth(n, i => {
      if (i > 300 && i < 340) return { ok: 0 };
      if (i % 97 < 4) return { ear: SHUT };
      if (i > 700 && i < 760) return { ear: SHUT };
      if (i > 900 && i < 1000) return { ear: OPEN, yaw: 0.8 };
      return { ear: OPEN, faceH: 1.1 + (i % 7) * 0.05 };
    }, cal);
    s.sleeps = [[1050, 1080]]; s.breaks = [[1090, 1120]];
    const batch = rejudge(s, {});
    const live = new Uint8Array(n);
    const m = createMachine(cal, {}, s.sleeps, s.breaks);
    for (let i = 0; i < n; i++) step(m, i, s.ok[i], s.ear[i] / 1000, s.faceH[i] / 100, s.yaw[i] / 100, live);
    let diff = 0; for (let i = 0; i < n; i++) if (batch[i] !== live[i]) diff++;
    T(10, '실시간 누적 상태기 == 사후 재판정', diff === 0, `불일치 ${diff}개 / ${n}`); }

  // 휴식 구간도 수면과 똑같이 분모에서 빠져야 한다 (타이머 통합용)
  { const n = 30 * 60 * HZ, a = 10 * 60 * HZ, b = a + 5 * 60 * HZ - 1;
    const s = synth(n, i => (i >= a && i <= b) ? { ok: 0 } : { ear: OPEN }, cal);
    s.breaks = [[a, b]];
    const st = rejudge(s, {}), r = stats(st);
    T(11, '휴식 5분 — 수면과 같이 분모에서 제외', Math.abs(secOf(st, 5) - 300) < 0.05 && r.rate > 0.99,
      `휴식 ${secOf(st,5)}초 / 집중률 ${(r.rate*100).toFixed(1)}% (잰 시간 ${(r.denom/HZ/60).toFixed(0)}분)`); }

  const pass = R.filter(Boolean).length;
  L.push(`\n${pass}/${R.length} 통과`);
  return { text: L.join('\n'), pass, total: R.length };
}

/* ─────────────────── 공개 인터페이스 ─────────────────── */
global.FocusSensor = {
  HZ, STATE, COLOR, CHECKS, DEFAULTS, EXCLUDED,
  init, calibrate, start, pause, resume, stop, report,
  abortCalibration: () => calAbort && calAbort(),
  get ready() { return ready; },
  get running() { return running; },
  get paused() { return paused; },
  get session() { return sess; },
  get states() { return stateBuf; },
  get options() { return opts; },
  setOptions(o) { opts = Object.assign({}, opts, o || {}); },
  /** 저장된 썸네일 전부 삭제 — 진행 중 세션과 IndexedDB 양쪽에서 지운다 */
  async clearShots() {
    let n = 0;
    if (sess && sess.shots) { n += sess.shots.length; sess.shots.length = 0; }
    const rows = await DB.all('focusSessions');
    for (const r of rows) {
      if (r.shots && r.shots.length) { n += r.shots.length; r.shots = []; await DB.put('focusSessions', r); }
    }
    return n;
  },
  detectNow, rejudge, stats, segments, mergeSegs, earAdjust, opennessOf,
  hms, durTxt, clockAt, drawTape, drawBars, drawStrip, runTests, synth,
  sound: Sound, db: DB, showPreview
};

})(typeof window !== 'undefined' ? window : globalThis);
