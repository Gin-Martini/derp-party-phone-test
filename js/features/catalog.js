import { state } from '../state.js';
import { resolvePortraitSrc, setDbg } from '../ui.js';

export function renderCatalog(entries){
  const grid = state.els.charGrid; if (!grid) return;

  const list = Array.isArray(entries) ? entries : [];
  grid.innerHTML = '';

  // Make the grid visible only when we actually have entries
  grid.style.display = list.length ? 'grid' : 'none';

  list.forEach((e, idx)=>{
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
    } else {
      const fb=document.createElement('div'); fb.className='fallback'; fb.textContent=label.slice(0,2).toUpperCase();
      portrait.appendChild(fb);
    }

    const name = document.createElement('div'); name.className='name'; name.textContent = label;

    btn.appendChild(portrait); btn.appendChild(name); grid.appendChild(btn);
  });

  markTaken([]);                 // start from a clean slate
  markSelected(state.myCharId);  // re-highlight my current choice
  setDbg('catalog:' + list.length);
}
