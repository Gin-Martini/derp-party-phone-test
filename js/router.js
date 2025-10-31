// js/router.js — FULL FILE (drop-in)
// Version tag kept for cache-bust parity with other modules.
import { state } from './state.js?v=11.0.1';
import {
  setDbg, setStatus, setLobbyVisible, setPhase, showToast,
  enableReadyButton, setReadyUI, idsEqual, isMeFrom
} from './ui.js?v=11.0.1';
import { renderCatalog, markTaken, markSelected } from './features/catalog.js?v=11.0.1';
import { updateRollUI, showRollOverlay, hideRollOverlay } from './features/rollOverlay.js?v=11.0.1';
import { showTriviaPadIfAllowed } from './features/triviaPad.js?v=11.0.1';
import { wsSend } from './ws.js';

// --- helpers ---
const normType = (() => {
  const map = new Map([
    // connection / hello
    ['HELLO', 'HELLO'], ['HELLO_OK', 'HELLO_OK'], ['WELCOME', 'HELLO_OK'],
    // lobby open/closed/state
    ['LOBBY_OPEN', 'LOBBY_OPEN'], ['LOBBY_CLOSED', 'LOBBY_CLOSED'],
    ['STATE', 'STATE'], ['LOBBY_STATE', 'STATE'],
    // character flows
    ['CHARACTER_CATALOG', 'CHARACTER_CATALOG'],
    ['CATALOG', 'CHARACTER_CATALOG'],
    ['CHARACTERS', 'CHARACTER_CATALOG'],
    ['CHARACTER_LIST', 'CHARACTER_CATALOG'],
    ['CHAR_LIST', 'CHARACTER_CATALOG'],
    ['CHARACTER_SELECT', 'CHARACTER_SELECT'],
    ['CHARACTER_TAKEN', 'CHARACTER_TAKEN'], ['SELECTED', 'CHARACTER_TAKEN'],
    // ready
    ['READY', 'READY'], ['UNREADY', 'UNREADY'],
    // turn order / roll
    ['TURN_ORDER_START', 'TURN_ORDER_START'],
    ['TURN_ORDER_RESULT', 'TURN_ORDER_RESULT'],
    ['ROLL', 'ROLL'], ['ROLL_RESULT', 'ROLL_RESULT'], ['PLAYER_ROLL', 'PLAYER_ROLL'],
    // trivia
    ['TRIVIA_START', 'TRIVIA_START'], ['TRIVIA_SWITCH', 'TRIVIA_SWITCH'],
    ['TRIVIA_END', 'TRIVIA_END'], ['TRIVIA_ALLOWED', 'TRIVIA_ALLOWED'],
    ['TRIVIA_BLOCKED', 'TRIVIA_BLOCKED'],
    // misc
    ['TEXT', 'TEXT'], ['MESSAGE', 'TEXT']
  ]);
  return t => {
    const k = String(t || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    return map.get(k) || k || 'TEXT';
  };
})();

const coalesce = (obj, ...keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
};

const toIdList = v => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(x => String(x));
  if (typeof v === 'object') {
    // map: { id: true } or { id: 1 }
    const keys = Object.keys(v);
    if (keys.length && typeof v[keys[0]] === 'boolean') {
      return keys.filter(k => v[k]).map(String);
    }
    return keys.flatMap(k => toIdList(v[k]));
  }
  return [String(v)];
};

function applyTaken(list) {
  const taken = (list || []).map(String);
  markTaken(taken);                 // updates state.takenChars + disables buttons
}

function ensureLobbyShown() {
  setPhase('lobby');
  setLobbyVisible(true);
  hideRollOverlay();
  enableReadyButton(!!state.myCharId);
}

