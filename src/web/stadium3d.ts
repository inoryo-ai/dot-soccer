/**
 * スタジアムの周り（観客席・観客・屋根・照明塔・広告板）を3Dで描く。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ背景も3Dにするのか（2026-10-03）
 * ─────────────────────────────────────────────────────────────
 * 選手とピッチを3Dにしてカメラが自由に回るようになった時点で、
 * **背景が2Dだと破綻する**。カメラを回しても観客席が回らないので、
 * 「書き割りの前で人形が動いている」ように見える。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 速さの作り（ここを外すと一気に重くなる）
 * ─────────────────────────────────────────────────────────────
 * 観客は**1人1枚の面**しか描かない（箱の6面を描くと6倍になる）。
 * 席の段は長い箱にまとめる（1席ずつ箱にしない）。
 * 画面の外に出たものは投影した時点で捨てる。
 *
 * 🔴 ここもゲームの規則を持たない。🔑 乱数を引かない（番号から作る）。
 */

import { basisOf, isFrontFacing, project, projectPoly } from "./voxel.ts";
import type { Basis, Cam, P2, Vec3 } from "./voxel.ts";
import { PITCH_X, PITCH_Y } from "./field3d.ts";

/* ピッチの外側の余白（走路と広告板）。ここから観客席が立ち上がる */
const MARGIN = 7.5;
const TIERS = 5;            // 段の数
const TIER_D = 3.4;         // 1段の奥行き（m）
const TIER_H = 2.0;         // 1段の高さ（m）
/** 最上段の外側。ここから外壁が立ち上がる */
const OUTER = MARGIN + TIERS * TIER_D;
const WALL_T = 1.6;         // 外壁の厚み（m）
const WALL_H = TIERS * TIER_H + 3.5;   // 外壁の高さ（m）。最上段より少し高く

const C = {
  sky: ["#4ea8e6", "#86c9f0", "#bfe4f7"],
  track: "#c3573f",
  concrete: "#9aa4b6",
  concreteDk: "#6f7a8e",
  seat: "#3a4f7a",
  seatDk: "#2a3a5c",
  roof: "#2a3350",
  roofLite: "#424e74",
  beam: "#1b2238",
  tower: "#5c6678",
  lamp: "#fff6d8",
  ad: ["#2f7ed8", "#e2574c", "#f0a01e", "#f2f6fb"],
  home: ["#2f6fd6", "#5b93e4", "#f2f6fb"],
  away: ["#d8343a", "#e4686c", "#1b1b1f"],
  neutral: ["#f2c230", "#4fae5a", "#9aa3ad", "#6b4fa0", "#e9e2d0"],
  skin: ["#f3cfaa", "#e0b089", "#b37a52", "#7a4a2e"],
};

const wob = (i: number, n: number): number => ((i * 2654435761) >>> 0) % n;
const pick = <T>(a: readonly T[], i: number): T => a[wob(i, a.length)]!;

function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/* 面の明るさ。`voxel.ts` と同じ規則にそろえる（光の向きがずれると立体が崩れる） */
const FACES: { idx: [number, number, number, number]; lit: number }[] = [
  { idx: [4, 5, 7, 6], lit: 1.00 },
  { idx: [2, 6, 7, 3], lit: 0.86 },
  { idx: [1, 5, 4, 0], lit: 0.68 },
  { idx: [3, 7, 5, 1], lit: 0.78 },
  { idx: [0, 4, 6, 2], lit: 0.62 },
];

interface Face { q: P2[]; d: number; color: string }

/**
 * 箱を1つ積む。
 * @param top 上の面だけ別の色にしたいとき（段の上＝座席、側面＝コンクリート）
 */
function pushBox(out: Face[], b: Basis, cam: Cam, min: Vec3, max: Vec3,
                 color: string, top?: string): void {
  const corner = (i: number): Vec3 => ({
    x: i & 1 ? max.x : min.x,
    y: i & 2 ? max.y : min.y,
    z: i & 4 ? max.z : min.z,
  });
  for (const f of FACES) {
    const base = f.lit === 1.00 && top !== undefined ? top : color;
    /* 🔴 **切ってから描く**。観客席や走路は数十mあるので、角が1つカメラの後ろに
          入っただけで面ごと捨てると、近寄った途端にスタンドが消える */
    const q = projectPoly(b, cam, f.idx.map(corner));
    if (q === null) continue;
    if (!isFrontFacing(q)) continue;           // 裏面
    let d = 0;
    for (const p of q) d += p.d;
    out.push({ q, d: d / q.length, color: shade(base, f.lit) });
  }
}

/**
 * 観客1人。**正面の1枚だけ**描く（6面描くと6倍になる）。
 *
 * 🔑 `axis` は体の幅を伸ばす向き。南北のスタンドは x 方向、東西のスタンドは y 方向。
 *    これを間違えると、東西の観客が**真横を向いて線になる**。
 */
