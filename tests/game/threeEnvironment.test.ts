import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { EnvironmentMaterials } from "../../src/game/threeEnvironmentMaterials";
import { ThreeLandscape, terrainHeight, roadBend, roadSurfaceHeight, threeRoadPitch, applyRoadPitch } from "../../src/game/threeLandscape";
import { createFoundation, createPlantedField, createEnvironmentTree, createGuardrail, groundScenery, scenerySetback } from "../../src/game/threeScenery";
import { disposeRoadObject } from "../../src/game/threeProps";

const prepare = (root: THREE.Object3D, x: number, z: number, yaw = 0): void => {
  root.userData.baseX = x; root.userData.baseYaw = yaw; root.position.z = z;
};
const surface = (point: THREE.Vector3, distance: number, pitch: number): number =>
  terrainHeight(point.x - roadBend(point.z, distance), point.z) + roadSurfaceHeight(point.z, pitch);

describe("3D environment grounding and ownership", () => {
  it("scrolls grass with the roadside scenery and recycles it into the distant verge", () => {
    const resources = new EnvironmentMaterials(), landscape = new ThreeLandscape(resources);
    const grass: THREE.InstancedMesh[] = [];
    landscape.root.traverse(object => {
      if (object instanceof THREE.InstancedMesh && object.name === "Wind-driven roadside blades") grass.push(object);
    });
    expect(grass).toHaveLength(2);
    const scenery = new THREE.Object3D(); prepare(scenery, 15, -10);
    groundScenery(scenery, 0, 0);
    const roots = grass.map(mesh => mesh.instanceMatrix.array.slice());
    const previousSceneryZ = scenery.position.z;
    const advance = 13.5 / 60; // One game frame at a displayed 25 km/h.
    scenery.position.z += advance;
    groundScenery(scenery, advance, 0); landscape.update(advance, 1 / 60);
    let recycled = 0;
    grass.forEach((mesh, side) => {
      const matrices = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count; i++) {
        const previousZ = roots[side][i * 16 + 14], z = matrices[i * 16 + 14];
        if (previousZ + advance > 10) {
          recycled++; expect(z).toBeCloseTo(previousZ + advance - 90, 4);
        } else expect(z - previousZ).toBeCloseTo(scenery.position.z - previousSceneryZ, 4);
        expect(z).toBeGreaterThanOrEqual(-80); expect(z).toBeLessThanOrEqual(10);
      }
    });
    expect(recycled).toBeGreaterThan(0);
    const positions = grass.map(mesh => mesh.instanceMatrix.array.slice());
    landscape.update(advance, 2);
    grass.forEach((mesh, i) => expect(mesh.instanceMatrix.array).toEqual(positions[i]));
    expect(resources.time.value).toBe(2);
    disposeRoadObject(landscape.root); resources.dispose();
  });

  it("keeps scrolling grass rooted on slopes and outside curved road edges, including after long rides", () => {
    const resources = new EnvironmentMaterials(), landscape = new ThreeLandscape(resources);
    const grass: THREE.InstancedMesh[] = [];
    landscape.root.traverse(object => {
      if (object instanceof THREE.InstancedMesh && object.name === "Wind-driven roadside blades") grass.push(object);
    });
    for (const gradient of [-0.12, 0, 0.12]) for (const distance of [5, 90, 1200, 100_000]) {
      const pitch = threeRoadPitch(gradient); landscape.setRoadPitch(pitch, 1.1); landscape.update(distance);
      grass.forEach(mesh => {
        const matrices = mesh.instanceMatrix.array;
        for (const index of [0, 29, 500, 1500, 2999]) {
          const point = new THREE.Vector3(matrices[index * 16 + 12], matrices[index * 16 + 13], matrices[index * 16 + 14]);
          expect(point.y).toBeCloseTo(surface(point, distance, pitch), 4);
          expect(Math.abs(point.x - roadBend(point.z, distance))).toBeGreaterThan(6.1);
        }
      });
    }
    disposeRoadObject(landscape.root); resources.dispose();
  });

  it("samples the rendered terrain triangles on both sides of the road", () => {
    const resources = new EnvironmentMaterials(), landscape = new ThreeLandscape(resources);
    for (const gradient of [-0.12, 0, 0.12]) {
      const pitch = threeRoadPitch(gradient); landscape.setRoadPitch(pitch, 1.1); landscape.update(1200);
      const meshes: THREE.Mesh[] = [];
      landscape.root.traverse(object => { if (object instanceof THREE.Mesh && !(object instanceof THREE.InstancedMesh) && object.name === "Rolling terrain") meshes.push(object); });
      // Cast in road-local coordinates to verify interpolation independently.
      meshes.forEach(mesh => mesh.updateMatrix());
      for (const x of [-38.9,-21.4,-8.2,8.2,21.4,38.9]) for (const z of [-3.1,-45.7,-151.8]) {
        const ray = new THREE.Raycaster(new THREE.Vector3(x + roadBend(z,1200), 250,z), new THREE.Vector3(0,-1,0));
        const localMeshes = meshes.map(mesh => { const local = mesh.clone(); local.matrixWorld.identity(); return local; });
        const hit = ray.intersectObjects(localMeshes)[0];
        expect(hit, `${x},${z}`).toBeDefined();
        expect(Math.abs(hit.point.y - surface(hit.point,1200,pitch))).toBeLessThan(0.002);
      }
    }
    disposeRoadObject(landscape.root); resources.dispose();
  });

  it("keeps houses upright and their entire foundation skirt grounded on steep grades and bends", () => {
    const resources = new EnvironmentMaterials(), road = new THREE.Group(), house = new THREE.Group();
    const {mesh, perimeter} = createFoundation(resources);
    house.add(mesh); house.userData.foundation = mesh; house.userData.foundationPerimeter = perimeter;
    house.scale.setScalar(1.11); road.add(house);
    for (const gradient of [-0.12,0,0.12]) for (const distance of [0,500,2000]) for (const z of [-12,-80,-160]) for (const side of [-1,1]) {
      const pitch = threeRoadPitch(gradient); applyRoadPitch(road,pitch,1.1);
      prepare(house,side*13,z,side*Math.PI/2); groundScenery(house,distance,pitch); road.updateMatrixWorld(true);
      const up = new THREE.Vector3(0,1,0).applyQuaternion(house.getWorldQuaternion(new THREE.Quaternion()));
      expect(up.distanceTo(new THREE.Vector3(0,1,0))).toBeLessThan(1e-6);
      const positions = mesh.geometry.attributes.position;
      for (let i=0;i<perimeter.length;i++) {
        const top = perimeter[i].clone().multiply(house.scale).applyQuaternion(house.quaternion).add(house.position);
        expect(top.y - surface(top,distance,pitch)).toBeGreaterThan(0.039);
        const bottom = new THREE.Vector3().fromBufferAttribute(positions,perimeter.length+i).multiply(house.scale).applyQuaternion(house.quaternion).add(house.position);
        expect(bottom.y).toBeCloseTo(surface(bottom,distance,pitch)-0.12,4);
        expect(Math.abs(bottom.x-roadBend(bottom.z,distance))).toBeGreaterThan(6.1);
      }
    }
    disposeRoadObject(house); resources.dispose();
  });

  it("plants every crop root on the terrain rather than placing a rigid row above it", () => {
    const resources = new EnvironmentMaterials(), field = createPlantedField(resources,true,3);
    prepare(field,-16,-100,0.3);
    for (const gradient of [-0.12,0.12]) {
      const pitch=threeRoadPitch(gradient); groundScenery(field,1700,pitch);
      const plants = field.userData.plants as THREE.InstancedMesh;
      for (let i=0;i<plants.count;i++) {
        const matrix = new THREE.Matrix4(); plants.getMatrixAt(i,matrix);
        const root = new THREE.Vector3().setFromMatrixPosition(matrix).applyQuaternion(field.quaternion).add(field.position);
        expect(root.y).toBeCloseTo(surface(root,1700,pitch),5);
        expect(Math.abs(root.x-roadBend(root.z,1700))).toBeGreaterThan(6.1);
      }
    }
    disposeRoadObject(field); resources.dispose();
  });

  it("fits guardrail segments to the road curve and shoulder height at both ends", () => {
    const post=new THREE.Group(), rail=createGuardrail(); post.add(rail); post.userData.rail=rail;
    for(const gradient of [-0.12,0.12]) for(const distance of [0,1200]) {
      const pitch=threeRoadPitch(gradient); prepare(post,6.35,-115); groundScenery(post,distance,pitch);
      for(const row of [0,4,8]) {
        const point=new THREE.Vector3().fromBufferAttribute(rail.geometry.attributes.position,row*5+2).applyQuaternion(post.quaternion).add(post.position);
        expect(point.x-roadBend(point.z,distance)).toBeCloseTo(6.35,4);
        expect(point.y-surface(point,distance,pitch)).toBeCloseTo(0.64,4);
      }
    }
    disposeRoadObject(post);
  });

  it("reserves building and field footprints on either side, including across the wrap seam", () => {
    for(const side of [-1,1]) {
      const house=new THREE.Object3D(); prepare(house,side*16,-169);
      house.userData.footprint={radius:2.9,depth:2.9};house.scale.setScalar(1.1);
      const tree=new THREE.Object3D();prepare(tree,side*21,8);tree.userData.footprint={radius:3.2,depth:3.2};
      const x=scenerySetback(side*15,9,4.8,4.8,[house,tree]);
      expect(Math.sign(x)).toBe(side);
      for(const occupied of [house,tree]) {
        expect(Math.abs(x-occupied.userData.baseX)).toBeGreaterThan(4.8+occupied.userData.footprint.radius*occupied.scale.x);
      }
      expect(Math.abs(x)-4.8).toBeGreaterThan(6.1);
      // A plot far along the route needs no extra setback.
      expect(scenerySetback(side*15,-80,4.8,4.8,[house,tree])).toBe(side*15);
    }
  });

  it("retains shared assets across stage disposal and releases them once at ride teardown", () => {
    const resources=new EnvironmentMaterials(), first=createEnvironmentTree(resources,1,"oak"), second=createEnvironmentTree(resources,2,"oak");
    const leaves=resources.geometry("leaves",()=>new THREE.BufferGeometry()), texture=resources.texture("foliage"), material=resources.material("foliage",0x638740,true);
    const geometryDispose=vi.spyOn(leaves,"dispose"), textureDispose=vi.spyOn(texture,"dispose"), materialDispose=vi.spyOn(material,"dispose");
    const instances=first.children.find(object=>object instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
    const instanceDispose=vi.spyOn(instances,"dispose");
    disposeRoadObject(first); disposeRoadObject(second);
    expect(instanceDispose).toHaveBeenCalledOnce(); expect(geometryDispose).not.toHaveBeenCalled(); expect(textureDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
    resources.dispose(); resources.dispose();
    expect(geometryDispose).toHaveBeenCalledOnce(); expect(textureDispose).toHaveBeenCalledOnce(); expect(materialDispose).toHaveBeenCalledOnce();
  });
});
