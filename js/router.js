// js/router.js — FULL FILE (deduped, no HTML)
import { state } from './state.js?v=11.0.12';
import { renderCatalog, extractCatalogEntries } from './features/catalog.js?v=11.0.12';
import { setStatus, setLobbyVisible, setPhase, hideJoinCard } from './ui.js?v=11.0.12';
import { showRollOverlay, updateRollUI, hideRollOverlay } from './features/rollOverlay.js?v=11.0.12';
import { wsSend, setOnSocketMessage } from './ws.js?v=11.0.12';

// ---------------------------------------------------------------------------
// Hydration + dedupe guards (SINGLE COPY)
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
let lastLobbyVisible = null;
let lastPhaseValue = state.phase || '';
let rollOverlayVisible = false;

const BOOLISH_TRUE = new Set([
  'true', '1', 'yes', 'y', 'on', 'ok', 'okay', 'allow', 'allowed', 'enable', 'enabled',
  'ready', 'start', 'started', 'go', 'active', 'running', 'prompt',
  'show', 'showing', 'visible', 'rolling'
]);

const BOOLISH_FALSE = new Set([
  'false', '0', 'no', 'n', 'off', 'none', 'null', 'nil', 'inactive', 'disabled',
  'finished', 'complete', 'completed', 'done', 'closed', 'ended', 'stop', 'stopped',
  'hidden', 'hide', 'hiding', 'idle', 'wait', 'waitingforothers'
]);

const ROLL_TEXT_RX = /roll|dice|tap|move|your turn|your go|initiative/i;
const TURN_TEXT_RX = /turn|order|initiative|round|player|rolling/i;

function toCamelFromSnake(key) {
  return key.replace(/[_-]([a-z])/g, (_, c) => c.toUpperCase());
}

function toSnakeFromCamel(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function readLooseProp(source, key) {
  if (!source || typeof source !== 'object') return undefined;
  if (key in source) return source[key];
  const camel = toCamelFromSnake(String(key));
  if (camel in source) return source[camel];
  const snake = toSnakeFromCamel(String(key));
  if (snake in source) return source[snake];
  const lower = String(key).toLowerCase();
  for (const prop of Object.keys(source)) {
    if (prop.toLowerCase() === lower) return source[prop];
  }
  return undefined;
}

function coerceBoolish(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value !== 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (BOOLISH_TRUE.has(lower)) return true;
    if (BOOLISH_FALSE.has(lower)) return false;
    if (ROLL_TEXT_RX.test(trimmed)) return true;
    return null;
  }
  if (typeof value === 'object') {
    if ('value' in value) {
      const nested = coerceBoolish(value.value);
      if (nested != null) return nested;
    }
    if ('enabled' in value) {
      const nested = coerceBoolish(value.enabled);
      if (nested != null) return nested;
    }
    if ('allow' in value) {
      const nested = coerceBoolish(value.allow);
      if (nested != null) return nested;
    }
    if ('allowed' in value) {
      const nested = coerceBoolish(value.allowed);
      if (nested != null) return nested;
    }
    if ('active' in value) {
      const nested = coerceBoolish(value.active);
      if (nested != null) return nested;
    }
  }
  return null;
}

function readBoolish(source, ...keys) {
  for (const key of keys) {
    const value = readLooseProp(source, key);
    if (value === undefined) continue;
    const bool = coerceBoolish(value);
    if (bool != null) return bool;
  }
  return null;
}

function stringFrom(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'object') {
    if ('text' in value) return stringFrom(value.text);
    if ('message' in value) return stringFrom(value.message);
    if ('value' in value) return stringFrom(value.value);
  }
  return '';
}

function readStringish(source, ...keys) {
  for (const key of keys) {
    const value = readLooseProp(source, key);
    if (value === undefined) continue;
    const text = stringFrom(value);
    if (text) return text;
  }
  return '';
}

function textSuggestsRoll(text) {
  if (!text) return false;
  return ROLL_TEXT_RX.test(String(text));
}

function textSuggestsTurn(text) {
  if (!text) return false;
  return TURN_TEXT_RX.test(String(text));
}

