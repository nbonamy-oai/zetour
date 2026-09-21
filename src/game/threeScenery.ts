import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Surface = "bark" | "hay" | "plaster" | "stone" | "roof" | "wood" | "metal";
export type SceneryTime = { value: number };

const patterns: Record<Surface, string> = {
  bark: `float grooves = noise(p.xy * vec2(22.0, 0.7));
    float pattern = grooves * 0.7 + noise(p.xy * 45.0) * 0.3;
    float relief = pattern * 0.018;`,
  hay: `float angle = atan(p.z, p.x), radius = length(p.xz);
    float end = smoothstep(0.6, 0.9, abs(vLocalNormal.y));
    float winding = sin(radius * 110.0 + angle * 1.7 + noise(p.xz * 18.0) * 0.8);
    float fibers = sin(angle * 190.0 + p.y * 9.0 + noise(p.xy * 30.0) * 2.0);
    float pattern = 0.5 + mix(fibers, winding, end) * 0.22 + (noise(p.xy * 80.0) - 0.5) * 0.25;
    pattern -= end * (1.0 - smoothstep(0.02, 0.14, radius)) * 0.3;
    float relief = pattern * 0.01;`,
  plaster: `float pattern = noise(p.xy * 18.0) * 0.45 + noise(p.zy * 4.0) * 0.15 + 0.2;
    float relief = pattern * 0.004;`,
  stone: `vec2 wall = abs(vLocalNormal.x) > abs(vLocalNormal.z) ? p.zy : p.xy;
    vec2 blocks = wall * vec2(2.8, 4.2); blocks.x += mod(floor(blocks.y), 2.0) * 0.5;
    vec2 edge = min(fract(blocks), 1.0 - fract(blocks));
    float joints = 1.0 - smoothstep(0.02, 0.07, min(edge.x, edge.y));
    float pattern = 0.65 + (hash(floor(blocks)) - 0.5) * 0.3 - joints * 0.4 + (noise(wall * 25.0) - 0.5) * 0.15;
    float relief = (1.0 - joints) * 0.015 + pattern * 0.003;`,
  roof: `vec2 slope = abs(vLocalNormal.x) > abs(vLocalNormal.z) ? p.zy : p.xy;
    vec2 tiles = slope * vec2(7.0, 10.0); tiles.x += floor(tiles.y) * 0.5;
    vec2 edge = min(fract(tiles), 1.0 - fract(tiles));
    float seams = 1.0 - smoothstep(0.02, 0.08, min(edge.x, edge.y));
    float pattern = 0.6 + (hash(floor(tiles)) - 0.5) * 0.25 - seams * 0.4;
    float relief = sin(fract(tiles.x) * 3.14159) * 0.008 - seams * 0.004;`,
  wood: `float grain = sin(p.x * 65.0 + noise(p.xy * vec2(5.0, 0.4)) * 10.0);
    float pattern = 0.55 + grain * 0.18 + (noise(p.xy * 20.0) - 0.5) * 0.2;
    float relief = pattern * 0.003;`,
  metal: `float pattern = 0.55 + (noise(p.zy * vec2(1.0, 100.0)) - 0.5) * 0.12;
    float relief = pattern * 0.0005;`,
};

/** Object-space grain avoids texture stretching when scenery moves or bends. */
export const sceneryMaterial = (
  color: number,
  surface: Surface,
): THREE.MeshStandardMaterial => {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: surface === "metal" ? 0.45 : 0.94,
    metalness: surface === "metal" ? 0.65 : 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `
      #include <common>
      varying vec3 vLocal, vLocalNormal;
    `,
      )
      .replace(
        "#include <begin_vertex>",
        `
      #include <begin_vertex>
      vLocal = position; vLocalNormal = normal;
    `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `
      #include <common>
      varying vec3 vLocal, vLocalNormal;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
      }
    `,
      )
      .replace(
        "#include <color_fragment>",
        `
      #include <color_fragment>
      vec3 p = vLocal;
      ${patterns[surface]}
      float resolved = 1.0 - smoothstep(0.015, 0.12, max(length(dFdx(p)), length(dFdy(p))));
      diffuseColor.rgb *= 1.0 + (pattern - 0.5) * resolved * 0.5;
      relief *= resolved;
    `,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `
      #include <normal_fragment_maps>
      vec3 dx = dFdx(-vViewPosition), dy = dFdy(-vViewPosition);
      vec3 rx = cross(dy,normal), ry = cross(normal,dx);
      float det = dot(dx,rx);
      normal = normalize(abs(det)*normal - sign(det)*(dFdx(relief)*rx+dFdy(relief)*ry));
    `,
      );
  };
  material.customProgramCacheKey = () => `scenery-${surface}-v1`;
  return material;
};

