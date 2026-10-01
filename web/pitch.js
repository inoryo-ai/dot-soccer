/* 試合の再生。右斜め後ろからの見下ろし＋画面中央の下に全体図（ミニマップ）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここは「描くだけ」。試合の規則を1行も書かない
 * ─────────────────────────────────────────────────────────────
 * 位置も得点もすべて Python 側（sim/）が決めた結果を読むだけにする。
 * ここで「ゴール判定」や「誰が速いか」を書き始めると、エンジンが2つに分かれる。
 *
 * 🔴 **エンジンは平面（x, y）しか持っていない。** ボールの高さも選手の背丈も
 *    計算していない。立体に見えるのはすべて**描き方**で作っている:
 *      ・奥ほど小さく描く（透視投影）
 *      ・足元に影を落とす
 *      ・ゴールに高さを持たせる
 *      ・ボールが飛ぶ間だけ、弧を描いて浮かせる
 *    ここで作った「高さ」を試合の判定に使ってはいけない（エンジンの値ではない）。
 *
 * 🔑 受け取るのは `api.play_next()` の `replay`:
 *      sample_ticks : 何ティックごとのコマか（1 なら毎秒）
 *      coord_scale  : 座標の倍率（10 なら 0.1m 単位の整数）
 *      pitch        : [横m, 縦m]
 *      roster       : コマの中の番号が誰かの名簿
 *      frames       : [ボールX, ボールY, 保持者の番号, 選手0X, 選手0Y, ...] の配列
 *
 * 🔑 出来事（events）は `{time, tick, type, team, player, detail}`。
 *    **`team` はチーム名の文字列**（番号ではない）。
 */

'use strict';

