// js/router.js — FULL FILE (patch-aware, blob-safe)
import { state } from './state.js?v=11.0.12';
import { renderCatalog, extractCatalogEntries } from './features/catalog.js?v=11.0.12';
import { setStatus, setLobbyVisible, setPhase, hideJoinCard } from './ui.js?v=11.0.12';
import { showRollOverlay, updateRollUI, hideRollOverlay } from './features/rollOverlay.js?v=11.0.12';
import { wsSend, setOnSocketMessage } from './ws.js?v=11.0.12';

// ---------- tiny helpers ----------
const ensureLobbyShown = () => { setLobbyVisible(true); setPhase && setPhase('lobby'); };
const A = (x) => Array.isArray(x) ? x : (x ? [x] : []);
const U = (s) => String(s || '').toUpperCase();

const normType = (t) => {
  const s = U(t);
  if (!s) return 'TEXT';

  // Accept real state shapes
  if (s.includes('BROADCAST_STATE') || s === 'STATE' || s.includes('STATEENVELOPE')) return 'STATE';

  // Only treat as character-catalog if the token itself indicates CHARACTER
  if (/^(CHAR(ACTER)?_)?CATALOG_?PATCH$/.test(s)) return 'CHARACTER_CATALOG_PATCH';
  if (/^(CHAR(ACTER)?_)?CATALOG$/.test(s))          return 'CHARACTER_CATALOG';

  // HELLO-ish signals
  if (s === 'HELLO_OK' || s === 'WELCOME' || s === 'ROOM_OPEN' || s === 'PONG') return 'HELLO';

  return s;
};

const PLAYER_LABEL_KEYS = ['name','displayName','playerName','label','nickname','handle','title'];
const ORDER_KEYS = ['order','turnOrder','turn_order','orderedPlayers','playerOrder','players','finalOrder','sequence','results','rolls','list'];

// Merge a shallow state payload into our local state
function mergeState(s) {
  if (!s) return;
  Object.assign(state, s);
  if (s.phase) setPhase(s.phase);
  // If a catalog came with state, render it
  const cat = s.catalog || s.lobby?.catalog;
  if (cat && Array.isArray(cat.entries) && cat.entries.length) {
    setLobbyVisible(true);
    renderCatalog(cat);
    state.hydrated = true;
  }
}

// Some hosts send catalog as its own message
function handleCatalogMessage(msg) {
  const cat = msg.catalog || msg.data?.catalog || msg.payload?.catalog;
  if (cat && Array.isArray(cat.entries) && cat.entries.length) {
    state.catalog = cat;
    setLobbyVisible(true);
    renderCatalog(cat);
    state.hydrated = true;
  }
}

function toPlayerLabel(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'bigint') return String(entry);
  if (Array.isArray(entry)) {
    if (entry.length === 0) return '';
    if (entry.length === 1) return toPlayerLabel(entry[0]);
    return toPlayerLabel(entry[1] ?? entry[0]);
  }
  if (typeof entry !== 'object') return '';
  for (const key of PLAYER_LABEL_KEYS) {
    if (entry[key] != null && String(entry[key]).trim() !== '') return String(entry[key]);
  }
  if (entry.player && typeof entry.player === 'object') return toPlayerLabel(entry.player);
  if (entry.playerId != null) return String(entry.playerId);
  if (entry.id != null) return String(entry.id);
  if (entry.socketId != null) return String(entry.socketId);
  return '';
}

function toPlayerId(entry) {
  if (entry == null) return null;
  if (Array.isArray(entry)) {
    if (entry.length === 0) return null;
    if (entry.length === 1) return toPlayerId(entry[0]);
    const [, value] = entry;
    const nested = toPlayerId(value);
    if (nested != null) return nested;
    const first = entry[0];
    return first != null ? String(first) : null;
  }
  if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'bigint') return String(entry);
  if (typeof entry !== 'object') return null;
  if (entry.playerId != null) return String(entry.playerId);
  if (entry.id != null) return String(entry.id);
  if (entry.socketId != null) return String(entry.socketId);
  if (entry.userId != null) return String(entry.userId);
  if (entry.value != null && typeof entry.value !== 'object' && String(entry.value).trim() !== '') return String(entry.value);
  if (entry.player && typeof entry.player === 'object') return toPlayerId(entry.player);
  if (entry.ownerId != null) return String(entry.ownerId);
  return null;
}

function toRollNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return num;
  }
  return null;
}

function extractRollValue(entry) {
  if (entry == null) return null;
  if (Array.isArray(entry)) {
    if (entry.length === 0) return null;
    if (entry.length === 1) return extractRollValue(entry[0]);
    const second = extractRollValue(entry[1]);
    if (second != null) return second;
    return extractRollValue(entry[0]);
  }
  if (typeof entry === 'object') {
    const candidates = [entry.roll, entry.value, entry.total, entry.result, entry.score, entry.dice, entry.die, entry.amount, entry.steps, entry.rollValue];
    for (const candidate of candidates) {
      const num = toRollNumber(candidate);
      if (num != null) return num;
    }
    if (entry.player && typeof entry.player === 'object') return extractRollValue(entry.player);
    return null;
  }
  return toRollNumber(entry);
}

function getOrderArray(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  for (const key of ORDER_KEYS) {
    const value = snapshot[key];
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === 'object') {
      if (Array.isArray(value.list) && value.list.length) return value.list;
      if (Array.isArray(value.order) && value.order.length) return value.order;
    }
  }
  return [];
}

function gatherRolledIds(snapshot) {
  const out = new Set();
  if (!snapshot || typeof snapshot !== 'object') return out;
  const sources = [
    snapshot.rolledPlayerIds,
    snapshot.completedPlayerIds,
    snapshot.players,
    snapshot.order,
    snapshot.results,
    snapshot.rolls,
    snapshot.turnOrder,
    snapshot.turn_order,
    snapshot.rollsByPlayer,
    snapshot.turnOrder?.players,
    snapshot.turnOrder?.results
  ];
  for (const source of sources) {
    if (!source) continue;
    if (Array.isArray(source)) {
      source.forEach((entry) => {
        const roll = extractRollValue(entry);
        const id = toPlayerId(entry);
        if (id != null && (roll != null || entry === true || entry?.hasRolled === true)) out.add(String(id));
      });
    } else if (typeof source === 'object') {
      for (const [key, value] of Object.entries(source)) {
        const roll = extractRollValue(value);
        if (roll == null && value !== true && value?.hasRolled !== true) continue;
        const id = toPlayerId(value) ?? (key != null ? String(key) : null);
        if (id != null) out.add(String(id));
      }
    }
  }
  return out;
}

function buildOrderText(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const labels = list.map((entry) => toPlayerLabel(entry)).filter(Boolean);
  return labels.join(' → ');
}

