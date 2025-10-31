// js/features/catalog.js — FULL FILE (adds empty-state hint + deep extract helper)
import { state } from '../state.js?v=11.0.12';
import { setDbg, resolvePortraitSrc, showToast, enableReadyButton } from '../ui.js?v=11.0.12';
import { wsSend } from '../ws.js?v=11.0.12';

const ID_KEYS = ['id', 'characterId', 'key', 'slug', 'code'];
const LOOKS_LIKE_ENTRY_KEYS = ['label', 'name', 'title', 'portrait', 'portraitUrl', 'portraitData', 'imageUrl'];

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

export function renderCatalog(entries) {
  const list = normalizeEntries(entries);

  if (!state.catalog) state.catalog = { entries: [] };
  state.catalog.entries = list;
  state._pendingCatalog = list;

  const grid = state.els.charGrid;
  if (!grid) return;

  attachCatalogHandlers();

  // Once the grid is available we can flush any pending catalog into it.
  state._pendingCatalog = null;

  // Clear and (re)fill
  grid.replaceChildren();
  if (list.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'emptyHint';
    hint.textContent = 'Waiting for the host to publish characters…';
    grid.appendChild(hint);
    setDbg('catalog: empty');
    return;
  }

  list.forEach((e, idx) => {
    const id    = String(e.id ?? idx);
    const label = e.label || e.name || e.title || e.id || ('Char ' + (idx + 1));
    const src   = resolvePortraitSrc({
      url:  e.portraitUrl || e.imageUrl || e.url || '',
      data: e.portraitData || e.portrait || ''
    });

    const btn = document.createElement('button');
    btn.className = 'charBtn';
    btn.type = 'button';
    btn.dataset.charId = id;

    const portrait = document.createElement('div');
    portrait.className = 'portrait';
    if (src) {
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
        fb.textContent = label.slice(0, 2).toUpperCase();
        portrait.appendChild(fb);
      };
      portrait.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'fallback';
      fb.textContent = label.slice(0, 2).toUpperCase();
      portrait.appendChild(fb);
    }

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = label;

    btn.appendChild(portrait);
    btn.appendChild(name);
    grid.appendChild(btn);
  });

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
