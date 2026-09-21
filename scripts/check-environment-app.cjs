const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});process.once('SIGINT',async()=>{await b.close();process.exit(130);});const all=[];
for(let stage=1;stage<=5;stage++){
 const context=await b.newContext({viewport:{width:960,height:800}});const p=await context.newPage();const errors=[],failures=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});p.on('response',r=>{if(r.status()>=400)failures.push(r.status()+' '+r.url())});
 const lengths=[800,1050,1050,1250,1800],progress=[0,0.65,1/3,0.2,0.625];
 await p.addInitScript(({stage,distance})=>localStorage.setItem('biker-inc-save-v1',JSON.stringify({version:4,stage,highestStage:stage,stageDistanceM:distance,lastSavedAt:Date.now()})),{stage,distance:lengths[stage-1]*progress[stage-1]});
 await p.goto('http://127.0.0.1:5175/');await p.locator('.mode-card-3d').click({force:true});await p.locator('.game-canvas-3d canvas').waitFor();await p.keyboard.press('p');
 const cameras=[];for(let i=0;i<5;i++){cameras.push(await p.locator('.three-camera-control').innerText());await p.locator('.three-camera-control').click({force:true});await p.evaluate(async()=>{for(let j=0;j<3;j++)await new Promise(requestAnimationFrame)});}
 assert.equal(new Set(cameras).size,5);
 const sector=await p.locator('.hud-tour-meta').textContent();assert.match(sector,new RegExp('Sector\\s*'+stage+'\\s*/'));
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);const slope=await p.locator('.hud-speed-copy').innerText();all.push({stage,sector:sector.trim(),cameras,slope,errors,failures});console.log(JSON.stringify(all.at(-1)));await context.close();}
require('fs').writeFileSync(require('node:path').resolve(process.cwd(),'docs/environment/production-app-results.json'),JSON.stringify(all,null,2)+'\n');await b.close();})().catch(e=>{console.error(e);process.exit(1)});
