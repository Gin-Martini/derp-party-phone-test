import { state } from './state.js';
import { STORAGE_KEY } from './config.js';
import { setStatus } from './views/ui.js';
import { reduceEnvelope } from './store.js';

let ws = null;

function sessionFromStorage() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch { return null; }
}

export function saveSession(sess) {
  state.session = sess;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sess));
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
  localStorage.removeItem(STORAGE_KEY);
  state.session = null;
}

export function wsConnect() {
  if (!state.session?.wsUrl) {
    setStatus('No WS URL; join first.');
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(state.session.wsUrl);
  } catch (e) {
    setStatus(`Bad WS URL`);
    return;
  }

  setStatus('Connecting…');

  ws.onopen = () => {
    state.connected = true;
    setStatus('Connected');
    identify(); // optional; no-op if we lack token/ids
  };

  ws.onclose = () => {
    state.connected = false;
    setStatus('Disconnected');
  };

  ws.onerror = () => {
    setStatus('WS error');
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    reduceEnvelope(msg);
  };
}

function identify() {
  // IDENTIFY is optional. Only send if we actually have data.
  const hasToken   = !!state.session?.token;
  const hasIds     = !!state.session?.roomId && !!state.session?.playerId;
  if (!hasToken && !hasIds) return;

  send({
    v:1, type:'IDENTIFY',
    roomId: state.session.roomId || undefined,
    playerId: state.session.playerId || undefined,
    payload: { token: state.session.token || undefined, lastSeq: state.lastSeq || 0 }
  });
}

export function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

export function saveDirectWsSession({ wsUrl, roomId='', playerId='', token='' }) {
  saveSession({ wsUrl, roomId, playerId, token });
}
