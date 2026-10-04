(() => {
if (customElements.get('stadium-scene')) return;
const W = 1920, H = 1080, PW = 960, PH = 540, TAU = Math.PI * 2;
const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const A = rgb(a), B = rgb(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const TEAM = { home: ['#2f6fd6', '#f4f6fa', '#1c3a8a'], away: ['#d8343a', '#1b1b1f', '#f4f6fa'] };
const NEUTRAL = ['#f2c230', '#ff8a3d', '#9aa3ad', '#4fae5a', '#e9e2d0', '#6b4fa0', '#2a2d38'];
const SKIN = ['#f3cfaa', '#e0b089', '#b37a52', '#7a4a2e'];
const HAIR = ['#1e1a1a', '#3b2a20', '#5a3b25', '#191c2c', '#8a8a8a'];

const VAR = {
  day: { night: false, sky: [[0, '#2a78d6'], [0.6, '#68b2ef'], [1, '#d4edf8']], cloudShade: '#b6cae6', tint: null,
    roof: '#222a42', roofLite: '#3e4b6c', truss: 'rgba(160,180,215,0.22)', beam: '#1a2034', rim: '#eef2f7',
    concrete: '#9aa2b4', concreteDk: '#6a7389', seat: '#4a6aa6', seatDk: '#2e4678', fascia: '#10152a',
    grass: ['#3d9a3e', '#55b44d'], grassFar: '#2c7a36', lamp: '#fffbe8', lampOff: '#c9d1dc', pole: '#e2e2e2', shadowA: 0.42,
    px: ['#4cae47', '#44a041', '#3a8d3a', '#f0f6ea'], tower: '#5b6478', towerHead: '#3f475c' },
  night: { night: true, sky: [[0, '#04061a'], [0.55, '#111a46'], [1, '#3a2c68']], cloudShade: '#222', tint: ['#121842', 0.45],
    roof: '#0b0f20', roofLite: '#1c2644', truss: 'rgba(110,130,190,0.18)', beam: '#080b18', rim: '#56628a',
    concrete: '#3e4762', concreteDk: '#252b43', seat: '#22356a', seatDk: '#151f44', fascia: '#05070f',
    grass: ['#2a7a3a', '#3a9a4a'], grassFar: '#173f26', lamp: '#fffbe8', lampOff: '#fffbe8', pole: '#9aa0b8', shadowA: 0.5,
    px: ['#2f9046', '#2a823f', '#22693a', '#dfe9f0'], tower: '#262d4a', towerHead: '#131829' }
};
const VIEWS = {
  wide: { roofTop: 232, roofBot: 322, standTop: 322, standBot: 700, fascia: 0.42, ledTop: 700, ledBot: 744, grassTop: 744, pmin: 9, pmax: 16, towers: true, anim: 0.3, armsP: 0.3, flags: 9, lines: true },
  match: { roofTop: 20, roofBot: 92, standTop: 92, standBot: 350, fascia: 0.4, ledTop: 350, ledBot: 396, grassTop: H, pmin: 8, pmax: 13, towers: false, anim: 0.3, armsP: 0.3, flags: 8 },
  goal: { roofTop: -60, roofBot: 104, standTop: 104, standBot: 840, fascia: 0, ledTop: 840, ledBot: 892, grassTop: 892, pmin: 22, pmax: 62, towers: false, anim: 0.62, armsP: 0.7, flags: 5, jump: 1.4 }
};
const SCREEN_VIEW = { title: 'wide', menu: 'wide', result: 'wide', match: 'match', goal: 'goal' };

const glow = (() => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,250,232,0.7)'); gr.addColorStop(0.4, 'rgba(255,238,205,0.16)'); gr.addColorStop(1, 'rgba(255,238,205,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256); return c; })();

const tint = (c, vr) => vr.tint ? mix(c, vr.tint[0], vr.tint[1]) : c;

function drawSky(c, vw, vr, R) {
  const h = vw.roofTop + 40; if (h <= 0) return;
  const g = c.createLinearGradient(0, 0, 0, h); vr.sky.forEach(([o, col]) => g.addColorStop(o, col));
  c.fillStyle = g; c.fillRect(0, 0, W, h);
  if (vr.night) {
    for (let i = 0; i < 260; i++) { c.globalAlpha = 0.3 + R() * 0.7; c.fillStyle = '#fff'; c.beginPath(); c.arc(R() * W, R() * h * 0.85, R() < 0.08 ? 1.7 : 0.9, 0, TAU); c.fill(); }
    c.globalAlpha = 1; c.globalCompositeOperation = 'lighter';
    const hz = c.createRadialGradient(960, h, 0, 960, h, 1100); hz.addColorStop(0, 'rgba(255,190,150,0.22)'); hz.addColorStop(1, 'rgba(255,190,150,0)');
    c.fillStyle = hz; c.fillRect(0, 0, W, h); c.globalCompositeOperation = 'source-over';
  } else if (h > 120) {
    [[1350, 300, 2.1], [400, 290, 1.5], [960, 130, 0.6], [1760, 170, 0.75], [140, 150, 0.55]].forEach(([x, y, s]) => cloud(c, x, y, s, R, vr));
  }
}
function cloud(c, cx, cy, sc, R, vr) {
  const pf = [];
  for (let i = 0; i < 9; i++) { const a = i / 8, hg = Math.sin(a * Math.PI), r = (40 + hg * 70 + R() * 20) * sc; pf.push([cx + (a - 0.5) * 260 * sc + (R() - 0.5) * 30 * sc, cy - hg * 70 * sc - r * 0.3, r]); }
  for (let i = 0; i < 4; i++) pf.push([cx + (R() - 0.5) * 140 * sc, cy - 120 * sc - R() * 40 * sc, (50 + R() * 30) * sc]);
  c.save(); c.beginPath(); c.rect(0, 0, W, cy); c.clip();
  c.fillStyle = vr.cloudShade; pf.forEach(([x, y, r]) => { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); });
  c.fillStyle = '#ffffff'; pf.forEach(([x, y, r]) => { c.beginPath(); c.arc(x - r * 0.18, y - r * 0.22, r * 0.8, 0, TAU); c.fill(); });
  c.restore();
}
function drawTowers(c, vw, vr, self) {
  for (const tx of [170, 1750]) {
    const top = 56, base = vw.roofTop + 30;
    c.strokeStyle = vr.tower; c.lineWidth = 7; c.beginPath();
    c.moveTo(tx - 42, base); c.lineTo(tx - 12, top + 88); c.moveTo(tx + 42, base); c.lineTo(tx + 12, top + 88); c.stroke();
    c.lineWidth = 2.5; c.beginPath();
    for (let y = top + 88, k = 0; y < base; y += 24, k++) { const f = (y - top - 88) / (base - top - 88), hw = 12 + 30 * f, f2 = (y + 24 - top - 88) / (base - top - 88), hw2 = 12 + 30 * f2;
      c.moveTo(tx - hw, y); c.lineTo(tx + hw2, y + 24); c.moveTo(tx + hw, y); c.lineTo(tx - hw2, y + 24); }
    c.stroke();
    c.fillStyle = vr.towerHead; c.fillRect(tx - 116, top, 232, 92);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 6; k++) { const lx = tx - 104 + k * 36, ly = top + 9 + r * 27;
      c.fillStyle = vr.night ? vr.lamp : vr.lampOff; c.fillRect(lx, ly, 28, 20); self.towerLamps.push({ x: lx + 14, y: ly + 10 }); }
    self.towerHeads.push({ x: tx, y: top + 46 });
  }
}
function buildCrowd(vw, vr, R) {
  const top = vw.standTop, bot = vw.standBot, people = [], rows = [];
  const sAt = y => vw.pmin + (vw.pmax - vw.pmin) * Math.min(1, Math.max(0, (y - top) / (bot - top)));
  let fas = null; if (vw.fascia) { const fy = top + (bot - top) * vw.fascia; fas = { y: fy, h: sAt(fy) * 1.7 }; }
  const aisles = []; for (let x = 150; x < W; x += 330) aisles.push(x);
  let y = top + sAt(top) * 1.15;
  while (y <= bot) {
    const s = sAt(y);
    if (fas && y > fas.y - s * 0.1 && y < fas.y + fas.h + s * 1.25) { y = fas.y + fas.h + s * 1.25; continue; }
    rows.push({ y, s });
    let x = R() * s;
    while (x < W + s) {
      if (!aisles.some(a => Math.abs(x - a) < s * 0.95) && R() < 0.92) people.push(mkPerson(x + (R() - 0.5) * s * 0.15, y, s, vw, vr, R));
      x += s * (0.86 + R() * 0.22);
    }
    y += s * 1.16;
  }
  return { people, rows, fas, aisles };
}
function mkPerson(x, y, s, vw, vr, R) {
  const homeP = 1 - smooth(0.38, 0.62, x / W); let shirt;
  if (R() < 0.2) shirt = NEUTRAL[(R() * NEUTRAL.length) | 0];
  else { const tm = R() < homeP ? TEAM.home : TEAM.away, r = R(); shirt = r < 0.55 ? tm[0] : r < 0.8 ? tm[1] : tm[2]; }
  const anim = R() < vw.anim;
  const p = { x, y, s, shirt: tint(shirt, vr), skin: tint(SKIN[(R() * 4) | 0], vr), hair: tint(HAIR[(R() * 5) | 0], vr), anim,
    arms: anim && R() < vw.armsP, ph: R() * TAU, sp: 5 + R() * 3, amp: s * (0.1 + R() * 0.18) * (vw.jump || 1) };
  p.shade = mix(p.shirt, '#000000', 0.3); return p;
}
function drawPerson(c, p, bob, arm) {
  const { x, s } = p, y = p.y - bob, bw = s * 0.74, bh = s * 0.7, hr = s * 0.25, hy = y - bh - s * 0.2;
  if (p.arms) for (const sd of [-1, 1]) { c.save(); c.translate(x + sd * bw * 0.34, y - bh * 0.85); c.rotate(sd * (0.28 + arm));
    c.fillStyle = p.shirt; c.fillRect(-s * 0.09, -s * 0.55, s * 0.18, s * 0.6); c.fillStyle = p.skin; c.fillRect(-s * 0.09, -s * 0.72, s * 0.18, s * 0.18); c.restore(); }
  c.fillStyle = p.shirt; c.beginPath(); c.roundRect(x - bw / 2, y - bh, bw, bh + s * 0.05, [s * 0.22, s * 0.22, 0, 0]); c.fill();
  c.fillStyle = p.shade; c.fillRect(x + bw * 0.08, y - bh * 0.78, bw * 0.42, bh * 0.78 + s * 0.05);
  c.fillStyle = p.skin; c.beginPath(); c.arc(x, hy, hr, 0, TAU); c.fill();
  c.fillStyle = p.hair; c.beginPath(); c.arc(x, hy - hr * 0.12, hr * 1.04, Math.PI * 1.02, Math.PI * 1.98); c.fill();
}
function drawStand(c, vw, vr, cw) {
  const g = c.createLinearGradient(0, vw.standTop, 0, vw.standBot); g.addColorStop(0, vr.concreteDk); g.addColorStop(1, vr.concrete);
  c.fillStyle = g; c.fillRect(0, vw.standTop, W, vw.standBot - vw.standTop);
  for (const r of cw.rows) {
    c.fillStyle = vr.seatDk; c.fillRect(0, r.y - r.s * 0.42, W, r.s * 0.5);
    c.fillStyle = vr.seat; c.fillRect(0, r.y - r.s * 0.42, W, r.s * 0.13);
    c.fillStyle = vr.concrete; for (const a of cw.aisles) c.fillRect(a - r.s * 0.7, r.y - r.s * 0.75, r.s * 1.4, r.s * 1.16);
    c.fillStyle = vr.concreteDk; for (const a of cw.aisles) c.fillRect(a - r.s * 0.7, r.y + r.s * 0.3, r.s * 1.4, Math.max(1, r.s * 0.08));
  }
  for (const p of cw.people) if (!p.anim) drawPerson(c, p, 0, 0);
  if (cw.fas) { const { y, h } = cw.fas; c.fillStyle = vr.fascia; c.fillRect(0, y, W, h); c.fillStyle = vr.rim; c.fillRect(0, y, W, 3); c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, y + h, W, 6); }
  if (vw.ledBot > vw.ledTop) { c.fillStyle = '#060912'; c.fillRect(0, vw.ledTop, W, vw.ledBot - vw.ledTop); c.fillStyle = vr.rim; c.fillRect(0, vw.ledTop, W, 3); }
}
function drawRoof(c, vw, vr, self) {
  const a = vw.roofTop, b = vw.roofBot;
  const g = c.createLinearGradient(0, a, 0, b); g.addColorStop(0, vr.roof); g.addColorStop(1, vr.roofLite);
  c.fillStyle = g; c.fillRect(0, a, W, b - a);
  c.strokeStyle = vr.truss; c.lineWidth = 2; c.beginPath();
  for (let x = 0; x < W; x += 90) { c.moveTo(x, a); c.lineTo(x + 90, b - 18); c.moveTo(x + 90, a); c.lineTo(x, b - 18); } c.stroke();
  if (a > 0) { c.fillStyle = vr.rim; c.fillRect(0, a, W, 6); }
  c.fillStyle = vr.beam; c.fillRect(0, b - 20, W, 20);
  for (let x = 40; x < W; x += 72) { c.fillStyle = vr.night ? vr.lamp : vr.lampOff; c.fillRect(x, b - 15, 40, 9); self.lamps.push({ x: x + 20, y: b - 10 }); }
}
function standShade(c, vw, vr, atop) {
  const a = vw.roofBot, len = (vw.standBot - vw.standTop) * 0.5;
  const g = c.createLinearGradient(0, a, 0, a + len); g.addColorStop(0, `rgba(8,10,30,${vr.shadowA})`); g.addColorStop(1, 'rgba(8,10,30,0)');
  if (atop) c.globalCompositeOperation = 'source-atop'; c.fillStyle = g; c.fillRect(0, a, W, len); c.globalCompositeOperation = 'source-over';
}
function drawGrass(c, vw, vr) {
  const gt = vw.grassTop; if (gt >= H) return;
  const g = c.createLinearGradient(0, gt, 0, H); g.addColorStop(0, vr.grassFar); g.addColorStop(1, vr.grass[1]);
  c.fillStyle = g; c.fillRect(0, gt, W, H - gt);
  const vpX = 960, vpY = gt - 1600, k = (gt - vpY) / (H - vpY);
  c.fillStyle = 'rgba(0,0,0,0.09)';
  for (let i = -16; i < 16; i += 2) { const x0 = 960 + i * 150, x1 = x0 + 150;
    c.beginPath(); c.moveTo(vpX + (x0 - vpX) * k, gt); c.lineTo(vpX + (x1 - vpX) * k, gt); c.lineTo(x1, H); c.lineTo(x0, H); c.fill(); }
  const tl = gt + 34; c.strokeStyle = 'rgba(245,250,240,0.9)'; c.lineWidth = 4; c.beginPath(); c.moveTo(0, tl); c.lineTo(W, tl);
  if (vw.lines) { c.moveTo(960, tl); c.lineTo(960, H); c.stroke(); c.beginPath(); c.ellipse(960, tl + (H - tl) * 0.55, 300, 82, 0, 0, TAU); }
  c.stroke();
  if (vr.night) { c.globalCompositeOperation = 'lighter'; const lp = c.createRadialGradient(960, H, 0, 960, H, 900); lp.addColorStop(0, 'rgba(200,230,255,0.14)'); lp.addColorStop(1, 'rgba(200,230,255,0)'); c.fillStyle = lp; c.fillRect(0, gt, W, H - gt); c.globalCompositeOperation = 'source-over'; }
  const sh = c.createLinearGradient(0, gt, 0, gt + 30); sh.addColorStop(0, 'rgba(0,0,0,0.4)'); sh.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = sh; c.fillRect(0, gt, W, 30);
}
function drawFlag(c, f, t, vr) {
  const { x, y, s, cols } = f, ph = t * 3.2 + f.ph, N = 12;
  const poleH = s * 4.2, fw = s * 4.8, fh = s * 2.5, tx = x + Math.sin(ph * 0.5) * s * 0.5, ty = y - poleH;
  c.strokeStyle = vr.pole; c.lineWidth = Math.max(1.5, s * 0.12); c.beginPath(); c.moveTo(x, y); c.lineTo(tx, ty); c.stroke();
  const pts = []; for (let i = 0; i <= N; i++) { const a = i / N; pts.push([tx + a * fw * (1 - 0.06 * Math.sin(ph)), ty + Math.sin(ph - a * 3.2) * s * 0.6 * a + a * s * 0.5]); }
  for (let i = 0; i < N; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1 + 0.5, y1); c.lineTo(x1 + 0.5, y1 + fh); c.lineTo(x0, y0 + fh); c.closePath();
    c.fillStyle = cols[Math.floor(i / N * cols.length)]; c.fill();
    const sh = Math.cos(ph - (i / N) * 3.2); c.fillStyle = sh > 0 ? `rgba(255,255,255,${sh * 0.18})` : `rgba(0,0,20,${-sh * 0.32})`; c.fill(); }
}
function hexagon(c, x, y, r) { c.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + 0.3; c[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r); } c.closePath(); c.fill(); }
function flare(c, sx, sy, f, big, cols, streakCol) {
  c.globalAlpha = f; c.drawImage(glow, sx - big, sy - big, big * 2, big * 2);
  c.drawImage(glow, sx - big * 0.3, sy - big * 0.3, big * 0.6, big * 0.6);
  const sg = c.createLinearGradient(sx - 900, 0, sx + 900, 0); sg.addColorStop(0, 'rgba(0,0,0,0)'); sg.addColorStop(0.5, streakCol); sg.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = sg; c.fillRect(sx - 900, sy - 3, 1800, 6);
  const dx = 960 - sx, dy = 540 - sy;
  [[0.35, 26], [0.6, 62], [0.85, 18], [1.2, 110], [1.5, 36], [1.8, 74]].forEach(([k, r], i) => { c.globalAlpha = f * 0.16; c.fillStyle = cols[i % cols.length]; hexagon(c, sx + dx * k, sy + dy * k, r); });
  c.globalAlpha = 1;
}

