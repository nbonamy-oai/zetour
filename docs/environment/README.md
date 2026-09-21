# 3D environment validation

Ze Tour keeps its warm rural art direction while adding textured surfaces,
grounded scenery, moving grass and a first-person cockpit with bent elbows.
This directory contains direct browser captures and raw validation results.

## Screenshot conditions

The PR's environment comparisons use `before/` and `final/`: matching stage,
grade, zero travel/speed, fixed animation time (2 seconds), camera mode,
1440 × 1000 viewport and DPR 1. The captured game area is 1400 × 836.
`final/` was captured from the running game with the finished cockpit.
House images use the same inspection camera looking at road-local (-18, 2, -12),
with target Y offset 1.3, camera offset (-16, 15, 12), and FOV 50°.
This exposes the foundations on both +12% and -12% grades.

`cockpit-before.png` and `cockpit-bent-after.png` show the original and finished
cockpits at stage 1, First person, zero grade/travel, fixed animation time
2 seconds, displayed speed 25 km/h, 1440 × 810 and DPR 1. The
`cockpit-bent-*-detail.png` pair isolates the straight-versus-bent arm posture
using the same direct browser screenshot rectangle (960 × 280).
The five `before/stage-*.png` and `after/stage-*.png` pairs cover the stage
palettes in Chase view, where the cockpit is hidden.

`terrain-scroll-start.png` and `terrain-scroll-forward.png` show the same
Roadside camera and animation time, separated by half a second of world
travel at displayed 25 km/h (6.75 world units). Grass blades, painted grass,
asphalt and shoulders advance with roadside objects. All screenshots are
captured from the running game; there are no post-capture image edits.
Other captures are retained as an evidence archive, not used as final PR views.

## Reproduce

```sh
npm ci
npm run build
npm test -- --maxWorkers=2
# Browser tooling, if not already available:
npm install --no-save playwright
CHROMIUM_PATH=/usr/bin/chromium node scripts/check-environment.cjs
node scripts/check-grass-scroll.cjs
node scripts/check-terrain-scroll.cjs
COCKPIT_BASELINE=8e58d13920ae31507dceebe8f6b5ba1d45f025ff COCKPIT_PREFIX=cockpit-bent COCKPIT_BENT=1 node scripts/check-cockpit.cjs
# With the production preview served on :5175:
node scripts/check-environment-app.cjs
# With the finished game served by Vite on :5173:
ENVIRONMENT_PORT=5173 node scripts/capture-environment.cjs final
```

The browser harness compiles the real ThreeRide class with production Vite
settings into a temporary, unshipped entry. It never adds production debug UI.
The application check separately navigates the actual production app and its
camera controls. Screenshot capture uses the development component instance
only to set deterministic game state and comparable cameras.

## Validation results

- Production TypeScript/Vite build passes. Vite's existing large-chunk warning
  remains (approximately 2.24 MB main bundle, 614 kB gzip).
- **14/14** targeted environment/road-grade tests pass, covering triangle
  sampling, grounding, clearances, footprint reservations, ownership, grass
  recycling, surface movement, stops/resets and long-ride precision.
- Full suite: **214 passed, 3 failed**. The three failures are progression
  simulation timeouts, also reproduced on untouched commit
  `a84a5ce741ddb983124085a8ee48cdf84cbfc86b` with one worker and no concurrent
  browser/build: 9.69, 40.71 and 18.39 seconds against 5, 30 and 15 second
  limits. Vitest also reported an `onTaskUpdate` RPC timeout. Core simulation
  code and existing progression tests are unchanged.
- `production-browser-results.json`: **75/75** renders, five stages × five
  cameras × -12%, 0%, +12% grades; nonblank pixels, camera clearance, no
  browser/shader errors, and stable resource counts over three stage cycles.
  All 14 tracked texture assets dispose exactly once; repeated teardown removes
  the canvas. This environment-renderer snapshot is from `1b5c520`.
- `production-app-results.json`: **25/25** actual production-app stage/camera
  cases, including real -5% descent and +12% climb; correct labels and no
  JavaScript errors or failed asset responses (environment snapshot `1b5c520`).
