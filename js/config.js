// js/config.js — public defaults for GH Pages
const QS = new URLSearchParams(location.search);

// Optional join API base (unused for direct-relay mode)
export const API_BASE = (QS.get('api') || '').trim();

// Default relay socket (must be wss:// for https page)
export const WS_BASE  = (QS.get('ws')  || 'wss://derpparty-relay.fly.dev/socket').trim();

// Hints (allow sharing pre-filled links like ?room=ABC123&name=Matt)
export const ROOM_HINT = (QS.get('room') || '').trim().toUpperCase();
export const NAME_HINT = (QS.get('name') || '').trim().slice(0, 32);

// Storage key
export const SESSION_KEY = 'derpParty.v1';