const seededRandom = (seed: number): (() => number) => {
  let state = seed + 731;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};
const shadows = (group: THREE.Group): THREE.Group => {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return group;
};

// A compound leaf spray has curved blades instead of a solid crown silhouette.
const leafSpray = (conifer = false): THREE.BufferGeometry => {
  const vertices: number[] = [],
    indices: number[] = [];
  for (let leaf = 0; leaf < (conifer ? 10 : 5); leaf += 1) {
    const angle = conifer ? (leaf % 2 ? 1 : -1) * 0.8 : leaf * 2.39996;
    const root = conifer
      ? new THREE.Vector3(0, 0, leaf * 0.06)
      : new THREE.Vector3();
    const length = conifer ? 0.22 + (10 - leaf) * 0.016 : 0.32;
    const width = conifer ? 0.028 : 0.12;
    const tip = root
      .clone()
      .add(
        new THREE.Vector3(
          Math.sin(angle) * length,
          0.07,
          Math.cos(angle) * length,
        ),
      );
    const middle = root.clone().lerp(tip, 0.5);
    middle.y += 0.06;
    const across = new THREE.Vector3(
      Math.cos(angle) * width,
      0,
      -Math.sin(angle) * width,
    );
    const i = vertices.length / 3;
    for (const point of [
      root,
      middle.clone().add(across),
      tip,
      middle.clone().sub(across),
    ])
      vertices.push(point.x, point.y, point.z);
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

const windVertex = (source: string): string =>
  source
    .replace(
      "#include <common>",
      `
  #include <common>
  uniform float sceneryTime, windRooted;
`,
    )
    .replace(
      "#include <begin_vertex>",
      `
  #include <begin_vertex>
  float phase = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 1.3;
  float bend = mix(1.0, smoothstep(0.0, 0.35, position.y), windRooted);
  transformed.x += sin(sceneryTime * 1.3 + phase) * 0.1 * bend;
  transformed.y += sin(sceneryTime * 1.8 + phase) * 0.025 * bend;
`,
    );

const foliage = (
  geometry: THREE.BufferGeometry,
  count: number,
  time: SceneryTime,
  rooted = false,
): THREE.InstancedMesh => {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.87,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sceneryTime = time;
    shader.uniforms.windRooted = { value: rooted ? 1 : 0 };
    shader.vertexShader = windVertex(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_begin>",
      `
      #include <normal_fragment_begin>
      vec3 foliageUp = normalize((viewMatrix * vec4(0.0,1.0,0.0,0.0)).xyz);
      normal = normalize(mix(normal,foliageUp,0.55));
    `,
    );
  };
  material.customProgramCacheKey = () => "scenery-foliage-wind-v1";
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.sceneryTime = time;
    shader.uniforms.windRooted = { value: rooted ? 1 : 0 };
    shader.vertexShader = windVertex(shader.vertexShader);
  };
  depth.customProgramCacheKey = () => "scenery-foliage-depth-v1";
  mesh.customDepthMaterial = depth;
  return mesh;
};

