// 音频引擎 + 信号处理 + 和声 + TOP：从 prototype/climb-template.html 原样搬出（HANDOFF §4）。
// 唯一的改动是接口：读页面控件的地方换成 UI.val(id) / UI.on(id) / UI.text(id,s)，由页面提供 UI 对象。
// 这是普通 <script>（不是模块），顶层 let/const 与 viz.js、lab.js 共享全局作用域。
const D=CLIMB_DATA.kp;   // 识别结果（js/pose.js → app.js），每帧 8 点 [x,y,conf]，30fps
const FPS=30,N=D.length;
const KP=['Ls','Rs','Lw','Rw','Lh','Rh','La','Ra'];
const $=id=>document.getElementById(id);
const vid=$('vid');
const SCALES={maj:[0,2,4,7,9],blues:[0,3,5,7,10]};
let PENT=SCALES.maj;
const NN=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const nname=m=>NN[((m%12)+12)%12]+(Math.floor(m/12)-1);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

/* ---------- parameters ---------- */
const PRESETS={v3:{hrel:'lead',frel:'indep',tsnap:'chord',rhy:'chord',glide:60},v2:{hrel:'indep',frel:'indep',tsnap:'hand',rhy:'hand',glide:50}};
const DEF={map:'h',key:0,scale:'maj',preset:'v3',hrel:'lead',lead:'R',par:3,frel:'indep',harm:'hip',tsnap:'chord',rhy:'chord',
  gH:100,gT:100,gF:100,gA:100,glide:60,echo:18,oct:2,shift:0,up:25,hold:5,dens:50,topPct:80,topHold:0.8,leadS:2.5,topVol:100};
const P=Object.assign({},DEF);
// 原来写在 $('scale').onchange 里的那一行，原样提成函数，用户页和 /lab 共用
function setScale(v){P.scale=v;PENT=SCALES[P.scale];buildSN();rebuild();ROOTS=P.scale==='blues'?[0,5,10]:[0,7,9]}
function hook(k){
  if(k==='oct'||k==='shift')rebuild();
  if(k==='up'||k==='hold')recomputeEV();
  if(k==='topPct'||k==='topHold'){if(topAuto){topT=detectTop();S.topDone=false;showTop()}}
  if(k==='echo'&&ac&&S.wet){S.wetLast=-1}
}

/* ---------- prepare the signals ---------- */
function med(a,w){const h=w>>1,o=a.slice();for(let i=0;i<a.length;i++){const s=[];for(let k=Math.max(0,i-h);k<=Math.min(a.length-1,i+h);k++)s.push(a[k]);s.sort((x,y)=>x-y);o[i]=s[s.length>>1]}return o}
const ser={};
KP.forEach((k,j)=>{
  let x=[],y=[],c=[];
  for(let i=0;i<N;i++){x.push(D[i][j*3]/1000);y.push(D[i][j*3+1]/1000);c.push(D[i][j*3+2]/100)}
  let first=c.findIndex(v=>v>=0.35);if(first<0)first=0;
  let lx=x[first],ly=y[first];
  for(let i=0;i<N;i++){if(c[i]<0.35){x[i]=lx;y[i]=ly}else{lx=x[i];ly=y[i]}}
  x=med(x,7);y=med(y,7);
  ser[k]={x,y,h:y.map(v=>1-v),c};
});
ser.hip={x:ser.Lh.x.map((v,i)=>(v+ser.Rh.x[i])/2),h:ser.Lh.h.map((v,i)=>(v+ser.Rh.h[i])/2)};
const pct=(a,p)=>{const s=a.slice().sort((x,y)=>x-y);return s[Math.floor(p*(s.length-1))]};
const handAll=ser.Lw.h.concat(ser.Rw.h),footAll=ser.La.h.concat(ser.Ra.h);
const R={hand:[pct(handAll,.04),pct(handAll,.96)],foot:[pct(footAll,.04),pct(footAll,.96)],hip:[pct(ser.hip.h,.04),pct(ser.hip.h,.96)]};
const hxAll=ser.Lw.x.concat(ser.Rw.x),fxAll=ser.La.x.concat(ser.Ra.x);
const Rx={hand:[pct(hxAll,.04),pct(hxAll,.96)],foot:[pct(fxAll,.04),pct(fxAll,.96)]};
// moves: a limb that was travelling comes to rest = a grab / a step
function events(h,up,down,hold){
  const w=5,ev=[];let mv=false,calm=0;
  for(let i=w;i<h.length;i++){
    const s=Math.abs(h[i]-h[i-w])*FPS/w;
    if(!mv&&s>up){mv=true;calm=0}
    else if(mv){calm=s<down?calm+1:0;if(calm>=hold){ev.push(Math.max(0,i-hold));mv=false}}
  }
  return ev;
}
const EV={};
function recomputeEV(){
  const u=P.up/100,fu=u*0.6;
  EV.Lw=events(ser.Lw.h,u,.08,P.hold);EV.Rw=events(ser.Rw.h,u,.08,P.hold);
  EV.La=events(ser.La.h,fu,.06,P.hold);EV.Ra=events(ser.Ra.h,fu,.06,P.hold);
  S.fired={};
  UI.text('stats',`换点次数：左手 ${EV.Lw.length}，右手 ${EV.Rw.length}，左脚 ${EV.La.length}，右脚 ${EV.Ra.length}（30 秒）`);
}
// body energy: mean 2-D speed of the limbs, smoothed, scaled 0..1
const E=(()=>{
  const ks=['Lw','Rw','La','Ra','Lh','Rh'],e=new Array(N).fill(0),w=5;
  for(let i=w;i<N;i++){let s=0;ks.forEach(k=>{s+=Math.hypot(ser[k].x[i]-ser[k].x[i-w],ser[k].y[i]-ser[k].y[i-w])*FPS/w});e[i]=s/ks.length}
  const sm=e.map((_,i)=>{let a=0,n=0;for(let k=Math.max(0,i-6);k<=Math.min(N-1,i+6);k++){a+=e[k];n++}return a/n});
  const lo=pct(sm,.2),hi=pct(sm,.95);return sm.map(v=>Math.max(0,Math.min(1,(v-lo)/(hi-lo+1e-9))));
})();

