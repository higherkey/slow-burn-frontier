import type { FrontierState, SectorNode, TransitFleet } from "../rooms/schema/FrontierState.js";

export type SectorSelectCallback = (sectorId: string) => void;

export class FrontierRenderer {
  private svg: SVGSVGElement;
  private lanesGroup: SVGGElement;
  private sectorsGroup: SVGGElement;
  private fleetsGroup: SVGGElement;

  private laneElements = new Map<string, SVGLineElement>();
  private sectorElements = new Map<string, SVGGElement>();
  private fleetElements = new Map<string, SVGGElement>();

  private selectedOriginSectorId: string | null = null;
  private selectedTargetSectorId: string | null = null;
  private onSectorSelectCb: SectorSelectCallback | null = null;

  private lastTickTime = performance.now();
  private lastTickNumber = 0;
  private animFrameId: number | null = null;
  private currentState: FrontierState | null = null;
  private mySessionId: string = "";

  constructor(svgElement: SVGSVGElement) {
    this.svg = svgElement;

    // Create layered groups in SVG
    this.lanesGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.lanesGroup.setAttribute("class", "lanes-layer");

    this.sectorsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.sectorsGroup.setAttribute("class", "sectors-layer");

    this.fleetsGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.fleetsGroup.setAttribute("class", "fleets-layer");

    this.svg.appendChild(this.lanesGroup);
    this.svg.appendChild(this.sectorsGroup);
    this.svg.appendChild(this.fleetsGroup);

    this.startInterpolationLoop();
  }

  public setMySessionId(sessionId: string): void {
    this.mySessionId = sessionId;
  }

  public onSectorSelect(cb: SectorSelectCallback): void {
    this.onSectorSelectCb = cb;
  }

  public setSelectedSectors(originId: string | null, targetId: string | null): void {
    this.selectedOriginSectorId = originId;
    this.selectedTargetSectorId = targetId;
    this.updateSectorSelections();
  }

  public updateState(state: FrontierState): void {
    this.currentState = state;

    if (state.currentTick !== this.lastTickNumber) {
      this.lastTickNumber = state.currentTick;
      this.lastTickTime = performance.now();
    }

    this.renderLanes(state);
    this.renderSectors(state);
    this.updateSectorSelections();
  }

  private renderLanes(state: FrontierState): void {
    const renderedKeys = new Set<string>();

    state.sectors.forEach((sector, id) => {
      sector.neighbors.forEach((neighborId: string) => {
        const neighbor = state.sectors.get(neighborId);
        if (!neighbor) return;

        const laneKey = id < neighborId ? `${id}-${neighborId}` : `${neighborId}-${id}`;
        renderedKeys.add(laneKey);

        let line = this.laneElements.get(laneKey);
        if (!line) {
          line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("id", `lane-${laneKey}`);
          line.setAttribute("class", "orbital-lane");
          line.setAttribute("x1", sector.x.toString());
          line.setAttribute("y1", sector.y.toString());
          line.setAttribute("x2", neighbor.x.toString());
          line.setAttribute("y2", neighbor.y.toString());
          this.lanesGroup.appendChild(line);
          this.laneElements.set(laneKey, line);
        }

        // Highlight lane if between selected origin and target
        const isSelectedLane =
          (this.selectedOriginSectorId === id && this.selectedTargetSectorId === neighborId) ||
          (this.selectedOriginSectorId === neighborId && this.selectedTargetSectorId === id);

        line.setAttribute(
          "class",
          isSelectedLane ? "orbital-lane orbital-lane-active" : "orbital-lane"
        );
      });
    });

    // Clean up removed lanes
    this.laneElements.forEach((el, key) => {
      if (!renderedKeys.has(key)) {
        el.remove();
        this.laneElements.delete(key);
      }
    });
  }

