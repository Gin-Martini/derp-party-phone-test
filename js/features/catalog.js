// js/features/catalog.js — FULL FILE (adds empty-state hint)
import { state } from '../state.js?v=11.0.8';
import { setDbg, resolvePortraitSrc } from '../ui.js?v=11.0.8';

export function renderCatalog(entries) {
  const grid = state.els.charGrid;
  if (!grid) return;

  // Clear and (re)fill
  grid.replaceChildren();

  const list = entries || [];
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
    const label = e.label || e.id || ('Char ' + (idx + 1));
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
