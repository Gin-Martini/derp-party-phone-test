// js/config.js — defaults for public shareable URL
const QS = new URLSearchParams(location.search);

// If you later deploy a tiny Join API, put its base URL here or override via ?api=...
export const API_BASE = QS.get('api') || ''; // empty = use direct WS fallback

// Default relay socket (MUST be wss:// because the page is https)
export const WS_BASE = (QS.get('ws') || 'wss://derpparty-relay.fly.dev/socket').trim();

// Session cache key (cleared on redirect)
export const SESSION_KEY = 'derpParty.v1';
