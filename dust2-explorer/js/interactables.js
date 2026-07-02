import * as THREE from 'three';

const INTERACT_RADIUS = 2.8;

export const PORTFOLIO_ITEMS = [
  {
    id: 'about',
    label: 'About Me',
    title: 'About Me',
    body: 'Placeholder — your bio, background, and what you build will live here.',
    color: 0xffc850,
    offset: new THREE.Vector3(0, 1.2, -4),
  },
  {
    id: 'projects',
    label: 'Projects',
    title: 'Projects',
    body: 'Placeholder — link out to featured work, demos, and case studies.',
    color: 0x50c8ff,
    offset: new THREE.Vector3(5, 1.2, 2),
  },
  {
    id: 'contact',
    label: 'Contact',
    title: 'Contact',
    body: 'Placeholder — email, socials, and hire-me CTA.',
    color: 0xc850ff,
    offset: new THREE.Vector3(-5, 1.2, 3),
  },
];

export class InteractableManager {
  constructor(scene, anchor) {
    this.scene = scene;
    this.anchor = anchor;
    this.group = new THREE.Group();
    this.items = [];
    this.nearest = null;
    this.scene.add(this.group);
  }

  build() {
    for (const data of PORTFOLIO_ITEMS) {
      const item = this._createMarker(data);
      this.items.push(item);
      this.group.add(item.mesh);
    }
  }

  _createMarker(data) {
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.85, 0.12),
      new THREE.MeshStandardMaterial({
        color: data.color,
        emissive: data.color,
        emissiveIntensity: 0.35,
        metalness: 0.2,
        roughness: 0.4,
      }),
    );

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(0.75, 1.05, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.5, roughness: 0.6 }),
    );
    frame.position.z = -0.06;

    const glow = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.72, 32),
      new THREE.MeshBasicMaterial({ color: data.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.55;

    const mesh = new THREE.Group();
    mesh.add(frame, core, glow);
    mesh.position.copy(data.offset);
    mesh.userData = { interactable: data };

    return { data, mesh, glow, core };
  }

  update(playerPosition, elapsed) {
    let closest = null;
    let closestDist = Infinity;

    for (const item of this.items) {
      const worldPos = item.mesh.getWorldPosition(new THREE.Vector3());
      const dist = worldPos.distanceTo(playerPosition);

      item.glow.material.opacity = 0.35 + Math.sin(elapsed * 3 + dist) * 0.12;
      item.core.position.z = 0.06 + Math.sin(elapsed * 2.5) * 0.03;

      if (dist < INTERACT_RADIUS && dist < closestDist) {
        closest = item;
        closestDist = dist;
      }
    }

    this.nearest = closest;
    return closest;
  }

  getNearest() {
    return this.nearest;
  }
}
