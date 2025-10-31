// js/router.js  (drop-in)
import { renderCatalog } from "./features/catalog.js";
import { ensureLobbyShown, setStatus, setDbg } from "./ui.js";

export function initRouter(ws) {
  const r = new Router(ws);
  ws.addEventListener("message", (ev) => r.onSocketMessage(ev));
  return r;
}

class Router {
  constructor(ws) {
    this.ws = ws;
  }

  async onSocketMessage(ev) {
    let raw = ev?.data;

    // Handle Blob / ArrayBuffer frames from the relay
    if (raw instanceof Blob) raw = await raw.text();
    else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);

    // Try to parse JSON; otherwise treat as a status text
    if (typeof raw === "string") {
      const s = raw.trim();
      if (s.startsWith("{") || s.startsWith("[")) {
        try { raw = JSON.parse(s); } catch { /* fall through as text */ }
      }
    }

    if (typeof raw === "string") {
      setDbg("last", "msg=TEXT");
      setStatus(raw);
      ensureLobbyShown();
      return;
    }

    const type = normalizeType(raw?.type);
    const payload = raw?.payload ?? raw?.state ?? raw;

    setDbg("last", `msg=${type}`);

    switch (type) {
      case "HELLO":
        setStatus("Connected.");
        ensureLobbyShown();
        return;

      case "STATE":
      case "CHARACTER_CATALOG": {
        const entries =
          payload?.entries ??
          payload?.catalog ??
          payload?.characters ??
          [];
        ensureLobbyShown();
        renderCatalog(Array.isArray(entries) ? entries : []);
        return;
      }

      default: {
        // Fallback: if something carries entries, render anyway
        const entries =
          payload?.entries ?? payload?.catalog ?? payload?.characters;
        if (Array.isArray(entries)) {
          ensureLobbyShown();
          renderCatalog(entries);
        }
      }
    }
  }
}

function normalizeType(t) {
  const x = String(t || "").toUpperCase();
  const map = new Map([
    // greetings / keepalive variants
    ["HELLO_OK", "HELLO"],
    ["WELCOME", "HELLO"],
    ["ACK", "HELLO"],
    ["PONG", "HELLO"],
    ["ROOM_OPEN", "HELLO"],

    // state variants from host
    ["STATE", "STATE"],
    ["BROADCAST_STATE", "STATE"],
    ["LOBBY_STATE", "STATE"],
    ["STATE_ENVELOPE", "STATE"],
    ["OUT_STATE", "STATE"],

    // catalog variants
    ["CHARACTER_CATALOG", "CHARACTER_CATALOG"],
    ["CATALOG", "CHARACTER_CATALOG"],
    ["BROADCAST_CATALOG", "CHARACTER_CATALOG"],
    ["CATALOG_STATE", "CHARACTER_CATALOG"],
  ]);
  return map.get(x) ?? x || "TEXT";
}
