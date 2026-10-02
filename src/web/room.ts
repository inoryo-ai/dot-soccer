/**
 * 施設の中をアイソメで描く。パネルの後ろに敷く「場所」の絵。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 密度がこの絵の質を決める（2026-10-03 オーナー指摘）
 * ─────────────────────────────────────────────────────────────
 * 「ドット自体が少なくてチープな印象」。最初は机6つ・人3人で、
 * **空いた床がほとんど**だった。参考にした絵は、机・人・小物・看板が
 * 画面のすみずみまで詰まっていて、それが「作り込まれている」の正体。
 *
 * 🔑 **パネルの外側だけ狙うのをやめた。** 中央は手前のパネルが覆うが、
 *    覆われる前提で隙間を空けると、見えている左右も結局まばらになる。
 *    **部屋全体を均一に埋める**ほうが、結果として見えている部分が濃くなる。
 *
 * 🔑 **1ドット = 2px にした**（960×540 を2倍で表示）。
 *    640×360 を3倍にしていた頃は1ドットが3pxで、椅子や画面のような
 *    小さいものを置く余地が無かった。フルHD（1920×1080）はちょうど2倍。
 *
 * 🔴 **ここにゲームの規則を1行も書かない。** 投影と描く順は `iso.ts`。
 * 🔑 **乱数を引かない**（`city.ts` と同じ理由）。ばらつきは番号から作る。
 */

import { at, box, shade, tile } from "./iso.ts";
import type { View } from "./iso.ts";

export const W = 960;
export const H = 540;

/**
 * 床のマス数と原点。
 * 🔴 床は canvas の端まで敷く（敷かないと菱形の外が素通しになる）。
 *    半分の幅 480px を覆うには 480/16 = 30マスぶん要るので 34 にしてある。
 */
const GX = 34;
const GY = 34;
const ORIGIN = { ox: 480, oy: 36 };
const WALL = 96;

const C = {
  floorA:  "#ded0b0", floorB:  "#d5c5a1",
  tileA:   "#cfd6de", tileB:   "#c3cbd5",
  turf:    "#49ad4f", turfB:   "#3f9e46",
  track:   "#c75a43",
  wall:    "#eee4cd", wallDk:  "#dbcfb1",
  skirt:   "#8a6a44",
  glass:   "#a9dcf6", glassDk: "#86c6e6",
  frame:   "#f8f4e8",
  desk:    "#a9774a", deskTop: "#c69363",
  chair:   "#39465c",
  screen:  "#263447", screenOn:"#74d2f0",
  paper:   "#fbf7ec",
  board:   "#f4f8fc",
  sofa:    "#44506a",
  wood:    "#b98a55",
  metal:   "#aab4c2", metalDk: "#8d97a6",
  plant:   "#4aa248", plantDk: "#357f38", pot: "#c4603f",
  crate:   "#cb9d5e", crateDk: "#a87e46",
  awning:  ["#e2574c", "#3f8fd8", "#4aa248", "#f0a01e"],
  banner:  "#2f7ed8",
  lamp:    "#5a6676", lamphead:"#ffe9a8",
  ad:      ["#2f7ed8", "#e2574c", "#f0a01e", "#ffffff"],
  edge:    "#20304a",
  ball:    "#fdfaf0",
  line:    "#eafbee",
  shirts:  ["#2f7ed8", "#e2574c", "#49a048", "#f0a01e", "#8a5cd0", "#d8568f",
            "#3bb6b0", "#6b7a8c"],
  hair:    ["#3b2a1b", "#1f1a16", "#6b4a2a", "#241c18"],
  skin:    "#f2cfa6",
  car:     ["#3f6fd8", "#d8453f", "#f2f4f6", "#4a4f58", "#49a048"],
};

/** 番号から決まるばらつき。乱数の代わり（同じ番号なら必ず同じ） */
const wob = (i: number, n: number): number => ((i * 2654435761) >>> 0) % n;