/* ---------- scale, pitch mapping, harmony ---------- */
let SN=[];                       // every pentatonic note of the current key, MIDI 0..127
function buildSN(){SN=[];for(let n=0;n<128;n++)if(PENT.includes(((n-P.key)%12+12)%12))SN.push(n)}
buildSN();
function stepIdx(m){let b=0;for(let i=0;i<SN.length;i++)if(Math.abs(SN[i]-m)<Math.abs(SN[b]-m))b=i;return b}
const snAt=i=>SN[clamp(i,0,SN.length-1)];
const nearest=(c,raw)=>{let b=c[0];for(const x of c){const d=Math.abs(x-raw),e=Math.abs(b-raw);if(d<e||(d===e&&x<b))b=x}return b};
let handM=[],footM=[];
function rows(start,oct){
  const want=PENT.length*oct+1,n=[];
  for(let o=0;n.length<want;o++)for(const i of PENT)if(n.length<want)n.push(start+o*12+i);
  return Array.from({length:32},(_,r)=>n[Math.floor(r*n.length/32)]);
}
function rebuild(){const ko=P.key>6?P.key-12:P.key;handM=rows(60+ko+12*P.shift,P.oct);footM=rows(36+ko,2)}
buildSN();rebuild();
// 0..1 position of a limb along the dimension that carries pitch (A: height, B: width)
function pos(kind,k,i){
  const r=R[kind];return clamp((ser[k].h[i]-r[0])/(r[1]-r[0]),0,1);
}
const rowOfP=p=>clamp(Math.round(p*31),0,31);
const handMidiK=(k,i)=>handM[rowOfP(pos('hand',k,i))];
const footMidiK=(k,i)=>footM[rowOfP(pos('foot',k,i))];
const hn=(k,i)=>clamp((ser[k].h[i]-R.hand[0])/(R.hand[1]-R.hand[0]),0,1);   // height 0..1, always

