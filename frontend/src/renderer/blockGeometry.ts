import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Quaternion } from 'three';

/**
 * StarMade block shapes and the geometry/orientation handling for the non-cube ones
 * (wedges, corners, tetras, heptas).
 *
 * The geometries below are first-pass approximations centered on the unit cube
 * [-s/2, +s/2]^3 so they drop straight into the same instanced placement as cube
 * voxels. They are intended to be eyeballed against a real ship and refined.
 *
 * Orientation is currently NOT applied (identity) — see orientationQuaternion(). That
 * is the piece to tune in the verify loop once shapes line up.
 */

// StarMade BlockStyle ordinals (declaration order of the in-game enum).
export enum BlockStyle {
  NORMAL = 0,
  WEDGE = 1,
  CORNER = 2,
  SPRITE = 3,
  TETRA = 4,
  HEPTA = 5,
  NORMAL24 = 6,
}

// Geometry key for a block style. Cube-like styles (NORMAL/NORMAL24/SPRITE/unknown) share 'cube'.
export function geometryKeyForStyle(style: number): string {
  switch (style) {
    case BlockStyle.WEDGE: return 'wedge';
    case BlockStyle.CORNER: return 'corner';
    case BlockStyle.TETRA: return 'tetra';
    case BlockStyle.HEPTA: return 'hepta';
    default: return 'cube';
  }
}

// Whether a geometry key needs double-sided rendering (custom solids whose triangle
// winding isn't guaranteed outward — DoubleSide avoids invisible faces in the scaffold).
export function isCustomShape(key: string): boolean {
  return key !== 'cube';
}

// Build a fresh geometry for the given key. Not cached: meshes dispose their own geometry,
// so each instanced mesh owns its copy.
export function buildBlockGeometry(key: string, scale: number): BufferGeometry {
  switch (key) {
    case 'wedge': return buildWedge(scale);
    case 'corner': return buildCorner(scale);
    case 'tetra': return buildTetra(scale);
    case 'hepta': return buildHepta(scale);
    default: return new BoxGeometry(scale, scale, scale);
  }
}

/**
 * First-attempt orientation -> rotation. Currently identity for every block (scaffold):
 * shapes render in their canonical orientation so we can confirm geometry/detection first.
 *
 * TODO(verify-loop): map StarMade's per-style orientation byte (SegmentPiece.getOrientation())
 * to the correct rotation here. The encoding differs per BlockStyle; fill in once we compare
 * against a real ship.
 */
export function orientationQuaternion(_style: number, _orientation: number, out: Quaternion): Quaternion {
  return out.identity();
}

type V3 = [number, number, number];

function geomFromTris(tris: V3[]): BufferGeometry {
  const positions: number[] = [];
  for (const v of tris) positions.push(v[0], v[1], v[2]);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

function quad(a: V3, b: V3, c: V3, d: V3): V3[] { return [a, b, c, a, c, d]; }
function tri(a: V3, b: V3, c: V3): V3[] { return [a, b, c]; }

// Triangular prism: full back wall (z=-h) and floor (y=-h), sloping from the top-back
// edge down to the front-bottom edge.
function buildWedge(s: number): BufferGeometry {
  const h = s / 2;
  const a1: V3 = [-h, -h, -h], a2: V3 = [-h, h, -h], a3: V3 = [-h, -h, h];
  const b1: V3 = [h, -h, -h], b2: V3 = [h, h, -h], b3: V3 = [h, -h, h];
  return geomFromTris([
    ...tri(a3, a2, a1),       // left triangular side (x=-h)
    ...tri(b1, b2, b3),       // right triangular side (x=+h)
    ...quad(a1, a2, b2, b1),  // back wall (z=-h)
    ...quad(b1, b3, a3, a1),  // floor (y=-h)
    ...quad(a2, a3, b3, b2),  // slope
  ]);
}

// Small corner tetrahedron at the back-bottom-left corner (approximate).
function buildTetra(s: number): BufferGeometry {
  const h = s / 2;
  const p: V3 = [-h, -h, -h], x: V3 = [h, -h, -h], y: V3 = [-h, h, -h], z: V3 = [-h, -h, h];
  return geomFromTris([
    ...tri(p, x, y), ...tri(p, y, z), ...tri(p, z, x), ...tri(x, z, y),
  ]);
}

// Pyramid: full floor (y=-h) rising to a single top-back-left apex (approximate corner).
function buildCorner(s: number): BufferGeometry {
  const h = s / 2;
  const b1: V3 = [-h, -h, -h], b2: V3 = [h, -h, -h], b3: V3 = [h, -h, h], b4: V3 = [-h, -h, h];
  const apex: V3 = [-h, h, -h];
  return geomFromTris([
    ...quad(b1, b2, b3, b4),  // floor
    ...tri(b1, apex, b2),
    ...tri(b2, apex, b3),
    ...tri(b3, apex, b4),
    ...tri(b4, apex, b1),
  ]);
}

// Cube with the (+x,+y,+z) corner sliced off through its three neighbours (7 vertices).
function buildHepta(s: number): BufferGeometry {
  const h = s / 2;
  const O: V3 = [-h, -h, -h], X: V3 = [h, -h, -h], Y: V3 = [-h, h, -h], Z: V3 = [-h, -h, h];
  const XY: V3 = [h, h, -h], XZ: V3 = [h, -h, h], YZ: V3 = [-h, h, h];
  return geomFromTris([
    ...quad(O, X, XZ, Z),  // floor (y=-h)
    ...quad(O, X, XY, Y),  // back (z=-h)
    ...quad(O, Y, YZ, Z),  // left (x=-h)
    ...tri(Y, XY, YZ),     // top (cut)
    ...tri(X, XY, XZ),     // right (cut)
    ...tri(Z, XZ, YZ),     // front (cut)
    ...tri(XY, XZ, YZ),    // slope
  ]);
}
