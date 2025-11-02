import { state } from '../state.js?v=11.0.12';
import { enableReadyButton, setReadyUI, showToast } from '../ui.js?v=11.0.12';
import { sendIntent, wsSend } from '../ws.js?v=11.0.12';

const READY_ON_INTENTS = ['READY', 'PLAYER_READY', 'SET_READY', 'READY_UP'];
const READY_OFF_INTENTS = ['UNREADY', 'PLAYER_UNREADY', 'SET_UNREADY', 'READY_DOWN'];
const READY_ON_TYPES = ['PLAYER_READY', 'READY', 'PLAYER_READY_STATE', 'READY_STATE', 'READY_STATUS', 'READY_UP'];
const READY_OFF_TYPES = ['PLAYER_UNREADY', 'UNREADY', 'PLAYER_READY_STATE', 'READY_STATE', 'READY_STATUS', 'READY_DOWN'];

function buildReadyPayload(nextReady) {
  const ready = Boolean(nextReady);
  const status = ready ? 'READY' : 'NOT_READY';
  const payload = {
    roomId: state.roomId || undefined,
    playerId: state.playerId || undefined,
    characterId: state.myCharId || undefined,
    ready,
    isReady: ready,
    playerReady: ready,
    readyState: status,
    state: status,
    status,
    value: ready,
    valueLabel: status
  };
  if (!payload.characterId) delete payload.characterId;
  return payload;
}

function broadcastReadyState(nextReady) {
  const payload = buildReadyPayload(nextReady);
  const intents = nextReady ? READY_ON_INTENTS : READY_OFF_INTENTS;
  const types = nextReady ? READY_ON_TYPES : READY_OFF_TYPES;

  const sentIntents = new Set();
  intents.forEach((intent) => {
    const key = String(intent || '').trim();
    if (!key || sentIntents.has(key)) return;
    sentIntents.add(key);
    try { sendIntent(key, payload); } catch {}
  });

  const sentTypes = new Set();
  types.forEach((type) => {
    const key = String(type || '').trim();
    if (!key || sentTypes.has(key)) return;
    sentTypes.add(key);
    try { wsSend({ type: key, ...payload }); } catch {}
  });
}

function ensureCharacterSelection() {
  const hasChar = String(state.myCharId || '').trim().length > 0;
  if (hasChar || state.myReady) return true;
  enableReadyButton(false);
  showToast('Pick a character first.');
  return false;
}

export function handleReadyClick(ev) {
  ev?.preventDefault?.();
  const btn = state.els.readyBtn;
  if (!btn) return;

  if (!ensureCharacterSelection()) return;

  const nextReady = !state.myReady;
  setReadyUI(nextReady);
  broadcastReadyState(nextReady);
  btn.blur?.();
}

export function setupReadyButton() {
  const btn = state.els.readyBtn;
  if (!btn) return;
  btn.addEventListener('click', handleReadyClick, { passive: false });
}

if (typeof window !== 'undefined') {
  window._READY = handleReadyClick;
}
