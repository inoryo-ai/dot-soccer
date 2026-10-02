/**
 * 街をアイソメ（クォータービュー）で**コードで描く**。施設を選ぶハブ画面の地。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ正面向きをやめたのか（2026-10-02 オーナー指摘）
 * ─────────────────────────────────────────────────────────────
 * 「奥行きもないし、見た目が面白くない」。正面から描くと、建物は
 * **前面1枚の板**にしかならない。屋根も側面も見えないので、どれだけ描き込んでも
 * 書き割りのままで、街の中に場所があるように見えない。
 * → 斜め上から見る。屋根・右面・左面の3枚が同時に見えるので、箱が箱に見える。
 *
 * 投影と描く順番の決まりは `iso.ts`。ここは**何をどこに置くか**だけを持つ。
 *
 * 🔴 **ここにゲームの規則を1行も書かない。** 街は見た目だけで、
 *    どこへ行けるかは `main.ts` 側の HTML のボタンが持つ。
 * 🔑 **乱数を引かない。** ビルドごとに街並みが変わると、画面の確認で
 *    「前と違う」のが変更のせいか乱数のせいか分からなくなる。
 * 🔑 盤（480×360）と違い **640×360**。3倍すると 1920×1080 ちょうどで、
 *    フルHDに**整数倍のまま**収まる。
 */

import { at, box, shade, slab, tile } from "./iso.ts";
import type { View } from "./iso.ts";

export const W = 640;
export const H = 360;

/**
 * 地面の広さ（マス）と原点。
 *
 * 🔴 **画面より大きく敷いて、はみ出したぶんを切り取る。**
 *    最初は画面に収まる広さ（16マス）で敷いたが、菱形の地面が
 *    **空に浮かぶ島**にしか見えなかった（四隅が空のまま残る）。
 *    街は「どこまでも続いている場所の一部」に見えないと、街に見えない。
 * 🔑 四隅まで地面で埋まる条件から出した値。原点を画面の上へ大きく外し（oy=-160）、
 *    その状態で右下の角まで届く広さ（44マス）にしてある。どちらか片方だけ変えない。
 */
const G = 44;
const ORIGIN = { ox: 320, oy: -160 };

/* 🔴 色は `web/style.css` の `:root` と揃える（canvas は CSS 変数を読めない）。
      片方だけ変えると、街と画面の枠が違う色になる。 */
const C = {
  skyTop:   "#5bb8ee",
  skyLow:   "#bfe8fb",
  cloud:    "#ffffff",
  grass:    "#6fc456",
  grassAlt: "#63b74c",
  road:     "#c9bfa8",
  roadLine: "#fdfaf0",
  water:    "#4aa8e0",
  waterAlt: "#3f99cf",
  edge:     "#20304a",

  standTop: "#f2f6fb",
  standSide:"#d3dceb",
  /* 🔑 席は**くすませる**。鮮やかな青にすると、沈んだ芝を囲む平らな面が
        「プールの水」に見えた（2026-10-02 の目視）。空や川の青と役割がぶつかる。 */
  seat:     "#6d86ad",
  seatAlt:  "#c4603f",
  pitch:    "#49ad4f",
  pitchAlt: "#3f9e46",

  officeTop:  "#2f7ed8",
  officeWall: "#f4f8fd",
  shopTop:    "#e2574c",
  shopWall:   "#fff3dc",
  dormTop:    "#f0a01e",
  dormWall:   "#fff1d6",

  window:   "#8fd2f7",
  windowLit:"#ffd45e",
  trunk:    "#8a6a44",
  leaf:     "#49a048",
  leafDk:   "#36803a",
};

/** 番号から決まる小さなばらつき。乱数の代わり（同じ番号なら必ず同じ） */
const wob = (i: number, n: number): number => ((i * 2654435761) >>> 0) % n;

/* ----------------------------------------------------------- 置きもの */

/** 施設の占める区画。**札の位置もここから出す**（絵と目印の出どころを1つにする） */
/* 🔑 見えているのは だいたい gx・gy ともに 9〜34 の帯。原点を外へ出したので、
      マス番号の 0 付近・43 付近は画面の外にある（＝切り取られる前提で敷いている）。 */
