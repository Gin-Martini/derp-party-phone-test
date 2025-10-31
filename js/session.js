import { SESSION_KEY } from './config.js?v=11.0.5';
import { state } from './state.js?v=11.0.5';

export function saveSession() {
  if (!state.roomId || !state.playerId) return;
  const name = (state.els.nameInput?.value || '').trim() || 'Player';
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId: state.roomId, playerId: state.playerId, name })); } catch {}
}
export function clearSession(){ try { localStorage.removeItem(SESSION_KEY); } catch {} }
export function loadSession(){
  try {
    const j = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return (j && j.roomId && j.playerId) ? j : null;
  } catch { return null; }
}
