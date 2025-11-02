// js/ws.js — thin WS client with IDENTIFY + legacy HELLO and robust normalizer
import { state } from './state.js';
import { SESSION_KEY, ROOM_HINT, NAME_HINT } from './config.js';
import { setStatus } from './views/ui.js';

let ws = null;

function sessionFromStorage() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

export function saveSession(sess) {
  state.session = sess;
  localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
}

export function hasStoredSession() {
  return !!sessionFromStorage();
}

export function loadStoredSession() {
  const s = sessionFromStorage();
  if (s) state.session = s;
  return s;
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  state.session = null;
}

export function wsConnect() {
  if (!state.session?.wsUrl) { setStatus('No WS URL; join first.'); return; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try { ws = new WebSocket(state.session.wsUrl); }
  catch { setStatus('Bad WS URL'); return; }

  setStatus('Connecting…');

  ws.onopen = () => {
    state.connected = true;
    setStatus('Connected');
    // Send modern IDENTIFY and multiple low-risk legacy join triggers
    identify();
    legacyHelloSuite();
  };

  ws.onclose = () => { state.connected = false; setStatus('Disconnected'); };
  ws.onerror  = () => setStatus('WS error');

  ws.onmessage = (ev) => {
    let raw; try { raw = JSON.parse(ev.data); } catch { return; }
    if (!raw || typeof raw !== 'object') return;

    const msg = normalize(raw);
    if (!msg || !msg.type) return;
    if (typeof msg.seq === 'number') state.lastSeq = msg.seq;

    if (window.reduceEnvelope) window.reduceEnvelope(msg);
  };
}

function identify() {
  const roomId   = state.session?.roomId || ROOM_HINT || undefined;
  const playerId = state.session?.playerId || undefined;
  const token    = state.session?.token || undefined;
  const name     = state.session?.displayName || NAME_HINT || undefined;
  if (!roomId) return;

  send({ v:1, type:'IDENTIFY', roomId, playerId, payload:{ token, lastSeq: state.lastSeq || 0, name, role:'player' } });
}

// Fire a few harmless verbs; host will ignore what it doesn’t know.
function legacyHelloSuite() {
  const name = state.session?.displayName || NAME_HINT || 'Player';
  send({ v:1, type:'HELLO',    value:name });   // common path to create player
  send({ v:1, type:'SET_NAME', value:name });   // some stacks use this
  send({ v:1, type:'JOIN',     payload:{ name }}); // extra nudge if router expects JOIN
}

export function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

// Normalize host shapes → { type, seq, payload }
// Accept: canonical envelope, C# StateEnvelope`1, and bare STATE (no payload).
function normalize(raw) {
  // Canonical already
  if (raw && (raw.payload || raw.type === 'STATE' || raw.type === 'ROLL_PROMPT' || raw.type === 'ROLL_RESULT' || raw.type === 'SCREEN' || raw.type === 'ERROR')) {
    // Bare STATE fallback: host sent fields at top-level (no payload)
    if (raw.type === 'STATE' && !raw.payload && (raw.phase || raw.me || raw.lobby)) {
      return { v: raw.v || 1, type:'STATE', seq: raw.seq || 0, payload: raw };
    }
    return raw;
  }

  // Generic C# envelope class name (e.g., "StateEnvelope`1")
  if (String(raw?.type).startsWith('StateEnvelope')) {
    const inner = raw.payload || {};
    return {
      v: inner.v || 1,
      type: inner.type || 'STATE',
      seq: raw.seq ?? inner.seq ?? 0,
      payload: inner.payload ?? inner
    };
  }

  // Last-ditch heuristic: looks like a snapshot but has no type
  if (raw && (raw.phase || raw.me || raw.lobby)) {
    return { v: 1, type:'STATE', seq: raw.seq || 0, payload: raw };
  }

  return null;
}
