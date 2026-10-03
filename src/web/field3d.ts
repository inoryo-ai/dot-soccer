/**
 * サッカー場を3Dで描く（検証中・2026-10-03）。`voxel.ts` と同じカメラを使う。
 *
 * 🔴 ここもゲームの規則を持たない。**寸法は競技規則の数字**で、描き手が作らない。
 * 🔑 外部ライブラリを使わない。地面は四角形、線は細い四角形、ゴールは箱。
 *    どれも「頂点を投影して塗る」だけで足りる。
 */

import { basisOf, project, projectPoly } from "./voxel.ts";
import type { Basis, Cam, Vec3 } from "./voxel.ts";

/* ピッチの実寸（m）。競技規則の数字 */
export const PITCH_X = 105;
export const PITCH_Y = 68;
const PENALTY = { depth: 16.5, width: 40.3 };
const GOAL_AREA = { depth: 5.5, width: 18.3 };
const GOAL = { width: 7.32, height: 2.44 };
const CENTER_R = 9.15;

const C = {
  turf: "#3f9e46",
  turfAlt: "#49ad4f",
  out: "#2e7a38",
  line: "#f2faf3",
  post: "#fdfaf0",
  net: "rgba(250, 253, 250, .35)",
};

const STRIPES = 14;
const LINE_W = 0.22;        // 白線の幅（m）

type Quad = [Vec3, Vec3, Vec3, Vec3];

function fill(c: CanvasRenderingContext2D, b: Basis, cam: Cam, q: Quad,
              color: string): void {
  /* 🔴 角がカメラの後ろに出たら**切る**。捨てると芝が丸ごと消える（`projectPoly` の説明） */
  const pts = projectPoly(b, cam, q);
  if (pts === null) return;
  c.beginPath();
  c.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i]!.x, pts[i]!.y);
  c.closePath();
  c.fillStyle = color;
  c.fill();
  /* 🔑 四角形のあいだに髪の毛1本ぶんの隙間が出るので、同じ色で縁をなぞる */
  c.strokeStyle = color;
  c.lineWidth = 1;
  c.stroke();
}

const at = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

/** 地面に置く線（まっすぐ）。幅を持たせた細い四角形にする */
function line(c: CanvasRenderingContext2D, b: Basis, cam: Cam,
              x0: number, y0: number, x1: number, y1: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (LINE_W / 2);
  const ny = (dx / len) * (LINE_W / 2);
  fill(c, b, cam, [
    at(x0 + nx, y0 + ny, 0.01), at(x1 + nx, y1 + ny, 0.01),
    at(x1 - nx, y1 - ny, 0.01), at(x0 - nx, y0 - ny, 0.01),
  ], C.line);
}

/** 長方形の枠（4本の線） */
function rect(c: CanvasRenderingContext2D, b: Basis, cam: Cam,
              x0: number, y0: number, x1: number, y1: number): void {
  line(c, b, cam, x0, y0, x1, y0);
  line(c, b, cam, x1, y0, x1, y1);
  line(c, b, cam, x1, y1, x0, y1);
  line(c, b, cam, x0, y1, x0, y0);
}

/** 円。短い線をつないで描く */
function circle(c: CanvasRenderingContext2D, b: Basis, cam: Cam,
                cxm: number, cym: number, r: number): void {
  const N = 44;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    line(c, b, cam,
         cxm + Math.cos(a0) * r, cym + Math.sin(a0) * r,
         cxm + Math.cos(a1) * r, cym + Math.sin(a1) * r);
  }
}

/** ゴール。2本のポスト＋クロスバー＋ネットの面 */
function goal(c: CanvasRenderingContext2D, b: Basis, cam: Cam, gx: number,
              dir: number): void {
  const y0 = PITCH_Y / 2 - GOAL.width / 2;
  const y1 = PITCH_Y / 2 + GOAL.width / 2;
  const back = gx + dir * 1.8;      // ネットの奥行き
  const h = GOAL.height;
  /* ネット（奥の面と左右の面）。薄く塗って「空いている」ことを見せる */
  fill(c, b, cam, [at(back, y0, 0), at(back, y1, 0), at(back, y1, h), at(back, y0, h)], C.net);
  fill(c, b, cam, [at(gx, y0, 0), at(back, y0, 0), at(back, y0, h), at(gx, y0, h)], C.net);
  fill(c, b, cam, [at(gx, y1, 0), at(back, y1, 0), at(back, y1, h), at(gx, y1, h)], C.net);
  /* ポストとクロスバー。細い箱を四角形2枚で表す（見える面だけで足りる） */
  const w = 0.14;
  for (const y of [y0, y1]) {
    fill(c, b, cam, [at(gx - w, y - w, 0), at(gx + w, y - w, 0),
                     at(gx + w, y - w, h), at(gx - w, y - w, h)], C.post);
    fill(c, b, cam, [at(gx - w, y - w, 0), at(gx - w, y + w, 0),
                     at(gx - w, y + w, h), at(gx - w, y - w, h)], "#ddd8c8");
  }
  fill(c, b, cam, [at(gx - w, y0, h), at(gx - w, y1, h),
                   at(gx - w, y1, h + w * 2), at(gx - w, y0, h + w * 2)], C.post);
}