export const createSceneryTree = (
  seed: number,
  species: "broadleaf" | "cypress" | "fir",
  time: SceneryTime,
): THREE.Group => {
  const group = new THREE.Group();
  group.name = `${species} tree`;
  const random = seededRandom(seed),
    transform = new THREE.Object3D();
  const bark = sceneryMaterial(species === "fir" ? 0x675446 : 0x795637, "bark");
  const height = species === "broadleaf" ? 3.1 : 4.7;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.24, height, 12, 5),
    bark,
  );
  trunk.position.y = height / 2;
  group.add(trunk);
  const branches = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.025, 0.065, 1, 7),
    bark,
    species === "broadleaf" ? 8 : 14,
  );
  const up = new THREE.Vector3(0, 1, 0),
    start = new THREE.Vector3(),
    end = new THREE.Vector3();
  for (let i = 0; i < branches.count; i++) {
    const angle = i * 2.39996 + random() * 0.3;
    start.set(0, 1.5 + (i / branches.count) * 1.8, 0);
    end.set(
      Math.cos(angle) * (species === "broadleaf" ? 1 : 0.8),
      start.y + 0.5,
      Math.sin(angle) * (species === "broadleaf" ? 1 : 0.8),
    );
    transform.position.copy(start).lerp(end, 0.5);
    transform.quaternion.setFromUnitVectors(
      up,
      end.clone().sub(start).normalize(),
    );
    transform.scale.set(1, start.distanceTo(end), 1);
    transform.updateMatrix();
    branches.setMatrixAt(i, transform.matrix);
  }
  group.add(branches);
  const leaves = foliage(
    leafSpray(species !== "broadleaf"),
    species === "broadleaf" ? 300 : 180,
    time,
  );
  leaves.name = "Layered foliage";
  const green = new THREE.Color(
    species === "fir" ? 0x416c4c : species === "cypress" ? 0x527744 : 0x698b42,
  );
  for (let i = 0; i < leaves.count; i++) {
    if (species === "broadleaf") {
      const azimuth = random() * Math.PI * 2,
        y = random() * 2 - 1;
      const radius = Math.cbrt(random()),
        span = Math.sqrt(1 - y * y) * radius;
      transform.position.set(
        Math.cos(azimuth) * span * 1.45,
        3.15 + y * radius * 1.2,
        Math.sin(azimuth) * span * 1.3,
      );
    } else {
      const tier = i % 9,
        angle = Math.floor(i / 9) * 2.39996 + random() * 0.4;
      const radius =
        (species === "fir" ? 1.55 * (1 - tier / 10) : 0.48) *
        (0.65 + random() * 0.35);
      transform.position.set(
        Math.cos(angle) * radius,
        1.4 + tier * 0.38 + random() * 0.25,
        Math.sin(angle) * radius,
      );
    }
    transform.rotation.set(
      (random() - 0.5) * 1.0,
      random() * Math.PI * 2,
      (random() - 0.5) * 0.9,
    );
    transform.scale.setScalar(
      species === "broadleaf"
        ? 0.85 + random() * 0.55
        : species === "fir"
          ? 1.3
          : 0.85,
    );
    transform.updateMatrix();
    leaves.setMatrixAt(i, transform.matrix);
    leaves.setColorAt(
      i,
      green
        .clone()
        .offsetHSL((random() - 0.5) * 0.025, 0, (random() - 0.5) * 0.08),
    );
  }
  leaves.computeBoundingSphere();
  branches.computeBoundingSphere();
  group.add(leaves);
  group.userData.foliage = leaves;
  group.userData.foliageCount = leaves.count;
  return shadows(group);
};

export const createSceneryHayBale = (seed: number): THREE.Group => {
  const group = new THREE.Group();
  group.name = "Wound hay roll";
  const points = [
    [0, -0.73],
    [0.7, -0.73],
    [0.8, -0.66],
    [0.82, -0.55],
    [0.83, 0],
    [0.82, 0.55],
    [0.8, 0.66],
    [0.7, 0.73],
    [0, 0.73],
  ];
  const bale = new THREE.Mesh(
    new THREE.LatheGeometry(
      points.map(([r, y]) => new THREE.Vector2(r, y)),
      48,
    ),
    sceneryMaterial(seed % 2 ? 0xc5a253 : 0xd6b668, "hay"),
  );
  bale.rotation.z = Math.PI / 2;
  bale.position.y = 0.83;
  group.add(bale);
  const ties = new THREE.InstancedMesh(
    new THREE.TorusGeometry(0.837, 0.009, 4, 48),
    new THREE.MeshStandardMaterial({ color: 0x9b8353, roughness: 1 }),
    2,
  );
  const transform = new THREE.Object3D();
  for (let i = 0; i < 2; i++) {
    transform.position.set(i ? 0.36 : -0.36, 0.83, 0);
    transform.rotation.y = Math.PI / 2;
    transform.updateMatrix();
    ties.setMatrixAt(i, transform.matrix);
  }
  ties.computeBoundingSphere();
  group.add(ties);
  return shadows(group);
};

