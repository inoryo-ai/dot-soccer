/**
 * SHA-512（同期版）。
 *
 * 🔑 Python の `random.Random("文字列")` は、文字列に SHA-512 を足した値を種にする。
 *    プリセットの「生まれ持った性質」はチーム名を種にしているので、
 *    ここが無いと Python 版と同じ選手が生まれない。
 *
 * 🔴 ブラウザの `crypto.subtle.digest` は非同期で、チームの組み立て（同期）の途中では使えない。
 *    1チームに1回しか呼ばないので、BigInt で素直に書いて速さより読みやすさを取る。
 */

const MASK = (1n << 64n) - 1n;

const K: readonly bigint[] = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & MASK;

/** バイト列の SHA-512 を64バイトで返す。 */
export function sha512(message: Uint8Array): Uint8Array {
  const h: bigint[] = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  // 詰め物: 0x80、0 を並べて 112 (mod 128) バイトにそろえ、最後に128ビットの長さ
  const bitLen = BigInt(message.length) * 8n;
  const padded = new Uint8Array(Math.ceil((message.length + 17) / 128) * 128);
  padded.set(message);
  padded[message.length] = 0x80;
  for (let i = 0; i < 16; i++) {
    padded[padded.length - 1 - i] = Number((bitLen >> BigInt(8 * i)) & 0xffn);
  }

  const w: bigint[] = new Array<bigint>(80).fill(0n);
  for (let off = 0; off < padded.length; off += 128) {
    for (let t = 0; t < 16; t++) {
      let v = 0n;
      for (let b = 0; b < 8; b++) v = (v << 8n) | BigInt(padded[off + t * 8 + b]!);
      w[t] = v;
    }
    for (let t = 16; t < 80; t++) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 1n) ^ rotr(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr(w2, 19n) ^ rotr(w2, 61n) ^ (w2 >> 6n);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) & MASK;
    }
    let [a, b, c, d, e, f, g, hh] = h as [bigint, bigint, bigint, bigint,
                                         bigint, bigint, bigint, bigint];
    for (let t = 0; t < 80; t++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & MASK & g);
      const t1 = (hh + S1 + ch + K[t]! + w[t]!) & MASK;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK;
      hh = g; g = f; f = e; e = (d + t1) & MASK;
      d = c; c = b; b = a; a = (t1 + t2) & MASK;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) & MASK;
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number((h[i]! >> BigInt(56 - 8 * b)) & 0xffn);
    }
  }
  return out;
}