function normalizePhase(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isLobbyPhaseValue(value) {
  const phase = normalizePhase(value);
  if (!phase) return true;
  if (phase === 'lobby' || phase === 'character_select' || phase === 'setup') return true;
  return phase.includes('lobby');
}

function isPlayPhaseValue(value) {
  const phase = normalizePhase(value);
  if (!phase) return false;
  if (phase === 'turn_order' || phase === 'turnorder' || phase === 'turn-order') return true;
  if (phase === 'board' || phase === 'in_game' || phase === 'game' || phase === 'playing') return true;
  if (phase.includes('turn') && phase.includes('order')) return true;
  if (phase.includes('board')) return true;
  if (phase.includes('game') && !phase.includes('lobby')) return true;
  return false;
}

function snapshotHintsAtPlay(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.turnOrder || snapshot.turn_order) return true;
  if (snapshot.board || snapshot.boardState || snapshot.board_state) return true;
  if (snapshot.canRoll || snapshot.allowRoll || snapshot.rollAllowed || snapshot.prompt === true) return true;
  const prompt = snapshot.prompt || snapshot.message || snapshot.text || snapshot.statusText;
  if (prompt && /roll/i.test(String(prompt))) return true;
  const phaseValue = snapshot.phase ?? snapshot.stage ?? snapshot.status ?? snapshot.state ?? snapshot.mode;
  return isPlayPhaseValue(phaseValue);
}

function shouldLobbyBeVisible(snapshot = null) {
  if (snapshot && snapshotHintsAtPlay(snapshot)) return false;
  if (snapshot) {
    const snapshotPhase = snapshot.phase ?? snapshot.stage ?? snapshot.status ?? snapshot.state ?? snapshot.mode;
    if (isLobbyPhaseValue(snapshotPhase)) return true;
  }
  if (state.inTurnOrder || state.canRollNow) return false;
  const phaseValue = lastPhaseValue || state.phase;
  return isLobbyPhaseValue(phaseValue);
}

function isLobbyShowing(){
  const lobbyEl = state.els?.lobbyArea;
  if (lobbyEl?.classList) {
    const visible = !lobbyEl.classList.contains('hidden');
    lastLobbyVisible = visible;
    return visible;
  }
  if (typeof lastLobbyVisible === 'boolean') return lastLobbyVisible;
  const phase = String(state.phase || '').toLowerCase();
  return phase === 'lobby';
}

function maybeSetPhase(next){
  if (!next) return;
  const clean = String(next);
  if (lastPhaseValue === clean) return;
  lastPhaseValue = clean;
  setPhase(clean);
}

// ---------------------------------------------------------------------------
// Small helpers formerly duplicated
// ---------------------------------------------------------------------------
function maybeSetLobbyVisible(on) {
  const flag = !!on;
  if (flag && !shouldLobbyBeVisible()) return;
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

function requestRehydrateSoon(reason = 'hello', delay = HYDRATE_KICK_DELAY_MS) {
  const hasCatalog = Array.isArray(state._pendingCatalog) && state._pendingCatalog.length;
  const hasRenderedCatalog = Array.isArray(state.catalog?.entries) && state.catalog.entries.length;
  if ((hasCatalog || hasRenderedCatalog) && state.hydrated) return;

  if (hydrateKickTimer) {
    clearTimeout(hydrateKickTimer);
    hydrateKickTimer = 0;
  }

  const wait = Number.isFinite(delay) ? Math.max(50, delay) : HYDRATE_KICK_DELAY_MS;
  hydrateKickTimer = setTimeout(() => {
    hydrateKickTimer = 0;
    requestHydrateBurst(reason || 'kick');
  }, wait);
}

// ---------------------------------------------------------------------------
// Message de-dupe helpers
// ---------------------------------------------------------------------------
function hasPatchOperations(source) {
  if (!source || typeof source !== 'object') return false;
  const seen = new Set();
  const queue = [source];
  const PATCH_OP_KEYS = ['add', 'update', 'remove', 'ops', 'patches', 'operations', 'changes', 'diff', 'delta', 'apply', 'values'];
  while (queue.length && seen.size < 100) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length) return true;
      continue;
    }

    for (const key of PATCH_OP_KEYS) {
      if (!(key in node)) continue;
      const value = node[key];
      if (Array.isArray(value) && value.length) return true;
      if (value && typeof value === 'object') queue.push(value);
    }

    const nested = node.patch || node.delta || node.payload || node.data;
    if (nested && typeof nested === 'object') queue.push(nested);
  }
  return false;
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
    if (start !== undefined || end !== undefined) {
      const hasOps = hasPatchOperations(source) ? '1' : '0';
      const part = source.patchPart ?? source.part ?? source.segment ?? source.chunk ?? source.batch ?? '';
      return `${type}|patch:${start ?? ''}-${end ?? ''}|ops:${hasOps}${part ? `|part:${part}` : ''}`;
    }
    const range = source.patchRange ?? source.range;
    if (range && typeof range === 'object') {
      const rs = range.start ?? range.from ?? range.begin ?? range[0];
      const re = range.end ?? range.to ?? range.finish ?? range[1];
      if (rs !== undefined || re !== undefined) {
        const hasOps = hasPatchOperations(source) ? '1' : '0';
        const part = source.patchPart ?? source.part ?? source.segment ?? source.chunk ?? source.batch ?? '';
        return `${type}|patch:${rs ?? ''}-${re ?? ''}|ops:${hasOps}${part ? `|part:${part}` : ''}`;
      }
    }
    const ids = source.patchIds ?? source.ids;
    if (Array.isArray(ids) && ids.length) {
      const hasOps = hasPatchOperations(source) ? '1' : '0';
      return `${type}|patchIds:${ids.join(',')}|ops:${hasOps}`;
    }
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

