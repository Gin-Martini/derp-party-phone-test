// js/main.js — phone bootstrap (fix: set state before WS; call initUi; cache-bust ALL module imports)
import * as WS from './ws.js?v=11.0.12';
import { renderCatalog, extractCatalogEntries } from './features/catalog.js?v=11.0.12';
import { state } from './state.js?v=11.0.12';
import { initUi, hideJoinCard, resetToLobbyUi, setLobbyVisible, setPhase, setReadyUI, enableReadyButton, showToast } from './ui.js?v=11.0.12';
import { HTTP_BASE, SESSION_KEY } from './config.js?v=11.0.12';
import { onSocketMessage } from './router.js?v=11.0.12';
import { wireRollButton, updateRollUI, hideRollOverlay } from './features/rollOverlay.js?v=11.0.12';

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

let storedSession = null;

function buildReadyPayload(nextReady) {
  const ready = !!nextReady;
  const status = ready ? 'READY' : 'NOT_READY';
  const roomId = String(state.roomId || '').trim();
  const playerId = String(state.playerId || '').trim();
  const characterId = String(state.myCharId || '').trim();
  const base = {
    roomId: roomId || undefined,
    playerId: playerId || undefined,
    characterId: characterId || undefined,
    ready,
    isReady: ready,
    playerReady: ready,
    readyState: status,
    state: status,
    status,
    value: ready,
    valueLabel: status
  };
  if (!characterId) delete base.characterId;
  return base;
}

function pushReadyState(nextReady) {
  const base = buildReadyPayload(nextReady);
  const intents = nextReady
    ? ['READY', 'PLAYER_READY', 'SET_READY', 'READY_UP']
    : ['UNREADY', 'PLAYER_UNREADY', 'SET_UNREADY', 'READY_DOWN'];
  const directTypes = nextReady
    ? ['PLAYER_READY', 'READY', 'PLAYER_READY_STATE', 'READY_STATE', 'READY_STATUS', 'READY_UP']
    : ['PLAYER_UNREADY', 'UNREADY', 'PLAYER_READY_STATE', 'READY_STATE', 'READY_STATUS', 'READY_DOWN'];

  const sentIntents = new Set();
  intents.forEach((intent) => {
    const key = String(intent || '').trim();
    if (!key || sentIntents.has(key)) return;
    sentIntents.add(key);
    try { WS.sendIntent?.(key, base); } catch {}
  });

  const sentTypes = new Set();
  directTypes.forEach((type) => {
    const key = String(type || '').trim();
    if (!key || sentTypes.has(key)) return;
    sentTypes.add(key);
    try { WS.wsSend?.({ type: key, ...base }); } catch {}
  });
}

function onReadyClicked(ev) {
  ev?.preventDefault?.();
  const btn = $('#btnReady');
  if (!btn) return;

  const hasChar = String(state.myCharId || '').trim().length > 0;
  if (!hasChar && !state.myReady) {
    enableReadyButton(false);
    toast('Pick a character first.');
    try { showToast('Pick a character first.'); } catch {}
    return;
  }

  const nextReady = !state.myReady;
  setReadyUI(nextReady);
  pushReadyState(nextReady);
  btn.blur?.();
}
window._READY = onReadyClicked;

// Wire the router immediately so the very first WS messages (HELLO/CATALOG) are handled.
WS.setOnSocketMessage(onSocketMessage);

function updateJoinButtonLabel(hasStored){
  const btn = $('#btnJoin'); if (!btn) return;
  btn.textContent = hasStored ? 'Join New Room' : 'Join Room';
}

function showResumeButton(room){
  const btn = $('#btnResume');
  if (!btn) return;
  btn.textContent = room ? `Resume ${room}` : 'Resume Session';
  btn.classList.remove('hidden');
}

function hideResumeButton(){
  const btn = $('#btnResume');
  if (btn) {
    btn.classList.add('hidden');
    btn.textContent = 'Resume Session';
  }
}

