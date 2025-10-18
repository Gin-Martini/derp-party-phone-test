// DerpPhone v10.0 – trivia SOLO gating + roll gating
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

  // Trivia gating (new)
  let triviaAllowed = null;         // null=unknown, true=can answer, false=cannot
  let triviaMode = 'FFA';           // 'FFA' | 'SOLO' (best effort from payload)

  // ======== DOM ========
  const $ = (id)=>document.getElementById(id);
  const logEl = $('log');
  const statusEl = $('status');
  const joinCard = $('joinCard');
  const lobbyArea = $('lobbyArea');
  const readyBtn = $('btnReady');
  const readyPill = $('readyPill');
  const charGrid = $('charGrid');
  const nameInput = $('name');
  const dbg = $('dbg');

  const rollPanel = $('turnOrder');
  const rollBtn   = $('btnRoll');
  const rollTitle = $('rollTitle');
  const rollState = $('rollState');
  const rollValue = $('rollValue');
  const orderResult = $('orderResult');

  const _legacyBtn = document.getElementById('btnShowRoll'); if (_legacyBtn) _legacyBtn.remove();

  // ======== Utils / UI ========
  function setPhase(p){ phase = p; setDbg('phase=' + p); }
  function setDbg(x){ if (dbg) dbg.textContent = 'last: ' + x; }
  function log(x){ if (!logEl) return; logEl.textContent += x + "\n"; logEl.scrollTop = logEl.scrollHeight; }
  function showToast(text, ms=1600){ const t=$('toast'); if(!t) return; t.textContent=text; t.style.display='block'; clearTimeout(showToast._to); showToast._to=setTimeout(()=>t.style.display='none',ms); }
  function setStatus(text, pill=false){ statusEl.textContent='Status: '+text; statusEl.classList.toggle('pill', pill); }
  function setLobbyVisible(on){ lobbyArea.classList.toggle('hidden', !on); }
  function setReadyPill(on){ readyPill.textContent=on?'Ready':'Not Ready'; readyPill.classList.toggle('ok',on); readyPill.classList.toggle('no',!on); }
  function ensureGridVisible(){ charGrid.style.display='grid'; }
  function idsEqual(a,b){ return String(a||'').trim() === String(b||'').trim(); }

  function enableReadyButton(can){
    const shouldEnable = can || myReady;
    readyBtn.disabled = !shouldEnable;
    readyBtn.classList.toggle('btn-disabled', !shouldEnable);
    setDbg('ready enabled=' + shouldEnable);
  }

  function setReadyUI(isReady){
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
        const fb=document.createElement('div'); fb.className='fallback'; fb.textContent=label.slice(0,2).toUpperCase();
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
    [...charGrid.querySelectorAll('.charBtn')].forEach(b=>{
      const id = b.dataset.charId;
      const isTaken = takenChars.has(id);
      const isMine  = (id === myCharId);
      b.classList.toggle('taken', isTaken && !isMine);
      b.disabled = isTaken && !isMine;
    });
  }

  function markSelected(id){
    [...charGrid.querySelectorAll('.charBtn')].forEach(b=>{
      b.classList.toggle('selected', b.dataset.charId === id);
    });
  }

  // ======== READY helpers ========
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
    if (!myReady && !reason) return;
    wsSend({ type:'PLAYER_UNREADY' });
    wsSend({ type:'NOT_READY' });
    setReadyUI(false);
    if (reason) showToast('⛔ Unreadied: ' + reason);
    else showToast('⛔ Unready');
    log('> PLAYER_UNREADY');
  }

  function onCharClicked(id){
    if (!ws) return;
    if (!id) return;
    if (takenChars.has(id) && id !== myCharId){ showToast('That character is taken.'); return; }
    if (myReady && id !== myCharId) { sendUnready('Changed character'); }
    wsSend({ type:'CHARACTER_SELECT', charId:id });
    myCharId = id;
    markSelected(myCharId);
    enableReadyButton(true);
  }

  function applyCharacterPicked(playerIdPicked, charIdPicked){
    if (playerIdPicked === playerId){ myCharId = charIdPicked; showToast('Picked: ' + charIdPicked); enableReadyButton(true); }
    takenChars.add(String(charIdPicked));
    markTaken([...takenChars]);
    markSelected(myCharId);
  }

  // ======== ROLL overlay ========
  function allowRollButton(){
    if (phase === 'lobby') return false;
    if (inTurnOrder) return !myHasRolled;
    return !!canRollNow;
  }
  function updateRollUI(){
    const show = allowRollButton();
    rollBtn.style.display = show ? 'inline-block' : 'none';
    rollBtn.disabled = !show;
    rollBtn.classList.toggle('btn-disabled', !show);
  }

  function showRollOverlay(title){
    if (phase === 'lobby') { setDbg('overlay blocked in lobby'); return; }
    rollTitle.textContent = title || 'Roll';
    rollValue.textContent = '—';
    rollState.textContent = 'Waiting…';
    rollState.classList.remove('ok'); rollState.classList.add('no');
    rollPanel.classList.remove('hidden'); rollPanel.style.display='block';
    updateRollUI();
    setTimeout(()=>window.scrollTo(0,0), 0);
  }
  function hideRollOverlay(){ rollPanel.classList.add('hidden'); }

  // ---- Trivia Pad (controls only) ----
  let triviaPadEl = null, triviaPadButtons = [];
  function ensureTriviaPad(){
    if (triviaPadEl) return triviaPadEl;
    const pad = document.createElement('div');
    pad.id = 'triviaPad';
    pad.style.cssText = `
      position:fixed; inset:0; z-index:10010; display:none;
      background:rgba(0,0,0,.5);
    `;
    pad.innerHTML = `
      <div style="
        position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
        width:min(520px,92%); background:#141418; border:1px solid #2a2a32;
        border-radius:16px; padding:16px; display:flex;flex-direction:column; gap:12px;
      ">
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
        if (triviaAllowed === false) { showToast('Not your question.'); return; }
        triviaPadButtons.forEach(bb=>{ bb.disabled = true; bb.classList.add('btn-disabled'); });
        sendIntent('TRIVIA_ANSWER', i);
        showToast('✅ Answer sent');
      }, { passive:true });
    });

    triviaPadEl = pad;
    return pad;
  }
  function showTriviaPad(){
    if (triviaAllowed === false) {
      endTriviaPad();
      return;
    }
    if (triviaMode === 'SOLO' && triviaAllowed !== true) {
      endTriviaPad();
      return;
    }
    const pad = ensureTriviaPad();
    triviaPadButtons.forEach(bb=>{ bb.disabled = false; bb.classList.remove('btn-disabled'); });
    pad.style.display = 'block';
  }
  function endTriviaPad(){
    if (!triviaPadEl) return;
    triviaPadButtons.forEach(bb=>{ bb.disabled = true; bb.classList.add('btn-disabled'); });
    setTimeout(()=>{ if (triviaPadEl) triviaPadEl.style.display='none'; }, 600);
  }

  // === SOLO/FFA gating helpers ===
  function computeTriviaEligibility(payload){
    if (!payload) return true;
    const mode = String(payload.mode || payload.triviaMode || '').toUpperCase();
    const allowed = payload.allowed || payload.allow || payload.participants || [];
    const soloId = payload.soloPlayerId || payload.playerId || payload.activePlayerId || '';

    triviaMode = (mode === 'SOLO') ? 'SOLO' : 'FFA';

    if (Array.isArray(allowed) && allowed.length > 0) {
      return allowed.some(id => idsEqual(id, playerId));
    }
    if (triviaMode === 'SOLO') {
      if (soloId) return idsEqual(soloId, playerId);
      return false; // conservative if SOLO but no target given
    }
    return true; // FFA fallback
  }

  function showTriviaPadIfAllowed(payload){
    triviaAllowed = computeTriviaEligibility(payload);
    if (triviaAllowed) {
      showTriviaPad();
    } else {
      endTriviaPad();
      showToast('Trivia in progress…');
    }
  }

  // ======== Intent (legacy+modern) ========
  function sendIntent(intentType, value){
    if (intentType === 'TRIVIA_ANSWER' && triviaAllowed === false) return;
    wsSend({ type:'INTENT', intent:intentType, value:String(value) }); // legacy
    wsSend({ type:intentType, optionIndex:Number(value) });            // typed DTO
  }

  function normType(t){
    if(!t) return t;
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
    return m[t] || t;
  }

  // ======== Message router ========
  function onSocketMessage(ev){
    log('< ' + ev.data);
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'PONG') return;

      if (msg.type === 'CHARACTER_CATALOG') {
        renderCatalog(msg.entries || msg.list || msg.characters || []);
        return;
      }

      const isWrapped = (msg && msg.type === 'STATE' && msg.state);
      const inner = isWrapped ? msg.state : msg;
      const type = normType(inner.type || msg.type);
      const payload = inner;
      setDbg(type || 'unknown');

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
        const pid  = (payload.playerId || payload.id || '').trim();
        const pname = (payload.name || '').trim();
        const isPidMatch = (pid && pid === playerId);
        theNameValue = (nameInput.value||'').trim();
        const isNameMatch = (pname && pname === theNameValue);
        const isMe = isPidMatch || (!isPidMatch && isNameMatch);

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
        const pid  = (payload.playerId || payload.id || '').trim();
        const pname = (payload.name || '').trim();
        const isPidMatch = (pid && pid === playerId);
        const isNameMatch = (pname && pname === (nameInput.value||'').trim());
        const isMe = isPidMatch || (!isPidMatch && isNameMatch);

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
        canRollNow = false;
        updateRollUI();
        return;
      }

      if (type === 'MOVE_END') {
        canRollNow = false;
        hideRollOverlay();
        updateRollUI();
        return;
      }

      // === SPACE / COINS feedback ===
      if (type === 'SPACE_LANDED') {
        const idx = payload.spaceIndex;
        const kind = payload.spaceType || 'Unknown';
        showToast(`🧭 Landed on ${kind} (space ${idx})`);
        return;
      }
      if (type === 'COINS_DELTA') {
        const d = Number(payload.delta || 0);
        const total = Number(payload.total || 0);
        const sign = d > 0 ? '+' : '';
        showToast(`🪙 Coins ${sign}${d} → ${total}`);
        return;
      }
      if (type === 'SPACE_RESOLVE') {
        const outcome = payload.outcome || 'Resolved';
        showToast(`✅ ${outcome}`);
        return;
      }

      // === TRIVIA (controls only) ===
      if (type === 'TRIVIA_START') {
        showTriviaPadIfAllowed(payload); // uses mode/allowed/soloPlayerId if present
        return;
      }

      if (type === 'TRIVIA_END') {
        endTriviaPad();
        triviaAllowed = null;
        triviaMode = 'FFA';
        if (payload && payload.winnerId) {
          const coins = Number(payload.awarded || 0);
          showToast(`🏆 ${payload.winnerId} won ${coins>0?`+${coins}`:''}`);
        }
        return;
      }

      // ---- STATE snapshots / legacy trivia paths ----
      if (msg.type === 'STATE') {
        const s = msg.state || {};

        if (s.trivia && (s.trivia.open === true || s.trivia.phase === 'start' || s.trivia.phase === 'open')) {
          showTriviaPadIfAllowed(s.trivia); return;
        }
        if (s.trivia && (s.trivia.closed === true || s.trivia.phase === 'end' || s.trivia.phase === 'closed' || s.trivia.phase === 'result')) {
          endTriviaPad(); triviaAllowed = null; triviaMode = 'FFA'; return;
        }

        if (s.type === 'ANSWER_WINDOW_OPEN' || s.type === 'TRIVIA_OPEN' || s.type === 'TRIVIA_PROMPT' || s.answerWindowOpen === true || (typeof s.answerWindowMillis === 'number' && s.answerWindowMillis > 0)) {
          if (triviaAllowed === true || triviaMode !== 'SOLO') showTriviaPad();
          return;
        }
        if (s.type === 'ANSWER_WINDOW_CLOSE' || s.type === 'TRIVIA_DONE' || s.type === 'TRIVIA_CLOSE' || s.type === 'TRIVIA_RESULT' || s.answerWindowOpen === false || (typeof s.answerWindowMillis === 'number' && s.answerWindowMillis <= 0)) {
          endTriviaPad(); triviaAllowed = null; triviaMode = 'FFA'; return;
        }

        if (s.type === 'CHARACTER_CATALOG') { renderCatalog(s.entries||[]); return; }

        if (s.type === 'LOBBY_STATE') {
          setPhase('lobby');
          hideRollOverlay();
          const players = s.players||[];
          const text = players.length
            ? players.map(p => `${p.name}${p.ready?' ✅':''}${p.charId?(' · '+p.charId):''}`).join(', ')
            : '—';
          setStatus('Lobby: ' + text, true);
          markTaken(s.taken||[]);
          const me = players.find(p => (p.playerId && p.playerId===playerId) || (p.name && p.name===(nameInput.value||'').trim()));
          if (me && !!me.ready !== myReady) setReadyUI(!!me.ready);
          canRollNow = false;
          inTurnOrder = false;
          myHasRolled = false;
          updateRollUI();
          return;
        }

        if (s.type === 'CHARACTER_TAKEN') { takenChars.add(String(s.charId)); markTaken([...takenChars]); return; }
        if (s.type === 'CHARACTER_PICKED') { applyCharacterPicked(s.playerId, s.charId); return; }
        if (s.type === 'READY_OPEN')  { showToast('Ready phase open'); return; }
        if (s.type === 'READY_CLOSE') { showToast('Ready closed'); return; }

        if (s.type === 'LOBBY_LOCKED') {
          setStatus('Game starting…', true);
          setReadyUI(false);
          lobbyArea.classList.add('hidden');
          setPhase('in_game');
          hideRollOverlay();
          updateRollUI();
          return;
        }

        if (s.type === 'TURN_STATE' || s.type === 'CURRENT_TURN') {
          if (phase === 'lobby') return;
          const pid = s.currentPlayerId || (s.turn && s.turn.currentPlayerId);
          if (!pid) return;
          canRollNow = idsEqual(pid, playerId);
          if (canRollNow) {
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

  // ======== Socket lifecycle ========
  function attachWsHandlers(sock){
    sock.onopen = () => {
      setPhase('lobby');
      wsSend({ type: 'HELLO_PLAYER', roomId, playerId, name: (nameInput.value||'').trim() || 'Player' });
      setStatus('Connected. In Lobby.', true);
      joinCard.classList.add('hidden');
      setLobbyVisible(true);
      ensureGridVisible();

      clearInterval(hbInterval);
      hbInterval = setInterval(() => wsSend({ type:'PING' }), 5000);
      updateRollUI();
    };
    sock.onmessage = onSocketMessage;
    sock.onclose = () => {
      setStatus('Disconnected');
      setLobbyVisible(false);
      joinCard.classList.remove('hidden');
      clearInterval(hbInterval);
      myReady = false; myCharId = null; takenChars.clear();
      charGrid.innerHTML = '';
      enableReadyButton(false);
      setReadyUI(false);
      canRollNow = false; inTurnOrder = false; myHasRolled = false;
      triviaAllowed = null; triviaMode = 'FFA';
      setPhase('lobby');
      if (rollPanel) { rollPanel.classList.add('hidden'); rollPanel.style.display=''; }
      if (triviaPadEl) triviaPadEl.style.display='none';
      setDbg('WS closed');
      updateRollUI();
    };
  }

  // ======== UI wiring ========
  charGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.charBtn');
    if (!btn || !charGrid.contains(btn)) return;
    const id = btn.dataset.charId;
    if (!id) return;
    onCharClicked(id);
  }, { passive: true });

  readyBtn.addEventListener('click', () => {
    if (readyBtn.disabled || readyBtn.classList.contains('btn-disabled')) {
      if (!myCharId) showToast('Pick a character first');
      else showToast('Still waiting for lobby to open');
      return;
    }
    if (!ws) return;
    if (myReady) sendUnready();
    else sendReady();
  }, { passive: true });

  readyPill.addEventListener('click', () => {
    if (readyBtn.disabled || readyBtn.classList.contains('btn-disabled')) return;
    readyBtn.click();
  }, { passive: true });

  nameInput.addEventListener('input', () => {
    if (myReady) sendUnready('Name changed');
  }, { passive:true });

  $('btnJoin').onclick = async () => {
    roomId = ($('room').value || '').trim().toUpperCase();
    const name = (nameInput.value || '').trim() || 'Player';
    if (!roomId) { alert('Enter room code.'); return; }

    setStatus('Joining…', true);

    try {
      const resp = await fetch(`${HTTP_BASE}/rooms/${roomId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
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
      log('Got playerId: ' + playerId);
    } catch (e) {
      log('HTTP error: ' + e);
      setStatus('HTTP error');
      showToast('Network error while joining.');
      return;
    }

    try {
      ws = new WebSocket(WS_URL);
      attachWsHandlers(ws);
    } catch (e) {
      log('WS construct error: ' + e);
      setStatus('WebSocket error');
      return;
    }
  };

  // Roll button
  rollBtn.addEventListener('click', ()=>{
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

  // ======== End IIFE ========
})();
