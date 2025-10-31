import { state } from '../state.js?v=11.0.6';
import { showToast } from '../ui.js?v=11.0.6';

// === Hints detection ===
export function hasTriviaHints(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const hintKeys = [
    'mode','triviaMode','answerMode','type',
    'isSolo','solo','soloMode',
    'isFfa','ffa','freeForAll',
    'allowedPlayerIds','allowedPlayers','allowedIds','allowed','allow','participants',
    'allowedPlayerId','participantIds',
    'soloPlayerId','targetPlayerId','activePlayerId',
    'promptPlayerId','promptedPlayerId','focusPlayerId','challengePlayerId',
    'soloPlayer'
  ];
  return hintKeys.some(k => Object.prototype.hasOwnProperty.call(payload, k) && payload[k] != null);
}

// === Eligibility (logic preserved) ===
import { idsEqual } from '../ui.js?v=11.0.6';
export function computeTriviaEligibility(payload){
  if (!payload || typeof payload !== 'object') { state.triviaMode = 'PENDING'; return false; }
  if (!hasTriviaHints(payload)) { state.triviaMode = 'PENDING'; return null; }

  const collectIds = (raw) => {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw.flatMap(collectIds).filter(Boolean);
    if (typeof raw === 'object') {
      const direct = raw.playerId || raw.id || raw.value || raw.key || raw.targetPlayerId || raw.soloPlayerId;
      if (direct != null) return collectIds(direct);
      const keys = Object.keys(raw);
      if (!keys.length) return [];
      const boolKeys = keys.filter((k) => typeof raw[k] === 'boolean');
      if (boolKeys.length === keys.length) return boolKeys.filter((k) => raw[k]);
      return keys.flatMap((k) => collectIds(raw[k])).filter(Boolean);
    }
    if (typeof raw === 'string') return raw.includes(',') ? raw.split(',').map(s=>s.trim()).filter(Boolean) : [raw.trim()];
    if (typeof raw === 'number' || typeof raw === 'bigint') return [String(raw)];
    return [];
  };
  const normalizeMode = (value) => {
    if (value == null) return '';
    const cleaned = String(value).trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!cleaned) return '';
    if (cleaned === 'SOLO' || cleaned.startsWith('SOLO') || cleaned.includes('TRIVIASOLO')) return 'SOLO';
    if (cleaned === 'FFA' || cleaned === 'FREEFORALL' || cleaned === 'EVERYONE' || cleaned === 'ALLPLAYERS' || cleaned.includes('FREEFORALL')) return 'FFA';
    return '';
  };
  const normalizeToken = (v)=> String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9*]/g,'');
  const allowAllTokens = new Set(['all','*','everyone','everybody','allplayers','anyone','anybody','any','ffa','open']);

  const allowedSources = [
    payload.allowed, payload.allowedPlayerIds, payload.allowedPlayers, payload.allowedIds,
    payload.allow, payload.participants, payload.allowedPlayerId, payload.participantIds,
    payload.playerIds, payload.players,
  ];
  let allowedIds = allowedSources.flatMap(collectIds).filter(Boolean);

  const allowAllFlags = [payload.allowed, payload.allow, payload.participants];
  const explicitAllowAllFromFlags = allowAllFlags.some((v) => v === true || allowAllTokens.has(normalizeToken(v)));

  const normalizedAllowed = allowedIds.map(normalizeToken);
  const allowAllFromAllowed = normalizedAllowed.some((t)=>allowAllTokens.has(t));
  if (allowAllFromAllowed) {
    allowedIds = allowedIds.filter((_, i)=>!allowAllTokens.has(normalizedAllowed[i]));
  }
  const explicitAllowAll = explicitAllowAllFromFlags || allowAllFromAllowed;

  const soloHints   = [payload.soloPlayerId, payload.targetPlayerId, payload.activePlayerId, payload.promptPlayerId,
                       payload.promptedPlayerId, payload.focusPlayerId, payload.challengePlayerId, payload.soloPlayer]
                      .flatMap(collectIds).filter(Boolean);
  const fallbackIds = [payload.playerId, payload.player].flatMap(collectIds).filter(Boolean);

  const explicitMode =
    normalizeMode(payload.mode) || normalizeMode(payload.triviaMode) ||
    normalizeMode(payload.answerMode) || normalizeMode(payload.type);
  const isSoloFlag = payload.isSolo === true || payload.solo === true || payload.soloMode === true;
  const isFfaFlag  = payload.isFfa  === true || payload.ffa  === true || payload.freeForAll === true;

  let resolvedMode = explicitMode;
  if (!resolvedMode) {
    if (isSoloFlag) resolvedMode = 'SOLO';
    else if (isFfaFlag) resolvedMode = 'FFA';
  }
  if (!resolvedMode) {
    if (explicitAllowAll) resolvedMode = 'FFA';
    else if (soloHints.length > 0 || fallbackIds.length > 0 || allowedIds.length === 1) resolvedMode = 'SOLO';
    else if (allowedIds.length > 1) resolvedMode = 'FFA';
    else resolvedMode = 'SOLO';
  }
  state.triviaMode = resolvedMode;

  const myId = state.playerId || '';
  const isAllowed = (list) => list.some((id) => idsEqual(id, myId));

  if (resolvedMode === 'FFA') {
    if (allowedIds.length > 0) return isAllowed(allowedIds) || explicitAllowAll;
    return true;
  }
  if (resolvedMode === 'SOLO') {
    if (allowedIds.length > 0) return isAllowed(allowedIds); // TRUST allow-list first
    if (soloHints.length > 0)   return isAllowed(soloHints);
    if (fallbackIds.length > 0) return isAllowed(fallbackIds);
    return false;
  }
  if (allowedIds.length > 0) return isAllowed(allowedIds);
  if (explicitAllowAll) return true;
  return false;
}

