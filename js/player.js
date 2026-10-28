// 播放页（含 TOP 状态）+ 分享页。识别完成、引擎（engine.js）和 viz.js 加载之后才加载这个文件。
// 用到引擎的全局量（vid、ac、topT、N、FPS、initAudio、hush、silence、audioStep、setScale、$），以及 app.js 的 App。
(()=>{
const INK='#141418';
const cropOf=()=>CLIMB_DATA.crop||{sx:0,sy:0,sw:vid.videoWidth,sh:vid.videoHeight};   // 视频里 9:16 的裁切

/* ---- TOP 兜底（HANDOFF §5 P2）----
   引擎的自动检测要两手都在最高处停稳 0.8 秒；手伸出画面顶端时识别不到手，就没有 TOP。
   这时取“手最后一次在高处（手范围最高 30%）且看得清”的时刻；连这个也没有就用视频末尾。只决定何时收束，声音不变。 */
if(topT==null){
  const th=R.hand[0]+0.7*(R.hand[1]-R.hand[0]);let f=-1;
  for(let i=0;i<N;i++)if((ser.Lw.c[i]>=0.35&&ser.Lw.h[i]>=th)||(ser.Rw.c[i]>=0.35&&ser.Rw.h[i]>=th))f=i;
  topT=f>=0?(f+1)/FPS:(N-1)/FPS;
  window.__topFallback=true;   // tools/report.js 用来区分“自动检测到”和“兜底”
}

/* ---- 播放页 ---- */
const playV=$('v-play');
Dots.render($('topText'),'TOP',190/17,INK);   // 190×78
const atTop=t=>topT!=null&&t>=topT;
$('play').onclick=()=>{
  if(!vid.paused){vid.pause();hush();return}   // 暂停要连余音一起停
  if(vid.ended){hush();vid.currentTime=0}       // 播完再按：先切掉 TOP 的尾音，从头来
  initAudio();vid.play().catch(()=>{});
};
$('replay').onclick=()=>{hush();initAudio();vid.currentTime=0;vid.play().catch(()=>{})};   // 先切掉 TOP 的尾音再从头来
document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{
  setScale(b.dataset.scale);
  document.querySelectorAll('.seg button').forEach(x=>x.setAttribute('aria-pressed',x===b));
});
// 进度条：0 → TOP 时刻（到 TOP 时走满）；点/拖跳转
const span=()=>topT!=null?topT:(vid.duration||N/FPS);
function seekAt(e){const r=$('seek').getBoundingClientRect();vid.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*span()}
$('seek').addEventListener('pointerdown',e=>{seekAt(e);$('seek').setPointerCapture(e.pointerId);$('seek')._d=true});
$('seek').addEventListener('pointermove',e=>{if($('seek')._d)seekAt(e)});
$('seek').addEventListener('pointerup',()=>$('seek')._d=false);
$('seek').addEventListener('keydown',e=>{const d={ArrowLeft:-2,ArrowRight:2}[e.key];if(d){e.preventDefault();vid.currentTime=Math.max(0,Math.min(vid.duration||N/FPS,vid.currentTime+d))}});
window.addEventListener('keydown',e=>{if(App.route==='play'&&e.code==='Space'&&!/^(INPUT|BUTTON|A)$/.test(document.activeElement.tagName)){e.preventDefault();$('play').click()}});

function drawPlay(t){
  const top=atTop(t);
  playV.classList.toggle('is-top',top);
  Viz.player($('viz'),t);
  Dots.render($('clock'),top?Dots.clock(topT,true):Dots.clock(t),4,INK);
  App.fillTo($('fill'),top?1:t/span());
  $('seek').setAttribute('aria-valuetext',Dots.clock(t));
  const on=!vid.paused;$('play').classList.toggle('on',on);$('play').setAttribute('aria-label',on?'暂停':'播放');
  $('replay').setAttribute('aria-label',top?'从头再听一遍':'从头播放');
}

/* ---- 分享页 ---- */
const sh={grade:3,title:''};
const today=(d=>`${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`)(new Date());
$('shDate').textContent=today;
for(let i=0;i<10;i++){
  const b=document.createElement('button');b.type='button';b.textContent='V'+i;b.setAttribute('role','radio');
  b.onclick=()=>{sh.grade=i;syncShare()};$('grades').appendChild(b);
}
$('title').addEventListener('input',e=>{sh.title=e.target.value;syncShare()});
function syncShare(){
  [...$('grades').children].forEach((b,i)=>{b.setAttribute('aria-checked',i===sh.grade);b.tabIndex=i===sh.grade?0:-1});
  Dots.render($('gradeCv'),'V'+sh.grade,6,INK);   // 66×42
  Dots.render($('timeCv'),Dots.clock(shareT(),true),3,INK);   // 99×21
  const t=sh.title.trim();
  $('shTitle').textContent=t||'给这首曲子起个名';$('shTitle').classList.toggle('empty',!t);
}
// 路线图停在 TOP 那一帧（没有 TOP 就用最后一帧）；只在进入和尺寸变化时重画
const shareT=()=>topT!=null?topT:(N-1)/FPS;
// 底图：TOP 那一帧，灰度 + 80% 纸白（和播放页一样）。用 saturation 合成去色，不读像素，Safari 也能用
let shareBg=null,shareBgT=null;
function grabFrame(t){
  return new Promise(res=>{
    const back=vid.currentTime,done=()=>{
      const c=document.createElement('canvas');c.width=720;c.height=1280;const g=c.getContext('2d');
      Sil.capture(vid,Math.min(N-1,Math.floor(t*FPS)));   // 顺便算 TOP 那一帧的人形轮廓
      const c0=cropOf();g.drawImage(vid,c0.sx,c0.sy,c0.sw,c0.sh,0,0,720,1280);
      g.globalCompositeOperation='saturation';g.fillStyle='#808080';g.fillRect(0,0,720,1280);
      g.globalCompositeOperation='source-over';g.fillStyle='rgba(245,245,243,.8)';g.fillRect(0,0,720,1280);
      vid.currentTime=back;res(c);
    };
    if(Math.abs(vid.currentTime-t)<0.02&&vid.readyState>=2){done();return}
    const seek=()=>{vid.addEventListener('seeked',done,{once:true});vid.currentTime=t};
    if(vid.readyState>=1)seek();else vid.addEventListener('loadedmetadata',seek,{once:true});
  });
}
async function renderShare(){
  syncShare();
  const t=shareT();
  if(shareBgT!==t){shareBg=await grabFrame(t);shareBgT=t}
  requestAnimationFrame(()=>Viz.share($('mapCv'),t,shareBg));
}
window.addEventListener('resize',()=>{if(App.route==='share')renderShare()});

$('saveVid').onclick=()=>App.toast('导出带配乐的视频还在做，下一版加上');
// 分享：把预览卡画成一张 PNG，能系统分享就分享，不能就下载
async function cardPng(){
  const card=document.querySelector('.share .card'),map=$('mapCv');
  const w=card.clientWidth,h=card.clientHeight,s=3,c=document.createElement('canvas');c.width=w*s;c.height=h*s;
  const g=c.getContext('2d');g.scale(s,s);
  const box=card.getBoundingClientRect(),rel=el=>{const r=el.getBoundingClientRect();return[r.left-box.left,r.top-box.top,r.width,r.height]};
  g.fillStyle='#fff';g.beginPath();g.roundRect(0,0,w,h,28);g.fill();
  const [mx,my,mw,mh]=rel($('mapCv').parentNode),[cx,cy,cw,ch]=rel(map);
  g.save();g.beginPath();g.roundRect(mx,my,mw,mh,18);g.clip();g.fillStyle='#F5F5F3';g.fillRect(mx,my,mw,mh);g.drawImage(map,cx,cy,cw,ch);g.restore();
  for(const k of document.querySelectorAll('.share .chip')){
    const [kx,ky,kw,kh]=rel(k);
    g.fillStyle='#F5F5F3';g.beginPath();g.roundRect(kx,ky,kw,kh,16);g.fill();g.strokeStyle='rgba(20,20,24,.1)';g.lineWidth=1;g.stroke();
    for(const cv of k.querySelectorAll('canvas')){const [x,y,w2,h2]=rel(cv);g.drawImage(cv,x,y,w2,h2)}
    for(const sp of k.querySelectorAll('span')){const [x,y,,h2]=rel(sp);g.fillStyle='#5E5E62';g.font='500 11px "Noto Sans SC",system-ui,sans-serif';g.textBaseline='middle';g.fillText(sp.textContent,x,y+h2/2)}
  }
  const [tx,ty,,th]=rel($('shTitle')),t=sh.title.trim();
  g.textBaseline='middle';g.fillStyle=t?INK:'#8A8A8E';g.font='700 22px "Noto Sans SC",system-ui,sans-serif';g.fillText(t||'给这首曲子起个名',tx,ty+th/2);
  const sub=document.querySelector('.meta .sub'),[sx,sy,sw,sh2]=rel(sub);
  g.fillStyle='#5E5E62';g.font='400 12px "Noto Sans SC",system-ui,sans-serif';g.fillText('过线配乐',sx,sy+sh2/2);
  g.textAlign='right';g.fillText(today,sx+sw,sy+sh2/2);
  return new Promise(r=>c.toBlob(r,'image/png'));
}
$('shareBtn').onclick=async()=>{
  let blob;try{blob=await cardPng()}catch(e){App.toast('这样打开的页面导不出图片，请用网页地址打开');return}   // file:// 下画布会被视频帧污染
  const name=(sh.title.trim()||'过线配乐')+'.png',file=new File([blob],name,{type:'image/png'});
  if(navigator.canShare&&navigator.canShare({files:[file]})){try{await navigator.share({files:[file],title:sh.title.trim()||'过线配乐'})}catch(e){}return}
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  App.toast('已保存分享卡图片');
};

/* ---- 路由钩子：app.js 切页时调用 ---- */
App.onRoute=(next,prev)=>{
  // 从分享页返回保持原状（通常停在 TOP）；从别处进来停在开头，等用户点播放（iOS 声音要在点击里开）
  if(next==='play'&&prev!=='share'&&prev!=='play'){vid.pause();vid.currentTime=0}
  if(next!=='play'){vid.pause();hush()}
  if(next==='share')renderShare();
};

/* ---- 驱动：和原型的 frame() 一样，引擎跟着视频时钟走 ---- */
function frame(){
  requestAnimationFrame(frame);
  const t=vid.currentTime||0;
  if(ac){if(vid.paused)silence();else audioStep(t)}
  if(App.route==='play')drawPlay(t);
}
requestAnimationFrame(frame);
})();
