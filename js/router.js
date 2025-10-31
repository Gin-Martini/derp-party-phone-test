// js/router.js — FULL FILE (drop-in)
// Imports keep the same cache-bust version to match your other modules.
import { state } from './state.js?v=11.0.1';
import {
  setDbg, setStatus, setLobbyVisible, setPhase, showToast,
  enableReadyButton, setReadyUI, idsEqual, isMeFrom
} from './ui.js?v=11.0.1';
import { renderCatalog, markTaken, markSelected } from './features/catalog.js?v=11.0.1';
import { updateRollUI, showRollOverlay, hideRollOverlay } from './features/rollOverlay.js?v=11.0.1';
import { showTriviaPadIfAllowed } from './features/triviaPad.js?v=11.0.1';
import { wsSend } from './ws.js';

// ---------- helpers ----------
const normType = (() => {
  const map = new Map([
    // connection / hello
    ['HELLO', 'HELLO'], ['HELLO_OK', 'HELLO_OK'], ['WELCOME', 'HELLO_OK'],

    // state envelopes (host sends both)
    ['STATE', 'STATE'], ['LOBBY_STATE', 'STATE'], ['BROADCAST_STATE', 'STATE'],
    ['SNAPSHOT', 'STATE'],

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

    // turn/roll
    ['TURN_ORDER_START', 'TURN_ORDER_START'],
    ['TURN_ORDER_RESULT', 'TURN_ORDER_RESULT'],
    ['ROLL', 'ROLL'], ['ROLL_RESULT', 'ROLL_RESULT'], ['PLAYER_ROLL', 'PLAYER_ROLL'],

    // trivia
    ['TRIVIA_START', 'TRIVIA_START'], ['TRIVIA_END', 'TRIVIA_END'],

    // fallthrough
    [undefined, 'UNKNOWN'], [null, 'UNKNOWN'], ['', 'UNKNOWN']
  ]);
  return (t) => (t ? (map.get(String(t).toUpperCase()) || String(t).toUpperCase()) : 'UNKNOWN');
})();

const looksLikeB64 = (s) => typeof s === 'string' && s.length > 100 && /^[A-Za-z0-9+/=]+$/.test(s);
const toDataUrl = (u, d) => (u ? u : looksLikeB64(d) ? 'data:image/png;base64,' + d : '');

const toIdList = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
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
  markTaken(taken); // updates state.takenChars + disables buttons
}

function ensureLobbyShown() {
  setPhase('lobby');
  setLobbyVisible(true);
  hideRollOverlay();
  enableReadyButton(!!state.myCharId);
}

