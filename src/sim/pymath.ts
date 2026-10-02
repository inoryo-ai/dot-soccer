/**
 * Python の数値の細かい規則を写したもの。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 JavaScript の同名の関数と結果が違うものだけを置く
 * ─────────────────────────────────────────────────────────────
 * 試合は1ティックごとに前の結果を使って進むので、**最後の1ビットのずれ**でも
 * 数十ティック後には別の試合になる。Python 版と同じ試合を出すために、
 * 違いが出るものは全部ここで Python に合わせる。
 *
 *  - `round(x)`      … Python は偶数への丸め（0.5 → 0、1.5 → 2）。Math.round は 0.5 → 1
 *  - `round(x, n)`   … 2進数の**正確な値**を10進で丸める（2.675 → 2.67）
 *  - `f"{x:.1f}"`    … 同上。toFixed はちょうど半分のとき大きい方に寄せる
 *  - `a % b`         … Python は割る数と同じ符号になる。JS の % は割られる数の符号
 *  - `math.hypot`    … CPython 3.11 は誤差を補正する独自の計算。Math.hypot と最後のビットが違う
 *  - 文字列の大小    … Python はコードポイント順。JS の < は UTF-16 の単位順
 */

// ---------------------------------------------------------------- 丸め

/** Python の `round(x)`（整数に、偶数への丸め）。 */
export function pyRound(x: number): number {
  if (!Number.isFinite(x)) throw new Error(`丸められない値: ${x}`);
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** 浮動小数の**正確な**10進表現を、小数 n 桁で偶数への丸めをした文字列（符号は別）。 */
function exactFixed(absX: number, n: number): string {
  // absX = mant × 2^exp（mant は 53 ビット以下の整数）
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, absX);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (biased === 0) {
    exp = -1074;
  } else {
    mant |= 1n << 52n;
    exp = biased - 1075;
  }
  // 値 = digits / 10^scale（digits は整数）
  let digits: bigint;
  let scale: number;
  if (exp >= 0) {
    digits = mant << BigInt(exp);
    scale = 0;
  } else {
    digits = mant * 5n ** BigInt(-exp);
    scale = -exp;
  }
  if (scale > n) {
    const div = 10n ** BigInt(scale - n);
    let q = digits / div;
    const r = digits % div;
    const twice = r * 2n;
    if (twice > div || (twice === div && q % 2n === 1n)) q += 1n;
    digits = q;
  } else {
    digits *= 10n ** BigInt(n - scale);
  }
  let s = digits.toString();
  if (n === 0) return s;
  if (s.length <= n) s = "0".repeat(n - s.length + 1) + s;
  return `${s.slice(0, s.length - n)}.${s.slice(s.length - n)}`;
}

/** Python の `f"{x:.nf}"`。 */
export function fmtF(x: number, n: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const body = exactFixed(Math.abs(x), n);
  return neg ? `-${body}` : body;
}

/** Python の `round(x, n)`（浮動小数を返す）。 */
export function pyRoundN(x: number, n: number): number {
  return Number.parseFloat(fmtF(x, n));
}

/** Python の `f"{x:.n%}"`（100倍してから固定小数、最後に %）。 */
export function fmtPct(x: number, n: number): string {
  return `${fmtF(x * 100, n)}%`;
}

/**
 * 浮動小数を Python の `str()` / f-string の `{x}` と同じ見た目にする。
 * 整数値でも `1.0` のように小数点を付ける（`round(x, 1)` の結果を表示するとき用）。
 */
export function pyFloatStr(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x.toFixed(1)}`;
  const s = String(x);
  if (s.includes("e")) {
    // Python は 1e-05 のように指数を2桁にする
    return s.replace(/e([+-])(\d)$/, "e$10$2");
  }
  return s;
}

// ---------------------------------------------------------------- 演算

/** Python の浮動小数の `a % b`（結果は b と同じ符号）。 */
export function pyMod(a: number, b: number): number {
  let mod = a % b;
  if (mod !== 0) {
    if (b < 0 !== mod < 0) mod += b;
  } else {
    mod = b < 0 ? -0 : 0;
  }
  return mod;
}

/** Python の整数の `a // b`。 */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

// ---------------------------------------------------------------- hypot

function split(x: number): [number, number] {
  const t = x * 134217729.0; // 2^27 + 1（Veltkamp の定数）
  const hi = t - (t - x);
  return [hi, x - hi];
}

function dlMul(x: number, y: number): [number, number] {
  const [xh, xl] = split(x);
  const [yh, yl] = split(y);
  const p = xh * yh;
  const q = xh * yl + xl * yh;
  const z = p + q;
  const zz = p - z + q + xl * yl;
  return [z, zz];
}

function dlFastSum(a: number, b: number): [number, number] {
  const x = a + b;
  const z = x - a;
  return [x, b - z];
}

