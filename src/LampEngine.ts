// Decision engine for smart street lighting

export type LampState = {
  on: boolean;
  brightness: number;
  color: string;
  colorMode?: string;
};

export type Lamp = {
  id: string;
  name?: string;
  street: string;
  connections: string[];
  state: LampState;
};

export type PartialLampState = Partial<LampState> & { on?: boolean };

export type ActivateStreetOptions = {
  on: boolean;
  brightness?: number;
  color?: string;
  spilloverDepth: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  type: "same_street" | "cross_street";
};

export type GraphData = {
  nodes: { id: string; street: string }[];
  edges: GraphEdge[];
};

export type EngineEvent =
  | { type: "lamp_state_updated"; lampId: string; state: LampState }
  | { type: "street_activated"; streetId: string; affectedLampIds: string[] }
  | { type: "engine_initialized" };

// Main engine: graph, state, BFS
export class LampEngine {
  private lamps: Map<string, Lamp> = new Map();
  private events: EngineEvent[] = [];
  private onStateUpdated?: (lampId: string, state: LampState) => void;

  constructor(initialLamps: Lamp[]) {
    for (const lamp of initialLamps) {
      // Defensive copy
      const copy: Lamp = {
        id: lamp.id,
        name: lamp.name,
        street: lamp.street,
        connections: [...lamp.connections],
        state: { ...lamp.state },
      };
      this.lamps.set(copy.id, copy);
    }
    this.recordEvent({ type: "engine_initialized" });
  }

  public getEvents(): EngineEvent[] {
    return [...this.events];
  }

  public setLampState(lampId: string, partialState: PartialLampState): void {
    const lamp = this.lamps.get(lampId);
    if (!lamp) return;

    const updated: LampState = {
      on: partialState.on ?? lamp.state.on,
      brightness: partialState.brightness ?? lamp.state.brightness,
      color: partialState.color ?? lamp.state.color,
      colorMode: partialState.colorMode ?? lamp.state.colorMode,
    };

    lamp.state = updated;
    this.lamps.set(lampId, lamp);
    try {
      const action = updated.on ? "activated" : "deactivated";
      console.log(`[LampEngine] Lamp ${lampId} ${action} | brightness=${updated.brightness} color=${updated.color}`);
    } catch {}
    try { if (this.onStateUpdated) this.onStateUpdated(lampId, { ...updated }); } catch {}
    this.recordEvent({ type: "lamp_state_updated", lampId, state: { ...updated } });
  }

  public activateStreet(streetId: string, options: ActivateStreetOptions): void {
    const { on, brightness, color, spilloverDepth } = options;

    const startLampIds = this.getLampIdsByStreet(streetId);
    const affected = new Set<string>();

    // Activate target street
    for (const lampId of startLampIds) {
      this.setLampState(lampId, { on, brightness, color });
      affected.add(lampId);
    }

    // Spillover to other streets
    const spilloverIds = this.bfsSpilloverFromSet(startLampIds, spilloverDepth, streetId);
    for (const lampId of spilloverIds) {
      this.setLampState(lampId, { on, brightness, color });
      affected.add(lampId);
    }

    this.recordEvent({ type: "street_activated", streetId, affectedLampIds: [...affected] });
  }

  public previewStreetActivation(streetId: string, spilloverDepth: number): string[] {
    const startLampIds = this.getLampIdsByStreet(streetId);
    const affected = new Set<string>(startLampIds);

    const spilloverIds = this.bfsSpilloverFromSet(startLampIds, spilloverDepth, streetId);
    for (const id of spilloverIds) affected.add(id);

    return [...affected];
  }

  public getLampGraph(): GraphData {
    const nodes = Array.from(this.lamps.values()).map((l) => ({ id: l.id, street: l.street }));

    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    for (const lamp of this.lamps.values()) {
      for (const neighborId of lamp.connections) {
        if (!this.lamps.has(neighborId)) continue;
        const a = lamp.id;
        const b = neighborId;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const neighbor = this.lamps.get(neighborId)!;
        const type: GraphEdge["type"] = lamp.street === neighbor.street ? "same_street" : "cross_street";
        // Preserve original direction for consistency (from current lamp to neighbor)
        edges.push({ from: lamp.id, to: neighborId, type });
      }
    }

    return { nodes, edges };
  }

  private bfsSpilloverFromSet(startIds: string[], depthLimit: number, originStreet: string): string[] {
    if (depthLimit <= 0) return [];

    const visited = new Set<string>(startIds);
    const queue: Array<{ id: string; depth: number }> = [];

    for (const id of startIds) queue.push({ id, depth: 0 });

    const result: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const lamp = this.lamps.get(current.id);
      if (!lamp) continue;

      for (const neighborId of lamp.connections) {
        if (visited.has(neighborId)) continue;
        const neighbor = this.lamps.get(neighborId);
        if (!neighbor) continue;

        const nextDepth = current.depth + 1;
        if (nextDepth > depthLimit) continue;

        visited.add(neighborId);
        queue.push({ id: neighborId, depth: nextDepth });

        // Only other streets
        if (neighbor.street !== originStreet) {
          result.push(neighborId);
        }
      }
    }

    return result;
  }

  private getLampIdsByStreet(streetId: string): string[] {
    const result: string[] = [];
    for (const lamp of this.lamps.values()) {
      if (lamp.street === streetId) result.push(lamp.id);
    }
    return result;
  }

  private recordEvent(event: EngineEvent): void {
    this.events.push(event);
  }

  public setOnStateUpdated(fn: (lampId: string, state: LampState) => void) {
    this.onStateUpdated = fn;
  }
}

export default LampEngine;
