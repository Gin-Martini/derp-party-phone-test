export const state = {
  connected: false,
  lastSeq: 0,
  phase: 'disconnected',
  me: null,             // { id, name, charId, ready }
  lobby: null,          // { players:[], catalog:{version,entries:[]}, allReady }
  rollPrompt: null,     // last ROLL_PROMPT
  rollResults: null,    // last ROLL_RESULT
  lastScreen: null,     // last SCREEN payload
  session: null,        // { roomId, playerId, token, wsUrl }
};
