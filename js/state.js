// Single source of truth for mutable state (no globals)
export const state = {
  // connection
  ws: null,
  shouldReconnect: false,
  reconnectTimer: 0,
  reconnectAttempts: 0,
  hbInterval: 0,
  _terminal: false,

  // identity/session
  playerId: '',
  roomId: '',
  phase: 'lobby', // 'lobby' | 'turn_order' | 'in_game'
  playerNameById: new Map(),

  // lobby/char select
  catalog: null,
  _pendingCatalog: null,
  myReady: false,
  myCharId: null,
  takenChars: new Set(),

  // turn / roll
  myHasRolled: false,
  inTurnOrder: false,
  canRollNow: false,

  // trivia gating UI
  triviaAllowed: null, // null=unknown, true=can answer, false=cannot
  triviaMode: 'PENDING', // 'FFA' | 'SOLO' | 'PENDING'

  // DOM refs (wired by ui.init)
  $: null,
  els: {
    log: null, status: null, joinCard: null, lobbyArea: null,
    readyBtn: null, readyPill: null, charGrid: null, nameInput: null, dbg: null,
    rollPanel: null, rollBtn: null, rollTitle: null, rollState: null, rollValue: null, orderResult: null
  },

  // trivia pad refs
  triviaPadEl: null,
  triviaPadButtons: []
};
