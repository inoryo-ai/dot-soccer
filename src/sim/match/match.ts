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
 * 🔑 シュートも「通り道に足や手が届くか」で決まる。触ったときのボールの速さで、
 *    止める（その人のボールになる）か、はね返る（フィールドの選手）／弾く（GK）かが決まる。
 *
 * まだ無いもの（作る順どおり）: ファウル・浮き球（クロス・ヘディング）・裏への走り込み。
 *   前後半の入れ替え（エンドの交代）もまだ。
 *
 * 🔴 乱数は一切使わない（D-42）。
 */

import { FORMATIONS } from "../model.ts";
import { hypot } from "../pymath.ts";
import { Ball } from "./ball.ts";
import { Body, topSpeed } from "./body.ts";
import { Execution } from "./execution.ts";
import { Fatigue, staminaEfficiency } from "./stamina.ts";
import type { KickKind } from "./execution.ts";
import { PENALTY_SPOT_M, exemptFromOffside, goalScored, inOwnPenaltyArea, offsidePositions, restartAfterOut }
  from "./laws.ts";
import type { Restart, RestartKind } from "./laws.ts";
import { effortOf } from "./pace.ts";
import { CARRY_PACE, bestShot, decideHeader, decideHolder, decideOffBall, decideRestartKick } from "./player_ai.ts";
import type { Agent, HolderPlan, View } from "./player_ai.ts";
import { CONTROL_MAX_MPS, CONTROL_MAX_Z_M, GK_ARM_M, GK_CATCH_MAX_MPS, GK_DIVE_M, PITCH_LENGTH_M, PITCH_WIDTH_M,
  REACH_M, canReachHeight, enterAt, gkReach } from "./reach.ts";
import { TEAM_DECIDE_EVERY_TICKS, planTeam } from "./team_ai.ts";
import { STANDARD } from "./tactics.ts";
import type { Tactics } from "./tactics.ts";
import type { RestartState, TeamPlan } from "./team_ai.ts";

/** 選手AIが考え直す間隔（コマ＝0.1秒）。D-42: 0.2〜0.3秒ごと */
export const DECIDE_EVERY_TICKS = 2;
/**
 * 受けてから奪われないまで（コマ）。ボールを止めて足元に置く瞬間だけ。
 * 🔑 設計値（出典なし）。無いと受けた瞬間に奪い返されて往復する
 */
export const FIRST_TOUCH_TICKS = 3;
/**
 * 受けてから次に蹴れるまで（コマ）。
 * 🔑 選手1人が1回ボールを持つ時間の平均は 約1.1〜1.2秒、いちばん短いセンターフォワードで 0.9±0.6秒
 *    （Link & Hoernig 2017, PLOS ONE・ブンデスリーガ 60試合 TRACAB）。
 *    🔴 奪われない時間と同じ 0.3秒にしていた頃は、手放すまでの中央値が 0.2〜0.5秒で、パスが現実の約2倍だった。
 *    受けてすぐ寄せられた選手は、蹴れるようになる前に奪われることがある（現実のセンターフォワードと同じ）
 */
export const CONTROL_TICKS = 10;
/** 蹴った本人が自分の蹴ったボールに触れない時間（コマ）。無いと蹴った瞬間に自分で止める */
export const KICKER_NO_TOUCH_TICKS = 3;
/** 運んでいるとき、ボールは体のこれだけ前にある（m） */
export const CARRY_AHEAD_M = 0.5;
/** 体どうしが近づける距離（体の中心どうし・m）。🔑 設計値（出典なし。肩幅 約0.4m の2人分） */
export const BODY_GAP_M = 0.8;
/**
 * ボールを守る: 相手がこの距離以内なら、ボールを相手から遠い側に、体から SHIELD_BALL_MIN〜MAX_M の所に置く
 * （技術 100 で MIN、0 で MAX）。🔑 設計値（出典なし）
 */
export const SHIELD_TRIGGER_M = 3.0;
/**
 * タックル: 相手のボールがこの距離以内に来たら足を伸ばして奪いにいく（同じ選手は TACKLE_COOLDOWN_TICKS に1回）。
 * 届かなければ TACKLE_RECOVER_TICKS のあいだ体勢を崩して止まる。🔑 設計値（出典なし）
 * 🔴 ボールを体の陰に置く（carryBall）と、まっすぐ寄せるだけでは体に押し戻されて永遠に届かず、
 *    奪われる回数が 1チーム 0〜0.5回になった（2026-10-05）
 */
export const TACKLE_ATTEMPT_M = 1.3;
/**
 * タックルでボールに届かず、相手の体の中心から「足が届いた距離 ＋ この値」以内に相手がいたら、足（体）に当たった＝ファウル。
 * 🔑 ファウル 1チーム 約11〜17回（プレミアリーグ 約10.6・ラ・リーガ 約16.7・`docs/realism-reference.md`）に合わせた。
 *    体どうしは 0.8m より近づけないので、足を伸ばせた分（実行のブレ）で当たる・当たらないが分かれ、この値に敏感
 *    （2026-10-05: −0.30m で 29回、−0.35m で 約20回、−0.37m で 約18.5回、−0.40m で 約9回、−0.45m で 0回）
 */
