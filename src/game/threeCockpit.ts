import * as THREE from "three";
import { mergeStaticDetails } from "./threeScenery";

const material = (color: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

const curveTube = (points: THREE.Vector3[], radius: number, surface: THREE.Material, segments = 24): THREE.Mesh =>
  new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, radius, radius < 0.004 ? 6 : radius < 0.012 ? 8 : 12, false), surface);

const ellipsoid = (surface: THREE.Material, position: THREE.Vector3, scale: THREE.Vector3, detail = 16): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, detail, Math.max(6, Math.round(detail * 0.6))), surface);
  mesh.position.copy(position); mesh.scale.copy(scale);
  return mesh;
};

// A small repeating wrap pattern follows the tube UVs; no external asset load.
const tapeTexture = (): THREE.DataTexture => {
  const width = 256, height = 32, pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const seam = (x + y * 0.8) % 16;
    const grain = Math.sin(x * 2.3 + y * 5.7) * 3;
    const value = Math.round((seam < 1.5 ? 155 : seam < 3 ? 206 : 232) + grain);
    pixels.set([value, value, value, 255], (y * width + x) * 4);
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true; texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

// Fine, low-contrast skin variation and fabric weave survive a close view.
const surfaceTexture = (fabric: boolean): THREE.DataTexture => {
  const size = 256, pixels = new Uint8Array(size * size * 4);
  let seed = 917;
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const noise = random(), low = Math.sin(x * 0.049) * Math.cos(y * 0.074);
    const weave = fabric ? ((x % 4 < 2) === (y % 4 < 2) ? 9 : -9) : 0;
    const value = fabric ? 226 + weave + (noise - 0.5) * 7 : 242 + low * 5 + (noise - 0.5) * 5 - (noise < 0.012 ? 12 : 0);
    pixels.set([value, value - (fabric ? 0 : 4 + low * 5), value - (fabric ? 0 : 7 + low * 6), 255], (y * size + x) * 4);
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; texture.needsUpdate = true;
  return texture;
};

const smoothSeam = (geometry: THREE.BufferGeometry, rings: number, sides: number): void => {
  geometry.computeVertexNormals(); const normals = geometry.attributes.normal;
  for (let ring = 0; ring <= rings; ring++) {
    const a = ring * (sides + 1), b = a + sides;
    const normal = new THREE.Vector3().fromBufferAttribute(normals, a).add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize();
    normals.setXYZ(a, normal.x, normal.y, normal.z); normals.setXYZ(b, normal.x, normal.y, normal.z);
  }
};

// Connected sections replace separate spherical wrist and glove pieces.
const gloveBody = (glove: THREE.Material): THREE.Mesh => {
  const sections = [
    [0.024, 0.025, 0.021, 0], [0.01, 0.027, 0.022, 0.002],
    [-0.012, 0.031, 0.016, 0.009], [-0.037, 0.037, 0.014, 0.017],
    [-0.06, 0.036, 0.012, 0.019], [-0.08, 0.034, 0.009, 0.017],
  ];
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const sides = 24;
  sections.forEach(([z, width, thickness, height], ring) => {
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * Math.PI * 2, c = Math.cos(angle), n = Math.sin(angle);
      positions.push(Math.sign(c) * Math.abs(c) ** 0.86 * width, height + Math.sign(n) * Math.abs(n) ** 0.65 * thickness, z);
      uvs.push(side / sides, ring / (sections.length - 1));
      if (ring < sections.length - 1 && side < sides) {
        const a = ring * (sides + 1) + side, b = a + sides + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  });
  const cap = positions.length / 3; positions.push(0, 0.017, -0.08); uvs.push(0.5, 1);
  for (let side = 0; side < sides; side++) indices.push(cap, cap - sides + side, cap - sides - 1 + side);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices);
  smoothSeam(geometry, sections.length - 1, sides);
  return new THREE.Mesh(geometry, glove);
};

// A continuous upper arm, rounded elbow and forearm. The upper arm enters
// from the side of the camera; the forearm reaches inward to the brake hood.
const bentArm = (upper: THREE.Vector3, elbow: THREE.Vector3, wrist: THREE.Vector3, skin: THREE.Material): THREE.Mesh => {
  // Continue toward the body beyond the visible upper arm so its open end
  // stays outside the frustum on portrait views and descending grades too.
  const entry = upper.clone().add(upper.clone().sub(elbow));
  const curve = new THREE.CatmullRomCurve3([entry, upper, upper.clone().lerp(elbow, 0.7), elbow, elbow.clone().lerp(wrist, 0.5), wrist.clone().add(new THREE.Vector3(0, 0, 0.045)), wrist]);
  const profile = [0.058, 0.064, 0.058, 0.052, 0.048, 0.051, 0.042, 0.03, 0.024];
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const rings = 60, sides = 20;
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings, center = curve.getPoint(t), tangent = curve.getTangent(t);
    const across = new THREE.Vector3(0, 1, 0).cross(tangent).normalize();
    const up = tangent.clone().cross(across).normalize();
    const span = t * (profile.length - 1), index = Math.min(profile.length - 2, Math.floor(span));
    const fraction = span - index, smooth = fraction * fraction * (3 - 2 * fraction);
    const radius = THREE.MathUtils.lerp(profile[index], profile[index + 1], smooth);
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * Math.PI * 2;
      const point = center.clone().addScaledVector(across, Math.cos(angle) * radius)
        .addScaledVector(up, Math.sin(angle) * radius * (0.83 + 0.06 * t));
      positions.push(point.x, point.y, point.z); uvs.push(side / sides, t);
      if (ring < rings && side < sides) {
        const a = ring * (sides + 1) + side, b = a + sides + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  smoothSeam(geometry, rings, sides);
  return new THREE.Mesh(geometry, skin);
};

export const createCockpit = (): THREE.Group => {
  const group = new THREE.Group(); group.name = "First-person cockpit";
  const carbon = material(0x263136, 0.44, 0.25), metal = material(0x606b70, 0.32, 0.65);
  const tape = material(0x303a3d, 0.94), rubber = material(0x253035, 0.9);
  const skin = material(0xcfa88d, 0.86), glove = material(0x48555f, 0.97);
  const stitching = material(0x78858a, 0.95);
  const nail = material(0xdfb998, 0.65);
  const skinSurface = surfaceTexture(false), fabric = surfaceTexture(true);
  skin.map = skinSurface; skin.bumpMap = skinSurface; skin.bumpScale = 0.00012;
  glove.map = fabric; glove.bumpMap = fabric; glove.bumpScale = 0.00018;
  const wrap = tapeTexture(); tape.map = wrap; tape.bumpMap = wrap; tape.bumpScale = 0.00035;
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  group.add(curveTube([v(0, -0.17, 0.14), v(0, -0.035, -0.015), v(0, 0, -0.105)], 0.018, carbon));
  group.add(curveTube([v(-0.33, 0.004, -0.13), v(-0.17, 0, -0.102), v(0, 0, -0.1), v(0.17, 0, -0.102), v(0.33, 0.004, -0.13)], 0.017, tape, 40));
  // Stem faceplate, mounting bolts and a short forward computer mount.
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.037, 0.033), carbon);
  clamp.position.set(0, 0, -0.1); group.add(clamp);
  for (const x of [-0.017, 0.017]) for (const y of [-0.015, 0.015])
    group.add(ellipsoid(metal, v(x, y, -0.122), v(0.004, 0.004, 0.002), 8));
  group.add(curveTube([v(0, 0.006, -0.12), v(0, 0.017, -0.22)], 0.008, carbon));

  const grips: THREE.Vector3[] = [];
  const armPose: { upper: THREE.Vector3; elbow: THREE.Vector3; wrist: THREE.Vector3 }[] = [];
  for (const side of [-1, 1]) {
    const wrist = v(side * 0.355, 0.016, -0.115);
    grips.push(wrist.clone());
    const upper = v(side * 0.48, 0.62, 0.55), elbow = v(side * 0.65, 0.1, 0.05);
    const armWrist = wrist.clone().add(v(0, 0, 0.004));
    armPose.push({upper: upper.clone(), elbow: elbow.clone(), wrist: armWrist.clone()});
    group.add(bentArm(upper, elbow, armWrist, skin));
    group.add(curveTube([v(side * 0.32, 0.004, -0.126), v(side * 0.355, 0.006, -0.185), v(side * 0.385, -0.065, -0.27), v(side * 0.39, -0.16, -0.235), v(side * 0.375, -0.18, -0.075)], 0.016, tape, 40));
    group.add(ellipsoid(carbon, v(side * 0.375, -0.18, -0.075), v(0.0165, 0.0165, 0.003)));
    // Low rubber body sits beneath the palm; the raised nose supports fingers.
    group.add(ellipsoid(rubber, v(side * 0.355, 0.002, -0.196), v(0.024, 0.021, 0.053)));
    group.add(ellipsoid(rubber, v(side * 0.355, 0.012, -0.232), v(0.020, 0.027, 0.023)));
    group.add(curveTube([v(side * 0.355, 0.006, -0.261), v(side * 0.355, -0.045, -0.279), v(side * 0.355, -0.1, -0.264), v(side * 0.355, -0.124, -0.229)], 0.005, metal));
    group.add(curveTube([v(side * 0.35, -0.01, -0.19), v(side * 0.26, -0.047, -0.22), v(side * 0.14, -0.07, -0.16), v(side * 0.015, -0.1, 0.045)], 0.003, rubber));

    const hand = new THREE.Group(); hand.position.copy(wrist);
    hand.add(gloveBody(glove));
    // Panel seams follow the flatter back of the hand and the fitted cuff.
    hand.add(curveTube([v(-0.025, 0.02, 0.008), v(-0.029, 0.025, -0.021), v(-0.025, 0.03, -0.067)], 0.0008, stitching));
    hand.add(curveTube([v(0.025, 0.02, 0.008), v(0.029, 0.025, -0.021), v(0.025, 0.03, -0.067)], 0.0008, stitching));
    const cuff = Array.from({length:25}, (_, i) => v(Math.cos(i / 24 * Math.PI * 2) * 0.027, 0.002 + Math.sin(i / 24 * Math.PI * 2) * 0.022, 0.01));
    hand.add(curveTube(cuff, 0.0007, stitching));
    for (let finger = 0; finger < 4; finger++) {
      const x = side * (finger - 1.5) * 0.017, reach = [0.132, 0.142, 0.137, 0.119][finger];
      const points = [v(x, 0.024, -0.073), v(x, 0.024, -0.101), v(x, 0.012, -reach + 0.014), v(x, -0.006, -reach), v(x, -0.027, -reach + 0.013)];
      const radius = finger === 3 ? 0.0065 : 0.0075;
      hand.add(curveTube(points.slice(0, 2), radius * 1.04, glove, 8));
      hand.add(curveTube(points.slice(1), radius, skin, 18));
      hand.add(ellipsoid(skin, points[4], v(radius * 0.94, radius * 0.94, radius * 0.94), 16));
      const fingernail = ellipsoid(nail, points[4].clone().add(v(0, radius * 0.7, -0.002)), v(radius * 0.58, 0.0007, 0.006));
      fingernail.rotation.x = -0.65; hand.add(fingernail);
    }
    const thumb = [v(-side * 0.026, 0.014, -0.022), v(-side * 0.043, 0.008, -0.047), v(-side * 0.042, -0.016, -0.08), v(-side * 0.025, -0.021, -0.099)];
    hand.add(curveTube(thumb.slice(0, 2), 0.01, glove, 8));
    hand.add(curveTube(thumb.slice(1), 0.009, skin, 18));
    hand.add(ellipsoid(skin, thumb[3], v(0.0085, 0.0085, 0.0085), 16));
    group.add(hand);
  }
  const computer = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.019, 0.146), carbon);
  computer.position.set(0, 0.036, -0.223); group.add(computer);
  const display = document.createElement("canvas"); display.width = 192; display.height = 256;
  const displayTexture = new THREE.CanvasTexture(display); displayTexture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.087, 0.12), new THREE.MeshBasicMaterial({ map: displayTexture }));
  screen.rotation.x = -Math.PI / 2; screen.position.set(0, 0.046, -0.223); group.add(screen);
  // All parts move together, including hands, so merging keeps this close-up cheap.
  mergeStaticDetails(group, true);
  group.userData.display = display; group.userData.displayTexture = displayTexture;
  group.userData.ownedTextures = [displayTexture, wrap, skinSurface, fabric]; group.userData.grips = grips; group.userData.armPose = armPose;
  group.position.set(0, -0.35, -0.7); group.visible = false;
  return group;
};