function coalesce(obj, ...path) {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// Depth-first search for an array of catalog entries in any envelope/patch shape
function findCatalogEntries(payload) {
  // common spots
  if (Array.isArray(payload?.entries)) return payload.entries;
  if (Array.isArray(payload?.catalog?.entries)) return payload.catalog.entries;
  if (Array.isArray(payload?.lobby?.characterCatalog?.entries)) return payload.lobby.characterCatalog.entries;

  // patches / partials
  const packs = []
    .concat(payload?.patch || [])
    .concat(payload?.patches || [])
    .concat(payload?.parts || [])
    .concat(payload?.batches || []);
  for (const p of packs) {
    if (Array.isArray(p?.entries)) return p.entries;
    if (Array.isArray(p?.value?.entries)) return p.value.entries;
  }

  // fallback: recursive search for an array of objects that look like entries
  let found = null;
  (function dfs(x){
    if (found || !x) return;
    if (Array.isArray(x)) {
      if (x.length && typeof x[0] === 'object' && (('id' in x[0]) || ('label' in x[0]) || ('portrait' in x[0]))) {
        found = x; return;
      }
      for (const it of x) dfs(it);
      return;
    }
    if (typeof x === 'object') {
      for (const k in x) { if (Object.prototype.hasOwnProperty.call(x,k)) dfs(x[k]); if (found) return; }
    }
  })(payload);

  return found || [];
}

function normalizeEntry(e) {
  if (!e) return null;
  const id = String(e.id ?? e.charId ?? e.key ?? '');
  if (!id) return null;
  const label = e.label ?? e.name ?? id;
  const url = toDataUrl(e.portraitUrl || e.url, e.portrait || e.data);
  return { id, label, url };
}

// ---------- main router ----------
export function onSocketMessage(ev) {
  // Accept either a MessageEvent or an already-parsed object/string
  let data = (ev && typeof ev === 'object' && Object.prototype.hasOwnProperty.call(ev, 'data'))
    ? ev.data
    : ev;

  // If string JSON, parse
  if (typeof data === 'string') {
    const s = data.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { data = JSON.parse(s); } catch { /* leave as string */ }
    }
  }

  // Normalize shape -> { type, payload? }
  const msg = (data && typeof data === 'object') ? data : { type: 'TEXT', message: String(data ?? '') };
  const rawType = msg.type || msg.kind || msg.event || (msg.payload && msg.payload.type);
  const type = normType(rawType);
  let payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : msg;

  // Peel common wrapper fields up one layer
  if (payload && typeof payload === 'object') {
    if (payload.state && typeof payload.state === 'object') payload = { ...payload, ...payload.state };
    else if (payload.data && typeof payload.data === 'object') payload = { ...payload, ...payload.data };
  }

  setDbg('msg=' + type);

  switch (type) {
    case 'TEXT': {
      const m = payload.message || payload.text || '';
      if (m) setStatus(m);
      return;
    }

    case 'HELLO_OK': {
      const pid = payload.playerId || payload.id;
      const rid = payload.roomId || payload.room;
      if (pid) state.playerId = String(pid);
      if (rid) state.roomId = String(rid);
      setStatus('Joined room. Waiting for host…');
      ensureLobbyShown();
      return;
    }

    case 'STATE':
    case 'CHARACTER_CATALOG': {
      // entries + taken come through in a few shapes; be permissive
      ensureLobbyShown();

      const entriesRaw = findCatalogEntries(payload);
      if (entriesRaw && entriesRaw.length) {
        const entries = entriesRaw.map(normalizeEntry).filter(Boolean);
        if (entries.length) renderCatalog(entries);
      }

      const takenList =
        toIdList(payload.takenCharIds) ||
        toIdList(payload.taken) ||
        toIdList(payload.selected) ||
        toIdList(payload.picked);
      if (takenList && takenList.length) applyTaken(takenList);

      // Keep "ready" button state sane
      enableReadyButton(!!state.myCharId);
      return;
    }

    case 'CHARACTER_SELECT': {
      const cid = payload.charId || payload.characterId || payload.id;
      const from = payload.playerId || payload.senderId;
      if (!cid) return;
      if (isMeFrom(from)) {
        state.myCharId = String(cid);
        markSelected(String(cid));
        enableReadyButton(true);
      } else {
        // someone else chose -> mark taken
        markTaken([String(cid)]);
      }
      return;
    }

    case 'CHARACTER_TAKEN': {
      applyTaken(toIdList(payload.taken || payload.charId || payload.id));
      return;
    }

    case 'READY': {
      if (isMeFrom(payload.playerId || payload.senderId)) setReadyUI(true);
      return;
    }

    case 'UNREADY': {
      if (isMeFrom(payload.playerId || payload.senderId)) setReadyUI(false);
      return;
    }

    // --- roll / turn-order (no-ops here but keep hooks) ---
    case 'TURN_ORDER_START':
    case 'TURN_ORDER_RESULT':
    case 'ROLL':
    case 'ROLL_RESULT':
    case 'PLAYER_ROLL': {
      updateRollUI(payload);
      return;
    }

    // --- trivia (gate opens on any-join elsewhere; show if allowed) ---
    case 'TRIVIA_START':
    case 'TRIVIA_END': {
      showTriviaPadIfAllowed();
      return;
    }

    default: {
      // benign debug for unknowns
      setDbg('unhandled:' + (rawType || type));
      return;
    }
  }
}