/**
 * ピッチ一式を描く。
 *
 * 🔴 **芝 → 線 → ゴール の順**。線を先に描くと芝で塗りつぶされる。
 */
export function draw(c: CanvasRenderingContext2D, cam: Cam): void {
  const b = basisOf(cam);

  /* 🔴 ピッチの外は**観客席の手前まで**しか敷かない（2026-10-03）。
        広く敷くと、先に描いたスタンドをこの一面が塗りつぶす。 */
  const M = 7.4;
  fill(c, b, cam, [at(-M, -M), at(PITCH_X + M, -M),
                   at(PITCH_X + M, PITCH_Y + M), at(-M, PITCH_Y + M)], C.out);

  /* 芝の縞。質感であって模様ではないので差は小さく */
  const sw = PITCH_X / STRIPES;
  for (let i = 0; i < STRIPES; i++) {
    const x0 = i * sw;
    fill(c, b, cam, [at(x0, 0), at(x0 + sw, 0), at(x0 + sw, PITCH_Y), at(x0, PITCH_Y)],
         i % 2 === 0 ? C.turf : C.turfAlt);
  }

  /* 外枠・ハーフライン・センターサークル */
  rect(c, b, cam, 0, 0, PITCH_X, PITCH_Y);
  line(c, b, cam, PITCH_X / 2, 0, PITCH_X / 2, PITCH_Y);
  circle(c, b, cam, PITCH_X / 2, PITCH_Y / 2, CENTER_R);

  /* 両ゴール側のペナルティエリアとゴールエリア */
  for (const side of [0, 1]) {
    const x0 = side === 0 ? 0 : PITCH_X - PENALTY.depth;
    const x1 = side === 0 ? PENALTY.depth : PITCH_X;
    rect(c, b, cam, x0, PITCH_Y / 2 - PENALTY.width / 2,
         x1, PITCH_Y / 2 + PENALTY.width / 2);
    const g0 = side === 0 ? 0 : PITCH_X - GOAL_AREA.depth;
    const g1 = side === 0 ? GOAL_AREA.depth : PITCH_X;
    rect(c, b, cam, g0, PITCH_Y / 2 - GOAL_AREA.width / 2,
         g1, PITCH_Y / 2 + GOAL_AREA.width / 2);
  }

  /* 🔑 ゴールは**奥から先に**。手前のゴールを先に描くと、奥のゴールが上に乗る */
  const camIsLeft = cam.target.x < PITCH_X / 2;
  const order = camIsLeft ? [PITCH_X, 0] : [0, PITCH_X];
  for (const gx of order) goal(c, b, cam, gx, gx === 0 ? -1 : 1);
}

/**
 * ボール。**丸い球**として描く（2026-10-03 オーナー指示で立方体から変更）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 球を「面に分ける」とは作らない
 * ─────────────────────────────────────────────────────────────
 * 箱と同じやり方（面に割って塗る）で球を作ると、なめらかに見せるには
 * 何百面も要る。ボールは画面で十数ピクセルしかないので、それは丸損。
 *
 * **輪郭は円を1つ描けば足りる**（球はどこから見ても円）。
 * 要るのは「回っていることが読めるか」だけなので、
 * **黒い面だけを3Dの点として回して**円の上に落とす。
 *
 * 🔑 黒い面の位置は**正二十面体の12頂点**。本物のサッカーボールの
 *    黒い五角形は、まさにこの12か所にある。
 * 🔑 回転は時間ではなく**進んだ距離**から出す。時間で回すと、止まっているのに
 *    回り続けて「転がっている」ように見えない。距離で回せば、止まれば止まる。
 */
