import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  SRGBColorSpace,
  Vector3
} from 'three';

/**
 * Ship/station render tiers, lightest to heaviest:
 *  - GENERIC: procedural placeholder shape, no per-entity voxel fetch (cheapest)
 *  - GRAY:    real voxel geometry, single flat color (no per-block color work)
 *  - COLOR:   real voxel geometry with per-block colors from the server
 *  - TEXTURE: real StarMade block textures sampled from the block atlas
 */
export type RenderMode = 'GENERIC' | 'GRAY' | 'COLOR' | 'TEXTURE';

// Uniform hull color used by the GRAY render tier
const GRAY_VOXEL_COLOR = new Color('hsl(210, 8%, 62%)');

// Map color IDs to stylized neon sci-fi colors
export const VOXEL_COLORS: Color[] = [
  new Color('hsl(200, 15%, 50%)'),  // 0: Standard Steel Hull
  new Color('hsl(195, 100%, 55%)'), // 1: Shield Systems (Neon Cyan)
  new Color('hsl(350, 100%, 55%)'), // 2: Weapons/Missiles (Vibrant Red)
  new Color('hsl(35, 100%, 55%)'),  // 3: Thrusters/Engines (Bright Orange)
  new Color('hsl(140, 100%, 50%)'), // 4: Power/Reactors (Vibrant Green)
  new Color('hsl(280, 100%, 65%)'), // 5: FTL/Jump Drive (Electric Purple)
];

interface TextureAtlas {
  material: MeshStandardMaterial;       // samples the composited block atlas per-face
  typeTiles: Map<number, number[]>;     // block type id -> 6 side atlas tile indices
}

export class VoxelModelLoader {
  // Reusable material
  private static material = new MeshStandardMaterial({
    roughness: 0.2,
    metalness: 0.8,
    flatShading: true
  });

  private static fallbackCache: Map<string, ArrayBuffer> = new Map();

  // Cache fetched voxel buffers per entity so switching render modes doesn't re-fetch
  // from the server (the heavy network cost of a mode switch). Bytes live on the client.
  private static voxelBufferCache: Map<number, ArrayBuffer> = new Map();

  // Lazily-built block texture atlas (shared across all textured meshes).
  private static textureAtlasPromise: Promise<TextureAtlas> | null = null;

  /**
   * Loads the block texture atlas once: fetches /api/blockmeta, composites the
   * needed atlas pages into one vertically-stacked super-atlas, and builds a
   * MeshStandardMaterial whose vertex shader maps each instance's `aTile` index
   * to the right tile UVs.
   */
  private static ensureTextureAtlas(): Promise<TextureAtlas> {
    if (!this.textureAtlasPromise) {
      this.textureAtlasPromise = (async () => {
        const meta = await fetch('/api/blockmeta').then(r => r.json());
        const tilesPerPage: number = meta.tilesPerPage ?? 256;
        const tilesPerRow: number = meta.tilesPerRow ?? 16;
        const tileSize: number = meta.tileSize ?? 64;
        const pageSize = tileSize * tilesPerRow; // px per atlas page (e.g. 1024)

        const typeTiles = new Map<number, number[]>();
        let maxTile = 0;
        for (const k in meta.blocks) {
          const sides: number[] = meta.blocks[k];
          const six = [0, 1, 2, 3, 4, 5].map(s => (sides && sides.length > s ? sides[s] : 0));
          typeTiles.set(parseInt(k, 10), six);
          for (const t of six) if (t > maxTile) maxTile = t;
        }
        const pages = Math.floor(maxTile / tilesPerPage) + 1;

        // Composite every needed atlas page into one vertically-stacked image.
        const canvas = document.createElement('canvas');
        canvas.width = pageSize;
        canvas.height = pageSize * pages;
        const ctx = canvas.getContext('2d')!;
        await Promise.all(
          Array.from({ length: pages }, (_, p) => new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => { ctx.drawImage(img, 0, p * pageSize); resolve(); };
            img.onerror = () => resolve();
            img.src = `/api/blocktexture?page=${p}`;
          }))
        );

        const tex = new CanvasTexture(canvas);
        tex.flipY = false;
        tex.colorSpace = SRGBColorSpace;
        tex.magFilter = NearestFilter;
        tex.minFilter = NearestFilter;
        tex.generateMipmaps = false;

        const material = new MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.1 });
        const rows = tilesPerRow.toFixed(1);
        const perPage = tilesPerPage.toFixed(1);
        const pagesF = pages.toFixed(1);
        material.onBeforeCompile = (shader) => {
          shader.vertexShader =
            'attribute vec3 aSideA;\nattribute vec3 aSideB;\n' +
            shader.vertexShader.replace(
              '#include <uv_vertex>',
              `#include <uv_vertex>
              {
                // Pick the atlas tile for this face from the block's 6 side tiles.
                // Face->side mapping (permute these if a face shows the wrong texture):
                //   side0=+Z front, side1=-Z back, side2=+Y top,
                //   side3=-Y bottom, side4=+X right, side5=-X left
                float tile;
                if (normal.z > 0.5)       tile = aSideA.x; // front
                else if (normal.z < -0.5) tile = aSideA.y; // back
                else if (normal.y > 0.5)  tile = aSideA.z; // top
                else if (normal.y < -0.5) tile = aSideB.x; // bottom
                else if (normal.x > 0.5)  tile = aSideB.y; // right
                else                      tile = aSideB.z; // left

                float page = floor(tile / ${perPage});
                float local = tile - page * ${perPage};
                float row = floor(local / ${rows});
                float col = local - row * ${rows};
                float tilesY = ${rows} * ${pagesF};
                vec2 tOrigin = vec2(col / ${rows}, (page * ${rows} + row) / tilesY);
                vec2 tScale = vec2(1.0 / ${rows}, 1.0 / tilesY);
                vMapUv = tOrigin + vec2(uv.x, 1.0 - uv.y) * tScale;
              }`
            );
        };

