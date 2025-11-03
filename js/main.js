// js/main.js — phone bootstrap (cache-busted imports, auto-join)
import { state } from './state.js?v=11.0.13';
import { API_BASE, WS_BASE, ROOM_HINT, NAME_HINT } from './config.js?v=11.0.13';
import { setStatus, bindJoinUI, showJoin, setLobbyVisible, setResumeAvailable, setJoinFields } from './views/ui.js?v=11.0.13';
import { reduceEnvelope } from './store.js?v=11.0.13';
import { wsConnect, saveDirectWsSession, hasStoredSession, loadStoredSession } from './ws.js?v=11.0.13';

// Expose reducer for ws.js
window.reduceEnvelope = reduceEnvelope;

// ----- boot UI (start on Join) -----
setStatus('Disconnected');
setLobbyVisible(false);
showJoin(true);
setResumeAvailable(null);

// Pre-fill from URL hints and show Resume if present
setJoinFields({ room: ROOM_HINT || '', name: NAME_HINT || '' });

const storedSession = hasStoredSession() ? loadStoredSession() : null;
if (ROOM_HINT && NAME_HINT) {
  // Auto-join when link contains ?room&name
  const wsUrl = `${WS_BASE}?room=${encodeURIComponent(ROOM_HINT)}&role=player`;
  saveDirectWsSession({ wsUrl, roomId: ROOM_HINT, displayName: NAME_HINT });
  showJoin(false);
  wsConnect();
} else if (storedSession) {
  setResumeAvailable(storedSession);
  setStatus('Tap Resume to rejoin or enter a new room code.');
}

// ----- Join / Resume wiring -----
bindJoinUI({ onJoinClicked, onResumeClicked: tryResume });

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
