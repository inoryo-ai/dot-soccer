/* デザイン由来の背景の共通ライブラリ（claude.ai のデザインプロジェクトから取り込み・2026-10-03）。
   🔴 **ここは預かりもの。手で直さない。** 直すならデザイン側で直して取り込み直す。
   🔑 乱数は種つき（`Math.random` を使っていない）＝同じ入力なら必ず同じ絵になる（D-16）。
   🔑 パレットは `docs/image-prompts.md` で渡した色そのもの。 */
function makeLib(ctx, opt){
  opt = opt || {};
  const P = {sky1:'#2a78d6',sky2:'#68b2ef',sky3:'#d4edf8',g1:'#3d9a3e',g2:'#55b44d',g3:'#2c7a36',c1:'#9aa2b4',c2:'#6a7389',k:'#16204a',k2:'#10152a',cr:'#fff8e6',cr2:'#e9e2d0',cr3:'#d9d2bf',y:'#ffd23a',o:'#ff8a3d',b:'#2f6fd6',r:'#d8343a',s1:'#f3cfaa',s2:'#e0b089',s3:'#b37a52',s4:'#7a4a2e',h1:'#1e1a1a',h2:'#3b2a20',h3:'#191c2c'};
  const night = !!opt.night, NT = '#121842';
  const hex = c => [1,3,5].map(i => parseInt(c.slice(i,i+2),16));
  const toHex = a => '#' + a.map(v => Math.round(v).toString(16).padStart(2,'0')).join('');
  const mix = (a,b,t) => { const A = hex(a), B = hex(b); return toHex(A.map((v,i) => v + (B[i]-v)*t)); };
  const cache = {};
  function map(c){ if (c[0] === '!') return c.slice(1); if (!night) return c; return cache[c] || (cache[c] = mix(c, NT, opt.nightT || 0.58)); }
  function fill(c){ ctx.fillStyle = map(c); }
  function rect(x,y,w,h,c){ fill(c); ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h)); }
  function poly(pts,c){
    fill(c);
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts){ minY = Math.min(minY,p[1]); maxY = Math.max(maxY,p[1]); }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++){
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++){
        const a = pts[i], b = pts[(i+1) % pts.length];
        if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + (yc-a[1])*(b[0]-a[0])/(b[1]-a[1]));
      }
      xs.sort((p,q) => p-q);
      for (let i = 0; i+1 < xs.length; i += 2){ const x0 = Math.round(xs[i]), x1 = Math.round(xs[i+1]); if (x1 > x0) ctx.fillRect(x0,y,x1-x0,1); }
    }
  }
  function outline(pts,o){ o = o || 1; for (const [dx,dy] of [[-o,0],[o,0],[0,-o],[0,o]]) poly(pts.map(p => [p[0]+dx,p[1]+dy]), P.k); }
  function polyO(pts,c){ outline(pts); poly(pts,c); }
  function ell(cx,cy,rx,ry,c){
    fill(c); cx = Math.round(cx); cy = Math.round(cy); rx = Math.round(rx); ry = Math.round(ry);
    for (let y = -ry; y < ry; y++){ const yy = (y+0.5)/ry; const w = Math.round(rx*Math.sqrt(Math.max(0,1-yy*yy))); if (w > 0) ctx.fillRect(cx-w,cy+y,2*w,1); }
  }
  function ellO(cx,cy,rx,ry,c){ ell(cx,cy,rx+1,ry+1,P.k); ell(cx,cy,rx,ry,c); }
  function line(pts,w,c){
    for (let i = 0; i+1 < pts.length; i++){
      const [x0,y0] = pts[i], [x1,y1] = pts[i+1], dx = x1-x0, dy = y1-y0, L = Math.hypot(dx,dy), nx = -dy/L*w/2, ny = dx/L*w/2;
      poly([[x0+nx,y0+ny],[x1+nx,y1+ny],[x1-nx,y1-ny],[x0-nx,y0-ny]], c);
    }
    for (let i = 1; i < pts.length-1; i++) ell(pts[i][0],pts[i][1],w/2,w/2,c);
  }
  function dith(x,y,w,h,c,ph){ fill(c); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (((x+i)+(y+j)+(ph||0)) % 2 === 0) ctx.fillRect(x+i,y+j,1,1); }
  function dithEll(cx,cy,rx,ry,c){
    fill(c); cx = Math.round(cx); cy = Math.round(cy);
    for (let y = -ry; y < ry; y++){ const yy = (y+0.5)/ry, w = Math.round(rx*Math.sqrt(Math.max(0,1-yy*yy))); for (let x = -w; x < w; x++){ const X = cx+x, Y = cy+y; if ((X+Y) % 2 === 0) ctx.fillRect(X,Y,1,1); } }
  }
  let seed = opt.seed || 1;
  function rnd(){ seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  const pick = a => a[Math.floor(rnd()*a.length)];
  const SPR = ['..kkkk..','.khhhhk.','khhhhhhk','khsssshk','ksessesk','.kssssk.','kttttttk','kttttttk','ksttttsk','.kttttk.','.kpkkpk.','.kpkkpk.','.kk..kk.'];
  const SHIRTS = [P.b,P.r,P.y,P.o,P.cr,P.g2,P.c1,P.sky2];
  function person(x,y,o){
    o = o || {}; const s = o.s || 1;
    const rows = SPR.slice(); if (o.walk){ rows[11] = 'kpk..kpk'; rows[12] = 'kk....kk'; }
    const R = o.seated ? rows.slice(0,10) : rows, H = R.length;
    const cm = {k:P.k, h:o.hair||pick([P.h1,P.h2,P.h3]), s:o.skin||pick([P.s1,P.s2,P.s3,P.s4]), e:P.k2, t:o.shirt||pick(SHIRTS), p:o.pants||pick([P.c2,P.s4,P.k2])};
    if (!o.seated && o.shadow !== false) ell(x+s, y, 4*s, Math.max(1,s), o.shadow || P.g3);
    for (let j = 0; j < H; j++) for (let i = 0; i < 8; i++){ const ch = R[j][i]; if (ch === '.') continue; rect(Math.round(x)-4*s+i*s, Math.round(y)-H*s+j*s, s, s, cm[ch]); }
  }
  function tree(x,y,r,o){
    o = o || {};
    ell(x+r*0.7, y, r*1.0, r*0.45, o.sh || P.g3);
    const th = Math.round(r*0.6);
    rect(x-2,y-th-1,4,th+2,P.k); rect(x-1,y-th,2,th,P.s4);
    const cy = y-th-r*0.75, blobs = [[0,0,r],[-r*0.55,r*0.3,r*0.68],[r*0.55,r*0.3,r*0.68]];
    for (const b of blobs) ell(x+b[0],cy+b[1],b[2]+1,b[2]*0.9+1,P.k);
    for (const b of blobs) ell(x+b[0],cy+b[1],b[2],b[2]*0.9,o.c||P.g1);
    ell(x-r*0.3,cy-r*0.3,r*0.48,r*0.36,o.hi||P.g2);
  }
  const iso = (OX,OY) => (gx,gy,gz) => [OX+2*(gx-gy), OY+(gx+gy)-(gz||0)];
  function box(Pf,gx,gy,gz,w,d,h,o){
    o = o || {};
    const L = (u,v) => Pf(gx+u,gy+d,gz+v), R = (u,v) => Pf(gx+w,gy+u,gz+v), T = (u,v) => Pf(gx+u,gy+v,gz+h);
    const q = F => (u0,v0,u1,v1,c) => poly([F(u0,v0),F(u1,v0),F(u1,v1),F(u0,v1)], c);
    if (o.shadow) poly([Pf(gx+w,gy,gz),Pf(gx+w+o.shadow,gy,gz),Pf(gx+w+o.shadow,gy+d,gz),Pf(gx+w,gy+d,gz)], o.shColor || P.g3);
    const sil = [Pf(gx,gy,gz+h),Pf(gx+w,gy,gz+h),Pf(gx+w,gy,gz),Pf(gx+w,gy+d,gz),Pf(gx,gy+d,gz),Pf(gx,gy+d,gz+h)];
    if (o.ol !== 0) outline(sil);
    q(L)(0,0,w,h,o.left); q(R)(0,0,d,h,o.right); q(T)(0,0,w,d,o.top);
    return {L,R,T,qL:q(L),qR:q(R),qT:q(T)};
  }
  function segDist(px,py,a,b){ const dx = b[0]-a[0], dy = b[1]-a[1]; let t = ((px-a[0])*dx+(py-a[1])*dy)/(dx*dx+dy*dy); t = Math.max(0,Math.min(1,t)); return Math.hypot(px-a[0]-t*dx, py-a[1]-t*dy); }
  function pathDist(px,py,pts){ let m = Infinity; for (let i = 0; i+1 < pts.length; i++) m = Math.min(m, segDist(px,py,pts[i],pts[i+1])); return m; }
  return {P,map,mix,fill,rect,poly,outline,polyO,ell,ellO,line,dith,dithEll,rnd,pick,person,tree,iso,box,pathDist,ctx};
}
