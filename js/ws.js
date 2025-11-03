// js/ws.js — thin WS client with IDENTIFY + legacy HELLO
import { state } from './state.js';
import { SESSION_KEY, ROOM_HINT, NAME_HINT } from './config.js';
import { setStatus, setResumeAvailable } from './views/ui.js';

let ws = null;

function sessionFromStorage() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

export function saveSession(sess) {
  state.session = sess;
  localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
}

export function hasStoredSession() { return !!sessionFromStorage(); }
export function loadStoredSession() { const s = sessionFromStorage(); if (s) state.session = s; return s; }
export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  state.session = null;
  state.lastSeq = 0;
  state.phase = 'disconnected';
  state.me = null;
  state.lobby = null;
  state.rollPrompt = null;
  state.rollResults = null;
  state.lastScreen = null;
  setResumeAvailable(null);
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
    // Send both: modern IDENTIFY and legacy HELLO to trigger host join path
    identify();
    legacyHello();
  };

  ws.onclose = () => { state.connected = false; setStatus('Disconnected'); };
  ws.onerror  = () => setStatus('WS error');

  ws.onmessage = (ev) => {
    let raw; try { raw = JSON.parse(ev.data); } catch { return; }
    if (!raw || typeof raw !== 'object' || !raw.type) return;

    const msg = normalize(raw);

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

// Lowest-risk legacy join trigger
function legacyHello() {
  const name = state.session?.displayName || NAME_HINT || 'Player';
  send({ v:1, type:'HELLO', value:name });
  send({ v:1, type:'SET_NAME', value:name });
}

export function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

export function saveDirectWsSession({ wsUrl, roomId='', playerId='', token='', displayName='' }) {
  saveSession({ wsUrl, roomId, playerId, token, displayName });
}

// Normalize various host shapes (bare DTOs, envelopes) into {type,seq,payload}
function normalize(raw) {
  // canonical or adjacent
  if (raw.payload || raw.type === 'STATE' || raw.type === 'BROADCAST_STATE' ||
      raw.type === 'ROLL_PROMPT' || raw.type === 'ROLL_RESULT' || raw.type === 'SCREEN' || raw.type === 'ERROR') {
    return raw.type === 'BROADCAST_STATE' ? { ...raw, type:'STATE' } : raw;
  }
  // Envelope class name from C# generic (e.g., "StateEnvelope`1")
  if (String(raw.type).startsWith('StateEnvelope')) {
    const inner = raw.payload || {};
    return {
      v: inner.v || 1,
      type: inner.type || 'STATE',
      seq: raw.seq ?? inner.seq ?? 0,
      payload: inner.payload ?? inner
    };
  }
  return raw;
}
