// 用户页外壳：路由、Landing、上传（提示 → 选视频 → 识别 → 失败）。hash 路由：#/页面[/参数]。
// 识别完成后才加载引擎（engine.js）、viz.js、player.js（播放页 + 分享页）。
// 引擎是普通脚本、顶层 const 只能声明一次，所以一页只处理一段视频；换视频时把文件先存进 IndexedDB 再刷新页面接着处理。
const App=(()=>{
const $=id=>document.getElementById(id);
const INK='#141418';
const views={'':$('v-home'),upload:$('v-upload'),process:$('v-process'),fail:$('v-fail'),play:$('v-play'),share:$('v-share')};
const A={route:null,booted:false,onRoute:null,toast,fillTo};

function go(){
  const [want,arg]=location.hash.replace(/^#\/?/,'').split('/');
  let next=views[want]?want:'';
  if((next==='play'||next==='share')&&!A.booted){location.replace('#/');return}   // 还没有识别结果
  const prev=A.route;A.route=next;
  for(const k in views)views[k].hidden=k!==next;
  if(next!=='process')job.abort=true;
  if(next==='fail')showFail(arg);
  if(A.onRoute)A.onRoute(next,prev);
  window.scrollTo(0,0);
}
window.addEventListener('hashchange',go);

function fillTo(el,p){const w=el.parentNode.clientWidth;el.style.width=Math.round(w*Math.max(0,Math.min(1,p))/10)*10+'px'}
let toastT=0;
function toast(s){const el=$('toast');el.textContent=s;el.classList.add('on');clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove('on'),2400)}

/* ---- Landing：静态封面，不出声；“拍一段”先禁用 ---- */
Dots.render($('homeClock'),'00:16',4,INK);

/* ---- 上传：提示 → 从相册选 → 校验 ---- */
// 视频只在本地处理：只用 object URL；网络请求只有识别模型和库（CDN），不带任何用户数据
document.querySelectorAll('.tips canvas[data-dot]').forEach(c=>Dots.render(c,c.dataset.dot,4,INK));
let userURL=null;
const pick=()=>{$('file').value='';$('file').click()};
$('pick').onclick=pick;$('failRetry').onclick=pick;
$('file').addEventListener('change',()=>{const f=$('file').files[0];if(f)takeFile(f)});
function takeFile(f){
  if(userURL)URL.revokeObjectURL(userURL);
  userURL=URL.createObjectURL(f);
  // 校验：能不能打开、时长、横竖屏
  // iOS 不一定主动加载元数据：主动 load()，静音 play() 一下催它，10 秒没反应就当打不开
  const v=document.createElement('video');v.muted=true;v.playsInline=true;v.preload='metadata';v.src=userURL;v.load();
  v.play().then(()=>v.pause()).catch(()=>{});
  const giveUp=setTimeout(()=>{v.onloadedmetadata=null;location.hash='#/fail/unreadable'},10000);
  v.onerror=()=>{clearTimeout(giveUp);location.hash='#/fail/unreadable'};
  v.onloadedmetadata=async()=>{
    clearTimeout(giveUp);
    if(!isFinite(v.duration)||v.duration<=0)location.hash='#/fail/unreadable';
    else if(v.duration>60.5)location.hash='#/fail/long';
    else if(v.videoWidth>v.videoHeight)location.hash='#/fail/landscape';
    else if(A.booted){await stash(f);location.hash='#/process';location.reload()}   // 已经播过一段：刷新后接着处理
    else run(v.duration);
  };
}

/* ---- 识别（js/pose.js） ---- */
const job={abort:false};
// 诊断：地址加 ?debug=1，处理页显示每一步的耗时和报错（手机上卡住时截图给开发看）
const DEBUG=/[?&]debug=1/.test(location.search);
if(DEBUG){$('procLog').hidden=false;Pose.onLog=l=>{const el=$('procLog');el.textContent+=l+'\n';el.scrollTop=el.scrollHeight};
  window.addEventListener('error',e=>Pose.onLog('页面报错：'+e.message));window.addEventListener('unhandledrejection',e=>Pose.onLog('未处理的报错：'+(e.reason&&e.reason.message||e.reason)))}
const MSG={model:'正在准备识别模型（约 9MB，第一次要下载一会儿）。',
  scan:'逐帧找你的手和脚。视频只在你的手机上处理，不会上传；处理时别切走页面。',
  post:'快好了，在找你抓过的岩点。'};
async function run(dur){
  $('userVid').src=userURL;$('userVid').currentTime=Math.min(0.5,dur/2);
  location.hash='#/process';
  job.abort=false;
  const total=Math.max(2,Math.round(dur*30));
  const count=n=>Dots.render($('procCount'),String(n).padStart(String(total).length,'0')+'/'+total,4,INK);
  count(0);fillTo($('procFill'),0);
  // 看门狗：逐帧识别阶段 40 秒没有任何进展就停（模型下载阶段 pose.js 自己有 90 秒超时）
  let last=Date.now(),stage='model',stuck=false;
  const dog=setInterval(()=>{if(stage==='scan'&&Date.now()-last>40000){stuck=true;job.abort=true}},2000);
  let r;
  try{
    r=await Pose.analyze(userURL,{abort:()=>job.abort,
      onStage:s=>{stage=s;last=Date.now();$('procMsg').textContent=MSG[s]},
      onProgress:(n,N)=>{last=Date.now();count(n);fillTo($('procFill'),n/N)}});
  }catch(e){
    clearInterval(dog);
    if(stuck){location.hash='#/fail/stuck';return}
    if(e.message==='abort')return;
    location.hash='#/fail/'+(['unreadable','model','device'].includes(e.message)?e.message:'device');return;
  }
  clearInterval(dog);
  if(job.abort)return;
  // 能不能用（阈值是拍脑袋的，等有更多真实视频再调）
  if(r.stats.seen<0.3){location.hash='#/fail/noperson';return}
  if(r.stats.hidden>0.5){location.hash='#/fail/occluded';return}
  await boot({kp:r.kp,dots:routeDots(r.bg,r.kp),bg:r.bg,crop:r.crop},userURL);
  location.hash='#/play';
}

// 路线岩点：空墙放大到 360×640（route.js 的阈值按这个尺度定的）。
// 颜色样本 = 手抓过的岩点 + 起步时两手的位置（第一帧两手都看得清的时候）
function routeDots(bg,kp){
  const c=document.createElement('canvas');c.width=360;c.height=640;const g=c.getContext('2d',{willReadFrequently:true});
  g.drawImage(bg,0,0,360,640);
  const G=Route.allGrabs(kp),f0=Math.max(0,kp.findIndex(r=>r[8]>=35&&r[11]>=35));
  const start=[2,3].map(j=>{const p=Route.track(kp,j)[f0];return{x:p[0],y:p[1]}});
  const r=Route.routeMask(g.getImageData(0,0,360,640).data,G.Lw.concat(G.Rw,start));
  routeDots.ref=r.ref;
  return Route.routeDots(r.mask);
}

/* ---- 有了数据：加载引擎和播放页 ---- */
const loadScript=src=>new Promise((ok,bad)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>bad(new Error(src));document.body.appendChild(s)});
async function boot(data,url){
  window.CLIMB_DATA=data;                   // engine.js 读 CLIMB_DATA.kp；viz.js 读 .dots；silhouette.js 读 .bg/.crop
  if(url)$('vid').src=url;
  if(data.bg)Sil.setBg(data.bg,data.crop);
  for(const s of ['js/engine.js','js/viz.js','js/player.js'])await loadScript(s);
  A.booted=true;
}

/* ---- 失败：一句话说清楚 + 怎么重拍 ---- */
const FAILS={
  long:['视频有点长','这段超过 60 秒了。剪到 60 秒以内再传，最好从起步剪到 TOP。',['用相册自带的“编辑”就能剪','只留离地到 TOP 的那一段']],
  landscape:['先用竖屏拍','横屏视频暂时还不支持，换一段竖着拍的吧。',['手机竖着放稳','从起步到 TOP 都在画面里']],
  unreadable:['这段视频打不开','可能是格式不支持或者文件损坏，换一段试试。',['用手机相机直接拍的视频最稳妥']],
  noperson:['没看到攀岩者','画面里没找到一个完整的人，可能离得太远，或者只拍到了一部分。',['全身入镜，手和脚都要看得到','离墙远一点，把整条线拍进去','光线别太暗']],
  many:['画面里不止一个人','分不清哪个是你。换一段只有你在爬的视频吧。',['等旁边的人走开再拍','别人挡住你的那几秒，曲子会断掉']],
  occluded:['好几次没看清你的手脚','手或脚被挡住太久，曲子会断断续续。',['机位别对着岩点的背面','别穿和墙一个颜色的衣服']],
  device:['这台设备跑不动识别','浏览器没法在这台设备上运行姿态识别。换个浏览器（比如手机自带的 Safari / Chrome）再试试。',['更新到最新版浏览器','关掉省电模式']],
  stuck:['处理卡住了','这台设备处理这段视频时停住了。可以换一段短一点的视频，或者换个浏览器再试。',['视频剪到 20 秒以内','关掉其他 App 再试','iPhone 上用 Safari 打开']],
  model:['识别模型没下载下来','需要联网下载一次识别模型（约 9MB），之后视频还是只在你的手机上处理。',['检查网络后再试一次','换个网络（比如 Wi-Fi）']]};
function showFail(why){
  const [t,m,tips]=FAILS[why]||FAILS.unreadable;
  $('failTitle').textContent=t;$('failMsg').textContent=m;
  $('failTips').replaceChildren(...tips.map(s=>{const li=document.createElement('li');li.textContent=s;return li}));
  const has=!!userURL&&!['unreadable','model','device','stuck'].includes(why);$('failCard').hidden=!has;
  if(has){$('failVid').src=userURL;$('failVid').currentTime=0.5}
}

/* ---- 换视频时暂存文件（IndexedDB，只在本机） ---- */
function db(){return new Promise((ok,bad)=>{const r=indexedDB.open('climb-sound',1);r.onupgradeneeded=()=>r.result.createObjectStore('pending');r.onsuccess=()=>ok(r.result);r.onerror=()=>bad(r.error)})}
async function stash(f){const d=await db();await new Promise(ok=>{const t=d.transaction('pending','readwrite');t.objectStore('pending').put(f,'file');t.oncomplete=ok})}
async function unstash(){
  try{const d=await db();return await new Promise(ok=>{const t=d.transaction('pending','readwrite'),s=t.objectStore('pending'),q=s.get('file');q.onsuccess=()=>{s.delete('file');ok(q.result||null)};q.onerror=()=>ok(null)})}
  catch(e){return null}
}

/* ---- 启动 ---- */
(async()=>{
  if(/^#\/process/.test(location.hash)){const f=await unstash();if(f){go();takeFile(f);return}location.replace('#/upload')}
  go();
})();
// 测试用：直接给数据启动播放页（tools/smoke_test.js、tools/report.js）
window.__boot=boot;A.routeDots=routeDots;
return A;
})();
