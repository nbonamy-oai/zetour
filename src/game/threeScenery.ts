import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { EnvironmentMaterials, environmentRandom } from "./threeEnvironmentMaterials";
import { roadBend, roadHeading, roadSurfaceHeight, terrainHeight } from "./threeLandscape";

const Y = new THREE.Vector3(0, 1, 0);
const part = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
};
const branch = (a: THREE.Vector3, b: THREE.Vector3, radius: number): THREE.BufferGeometry => {
  const geometry = new THREE.CylinderGeometry(radius * 0.55, radius, a.distanceTo(b), 7);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, b.clone().sub(a).normalize()));
  geometry.translate(...a.clone().add(b).multiplyScalar(0.5).toArray());
  return geometry;
};

// Small, open clusters of individual leaves/needles, rather than solid crowns.
const leafCluster = (needle: boolean): THREE.BufferGeometry => {
  const random = environmentRandom(needle ? 96 : 81);
  const leaves: THREE.BufferGeometry[] = [];
  if (needle) {
    // Three crossed sprigs retain volume from every camera. Fine needles are
    // cut out of the shared texture, rather than modeled as oversized spikes.
    for(let i=0;i<3;i++) {
      const card=new THREE.PlaneGeometry(0.95,0.75);
      card.rotateY(i*Math.PI/3);leaves.push(card);
    }
  } else for (let i=0;i<24;i++) {
    const leaf=new THREE.PlaneGeometry(0.08,0.12);
    leaf.rotateX(random()*Math.PI);leaf.rotateY(random()*Math.PI);leaf.rotateZ(random()*Math.PI);
    leaf.translate((random()-0.5)*0.55,(random()-0.5)*0.55,(random()-0.5)*0.55);
    leaves.push(leaf);
  }
  const geometry=mergeGeometries(leaves)!;leaves.forEach(leaf=>leaf.dispose());return geometry;
};

export const createEnvironmentTree = (resources: EnvironmentMaterials, seed: number, species: "oak" | "birch" | "fir" | "cypress" | "olive"): THREE.Group => {
  const root = new THREE.Group(); root.name = `${species} tree`; root.userData.footprint={radius:3.2,depth:3.2};
  const random = environmentRandom(seed * 93 + 62);
  const conifer = species === "fir" || species === "cypress";
  const trunkHeight = species === "birch" ? 4.2 : conifer ? 4.5 : 2.8;
  const limbs = [branch(new THREE.Vector3(0, -0.18, 0), new THREE.Vector3(0.05, trunkHeight, 0), species === "birch" ? 0.15 : 0.24)];
  const centers: THREE.Vector3[] = [];
  for (let i = 0; i < (conifer ? 18 : 11); i++) {
    const angle = i * 2.4 + seed;
    const height = conifer ? 1.1 + i * 0.2 : 1.5 + random() * 1.8;
    const reach = species === "cypress" ? 0.35 : species === "fir" ? 1.7 * (1 - i / 23) : 0.8 + random() * 0.8;
    const tip = new THREE.Vector3(Math.cos(angle) * reach, height + (conifer ? 0.15 : 0.6), Math.sin(angle) * reach);
    limbs.push(branch(new THREE.Vector3(0, height, 0), tip, conifer ? 0.06 : 0.09));
    centers.push(tip);
  }
  for (let i = 0; i < 5; i++) {
    const angle = i * 1.256;
    limbs.push(branch(new THREE.Vector3(Math.cos(angle) * 0.5, -0.1, Math.sin(angle) * 0.5), new THREE.Vector3(0, 0.3, 0), 0.1));
  }
  const wood = mergeGeometries(limbs)!; limbs.forEach(limb => limb.dispose());
  root.add(part(wood, resources.material("bark", species === "birch" ? 0xc9c6ac : species === "olive" ? 0x80735c : 0x78604a)));
  const foliage = new THREE.InstancedMesh(
    resources.geometry(conifer ? "needles" : "leaves", () => leafCluster(conifer)),
    resources.material(conifer ? "needles" : "foliage", species === "olive" ? 0x7f9565 : conifer ? 0x547b56 : 0x638740, true),
    centers.length * 3 + 6,
  );
  const dummy = new THREE.Object3D();
  for (let i = 0; i < foliage.count; i++) {
    const center = centers[i % centers.length];
    dummy.position.copy(center).add(new THREE.Vector3((random() - 0.5) * 0.9, (random() - 0.5) * 0.8, (random() - 0.5) * 0.9));
    if (i < 6) dummy.position.set((random() - 0.5) * 0.6, trunkHeight - 0.5 + random() * 0.8, (random() - 0.5) * 0.6);
    if(conifer) {
      const direction=center.clone();direction.y=0.45;
      dummy.quaternion.setFromUnitVectors(Y,direction.normalize());
    } else dummy.rotation.set(random()*2,random()*6,random()*2);
    dummy.scale.setScalar(conifer && i < 6 ? 0.7+random()*0.3 : (conifer ? 1.4 : 1.8) + random() * 0.7);
    dummy.updateMatrix(); foliage.setMatrixAt(i, dummy.matrix);
    foliage.setColorAt(i, new THREE.Color().setHSL(0.23 + random() * 0.07, 0.23, 0.65 + random() * 0.25));
  }
  // Keep a full-density bound when draw counts fall at distance, including
  // a little margin for wind. Returning to a near camera cannot clip leaves.
  foliage.computeBoundingSphere();
  foliage.boundingSphere!.radius += 0.25;
  foliage.castShadow = foliage.receiveShadow = true;
  foliage.customDepthMaterial = resources.windDepth(conifer ? "needles" : "foliage"); root.add(foliage);
  root.userData.foliage = foliage; root.userData.foliageCount = foliage.count;
  return root;
};