export const FOUL_BODY_M = -0.38;
/** 自陣のペナルティエリアの中でタックルに行く、ボールまでの距離の上限（m）。🔑 設計値（出典なし） */
export const BOX_TACKLE_M = 0.9;
export const TACKLE_COOLDOWN_TICKS = 10;
export const TACKLE_RECOVER_TICKS = 8;
export const SHIELD_BALL_MIN_M = 0.3;
export const SHIELD_BALL_MAX_M = 0.6;
/**
 * 蹴る人がボールに着いてから蹴るまで（コマ）。
 * 🔑 設計値（出典なし）。確かめ方: 実プレー時間が 54〜59分（`docs/realism-reference.md`）に入るか。
 */
export const RESTART_PREP_TICKS: Readonly<Record<RestartKind, number>> = {
  KICKOFF: 20, THROW_IN: 30, GOAL_KICK: 50, CORNER: 50, FREE_KICK: 40, PENALTY: 30,
};
/** GK がキャッチしてから配るまで（コマ）。🔑 設計値（出典なし）。競技規則の上限は6秒（第12条） */
export const GK_HOLD_TICKS = 20;
/** 止められない速さのボールに触れたとき、はね返る強さ（もとの速さに対する割合）。🔑 設計値（出典なし） */
export const BLOCK_REBOUND = 0.3;
/** 体をかすめた成分が残る割合（はね返り）。🔑 設計値（出典なし） */
export const BLOCK_GLANCE = 0.7;
/** GK が弾いたボールの速さ（もとの速さに対する割合）。横へそらす。🔑 設計値（出典なし） */
export const PARRY_SPEED = 0.35;
/**
 * 再開までに少なくとも止まっている時間（秒）。ボールが外へ出てから（得点してから）蹴るまで。
 * 🔑 現実: 1試合に約108回止まり、1回あたり平均 18.7秒（Siegle & Lames 2012, J Sports Sci・ブンデスリーガ）。
 *    種類ごとの「自然な長さ」の上限の目安はスローイン 20秒・ゴールキック 30秒・CK 45秒・FK 60秒
 *    （FiveThirtyEight 2018 W杯 3,194回の中断の分析・非査読）。両方に合うよう、Siegle & Lames の内訳
 *    （スローイン40・FK33・GK17・CK10・キックオフ3）で平均が約20秒になる値にした。
 * 🔴 以前は蹴る人が着いて 2〜5秒で蹴り、実プレー時間が 約84分（現実 約56分）あった。
 *    プレーが 1.5倍続くので、パス・シュート・得点・走行距離がどれも 1.5倍になっていた（2026-10-05）。
 *    ⚠️ ファウル（現実は1試合 約33回の FK）がまだ無いので、これだけでは現実の 56分までは下がらない。
 */
export const RESTART_STOPPAGE_S: Readonly<Record<RestartKind, number>> = {
  KICKOFF: 45, THROW_IN: 10, GOAL_KICK: 20, CORNER: 30, FREE_KICK: 25, PENALTY: 60,
};
/** キックオフは全員が自陣に戻るまで待つ。ただしこれ以上は待たない（コマ） */
export const KICKOFF_WAIT_MAX_TICKS = 600;

export interface Spawn {
  team: 0 | 1;
  role: Agent["role"];
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  topSpeed: number;
  /** 技術（0〜100）。省略すれば 50 */
  technique?: number;
  /** スタミナ（0〜100）。省略すれば 50。体力の減りにくさ（stamina.ts） */
  stamina?: number;
  /** フィジカル（0〜100）。省略すれば 50。体がぶつかったとき押されにくい */
  physical?: number;
}

export interface Setup {
  players: Spawn[];
  /** kickedBy: いま転がっているボールを蹴った選手の番号（shot なら シュート、そうでなければパスとして数える） */
  ball: { x: number; y: number; vx?: number; vy?: number; kickedBy?: number; shot?: boolean };
  /** このチームのキックオフで始める（省略すればボールはそのまま動いている） */
  kickoff?: 0 | 1;
  /** 実行のブレの種（省略すれば 1）。同じ種なら同じ試合になる */
  seed?: number;
  /** チームごとの戦術（省略すれば両チームとも標準の型） */
  tactics?: [Tactics, Tactics];
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
  /** 浮かせて蹴ったか */
  lofted: boolean;
  /** ヘディングでのパスか */
  header: boolean;
}

export interface ShotRecord {
  team: 0 | 1;
  x: number;
  y: number;
  /** 相手ゴールの中心からの距離（m） */
  distance: number;
  /** 撃った人が読んだ入る見込み（物理から出したゴール期待値・0〜1） */
  chance: number;
  result: "GOAL" | "SAVED" | "BLOCKED" | "OFF_TARGET";
  /** ヘディングシュートか */
  header: boolean;
}

