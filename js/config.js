// Resolve bases from URL or sensible defaults.
// Supports two modes: API mode (/api/join) and Relay-direct mode (?ws=...).
const url = new URL(location.href);

export const API_BASE =
  (url.searchParams.get('api') || '').replace(/\/+$/,'') ||
  // If you host your own API at the same origin, uncomment next line:
  // `${location.origin}`,
  '';

export const WS_BASE  = (url.searchParams.get('wsbase') || '').replace(/\/+$/,'') || '';

// Relay-direct: if present, we skip HTTP join entirely.
export const DIRECT_WS = (url.searchParams.get('ws') || '').trim();

// Optional hints to prefill the join form / session in direct mode
export const ROOM_HINT = (url.searchParams.get('room') || '').trim();
export const NAME_HINT = (url.searchParams.get('name') || '').trim();
export const PID_HINT  = (url.searchParams.get('pid')  || '').trim(); // optional playerId if your relay supports it

export const STORAGE_KEY = 'derp.session.v1';
