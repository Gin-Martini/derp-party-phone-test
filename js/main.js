// js/main.js — phone bootstrap (robust join; optional router)
import * as WS from './ws.js';
import { HTTP_BASE } from './config.js';

// Minimal status helpers (work even if ui.js/state.js are broken)
const $ = (s)=>document.querySelector(s);
function setStatus(s, busy=false){
  const el = $('#status');
  if (el) el.textContent = `Status: ${s}`;
  if (busy) el?.classList?.add('busy'); else el?.classList?.remove('busy');
}
function toast(msg){
  const t = $('#toast'); if (!t) { alert(msg); return; }
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 1500);
}

// --- JOIN FLOW ---
async function onJoinClicked(e){
  e?.preventDefault?.();

  WS.cancelReconnect?.();

  const room = String($('#room')?.value || '').trim().toUpperCase();
  const name = String($('#name')?.value || '').trim() || 'Player';
  if (!room){ toast('Enter room code.'); return; }

  const btn = $('#btnJoin');
  btn?.classList?.add('btn-disabled'); if (btn) btn.disabled = true;
  setStatus('Joining…', true);

  try {
    const url = `${HTTP_BASE}/rooms/${encodeURIComponent(room)}/join`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ name })
    });
    if (!resp.ok){
      const txt = await resp.text().catch(()=>'<no body>');
      console.log('Join HTTP failed:', resp.status, txt);
      setStatus(`Join failed (${resp.status})`);
      toast('Could not join room. Check code/capacity.');
      return;
    }
    const j = await resp.json().catch(()=>({}));
    const playerId = j.playerId || j.id || '';
    if (!playerId){
      setStatus('Join failed (no playerId)'); toast('Bad server response.'); return;
    }

    // persist minimal session so reconnect works (no dependency on session.js)
    try { localStorage.setItem('dp.session', JSON.stringify({ roomId: room, playerId, name })); } catch {}

    setStatus('Joined. Connecting…', true);
    WS.connectWs?.(); // triggers HELLO on open
  } catch (err){
    console.log('HTTP error:', err);
    setStatus('HTTP error'); toast('Network error while joining.');
  } finally {
    btn?.classList?.remove('btn-disabled'); if (btn) btn.disabled = false;
  }
}
window._JOIN = onJoinClicked; // hard fallback (optional)

// --- UI BINDINGS ---
function bindJoin(){
  const btn = $('#btnJoin');
  if (!btn) return;
  const fire = (e)=>onJoinClicked(e);
  // multiple events = reliable on mobile
  ['click','pointerup','touchend'].forEach(evt => btn.addEventListener(evt, fire, {passive:false}));
  // Enter in room field
  $('#room')?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onJoinClicked(e); });
}

// --- OPTIONAL: wire router safely (won’t block joins if missing) ---
async function wireRouter(){
  try {
    const mod = await import('./router.js?v=11.0.1');
    if (mod?.onSocketMessage && typeof WS.setOnSocketMessage === 'function') {
      WS.setOnSocketMessage(mod.onSocketMessage);
    }
  } catch (e) {
    console.warn('router optional:', e?.message || e);
  }
}

// --- AUTO-RESUME (safe/local) ---
function tryAutoResume(){
  try {
    const raw = localStorage.getItem('dp.session');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s?.roomId || !s?.playerId) return;
    $('#name') && ($('#name').value = s.name || 'Player');
    setStatus('Reconnecting…', true);
    WS.connectWs?.();
  } catch {}
}

// --- BOOT ---
function boot(){
  bindJoin();
  wireRouter();    // non-blocking
  tryAutoResume(); // if a session exists
}
document.addEventListener('DOMContentLoaded', boot);
