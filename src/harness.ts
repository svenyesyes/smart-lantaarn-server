import LampEngine, { Lamp } from "./LampEngine.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Tiny harness to exercise the engine deterministically using JSON settings.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const settingsPath = path.join(__dirname, "../data/settings.json");
const settingsRaw = fs.readFileSync(settingsPath, "utf-8");
const settings = JSON.parse(settingsRaw) as { lamps: Lamp[] };
const lamps: Lamp[] = settings.lamps;

const engine = new LampEngine(lamps);

console.log("Graph:", JSON.stringify(engine.getLampGraph(), null, 2));

console.log("Preview Main spillover depth 1:", engine.previewStreetActivation("Main", 1));
console.log("Preview Main spillover depth 2:", engine.previewStreetActivation("Main", 2));

engine.activateStreet("Main", { on: true, brightness: 75, color: "#ffdd88", spilloverDepth: 1 });

console.log("Events:", engine.getEvents());

// Show final states for verification
console.log(
  "Final states:",
  lamps.map((l) => ({ id: l.id, state: l.state }))
);
