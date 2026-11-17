import { FrontierClient } from "./FrontierClient.js";
import { FrontierRenderer } from "./FrontierRenderer.js";
import { calculateDistance, calculateTransitDuration } from "../shared/FrontierSimulation.js";
import type { SectorNode, LogisticsRule } from "../rooms/schema/FrontierState.js";

// Initialize Client & Renderer
const svgElement = document.getElementById("map-svg") as unknown as SVGSVGElement;
const renderer = new FrontierRenderer(svgElement);
const client = new FrontierClient();

// UI Elements
const tickCounter = document.getElementById("tick-counter") as HTMLElement;
const controlRatio = document.getElementById("control-ratio") as HTMLElement;
const matchPhase = document.getElementById("match-phase") as HTMLElement;

const apcTokens = document.getElementById("apc-tokens") as HTMLElement;
const apcCircle = document.getElementById("apc-circle") as unknown as SVGCircleElement;

const labelOrigin = document.getElementById("label-origin") as HTMLElement;
const labelTarget = document.getElementById("label-target") as HTMLElement;
const labelTransitTime = document.getElementById("label-transit-time") as HTMLElement;

const sliderUnits = document.getElementById("slider-units") as HTMLInputElement;
const sliderUnitsVal = document.getElementById("slider-units-val") as HTMLElement;
const btnDispatch = document.getElementById("btn-dispatch") as HTMLButtonElement;
const btnFortify = document.getElementById("btn-fortify") as HTMLButtonElement;

const preset25 = document.getElementById("preset-25") as HTMLButtonElement;
const preset50 = document.getElementById("preset-50") as HTMLButtonElement;
const preset75 = document.getElementById("preset-75") as HTMLButtonElement;
const presetMax = document.getElementById("preset-max") as HTMLButtonElement;

// Mobile Tabs
const tabBtnFleet = document.getElementById("tab-btn-fleet") as HTMLButtonElement;
const tabBtnConduits = document.getElementById("tab-btn-conduits") as HTMLButtonElement;
const tabBtnLobby = document.getElementById("tab-btn-lobby") as HTMLButtonElement;

const panelFleet = document.getElementById("panel-fleet") as HTMLElement;
const panelConduits = document.getElementById("panel-conduits") as HTMLElement;
const panelLobby = document.getElementById("panel-lobby") as HTMLElement;

// Conduits UI
const rulesContainer = document.getElementById("rules-container") as HTMLElement;
const btnOpenRuleDialog = document.getElementById("btn-open-rule-dialog") as HTMLButtonElement;
const ruleDialog = document.getElementById("rule-dialog") as HTMLDialogElement;
const ruleForm = document.getElementById("rule-form") as HTMLFormElement;
const ruleSrcSelect = document.getElementById("rule-src") as HTMLSelectElement;
const ruleDstSelect = document.getElementById("rule-dst") as HTMLSelectElement;
const ruleThresholdInput = document.getElementById("rule-threshold") as HTMLInputElement;
const ruleAmountInput = document.getElementById("rule-amount") as HTMLInputElement;
const btnCancelRule = document.getElementById("btn-cancel-rule") as HTMLButtonElement;

const btnSoloBot = document.getElementById("btn-solo-bot") as HTMLButtonElement;
const btnPvpMatch = document.getElementById("btn-pvp-match") as HTMLButtonElement;
const gameOverBanner = document.getElementById("game-over-banner") as HTMLElement;
const gameOverTitle = document.getElementById("game-over-title") as HTMLElement;
const btnRestart = document.getElementById("btn-restart") as HTMLButtonElement;

// Selection State
let selectedOriginId: string | null = null;
let selectedTargetId: string | null = null;

