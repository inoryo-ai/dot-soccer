/**
 * サッカー場を3Dで描く（検証中・2026-10-03）。`voxel.ts` と同じカメラを使う。
 *
 * 🔴 ここもゲームの規則を持たない。**寸法は競技規則の数字**で、描き手が作らない。
 * 🔑 外部ライブラリを使わない。地面は四角形、線は細い四角形、ゴールは箱。
 *    どれも「頂点を投影して塗る」だけで足りる。
 * 🔴 乱数を引かない（D-16 の決定論）。ばらつきは**番号から決まる値**で作る（`wob`）。
 */

import { basisOf, isFrontFacing, project, projectPoly } from "./voxel.ts";
import type { Basis, Cam, P2, Vec3 } from "./voxel.ts";

/* ピッチの実寸（m）。競技規則の数字 */
export const PITCH_X = 105;
export const PITCH_Y = 68;
const PENALTY = { depth: 16.5, width: 40.3 };
const GOAL_AREA = { depth: 5.5, width: 18.3 };
const GOAL = { width: 7.32, height: 2.44 };
const CENTER_R = 9.15;
/** ゴールラインからペナルティマークまで（m）。競技規則 */
const PEN_MARK = 11;
/** コーナーアークの半径（m）。競技規則 */
const CORNER_R = 1;
/** マーク（センタースポット・ペナルティマーク）の半径（m） */
const SPOT_R = 0.11;
/** ゴールポストとクロスバーの太さ（m）。競技規則の上限が12cm */
const POST_T = 0.12;

const C = {
  turf: "#3f9e46",
  turfAlt: "#49ad4f",
  /* ピッチの外の芝（走路の手前まで）。ここから先は `stadium3d.ts` の走路が見える */
  out: "#2e7a38",
  line: "#f2faf3",
  post: "#fdfaf0",
  /* ネットを支える奥の枠。ポストより一段くすませて「別の部材」だと分かるようにする */
  frame: "#e2dcce",
  /* 🔑 ゴールの中は**暗く**塗る。網の白が読めるようになるのはここが暗いときだけ。
        半透明の白を1枚貼っていた以前の作りは、ただの曇りガラスで網には見えなかった。 */
  netIn: "rgba(14, 40, 20, .24)",
  netLine: "rgba(250, 253, 250, .60)",
};

const STRIPES = 14;         // 長さ方向の刈り込み（縞）
/** 幅方向の刈り跡。縞の中をさらに割って市松にする（刈り跡の濃淡をもう一段） */
const MOW_BANDS = 7;
const LINE_W = 0.22;        // 白線の幅（m）

/* ピッチの外に敷く芝の幅（m）。
   🔴 **広く敷かない。** 広げると、先に描いたスタンド・広告板・走路をこの一面が
      塗りつぶす（2026-10-03 に 7.4m で敷いていて走路が全部消えていた）。
   🔑 横は広告板の手前（`stadium3d.ts` の広告板が y=±1.9 に立っている）でぴったり止める。
      ゴール裏はネットが 1.8m 奥へ出るので、その分だけ広く取る。 */
const OUT_X = 3.4;
const OUT_Y = 1.9;
/** ピッチの境界の暗い縁の幅（m）。白線の外側を一段暗くして境界を立てる */
const EDGE_W = 0.9;

/** 番号から決まるばらつき。🔴 `Math.random` は使わない（同じ入力で同じ絵にする） */
const wob = (i: number, n: number): number => ((i * 2654435761) >>> 0) % n;

function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

const at = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

/** カメラから見た奥行き（m）。`voxel.ts` の `toView` と同じ計算の、奥行きだけ */
const depthOf = (b: Basis, p: Vec3): number =>
  (p.x - b.eye.x) * b.fwd.x + (p.y - b.eye.y) * b.fwd.y + (p.z - b.eye.z) * b.fwd.z;

