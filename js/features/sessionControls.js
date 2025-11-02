import { HTTP_BASE } from '../config.js?v=11.0.12';
import { state } from '../state.js?v=11.0.12';
import { renderCatalog, extractCatalogEntries } from './catalog.js?v=11.0.12';
import {
  hideJoinCard,
  resetToLobbyUi,
  setLobbyVisible,
  setPhase,
  setStatus,
  showToast
} from '../ui.js?v=11.0.12';
import { connectWs, cancelReconnect } from '../ws.js?v=11.0.12';
import { clearSession, loadSession, saveSession } from '../session.js?v=11.0.12';

let cachedSession = null;

function getStoredSession() {
  if (!cachedSession) cachedSession = loadSession();
  return cachedSession;
}

function setStoredSession(session) {
  cachedSession = session;
}

function updateJoinButtonLabel(hasStored) {
  const btn = state.els.joinBtn;
  if (!btn) return;
  btn.textContent = hasStored ? 'Join New Room' : 'Join Room';
}

function showResumeButton(room) {
  const btn = state.els.resumeBtn;
  if (!btn) return;
  btn.textContent = room ? `Resume ${room}` : 'Resume Session';
  btn.classList.remove('hidden');
}

function hideResumeButton() {
  const btn = state.els.resumeBtn;
  if (!btn) return;
  btn.classList.add('hidden');
  btn.textContent = 'Resume Session';
}

function setJoinButtonBusy(isBusy) {
  const btn = state.els.joinBtn;
  if (!btn) return;
  btn.disabled = !!isBusy;
  btn.classList.toggle('btn-disabled', !!isBusy);
}

function readInputValues() {
  const room = String(state.els.roomInput?.value || '').trim().toUpperCase();
  const name = String(state.els.nameInput?.value || '').trim() || 'Player';
  return { room, name };
}

async function requestJoin(room, name) {
  const url = `${HTTP_BASE}/rooms/${encodeURIComponent(room)}/join`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const error = new Error('JOIN_HTTP_ERROR');
    error.status = resp.status;
    error.body = body;
    throw error;
  }
  return resp.json().catch(() => ({}));
}

function showStoredSession(session) {
  if (!session) return;
  const room = String(session.roomId || '').trim().toUpperCase();
  const name = String(session.name || '').trim();
  if (state.els.roomInput) state.els.roomInput.value = room;
  if (state.els.nameInput) state.els.nameInput.value = name || 'Player';
  updateJoinButtonLabel(true);
  showResumeButton(room);
}

function applyJoinSuccess(payload, { room, name }) {
  const playerId = String(payload?.playerId ?? payload?.id ?? '').trim();
  if (!playerId) {
    const error = new Error('MISSING_PLAYER_ID');
    throw error;
  }

  const joinCatalog = extractCatalogEntries(payload);
  if (Array.isArray(joinCatalog)) {
    setLobbyVisible(true);
    setPhase('lobby');
    renderCatalog(joinCatalog);
  }

  state.roomId = room;
  state.playerId = playerId;
  state.shouldReconnect = true;

  if (state.els.nameInput) state.els.nameInput.value = name;

  setStoredSession(null);
  updateJoinButtonLabel(false);
  hideResumeButton();

  setStatus('Joined. Connecting…', true);
  hideJoinCard();

  try { saveSession(); } catch {}

  connectWs();
}

function restorePreviousSession(previousSession) {
  if (!previousSession) return;
  setStoredSession(previousSession);
  showStoredSession(previousSession);
}

function handleJoinError(error) {
  if (error?.message === 'MISSING_PLAYER_ID') {
    setStatus('Join failed (no player)');
    showToast('Bad server response.');
    return;
  }

  const status = error?.status ? ` (${error.status})` : '';
  setStatus(`Join failed${status}`);
  showToast('Could not join room. Check code/capacity.');
}