const Pitch = (() => {
  /* ---------------------------------------------------------- カメラ設定 */
  /* 🔑 「右斜め後ろから見下ろす」を、振り向き（yaw）と見下ろし角（pitch）で表す。
        カメラはボールを追うが、**向きは変えない**。向きまで追うと画面が回って、
        どちらへ攻めているか分からなくなる。 */
  const CAM_YAW = -0.52;         // 右へ振る量（ラジアン）
  const CAM_PITCH = 0.56;        // 見下ろす角度（0=水平・π/2=真上）
  const CAM_DIST = 26;           // 注視点までの距離（m）。小さいほど寄る
  const FOCAL = 430;             // 画角。大きいほど寄る

  /* 🔑 選手の背丈。18ドットの絵を何メートルとして扱うか。
        実寸（1.8m）どおりだと小さくて読めないので、少し誇張する。
        ここを変えると全員の大きさが変わる（1か所で決める） */
  const PLAYER_HEIGHT_M = 2.05;
  const CAM_FOLLOW = 0.06;       // カメラがボールに追いつく速さ（1なら即追従）

  const PAD_BOTTOM = 62;         // 下の全体図のぶん空ける

  const STRIPES = 26;
  const PASS_ARC_M = 2.6;        // 飛んでいる間の最大の高さ（m・見た目だけ）
  const JUMP_M = 6.0;            // これ以上ボールが動いたら「蹴った」とみなす

  const COLOR = {
    sky:       '#10161c',
    /* 🔑 ピッチの外にも芝を敷く。敷かないと画面の端が黒く抜けて、
          ピッチが宙に浮いて見える */
    outfield:  '#15532f',
    turf:      '#1f7a44',
    /* 🔑 縞は**質感**であって模様ではない。差を付けすぎると
          斜めの帯に見えて、芝に見えなくなる */
    turfAlt:   '#20804a',
    line:      'rgba(232, 248, 238, .75)',
    shadow:    'rgba(0, 0, 0, .30)',
    ball:      '#ffffff',
    ballEdge:  '#1a1a1a',
    goal:      'rgba(255, 255, 255, .20)',
    minimapBg: 'rgba(10, 15, 20, .82)',
  };

  const KIT = {
    home: { shirt: '#ffd23f', shirtDark: '#9c7410', shorts: '#2d2a1a',
            skin: '#f2c9a0', hair: '#2a1a10', socks: '#ffd23f' },
    away: { shirt: '#4aa3ff', shirtDark: '#1f5d9e', shorts: '#16263a',
            skin: '#f2c9a0', hair: '#1a1410', socks: '#4aa3ff' },
    gk:   { shirt: '#ff8a3f', shirtDark: '#a04f14', shorts: '#2a1a10',
            skin: '#f2c9a0', hair: '#2a1a10', socks: '#ff8a3f' },
  };

  /* ピッチの実寸（m）。競技規則の数字で、描き手が作らない */
  const PENALTY = { depth: 16.5, width: 40.3 };
  const GOAL_AREA = { depth: 5.5, width: 18.3 };
  const GOAL = { depth: 2.4, width: 7.32, height: 2.44 };
  const CENTER_CIRCLE = 9.15;
  const PENALTY_SPOT = 11.0;

  let canvas = null;
  let ctx = null;
  let replay = null;
  let events = [];
  let goalEvents = [];
  let homeName = '';

  let frameIndex = 0;
  let playing = false;
  let speed = 1;
  let lastStamp = 0;
  let rafId = 0;
  let onUpdate = null;
  let onFinish = null;

  const camTarget = { x: 52.5, y: 34 };
  const phases = [];       // 選手ごとの足の運びの位相（足並みをそろえない）
  const facings = [];      // 選手ごとの向き

  /* ------------------------------------------------------------ 投影 */

  let basis = null;

  function buildCamera(tx, ty) {
    const cp = Math.cos(CAM_PITCH);
    const sp = Math.sin(CAM_PITCH);
    const cy = Math.cos(CAM_YAW);
    const sy = Math.sin(CAM_YAW);
    const fwd = { x: cp * cy, y: cp * sy, z: -sp };
    const eye = {
      x: tx - fwd.x * CAM_DIST,
      y: ty - fwd.y * CAM_DIST,
      z: -fwd.z * CAM_DIST,
    };
    /* 右手方向 = fwd × 真上(0,0,1) */
    const right = { x: fwd.y, y: -fwd.x, z: 0 };
    const rlen = Math.hypot(right.x, right.y) || 1;
    right.x /= rlen;
    right.y /= rlen;
    /* 上方向 = right × fwd */
    const up = {
      x: right.y * fwd.z - right.z * fwd.y,
      y: right.z * fwd.x - right.x * fwd.z,
      z: right.x * fwd.y - right.y * fwd.x,
    };
    basis = { eye, right, up, fwd };
  }

  /** 世界の点（m・z は上）を画面へ。奥にあるほど scale が小さい */
  function project(x, y, z) {
    const { eye, right, up, fwd } = basis;
    const vx = x - eye.x;
    const vy = y - eye.y;
    const vz = (z || 0) - eye.z;
    const depth = vx * fwd.x + vy * fwd.y + vz * fwd.z;
    if (depth <= 1) return null;          // カメラの後ろは描かない
    const sx = vx * right.x + vy * right.y + vz * right.z;
    const sy = vx * up.x + vy * up.y + vz * up.z;
    const viewH = canvas.height - PAD_BOTTOM;
    return {
      x: canvas.width / 2 + (FOCAL * sx) / depth,
      y: viewH / 2 - (FOCAL * sy) / depth,
      scale: FOCAL / depth,
      depth,
    };
  }

  /* ------------------------------------------------------------ 読み込み */

  function attach(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
  }

  function load(data, matchEvents, homeTeamName, callbacks) {
    replay = data;
    homeName = homeTeamName;
    events = (matchEvents || []).slice().sort((a, b) => a.tick - b.tick);
    goalEvents = events.filter((e) => e.type === 'ゴール');

    phases.length = 0;
    facings.length = 0;
    for (let i = 0; i < replay.roster.length; i += 1) {
      /* 🔑 足並みをそろえない。同じ位相で始めると22人が同じ足で走る */
      phases.push((i * 1.7) % 4);
      facings.push(0);
    }
    const k = replay.coord_scale;
    camTarget.x = replay.frames[0][0] / k;
    camTarget.y = replay.frames[0][1] / k;

    frameIndex = 0;
    playing = true;
    onUpdate = callbacks.onUpdate || null;
    onFinish = callbacks.onFinish || null;
    lastStamp = 0;
    start();
  }

  /* --------------------------------------------------------------- 進行 */

  function start() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(step);
  }

  function step(stamp) {
    if (!replay) return;
    if (!lastStamp) lastStamp = stamp;
    const dt = Math.min(0.1, (stamp - lastStamp) / 1000);
    lastStamp = stamp;

    if (playing) {
      /* 🔴 ×1 は実時間（試合の1秒＝実際の1秒）。
         1コマ = sample_ticks 秒ぶんなので、進むコマ数は speed ÷ sample_ticks */
      frameIndex += (dt * speed) / replay.sample_ticks;
      const last = replay.frames.length - 1;
      if (frameIndex >= last) {
        frameIndex = last;
        playing = false;
        if (onFinish) onFinish();
      }
    }

    draw(dt);
    if (onUpdate) onUpdate(state());
    rafId = requestAnimationFrame(step);
  }

  function state() {
    const tick = Math.round(frameIndex * replay.sample_ticks);
    let home = 0;
    let away = 0;
    for (const g of goalEvents) {
      if (g.tick > tick) break;
      if (g.team === homeName) home += 1; else away += 1;
    }
    let latest = null;
    for (const e of events) {
      if (e.tick > tick) break;
      latest = e;
    }
    return { tick, home, away, event: latest, done: !playing };
  }

  /* --------------------------------------------------------- 盤面を描く */

  const NEAR = 1.2;          // これより手前は描けない（カメラの目の前）

  /** その点の「奥行き」。負ならカメラの後ろ */
  function depthOf(p) {
    const { eye, fwd } = basis;
    return (p[0] - eye.x) * fwd.x + (p[1] - eye.y) * fwd.y + ((p[2] || 0) - eye.z) * fwd.z;
  }

  /**
   * 🔴 **カメラの後ろに角がある図形を、丸ごと捨てない。**
   *    以前は角が1つでも後ろにあると描画を諦めていたので、
   *    芝の縞が虫食いになり、地面が黒く抜けてピッチが宙に浮いて見えた。
   *    手前の面（NEAR）で**切り取ってから**投影する。
   */
  function clipNear(points) {
    const out = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const da = depthOf(a) - NEAR;
      const db = depthOf(b) - NEAR;
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t,
                  a[1] + (b[1] - a[1]) * t,
                  (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t]);
      }
    }
    return out;
  }

  function fillPoly(points3, color) {
    const clipped = clipNear(points3);
    if (clipped.length < 3) return;
    const pts = clipped.map((p) => project(p[0], p[1], p[2]));
    if (pts.some((p) => p === null)) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
  }

  /** 折れ線。手前で切れたところは分けて描く（線をつなげると画面を横切る） */
  function strokeLine(points3) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(run[0].x, run[0].y);
        for (let i = 1; i < run.length; i += 1) ctx.lineTo(run[i].x, run[i].y);
        ctx.stroke();
      }
      run = [];
    };
    for (const p of points3) {
      if (depthOf(p) <= NEAR) { flush(); continue; }
      const q = project(p[0], p[1], p[2]);
      if (q === null) { flush(); continue; }
      run.push(q);
    }
    flush();
  }

  function box(x, y, w, h) {
    strokeLine([[x, y, 0], [x + w, y, 0], [x + w, y + h, 0], [x, y + h, 0], [x, y, 0]]);
  }

  function drawField(px, py) {
    ctx.fillStyle = COLOR.sky;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    /* 🔑 見下ろしているので、画面はすべて地面。地平線は画面の上に外れている。
       先に一面を外の芝で塗っておけば、ピッチの外が黒く抜けない */
    ctx.fillStyle = COLOR.outfield;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    fillPoly([[0, 0, 0], [px, 0, 0], [px, py, 0], [0, py, 0]], COLOR.turf);
    const sw = px / STRIPES;
    for (let i = 0; i < STRIPES; i += 2) {
      fillPoly([[i * sw, 0, 0], [(i + 1) * sw, 0, 0],
                [(i + 1) * sw, py, 0], [i * sw, py, 0]], COLOR.turfAlt);
    }

    ctx.strokeStyle = COLOR.line;
    ctx.lineWidth = 1;
    box(0, 0, px, py);
    strokeLine([[px / 2, 0, 0], [px / 2, py, 0]]);

    /* 円は分割して折れ線で描く（透視で歪むので2点では足りない） */
    const circle = [];
    for (let i = 0; i <= 32; i += 1) {
      const t = (i / 32) * Math.PI * 2;
      circle.push([px / 2 + Math.cos(t) * CENTER_CIRCLE,
                   py / 2 + Math.sin(t) * CENTER_CIRCLE, 0]);
    }
    strokeLine(circle);

    for (const left of [true, false]) {
      box(left ? 0 : px - PENALTY.depth, (py - PENALTY.width) / 2,
          PENALTY.depth, PENALTY.width);
      box(left ? 0 : px - GOAL_AREA.depth, (py - GOAL_AREA.width) / 2,
          GOAL_AREA.depth, GOAL_AREA.width);
      const spot = project(left ? PENALTY_SPOT : px - PENALTY_SPOT, py / 2, 0);
      if (spot) {
        ctx.fillStyle = COLOR.line;
        ctx.fillRect(spot.x - 1, spot.y - 1, 2, 2);
      }

      /* ゴールは**高さを持たせる**。ここが一番「立体」に見える */
      const gx = left ? 0 : px;
      const dir = left ? -1 : 1;
      const y0 = (py - GOAL.width) / 2;
      const y1 = y0 + GOAL.width;
      const h = GOAL.height;
      fillPoly([[gx, y0, 0], [gx, y1, 0], [gx, y1, h], [gx, y0, h]], COLOR.goal);
      strokeLine([[gx, y0, 0], [gx, y0, h], [gx, y1, h], [gx, y1, 0]]);
      strokeLine([[gx, y0, h], [gx + dir * GOAL.depth, y0, h]]);
      strokeLine([[gx, y1, h], [gx + dir * GOAL.depth, y1, h]]);
    }
  }

  /* --------------------------------------------- ボールの高さ（見た目だけ） */

  function ballHeight(a, b, t, k) {
    const ax = replay.frames[a][0] / k;
    const ay = replay.frames[a][1] / k;
    const bx = replay.frames[b][0] / k;
    const by = replay.frames[b][1] / k;
    const jump = Math.hypot(bx - ax, by - ay);
    if (jump < JUMP_M) return 0;
    /* 🔑 エンジンはボールを受け手の足元へ**瞬間移動**させる（高さを持たないため）。
       寄った画面ではそこが一番不自然に見えるので、飛んでいる間だけ弧を描く。
       見た目だけで、判定には一切関わらない。 */
    return Math.sin(Math.PI * t) * Math.min(PASS_ARC_M, PASS_ARC_M * (jump / 30));
  }

  /* ------------------------------------------------------------ 本体 */

  function draw(dt) {
    const k = replay.coord_scale;
    const a = Math.floor(frameIndex);
    const b = Math.min(a + 1, replay.frames.length - 1);
    const t = frameIndex - a;
    const fa = replay.frames[a];
    const fb = replay.frames[b];
    const lerp = (i) => (fa[i] + (fb[i] - fa[i]) * t) / k;

    const [px, py] = replay.pitch;

    const bx = lerp(0);
    const by = lerp(1);
    const follow = Math.min(1, CAM_FOLLOW * (dt * 60));
    camTarget.x += (bx - camTarget.x) * follow;
    camTarget.y += (by - camTarget.y) * follow;
    buildCamera(camTarget.x, camTarget.y);

    drawField(px, py);

    const roster = replay.roster;
    const owner = fa[2];
    const list = [];
    for (let i = 0; i < roster.length; i += 1) {
      const x = lerp(3 + i * 2);
      const y = lerp(4 + i * 2);
      const p0 = project(x, y, 0);
      if (!p0) continue;

      const dx = (fb[3 + i * 2] - fa[3 + i * 2]) / k;
      const dy = (fb[4 + i * 2] - fa[4 + i * 2]) / k;
      const sp = Math.hypot(dx, dy) / replay.sample_ticks;      // m/s
      if (sp > 0.25) {
        /* 🔑 絵の向きは**画面の上での向き**で選ぶ。世界の向きで選ぶと、
           カメラを振っている今の見え方と合わない */
        const p1 = project(x + dx, y + dy, 0);
        if (p1) facings[i] = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      }
      phases[i] = (phases[i] + sp * dt * 2.4) % Sprites.RUN_FRAMES;
      list.push({ i, p: p0, sp });
    }
    /* 奥から順に描く（手前が上に重なる） */
    list.sort((m, n) => n.p.depth - m.p.depth);

    for (const item of list) {
      const { i, p, sp } = item;
      const who = roster[i];
      const kitKey = who.pos === 'GK' ? 'gk' : (who.team === 0 ? 'home' : 'away');
      const kit = KIT[kitKey];

      const sx = p.scale * 0.55;
      ctx.fillStyle = COLOR.shadow;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, Math.max(1.5, sx * 0.9), Math.max(0.8, sx * 0.4),
                  0, 0, Math.PI * 2);
      ctx.fill();

      const moving = sp > 0.6;
      const frame = Math.floor(phases[i]) % Sprites.RUN_FRAMES;
      const img = Sprites.get(kitKey, kit, Sprites.dirOf(facings[i]), frame, moving);
      /* 1ドットの大きさ。奥ほど小さい */
      const unit = Math.max(0.9, (p.scale * PLAYER_HEIGHT_M) / Sprites.H);
      const w = Sprites.W * unit;
      const h = Sprites.H * unit;
      ctx.drawImage(img, Math.round(p.x - w / 2),
                    Math.round(p.y - Sprites.FEET_Y * unit),
                    Math.round(w), Math.round(h));

      if (i === owner) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, Math.max(2.5, sx * 1.3), Math.max(1.2, sx * 0.6),
                    0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    const h = ballHeight(a, b, t, k);
    const ground = project(bx, by, 0);
    const air = project(bx, by, h);
    if (ground) {
      ctx.fillStyle = COLOR.shadow;
      ctx.beginPath();
      ctx.ellipse(ground.x, ground.y, Math.max(1.2, ground.scale * 0.03),
                  Math.max(0.6, ground.scale * 0.015), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (air) {
      const r = Math.max(1.8, air.scale * 0.14);          // ボールの半径 約0.14m相当
      ctx.fillStyle = COLOR.ballEdge;
      ctx.beginPath();
      ctx.arc(air.x, air.y, r + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLOR.ball;
      ctx.beginPath();
      ctx.arc(air.x, air.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    drawMinimap(px, py, fa, fb, t, k);
  }

  /* --------------------------------------------- 全体図（画面中央の一番下） */

  function drawMinimap(px, py, fa, fb, t, k) {
    const mw = Math.min(160, canvas.width * 0.36);
    const mh = mw * (py / px);
    const mx = (canvas.width - mw) / 2;
    const my = canvas.height - mh - 6;

    ctx.fillStyle = COLOR.minimapBg;
    ctx.fillRect(mx - 3, my - 3, mw + 6, mh + 6);
    ctx.fillStyle = COLOR.turf;
    ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle = 'rgba(232,248,238,.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx + 0.5, my + 0.5, mw - 1, mh - 1);
    ctx.beginPath();
    ctx.moveTo(Math.round(mx + mw / 2) + 0.5, my);
    ctx.lineTo(Math.round(mx + mw / 2) + 0.5, my + mh);
    ctx.stroke();

    const at = (x, y) => ({ x: mx + (x / px) * mw, y: my + (y / py) * mh });
    const lerp = (i) => (fa[i] + (fb[i] - fa[i]) * t) / k;

    for (let i = 0; i < replay.roster.length; i += 1) {
      const who = replay.roster[i];
      const q = at(lerp(3 + i * 2), lerp(4 + i * 2));
      ctx.fillStyle = who.pos === 'GK' ? KIT.gk.shirt
        : (who.team === 0 ? KIT.home.shirt : KIT.away.shirt);
      ctx.fillRect(Math.round(q.x) - 1, Math.round(q.y) - 1, 3, 3);
    }
    const ball = at(lerp(0), lerp(1));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(ball.x) - 1, Math.round(ball.y) - 1, 2, 2);

    /* いまカメラが見ているあたり。全体のどこを見ているかが分かるようにする */
    const c = at(camTarget.x, camTarget.y);
    ctx.strokeStyle = 'rgba(255,255,255,.6)';
    ctx.strokeRect(Math.round(c.x) - 15, Math.round(c.y) - 10, 30, 20);
  }

  /* --------------------------------------------------------------- 操作 */

  function toggle() {
    playing = !playing;
    lastStamp = 0;
    return playing;
  }

  function setSpeed(v) { speed = v; return speed; }

  function skipToEnd() {
    frameIndex = replay.frames.length - 1;
    playing = false;
    draw(0.016);
    if (onUpdate) onUpdate(state());
    if (onFinish) onFinish();
  }

  function stop() {
    cancelAnimationFrame(rafId);
    replay = null;
    playing = false;
  }

  return { attach, load, toggle, setSpeed, skipToEnd, stop, state: () => state() };
})();