  private renderSectors(state: FrontierState): void {
    const renderedSectorIds = new Set<string>();

    state.sectors.forEach((sector, id) => {
      renderedSectorIds.add(id);

      let g = this.sectorElements.get(id);
      if (!g) {
        g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("id", `sector-node-${id}`);
        g.setAttribute("class", "sector-node");
        g.setAttribute("transform", `translate(${sector.x}, ${sector.y})`);

        // Wide touch target for mobile thumbs
        const touchHitbox = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        touchHitbox.setAttribute("class", "sector-touch-hitbox");
        touchHitbox.setAttribute("r", "38");
        touchHitbox.setAttribute("fill", "transparent");
        g.appendChild(touchHitbox);

        // Outer pulse circle
        const pulse = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        pulse.setAttribute("class", "sector-pulse");
        pulse.setAttribute("r", "28");
        g.appendChild(pulse);

        // Core base circle
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("class", "sector-core");
        circle.setAttribute("r", "22");
        g.appendChild(circle);

        // Fortification shield indicator
        const shield = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        shield.setAttribute("class", "sector-shield");
        shield.setAttribute("r", "26");
        g.appendChild(shield);

        // Garrison counter text
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("class", "sector-garrison");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dy", "5");
        g.appendChild(text);

        // Sector name label
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("class", "sector-label");
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dy", "38");
        label.textContent = id;
        g.appendChild(label);

        // Ore yield badge
        const yieldBadge = document.createElementNS("http://www.w3.org/2000/svg", "text");
        yieldBadge.setAttribute("class", "sector-yield");
        yieldBadge.setAttribute("text-anchor", "middle");
        yieldBadge.setAttribute("dy", "-28");
        g.appendChild(yieldBadge);

        g.addEventListener("click", () => {
          if (this.onSectorSelectCb) {
            this.onSectorSelectCb(id);
          }
        });

        this.sectorsGroup.appendChild(g);
        this.sectorElements.set(id, g);
      }

      // Update attributes surgically
      const isPlayerOwned = sector.ownerSessionId === this.mySessionId && this.mySessionId !== "";
      const isHostile = sector.ownerSessionId !== "" && !isPlayerOwned;
      const isNeutral = sector.ownerSessionId === "";

      let ownershipClass = "ownership-neutral";
      if (isPlayerOwned) ownershipClass = "ownership-player";
      else if (isHostile) ownershipClass = "ownership-hostile";

      const coreCircle = g.querySelector(".sector-core") as SVGCircleElement;
      coreCircle.setAttribute("class", `sector-core ${ownershipClass}`);

      const shieldCircle = g.querySelector(".sector-shield") as SVGCircleElement;
      shieldCircle.setAttribute("display", sector.fortified ? "block" : "none");

      const garrisonText = g.querySelector(".sector-garrison") as SVGTextElement;
      garrisonText.textContent = sector.garrison.toString();

      const yieldBadge = g.querySelector(".sector-yield") as SVGTextElement;
      yieldBadge.textContent = `+${sector.oreYieldPerTick}/s`;
    });

    // Remove defunct sectors
    this.sectorElements.forEach((el, id) => {
      if (!renderedSectorIds.has(id)) {
        el.remove();
        this.sectorElements.delete(id);
      }
    });
  }

  private updateSectorSelections(): void {
    this.sectorElements.forEach((g, id) => {
      const isOrigin = this.selectedOriginSectorId === id;
      const isTarget = this.selectedTargetSectorId === id;

      let cls = "sector-node";
      if (isOrigin) cls += " selected-origin";
      if (isTarget) cls += " selected-target";

      g.setAttribute("class", cls);
    });
  }

  private startInterpolationLoop(): void {
    const loop = () => {
      this.renderFleetsInterpolated();
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  private renderFleetsInterpolated(): void {
    if (!this.currentState) return;

    const now = performance.now();
    const subTickRatio = Math.min(1.0, (now - this.lastTickTime) / 1000);
    const currentTick = this.currentState.currentTick;
    const activeFleetIds = new Set<string>();

    this.currentState.fleets.forEach((fleet, fleetId) => {
      activeFleetIds.add(fleetId);

      const src = this.currentState!.sectors.get(fleet.fromSectorId);
      const dst = this.currentState!.sectors.get(fleet.toSectorId);
      if (!src || !dst) return;

      const totalTicks = Math.max(1, fleet.arrivalTick - fleet.departureTick);
      const elapsedTicks = currentTick - fleet.departureTick + subTickRatio;
      const progress = Math.min(1.0, Math.max(0.0, elapsedTicks / totalTicks));

      const x = src.x + (dst.x - src.x) * progress;
      const y = src.y + (dst.y - src.y) * progress;

      let g = this.fleetElements.get(fleetId);
      if (!g) {
        g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("id", `fleet-${fleetId}`);
        g.setAttribute("class", "fleet-marker");

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("r", "9");
        circle.setAttribute("class", "fleet-circle");
        g.appendChild(circle);

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("class", "fleet-units");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dy", "3");
        g.appendChild(text);

        this.fleetsGroup.appendChild(g);
        this.fleetElements.set(fleetId, g);
      }

      const isMyFleet = fleet.ownerSessionId === this.mySessionId;
      const circle = g.querySelector(".fleet-circle") as SVGCircleElement;
      circle.setAttribute("class", isMyFleet ? "fleet-circle fleet-player" : "fleet-circle fleet-hostile");

      const text = g.querySelector(".fleet-units") as SVGTextElement;
      text.textContent = fleet.units.toString();

      g.setAttribute("transform", `translate(${x.toFixed(1)}, ${y.toFixed(1)})`);
    });

    // Remove expired fleets
    this.fleetElements.forEach((el, id) => {
      if (!activeFleetIds.has(id)) {
        el.remove();
        this.fleetElements.delete(id);
      }
    });
  }

  public destroy(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
  }
}
