
import { 
  Scene, 
  PerspectiveCamera, 
  WebGLRenderer, 
  AmbientLight, 
  DirectionalLight, 
  PointLight, 
  SphereGeometry, 
  MeshBasicMaterial, 
  MeshStandardMaterial,
  Mesh, 
  GridHelper, 
  Points, 
  Vector3, 
  Object3D,
  RingGeometry,
  DoubleSide,
  InstancedMesh,
  Raycaster,
  Vector2,
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Color,
  Material,
  Matrix4,
  Quaternion
} from 'three';
import { CameraController, CameraMode } from '../camera/CameraController.ts';
import { VoxelModelLoader, RenderMode } from './VoxelModelLoader.ts';

export type { RenderMode };

export type ViewMode = 'GALAXY' | 'SECTOR';

export interface StarProps {
  color: string;
  hexColor: string;
  brightness: number;
  radius: number;
}

export interface GalaxyEntity {
  id: number;
  name: string;
  type: 'SUN' | 'PLANET' | 'STATION' | 'SHIP';
  sector: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  factionId: number;
  minBounds?: { x: number; y: number; z: number };
  maxBounds?: { x: number; y: number; z: number };
  starProps?: StarProps;
  rotation?: number[]; // 3x3 world-orientation basis, row-major (loaded entities only)
}

export interface PlayerData {
  name: string;
  sector: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  factionId: number;
}

export class GalaxyRenderer {
  private container: HTMLElement;
  private scene!: Scene;
  private pointerStart = { x: 0, y: 0 };
  private camera!: PerspectiveCamera;
  private renderer!: WebGLRenderer;
  private cameraController!: CameraController;
  private isRunning = false;
  private lastTime = 0;

  // Scene Objects mapping
  private entityMeshes: Map<number, Object3D> = new Map();
  private entityVoxelMeshes: Map<number, InstancedMesh> = new Map();
  private entityVoxelLoading: Set<number> = new Set();
  private playerMeshes: Map<String, Object3D> = new Map();
  private sectorHighlights: Map<string, Object3D> = new Map();
  private playersData: Map<string, PlayerData> = new Map();
  private grid!: GridHelper;
  private starfield?: Points;

  // Positions/orientations to interpolate towards (from WebSocket)
  private targetPositions: Map<number, Vector3> = new Map();
  private entityTargetQuat: Map<number, Quaternion> = new Map();
  private playerTargetPositions: Map<String, Vector3> = new Map();

  // View mode: Galaxy (stars/factions prominent) vs Sector (nearby entities prominent)
  private _viewMode: ViewMode = 'GALAXY';
  private viewModeTransitionProgress = 1.0; // 0..1, 1 = fully transitioned
  private onViewModeChangeCallback: ((mode: ViewMode) => void) | null = null;

  // Ship/station render tier (see RenderMode). Default to full per-block color.
  private _renderMode: RenderMode = 'COLOR';

  // Faction name resolution
  private factionNames: Map<number, string> = new Map();

  // Selection state
  private selectedEntityId: number | null = null;
  private selectedPlayerName: string | null = null;
  private selectedSector: { x: number; y: number; z: number } = { x: 2, y: 2, z: 2 };

  // Callback to inform UI when selection change occurs
  private onSelectCallback: (entity: GalaxyEntity | null) => void;
  private onHoverCallback: ((entity: GalaxyEntity | null, clientX: number, clientY: number) => void) | null = null;
  private entitiesData: Map<number, GalaxyEntity> = new Map();

  constructor(container: HTMLElement, onSelect: (entity: GalaxyEntity | null) => void) {
    this.container = container;
    this.onSelectCallback = onSelect;
    
    this.initThree();
    this.createGrid();
    this.setupKeyboardListeners();
    this.animate(0);
  }

  private initThree() {
    this.scene = new Scene();
    
    this.camera = new PerspectiveCamera(
      60, 
      this.container.clientWidth / this.container.clientHeight, 
      1.0, 
      5000000
    );
    
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x04060c, 1);
    this.container.appendChild(this.renderer.domElement);

    // Setup Camera Controller
    this.cameraController = new CameraController(this.camera, this.renderer.domElement);

    // Lights
    const ambientLight = new AmbientLight(0xffffff, 0.15);
    this.scene.add(ambientLight);

    const dirLight = new DirectionalLight(0xffffff, 0.4);
    dirLight.position.set(100, 300, 100);
    this.scene.add(dirLight);

    // Handle pointer/click gestures to identify object selection in 3D
    this.renderer.domElement.addEventListener('mousedown', (e) => {
      this.pointerStart.x = e.clientX;
      this.pointerStart.y = e.clientY;
    });

    this.renderer.domElement.addEventListener('mouseup', (e) => {
      const deltaX = Math.abs(e.clientX - this.pointerStart.x);
      const deltaY = Math.abs(e.clientY - this.pointerStart.y);
      // Small threshold (3 pixels) to differentiate clicking from camera dragging
      if (deltaX < 3 && deltaY < 3) {
        this.handleCanvasClick(e);
      }
    });

    this.renderer.domElement.addEventListener('mousemove', (e) => {
      this.handlePointerMove(e);
    });

