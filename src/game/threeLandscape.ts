import * as THREE from "three";
import { ThreeGrass } from "./threeGrass";
import { createSkyMaterial } from "./threeSky";

// Keep the playable foreground straight. Everything farther ahead follows the
// same curve, so scenery, road markings and encounters stay on the road.
export const roadBend = (z: number, distance: number): number => {
  const depth = Math.max(0, -z - 12) / 160;
  return depth * depth * (30 * Math.sin(distance * 0.0025 + 0.7) + 12 * Math.sin(distance * 0.005));
};

export const roadHeading = (z: number, distance: number): number =>
  Math.atan2(roadBend(z + 0.5, distance) - roadBend(z - 0.5, distance), 1);

// Arcade hills: even 4% reads as a clear 20-degree climb or descent, while
// the steepest grades ease toward 38 degrees instead of becoming vertical.
// Keep gameplay coordinates on the flat local road; tilt its rendering only.
export const threeRoadPitch = (gradient: number): number =>
  THREE.MathUtils.degToRad(38) * Math.tanh(THREE.MathUtils.clamp(gradient, -0.12, 0.12) / 0.07);

export const applyRoadPitch = (road: THREE.Object3D, pitch: number, riderZ: number): void => {
  road.rotation.x = pitch;
  road.position.set(0, riderZ * Math.sin(pitch), riderZ * (1 - Math.cos(pitch)));
};

// Ease the distant road onto a plateau. The changing silhouette supplies a
// visible crest or valley instead of an endlessly tilted flat sheet.
export const roadSurfaceHeight = (z: number, pitch: number, riderZ = 1.1): number => {
  const depth = Math.max(0, riderZ - z - 18);
  return (52 * (1 - Math.exp(-depth / 52)) - depth) * Math.tan(pitch);
};

export const roadSurfacePitch = (z: number, pitch: number, riderZ = 1.1): number => {
  const depth = Math.max(0, riderZ - z - 18);
  return -Math.atan((1 - Math.exp(-depth / 52)) * Math.tan(pitch));
};

interface Ribbon {
  geometry: THREE.BufferGeometry;
  offsets: Float32Array;
  terrain: boolean;
}

