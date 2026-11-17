# Slow Burn Frontier — Project Plan, Requirements & Coding Agent Kickoff

**Folder:** `01 - Slow Burn Frontier`  
**Portfolio Rank:** \#1 (Score: 90.0 / 100\)  
**Target Mode:** 1-to-4 Player Blitz Tabletop Strategy (with Solo AI Bot Fallback)

---

## **1\. Product Vision & Scope**

**Slow Burn Frontier** is a deterministic, zero-micro orbital sector control game built around an **Action Point Capacitor (APC)** and **Programmed Logistics Rules**. Instead of pay-to-win timers or high-APM unit clicking, commanders start with a full 10-token capacitor for an immediate opening burst, then regenerate 1 token every 20 seconds (Blitz format) or 60 seconds (Standard format). Players spend tokens to launch manual strike fleets, fortify sectors, or program conditional supply conduits that execute automatically without further APC cost.

### **Vertical Slice vs. Commercial Release Scope**

* **POC Vertical Slice (Implemented):** 12-node ring/core orbital map, 1 Hz simulation loop, private `StateView` APC & rule isolation, `dispatch-fleet`, `fortify-sector`, `upsert-rule` with anti-ping-pong cooldowns (`RULE_COOLDOWN_TICKS = 8`), solo AI bot, and interactive SVG tactical console.  
* **Full Release Scope:** Procedural 16–24 node sector topologies, `@colyseus/database` SQLite/PostgreSQL match persistence and ELO/match history, multiple AI bot doctrines (`AGGRESSIVE_EXPANSION`, `TURTLE_CONDUIT`, `CORE_RUSHER`), alliance diplomacy pacts, and replay timeline scrubber.

---

## **2\. Functional Requirements**

* **FR-1 (Action Point Capacitor):** Every commander initializes with `tokens = 10` (`maxTokens = 10`). When `tokens < maxTokens`, `nextTokenProgressMs` increments each tick and grants `+1` token upon reaching `regenIntervalMs` (default `20000` ms).  
* **FR-2 (Sector Ownership & Resource Accrual):** Owned sectors (`ownerSessionId !== ""`) accrue `+oreYieldPerTick` garrison units every 1 Hz tick, capped at `500`.  
* **FR-3 (Manual Fleet Dispatch):** `dispatch-fleet` requires `tokens >= 1`, sector ownership, an adjacent transit lane (`origin.neighbors.includes(toSectorId)`), and `1 <= units < origin.garrison`. Deducts 1 APC token and spawns a `TransitFleet` whose transit duration scales with Euclidean node distance (`Math.max(5, Math.round(distance / 10))`). Shipments of `>= 10` units incur a 1-unit transit attrition tax.  
* **FR-4 (Sector Fortification):** `fortify-sector` costs 1 APC token, sets `sector.fortified = true`, and grants a `1.25x` defensive multiplier until the sector is captured.  
* **FR-5 (Automated Logistics Rules):** `upsert-rule` costs 1 APC token (max 8 rules per commander). Every tick, active rules whose cooldown (`RULE_COOLDOWN_TICKS = 8`) has elapsed and whose `source.garrison >= minThreshold` automatically dispatch `dispatchAmount` units free of APC cost.  
* **FR-6 (Combat Resolution):** Friendly arrivals reinforce `target.garrison` (capped at `500`). Hostile arrivals compare `fleet.units` against `Math.ceil(target.garrison * (target.fortified ? 1.25 : 1.0))`. Strictly exceeding defense transfers ownership, sets remaining garrison to `fleet.units - effectiveDefense`, and clears `fortified`.  
* **FR-7 (Disconnect Doctrine & Solo Bot):** Disconnected players enter a 300-second reconnection window (`allowReconnection`) while `executeFallbackDoctrines()` automatically fortifies vulnerable sectors. When `enableSoloBot: true` is passed on room creation, an AI commander spawns and competes for sectors.  
* **FR-8 (Victory Condition):** Controlling `>= 75%` of total map sectors transitions `state.phase` to `"VICTORY"` and records `winnerSessionId`.

---

## **3\. Non-Functional & Technical Requirements**

