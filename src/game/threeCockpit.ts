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

// Elliptical cross sections taper through the forearm muscle into the wrist.
// Smooth connected rings avoid the cylinder/sphere joint visible at close range.
const forearm = (elbow: THREE.Vector3, wrist: THREE.Vector3, skin: THREE.Material): THREE.Mesh => {
  const curve = new THREE.CatmullRomCurve3([elbow, elbow.clone().lerp(wrist, 0.48).add(new THREE.Vector3(0, 0.018, 0)), wrist]);
  const profile = [0.052, 0.057, 0.053, 0.043, 0.032, 0.025];
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const rings = 24, sides = 20;
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
  // Match duplicate seam normals so there is no bright longitudinal edge.
  const normals = geometry.attributes.normal;
  for (let ring = 0; ring <= rings; ring++) {
    const a = ring * (sides + 1), b = a + sides;
    const normal = new THREE.Vector3().fromBufferAttribute(normals, a).add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize();
    normals.setXYZ(a, normal.x, normal.y, normal.z); normals.setXYZ(b, normal.x, normal.y, normal.z);
  }
  return new THREE.Mesh(geometry, skin);
};

export const createCockpit = (): THREE.Group => {
  const group = new THREE.Group(); group.name = "First-person cockpit";
  const carbon = material(0x263136, 0.44, 0.25), metal = material(0x606b70, 0.32, 0.65);
  const tape = material(0x303a3d, 0.94), rubber = material(0x253035, 0.9);
  const skin = material(0xd6a17b, 0.82), glove = material(0x334149, 0.92);
  const stitching = material(0x627079, 0.95);
  const wrap = tapeTexture(); tape.map = wrap; tape.bumpMap = wrap; tape.bumpScale = 0.00035;
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  group.add(curveTube([v(0, -0.17, 0.14), v(0, -0.035, -0.015), v(0, 0, -0.105)], 0.024, carbon));
  group.add(curveTube([v(-0.33, 0.004, -0.13), v(-0.17, 0, -0.102), v(0, 0, -0.1), v(0.17, 0, -0.102), v(0.33, 0.004, -0.13)], 0.022, tape, 40));
  // Stem faceplate, mounting bolts and a short forward computer mount.
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.05, 0.038), carbon);
  clamp.position.set(0, 0, -0.1); group.add(clamp);
  for (const x of [-0.017, 0.017]) for (const y of [-0.015, 0.015])
    group.add(ellipsoid(metal, v(x, y, -0.122), v(0.004, 0.004, 0.002), 8));
  group.add(curveTube([v(0, 0.006, -0.12), v(0, 0.017, -0.22)], 0.008, carbon));

  const grips: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    const wrist = v(side * 0.355, 0.016, -0.115);
    grips.push(wrist.clone());
    group.add(forearm(v(side * 0.56, -0.29, 0.4), wrist, skin));
    group.add(curveTube([v(side * 0.32, 0.004, -0.126), v(side * 0.355, 0.006, -0.185), v(side * 0.385, -0.065, -0.27), v(side * 0.39, -0.16, -0.235), v(side * 0.375, -0.18, -0.075)], 0.021, tape, 40));
    group.add(ellipsoid(carbon, v(side * 0.375, -0.18, -0.075), v(0.0215, 0.0215, 0.003)));
    // Low rubber body sits beneath the palm; the raised nose supports fingers.
    group.add(ellipsoid(rubber, v(side * 0.355, 0.008, -0.195), v(0.03, 0.027, 0.066)));
    group.add(ellipsoid(rubber, v(side * 0.355, 0.025, -0.239), v(0.024, 0.036, 0.027)));
    group.add(curveTube([v(side * 0.355, 0.006, -0.261), v(side * 0.355, -0.045, -0.279), v(side * 0.355, -0.1, -0.264), v(side * 0.355, -0.124, -0.229)], 0.005, metal));
    group.add(curveTube([v(side * 0.35, -0.01, -0.19), v(side * 0.26, -0.047, -0.22), v(side * 0.14, -0.07, -0.16), v(side * 0.015, -0.1, 0.045)], 0.003, rubber));

    const hand = new THREE.Group(); hand.position.copy(wrist);
    hand.add(ellipsoid(skin, v(0, 0, 0.01), v(0.025, 0.022, 0.035)));
    hand.add(ellipsoid(glove, v(0, 0.023, -0.035), v(0.039, 0.024, 0.058)));
    hand.add(ellipsoid(glove, v(0, 0.009, 0.001), v(0.028, 0.023, 0.012)));
    // Thin curved seams and knuckle pads rather than a flat mitten silhouette.
    hand.add(curveTube([v(-0.027, 0.028, -0.058), v(0, 0.047, -0.043), v(0.027, 0.028, -0.058)], 0.0012, stitching));
    for (let finger = 0; finger < 4; finger++) {
      const x = (finger - 1.5) * 0.018, reach = [0.11, 0.12, 0.115, 0.097][finger];
      const points = [v(x, 0.025, -0.07), v(x, 0.016, -reach), v(x, -0.012, -reach - 0.017), v(x, -0.034, -reach + 0.007)];
      const radius = finger === 3 ? 0.007 : 0.008;
      hand.add(curveTube(points.slice(0, 2), radius * 1.1, glove, 8));
      hand.add(curveTube(points.slice(1), radius, skin, 12));
      hand.add(ellipsoid(skin, points[1], v(radius, radius, radius), 10));
      hand.add(ellipsoid(skin, points[3], v(radius * 0.9, radius * 0.9, radius * 0.9), 10));
      hand.add(ellipsoid(glove, v(x, 0.034, -0.064), v(0.007, 0.008, 0.012), 10));
    }
    const thumb = [v(-side * 0.029, 0.018, -0.008), v(-side * 0.052, 0, -0.037), v(-side * 0.045, -0.02, -0.073), v(-side * 0.025, -0.023, -0.086)];
    hand.add(curveTube(thumb.slice(0, 2), 0.011, glove, 8));
    hand.add(curveTube(thumb.slice(1), 0.01, skin, 12));
    hand.add(ellipsoid(skin, thumb[3], v(0.009, 0.009, 0.009), 10));
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
  group.userData.ownedTextures = [displayTexture, wrap]; group.userData.grips = grips;
  group.position.set(0, -0.35, -0.7); group.visible = false;
  return group;
};