/**
 * その場所で 1m が画面で何pxになるか。網の間引きと円の分割数に使う。
 *
 * 🔴 カメラの手前の面より近いと割り算が暴れるので、そこで止める。
 *    止めないと `Infinity` が分割数に入って、線を無限に引こうとして固まる。
 */
const SEG_NEAR = 0.25;

function pxPerMetre(b: Basis, cam: Cam, p: Vec3): number {
  const d = depthOf(b, p);
  return cam.focal / Math.max(SEG_NEAR, d);
}

function fill(c: CanvasRenderingContext2D, b: Basis, cam: Cam, poly: readonly Vec3[],
              color: string): void {
  /* 🔴 角がカメラの後ろに出たら**切る**。捨てると芝が丸ごと消える（`projectPoly` の説明） */
  const pts = projectPoly(b, cam, poly as Vec3[]);
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

/**
 * 線分を画面へ。端点がカメラの後ろに回ったら**手前の面まで縮める**（捨てない）。
 *
 * 🔴 捨てると、ゴールの前に立った瞬間に網が消える。`projectPoly` が面に対して
 *    やっているのと同じことを、線に対してもやる必要がある。
 * 🔑 `voxel.ts` の NEAR(0.2) より**少し手前**（0.25）で切る。ちょうど 0.2 に切ると
 *    `project` が「NEAR 以下」と見て null を返すので、切った意味が無くなる。
 */
function seg(b: Basis, cam: Cam, p0: Vec3, p1: Vec3): [P2, P2] | null {
  const d0 = depthOf(b, p0);
  const d1 = depthOf(b, p1);
  if (d0 <= SEG_NEAR && d1 <= SEG_NEAR) return null;
  const mix = (a: Vec3, z: Vec3, t: number): Vec3 => ({
    x: a.x + (z.x - a.x) * t,
    y: a.y + (z.y - a.y) * t,
    z: a.z + (z.z - a.z) * t,
  });
  /* 片方だけが後ろにいる場合しかここへ来ないので、分母は 0 にならない */
  const q0 = d0 > SEG_NEAR ? p0 : mix(p0, p1, (SEG_NEAR - d0) / (d1 - d0));
  const q1 = d1 > SEG_NEAR ? p1 : mix(p1, p0, (SEG_NEAR - d1) / (d0 - d1));
  const s0 = project(b, cam, q0);
  const s1 = project(b, cam, q1);
  if (s0 === null || s1 === null) return null;
  return [s0, s1];
}

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

/**
 * 円弧。短い線をつないで描く。
 *
 * 🔑 分割数は**画面での長さ**で決める。固定にすると、引いたときは細かすぎて無駄に重く、
 *    寄ったときは粗くて多角形に見える。
 */
function arc(c: CanvasRenderingContext2D, b: Basis, cam: Cam,
             cxm: number, cym: number, r: number, a0: number, a1: number): void {
  const px = pxPerMetre(b, cam, at(cxm, cym));
  const lenPx = Math.abs(a1 - a0) * r * px;
  const n = Math.max(4, Math.min(64, Math.round(lenPx / 7)));
  for (let i = 0; i < n; i++) {
    const t0 = a0 + ((a1 - a0) * i) / n;
    const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
    line(c, b, cam,
         cxm + Math.cos(t0) * r, cym + Math.sin(t0) * r,
         cxm + Math.cos(t1) * r, cym + Math.sin(t1) * r);
  }
}

/** マーク（センタースポット・ペナルティマーク）。小さい多角形で丸く見せる */
function spot(c: CanvasRenderingContext2D, b: Basis, cam: Cam,
              cxm: number, cym: number): void {
  const N = 10;
  const q: Vec3[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    q.push(at(cxm + Math.cos(a) * SPOT_R, cym + Math.sin(a) * SPOT_R, 0.012));
  }
  fill(c, b, cam, q, C.line);
}

/* ------------------------------------------------------------ ゴール */

const NET_DEPTH = 1.8;        // ゴールの奥行き（m）
/** 奥のバーの高さ（クロスバーに対する比）。本物の網は後ろへ下がりながら落ちる */
const NET_BACK = 0.62;
const NET_MESH = 0.12;        // 網の目（m）。実物に近い
/** 画面でこれを下回る間隔の網は間引く。🔴 間引かないと遠くで線が重なって**白い板**になる */
const NET_MIN_PX = 5;
/** 1枚の面に張る線の上限。寄りきったときに線を無限に増やさないための予算 */
const NET_MAX_LINES = 36;

/**
 * 四隅で作る面（双線形パッチ）。`u` `v` は 0..1。
 * 🔑 片方を固定すると**直線**になるので、台形でも格子をそのまま線で張れる。
 *    ネットの横の面はクロスバー側が高く奥が低い台形なので、平行四辺形では足りない。
 */
type Patch = readonly [Vec3, Vec3, Vec3, Vec3];

function patchAt(q: Patch, u: number, v: number): Vec3 {
  const w00 = (1 - u) * (1 - v);
  const w10 = u * (1 - v);
  const w11 = u * v;
  const w01 = (1 - u) * v;
  return {
    x: q[0].x * w00 + q[1].x * w10 + q[2].x * w11 + q[3].x * w01,
    y: q[0].y * w00 + q[1].y * w10 + q[2].y * w11 + q[3].y * w01,
    z: q[0].z * w00 + q[1].z * w10 + q[2].z * w11 + q[3].z * w01,
  };
}

const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 画面で潰れない間隔まで、2倍ずつ粗くする */
function meshStep(px: number): number {
  let step = NET_MESH;
  while (step * px < NET_MIN_PX && step < 1.2) step *= 2;
  return step;
}

/**
 * ネット1面。中を暗く塗って、その上に縦横の細い線を張る。
 *
 * 🔑 線は**1本の経路にまとめて1回で stroke する**。1本ずつ stroke すると、
 *    面あたり70回以上の描画命令になって、ゴール2つで一気に重くなる。
 */
function drawNet(c: CanvasRenderingContext2D, b: Basis, cam: Cam, q: Patch): void {
  fill(c, b, cam, q, C.netIn);

  const px = pxPerMetre(b, cam, patchAt(q, 0.5, 0.5));
  const step = meshStep(px);
  /* 台形なので、向かい合う2辺の平均を長さとして使う */
  const lenU = (dist3(q[0], q[1]) + dist3(q[3], q[2])) / 2;
  const lenV = (dist3(q[0], q[3]) + dist3(q[1], q[2])) / 2;
  const nu = Math.max(1, Math.min(NET_MAX_LINES, Math.round(lenU / step)));
  const nv = Math.max(1, Math.min(NET_MAX_LINES, Math.round(lenV / step)));

  c.beginPath();
  for (let i = 0; i <= nu; i++) {
    const s = seg(b, cam, patchAt(q, i / nu, 0), patchAt(q, i / nu, 1));
    if (s === null) continue;
    c.moveTo(s[0].x, s[0].y);
    c.lineTo(s[1].x, s[1].y);
  }
  for (let j = 0; j <= nv; j++) {
    const s = seg(b, cam, patchAt(q, 0, j / nv), patchAt(q, 1, j / nv));
    if (s === null) continue;
    c.moveTo(s[0].x, s[0].y);
    c.lineTo(s[1].x, s[1].y);
  }
  c.strokeStyle = C.netLine;
  c.lineWidth = 1;
  c.stroke();
}

/* 面の明るさ。🔑 `voxel.ts` / `stadium3d.ts` と**同じ規則**にそろえる。
   光の向きがファイルごとにずれると、同じ画面の中で立体の見え方が噛み合わなくなる。
   底面は地面に接していて見えないので持たない。 */
const FACES: { idx: [number, number, number, number]; lit: number }[] = [
  { idx: [4, 5, 7, 6], lit: 1.00 },   // 上
  { idx: [2, 6, 7, 3], lit: 0.86 },   // 前（+y）
  { idx: [1, 5, 4, 0], lit: 0.68 },   // 後（-y）
  { idx: [3, 7, 5, 1], lit: 0.78 },   // 右（+x）
  { idx: [0, 4, 6, 2], lit: 0.62 },   // 左（-x）
];

/** 1つ描く仕事。ゴールの中では**ネットと枠が入れ替わる**ので、奥行きで並べ替えて描く */
interface Item { d: number; run: () => void }

/** 箱（ポスト・クロスバー・奥の枠）の面を Item にして積む */
function pushBox(out: Item[], c: CanvasRenderingContext2D, b: Basis, cam: Cam,
                 min: Vec3, max: Vec3, color: string): void {
  const corner = (i: number): Vec3 => ({
    x: i & 1 ? max.x : min.x,
    y: i & 2 ? max.y : min.y,
    z: i & 4 ? max.z : min.z,
  });
  for (const f of FACES) {
    const q = projectPoly(b, cam, f.idx.map(corner));
    if (q === null) continue;
    /* 🔴 裏向きの面は描かない。符号は `voxel.ts` の `signedArea` の説明のとおり
          **負が表**。面の並び（idx）を他のファイルと揃えてあるので、そのまま使える。 */
    if (!isFrontFacing(q)) continue;
    let d = 0;
    for (const p of q) d += p.d;
    const col = shade(color, f.lit);
    out.push({ d: d / q.length, run: () => {
      c.beginPath();
      c.moveTo(q[0]!.x, q[0]!.y);
      for (let i = 1; i < q.length; i++) c.lineTo(q[i]!.x, q[i]!.y);
      c.closePath();
      c.fillStyle = col;
      c.fill();
      c.strokeStyle = col;
      c.lineWidth = 1;
      c.stroke();
    } });
  }
}

/**
 * ゴール1つ。2本のポスト＋クロスバー＋奥の枠＋ネット4面。
 *
 * 🔴 ネットと枠を**別々に順番で描かない**。ゴール裏にカメラが回ると、
 *    奥のネットが手前・ポストが奥になる。全部を奥行きで並べ替えてから描く。
 */
function goal(c: CanvasRenderingContext2D, b: Basis, cam: Cam, gx: number,
              dir: number): void {
  const y0 = PITCH_Y / 2 - GOAL.width / 2;
  const y1 = PITCH_Y / 2 + GOAL.width / 2;
  const back = gx + dir * NET_DEPTH;
  const h = GOAL.height;
  const hb = h * NET_BACK;          // 奥のバーの高さ
  const t = POST_T;
  const ht = t / 2;

  const items: Item[] = [];

  /* ネット。奥・左右・天井の4面。
     🔑 天井は**クロスバーから奥へ下がる台形**。水平に張ると箱になって、
        ゴールというより物置に見える。 */
  const patches: Patch[] = [
    [at(back, y0, 0), at(back, y1, 0), at(back, y1, hb), at(back, y0, hb)],
    [at(gx, y0, 0), at(back, y0, 0), at(back, y0, hb), at(gx, y0, h)],
    [at(gx, y1, 0), at(back, y1, 0), at(back, y1, hb), at(gx, y1, h)],
    [at(gx, y0, h), at(gx, y1, h), at(back, y1, hb), at(back, y0, hb)],
  ];
  for (const q of patches) {
    items.push({ d: depthOf(b, patchAt(q, 0.5, 0.5)), run: () => drawNet(c, b, cam, q) });
  }

  /* ポスト。🔑 ゴール幅 7.32m は**内側の面のあいだ**なので、柱は外へ出す */
  pushBox(items, c, b, cam, at(gx - ht, y0 - t, 0), at(gx + ht, y0, h), C.post);
  pushBox(items, c, b, cam, at(gx - ht, y1, 0), at(gx + ht, y1 + t, h), C.post);
  /* クロスバー。高さ 2.44m は**下端まで**なので、バーはその上に乗る */
  pushBox(items, c, b, cam, at(gx - ht, y0 - t, h), at(gx + ht, y1 + t, h + t), C.post);
  /* 奥の枠（支柱2本と上のバー）。これが無いとネットが空中に張ってあるように見える */
  const bt = t * 0.35;
  pushBox(items, c, b, cam, at(back - bt, y0 - t, 0), at(back + bt, y0, hb), C.frame);
  pushBox(items, c, b, cam, at(back - bt, y1, 0), at(back + bt, y1 + t, hb), C.frame);
  pushBox(items, c, b, cam, at(back - bt, y0 - t, hb), at(back + bt, y1 + t, hb + bt * 2),
          C.frame);

  /* 🔴 奥から手前へ */
  items.sort((m, n) => n.d - m.d);
  for (const it of items) it.run();
}

/* ------------------------------------------------------------ ピッチ */

/**
 * ピッチ一式を描く。
 *
 * 🔴 **外の芝 → 境界の縁 → 芝 → 線 → ゴール の順**。線を先に描くと芝で塗りつぶされる。
 */
export function draw(c: CanvasRenderingContext2D, cam: Cam): void {
  const b = basisOf(cam);

  /* ピッチの外（走路の手前まで）。`OUT_X` / `OUT_Y` の 🔴 を読むこと */
  fill(c, b, cam, [at(-OUT_X, -OUT_Y), at(PITCH_X + OUT_X, -OUT_Y),
                   at(PITCH_X + OUT_X, PITCH_Y + OUT_Y), at(-OUT_X, PITCH_Y + OUT_Y)],
       C.out);

  /* 🔑 ピッチの**外側だけ**を一段暗くして境界を立てる（2026-10-03）。
        外の芝と中の芝が近い緑のままだと、白線が消える向き（真上から・引き）で
        「どこまでが中か」が読めなくなる。暗い縁＋白線＋明るい芝の3段で境界が立つ。 */
  const edge = shade(C.out, 0.78);
  const bands: [number, number, number, number][] = [
    [-EDGE_W, -EDGE_W, PITCH_X + EDGE_W, 0],
    [-EDGE_W, PITCH_Y, PITCH_X + EDGE_W, PITCH_Y + EDGE_W],
    [-EDGE_W, 0, 0, PITCH_Y],
    [PITCH_X, 0, PITCH_X + EDGE_W, PITCH_Y],
  ];
  for (const [x0, y0, x1, y1] of bands) {
    fill(c, b, cam, [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)], edge);
  }

  /* 芝。縞（長さ方向）の中をさらに幅方向で割って市松にする。
     🔴 **差を小さく保つ。** 模様が主役になると選手とボールが読めなくなり、
        質感を上げたつもりで試合が見えなくなる（本末転倒）。
     🔑 ばらつきは `wob`（番号から決まる値）で出す。乱数だとコマごとに芝が波打つ。 */
  const sw = PITCH_X / STRIPES;
  const bh = PITCH_Y / MOW_BANDS;
  for (let i = 0; i < STRIPES; i++) {
    const base = i % 2 === 0 ? C.turf : C.turfAlt;
    for (let j = 0; j < MOW_BANDS; j++) {
      /* 市松の濃淡（±4%）＋刈り跡のわずかなむら（±0.8%） */
      const k = ((i + j) % 2 === 0 ? 1.0 : 0.96)
                + (wob(i * 31 + j * 7 + 1, 3) - 1) * 0.008;
      fill(c, b, cam,
           [at(i * sw, j * bh), at((i + 1) * sw, j * bh),
            at((i + 1) * sw, (j + 1) * bh), at(i * sw, (j + 1) * bh)],
           shade(base, k));
    }
  }

  /* 外枠・ハーフライン・センターサークル・センタースポット */
  rect(c, b, cam, 0, 0, PITCH_X, PITCH_Y);
  line(c, b, cam, PITCH_X / 2, 0, PITCH_X / 2, PITCH_Y);
  arc(c, b, cam, PITCH_X / 2, PITCH_Y / 2, CENTER_R, 0, Math.PI * 2);
  spot(c, b, cam, PITCH_X / 2, PITCH_Y / 2);

  /* 両ゴール側のペナルティエリア・ゴールエリア・ペナルティマーク・ペナルティアーク */
  for (const side of [0, 1]) {
    const x0 = side === 0 ? 0 : PITCH_X - PENALTY.depth;
    const x1 = side === 0 ? PENALTY.depth : PITCH_X;
    rect(c, b, cam, x0, PITCH_Y / 2 - PENALTY.width / 2,
         x1, PITCH_Y / 2 + PENALTY.width / 2);
    const g0 = side === 0 ? 0 : PITCH_X - GOAL_AREA.depth;
    const g1 = side === 0 ? GOAL_AREA.depth : PITCH_X;
    rect(c, b, cam, g0, PITCH_Y / 2 - GOAL_AREA.width / 2,
         g1, PITCH_Y / 2 + GOAL_AREA.width / 2);

    const mx = side === 0 ? PEN_MARK : PITCH_X - PEN_MARK;
    spot(c, b, cam, mx, PITCH_Y / 2);
    /* 🔑 ペナルティアークは**エリアの外に出た部分だけ**。半径 9.15m の円のうち、
          マークからエリアの前線（16.5m）より外側に出る角度を出して、そこだけ描く。
          全周描くとエリアの中に円が入って、別の競技の線に見える。 */
    const span = Math.acos((PENALTY.depth - PEN_MARK) / CENTER_R);
    const face = side === 0 ? 0 : Math.PI;      // エリアの外へ向く向き
    arc(c, b, cam, mx, PITCH_Y / 2, CENTER_R, face - span, face + span);
  }

  /* コーナーアーク。4隅。半径1m の四分円 */
  for (const [cxm, cym, a0] of [[0, 0, 0], [PITCH_X, 0, Math.PI / 2],
                                [PITCH_X, PITCH_Y, Math.PI],
                                [0, PITCH_Y, -Math.PI / 2]] as const) {
    arc(c, b, cam, cxm, cym, CORNER_R, a0, a0 + Math.PI / 2);
  }

  /* 🔑 ゴールは**奥から先に**。手前のゴールを先に描くと、奥のゴールが上に乗る */
  const camIsLeft = cam.target.x < PITCH_X / 2;
  const order = camIsLeft ? [PITCH_X, 0] : [0, PITCH_X];
  for (const gx of order) goal(c, b, cam, gx, gx === 0 ? -1 : 1);
}

