// app.js — DerpPhone v10.1.0 (rehydrate-on-connect, manual reset, terminal handling, trivia reconnect fix, id/name fallback for roll)
'use strict';

(() => {
  // ======== Config ========
  const BASE      = 'https://derpparty-relay.fly.dev';
  const HTTP_BASE = BASE;
  const WS_URL    = BASE.replace('https','wss') + '/socket';

  // ======== State ========
  let ws, playerId = '', roomId = '', hbInterval;
  let myReady = false, myCharId = null;
  const takenChars = new Set();
  const playerNameById = new Map();
  let myHasRolled = false, inTurnOrder = false, canRollNow = false;
  let phase = 'lobby'; // 'lobby' | 'turn_order' | 'in_game'

  // ======== DOM refs (assigned in initDom) ========
  let $, logEl, statusEl, joinCard, lobbyArea, readyBtn, readyPill, charGrid, nameInput, dbg;
  let rollPanel, rollBtn, rollTitle, rollState, rollValue, orderResult;

  // ======== Reconnect/session ========
  const SESSION_KEY = 'dp.session.v2'; // bumped to force-clear old sessions
  let shouldReconnect = false;
  let reconnectTimer = 0;
  let reconnectAttempts = 0;
  const backoff = (n) => Math.min(15000, 500 * Math.pow(1.8, n)) + Math.floor(Math.random()*150);

  function saveSession() {
    if (!roomId || !playerId) return;
    const name = (nameInput?.value || '').trim() || 'Player';
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId, playerId, name })); } catch (_) {}
  }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} }
  function loadSession() {
    try {
      const j = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return (j && j.roomId && j.playerId) ? j : null;
    } catch (_) { return null; }
  }
  function scheduleReconnect(reason) {
    if (!shouldReconnect || !roomId || !playerId) return;
    setStatus(`Reconnecting… (${reason||'lost connection'})`, true);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const wait = backoff(reconnectAttempts++);
    reconnectTimer = setTimeout(()=> {
      reconnectTimer = 0;
      connectWs(); // sends HELLO on open
    }, wait);
  }
  function cancelReconnect() {
    shouldReconnect = false;
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  }
  function connectWs() {
    try {
      ws = new WebSocket(WS_URL);
      attachWsHandlers(ws);
    } catch {
      scheduleReconnect('ws construct failed');
    }
  }

  // ======== UI helpers ========
  function setPhase(p){ phase = p; setDbg('phase=' + p); }
  function setDbg(x){ if (dbg) dbg.textContent = 'last: ' + x; }
  function log(x){ if (!logEl) return; logEl.textContent += x + "\n"; logEl.scrollTop = logEl.scrollHeight; }
  function showToast(text, ms=1600){ const t=$('toast'); if(!t) return; t.textContent=text; t.style.display='block'; clearTimeout(showToast._to); showToast._to=setTimeout(()=>t.style.display='none',ms); }
  function setStatus(text, pill=false){ if(!statusEl) return; statusEl.textContent='Status: '+text; statusEl.classList.toggle('pill', pill); }
  function setLobbyVisible(on){ if(!lobbyArea) return; lobbyArea.classList.toggle('hidden', !on); }
  function setReadyPill(on){ if(!readyPill) return; readyPill.textContent=on?'Ready':'Not Ready'; readyPill.classList.toggle('ok',on); readyPill.classList.toggle('no',!on); }
  function ensureGridVisible(){ if(charGrid) charGrid.style.display='grid'; }
  function idsEqual(a,b){ return String(a||'').trim() === String(b||'').trim(); }

  // --- NEW: tolerant “is this me?” (id OR name) ---
  function isMeFrom(pid, pname){
    const myName = (nameInput?.value || '').trim();
    const idMatch = !!pid && idsEqual(pid, playerId);
    const nameMatch = !!pname && pname.trim() && idsEqual(pname, myName);
    return idMatch || (!idMatch && nameMatch);
  }

  function enableReadyButton(can){
    if (!readyBtn) return;
    const shouldEnable = can || myReady;
    readyBtn.disabled = !shouldEnable;
    readyBtn.classList.toggle('btn-disabled', !shouldEnable);
    setDbg('ready enabled=' + shouldEnable);
  }

  function setReadyUI(isReady){
    if (!readyBtn) return;
    myReady = !!isReady;
    setReadyPill(myReady);
    readyBtn.textContent = myReady ? 'Unready' : 'I’m Ready';
    readyBtn.classList.toggle('btn-primary', myReady);
    readyBtn.classList.toggle('btn-accent', !myReady);
    enableReadyButton(!!myCharId);
  }

  function looksLikeBase64(s){ return typeof s==='string' && s.length>40 && /^[A-Za-z0-9+/=\s]+$/.test(s.slice(0,120)); }
  function resolvePortraitSrc({ url, data }) {
    let u = (url || '').trim();
    let d = (data || '').trim();
    if (u && u.startsWith('/')) u = HTTP_BASE.replace(/\/+$/,'') + u;
    if (u && u.startsWith('//')) u = 'https:' + u;
    if (u && u.startsWith('http://')) u = 'https://' + u.slice(7);
    if (u && u.startsWith('data:')) return u;
    if (!u && d) { if (!d.startsWith('data:')) d = 'data:image/png;base64,' + d; return d; }
    if (!u && looksLikeBase64(d)) return 'data:image/png;base64,' + d;
    return u || '';
  }

  function renderCatalog(entries){
    if (!charGrid) return;
    charGrid.innerHTML = '';
    (entries||[]).forEach((e, idx)=>{
      const id    = e.id;
      const label = e.label || e.id || ('Char ' + (idx+1));
      const src   = resolvePortraitSrc({
        url:  e.portraitUrl || e.imageUrl || e.url || '',
        data: e.portraitData || e.portrait || ''
      });

      const btn = document.createElement('button');
      btn.className = 'charBtn';
      btn.dataset.charId = id;
      btn.type = 'button';

      const portrait = document.createElement('div');
      portrait.className = 'portrait';
      if (src){
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        img.src = src;
        img.onerror = () => {
          portrait.innerHTML='';
          const fb=document.createElement('div'); fb.className='fallback'; fb.textContent=label.slice(0,2).toUpperCase();
          portrait.appendChild(fb);
        };
        portrait.appendChild(img);
      } else {
        const fb=document.createElement('div'); fb.className = 'fallback'; fb.textContent = label.slice(0,2).toUpperCase();
        portrait.appendChild(fb);
      }

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = label;

      btn.appendChild(portrait);
      btn.appendChild(name);
      charGrid.appendChild(btn);
    });

    markTaken([]);
    markSelected(myCharId);
    enableReadyButton(!!myCharId);
    ensureGridVisible();
  }

  function markTaken(list){
    takenChars.clear();
    (list||[]).forEach(id => takenChars.add(String(id)));
    if (!charGrid) return;
    [...charGrid.querySelectorAll('.charBtn')].forEach(b=>{
      const id = b.dataset.charId;
      const isTaken = takenChars.has(id);
      const isMine  = (id === myCharId);
      b.classList.toggle('taken', isTaken && !isMine);
      b.disabled = isTaken && !isMine;
    });
  }

  function markSelected(id){
    if (!charGrid) return;
    [...charGrid.querySelectorAll('.charBtn')].forEach(b=>{
      b.classList.toggle('selected', b.dataset.charId === id);
    });
  }

  // ======== Intent helpers ========
  function wsSend(obj){
    try{ ws && ws.readyState===1 && ws.send(JSON.stringify(obj)); }catch(_){ /*no-op*/ }
  }

  function sendReady(){
    if (!ws) return;
    if (!myCharId){ showToast('Pick a character first'); return; }
    if (myReady) return;
    wsSend({ type:'PLAYER_READY' });
    wsSend({ type:'READY' });
    setReadyUI(true);
    showToast('✅ Ready');
    log('> PLAYER_READY');
  }

  function sendUnready(reason){
    if (!ws) return;
    if (myReady || reason) {
      wsSend({ type:'PLAYER_UNREADY' });
      wsSend({ type:'NOT_READY' });
      setReadyUI(false);
      if (reason) showToast('⛔ Unreadied: ' + reason);
      else showToast('⛔ Unready');
      log('> PLAYER_UNREADY');
    }
  }

  function onCharClicked(id){
    if (!ws || !id) return;
    if (takenChars.has(id) && id !== myCharId){ showToast('That character is taken.'); return; }
    if (myReady && id !== myCharId) { sendUnready('Changed character'); }
    wsSend({ type:'CHARACTER_SELECT', charId:id });
    myCharId = id;
    markSelected(myCharId);
    enableReadyButton(true);
  }

  // ======== Roll overlay ========
  function allowRollButton(){
    if (phase === 'lobby') return false;
    if (inTurnOrder) return !myHasRolled;
    return !!canRollNow;
  }
  function updateRollUI(){
    if (!rollBtn) return;
    const show = allowRollButton();
    rollBtn.style.display = show ? 'inline-block' : 'none';
    rollBtn.disabled = !show;
    rollBtn.classList.toggle('btn-disabled', !show);
  }

  function showRollOverlay(title){
    if (!rollPanel || !rollTitle || !rollValue || !rollState) return;
    if (phase === 'lobby') { setDbg('overlay blocked in lobby'); return; }
    rollTitle.textContent = title || 'Roll';
    rollValue.textContent = '—';
    rollState.textContent = 'Waiting…';
    rollState.classList.remove('ok'); rollState.classList.add('no');
    rollPanel.classList.remove('hidden'); rollPanel.style.display='block';
    updateRollUI();
    setTimeout(()=>window.scrollTo(0,0), 0);
  }
  function hideRollOverlay(){ if(rollPanel) rollPanel.classList.add('hidden'); }

  // ======== Session termination (host closed / kicked / expired) ========
  const TERMINAL_CLOSE_CODES = new Set([4000,4001,4002,4003,4401,4403,4410,4411]);
  let _terminal = false;

  function endSession(reason = 'Session closed') {
    _terminal = true;
    shouldReconnect = false;
    reconnectAttempts = 0;

    try { clearSession(); } catch {}

    try { ws && ws.close(); } catch {}
    ws = null;

    setStatus(reason);
    setPhase('lobby');
    setLobbyVisible(false);
    joinCard?.classList.remove('hidden');

    myReady = false; myCharId = null; takenChars.clear();
    if (charGrid) charGrid.innerHTML = '';
    enableReadyButton(false);
    setReadyUI(false);

    canRollNow = false; inTurnOrder = false; myHasRolled = false;
    if (rollPanel) { rollPanel.classList.add('hidden'); rollPanel.style.display=''; }
    if (triviaPadEl) triviaPadEl.style.display='none';
    updateRollUI();

    showToast('🔒 ' + reason, 1800);
  }

  // ======== Rehydrate helpers (fix "stuck in lobby" cases) ========
  let rehydrateTimer = 0;
  function requestRehydrate(tag){
    setDbg('rehydrate:' + (tag||''));
    wsSend({ type:'REQUEST_SNAPSHOT' });
    wsSend({ type:'REQUEST_CATALOG' });
    wsSend({ type:'LOBBY_SNAPSHOT' }); // some hosts listen to this alias
  }
  function scheduleRehydrate(ms=900){
    if (rehydrateTimer) clearTimeout(rehydrateTimer);
    rehydrateTimer = setTimeout(()=>{
      const empty = !charGrid || charGrid.children.length === 0;
      requestRehydrate('timer1');
      if (empty) setTimeout(()=>{
        if (!charGrid || charGrid.children.length === 0) requestRehydrate('timer2');
      }, 1500);
    }, ms);
  }
  function hardReset(reason='Manual reset'){ endSession(reason); }
  window.dpReset = hardReset;
  window.dpRehydrate = ()=>requestRehydrate('manual');

  // ======== Socket lifecycle ========
  function attachWsHandlers(sock){
    sock.onopen = () => {
      _terminal = false;
      shouldReconnect = true;
      reconnectAttempts = 0;
      setPhase('lobby');
      wsSend({ type: 'HELLO_PLAYER', roomId, playerId, name: (nameInput?.value||'').trim() || 'Player' });
      setStatus('Connected.', true);
      joinCard?.classList.add('hidden');
      setLobbyVisible(true);
      ensureGridVisible();

      saveSession();

      clearInterval(hbInterval);
      hbInterval = setInterval(() => wsSend({ type:'PING' }), 5000);
      updateRollUI();

      // NEW: proactively rehydrate if host didn’t push immediately
      scheduleRehydrate(300);
    };
    sock.onmessage = onSocketMessage;
    sock.onclose = (e) => {
      clearInterval(hbInterval);
      triviaAllowed = null; triviaMode = 'PENDING';

      if (_terminal) return; // already handled by broadcast

      const code = Number(e.code || 0);
      const reason = String(e.reason || '').toUpperCase();
      const reasonLooksTerminal =
        reason.includes('ROOM_CLOSED') ||
        reason.includes('SESSION')     ||
        reason.includes('KICK')        ||
        reason.includes('EXPIRE')      ||
        reason.includes('FORBIDDEN')   ||
        reason.includes('UNAUTHORIZED');

      const isTerminal = TERMINAL_CLOSE_CODES.has(code) || reasonLooksTerminal;

      if (isTerminal) { endSession(e.reason || 'Session closed'); return; }

      // Non-terminal → attempt reconnect if allowed
      setDbg('WS closed ' + code + ' ' + (e.reason || ''));
      if (shouldReconnect && roomId && playerId) {
        setLobbyVisible(false);
        joinCard?.classList.add('hidden');
        scheduleReconnect('socket closed');
        updateRollUI();
        return;
      }

      // Hard offline / session cleared
      setStatus('Disconnected');
      setLobbyVisible(false);
      joinCard?.classList.remove('hidden');
      myReady = false; myCharId = null; takenChars.clear();
      if (charGrid) charGrid.innerHTML = '';
      enableReadyButton(false);
      setReadyUI(false);
      canRollNow = false; inTurnOrder = false; myHasRolled = false;
      if (rollPanel) { rollPanel.classList.add('hidden'); rollPanel.style.display=''; }
      if (triviaPadEl) triviaPadEl.style.display='none';
      updateRollUI();
    };
  }

  // ======== Message router ========
  function normType(t){
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
    if (soloSanitized.startsWith('SOLOTRIVIA_')) return ('TRIVIA_' + soloSanitized.slice('SOLOTRIVIA_'.length));
    if (soloSanitized.startsWith('SOLO_')) return soloSanitized.slice('SOLO_'.length);
    if (soloSanitized.startsWith('SOLOTRIVIA')) return ('TRIVIA' + soloSanitized.slice('SOLOTRIVIA'.length));
    if (upper.startsWith('SOLOTRIVIA')) return ('TRIVIA' + upper.slice('SOLOTRIVIA'.length));
    return upper;
  }

  function onSocketMessage(ev){
    log('< ' + ev.data);
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'PONG') return;

      // unwrap STATE
      const isWrapped = (msg && msg.type === 'STATE' && msg.state);
      const inner = isWrapped ? msg.state : msg;
      const type = normType(inner.type || msg.type);
      const payload = inner;
      setDbg(type || 'unknown');

      // NEW: treat welcome/connected as a cue to rehydrate
      if (type === 'WELCOME' || type === 'HELLO' || type === 'CONNECTED') {
        scheduleRehydrate(0);
        return;
      }

      // ===== terminal signals =====
      if (type === 'ROOM_CLOSED' || type === 'SESSION_END' || type === 'GAME_ENDED') {
        endSession(payload.reason || 'Host ended the session');
        return;
      }
      if (type === 'KICKED' || type === 'PLAYER_KICKED') {
        const pid = (payload.playerId || payload.id || '').trim();
        if (!pid || idsEqual(pid, playerId)) { endSession('You were removed by the host'); return; }
      }

      if (type === 'TEXT' && payload.message) showToast(payload.message);

      // === TURN-ORDER ===
      if (type === 'TURN_ORDER_START') {
        setPhase('turn_order');
        inTurnOrder = true;
        playerNameById.clear();
        const arr = payload.players || payload.order || [];
        for (const p of arr) if (p && (p.playerId || p.id)) {
          const pid = p.playerId || p.id;
          playerNameById.set(pid, p.name || pid);
        }
        myHasRolled = false;
        showRollOverlay('Roll for Turn Order');
        updateRollUI();
        return;
      }

      if (type === 'TURN_ORDER_FEEDBACK') {
        const who  = payload.playerId || payload.id;
        const roll = (payload.roll != null ? payload.roll : payload.value);
        if (who === playerId) {
          myHasRolled = true;
          rollValue.textContent = String(roll);
          rollState.textContent = 'Rolled';
          rollState.classList.add('ok'); rollState.classList.remove('no');
        }
        updateRollUI();
        return;
      }

      if (type === 'TURN_ORDER_DONE') {
        inTurnOrder = false;
        setPhase('in_game');
        const ordered = payload.ordered || payload.order || [];
        const rolls   = payload.rolls || payload.values || {};
        const lines = ordered.map((pid,i)=>{
          const name = playerNameById.get(pid) || pid;
          const me   = (pid === playerId) ? ' (you)' : '';
          const r    = (rolls && rolls[pid] != null) ? ` — ${rolls[pid]}` : '';
          return `${i+1}. ${name}${me}${r}`;
        }).join('<br/>');
        orderResult.innerHTML = lines;
        orderResult.classList.remove('hidden');

        canRollNow = false;
        rollState.textContent = 'Waiting…';
        rollState.classList.remove('ok');
        rollState.classList.add('no');
        updateRollUI();
        return;
      }

      // === MAIN GAME TURNS ===
      if (type === 'YOUR_TURN') {
        setPhase('in_game');
        const pid   = (payload.playerId || payload.id || '').trim();
        const pname = (payload.name || '').trim();
        const isMe  = isMeFrom(pid, pname);

        if (!pid && !isMe) { setDbg('YOUR_TURN (no pid, no name match) ignored'); return; }

        canRollNow = isMe;
        if (isMe) {
          rollState.textContent = 'Waiting…';
          rollState.classList.remove('ok'); rollState.classList.add('no');
          showRollOverlay('Your Turn — Roll!');
          showToast('🎲 Your turn! Tap Roll.');
        } else {
          hideRollOverlay();
          showToast('⏳ Waiting for other player…', 1200);
        }
        updateRollUI();
        return;
      }

      if (type === 'ROLL_PROMPT') {
        setPhase('in_game');
        const pid   = (payload.playerId || payload.id || '').trim();
        const pname = (payload.name || '').trim();
        const isMe  = isMeFrom(pid, pname);

        canRollNow = !!isMe;
        if (isMe) {
          rollState.textContent = 'Waiting…';
          rollState.classList.remove('ok'); rollState.classList.add('no');
          showRollOverlay('Your Turn — Roll!');
          showToast('🎲 Your turn! Tap Roll.');
        } else {
          setDbg('ROLL_PROMPT (not me)');
        }
        updateRollUI();
        return;
      }

      if (type === 'MOVE_BEGIN') {
        if (idsEqual(payload.playerId || payload.id, playerId)) {
          rollState.textContent = 'Rolled';
          rollState.classList.add('ok'); rollState.classList.remove('no');
        }
        canRollNow = false; updateRollUI(); return;
      }

      if (type === 'MOVE_END') { canRollNow = false; hideRollOverlay(); updateRollUI(); return; }

      // === SPACE / COINS feedback ===
      if (type === 'SPACE_LANDED') { showToast(`🧭 Landed on ${payload.spaceType || 'Unknown'} (space ${payload.spaceIndex})`); return; }
      if (type === 'COINS_DELTA') {
        const d = Number(payload.delta || 0);
        const total = Number(payload.total || 0);
        const sign = d > 0 ? '+' : '';
        showToast(`🪙 Coins ${sign}${d} → ${total}`);
        return;
      }
      if (type === 'SPACE_RESOLVE') { showToast(`✅ ${payload.outcome || 'Resolved'}`); return; }

      // === TRIVIA (controls only) ===
      if (type === 'TRIVIA_START') { showTriviaPadIfAllowed(payload); return; }
      if (type === 'TRIVIA_END') {
        endTriviaPad(); triviaAllowed = null; triviaMode = 'PENDING';
        if (payload && payload.winnerId) {
          const coins = Number(payload.awarded || 0);
          showToast(`🏆 ${payload.winnerId} won ${coins>0?`+${coins}`:''}`);
        }
        return;
      }

      // ---- STATE snapshots / legacy trivia paths ----
      if (msg.type === 'STATE') {
        const s = msg.state || {};
        const stateType = normType(s.type);

        if (s.trivia && (s.trivia.open === true || s.trivia.phase === 'start' || s.trivia.phase === 'open')) { showTriviaPadIfAllowed(s.trivia, { quiet:true }); return; }
        if (s.trivia && (s.trivia.closed === true || s.trivia.phase === 'end' || s.trivia.phase === 'closed' || s.trivia.phase === 'result')) { endTriviaPad(); triviaAllowed = null; triviaMode = 'PENDING'; return; }

        if (stateType === 'TRIVIA_START' || s.answerWindowOpen === true || (typeof s.answerWindowMillis === 'number' && s.answerWindowMillis > 0)) { showTriviaPadIfAllowed(s, { quiet:true }); return; }
        if (stateType === 'TRIVIA_END'   || s.answerWindowOpen === false || (typeof s.answerWindowMillis === 'number' && s.answerWindowMillis <= 0)) { endTriviaPad(); triviaAllowed = null; triviaMode = 'PENDING'; return; }

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
          const me = players.find(p => (p.playerId && p.playerId===playerId) || (p.name && p.name===(nameInput?.value||'').trim()));
          if (me && !!me.ready !== myReady) setReadyUI(!!me.ready);
          canRollNow = false; inTurnOrder = false; myHasRolled = false;
          updateRollUI();
          return;
        }

        if (stateType === 'CHARACTER_TAKEN')  { takenChars.add(String(s.charId)); markTaken([...takenChars]); return; }
        if (stateType === 'CHARACTER_PICKED') { applyCharacterPicked(s.playerId, s.charId); return; }
        if (stateType === 'READY_OPEN')  { showToast('Ready phase open'); return; }
        if (stateType === 'READY_CLOSE') { showToast('Ready closed'); return; }

        if (stateType === 'LOBBY_LOCKED') {
          setStatus('Game starting…', true);
          setReadyUI(false);
          lobbyArea?.classList.add('hidden');
          setPhase('in_game');
          hideRollOverlay();
          updateRollUI();
          return;
        }

        if (stateType === 'TURN_STATE' || stateType === 'CURRENT_TURN') {
          if (phase === 'lobby') return;
          const pid = s.currentPlayerId || (s.turn && s.turn.currentPlayerId);
          const pname =
            s.currentPlayerName || (s.turn && s.turn.currentPlayerName) ||
            playerNameById.get(pid) || s.name || '';
          const isMe = isMeFrom(pid, pname);
          canRollNow = !!isMe;
          if (isMe) {
            showRollOverlay('Your Turn — Roll!');
            rollState.textContent = 'Waiting…';
            rollState.classList.remove('ok'); rollState.classList.add('no');
          } else {
            hideRollOverlay();
          }
          updateRollUI();
          return;
        }

        if (s.type === 'TEXT') { showToast('📣 ' + (s.message || 'Info')); return; }
      }
    } catch(e) { console.error(e); }
  }

  function applyCharacterPicked(pid, cid){
    if (!pid) return;
    if (idsEqual(pid, playerId)) {
      myCharId = cid || null;
      markSelected(myCharId);
      enableReadyButton(!!myCharId);
    }
  }

  // ======== Trivia gating (controls only) ========
  let triviaAllowed = null;         // null=unknown, true=can answer, false=cannot
  let triviaMode = 'PENDING';       // 'FFA' | 'SOLO' | 'PENDING'
  let triviaPadEl = null, triviaPadButtons = [];

  function ensureTriviaPad(){
    if (triviaPadEl) return triviaPadEl;
    const pad = document.createElement('div');
    pad.id = 'triviaPad';
    pad.style.cssText = `position:fixed; inset:0; z-index:10010; display:none; background:rgba(0,0,0,.5);`;
    pad.innerHTML = `
      <div style="
        position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
        width:min(520px,92%); background:#141418; border:1px solid #2a2a32;
        border-radius:16px; padding:16px; display:flex;flex-direction:column; gap:12px;">
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

    const btnA = pad.querySelector('#tpA');
    const btnB = pad.querySelector('#tpB');
    const btnC = pad.querySelector('#tpC');
    const btnD = pad.querySelector('#tpD');
    triviaPadButtons = [btnA, btnB, btnC, btnD];
    triviaPadButtons.forEach((b, i)=>{
      b.addEventListener('click', ()=>{
        if (triviaAllowed !== true) { showToast('Not your question.'); return; }
        triviaPadButtons.forEach(bb=>{ bb.disabled = true; bb.classList.add('btn-disabled'); });
        sendIntent('TRIVIA_ANSWER', i);
        showToast('✅ Answer sent');
      }, { passive:true });
    });

    triviaPadEl = pad;
    return pad;
  }
  function showTriviaPad(){
    if (triviaAllowed !== true) { endTriviaPad(); return; }
    const pad = ensureTriviaPad();
    triviaPadButtons.forEach(bb=>{ bb.disabled = false; bb.classList.remove('btn-disabled'); });
    pad.style.display = 'block';
  }
  function endTriviaPad(){
    if (!triviaPadEl) return;
    triviaPadButtons.forEach(bb=>{ bb.disabled = true; bb.classList.add('btn-disabled'); });
    triviaPadEl.style.display='none';
  }

  function hasTriviaHints(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const hintKeys = [
      'mode', 'triviaMode', 'answerMode', 'type',
      'isSolo', 'solo', 'soloMode',
      'isFfa', 'ffa', 'freeForAll',
      'allowedPlayerIds', 'allowedPlayers', 'allowedIds', 'allowed', 'allow', 'participants',
      'allowedPlayerId', 'participantIds',
      'soloPlayerId', 'targetPlayerId', 'activePlayerId',
      'promptPlayerId', 'promptedPlayerId', 'focusPlayerId', 'challengePlayerId',
      'soloPlayer'
    ];
    return hintKeys.some((key) => Object.prototype.hasOwnProperty.call(payload, key) && payload[key] != null);
  }

  // === FIXED: eligibility trusts allowed[] first to support reconnects with new raw ids ===
  function computeTriviaEligibility(payload){
    if (!payload || typeof payload !== 'object') { triviaMode = 'PENDING'; return false; }
    if (!hasTriviaHints(payload)) { triviaMode = 'PENDING'; return null; }

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
    const normalizeToken = (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9*]/g, '');
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
      // Strip tokens but remember that it's effectively open
      allowedIds = allowedIds.filter((_, i)=>!allowAllTokens.has(normalizedAllowed[i]));
    }
    const explicitAllowAll = explicitAllowAllFromFlags || allowAllFromAllowed;

    const soloHints = [
      payload.soloPlayerId, payload.targetPlayerId, payload.activePlayerId, payload.promptPlayerId,
      payload.promptedPlayerId, payload.focusPlayerId, payload.challengePlayerId, payload.soloPlayer
    ].flatMap(collectIds).filter(Boolean);

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
    triviaMode = resolvedMode;

    const myId = playerId || '';
    const isAllowed = (list) => list.some((id) => idsEqual(id, myId));

    if (resolvedMode === 'FFA') {
      if (allowedIds.length > 0) return isAllowed(allowedIds) || explicitAllowAll;
      return true; // default-open FFA
    }

    // SOLO: TRUST allow-list first (fixes reconnect where soloPlayerId is a seat id and myId is a new raw id)
    if (resolvedMode === 'SOLO') {
      if (allowedIds.length > 0) return isAllowed(allowedIds); // <-- critical: no early false
      if (soloHints.length > 0)   return isAllowed(soloHints);
      if (fallbackIds.length > 0) return isAllowed(fallbackIds);
      return false;
    }

    // Unknown mode: use allowedIds if present, else explicitAllowAll
    if (allowedIds.length > 0) return isAllowed(allowedIds);
    if (explicitAllowAll) return true;
    return false;
  }

  function showTriviaPadIfAllowed(payload, opts = {}){
    const hintful = hasTriviaHints(payload);
    if (!hintful && opts.quiet && triviaAllowed != null) {
      if (triviaAllowed) showTriviaPad();
      else endTriviaPad();
      return;
    }
    const eligibility = computeTriviaEligibility(payload);
    triviaAllowed = eligibility;
    if (eligibility === true) showTriviaPad();
    else {
      endTriviaPad();
      if (eligibility === false && !opts.quiet) showToast('Trivia in progress…');
    }
  }

  function sendIntent(intentType, value){
    if (intentType === 'TRIVIA_ANSWER' && triviaAllowed !== true) return;
    wsSend({ type:'INTENT', intent:intentType, value:String(value) }); // legacy
    wsSend({ type:intentType, optionIndex:Number(value) });            // typed DTO
  }

  // ======== Boot: DOM init + listeners + auto-resume ========
  function initDom() {
    $ = (id)=>document.getElementById(id);
    logEl     = $('log');
    statusEl  = $('status');
    joinCard  = $('joinCard');
    lobbyArea = $('lobbyArea');
    readyBtn  = $('btnReady');
    readyPill = $('readyPill');
    charGrid  = $('charGrid');
    nameInput = $('name');
    dbg       = $('dbg');

    rollPanel   = $('turnOrder');
    rollBtn     = $('btnRoll');
    rollTitle   = $('rollTitle');
    rollState   = $('rollState');
    rollValue   = $('rollValue');
    orderResult = $('orderResult');

    // remove any legacy dev button if present
    (document.getElementById('btnShowRoll') || { remove:()=>{} }).remove();
  }

  function bindUi() {
    // Cancel a pending reconnect by tapping the status pill
    statusEl?.addEventListener('click', () => {
      if (!shouldReconnect || !reconnectTimer) return;
      cancelReconnect();
      setStatus('Reconnect canceled — use Join to re-enter');
    });

    // Hidden hard-reset gesture on Status: triple tap or long-press
    let _tapCount = 0, _lastTap = 0, _pressTo;
    statusEl?.addEventListener('click', () => {
      const now = Date.now();
      _tapCount = (now - _lastTap < 350) ? _tapCount + 1 : 1;
      _lastTap = now;
      if (_tapCount >= 3) { hardReset('manual triple-tap'); _tapCount = 0; }
    });
    statusEl?.addEventListener('touchstart', () => {
      _pressTo = setTimeout(() => hardReset('manual long-press'), 800);
    }, { passive:true });
    statusEl?.addEventListener('touchend', () => clearTimeout(_pressTo), { passive:true });

    // Character grid
    charGrid?.addEventListener('click', (e) => {
      const btn = e.target.closest('.charBtn');
      if (!btn || !charGrid.contains(btn)) return;
      const id = btn.dataset.charId;
      if (!id) return;
      onCharClicked(id);
    }, { passive: true });

    // Ready
    readyBtn?.addEventListener('click', () => {
      if (readyBtn.disabled || readyBtn.classList.contains('btn-disabled')) {
        if (!myCharId) showToast('Pick a character first');
        else showToast('Still waiting for lobby to open');
        return;
      }
      if (!ws) return;
      if (myReady) sendUnready();
      else sendReady();
    }, { passive: true });

    readyPill?.addEventListener('click', () => {
      if (readyBtn.disabled || readyBtn.classList.contains('btn-disabled')) return;
      readyBtn.click();
    }, { passive: true });

    nameInput?.addEventListener('input', () => {
      if (myReady) sendUnready('Name changed');
    }, { passive:true });

    // Join (click)
    $('btnJoin')?.addEventListener('click', onJoinClicked, { passive:true });

    // Join on Enter in the room field
    const roomEl = $('room');
    if (roomEl) {
      roomEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onJoinClicked();
      });
    }

    // Roll
    rollBtn?.addEventListener('click', ()=>{
      if (!ws) return;
      if (!allowRollButton()) { updateRollUI(); return; }

      if (inTurnOrder && !myHasRolled) {
        wsSend({ type:'PLAYER_ROLL' });
        wsSend({ type:'ROLL', phase:'TURN_ORDER' });
        myHasRolled = true;
        rollState.textContent = 'Rolling…';
        updateRollUI();
        setDbg('PLAYER_ROLL/ROLL (turn-order) sent');
        return;
      }
      if (canRollNow) {
        wsSend({ type:'ROLL_MOVE' });
        wsSend({ type:'ROLL', phase:'MOVE' });
        rollState.textContent = 'Rolling…';
        canRollNow = false;
        updateRollUI();
        setDbg('ROLL_MOVE/ROLL (move) sent');
      }
    }, { passive:true });
  }

  async function onJoinClicked() {
    cancelReconnect();
    shouldReconnect = false;

    const roomEl = $('room');
    if (!roomEl) { showToast('Room input not found. Refresh the page.'); return; }

    roomId = String(roomEl.value || '').trim().toUpperCase();
    const name = String(nameInput?.value || '').trim() || 'Player';
    if (!roomId) { showToast('Enter room code.'); return; }

    const btn = $('btnJoin');
    if (btn) { btn.disabled = true; btn.classList.add('btn-disabled'); }
    setStatus('Joining…', true);

    try {
      const resp = await fetch(`${HTTP_BASE}/rooms/${encodeURIComponent(roomId)}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '<no body>');
        log(`Join HTTP failed: ${resp.status} ${txt}`);
        setStatus(`Join failed (${resp.status})`);
        showToast('Could not join room. Check code/capacity.');
        return;
      }
      const j = await resp.json().catch(() => ({}));
      playerId = j.playerId || j.id || '';
      if (!playerId) {
        log('Join response missing playerId: ' + JSON.stringify(j));
        setStatus('Join failed (no playerId)');
        showToast('Join failed: bad server response.');
        return;
      }
      shouldReconnect = true;
      saveSession();
      connectWs(); // HELLO on open
    } catch (e) {
      log('HTTP error: ' + e);
      setStatus('HTTP error');
      showToast('Network error while joining.');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('btn-disabled'); }
    }
  }

  function tryAutoResume(){
    const sess = loadSession();
    if (sess) {
      roomId   = sess.roomId;
      playerId = sess.playerId;
      if (nameInput) nameInput.value = sess.name || 'Player';
      setStatus('Reconnecting…', true);
      shouldReconnect = true;
      connectWs();
    }
  }

  function boot(){
    initDom();
    bindUi();

    // URL kill-switch: ?reset / #reset / ?wipe / ?clear
    if (/(^|[?#&])(reset|wipe|clear)(=1)?/i.test(location.search + location.hash)) {
      hardReset('URL reset');
      return;
    }

    tryAutoResume();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
