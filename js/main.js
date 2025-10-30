import { HTTP_BASE } from './config.js';

// --- very small state holder used by this page ---
const els = {
  status:    document.getElementById('status'),
  room:      document.getElementById('room'),
  nameInput: document.getElementById('name'),
  joinBtn:   document.getElementById('btnJoin'),
  toast:     document.getElementById('toast'),
};
function setStatus(s, busy=false){ if(els.status){ els.status.textContent = s + (busy?' …':''); } }
function toast(msg){ if(!els.toast) return; els.toast.textContent = msg; els.toast.style.display='block'; setTimeout(()=>els.toast.style.display='none', 2200); }

// --- JOIN flow ---
async function onJoinClicked(){
  const room = String(els.room?.value||'').trim().toUpperCase();
  const name = String(els.nameInput?.value||'').trim() || 'Player';
  if(!room){ toast('Enter room code'); return; }

  setStatus('Joining', true);
  els.joinBtn?.setAttribute('disabled','true');
  els.joinBtn?.classList.add('btn-disabled');

  try{
    // Force CORS preflight to be obvious in DevTools
    const resp = await fetch(`${HTTP_BASE}/rooms/${encodeURIComponent(room)}/join`, {
      method:'POST',
      mode:'cors',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ name }),
    });

    if(!resp.ok){
      const body = await resp.text().catch(()=>'<no body>');
      console.warn('Join failed', resp.status, body);
      setStatus(`Join failed (${resp.status})`);
      toast(resp.status === 0 ? 'Network/CORS blocked' : 'Could not join room');
      return;
    }

    const j = await resp.json().catch(()=> ({}));
    const playerId = j.playerId || j.id;
    if(!playerId){ setStatus('Join failed (no playerId)'); toast('Bad server response'); return; }

    // If you have a websocket module, connect here using playerId.
    // connectWs({ room, playerId });  // <- your existing code path
    setStatus('Joined — waiting for host');
  }
  catch(err){
    console.error('HTTP error', err);
    setStatus('HTTP error'); toast('Network/CORS error (see console)');
  }
  finally{
    els.joinBtn?.removeAttribute('disabled');
    els.joinBtn?.classList.remove('btn-disabled');
  }
}

// Bind with bullet-proof mobile taps (never passive)
function bindJoin(){
  if(!els.joinBtn) return;
  els.joinBtn.setAttribute('type','button'); // avoid form-submit reloads

  const fire = (e)=>{ e.preventDefault(); e.stopPropagation(); onJoinClicked(); };
  els.joinBtn.addEventListener('pointerup', fire, {passive:false});
  els.joinBtn.addEventListener('click',     fire, {passive:false});
  els.joinBtn.addEventListener('touchend',  fire, {passive:false});
}

function boot(){
  bindJoin();
  setStatus('Ready');
}
document.addEventListener('DOMContentLoaded', boot);
