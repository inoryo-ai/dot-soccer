/**
 * どの環境でも**同じビット**を返す sin / cos / atan2 / exp。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ Math.sin などを使わないのか
 * ─────────────────────────────────────────────────────────────
 * Math.sin の最後のビットは**ブラウザ（JS エンジン）ごとに違う**。
 * Python の math.sin も OS の数学ライブラリ次第で、macOS では約15%の値が
 * 正しく丸めた値と1ビット違っていた（2026-10-02 実測）。
 * 試合は1ティックのずれが残り全部に伝わるので、これでは
 * 「同じシードなら必ず同じ試合」（決定 D-08）が環境をまたいで守れない。
 *
 * 🔑 だから四則演算と平方根（どの環境でも結果が1つに決まる）だけで計算する。
 *    計算の手順は fdlibm（Sun が公開した数学ライブラリ）の考え方に沿い、
 *    誤差は1ビット程度（`tests/detmath.test.ts` が高精度の値と比べて確かめる）。
 *
 * 🔴 正解データ（`tests/golden/`）は、**一字一句同じ手順**の Python 版
 *    （コミット 2dbe331 の `tools/detmath.py`）を Python のエンジンに差し込んで作った。
 *    ここの手順を変えると、正解データと照合できなくなる（`tests/golden/README.md`）。
 */

// --------------------------------------------------------------- 定数
// 円周率/2 を33ビットずつに分けたもの（掛け算が誤差なしで済むように）
const PIO2_1 = 1.5707963267341256;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_2T = 2.0222662487959506e-21;
const PIO2_3 = 2.0222662487111665e-21;
const PIO2_3T = 8.4784276603689e-32;
const INVPIO2 = 0.6366197723675814;
const PIO4 = 0.7853981633974483;
const PIO2 = 1.5707963267948966;
const PI = 3.141592653589793;
const PI_LO = 1.2246467991473532e-16;

// sin / cos の多項式（fdlibm の __kernel_sin / __kernel_cos）
const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

// atan の表と多項式（fdlibm の s_atan.c）
const ATAN_HI = [0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966];
const ATAN_LO = [
  2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17,
];
const AT0 = 3.33333333333329318027e-01;
const AT1 = -1.99999999998764832476e-01;
const AT2 = 1.42857142725034663711e-01;
const AT3 = -1.11111104054623557880e-01;
const AT4 = 9.09088713343650656196e-02;
const AT5 = -7.69187620504482999495e-02;
const AT6 = 6.66107313738753120669e-02;
const AT7 = -5.83357013379057348645e-02;
const AT8 = 4.97687799461593236017e-02;
const AT9 = -3.65315727442169155270e-02;
const AT10 = 1.62858201153657823623e-02;

// exp（fdlibm の e_exp.c）
const LN2HI = 0.6931471803691238;
const LN2LO = 1.9082149292705877e-10;
const INVLN2 = 1.4426950408889634;
const P1 = 1.66666666666666019037e-01;
const P2 = -2.77777777770155933842e-03;
const P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06;
const P5 = 4.13813679705723846039e-08;

// 引数の縮約をこの範囲までしか行わない（試合の向きの値はこれより十分小さい）
const REDUCE_LIMIT = 823549.6;   // 2^19 × π/2

// --------------------------------------------------------------- 部品

// 🔑 1試合で数十万回呼ばれる。作業用の領域は1つだけ持ち、戻り値も配列で返さない
const SCRATCH = new DataView(new ArrayBuffer(8));
let RY0 = 0.0;   // remPio2 の結果（x - n×π/2 の上位）
let RY1 = 0.0;   // 同じく下位

/** 2^k（k は整数）。掛け算1回で誤差なしに作る。 */
function pow2(k: number): number {
  if (k > 1023) return pow2(1023) * pow2(k - 1023);
  if (k < -1022) return pow2(-1022) * pow2(k + 1022);
  SCRATCH.setUint32(0, (k + 1023) << 20);
  SCRATCH.setUint32(4, 0);
  return SCRATCH.getFloat64(0);
}

/** 2進数の指数部（x = m × 2^e、1 <= m < 2 の e）。0 は -1023 扱い。 */
function exponentOf(x: number): number {
  SCRATCH.setFloat64(0, x);
  return ((SCRATCH.getUint32(0) >>> 20) & 0x7ff) - 1023;
}

