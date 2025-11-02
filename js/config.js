// Resolve server bases from URL or defaults.
const url = new URL(location.href);
export const API_BASE = (url.searchParams.get('api') || '').replace(/\/+$/,'') || 'http://localhost:8080';
export const WS_BASE  = (url.searchParams.get('ws')  || '').replace(/\/+$/,'') || 'ws://localhost:8080';

export const STORAGE_KEY = 'derp.session.v1';
