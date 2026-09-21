import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ThreeLandscape, threeRoadPitch } from "../../src/game/threeLandscape";

describe("roadside grass", () => {
  it("keeps a fixed instance pool rooted in the terrain through travel and grade changes", () => {
    const landscape = new ThreeLandscape();
    const grass = landscape.root.getObjectByName("Roadside grass blades") as THREE.InstancedMesh;
    expect(grass.isInstancedMesh).toBe(true);
    const count = grass.count;
    const matrix = new THREE.Matrix4();
    const point = new THREE.Vector3();
    const heights = new Set<number>();
    for (const grade of [-0.1, 0, 0.1]) {
      landscape.setRoadPitch(threeRoadPitch(grade), 1.1);
      for (const distance of [0, 40, 93, 1234]) {
        landscape.update(distance, 5);
        expect(grass.count).toBe(count);
        for (let i = 0; i < count; i += 31) {
          grass.getMatrixAt(i, matrix);
          expect(matrix.elements.every(Number.isFinite)).toBe(true);
          point.setFromMatrixPosition(matrix);
          expect(point.z).toBeGreaterThanOrEqual(-75);
          expect(point.z).toBeLessThan(18);
          expect(point.y + 0.015).toBeCloseTo(landscape.surfaceHeight(point.x, point.z, distance), 5);
          heights.add(Math.round(new THREE.Vector3().setFromMatrixScale(matrix).y * 1000));
        }
      }
    }
    expect(heights.size).toBeGreaterThan(20);
  });
});
