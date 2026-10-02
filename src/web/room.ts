/**
 * 施設の中をアイソメで描く。パネルの後ろに敷く「場所」の絵。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ中にも絵が要るのか（2026-10-02 ラフ）
 * ─────────────────────────────────────────────────────────────
 * 街だけ立体にして中が白い板のままだと、**施設に入った感じがしない**。
 * 入った先が「別のページ」ではなく「建物の中」に見えて、はじめて街が意味を持つ。
 *
 * 🔑 室内は**背景**であって主役ではない。読むのは手前のパネルなので、
 *    家具は置くが、文字と同じ明るさ・同じ彩度にはしない（下の `dim`）。
 *    背景が強いと、パネルの字が読めなくなる。
 *
 * 🔴 **ここにゲームの規則を1行も書かない。** 投影と描く順は `iso.ts`。
 * 🔑 **乱数を引かない**（`city.ts` と同じ理由）。
 */

import { at, box, shade, tile } from "./iso.ts";
import type { View } from "./iso.ts";

export const W = 640;
export const H = 360;

/**
 * 床のマス数と原点。
 *
 * 🔴 **床は canvas の端まで敷く。** 11×11 で敷いたら、菱形の外（左右の端）が
 *    素通しになり、せっかくの部屋が見えずに地の縞だけが見えていた（2026-10-02 の目視）。
 *    22マスにすると横幅 320±352 で 640 を覆い切る。はみ出しは切り取られる。
 *
 * 🔴 **家具は `|gx - gy| > 12` の帯に置く。** 手前のパネルが画面の中央 58% を覆うので、
 *    中央に置いた家具は1つも見えない。アイソメでは `gx - gy` が画面の横位置に当たるので、
 *    この差が大きいところ＝画面の左右の端になる。
 */
const GX = 22;
const GY = 22;
const ORIGIN = { ox: 320, oy: 28 };

/** 壁の高さ（ドット） */
const WALL = 86;

const C = {
  floorA:  "#d9c9a6",
  floorB:  "#cfbd96",
  floorShop: "#bfb6a6",
  floorShopB:"#b4aa99",
  turf:    "#49ad4f",
  turfB:   "#3f9e46",

  wall:    "#eadfc6",
  wallDk:  "#d6c8a8",
  skirt:   "#8a6a44",

  glass:   "#9fd8f5",
  glassDk: "#7cc3e8",
  frame:   "#f6f2e6",

  desk:    "#a9774a",
  deskTop: "#c08f5c",
  seat:    "#2f7ed8",
  screen:  "#2b3b52",
  screenOn:"#6fd0f0",
  paper:   "#fbf7ec",
  board:   "#f2f6fb",
  plant:   "#49a048",
  plantDk: "#35803a",
  pot:     "#c4603f",
  crate:   "#c89a5c",
  crateDk: "#a67c45",
  awning:  "#e2574c",
  edge:    "#20304a",
  ball:    "#fdfaf0",
};

/* 🔑 背景として沈ませる量。ここを1か所に持つと、部屋ごとに濃さがばらけない */
const dim = (hex: string): string => shade(hex, .9);

function floor(v: View, a: string, b: string): void {
  for (let gx = 0; gx < GX; gx++) {
    for (let gy = 0; gy < GY; gy++) {
      tile(v, gx, gy, 0, (gx + gy) % 2 === 0 ? a : b);
    }
  }
}

/**
 * 奥の2枚の壁。
 *
 * 🔑 アイソメの部屋は**奥の2面だけ**描く。手前2面も描くと中が見えなくなる。
 *    「箱の中を斜め上から覗いている」形にするのが、この投影の部屋の作法。
 */
function walls(v: View): void {
  box(v, 0, -0.4, GX, 0.4, 0, WALL, dim(C.wallDk), dim(C.wall), dim(C.wallDk), C.edge);
  box(v, -0.4, 0, 0.4, GY, 0, WALL, dim(C.wallDk), dim(C.wallDk), dim(C.wall), C.edge);
  /* 幅木。床と壁の境目に線が1本あるだけで、床が床に見える */
  box(v, 0, -0.4, GX, 0.4, 0, 6, C.skirt, shade(C.skirt, .9), shade(C.skirt, .78), C.edge);
  box(v, -0.4, 0, 0.4, GY, 0, 6, C.skirt, shade(C.skirt, .78), shade(C.skirt, .9), C.edge);
}

/** 右の壁（gy 側）に窓を開ける。外が見えると部屋が閉じて見えない */
function windowRight(v: View, gy: number, gh: number, y0: number, y1: number): void {
  const a = at(v, 0, gy, y1);
  const b = at(v, 0, gy + gh, y1);
  const c2 = at(v, 0, gy + gh, y0);
  const d = at(v, 0, gy, y0);
  const c = v.c;
  const quad = (fill: string, inset: number): void => {
    c.beginPath();
    c.moveTo(a.x + inset, a.y + inset);
    c.lineTo(b.x + inset, b.y - inset);
    c.lineTo(c2.x + inset, c2.y - inset);
    c.lineTo(d.x + inset, d.y + inset);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = C.edge;
    c.lineWidth = 1;
    c.stroke();
  };
  quad(C.frame, 0);
  quad(dim(C.glass), 3);
}