// --- JOIN FLOW ---
async function onJoinClicked(e){
  e?.preventDefault?.();
  WS.cancelReconnect?.();

  const previousStored = storedSession || loadStoredSession();
  const hadStored = !!(previousStored?.roomId && previousStored?.playerId);

  const room = String($('#room')?.value || '').trim().toUpperCase();
  const name = String($('#name')?.value || '').trim() || 'Player';
  if (!room){ toast('Enter room code.'); return; }

  const btn = $('#btnJoin');
  btn?.classList?.add('btn-disabled'); if (btn) btn.disabled = true;
  setStatus('Joining…', true);

  let joinSucceeded = false;
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

    const joinCatalog = extractCatalogEntries(j);
    if (Array.isArray(joinCatalog)) {
      setLobbyVisible(true);
      setPhase('lobby');
      renderCatalog(joinCatalog);
    }

    // >>> CRITICAL: set state before opening WS <<<
    state.roomId = room;
    state.playerId = String(playerId);
    state.shouldReconnect = true;

    storedSession = null;
    hideResumeButton();
    updateJoinButtonLabel(false);

    // Persist (use canonical v2 key so reconnects work across pages)
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId: room, playerId, name })); } catch {}

    setStatus('Joined. Connecting…', true);
    hideJoinCard();
    WS.connectWs?.(); // triggers HELLO on open using state.roomId/playerId
    joinSucceeded = true;
  } catch (err){
    console.log('HTTP error:', err);
    setStatus('HTTP error'); toast('Network error while joining.');
  } finally {
    btn?.classList?.remove('btn-disabled'); if (btn) btn.disabled = false;
    if (!joinSucceeded && hadStored && previousStored){
      storedSession = previousStored;
      const resumeRoom = String(previousStored.roomId || '').trim().toUpperCase();
      updateJoinButtonLabel(true);
      showResumeButton(resumeRoom);
    }
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

function bindReady(){
  const btn = $('#btnReady'); if (!btn) return;
  btn.addEventListener('click', onReadyClicked, { passive: false });
}

function onResetClicked(e){
  e?.preventDefault?.();
  WS.cancelReconnect?.();
  try { state.ws?.close?.(); } catch {}
  state.shouldReconnect = false;
  state.roomId = '';
  state.playerId = '';
  clearStoredSession();
  resetToLobbyUi();
  setStatus('Waiting to join…');
  toast('Session cleared. Enter room code.');
}

function bindSessionControls(){
  const btn = $('#btnReset'); if (!btn) return;
  const fire = (e)=>onResetClicked(e);
  ['click','pointerup','touchend'].forEach(evt => btn.addEventListener(evt, fire, {passive:false}));
}

function onResumeClicked(e){
  e?.preventDefault?.();
  WS.cancelReconnect?.();

  const session = storedSession || loadStoredSession();
  if (!session?.roomId || !session?.playerId){
    storedSession = null;
    hideResumeButton();
    updateJoinButtonLabel(false);
    toast('Saved session not found. Enter a room code.');
    return;
  }

  storedSession = session;
  const room = String(session.roomId || '').trim().toUpperCase();
  const playerId = String(session.playerId || '').trim();
  if (!room || !playerId){
    storedSession = null;
    hideResumeButton();
    updateJoinButtonLabel(false);
    toast('Saved session was incomplete. Enter a room code.');
    return;
  }

  const name = (session.name || '').trim();
  if ($('#name')) $('#name').value = name || $('#name').value || 'Player';
  state.roomId = room;
  state.playerId = playerId;
  state.shouldReconnect = true;

  hideResumeButton();
  updateJoinButtonLabel(false);

  setStatus('Reconnecting…', true);
  hideJoinCard();
  WS.connectWs?.();
}

function bindResume(){
  const btn = $('#btnResume'); if (!btn) return;
  const fire = (e)=>onResumeClicked(e);
  ['click','pointerup','touchend'].forEach(evt => btn.addEventListener(evt, fire, {passive:false}));
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
  storedSession = null;
  hideResumeButton();
  updateJoinButtonLabel(false);
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
  storedSession = loadStoredSession();
  if (!storedSession?.roomId || !storedSession?.playerId){
    storedSession = null;
    hideResumeButton();
    updateJoinButtonLabel(false);
    return;
  }

  const room = String(storedSession.roomId || '').trim().toUpperCase();
  const name = (storedSession.name || '').trim();
  if ($('#room')) $('#room').value = room;
  if ($('#name')) $('#name').value = name || 'Player';

  updateJoinButtonLabel(true);
  showResumeButton(room);
  setStatus(room ? `Saved session found for room ${room}. Tap Resume or Switch Room.` : 'Saved session found. Tap Resume or Switch Room.');
}

// --- BOOT ---
function boot(){
  initUi();       // wire DOM refs so router/catalog can render the grid
  wireRollButton();
  hideRollOverlay();
  updateRollUI();
  const initialCatalog = Array.isArray(state._pendingCatalog) ? state._pendingCatalog : (Array.isArray(state.catalog?.entries) ? state.catalog.entries : []);
  renderCatalog(initialCatalog);
  bindJoin();
  bindReady();
  bindResume();
  bindSessionControls();
  const didReset = maybeResetFromQuery();
  if (!didReset) tryAutoResume();
  else updateJoinButtonLabel(false);
}
document.addEventListener('DOMContentLoaded', boot);
