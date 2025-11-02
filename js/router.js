// js/router.js — hydration-aware client router (full file replacement)
import { state } from './state.js?v=11.0.12';
import { renderCatalog, extractCatalogEntries } from './features/catalog.js?v=11.0.12';
import { setStatus, setLobbyVisible, setPhase, hideJoinCard } from './ui.js?v=11.0.12';
import { showRollOverlay, updateRollUI, hideRollOverlay } from './features/rollOverlay.js?v=11.0.12';
import { wsSend, setOnSocketMessage } from './ws.js?v=11.0.12';

// ---------------------------------------------------------------------------
// Hydration + dedupe guards
// ---------------------------------------------------------------------------
const HYDRATE_KICK_DELAY_MS = 320;
const HYDRATE_RETRY_DELAY_MS = 6200;
const MESSAGE_CACHE_LIMIT = 240;
const CATALOG_RENDER_DEBOUNCE_MS = 140;

let hydrateKickTimer = 0;
let hydrateRetryTimer = 0;
let hydrateAttempts = 0;
let catalogRenderTimer = 0;

const seenMessages = new Map();
let lastLobbyVisible = false;
let lastPhaseValue = state.phase || '';
let rollOverlayVisible = false;

function maybeSetPhase(next) {
  if (!next) return;
  const clean = String(next);
  if (lastPhaseValue === clean) return;
  lastPhaseValue = clean;
  setPhase(clean);
}

function maybeSetLobbyVisible(on) {
  const flag = !!on;
  if (lastLobbyVisible === flag) return;
  lastLobbyVisible = flag;
  setLobbyVisible(flag);
}

function ensureLobbyShown() {
  maybeSetLobbyVisible(true);
  maybeSetPhase('lobby');
}

function cancelHydrateRetry() {
  if (hydrateRetryTimer) {
    clearTimeout(hydrateRetryTimer);
    hydrateRetryTimer = 0;
  }
}

function resetHydrationTracking({ keepVersion = false } = {}) {
  state.hydrated = false;
  if (!keepVersion) state._hydratedVersion = null;
  state._rehydrateRequested = false;
  state._rehydrateRequestedVersion = null;
  state._lastRehydrateAt = 0;
  hydrateAttempts = 0;
  if (hydrateKickTimer) {
    clearTimeout(hydrateKickTimer);
    hydrateKickTimer = 0;
  }
  cancelHydrateRetry();
}

function markHydrated({ version = null } = {}) {
  state.hydrated = true;
  const normalized = version || state.catalogVersion || null;
  if (normalized) state._hydratedVersion = normalized;
  state._rehydrateRequested = false;
  state._rehydrateRequestedVersion = null;
  cancelHydrateRetry();
  if (hydrateKickTimer) {
    clearTimeout(hydrateKickTimer);
    hydrateKickTimer = 0;
  }
  hydrateAttempts = 0;
}

function requestHydrateBurst(reason = 'kick') {
  const knownVersion = state.catalogVersion ?? null;
  if (state.hydrated && (!knownVersion || state._hydratedVersion === knownVersion)) return;
  if (hydrateAttempts >= 2) return;

  hydrateAttempts += 1;
  state._rehydrateRequested = true;
  state._rehydrateRequestedVersion = knownVersion;
  state._lastRehydrateAt = Date.now();

  wsSend({ type: 'REQUEST_SNAPSHOT', reason });
  wsSend({ type: 'REQUEST_CATALOG', reason });

  if (hydrateAttempts === 1) {
    cancelHydrateRetry();
    hydrateRetryTimer = setTimeout(() => {
      hydrateRetryTimer = 0;
      if (!state.hydrated) requestHydrateBurst('retry-timeout');
    }, HYDRATE_RETRY_DELAY_MS);
  }
}

