import { state } from './state.js';
import { setLobbyVisible, renderCatalog, setReadyEnabled, showRollOverlay, hideRollOverlay,
         setRollPrompt, setRollResults, setStatus, showJoin, showScreen, renderScreen } from './views/ui.js';

function applySeq(seq) {
  if (typeof seq !== 'number') return true;
  if (seq <= state.lastSeq) return false;
  state.lastSeq = seq;
  return true;
}

export function reduceEnvelope(incoming) {
  // Compat: unwrap C# envelopes if any slipped through ws.js
  let msg = incoming;
  if (String(msg?.type).startsWith('StateEnvelope') && msg?.payload) {
    const inner = msg.payload;
    msg = { v: inner.v || 1, type: inner.type || 'STATE', seq: msg.seq ?? inner.seq ?? 0, payload: inner.payload ?? inner };
  }

  const { type, seq, payload } = msg;

  switch (type) {
    case 'STATE':
      if (!applySeq(seq)) return;
      applyState(payload);
      break;

    case 'ROLL_PROMPT':
      if (!applySeq(seq)) return;
      state.rollPrompt = payload;
      // Only show if phase is roll_turn_order and I'm eligible
      const meId = state.me?.id;
      const allowed = payload?.allowedPlayers || [];
      const already = new Set(payload?.alreadyRolled || []);
      const canSee = state.phase === 'roll_turn_order' && meId && allowed.includes(meId) && !already.has(meId);
      setRollPrompt(payload, canSee);
      if (canSee) showRollOverlay(); else hideRollOverlay();
      break;

    case 'ROLL_RESULT':
      if (!applySeq(seq)) return;
      state.rollResults = payload;
      setRollResults(payload);
      if (payload?.complete) hideRollOverlay();
      break;

    case 'SCREEN':
      if (!applySeq(seq)) return;
      state.lastScreen = payload;
      showScreen(true);
      renderScreen(payload, state.me?.id);
      break;

    case 'ERROR':
      setStatus(`Error: ${payload?.code || ''} ${payload?.message || ''}`);
      break;

    case 'PING':
      break;

    default:
      // Unknown types are ignored.
      break;
  }
}

function applyState(snap) {
  state.phase = snap?.phase || 'disconnected';
  state.me    = snap?.me    || null;
  state.lobby = snap?.lobby || null;

  if (state.phase === 'lobby') {
    showScreen(false);
    setLobbyVisible(true);
    renderLobby();
  } else if (state.phase === 'roll_turn_order') {
    setLobbyVisible(false);
    showScreen(false);
    // ROLL_PROMPT decides overlay visibility
  } else {
    setLobbyVisible(false);
    showScreen(!!state.lastScreen);
    if (state.lastScreen) renderScreen(state.lastScreen, state.me?.id);
  }
}

function renderLobby() {
  const catalog = state.lobby?.catalog;
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  renderCatalog(entries, state);
  setReadyEnabled(Boolean(state.me?.charId));
}