* **NFR-1 (Privacy via `StateView`):** `Commander.tokens`, `maxTokens`, `nextTokenProgressMs`, and `rules` MUST remain tagged `.view()` and attached only to the owning client's `StateView`.  
* **NFR-2 (Bandwidth Optimization):** Static sector topology (`sectorId`, `x`, `y`, `neighbors`) MUST use `.fullStateOnly()` so coordinates are sent only during the initial join handshake.  
* **NFR-3 (Schema Constraints):** Keep `LogisticsRule` (`7` fields) and `TransitFleet` (`7` fields) at or below 8 fields to preserve `@colyseus/schema` v5 zero-allocation change tracking.

---

## **4\. Existing File Manifest (`01 - Slow Burn Frontier`)**

1. `FrontierState.ts` \-\> Place at `src/rooms/schema/FrontierState.ts`  
2. `FrontierRoom.ts` \-\> Place at `src/rooms/FrontierRoom.ts`  
3. `FrontierClient.ts` \-\> Place at `src/client/FrontierClient.ts`  
4. `FrontierRenderer.ts` \-\> Place at `src/client/FrontierRenderer.ts`  
5. `index.html` \-\> Place at `src/client/index.html`  
6. `frontier-ui.css` \-\> Place at `src/client/frontier-ui.css`  
7. `FrontierRoom.test.ts` \-\> Place at `test/FrontierRoom.test.ts`  
8. `Slow Burn Frontier - Design & Colyseus 0.18 Architecture` \-\> Reference architecture notes

---

## **5\. Phased Implementation Roadmap & Acceptance Criteria**

* **Phase 1: Core Loop & Test Verification (Complete)**  
  - *Acceptance Criteria:* `FrontierRoom.test.ts` passes all assertions for APC deduction, `StateView` token privacy, fortification, transit attrition, and 8-tick logistics cooldowns.  
* **Phase 2: Procedural Map Generator & Expanded Bot AI (Next)**  
  - *Tasks:* Replace fixed 12-node ring generator with a seeded planar graph generator (`16` to `24` nodes using Delaunay/Gabriel edge pruning so lanes never cross); upgrade `executeFallbackDoctrines()` so bots also program logistics conduits and launch offensive attacks when garrison exceeds `60`.  
  - *Acceptance Criteria:* Two rooms created with the same `seed` produce identical graphs; a solo player can play a complete 10-minute match against an offensive AI bot to `VICTORY`.  
* **Phase 3: Persistence & Match History (`@colyseus/database`)**  
  - *Tasks:* Add a Drizzle ORM `frontier_matches` table persisting completed match results, winner faction, tick duration, and replay snapshots.  
  - *Acceptance Criteria:* Completed games write a persistent record to SQLite without blocking the 1 Hz simulation step.  
* **Phase 4: Frontend Polish & Smooth Fleet Interpolation**  
  - *Tasks:* Refactor `FrontierRenderer.ts` to diff SVG elements by ID rather than clearing `innerHTML`, add smooth `requestAnimationFrame` sub-tick fleet interpolation, and add rule deletion/toggling UI.

---

## **6\. Fresh-Start Coding Agent Prompt**

> "You are working on **Slow Burn Frontier**, a Colyseus 0.18 (`@colyseus/schema` v5) orbital logistics strategy game. First, inspect `FrontierState.ts`, `FrontierRoom.ts`, `FrontierClient.ts`, `FrontierRenderer.ts`, and `FrontierRoom.test.ts`, and run `npm test` to confirm the baseline test suite passes. Follow Colyseus 0.18 conventions strictly (`schema({...}, 'Name')`, `Callbacks.get(room)`, `messages` with `ctx.reject()`). Your next milestone is Phase 2 & 4: (1) upgrade `FrontierRoom.ts` with a seeded 18-node non-crossing planar graph generator and an offensive AI bot doctrine that programs logistics rules and dispatches attacks, (2) add unit tests in `FrontierRoom.test.ts` covering victory resolution and AI bot offensive actions, and (3) optimize `FrontierRenderer.ts` to diff SVG nodes smoothly at 60 FPS."