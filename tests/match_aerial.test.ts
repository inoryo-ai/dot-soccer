/**
 * 浮き球・クロス・ヘディング（D-42）。
 *
 * 🔑 ボールの高さも物理で決まり、触れるかどうかも高さで決まることを確かめる（サイコロなし）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loftKick } from "../src/sim/match/aerial.ts";
import { Ball } from "../src/sim/match/ball.ts";
import { CROSSBAR_M, goalScored } from "../src/sim/match/laws.ts";
import { MatchSim, standardSetup } from "../src/sim/match/match.ts";
import type { Setup, Spawn } from "../src/sim/match/match.ts";
import { planTeam } from "../src/sim/match/team_ai.ts";

const spawn = (team: 0 | 1, x: number, y: number, role: Spawn["role"] = "MF"): Spawn =>
  ({ team, role, x, y, homeX: x, homeY: y, topSpeed: 8.8 });

describe("ボールの高さ（物理）", () => {
  test("🔴 2m から落とすと、FIFA の芝の基準（0.60〜0.85m）の高さまで跳ね返る", () => {
    const b = new Ball(0.0, 0.0);
    b.z = 2.0 + 0.11;                         // 下端が 2m
    b.kick(0.0, 0.0, -1e-6);
    let top = 0.0;
    let up = false;
    for (let i = 0; i < 40; i++) {
      b.step();
      if (b.vz > 0.0) up = true;
      if (up) top = Math.max(top, b.z - 0.11);
    }
    assert.ok(top >= 0.60 && top <= 0.85, `跳ね返った高さ ${top.toFixed(2)}m`);
  });

  test("浮かせたボールは、いつか地面に落ちて転がり、止まる", () => {
    const b = new Ball(0.0, 0.0);
    b.kick(20.0, 0.0, 10.0);
    for (let i = 0; i < 400; i++) b.step();
    assert.equal(b.z, 0.0);
    assert.equal(b.speed, 0.0);
  });

  test("狙った地点に落ちる速さで蹴れる（表で引いた速さ）", () => {
    for (const d of [20, 30, 40]) {
      const k = loftKick(d, 0.0, 0)!;
      const b = new Ball(0.0, 0.0);
      b.kick(k[0], k[1], k[2]);
      for (let i = 0; i < 200 && (i === 0 || b.z > 0.0); i++) b.step();
      assert.ok(Math.abs(b.x - d) < 1.5, `${d}m を狙って ${b.x.toFixed(1)}m に落ちた`);
    }
  });

  test("🔴 クロスバー（2.44m）より上を越えたボールは得点にならない（第1条）", () => {
    assert.equal(goalScored(105.1, 34.0, 1.0), 0);
    assert.equal(goalScored(105.1, 34.0, CROSSBAR_M + 0.5), null);
  });
});

describe("高さで触り方が変わる", () => {
  test("🔴 浮かせたパスは、間に立つ相手の頭上を越えて味方に届く（転がせばカットされる）", () => {
    const lofted = loftKick(30.0, 0.0, 1)!;   // 高めの角度で 30m 先へ
    const setup = (vz: number, vx: number): Setup => ({
      // 相手の GK と DF を受け手より奥に置く（受け手がオフサイドの位置にならないように）
      players: [spawn(0, 29.0, 34.0), spawn(0, 60.0, 34.0), spawn(1, 40.0, 34.0),
                spawn(1, 104.0, 34.0, "GK"), spawn(1, 75.0, 10.0, "DF")],
      ball: { x: 30.0, y: 34.0, vx, vy: 0.0, vz, kickedBy: 0 } as Setup["ball"],
    });
    const ground = new MatchSim(setup(0.0, 15.0));
    ground.run(4);
    assert.equal(ground.passes[0]?.result, "INTERCEPTED");
    const air = new MatchSim({ ...setup(lofted[2], lofted[0]) });
    air.ball.kick(lofted[0], lofted[1], lofted[2]);
    air.run(5);
    assert.equal(air.passes[0]?.result, "COMPLETED", "頭上を越えなかった");
  });

  test("サイドの深い位置にボールがあると、前線がゴール前へ入る（BOX）", () => {
    const sim = new MatchSim(standardSetup());
    const holder = sim.agents.find((a) => a.team === 0 && a.role === "MF")!;
    sim.ball.x = 92.0;
    sim.ball.y = 60.0;
    const plan = planTeam(0, sim.agents, sim.ball, holder);
    const box = [...plan.orders.entries()].filter(([, o]) => o.role === "BOX");
    assert.ok(box.length >= 2, "ゴール前へ入る役が出ていない");
    for (const [id] of box) assert.ok(plan.outlets.includes(id), "BOX がパスの出し先の候補に入っていない");
  });

  test("🔴 頭の高さのボールに触れた選手はヘディングする（止めずに弾く）", () => {
    // 2m の高さを水平に飛んでくるボール（重力で少し落ちる）
    // 相手の GK と DF を FW より奥に置く（FW がオフサイドの位置にならないように）
    const sim = new MatchSim({
      players: [spawn(0, 70.0, 34.0), spawn(0, 90.0, 34.0, "FW"), spawn(1, 104.0, 34.0, "GK"),
                spawn(1, 93.0, 20.0, "DF")],
      ball: { x: 85.0, y: 34.0, vx: 12.0, vy: 0.0, kickedBy: 0 },
    });
    sim.ball.z = 2.0;
    sim.ball.kick(12.0, 0.0, 1.5);
    sim.run(2);
    assert.equal(sim.headers[0], 1, "ヘディングしていない");
  });
});