/* ------------------------------------------------------------ ボール */

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
  /* 🔴 数でない入力は**弾く**。投影すると座標が NaN になるだけで何も描かれず、
        「ボールがどこかへ消えた」としか分からなくなる（原因まで辿れない）。
        検証ページ（`pitch3d.ts`）はこの例外を画面に出すようにしてある。 */
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    throw new Error(`ボールの位置が数でない: x=${p.x} y=${p.y} z=${p.z}`);
  }
  if (!Number.isFinite(spin) || !Number.isFinite(dir)) {
    throw new Error(`ボールの回転が数でない: spin=${spin} dir=${dir}`);
  }

  const b = basisOf(cam);

  /* 地面からの浮き（m）。置いてあるとき（z=半径）はちょうど 0 になる */
  const lift = Math.max(0, p.z - BALL_R);

  /* 影は**足元の地面**に落とす。
     🔑 高いほど**小さく薄く**する。大きさを変えないと、ボールだけが画面を上がって
        「坂を登っている」ようにしか見えず、浮いていることが伝わらない。
     🔑 落ち方は 1/(1+高さ) にする。線形だと数mで影が消えてしまい、
        ロングボールの着地点が分からなくなる（着地点を示すのが影の仕事）。 */
  const k = 1 / (1 + lift * 0.55);
  const s0 = project(b, cam, { x: p.x, y: p.y, z: 0 });
  if (s0 !== null) {
    const r0 = Math.max(1.5, (cam.focal / s0.d) * BALL_R * 0.95 * (0.42 + 0.58 * k));
    c.fillStyle = `rgba(10, 40, 15, ${(0.34 * k).toFixed(3)})`;
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
