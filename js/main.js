// js/main.js — FULL FILE (deduped imports; versioned feature modules)
import { state } from './state.js?v=11.0.1';
import { initUi, setStatus, showToast, enableReadyButton, setReadyUI, setDbg } from './ui.js?v=11.0.1';
import { saveSession, loadSession, clearSession } from './session.js';
import { connectWs, scheduleReconnect, cancelReconnect, wsSend, endSession, resetToLobbyUi } from './ws.js';
import { setOnSocketMessage } from './ws.js';
import { onSocketMessage } from './router.js?v=11.0.1';
import { renderCatalog } from './features/catalog.js?v=11.0.1';
import { updateRollUI, showRollOverlay } from './features/rollOverlay.js?v=11.0.1';
import { HTTP_BASE } from './config.js';

// === DOM wiring & UI helpers (unchanged parts trimmed for brevity) ===
function initUi(){ /* ... keep your existing init code ... */ }
function setReadyUI(isReady){ /* ... existing ... */ }
function enableReadyButton(on){ /* ... existing ... */ }
function setDbg(s){ const pill = document.querySelector('#dbgLast, .dbg-last, .pill-last'); if (pill) pill.textContent = `last: ${s}`; }

// === JOIN / RESUME ===
async function onJoinClicked(){
  cancelReconnect(); state.shouldReconnect = false;

  const roomEl = document.getElementById('room');
  if (!roomEl) { showToast('Room input not found. Refresh the page.'); return; }

  state.roomId = String(roomEl.value || '').trim().toUpperCase();
  const name = String(state.els.nameInput?.value || '').trim() || 'Player';
  if (!state.roomId) { showToast('Enter room code.'); return; }

  const btn = document.getElementById('btnJoin');
  if (btn) { btn.disabled = true; btn.classList.add('btn-disabled'); }
  setStatus('Joining…', true);

  try {
    const resp = await fetch(`${HTTP_BASE}/rooms/${encodeURIComponent(state.roomId)}/join`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ name })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '<no body>');
      console.log(`Join HTTP failed: ${resp.status} ${txt}`);
      setStatus(`Join failed (${resp.status})`);
      showToast('Could not join room. Check code/capacity.');
      return;
    }
    const j = await resp.json().catch(() => ({}));
    state.playerId = j.playerId || j.id || '';
    if (!state.playerId) {
      console.log('Join response missing playerId:', j);
      setStatus('Join failed (no playerId)');
      showToast('Join failed: bad server response.');
      return;
    }
    state.shouldReconnect = true;
    saveSession();
    connectWs(); // HELLO on open; router is wired below
  } catch (e) {
    console.log('HTTP error:', e);
    setStatus('HTTP error'); showToast('Network error while joining.');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('btn-disabled'); }
  }
}

function tryAutoResume(){
  const sess = loadSession();
  if (!sess || !sess.roomId || !sess.playerId) return;
  state.roomId = sess.roomId;
  state.playerId = sess.playerId;
  state.shouldReconnect = true;
  setStatus('Reconnecting…', true);
  connectWs();
}

// === boot ===
function bindUi(){
  const joinBtn = document.getElementById('btnJoin');
  const fireJoin = (e) => { e.preventDefault(); onJoinClicked(); };
  if (joinBtn) {
    joinBtn.addEventListener('pointerup', fireJoin, { passive:false });
    joinBtn.addEventListener('click',     fireJoin, { passive:false });
  }
  const roomEl = document.getElementById('room');
  if (roomEl) roomEl.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onJoinClicked(); });
}
function hardReset(why){
  cancelReconnect(); state.shouldReconnect = false;
  endSession(why || 'Reset');
  clearSession();
  resetToLobbyUi();
}

function boot(){
  initUi();
  bindUi();
  // Wire WS -> router so lobby/catalog render
  try { setOnSocketMessage(onSocketMessage); } catch (e) { console.log('router wire error', e); }
  // URL kill-switch: ?reset / #reset / ?wipe / ?clear
  if (/(^|[?#&])(reset|wipe|clear)(=1)?/i.test(location.search + location.hash)) { hardReset('URL reset'); return; }
  tryAutoResume();
}
document.addEventListener('DOMContentLoaded', boot);

// Expose a couple helpers for console debugging
window.dpReset = hardReset;
window.dpRehydrate = ()=>{ /* host will respond to snapshot requests */ };
