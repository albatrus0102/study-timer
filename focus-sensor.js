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

// 배포할 때마다 올린다. 캐시된 옛 코드가 도는지 화면에서 바로 확인하려는 용도.
// sw.js 의 CACHE_NAME 과 같은 번호를 쓴다.
const VERSION = 'v23';

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
const STATE = ['집중', '이탈', '졸음', '자리비움', '수면', '휴식', '측정 불가'];
const COLOR = ['#1f6f4a', '#b08a2e', '#c8502f', '#4a4a52', '#3b4a86', '#2a4a55', '#5a4a6a'];
// 분모에서 빼는 상태들. 수면·휴식은 의도한 중단, 가려짐은 잴 수 없었던 구간이다.
const EXCLUDED = [4, 5, 6];
// 얼굴 소실을 이 샘플 수까지는 감김·회전 런을 잇는 데 허용한다 (0.5초).
// 눈을 완전히 감으면 랜드마크를 놓치는 프레임이 실제로 생기기 때문에 0 으로 둘 수 없다.
const MISS_BRIDGE = 5;

const DEFAULTS = {
  earFrac: 0.20,      // PERCLOS P80
  perclos: 0.15,      // 60초 창 임계
  headComp: 1.0,      // 고개 숙임 보정 계수
  yawThr: 0.35,
  // 고개를 돌린 걸 "이탈"로 셀지. 기본 꺼짐.
  // 실측 결과 왼쪽 노트를 보는 자세가 그대로 이탈로 찍혔다. 무엇을 보고 있는지는
  // 카메라로 구분할 수 없으므로, 자리를 실제로 비운 것(얼굴 소실)만 세는 게 정직하다.
  // 고개 방향은 계속 기록하므로 리포트의 분포에서 볼 수 있고, 켜면 종전대로 판정한다.
  awayOnTurn: false,
  closedSec: 1.5,     // 마이크로슬립 즉시 판정
  turnSec: 3.0,
  missSec: 10.0,
  perclosWinSec: 60,
  perclosMinValidSec: 20,
  marMul: 2.2, marFloor: 0.35, yawnSec: 0.6,
  alertCooldownSec: 20,
  alerts: true,
  // 가려져도 계속 측정. setTimeout 은 가려진 탭에서 분당 1회까지 조여지지만
  // 오디오 스레드가 미는 콜백은 조여지지 않는다(실측 11.7Hz). 그걸 클럭으로 쓰고,
  // 매 샘플 캔버스에 프레임을 그려 카메라 공급이 끊기지 않게 한다.
  // 실측: 최소화 40초 동안 새 프레임 471장(11.74Hz) 수신.
  bgMode: true,
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
function createMachine(cal, opt, sleeps, breaks, hidden, camDown) {
  const o = Object.assign({}, DEFAULTS, opt || {});
  const win = Math.round(o.perclosWinSec * HZ);
  return {
    o, cal, sleeps: sleeps || [], breaks: breaks || [], hidden: hidden || [], camDown: camDown || [],
    earThr: cal.earClosed + o.earFrac * (cal.earOpen - cal.earClosed),
    backN: Math.round(o.closedSec * HZ),
    minValid: Math.round(o.perclosMinValidSec * HZ),
    win, ring: new Uint8Array(win), rvalid: new Uint8Array(win),
    rp: 0, sClosed: 0, sValid: 0, pushed: 0,
    miss: 0, closedRun: 0, turnRun: 0, micro: false,
    prev: 0, sp: 0, bp: 0, hp: 0, cp: 0, inX: false,
    onEvent: null
  };
}
function machReset(m) {
  m.ring.fill(0); m.rvalid.fill(0); m.rp = 0; m.sClosed = 0; m.sValid = 0; m.pushed = 0;
  m.miss = 0; m.closedRun = 0; m.turnRun = 0; m.micro = false; m.prev = 0;
}
function ringPush(m, valid, closed) {
  m.sValid -= m.rvalid[m.rp]; m.sClosed -= m.ring[m.rp];
  m.rvalid[m.rp] = valid; m.ring[m.rp] = closed;
  m.sValid += valid; m.sClosed += closed;
  m.rp = (m.rp + 1) % m.win;
  if (m.pushed < m.win) m.pushed++;
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
  // 탭이 가려진 구간은 브라우저가 타이머를 조여서 샘플이 통째로 빈다.
  // 자리를 비운 것과는 다른 사건이라 따로 세고 분모에서 뺀다.
  const covered = !sleeping && !resting &&
    (inRange(m.hidden, 'hp', m, i) || inRange(m.camDown, 'cp', m, i));
  if (sleeping || resting || covered) {
    if (!m.inX) { machReset(m); m.inX = true; }
    states[i] = sleeping ? 4 : resting ? 5 : 6;
    return states[i];
  }
  m.inX = false;
  const o = m.o;

  if (!ok) {
    m.miss++;
    ringPush(m, 0, 0);
    // 아주 짧은 소실(프레임 한둘)은 감김 도중에도 일어나므로 런을 잇는다.
    // 그보다 길면 관측하지 못한 시간이므로 "연속"으로 합산하면 안 된다.
    // 그렇지 않으면 1.4초 감김 → 10초 소실 → 0.1초 감김이 마이크로슬립으로 판정되고
    // 관측 불가였던 10초까지 졸음으로 백필된다.
    if (m.miss > MISS_BRIDGE) { m.closedRun = 0; m.turnRun = 0; m.micro = false; }
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
        if (states[j] >= 4) break;      // 수면·휴식·측정불가 구간은 침범하지 않는다
        states[j] = 2;
      }
      if (m.onEvent) m.onEvent('drowsy', i);
    }
  // 창이 한 바퀴 다 돌기 전에는 PERCLOS 를 쓰지 않는다.
  // 덜 찬 창은 분모가 작아 비율이 부풀려진다. 실제로 2.8초 감김 하나가
  // 세션 초반에 28/200 = 14% 로 계산돼, 눈을 다 뜨고 있는 30초를 졸음으로
  // 만들었다(눈 열림 평균 81%). 초반 급성 졸음은 1.5초 마이크로슬립 경로가 잡는다.
  } else if (m.pushed >= m.win && m.sValid >= m.minValid && m.sClosed / m.sValid > o.perclos) {
    st = 2;
    if (m.prev !== 2 && m.onEvent) m.onEvent('drowsy', i);
  } else if (o.awayOnTurn && m.turnRun > 0 && (m.turnRun - 1) / HZ >= o.turnSec) {
    st = 1;
  }
  states[i] = st; m.prev = st; return st;
}