function frexpExp(x: number): number {
  // x = m × 2^e（0.5 <= m < 1）の e を返す。x は正の正規化数
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const biased = (buf.getUint32(0) >>> 20) & 0x7ff;
  return biased - 1022;
}

/**
 * CPython 3.11 の `math.hypot(x, y)`（`vector_norm`）。
 *
 * 🔑 2乗を誤差なしで足し、最後に1回だけ平方根を補正する。
 *    Math.hypot とは最後のビットが違うことがあり、試合が別物になる。
 */
export function hypot(x: number, y: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax === Infinity || ay === Infinity) return Infinity;
  if (Number.isNaN(ax) || Number.isNaN(ay)) return Number.NaN;
  const max = Math.max(ax, ay);
  if (max === 0) return 0;
  const maxE = frexpExp(max);
  if (maxE < -1023) {
    const DBL_MIN = 2.2250738585072014e-308;
    return DBL_MIN * hypot(ax / DBL_MIN, ay / DBL_MIN);
  }
  const scale = 2 ** -maxE;
  let csum = 1.0;
  let frac1 = 0.0;
  let frac2 = 0.0;
  for (const v of [ax, ay]) {
    const s = v * scale;
    const [prHi, prLo] = dlMul(s, s);
    const [smHi, smLo] = dlFastSum(csum, prHi);
    csum = smHi;
    frac1 += prLo;
    frac2 += smLo;
  }
  let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
  const [prHi, prLo] = dlMul(-h, h);
  const [smHi, smLo] = dlFastSum(csum, prHi);
  csum = smHi;
  frac1 += prLo;
  frac2 += smLo;
  const corr = csum - 1.0 + (frac1 + frac2);
  h += corr / (2.0 * h);
  return h / scale;
}

// ---------------------------------------------------------------- 文字列

/** 文字数（Python の `len(str)`。サロゲートペアは1文字）。 */
export function strLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Python の文字列比較（コードポイント順）。 */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Python の `str.ljust(width)`。 */
export function ljust(s: string, width: number, fill = " "): string {
  const n = strLen(s);
  return n >= width ? s : s + fill.repeat(width - n);
}

/** Python の `str.rjust(width)`。 */
export function rjust(s: string, width: number, fill = " "): string {
  const n = strLen(s);
  return n >= width ? s : fill.repeat(width - n) + s;
}

/** Python の `str.center(width)`（余りの1文字を置く側まで同じにする）。 */
export function center(s: string, width: number, fill = " "): string {
  const n = strLen(s);
  if (n >= width) return s;
  const marg = width - n;
  const left = Math.floor(marg / 2) + (marg & width & 1);
  return fill.repeat(left) + s + fill.repeat(marg - left);
}

/** Python の `f"{n:+d}"`。 */
export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

// ---------------------------------------------------------------- 平均

/** 浮動小数を正確な分数（分子, 2 の指数）にする。値 = num × 2^exp。 */
function exactParts(x: number): [bigint, number] {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const neg = hi >>> 31 === 1;
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (biased === 0) {
    exp = -1074;
  } else {
    mant |= 1n << 52n;
    exp = biased - 1075;
  }
  return [neg ? -mant : mant, exp];
}

/** 分数 p / q（q > 0）を最も近い浮動小数にする（同値は偶数側）。 */
function ratioToDouble(p: bigint, q: bigint): number {
  if (p === 0n) return 0;
  const neg = p < 0n;
  let a = neg ? -p : p;
  let b = q;
  // a/b を [2^52, 2^53) に収める指数 e を探す（a/b = m × 2^e）
  let e = a.toString(2).length - b.toString(2).length - 53;
  if (e > 0) b <<= BigInt(e);
  else a <<= BigInt(-e);
  let m = a / b;
  while (m >= 1n << 53n) {
    b <<= 1n;
    e += 1;
    m = a / b;
  }
  while (m < 1n << 52n) {
    a <<= 1n;
    e -= 1;
    m = a / b;
  }
  const r = a - m * b;
  if (r * 2n > b || (r * 2n === b && (m & 1n) === 1n)) m += 1n;
  const value = Number(m) * 2 ** e;
  return neg ? -value : value;
}

/**
 * Python の `statistics.mean`（合計を誤差なしで取り、最後に1回だけ丸める）。
 * 素直に足して割ると最後のビットが違うことがあり、表示や判定の境目でずれる。
 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("平均を取る値が無い");
  const parts = values.map(exactParts);
  const minExp = Math.min(...parts.map(([, e]) => e));
  let total = 0n;
  for (const [num, e] of parts) total += num << BigInt(e - minExp);
  const denom = BigInt(values.length);
  // 値 = total × 2^minExp / n
  if (minExp >= 0) return ratioToDouble(total << BigInt(minExp), denom);
  return ratioToDouble(total, denom << BigInt(-minExp));
}
