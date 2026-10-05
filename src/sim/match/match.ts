/**
 * 新しい試合の進行（D-42・作る順 2 の段階）。
 *
 * 0.1秒ごとに: ① 選手AI（0.2秒ごと＋出来事の直後） → ② 蹴る → ③ 体を動かす
 *              → ④ ボールを動かす → ⑤ 外へ出たか → ⑥ 誰かの足が届いたか
 *
 * 🔑 パスが通るか・奪われるかは ⑥ だけで決まる。**足が届いた選手が触る**。
 *    同時に届いたら、ボールにより近い選手（同じなら並びが前の選手）。
 *
 * まだ無いもの（作る順どおり）:
 *   チームAI（陣形・局面）＝作る順 3。いまは全員が持ち場に戻るだけ。
 *   スローイン・CK・GK・オフサイド・シュート＝作る順 4〜5。
 *   いまはボールが外へ出たら、出た地点の内側に止めて、最後に触ったチームは
 *   2秒触れない（相手が拾いに行く）だけにしている。
 *
 * 🔴 乱数は一切使わない（D-42）。
 */

import { FORMATIONS } from "../model.ts";
import { hypot } from "../pymath.ts";
import { Ball } from "./ball.ts";
import { Body, topSpeed } from "./body.ts";
import { CARRY_EFFORT, decideHolder, decideOffBall } from "./player_ai.ts";
import type { Agent, HolderPlan, View } from "./player_ai.ts";
import { CONTROL_MAX_MPS, PITCH_LENGTH_M, PITCH_WIDTH_M, REACH_M } from "./reach.ts";

/** 選手AIが考え直す間隔（コマ＝0.1秒）。D-42: 0.2〜0.3秒ごと */
export const DECIDE_EVERY_TICKS = 2;
/**
 * 受けてから次に蹴れるまで・奪われないまで（コマ）。
 * 🔑 設計値（出典なし）。ボールを止めて足元に置く時間として 0.3 秒。無いと受けた瞬間に奪い返されて往復する
 */
export const FIRST_TOUCH_TICKS = 3;
/** 蹴った本人が自分の蹴ったボールに触れない時間（コマ）。無いと蹴った瞬間に自分で止める */
export const KICKER_NO_TOUCH_TICKS = 3;
/** 外へ出したチームが触れない時間（コマ） */
export const OUT_NO_TOUCH_TICKS = 20;
/** 運んでいるとき、ボールは体のこれだけ前にある（m） */
export const CARRY_AHEAD_M = 0.5;

export interface Spawn {
  team: 0 | 1;
  role: Agent["role"];
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  topSpeed: number;
}

export interface Setup {
  players: Spawn[];
  /** kickedBy: いま転がっているボールを蹴った選手の番号（パスとして数える） */
  ball: { x: number; y: number; vx?: number; vy?: number; kickedBy?: number };
}

export interface PassRecord {
  team: 0 | 1;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** 味方が受けた／相手が触った／外へ出た／蹴った本人が拾い直した */
  result: "COMPLETED" | "INTERCEPTED" | "OUT" | "SELF";
}

export class MatchSim {
  tick = 0;
  readonly ball: Ball;
  readonly agents: Agent[];
  readonly bodies: Body[];
  holder: Agent | null = null;
  /** 持っている人が蹴れる・奪われるようになるコマ */
  private settledAt = 0;
  private plan: HolderPlan | null = null;
  private lastTeam: 0 | 1 | null = null;
  private readonly noTouchUntil: number[];
  private inFlight: { team: 0 | 1; from: Agent; x: number; y: number } | null = null;
  private eventHappened = true;
  readonly passes: PassRecord[] = [];
  readonly steals: [number, number] = [0, 0];
  outs = 0;

