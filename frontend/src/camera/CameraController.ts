import { PerspectiveCamera, Vector3, MathUtils } from 'three';

export type CameraMode = 'FLY' | 'ORBIT' | 'FPV';

export class CameraController {
  private camera: PerspectiveCamera;
  private domElement: HTMLElement;
  
  public mode: CameraMode = 'FLY';
  
  // Fly Mode state
  private flySpeed = 50.0; // Units per second
  private maxFlySpeed = 500.0;
  private minFlySpeed = 5.0;
  private moveForward = false;
  private moveBackward = false;
  private moveLeft = false;
  private moveRight = false;
  private moveUp = false;
  private moveDown = false;
  private yaw = 0.0;
  private pitch = 0.0;
  
  // Orbit Mode state
  private targetPos = new Vector3(0, 0, 0);
  private orbitRadius = 150.0;
  private targetOrbitRadius = 150.0;
  private minOrbitRadius = 10.0;
  private maxOrbitRadius = 5000000.0;
  private theta = 0.0; // Azimuthal angle (X-Z plane)
  private phi = Math.PI / 4.0; // Polar angle (Y axis offset)
  private orbitSpeed = 0.005;
  private zoomSpeed = 0.1;
  
  // Shared drag state. dragButton: 0 = left (pan), 2 = right (rotate), null = none
  private dragButton: number | null = null;
  private previousMousePosition = { x: 0, y: 0 };
  
  // Reference object to follow
  private followTarget: { getPosition: () => Vector3 } | null = null;

  // First-person (FPV) mode state: pointer is locked and mouse movement drives the look
  private pointerLocked = false;
  private lookSensitivity = 0.002;
  private onPointerLockChange: ((locked: boolean) => void) | null = null;

  constructor(camera: PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    
    // Position camera initially
    this.camera.position.set(0, 100, 300);
    this.camera.lookAt(0, 0, 0);
    
    this.setupListeners();
  }

  public setMode(mode: CameraMode) {
    // Release the mouse when leaving first-person mode.
    if (mode !== 'FPV' && this.pointerLocked) {
      document.exitPointerLock();
    }
    this.mode = mode;
    if (mode === 'ORBIT') {
      // Transition settings
      if (this.followTarget) {
        this.targetPos.copy(this.followTarget.getPosition());
      } else {
        // Look at current look direction at a distance
        const dir = new Vector3();
        this.camera.getWorldDirection(dir);
        this.targetPos.copy(this.camera.position).addScaledVector(dir, 150);
      }
      
      // Calculate theta, phi, and radius based on current camera relative position
      const offset = new Vector3().copy(this.camera.position).sub(this.targetPos);
      this.orbitRadius = MathUtils.clamp(offset.length(), this.minOrbitRadius, this.maxOrbitRadius);
      this.targetOrbitRadius = this.orbitRadius;
      
      this.theta = Math.atan2(offset.x, offset.z);
      this.phi = Math.acos(MathUtils.clamp(offset.y / this.orbitRadius, -0.99, 0.99));
    } else {
      // Transitioning to a free-look mode (FLY or FPV): retain current orientation angles.
      const dir = new Vector3();
      this.camera.getWorldDirection(dir);
      this.yaw = Math.atan2(dir.x, dir.z);
      this.pitch = Math.asin(dir.y);
    }
  }

  public focusOn(target: { getPosition: () => Vector3 } | null) {
    this.followTarget = target;
    if (target) {
      this.targetPos.copy(target.getPosition());
      this.setMode('ORBIT');
    }
  }

  public getTargetPosition(): Vector3 {
    return this.targetPos;
  }

  public update(deltaTime: number) {
    if (this.mode === 'FLY') {
      this.updateFlyMode(deltaTime, false);
    } else if (this.mode === 'FPV') {
      this.updateFlyMode(deltaTime, true);
    } else if (this.mode === 'ORBIT') {
      this.updateOrbitMode(deltaTime);
    }
  }