/** 사후 전체 재판정 (§5.7) — 슬라이더가 호출한다 */
function rejudge(sess, opt) {
  const st = new Uint8Array(sess.count);
  const m = createMachine(sess.cal, opt, sess.sleeps, sess.breaks || [], sess.hidden || [], sess.camDown || []);
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
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < states.length; i++) c[states[i]]++;
  const denom = states.length - c[4] - c[5] - c[6];
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
        // 버전 2 — 1에서 스토어 이름을 sessions/meta → focusSessions/focusMeta 로 바꿨다.
        // IndexedDB 는 버전이 올라갈 때만 스토어를 만들기 때문에, 이름만 바꾸고 버전을
        // 안 올리면 기존 DB 를 쓰던 기기에서 스토어가 영영 안 생기고 저장이 조용히 실패한다.
        const rq = indexedDB.open('focusTracker', 2);
        rq.onupgradeneeded = ev => {
          const d = rq.result, tx = rq.transaction;
          if (!d.objectStoreNames.contains('focusSessions')) d.createObjectStore('focusSessions', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('focusMeta')) d.createObjectStore('focusMeta');
          // v1 시절(단독 focus-tracker.html)에 잰 캘리브레이션을 옮겨온다
          if (ev.oldVersion < 2 && d.objectStoreNames.contains('meta')) {
            try {
              const g = tx.objectStore('meta').get('cal');
              g.onsuccess = () => {
                if (g.result) {
                  tx.objectStore('focusMeta').put(g.result, 'cal');
                  console.log('[FocusSensor] v1 캘리브레이션을 이관했습니다.');
                }
              };
            } catch (e) { console.warn('[FocusSensor] v1 캘리브레이션 이관 실패', e); }
          }
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

/* 캘리브레이션은 두 곳에 저장한다. 65초를 다시 재는 건 성가신 일이라
   IndexedDB 하나에 맡기지 않고 localStorage 를 예비로 둔다.
   (IDB 는 저장소 정리·프라이빗 모드·용량 초과로 통째로 죽는 경우가 있다) */
const CAL_LS_KEY = 'focusSensor_cal';
async function saveCal(cal) {
  let ok = await DB.put('focusMeta', cal, 'cal');
  try { localStorage.setItem(CAL_LS_KEY, JSON.stringify(cal)); ok = true; } catch (e) {}
  return ok;
}
async function loadCal() {
  const c = await DB.get('focusMeta', 'cal');
  if (c) return c;
  try {
    const t = localStorage.getItem(CAL_LS_KEY);
    if (t) {
      const parsed = JSON.parse(t);
      DB.put('focusMeta', parsed, 'cal');       // IDB 가 살아났으면 되돌려 놓는다
      console.log('[FocusSensor] localStorage 예비본에서 캘리브레이션을 복구했습니다.');
      return parsed;
    }
  } catch (e) {}
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   센서 본체
   ══════════════════════════════════════════════════════════════════ */
let landmarker = null, stream = null, video = null, ready = false;
// 엔진 재생성에 필요한 재료. 카메라만 다시 열어서는 GPU 컨텍스트 손실이 낫지 않는다.
let visionMod = null, visionFileset = null, visionModel = null, visionDelegate = 'GPU';
let sess = null, mach = null, stateBuf = null;
let running = false, paused = false, pauseKind = null, pauseKeptCamera = false, pendingResume = false;
let t0 = 0, timer = null, snapTimer = null;
let onStateCb = null, onTickCb = null;
let lastVideoTime = -1, lastMet = null;
let wakeLock = null, lastAlert = -1e9, yawnRun = 0, shotCanvas = null;
// 카메라를 새로 열면 자동 노출·화이트밸런스가 잡힐 때까지 1~2초간 화면이 흔들린다.
// 그 구간의 랜드마크는 못 믿으므로 얼굴 소실(ok=0)로 기록해 판정에서 뺀다.
// 휴식에서 돌아올 때마다 카메라를 다시 열기 때문에 매번 적용된다.
const CAM_WARMUP_MS = 2000;
let camWarmUntil = 0;

// 백그라운드 클럭. AudioContext 는 사용자 제스처에서 만들어야 하므로 start() 에서 켠다.
let bgCtx = null, bgOsc = null, bgProc = null, bgActive = false;
// 클럭이 "켜졌다"가 아니라 "실제로 돌고 있다"를 봐야 한다. AudioContext 가
// suspended 면 노드는 있는데 콜백이 안 온다. 그러면 가려지는 순간 조용히 끊긴다.
let bgTicks = 0, bgLastCheck = 0, bgHealthy = false;
// 프레임을 실제로 끌어오는 캔버스. 아무도 소비하지 않으면 가려진 탭의 비디오는
// 공급이 멈춘다. 매 샘플 여기에 그려야 프레임이 계속 온다.
let frameCv = null, frameCtx = null;
let hiddenAt = -1;      // 가려지기 시작한 샘플 인덱스

// 카메라는 10시간 사이에 조용히 죽는다. 다른 앱이 뺏거나, 연속성 카메라가 끼어들거나,
// 시스템이 절전에서 파이프라인을 재시작하거나. 감지하지 않으면 판정기는 그걸 그냥
// "얼굴 소실 → 자리비움"으로 적고, 프레임이 얼면 마지막 지표를 되풀이해서
// 고장을 "꾸준한 집중"으로 둔갑시킨다. 둘 다 조용히 틀린 데이터가 되므로 막는다.
const FREEZE_MS = 1500;        // 이만큼 같은 프레임이면 얼었다고 본다
const REOPEN_EVERY_MS = 5000;  // 복구 재시도 간격
let lastFrameAt = 0, camFail = null, lastReopen = 0, reopening = false, inferFailRun = 0;
const health = { ok: true, reason: null, since: 0 };
function setHealth(ok, reason) {
  if (health.ok === ok && health.reason === reason) return;
  health.ok = ok; health.reason = reason; health.since = Date.now();
  if (!ok) console.warn('[FocusSensor] 측정 불가:', reason);
  else console.log('[FocusSensor] 측정 정상 복귀');
}
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
  visionMod = vision; visionFileset = fileset; visionModel = modelBuf;
  try { landmarker = await mk('GPU'); visionDelegate = 'GPU'; ck('task', 'ok', 'delegate: GPU'); }
  catch (e1) {
    try { landmarker = await mk('CPU'); visionDelegate = 'CPU'; ck('task', 'ok', `delegate: CPU (GPU 실패: ${e1.message})`); }
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
    lastFrameAt = performance.now();
    camWarmUntil = performance.now() + CAM_WARMUP_MS;
    camFail = null; setHealth(true, null);
    const tr = stream.getVideoTracks()[0];
    if (tr) {
      // 트랙이 끝나면(다른 앱이 뺏김 등) 브라우저가 알려준다. 이걸 놓치면 무한 자리비움이 된다.
      tr.addEventListener('ended', () => {
        if (running && !paused) { camFail = '카메라 연결이 끊겼습니다'; setHealth(false, camFail); }
      });
    }
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
  // 캔버스로 프레임을 끌어온다. 가려진 탭의 비디오는 아무도 소비하지 않으면 공급이
  // 멈추는데, 매 샘플 그려주면 계속 들어온다 (실측으로 확인). 추론도 이 캔버스로 한다.
  if (!frameCv) {
    frameCv = document.createElement('canvas');
    frameCv.width = 640; frameCv.height = 480;
    frameCtx = frameCv.getContext('2d', { willReadFrequently: false });
  }
  if (frameCv.width !== video.videoWidth && video.videoWidth) {
    frameCv.width = video.videoWidth; frameCv.height = video.videoHeight;
  }
  try { frameCtx.drawImage(video, 0, 0, frameCv.width, frameCv.height); }
  catch (e) { return null; }

  if (video.currentTime === lastVideoTime) {
    // 같은 프레임 재사용은 10Hz 샘플링 / 15fps 카메라라 정상이다. 다만 몇 초씩
    // 안 바뀌면 화면이 언 것이므로, 낡은 지표를 되풀이하지 않고 소실로 처리한다.
    // 가려진 상태에서는 클럭이 흔들릴 수 있으므로 판정을 넉넉히 잡는다.
    const limit = document.hidden ? FREEZE_MS * 4 : FREEZE_MS;
    if (performance.now() - lastFrameAt > limit) {
      camFail = '카메라 화면이 멈췄습니다';
      setHealth(false, camFail);
      return null;
    }
    return lastMet;
  }
  lastVideoTime = video.currentTime;
  lastFrameAt = performance.now();
  if (camFail) { camFail = null; setHealth(true, null); }
  let res;
  try {
    res = landmarker.detectForVideo(frameCv, performance.now());
    inferFailRun = 0;
  } catch (e) {
    // GPU 컨텍스트 손실 등으로 추론이 계속 던지면, 그냥 "얼굴 없음"으로 넘기던
    // 예전 코드는 세션 끝까지 조용히 자리비움을 적었다. 연속 실패는 장애로 본다.
    inferFailRun++;
    if (inferFailRun >= 10) {
      camFail = '얼굴 인식 엔진 오류: ' + (e && e.message ? e.message : e);
      setHealth(false, camFail);
    }
    return null;
  }
  const lm = res && res.faceLandmarks && res.faceLandmarks[0];
  if (!lm) { lastMet = null; return null; }
  const m = metricsFrom(lm, frameCv.width, frameCv.height);
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
    // 측정 중에 재캘리브레이션을 하면 B단계(의도적으로 눈 감기 10초)가 그대로
    // 학습 세션에 들어가 졸음 판정·알림·썸네일까지 발생한다. 카메라는 살려둔 채
    // 판정만 멈추고, 그 구간을 제외 구간으로 남긴다.
    const wasJudging = running && !paused;
    if (wasJudging) pause('break', true);
    showPreview(true);
    const acc = CAL_STAGES.map(() => ({ ear: [], faceH: [], yaw: [], mar: [], n: 0, ok: 0 }));
    let si = 0, ts = performance.now();
    const done = r => {
      clearInterval(iv); calAbort = null; showPreview(false);
      if (wasJudging) resume();
      resolve(r);
    };
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
  // 합계만 보면 A·C 가 멀쩡할 때 B(눈 감기) 10초 중 한 프레임만 잡혀도 통과한다.
  // 그 한 프레임이 earClosed 전체를 정하고, 이후 최대 10시간의 판정선을 좌우한다.
  const names = ['A(문제 풀기)', 'B(눈 감기)', 'C(정면)'];
  for (let k = 0; k < acc.length; k++) {
    const a = acc[k], rate = a.n ? a.ok / a.n : 0;
    if (rate < 0.5) {
      return { error: `${names[k]} 단계 인식률이 ${(rate*100).toFixed(0)}% 입니다 (${a.ok}/${a.n}). ` +
        `이 단계 값이 이후 판정 기준을 정하므로 표본이 모자라면 쓸 수 없습니다. 다시 하세요.` };
    }
  }

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
    sleeps: [], breaks: [], hidden: [], camDown: [], gaps: [], shots: [], yawns: 0,
    get ok() { return this._ok.a; }, get ear() { return this._ear.a; },
    get faceH() { return this._faceH.a; }, get yaw() { return this._yaw.a; }, get mar() { return this._mar.a; }
  };
}
function pushSample(ok, ear, faceH, yaw, mar) {
  // 저장은 정수 양자화(×1000, ×100)인데 실시간 판정에 원본 실수를 쓰면
  // 임계선 언저리에서 실시간과 사후 재판정이 갈린다. 실시간에 울린 졸음이
  // 리포트에서는 집중으로 사라질 수 있다. 그래서 저장될 값으로 판정한다.
  const qe = Math.round(ear * 1000), qf = Math.round(faceH * 100);
  const qy = Math.round(yaw * 100), qm = Math.round(mar * 100);
  sess._ok.push(ok); sess._ear.push(qe); sess._faceH.push(qf);
  sess._yaw.push(qy); sess._mar.push(qm);
  if (stateBuf.length <= sess.count) { const b = new Uint8Array(stateBuf.length * 2); b.set(stateBuf); stateBuf = b; }
  const i = sess.count++;
  step(mach, i, ok, qe / 1000, qf / 100, qy / 100, stateBuf);
  return i;
}

/** 두 클럭(setTimeout / 오디오)이 함께 부른다. 시간 기준으로 밀린 샘플만 채우므로
    누가 몇 번 부르든 중복되지 않는다. */
function pump() {
  if (!running) return;
  const now = performance.now();
  let guard = 0;
  // 카메라가 다시 열리고 워밍업까지 끝났으면 이 지점에서 판정을 재개한다.
  if (pendingResume && now >= camWarmUntil) finishResume(sess.count);
  while (now >= t0 + sess.count * SAMPLE_MS && guard++ < 20000) {
    const due = t0 + sess.count * SAMPLE_MS;
    const fresh = (now - due) < SAMPLE_MS * 1.5;
    // 카메라 장애 구간은 이 샘플을 판정하기 "전에" 열고 닫아야 실시간과
    // 사후가 같은 경계를 본다. 뒤에서 하면 장애 시작·복구 샘플이 한 칸씩 어긋난다.
    const next = sess.count;
    const openCd = sess.camDown[sess.camDown.length - 1];
    if (!health.ok && !paused) {
      if (!openCd || openCd[1] !== 1e12) sess.camDown.push([next, 1e12]);
    } else if (openCd && openCd[1] === 1e12) {
      openCd[1] = Math.max(openCd[0], next - 1);
    }
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
  maintain();
  if (onTickCb) onTickCb(sess, stateBuf);
}

function tick() {
  if (!running) return;
  pump();
  timer = setTimeout(tick, Math.max(2, t0 + sess.count * SAMPLE_MS - performance.now()));
}

/** 오디오 스레드가 미는 보조 클럭. 가려진 탭에서 setTimeout 이 분당 1회로 조여져도
    이건 살아 있다(실측 11.7Hz). 소리는 거의 안 들리는 세기로 흘린다. */
function startBgClock() {
  if (!opts.bgMode || bgActive) return;
  try {
    bgCtx = Sound.init();
    if (!bgCtx) return;
    if (bgCtx.state === 'suspended') bgCtx.resume();
    bgOsc = bgCtx.createOscillator();
    const g = bgCtx.createGain();
    bgOsc.frequency.value = 60; g.gain.value = 0.0008;
    bgOsc.connect(g).connect(bgCtx.destination); bgOsc.start();
    bgProc = bgCtx.createScriptProcessor(4096, 1, 1);   // 48kHz 기준 약 11.7Hz
    bgProc.onaudioprocess = () => { bgTicks++; if (running) pump(); };
    bgProc.connect(bgCtx.destination);
    bgActive = true; bgTicks = 0; bgLastCheck = performance.now();
    console.log('[FocusSensor] 백그라운드 클럭 켬 · AudioContext ' + bgCtx.state);
  } catch (e) { console.warn('[FocusSensor] 백그라운드 클럭 실패', e); bgActive = false; }
}
function stopBgClock() {
  try { if (bgOsc) bgOsc.stop(); } catch (e) {}
  try { if (bgProc) { bgProc.onaudioprocess = null; bgProc.disconnect(); } } catch (e) {}
  bgOsc = null; bgProc = null; bgActive = false; bgHealthy = false; bgTicks = 0;
}

/** 주기 점검 — 카메라 복구와 Wake Lock 재획득. 10시간 방치가 전제라
    "한 번 걸어두고 잊는" 방식은 쓸 수 없다. */
function maintain() {
  const now = performance.now();
  // 가려진 동안은 복구를 시도하지 않는다. 프레임이 멈춘 게 정상이라 고칠 게 없고,
  // 트랙을 껐다 켜면 LED 만 깜빡이면서 워밍업 구간이 계속 쌓인다.
  if (!document.hidden && !health.ok && !paused && !reopening && now - lastReopen > REOPEN_EVERY_MS) {
    lastReopen = now; reopening = true;
    const engineDead = inferFailRun >= 10;
    Promise.resolve()
      .then(() => {
        // 추론 자체가 죽었으면 카메라를 다시 여는 것만으로는 안 낫는다. 엔진부터 새로 만든다.
        if (!engineDead || !visionMod) return;
        try { if (landmarker) landmarker.close(); } catch (e) {}
        return visionMod.FaceLandmarker.createFromOptions(visionFileset, {
          baseOptions: { modelAssetBuffer: visionModel, delegate: visionDelegate },
          runningMode: 'VIDEO', numFaces: 1,
          outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false
        }).then(l => { landmarker = l; inferFailRun = 0; console.log('[FocusSensor] 인식 엔진 재생성'); });
      })
      .then(() => {
        if (stream) { try { stream.getVideoTracks().forEach(t => t.stop()); } catch (e) {} }
        return openCamera();
      })
      .catch(e => console.warn('[FocusSensor] 복구 실패', e))
      .finally(() => { reopening = false; });
  }
  // 백그라운드 클럭이 진짜 도는지 5초마다 확인한다. AudioContext 가 자동재생 정책으로
  // suspended 로 떨어지면 노드는 살아 있는데 콜백이 안 온다.
  if (opts.bgMode && bgActive && now - bgLastCheck > 5000) {
    const spanSec = (now - bgLastCheck) / 1000;
    bgHealthy = (bgTicks / spanSec) > 3;
    if (!bgHealthy) {
      console.warn('[FocusSensor] 백그라운드 클럭이 멈춤 — 되살리기 시도');
      try { if (bgCtx && bgCtx.state === 'suspended') bgCtx.resume(); } catch (e) {}
    }
    bgTicks = 0; bgLastCheck = now;
  }

  // Wake Lock 은 저전력 모드·배터리 부족으로 화면이 켜진 채로도 풀린다.
  // 사양서 §1 이 지목한 "실패해도 경고가 없어 10시간이 날아가는" 구멍이 여기다.
  if (!paused && now - lastWakeCheck > WAKE_CHECK_MS) {
    lastWakeCheck = now;
    if (!wakeLock) requestWake();
  }
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
  if (!sess) return;
  if (document.hidden) {
    sess.gaps.push(sess.count);
    hiddenAt = sess.count;
    // 백그라운드 클럭이 살아 있으면 가려져도 계속 잰다. 미리 "측정 불가"로
    // 찍어두지 않고, 돌아왔을 때 실제로 못 쟀는지를 보고 판단한다.
    if (!bgActive) sess.hidden.push([sess.count, 1e12]);
  } else {
    if (bgActive && hiddenAt >= 0) evaluateHidden();
    hiddenAt = -1;
    const h = sess.hidden[sess.hidden.length - 1];
    if (h && h[1] === 1e12) {
      // sess.count 로 닫으면 안 된다. 가려진 동안 타이머가 조여져서 count 가
      // 실시간보다 최대 1분 뒤처져 있고, 복귀 직후 tick() 이 그 공백을 ok=0 으로
      // 채운다. 그 샘플들이 구간 밖에 남으면 "측정 불가"가 아니라 "자리비움"이 된다.
      // 스로틀링을 처리하려던 경로가 가장 심하게 스로틀링될 때 정반대로 동작하는 셈이다.
      const nowIdx = Math.floor((performance.now() - t0) / SAMPLE_MS);
      h[1] = Math.max(h[0], nowIdx - 1);
    }
    if (mach) { machReset(mach); mach.hp = 0; }   // 가려진 동안의 잔여 상태는 못 믿는다
    // 가려진 동안 프레임이 멈춰 있었으므로, 복귀 직후 곧바로 "얼었다"로 판정하지
    // 않도록 프레임 시계를 다시 맞춘다.
    lastFrameAt = performance.now();
    if (camFail === '카메라 화면이 멈췄습니다') { camFail = null; setHealth(true, null); }
    requestWake();
  }
}
const WAKE_CHECK_MS = 30000;
let lastWakeCheck = 0, wakeSupported = ('wakeLock' in navigator), wakeLost = false;
/** 가려졌던 구간을 실제로 쟀는지 표본으로 판단한다. 백그라운드 클럭이 있어도
    기기·설정에 따라 프레임이 안 올 수 있으므로, 가정하지 않고 증거를 본다.
    거의 못 쟀으면 그 구간을 "측정 불가"로 남긴다. */
function evaluateHidden() {
  const a = hiddenAt, b = sess.count - 1;
  if (b < a) return;
  let obs = 0;
  for (let i = a; i <= b; i++) if (sess.ok[i]) obs++;
  const span = b - a + 1, rate = obs / span;
  if (rate < 0.3) {
    sess.hidden.push([a, b]);
    console.warn(`[FocusSensor] 가려진 ${(span/HZ).toFixed(1)}초 중 관측 ${(rate*100).toFixed(0)}% — 측정 불가로 기록`);
  } else {
    console.log(`[FocusSensor] 가려진 ${(span/HZ).toFixed(1)}초를 관측률 ${(rate*100).toFixed(0)}% 로 측정함`);
  }
}

async function requestWake() {
  if (!wakeSupported) return;
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLost = false;
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        // 화면이 잠들면 브라우저가 타이머를 분당 1회로 조인다. 조용히 넘기면 안 된다.
        if (running && !paused) { wakeLost = true; console.warn('[FocusSensor] WakeLock 해제됨 — 재획득 시도'); }
      });
    }
  } catch (e) {
    wakeLost = true;
    console.warn('[FocusSensor] WakeLock 실패', e);
  }
}

