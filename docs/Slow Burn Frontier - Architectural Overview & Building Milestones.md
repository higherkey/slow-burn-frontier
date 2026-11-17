# Slow Burn Frontier — Architectural Overview & Building Milestones

**Folder:** `01 - Slow Burn Frontier`  
**Portfolio Rank:** #1 (Weighted Score: 90.0 / 100)  
**Target Mode:** 1-to-4 Player Blitz Tabletop Strategy (with Solo AI Bot Fallback)  
**Authoritative Framework:** Colyseus 0.18 (`@colyseus/schema` v5, `@colyseus/sdk` v0.18, `@colyseus/testing`)

---

## 1. Architectural & Gameplay Overview

### Core Gameplay Concept
**Slow Burn Frontier** is a deterministic, zero-micro orbital sector conquest and logistics strategy game designed for 1–4 players with solo AI bot fallback. It eliminates pay-to-win mechanics and high-APM unit micromanagement through two core systems:

* **Action Point Capacitor (APC):** Commanders start with a full capacitor of 10 tokens for an immediate strategic opening burst, followed by a continuous recharge of 1 token every 20 seconds (Blitz format) or 60 seconds (Standard format). Tokens are spent on manual fleet dispatches, sector fortification, or programming automated conduits.
* **Programmed Logistics Rules:** Players program conditional supply conduits (`upsert-rule`) that automatically shuttle garrison reinforcements along adjacent lanes free of APC cost whenever conditions are met (e.g., source garrison $\ge 30$, dispatching 15 units). A built-in anti-ping-pong cooldown (`cooldownTicksRemaining = 8` ticks) and 1-unit transit attrition prevent infinite zero-cost cycling.
* **Deterministic Warfare & Map Control:** Owned nodes generate resource units each tick (capped at 500). Fleet transit delay scales strictly with Euclidean node distance ($\max(5, \text{round}(\text{distance}/10))$). Defense benefits from a $1.25\times$ fortification multiplier, and controlling $\ge 75\%$ of total orbital sectors triggers match victory.
* **Offline Fallback Doctrine & Solo Play:** Disconnected players enter a 300-second reconnect window while the server runs automated fallback routines (`"HOLD_AND_FORTIFY"`). Rooms can launch with `enableSoloBot: true` to pit a solo player against an autonomous bot.

```
                    ┌───────────────────────────────┐
                    │      Colyseus 0.18 Server     │
                    │      FrontierRoom (1 Hz)      │
                    └───────┬───────────────┬───────┘
                            │               │
            Shared State    │               │  Per-Client Private
         (Topology, Fleets) │               │  StateView (APC Tokens,
                            ▼               ▼  Programmed Rules)
                    ┌──────────────┐ ┌──────────────┐
                    │ Client A     │ │ Client B     │
                    │ Tactical SVG │ │ Tactical SVG │
                    └──────────────┘ └──────────────┘
```

### Colyseus 0.18 Technical Architecture
* **`@colyseus/schema` v5 Builder API:** Uses explicit class builders `schema({ ... }, "ClassName")` with zero legacy TypeScript decorators:
  * **Bandwidth Optimization via `.fullStateOnly()`:** Static topology (`SectorNode.sectorId`, `x`, `y`, `neighbors`) is marked `.fullStateOnly()`, transmitting coordinates and connectivity only during initial handshake.
  * **Hidden State Privacy via `.view()`:** Commander APC tokens, regeneration progress, and secret logistics rules are tagged `.view()` and scoped strictly to the owning client's `StateView`.
  * **Zero-Allocation Change Tracking:** Leaf schemas (`LogisticsRule` and `TransitFleet`) are strictly bounded to 7 fields ($\le 8$ fields limit).
* **Authoritative Tick & Message Validation:** Powered by `setTimestep(1000)` running a deterministic 1 Hz simulation loop. Commands (`dispatch-fleet`, `fortify-sector`, `upsert-rule`) are validated in `messages` using `ctx.reject({ code })`.
* **Zero-Micro Frontend:** An interactive 2D SVG tactical console powered by `@colyseus/sdk` `Callbacks.get(room)` with node-diffing and sub-tick fleet position interpolation.

