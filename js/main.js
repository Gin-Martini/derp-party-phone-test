// js/main.js — FULL FILE (deduped imports; versioned feature modules)
import { state } from './state.js?v=11.0.1';
import { initUi, setStatus, showToast, enableReadyButton, setReadyUI, setDbg } from './ui.js?v=11.0.1';
import { saveSession, loadSession, clearSession } from './session.js';
import { connectWs, scheduleReconnect, cancelReconnect, wsSend, endSession, resetToLobbyUi } from './ws.js';
import { renderCatalog } from './features/catalog.js?v=11.0.1';
import { updateRollUI, showRollOverlay } from './features/rollOverlay.js?v=11.0.1';
import { HTTP_BASE } from './config.js';


// ==== Boot ====
function bindUi() {
  // Cancel pending reconnect by tapping status pill
  state.els.status?.addEventListener('click', () => {
    if (!state.shouldReconnect || !state.reconnectTimer) return;
    cancelReconnect();
    setStatus('Reconnect canceled — use Join to re-enter');
  });

  // Hidden hard-reset: triple tap or long-press
  let _tapCount = 0, _lastTap = 0, _pressTo;
  state.els.status?.addEventListener('click', () => {
    const now = Date.now();
    _tapCount = (now - _lastTap < 350) ? _tapCount + 1 : 1;
    _lastTap = now;
    if (_tapCount >= 3) { hardReset('manual triple-tap'); _tapCount = 0; }
  });
  state.els.status?.addEventListener('touchstart', () => { _pressTo = setTimeout(() => hardReset('manual long-press'), 800); }, { passive:true });
  state.els.status?.addEventListener('touchend', () => clearTimeout(_pressTo), { passive:true });

  // Character grid click
  state.els.charGrid?.addEventListener('click', (e) => {
    const btn = e.target.closest('.charBtn');
    if (!btn || !state.els.charGrid.contains(btn)) return;
    const id = btn.dataset.charId;
    if (!id) return;
    if (state.takenChars.has(id) && id !== state.myCharId){ showToast('That character is taken.'); return; }
    if (state.myReady && id !== state.myCharId) { sendUnready('Changed character'); }
    wsSend({ type:'CHARACTER_SELECT', charId:id });
    state.myCharId = id;
    enableReadyButton(true);
  }, { passive: true });

  // Ready toggle
  state.els.readyBtn?.addEventListener('click', () => {
    const b = state.els.readyBtn;
    if (b.disabled || b.classList.contains('btn-disabled')) {
      if (!state.myCharId) showToast('Pick a character first');
      else showToast('Still waiting for lobby to open');
      return;
    }
    if (!state.ws) return;
    if (state.myReady) sendUnready(); else sendReady();
  }, { passive: true });

  state.els.readyPill?.addEventListener('click', () => {
    const b = state.els.readyBtn; if (b.disabled || b.classList.contains('btn-disabled')) return; b.click();
  }, { passive: true });

  // Name change -> unready
  state.els.nameInput?.addEventListener('input', () => {
    if (state.myReady) sendUnready('Name changed');
  }, { passive:true });

  // JOIN — never passive; bind pointerup + click for mobile reliability
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
      setDbg('PLAYER_ROLL/ROLL (turn-order) sent');
      return;
    }
    if (state.canRollNow) {
      wsSend({ type:'ROLL_MOVE' });
      wsSend({ type:'ROLL', phase:'MOVE' });
      state.els.rollState.textContent = 'Rolling…';
      state.canRollNow = false;
      updateRollUI();
      setDbg('ROLL_MOVE/ROLL (move) sent');
    }
  }, { passive:true });
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

function sendReady(){ wsSend({ type:'PLAYER_READY' }); setReadyUI(true); }
function sendUnready(reason){ wsSend({ type:'PLAYER_UNREADY', reason }); setReadyUI(false); }

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
  // URL kill-switch: ?reset / #reset / ?wipe / ?clear
  if (/(^|[?#&])(reset|wipe|clear)(=1)?/i.test(location.search + location.hash)) { hardReset('URL reset'); return; }
  tryAutoResume();
}

document.addEventListener('DOMContentLoaded', boot);
