// 保存带配乐的视频（M-07）。player.js 之后加载。
// 播放页画面（灰度 + 纸白底、可视化、TOP 字）加右下角圆点字水印 CLIMIDI，画到一张 720×1280 画布，
// 和音频引擎的出口（S.gate）一起用 MediaRecorder 录。全程在本机，不上传。
// 录完原地保存（M-11），不跳页：能直接下载的直接下载；iPhone 要走系统分享存相册，只能在点击里调（录了几十秒，那次点击早失效了），
// 所以画面右上角原地出一个“存到相册”。
(()=>{
const W=720,H=1280,INK='#141418';
const TYPES=['video/mp4;codecs=avc1,mp4a.40.2','video/mp4','video/webm;codecs=vp9,opus','video/webm'];   // iOS Safari 只有 mp4
const type=window.MediaRecorder&&TYPES.find(t=>MediaRecorder.isTypeSupported(t));
const btn=$('saveVid'),now=$('saveNow'),playV=$('v-play'),viz=$('viz'),topCv=$('topText');
let rec=null,file=null;

btn.onclick=()=>{
  if(file)return save();
  if(rec)return;
  if(!type||!HTMLCanvasElement.prototype.captureStream){App.toast('这个浏览器录不了视频，换 Safari 或 Chrome 试试');return}
  record();
};
// 换了音色，录好的视频就不对了
document.querySelectorAll('.seg button').forEach(b=>b.addEventListener('click',()=>{file=null;playV.classList.remove('saved')}));
now.onclick=()=>{playV.classList.remove('saved');save()};

function record(){
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;const g=cv.getContext('2d');
  playV.classList.remove('saved');
  location.hash='#/play';                 // 在播放页录：用户看着它播，可视化照常由 player.js 画
  hush();vid.currentTime=0;App.start();   // 新建音频图（在这次点击里），从头播
  const dest=ac.createMediaStreamDestination(),gate=S.gate;gate.connect(dest);
  const stream=new MediaStream([...cv.captureStream(30).getVideoTracks(),...dest.stream.getAudioTracks()]);
  const chunks=[];let ok=false;
  rec=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:5e6});
  rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
  rec.onstop=()=>{
    try{gate.disconnect(dest)}catch(e){}
    stream.getTracks().forEach(t=>t.stop());
    playV.classList.remove('rec');rec=null;
    if(!ok||!chunks.length){App.toast('录制中断了，再点一次重新录');return}
    const mime=type.split(';')[0];
    file=new File(chunks,'CLIMIDI-'+Date.now()+(mime==='video/mp4'?'.mp4':'.webm'),{type:mime});
    if(canShare()){playV.classList.add('saved');App.toast('录好了，点右上角存到相册')}
    else{download();App.toast('已保存')}
  };
  // 播完（pause 先于 ended 触发，这时 ended 已经是 true）留 0.3 秒尾音再停；中途被暂停 / 切走就作废
  const onPause=()=>{vid.removeEventListener('pause',onPause);ok=vid.ended;setTimeout(()=>rec&&rec.stop(),ok?300:0)};
  vid.addEventListener('pause',onPause);
  playV.classList.add('rec');
  rec.start(1000);
  (function draw(){
    if(!rec)return;
    requestAnimationFrame(draw);
    const c=CLIMB_DATA.crop||{sx:0,sy:0,sw:vid.videoWidth,sh:vid.videoHeight};
    g.globalAlpha=1;g.globalCompositeOperation='source-over';g.fillStyle='#F5F5F3';g.fillRect(0,0,W,H);
    if(vid.readyState>=2)g.drawImage(vid,c.sx,c.sy,c.sw,c.sh,0,0,W,H);
    // 和播放页 CSS 一样：灰度 + 80% 纸白（同 player.js 的 grabFrame）
    g.globalCompositeOperation='saturation';g.fillStyle='#808080';g.fillRect(0,0,W,H);
    g.globalCompositeOperation='source-over';g.fillStyle='rgba(245,245,243,.8)';g.fillRect(0,0,W,H);
    if(viz.width)g.drawImage(viz,0,0,W,H);
    const a=+getComputedStyle(topCv).opacity;   // TOP 字跟着 CSS 淡入
    if(a>0&&topCv.width){g.globalAlpha=a;const w=W*.4872;g.drawImage(topCv,W*.059,H*.0433,w,w*topCv.height/topCv.width);g.globalAlpha=1}
    // 水印：右下角圆点字，只写 CLIMIDI，不放网址
    const p=4,x=W-28-Dots.cols('CLIMIDI')*p,y=H-28-7*p;
    g.fillStyle='rgba(245,245,243,.72)';g.beginPath();g.roundRect(x-10,y-8,Dots.cols('CLIMIDI')*p+20,7*p+16,999);g.fill();
    Dots.paint(g,'CLIMIDI',x,y,p,INK);
  })();
}

// 只有 iPhone/iPad 走系统分享（存相册）；电脑上直接下载
const canShare=()=>playV.classList.contains('ios')&&!!(navigator.canShare&&navigator.canShare({files:[file]}));
async function save(){
  if(canShare()){
    try{await navigator.share({files:[file]})}catch(e){}   // iPhone：分享面板里选“存储视频”
    return;
  }
  download();App.toast('已保存');
}
function download(){
  const a=document.createElement('a');a.href=URL.createObjectURL(file);a.download=file.name;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}
})();