// === Pad UI ===
import { showRollOverlay, hideRollOverlay, updateRollUI } from './rollOverlay.js';
import { wsSend } from '../ws.js';

export function ensureTriviaPad(){
  if (state.triviaPadEl) return state.triviaPadEl;
  const pad = document.createElement('div');
  pad.id = 'triviaPad';
  pad.style.cssText = `position:fixed; inset:0; z-index:10010; display:none; background:rgba(0,0,0,.5);`;
  pad.innerHTML = `
    <div style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
      width:min(520px,92%); background:#141418; border:1px solid #2a2a32; border-radius:16px; padding:16px; display:flex;flex-direction:column; gap:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="pill">Trivia — choose</div>
        <button id="tpClose" type="button" style="background:#1f2937;border:1px solid #374151;color:#e5e7eb;padding:6px 10px;border-radius:10px">Hide</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <button class="tp-btn btn-primary" id="tpA" type="button">A</button>
        <button class="tp-btn btn-primary" id="tpB" type="button">B</button>
        <button class="tp-btn btn-primary" id="tpC" type="button">C</button>
        <button class="tp-btn btn-primary" id="tpD" type="button">D</button>
      </div>
      <div style="font-size:12px;color:#9aa0a6">Answers lock after you tap.</div>
    </div>`;
  document.body.appendChild(pad);
  pad.querySelector('#tpClose').addEventListener('click', ()=>{ pad.style.display='none'; }, { passive:true });

  const buttons = ['tpA','tpB','tpC','tpD'].map(id=>pad.querySelector('#'+id));
  state.triviaPadButtons = buttons;
  buttons.forEach((b, i)=>{
    b.addEventListener('click', ()=>{
      if (state.triviaAllowed !== true) { showToast('Not your question.'); return; }
      buttons.forEach(bb=>{ bb.disabled = true; bb.classList.add('btn-disabled'); });
      wsSend({ type:'INTENT', intent:'TRIVIA_ANSWER', value:String(i) });
      wsSend({ type:'TRIVIA_ANSWER', optionIndex:i });
      showToast('✅ Answer sent');
    }, { passive:true });
  });

  state.triviaPadEl = pad;
  return pad;
}
export function showTriviaPad(){
  if (state.triviaAllowed !== true) { endTriviaPad(); return; }
  const pad = ensureTriviaPad();
  state.triviaPadButtons.forEach(bb=>{ bb.disabled = false; bb.classList.remove('btn-disabled'); });
  pad.style.display = 'block';
}
export function endTriviaPad(){
  if (!state.triviaPadEl) return;
  state.triviaPadButtons.forEach(bb=>{ bb.disabled = true; bb.classList.add('btn-disabled'); });
  state.triviaPadEl.style.display='none';
}

export function showTriviaPadIfAllowed(payload, opts = {}){
  const hintful = hasTriviaHints(payload);
  if (!hintful && opts.quiet && state.triviaAllowed != null) {
    if (state.triviaAllowed) showTriviaPad(); else endTriviaPad();
    return;
  }
  const eligibility = computeTriviaEligibility(payload);
  state.triviaAllowed = eligibility;
  if (eligibility === true) showTriviaPad();
  else {
    endTriviaPad();
    if (eligibility === false && !opts.quiet) showToast('Trivia in progress…');
  }
}
