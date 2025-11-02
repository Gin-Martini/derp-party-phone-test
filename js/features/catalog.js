// js/features/catalog.js — FULL FILE (adds empty-state hint + deep extract helper)
import { state } from '../state.js?v=11.0.12';
import { setDbg, resolvePortraitSrc, showToast, enableReadyButton, setReadyUI } from '../ui.js?v=11.0.12';
import { wsSend } from '../ws.js?v=11.0.12';

const ID_KEYS = ['id', 'characterId', 'key', 'slug', 'code'];
const LOOKS_LIKE_ENTRY_KEYS = ['label', 'name', 'title', 'portrait', 'portraitUrl', 'portraitData', 'imageUrl'];

function stableValueForFingerprint(value, seen, depth = 0) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'function') return '__fn__';
  if (type === 'symbol') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (depth > 4) return value.length;
    return value.map(item => stableValueForFingerprint(item, seen, depth + 1));
  }
  if (type === 'object') {
    if (seen.has(value)) return '__cycle__';
    seen.add(value);
    if (depth > 4) return Object.keys(value).sort();
    const out = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const val = value[key];
      out[key] = val === undefined ? '__undef__' : stableValueForFingerprint(val, seen, depth + 1);
    }
    return out;
  }
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

// --- replace existing fingerprintEntries with this stable version ---
function fingerprintEntries(list) {
  try {
    const stable = Array.from(list || []).map((entry) => {
      const raw = entry?.raw || entry || {};
      const id =
        String(entry?.id ??
               raw.id ?? raw.characterId ?? raw.key ?? raw.slug ?? raw.code ?? '');
      const label = String(raw.label ?? raw.name ?? raw.title ?? id);
      // Use the same portrait resolver the renderer uses so hashes match reality
      const portrait = resolvePortraitSrc({
        url: raw.portraitUrl ?? raw.imageUrl,
        data: raw.portraitData ?? raw.portrait
      });
      return `${id}|${label}|${portrait}`;
    });
    return JSON.stringify(stable);
  } catch {
    return `len:${Array.isArray(list) ? list.length : 0}`;
  }
}

function normalizeEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    let id = null;
    for (const k of ID_KEYS) {
      if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') {
        id = raw[k];
        break;
      }
    }
    if (id === null) id = idx;
    out.push({ ...raw, id: String(id) });
  });
  return out;
}

function looksLikeCatalogEntry(node) {
  if (!node || typeof node !== 'object') return false;
  return LOOKS_LIKE_ENTRY_KEYS.some(k => node[k] !== undefined && node[k] !== null && String(node[k]).trim() !== '');
}

function tryArrayAsCatalog(arr, { allowEmpty = false } = {}) {
  if (!Array.isArray(arr)) return null;
  if (!arr.length) return allowEmpty ? [] : null;
  const objects = arr.filter(item => item && typeof item === 'object');
  if (!objects.length) return null;
  if (!objects.some(looksLikeCatalogEntry)) return null;
  return normalizeEntries(objects);
}

export function extractCatalogEntries(root, guardLimit = 4000) {
  if (!root || typeof root !== 'object') return null;
  const seen = new Set();
  const queue = [root];
  let guard = 0;

  while (queue.length && guard++ < guardLimit) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      const out = tryArrayAsCatalog(node);
      if (out && out.length) return out;
      for (const item of node) if (item && typeof item === 'object') queue.push(item);
      continue;
    }

    // direct property hits first
    if (Array.isArray(node.entries)) {
      const out = tryArrayAsCatalog(node.entries, { allowEmpty: true });
      if (out !== null) return out;
    }
    if (Array.isArray(node.characters)) {
      const out = tryArrayAsCatalog(node.characters, { allowEmpty: true });
      if (out !== null) return out;
    }
    if (Array.isArray(node.catalog)) {
      const out = tryArrayAsCatalog(node.catalog, { allowEmpty: true });
      if (out !== null) return out;
    }
    if (Array.isArray(node.list)) {
      const out = tryArrayAsCatalog(node.list, { allowEmpty: false });
      if (out) return out;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return null;
}

function attachCatalogHandlers(){
  const grid = state.els.charGrid;
  if (!grid || grid._dpCatalogBound) return;

  const onClick = (ev) => {
    const btn = ev.target?.closest?.('.charBtn');
    if (!btn) return;
    ev.preventDefault?.();
    const charId = btn.dataset?.charId;
    if (!charId) return;
    if (btn.classList.contains('taken')) {
      showToast?.('That character is already taken.');
      return;
    }
    selectCharacter(charId, btn);
  };

  grid.addEventListener('click', onClick, { passive: false });
  grid._dpCatalogBound = true;
}

function selectCharacter(charId, btn){
  const cleanId = String(charId || '').trim();
  if (!cleanId) return;

  const label = btn?.querySelector?.('.name')?.textContent?.trim() || cleanId;
  state.myCharId = cleanId;
  if (state.myReady) setReadyUI(false);
  markSelected(cleanId);
  enableReadyButton(true);
  setDbg(`pick:${cleanId}`);

  const base = {
    roomId: state.roomId || undefined,
    playerId: state.playerId || undefined,
    characterId: cleanId,
    value: cleanId,
    id: cleanId,
    label
  };

  try { wsSend({ type: 'INTENT', intent: 'CHARACTER_SELECT', ...base }); } catch {}
  try { wsSend({ type: 'CHARACTER_SELECT', ...base }); } catch {}
  try { wsSend({ type: 'SELECT_CHARACTER', ...base }); } catch {}
}