export const createEnvironmentHay = (resources: EnvironmentMaterials, seed: number): THREE.Group => {
  const root = new THREE.Group(); root.name = "Round straw roll"; root.userData.footprint={radius:1.2,depth:1.2};
  const bale = part(resources.geometry("hay-roll", () => {
    const geometry = new THREE.CylinderGeometry(0.85, 0.85, 1.5, 32, 5, true);
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const bulge = 0.97 + 0.035 * Math.cos(p.getY(i) * 2) + 0.012 * Math.sin(i * 2.4);
      p.setX(i, p.getX(i) * bulge); p.setZ(i, p.getZ(i) * bulge);
    }
    geometry.computeVertexNormals(); geometry.rotateZ(Math.PI / 2); return geometry;
  }), resources.material("straw", 0xd6b970), 0, 0.85);
  root.add(bale);
  for (const side of [-1, 1]) {
    const end = part(resources.geometry("hay-end", () => new THREE.CircleGeometry(0.845, 32)), resources.material("wound", 0xc6a25d), side * 0.752, 0.85);
    end.rotation.y = side * Math.PI / 2; root.add(end);
  }
  for (const x of [-0.47, 0.47]) {
    const twine = part(resources.geometry("hay-twine", () => new THREE.TorusGeometry(0.854, 0.012, 4, 32)), resources.material("wood", 0x8b794f), x, 0.85);
    twine.rotation.y = Math.PI / 2; root.add(twine);
  }
  root.userData.baseYaw = seed * 0.9;
  root.userData.surfaceAligned = true;
  return root;
};

