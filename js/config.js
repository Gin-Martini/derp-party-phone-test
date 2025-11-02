// Resolve bases from URL or sensible defaults.
// Supports API mode (?api=...) and Relay-direct mode (?ws=...).
const url = new URL(location.href);

export const API_BASE =
  (url.searchParams.get('api') || '').replace(/\/+$/,'') || '';

export const WS_BASE =
  (url.searchParams.get('wsbase') || '').replace(/\/+$/,'') || '';

// Relay-direct: if present, we skip HTTP join entirely.
export const DIRECT_WS = (url.searchParams.get('ws') || '').trim();

// Optional hints (used in IDENTIFY during direct mode)
export const ROOM_HINT = (url.searchParams.get('room') || '').trim();
export const NAME_HINT = (url.searchParams.get('name') || '').trim();
export const PID_HINT  = (url.searchParams.get('pid')  || '').trim();

export const STORAGE_KEY = 'derp.session.v1';