async function handleJoinClick(ev) {
  ev?.preventDefault?.();
  cancelReconnect();

  const previousStored = getStoredSession();
  const hadStored = !!(previousStored?.roomId && previousStored?.playerId);

  const { room, name } = readInputValues();
  if (!room) {
    showToast('Enter room code.');
    return;
  }

  setJoinButtonBusy(true);
  setStatus('Joining…', true);

  try {
    const payload = await requestJoin(room, name);
    applyJoinSuccess(payload, { room, name });
  } catch (err) {
    console.error('Join HTTP failed', err);
    handleJoinError(err);
    if (hadStored && previousStored) {
      restorePreviousSession(previousStored);
    }
    return;
  } finally {
    setJoinButtonBusy(false);
  }
}

function handleResumeClick(ev) {
  ev?.preventDefault?.();
  cancelReconnect();

  const session = getStoredSession();
  if (!session?.roomId || !session?.playerId) {
    setStoredSession(null);
    hideResumeButton();
    updateJoinButtonLabel(false);
    showToast('Saved session not found. Enter a room code.');
    return;
  }

  const room = String(session.roomId || '').trim().toUpperCase();
  const playerId = String(session.playerId || '').trim();
  if (!room || !playerId) {
    setStoredSession(null);
    hideResumeButton();
    updateJoinButtonLabel(false);
    showToast('Saved session was incomplete. Enter a room code.');
    return;
  }

  if (state.els.roomInput) state.els.roomInput.value = room;
  if (state.els.nameInput) state.els.nameInput.value = (session.name || '').trim() || 'Player';

  state.roomId = room;
  state.playerId = playerId;
  state.shouldReconnect = true;

  hideResumeButton();
  updateJoinButtonLabel(false);

  setStatus('Reconnecting…', true);
  hideJoinCard();
  connectWs();
}

function handleResetClick(ev) {
  ev?.preventDefault?.();
  cancelReconnect();
  try { state.ws?.close?.(); } catch {}

  state.shouldReconnect = false;
  state.roomId = '';
  state.playerId = '';

  clearSession();
  setStoredSession(null);

  resetToLobbyUi();
  setStatus('Waiting to join…');
  showToast('Session cleared. Enter room code.');
  updateJoinButtonLabel(false);
  hideResumeButton();
}

function shouldResetFromQuery() {
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

function maybeResetFromQuery() {
  if (!shouldResetFromQuery()) return false;

  cancelReconnect();
  state.shouldReconnect = false;
  state.roomId = '';
  state.playerId = '';

  clearSession();
  setStoredSession(null);

  resetToLobbyUi();
  setStatus('Waiting to join…');
  hideResumeButton();
  updateJoinButtonLabel(false);

  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('reset');
    const qs = url.searchParams.toString();
    const next = url.pathname + (qs ? `?${qs}` : '') + url.hash;
    window.history.replaceState({}, document.title, next);
  } catch {}

  return true;
}

function bindJoin() {
  const btn = state.els.joinBtn;
  if (!btn) return;
  const handler = (ev) => handleJoinClick(ev);
  btn.onclick = handler;
  ['click', 'pointerup', 'touchend'].forEach((evt) => btn.addEventListener(evt, handler, { passive: false }));

  state.els.roomInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJoinClick(e);
  });
}

function bindResume() {
  const btn = state.els.resumeBtn;
  if (!btn) return;
  const handler = (ev) => handleResumeClick(ev);
  ['click', 'pointerup', 'touchend'].forEach((evt) => btn.addEventListener(evt, handler, { passive: false }));
}

function bindReset() {
  const btn = state.els.resetBtn;
  if (!btn) return;
  const handler = (ev) => handleResetClick(ev);
  ['click', 'pointerup', 'touchend'].forEach((evt) => btn.addEventListener(evt, handler, { passive: false }));
}

export function configureSessionControls() {
  bindJoin();
  bindResume();
  bindReset();

  if (maybeResetFromQuery()) return;

  const session = getStoredSession();
  if (session) {
    showStoredSession(session);
    return;
  }

  updateJoinButtonLabel(false);
  hideResumeButton();
}

if (typeof window !== 'undefined') {
  window._JOIN = handleJoinClick;
}
