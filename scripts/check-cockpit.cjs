// Comparable before/after captures and first-person pose/resource checks.
const {chromium}=require('playwright');
const {createServer}=require('node:http');
const {readFile,mkdir,writeFile}=require('node:fs/promises');
const {execFileSync}=require('node:child_process');
const {resolve}=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
 const {build}=await import('vite');
 const root=process.cwd(),outDir='/tmp/zetour-cockpit';
 const oldRide=execFileSync('git',['show','8058c6b4fe0b4642f0bb0fe23a044c4be9952502:src/game/ThreeRide.ts'],{encoding:'utf8'});
 for(const phase of ['before','after'])await build({configFile:false,root,logLevel:'warn',plugins:phase==='before'?[{name:'original-cockpit',enforce:'pre',transform(code,id){if(id===resolve(root,'src/game/ThreeRide.ts'))return oldRide;}}]:[],build:{outDir,emptyOutDir:phase==='before',target:'es2022',lib:{entry:resolve(root,'scripts/environment-harness.ts'),formats:['es'],fileName:()=>`${phase}.js`}}});
 const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.end('<html><head><link rel="icon" href="data:,"></head><body style="margin:0"><div id="game" style="width:100vw;height:100vh"></div></body></html>');return;}
  if(['/before.js','/after.js'].includes(req.url)){res.setHeader('Content-Type','text/javascript');res.end(await readFile(resolve(outDir,req.url.slice(1))));return;}
  res.statusCode=404;res.end();
 });
 await new Promise(done=>server.listen(5183,'127.0.0.1',done));
 let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const errors=[],results=[],captures=[],cost=[];
  await mkdir(resolve(root,'docs/environment'),{recursive:true});
  for(const phase of ['before','after']){
   const page=await browser.newPage({viewport:{width:1440,height:810},deviceScaleFactor:1});
   page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
   await page.goto('http://127.0.0.1:5183/');
   await page.evaluate(async phase=>{
    const m=await import(`/${phase}.js`);window.qa=m;
    const ride=new m.ThreeRide(document.querySelector('#game'),{onAnnouncement(){},onCameraChange(){},onFlowChange(){}});
    ride.setPaused(true);cancelAnimationFrame(ride.animationFrame);window.ride=ride;
    ride.cameraModeIndex=1;ride.visualSpeed=25;ride.roadPitch=0;ride.applyGrade();ride.travelled=0;
    ride.landscape.update(0,2);ride.updateRoadMotion(0,0);ride.render(10);
   },phase);
   await page.screenshot({path:resolve(root,`docs/environment/cockpit-${phase}.png`)});
   captures.push({phase,viewport:[1440,810],stage:1,grade:0,travel:0,windSeconds:2});
   cost.push(await page.evaluate(phase=>{
    const {ride}=window;ride.scene.traverse(object=>{if(object.isMesh)object.visible=false;});
    ride.cockpit.traverse(object=>{if(object.isMesh)object.visible=true;});ride.renderer.shadowMap.enabled=false;
    ride.renderer.render(ride.scene,ride.camera);
    return {phase,drawCalls:ride.renderer.info.render.calls,triangles:ride.renderer.info.render.triangles};
   },phase));
   if(phase==='after'){
    // Pose remains camera-relative on every stage and both steep grade signs.
    for(const viewport of [{width:1440,height:810},{width:1920,height:810},{width:810,height:1080}]){
     await page.setViewportSize(viewport);
     const checks=await page.evaluate(viewport=>{
      const {ride,qa:m}=window,checks=[];
      ride.renderer.setSize(viewport.width,viewport.height,false);ride.camera.aspect=viewport.width/viewport.height;
      ride.camera.updateProjectionMatrix();
      for(let stage=1;stage<=5;stage++)for(const grade of [-0.12,0,0.12]){
       ride.updateStage(m.stages[stage-1]);ride.roadPitch=m.threeRoadPitch(grade);ride.applyGrade();
       ride.scene.traverse(object=>{if(object.isMesh)object.visible=false;});
       ride.cockpit.traverse(object=>{if(object.isMesh)object.visible=true;});
       ride.landscape.update(0,2);ride.updateRoadMotion(0,0);ride.render(10);ride.scene.updateMatrixWorld(true);
       const grips=ride.cockpit.userData.grips.map(point=>point.clone().applyMatrix4(ride.cockpit.matrixWorld).project(ride.camera).toArray());
       const gl=ride.renderer.getContext(),pixels=new Uint8Array(viewport.width*viewport.height*4);
       gl.readPixels(0,0,viewport.width,viewport.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
       let coloredPixels=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]+pixels[i+1]+pixels[i+2]>30)coloredPixels++;
       checks.push({stage,grade,viewport,grips,visible:ride.cockpit.visible,riderVisible:ride.rider.visible,coloredPixels});
      }
      return checks;
     },viewport);
     for(const check of checks){assert(check.visible);assert(!check.riderVisible);assert(check.grips[0][0]<0&&check.grips[1][0]>0);for(const grip of check.grips){assert(Math.abs(grip[0])<0.95);assert(grip[1]>-0.95&&grip[1]<0.1);assert(grip[2]>-1&&grip[2]<1);}assert(check.coloredPixels>1000);}
     results.push(...checks);console.log(`PASS: 15 first-person stage/slope views at ${viewport.width} × ${viewport.height}`);
    }
    const cleanup=await page.evaluate(()=>{
     const {ride}=window;let visibleInOtherCameras=0;
     for(const index of [0,2,3,4]){ride.cameraModeIndex=index;ride.render(10);if(ride.cockpit.visible)visibleInOtherCameras++;}
     const resources=new Set();ride.cockpit.traverse(object=>{if(object.isMesh){resources.add(object.geometry);(Array.isArray(object.material)?object.material:[object.material]).forEach(m=>resources.add(m));}});
     ride.cockpit.userData.ownedTextures.forEach(texture=>resources.add(texture));
     const counts=[];resources.forEach(resource=>{const entry={kind:resource.isTexture?'texture':resource.isMaterial?'material':'geometry',count:0};resource.addEventListener('dispose',()=>entry.count++);counts.push(entry);});
     ride.dispose();ride.dispose();return {visibleInOtherCameras,counts,remainingCanvases:document.querySelectorAll('canvas').length};
    });
    assert.equal(cleanup.visibleInOtherCameras,0);assert.equal(cleanup.remainingCanvases,0);cleanup.counts.forEach(entry=>assert.equal(entry.count,1));
    results.push({cleanup});
   }else await page.evaluate(()=>window.ride.dispose());
   await page.close();
  }
  assert.deepEqual(errors,[]);assert(cost[1].drawCalls<cost[0].drawCalls);
  await writeFile(resolve(root,'docs/environment/cockpit-browser-results.json'),JSON.stringify({captures,cost,results,errors},null,2)+'\n');
  console.log('PASS: comparable captures, 45 stage/slope/aspect views, other camera visibility and exact-once disposal.',cost);
 }finally{if(browser)await browser.close();await new Promise(done=>server.close(done));}
})().catch(error=>{console.error(error);process.exitCode=1;});
