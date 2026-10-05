/**
 * 新しい試合の進行（D-42・作る順 4 の段階）。
 *
 * 0.1秒ごとに: ⓪ チームAI（1秒ごと＋出来事の直後） → ① 選手AI（0.2秒ごと＋出来事の直後）
 *              → ② 蹴る（再開のキックも） → ③ 体を動かす
 *              → ④ ボールを動かす → ⑤ ゴール／外へ出たか → ⑥ 誰かの足が届いたか（オフサイドもここ）
 *
 * 🔑 パスが通るか・奪われるかは ⑥ だけで決まる。**足が届いた選手が触る**。
 *    同時に届いたら、ボールにより近い選手（同じなら並びが前の選手）。
 * 🔑 ボールが外へ出たら、競技規則どおりの再開（laws.ts）。再開を待つ間はボールが止まっていて、
 *    **実プレー時間に数えない**。蹴る人（チームAIの TAKER）が着いて、準備の時間がたったら蹴る。
 *
 * まだ無いもの（作る順どおり）: シュート・ファウル・GK のキャッチ・浮き球＝作る順 5 以降。
 *   前後半の入れ替え（エンドの交代）もまだ。
 *
 * 🔴 乱数は一切使わない（D-42）。
 */

import { FORMATIONS } from "../model.ts";
import { hypot } from "../pymath.ts";
import { Ball } from "./ball.ts";
import { Body, topSpeed } from "./body.ts";
import { exemptFromOffside, goalScored, offsidePositions, restartAfterOut } from "./laws.ts";
import type { Restart, RestartKind } from "./laws.ts";
import { CARRY_EFFORT, decideHolder, decideOffBall, decideRestartKick } from "./player_ai.ts";
import type { Agent, HolderPlan, View } from "./player_ai.ts";
import { CONTROL_MAX_MPS, PITCH_LENGTH_M, PITCH_WIDTH_M, REACH_M, enterAt } from "./reach.ts";
import { TEAM_DECIDE_EVERY_TICKS, planTeam } from "./team_ai.ts";
import type { RestartState, TeamPlan } from "./team_ai.ts";

/** 選手AIが考え直す間隔（コマ＝0.1秒）。D-42: 0.2〜0.3秒ごと */
export const DECIDE_EVERY_TICKS = 2;
/**
 * 受けてから次に蹴れるまで・奪われないまで（コマ）。
 * 🔑 設計値（出典なし）。ボールを止めて足元に置く時間として 0.3 秒。無いと受けた瞬間に奪い返されて往復する
 */
export const FIRST_TOUCH_TICKS = 3;
/** 蹴った本人が自分の蹴ったボールに触れない時間（コマ）。無いと蹴った瞬間に自分で止める */
export const KICKER_NO_TOUCH_TICKS = 3;
/** 運んでいるとき、ボールは体のこれだけ前にある（m） */
export const CARRY_AHEAD_M = 0.5;
/**
 * 蹴る人がボールに着いてから蹴るまで（コマ）。
 * 🔑 設計値（出典なし）。確かめ方: 実プレー時間が 54〜59分（`docs/realism-reference.md`）に入るか。
 */
export const RESTART_PREP_TICKS: Readonly<Record<RestartKind, number>> = {
  KICKOFF: 20, THROW_IN: 30, GOAL_KICK: 50, CORNER: 50, FREE_KICK: 40,
};
/** キックオフは全員が自陣に戻るまで待つ。ただしこれ以上は待たない（コマ） */
export const KICKOFF_WAIT_MAX_TICKS = 200;

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
  /** このチームのキックオフで始める（省略すればボールはそのまま動いている） */
  kickoff?: 0 | 1;
}

export interface PassRecord {
  team: 0 | 1;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** 味方が受けた／相手が触った／外へ出た／蹴った本人が拾い直した／受けた味方がオフサイド */
  result: "COMPLETED" | "INTERCEPTED" | "OUT" | "SELF" | "OFFSIDE";
  /** 蹴る前に reach.ts が「先に触る」と読んだチーム（読まずに蹴ったなら null） */
  expectedTeam: 0 | 1 | null;
  /** 再開のキックなら、その種類 */
  restart: RestartKind | null;
}

