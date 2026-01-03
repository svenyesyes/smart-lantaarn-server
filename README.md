# Smart Lantaarn Decision Engine (TypeScript)

A minimal, deterministic, testable decision engine for smart street lighting. It models lamps as nodes in a graph, supports spillover activation across streets via BFS, and avoids any networking or hardware code.

## Scope
- No authentication
- No direct IoT/MQTT/hardware communication
- Focus on lamp state logic and graph traversal
- Clean, deterministic, strongly-typed code

## Data Model
```ts
export type LampState = { on: boolean; brightness: number; color: string };
export type Lamp = { id: string; street: string; connections: string[]; state: LampState };
```

## Public API
- `setLampState(lampId, partialState)`
- `activateStreet(streetId, { on, brightness?, color?, spilloverDepth })`
- `previewStreetActivation(streetId, spilloverDepth)`
- `getLampGraph()` → nodes & typed edges

## Settings JSON
Load your lamps from a JSON file externally and pass to `new LampEngine(lamps)`. This module only handles in-memory logic.

## Quick Start
```bash
npm install
npm run build
npm start
```

The harness runs a small scenario, prints graph/preview/events, and final lamp states.

## Notes
- Spillover is limited by BFS depth and only applies to lamps in other streets.
- Duplicate processing is avoided via visited sets.
- Edges are emitted once per pair based on ID ordering to prevent duplicates.
