import { state } from './state.js';
import { STORAGE_KEY, ROOM_HINT, NAME_HINT } from './config.js';
// If your UI exports setStatus, import it; otherwise replace with console.log
import { setStatus } from './ui.js';

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
    setStatus?.('No WS URL; join first.') ?? console.log('No WS URL; join first.');
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(state.session.wsUrl);
  } catch (e) {
    setStatus?.('Bad WS URL') ?? console.log('Bad WS URL');
    return;
  }

  setStatus?.('Connecting…') ?? console.log('Connecting…');

  ws.onopen = () => {
    state.connected = true;
    setStatus?.('Connected') ?? console.log('Connected');
    identify(); // now includes room/name hints for relay-direct flow
  };

  ws.onclose = () => {
    state.connected = false;
    setStatus?.('Disconnected') ?? console.log('Disconnected');
  };

  ws.onerror = () => {
    setStatus?.('WS error') ?? console.log('WS error');
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    // Store last sequence if present
    if (typeof msg.seq === 'number') state.lastSeq = msg.seq;

    // Hand off to your reducer/router (if any)
    if (window.reduceEnvelope) {
      window.reduceEnvelope(msg);
    } else {
      // Fallback: basic logging
      if (msg?.type === 'STATE') state.phase = msg?.payload?.phase || state.phase;
      console.log('[WS] <-', msg.type, msg);
    }
  };
}

function identify() {
  // Send enough context for host to treat this as a join in direct-WS mode.
  const roomId  = state.session?.roomId || ROOM_HINT || undefined;
  const playerId = state.session?.playerId || undefined;
  const token   = state.session?.token || undefined;
  const name    = NAME_HINT || undefined;

  if (!roomId && !token) return; // nothing useful

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

export function saveDirectWsSession({ wsUrl, roomId='', playerId='', token='' }) {
  saveSession({ wsUrl, roomId, playerId, token });
}
