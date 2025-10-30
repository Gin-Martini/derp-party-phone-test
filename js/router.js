import { state } from './state.js';
import { setPhase, setStatus, setLobbyVisible, log, setDbg, showToast } from './ui.js';
import { renderCatalog, markTaken, markSelected } from './features/catalog.js';
import { showRollOverlay, hideRollOverlay, updateRollUI } from './features/rollOverlay.js';
import { showTriviaPadIfAllowed, endTriviaPad } from './features/triviaPad.js';
import { idsEqual, isMeFrom } from './ui.js';
import { endSession } from './ws.js';

export function normType(t){
  if(!t) return t;
  const upper = String(t).trim().toUpperCase();
  const m = {
    'TURNORDER_START':'TURN_ORDER_START',
    'TURNORDER_ROLL':'TURN_ORDER_FEEDBACK',
    'TURNORDER_FEEDBACK':'TURN_ORDER_FEEDBACK',
    'TURNORDER_DONE':'TURN_ORDER_DONE',
    'START_TURN':'YOUR_TURN',
    'YOURTURN':'YOUR_TURN',
    'TURN_START':'YOUR_TURN',
    'TURNBEGIN':'YOUR_TURN',
    'TURN_BEGIN':'YOUR_TURN',
    'PLAYER_TURN':'YOUR_TURN',
    'CURRENT_TURN':'YOUR_TURN',
    'PROMPT_ROLL':'ROLL_PROMPT',
    'ROLLREQUEST':'ROLL_PROMPT',
    'ROLL_REQUEST':'ROLL_PROMPT',
    'ROLLNOW':'ROLL_PROMPT',
    'TURN_PROMPT':'ROLL_PROMPT',
    'TRIVIA_BEGIN':'TRIVIA_START',
    'TRIVIA_OPEN':'TRIVIA_START',
    'TRIVIA_PROMPT':'TRIVIA_START',
    'QUESTION_START':'TRIVIA_START',
    'PROMPT_TRIVIA':'TRIVIA_START',
    'ANSWER_WINDOW_OPEN':'TRIVIA_START',
    'TRIVIA_DONE':'TRIVIA_END',
    'TRIVIA_CLOSE':'TRIVIA_END',
    'TRIVIA_RESULT':'TRIVIA_END',
    'ANSWER_WINDOW_CLOSE':'TRIVIA_END',
  };
  if (m[upper]) return m[upper];
  const soloSanitized = upper.replace(/-/g, '_');
  if (soloSanitized.startsWith('SOLO_TRIVIA_')) return ('TRIVIA_' + soloSanitized.slice('SOLO_TRIVIA_'.length));
  if (soloSanitized.startsWith('SOLOTRIVIA_'))   return ('TRIVIA_' + soloSanitized.slice('SOLOTRIVIA_'.length));
  if (soloSanitized.startsWith('SOLO_'))         return soloSanitized.slice('SOLO_'.length);
  if (soloSanitized.startsWith('SOLOTRIVIA'))    return ('TRIVIA' + soloSanitized.slice('SOLOTRIVIA'.length));
  if (upper.startsWith('SOLOTRIVIA'))            return ('TRIVIA' + upper.slice('SOLOTRIVIA'.length));
  return upper;
}

