// 拼贴风格的配乐（?style= 切回 maj / blues 时不加载）。engine.js 负责手脚事件、和声和时钟，这里替换它的几个出声函数（sustain、setVoice、pluck、cadence），engine.js 本身不改。
// 没有固定的鼓和循环：脚落点 = 底鼓 + 贝斯，手抓点 = 军鼓 + 电钢，手的高度变化 = 电钢单音，身体动得多镲才变密。身体越高，贝斯和和弦越往上走。
// 速度和第一拍从这段攀爬算出来，每段视频不一样。
const Acid=(()=>{
if(window.STYLE!=='collage')return null;
// 85–105 BPM 里挑最贴合手脚落点的速度和相位（手的权重是脚的两倍，略偏向 95）
function pickTempo(){
  const ts=['Lw','Rw','La','Ra'].flatMap(k=>EV[k].map(e=>[e/FPS,k[1]==='w'?2:1]));let best=[-1,95,0];
  for(let b=85;b<=105;b++){const g=60/b/4;for(let ph=0;ph<g;ph+=.01){let s=0;for(const [t,w] of ts){const u=(t-ph)/g,d=u-Math.floor(u);s+=w*Math.exp(-Math.pow(Math.min(d,1-d)/.16,2))}s-=Math.abs(b-95)*.02;if(s>best[0])best=[s,b,ph]}}
  return{BPM:best[1],PH:best[2]};
}
const {BPM,PH}=pickTempo(),S16=60/BPM/4,S8=S16*2,SW=.14*S16;
UI.val=(o=>k=>k==='bpm'?String(BPM):k==='grid'?'e':o(k))(UI.val);
P.key=10;setScale('blues');P.echo=8;   // B♭ 小调五声
const hz=m=>440*Math.pow(2,(m-69)/12);
const CH=[[0,3,7,10,14],[5,8,0,3,7],[8,0,3,7,10]];   // 底部 i9，中段 iv9，高处 VImaj7（相对 B♭）
const chord=fi=>CH[ROOTIDX[Math.min(N-1,fi)]]||CH[0];
const clk=()=>vid.currentTime+(ac.baseLatency||0)+(ac.outputLatency||.02);
const onGrid=step=>{const t=clk();return ac.currentTime+(Math.ceil((t-PH)/step-.001)*step+PH-t)+.005};
const hum=()=>(Math.random()-.5)*.012,vel=()=>.88+Math.random()*.24;
let rev=null,revOf=null;
function room(){
  if(revOf===ac)return rev;revOf=ac;rev=ac.createConvolver();
  const n=ac.sampleRate*.9|0,ir=ac.createBuffer(2,n,ac.sampleRate);for(let c=0;c<2;c++){const d=ir.getChannelData(c);for(let i=0;i<n;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/n,3.2)}
  rev.buffer=ir;const g=ac.createGain();g.gain.value=.22;rev.connect(g);g.connect(S.gate);return rev;
}
function env(t,peak,dec,wet){const g=ac.createGain();g.gain.setValueAtTime(.0001,t);g.gain.linearRampToValueAtTime(peak,t+.004);g.gain.setTargetAtTime(0,t+.004,dec);g.connect(dry);if(wet){const w=ac.createGain();w.gain.value=wet;g.connect(w);w.connect(room())}return g}
let nb=null,nOf=null;const noise=()=>{if(nOf===ac)return nb;nOf=ac;nb=ac.createBuffer(1,ac.sampleRate,ac.sampleRate);const d=nb.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;return nb};
function hit(t,p,dec,type,f,Q=.8,wet=0){const s=ac.createBufferSource();s.buffer=noise();const b=ac.createBiquadFilter();b.type=type;b.frequency.value=f;b.Q.value=Q;s.connect(b);b.connect(env(t,p,dec,wet));s.start(t,Math.random()*.5);s.stop(t+dec*7)}
const kick=(t,v)=>{const o=ac.createOscillator();o.frequency.setValueAtTime(95,t);o.frequency.exponentialRampToValueAtTime(46,t+.06);o.connect(env(t,.46*v,.075));o.start(t);o.stop(t+.5)};
const snare=(t,v)=>{hit(t,.17*v,.07,'bandpass',1800,.5,.5);hit(t,.05*v,.03,'highpass',6000)};
const hat=(t,v,open)=>hit(t,.038*v,open?.07:.014,'highpass',8500);
// 贝斯：干净的手指贝斯，低音 + 一点拨弦的亮
function bass(m,t,v,dur){
  const f=hz(m),o=ac.createOscillator(),h=ac.createOscillator(),hg=ac.createGain();o.type='triangle';o.frequency.value=f;h.type='sawtooth';h.frequency.value=f;hg.gain.value=.22;
  const lp=ac.createBiquadFilter();lp.type='lowpass';lp.Q.value=.8;lp.frequency.setValueAtTime(1300,t);lp.frequency.setTargetAtTime(420,t,.05);
  const g=env(t,.3*v,dur*.55);o.connect(lp);h.connect(hg);hg.connect(lp);lp.connect(g);
  g.gain.setTargetAtTime(0,t+dur,.025);[o,h].forEach(x=>{x.start(t);x.stop(t+dur+.4)});
}
function ep(m,t,v,dec=.55){
  const f=hz(m),c=ac.createOscillator(),mo=ac.createOscillator(),mg=ac.createGain();c.frequency.value=f;mo.frequency.value=f;
  mg.gain.setValueAtTime(f*.9,t);mg.gain.setTargetAtTime(f*.1,t,.1);mo.connect(mg);mg.connect(c.frequency);
  const lp=ac.createBiquadFilter();lp.type='lowpass';lp.frequency.value=2600;c.connect(lp);lp.connect(env(t,.13*v,dec,.8));
  [c,mo].forEach(o=>{o.start(t);o.stop(t+dec*6)});
}
const up=(pc,lo)=>lo+((pc+10-lo)%12+12)%12;   // 和弦音 pc（相对 B♭）放到 lo 以上最近的位置
const chordNotes=(fi,lo)=>chord(fi).map(pc=>up(pc%12,lo)).sort((a,b)=>a-b);
// 身体的高度：0 底部，1 顶部
const hipH=fi=>{const r=R.hip;return Math.max(0,Math.min(1,(ser.hip.h[fi]-r[0])/(r[1]-r[0]+1e-9)))};
const bassLo=fi=>34+Math.round(hipH(fi)*10);   // 爬得越高，贝斯越往上
let lastBassM=null;
function footBass(fi,t,v){   // 脚落点：贝斯按脚的高度取和弦音，八度跳让线条有起伏
  const ns=chordNotes(fi,bassLo(fi)),foot=Math.max(0,Math.min(.999,(ser.La.h[fi]+ser.Ra.h[fi])/2));
  let m=ns[Math.floor(foot*97)%ns.length];if(lastBassM!=null&&Math.abs(m-lastBassM)<3)m+=lastBassM<m+6&&lastBassM>m-1?12:0;
  while(m>55)m-=12;lastBassM=m;bass(m,t,v,S16*2.6);
}
sustain=()=>{const g=ac.createGain();g.gain.value=0;const lp=ac.createBiquadFilter(),o=ac.createOscillator();o.connect(lp);lp.connect(g);o.start();return{g,oscs:[[o,1]],lp,base:1000,lastF:1000}};
const last=new Map();
const afterTop=()=>topT!=null&&clk()>=topT;
setVoice=(v,m)=>{if(last.get(v)===m||!ac||afterTop())return;const had=last.has(v);last.set(v,m);if(had&&v===vR)ep(m,onGrid(S8)+hum(),.95*vel())};
pluck=(orig=>(kind,m,v,when)=>{
  if(when!==undefined||kind==='harp')return orig(kind,m,v,when);
  if(afterTop())return;
  const fi=Math.min(N-1,Math.floor(clk()*FPS));
  if(kind==='marimba'){const t=onGrid(S16);snare(t,.9*vel());chordNotes(fi,60).slice(0,4).forEach((n,k)=>ep(n,t+k*.006,.5*vel(),.8));ep(m,t,1.05*v);return}
  if(kind==='bass'){const t=onGrid(S16);kick(t,.75*vel());footBass(fi,t,.95*vel());return}
  if(kind==='chime')return;
  orig(kind,m,v,when);
})(pluck);
// TOP：先走 VI → VII → i 往上推，到顶时全部落在 i9 上，不再接竖琴
const chordAbs=(pcs,lo)=>pcs.map(pc=>up(pc%12,lo)).sort((x,y)=>x-y);
cadence=()=>{
  const t=onGrid(S16),b=S16*4;S.topReal=t;
  kick(t,1.1);hit(t,.1,.75,'highpass',5200,.7,.9);hit(t,.13,.09,'bandpass',1700,.5,.7);
  bass(34,t,1.05,b*3.2);bass(46,t,.45,b*1.6);
  chordAbs([0,3,7,10,14],58).forEach((m,k)=>ep(m,t+k*.028,.8,1.5));
  swell([46,53,58,61,65,68].map(m=>m+12),t,3.6,.28,1.15);
  ep(85,t+b*1,.5,1.1);ep(82,t+b*2,.62,1.8);
};
// 动得多才有镲和贝斯短句；静止时全部退下
const BW=[.9,.1,.5,.15,.35,.5,.35,.1,.55,.25,.6,.5,.25,.45,.5,.2];   // 每个十六分音出贝斯音的可能性：重音分散，偏切分
let lastN=-1,lt=-1;
const rnd=(a,b)=>{const s=Math.sin(a*12.9898+b*78.233)*43758.5453;return s-Math.floor(s)};
setInterval(()=>{
  if(!ac||vid.paused)return;
  const t=clk();if(t<lt-.3)lastN=-1;lt=t;const top=topT;
  for(let n=Math.max(lastN+1,Math.ceil((t-PH)/S16));n*S16+PH<t+.12;n++){
    lastN=n;const tt=n*S16+PH;if(tt<0||(top!=null&&tt>=top))continue;
    if(top!=null){const left=Math.round((top-tt)/S16);
      if(left===16||left===8){const w=ac.currentTime+(tt-t)+.005,pcs=left===16?[8,0,3,7]:[10,2,5,8];chordAbs(pcs,58).forEach((m,k)=>ep(m,w+k*.012,.72+(16-left)*.02,.5));bass(left===16?42:44,w,.85,S16*5);kick(w,.8)}
      if(left>0&&left<=4)hit(ac.currentTime+(tt-t)+.005,.045+.03*(4-left),.03,'bandpass',1900,.7,.5);
      if(left>0&&left<=8&&n%2)hat(ac.currentTime+(tt-t)+.005,.8,false);}
    const st=((n%16)+16)%16,fi=Math.min(N-1,Math.floor(tt*FPS)),en=E[fi],when=ac.currentTime+(tt-t)+(n%2?SW:0)+.005+hum();
    if(en>.12){if(n%2===0)hat(when,(st%4===0?1:.65)*(.5+en*.6),false);else if(en>.45&&[3,5,13].includes(st))hat(when,.55,false)}
    if(en>.28&&rnd(n,fi%7)<BW[st]*Math.min(1,(en-.1)*1.25)){
      const ns=chordNotes(fi,bassLo(fi));let m=ns[Math.floor(rnd(n,3)*ns.length)];if(rnd(n,5)<.22)m+=12;while(m>58)m-=12;bass(m,when,.62*vel(),S16*(rnd(n,9)<.3?1.9:.9));
    }
    if(n%32===0&&en>.08){const r=top?Math.min(1,tt/top):.4;chordNotes(fi,55+Math.round(hipH(fi)*6)).slice(0,4).forEach((x,k)=>ep(x,when+k*.008,.3+.3*r,1.3))}
  }
},20);
return{BPM,PH,S16};
})();
