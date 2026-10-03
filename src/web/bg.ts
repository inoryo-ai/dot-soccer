/**
 * デザイン由来の背景（街・商店街・事務所）を画面に敷く。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 絵は `web/bg/*.js` が**コードで描く**（画像ファイルではない）
 * ─────────────────────────────────────────────────────────────
 * claude.ai のデザインプロジェクトから取り込んだもの。960×540 で描いて
 * **最近傍で2倍**し、1920×1080 にする（`docs/image-prompts.md` で渡した作り方そのもの）。
 *
 * 🔑 画像ファイルではないので、出どころの問題も、差し替えの取り違えも起きない。
 *    乱数も種つきなので、**同じ画面はいつ見ても同じ絵**になる（D-16）。
 *
 * 🔴 `web/bg/*.js` は**預かりもの。手で直さない。**
 *    直すならデザイン側で直して取り込み直す。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 描き直しは高い。1回描いて取っておく
 * ─────────────────────────────────────────────────────────────
 * 街は木70本・人40人超を1枚ずつ置くので、画面を切り替えるたびに描くと
 * そのたびに止まる。**一度描いた canvas を持ち回す。**
 */

/** 背景の種類。`main.ts` の画面IDと対応させる */
export type Kind = "town" | "town-night" | "arcade" | "office";

/* 🔑 `web/bg/*.js` は普通の `<script>` で読み込まれ、グローバルに関数を置く
      （`scene/stadium.js` と同じ作り）。module にすると読み込み順の約束が増える。 */
interface BgGlobals {
  makeLib?: unknown;
  drawTown?: (night: boolean, makeLib: unknown,
              createCanvas: (w: number, h: number) => HTMLCanvasElement) => HTMLCanvasElement;
  drawArcade?: (makeLib: unknown,
                createCanvas: (w: number, h: number) => HTMLCanvasElement) => HTMLCanvasElement;
  drawOffice?: (makeLib: unknown,
                createCanvas: (w: number, h: number) => HTMLCanvasElement) => HTMLCanvasElement;
}

/** 元の絵の大きさ。2倍して 1920×1080 にする */
export const SRC_W = 960;
export const SRC_H = 540;

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const cache = new Map<Kind, HTMLCanvasElement>();

/**
 * 背景を1枚描いて返す（2回目からは取っておいたものを返す）。
 *
 * 🔴 読み込まれていなければ**黙って諦めない**。`index.html` の `<script>` を
 *    書き忘れたとき、背景が出ないだけだと原因が画面から見えない。
 */
function source(kind: Kind): HTMLCanvasElement {
  const hit = cache.get(kind);
  if (hit !== undefined) return hit;

  const g = globalThis as unknown as BgGlobals;
  const lib = g.makeLib;
  if (lib === undefined) {
    throw new Error("背景の共通ライブラリ（bg/lib.js）が読み込まれていない");
  }
  const made = kind === "town" ? g.drawTown?.(false, lib, createCanvas)
             : kind === "town-night" ? g.drawTown?.(true, lib, createCanvas)
             : kind === "arcade" ? g.drawArcade?.(lib, createCanvas)
             : g.drawOffice?.(lib, createCanvas);
  if (made === undefined) {
    throw new Error(`背景「${kind}」を描く関数が読み込まれていない（bg/*.js の <script> を確認）`);
  }
  cache.set(kind, made);
  return made;
}

/**
 * 画面の canvas へ、背景を**整数倍**で敷く。
 *
 * 🔴 **整数倍でしか拡大しない。** ドット絵なので、1.5倍のような端数にすると
 *    1ドットが2pxの列と1pxの列に割れて、縞のムラが出る。
 *    端数ぶんは左右上下の余白にする（`image-rendering: pixelated` はムラを消さない）。
 */
export function draw(target: HTMLCanvasElement, kind: Kind): void {
  const src = source(kind);
  const c = target.getContext("2d");
  if (c === null) throw new Error("背景を描く canvas が使えない");

  const box = target.getBoundingClientRect();
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = Math.max(1, Math.round((box.width || SRC_W) * dpr));
  const h = Math.max(1, Math.round((box.height || SRC_H) * dpr));
  if (target.width !== w || target.height !== h) {
    target.width = w;
    target.height = h;
  }

  /* 覆いきる倍率を整数で取る（足りないと縁に地が出る） */
  const k = Math.max(1, Math.ceil(Math.max(w / SRC_W, h / SRC_H)));
  const dw = SRC_W * k;
  const dh = SRC_H * k;
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, w, h);
  /* 🔑 横は中央、縦は**上に寄せる**。街も商店街も、絵の見せ場は上半分にある */
  c.drawImage(src, Math.round((w - dw) / 2), Math.round(Math.min(0, (h - dh) / 2)), dw, dh);
}

/**
 * 街の施設を指す点（`town.js` の絵の中。960×540 に対する割合）。
 *
 * 🔴 **絵と押せる場所は必ずここ1か所から出す。** 絵を描き直したのに
 *    押せる場所だけ取り残される、が一番よく起きる壊れ方。
 *
 * 🔴 **指すのは建物の「天辺」で、中心ではない**（2026-10-03 オーナー指摘
 *    「建物の上に名前を出して」）。中心を指すと札が建物にかぶさり、
 *    せっかく描いてもらったスタジアムやビルが**札で隠れる**。
 *    札は `transform: translate(-50%, -100%)` で指した点の**上**に乗り、
 *    下に出る ▼ がその点を指す。
 *
 * 🔑 値は `web/bg/town.js` の図形から出した:
 *    サッカー場 = 楕円の上端（中心 y=398・短半径 58・高さ 24 → 316）
 *    商店街     = 屋根の上面（箱 gz=24 の上面。中心は iso で (498, 181)）
 *    事務所     = 屋上（箱 gz=40 ＋ 屋上の小箱。iso で (808, 348)）
 */
export const TOWN_SPOTS: Record<string, { left: number; top: number }> = {
  stadium: { left: (180 / SRC_W) * 100, top: (322 / SRC_H) * 100 },
  shop: { left: (498 / SRC_W) * 100, top: (176 / SRC_H) * 100 },
  office: { left: (812 / SRC_W) * 100, top: (344 / SRC_H) * 100 },
};
