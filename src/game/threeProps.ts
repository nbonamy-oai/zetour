import * as THREE from "three";
import type { PowerUpType } from "../core/gameStore";

const material = (color: number, metalness = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness: metalness ? 0.3 : 0.65 });

export const createRoadReward = (type: "sweat" | "cash" | PowerUpType): THREE.Group => {
  const root = new THREE.Group();
  const colors = { sweat: 0x3be0da, cash: 0xffc849, "super-draft": 0x66f2c1, "lucky-bidon": 0x4ec5ff, jump: 0xd5a3ff };
  const color = colors[type];
  const finish = material(color, type === "cash" ? 0.72 : 0.25);
  const white = material(0xf4faf5);
  const model = new THREE.Group();
  if (type === "sweat") {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.2, 0.7, 16), finish);
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.23, 0.15, 16), finish);
    shoulder.position.y = 0.42;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.11, 16), white);
    cap.position.y = 0.55;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.08, 10), material(0x203c46));
    nozzle.position.y = 0.64;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.236, 0.236, 0.17, 16), white);
    model.add(body, shoulder, cap, nozzle, band);
    model.rotation.z = -0.18;
  } else if (type === "cash") {
    for (let i = 0; i < 3; i += 1) {
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.09, 24), finish);
      coin.rotation.x = Math.PI / 2;
      coin.position.set((i - 1) * 0.18, (i - 1) * 0.15, -i * 0.12);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.021, 6, 24), material(0xffe9a3, 0.7));
      rim.position.copy(coin.position).z += 0.05;
      model.add(coin, rim);
    }
  } else {
    const shape = new THREE.Shape();
    const points = type === "jump"
      ? [[-0.42, 0.42], [0, 0.55], [0.42, 0.42], [0.36, -0.16], [0, -0.55], [-0.36, -0.16]]
      : type === "lucky-bidon"
        ? [[0.12, 0.63], [-0.38, -0.05], [-0.05, -0.05], [-0.18, -0.63], [0.4, 0.16], [0.06, 0.16]]
        : [[-0.43, -0.38], [0, -0.05], [0.43, -0.38], [0.43, -0.05], [0, 0.3], [-0.43, -0.05]];
    points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
    shape.closePath();
    const icon = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.04, bevelThickness: 0.04 }), finish);
    model.add(icon);
    if (type === "super-draft") {
      const second = icon.clone();
      second.position.y = 0.42;
      model.add(second);
    }
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(0.83, 0.035, 8, 40), finish);
    model.add(orbit);
  }
  root.add(model);
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.57, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false }));
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -0.78;
  root.add(halo);
  root.userData.rewardModel = model;
  root.traverse((child) => { if (child instanceof THREE.Mesh) child.castShadow = child !== halo; });
  return root;
};

export const createPothole = (): THREE.Group => {
  const root = new THREE.Group();
  const vertices: number[] = [];
  const indices: number[] = [];
  const segments = 15;
  for (let ring = 0; ring < 2; ring += 1) {
    for (let i = 0; i < segments; i += 1) {
      const angle = i / segments * Math.PI * 2;
      const radius = (ring ? 0.7 : 1) * (0.87 + Math.sin(i * 8.3) * 0.1);
      vertices.push(Math.cos(angle) * radius, ring ? 0.026 : 0.08 + Math.sin(i * 3.4) * 0.035, Math.sin(angle) * radius * 0.7);
      if (!ring) {
        const next = (i + 1) % segments;
        indices.push(i, next, i + segments, next, next + segments, i + segments);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const rim = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x666365, flatShading: true, roughness: 1, side: THREE.DoubleSide }));
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.77, segments), new THREE.MeshBasicMaterial({ color: 0x151f23 }));
  hole.rotation.x = -Math.PI / 2;
  hole.scale.y = 0.7;
  hole.position.y = 0.02;
  root.add(rim, hole);
  for (let i = 0; i < 7; i += 1) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.06 + i % 3 * 0.025), material(0x77787a));
    const angle = i * 2.4;
    rock.position.set(Math.cos(angle) * 1.04, 0.06, Math.sin(angle) * 0.8);
    rock.castShadow = true;
    root.add(rock);
  }
  return root;
};

export const disposeRoadObject = (root: THREE.Object3D): void => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      geometries.add(child.geometry);
      if (child.customDepthMaterial) materials.add(child.customDepthMaterial);
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
    if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
      (Array.isArray(child.material) ? child.material : [child.material]).forEach((entry) => materials.add(entry));
    }
  });
  geometries.forEach((entry) => entry.dispose());
  materials.forEach((entry) => entry.dispose());
};
