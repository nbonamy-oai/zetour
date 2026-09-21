# 3D environment validation

The environment keeps Ze Tour's warm, illustrated rural style while replacing
flat surfaces and primitive scenery with finer physical detail. The screenshots
in `before/` and `after/` are captured from the running game, with matching stage,
grade, zero visual speed, viewport (1440 × 1000, DPR 1), and camera mode. Cameras
are settled through the game's own render function and a fixed animation clock;
only development component state is accessed by the capture script. House
images use the same fixed inspection camera outside the left verge, looking
inward at road-local (-18, 2, -12), with world offset (-16, 15, 12), FOV 50°.
This exposes their foundations rather than hiding houses behind a road crest.

## Changes

- Asphalt aggregate, gravel shoulders, organic grass texture and broad terrain
  color variation; brighter lane markings follow the same bend/crest as asphalt.
- 6,000 nearby instanced grass clumps (three tapered blades each), natural color
  variation and wind; distant grass uses the textured terrain rather than blades.
- Animated procedural clouds with soft lit edges, warm sunlight and a horizon
  gradient; three rugged mountain layers with rock, vegetation, alpine snow and
  progressively stronger distance haze.
- Oak, birch, fir, cypress and olive trees have bark, branching trunks, roots,
  individual leaf cards and crossed needle sprigs, wind and matching wind-driven shadows.
  Foliage density falls with distance.
- Rounded straw rolls have straw fibers, spiral wound ends and two twine bands.
  Crop/lavender rows have separate green stems and colored heads, soil strips,
  varied plant scale, and individually sampled terrain roots.
- Plaster walls, tiled roofs, wooden doors and masonry foundations; house
  orientation cancels the parent road pitch using quaternions. Foundation skirts
  reach the terrain along their entire perimeter instead of sinking/floating.
- Weathered rocks, cloth flags, roadside reflectors and corrugated guardrails.
  Guardrails sample both bends and slope changes along each segment; gantry
  supports independently extend to the shoulders.

All scenery uses the same road-relative, triangle-interpolated terrain lattice.
Houses, trees and fields have conservative roadside setbacks and reserve their
footprints to avoid crops, bales or trunks clipping through buildings. Terrain and prop
coordinates share the road's bend and grade transforms. Shared textures,
materials and foliage/blade geometries are owned by one ride, retained during
stage changes, and disposed at teardown. Stage disposal also releases instanced
mesh buffers. Static house and spectator details are merged by material.

## Reproduce

```sh
npm ci
npm run build
npm test -- --maxWorkers=2
# Install browser tooling locally if it is not already available.
npm install --no-save playwright
CHROMIUM_PATH=/usr/bin/chromium node scripts/check-environment.cjs
# With Vite serving the improved game at :5173 and the baseline at :5174:
node scripts/capture-environment.cjs before
node scripts/capture-environment.cjs after
# With npm run preview serving the production build at :5175:
node scripts/check-environment-app.cjs
```

`check-environment.cjs` compiles the real ThreeRide class with Vite's production
settings into a temporary, unshipped browser harness. It checks all five stages,
all five cameras, and grades -12%, 0%, +12% (75 combinations), including pixel
readback, shader/browser errors, repeated stage changes and resource disposal.
It also measures 15 warmed frames (after eight warm-up frames) at 960 × 600, DPR 1 while updating terrain and
scenery at 25 km/h displayed pace (13.5 world units/s). Frame time includes presentation; CPU time separately covers
terrain and scenery updates. The camera is settled in Chase view before timing. The raw output is
`production-browser-results.json`.
The test harness is never imported by the application and adds no debug controls
to production UI. `check-environment-app.cjs` additionally navigates the actual
production build and cycles all five camera controls in five separately seeded
stages (25 cases), including the real -5% descent and +12% alpine climb; it
checks the displayed stage/grade, JavaScript errors and failed asset responses.
Screenshots were visually inspected, including house-foot contact and the
road/guardrail bend in the extreme slope views.