// Tab Switching
function switchTab(tab: "fleet" | "conduits" | "lobby") {
  tabBtnFleet.classList.toggle("active", tab === "fleet");
  tabBtnFleet.setAttribute("aria-selected", (tab === "fleet").toString());
  panelFleet.hidden = tab !== "fleet";

  tabBtnConduits.classList.toggle("active", tab === "conduits");
  tabBtnConduits.setAttribute("aria-selected", (tab === "conduits").toString());
  panelConduits.hidden = tab !== "conduits";

  tabBtnLobby.classList.toggle("active", tab === "lobby");
  tabBtnLobby.setAttribute("aria-selected", (tab === "lobby").toString());
  panelLobby.hidden = tab !== "lobby";
}

tabBtnFleet.addEventListener("click", () => switchTab("fleet"));
tabBtnConduits.addEventListener("click", () => switchTab("conduits"));
tabBtnLobby.addEventListener("click", () => switchTab("lobby"));

// Connect to match
async function startSession(soloBot: boolean) {
  try {
    const room = await client.joinMatch({
      enableSoloBot: soloBot,
      factionName: soloBot ? "Orbital Command" : "Command Operative",
    });

    renderer.setMySessionId(room.sessionId);
    gameOverBanner.classList.remove("visible");

    client.onStateChange(() => {
      updateUI();
    });

    updateUI();
  } catch (err) {
    console.error("Match connection failed:", err);
  }
}

// Update all UI components on state ticks
function updateUI() {
  if (!client.room) return;
  const state = client.room.state;
  renderer.updateState(state);

  const mySessionId = client.room.sessionId;
  const myCommander = client.getMyCommander();

  // 1. Tick & Phase
  tickCounter.textContent = state.currentTick.toString();
  matchPhase.textContent = state.phase;

  // 2. Sector Control Ratio
  let mySectors = 0;
  const totalSectors = state.sectors.size;
  state.sectors.forEach((s: SectorNode) => {
    if (s.ownerSessionId === mySessionId) mySectors++;
  });
  const ratio = totalSectors > 0 ? Math.round((mySectors / totalSectors) * 100) : 0;
  controlRatio.textContent = `${ratio}% (${mySectors}/${totalSectors})`;

  // 3. Action Point Capacitor Gauge
  if (myCommander) {
    apcTokens.textContent = myCommander.tokens.toString();
    const circumference = 113.1; // 2 * PI * 18

    if (myCommander.tokens < myCommander.maxTokens) {
      const progress = myCommander.nextTokenProgressMs / state.regenIntervalMs;
      const offset = circumference * (1 - progress);
      apcCircle.setAttribute("stroke-dashoffset", offset.toFixed(1));
    } else {
      apcCircle.setAttribute("stroke-dashoffset", "0");
    }

    // Update rules panel
    renderRules(myCommander.rules);
  }

  // 4. Update Selection Controls
  updateSelectionPanel();

  // 5. Game Over Banner
  if (state.phase === "GAME_OVER") {
    gameOverBanner.classList.add("visible");
    const won = state.winnerSessionId === mySessionId;
    gameOverTitle.textContent = won ? "VICTORY — SECTOR HEGEMONY" : "DEFEAT — ORBITAL FLEET LOST";
    gameOverTitle.className = won ? "game-over-title victory-title" : "game-over-title defeat-title";
  }
}