export const createCropRows = (
  seed: number,
  lavender: boolean,
  time: SceneryTime,
): THREE.Group => {
  const group = new THREE.Group();
  group.name = lavender ? "Lavender rows" : "Vine rows";
  const stem = new THREE.CylinderGeometry(0.018, 0.025, 0.48, 5);
  stem.translate(0, 0.24, 0);
  const bloom = new THREE.IcosahedronGeometry(lavender ? 0.07 : 0.14, 0);
  bloom.scale(1, lavender ? 2.3 : 1, 1);
  bloom.translate(0, 0.48, 0);
  for (const [geometry, color] of [
    [stem, 0x5a7441],
    [bloom, lavender ? 0x9673b5 : 0x68854c],
  ] as const) {
    const tint = new THREE.Color(color);
    const attribute = new THREE.Float32BufferAttribute(
      new Float32Array(geometry.getAttribute("position").count * 3),
      3,
    );
    for (let i = 0; i < attribute.count; i++)
      attribute.setXYZ(i, tint.r, tint.g, tint.b);
    geometry.setAttribute("color", attribute);
  }
  const stemTriangles = stem.toNonIndexed();
  const geometry = mergeGeometries([stemTriangles, bloom])!;
  stemTriangles.dispose();
  stem.dispose();
  bloom.dispose();
  const plants = foliage(geometry, 80, time, true);
  (plants.material as THREE.MeshStandardMaterial).vertexColors = true;
  const random = seededRandom(seed),
    transform = new THREE.Object3D();
  for (let i = 0; i < plants.count; i++) {
    transform.position.set(
      Math.floor(i / 20) * 1.2 - 1.8 + (random() - 0.5) * 0.2,
      0,
      ((i % 20) / 19) * 6 - 3,
    );
    transform.rotation.y = random() * Math.PI * 2;
    transform.scale.setScalar(0.75 + random() * 0.4);
    transform.updateMatrix();
    plants.setMatrixAt(i, transform.matrix);
  }
  plants.computeBoundingSphere();
  group.add(plants);
  group.userData.cropPlants = plants;
  group.userData.cropMatrices = new Float32Array(plants.instanceMatrix.array);
  return shadows(group);
};

/** Project each crop root onto the grass, including tilted field groups. */
export const groundCropRows = (
  group: THREE.Object3D,
  height: (x: number, z: number) => number,
): void => {
  const plants = group.userData.cropPlants as THREE.InstancedMesh | undefined;
  if (!plants) return;
  const original = group.userData.cropMatrices as Float32Array;
  group.updateMatrix();
  const matrix = new THREE.Matrix4(),
    local = new THREE.Vector3(),
    point = new THREE.Vector3();
  const upY = new THREE.Vector3(0, 1, 0)
    .multiply(group.scale)
    .applyQuaternion(group.quaternion).y;
  for (let i = 0; i < plants.count; i++) {
    matrix.fromArray(original, i * 16);
    local.setFromMatrixPosition(matrix);
    for (let step = 0; step < 3; step++) {
      point.copy(local).applyMatrix4(group.matrix);
      local.y += (height(point.x, point.z) - point.y) / upY;
    }
    matrix.setPosition(local);
    plants.setMatrixAt(i, matrix);
  }
  plants.instanceMatrix.needsUpdate = true;
  // The bounds must include the terrain corrections used for frustum culling.
  plants.computeBoundingSphere();
};