export const createPlantedField = (resources: EnvironmentMaterials, flowers: boolean, seed: number): THREE.Group => {
  const root = new THREE.Group(); root.name = flowers ? "Lavender rows" : "Crop rows"; root.userData.footprint={radius:4.8,depth:4.8};
  const geometry = resources.geometry(flowers ? "lavender" : "crop", () => {
    const stem = new THREE.CylinderGeometry(0.025, 0.045, flowers ? 0.45 : 0.75, 4); stem.translate(0, flowers ? 0.225 : 0.375, 0);
    const bloom = new THREE.SphereGeometry(flowers ? 0.12 : 0.15, 5, 3); bloom.scale(1, flowers ? 1.8 : 0.6, 1); bloom.translate(0, flowers ? 0.43 : 0.65, 0);
    const result = mergeGeometries([stem, bloom], true)!; stem.dispose(); bloom.dispose(); return result;
  });
  const plants = new THREE.InstancedMesh(geometry, [resources.material("leaf", 0x749449, true), resources.material("leaf", flowers ? 0x9f82b2 : 0x91a553, true)], 4 * 24);
  const random = environmentRandom(seed + 12);
  root.userData.plants = plants;
  root.userData.plantOffsets = Array.from({length: plants.count}, (_, i) => new THREE.Vector3(-2.25 + Math.floor(i / 24) * 1.5 + (random() - 0.5) * 0.1, 0, -4 + (i % 24) * 0.35));
  plants.receiveShadow = true; plants.frustumCulled = false; root.add(plants);
  const soilOffsets: THREE.Vector3[] = [], soilIndices: number[] = [];
  for (let row=0;row<4;row++) for(let step=0;step<=8;step++) for(const edge of [-1,1]) {
    soilOffsets.push(new THREE.Vector3(-2.25+row*1.5+edge*0.42,0,-4+step));
    if(edge===-1 && step<8) {const a=row*18+step*2;soilIndices.push(a,a+2,a+1,a+1,a+2,a+3);}
  }
  const soilGeometry=new THREE.BufferGeometry();
  soilGeometry.setAttribute("position",new THREE.Float32BufferAttribute(soilOffsets.flatMap(v=>v.toArray()),3));
  soilGeometry.setAttribute("uv",new THREE.Float32BufferAttribute(soilOffsets.flatMap(v=>[v.x,v.z]),2));
  soilGeometry.setIndex(soilIndices);soilGeometry.computeVertexNormals();
  const soil=part(soilGeometry,resources.material("gravel",0x897557));soil.castShadow=false;soil.frustumCulled=false;
  root.userData.soil=soil;root.userData.soilOffsets=soilOffsets;root.add(soil);
  return root;
};

export const createEnvironmentRock = (resources: EnvironmentMaterials, seed: number): THREE.Group => {
  const root = new THREE.Group(); root.name = "Weathered roadside rock"; root.userData.footprint={radius:1.2,depth:1.2};
  const geometry = new THREE.IcosahedronGeometry(0.65, 1);
  const random = environmentRandom(seed + 96), p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // Coordinate noise keeps duplicate vertices together.
    const roughness = 1 + 0.13 * Math.sin(p.getX(i) * 22 + p.getY(i) * 13 + p.getZ(i) * 7);
    p.setXYZ(i, p.getX(i) * roughness, p.getY(i) * roughness, p.getZ(i) * roughness);
  }
  geometry.computeVertexNormals();
  const rock = part(geometry, resources.material("gravel", seed % 2 ? 0x9b9b83 : 0x8b8d86), 0, 0.25);
  rock.scale.set(1.2 + random() * 0.6, 0.8, 0.8); root.add(rock); return root;
};

