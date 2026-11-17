export interface GeneratedSector {
  sectorId: string;
  x: number;
  y: number;
  neighbors: string[];
  ownerSessionId: string;
  garrison: number;
  oreYieldPerTick: number;
  fortified: boolean;
}

/**
 * Seeded pseudo-random number generator (Mulberry32).
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number | string = 12345) {
    if (typeof seed === "string") {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
      }
      this.state = h >>> 0;
    } else {
      this.state = Math.floor(seed) >>> 0;
    }
  }

  /**
   * Returns a float in [0, 1).
   */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns an integer in [min, max] inclusive.
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

/**
 * Generates the default 12-node POC orbital network (2 core nodes + 10 ring nodes).
 */
export function generateDefault12NodeMap(player1SessionId = "", player2SessionId = ""): Map<string, GeneratedSector> {
  const map = new Map<string, GeneratedSector>();

  // Center core coordinates
  const centerX = 400;
  const centerY = 300;
  const ringRadius = 210;

  // 2 high-yield core sectors
  map.set("core_alpha", {
    sectorId: "core_alpha",
    x: centerX - 60,
    y: centerY,
    neighbors: ["core_beta", "ring_0", "ring_1", "ring_8", "ring_9"],
    ownerSessionId: "",
    garrison: 30,
    oreYieldPerTick: 3,
    fortified: false,
  });

  map.set("core_beta", {
    sectorId: "core_beta",
    x: centerX + 60,
    y: centerY,
    neighbors: ["core_alpha", "ring_3", "ring_4", "ring_5", "ring_6"],
    ownerSessionId: "",
    garrison: 30,
    oreYieldPerTick: 3,
    fortified: false,
  });

  // 10 orbital ring sectors
  for (let i = 0; i < 10; i++) {
    const angle = (i * 2 * Math.PI) / 10 - Math.PI / 2;
    const x = Math.round(centerX + ringRadius * Math.cos(angle));
    const y = Math.round(centerY + ringRadius * Math.sin(angle));
    const sectorId = `ring_${i}`;

    const prevRing = `ring_${(i + 9) % 10}`;
    const nextRing = `ring_${(i + 1) % 10}`;
    const neighbors: string[] = [prevRing, nextRing];

    if (i === 0 || i === 1 || i === 8 || i === 9) {
      neighbors.push("core_alpha");
    }
    if (i === 3 || i === 4 || i === 5 || i === 6) {
      neighbors.push("core_beta");
    }

    let owner = "";
    let initialGarrison = 10;
    let yieldRate = 1;

    // Home sector assignments
    if (i === 0 && player1SessionId) {
      owner = player1SessionId;
      initialGarrison = 25;
      yieldRate = 2;
    } else if (i === 5 && player2SessionId) {
      owner = player2SessionId;
      initialGarrison = 25;
      yieldRate = 2;
    }

    map.set(sectorId, {
      sectorId,
      x,
      y,
      neighbors,
      ownerSessionId: owner,
      garrison: initialGarrison,
      oreYieldPerTick: yieldRate,
      fortified: false,
    });
  }

  return map;
}

/**
 * Procedurally generates a balanced, non-crossing planar graph (Gabriel Graph)
 * with 16 to 24 orbital sectors.
 */
export function generateProceduralPlanarMap(
  seed: number | string = 42,
  nodeCount = 18,
  player1SessionId = "",
  player2SessionId = ""
): Map<string, GeneratedSector> {
  const rng = new SeededRandom(seed);
  const count = Math.max(12, Math.min(24, nodeCount));
  const points: { id: string; x: number; y: number }[] = [];

  const width = 800;
  const height = 600;
  const margin = 80;
  const minDistance = 90;

  // Rejection sampling for well-spaced sector coordinates
  let attempts = 0;
  while (points.length < count && attempts < 2000) {
    attempts++;
    const x = rng.nextInt(margin, width - margin);
    const y = rng.nextInt(margin, height - margin);

    const tooClose = points.some((p) => Math.hypot(p.x - x, p.y - y) < minDistance);
    if (!tooClose) {
      points.push({
        id: `sector_${points.length}`,
        x,
        y,
      });
    }
  }

  // Build adjacency list for Gabriel Graph
  const adjacency = new Map<string, Set<string>>();
  for (const p of points) {
    adjacency.set(p.id, new Set<string>());
  }

  // Gabriel Graph edge pruning:
  // Edge (A, B) exists iff the circle with diameter AB contains no other node C
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const radiusSq = (Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)) / 4;

      let emptyCircle = true;
      for (let k = 0; k < points.length; k++) {
        if (k === i || k === j) continue;
        const c = points[k];
        const distToMidSq = Math.pow(c.x - midX, 2) + Math.pow(c.y - midY, 2);
        if (distToMidSq < radiusSq - 0.001) {
          emptyCircle = false;
          break;
        }
      }

      if (emptyCircle) {
        adjacency.get(a.id)!.add(b.id);
        adjacency.get(b.id)!.add(a.id);
      }
    }
  }

  // Ensure connectivity using BFS and bridge isolated components with nearest non-crossing edge
  const visited = new Set<string>();
  const queue = [points[0].id];
  visited.add(points[0].id);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const neighbor of adjacency.get(curr)!) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // If disconnected components exist, connect closest pairs
  if (visited.size < points.length) {
    for (const p of points) {
      if (!visited.has(p.id)) {
        let bestTarget: string | null = null;
        let minDist = Infinity;
        for (const vId of visited) {
          const vPoint = points.find((pt) => pt.id === vId)!;
          const dist = Math.hypot(p.x - vPoint.x, p.y - vPoint.y);
          if (dist < minDist) {
            minDist = dist;
            bestTarget = vId;
          }
        }
        if (bestTarget) {
          adjacency.get(p.id)!.add(bestTarget);
          adjacency.get(bestTarget)!.add(p.id);
          visited.add(p.id);
        }
      }
    }
  }

  // Find two sectors with maximum spatial separation for fair home starting sectors
  let maxDist = -1;
  let home1 = points[0].id;
  let home2 = points[1].id;

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (d > maxDist) {
        maxDist = d;
        home1 = points[i].id;
        home2 = points[j].id;
      }
    }
  }

  // Assemble sector map
  const resultMap = new Map<string, GeneratedSector>();
  for (const p of points) {
    let owner = "";
    let garrison = rng.nextInt(10, 20);
    let oreYield = 1;

    if (p.id === home1 && player1SessionId) {
      owner = player1SessionId;
      garrison = 25;
      oreYield = 2;
    } else if (p.id === home2 && player2SessionId) {
      owner = player2SessionId;
      garrison = 25;
      oreYield = 2;
    } else {
      // Core-distance yield distribution: nodes closer to center have higher yield
      const distFromCenter = Math.hypot(p.x - 400, p.y - 300);
      if (distFromCenter < 140) {
        oreYield = 3;
        garrison = 30;
      } else if (distFromCenter < 220) {
        oreYield = 2;
      }
    }

    resultMap.set(p.id, {
      sectorId: p.id,
      x: p.x,
      y: p.y,
      neighbors: Array.from(adjacency.get(p.id)!).sort(),
      ownerSessionId: owner,
      garrison,
      oreYieldPerTick: oreYield,
      fortified: false,
    });
  }

  return resultMap;
}
