/**
 * 乱数と数値の規則が Python と**最後のビットまで**同じであること。
 *
 * 🔴 ここがずれると、試合はすべて別物になる（1ティックのずれが残り全部に伝わる）。
 *    試合の照合（golden.test.ts）が落ちたら、まずここを見る。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PyRandom } from "../src/sim/pyrandom.ts";
import { atan2, cos, exp, sin } from "../src/sim/detmath.ts";
import { fmtF, fmtPct, hypot, pyMod, pyRound, pyRoundN } from "../src/sim/pymath.ts";
import { golden } from "./helpers.ts";

interface RandomCase {
  seed: number | string;
  seq: {
    random: number[];
    getrandbits: number[];
    randrange5: number[];
    randint: number[];
    randint03: number[];
    uniform: number[];
    choice: string[];
    sample: string[][];
    big: number[];
  };
}

test("乱数列が Python の random.Random と一致する（整数・文字列の種）", () => {
  const cases = golden<RandomCase[]>("random");
  assert.ok(cases.length >= 9);
  for (const { seed, seq } of cases) {
    const r = new PyRandom(seed);
    const label = `seed=${JSON.stringify(seed)}`;
    assert.deepEqual(Array.from({ length: 5 }, () => r.random()), seq.random, label);
    // 🔑 64ビットの値は正解データ（JSON）を読んだ時点で丸まっているので、同じく丸めて比べる
    const bits = [1, 5, 31, 32, 33, 64].map((k) =>
      (k <= 53 ? r.getrandbits(k) : Number(r.getrandbitsBig(k))));
    assert.deepEqual(bits, seq.getrandbits, label);
    assert.deepEqual(Array.from({ length: 8 }, () => r.randrange(5)), seq.randrange5, label);
    assert.deepEqual(Array.from({ length: 8 }, () => r.randint(-28, 28)), seq.randint, label);
    assert.deepEqual(Array.from({ length: 8 }, () => r.randint(0, 3)), seq.randint03, label);
    assert.deepEqual(Array.from({ length: 4 }, () => r.uniform(-2.5, 2.5)), seq.uniform, label);
    const letters = ["a", "b", "c", "d", "e", "f", "g"];
    assert.deepEqual(Array.from({ length: 6 }, () => r.choice(letters)), seq.choice, label);
    const keys = ["k", "s", "st", "t", "p"];
    assert.deepEqual(Array.from({ length: 6 }, () => r.sample(keys, 2)), seq.sample, label);
    assert.deepEqual(Array.from({ length: 3 }, () => r.randrange(10 ** 12)), seq.big, label);
  }
});

interface MathRow {
  x: number; y: number; hypot: number; atan2: number; cos: number; sin: number; exp: number;
  mod_tau: number; round1: number; round2: number; fmt0: string; fmt1: string; fmt3: string;
  pct1: string;
}
interface TieRow {
  x: number; round0: number; round1: number; round2: number; fmt0: string; fmt1: string;
  fmt2: string;
}

test("hypot・三角関数（detmath）・剰余・丸め・書式が Python と一致する", () => {
  const { vals, ties } = golden<{ vals: MathRow[]; ties: TieRow[] }>("math");
  const tau = 2 * Math.PI;
  for (const v of vals) {
    assert.equal(hypot(v.x, v.y), v.hypot, `hypot(${v.x}, ${v.y})`);
    assert.equal(atan2(v.y, v.x), v.atan2, `atan2(${v.y}, ${v.x})`);
    assert.equal(cos(v.x), v.cos, `cos(${v.x})`);
    assert.equal(sin(v.x), v.sin, `sin(${v.x})`);
    assert.equal(exp(-Math.abs(v.x) / 10), v.exp, `exp(${v.x})`);
    assert.equal(pyMod(v.x + Math.PI, tau) - Math.PI, v.mod_tau, `mod(${v.x})`);
    assert.equal(pyRoundN(v.x, 1), v.round1, `round(${v.x}, 1)`);
    assert.equal(pyRoundN(v.x / 7, 2), v.round2, `round(${v.x}/7, 2)`);
    assert.equal(fmtF(Math.abs(v.x), 0), v.fmt0);
    assert.equal(fmtF(v.x, 1), v.fmt1);
    assert.equal(fmtF(v.x / 100, 3), v.fmt3);
    assert.equal(fmtPct(Math.abs(v.x) / 120, 1), v.pct1);
  }
  for (const t of ties) {
    assert.equal(pyRound(t.x), t.round0, `round(${t.x})`);
    assert.equal(pyRoundN(t.x, 1), t.round1, `round(${t.x}, 1)`);
    assert.equal(pyRoundN(t.x, 2), t.round2, `round(${t.x}, 2)`);
    assert.equal(fmtF(t.x, 0), t.fmt0);
    assert.equal(fmtF(t.x, 1), t.fmt1);
    assert.equal(fmtF(t.x, 2), t.fmt2);
  }
});