For a fair baseline, preserve the original checkout at `/tmp/zetour-baseline`,
symlink its `node_modules`, and copy the original five-line
`scripts/environment-harness.ts` from commit `cbc67a9` into its scripts
directory (the baseline has no terrain sampler export). Then run the same
script with `ENVIRONMENT_BASELINE=1`. This produces
`baseline-browser-results.json` using identical rendering/measurement steps.

## Test results

- `npm run build`: passed (TypeScript and production Vite build).
- Targeted terrain, road grade, grounding, footprint and resource ownership
  tests: **10/10 passed**.
- Full suite: **214 passed, 3 failed**. All three failures are existing
  `tests/core/progressionPacing.test.ts` simulation timeouts, plus a Vitest
  `onTaskUpdate` RPC timeout. The same three failures reproduce on untouched
  commit `a84a5ce741ddb983124085a8ee48cdf84cbfc86b`, running that file alone with
  one worker and no concurrent browser/build. Baseline durations were 9.69s,
  40.71s and 18.39s against 5s, 30s and 15s timeouts respectively. No core
  simulation code or existing progression tests are changed.
- Actual production application: **25/25** stage/camera-control cases; stage
  labels and real grades verified (including -5% descent and +12% climb), no
  JavaScript errors or failed asset responses. Raw results are in
  `production-app-results.json`.
- Production renderer browser harness: **75/75** stage/grade/camera renders,
  nonblank pixel readback and camera clearance above the rendered terrain,
  no browser/shader errors; three complete stage
  cycles retain identical geometry/texture counts. All 14 tracked textures
  emit disposal exactly once and the canvas is removed on repeated teardown.

## Rendering performance

See the original and improved `*-browser-results.json` files for all per-view
render counts. Measurements use SwiftShader software rendering, not a hardware
GPU. Frame times include presentation; terrain/prop CPU time excludes renderer
work. Only 15 warmed samples per stage are taken, so these are a cost comparison
rather than a sustained frame-rate certification.

| Stage | Original median / p95 ms | Improved median / p95 ms | Draw calls | Triangles | Improved terrain/prop CPU ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 254 / 324 | 1100 / 1235 | 1862 → 1143 | 85,564 → 253,220 | 3.3 |
| 2 | 318 / 350 | 1921 / 2142 | 2102 → 1193 | 91,744 → 397,408 | 5.9 |
| 3 | 310 / 340 | 1949 / 2083 | 1652 → 1003 | 79,956 → 207,632 | 4.6 |
| 4 | 272 / 293 | 1527 / 3063 | 1872 → 1096 | 82,856 → 273,450 | 6.6 |
| 5 | 346 / 370 | 2052 / 2157 | 2168 → 1179 | 98,916 → 226,592 | 7.8 |

Draw calls fall 39–46%, and retained geometries after full stage cycles fall
from 1,801 to 976 (46%). Total GPU texture counts rise from 4 to 17 and stay
stable across repeated cycles. The 13 environmental maps are only 256 × 256
RGBA and shared per ride. Improved terrain/prop CPU updates take 3.3–7.8 ms
on this environment. Software median frame times rise to 1.10–2.05 seconds
from 0.25–0.35 seconds: this is a substantial software-rendering regression,
not proof of meeting a hardware GPU frame budget. A hardware GPU check is
required before promoting this draft to a target-frame-rate claim.

## Limits

This remains an illustrated procedural environment, rather than scanned assets
or photorealism. Mountain vegetation/snow are distant surface shading, clouds
are a procedural sky layer rather than volumetric weather, and grass blades are
limited to the nearby verge. Foundations use retaining walls on exaggerated
slopes. There is one existing near-field shadow map, rather than cascaded
shadows for the entire landscape. The application bundle still emits Vite's
existing large-chunk warning.