const BALL_R = 0.30;        // 半径（m）。実物より大きいが、見えることを優先する

/** 黒い面の角の大きさ（球の半径に対する比）。本物の五角形はおよそこのくらい */
const PATCH = 0.34;

/** 正二十面体の12頂点（単位ベクトル）。黄金比で作る */
const PATCHES: Vec3[] = (() => {
  const g = (1 + Math.sqrt(5)) / 2;
  const n = Math.hypot(1, g);
  const out: Vec3[] = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      out.push({ x: 0, y: s1 / n, z: (s2 * g) / n });
      out.push({ x: s1 / n, y: (s2 * g) / n, z: 0 });
      out.push({ x: (s2 * g) / n, y: 0, z: s1 / n });
    }
  }
  return out;
})();

/** 単位ベクトル `a` まわりに `v` を `spin` だけ回す（ロドリゲスの式） */
function spinAround(v: Vec3, ax: number, ay: number, ca: number, sa: number): Vec3 {
  const dot = v.x * ax + v.y * ay;              // 軸の z は 0
  return {
    x: v.x * ca + ay * v.z * sa + ax * dot * (1 - ca),
    y: v.y * ca - ax * v.z * sa + ay * dot * (1 - ca),
    z: v.z * ca + (ax * v.y - ay * v.x) * sa,
  };
}

export function drawBall(c: CanvasRenderingContext2D, cam: Cam, p: Vec3,
                         spin: number, dir: number): void {
  const b = basisOf(cam);

  /* 影は地面に落とす（ボールが浮いていても足元に出す） */
  const s0 = project(b, cam, { x: p.x, y: p.y, z: 0 });
  if (s0 !== null) {
    const r0 = Math.max(2, (cam.focal / s0.d) * BALL_R * 0.9);
    c.fillStyle = "rgba(10, 40, 15, .30)";
    c.beginPath();
    c.ellipse(s0.x, s0.y, r0, r0 * 0.45, 0, 0, Math.PI * 2);
    c.fill();
  }

  const s = project(b, cam, p);
  if (s === null) return;
  const r = Math.max(2, (cam.focal / s.d) * BALL_R);

  /* 白い球。上から光が当たっている前提で、少し上寄りを明るくする */
  const g = c.createRadialGradient(s.x - r * 0.3, s.y - r * 0.4, r * 0.1,
                                   s.x, s.y, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.65, "#f3f1e8");
  g.addColorStop(1, "#b9b7ad");
  c.beginPath();
  c.arc(s.x, s.y, r, 0, Math.PI * 2);
  c.fillStyle = g;
  c.fill();

  /* 🔑 転がる軸は**進む向きと直交**する水平の軸。
        進行方向を向いたまま前へ倒れるように回す。 */
  const ax = -Math.sin(dir);
  const ay = Math.cos(dir);
  const ca = Math.cos(spin);
  const sa = Math.sin(spin);

  /* 黒い面。**球からはみ出させない**ため、円の内側だけに描く */
  c.save();
  c.beginPath();
  c.arc(s.x, s.y, r, 0, Math.PI * 2);
  c.clip();
  c.fillStyle = "#23242a";
  for (const v of PATCHES) {
    const n = spinAround(v, ax, ay, ca, sa);
    /* カメラから見て裏側（球の向こう側）なら描かない */
    const toward = -(n.x * b.fwd.x + n.y * b.fwd.y + n.z * b.fwd.z);
    if (toward <= 0.02) continue;
    const ex = n.x * b.right.x + n.y * b.right.y + n.z * b.right.z;
    const ey = n.x * b.up.x + n.y * b.up.y + n.z * b.up.z;
    const px = s.x + ex * r;
    const py = s.y - ey * r;
    /* 🔑 球のふちに行くほど**縁に向かう向きだけ**潰れて見える。
          潰さないと、ふちの面が正面と同じ大きさの丸になって球に見えない。 */
    const rot = Math.atan2(-ey, ex);
    c.beginPath();
    c.ellipse(px, py, Math.max(0.6, r * PATCH * toward), Math.max(0.6, r * PATCH),
              rot, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();

  /* ふちを締める。背景が明るいと球の輪郭が溶ける */
  c.beginPath();
  c.arc(s.x, s.y, r, 0, Math.PI * 2);
  c.strokeStyle = "rgba(32, 48, 74, .55)";
  c.lineWidth = 1;
  c.stroke();
}