function findTurnOrderData(root, limit = 500) {
  const queue = [root];
  let guard = 0;
  while (queue.length && guard++ < limit) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === 'object') queue.push(item);
      continue;
    }
    if (node.turnOrder && typeof node.turnOrder === 'object') return node.turnOrder;
    if (node.turn_order && typeof node.turn_order === 'object') return node.turn_order;

    const orderList = getOrderArray(node);
    const hasRoll = extractRollValue(node) != null;
    const hasPrompt = typeof node.prompt === 'string' || typeof node.message === 'string' || typeof node.text === 'string' || typeof node.statusText === 'string';
    const statusRaw = node.status ?? node.state ?? node.phase ?? node.stage ?? node.turnOrderStatus ?? node.turnOrderState;
    const statusHasTurn = typeof statusRaw === 'string' && statusRaw.toLowerCase().includes('turn');
    const playerId = toPlayerId(node);
    if (orderList.length || hasRoll || hasPrompt || statusHasTurn) {
      if (orderList.length || playerId != null || hasRoll || hasPrompt) return node;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function extractBoardRollData(root, limit = 500) {
  const queue = [root];
  let guard = 0;
  while (queue.length && guard++ < limit) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === 'object') queue.push(item);
      continue;
    }
    if (Array.isArray(node.entries) && node.entries.length && !node.canRoll && !node.roll && !node.rollPrompt) {
      // catalog-like snapshot; skip
      continue;
    }
    if (node.rollPrompt && typeof node.rollPrompt === 'object') return node.rollPrompt;
    const playerCandidate = node.playerId ?? node.currentPlayerId ?? node.activePlayerId ?? node.nextPlayerId ?? node.socketId ?? (node.player && (node.player.playerId ?? node.player.id));
    const canRollFlag = node.canRoll ?? node.canRollNow ?? node.shouldRoll ?? node.allowRoll ?? node.allowed ?? node.isMyTurn ?? node.isActive ?? node.active ?? node.canTapRoll;
    const promptLike = typeof node.prompt === 'string' || typeof node.message === 'string' || typeof node.text === 'string' || typeof node.statusText === 'string';
    const rollLike = extractRollValue(node);
    if (playerCandidate != null && (promptLike || rollLike != null || typeof canRollFlag === 'boolean')) return node;

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function handleTurnOrderSnapshot(snapshot, { typeHint = '' } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;

  const normalizedType = String(typeHint || '').toUpperCase();
  const statusRaw = snapshot.status ?? snapshot.state ?? snapshot.phase ?? snapshot.stage ?? snapshot.turnOrderStatus ?? snapshot.turnOrderState;
  const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : '';
  const promptText = snapshot.prompt ?? snapshot.turnOrderPrompt ?? '';
  const statusText = snapshot.statusText ?? '';
  const messageText = snapshot.message ?? snapshot.text ?? '';
  const title = snapshot.title || 'Turn Order';
  const orderList = getOrderArray(snapshot);
  const resultsList = Array.isArray(snapshot.results) && snapshot.results.length ? snapshot.results : orderList;
  const rolledIds = gatherRolledIds(snapshot);

  const myId = String(state.playerId || '');
  const playerId = toPlayerId(snapshot);
  const rollValue = extractRollValue(snapshot);
  const mine = myId && playerId && String(playerId) === myId;
  if (mine && rollValue != null) rolledIds.add(myId);

  const stageIsFinal = snapshot.final === true || snapshot.complete === true || snapshot.completed === true ||
    status.includes('final') || status.includes('complete') || status.includes('finished') || status.includes('done') ||
    normalizedType.includes('FINAL') || normalizedType.includes('COMPLETE');

  const stageIsFeedback = rollValue != null || normalizedType.includes('RESULT') || normalizedType.includes('FEEDBACK') ||
    status.includes('rolled') || status.includes('result');

  const promptCandidate = promptText || messageText || statusText;

  if (stageIsFinal || (orderList.length && (status.includes('locked') || status.includes('closed')))) {
    state.inTurnOrder = false;
    state.myHasRolled = false;
    state.canRollNow = false;
    const text = snapshot.orderText || snapshot.finalText || buildOrderText(orderList.length ? orderList : resultsList);
    const msg = statusText || messageText || 'Order set.';
    if (text) updateRollUI({ orderText: text, msg, ok: true });
    else updateRollUI({ msg, ok: true });
    hideRollOverlay();
    return true;
  }

  const hasRolled = rolledIds.has(myId);
  state.myHasRolled = hasRolled;

  if (stageIsFeedback) {
    const who = toPlayerLabel(snapshot) || (mine ? 'You' : 'Player');
    const msg = messageText || statusText || (rollValue != null ? `${who} rolled ${rollValue}.` : `${who} rolled.`);
    if (mine && rollValue != null) {
      updateRollUI({ value: rollValue, msg, ok: true });
    } else {
      updateRollUI({ msg });
    }
    return true;
  }

  const shouldStart = normalizedType.includes('START') || normalizedType.includes('OPEN') || normalizedType.includes('STATUS') ||
    normalizedType.includes('STATE') || normalizedType.includes('PROMPT') || status.includes('start') || status.includes('open') ||
    status.includes('pending') || status.includes('waiting') || status.includes('prompt') || status.includes('ready') ||
    !state.inTurnOrder || (playerId != null && !rolledIds.has(String(playerId)));

  if (!shouldStart && !promptCandidate) return false;

  setPhase('turn_order');
  state.inTurnOrder = true;

  const currentTargetId = snapshot.currentPlayerId ?? snapshot.activePlayerId ?? snapshot.nextPlayerId ?? snapshot.promptPlayerId ?? snapshot.waitingForId ?? snapshot.waitingOn ?? snapshot.turn?.currentPlayerId;
  const explicitRollFlag = snapshot.canRoll ?? snapshot.canPlayerRoll ?? snapshot.allowRoll ?? snapshot.shouldRoll ?? snapshot.canTapRoll;
  const targetId = currentTargetId != null ? String(currentTargetId) : null;
  const mineTurn = targetId ? targetId === myId : null;

  if (typeof explicitRollFlag === 'boolean') {
    state.canRollNow = explicitRollFlag;
  } else if (mineTurn !== null) {
    state.canRollNow = mineTurn && !state.myHasRolled;
  } else {
    state.canRollNow = !state.myHasRolled;
  }

  const overlayPrompt = promptText || promptCandidate || 'Tap ROLL to set the order.';
  showRollOverlay({ title, prompt: overlayPrompt });

  const myEntry = resultsList.find((entry) => myId && String(toPlayerId(entry) || '') === myId);
  const myEntryRoll = extractRollValue(myEntry);
  if (myEntryRoll != null) {
    state.myHasRolled = true;
    state.canRollNow = false;
    const msg = statusText || messageText || `You rolled ${myEntryRoll}.`;
    updateRollUI({ value: myEntryRoll, msg, ok: true });
  } else {
    updateRollUI({ msg: overlayPrompt });
  }

  return true;
}

