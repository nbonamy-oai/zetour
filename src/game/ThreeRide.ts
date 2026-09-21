import * as THREE from "three";
import { ThreeLandscape, roadBend, roadHeading, threeRoadPitch, applyRoadPitch, roadSurfaceHeight, roadSurfacePitch } from "./threeLandscape";
import { createRoadReward, createPothole, disposeRoadObject } from "./threeProps";
import { ThreeSlipstream } from "./threeSlipstream";
import { createRoadVehicle, animateRoadVehicle } from "./threeVehicles";
import { gameAudio } from "../audio/gameAudio";
import {
  gameStore,
  powerUpDefinitions,
  stages,
  type GameSnapshot,
  type PowerUpType,
} from "../core/gameStore";
import { RANDOM_RIDER_DRAFT_BONUS } from "../core/drafting";
import { formatCompactNumber } from "../core/format";
import {
  addFlow,
  createTrafficGauntlet,
  decayFlow,
  draftRulesForStage,
  encounterChallengeRules,
  encounterDelayRange,
  encounterLabel,
  flowMultiplier,
  lootSequenceForStage,
  moveLane,
  nextEncounter,
  oncomingTrafficSpeedMultiplier,
  roadPowerUpChoices,
  trafficColumnSpacing,
  type RideEncounter,
} from "./rideSystems";
import { readVisualQaOverrides } from "./visualQa";

export const THREE_LANE_X = [-2.75, 0, 2.75] as const;
export type ThreeRiderRole = "main" | "draft" | "teammate";
export const threeRiderModelScale = (_role: ThreeRiderRole): number => 0.8;
export const threeWorldSpeed = (speedKmh: number): number =>
  Math.max(0, speedKmh) * 0.54;
export const threePedalCadenceRpm = (speedKmh: number): number =>
  speedKmh <= 0
    ? 0
    : THREE.MathUtils.clamp(speedKmh * 3.25, 70, 100);
export const threeEncounterZ = (offset = 0): number => -58 - offset / 7.5;
export const isThreeLaneCollision = (
  riderX: number,
  objectX: number,
  riderZ: number,
  objectZ: number,
): boolean =>
  Math.abs(riderX - objectX) < 1.05 && Math.abs(riderZ - objectZ) < 1.35;

type LootType = "sweat" | "cash";
type HazardType = "pothole" | "oncoming-car" | "oncoming-van";
type WorldObjectType = LootType | HazardType | PowerUpType;

interface WorldObject {
  mesh: THREE.Object3D;
  type: WorldObjectType;
  lane: number;
  sequenceId?: number;
  sequenceIndex?: number;
  sequenceFailed?: boolean;
  choiceId?: number;
  speedMultiplier: number;
  passedRider: boolean;
}

interface ChallengeRun {
  encounter: RideEncounter;
  totalPickups: number;
  collectedPickups: number;
  failed: boolean;
}

interface Announcement {
  message: string;
  tone: "neutral" | "good" | "bad";
  until: number;
}

interface CyclistLegRig {
  side: number;
  shorts: THREE.Mesh;
  thigh: THREE.Mesh;
  knee: THREE.Mesh;
  calf: THREE.Mesh;
  sock: THREE.Mesh;
  shoe: THREE.Mesh;
  crankArm: THREE.Mesh;
  pedal: THREE.Mesh;
}

interface FanArmRig {
  pivot: THREE.Group;
  baseRotation: number;
  amplitude: number;
  phaseOffset: number;
}

export interface ThreeRideCallbacks {
  onAnnouncement: (announcement: Announcement | null) => void;
  onCameraChange: (camera: ThreeCameraMode) => void;
  onFlowChange: (flow: number, combo: number) => void;
}

export type ThreeCameraMode = "Chase" | "First person" | "Wide" | "Roadside" | "Helicopter";

const CAMERA_MODES: readonly ThreeCameraMode[] = [
  "Chase",
  "First person",
  "Wide",
  "Roadside",
  "Helicopter",
];

const VISUAL_QA = readVisualQaOverrides();
const RIDER_Z = 1.1;
const WORLD_END_Z = 10;
const WORLD_WRAP_LENGTH = 180;
const MAX_PIXEL_RATIO = 2;
const RANDOM_DRAFT_PERCENT = Math.round(RANDOM_RIDER_DRAFT_BONUS * 100);

const stagePalette = [
  { sky: 0xa8d7e7, fog: 0xd6e4db, verge: 0xa4b783, soil: 0xb79c73, mountain: 0x9db9ac },
  { sky: 0xc2d8d4, fog: 0xd9dcc6, verge: 0xa3b184, soil: 0xb89a73, mountain: 0xa6b6a4 },
  { sky: 0xa0d3e4, fog: 0xd4e2dd, verge: 0x9fae7d, soil: 0xb49870, mountain: 0x91b3ac },
  { sky: 0xb2ced8, fog: 0xd5d9ca, verge: 0xa2ad7e, soil: 0xaa9275, mountain: 0x9bafa7 },
  { sky: 0xa4cadb, fog: 0xd0dbd7, verge: 0x8fa178, soil: 0xa49078, mountain: 0x8ca39e },
] as const;

const randomBetween = (minimum: number, maximum: number): number =>
  minimum + Math.random() * (maximum - minimum);
const randomInt = (minimum: number, maximum: number): number =>
  Math.floor(randomBetween(minimum, maximum + 1));
const isPowerUpType = (type: WorldObjectType): type is PowerUpType =>
  Object.hasOwn(powerUpDefinitions, type);
const isTraffic = (type: WorldObjectType): type is "oncoming-car" | "oncoming-van" =>
  type === "oncoming-car" || type === "oncoming-van";

const meshMaterial = (color: number, roughness = 0.82): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.03, flatShading: true });

const applyShadow = (object: THREE.Object3D): void => {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
};

const tubeBetween = (
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): THREE.Mesh => {
  const direction = end.clone().sub(start);
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 7),
    material,
  );
  tube.position.copy(start).add(end).multiplyScalar(0.5);
  tube.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  return tube;
};

const taperedLimb = (
  start: THREE.Vector3,
  end: THREE.Vector3,
  startRadius: number,
  endRadius: number,
  material: THREE.Material,
): THREE.Mesh => {
  const limb = new THREE.Mesh(new THREE.CylinderGeometry(endRadius, startRadius, start.distanceTo(end), 16), material);
  limb.position.copy(start).add(end).multiplyScalar(0.5);
  limb.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
  return limb;
};

// Local hand coordinates: wrist toward +Z, fingers reach forward around a hood.
const createHand = (side: number, skin: THREE.Material): THREE.Group => {
  const hand = new THREE.Group();
  const glove = new THREE.MeshStandardMaterial({ color: 0x26333b, roughness: 0.96 });
  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), glove);
  palm.scale.set(0.042, 0.026, 0.058);
  palm.position.set(0, 0.025, 0);
  hand.add(palm);
  const wrist = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), skin);
  wrist.scale.set(0.029, 0.024, 0.045);
  wrist.position.set(0, 0.012, 0.05);
  hand.add(wrist);
  const cuff = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), glove);
  cuff.scale.set(0.032, 0.027, 0.018);
  cuff.position.set(0, 0.014, 0.042);
  hand.add(cuff);
  const digit = (points: THREE.Vector3[], radius: number): void => {
    points.forEach((point, index) => {
      const joint = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), index === 0 ? glove : skin);
      joint.position.copy(point);
      hand.add(joint);
      if (index) hand.add(taperedLimb(points[index - 1], point, radius, radius * 0.88, index === 1 ? glove : skin));
    });
  };
  for (let finger = 0; finger < 4; finger += 1) {
    const x = (finger - 1.5) * 0.02;
    const reach = [0.082, 0.096, 0.089, 0.07][finger];
    digit([
      new THREE.Vector3(x, 0.03, -0.037),
      new THREE.Vector3(x, 0.025, -reach),
      new THREE.Vector3(x, -0.009, -reach - 0.013),
      new THREE.Vector3(x, -0.028, -reach + 0.013),
    ], finger === 3 ? 0.008 : 0.0095);
  }
  digit([
    new THREE.Vector3(-side * 0.032, 0.015, 0.015),
    new THREE.Vector3(-side * 0.06, 0, -0.008),
    new THREE.Vector3(-side * 0.054, -0.025, -0.04),
    new THREE.Vector3(-side * 0.033, -0.028, -0.055),
  ], 0.012);
  return hand;
};

const unitTube = (
  radius: number,
  material: THREE.Material,
  radialSegments = 8,
): THREE.Mesh =>
  new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 1, radialSegments),
    material,
  );

const placeTube = (
  tube: THREE.Mesh,
  start: THREE.Vector3,
  end: THREE.Vector3,
): void => {
  const direction = end.clone().sub(start);
  tube.position.copy(start).add(end).multiplyScalar(0.5);
  tube.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.clone().normalize(),
  );
  tube.scale.set(1, direction.length(), 1);
};

