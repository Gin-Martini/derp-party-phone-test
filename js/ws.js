// js/ws.js — phone WS layer (fixed watchdog; no UI thrash on slow host)
import { state } from './state.js?v=11.0.12';
import { setPhase, setStatus, setLobbyVisible, showToast, resetToLobbyUi } from './ui.js?v=11.0.12';
import { saveSession, clearSession } from './session.js?v=11.0.12';
import { TERMINAL_CLOSE_CODES } from './config.js?v=11.0.12';

const TERMINAL_CLOSE_REASON_PATTERNS = [
  /room\s+(closed|missing|not\s+found|expired)/i,
  /(session|player)\s+(expired|missing|unknown)/i,
  /rejoin\s+required/i,
  /forbidden/i
];

function isTerminalClose(ev){
  const code = Number(ev?.code) || 0;
  if (code && TERMINAL_CLOSE_CODES?.has?.(code)) return true;
  if (code >= 4400) return true; // relay policy/auth codes
  const reason = (ev?.reason || '').trim();
  if (!reason) return false;
  return TERMINAL_CLOSE_REASON_PATTERNS.some((re) => re.test(reason));
}

// message router hook (set by router.js)
let _onSocketMessage = () => {};
let _boundRouterHandler = null;
export function setOnSocketMessage(fn){
  const handler = fn || (()=>{});
  if (_boundRouterHandler === handler) return;
  _boundRouterHandler = handler;
  _onSocketMessage = handler;
}

// config
const WS_BASE = 'wss://derpparty-relay.fly.dev/socket';
const MAX_RECONNECT_ATTEMPTS = 6;

// helpers
function buildWsUrl() {
  const room = String(state.roomId || '').trim().toUpperCase();
  const name = (state.els.nameInput?.value || 'Player').trim() || 'Player';
  const qs = new URLSearchParams({
    room,
    role: 'player',
    playerId: String(state.playerId || '').trim(),
    name
  });
  return `${WS_BASE}?${qs}`;
}
function backoff(i){ return Math.min(2000 + i*500, 6000); }

export function wsSend(obj){
  try { if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj)); } catch(_){}
}
export function sendIntent(intentType, payload = {}){
  if (!intentType) return;
  const msg = { type: 'INTENT', intent: intentType, kind: 'INTENT', ...payload };
  wsSend(msg);
}

// reconnect control
export function scheduleReconnect(reason){
  if (!state.shouldReconnect || !state.roomId || !state.playerId) return;

  if ((state.reconnectAttempts|0) >= MAX_RECONNECT_ATTEMPTS){
    endSession('Rejoin required');
    clearSession();
    resetToLobbyUi();
    setStatus('Please re-enter the room code.');
    showToast('Connection expired. Rejoin the room.');
    return;
  }

  setStatus(`Reconnecting… (${reason || 'lost connection'})`, true);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const wait = backoff(state.reconnectAttempts++);
  state.reconnectTimer = setTimeout(()=>{ state.reconnectTimer = 0; connectWs(); }, wait);
}
export function cancelReconnect(){
  state.shouldReconnect = false; state.reconnectAttempts = 0;
  if (state.reconnectTimer){ clearTimeout(state.reconnectTimer); state.reconnectTimer = 0; }
}

// rehydrate helpers
const REHYDRATE_MIN_INTERVAL_MS = 1400;

function hasCatalogContent(){
  if (Array.isArray(state._pendingCatalog) && state._pendingCatalog.length) return true;
  if (Array.isArray(state.catalog?.entries) && state.catalog.entries.length) return true;
  const grid = state.els.charGrid;
  if (grid && grid.querySelector('.charBtn')) return true;
  return false;
}

function shouldSkipHydrate(){
  const knownVersion = state.catalogVersion ?? null;
  const hydratedVersion = state._hydratedVersion ?? null;
  if (state.hydrated && (!knownVersion || hydratedVersion === knownVersion)) return true;
  if (state._rehydrateRequested && (!knownVersion || state._rehydrateRequestedVersion === knownVersion)) return true;
  return false;
}

function requestRehydrate(arg){
  const opts = typeof arg === 'object' && arg !== null ? arg : { force: !!arg };
  const force = !!opts.force;

  if (!state.hydrated && hasCatalogContent()) {
    state.hydrated = true;
    if (!state._hydratedVersion) state._hydratedVersion = state.catalogVersion ?? null;
  }

  const now = Date.now();
  if (!force) {
    if (shouldSkipHydrate()) return;
    if (state._lastRehydrateAt && (now - state._lastRehydrateAt) < REHYDRATE_MIN_INTERVAL_MS) return;
  }

  state._lastRehydrateAt = now;
  state._rehydrateRequested = true;
  state._rehydrateRequestedVersion = state.catalogVersion ?? null;

  wsSend({ type:'REQUEST_SNAPSHOT' });
  wsSend({ type:'REQUEST_CATALOG' });
}

