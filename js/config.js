// js/config.js — defaults for public shareable URL
const QS = new URLSearchParams(location.search);

// Default to your Join API; override with ?api= if needed.
export const API_BASE =
  QS.get('api') ||
  'https://derpparty-join.fly.dev';

// Optional: direct WS override for debugging (?ws=wss://…/socket)
export const WS_OVERRIDE = QS.get('ws') || '';

// Session cache key
export const SESSION_KEY = 'derpParty.v1';
