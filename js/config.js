// Centralized config + constants
export const BASE       = 'https://derpparty-relay.fly.dev';
export const HTTP_BASE  = BASE;
export const WS_URL     = BASE.replace('https','wss') + '/socket';

// Terminal close codes that end a session immediately
export const TERMINAL_CLOSE_CODES = new Set([4000,4001,4002,4003,4401,4403,4410,4411]);

// Session storage key (bumped to clear old layouts)
export const SESSION_KEY = 'dp.session.v2';

// Reconnect backoff (was 500 * 1.8^n, jitter)
export const backoff = (n) => Math.min(15000, 500 * Math.pow(1.8, n)) + Math.floor(Math.random()*150);
