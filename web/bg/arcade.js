/* 商店街の背景（claude.ai のデザインプロジェクトから取り込み・2026-10-03）。
   🔴 **ここは預かりもの。手で直さない。** 直すならデザイン側で直して取り込み直す。
   🔑 `drawArcade(makeLib, createCanvas)` が 960×540 の canvas を返す。
      中央はパネルが覆う前提で空けてある（`docs/image-prompts.md` の指定）。 */
function drawArcade(makeLib, createCanvas){
  const c = createCanvas(960,540), ctx = c.getContext('2d');
  const Lb = makeLib(ctx,{seed:21});
  const {P,rect,poly,ell,ellO,line,dith,rnd,pick,person} = Lb;
  const WIN = '!#ffd23a';
  const VX = 480, VY = 400;
  const pr = (X,Y,z) => { const s = 1/(1+z); return [VX+X*s, VY+Y*s]; };
  const wq = (X,Ya,Yb,za,zb,col) => poly([pr(X,Ya,za),pr(X,Ya,zb),pr(X,Yb,zb),pr(X,Yb,za)],col);
  const bres = (x0,y0,x1,y1,col) => { x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1); const dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1; let e=dx+dy; for(;;){ rect(x0,y0,1,1,col); if(x0===x1&&y0===y1)break; const e2=2*e; if(e2>=dy){e+=dy;x0+=sx;} if(e2<=dx){e+=dx;y0+=sy;} } };
  const dpoly = (pts,col,ph) => { Lb.fill(col); let a=Infinity,b=-Infinity; for(const p of pts){a=Math.min(a,p[1]);b=Math.max(b,p[1]);} for(let y=Math.floor(a);y<=Math.ceil(b);y++){ const yc=y+0.5,xs=[]; for(let i=0;i<pts.length;i++){const p=pts[i],q=pts[(i+1)%pts.length]; if((p[1]<=yc&&q[1]>yc)||(q[1]<=yc&&p[1]>yc)) xs.push(p[0]+(yc-p[1])*(q[0]-p[0])/(q[1]-p[1]));} xs.sort((m,n)=>m-n); for(let i=0;i+1<xs.length;i+=2) for(let x=Math.round(xs[i]);x<Math.round(xs[i+1]);x++) if((x+y+(ph||0))%2===0) ctx.fillRect(x,y,1,1); } };
  const vaultY = X => -150 - 200*Math.sqrt(Math.max(0,1-(X/280)**2));
  rect(0,0,960,420,P.sky3);
  poly([pr(-280,-150,3),pr(280,-150,3),pr(280,80,3),pr(-280,80,3)],P.cr);
  rect(pr(-280,0,3)[0],pr(0,40,3)[1],140,8,P.g2);
  const XS = [-280,-210,-130,-45,45,130,210,280], ZS = [-0.6,-0.2,0.25,0.75,1.35,2.1,3];
  for (let i = 0; i+1 < XS.length; i++) for (let j = 0; j+1 < ZS.length; j++){
    if ((i+j)%2) continue;
    const a = XS[i], b = XS[i+1], za = ZS[j], zb = ZS[j+1];
    poly([pr(a,vaultY(a),za),pr(b,vaultY(b),za),pr(b,vaultY(b),zb),pr(a,vaultY(a),zb)],P.cr);
  }
  const segs = [0,0.45,0.95,1.55,2.25,3];
  const signC = [P.b,P.r,P.g2,P.y,P.o,P.c1];
  for (const side of [-1,1]){
    const X = 280*side;
    wq(X,-150,80,0,3,P.cr2);
    for (let i = 0; i+1 < segs.length; i++){
      const za = segs[i], zb = segs[i+1], m = (zb-za)*0.08;
      wq(X,-130,-75,za+m*2,zb-m*2,P.cr3);
      wq(X,-118,-88,za+m*4,zb-m*4,P.sky2);
      wq(X,-62,-36,za+m,zb-m,P.k);
      wq(X,-60,-38,za+m*1.5,zb-m*1.5,signC[(i+(side>0?3:0))%6]);
      const n = 6; for (let k = 0; k < n; k++) wq(X,-30,-12,za+(zb-za)*k/n,za+(zb-za)*(k+1)/n,k%2?P.cr:P.o);
      wq(X,-12,80,za+m,zb-m,P.s4);
      wq(X,-6,50,za+m*2,zb-m*2,WIN);
      wq(X,10,30,za+m*3,za+(zb-za)*0.45,pick([P.r,P.b,P.g2,P.cr]));
      wq(X,0,25,za+(zb-za)*0.55,zb-m*3,pick([P.o,P.b,P.r,P.cr]));
      wq(X,-150,80,za-0.02,za+0.03,P.c2);
      const lp = pr(X,-10,za+0.06); const s = 1/(1+za);
      rect(lp[0]-3*s,lp[1],7*s,10*s,P.k); rect(lp[0]-2*s,lp[1]+s,5*s,8*s,'!'+P.r);
    }
    wq(X,-150,-146,0,3,P.c2);
  }
  poly([pr(-280,80,0),pr(280,80,0),pr(280,80,3),pr(-280,80,3)],P.cr2);
  rect(0,480,960,60,P.cr2);
  poly([pr(-90,80,-0.3),pr(90,80,-0.3),pr(90,80,3),pr(-90,80,3)],P.cr);
  for (let X = -420; X <= 420; X += 70) bres(...pr(X,80,-0.25),...pr(X,80,3),P.cr3);
  for (const z of [-0.2,0,0.3,0.7,1.2,1.9,2.6]){ const y = Math.round(pr(0,80,z)[1]); rect(0,y,960,1,P.cr3); }
  for (const [x0,w] of [[300,26],[420,18],[560,30],[680,16]]) dpoly([[x0,40],[x0+w,40],[x0+w+150,480],[x0+150,480]],'!#fff8e6');
  for (const [x0,w] of [[300,26],[420,18],[560,30],[680,16]]) dpoly([[x0+150,480],[x0+w+150,480],[x0+w+170,540],[x0+170,540]],'!#ffffff',1);
  for (const z of ZS){
    const pts = []; for (let X = -280; X <= 280; X += 10) pts.push(pr(X,vaultY(X),z));
    const w = Math.max(2, 5/(1+z));
    line(pts,w+2,P.k); line(pts,w,P.c2);
  }
  for (const X of XS) { const a = pr(X,vaultY(X),-0.6), b = pr(X,vaultY(X),3); line([a,b],3,P.k); line([a,b],1,P.c1); }
  for (const [x,y] of [[468,420],[500,421]]) person(x,y,{s:1,shadow:false});
  const facade = (x0,w) => {
    rect(x0,250,w,230,P.k); rect(x0+1,251,w-2,229,P.cr2);
    rect(x0+8,262,w-16,52,P.k); rect(x0+9,263,w-18,50,P.sky2); rect(x0+9,263,w-18,8,P.sky3);
    rect(x0+w/2-1,263,2,50,P.k);
    rect(x0+1,322,w-2,4,P.c1);
  };
  const sign = (x0,w,col) => { rect(x0+6,338,w-12,30,P.k); rect(x0+7,339,w-14,28,col); rect(x0+7,339,w-14,3,P.cr); };
  const awning = (x0,w) => {
    rect(x0,368,w,22,P.k);
    for (let x = x0+1; x < x0+w-1; x += 8) { rect(x,369,Math.min(8,x0+w-1-x),18,((x-x0)/8)%2?P.cr:P.o); }
    for (let x = x0+1; x < x0+w-1; x += 8) { rect(x+1,387,6,3,((x-x0)/8)%2?P.cr:P.o); rect(x,389,8,1,P.k); }
    rect(x0+1,369,w-2,3,P.y);
  };
  const opening = (x0,w,col) => { rect(x0+4,392,w-8,88,P.k); rect(x0+5,393,w-10,87,col||P.s4); };
  const jersey = (x,y,col) => { rect(x-9,y-1,18,6,P.k); rect(x-6,y-1,12,19,P.k); rect(x-8,y,16,4,col); rect(x-5,y,10,17,col); rect(x-2,y,4,2,P.cr); };
  facade(0,98); sign(0,98,P.b); awning(0,98); opening(0,98,WIN);
  rect(10,404,78,3,P.k); for (let i = 0; i < 4; i++) jersey(20+i*19,407,[P.b,P.r,P.y,P.g2][i]);
  rect(8,446,82,4,P.s3); rect(14,450,3,30,P.s4); rect(80,450,3,30,P.s4);
  for (let i = 0; i < 4; i++){ rect(16+i*18,438,14,8,P.k); rect(17+i*18,439,12,6,[P.cr,P.b,P.r,P.c1][i]); }
  facade(98,100); sign(98,100,P.r); awning(98,100); opening(98,100,P.cr3);
  rect(118,400,42,40,P.k); rect(119,401,40,38,P.sky3); rect(121,403,8,30,P.cr);
  rect(130,446,22,20,P.k); rect(131,447,20,10,P.r); rect(138,457,6,22,P.k); rect(132,476,18,4,P.k);
  rect(170,398,12,62,P.k); for (let y = 399; y < 459; y++){ const t = (y*1)%12; rect(171,y,10,1,t<4?P.r:(t<8?P.cr:P.b)); } rect(169,394,14,5,P.k); rect(170,395,12,3,P.c1); rect(169,459,14,5,P.k);
  rect(100,476,96,6,P.k); rect(101,477,94,4,P.c1);
  rect(178,466,14,9,P.k); rect(179,467,12,8,P.h3); rect(188,462,6,6,P.k); rect(189,463,4,4,P.h3); rect(189,461,1,2,P.k); rect(192,461,1,2,P.k); rect(176,468,3,2,P.k); rect(190,464,1,1,P.y);
  facade(762,62); sign(762,62,P.y); awning(762,62); opening(762,62,P.cr3);
  rect(770,440,46,6,P.k); rect(771,441,44,4,P.s3); rect(774,446,3,34,P.s4); rect(808,446,3,34,P.s4);
  for (let i = 0; i < 5; i++){ rect(774+i*8,434,5,5,P.k); rect(775+i*8,435,3,3,[P.r,P.y,P.b,P.cr,P.o][i]); }
  rect(772,402,42,2,P.k); for (let i = 0; i < 5; i++){ ell(778+i*8,414,3,5,P.k); ell(778+i*8,414,2,4,[P.y,P.cr,P.r,P.b,P.y][i]); ell(778+i*8,414,1,3,P.cr3); }
  facade(824,82); sign(824,82,P.r); awning(824,82); opening(824,82,P.s4);
  for (let i = 0; i < 5; i++){ rect(832+i*14,392,12,30,P.k); rect(833+i*14,392,10,29,P.b); }
  rect(830,446,70,6,P.k); rect(831,447,68,4,P.cr3); rect(840,452,3,28,P.s3);
  rect(870,430,22,16,P.k); rect(871,431,20,14,P.c2); rect(871,431,20,3,P.c1);
  for (const [dx,dy] of [[0,0],[4,-6],[-2,-12],[3,-18],[0,-24]]) rect(878+dx,424+dy,4,3,P.cr);
  facade(906,60); sign(906,60,P.g2); awning(906,60); opening(906,60,WIN);
  for (const sy of [408,428,448]){ rect(912,sy+10,48,3,P.s4); for (let i = 0; i < 3; i++){ const col = [P.r,P.b,P.cr,P.k2,P.o][(i+sy)%5]; rect(914+i*15,sy+3,12,7,P.k); rect(915+i*15,sy+4,10,5,col); rect(915+i*15,sy+4,4,2,P.cr); } }
  for (const x of [96,196,760,822,904]) { rect(x,250,4,232,P.k); rect(x+1,251,2,230,P.c2); }
  for (const [x0,x1] of [[0,198],[762,960]]){
    for (let x = x0; x < x1; x++) rect(x,232+Math.round(6*Math.sin((x-x0)/(x1-x0)*Math.PI)),1,1,P.k);
    for (let x = x0+14; x < x1-6; x += 28){ const y = 236+Math.round(6*Math.sin((x-x0)/(x1-x0)*Math.PI)); ell(x,y+7,6,8,P.k); ell(x,y+7,5,7,'!'+P.r); rect(x-4,y-1,9,3,P.k); rect(x-3,y,7,1,P.y); rect(x-4,y+14,9,3,P.k); rect(x-1,y+3,2,8,P.o); }
  }
  for (const [x,col] of [[60,P.b],[150,P.o],[790,P.g2],[870,P.b]]){
    rect(x-1,262,2,60,P.k); rect(x+1,262,16,62,P.k); rect(x+2,263,14,60,col); rect(x+2,263,14,4,P.cr); rect(x+2,319,14,4,P.cr);
  }
  rect(6,436,30,48,P.k); rect(7,437,28,46,P.r); rect(10,440,22,16,P.sky2); for (let i = 0; i < 3; i++) rect(12+i*7,444,4,8,[P.cr,P.y,P.b][i]); rect(10,460,22,3,P.cr); rect(14,470,14,6,P.k2);
  for (const [x,y] of [[838,462],[852,462],[845,446]]){ rect(x,y,16,16,P.k); rect(x+1,y+1,14,14,P.s3); rect(x+1,y+6,14,2,P.s4); rect(x+3,y-2,4,3,P.o); rect(x+9,y-2,4,3,P.y); }
  const bx = 920, by = 510;
  for (const dx of [-14,14]){ ell(bx+dx,by,11,11,P.k); ell(bx+dx,by,9,9,P.cr2); ell(bx+dx,by,2,2,P.k); }
  line([[bx-14,by],[bx,by-14],[bx+14,by]],3,P.b); line([[bx,by-14],[bx-4,by]],3,P.b); rect(bx-6,by-18,9,3,P.k); rect(bx+10,by-22,3,10,P.k); rect(bx+8,by-23,8,2,P.k);
  const SH = P.cr3;
  for (const [x,y,w] of [[40,516,1],[72,532,0],[128,500,1],[158,528,0],[186,524,1],[776,520,0],[796,508,1],[862,530,1],[888,494,0]]) person(x,y,{s:3,walk:!!w,shadow:SH});
  return c;
}