function handleTurnOrderFallback(type, raw) {
  const normalized = U(type);
  const looksTurnOrderType = normalized.includes('TURN_ORDER') || normalized.includes('TURNORDER');
  if (looksTurnOrderType && raw && typeof raw === 'object') {
    const payload = raw.turnOrder || raw.turn_order || raw.payload || raw.data || raw.body || raw;
    const snapshot = findTurnOrderData(payload) || payload;
    if (snapshot && typeof snapshot === 'object' && snapshot !== raw) {
      if (handleTurnOrderSnapshot(snapshot, { typeHint: normalized })) return true;
    } else if (snapshot && typeof snapshot === 'object') {
      if (handleTurnOrderSnapshot(snapshot, { typeHint: normalized })) return true;
    }
  }

  const nested = findTurnOrderData(raw);
  if (nested && typeof nested === 'object') {
    return handleTurnOrderSnapshot(nested, { typeHint: normalized });
  }
  return false;
}

function handleBoardRollSnapshot(snapshot, { typeHint = '' } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;

  const normalized = String(typeHint || '').toUpperCase();
  if (normalized.includes('TURN_ORDER')) return false;

  const statusRaw = snapshot.status ?? snapshot.state ?? snapshot.phase ?? snapshot.stage ?? '';
  const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : '';
  const promptValue = snapshot.prompt ?? snapshot.turnPrompt ?? '';
  const messageValue = snapshot.statusText ?? snapshot.message ?? snapshot.text ?? '';
  const promptOrMessage = promptValue || messageValue;
  const title = snapshot.title || (status.includes('order') ? 'Turn Order' : 'Your Turn');

  const myId = String(state.playerId || '');
  const targetId = snapshot.currentPlayerId ?? snapshot.activePlayerId ?? snapshot.nextPlayerId ?? snapshot.playerId ?? snapshot.socketId ?? (snapshot.player && (snapshot.player.playerId ?? snapshot.player.id));
  const target = targetId != null ? String(targetId) : null;
  const mine = target && myId ? target === myId : false;

  const canRollFlag = snapshot.canRoll ?? snapshot.canRollNow ?? snapshot.shouldRoll ?? snapshot.allowRoll ?? snapshot.allowed ?? snapshot.isMyTurn ?? snapshot.isActive ?? snapshot.active ?? snapshot.canTapRoll;
  const explicitCanRoll = typeof canRollFlag === 'boolean' ? canRollFlag : null;

  const rollValue = extractRollValue(snapshot);
  const stageIsResult = rollValue != null || status.includes('rolled') || status.includes('move') || status.includes('moved') || normalized.includes('ROLL_RESULT') || normalized.includes('RESULT');
  const stageIsPrompt = status.includes('prompt') || status.includes('turn') || status.includes('await') || status.includes('wait') || status.includes('ready') || normalized.includes('PROMPT') || normalized.includes('TURN');

  if (stageIsResult) {
    const name = toPlayerLabel(snapshot) || (mine ? 'You' : 'Player');
    const msg = promptOrMessage || (rollValue != null ? `${name} rolled ${rollValue}.` : `${name} rolled.`);
    if (mine) {
      state.canRollNow = false;
      state.myHasRolled = true;
      if (rollValue != null) updateRollUI({ value: rollValue, msg: msg || 'Moving…', ok: true });
      else updateRollUI({ msg: msg || 'Moving…', ok: true });
      hideRollOverlay();
    } else {
      if (msg) updateRollUI({ msg });
    }
    return true;
  }

  if (stageIsPrompt || promptOrMessage || explicitCanRoll !== null) {
    setPhase('board');
    state.inTurnOrder = false;
    state.myHasRolled = false;
    const allow = explicitCanRoll !== null ? explicitCanRoll : mine;
    state.canRollNow = !!allow;
    if (state.canRollNow) {
      const overlayPrompt = promptValue || promptOrMessage || 'Tap ROLL to move.';
      showRollOverlay({ title, prompt: overlayPrompt });
      updateRollUI({ msg: overlayPrompt });
    } else {
      hideRollOverlay();
      if (promptOrMessage) updateRollUI({ msg: promptOrMessage });
      else updateRollUI();
    }
    return true;
  }

  return false;
}