function updateSelectionPanel() {
  if (!client.room) return;
  const state = client.room.state;
  const mySessionId = client.room.sessionId;
  const myCommander = client.getMyCommander();
  const hasTokens = myCommander ? myCommander.tokens >= 1 : false;

  const originSector = selectedOriginId ? state.sectors.get(selectedOriginId) : null;
  const targetSector = selectedTargetId ? state.sectors.get(selectedTargetId) : null;

  labelOrigin.textContent = selectedOriginId ? `${selectedOriginId} (${originSector?.garrison}u)` : "Select Node";
  labelTarget.textContent = selectedTargetId ? `${selectedTargetId} (${targetSector?.garrison}u)` : "Tap Adjacent";

  // Fortify button state
  if (originSector && originSector.ownerSessionId === mySessionId && !originSector.fortified && hasTokens) {
    btnFortify.disabled = false;
  } else {
    btnFortify.disabled = true;
  }

  // Target and dispatch state
  if (originSector && targetSector && originSector.ownerSessionId === mySessionId) {
    const isAdjacent = originSector.neighbors.some((n: string) => n === selectedTargetId);
    if (isAdjacent && originSector.garrison > 1) {
      const dist = calculateDistance(originSector.x, originSector.y, targetSector.x, targetSector.y);
      const transitTicks = calculateTransitDuration(dist);
      labelTransitTime.textContent = `${transitTicks} cycles (~${transitTicks}s)`;

      const maxUnits = originSector.garrison - 1;
      sliderUnits.min = "1";
      sliderUnits.max = maxUnits.toString();
      sliderUnits.disabled = false;

      preset25.disabled = false;
      preset50.disabled = false;
      preset75.disabled = false;
      presetMax.disabled = false;

      if (parseInt(sliderUnits.value) > maxUnits) {
        sliderUnits.value = maxUnits.toString();
      }
      sliderUnitsVal.textContent = sliderUnits.value;
      btnDispatch.disabled = !hasTokens;
      return;
    }
  }

  labelTransitTime.textContent = "--";
  sliderUnits.disabled = true;
  sliderUnits.value = "1";
  sliderUnitsVal.textContent = "0";
  btnDispatch.disabled = true;

  preset25.disabled = true;
  preset50.disabled = true;
  preset75.disabled = true;
  presetMax.disabled = true;
}

// Map Sector Selection Handler (auto-switches to fleet command tab)
renderer.onSectorSelect((sectorId: string) => {
  if (!client.room) return;
  const state = client.room.state;
  const mySessionId = client.room.sessionId;
  const clickedSector = state.sectors.get(sectorId);
  if (!clickedSector) return;

  if (clickedSector.ownerSessionId === mySessionId) {
    selectedOriginId = sectorId;
    selectedTargetId = null;
    switchTab("fleet");
  } else if (selectedOriginId) {
    const origin = state.sectors.get(selectedOriginId);
    if (origin && origin.neighbors.some((n: string) => n === sectorId)) {
      selectedTargetId = sectorId;
      switchTab("fleet");
    }
  }

  renderer.setSelectedSectors(selectedOriginId, selectedTargetId);
  updateSelectionPanel();
});

// Slider & Preset Listeners
sliderUnits.addEventListener("input", () => {
  sliderUnitsVal.textContent = sliderUnits.value;
});

function applyPreset(ratio: number) {
  if (!client.room || !selectedOriginId) return;
  const origin = client.room.state.sectors.get(selectedOriginId);
  if (!origin || origin.garrison <= 1) return;
  const maxUnits = origin.garrison - 1;
  const units = Math.max(1, Math.round(maxUnits * ratio));
  sliderUnits.value = units.toString();
  sliderUnitsVal.textContent = units.toString();
}

preset25.addEventListener("click", () => applyPreset(0.25));
preset50.addEventListener("click", () => applyPreset(0.50));
preset75.addEventListener("click", () => applyPreset(0.75));
presetMax.addEventListener("click", () => applyPreset(1.0));

// Dispatch Fleet Button
btnDispatch.addEventListener("click", async () => {
  if (!selectedOriginId || !selectedTargetId) return;
  const units = parseInt(sliderUnits.value);
  try {
    await client.dispatchFleet(selectedOriginId, selectedTargetId, units);
    selectedTargetId = null;
    renderer.setSelectedSectors(selectedOriginId, null);
    updateSelectionPanel();
  } catch (err) {
    console.error("Dispatch fleet error:", err);
  }
});

// Fortify Sector Button
btnFortify.addEventListener("click", async () => {
  if (!selectedOriginId) return;
  try {
    await client.fortifySector(selectedOriginId);
    updateSelectionPanel();
  } catch (err) {
    console.error("Fortify error:", err);
  }
});