// --- main router ---
export function onSocketMessage(ev) {
  let data = ev?.data;
  try {
    if (typeof data === 'string' && data.trim().startsWith('{')) data = JSON.parse(data);
  } catch (e) {
    // leave as raw string
  }

  // normalize shape
  const msg = (typeof data === 'object' && data) ? data : { type: 'TEXT', message: String(data ?? '') };
  const rawType = msg.type || msg.kind || msg.event || (msg.payload && msg.payload.type);
  const type = normType(rawType);
  let payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : msg;
  if (payload && typeof payload === 'object') {
    if (payload.state && typeof payload.state === 'object') {
      // merge state-level fields up one layer
      payload = { ...payload, ...payload.state };
    } else if (payload.data && typeof payload.data === 'object') {
      payload = { ...payload, ...payload.data };
    }
  }

  setDbg('msg=' + type);

  // ---- switchboard ----
  switch (type) {

    case 'TEXT': {
      const m = payload.message || payload.text || String(data ?? '');
      if (m) setStatus(m);
      return;
    }

    // ===== HELLO / JOINED =====
    case 'HELLO_OK': {
      const pid = payload.playerId || payload.pid || payload.player;
      const rid = payload.roomId || payload.room;
      if (pid) state.playerId = String(pid);
      if (rid) state.roomId = String(rid);
      setStatus('Joined room.');
      return;
    }

    // ===== LOBBY / CATALOG =====
    case 'CHARACTER_CATALOG': {
      const entries = coalesce(payload, 'entries', 'list', 'characters', 'catalog', 'items') || [];
      ensureLobbyShown();
      renderCatalog(entries); // builds grid fresh
      const taken = coalesce(payload, 'taken', 'takenIds', 'takenChars', 'selected', 'selectedIds');
      if (taken != null) applyTaken(toIdList(taken));
      markSelected(state.myCharId);
      setStatus('Pick a character, then tap “I’m Ready”.');
      return;
    }

    case 'CHARACTER_TAKEN': {
      const tidMany = coalesce(payload, 'taken', 'takenIds', 'ids');
      const tidOne  = coalesce(payload, 'charId', 'characterId', 'id');
      let next = new Set(state.takenChars);
      if (tidMany != null) toIdList(tidMany).forEach(id => next.add(String(id)));
      if (tidOne  != null) next.add(String(tidOne));
      // don't mark my current selection as taken for me
      next.delete(state.myCharId || '');
      applyTaken([...next]);
      return;
    }

    case 'CHARACTER_SELECT': {
      const pid = coalesce(payload, 'playerId', 'pid', 'player');
      const pname = coalesce(payload, 'playerName', 'name');
      const charId = coalesce(payload, 'charId', 'characterId', 'id', 'char');
      if (charId != null && isMeFrom(pid, pname)) {
        state.myCharId = String(charId);
        markSelected(state.myCharId);
        enableReadyButton(true);
      }
      return;
    }

    case 'STATE': {
      // Taken chars
      const taken = coalesce(payload, 'taken', 'takenIds', 'takenChars', 'selected', 'selectedIds');
      if (taken != null) applyTaken(toIdList(taken));

      // My selection (several possible shapes)
      const selPid  = coalesce(payload, 'playerId', 'pid', 'player');
      const selName = coalesce(payload, 'playerName', 'name');
      const selChar = coalesce(payload, 'charId', 'characterId', 'char', 'id');
      if (selChar != null && isMeFrom(selPid, selName)) {
        state.myCharId = String(selChar);
        markSelected(state.myCharId);
        enableReadyButton(true);
      }

      // Trivia gate (allow/block)
      showTriviaPadIfAllowed(payload, { quiet: true });

      // If a catalog is present in STATE, render it here.
      const entries = coalesce(payload, 'entries', 'list', 'characters', 'catalog', 'items');
      if (entries && Array.isArray(entries)) {
        ensureLobbyShown();
        renderCatalog(entries);
        markSelected(state.myCharId);
        setStatus('Pick a character, then tap “I’m Ready”.');
      } else if (payload.entries || payload.characters || payload.catalog) {
        // Catalog implied (maybe empty): still show lobby
        ensureLobbyShown();
      }
      return;
    }

    // ===== READY =====
    case 'READY': {
      const pid = coalesce(payload, 'playerId', 'pid', 'player');
      const pname = coalesce(payload, 'playerName', 'name');
      if (isMeFrom(pid, pname)) setReadyUI(true);
      return;
    }

    case 'UNREADY': {
      const pid = coalesce(payload, 'playerId', 'pid', 'player');
      const pname = coalesce(payload, 'playerName', 'name');
      if (isMeFrom(pid, pname)) setReadyUI(false);
      return;
    }

    // ===== LOBBY OPEN/CLOSE =====
    case 'LOBBY_OPEN': {
      ensureLobbyShown();
      setStatus('Lobby open.');
      return;
    }
    case 'LOBBY_CLOSED': {
      setPhase('closed');
      setLobbyVisible(false);
      setStatus('Lobby closed.');
      return;
    }

    // ===== TURN ORDER / ROLL FLOW =====
    case 'TURN_ORDER_START': {
      setPhase('roll');
      showRollOverlay();
      updateRollUI({ phase: 'start', players: payload.players || [] });
      return;
    }

    case 'PLAYER_ROLL': {
      const who = coalesce(payload, 'playerId', 'pid', 'player');
      const val = coalesce(payload, 'value', 'roll', 'result');
      updateRollUI({ phase: 'rolling', who, val });
      return;
    }

    case 'ROLL_RESULT':
    case 'TURN_ORDER_RESULT':
    case 'ROLL': {
      const order = coalesce(payload, 'order', 'turnOrder', 'players') || [];
      updateRollUI({ phase: 'result', order });
      // lobby UI stays hidden during roll overlay
      return;
    }

    // ===== TRIVIA =====
    case 'TRIVIA_ALLOWED': {
      state.triviaAllowed = true;
      showTriviaPadIfAllowed(payload);
      return;
    }
    case 'TRIVIA_BLOCKED': {
      state.triviaAllowed = false;
      showTriviaPadIfAllowed(payload); // closes if open
      return;
    }
    case 'TRIVIA_START': {
      state.triviaAllowed = true;
      showTriviaPadIfAllowed(payload);
      return;
    }
    case 'TRIVIA_SWITCH': {
      showTriviaPadIfAllowed(payload);
      return;
    }
    case 'TRIVIA_END': {
      state.triviaAllowed = false;
      showTriviaPadIfAllowed(payload);
      return;
    }

    default: {
      setDbg('unhandled=' + type);
      return;
    }
  }
}

// --- outbound helpers (UI -> host) ---
export function sendReady(flag) {
  wsSend({ type: flag ? 'READY' : 'UNREADY' });
}

export function requestCatalog() {
  wsSend({ type: 'CATALOG' });
}

export function selectCharacter(charId) {
  if (!charId) return;
  wsSend({ type: 'CHARACTER_SELECT', charId: String(charId) });
}

export function requestRehydrate() {
  wsSend({ type: 'STATE' });
}

// --- roll overlay interop (optional) ---
export function notifyRollUIVisible(v) {
  if (v != null && state.els.rollPanel) {
    state.els.rollPanel.style.display = v ? '' : 'none';
  }
}

export function setRollValueText(v) {
  if (v != null && state.els.rollValue) state.els.rollValue.textContent = String(v);
}
