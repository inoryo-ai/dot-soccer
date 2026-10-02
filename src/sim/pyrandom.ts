/**
 * Python の `random.Random` と**同じ乱数列**を出す乱数（メルセンヌ・ツイスタ MT19937）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ Math.random を使わないのか
 * ─────────────────────────────────────────────────────────────
 * 試合は「同じシードなら必ず同じ結果」（決定 D-08）。Math.random は種を渡せない。
 * さらに Python 版（コミット 8b126f0）と**同じシードで同じ試合**になることを
 * `tests/golden.test.ts` が固定しているので、乱数の引き方まで Python と同じにする。
 *
 * 🔑 写したのは CPython 3.11 の `_randommodule.c` と `random.py`。
 *    - 種: 整数は絶対値を32ビットずつ下から並べて init_by_array に渡す。
 *      文字列は「UTF-8 のバイト＋その SHA-512」を大きな整数にして同じことをする（version 2）
 *    - random(): 27ビットと26ビットを合わせた53ビット
 *    - randrange / randint / choice / sample: `_randbelow`（ビット数ぶん引いて、超えたら引き直す）
 */

import { sha512 } from "./sha512.ts";

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export type Seed = number | bigint | string;

function seedToBigInt(seed: Seed): bigint {
  if (typeof seed === "string") {
    const bytes = new TextEncoder().encode(seed);
    const digest = sha512(bytes);
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    for (const b of digest) n = (n << 8n) | BigInt(b);
    return n;
  }
  if (typeof seed === "number") {
    if (!Number.isInteger(seed)) {
      // Python は float の種を hash() で整数にする。ここでは使わないので拒む
      throw new Error(`整数か文字列の種だけを受け付ける: ${seed}`);
    }
    return BigInt(seed);
  }
  return seed;
}

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: Seed) {
    this.seed(seed);
  }

  seed(seed: Seed): void {
    let n = seedToBigInt(seed);
    if (n < 0n) n = -n;
    const key: number[] = [];
    while (n > 0n) {
      key.push(Number(n & 0xffffffffn));
      n >>= 32n;
    }
    if (key.length === 0) key.push(0);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1]!;
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1]!;
      mt[i] = ((mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1]!;
      mt[i] = ((mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  /** 32ビットの乱数（0〜2^32-1）。 */
  genrandUint32(): number {
    const mt = this.mt;
    let y: number;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = (mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK);
      mt[N - 1] = mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** [0, 1) の浮動小数（53ビット）。Python の `random()` と同じ値。 */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** k ビットの乱数。53ビット以下なら number、それより大きければ bigint。 */
  getrandbits(k: number): number {
    if (k < 0 || k > 53 || !Number.isInteger(k)) {
      throw new Error(`getrandbits は 0〜53 ビットだけ（${k}）。大きい値は getrandbitsBig を使う`);
    }
    if (k === 0) return 0;
    if (k <= 32) return this.genrandUint32() >>> (32 - k);
    // 下の32ビットから順に詰める（CPython と同じ順）
    const lo = this.genrandUint32();
    const hi = this.genrandUint32() >>> (64 - k);
    return lo + hi * 4294967296;
  }

  getrandbitsBig(k: number): bigint {
    if (k <= 32) return BigInt(this.genrandUint32() >>> (32 - k));
    let result = 0n;
    let shift = 0n;
    let remaining = k;
    while (remaining > 0) {
      let r = this.genrandUint32();
      if (remaining < 32) r >>>= 32 - remaining;
      result |= BigInt(r) << shift;
      shift += 32n;
      remaining -= 32;
    }
    return result;
  }

  /** 0 以上 n 未満の整数（Python の `_randbelow_with_getrandbits`）。 */
  randbelow(n: number): number {
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`randbelow の範囲が不正: ${n}`);
    }
    const k = bitLength(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** Python の `randrange(stop)` / `randrange(start, stop)`（step は使わない）。 */
  randrange(start: number, stop?: number): number {
    if (stop === undefined) {
      if (start <= 0) throw new Error("randrange の範囲が空");
      return this.randbelow(start);
    }
    const width = stop - start;
    if (width <= 0) throw new Error(`randrange の範囲が空: (${start}, ${stop})`);
    return start + this.randbelow(width);
  }

  /** a 以上 b 以下の整数。 */
  randint(a: number, b: number): number {
    return this.randrange(a, b + 1);
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) throw new Error("空の列からは選べない");
    return seq[this.randbelow(seq.length)]!;
  }

  /** Python 3.11 の `sample(population, k)`。 */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (k < 0 || k > n) throw new Error("標本の数が母集団より大きいか、負");
    const result: T[] = new Array<T>(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = population.slice();
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j]!;
        pool[j] = pool[n - i - 1]!;
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (selected.has(j)) j = this.randbelow(n);
        selected.add(j);
        result[i] = population[j]!;
      }
    }
    return result;
  }

  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const tmp = x[i]!;
      x[i] = x[j]!;
      x[j] = tmp;
    }
  }
}

/** n を表すのに要るビット数（Python の `int.bit_length()`）。n は 0 以上の安全な整数。 */
export function bitLength(n: number): number {
  if (n === 0) return 0;
  if (n <= 0xffffffff) return 32 - Math.clz32(n);
  return 32 + bitLength(Math.floor(n / 4294967296));
}
