// js/ws.js — phone WS layer (cycle-free)
import { state } from './state.js?v=11.0.1';
import { setPhase, setStatus, setLobbyVisible, showToast } from './ui.js?v=11.0.1';
import { saveSession, clearSession } from './session.js';

// ----- message router hook (set by router.js) -----
let _onSocketMessage = () => {};
export function setOnSocketMessage(fn){ _onSocketMessage = fn || (()=>{}); }

// ----- config -----
const WS_BASE = 'wss://derpparty-relay.fly.dev/socket';
const MAX_RECONNECT_ATTEMPTS = 6;

// ----- helpers -----
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
function backoff(i){ return Math.min(2000 + i*500, 6000); } // simple/local backoff

export function wsSend(obj){
  try {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  } catch(e){ console.log('wsSend error', e); }
}

export function cancelReconnect(){
  state.shouldReconnect = false;
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = 0; }
}
export function scheduleReconnect(reason){
  if (!state.shouldReconnect || !state.roomId || !state.playerId) return;

  if ((state.reconnectAttempts|0) >= MAX_RECONNECT_ATTEMPTS) {
    endSession('Rejoin required');
    clearSession();
    resetToLobbyUi();
    setStatus('Please re-enter the room code.');
    showToast('Connection expired. Rejoin the room.');
    return;
  }
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = backoff(state.reconnectAttempts|0);
  setStatus(`Reconnecting… (${reason || 'lost connection'})`, true);
  state.reconnectTimer = setTimeout(()=> {
    state.reconnectAttempts = (state.reconnectAttempts|0) + 1;
    connectWs();
  }, delay);
}

function requestRehydrate(tag){
  // ask host for current lobby + catalog (host understands any of these)
  wsSend({ type:'REQUEST_SNAPSHOT', tag });
  wsSend({ type:'REQUEST_CATALOG', tag });
}
function scheduleRehydrate(ms){ if (ms <= 0) requestRehydrate('schedule0'); else setTimeout(()=>requestRehydrate('schedule'), ms); }

// ----- connect -----
export function connectWs(){
  try { if (state.ws) { try { state.ws.close(); } catch {} } } catch {}
  const url = buildWsUrl();
  const sock = new WebSocket(url);
  state.ws = sock;

  sock.onopen = () => {
    try {
      wsSend({ type:'HELLO', roomId: state.roomId, playerId: state.playerId,
               name: (state.els.nameInput?.value||'').trim() || 'Player' });
    } catch {}

    setStatus('Connected.', true);
    state.els.joinCard?.classList.add('hidden');
    setLobbyVisible(true);
    saveSession();

    clearInterval(state.hbInterval);
    state.hbInterval = setInterval(()=> wsSend({ type:'PING' }), 5000);

    if (state._firstMsgWatch) clearTimeout(state._firstMsgWatch);
    state._firstMsgWatch = setTimeout(()=>{
      endSession('Session expired or room closed');
      clearSession();
      resetToLobbyUi();
      setStatus('Room missing/expired. Re-enter code.');
      showToast('Room not found or expired.');
    }, 4000);

    scheduleRehydrate(300);
  };

  sock.onmessage = (ev) => {
    if (state._firstMsgWatch) { clearTimeout(state._firstMsgWatch); state._firstMsgWatch = 0; }
    let msg = null; try { msg = JSON.parse(ev.data); } catch { return; }
    try { _onSocketMessage(msg); } catch(e) { console.error('router error', e); }
  };

  sock.onerror = (e) => {
    console.log('WS error', e);
    setStatus('Connection problem'); showToast('Connection problem.');
  };

  sock.onclose = (e) => {
    console.log('WS closed', e?.code, e?.reason);
    if (state.shouldReconnect) scheduleReconnect('socket closed');
  };
}

// ----- lifecycle helpers used elsewhere -----
export function endSession(reason){
  state.shouldReconnect = false;
  if (state.hbInterval) { clearInterval(state.hbInterval); state.hbInterval = 0; }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = 0; }
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
if (typeof window !== 'undefined') window.dpRehydrate = () => requestRehydrate('manual');
