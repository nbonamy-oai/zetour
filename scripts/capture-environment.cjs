const {chromium}=require('playwright');
const {resolve}=require('node:path');
const {mkdirSync}=require('node:fs');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 process.once("SIGINT",async()=>{await browser.close();process.exit(130);});
 const phase=process.argv[2]||"after";
 mkdirSync(resolve(process.cwd(),`docs/environment/${phase}`),{recursive:true});
 const shots=[['grass-road',1,0,0],['trees-hay',1,0,3],['sky-mountains',5,0,1],['houses-uphill',3,0.12,2],['houses-downhill',3,-0.12,2]];
 for(const [name,stage,grade,camera] of shots.filter(shot=>!process.env.ENVIRONMENT_SHOTS||process.env.ENVIRONMENT_SHOTS.split(",").includes(shot[0]))){
  const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error') console.log(m.text().slice(0,1500))});
  await page.goto(`http://127.0.0.1:${process.env.ENVIRONMENT_PORT || (phase === "before" ? 5174 : 5173)}/?qaFresh=1&qaStage=${stage}&qaGradient=${grade}&qaSpeed=0`);
  await page.locator('.mode-card-3d').click({force:true});await page.locator('.game-canvas-3d canvas').waitFor();
  for(let i=0;i<camera;i++) await page.locator('.three-camera-control').click({force:true});
  await page.evaluate((name)=>{
    const ride=document.querySelector('.game-canvas-3d').__vueParentComponent.setupState.ride;
    if(!ride)throw new Error('The development game instance is unavailable');
    ride.setPaused(true);cancelAnimationFrame(ride.animationFrame);ride.elapsedMs=2000;ride.travelled=0;
    ride.landscape.update(0,2);ride.updateRoadMotion(0,0);ride.render(10);
    if(name.startsWith('houses-')) {
      // Matching fixed inspection camera: look inward from the outer verge.
      // It shows the foundation instead of hiding distant houses behind a crest.
      const Vector=ride.camera.position.constructor;
      const target=ride.roadWorld.localToWorld(new Vector(-18,2,-12));target.y+=1.3;
      ride.camera.position.copy(target).add(new Vector(-16,5,12));
      ride.camera.lookAt(target);ride.camera.fov=50;ride.camera.updateProjectionMatrix();
      ride.renderer.render(ride.scene,ride.camera);
    }
  },name);
  await page.screenshot({clip:await page.locator('.game-canvas-3d').boundingBox(),path:resolve(process.cwd(),`docs/environment/${phase}/${name}.png`)});
  console.log(name,errors);await page.close();
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
