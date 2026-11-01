// 抓点 + 路线岩点（DESIGN-SPEC §6）
// 参考实现：design/tools/render2.py events()、holds2.py。坐标约定同参考：
//   抓点用 720×1280（可视化坐标），墙面分析用 360×640。
const Route=(()=>{
  const W=720,H=1280,WW=360,WH=640;

  // 关键点 j 的轨迹（720×1280）：置信度 <35 的帧沿用上一个有效值（和音频侧一致），开头没有就用第一个有效值；全 0 的“没识别到人”不会变成 (0,0)
  function track(D,j){
    let first=D.findIndex(r=>r[j*3+2]>=35);if(first<0)first=0;
    let l=[D[first][j*3],D[first][j*3+1]];
    return D.map(r=>{if(r[j*3+2]>=35)l=[r[j*3],r[j*3+1]];return[l[0]/1000*W,l[1]/1000*H]});
  }
  // 一个肢体的停稳点：平滑后速度 <thr（360 宽坐标，px/帧）持续 ≥minrun 帧；与上一个抓点 <merge（720 坐标）算同一个岩点
  function grabs(D,j,thr=0.9,minrun=10,merge=22){
    const N=D.length,P=track(D,j);
    const Ps=P.map((_,t)=>{let x=0,y=0;for(let k=t-4;k<=t+4;k++){const q=P[Math.max(0,Math.min(N-1,k))];x+=q[0];y+=q[1]}return[x/9,y/9]});
    const sp=Ps.map((p,t)=>t?Math.hypot(p[0]-Ps[t-1][0],p[1]-Ps[t-1][1])/2:0);
    const sp5=sp.map((_,t)=>{let a=0;for(let k=t-2;k<=t+2;k++)if(k>=0&&k<N)a+=sp[k];return a/5});
    const out=[];
    for(let t=0;t<N;){
      if(sp5[t]<thr){
        let e=t;while(e<N&&sp5[e]<thr)e++;
        if(e-t>=minrun){
          const med=k=>{const s=Ps.slice(t,e).map(p=>p[k]).sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2};
          const m=[med(0),med(1)],l=out[out.length-1];
          if(!l||Math.hypot(m[0]-l.x,m[1]-l.y)>merge)out.push({f:t,x:m[0],y:m[1]});
        }
        t=e;
      }else t++;
    }
    return out;
  }
  // 四肢（KP 下标：2 左腕 3 右腕 6 左踝 7 右踝）
  const allGrabs=D=>({Lw:grabs(D,2),Rw:grabs(D,3),La:grabs(D,6),Ra:grabs(D,7)});

  /* ---- 小型形态学（3 通道 RGBA 360×640；越界邻居忽略，等同 OpenCV 默认边界） ---- */
  function morph(m,w,h,r,dil){
    const t=new Uint8Array(m.length),o=new Uint8Array(m.length);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){let v=dil?0:1;for(let k=Math.max(0,x-r);k<=Math.min(w-1,x+r);k++){const q=m[y*w+k];if(dil?q:!q){v=dil?1:0;break}}t[y*w+x]=v}
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){let v=dil?0:1;for(let k=Math.max(0,y-r);k<=Math.min(h-1,y+r);k++){const q=t[k*w+x];if(dil?q:!q){v=dil?1:0;break}}o[y*w+x]=v}
    return o;
  }
  const dilate=(m,w,h,r)=>morph(m,w,h,r,true),erode=(m,w,h,r)=>morph(m,w,h,r,false);
  // sRGB → CIE Lab（D65，L 0..100）
  function lab(r,g,b){
    const lin=v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
    const R=lin(r),G=lin(g),B=lin(b);
    const X=(0.412453*R+0.357580*G+0.180423*B)/0.950456,Y=0.212671*R+0.715160*G+0.072169*B,Z=(0.019334*R+0.119193*G+0.950227*B)/1.088754;
    const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;
    return[Y>0.008856?116*Math.cbrt(Y)-16:903.3*Y,500*(f(X)-f(Y)),200*(f(Y)-f(Z))];
  }
  // 路线岩点按“一颗颗岩点”来判，同时看两件事：手脚碰过（接触）+ 颜色相同。
  // 1 分块：和墙差得多（ΔE>18）又不是阴影的像素，按颜色相近连成一块块岩点。亮度可以差得多（同一颗岩点有高光和背光），色度要接近（挨着的两颗不同色岩点不能连成一块）
  // 2 接触：每个抓点找它碰到的那一块，一块最多算 2 次（手在一颗岩点上反复调整不算多票），手的分量是脚的两倍（脚常踩在墙上或别的点上）
  // 3 定颜色：被碰过的岩点里，颜色相近的一组分量最大，就是这条线的颜色。占比太低或没有明显领先第二名就算“颜色不确定”，不画（宁可不画也别画错）
  // 4 路线 = 这组被碰过的岩点 + 全墙和它同色的岩点。碰过但颜色不同的不画（路过别的点、踩墙边）；结束点不一定碰过，只靠颜色也能选上。不够彩的岩点没碰过时要形状像岩点（防黑色大岩点、墙边和地垫）
  const DE=18,BLOB_DE=14,SAME=14,TOUCH_R=16,MIN_AREA=30,MAX_AREA=2500,MIN_SHARE=0.4,LEAD=1.3;
  // 两种颜色的距离。亮度受光照影响大，彩色主要比色度；黑、灰、白本来就靠亮度区分，亮度权重高一些。
  // 暗处的色度会被压缩（暗紫和深蓝的 a、b 都很小），先按亮度折算成相对饱和度再比，最多放大 2 倍免得黑色的噪声被放大
  function colorDist(p,q){
    const sa=50/Math.max(p[0],25),sb=50/Math.max(q[0],25),ca=Math.hypot(p[1],p[2]),cb=Math.hypot(q[1],q[2]),kL=ca<6&&cb<6?1.5:ca<10&&cb<10?0.7:0.35;
    return Math.hypot(p[1]*sa-q[1]*sb,p[2]*sa-q[2]*sb,kL*(p[0]-q[0]));
  }
  function routeMask(px,samples){
    const w=WW,h=WH,n=w*h,L=new Float32Array(n),A=new Float32Array(n),B=new Float32Array(n);
    for(let p=0;p<n;p++){const c=lab(px[p*4],px[p*4+1],px[p*4+2]);L[p]=c[0];A[p]=c[1];B[p]=c[2]}
    const med=arr=>{const t=[];for(let p=0;p<n;p+=7)t.push(arr[p]);t.sort((x,y)=>x-y);return t[t.length>>1]};
    const wall=[med(L),med(A),med(B)],wallC=Math.hypot(wall[1],wall[2]);
    // 墙的明暗变化（阴影、灯光照亮的一片）：亮度变了，色相不变，彩度和亮度同比例变化。灰色岩点的彩度比例低得多，不会被当成墙
    const wallLike=p=>{
      if(L[p]<25)return false;
      const r=L[p]/wall[0];
      if(wallC<8&&r<0.55)return false;   // 白墙没有色相可比，太暗的不算阴影
      // 被灯照亮的墙会褪色，比例对不上，但色相还是墙的
      if(r>1&&wallC>=8&&Math.hypot(A[p],B[p])>=6){const d=Math.abs(Math.atan2(B[p],A[p])-Math.atan2(wall[2],wall[1]))*180/Math.PI;if((d>180?360-d:d)<30)return true}
      return Math.hypot(A[p]-wall[1]*r,B[p]-wall[2]*r)<Math.max(5,wallC*0.3);
    };
    const y0=Math.round(h*0.03),y1=Math.round(h*0.9);   // 顶上一条（天花板/横幅）和底下的地垫不算
    const cand=new Uint8Array(n);
    for(let y=y0;y<y1;y++)for(let x=0;x<w;x++){const p=y*w+x;if(Math.hypot(L[p]-wall[0],A[p]-wall[1],B[p]-wall[2])>DE&&!wallLike(p))cand[p]=1}
    // 1 分块：区域生长，新像素和这一块当前的平均色相近才并进来
    const lb=new Int32Array(n),blobs=[null],q=[];
    for(let i=0;i<n;i++){
      if(!cand[i]||lb[i])continue;
      const b={id:blobs.length,area:0,l:0,a:0,b:0,x0:w,y0:h,x1:0,y1:0,hits:0,edge:false,w:0};
      blobs.push(b);lb[i]=b.id;q.length=0;q.push(i);
      while(q.length){
        const p=q.pop(),x=p%w,y=(p/w)|0;
        b.area++;b.l+=L[p];b.a+=A[p];b.b+=B[p];
        b.x0=Math.min(b.x0,x);b.x1=Math.max(b.x1,x);b.y0=Math.min(b.y0,y);b.y1=Math.max(b.y1,y);
        if(x===0||x===w-1)b.edge=true;
        for(const k of [x>0?p-1:-1,x<w-1?p+1:-1,p-w,p+w]){
          if(k<0||k>=n||!cand[k]||lb[k])continue;
          if(Math.hypot(0.5*(L[k]-b.l/b.area),A[k]-b.a/b.area,B[k]-b.b/b.area)<=BLOB_DE){lb[k]=b.id;q.push(k)}
        }
      }
      b.c=[b.l/b.area,b.a/b.area,b.b/b.area];
    }
    const real=b=>b&&b.area>=MIN_AREA&&b.area<n*0.25;
    // 2 接触
    for(const s of samples){
      const cx=Math.floor(s.x/2),cy=Math.floor(s.y/2),cnt=new Map();
      for(let dy=-TOUCH_R;dy<=TOUCH_R;dy++)for(let dx=-TOUCH_R;dx<=TOUCH_R;dx++){
        const X=cx+dx,Y=cy+dy;if(dx*dx+dy*dy>TOUCH_R*TOUCH_R||X<0||Y<0||X>=w||Y>=h)continue;
        const k=lb[Y*w+X];if(k&&real(blobs[k]))cnt.set(k,(cnt.get(k)||0)+1);
      }
      let best=0,bn=5;for(const [k,v] of cnt)if(v>bn){bn=v;best=k}
      if(best){const b=blobs[best];b.hits++;b.w+=s.foot?1:2}
    }
    const touched=blobs.filter(b=>b&&b.hits);
    if(!touched.length)return{mask:new Uint8Array(n),ref:null,kept:0};
    const weight=b=>Math.min(b.w,4);
    // 3 定颜色：以每一块被碰过的岩点为中心，看同色的总分量
    let top=null,topW=-1;
    let topN=0;
    for(const t of touched){
      const near=touched.filter(b=>colorDist(t.c,b.c)<=SAME),v=near.reduce((a,b)=>a+weight(b),0);
      if(v>topW||(v===topW&&near.length>topN)){topW=v;top=t;topN=near.length}   // 分量相同时，碰过的岩点多的那组更可能是路线
    }
    const group=touched.filter(b=>colorDist(top.c,b.c)<=SAME),tot=touched.reduce((a,b)=>a+weight(b),0);
    const sum=group.reduce((a,b)=>[a[0]+b.c[0]*b.area,a[1]+b.c[1]*b.area,a[2]+b.c[2]*b.area,a[3]+b.area],[0,0,0,0]);
    const c=[sum[0]/sum[3],sum[1]/sum[3],sum[2]/sum[3]],C=Math.hypot(c[1],c[2]),hue=(Math.atan2(c[2],c[1])*180/Math.PI+360)%360;
    const ref={cls:C>=8?Math.floor(hue/30):c[0]<50?12:13,L:c[0],C,hue,votes:topW,of:tot,holds:group.length};
    // 确定性：占比够，而且明显领先第二名（路线颜色的岩点常被高光拆成几块，只看过半太严）
    const rest=touched.filter(b=>!group.includes(b));let second=0;
    for(const t of rest)second=Math.max(second,rest.reduce((a,b)=>a+(colorDist(t.c,b.c)<=SAME?weight(b):0),0));
    ref.second=second;
    if(topW/tot<MIN_SHARE||topW<second*LEAD){ref.unsure=true;return{mask:new Uint8Array(n),ref,kept:0}}
    // 4 路线
    const inGroup=new Set(group.map(b=>b.id)),keep=new Uint8Array(n);let kept=0;
    const shaped=b=>{const bw=b.x1-b.x0+1,bh=b.y1-b.y0+1;return b.area<MAX_AREA&&Math.max(bw,bh)<=w/3&&b.area/(bw*bh)>=0.25&&!b.edge};
    const ok=new Uint8Array(blobs.length);
    for(const b of blobs){
      if(!real(b))continue;
      if(inGroup.has(b.id)||(colorDist(c,b.c)<=SAME&&(Math.hypot(b.c[1],b.c[2])>=8||shaped(b)))){ok[b.id]=1;kept++}
    }
    for(let p=0;p<n;p++)if(ok[lb[p]])keep[p]=1;
    const closed=erode(dilate(keep,w,h,2),w,h,2);   // 闭运算 5×5（补岩点上的螺丝孔、高光）
    // 填洞：从边界出发走不到的空白就是洞
    const out=new Uint8Array(n),st=[];
    for(let x=0;x<w;x++){st.push(x,(h-1)*w+x)}for(let y=0;y<h;y++){st.push(y*w,y*w+w-1)}
    while(st.length){const p=st.pop();if(closed[p]||out[p])continue;out[p]=1;const x=p%w,y=(p/w)|0;if(x>0)st.push(p-1);if(x<w-1)st.push(p+1);if(y>0)st.push(p-w);if(y<h-1)st.push(p+w)}
    for(let p=0;p<n;p++)out[p]=out[p]?0:1;
    return{mask:dilate(out,w,h,1),ref,kept};
  }
  // 掩膜 → 720×1280 上的紫色点阵位置（间距 7，先在 720 尺度上腐蚀 3×3）
  function routeDots(mask){
    const at=(x,y)=>x>=0&&y>=0&&x<W&&y<H&&mask[(y>>1)*WW+(x>>1)];
    const dots=[];
    for(let y=3;y<H;y+=7)for(let x=3;x<W;x+=7){
      let all=true;for(let dy=-1;dy<=1&&all;dy++)for(let dx=-1;dx<=1;dx++)if(!at(x+dx,y+dy)){all=false;break}
      if(all)dots.push(x,y);
    }
    return dots;
  }
  return{grabs,allGrabs,track,routeMask,routeDots,dilate,erode,W,H};
})();