interface InFlight {
  team: 0 | 1;
  from: Agent;
  x: number;
  y: number;
  expectedTeam: 0 | 1 | null;
  restart: RestartKind | null;
  /** 蹴った瞬間にオフサイドの位置にいた味方 */
  offside: Set<number>;
}

export class MatchSim {
  tick = 0;
  readonly ball: Ball;
  readonly agents: Agent[];
  readonly bodies: Body[];
  holder: Agent | null = null;
  /** 再開を待っているなら、その中身 */
  restart: RestartState | null = null;
  readonly score: [number, number] = [0, 0];
  /** ボールが動いていたコマ数（実プレー時間） */
  inPlayTicks = 0;
  readonly restarts: Record<RestartKind, number> = { KICKOFF: 0, THROW_IN: 0, GOAL_KICK: 0, CORNER: 0, FREE_KICK: 0 };
  readonly offsides: [number, number] = [0, 0];
  readonly passes: PassRecord[] = [];
  readonly steals: [number, number] = [0, 0];
  plans: [TeamPlan, TeamPlan];

  /** 持っている人が蹴れる・奪われるようになるコマ */
  private settledAt = 0;
  private plan: HolderPlan | null = null;
  private lastTeam: 0 | 1 | null = null;
  private readonly noTouchUntil: number[];
  /** 再開で蹴った人。ほかの誰かが触るまで2度は触れない（第13〜17条） */
  private doubleTouchBan: number | null = null;
  private inFlight: InFlight | null = null;
  private eventHappened = true;
  private teamEvent = true;
  private prevX = 0.0;
  private prevY = 0.0;
  /** 蹴る人がボールに着いて、蹴ってよくなるコマ（まだ着いていなければ null） */
  private restartReadyAt: number | null = null;
  private restartBegan = 0;

  constructor(setup: Setup) {
    this.agents = setup.players.map((p, id) => ({
      id, team: p.team, role: p.role, body: new Body(p.x, p.y, p.topSpeed),
      homeX: p.homeX, homeY: p.homeY, aimX: p.x, aimY: p.y, effort: 0.5, stop: true,
    }));
    this.bodies = this.agents.map((a) => a.body);
    this.noTouchUntil = this.agents.map(() => 0);
    this.ball = new Ball(setup.ball.x, setup.ball.y);
    this.ball.kick(setup.ball.vx ?? 0.0, setup.ball.vy ?? 0.0);
    this.plans = [planTeam(0, this.agents, this.ball, null), planTeam(1, this.agents, this.ball, null)];
    const by = setup.ball.kickedBy;
    if (by !== undefined) {
      const from = this.agents[by]!;
      this.inFlight = { team: from.team, from, x: this.ball.x, y: this.ball.y, expectedTeam: null,
                        restart: null,
                        offside: offsidePositions(from.team, this.ball.x,
                                                  this.agents.map((a) => ({ team: a.team, x: a.body.x }))) };
      this.lastTeam = from.team;
      this.noTouchUntil[by] = KICKER_NO_TOUCH_TICKS;
    }
    if (setup.kickoff !== undefined) {
      this.beginRestart({ kind: "KICKOFF", team: setup.kickoff, x: PITCH_LENGTH_M / 2, y: PITCH_WIDTH_M / 2 });
    }
  }

  /** 実プレー時間（分） */
  get inPlayMinutes(): number {
    return this.inPlayTicks / 600;
  }