// the two hands as a pair
function handNotes(i){
  const a=handMidiK('Lw',i),b=handMidiK('Rw',i);
  if(P.hrel==='indep'){let mL=a,mR=b;if(Math.abs(mL-mR)<3){if(mL>=mR)mR-=12;else mL-=12}return[mL,mR]}
  const leadR=P.lead==='R',ld=leadR?b:a,raw=leadR?a:b,li=stepIdx(ld);
  let f;
  if(P.hrel==='par')f=snAt(li-P.par);
  else f=nearest([-5,-3,-2,2,3,5].map(s=>snAt(li+s)),raw);   // pentatonic steps 2/3/5 = 3rd-4th / 5th / octave: always consonant
  return leadR?[f,ld]:[ld,f];
}
// harmony: the root drifts with how high the body is, and TOP brings it home
let ROOTS=[0,7,9];   // I V vi in the bright scale; I IV bVII in blues (set when the scale changes)
const ROOTIDX=(()=>{
  const lo=R.hip[0],hi=R.hip[1],out=[];let cur=0,cand=0,cnt=0;
  for(let i=0;i<N;i++){
    let a=0,n=0;for(let k=Math.max(0,i-15);k<=Math.min(N-1,i+15);k++){a+=ser.hip.h[k];n++}
    const x=(a/n-lo)/(hi-lo+1e-9),want=x<.38?0:x<.68?1:2;
    if(want===cur)cnt=0;else if(want===cand){if(++cnt>=40){cur=want;cnt=0}}else{cand=want;cnt=1}
    out.push(cur);
  }
  return out;
})();
const rootPc=i=>P.harm==='fix'?P.key:(P.key+ROOTS[ROOTIDX[Math.min(N-1,Math.max(0,i))]])%12;
const bassOf=i=>36+rootPc(i);
function chordPcs(i){const ri=stepIdx(60+rootPc(i));return [0,2,3,5].map(s=>snAt(ri+s)%12)}
function chordTones(i,lo,hi){const ps=chordPcs(i),o=[];for(let n=lo;n<=hi;n++)if(ps.includes(n%12))o.push(n);return o}
const tonicNear=m=>{let b=null;for(let n=m-8;n<=m+8;n++)if(((n%12)+12)%12===P.key&&(b===null||Math.abs(n-m)<Math.abs(b-m)))b=n;return b};