/**
 * 人やものを**重ならないように**散らす。
 *
 * 🔴 2026-10-03 の目視で踏んだ: `wob()` で座標を2つ作って置くと、
 *    整数のマスに何人も乗り、しかもアイソメでは `gx - gy` が同じ位置が
 *    **画面上でぴったり縦に重なる**ので、人が積み上がって柱になった。
 * 🔑 だから格子に並べてから、マス未満のゆらぎだけ足す。
 *    これなら同じ場所に2人は来ないし、整列しても見えない。
 */
function scatter(i: number, cols: number, gx0: number, gy0: number,
                 step: number): [number, number] {
  const cx = i % cols;
  const cy = Math.floor(i / cols);
  return [gx0 + cx * step + wob(i * 7 + 1, 7) * .12,
          gy0 + cy * step + wob(i * 13 + 5, 7) * .12];
}
const pick = <T>(arr: readonly T[], i: number): T => arr[wob(i, arr.length)]!;
/** 背景として少し沈ませる。読むのは手前のパネルなので、ここは一段おとなしく */
const dim = (hex: string): string => shade(hex, .93);

/* --------------------------------------------------------------- 下地 */

function floor(v: View, a: string, b: string): void {
  for (let gx = 0; gx < GX; gx++) {
    for (let gy = 0; gy < GY; gy++) tile(v, gx, gy, 0, (gx + gy) % 2 === 0 ? a : b);
  }
}

/**
 * 奥の2枚の壁。
 * 🔑 アイソメの部屋は**奥の2面だけ**描く。手前2面も描くと中が見えなくなる。
 */
function walls(v: View): void {
  box(v, 0, -0.4, GX, 0.4, 0, WALL, dim(C.wallDk), dim(C.wall), dim(C.wallDk), C.edge);
  box(v, -0.4, 0, 0.4, GY, 0, WALL, dim(C.wallDk), dim(C.wallDk), dim(C.wall), C.edge);
  box(v, 0, -0.4, GX, 0.4, 0, 6, C.skirt, shade(C.skirt, .9), shade(C.skirt, .78), C.edge);
  box(v, -0.4, 0, 0.4, GY, 0, 6, C.skirt, shade(C.skirt, .78), shade(C.skirt, .9), C.edge);
}

/** 壁に貼るもの（窓・掲示物）。`side` が "r" なら右の壁、"l" なら左の壁 */
function panel(v: View, side: "r" | "l", a: number, len: number,
               y0: number, y1: number, fill: string, inset = 0): void {
  const p = (t: number, y: number): { x: number; y: number } =>
    side === "r" ? at(v, 0, t, y) : at(v, t, 0, y);
  const q = [p(a, y1), p(a + len, y1), p(a + len, y0), p(a, y0)];
  const c = v.c;
  c.beginPath();
  c.moveTo(q[0]!.x + inset, q[0]!.y + inset);
  c.lineTo(q[1]!.x + inset, q[1]!.y - inset);
  c.lineTo(q[2]!.x + inset, q[2]!.y - inset);
  c.lineTo(q[3]!.x + inset, q[3]!.y + inset);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = C.edge;
  c.lineWidth = 1;
  c.stroke();
}

/* ------------------------------------------------------------- 置きもの */

/** 人。背景なので形だけ分かれば足りるが、**数と色の散らばり**が効く */
function person(v: View, gx: number, gy: number, i: number, scale = 1): void {
  const p = at(v, gx, gy, 0);
  const c = v.c;
  const s = scale;
  const put = (x: number, y: number, w: number, h: number, col: string): void => {
    c.fillStyle = col;
    c.fillRect(Math.round(p.x + x * s), Math.round(p.y + y * s),
               Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  };
  put(-3, -9, 6, 9, dim(pick(C.shirts, i)));
  put(-3, -15, 6, 6, C.skin);
  put(-3, -16, 6, 3, pick(C.hair, i + 3));
  put(-4, -8, 1, 6, C.skin);
  put(3, -8, 1, 6, C.skin);
  put(-2, 0, 2, 2, "#2b2b33");
  put(0, 0, 2, 2, "#2b2b33");
}

/** 観客。1人を3ドットで描いて、席にびっしり並べる */
function fan(v: View, gx: number, gy: number, h: number, i: number): void {
  const p = at(v, gx, gy, h);
  const c = v.c;
  c.fillStyle = dim(pick(C.shirts, i));
  c.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 4, 3, 3);
  c.fillStyle = C.skin;
  c.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 6, 3, 2);
}