const createJerseyGeometry = (): THREE.BufferGeometry => {
  const rings = [
    { y: -0.28, radiusX: 0.215, radiusZ: 0.17 },
    { y: -0.18, radiusX: 0.225, radiusZ: 0.18 },
    { y: 0.09, radiusX: 0.285, radiusZ: 0.205 },
    { y: 0.19, radiusX: 0.26, radiusZ: 0.19 },
    { y: 0.28, radiusX: 0.145, radiusZ: 0.14 },
  ];
  const segments = 10;
  const vertices: number[] = [];
  const indices: number[] = [];
  rings.forEach((ring) => {
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      vertices.push(
        Math.cos(angle) * ring.radiusX,
        ring.y,
        Math.sin(angle) * ring.radiusZ,
      );
    }
  });
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const lower = ring * segments + segment;
      const lowerNext = ring * segments + next;
      const upper = (ring + 1) * segments + segment;
      const upperNext = (ring + 1) * segments + next;
      indices.push(lower, upper, lowerNext, lowerNext, upper, upperNext);
    }
  }
  const bottomCenter = vertices.length / 3;
  vertices.push(0, rings[0].y, 0);
  const topCenter = vertices.length / 3;
  vertices.push(0, rings[rings.length - 1].y, 0);
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    indices.push(bottomCenter, next, segment);
    const topOffset = (rings.length - 1) * segments;
    indices.push(topCenter, topOffset + segment, topOffset + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

const createFanShirtGeometry = (): THREE.BufferGeometry => {
  const rings = [
    { y: -0.38, radiusX: 0.22, radiusZ: 0.17 },
    { y: -0.27, radiusX: 0.245, radiusZ: 0.18 },
    { y: 0.19, radiusX: 0.31, radiusZ: 0.205 },
    { y: 0.29, radiusX: 0.265, radiusZ: 0.19 },
    { y: 0.36, radiusX: 0.13, radiusZ: 0.135 },
  ];
  const segments = 8;
  const vertices: number[] = [];
  const indices: number[] = [];
  rings.forEach((ring) => {
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      vertices.push(
        Math.cos(angle) * ring.radiusX,
        ring.y,
        Math.sin(angle) * ring.radiusZ,
      );
    }
  });
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const lower = ring * segments + segment;
      const lowerNext = ring * segments + next;
      const upper = (ring + 1) * segments + segment;
      const upperNext = (ring + 1) * segments + next;
      indices.push(lower, upper, lowerNext, lowerNext, upper, upperNext);
    }
  }
  const bottomCenter = vertices.length / 3;
  vertices.push(0, rings[0].y, 0);
  const topCenter = vertices.length / 3;
  vertices.push(0, rings[rings.length - 1].y, 0);
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    indices.push(bottomCenter, next, segment);
    const topOffset = (rings.length - 1) * segments;
    indices.push(topCenter, topOffset + segment, topOffset + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

const positionCyclistLegs = (
  cyclist: THREE.Group,
  pedalPhase: number,
): void => {
  const legs = cyclist.userData.legs as CyclistLegRig[] | undefined;
  if (!legs) return;
  const crank = new THREE.Vector3(0, 0.66, 0.08);
  legs.forEach((leg, index) => {
    const phase = pedalPhase + index * Math.PI;
    const hip = new THREE.Vector3(leg.side * 0.14, 1.02, 0.17);
    const foot = new THREE.Vector3(
      leg.side * 0.175,
      crank.y + Math.sin(phase) * 0.18,
      crank.z + Math.cos(phase) * 0.18,
    );
    const deltaY = foot.y - hip.y;
    const deltaZ = foot.z - hip.z;
    const distance = Math.max(0.001, Math.hypot(deltaY, deltaZ));
    const segmentLength = 0.385;
    const bend = Math.sqrt(Math.max(0, segmentLength ** 2 - (distance * 0.5) ** 2));
    const knee = new THREE.Vector3(
      leg.side * 0.155,
      (hip.y + foot.y) * 0.5 - (deltaZ / distance) * bend,
      (hip.z + foot.z) * 0.5 + (deltaY / distance) * bend,
    );
    const shortsEnd = hip.clone().lerp(knee, 0.48);
    const thighStart = hip.clone().lerp(knee, 0.34);
    const calfEnd = knee.clone().lerp(foot, 0.66);
    const sockStart = knee.clone().lerp(foot, 0.62);
    placeTube(leg.shorts, hip, shortsEnd);
    placeTube(leg.thigh, thighStart, knee);
    placeTube(leg.calf, knee, calfEnd);
    placeTube(leg.sock, sockStart, foot);
    placeTube(
      leg.crankArm,
      crank.clone().add(new THREE.Vector3(leg.side * 0.07, 0, 0)),
      foot,
    );
    leg.knee.position.copy(knee);
    leg.pedal.position.copy(foot).add(new THREE.Vector3(0, -0.035, 0));
    leg.shoe.position.copy(foot).add(new THREE.Vector3(0, 0.015, -0.045));
    leg.shoe.rotation.set(-0.08 + Math.sin(phase) * 0.12, 0, 0);
  });
};

const wheel = (): { root: THREE.Group; spinner: THREE.Group } => {
  const root = new THREE.Group();
  const spinner = new THREE.Group();
  const tire = new THREE.Mesh(
    new THREE.TorusGeometry(0.43, 0.028, 10, 40),
    meshMaterial(0x211915, 0.68),
  );
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.385, 0.026, 8, 40),
    meshMaterial(0x222b32, 0.4),
  );
  const spokeMaterial = meshMaterial(0xb9b8b1, 0.4);
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    spinner.add(
      tubeBetween(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(Math.cos(angle) * 0.345, Math.sin(angle) * 0.345, 0),
        0.007,
        spokeMaterial,
      ),
    );
  }
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.047, 0.047, 0.13, 8),
    meshMaterial(0xc9c5b9, 0.3),
  );
  hub.rotation.x = Math.PI / 2;
  const sidewall = new THREE.Mesh(new THREE.TorusGeometry(0.426, 0.012, 6, 40), meshMaterial(0xc8a574));
  sidewall.position.z = 0.024;
  spinner.add(tire, sidewall, rim, hub);
  root.rotation.y = Math.PI / 2;
  root.add(spinner);
  return { root, spinner };
};

const createCyclist = (
  jersey: number,
  accent: number,
  scale = 1,
): THREE.Group => {
  const group = new THREE.Group();
  const backWheel = wheel();
  backWheel.root.position.set(0, 0.47, 0.68);
  const frontWheel = wheel();
  frontWheel.root.position.set(0, 0.47, -0.68);
  group.add(backWheel.root, frontWheel.root);

  const frameMaterial = meshMaterial(accent, 0.54);
  const metalMaterial = meshMaterial(0xb9b8b1, 0.34);
  const rubberMaterial = meshMaterial(0x24211f, 0.9);
  const chainMaterial = meshMaterial(0x5a5148, 0.4);
  const skinMaterial = meshMaterial(0xd7a27b, 0.88);
  const shortsMaterial = meshMaterial(0x24262a, 0.9);
  const sockMaterial = meshMaterial(0xf3eee0, 0.92);
  const jerseyMaterial = meshMaterial(jersey, 0.76);
  skinMaterial.flatShading = false;
  shortsMaterial.flatShading = false;
  jerseyMaterial.flatShading = false;
  const crank = new THREE.Vector3(0, 0.66, 0.08);
  const seat = new THREE.Vector3(0, 1.02, 0.28);
  const handle = new THREE.Vector3(0, 1.0, -0.48);
  group.add(
    tubeBetween(new THREE.Vector3(0, 0.47, 0.68), crank, 0.035, frameMaterial),
    tubeBetween(new THREE.Vector3(0, 0.47, -0.68), handle, 0.03, frameMaterial),
    tubeBetween(crank, seat, 0.04, frameMaterial),
    tubeBetween(crank, handle, 0.04, frameMaterial),
    tubeBetween(seat, handle, 0.04, frameMaterial),
    tubeBetween(new THREE.Vector3(-0.045, 0.47, 0.68), new THREE.Vector3(-0.045, 1.0, 0.29), 0.022, frameMaterial),
    tubeBetween(new THREE.Vector3(0.045, 0.47, 0.68), new THREE.Vector3(0.045, 1.0, 0.29), 0.022, frameMaterial),
    tubeBetween(new THREE.Vector3(-0.045, 0.47, -0.68), new THREE.Vector3(-0.15, 0.98, -0.49), 0.024, frameMaterial),
    tubeBetween(new THREE.Vector3(0.045, 0.47, -0.68), new THREE.Vector3(0.15, 0.98, -0.49), 0.024, frameMaterial),
    tubeBetween(new THREE.Vector3(0.075, 0.47, 0.68), new THREE.Vector3(0.075, 0.76, 0.08), 0.009, chainMaterial),
    tubeBetween(new THREE.Vector3(0.075, 0.47, 0.68), new THREE.Vector3(0.075, 0.56, 0.08), 0.009, chainMaterial),
  );
  const chainRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.14, 0.018, 6, 18),
    metalMaterial,
  );
  chainRing.rotation.y = Math.PI / 2;
  chainRing.position.copy(crank).add(new THREE.Vector3(0.065, 0, 0));
  const waterBottle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.065, 0.3, 8),
    meshMaterial(0x9bd1d7, 0.5),
  );
  waterBottle.position.set(0.055, 0.82, -0.12);
  waterBottle.rotation.x = -0.58;
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.06, 0.31), rubberMaterial);
  saddle.position.set(0, 1.05, 0.33);
  const handlebars = tubeBetween(
    new THREE.Vector3(-0.34, 1.02, -0.51),
    new THREE.Vector3(0.34, 1.02, -0.51),
    0.025,
    rubberMaterial,
  );
  const leftGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8), rubberMaterial);
  leftGrip.rotation.z = Math.PI / 2;
  leftGrip.position.set(-0.33, 1.02, -0.51);
  const rightGrip = leftGrip.clone();
  rightGrip.position.x = 0.33;
  group.add(chainRing, waterBottle, saddle, handlebars, leftGrip, rightGrip);

  const torso = new THREE.Mesh(
    createJerseyGeometry(),
    jerseyMaterial,
  );
  torso.position.set(0, 1.34, -0.08);
  torso.rotation.x = -0.94;
  const jerseySeam = new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.34, 0.018),
    meshMaterial(accent, 0.8),
  );
  jerseySeam.position.set(0, 0, 0.196);
  torso.add(jerseySeam);
  const jerseyHem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, 0.05, 10),
    meshMaterial(accent, 0.82),
  );
  jerseyHem.position.set(0, 1.175, 0.15);
  jerseyHem.rotation.x = -0.94;
  const shorts = new THREE.Mesh(
    new THREE.CylinderGeometry(0.235, 0.25, 0.18, 8),
    shortsMaterial,
  );
  shorts.position.set(0, 1.105, 0.17);
  shorts.rotation.x = -0.19;
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.115, 0.18, 8),
    skinMaterial,
  );
  neck.position.set(0, 1.66, -0.075);
  const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18, 1), meshMaterial(0xd7a27b));
  head.position.set(0, 1.78, -0.13);
  head.scale.set(0.94, 1.05, 1);
  const nose = new THREE.Mesh(new THREE.TetrahedronGeometry(0.045, 0), skinMaterial);
  nose.position.set(0, 1.79, -0.315);
  nose.rotation.x = -0.22;
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x332923 });
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 4), eyeMaterial);
  leftEye.position.set(-0.125, 1.825, -0.245);
  const rightEye = leftEye.clone();
  rightEye.position.x = 0.125;
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.205, 12, 6, 0, Math.PI * 2, 0, Math.PI / 1.8),
    jerseyMaterial,
  );
  helmet.scale.set(1, 0.7, 1.08);
  helmet.position.set(0, 1.88, -0.13);
  const helmetBand = new THREE.Mesh(
    new THREE.BoxGeometry(0.38, 0.055, 0.08),
    meshMaterial(accent, 0.46),
  );
  helmetBand.position.set(0, 1.84, 0.01);
  const ventMaterial = new THREE.MeshBasicMaterial({
    color: 0x463b2b,
    side: THREE.DoubleSide,
  });
  const helmetVents: THREE.Mesh[] = [];
  [-0.095, 0, 0.095].forEach((x, index) => {
    const vent = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.092), ventMaterial);
    vent.position.set(x, 1.91 + (index === 1 ? 0.025 : 0), 0.078);
    vent.rotation.z = x * -1.8;
    helmetVents.push(vent);
  });
  const earLeft = new THREE.Mesh(new THREE.SphereGeometry(0.04, 7, 5), skinMaterial);
  earLeft.position.set(-0.18, 1.78, -0.1);
  const earRight = earLeft.clone();
  earRight.position.x = 0.18;
  const helmetStraps = [-1, 1].map((side) =>
    tubeBetween(
      new THREE.Vector3(side * 0.145, 1.85, -0.08),
      new THREE.Vector3(side * 0.095, 1.7, -0.21),
      0.009,
      rubberMaterial,
    ),
  );
  group.add(
    torso,
    jerseyHem,
    shorts,
    neck,
    head,
    nose,
    leftEye,
    rightEye,
    helmet,
    helmetBand,
    ...helmetVents,
    ...helmetStraps,
    earLeft,
    earRight,
  );

  const headParts = [neck, head, nose, leftEye, rightEye, helmet, helmetBand, ...helmetVents, ...helmetStraps, earLeft, earRight];
  headParts.forEach((part) => { part.position.y -= 0.17; part.position.z -= 0.32; });
  const glasses = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 8, Math.PI, Math.PI, 0.65, 0.75), new THREE.MeshStandardMaterial({ color: 0x225567, metalness: 0.65, roughness: 0.16, side: THREE.DoubleSide }));
  glasses.position.set(0, 1.635, -0.46);
  glasses.scale.set(1.05, 0.72, 1.1);
  group.add(glasses);
  for (const side of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.27, 1.02, -0.5),
      new THREE.Vector3(side * 0.27, 1.02, -0.66),
      new THREE.Vector3(side * 0.27, 0.86, -0.7),
      new THREE.Vector3(side * 0.27, 0.82, -0.53),
    ]);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 14, 0.027, 8, false), rubberMaterial));
  }
  const raceNumber = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.16), new THREE.MeshStandardMaterial({ color: 0xf7f6e9, side: THREE.DoubleSide }));
  raceNumber.position.set(0.1, -0.035, 0.197);
  raceNumber.rotation.y = 0.3;
  torso.add(raceNumber);

  const legs: CyclistLegRig[] = [];
  [-1, 1].forEach((side) => {
    const shortsLeg = unitTube(0.105, shortsMaterial, 8);
    const thigh = unitTube(0.074, skinMaterial, 8);
    const kneeCap = new THREE.Mesh(new THREE.SphereGeometry(0.073, 7, 5), skinMaterial);
    const calf = unitTube(0.058, skinMaterial, 8);
    const sock = unitTube(0.054, sockMaterial, 8);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.085, 0.23), sockMaterial);
    const crankArm = unitTube(0.012, metalMaterial, 6);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.035, 0.08), rubberMaterial);
    legs.push({
      side,
      shorts: shortsLeg,
      thigh,
      knee: kneeCap,
      calf,
      sock,
      shoe,
      crankArm,
      pedal,
    });

    const shoulder = new THREE.Vector3(side * 0.235, 1.47, -0.22);
    const sleeveEnd = new THREE.Vector3(side * 0.275, 1.36, -0.29);
    const elbow = new THREE.Vector3(side * 0.29, 1.2, -0.32);
    const hand = new THREE.Vector3(side * 0.27, 1.04, -0.61);
    const shoulderJoint = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.095, 0),
      jerseyMaterial,
    );
    shoulderJoint.position.copy(shoulder);
    const sleeve = tubeBetween(shoulder, sleeveEnd, 0.084, jerseyMaterial);
    const upperArm = taperedLimb(sleeveEnd, elbow, 0.062, 0.046, skinMaterial);
    const forearm = taperedLimb(elbow, hand, 0.05, 0.028, skinMaterial);
    const elbowJoint = new THREE.Mesh(new THREE.SphereGeometry(0.064, 7, 5), skinMaterial);
    elbowJoint.position.copy(elbow);
    const wrist = hand.clone().lerp(elbow, 0.16);
    const wristJoint = new THREE.Mesh(new THREE.SphereGeometry(0.05, 7, 5), skinMaterial);
    wristJoint.position.copy(wrist);
    const handMesh = createHand(side, skinMaterial);
    handMesh.position.copy(hand);
    handMesh.rotation.x = 0.18;
    group.add(
      shortsLeg,
      thigh,
      kneeCap,
      calf,
      sock,
      shoe,
      crankArm,
      pedal,
      shoulderJoint,
      sleeve,
      upperArm,
      forearm,
      elbowJoint,
      wristJoint,
      handMesh,
    );
  });

  group.scale.setScalar(scale);
  group.userData.wheels = [backWheel.spinner, frontWheel.spinner];
  group.userData.legs = legs;
  group.userData.pedalPhase = Math.PI * 0.35;
  positionCyclistLegs(group, group.userData.pedalPhase as number);
  applyShadow(group);
  return group;
};