// Render Programmed Logistics Conduits
function renderRules(rulesMap: Map<string, LogisticsRule>) {
  rulesContainer.innerHTML = "";

  if (!rulesMap || rulesMap.size === 0) {
    rulesContainer.innerHTML = '<div class="detail-label">No automated conduits active. Tap "+ New Rule" to program supply convoys.</div>';
    return;
  }

  rulesMap.forEach((rule, ruleId) => {
    const card = document.createElement("div");
    card.setAttribute("class", "rule-card");

    const header = document.createElement("div");
    header.setAttribute("class", "rule-header");

    const route = document.createElement("span");
    route.setAttribute("class", "rule-route");
    route.textContent = `${rule.sourceSectorId} → ${rule.targetSectorId}`;
    header.appendChild(route);

    const cooldown = document.createElement("span");
    const isCooling = rule.cooldownTicksRemaining > 0;
    cooldown.setAttribute("class", isCooling ? "rule-cooldown rule-cooldown-active" : "rule-cooldown");
    cooldown.textContent = isCooling ? `Cooldown: ${rule.cooldownTicksRemaining}s` : "READY";
    header.appendChild(cooldown);

    card.appendChild(header);

    const details = document.createElement("div");
    details.setAttribute("class", "rule-details");
    details.textContent = `Auto-dispatch ${rule.dispatchAmount} units when garrison ≥ ${rule.minThreshold}`;
    card.appendChild(details);

    const actions = document.createElement("div");
    actions.setAttribute("class", "rule-actions");

    const toggleBtn = document.createElement("button");
    toggleBtn.setAttribute("type", "button");
    toggleBtn.setAttribute("class", rule.active ? "btn-secondary btn-mini" : "btn-primary btn-mini");
    toggleBtn.textContent = rule.active ? "Pause" : "Resume";
    toggleBtn.addEventListener("click", () => client.toggleRule(ruleId));
    actions.appendChild(toggleBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.setAttribute("type", "button");
    deleteBtn.setAttribute("class", "btn-danger btn-mini");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => client.deleteRule(ruleId));
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    rulesContainer.appendChild(card);
  });
}

// Dialog: Add Logistics Rule
btnOpenRuleDialog.addEventListener("click", () => {
  if (!client.room) return;
  const state = client.room.state;
  const mySessionId = client.room.sessionId;

  ruleSrcSelect.innerHTML = "";
  ruleDstSelect.innerHTML = "";

  state.sectors.forEach((s: SectorNode) => {
    if (s.ownerSessionId === mySessionId) {
      const opt = document.createElement("option");
      opt.value = s.sectorId;
      opt.textContent = `${s.sectorId} (${s.garrison} units)`;
      ruleSrcSelect.appendChild(opt);
    }
  });

  const updateDestinations = () => {
    ruleDstSelect.innerHTML = "";
    const srcId = ruleSrcSelect.value;
    const src = state.sectors.get(srcId);
    if (src) {
      src.neighbors.forEach((nId: string) => {
        const dst = state.sectors.get(nId);
        if (dst && dst.ownerSessionId === mySessionId) {
          const opt = document.createElement("option");
          opt.value = dst.sectorId;
          opt.textContent = dst.sectorId;
          ruleDstSelect.appendChild(opt);
        }
      });
    }
  };

  ruleSrcSelect.addEventListener("change", updateDestinations);
  updateDestinations();
  ruleDialog.showModal();
});

btnCancelRule.addEventListener("click", () => {
  ruleDialog.close();
});

ruleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const source = ruleSrcSelect.value;
  const target = ruleDstSelect.value;
  const threshold = parseInt(ruleThresholdInput.value);
  const amount = parseInt(ruleAmountInput.value);

  if (source && target && threshold > amount && amount >= 1) {
    try {
      await client.upsertRule({
        sourceSectorId: source,
        targetSectorId: target,
        minThreshold: threshold,
        dispatchAmount: amount,
      });
      ruleDialog.close();
    } catch (err) {
      console.error("Failed to program rule:", err);
    }
  }
});

// Mode Buttons
btnSoloBot.addEventListener("click", () => startSession(true));
btnPvpMatch.addEventListener("click", () => startSession(false));
btnRestart.addEventListener("click", () => startSession(true));

// Auto-start solo bot match on initial load
startSession(true);
