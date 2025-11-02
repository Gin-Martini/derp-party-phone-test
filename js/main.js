// js/main.js — join with room code; uses Join API if present, else direct WS fallback
import { state } from './state.js?v=11.0.14';
import { initUi, hideJoinCard, setLobbyVisible, setPhase, showToast } from './ui.js?v=11.0.14';
import { API_BASE, WS_BASE, SESSION_KEY } from './config.js?v=11.0.14';
import { setOnSocketMessage } from './ws.js?v=11.0.14';
import { onSocketMessage } from './router.js?v=11.0.14';

const $ = (s)=>document.querySelector(s);
function setStatus(s, busy=false){
  const el = $('#status'); if (el) el.textContent = s || '';
  if (busy) el?.classList?.add('busy'); else el?.classList?.remove('busy');
}

// Boot
(function boot(){
  setOnSocketMessage(onSocketMessage);
  initUi();
  setLobbyVisible(true); setPhase('lobby');
  setStatus('Disconnected');
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

  // 1) If a Join API is configured, use it.
  if (API_BASE){
    try{
      setStatus('Contacting server…', true);
      const res = await fetch(`${API_BASE.replace(/\/+$/,'')}/api/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode, name })
      });
      if (!res.ok){
        setStatus('Join failed');
        showToast?.(`Join failed (${res.status})`);
        return;
      }
      const { wsUrl, roomId } = await res.json();
      if (!wsUrl){
        setStatus('Join failed'); showToast?.('No wsUrl from server.'); return;
      }
      redirectWithWs(wsUrl, (roomId || roomCode), name);
      return;
    }catch(err){
      setStatus('Join failed');
      showToast?.(String(err?.message || err));
      return;
    }
  }

  // 2) No API? Fall back to direct WS using your relay.
  if (!WS_BASE){
    showToast?.('No relay configured.');
    return;
  }
  redirectWithWs(WS_BASE, roomCode, name);
}

// Redirect so router.js auto-connects and sends IDENTIFY
function redirectWithWs(wsUrl, roomId, name){
  const url = new URL(location.href);
  url.searchParams.set('ws', wsUrl);
  url.searchParams.set('room', roomId);
  url.searchParams.set('name', name);
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  location.href = url.toString();
}