The available browser uses ANGLE/SwiftShader, a CPU software renderer. Its frame
times must not be presented as desktop GPU results or evidence of 60 FPS. Added
geometric/texture detail increases raster cost even when draw calls decrease.
A desktop GPU frame-budget check remains necessary before asserting a target
frame rate.


## Grass scrolling follow-up

The grass instance updates originally changed only X and Y for road bends and
crests. Their Z positions stayed fixed while houses and hay rolls advanced,
so the blades remained static relative to the moving bike. Grass now advances
by the same travelled world distance as the roadside props, wraps within its
90-unit verge strip, and samples the rendered terrain again at each new root.
Blade shape, density, colors and wind strength are unchanged.

Validation of this correction:

- Production build and **12/12** targeted environment/road-grade tests pass.
  Two new tests cover scrolling/recycling at prop speed, stop behavior, and
  root contact/road clearance on ±12% slopes and bends after long rides.
- `node scripts/check-grass-scroll.cjs`: **75/75** production-renderer views
  (five stages × five cameras × -12%, 0%, +12%). Camera and wind time are
  frozen and only the actual grass is drawn for the pixel comparison. Every
  view shows grass movement; all 6,000 roots advance at the same rate as a
  house and match the shared terrain sampler. Grass remains **2 draw calls /
  54,000 triangles**, with no browser/shader errors. Results are stored in
  `grass-scroll-browser-results.json`.
- Warmed stage-1 terrain/prop CPU updates: median **3.9 ms**,
  p95 **5.6 ms**, 30 samples after 10 warm-up updates. This is
  CPU update cost only, not a new whole-scene GPU frame-rate measurement.
- `grass-scroll-start.png` and `grass-scroll-forward.png` show the full running
  production renderer at the same fixed Roadside camera and wind time,
  separated by half a second of world travel at a displayed 25 km/h.

The original full-suite counts and performance table above describe the
initial overhaul. The user has since run that branch locally and reports
acceptable performance; local GPU FPS has not been instrumented here.


## Grass surface scrolling follow-up

The blade correction above left the terrain's UVs and broad vertex colors
fixed in the stationary ribbon mesh. The painted grass surface therefore
stayed fixed while blades and props passed the camera. Surface UVs now sample
road-local Z minus travelled distance, and the grass's broad color variation
uses the same moving world coordinate. Asphalt and gravel shoulders also
scroll at prop speed. Independent repeating phases preserve precision on
long rides; shared texture offsets stay unchanged, so blades and distant
mountains keep their own mappings. No geometry, materials or draw calls were
added, and existing resource ownership/cleanup is unchanged.

Validation of the surface correction:

- Production build and **14/14** targeted environment/road-grade tests pass.
  The two additional tests isolate texture/color movement from wind, check
  stops and resets, and cover texture repeats, five stage palettes, steep
  grades, long rides and unchanged shared map offsets.
- `node scripts/check-terrain-scroll.cjs`: **75/75** production-renderer views
  (five stages × five cameras × -12%, 0%, +12%). Only the painted grass terrain is drawn; camera, wind time, vertex positions and normals are
  frozen during each pixel comparison. Texture phase is checked on every
  surface vertex. All views change, with at least **8,517** changed grass
  pixels per frame. The grass terrain remains **2 draw calls / 12,000 triangles**,
  with no browser errors. Results are in `terrain-scroll-browser-results.json`.
- Warmed terrain/prop CPU updates: median **8.4 ms**, p95 **14.0 ms**,
  30 samples after 10 warm-up updates in this browser environment. This is
  CPU update time, not whole-scene FPS or a same-session comparison against
  the earlier 3.9 ms sample. No new hardware GPU measurement is available.
- `terrain-scroll-start.png` and `terrain-scroll-forward.png` show the full
  running production renderer at the same fixed Roadside camera and wind
  time, separated by half a second of world travel at a displayed 25 km/h.

These follow-up checks supplement the original whole-scene performance,
application-stage and resource-disposal checks above.