function plant(v: View, gx: number, gy: number, big = false): void {
  const s = big ? 1.3 : 1;
  box(v, gx, gy, .8 * s, .8 * s, 0, 10, C.pot, shade(C.pot, .9),
      shade(C.pot, .78), C.edge);
  box(v, gx + .1, gy + .1, .6 * s, .6 * s, 10, big ? 30 : 20, C.plant, C.plant,
      C.plantDk, C.edge);
}

function desk(v: View, gx: number, gy: number, i: number): void {
  box(v, gx, gy, 1.7, .9, 0, 15, C.deskTop, C.desk, shade(C.desk, .82), C.edge);
  box(v, gx + .25, gy + .25, .45, .4, 15, 11, C.screen, C.screenOn,
      shade(C.screen, .8), C.edge);
  const p = at(v, gx + 1.25, gy + .45, 15);
  v.c.fillStyle = C.paper;
  v.c.fillRect(p.x - 4, p.y - 3, 8, 5);
  v.c.strokeStyle = C.edge;
  v.c.lineWidth = 1;
  v.c.strokeRect(p.x - 4.5, p.y - 3.5, 9, 6);
  if (wob(i, 3) === 0) {
    /* マグカップ。小さいものが1つ乗るだけで、使われている机に見える */
    const q = at(v, gx + .9, gy + .7, 15);
    v.c.fillStyle = pick(C.shirts, i + 5);
    v.c.fillRect(q.x - 1, q.y - 4, 3, 4);
  }
}

function chair(v: View, gx: number, gy: number): void {
  box(v, gx, gy, .65, .65, 0, 8, C.chair, shade(C.chair, .9), shade(C.chair, .78), C.edge);
  box(v, gx, gy, .65, .16, 8, 12, shade(C.chair, .86), shade(C.chair, .8),
      shade(C.chair, .7), C.edge);
}

function sofa(v: View, gx: number, gy: number, len: number): void {
  box(v, gx, gy, len, .9, 0, 9, C.sofa, shade(C.sofa, .9), shade(C.sofa, .78), C.edge);
  box(v, gx, gy, len, .25, 9, 10, shade(C.sofa, .86), shade(C.sofa, .8),
      shade(C.sofa, .7), C.edge);
}

/** 自動販売機・ロッカー・棚。どれも「立っている箱」なので1つにまとめる */
function cabinet(v: View, gx: number, gy: number, h: number, face: string): void {
  box(v, gx, gy, .9, .7, 0, h, C.metalDk, face, shade(face, .8), C.edge);
}

function car(v: View, gx: number, gy: number, i: number): void {
  const col = pick(C.car, i);
  box(v, gx, gy, 1.9, 1.0, 0, 8, col, shade(col, .9), shade(col, .78), C.edge);
  box(v, gx + .45, gy + .1, 1.0, .8, 8, 6, shade(C.glass, .95), C.glass,
      C.glassDk, C.edge);
}

/** 屋上の室外機。小さい箱を散らすと、建物が「使われている」ように見える */
function acUnit(v: View, gx: number, gy: number, base: number): void {
  box(v, gx, gy, .8, .6, base, 7, C.metal, C.metalDk, shade(C.metalDk, .85), C.edge);
}

/* --------------------------------------------------------------- 事務所 */