const PLOTS = {
  stadium: { gx: 17, gy: 15, gw: 6, gh: 5, h: 30 },
  shop:    { gx: 12, gy: 24, gw: 3, gh: 3, h: 26 },
  office:  { gx: 28, gy: 12, gw: 3, gh: 3, h: 56 },
} as const;

/** 施設ではない建物（賑やかしの街並み）。押せない */
const SCENERY = [
  { gx: 27, gy: 23, gw: 3, gh: 3, h: 32, top: C.dormTop,   wall: C.dormWall },
  { gx: 31, gy: 18, gw: 2, gh: 2, h: 44, top: C.officeTop, wall: C.officeWall },
  { gx: 13, gy: 14, gw: 2, gh: 2, h: 38, top: C.shopTop,   wall: C.shopWall },
  { gx: 21, gy: 27, gw: 2, gh: 2, h: 26, top: C.dormTop,   wall: C.dormWall },
  { gx:  9, gy: 19, gw: 2, gh: 2, h: 48, top: C.officeTop, wall: C.officeWall },
  { gx: 24, gy:  9, gw: 2, gh: 2, h: 40, top: C.officeTop, wall: C.officeWall },
  { gx: 16, gy: 31, gw: 2, gh: 2, h: 30, top: C.shopTop,   wall: C.shopWall },
  { gx: 33, gy: 26, gw: 2, gh: 2, h: 36, top: C.dormTop,   wall: C.dormWall },
  { gx: 11, gy: 30, gw: 2, gh: 2, h: 34, top: C.officeTop, wall: C.officeWall },
  { gx: 30, gy:  8, gw: 2, gh: 2, h: 30, top: C.shopTop,   wall: C.shopWall },
] as const;

const TREES = [[16, 13], [24, 14], [26, 17], [15, 21], [19, 22], [25, 20], [11, 23],
               [20, 25], [29, 20], [23, 30], [14, 28], [31, 14], [18, 11], [34, 22],
               [9, 27], [27, 31]] as const;

/* 道は十字に通す。街が「区画」に割れて、建物が置かれている場所に見える */
const isRoad = (gx: number, gy: number): boolean => gx === 26 || gy === 22;
/* 川は手前の角に流す。地面が一色で続くより、端に違う素材があるほうが奥行きが出る */
const isWater = (gx: number, gy: number): boolean => gx + gy >= 58 && gx + gy <= 62;

function inPlot(gx: number, gy: number): boolean {
  for (const p of [...Object.values(PLOTS), ...SCENERY]) {
    if (gx >= p.gx && gx < p.gx + p.gw && gy >= p.gy && gy < p.gy + p.gh) return true;
  }
  return false;
}

/* ------------------------------------------------------------- 描くもの */

function sky(c: CanvasRenderingContext2D): void {
  /* 🔑 なめらかなグラデーションにしない。段に割ると空までドット絵の側に寄る */
  const bands = [C.skyTop, "#7cc8f2", "#9ddaf7", C.skyLow];
  bands.forEach((col, i) => {
    c.fillStyle = col;
    c.fillRect(0, i * 26, W, 26);
  });
  c.fillStyle = C.skyLow;
  c.fillRect(0, bands.length * 26, W, H - bands.length * 26);

  for (const [x, y, w] of [[60, 22, 40], [250, 12, 26], [430, 30, 46], [560, 18, 30]]) {
    c.fillStyle = C.cloud;
    c.fillRect(x!, y!, w!, 6);
    c.fillRect(x! + 6, y! - 4, w! - 14, 5);
    c.fillRect(x! + 12, y! + 5, w! - 22, 4);
  }
}

function ground(v: View): void {
  /* 🔴 奥から手前へ（`gx+gy` の小さい順）。順番を変えると建物が重なり方を間違える */
  for (let s = 0; s <= (G - 1) * 2; s++) {
    for (let gx = 0; gx < G; gx++) {
      const gy = s - gx;
      if (gy < 0 || gy >= G) continue;
      if (isWater(gx, gy)) {
        tile(v, gx, gy, 0, (gx + gy) % 2 === 0 ? C.water : C.waterAlt);
      } else if (isRoad(gx, gy)) {
        tile(v, gx, gy, 0, C.road);
        /* 道の真ん中に白線。道が道に見える最小の手がかり */
        const p = at(v, gx, gy, 0);
        v.c.fillStyle = C.roadLine;
        v.c.fillRect(p.x - 2, p.y - 1, 4, 2);
      } else {
        tile(v, gx, gy, 0, (gx + gy) % 2 === 0 ? C.grass : C.grassAlt);
      }
    }
  }
}

