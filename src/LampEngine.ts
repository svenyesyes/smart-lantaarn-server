/**
 * LampEngine: Decision engine for smart street lighting.
 * - In-memory graph of lamps
 * - Deterministic, testable logic for state updates and spillover activation
 * - No I/O, networking, or frameworks
 */

export type LampState = {
  on: boolean;
  brightness: number; // 0-100, interpreted by downstream UI/IoT layers
  color: string; // arbitrary CSS-like color string or hex
};

export type Lamp = {
  id: string;
  street: string;
  connections: string[]; // adjacent lamp IDs (can be same or cross street)
  state: LampState;
};

export type PartialLampState = Partial<LampState> & { on?: boolean };

export type ActivateStreetOptions = {
  on: boolean;
  brightness?: number;
  color?: string;
  spilloverDepth: number; // BFS depth limit for cross-street activation
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

/**
 * LampEngine: main class encapsulating graph, state, and BFS operations.
 */
export class LampEngine {
  private lamps: Map<string, Lamp> = new Map();
  private events: EngineEvent[] = [];

  /**
   * Initialize engine with a set of lamps.
   * Typically loaded from a JSON settings file externally.
   */
  constructor(initialLamps: Lamp[]) {
    for (const lamp of initialLamps) {
      // Defensive copy to avoid external mutation
      const copy: Lamp = {
        id: lamp.id,
        street: lamp.street,
        connections: [...lamp.connections],
        state: { ...lamp.state },
      };
      this.lamps.set(copy.id, copy);
    }
    this.recordEvent({ type: "engine_initialized" });
  }

  /**
   * Returns a snapshot of recorded events for external hooks or auditing.
   */
  public getEvents(): EngineEvent[] {
    return [...this.events];
  }

  /**
   * Updates desired state of a single lamp.
   * - No external communication performed
   * - Records an internal event
   */
  public setLampState(lampId: string, partialState: PartialLampState): void {
    const lamp = this.lamps.get(lampId);
    if (!lamp) return; // Silently ignore unknown IDs for deterministic flow

    const updated: LampState = {
      on: partialState.on ?? lamp.state.on,
      brightness: partialState.brightness ?? lamp.state.brightness,
      color: partialState.color ?? lamp.state.color,
    };

    lamp.state = updated;
    this.lamps.set(lampId, lamp);
    this.recordEvent({ type: "lamp_state_updated", lampId, state: { ...updated } });
  }

  /**
   * Activates all lamps in a given street and spillover to connected lamps
   * in other streets up to a BFS depth limit.
   * Uses BFS over lamp connections and avoids duplicate processing.
   */
  public activateStreet(streetId: string, options: ActivateStreetOptions): void {
    const { on, brightness, color, spilloverDepth } = options;

    const startLampIds = this.getLampIdsByStreet(streetId);
    const affected = new Set<string>();

    // Activate all lamps in the target street
    for (const lampId of startLampIds) {
      this.setLampState(lampId, { on, brightness, color });
      affected.add(lampId);
    }

    // BFS spillover to other streets only
    const spilloverIds = this.bfsSpilloverFromSet(startLampIds, spilloverDepth, streetId);
    for (const lampId of spilloverIds) {
      this.setLampState(lampId, { on, brightness, color });
      affected.add(lampId);
    }

    this.recordEvent({ type: "street_activated", streetId, affectedLampIds: [...affected] });
  }

  /**
   * Preview which lamps would be affected by activating the street with spillover depth.
   * Does not modify state.
   */
  public previewStreetActivation(streetId: string, spilloverDepth: number): string[] {
    const startLampIds = this.getLampIdsByStreet(streetId);
    const affected = new Set<string>(startLampIds);

    const spilloverIds = this.bfsSpilloverFromSet(startLampIds, spilloverDepth, streetId);
    for (const id of spilloverIds) affected.add(id);

    return [...affected];
  }

  /**
   * Returns nodes and edges suitable for a visual graph UI.
   * Edges are typed based on whether both lamps share the same street.
   */
  public getLampGraph(): GraphData {
    const nodes = Array.from(this.lamps.values()).map((l) => ({ id: l.id, street: l.street }));

    const edges: GraphEdge[] = [];
    for (const lamp of this.lamps.values()) {
      for (const neighborId of lamp.connections) {
        // To avoid duplicate edges, only add edge in one direction consistently
        if (lamp.id < neighborId && this.lamps.has(neighborId)) {
          const neighbor = this.lamps.get(neighborId)!;
          const type: GraphEdge["type"] = lamp.street === neighbor.street ? "same_street" : "cross_street";
          edges.push({ from: lamp.id, to: neighborId, type });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Private helper: BFS spillover starting from a set of lamp IDs.
   * - Depth-limited
   * - Only returns lamps in other streets
   * - Avoids duplicates
   */
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

        // Include only lamps in other streets for spillover
        if (neighbor.street !== originStreet) {
          result.push(neighborId);
        }
      }
    }

    return result;
  }

  /**
   * Utility: get all lamp IDs that belong to a given street.
   */
  private getLampIdsByStreet(streetId: string): string[] {
    const result: string[] = [];
    for (const lamp of this.lamps.values()) {
      if (lamp.street === streetId) result.push(lamp.id);
    }
    return result;
  }

  /**
   * Record internal engine events for hooks/auditing.
   */
  private recordEvent(event: EngineEvent): void {
    this.events.push(event);
  }
}

/**
 * Optional: default export for convenience.
 */
export default LampEngine;