/** 左の壁（gx 側）に掛けもの（ホワイトボード・掲示物） */
function boardLeft(v: View, gx: number, gw: number, y0: number, y1: number,
                   fill: string): void {
  const a = at(v, gx, 0, y1);
  const b = at(v, gx + gw, 0, y1);
  const c2 = at(v, gx + gw, 0, y0);
  const d = at(v, gx, 0, y0);
  const c = v.c;
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(b.x, b.y);
  c.lineTo(c2.x, c2.y);
  c.lineTo(d.x, d.y);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = C.edge;
  c.lineWidth = 1;
  c.stroke();
}

function plant(v: View, gx: number, gy: number): void {
  box(v, gx, gy, .8, .8, 0, 10, C.pot, shade(C.pot, .9), shade(C.pot, .78), C.edge);
  box(v, gx + .1, gy + .1, .6, .6, 10, 20, C.plant, C.plant, C.plantDk, C.edge);
}

/** 机。天板＋脚＋画面。向きは1種類だけ（部屋の中で机の向きが混ざると散らかって見える） */
function desk(v: View, gx: number, gy: number): void {
  box(v, gx, gy, 1.8, .9, 0, 16, C.deskTop, C.desk, shade(C.desk, .82), C.edge);
  /* 画面 */
  box(v, gx + .3, gy + .25, .5, .4, 16, 12, C.screen, C.screenOn, shade(C.screen, .8), C.edge);
  /* 書類 */
  const p = at(v, gx + 1.3, gy + .45, 16);
  v.c.fillStyle = C.paper;
  v.c.fillRect(p.x - 4, p.y - 3, 8, 5);
  v.c.strokeStyle = C.edge;
  v.c.lineWidth = 1;
  v.c.strokeRect(p.x - 4.5, p.y - 3.5, 9, 6);
}

function chair(v: View, gx: number, gy: number): void {
  box(v, gx, gy, .7, .7, 0, 9, C.seat, shade(C.seat, .9), shade(C.seat, .78), C.edge);
  box(v, gx, gy, .7, .18, 9, 12, shade(C.seat, .86), shade(C.seat, .8),
      shade(C.seat, .7), C.edge);
}

/** 人。ドット絵の選手と同じ作りにはしない（ここは背景なので、形だけ分かれば足りる） */
function person(v: View, gx: number, gy: number, shirt: string): void {
  const p = at(v, gx, gy, 0);
  const c = v.c;
  const put = (x: number, y: number, w: number, h: number, col: string): void => {
    c.fillStyle = col;
    c.fillRect(Math.round(p.x + x), Math.round(p.y + y), w, h);
  };
  put(-3, -8, 6, 8, dim(shirt));          // 胴
  put(-3, -14, 6, 6, "#f0cda4");          // 頭
  put(-3, -15, 6, 3, "#3b2a1b");          // 髪
  put(-4, -7, 1, 5, "#f0cda4");           // 腕
  put(3, -7, 1, 5, "#f0cda4");
  put(-2, 0, 2, 2, "#3b2a1b");            // 足
  put(0, 0, 2, 2, "#3b2a1b");
}

/* ------------------------------------------------------------- 各施設 */