- `grass-scroll-browser-results.json`: **75/75** views with camera and wind
  time frozen and only blades drawn. All 6,000 roots advance at prop speed,
  remain grounded within 0.0001 world units, and every view changes pixels.
- `terrain-scroll-browser-results.json`: **75/75** views with only painted
  grass drawn and camera, wind, positions and normals frozen. Every view changes
  at least 8,517 pixels; every terrain/asphalt/shoulder UV phase matches travel.
  Stops, resets and unchanged shared texture offsets are also checked.
- `cockpit-bent-browser-results.json`: **45/45** finished-cockpit cases across
  five stages, -12%/flat/+12% grades, and 1440×810, 1920×810 and 810×1080
  viewports. Grips stay visible, elbows are outboard with 80–130° bends, upper
  arm ends stay outside the view, the third-person rider is hidden, and the
  cockpit hides in the other four cameras. No browser/shader errors.
- All **22** cockpit resources (9 geometries, 9 materials, 4 textures) dispose
  exactly once after repeated teardown; the renderer canvas is removed.

## Rendering cost

The whole-scene benchmark compares the original checkout against the environment
renderer at `1b5c520`, before cockpit and surface-travel changes. Its raw records
are `baseline-browser-results.json` and `production-browser-results.json`.
It uses ANGLE/SwiftShader **CPU software rendering**, 960 × 600, DPR 1, settled
Chase camera, displayed 25 km/h, eight warm-up and 15 measured frames per stage.
Frames include presentation; CPU update measurements exclude rendering. These
are a software cost comparison, not hardware GPU FPS measurements.

| Stage | Original median / p95 ms | Environment median / p95 ms | Draw calls | Triangles | Terrain/prop CPU ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 254 / 324 | 1100 / 1235 | 1862 → 1143 | 85,564 → 253,220 | 3.3 |
| 2 | 318 / 350 | 1921 / 2142 | 2102 → 1193 | 91,744 → 397,408 | 5.9 |
| 3 | 310 / 340 | 1949 / 2083 | 1652 → 1003 | 79,956 → 207,632 | 4.6 |
| 4 | 272 / 293 | 1527 / 3063 | 1872 → 1096 | 82,856 → 273,450 | 6.6 |
| 5 | 346 / 370 | 2052 / 2157 | 2168 → 1179 | 98,916 → 226,592 | 7.8 |

Draw calls decrease 39–46%; retained geometry counts decrease 1,801 → 976.
That snapshot retains 17 GPU textures across stage cycles; the finished cockpit
owns four textures and is validated separately. Environmental maps are shared
256 × 256 RGBA assets. Added detail substantially increases SwiftShader raster
cost despite batching; no measured desktop GPU frame-rate claim is made.

Finished components have these independently measured costs:

- Nearby grass: **2 draw calls / 54,000 triangles** (6,000 instanced clumps).
- Painted grass terrain: **2 draw calls / 12,000 triangles**; road, shoulders
  and grass together: 5 draws / 12,600 triangles. Surface scrolling adds no
  geometry, materials or draw calls.
- Finished isolated cockpit: **9 draw calls / 23,658 triangles**, versus
  original 86 draws / 10,518 triangles. Skin/fabric add two 256² RGBA textures,
  about 0.67 MiB together including mipmaps.
- Moving terrain/prop updates: **8.4 ms median / 14.0 ms p95**, 30 samples
  after ten warm-up updates in `terrain-scroll-browser-results.json`. This
  is CPU update time only, not whole-scene FPS or a same-session comparison
  with the whole-scene benchmark.

Local manual playtesting reported acceptable performance. Hardware GPU frame
times have not been instrumented; a sustained target FPS remains unverified.

## Limits

This remains a procedural illustrated game environment, not scanned assets.
Clouds are a sky shader rather than volumetric weather; distant mountain
vegetation and snow are surface shading. Blades cover the nearby verge, and
there is one near-field shadow map. Houses use retaining foundations on extreme
arcade slopes. First-person arms use a fixed grip with camera/steering response,
not skeletal braking animation or skin subsurface scattering.
