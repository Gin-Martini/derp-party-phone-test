// js/main.js — phone bootstrap (fix: set state before WS; call initUi; cache-bust ALL module imports)
import * as WS from './ws.js?v=11.0.6';
import { state } from './state.js?v=11.0.6';
import { initUi, hideJoinCard } from './ui.js?v=11.0.6';
import { HTTP_BASE, SESSION_KEY } from './config.js?v=11.0.6';

// Minimal status helpers (works even if ui wiring hiccups)
const $ = (s)=>document.querySelector(s);
function setStatus(s, busy=false){
  const el = $('#status');
  if (el) el.textContent = `Status: ${s}`;
  if (busy) el?.classList?.add('busy'); else el?.classList?.remove('busy');
}
function toast(msg){
  const t = $('#toast'); if (!t) { alert(msg); return; }
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast._to); toast._to = setTimeout(()=>t.style.display='none', 1500);
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
    if (!playerId){ setStatus('Join failed (no playerId)'); toast('Bad server response.'); return; }

    // >>> CRITICAL: set state before opening WS <<<
    state.roomId = room;
    state.playerId = String(playerId);
    state.shouldReconnect = true;

    // Persist (use canonical v2 key so reconnects work across pages)
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId: room, playerId, name })); } catch {}

    setStatus('Joined. Connecting…', true);
    hideJoinCard();
    WS.connectWs?.(); // triggers HELLO on open using state.roomId/playerId
  } catch (err){
    console.log('HTTP error:', err);
    setStatus('HTTP error'); toast('Network error while joining.');
  } finally {
    btn?.classList?.remove('btn-disabled'); if (btn) btn.disabled = false;
  }
}
window._JOIN = onJoinClicked; // debug helper

// --- UI BINDINGS ---
function bindJoin(){
  const btn = $('#btnJoin'); if (!btn) return;
  const fire = (e)=>onJoinClicked(e);
  ['click','pointerup','touchend'].forEach(evt => btn.addEventListener(evt, fire, {passive:false}));
  $('#room')?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') onJoinClicked(e); });
}

// --- Optional router wiring (cache-busted import) ---
async function wireRouter(){
  try {
    const mod = await import('./router.js?v=11.0.6');
    if (mod?.onSocketMessage && typeof WS.setOnSocketMessage === 'function') {
      WS.setOnSocketMessage(mod.onSocketMessage);
    }
  } catch (e) { console.warn('router optional:', e?.message || e); }
}

// --- AUTO-RESUME (supports old and new keys) ---
function loadStoredSession(){
  try {
    const raw = localStorage.getItem(SESSION_KEY) || localStorage.getItem('dp.session');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function shouldResetFromQuery(){
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('reset')) return false;
    const val = params.get('reset');
    if (val === null) return true;
    const normalized = String(val).trim().toLowerCase();
    if (normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
    return true;
  } catch {
    return false;
  }
}

function clearStoredSession(){
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  try { localStorage.removeItem('dp.session'); } catch {}
}

function maybeResetFromQuery(){
  if (!shouldResetFromQuery()) return false;
  WS.cancelReconnect?.();
  state.shouldReconnect = false;
  state.roomId = '';
  state.playerId = '';
  clearStoredSession();
  setStatus('Waiting to join…');
  try { state.els?.joinCard?.classList?.remove('hidden'); } catch {}
  try { state.els?.lobbyArea?.classList?.add('hidden'); } catch {}
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('reset');
    const qs = url.searchParams.toString();
    const next = url.pathname + (qs ? `?${qs}` : '') + url.hash;
    window.history.replaceState({}, document.title, next);
  } catch {}
  return true;
}

function tryAutoResume(){
  const s = loadStoredSession();
  if (!s?.roomId || !s?.playerId) return;
  $('#name') && ($('#name').value = s.name || 'Player');
  state.roomId = String(s.roomId).trim().toUpperCase();
  state.playerId = String(s.playerId).trim();
  state.shouldReconnect = true;
  setStatus('Reconnecting…', true);
  WS.connectWs?.();
}

// --- BOOT ---
function boot(){
  initUi();       // wire DOM refs so router/catalog can render the grid
  bindJoin();
  wireRouter();   // non-blocking
  const didReset = maybeResetFromQuery();
  if (!didReset) tryAutoResume();
}
document.addEventListener('DOMContentLoaded', boot);