  /** 1コマ（0.1秒）進める */
  step(): void {
    // ⓪ チームAI（持ち主が変わった・外へ出た直後はすぐ）
    if (this.teamEvent || this.tick % TEAM_DECIDE_EVERY_TICKS === 0) {
      this.teamEvent = false;
      this.plans = [planTeam(0, this.agents, this.ball, this.holder, this.restart),
                    planTeam(1, this.agents, this.ball, this.holder, this.restart)];
    }
    // ① 選手AI
    if (this.eventHappened || this.tick % DECIDE_EVERY_TICKS === 0) {
      this.eventHappened = false;
      const view = this.view();
      decideOffBall(view);
      if (this.holder !== null) this.plan = decideHolder(view, this.holder);
    }
    // ② 蹴る
    if (this.restart !== null) {
      this.stepRestart();
    } else {
      const h = this.holder;
      if (h !== null && this.plan !== null && this.tick >= this.settledAt) {
        if (this.plan.kind === "PASS") {
          this.kick(h, this.plan.vx, this.plan.vy, this.agents[this.plan.to]!.team, null);
        } else {
          h.aimX = this.plan.x;
          h.aimY = this.plan.y;
          h.effort = CARRY_EFFORT;
        }
      }
    }
    // ③ 体
    for (const a of this.agents) a.body.steerTo(a.aimX, a.aimY, a.effort, a.stop);
    if (this.restart !== null) {
      // 再開を待つ間、ボールは置いたまま
      this.tick += 1;
      return;
    }
    this.inPlayTicks += 1;
    // ④ ボール（触れたかの判定のため、動く前の位置を覚えておく）
    this.prevX = this.ball.x;
    this.prevY = this.ball.y;
    if (this.holder !== null) this.carryBall(this.holder);
    else this.ball.step();
    // ⑤ ゴール／外へ出たか
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
      if (this.noTouchUntil[i]! > this.tick || this.doubleTouchBan === i) blocked.add(a.id);
    });
    return { agents: this.agents, bodies: this.bodies, ball: this.ball, holder: this.holder, blocked,
             plans: this.plans, restart: this.restart };
  }

  // ------------------------------------------------------------ 再開

  /**
   * 再開を始める。ボールを再開の地点に置き、蹴る人を決める。
   * 🔑 蹴る人: ゴールキックは GK、それ以外は再開するチームでいちばん近いフィールドの選手。
   */
  private beginRestart(r: Restart): void {
    this.restarts[r.kind] += 1;
    this.holder = null;
    this.plan = null;
    this.ball.x = r.x;
    this.ball.y = r.y;
    this.ball.kick(0.0, 0.0);
    const team = this.agents.filter((a) => a.team === r.team);
    let taker = team.find((a) => a.role === "GK")!;
    if (r.kind !== "GOAL_KICK") {
      let best = Infinity;
      for (const a of team) {
        if (a.role === "GK") continue;
        const d = hypot(a.body.x - r.x, a.body.y - r.y);
        if (d < best) {
          best = d;
          taker = a;
        }
      }
    }
    this.restart = { ...r, taker: taker.id };
    this.restartReadyAt = null;
    this.restartBegan = this.tick;
    this.eventHappened = true;
    this.teamEvent = true;
  }

  /** 蹴る人が着いたら準備の時間をおき、蹴る */
  private stepRestart(): void {
    const r = this.restart!;
    const taker = this.agents[r.taker]!;
    const there = hypot(taker.body.x - r.x, taker.body.y - r.y) <= REACH_M;
    if (this.restartReadyAt === null) {
      if (there) this.restartReadyAt = this.tick + RESTART_PREP_TICKS[r.kind];
      return;
    }
    if (this.tick < this.restartReadyAt || !there) return;
    if (r.kind === "KICKOFF" && !this.everyoneInOwnHalf()
        && this.tick - this.restartBegan < KICKOFF_WAIT_MAX_TICKS) return;
    const plan = decideRestartKick(this.view(), taker, r.kind);
    if (plan.kind !== "PASS") return;
    this.restart = null;
    this.kick(taker, plan.vx, plan.vy, this.agents[plan.to]!.team, r.kind);
    this.doubleTouchBan = taker.id;
  }

  /** 🔑 蹴る人はセンターマーク（ハーフウェーライン上）に立つので数えない */
  private everyoneInOwnHalf(): boolean {
    const taker = this.restart?.taker;
    return this.agents.every((a) => a.id === taker
      || (a.team === 0 ? a.body.x <= PITCH_LENGTH_M / 2 : a.body.x >= PITCH_LENGTH_M / 2));
  }

  // ------------------------------------------------------------ ボール

  private kick(from: Agent, vx: number, vy: number, expectedTeam: 0 | 1 | null,
               restart: RestartKind | null): void {
    const offside = exemptFromOffside(restart)
      ? new Set<number>()
      : offsidePositions(from.team, this.ball.x, this.agents.map((a) => ({ team: a.team, x: a.body.x })));
    this.inFlight = { team: from.team, from, x: this.ball.x, y: this.ball.y, expectedTeam, restart, offside };
    this.ball.kick(vx, vy);
    this.holder = null;
    this.plan = null;
    this.lastTeam = from.team;
    this.noTouchUntil[from.id] = this.tick + KICKER_NO_TOUCH_TICKS;
    this.eventHappened = true;
    this.teamEvent = true;
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

  /** ゴールなら得点してキックオフ、そうでなければ競技規則どおりの再開（laws.ts） */
  private ballOut(): void {
    const scorer = goalScored(this.ball.x, this.ball.y);
    if (this.inFlight !== null) this.closePass("OUT", this.ball.x, this.ball.y);
    this.doubleTouchBan = null;
    if (scorer !== null) {
      this.score[scorer] += 1;
      this.beginRestart({ kind: "KICKOFF", team: (1 - scorer) as 0 | 1,
                          x: PITCH_LENGTH_M / 2, y: PITCH_WIDTH_M / 2 });
      return;
    }
    this.beginRestart(restartAfterOut(this.ball.x, this.ball.y, this.lastTeam ?? 0));
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
    // 🔴 このコマにボールが通った線で見る（終わりの位置だけで見ると、速いボールが足をすり抜ける）。
    //    線の手前で届いた選手が先。同じならボールの終わりの位置に近い選手、それも同じなら並びが前
    let got: { a: Agent; s: number; d: number } | null = null;
    for (const a of this.agents) {
      if (this.noTouchUntil[a.id]! > this.tick || this.doubleTouchBan === a.id) continue;
      const s = enterAt(this.prevX, this.prevY, this.ball.x, this.ball.y, a.body.x, a.body.y, REACH_M);
      if (s < 0.0) continue;
      const d = hypot(this.ball.x - a.body.x, this.ball.y - a.body.y);
      if (got === null || s < got.s || (s === got.s && d < got.d)) got = { a, s, d };
    }
    if (got === null) return;
    // 触ったのは線の途中。ボールはそこで止められている
    this.ball.x = this.prevX + (this.ball.x - this.prevX) * got.s;
    this.ball.y = this.prevY + (this.ball.y - this.prevY) * got.s;
    this.doubleTouchBan = null;
    const f = this.inFlight;
    if (f !== null) {
      // 🔑 オフサイド（第11条）: 蹴った瞬間にオフサイドの位置にいた味方が、そのボールに触った
      if (got.a.team === f.team && got.a !== f.from && f.offside.has(got.a.id)) {
        this.closePass("OFFSIDE", this.ball.x, this.ball.y);
        this.offsides[f.team] += 1;
        this.beginRestart({ kind: "FREE_KICK", team: (1 - f.team) as 0 | 1, x: this.ball.x, y: this.ball.y });
        return;
      }
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
    this.teamEvent = true;
  }

  private closePass(result: PassRecord["result"], x: number, y: number): void {
    const f = this.inFlight!;
    this.passes.push({ team: f.team, fromX: f.x, fromY: f.y, toX: x, toY: y, result,
                       expectedTeam: f.expectedTeam, restart: f.restart });
    this.inFlight = null;
  }
}

/**
 * フォーメーションどおりに22人を並べ、チーム0 のキックオフで始める（能力 speed は全員同じ）。
 * 🔑 最初の位置は持ち場を自陣側へ半分に縮めたところ（キックオフの並び・第8条）。
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
  return { players, ball: { x: PITCH_LENGTH_M / 2.0, y: PITCH_WIDTH_M / 2.0 }, kickoff: 0 };
}
