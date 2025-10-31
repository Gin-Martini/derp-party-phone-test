// js/router.js — FULL FILE (v11.0.2) — forces lobby show on any catalog arrival
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
    ['HELLO', 'HELLO'], ['HELLO_OK', 'HELLO_OK'], ['WELCOME', 'HELLO_OK'],
    ['LOBBY_OPEN', 'LOBBY_OPEN'], ['LOBBY_CLOSED', 'LOBBY_CLOSED'],
    ['STATE', 'STATE'], ['LOBBY_STATE', 'STATE'], ['BROADCAST_STATE', 'STATE'],
    // character flows (normalize a bunch of legacy aliases)
    ['CHARACTER_CATALOG', 'CHARACTER_CATALOG'],
    ['CATALOG', 'CHARACTER_CATALOG'], ['CHARACTERS', 'CHARACTER_CATALOG'],
    ['CHARACTER_LIST', 'CHARACTER_CATALOG'], ['CHAR_LIST', 'CHARACTER_CATALOG'],
    ['CHARACTER_CATALOG_PATCH', 'CHARACTER_CATALOG_PATCH'],
    ['CHARACTER_SELECT', 'CHARACTER_SELECT'],
    ['CHARACTER_TAKEN', 'CHARACTER_TAKEN'], ['SELECTED', 'CHARACTER_TAKEN'],
    // ready
    ['READY', 'READY'], ['UNREADY', 'UNREADY'],
    // roll/turn
    ['TURN_ORDER_START', 'TURN_ORDER_START'],
    ['TURN_ORDER_RESULT', 'TURN_ORDER_RESULT'],
    ['ROLL', 'ROLL'], ['ROLL_RESULT', 'ROLL_RESULT'], ['PLAYER_ROLL', 'PLAYER_ROLL'],
    // misc
    ['TOAST', 'TOAST']
  ]);
  return (t) => map.get(String(t||'').toUpperCase()) || String(t||'').toUpperCase();
})();

const ensureLobbyShown = () => { setLobbyVisible(true); setPhase('lobby'); };
const getArray = (x)=> Array.isArray(x) ? x : (x ? [x] : []);
const has = (o,k)=> o && Object.prototype.hasOwnProperty.call(o,k);