function handleBoardRollFallback(type, raw) {
  const normalized = U(type);
  if (normalized.includes('TURN_ORDER')) return false;
  if (normalized.includes('ROLL') || normalized.includes('TURN')) {
    if (raw && typeof raw === 'object') {
      const payload = raw.payload || raw.data || raw.body || raw;
      const snapshot = extractBoardRollData(payload);
      if (snapshot && typeof snapshot === 'object') {
        if (handleBoardRollSnapshot(snapshot, { typeHint: normalized })) return true;
      }
    }
  }
  const nested = extractBoardRollData(raw);
  if (nested && typeof nested === 'object') {
    return handleBoardRollSnapshot(nested, { typeHint: normalized });
  }
  return false;
}

// Find the first object in a (possibly nested) payload that has any of add/update/remove arrays
function findPatchTriplet(root) {
  const q = [root];
  let guard = 0;
  while (q.length && guard++ < 1000) {
    const n = q.shift();
    if (!n || typeof n !== 'object') continue;
    const cand = n.payload || n.body || n.data || n;
    const hasTriplet = (o) =>
      o && (Array.isArray(o.add) || Array.isArray(o.update) || Array.isArray(o.remove));
    if (hasTriplet(cand)) return cand;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === 'object') q.push(v);
    }
  }
  return null;
}

function applyCatalogPatch(trip) {
  if (!state.catalog) state.catalog = { entries: [] };
  const list = state.catalog.entries;

  if (Array.isArray(trip.add)) {
    for (const e of trip.add) {
      const id = String(e.id ?? e.characterId ?? e.key ?? Math.random());
      const i = list.findIndex(x => String(x.id) === id);
      if (i >= 0) list[i] = { ...list[i], ...e, id };
      else list.push({ ...e, id });
    }
  }
  if (Array.isArray(trip.update)) {
    for (const e of trip.update) {
      const id = String(e.id ?? e.characterId ?? e.key);
      const i = list.findIndex(x => String(x.id) === id);
      if (i >= 0) list[i] = { ...list[i], ...e, id };
    }
  }
  if (Array.isArray(trip.remove)) {
    const removes = trip.remove.map(x => String(x));
    const keep = [];
    for (const e of list) if (!removes.includes(String(e.id))) keep.push(e);
    state.catalog.entries = keep;
  }
}

function setDbg(s) {
  const pill = document.querySelector('#dbg, #dbgLast, .dbg-last, .pill-last');
  if (pill) pill.textContent = `last: ${s}`;
}

function applyCatalogSnapshot(entries, { force = false } = {}) {
  const currentCount = Array.isArray(state.catalog?.entries) ? state.catalog.entries.length : 0;
  const explicit = entries !== undefined && entries !== null;
  const nextList = Array.isArray(entries) ? entries : [];

  // NEW: if someone forced us with an empty list, ignore (prevents “blink to empty”)
  if (force && explicit && nextList.length === 0) return false;

  // unchanged/no-op protections
  if (!force && currentCount && !explicit) return false;

  if (!force && currentCount && nextList.length === 0 && explicit) {
    ensureLobbyShown();
    renderCatalog([]);
    return true;
  }

  if (!force && currentCount && nextList.length && currentCount === nextList.length) {
    const unchanged = nextList.every((entry, idx) => {
      const existing = state.catalog.entries[idx];
      return existing && String(existing.id) === String(entry.id);
    });
    if (unchanged) return false;
  }

  ensureLobbyShown();
  renderCatalog(nextList);
  return true;
}

