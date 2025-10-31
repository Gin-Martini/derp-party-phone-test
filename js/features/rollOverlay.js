import { state } from '../state.js?v=11.0.10';

export function allowRollButton(){
  if (state.phase === 'lobby') return false;
  if (state.inTurnOrder) return !state.myHasRolled;
  return !!state.canRollNow;
}
export function updateRollUI(){
  const b = state.els.rollBtn; if (!b) return;
  const show = allowRollButton();
  b.style.display = show ? 'inline-block' : 'none';
  b.disabled = !show;
  b.classList.toggle('btn-disabled', !show);
}
export function showRollOverlay(title='Roll'){
  const { rollPanel, rollTitle, rollValue, rollState } = state.els;
  if (!rollPanel || !rollTitle || !rollValue || !rollState) return;
  if (state.phase === 'lobby') return;
  rollTitle.textContent = title;
  rollValue.textContent = '—';
  rollState.textContent = 'Waiting…';
  rollState.classList.remove('ok'); rollState.classList.add('no');
  rollPanel.classList.remove('hidden'); rollPanel.style.display = 'block';
  updateRollUI();
  setTimeout(()=>window.scrollTo(0,0), 0);
}
export function hideRollOverlay(){ state.els.rollPanel?.classList.add('hidden'); }
