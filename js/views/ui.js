import { state } from '../state.js';

export const $ = (sel) => document.querySelector(sel);

const el = {
  status: $('#status'),
  join:   $('#join-card'),
  lobby:  $('#lobby'),
  grid:   $('#catalogGrid'),
  btnReady: $('#btnReady'),
  lobbyInfo: $('#lobbyInfo'),
  roll: $('#rollOverlay'),
  rollLabel: $('#rollLabel'),
  rollSub: $('#rollSub'),
  btnRoll: $('#btnRoll'),
  rollResults: $('#rollResults'),
  btnCloseRoll: $('#btnCloseRoll'),
  screen: $('#screen'),
  screenTitle: $('#screenTitle'),
  screenBody: $('#screenBody'),
  btnJoin: $('#btnJoin'),
  btnResume: $('#btnResume'),
  roomCode: $('#roomCode'),
  playerName: $('#playerName'),
};

let tileClickHandler = null;
export function onTileClicked(fn){ tileClickHandler = fn; }

export function setStatus(s, busy=false){
  if (!el.status) return;
  el.status.textContent = String(s);
  if (busy) el.status.classList.add('busy'); else el.status.classList.remove('busy');
}

export function bindJoinUI({
  onJoin = () => {},
  onResume = () => {},
  onReadyClick = () => {},
  onRollClick = () => {},
  onCloseRoll = () => {},
} = {}) {
  if (el.btnJoin) el.btnJoin.addEventListener('click', onJoin);
  if (el.btnResume) el.btnResume.addEventListener('click', onResume);

  if (el.btnReady) {
    el.btnReady.addEventListener('click', () => {
      const next = !(state.me?.ready);
      onReadyClick(next);
    });
  }

  if (el.btnRoll) el.btnRoll.addEventListener('click', onRollClick);
  if (el.btnCloseRoll) el.btnCloseRoll.addEventListener('click', onCloseRoll);
}

export function showJoin(yes){
  el.join.classList.toggle('hidden', !yes);
}

export function setLobbyVisible(yes){
  el.lobby.classList.toggle('hidden', !yes);
}

export function setResumeAvailable(session){
  const has = !!session;
  el.btnResume.classList.toggle('hidden', !has);
  if (has) {
    const room = String(session?.roomId || '').trim();
    el.btnResume.textContent = room ? `Resume ${room}` : 'Resume';
  } else {
    el.btnResume.textContent = 'Resume';
  }
}

export function setJoinFields({ room = '', name = '' } = {}){
  if (el.roomCode) el.roomCode.value = room;
  if (el.playerName) el.playerName.value = name;
}

export function setReadyEnabled(enabled){
  el.btnReady.disabled = !enabled;
  el.btnReady.textContent = state.me?.ready ? 'Ready ✔' : "I'm Ready";
}

export function renderCatalog(entries, currentState){
  const takenBy = new Map(entries.filter(e=>e.lockedBy).map(e=>[e.id, e.lockedBy]));
  const myChar = currentState.me?.charId || null;

  el.grid.innerHTML = '';
  entries.forEach(e => {
    const tile = document.createElement('div');
    tile.className = 'tile' + (e.id === myChar ? ' selected' : '') + (takenBy.has(e.id) && takenBy.get(e.id)!==currentState.me?.id ? ' locked' : '');
    tile.dataset.charId = e.id;

    const img = document.createElement('div');
    img.className = 'img';
    if (e.portraitUrl) {
      img.style.backgroundImage = `url('${e.portraitUrl}')`;
      img.style.backgroundSize = 'cover';
      img.style.backgroundPosition = 'center';
      img.textContent = '';
    } else {
      img.textContent = (e.name || e.id || '?').slice(0,2).toUpperCase();
    }

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = e.name || e.id;

    tile.appendChild(img);
    tile.appendChild(name);

    const lockedByOther = takenBy.has(e.id) && takenBy.get(e.id)!==currentState.me?.id;
    if (!lockedByOther) {
      tile.addEventListener('click', ()=>{
        tileClickHandler && tileClickHandler(e.id);
      });
    }

    el.grid.appendChild(tile);
  });

  el.lobbyInfo.textContent = formatLobbyInfo(currentState);
  setReadyEnabled(Boolean(myChar));
}

function formatLobbyInfo(s){
  const ps = s.lobby?.players || [];
  const list = ps.map(p=>`${p.name}${p.ready?' ✔':''}${p.charId?` · ${p.charId}`:''}`).join('  •  ');
  return list || '';
}

export function showRollOverlay(){
  el.roll.classList.remove('hidden');
}
export function hideRollOverlay(){
  el.roll.classList.add('hidden');
}

export function setRollPrompt(prompt, visible){
  el.rollLabel.textContent = prompt?.label || 'Roll';
  const mine = state.me?.id;
  const already = new Set(prompt?.alreadyRolled || []);
  const canRoll = prompt?.allowedPlayers?.includes(mine) && !already.has(mine);
  el.btnRoll.disabled = !canRoll;
  el.rollSub.textContent = canRoll ? 'Your turn to roll.' : 'Waiting for others…';
  el.btnCloseRoll.classList.toggle('hidden', !!canRoll);
  if (visible) showRollOverlay();
}

export function setRollResults(rr){
  const out = [];
  if (Array.isArray(rr?.results)) {
    rr.results.forEach(r=>{
      const name = nameFor(r.playerId);
      out.push(`${name}: ${r.value}`);
    });
  }
  if (rr?.order?.length) {
    const names = rr.order.map(nameFor).join(' → ');
    out.push(`Order: ${names}`);
  }
  el.rollResults.textContent = out.join('\n');
  if (rr?.complete) {
    el.rollSub.textContent = 'All rolls received.';
    el.btnRoll.disabled = true;
    el.btnCloseRoll.classList.remove('hidden');
  }
}

function nameFor(playerId){
  const ps = state.lobby?.players || [];
  return ps.find(p=>p.id===playerId)?.name || playerId;
}

export function showScreen(yes){
  el.screen.classList.toggle('hidden', !yes);
}

export function renderScreen(screenPayload, myId){
  // Minimal generic renderer
  const { name, data } = screenPayload || {};
  el.screenTitle.textContent = titleFor(name);
  el.screenBody.innerHTML = '';

  if (data?.prompt) {
    const p = document.createElement('div');
    p.className = 'note';
    p.textContent = data.prompt;
    el.screenBody.appendChild(p);
  }

  if (Array.isArray(data?.buttons) && data.buttons.length) {
    const row = document.createElement('div');
    row.className = 'button-row';
    data.buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.textContent = b.label || b.id;
      const allowed = Array.isArray(data.allowedPlayers) ? data.allowedPlayers.includes(myId) : true;
      btn.disabled = !allowed;
      btn.addEventListener('click', () => {
        // send UI_EVENT via dynamic import to avoid circular dep
        import('../ws.js').then(m=>{
          m.send({ v:1, type:'UI_EVENT', payload:{ screen:name, event:b.id, data:{} } });
        });
      });
      row.appendChild(btn);
    });
    el.screenBody.appendChild(row);
  }
}

function titleFor(n){
  if (!n) return 'Screen';
  const map = { board_move:'Board Move', trivia_pad:'Trivia', shop:'Shop' };
  return map[n] || n;
}