async function start(cal, cbState, cbTick) {
  if (!ready) throw new Error('초기화 필요');
  if (running) return sess;
  sess = newSession(cal);
  stateBuf = new Uint8Array(16384);
  mach = createMachine(cal, opts, sess.sleeps, sess.breaks, sess.hidden, sess.camDown);
  mach.onEvent = (type, i) => { if (type === 'drowsy') onDrowsyOnset(i); };
  onStateCb = cbState || null; onTickCb = cbTick || null;
  running = true; paused = false; pauseKind = null;
  t0 = performance.now(); lastAlert = -1e9; yawnRun = 0;
  requestWake();
  startBgClock();                 // 사용자 제스처 안에서 호출되므로 여기서 켠다
  hiddenAt = -1;
  document.addEventListener('visibilitychange', onVis);
  snapTimer = setInterval(snapshot, 60000);
  tick();
  return sess;
}

/** kind: 'sleep'(수면 버튼) | 'break'(타이머 휴식·일시정지)
    keepCamera: 캘리브레이션처럼 카메라는 살려두고 판정만 멈출 때 true */
function pause(kind, keepCamera) {
  if (!running || paused) return;
  paused = true; pauseKind = (kind === 'sleep') ? 'sleep' : 'break';
  pauseKeptCamera = !!keepCamera;
  const list = pauseKind === 'sleep' ? sess.sleeps : sess.breaks;
  list.push([sess.count, 1e12]);
  if (!pauseKeptCamera && stream) stream.getVideoTracks().forEach(t => t.stop());
}
async function resume() {
  if (!running || !paused || pendingResume) return;
  if (!pauseKeptCamera) await openCamera();     // camWarmUntil 이 여기서 설정된다
  machReset(mach); mach.sp = 0; mach.bp = 0; mach.hp = 0; mach.cp = 0;
  // 제외 구간을 여기서 닫으면 안 된다. 카메라를 여는 동안과 워밍업 2초 동안
  // tick() 은 계속 ok=0 을 밀어넣는데, 구간이 이미 닫혀 있으면 그 샘플들이
  // "직전 상태 유지" 규칙을 타고 대부분 집중으로 기록된다. 휴식마다 몇 초씩
  // 집중이 부풀려지는 셈이다. 실제로 판정을 재개하는 순간에 닫는다.
  pendingResume = true;
}
/** 워밍업이 끝나 판정을 실제로 재개하는 순간 — 제외 구간을 여기서 닫는다 */
function finishResume(nextIdx) {
  const list = pauseKind === 'sleep' ? sess.sleeps : sess.breaks;
  const s = list[list.length - 1];
  if (s && s[1] === 1e12) s[1] = Math.max(s[0], nextIdx - 1);
  paused = false; pauseKind = null; pauseKeptCamera = false; pendingResume = false;
}

