import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  createSceneryTree,
  createSceneryHayBale,
  createCropRows,
  createSceneryFlag,
  groundCropRows,
} from "../../src/game/threeScenery";
import { disposeRoadObject } from "../../src/game/threeProps";

describe("detailed roadside scenery", () => {
  it.each(["broadleaf", "cypress", "fir"] as const)(
    "builds a deterministic, grounded %s with a bounded foliage pool",
    (species) => {
      const first = createSceneryTree(7, species, { value: 0 }),
        second = createSceneryTree(7, species, { value: 0 });
      const leaves = first.getObjectByName(
        "Layered foliage",
      ) as THREE.InstancedMesh;
      const other = second.getObjectByName(
        "Layered foliage",
      ) as THREE.InstancedMesh;
      expect(leaves.count).toBeLessThanOrEqual(300);
      expect(Array.from(leaves.instanceMatrix.array)).toEqual(
        Array.from(other.instanceMatrix.array),
      );
      expect(
        Array.from(leaves.instanceMatrix.array).every(Number.isFinite),
      ).toBe(true);
      const bounds = new THREE.Box3().setFromObject(first);
      expect(bounds.min.y).toBeCloseTo(0);
      expect(bounds.max.y).toBeGreaterThan(3);
      expect(bounds.max.y).toBeLessThan(6);
      disposeRoadObject(first);
      disposeRoadObject(second);
    },
  );

  it("roots the rounded hay roll and twine above ground", () => {
    const bale = createSceneryHayBale(0),
      bounds = new THREE.Box3().setFromObject(bale);
    expect(bounds.min.y).toBeGreaterThan(-0.02);
    expect(bounds.min.y).toBeLessThan(0.02);
    expect(bounds.max.y).toBeGreaterThan(1.6);
    disposeRoadObject(bale);
  });

  it("keeps crop roots on sloped ground while leaving the paved road clear", () => {
    const field = createCropRows(9, true, { value: 0 });
    field.position.set(-9, -0.45, 0);
    field.rotation.x = 0.3;
    const height = (x: number, z: number): number => 0.05 * x + 0.03 * z;
    groundCropRows(field, height);
    const plants = field.userData.cropPlants as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4(),
      root = new THREE.Vector3();
    for (let i = 0; i < plants.count; i++) {
      plants.getMatrixAt(i, matrix);
      root.setFromMatrixPosition(matrix).applyMatrix4(field.matrix);
      expect(root.y).toBeCloseTo(height(root.x, root.z), 5);
      expect(root.x).toBeLessThan(-6.1);
    }
    disposeRoadObject(field);
  });

  it("releases instanced buffers and custom wind shadow materials when replacing scenery", () => {
    const roots = [
      createSceneryTree(0, "fir", { value: 0 }),
      createCropRows(0, true, { value: 0 }),
      createSceneryFlag(0, { value: 0 }),
    ];
    for (const root of roots) {
      const disposals: ReturnType<typeof vi.fn>[] = [];
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        if (object.customDepthMaterial) {
          const spy = vi.fn();
          object.customDepthMaterial.addEventListener("dispose", spy);
          disposals.push(spy);
        }
        if (object instanceof THREE.InstancedMesh) {
          const spy = vi.fn();
          object.addEventListener("dispose", spy);
          disposals.push(spy);
        }
      });
      expect(disposals.length).toBeGreaterThan(0);
      disposeRoadObject(root);
      disposals.forEach((spy) => expect(spy).toHaveBeenCalledOnce());
    }
  });
});
