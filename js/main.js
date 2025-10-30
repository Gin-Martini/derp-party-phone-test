// js/main.js
import { initUi, setStatus, setPhase, setReadyUI, setReadyPill, enableReadyButton, setLobbyVisible, showToast, log } from './ui.js';
import { connectWs, scheduleReconnect, cancelReconnect, wsSend, endSession, resetToLobbyUi } from './ws.js';
import { renderCatalog, markSelected, markTaken } from './features/catalog.js';
import { updateRollUI } from './features/rollOverlay.js';
import { saveSession, loadSession, clearSession, state } from './state.js';
import { HTTP_BASE } from './config.js';

function bindUi() {
  // Ready button
  state.els.readyBtn?.addEventListener('click', () => {
    if (!state.ws) return;
    if (state.phase !== 'lobby') { showToast('Still waiting for lobby to open'); return; }
    if (state.myReady) wsSend({ type:'PLAYER_UNREADY' }); else wsSend({ type:'PLAYER_READY' });
  }, { passive:false });

  // Pill proxies to button
  state.els.readyPill?.addEventListener('click', () => {
    const b = state.els.readyBtn; if (b && !b.disabled && !b.classList.contains('btn-disabled')) b.click();
  }, { passive:false });

  // Name change -> unready
  state.els.nameInput?.addEventListener('input', () => {
    if (state.myReady) wsSend({ type:'PLAYER_UNREADY', reason:'Name changed' });
  }, { passive:false });

  // JOIN — robust on mobile: pointerup + click, never passive
  const joinBtn = document.getElementById('btnJoin');
  const fireJoin = (e) => { e.preventDefault(); onJoinClicked(); };
  if (joinBtn) {
    joinBtn.addEventListener('pointerup', fireJoin, { passive:false });
    joinBtn.addEventListener('click',     fireJoin, { passive:false });
  }
  const roomEl = document.getElementById('room');
  if (roomEl) roomEl.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onJoinClicked(); });

  // Roll button
  state.els.rollBtn?.addEventListener('click', ()=>{
    if (!state.ws) return;
    if (state.phase === 'lobby') return;
    if (state.inTurnOrder && !state.myHasRolled) {
      wsSend({ type:'PLAYER_ROLL' });
      wsSend({ type:'ROLL', phase:'TURN_ORDER' });
      state.myHasRolled = true;
      state.els.rollState.textContent = 'Rolling…';
      updateRollUI();
      return;
    }
    if (state.canRollNow) {
      wsSend({ type:'ROLL_MOVE' });
      wsSend({ type:'ROLL', phase:'MOVE' });
      state.els.rollState.textContent = 'Rolling…';
      state.canRollNow = false;
      updateRollUI();
    }
  }, { passive:false });
}

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
      headers: { 'content-type': 'application/json' },
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
    connectWs(); // HELLO on open
  } catch (e) {
    console.log('HTTP error:', e);
    setStatus('HTTP error'); showToast('Network error while joining.');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('btn-disabled'); }
  }
}

function tryAutoResume(){
  const sess = loadSession();
  if (sess) {
    state.roomId   = sess.roomId;
    state.playerId = sess.playerId;
    if (state.els.nameInput) state.els.nameInput.value = sess.name || 'Player';
    setStatus('Reconnecting…', true);
    state.shouldReconnect = true;
    connectWs();
  }
}

function hardReset(reason='Manual reset'){
  endSession(reason);
  clearSession();
  resetToLobbyUi();
}
window.dpReset = hardReset;
window.dpRehydrate = ()=>{ /* host will respond to snapshot requests via router schedule */ };

function boot(){
  initUi();
  bindUi();
  if (/(^|[?#&])(reset|wipe|clear)(=1)?/i.test(location.search + location.hash)) { hardReset('URL reset'); return; }
  tryAutoResume();
}
document.addEventListener('DOMContentLoaded', boot);
