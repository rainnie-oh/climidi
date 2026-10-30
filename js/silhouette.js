// 人形轮廓：视频帧 − 空墙（design/SILHOUETTE.md；参考 design/tools/silhouette_test.py mask_for()）。
// 只在关键点包围盒 ±45px（360×640 坐标）里算，同时挡住旁人。结果交给 viz.js 和骨架线段合成。
// 为了手机上跑得动，按文档建议在 180×320 上算（SC=2），掩膜按 360×640 坐标查询；SC=1 就是参考实现的原尺寸。
// 读不到视频像素（双击 file:// 打开时画布会被污染）就返回 null，viz.js 退回只用骨架线段。
const Sil=(()=>{
  const SC=2,W=360/SC,H=640/SC,PAD=45/SC,THR=38;
  // 形态学核按尺度缩：闭运算 9×9 → 半径 4/SC；开运算 3×3 在半尺度下由缩图本身的平均代替（再开会吃掉手指这类细节）
  const K=[0.0708,0.2445,0.3694,0.2445,0.0708];   // OpenCV 5×5 高斯（sigma 1.1）
  let bg=null,ok=true,crop=null,stat='还没算';   // stat：最近一次的结果，?debug=1 时播放页显示
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;
  const g=cv.getContext('2d',{willReadFrequently:true});

  // 5×5 高斯模糊（RGBA → 3 通道 Float32），只算 ROI [x0,x0+w)×[y0,y0+h)，越界取边缘像素。
  // 先横向（上下各多算 2 行），再竖向
  function blur(px,pw,ph,x0,y0,w,h){
    const cx=x=>Math.min(pw-1,Math.max(0,x)),cy=y=>Math.min(ph-1,Math.max(0,y));
    const hh=h+4,t=new Float32Array(w*hh*3),o=new Float32Array(w*h*3);
    for(let y=0;y<hh;y++){const row=cy(y0+y-2)*pw;
      for(let x=0;x<w;x++)for(let c=0;c<3;c++){let s=0;for(let k=-2;k<=2;k++)s+=K[k+2]*px[(row+cx(x0+x+k))*4+c];t[(y*w+x)*3+c]=s}}
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++){
      let s=0;for(let k=0;k<5;k++)s+=K[k]*t[((y+k)*w+x)*3+c];   // t 的第 y+k 行 = 图像第 y0+y+k-2 行（越界已在横向时夹住）
      o[(y*w+x)*3+c]=s}
    return o;
  }
  // 空墙：识别时抽帧取中值得到（js/pose.js），画布或图片都行；crop 是视频里 9:16 的裁切（视频像素）
  function setBg(src,c){
    crop=c||null;
    const cv2=document.createElement('canvas');cv2.width=W;cv2.height=H;const cg=cv2.getContext('2d');cg.drawImage(src,0,0,W,H);
    bg=blur(cg.getImageData(0,0,W,H).data,W,H,0,0,W,H);
  }
  // 当前帧 i 的人形掩膜（工作尺度里的 ROI）；按帧缓存
  const cache=new Map();
  function capture(video,i){
    if(!ok||!bg||cache.has(i))return cache.get(i)||null;
    if(!video||(video.readyState!==undefined&&(video.readyState<2||video.seeking))){stat='视频帧没就绪 rs='+(video&&video.readyState);return null}   // 视频正在跳转时画面还是旧帧；图片/画布直接用
    let x0=W,y0=H,x1=0,y1=0;
    for(const k of KP){const x=ser[k].x[i]*W,y=ser[k].y[i]*H;x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)}
    x0=Math.max(0,Math.floor(x0-PAD));y0=Math.max(0,Math.floor(y0-PAD));x1=Math.min(W,Math.ceil(x1+PAD));y1=Math.min(H,Math.ceil(y1+PAD));
    const w=x1-x0,h=y1-y0;if(w<=0||h<=0)return null;
    // 只读 ROI（四周多 2px 给模糊用），不读整帧
    const rx=Math.max(0,x0-2),ry=Math.max(0,y0-2),rw=Math.min(W,x1+2)-rx,rh=Math.min(H,y1+2)-ry;
    let px;
    try{
      if(crop)g.drawImage(video,crop.sx,crop.sy,crop.sw,crop.sh,0,0,W,H);else g.drawImage(video,0,0,W,H);
      px=g.getImageData(rx,ry,rw,rh).data;
    }catch(e){ok=false;stat='读不到像素：'+e.message;return null}   // file:// 下会被拒
    const f=blur(px,rw,rh,x0-rx,y0-ry,w,h);
    let m=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const a=(y*w+x)*3,b=((y0+y)*W+x0+x)*3;
      if(Math.max(Math.abs(f[a]-bg[b]),Math.abs(f[a+1]-bg[b+1]),Math.abs(f[a+2]-bg[b+2]))>THR)m[y*w+x]=1;
    }
    const rc=Math.round(4/SC);
    m=Route.erode(Route.dilate(m,w,h,rc),w,h,rc);   // 闭运算（补洞）
    if(SC===1)m=Route.dilate(Route.erode(m,w,h,1),w,h,1);   // 开运算 3×3（去噪点）
    let on=0;for(const q of m)on+=q;stat=`掩膜 ${Math.round(on/m.length*100)}%（ROI ${w}×${h}）`;   // 接近 100% 多半是空墙不对，接近 0 是读到的帧和空墙一样
    const r={x0,y0,w,h,m};
    cache.set(i,r);if(cache.size>12)cache.delete(cache.keys().next().value);
    return r;
  }
  // 按 360×640 坐标查询
  const at=(r,x,y)=>{x=Math.floor(x/SC)-r.x0;y=Math.floor(y/SC)-r.y0;return x>=0&&y>=0&&x<r.w&&y<r.h&&r.m[y*r.w+x]===1};
  return{setBg,capture,get:i=>cache.get(i)||null,at,get ready(){return ok&&!!bg},get stat(){return bg?stat:'没有空墙'}};
})();