  // fullDirection: FPV flies along the full look vector; FLY keeps W/S level with the horizon.
  private updateFlyMode(deltaTime: number, fullDirection: boolean = false) {
    const moveDir = new Vector3();
    const forwardDir = new Vector3();
    this.camera.getWorldDirection(forwardDir);
    if (!fullDirection) forwardDir.y = 0; // lock to horizontal plane for navigation
    forwardDir.normalize();

    const rightDir = new Vector3().crossVectors(forwardDir, new Vector3(0, 1, 0)).normalize();

    if (this.moveForward) moveDir.add(forwardDir);
    if (this.moveBackward) moveDir.sub(forwardDir);
    if (this.moveLeft) moveDir.sub(rightDir);
    if (this.moveRight) moveDir.add(rightDir);
    if (this.moveUp) moveDir.y += 1;
    if (this.moveDown) moveDir.y -= 1;

    moveDir.normalize();
    this.camera.position.addScaledVector(moveDir, this.flySpeed * deltaTime);

    // Apply rotation
    const targetDir = new Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    ).normalize();
    
    const lookTarget = new Vector3().copy(this.camera.position).add(targetDir);
    this.camera.lookAt(lookTarget);
  }

  private updateOrbitMode(_deltaTime: number) {
    if (this.followTarget) {
      // Smoothly interpolate to moving target
      this.targetPos.lerp(this.followTarget.getPosition(), 0.1);
    }

    // Smoothly interpolate orbit radius towards target orbit radius
    this.orbitRadius += (this.targetOrbitRadius - this.orbitRadius) * 0.1;

    // Clamp polar angle (phi) to prevent flipping over the poles
    this.phi = MathUtils.clamp(this.phi, 0.05, Math.PI - 0.05);

    // Compute cartesian coordinates
    const offset = new Vector3(
      this.orbitRadius * Math.sin(this.theta) * Math.sin(this.phi),
      this.orbitRadius * Math.cos(this.phi),
      this.orbitRadius * Math.cos(this.theta) * Math.sin(this.phi)
    );

    this.camera.position.copy(this.targetPos).add(offset);
    this.camera.lookAt(this.targetPos);
  }

  public setOrbitRadius(radius: number) {
    this.targetOrbitRadius = MathUtils.clamp(radius, this.minOrbitRadius, this.maxOrbitRadius);
  }

  // Right-click drag: look around (FLY) or orbit the focus point (ORBIT).
  private rotateView(deltaX: number, deltaY: number) {
    if (this.mode === 'FLY') {
      const sensitivity = 0.003;
      this.yaw -= deltaX * sensitivity;
      this.pitch -= deltaY * sensitivity;

      // Clamp pitch to look almost straight up/down but not past
      const maxPitch = Math.PI / 2.0 - 0.02;
      this.pitch = MathUtils.clamp(this.pitch, -maxPitch, maxPitch);
    } else {
      this.theta -= deltaX * this.orbitSpeed;
      this.phi -= deltaY * this.orbitSpeed;
    }
  }

  // Left-click drag: pan in the screen plane so the grabbed point tracks the cursor.
  private panView(deltaX: number, deltaY: number) {
    const right = new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);

    if (this.mode === 'FLY') {
      // Scale with fly speed so panning feels consistent at any navigation scale.
      const panScale = this.flySpeed * 0.02;
      this.camera.position.addScaledVector(right, -deltaX * panScale);
      this.camera.position.addScaledVector(up, deltaY * panScale);
    } else {
      // Move the orbit focus point; scale with distance for a consistent feel.
      // Panning detaches any followed object so the new focus sticks.
      this.followTarget = null;
      const panScale = this.orbitRadius * 0.0015;
      this.targetPos.addScaledVector(right, -deltaX * panScale);
      this.targetPos.addScaledVector(up, deltaY * panScale);
    }
  }

  private setupListeners() {
    // Keyboard handlers
    window.addEventListener('keydown', (e) => {
      this.handleKey(e.code, e.key, true);
    });
    
    window.addEventListener('keyup', (e) => {
      this.handleKey(e.code, e.key, false);
    });

    // Mouse drag handlers: hold right-click to rotate, hold left-click to pan.
    this.domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 2) {
        this.dragButton = e.button;
        this.previousMousePosition = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('mousemove', (e) => {
      // First-person look: while the pointer is locked, mouse movement drives yaw/pitch directly.
      if (this.mode === 'FPV' && this.pointerLocked) {
        this.yaw -= e.movementX * this.lookSensitivity;
        this.pitch -= e.movementY * this.lookSensitivity;
        const maxPitch = Math.PI / 2.0 - 0.02;
        this.pitch = MathUtils.clamp(this.pitch, -maxPitch, maxPitch);
        return;
      }

      if (this.dragButton === null) return;

      const deltaX = e.clientX - this.previousMousePosition.x;
      const deltaY = e.clientY - this.previousMousePosition.y;
      this.previousMousePosition = { x: e.clientX, y: e.clientY };

      if (this.dragButton === 2) {
        this.rotateView(deltaX, deltaY);
      } else {
        this.panView(deltaX, deltaY);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === this.dragButton) {
        this.dragButton = null;
      }
    });

    // Mouse wheel zoom
    this.domElement.addEventListener('wheel', (e) => {
      e.preventDefault(); // Prevent standard page scroll
      if (this.mode === 'FLY' || this.mode === 'FPV') {
        // Zoom in/out of the map by moving camera forward/backward along the look direction
        const dir = new Vector3();
        this.camera.getWorldDirection(dir);
        const zoomDistance = this.flySpeed * 1.5; // Zoom speed proportional to fly speed!
        const sign = Math.sign(e.deltaY); // -1 for scroll up (zoom in), +1 for scroll down (zoom out)
        this.camera.position.addScaledVector(dir, -sign * zoomDistance);
      } else if (this.mode === 'ORBIT') {
        // Mouse wheel zooms target radius
        const zoomDelta = e.deltaY * this.zoomSpeed;
        this.targetOrbitRadius = MathUtils.clamp(
          this.targetOrbitRadius + zoomDelta * (this.targetOrbitRadius * 0.01), // logarithmic scroll speed
          this.minOrbitRadius,
          this.maxOrbitRadius
        );
      }
    });

    // Prevent context menu
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    // First-person mode: click the canvas to capture the mouse; Esc (browser default) releases it.
    this.domElement.addEventListener('click', () => {
      if (this.mode === 'FPV' && !this.pointerLocked) {
        this.domElement.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.domElement;
      if (this.onPointerLockChange) this.onPointerLockChange(this.pointerLocked);
    });
  }

  private adjustSpeed(delta: number) {
    this.flySpeed = MathUtils.clamp(this.flySpeed + delta, this.minFlySpeed, this.maxFlySpeed);
    const speedIndicator = document.getElementById('speed-value');
    if (speedIndicator) {
      speedIndicator.innerText = `${Math.round(this.flySpeed)} m/s`;
    }
  }

  private handleKey(code: string, key: string, isDown: boolean) {
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this.moveForward = isDown;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.moveBackward = isDown;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.moveLeft = isDown;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.moveRight = isDown;
        break;
      case 'KeyE': // ascend
        this.moveUp = isDown;
        break;
      case 'KeyQ': // descend
        this.moveDown = isDown;
        break;
      case 'Equal': // '+' key (without Shift, Equal; with Shift, Plus)
      case 'NumpadAdd':
        if (isDown) {
          this.adjustSpeed(5);
        }
        break;
      case 'Minus': // '-' key
      case 'NumpadSubtract':
        if (isDown) {
          this.adjustSpeed(-5);
        }
        break;
    }

    // Fallback using e.key character for speed adjustments (e.g. non-US layout, Shift modifier)
    if (isDown && code !== 'Equal' && code !== 'NumpadAdd' && code !== 'Minus' && code !== 'NumpadSubtract') {
      if (key === '+' || key === '=') {
        this.adjustSpeed(5);
      } else if (key === '-') {
        this.adjustSpeed(-5);
      }
    }
  }

  public getFlySpeed(): number {
    return this.flySpeed;
  }

  public setPointerLockCallback(cb: (locked: boolean) => void) {
    this.onPointerLockChange = cb;
  }

  public isPointerLocked(): boolean {
    return this.pointerLocked;
  }
}