interface InFlight {
  /** 蹴った瞬間に GK が立っていた所（飛び込みはここから・reach.ts と同じ） */
  keeperAt: Map<number, [number, number]>;
  /** パスかシュートか */
  shot: boolean;
  /** 浮かせて蹴ったか・ヘディングか */
  lofted: boolean;
  header: boolean;
  /** シュートなら、撃った人が読んだ入る見込み */
  chance: number;
  /** 蹴ったコマ */
  at: number;
  team: 0 | 1;
  from: Agent;
  x: number;
  y: number;
  expectedTeam: 0 | 1 | null;
  restart: RestartKind | null;
  /** 蹴った瞬間にオフサイドの位置にいた味方 */
  offside: Set<number>;
}

/**
 * 見た目のための記録: 誰がいつ何をしたか（3D の姿勢に使う・web/engine3d.ts）。
 * 🔑 書き残すだけで、試合の進み方には一切効かない。
 */
export interface ActionRecord {
  tick: number;
  who: number;
  /** 蹴る・頭で当てる・足を伸ばす（タックル）・GK が弾く・反則で倒された */
  kind: "KICK" | "HEADER" | "TACKLE" | "SAVE" | "FOULED";
}

export class MatchSim {
  tick = 0;
  readonly ball: Ball;
  readonly agents: Agent[];
  readonly bodies: Body[];
  /** 選手ごとの体力（agents と同じ並び） */
  readonly fatigue: Fatigue[];
  /** チームごとの戦術 */
  readonly tactics: [Tactics, Tactics];
  /** チームごとの、最後にボールを失ったコマ（失っていなければ -∞） */
  private readonly lostAt: [number, number] = [-Infinity, -Infinity];
  /** 持っている人が受けたコマ */
  private heldSince = 0;
  holder: Agent | null = null;
  /** 再開を待っているなら、その中身 */
  restart: RestartState | null = null;
  readonly score: [number, number] = [0, 0];
  /** ボールが動いていたコマ数（実プレー時間） */
  inPlayTicks = 0;
  readonly restarts: Record<RestartKind, number> = { KICKOFF: 0, THROW_IN: 0, GOAL_KICK: 0, CORNER: 0, FREE_KICK: 0, PENALTY: 0 };
  /** ファウルの回数（したチーム） */
  readonly fouls: [number, number] = [0, 0];
  readonly offsides: [number, number] = [0, 0];
  readonly passes: PassRecord[] = [];
  readonly shots: ShotRecord[] = [];
  readonly actions: ActionRecord[] = [];
  readonly steals: [number, number] = [0, 0];
  /** タックルを試みた回数（成功も失敗も） */
  readonly tackles: [number, number] = [0, 0];
  /** ヘディングした回数 */
  readonly headers: [number, number] = [0, 0];
  plans: [TeamPlan, TeamPlan];

  /** 持っている人が蹴れる・奪われるようになるコマ */
  private settledAt = 0;
  /** 持っている人が蹴れるようになるコマ */
  private canKickAt = 0;
  /** 選手ごとの、次にタックルできるコマ・体勢を崩して止まっている終わりのコマ */
  private readonly tackleReadyAt: number[] = [];
  private readonly stunnedUntil: number[] = [];
  private plan: HolderPlan | null = null;
  /** plan を決めたコマ */
  private planTick = -1;
  private lastTeam: 0 | 1 | null = null;
  private readonly noTouchUntil: number[];
  /** 再開で蹴った人。ほかの誰かが触るまで2度は触れない（第13〜17条） */
  private doubleTouchBan: number | null = null;
  private inFlight: InFlight | null = null;
  private eventHappened = true;
  private teamEvent = true;
  private prevX = 0.0;
  private prevY = 0.0;
  private prevZ = 0.0;
  /** 蹴る人がボールに着いて、蹴ってよくなるコマ（まだ着いていなければ null） */
  private restartReadyAt: number | null = null;
  private restartBegan = 0;
  private readonly execution: Execution;