function scheduleHydrateKick(delay = HYDRATE_KICK_DELAY_MS) {
  if (state.hydrated) return;
  if (hydrateAttempts > 0) return;
  if (hydrateKickTimer) return;
  hydrateKickTimer = setTimeout(() => {
    hydrateKickTimer = 0;
    requestHydrateBurst('kick');
  }, delay);
}

function buildMessageKey(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || raw.msgType || raw.kind || '').toUpperCase();
  const directId = raw.id ?? raw.messageId ?? raw.msgId ?? raw.uuid ?? raw.guid;
  if (directId !== undefined && directId !== null) return `${type}|id:${directId}`;
  const seq = raw.seq ?? raw.sequence ?? raw.index ?? raw.order ?? raw.position ?? raw.patchIndex;
  if (seq !== undefined && seq !== null) return `${type}|seq:${seq}`;
  const ts = raw.ts ?? raw.timestamp ?? raw.sentAt ?? raw.time ?? raw.createdAt;
  if (ts !== undefined && ts !== null) return `${type}|ts:${ts}`;
  const rangeSources = [raw, raw.header, raw.stateHeader, raw.envelope, raw.payload];
  for (const source of rangeSources) {
    if (!source || typeof source !== 'object') continue;
    const start = source.patchStart ?? source.start ?? source.rangeStart ?? source.from;
    const end = source.patchEnd ?? source.end ?? source.rangeEnd ?? source.to;
    if (start !== undefined || end !== undefined) return `${type}|patch:${start ?? ''}-${end ?? ''}`;
    const range = source.patchRange ?? source.range;
    if (range && typeof range === 'object') {
      const rs = range.start ?? range.from ?? range.begin ?? range[0];
      const re = range.end ?? range.to ?? range.finish ?? range[1];
      if (rs !== undefined || re !== undefined) return `${type}|patch:${rs ?? ''}-${re ?? ''}`;
    }
    const ids = source.patchIds ?? source.ids;
    if (Array.isArray(ids) && ids.length) return `${type}|patchIds:${ids.join(',')}`;
  }
  return null;
}

function shouldProcessMessage(raw) {
  const key = buildMessageKey(raw);
  if (!key) return true;
  if (seenMessages.has(key)) return false;
  seenMessages.set(key, Date.now());
  if (seenMessages.size > MESSAGE_CACHE_LIMIT) {
    const keys = Array.from(seenMessages.keys());
    const trim = keys.length - MESSAGE_CACHE_LIMIT;
    for (let i = 0; i < trim; i++) seenMessages.delete(keys[i]);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Catalog fingerprint + guard helpers
// ---------------------------------------------------------------------------
const VERSION_KEY_HINTS = ['catalogVersion', 'catalog_version'];
const PORTRAIT_VALUE_KEYS = [
  'portraitUrl', 'portraitData', 'imageUrl', 'portrait', 'portrait_url', 'portrait_data',
  'thumbnailUrl', 'thumbUrl', 'thumb', 'avatarUrl', 'avatar'
];
const PLAYER_HINT_KEYS = [
  'playerId', 'player_id', 'alias', 'joinedAt', 'joined_at', 'ready', 'isReady', 'seat', 'slot',
  'position', 'connectionId', 'wsId', 'role', 'team', 'score', 'latency', 'ping', 'isHost'
];

function valueHasPortrait(value) {
  if (!value) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.some((item) => valueHasPortrait(item));
    const keys = ['url', 'data', 'imageUrl', 'src'];
    return keys.some((k) => valueHasPortrait(value[k]));
  }
  return false;
}

function hasPortraitCandidate(entry) {
  if (!entry || typeof entry !== 'object') return false;
  for (const key of PORTRAIT_VALUE_KEYS) {
    if (valueHasPortrait(entry[key])) return true;
  }
  if (entry.raw && typeof entry.raw === 'object') {
    for (const key of PORTRAIT_VALUE_KEYS) {
      if (valueHasPortrait(entry.raw[key])) return true;
    }
  }
  return false;
}

function looksLikePlayerWithoutPortrait(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (hasPortraitCandidate(entry)) return false;
  const source = entry.raw && typeof entry.raw === 'object' ? entry.raw : entry;
  return PLAYER_HINT_KEYS.some((key) => {
    const value = source[key];
    return value !== undefined && value !== null && String(value).trim() !== '';
  });
}

function passesCatalogGuard(entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  const objects = entries.filter((item) => item && typeof item === 'object');
  if (!objects.length) return false;
  if (!objects.some((item) => hasPortraitCandidate(item))) return false;
  if (objects.every((item) => looksLikePlayerWithoutPortrait(item))) return false;
  return true;
}

function toCatalogVersion(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function sniffCatalogVersion(source, seen = new Set(), depth = 0) {
  if (!source || typeof source !== 'object' || seen.has(source) || depth > 4) return null;
  seen.add(source);

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = sniffCatalogVersion(item, seen, depth + 1);
      if (found != null) return found;
    }
    return null;
  }

  for (const key of VERSION_KEY_HINTS) {
    if (key in source && source[key] != null) return source[key];
  }

  const nestedKeys = ['catalog', 'meta', 'header', 'stateHeader', 'envelope', 'payload', 'data', 'body', 'state'];
  for (const key of nestedKeys) {
    const value = source[key];
    if (value && typeof value === 'object') {
      const nested = sniffCatalogVersion(value, seen, depth + 1);
      if (nested != null) return nested;
    }
  }

  if (source.version != null) {
    const hint = String(source.type || source.kind || source.msgType || '').toUpperCase();
    if (!hint || hint.includes('CATALOG') || hint.includes('LOBBY')) return source.version;
  }

  return null;
}

