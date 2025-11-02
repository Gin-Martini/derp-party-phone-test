// js/main.js — bootstrap + join flow via Join API with graceful fallback
import { state } from './state.js?v=11.0.13';
import { initUi, hideJoinCard, setLobbyVisible, setPhase, showToast } from './ui.js?v=11.0.13';
import { API_BASE, WS_OVERRIDE, SESSION_KEY } from './config.js?v=11.0.13';
import { setOnSocketMessage } from './ws.js?v=11.0.13';
import { onSocketMessage } from './router.js?v=11.0.13';

const $ = (s)=>document.querySelector(s);
function setStatus(s, busy=false){
  const el = $('#status'); if (el) el.textContent = s || '';
  if (busy) el?.classList?.add('busy'); else el?.classList?.remove('busy');
}

// If a direct WS override is present, router.js will auto-connect. Just wire handlers/UI.
(function boot(){
  setOnSocketMessage(onSocketMessage);
  initUi();
  setLobbyVisible(true); setPhase('lobby');
  setStatus(WS_OVERRIDE ? 'Connecting…' : 'Disconnected');

  // Wire the Join button
  const btn = $('#btnJoin'); if (btn) btn.addEventListener('click', onJoinClicked);
})();

// --- JOIN FLOW ---
async function onJoinClicked(e){
  e?.preventDefault?.();

  const roomCode = ($('#room')?.value || '').trim().toUpperCase();
  const name = ($('#name')?.value || '').trim();

  if (!roomCode || !name){
    showToast?.('Enter room code and name.');
    return;
  }

  // If a direct WS is provided in URL, just redirect to let router.js handle IDENTIFY
  if (WS_OVERRIDE){
    redirectWithWs(WS_OVERRIDE, roomCode, name);
    return;
  }

  if (!API_BASE){
    showToast?.('No join service configured.');
    return;
  }

  try{
    setStatus('Contacting server…', true);
    const res = await fetch(`${API_BASE.replace(/\/+$/,'')}/api/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode, name })
    });
    if (!res.ok){
      setStatus('Join failed');
      const t = await safeText(res);
      showToast?.(t || `Join failed (${res.status})`);
      return;
    }
    const { wsUrl, roomId } = await res.json();
    if (!wsUrl){
      setStatus('Join failed');
      showToast?.('No wsUrl from server.');
      return;
    }
    redirectWithWs(wsUrl, roomId || roomCode, name);
  }catch(err){
    setStatus('Join failed');
    showToast?.(String(err?.message || err));
  }
}

function redirectWithWs(wsUrl, roomId, name){
  // Preserve current path; add params the router understands
  const url = new URL(location.href);
  url.searchParams.set('ws', wsUrl);
  url.searchParams.set('room', roomId);
  url.searchParams.set('name', name);
  // Clear any stale session
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  location.href = url.toString();
}

async function safeText(res){ try { return await res.text(); } catch { return ''; } }
