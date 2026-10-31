// 点阵可视化（DESIGN-SPEC §4、§5、§7）。所有绘制都在 720×1280 的逻辑坐标里，按画布宽度缩放。
// 参考实现：design/tools/holds2.py render()、render.py silhouette()。
// 读引擎的全局量（ser、EV、P、handNotes、chordTones、nearest、footMidiK、nname、topT、vid），只读不写。
const Viz=(()=>{
  const W=720,H=1280,C=8,GW=90,GH=160;
  const INK='#141418',PAPER='#F5F5F3',ROUTE='#7B4DFF';
  const LIMBS=['Lw','Rw','La','Ra'];
  const COL={Lw:'#4DA3FF',Rw:'#FF5A4D',La:'#3ECF8E',Ra:'#FFB347'};
  const NAME={Lw:'左手',Rw:'右手',La:'左脚',Ra:'右脚'};
  const GRAB=Route.allGrabs(D);          // 已抓过的岩点（视觉用，§6 的阈值）
  const pt=(k,i)=>[ser[k].x[i]*W,ser[k].y[i]*H];
  const snap=v=>Math.floor(v/C)*C+C/2;
  const fi=t=>Math.max(0,Math.min(N-1,Math.floor(t*FPS)));

  // 画布按 CSS 尺寸 × DPR 设像素，再把 720 宽的逻辑坐标缩放进去；返回 CSS 像素→逻辑坐标的比例
  function fit(cv){
    const r=cv.getBoundingClientRect(),d=Math.min(2,devicePixelRatio||1),w=Math.round(r.width*d),h=Math.round(r.height*d);
    if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h}
    const g=cv.getContext('2d');g.setTransform(w/W,0,0,w/W,0,0);g.clearRect(0,0,W,H);
    return{g,css:W/Math.max(1,r.width)};
  }
  const circle=(g,x,y,r,fill,a=1)=>{g.globalAlpha=a;g.fillStyle=fill;g.beginPath();g.arc(x,y,r,0,7);g.fill();g.globalAlpha=1};
  const ring=(g,x,y,r,lw,stroke,a=1)=>{g.globalAlpha=a;g.strokeStyle=stroke;g.lineWidth=lw;g.beginPath();g.arc(x,y,r,0,7);g.stroke();g.globalAlpha=1};

  /* ---- 人（design/SILHOUETTE.md）：out = (真实轮廓 ∩ 骨架外扩 13px) ∪ 骨架线段 → 90×160 覆盖率 ----
     真实轮廓来自 silhouette.js（帧 − 空墙）；拿不到时只用骨架线段。每格 4×4 采样，正好对上 360×640 掩膜的像素。 */
  const NEAR=13;   // 外扩半径（720 坐标）。想更饱满可到 18，别超过 20（=40px 核），会糊
  function segD(px,py,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy,u=l?Math.max(0,Math.min(1,((px-a[0])*dx+(py-a[1])*dy)/l)):0;return Math.hypot(px-a[0]-u*dx,py-a[1]-u*dy)}
  function coverage(i){
    const p={};['Ls','Rs','Lw','Rw','Lh','Rh','La','Ra'].forEach(k=>p[k]=pt(k,i));
    const sm=[(p.Ls[0]+p.Rs[0])/2,(p.Ls[1]+p.Rs[1])/2],hm=[(p.Lh[0]+p.Rh[0])/2,(p.Lh[1]+p.Rh[1])/2];
    const head=[sm[0]+(sm[0]-hm[0])*0.38,sm[1]+(sm[1]-hm[1])*0.38];
    const S=[[sm,hm,31],[p.Ls,p.Rs,15],[p.Lh,p.Rh,17],[p.Ls,p.Lw,13],[p.Rs,p.Rw,13],[p.Lh,p.La,15],[p.Rh,p.Ra,15]];
    const mask=Sil.get(i),pad=mask?31+NEAR:32;
    let x0=head[0]-24-NEAR,x1=head[0]+24+NEAR,y0=head[1]-24-NEAR,y1=head[1]+24+NEAR;
    for(const k in p){x0=Math.min(x0,p[k][0]-pad);x1=Math.max(x1,p[k][0]+pad);y0=Math.min(y0,p[k][1]-pad);y1=Math.max(y1,p[k][1]+pad)}
    const gx0=Math.max(0,Math.floor(x0/C)),gx1=Math.min(GW-1,Math.floor(x1/C)),gy0=Math.max(0,Math.floor(y0/C)),gy1=Math.min(GH-1,Math.floor(y1/C));
    const grid=new Float32Array(GW*GH);
    for(let gy=gy0;gy<=gy1;gy++)for(let gx=gx0;gx<=gx1;gx++){
      let hit=0;
      for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++){
        const x=gx*C+1+2*sx,y=gy*C+1+2*sy;
        // 到骨架的最近“超出半径”的距离：≤0 在骨架里，≤NEAR 在外扩带里
        let d=Math.hypot(x-head[0],y-head[1])-24;
        for(const [a,b,r] of S){d=Math.min(d,segD(x,y,a,b)-r);if(d<=0)break}
        if(d<=0||(mask&&d<=NEAR&&Sil.at(mask,(gx*4+sx),(gy*4+sy))))hit++;
      }
      grid[gy*GW+gx]=hit/16;
    }
    return grid;
  }
  // 3 帧中值：对第 i、i−1、i−2 帧的覆盖率逐格取中值（只有两帧就取平均），防止点阵边缘每帧抖
  const covCache=new Map();
  function smoothed(i){
    let gr=covCache.get(i);
    if(!gr||gr.mask!==!!Sil.get(i)){gr=coverage(i);gr.mask=!!Sil.get(i);covCache.set(i,gr);if(covCache.size>6)covCache.delete(covCache.keys().next().value)}
    const [A,B,Z]=[gr,covCache.get(i-1),covCache.get(i-2)].filter(Boolean),out=[];
    for(let k=0;k<GW*GH;k++){
      const a=A[k],b=B?B[k]:0,c=Z?Z[k]:0;if(!(a||b||c))continue;
      const v=Z?Math.max(Math.min(a,b),Math.min(Math.max(a,b),c)):B?(a+b)/2:a;   // 三个数的中值
      if(v>0.30)out.push((k%GW)*C+C/2,((k/GW)|0)*C+C/2,v);
    }
    return out;
  }
  function body(g,i,halo=.6,ink=.88){
    const c=smoothed(i);
    for(let k=0;k<c.length;k+=3){const r=1.6+2.6*Math.min(c[k+2],1);circle(g,c[k],c[k+1],r+1.2,'#fff',halo);circle(g,c[k],c[k+1],r,INK,ink)}
  }

  /* ---- 静态层缓存：路线紫点 ---- */
  const cache={};
  function layer(name,w,draw){
    const k=name+w;if(cache[k])return cache[k];
    const c=document.createElement('canvas');c.width=w;c.height=Math.round(w*H/W);
    const g=c.getContext('2d');g.setTransform(w/W,0,0,w/W,0,0);draw(g);return cache[k]=c;
  }
  const routeLayer=g=>{const d=CLIMB_DATA.dots;g.fillStyle=ROUTE;for(let k=0;k<d.length;k+=2){g.beginPath();g.arc(d[k],d[k+1],2.7,0,7);g.fill()}};
  const blit=(g,cv,name,draw)=>{g.save();g.setTransform(1,0,0,1,0,0);g.drawImage(layer(name,cv.width,draw),0,0);g.restore()};

  /* ---- 抓过的岩点：白圈 + 肢体色圈，越爬越多 ---- */
  function rings(g,i){
    for(const k of LIMBS)for(const e of GRAB[k])if(e.f<=i){ring(g,e.x,e.y,12,4,'#fff',235/255);ring(g,e.x,e.y,9.5,3,COL[k])}
  }
  /* ---- 近 1.5 秒轨迹 ---- */
  function trails(g,i){
    for(const k of LIMBS)for(let s=45;s>=0;s-=3){
      const a=1-s/45,[x,y]=pt(k,Math.max(0,i-s)),cx=snap(x),cy=snap(y),r=2.4+3.6*a;
      circle(g,cx,cy,r+1.5,'#fff',200/255*a);circle(g,cx,cy,r,COL[k],.24+.76*a);
    }
  }
  /* ---- 四肢节点 + 发声瞬间的方框 + 音名胶囊 ---- */
  // 发声事件直接用引擎的 EV（和声音同一套检测），按视频时间算，不依赖 AudioContext
  function events(t,win){
    const out=[];
    for(const k of LIMBS)for(const e of EV[k]){const age=t-e/FPS;if(age>=0&&age<win)out.push({k,e,age})}
    return out;
  }
  function noteOf(k,e){
    if(k[1]==='w'){let m=handNotes(e)[k==='Lw'?0:1];if(P.tsnap==='chord')m=nearest(chordTones(e,m-8,m+8),m);return nname(m)}
    return nname(footMidiK(k,Math.min(N-1,e)));
  }
  function square(g,x,y,r,lw,col,a){
    g.globalAlpha=a*.8;g.strokeStyle='#fff';g.lineWidth=lw+2;g.strokeRect(x-r-1,y-r-1,2*r+2,2*r+2);
    g.globalAlpha=a;g.strokeStyle=col;g.lineWidth=lw;g.strokeRect(x-r,y-r,2*r,2*r);g.globalAlpha=1;
  }
  function nodes(g,i,t,css,{boxes=true,tags=true}={}){
    const box=boxes?events(t,0.3):[];
    for(const k of LIMBS){
      const [x,y]=pt(k,i),cx=snap(x),cy=snap(y);
      circle(g,cx,cy,10,'#fff');circle(g,cx,cy,7,COL[k]);
      for(const b of box)if(b.k===k){const a=1-b.age/0.3;square(g,cx,cy,13.5,3,COL[k],.92*a);square(g,cx,cy,26,2,COL[k],.43*a)}
    }
    if(!tags)return;
    const placed=[];
    for(const b of events(t,0.6)){
      const [x,y]=pt(b.k,i),a=Math.min(1,(0.6-b.age)/0.25);
      tag(g,snap(x),snap(y),noteOf(b.k,b.e)+' '+NAME[b.k],COL[b.k],a,css,placed);
    }
  }
  // 胶囊：纸白底，12px 加粗，前面一个肢体色圆点（尺寸按 CSS 像素给，再换算到逻辑坐标）
  function tag(g,x,y,text,col,a,css,placed){
    const s=css;g.font=`700 ${12*s}px "Noto Sans SC",system-ui,sans-serif`;
    const tw=g.measureText(text).width,w=(8+8+6+11)*s+tw,h=26*s;
    let L=Math.min(W-w-4*s,x+16*s),T=Math.max(4*s,y-24*s-h/2);
    for(const p of placed)if(L<p[0]+p[2]&&L+w>p[0]&&T<p[1]+p[3]&&T+h>p[1])T=p[1]+p[3]+4*s;
    placed.push([L,T,w,h]);
    g.globalAlpha=a;
    g.beginPath();g.roundRect(L,T,w,h,h/2);g.fillStyle=PAPER;g.fill();g.strokeStyle='rgba(20,20,24,.12)';g.lineWidth=s;g.stroke();
    g.fillStyle=col;g.beginPath();g.arc(L+(8+4)*s,T+h/2,4*s,0,7);g.fill();
    g.fillStyle=INK;g.textBaseline='middle';g.textAlign='left';g.fillText(text,L+(8+8+6)*s,T+h/2+.5*s);
    g.globalAlpha=1;
  }
  /* ---- TOP：四肢四色小圆点从两手之间迸散，约 1 秒淡出 ---- */
  const BURST=(()=>{let s=7;const r=()=>(s=(s*16807)%2147483647)/2147483647;
    // a 方向（偏向上方），d 飞多远（CSS px），sz 直径（CSS px），dl 起飞延迟
    return Array.from({length:14},(_,n)=>({a:-Math.PI/2+(r()-.5)*Math.PI*1.6,d:40+110*r(),sz:6+3*r(),k:LIMBS[n%4],dl:0.08*r()}))})();
  function burst(g,t,css){
    if(topT==null)return;const e=t-topT;if(e<0||e>1.1)return;
    const i=fi(topT),[ax,ay]=pt('Lw',i),[bx,by]=pt('Rw',i),cx=(ax+bx)/2,cy=(ay+by)/2;
    for(const p of BURST){
      const u=Math.max(0,Math.min(1,(e-p.dl)/0.9));if(u<=0)continue;
      const k=1-Math.pow(1-u,3),x=cx+Math.cos(p.a)*p.d*k*css,y=cy+Math.sin(p.a)*p.d*k*css;
      circle(g,x,y,p.sz*css/2,COL[p.k],u<0.6?1:1-(u-0.6)/0.4);
    }
  }
  // 髋部中点的虚线轨迹（41 帧均值平滑，每 15px 一个点）
  function hipPath(g,i){
    const L=Route.track(D,4),R=Route.track(D,5),raw=L.map((p,t)=>[(p[0]+R[t][0])/2,(p[1]+R[t][1])/2]);   // 没识别到人的帧沿用上一个位置
    const sm=[];for(let t=0;t<=i;t++){let x=0,y=0;for(let k=t-20;k<=t+20;k++){const q=raw[Math.max(0,Math.min(N-1,k))];x+=q[0];y+=q[1]}sm.push([x/41,y/41])}
    let acc=0;
    for(let t=2;t<sm.length;t+=2){acc+=Math.hypot(sm[t][0]-sm[t-2][0],sm[t][1]-sm[t-2][1]);
      if(acc>=15){acc=0;circle(g,sm[t][0],sm[t][1],5.2,'#fff',235/255);circle(g,sm[t][0],sm[t][1],3.2,INK)}}
  }

  // 诊断（地址加 ?debug=1）：左上角写出视频、空墙、路线、轮廓的状态，手机上截图就能看出哪一步没拿到像素
  const DEBUG=/[?&]debug=1/.test(location.search);
  function diag(g,css){
    const b=typeof Pose!=='undefined'&&Pose.bgInfo,ref=typeof App!=='undefined'&&App.routeDots&&App.routeDots.ref;
    const lines=['版本 '+window.BUILD,
      `视频 rs=${vid.readyState} ${vid.paused?'暂停':'播放'} ${vid.videoWidth}×${vid.videoHeight}`,
      b?`空墙 用${b.used}帧 空白${b.blank} 救回${b.rescued} 亮度${b.luma}`:'空墙 无记录',
      '路线 '+(ref?`类${ref.cls} ${ref.votes}/${ref.of}票${ref.unsure?' 不确定':''}`:'没有投票')+' 紫点'+CLIMB_DATA.dots.length/2,
      '轮廓 '+Sil.stat,
      `播放 t=${vid.currentTime.toFixed(2)} seeking=${vid.seeking} err=${vid.error?vid.error.code:'无'}`,
      `play()=${App.playRes||'没点'} 会话=${navigator.audioSession?navigator.audioSession.type:'不支持'}`];
    const s=css;g.font=`500 ${11*s}px ui-monospace,monospace`;g.textBaseline='top';g.textAlign='left';
    g.fillStyle='rgba(255,255,255,.85)';g.fillRect(0,0,W,(lines.length*15+8)*s);
    g.fillStyle=INK;lines.forEach((l,k)=>g.fillText(l,6*s,(4+15*k)*s));
  }

  return{
    COL,NAME,GRAB,
    // 播放页叠加层：视频（灰度 + 纸白 80%）在下面，由 CSS 负责
    player(cv,t){
      const {g,css}=fit(cv),i=fi(t);
      blit(g,cv,'route',routeLayer);
      Sil.capture(vid,i);   // 读当前显示的视频帧做人形轮廓（按帧缓存）
      // 这一帧没认到攀岩者（还在走向岩壁、走出画面）就不画人，否则人形会停在第一次认到的位置，和视频里的人对不上
      const row=CLIMB_DATA.kp[i],seen=row&&[2,5,8,11,14,17,20,23].some(k=>row[k]>=35);
      if(seen){rings(g,i);body(g,i);trails(g,i);nodes(g,i,t,css)}
      burst(g,t,css);
      if(DEBUG)diag(g,css);
    },
    // 分享卡路线图：TOP 那一帧（灰度 + 80% 纸白，和播放页同一个底）+ 路线紫点 + 抓过的岩点 + 髋部虚线 + 停在 TOP 的剪影
    share(cv,t,frame){
      const {g}=fit(cv),i=fi(t);
      g.fillStyle=PAPER;g.fillRect(0,0,W,H);
      if(frame)g.drawImage(frame,0,0,W,H);
      blit(g,cv,'route',routeLayer);
      rings(g,i);hipPath(g,i);body(g,i,150/255,225/255);
    }
  };
})();
