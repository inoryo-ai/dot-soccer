/* 街ハブの背景（claude.ai のデザインプロジェクトから取り込み・2026-10-03）。
   🔴 **ここは預かりもの。手で直さない。** 直すならデザイン側で直して取り込み直す。
   🔑 `drawTown(night, makeLib, createCanvas)` が 960×540 の canvas を返す。
      施設の位置は `src/web/bg.ts` の `TOWN_SPOTS` と**必ずそろえる**（押せる場所がずれる）。 */
function drawTown(night, makeLib, createCanvas){
  const c = createCanvas(960,540), ctx = c.getContext('2d');
  const Lb = makeLib(ctx,{night,seed:7});
  const {P,rect,poly,ell,ellO,line,dith,dithEll,rnd,pick,person,tree,box,pathDist,mix,map} = Lb;
  const nr = makeLib(ctx,{seed:99}).rnd;
  const Pf = Lb.iso(480,0);
  const LAMP = '!#fffbe8', WIN = '!#ffd23a';
  if (!night){
    rect(0,0,960,50,P.sky1); dith(0,44,960,6,P.sky2);
    rect(0,50,960,42,P.sky2); dith(0,86,960,6,P.sky3);
    rect(0,92,960,26,P.sky3);
    for (const [x,y,s] of [[140,40,1],[420,62,0.8],[760,30,1.2],[880,78,0.7]]){
      const bl = [[0,0,20],[-18,5,13],[18,5,14],[-32,9,8],[32,9,9]];
      for (const b of bl) ell(x+b[0]*s,y+b[1]*s,b[2]*s,b[2]*0.6*s,P.cr);
      rect(x-38*s,y+10*s,76*s,3,P.sky3);
    }
  } else {
    rect(0,0,960,46,'!#04061a'); dith(0,40,960,6,'!#111a46');
    rect(0,46,960,40,'!#111a46'); dith(0,80,960,6,'!#3a2c68');
    rect(0,86,960,32,'!#3a2c68'); dith(0,106,960,6,'!#ffbe96'); rect(0,112,960,6,'!#ffbe96');
    for (let i = 0; i < 90; i++){ const x = Math.floor(nr()*960), y = Math.floor(nr()*96); rect(x,y,1,1,'!#fff8e6'); if (nr() < 0.12){ rect(x-1,y,3,1,'!#fff8e6'); rect(x,y-1,1,3,'!#fff8e6'); } }
    ell(820,40,10,10,'!#fff8e6'); ell(816,37,4,4,'!#e9e2d0');
  }
  rect(0,118,960,20,P.sky1);
  for (let i = 0; i < 70; i++){ const x = Math.floor(rnd()*960), y = 120+Math.floor(rnd()*15); rect(x,y,2+Math.floor(rnd()*4),1,night?'!#3a2c68':P.sky2); }
  if (night) for (let i = 0; i < 40; i++) rect(Math.floor(nr()*960),119+Math.floor(nr()*4),3,1,'!#ffbe96');
  ell(130,118,70,9,P.g3); rect(60,118,140,1,P.k);
  rect(150,96,6,16,P.k); rect(151,97,4,14,P.cr); rect(151,101,4,3,P.r); rect(149,93,8,4,P.k); rect(150,94,6,2,night?LAMP:P.y);
  rect(0,136,960,6,P.cr2);
  for (let x = 0; x < 960; x += 10) rect(x+(x%20?3:0),135,5,1,P.cr);
  rect(0,141,960,399,P.g1);
  for (let i = 0; i < 1700; i++){ const x = Math.floor(rnd()*960), y = 142+Math.floor(rnd()*398); rect(x,y,2,1,rnd()<0.5?P.g2:P.g3); }
  const river = [[945,130],[860,200],[720,250],[610,300],[520,370],[450,450],[410,560]];
  line(river,32,P.k); line(river,30,P.c1); line(river,24,P.sky1);
  for (let i = 0; i < 40; i++){ const s = Math.floor(rnd()*(river.length-1)), t = rnd(), a = river[s], b = river[s+1]; rect(a[0]+(b[0]-a[0])*t+(rnd()-0.5)*10, a[1]+(b[1]-a[1])*t, 4, 1, night?'!#ffbe96':P.sky2); }
  const roads = [[[40,560],[876,142]],[[156,148],[980,560]],[[464,142],[980,400]]];
  for (const r of roads) line(r,16,P.k);
  for (const r of roads) line(r,14,P.c1);
  for (const r of roads) line(r,10,P.cr3);
  for (const [bx,by] of [[551,346],[699,260]]){
    const d = [2/Math.sqrt(5),1/Math.sqrt(5)], n = [-d[1],d[0]];
    for (const sgn of [-1,1]){
      const a = [bx-d[0]*20+n[0]*7*sgn, by-d[1]*20+n[1]*7*sgn], b = [bx+d[0]*20+n[0]*7*sgn, by+d[1]*20+n[1]*7*sgn];
      line([a,b],4,P.k); line([a,b],2,P.cr);
    }
  }
  const PX = 510, PY = 325;
  poly([[PX-46,PY],[PX,PY-23],[PX+46,PY],[PX,PY+23]],P.k);
  poly([[PX-44,PY],[PX,PY-22],[PX+44,PY],[PX,PY+22]],P.c1);
  poly([[PX-40,PY],[PX,PY-20],[PX+40,PY],[PX,PY+20]],P.cr2);
  ellO(PX,PY,13,7,P.c1); ell(PX,PY,10,5,P.sky2); rect(PX-1,PY-9,3,8,P.k); rect(PX,PY-8,1,7,P.cr);
  const lamps = [];
  for (let x = 140; x < 860; x += 64){ const y = 580-x/2; lamps.push([x+5,y+9]); }
  for (let x = 220; x < 960; x += 72){ const y = 220+(x-300)/2; if (Math.hypot(x-551,y-346) > 24) lamps.push([x-4,y+10]); }
  if (night){ const gc = '!' + mix(map(P.g1),'#ffbe96',0.45); for (const [x,y] of lamps) dithEll(x,y,14,7,gc); }
  const objs = [], add = (y,fn) => objs.push({y,fn});
  const SX = 180, SY = 398;
  add(SY+58, () => {
    const rx = 118, ry = 58, H = 24;
    ell(SX+16,SY+8,rx+4,ry+3,P.g3);
    for (let z = 0; z <= H; z++) ell(SX,SY-z,rx+1,ry+1,P.k);
    for (let z = 0; z < H; z++) ell(SX,SY-z,rx,ry,P.c1);
    ctx.save(); ctx.beginPath(); ctx.rect(SX+40,0,400,600); ctx.clip();
    for (let z = 0; z < H; z++) ell(SX,SY-z,rx,ry,P.c2);
    ctx.restore();
    for (let a = 0.08; a < 0.95; a += 0.055){ const x = SX + rx*Math.cos(a*Math.PI)*0.98, yb = SY + ry*Math.sin(a*Math.PI); rect(x-1,yb-17,3,9,night?WIN:P.k2); }
    ell(SX,SY-H,rx,ry,P.cr);
    ell(SX,SY-H+1,rx-12,ry-6,P.k);
    ell(SX,SY-H+1,rx-13,ry-7,P.c2);
    for (let a = 0; a < Math.PI*2; a += 0.3){ const x = SX + (rx-19)*Math.cos(a), y = SY-H+1 + (ry-10)*Math.sin(a); rect(x-3,y-1,6,2, Math.sin(a) > 0.5 ? P.c1 : (Math.cos(a) > 0 ? P.r : P.b)); }
    ell(SX,SY-H+4,rx-26,ry-14,P.g3);
    const cx = SX, cy = SY-H+4, rel = (u,v) => [cx+2*(u-v), cy+(u+v)];
    poly([rel(-19,-11.5),rel(19,-11.5),rel(19,11.5),rel(-19,11.5)],P.cr);
    const a1 = 18, b1 = 10.5, n = 8;
    for (let i = 0; i < n; i++){
      let u0 = -a1 + i*2*a1/n, u1 = u0 + 2*a1/n;
      if (i === n/2) u0 += 0.5; if (i === n/2-1) u1 -= 0.5;
      poly([rel(u0,-b1),rel(u1,-b1),rel(u1,b1),rel(u0,b1)], i%2 ? P.g1 : P.g2);
    }
    ell(cx,cy,9,5,P.cr); ell(cx,cy,7,4,P.g2);
    for (const a of [0.25,0.75,1.25,1.75]){
      const x = SX + rx*0.8*Math.cos(a*Math.PI), y = SY-H + ry*0.8*Math.sin(a*Math.PI);
      rect(x-2,y-38,4,38,P.k); rect(x-1,y-37,2,37,P.c2);
      rect(x-7,y-45,14,8,P.k); rect(x-6,y-44,12,6,night?LAMP:P.cr2);
      for (let i = 0; i < 3; i++) rect(x-5+i*4,y-42,2,2,night?WIN:P.c1);
    }
  });
  add(270, () => {
    const B = box(Pf,62,90,0,90,16,18,{top:P.c1,left:P.cr,right:P.cr3,shadow:9});
    for (let i = 0; i < 9; i++){
      const u = i*10;
      B.qL(u+1.5,2,u+8.5,10,P.k); B.qL(u+2,2,u+8,9.5,WIN);
      const gcol = [P.r,P.b,P.g2,P.o,P.cr,P.s3][i%6];
      B.qL(u+3,3,u+5,6,gcol); B.qL(u+6,2,u+7.5,7,P.s3);
      B.qL(u-0.5,0,u+0.6,12,P.c2);
    }
    for (let u = 0; u < 90; u += 3) B.qL(u,11,u+3,16,(u/3)%2 ? P.cr : P.o);
    B.qL(0,10.4,90,11,P.k);
    B.qR(3,0,13,15,P.k); B.qR(4,0,12,14,P.k2); B.qR(6,0,10,10,night?WIN:P.s3);
    for (let u = 0; u < 16; u += 3) B.qR(u,15,Math.min(16,u+3),18,(u/3)%2 ? P.cr : P.o);
    const R2 = box(Pf,62,91,18,90,14,6,{top:P.o,left:P.cr,right:P.o});
    for (let u = 0; u < 90; u += 6){ R2.qT(u,0,u+3,14,P.cr); R2.qL(u,0,u+3,6,P.o); }
    for (let i = 0; i < 9; i++){ const p = B.L(i*10+5,10); rect(p[0]-2,p[1],5,6,P.k); rect(p[0]-1,p[1]+1,3,4,'!'+P.r); rect(p[0]-1,p[1]+1,3,1,P.y); }
    for (const v of [4,8,12]){ const p = B.R(v,15); rect(p[0]-2,p[1],4,5,P.k); rect(p[0]-1,p[1]+1,2,3,'!'+P.r); }
  });
  add(470, () => {
    poly([Pf(270,138,0),Pf(318,138,0),Pf(318,154,0),Pf(270,154,0)],P.cr3);
    const B = box(Pf,276,112,0,38,28,40,{top:P.c1,left:P.cr,right:P.cr3,shadow:20});
    const win = (q,u,v) => { q(u-0.6,v-0.6,u+5.6,v+9.6,P.k); q(u,v,u+5,v+9,WIN); q(u+2.2,v,u+2.8,v+9,P.cr3); };
    for (const v of [6,24]) for (const u of [3,11,19,27]) if (!(v === 6 && u === 19)) win(B.qL,u,v);
    for (const v of [6,24]) for (const u of [3,11,19]) win(B.qR,u,v);
    B.qL(17,0,25,14,P.k); B.qL(18,0,24,13,P.b); B.qL(20.6,0,21.4,13,P.k);
    B.qL(15.5,14,26.5,17,P.k); B.qL(16,14.5,26,16.5,P.r);
    B.qL(0,19,38,20,P.c1); B.qR(0,19,28,20,P.c2);
    B.qT(2,2,36,26,P.c2); B.qT(3,3,35,25,P.c1);
    box(Pf,288,118,40,10,8,6,{top:P.cr3,left:P.c1,right:P.c2});
    const pp = Pf(286,143,0); rect(pp[0]-3,pp[1]-6,7,6,P.k); rect(pp[0]-2,pp[1]-5,5,4,P.s3);
    ell(pp[0],pp[1]-10,6,5,P.k); ell(pp[0],pp[1]-10,5,4,P.g1); ell(pp[0]-1,pp[1]-12,2,2,P.g2);
    for (let i = 0; i < 3; i++){ const q = Pf(304+i*4,146,0); rect(q[0]-1,q[1]-6,2,6,P.k); }
    const bp = Pf(306,150,0);
    for (const dx of [-4,4]){ ell(bp[0]+dx,bp[1]-3,4,4,P.k); ell(bp[0]+dx,bp[1]-3,2,2,P.cr3); }
    rect(bp[0]-4,bp[1]-6,8,2,P.r); rect(bp[0]+1,bp[1]-9,2,4,P.k); rect(bp[0]-4,bp[1]-8,3,1,P.k);
  });
  const roadsD = (x,y) => Math.min(...roads.map(r => pathDist(x,y,r)));
  const blocked = (x,y,m) => {
    if (y < 158) return true;
    if (((x-SX)/(118+m))**2 + ((y-SY+10)/(70+m))**2 < 1) return true;
    if (x > 375-m && x < 625+m && y > 120 && y < 280+m) return true;
    if (x > 730-m && x < 905+m && y > 310 && y < 480+m) return true;
    if (Math.hypot(x-PX,(y-PY)*2) < 70+m) return true;
    if (roadsD(x,y) < 11+m*0.5) return true;
    if (pathDist(x,y,river) < 22+m*0.5) return true;
    if (x > 400 && x < 640 && y > 290 && y < 440) return true;
    return false;
  };
  const placed = [], free = (x,y,d) => placed.every(p => Math.hypot(p[0]-x,(p[1]-y)*1.6) > d);
  let hc = 0;
  for (let i = 0; i < 400 && hc < 16; i++){
    const x = 30+rnd()*900, y = 160+rnd()*370;
    const zone = (y < 270) || (x < 120 && y > 470) || (x > 640 && y > 480);
    if (!zone || blocked(x,y,14) || !free(x,y,34)) continue;
    placed.push([x,y]); hc++;
    const gx = (y+(x-480)/2)/2, gy = (y-(x-480)/2)/2, roof = pick([P.c2,P.s4,P.b,P.r,P.c2]);
    add(y+8, () => {
      const H = box(Pf,gx-6,gy-5,0,12,10,8,{top:P.cr2,left:P.cr,right:P.cr3,shadow:5});
      H.qL(3,2,6,5,night?WIN:P.sky2); H.qR(3,2,6,5,night?WIN:P.c2);
      const R = box(Pf,gx-7,gy-6,8,14,12,3,{top:roof,left:roof,right:P.k2});
      R.qL(0,0,14,1,P.k2);
    });
  }
  let tc = 0;
  for (let i = 0; i < 900 && tc < 70; i++){
    const x = 10+rnd()*940, y = 165+rnd()*370;
    if (blocked(x,y,6) || !free(x,y,18)) continue;
    placed.push([x,y]); tc++;
    const r = 6+Math.floor(rnd()*4);
    add(y, () => tree(x,y,r));
  }
  for (const [x,y,r] of [[430,300,7],[600,410,8],[628,392,6],[470,430,7],[575,435,6]]) add(y, () => tree(x,y,r));
  for (const [x,y] of lamps) add(y, () => { rect(x-1,y-14,3,14,P.k); rect(x,y-13,1,13,P.c2); rect(x-2,y-17,5,4,P.k); rect(x-1,y-16,3,2,night?LAMP:P.cr3); });
  const SH = night ? P.k2 : P.g3;
  const people = [];
  for (const r of roads){
    for (let i = 0; i < 14; i++){
      const t = rnd(), x = r[0][0]+(r[1][0]-r[0][0])*t, y = r[0][1]+(r[1][1]-r[0][1])*t + (rnd()-0.5)*5;
      if (y < 160 || y > 535 || x < 8 || x > 952) continue;
      if (x > 375 && x < 625 && y < 280) continue;
      people.push([Math.round(x),Math.round(y),rnd()<0.6]);
    }
  }
  for (const [x,y] of [[300,446],[310,450],[318,444],[490,340],[498,343],[536,318],[560,262],[568,266],[742,440],[750,446],[96,470],[104,474]]) people.push([x,y,rnd()<0.3]);
  if (night) people.splice(0, Math.floor(people.length*0.4));
  for (const [x,y,w] of people){ const o = {walk:w,shadow:SH,shirt:pick([P.b,P.r,P.y,P.o,P.cr,P.g2,P.c1,P.sky2]),skin:pick([P.s1,P.s2,P.s3,P.s4]),hair:pick([P.h1,P.h2,P.h3]),pants:pick([P.c2,P.s4,P.k2])}; add(y, () => person(x,y,o)); }
  objs.sort((a,b) => a.y-b.y);
  for (const o of objs) o.fn();
  return c;
}
