// 姿态识别（HANDOFF P0-2）：在用户手机上用 MediaPipe Pose Landmarker 逐帧找人，视频不离开设备。
// 输出和原来离线管线（tools/make_data.py）同一格式：每帧 8 个点 [x,y,conf]，x,y 归一化到 0..1000，conf×100，30fps。
// 同一遍扫描里顺便抽帧算“空墙”（逐像素中值），给路线岩点和人形轮廓用。
const Pose=(()=>{
  const VER='0.10.14';
  const LIB=`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
  const MODEL='https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
  const IDX=[11,12,15,16,23,24,27,28];   // MediaPipe 33 点 → Ls Rs Lw Rw Lh Rh La Ra（左右都是攀岩者自己的左右，和 COCO 一致）
  const FPS=30,STEP=2;                    // 每 2 帧识别一次（15fps），中间帧插值，手机上快一倍
  const BW=180,BH=320,BG_MAX=48;          // 空墙在 180×320 上算，最多抽 48 帧（手机内存）
  let lm=null;

  async function load(){
    if(lm)return lm;
    const vision=await import(`${LIB}/vision_bundle.mjs`);
    const files=await vision.FilesetResolver.forVisionTasks(`${LIB}/wasm`);
    const opt=d=>({baseOptions:{modelAssetPath:MODEL,delegate:d},runningMode:'VIDEO',numPoses:2,
      minPoseDetectionConfidence:0.3,minPosePresenceConfidence:0.3,minTrackingConfidence:0.3});
    try{lm=await vision.PoseLandmarker.createFromOptions(files,opt('GPU'))}
    catch(e){lm=await vision.PoseLandmarker.createFromOptions(files,opt('CPU'))}   // 没有 WebGL 时退回 CPU
    return lm;
  }
  // 竖屏 9:16 的居中裁切（和播放页 object-fit:cover 一致），视频像素坐标
  function cropOf(vw,vh){
    const want=9/16;
    if(vw/vh>want){const sw=vh*want;return{sx:(vw-sw)/2,sy:0,sw,sh:vh}}
    const sh=vw/want;return{sx:0,sy:(vh-sh)/2,sw:vw,sh};
  }
  const seek=(v,t)=>new Promise(r=>{v.addEventListener('seeked',r,{once:true});v.currentTime=t});

  // 主流程 = 扫描（逐帧识别，所有人都留着）+ 整理（选攀岩者、清洗、插值）。
  // onStage('model'|'scan'|'post')，onProgress(已识别帧, 总帧)；abort() 返回 true 就停
  async function analyze(url,cb){
    const s=await scan(url,cb);
    cb.onStage('post');
    const r=finish(s);
    return{kp:r.kp,N:s.N,dur:s.dur,crop:s.crop,vw:s.vw,vh:s.vh,bg:s.bg,stats:r.stats};
  }
  // 扫描。keep>0 时每 keep 帧另存一张 180×320 缩略帧（tools/extract_kp.js 用，线上不存）
  async function scan(url,{onStage=()=>{},onProgress=()=>{},abort=()=>false,keep=0}={}){
    onStage('model');
    let det;try{det=await load()}catch(e){console.error('pose: 模型加载失败',e);throw new Error('model')}
    const v=document.createElement('video');v.muted=true;v.playsInline=true;v.preload='auto';v.src=url;
    await new Promise((ok,bad)=>{v.onloadeddata=ok;v.onerror=()=>bad(new Error('unreadable'))});
    try{await v.play();v.pause()}catch(e){}   // iOS 上不先播一下不肯解码
    const vw=v.videoWidth,vh=v.videoHeight,crop=cropOf(vw,vh),dur=v.duration,N=Math.max(2,Math.round(dur*FPS));
    const bgEvery=Math.max(10,Math.ceil(N/BG_MAX/STEP)*STEP),bgFrames=[];
    const bc=document.createElement('canvas');bc.width=BW;bc.height=BH;const bg=bc.getContext('2d',{willReadFrequently:true});
    const raw=[],frames=new Map();   // raw 每个识别帧：{f, poses:[{p:[[x,y,vis]×8],cx,cy}]}
    onStage('scan');
    for(let f=0;f<N;f+=STEP){
      if(abort())throw new Error('abort');
      await seek(v,Math.min(dur-0.001,(f+0.5)/FPS));
      let res;try{res=det.detectForVideo(v,Math.round(f*1000/FPS)+1)}catch(e){console.error('pose: 识别失败',e);throw new Error('device')}
      raw.push({f,poses:(res.landmarks||[]).map(L=>{
        const p=IDX.map(k=>{const q=L[k];return[((q.x*vw)-crop.sx)/crop.sw,((q.y*vh)-crop.sy)/crop.sh,q.visibility==null?1:q.visibility]});
        const cx=p.reduce((a,q)=>a+q[0],0)/8,cy=p.reduce((a,q)=>a+q[1],0)/8;
        return{p,cx,cy};
      })});
      if(f%bgEvery===0){bg.drawImage(v,crop.sx,crop.sy,crop.sw,crop.sh,0,0,BW,BH);bgFrames.push(bg.getImageData(0,0,BW,BH).data)}
      if(keep&&f%keep===0){const c=document.createElement('canvas');c.width=BW;c.height=BH;c.getContext('2d').drawImage(v,crop.sx,crop.sy,crop.sw,crop.sh,0,0,BW,BH);frames.set(f,c)}
      onProgress(Math.min(N,f+STEP),N);
      if(f%20===0)await new Promise(r=>setTimeout(r,0));   // 让出主线程，进度条能动
    }
    return{raw,N,dur,crop,vw,vh,bg:median(bgFrames),frames};
  }
  // 整理：扫描结果 → 每帧 8 点（30fps）+ 质量统计。只依赖 raw 和 N，参数改了可以离线重跑
  function finish({raw,N},o=CLEAN){
    const pick=chooseClimber(raw),{M,swaps}=clean(raw,pick,o);
    return{kp:toFrames(M,N),S:M,stats:Object.assign(quality(M),{swaps,jumps:jumps(M)})};
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
    return pick;
  }
  // 清洗（MediaPipe 大部分时候稳，坏在少数大跳；大跳会被音频侧误判成“换点”）：
  // 1 漏选的帧补回离攀岩者最近的人；2 左右互换修正（整个人 / 单只手或脚）；
  // 3 每个点 5 次识别（约 1/3 秒）的中值，去掉孤立的大跳，“手停在岩点上”的台阶不受影响；4 ≤6 次识别的空隙插值
  const PAIRS=[[0,1],[2,3],[4,5],[6,7]];
  const dist=(a,b)=>Math.hypot(a[0]-b[0],(a[1]-b[1])*16/9);   // 归一化坐标，按 9:16 换成等比距离
  // 中值窗半宽（识别次数）、参与中值的最低可见度、窗内至少几个、可见度增益。
  // MediaPipe 的 visibility 比 YOLO 的置信度系统性偏低（找到人时位置通常是准的），×2.5 后再交给音频侧的 0.35 门限；
  // 在 4 段测试视频上通用（samples/report/summary.md 第 2 轮），不是为某一段调的
  const CLEAN={half:2,minVis:0.1,minN:3,visGain:2.5};
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
  // 逐像素逐通道中值 → 空墙（180×320 canvas）
  function median(frames){
    const c=document.createElement('canvas');c.width=BW;c.height=BH;
    if(!frames.length)return c;
    const g=c.getContext('2d'),img=g.createImageData(BW,BH),n=frames.length,col=new Uint8Array(n);
    for(let i=0;i<img.data.length;i++){if(i%4===3){img.data[i]=255;continue}for(let k=0;k<n;k++)col[k]=frames[k][i];col.sort();img.data[i]=col[n>>1]}
    g.putImageData(img,0,0);return c;
  }
  return{analyze,scan,finish,load,cropOf,CLEAN};   // scan/finish/CLEAN 给 tools/extract_kp.js、tools/report.js 用
})();