/* ---------- audio ---------- */
let ac=null,dry=null,vL=null,vR=null,tap=null;
const waves={};
function wave(a){const k=a.join();return waves[k]||(waves[k]=ac.createPeriodicWave(new Float32Array(a.length+1),Float32Array.from([0,...a])))}
function initAudio(){
  if(ac){if(ac.state==='suspended')ac.resume();return}
  ac=new (window.AudioContext||window.webkitAudioContext)({latencyHint:'playback'});
  const comp=ac.createDynamicsCompressor();comp.threshold.value=-10;comp.knee.value=6;comp.ratio.value=12;comp.attack.value=0.003;comp.release.value=0.15;
  const master=ac.createGain();master.gain.value=0.5;
  const ws=ac.createWaveShaper(),cur=new Float32Array(2048);for(let i=0;i<2048;i++){cur[i]=Math.tanh((i/1023.5-1)*1.0)}ws.curve=cur;ws.oversample='2x';
  // 出口闸门（增益 1，不改变声音）：用户暂停时 hush() 用它把所有余音一起淡掉
  const gate=ac.createGain();S.gate=gate;
  master.connect(comp);comp.connect(ws);ws.connect(gate);gate.connect(ac.destination);
  tap=ac.createAnalyser();tap.fftSize=2048;master.connect(tap);
  dry=ac.createGain();dry.connect(master);
  const hp=ac.createBiquadFilter();hp.type='highpass';hp.frequency.value=220;
  const lp=ac.createBiquadFilter();lp.type='lowpass';lp.frequency.value=3200;
  const dl=ac.createDelay(1);dl.delayTime.value=0.3;
  const fb=ac.createGain();fb.gain.value=0.3;
  const wet2=ac.createGain();wet2.gain.value=P.echo/100;S.wet=wet2;S.wetLast=P.echo/100;
  dry.connect(hp);hp.connect(lp);lp.connect(dl);dl.connect(fb);fb.connect(hp);dl.connect(wet2);wet2.connect(master);
  vL=sustain('flute');vR=sustain('strings');
}
function sustain(kind){
  const g=ac.createGain();g.gain.value=0;const lp=ac.createBiquadFilter();lp.type='lowpass';lp.Q.value=0.7;lp.connect(g);g.connect(dry);
  const oscs=[];let base;
  if(kind==='flute'){
    base=3000;lp.frequency.value=base;
    const o=ac.createOscillator();o.setPeriodicWave(wave([1,0.1]));o.frequency.value=440;
    const l=ac.createOscillator(),lg=ac.createGain();l.frequency.value=4.5;lg.gain.value=2;l.connect(lg);lg.connect(o.frequency);
    o.connect(lp);o.start();l.start();oscs.push([o,1]);
  }else{
    base=2000;lp.frequency.value=base;
    [1,1.008].forEach(r=>{const o=ac.createOscillator();o.type='triangle';o.frequency.value=440;const m=ac.createGain();m.gain.value=0.5;o.connect(m);m.connect(lp);o.start();oscs.push([o,r])});
  }
  return{g,oscs,lp,base,lastF:base};
}
function setVoice(v,midi,glide){
  const f=440*Math.pow(2,(midi-69)/12),t=ac.currentTime;
  v.oscs.forEach(([o,r])=>o.frequency.setTargetAtTime(f*r,t,Math.max(0.004,glide/3)));
}
function setBright(v,f){if(Math.abs(f-v.lastF)>25){v.lp.frequency.setTargetAtTime(f,ac.currentTime,0.12);v.lastF=f}}
const loud=f=>f<330?Math.min(2.2,Math.pow(330/Math.max(f,40),0.45)):f>1400?Math.pow(1400/f,0.12):1;
function pluck(kind,midi,vel,when){
  if(vel<=0.001)return;
  const f=440*Math.pow(2,(midi-69)/12),t=when||ac.currentTime+0.005;
  const lp=ac.createBiquadFilter();lp.type='lowpass';lp.Q.value=0.7;
  const g=ac.createGain();lp.connect(g);g.connect(dry);
  const o=ac.createOscillator(),nodes=[o];let dec,amp=vel*0.28*Math.min(loud(f),1.5);
  if(kind==='bass'){o.setPeriodicWave(wave([1,0.22]));lp.frequency.value=900;dec=0.7;amp*=1.2}
  else if(kind==='marimba'){o.type='sine';lp.frequency.value=3200;dec=0.45;const h=ac.createOscillator(),hg=ac.createGain();hg.gain.setValueAtTime(0.3,t);hg.gain.setTargetAtTime(0,t,0.1);h.type='sine';h.frequency.value=f*4;h.connect(hg);hg.connect(lp);nodes.push(h)}
  else if(kind==='harp'){o.setPeriodicWave(wave([1,0.28,0.07]));lp.frequency.value=3400;dec=0.9}
  else{o.type='sine';lp.frequency.value=5000;dec=1.1;const h=ac.createOscillator(),hg=ac.createGain();hg.gain.setValueAtTime(0.2,t);hg.gain.setTargetAtTime(0,t,0.3);h.type='sine';h.frequency.value=f*3.984;h.connect(hg);hg.connect(lp);nodes.push(h)}
  o.frequency.value=f;o.connect(lp);
  g.gain.setValueAtTime(0.0001,t);g.gain.linearRampToValueAtTime(amp,t+0.008);g.gain.setTargetAtTime(0,t+0.008,dec);
  nodes.forEach(n=>{n.start(t);n.stop(t+dec*7+0.1)});
}
// a slow-breathing pad: swells in, holds, lets go
function swell(ms,t,len,att,v){
  ms.forEach(m=>{
    const f=440*Math.pow(2,(m-69)/12);
    [1,1.006].forEach(r=>{
      const o=ac.createOscillator();o.type='triangle';o.frequency.value=f*r;
      const lp=ac.createBiquadFilter();lp.type='lowpass';lp.frequency.value=1600;
      const g=ac.createGain();o.connect(lp);lp.connect(g);g.connect(dry);
      const pk=0.022*v*Math.min(loud(f),1.4);
      g.gain.setValueAtTime(0.0001,t);g.gain.linearRampToValueAtTime(pk,t+att);
      g.gain.setValueAtTime(pk,t+Math.max(att+0.05,len*0.5));g.gain.setTargetAtTime(0,t+len*0.5,len*0.22);
      o.start(t);o.stop(t+len*1.6+1);
    });
  });
}

