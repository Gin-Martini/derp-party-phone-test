// js/store.js
import { state } from './state.js';
import {
  setLobbyVisible, renderCatalog, setReadyEnabled,
  showRollOverlay, hideRollOverlay, setRollPrompt, setRollResults,
  setStatus, showJoin, showScreen, renderScreen
} from './views/ui.js';
import { clearSession } from './ws.js';

function applySeq(seq, { allowEqual = false } = {}) {
  if (typeof seq !== 'number') return true;
  if (seq < state.lastSeq) return false;
  if (seq === state.lastSeq && !allowEqual) return false;
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
    case 'BROADCAST_STATE': {  // safety: treat as STATE
      const allowEqualSeq = payload && Array.isArray(payload.patches);
      if (!applySeq(seq, { allowEqual: allowEqualSeq })) return;
      applyState(payload);
      break;
    }

    case 'ROLL_PROMPT':
      if (!applySeq(seq)) return;
      state.rollPrompt = payload;
      const meId = state.me?.id;
      const allowed = payload?.allowedPlayers || [];
      const already = new Set((payload?.alreadyRolled || []).map(x => x?.playerId));
      const iCanRoll = meId && allowed.includes(meId) && !already.has(meId);
      setRollPrompt(payload);
      if (iCanRoll) showRollOverlay(payload); else hideRollOverlay();
      break;

    case 'ROLL_RESULT':
      if (!applySeq(seq)) return;
      state.rollResults = payload;
      setRollResults(payload);
      break;

    case 'SCREEN':
      if (!applySeq(seq)) return;
      state.lastScreen = payload || null;
      showScreen(Boolean(state.lastScreen));
      if (state.lastScreen) renderScreen(state.lastScreen, state.me?.id);
      break;

    case 'ERROR': {
      const message = String(payload?.message || 'Error');
      setStatus(message);
      if (shouldResetSession(payload)) {
        clearSession();
        setLobbyVisible(false);
        showJoin(true);
      }
      break;
    }

    default:
      // ignore unknown messages
      break;
  }
}

function shouldResetSession(payload) {
  const code = payload?.code;
  if (code) {
    const normalized = String(code).toUpperCase();
    if (normalized === 'ROOM_NOT_FOUND' ||
        normalized === 'UNKNOWN_ROOM' ||
        normalized === 'INVALID_SESSION' ||
        normalized === 'SESSION_EXPIRED') {
      return true;
    }
  }

  const message = String(payload?.message || '').toLowerCase();
  if (!message) return false;

  return message.includes('room not found') ||
         message.includes('no such room') ||
         message.includes('unknown room') ||
         message.includes('room does not exist') ||
         message.includes('room expired') ||
         message.includes('room closed');
}

// ----- STATE / PATCH handling -----
function applyState(payload) {
  if (!payload) return;

  // If host sent RFC6902-style patches, apply them to live state
  if (Array.isArray(payload.patches)) {
    jsonPatch(state, payload.patches);
  } else {
    // Merge snapshot fields
    if (payload.phase !== undefined) state.phase = payload.phase;
    if (payload.me !== undefined)    state.me = payload.me;
    if (payload.lobby !== undefined) state.lobby = payload.lobby;
  }

  // Default shapes to keep UI stable
  if (!state.lobby) state.lobby = { players: [], catalog: { version: 0, entries: [] }, allReady: false };
  if (!state.lobby.catalog) state.lobby.catalog = { version: 0, entries: [] };
  if (!Array.isArray(state.lobby.players)) state.lobby.players = [];
  if (!Array.isArray(state.lobby.catalog.entries)) state.lobby.catalog.entries = [];

  const meId = state.me?.id;
  if (!meId) {
    if (state.session?.playerId) {
      clearSession();
    }
    setLobbyVisible(false);
    showJoin(true);
    return;
  }

  // Phase → UI
  const phase = String(state.phase || '').toLowerCase();
  if (phase === 'lobby') {
    showJoin(false);
    setLobbyVisible(true);
    renderLobby();
  } else {
    showJoin(false);
    setLobbyVisible(false);
  }
}

function renderLobby() {
  const entries = Array.isArray(state.lobby?.catalog?.entries) ? state.lobby.catalog.entries : [];
  renderCatalog(entries, state);
  setReadyEnabled(Boolean(state.me?.charId));
}

// ----- Minimal JSON Patch (add, remove, replace) -----
function jsonPatch(root, patches) {
  for (const p of patches) {
    const op = String(p.op || '').toLowerCase();
    const { obj, key, parent } = pointerParent(root, p.path, op === 'add');
    if (!obj) continue;

    if (op === 'add') {
      if (Array.isArray(obj)) {
        if (key === '-') obj.push(p.value);
        else obj.splice(indexify(key, obj.length), 0, p.value);
      } else {
        obj[key] = p.value;
      }
    } else if (op === 'replace') {
      if (Array.isArray(obj)) obj[indexify(key, obj.length)] = p.value;
      else obj[key] = p.value;
    } else if (op === 'remove') {
      if (Array.isArray(obj)) obj.splice(indexify(key, obj.length), 1);
      else delete obj[key];
    }
    // ignore test/move/copy
  }
}

function indexify(k, len) {
  const i = Number(k);
  return Number.isInteger(i) ? Math.max(0, Math.min(len, i)) : 0;
}

function decodeToken(t) { return t.replace(/~1/g, '/').replace(/~0/g, '~'); }

function pointerParent(root, path, create) {
  const parts = String(path || '').split('/').slice(1).map(decodeToken);
  if (!parts.length) return { obj: null, key: null };
  let obj = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const token = parts[i];
    if (obj[token] == null) {
      if (!create) return { obj: null, key: null };
      // choose {} or []
      const next = parts[i + 1];
      obj[token] = /^[0-9]+$/.test(next) ? [] : {};
    }
    obj = obj[token];
  }
  return { obj, key: parts[parts.length - 1] };
}