---

## 2. First Three Concrete Building Milestones

### Milestone 1: Server Core Loop, Schema & Headless Test Suite
* **Goal:** Establish the complete authoritative backend and verify all rules and state transitions headlessly with `@colyseus/testing`.
* **Deliverables:**
  1. **Schema Definitions (`src/rooms/schema/FrontierState.ts`):** Implement `LogisticsRule`, `Commander`, `SectorNode`, `TransitFleet`, and `FrontierState` conforming to `@colyseus/schema` v5 builders, `.view()`, and `.fullStateOnly()`.
  2. **Authoritative Room (`src/rooms/FrontierRoom.ts`):** 
     - Set up `setTimestep` at 1 Hz for garrison growth, fleet movement, combat resolution, and APC token regeneration.
     - Implement message handlers for `dispatch-fleet`, `fortify-sector`, and `upsert-rule` with validation and `ctx.reject()`.
     - Implement the 8-tick cooldown and attrition tax logic for automated conduits.
     - Implement fallback doctrine execution (`executeFallbackDoctrines()`) for disconnected commanders and solo bots.
  3. **Verification Suite (`test/FrontierRoom.test.ts`):**
     - Verify APC deduction and 20s regeneration intervals.
     - Verify `StateView` isolation (Player A cannot see Player B's capacitor or programmed rules).
     - Verify transit time scaling, combat resolution, fortification multipliers, and anti-ping-pong cooldown enforcement.

---

### Milestone 2: Procedural Planar Graph Generator & Expanded AI Bot
* **Goal:** Move beyond static 12-node layouts into dynamic, balanced orbital networks and enhance AI bot autonomy for full matches.
* **Deliverables:**
  1. **Seeded Planar Graph Generator (`src/shared/FrontierMapGenerator.ts`):**
     - Procedurally generate 16–24 sector topologies using seeded PRNG coordinates.
     - Apply Delaunay triangulation with Gabriel/RNG edge pruning to guarantee zero-crossing orbital lanes and balanced node degrees (2–4 connections per sector).
     - Ensure deterministic map generation given identical room seeds.
  2. **Tactical AI Bot Doctrine:**
     - Upgrade bot behaviors from passive fortification to active expansion: evaluate adjacent unfortified neutral/hostile sectors, program logistics conduits from high-yield core sectors, and launch strikes when sector garrison $> 60$.
  3. **End-to-End Match Verification:**
     - Implement and test the $\ge 75\%$ sector control victory condition (`state.phase = "GAME_OVER"`).
     - Add integration tests simulating complete automated matches against the bot to verify termination without infinite loops or deadlocks.

---

### Milestone 3: Interactive Tactical SVG Console & Client SDK Integration
* **Goal:** Deliver a playable, responsive browser frontend connecting to the authoritative Colyseus room.
* **Deliverables:**
  1. **Client Controller (`src/client/FrontierClient.ts`):**
     - Connect using `@colyseus/sdk` `Client`.
     - Bind state updates using `Callbacks.get(room)` (`callbacks.listen`, `callbacks.onAdd`, `callbacks.onRemove`).
     - Wrap user actions in `room.request()` / `room.send()` with graceful rejection handling.
  2. **SVG Tactical Renderer (`src/client/FrontierRenderer.ts`):**
     - Render orbital transit lanes, sector nodes, and ownership indicators using SVG.
     - Implement DOM/SVG element ID diffing to update elements without full `innerHTML` redraws.
     - Implement `requestAnimationFrame` sub-tick interpolation for transit fleets moving along lane vectors.
  3. **Diegetic Commander HUD (`src/client/index.html`, `src/client/frontier-ui.css`):**
     - Diegetic Action Point Capacitor ring gauge displaying available tokens and next-token recharge progress.
     - Interactive sector selection with manual fleet dispatch slider and fortification button.
     - Visual logistics rule management panel (viewing active conduits, target thresholds, and toggle/delete options).
