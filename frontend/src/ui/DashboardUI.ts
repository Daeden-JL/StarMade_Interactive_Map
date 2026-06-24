import { GalaxyEntity, GalaxyRenderer, RenderMode } from '../renderer/GalaxyRenderer.ts';
import { getCookie, setCookie, deleteCookie } from '../util/cookies.ts';

// Cookie keys for persisting UI state across page reloads.
const COOKIE_SELECTED = 'sm_selected_object';
const COOKIE_RENDER_MODE = 'sm_render_mode';

export class DashboardUI {
  private container: HTMLElement;
  private renderer!: GalaxyRenderer;

  // Selected state
  private selectedEntity: GalaxyEntity | null = null;

  // Render-mode tier buttons (Generic / Gray / Color / Texture)
  private renderButtons: Array<{ id: string; mode: RenderMode }> = [
    { id: 'render-btn-generic', mode: 'GENERIC' },
    { id: 'render-btn-gray', mode: 'GRAY' },
    { id: 'render-btn-color', mode: 'COLOR' },
    { id: 'render-btn-texture', mode: 'TEXTURE' },
  ];

  // DOM Elements cache
  private elLeftList!: HTMLElement;
  // private elRightPanel!: HTMLElement;
  private elSearchInput!: HTMLInputElement;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderLayout();
    this.setupUIListeners();
  }

  public setRenderer(renderer: GalaxyRenderer) {
    this.renderer = renderer;
    this.restoreRenderMode();
  }

  private renderLayout() {
    this.container.innerHTML = `
      <div id="canvas-container"></div>
      
      <div id="hud-overlay">
        <!-- Header -->
        <header class="hud-panel hud-header">
          <div class="hud-title">
            <svg width="24" height="24" viewBox="0 0 24 24" class="pulse-primary"><path d="M12 1.5l2.95 7.03 7.6.62-5.78 4.96 1.78 7.39L12 17.6l-6.55 3.9 1.78-7.39L1.45 9.15l7.6-.62z" fill="#3aa0ff" stroke="#bfe6ff" stroke-width="0.5" stroke-linejoin="round"></path></svg>
            StarMade Interactive Galaxy Grid
          </div>
          <div style="display: flex; align-items: center; gap: 15px;">
            <div id="conn-status" class="faction-tag faction-neutral">DISCONNECTED</div>
          </div>
        </header>

        <!-- Left Sidebar: Search & Entity List -->
        <aside class="hud-panel hud-sidebar-left">
          <div class="search-container">
            <input type="text" id="hud-search" class="search-input" placeholder="Search systems, ships, players...">
          </div>
          <div style="font-family: var(--font-hud); font-size: 11px; color: var(--color-primary); border-bottom: 1px solid var(--color-glass-border); padding-bottom: 5px; margin-top: 5px;">
            ONLINE PLAYERS
          </div>
          <div id="hud-entity-list" class="entity-list-container">
            <div class="text-muted" style="padding: 10px;">No entities found. Waiting for server synchronization...</div>
          </div>
        </aside>

        <!-- Right Sidebar: Statistics & Info -->
        <aside class="hud-panel hud-sidebar-right" id="hud-stats-panel">
          <div style="display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100%; text-align: center;" id="stats-placeholder">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-dim)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 15px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            <div class="font-hud text-muted" style="font-size: 13px;">No Object Selected</div>
            <div class="text-dim" style="font-size: 11px; margin-top: 5px;">Click on any celestial body or vessel in space or search from the sidebar to inspect.</div>
          </div>
          
          <div id="stats-content" style="display: none; height: 100%; flex-direction: column; gap: 15px;">
            <!-- Rendered dynamically -->
          </div>
        </aside>

        <!-- Camera Controller Mode Indicators -->
        <div class="hud-panel hud-bottom-center">
          <div id="view-mode-badge" class="view-mode-badge galaxy" title="Press Spacebar to toggle">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>
            GALAXY VIEW
          </div>
          <div style="width: 1px; height: 20px; background: var(--color-glass-border); margin: 0 5px;"></div>
          <button id="cam-btn-fly" class="btn-hud active">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>
            Fly Mode
          </button>
          <button id="cam-btn-orbit" class="btn-hud">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"></circle><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line></svg>
            Orbit Focus
          </button>
          <div id="speed-indicator" style="display: flex; align-items: center; gap: 8px; font-family: var(--font-hud); font-size: 11px; border-left: 1px solid var(--color-glass-border); padding-left: 15px; margin-left: 5px;">
            <span>SPEED:</span>
            <span id="speed-value" style="color: var(--color-primary);">50 m/s</span>
          </div>

          <!-- Render Mode Selector: ship/station detail tier -->
          <div style="width: 1px; height: 20px; background: var(--color-glass-border); margin: 0 5px;"></div>
          <span style="font-family: var(--font-hud); font-size: 10px; color: var(--color-text-dim); letter-spacing: 1px;">RENDER</span>
          <button id="render-btn-generic" class="btn-hud" title="Procedural placeholder shape — lightest on the server">Generic</button>
          <button id="render-btn-gray" class="btn-hud" title="Real ship geometry, single flat color">Gray</button>
          <button id="render-btn-color" class="btn-hud active" title="Real ship geometry with per-block colors">Color</button>
          <button id="render-btn-texture" class="btn-hud" title="Real StarMade block textures (heaviest)">Texture</button>
        </div>
      </div>

      <!-- Tooltip -->
      <div id="hud-tooltip" class="hud-panel" style="display: none; position: absolute; pointer-events: none; z-index: 100; padding: 10px 15px; font-size: 11px; min-width: 180px;"></div>
    `;

    // Cache elements
    this.elLeftList = document.getElementById('hud-entity-list')!;
    // this.elRightPanel = document.getElementById('hud-stats-panel')!;
    this.elSearchInput = document.getElementById('hud-search') as HTMLInputElement;
  }

  private setupUIListeners() {
    // Search filter inputs
    this.elSearchInput.addEventListener('input', () => {
      this.populateEntitiesList();
    });

    // Camera Mode toggle buttons
    const btnFly = document.getElementById('cam-btn-fly')!;
    const btnOrbit = document.getElementById('cam-btn-orbit')!;

    btnFly.addEventListener('click', () => {
      this.renderer.setCameraMode('FLY');
      btnFly.classList.add('active');
      btnOrbit.classList.remove('active');
      document.getElementById('speed-indicator')!.style.display = 'flex';
    });

    btnOrbit.addEventListener('click', () => {
      this.renderer.setCameraMode('ORBIT');
      btnOrbit.classList.add('active');
      btnFly.classList.remove('active');
      document.getElementById('speed-indicator')!.style.display = 'none';
    });

    // Render-mode tier buttons (Generic / Gray / Color / Texture)
    for (const { id, mode } of this.renderButtons) {
      document.getElementById(id)!.addEventListener('click', () => {
        this.applyRenderMode(mode);
      });
    }
  }

  // Switch render tier, sync button highlight, and remember the choice in a cookie.
  private applyRenderMode(mode: RenderMode, persist = true) {
    this.renderer.setRenderMode(mode);
    this.renderButtons.forEach(rb => {
      document.getElementById(rb.id)!.classList.toggle('active', rb.mode === mode);
    });
    if (persist) setCookie(COOKIE_RENDER_MODE, mode);
  }

  // Re-apply the last render/texture tier saved in the cookie, if any.
  private restoreRenderMode() {
    const saved = getCookie(COOKIE_RENDER_MODE) as RenderMode | null;
    if (saved && this.renderButtons.some(rb => rb.mode === saved)) {
      this.applyRenderMode(saved, false);
    }
  }

  // Re-select the object stored in the cookie, once galaxy data has loaded.
  public restoreSelection() {
    const raw = getCookie(COOKIE_SELECTED);
    if (!raw) return;
    try {
      const sel = JSON.parse(raw);
      if (sel.kind === 'player' && typeof sel.name === 'string') {
        if (this.renderer.getPlayers().some(p => p.name === sel.name)) {
          this.renderer.selectPlayer(sel.name);
        }
      } else if (sel.kind === 'entity' && typeof sel.id === 'number') {
        if (this.renderer.getEntities().some(e => e.id === sel.id)) {
          this.renderer.selectEntity(sel.id);
        }
      }
    } catch {
      // Malformed cookie — drop it so we don't keep retrying a bad value.
      deleteCookie(COOKIE_SELECTED);
    }
  }

  // --- Dynamic State Populators ---

  public updateConnectionStatus(status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') {
    const statusTag = document.getElementById('conn-status')!;
    statusTag.className = 'faction-tag';
    statusTag.innerText = status;

    if (status === 'CONNECTED') {
      statusTag.classList.add('faction-ally');
    } else if (status === 'DISCONNECTED') {
      statusTag.classList.add('faction-pirate');
    } else {
      statusTag.classList.add('faction-neutral');
    }
  }

  public populateEntitiesList() {
    const query = this.elSearchInput.value.toLowerCase().trim();
    
    this.elLeftList.innerHTML = '';
    
    if (query === '') {
      // Default view: list online players
      const players = this.renderer.getPlayers();
      if (players.length === 0) {
        this.elLeftList.innerHTML = `<div class="text-muted" style="padding: 10px;">No online players.</div>`;
        return;
      }
      
      players.forEach(player => {
        this.renderPlayerItem(player);
      });
    } else {
      // Search view: filter players, systems (SUNs), player stations, and ships
      const players = this.renderer.getPlayers().filter(p => 
        p.name.toLowerCase().includes(query) || 
        `(${p.sector.x}, ${p.sector.y}, ${p.sector.z})`.includes(query)
      );
      
      const entities = this.renderer.getEntities().filter(e => 
        e.name.toLowerCase().includes(query) || 
        e.type.toLowerCase().includes(query) ||
        `(${e.sector.x}, ${e.sector.y}, ${e.sector.z})`.includes(query)
      );

      if (players.length === 0 && entities.length === 0) {
        this.elLeftList.innerHTML = `<div class="text-muted" style="padding: 10px;">No matching results.</div>`;
        return;
      }

      players.forEach(player => {
        this.renderPlayerItem(player);
      });

      entities.forEach(entity => {
        this.renderEntityItem(entity);
      });
    }
  }

  private renderPlayerItem(player: any) {
    const item = document.createElement('div');
    item.className = 'entity-list-item';
    if (this.selectedEntity && this.selectedEntity.name === player.name) {
      item.classList.add('selected');
    }

    let factionTag = `<span class="faction-tag faction-neutral">Neutral</span>`;
    if (player.factionId === -1) {
      factionTag = `<span class="faction-tag faction-pirate">Pirate</span>`;
    } else if (player.factionId > 0) {
      const color = this.renderer.getFactionColor(player.factionId);
      const fName = this.renderer.getFactionName(player.factionId);
      factionTag = `<span class="faction-tag" style="background: ${color}28; border: 1px solid ${color}; color: ${color}; text-shadow: 0 0 5px ${color}66;">${fName}</span>`;
    }

    item.innerHTML = `
      <div class="flex-col">
        <strong style="font-family: var(--font-hud); font-size: 12px;">${player.name}</strong>
        <span class="text-muted" style="font-size: 11px;">Sector (${player.sector.x}, ${player.sector.y}, ${player.sector.z})</span>
      </div>
      <div class="flex-col align-center gap-10" style="align-items: flex-end;">
        <span style="font-size: 10px; text-transform: uppercase; color: var(--color-primary); font-family: var(--font-hud);">PLAYER</span>
        ${factionTag}
      </div>
    `;

    item.addEventListener('click', () => {
      if (this.selectedEntity && this.selectedEntity.name === player.name) {
        this.renderer.selectPlayer(null);
      } else {
        this.renderer.selectPlayer(player.name);
      }
      this.populateEntitiesList();
    });

    this.elLeftList.appendChild(item);
  }

  private renderEntityItem(entity: GalaxyEntity) {
    const item = document.createElement('div');
    item.className = 'entity-list-item';
    if (this.selectedEntity && this.selectedEntity.id === entity.id) {
      item.classList.add('selected');
    }

    let factionTag = `<span class="faction-tag faction-neutral">Neutral</span>`;
    if (entity.factionId === -1) {
      factionTag = `<span class="faction-tag faction-pirate">Pirate</span>`;
    } else if (entity.factionId > 0) {
      const color = this.renderer.getFactionColor(entity.factionId);
      const fName = this.renderer.getFactionName(entity.factionId);
      factionTag = `<span class="faction-tag" style="background: ${color}28; border: 1px solid ${color}; color: ${color}; text-shadow: 0 0 5px ${color}66;">${fName}</span>`;
    }

    item.innerHTML = `
      <div class="flex-col">
        <strong style="font-family: var(--font-hud); font-size: 12px;">${entity.name}</strong>
        <span class="text-muted" style="font-size: 11px;">Sector (${entity.sector.x}, ${entity.sector.y}, ${entity.sector.z})</span>
      </div>
      <div class="flex-col align-center gap-10" style="align-items: flex-end;">
        <span style="font-size: 10px; text-transform: uppercase; color: var(--color-primary); font-family: var(--font-hud);">${entity.type}</span>
        ${factionTag}
      </div>
    `;

    item.addEventListener('click', () => {
      if (this.selectedEntity && this.selectedEntity.id === entity.id) {
        this.renderer.selectEntity(null);
      } else {
        this.renderer.selectEntity(entity.id);
      }
      this.populateEntitiesList();
    });

    this.elLeftList.appendChild(item);
  }

  public showEntityInfo(entity: GalaxyEntity | null) {
    this.selectedEntity = entity;

    // Persist the current selection so it can be restored on the next page load.
    // Player markers arrive as a pseudo-entity with id -999 (keyed by name).
    if (entity) {
      const sel = entity.id === -999
        ? { kind: 'player', name: entity.name }
        : { kind: 'entity', id: entity.id };
      setCookie(COOKIE_SELECTED, JSON.stringify(sel));
    } else {
      deleteCookie(COOKIE_SELECTED);
    }

    const placeholder = document.getElementById('stats-placeholder')!;
    const content = document.getElementById('stats-content')!;

    if (!entity) {
      placeholder.style.display = 'flex';
      content.style.display = 'none';
      return;
    }

    placeholder.style.display = 'none';
    content.style.display = 'flex';

    let factionName = 'Neutral / Unowned';
    let factionClass = 'faction-neutral';
    let factionStyle = '';
    if (entity.factionId === -1) {
      factionName = 'Pirates';
      factionClass = 'faction-pirate';
    } else if (entity.factionId > 0) {
      factionName = this.renderer.getFactionName(entity.factionId);
      const color = this.renderer.getFactionColor(entity.factionId);
      factionStyle = `style="background: ${color}28; border: 1px solid ${color}; color: ${color}; text-shadow: 0 0 5px ${color}66;"`;
      factionClass = '';
    }

    let extraStats = '';
    if (entity.minBounds && entity.maxBounds) {
      // Bounds are in segment (32-block) units; convert to blocks for display.
      const SEG = 32;
      const dx = (entity.maxBounds.x - entity.minBounds.x + 1) * SEG;
      const dy = (entity.maxBounds.y - entity.minBounds.y + 1) * SEG;
      const dz = (entity.maxBounds.z - entity.minBounds.z + 1) * SEG;
      extraStats = `
        <div class="justify-between" style="display:flex; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 5px 0;">
          <span class="text-muted">Dimensions:</span>
          <span>${dx}x${dy}x${dz} blocks</span>
        </div>
        <div class="justify-between" style="display:flex; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 5px 0;">
          <span class="text-muted">Grid Range:</span>
          <span>X:[${entity.minBounds.x * SEG}, ${entity.maxBounds.x * SEG + (SEG - 1)}]</span>
        </div>
      `;
    }

    content.innerHTML = `
      <div style="border-bottom: 1px solid var(--color-glass-border); padding-bottom: 10px;">
        <span class="faction-tag ${factionClass}" ${factionStyle} style="margin-bottom: 8px; display:inline-block;">${entity.type}</span>
        <h2 class="font-hud" style="font-size: 18px; color: var(--color-primary);">${entity.name}</h2>
      </div>
      
      <div class="flex-col gap-10" style="flex-grow: 1; font-size: 12px;">
        <div class="justify-between" style="display:flex; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 5px 0;">
          <span class="text-muted">Sector Vector:</span>
          <span>(${entity.sector.x}, ${entity.sector.y}, ${entity.sector.z})</span>
        </div>
        <div class="justify-between" style="display:flex; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 5px 0;">
          <span class="text-muted">Local coordinates:</span>
          <span>X: ${Math.round(entity.position.x)}, Y: ${Math.round(entity.position.y)}, Z: ${Math.round(entity.position.z)}</span>
        </div>
        <div class="justify-between" style="display:flex; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 5px 0;">
          <span class="text-muted">Faction Ownership:</span>
          <span>${factionName}</span>
        </div>
        ${extraStats}
      </div>

      <div style="display: flex; gap: 10px;">
        <button id="btn-focus-object" class="btn-hud" style="flex-grow: 1; justify-content: center;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>
          CAMERA LOCK
        </button>
      </div>
    `;

    document.getElementById('btn-focus-object')!.addEventListener('click', () => {
      // Focus orbit
      if (entity.id === -999) {
        this.renderer.selectPlayer(entity.name);
      } else {
        this.renderer.selectEntity(entity.id);
      }
      
      // Toggle the orbit button highlighted active
      document.getElementById('cam-btn-orbit')!.classList.add('active');
      document.getElementById('cam-btn-fly')!.classList.remove('active');
      document.getElementById('speed-indicator')!.style.display = 'none';
    });
  }

  public showTooltip(clientX: number, clientY: number, entity: GalaxyEntity) {
    const tooltip = document.getElementById('hud-tooltip')!;
    tooltip.style.display = 'block';
    
    // Position tooltip offset from cursor, keeping it inside screen bounds
    const offset = 15;
    let x = clientX + offset;
    let y = clientY + offset;
    
    const rect = tooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) {
      x = clientX - rect.width - offset;
    }
    if (y + rect.height > window.innerHeight) {
      y = clientY - rect.height - offset;
    }
    
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    
    let factionName = 'Neutral';
    let factionColor = '#888888';
    if (entity.factionId === -1) {
      factionName = 'Pirates';
      factionColor = '#ff2244';
    } else if (entity.factionId > 0) {
      factionName = this.renderer.getFactionName(entity.factionId);
      factionColor = this.renderer.getFactionColor(entity.factionId);
    }
    
    tooltip.innerHTML = `
      <div class="flex-col gap-10">
        <div style="border-bottom: 1px solid var(--color-glass-border); padding-bottom: 5px; font-weight: 800; color: var(--color-primary); font-family: var(--font-hud);">
          ${entity.name}
        </div>
        <div class="justify-between" style="display: flex; gap: 15px;">
          <span class="text-muted">Sector:</span>
          <span>(${entity.sector.x}, ${entity.sector.y}, ${entity.sector.z})</span>
        </div>
        <div class="justify-between" style="display: flex; gap: 15px;">
          <span class="text-muted">Local Coordinates:</span>
          <span>X: ${Math.round(entity.position.x)}, Y: ${Math.round(entity.position.y)}, Z: ${Math.round(entity.position.z)}</span>
        </div>
        <div class="justify-between" style="display: flex; gap: 15px;">
          <span class="text-muted">Faction:</span>
          <span style="color: ${factionColor}; font-weight: 600; text-shadow: 0 0 5px ${factionColor}44;">${factionName}</span>
        </div>
      </div>
    `;
  }

  public hideTooltip() {
    const tooltip = document.getElementById('hud-tooltip')!;
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }

  public updateViewMode(mode: 'GALAXY' | 'SECTOR') {
    const badge = document.getElementById('view-mode-badge');
    if (!badge) return;

    badge.className = 'view-mode-badge ' + (mode === 'GALAXY' ? 'galaxy' : 'sector');

    if (mode === 'GALAXY') {
      badge.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>
        GALAXY VIEW
      `;
    } else {
      badge.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="12" x2="21" y2="12"></line><line x1="12" y1="3" x2="12" y2="21"></line></svg>
        SECTOR VIEW
      `;
    }
  }

  public updateCameraModeButtons(mode: 'FLY' | 'ORBIT') {
    const btnFly = document.getElementById('cam-btn-fly');
    const btnOrbit = document.getElementById('cam-btn-orbit');
    const speedInd = document.getElementById('speed-indicator');
    if (btnFly && btnOrbit && speedInd) {
      if (mode === 'FLY') {
        btnFly.classList.add('active');
        btnOrbit.classList.remove('active');
        speedInd.style.display = 'flex';
      } else {
        btnOrbit.classList.add('active');
        btnFly.classList.remove('active');
        speedInd.style.display = 'none';
      }
    }
  }
}