function office(v: View): void {
  floor(v, dim(C.tileA), dim(C.tileB));
  walls(v);

  /* 窓を壁いっぱいに並べる。1枚だけだと「窓がある部屋」に見えない */
  for (let t = 1; t < GY - 2; t += 4.2) {
    panel(v, "r", t, 3.4, 40, 84, C.frame);
    panel(v, "r", t, 3.4, 40, 84, dim(C.glass), 3);
  }
  for (let t = 1; t < GX - 2; t += 4.2) {
    if (wob(Math.round(t), 4) === 0) {
      panel(v, "l", t, 3.2, 44, 80, dim(C.board));      // ホワイトボード
      for (let i = 0; i < 4; i++) {
        const q = at(v, t + .5 + i * .2, 0, 74 - i * 7);
        v.c.fillStyle = dim(pick(C.shirts, i + Math.round(t)));
        v.c.fillRect(q.x, q.y, 14 + i * 4, 2);
      }
    } else {
      panel(v, "l", t, 3.2, 40, 84, C.frame);
      panel(v, "l", t, 3.2, 40, 84, dim(C.glass), 3);
    }
  }

  /* 🔴 机の島を**床いっぱいに**並べる。6つでは空き床のほうが広かった。
        3マスごとに島を置くと、通路を残したまま密度が上がる。 */
  let n = 0;
  for (let gx = 1; gx < GX - 2; gx += 3.4) {
    for (let gy = 1; gy < GY - 2; gy += 3.4) {
      /* 通路。全部埋めると床が見えず、かえって何の部屋か分からなくなる */
      if (wob(Math.round(gx * 31 + gy), 7) === 0) continue;
      desk(v, gx, gy, n);
      chair(v, gx + .5, gy + 1.25);
      if (wob(n, 3) !== 0) person(v, gx + .75, gy + 1.5, n);
      n += 1;
    }
  }

  /* 会議の島・応接・観葉植物を要所に置いて、同じ机の繰り返しに見せない */
  for (const [gx, gy] of [[8, 25], [25, 8], [17, 29], [29, 17]]) {
    box(v, gx!, gy!, 3.2, 1.6, 0, 14, C.wood, shade(C.wood, .9),
        shade(C.wood, .78), C.edge);
    for (let k = 0; k < 4; k++) {
      chair(v, gx! - .9, gy! + .2 + k * .4);
      chair(v, gx! + 3.3, gy! + .2 + k * .4);
    }
    person(v, gx! - .7, gy! + .6, gx! + gy!);
    person(v, gx! + 3.5, gy! + 1.1, gx! + gy! + 3);
  }
  for (const [gx, gy] of [[4, 20], [20, 4], [12, 12], [27, 27], [2, 31], [31, 2]]) {
    sofa(v, gx!, gy!, 2.2);
    person(v, gx! + .6, gy! + 1.2, gx! * 3 + gy!);
  }
  for (let k = 0; k < 16; k++) {
    const [gx, gy] = scatter(k, 4, 2.4, 2.4, 7.8);
    plant(v, gx, gy, wob(k, 3) === 0);
  }
  for (let k = 0; k < 12; k++) {
    const [gx, gy] = scatter(k, 4, 5.6, 5.6, 7.8);
    cabinet(v, gx, gy, 22 + wob(k, 3) * 6, pick(C.shirts, k));
  }
  /* 歩いている人。机に座っている人だけだと、止まった絵になる */
  for (let k = 0; k < 24; k++) {
    const [gx, gy] = scatter(k, 5, 2.0, 2.0, 6.2);
    person(v, gx, gy, k + 7);
  }
}

/* --------------------------------------------------------------- 商店街 */

