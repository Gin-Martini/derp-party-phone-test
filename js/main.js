import { API_BASE, DIRECT_WS, ROOM_HINT, NAME_HINT, PID_HINT } from './config.js';
import { state } from './state.js';
import { saveSession, saveDirectWsSession, wsConnect, hasStoredSession, loadStoredSession, send } from './ws.js';
import { $, setStatus, bindJoinUI, setLobbyVisible, setReadyEnabled, onTileClicked,
         showJoin, showScreen, renderScreen, showRollOverlay, hideRollOverlay } from './views/ui.js';

// Wire base UI
bindJoinUI({ onJoin, onResume, onReadyClick, onRollClick, onCloseRoll });

initResumeHint();
prefillHints();
showJoin(true);
setLobbyVisible(false);
showScreen(false);
hideRollOverlay();

// --- Relay-direct mode: if ?ws=... is present, skip HTTP join entirely.
if (DIRECT_WS) {
  const wsUrl = DIRECT_WS;
  const roomId = ROOM_HINT || '';           // optional
  const playerId = PID_HINT || '';          // optional
  const token = '';                         // optional
  setStatus('Connecting (relay-direct)…', true);
  saveDirectWsSession({ wsUrl, roomId, playerId, token });
  wsConnect();
  showJoin(false);
}

function initResumeHint() {
  const resume = $('#btnResume');
  if (hasStoredSession()) resume.classList.remove('hidden');
  else resume.classList.add('hidden');
}

function prefillHints() {
  if (ROOM_HINT) $('#roomCode').value = ROOM_HINT;
  if (NAME_HINT) $('#playerName').value = NAME_HINT;
}

async function onJoin() {
  const roomCode = $('#roomCode').value.trim().toUpperCase();
  const name = $('#playerName').value.trim();
  if (!roomCode || !name) { setStatus('Enter code and name.'); return; }

  // If there is no API configured, fail fast with a helpful hint.
  if (!API_BASE) {
    setStatus('No API configured. Either add ?api=https://your-api OR pass ?ws=wss://relay/socket…');
    return;
  }

  setStatus('Joining…', true);
  try {
    const res = await fetch(`${API_BASE}/api/join`, {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ roomCode, name })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Expect: { roomId, playerId, token, wsUrl }
    if (!data?.roomId || !data?.playerId || !data?.token || !data?.wsUrl) {
      throw new Error('Bad join payload');
    }
    saveSession(data);
    setStatus('Joined. Opening socket…');
    wsConnect();
    showJoin(false);
  } catch (e) {
    // Mixed content / CORS / no server all show as "Failed to fetch".
    setStatus(`Join failed. Options: add ?api=https://your-api OR use ?ws=wss://relay…`);
  }
}

function onResume() {
  const s = loadStoredSession();
  if (!s) { setStatus('No session to resume'); return; }
  setStatus('Resuming…');
  wsConnect();
  showJoin(false);
}

function onReadyClick(nextReady) {
  send({ v:1, type:'SET_READY', payload:{ ready: nextReady } });
  setReadyEnabled(false); // prevent spam; server STATE will re-enable
}

function onRollClick() {
  const rollId = state.rollPrompt?.rollId;
  if (!rollId) return;
  send({ v:1, type:'ROLL', payload:{ rollId } });
}

function onCloseRoll() {
  hideRollOverlay();
}

// Character selection callback
onTileClicked((charId) => {
  send({ v:1, type:'CHOOSE_CHARACTER', payload:{ charId } });
});
