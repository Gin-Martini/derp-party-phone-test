import { state } from './state.js?v=11.0.12';

// Safe to import because rollOverlay.js doesn't depend on ui.js, so no cycle.
import { hideRollOverlay } from './features/rollOverlay.js?v=11.0.12';

// DOM helpers + visual utilities (status, toast, log, etc.)
export function initUi() {
  const $ = (id)=>document.getElementById(id);
  state.$ = $;

  const e = state.els;
  e.log       = $('log');
  e.status    = $('status');
  e.joinCard  = $('joinCard');
  e.lobbyArea = $('lobbyArea');
  e.readyBtn  = $('btnReady');
  e.readyPill = $('readyPill');
  e.charGrid  = $('charGrid');
  e.nameInput = $('name');
  e.dbg       = $('dbg');

  e.rollPanel   = $('turnOrder');
  e.rollBtn     = $('btnRoll');
  e.rollTitle   = $('rollTitle');
  e.rollState   = $('rollState');
  e.rollValue   = $('rollValue');
  e.orderResult = $('orderResult');

  // remove any legacy dev button
  (document.getElementById('btnShowRoll') || { remove:()=>{} }).remove();
}

export function hideJoinCard(){ state.els.joinCard?.classList.add('hidden'); }
export function showJoinCard(){ state.els.joinCard?.classList.remove('hidden'); }

export function resetToLobbyUi(){
  setPhase('lobby');
  state.roomId = '';
  state.playerId = '';
  state.playerNameById?.clear?.();

  showJoinCard();
  setLobbyVisible(false);

  state.catalog = null;
  state._pendingCatalog = null;
  state.catalogFingerprint = null;
  state._lastRehydrateAt = 0;

  state.myCharId = null;
  state.takenChars?.clear?.();
  setReadyUI(false);

  const grid = state.els.charGrid;
  if (grid) grid.replaceChildren();

  state.inTurnOrder = false;
  state.canRollNow = false;
  state.myHasRolled = false;

  if (state.els.rollPanel) state.els.rollPanel.classList.add('hidden');
  if (state.els.rollValue) state.els.rollValue.textContent = '—';
  if (state.els.rollState) {
    state.els.rollState.textContent = 'Waiting…';
    state.els.rollState.classList.add('no');
    state.els.rollState.classList.remove('ok');
  }
  if (state.els.rollBtn) {
    state.els.rollBtn.disabled = false;
    state.els.rollBtn.classList.remove('btn-disabled');
  }
  if (state.els.orderResult) {
    state.els.orderResult.textContent = '';
    state.els.orderResult.classList.add('hidden');
  }

  state.triviaAllowed = null;
  state.triviaMode = 'PENDING';
  state.triviaPadEl = null;
  state.triviaPadButtons = [];
}

export function setPhase(p){ state.phase = p; setDbg('phase=' + p); }
export function setDbg(x){ const d = state.els.dbg; if (d) d.textContent = 'last: ' + x; }
export function log(x){ const el = state.els.log; if (!el) return; el.textContent += x + '\n'; el.scrollTop = el.scrollHeight; }

export function showToast(text, ms=1600){
  const t = state.$('toast'); if(!t) return;
  t.textContent = text; t.style.display='block';
  clearTimeout(showToast._to); showToast._to = setTimeout(()=>t.style.display='none', ms);
}
export function setStatus(text, pill=false){
  const el = state.els.status; if(!el) return;
  el.textContent = 'Status: ' + text;
  el.classList.toggle('pill', pill);
}

export function setLobbyVisible(on){
  state.els.lobbyArea?.classList.toggle('hidden', !on);
  if (!on) return;

  // When we re-enter the lobby, make sure the roll overlay is fully reset so it
  // doesn't cover the character grid during reconnects / snapshots.
  hideRollOverlay();
  state.inTurnOrder = false;
  state.canRollNow = false;
  state.myHasRolled = false;

  const { rollBtn, rollState, rollValue, orderResult } = state.els;
  if (rollBtn) {
    rollBtn.disabled = true;
    rollBtn.classList.add('btn-disabled');
    rollBtn.style.display = 'none';
  }
  if (rollState) {
    rollState.textContent = 'Waiting…';
    rollState.classList.remove('ok');
    rollState.classList.add('no');
  }
  if (rollValue) rollValue.textContent = '—';
  if (orderResult) {
    orderResult.textContent = '';
    orderResult.classList.add('hidden');
  }
}

export function setReadyPill(on){
  const p = state.els.readyPill; if (!p) return;
  p.textContent = on ? 'Ready' : 'Not Ready';
  p.classList.toggle('ok', on);
  p.classList.toggle('no', !on);
}

export function enableReadyButton(can){
  const b = state.els.readyBtn; if (!b) return;
  const shouldEnable = can || state.myReady;
  b.disabled = !shouldEnable;
  b.classList.toggle('btn-disabled', !shouldEnable);
  setDbg('ready enabled=' + shouldEnable);
}
export function setReadyUI(isReady){
  const b = state.els.readyBtn; if (!b) return;
  state.myReady = !!isReady;
  setReadyPill(state.myReady);
  b.textContent = state.myReady ? 'Unready' : 'I’m Ready';
  b.classList.toggle('btn-primary', state.myReady);
  b.classList.toggle('btn-accent', !state.myReady);
  enableReadyButton(!!state.myCharId);
}

export const idsEqual = (a,b)=> String(a||'').trim() === String(b||'').trim();
export function isMeFrom(pid, pname){
  const myName = (state.els.nameInput?.value || '').trim();
  const idMatch = !!pid && idsEqual(pid, state.playerId);
  const nameMatch = !!pname && pname.trim() && idsEqual(pname, myName);
  return idMatch || (!idMatch && nameMatch);
}

export function looksLikeBase64(s){ return typeof s==='string' && s.length>40 && /^[A-Za-z0-9+/=\s]+$/.test(s.slice(0,120)); }
export function resolvePortraitSrc({ url, data }) {
  let u = (url || '').trim();
  let d = (data || '').trim();
  if (u && u.startsWith('/'))  u = location.origin + u;
  if (u && u.startsWith('//')) u = 'https:' + u;
  if (u && u.startsWith('http://')) u = 'https://' + u.slice(7);
  if (u && u.startsWith('data:')) return u;
  if (!u && d) { if (!d.startsWith('data:')) d = 'data:image/png;base64,' + d; return d; }
  if (!u && looksLikeBase64(d)) return 'data:image/png;base64,' + d;
  return u || '';
}
