// ─────────────────────────────────────────────────────────────────────────────
// pen-input.js — Stylus-only input (palm rejection) for the measurement tools.
//
// Problem this solves: on an iPad, placing a measurement point with an Apple
// Pencil is hard because the palm resting on the glass registers as a touch.
// OrbitControls picks that touch up and orbits the view, so the snap target
// slides out from under the pencil tip.
//
// Policy while a measurement tool is active:
//   • stylus           → always passes through (tap places a point, drag orbits)
//   • mouse / trackpad  → untouched
//   • one finger / palm → swallowed; this is the contact that ruins a snap
//   • two fingers       → handed to OrbitControls as a pinch, so zoom and pan
//                         stay available — unless the stylus is in use right
//                         now, in which case the extra contacts are a palm and
//                         stay swallowed.
//
// How the swallowing works: OrbitControls binds its own `pointerdown` listener
// directly to the renderer's canvas, and it does so *before* the viewer binds
// its handlers. Listeners on the same element fire in registration order
// regardless of the capture flag, so a capture listener on the canvas itself
// could not preempt it. We therefore listen in the capture phase on
// `#canvas-container` — a genuine ancestor — where `stopPropagation()` halts
// the event before it ever reaches the canvas at all.
//
// Invariant that keeps OrbitControls' pointer bookkeeping consistent: it must
// see a `pointerup` for every `pointerdown` it saw, and no others. Swallowing a
// lone `pointerup` would strand the pointer in its internal list and break
// every later gesture. Every branch below is written to preserve that.
// ─────────────────────────────────────────────────────────────────────────────
import { S } from './state.js';
import { t } from './i18n.js';
import { showToast } from './helpers.js';

const PREF_KEY = 'byrhinoview_pen_only_measure';
const SEEN_KEY = 'byrhinoview_pen_seen';

// Simultaneous finger count that counts as a deliberate navigation gesture
// rather than a stray contact.
const GESTURE_TOUCHES = 2;

// How long after the last stylus event the stylus still counts as "in use".
// While it is, even multi-touch is treated as palm and stays swallowed — a hand
// steadying the tablet must never dolly the view mid-measurement.
const PEN_BUSY_MS = 1000;

let _canvas = null;

// Last page position of every live touch pointer. OrbitControls reads pageX/
// pageY for touches, so a replayed pointerdown has to carry the real ones.
const _pos = new Map();
// Touch pointers we are swallowing.
const _blocked = new Set();
// Touch pointers handed over to OrbitControls as part of a gesture.
const _gesture = new Set();

// Set while we dispatch a replayed event, so our own filter lets it through.
let _replaying = false;

let _lastPenTime = -Infinity;

// The explanatory toast is shown once per session, on the first touch we eat,
// so the mode never looks like the viewer has frozen.
let _toastShown = false;

function _readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function _writePref(key, on) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch (e) {
    console.warn('Failed to save pen-input preference to localStorage:', e);
  }
}

/** True while any tool that places points by tapping the model is active. */
function _measuring() {
  return !!(S.distanceToolState || S.angleToolState || S.noteToolState);
}

function _penBusy() {
  return performance.now() - _lastPenTime < PEN_BUSY_MS;
}

/**
 * Is stylus-only input in force right now?
 *
 * All three must hold:
 *   1. the user has not turned the mode off,
 *   2. a stylus has been seen on this device (so a mouse-only or finger-only
 *      device is never silently robbed of its touch input),
 *   3. a measurement tool is active — outside measuring, fingers navigate.
 */
export function isPenOnlyActive() {
  return S.penOnlyMeasure && S.penDetected && _measuring();
}

export function setPenOnlyMeasure(on) {
  S.penOnlyMeasure = !!on;
  _writePref(PREF_KEY, S.penOnlyMeasure);
  // Deliberately not clearing _blocked/_gesture: pointers already in flight must
  // keep the disposition their pointerdown was given, or OrbitControls is left
  // holding a pointer that never lifts.
}

/** Remember that this device has a stylus, so the mode can arm itself. */
function _notePenSeen() {
  if (S.penDetected) return;
  S.penDetected = true;
  _writePref(SEEN_KEY, true);
}

function _announceOnce() {
  if (_toastShown) return;
  _toastShown = true;
  showToast(t('msg.pen_only_active'), { duration: 7000 });
}

