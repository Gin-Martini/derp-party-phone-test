import { API_BASE } from './config.js';
import { state } from './state.js';
import { saveSession, wsConnect, hasStoredSession, loadStoredSession, send } from './ws.js';
import { $, setStatus, bindJoinUI, setLobbyVisible, setReadyEnabled, onTileClicked,
         showJoin, showScreen, renderScreen, showRollOverlay, hideRollOverlay } from './views/ui.js';

// Wire base UI
bindJoinUI({ onJoin, onResume, onReadyClick, onRollClick, onCloseRoll });

initResumeHint();
showJoin(true);
setLobbyVisible(false);
showScreen(false);
hideRollOverlay();

function initResumeHint() {
  const resume = $('#btnResume');
  if (hasStoredSession()) resume.classList.remove('hidden');
  else resume.classList.add('hidden');
}

async function onJoin() {
  const roomCode = $('#roomCode').value.trim().toUpperCase();
  const name = $('#playerName').value.trim();
  if (!roomCode || !name) { setStatus('Enter code and name.'); return; }

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
    setStatus(`Join failed: ${e.message}`);
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

// Character selection callback (tile wiring)
onTileClicked((charId) => {
  send({ v:1, type:'CHOOSE_CHARACTER', payload:{ charId } });
  // Button will enable after server echoes STATE.me.charId
});
