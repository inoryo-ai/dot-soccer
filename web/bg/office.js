/* 事務所の背景（claude.ai のデザインプロジェクトから取り込み・2026-10-03）。
   🔴 **ここは預かりもの。手で直さない。** 直すならデザイン側で直して取り込み直す。
   🔑 `drawOffice(makeLib, createCanvas)` が 960×540 の canvas を返す。
      中央はパネルが覆う前提で空けてある（`docs/image-prompts.md` の指定）。 */
function drawOffice(makeLib, createCanvas){
  const c = createCanvas(960,540), ctx = c.getContext('2d');
  const Lb = makeLib(ctx,{seed:33});
  const {P,rect,poly,ell,ellO,line,dith,rnd,pick,person,box,outline} = Lb;
  const Pf = Lb.iso(480,120);
  const SCR = '!#68b2ef';
  const bres = (a,b,col) => { let [x0,y0] = a.map(Math.round), [x1,y1] = b.map(Math.round); const dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1; let e=dx+dy; for(;;){ rect(x0,y0,1,1,col); if(x0===x1&&y0===y1)break; const e2=2*e; if(e2>=dy){e+=dy;x0+=sx;} if(e2<=dx){e+=dx;y0+=sy;} } };
  const WL = (gy,z) => Pf(0,gy,z), WR = (gx,z) => Pf(gx,0,z);
  const qWL = (a,b,za,zb,col) => poly([WL(a,za),WL(b,za),WL(b,zb),WL(a,zb)],col);
  const qWR = (a,b,za,zb,col) => poly([WR(a,za),WR(b,za),WR(b,zb),WR(a,zb)],col);
  const qF = (a0,b0,a1,b1,col) => poly([Pf(a0,b0,0),Pf(a1,b0,0),Pf(a1,b1,0),Pf(a0,b1,0)],col);
  rect(0,0,960,540,P.k);
  qWL(0,320,0,360,P.cr); qWR(0,320,0,360,P.cr2);
  qWL(0,320,0,7,P.s4); qWR(0,320,0,7,P.s4);
  qWL(0,320,44,47,P.cr3); qWR(0,320,44,47,P.cr3);
  qWL(0,320,7,44,P.cr2); qWR(0,320,7,44,P.cr3);
  bres(Pf(0,0,0),Pf(0,0,300),P.cr3);
  qF(0,0,420,420,P.s3);
  for (let gy = 10; gy < 420; gy += 10) bres(Pf(0,gy,0),Pf(420,gy,0),P.s4);
  for (let i = 0; i < 140; i++){ const gy = 10*Math.floor(rnd()*32), gx = Math.floor(rnd()*300); bres(Pf(gx,gy,0),Pf(gx,gy+10,0),P.s4); }
  for (let i = 0; i < 90; i++){ const gx = rnd()*300, gy = rnd()*300, p = Pf(gx,gy,0); rect(p[0],p[1],3,1,P.s2); }
  { const pts = [Pf(128,6,0),Pf(196,6,0),Pf(176,70,0),Pf(108,70,0)]; Lb.fill(P.s2); let a=Infinity,b=-Infinity; for(const p of pts){a=Math.min(a,p[1]);b=Math.max(b,p[1]);} for(let y=Math.floor(a);y<=b;y++){const yc=y+0.5,xs=[];for(let i=0;i<4;i++){const p=pts[i],q=pts[(i+1)%4];if((p[1]<=yc&&q[1]>yc)||(q[1]<=yc&&p[1]>yc))xs.push(p[0]+(yc-p[1])*(q[0]-p[0])/(q[1]-p[1]));}xs.sort((m,n)=>m-n);for(let x=Math.round(xs[0]);x<Math.round(xs[1]);x++)if((x+y)%2===0)ctx.fillRect(x,y,1,1);} }
  qF(104,104,196,196,P.k); qF(106,106,194,194,P.cr3); qF(112,112,188,188,P.cr2);
  for (const t of [120,180]) { qF(t-1,112,t+1,188,P.cr3); qF(112,t-1,188,t+1,P.cr3); }
  for (let i = 0; i < 40; i++){ const p = Pf(112+rnd()*76,112+rnd()*76,0); rect(p[0],p[1],2,1,P.cr3); }
  qWL(28,104,58,134,P.k); qWL(30,102,60,132,P.c1); qWL(32,100,62,130,P.cr);
  qWL(38,94,68,124,P.cr); qWL(38,94,68,124,P.g2);
  for (let i = 0; i < 6; i++) if (i%2) qWL(38+i*56/6,38+(i+1)*56/6,68,124,P.g1);
  qWL(38,94,68,69,P.cr); qWL(38,94,123,124,P.cr); qWL(38,39,68,124,P.cr); qWL(93,94,68,124,P.cr); qWL(65.5,66.5,68,124,P.cr);
  { const cc = WL(66,96); ell(cc[0],cc[1],8,10,P.cr); ell(cc[0],cc[1],6,8,P.g2); }
  qWL(38,46,86,106,P.cr); qWL(39,45,87,105,P.g2); qWL(86,94,86,106,P.cr); qWL(87,93,87,105,P.g2);
  for (const [gy,z,col] of [[48,110,P.r],[56,90,P.r],[52,78,P.r],[60,100,P.r],[76,110,P.b],[72,86,P.b],[82,96,P.b],[78,78,P.b],[66,96,P.cr]]){ const p = WL(gy,z); rect(p[0]-2,p[1]-2,5,5,P.k); rect(p[0]-1,p[1]-1,3,3,col); }
  qWL(40,92,56,58,P.c2);
  qWL(136,196,60,124,P.k); qWL(138,194,62,122,P.s4); qWL(141,191,65,119,P.s2);
  for (const [a,z0,col] of [[146,98,P.cr],[160,104,P.cr],[176,96,P.sky3],[150,74,P.cr],[168,72,P.y],[182,76,P.cr]]){ qWL(a-0.6,a+10.6,z0-0.6,z0+14.6,P.k); qWL(a,a+10,z0,z0+14,col); const p = WL(a+5,z0+12); rect(p[0]-1,p[1]-1,2,2,col===P.y?P.r:P.r); }
  const objs = [], add = (d,fn) => objs.push({d,fn});
  add(30, () => {
    const S = box(Pf,26,0,0,64,12,30,{top:P.s2,left:P.s3,right:P.s4});
    S.qL(2,14,62,15,P.s4); S.qL(2,4,62,13,P.s4); S.qL(2,17,62,28,P.s4);
    for (const [u,v,col] of [[8,18,P.r],[14,18,P.b],[18,18,P.cr],[40,18,P.y],[48,18,P.g2],[10,5,P.b],[30,5,P.cr3],[34,5,P.r]]){ S.qL(u,v,u+3,v+8,P.k); S.qL(u+0.5,v,u+2.5,v+7.5,col); }
    for (const [u,s] of [[12,1],[28,1.3],[44,1]]){ const p = S.T(u,6); rect(p[0]-5*s,p[1]-14*s,10*s,9*s,P.k); rect(p[0]-4*s,p[1]-13*s,8*s,7*s,P.y); rect(p[0]-2*s,p[1]-6*s,4*s,3*s,P.k); rect(p[0]-1*s,p[1]-6*s,2*s,2*s,P.y); rect(p[0]-4*s,p[1]-4*s,8*s,4*s,P.k); rect(p[0]-3*s,p[1]-3*s,6*s,2*s,P.s4); rect(p[0]-3*s,p[1]-12*s,2*s,2*s,P.cr); }
    const fb = S.T(56,6); ellO(fb[0],fb[1]-6,6,6,P.cr); rect(fb[0]-2,fb[1]-8,4,3,P.k); rect(fb[0]-5,fb[1]-4,2,2,P.k); rect(fb[0]+3,fb[1]-4,2,2,P.k);
  });
  qWR(138,206,28,152,P.k); qWR(140,204,30,150,P.c1);
  qWR(143,201,33,147,P.sky2); qWR(143,201,100,147,P.sky1); qWR(143,201,66,100,P.sky3);
  qWR(143,201,58,68,P.sky1); qWR(143,201,33,58,P.g1);
  for (let i = 0; i < 6; i++){ const a = 146+i*9; qWR(a,a+4,52,57,P.cr); qWR(a-0.5,a+4.5,57,59,[P.r,P.c2,P.b,P.s4][i%4]); }
  { const p = WR(186,46); ell(p[0],p[1],15,7,P.k); ell(p[0],p[1],14,6,P.cr); ell(p[0],p[1]+1,10,4,P.g2); rect(p[0]-14,p[1]-14,2,12,P.c2); rect(p[0]+12,p[1]-10,2,10,P.c2); }
  for (let i = 0; i < 18; i++){ const p = WR(145+rnd()*54,34+rnd()*18); rect(p[0],p[1],2,1,P.g3); }
  { const p = WR(152,124); ell(p[0],p[1],8,3,P.cr); ell(p[0]+6,p[1]-1,6,3,P.cr); }
  qWR(171,173,33,147,P.c1); qWR(143,201,88,90,P.c1); qWR(140,204,28,31,P.cr3);
  add(160, () => {
    box(Pf,146,4,0,54,7,24,{top:P.c2,left:P.c1,right:P.c2});
    const B = box(Pf,146,11,0,54,16,10,{top:P.c1,left:P.c2,right:P.k2});
    box(Pf,147,12,10,25,13,3,{top:P.b,left:P.b,right:P.k2});
    box(Pf,174,12,10,25,13,3,{top:P.r,left:P.r,right:P.k2});
    box(Pf,150,6,13,9,4,9,{top:P.r,left:P.r,right:P.k2});
    box(Pf,188,6,13,9,4,9,{top:P.b,left:P.b,right:P.k2});
  });
  const plant = (gx,gy,h) => () => {
    const B = box(Pf,gx,gy,0,9,9,9,{top:P.s4,left:P.s3,right:P.s4});
    const p = Pf(gx+4.5,gy+4.5,9+h*0.5);
    for (const [dx,dy,r] of [[0,-h*0.4,8],[-6,0,6],[6,-2,6],[0,4,6]]) ell(p[0]+dx,p[1]+dy,r+1,r+1,P.k);
    for (const [dx,dy,r] of [[0,-h*0.4,8],[-6,0,6],[6,-2,6],[0,4,6]]) ell(p[0]+dx,p[1]+dy,r,r,P.g1);
    ell(p[0]-3,p[1]-h*0.4-3,3,3,P.g2); ell(p[0]-7,p[1]-2,2,2,P.g2);
  };
  add(24, plant(6,10,14)); add(222, plant(208,6,20));
  add(220, () => {
    const B = box(Pf,0,196,0,16,46,28,{top:P.cr3,left:P.c1,right:P.c2});
    B.qR(2,4,20,24,P.c2); B.qR(24,4,44,24,P.c2); B.qR(19,8,21,20,P.k);
    const M = box(Pf,3,202,28,10,10,16,{top:P.c2,left:P.k2,right:P.k});
    M.qR(2,6,8,12,P.c1); M.qR(4,9,6,11,'!'+P.r);
    box(Pf,5,216,28,4,4,4,{top:P.cr,left:P.cr,right:P.cr3});
    box(Pf,5,224,28,4,4,4,{top:P.cr,left:P.b,right:P.k2});
  });
  const deskL = (gx,gy,seated) => {
    add(gx+gy, () => {
      const D = box(Pf,gx,gy,0,26,16,14,{top:P.s2,left:P.s3,right:P.s4});
      D.qL(2,0,24,11,P.s4);
      const M = box(Pf,gx+3,gy+3,14,12,10,11,{top:P.cr3,left:P.cr2,right:P.c1});
      M.qL(1.5,1.5,10.5,9.5,P.k); M.qL(2,2,10,9,SCR); M.qL(3,6,7,7,P.cr); M.qL(3,4,9,5,P.cr);
      box(Pf,gx+16,gy+8,14,8,5,1,{top:P.c1,left:P.c2,right:P.k2});
      box(Pf,gx+19,gy+1,14,4,4,3,{top:P.cr,left:P.cr,right:P.cr3});
    });
    add(gx+gy+20, () => {
      box(Pf,gx+14,gy+20,0,8,8,8,{top:P.b,left:P.c2,right:P.k2});
      if (seated){ const p = Pf(gx+18,gy+24,8); person(p[0],p[1]+3,{s:3,seated:true,shirt:seated,hair:P.h2,skin:P.s2}); }
    });
  };
  const deskR = (gx,gy,seated) => {
    add(gx+gy, () => {
      const D = box(Pf,gx,gy,0,16,26,14,{top:P.s2,left:P.s3,right:P.s4});
      D.qR(2,0,24,11,P.s4);
      const M = box(Pf,gx+3,gy+3,14,10,12,11,{top:P.cr3,left:P.c1,right:P.cr2});
      M.qR(1.5,1.5,10.5,9.5,P.k); M.qR(2,2,10,9,SCR); M.qR(3,6,7,7,P.cr); M.qR(3,4,9,5,P.cr);
      box(Pf,gx+8,gy+16,14,5,8,1,{top:P.c1,left:P.c2,right:P.k2});
    });
    add(gx+gy+20, () => {
      box(Pf,gx+20,gy+14,0,8,8,8,{top:P.r,left:P.c2,right:P.k2});
      if (seated){ const p = Pf(gx+24,gy+18,8); person(p[0],p[1]+3,{s:3,seated:true,shirt:seated,hair:P.h1,skin:P.s3}); }
    });
  };
  deskL(54,214,P.y); deskL(84,252,null);
  deskR(214,54,null); deskR(252,84,P.g2);
  add(90, () => { const p = Pf(18,74,0); person(p[0],p[1],{s:3,shirt:P.r,hair:P.h3,skin:P.s1,pants:P.k2,shadow:P.s4}); });
  add(250, () => { const p = Pf(30,232,0); person(p[0],p[1],{s:3,shirt:P.b,hair:P.h1,skin:P.s4,pants:P.c2,shadow:P.s4}); rect(p[0]+11,p[1]-21,6,6,P.k); rect(p[0]+12,p[1]-20,4,4,P.cr); });
  add(232, () => { const p = Pf(196,40,0); person(p[0],p[1],{s:3,shirt:P.o,hair:P.h2,skin:P.s3,pants:P.s4,shadow:P.s4}); });
  objs.sort((a,b) => a.d-b.d);
  for (const o of objs) o.fn();
  return c;
}