export class ThreeLandscape {
  readonly root = new THREE.Group();
  private readonly ground = new THREE.Group();
  private readonly grass = new ThreeGrass();
  private readonly grassTravel = { value: 0 };
  private pitch = 0;
  private riderZ = 1.1;
  private readonly ribbons: Ribbon[] = [];
  private readonly terrainMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly roadMaterial = new THREE.MeshStandardMaterial({ color: 0x343e43, roughness: 1 });
  private readonly skyMaterial = createSkyMaterial();
  private readonly gravelRoad = { value: 0 };
  private readonly mountainMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, fog: false });
  private readonly mountains = new THREE.Group();

  constructor() {
    this.root.add(this.ground);
    this.textureSurface(this.roadMaterial, this.gravelRoad);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(290, 24, 16), this.skyMaterial);
    sky.frustumCulled = false;
    this.root.add(sky);
    this.addRibbon(-5.35, 5.35, 0, this.roadMaterial).name = "Road surface";
    const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xf3edda, roughness: 1 });
    const gravelMaterial = new THREE.MeshStandardMaterial({ color: 0xb7ad8a, roughness: 1 });
    this.textureSurface(gravelMaterial, { value: 1 });
    for (const side of [-1, 1]) {
      this.addRibbon(side * 5.35, side * 6.1, -0.035, gravelMaterial);
      this.addRibbon(side * 5.02, side * 5.12, 0.014, edgeMaterial);
      for (let band = 0; band < 5; band += 1) {
        const material = this.createGrassMaterial();
        this.terrainMaterials.push(material);
        this.addRibbon(side * (6.1 + band * 18), side * (24.1 + band * 18), -0.08, material, true);
      }
    }

    this.ground.add(this.grass.mesh);

    // Separate ridge profiles and folded faces break up the repeated skyline.
    for (let layer = 0; layer < 4; layer += 1) {
      const geometry = new THREE.PlaneGeometry(680, 120, 90, 12);
      const positions = geometry.attributes.position;
      for (let i = 0; i < positions.count; i += 1) {
        const x = positions.getX(i);
        const row = (positions.getY(i) + 60) / 120;
        const peaks = 32 * Math.exp(-(((x + 95 + layer * 27) / 48) ** 2))
          + 42 * Math.exp(-(((x - 78 + layer * 16) / 39) ** 2))
          + 26 * Math.exp(-(((x - 215) / 57) ** 2));
        const ridge = 16 + peaks + 9 * Math.sin(x * 0.043 + layer * 1.9)
          + 5 * Math.sin(x * 0.113 + layer * 0.7) + 2.5 * Math.cos(x * 0.247 + layer);
        positions.setY(i, row === 0 ? -240 : -9 + Math.pow(row, 0.9) * ridge);
        positions.setZ(i, Math.sin(x * 0.038 + row * 7 + layer) * (4 + row * 9)
          + Math.cos(x * 0.1 - row * 11) * row * 3);
      }
      geometry.computeVertexNormals();
      const material = this.mountainMaterial.clone();
      this.textureMountains(material, layer);
      const ridge = new THREE.Mesh(geometry, material);
      ridge.position.set((layer - 1) * 18, 0, -190 - layer * 22);
      this.mountains.add(ridge);
    }
    this.mountains.name = "Mountain backdrop";
    this.root.add(this.mountains);
    this.update(0);
  }

  private textureMountains(material: THREE.MeshBasicMaterial, layer: number): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.rockDetail = { value: 0.22 * (1 - layer * 0.18) };
      shader.vertexShader = shader.vertexShader.replace("#include <common>", `
        #include <common>
        varying vec2 vRockCoord;
      `).replace("#include <begin_vertex>", `
        #include <begin_vertex>
        vRockCoord = position.xy;
      `);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `
        #include <common>
        varying vec2 vRockCoord;
        uniform float rockDetail;
        float rockHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float rockNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(rockHash(i), rockHash(i + vec2(1, 0)), f.x),
            mix(rockHash(i + vec2(0, 1)), rockHash(i + vec2(1, 1)), f.x), f.y);
        }
      `).replace("#include <color_fragment>", `
        #include <color_fragment>
        vec2 rock = vRockCoord;
        float grain = rockNoise(rock * 0.65);
        float gullies = smoothstep(0.58, 0.82, rockNoise(rock * vec2(0.28, 0.07)
          + vec2(sin(rock.y * 0.12) * 0.6, 0.0)));
        diffuseColor.rgb *= 1.0 + rockDetail * ((grain - 0.5) * 0.7 - gullies * 0.5);
      `);
    };
    material.customProgramCacheKey = () => "mountain-rock-detail-v1";
  }

  private textureSurface(material: THREE.MeshStandardMaterial, gravel: { value: number }): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.surfaceTravel = this.grassTravel;
      shader.uniforms.surfaceGravel = gravel;
      shader.vertexShader = shader.vertexShader.replace("#include <common>", `
        #include <common>
        attribute vec2 surfaceCoord;
        varying vec2 vSurfaceCoord;
      `).replace("#include <begin_vertex>", `
        #include <begin_vertex>
        vSurfaceCoord = surfaceCoord;
      `);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `
        #include <common>
        uniform float surfaceTravel, surfaceGravel;
        varying vec2 vSurfaceCoord;
        float stoneHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float surfaceNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(stoneHash(i), stoneHash(i + vec2(1, 0)), f.x),
            mix(stoneHash(i + vec2(0, 1)), stoneHash(i + vec2(1, 1)), f.x), f.y);
        }
      `).replace("#include <color_fragment>", `
        #include <color_fragment>
        vec2 surface = vSurfaceCoord - vec2(0.0, surfaceTravel);
        float grainScale = mix(38.0, 13.0, surfaceGravel);
        float grain = stoneHash(floor(surface * grainScale));
        float resolved = 1.0 - smoothstep(0.035, 0.16, max(fwidth(surface.x), fwidth(surface.y)));
        float mottling = surfaceNoise(surface * 0.9) - 0.5;
        vec2 pebbleCell = fract(surface * grainScale) - 0.5;
        float pebble = 1.0 - smoothstep(0.22, 0.48, length(pebbleCell * vec2(1.0, 1.4)));
        diffuseColor.rgb *= 0.96 + mottling * 0.12 + resolved
          * ((grain - 0.5) * mix(0.26, 0.48, surfaceGravel) + pebble * surfaceGravel * 0.14);
        float aggregateRelief = resolved * (surfaceNoise(surface * grainScale) * 0.006
          + pebble * surfaceGravel * 0.009);
      `).replace("#include <normal_fragment_maps>", `
        #include <normal_fragment_maps>
        vec3 roadDx = dFdx(-vViewPosition), roadDy = dFdy(-vViewPosition);
        vec3 roadRx = cross(roadDy, normal), roadRy = cross(normal, roadDx);
        float roadDet = dot(roadDx, roadRx);
        normal = normalize(abs(roadDet) * normal - sign(roadDet)
          * (dFdx(aggregateRelief) * roadRx + dFdy(aggregateRelief) * roadRy));
      `);
    };
    material.customProgramCacheKey = () => "road-surface-grain-v2";
  }

  private createGrassMaterial(): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color: 0x849746, roughness: 1 });
    // Unbent ribbon coordinates keep the texture continuous across field bands
    // and attached to the moving scenery, including on climbs and descents.
    material.onBeforeCompile = (shader) => {
      shader.uniforms.grassTravel = this.grassTravel;
      shader.vertexShader = shader.vertexShader.replace("#include <common>", `
        #include <common>
        attribute vec2 grassCoord;
        varying vec2 vGrassCoord;
      `).replace("#include <begin_vertex>", `
        #include <begin_vertex>
        vGrassCoord = grassCoord;
      `);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `
        #include <common>
        uniform float grassTravel;
        varying vec2 vGrassCoord;
        float grassHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float grassNoise(vec2 p) {
          vec2 cell = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(grassHash(cell), grassHash(cell + vec2(1, 0)), f.x),
                     mix(grassHash(cell + vec2(0, 1)), grassHash(cell + vec2(1, 1)), f.x), f.y);
        }
      `).replace("#include <color_fragment>", `
        #include <color_fragment>
        vec2 p = vGrassCoord - vec2(0.0, grassTravel);
        float patches = grassNoise(p * 0.19 + grassNoise(p * 0.05) * 3.0);
        float tufts = grassNoise(p * 2.4);
        float footprint = max(fwidth(p.x), fwidth(p.y));
        float detail = 1.0 - smoothstep(0.025, 0.13, footprint);
        vec2 grain = vec2(p.x + p.y * 0.37, p.y - p.x * 0.37);
        float fibers = grassNoise(grain * vec2(24.0, 5.0));
        float crossFibers = grassNoise(vec2(p.x - p.y * 0.61, p.y + p.x * 0.61) * vec2(19.0, 6.0));
        float thatch = mix(fibers, crossFibers, 0.4);
        float dry = smoothstep(0.58, 0.82, patches);
        diffuseColor.rgb *= 0.68 + patches * 0.4 + tufts * 0.18;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.16, 1.02, 0.74), dry * 0.65);
        diffuseColor.rgb *= 1.0 + detail * (thatch - 0.5) * 0.38;
        float grassRelief = detail * (thatch * 0.018 + tufts * 0.008);
      `).replace("#include <normal_fragment_maps>", `
        #include <normal_fragment_maps>
        // Derivative bump shading gives the fine fibers depth in the sun,
        // while fading subpixel detail keeps the distant fields calm.
        vec3 grassDx = dFdx(-vViewPosition), grassDy = dFdy(-vViewPosition);
        vec3 grassRx = cross(grassDy, normal), grassRy = cross(normal, grassDx);
        float grassDet = dot(grassDx, grassRx);
        normal = normalize(abs(grassDet) * normal - sign(grassDet)
          * (dFdx(grassRelief) * grassRx + dFdy(grassRelief) * grassRy));
      `);
    };
    material.customProgramCacheKey = () => "roadside-grass-v2";
    return material;
  }

  // Sample the actual ribbon triangles, rather than the analytic hill formula:
  // coarse terrain vertices interpolate differently between rows and columns.
  surfaceHeight(x: number, z: number, distance: number): number {
    const rowPosition = THREE.MathUtils.clamp((22 - z) / 2.6, 0, 100);
    const row = Math.min(99, Math.floor(rowPosition));
    const v = rowPosition - row;
    const bend = THREE.MathUtils.lerp(roadBend(22 - row * 2.6, distance),
      roadBend(22 - (row + 1) * 2.6, distance), v);
    const baseX = x - bend;
    const ribbon = this.ribbons.find(({ offsets, terrain }) => terrain
      && baseX >= offsets[0] && baseX <= offsets[12]);
    if (!ribbon) return roadSurfaceHeight(z, this.pitch, this.riderZ);
    const { offsets } = ribbon;
    const colPosition = THREE.MathUtils.clamp((baseX - offsets[0]) / (offsets[12] - offsets[0]) * 4, 0, 4);
    const col = Math.min(3, Math.floor(colPosition));
    const u = colPosition - col;
    const height = (r: number, c: number): number => {
      const i = (r * 5 + c) * 3;
      return offsets[i + 1] + roadSurfaceHeight(offsets[i + 2], this.pitch, this.riderZ);
    };
    return u + v <= 1
      ? height(row, col) * (1 - u - v) + height(row, col + 1) * u + height(row + 1, col) * v
      : height(row, col + 1) * (1 - v) + height(row + 1, col) * (1 - u) + height(row + 1, col + 1) * (u + v - 1);
  }

  supportHeight(object: THREE.Object3D, distance: number): number {
    let height = this.surfaceHeight(object.position.x, object.position.z, distance);
    const footprint = object.userData.groundFootprint as [number, number] | undefined;
    if (!footprint) return height;
    // Upright buildings counter-rotate the road pitch. Account for the resulting
    // local height of each footprint sample so uphill walls stay above grass.
    const offset = new THREE.Vector3();
    for (const x of [-footprint[0], 0, footprint[0]]) {
      for (const z of [-footprint[1], 0, footprint[1]]) {
        offset.set(x, 0, z).multiply(object.scale).applyEuler(object.rotation);
        height = Math.max(height, this.surfaceHeight(object.position.x + offset.x,
          object.position.z + offset.z, distance) - offset.y);
      }
    }
    // Keep walls clear of small triangle peaks between footprint samples.
    return height + 0.05;
  }

  private addRibbon(left: number, right: number, y: number, material: THREE.Material, terrain = false): THREE.Mesh {
    const segments = 100;
    const columns = terrain ? 4 : 1;
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row <= segments; row += 1) {
      const z = 22 - row * 2.6;
      for (let col = 0; col <= columns; col += 1) {
        const x = Math.min(left, right) + Math.abs(right - left) * col / columns;
        const inland = Math.max(0, Math.abs(x) - 7);
        const height = terrain
          ? Math.min(1, inland / 12) * (1.5 + Math.sin(z * 0.04 + x * 0.09) * 1.4 + Math.cos(z * 0.08 - x * 0.05) * 0.7) + inland * 0.032
          : 0;
        vertices.push(x, y + height, z);
        if (row < segments && col < columns) {
          const a = row * (columns + 1) + col;
          const b = a + columns + 1;
          indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    const coordinates = vertices.flatMap((_, i) => i % 3 === 0 ? [vertices[i], vertices[i + 2]] : []);
    geometry.setAttribute("surfaceCoord", new THREE.Float32BufferAttribute(coordinates, 2));
    if (terrain) {
      geometry.setAttribute("grassCoord", new THREE.Float32BufferAttribute(coordinates, 2));
    }
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.ground.add(mesh);
    this.ribbons.push({ geometry, offsets: new Float32Array(vertices), terrain });
    return mesh;
  }

  update(distance: number, seconds = 0): void {
    this.grassTravel.value = distance;
    this.skyMaterial.uniforms.time.value = seconds;
    this.grass.update(distance, seconds, (z) => roadBend(z, distance),
      (x, z) => this.surfaceHeight(x, z, distance));
    for (const { geometry, offsets } of this.ribbons) {
      const positions = geometry.attributes.position;
      for (let i = 0; i < positions.count; i += 1) {
        positions.setX(i, offsets[i * 3] + roadBend(offsets[i * 3 + 2], distance));
        positions.setY(i, offsets[i * 3 + 1] + roadSurfaceHeight(offsets[i * 3 + 2], this.pitch, this.riderZ));
      }
      positions.needsUpdate = true;
      geometry.computeVertexNormals();
    }
  }

  setRoadPitch(pitch: number, riderZ: number): void {
    this.pitch = pitch;
    this.riderZ = riderZ;
    applyRoadPitch(this.ground, pitch, riderZ);
    this.mountains.position.y = 70 * Math.sin(pitch);
  }

  setStage(stage: number, gravel: boolean): void {
    const palettes = [
      [0x438ebb, 0xf4e6c5, 0x849746],
      [0x548fac, 0xe4debd, 0x688649],
      [0x388fb5, 0xe7e9d3, 0x78974e],
      [0x649cbd, 0xf4dfcb, 0xb0a562],
      [0x377ea8, 0xd5e5e7, 0x768b78],
    ];
    const palette = palettes[stage - 1] ?? palettes[0];
    this.skyMaterial.uniforms.top.value.setHex(palette[0]);
    this.skyMaterial.uniforms.horizon.value.setHex(palette[1]);
    this.skyMaterial.uniforms.cloudCoverage.value = [0.56, 0.47, 0.51, 0.61, 0.49][stage - 1] ?? 0.56;
    this.gravelRoad.value = gravel ? 1 : 0;
    this.grass.setColor(palette[2]);
    this.roadMaterial.color.setHex(gravel ? 0x948168 : 0x343e43);
    this.terrainMaterials.forEach((material) => {
      material.color.setHex(palette[2]);
    });
    this.mountains.scale.y = [0.3, 0.7, 1.3, 0.55, 1.8][stage - 1] ?? 0.3;
    this.mountains.children.forEach((ridge, layer) => {
      const mesh = ridge as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      const positions = mesh.geometry.attributes.position;
      const colors: number[] = [];
      const rock = new THREE.Color(stage === 5 ? 0x77818b : 0x798476);
      const forest = new THREE.Color(stage === 4 ? 0x7e8659 : 0x4e7356);
      const haze = new THREE.Color(palette[1]).lerp(new THREE.Color(palette[0]), 0.25);
      const normals = mesh.geometry.getAttribute("normal");
      const sun = new THREE.Vector3(-0.55, 0.7, 0.45).normalize();
      for (let i = 0; i < positions.count; i += 1) {
        const x = positions.getX(i), y = positions.getY(i);
        const variation = Math.sin(x * 0.17 + y * 0.3) * Math.cos(y * 0.35 - x * 0.06);
        const alpine = THREE.MathUtils.smoothstep(y + variation * 5,
          stage === 3 || stage === 5 ? 13 : 35, stage === 3 || stage === 5 ? 32 : 60);
        const color = forest.clone().lerp(rock, alpine).multiplyScalar(0.9 + variation * 0.12);
        const snow = stage === 5 ? THREE.MathUtils.smoothstep(y + variation * 7, 30, 43) : 0;
        color.lerp(new THREE.Color(0xecf4ee), snow);
        // Soft baked face lighting prevents dark cliffs in the distant haze.
        const face = new THREE.Vector3().fromBufferAttribute(normals, i);
        color.multiplyScalar(1.45 + Math.max(0, face.dot(sun)) * 0.4);
        color.lerp(haze, 0.32 + layer * 0.15);
        colors.push(color.r, color.g, color.b);
      }
      mesh.material.color.setHex(0xffffff);
      mesh.material.vertexColors = true;
      mesh.material.needsUpdate = true;
      mesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    });
  }
}
