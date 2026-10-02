/**
 * サッカー場を3Dで描く（検証中・2026-10-03）。`voxel.ts` と同じカメラを使う。
 *
 * 🔴 ここもゲームの規則を持たない。**寸法は競技規則の数字**で、描き手が作らない。
 * 🔑 外部ライブラリを使わない。地面は四角形、線は細い四角形、ゴールは箱。
 *    どれも「頂点を投影して塗る」だけで足りる。
 */

import { basisOf, project } from "./voxel.ts";
import type { Basis, Cam, P2, Vec3 } from "./voxel.ts";

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
  const p: (P2 | null)[] = q.map((v) => project(b, cam, v));
  if (p.some((v) => v === null)) return;
  const pts = p as P2[];
  c.beginPath();
  c.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < 4; i++) c.lineTo(pts[i]!.x, pts[i]!.y);
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

  /* ピッチの外。端が抜けないよう広めに敷く */
  fill(c, b, cam, [at(-40, -40), at(PITCH_X + 40, -40),
                   at(PITCH_X + 40, PITCH_Y + 40), at(-40, PITCH_Y + 40)], C.out);

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
 * ボール。**転がる立方体**として描く（2026-10-03 オーナー指示）。
 *
 * 🔑 回転は時間ではなく**進んだ距離**から出す。時間で回すと、止まっているのに
 *    回り続けて「転がっている」ように見えない。距離で回せば、止まれば止まる。
 * 🔑 面ごとに明るさを変える（`voxel.ts` と同じ考え方）。でないと回っても気づけない。
 */
const BALL_R = 0.30;        // 半径（m）。実物より大きいが、見えることを優先する

const BALL_FACES: { idx: [number, number, number, number]; lit: number }[] = [
  { idx: [4, 5, 7, 6], lit: 1.00 },
  { idx: [0, 2, 3, 1], lit: 0.52 },
  { idx: [2, 6, 7, 3], lit: 0.88 },
  { idx: [1, 5, 4, 0], lit: 0.66 },
  { idx: [3, 7, 5, 1], lit: 0.80 },
  { idx: [0, 4, 6, 2], lit: 0.60 },
];

function tone(k: number): string {
  const v = Math.round(253 * k);
  const g = Math.round(250 * k);
  const b2 = Math.round(240 * k);
  return `rgb(${v}, ${g}, ${b2})`;
}

export function drawBall(c: CanvasRenderingContext2D, cam: Cam, p: Vec3,
                         spin: number, dir: number): void {
  const b = basisOf(cam);

  /* 影は地面に落とす（ボールが浮いていても足元に出す） */
  const s = project(b, cam, { x: p.x, y: p.y, z: 0 });
  if (s !== null) {
    const r0 = Math.max(2, (cam.focal / s.d) * BALL_R * 0.9);
    c.fillStyle = "rgba(10, 40, 15, .30)";
    c.beginPath();
    c.ellipse(s.x, s.y, r0, r0 * 0.45, 0, 0, Math.PI * 2);
    c.fill();
  }

  /* 🔑 転がる軸は**進む向きと直交**する水平の軸。
        進行方向を向いたまま前へ倒れるように回す。 */
  const ax = -Math.sin(dir);
  const ay = Math.cos(dir);
  const ca = Math.cos(spin);
  const sa = Math.sin(spin);

  const pts: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    const lx = (i & 1 ? 1 : -1) * BALL_R;
    const ly = (i & 2 ? 1 : -1) * BALL_R;
    const lz = (i & 4 ? 1 : -1) * BALL_R;
    /* 軸 (ax, ay, 0) まわりの回転（ロドリゲスの式。軸は単位ベクトル） */
    const dot = lx * ax + ly * ay;
    const crx = ay * lz;
    const cry = -ax * lz;
    const crz = ax * ly - ay * lx;
    pts.push({
      x: lx * ca + crx * sa + ax * dot * (1 - ca) + p.x,
      y: ly * ca + cry * sa + ay * dot * (1 - ca) + p.y,
      z: lz * ca + crz * sa + p.z,
    });
  }

  type F = { q: P2[]; d: number; lit: number };
  const faces: F[] = [];
  for (const f of BALL_FACES) {
    const q = f.idx.map((i) => project(b, cam, pts[i]!));
    if (q.some((v) => v === null)) continue;
    const qq = q as P2[];
    const area = (qq[1]!.x - qq[0]!.x) * (qq[2]!.y - qq[0]!.y)
               - (qq[2]!.x - qq[0]!.x) * (qq[1]!.y - qq[0]!.y);
    if (area <= 0) continue;
    faces.push({ q: qq, d: (qq[0]!.d + qq[1]!.d + qq[2]!.d + qq[3]!.d) / 4, lit: f.lit });
  }
  faces.sort((m, n) => n.d - m.d);
  for (const f of faces) {
    c.beginPath();
    c.moveTo(f.q[0]!.x, f.q[0]!.y);
    for (let i = 1; i < 4; i++) c.lineTo(f.q[i]!.x, f.q[i]!.y);
    c.closePath();
    c.fillStyle = tone(f.lit);
    c.fill();
    c.strokeStyle = "#20304a";
    c.lineWidth = 1;
    c.stroke();
  }
}
