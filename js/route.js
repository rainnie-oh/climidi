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
  function label(m,w,h){   // 8 连通
    const lab=new Int32Array(m.length),st=[null];let n=0;const q=[];
    for(let i=0;i<m.length;i++){
      if(!m[i]||lab[i])continue;
      n++;let area=0,sx=0,sy=0;q.length=0;q.push(i);lab[i]=n;
      while(q.length){const p=q.pop(),x=p%w,y=(p/w)|0;area++;sx+=x;sy+=y;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const X=x+dx,Y=y+dy;if(X<0||Y<0||X>=w||Y>=h)continue;const k=Y*w+X;if(m[k]&&!lab[k]){lab[k]=n;q.push(k)}}}
      st.push({area,cx:sx/area,cy:sy/area});
    }
    return{lab,st,n};
  }
  // sRGB → CIE Lab（D65，L 0..100）
  function lab(r,g,b){
    const lin=v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
    const R=lin(r),G=lin(g),B=lin(b);
    const X=(0.412453*R+0.357580*G+0.180423*B)/0.950456,Y=0.212671*R+0.715160*G+0.072169*B,Z=(0.019334*R+0.119193*G+0.950227*B)/1.088754;
    const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;
    return[Y>0.008856?116*Math.cbrt(Y)-16:903.3*Y,500*(f(X)-f(Y)),200*(f(Y)-f(Z))];
  }
  // 路线岩点 = 和“人抓过的岩点”同色的岩点（按颜色，不限深色）：
  // 1 墙面色 = 空墙的颜色中值；和墙差得多（ΔE>18）的像素才可能是岩点（木墙本身偏橘，所以不能只看饱和度）
  // 2 像素分类：彩色按色相 12 档（每档 30°），不够彩的分成“深”（黑/深灰）和“浅”（白/浅灰）
  // 3 每个抓点（加起步时两手的位置）周围 14px 看岩点像素是哪一类，各投一票；票最多的类就是这条线的颜色
  // 4 参考色相 = 各抓点自己的主色相取中值（红和橘挨得近，不能把两种票平均成一个中间色）
  // 5 全墙找同类、色相/饱和度/亮度接近参考色的连通块；太大的（volume，>2500px）、太长太空的（阴影、墙边）不算，
  //   但抓点碰到的块一定是路线，无条件保留（只防整面墙：<6% 画面）
  // 6 获胜颜色票数不到 60% 就算“颜色不确定”，不画路线（宁可不画也别画错；以后让用户点一个岩点选颜色，DESIGN-SPEC §6 P1）
  const CHROMA=18,DE=18,HUE_TOL=18,MAX_AREA=2500,MIN_SHARE=0.6;
  function routeMask(px,samples){
    const w=WW,h=WH,n=w*h,L=new Float32Array(n),A=new Float32Array(n),B=new Float32Array(n);
    for(let p=0;p<n;p++){const c=lab(px[p*4],px[p*4+1],px[p*4+2]);L[p]=c[0];A[p]=c[1];B[p]=c[2]}
    const med=arr=>{const t=[];for(let p=0;p<n;p+=7)t.push(arr[p]);t.sort((x,y)=>x-y);return t[t.length>>1]};
    const wall=[med(L),med(A),med(B)];
    const C=p=>Math.hypot(A[p],B[p]),hue=p=>(Math.atan2(B[p],A[p])*180/Math.PI+360)%360;
    const cls=p=>C(p)>=CHROMA?Math.floor(hue(p)/30):L[p]<50?12:13;   // 0..11 彩色，12 深，13 浅
    const y0=Math.round(h*0.03),y1=Math.round(h*0.9);   // 顶上一条（天花板/横幅）和底下的地垫不算
    const cand=new Uint8Array(n);
    for(let y=y0;y<y1;y++)for(let x=0;x<w;x++){const p=y*w+x;if(Math.hypot(L[p]-wall[0],A[p]-wall[1],B[p]-wall[2])>DE)cand[p]=1}
    // 投票
    const votes=new Array(14).fill(0),pix=[],hues=[];
    for(const s of samples){
      const cx=Math.floor(s.x/2),cy=Math.floor(s.y/2),hist=new Array(14).fill(0),mine=[];
      for(let dy=-14;dy<=14;dy++)for(let dx=-14;dx<=14;dx++){const X=cx+dx,Y=cy+dy;if(dx*dx+dy*dy>196||X<0||Y<0||X>=w||Y>=h)continue;const p=Y*w+X;if(cand[p]){hist[cls(p)]++;mine.push(p)}}
      const tot=hist.reduce((a,v)=>a+v,0);if(tot<6)continue;
      const k=hist.indexOf(Math.max(...hist)),own=mine.filter(p=>cls(p)===k);votes[k]++;pix.push(...own.map(p=>[k,p]));
      if(k<12){const hs=own.map(hue).sort((a,b)=>a-b);hues.push([k,hs[hs.length>>1]])}
    }
    const win=votes.indexOf(Math.max(...votes));
    if(!votes[win])return{mask:new Uint8Array(n),ref:null,kept:0};
    const ps=pix.filter(q=>q[0]===win).map(q=>q[1]);
    const mean=f=>ps.reduce((a,p)=>a+f(p),0)/ps.length;
    // 参考色相：投给获胜类的那些抓点，各自主色相的中值（以获胜类中心为基准展开，跨 0° 也对）
    const c0=win*30+15,unwrap=x=>{let d=x-c0;if(d>180)d-=360;if(d<-180)d+=360;return d};
    const hv=hues.filter(q=>q[0]===win).map(q=>unwrap(q[1])).sort((a,b)=>a-b);
    const ref={cls:win,L:mean(p=>L[p]),C:mean(C),hue:hv.length?(c0+hv[hv.length>>1]+360)%360:c0,votes:votes[win],of:votes.reduce((a,v)=>a+v,0)};
    if(ref.votes/ref.of<MIN_SHARE){ref.unsure=true;return{mask:new Uint8Array(n),ref,kept:0}}
    const hd=x=>{const d=Math.abs(x-ref.hue)%360;return d>180?360-d:d};
    let m=new Uint8Array(n);
    for(let p=0;p<n;p++){
      if(!cand[p])continue;
      if(win<12)m[p]=C(p)>=Math.max(12,0.5*ref.C)&&hd(hue(p))<=HUE_TOL&&Math.abs(L[p]-ref.L)<=30?1:0;
      else if(win===12)m[p]=C(p)<CHROMA&&L[p]<=Math.min(45,ref.L+10)?1:0;
      else m[p]=C(p)<CHROMA+4&&L[p]>=ref.L-15?1:0;
    }
    m=dilate(erode(m,w,h,1),w,h,1);   // 开运算 3×3（去零星像素）
    m=erode(dilate(m,w,h,2),w,h,2);   // 闭运算 5×5（补岩点上的螺丝孔、高光）
    const {lab:lb,st,n:nc}=label(m,w,h),ok=new Uint8Array(nc+1);let kept=0;
    const touched=new Set();
    for(const sp of samples){const cx=Math.floor(sp.x/2),cy=Math.floor(sp.y/2);
      for(let dy=-14;dy<=14;dy++)for(let dx=-14;dx<=14;dx++){const X=cx+dx,Y=cy+dy;if(dx*dx+dy*dy<=196&&X>=0&&Y>=0&&X<w&&Y<h&&lb[Y*w+X])touched.add(lb[Y*w+X])}}
    // 外接框：长边不超过画面宽的 1/3，填充率 ≥0.25（长条阴影、墙边线都很空）
    const bb=Array.from({length:nc+1},()=>[w,h,0,0]);
    for(let p=0;p<n;p++){const k=lb[p];if(!k)continue;const x=p%w,y=(p/w)|0,b=bb[k];if(x<b[0])b[0]=x;if(y<b[1])b[1]=y;if(x>b[2])b[2]=x;if(y>b[3])b[3]=y}
    for(let k=1;k<=nc;k++){
      const b=bb[k],bw=b[2]-b[0]+1,bh=b[3]-b[1]+1;
      const fine=st[k].area>=30&&st[k].area<MAX_AREA&&Math.max(bw,bh)<=w/3&&st[k].area/(bw*bh)>=0.25;
      if(fine||(touched.has(k)&&st[k].area<n*0.06)){ok[k]=1;kept++}
    }
    const keep=new Uint8Array(n);for(let p=0;p<n;p++)if(ok[lb[p]])keep[p]=1;
    // 填洞：从边界出发走不到的空白就是洞
    const out=new Uint8Array(n),q=[];
    for(let x=0;x<w;x++){q.push(x,(h-1)*w+x)}for(let y=0;y<h;y++){q.push(y*w,y*w+w-1)}
    while(q.length){const p=q.pop();if(keep[p]||out[p])continue;out[p]=1;const x=p%w,y=(p/w)|0;if(x>0)q.push(p-1);if(x<w-1)q.push(p+1);if(y>0)q.push(p-w);if(y<h-1)q.push(p+w)}
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
