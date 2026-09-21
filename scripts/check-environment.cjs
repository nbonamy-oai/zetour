// Requires Playwright (npm install --no-save playwright) and Chromium.
// Runs the actual ThreeRide class compiled in production mode; controls below
// touch private state only in this test harness, with no shipped debug hooks.
const { chromium } = require('playwright');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const { build } = await import('vite');
  const root = process.cwd();
  const baseline=process.env.ENVIRONMENT_BASELINE === "1";
  const sourceRoot=baseline ? "/tmp/zetour-baseline" : root;
  const buildDir = '/tmp/zetour-environment-browser';
  await build({ configFile: false, root:sourceRoot, logLevel: 'warn', build: {
    outDir: buildDir, emptyOutDir: true, target: 'es2022',
    lib: { entry: resolve(sourceRoot, 'scripts/environment-harness.ts'), formats: ['es'], fileName: () => 'environment-qa.js' },
  }});
  const server = createServer(async (request, response) => {
    if (request.url === '/favicon.ico') {response.statusCode=204;response.end();return;}
    if (request.url === '/') { response.end('<html><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="game" style="width:960px;height:600px"></div></body></html>'); return; }
    try { const path = join(buildDir, request.url.split('?')[0]); response.setHeader('Content-Type',path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); response.end(await readFile(path)); }
    catch { response.statusCode=404; response.end(); }
  });
  await new Promise(resolve => server.listen(5180,'127.0.0.1',resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  process.once("SIGINT",async()=>{await browser.close();server.close();process.exit(130);});
  const results = [], errors=[];
  const page = await browser.newPage({ viewport: { width:960,height:600 },deviceScaleFactor:1 });
  page.on('pageerror',error => errors.push(error.message));
  page.on('console',message => { if(message.type()==='error') {errors.push(message.text());console.error(message.text().slice(0,1200));} });
  await page.goto('http://127.0.0.1:5180/');
  await page.evaluate(async () => {
    const module=await import('/environment-qa.js'); window.environmentModule=module;
    const ride=new module.ThreeRide(document.querySelector('#game'),{onAnnouncement(){},onCameraChange(){},onFlowChange(){}});
    ride.setPaused(true); cancelAnimationFrame(ride.animationFrame); window.ride=ride;
  });
  for (let stage=1;stage<=5;stage++) {
    console.log(`Checking stage ${stage}...`);
    const result = await page.evaluate(async stage => {
      const {ride,environmentModule:module}=window;
      ride.updateStage(module.stages[stage-1]);
      const views=[];
      for (const grade of [-0.12,0,0.12]) {
        ride.roadPitch=module.threeRoadPitch(grade); ride.applyGrade();
        for(let camera=0;camera<5;camera++) {
          ride.cameraModeIndex=camera;
          // A large render delta settles the camera without waiting for the
          // software GPU's frame rate. Game frame delta remains unchanged.
          ride.landscape.update(ride.travelled,10); ride.updateRoadMotion(0,0); ride.render(10);
          const pixels=new Uint8Array(4);const gl=ride.renderer.getContext();gl.readPixels(480,300,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
          const local=ride.roadWorld.worldToLocal(ride.camera.position.clone());
          const cameraTerrainClearance=module.terrainHeight ? local.y-module.terrainHeight(local.x-module.roadBend(local.z,ride.travelled),local.z)-module.roadSurfaceHeight(local.z,ride.roadPitch) : null;
          views.push({grade,camera,cameraTerrainClearance,calls:ride.renderer.info.render.calls,triangles:ride.renderer.info.render.triangles,pixel:[...pixels]});
        }
      }
      ride.roadPitch=0;ride.applyGrade();ride.cameraModeIndex=0;
      ride.landscape.update(ride.travelled,0);ride.updateRoadMotion(0,0);ride.render(10);
      const frameTimes=[],cpuTimes=[];
      for(let i=0;i<23;i++) {
        const start=performance.now();
        // Exercise the terrain/prop updates at 48.6km/h, then draw and allow
        // presentation. Include CPU updates as well as the software GPU.
        ride.travelled+=13.5/60;
        const cpuStart=performance.now();ride.landscape.update(ride.travelled,i/60);ride.updateRoadMotion(13.5,1/60);const cpu=performance.now()-cpuStart;
        ride.render(1/60);await new Promise(requestAnimationFrame);
        if(i>=8){frameTimes.push(performance.now()-start);cpuTimes.push(cpu);}
      }
      frameTimes.sort((a,b)=>a-b);cpuTimes.sort((a,b)=>a-b);
      const r=ride.renderer,gl=r.getContext();
      return {stage,views,medianMs:frameTimes[7],p95Ms:frameTimes[14],cpuMedianMs:cpuTimes[7],calls:r.info.render.calls,triangles:r.info.render.triangles,geometries:r.info.memory.geometries,textures:r.info.memory.textures,gpu:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)};
    },stage);
    assert.equal(result.views.length,15);assert(result.views.every(v=>v.pixel[3]>0 && v.pixel.slice(0,3).some(channel=>channel>0)),'Blank canvas');
    if(!baseline) assert(result.views.every(view=>view.cameraTerrainClearance>0.15),'Camera entered the terrain');
    results.push(result);console.log(JSON.stringify({...result,views:`${result.views.length} stage/grade/camera combinations`}));
    await page.screenshot({path:resolve(root,`docs/environment/${baseline ? "before" : "after"}/stage-${stage}.png`)});
  }
  // Repeatedly change stages in the same renderer to detect resource growth.
  const lifecycle=await page.evaluate(() => {
    const {ride,environmentModule:module}=window;
    const counts=[];
    for(let cycle=0;cycle<3;cycle++) {
      for(const stage of module.stages) {ride.updateStage(stage);ride.landscape.update(ride.travelled);ride.updateRoadMotion(0,0);ride.render(10);}
      counts.push({...ride.renderer.info.memory});
    }
    const textureSet=new Set();ride.scene.traverse(mesh=>{if(mesh.material) for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]) if(material.map) textureSet.add(material.map);});
    if(ride.environmentMaterials) ride.environmentMaterials.textures.forEach(texture=>textureSet.add(texture));
    let textureDisposals=0;textureSet.forEach(texture=>texture.addEventListener('dispose',()=>textureDisposals++));
    ride.dispose();ride.dispose();
    return {counts,textureCount:textureSet.size,textureDisposals,canvases:document.querySelectorAll('canvas').length};
  });
  assert.deepEqual(lifecycle.counts[0],lifecycle.counts[2],'GPU resource growth between stage cycles');
  assert.equal(lifecycle.canvases,0);if(!baseline) assert.equal(lifecycle.textureCount,lifecycle.textureDisposals,'Undisposed textures');
  assert.deepEqual(errors,[]);
  await mkdir(resolve(root,'docs/environment'),{recursive:true});
  await writeFile(resolve(root,`docs/environment/${baseline ? 'baseline' : 'production'}-browser-results.json`),JSON.stringify({viewport:[960,600],dpr:1,speedKmh:48.6,camera:'Chase',warmupFrames:8,sampleFrames:15,results,lifecycle,errors},null,2)+'\n');
  await browser.close();await new Promise(resolve=>server.close(resolve));
  console.log('PASS: 75 views, repeated stage transitions, teardown, no browser/shader errors.');
})().catch(error=>{console.error(error);process.exit(1)});
