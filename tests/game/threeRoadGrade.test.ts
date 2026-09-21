import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyRoadPitch, threeRoadPitch, roadSurfaceHeight, roadSurfacePitch, roadBend, roadHeading, ThreeLandscape } from "../../src/game/threeLandscape";

describe("3D road grade", () => {
  it("makes a four-percent grade unmistakable while easing the steepest slopes", () => {
    const visibleDegrees = THREE.MathUtils.radToDeg(threeRoadPitch(0.04));
    expect(visibleDegrees).toBeGreaterThan(18);
    expect(visibleDegrees).toBeLessThan(22);
    expect(threeRoadPitch(-0.04)).toBeCloseTo(-threeRoadPitch(0.04));
    expect(threeRoadPitch(0.12)).toBeLessThan(THREE.MathUtils.degToRad(38));
    expect(threeRoadPitch(0)).toBe(0);
  });

  it("raises the road ahead on a climb and lowers it on a descent", () => {
    for (const gradient of [-0.08, 0, 0.08, 0.12]) {
      const road = new THREE.Group();
      applyRoadPitch(road, threeRoadPitch(gradient), 1.1);
      const ahead = road.localToWorld(new THREE.Vector3(0, 0, -50));
      const rider = road.localToWorld(new THREE.Vector3(0, 0, 1.1));
      expect(Math.sign(ahead.y)).toBe(Math.sign(gradient));
      expect(rider.y).toBeCloseTo(0);
      expect(rider.z).toBeCloseTo(1.1);
    }
    expect(threeRoadPitch(0.12)).toBeGreaterThan(threeRoadPitch(0.08));
    expect(threeRoadPitch(0.3)).toBe(threeRoadPitch(0.12));
  });

  it("keeps the playable foreground on grade and levels out ahead into a crest or valley", () => {
    for (const gradient of [-0.04, 0, 0.1]) {
      const pitch = threeRoadPitch(gradient);
      const road = new THREE.Group();
      applyRoadPitch(road, pitch, 1.1);
      const point = (z: number) => road.localToWorld(new THREE.Vector3(0, roadSurfaceHeight(z, pitch), z));
      expect(roadSurfaceHeight(1.1, pitch)).toBeCloseTo(0);
      expect(Math.abs(roadSurfacePitch(-6, pitch))).toBe(0);
      expect(roadSurfaceHeight(-6, pitch)).toBeCloseTo(0);
      expect(Math.sign(point(-80).y)).toBe(Math.sign(gradient));
      expect(Math.abs(pitch + roadSurfacePitch(-220, pitch))).toBeLessThan(0.02);
      expect(Math.abs(point(-220).y - point(-200).y)).toBeLessThan(0.4);
    }
  });

  it("samples the rendered grass triangles on both sides of bends and hills", () => {
    const landscape = new ThreeLandscape();
    for (const gradient of [-0.1, 0, 0.1]) {
      landscape.setRoadPitch(threeRoadPitch(gradient), 1.1);
      landscape.update(350);
      landscape.root.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !object.geometry.hasAttribute("grassCoord")) return;
        const positions = object.geometry.getAttribute("position");
        const indices = object.geometry.getIndex()!;
        for (let i = 0; i < indices.count; i += 39) {
          const a = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(i));
          const b = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(i + 1));
          const c = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(i + 2));
          const point = a.multiplyScalar(0.2).addScaledVector(b, 0.3).addScaledVector(c, 0.5);
          // Bent row coordinates interpolate linearly along each triangle.
          expect(landscape.surfaceHeight(point.x, point.z, 350)).toBeCloseTo(point.y, 4);
        }
      });
    }
  });

  it("supports upright house footprints above the grass as they move and wrap", () => {
    const landscape = new ThreeLandscape();
    const house = new THREE.Group();
    house.userData.groundFootprint = [1.95, 1.85];
    house.scale.setScalar(1.11);
    for (const grade of [-0.12, 0, 0.12]) {
      const pitch = threeRoadPitch(grade);
      landscape.setRoadPitch(pitch, 1.1);
      for (const distance of [0, 350, 1200]) {
        landscape.update(distance);
        for (const side of [-1, 1]) {
          for (const z of [12, -12, -90, -170]) {
            house.position.set(side * 12 + roadBend(z, distance), 0, z);
            house.rotation.set(-pitch, side * Math.PI / 2 + roadHeading(z, distance), 0);
            house.position.y = landscape.supportHeight(house, distance);
            expect(Number.isFinite(house.position.y)).toBe(true);
            for (let x = -3; x <= 3; x += 1) {
              for (let depth = -3; depth <= 3; depth += 1) {
                const point = new THREE.Vector3(x / 3 * 1.95, 0, depth / 3 * 1.85).multiply(house.scale)
                  .applyEuler(house.rotation).add(house.position);
                expect(point.y + 0.00001).toBeGreaterThanOrEqual(landscape.surfaceHeight(point.x, point.z, distance));
              }
            }
          }
        }
      }
    }
  });

  it("keeps the rendered asphalt and road actors aligned while the horizon stays level", () => {
    const landscape = new ThreeLandscape();
    const actors = new THREE.Group();
    for (const grade of [0.12, -0.05, 0]) {
      const pitch = threeRoadPitch(grade);
      landscape.setRoadPitch(pitch, 1.1);
      applyRoadPitch(actors, pitch, 1.1);
      landscape.update(100);
      const asphalt = landscape.root.getObjectByName("Road surface") as THREE.Mesh;
      const vertex = new THREE.Vector3().fromBufferAttribute(asphalt.geometry.attributes.position, 60);
      expect(vertex.y).toBeCloseTo(roadSurfaceHeight(vertex.z, pitch), 4);
      const actor = new THREE.Object3D();
      actor.position.copy(vertex);
      actors.add(actor);
      expect(actor.getWorldPosition(new THREE.Vector3()).distanceTo(asphalt.localToWorld(vertex.clone()))).toBeLessThan(0.00001);
      expect(actor.position.equals(vertex)).toBe(true);
      expect(landscape.root.rotation.x).toBe(0);
      const mountains = landscape.root.getObjectByName("Mountain backdrop")!;
      const farRoad = actors.localToWorld(new THREE.Vector3(0, 0, -238));
      expect(new THREE.Box3().setFromObject(mountains).min.y).toBeLessThan(farRoad.y);
      actors.remove(actor);
    }
    landscape.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
  });
});
