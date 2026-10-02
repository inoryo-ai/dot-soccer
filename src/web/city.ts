/**
 * 街のドット絵を**コードで描いて作る**。施設を選ぶハブ画面の地。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 画像ファイルを持ち込まない（`sprites.ts` と同じ筋）
 * ─────────────────────────────────────────────────────────────
 * 要件定義書 §12「名称・キャラ・ドット絵・UIをオリジナルにする」。
 * 手続きで描けば、出どころの問題が起きようがない。
 *
 * 🔴 **ここにゲームの規則を1行も書かない。** 街は見た目だけで、
 *    どこへ行けるか・押せるかは `main.ts` 側の HTML のボタンが持つ
 *    （canvas の当たり判定で作ると、キーボードでも読み上げでも辿れなくなる）。
 *
 * 🔑 **乱数を引かない。** ビルごとに街並みが変わると、画面の確認で
 *    「前と違う」のが変更のせいか乱数のせいか分からなくなる。
 *    ばらつきは番号から作る（下の `wobble`）。
 *
 * 🔑 1ドットを1点として描き、表示のときだけ拡大する（CSS の `image-rendering: pixelated`）。
 *    先に拡大してから描くと、ドットの角が丸まって「ドット絵」でなくなる。
 */

export const W = 480;
export const H = 270;

/* 🔴 色は `web/style.css` の `:root` と揃える（canvas は CSS 変数を読めない）。
      片方だけ変えると、街と画面の枠が違う色になる。 */
const C = {
  skyTop:    "#6fc5f0",
  skyMid:    "#9adcf7",
  skyLow:    "#c9eefb",
  cloud:     "#fffdf3",
  farCity:   "#8fb3cf",
  farCity2:  "#a3c3da",
  road:      "#9a8463",
  roadLine:  "#f6ead0",
  ground:    "#7fbf5c",
  groundDk:  "#6aa94b",
  edge:      "#3b2a1b",
  wall:      "#fffdf3",
  wallShade: "#e7d6b4",
  window:    "#3d8ed6",
  windowLit: "#f2a714",
  roofShop:  "#e2574c",
  roofOffice:"#3d8ed6",
  stand:     "#efe3c6",
  pitch:     "#3fae5a",
  pitchDk:   "#37a04f",
  pole:      "#7d6a51",
  tree:      "#2e8c46",
  treeDk:    "#246f38",
};

/** 番号から決まる小さなばらつき。乱数の代わり（同じ番号なら必ず同じ） */
const wobble = (i: number, n: number): number => ((i * 2654435761) >>> 0) % n;

function rect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
              color: string): void {
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
}

/** 枠つきの箱。輪郭が無いと、明るい地の上で建物が溶ける */
function box(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
             fill: string): void {
  rect(c, x, y, w, h, C.edge);
  rect(c, x + 1, y + 1, w - 2, h - 2, fill);
}

function sky(c: CanvasRenderingContext2D): void {
  /* 🔑 なめらかなグラデーションにしない。3段に割ると空までドット絵の側に寄る */
  rect(c, 0, 0, W, 70, C.skyTop);
  rect(c, 0, 70, W, 50, C.skyMid);
  rect(c, 0, 120, W, 40, C.skyLow);

  /* 雲。横長の箱を3つ重ねるだけで雲に見える */
  const clouds = [[40, 24, 34], [150, 14, 22], [300, 30, 40], [410, 18, 26]];
  for (const [x, y, w] of clouds) {
    rect(c, x!, y!, w!, 6, C.cloud);
    rect(c, x! + 5, y! - 4, w! - 12, 5, C.cloud);
    rect(c, x! + 10, y! + 5, w! - 18, 4, C.cloud);
  }
}

/** 遠景のビル群。奥ほど薄くして、手前の3施設を前に出す */
function skyline(c: CanvasRenderingContext2D): void {
  for (let i = 0; i < 24; i++) {
    const x = i * 21 - 6;
    const h = 26 + wobble(i + 1, 46);
    const w = 16 + wobble(i + 7, 8);
    rect(c, x, 158 - h, w, h, i % 2 === 0 ? C.farCity : C.farCity2);
    /* 窓。3つおきに灯りを入れると「生きている街」に見える */
    for (let wy = 158 - h + 4; wy < 154; wy += 7) {
      for (let wx = x + 3; wx < x + w - 3; wx += 5) {
        rect(c, wx, wy, 2, 3, wobble(wx * wy, 7) === 0 ? C.windowLit : C.farCity2);
      }
    }
  }
  rect(c, 0, 158, W, 4, C.edge);
}

function groundAndRoad(c: CanvasRenderingContext2D): void {
  rect(c, 0, 162, W, H - 162, C.ground);
  /* 芝の目。試合のピッチと同じ「縞は質感」の考え方 */
  for (let x = 0; x < W; x += 16) rect(c, x, 162, 8, H - 162, C.groundDk);

  /* 道。3施設の前を横切らせて、歩いて回る場所だと分かるようにする */
  rect(c, 0, 214, W, 26, C.edge);
  rect(c, 0, 216, W, 22, C.road);
  for (let x = 6; x < W; x += 24) rect(c, x, 226, 12, 2, C.roadLine);
}

