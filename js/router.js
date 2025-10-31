// js/router.js — FULL FILE (patch-aware, blob-safe)
import { state } from './state.js?v=11.0.1';
import { renderCatalog } from './features/catalog.js?v=11.0.1';
import { setStatus, setLobbyVisible, setPhase } from './ui.js?v=11.0.1';
import { wsSend } from './ws.js';

// ---------- tiny helpers ----------
const ensureLobbyShown = () => { setLobbyVisible(true); setPhase && setPhase('lobby'); };
const A = (x) => Array.isArray(x) ? x : (x ? [x] : []);
const U = (s) => String(s || '').toUpperCase();
const normType = (t) => {
  const s = U(t);
  if (!s) return 'TEXT';
  if (s.includes('BROADCAST_STATE') || s === 'STATE' || s.includes('STATEENVELOPE')) return 'STATE';
  if (s.includes('SNAPSHOT')) return 'SNAPSHOT';
  if (s.includes('CATALOG')) return 'CATALOG';
  return s;
};

// find a {add/update/remove} triplet anywhere in the payload tree
function findTriplet(root) {
  const q = [root];
  while (q.length) {
    const n = q.shift();
    if (!n || typeof n !== 'object') continue;
    const cand = n.payload || n.body || n.data || n;
    const hasTriplet = (o) => o && (Array.isArray(o.add) || Array.isArray(o.update) || Array.isArray(o.remove));
    if (hasTriplet(cand)) return cand;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === 'object') q.push(v);
    }
  }
  return null;
}

function applyCatalogPatch(p) {
  ensureLobbyShown();
  // delegate to catalog feature (understands header + batched patches)
  renderCatalog(p);
  setStatus('Lobby ready.');
}

// ---------- main router ----------
export async function onSocketMessage(msg){
  try {
    // Accept raw string, already-parsed object, or Event with .data (Blob/ArrayBuffer/String)
    let raw = msg;
    if (raw && typeof raw === 'object' && 'data' in raw) raw = raw.data;

    if (raw instanceof Blob) raw = await raw.text();
    else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);

    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const t = normType(o?.type);

    switch (t) {
      case 'STATE':
      case 'SNAPSHOT': {
        ensureLobbyShown();
        const trip = findTriplet(o);
        if (trip) { applyCatalogPatch(trip); return; }
        // Some hosts send a straight snapshot under .payload
        if (o?.payload) { applyCatalogPatch(o.payload); return; }
        break;
      }

      case 'CATALOG': {
        ensureLobbyShown();
        const trip = findTriplet(o);
        if (trip) { applyCatalogPatch(trip); return; }
        break;
      }

      case 'PING': { wsSend({ type:'PONG' }); return; }
    }
  } catch (e) {
    console.log('router parse error', e);
  }
}