function isDuplicate(raw) {
  return !shouldProcessMessage(raw);
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
  const lobbyShowing = isLobbyShowing();

  if (shouldShow) {
    if (lobbyShowing) {
      maybeSetLobbyVisible(false);
      hideJoinCard();
    }
    if (!rollOverlayVisible) {
      showRollOverlay();
      rollOverlayVisible = true;
    }
    if (immediateUpdate) updateRollUI();
    return;
  }

  if (rollOverlayVisible) {
    hideRollOverlay();
    rollOverlayVisible = false;
  }

  if (lobbyShowing && rollOverlayVisible === false) {
    // If we were showing the lobby while a roll prompt was pending, ensure it can
    // stay visible once the prompt clears.
    maybeSetLobbyVisible(shouldLobbyBeVisible());
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

  if (Array.isArray(state.catalog.entries)) {
    state._pendingCatalog = [...state.catalog.entries];
  }
}

function commitCatalogRender(list, { debounce = false } = {}) {
  const doRender = () => {
    renderCatalog(list);
    if (rollOverlayVisible) updateRollUI();
    if (Array.isArray(list) && list.length && shouldLobbyBeVisible()) maybeSetLobbyVisible(true);
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
    if (shouldLobbyBeVisible()) maybeSetLobbyVisible(true);
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
    if (shouldLobbyBeVisible(snapshot)) {
      if (state._lobbySignature !== lobbySignature) {
        maybeSetLobbyVisible(true);
      }
    } else {
      maybeSetLobbyVisible(false);
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
  if (myId) state.myHasRolled = rolled.has(myId);

  const promptText = readStringish(turnOrder, 'prompt', 'promptText', 'message', 'text');
  const statusText = readStringish(turnOrder, 'statusText', 'status', 'state');
  const phaseText = readStringish(turnOrder, 'phase', 'stage', 'mode');
  const titleText = readStringish(turnOrder, 'title', 'heading');

  const promptSuggestsRoll = textSuggestsRoll(promptText);
  const statusSuggestsRoll = textSuggestsRoll(statusText);

  const detectedCanRoll = readBoolish(
    turnOrder,
    'canRoll', 'allowRoll', 'rollAllowed', 'awaitingRoll', 'waitingForRoll', 'waiting_for_roll',
    'awaitingPlayer', 'awaitingPlayers', 'promptPending', 'promptReady', 'shouldRoll', 'playerCanRoll', 'prompt'
  );
  if (detectedCanRoll != null) {
    state.canRollNow = detectedCanRoll;
  } else if (promptSuggestsRoll || statusSuggestsRoll) {
    state.canRollNow = true;
  } else {
    state.canRollNow = false;
  }

  const detectedActive = readBoolish(
    turnOrder,
    'active', 'isActive', 'running', 'inProgress', 'turnActive', 'visible', 'showing', 'show',
    'turnInProgress', 'turn_in_progress'
  );
  if (detectedActive != null) {
    state.inTurnOrder = detectedActive;
  } else {
    const statusLooksLikeTurn = textSuggestsTurn(statusText) || textSuggestsTurn(promptText) || textSuggestsTurn(phaseText);
    if (orderList.length || state.canRollNow || statusLooksLikeTurn) {
      state.inTurnOrder = true;
    } else if (statusText && BOOLISH_FALSE.has(statusText.trim().toLowerCase())) {
      state.inTurnOrder = false;
    } else if (phaseText && !textSuggestsTurn(phaseText) && !state.canRollNow && !orderList.length) {
      state.inTurnOrder = false;
    }
  }

  if (phaseText) maybeSetPhase(phaseText);

  if (titleText && state.els.rollTitle) {
    state.els.rollTitle.textContent = titleText;
  }

  const normalizedStatus = statusText.trim();
  const shouldUseStatus = !!normalizedStatus && !/^turn[\s_-]*order$/i.test(normalizedStatus) && normalizedStatus.toLowerCase() !== 'board';

  if (shouldUseStatus) {
    const ok = textSuggestsRoll(statusText) || !!state.canRollNow;
    updateRollUI({ msg: statusText, ok });
  } else if (promptText) {
    const ok = textSuggestsRoll(promptText) || !!state.canRollNow;
    updateRollUI({ msg: promptText, ok });
  } else if (normalizedStatus) {
    const ok = textSuggestsRoll(statusText) || !!state.canRollNow;
    updateRollUI({ msg: statusText, ok });
  }
  if (orderText) updateRollUI({ orderText, ok: true });

  updateRollOverlayVisibility({ immediateUpdate: true });
  return true;
}

function handleBoardRollSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return false;

  const prompt = readStringish(raw, 'prompt', 'promptText', 'message', 'text', 'statusText');
  const title = readStringish(raw, 'title', 'heading') || 'Roll';
  const detectedAllow = readBoolish(
    raw,
    'canRoll', 'allowRoll', 'rollAllowed', 'allow', 'enabled', 'can_roll', 'allow_roll', 'roll_allowed',
    'awaitingRoll', 'waitingForRoll', 'promptPending', 'shouldRoll', 'playerCanRoll', 'prompt'
  );
  let allow = detectedAllow;
  if (allow == null && textSuggestsRoll(prompt)) allow = true;

  if (allow == null) return false;

  let lobbyShowing = isLobbyShowing();

  const myId = state.playerId ? String(state.playerId) : null;
  const rolled = gatherRolledIds(raw);
  if (myId && rolled.size) state.myHasRolled = rolled.has(myId);

  if (allow) {
    state.canRollNow = true;
    state.inTurnOrder = state.inTurnOrder || !!raw.turnOrder;
    if (state.els.rollTitle) state.els.rollTitle.textContent = title;
    if (lobbyShowing) {
      maybeSetLobbyVisible(false);
      lobbyShowing = isLobbyShowing();
    }
    if (!lobbyShowing) {
      showRollOverlay({ title, prompt: prompt || 'Tap ROLL to move.' });
      rollOverlayVisible = true;
    } else {
      hideRollOverlay();
      rollOverlayVisible = false;
    }
    updateRollUI({ msg: prompt || 'Tap ROLL to move.' });
  } else {
    state.canRollNow = false;
    if (!state.inTurnOrder) hideRollOverlay();
    if (prompt) updateRollUI({ msg: prompt });
    rollOverlayVisible = false;
  }

  updateRollOverlayVisibility({ immediateUpdate: true });
  return true;
}

// normalize message types (treat BROADCAST_STATE like STATE)
function normType(t) {
  const s = String(t || '').toUpperCase();
  if (!s) return 'TEXT';
  if (s.includes('BROADCAST_STATE') || s === 'STATE' || s.includes('STATEENVELOPE')) return 'STATE';
  if (/^(CHAR(ACTER)?_)?CATALOG_?PATCH$/.test(s)) return 'CHARACTER_CATALOG_PATCH';
  if (/^(CHAR(ACTER)?_)?CATALOG$/.test(s)) return 'CHARACTER_CATALOG';
  if (s === 'HELLO_OK' || s === 'WELCOME' || s === 'ROOM_OPEN' || s === 'PONG') return 'HELLO';
  return s;
}

// message handler
export async function onSocketMessage(msg) {
  try {
    // --- normalize incoming payload (Blob/ArrayBuffer/string/object) ---
    let raw = msg;
    if (raw && typeof raw === 'object' && 'data' in raw) raw = raw.data;
    if (raw instanceof Blob) raw = await raw.text();
    else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s || (s[0] !== '{' && s[0] !== '[')) {
        const up = s.toUpperCase();
        if (up.includes('PONG') || up.includes('PING')) return;
        return; // ignore non-JSON chatter
      }
      try { raw = JSON.parse(s); } catch { return; }
    }

    // --- de-dupe identical messages ---
    if (isDuplicate(raw)) return;

    const type = normType(raw?.type || raw?.msg || raw?.kind || raw?.messageType);

    switch (type) {
      case 'HELLO': {
        ensureLobbyShown();
        requestRehydrateSoon('hello');
        return;
      }

      case 'WS_OPEN': {
        ensureLobbyShown();
        requestRehydrateSoon('ws-open', 120);
        return;
      }

      case 'WS_RETRY': {
        requestRehydrateSoon('ws-retry', HYDRATE_KICK_DELAY_MS);
        return;
      }

      case 'STATE': {
        // 1) Merge lobby/game state if present
        const payload = raw.payload || raw.data || raw.body || raw.state || raw;
        if (payload && typeof payload === 'object') {
          if (payload.lobbySnapshot || payload.lobby_state) {
            mergeState(payload.lobbySnapshot || payload.lobby_state, { debounceCatalog: true });
          } else {
            mergeState(payload.state || payload, { debounceCatalog: true });
          }
        }

        // 2) ALSO handle catalog envelopes/patch triplets piggybacked on STATE
        //    (This was the missing piece; without it the grid never renders.)
        const trip = findPatchTriplet(payload);
        if (trip) {
          noteCatalogVersion(payload);
          applyCatalogPatch(trip);
          // commit pending list with debounce to avoid flicker during batch patches
          const list = (state._pendingCatalog && state._pendingCatalog.length)
            ? state._pendingCatalog
            : state.catalog?.entries || [];
          commitCatalogRender(list, { debounce: true });
        } else {
          const entries = pickCatalogEntries(payload);
          if (entries && entries.length) {
            const version = noteCatalogVersion(payload);
            applyCatalogSnapshot(entries, { debounce: true, version });
          }
        }

        // 3) Turn/roll overlays (unchanged)
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

      case 'CHARACTER_CATALOG': {
        const payload = raw.payload || raw.data || raw.body || raw;
        const entries = pickCatalogEntries(payload);
        if (entries && entries.length) {
          const version = noteCatalogVersion(payload);
          applyCatalogSnapshot(entries, { debounce: false, version });
          markHydrated({ version: state.catalogVersion });
        }
        return;
      }

      case 'CHARACTER_CATALOG_PATCH': {
        const payload = raw.payload || raw.data || raw.body || raw;
        const trip = findPatchTriplet(payload) || payload;
        if (trip) {
          noteCatalogVersion(payload);
          applyCatalogPatch(trip);
          commitCatalogRender(
            state._pendingCatalog?.length ? state._pendingCatalog : state.catalog.entries,
            { debounce: true }
          );
          markHydrated({ version: state.catalogVersion });
        }
        return;
      }

      default: {
        // Fallback: try to extract catalog content from odd wrappers
        const payload = raw.payload || raw.data || raw.body || raw;
        const trip = findPatchTriplet(payload);
        if (trip) {
          noteCatalogVersion(payload);
          applyCatalogPatch(trip);
          commitCatalogRender(
            state._pendingCatalog?.length ? state._pendingCatalog : state.catalog.entries,
            { debounce: true }
          );
          markHydrated({ version: state.catalogVersion });
          return;
        }
        const entries = pickCatalogEntries(payload);
        if (entries && entries.length) {
          const version = noteCatalogVersion(payload);
          applyCatalogSnapshot(entries, { debounce: false, version });
          markHydrated({ version: state.catalogVersion });
          return;
        }
        // keep turn/roll responsive even on unknown wrappers
        handleTurnOrderSnapshot(payload);
        handleBoardRollSnapshot(payload);
        updateRollOverlayVisibility({ immediateUpdate: true });
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
