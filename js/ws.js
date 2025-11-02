// js/ws.js — thin WS client with IDENTIFY
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
  if (!state.session?.wsUrl) {
    setStatus('No WS URL; join first.');
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try { ws = new WebSocket(state.session.wsUrl); }
  catch { setStatus('Bad WS URL'); return; }

  setStatus('Connecting…');

  ws.onopen = () => {
    state.connected = true;
    setStatus('Connected');
    identify();
  };

  ws.onclose = () => {
    state.connected = false;
    setStatus('Disconnected');
  };

  ws.onerror = () => setStatus('WS error');

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    if (typeof msg.seq === 'number') state.lastSeq = msg.seq;

    // Hand off to reducer
    if (window.reduceEnvelope) window.reduceEnvelope(msg);
  };
}

function identify() {
  // Send enough for host to synthesize PLAYER_JOINED on relay-direct path
  const roomId   = state.session?.roomId || ROOM_HINT || undefined;
  const playerId = state.session?.playerId || undefined;
  const token    = state.session?.token || undefined;
  const name     = state.session?.displayName || NAME_HINT || undefined;

  if (!roomId) return;

  send({
    v: 1,
    type: 'IDENTIFY',
    roomId,
    playerId,
    payload: { token, lastSeq: state.lastSeq || 0, name, role: 'player' }
  });
}

export function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

export function saveDirectWsSession({ wsUrl, roomId='', playerId='', token='', displayName='' }) {
  saveSession({ wsUrl, roomId, playerId, token, displayName });
}
