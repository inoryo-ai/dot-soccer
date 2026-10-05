/**
 * シュートと GK（D-42 の作る順 5 の一部）。
 *
 * 🔑 シュートが入るかは「通り道に足や GK の手が届くか」だけで決まる（サイコロなし）。
 *    触ったときのボールの速さで、止める・はね返る・弾くが決まる。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MatchSim } from "../src/sim/match/match.ts";
import type { Setup, Spawn } from "../src/sim/match/match.ts";
import { decideShot } from "../src/sim/match/player_ai.ts";
import { GK_ARM_M, GK_DIVE_M, REACT_S, gkReach } from "../src/sim/match/reach.ts";
import { STANDARD } from "../src/sim/match/tactics.ts";

const spawn = (team: 0 | 1, x: number, y: number, role: Spawn["role"] = "MF"): Spawn =>
  ({ team, role, x, y, homeX: x, homeY: y, topSpeed: 8.8 });

/** チーム0 の選手が (shooterX, 34) から、相手ゴール（x=105）の (105, aimY) へ speed で蹴ったところ */
function shotSetup(gk: [number, number] | null, defender: [number, number] | null,
                   aimY: number, speed = 28.0, shooterX = 90.0): Setup {
  const players = [spawn(0, shooterX - 1.0, 34.0, "FW")];
  if (gk !== null) players.push(spawn(1, gk[0], gk[1], "GK"));
  if (defender !== null) players.push(spawn(1, defender[0], defender[1], "DF"));
  const dx = 105.0 - shooterX;
  const dy = aimY - 34.0;
  const d = Math.hypot(dx, dy);
  return { players, ball: { x: shooterX, y: 34.0, vx: dx / d * speed, vy: dy / d * speed, kickedBy: 0, shot: true } };
}

describe("GK の届く範囲（PK の飛び込みの実測から）", () => {
  test("反応するまでは手の長さだけ、飛び込むと最大で手＋1.5m", () => {
    assert.equal(gkReach(REACT_S), GK_ARM_M);
    assert.equal(gkReach(5.0), GK_ARM_M + GK_DIVE_M);
    assert.ok(gkReach(REACT_S + 0.2) > GK_ARM_M && gkReach(REACT_S + 0.2) < GK_ARM_M + GK_DIVE_M);
  });
});

describe("シュートの結果は位置で決まる", () => {
  test("GK がいなければ入る", () => {
    const sim = (new MatchSim(shotSetup(null, [60.0, 10.0], 35.0)));
    sim.run(2);
    assert.equal(sim.shots[0]?.result, "GOAL");
    assert.deepEqual(sim.score, [1, 0]);
  });

  test("🔴 GK の正面へ蹴れば止められ、隅へ蹴れば届かずに入る（同じ GK・同じ速さ）", () => {
    const front = (new MatchSim(shotSetup([104.0, 34.0], null, 34.0)));
    front.run(2);
    assert.equal(front.shots[0]?.result, "SAVED");
    const corner = (new MatchSim(shotSetup([104.0, 34.0], null, 37.3, 28.0, 94.0)));
    corner.run(2);
    assert.equal(corner.shots[0]?.result, "GOAL");
  });

  test("🔴 コースに立つ相手に当たればブロック。速すぎて止められずにはね返り、誰のボールでもなくなる", () => {
    const sim = (new MatchSim(shotSetup(null, [95.0, 34.0], 34.0)));
    sim.run(0.5);
    assert.equal(sim.shots[0]?.result, "BLOCKED");
    assert.equal(sim.holder, null);
    assert.ok(sim.ball.vx < 0.0, "はね返っていない");
  });

  test("GK が自分のペナルティエリアの中で持ったボールは奪えない（第12条）", () => {
    const setup: Setup = {
      players: [spawn(0, 99.0, 34.0, "FW"), spawn(1, 103.0, 34.0, "GK")],
      ball: { x: 100.0, y: 34.0, vx: 8.0, vy: 0.0, kickedBy: 0 },
    };
    const sim = new MatchSim(setup);
    sim.run(1.5);
    assert.equal(sim.holder?.role, "GK");
    assert.equal(sim.steals[0], 0, "GK の手からボールを奪った");
  });
});