/* ---------- TOP: build-up, then come home ---------- */
const HOLD=2.8;   // seconds the resolved hold lasts before the voices walk back to the climber
function detectTop(){
  const th=R.hand[0]+(P.topPct/100)*(R.hand[1]-R.hand[0]),need=Math.round(P.topHold*FPS);let run=0;
  for(let i=0;i<N;i++){run=Math.min(ser.Lw.h[i],ser.Rw.h[i])>=th&&ser.Lw.c[i]>=0.35&&ser.Rw.c[i]>=0.35?run+1:0;if(run>=need)return (i+1)/FPS}
  return null;
}
let topT=null,topAuto=true;
function showTop(){UI.text('topv',topT==null?'没有检测到 TOP。可以手动标记。':`TOP 在 ${topT.toFixed(1)} s（${topAuto?`自动检测：两手都在最高 ${100-P.topPct}% 的位置停稳 ${P.topHold.toFixed(1)} 秒`:'手动标记'}）`)}
function topState(t){
  if(topT==null||!UI.on('l-top'))return{ph:0};
  const rel=t-topT;
  if(P.leadS>0&&rel>=-P.leadS&&rel<0)return{ph:1,p:(rel+P.leadS)/P.leadS};
  if(rel>=0&&rel<HOLD)return{ph:2,rel};
  if(rel>=HOLD&&rel<HOLD+2)return{ph:3,q:(rel-HOLD)/2};
  return{ph:0};
}
// the voices resolve by the shortest step to the tonic: top voice to the nearest tonic, the other a fifth beneath it
function resolved(){
  const ti=Math.min(N-1,Math.floor(topT*FPS)),[a,b]=handNotes(ti);
  let hi=tonicNear(Math.max(a,b));while(hi<67)hi+=12;while(hi>79)hi-=12;
  const lo=hi-5;return a>=b?[hi,lo]:[lo,hi];
}
function cadence(){
  const t0=ac.currentTime+0.03,v=P.topVol/100,u=Math.max(0.17,60/(+UI.val('bpm'))/3);
  S.topReal=t0;
  const b=48+P.key;
  pluck('bass',36+P.key,0.8*v,t0);pluck('bass',43+P.key,0.4*v,t0+u*2.2);
  const th=P.scale==='blues'?15:16;
  swell([b,b+7,b+12,b+th,b+19],t0,3.8,0.4,v);
  const arp=[b+12,b+19,b+24,b+24+th],gap=[0,1,2.1,3.7].map(x=>0.14+x*u*1.15);
  arp.forEach((m,i)=>pluck('harp',m,(0.45-i*0.05)*v,t0+gap[i]));
  pluck('chime',b+36,0.3*v,t0+gap[3]+0.04);
  const fi=Math.min(N-1,Math.floor(vid.currentTime*FPS)),hx=ser.Lw.x[fi],hy=ser.Lw.y[fi];
  S.confetti=[];
  for(let i=0;i<36;i++){const a=Math.random()*Math.PI*2,sp=0.1+Math.random()*0.3;
    S.confetti.push({x:hx,y:hy,vx:Math.cos(a)*sp*0.6,vy:Math.sin(a)*sp-0.14,c:['#4da3ff','#ff5a4d','#3ecf8e','#ffb347','#f1ead6'][i%5],s:2+Math.random()*2.5})}
}