    // Handle Resize
    window.addEventListener('resize', this.onWindowResize.bind(this));
    this.isRunning = true;
  }

  /*
  private createStarfield() {
    // Generate a background particle nebula/starfield
    const starCount = 3000;
    const geometry = new BufferGeometry();
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      // Scatter stars in a large sphere
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 2000 + Math.random() * 2000; // Far distance

      positions[i * 3] = r * Math.sin(theta) * Math.sin(phi);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(theta) * Math.cos(phi);

      // Star colors: blue, white, purple/orange hints
      const rnd = Math.random();
      if (rnd < 0.3) {
        colors[i * 3] = 0.8; colors[i * 3 + 1] = 0.9; colors[i * 3 + 2] = 1.0; // Bluish
      } else if (rnd < 0.6) {
        colors[i * 3] = 1.0; colors[i * 3 + 1] = 1.0; colors[i * 3 + 2] = 1.0; // White
      } else if (rnd < 0.8) {
        colors[i * 3] = 1.0; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 0.6; // Orange tint
      } else {
        colors[i * 3] = 0.9; colors[i * 3 + 1] = 0.7; colors[i * 3 + 2] = 1.0; // Violet tint
      }
    }

    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));

    const material = new PointsMaterial({
      size: 3,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      sizeAttenuation: true
    });

    this.starfield = new Points(geometry, material);
    this.scene.add(this.starfield);
  }
  */

  private createGrid() {
    // Add grid lines representing the sector axes
    this.grid = new GridHelper(4000, 80, 0x00d2ff, 0x1f2e4d);
    this.grid.position.y = -500;
    this.grid.material.opacity = 0.2;
    this.grid.material.transparent = true;
    this.scene.add(this.grid);
  }

  private onWindowResize() {
    this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  // Transform Sector coordinates to WebGL world position coordinates
  // StarMade sectors are in integer space (e.g. 2, 2, 2). 
  // Let's space sectors by 4000 units on the map grid!
  public getAbsolutePosition(sector: {x:number, y:number, z:number}, localPos: {x:number, y:number, z:number}): Vector3 {
    const SECTOR_SIZE = 4000;
    // Base position around sector (2, 2, 2) which we treat as (0, 0, 0)
    const sx = (sector.x - 2) * SECTOR_SIZE;
    const sy = (sector.y - 2) * SECTOR_SIZE;
    const sz = (sector.z - 2) * SECTOR_SIZE;

    return new Vector3(
      sx + localPos.x,
      sy + localPos.y,
      sz + localPos.z
    );
  }

  // --- Dynamic Entity Updates ---

  public updateGalaxyState(entities: GalaxyEntity[], players: PlayerData[], isPartial = false) {
    if (!isPartial) {
      // 1. Scan/determine sector ownership (prioritizing STATION over SHIP etc.)
      const sectorOwnership = new Map<string, { factionId: number, sector: {x:number, y:number, z:number} }>();
      
      for (const entity of entities) {
        if (entity.factionId === 0) continue; // Skip neutral
        const key = `${entity.sector.x},${entity.sector.y},${entity.sector.z}`;
        
        const existing = sectorOwnership.get(key);
        if (!existing) {
          sectorOwnership.set(key, { factionId: entity.factionId, sector: entity.sector });
        } else {
          const existingEntity = entities.find(e => e.sector.x === entity.sector.x && e.sector.y === entity.sector.y && e.sector.z === entity.sector.z && e.factionId === existing.factionId);
          const existingType = existingEntity ? existingEntity.type : 'SHIP';
          
          if (entity.type === 'STATION' || (entity.type === 'SHIP' && existingType !== 'STATION')) {
            sectorOwnership.set(key, { factionId: entity.factionId, sector: entity.sector });
          }
        }
      }

      // 2. Create or update highlights
      for (const [key, owner] of sectorOwnership.entries()) {
        const existingHighlight = this.sectorHighlights.get(key);
        if (existingHighlight) {
          if (existingHighlight.userData.factionId !== owner.factionId) {
            this.scene.remove(existingHighlight);
            this.sectorHighlights.delete(key);
            this.createSectorHighlight(key, owner.sector, owner.factionId);
          }
        } else {
          this.createSectorHighlight(key, owner.sector, owner.factionId);
        }
      }

      // 3. Remove highlights for no longer owned sectors
      const keysToRemove: string[] = [];
      for (const key of this.sectorHighlights.keys()) {
        if (!sectorOwnership.has(key)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        const mesh = this.sectorHighlights.get(key);
        if (mesh) {
          this.scene.remove(mesh);
        }
        this.sectorHighlights.delete(key);
      }
    }

    // Update active entities list
    const currentEntityIds = new Set<number>();
    
    for (const entity of entities) {
      currentEntityIds.add(entity.id);
      
      const existing = this.entitiesData.get(entity.id);
      if (existing) {
        // Merge the incoming partial entity update with existing metadata
        this.entitiesData.set(entity.id, { ...existing, ...entity });
      } else {
        this.entitiesData.set(entity.id, entity);
      }
      
      const targetWorldPos = this.getAbsolutePosition(entity.sector, entity.position);
      this.targetPositions.set(entity.id, targetWorldPos);

      // Track the target orientation for live spin (loaded/cached entities only).
      const r = entity.rotation;
      if (r && r.length === 9) {
        const m = new Matrix4().set(
          r[0], r[1], r[2], 0,
          r[3], r[4], r[5], 0,
          r[6], r[7], r[8], 0,
          0, 0, 0, 1
        );
        this.entityTargetQuat.set(entity.id, new Quaternion().setFromRotationMatrix(m));
      }

      if (!this.entityMeshes.has(entity.id)) {
        // Create mesh marker representing the entity
        this.createEntityMarker(this.entitiesData.get(entity.id)!, targetWorldPos);
      }
    }

    // Clean up entities no longer on the server (skip for partial WebSocket updates)
    if (!isPartial) {
      for (const [id, mesh] of this.entityMeshes.entries()) {
        if (!currentEntityIds.has(id)) {
          this.scene.remove(mesh);
          this.entityMeshes.delete(id);
          this.targetPositions.delete(id);
          
          const voxelMesh = this.entityVoxelMeshes.get(id);
          if (voxelMesh) {
            this.scene.remove(voxelMesh);
            this.entityVoxelMeshes.delete(id);
          }
        }
      }
    }

    // Update active players list
    const currentPlayers = new Set<string>();
    for (const p of players) {
      currentPlayers.add(p.name);
      
      const existing = this.playersData.get(p.name);
      if (existing) {
        // Merge incoming partial player telemetry with existing metadata to preserve fields like factionId
        this.playersData.set(p.name, { ...existing, ...p });
      } else {
        this.playersData.set(p.name, p);
      }
      
      const targetWorldPos = this.getAbsolutePosition(p.sector, p.position);
      this.playerTargetPositions.set(p.name, targetWorldPos);

      if (!this.playerMeshes.has(p.name)) {
        this.createPlayerMarker(this.playersData.get(p.name)!, targetWorldPos);
      }
    }

    // Clean up disconnected players
    const playersToRemove: string[] = [];
    for (const name of this.playersData.keys()) {
      if (!currentPlayers.has(name as string)) {
        playersToRemove.push(name as string);
      }
    }
    for (const name of playersToRemove) {
      const mesh = this.playerMeshes.get(name);
      if (mesh) {
        this.scene.remove(mesh);
      }
      this.playerMeshes.delete(name);
      this.playerTargetPositions.delete(name);
      this.playersData.delete(name);
    }

    // Auto-center camera on load once active players/entities are available
    this.centerCameraOnActiveObjects();
  }

  // Setup initial marker geometry for distant visualization
  private createEntityMarker(entity: GalaxyEntity, position: Vector3) {
    const containerObj = new Object3D();
    containerObj.position.copy(position);

    let markerMesh: Mesh;
    
    if (entity.type === 'SUN') {
      // Glowing sphere using the star's real color, brightness and radius.
      const sp = entity.starProps;
      const radius = sp?.radius ?? 80;
      const brightness = sp?.brightness ?? 1.0;
      const starColor = new Color(sp?.hexColor ?? '#ffaa00');

      const geom = new SphereGeometry(radius, 16, 16);
      // Modulate the disk color by brightness so dimmer stars actually look dimmer.
      const mat = new MeshBasicMaterial({ color: starColor.clone().multiplyScalar(brightness) });
      markerMesh = new Mesh(geom, mat);

      // Light source radiating from the sun, tinted and scaled by the star's real values.
      const light = new PointLight(starColor, 2 * brightness, 2000);
      containerObj.add(light);
    } else if (entity.type === 'PLANET') {
      // Planet body with simple orbit ring
      const geom = new SphereGeometry(35, 16, 16);
      const mat = new MeshStandardMaterial({ color: 0x44aa99, roughness: 0.8 });
      markerMesh = new Mesh(geom, mat);
      
      // Draw rings
      const ringGeom = new RingGeometry(45, 60, 32);
      const ringMat = new MeshBasicMaterial({ color: 0x00d2ff, side: DoubleSide, transparent: true, opacity: 0.15 });
      const rings = new Mesh(ringGeom, ringMat);
      rings.rotation.x = Math.PI / 2;
      containerObj.add(rings);
    } else if (entity.type === 'STATION') {
      // Station representation
      const geom = new SphereGeometry(12, 8, 8);
      const mat = new MeshStandardMaterial({ color: 0xaa55ff, metalness: 0.9 });
      markerMesh = new Mesh(geom, mat);
    } else { // SHIP
      // Small octahedron representing ships
      const geom = new SphereGeometry(5, 4, 4);
      const mat = new MeshStandardMaterial({ color: 0xff2244, metalness: 0.5 });
      markerMesh = new Mesh(geom, mat);
    }

    containerObj.add(markerMesh);
    containerObj.userData = { id: entity.id, type: entity.type, name: entity.name, isMarker: true };
    
    this.scene.add(containerObj);
    this.entityMeshes.set(entity.id, containerObj);
  }

  private createPlayerMarker(player: PlayerData, position: Vector3) {
    const containerObj = new Object3D();
    containerObj.position.copy(position);

    // Glowing green small dot representing players
    const geom = new SphereGeometry(3, 8, 8);
    const mat = new MeshBasicMaterial({ color: 0x00ff88 });
    const mesh = new Mesh(geom, mat);

    containerObj.add(mesh);
    containerObj.userData = { name: player.name, isPlayer: true };

    this.scene.add(containerObj);
    this.playerMeshes.set(player.name, containerObj);
  }

  // --- Real-time Animation loop ---

  private animate(timestamp: number) {
    if (!this.isRunning) return;
    requestAnimationFrame(this.animate.bind(this));

    const deltaTime = Math.min((timestamp - this.lastTime) / 1000, 0.1);
    this.lastTime = timestamp;

    this.interpolatePositions(deltaTime);
    this.handleLevelOfDetail();
    this.updateViewModeOpacities(deltaTime);

    // Update camera controls
    this.cameraController.update(deltaTime);

    // Keep starfield centered around the camera so it is infinite
    if (this.starfield) {
      this.starfield.position.copy(this.camera.position);
    }

    // Keep grid centered under target focus or camera position
    if (this.grid) {
      if (this.cameraController.mode === 'ORBIT') {
        const target = this.cameraController.getTargetPosition();
        this.grid.position.x = target.x;
        this.grid.position.z = target.z;
        this.grid.position.y = target.y - 500;
      } else {
        this.grid.position.x = this.camera.position.x;
        this.grid.position.z = this.camera.position.z;
        this.grid.position.y = this.camera.position.y - 500;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  // Smoothly interpolate positions of players and ships from network
  private interpolatePositions(deltaTime: number) {
    const lerpFactor = 5.0 * deltaTime; // Smooth speed adjustment

    // Entities
    for (const [id, targetPos] of this.targetPositions.entries()) {
      const mesh = this.entityMeshes.get(id);
      if (mesh) {
        mesh.position.lerp(targetPos, lerpFactor);
        
        // Voxel meshes if loaded
        const voxelMesh = this.entityVoxelMeshes.get(id);
        if (voxelMesh) {
          voxelMesh.position.copy(mesh.position);
          // Smoothly spin toward the entity's live orientation.
          const tq = this.entityTargetQuat.get(id);
          if (tq) {
            voxelMesh.quaternion.slerp(tq, lerpFactor);
          }
        }
      }
    }

    // Players
    for (const [name, targetPos] of this.playerTargetPositions.entries()) {
      const mesh = this.playerMeshes.get(name);
      if (mesh) {
        mesh.position.lerp(targetPos, lerpFactor);
      }
    }
  }

  // Swaps simple markers with detailed voxel meshes based on camera distance (LoD)
  private handleLevelOfDetail() {
    const cameraPos = this.camera.position;
    const LOD_DISTANCE = 20000.0; // Large enough to trigger loading within several sectors

    for (const [id, mesh] of this.entityMeshes.entries()) {
      const entity = this.entitiesData.get(id);
      if (!entity || (entity.type !== 'SHIP' && entity.type !== 'STATION')) {
        continue; // Only voxel entities (ships and stations) get detailed voxel models
      }

      const distance = cameraPos.distanceTo(mesh.position);
      const voxelMesh = this.entityVoxelMeshes.get(id);

      if (distance < LOD_DISTANCE) {
        // We should show voxel model and hide standard marker sphere/octahedron
        if (voxelMesh) {
          voxelMesh.userData.inRange = true;
          // Hide marker child mesh
          mesh.children.forEach(c => {
            if ((c as Mesh).isMesh) c.visible = false;
          });
        } else if (!this.entityVoxelLoading.has(id)) {
          // Trigger loading
          this.entityVoxelLoading.add(id);
          this.loadVoxelModel(id, mesh, entity);
        }
      } else {
        // Beyond LoD distance: show marker, hide voxel mesh
        if (voxelMesh) {
          voxelMesh.userData.inRange = false;
          voxelMesh.visible = false;
          mesh.children.forEach(c => {
            if ((c as Mesh).isMesh) c.visible = true;
          });
        }
      }
    }
  }

  private async loadVoxelModel(id: number, container: Object3D, entity: GalaxyEntity) {
    try {
      // Render voxels at true scale (1 block = 1 unit). Inter-entity dock offsets come
      // from the server in real units, so any non-1.0 scale inflates each shell out of
      // sync with those offsets and makes docked entities overlap/engulf each other.
      const voxelScale = 1.0;
      
      console.log(`[GalaxyRenderer] Loading voxel model for "${entity.name}" (id=${id}, type=${entity.type}, scale=${voxelScale})`);
      const voxelMesh = await VoxelModelLoader.loadModel(id, voxelScale, entity.type, this._renderMode);
      voxelMesh.position.copy(container.position);

      // Apply the entity's real orientation if the server sent it (loaded entities only).
      const rot = entity.rotation;
      if (rot && rot.length === 9) {
        const m = new Matrix4().set(
          rot[0], rot[1], rot[2], 0,
          rot[3], rot[4], rot[5], 0,
          rot[6], rot[7], rot[8], 0,
          0, 0, 0, 1
        );
        voxelMesh.quaternion.setFromRotationMatrix(m);
      }

      voxelMesh.userData.id = id; // tag with entity id for raycasting!
      voxelMesh.userData.inRange = true;
      this.scene.add(voxelMesh);
      
      this.entityVoxelMeshes.set(id, voxelMesh);
      this.entityVoxelLoading.delete(id);

      // Hide default marker
      container.children.forEach(c => {
        if ((c as Mesh).isMesh) c.visible = false;
      });
      console.log(`[GalaxyRenderer] Voxel model loaded for "${entity.name}"`);
    } catch (e) {
      console.warn(`[GalaxyRenderer] Could not load voxel model for ${id} ("${entity.name}"):`, e);
      // Remove from loading set but don't attempt to load repeatedly
      setTimeout(() => this.entityVoxelLoading.delete(id), 10000);
    }
  }

  public selectEntity(id: number | null) {
    if (id !== null && this.selectedEntityId === id && this._viewMode === 'GALAXY') {
      this.toggleViewMode();
      return;
    }
    this.selectedEntityId = id;
    this.selectedPlayerName = null;
    this.viewModeTransitionProgress = 0.0; // Trigger smooth fade transition
    if (id === null) {
      this.cameraController.focusOn(null);
      this.onSelectCallback(null);
      return;
    }

    const mesh = this.entityMeshes.get(id);
    const entity = this.entitiesData.get(id);
    if (mesh && entity) {
      this.selectedSector = { ...entity.sector };

      // Selecting an object focuses it, switches to Sector view, and zooms in.
      this._viewMode = 'SECTOR';
      this.cameraController.focusOn({ getPosition: () => mesh.position });
      this.cameraController.setMode('ORBIT');

      // Frame the object: zoom distance scales with its size, with a sane default.
      let zoom = 1500;
      const mn = entity.minBounds, mx = entity.maxBounds;
      if (mn && mx) {
        const size = Math.max(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z);
        if (size > 0) zoom = Math.max(500, Math.min(8000, size * 50));
      }
      this.cameraController.setOrbitRadius(zoom);

      if (this.onViewModeChangeCallback) {
        this.onViewModeChangeCallback(this._viewMode);
      }

      this.onSelectCallback(entity);
    }
  }

  public getRenderMode(): RenderMode {
    return this._renderMode;
  }

  /**
   * Switch the ship/station render tier. Existing voxel meshes are disposed so they
   * reload in the new mode; markers reappear briefly until the reload completes.
   */
  public setRenderMode(mode: RenderMode) {
    if (this._renderMode === mode) return;
    this._renderMode = mode;

    for (const [id, voxelMesh] of this.entityVoxelMeshes.entries()) {
      this.scene.remove(voxelMesh);
      voxelMesh.geometry.dispose();
      const mat = voxelMesh.material;
      if (Array.isArray(mat)) mat.forEach(m => m.dispose());
      else (mat as Material).dispose();

      // Restore the entity's marker until the voxel model reloads in the new mode.
      const container = this.entityMeshes.get(id);
      if (container) {
        container.children.forEach(c => {
          if ((c as Mesh).isMesh) c.visible = true;
        });
      }
    }
    this.entityVoxelMeshes.clear();
    this.entityVoxelLoading.clear();
    // handleLevelOfDetail() re-triggers loads for in-range entities on the next frame.
  }

  public setCameraMode(mode: CameraMode) {
    this.cameraController.setMode(mode);
  }

  public setPointerLockCallback(cb: (locked: boolean) => void) {
    this.cameraController.setPointerLockCallback(cb);
  }

  public getCameraMode(): CameraMode {
    return this.cameraController.mode;
  }

  public shutdown() {
    this.isRunning = false;
    if (this.renderer) {
      this.renderer.dispose();
      this.container.removeChild(this.renderer.domElement);
    }
  }

  private handleCanvasClick(e: MouseEvent) {
    // In first-person mode a click captures the mouse (handled by CameraController), so don't
    // also treat it as an object-selection raycast.
    if (document.pointerLockElement === this.renderer.domElement) return;

    // Normalize coordinates to -1 to +1 space
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new Raycaster();
    const mouse = new Vector2(x, y);
    raycaster.setFromCamera(mouse, this.camera);

    const clickableObjects: Object3D[] = [];

    // Gather default marker meshes
    for (const mesh of this.entityMeshes.values()) {
      if (mesh.visible) {
        mesh.traverse(child => {
          if ((child as Mesh).isMesh && child.visible) {
            clickableObjects.push(child);
          }
        });
      }
    }

    // Gather voxel meshes
    for (const mesh of this.entityVoxelMeshes.values()) {
      if (mesh.visible) {
        clickableObjects.push(mesh);
      }
    }

    const intersects = raycaster.intersectObjects(clickableObjects, true);

    if (intersects.length > 0) {
      // Find the entity ID tagged in userData (traversing up parents if necessary)
      let current: Object3D | null = intersects[0].object;
      let targetId: number | null = null;

      while (current) {
        if (current.userData && typeof current.userData.id === 'number') {
          targetId = current.userData.id;
          break;
        }
        current = current.parent;
      }

      if (targetId !== null) {
        this.selectEntity(targetId);
      }
    }
  }

  public getFactionColor(factionId: number): string {
    if (factionId === 0) return '#888888';
    if (factionId === -1) return '#ff2244';
    
    // Generate dynamic stable HSL color based on faction ID hash
    let hash = 0;
    const idStr = factionId.toString();
    for (let i = 0; i < idStr.length; i++) {
      hash = idStr.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 95%, 55%)`;
  }

  public getFactionName(factionId: number): string {
    if (factionId === 0) return 'Neutral / Unowned';
    if (factionId === -1) return 'Pirates';
    return this.factionNames.get(factionId) || `Faction #${factionId}`;
  }

  public setFactionNames(names: Map<number, string>) {
    this.factionNames = names;
  }

  private createSectorHighlight(key: string, sector: {x:number, y:number, z:number}, factionId: number) {
    const colorStr = this.getFactionColor(factionId);
    const group = new Object3D();
    const SECTOR_SIZE = 4000;
    
    // Position highlight group at the center of the sector
    const center = this.getAbsolutePosition(sector, { x: 0, y: 0, z: 0 });
    group.position.copy(center);
    
    // 1. Holographic transparent box volume
    const boxGeom = new BoxGeometry(SECTOR_SIZE, SECTOR_SIZE, SECTOR_SIZE);
    const boxMat = new MeshBasicMaterial({
      color: new Color(colorStr),
      transparent: true,
      opacity: 0.03,
      depthWrite: false,
      side: DoubleSide
    });
    const boxMesh = new Mesh(boxGeom, boxMat);
    group.add(boxMesh);
    
    // 2. Matching wireframe outlines
    const edgesGeom = new EdgesGeometry(boxGeom);
    const edgesMat = new LineBasicMaterial({
      color: new Color(colorStr),
      transparent: true,
      opacity: 0.15
    });
    const edgesLines = new LineSegments(edgesGeom, edgesMat);
    group.add(edgesLines);
    
    group.userData = { factionId, isSectorHighlight: true };
    this.scene.add(group);
    this.sectorHighlights.set(key, group);
  }

  public setHoverCallback(callback: (entity: GalaxyEntity | null, clientX: number, clientY: number) => void) {
    this.onHoverCallback = callback;
  }

  private handlePointerMove(e: MouseEvent) {
    if (!this.onHoverCallback) return;

    // Determine normalized device coordinates
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new Raycaster();
    const mouse = new Vector2(x, y);
    raycaster.setFromCamera(mouse, this.camera);

    const clickableObjects: Object3D[] = [];

    // Gather default marker meshes
    for (const mesh of this.entityMeshes.values()) {
      if (mesh.visible) {
        mesh.traverse(child => {
          if ((child as Mesh).isMesh && child.visible) {
            clickableObjects.push(child);
          }
        });
      }
    }

    // Gather voxel meshes
    for (const mesh of this.entityVoxelMeshes.values()) {
      if (mesh.visible) {
        clickableObjects.push(mesh);
      }
    }

    const intersects = raycaster.intersectObjects(clickableObjects, true);

    if (intersects.length > 0) {
      let current: Object3D | null = intersects[0].object;
      let targetId: number | null = null;

      while (current) {
        if (current.userData && typeof current.userData.id === 'number') {
          targetId = current.userData.id;
          break;
        }
        current = current.parent;
      }

      if (targetId !== null) {
        const entity = this.entitiesData.get(targetId);
        if (entity) {
          this.onHoverCallback(entity, e.clientX, e.clientY);
          return;
        }
      }
    }

    this.onHoverCallback(null, 0, 0);
  }

  public getEntities(): GalaxyEntity[] {
    return Array.from(this.entitiesData.values());
  }

  public getPlayers(): PlayerData[] {
    return Array.from(this.playersData.values());
  }

  public selectPlayer(name: string | null) {
    if (name !== null && this.selectedPlayerName === name && this._viewMode === 'GALAXY') {
      this.toggleViewMode();
      return;
    }
    this.selectedPlayerName = name;
    this.selectedEntityId = null;
    this.viewModeTransitionProgress = 0.0; // Trigger smooth fade transition
    if (name === null) {
      this.cameraController.focusOn(null);
      this.onSelectCallback(null);
      return;
    }

    const mesh = this.playerMeshes.get(name);
    const player = this.playersData.get(name);
    if (mesh && player) {
      this.selectedSector = { ...player.sector };
      this.cameraController.focusOn({
        getPosition: () => mesh.position
      });

      const pseudoEntity: GalaxyEntity = {
        id: -999, // special ID for player
        name: player.name,
        type: 'SHIP', // Render stats as ship
        sector: player.sector,
        position: player.position,
        factionId: player.factionId
      };
      this.onSelectCallback(pseudoEntity);
    }
  }

  private hasInitializedCameraPosition = false;

  public centerCameraOnActiveObjects() {
    if (this.hasInitializedCameraPosition) return;

    if (this.playerMeshes.size > 0) {
      const firstPlayerMesh = Array.from(this.playerMeshes.values())[0];
      this.camera.position.copy(firstPlayerMesh.position).add(new Vector3(0, 100, 300));
      this.camera.lookAt(firstPlayerMesh.position);
      this.cameraController.focusOn({ getPosition: () => firstPlayerMesh.position });
      this.hasInitializedCameraPosition = true;
    } else if (this.entityMeshes.size > 0) {
      let targetMesh: Object3D | null = null;
      for (const [id, mesh] of this.entityMeshes.entries()) {
        const entity = this.entitiesData.get(id);
        if (entity && (entity.type === 'SUN' || entity.type === 'PLANET')) {
          targetMesh = mesh;
          break;
        }
      }
      if (!targetMesh) {
        targetMesh = Array.from(this.entityMeshes.values())[0];
      }
      if (targetMesh) {
        this.camera.position.copy(targetMesh.position).add(new Vector3(0, 300, 800));
        this.camera.lookAt(targetMesh.position);
        this.cameraController.focusOn({ getPosition: () => targetMesh.position });
        this.hasInitializedCameraPosition = true;
      }
    }
  }

  public getCameraController(): CameraController {
    return this.cameraController;
  }

  // --- View Mode System (Homeworld 2 Style) ---

  public get viewMode(): ViewMode {
    return this._viewMode;
  }

  public setViewModeCallback(callback: (mode: ViewMode) => void) {
    this.onViewModeChangeCallback = callback;
  }

  public toggleViewMode() {
    this._viewMode = this._viewMode === 'GALAXY' ? 'SECTOR' : 'GALAXY';
    this.viewModeTransitionProgress = 0.0;
    console.log(`[GalaxyRenderer] View mode switched to: ${this._viewMode}`);

    // Center focus on selected sector center, or selected entity if exists
    const sectorCenter = this.getAbsolutePosition(this.selectedSector, { x: 0, y: 0, z: 0 });
    
    if (this.selectedEntityId !== null) {
      const mesh = this.entityMeshes.get(this.selectedEntityId);
      if (mesh) {
        this.cameraController.focusOn({ getPosition: () => mesh.position });
      }
    } else if (this.selectedPlayerName !== null) {
      const mesh = this.playerMeshes.get(this.selectedPlayerName);
      if (mesh) {
        this.cameraController.focusOn({ getPosition: () => mesh.position });
      }
    } else {
      this.cameraController.focusOn({ getPosition: () => sectorCenter });
    }

    // Force orbit mode to apply zoom smoothly
    this.cameraController.setMode('ORBIT');

    // Zoom in or out
    if (this._viewMode === 'SECTOR') {
      this.cameraController.setOrbitRadius(3000.0);
    } else {
      this.cameraController.setOrbitRadius(70000.0);
    }

    if (this.onViewModeChangeCallback) {
      this.onViewModeChangeCallback(this._viewMode);
    }
  }

  private setupKeyboardListeners() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        this.toggleViewMode();
      }
    });
  }

  // Determine the "focus sector" for sector view based on camera position or selection
  private getFocusSector(): { x: number; y: number; z: number } {
    const SECTOR_SIZE = 4000;
    const pos = this.camera.position;
    return {
      x: Math.round(pos.x / SECTOR_SIZE) + 2,
      y: Math.round(pos.y / SECTOR_SIZE) + 2,
      z: Math.round(pos.z / SECTOR_SIZE) + 2
    };
  }

  private isSectorNearby(entitySector: { x: number; y: number; z: number }, focusSector: { x: number; y: number; z: number }, range: number = 1): boolean {
    return Math.abs(entitySector.x - focusSector.x) <= range &&
           Math.abs(entitySector.y - focusSector.y) <= range &&
           Math.abs(entitySector.z - focusSector.z) <= range;
  }

  // Smoothly set opacity on a mesh's materials
  private setMeshOpacity(obj: Object3D, targetOpacity: number) {
    obj.traverse((child) => {
      if ((child as Mesh).isMesh || (child as LineSegments).isLineSegments) {
        const mat = (child as Mesh).material as Material;
        if (mat && 'opacity' in mat) {
          mat.transparent = true;
          mat.opacity = targetOpacity;
          mat.needsUpdate = true;
        }
      }
    });
  }

  // Per-frame view mode opacity and scale updates
  private updateViewModeOpacities(deltaTime: number) {
    // Advance transition progress
    if (this.viewModeTransitionProgress < 1.0) {
      this.viewModeTransitionProgress = Math.min(1.0, this.viewModeTransitionProgress + deltaTime * 3.0); // ~330ms transition
    }

    const t = this.viewModeTransitionProgress;
    const focusSector = this.getFocusSector();

    // Check if there is an active focus/selection
    const hasSelection = (this.selectedEntityId !== null || this.selectedPlayerName !== null);
    
    let selectedPos: Vector3 | null = null;
    let selectedSec: { x: number; y: number; z: number } | null = null;

    if (this.selectedEntityId !== null) {
      const mesh = this.entityMeshes.get(this.selectedEntityId);
      if (mesh) selectedPos = mesh.position;
      const entity = this.entitiesData.get(this.selectedEntityId);
      if (entity) selectedSec = entity.sector;
    } else if (this.selectedPlayerName !== null) {
      const mesh = this.playerMeshes.get(this.selectedPlayerName);
      if (mesh) selectedPos = mesh.position;
      const player = this.playersData.get(this.selectedPlayerName);
      if (player) selectedSec = player.sector;
    }

    // Determine if focus isolation is active (ONLY in Sector View with selection)
    const isFocusActive = hasSelection && (this._viewMode === 'SECTOR');

    // 1. Update Grid Helper Opacity
    if (this.grid) {
      const targetGridOpacity = isFocusActive ? 0.03 : 0.2;
      const mat = this.grid.material as Material;
      if (mat && 'opacity' in mat) {
        const currentOp = mat.opacity;
        mat.transparent = true;
        mat.opacity = currentOp + (targetGridOpacity - currentOp) * Math.min(t, 1.0);
        mat.needsUpdate = true;
      }
    }

    // 2. Update entities (markers and voxel meshes)
    for (const [id, mesh] of this.entityMeshes.entries()) {
      const entity = this.entitiesData.get(id);
      if (!entity) continue;

      let targetOpacity = 1.0;
      let targetScale = 1.0;

      // Scale suns up in Galaxy view so they read as stars (smaller than before).
      if (entity.type === 'SUN') {
        targetScale = this._viewMode === 'GALAXY' ? 28.0 : 1.0;
      }

      if (isFocusActive && selectedSec && selectedPos) {
        // Focus active: hide everything except selected and docked
        const isSelected = (id === this.selectedEntityId);
        const isSameSector = (entity.sector.x === selectedSec.x && entity.sector.y === selectedSec.y && entity.sector.z === selectedSec.z);
        // Keep the selection and everything else in its sector visible. A distance cap
        // would hide a large parent station (whose core can be far from a docked ship).

        if (isSelected || isSameSector) {
          targetOpacity = 1.0;
        } else {
          targetOpacity = 0.0;
        }
      } else {
        // Standard view mode rules (no selection focus active, e.g. Galaxy View or Sector View with no selection)
        if (this._viewMode === 'GALAXY') {
          if (entity.type === 'SUN') {
            targetOpacity = 1.0;
          } else {
            targetOpacity = 0.15;
          }
        } else { // SECTOR view
          if (this.isSectorNearby(entity.sector, focusSector, 1)) {
            targetOpacity = 1.0;
          } else if (entity.type === 'SUN') {
            targetOpacity = 0.15;
          } else {
            targetOpacity = 0.05;
          }
        }
      }

      // Lerp opacity
      const currentOpacity = this.getMeshOpacity(mesh);
      const newOpacity = currentOpacity + (targetOpacity - currentOpacity) * Math.min(t, 1.0);
      this.setMeshOpacity(mesh, newOpacity);
      mesh.visible = (newOpacity > 0.01);

      // Lerp scale for SUNs
      if (entity.type === 'SUN') {
        const currentScale = mesh.scale.x;
        const newScale = currentScale + (targetScale - currentScale) * Math.min(t, 1.0);
        mesh.scale.set(newScale, newScale, newScale);
      }

      // Also apply to voxel meshes
      const voxelMesh = this.entityVoxelMeshes.get(id);
      if (voxelMesh) {
        const mat = voxelMesh.material as Material;
        if (mat && 'opacity' in mat) {
          mat.transparent = true;
          mat.opacity = newOpacity;
          mat.needsUpdate = true;
        }
        voxelMesh.visible = (newOpacity > 0.01) && (voxelMesh.userData.inRange === true);
      }
    }

    // 3. Update Player Meshes
    for (const [name, mesh] of this.playerMeshes.entries()) {
      const player = this.playersData.get(name as string);
      if (!player) continue;

      let targetOpacity = 1.0;

      if (isFocusActive && selectedSec && selectedPos) {
        const isSelected = (name === this.selectedPlayerName);
        const isSameSector = (player.sector.x === selectedSec.x && player.sector.y === selectedSec.y && player.sector.z === selectedSec.z);
        const isDocked = isSameSector && mesh.position.distanceTo(selectedPos) < 300.0;

        if (isSelected || isDocked) {
          targetOpacity = 1.0;
        } else {
          targetOpacity = 0.0;
        }
      } else {
        if (this._viewMode === 'GALAXY') {
          targetOpacity = 0.3;
        } else {
          targetOpacity = this.isSectorNearby(player.sector, focusSector, 1) ? 1.0 : 0.1;
        }
      }

      const currentOpacity = this.getMeshOpacity(mesh);
      const newOpacity = currentOpacity + (targetOpacity - currentOpacity) * Math.min(t, 1.0);
      this.setMeshOpacity(mesh, newOpacity);
      mesh.visible = (newOpacity > 0.01);
    }

    // 4. Update Sector Highlights (faction territory highlights)
    for (const [, highlight] of this.sectorHighlights.entries()) {
      let targetOpacity = 1.0;
      if (isFocusActive) {
        targetOpacity = 0.0; // Hide outlines when inspecting a single target in focus mode
      } else {
        targetOpacity = this._viewMode === 'GALAXY' ? 1.0 : 0.3;
      }

      const currentOpacity = highlight.userData.opacity ?? 1.0;
      const newOpacity = currentOpacity + (targetOpacity - currentOpacity) * Math.min(t, 1.0);
      highlight.userData.opacity = newOpacity;
      highlight.visible = (newOpacity > 0.01);

      highlight.traverse((child) => {
        if ((child as Mesh).isMesh || (child as LineSegments).isLineSegments) {
          const mat = (child as Mesh).material as Material;
          if (mat && 'opacity' in mat) {
            mat.transparent = true;
            const baseOpacity = (child as any).userData?.baseOpacity ?? mat.opacity;
            if (!(child as any).userData) (child as any).userData = {};
            (child as any).userData.baseOpacity = baseOpacity;
            mat.opacity = baseOpacity * newOpacity;
            mat.needsUpdate = true;
          }
        }
      });
    }
  }

  private getMeshOpacity(obj: Object3D): number {
    let opacity = 1.0;
    obj.traverse((child) => {
      if ((child as Mesh).isMesh) {
        const mat = (child as Mesh).material as Material;
        if (mat && 'opacity' in mat) {
          opacity = mat.opacity;
        }
      }
    });
    return opacity;
  }
}