function office(v: View): void {
  floor(v, dim(C.floorA), dim(C.floorB));
  walls(v);
  windowRight(v, 2.0, 4.0, 34, 74);
  windowRight(v, 8.0, 4.0, 34, 74);
  windowRight(v, 14.0, 4.0, 34, 74);
  boardLeft(v, 2.0, 4.0, 36, 72, dim(C.board));
  boardLeft(v, 9.0, 3.0, 40, 68, dim(C.paper));
  /* ホワイトボードの線。何か書いてあるように見えれば足りる */
  for (let i = 0; i < 4; i++) {
    const q = at(v, 2.4 + i * .2, 0, 66 - i * 7);
    v.c.fillStyle = dim(C.seat);
    v.c.fillRect(q.x, q.y, 16 + i * 4, 2);
  }

  /* 🔴 家具は**画面の左右の端へ寄せる**（2026-10-02 の目視）。
        真ん中は手前のパネルが覆うので、中央に置いた机は1つも見えない。
        アイソメでは「gx が大きい＝画面の右、gy が大きい＝画面の左」なので、
        gx と gy のどちらかが大きい側に寄せると、パネルの外に出る。
     🔑 奥から手前へ。机→椅子→人 の順に置く。 */
  /* 右の帯（gx - gy が大きい）と左の帯（gy - gx が大きい）に分けて置く */
  const seats: [number, number][] = [
    [15, 1], [18, 4], [20, 8],          // 画面の右
    [1, 15], [4, 18], [8, 20],          // 画面の左
  ];
  for (const [gx, gy] of seats) {
    desk(v, gx, gy);
    chair(v, gx + .5, gy + 1.3);
  }
  person(v, 17.2, 2.0, C.seat);
  person(v, 2.0, 17.2, "#e2574c");
  person(v, 20.4, 6.2, "#f0a01e");
  person(v, 6.2, 20.4, "#49a048");
  plant(v, 21.0, 3.0);
  plant(v, 3.0, 21.0);
  plant(v, 19.0, 12.0);
  plant(v, 12.0, 19.0);
  /* ボール。サッカーの事務所だと分かる小物を1つだけ置く */
  const b = at(v, 21.4, 9.0, 0);
  v.c.fillStyle = C.ball;
  v.c.beginPath();
  v.c.arc(b.x, b.y - 4, 4, 0, Math.PI * 2);
  v.c.fill();
  v.c.strokeStyle = C.edge;
  v.c.lineWidth = 1;
  v.c.stroke();
}

function shop(v: View): void {
  floor(v, dim(C.floorShop), dim(C.floorShopB));
  walls(v);
  /* 店先を左右の帯に並べる。通りを歩いている形にする */
  for (let i = 0; i < 4; i++) {
    const gy = 1 + i * 4.0;
    box(v, gy + 13, gy, 2.4, 2.4, 0, 30, dim(C.crateDk), dim(C.crate),
        shade(dim(C.crate), .82), C.edge);
    box(v, gy + 13, gy, 2.4, 2.4, 30, 8, C.awning, shade(C.awning, .9),
        shade(C.awning, .78), C.edge);
    box(v, gy, gy + 13, 2.4, 2.4, 0, 30, dim(C.crateDk), dim(C.crate),
        shade(dim(C.crate), .82), C.edge);
    box(v, gy, gy + 13, 2.4, 2.4, 30, 8, C.awning, shade(C.awning, .78),
        shade(C.awning, .9), C.edge);
  }
  /* 通りに積んだ木箱 */
  for (const [gx, gy] of [[19.0, 5.0], [20.0, 5.0], [19.0, 6.0], [5.0, 19.0], [6.0, 20.0]]) {
    box(v, gx!, gy!, .9, .9, 0, 11, C.crate, shade(C.crate, .9),
        shade(C.crate, .78), C.edge);
  }
  box(v, 19.0, 5.0, .9, .9, 11, 11, C.crate, shade(C.crate, .9),
      shade(C.crate, .78), C.edge);
  person(v, 18.0, 3.0, "#2f7ed8");
  person(v, 3.0, 18.0, "#49a048");
  person(v, 21.0, 8.0, "#f0a01e");
  plant(v, 21.5, 11.0);
  plant(v, 11.0, 21.5);
}

function stadium(v: View): void {
  floor(v, dim(C.turf), dim(C.turfB));
  walls(v);
  /* 観客席の段。壁の手前に3段重ねると、スタンドの下に立っている形になる */
  for (let i = 0; i < 3; i++) {
    const h = 10 + i * 10;
    box(v, 0, -0.4 + i * .5, GX, .5, 0, h, dim("#6d86ad"), dim("#8094b8"),
        dim("#5c7399"), C.edge);
    box(v, -0.4 + i * .5, 0, .5, GY, 0, h, dim("#6d86ad"), dim("#5c7399"),
        dim("#8094b8"), C.edge);
  }
  /* ピッチの白線。対角に1本引くと、芝が広がっているのが分かる */
  for (let k = 2; k < GX; k++) {
    const p = at(v, k, k, 0);
    v.c.fillStyle = "#eafbee";
    v.c.fillRect(p.x - 2, p.y - 1, 4, 2);
  }
  const b = at(v, 20.0, 8.0, 0);
  v.c.fillStyle = C.ball;
  v.c.beginPath();
  v.c.arc(b.x, b.y - 4, 4, 0, Math.PI * 2);
  v.c.fill();
  v.c.strokeStyle = C.edge;
  v.c.lineWidth = 1;
  v.c.stroke();
  person(v, 18.6, 6.0, "#f0a01e");
  person(v, 6.0, 18.6, "#2f7ed8");
  person(v, 21.0, 10.0, "#e2574c");
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
        塗らないとそこだけ素通しになり、ページの地の縞が覗く（2026-10-02 の目視）。
        暗めにしておくと、覗いた部分が「隅の影」として収まる。 */
  c.fillStyle = "#6b5a44";
  c.fillRect(0, 0, W, H);
  run({ c, ...ORIGIN });
  return true;
}
