// DerpPhone v10.0.1 – trivia SOLO gating + roll gating
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

  // ======== Reconnect/session (NEW) ========
  const SESSION_KEY = 'dp.session.v1';
  let shouldReconnect = false;
  let reconnectTimer = 0;
  let reconnectAttempts = 0;
  const backoff = (n) => Math.min(15000, 500 * Math.pow(1.8, n)) + Math.floor(Math.random()*150);
  
  function saveSession() {
    if (!roomId || !playerId) return;
    const name = (nameInput.value || '').trim() || 'Player';
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId, playerId, name })); } catch (_) {}
  }
  
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }
  
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
      connectWs(); // will send HELLO_PLAYER on open via attachWsHandlers
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
    } catch (e) {
      scheduleReconnect('ws construct failed');
    }
  }
  
  // Try auto-resume on load
  document.addEventListener('DOMContentLoaded', () => {
    const sess = loadSession();
    if (sess) {
      roomId   = sess.roomId;
      playerId = sess.playerId;
      if (nameInput) nameInput.value = sess.name || 'Player';
      setStatus('Reconnecting…', true);
      shouldReconnect = true;
      connectWs();
    }
  });

// Optional cancel control: tap status pill to cancel reconnect (long-press UX could be better later)
statusEl?.addEventListener('click', () => {
  if (!shouldReconnect || !reconnectTimer) return;
  cancelReconnect();
  setStatus('Reconnect canceled — use Join to re-enter');
});

  // Trivia gating (new)
  let triviaAllowed = null;         // null=unknown, true=can answer, false=cannot
  let triviaMode = 'PENDING';       // 'FFA' | 'SOLO' | 'PENDING' (best effort from payload)

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
    if (triviaAllowed !== true) {
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
    triviaPadEl.style.display='none';
  }

  // === SOLO/FFA gating helpers ===
  function computeTriviaEligibility(payload){
    if (!payload || typeof payload !== 'object') {
      triviaMode = 'PENDING';
      return false;
    }

    if (!hasTriviaHints(payload)) {
      triviaMode = 'PENDING';
      return null;
    }

    const collectIds = (raw) => {
      if (raw == null) return [];
      if (Array.isArray(raw)) return raw.flatMap(collectIds).filter(Boolean);
      if (typeof raw === 'object') {
        const direct = raw.playerId || raw.id || raw.value || raw.key || raw.targetPlayerId || raw.soloPlayerId;
        if (direct != null) return collectIds(direct);

        const keys = Object.keys(raw);
        if (!keys.length) return [];
        const boolKeys = keys.filter((k) => typeof raw[k] === 'boolean');
        if (boolKeys.length === keys.length) {
          return boolKeys.filter((k) => raw[k]);
        }
        return keys.flatMap((k) => collectIds(raw[k])).filter(Boolean);
      }
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return [];
        if (trimmed.includes(',')) return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
        return [trimmed];
      }
      if (typeof raw === 'number' || typeof raw === 'bigint') {
        return [String(raw)];
      }
      return [];
    };

    const normalizeMode = (value) => {
      if (value == null) return '';
      const compact = String(value).trim();
      if (!compact) return '';
      const cleaned = compact.toUpperCase().replace(/[^A-Z]/g, '');
      if (!cleaned) return '';

      const looksSolo = cleaned === 'SOLO' || cleaned === 'SOLOTRIVIA' || cleaned.includes('SOLOTRIVIA') || cleaned.includes('TRIVIASOLO') || cleaned.startsWith('SOLO');
      if (looksSolo) return 'SOLO';

      const looksFfa = cleaned === 'FFA' || cleaned === 'FREEFORALL' || cleaned === 'EVERYONE' || cleaned === 'ALLPLAYERS' || cleaned.includes('FREEFORALL');
      if (looksFfa) return 'FFA';

      return '';
    };

    const normalizeToken = (value) => {
      if (value == null) return '';
      return String(value).trim().toLowerCase().replace(/[^a-z0-9*]/g, '');
    };
    const allowAllTokens = new Set([
      'all',
      '*',
      'everyone',
      'everybody',
      'allplayers',
      'anyone',
      'anybody',
      'any',
      'ffa',
      'open',
    ]);

    const allowedSources = [
      payload.allowed,
      payload.allowedPlayerIds,
      payload.allowedPlayers,
      payload.allowedIds,
      payload.allow,
      payload.participants,
      payload.allowedPlayerId,
      payload.participantIds,
      payload.playerIds,
      payload.players,
    ];
    let allowedIds = allowedSources.flatMap(collectIds).filter(Boolean);

    const allowAllFlags = [payload.allowed, payload.allow, payload.participants];
    const explicitAllowAllFromFlags = allowAllFlags.some((v) => {
      if (v === true) return true;
      const token = normalizeToken(v);
      if (!token) return false;
      return allowAllTokens.has(token);
    });

    const normalizedAllowed = allowedIds.map((id) => normalizeToken(id));
    const allowAllFromAllowed = normalizedAllowed.some((token) => allowAllTokens.has(token));
    if (allowAllFromAllowed) {
      allowedIds = allowedIds.filter((_, idx) => !allowAllTokens.has(normalizedAllowed[idx]));
    }

    const explicitAllowAll = explicitAllowAllFromFlags || allowAllFromAllowed;

    const soloHintSources = [
      payload.soloPlayerId,
      payload.targetPlayerId,
      payload.activePlayerId,
      payload.promptPlayerId,
      payload.promptedPlayerId,
      payload.focusPlayerId,
      payload.challengePlayerId,
      payload.soloPlayer,
    ];
    const soloHints = soloHintSources.flatMap(collectIds).filter(Boolean);

    const fallbackSolo = [payload.playerId, payload.player];
    const fallbackIds = fallbackSolo.flatMap(collectIds).filter(Boolean);

    const explicitMode =
      normalizeMode(payload.mode) ||
      normalizeMode(payload.triviaMode) ||
      normalizeMode(payload.answerMode) ||
      normalizeMode(payload.type);
    const isSoloFlag = payload.isSolo === true || payload.solo === true || payload.soloMode === true;
    const isFfaFlag = payload.isFfa === true || payload.ffa === true || payload.freeForAll === true;

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
    const soloTarget = soloHints.find(Boolean) || fallbackIds.find(Boolean) || (allowedIds.length === 1 ? allowedIds[0] : '');

    if (resolvedMode === 'SOLO') {
      if (soloTarget && !idsEqual(soloTarget, myId)) return false;
      if (allowedIds.length > 0) return isAllowed(allowedIds);
      if (soloHints.length > 0) return isAllowed(soloHints);
      if (fallbackIds.length > 0) return isAllowed(fallbackIds);
      return false;
    }

    if (resolvedMode === 'FFA') {
      if (allowedIds.length > 0) return isAllowed(allowedIds);
      if (explicitAllowAll) return true;
      // FFA with no explicit allow-list defaults to open to everyone
      return true;
    }

    if (allowedIds.length > 0) return isAllowed(allowedIds);
    if (explicitAllowAll) return true;
    return false;
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

  function showTriviaPadIfAllowed(payload, opts = {}){
    const hintful = hasTriviaHints(payload);
    if (!hintful && opts.quiet && triviaAllowed != null) {
      if (triviaAllowed) showTriviaPad();
      else endTriviaPad();
      return;
    }

    const eligibility = computeTriviaEligibility(payload);
    triviaAllowed = eligibility;
    if (eligibility === true) {
      showTriviaPad();
    } else {
      endTriviaPad();
      if (eligibility === false && !opts.quiet) showToast('Trivia in progress…');
    }
  }

  // ======== Intent (legacy+modern) ========
  function sendIntent(intentType, value){
    if (intentType === 'TRIVIA_ANSWER' && triviaAllowed !== true) return;
    wsSend({ type:'INTENT', intent:intentType, value:String(value) }); // legacy
    wsSend({ type:intentType, optionIndex:Number(value) });            // typed DTO
  }

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

    if (soloSanitized.startsWith('SOLO_TRIVIA_')) {
      const base = 'TRIVIA_' + soloSanitized.slice('SOLO_TRIVIA_'.length);
      return m[base] || base;
    }

    if (soloSanitized.startsWith('SOLOTRIVIA_')) {
      const base = 'TRIVIA_' + soloSanitized.slice('SOLOTRIVIA_'.length);
      return m[base] || base;
    }

    if (soloSanitized.startsWith('SOLO_')) {
      const base = soloSanitized.slice('SOLO_'.length);
      return m[base] || base;
    }

    if (soloSanitized.startsWith('SOLOTRIVIA')) {
      const base = 'TRIVIA' + soloSanitized.slice('SOLOTRIVIA'.length);
      return m[base] || base;
    }

    if (upper.startsWith('SOLOTRIVIA')) {
      const base = 'TRIVIA' + upper.slice('SOLOTRIVIA'.length);
      return m[base] || base;
    }
    return upper;
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
        triviaMode = 'PENDING';
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

        if (s.trivia && (s.trivia.open === true || s.trivia.phase === 'start' || s.trivia.phase === 'open')) {
          showTriviaPadIfAllowed(s.trivia, { quiet:true }); return;
        }
        if (s.trivia && (s.trivia.closed === true || s.trivia.phase === 'end' || s.trivia.phase === 'closed' || s.trivia.phase === 'result')) {
          endTriviaPad(); triviaAllowed = null; triviaMode = 'PENDING'; return;
        }

        if (stateType === 'TRIVIA_START' || s.answerWindowOpen === true || (typeof s.answerWindowMillis === 'number' && s.answerWindowMillis > 0)) {
          showTriviaPadIfAllowed(s, { quiet:true });
          return;
        }
        if (stateType === 'TRIVIA_END' || s.answerWindowOpen === false || (typeof s.answerWindowMillis === 'number' && s.answerWindowMillis <= 0)) {
          endTriviaPad(); triviaAllowed = null; triviaMode = 'PENDING'; return;
        }

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
          const me = players.find(p => (p.playerId && p.playerId===playerId) || (p.name && p.name===(nameInput.value||'').trim()));
          if (me && !!me.ready !== myReady) setReadyUI(!!me.ready);
          canRollNow = false;
          inTurnOrder = false;
          myHasRolled = false;
          updateRollUI();
          return;
        }

        if (stateType === 'CHARACTER_TAKEN') { takenChars.add(String(s.charId)); markTaken([...takenChars]); return; }
        if (stateType === 'CHARACTER_PICKED') { applyCharacterPicked(s.playerId, s.charId); return; }
        if (stateType === 'READY_OPEN')  { showToast('Ready phase open'); return; }
        if (stateType === 'READY_CLOSE') { showToast('Ready closed'); return; }

        if (stateType === 'LOBBY_LOCKED') {
          setStatus('Game starting…', true);
          setReadyUI(false);
          lobbyArea.classList.add('hidden');
          setPhase('in_game');
          hideRollOverlay();
          updateRollUI();
          return;
        }

        if (stateType === 'TURN_STATE' || stateType === 'CURRENT_TURN') {
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
      shouldReconnect = true;           // NEW
      reconnectAttempts = 0;            // NEW
      setPhase('lobby');
      wsSend({ type: 'HELLO_PLAYER', roomId, playerId, name: (nameInput.value||'').trim() || 'Player' });
      setStatus('Connected.', true);
      joinCard.classList.add('hidden');
      setLobbyVisible(true);
      ensureGridVisible();
  
      saveSession();                    // NEW
  
      clearInterval(hbInterval);
      hbInterval = setInterval(() => wsSend({ type:'PING' }), 5000);
      updateRollUI();
    };
    sock.onmessage = onSocketMessage;
    sock.onclose = () => {
      // Don't immediately wipe everything; try to recover first
      clearInterval(hbInterval);
      triviaAllowed = null; triviaMode = 'PENDING';
      setPhase('lobby');
      setDbg('WS closed');
  
      if (shouldReconnect && roomId && playerId) {
        // Keep the lobby UI hidden while we attempt reconnect; show a status pill instead
        setLobbyVisible(false);
        joinCard.classList.add('hidden');
        scheduleReconnect('socket closed');   // NEW
        updateRollUI();
        return;
      }
  
      // Fallback: truly offline or session cleared — show Join
      setStatus('Disconnected');
      setLobbyVisible(false);
      joinCard.classList.remove('hidden');
      myReady = false; myCharId = null; takenChars.clear();
      charGrid.innerHTML = '';
      enableReadyButton(false);
      setReadyUI(false);
      canRollNow = false; inTurnOrder = false; myHasRolled = false;
      if (rollPanel) { rollPanel.classList.add('hidden'); rollPanel.style.display=''; }
      if (triviaPadEl) triviaPadEl.style.display='none';
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
      shouldReconnect = true;      // NEW
      saveSession();               // NEW
    } catch (e) {
      log('HTTP error: ' + e);
      setStatus('HTTP error');
      showToast('Network error while joining.');
      return;
    }
  
    connectWs();                   // NEW (instead of new WebSocket + attach here)
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