// Transform and sample in the same coordinate system as the ribbon mesh. The
// inverse parent pitch is a quaternion so yaw cannot accidentally tilt houses.
export const groundScenery = (object: THREE.Object3D, distance: number, pitch: number): void => {
  const z = object.position.z, x = object.userData.baseX as number;
  const yaw = (object.userData.baseYaw || 0) + roadHeading(z, distance);
  const parentInverse = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
  object.quaternion.copy(parentInverse).multiply(new THREE.Quaternion().setFromAxisAngle(Y, yaw));
  object.position.set(x + roadBend(z, distance), terrainHeight(x, z) + roadSurfaceHeight(z, pitch), z);
  const sample = (offset: THREE.Vector3): number => terrainHeight(offset.x - roadBend(offset.z, distance), offset.z) + roadSurfaceHeight(offset.z, pitch);
  const foliage = object.userData.foliage as THREE.InstancedMesh | undefined;
  if (foliage) foliage.count = Math.ceil(object.userData.foliageCount * (z < -105 ? 0.45 : z < -65 ? 0.7 : 1));
  const foundation = object.userData.foundation as THREE.Mesh<THREE.BufferGeometry> | undefined;
  if (foundation) {
    const perimeter = object.userData.foundationPerimeter as THREE.Vector3[];
    const offsets = perimeter.map(v => v.clone().multiply(object.scale).applyQuaternion(object.quaternion));
    const center = object.position.clone();
    const supports = offsets.map(offset => sample(center.clone().add(offset)) - offset.y);
    object.position.y = Math.max(sample(center), ...supports) + 0.04;
    const inverse = object.quaternion.clone().invert();
    const positions = foundation.geometry.attributes.position, uv=foundation.geometry.attributes.uv;
    offsets.forEach((offset, i) => {
      const foot = object.position.clone().add(offset);
      foot.y = sample(foot) - 0.12;
      foot.sub(object.position).applyQuaternion(inverse).divide(object.scale);
      positions.setXYZ(perimeter.length + i, foot.x, foot.y, foot.z);
      uv.setY(perimeter.length+i,foot.y*object.scale.y*0.5);
    });
    positions.needsUpdate = true; uv.needsUpdate=true; foundation.geometry.computeVertexNormals(); foundation.geometry.computeBoundingSphere();
  }
  const plants = object.userData.plants as THREE.InstancedMesh | undefined;
  if (plants) {
    const dummy = new THREE.Object3D(), inverse = object.quaternion.clone().invert();
    (object.userData.plantOffsets as THREE.Vector3[]).forEach((offset, i) => {
      const foot = offset.clone().applyQuaternion(object.quaternion).add(object.position);
      foot.y = sample(foot);
      dummy.position.copy(foot.sub(object.position).applyQuaternion(inverse));
      dummy.scale.setScalar(0.85 + (i % 7) * 0.045);
      dummy.updateMatrix(); plants.setMatrixAt(i, dummy.matrix);
    });
    plants.instanceMatrix.needsUpdate = true;
  }
  const soil=object.userData.soil as THREE.Mesh<THREE.BufferGeometry> | undefined;
  if (soil) {
    const inverse=object.quaternion.clone().invert(), positions=soil.geometry.attributes.position;
    (object.userData.soilOffsets as THREE.Vector3[]).forEach((offset,i)=>{
      const point=offset.clone().applyQuaternion(object.quaternion).add(object.position);point.y=sample(point)+0.015;
      point.sub(object.position).applyQuaternion(inverse);positions.setXYZ(i,point.x,point.y,point.z);
    });
    positions.needsUpdate=true;soil.geometry.computeVertexNormals();
  }
  if (object.userData.surfaceAligned) {
    const step = 0.2;
    const heightAt = (dx: number, dz: number) => sample(new THREE.Vector3(object.position.x + dx, 0, z + dz));
    const dx = (heightAt(step,0)-heightAt(-step,0))/(2*step);
    const dz = (heightAt(0,step)-heightAt(0,-step))/(2*step);
    object.quaternion.setFromUnitVectors(Y,new THREE.Vector3(-dx,1,-dz).normalize()).multiply(new THREE.Quaternion().setFromAxisAngle(Y,yaw));
    object.position.y += 0.025;
  }
  const gantryFeet = object.userData.gantryFeet as THREE.Mesh[] | undefined;
  if (gantryFeet) {
    const inverse = object.quaternion.clone().invert();
    gantryFeet.forEach(post => {
      const base = new THREE.Vector3(post.position.x,0,0).applyQuaternion(object.quaternion).add(object.position);
      base.y = sample(base)-0.1;
      const bottom = base.sub(object.position).applyQuaternion(inverse).y;
      post.scale.y = (4.245-bottom)/4.25;
      post.position.y = (4.245+bottom)/2;
    });
  }
  const rail = object.userData.rail as THREE.Mesh<THREE.BufferGeometry> | undefined;
  if (rail) {
    // Absolute samples fit both ends of the W-beam to bends and grade changes.
    const inverse = object.quaternion.clone().invert(), positions = rail.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const row = Math.floor(i / 5), col = i % 5;
      const rz = z - row * 8.2 / 8;
      const point = new THREE.Vector3(x + roadBend(rz, distance) + [0, -0.055, 0, -0.055, 0][col], terrainHeight(x, rz) + roadSurfaceHeight(rz, pitch) + 0.64 + (col - 2) * 0.07, rz);
      point.sub(object.position).applyQuaternion(inverse);
      positions.setXYZ(i, point.x, point.y, point.z);
    }
    positions.needsUpdate = true; rail.geometry.computeVertexNormals(); rail.geometry.computeBoundingSphere();
  }
};