/** 窓を面に打つ。建物が「壁の箱」から「人が居る建物」に変わる */
function windows(v: View, gx: number, gy: number, gw: number, gh: number,
                 base: number, height: number, seed: number): void {
  const c = v.c;
  const rows = Math.floor(height / 12);
  for (let r = 0; r < rows; r++) {
    const hy = base + height - 8 - r * 12;
    for (let k = 0; k < gh; k++) {
      const p = at(v, gx + gw, gy + k + .5, hy);
      c.fillStyle = wob(seed + r * 7 + k, 5) === 0 ? C.windowLit : C.window;
      c.fillRect(p.x + 3, p.y - 4, 5, 6);
    }
    for (let k = 0; k < gw; k++) {
      const p = at(v, gx + k + .5, gy + gh, hy);
      c.fillStyle = wob(seed + r * 3 + k + 11, 5) === 0 ? C.windowLit : C.window;
      c.fillRect(p.x - 8, p.y - 4, 5, 6);
    }
  }
}

function tree(v: View, gx: number, gy: number): void {
  const p = at(v, gx, gy, 0);
  const c = v.c;
  c.fillStyle = C.trunk;
  c.fillRect(p.x - 1, p.y - 10, 3, 10);
  c.fillStyle = C.leafDk;
  c.fillRect(p.x - 7, p.y - 22, 14, 13);
  c.fillStyle = C.leaf;
  c.fillRect(p.x - 6, p.y - 23, 12, 11);
}

/** 大きなサッカー場。観客席の器の中に芝が見えている */
function stadium(v: View): void {
  const p = PLOTS.stadium;
  slab(v, p.gx, p.gy, p.gw, p.gh, 0, p.h, C.standTop, C.standSide, C.edge);
  /* 🔑 観客席に色を入れる。白いままだと「大きい白い箱」で、競技場に見えない。
        席の色を2色で散らすと、遠目に人が入っているように読める（人は描いていない）。 */
  for (let gx = p.gx; gx < p.gx + p.gw; gx++) {
    for (let gy = p.gy; gy < p.gy + p.gh; gy++) {
      const inside = gx > p.gx && gx < p.gx + p.gw - 1
                     && gy > p.gy && gy < p.gy + p.gh - 1;
      if (inside) continue;
      /* 🔑 席の色は**1色＋ときどき差し色**。2色を半々で散らすと、
            遠目に「市松模様の屋根」に見えて、席に見えない（2026-10-02 の目視） */
      tile(v, gx, gy, p.h, wob(gx * 7 + gy, 5) === 0 ? C.seatAlt : C.seat);
    }
  }
  /* 器の中をくり抜いて芝を見せる */
  for (let gx = p.gx + 1; gx < p.gx + p.gw - 1; gx++) {
    for (let gy = p.gy + 1; gy < p.gy + p.gh - 1; gy++) {
      tile(v, gx, gy, p.h - 6, (gx + gy) % 2 === 0 ? C.pitch : C.pitchAlt);
    }
  }
  /* センターライン */
  for (let gy = p.gy + 1; gy < p.gy + p.gh - 1; gy++) {
    const q = at(v, p.gx + p.gw / 2, gy, p.h - 6);
    v.c.fillStyle = C.roadLine;
    v.c.fillRect(q.x - 1, q.y - 1, 2, 2);
  }
  /* 照明塔。4隅に立てると「大きな競技場」の記号になる */
  for (const [dx, dy] of [[0, 0], [p.gw, 0], [0, p.gh], [p.gw, p.gh]]) {
    const q = at(v, p.gx + dx!, p.gy + dy!, 0);
    v.c.fillStyle = shade(C.standSide, .7);
    v.c.fillRect(q.x - 1, q.y - 52, 2, 52);
    v.c.fillStyle = C.windowLit;
    v.c.fillRect(q.x - 5, q.y - 60, 10, 7);
    v.c.strokeStyle = C.edge;
    v.c.lineWidth = 1;
    v.c.strokeRect(q.x - 5.5, q.y - 60.5, 11, 8);
  }
}

