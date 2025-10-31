// js/main.js — phone bootstrap (robust join binding + optional router wiring)

import * as WS from './ws.js';
import { state } from './state.js';
import { initUi, setStatus, showToast, enableReadyButton, setReadyUI } from './ui.js';
import { saveSession, loadSession, clearSession } from './session.js';
import { HTTP_BASE } from './config.js';

// --- JOIN FLOW ---
async function onJoinClicked(){
  WS.cancelReconnect?.(); state.shouldReconnect = false;

  const roomEl = document.getElementById('room');
  const nameEl = document.getElementById('name');
  if (!roomEl) { showToast('Room input not found. Refresh.'); return; }

  state.roomId = String(roomEl.value || '').trim().toUpperCase();
  const name = String(nameEl?.value || '').trim() || 'Player';
  if (!state.roomId) { showToast('Enter room code.'); return; }

  const btn = document.getElementById('btnJoin');
  if (btn) { btn.disabled = true; btn.classList.add('btn-disabled'); }
  setStatus('Joining…', true);

  try {
    const url = `${HTTP_BASE}/rooms/${encodeURIComponent(state.roomId)}/join`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=>'<no body>');
      console.log('Join HTTP failed:', resp.status, txt);
      setStatus(`Join failed (${resp.status})`);
      showToast('Could not join room. Check code/capacity.');
      return;
    }
    const j = await resp.json().catch(()=>({}));
    state.playerId = j.playerId || j.id || '';
    if (!state.playerId) { setStatus('Join failed (no playerId)'); showToast('Bad server response.'); return; }

    state.shouldReconnect = true;
    saveSession();
    WS.connectWs?.(); // HELLO on open; router wiring happens separately
  } catch (e) {
    console.log('HTTP error:', e);
    setStatus('HTTP error'); showToast('Network error while joining.');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('btn-disabled'); }
  }
}
window._JOIN = onJoinClicked; // manual fallback: allows inline onclick if ever needed

function sendReady(){ WS.wsSend?.({ type:'PLAYER_READY' }); setReadyUI?.(true); }
function sendUnready(reason){ WS.wsSend?.({ type:'PLAYER_UNREADY', reason }); setReadyUI?.(false); }

// --- RESUME FLOW ---
function tryAutoResume(){
  const sess = loadSession();
  if (!sess || !sess.roomId || !sess.playerId) return;
  state.roomId = sess.roomId;
  state.playerId = sess.playerId;
  if (document.getElementById('name')) document.getElementById('name').value = sess.name || 'Player';
  state.shouldReconnect = true;
  setStatus('Reconnecting…', true);
  WS.connectWs?.();
}

// --- UI BINDINGS ---
function bindUi(){
  const joinBtn = document.getElementById('btnJoin');
  const fireJoin = (e)=>{ e?.preventDefault?.(); onJoinClicked(); };

  if (joinBtn) {
    ['click','pointerup','touchend'].forEach(evt =>
      joinBtn.addEventListener(evt, fireJoin, { passive:false })
    );
  }

  const roomEl = document.getElementById('room');
  if (roomEl) roomEl.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onJoinClicked(); });

  // (optional) ready / char handlers here if needed
}

// --- OPTIONAL: wire router safely (won’t block joins if missing) ---
async function wireRouter(){
  try {
    const mod = await import('./router.js?v=hotfix');
    if (mod?.onSocketMessage && typeof WS.setOnSocketMessage === 'function') {
      WS.setOnSocketMessage(mod.onSocketMessage);
    }
  } catch (e) {
    console.warn('router optional:', e?.message || e);
  }
}

// --- HARD RESET ---
function hardReset(reason='Manual reset'){
  WS.endSession?.(reason);
  clearSession();
  WS.resetToLobbyUi?.();
}
window.dpReset = hardReset;

// --- BOOT ---
function boot(){
  try { initUi?.(); } catch(e){ console.warn('initUi error', e); }
  bindUi();
  wireRouter();           // non-blocking
  if (/(^|[?#&])(reset|wipe|clear)(=1)?/i.test(location.search + location.hash)) { hardReset('URL reset'); return; }
  tryAutoResume();
}
document.addEventListener('DOMContentLoaded', boot);
