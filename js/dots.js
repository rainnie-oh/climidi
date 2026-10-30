// 自绘 5×7 圆点字（DESIGN-SPEC §3）。字形来自 design/tools/render2.py 的 G 字典。
// 字符间空 1 列，点直径 = 0.74 × 间距。不要换成 Ndot（商标字体）。
const Dots=(()=>{
  const G={
    '0':'01110 10001 10011 10101 11001 10001 01110','1':'00100 01100 00100 00100 00100 00100 01110',
    '2':'01110 10001 00001 00010 00100 01000 11111','3':'11110 00001 00001 01110 00001 00001 11110',
    '4':'00010 00110 01010 10010 11111 00010 00010','5':'11111 10000 11110 00001 00001 10001 01110',
    '6':'00110 01000 10000 11110 10001 10001 01110','7':'11111 00001 00010 00100 01000 01000 01000',
    '8':'01110 10001 10001 01110 10001 10001 01110','9':'01110 10001 10001 01111 00001 00010 01100',
    ':':'0 0 1 0 1 0 0','.':'0 0 0 0 0 0 1',
    'T':'11111 00100 00100 00100 00100 00100 00100','O':'01110 10001 10001 10001 10001 10001 01110',
    'P':'11110 10001 10001 11110 10000 10000 10000','V':'10001 10001 10001 10001 10001 01010 00100',
    '/':'00001 00001 00010 00100 01000 10000 10000',
    // 水印 CLIMIDI 用（M-07）
    'C':'01110 10001 10000 10000 10000 10001 01110','L':'10000 10000 10000 10000 10000 10000 11111',
    'I':'111 010 010 010 010 010 111','M':'10001 11011 10101 10101 10001 10001 10001',
    'D':'11110 10001 10001 10001 10001 10001 11110',' ':'00 00 00 00 00 00 00'};
  const cols=t=>[...t].reduce((a,ch)=>a+G[ch].split(' ')[0].length,0)+t.length-1;
  // 在 ctx 的 (x,y) 处画字，pitch 是点间距（ctx 当前坐标单位）
  function paint(ctx,text,x,y,pitch,color='#141418',dot=0.74){
    ctx.fillStyle=color;let x0=0;
    for(const ch of text){
      const rows=G[ch].split(' '),w=rows[0].length;
      rows.forEach((row,r)=>{for(let c=0;c<w;c++)if(row[c]==='1'){ctx.beginPath();ctx.arc(x+(x0+c+.5)*pitch,y+(r+.5)*pitch,dot*pitch/2,0,7);ctx.fill()}});
      x0+=w+1;
    }
  }
  // 画到一个 <canvas>，CSS 尺寸 = 列数×间距 × 7×间距；同样的字不重画
  function render(cv,text,pitch,color){
    const key=text+'|'+pitch+'|'+color;if(cv._k===key)return;cv._k=key;
    const d=Math.min(3,devicePixelRatio||1),w=cols(text)*pitch,h=7*pitch;
    cv.style.width=w+'px';cv.style.height=h+'px';cv.width=Math.round(w*d);cv.height=Math.round(h*d);
    const g=cv.getContext('2d');g.setTransform(d,0,0,d,0,0);g.clearRect(0,0,w,h);paint(g,text,0,0,pitch,color);
    cv.setAttribute('aria-label',text);
  }
  // 计时：mm:ss；带小数时 mm:ss.s
  const clock=(t,dec)=>{const m=Math.floor(t/60),s=t-m*60,ss=dec?s.toFixed(1).padStart(4,'0'):String(Math.floor(s)).padStart(2,'0');return String(m).padStart(2,'0')+':'+ss};
  return{G,cols,paint,render,clock};
})();