// ---------- pixel sprites ----------
const OUT = '#0e1220';
const SPR = {
  run: ['...hhhh...', '..hhhhhh..', '..hsssss..', '..ssssss..', '...ssss...', '..jjjjjj..', '.jjjjjjjj.', 'sjjjkkjjjs', 'sjjjjjjjjs', '..jjjjjj..', '..pppppp..', '.ppp..ppp.', '.ss....ss.', '.oo....oo.', 'oo......oo', 'bb......bb'],
  stand: ['...hhhh...', '..hhhhhh..', '..hsssss..', '..ssssss..', '...ssss...', '..jjjjjj..', '.jjjjjjjj.', 'sjjjkkjjjs', 'sjjjjjjjjs', 's.jjjjjj.s', '..pppppp..', '..pppppp..', '..ss..ss..', '..oo..oo..', '..oo..oo..', '.bbb..bbb.'],
  cheer: ['s..........s', 's...hhhh...s', 'ss.hhhhhh.ss', '.s.hsssss.s.', '.jj.ssss.jj.', '..jjjjjjjj..', '...jjkkjj...', '...jjjjjj...', '...jjjjjj...', '...pppppp...', '...pppppp...', '...ss..ss...', '...oo..oo...', '...oo..oo...', '..bbb..bbb..'],
  ballS: ['.ww.', 'wkww', 'wwkw', '.ww.'],
  ballL: ['..wwww..', '.wkkwww.', 'wkkkwwkw', 'wwkwwkkw', 'wwwwkkkw', 'wkwwwkww', '.wkkwww.', '..wwww..'],
  cursor: ['yyyyy', '.yyy.', '..y..']
};
const PAL = {
  home: { h: '#2a1a12', s: '#f2c39a', j: '#2f6fd6', k: '#ffffff', p: '#ffffff', o: '#2f6fd6', b: '#202028' },
  away: { h: '#141414', s: '#d9a273', j: '#d8343a', k: '#1b1b1f', p: '#1b1b1f', o: '#d8343a', b: '#202028' },
  gk: { h: '#141414', s: '#d9a273', j: '#3fbf5a', k: '#1b1b1f', p: '#1b1b1f', o: '#3fbf5a', b: '#202028' },
  ball: { w: '#ffffff', k: '#23262f' }, cur: { y: '#ffe14a' }
};
function sprite(p, rows, pal, fx, fy, sc, flip) {
  const h = rows.length, w = rows[0].length, x0 = Math.round(fx - w * sc / 2), y0 = Math.round(fy - h * sc);
  for (const pass of [0, 1]) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ch = rows[y][x]; if (ch === '.') continue; const X = flip ? w - 1 - x : x;
    if (!pass) { p.fillStyle = OUT; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.fillRect(x0 + (X + dx) * sc, y0 + (y + dy) * sc, sc, sc); }
    else { p.fillStyle = pal[ch]; p.fillRect(x0 + X * sc, y0 + y * sc, sc, sc); }
  }
}
function pxShadow(p, x, y, sc) { p.fillStyle = 'rgba(0,25,0,0.38)'; p.fillRect(x - 3 * sc, y - sc, 6 * sc, sc); p.fillRect(x - 5 * sc, y, 10 * sc, sc); p.fillRect(x - 3 * sc, y + sc, 6 * sc, sc); }
function pxLine(p, x0, y0, x1, y1) { x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy;
  for (;;) { p.fillRect(x0, y0, 1, 1); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } } }

function drawMatchPixel(p, vr) {
  const G = 198, y0 = 214, D = 286, cx = 480, camU = 1080, K = 0.45;
  const toPx = (u, v) => { const s = 1 + v * K; return [Math.round(cx + (u - camU) * s), Math.round(y0 + v * D)]; };
  const ry = v => Math.round(y0 + v * D);
  const img = p.createImageData(PW, PH - G), d = img.data;
  const cA = rgb(vr.px[0]), cB = rgb(vr.px[1]), cO = rgb(vr.px[2]), cL = rgb(vr.px[3]);
  for (let y = G; y < PH; y++) {
    const v = (y - y0) / D, s = 1 + v * K, band = v < 0.25 ? 0.88 : v < 0.6 ? 0.94 : 1;
    for (let x = 0; x < PW; x++) {
      const u = (x - cx) / s + camU, inF = v >= 0 && v <= 1 && u >= 0 && u <= 1400;
      const col = inF ? (Math.floor(u / 70) % 2 ? cA : cB) : cO;
      const near = U => Math.abs(u - U) * s < 0.6; let ln = false;
      if (v >= 0 && v <= 1 && (near(1400) || near(700))) ln = true;
      if (near(1190) && v >= 0.2 && v <= 0.8) ln = true;
      if (near(1330) && v >= 0.37 && v <= 0.63) ln = true;
      if (u >= 0 && u <= 1400 && (y === ry(0) || y === ry(1))) ln = true;
      if (u >= 1190 && u <= 1400 && (y === ry(0.2) || y === ry(0.8))) ln = true;
      if (u >= 1330 && u <= 1400 && (y === ry(0.37) || y === ry(0.63))) ln = true;
      const i = ((y - G) * PW + x) * 4, f = ln ? 1 : band, c = ln ? cL : col;
      d[i] = c[0] * f; d[i + 1] = c[1] * f; d[i + 2] = c[2] * f; d[i + 3] = 255;
    }
  }
  p.putImageData(img, 0, G);
  p.fillStyle = vr.px[3];
  for (let a = 0; a < TAU; a += 0.003) {
    let [x, y] = toPx(700 + 122 * Math.cos(a), 0.5 + 0.1346 * Math.sin(a)); p.fillRect(x, y, 1, 1);
    const u2 = 1260 + 122 * Math.cos(a); if (u2 < 1190) { [x, y] = toPx(u2, 0.5 + 0.1346 * Math.sin(a)); p.fillRect(x, y, 1, 1); }
  }
  for (const u of [700, 1260]) { const [x, y] = toPx(u, 0.5); p.fillRect(x - 1, y, 2, 1); }
  // goal
  const H1 = 22, H2 = 16, va = 0.446, vb = 0.554;
  p.fillStyle = 'rgba(225,232,240,0.7)';
  for (let k = 0; k <= 8; k++) { const v = va + (vb - va) * k / 8, [bx, by] = toPx(1426, v), [fx, fy] = toPx(1400, v); pxLine(p, bx, by, bx, by - H2); pxLine(p, fx, fy - H1, bx, by - H2); }
  for (let h = 0; h <= H2; h += 4) { const [x1, y1] = toPx(1426, va), [x2, y2] = toPx(1426, vb); pxLine(p, x1, y1 - h, x2, y2 - h); }
  p.fillStyle = '#ffffff';
  for (const v of [va, vb]) { const [x, y] = toPx(1400, v); p.fillRect(x, y - H1, 2, H1); }
  { const [x1, y1] = toPx(1400, va), [x2, y2] = toPx(1400, vb); pxLine(p, x1, y1 - H1, x2, y2 - H1); pxLine(p, x1 + 1, y1 - H1, x2 + 1, y2 - H1); }
  const pl = [
    ['home', 'run', 1150, 0.56, 0, 1], ['home', 'run', 1000, 0.28, 0], ['home', 'run', 1060, 0.82, 0], ['home', 'stand', 880, 0.5, 0], ['home', 'run', 1235, 0.2, 0],
    ['gk', 'stand', 1385, 0.5, 1], ['away', 'run', 1272, 0.46, 1], ['away', 'stand', 1285, 0.66, 1], ['away', 'run', 1225, 0.32, 1], ['away', 'run', 1190, 0.74, 1], ['away', 'run', 1100, 0.44, 1]
  ].sort((a, b) => a[3] - b[3]);
  for (const [tm, sp, u, v, flip, me] of pl) {
    const [x, y] = toPx(u, v); pxShadow(p, x, y, 1); sprite(p, SPR[sp], PAL[tm], x, y, 1, flip);
    if (me) { pxShadow(p, x + 9, y, 0.6); sprite(p, SPR.ballS, PAL.ball, x + 9, y, 1); sprite(p, SPR.cursor, PAL.cur, x, y - 20, 1); }
  }
}

