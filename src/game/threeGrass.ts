import * as THREE from "three";

const TUFT_COUNT = 4_200;
const NEAR_Z = 18;
const FAR_Z = -75;

/** Short, irregular roadside tufts, pooled into a single instanced draw. */
export class ThreeGrass {
  readonly mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly tufts: { x: number; z: number; yaw: number; width: number; height: number; shade: number; dry: boolean }[] = [];
  private readonly transform = new THREE.Object3D();
  private readonly windTime = { value: 0 };
  private readonly tint = new THREE.Color();

  constructor() {
    const vertices: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (let blade = 0; blade < 5; blade += 1) {
      const angle = blade * 2.39996;
      const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const across = new THREE.Vector3(-direction.z, 0, direction.x);
      const height = 0.65 + blade % 3 * 0.17;
      const base = direction.clone().multiplyScalar(blade * 0.06);
      const offset = vertices.length / 3;
      // A narrow root, a curved middle, and a pointed tip catch light differently.
      for (const [y, width, lean] of [[0, 0.045, 0], [height * 0.55, 0.032, 0.12], [height, 0, 0.34]]) {
        for (const side of [-1, 1]) {
          const point = base.clone().addScaledVector(direction, lean).addScaledVector(across, side * width);
          vertices.push(point.x, y, point.z);
          const shade = y === 0 ? 0.72 : y < height ? 0.98 : 1.18;
          colors.push(shade, shade, shade * 0.9);
        }
      }
      indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2,
        offset + 2, offset + 3, offset + 4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: 0x849746, vertexColors: true, roughness: 0.92, side: THREE.DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.grassWindTime = this.windTime;
      shader.vertexShader = shader.vertexShader.replace("#include <common>", `
        #include <common>
        uniform float grassWindTime;
      `).replace("#include <begin_vertex>", `
        #include <begin_vertex>
        float phase = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.18;
        float gust = sin(grassWindTime * 1.4 + phase) * 0.12
          + sin(grassWindTime * 2.3 + phase * 1.7) * 0.04;
        transformed.x += position.y * position.y * gust;
      `);
      // Upward-biased foliage normals soften the black backfaces of thin leaves.
      shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_begin>", `
        #include <normal_fragment_begin>
        vec3 grassUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        normal = normalize(mix(normal, grassUp, 0.7));
      `);
    };
    material.customProgramCacheKey = () => "roadside-grass-tufts-v1";
    this.mesh = new THREE.InstancedMesh(geometry, material, TUFT_COUNT);
    this.mesh.name = "Roadside grass blades";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Matrices wrap and follow the curved terrain every frame.
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    let seed = 731;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let i = 0; i < TUFT_COUNT; i += 1) {
      this.tufts.push({
        x: (i % 2 ? 1 : -1) * (6.3 + random() ** 1.7 * 11.5),
        z: FAR_Z + random() * (NEAR_Z - FAR_Z), yaw: random() * Math.PI * 2,
        width: 0.3 + random() * 0.3, height: 0.08 + random() ** 2 * 0.2,
        shade: 0.72 + random() * 0.5, dry: random() < 0.16,
      });
    }
    this.setColor(0x849746);
  }

  setColor(color: number): void {
    this.mesh.material.color.setHex(color);
    this.tufts.forEach((tuft, index) => {
      this.tint.setRGB(tuft.shade, tuft.shade, tuft.shade);
      if (tuft.dry) this.tint.setRGB(tuft.shade * 1.25, tuft.shade * 1.04, tuft.shade * 0.62);
      this.mesh.setColorAt(index, this.tint);
    });
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(distance: number, seconds: number, bend: (z: number) => number, height: (x: number, z: number) => number): void {
    this.windTime.value = seconds;
    this.tufts.forEach((tuft, index) => {
      const z = FAR_Z + THREE.MathUtils.euclideanModulo(tuft.z - FAR_Z + distance, NEAR_Z - FAR_Z);
      const x = tuft.x + bend(z);
      // Shrink distant blades into the ground texture without an abrupt edge.
      const fade = THREE.MathUtils.smoothstep(z, FAR_Z, FAR_Z + 22);
      this.transform.position.set(x, height(x, z) - 0.015, z);
      this.transform.rotation.set(0, tuft.yaw, 0);
      this.transform.scale.set(tuft.width, tuft.height * fade, tuft.width);
      this.transform.updateMatrix();
      this.mesh.setMatrixAt(index, this.transform.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
