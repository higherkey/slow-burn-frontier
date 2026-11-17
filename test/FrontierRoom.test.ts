import { boot, ColyseusTestServer } from "@colyseus/testing";
import { expect } from "chai";
import appConfig from "../src/app.config.js";
import { FrontierRoom } from "../src/rooms/FrontierRoom.js";
import { TransitFleet } from "../src/rooms/schema/FrontierState.js";
import {
  generateProceduralPlanarMap,
  generateDefault12NodeMap,
} from "../src/shared/FrontierMapGenerator.js";
import {
  calculateEffectiveDefense,
  calculateDamageInflicted,
  calculateTransitDuration,
  calculateAttritionTax,
} from "../src/shared/FrontierSimulation.js";

describe("Slow Burn Frontier — Authoritative Suite", () => {
  let colyseus: ColyseusTestServer;

  before(async () => {
    const testPort = 2600 + Math.floor(Math.random() * 100);
    colyseus = await boot(appConfig, testPort);
  });

  after(async () => {
    await colyseus.shutdown();
  });

  afterEach(async () => {
    await colyseus.cleanup();
  });

  describe("Unit Simulation Formulas", () => {
    it("should compute transit duration scaling strictly with Euclidean distance", () => {
      expect(calculateTransitDuration(30)).to.equal(5); // max(5, round(30/10)) = 5
      expect(calculateTransitDuration(100)).to.equal(10); // round(100/10) = 10
      expect(calculateTransitDuration(254)).to.equal(25); // round(254/10) = 25
    });

    it("should compute attrition tax for shipments >= 10 units", () => {
      expect(calculateAttritionTax(5)).to.equal(0);
      expect(calculateAttritionTax(9)).to.equal(0);
      expect(calculateAttritionTax(10)).to.equal(1);
      expect(calculateAttritionTax(50)).to.equal(1);
    });

    it("should calculate effective defense with 1.25x fortification multiplier", () => {
      expect(calculateEffectiveDefense(10, false)).to.equal(10);
      expect(calculateEffectiveDefense(10, true)).to.equal(13); // ceil(10 * 1.25) = 13
      expect(calculateEffectiveDefense(25, true)).to.equal(32); // ceil(25 * 1.25) = 32
    });

    it("should calculate casualties inflicted on defense hold", () => {
      expect(calculateDamageInflicted(10, false)).to.equal(10);
      expect(calculateDamageInflicted(13, true)).to.equal(10); // floor(13 / 1.25) = 10
    });
  });

  describe("Room Gameplay & Netcode Integration", () => {
    it("NFR-1: StateView enforces commander token and rule privacy between rival players", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier");
      const client1 = await colyseus.connectTo(room, { factionName: "Player Alpha" });
      const client2 = await colyseus.connectTo(room, { factionName: "Player Beta" });
      await client1.waitForInitialState();
      await client2.waitForInitialState();

      // Client 1 can see their own tokens and maxTokens
      const c1Own = client1.state.commanders.get(client1.sessionId);
      expect(c1Own).to.not.be.undefined;
      expect(c1Own!.tokens).to.equal(10);
      expect(c1Own!.maxTokens).to.equal(10);

      // Client 2 can see their own tokens
      const c2Own = client2.state.commanders.get(client2.sessionId);
      expect(c2Own).to.not.be.undefined;
      expect(c2Own!.tokens).to.equal(10);

      // Check client1 view of client2's commander: tokens should NOT be synchronized to client1!
      const c1ViewOfC2 = client1.state.commanders.get(client2.sessionId);
      expect(c1ViewOfC2).to.not.be.undefined;
      expect(c1ViewOfC2!.factionName).to.equal("Player Beta");
      // Since tokens has .view() and was only added to client2's view, client1 receives no tokens/rules
      expect(c1ViewOfC2!.tokens).to.be.undefined;
      expect(c1ViewOfC2!.rules).to.be.undefined;
    });

    it("FR-1: Commander initializes with 10 APC tokens and recharges upon interval", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier", {
        regenIntervalMs: 2000,
      });
      const client1 = await colyseus.connectTo(room);
      await client1.waitForInitialState();

      const commander = room.state.commanders.get(client1.sessionId)!;
      expect(commander).to.not.be.undefined;
      expect(commander.tokens).to.equal(10);
      expect(commander.maxTokens).to.equal(10);

      // Drain tokens to 8
      commander.tokens = 8;
      commander.nextTokenProgressMs = 0;

      // 1st tick (+1000ms)
      room.stepSimulation();
      expect(commander.tokens).to.equal(8);
      expect(commander.nextTokenProgressMs).to.equal(1000);

      // 2nd tick (+1000ms = 2000ms >= regenIntervalMs)
      room.stepSimulation();
      expect(commander.tokens).to.equal(9);
      expect(commander.nextTokenProgressMs).to.equal(0);
    });

    it("FR-2: Owned sectors accrue resource garrison each tick up to 500 cap", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier");
      const client1 = await colyseus.connectTo(room);
      await client1.waitForInitialState();

      const homeSector = room.state.sectors.get("ring_0")!;
      expect(homeSector.ownerSessionId).to.equal(client1.sessionId);
      const initialGarrison = homeSector.garrison;

      room.stepSimulation();
      expect(homeSector.garrison).to.equal(initialGarrison + homeSector.oreYieldPerTick);

      // Test cap
      homeSector.garrison = 499;
      homeSector.oreYieldPerTick = 3;
      room.stepSimulation();
      expect(homeSector.garrison).to.equal(500);
    });

    it("FR-3: Manual fleet dispatch deducts APC token, applies attrition tax, and scales transit", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier");
      const client1 = await colyseus.connectTo(room);
      await client1.waitForInitialState();

      const commander = room.state.commanders.get(client1.sessionId)!;
      const homeSector = room.state.sectors.get("ring_0")!;
      homeSector.garrison = 30;

      const targetSectorId = homeSector.neighbors[0];
      const targetSector = room.state.sectors.get(targetSectorId)!;

      // Send dispatch
      await client1.send("dispatch-fleet", {
        fromSectorId: "ring_0",
        toSectorId: targetSectorId,
        units: 15,
      });

      // Allow message dispatch to process
      await room.waitForNextMessage();

      expect(commander.tokens).to.equal(9); // 10 - 1
      expect(homeSector.garrison).to.equal(15); // 30 - 15

      // Check fleet spawned
      expect(room.state.fleets.size).to.equal(1);
      const fleet = Array.from(room.state.fleets.values())[0];
      expect(fleet.ownerSessionId).to.equal(client1.sessionId);
      expect(fleet.fromSectorId).to.equal("ring_0");
      expect(fleet.toSectorId).to.equal(targetSectorId);
      expect(fleet.units).to.equal(14); // 15 - 1 attrition tax
      expect(fleet.arrivalTick).to.be.greaterThan(room.state.currentTick);
    });

    it("FR-4: Sector fortification deducts 1 token and sets fortified flag", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier");
      const client1 = await colyseus.connectTo(room);
      await client1.waitForInitialState();

      const commander = room.state.commanders.get(client1.sessionId)!;
      const homeSector = room.state.sectors.get("ring_0")!;
      expect(homeSector.fortified).to.be.false;

      await client1.send("fortify-sector", { sectorId: "ring_0" });
      await room.waitForNextMessage();

      expect(commander.tokens).to.equal(9);
      expect(homeSector.fortified).to.be.true;
    });

    it("FR-5: Automated logistics rules execute without APC cost and enforce 8-tick cooldown", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier");
      const client1 = await colyseus.connectTo(room);
      await client1.waitForInitialState();

      const commander = room.state.commanders.get(client1.sessionId)!;
      const srcSector = room.state.sectors.get("ring_0")!;
      const dstSectorId = srcSector.neighbors[0];
      const dstSector = room.state.sectors.get(dstSectorId)!;

      // Set player as owner of both sectors
      dstSector.ownerSessionId = client1.sessionId;
      srcSector.garrison = 40;

      // Upsert logistics rule
      await client1.send("upsert-rule", {
        sourceSectorId: "ring_0",
        targetSectorId: dstSectorId,
        minThreshold: 30,
        dispatchAmount: 15,
      });
      await room.waitForNextMessage();

      expect(commander.tokens).to.equal(9); // 1 token spent to program
      expect(commander.rules.size).to.equal(1);
      const rule = Array.from(commander.rules.values())[0];
      expect(rule.active).to.be.true;

      // Step simulation: condition met (garrison 40 >= 30), should dispatch convoy
      room.stepSimulation();

      // Check fleet created
      expect(room.state.fleets.size).to.equal(1);
      const fleet = Array.from(room.state.fleets.values())[0];
      expect(fleet.units).to.equal(14); // 15 - 1 fuel fee
      expect(commander.tokens).to.equal(9); // FREE of APC tokens!
      expect(srcSector.garrison).to.equal(40 - 15 + srcSector.oreYieldPerTick);
      expect(rule.cooldownTicksRemaining).to.equal(8); // Anti-ping-pong cooldown active!

      // Step simulation again: cooldown should decrement and NO second fleet should launch
      room.stepSimulation();
      expect(rule.cooldownTicksRemaining).to.equal(7);
      expect(room.state.fleets.size).to.equal(1); // Still only 1 fleet
    });

    it("FR-6: Deterministic combat resolves friendly reinforcement and hostile capture", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier");
      const client1 = await colyseus.connectTo(room);
      const client2 = await colyseus.connectTo(room);
      await client1.waitForInitialState();
      await client2.waitForInitialState();

      const target = room.state.sectors.get("ring_1")!;
      target.ownerSessionId = client2.sessionId;
      target.garrison = 20;
      target.fortified = true; // Effective defense = ceil(20 * 1.25) = 25

      // 1. Defending victory: attack with 15 units <= 25
      const weakFleet = new TransitFleet();
      weakFleet.fleetId = "f_weak";
      weakFleet.ownerSessionId = client1.sessionId;
      weakFleet.fromSectorId = "ring_0";
      weakFleet.toSectorId = "ring_1";
      weakFleet.units = 15;
      weakFleet.departureTick = 0;
      weakFleet.arrivalTick = 1;
      room.state.fleets.set("f_weak", weakFleet);

      room.stepSimulation(); // Ticks to 1, resolves fleet
      expect(target.ownerSessionId).to.equal(client2.sessionId); // Defense holds
      // Casualties = floor(15 / 1.25) = 12. Garrison = 20 - 12 + yield(1) = 9
      expect(target.garrison).to.equal(9);
      expect(target.fortified).to.be.true;

      // 2. Attacking victory: attack with 30 units > ceil(9 * 1.25 = 12)
      const strongFleet = new TransitFleet();
      strongFleet.fleetId = "f_strong";
      strongFleet.ownerSessionId = client1.sessionId;
      strongFleet.fromSectorId = "ring_0";
      strongFleet.toSectorId = "ring_1";
      strongFleet.units = 30;
      strongFleet.departureTick = 1;
      strongFleet.arrivalTick = 2;
      room.state.fleets.set("f_strong", strongFleet);

      room.stepSimulation(); // Ticks to 2, resolves fleet
      expect(target.ownerSessionId).to.equal(client1.sessionId); // Sector captured!
      expect(target.fortified).to.be.false; // Fortification cleared
      // Tick accrual makes garrison 9 + 1 = 10, effDefense = ceil(10 * 1.25) = 13. Remaining = 30 - 13 = 17
      expect(target.garrison).to.equal(17);
    });

    it("FR-7: Disconnected commander triggers HOLD_AND_FORTIFY fallback doctrine", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier");
      const client1 = await colyseus.connectTo(room);
      await client1.waitForInitialState();

      const commander = room.state.commanders.get(client1.sessionId)!;
      const homeSector = room.state.sectors.get("ring_0")!;
      expect(homeSector.fortified).to.be.false;

      // Simulate disconnect
      commander.connected = false;
      commander.tokens = 7; // >= 6

      room.stepSimulation();
      expect(homeSector.fortified).to.be.true;
      expect(commander.tokens).to.equal(6);
    });

    it("FR-7 & FR-8: Solo AI bot spawns and victory condition triggers at >= 75% sectors", async () => {
      const room = await colyseus.createRoom<FrontierRoom>("frontier", {
        enableSoloBot: true,
      });
      const client1 = await colyseus.connectTo(room);
      await client1.waitForInitialState();

      // Bot exists
      const bot = room.state.commanders.get("bot_commander");
      expect(bot).to.not.be.undefined;
      expect(bot?.factionName).to.include("AI");

      // Verify victory condition resolution
      expect(room.state.phase).to.equal("ACTIVE");

      // Give client1 ownership of >= 75% of sectors (12 * 0.75 = 9 sectors)
      let count = 0;
      for (const s of room.state.sectors.values()) {
        s.ownerSessionId = client1.sessionId;
        count++;
        if (count >= 9) break;
      }

      room.stepSimulation();
      expect(room.state.phase).to.equal("GAME_OVER");
      expect(room.state.winnerSessionId).to.equal(client1.sessionId);
    });
  });

  describe("Procedural Gabriel Planar Graph Generator", () => {
    it("should deterministically generate identical planar topologies with identical seeds", () => {
      const mapA = generateProceduralPlanarMap(777, 16);
      const mapB = generateProceduralPlanarMap(777, 16);

      expect(mapA.size).to.equal(mapB.size);
      mapA.forEach((sectorA, id) => {
        const sectorB = mapB.get(id);
        expect(sectorB).to.not.be.undefined;
        expect(sectorA.x).to.equal(sectorB!.x);
        expect(sectorA.y).to.equal(sectorB!.y);
        expect(sectorA.neighbors).to.deep.equal(sectorB!.neighbors);
      });
    });

    it("should guarantee planarity with zero crossing orbital transit lanes", () => {
      const map = generateProceduralPlanarMap(999, 18);
      const sectors = Array.from(map.values());

      // Helper: check if two line segments (p1-p2) and (p3-p4) intersect in their interiors
      function ccw(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }) {
        return (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
      }
      function segmentsIntersect(
        a1: { x: number; y: number },
        a2: { x: number; y: number },
        b1: { x: number; y: number },
        b2: { x: number; y: number }
      ) {
        // Shared endpoint is not an interior crossing
        if (
          (a1.x === b1.x && a1.y === b1.y) ||
          (a1.x === b2.x && a1.y === b2.y) ||
          (a2.x === b1.x && a2.y === b1.y) ||
          (a2.x === b2.x && a2.y === b2.y)
        ) {
          return false;
        }
        return (
          ccw(a1, b1, b2) !== ccw(a2, b1, b2) &&
          ccw(a1, a2, b1) !== ccw(a1, a2, b2)
        );
      }

      // Collect all undirected edges
      const edges: { a: string; b: string }[] = [];
      for (const s of sectors) {
        for (const n of s.neighbors) {
          if (s.sectorId < n) {
            edges.push({ a: s.sectorId, b: n });
          }
        }
      }

      // Check all edge pairs for intersection
      let crossingCount = 0;
      for (let i = 0; i < edges.length; i++) {
        for (let j = i + 1; j < edges.length; j++) {
          const e1 = edges[i];
          const e2 = edges[j];
          const a1 = map.get(e1.a)!;
          const a2 = map.get(e1.b)!;
          const b1 = map.get(e2.a)!;
          const b2 = map.get(e2.b)!;
          if (segmentsIntersect(a1, a2, b1, b2)) {
            crossingCount++;
          }
        }
      }

      expect(crossingCount).to.equal(0); // Zero edge crossings guaranteed by Gabriel pruning!
    });
  });
});
