/**
 * 新しい試合エンジンの物理とステアリング（D-42 の作る順 1）。
 *
 * 🔑 「それっぽく動く」ではなく**現実の実測と同じに動く**ことを確かめる。
 *    数字の出典は `docs/realism-reference.md`。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { BALL_CD_FAST, BALL_CD_SLOW, Ball, DT, ballDecel, dragCoef } from "../src/sim/match/ball.ts";
import { ARRIVE_M, Body, MAX_DECEL_MPS2, TOP_SPEED_MAX_MPS, TOP_SPEED_MIN_MPS, topSpeed }
  from "../src/sim/match/body.ts";

const MATCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sim", "match");

/** 止まった状態から全力で走り、各距離を通った時刻（コマの間は直線で補う） */
function sprintSplits(body: Body, marks: number[]): number[] {
  const out: number[] = [];
  let t = 0.0;
  while (out.length < marks.length && t < 30.0) {
    const before = body.x;
    body.steerTo(10_000.0, 0.0);
    for (const m of marks.slice(out.length)) {
      if (body.x < m) break;
      out.push(t + (m - before) / (body.x - before) * DT);
    }
    t += DT;
  }
  return out;
}

describe("選手の体（ステアリング）", () => {
  test("🔴 全力疾走が代表選手の 10/20/30/40m 走と同じ時間で走る（Haugen ら 2019）", () => {
    const real = [2.01, 3.24, 4.39, 5.51];
    const got = sprintSplits(new Body(0.0, 0.0, 9.0), [10, 20, 30, 40]);
    real.forEach((r, i) => {
      assert.ok(Math.abs(got[i]! - r) <= 0.05,
                `${(i + 1) * 10}m: ${got[i]!.toFixed(2)}秒（現実 ${r}秒）`);
    });
  });

  test("最高速を超えない。最高速は現実の 28〜35 km/h の中", () => {
    for (const ability of [0, 50, 100]) {
      const b = new Body(0.0, 0.0, topSpeed(ability));
      let peak = 0.0;
      for (let i = 0; i < 150; i++) {
        b.steerTo(10_000.0, 0.0);
        peak = Math.max(peak, b.speed);
      }
      assert.ok(peak <= b.topSpeed + 1e-9, `speed=${ability}: ${peak}`);
    }
    assert.ok(TOP_SPEED_MIN_MPS * 3.6 >= 28.0 && TOP_SPEED_MAX_MPS * 3.6 <= 35.0);
  });

  test("目標の点でぴたりと止まる（行き過ぎない）", () => {
    for (const d of [3, 10, 20, 50]) {
      const b = new Body(0.0, 0.0, 9.0);
      let farthest = 0.0;
      for (let i = 0; i < 200; i++) {
        b.steerTo(d, 0.0);
        farthest = Math.max(farthest, b.x);
      }
      assert.ok(Math.abs(b.x - d) <= ARRIVE_M, `${d}m: 止まった位置 ${b.x.toFixed(2)}`);
      // 🔑 着いたとみなす範囲（ARRIVE_M）の中なら行き過ぎではない
      assert.ok(farthest - d <= ARRIVE_M, `${d}m: ${(farthest - d).toFixed(2)}m 行き過ぎた`);
      assert.ok(b.speed < 0.01, `${d}m: 止まりきっていない（${b.speed}）`);
    }
  });

  test("🔴 全速から真後ろへは急に戻れない（止まるまで 速さ÷最大減速 かかる）", () => {
    const b = new Body(0.0, 0.0, 9.0);
    b.vx = 8.0;
    let t = 0.0;
    while (b.vx > 0.0) {
      b.steerTo(-50.0, 0.0);
      t += DT;
    }
    const ideal = 8.0 / MAX_DECEL_MPS2;
    assert.ok(t >= ideal && t <= ideal + 2 * DT, `止まるまで ${t.toFixed(2)}秒（理論 ${ideal.toFixed(2)}秒）`);
  });

  test("🔴 走り抜けるモードでも、近くの真横の目標の周りを回り続けない（曲がるときは減速する）", () => {
    const b = new Body(0.0, 0.0, 9.0);
    b.vy = 8.0;                                // 全速で横へ走っているところ
    let t = 0.0;
    while (Math.hypot(b.x - 5.0, b.y) > 0.7 && t < 10.0) {
      b.steerTo(5.0, 0.0, 1.0, false);
      t += DT;
    }
    assert.ok(t < 4.0, `真横 5m の目標に ${t.toFixed(1)}秒かかった（回り続けている）`);
  });

  test("速いほど大回りになる（同じ真横への切り返しで、速い方が元の向きへ流される）", () => {
    const drift = (v: number): number => {
      const b = new Body(0.0, 0.0, 9.0);
      b.vx = v;
      for (let i = 0; i < 10; i++) b.steerTo(b.x, 100.0);
      return b.x;
    };
    assert.ok(drift(8.0) > drift(3.0) + 2.0, `8m/s: ${drift(8.0)} / 3m/s: ${drift(3.0)}`);
  });
});