const createTree = (seed: number, cypress = false): THREE.Group => {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.24, 1.9, 6),
    meshMaterial(0x6b482f, 1),
  );
  trunk.position.y = 0.95;
  const leafColors = [0x648b4f, 0x77985d, 0x4f7c4b];
  const leafMaterial = meshMaterial(leafColors[seed % leafColors.length], 1);
  group.add(trunk);
  if (cypress) {
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.68 + (seed % 3) * 0.06, 3.15, 7),
      leafMaterial,
    );
    body.position.y = 3.0;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.43, 1.15, 7), leafMaterial);
    crown.position.y = 5.12;
    body.rotation.y = seed * 0.31;
    crown.rotation.y = seed * 0.31;
    group.add(body, crown);
  } else {
    [
      { x: -0.46, y: 2.38, z: 0.03, scale: 0.82 },
      { x: 0.42, y: 2.45, z: 0.08, scale: 0.78 },
      { x: 0, y: 2.92, z: -0.04, scale: 0.94 },
    ].forEach((part, index) => {
      const crown = new THREE.Mesh(
        new THREE.DodecahedronGeometry((1.02 + (seed % 3) * 0.08) * part.scale, 0),
        index === 2
          ? meshMaterial(leafColors[(seed + 1) % leafColors.length], 1)
          : leafMaterial,
      );
      crown.position.set(part.x, part.y, part.z);
      crown.rotation.set(seed * 0.19 + index, seed * 0.47 + index * 0.7, seed * 0.11);
      group.add(crown);
    });
  }
  applyShadow(group);
  return group;
};

const createHouse = (seed: number): THREE.Group => {
  const group = new THREE.Group();
  const wallMaterial = meshMaterial(seed % 2 ? 0xeee3c8 : 0xf4ead0, 1);
  const trimMaterial = meshMaterial(0xf4f0e3, 0.92);
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 2.3, 2.8),
    wallMaterial,
  );
  walls.position.y = 1.15;
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(2.65, 1.25, 4),
    meshMaterial(seed % 2 ? 0xb9563c : 0xc96a49, 0.94),
  );
  roof.position.y = 2.87;
  roof.rotation.y = Math.PI / 4;
  const eaves = new THREE.Mesh(
    new THREE.BoxGeometry(3.86, 0.13, 3.04),
    meshMaterial(seed % 2 ? 0xa94c37 : 0xb85a3f, 0.96),
  );
  eaves.position.y = 2.34;
  const foundation = new THREE.Mesh(
    new THREE.BoxGeometry(3.72, 4, 2.92),
    meshMaterial(0xd3cab3, 1),
  );
  foundation.position.y = -1.78;
  group.userData.groundFootprint = [1.95, 1.85];
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(0.82, 1.34, 0.12), trimMaterial);
  doorFrame.position.set(0, 0.71, 1.43);
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.64, 1.2, 0.08),
    meshMaterial(0x76523a, 0.9),
  );
  door.position.set(0, 0.65, 1.5);
  const doorInset = new THREE.Mesh(
    new THREE.BoxGeometry(0.43, 0.42, 0.02),
    meshMaterial(0x5f422f, 0.9),
  );
  doorInset.position.set(0, 0.95, 1.552);
  const doorKnob = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 7, 5),
    meshMaterial(0xd3af5f, 0.36),
  );
  doorKnob.position.set(0.22, 0.66, 1.58);
  const doorstep = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.14, 0.42),
    meshMaterial(0xbcb39f, 1),
  );
  doorstep.position.set(0, 0.07, 1.62);

  const createWindow = (): THREE.Group => {
    const window = new THREE.Group();
    const pane = new THREE.Mesh(
      new THREE.BoxGeometry(0.68, 0.62, 0.07),
      new THREE.MeshStandardMaterial({ color: 0x79a7ad, roughness: 0.28, metalness: 0.06 }),
    );
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.075, 0.1), trimMaterial);
    top.position.y = 0.34;
    const bottom = top.clone();
    bottom.position.y = -0.34;
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.62, 0.1), trimMaterial);
    left.position.x = -0.38;
    const right = left.clone();
    right.position.x = 0.38;
    const verticalBar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 0.11), trimMaterial);
    const horizontalBar = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.11), trimMaterial);
    const shutterMaterial = meshMaterial(seed % 2 ? 0x648f94 : 0x5d8790, 0.84);
    const leftShutter = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.68, 0.08), shutterMaterial);
    leftShutter.position.x = -0.5;
    const rightShutter = leftShutter.clone();
    rightShutter.position.x = 0.5;
    window.add(pane, top, bottom, left, right, verticalBar, horizontalBar, leftShutter, rightShutter);
    return window;
  };
  const windowLeft = createWindow();
  windowLeft.position.set(-1.02, 1.3, 1.46);
  const windowRight = createWindow();
  windowRight.position.set(1.02, 1.3, 1.46);
  const windowSide = createWindow();
  windowSide.position.set(-1.84, 1.28, 0.15);
  windowSide.rotation.y = -Math.PI / 2;
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.05, 0.42), meshMaterial(0x9a6749));
  chimney.position.set(-0.92, 3.08, 0.38);
  const chimneyCap = new THREE.Mesh(
    new THREE.BoxGeometry(0.52, 0.14, 0.52),
    meshMaterial(0x81543e),
  );
  chimneyCap.position.set(-0.92, 3.62, 0.38);
  group.add(
    foundation,
    walls,
    eaves,
    roof,
    doorFrame,
    door,
    doorInset,
    doorKnob,
    doorstep,
    windowLeft,
    windowRight,
    windowSide,
    chimney,
    chimneyCap,
  );
  applyShadow(group);
  return group;
};

const createHayBale = (): THREE.Group => {
  const group = new THREE.Group();
  const bale = new THREE.Mesh(
    new THREE.CylinderGeometry(0.82, 0.82, 1.45, 12),
    meshMaterial(0xd6b35b, 1),
  );
  bale.rotation.z = Math.PI / 2;
  bale.position.y = 0.82;
  const center = new THREE.Mesh(
    new THREE.CircleGeometry(0.34, 12),
    meshMaterial(0x9f7b37, 1),
  );
  center.rotation.y = Math.PI / 2;
  center.position.set(0.731, 0.82, 0);
  group.add(bale, center);
  applyShadow(group);
  return group;
};

