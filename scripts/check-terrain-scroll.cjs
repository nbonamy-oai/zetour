// Production renderer regression check: terrain textures must scroll even with geometry and camera frozen.
// Requires Playwright and Chromium; run from the repository root.
const {chromium}=require('playwright');
const {createServer}=require('node:http');
const {readFile,mkdir,writeFile}=require('node:fs/promises');
const {resolve}=require('node:path');
const assert=require('node:assert/strict');

(async()=>{
 const {build}=await import('vite');
 const root=process.cwd(),outDir='/tmp/zetour-terrain-scroll';
 await build({configFile:false,root,logLevel:'warn',build:{outDir,emptyOutDir:true,target:'es2022',lib:{entry:resolve(root,'scripts/environment-harness.ts'),formats:['es'],fileName:()=> 'game.js'}}});
 const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.end('<html><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="game" style="width:960px;height:600px"></div></body></html>');return;}
  if(req.url==='/game.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(resolve(outDir,'game.js')));return;}
  res.statusCode=404;res.end();
 });
 await new Promise(done=>server.listen(5182,'127.0.0.1',done));
 let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  process.once('SIGINT',async()=>{await browser.close();server.close();process.exit(130);});
  const page=await browser.newPage({viewport:{width:960,height:600},deviceScaleFactor:1});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto('http://127.0.0.1:5182/');
  await page.evaluate(async()=>{
   const m=await import('/game.js');window.qaModule=m;
   const ride=new m.ThreeRide(document.querySelector('#game'),{onAnnouncement(){},onCameraChange(){},onFlowChange(){}});
   ride.setPaused(true);cancelAnimationFrame(ride.animationFrame);window.ride=ride;
   window.meshVisibility=new WeakMap();
   ride.scene.traverse(object=>{
    if(object.isMesh){window.meshVisibility.set(object,object.visible);object.visible=object.name==='Rolling terrain';}
   });
   ride.renderer.shadowMap.enabled=false;
  });
  const results=[];
  for(let stage=1;stage<=5;stage++){
   const checks=await page.evaluate(stage=>{
    const {ride,qaModule:m}=window;
    ride.updateStage(m.stages[stage-1]);
    ride.scene.traverse(object=>{if(object.isMesh){if(!window.meshVisibility.has(object))window.meshVisibility.set(object,object.visible);object.visible=object.name==='Rolling terrain';}});
    const surfaces=[];ride.scene.traverse(object=>{if(['Rolling terrain','Road surface','Gravel shoulder'].includes(object.name))surfaces.push(object);});
    const gl=ride.renderer.getContext(),checks=[];
    const read=()=>{const pixels=new Uint8Array(960*600*4);gl.readPixels(0,0,960,600,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
    for(const grade of [-0.12,0,0.12])for(let camera=0;camera<5;camera++){
     ride.roadPitch=m.threeRoadPitch(grade);ride.applyGrade();ride.cameraModeIndex=camera;
     ride.landscape.update(ride.travelled,2);ride.updateRoadMotion(0,0);ride.render(10);
     const before=read(),states=surfaces.map(mesh=>({position:mesh.geometry.attributes.position.array.slice(),normal:mesh.geometry.attributes.normal.array.slice(),uv:mesh.geometry.attributes.uv.array.slice()}));
     const advance=13.5/60, distanceBefore=ride.travelled;ride.travelled+=advance;
     ride.landscape.update(ride.travelled,2);
     let maxPhaseError=0;
     surfaces.forEach((mesh,index)=>{
      const geometry=mesh.geometry,scale=mesh.name==='Rolling terrain'?0.65:1.1;
      const phase=distance=>((distance*scale)%1+1)%1;
      for(let i=0;i<geometry.attributes.uv.count;i++)maxPhaseError=Math.max(maxPhaseError,Math.abs(geometry.attributes.uv.getY(i)-states[index].uv[i*2+1]+phase(ride.travelled)-phase(distanceBefore)));
      // Freeze every drawn vertex and its normal too: the only possible
      // movement in this pixel comparison is surface UV/color transport.
      geometry.attributes.position.array.set(states[index].position);geometry.attributes.position.needsUpdate=true;
      geometry.attributes.normal.array.set(states[index].normal);geometry.attributes.normal.needsUpdate=true;
     });
     ride.renderer.render(ride.scene,ride.camera);const after=read();
     let changedPixels=0;
     for(let i=0;i<before.length;i+=4){if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])>8)changedPixels++;}
     checks.push({stage,grade,camera,changedPixels,maxPhaseError,terrainDrawCalls:ride.renderer.info.render.calls,terrainTriangles:ride.renderer.info.render.triangles});
    }
    return checks;
   },stage);
   for(const check of checks){assert(check.maxPhaseError<0.00004);assert(check.changedPixels>20,`Surface stayed static in ${JSON.stringify(check)}`);assert.equal(check.terrainDrawCalls,2);assert.equal(check.terrainTriangles,12000);}
   results.push(...checks);console.log(`Stage ${stage}: 15 views passed; minimum ${Math.min(...checks.map(x=>x.changedPixels))} changed grass surface pixels.`);
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
  await page.screenshot({path:resolve(root,'docs/environment/terrain-scroll-start.png')});
  await page.evaluate(()=>{const {ride}=window;ride.travelled=6.75;ride.landscape.update(6.75,2);ride.updateRoadMotion(13.5,0.5);ride.renderer.render(ride.scene,ride.camera);});
  await page.screenshot({path:resolve(root,'docs/environment/terrain-scroll-forward.png')});
  const cpu=await page.evaluate(()=>{
   const {ride}=window,times=[];
   for(let i=0;i<40;i++){ride.travelled+=13.5/60;const start=performance.now();ride.landscape.update(ride.travelled,2);ride.updateRoadMotion(13.5,1/60);if(i>=10)times.push(performance.now()-start);}
   times.sort((a,b)=>a-b);ride.dispose();return {medianMs:times[15],p95Ms:times[28]};
  });
  assert.deepEqual(errors,[]);
  await writeFile(resolve(root,'docs/environment/terrain-scroll-browser-results.json'),JSON.stringify({viewport:[960,600],fixedWindSeconds:2,speedKmh:25,worldSpeed:13.5,advancePerFrame:13.5/60,results,cpu,errors},null,2)+'\n');
  console.log('PASS: 75 views, textures scroll with fixed geometry, camera and wind; no additional draws or browser errors.',cpu);
 }finally{
  if(browser)await browser.close();await new Promise(done=>server.close(done));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