function pushFan(out: Face[], b: Basis, cam: Cam, x: number, y: number, z: number,
                 i: number, bob: number, side: "home" | "away",
                 axis: "x" | "y"): void {
  const w = 0.30;
  const h = 0.78 + wob(i, 3) * 0.06;
  const body = wob(i, 10) < 2 ? pick(C.neutral, i) : pick(side === "home" ? C.home : C.away, i);
  const z0 = z + bob;
  /** 幅 `r` の板を、`axis` の向きに張って z0+a から z0+b まで立てる */
  const slab = (r: number, a: number, bz: number): P2[] | null => {
    const pts: Vec3[] = axis === "x"
      ? [{ x: x - r, y, z: z0 + a }, { x: x + r, y, z: z0 + a },
         { x: x + r, y, z: z0 + bz }, { x: x - r, y, z: z0 + bz }]
      : [{ x, y: y - r, z: z0 + a }, { x, y: y + r, z: z0 + a },
         { x, y: y + r, z: z0 + bz }, { x, y: y - r, z: z0 + bz }];
    const q: (P2 | null)[] = pts.map((p) => project(b, cam, p));
    if (q.some((v) => v === null)) return null;
    return q as P2[];
  };
  const bodyQ = slab(w, 0, h);
  if (bodyQ === null) return;
  const d = (bodyQ[0]!.d + bodyQ[1]!.d + bodyQ[2]!.d + bodyQ[3]!.d) / 4;
  out.push({ q: bodyQ, d, color: body });
  const headQ = slab(w * 0.62, h, h + 0.34);
  if (headQ === null) return;
  out.push({ q: headQ, d: d - 0.01, color: pick(C.skin, i + 5) });
}

/* 席の向き: 0=南(y<0) 1=北(y>PITCH_Y) 2=西(x<0) 3=東(x>PITCH_X) */
const SIDES = [0, 1, 2, 3] as const;

/**
 * スタジアムの周りを描く。
 *
 * 🔴 **ピッチより先に呼ぶ。** 観客席はピッチの外にあるので重ならないが、
 *    屋根と照明塔は空に届くため、先に描かないと空で塗りつぶされる。
 * @param t 秒。観客の揺れに使う
 */