const createFrenchFlag = (): THREE.Group => {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.045, 2.7, 7),
    meshMaterial(0xd8d2c1, 0.76),
  );
  pole.position.y = 1.35;
  group.add(pole);
  [0x2c5e9e, 0xf2eee1, 0xc4473d].forEach((color, index) => {
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.78, 0.025),
      meshMaterial(color, 0.75),
    );
    panel.position.set(0.18 + index * 0.32, 2.2, 0);
    group.add(panel);
  });
  applyShadow(group);
  return group;
};

const createFan = (seed: number): THREE.Group => {
  const group = new THREE.Group();
  const shirtColors = [0xc85f4d, 0xd4b658, 0x4f889b, 0xe5d3a0, 0x658b5d];
  const shirt = meshMaterial(shirtColors[seed % shirtColors.length], 0.9);
  const skin = meshMaterial([0xc98e66, 0xd5aa82, 0xb97955][seed % 3], 0.9);
  const hairMaterial = meshMaterial([0x6c4b34, 0xb49a70, 0x3b3129][seed % 3], 0.9);
  const trousersMaterial = meshMaterial(seed % 2 ? 0x343a3a : 0x2d4050, 0.95);
  const shoeMaterial = meshMaterial(0x292725, 0.92);
  const torso = new THREE.Mesh(createFanShirtGeometry(), shirt);
  torso.position.y = 1.08;
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(0.12, 0.026, 5, 10, Math.PI),
    meshMaterial(seed % 3 === 0 ? 0xeee3c4 : shirtColors[(seed + 1) % shirtColors.length], 0.88),
  );
  collar.position.set(0, 1.39, 0.115);
  collar.rotation.x = Math.PI / 2;
  const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.205, 1), skin);
  head.position.y = 1.63;
  head.scale.set(0.94, 1.08, 0.92);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.095, 0.18, 7), skin);
  neck.position.y = 1.43;
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.208, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
    hairMaterial,
  );
  hair.position.set(0, 1.745, -0.008);
  hair.scale.set(0.98, 0.62, 0.98);

  const earGeometry = new THREE.DodecahedronGeometry(0.052, 0);
  [-1, 1].forEach((side) => {
    const ear = new THREE.Mesh(earGeometry, skin);
    ear.position.set(side * 0.19, 1.63, 0.008);
    group.add(ear);
  });
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.047, 0.09, 5), skin);
  nose.position.set(0, 1.62, 0.198);
  nose.rotation.x = Math.PI / 2;
  const eyeMaterial = meshMaterial(0x302b28, 0.96);
  [-1, 1].forEach((side) => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 5, 4), eyeMaterial);
    eye.position.set(side * 0.068, 1.67, 0.187);
    group.add(eye);
  });
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.018, 0.016), eyeMaterial);
  mouth.position.set(0, 1.54, 0.192);

  const shorts = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.25, 0.34), trousersMaterial);
  shorts.position.set(0, 0.7, 0);
  shorts.rotation.y = (seed % 3 - 1) * 0.035;
  [-1, 1].forEach((side) => {
    const hip = new THREE.Vector3(side * 0.135, 0.7, 0);
    const knee = new THREE.Vector3(
      side * (0.15 + (seed % 2) * 0.018),
      0.39,
      side === (seed % 2 === 0 ? 1 : -1) ? 0.035 : -0.025,
    );
    const ankle = new THREE.Vector3(side * 0.16, 0.12, knee.z + 0.012);
    const thigh = tubeBetween(hip, knee, 0.09, trousersMaterial);
    const kneeJoint = new THREE.Mesh(new THREE.DodecahedronGeometry(0.092, 0), trousersMaterial);
    kneeJoint.position.copy(knee);
    const shin = tubeBetween(knee, ankle, 0.078, trousersMaterial);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.27), shoeMaterial);
    shoe.position.set(ankle.x, 0.065, 0.065 + ankle.z);
    shoe.rotation.y = side * 0.04;
    group.add(thigh, kneeJoint, shin, shoe);
  });

  const pose = seed % 4;
  const arms: FanArmRig[] = [];
  [-1, 1].forEach((side) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.255, 1.29, 0);
    const sleeveEnd = new THREE.Vector3(side * 0.11, 0.07, 0.006);
    let elbow = new THREE.Vector3(side * 0.27, 0.3, 0.015);
    let hand = new THREE.Vector3(side * 0.15, 0.62, 0.025);
    if (pose === 1 && side < 0) {
      elbow = new THREE.Vector3(side * 0.33, 0.25, -0.01);
      hand = new THREE.Vector3(side * 0.42, 0.5, 0.02);
    } else if (pose === 2) {
      elbow = new THREE.Vector3(side * 0.29, 0.28, 0.02);
      hand = new THREE.Vector3(side * 0.045, 0.57, 0.09);
    } else if (pose === 3 && side > 0) {
      elbow = new THREE.Vector3(side * 0.3, 0.15, 0.015);
      hand = new THREE.Vector3(side * 0.39, 0.34, 0.06);
    }
    const shoulder = new THREE.Mesh(new THREE.DodecahedronGeometry(0.112, 0), shirt);
    const sleeve = tubeBetween(new THREE.Vector3(), sleeveEnd, 0.105, shirt);
    const upperArm = tubeBetween(sleeveEnd, elbow, 0.064, skin);
    const elbowJoint = new THREE.Mesh(new THREE.DodecahedronGeometry(0.072, 0), skin);
    elbowJoint.position.copy(elbow);
    const forearm = tubeBetween(elbow, hand, 0.058, skin);
    const handMesh = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.078, 0),
      skin,
    );
    handMesh.position.copy(hand);
    arm.add(shoulder, sleeve, upperArm, elbowJoint, forearm, handMesh);
    arms.push({
      pivot: arm,
      baseRotation: side * ((seed % 3) - 1) * 0.018,
      amplitude: pose === 2 ? 0.055 : 0.085 + (seed % 2) * 0.02,
      phaseOffset: side > 0 ? 0.64 : 0,
    });
    group.add(arm);
  });
  if (seed % 4 === 0) {
    const capMaterial = meshMaterial(shirtColors[(seed + 2) % shirtColors.length], 0.84);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.215, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
      capMaterial,
    );
    cap.position.set(0, 1.755, -0.008);
    cap.scale.set(1, 0.52, 1);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.035, 0.15), capMaterial);
    brim.position.set(0, 1.745, 0.16);
    group.add(cap, brim);
  } else {
    group.add(hair);
  }
  group.add(shorts, torso, collar, neck, head, nose, mouth);
  group.userData.wavingArms = arms;
  group.userData.wavePhase = seed * 0.73;
  applyShadow(group);
  return group;
};

const createGantry = (seed: number): THREE.Group => {
  const group = new THREE.Group();
  const green = meshMaterial(seed % 2 === 0 ? 0x397b68 : 0x467b8a, 0.72);
  [-6.25, 6.25].forEach((x) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.25, 0.34), green);
    post.position.set(x, 2.12, 0);
    group.add(post);
  });
  const header = new THREE.Mesh(new THREE.BoxGeometry(12.8, 0.66, 0.42), green);
  header.position.y = 4.05;
  const inset = new THREE.Mesh(
    new THREE.BoxGeometry(5.4, 0.34, 0.05),
    meshMaterial(0xe8e6d7, 0.8),
  );
  inset.position.set(0, 4.05, 0.235);
  group.add(header, inset);
  applyShadow(group);
  return group;
};

const createCockpit = (): THREE.Group => {
  const group = new THREE.Group();
  const carbon = meshMaterial(0x1c2a31, 0.42);
  const tape = meshMaterial(0x29383d, 0.94);
  const skin = meshMaterial(0xd6a17b, 0.8);
  skin.flatShading = false;
  group.add(tubeBetween(new THREE.Vector3(0, -0.18, 0.22), new THREE.Vector3(0, 0, -0.09), 0.035, carbon));
  group.add(tubeBetween(new THREE.Vector3(-0.36, 0, -0.09), new THREE.Vector3(0.36, 0, -0.09), 0.028, carbon));
  for (const side of [-1, 1]) {
    const bend = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.35, 0, -0.09),
      new THREE.Vector3(side * 0.4, 0.01, -0.2),
      new THREE.Vector3(side * 0.42, -0.13, -0.23),
      new THREE.Vector3(side * 0.4, -0.18, -0.02),
    ]);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(bend, 20, 0.029, 10, false), tape));
    const wrist = new THREE.Vector3(side * 0.37, 0.01, -0.095);
    const hand = createHand(side, skin);
    hand.position.set(side * 0.37, 0.01, -0.15);
    const elbow = new THREE.Vector3(side * 0.59, -0.23, 0.4);
    const forearm = taperedLimb(elbow, wrist, 0.069, 0.028, skin);
    const elbowJoint = new THREE.Mesh(new THREE.SphereGeometry(0.069, 16, 12), skin);
    elbowJoint.position.copy(elbow);
    group.add(forearm, elbowJoint, hand);
    const hood = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, 0.085, 4, 8), tape);
    hood.position.set(side * 0.38, 0.015, -0.23);
    hood.rotation.x = -0.3;
    group.add(hood);
  }
  const computer = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.17), carbon);
  computer.position.set(0, 0.035, -0.14);
  const display = document.createElement("canvas");
  display.width = 192;
  display.height = 256;
  const displayTexture = new THREE.CanvasTexture(display);
  displayTexture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.094, 0.123), new THREE.MeshBasicMaterial({ map: displayTexture }));
  screen.rotation.x = -Math.PI / 2;
  screen.position.set(0, 0.049, -0.14);
  group.add(computer, screen);
  group.userData.display = display;
  group.userData.displayTexture = displayTexture;
  group.position.set(0, -0.35, -0.7);
  group.visible = false;
  return group;
};

export class ThreeRide {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(53, 16 / 9, 0.1, 600);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly timer = new THREE.Timer();
  private readonly roadWorld = new THREE.Group();
  private readonly landscape = new ThreeLandscape();
  private readonly slipstream = new ThreeSlipstream();
  private travelled = 0;
  private visualSpeed = 25;
  private roadPitch = 0;
  private readonly objects: WorldObject[] = [];
  private readonly movingScenery: THREE.Object3D[] = [];
  private readonly laneMarkers: THREE.Mesh[] = [];
  private readonly challenges = new Map<number, ChallengeRun>();
  private readonly callbacks: ThreeRideCallbacks;
  private readonly resizeObserver: ResizeObserver;
  private readonly rider: THREE.Group;
  private readonly cockpit = createCockpit();
  private readonly aura: THREE.Mesh;
  private readonly sunlight: THREE.DirectionalLight;
  private animationFrame = 0;
  private paused = false;
  private disposed = false;
  private elapsedMs = 0;
  private targetLane = 1;
  private targetRiderX: number = THREE_LANE_X[1];
  private lastSteerAt = 0;
  private encounterCountdown = VISUAL_QA.encounter ? 0 : 1_200;
  private encounterCount = 0;
  private sequenceCount = 0;
  private flow = 0;
  private combo = 0;
  private lastReportedFlow = -1;
  private lastReportedCombo = -1;
  private lastFlowActionAt = 0;
  private raceRevision = 0;
  private sceneryStage = 0;
  private announcement: Announcement | null = null;
  private cameraShake = 0;
  private cameraModeIndex = 0;
  private readonly cameraPosition = new THREE.Vector3(0, 3.6, 8.2);
  private readonly cameraLookTarget = new THREE.Vector3(0, 0.9, -7);
  private domestiques: THREE.Group[] = [];
  private draftCyclist: THREE.Group | null = null;
  private draftLane = 1;
  private draftAcquisitionRemaining = 3.2;
  private draftTimeRemaining = 0;
  private draftGraceRemaining = 0;
  private draftLaneCountdown = 0;
  private drafting = false;
  private droppedFromDraft = false;

