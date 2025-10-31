// js/ws.js — phone WS layer (fixed handshake)
import { state } from './state.js';
import { setPhase, setStatus, setLobbyVisible, showToast } from './ui.js';
import { saveSession, clearSession } from './session.js';

// message router hook (set by router.js)
let _onSocketMessage = () => {};
export function setOnSocketMessage(fn){ _onSocketMessage = fn || (()=>{}); }

// config
const WS_BASE = 'wss://derpparty-relay.fly.dev/socket';
const MAX_RECONNECT_ATTEMPTS = 6;

// helpers
function buildWsUrl() {
  const room = String(state.roomId || '').trim().toUpperCase();
  const name = (state.els.nameInput?.value || 'Player').trim() || 'Player';
  const qs = new URLSearchParams({
    room,
    role: 'player',                    // <- must be 'player'
    playerId: String(state.playerId || '').trim(),  // <- required
    name
  });
  return `${WS_BASE}?${qs}`;
}
function backoff(i){ return Math.min(2000 + i*500, 6000); }

export function wsSend(obj){
  try { if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj)); } catch(_){}
}

// reconnect control
export function scheduleReconnect(reason){
  if (!state.shouldReconnect || !state.roomId || !state.playerId) return;
  if ((state.reconnectAttempts|0) >= MAX_RECONNECT_ATTEMPTS){
    endSession('Rejoin required'); clearSession(); resetToLobbyUi();
    setStatus('Please re-enter the room code.'); showToast('Connection expired. Rejoin the room.'); return;
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
function requestRehydrate(){
  wsSend({ type:'REQUEST_SNAPSHOT' });
  wsSend({ type:'REQUEST_CATALOG' });
  wsSend({ type:'LOBBY_SNAPSHOT' });
}
function scheduleRehydrate(ms=900){
  if (state._rehydrateTimer) clearTimeout(state._rehydrateTimer);
  state._rehydrateTimer = setTimeout(()=>{
    const empty = !state.els.charGrid || state.els.charGrid.children.length === 0;
    requestRehydrate();
    if (empty) setTimeout(()=>{ if (!state.els.charGrid || state.els.charGrid.children.length === 0) requestRehydrate(); }, 1500);
  }, ms);
}

// connect
export function connectWs(){
  try { if (state.ws) { try { state.ws.close(); } catch {} } } catch {}
  const sock = new WebSocket(buildWsUrl());
  state.ws = sock;

  sock.onopen = () => {
    try {
      wsSend({
        type: 'HELLO_PLAYER',          // <- must be HELLO_PLAYER
        roomId: state.roomId,
        playerId: state.playerId,
        name: (state.els.nameInput?.value||'').trim() || 'Player'
      });
    } catch {}

    setStatus('Connected.', true);
    state.els.joinCard?.classList.add('hidden');
    setLobbyVisible(true);
    saveSession();

    clearInterval(state.hbInterval);
    state.hbInterval = setInterval(()=> wsSend({ type:'PING' }), 5000);

    if (state._firstMsgWatch) clearTimeout(state._firstMsgWatch);
    state._firstMsgWatch = setTimeout(()=>{
      endSession('Session expired or room closed'); clearSession(); resetToLobbyUi();
      setStatus('Room missing/expired. Re-enter code.'); showToast('Room not found or expired.');
    }, 4000);

    scheduleRehydrate(300);
  };

  sock.onmessage = (ev) => {
    if (state._firstMsgWatch) { clearTimeout(state._firstMsgWatch); state._firstMsgWatch = 0; }
    let msg = null; try { msg = JSON.parse(ev.data); } catch { return; }
    try { _onSocketMessage(msg); } catch(e) { console.error('router error', e); }
  };

  sock.onerror = () => { setStatus('Connection problem'); showToast('Connection problem.'); };

  sock.onclose = () => { if (state.shouldReconnect) scheduleReconnect('socket closed'); };
}

// teardown used by scheduleReconnect
function endSession(reason='Disconnected'){
  state.shouldReconnect = false;
  if (state.hbInterval) { clearInterval(state.hbInterval); state.hbInterval = 0; }
  if (state.reconnectTimer){ clearTimeout(state.reconnectTimer); state.reconnectTimer = 0; }
  state.reconnectAttempts = 0;
  try { wsSend({ type:'GOODBYE' }); } catch {}
  try { state.ws && state.ws.close(); } catch {}
  state.ws = null;

  setStatus(reason); setPhase('lobby'); setLobbyVisible(false);
  state.els.joinCard?.classList.remove('hidden');
}

// console helper
if (typeof window !== 'undefined') window.dpRehydrate = () => requestRehydrate();