  constructor(setup: Setup) {
    this.agents = setup.players.map((p, id) => ({
      id, team: p.team, role: p.role, body: new Body(p.x, p.y, p.topSpeed), technique: p.technique ?? 50,
      physical: p.physical ?? 50,
      homeX: p.homeX, homeY: p.homeY, aimX: p.x, aimY: p.y, effort: 0.5, stop: true,
    }));
    this.bodies = this.agents.map((a) => a.body);
    this.fatigue = setup.players.map((p) => new Fatigue(staminaEfficiency(p.stamina ?? 50)));
    this.tactics = setup.tactics ?? [STANDARD, STANDARD];
    this.noTouchUntil = this.agents.map(() => 0);
    for (let i = 0; i < this.agents.length; i++) {
      this.tackleReadyAt.push(0);
      this.stunnedUntil.push(0);
    }
    this.execution = new Execution(setup.seed ?? 1);
    this.ball = new Ball(setup.ball.x, setup.ball.y);
    this.ball.kick(setup.ball.vx ?? 0.0, setup.ball.vy ?? 0.0);
    this.plans = [planTeam(0, this.agents, this.ball, null), planTeam(1, this.agents, this.ball, null)];
    const by = setup.ball.kickedBy;
    if (by !== undefined) {
      const from = this.agents[by]!;
      this.inFlight = { keeperAt: this.keeperPositions(), shot: setup.ball.shot ?? false, lofted: false,
                        header: false, chance: 0.0, at: 0, team: from.team, from, x: this.ball.x, y: this.ball.y,
                        expectedTeam: null, restart: null,
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
      this.plans = [0, 1].map((t) => planTeam(t as 0 | 1, this.agents, this.ball, this.holder, this.restart,
                                               this.lastTeam, this.tactics[t]!,
                                               (this.tick - this.lostAt[t]!) * 0.1)) as [TeamPlan, TeamPlan];
    }
    // ① 選手AI
    if (this.eventHappened || this.tick % DECIDE_EVERY_TICKS === 0) {
      this.eventHappened = false;
      const view = this.view();
      decideOffBall(view);
      if (this.holder !== null) {
        this.plan = decideHolder(view, this.holder);
        this.planTick = this.tick;
      }
    }
    // ② 蹴る
    if (this.restart !== null) {
      this.stepRestart();
    } else {
      const h = this.holder;
      if (h !== null && this.plan !== null && this.tick >= this.canKickAt) {
        // 🔑 蹴るなら、蹴る瞬間の盤面で決め直す（0.1〜0.2秒前の判断のまま蹴ると、その間に動いた相手に読み負ける）
        // （同じコマの ① で決めたばかりなら盤面は同じなので、決め直さない）
        if (this.plan.kind !== "CARRY" && this.planTick !== this.tick) this.plan = decideHolder(this.view(), h);
        if (this.plan.kind === "PASS") {
          this.kick(h, this.plan.vx, this.plan.vy, this.agents[this.plan.to]!.team, null, null, this.plan.vz);
        } else if (this.plan.kind === "SHOOT") {
          this.kick(h, this.plan.vx, this.plan.vy, h.team, null, this.plan.chance, this.plan.vz);
        } else if (this.plan.kind === "CLEAR") {
          this.kick(h, this.plan.vx, this.plan.vy, null, null, null, this.plan.vz);
          this.inFlight = null;
        } else {
          h.aimX = this.plan.x;
          h.aimY = this.plan.y;
          h.effort = effortOf(h.body, CARRY_PACE);
        }
      }
    }
    // ③ 体（動いたぶん体力が減り、今の最高速に反映する）
    for (const a of this.agents) {
      // タックルを外して体勢を崩している間は、その場に止まる
      if (this.stunnedUntil[a.id]! > this.tick) a.body.steerTo(a.body.x, a.body.y, 0.2, true);
      else a.body.steerTo(a.aimX, a.aimY, a.effort, a.stop);
      const f = this.fatigue[a.id]!;
      f.update(a.body.speed, 0.1);
      f.applyTo(a.body);
    }
    this.separateBodies();
    if (this.restart !== null) {
      // 再開を待つ間、ボールは置いたまま
      this.tick += 1;
      return;
    }
    this.inPlayTicks += 1;
    // ④ ボール（触れたかの判定のため、動く前の位置を覚えておく）
    this.prevX = this.ball.x;
    this.prevY = this.ball.y;
    this.prevZ = this.ball.z;
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
             plans: this.plans, restart: this.restart,
             holderReady: this.holder !== null && this.tick >= this.canKickAt,
             holderFor: (this.tick - this.heldSince) * 0.1, tactics: this.tactics };
  }

  // ------------------------------------------------------------ 再開

  /**
   * 再開を始める。ボールを再開の地点に置き、蹴る人を決める。
   * 🔑 蹴る人: ゴールキックは GK、それ以外は再開するチームでいちばん近いフィールドの選手。
   */
  /** 飛んでいるパス・シュートがあれば、記録を閉じる（ファウルで止まったときなど） */
  private closeAnyFlight(): void {
    const f = this.inFlight;
    if (f === null) return;
    if (f.shot) this.closeShot("BLOCKED");
    else this.closePass("INTERCEPTED", this.ball.x, this.ball.y);
  }