/** 商店街。小さい店が3つ並び、赤い日よけが出ている */
function shops(v: View): void {
  const p = PLOTS.shop;
  for (let k = 0; k < p.gh; k++) {
    box(v, p.gx, p.gy + k, p.gw, 1, 0, p.h - k * 2,
        C.shopTop, C.shopWall, shade(C.shopWall, .84), C.edge);
    windows(v, p.gx, p.gy + k, p.gw, 1, 0, p.h - k * 2, 40 + k * 5);
  }
}

function office(v: View): void {
  const p = PLOTS.office;
  box(v, p.gx, p.gy, p.gw, p.gh, 0, p.h,
      C.officeWall, C.officeWall, shade(C.officeWall, .84), C.edge);
  windows(v, p.gx, p.gy, p.gw, p.gh, 0, p.h, 7);
  /* 屋上に青い帽子。遠目にも「あの青いビル」で指せるようにする */
  slab(v, p.gx, p.gy, p.gw, p.gh, p.h, 8, C.officeTop, shade(C.officeTop, .9), C.edge);
}

/**
 * 街をまるごと1枚描く。
 *
 * 🔴 **描く順番＝奥から手前。** `gx + gy` の合計が小さいものほど奥。
 *    ここを崩すと、手前の建物の上に奥の建物が乗る。
 */
export function draw(canvas: HTMLCanvasElement): void {
  const c = canvas.getContext("2d");
  if (c === null) throw new Error("街を描く canvas が使えない");
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, W, H);
  const v: View = { c, ...ORIGIN };

  sky(c);
  ground(v);

  /* 置きものを「奥行きの合計」で並べ替えてから描く。
     🔑 施設も賑やかしも木も**同じ1本の列**に入れる。別々に描くと、
        木が建物の前に出たり後ろに回ったりして、奥行きが壊れる。 */
  type Item = { key: number; run: () => void };
  const items: Item[] = [];
  const push = (gx: number, gy: number, run: () => void): void =>
    void items.push({ key: gx + gy, run });

  push(PLOTS.stadium.gx, PLOTS.stadium.gy, () => stadium(v));
  push(PLOTS.shop.gx, PLOTS.shop.gy, () => shops(v));
  push(PLOTS.office.gx, PLOTS.office.gy, () => office(v));
  for (const s of SCENERY) {
    push(s.gx, s.gy, () => {
      box(v, s.gx, s.gy, s.gw, s.gh, 0, s.h, s.top, s.wall, shade(s.wall, .84), C.edge);
      windows(v, s.gx, s.gy, s.gw, s.gh, 0, s.h, s.gx * 13 + s.gy);
    });
  }
  for (const [gx, gy] of TREES) {
    if (inPlot(gx, gy) || isWater(gx, gy)) continue;
    push(gx, gy, () => tree(v, gx, gy));
  }
  items.sort((a, b) => a.key - b.key);
  for (const it of items) it.run();
}

/**
 * 押せる場所を重ねる位置（％）。
 *
 * 🔑 **区画（`PLOTS`）と建物の高さから計算する。** CSS に書き写すと、
 *    建物を動かしたときに札だけ取り残される（2026-10-02 に実際にやった）。
 * 🔑 札は屋根の**少し上**に出す。屋根に重ねると、せっかくの立体が隠れる。
 */
function spotOf(p: { gx: number; gy: number; gw: number; gh: number; h: number },
                lift: number): { left: number; top: number } {
  const v: View = { c: null as unknown as CanvasRenderingContext2D, ...ORIGIN };
  const q = at(v, p.gx + p.gw / 2, p.gy + p.gh / 2, p.h + lift);
  return { left: (q.x / W) * 100, top: (q.y / H) * 100 };
}

export const SPOTS = {
  stadium: spotOf(PLOTS.stadium, 76),
  shop:    spotOf(PLOTS.shop, 30),
  office:  spotOf(PLOTS.office, 30),
} as const;
