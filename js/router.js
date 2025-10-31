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
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  return undefined;
};

const toIdList = (v) => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(toIdList).map(x => String(x)).filter(Boolean);
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length && keys.every(k => typeof v[k] === 'boolean')) {
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

    case 'HELLO_OK': {
      const pid = payload.playerId || payload.id;
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

    case 'LOBBY_OPEN': {
      ensureLobbyShown();
      setStatus('Lobby open — pick a character, then Ready.');
      enableReadyButton(!!state.myCharId);
      return;
    }

    case 'LOBBY_CLOSED': {
      setStatus('Lobby closed — waiting…');
      enableReadyButton(false);
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

      // Ready state (mine)
      const readyMap = coalesce(payload, 'readyPlayers', 'readyMap', 'readyByPlayer');
      if (readyMap && typeof readyMap === 'object' && state.playerId) {
        const mine = !!readyMap[state.playerId] || !!readyMap[String(state.playerId)];
        setReadyUI(!!mine);
      }
      if (payload.ready === true  && isMeFrom(selPid, selName)) setReadyUI(true);
      if (payload.ready === false && isMeFrom(selPid, selName)) setReadyUI(false);

      // Trivia pad gating (quiet refresh)
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

    // ===== CHARACTER EVENTS =====
    case 'CHARACTER_SELECT': {
      const pid = coalesce(payload, 'playerId', 'pid', 'player');
      const pname = coalesce(payload, 'playerName', 'name');
      const cid = coalesce(payload, 'charId', 'characterId', 'char', 'id');
      if (cid != null && isMeFrom(pid, pname)) {
        state.myCharId = String(cid);
        markSelected(state.myCharId);
        enableReadyButton(true);
        setDbg('my select=' + state.myCharId);
      }
      return;
    }

    case 'CHARACTER_TAKEN': {
      const tidOne  = coalesce(payload, 'charId', 'characterId', 'id');
      const tidMany = coalesce(payload, 'taken', 'takenIds', 'takenChars', 'selected', 'selectedIds');
      let next = new Set(state.takenChars);
      if (tidMany != null) toIdList(tidMany).forEach(id => next.add(String(id)));
      if (tidOne  != null) next.add(String(tidOne));
      next.delete(state.myCharId || '');
      applyTaken([...next]);
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

    // ===== TURN ORDER / ROLL =====
    case 'TURN_ORDER_START': {
      setPhase('turn_order');
      state.inTurnOrder = true;
      state.myHasRolled = false;
      showRollOverlay('Turn Order');
      updateRollUI();
      setStatus('Rolling for turn order…');
      return;
    }

    case 'PLAYER_ROLL': {
      return;
    }

    case 'ROLL_RESULT': {
      const v = coalesce(payload, 'value', 'v', 'roll', 'result');
      if (v != null && state.els.rollValue) state.els.rollValue.textContent = String(v);
      const done = !!payload.done;
      if (done && state.els.rollState) {
        state.els.rollState.textContent = 'Done';
        state.els.rollState.classList.remove('no'); state.els.rollState.classList.add('ok');
      }
      updateRollUI();
      return;
    }

    case 'TURN_ORDER_RESULT': {
      state.inTurnOrder = false;
      state.myHasRolled = true;
      if (state.els.orderResult) {
        state.els.orderResult.classList.remove('hidden');
        state.els.orderResult.textContent = payload.text || payload.order || 'Order set.';
      }
      updateRollUI();
      return;
    }

    // ===== TRIVIA (PAD GATING ONLY ON PHONE) =====
    case 'TRIVIA_START':
    case 'TRIVIA_SWITCH':
    case 'TRIVIA_ALLOWED':
    case 'TRIVIA_BLOCKED':
    case 'TRIVIA_END': {
      showTriviaPadIfAllowed(payload);
      return;
    }

    default: {
      setDbg('unhandled=' + type);
      return;
    }
  }
}