export function draw(c: CanvasRenderingContext2D, cam: Cam, t: number): void {
  const b = basisOf(cam);

  /* 空。3段に割る（なめらかにすると現代のUIになる） */
  const g = c.createLinearGradient(0, 0, 0, c.canvas.height);
  g.addColorStop(0, C.sky[0]!);
  g.addColorStop(0.55, C.sky[1]!);
  g.addColorStop(1, C.sky[2]!);
  c.fillStyle = g;
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);

  const faces: Face[] = [];

  /* 走路（ピッチの外周） */
  const tx0 = -MARGIN;
  const tx1 = PITCH_X + MARGIN;
  const ty0 = -MARGIN;
  const ty1 = PITCH_Y + MARGIN;
  pushBox(faces, b, cam, { x: tx0, y: ty0, z: -0.02 }, { x: tx1, y: ty1, z: 0 }, C.track);

  for (const side of SIDES) {
    const horiz = side < 2;                     // 南北＝長辺に沿う
    for (let i = 0; i < TIERS; i++) {
      const off = MARGIN + i * TIER_D;
      const zTop = (i + 1) * TIER_H;
      /* 段（コンクリートの長い箱）と、その上の席の面 */
      let min: Vec3;
      let max: Vec3;
      /* 🔴 段は**額縁**として噛み合わせる。南北の箱は、その段の外周ぶんだけ
            横に伸ばす（固定幅で伸ばすと、内側の段が東西のスタンドを突き抜けて
            ピッチの上に灰色の板が乗る。2026-10-03 の目視で発見）。 */
      const span = off + TIER_D;
      if (side === 0) {
        min = { x: -span, y: -off - TIER_D, z: 0 };
        max = { x: PITCH_X + span, y: -off, z: zTop };
      } else if (side === 1) {
        min = { x: -span, y: PITCH_Y + off, z: 0 };
        max = { x: PITCH_X + span, y: PITCH_Y + off + TIER_D, z: zTop };
      } else if (side === 2) {
        min = { x: -off - TIER_D, y: ty0, z: 0 };
        max = { x: -off, y: ty1, z: zTop };
      } else {
        min = { x: PITCH_X + off, y: ty0, z: 0 };
        max = { x: PITCH_X + off + TIER_D, y: ty1, z: zTop };
      }
      /* 🔑 側面＝コンクリート／上面＝座席。同じ色で積むと段差が読めず、
            灰色の坂が1枚あるようにしか見えない（2026-10-03 の目視） */
      pushBox(faces, b, cam, min, max, i % 2 === 0 ? C.concrete : C.concreteDk,
              i % 2 === 0 ? C.seat : C.seatDk);

      /* 観客。段の上に並べる。🔑 ホーム側とアウェー側で色の寄りを変える */
      const step = 1.25;
      if (horiz) {
        const y = side === 0 ? min.y + TIER_D * 0.45 : max.y - TIER_D * 0.45;
        for (let x = min.x + 1; x < max.x; x += step) {
          const n = Math.round(x * 7 + i * 131 + side * 17);
          if (wob(n, 12) === 0) continue;                 // 空席
          const bobA = Math.max(0, Math.sin(t * (4 + wob(n, 4)) + n)) * 0.14;
          pushFan(faces, b, cam, x, y, zTop, n, bobA,
                  x < PITCH_X / 2 ? "home" : "away", "x");
        }
      } else {
        const x = side === 2 ? min.x + TIER_D * 0.45 : max.x - TIER_D * 0.45;
        for (let y = min.y + 1; y < max.y; y += step) {
          const n = Math.round(y * 11 + i * 97 + side * 29);
          if (wob(n, 12) === 0) continue;
          const bobA = Math.max(0, Math.sin(t * (4 + wob(n, 4)) + n)) * 0.14;
          pushFan(faces, b, cam, x, y, zTop, n, bobA,
                  side === 2 ? "home" : "away", "y");
        }
      }
    }

    /* 🔴 **屋根ではなく外壁**にする（2026-10-03 の目視）。
          最上段の上に庇を張ると、支柱が無いので空中に細い梁が1本走っているだけに見え、
          しかもカメラを上げると観客を隠す。見せたいのは観客なので、
          スタンドの背中を壁で閉じて「外から見ても建物」にするほうが効く。 */
    const back = OUTER;
    if (side === 0) {
      pushBox(faces, b, cam,
              { x: -back - WALL_T, y: -back - WALL_T, z: 0 },
              { x: PITCH_X + back + WALL_T, y: -back, z: WALL_H },
              C.concreteDk, C.roofLite);
    } else if (side === 1) {
      pushBox(faces, b, cam,
              { x: -back - WALL_T, y: PITCH_Y + back, z: 0 },
              { x: PITCH_X + back + WALL_T, y: PITCH_Y + back + WALL_T, z: WALL_H },
              C.concreteDk, C.roofLite);
    } else if (side === 2) {
      pushBox(faces, b, cam,
              { x: -back - WALL_T, y: -back - WALL_T, z: 0 },
              { x: -back, y: PITCH_Y + back + WALL_T, z: WALL_H },
              C.concrete, C.roofLite);
    } else {
      pushBox(faces, b, cam,
              { x: PITCH_X + back, y: -back - WALL_T, z: 0 },
              { x: PITCH_X + back + WALL_T, y: PITCH_Y + back + WALL_T, z: WALL_H },
              C.concrete, C.roofLite);
    }
  }

  /* 広告板。ピッチをぐるりと囲むと一気に「試合会場」になる */
  for (let x = 0; x < PITCH_X; x += 6) {
    const col = pick(C.ad, Math.round(x));
    pushBox(faces, b, cam, { x, y: -2.2, z: 0 }, { x: x + 5.4, y: -1.9, z: 1.1 }, col);
    pushBox(faces, b, cam, { x, y: PITCH_Y + 1.9, z: 0 },
            { x: x + 5.4, y: PITCH_Y + 2.2, z: 1.1 }, pick(C.ad, Math.round(x) + 2));
  }

  /* 照明塔。4隅。これがあると「大きな競技場」に見える */
  const towerOut = OUTER + WALL_T + 2.5;   // 外壁のさらに外に立てる
  for (const [cxm, cym] of [[-towerOut, -towerOut], [PITCH_X + towerOut, -towerOut],
                            [-towerOut, PITCH_Y + towerOut],
                            [PITCH_X + towerOut, PITCH_Y + towerOut]]) {
    pushBox(faces, b, cam, { x: cxm! - 0.9, y: cym! - 0.9, z: 0 },
            { x: cxm! + 0.9, y: cym! + 0.9, z: 30 }, C.tower);
    pushBox(faces, b, cam, { x: cxm! - 4.5, y: cym! - 1.4, z: 30 },
            { x: cxm! + 4.5, y: cym! + 1.4, z: 34 }, C.lamp);
  }

  /* 🔴 奥から手前へ。これを飛ばすと、手前の段の裏に奥の観客が出る */
  faces.sort((m, n) => n.d - m.d);
  for (const f of faces) {
    c.beginPath();
    c.moveTo(f.q[0]!.x, f.q[0]!.y);
    for (let i = 1; i < f.q.length; i++) c.lineTo(f.q[i]!.x, f.q[i]!.y);
    c.closePath();
    c.fillStyle = f.color;
    c.fill();
    c.strokeStyle = f.color;
    c.lineWidth = 1;
    c.stroke();
  }
}
