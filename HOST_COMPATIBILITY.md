Short answer: we’re 90% aligned already. Your host is a thin bus that forwards JSON DTOs with a type field; my plan expects a single, consistent envelope and a small, fixed set of client intents. To make them play perfectly, we need a wafer-thin wire adapter on the host and a couple of intent names registered in your router. That’s it.

Here’s the exact compatibility map and the minimal patches.

Where it already matches

Server→client framing: Host broadcasts raw DTOs that include type (e.g., ROOM_CLOSED). That’s structurally compatible with a typed wire. The bus already has SendStateEnvelope(...) and a central BroadcastState path—perfect choke points to standardize framing.

Client→server intents: Host funnels all generic player actions through IntentRouter.TryRoute(ii) using a single parsed IncomingIntent. If we send type:"CHOOSE_CHARACTER" | "SET_READY" | "ROLL" | "UI_EVENT", the router can route those with a one-liner registration per intent.

Rehydrate: On join, host triggers _rehydrate.AfterJoin() which pushes catalog + snapshots + open windows without needing client “rehydrate” requests. That fits the “server is authoritative” model.

The deltas (and one clean fix for each)

Envelope vs bare DTO

Current: Host sometimes broadcasts bare DTOs (top-level fields) and sometimes uses the bus abstraction.

Plan: Phone expects a canonical envelope: { v, type, seq, payload }, with snapshots living in payload.

Fix (host, 30 lines): Introduce a single Wire helper that wraps any DTO before broadcasting. Everything funnels through BroadcastState(...) already, so this is surgical.

```csharp
// Assets/Scripts/Net/Relay/Wire.cs
namespace DerpParty {
  public static class Wire {
    private static long _seq = 1;
    public static object Wrap(object dto, string forcedType = null, string roomId = null) {
      var type = forcedType ?? (string)dto.GetType().GetField("type")?.GetValue(dto);
      if (string.IsNullOrEmpty(type)) type = dto.GetType().Name.ToUpperInvariant();
      return new {
        v = 1,
        type,
        roomId,
        seq = System.Threading.Interlocked.Increment(ref _seq),
        payload = dto
      };
    }
  }
}
```

Patch your broadcast to always use the wrapper:

```csharp
public void BroadcastState(object stateDto)
{
    var wrapped = Wire.Wrap(stateDto, roomId: _roomId);
    _bus.BroadcastState(wrapped);
    OnMainThread(() => { try { OnStateBroadcast?.Invoke(wrapped); } catch { } });
}
```

Optional: keep SendState(object envelope) as-is for rare pre-wrapped cases; everything else goes through BroadcastState(...) and gets wrapped.

Canonical message types

Current: Router handles generic “intents,” but supported verbs are spread around legacy names.

Plan: Phone only emits four canonical types: CHOOSE_CHARACTER, SET_READY, ROLL, UI_EVENT.

Fix (router, ~4 registrations): Add these to your IntentRouter map with the semantics you already have.

```csharp
// Pseudocode inside IntentRouter config:
Register("CHOOSE_CHARACTER", (pid, msg) => Lobby.SelectCharacter(pid, msg.value ?? msg.charId));
Register("SET_READY",       (pid, msg) => Lobby.SetReady(pid, msg.ready));
Register("ROLL",            (pid, msg) => TurnOrder.OnRoll(pid, msg.rollId));
Register("UI_EVENT",        (pid, msg) => UIScreens.Handle(pid, msg.screen, msg.@event, msg.data));
```

If your IncomingIntent uses value rather than a structured payload, either:

(A) teach the router to look into msg.payload or

(B) keep reading value and have phone include a mirror value field. Your choice. I recommend (A) to match the envelope.

Snapshot naming

Current: Rehydrate coordinator pushes “lobby snapshot,” “order snapshot,” etc., each with its own DTO.

Plan: Phone expects a single STATE message whose payload contains { phase, me, lobby, ... }.

Fix (where you send snapshots, 1 function): Coalesce your existing snapshots into one composer that builds StateSnapshotDto { type="STATE", phase=..., me=..., lobby=..., flags=... } and then call BroadcastState(stateDto). Keep your internal snapshot types if you like; the wire sees only STATE.

