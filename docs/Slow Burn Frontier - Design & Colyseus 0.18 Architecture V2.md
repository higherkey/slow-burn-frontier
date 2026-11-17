# Slow Burn Frontier — Design & Colyseus 0.18 Architecture V2

## **1\. Fresh-Eyes Audit & Applied Fixes**

* **Ping-Pong Rule Exploit Fixed:** Added `cooldownTicksRemaining` (default 3 ticks after firing) and a 1-unit logistics transit fuel fee to `LogisticsRule` evaluation so cyclic rules between two adjacent sectors cannot create infinite zero-cost convoy loops.  
* **Offline Fallback Doctrine Implemented:** Connected the previously unused `Commander.fallbackDoctrine` (`"HOLD_AND_FORTIFY"`) inside `stepSimulation()` so disconnected commanders automatically fortify unfortified sectors when their capacitor reaches 6 tokens.  
* **Victory Condition Added:** The simulation now checks sector ownership after fleet resolution and transitions `state.phase` to `"GAME_OVER"` with `winnerSessionId` when a commander controls all sectors.  
* **Standalone Source Files:** Extracted `FrontierState.ts`, `FrontierRoom.ts`, `FrontierClient.ts`, and `FrontierRoom.test.ts` into the project folder.

---

## **2\. Updated Schema (`FrontierState.ts`)**

```ts
import { schema, t, type SchemaType } from "@colyseus/schema";

export const LogisticsRule = schema({
  ruleId: t.string(),
  sourceSectorId: t.string(),
  targetSectorId: t.string(),
  minThreshold: t.uint16().default(30),
  dispatchAmount: t.uint16().default(15),
  cooldownTicksRemaining: t.uint8().default(0),
  active: t.boolean().default(true),
}, "LogisticsRule");
export type LogisticsRule = SchemaType<typeof LogisticsRule>;

export const Commander = schema({
  sessionId: t.string(),
  factionName: t.string(),
  connected: t.boolean().default(true),
  fallbackDoctrine: t.string().default("HOLD_AND_FORTIFY"),
  tokens: t.uint8().default(10).view(),
  maxTokens: t.uint8().default(10).view(),
  nextTokenProgressMs: t.uint32().default(0).view(),
  rules: t.map(LogisticsRule).view(),
}, "Commander");
export type Commander = SchemaType<typeof Commander>;

export const SectorNode = schema({
  sectorId: t.string().fullStateOnly(),
  x: t.int16().fullStateOnly(),
  y: t.int16().fullStateOnly(),
  neighbors: t.array("string").fullStateOnly(),
  ownerSessionId: t.string().default(""),
  garrison: t.uint16().default(10),
  oreYieldPerTick: t.uint8().default(1),
  fortified: t.boolean().default(false),
}, "SectorNode");
export type SectorNode = SchemaType<typeof SectorNode>;

export const TransitFleet = schema({
  fleetId: t.string(),
  ownerSessionId: t.string(),
  fromSectorId: t.string(),
  toSectorId: t.string(),
  units: t.uint16(),
  departureTick: t.uint32(),
  arrivalTick: t.uint32(),
}, "TransitFleet");
export type TransitFleet = SchemaType<typeof TransitFleet>;

export const FrontierState = schema({
  currentTick: t.uint32().default(0),
  regenIntervalMs: t.uint32().default(20_000),
  phase: t.string().default("ACTIVE"), // "ACTIVE" | "GAME_OVER"
  winnerSessionId: t.string().default(""),
  sectors: t.map(SectorNode),
  fleets: t.map(TransitFleet),
  commanders: t.map(Commander),
}, "FrontierState");
export type FrontierState = SchemaType<typeof FrontierState>;
```