function noteCatalogVersion(...sources) {
  for (const source of sources) {
    if (!source) continue;
    const raw = sniffCatalogVersion(source);
    const normalized = toCatalogVersion(raw);
    if (!normalized) continue;
    if (state.catalogVersion !== normalized) {
      const prevHydrated = state._hydratedVersion;
      state.catalogVersion = normalized;
      if (prevHydrated && prevHydrated !== normalized) {
        state.hydrated = false;
        state._rehydrateRequested = false;
        state._rehydrateRequestedVersion = null;
        hydrateAttempts = 0;
        cancelHydrateRetry();
      }
    }
    return normalized;
  }
  return null;
}

function stableOptionSignature(obj, depth = 0) {
  if (!obj || typeof obj !== 'object') return '';
  if (depth > 3) return '';
  const keys = Object.keys(obj).sort().filter((key) => !/time|stamp|date/i.test(key));
  const parts = [];
  for (const key of keys) {
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = stableOptionSignature(value, depth + 1);
      if (nested) parts.push(`${key}:{${nested}}`);
    } else if (Array.isArray(value)) {
      if (!value.length) continue;
      const sample = value.slice(0, 3).map((item) => String(item ?? '')).join('|');
      parts.push(`${key}=[${sample}]`);
    } else if (value !== undefined) {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(',');
}

function buildCatalogSignature(entries, options) {
  const list = Array.isArray(entries) ? entries : [];
  const head = list.slice(0, 8).map((entry) => {
    if (!entry || typeof entry !== 'object') return '';
    const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : entry;
    const id = raw.id ?? raw.characterId ?? raw.key ?? raw.slug ?? entry.id ?? '';
    const label = raw.label ?? raw.name ?? raw.title ?? entry.label ?? '';
    return `${id}:${label}`;
  }).join('|');
  const optionSig = stableOptionSignature(options);
  return `${list.length}|${head}|${optionSig}`;
}

// ---------------------------------------------------------------------------
// Roll snapshot helpers
// ---------------------------------------------------------------------------
const PLAYER_LABEL_KEYS = ['name','displayName','playerName','label','nickname','handle','title'];
const ORDER_KEYS = ['order','turnOrder','turn_order','orderedPlayers','playerOrder','players','finalOrder','sequence','results','rolls','list'];

function toPlayerLabel(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'bigint') return String(entry);
  if (Array.isArray(entry)) {
    if (!entry.length) return '';
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
    if (!entry.length) return null;
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
    if (!entry.length) return null;
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
    if (orderList.length || hasRoll || hasPrompt || statusHasTurn || playerId) return node;

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lobby helpers
// ---------------------------------------------------------------------------
function countPlayers(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const playerArrays = [snapshot.players, snapshot.playerList, snapshot.player_order, snapshot.turnOrder?.players];
  let playerCount = 0;
  for (const value of playerArrays) {
    if (Array.isArray(value) && value.length) {
      playerCount = Math.max(playerCount, value.length);
    }
  }
  return playerCount;
}

function buildLobbySignature(snapshot, catalogEntries) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const roomId = snapshot.roomId ?? snapshot.room ?? state.roomId ?? '';
  const phase = snapshot.phase ?? snapshot.stage ?? snapshot.status ?? state.phase ?? '';
  const playerCount = countPlayers(snapshot);
  const catalogSize = Array.isArray(catalogEntries) ? catalogEntries.length : Array.isArray(state.catalog?.entries) ? state.catalog.entries.length : 0;
  return `${roomId}|${phase}|${playerCount}|${catalogSize}`;
}

function updateRollOverlayVisibility({ immediateUpdate = false } = {}) {
  const shouldShow = !!state.canRollNow || !!state.inTurnOrder;
  if (shouldShow) {
    if (!rollOverlayVisible) {
      showRollOverlay();
      rollOverlayVisible = true;
    }
    if (immediateUpdate) updateRollUI();
  } else if (rollOverlayVisible) {
    hideRollOverlay();
    rollOverlayVisible = false;
  } else if (immediateUpdate && rollOverlayVisible) {
    updateRollUI();
  }
}

// ---------------------------------------------------------------------------
// Catalog apply helpers
// ---------------------------------------------------------------------------
function ensureCatalogContainer() {
  if (!state.catalog) state.catalog = { entries: [] };
  if (!Array.isArray(state.catalog.entries)) state.catalog.entries = [];
  if (!Array.isArray(state._pendingCatalog)) state._pendingCatalog = [];
}

function applyCatalogPatch(trip) {
  ensureCatalogContainer();
  const list = state.catalog.entries;
  if (Array.isArray(trip.add)) {
    for (const e of trip.add) {
      const raw = e && typeof e === 'object' ? e : {};
      const id = String(raw.id ?? raw.characterId ?? raw.key ?? Math.random());
      const i = list.findIndex((x) => String(x.id) === id);
      if (i >= 0) list[i] = { ...list[i], ...raw, id };
      else list.push({ ...raw, id });
    }
  }
  if (Array.isArray(trip.update)) {
    for (const e of trip.update) {
      const raw = e && typeof e === 'object' ? e : {};
      const id = String(raw.id ?? raw.characterId ?? raw.key ?? '');
      if (!id) continue;
      const i = list.findIndex((x) => String(x.id) === id);
      if (i >= 0) list[i] = { ...list[i], ...raw, id };
    }
  }
  if (Array.isArray(trip.remove)) {
    const removes = trip.remove.map((x) => String(x));
    const keep = [];
    for (const e of list) if (!removes.includes(String(e.id))) keep.push(e);
    state.catalog.entries = keep;
  }
}

function commitCatalogRender(list, { debounce = false } = {}) {
  const doRender = () => {
    renderCatalog(list);
    if (rollOverlayVisible) updateRollUI();
  };

  if (debounce) {
    if (catalogRenderTimer) clearTimeout(catalogRenderTimer);
    catalogRenderTimer = setTimeout(() => {
      catalogRenderTimer = 0;
      doRender();
    }, CATALOG_RENDER_DEBOUNCE_MS);
  } else {
    if (catalogRenderTimer) {
      clearTimeout(catalogRenderTimer);
      catalogRenderTimer = 0;
    }
    doRender();
  }
}

function applyCatalogSnapshot(entries, { options = null, force = false, version = null, debounce = false } = {}) {
  ensureCatalogContainer();
  const nextList = Array.isArray(entries) ? entries : [];

  if (nextList.length && !passesCatalogGuard(nextList)) return false;
  if (force && nextList.length === 0 && state.catalog.entries.length) {
    state.catalog.entries = [];
    state._pendingCatalog = [];
    state.catalogFingerprint = '';
    commitCatalogRender([], { debounce: false });
    markHydrated({ version: null });
    return true;
  }

  const nextSignature = buildCatalogSignature(nextList, options);
  if (!force && state.catalogFingerprint && state.catalogFingerprint === nextSignature) {
    markHydrated({ version: state.catalogVersion });
    return false;
  }

  state.catalog.entries = nextList;
  state._pendingCatalog = nextList;
  state.catalogFingerprint = nextSignature;

  const stubLobby = { roomId: state.roomId, phase: lastPhaseValue || state.phase || '', players: Array.from({ length: state._lastPlayerCount || 0 }) };
  const derivedSignature = buildLobbySignature(stubLobby, nextList);
  if (derivedSignature) state._lobbySignature = derivedSignature;

  if (nextList.length) {
    commitCatalogRender(nextList, { debounce });
    maybeSetLobbyVisible(true);
  }

  if (version) {
    const normalized = toCatalogVersion(version);
    if (normalized) {
      state.catalogVersion = normalized;
      state._hydratedVersion = normalized;
    }
  }

  markHydrated({ version: state.catalogVersion });
  return true;
}

function findPatchTriplet(root) {
  const queue = [root];
  let guard = 0;
  while (queue.length && guard++ < 1000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    const candidate = node.payload || node.body || node.data || node;
    const hasTriplet = (o) => o && (Array.isArray(o.add) || Array.isArray(o.update) || Array.isArray(o.remove));
    if (hasTriplet(candidate)) return candidate;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function pickCatalogEntries(payload) {
  if (!payload || typeof payload !== 'object') return null;
  let entries = Array.isArray(payload.entries) ? payload.entries
    : Array.isArray(payload.list) ? payload.list
    : Array.isArray(payload.characters) ? payload.characters
    : undefined;
  if (!Array.isArray(entries) || !entries.length) {
    const extracted = extractCatalogEntries(payload);
    if (Array.isArray(extracted) && extracted.length) entries = extracted;
  }
  if (Array.isArray(entries) && entries.length && passesCatalogGuard(entries)) return entries;
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot / lobby handling
// ---------------------------------------------------------------------------
function mergeState(snapshot, { debounceCatalog = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return;
  Object.assign(state, snapshot);
  if (snapshot.phase) maybeSetPhase(snapshot.phase);
  if (snapshot.roomId) state.roomId = snapshot.roomId;
  if (snapshot.playerId) state.playerId = snapshot.playerId;

  const catalog = snapshot.catalog || snapshot.lobby?.catalog;
  if (catalog && Array.isArray(catalog.entries) && catalog.entries.length && passesCatalogGuard(catalog.entries)) {
    noteCatalogVersion(catalog, snapshot);
    applyCatalogSnapshot(catalog.entries, { options: catalog.options ?? catalog.meta ?? null, force: true, version: catalog.version ?? snapshot.version ?? null, debounce: debounceCatalog });
  }

  const pendingEntries = Array.isArray(catalog?.entries) ? catalog.entries : Array.isArray(state.catalog?.entries) ? state.catalog.entries : null;
  const lobbyRoot = snapshot.lobby || snapshot;
  const playerCount = countPlayers(lobbyRoot);
  const lobbySignature = buildLobbySignature(lobbyRoot, pendingEntries || []);
  if (lobbySignature) {
    if (state._lobbySignature !== lobbySignature) {
      maybeSetLobbyVisible(true);
    }
    state._lobbySignature = lobbySignature;
  }
  state._lastPlayerCount = playerCount;

  markHydrated({ version: state.catalogVersion });
}

function handleTurnOrderSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const turnOrder = findTurnOrderData(raw);
  if (!turnOrder || typeof turnOrder !== 'object') return false;

  const orderList = getOrderArray(turnOrder);
  const orderText = buildOrderText(orderList);
  const rolled = gatherRolledIds(turnOrder);

  const myId = state.playerId ? String(state.playerId) : null;
  state.inTurnOrder = !!turnOrder.active || !!turnOrder.prompt || !!orderList.length;
  state.canRollNow = !!turnOrder.canRoll || !!turnOrder.allowRoll || !!turnOrder.prompt;
  if (myId) state.myHasRolled = rolled.has(myId);

  if (turnOrder.phase) maybeSetPhase(turnOrder.phase);
  if (turnOrder.statusText) updateRollUI({ msg: turnOrder.statusText });
  if (orderText) updateRollUI({ orderText, ok: true });

  updateRollOverlayVisibility({ immediateUpdate: true });
  return true;
}

function handleBoardRollSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const allow = raw.canRoll || raw.allowRoll || raw.rollAllowed || raw.prompt === true;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : raw.message || raw.text;
  const title = raw.title || raw.heading || 'Roll';

  const myId = state.playerId ? String(state.playerId) : null;
  const rolled = gatherRolledIds(raw);
  if (myId && rolled.size) state.myHasRolled = rolled.has(myId);

  if (allow) {
    state.canRollNow = true;
    state.inTurnOrder = !!raw.turnOrder;
    showRollOverlay({ title, prompt: prompt || 'Tap ROLL to move.' });
    updateRollUI({ msg: prompt || 'Tap ROLL to move.' });
    rollOverlayVisible = true;
  } else {
    state.canRollNow = false;
    if (!state.inTurnOrder) hideRollOverlay();
    if (prompt) updateRollUI({ msg: prompt });
    rollOverlayVisible = false;
  }

  updateRollOverlayVisibility({ immediateUpdate: true });
  return true;
}

function normType(t) {
  const s = String(t || '').toUpperCase();
  if (!s) return 'TEXT';
  if (s.includes('BROADCAST_STATE') || s === 'STATE' || s.includes('STATEENVELOPE')) return 'STATE';
  if (/^(CHAR(ACTER)?_)?CATALOG_?PATCH$/.test(s)) return 'CHARACTER_CATALOG_PATCH';
  if (/^(CHAR(ACTER)?_)?CATALOG$/.test(s)) return 'CHARACTER_CATALOG';
  if (s === 'HELLO_OK' || s === 'WELCOME' || s === 'ROOM_OPEN' || s === 'PONG') return 'HELLO';
  return s;
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
async function onSocketMessage(msg) {
  try {
    let raw = msg;
    if (raw && typeof raw === 'object' && 'data' in raw) raw = raw.data;
    if (raw instanceof Blob) raw = await raw.text();
    else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);

    if (Array.isArray(raw)) {
      for (const item of raw) await onSocketMessage(item);
      return;
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { raw = JSON.parse(trimmed); }
        catch { setStatus(trimmed); ensureLobbyShown(); return; }
      } else {
        setStatus(trimmed);
        ensureLobbyShown();
        return;
      }
    }

    if (!raw || typeof raw !== 'object') return;
    if (!shouldProcessMessage(raw)) return;

    const type = normType(raw.type || raw.msgType || raw.kind);

    if (type === 'WS_OPEN') {
      resetHydrationTracking({ keepVersion: true });
      scheduleHydrateKick();
      return;
    }
    if (type === 'WS_RETRY') {
      requestHydrateBurst('retry-signal');
      return;
    }

    switch (type) {
      case 'HELLO': {
        setStatus('Connected. Waiting for host...');
        hideJoinCard();
        ensureLobbyShown();
        if (raw.playerId) state.playerId = raw.playerId;
        if (raw.roomId) state.roomId = raw.roomId;
        resetHydrationTracking({ keepVersion: true });
        scheduleHydrateKick();
        return;
      }

      case 'CHARACTER_CATALOG': {
        const payload = raw.payload || raw.data || raw;
        const version = noteCatalogVersion(payload, raw);
        const entries = pickCatalogEntries(payload);
        if (entries) {
          applyCatalogSnapshot(entries, { options: payload?.options ?? payload?.meta, force: true, version: version ?? payload?.version ?? raw.version, debounce: false });
        }
        return;
      }

      case 'CHARACTER_CATALOG_PATCH': {
        const trip = findPatchTriplet(raw);
        if (trip) {
          applyCatalogPatch(trip);
          noteCatalogVersion(trip, raw);
          applyCatalogSnapshot(state.catalog.entries, { options: raw.payload?.options ?? raw.payload?.meta, force: true, version: state.catalogVersion, debounce: false });
        } else {
          const payload = raw.payload || raw.data || raw;
          const entries = pickCatalogEntries(payload);
          if (entries) applyCatalogSnapshot(entries, { options: payload?.options ?? payload?.meta, force: true, version: state.catalogVersion, debounce: false });
        }
        markHydrated({ version: state.catalogVersion });
        return;
      }

      case 'STATE': {
        const payload = raw.payload || raw.data || raw.body || raw.state || raw;
        if (payload && typeof payload === 'object') {
          if (payload.lobbySnapshot || payload.lobby_state) {
            mergeState(payload.lobbySnapshot || payload.lobby_state, { debounceCatalog: true });
          } else {
            mergeState(payload.state || payload, { debounceCatalog: true });
          }
        }
        handleTurnOrderSnapshot(payload);
        handleBoardRollSnapshot(payload);
        updateRollOverlayVisibility({ immediateUpdate: true });
        markHydrated({ version: state.catalogVersion });
        return;
      }

      case 'LOBBY_SNAPSHOT': {
        const payload = raw.payload || raw.data || raw.body || raw.state || raw;
        mergeState(payload, { debounceCatalog: true });
        handleTurnOrderSnapshot(payload);
        updateRollOverlayVisibility({ immediateUpdate: true });
        markHydrated({ version: state.catalogVersion });
        return;
      }

      case 'TURN_ORDER_SNAPSHOT': {
        if (handleTurnOrderSnapshot(raw.payload || raw.data || raw)) markHydrated({ version: state.catalogVersion });
        return;
      }

      case 'ROLL_PROMPT':
      case 'YOUR_TURN':
      case 'MOVE_ROLL':
      case 'ROLL_STATE': {
        const payload = raw.payload || raw.data || raw;
        handleBoardRollSnapshot(payload);
        markHydrated({ version: state.catalogVersion });
        return;
      }

      default: {
        const payload = raw.payload || raw.data || raw.body || raw;
        const version = noteCatalogVersion(payload, raw);
        const entries = pickCatalogEntries(payload);
        if (entries) {
          applyCatalogSnapshot(entries, { options: payload?.options ?? payload?.meta, force: false, version: version ?? payload?.version ?? null, debounce: false });
        }
        handleTurnOrderSnapshot(payload);
        handleBoardRollSnapshot(payload);
        updateRollOverlayVisibility({ immediateUpdate: true });
        markHydrated({ version: state.catalogVersion });
        return;
      }
    }
  } catch (err) {
    console.error('router error', err);
  }
}

setOnSocketMessage(onSocketMessage);

export function onSocketEvent(ev) {
  return setOnSocketMessage(onSocketMessage);
}
