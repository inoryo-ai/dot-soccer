/**
 * 選手の顔（ドット絵）。**16×16 の格子にコードで描く。画像ファイルは持ち込まない。**
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 なぜ画像にしないのか
 * ─────────────────────────────────────────────────────────────
 * 髪20 × 顔10 × 色5 = **1000通り**。これを画像で持つと1000枚になる。
 * コードで組めば、部品は 20 + 10 + 5 = 35個で済む。
 * 色を1つ足すのも、髪型を1つ足すのも、1行足すだけ。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 誰がどの顔になるかは**名前から決まる**（保存しない）
 * ─────────────────────────────────────────────────────────────
 * セーブに顔の番号を書くと、**古いセーブと新しいセーブで形が変わる**うえに、
 * 髪型を足したときに全員の顔がずれる。名前から出せば保存するものが増えず、
 * 同じ選手はいつ見ても同じ顔になる（D-07「導出値は保存しない」と同じ考え方）。
 *
 * 🔴 乱数を引かない（D-16）。同じ名前なら必ず同じ顔。
 */

/** 格子の大きさ（ドット） */
export const W = 16;
export const H = 16;

/* ------------------------------------------------------------ 色 */

/**
 * 髪の色（5種）。
 *
 * 🔑 **隣り合う色を似せない。** 小さく出すので、近い色を並べると
 *    「同じ人が2人いる」ようにしか見えない。
 */
export const HAIR_COLORS: readonly { key: string; label: string; hex: string }[] = [
  { key: "black", label: "黒", hex: "#241d1a" },
  { key: "brown", label: "茶", hex: "#5d3a1e" },
  { key: "blond", label: "金", hex: "#d9a441" },
  { key: "red", label: "赤", hex: "#8e3a24" },
  { key: "silver", label: "銀", hex: "#9aa3ad" },
];

const SKIN = "#f2c79c";
const SKIN_SHADE = "#d8a87c";
const DARK = "#2b2118";        // 目・口・輪郭
const WHITE = "#fdfbf4";       // 白目
const COLLAR = "#f2a714";      // 襟（自チームの色）

/* ------------------------------------------------------------ 顔の形 */

/**
 * 顔つき（10種）。**目・眉・口の組み合わせ**で分ける。
 *
 * 🔑 輪郭を10通り描くより、**目鼻立ち**を変えるほうが見分けが付く。
 *    この大きさでは輪郭の差（丸顔・面長）は1〜2ドットにしかならず、
 *    並べても違いが読めない。
 *
 * - `jaw`  … 0=細い 1=ふつう 2=角ばった
 * - `eye`  … 目の形
 * - `brow` … 眉（`null` は眉なし）
 * - `mouth`… 口の形
 */
export interface FaceShape {
  label: string;
  jaw: 0 | 1 | 2;
  eye: "dot" | "wide" | "narrow" | "closed" | "sharp";
  brow: "flat" | "angry" | "worried" | null;
  mouth: "line" | "smile" | "open" | "frown";
}

export const FACE_SHAPES: readonly FaceShape[] = [
  { label: "ふつう",   jaw: 1, eye: "dot",    brow: "flat",    mouth: "line" },
  { label: "笑顔",     jaw: 1, eye: "closed", brow: "flat",    mouth: "smile" },
  { label: "鋭い",     jaw: 2, eye: "sharp",  brow: "angry",   mouth: "line" },
  { label: "おだやか", jaw: 0, eye: "wide",   brow: "flat",    mouth: "smile" },
  { label: "気弱",     jaw: 0, eye: "wide",   brow: "worried", mouth: "frown" },
  { label: "闘志",     jaw: 2, eye: "narrow", brow: "angry",   mouth: "open" },
  { label: "寡黙",     jaw: 2, eye: "narrow", brow: null,      mouth: "line" },
  { label: "陽気",     jaw: 1, eye: "wide",   brow: "flat",    mouth: "open" },
  { label: "冷静",     jaw: 1, eye: "sharp",  brow: "flat",    mouth: "line" },
  { label: "眠そう",   jaw: 0, eye: "closed", brow: "worried", mouth: "line" },
];

/* ------------------------------------------------------------ 髪型 */