  constructor(host: HTMLElement, callbacks: ThreeRideCallbacks) {
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.domElement.setAttribute("aria-label", "3D cycling road");
    this.renderer.domElement.setAttribute("role", "img");
    host.append(this.renderer.domElement);

    this.camera.position.set(0, 3.6, 8.2);
    this.camera.lookAt(0, 0.9, -7);
    this.camera.add(this.cockpit);
    this.scene.add(this.camera);
    this.scene.add(this.roadWorld);
    this.roadWorld.add(this.slipstream.mesh);
    this.createEnvironment();
    this.rider = createCyclist(
      0xf4c52d,
      0x197d91,
      threeRiderModelScale("main"),
    );
    this.rider.position.set(THREE_LANE_X[1], 0, RIDER_Z);
    this.roadWorld.add(this.rider);
    this.aura = new THREE.Mesh(
      new THREE.RingGeometry(0.52, 0.72, 32),
      new THREE.MeshBasicMaterial({ color: 0x71f5cc, transparent: true, opacity: 0.72, side: THREE.DoubleSide }),
    );
    this.aura.rotation.x = -Math.PI / 2;
    this.aura.position.set(0, 0.04, RIDER_Z);
    this.aura.visible = false;
    this.roadWorld.add(this.aura);

    this.sunlight = new THREE.DirectionalLight(0xffe0a8, 3.2);
    this.sunlight.position.set(-24, 30, -18);
    this.sunlight.target.position.set(0, 0, -16);
    this.scene.add(this.sunlight.target);
    this.sunlight.shadow.bias = -0.00015;
    this.sunlight.shadow.normalBias = 0.025;
    this.sunlight.shadow.radius = 3;
    this.sunlight.castShadow = true;
    this.sunlight.shadow.mapSize.set(2048, 2048);
    this.sunlight.shadow.camera.left = -24;
    this.sunlight.shadow.camera.right = 24;
    this.sunlight.shadow.camera.top = 26;
    this.sunlight.shadow.camera.bottom = -30;
    this.sunlight.shadow.camera.near = 0.5;
    this.sunlight.shadow.camera.far = 90;
    this.scene.add(this.sunlight);
    this.scene.add(new THREE.HemisphereLight(0xb8d9ef, 0x74714b, 1.35));

    this.roadPitch = threeRoadPitch(VISUAL_QA.gradient ?? gameStore.getSnapshot().currentGradient);
    this.applyGrade();
    this.updateStage(VISUAL_QA.stage === null ? gameStore.getSnapshot().stageDefinition : stages[VISUAL_QA.stage - 1]);
    this.raceRevision = gameStore.getSnapshot().raceRevision;
    this.callbacks.onCameraChange(CAMERA_MODES[this.cameraModeIndex]);
    this.callbacks.onFlowChange(this.flow, this.combo);
    this.resizeObserver = new ResizeObserver(() => this.resize(host));
    this.resizeObserver.observe(host);
    this.resize(host);
    window.addEventListener("keydown", this.onKeydown, { passive: false });
    this.timer.connect(document);
    this.timer.update();
    this.animationFrame = window.requestAnimationFrame(this.frame);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.timer.reset();
  }