function tryConsumeCatalog(root, opts = {}) {
  const entries = extractCatalogEntries(root);
  if (Array.isArray(entries)) {
    applyCatalogSnapshot(entries, opts);
    return true;
  }
  return false;
}

// ---------- main router ----------
export async function onSocketMessage(msg){
  try {
    // Accept raw string, already-parsed object, or Event with .data (Blob/ArrayBuffer/String)
    let raw = msg;
    if (raw && typeof raw === 'object' && 'data' in raw) raw = raw.data;

    if (raw instanceof Blob) raw = await raw.text();
    else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);

    // Allow batch arrays
    if (Array.isArray(raw)) {
      for (const item of raw) await onSocketMessage(item);
      return;
    }

    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s.startsWith('{') || s.startsWith('[')) {
        try { raw = JSON.parse(s); }
        catch { setDbg('TEXT'); setStatus(s); ensureLobbyShown(); return; }
      } else {
        setDbg('TEXT'); setStatus(s); ensureLobbyShown(); return;
      }
    }

    // Now raw is object
    const type = normType(raw.type || raw.msgType || raw.kind);
    setDbg(type);

    switch (type) {
      case 'HELLO': {
        setStatus('Connected. Waiting for host...');
        hideJoinCard();
        ensureLobbyShown();
        if (raw.playerId) state.playerId = raw.playerId;
        if (raw.roomId) state.roomId = raw.roomId;
        // Ask host to rehydrate us
        wsSend && wsSend({ type: 'REQUEST_SNAPSHOT' });
        wsSend && wsSend({ type: 'REQUEST_CATALOG' });
        return;
      }

      case 'CHARACTER_CATALOG': {
        const p = raw.payload || raw.data || raw;

        // Try all known shapes
        let entries = Array.isArray(p?.entries) ? p.entries
                    : Array.isArray(p?.list)     ? p.list
                    : Array.isArray(p?.characters) ? p.characters
                    : undefined;

        if (!Array.isArray(entries) || entries.length === 0) {
          const fallback = extractCatalogEntries(p);
          if (Array.isArray(fallback) && fallback.length) entries = fallback;
        }

        // Only apply if we actually have entries; otherwise ignore (prevents wipe)
        if (Array.isArray(entries) && entries.length) {
          applyCatalogSnapshot(entries, { force: true });
        }
        return;
      }

      case 'CHARACTER_CATALOG_PATCH': {
        const pack = raw.payload || raw.data || raw;
        const trip = findPatchTriplet(pack);
        if (trip) {
          if (!state.catalog) state.catalog = { entries: [] };
          applyCatalogPatch(trip);
          applyCatalogSnapshot(state.catalog.entries, { force: true });
        }
        return;
      }

      case 'STATE': {
        const env = raw.envelope || raw.state || raw;
        const header = env.header || env.stateHeader || {};
        const body   = env.payload || env.state || env.data || {};
        const typed  = normType(header.type || header.typeName || body.type || body.subtype);

        // 1) Full catalog embedded in body
        if (typed === 'CHARACTER_CATALOG' || Array.isArray(body.entries)) {
          let entries = Array.isArray(body.entries)
            ? body.entries
            : Array.isArray(body.list)
              ? body.list
              : Array.isArray(body.characters)
                ? body.characters
                : [];
          if (!entries.length) {
            const fallback = extractCatalogEntries(body);
            if (Array.isArray(fallback)) entries = fallback;
          }
          applyCatalogSnapshot(entries, { force: true });
          return;
        }

        // 2) Patch batches (this is what your host is sending)
        if (typed === 'CHARACTER_CATALOG_PATCH' || Array.isArray(env.patches) || Array.isArray(env.patch)) {
          const packs = A(env.patches || env.patch);
          if (!state.catalog) state.catalog = { entries: [] };
          for (const pack of packs) {
            const trip = findPatchTriplet(pack);
            if (trip) applyCatalogPatch(trip);
          }
          applyCatalogSnapshot(state.catalog.entries, { force: true });
          return;
        }

        // 3) Defensive: anywhere in the envelope has a patch triplet
        const trip = findPatchTriplet(env);
        if (trip) {
          if (!state.catalog) state.catalog = { entries: [] };
          applyCatalogPatch(trip);
          applyCatalogSnapshot(state.catalog.entries, { force: true });
          return;
        }

        if (tryConsumeCatalog(env, { force: false })) return;
        if (handleTurnOrderFallback(type, env) || handleBoardRollFallback(type, env)) return;

        return;
      }

      case 'TURN_ORDER_START': {
        setPhase('turn_order');
        state.inTurnOrder = true;
        state.canRollNow = false;
        state.myHasRolled = false;
        showRollOverlay({ title: 'Turn Order', prompt: 'Tap ROLL to set the order.' });
        updateRollUI();
        return;
      }

      case 'TURN_ORDER_FEEDBACK': {
        const rollValue = raw.roll ?? raw.value ?? raw.total;
        const playerId = raw.playerId || raw.id || raw.socketId;
        const mine = !!playerId && String(playerId) === String(state.playerId || '');
        if (mine) state.myHasRolled = true;
        const who = raw.name || raw.displayName || (mine ? 'You' : 'Player');
        const msg = rollValue != null ? `${who} rolled ${rollValue}.` : `${who} rolled.`;
        if (mine && rollValue != null) {
          updateRollUI({ value: rollValue, msg, ok: true });
        } else {
          updateRollUI({ msg });
        }
        return;
      }

      case 'TURN_ORDER_FINAL': {
        const order = Array.isArray(raw.order) ? raw.order : [];
        const toLabel = (entry) => entry?.name || entry?.displayName || entry?.playerName || entry?.playerId || entry?.id || '';
        const text = order.map(toLabel).filter(Boolean).join(' → ');
        state.inTurnOrder = false;
        state.myHasRolled = false;
        state.canRollNow = false;
        if (text) updateRollUI({ orderText: text, msg: 'Order set.', ok: true });
        else updateRollUI({ msg: 'Order set.', ok: true });
        hideRollOverlay();
        return;
      }

      case 'YOUR_TURN':
      case 'ROLL_PROMPT': {
        const playerId = raw.playerId || raw.id || raw.socketId;
        const mine = !!playerId && String(playerId) === String(state.playerId || '');
        setPhase('board');
        state.inTurnOrder = false;
        state.canRollNow = mine;
        state.myHasRolled = false;
        if (mine) {
          showRollOverlay({ title: 'Your Turn', prompt: 'Tap ROLL to move.' });
          updateRollUI();
        } else {
          hideRollOverlay();
          updateRollUI();
        }
        return;
      }

      case 'MOVE_ROLL': {
        const playerId = raw.playerId || raw.id || raw.socketId;
        const mine = !!playerId && String(playerId) === String(state.playerId || '');
        const value = raw.value ?? raw.roll ?? raw.steps;
        if (mine) {
          state.canRollNow = false;
          state.myHasRolled = true;
          if (value != null) updateRollUI({ value, msg: 'Moving…', ok: true });
          else updateRollUI({ msg: 'Moving…', ok: true });
          hideRollOverlay();
        } else {
          const who = raw.name || raw.displayName || 'Player';
          if (value != null) updateRollUI({ msg: `${who} rolled ${value}.` });
        }
        return;
      }

      default:
        if (handleTurnOrderFallback(type, raw) || handleBoardRollFallback(type, raw)) return;
        // Unknowns: try defensive render if entries exist
        const p = raw.payload || raw.data || raw;
        if (p && Array.isArray(p.entries)) {
          applyCatalogSnapshot(p.entries, { force: true });
        } else {
          const trip = findPatchTriplet(raw);
          if (trip) {
            if (!state.catalog) state.catalog = { entries: [] };
            applyCatalogPatch(trip);
            applyCatalogSnapshot(state.catalog.entries, { force: true });
          } else {
            tryConsumeCatalog(raw);
          }
        }
        return;
    }
  } catch (err) {
    console.log('router error:', err);
  }
}

// Ensure the shared ws layer forwards messages here immediately on module load and for legacy entry points.
setOnSocketMessage(onSocketMessage);

// Optional: if your ws layer wires events instead of raw strings
export function onSocketEvent(ev) { return setOnSocketMessage(onSocketMessage); }
