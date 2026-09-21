// Production renderer regression check: grass must pass the camera with props.
// Requires Playwright and Chromium; run from the repository root.
const {chromium}=require('playwright');
const {createServer}=require('node:http');
const {readFile,mkdir,writeFile}=require('node:fs/promises');
const {resolve}=require('node:path');
const assert=require('node:assert/strict');

(async()=>{
 const {build}=await import('vite');
 const root=process.cwd(),outDir='/tmp/zetour-grass-scroll';
 await build({configFile:false,root,logLevel:'warn',build:{outDir,emptyOutDir:true,target:'es2022',lib:{entry:resolve(root,'scripts/environment-harness.ts'),formats:['es'],fileName:()=> 'game.js'}}});
 const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.end('<html><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="game" style="width:960px;height:600px"></div></body></html>');return;}
  if(req.url==='/game.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(resolve(outDir,'game.js')));return;}
  res.statusCode=404;res.end();
 });
 await new Promise(done=>server.listen(5181,'127.0.0.1',done));
 let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  process.once('SIGINT',async()=>{await browser.close();server.close();process.exit(130);});
  const page=await browser.newPage({viewport:{width:960,height:600},deviceScaleFactor:1});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto('http://127.0.0.1:5181/');
  await page.evaluate(async()=>{
   const m=await import('/game.js');window.qaModule=m;
   const ride=new m.ThreeRide(document.querySelector('#game'),{onAnnouncement(){},onCameraChange(){},onFlowChange(){}});
   ride.setPaused(true);cancelAnimationFrame(ride.animationFrame);window.ride=ride;
   window.meshVisibility=new WeakMap();
   ride.scene.traverse(object=>{
    if(object.isMesh){window.meshVisibility.set(object,object.visible);object.visible=object.name==='Wind-driven roadside blades';}
   });
   ride.renderer.shadowMap.enabled=false;
  });
  const results=[];
  for(let stage=1;stage<=5;stage++){
   const checks=await page.evaluate(stage=>{
    const {ride,qaModule:m}=window;
    ride.updateStage(m.stages[stage-1]);
    ride.scene.traverse(object=>{if(object.isMesh){if(!window.meshVisibility.has(object))window.meshVisibility.set(object,object.visible);object.visible=object.name==='Wind-driven roadside blades';}});
    const grass=[];ride.scene.traverse(object=>{if(object.name==='Wind-driven roadside blades')grass.push(object);});
    const house=ride.movingScenery.find(object=>object.userData.foundation);
    const gl=ride.renderer.getContext(),checks=[];
    const read=()=>{const pixels=new Uint8Array(960*600*4);gl.readPixels(0,0,960,600,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
    for(const grade of [-0.12,0,0.12])for(let camera=0;camera<5;camera++){
     ride.roadPitch=m.threeRoadPitch(grade);ride.applyGrade();ride.cameraModeIndex=camera;
     const distance=ride.travelled;
     ride.landscape.update(distance,2);ride.updateRoadMotion(0,0);ride.render(10);
     const before=read(),roots=grass.map(mesh=>mesh.instanceMatrix.array.slice()),houseZ=house.position.z;
     const advance=13.5/60;ride.travelled+=advance;
     ride.landscape.update(ride.travelled,2);ride.updateRoadMotion(13.5,1/60);
     // Hold camera and wind time fixed. Only grass is drawn, so changes
     // cannot be attributed to clouds, camera motion, houses or the bike.
     ride.renderer.render(ride.scene,ride.camera);const after=read();
     let changedPixels=0,matchingRoots=0,maxHeightError=0;
     for(let i=0;i<before.length;i+=4){if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])>8)changedPixels++;}
     grass.forEach((mesh,side)=>{
      const matrices=mesh.instanceMatrix.array;
      for(let i=0;i<mesh.count;i++){
       const z=matrices[i*16+14],previousZ=roots[side][i*16+14];
       const delta=z-previousZ;
       if(Math.min(Math.abs(delta-advance),Math.abs(delta-advance+90))<0.0001)matchingRoots++;
       const x=matrices[i*16+12]-m.roadBend(z,ride.travelled);
       maxHeightError=Math.max(maxHeightError,Math.abs(matrices[i*16+13]-m.terrainHeight(x,z)-m.roadSurfaceHeight(z,ride.roadPitch)));
      }
     });
     checks.push({stage,grade,camera,changedPixels,matchingRoots,houseAdvance:house.position.z-houseZ,maxHeightError,grassDrawCalls:ride.renderer.info.render.calls,grassTriangles:ride.renderer.info.render.triangles});
    }
    return checks;
   },stage);
   for(const check of checks){assert.equal(check.matchingRoots,6000);assert(Math.abs(check.houseAdvance-13.5/60)<0.0001);assert(check.maxHeightError<0.0001);assert(check.changedPixels>20,`Grass stayed static in ${JSON.stringify(check)}`);assert.equal(check.grassDrawCalls,2);assert.equal(check.grassTriangles,54000);}
   results.push(...checks);console.log(`Stage ${stage}: 15 views passed; minimum ${Math.min(...checks.map(x=>x.changedPixels))} changed grass pixels.`);
  }
  // Restore the full game for comparable screenshots at the same fixed
  // roadside camera, with a half-second of world travel between images.
  await page.evaluate(()=>{
   const {ride,qaModule:m}=window;ride.updateStage(m.stages[0]);
   ride.scene.traverse(object=>{if(object.isMesh)object.visible=window.meshVisibility.get(object)??object.visible;});
   ride.renderer.shadowMap.enabled=true;ride.cameraModeIndex=3;ride.roadPitch=0;ride.applyGrade();ride.travelled=0;
   ride.landscape.update(0,2);ride.updateRoadMotion(0,0);ride.render(10);
  });
  await mkdir(resolve(root,'docs/environment'),{recursive:true});
  await page.screenshot({path:resolve(root,'docs/environment/grass-scroll-start.png')});
  await page.evaluate(()=>{const {ride}=window;ride.travelled=6.75;ride.landscape.update(6.75,2);ride.updateRoadMotion(13.5,0.5);ride.renderer.render(ride.scene,ride.camera);});
  await page.screenshot({path:resolve(root,'docs/environment/grass-scroll-forward.png')});
  const cpu=await page.evaluate(()=>{
   const {ride}=window,times=[];
   for(let i=0;i<40;i++){ride.travelled+=13.5/60;const start=performance.now();ride.landscape.update(ride.travelled,2);ride.updateRoadMotion(13.5,1/60);if(i>=10)times.push(performance.now()-start);}
   times.sort((a,b)=>a-b);ride.dispose();return {medianMs:times[15],p95Ms:times[28]};
  });
  assert.deepEqual(errors,[]);
  await writeFile(resolve(root,'docs/environment/grass-scroll-browser-results.json'),JSON.stringify({viewport:[960,600],fixedWindSeconds:2,speedKmh:25,worldSpeed:13.5,advancePerFrame:13.5/60,results,cpu,errors},null,2)+'\n');
  console.log('PASS: 75 views, grass and houses advance together, roots remain grounded, unchanged grass draw/triangle counts, no browser errors.',cpu);
 }finally{
  if(browser)await browser.close();await new Promise(done=>server.close(done));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