function _dispatch(type, pointerId, p) {
  _replaying = true;
  try {
    _canvas.dispatchEvent(new PointerEvent(type, {
      pointerId,
      pointerType: 'touch',
      // pageX/pageY are derived from clientX/clientY, so undo the scroll offset
      // to land OrbitControls on the position we actually recorded.
      clientX: p ? p.pageX - window.scrollX : 0,
      clientY: p ? p.pageY - window.scrollY : 0,
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      isPrimary: true,
    }));
  } finally {
    _replaying = false;
  }
}

/**
 * A second finger landed: hand the whole contact set to OrbitControls so it can
 * run its pinch. The fingers we already swallowed are replayed first, in the
 * order they arrived, so OrbitControls sees a well-formed multi-touch sequence
 * before the triggering event reaches it under its own steam.
 */
function _promoteToGesture(triggerId) {
  const replay = [..._blocked].filter(id => id !== triggerId);
  for (const id of _blocked) _gesture.add(id);
  _blocked.clear();
  for (const id of replay) _dispatch('pointerdown', id, _pos.get(id));
}

/**
 * A finger left a gesture. OrbitControls answers a 2→1 drop by restarting as a
 * single-finger rotate on whatever is left (see its onPointerUp, case 1) — and
 * what is left may well be a palm. So retire the survivor from OrbitControls
 * too, and put it back under the filter.
 */
function _retireGesturePointer(endedId) {
  _gesture.delete(endedId);
  if (_gesture.size !== 1) return;

  const survivor = [..._gesture][0];
  _gesture.delete(survivor);
  _blocked.add(survivor);
  // Let OrbitControls finish handling the real pointerup first — we are still in
  // its capture phase, so it has not seen the event yet.
  queueMicrotask(() => _dispatch('pointerup', survivor, _pos.get(survivor)));
}

function _onCapture(e) {
  // A stylus event is never blocked — it only arms the mode and marks the
  // stylus as in use.
  if (e.pointerType === 'pen') {
    _lastPenTime = performance.now();
    _notePenSeen();
    return;
  }
  if (e.pointerType !== 'touch') return;  // mouse / trackpad pass through
  if (_replaying) return;                 // our own replay, on its way to the canvas

  const down  = e.type === 'pointerdown';
  const ended = e.type === 'pointerup' || e.type === 'pointercancel';

  if (ended) _pos.delete(e.pointerId);
  else       _pos.set(e.pointerId, { pageX: e.pageX, pageY: e.pageY });

  // Pointers already handed over belong to OrbitControls until they lift.
  if (_gesture.has(e.pointerId)) {
    if (ended) _retireGesturePointer(e.pointerId);
    return;
  }

  if (down) {
    if (!isPenOnlyActive()) return;
    _blocked.add(e.pointerId);
    if (_blocked.size >= GESTURE_TOUCHES && !_penBusy()) {
      _promoteToGesture(e.pointerId);
      return;  // this event carries on to the canvas as the gesture's last finger
    }
    _announceOnce();
  } else if (_blocked.has(e.pointerId)) {
    if (ended) _blocked.delete(e.pointerId);
  } else {
    // Its pointerdown came through, so its follow-ups must too.
    return;
  }

  e.stopPropagation();
  // Also suppress the compatibility mouse/click events the touch would
  // synthesise, which would otherwise reach the canvas by a second route.
  if (e.cancelable) e.preventDefault();
}

/**
 * Install the capture-phase filter. Call once, after the renderer's canvas has
 * been added to `#canvas-container`.
 */
export function initPenInput() {
  S.penOnlyMeasure = _readPref(PREF_KEY, true);   // on by default; inert until a stylus shows up
  S.penDetected    = _readPref(SEEN_KEY, false);

  const container = document.getElementById('canvas-container');
  _canvas = S.renderer?.domElement ?? container?.querySelector('canvas');
  if (!container || !_canvas) {
    console.warn('[pen-input] canvas not found — stylus-only mode disabled.');
    return;
  }

  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    container.addEventListener(type, _onCapture, { capture: true, passive: false });
  }

  // A stylus used anywhere in the UI counts as detection, so the mode is already
  // armed by the time the user opens the measurement panel.
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') { _lastPenTime = performance.now(); _notePenSeen(); }
  }, { capture: true, passive: true });

  const chk = document.getElementById('chk-measure-pen-only');
  if (chk) {
    chk.checked = S.penOnlyMeasure;
    chk.addEventListener('change', () => setPenOnlyMeasure(chk.checked));
  }
}
