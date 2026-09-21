import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ThreeLandscape } from "../../src/game/threeLandscape";

describe("3D environment", () => {
  it("restores the landscape palette after leaving the Alps without rebuilding ridges", () => {
    const landscape = new ThreeLandscape();
    const mountains = landscape.root.getObjectByName("Mountain backdrop")!;
    const ridges = mountains.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
    landscape.setStage(1, false);
    const original = ridges.map(ridge => Array.from(ridge.geometry.getAttribute("color").array));
    const geometry = ridges.map(ridge => ridge.geometry);
    landscape.setStage(5, false);
    expect(ridges.some((ridge, i) => Array.from(ridge.geometry.getAttribute("color").array)
      .some((value, j) => value !== original[i]![j]))).toBe(true);
    landscape.setStage(1, false);
    ridges.forEach((ridge, i) => {
      expect(ridge.geometry).toBe(geometry[i]);
      expect(Array.from(ridge.geometry.getAttribute("color").array)).toEqual(original[i]);
    });
    expect(ridges.every(ridge => Array.from(ridge.geometry.getAttribute("position").array).every(Number.isFinite))).toBe(true);
  });
});