Minimal DTO:

```csharp
[Serializable]
public sealed class StateSnapshotDto {
  public string type = "STATE";
  public string phase;      // "lobby" | "roll_turn_order" | "gameplay" | "trivia"
  public MeDto me;
  public LobbyDto lobby;
  public FlagsDto flags;
}
```

Roll prompts/results

Current: Turn order logic exists (TurnOrderNetController, TurnLoopController), but wire types aren’t standardized.

Plan: Phone looks for ROLL_PROMPT and ROLL_RESULT.

Fix (emitters, tiny): When you open initiative, broadcast:

```csharp
[Serializable] sealed class RollPromptDto {
  public string type = "ROLL_PROMPT";
  public string rollId;
  public string kind = "turn_order";
  public string label = "Roll for turn order";
  public List<string> allowedPlayers;      // canonical ids
  public List<string> alreadyRolled;       // optional
  public int deadlineMs;                   // optional
}
```

As results come in, broadcast:

```csharp
[Serializable] sealed class RollResultDto {
  public string type = "ROLL_RESULT";
  public string rollId;
  public List<PlayerRoll> results;         // { playerId, value }
  public List<string> order;               // optional summary
  public bool complete;                    // set true when done
}
```

IDENTIFY noise

Current: Host doesn’t care about a client “identify” packet.

Plan: Phone sends IDENTIFY on socket open (for future replay/seq).

Fix: No change required. Your OnWsMessage will parse, fail to match known records, and move on. If you want to be explicit, add a trivial ignore:

```csharp
try {
  var id = JsonUtility.FromJson<ClientRequestMsg>(text);
  if (id != null && id.type == "IDENTIFY") return;
} catch { }
```

HTTP /api/join

Reality check: The host connects to a relay. Phones either (a) join via the relay’s own HTTP/WS or (b) call your convenience /api/join that returns { roomId, playerId, token, wsUrl }. My client uses (b).

Fix: If you don’t already expose /api/join, add a tiny edge service in front of the relay that maps your current “room code” to a wsUrl and issues a player token. If (a) is already how your phones join today, keep it and just have the phone fill wsUrl from query string—schema remains identical after connect. The wire schema doesn’t care where the URL came from.

Why this won’t break anything you care about

Your RehydrateCoordinator.AfterJoin() still fires on PLAYER_JOINED. The phone doesn’t need to ask; it will simply receive a proper STATE and render.

Your card window service still uses CARD_INTENT; the phone never sends it unless you show that screen and wire a button to do so (via UI_EVENT or a dedicated message).

On the host HUD, you’re already listening to OnStateBroadcast. You’ll now receive the wrapped object; if your HUD expects the inner DTO, unwrap in one place or accept the envelope.

Phone client: one optional compat shim (during migration)

If you want to migrate the host later, add this tiny fallback in the phone for a while:

```javascript
// inside reduceEnvelope(msg)
const isBareState = msg.type === 'STATE' && !msg.payload && msg.phase;
if (isBareState) {
  applyState(msg);           // accept old shape temporarily
  return;
}
```

Then delete it once the host is wrapping.

Sanity checklist to prove it’s wired right

Create room → host logs “WS connected.” → host broadcasts catalog ⇒ phone shows grid and I’m Ready.

All ready → host switches phase and broadcasts STATE{phase:"roll_turn_order"} + ROLL_PROMPT ⇒ only eligible phones see Roll.

Player taps Roll ⇒ host receives type:"ROLL" intent with rollId and canonical playerId ⇒ host broadcasts ROLL_RESULT updates; on complete:true, next STATE flips phase to gameplay.

Any host window (Lobby, Trivia, etc.) still functions; if you want interactivity, add button → phone sends UI_EVENT → IntentRouter routes to the right system.

TL;DR patches to apply

Wrap all outbound with Wire.Wrap(...) inside BroadcastState(...).

Register four intent names with the router.

Emit STATE/ROLL_PROMPT/ROLL_RESULT DTOs from your existing systems.

Optionally ignore IDENTIFY in OnWsMessage.

Provide /api/join convenience (or supply wsUrl another way).

Do that, and the static GH phone will “just work” with your Unity host—clean schema, no aliases, no timers, no guesswork.
