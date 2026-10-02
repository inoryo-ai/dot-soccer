/**
 * アイソメ（クォータービュー）で街を描くための土台。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 投影の決め事（ここを崩すと全部ずれる）
 * ─────────────────────────────────────────────────────────────
 * 1マス = 横32ドット × 縦16ドットの菱形（2:1）。これが**唯一の比率**。
 * 2:1 にすると、斜めの辺が「右へ2・下へ1」のきれいな階段になり、
 * ドット絵として破綻しない。3:2 や 1:1 にすると辺がガタつく。
 *
 *     画面X = 原点X + (マスX - マスY) * 16
 *     画面Y = 原点Y + (マスX + マスY) *  8 - 高さ
 *
 * 🔴 **奥から手前へ描く**（画家のアルゴリズム）。
 *    `マスX + マスY` が小さいほど奥。同じなら X の大きい方が右手前。
 *    順番を間違えると、奥の建物が手前の建物の上に乗る。
 *
 * 🔑 高さは**画面Yから引く**だけ。奥行き方向には動かさない。
 *    動かすと、足元の位置と影の位置が合わなくなる。
 */

export const TW = 32;        // 1マスの横幅（ドット）
export const TH = 16;        // 1マスの縦幅（ドット）

export interface View {
  c: CanvasRenderingContext2D;
  ox: number;
  oy: number;
}

/** マス座標 → 画面座標（マスの中心・上面） */
export function at(v: View, gx: number, gy: number, h = 0): { x: number; y: number } {
  return { x: v.ox + (gx - gy) * (TW / 2), y: v.oy + (gx + gy) * (TH / 2) - h };
}

/** 菱形を1枚塗る（地面のマス・建物の屋根） */
export function tile(v: View, gx: number, gy: number, h: number, fill: string,
                     edge?: string): void {
  const { x, y } = at(v, gx, gy, h);
  const c = v.c;
  c.beginPath();
  c.moveTo(x, y - TH / 2);
  c.lineTo(x + TW / 2, y);
  c.lineTo(x, y + TH / 2);
  c.lineTo(x - TW / 2, y);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  if (edge !== undefined) {
    c.strokeStyle = edge;
    c.lineWidth = 1;
    c.stroke();
  }
}

/**
 * 箱を1つ立てる。屋根（上面）＋左面＋右面の3枚。
 *
 * 🔑 **3面に必ず明るさの差を付ける。** 同じ色で塗ると、どれだけ高くしても
 *    平たい六角形にしか見えない。上＝明るい / 右＝中 / 左＝暗い、で光を固定する
 *    （光の向きが面ごとに変わると、建物が並んだとき立体が崩れる）。
 *
 * @param gw  奥行き方向の広さ（マス）。1なら1マスぶん
 * @param gh  横方向の広さ（マス）
 */
export function box(v: View, gx: number, gy: number, gw: number, gh: number,
                    base: number, height: number,
                    top: string, right: string, left: string, edge: string): void {
  const c = v.c;
  /* 上面の4隅（マスの外周に合わせる） */
  const n = at(v, gx, gy, base + height);                       // 奥
  const e = at(v, gx + gw, gy, base + height);                  // 右
  const s = at(v, gx + gw, gy + gh, base + height);             // 手前
  const w = at(v, gx, gy + gh, base + height);                  // 左
  const sb = at(v, gx + gw, gy + gh, base);                     // 手前の足元
  const eb = at(v, gx + gw, gy, base);
  const wb = at(v, gx, gy + gh, base);

  const face = (pts: { x: number; y: number }[], fill: string): void => {
    c.beginPath();
    c.moveTo(pts[0]!.x, pts[0]!.y);
    for (const p of pts.slice(1)) c.lineTo(p.x, p.y);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = edge;
    c.lineWidth = 1;
    c.stroke();
  };

  /* 🔑 右・左を先に、上面を最後に描く。逆だと面の境目の線が屋根に乗る */
  face([e, s, sb, eb], right);
  face([w, s, sb, wb], left);
  face([n, e, s, w], top);
}

/** 高さだけ変えた同じ箱を重ねて、段のある建物を作る */
export function slab(v: View, gx: number, gy: number, gw: number, gh: number,
                     base: number, height: number, top: string, side: string,
                     edge: string): void {
  box(v, gx, gy, gw, gh, base, height, top, side, shade(side, .78), edge);
}

/** 色を暗くする。面ごとの明るさ差を1か所で作る（ばらばらに書かない） */
export function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