  private beginRestart(r: Restart, takerId: number | null = null): void {
    this.restarts[r.kind] += 1;
    this.holder = null;
    this.plan = null;
    this.ball.x = r.x;
    this.ball.y = r.y;
    this.ball.kick(0.0, 0.0);
    const team = this.agents.filter((a) => a.team === r.team);
    if (team.length === 0) throw new Error(`再開するチーム ${r.team} に選手がいない`);
    let taker: Agent | undefined = takerId !== null ? this.agents[takerId]
      : r.kind === "GOAL_KICK" ? team.find((a) => a.role === "GK") : undefined;
    if (taker === undefined) {
      // フィールドの選手でいちばん近い人（フィールドの選手がいなければ GK）
      const pool = team.some((a) => a.role !== "GK") ? team.filter((a) => a.role !== "GK") : team;
      let best = Infinity;
      for (const a of pool) {
        const d = hypot(a.body.x - r.x, a.body.y - r.y);
        if (d < best) {
          best = d;
          taker = a;
        }
      }
    }
    this.restart = { ...r, taker: taker!.id };
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
    // 🔑 再開の種類ごとの止まっている時間（試合の最初のキックオフは待たない）
    const stoppage = r.kind === "KICKOFF" && this.restartBegan === 0 ? 0 : RESTART_STOPPAGE_S[r.kind];
    if (this.tick - this.restartBegan < stoppage * 10) return;
    if (r.kind === "KICKOFF" && !this.everyoneInOwnHalf()
        && this.tick - this.restartBegan < KICKOFF_WAIT_MAX_TICKS) return;
    if (r.kind === "PENALTY") {
      // PK は必ず撃つ。いちばん入る見込みの高い狙いへ（見つからなければ真ん中へ）
      const shot = bestShot(this.view(), taker);
      const gx = taker.team === 0 ? PITCH_LENGTH_M : 0.0;
      const vx = shot?.vx ?? (gx - this.ball.x) / PENALTY_SPOT_M * 26.0;
      const vy = shot?.vy ?? 0.0;
      this.restart = null;
      this.kick(taker, vx, vy, taker.team, "PENALTY", shot?.chance ?? 0.0, shot?.vz ?? 0.0);
      this.doubleTouchBan = taker.id;
      return;
    }
    const plan = decideRestartKick(this.view(), taker, r.kind);
    if (plan.kind !== "PASS" && plan.kind !== "CLEAR") return;
    this.restart = null;
    this.kick(taker, plan.vx, plan.vy, plan.kind === "PASS" ? this.agents[plan.to]!.team : null, r.kind, null, plan.vz);
    if (plan.kind === "CLEAR") this.inFlight = null;
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
               restart: RestartKind | null, shotChance: number | null = null, vz = 0.0,
               header = false): void {
    const shot = shotChance !== null;
    const offside = exemptFromOffside(restart)
      ? new Set<number>()
      : offsidePositions(from.team, this.ball.x, this.agents.map((a) => ({ team: a.team, x: a.body.x })));
    this.inFlight = { keeperAt: this.keeperPositions(), shot, lofted: vz > 0.0, header, chance: shotChance ?? 0.0,
                      at: this.tick, team: from.team, from, x: this.ball.x, y: this.ball.y,
                      expectedTeam, restart, offside };
    // 🔑 実行のブレ: 狙った速度から、技術・速さ・寄せられ具合に応じてずれる（execution.ts）
    let near = Infinity;
    for (const a of this.agents) {
      if (a.team !== from.team) near = Math.min(near, hypot(a.body.x - from.body.x, a.body.y - from.body.y));
    }
    const kind: KickKind = header ? "HEADER" : shot ? "SHOT" : "PASS";
    [vx, vy, vz] = this.execution.kick(kind, vx, vy, from.technique, near, vz);
    this.ball.kick(vx, vy, vz);
    this.actions.push({ tick: this.tick, who: from.id, kind: header ? "HEADER" : "KICK" });
    this.holder = null;
    this.plan = null;
    this.lastTeam = from.team;
    this.noTouchUntil[from.id] = this.tick + KICKER_NO_TOUCH_TICKS;
    this.eventHappened = true;
    this.teamEvent = true;
  }

  /**
   * 体どうしは BODY_GAP_M より近づけない。重なったら押し戻す（フィジカルが強いほど押されにくい）。
   * 🔑 これが無いと、ボールを体の陰に置いても、相手は持っている人の体をすり抜けてボールに届く。
   *    並びの順に1回ずつ押し戻す（決定論）。
   */
  private separateBodies(): void {
    const n = this.agents.length;
    for (let i = 0; i < n; i++) {
      const a = this.agents[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = this.agents[j]!;
        let dx = b.body.x - a.body.x;
        let dy = b.body.y - a.body.y;
        let d = hypot(dx, dy);
        if (d >= BODY_GAP_M) continue;
        if (d === 0.0) {
          dx = 1.0;
          dy = 0.0;
          d = 1.0;
        }
        const overlap = BODY_GAP_M - hypot(b.body.x - a.body.x, b.body.y - a.body.y);
        const pa = 0.5 + a.physical / 100.0;
        const pb = 0.5 + b.physical / 100.0;
        const moveA = overlap * pb / (pa + pb);   // 強い相手ほど自分が押される
        const moveB = overlap * pa / (pa + pb);
        a.body.x -= dx / d * moveA;
        a.body.y -= dy / d * moveA;
        b.body.x += dx / d * moveB;
        b.body.y += dy / d * moveB;
      }
    }
  }

