import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { EnvironmentMaterials, environmentRandom } from "./threeEnvironmentMaterials";

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

// Shared road-relative terrain lattice. This interpolation uses the same
// triangle diagonal as the ribbons, so planted scenery meets the actual mesh.
const terrainProfile = (x: number, z: number): number => {
  const inland = Math.max(0, Math.abs(x) - 7);
  return -0.08 + Math.min(1, inland / 12) * (1.5 + Math.sin(z * 0.04 + x * 0.09) * 1.4 + Math.cos(z * 0.08 - x * 0.05) * 0.7) + inland * 0.032;
};
export const terrainHeight = (x: number, z: number): number => {
  if (Math.abs(x) <= 5.35) return 0;
  if (Math.abs(x) < 6.1) return -0.035;
  const side = Math.sign(x);
  const column = (Math.abs(x) - 6.1) / 3;
  const row = (22 - z) / 2.6;
  const cx = Math.floor(column), rz = Math.floor(row), u = column - cx, v = row - rz;
  // Negative-side ribbons run from the inland edge toward the road.
  const a = side * (6.1 + cx * 3), b = side * (9.1 + cx * 3);
  const near = 22 - rz * 2.6, far = near - 2.6;
  const h00 = terrainProfile(a, near), h10 = terrainProfile(b, near);
  const h01 = terrainProfile(a, far), h11 = terrainProfile(b, far);
  if (side > 0) return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  return u <= v ? h00 + u * (h11 - h01) + v * (h01 - h00) : h00 + u * (h10 - h00) + v * (h11 - h10);
};

interface Ribbon {
  geometry: THREE.BufferGeometry;
  offsets: Float32Array;
}

