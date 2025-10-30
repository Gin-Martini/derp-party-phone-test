import { state } from '../state.js';
import { resolvePortraitSrc, setDbg } from '../ui.js';

export function renderCatalog(entries){
  const grid = state.els.charGrid; if (!grid) return;
  grid.innerHTML = '';
  (entries||[]).forEach((e, idx)=>{
    const id = e.id;
    const label = e.label || e.id || ('Char ' + (idx+1));
    const src = resolvePortraitSrc({
      url: e.portraitUrl || e.imageUrl || e.url || '',
      data: e.portraitData || e.portrait || ''
    });

    const btn = document.createElement('button');
    btn.className = 'charBtn'; btn.dataset.charId = id; btn.type = 'button';

    const portrait = document.createElement('div'); portrait.className = 'portrait';
    if (src){
      const img = document.createElement('img');
      img.loading='lazy'; img.decoding='async'; img.crossOrigin='anonymous'; img.referrerPolicy='no-referrer'; img.src = src;
      img.onerror = () => { portrait.innerHTML=''; const fb=document.createElement('div'); fb.className='fallback'; fb.textContent=label.slice(0,2).toUpperCase(); portrait.appendChild(fb); };
      portrait.appendChild(img);
    } else { const fb=document.createElement('div'); fb.className='fallback'; fb.textContent=label.slice(0,2).toUpperCase(); portrait.appendChild(fb); }

    const name = document.createElement('div'); name.className='name'; name.textContent = label;

    btn.appendChild(portrait); btn.appendChild(name); grid.appendChild(btn);
  });

  markTaken([]);
  markSelected(state.myCharId);
}

export function markTaken(list){
  state.takenChars.clear();
  (list || []).forEach(id => state.takenChars.add(String(id)));
  const grid = state.els.charGrid; if (!grid) return;
  [...grid.querySelectorAll('.charBtn')].forEach(b => {
    const id = b.dataset.charId;
    const isTaken = state.takenChars.has(id);
    const isMine  = (id === state.myCharId);
    b.classList.toggle('taken', isTaken && !isMine);
    b.disabled = isTaken && !isMine;
  });
}

export function markSelected(id){
  const grid = state.els.charGrid; if (!grid) return;
  [...grid.querySelectorAll('.charBtn')].forEach(b => {
    b.classList.toggle('selected', b.dataset.charId === id);
  });
  setDbg('selected=' + id);
}