export function onSocketMessage(ev){
  log('< ' + ev.data);
  try {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'PONG') return;

    const isWrapped = (msg && msg.type === 'STATE' && msg.state);
    const inner = isWrapped ? msg.state : msg;
    const type = normType(inner.type || msg.type);
    const payload = inner;
    setDbg(type || 'unknown');

    if (type === 'WELCOME' || type === 'HELLO' || type === 'CONNECTED') {
      // rehydrate ping happens from ws.onopen’s schedule
      return;
    }

    // ===== terminal signals =====
    if (type === 'ROOM_CLOSED' || type === 'SESSION_END' || type === 'GAME_ENDED') {
      endSession(payload.reason || 'Host ended the session'); return;
    }
    if (type === 'KICKED' || type === 'PLAYER_KICKED') {
      const pid = (payload.playerId || payload.id || '').trim();
      if (!pid || idsEqual(pid, state.playerId)) { endSession('You were removed by the host'); return; }
    }

    if (type === 'TEXT' && payload.message) showToast(payload.message);

    // === TURN-ORDER ===
    if (type === 'TURN_ORDER_START') {
      setPhase('turn_order');
      state.inTurnOrder = true;
      state.playerNameById.clear();
      const arr = payload.players || payload.order || [];
      for (const p of arr) if (p && (p.playerId || p.id)) {
        const pid = p.playerId || p.id;
        state.playerNameById.set(pid, p.name || pid);
      }
      state.myHasRolled = false;
      showRollOverlay('Roll for Turn Order');
      updateRollUI();
      return;
    }

    if (type === 'TURN_ORDER_FEEDBACK') {
      const who  = payload.playerId || payload.id;
      const roll = (payload.roll != null ? payload.roll : payload.value);
      if (who === state.playerId) {
        state.myHasRolled = true;
        state.els.rollValue.textContent = String(roll);
        state.els.rollState.textContent = 'Rolled';
        state.els.rollState.classList.add('ok'); state.els.rollState.classList.remove('no');
      }
      updateRollUI(); return;
    }

    if (type === 'TURN_ORDER_DONE') {
      state.inTurnOrder = false;
      setPhase('in_game');
      const ordered = payload.ordered || payload.order || [];
      const rolls   = payload.rolls || payload.values || {};
      const lines = ordered.map((pid,i)=>{
        const name = state.playerNameById.get(pid) || pid;
        const me   = (pid === state.playerId) ? ' (you)' : '';
        const r    = (rolls && rolls[pid] != null) ? ` — ${rolls[pid]}` : '';
        return `${i+1}. ${name}${me}${r}`;
      }).join('<br/>');
      state.els.orderResult.innerHTML = lines;
      state.els.orderResult.classList.remove('hidden');

      state.canRollNow = false;
      state.els.rollState.textContent = 'Waiting…';
      state.els.rollState.classList.remove('ok');
      state.els.rollState.classList.add('no');
      updateRollUI(); return;
    }

    // === MAIN GAME TURNS ===
    if (type === 'YOUR_TURN') {
      setPhase('in_game');
      const pid   = (payload.playerId || payload.id || '').trim();
      const pname = (payload.name || '').trim();
      const isMe  = isMeFrom(pid, pname);
      if (!pid && !isMe) return;

      state.canRollNow = isMe;
      if (isMe) {
        state.els.rollState.textContent = 'Waiting…';
        state.els.rollState.classList.remove('ok'); state.els.rollState.classList.add('no');
        showRollOverlay('Your Turn — Roll!');
        showToast('🎲 Your turn! Tap Roll.');
      } else {
        hideRollOverlay();
        showToast('⏳ Waiting for other player…', 1200);
      }
      updateRollUI(); return;
    }

    if (type === 'ROLL_PROMPT') {
      setPhase('in_game');
      const pid   = (payload.playerId || payload.id || '').trim();
      const pname = (payload.name || '').trim();
      const isMe  = isMeFrom(pid, pname);
      state.canRollNow = !!isMe;
      if (isMe) {
        state.els.rollState.textContent = 'Waiting…';
        state.els.rollState.classList.remove('ok'); state.els.rollState.classList.add('no');
        showRollOverlay('Your Turn — Roll!');
        showToast('🎲 Your turn! Tap Roll.');
      }
      updateRollUI(); return;
    }

    if (type === 'MOVE_BEGIN') {
      if (idsEqual(payload.playerId || payload.id, state.playerId)) {
        state.els.rollState.textContent = 'Rolled';
        state.els.rollState.classList.add('ok'); state.els.rollState.classList.remove('no');
      }
      state.canRollNow = false; updateRollUI(); return;
    }
    if (type === 'MOVE_END') { state.canRollNow = false; hideRollOverlay(); updateRollUI(); return; }

    // === SPACE / COINS feedback ===
    if (type === 'SPACE_LANDED') { showToast(`🧭 Landed on ${payload.spaceType || 'Unknown'} (space ${payload.spaceIndex})`); return; }
    if (type === 'COINS_DELTA') {
      const d = Number(payload.delta || 0);
      const total = Number(payload.total || 0);
      const sign = d > 0 ? '+' : '';
      showToast(`🪙 Coins ${sign}${d} → ${total}`); return;
    }
    if (type === 'SPACE_RESOLVE') { showToast(`✅ ${payload.outcome || 'Resolved'}`); return; }

    // === TRIVIA ===
    if (type === 'TRIVIA_START') { showTriviaPadIfAllowed(payload); return; }
    if (type === 'TRIVIA_END') {
      endTriviaPad(); state.triviaAllowed = null; state.triviaMode = 'PENDING';
      if (payload && payload.winnerId) {
        const coins = Number(payload.awarded || 0);
        showToast(`🏆 ${payload.winnerId} won ${coins>0?`+${coins}`:''}`);
      }
      return;
    }
    if (type === 'TRIVIA_SWITCH') {
      showTriviaPadIfAllowed(payload, { quiet:true });
      showToast('🔁 New question!'); return;
    }

    // Handle catalog messages whether or not they're wrapped in STATE
    if (type === 'CHARACTER_CATALOG') {
      const list = (payload.entries || payload.catalog || []);
      renderCatalog(list);
      return;
    }

    // ---- STATE snapshots / legacy trivia paths ----
    if (msg.type === 'STATE') {
      const s = msg.state || {};
      const stateType = normType(s.type);

      if (s.trivia && (s.trivia.open === true || s.trivia.phase === 'start' || s.trivia.phase === 'open')) { showTriviaPadIfAllowed(s.trivia, { quiet:true }); return; }
      if (s.trivia && (s.trivia.closed === true || s.trivia.phase === 'end' || s.trivia.phase === 'closed' || s.trivia.phase === 'result')) { endTriviaPad(); state.triviaAllowed = null; state.triviaMode = 'PENDING'; return; }

      if (stateType === 'TRIVIA_START' || s.answerWindowOpen === true || (typeof s.answerWindowMillis === 'number' && s.answerWindowMillis > 0)) { showTriviaPadIfAllowed(s, { quiet:true }); return; }
      if (stateType === 'TRIVIA_END'   || s.answerWindowOpen === false || (typeof s.answerWindowMillis === 'number' && s.answerWindowMillis <= 0)) { endTriviaPad(); state.triviaAllowed = null; state.triviaMode = 'PENDING'; return; }

      if (stateType === 'CHARACTER_CATALOG') { renderCatalog(s.entries||[]); return; }

      if (stateType === 'LOBBY_STATE') {
        setPhase('lobby');
        hideRollOverlay();
        const players = s.players||[];
        const text = players.length
          ? players.map(p => `${p.name}${p.ready?' ✅':''}${p.charId?(' · '+p.charId):''}`).join(', ')
          : '—';
        setStatus('Lobby: ' + text, true);
        markTaken(s.taken||[]);
        const me = players.find(p => (p.playerId && p.playerId===state.playerId) || (p.name && p.name===(state.els.nameInput?.value||'').trim()));
        if (me && !!me.ready !== state.myReady) {
          state.myReady = !!me.ready;
        }
        state.canRollNow = false; state.inTurnOrder = false; state.myHasRolled = false;
        updateRollUI(); return;
      }

      if (stateType === 'CHARACTER_TAKEN')  { markTaken([...(state.takenChars), String(s.charId)]); return; }
      if (stateType === 'CHARACTER_PICKED') { if (idsEqual(s.playerId, state.playerId)) { state.myCharId = s.charId || null; markSelected(state.myCharId); } return; }

      if (stateType === 'LOBBY_LOCKED') {
        setStatus('Game starting…', true);
        state.myReady = false;
        state.els.lobbyArea?.classList.add('hidden');
        setPhase('in_game');
        hideRollOverlay();
        updateRollUI(); return;
      }

      if (stateType === 'TURN_STATE' || stateType === 'CURRENT_TURN') {
        if (state.phase === 'lobby') return;
        const pid = s.currentPlayerId || (s.turn && s.turn.currentPlayerId);
        const pname = s.currentPlayerName || (s.turn && s.turn.currentPlayerName) || state.playerNameById.get(pid) || s.name || '';
        const isMe = (pid && idsEqual(pid, state.playerId)) || (!!pname && idsEqual(pname, (state.els.nameInput?.value||'').trim()));
        state.canRollNow = !!isMe;
        if (isMe) {
          showRollOverlay('Your Turn — Roll!');
          state.els.rollState.textContent = 'Waiting…';
          state.els.rollState.classList.remove('ok'); state.els.rollState.classList.add('no');
        } else { hideRollOverlay(); }
        updateRollUI(); return;
      }

      if (s.type === 'TEXT') { showToast('📣 ' + (s.message || 'Info')); return; }
    }
  } catch(e) { console.error(e); }
}