function exportSession(s) {
  const fix = list => list.map(x => [x[0], Math.min(x[1], Math.max(0, s.count - 1))]);
  return {
    id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, hz: s.hz, count: s.count, cal: s.cal,
    ok: s._ok.slice(), ear: s._ear.slice(), faceH: s._faceH.slice(), yaw: s._yaw.slice(), mar: s._mar.slice(),
    sleeps: fix(s.sleeps), breaks: fix(s.breaks), hidden: fix(s.hidden), camDown: fix(s.camDown),
    gaps: s.gaps.slice(), shots: s.shots.slice(), yawns: s.yawns
  };
}
async function snapshot() { if (sess) await DB.put('focusSessions', exportSession(sess)); }

async function stop() {
  if (!running) return sess ? exportSession(sess) : null;
  running = false;
  clearTimeout(timer); clearInterval(snapTimer);
  stopBgClock();
  document.removeEventListener('visibilitychange', onVis);
  if (paused) {
    const list = pauseKind === 'sleep' ? sess.sleeps : sess.breaks;
    const s = list[list.length - 1];
    if (s && s[1] === 1e12) s[1] = Math.max(s[0], sess.count - 1);
    paused = false; pauseKind = null; pauseKeptCamera = false; pendingResume = false;
  }
  for (const list of [sess.hidden, sess.camDown]) {
    const o = list[list.length - 1];
    if (o && o[1] === 1e12) o[1] = Math.max(o[0], sess.count - 1);
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
  const per = n / W, cnt = new Int32Array(7);
  for (let x = 0; x < W; x++) {
    const a = Math.floor(x * per), b = Math.min(n, Math.floor((x + 1) * per) + (per < 1 ? 1 : 0));
    cnt.fill(0);
    for (let i = a; i < b; i++) cnt[states[i]]++;
    let pick = 0, mx = -1;
    for (let k = 0; k < 7; k++) if (cnt[k] > mx) { mx = cnt[k]; pick = k; }
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
const STRIP_PRIO = [6, 5, 4, 3, 1, 2];        // 뒤로 갈수록 셈. 졸음이 가장 세다
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
/** 캘리브레이션이 실제 자세와 맞는지. 어긋나면 판정 전체가 흔들리므로
    숫자만 보고 "왜 이러지" 하지 않도록 리포트에서 짚어준다.
    실제로 A단계에서 실사용보다 고개를 훨씬 숙여 잰 세션이 있었는데,
    그 탓에 보정이 EAR 을 키우는 게 아니라 깎고 있었다. */
function calFit(s, o) {
  const ears = [], fhs = [], norm = [];
  let clamped = 0;
  for (let i = 0; i < s.count; i++) if (s.ok[i]) {
    const e = s.ear[i] / 1000, f = s.faceH[i] / 100;
    ears.push(e); fhs.push(f);
    // 클램프 없이 기준 자세로 환산한 값. 보정 모델(EAR·faceH 둘 다 cos(pitch)에 비례)이
    // 맞다면 이 값의 중앙값은 캘리브레이션의 earOpen 과 비슷해야 한다.
    // 이게 진짜 적합도 지표다. faceH 가 다르다는 것 자체는 문제가 아니다 —
    // 자세가 다르면 당연히 다르고, 보정이 하는 일이 바로 그 차이를 되돌리는 것이다.
    norm.push(e * (s.cal.faceH / Math.max(f, 1e-6)));
    const r = f / s.cal.faceH;
    if (r < 0.55 || r > 1.15) clamped++;
  }
  if (ears.length < HZ * 10) return '<div class="note">표본이 모자라 판단할 수 없습니다.</div>';
  const mEar = median(ears), mFh = median(fhs), mNorm = median(norm);
  const fit = mNorm / s.cal.earOpen;
  const clampRate = clamped / ears.length;
  const rows = [
    ['고개 높이 faceH', s.cal.faceH.toFixed(2), mFh.toFixed(2),
      '자세가 다른 건 정상 — 보정이 되돌립니다'],
    ['뜬 눈 EAR (원본)', s.cal.earOpen.toFixed(3), mEar.toFixed(3),
      '자세가 다르면 이 값도 달라집니다'],
    ['<b>기준 자세로 환산한 EAR</b>', `<b>${s.cal.earOpen.toFixed(3)}</b>`, `<b>${mNorm.toFixed(3)}</b>`,
      `<b>${(fit * 100).toFixed(0)}%</b> — 100%에 가까울수록 잘 맞음`],
    ['분리도 (뜬 눈 − 감은 눈)', s.cal.sep != null ? s.cal.sep.toFixed(3) : '—', '—',
      (s.cal.sep != null && s.cal.sep < 0.06) ? '<span style="color:#d8b878">여유가 적음</span>' : '충분'],
    ['보정 상한에 걸린 샘플', '—', `${(clampRate * 100).toFixed(0)}%`,
      clampRate > 0.5 ? '<span style="color:#d8b878">자세 차이가 커서 보정이 덜 됨</span>' : '문제없음']
  ];
  let warn = '';
  if (fit < 0.75 || fit > 1.35) {
    warn += `<div class="warn"><b>캘리브레이션이 이번 세션과 맞지 않습니다.</b> 기준 자세로 환산한 EAR 이 ` +
      `${mNorm.toFixed(3)} 인데 캘리브레이션의 뜬 눈은 ${s.cal.earOpen.toFixed(3)} 입니다 (${(fit*100).toFixed(0)}%). ` +
      `자세 차이로는 설명되지 않는 차이라 <b>조명이나 카메라 위치가 달라진 것</b>일 수 있습니다. ` +
      `다시 캘리브레이션하세요.</div>`;
  } else if (clampRate > 0.5) {
    warn += `<div class="warn">자세가 캘리브레이션 때와 많이 달라 보정이 상한에 걸린 샘플이 ` +
      `${(clampRate*100).toFixed(0)}% 입니다. 판정이 크게 틀리지는 않지만, ` +
      `<b>이번 세션 같은 자세로 다시 캘리브레이션하면</b> 더 정확해집니다. ` +
      `종이 문제풀이와 화면 강의처럼 자세가 크게 다른 두 상황을 오간다면, 더 오래 하는 쪽에 맞추세요.</div>`;
  }
  if (s.cal.sep != null && s.cal.sep < 0.06) {
    warn += `<div class="warn">뜬 눈과 감은 눈의 차이(분리도 ${s.cal.sep.toFixed(3)})가 작습니다. ` +
      `판정선이 좁은 폭 안에 놓여 작은 흔들림에도 졸음이 오갈 수 있습니다. 조명을 밝히거나 ` +
      `카메라를 눈높이에 가깝게 올린 뒤 다시 재면 나아집니다.</div>`;
  }
  if (!warn) warn = '<div class="note">캘리브레이션이 이번 세션과 잘 맞습니다.</div>';
  return `<table><tr><th>항목</th><th>캘리브레이션</th><th>이번 세션</th><th>해석</th></tr>` +
    rows.map(x => `<tr><td>${x[0]}</td><td>${x[1]}</td><td>${x[2]}</td><td>${x[3]}</td></tr>`).join('') +
    `</table>` + warn;
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
      `노트를 보며 고개가 돌아간 채 공부하면 그 자세 전체가 이탈 쪽으로 밀립니다.<br>` +
      `<b>판정 폭을 넓히는 건 해법이 아닙니다</b> — 중심이 어긋난 채로 폭만 키우면 반대쪽(진짜 딴 데 보는 방향) ` +
      `감도까지 같이 죽습니다. 아래 버튼으로 <b>중심을 옮기세요.</b>`;
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
    <h4>수면 · 휴식 · 측정 불가 구간</h4><div id="fsRest"></div>
    <h4>졸음 구간</h4><div id="fsDrowsy"></div>
    <h4>이탈 구간</h4><div id="fsAway"></div>
    <h4>캘리브레이션 적합도</h4><div id="fsFit"></div>
    <h4>고개 방향 분포</h4><canvas id="fsYaw" style="height:110px"></canvas>
    <div class="note" id="fsYawNote"></div>
    <div class="frow" style="display:flex;gap:8px;align-items:center;margin:10px 0">
      <button id="fsSetYaw">이 세션의 자세를 정면 기준으로 저장</button>
      <span class="note" id="fsSetYawMsg"></span>
    </div>
    <h4>임계값 조정 — 재측정 없이 즉시 재판정</h4>
    <div id="fsSliders"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
      <button id="fsReset">기본값으로</button><button id="fsCsv">CSV</button><button id="fsJson">JSON</button>
    </div>
    <h4>알려진 한계</h4>
    <div class="note">
      · 눈을 뜨고 딴생각하는 건 잡지 못합니다. 이 숫자는 “몰입도”가 아니라 “안 졸고 자리를 지켰나”입니다.<br>
      · 고개를 <b>뒤로</b> 젖히는 자세는 숙인 것과 구분되지 않습니다 (faceH가 양방향으로 줄어듦).<br>
      · 고개를 옆으로 돌리면 두 눈 사이 거리가 짧아져 faceH가 커집니다. 그러면 고개 숙임 보정이
        EAR을 깎아, <b>고개 돌린 동안은 졸음이 과하게 잡힙니다.</b> 실측 상관계수 −0.72.<br>
      · 무엇을 보고 있는지는 구분하지 못합니다. 왼쪽 노트를 보는 것과 딴 데를 보는 것이 같게 찍히므로,
        고개 돌림은 기본적으로 이탈로 세지 않습니다.<br>
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
  q('fsSliders').innerHTML =
    `<label style="display:flex;gap:7px;align-items:center;margin:6px 0 12px;font-size:12px">
      <input type="checkbox" id="fsAwayOn"${o.awayOnTurn ? ' checked' : ''}> 고개 돌림을 이탈로 셈
      <span class="note">(끄면 자리를 비운 것만 셉니다)</span></label>` +
    SL.map(([k, n, mn, mx, st]) =>
    `<div class="sld"><span>${n}</span>
      <input type="range" id="fsl_${k}" min="${mn}" max="${mx}" step="${st}" value="${o[k]}">
      <b id="fsv_${k}">${o[k].toFixed(2)}</b></div>`).join('');
  for (const [k] of SL) q('fsl_' + k).oninput = e => {
    o[k] = parseFloat(e.target.value); q('fsv_' + k).textContent = o[k].toFixed(2); paint();
  };
  q('fsReset').onclick = () => {
    for (const [k] of SL) { o[k] = DEFAULTS[k]; q('fsl_' + k).value = o[k]; q('fsv_' + k).textContent = o[k].toFixed(2); }
    o.awayOnTurn = DEFAULTS.awayOnTurn; q('fsAwayOn').checked = o.awayOnTurn;
    paint();
  };
  // 이탈 오탐의 근본 수정 — 판정 폭이 아니라 중심을 실제 자습 자세로 옮긴다.
  // 폭을 키우면 반대 방향 감도까지 죽으므로 이쪽이 옳다.
  q('fsSetYaw').onclick = async () => {
    const vals = [];
    for (let i = 0; i < s.count; i++) if (s.ok[i]) vals.push(s.yaw[i] / 100);
    if (!vals.length) { q('fsSetYawMsg').textContent = '얼굴을 잡은 샘플이 없습니다.'; return; }
    const before = s.cal.yawLog, next = median(vals);
    s.cal = Object.assign({}, s.cal, { yawLog: next });
    const saved = await saveCal(s.cal);
    q('fsSetYawMsg').innerHTML = `정면 기준 ${before.toFixed(2)} → <b>${next.toFixed(2)}</b> ` +
      (saved ? '저장됨. 다음 세션부터 적용됩니다.' : '<b>저장 실패</b> — 이 리포트에만 반영됩니다.');
    paint();
  };
  q('fsAwayOn').onchange = e => { o.awayOnTurn = e.target.checked; paint(); };
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
    if (r.c[6]) {
      const camSec = (s.camDown || []).reduce((a, x) => a + (x[1] - x[0] + 1), 0) / HZ;
      const hidSec = sec(r.c[6]) - camSec;
      w += `<div class="warn">잴 수 없었던 시간이 ${hms(sec(r.c[6]))} 있습니다` +
        (camSec ? ` (그중 카메라 끊김 ${hms(camSec)})` : ` (탭 가려짐 ${s.gaps.length}회)`) +
        `. <b>자리비움으로 세지 않고 집중률 분모에서 빼</b> 두었으니, 이 시간이 길면 ` +
        `집중률은 “잰 시간 안에서의 비율”로만 읽으세요.` +
        // 세션의 3할 이상이 탭 가려짐이면 배치 문제다. 인강 전체화면이 대표적인 원인이라
        // 리포트를 볼 때 바로 알 수 있게 해법을 붙여 둔다.
        (hidSec > sec(s.count) * 0.3
          ? `<br><br><b>세션의 ${(hidSec / sec(s.count) * 100).toFixed(0)}% 가 탭 가려짐입니다.</b> ` +
            `맥에서 영상을 전체화면으로 보면 타이머 탭이 다른 Space 로 밀려나 카메라 영상이 끊깁니다. ` +
            `브라우저 정책이라 코드로는 못 뚫습니다. 영상을 <b>PiP(화상 속 화상)</b>로 띄우고 ` +
            `타이머 탭을 앞에 두면 측정이 유지됩니다. Split View 나 외부 모니터도 됩니다. ` +
            `타이머의 공부 시간 기록 자체는 이 구간에도 정상입니다.`
          : '') +
        `</div>`;
    }
    if (s.cal.warn) w += `<div class="warn">${s.cal.warn}</div>`;
    q('fsWarn').innerHTML = w;

    q('fsRate').innerHTML = (r.rate * 100).toFixed(1) + '<small>%</small>';
    q('fsRate2').textContent = `집중률 (수면·휴식 제외) · 잰 시간 ${hms(sec(r.denom))} · 판정선 ` +
      (s.cal.earClosed + o.earFrac * (s.cal.earOpen - s.cal.earClosed)).toFixed(3);
    q('fsKv').innerHTML = [['집중', hms(sec(r.c[0]))], ['졸음', hms(sec(r.c[2]))], ['이탈', hms(sec(r.c[1]))],
      ['자리비움', hms(sec(r.c[3]))], ['수면', hms(sec(r.c[4]))], ['휴식', hms(sec(r.c[5]))],
      ['측정 불가', hms(sec(r.c[6]))], ['하품', s.yawns + '회']].map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('');

    drawTape(q('fsTape'), states);
    drawBars(q('fsBars'), states);

    const rest = [].concat(
      (s.sleeps || []).filter(x => x[1] >= x[0]).map(x => ['수면', x]),
      (s.breaks || []).filter(x => x[1] >= x[0]).map(x => ['휴식', x]),
      (s.hidden || []).filter(x => x[1] >= x[0]).map(x => ['탭 가려짐', x]),
      (s.camDown || []).filter(x => x[1] >= x[0]).map(x => ['카메라 끊김', x])
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
    if (!o.awayOnTurn) {
      q('fsAway').innerHTML = '<div class="note">고개 돌림을 이탈로 세지 않는 설정입니다. ' +
        '자리를 실제로 비운 것은 <b>자리비움</b>으로 따로 셉니다. ' +
        '아래 <b>고개 돌림을 이탈로 셈</b>을 켜면 판정합니다.</div>';
      drawYawHist(q('fsYaw'), s, o);
      q('fsYawNote').innerHTML = yawNote(s, o);
      q('fsFit').innerHTML = calFit(s, o);
      return;
    }
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

    q('fsFit').innerHTML = calFit(s, o);
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

  // 창이 덜 찼을 때 PERCLOS 가 끼어들면 안 된다. 실사용에서 2.8초 감김 하나가
  // 28/200=14% 로 계산돼 눈 열림 81% 인 30초를 졸음으로 만들었다. 창이 한 바퀴
  // 돌기 전에는 규칙 5를 쓰지 않으므로 이제 정확히 감긴 만큼만 나와야 한다.
  { const a = 200;
    const segs = segments(rejudge(synth(60 * HZ, i => ({ ear: (i >= a && i < a + 50) ? SHUT : OPEN }), cal), {}), 2);
    const len = segs.length ? (segs[0][1] - segs[0][0] + 1) / HZ : 0;
    T('4b', '창 미충전 구간(20초 지점)의 5초 감김 — PERCLOS 가 연장하지 않는다',
      segs.length === 1 && segs[0][0] === a && len === 5.0,
      `길이 ${len.toFixed(1)}초 (기대 5.0), 시작 ${segs.length?segs[0][0]:'-'}`); }

  // 회귀 방지 — 짧은 감김 하나가 창이 덜 찬 구간에서 긴 졸음으로 번지면 안 된다
  { const n = 50 * HZ, a = 15 * HZ;
    const s = synth(n, i => ({ ear: (i >= a && i < a + 28) ? SHUT : (i % 40 < 3 ? SHUT : OPEN) }), cal);
    const st = rejudge(s, {});
    T('4c', '2.8초 감김 + 정상 깜빡임 (실사용 재현) — 졸음이 번지지 않는다',
      secOf(st, 2) <= 4.0,
      `졸음 ${secOf(st,2).toFixed(1)}초 (기대 ≤4.0). 고치기 전에는 30초 넘게 번졌다`); }

  { const s = synth(120 * HZ, () => ({ ear: 0.12, faceH: 0.93 }), cal);
    const f1 = secOf(rejudge(s, { headComp: 1 }), 0), d0 = secOf(rejudge(s, { headComp: 0 }), 2);
    T(5, '깊은 필기 자세 (faceH 0.93, EAR 0.12) 2분 — 가장 중요', f1 === 120 && d0 === 120,
      `headComp=1 → 집중 ${f1}초 (기대 120) / headComp=0 → 졸음 ${d0}초 (기대 120)`); }

  { const s = synth(10 * HZ, () => ({ ear: OPEN, yaw: 0.9 }), cal);
    const on = rejudge(s, { awayOnTurn: true });
    T(6, 'yawLog 0.9 유지 10초 — 규칙을 켰을 때', secOf(on, 0) === 3.0 && secOf(on, 1) === 7.0,
      `집중 ${secOf(on,0).toFixed(1)}초 / 이탈 ${secOf(on,1).toFixed(1)}초 (기대 3.0 / 7.0)`);
    const off = rejudge(s, {});
    T('6b', '기본값에서는 고개 돌림을 이탈로 세지 않는다',
      secOf(off, 1) === 0 && secOf(off, 0) === 10.0,
      `이탈 ${secOf(off,1).toFixed(1)}초 (기대 0) / 집중 ${secOf(off,0).toFixed(1)}초 (기대 10.0)`); }

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
    // 세 번 재서 가장 빠른 값을 쓴다. 한 번만 재면 JIT 컴파일이나 GC 정지가
    // 그대로 섞여 들어와 간헐적으로 실패한다. 재려는 건 정상 상태의 판정 속도다.
    let ms = Infinity, st = null;
    for (let k = 0; k < 3; k++) {
      const t = performance.now(); st = rejudge(s, {}); const d = performance.now() - t;
      if (d < ms) ms = d;
    }
    T(9, '36만 샘플 전체 재판정', ms < 100, `${ms.toFixed(1)}ms (기대 <100, 3회 중 최속), 집중 ${secOf(st,0).toFixed(0)}초`); }

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

  // 탭 가려짐은 자리비움이 아니라 "잴 수 없었던 시간"이다. 분모에서 빠져야 한다.
  { const n = 30 * 60 * HZ, a = 10 * 60 * HZ, b = a + 5 * 60 * HZ - 1;
    const s = synth(n, i => (i >= a && i <= b) ? { ok: 0 } : { ear: OPEN }, cal);
    s.hidden = [[a, b]];
    const st = rejudge(s, {}), r = stats(st);
    T(12, '탭 가려짐 5분 — 자리비움이 아니라 분모에서 제외',
      Math.abs(secOf(st, 6) - 300) < 0.05 && secOf(st, 3) === 0 && r.rate > 0.99,
      `가려짐 ${secOf(st,6)}초 / 자리비움 ${secOf(st,3)}초 (기대 0) / 집중률 ${(r.rate*100).toFixed(1)}%`); }

  // 같은 구간을 가려짐으로 표시하지 않으면 자리비움으로 잡혀 집중률이 깎인다 (회귀 방지)
  { const n = 30 * 60 * HZ, a = 10 * 60 * HZ, b = a + 5 * 60 * HZ - 1;
    const s = synth(n, i => (i >= a && i <= b) ? { ok: 0 } : { ear: OPEN }, cal);
    const r = stats(rejudge(s, {}));
    T('12b', '표시가 없으면 같은 구간이 자리비움으로 잡히는지 (대조군)',
      r.c[3] > 0 && r.rate < 0.9,
      `자리비움 ${(r.c[3]/HZ).toFixed(0)}초 / 집중률 ${(r.rate*100).toFixed(1)}%`); }

  // 카메라가 죽은 구간은 자리비움이 아니라 측정 불가다. 이게 뒤집히면
  // 앉아서 공부한 시간이 통째로 자리비움으로 찍힌다.
  { const n = 30 * 60 * HZ, a = 10 * 60 * HZ, b = a + 5 * 60 * HZ - 1;
    const s = synth(n, i => (i >= a && i <= b) ? { ok: 0 } : { ear: OPEN }, cal);
    s.camDown = [[a, b]];
    const st = rejudge(s, {}), r = stats(st);
    T(13, '카메라 사망 5분 — 자리비움이 아니라 측정 불가',
      Math.abs(secOf(st, 6) - 300) < 0.05 && secOf(st, 3) === 0 && r.rate > 0.99,
      `측정 불가 ${secOf(st,6)}초 / 자리비움 ${secOf(st,3)}초 (기대 0) / 집중률 ${(r.rate*100).toFixed(1)}%`); }

  // 휴식 구간도 수면과 똑같이 분모에서 빠져야 한다 (타이머 통합용)
  { const n = 30 * 60 * HZ, a = 10 * 60 * HZ, b = a + 5 * 60 * HZ - 1;
    const s = synth(n, i => (i >= a && i <= b) ? { ok: 0 } : { ear: OPEN }, cal);
    s.breaks = [[a, b]];
    const st = rejudge(s, {}), r = stats(st);
    T(11, '휴식 5분 — 수면과 같이 분모에서 제외', Math.abs(secOf(st, 5) - 300) < 0.05 && r.rate > 0.99,
      `휴식 ${secOf(st,5)}초 / 집중률 ${(r.rate*100).toFixed(1)}% (잰 시간 ${(r.denom/HZ/60).toFixed(0)}분)`); }

  // --- Codex 리뷰에서 나온 것들. 기존 테스트가 재현하지 못하던 영역이다. ---

  // 관측하지 못한 시간을 사이에 두고 "연속"으로 합산하면 안 된다.
  { const n = 60 * HZ;
    const s = synth(n, i => {
      if (i < 14) return { ear: SHUT };            // 1.4초 감김 (판정 직전)
      if (i < 113) return { ok: 0 };               // 9.9초 얼굴 소실
      if (i === 113) return { ear: SHUT };         // 0.1초 감김
      return { ear: OPEN };
    }, cal);
    const st = rejudge(s, {});
    T(16, '감김 1.4초 → 소실 9.9초 → 감김 0.1초 는 마이크로슬립이 아니다',
      st[113] !== 2 && secOf(st, 2) === 0,
      `졸음 ${secOf(st,2).toFixed(1)}초 (기대 0)`); }

  // 회전도 마찬가지
  { const n = 60 * HZ;
    const s = synth(n, i => {
      if (i < 29) return { ear: OPEN, yaw: 0.9 };  // 2.9초 회전
      if (i < 128) return { ok: 0 };               // 9.9초 소실
      if (i === 128) return { ear: OPEN, yaw: 0.9 };
      return { ear: OPEN };
    }, cal);
    const st = rejudge(s, {});
    T('16b', '회전 2.9초 → 소실 9.9초 → 회전 0.1초 는 이탈이 아니다',
      st[128] !== 1, `128번 샘플 상태 ${STATE[st[128]]}`); }

  // 짧은 소실(0.3초)은 감김 도중에도 일어나므로 런을 끊으면 안 된다
  { const n = 60 * HZ;
    const s = synth(n, i => {
      if (i < 10) return { ear: SHUT };
      if (i < 13) return { ok: 0 };                // 0.3초만 소실
      if (i < 30) return { ear: SHUT };
      return { ear: OPEN };
    }, cal);
    T('16c', '감김 도중 0.3초 소실은 런을 잇는다', secOf(rejudge(s, {}), 2) > 0,
      `졸음 ${secOf(rejudge(s, {}), 2).toFixed(1)}초 (0 이면 안 됨)`); }

  // 실시간이 원본 실수로 판정하면 사후(정수 저장값)와 갈린다.
  // pushSample 과 똑같이 양자화해서 넣어야 두 경로가 일치한다.
  { const n = 40 * HZ;
    const raw = [];
    for (let i = 0; i < n; i++) raw.push(0.1316 + (i % 3) * 0.00002);   // 판정선 0.132 바로 아래
    const s = { count: n, hz: HZ, cal, sleeps: [], breaks: [], hidden: [], camDown: [],
      ok: new Int16Array(n), ear: new Int16Array(n), faceH: new Int16Array(n),
      yaw: new Int16Array(n), mar: new Int16Array(n) };
    const live = new Uint8Array(n);
    const m = createMachine(cal, {}, [], [], [], []);
    for (let i = 0; i < n; i++) {
      const qe = Math.round(raw[i] * 1000), qf = Math.round(cal.faceH * 100);
      s.ok[i] = 1; s.ear[i] = qe; s.faceH[i] = qf; s.yaw[i] = 0; s.mar[i] = 5;
      step(m, i, 1, qe / 1000, qf / 100, 0, live);       // pushSample 과 동일한 경로
    }
    const batch = rejudge(s, {});
    let diff = 0; for (let i = 0; i < n; i++) if (batch[i] !== live[i]) diff++;
    T(17, '임계선 언저리에서 실시간 == 사후 (양자화 일치)', diff === 0,
      `불일치 ${diff}개 / ${n} · 원본 0.1316 → 저장 ${Math.round(0.1316*1000)} · 판정선 ${earThr.toFixed(3)}`); }

  const pass = R.filter(Boolean).length;
  L.push(`\n${pass}/${R.length} 통과`);
  return { text: L.join('\n'), pass, total: R.length };
}

/* ─────────────────── 공개 인터페이스 ─────────────────── */
global.FocusSensor = {
  VERSION, HZ, STATE, COLOR, CHECKS, DEFAULTS, EXCLUDED,
  init, calibrate, start, pause, resume, stop, report, snapshot,
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
  saveCal, loadCal,
  get health() { return { ok: health.ok, reason: health.reason, since: health.since,
    wakeLost: wakeLost, wakeSupported: wakeSupported,
    bgActive: bgActive && (!bgCtx || bgCtx.state === 'running'),
    bgHealthy: bgHealthy, bgState: bgCtx ? bgCtx.state : 'none' }; },
  detectNow, rejudge, stats, segments, mergeSegs, earAdjust, opennessOf,
  hms, durTxt, clockAt, drawTape, drawBars, drawStrip, runTests, synth,
  sound: Sound, db: DB, showPreview
};

})(typeof window !== 'undefined' ? window : globalThis);