/* ---------- live driver (follows the video clock) ---------- */
const S={confetti:[],topDone:false,topReal:-9,lastStep:-1,lastArp:-1,lastT:0,flash:[],fired:{},wet:null,wetLast:0,lastPed:-1};
function audioStep(t){
  t+=(ac.baseLatency||0)+(ac.outputLatency||0.02);   // fire early by the output latency so sound lands with the picture
  const bpm=+UI.val('bpm'),grid=UI.val('grid');
  const fi=Math.min(N-1,Math.floor(t*FPS));
  const sd=grid==='free'?0:60/bpm/({t:3,e:2,q:1}[grid]);
  const jumped=Math.abs(t-S.lastT)>0.4;S.lastT=t;
  const playing=!vid.paused&&ac;
  const now=ac.currentTime;
  if(jumped){for(const v of [vL,vR]){v.g.gain.cancelScheduledValues(now);v.g.gain.setValueAtTime(v.g.gain.value,now);v.g.gain.linearRampToValueAtTime(0,now+0.03);v.last=0}}
  const ts=topState(t);
  // layers other than the hands give way gently around the cadence, then come back
  let dk=1;
  if(ts.ph===2)dk=ts.rel<.35?1-.65*ts.rel/.35:.35;else if(ts.ph===3)dk=.35+.65*ts.q;
  const bu=ts.ph===1?ts.p:0;
  const wantWet=P.echo/100+0.22*bu+(ts.ph===2?0.15:0);
  if(Math.abs(wantWet-S.wetLast)>0.004){S.wet.gain.setTargetAtTime(wantWet,now,0.3);S.wetLast=wantWet}
  if(topT!=null&&t<topT-0.3)S.topDone=false;
  if(UI.on('l-top')&&topT!=null&&playing&&!jumped&&!S.topDone&&t>=topT&&t<topT+0.4){S.topDone=true;cadence()}
  // dominant pedal under the build-up: tension that wants to resolve
  if(ts.ph===1&&playing&&!jumped){
    const bi=Math.floor(t/(60/bpm));
    if(bi!==S.lastPed){S.lastPed=bi;if(bi%2===0)pluck('bass',36+(P.key+7)%12,(0.3+0.5*bu)*P.topVol/100)}
  }
  // hands
  const on=UI.on('l-hands')&&playing;
  const step=sd?Math.floor(t/sd):fi,changed=step!==S.lastStep;
  const si=sd?Math.min(N-1,Math.round(step*sd*FPS)):fi;
  let [mL,mR]=handNotes(si);
  if(ts.ph===2)[mL,mR]=resolved();
  const gl=ts.ph===2?0.16:ts.ph===3?0.45:P.glide/1000;
  if(changed||!sd||ts.ph>=2){setVoice(vL,mL,gl);setVoice(vR,mR,gl)}
  const cL=ser.Lw.c[fi]>=0.35,cR=ser.Rw.c[fi]>=0.35;
  let lv,rv;
  if(ts.ph===2){lv=rv=on?0.3:0}else{lv=on&&cL?0.34:0;rv=on&&cR?0.3:0}
  const gh=P.gH/100*(1+0.35*bu);
  lv*=gh;rv*=gh;
  setGain(vL,lv*Math.min(loud(440*Math.pow(2,(mL-69)/12)),1.5));
  setGain(vR,rv*Math.min(loud(440*Math.pow(2,(mR-69)/12)),1.5));
  setBright(vL,vL.base*(1+0.6*bu));setBright(vR,vR.base*(1+0.6*bu));
  S.lastStep=step;
  // grab / step events
  if(!jumped&&playing){
    const t0=t-0.12;
    for(const k of ['Lw','Rw','La','Ra']){
      for(const e of EV[k]){
        const et=e/FPS;
        if(et>t0&&et<=t&&!S.fired[k+e]){
          S.fired[k+e]=1;
          if(k[1]==='w'){
            if(UI.on('l-touch')){
              let m=k==='Lw'?mL:mR;
              if(P.tsnap==='chord')m=nearest(chordTones(e,m-8,m+8),m);
              pluck('marimba',m,0.8*dk*P.gT/100);
            }
          }else if(UI.on('l-feet')){
            const m=P.frel==='rf'?bassOf(e)+(k==='Ra'?7:0):footMidiK(k,Math.min(N-1,e));
            pluck('bass',m,1*dk*P.gF/100);
          }
          S.flash.push({k,t:et,real:now});
        }
      }
    }
  }
  if(jumped)S.fired={};
  // body rhythm
  if(UI.on('l-arp')&&playing){
    const ad=sd||60/bpm/2,as=Math.floor(t/ad);
    if(as!==S.lastArp){
      S.lastArp=as;
      let lvl=clamp(E[fi]+(P.dens-50)/100*0.8,0,1);lvl=lvl+bu*(1-lvl)*0.9;
      const every=lvl<0.12?0:lvl<0.4?6:lvl<0.7?3:1;
      if(every&&as%every===0){
        let tones;
        if(P.rhy==='chord')tones=chordTones(fi,72,91);
        else{const hipM=handM[rowOfP(pos('hand','hip',fi))];tones=[mL,mR,hipM].map(n=>{while(n<72)n+=12;while(n>91)n-=12;return n}).sort((a,b)=>a-b)}
        const pat=[0,1,2,1][(as/every|0)%4];
        pluck('chime',tones[pat%tones.length],0.7*dk*P.gA/100);
      }
    }
  }
}
function setGain(v,x){if(v.last===undefined||Math.abs(v.last-x)>0.004){v.g.gain.setTargetAtTime(x,ac.currentTime,0.08);v.last=x}}
function silence(){if(!ac)return;setGain(vL,0);setGain(vR,0)}
// 用户暂停：silence() 只淡出两只手，已排好的拨奏、回声、TOP 垫音还会响几秒。
// 这里把出口 15ms 淡到 0，再关掉这套音频图；下次 initAudio() 会重建（缓存的 PeriodicWave 属于旧 context，一起清掉）。
function hush(){
  if(!ac)return;const c=ac,g=S.gate;
  g.gain.setTargetAtTime(0,c.currentTime,0.015);
  ac=null;for(const k in waves)delete waves[k];
  setTimeout(()=>c.close().catch(()=>{}),150);
}

recomputeEV();
topT=detectTop();showTop();
window.__dbg={ser,EV,E,R,Rx,P,ROOTIDX,handNotes,resolved,topState,chordPcs,SN:()=>SN,peak:()=>{if(!tap)return 0;const b=new Float32Array(2048);tap.getFloatTimeDomainData(b);let m=0;for(const v of b)m=Math.max(m,Math.abs(v));return m},topT:()=>topT};