// --- in renderCatalog(entries), add the empty-tick guard right after list normalization ---
export function renderCatalog(entries) {
  const list = normalizeEntries(entries);

  if (!state.catalog) state.catalog = { entries: [] };
  state.catalog.entries = list;
  state._pendingCatalog = list;

  const grid = state.els.charGrid;
  if (!grid) return;

  attachCatalogHandlers();

  // NEW: ignore transient empty ticks to prevent flicker
  if ((!list || list.length === 0) && grid.children && grid.children.length) {
    setDbg('catalog: ignore empty tick');
    return;
  }

  const nextFingerprint = fingerprintEntries(list);
  const prevFingerprint = state.catalogFingerprint;

  // Once the grid is available we can flush any pending catalog into it.
  state._pendingCatalog = null;

  if (prevFingerprint && nextFingerprint === prevFingerprint && grid.children.length) {
    markSelected(state.myCharId);
    if (state.takenChars && state.takenChars.size) markTaken(state.takenChars);
    enableReadyButton(!!state.myCharId);
    setDbg(`catalog: ${list.length} entries (unchanged)`);
    return;
  }

  state.catalogFingerprint = nextFingerprint;
  
  const existing = new Map();
  grid.querySelectorAll('.charBtn').forEach((btn) => {
    const id = btn?.dataset?.charId;
    if (id) existing.set(id, btn);
  });

  const desiredOrder = [];
  const seen = new Set();

  const ensurePortrait = (portrait, label, src) => {
    if (!portrait) return;
    const desiredInitials = label.slice(0, 2).toUpperCase();
    const currentImg = portrait.querySelector('img');
    if (src) {
      if (currentImg && currentImg.getAttribute('src') === src) return;
      if (currentImg) {
        currentImg.src = src;
      } else {
        portrait.innerHTML = '';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        img.src = src;
        img.onerror = () => {
          portrait.innerHTML = '';
          const fb = document.createElement('div');
          fb.className = 'fallback';
          fb.textContent = desiredInitials;
          portrait.appendChild(fb);
        };
        portrait.appendChild(img);
      }
      const fb = portrait.querySelector('.fallback');
      if (fb) fb.remove();
      return;
    }

    if (currentImg) currentImg.remove();
    let fallback = portrait.querySelector('.fallback');
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.className = 'fallback';
      portrait.appendChild(fallback);
    }
    fallback.textContent = desiredInitials;
  };

  const buildButton = (entry, idx) => {
    const id = String(entry.id ?? idx);
    const label = entry.label || entry.name || entry.title || entry.id || (`Char ${idx + 1}`);
    const src = resolvePortraitSrc({
      url: entry.portraitUrl || entry.imageUrl || entry.url || '',
      data: entry.portraitData || entry.portrait || ''
    });

    let btn = existing.get(id);
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'charBtn';
      btn.type = 'button';
      btn.dataset.charId = id;

      const portrait = document.createElement('div');
      portrait.className = 'portrait';
      btn.appendChild(portrait);

      const name = document.createElement('div');
      name.className = 'name';
      btn.appendChild(name);
    }

    btn.dataset.charId = id;

    const portrait = btn.querySelector('.portrait');
    ensurePortrait(portrait, label, src);

    const name = btn.querySelector('.name');
    if (name && name.textContent !== label) name.textContent = label;

    desiredOrder.push(btn);
    seen.add(id);
  };

  if (!list.length) {
    grid.querySelectorAll('.charBtn').forEach((btn) => btn.remove());
    if (!grid.querySelector('.emptyHint')) {
      const hint = document.createElement('div');
      hint.className = 'emptyHint';
      hint.textContent = 'Waiting for the host to publish characters…';
      grid.appendChild(hint);
    }
    enableReadyButton(false);
    setDbg('catalog: empty');
    return;
  }

  list.forEach((entry, idx) => buildButton(entry, idx));

  existing.forEach((btn, id) => {
    if (!seen.has(id)) btn.remove();
  });

  const hint = grid.querySelector('.emptyHint');
  if (hint) hint.remove();

  desiredOrder.forEach((btn) => {
    grid.appendChild(btn);
  });

  markSelected(state.myCharId);
  if (state.takenChars && state.takenChars.size) markTaken(state.takenChars);
  enableReadyButton(!!state.myCharId);
  setDbg(`catalog: ${list.length} entries`);
}

// Optional helpers if you already import these elsewhere:
export function markTaken(takenSet){
  const grid = state.els.charGrid; if (!grid) return;
  const taken = new Set(Array.from(takenSet || []));
  grid.querySelectorAll('.charBtn').forEach(btn=>{
    const id = btn.dataset.charId;
    btn.classList.toggle('taken', taken.has(id));
    btn.disabled = taken.has(id);
  });
}

export function markSelected(myId){
  const grid = state.els.charGrid; if (!grid) return;
  grid.querySelectorAll('.charBtn').forEach(btn=>{
    btn.classList.toggle('selected', btn.dataset.charId === myId);
  });
}
