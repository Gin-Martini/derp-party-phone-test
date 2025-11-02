import { state } from '../state.js?v=11.0.12';
import { sendIntent, wsSend } from '../ws.js?v=11.0.12';

function isBoardPhase(){
  const phase = String(state.phase || '').toLowerCase();
  return phase === 'board' || phase === 'in_game';
}

function allowRollButton(){
  if (state.phase === 'lobby') return false;
  if (state.inTurnOrder) return !state.myHasRolled;
  return !!state.canRollNow && !state.myHasRolled;
}

function applyRollButtonState(){
  const btn = state.els.rollBtn;
  if (!btn) return;
  const show = allowRollButton();
  btn.style.display = show ? 'inline-block' : 'none';
  btn.disabled = !show;
  btn.classList.toggle('btn-disabled', !show);
}

function setText(el, value, { ok } = {}){
  if (!el) return;
  if (value !== undefined) el.textContent = value == null ? '' : String(value);
  if (ok === undefined || !('classList' in el)) return;
  if (ok) {
    el.classList.add('ok');
    el.classList.remove('no');
  } else {
    el.classList.remove('ok');
    el.classList.add('no');
  }
}

function ensureOrderResultVisible(hasText){
  const order = state.els.orderResult;
  if (!order) return;
  order.classList.toggle('hidden', !hasText);
}

function onRollClick(e){
  e?.preventDefault?.();
  if (!allowRollButton()) return;

  if (state.inTurnOrder && !state.myHasRolled) {
    state.myHasRolled = true;
    updateRollUI({ msg: 'Rolling…' });
    sendIntent('PLAYER_ROLL');
    wsSend({ type: 'PLAYER_ROLL' });
    return;
  }

  if (isBoardPhase() && state.canRollNow && !state.myHasRolled) {
    state.myHasRolled = true;
    state.canRollNow = false;
    updateRollUI({ msg: 'Rolling…' });
    sendIntent('ROLL_MOVE');
    wsSend({ type: 'ROLL_MOVE' });
  }
}

export function wireRollButton(){
  const btn = state.els.rollBtn;
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.addEventListener('click', onRollClick, { passive: false });
}

export function updateRollUI({ value, msg, orderText, ok } = {}){
  const { rollValue, rollState, orderResult } = state.els;
  if (value !== undefined) setText(rollValue, value);
  if (msg !== undefined) setText(rollState, msg, { ok });
  if (orderText !== undefined) {
    setText(orderResult, orderText, { ok: true });
    ensureOrderResultVisible(!!orderText);
  }
  applyRollButtonState();
}

export function showRollOverlay({ title = 'Roll', prompt = 'Waiting…' } = {}){
  const { rollPanel, rollTitle, rollValue, rollState, orderResult } = state.els;
  if (!rollPanel || !rollTitle || !rollValue || !rollState) return;

  rollTitle.textContent = title;
  setText(rollState, prompt, { ok: false });
  setText(rollValue, '—');
  if (orderResult) {
    orderResult.textContent = '';
    ensureOrderResultVisible(false);
  }
  rollPanel.classList.remove('hidden');
  rollPanel.style.display = 'block';
  applyRollButtonState();
  setTimeout(() => window.scrollTo(0, 0), 0);
}

export function hideRollOverlay(){
  const panel = state.els.rollPanel;
  if (!panel) return;
  panel.classList.add('hidden');
}
