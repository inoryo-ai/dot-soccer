/**
 * 誰が先に触れるか・選手AIの最小形（D-42 の作る順 2）。
 *
 * 🔑 パスが通るか・カットされるかは**位置と速さだけで決まる**ことを確かめる。
 *    サイコロが無いので、同じ盤面なら必ず同じ結果になり、相手の位置を動かせば結果が変わる。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Body } from "../src/sim/match/body.ts";
import { MatchSim, standardSetup } from "../src/sim/match/match.ts";
import type { Setup, Spawn } from "../src/sim/match/match.ts";
import { PITCH_LENGTH_M, PITCH_WIDTH_M, REACH_M, firstTouch, timeToReach }
  from "../src/sim/match/reach.ts";

const spawn = (team: 0 | 1, x: number, y: number, role: Spawn["role"] = "MF"): Spawn =>
  ({ team, role, x, y, homeX: x, homeY: y, topSpeed: 8.8 });

/** 味方 (50, 34) へ、(30, 34) から 12 m/s で転がしたところ。opp があれば相手を1人置く */
function passSetup(opp: [number, number] | null): Setup {
  const players = [spawn(0, 29.0, 34.0), spawn(0, 50.0, 34.0)];
  if (opp !== null) players.push(spawn(1, opp[0], opp[1]));
  return { players, ball: { x: 30.0, y: 34.0, vx: 12.0, vy: 0.0, kickedBy: 0 } };
}

describe("走って着く時間の見積もり", () => {
  test("体を実際に走らせた時間と 0.1秒以内で合う", () => {
    for (const d of [5, 12, 20, 35]) {
      const predicted = timeToReach(new Body(0.0, 0.0, 8.8), d, 0.0);
      const b = new Body(0.0, 0.0, 8.8);
      let t = 0.0;
      while (d - b.x > REACH_M) {
        b.steerTo(1000.0, 0.0);
        t += 0.1;
      }
      assert.ok(Math.abs(predicted - t) <= 0.1, `${d}m: 見積もり ${predicted.toFixed(2)} / 実際 ${t.toFixed(2)}`);
    }
  });
});

describe("パスは位置で決まる（サイコロなし）", () => {
  test("空いている味方へのパスは通る", () => {
    const sim = new MatchSim(passSetup(null));
    sim.run(4);
    assert.equal(sim.passes[0]?.result, "COMPLETED");
    assert.equal(sim.holder?.team, 0);
  });

  test("🔴 コースに立っている相手がいればカットされる", () => {
    const sim = new MatchSim(passSetup([40.0, 34.5]));
    sim.run(4);
    assert.equal(sim.passes[0]?.result, "INTERCEPTED");
    // 🔑 カットした相手は1人きりなので、そのあと寄せてきた出し手に奪い返されることがある（それも物理で決まる）
  });

  test("🔴 同じ相手でも、コースから離れて間に合わなければ通る", () => {
    const sim = new MatchSim(passSetup([40.0, 50.0]));
    sim.run(4);
    assert.equal(sim.passes[0]?.result, "COMPLETED");
  });

  test("先読み（reach.ts）が当てた選手が、実際にも触る", () => {
    for (const opp of [[40.0, 34.5], [40.0, 50.0], [45.0, 38.0]] as [number, number][]) {
      const setup = passSetup(opp);
      const sim = new MatchSim(setup);
      const predicted = firstTouch(sim.ball, sim.bodies, new Set([0]));
      sim.run(4);
      const pass = sim.passes[0]!;
      const team = sim.agents[predicted!.who]!.team;
      assert.equal(pass.result === "COMPLETED" ? 0 : 1, team, `相手 ${opp}: 予測と実際が違う`);
    }
  });
});

describe("22人で回す", () => {
  test("同じ入力なら同じ試合（2回回してビットまで同じ）", () => {
    const run = (): unknown => {
      const sim = new MatchSim(standardSetup());
      sim.run(60);
      return { passes: sim.passes, pos: sim.bodies.map((b) => [b.x, b.y]), ball: [sim.ball.x, sim.ball.y] };
    };
    assert.deepEqual(run(), run());
  });

  test("1分回しても全員がピッチの中にいて、数が壊れない", () => {
    const sim = new MatchSim(standardSetup());
    sim.run(60);
    for (const b of sim.bodies) {
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
      assert.ok(b.x >= -1.0 && b.x <= PITCH_LENGTH_M + 1.0 && b.y >= -1.0 && b.y <= PITCH_WIDTH_M + 1.0,
                `ピッチの外: (${b.x}, ${b.y})`);
    }
    assert.ok(sim.passes.length > 0, "1分間に1本もパスが出ていない");
  });
});
