// 姿态识别：在用户手机上用 MediaPipe Pose Landmarker 逐帧找人，视频不离开设备。
// 输出格式：每帧 8 个点 [x,y,conf]，x,y 归一化到 0..1000，conf×100，30fps。
// 逐帧识别前先抽帧算“空墙”（排除人的逐像素中值），给路线岩点、去掉蒙版里的岩点和过滤认错的姿态用。
const Pose=(()=>{
  const VER='0.10.14';
  // 库和模型放在自己的网站上（vendor/，约 28MB，手机按需下 19MB 左右）：谷歌存储和 jsdelivr 在部分流量网络下连不上
  const LIB=new URL('vendor/mediapipe',location.href).href;
  const MODEL=LIB+'/pose_landmarker_full.task';
  const IDX=[11,12,15,16,23,24,27,28];   // MediaPipe 33 点 → Ls Rs Lw Rw Lh Rh La Ra（左右都是攀岩者自己的左右）
  const FPS=30,STEP=2;                    // 每 2 帧识别一次（15fps），中间帧插值，手机上快一倍
  const BW=180,BH=320,BG_MAX=48;          // 空墙在 180×320 上算，最多抽 48 帧（手机内存）
  // 识别配置（tools 可以覆盖后对比）。pad：识别前四周加灰边，模型要看到“身体还能往外延伸”才认得出画面边缘的半个人；maxSide：识别画布长边，决定读蒙版的耗时
  const CFG={padX:0.25,padY:0.1,maxSide:1024,det:0.1,pres:0.1,track:0.1};
  const DIFF=30;                          // 和空墙差多少算前景（180×320，缩小本身已平滑）
  const SKEL=[[11,13],[13,15],[12,14],[14,16],[11,12],[23,24],[11,23],[12,24],[23,25],[25,27],[24,26],[26,28]];
  let lm=null;
  // 诊断日志（?debug=1 时处理页会显示）：每一步的耗时和报错，手机上卡住时能看出卡在哪一步
  const T0=performance.now(),logs=[];
  function log(m){const line=((performance.now()-T0)/1000).toFixed(1)+'s '+m;logs.push(line);console.log('pose:',line);if(Pose.onLog)Pose.onLog(line)}
  // 等一个 Promise，超时就报错（手机上任何一步都不能无声无息地卡住）
  const within=(p,ms,err)=>Promise.race([p,new Promise((_,bad)=>setTimeout(()=>bad(new Error(err)),ms))]);

  // 下载 wasm 和模型：有进度、记录网速；存进 Cache，之后打开不用再下载。慢网不算失败，只有 30 秒一个字节都没收到才算
  const WASM_MB=9.4,MODEL_MB=9.4;
  async function asset(url,name,type,doneMB,totMB){
    const cache=window.caches?await caches.open('climidi-mp-'+VER).catch(()=>null):null;
    const hit=cache&&await cache.match(url).catch(()=>null);
    if(hit){log(name+' 用缓存');return new Blob([await hit.arrayBuffer()],{type})}
    log('下载 '+name);
    const ctl=new AbortController();let timer;const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>ctl.abort(),30000)};arm();
    const res=await fetch(url,{signal:ctl.signal});if(!res.ok)throw new Error(name+' HTTP '+res.status);
    const rd=res.body.getReader(),parts=[],t0=performance.now();let n=0,lastLog=0;
    for(;;){
      const {done,value}=await rd.read();if(done)break;
      arm();parts.push(value);n+=value.length;
      if(Pose.onDownload)Pose.onDownload(doneMB+n/1e6,totMB);
      if(performance.now()-lastLog>5000){lastLog=performance.now();log(`${name} ${(n/1e6).toFixed(1)}MB，${Math.round(n/1024/((lastLog-t0)/1000))}KB/s`)}
    }
    clearTimeout(timer);
    const blob=new Blob(parts,{type});
    log(`${name} 下载完，${((performance.now()-t0)/1000).toFixed(0)} 秒`);
    if(cache)await cache.put(url,new Response(blob,{headers:{'Content-Type':type}})).catch(()=>{});
    return blob;
  }

  async function load(){
    if(lm)return lm;
    log('加载 MediaPipe 库');
    const vision=await within(import(`${LIB}/vision_bundle.mjs`),60000,'lib timeout');
    const files=await vision.FilesetResolver.forVisionTasks(`${LIB}/wasm`);
    const tot=WASM_MB+MODEL_MB;
    const wasm=await asset(files.wasmBinaryPath,'wasm','application/wasm',0,tot);
    const model=await asset(MODEL,'模型','application/octet-stream',WASM_MB,tot);
    files.wasmBinaryPath=URL.createObjectURL(wasm);
    const buf=new Uint8Array(await model.arrayBuffer());
    log('创建识别器（GPU）');
    // numPoses 必须是 1：大于 1 时跟踪器每帧都重跑人体检测，关键点窗口每帧变，关节会抽搐
    const opt=d=>({baseOptions:{modelAssetBuffer:buf,delegate:d},runningMode:'VIDEO',numPoses:1,outputSegmentationMasks:true,
      // 门限放低：人爬到画面边缘只露半边时也不跟丢。放低后会认出假人，由 ghostFilter 用空墙对比去掉
      minPoseDetectionConfidence:CFG.det,minPosePresenceConfidence:CFG.pres,minTrackingConfidence:CFG.track});
    try{lm=await within(vision.PoseLandmarker.createFromOptions(files,opt('GPU')),90000,'create timeout')}
    catch(e){log('GPU 不行，改用 CPU：'+e.message);lm=await vision.PoseLandmarker.createFromOptions(files,opt('CPU'))}   // 没有 WebGL 时退回 CPU
    log('识别器就绪');
    return lm;
  }
  // 竖屏 9:16 的居中裁切（和播放页 object-fit:cover 一致），视频像素坐标
  function cropOf(vw,vh){
    const want=9/16;
    if(vw/vh>want){const sw=vh*want;return{sx:(vw-sw)/2,sy:0,sw,sh:vh}}
    const sh=vw/want;return{sx:0,sy:(vh-sh)/2,sw:vw,sh};
  }
  // 跳到 t。目标和当前位置一样时浏览器不发 seeked，直接返回；个别帧 seek 不回来也只等 3 秒
  const seek=(v,t)=>Math.abs(v.currentTime-t)<1e-3?Promise.resolve():within(new Promise(r=>{v.addEventListener('seeked',r,{once:true});v.currentTime=t}),3000,'seek').catch(()=>log('seek 超时 '+t.toFixed(2)));

  // 主流程 = 扫描（逐帧识别，所有人都留着）+ 整理（选攀岩者、清洗、插值）。
  // onStage('model'|'scan'|'post')，onProgress(已识别帧, 总帧)；abort() 返回 true 就停
  async function analyze(url,cb){
    const s=await scan(url,cb);
    cb.onStage('post');
    const r=finish(s);
    return{kp:r.kp,N:s.N,dur:s.dur,crop:s.crop,vw:s.vw,vh:s.vh,bg:s.bg,masks:r.masks,reach:r.reach,stats:r.stats};
  }
  // 这一像素是不是前景。空墙一直被人挡着、没有依据的像素算前景（宁可不抠，也不把静止的人抠掉）
  const fgTest=(d,wall,known)=>k=>{
    if(!known[k])return true;const i=k*4;
    return Math.max(Math.abs(d[i]-wall[i]),Math.abs(d[i+1]-wall[i+1]),Math.abs(d[i+2]-wall[i+2]))>DIFF;
  };
  // 身体范围（宽度接近真实四肢和躯干）：浅色裤子贴白墙时前景图全是洞，范围内不看前景。线段只到手腕和脚踝，手脚外侧抓着、踩着的岩点不在里面
  const kc=document.createElement('canvas');kc.width=BW;kc.height=BH;const kg=kc.getContext('2d',{willReadFrequently:true});
  function bodyMap(pts){
    const T=Math.hypot((pts[11][0]+pts[12][0]-pts[23][0]-pts[24][0])/2*BW,(pts[11][1]+pts[12][1]-pts[23][1]-pts[24][1])/2*BH);
    kg.clearRect(0,0,BW,BH);kg.strokeStyle='#000';kg.fillStyle='#000';kg.lineCap='round';
    for(const [a,b] of SKEL){kg.lineWidth=Math.max(4,T*(a===11&&b===23||a===12&&b===24?.9:.5));kg.beginPath();kg.moveTo(pts[a][0]*BW,pts[a][1]*BH);kg.lineTo(pts[b][0]*BW,pts[b][1]*BH);kg.stroke()}
    kg.beginPath();kg.arc(pts[0][0]*BW,pts[0][1]*BH,Math.max(3,T*.4),0,7);kg.fill();
    const d=kg.getImageData(0,0,BW,BH).data;
    return k=>d[k*4+3]>100;
  }
  // 假人判据：身上的关键点有多少落在前景上（±2 像素内）。画面外的点不算；一个点都不在画面里就是 0
  function evidence(pts,isFg){
    let n=0,hit=0;
    for(const k of [11,12,13,14,15,16,23,24,25,26,27,28]){
      const x=Math.round(pts[k][0]*BW),y=Math.round(pts[k][1]*BH);
      if(x<0||y<0||x>=BW||y>=BH)continue;
      n++;let on=false;
      for(let dy=-2;dy<=2&&!on;dy++)for(let dx=-2;dx<=2&&!on;dx++){const a=x+dx,b=y+dy;if(a>=0&&b>=0&&a<BW&&b<BH&&isFg(b*BW+a))on=true}
      if(on)hit++;
    }
    return n?hit/n:0;
  }
  // 人体分割蒙版 → BW×BH 的 1 位图，一帧 7KB。模型常把手边的岩点也算进人体：岩点在空墙上也有，所以“和空墙一样、又不在身体范围内”的像素去掉。
  // 返回 {bits, mp}，mp 是蒙版里有多少落在前景上：太低说明模型把墙上的东西当成了人。读不出来返回 null，轮廓退回“帧 − 空墙”
  function packMask(m,lut,isFg,body){
    if(!m)return null;
    try{
      const a=m.getAsFloat32Array(),{xs,ys}=lut(m.width,m.height),bits=new Uint8Array(BW*BH>>3),w=m.width;
      let on=0,fg=0;
      for(let y=0;y<BH;y++){const r=ys[y]*w;for(let x=0;x<BW;x++){
        if(a[r+xs[x]]<=.5)continue;
        const k=y*BW+x,f=!isFg||isFg(k);on++;if(f)fg++;
        if(f||body(k))bits[k>>3]|=1<<(k&7);
      }}
      return{bits,mp:on?fg/on:null};
    }catch(e){log('读蒙版失败：'+e.message);return null}
  }
  // 模型跟丢时接着找人：从上一帧人形出发，在附近沿“和空墙不同的像素”连成一块，人形不会断。
  // 不知道是不是墙的像素（人一直挡着）只在上一帧也是人时才算。太大（连上了旁人）或太小（没东西了）都放弃；上限放宽是因为模型最后一帧常漏掉浅色裤子，参考面积偏小
  function followBlob(isDiff,known,prev,box,refArea){
    const pad=Math.max(6,Math.round(Math.max(box.x1-box.x0,box.y1-box.y0)*.2));
    const x0=Math.max(0,box.x0-pad),x1=Math.min(BW-1,box.x1+pad),y0=Math.max(0,box.y0-pad),y1=Math.min(BH-1,box.y1+pad);
    const on=k=>prev[k>>3]>>(k&7)&1,yes=k=>known[k]?isDiff(k):on(k);
    // 只留最大的一块：和身体断开的多半是人几秒前待过的位置留下的残影
    const seen=new Uint8Array(BW*BH);let best=[];
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const k0=y*BW+x;if(seen[k0]||!on(k0)||!yes(k0))continue;
      seen[k0]=1;const st=[k0],comp=[];
      while(st.length){
        const k=st.pop(),cx=k%BW,cy=(k/BW)|0;comp.push(k);
        for(const [a,e] of [[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]]){if(a<x0||a>x1||e<y0||e>y1)continue;const q=e*BW+a;if(!seen[q]&&yes(q)){seen[q]=1;st.push(q)}}
      }
      if(comp.length>best.length)best=comp;
    }
    const bits=new Uint8Array(BW*BH>>3),b={x0:BW,y0:BH,x1:-1,y1:-1},area=best.length;
    for(const k of best){const x=k%BW,y=(k/BW)|0;bits[k>>3]|=1<<(k&7);b.x0=Math.min(b.x0,x);b.x1=Math.max(b.x1,x);b.y0=Math.min(b.y0,y);b.y1=Math.max(b.y1,y)}
    return area>=refArea*.3&&area<=refArea*3?{bits,box:b,area}:null;
  }
  const boxOf=bits=>{
    const b={x0:BW,y0:BH,x1:-1,y1:-1};let area=0;
    for(let y=0;y<BH;y++)for(let x=0;x<BW;x++){const k=y*BW+x;if(bits[k>>3]>>(k&7)&1){area++;b.x0=Math.min(b.x0,x);b.x1=Math.max(b.x1,x);b.y0=Math.min(b.y0,y);b.y1=Math.max(b.y1,y)}}
    return{box:b,area};
  };
  // 扫描。keep>0 时每 keep 帧另存一张 180×320 缩略帧（测试脚本用，线上不存）
  async function scan(url,{onStage=()=>{},onProgress=()=>{},abort=()=>false,keep=0}={}){
    onStage('model');
    let det;try{det=await load()}catch(e){log('模型加载失败：'+e.message);throw new Error('model')}
    // iOS Safari 不会主动预加载视频：要先 play() 才开始加载/解码（不能先等 loadeddata 再 play，会一直等）。
    // 视频挂在页面上（看不见），有些 Safari 版本对脱离页面的 video 不出画面帧
    const v=document.createElement('video');v.muted=true;v.defaultMuted=true;v.playsInline=true;
    v.setAttribute('muted','');v.setAttribute('playsinline','');v.preload='auto';
    v.style.cssText='position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
    document.body.appendChild(v);
    try{
    const ready=new Promise((ok,bad)=>{v.addEventListener('loadeddata',ok,{once:true});v.onerror=()=>bad(new Error('unreadable'))});
    v.src=url;v.load();
    log('打开视频');
    try{await within(v.play(),8000,'play');v.pause();log('视频可以播放')}catch(e){log('play() 没成功：'+e.message)}
    if(v.readyState<2)await within(ready,20000,'unreadable');
    log(`视频就绪 ${v.videoWidth}×${v.videoHeight} ${v.duration.toFixed(1)}s`);
    const vw=v.videoWidth,vh=v.videoHeight,crop=cropOf(vw,vh),dur=v.duration,N=Math.max(2,Math.round(dur*FPS));
    const bgEvery=Math.max(10,Math.ceil(N/BG_MAX/STEP)*STEP),bgFrames=[];
    const bc=document.createElement('canvas');bc.width=BW;bc.height=BH;const bg=bc.getContext('2d',{willReadFrequently:true});
    const bgInfo=Pose.bgInfo={blank:0,rescued:0,used:0,luma:0};
    // 读 180×320 的当前帧。读到空白帧（全透明/全黑）说明这一刻视频帧还没解码出来（iOS 上 seeked 之后可能还没出帧）：
    // 等下一个出帧回调（最多 0.3 秒）再读一次，还是空白就返回 null
    const read=()=>{bg.clearRect(0,0,BW,BH);bg.drawImage(v,crop.sx,crop.sy,crop.sw,crop.sh,0,0,BW,BH);return bg.getImageData(0,0,BW,BH).data};
    const grab=async()=>{
      let d=read();if(!blank(d))return d;
      bgInfo.blank++;await within(new Promise(r=>v.requestVideoFrameCallback?v.requestVideoFrameCallback(r):setTimeout(r,100)),300,'rvfc').catch(()=>{});
      d=read();if(blank(d))return null;bgInfo.rescued++;return d;
    };
    // 加灰边的识别画布。S 限制总尺寸；landmark 坐标先换回视频像素，再换成裁切后的 0..1
    const S=Math.min(1,CFG.maxSide/Math.max(vw*(1+2*CFG.padX),vh*(1+2*CFG.padY))),pw=Math.round(vw*CFG.padX*S),ph=Math.round(vh*CFG.padY*S);
    const pc=document.createElement('canvas');pc.width=Math.round(vw*S)+2*pw;pc.height=Math.round(vh*S)+2*ph;const pg=pc.getContext('2d');
    const toCrop=q=>[((q.x*pc.width-pw)/S-crop.sx)/crop.sw,((q.y*pc.height-ph)/S-crop.sy)/crop.sh];
    const toPad=()=>{pg.fillStyle='#808080';pg.fillRect(0,0,pc.width,pc.height);pg.drawImage(v,pw,ph,pc.width-2*pw,pc.height-2*ph)};
    // 蒙版下标查找表：每帧不用重算坐标
    let tab=null;
    const lut=(mw,mh)=>{
      if(tab&&tab.mw===mw)return tab;
      const xs=new Int32Array(BW),ys=new Int32Array(BH);
      for(let x=0;x<BW;x++)xs[x]=Math.min(mw-1,Math.max(0,Math.floor(((crop.sx+(x+.5)/BW*crop.sw)*S+pw)*mw/pc.width)));
      for(let y=0;y<BH;y++)ys[y]=Math.min(mh-1,Math.max(0,Math.floor(((crop.sy+(y+.5)/BH*crop.sh)*S+ph)*mh/pc.height)));
      return tab={mw,xs,ys};
    };
    onStage('scan');
    // 先抽帧算空墙（后面逐帧要用它判断前景）。这一遍也跑识别，每帧把人挡住的像素排除，所以人长时间不动（平衡线）也不会被算进墙
    const bgSamples=[];
    for(let f=0;f<N;f+=bgEvery){
      if(abort())throw new Error('abort');
      await seek(v,Math.min(dur-0.001,(f+0.5)/FPS));
      const d=await grab();
      if(d){
        toPad();
        let res;try{res=det.detectForVideo(pc,Math.round(f*1000/FPS)+1)}catch(e){log('识别失败：'+e.message);throw new Error('device')}
        const sm=res.segmentationMasks||[],mk=packMask(sm[0],lut,null,()=>true);sm.forEach(q=>q.close());
        bgSamples.push({d,person:mk&&mk.bits});bgInfo.luma+=luma(d);
      }
      onProgress(0,N);
    }
    bgInfo.used=bgSamples.length;bgInfo.luma=bgSamples.length?Math.round(bgInfo.luma/bgSamples.length):0;
    log(`空墙：抽 ${bgInfo.used+bgInfo.blank-bgInfo.rescued} 帧，读到空白 ${bgInfo.blank}（重读救回 ${bgInfo.rescued}），用 ${bgInfo.used} 帧，平均亮度 ${bgInfo.luma}`);
    const {canvas:wall,known}=wallOf(bgSamples),wallD=bgSamples.length?wall.getContext('2d').getImageData(0,0,BW,BH).data:null;
    bgSamples.length=0;
    const ts0=Math.round(dur*1000)+1000;   // 时间戳必须递增：逐帧这一遍接在抽帧那一遍后面
    const lost=[];let track=null;   // lost：这一帧的人形来自 followBlob；track：最近一次的人形 {bits,box,area}，refArea 是模型最后认对时的面积
    let refArea=0;
    const raw=[],frames=new Map(),masks=[];   // raw 每个识别帧：{f, poses:[{p:[[x,y,vis]×8],cx,cy,ev,mp}]}；masks 和 raw 一一对应
    const cost={读帧:0,识别:0,蒙版:0};   // 每一步的累计耗时，?debug=1 看手机上慢在哪
    log('开始逐帧识别，共 '+N+' 帧');
    for(let f=0;f<N;f+=STEP){
      if(abort())throw new Error('abort');
      await seek(v,Math.min(dur-0.001,(f+0.5)/FPS));
      let t=performance.now();
      const d=await grab(),isFg=d&&wallD?fgTest(d,wallD,known):null;
      toPad();
      cost.读帧+=performance.now()-t;t=performance.now();
      let res;try{res=det.detectForVideo(pc,ts0+Math.round(f*1000/FPS))}catch(e){log('识别失败：'+e.message);throw new Error('device')}
      if(f===0)log('第一帧识别完成');
      cost.识别+=performance.now()-t;t=performance.now();
      const sm=res.segmentationMasks||[],L0=res.landmarks&&res.landmarks[0],pts0=L0&&L0.map(toCrop);
      const mk=pts0?packMask(sm[0],lut,isFg,isFg?bodyMap(pts0):()=>true):null;sm.forEach(q=>q.close());   // 不 close 会一直占显存
      // 这一帧模型认得对不对（和 ghostFilter 同一标准）；不对就用 followBlob 接上
      const ev0=pts0&&isFg?evidence(pts0,isFg):1,good=pts0&&ev0>=CLEAN.ghostEv&&(!mk||mk.mp==null||mk.mp>=CLEAN.ghostMp);
      let useBits=mk&&mk.bits,isLost=false;
      if(good&&mk){const bb=boxOf(mk.bits);if(bb.area){track={bits:mk.bits,box:bb.box,area:bb.area};refArea=bb.area}}
      else if(!good&&track&&d&&wallD){
        const diff=k=>{
          const i=k*4,r=d[i]/(wallD[i]+1),g=d[i+1]/(wallD[i+1]+1),b=d[i+2]/(wallD[i+2]+1);
          if(r>.45&&r<1&&Math.abs(r-g)<.08&&Math.abs(g-b)<.08&&Math.abs(r-b)<.08)return false;   // 影子：墙变暗，三个通道同比例下降
          return Math.max(Math.abs(d[i]-wallD[i]),Math.abs(d[i+1]-wallD[i+1]),Math.abs(d[i+2]-wallD[i+2]))>DIFF;
        };
        const fb=followBlob(diff,known,track.bits,track.box,refArea);
        if(fb){track=fb;useBits=fb.bits;isLost=true}else useBits=null;
      }
      masks.push(useBits);lost.push(isLost);
      cost.蒙版+=performance.now()-t;
      raw.push({f,poses:(res.landmarks||[]).map(L=>{
        const pts=L.map(toCrop),p=IDX.map(k=>[pts[k][0],pts[k][1],L[k].visibility==null?1:L[k].visibility]);
        const cx=p.reduce((a,q)=>a+q[0],0)/8,cy=p.reduce((a,q)=>a+q[1],0)/8;
        return{p,cx,cy,ev:isFg?evidence(pts,isFg):1,mp:isFg&&mk?mk.mp:null};
      })});
      if(keep&&f%keep===0){const c=document.createElement('canvas');c.width=BW;c.height=BH;c.getContext('2d').drawImage(v,crop.sx,crop.sy,crop.sw,crop.sh,0,0,BW,BH);frames.set(f,c)}
      onProgress(Math.min(N,f+STEP),N);
      if(f%20===0)await new Promise(r=>setTimeout(r,0));   // 让出主线程，进度条能动
    }
    log('识别完成，平均每帧 '+Object.entries(cost).map(([k,v])=>k+' '+(v/raw.length).toFixed(1)+'ms').join('，'));
    return{raw,N,dur,crop,vw,vh,bg:wall,frames,masks,lost,cost:Object.fromEntries(Object.entries(cost).map(([k,v])=>[k,v/raw.length]))};
    }finally{v.remove()}
  }
  // 整理：扫描结果 → 每帧 8 点（30fps）+ 质量统计。只依赖 raw 和 N，参数改了可以离线重跑
  function finish({raw,N,masks,lost},o=CLEAN){
    const {raw:live,ghosts}=ghostFilter(raw,o),pick=chooseClimber(live),{M,swaps}=clean(live,pick,o);
    return{kp:toFrames(M,N),S:M,masks:masks&&masks.map((m,d)=>(lost&&lost[d])||(M[d]&&live[d].poses.length)?m:null),
      // 跟丢期间人形最高点（0..1），TOP 判定用：后面没有手的数据时，靠它知道人还在往上爬
      reach:masks&&lost?masks.flatMap((m,d)=>{if(!lost[d]||!m)return[];const i=m.findIndex(v=>v);return i<0?[]:[{t:raw[d].f/FPS,y:Math.floor(i*8/BW)/BH}]}):[],stats:Object.assign(quality(M),{swaps,jumps:jumps(M),ghosts})};
  }
  // 去掉认错的姿态：关键点大多落在空墙上（人全出画面时模型还在凭空猜），或者蒙版大多是墙上的东西（把大岩点当成人）。
  // 去掉之后这几帧不画人，比画一团不像人的东西好
  function ghostFilter(raw,o){
    let ghosts=0;
    const live=raw.map(r=>({f:r.f,poses:r.poses.filter(q=>{const bad=(q.ev!=null&&q.ev<o.ghostEv)||(q.mp!=null&&q.mp<o.ghostMp);if(bad)ghosts++;return !bad})}));
    return{raw:live,ghosts};
  }
  // 画面里可能有旁人：按位置连续性把每帧的人串成轨迹，选“在画面里时间长、而且手往上走得多”的那条
  function chooseClimber(raw){
    const tracks=[];
    for(const r of raw)for(const ps of r.poses){
      let best=null,bd=0.15;
      for(const t of tracks){if(t.last===r.f)continue;const d=Math.hypot(t.cx-ps.cx,t.cy-ps.cy);if(d<bd&&r.f-t.last<=30){bd=d;best=t}}
      if(!best){best={hits:new Map(),cx:0,cy:0,last:-1};tracks.push(best)}
      best.hits.set(r.f,ps.p);best.cx=ps.cx;best.cy=ps.cy;best.last=r.f;
    }
    let pick=null,score=-1;
    for(const t of tracks){
      const ys=[...t.hits.values()].map(p=>(p[2][1]+p[3][1])/2).sort((a,b)=>a-b);
      const rise=ys.length?ys[Math.floor(ys.length*0.95)]-ys[Math.floor(ys.length*0.05)]:0;
      const s=t.hits.size/raw.length*(rise+0.1);
      if(s>score){score=s;pick=t}
    }
    // 默认视频一开始人就在线路上：动态（DYNO）一跳位置突变，轨迹会断成两条，所以选中轨迹之前的帧也归给他（每帧取离后一帧最近的人）
    if(pick&&pick.hits.size){
      const first=Math.min(...pick.hits.keys()),c=p=>[p.reduce((a,q)=>a+q[0],0)/8,p.reduce((a,q)=>a+q[1],0)/8];
      let [x,y]=c(pick.hits.get(first));
      for(let k=raw.length-1;k>=0;k--){
        const r=raw[k];if(r.f>=first||!r.poses.length)continue;
        const q=r.poses.reduce((a,b)=>Math.hypot(b.cx-x,b.cy-y)<Math.hypot(a.cx-x,a.cy-y)?b:a);
        pick.hits.set(r.f,q.p);x=q.cx;y=q.cy;
      }
    }
    return pick;
  }
  // 清洗（MediaPipe 大部分时候稳，坏在少数大跳；大跳会被音频侧误判成“换点”）：
  // 1 漏选的帧补回离攀岩者最近的人；2 左右互换修正（整个人 / 单只手或脚）；
  // 3 每个点 5 次识别（约 1/3 秒）的中值，去掉孤立的大跳，“手停在岩点上”的台阶不受影响；4 ≤6 次识别的空隙插值
  const PAIRS=[[0,1],[2,3],[4,5],[6,7]];
  const dist=(a,b)=>Math.hypot(a[0]-b[0],(a[1]-b[1])*16/9);   // 归一化坐标，按 9:16 换成等比距离
  // 中值窗半宽（识别次数）、参与中值的最低可见度、窗内至少几个、可见度增益。
  // MediaPipe 的 visibility 系统性偏低（找到人时位置通常是准的），×2.5 后再交给音频侧的 0.35 门限
  const CLEAN={half:2,minVis:0.1,minN:3,visGain:2.5,ghostEv:0.35,ghostMp:0.5};
  function clean(raw,pick,o=CLEAN){
    const n=raw.length,S=new Array(n).fill(null);
    let last=null;
    raw.forEach((r,d)=>{
      let p=pick&&pick.hits.get(r.f);
      if(!p&&last)for(const q of r.poses){if(Math.hypot(q.cx-last.cx,q.cy-last.cy)<0.2){p=q.p;break}}
      if(p){S[d]=p.map(q=>q.slice());last={cx:p.reduce((a,q)=>a+q[0],0)/8,cy:p.reduce((a,q)=>a+q[1],0)/8}}
    });
    // swaps 数的是“互换了几段”：MediaPipe 认反之后常常连续很多帧都反着，每帧都要纠正，但只算一次
    let prev=null,swaps=0;const on={body:false,2:false,6:false};
    for(const p of S){
      if(!p)continue;
      if(prev){
        let keep=0,swap=0;for(const [l,r] of PAIRS){keep+=dist(p[l],prev[l])+dist(p[r],prev[r]);swap+=dist(p[l],prev[r])+dist(p[r],prev[l])}
        const b=swap<keep*0.6;if(b)for(const [l,r] of PAIRS)[p[l],p[r]]=[p[r],p[l]];
        if(b&&!on.body)swaps++;on.body=b;
        for(const [l,r] of [[2,3],[6,7]]){const k=dist(p[l],prev[l])+dist(p[r],prev[r]),s=dist(p[l],prev[r])+dist(p[r],prev[l]),x=s<k*0.5;if(x)[p[l],p[r]]=[p[r],p[l]];if(x&&!on[l])swaps++;on[l]=x}
      }
      prev=p;
    }
    const med=a=>{a.sort((x,y)=>x-y);return a[a.length>>1]};
    const M=S.map((p,d)=>p&&p.map((q,k)=>{
      const xs=[],ys=[];
      let vmax=0;
      for(let e=Math.max(0,d-o.half);e<=Math.min(n-1,d+o.half);e++){const z=S[e];if(z&&z[k][2]>=o.minVis){xs.push(z[k][0]);ys.push(z[k][1]);vmax=Math.max(vmax,z[k][2])}}
      const c=Math.min(1,q[2]*o.visGain);
      return xs.length>=o.minN?[med(xs),med(ys),c]:[q[0],q[1],c];
    }));
    for(let d=0;d<n;d++){
      if(M[d]||!d||!M[d-1])continue;
      let e=d;while(e<n&&!M[e])e++;
      if(e<n&&e-d<=6){const a=M[d-1],b=M[e];for(let k=d;k<e;k++){const u=(k-d+1)/(e-d+1);M[k]=a.map((q,j)=>[q[0]+(b[j][0]-q[0])*u,q[1]+(b[j][1]-q[1])*u,Math.min(q[2],b[j][2])])}}
      d=e;
    }
    return{M,swaps};
  }
  // 清洗后还剩多少“大跳”：相邻两次识别之间，手或脚移动超过画面高度的 8%（约 0.13 秒内，正常攀爬做不到）
  function jumps(M){
    let n=0,prev=null;
    for(const p of M){if(p&&prev)for(const k of [2,3,6,7])if(p[k][2]>=0.35&&prev[k][2]>=0.35&&dist(p[k],prev[k])>0.08*16/9)n++;prev=p}
    return n;
  }
  // 识别帧 → 每一帧（30fps）。中间帧取前后两帧的平均；都可信才插值，否则沿用最近的
  function toFrames(S,N){
    const at=f=>S[f/STEP];
    const row=p=>p?p.flatMap(q=>[Math.round(q[0]*1000),Math.round(q[1]*1000),Math.round(q[2]*100)]):new Array(24).fill(0);
    const out=[];
    for(let f=0;f<N;f++){
      const a=Math.floor(f/STEP)*STEP,b=a+STEP,pa=at(a),pb=at(b);
      if(f===a||!pb){out.push(row(pa));continue}
      if(!pa){out.push(row(pb));continue}
      const u=(f-a)/STEP;out.push(row(pa.map((q,k)=>[q[0]+(pb[k][0]-q[0])*u,q[1]+(pb[k][1]-q[1])*u,Math.min(q[2],pb[k][2])])));
    }
    return out;
  }
  // 能不能用：多少帧里有人、四肢看不清的比例
  function quality(S){
    const got=S.filter(Boolean),hidden=got.filter(p=>[2,3,6,7].filter(k=>p[k][2]<0.35).length>=2).length;
    return{seen:got.length/S.length,hidden:got.length?hidden/got.length:1};
  }
  // 抽帧质检：平均亮度（0..255）；全透明或几乎全黑算空白帧（没读到画面）
  const luma=d=>{let s=0;for(let i=0;i<d.length;i+=16)s+=d[i]+d[i+1]+d[i+2];return s/(d.length/16)/3};
  const blank=d=>{let a=0;for(let i=3;i<d.length;i+=16)a+=d[i];return a===0||luma(d)<4};
  // 空墙（180×320 canvas）：逐像素逐通道取中值，只用这个像素没被人挡住的帧（人的范围外扩 4 像素，影子也避开）。
  // 不到一半的帧没被挡的像素 known=0，颜色退回全部帧的中值：模型偶尔漏掉人，只靠少数几帧会把静止的人当成墙
  function wallOf(samples){
    const c=document.createElement('canvas');c.width=BW;c.height=BH;
    const known=new Uint8Array(BW*BH);
    if(!samples.length)return{canvas:c,known};
    const g=c.getContext('2d'),img=g.createImageData(BW,BH),n=samples.length;
    const free=samples.map(({person:b})=>{
      const m=new Uint8Array(BW*BH);if(!b)return m;
      for(let y=0;y<BH;y++)for(let x=0;x<BW;x++){const k=y*BW+x;if(b[k>>3]>>(k&7)&1)for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const a=x+dx,e=y+dy;if(a>=0&&e>=0&&a<BW&&e<BH)m[e*BW+a]=1}}
      return m;
    });
    const col=new Uint8Array(n),med=m=>{const a=col.subarray(0,m).sort();return a[m>>1]};
    for(let k=0;k<BW*BH;k++){
      let use=0;for(let s=0;s<n;s++)if(!free[s][k])use++;
      known[k]=use>=Math.max(3,n/2)?1:0;
      for(let ch=0;ch<3;ch++){
        let m=0;for(let s=0;s<n;s++)if(!known[k]||!free[s][k])col[m++]=samples[s].d[k*4+ch];
        img.data[k*4+ch]=med(m);
      }
      img.data[k*4+3]=255;
    }
    g.putImageData(img,0,0);return{canvas:c,known};
  }
  return{analyze,scan,finish,load,cropOf,CLEAN,CFG,logs};   // scan/finish/CLEAN 也给测试脚本用
})();