  /**
   * 運んでいる間、ボールは体の少し前（進んでいる向き。止まっていれば攻める向き）。
   * 🔑 ボールを守る: 相手が SHIELD_TRIGGER_M 以内にいれば、その相手から遠い側の足元に置く。
   *    技術が高いほど体の近くに置ける（相手の足が届きにくい）。体の接触（separateBodies）があるので、
   *    相手は体を回り込まないとボールに届かない。
   *    🔴 これが無い頃は 1チーム 116〜147回ボールを奪われた（現実のタックル 約17回・2026-10-05）
   */
  private carryBall(h: Agent): void {
    const s = h.body.speed;
    let ux = s > 0.1 ? h.body.vx / s : (h.team === 0 ? 1.0 : -1.0);
    let uy = s > 0.1 ? h.body.vy / s : 0.0;
    let ahead = CARRY_AHEAD_M;
    let near: Agent | null = null;
    let nd = SHIELD_TRIGGER_M;
    for (const o of this.agents) {
      if (o.team === h.team) continue;
      const d = hypot(o.body.x - h.body.x, o.body.y - h.body.y);
      if (d < nd) {
        nd = d;
        near = o;
      }
    }
    if (near !== null && nd > 0.0) {
      ux = (h.body.x - near.body.x) / nd;
      uy = (h.body.y - near.body.y) / nd;
      ahead = SHIELD_BALL_MAX_M - (SHIELD_BALL_MAX_M - SHIELD_BALL_MIN_M) * h.technique / 100.0;
    }
    this.ball.x = h.body.x + ux * ahead;
    this.ball.y = h.body.y + uy * ahead;
    this.ball.z = 0.0;
    this.ball.kick(h.body.vx, h.body.vy);
  }

  private isOut(): boolean {
    const b = this.ball;
    return b.x < 0.0 || b.x > PITCH_LENGTH_M || b.y < 0.0 || b.y > PITCH_WIDTH_M;
  }

