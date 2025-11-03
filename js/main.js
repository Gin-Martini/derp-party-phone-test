// js/main.js — click Join → build ws URL → save session → connect
import { state } from './state.js';
import { API_BASE, WS_BASE, ROOM_HINT, NAME_HINT } from './config.js';
import { setStatus, bindJoinUI, showJoin, setLobbyVisible, setResumeAvailable, setJoinFields } from './views/ui.js';
import { reduceEnvelope } from './store.js';
import { wsConnect, saveDirectWsSession, hasStoredSession, loadStoredSession } from './ws.js';

// expose reducer for ws.js callback
window.reduceEnvelope = reduceEnvelope;

// ----- boot UI (do NOT show lobby yet) -----
setStatus('Disconnected');
setLobbyVisible(false);
showJoin(true);
setResumeAvailable(null);

bindJoinUI({
  onJoin: onJoinClicked,
  onResume: tryResume,
  onReadyClick: () => {},
  onRollClick:  () => {},
  onCloseRoll:  () => {}
});

const storedSession = hasStoredSession() ? loadStoredSession() : null;

setJoinFields({
  room: ROOM_HINT || storedSession?.roomId || '',
  name: NAME_HINT || storedSession?.displayName || '',
});

// If link pre-fills room/name, move straight to connect
if (ROOM_HINT) {
  const wsUrl = `${WS_BASE}?room=${encodeURIComponent(ROOM_HINT)}&role=player`;
  saveDirectWsSession({ wsUrl, roomId: ROOM_HINT, displayName: NAME_HINT || '' });
  showJoin(false);
  wsConnect();
} else if (storedSession) {
  setResumeAvailable(storedSession);
  setStatus('Tap Resume to rejoin or enter a new room code.');
}

async function onJoinClicked(e){
  e?.preventDefault?.();
  const roomInput = document.querySelector('#roomCode');
  const nameInput = document.querySelector('#playerName');
  const roomCode = (roomInput?.value || '').trim().toUpperCase();
  const name = (nameInput?.value || '').trim();

  if (!roomCode || !name) { setStatus('Enter room code + name.'); return; }

  const wsUrl = `${WS_BASE}?room=${encodeURIComponent(roomCode)}&role=player`;
  saveDirectWsSession({ wsUrl, roomId: roomCode, displayName: name });
  showJoin(false);
  wsConnect();
}

function tryResume(){
  if (!hasStoredSession()) return;
  loadStoredSession();
  showJoin(false);
  wsConnect();
}