  constructor(setup: Setup) {
    this.agents = setup.players.map((p, id) => ({
      id, team: p.team, role: p.role, body: new Body(p.x, p.y, p.topSpeed),
      homeX: p.homeX, homeY: p.homeY, aimX: p.x, aimY: p.y, effort: 0.5,
    }));
    this.bodies = this.agents.map((a) => a.body);
    this.noTouchUntil = this.agents.map(() => 0);
    this.ball = new Ball(setup.ball.x, setup.ball.y);
    this.ball.kick(setup.ball.vx ?? 0.0, setup.ball.vy ?? 0.0);
    const by = setup.ball.kickedBy;
    if (by !== undefined) {
      const from = this.agents[by]!;
      this.inFlight = { team: from.team, from, x: this.ball.x, y: this.ball.y };
      this.lastTeam = from.team;
      this.noTouchUntil[by] = KICKER_NO_TOUCH_TICKS;
    }
  }

  /** 1コマ（0.1秒）進める */
  step(): void {
    // ① 選手AI
    if (this.eventHappened || this.tick % DECIDE_EVERY_TICKS === 0) {
      this.eventHappened = false;
      const view = this.view();
      decideOffBall(view);
      if (this.holder !== null) this.plan = decideHolder(view, this.holder);
    }
    // ② 蹴る（足元に収まっていれば）
    const h = this.holder;
    if (h !== null && this.plan !== null && this.tick >= this.settledAt) {
      if (this.plan.kind === "PASS") {
        this.kick(h, this.plan.vx, this.plan.vy);
      } else {
        h.aimX = this.plan.x;
        h.aimY = this.plan.y;
        h.effort = CARRY_EFFORT;
      }
    }
    // ③ 体
    for (const a of this.agents) a.body.steerTo(a.aimX, a.aimY, a.effort);
    // ④ ボール
    if (this.holder !== null) this.carryBall(this.holder);
    else this.ball.step();
    // ⑤ 外へ出たか
    if (this.holder === null && this.isOut()) this.ballOut();
    // ⑥ 足が届いたか
    else this.resolveTouches();
    this.tick += 1;
  }

  run(seconds: number): void {
    const n = Math.round(seconds * 10);
    for (let i = 0; i < n; i++) this.step();
  }

  private view(): View {
    const blocked = new Set<number>();
    this.agents.forEach((a, i) => {
      if (this.noTouchUntil[i]! > this.tick) blocked.add(a.id);
    });
    return { agents: this.agents, bodies: this.bodies, ball: this.ball, holder: this.holder, blocked };
  }

  private kick(from: Agent, vx: number, vy: number): void {
    this.inFlight = { team: from.team, from, x: this.ball.x, y: this.ball.y };
    this.ball.kick(vx, vy);
    this.holder = null;
    this.plan = null;
    this.lastTeam = from.team;
    this.noTouchUntil[from.id] = this.tick + KICKER_NO_TOUCH_TICKS;
    this.eventHappened = true;
  }

  /** 運んでいる間、ボールは体の少し前（進んでいる向き。止まっていれば攻める向き） */
  private carryBall(h: Agent): void {
    const s = h.body.speed;
    const ux = s > 0.1 ? h.body.vx / s : (h.team === 0 ? 1.0 : -1.0);
    const uy = s > 0.1 ? h.body.vy / s : 0.0;
    this.ball.x = h.body.x + ux * CARRY_AHEAD_M;
    this.ball.y = h.body.y + uy * CARRY_AHEAD_M;
    this.ball.vx = h.body.vx;
    this.ball.vy = h.body.vy;
  }

  private isOut(): boolean {
    const b = this.ball;
    return b.x < 0.0 || b.x > PITCH_LENGTH_M || b.y < 0.0 || b.y > PITCH_WIDTH_M;
  }