export function ensureHydrateRequest(options = {}){
  requestRehydrate(options);
}

function scheduleRehydrate(ms=900){
  if (state._rehydrateTimer) clearTimeout(state._rehydrateTimer);
  state._rehydrateTimer = setTimeout(()=>{
    state._rehydrateTimer = 0;
    try { _onSocketMessage({ type: 'WS_RETRY' }); } catch (_) {}
  }, ms);
}

// connect
export function connectWs(){
  const room = String(state.roomId || '').trim();
  const player = String(state.playerId || '').trim();
  if (!room || !player) {
    try { setStatus('Waiting to join…'); } catch {}
    state.shouldReconnect = false;
    return;
  }

  state.hydrated = false;
  state._hydratedVersion = null;
  state._rehydrateRequested = false;
  state._rehydrateRequestedVersion = null;
  if (state._rehydrateTimer) { clearTimeout(state._rehydrateTimer); state._rehydrateTimer = 0; }

  try { if (state.ws) { try { state.ws.close(); } catch {} } } catch {}
  const sock = new WebSocket(buildWsUrl());
  state.ws = sock;

  sock.onopen = () => {
    try {
      wsSend({
        type: 'HELLO_PLAYER',
        roomId: state.roomId,
        playerId: state.playerId,
        name: (state.els.nameInput?.value||'').trim() || 'Player'
      });
    } catch {}

    setStatus('Connected.', true);
    saveSession();

    clearInterval(state.hbInterval);
    state.hbInterval = setInterval(()=> wsSend({ type:'PING' }), 5000);

    if (state._firstMsgWatch) clearTimeout(state._firstMsgWatch);
    // Less aggressive watchdog: if we already have lobby content, don't tear it down.
    state._firstMsgWatch = setTimeout(()=>{
      const hasGrid = !!(state.els.charGrid && state.els.charGrid.children.length);
      if (state.hydrated || hasGrid) {
        setStatus('Waiting for host…');   // non-destructive
        scheduleRehydrate(1200);
        return;
      }
      endSession('Session expired or room closed');
      clearSession();
      resetToLobbyUi();
      setStatus('Room missing/expired. Re-enter code.');
      showToast('Room not found or expired.');
    }, 12000);

    setTimeout(() => {
      try { _onSocketMessage({ type: 'WS_OPEN' }); } catch (_) {}
    }, 300);
  };

  sock.onmessage = async (ev) => {
    if (state._firstMsgWatch) { clearTimeout(state._firstMsgWatch); state._firstMsgWatch = 0; }

    let payload = ev?.data;
    try {
      if (payload instanceof Blob) {
        payload = await payload.text();
      } else if (payload instanceof ArrayBuffer) {
        payload = new TextDecoder().decode(payload);
      }

      if (typeof payload === 'string') {
        const trimmed = payload.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { payload = JSON.parse(trimmed); }
          catch { payload = trimmed; }
        } else {
          payload = trimmed;
        }
      }
    } catch (err) {
      console.warn('ws message decode failed', err);
      payload = ev?.data ?? null;
    }

    try { _onSocketMessage(payload); }
    catch(e) { console.error('router error', e); }
  };

  sock.onerror = () => { setStatus('Connection problem'); showToast('Connection problem.'); };

  sock.onclose = (ev) => {
    const code = Number(ev?.code) || 0;
    if (isTerminalClose(ev)) {
      const fallback = code ? `Room closed (${code}). Re-enter code.` : 'Room closed. Re-enter code.';
      const msg = (ev?.reason || '').trim() || fallback;
      endSession('Room closed');
      clearSession();
      resetToLobbyUi();
      setStatus(msg);
      showToast(msg);
      return;
    }
    if (state.shouldReconnect) {
      const label = code ? `socket closed (${code})` : 'socket closed';
      scheduleReconnect(label);
    }
  };
}

// teardown used by scheduleReconnect / terminal close
function endSession(reason='Disconnected'){
  state.shouldReconnect = false;
  if (state.hbInterval) { clearInterval(state.hbInterval); state.hbInterval = 0; }
  if (state.reconnectTimer){ clearTimeout(state.reconnectTimer); state.reconnectTimer = 0; }
  state.reconnectAttempts = 0;
  try { wsSend({ type:'GOODBYE' }); } catch {}
  try { state.ws && state.ws.close(); } catch {}
  state.ws = null;

  setStatus(reason);
  setPhase('lobby');
  setLobbyVisible(false);
  state.els.joinCard?.classList.remove('hidden');
}

// console helper
if (typeof window !== 'undefined') window.dpRehydrate = (force = true) => requestRehydrate({ force });
