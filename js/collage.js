// 拼贴画面：视频转中性黑白，人是灰色，白线绕身体，抓点时贴黑白灰的剪纸，手边出剪报字音名，左边是音高刻度和四肢的亮线。
// 画面和视频都是 12 帧。逻辑坐标 720×1280，和 viz.js 一致。读引擎的全局量（ser、EV、R、N、FPS、vid），只读不写。
const Collage=(()=>{
  const W=720,H=1280,MW=180,MH=320;
  const LIMBS=['Lw','Rw','La','Ra'];
  const noise=(a,b=0)=>{const s=Math.sin(a*127.1+b*311.7)*43758.5453;return s-Math.floor(s)};
  const cropOf=()=>CLIMB_DATA.crop||{sx:0,sy:0,sw:vid.videoWidth,sh:vid.videoHeight};
  const drawCrop=(q,v,w,h)=>{const c=cropOf();q.drawImage(v,c.sx,c.sy,c.sw,c.sh,0,0,w,h)};

  // 刻度：B♭ 小调五声两个八度，位置是手范围里这个音对应的高度（和引擎的 rows() 同一种映射，只用于画面）
  function handRows(){
    const PCS=[0,3,5,7,10],start=58,want=PCS.length*2+1,n=[];
    for(let o=0;n.length<want;o++)for(const i of PCS)if(n.length<want)n.push(start+o*12+i);
    const seen=new Map();
    for(let row=0;row<32;row++){const m=n[Math.floor(row*n.length/32)],h=R.hand[0]+(row/31)*(R.hand[1]-R.hand[0]);if(!seen.has(m))seen.set(m,[]);seen.get(m).push(h)}
    return[...seen].map(([m,hs])=>({m,y:1-hs.reduce((a,b)=>a+b,0)/hs.length}));
  }
  // 蒙版是 1 位图，用到时才展开，只留最近几张
  const unpacked=new Map();
  function bit(d){
    const b=CLIMB_DATA.masks&&CLIMB_DATA.masks[d];if(!b)return null;
    let m=unpacked.get(d);if(m)return m;
    m=new Uint8Array(MW*MH);for(let k=0;k<m.length;k++)m[k]=b[k>>3]>>(k&7)&1;
    unpacked.set(d,m);if(unpacked.size>6)unpacked.delete(unpacked.keys().next().value);
    return m;
  }
  const D={N,fps:FPS,ser,rows:handRows(),bit,fields:new Map(),grid:Acid&&Acid.S16,gridPh:Acid&&Acid.PH,
    pt:(k,i)=>{i=Math.max(0,Math.min(N-1,i));return[ser[k].x[i]*W,ser[k].y[i]*H]},
    seen:CLIMB_DATA.kp.map(row=>[2,5,8,11,14,17,20,23].some(k=>row[k]>=35)),
    ev:LIMBS.flatMap(k=>EV[k].map(f=>({k,f}))).sort((a,b)=>a.f-b.f)};

  // 蒙版 → 平滑场 F。前后两张蒙版一起平均，边缘不抖。只在人附近算
  function field(D,i){
    const d=i>>1;let hit=D.fields.get(d);if(hit!==undefined)return hit;
    const pick=x=>D.bit(x);
    if(!pick(d)&&!pick(d-1)&&!pick(d+1)){D.fields.set(d,null);return null}
    let F=new Float32Array(MW*MH),bx0=MW,bx1=-1,by0=MH,by1=-1;
    [[d-1,.25],[d,.5],[d+1,.25]].forEach(([x,w])=>{const m=pick(x)||pick(d)||pick(d-1)||pick(d+1);for(let y=0;y<MH;y++){const r=y*MW;for(let c=0;c<MW;c++)if(m[r+c]){F[r+c]+=w;if(c<bx0)bx0=c;if(c>bx1)bx1=c;if(y<by0)by0=y;if(y>by1)by1=y}}});
    for(let p=0;p<2;p++){bx0=Math.max(0,bx0-1);bx1=Math.min(MW-1,bx1+1);by0=Math.max(0,by0-1);by1=Math.min(MH-1,by1+1);F=box(F,bx0,bx1,by0,by1)}
    let x0=MW,x1=0,y0=MH,y1=0;
    for(let y=by0;y<=by1;y++)for(let x=bx0;x<=bx1;x++)if(F[y*MW+x]>.5){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}
    const r={F,x0,x1,y0,y1,empty:x1<x0};
    D.fields.set(d,r);if(D.fields.size>16)D.fields.delete(D.fields.keys().next().value);
    return r;
  }
  function box(a,x0,x1,y0,y1){
    const o=new Float32Array(a.length),t=new Float32Array(a.length),n=3;
    for(let y=y0;y<=y1;y++){const r=y*MW;for(let x=x0;x<=x1;x++)t[r+x]=(a[r+Math.max(0,x-1)]+a[r+x]+a[r+Math.min(MW-1,x+1)])/n}
    for(let y=y0;y<=y1;y++){const u=Math.max(0,y-1)*MW,r=y*MW,e=Math.min(MH-1,y+1)*MW;for(let x=x0;x<=x1;x++)o[r+x]=(t[u+x]+t[r+x]+t[e+x])/n}
    return o;
  }
  // 轮廓线：marching squares，返回每条闭合/开放线的点列（720 坐标），短的小块丢掉。边编号 2*(y*MW+x)，横边偶数、竖边奇数；每条边最多连两段
  const EDGES=2*MW*MH,linkA=new Int32Array(EDGES).fill(-1),linkB=new Int32Array(EDGES).fill(-1),posX=new Float32Array(EDGES),posY=new Float32Array(EDGES),visited=new Uint8Array(EDGES);
  function contours(f,th){
    const F=f.F,order=[];
    const eh=(x,y)=>2*(y*MW+x),ev=(x,y)=>2*(y*MW+x)+1;
    const P=(id,x0,y0,x1,y1,a,b)=>{if(linkA[id]<0&&!visited[id]){const u=(th-a)/(b-a);posX[id]=(x0+(x1-x0)*u)*4+2;posY[id]=(y0+(y1-y0)*u)*4+2}return id};
    const add=(a,b)=>{if(linkA[a]<0){linkA[a]=b;order.push(a)}else linkB[a]=b};
    const link=(a,b)=>{add(a,b);add(b,a)};
    for(let y=Math.max(0,f.y0-1);y<=Math.min(MH-2,f.y1);y++)for(let x=Math.max(0,f.x0-1);x<=Math.min(MW-2,f.x1);x++){
      const a=F[y*MW+x],b=F[y*MW+x+1],c=F[(y+1)*MW+x+1],d=F[(y+1)*MW+x];
      const n=(a>th)|((b>th)<<1)|((c>th)<<2)|((d>th)<<3);if(n===0||n===15)continue;
      const T=()=>P(eh(x,y),x,y,x+1,y,a,b),R=()=>P(ev(x+1,y),x+1,y,x+1,y+1,b,c),B=()=>P(eh(x,y+1),x,y+1,x+1,y+1,d,c),L=()=>P(ev(x,y),x,y,x,y+1,a,d);
      switch(n){
        case 1:case 14:link(L(),T());break;case 2:case 13:link(T(),R());break;case 4:case 11:link(R(),B());break;case 8:case 7:link(B(),L());break;
        case 3:case 12:link(L(),R());break;case 6:case 9:link(T(),B());break;case 5:link(L(),T());link(R(),B());break;case 10:link(T(),R());link(B(),L());break;
      }
    }
    const out=[];
    for(const start of order){
      if(visited[start])continue;
      const line=[];let cur=start,prev=-1;
      while(cur>=0&&!visited[cur]){
        visited[cur]=1;line.push([posX[cur],posY[cur]]);
        const a=linkA[cur],b=linkB[cur],nx=a>=0&&a!==prev&&!visited[a]?a:b>=0&&b!==prev&&!visited[b]?b:-1;prev=cur;cur=nx;
      }
      if(line.length>24)out.push(line);
    }
    for(const id of order){linkA[id]=linkB[id]=-1;visited[id]=0}
    return out;
  }
  const contourCache=new Map();
  function resample(l,step){
    const o=[l[0]];let acc=0;
    for(let k=1;k<=l.length;k++){const a=l[k-1],b=l[k%l.length],d=Math.hypot(b[0]-a[0],b[1]-a[1]);acc+=d;if(acc>=step){acc=0;o.push(b)}}
    return o;
  }
  function active(D,t,win){
    const o=[];
    for(const e of D.ev){const age=t-(D.grid?Math.ceil((e.f/D.fps-(D.gridPh||0))/D.grid)*D.grid+(D.gridPh||0):e.f/D.fps);if(age>=0&&age<win){const [x,y]=D.pt(e.k,e.f);o.push({...e,age,x,y,hand:e.k[1]==='w'})}}
    return o;
  }
  const CFPS=12;
  const rnd=noise;
  const linesF=(D,i)=>{
    const key='F'+(i>>1);let c=contourCache.get(key);if(c)return c;
    const f=field(D,i);c=f?contours(f,.5).map(l=>resample(l,12)):[];
    contourCache.set(key,c);if(contourCache.size>16)contourCache.delete(contourCache.keys().next().value);
    return c;
  };
  // 手绘感的闭合曲线
  function softPath(ls,amp,seed){
    const p=new Path2D();
    ls.forEach((l,li)=>{
      const n=l.length,q=l.map(([x,y],k)=>[x+(rnd(k+li*9,seed)-.5)*2*amp,y+(rnd(k+li*9+50,seed)-.5)*2*amp]);
      p.moveTo((q[n-1][0]+q[0][0])/2,(q[n-1][1]+q[0][1])/2);
      for(let k=0;k<n;k++){const b=q[(k+1)%n];p.quadraticCurveTo(q[k][0],q[k][1],(q[k][0]+b[0])/2,(q[k][1]+b[1])/2)}
      p.closePath();
    });
    return p;
  }
  // 剪刀剪出来的折线：点隔几个取一个
  function cutPath(ls,every,amp,seed){
    const p=new Path2D();
    ls.forEach((l,li)=>{
      let first=true;
      for(let k=0;k<l.length;k+=every){const x=l[k][0]+(rnd(k+li,seed)-.5)*2*amp,y=l[k][1]+(rnd(k+li+50,seed)-.5)*2*amp;first?p.moveTo(x,y):p.lineTo(x,y);first=false}
      p.closePath();
    });
    return p;
  }
  // 灰色半调网点和纸的颗粒（小图，当 pattern 平铺）
  let grainTile=null,dotTile=null,grainPat=null,dotPat=null;
  function tiles(){
    if(grainTile)return;
    grainTile=document.createElement('canvas');grainTile.width=grainTile.height=128;
    const t=grainTile.getContext('2d'),im=t.createImageData(128,128);
    for(let k=0;k<im.data.length;k+=4){const v=rnd(k*.13,k*.07)*255;im.data[k]=im.data[k+1]=im.data[k+2]=v;im.data[k+3]=255}
    t.putImageData(im,0,0);
    dotTile=document.createElement('canvas');dotTile.width=dotTile.height=12;
    const d=dotTile.getContext('2d');d.fillStyle='#D8D8D4';d.fillRect(0,0,12,12);d.fillStyle='#141418';d.beginPath();d.arc(6,6,3,0,7);d.fill();
    const pat=grainTile.getContext('2d');grainPat=pat.createPattern(grainTile,'repeat');dotPat=pat.createPattern(dotTile,'repeat');
  }
  // 图层只在 rect（设备像素）里画：人只占画面一小块，这样不用每帧清空、合成整张画布。layerOf 和 blitLayer 成对调用
  const rectOf=(g,x0,y0,x1,y1)=>{
    const cv=g.canvas,S=cv.width/W,x=Math.max(0,Math.floor(x0*S)),y=Math.max(0,Math.floor(y0*S)),e=Math.min(cv.width,Math.ceil(x1*S)),b=Math.min(cv.height,Math.ceil(y1*S));
    return e>x&&b>y?{x,y,w:e-x,h:b-y}:null;
  };
  const figRect=(g,f,pad)=>rectOf(g,f.x0*4-pad,f.y0*4-pad,f.x1*4+4+pad,f.y1*4+4+pad);
  const canvasOf=(g,name)=>{const cv=g.canvas,o=cv[name]||(cv[name]=document.createElement('canvas'));if(o.width!==cv.width||o.height!==cv.height){o.width=cv.width;o.height=cv.height;o._r=null}return o};
  const layerOf=(g,name,r)=>{
    const o=canvasOf(g,name),q=o.getContext('2d');
    if(o._r)q.clearRect(o._r.x,o._r.y,o._r.w,o._r.h);o._r=r;
    q.save();q.beginPath();q.rect(r.x,r.y,r.w,r.h);q.clip();
    return q;
  };
  const blitLayer=(g,q)=>{const r=q.canvas._r;q.restore();g.save();g.setTransform(1,0,0,1,0,0);g.drawImage(q.canvas,r.x,r.y,r.w,r.h,r.x,r.y,r.w,r.h);g.restore()};
  function grayFigure(g,D,i,video,seed){
    const f=field(D,i);if(!f||f.empty||!g.canvas._gray||!linesF(D,i).length)return;   // 没有人形时不画，否则整幅噪点灰会贴上来
    const r=figRect(g,f,8);if(!r)return;
    const q=layerOf(g,'_fig',r),w=q.canvas.width,h=q.canvas.height,S=w/W;
    q.drawImage(g.canvas._gray,0,0);
    q.globalCompositeOperation='overlay';q.globalAlpha=.26;
    const dx=-(rnd(seed,1)*128|0),dy=-(rnd(seed,2)*128|0);q.translate(dx,dy);q.fillStyle=grainPat;q.fillRect(0,0,w+128,h+128);q.setTransform(1,0,0,1,0,0);q.globalAlpha=1;
    q.globalCompositeOperation='destination-in';q.setTransform(S,0,0,S,0,0);
    q.fill(softPath(linesF(D,i),0,0));
    blitLayer(g,q);
  }
  // 一块碎纸的形状（只在抓点附近贴）
  function scrap(cx,cy,R,seed){
    const p=new Path2D(),n=9;
    for(let k=0;k<n;k++){const a=k/n*6.283+rnd(k,seed)*.4,r=R*(.72+.5*rnd(k+20,seed)),x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;k?p.lineTo(x,y):p.moveTo(x,y)}
    p.closePath();return p;
  }
  function collage(g,D,i,t,seed){
    const ls=linesF(D,i);if(!ls.length)return;
    const f=field(D,i),cv=g.canvas;
    for(const e of active(D,t,e_win)){
      const [lx,ly]=D.pt(e.k,i),amp=e.hand?1:.68,c=Math.min(1,e.age/.09)*Math.exp(-e.age*(e.hand?1.5:3.2))*amp;
      if(c<.06)continue;
      const R=(e.hand?900:300)*Math.min(1,e.age/.25+.25),s=e.f*7+seed;
      // 纸片的范围：人形外扩最粗的一层（尖角最多伸出 1.7 倍）和碎纸形状的交集
      const pad=(8+60*c)*1.7+7*c+4,fr=figRect(g,f,pad),sr=rectOf(g,lx-R*1.22,ly-R*1.22,lx+R*1.22,ly+R*1.22);
      if(!fr||!sr)continue;
      const x=Math.max(fr.x,sr.x),y=Math.max(fr.y,sr.y),e2=Math.min(fr.x+fr.w,sr.x+sr.w),b2=Math.min(fr.y+fr.h,sr.y+sr.h);if(e2<=x||b2<=y)continue;
      const r={x,y,w:e2-x,h:b2-y},q=layerOf(g,'_col',r),S=q.canvas.width/W;
      q.setTransform(S,0,0,S,0,0);q.lineJoin='miter';q.miterLimit=1.7;q.lineCap='butt';
      const stack=[[8+60*c,'#141418',0],[8+44*c,'#F2F1EC',1],[8+24*c,'dots',2]];
      stack.forEach(([d,col,n])=>{
        // 每层纸都错开一点、用不同的剪法，像手工贴上去的
        const ox=(rnd(s,n+1)-.5)*14*c,oy=(rnd(s,n+5)-.5)*14*c;
        q.save();q.translate(ox,oy);
        q.lineWidth=2*d;q.strokeStyle=col==='dots'?dotPat:col;
        const p=cutPath(ls,3+n%2,2.5,s+n);q.stroke(p);q.fillStyle=q.strokeStyle;q.fill(p);
        q.restore();
      });
      q.globalCompositeOperation='source-atop';q.globalAlpha=.16;q.fillStyle=grainPat;q.fillRect(0,0,W,H);q.globalAlpha=1;
      q.globalCompositeOperation='destination-in';q.fillStyle='#000';q.fill(scrap(lx,ly,R,e.f));
      blitLayer(g,q);
      // 记下纸片盖到哪里：亮线走在纸上的那段要换墨色
      const pc=canvasOf(g,'_paper'),u=cv._paperRect;pc.getContext('2d').drawImage(q.canvas,r.x,r.y,r.w,r.h,r.x,r.y,r.w,r.h);
      if(!u)cv._paperRect=r;else{const nx=Math.min(u.x,r.x),ny=Math.min(u.y,r.y);cv._paperRect={x:nx,y:ny,w:Math.max(u.x+u.w,r.x+r.w)-nx,h:Math.max(u.y+u.h,r.y+r.h)-ny}}
    }
  }
  const e_win=2.2;
  // 白线：离身体一段距离。外缘和内缘用不同的抖动，粗细就自然不匀，像手画的
  function whiteLine(g,D,i,seed){
    const ls=linesF(D,i);if(!ls.length)return;
    const gap=20,t=3.4,r=figRect(g,field(D,i),gap+t+6);if(!r)return;
    const q=layerOf(g,'_line',r),S=q.canvas.width/W;
    q.setTransform(S,0,0,S,0,0);q.lineJoin='round';
    const outer=softPath(ls,1.6,seed),inner=softPath(ls,1.6,seed+13);
    q.strokeStyle='#fff';q.lineWidth=2*(gap+t);q.stroke(outer);
    q.globalCompositeOperation='destination-out';q.lineWidth=2*gap;q.stroke(inner);q.fill(inner);
    blitLayer(g,q);
  }
  const FR=1/CFPS;
  const CUT=['900 44px Georgia,serif','900 42px Impact,"Arial Black",sans-serif','700 italic 46px "Times New Roman",serif','700 40px "Courier New",monospace'];
  function ransom(g,D,i,t){
    const L=D.pt('Lh',i),R=D.pt('Rh',i),hip=[(L[0]+R[0])/2,(L[1]+R[1])/2];
    for(const e of active(D,t,1.4)){
      if(!e.hand)continue;
      const [hx,hy]=D.pt(e.k,i),dx=hx-hip[0],dy=hy-hip[1],l=Math.hypot(dx,dy)||1,s=e.age<FR?1.3:1;
      const cx=Math.max(70,Math.min(W-70,hx+dx/l*78)),cy=Math.max(50,Math.min(H-50,hy+dy/l*78));
      const label=D.rows?fullRows(D)[limbRows(D)[e.k][Math.min(D.N-1,e.f)]].n:e.n;   // 和这只手亮起的线一致
      [...label].forEach((ch,n,all)=>{
        const r=(a)=>rnd(e.f+n*3,a),tw=54*s,th=66*s,x=cx+(n-(all.length-1)/2)*(tw+2),y=cy+(r(1)-.5)*12;
        g.save();g.translate(x,y);g.rotate((r(2)-.5)*.34);
        const dark=(e.f+n)%2===0;
        g.fillStyle='rgba(20,20,24,.35)';g.fillRect(-tw/2+4,-th/2+5,tw,th);
        g.beginPath();g.moveTo(-tw/2+(r(3)-.5)*6,-th/2);g.lineTo(tw/2,-th/2+(r(4)-.5)*7);g.lineTo(tw/2+(r(5)-.5)*6,th/2);g.lineTo(-tw/2,th/2+(r(6)-.5)*7);g.closePath();
        g.fillStyle=dark?'#141418':'#F2F1EC';g.fill();
        g.fillStyle=dark?'#F2F1EC':'#141418';g.font=CUT[(e.f+n)%CUT.length];g.textAlign='center';g.textBaseline='middle';g.scale(s,s);g.fillText(ch,0,3);
        g.restore();
      });
    }
  }
  // 底：完全中性的黑白，再整体提亮，把人和纸让出来。去色只做一次，人形也用这张灰图。视频正在跳转时沿用上一张，不露原视频
  function bluesVideo(g,v){
    const cv=g.canvas,w=cv.width,h=cv.height;
    g.save();g.setTransform(1,0,0,1,0,0);
    if(v&&v.readyState>=2&&!v.seeking){
      const keep=canvasOf(g,'_grayCv'),q=keep.getContext('2d');q.globalCompositeOperation='source-over';drawCrop(q,v,w,h);
      q.globalCompositeOperation='saturation';q.fillStyle='#808080';q.fillRect(0,0,w,h);
      cv._gray=keep;
    }
    if(cv._gray){g.drawImage(cv._gray,0,0);g.globalAlpha=.38;g.fillStyle='#F3F3F1';g.fillRect(0,0,w,h);g.globalAlpha=1}
    else{g.fillStyle='#BDBDBB';g.fillRect(0,0,w,h)}   // 第一帧出来之前铺中性灰
    g.restore();
  }
  // 音名用 App 的 5×7 圆点字（app/js/dots.js 的字形，点直径 0.74×间距），补上 A–G 和 ♭
  const GL={'0':'01110 10001 10011 10101 11001 10001 01110','1':'00100 01100 00100 00100 00100 00100 01110','2':'01110 10001 00001 00010 00100 01000 11111','3':'11110 00001 00001 01110 00001 00001 11110','4':'00010 00110 01010 10010 11111 00010 00010','5':'11111 10000 11110 00001 00001 10001 01110','6':'00110 01000 10000 11110 10001 10001 01110','7':'11111 00001 00010 00100 01000 01000 01000',
    A:'01110 10001 10001 11111 10001 10001 10001',B:'11110 10001 10001 11110 10001 10001 11110',C:'01110 10001 10000 10000 10000 10001 01110',D:'11110 10001 10001 10001 10001 10001 11110',E:'11111 10000 10000 11110 10000 10000 11111',F:'11111 10000 10000 11110 10000 10000 10000',G:'01110 10001 10000 10111 10001 10001 01110','♭':'100 100 100 110 101 101 110','-':'000 000 000 111 000 000 000'};
  function dotText(g,text,x,y,p,col,alpha=1){
    g.save();g.fillStyle=col;g.globalAlpha=alpha;g.beginPath();let x0=0;
    for(const ch of text){const rows=(GL[ch]||GL['0']).split(' '),w=rows[0].length;
      rows.forEach((row,r)=>{for(let c=0;c<w;c++)if(row[c]==='1'){const X=x+(x0+c+.5)*p,Y=y+(r+.5-3.5)*p;g.moveTo(X+p*.45,Y);g.arc(X,Y,p*.45,0,7)}});x0+=w+1}
    g.fill();g.restore();
  }
  const P_=3,LX=60;
  // 音高横线：每个音一条，位置就是引擎把手的高度映射到这个音的位置。右手正在弹的音亮起来
  // 把音高刻度铺满整面墙（只是视觉，和引擎的声音各算各的）：沿用手的音高间距，往上下延伸
  function fullRows(D){
    if(D.fullRows)return D.fullRows;
    const PCS=[10,1,3,5,8],NN=['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
    const sorted=[...D.rows].sort((a,b)=>a.m-b.m),gap=(sorted[0].y-sorted[sorted.length-1].y)/(sorted.length-1),out=sorted.map(r=>({m:r.m,y:r.y}));
    const step=(m,d)=>{do{m+=d}while(!PCS.includes(((m%12)+12)%12));return m};
    for(let m=sorted[0].m,y=sorted[0].y+gap;y<.985;y+=gap){m=step(m,-1);out.unshift({m,y})}
    for(let m=sorted[sorted.length-1].m,y=sorted[sorted.length-1].y-gap;y>.015;y-=gap){m=step(m,1);out.push({m,y})}
    out.forEach(r=>r.n=NN[r.m%12]+(Math.floor(r.m/12)-1));
    return D.fullRows=out;
  }
  // 每只手脚当前在哪一行。带迟滞：过了行距的 65% 才换行，线不会在两行之间抖
  function limbRows(D){
    if(D.limbRow)return D.limbRow;
    const rows=fullRows(D),gap=Math.abs(rows[1].y-rows[0].y),out={};
    for(const k of LIMBS){
      const a=new Int16Array(D.N);let cur=-1;
      for(let i=0;i<D.N;i++){
        const y=D.ser[k].y[i];
        if(cur<0||Math.abs(rows[cur].y-y)>gap*.65){let b=0,bd=9;rows.forEach((r,j)=>{const d=Math.abs(r.y-y);if(d<bd){bd=d;b=j}});cur=b}
        a[i]=cur;
      }
      out[k]=a;
    }
    return D.limbRow=out;
  }
  function pitchLines(g,D,active){
    const short=true;
    fullRows(D).forEach((r,j)=>{
      if(active.has(j))return;
      const y=r.y*H,root=r.m%12===10;
      if(!short){g.strokeStyle='rgba(255,255,255,'+(root?.72:.42)+')';g.lineWidth=root?1.6:1;g.beginPath();g.moveTo(LX,y);g.lineTo(W,y);g.stroke()}
      // 平时只标主音 B♭；其他音只留一个很小的刻度，亮起时才出现音名
      if(root){if(short){g.strokeStyle='rgba(255,255,255,.8)';g.lineWidth=1.6;g.beginPath();g.moveTo(LX,y);g.lineTo(LX+30,y);g.stroke()}dotText(g,r.n,9,y,P_,'#141418',1)}
      else if(short){g.strokeStyle='rgba(255,255,255,.55)';g.lineWidth=1.2;g.beginPath();g.moveTo(10,y);g.lineTo(20,y);g.stroke()}
    });
  }
  // 四肢各牵一条线：从音名出发，沿这一行走到这只手脚，最后斜一笔落到手脚上。抓点时这条线粗一下
  function limbLines(g,D,i,t){
    const rows=fullRows(D),lr=limbRows(D),lit=new Set(),hits=active(D,t,3*FR);
    // 走在纸片上的那段换成墨色，否则白线在白纸上看不见
    const pr=g.canvas._paperRect;let ink=null;
    if(pr){ink=layerOf(g,'_ink',pr);const S=ink.canvas.width/W;ink.setTransform(S,0,0,S,0,0);ink.lineCap='round';ink.lineJoin='round';ink.strokeStyle='#141418'}
    g.save();g.lineCap='round';g.lineJoin='round';g.strokeStyle='#fff';
    for(const k of LIMBS){
      const j=lr[k][i],y=rows[j].y*H,[x,ly]=D.pt(k,i),hit=hits.filter(e=>e.k===k).pop(),hand=k[1]==='w';
      const kink=Math.max(LX,x-Math.min(26,Math.abs(ly-y)*1.1));
      g.lineWidth=(hand?2.6:1.8)+(hit?(hit.age<FR?5:hit.age<2*FR?3:1.4):0);
      g.beginPath();g.moveTo(LX,y);g.lineTo(kink,y);g.lineTo(x,ly);g.stroke();
      if(ink){ink.lineWidth=g.lineWidth;ink.beginPath();ink.moveTo(LX,y);ink.lineTo(kink,y);ink.lineTo(x,ly);ink.stroke()}
      lit.add(j);
    }
    g.restore();
    if(ink){ink.setTransform(1,0,0,1,0,0);ink.globalCompositeOperation='destination-in';ink.drawImage(g.canvas._paper,0,0);blitLayer(g,ink)}
    for(const j of lit){const y=rows[j].y*H;g.fillStyle='#141418';g.fillRect(4,y-15,54,30);dotText(g,rows[j].n,9,y,P_,'#F3F3F1')}
  }
  const planB=(g,D,i,t)=>{
    tiles();const seed=Math.floor(t*CFPS),v=g.video;
    bluesVideo(g,v);{const r=g.canvas._paperRect;if(r){canvasOf(g,'_paper').getContext('2d').clearRect(r.x,r.y,r.w,r.h);g.canvas._paperRect=null}}
    const seen=D.rows&&(!D.seen||D.seen[i]),lit=new Set();if(seen)for(const k of LIMBS)lit.add(limbRows(D)[k][i]);
    if(D.rows)pitchLines(g,D,lit);
    collage(g,D,i,t,seed);grayFigure(g,D,i,v,seed);whiteLine(g,D,i,seed);
    if(seen)limbLines(g,D,i,t);
    ransom(g,D,i,t);
  };

  let drawn='';
  function draw(cv,t){
    const r=cv.getBoundingClientRect(),dp=Math.min(2,devicePixelRatio||1),w=Math.round(r.width*dp),h=Math.round(r.height*dp);
    const rt=Math.floor(t*CFPS)/CFPS,key=[rt,w,h,vid.seeking,vid.readyState].join();
    if(key===drawn)return;drawn=key;
    if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h}
    const g=cv.getContext('2d');g.setTransform(w/W,0,0,w/W,0,0);g.video=vid;
    planB(g,D,Math.max(0,Math.min(N-1,Math.floor(rt*FPS))),rt);
    if(/[?&]debug=1/.test(location.search))Viz.diag(g,W/Math.max(1,r.width));
  }
  return{draw};
})();