        console.log(`[VoxelModelLoader] Block atlas ready: ${typeTiles.size} types, ${pages} pages.`);
        return { material, typeTiles };
      })();
    }
    return this.textureAtlasPromise;
  }

  private static getProceduralVoxelBuffer(type: 'SHIP' | 'STATION'): ArrayBuffer {
    if (this.fallbackCache.has(type)) {
      return this.fallbackCache.get(type)!;
    }

    const voxels: { rx: number; ry: number; rz: number; colorId: number }[] = [];
    let minX = 0, minY = 0, minZ = 0;

    if (type === 'SHIP') {
      minX = -6;
      minY = -3;
      minZ = -10;
      for (let rz = 0; rz <= 20; rz++) {
        const z = rz - 10;
        const maxWidth = z > 0 ? Math.floor(6 * (1.0 - z / 10)) : Math.floor(4 + rz * 0.2);
        for (let rx = 0; rx <= 12; rx++) {
          const x = rx - 6;
          if (Math.abs(x) > maxWidth) continue;
          
          const maxHeight = Math.max(1, Math.floor(3 - Math.abs(x) * 0.5 - Math.abs(z) * 0.1));
          for (let ry = 0; ry <= 6; ry++) {
            const y = ry - 3;
            if (Math.abs(y) > maxHeight) continue;

            let colorId = 0; // standard hull (gray)
            if (z === -10) {
              colorId = 3; // thruster (orange) at the very back
            } else if (Math.abs(x) === maxWidth && Math.abs(y) === maxHeight) {
              colorId = 1; // shield (cyan) on edges
            } else if (z === 8) {
              colorId = 2; // weapons (red) near front
            } else if (x === 0 && y === 0 && Math.abs(z) < 3) {
              colorId = 4; // reactor (green) at center
            }

            voxels.push({ rx, ry, rz, colorId });
          }
        }
      }
    } else { // STATION
      minX = -12;
      minY = -12;
      minZ = -3;
      for (let rz = 0; rz <= 6; rz++) {
        const z = rz - 3;
        for (let rx = 0; rx <= 24; rx++) {
          const x = rx - 12;
          for (let ry = 0; ry <= 24; ry++) {
            const y = ry - 12;
            const dist2d = Math.sqrt(x*x + y*y);
            
            let isPart = false;
            let colorId = 0;

            if (dist2d <= 3 && Math.abs(z) <= 3) {
              isPart = true;
              colorId = (dist2d <= 1) ? 4 : 0; // reactor core
            } else if ((Math.abs(x) <= 1 || Math.abs(y) <= 1) && dist2d < 10 && z === 0) {
              isPart = true;
              colorId = 0; // struts
            } else if (dist2d >= 9 && dist2d <= 11 && Math.abs(z) <= 1) {
              isPart = true;
              colorId = (Math.abs(z) === 1) ? 1 : 0; // shield panels on ring
            } else if (dist2d >= 11 && dist2d <= 13 && (Math.abs(x) <= 2 && Math.abs(y) <= 2) && z === 0) {
              isPart = true;
              colorId = 5; // FTL pods on spoke tips
            }

            if (isPart) {
              voxels.push({ rx, ry, rz, colorId });
            }
          }
        }
      }
    }

    // Precompute sRGB byte triples for each palette slot so the procedural fallback
    // uses the same 9-byte-per-voxel format as the real server output.
    const palette = VOXEL_COLORS.map((c) => {
      const o = c.getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
      return [Math.round(o.r * 255), Math.round(o.g * 255), Math.round(o.b * 255)];
    });

    const N = voxels.length;
    // 11 bytes/voxel: 3x int16 position + 3x uint8 RGB + 1x int16 block type (0 here).
    const buffer = new ArrayBuffer(12 + N * 11);
    const dataView = new DataView(buffer);

    dataView.setInt32(0, minX, false);
    dataView.setInt32(4, minY, false);
    dataView.setInt32(8, minZ, false);

    for (let i = 0; i < N; i++) {
      const v = voxels[i];
      const offset = 12 + i * 11;
      dataView.setInt16(offset, v.rx, false);
      dataView.setInt16(offset + 2, v.ry, false);
      dataView.setInt16(offset + 4, v.rz, false);
      const [r, g, b] = palette[Math.min(Math.max(v.colorId, 0), palette.length - 1)];
      dataView.setUint8(offset + 6, r);
      dataView.setUint8(offset + 7, g);
      dataView.setUint8(offset + 8, b);
      dataView.setInt16(offset + 9, 0, false); // procedural blocks have no real type
    }

    this.fallbackCache.set(type, buffer);
    return buffer;
  }

  /**
   * Fetches and parses optimized binary voxel shell from backend APIs, returning a Three.js InstancedMesh.
   * 
   * @param entityId The ID of the segment controller entity
   * @param scale Scale factor to apply to voxel positions (default 1.0)
   * @param entityType The type of the entity for procedural fallback
   * @returns Promise of InstancedMesh
   */
  public static async loadModel(
    entityId: number,
    scale: number = 1.0,
    entityType?: 'SHIP' | 'STATION' | 'SUN' | 'PLANET',
    mode: RenderMode = 'COLOR'
  ): Promise<InstancedMesh> {
    const type = entityType === 'STATION' ? 'STATION' : 'SHIP';

    // GENERIC tier: skip the network entirely and render the procedural placeholder.
    if (mode === 'GENERIC') {
      return this.parseBinaryVoxelShell(this.getProceduralVoxelBuffer(type), scale, 'COLOR', null);
    }

    // TEXTURE tier: ensure the block atlas + tile map is loaded; fall back to COLOR on failure.
    let atlas: TextureAtlas | null = null;
    if (mode === 'TEXTURE') {
      try {
        atlas = await this.ensureTextureAtlas();
      } catch (e) {
        console.warn('[VoxelModelLoader] Texture atlas load failed; falling back to COLOR.', e);
        mode = 'COLOR';
      }
    }

    try {
      let buffer = this.voxelBufferCache.get(entityId);
      if (!buffer) {
        console.log(`[VoxelModelLoader] Fetching voxel data for entity ${entityId} (mode=${mode})...`);
        const response = await fetch(`/api/voxels/${entityId}`);
        if (!response.ok) {
          throw new Error(`HTTP status ${response.status}`);
        }
        buffer = await response.arrayBuffer();
        if (buffer.byteLength <= 12) {
          throw new Error("Empty voxel buffer (only header)");
        }
        this.voxelBufferCache.set(entityId, buffer);
      }

      return this.parseBinaryVoxelShell(buffer, scale, mode, atlas);
    } catch (e) {
      console.warn(`[VoxelModelLoader] Could not load voxel data for ${entityId}. Falling back to procedural model.`, e);
      const fallbackBuffer = this.getProceduralVoxelBuffer(type);
      // Procedural blocks have no real type, so texture can't apply; use color colors.
      return this.parseBinaryVoxelShell(fallbackBuffer, scale, mode === 'TEXTURE' ? 'COLOR' : mode, null);
    }
  }

  private static parseBinaryVoxelShell(
    buffer: ArrayBuffer,
    scale: number = 1.0,
    mode: RenderMode = 'COLOR',
    atlas: TextureAtlas | null = null
  ): InstancedMesh {
    const gray = mode === 'GRAY';
    const textured = mode === 'TEXTURE' && atlas != null;
    const dataView = new DataView(buffer);
    
    // Read starting 12-byte header: min bounds coordinates
    const minX = dataView.getInt32(0, false); // big-endian
    const minY = dataView.getInt32(4, false);
    const minZ = dataView.getInt32(8, false);

    const voxelDataSize = 11; // 11 bytes/voxel: 3x int16 pos + 3x uint8 RGB + 1x int16 block type
    const headerSize = 12;
    const voxelCount = (buffer.byteLength - headerSize) / voxelDataSize;

    console.log(`[VoxelModelLoader] Parsing ${voxelCount} voxels, minBounds=(${minX},${minY},${minZ}), scale=${scale}, mode=${mode}`);

    // Create the instanced mesh with scaled geometry
    const scaledGeometry = new BoxGeometry(scale, scale, scale);
    let material: MeshStandardMaterial;
    if (textured) {
      material = atlas!.material.clone();
      // Material.clone() does NOT copy onBeforeCompile, so re-apply the atlas
      // tile-UV shader (otherwise each face samples the whole atlas).
      material.onBeforeCompile = atlas!.material.onBeforeCompile;
    } else {
      material = this.material.clone();
    }
    const mesh = new InstancedMesh(scaledGeometry, material, voxelCount);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);

    // TEXTURE tier: per-instance atlas tile indices for the 6 faces (sides 0-2 / 3-5),
    // read by the material's vertex shader.
    let sideA: Float32Array | null = null;
    let sideB: Float32Array | null = null;
    if (textured) {
      sideA = new Float32Array(voxelCount * 3);
      sideB = new Float32Array(voxelCount * 3);
    }

    const dummy = new Object3D();
    const position = new Vector3();
    const color = new Color();

    for (let i = 0; i < voxelCount; i++) {
      const offset = headerSize + i * voxelDataSize;

      // Read Packed Voxel: int16 rx, ry, rz, uint8 R, G, B, int16 block type
      const rx = dataView.getInt16(offset, false);
      const ry = dataView.getInt16(offset + 2, false);
      const rz = dataView.getInt16(offset + 4, false);
      const r = dataView.getUint8(offset + 6);
      const g = dataView.getUint8(offset + 7);
      const b = dataView.getUint8(offset + 8);
      const blockType = dataView.getInt16(offset + 9, false);

      // Compute actual position (centered around origin of local coordinate space)
      // Apply scale so voxels spread out proportionally
      position.set(
        (minX + rx) * scale,
        (minY + ry) * scale,
        (minZ + rz) * scale
      );

      dummy.position.copy(position);
      dummy.updateMatrix();

      mesh.setMatrixAt(i, dummy.matrix);

      if (textured) {
        // Per-face atlas tiles for this block type (unknown blocks -> tile 0).
        const six = atlas!.typeTiles.get(blockType);
        sideA![i * 3] = six ? six[0] : 0;
        sideA![i * 3 + 1] = six ? six[1] : 0;
        sideA![i * 3 + 2] = six ? six[2] : 0;
        sideB![i * 3] = six ? six[3] : 0;
        sideB![i * 3 + 1] = six ? six[4] : 0;
        sideB![i * 3 + 2] = six ? six[5] : 0;
      } else if (gray) {
        mesh.setColorAt(i, GRAY_VOXEL_COLOR);
      } else {
        color.setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
        mesh.setColorAt(i, color);
      }
    }

    if (sideA && sideB) {
      scaledGeometry.setAttribute('aSideA', new InstancedBufferAttribute(sideA, 3));
      scaledGeometry.setAttribute('aSideB', new InstancedBufferAttribute(sideB, 3));
    }

    // Trigger update updates to GPU buffer
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }

    // Tag the mesh with the bounds metadata for bounding operations
    mesh.userData = {
      isVoxelMesh: true,
      minBounds: new Vector3(minX, minY, minZ),
      voxelCount: voxelCount
    };

    return mesh;
  }
}