// ---------- element ----------
const scenes = new Set();
const io = new IntersectionObserver(es => es.forEach(e => { e.target._vis = e.isIntersecting; }), { rootMargin: '300px' });
class StadiumScene extends HTMLElement {
  static get observedAttributes() { return ['variant', 'screen']; }
  connectedCallback() {
    if (!this._init) {
      this._init = true;
      this.style.cssText += ';display:block;position:relative;width:100%;height:100%;overflow:hidden;';
      const mk = (w, h, extra) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;' + (extra || ''); this.appendChild(c); return c; };
      this.bg = mk(W, H); this.cr = mk(W, H); this.fx = mk(W, H, 'mix-blend-mode:screen;'); this.pix = mk(PW, PH, 'image-rendering:pixelated;');
      this.build();
    }
    scenes.add(this); io.observe(this);
  }
  disconnectedCallback() { scenes.delete(this); io.unobserve(this); }
  attributeChangedCallback() { if (this._init) this.build(); }
  build() {
    const vr = VAR[this.getAttribute('variant')] || VAR.day, scr = this.getAttribute('screen') || 'title', vw = VIEWS[SCREEN_VIEW[scr] || 'wide'];
    Object.assign(this, { vr, vw, scr, lamps: [], towerLamps: [], towerHeads: [], flashes: [], dips: {} });
    const R = mulberry(11 + (vr.night ? 97 : 0) + scr.length * 31);
    const b = this.bg.getContext('2d'); b.clearRect(0, 0, W, H);
    drawSky(b, vw, vr, R);
    if (vw.towers) drawTowers(b, vw, vr, this);
    const cw = buildCrowd(vw, vr, R); this.cw = cw; this.anim = cw.people.filter(p => p.anim);
    drawStand(b, vw, vr, cw);
    drawRoof(b, vw, vr, this);
    standShade(b, vw, vr, false);
    drawGrass(b, vw, vr);
    const hp = cw.people.filter(p => !p.anim && p.y > vw.standTop + (vw.standBot - vw.standTop) * 0.25);
    this.flags = [];
    for (let i = 0; i < vw.flags; i++) { const p = hp[(R() * hp.length) | 0]; if (!p) continue; const home = p.x < W / 2;
      this.flags.push({ x: p.x, y: p.y - p.s * 0.9, s: Math.min(p.s, 34), ph: R() * TAU, cols: (home ? [TEAM.home[0], TEAM.home[1], TEAM.home[0]] : [TEAM.away[0], TEAM.away[1]]).map(c => tint(c, vr)) }); }
    this.sun = scr === 'match' ? [1820, -30, 520] : scr === 'goal' ? [1780, -40, 560] : [1610, 84, 380];
    const p = this.pix.getContext('2d'); p.imageSmoothingEnabled = false; p.clearRect(0, 0, PW, PH);
    if (scr === 'match') drawMatchPixel(p, vr);
    else if (scr === 'title') { pxShadow(p, 480, 473, 3); sprite(p, SPR.ballL, PAL.ball, 480, 472, 5); }
    else if (scr === 'goal') { pxShadow(p, 230, 488, 8); sprite(p, SPR.cheer, PAL.home, 230, 488, 10); pxShadow(p, 720, 500, 6); sprite(p, SPR.run, PAL.home, 720, 500, 8, 1); }
    const blur = scr === 'menu' ? 'blur(7px) brightness(0.82)' : '';
    [this.bg, this.cr, this.fx].forEach(c => { c.style.filter = blur; c.style.transform = blur ? 'scale(1.04)' : ''; });
    this.drawCrowd(0); this.drawFx(0);
  }
  drawCrowd(t) {
    const c = this.cr.getContext('2d'); c.clearRect(0, 0, W, H);
    for (const p of this.anim) { const ph = t * p.sp + p.ph; drawPerson(c, p, Math.max(0, Math.sin(ph)) * p.amp, Math.sin(ph * 0.5) * 0.35); }
    standShade(c, this.vw, this.vr, true);
    for (const f of this.flags) drawFlag(c, f, t, this.vr);
  }
  drawFx(t) {
    const c = this.fx.getContext('2d'), vr = this.vr, vw = this.vw; c.clearRect(0, 0, W, H); c.globalCompositeOperation = 'lighter';
    if (vw.ledBot > vw.ledTop) {
      const y = vw.ledTop + 7, h = vw.ledBot - vw.ledTop - 12, pw = Math.round(h * 12), sp = 110, n = Math.floor(t * sp / pw), off = t * sp - n * pw;
      const msgs = this.ledMsgs || [['.soccer', '#ffd23a'], ['KICK OFF!', '#7dffb0']];
      c.font = `${Math.round(h * 0.5)}px "Press Start 2P", monospace`; c.textBaseline = 'middle';
      for (let i = 0; i * pw - off < W; i++) { const x = i * pw - off, [m, col] = msgs[(i + n) % msgs.length];
        c.globalAlpha = 0.2; c.fillStyle = col; c.fillRect(x + 4, y, pw - 8, h); c.globalAlpha = 0.95; c.fillText(m, x + h * 0.7, y + h / 2 + 1); }
      c.globalAlpha = 1;
    }
    if (this.cw.fas) { const { y, h } = this.cw.fas, off = (t * 70) % 320; c.globalAlpha = vr.night ? 0.55 : 0.4;
      for (let x = -320 + off; x < W; x += 320) { c.fillStyle = '#2f6fd6'; c.fillRect(x, y + h * 0.3, 150, h * 0.4); c.fillStyle = '#ff4a57'; c.fillRect(x + 160, y + h * 0.3, 150, h * 0.4); }
      c.globalAlpha = 1; }
    const fl = i => { let f = 0.86 + 0.08 * Math.sin(t * 11 + i * 1.7) + 0.06 * Math.sin(t * 27.3 + i * 4.1);
      if (this.dips[i] > 0) { this.dips[i]--; f *= 0.55; } else if (Math.random() < 0.003) this.dips[i] = 3 + (Math.random() * 5 | 0); return f; };
    if (vr.night) {
      this.lamps.forEach((l, i) => { c.globalAlpha = 0.55 * fl(i); c.drawImage(glow, l.x - 70, l.y - 70, 140, 140); });
      this.towerLamps.forEach((l, i) => { c.globalAlpha = 0.6 * fl(100 + (i / 6 | 0)); c.drawImage(glow, l.x - 50, l.y - 50, 100, 100); });
      this.towerHeads.forEach((hd, i) => { const f = fl(100 + i * 3);
        c.globalAlpha = 0.07 * f; c.fillStyle = '#fff4dc'; c.beginPath(); c.moveTo(hd.x - 90, hd.y + 40); c.lineTo(hd.x + 90, hd.y + 40);
        c.lineTo(960 + (hd.x < 960 ? 380 : -380) * 0.3 + 420, H); c.lineTo(960 + (hd.x < 960 ? 380 : -380) * 0.3 - 420, H); c.fill();
        flare(c, hd.x, hd.y, 0.85 * f, 420, ['#7fd8ff', '#b48cff', '#ffd27f'], 'rgba(140,200,255,0.75)'); });
      if (!this.towerHeads.length && this.lamps.length) { const l = this.lamps[Math.round(this.lamps.length * 0.78)]; flare(c, l.x, l.y, 0.7 * fl(7), 240, ['#7fd8ff', '#b48cff', '#ffd27f'], 'rgba(140,200,255,0.6)'); }
    } else {
      const [sx, sy, big] = this.sun; flare(c, sx, sy, 0.9 + 0.1 * Math.sin(t * 2.3) * Math.sin(t * 5.1), big, ['#ffe9a8', '#9fe3ff', '#ffb38a'], 'rgba(255,240,210,0.6)');
    }
    if (this.scr === 'goal' && vr.night) {
      const cols = ['rgba(120,220,255,', 'rgba(255,90,180,', 'rgba(255,230,110,', 'rgba(255,255,255,'];
      [260, 760, 1180, 1680].forEach((bx, i) => { const ang = Math.sin(t * 0.9 + i * 1.4) * 0.55, len = 1300, w = len * 0.11;
        c.save(); c.translate(bx, -20); c.rotate(ang); const g = c.createLinearGradient(0, 0, 0, len); g.addColorStop(0, cols[i] + '0.42)'); g.addColorStop(1, cols[i] + '0)');
        c.fillStyle = g; c.globalAlpha = fl(200 + i); c.beginPath(); c.moveTo(-6, 0); c.lineTo(6, 0); c.lineTo(w, len); c.lineTo(-w, len); c.fill(); c.restore(); });
      c.globalAlpha = 1;
    }
    const rate = this.scr === 'goal' ? 0.9 : vr.night ? 0.4 : 0.22;
    for (let k = 0; k < 2; k++) if (Math.random() < rate) { const y = vw.standTop + Math.random() * (vw.standBot - vw.standTop), s = vw.pmin + (vw.pmax - vw.pmin) * (y - vw.standTop) / (vw.standBot - vw.standTop);
      this.flashes.push({ x: Math.random() * W, y, r: s * 0.6, life: 3 }); }
    c.fillStyle = '#ffffff';
    this.flashes = this.flashes.filter(f => { c.globalAlpha = f.life / 3; c.drawImage(glow, f.x - f.r * 4, f.y - f.r * 4, f.r * 8, f.r * 8);
      c.fillRect(f.x - f.r * 2.5, f.y - 0.8, f.r * 5, 1.6); c.fillRect(f.x - 0.8, f.y - f.r * 2.5, 1.6, f.r * 5); return --f.life > 0; });
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }
}
customElements.define('stadium-scene', StadiumScene);
const t0 = performance.now();
(function loop(now) {
  const t = (now - t0) / 1000;
  if (!document.hidden) for (const s of scenes) { if (!s._vis) continue;
    if (now - (s._lc || 0) > 83) { s._lc = now; s.drawCrowd(t); }
    if (now - (s._lf || 0) > 33) { s._lf = now; s.drawFx(t); } }
  requestAnimationFrame(loop);
})(t0);
})();