export const createFoundation = (resources: EnvironmentMaterials): { mesh: THREE.Mesh; perimeter: THREE.Vector3[] } => {
  const perimeter: THREE.Vector3[] = [];
  for (let edge = 0; edge < 4; edge++) for (let step = 0; step < 4; step++) {
    const t = step / 4;
    const points = [[-2, -1.65], [2, -1.65], [2, 1.95], [-2, 1.95]];
    const a = points[edge], b = points[(edge + 1) % 4];
    perimeter.push(new THREE.Vector3(THREE.MathUtils.lerp(a[0], b[0], t), 0, THREE.MathUtils.lerp(a[1], b[1], t)));
  }
  const vertices = [...perimeter, ...perimeter].flatMap(v => v.toArray());
  const uv = [...perimeter, ...perimeter].flatMap((v) => [v.x * 0.5 + v.z * 0.5, 0]);
  const indices: number[] = [];
  for (let i = 0; i < perimeter.length; i++) {
    const next = (i + 1) % perimeter.length;
    indices.push(i, next, i + 16, next, next + 16, i + 16);
    if (i > 0 && i < 15) indices.push(0, i + 1, i);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
  return {mesh: part(geometry, resources.material("stone", 0xaaa494)), perimeter};
};

export const createGuardrail = (): THREE.Mesh => {
  const positions = new Float32Array(9 * 5 * 3), indices: number[] = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 4; col++) {
    const a = row * 5 + col; indices.push(a, a + 5, a + 1, a + 1, a + 5, a + 6);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3)); geometry.setIndex(indices);
  return part(geometry, new THREE.MeshStandardMaterial({color: 0xaeb8b9, roughness: 0.47, metalness: 0.72, side: THREE.DoubleSide}));
};

// Collapse static details into a draw per finish. Animated fan pivots remain
// separate groups, and instanced vegetation keeps its own batching.
export const mergeStaticDetails = (root: THREE.Group, recursive = false): void => {
  root.updateMatrixWorld(true);
  const groups = new Map<THREE.Material, {mesh: THREE.Mesh; geometry: THREE.BufferGeometry}[]>();
  const inverse = root.matrixWorld.clone().invert();
  const collect = (object: THREE.Object3D) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || Array.isArray(object.material)) return;
    const geometry = (object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()).applyMatrix4(inverse.clone().multiply(object.matrixWorld));
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    if (!geometry.attributes.uv) geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2));
    Object.keys(geometry.attributes).forEach(attribute => { if (!["position","normal","uv"].includes(attribute)) geometry.deleteAttribute(attribute); });
    const entries = groups.get(object.material) || []; entries.push({mesh: object, geometry}); groups.set(object.material, entries);
  };
  if (recursive) root.traverse(collect); else root.children.forEach(collect);
  groups.forEach((entries, material) => {
    if (entries.length < 2) {entries.forEach(entry => entry.geometry.dispose()); return;}
    const geometry = mergeGeometries(entries.map(entry => entry.geometry));
    if (!geometry) {entries.forEach(entry => entry.geometry.dispose()); return;}
    entries.forEach(({mesh, geometry}) => {mesh.removeFromParent(); if (!mesh.geometry.userData.environmentShared) mesh.geometry.dispose(); geometry.dispose();});
    root.add(part(geometry, material));
  });
};

// Reserve whole footprints, including across the moving world's wrap seam.
// Keep a site on its original side and move it outward until it clears earlier
// trees/buildings/plots; this also keeps crops and straw out of foundations.
export const scenerySetback = (x: number, z: number, radius: number, depth: number, occupied: readonly THREE.Object3D[]): number => {
  const side=Math.sign(x);
  let setback=Math.max(Math.abs(x),6.1+radius+0.3);
  for(let pass=0;pass<=occupied.length;pass++) {
    let changed=false;
    for(const other of occupied) {
      const footprint=other.userData.footprint as {radius: number; depth: number} | undefined;
      if(!footprint || Math.sign(other.userData.baseX)!==side)continue;
      const separation=Math.abs(z-other.position.z)%180;
      const dz=Math.min(separation,180-separation);
      const otherRadius=footprint.radius*Math.max(other.scale.x,other.scale.z);
      const otherDepth=footprint.depth*Math.max(other.scale.x,other.scale.z);
      if(dz<depth+otherDepth+0.4 && Math.abs(setback-Math.abs(other.userData.baseX))<radius+otherRadius+0.4) {
        setback=Math.abs(other.userData.baseX)+radius+otherRadius+0.45;changed=true;
      }
    }
    if(!changed)break;
  }
  return side*setback;
};