function shop(v: View): void {
  floor(v, dim("#cfc7b6"), dim("#c5bca9"));
  walls(v);
  /* 石畳の目地。床が一色だと広場が広場に見えない */
  for (let gx = 0; gx < GX; gx += 4) {
    for (let gy = 0; gy < GY; gy++) {
      const p = at(v, gx, gy, 0);
      v.c.fillStyle = "rgba(32,48,74,.10)";
      v.c.fillRect(p.x - 1, p.y - 1, 2, 2);
    }
  }

  /* 店先を通りの両側にびっしり。日よけの色を散らすと「商店街」になる */
  for (let t = 1; t < GY - 4; t += 3.0) {
    const i = Math.round(t);
    box(v, t + 11, t, 2.6, 2.6, 0, 34 + wob(i, 3) * 6, dim(C.crateDk), dim(C.crate),
        shade(dim(C.crate), .82), C.edge);
    box(v, t + 11, t, 2.8, 2.8, 34 + wob(i, 3) * 6, 7, pick(C.awning, i),
        shade(pick(C.awning, i), .9), shade(pick(C.awning, i), .78), C.edge);
    box(v, t, t + 11, 2.6, 2.6, 0, 34 + wob(i + 2, 3) * 6, dim(C.crateDk), dim(C.crate),
        shade(dim(C.crate), .82), C.edge);
    box(v, t, t + 11, 2.8, 2.8, 34 + wob(i + 2, 3) * 6, 7, pick(C.awning, i + 1),
        shade(pick(C.awning, i + 1), .78), shade(pick(C.awning, i + 1), .9), C.edge);
    /* のぼり。縦に伸びるものがあると、横に寝た絵が締まる */
    const p = at(v, t + 10.4, t - .4, 0);
    v.c.fillStyle = C.lamp;
    v.c.fillRect(p.x - 1, p.y - 46, 2, 46);
    v.c.fillStyle = dim(C.banner);
    v.c.fillRect(p.x + 1, p.y - 44, 9, 22);
    v.c.strokeStyle = C.edge;
    v.c.lineWidth = 1;
    v.c.strokeRect(p.x + .5, p.y - 44.5, 10, 23);
  }

  /* 街灯を通りに等間隔で */
  for (let t = 2; t < GX - 2; t += 5) {
    const p = at(v, t, t, 0);
    v.c.fillStyle = C.lamp;
    v.c.fillRect(p.x - 1, p.y - 40, 2, 40);
    v.c.fillStyle = C.lamphead;
    v.c.fillRect(p.x - 4, p.y - 46, 9, 7);
    v.c.strokeStyle = C.edge;
    v.c.lineWidth = 1;
    v.c.strokeRect(p.x - 4.5, p.y - 46.5, 10, 8);
  }

  /* 木箱・プランター・買い物客 */
  for (let k = 0; k < 24; k++) {
    const [gx, gy] = scatter(k, 5, 2.2, 2.2, 6.2);
    if (wob(k, 2) === 0) {
      box(v, gx, gy, .9, .9, 0, 11, C.crate, shade(C.crate, .9),
          shade(C.crate, .78), C.edge);
      if (wob(k, 4) === 0) {
        box(v, gx, gy, .9, .9, 11, 11, C.crate, shade(C.crate, .9),
            shade(C.crate, .78), C.edge);
      }
    } else {
      plant(v, gx, gy, wob(k, 3) === 0);
    }
  }
  /* 🔴 人をたくさん置く。商店街は**人がいること**がいちばんの看板 */
  for (let k = 0; k < 48; k++) {
    const [gx, gy] = scatter(k, 7, 1.8, 1.8, 4.4);
    person(v, gx, gy, k);
  }
}

/* ------------------------------------------------------------ サッカー場 */

