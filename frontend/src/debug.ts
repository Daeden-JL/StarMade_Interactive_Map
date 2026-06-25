import {
  AmbientLight,
  AxesHelper,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { BlockStyle, buildBlockGeometry, geometryKeyForStyle, orientationQuaternion } from './renderer/blockGeometry.ts';

// A standalone diagnostic grid: every non-cube block shape rendered in each orientation byte,
// using the same geometry/orientation code as the live map, so we can verify and fill in the
// StarMade orientation mappings by eye instead of hunting for examples on real ships.

type Status = 'confirmed' | 'hypothesis' | 'unhandled';

const STATUS_COLOR: Record<Status, number> = {
  confirmed: 0x3aff7a,
  hypothesis: 0xffc14d,
  unhandled: 0xff5a5a,
};

// Which orientations are currently handled, mirroring orientationQuaternion().
function statusFor(style: number, o: number): Status {
  if (style === BlockStyle.WEDGE) return o <= 3 ? 'confirmed' : 'hypothesis';
  if (style === BlockStyle.TETRA) return o <= 3 ? 'confirmed' : 'unhandled';
  return 'unhandled'; // CORNER, HEPTA: no mapping yet
}

// Rows of the grid. Wedges have 12 orientations; corner/tetra/hepta use the full 0-23.
const SHAPES: Array<{ name: string; style: number; count: number }> = [
  { name: 'WEDGE', style: BlockStyle.WEDGE, count: 12 },
  { name: 'CORNER', style: BlockStyle.CORNER, count: 24 },
  { name: 'TETRA', style: BlockStyle.TETRA, count: 24 },
  { name: 'HEPTA', style: BlockStyle.HEPTA, count: 24 },
];

const SPACING = 2.4;

const root = document.getElementById('debug-root')!;

const scene = new Scene();
scene.background = new Color(0x0a0e14);

const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);

const renderer = new WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
root.appendChild(renderer.domElement);

// CSS2D overlay for crisp text labels aligned to the 3D cells.
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.className = 'label-overlay';
root.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, labelRenderer.domElement);
controls.enableDamping = true;

// Lighting tuned to read flat-shaded faces clearly from any orbit angle.
scene.add(new AmbientLight(0x556070, 1.4));
const key = new DirectionalLight(0xffffff, 2.2);
key.position.set(1, 2, 1.5);
scene.add(key);
const fill = new DirectionalLight(0x88aaff, 0.8);
fill.position.set(-1.5, 1, -1);
scene.add(fill);

const cubeEdges = new EdgesGeometry(new BoxGeometry(1, 1, 1));
const edgeMaterial = new LineBasicMaterial({ color: 0x33506e });
const tmpQuat = new Quaternion();

function makeLabel(text: string, className: string, y: number): CSS2DObject {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  const obj = new CSS2DObject(div);
  obj.position.set(0, y, 0);
  return obj;
}

const COLS = 12; // orientations per visual row before wrapping
let cellRow = 0;
SHAPES.forEach((shape) => {
  const geomKey = geometryKeyForStyle(shape.style);
  const startRow = cellRow;

  // Shape name label at the left of the shape's first row.
  const rowLabel = makeLabel(shape.name, 'row-label', 0.7);
  rowLabel.position.set(-SPACING * 1.5, 0.7, -startRow * SPACING);
  scene.add(rowLabel);

  for (let o = 0; o < shape.count; o++) {
    const col = o % COLS;
    const sub = Math.floor(o / COLS);
    const cell = new Group();
    cell.position.set(col * SPACING, 0, -(startRow + sub) * SPACING);

    const status = statusFor(shape.style, o);
    const material = new MeshStandardMaterial({
      color: STATUS_COLOR[status],
      flatShading: true,
      roughness: 0.55,
      metalness: 0.05,
      side: DoubleSide, // custom shapes don't guarantee outward winding
    });
    const mesh = new Mesh(buildBlockGeometry(geomKey, 1), material);
    mesh.quaternion.copy(orientationQuaternion(shape.style, o, tmpQuat));
    cell.add(mesh);

    // Faint unit-cube outline so the block's extent within its cell is visible.
    cell.add(new LineSegments(cubeEdges, edgeMaterial));

    // Per-cell axes reference (X red / Y green / Z blue).
    cell.add(new AxesHelper(0.85));

    // Orientation byte label under the cell.
    const label = makeLabel(String(o), 'cell-label', -0.95);
    label.element.style.color = '#' + STATUS_COLOR[status].toString(16).padStart(6, '0');
    cell.add(label);

    scene.add(cell);
  }

  cellRow = startRow + Math.ceil(shape.count / COLS) + 1; // blank row between shapes
});

// Frame the whole grid.
const totalRows = cellRow;
const gridW = COLS * SPACING;
const cx = ((COLS - 1) * SPACING) / 2;
const cz = -((totalRows - 1) * SPACING) / 2;
controls.target.set(cx, 0, cz);
camera.position.set(cx, gridW * 0.85, cz + gridW * 0.6);
controls.update();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();
