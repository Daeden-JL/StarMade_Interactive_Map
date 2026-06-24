import { GalaxyRenderer } from './renderer/GalaxyRenderer.ts';
import { DashboardUI } from './ui/DashboardUI.ts';
import { WebSocketClient } from './api/WebSocketClient.ts';
import './index.css';

document.addEventListener('DOMContentLoaded', async () => {
  const rootApp = document.getElementById('app')!;

  // 1. Initialize Dashboard HUD UI (sets up the DOM layout)
  const ui = new DashboardUI(rootApp);

  // 2. Initialize Renderer inside the #canvas-container element
  const canvasContainer = document.getElementById('canvas-container')!;
  const renderer = new GalaxyRenderer(canvasContainer, (entity) => {
    ui.showEntityInfo(entity);
    ui.populateEntitiesList();
  });

  // Connect UI and Renderer
  ui.setRenderer(renderer);

  // Connect Hover Tooltip Callback
  renderer.setHoverCallback((entity, clientX, clientY) => {
    if (entity) {
      ui.showTooltip(clientX, clientY, entity);
    } else {
      ui.hideTooltip();
    }
  });

  // Connect View Mode toggle callback
  renderer.setViewModeCallback((mode) => {
    ui.updateViewMode(mode);
    ui.updateCameraModeButtons(renderer.getCameraMode());
  });

  // 3. Fetch faction names for display
  try {
    const factionResponse = await fetch('/api/factions');
    if (factionResponse.ok) {
      const factionData = await factionResponse.json();
      const factionMap = new Map<number, string>();
      if (factionData.factions) {
        for (const [id, name] of Object.entries(factionData.factions)) {
          factionMap.set(parseInt(id), name as string);
        }
      }
      renderer.setFactionNames(factionMap);
      console.log(`[Main] Loaded ${factionMap.size} faction names`);
    }
  } catch (e) {
    console.warn('[Main] Could not fetch faction names, using IDs:', e);
  }

  // 4. Load initial static galaxy environment data
  try {
    const response = await fetch('/api/galaxy');
    if (!response.ok) {
      throw new Error("HTTP server status " + response.status);
    }
    const data = await response.json();
    
    // Seed renderer lists (combining real database systems/stars and other entities)
    const combinedEntities = [...(data.systems || []), ...(data.entities || [])];
    renderer.updateGalaxyState(combinedEntities, data.players || []);
    
    // Draw left panel entity items
    ui.populateEntitiesList();
  } catch (e) {
    console.error("Failed to load initial galaxy state:", e);
    // Seed mock data for offline/standalone preview
    seedMockPreviewData(renderer, ui);
  }

  // Restore the last selected object from the cookie (now that entities exist)
  ui.restoreSelection();

  // 5. Initialize WebSocket Client for real-time telemetry (player & dynamic ship movements)
  const wsClient = new WebSocketClient(
    (update) => {
      // Message callback: update dynamic coordinate locations in the scene
      renderer.updateGalaxyState(update.entities || [], update.players || [], true);
    },
    (status) => {
      // Status callback: update connection tag on HUD header
      ui.updateConnectionStatus(status);
    }
  );

  // Connect to the WebSocket server
  wsClient.connect();
});

// Seed data fallback for standalone web testing (when the Java server is not running)
function seedMockPreviewData(renderer: GalaxyRenderer, ui: DashboardUI) {
  console.log("Seeding offline mock preview data...");
  
  const mockEntities = [
    {
      id: 100,
      name: "Alpha Centauri Sun",
      type: 'SUN' as const,
      sector: { x: 2, y: 2, z: 2 },
      position: { x: 0, y: 0, z: 0 },
      factionId: 0
    },
    {
      id: 101,
      name: "Tatooine Desert Planet",
      type: 'PLANET' as const,
      sector: { x: 2, y: 2, z: 2 },
      position: { x: 1200, y: 100, z: 800 },
      factionId: 0
    },
    {
      id: 102,
      name: "Hoth Ice Planet",
      type: 'PLANET' as const,
      sector: { x: 2, y: 2, z: 2 },
      position: { x: -2500, y: -300, z: -1500 },
      factionId: 0
    },
    {
      id: 201,
      name: "Omega Outpost Station",
      type: 'STATION' as const,
      sector: { x: 2, y: 2, z: 2 },
      position: { x: 1000, y: 150, z: 900 },
      factionId: 1001,
      minBounds: { x: -8, y: -4, z: -8 },
      maxBounds: { x: 8, y: 4, z: 8 }
    },
    {
      id: 202,
      name: "U.S.S. Discovery",
      type: 'SHIP' as const,
      sector: { x: 2, y: 2, z: 2 },
      position: { x: 200, y: 30, z: -150 },
      factionId: 1001,
      minBounds: { x: -6, y: -3, z: -12 },
      maxBounds: { x: 6, y: 3, z: 12 }
    },
    {
      id: 203,
      name: "Klingon Bird of Prey",
      type: 'SHIP' as const,
      sector: { x: 2, y: 2, z: 3 },
      position: { x: -450, y: 0, z: 120 },
      factionId: -1,
      minBounds: { x: -4, y: -2, z: -6 },
      maxBounds: { x: 4, y: 2, z: 6 }
    }
  ];

  const mockPlayers = [
    {
      name: "Commander_Dae",
      sector: { x: 2, y: 2, z: 2 },
      position: { x: 150, y: 50, z: -200 },
      factionId: 1001
    },
    {
      name: "Miner_Bob",
      sector: { x: 1, y: 2, z: 2 },
      position: { x: 0, y: -80, z: 50 },
      factionId: 1002
    }
  ];

  renderer.updateGalaxyState(mockEntities, mockPlayers);
  ui.populateEntitiesList();

  // Simulate periodic update jitter offline
  setInterval(() => {
    mockEntities.forEach(e => {
      if (e.type === 'SHIP') {
        e.position.x += (Math.random() - 0.5) * 5;
        e.position.z += (Math.random() - 0.5) * 5;
      }
    });

    mockPlayers.forEach(p => {
      p.position.x += (Math.random() - 0.5) * 3;
      p.position.z += (Math.random() - 0.5) * 3;
    });

    renderer.updateGalaxyState(mockEntities, mockPlayers, true);
  }, 500);
}