  /** ゴールなら得点してキックオフ、そうでなければ競技規則どおりの再開（laws.ts） */
  private ballOut(): void {
    const scorer = goalScored(this.ball.x, this.ball.y, this.ball.z);
    const f = this.inFlight;
    if (f !== null && f.shot) this.closeShot(scorer === f.team ? "GOAL" : "OFF_TARGET");
    else if (f !== null) this.closePass("OUT", this.ball.x, this.ball.y);
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
      // 🔑 GK が自分のペナルティエリアの中で手で持っているボールには挑めない（第12条）
      if (h.role === "GK" && inOwnPenaltyArea(h.team, this.ball.x, this.ball.y)) return;
      // 相手の足がボールに届き、しかも持っている人よりボールに近ければ奪う（ボールが体の陰に無いとき）
      const mine = hypot(this.ball.x - h.body.x, this.ball.y - h.body.y);
      const thief = this.closestWithin(REACH_M, (a) => a.team !== h.team);
      if (thief !== null && thief.d < mine) {
        this.steals[thief.a.team] += 1;
        this.take(thief.a);
        return;
      }
      // 🔑 タックル: ボールまで TACKLE_ATTEMPT_M 以内の相手が足を伸ばす（伸ばせた分は実行のブレ・execution.ts）。
      //    届けば奪い、届かなければ体勢を崩して止まる。並びの順に1人ずつ（決定論）
      for (const a of this.agents) {
        if (a.team === h.team || a.role === "GK" || this.stunnedUntil[a.id]! > this.tick
            || this.tackleReadyAt[a.id]! > this.tick) continue;
        const d = hypot(this.ball.x - a.body.x, this.ball.y - a.body.y);
        if (d > TACKLE_ATTEMPT_M) continue;
        // 🔑 自陣のペナルティエリアの中では、確実に届くときだけ足を出す（外せば PK になりうる）
        if (inOwnPenaltyArea(a.team, h.body.x, h.body.y) && d > BOX_TACKLE_M) continue;
        this.tackleReadyAt[a.id] = this.tick + TACKLE_COOLDOWN_TICKS;
        this.tackles[a.team] += 1;
        this.actions.push({ tick: this.tick, who: a.id, kind: "TACKLE" });
        const reach = REACH_M + this.execution.tackleExtension(a.physical);
        if (d <= reach) {
          this.steals[a.team] += 1;
          this.take(a);
          return;
        }
        // 🔑 ファウル: ボールに届かず、相手の足（体）に届いた。体の陰に置いたボールへ後ろや横から足を
        //    伸ばすと起きる。自陣のペナルティエリアの中なら PK（第12・14条）
        if (hypot(h.body.x - a.body.x, h.body.y - a.body.y) - FOUL_BODY_M <= reach) {
          this.fouls[a.team] += 1;
          this.actions.push({ tick: this.tick, who: h.id, kind: "FOULED" });
          const pk = inOwnPenaltyArea(a.team, h.body.x, h.body.y);
          const goalX = h.team === 0 ? PITCH_LENGTH_M : 0.0;
          this.closeAnyFlight();
          this.beginRestart(pk
            ? { kind: "PENALTY", team: h.team, x: goalX - (h.team === 0 ? 1 : -1) * PENALTY_SPOT_M, y: PITCH_WIDTH_M / 2 }
            : { kind: "FREE_KICK", team: h.team, x: h.body.x, y: h.body.y }, pk ? null : h.id);
          return;
        }
        this.stunnedUntil[a.id] = this.tick + TACKLE_RECOVER_TICKS;
      }
      return;
    }
    // 🔴 このコマにボールが通った線で見る（終わりの位置だけで見ると、速いボールが足をすり抜ける）。
    //    線の手前で届いた選手が先。同じならボールの終わりの位置に近い選手、それも同じなら並びが前
    let got: { a: Agent; s: number; d: number } | null = null;
    for (const a of this.agents) {
      if (this.noTouchUntil[a.id]! > this.tick || this.doubleTouchBan === a.id) continue;
      const s = this.touchAt(a);
      if (s < 0.0) continue;
      const d = hypot(this.ball.x - a.body.x, this.ball.y - a.body.y);
      if (got === null || s < got.s || (s === got.s && d < got.d)) got = { a, s, d };
    }
    if (got === null) return;
    // 触ったのは線の途中。ボールはそこで止められている（高さも途中の値）
    const touchZ = Math.min(this.prevZ, this.ball.z);
    this.ball.x = this.prevX + (this.ball.x - this.prevX) * got.s;
    this.ball.y = this.prevY + (this.ball.y - this.prevY) * got.s;
    if (this.ball.airborne) this.ball.z = this.prevZ + (this.ball.z - this.prevZ) * got.s;
    this.doubleTouchBan = null;
    const f = this.inFlight;
    const speed = this.ball.speed;
    const keeper = got.a.role === "GK" && inOwnPenaltyArea(got.a.team, this.ball.x, this.ball.y);
    if (f !== null && f.shot) {
      this.closeShot(got.a.team === f.team ? "BLOCKED" : keeper ? "SAVED" : "BLOCKED");
    }
    // 🔑 頭の高さ（フィールドの選手）ならヘディング。止められない速さならはね返す（GK は横へ弾く）
    const header = !keeper && touchZ > CONTROL_MAX_Z_M;
    const tooFast = keeper ? speed > GK_CATCH_MAX_MPS : speed > CONTROL_MAX_MPS;
    if (f !== null && !f.shot) {
      // 🔑 オフサイド（第11条）: 蹴った瞬間にオフサイドの位置にいた味方が、そのボールに触った（頭でも）
      if (got.a.team === f.team && got.a !== f.from && f.offside.has(got.a.id)) {
        this.closePass("OFFSIDE", this.ball.x, this.ball.y);
        this.offsides[f.team] += 1;
        this.beginRestart({ kind: "FREE_KICK", team: (1 - f.team) as 0 | 1, x: this.ball.x, y: this.ball.y });
        return;
      }
      // 味方が止めた、または頭で合わせた（クロス）なら通った。止められずにはね返ったなら通っていない
      const reached = header || !tooFast;
      const result = got.a === f.from ? "SELF" : got.a.team === f.team && reached ? "COMPLETED" : "INTERCEPTED";
      this.closePass(result, this.ball.x, this.ball.y);
    }
    if (header && !tooFast) {
      this.header(got.a);
      return;
    }
    if (header || tooFast) {
      this.deflect(got.a, keeper);
      return;
    }
    this.take(got.a);
  }

  /** ヘディング: 選手AIが向きを決め、その場で頭で弾く（止めない） */
  private header(a: Agent): void {
    this.headers[a.team] += 1;
    const plan = decideHeader(this.view(), a);
    if (plan.kind === "CARRY") return;   // （ヘディングでは運べないので起きない）
    const expected = plan.kind === "PASS" ? this.agents[plan.to]!.team : plan.kind === "SHOOT" ? a.team : null;
    this.kick(a, plan.vx, plan.vy, expected, null, plan.kind === "SHOOT" ? plan.chance : null, plan.vz, true);
    if (plan.kind === "CLEAR") this.inFlight = null;
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

  /**
   * このコマにボールが通った線のどこで、その選手の足（GK は手）が届くか（0〜1・届かなければ −1）。
   * 🔑 GK は自分のペナルティエリアの中なら、① 蹴られた瞬間に立っていた所から 手＋飛び込み、
   *    ② いまの体から 手、のどちらか（reach.ts の先読みと同じ。走ったうえに飛び込みを足さない）。
   */
  private touchAt(a: Agent): number {
    const seg = (x: number, y: number, r: number): number =>
      enterAt(this.prevX, this.prevY, this.ball.x, this.ball.y, x, y, r);
    const keeper = a.role === "GK" && inOwnPenaltyArea(a.team, this.ball.x, this.ball.y);
    // 頭上を越えていくボールには触れない（このコマのいちばん低い高さで見る・reach.ts と同じ）
    if (!canReachHeight(Math.min(this.prevZ, this.ball.z), keeper)) return -1.0;
    if (!keeper) {
      return seg(a.body.x, a.body.y, REACH_M);
    }
    const f = this.inFlight;
    const start = f?.keeperAt.get(a.id);
    const arm = seg(a.body.x, a.body.y, GK_ARM_M);
    const dive = start === undefined
      ? seg(a.body.x, a.body.y, GK_ARM_M + GK_DIVE_M)
      : seg(start[0], start[1], gkReach((this.tick - f!.at) * 0.1));
    if (arm < 0.0) return dive;
    if (dive < 0.0) return arm;
    return Math.min(arm, dive);
  }

  private keeperPositions(): Map<number, [number, number]> {
    const m = new Map<number, [number, number]>();
    for (const a of this.agents) if (a.role === "GK") m.set(a.id, [a.body.x, a.body.y]);
    return m;
  }

  /** 止められずに触れた: フィールドの選手ははね返し、GK は横へ弾く。誰のボールでもなくなる */
  private deflect(a: Agent, keeper: boolean): void {
    const v = this.ball.speed;
    if (keeper) {
      // ゴールラインへ向かう勢いは少し残し、ゴールの外側へそらす
      const side = this.ball.y >= PITCH_WIDTH_M / 2 ? 1.0 : -1.0;
      this.ball.kick(this.ball.vx * PARRY_SPEED * 0.5, side * v * PARRY_SPEED);
      this.actions.push({ tick: this.tick, who: a.id, kind: "SAVE" });
    } else {
      // 🔑 体のどこに当たったかで向きが変わる: 体の中心から当たった点への向き（n）の成分は BLOCK_REBOUND で
      //    はね返し、体をかすめる成分は BLOCK_GLANCE で残す。真正面なら手前へ戻り、端なら横・斜め後ろへそれる。
      //    🔴 いつも来た向きへまっすぐ戻すと、ブロックがゴールラインの外へ出ずコーナーキックが 0回だった（2026-10-05）
      let nx = this.ball.x - a.body.x;
      let ny = this.ball.y - a.body.y;
      const nl = hypot(nx, ny);
      if (nl > 0.0) {
        nx /= nl;
        ny /= nl;
      } else {
        const sp = hypot(this.ball.vx, this.ball.vy) || 1.0;
        nx = -this.ball.vx / sp;
        ny = -this.ball.vy / sp;
      }
      const vn = this.ball.vx * nx + this.ball.vy * ny;
      const tx = this.ball.vx - vn * nx;
      const ty = this.ball.vy - vn * ny;
      const back = vn < 0.0 ? -vn * BLOCK_REBOUND : vn;
      this.ball.kick(tx * BLOCK_GLANCE + nx * back, ty * BLOCK_GLANCE + ny * back, this.ball.vz * 0.5);
    }
    this.holder = null;
    this.plan = null;
    this.lastTeam = a.team;
    this.noTouchUntil[a.id] = this.tick + KICKER_NO_TOUCH_TICKS;
    this.eventHappened = true;
    this.teamEvent = true;
  }

  private take(a: Agent): void {
    // ボールの持ち主のチームが変わったなら、失った側の「失ったコマ」を記録する（奪い返しに使う）
    if (this.lastTeam !== null && this.lastTeam !== a.team) this.lostAt[this.lastTeam] = this.tick;
    this.holder = a;
    this.heldSince = this.tick;
    this.lastTeam = a.team;
    const caught = a.role === "GK" && inOwnPenaltyArea(a.team, this.ball.x, this.ball.y);
    this.settledAt = this.tick + (caught ? GK_HOLD_TICKS : FIRST_TOUCH_TICKS);
    this.canKickAt = this.tick + (caught ? GK_HOLD_TICKS : CONTROL_TICKS);
    this.plan = null;
    // 🔑 止めたボールは体と同じ動きになる（足元に収める）
    this.ball.kick(a.body.vx, a.body.vy);
    this.eventHappened = true;
    this.teamEvent = true;
  }

  private closeShot(result: ShotRecord["result"]): void {
    const f = this.inFlight!;
    const gx = f.team === 0 ? PITCH_LENGTH_M : 0.0;
    this.shots.push({ team: f.team, x: f.x, y: f.y, distance: hypot(gx - f.x, PITCH_WIDTH_M / 2 - f.y),
                      chance: f.chance, result, header: f.header });
    this.inFlight = null;
  }

  private closePass(result: PassRecord["result"], x: number, y: number): void {
    const f = this.inFlight!;
    this.passes.push({ team: f.team, fromX: f.x, fromY: f.y, toX: x, toY: y, result,
                       expectedTeam: f.expectedTeam, restart: f.restart, lofted: f.lofted, header: f.header });
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