describe("ボール", () => {
  test("転がって必ず止まり、強く蹴るほど遠くまで行く", () => {
    let prev = 0.0;
    for (const v of [5, 10, 15, 20, 28]) {
      const ball = new Ball(0.0, 0.0);
      ball.kick(v, 0.0);
      let n = 0;
      while (ball.speed > 0.0 && n < 1000) {
        ball.step();
        n++;
      }
      assert.equal(ball.speed, 0.0, `${v}m/s: 止まらない`);
      assert.ok(ball.x > prev, `${v}m/s: ${ball.x}m（弱く蹴ったときより近い）`);
      prev = ball.x;
    }
  });

  test("速いほど空気でよく減速する（減速＝芝の転がり＋空気）", () => {
    const loss = (v: number): number => {
      const ball = new Ball(0.0, 0.0);
      ball.kick(v, 0.0);
      ball.step();
      return (v - ball.speed) / DT;
    };
    assert.ok(Math.abs(loss(25.0) - ballDecel(25.0)) < 1e-9);
    assert.ok(loss(25.0) > loss(5.0) * 3);
  });

  test("🔑 抗力危機: 速いボールほど空気抵抗の係数が小さい（浅井ら 2007）", () => {
    assert.equal(dragCoef(8.0), BALL_CD_SLOW);
    assert.equal(dragCoef(28.0), BALL_CD_FAST);
    let prev = dragCoef(14.0);
    for (let v = 15.0; v <= 22.0; v += 0.5) {
      assert.ok(dragCoef(v) <= prev, `${v}m/s で係数が増えた`);
      prev = dragCoef(v);
    }
  });

  test("斜めに蹴っても向きは変わらない（芝はボールを曲げない）", () => {
    const ball = new Ball(10.0, 10.0);
    ball.kick(6.0, 8.0);
    for (let i = 0; i < 40; i++) ball.step();
    assert.ok(Math.abs((ball.y - 10.0) / (ball.x - 10.0) - 8.0 / 6.0) < 1e-9);
  });
});

describe("乱数（D-42: 実行のブレだけ）", () => {
  test("🔴 乱数を使うのは実行のブレ（execution.ts）だけ。判断・先読み・結果の判定は乱数を使わない", () => {
    const offenders = readdirSync(MATCH_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "execution.ts")
      .filter((f) => /pyrandom|PyRandom/.test(readFileSync(join(MATCH_DIR, f), "utf8")));
    assert.deepEqual(offenders, []);
  });

  test("同じ入力なら同じ動き（2回走らせてビットまで同じ）", () => {
    const run = (): number[] => {
      const b = new Body(3.0, 4.0, 8.7);
      const ball = new Ball(0.0, 0.0);
      ball.kick(13.0, -4.0);
      const out: number[] = [];
      for (let i = 0; i < 80; i++) {
        b.steerTo(ball.x, ball.y);
        ball.step();
        out.push(b.x, b.y, ball.x, ball.y);
      }
      return out;
    };
    assert.deepEqual(run(), run());
  });
});
