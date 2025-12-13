import express, { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import LampEngine, { Lamp, ActivateStreetOptions } from "./LampEngine.js";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load lamps from JSON settings (compatible with Node ESM without import attributes)
const settingsPath = path.join(__dirname, "../data/settings.json");
const settingsRaw = fs.readFileSync(settingsPath, "utf-8");
const settings = JSON.parse(settingsRaw) as { lamps: Lamp[] };
const lamps: Lamp[] = settings.lamps;

const engine = new LampEngine(lamps);

const app = express();
app.use(express.json());

// Static frontend
const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

// REST: GET /graph
app.get("/graph", (_req: Request, res: Response) => {
  res.json(engine.getLampGraph());
});
// Optional: save client-side positions (persist to file)
app.post("/positions", (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, { x: number; y: number }>;
    setPositions(body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/positions", (_req: Request, res: Response) => {
  res.json(positionsCache);
});

// REST: POST /streets/:streetId/activate
app.post("/streets/:streetId/activate", (req: Request, res: Response) => {
  const streetId = req.params.streetId;
  const { on, brightness, color, spilloverDepth } = req.body || {};
  const opts: ActivateStreetOptions = {
    on: Boolean(on),
    brightness: brightness !== undefined ? Number(brightness) : undefined,
    color: typeof color === "string" ? color : undefined,
    spilloverDepth: Number(spilloverDepth) || 0,
  };

  engine.activateStreet(streetId, opts);

  // Broadcast latest lamp states
  broadcastLampStates();

  res.json({ ok: true, events: engine.getEvents() });
});

// REST: GET /streets/:streetId/preview?depth=N
app.get("/streets/:streetId/preview", (req: Request, res: Response) => {
  const streetId = req.params.streetId;
  const depth = Number(req.query.depth) || 0;
  const ids = engine.previewStreetActivation(streetId, depth);
  res.json({ affectedLampIds: ids });
});

// Root -> index.html
app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Shared positions persistence (across clients)
let positionsCache: Record<string, { x: number; y: number }> = {};
const positionsPath = path.join(__dirname, "../data/positions.json");
try {
  const raw = fs.readFileSync(positionsPath, "utf-8");
  positionsCache = JSON.parse(raw);
} catch {}

wss.on("connection", (ws: WebSocket) => {
  // Send initial states + positions
  ws.send(
    JSON.stringify({ type: "init", graph: engine.getLampGraph(), states: getAllLampStates(), positions: positionsCache })
  );
});

function getAllLampStates() {
  // Export minimal state snapshot
  // engine doesn't expose lamps publicly; we can reconstruct from graph and ask current state via internal map using type cast.
  const graph = engine.getLampGraph();
  return graph.nodes.map((n) => {
    const l = (engine as any).lamps.get(n.id) as Lamp;
    return { id: n.id, state: l.state };
  });
}

function broadcastLampStates() {
  const payload = JSON.stringify({ type: "update", states: getAllLampStates(), events: engine.getEvents() });
  wss.clients.forEach((client: WebSocket) => {
    try {
      client.send(payload);
    } catch {}
  });
}

function setPositions(p: Record<string, { x: number; y: number }>) {
  positionsCache = p;
  try {
    fs.writeFileSync(positionsPath, JSON.stringify(positionsCache, null, 2), "utf-8");
  } catch {}
  const payload = JSON.stringify({ type: "positions", positions: positionsCache });
  wss.clients.forEach((client: WebSocket) => {
    try { client.send(payload); } catch {}
  });
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