export const createSceneryRock = (seed: number): THREE.Mesh => {
  const random = seededRandom(seed),
    geometry = new THREE.IcosahedronGeometry(0.35, 1),
    positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i),
      y = positions.getY(i),
      z = positions.getZ(i);
    const shape = 0.88 + Math.sin(x * 14 + seed) * Math.cos(z * 11) * 0.14;
    positions.setXYZ(i, x * shape, (y * shape + 0.4) * 0.65, z * shape * 0.75);
  }
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox!.min.y, 0);
  geometry.computeVertexNormals();
  const rock = new THREE.Mesh(geometry, sceneryMaterial(0x8d9081, "plaster"));
  rock.rotation.y = random() * Math.PI * 2;
  rock.castShadow = true;
  rock.receiveShadow = true;
  return rock;
};

export const createGuardrail = (): THREE.Mesh => {
  const section = new THREE.Shape();
  section.moveTo(-0.04, -0.14);
  section.lineTo(0.04, -0.09);
  section.lineTo(-0.02, 0);
  section.lineTo(0.04, 0.09);
  section.lineTo(-0.04, 0.14);
  section.lineTo(-0.06, 0.13);
  section.lineTo(0.02, 0.08);
  section.lineTo(-0.04, 0);
  section.lineTo(0.02, -0.08);
  section.lineTo(-0.06, -0.13);
  section.closePath();
  const geometry = new THREE.ExtrudeGeometry(section, {
    depth: 8.2,
    bevelEnabled: false,
    steps: 1,
  });
  geometry.translate(0, 0, -8.1);
  const rail = new THREE.Mesh(geometry, sceneryMaterial(0xc3c8c8, "metal"));
  rail.position.y = 0.65;
  return rail;
};

export const createSceneryFlag = (
  seed: number,
  time: SceneryTime,
): THREE.Group => {
  const group = new THREE.Group();
  group.name = "Fabric tricolour";
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.045, 2.7, 12),
    sceneryMaterial(0xd8d2c1, "metal"),
  );
  pole.position.y = 1.35;
  group.add(pole);
  const wind = (source: string): string =>
    source
      .replace(
        "#include <common>",
        `
    #include <common>
    uniform float sceneryTime, flagPhase;
  `,
      )
      .replace(
        "#include <begin_vertex>",
        `
    #include <begin_vertex>
    float freeEdge = (position.x + 0.48) / 0.96;
    transformed.z += sin(position.x * 9.0 - sceneryTime * 2.2 + flagPhase) * freeEdge * 0.09;
    transformed.y += sin(position.x * 7.0 - sceneryTime * 1.8 + flagPhase) * freeEdge * 0.025;
  `,
      );
  const uniforms = { sceneryTime: time, flagPhase: { value: seed * 0.7 } };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      flagBlue: { value: new THREE.Color(0x2c5e9e) },
      flagWhite: { value: new THREE.Color(0xf2eee1) },
      flagRed: { value: new THREE.Color(0xc4473d) },
    });
    shader.vertexShader = wind(shader.vertexShader)
      .replace("#include <common>", `#include <common>\nvarying vec2 vClothUV;`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\nvClothUV = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `
      #include <common>
      varying vec2 vClothUV;
      uniform vec3 flagBlue,flagWhite,flagRed;
    `,
      )
      .replace(
        "#include <color_fragment>",
        `
      #include <color_fragment>
      diffuseColor.rgb *= vClothUV.x < 0.333333 ? flagBlue : vClothUV.x < 0.666667 ? flagWhite : flagRed;
      float weave = sin(vClothUV.x * 320.0) * sin(vClothUV.y * 240.0);
      float resolved = 1.0-smoothstep(0.002,0.01,max(fwidth(vClothUV.x),fwidth(vClothUV.y)));
      diffuseColor.rgb *= 1.0 + weave * resolved * 0.035;
    `,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `
      #include <normal_fragment_maps>
      normal = normalize(cross(dFdx(-vViewPosition),dFdy(-vViewPosition))) * faceDirection;
    `,
      );
  };
  material.customProgramCacheKey = () => "scenery-flag-cloth-v1";
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.96, 0.78, 12, 4),
    material,
  );
  flag.position.set(0.5, 2.2, 0);
  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = wind(shader.vertexShader);
  };
  depth.customProgramCacheKey = () => "scenery-flag-depth-v1";
  flag.customDepthMaterial = depth;
  group.add(flag);
  return shadows(group);
};