  cycleCamera(): void {
    this.cameraModeIndex = (this.cameraModeIndex + 1) % CAMERA_MODES.length;
    const mode = CAMERA_MODES[this.cameraModeIndex];
    this.callbacks.onCameraChange(mode);
    this.showAnnouncement(`${mode.toUpperCase()} CAMERA`, "neutral", 850);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.animationFrame);
    window.removeEventListener("keydown", this.onKeydown);
    this.resizeObserver.disconnect();
    this.timer.dispose();
    this.slipstream.dispose();
    (this.cockpit.userData.displayTexture as THREE.Texture).dispose();
    gameStore.setTemporaryDraftBonus(0);
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Sprite)) return;
      if (object instanceof THREE.Mesh) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly frame = (): void => {
    if (this.disposed) return;
    this.timer.update();
    const delta = Math.min(0.05, this.timer.getDelta());
    if (!this.paused) this.update(delta);
    this.render(delta);
    this.animationFrame = window.requestAnimationFrame(this.frame);
  };

  private update(delta: number): void {
    this.elapsedMs += delta * 1_000;
    const current = gameStore.getSnapshot();
    if (current.raceRevision !== this.raceRevision) {
      this.raceRevision = current.raceRevision;
      this.resetWorld();
      return;
    }
    if (current.raceFinished) return;

    gameStore.tick(delta);
    const snapshot = gameStore.getSnapshot();
    if (snapshot.raceFinished) return;
    const speedKmh = VISUAL_QA.speedKmh ?? snapshot.stats.speedKmh;
    const speed = threeWorldSpeed(speedKmh);
    this.visualSpeed = speedKmh;
    this.roadPitch = THREE.MathUtils.lerp(
      this.roadPitch,
      threeRoadPitch(VISUAL_QA.gradient ?? snapshot.currentGradient),
      1 - Math.exp(-delta * 1.8),
    );
    this.applyGrade();
    this.travelled += speed * delta;
    this.landscape.update(this.travelled, this.elapsedMs / 1_000);
    const stage = VISUAL_QA.stage === null ? snapshot.stageDefinition : stages[VISUAL_QA.stage - 1];
    this.updateStage(stage);
    this.targetRiderX = THREE_LANE_X[this.targetLane];
    this.rider.position.x = THREE.MathUtils.lerp(
      this.rider.position.x,
      this.targetRiderX,
      1 - Math.exp(-delta * (7 + snapshot.stats.handling * 0.75)),
    );
    this.rider.rotation.z = THREE.MathUtils.lerp(
      this.rider.rotation.z,
      (this.targetRiderX - this.rider.position.x) * -0.15,
      1 - Math.exp(-delta * 9),
    );
    this.animateCyclist(this.rider, speed, delta);
    this.updateRoadMotion(speed, delta);
    this.updateObjects(speed, delta, snapshot.stats.pickupMagnet);
    this.updateFans(speed, delta);
    this.updateFlow(delta, snapshot.stats.flowDecayPerSecond);
    this.syncDomestiques(
      VISUAL_QA.domestiques ?? snapshot.upgrades.domestique ?? 0,
    );
    this.updateDomestiques(speed, delta);
    this.updateDraft(delta, snapshot.stage, speed);
    this.updateSlipstream(delta, speed);
    this.reportFlow();
    this.updatePowerUpFeedback(snapshot.activePowerUp);

    this.encounterCountdown -= delta * 1_000;
    if (
      this.encounterCountdown <= 0 &&
      this.objects.length === 0 &&
      !this.draftCyclist
    ) {
      const encounter = VISUAL_QA.encounter ?? nextEncounter(stage, this.encounterCount);
      this.startEncounter(encounter, snapshot);
      this.encounterCount += 1;
      const [minimum, maximum] = encounterDelayRange(snapshot.stage);
      this.encounterCountdown = randomBetween(minimum, maximum);
    }

    if (this.announcement && this.announcement.until <= this.elapsedMs) {
      this.announcement = null;
      this.callbacks.onAnnouncement(null);
    }
  }

  private render(delta: number): void {
    const shake = this.cameraShake;
    this.cameraShake = Math.max(0, this.cameraShake - delta * 3.8);
    const offsetX = shake > 0 ? (Math.random() - 0.5) * shake : 0;
    const offsetY = shake > 0 ? (Math.random() - 0.5) * shake * 0.5 : 0;
    const mode = CAMERA_MODES[this.cameraModeIndex];
    const firstPerson = mode === "First person";
    this.rider.visible = !firstPerson;
    this.cockpit.visible = firstPerson;
    this.cockpit.rotation.z = this.rider.rotation.z * 0.2;
    this.cockpit.rotation.x = THREE.MathUtils.clamp(this.roadPitch * 0.2, -0.12, 0.12);
    const pace = Math.round(this.visualSpeed);
    if (firstPerson && this.cockpit.userData.displayPace !== pace) {
      const context = (this.cockpit.userData.display as HTMLCanvasElement).getContext("2d");
      if (context) {
        context.fillStyle = "#d1e2cd";
        context.fillRect(0, 0, 192, 256);
        context.fillStyle = "#203c3c";
        context.textAlign = "center";
        context.font = "bold 28px sans-serif";
        context.fillText("ZE TOUR", 96, 45);
        context.font = "bold 90px sans-serif";
        context.fillText(String(pace), 96, 151);
        context.font = "24px sans-serif";
        context.fillText("KM/H", 96, 194);
        (this.cockpit.userData.displayTexture as THREE.Texture).needsUpdate = true;
        this.cockpit.userData.displayPace = pace;
      }
    }
    let desiredPosition: THREE.Vector3;
    let desiredLook: THREE.Vector3;
    switch (mode) {
      case "First person": {
        const pedalPhase = (this.rider.userData.pedalPhase as number) ?? 0;
        const sway = this.paused ? 0 : Math.sin(pedalPhase) * 0.009;
        desiredPosition = new THREE.Vector3(this.rider.position.x + sway, 1.29, RIDER_Z + 0.06);
        desiredLook = new THREE.Vector3(this.rider.position.x + roadBend(-35, this.travelled) * 0.2, 0.48, -18);
        break;
      }
      case "Chase":
        desiredPosition = new THREE.Vector3(this.rider.position.x * 0.28, 3.6, 8.2);
        desiredLook = new THREE.Vector3(this.rider.position.x * 0.18 + roadBend(-40, this.travelled) * 0.08, 0.9, -7);
        break;
      case "Wide":
        desiredPosition = new THREE.Vector3(this.rider.position.x * 0.1, 7.1, 12.5);
        desiredLook = new THREE.Vector3(0, 0.6, -12);
        break;
      case "Roadside":
        desiredPosition = new THREE.Vector3(-7.8, 2.8, 4.6);
        desiredLook = new THREE.Vector3(this.rider.position.x, 0.8, -1.5);
        break;
      case "Helicopter":
        desiredPosition = new THREE.Vector3(0, 17.5, 8.4);
        desiredLook = new THREE.Vector3(0, 0, -10);
        break;
    }
    const pivot = new THREE.Vector3(0, 0, RIDER_Z);
    const slopeAxis = new THREE.Vector3(1, 0, 0);
    if (firstPerson || mode === "Chase" || mode === "Wide") {
      const lookDirection = desiredLook.clone().sub(desiredPosition);
      // Following the full angle would make the road look flat again.
      const climbing = this.roadPitch > 0;
      const follow = firstPerson ? (climbing ? 0.7 : 0.4) : mode === "Chase" ? (climbing ? 0.78 : 0.3) : (climbing ? 0.85 : 0.55);
      desiredPosition.sub(pivot).applyAxisAngle(slopeAxis, this.roadPitch * (firstPerson ? 1 : follow)).add(pivot);
      // Keep the rider framed while the road falls away. A following camera
      // must also clear the rising surface behind the rider on steep descents.
      if (!firstPerson) {
        const roadHeight = -(desiredPosition.z - RIDER_Z) * Math.tan(this.roadPitch);
        desiredPosition.y = Math.max(desiredPosition.y, roadHeight + 1.5);
      }
      desiredLook.copy(desiredPosition).add(lookDirection.applyAxisAngle(slopeAxis, this.roadPitch * follow));
    } else {
      desiredLook.sub(pivot).applyAxisAngle(slopeAxis, this.roadPitch).add(pivot);
      const roadHeight = -(desiredPosition.z - RIDER_Z) * Math.tan(this.roadPitch);
      desiredPosition.y = Math.max(desiredPosition.y, roadHeight + 2);
    }
    const response = 1 - Math.exp(-delta * (firstPerson ? 14 : 4.6));
    this.cameraPosition.lerp(desiredPosition, response);
    this.cameraLookTarget.lerp(desiredLook, response);
    this.camera.position.copy(this.cameraPosition);
    this.camera.position.x += offsetX;
    this.camera.position.y += offsetY;
    this.camera.lookAt(this.cameraLookTarget);
    const fov = firstPerson ? 76 : mode === "Chase" ? 53 + THREE.MathUtils.clamp((this.visualSpeed - 25) * 0.09, 0, 6) : 50;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, response);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }

  private resize(host: HTMLElement): void {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() === "c" && !event.repeat) {
      event.preventDefault();
      this.cycleCamera();
      return;
    }
    if (this.paused || event.repeat) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    this.targetLane = moveLane(
      this.targetLane,
      event.key === "ArrowLeft" ? -1 : 1,
      THREE_LANE_X.length,
    );
    this.lastSteerAt = this.elapsedMs;
  };

  private createEnvironment(): void {
    this.scene.add(this.landscape.root);
    const markerMaterial = new THREE.MeshStandardMaterial({ color: 0xe9e4cb, transparent: true, opacity: 0.55 });
    for (const x of [-1.38, 1.38]) {
      for (let z = 7; z > -WORLD_WRAP_LENGTH; z -= 8.5) {
        const marker = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 2.4), markerMaterial);
        marker.position.set(x, 0.018, z);
        marker.userData.baseX = x;
        marker.userData.baseY = 0.018;
        this.laneMarkers.push(marker);
        this.roadWorld.add(marker);
      }
    }
  }

  private applyGrade(): void {
    applyRoadPitch(this.roadWorld, this.roadPitch, RIDER_Z);
    this.landscape.setRoadPitch(this.roadPitch, RIDER_Z);
  }

  private populateScenery(stage: number): void {
    this.movingScenery.forEach((object) => { this.roadWorld.remove(object); disposeRoadObject(object); });
    this.movingScenery.length = 0;
    const place = (object: THREE.Object3D, x: number, z: number, yaw = 0, upright = true): void => {
      object.position.set(x + roadBend(z, this.travelled), roadSurfaceHeight(z, this.roadPitch), z);
      object.userData.baseX = x;
      object.userData.baseYaw = yaw;
      object.userData.upright = upright;
      object.rotation.set(upright ? -this.roadPitch : roadSurfacePitch(z, this.roadPitch), yaw + roadHeading(z, this.travelled), 0);
      this.groundScenery(object);
      this.movingScenery.push(object);
      this.roadWorld.add(object);
    };
    const mountain = stage === 3 || stage === 5;
    const mediterranean = stage === 4;
    const treeCount = stage === 2 ? 72 : mountain ? 42 : 32;
    for (let i = 0; i < treeCount; i += 1) {
      const side = i % 2 ? 1 : -1;
      const tree = createTree(i, mediterranean || mountain);
      tree.scale.setScalar(0.75 + i % 5 * 0.14);
      if (mountain) {
        // Layered fir crowns replace Mediterranean cypresses in the Alps.
        disposeRoadObject(tree);
        tree.clear();
        const bark = meshMaterial(0x5b4435);
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 1.8, 6), bark);
        trunk.position.y = 0.9;
        tree.add(trunk);
        for (let crown = 0; crown < 3; crown += 1) {
          const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.4 - crown * 0.3, 2.2, 8), meshMaterial([0x285a49, 0x34715a, 0x478366][crown]));
          leaves.position.y = 2 + crown * 0.8;
          tree.add(leaves);
        }
        applyShadow(tree);
      }
      place(tree, side * (7.6 + i % 6 * 1.6), 7 - i / treeCount * 180, i * 0.41);
    }
    for (let i = 0; i < (mountain ? 5 : 10); i += 1) {
      const house = createHouse(i);
      house.scale.setScalar(mountain ? 0.8 : 0.85 + i % 3 * 0.13);
      place(house, (i % 2 ? 1 : -1) * (10 + i % 3 * 2), -12 - i * (mountain ? 34 : 17), i % 2 ? -Math.PI / 2 : Math.PI / 2);
    }
    if (stage === 1 || stage === 2 || mediterranean) {
      for (let i = 0; i < 18; i += 1) {
        const field = new THREE.Group();
        if (stage === 1) {
          field.add(createHayBale());
        } else {
          const cropMaterial = meshMaterial(mediterranean ? 0x8266ad : 0x527747);
          for (let row = 0; row < 4; row += 1) {
            const crop = new THREE.Mesh(new THREE.BoxGeometry(0.6, mediterranean ? 0.35 : 0.7, 6), cropMaterial);
            crop.position.set(row * 1.2, mediterranean ? 0.18 : 0.35, 0);
            field.add(crop);
          }
          applyShadow(field);
        }
        place(field, (i % 2 ? 1 : -1) * (9 + i % 3 * 2), -i * 10, 0, false);
      }
    }
    for (let i = 0; i < 44; i += 1) {
      const side = i % 2 ? 1 : -1;
      const post = new THREE.Group();
      const stem = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.8, 0.15), meshMaterial(0xe9e5d9));
      stem.position.y = 0.4;
      const reflector = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.17), meshMaterial(0xeab74b));
      reflector.position.y = 0.69;
      post.add(stem, reflector);
      if (mountain) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, 8.2), meshMaterial(0xadbabc, 0.55));
        rail.position.set(0, 0.65, -4);
        post.add(rail);
      }
      place(post, side * 6.35, 8 - Math.floor(i / 2) * 8.2, 0, false);
    }
    for (let i = 0; i < (stage === 5 ? 32 : 16); i += 1) {
      const side = i % 2 ? 1 : -1;
      const fan = createFan(i);
      fan.scale.setScalar(0.67 + i % 3 * 0.025);
      place(fan, side * (6.8 + i % 3 * 0.45), -20 - Math.floor(i / 4) * 37 - i % 4 * 1.2, -side * Math.PI / 2);
    }
    for (let i = 0; i < 8; i += 1) {
      const side = i % 2 ? 1 : -1;
      place(createFrenchFlag(), side * 7.3, -22 - Math.floor(i / 2) * 40, -side * 0.2);
    }
    const gantry = createGantry(stage);
    place(gantry, 0, -140);
  }

  private updateStage(stage: GameSnapshot["stageDefinition"]): void {
    if (this.sceneryStage === stage.number) return;
    this.sceneryStage = stage.number;
    const palette = stagePalette[stage.number - 1] ?? stagePalette[0];
    this.scene.fog = new THREE.Fog(palette.fog, 90, 250);
    this.landscape.setStage(stage.number, stage.surface === "gravel");
    this.populateScenery(stage.number);
    this.showAnnouncement(
      stage.surface === "gravel"
        ? `GRAVEL · ${stage.start.toUpperCase()} → ${stage.finish.toUpperCase()}`
        : `${stage.start.toUpperCase()} → ${stage.finish.toUpperCase()}`,
      "neutral",
      2_400,
    );
  }

  private updateRoadMotion(speed: number, delta: number): void {
    for (const object of [...this.laneMarkers, ...this.movingScenery]) {
      object.position.z += speed * delta;
      if (object.position.z > WORLD_END_Z) object.position.z -= WORLD_WRAP_LENGTH;
      object.position.x = (object.userData.baseX as number) + roadBend(object.position.z, this.travelled);
      object.rotation.set(
        object.userData.upright ? -this.roadPitch : roadSurfacePitch(object.position.z, this.roadPitch),
        ((object.userData.baseYaw as number) || 0) + roadHeading(object.position.z, this.travelled),
        0,
      );
      this.groundScenery(object);
    }
  }

  private groundScenery(object: THREE.Object3D): void {
    object.position.y = ((object.userData.baseY as number) || 0)
      + this.landscape.supportHeight(object, this.travelled);
  }

  private alignRoadObject(object: THREE.Object3D): void {
    const clearance = (object.userData.roadClearance ??= object.position.y) as number;
    object.position.y = clearance + roadSurfaceHeight(object.position.z, this.roadPitch);
    object.rotation.x = roadSurfacePitch(object.position.z, this.roadPitch);
  }

  private spawnPickup(
    type: LootType,
    lane: number,
    z: number,
    sequenceId?: number,
    sequenceIndex?: number,
  ): void {
    const sprite = createRoadReward(type);
    sprite.position.set(THREE_LANE_X[lane], 0.95, z);
    this.alignRoadObject(sprite);
    this.roadWorld.add(sprite);
    this.objects.push({ mesh: sprite, type, lane, sequenceId, sequenceIndex, speedMultiplier: 1, passedRider: false });
  }

  private spawnPowerUp(type: PowerUpType, lane: number, z: number, choiceId: number): void {
    const sprite = createRoadReward(type);
    sprite.position.set(THREE_LANE_X[lane], 1.15, z);
    this.alignRoadObject(sprite);

    this.roadWorld.add(sprite);
    this.objects.push({ mesh: sprite, type, lane, choiceId, speedMultiplier: 1, passedRider: false });
  }

  private spawnPothole(lane: number, z: number, sequenceId?: number): void {
    const pothole = createPothole();
    pothole.position.set(THREE_LANE_X[lane], 0.02, z);
    this.alignRoadObject(pothole);
    this.roadWorld.add(pothole);
    this.objects.push({ mesh: pothole, type: "pothole", lane, sequenceId, speedMultiplier: 1, passedRider: false });
  }

  private spawnTraffic(lane: number, z: number, sequenceId: number): void {
    const van = Math.random() > 0.62;
    const car = createRoadVehicle(van, randomInt(0, 2));
    car.scale.setScalar(1.08);
    car.position.set(THREE_LANE_X[lane], 0, z);
    this.alignRoadObject(car);
    this.roadWorld.add(car);
    this.objects.push({
      mesh: car,
      type: van ? "oncoming-van" : "oncoming-car",
      lane,
      sequenceId,
      speedMultiplier: oncomingTrafficSpeedMultiplier(gameStore.getSnapshot().stage),
      passedRider: false,
    });
  }

  private updateObjects(speed: number, delta: number, pickupMagnet: boolean): void {
    for (let index = this.objects.length - 1; index >= 0; index -= 1) {
      const object = this.objects[index];
      if (!object) continue;
      if (object.sequenceFailed) continue;
      const distance = speed * object.speedMultiplier * delta;
      object.mesh.position.z += distance;
      animateRoadVehicle(object.mesh, speed * (object.speedMultiplier - 1) * delta);
      object.mesh.position.x = THREE_LANE_X[object.lane] + roadBend(object.mesh.position.z, this.travelled);
      object.mesh.rotation.y = roadHeading(object.mesh.position.z, this.travelled);
      this.alignRoadObject(object.mesh);
      const rewardModel = object.mesh.userData.rewardModel as THREE.Group | undefined;
      if (rewardModel) {
        rewardModel.rotation.y += delta * 1.5;
        rewardModel.position.y = Math.sin(this.elapsedMs / 310 + object.mesh.position.z * 0.08) * 0.1;
      }
      const pickup = object.type === "sweat" || object.type === "cash" || isPowerUpType(object.type);
      const magnetized = pickupMagnet && (object.type === "sweat" || object.type === "cash") && object.mesh.position.z > -5;
      if (
        (magnetized || isThreeLaneCollision(this.rider.position.x, object.mesh.position.x, RIDER_Z, object.mesh.position.z)) &&
        pickup
      ) {
        this.collect(object);
        continue;
      }
      if (
        isThreeLaneCollision(this.rider.position.x, object.mesh.position.x, RIDER_Z, object.mesh.position.z) &&
        !pickup
      ) {
        this.hitHazard(object);
        continue;
      }
      if (!object.passedRider && object.mesh.position.z >= RIDER_Z + 0.8 && !pickup) {
        object.passedRider = true;
        const laneGap = Math.abs(object.mesh.position.x - this.rider.position.x);
        if (this.elapsedMs - this.lastSteerAt < 5_000 && laneGap >= 1.5 && laneGap <= 3.8) {
          this.rewardFlow(isTraffic(object.type) ? 22 : 15, isTraffic(object.type) ? "TRAFFIC NEAR MISS" : "NEAR MISS");
        }
      }
      if (
        pickup &&
        object.sequenceId !== undefined &&
        object.sequenceIndex !== undefined &&
        object.mesh.position.z > RIDER_Z + 2.1
      ) {
        this.failSequence(object);
        continue;
      }
      if (object.mesh.position.z > 12) this.removeObject(object);
    }
  }

  private collect(object: WorldObject): void {
    if (isPowerUpType(object.type)) {
      const definition = powerUpDefinitions[object.type];
      gameStore.collectPowerUp(object.type);
      gameAudio.playEffect("power-up-pickup");
      this.rewardFlow(15, `${definition.label.toUpperCase()} RESERVED`);
      this.objects
        .filter((candidate) => candidate.choiceId === object.choiceId)
        .forEach((candidate) => this.removeObject(candidate));
      return;
    }
    if (object.type !== "sweat" && object.type !== "cash") return;
    const amount = gameStore.collectBag(object.type);
    gameAudio.playEffect(object.type === "sweat" ? "sweat-pickup" : "cash-pickup");
    this.rewardFlow(10, object.type === "sweat" ? `+${amount} SWEAT` : `+$${amount}`);
    const sequenceId = object.sequenceId;
    this.removeObject(object);
    if (sequenceId !== undefined) this.recordChallengePickup(sequenceId);
  }

  private recordChallengePickup(sequenceId: number): void {
    const challenge = this.challenges.get(sequenceId);
    if (!challenge) return;
    challenge.collectedPickups += 1;
    if (challenge.collectedPickups < challenge.totalPickups) return;
    this.challenges.delete(sequenceId);
    const rules = encounterChallengeRules[challenge.encounter];
    if (!rules || challenge.failed) {
      this.showAnnouncement(`${encounterLabel[challenge.encounter]} SURVIVED · CLEAN BONUS LOST`, "bad", 1_600);
      return;
    }
    const reward = gameStore.completeChallenge(rules.cleanRewardMultiplier, rules.difficulty);
    gameAudio.playEffect("challenge-clean");
    this.rewardFlow(rules.flowReward, `CLEAN ×${rules.cleanRewardMultiplier}`);
    this.showAnnouncement(
      `CLEAN ×${rules.cleanRewardMultiplier} · +${formatCompactNumber(reward.sweat)} SWEAT · +$${formatCompactNumber(reward.cash)}`,
      "good",
      2_200,
    );
  }

  private failSequence(missed: WorldObject): void {
    if (missed.sequenceId === undefined || missed.sequenceIndex === undefined) return;
    const challenge = this.challenges.get(missed.sequenceId);
    if (challenge) challenge.failed = true;
    this.removeObject(missed);
    this.objects
      .filter(
        (object) =>
          object.sequenceId === missed.sequenceId &&
          object.sequenceIndex !== undefined &&
          object.sequenceIndex > (missed.sequenceIndex ?? -1),
      )
      .forEach((object) => this.removeObject(object));
    this.challenges.delete(missed.sequenceId);
    gameAudio.playEffect("challenge-missed");
    this.showAnnouncement("SEQUENCE MISSED · CLEAN BONUS LOST", "bad", 1_500);
  }

  private hitHazard(object: WorldObject): void {
    const traffic = isTraffic(object.type);
    const active = gameStore.getSnapshot().activePowerUp;
    if (active && powerUpDefinitions[active.type].hazardImmunity) {
      gameAudio.playEffect("shield-hit");
      this.rewardFlow(traffic ? 20 : 12, traffic ? "TRAFFIC SHIELD" : "POTHOLE SHIELD");
      this.removeObject(object);
      return;
    }
    const challenge = object.sequenceId === undefined ? undefined : this.challenges.get(object.sequenceId);
    if (challenge) challenge.failed = true;
    const lost = traffic ? gameStore.hitTraffic() : gameStore.hitPothole();
    gameAudio.playEffect(traffic ? "car-crash" : "pothole-crash");
    this.flow = 0;
    this.combo = 0;
    gameStore.setActiveFlowMultiplier(1);
    this.lastFlowActionAt = this.elapsedMs;
    this.cameraShake = traffic ? 0.72 : 0.4;
    this.showAnnouncement(`COLLISION · -$${formatCompactNumber(lost)}`, "bad", 1_450);
    this.removeObject(object);
  }

  private removeObject(object: WorldObject): void {
    const index = this.objects.indexOf(object);
    if (index >= 0) this.objects.splice(index, 1);
    this.roadWorld.remove(object.mesh);
    object.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      if (child instanceof THREE.Mesh || child instanceof THREE.Sprite) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      }
    });
  }

  private startEncounter(encounter: RideEncounter, snapshot: GameSnapshot): void {
    const rules = encounterChallengeRules[encounter];
    this.showAnnouncement(
      rules ? `${encounterLabel[encounter]} · CLEAN ×${rules.cleanRewardMultiplier}` : encounterLabel[encounter],
      "neutral",
      2_200,
    );
    const sequenceId = this.sequenceCount;
    this.sequenceCount += 1;
    const spawnLoot = (placements: Array<{ lane: number; z: number }>): void => {
      this.challenges.set(sequenceId, { encounter, totalPickups: placements.length, collectedPickups: 0, failed: false });
      const loot = lootSequenceForStage(snapshot.stage, placements.length);
      placements.forEach((placement, index) =>
        this.spawnPickup(loot[index], placement.lane, placement.z, sequenceId, index),
      );
    };
    const start = threeEncounterZ();

    switch (encounter) {
      case "bonus-line": {
        const lane = randomInt(0, 2);
        spawnLoot(Array.from({ length: 4 }, (_, index) => ({ lane, z: start - index * 11 })));
        this.spawnPothole((lane + 1) % 3, start - 18, sequenceId);
        this.spawnPothole((lane + 2) % 3, start - 42, sequenceId);
        break;
      }
      case "slalom": {
        const lanes = [0, 1, 2, 1, 0];
        const placements = lanes.map((lane, index) => {
          const z = start - index * 10.5;
          this.spawnPothole(lane, z, sequenceId);
          return { lane: (lane + 1) % 3, z: z - 5 };
        });
        spawnLoot(placements);
        break;
      }
      case "feed-zone": {
        const lane = randomInt(0, 2);
        spawnLoot(Array.from({ length: 6 }, (_, index) => ({ lane, z: start - index * 9 })));
        break;
      }
      case "sprint": {
        const placements = Array.from({ length: 7 }, (_, index) => {
          const lane = index % 2 === 0 ? 1 : randomInt(0, 2);
          const z = start - index * 8.5;
          if (index === 2 || index === 5) this.spawnPothole((lane + 1) % 3, z - 4, sequenceId);
          return { lane, z };
        });
        spawnLoot(placements);
        break;
      }
      case "hairpins": {
        const placements = [0, 2, 0, 2, 1].map((lane, index) => {
          const z = start - index * 10.5;
          this.spawnPothole(lane, z, sequenceId);
          return { lane: lane === 0 ? 2 : 0, z: z - 5 };
        });
        spawnLoot(placements);
        break;
      }
      case "traffic": {
        const pattern = createTrafficGauntlet(this.targetLane);
        const spacing = trafficColumnSpacing(VISUAL_QA.speedKmh ?? snapshot.stats.speedKmh, snapshot.stage) / 12;
        const placements = pattern.map((column, index) => {
          const z = start - index * spacing;
          column.hazardLanes.forEach((lane) => this.spawnTraffic(lane, z, sequenceId));
          return { lane: column.rewardLane, z: z - 5 };
        });
        spawnLoot(placements);
        break;
      }
      case "power-up":
        roadPowerUpChoices.forEach((type, lane) => this.spawnPowerUp(type, lane, start, sequenceId));
        break;
      case "draft":
        this.spawnDraftCyclist();
        break;
    }
  }

  private updateFlow(delta: number, decayPerSecond: number): void {
    if (VISUAL_QA.flow !== null) {
      this.flow = VISUAL_QA.flow;
    } else if (this.elapsedMs - this.lastFlowActionAt > 2_500 && !this.drafting) {
      this.flow = decayFlow(this.flow, delta, decayPerSecond);
      if (this.flow === 0) this.combo = 0;
    }
    gameStore.setActiveFlowMultiplier(flowMultiplier(this.flow));
  }

  private reportFlow(): void {
    const roundedFlow = Math.round(this.flow);
    if (roundedFlow === this.lastReportedFlow && this.combo === this.lastReportedCombo) return;
    this.lastReportedFlow = roundedFlow;
    this.lastReportedCombo = this.combo;
    this.callbacks.onFlowChange(roundedFlow, this.combo);
  }

  private rewardFlow(amount: number, label: string): void {
    this.flow = addFlow(this.flow, amount);
    this.combo += 1;
    this.lastFlowActionAt = this.elapsedMs;
    this.showAnnouncement(label, "good", 900);
  }

  private spawnDraftCyclist(): void {
    if (this.draftCyclist) return;
    this.draftLane = VISUAL_QA.draftLane ?? randomInt(0, 2);
    this.draftCyclist = createCyclist(
      0x5d83b9,
      0x23384d,
      threeRiderModelScale("draft"),
    );
    this.draftCyclist.position.set(THREE_LANE_X[this.draftLane], 0, -38);
    this.roadWorld.add(this.draftCyclist);
    this.draftAcquisitionRemaining = 3.2;
    this.draftTimeRemaining = 0;
    this.draftGraceRemaining = 0;
    this.draftLaneCountdown = randomBetween(2.7, 4.2);
    this.drafting = false;
    this.droppedFromDraft = false;
    gameStore.setTemporaryDraftBonus(0);
  }

  private updateDraft(delta: number, stage: number, speed: number): void {
    const cyclist = this.draftCyclist;
    if (!cyclist) {
      gameStore.setTemporaryDraftBonus(0);
      return;
    }
    this.animateCyclist(cyclist, speed, delta);
    cyclist.position.x = THREE.MathUtils.lerp(cyclist.position.x, THREE_LANE_X[this.draftLane] + roadBend(cyclist.position.z, this.travelled), 1 - Math.exp(-delta * 5));
    if (this.droppedFromDraft) {
      cyclist.position.z -= 17 * delta;
      if (cyclist.position.z < -82) {
        this.roadWorld.remove(cyclist);
        this.draftCyclist = null;
        const [minimum, maximum] = encounterDelayRange(stage);
        this.encounterCountdown = randomBetween(minimum, maximum);
      }
      return;
    }
    if (cyclist.position.z < -6.5) {
      cyclist.position.z = Math.min(-6.5, cyclist.position.z + 14 * delta);
      return;
    }
    const rules = draftRulesForStage(stage);
    const aligned = Math.abs(this.rider.position.x - cyclist.position.x) < 0.82;
    if (!this.drafting) {
      this.draftAcquisitionRemaining -= delta;
      if (aligned) {
        this.drafting = true;
        this.draftGraceRemaining = rules.reactionSeconds;
        this.draftTimeRemaining = rules.durationSeconds;
        gameStore.setTemporaryDraftBonus(RANDOM_RIDER_DRAFT_BONUS);
        gameAudio.playEffect("draft-start");
        this.rewardFlow(12, `IN THE DRAFT · +${RANDOM_DRAFT_PERCENT}% SPEED`);
      } else if (this.draftAcquisitionRemaining <= 0) {
        this.dropDraft();
      }
      return;
    }
    this.draftTimeRemaining -= delta;
    if (this.draftTimeRemaining <= 0) {
      this.finishDraft();
      return;
    }
    this.draftLaneCountdown -= delta;
    if (this.draftLaneCountdown <= 0) {
      const direction = this.draftLane === 0 ? 1 : this.draftLane === 2 ? -1 : Math.random() < 0.5 ? -1 : 1;
      this.draftLane += direction;
      this.draftLaneCountdown = randomBetween(2.5, 4);
      this.draftGraceRemaining = rules.reactionSeconds;
      this.showAnnouncement("FOLLOW THE WHEEL!", "neutral", 900);
    }
    if (aligned) {
      this.draftGraceRemaining = rules.reactionSeconds;
      gameStore.setTemporaryDraftBonus(RANDOM_RIDER_DRAFT_BONUS);
      this.flow = addFlow(this.flow, delta * 2.5);
      this.lastFlowActionAt = this.elapsedMs;
    } else {
      this.draftGraceRemaining -= delta;
      if (this.draftGraceRemaining <= 0) this.dropDraft();
    }
  }

  private dropDraft(): void {
    const wasDrafting = this.drafting;
    this.drafting = false;
    this.droppedFromDraft = true;
    gameStore.setTemporaryDraftBonus(0);
    this.showAnnouncement("DROPPED!", "bad", 1_300);
    if (wasDrafting) gameAudio.playEffect("draft-end");
  }

  private updateSlipstream(delta: number, speed: number): void {
    const leader = this.drafting ? this.draftCyclist : this.domestiques[0];
    const alignment = leader ? Math.abs(this.rider.position.x - leader.position.x) : 0;
    const strength = this.drafting
      ? 1 - THREE.MathUtils.smoothstep(alignment, 0.45, 1.5)
      : 0.48;
    this.slipstream.update(delta, speed, leader?.position ?? null, this.rider.position, strength);
  }

  private finishDraft(): void {
    this.drafting = false;
    this.droppedFromDraft = true;
    gameStore.setTemporaryDraftBonus(0);
    gameAudio.playEffect("draft-end");
    gameAudio.playEffect("challenge-clean");
    const rules = encounterChallengeRules.draft;
    const reward = gameStore.completeChallenge(rules?.cleanRewardMultiplier ?? 6, rules?.difficulty ?? 4);
    this.rewardFlow(rules?.flowReward ?? 24, "DRAFT CLEAN");
    this.showAnnouncement(
      `DRAFT CLEAN ×${rules?.cleanRewardMultiplier ?? 6} · +${formatCompactNumber(reward.sweat)} SWEAT · +$${formatCompactNumber(reward.cash)}`,
      "good",
      2_200,
    );
  }

  private syncDomestiques(level: number): void {
    const count = Math.max(0, Math.min(3, Math.floor(level)));
    while (this.domestiques.length < count) {
      const rider = createCyclist(
        0xe5d6ad,
        0x7d4930,
        threeRiderModelScale("teammate"),
      );
      this.domestiques.push(rider);
      this.roadWorld.add(rider);
    }
    while (this.domestiques.length > count) {
      const rider = this.domestiques.pop();
      if (rider) this.roadWorld.remove(rider);
    }
  }

  private updateDomestiques(speed: number, delta: number): void {
    this.domestiques.forEach((rider, index) => {
      const side = index % 2 === 0 ? -0.85 : 0.85;
      rider.position.x = THREE.MathUtils.lerp(rider.position.x, this.rider.position.x + side, 1 - Math.exp(-delta * 5));
      rider.position.z = -2.2 - index * 1.9;
      this.animateCyclist(rider, speed, delta);
    });
  }

  private animateCyclist(cyclist: THREE.Group, speed: number, delta: number): void {
    const wheels = cyclist.userData.wheels as THREE.Group[] | undefined;
    wheels?.forEach((wheelMesh) => {
      wheelMesh.rotation.z -= speed * delta * 1.55;
    });
    const speedKmh = speed / 0.54;
    const pedalAngularSpeed = threePedalCadenceRpm(speedKmh) * Math.PI / 30;
    const pedalPhase =
      ((cyclist.userData.pedalPhase as number | undefined) ?? 0) +
      pedalAngularSpeed * delta;
    cyclist.userData.pedalPhase = pedalPhase;
    positionCyclistLegs(cyclist, pedalPhase);
    cyclist.position.y = roadSurfaceHeight(cyclist.position.z, this.roadPitch) + Math.sin(pedalPhase * 2) * 0.009;
    cyclist.rotation.x = roadSurfacePitch(cyclist.position.z, this.roadPitch);
    cyclist.rotation.z += Math.sin(pedalPhase) * 0.003;
  }

  private updatePowerUpFeedback(active: GameSnapshot["activePowerUp"]): void {
    this.aura.visible = Boolean(active && !active.suppressed);
    if (!active || active.suppressed) return;
    const color = active.type === "jump" ? 0xffe26f : active.type === "lucky-bidon" ? 0xa7e8ff : 0x71f5cc;
    const material = this.aura.material as THREE.MeshBasicMaterial;
    material.color.setHex(color);
    material.opacity = 0.48 + Math.sin(this.elapsedMs / 110) * 0.22;
    this.aura.scale.setScalar(1 + Math.sin(this.elapsedMs / 150) * 0.14);
  }

  private updateFans(_speed: number, _delta: number): void {
    this.movingScenery.forEach((object) => {
      const arms = object.userData.wavingArms as FanArmRig[] | undefined;
      if (!arms) return;
      const phase = (object.userData.wavePhase as number | undefined) ?? 0;
      arms.forEach((arm) => {
        arm.pivot.rotation.z =
          arm.baseRotation +
          Math.sin(this.elapsedMs / 210 + phase + arm.phaseOffset) * arm.amplitude;
      });
    });
  }

  private showAnnouncement(
    message: string,
    tone: Announcement["tone"],
    duration: number,
  ): void {
    this.announcement = { message, tone, until: this.elapsedMs + duration };
    this.callbacks.onAnnouncement(this.announcement);
  }

  private resetWorld(): void {
    this.slipstream.reset();
    this.roadPitch = threeRoadPitch(VISUAL_QA.gradient ?? gameStore.getSnapshot().currentGradient);
    this.applyGrade();
    [...this.objects].forEach((object) => this.removeObject(object));
    this.challenges.clear();
    if (this.draftCyclist) this.roadWorld.remove(this.draftCyclist);
    this.draftCyclist = null;
    this.domestiques.forEach((rider) => this.roadWorld.remove(rider));
    this.domestiques = [];
    this.targetLane = 1;
    this.rider.position.set(THREE_LANE_X[1], 0, RIDER_Z);
    this.encounterCountdown = VISUAL_QA.encounter ? 0 : 1_200;
    this.encounterCount = 0;
    this.sequenceCount = 0;
    this.flow = 0;
    this.combo = 0;
    this.lastReportedFlow = -1;
    this.lastReportedCombo = -1;
    this.lastFlowActionAt = this.elapsedMs;
    this.drafting = false;
    this.droppedFromDraft = false;
    gameStore.setActiveFlowMultiplier(1);
    gameStore.setTemporaryDraftBonus(0);
    this.reportFlow();
  }
}
