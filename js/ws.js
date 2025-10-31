// js/ws.js — phone WS layer (cycle-free)
import { state } from './state.js?v=11.0.1';
import { setPhase, setStatus, setLobbyVisible, showToast } from './ui.js?v=11.0.1';
import { saveSession, clearSession } from './session.js';

// ----- message router hook (set by router.js) -----
let _onSocketMessage = () => {};
export function setOnSocketMessage(fn) { _onSocketMessage = fn || (()=>{}); }

// ----- config -----
const WS_BASE = 'wss://derpparty-relay.fly.dev/socket';
const MAX_RECONNECT_ATTEMPTS = 6;

// ----- helpers -----
function buildWsUrl() {
  const room = String(state.roomId || '').trim().toUpperCase();
  const name = (state.els.nameInput?.value || 'Player').trim() || 'Player';
  const pid  = String(state.playerId || '').trim();
  const qs = new URLSearchParams({ room, role: 'player', playerId: pid, name });
  return `${WS_BASE}?${qs}`;
}
function backoff(i){ return Math.min(2000 + i*500, 6000); } // simple/local backoff

export function wsSend(obj){
  try { state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify(obj)); } catch(_){}
}

// ----- reconnect control -----
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
  const wait = backoff(state.reconnectAttempts++);
  state.reconnectTimer = setTimeout(()=>{ state.reconnectTimer = 0; connectWs(); }, wait);
}
export function cancelReconnect(){
  state.shouldReconnect = false;
  state.reconnectAttempts = 0;
  if (state.reconnectTimer){ clearTimeout(state.reconnectTimer); state.reconnectTimer = 0; }
}

// ----- connect -----
export function connectWs(){
  try {
    state.ws = new WebSocket(buildWsUrl());
    attachWsHandlers(state.ws);
  } catch {
    scheduleReconnect('ws construct failed');
  }
}

// ----- initial rehydrate helpers -----
function requestRehydrate(tag){
  wsSend({ type:'REQUEST_SNAPSHOT' });
  wsSend({ type:'REQUEST_CATALOG' });
  wsSend({ type:'LOBBY_SNAPSHOT' });
}
function scheduleRehydrate(ms=900){
  if (state._rehydrateTimer) clearTimeout(state._rehydrateTimer);
  state._rehydrateTimer = setTimeout(()=>{
    const empty = !state.els.charGrid || state.els.charGrid.children.length === 0;
    if (empty) requestRehydrate('timer1');
    setTimeout(()=>{
      if (!state.els.charGrid || state.els.charGrid.children.length === 0) requestRehydrate('timer2');
    }, 1500);
  }, ms);
}

// ----- handlers -----
function attachWsHandlers(sock){
  sock.onopen = () => {
    try {
      sock.send(JSON.stringify({
        type:'HELLO_PLAYER',
        roomId: state.roomId,
        playerId: state.playerId,
        name: (state.els.nameInput?.value||'').trim() || 'Player'
      }));
    } catch {}

    setStatus('Connected.', true);
    state.els.joinCard?.classList.add('hidden');
    setLobbyVisible(true);
    saveSession();

    clearInterval(state.hbInterval);
    state.hbInterval = setInterval(()=> wsSend({ type:'PING' }), 5000);

    if (state._firstMsgWatch) clearTimeout(state._firstMsgWatch);
    state._firstMsgWatch = setTimeout(()=>{
      setStatus('Connected. Waiting for host...');
      ensureOpenRoomOrReset();
      scheduleRehydrate(300);
    }, 1200);
  };

  sock.onmessage = (ev) => {
    if (state._firstMsgWatch) { clearTimeout(state._firstMsgWatch); state._firstMsgWatch = 0; }
    let msg = null; try { msg = JSON.parse(ev.data); } catch { return; }
    try { _onSocketMessage(msg); } catch(e) { console.error('router error', e); }
  };

  sock.onerror = () => { setStatus('Socket error'); };

  sock.onclose = (e) => {
    try { clearInterval(state.hbInterval); } catch {}
    clearInterval(state.hbInterval);
    if (state._firstMsgWatch) { clearTimeout(state._firstMsgWatch); state._firstMsgWatch = 0; }
    state.triviaAllowed = null; state.triviaMode = 'PENDING';
    if (state._terminal) return;

    const code = Number(e.code || 0);
    const reason = String(e.reason || '').toUpperCase();
    const looksTerminal =
      reason.includes('ROOM_CLOSED') ||
      reason.includes('SESSION') ||
      reason.includes('KICK') ||
      reason.includes('EXPIRE') ||
      reason.includes('FORBIDDEN') ||
      reason.includes('UNAUTHORIZED');

    if (looksTerminal) {
      endSession(reason || 'Session closed');
      clearSession();
      resetToLobbyUi();
      setStatus('Please re-enter the room code.');
      showToast('Room closed or session ended.');
      return;
    }

    if (state.shouldReconnect) scheduleReconnect(`close ${code}`); else resetToLobbyUi();
  };
}

function ensureOpenRoomOrReset(){
  // if we don’t see catalog/cards within a few seconds, assume stale room
  if (state._roomGuard) clearTimeout(state._roomGuard);
  state._roomGuard = setTimeout(()=>{
    const looksEmpty = !state.catalog || !Array.isArray(state.catalog.entries) || state.catalog.entries.length === 0;
    if (looksEmpty) {
      endSession('Room missing/expired');
      clearSession();
      resetToLobbyUi();
      setStatus('Room missing/expired. Re-enter code.');
      showToast('Room not found or expired.');
    }
  }, 4000);
  scheduleRehydrate(300);
}

export function resetToLobbyUi(){
  setPhase('lobby');
  setLobbyVisible(false);
  state.els.joinCard?.classList.remove('hidden');
  state.els.rollBtn?.classList.add('hidden');
}

export function endSession(reason='Session ended'){
  try { state._terminal = true; } catch {}
  try { clearInterval(state.hbInterval); } catch {}
  clearInterval(state.hbInterval);
  if (state._firstMsgWatch) { clearTimeout(state._firstMsgWatch); state._firstMsgWatch = 0; }
  state.triviaAllowed = null; state.triviaMode = 'PENDING';

  state.shouldReconnect = false;
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