function stadium(v: View): void {
  floor(v, dim(C.turf), dim(C.turfB));
  walls(v);

  /* 芝の縞。質感であって模様ではないので差は小さく */
  for (let gx = 0; gx < GX; gx += 3) {
    for (let gy = 0; gy < GY; gy++) tile(v, gx, gy, 0, dim(shade(C.turf, .96)));
  }
  /* トラック（赤い外周）＋白線 */
  for (let t = 0; t < GX; t++) {
    tile(v, t, 1, 0, dim(C.track));
    tile(v, 1, t, 0, dim(C.track));
    const p = at(v, t, t, 0);
    v.c.fillStyle = C.line;
    v.c.fillRect(p.x - 2, p.y - 1, 4, 2);
  }

  /* 🔴 観客席。段を重ね、**席1つずつに人を打つ**。
        ここの点の数が、そのまま「競技場らしさ」になる。 */
  /* 🔴 **外側の段から先に描く**（2026-10-03 の目視）。内側から描くと、
        あとに描いた外側の段が内側の段の観客を覆い、いちばん外の1列しか見えない。
        外側ほど奥なので、画家の順（奥→手前）に合わせると s は大きいほうから。 */
  for (let s = 3; s >= 0; s--) {
    const h = 12 + s * 11;
    box(v, 0, -0.4 - s * .9, GX, .9, 0, h, dim("#7488ab"), dim("#8ea2c4"),
        dim("#5f7193"), C.edge);
    box(v, -0.4 - s * .9, 0, .9, GY, 0, h, dim("#7488ab"), dim("#5f7193"),
        dim("#8ea2c4"), C.edge);
    for (let t = 0; t < GX; t += .9) {
      if (wob(Math.round(t * 7 + s * 13), 5) === 0) continue;   // 空席も作る
      fan(v, t, -0.2 - s * .9, h, Math.round(t * 3 + s));
      fan(v, -0.2 - s * .9, t, h, Math.round(t * 5 + s + 2));
    }
  }
  /* 広告看板。ピッチを囲むと一気に「試合会場」になる */
  for (let t = 2; t < GX - 1; t += 1.6) {
    const col = pick(C.ad, Math.round(t));
    box(v, t, 2.2, 1.5, .2, 0, 7, dim(col), dim(col), shade(dim(col), .8), C.edge);
    box(v, 2.2, t, .2, 1.5, 0, 7, dim(col), shade(dim(col), .8), dim(col), C.edge);
  }
  /* 照明塔 */
  for (const [gx, gy] of [[1, 1], [GX - 2, 1], [1, GY - 2]]) {
    const p = at(v, gx!, gy!, 0);
    v.c.fillStyle = C.metalDk;
    v.c.fillRect(p.x - 2, p.y - 74, 4, 74);
    v.c.fillStyle = C.lamphead;
    v.c.fillRect(p.x - 11, p.y - 88, 23, 15);
    v.c.strokeStyle = C.edge;
    v.c.lineWidth = 1;
    v.c.strokeRect(p.x - 11.5, p.y - 88.5, 24, 16);
  }
  /* ゴール。枠だけの細い箱にする（太いと芝に置いた白い板に見える） */
  for (const [gx, gy] of [[6, 15], [27, 15]]) {
    box(v, gx!, gy!, .25, 4.2, 0, 24, C.frame, C.frame, shade(C.frame, .86), C.edge);
    box(v, gx!, gy!, .25, .25, 0, 26, C.frame, C.frame, shade(C.frame, .8), C.edge);
    box(v, gx!, gy! + 4.0, .25, .25, 0, 26, C.frame, C.frame, shade(C.frame, .8), C.edge);
  }
  /* 練習している選手とボール */
  for (let k = 0; k < 20; k++) {
    const [gx, gy] = scatter(k, 5, 7.0, 7.0, 4.2);
    person(v, gx, gy, k + 2);
  }
  for (const [gx, gy] of [[12, 14], [20, 22], [16, 9]]) {
    const b = at(v, gx!, gy!, 0);
    v.c.fillStyle = C.ball;
    v.c.beginPath();
    v.c.arc(b.x, b.y - 4, 4, 0, Math.PI * 2);
    v.c.fill();
    v.c.strokeStyle = C.edge;
    v.c.lineWidth = 1;
    v.c.stroke();
  }
  /* 🔑 車とベンチは置かない。ピッチの上に車があると意味が通らないし、
        芝に置いた箱は「寝ている板」にしか見えなかった（2026-10-03 の目視）。
        外の気配は `city.ts` 側の仕事にする。 */
  void car;
  void acUnit;
}

const ROOMS: Record<string, (v: View) => void> = { office, shop, stadium };

/** その施設の室内を描く。知らない名前なら何も描かない（画面は壊さない） */
export function draw(canvas: HTMLCanvasElement, which: string): boolean {
  const run = ROOMS[which];
  if (run === undefined) return false;
  const c = canvas.getContext("2d");
  if (c === null) throw new Error("室内を描く canvas が使えない");
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, W, H);
  /* 🔑 先に下地を塗る。床の菱形は画面の下の隅までは届かないので、
        塗らないとそこだけ素通しになり、ページの地の縞が覗く。 */
  c.fillStyle = "#6b5a44";
  c.fillRect(0, 0, W, H);
  run({ c, ...ORIGIN });
  return true;
}
