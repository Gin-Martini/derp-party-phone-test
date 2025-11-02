import { SESSION_KEY } from './config.js?v=11.0.12';
import { state } from './state.js?v=11.0.12';

export function saveSession() {
  if (!state.roomId || !state.playerId) return;
  const name = (state.els.nameInput?.value || '').trim() || 'Player';
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId: state.roomId, playerId: state.playerId, name })); } catch {}
}
export function clearSession(){
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  try { localStorage.removeItem('dp.session'); } catch {}
}
export function loadSession(){
  try {
    const raw = localStorage.getItem(SESSION_KEY) ?? localStorage.getItem('dp.session');
    if (!raw) return null;
    const j = JSON.parse(raw);
    return (j && j.roomId && j.playerId) ? j : null;
  } catch { return null; }
}
