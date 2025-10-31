// js/router.js — FULL FILE (patch-aware, blob-safe)
import { state } from './state.js';
import { renderCatalog } from './features/catalog.js';
import { setStatus, setLobbyVisible, setPhase } from './ui.js';
import { wsSend } from './ws.js';

// ---------- tiny helpers ----------
const ensureLobbyShown = () => { setLobbyVisible(true); setPhase && setPhase('lobby'); };
const A = (x) => Array.isArray(x) ? x : (x ? [x] : []);
const U = (s) => String(s || '').toUpperCase();
const normType = (t) => {
  const s = U(t);
  if (!s) return 'TEXT';
  if (s.includes('BROADCAST_STATE') || s === 'STATE' || s.includes('STATEENVELOPE')) return 'STATE';
  if (s.includes('CATALOG') && s.includes('PATCH')) return 'CHARACTER_CATALOG_PATCH';
  if (s.includes('CATALOG')) return 'CHARACTER_CATALOG';
  if (s === 'HELLO_OK' || s === 'WELCOME' || s === 'ROOM_OPEN' || s === 'PONG') return 'HELLO';
  return s;
};

// Find the first object in a (possibly nested) payload that has any of add/update/remove arrays
function findPatchTriplet(root) {
  const q = [root];
  let guard = 0;
  while (q.length && guard++ < 1000) {
    const n = q.shift();
    if (!n || typeof n !== 'object') continue;
    const cand = n.payload || n.body || n.data || n;
    const hasTriplet = (o) =>
      o && (Array.isArray(o.add) || Array.isArray(o.update) || Array.isArray(o.remove));
    if (hasTriplet(cand)) return cand;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === 'object') q.push(v);
    }
  }
  return null;
}

function applyCatalogPatch(trip) {
  if (!state.catalog) state.catalog = { entries: [] };
  const list = state.catalog.entries;

  if (Array.isArray(trip.add)) {
    for (const e of trip.add) {
      const id = String(e.id ?? e.characterId ?? e.key ?? Math.random());
      const i = list.findIndex(x => String(x.id) === id);
      if (i >= 0) list[i] = { ...list[i], ...e, id };
      else list.push({ ...e, id });
    }
  }
  if (Array.isArray(trip.update)) {
    for (const e of trip.update) {
      const id = String(e.id ?? e.characterId ?? e.key);
      const i = list.findIndex(x => String(x.id) === id);
      if (i >= 0) list[i] = { ...list[i], ...e, id };
    }
  }
  if (Array.isArray(trip.remove)) {
    const removes = trip.remove.map(x => String(x));
    const keep = [];
    for (const e of list) if (!removes.includes(String(e.id))) keep.push(e);
    state.catalog.entries = keep;
  }
}

function setDbg(s) {
  const pill = document.querySelector('#dbgLast, .dbg-last, .pill-last');
  if (pill) pill.textContent = `last: ${s}`;
}

// ---------- main router ----------
export async function onSocketMessage(msg) {
  try {
    // Accept raw string, already-parsed object, or Event with .data (Blob/ArrayBuffer/String)
    let raw = msg;
    if (raw && typeof raw === 'object' && 'data' in raw) raw = raw.data;

    if (raw instanceof Blob) raw = await raw.text();
    else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);

    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s.startsWith('{') || s.startsWith('[')) {
        try { raw = JSON.parse(s); }
        catch { setDbg('TEXT'); setStatus(s); ensureLobbyShown(); return; }
      } else {
        setDbg('TEXT'); setStatus(s); ensureLobbyShown(); return;
      }
    }

    // Now raw is object
    const type = normType(raw.type || raw.msgType || raw.kind);
    setDbg(type);

    switch (type) {
      case 'HELLO': {
        setStatus('Connected. Waiting for host...');
        ensureLobbyShown();
        // Ask host to rehydrate us
        wsSend && wsSend({ type: 'REQUEST_SNAPSHOT' });
        wsSend && wsSend({ type: 'REQUEST_CATALOG' });
        return;
      }

      case 'CHARACTER_CATALOG': {
        ensureLobbyShown();
        const p = raw.payload || raw.data || raw;
        const entries = A(p.entries || p.list || p.characters);
        if (!state.catalog) state.catalog = { entries: [] };
        state.catalog.entries = entries.slice();
        renderCatalog(state.catalog.entries);
        return;
      }

      case 'STATE': {
        const env = raw.envelope || raw.state || raw;
        const header = env.header || env.stateHeader || {};
        const body   = env.payload || env.state || env.data || {};
        const typed  = normType(header.type || header.typeName || body.type || body.subtype);

        // 1) Full catalog embedded in body
        if (typed === 'CHARACTER_CATALOG' || Array.isArray(body.entries)) {
          ensureLobbyShown();
          if (!state.catalog) state.catalog = { entries: [] };
          state.catalog.entries = A(body.entries || body.list || body.characters).slice();
          renderCatalog(state.catalog.entries);
          return;
        }

        // 2) Patch batches (this is what your host is sending)
        if (typed === 'CHARACTER_CATALOG_PATCH' || Array.isArray(env.patches) || Array.isArray(env.patch)) {
          const packs = A(env.patches || env.patch);
          if (!state.catalog) state.catalog = { entries: [] };
          for (const pack of packs) {
            const trip = findPatchTriplet(pack);
            if (trip) applyCatalogPatch(trip);
          }
          ensureLobbyShown();
          renderCatalog(state.catalog.entries);
          return;
        }

        // 3) Defensive: anywhere in the envelope has a patch triplet
        const trip = findPatchTriplet(env);
        if (trip) {
          if (!state.catalog) state.catalog = { entries: [] };
          applyCatalogPatch(trip);
          ensureLobbyShown();
          renderCatalog(state.catalog.entries);
          return;
        }

        return;
      }

      default:
        // Unknowns: try defensive render if entries exist
        const p = raw.payload || raw.data || raw;
        if (p && Array.isArray(p.entries)) {
          ensureLobbyShown();
          if (!state.catalog) state.catalog = { entries: [] };
          state.catalog.entries = p.entries.slice();
          renderCatalog(state.catalog.entries);
        } else {
          const trip = findPatchTriplet(raw);
          if (trip) {
            if (!state.catalog) state.catalog = { entries: [] };
            applyCatalogPatch(trip);
            ensureLobbyShown();
            renderCatalog(state.catalog.entries);
          }
        }
        return;
    }
  } catch (err) {
    console.log('router error:', err);
  }
}

// Optional: if your ws layer wires events instead of raw strings
export function onSocketEvent(ev) { return onSocketMessage(ev); }