/**
 * 髪型（20種）。1文字＝1ドット。`H` が髪、`.` は何も置かない。
 *
 * 🔑 **上から4行目までで差を付ける。** 小さく出すと横や後ろは潰れるので、
 *    見分けが付くのは生え際と前髪の形だけ。
 * 🔴 **5行目から下を `H` で潰さない。** 潰すと眉（6行目）と目（7〜8行目）が消えて、
 *    顔10種の意味が無くなる。横に長い髪は col 2 と 13（顔の外側）だけに置く。
 */
export const HAIR_STYLES: readonly { label: string; rows: readonly string[] }[] = [
  { label: "短髪", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H..........H.."] },
  { label: "坊主", rows: [
    "................",
    "................",
    "....HHHHHHHH....",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH.."] },
  { label: "七三", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHH.HHHH..",
    "..HHHHH......H.."] },
  { label: "ぱっつん", rows: [
    "................",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H..........H.."] },
  { label: "ツンツン", rows: [
    "...H..H..H..H...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H..........H.."] },
  { label: "モヒカン", rows: [
    ".......HH.......",
    ".......HH.......",
    "..H....HH....H..",
    "..HH...HH...HH..",
    "..HHHHHHHHHHHH..",
    "..H..........H.."] },
  { label: "ロング", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H..........H..",
    "..H..........H..",
    "..H..........H..",
    "..H..........H..",
    "..H..........H..",
    "..HH........HH..",
    "...H........H..."] },
  { label: "ポニー", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHHH.",
    "..HHHHHHHHHHHHHH",
    "..H..........H.H",
    "..............HH",
    "..............H."] },
  { label: "ツイン", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    ".HHHHHHHHHHHHHH.",
    ".HHHHHHHHHHHHHH.",
    ".HH..........HH.",
    ".HH..........HH.",
    ".HH..........HH.",
    "..H..........H.."] },
  { label: "アフロ", rows: [
    "...HHHHHHHHHH...",
    ".HHHHHHHHHHHHHH.",
    ".HHHHHHHHHHHHHH.",
    ".HHHHHHHHHHHHHH.",
    ".HHHHHHHHHHHHHH.",
    ".HH..........HH.",
    "..H..........H.."] },
  { label: "オールバック", rows: [
    "................",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H.HHHHHHHH.H..",
    "..H..........H.."] },
  { label: "ウルフ", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H..........H..",
    "..H..........H..",
    "..HH........HH..",
    "...H........H..."] },
  { label: "刈り上げ", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "...HHHHHHHHHH..."] },
  { label: "センター分け", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHH..HHHHH..",
    "..HH........HH.."] },
  { label: "ボブ", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H..........H..",
    "..H..........H..",
    "..HH........HH.."] },
  { label: "おかっぱ", rows: [
    "................",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H..........H..",
    "..H..........H..",
    "..H..........H..",
    "..H..........H.."] },
  { label: "逆立ち", rows: [
    "..H...H..H...H..",
    "..H.H.H..H.H.H..",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H..........H.."] },
  { label: "はげ", rows: [
    "................",
    "................",
    "................",
    "................",
    "..H..........H..",
    "..H..........H.."] },
  { label: "ヘアバンド", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH.."] },
  { label: "ドレッド", rows: [
    "................",
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..H.H.H..H.H.H..",
    "..H.H.H..H.H.H..",
    "..H.H.H..H.H.H.."] },
];

/* ------------------------------------------------------------ 誰の顔か */

export interface FaceSpec {
  hair: number;    // 0..19
  shape: number;   // 0..9
  color: number;   // 0..4
}

/**
 * 名前から顔を決める。**同じ名前なら必ず同じ顔**（乱数を引かない・D-16）。
 *
 * 🔑 3つの軸を**別々のかけ算**で散らす。1つのハッシュを割った余りで3つとも出すと、
 *    髪型と顔が連動して「黒髪はいつも鋭い顔」のような偏りが出る。
 */
export function faceOf(name: string): FaceSpec {
  let a = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    a ^= name.charCodeAt(i);
    a = Math.imul(a, 0x01000193) >>> 0;
  }
  const mix = (salt: number): number => {
    let v = (a ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
    v = Math.imul(v ^ (v >>> 15), 0x85ebca6b) >>> 0;
    return (v ^ (v >>> 13)) >>> 0;
  };
  return {
    hair: mix(1) % HAIR_STYLES.length,
    shape: mix(2) % FACE_SHAPES.length,
    color: mix(3) % HAIR_COLORS.length,
  };
}

/* ------------------------------------------------------------ 描く */

/**
 * 肌の輪郭。`jaw` であごの幅を変える。
 *
 * 🔑 行の割り当て: 1〜4=髪 / 5=額 / 6=眉 / 7〜8=目 / 9=頬 / 10〜11=口 /
 *    12=あご / 13=首 / 14〜15=襟。
 *    **髪（〜4行目）と眉（6行目）のあいだを1行空ける**のが肝。
 *    空けないと眉が髪に埋もれて、顔10種の差がまるごと消える（2026-10-03 に実際にそうなった）。
 */
function skinRows(jaw: 0 | 1 | 2): string[] {
  const chin = jaw === 0
    ? ["....SSSSSSSS....", ".....SSSSSS....."]   // 細い
    : jaw === 2
      ? ["..SSSSSSSSSSSS..", "...SSSSSSSSSS..."] // 角ばった
      : ["...SSSSSSSSSS...", "....SSSSSSSS...."]; // ふつう
  return [
    "................",
    ".....SSSSSS.....",
    "...SSSSSSSSSS...",
    "..SSSSSSSSSSSS..",
    "..SSSSSSSSSSSS..",
    "..SSSSSSSSSSSS..",
    "..SSSSSSSSSSSS..",
    "..SSSSSSSSSSSS..",
    "..SSSSSSSSSSSS..",
    "..SSSSSSSSSSSS..",
    "..SSSSSSSSSSSS..",
    chin[0]!,
    chin[1]!,
    "......SSSS......",
    "..CCCCCCCCCCCC..",
    ".CCCCCCCCCCCCCC.",
  ];
}

/**
 * 目・眉・口。`[列, 行, 色]` の並びで返す。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 置き場所を間違えると、顔10種の差が丸ごと消える（2026-10-03 に2回やり直した）
 * ─────────────────────────────────────────────────────────────
 * 1回目（12×12）で踏んだもの:
 *   - 眉を髪と同じ行に置いた → **髪に塗りつぶされて眉が消える**。
 *     眉は顔つきを決める一番の部品なので、消えると10種が実質3種になった
 *   - 見開いた目の白を目の**上**に置いた → 白い帯になって**包帯**に見えた
 *   - 口をあごの影の行に置いた → 影と混ざって**ひげの染み**に見えた
 *   - 細目と閉じ目をどちらも横2ドットにした → **サングラス**になって区別が付かなかった
 *
 * 🔑 12×12 では顔に使える面積が 6行×8列しかなく、どう置いても潰れた。
 *    16×16 にして、**目に2行**使えるようにしたのが解決。
 * 🔑 目は形だけでなく**左右の間隔**も変える。小さい絵では、間隔の差のほうが遠目に効く。
 */
function features(s: FaceShape): [number, number, string][] {
  const out: [number, number, string][] = [];
  const BROW = 6;
  const EYE = 7;        // 目は 7〜8 行目の2行を使う
  const MOUTH = 10;     // 口は 10〜11 行目

  /* 目。`[内側の列, 外側の列]` を左右ぶん */
  const cols: [number, number][] = s.eye === "wide"
    ? [[5, 4], [10, 11]]
    : [[5, 4], [10, 11]];
  for (const [inner, outer] of cols) {
    if (s.eye === "dot") {
      out.push([inner, EYE, DARK], [inner, EYE + 1, DARK]);
    } else if (s.eye === "wide") {
      /* 白目を2×2で敷いて、内側に瞳を置く。🔑 白は目の**隣**（上に置くと帯に見える） */
      out.push([inner, EYE, WHITE], [outer, EYE, WHITE],
               [inner, EYE + 1, WHITE], [outer, EYE + 1, WHITE],
               [inner, EYE, DARK], [inner, EYE + 1, DARK]);
    } else if (s.eye === "narrow") {
      /* 細目は**横1行だけ**。2行にすると閉じ目と同じ形になる */
      out.push([inner, EYE + 1, DARK], [outer, EYE + 1, DARK]);
    } else if (s.eye === "closed") {
      /* 閉じ目は**下がった弧**。細目と違う形にするため、内と外で段を変える */
      out.push([inner, EYE + 1, DARK], [outer, EYE, DARK]);
    } else {
      /* sharp: 目尻だけ1段上げる */
      out.push([inner, EYE + 1, DARK], [inner, EYE, DARK], [outer, EYE, DARK]);
    }
  }

  /* 眉。内側と外側のどちらを下げるかで表情が変わる */
  if (s.brow !== null) {
    for (const [inner, outer] of [[5, 4], [10, 11]] as [number, number][]) {
      if (s.brow === "flat") {
        out.push([inner, BROW, DARK], [outer, BROW, DARK]);
      } else if (s.brow === "angry") {
        out.push([inner, BROW, DARK], [outer, BROW - 1, DARK]);
      } else {
        out.push([inner, BROW - 1, DARK], [outer, BROW, DARK]);
      }
    }
  }

  /* 口。🔴 あごの影の行まで降ろさない。影と混ざって染みになる */
  if (s.mouth === "line") {
    out.push([7, MOUTH, DARK], [8, MOUTH, DARK]);
  } else if (s.mouth === "smile") {
    out.push([6, MOUTH, DARK], [7, MOUTH + 1, DARK],
             [8, MOUTH + 1, DARK], [9, MOUTH, DARK]);
  } else if (s.mouth === "open") {
    out.push([7, MOUTH, DARK], [8, MOUTH, DARK],
             [7, MOUTH + 1, DARK], [8, MOUTH + 1, DARK]);
  } else {
    out.push([6, MOUTH + 1, DARK], [7, MOUTH, DARK],
             [8, MOUTH, DARK], [9, MOUTH + 1, DARK]);
  }
  return out;
}

export interface DrawFaceOpts {
  /** 襟の色。チームの色を入れると誰のチームか分かる */
  collar?: string;
}

/**
 * 顔を1つ描く。`px` は1ドットの大きさ（画面の画素数）。
 *
 * 🔴 **整数倍でしか拡大しない。** 1.5倍のような端数にすると、
 *    1ドットが2pxの列と1pxの列に割れて、顔がゆがむ。
 *    呼ぶ側で `px` を整数にする。
 */
export function draw(c: CanvasRenderingContext2D, spec: FaceSpec,
                     x0: number, y0: number, px: number,
                     opts: DrawFaceOpts = {}): void {
  const shape = FACE_SHAPES[spec.shape % FACE_SHAPES.length]!;
  const hair = HAIR_STYLES[spec.hair % HAIR_STYLES.length]!;
  const hairHex = HAIR_COLORS[spec.color % HAIR_COLORS.length]!.hex;
  const collar = opts.collar ?? COLLAR;

  const put = (cx: number, cy: number, color: string): void => {
    c.fillStyle = color;
    c.fillRect(x0 + cx * px, y0 + cy * px, px, px);
  };

  /* ① 肌と襟 */
  const rows = skinRows(shape.jaw);
  for (let y = 0; y < H; y++) {
    const row = rows[y] ?? "";
    for (let x = 0; x < W; x++) {
      const ch = row[x];
      if (ch === "S") put(x, y, SKIN);
      else if (ch === "C") put(x, y, collar);
    }
  }
  /* 🔑 影は**あごの両端だけ**に入れる。平らなままだと「板に顔が描いてある」ように
        見えるが、行を丸ごと暗くすると口と混ざって髭の染みになる（2026-10-03 の目視）。 */
  for (let x = 0; x < W; x++) {
    const row = rows[12] ?? "";
    if (row[x] !== "S") continue;
    const edge = row[x - 1] !== "S" || row[x + 1] !== "S";
    if (edge) put(x, 12, SKIN_SHADE);
  }

  /* ② 目・眉・口（髪より先。髪は上から被せる） */
  for (const [fx, fy, color] of features(shape)) put(fx, fy, color);

  /* ③ 髪 */
  for (let y = 0; y < H; y++) {
    const row = hair.rows[y] ?? "";
    for (let x = 0; x < W; x++) {
      if (row[x] === "H") put(x, y, hairHex);
    }
  }
}

/**
 * 顔を描いた canvas を作って返す。盤の駒など、DOM に貼るとき用。
 *
 * 🔑 `image-rendering: pixelated` を要素側に付ける。付けないと、
 *    画面の拡大率が端数のときににじむ。
 */
export function toCanvas(spec: FaceSpec, px: number,
                         opts: DrawFaceOpts = {}): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = W * px;
  cv.height = H * px;
  const c = cv.getContext("2d");
  if (c === null) throw new Error("顔を描く canvas が使えない");
  c.imageSmoothingEnabled = false;
  draw(c, spec, 0, 0, px, opts);
  cv.style.imageRendering = "pixelated";
  return cv;
}