/** x - n×π/2 を2つの浮動小数 (RY0 + RY1) に置き、n を返す。 */
function remPio2(x: number): number {
  const t = Math.abs(x);
  if (t <= PIO4) {
    RY0 = x;
    RY1 = 0.0;
    return 0;
  }
  if (t > REDUCE_LIMIT) {
    throw new Error(`角度が大きすぎる（${x}）。試合の中では起きないはずの値`);
  }
  const n = Math.floor(t * INVPIO2 + 0.5);
  // 3段に分けて n×π/2 を引く。各段の掛け算は誤差なし（33ビット × 20ビット未満）
  let r = t - n * PIO2_1;
  let w = n * PIO2_2;
  const r1 = r;
  r = r1 - w;
  w = n * PIO2_2T - ((r1 - r) - w);
  const r2 = r;
  w = n * PIO2_3;
  r = r2 - w;
  w = n * PIO2_3T - ((r2 - r) - w);
  const y0 = r - w;
  const y1 = (r - y0) - w;
  if (x < 0) {
    RY0 = -y0;
    RY1 = -y1;
    return -n;
  }
  RY0 = y0;
  RY1 = y1;
  return n;
}

function kernelSin(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

function kernelCos(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  const v = 1.0 - hz;
  return v + (((1.0 - v) - hz) + (z * r - x * y));
}

function quadrant(n: number): number {
  return ((n % 4) + 4) % 4;
}

// --------------------------------------------------------------- 公開する関数

export function sin(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const n = remPio2(x);
  switch (quadrant(n)) {
    case 0: return kernelSin(RY0, RY1);
    case 1: return kernelCos(RY0, RY1);
    case 2: return -kernelSin(RY0, RY1);
    default: return -kernelCos(RY0, RY1);
  }
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const n = remPio2(x);
  switch (quadrant(n)) {
    case 0: return kernelCos(RY0, RY1);
    case 1: return -kernelSin(RY0, RY1);
    case 2: return -kernelCos(RY0, RY1);
    default: return kernelSin(RY0, RY1);
  }
}

export function atan(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const ax = Math.abs(x);
  if (ax >= 7.378697629483821e19) {         // 2^66 以上
    return x > 0 ? ATAN_HI[3]! + ATAN_LO[3]! : -(ATAN_HI[3]! + ATAN_LO[3]!);
  }
  let id: number;
  let v: number;
  if (ax < 0.4375) {
    if (ax < 7.450580596923828e-9) return x;  // 2^-27 未満
    id = -1;
    v = x;
  } else if (ax < 0.6875) {
    id = 0;
    v = (2.0 * ax - 1.0) / (2.0 + ax);
  } else if (ax < 1.1875) {
    id = 1;
    v = (ax - 1.0) / (ax + 1.0);
  } else if (ax < 2.4375) {
    id = 2;
    v = (ax - 1.5) / (1.0 + 1.5 * ax);
  } else {
    id = 3;
    v = -1.0 / ax;
  }
  const z = v * v;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return v - v * (s1 + s2);
  const r = ATAN_HI[id]! - ((v * (s1 + s2) - ATAN_LO[id]!) - v);
  return x < 0 ? -r : r;
}

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === 1.0) return atan(y);
  const yNeg = y < 0 || Object.is(y, -0);
  const xNeg = x < 0 || Object.is(x, -0);
  if (y === 0) {
    if (!xNeg) return y;
    return yNeg ? -PI : PI;
  }
  if (x === 0) return yNeg ? -PIO2 : PIO2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    // 試合の中では起きない。起きたら Math に任せる（どの環境でも同じ値になる場合だけ）
    return Math.atan2(y, x);
  }
  const k = exponentOf(Math.abs(y)) - exponentOf(Math.abs(x));
  let z: number;
  let yPos = !yNeg;
  let xPos = !xNeg;
  if (k > 60) {
    z = PIO2 + 0.5 * PI_LO;
    xPos = true;                              // 符号は y だけで決まる
  } else if (xNeg && k < -60) {
    z = 0.0;
  } else {
    z = atan(Math.abs(y / x));
  }
  if (xPos) return yPos ? z : -z;
  yPos = !yNeg;
  return yPos ? PI - (z - PI_LO) : (z - PI_LO) - PI;
}

export function exp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0.0;
  const ax = Math.abs(x);
  if (ax < 3.725290298461914e-9) return 1.0 + x;  // 2^-28 未満
  let k = 0;
  let hi = x;
  let lo = 0.0;
  let r = x;
  if (ax > 0.34657359027997264) {                // 0.5 × ln2 より大きい
    k = Math.trunc(INVLN2 * x + (x < 0 ? -0.5 : 0.5));
    hi = x - k * LN2HI;                         // k × LN2HI は誤差なし
    lo = k * LN2LO;
    r = hi - lo;
  }
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1.0 - ((r * c) / (c - 2.0) - r);
  const y = 1.0 - ((lo - (r * c) / (2.0 - c)) - hi);
  return y * pow2(k);
}

export const TAU = 2 * PI;
export { PI };
