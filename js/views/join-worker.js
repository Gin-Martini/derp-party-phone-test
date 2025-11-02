export default {
  async fetch(req, env, ctx) {
    // Basic CORS
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    };
    if (req.method === 'OPTIONS') return new Response('', { headers: cors });

    if (req.method !== 'POST') return new Response('Not Found', { status: 404, headers: cors });

    try {
      const { roomCode, name } = await req.json();
      const roomId = String(roomCode || '').trim().toUpperCase();
      const playerName = (name || '').trim().slice(0, 32);

      if (!roomId || !/^[A-Z0-9]{4,8}$/.test(roomId))
        return new Response(JSON.stringify({ error: 'Bad room code' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });

      // Your public relay socket (wss REQUIRED for https pages)
      const wsUrl = 'wss://derpparty-relay.fly.dev/socket';

      const payload = {
        wsUrl,
        roomId,
        playerId: crypto.randomUUID(),
        token: crypto.getRandomValues(new Uint32Array(4)).join('-'),
        // optional: echo a sanitized name the client could use
        displayName: playerName || 'Player',
      };

      return new Response(JSON.stringify(payload), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Bad request' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};