/** 商店街。小さい店が並び、日よけとのぼりが出ている */
function shoppingStreet(c: CanvasRenderingContext2D, x: number, y: number): void {
  box(c, x, y, 128, 56, C.wall);
  rect(c, x + 2, y + 2, 124, 10, C.roofShop);          // 通りにかかる屋根
  for (let i = 0; i < 4; i++) {
    const sx = x + 6 + i * 30;
    rect(c, sx, y + 14, 24, 28, C.wallShade);          // 店先
    rect(c, sx, y + 14, 24, 5, C.roofShop);            // 日よけ
    for (let k = 0; k < 24; k += 6) rect(c, sx + k, y + 19, 3, 2, C.wall);  // 日よけの縞
    rect(c, sx + 7, y + 24, 10, 18, C.edge);           // 入口
    rect(c, sx + 8, y + 25, 8, 17, C.window);
  }
  /* のぼり。縦の棒＋旗で「商店街」の気配を出す */
  rect(c, x + 120, y - 14, 2, 20, C.pole);
  rect(c, x + 110, y - 14, 11, 9, C.roofShop);
  rect(c, x + 2, y + 44, 124, 10, C.wallShade);
}

/** 大きなサッカー場。観客席に囲まれた芝が見えている */
function stadium(c: CanvasRenderingContext2D, x: number, y: number): void {
  box(c, x, y, 150, 72, C.stand);
  /* 観客席の段。横の線を重ねるだけで段に見える */
  for (let i = 0; i < 5; i++) rect(c, x + 4 + i * 2, y + 8 + i * 3, 142 - i * 4, 2, C.wallShade);
  /* 中の芝 */
  rect(c, x + 18, y + 24, 114, 40, C.edge);
  rect(c, x + 19, y + 25, 112, 38, C.pitch);
  for (let sx = x + 19; sx < x + 131; sx += 14) rect(c, sx, y + 25, 7, 38, C.pitchDk);
  rect(c, x + 74, y + 25, 2, 38, C.roadLine);          // センターライン
  rect(c, x + 69, y + 39, 12, 10, C.stand);            // センターサークル（四角で十分）
  rect(c, x + 71, y + 41, 8, 6, C.pitch);
  /* 照明塔。夜でなくても「大きな競技場」の記号になる */
  for (const px of [x + 6, x + 140]) {
    rect(c, px, y - 22, 3, 24, C.pole);
    box(c, px - 5, y - 30, 13, 9, C.windowLit);
  }
}

/** 事務所。縦に長い建物で、入口が1つ */
function office(c: CanvasRenderingContext2D, x: number, y: number): void {
  box(c, x, y, 76, 94, C.wall);
  rect(c, x + 2, y + 2, 72, 10, C.roofOffice);
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 4; col++) {
      const wx = x + 8 + col * 16;
      const wy = y + 18 + row * 12;
      rect(c, wx, wy, 11, 8, C.edge);
      rect(c, wx + 1, wy + 1, 9, 6,
           wobble(row * 4 + col + 3, 5) === 0 ? C.windowLit : C.window);
    }
  }
  rect(c, x + 28, y + 76, 20, 18, C.edge);             // 入口
  rect(c, x + 29, y + 77, 18, 17, C.window);
  rect(c, x + 37, y + 77, 2, 17, C.wall);              // 自動ドアの合わせ目
}

function tree(c: CanvasRenderingContext2D, x: number, y: number): void {
  rect(c, x + 3, y + 10, 3, 8, C.pole);
  rect(c, x, y, 9, 11, C.treeDk);
  rect(c, x + 1, y, 7, 9, C.tree);
}

/**
 * 街をまるごと1枚描く。
 *
 * 🔑 施設の位置は下の `SPOTS`（％）と**必ず揃える**。
 *    ずれると、押せる場所と建物の絵が別のところにある状態になる。
 */
export function draw(canvas: HTMLCanvasElement): void {
  const c = canvas.getContext("2d");
  if (c === null) throw new Error("街を描く canvas が使えない");
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, W, H);

  sky(c);
  skyline(c);
  groundAndRoad(c);

  shoppingStreet(c, 14, 150);
  stadium(c, 164, 132);
  office(c, 386, 118);

  /* 🔴 2026-10-02 の目視確認で直した: 木と街灯を建物と同じ高さに等間隔で置いていたので、
        店先・ビルの窓の上に重なっていた（絵が読めなくなる）。
     🔑 **木は建物のすきまだけ**に置く（店 14〜142 / 競技場 164〜314 / 事務所 386〜462）。 */
  for (const tx of [148, 330, 366, 470]) tree(c, tx, 196);

  /* 🔑 街灯は**道の手前側**（道より下）に置く。手前に置けば建物と重なりようがなく、
        画面の下ぶちを締めて奥行きも出る。 */
  for (let px = 42; px < W; px += 96) {
    rect(c, px, 238, 2, 20, C.pole);
    box(c, px - 3, 232, 9, 7, C.windowLit);
  }
}

/**
 * 押せる場所。**canvas の中ではなく HTML のボタンとして重ねる**ので、
 * ここは「どこに重ねるか」（％）だけを持つ。
 * 値は上の描画位置から出している。
 */
/* 🔴 2026-10-02 の目視確認で直した: 札を建物の**真ん中**に置いていたので、
      せっかく描いた店先・芝・窓を札が覆っていた（特にサッカー場は芝の上に札）。
      → **建物の上**へ出す。札は「ここに入れる」の目印であって、建物の代わりではない。
   🔑 値は `draw()` の配置から出している。建物を動かしたらここも動かす。 */
export const SPOTS = {
  shop:    { left: 16, top: 48 },   // 店先 y=150 の上
  stadium: { left: 50, top: 41 },   // 観客席 y=132 の上（照明塔の間）
  office:  { left: 88, top: 35 },   // ビル y=118 の上
} as const;