export class ThreeLandscape {
  readonly root = new THREE.Group();
  private readonly ground = new THREE.Group();
  private pitch = 0;
  private riderZ = 1.1;
  private readonly ribbons: Ribbon[] = [];
  private readonly terrainMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly roadMaterial: THREE.MeshStandardMaterial;
  private readonly grass: THREE.InstancedMesh[] = [];
  private readonly grassOffsets: Float32Array[] = [];
  private lastDistance = NaN;
  private lastPitch = NaN;
  private lastRiderZ = NaN;
  private readonly skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x438ebb) },
      horizon: { value: new THREE.Color(0xf4e6c5) },
      time: { value: 0 },
    },
    vertexShader: `varying vec3 direction;
      void main() { direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform float time; varying vec3 direction;
      float hash(vec2 p) { vec3 q=fract(vec3(p.xyx)*0.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }
      float noise(vec2 p) { vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.0),f.x),f.y); }
      float fbm(vec2 p) { return noise(p)*0.55+noise(p*2.03)*0.28+noise(p*4.01)*0.17; }
      void main() {
        vec3 d = normalize(direction);
        float h = smoothstep(-0.06, 0.45, d.y);
        vec3 sky = mix(horizon, top, h);
        vec2 cloudUV = d.xz / max(0.08,d.y) * 4.0 + vec2(time*0.007,time*0.002);
        float density = fbm(cloudUV);
        float cloud = smoothstep(0.52,0.71,density) * smoothstep(0.035,0.16,d.y);
        float light = fbm(cloudUV+vec2(-0.14,0.09));
        vec3 cloudColor = mix(vec3(0.64,0.72,0.77),vec3(1.0,0.96,0.86),smoothstep(0.48,0.73,light));
        sky = mix(sky,cloudColor,cloud*0.92);
        float sun = pow(max(0.0,dot(d,normalize(vec3(-0.6,0.7,-0.4)))),64.0);
        sky += vec3(0.17,0.11,0.04)*sun;
        gl_FragColor = vec4(sky, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  private readonly mountains = new THREE.Group();

  constructor(private readonly resources = new EnvironmentMaterials()) {
    this.roadMaterial = resources.material("asphalt", 0x56585a);
    this.root.add(this.ground);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(290, 24, 16), this.skyMaterial);
    sky.frustumCulled = false;
    this.root.add(sky);
    this.addRibbon(-5.35, 5.35, 0, this.roadMaterial).name = "Road surface";
    const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xf3edda, roughness: 1 });
    const gravelMaterial = resources.material("gravel", 0xb7ad8a);
    for (const side of [-1, 1]) {
      this.addRibbon(side * 5.35, side * 6.1, -0.035, gravelMaterial);
      this.addRibbon(side * 5.02, side * 5.12, 0.014, edgeMaterial);
      const material = resources.material("grass", 0x8d9d64);
      this.terrainMaterials.push(material);
      this.addRibbon(side * 6.1, side * 96.1, -0.08, material, true).name = "Rolling terrain";
    }

    this.createGrass();

    // Broad, irregular ridges give the horizon a silhouette instead of a row
    // of identical cones. They stay distant while roadside objects move past.
    for (let layer = 0; layer < 3; layer += 1) {
      const geometry = new THREE.PlaneGeometry(660, 85, 180, 22);
      const positions = geometry.attributes.position;
      for (let i = 0; i < positions.count; i += 1) {
        const x = positions.getX(i);
        const row = (positions.getY(i) + 42.5) / 85;
        const ridge = 13 + 19 * Math.sin(x * 0.028 + layer * 2) ** 2 + 12 * Math.sin(x * 0.066 + 0.4) ** 2 + 4 * Math.sin(x * 0.17 + layer) ** 2;
        // Keep the foot of the ridge below the descending road as well.
        positions.setY(i, row === 0 ? -180 : -3 + row * ridge + Math.sin(x * 0.31 + row * 18) * Math.sin(row * Math.PI) * 2.5);
        positions.setZ(i, Math.sin(x * 0.045 + row * 4) * 7);
      }
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({ color: 0x527d84, flatShading: true, roughness: 1 });
      material.map = resources.texture("gravel");
      material.bumpMap = material.map; material.bumpScale = 0.35;
      geometry.attributes.uv.array.forEach((_, i, array) => { array[i] *= 18; });
      material.color.lerp(new THREE.Color(0xc7d5c8), layer * 0.22);
      const ridge = new THREE.Mesh(geometry, material);
      ridge.position.set((layer - 1) * 15, 0, -185 - layer * 27);
      this.mountains.add(ridge);
    }
    this.mountains.name = "Mountain backdrop";
    this.root.add(this.mountains);

    this.update(0);
  }

  private addRibbon(left: number, right: number, y: number, material: THREE.Material, terrain = false): THREE.Mesh {
    const segments = 100;
    const columns = terrain ? Math.round(Math.abs(right-left)/3) : 1;
    const uvs: number[] = [];
    const colors: number[] = [];
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row <= segments; row += 1) {
      const z = 22 - row * 2.6;
      for (let col = 0; col <= columns; col += 1) {
        const x = Math.min(left, right) + Math.abs(right - left) * col / columns;
        vertices.push(x, terrain ? terrainProfile(x, z) : y, z);
        uvs.push(x * (terrain ? 0.65 : 1.1), z * (terrain ? 0.65 : 1.1));
        const shade = terrain ? 0.8 + Math.sin(x * 0.34 + z * 0.12) * 0.09 + Math.cos(z * 0.24 - x * 0.12) * 0.08 : 1;
        colors.push(shade, shade, terrain ? shade * 0.92 : shade);
        if (row < segments && col < columns) {
          const a = row * (columns + 1) + col;
          const b = a + columns + 1;
          indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    (material as THREE.MeshStandardMaterial).vertexColors = true;
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.ground.add(mesh);
    this.ribbons.push({ geometry, offsets: new Float32Array(vertices) });
    return mesh;
  }

  update(distance: number, time = 0): void {
    this.skyMaterial.uniforms.time.value = time;
    this.resources.time.value = time;
    if (distance === this.lastDistance && this.pitch === this.lastPitch && this.riderZ === this.lastRiderZ) return;
    this.lastDistance = distance; this.lastPitch = this.pitch; this.lastRiderZ = this.riderZ;
    this.grass.forEach((grass,index) => {
      const offsets=this.grassOffsets[index], matrices=grass.instanceMatrix.array;
      for(let i=0;i<grass.count;i++) {
        const z=offsets[i*3+2];
        matrices[i*16+12]=offsets[i*3]+roadBend(z,distance);
        matrices[i*16+13]=offsets[i*3+1]+roadSurfaceHeight(z,this.pitch,this.riderZ);
      }
      grass.instanceMatrix.needsUpdate=true;
    });
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

  private createGrass(): void {
    const geometry = this.resources.geometry("grass-blade", () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([-0.02,0,0, 0.02,0,0, -0.012,0.16,0.025, 0.012,0.16,0.025, 0,0.32,0.07], 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute([0,0,1,0,0,0.5,1,0.5,0.5,1], 2));
      g.setIndex([0,1,2,1,3,2,2,3,4]); g.computeVertexNormals();
      const blades = [g, g.clone().rotateY(2.1).scale(0.85,0.8,0.85).translate(0.035,0,0), g.clone().rotateY(4.2).scale(0.8,0.7,0.8).translate(-0.035,0,0.02)];
      const clump = mergeGeometries(blades)!; blades.forEach(blade => blade.dispose()); return clump;
    });
    for (const side of [-1,1]) {
      const random = environmentRandom(side + 124);
      const grass = new THREE.InstancedMesh(geometry, this.resources.material("grass", 0x92a76a, true), 3000);
      const dummy = new THREE.Object3D(), offsets=new Float32Array(grass.count*3);
      grass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i=0;i<grass.count;i++) {
        // Bias coverage toward the road, with a deliberate gravel clearance.
        const x = side * (6.22 + Math.pow(random(), 2) * 14), z = 10 - random() * 90;
        offsets.set([x,terrainHeight(x,z),z],i*3);
        dummy.position.set(x,terrainHeight(x,z),z); dummy.rotation.y = random() * Math.PI;
        const size = 0.55 + random() * 0.95; dummy.scale.set(size, size * 0.68, size); dummy.updateMatrix();
        grass.setMatrixAt(i,dummy.matrix);
        grass.setColorAt(i,new THREE.Color().setHSL(0.19+random()*0.09,0.18+random()*0.2,0.6+random()*0.3));
      }
      // Limit blades to the nearby verge. Updating only their translations
      // keeps bend/crest sampling off the vertex shader and avoids rebuilding
      // rotations/scales. Far grass detail comes from the terrain texture.
      grass.frustumCulled = false; grass.name = "Wind-driven roadside blades";
      this.grass.push(grass); this.grassOffsets.push(offsets); this.ground.add(grass);
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
    this.roadMaterial.color.setHex(gravel ? 0xb49a7c : 0x56585a);
    this.roadMaterial.map = this.resources.texture(gravel ? "gravel" : "asphalt");
    this.roadMaterial.bumpMap = this.roadMaterial.map;
    this.grass.forEach(grass => (grass.material as THREE.MeshStandardMaterial).color.setHex(palette[2]).lerp(new THREE.Color(0xbcd087),0.35));
    this.terrainMaterials.forEach((material) => {
      material.color.setHex(palette[2]);
    });
    this.mountains.scale.y = [0.3, 0.7, 1.3, 0.55, 1.8][stage - 1] ?? 0.3;
    this.mountains.children.forEach((ridge, layer) => {
      const mesh = ridge as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      const positions = mesh.geometry.attributes.position;
      const colors: number[] = [];
      const rock = new THREE.Color(stage === 5 ? 0x7b9096 : 0x527d84).lerp(new THREE.Color(0xc7d5c8), layer * 0.22);
      for (let i = 0; i < positions.count; i += 1) {
        const snow = stage === 5 && positions.getY(i) > 26 + Math.sin(positions.getX(i) * 0.18) * 3;
        const y = positions.getY(i), x = positions.getX(i);
        const vegetation = y < 15 + Math.sin(x * 0.12) * 4;
        const color = snow ? new THREE.Color(0xecf4ee) : vegetation ? new THREE.Color(0x667b54).lerp(rock, layer * 0.28) : rock.clone().offsetHSL(0, 0, Math.sin(x * 0.3 + y * 0.8) * 0.065);
        color.lerp(new THREE.Color(0xc7d5cf), layer * 0.16);
        colors.push(color.r, color.g, color.b);
      }
      mesh.material.color.setHex(0xffffff);
      mesh.material.vertexColors = true;
      mesh.material.needsUpdate = true;
      mesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    });
  }
}
