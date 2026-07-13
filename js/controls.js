import * as THREE from 'three';
import { CollisionWorld, PLAYER_HEIGHT } from './collision.js';

const GRAVITY = 28;
const JUMP_VELOCITY = 9;
const MOVE_SPEED = 7;
const SPRINT_MULT = 1.45;
const MOUSE_IDLE_THRESHOLD = 0.15;

export class PlayerController {
  constructor(domElement, collisionWorld) {
    this.domElement = domElement;
    this.collisionWorld = collisionWorld;
    this.position = new THREE.Vector3();

    this.velocityY = 0;
    this.direction = new THREE.Vector3();
    this.moveInput = { forward: 0, right: 0 };
    this.keys = new Set();
    this.onGround = false;
    this.enabled = false;
    this.cameraYaw = 0;
    this.cameraPitch = 0;
    this.characterYaw = 0;
    this.timeSinceMouseMove = MOUSE_IDLE_THRESHOLD + 1;
    this.pointerLocked = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  disable() {
    this.enabled = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this.keys.clear();
    this.moveInput.forward = 0;
    this.moveInput.right = 0;
  }

  requestPointerLock() {
    this.domElement.requestPointerLock();
  }

  _onPointerLockChange() {
    this.pointerLocked = document.pointerLockElement === this.domElement;
  }

  _onKeyDown(event) {
    if (!this.enabled) return;
    this.keys.add(event.code);

    if (event.code === 'KeyW') this.moveInput.forward = 1;
    if (event.code === 'KeyS') this.moveInput.forward = -1;
    if (event.code === 'KeyA') this.moveInput.right = -1;
    if (event.code === 'KeyD') this.moveInput.right = 1;
  }

  _onKeyUp(event) {
    this.keys.delete(event.code);

    if (event.code === 'KeyW' && this.moveInput.forward === 1) this.moveInput.forward = 0;
    if (event.code === 'KeyS' && this.moveInput.forward === -1) this.moveInput.forward = 0;
    if (event.code === 'KeyA' && this.moveInput.right === -1) this.moveInput.right = 0;
    if (event.code === 'KeyD' && this.moveInput.right === 1) this.moveInput.right = 0;
  }

  _onMouseMove(event) {
    if (!this.pointerLocked) return;

    const sensitivity = 0.0022;
    this.cameraYaw -= event.movementX * sensitivity;
    this.cameraPitch -= event.movementY * sensitivity;
    this.characterYaw = this.cameraYaw;
    this.timeSinceMouseMove = 0;
  }

  isMouseIdle() {
    return this.timeSinceMouseMove >= MOUSE_IDLE_THRESHOLD;
  }

  isMoving() {
    return this.moveInput.forward !== 0 || this.moveInput.right !== 0;
  }

  applyRecoil(yawRad, pitchRad) {
    this.cameraYaw += yawRad;
    this.cameraPitch += pitchRad;
    const limit = Math.PI / 2 - 0.05;
    if (this.cameraPitch > limit) this.cameraPitch = limit;
    if (this.cameraPitch < -limit) this.cameraPitch = -limit;
    this.characterYaw = this.cameraYaw;
    this.timeSinceMouseMove = 0;
  }

  setPosition(x, y, z) {
    this.position.set(x, y, z);
    this.velocityY = 0;
    this.collisionWorld.liftToClear(this.position);
  }

  getFeetPosition(target = new THREE.Vector3()) {
    return target.copy(this.position);
  }

  getCameraForward(target = new THREE.Vector3()) {
    return target.set(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw)).normalize();
  }

  update(delta) {
    if (!this.enabled || !this.pointerLocked) return;

    this.timeSinceMouseMove += delta;

    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = MOVE_SPEED * (sprinting ? SPRINT_MULT : 1);

    this.direction.set(-this.moveInput.right, 0, this.moveInput.forward);
    if (this.direction.lengthSq() > 0) {
      this.direction.normalize();
    }

    const forward = this.getCameraForward(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
    const wish = new THREE.Vector3()
      .addScaledVector(forward, this.direction.z)
      .addScaledVector(right, this.direction.x);

    if (wish.lengthSq() > 0) {
      wish.normalize().multiplyScalar(speed * delta);
      this.collisionWorld.moveAndSlide(this.position, wish);

      if (this.isMouseIdle()) {
        this.characterYaw = Math.atan2(wish.x, wish.z);
      }
    } else if (!this.isMouseIdle()) {
      this.characterYaw = this.cameraYaw;
    }

    if (this.onGround && this.keys.has('Space')) {
      this.velocityY = JUMP_VELOCITY;
      this.onGround = false;
    }

    this.velocityY -= GRAVITY * delta;
    this.collisionWorld.moveVertical(this.position, this.velocityY, delta, this);
  }
}

export { PLAYER_HEIGHT };