describe("撃つかの判断", () => {
  test("GK が逆側に寄っていれば、空いた側へ撃つ", () => {
    const sim = new MatchSim({
      players: [spawn(0, 92.0, 34.0, "FW"), spawn(1, 103.0, 30.5, "GK")],
      ball: { x: 93.0, y: 34.0 },
    });
    const plan = decideShot({ agents: sim.agents, bodies: sim.bodies, ball: sim.ball, holder: sim.agents[0]!,
                              blocked: new Set(), plans: sim.plans, restart: null, holderReady: true,
                              holderFor: 1.0, tactics: [STANDARD, STANDARD] }, sim.agents[0]!);
    assert.equal(plan?.kind, "SHOOT");
    assert.ok(plan!.kind === "SHOOT" && plan.vy > 0.0, "GK のいない側（y が大きい側）へ撃っていない");
  });

  test("遠すぎれば撃たない", () => {
    const sim = new MatchSim({ players: [spawn(0, 60.0, 34.0, "FW")], ball: { x: 61.0, y: 34.0 } });
    const plan = decideShot({ agents: sim.agents, bodies: sim.bodies, ball: sim.ball, holder: sim.agents[0]!,
                              blocked: new Set(), plans: sim.plans, restart: null, holderReady: true,
                              holderFor: 1.0, tactics: [STANDARD, STANDARD] }, sim.agents[0]!);
    assert.equal(plan, null);
  });
});

describe("実行のブレと入る見込み（D-42・2026-10-05 オーナー判断）", () => {
  test("🔴 ブレは技術が低いほど・速いほど・寄せられているほど大きい", async () => {
    const { directionSigma } = await import("../src/sim/match/execution.ts");
    const base = directionSigma("SHOT", 28.0, 50, Infinity);
    assert.ok(directionSigma("SHOT", 28.0, 20, Infinity) > base);
    assert.ok(directionSigma("SHOT", 28.0, 90, Infinity) < base);
    assert.ok(directionSigma("SHOT", 22.0, 50, Infinity) < base);
    assert.ok(directionSigma("SHOT", 28.0, 50, 0.5) > base);
    assert.ok(directionSigma("PASS", 28.0, 50, Infinity) < base, "パスはシュートより正確");
  });

  test("同じ種なら同じ試合、種を変えれば別の試合", async () => {
    const { standardSetup } = await import("../src/sim/match/match.ts");
    const run = (seed: number): string => {
      const sim = new MatchSim({ ...standardSetup(), seed });
      sim.run(120);
      return JSON.stringify([sim.passes.length, sim.bodies.map((b) => [b.x, b.y]), sim.ball.x]);
    };
    assert.equal(run(7), run(7));
    assert.notEqual(run(7), run(8));
  });

  test("🔴 入る見込みは、GK が空けている隅ほど高く、GK の正面しか空いていなければ低い", async () => {
    const { bestShot } = await import("../src/sim/match/player_ai.ts");
    const chanceWith = (gkY: number): number => {
      const sim = new MatchSim({
        players: [spawn(0, 91.0, 34.0, "FW"), spawn(1, 103.0, gkY, "GK")],
        ball: { x: 92.0, y: 34.0 },
      });
      return bestShot({ agents: sim.agents, bodies: sim.bodies, ball: sim.ball, holder: sim.agents[0]!,
                        blocked: new Set(), plans: sim.plans, restart: null, holderReady: true,
                              holderFor: 1.0, tactics: [STANDARD, STANDARD] },
                      sim.agents[0]!)?.chance ?? 0.0;
    };
    const centered = chanceWith(34.0);
    const offside = chanceWith(31.0);
    assert.ok(offside > centered, `GK が寄ったほうが見込みが高くない（${offside} / ${centered}）`);
    assert.ok(centered > 0.0 && centered < 1.0);
  });
});