// ---------- main router ----------
export function onSocketMessage(msg) {
  try {
    const m = (typeof msg === 'string') ? JSON.parse(msg) : (msg || {});
    const type = normType(m.type || m.msgType || m.kind);
    setDbg(`last: ${type}`);

    switch (type) {
      // --- connection / lifecycle ---
      case 'HELLO_OK': {
        state.connected = true;
        ensureLobbyShown();
        setStatus('Connected. Waiting for host…');
        // Ask host to rehydrate us (catalog + lobby snapshot)
        wsSend({ type:'REQUEST_SNAPSHOT' });
        wsSend({ type:'REQUEST_CATALOG' });
        wsSend({ type:'LOBBY_SNAPSHOT' });
        return;
      }

      case 'LOBBY_OPEN': {
        ensureLobbyShown();
        setStatus('Lobby open.');
        return;
      }
      case 'LOBBY_CLOSED': {
        setStatus('Lobby closed.');
        return;
      }

      // --- direct catalog payload ---
      case 'CHARACTER_CATALOG': {
        // NEW: force lobby visible if this arrives before HELLO_OK/UI phase swap
        ensureLobbyShown();
        const payload = m.payload || m.data || m;
        const entries = getArray(payload.entries || payload.list || payload.characters);
        state.catalog = state.catalog || {};
        state.catalog.entries = entries;
        renderCatalog(entries);
        setStatus(entries.length ? `Pick a character.` : 'Waiting for host to publish characters…');
        return;
      }

      case 'CHARACTER_CATALOG_PATCH': {
        // NEW: same force-show as above
        ensureLobbyShown();
        const p = m.payload || m.data || m;
        if (!state.catalog) state.catalog = { entries: [] };
        // apply simple patch forms: { add:[...], update:[...], remove:[ids...] }
        if (Array.isArray(p.add))    state.catalog.entries.push(...p.add);
        if (Array.isArray(p.update)) {
          for (const u of p.update) {
            const i = state.catalog.entries.findIndex(e => String(e.id) === String(u.id));
            if (i >= 0) state.catalog.entries[i] = { ...state.catalog.entries[i], ...u };
          }
        }
        if (Array.isArray(p.remove)) {
          state.catalog.entries = state.catalog.entries.filter(e => !p.remove.includes(String(e.id)));
        }
        renderCatalog(state.catalog.entries);
        return;
      }

      case 'CHARACTER_TAKEN': {
        const p = m.payload || m.data || m;
        if (p?.characterId) markTaken(String(p.characterId), true);
        return;
      }

      case 'CHARACTER_SELECT': {
        const p = m.payload || m.data || m;
        if (p?.characterId && isMeFrom(p.playerId, p.playerName)) {
          state.myCharId = String(p.characterId);
          markSelected(state.myCharId);
          enableReadyButton(true);
        }
        return;
      }

      case 'READY':    { setReadyUI(true);  return; }
      case 'UNREADY':  { setReadyUI(false); return; }

      // --- roll / turn overlays (unchanged behavior) ---
      case 'TURN_ORDER_START': { showRollOverlay(); updateRollUI(m); return; }
      case 'TURN_ORDER_RESULT': { updateRollUI(m); return; }
      case 'PLAYER_ROLL':
      case 'ROLL':
      case 'ROLL_RESULT': { updateRollUI(m); return; }

      case 'TOAST': { showToast((m.payload&&m.payload.text)||m.text||''); return; }

      // --- generic state envelopes from host ---
      case 'STATE': {
        const env = m.envelope || m.state || m;
        const header = env.header || env.stateHeader || {};
        const body   = env.payload || env.state || env.data || {};
        const patches = env.patches || env.patch || [];

        // Prefer typed payloads (CharacterCatalogState / CharacterCatalogPatchState)
        const typed = (body && typeof body === 'object') ? (body.type || body.subtype || header.type || header.typeName) : null;
        const t = normType(typed);

        if (t === 'CHARACTER_CATALOG') {
          ensureLobbyShown(); // NEW
          const entries = getArray(body.entries || body.list);
          state.catalog = state.catalog || {};
          state.catalog.entries = entries;
          renderCatalog(entries);
          setStatus(entries.length ? `Pick a character.` : 'Waiting for host to publish characters…');
          return;
        }

        if (t === 'CHARACTER_CATALOG_PATCH') {
          ensureLobbyShown(); // NEW
          const p = body;
          if (!state.catalog) state.catalog = { entries: [] };
          if (Array.isArray(p.add))    state.catalog.entries.push(...p.add);
          if (Array.isArray(p.update)) {
            for (const u of p.update) {
              const i = state.catalog.entries.findIndex(e => String(e.id) === String(u.id));
              if (i >= 0) state.catalog.entries[i] = { ...state.catalog.entries[i], ...u };
            }
          }
          if (Array.isArray(p.remove)) {
            state.catalog.entries = state.catalog.entries.filter(e => !p.remove.includes(String(e.id)));
          }
          renderCatalog(state.catalog.entries);
          return;
        }

        // Fallback: untyped but catalog-shaped state (defensive)
        if (has(body,'entries') && Array.isArray(body.entries)) {
          ensureLobbyShown(); // NEW
          state.catalog = state.catalog || {};
          state.catalog.entries = body.entries.slice();
          renderCatalog(state.catalog.entries);
          return;
        }

        // Apply any taken/selection hints embedded in patches
        if (Array.isArray(patches) && patches.length) {
          for (const patch of patches) {
            if (patch?.type && normType(patch.type) === 'CHARACTER_TAKEN' && patch.characterId) {
              markTaken(String(patch.characterId), true);
            }
          }
        }
        return;
      }

      default:
        // swallow unknowns; useful for dbg
        return;
    }
  } catch (e) {
    console.log('router error:', e);
  }
}