  /** 🔑 作る順 4 で本物のスローイン・CK・GK に置き換える。いまは出た地点の内側に止めるだけ */
  private ballOut(): void {
    this.outs += 1;
    if (this.inFlight !== null) this.closePass("OUT", this.ball.x, this.ball.y);
    this.ball.x = Math.max(0.1, Math.min(PITCH_LENGTH_M - 0.1, this.ball.x));
    this.ball.y = Math.max(0.1, Math.min(PITCH_WIDTH_M - 0.1, this.ball.y));
    this.ball.kick(0.0, 0.0);
    if (this.lastTeam !== null) {
      for (const a of this.agents) {
        if (a.team === this.lastTeam) this.noTouchUntil[a.id] = this.tick + OUT_NO_TOUCH_TICKS;
      }
    }
    this.eventHappened = true;
  }

  private resolveTouches(): void {
    const h = this.holder;
    if (h !== null) {
      if (this.tick < this.settledAt) return;
      // 相手の足がボールに届き、しかも持っている人よりボールに近ければ奪う
      const mine = hypot(this.ball.x - h.body.x, this.ball.y - h.body.y);
      const thief = this.closestWithin(REACH_M, (a) => a.team !== h.team);
      if (thief !== null && thief.d < mine) {
        this.steals[thief.a.team] += 1;
        this.take(thief.a);
      }
      return;
    }
    if (this.ball.speed > CONTROL_MAX_MPS) return;
    const got = this.closestWithin(REACH_M, (a) => this.noTouchUntil[a.id]! <= this.tick);
    if (got === null) return;
    const f = this.inFlight;
    if (f !== null) {
      const result = got.a === f.from ? "SELF" : got.a.team === f.team ? "COMPLETED" : "INTERCEPTED";
      this.closePass(result, this.ball.x, this.ball.y);
    }
    this.take(got.a);
  }

  private closestWithin(r: number, ok: (a: Agent) => boolean): { a: Agent; d: number } | null {
    let best: { a: Agent; d: number } | null = null;
    for (const a of this.agents) {
      if (!ok(a)) continue;
      const d = hypot(this.ball.x - a.body.x, this.ball.y - a.body.y);
      if (d <= r && (best === null || d < best.d)) best = { a, d };
    }
    return best;
  }

  private take(a: Agent): void {
    this.holder = a;
    this.lastTeam = a.team;
    this.settledAt = this.tick + FIRST_TOUCH_TICKS;
    this.plan = null;
    // 🔑 止めたボールは体と同じ動きになる（足元に収める）
    this.ball.kick(a.body.vx, a.body.vy);
    this.eventHappened = true;
  }

  private closePass(result: PassRecord["result"], x: number, y: number): void {
    const f = this.inFlight!;
    this.passes.push({ team: f.team, fromX: f.x, fromY: f.y, toX: x, toY: y, result });
    this.inFlight = null;
  }
}

/**
 * フォーメーションどおりに22人を並べる（能力 speed は全員同じ）。
 * 🔑 キックオフの位置は持ち場を自陣側へ半分に縮めたところ。ボールはセンターに置いてあり、
 *    先に触れた側から始まる（作る順 4 で本物のキックオフにする）。
 */
export function standardSetup(formationA = "4-4-2", formationB = "4-4-2", speedAbility = 50): Setup {
  const players: Spawn[] = [];
  const top = topSpeed(speedAbility);
  for (const [team, formation] of [[0, formationA], [1, formationB]] as const) {
    for (const [role, fx, fy] of FORMATIONS[formation]!) {
      const hx = team === 0 ? fx * PITCH_LENGTH_M : (1.0 - fx) * PITCH_LENGTH_M;
      const hy = team === 0 ? fy * PITCH_WIDTH_M : (1.0 - fy) * PITCH_WIDTH_M;
      const kx = team === 0 ? fx * PITCH_LENGTH_M / 2.0 : PITCH_LENGTH_M - fx * PITCH_LENGTH_M / 2.0;
      players.push({ team, role, x: kx, y: hy, homeX: hx, homeY: hy, topSpeed: top });
    }
  }
  return { players, ball: { x: PITCH_LENGTH_M / 2.0, y: PITCH_WIDTH_M / 2.0 } };
}
