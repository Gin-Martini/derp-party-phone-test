// js/ws.js — FULL FILE (watchdog + capped reconnects)
import { state } from './state.js';
import { WS_URL, backoff } from './config.js';
import { setPhase, setStatus, setLobbyVisible, setDbg, showToast } from './ui.js';
import { saveSession, clearSession } from './session.js';
import { onSocketMessage as _onSocketMessage } from './router.js';

const MAX_RECONNECT_ATTEMPTS = 6;

// ---- reconnect control ----
export function scheduleReconnect(reason){
  if (!state.shouldReconnect || !state.roomId || !state.playerId) return;

  // cap retries -> force clean rejoin to avoid "phantom room" state
  if ((state.reconnectAttempts|0) >= MAX_RECONNECT_ATTEMPTS) {
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
  state.shouldReconnect = false;
  state.reconnectAttempts = 0;
  if (state.reconnectTimer){ clearTimeout(state.reconnectTimer); state.reconnectTimer = 0; }
}

export function connectWs(){
  try {
    state.ws = new WebSocket(WS_URL);
    attachWsHandlers(state.ws);
  } catch {
    scheduleReconnect('ws construct failed');
  }
}

// ---- initial rehydrate helpers ----
function requestRehydrate(tag){
  setDbg('rehydrate:' + (tag||''));
  wsSend({ type:'REQUEST_SNAPSHOT' });
  wsSend({ type:'REQUEST_CATALOG' });
  wsSend({ type:'LOBBY_SNAPSHOT' });
}
function scheduleRehydrate(ms=900){
  if (state._rehydrateTimer) clearTimeout(state._rehydrateTimer);
  state._rehydrateTimer = setTimeout(()=>{
    const empty = !state.els.charGrid || state.els.charGrid.children.length === 0;
    requestRehydrate('timer1');
    if (empty) setTimeout(()=>{
      if (!state.els.charGrid || state.els.charGrid.children.length === 0) requestRehydrate('timer2');
    }, 1500);
  }, ms);
}

export function wsSend(obj){
  try { state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify(obj)); } catch(_){}
}

// ---- handlers ----
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

    // Start watchdog: if no first message lands quickly, assume dead session/room
    if (state._firstMsgWatch) clearTimeout(state._firstMsgWatch);
    state._firstMsgWatch = setTimeout(()=>{
      // If still no message, tear down and force a clean rejoin
      endSession('Session expired or room closed');
      clearSession();
      resetToLobbyUi();
      setStatus('Room missing/expired. Re-enter code.');
      showToast('Room not found or expired.');
    }, 4000);

    scheduleRehydrate(300);
  };

  sock.onmessage = (ev) => {
    // First actual message clears the watchdog
    if (state._firstMsgWatch) { clearTimeout(state._firstMsgWatch); state._firstMsgWatch = 0; }

    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    _onSocketMessage(msg);
  };

  sock.onerror = () => {
    setStatus('Socket error'); // visible until close fires
  };

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
      endSession(reason || `Closed (${code})`);
      return;
    }

    setStatus(`Disconnected (${code || '—'})`, true);
    if (state.shouldReconnect) {
      scheduleReconnect(`close ${code}`);
    } else {
      resetToLobbyUi();
    }
  };
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

// expose manual rehydrate for console debugging
if (typeof window !== 'undefined') {
  window.dpRehydrate = () => requestRehydrate('manual');
}
