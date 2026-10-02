/**
 * 画面（`src/web/main.ts`）から `src/sim/` を呼ぶための薄い入口。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここにゲームの規則を書かない
 * ─────────────────────────────────────────────────────────────
 * 規則は `src/sim/` にしかない状態を保つ。ここに「画面用の判定」を書き始めると、
 * **エンジンが2つに分かれて、どちらが正か分からなくなる**。
 * この層がやるのは「画面が欲しい形の値に並べ直す」ことと、
 * 「画面に出してよいエラー（GameError）」と「こちらの不具合」を分けることだけ。
 *
 * 🔑 セーブはファイルではなく **`Career.toDict()` の値**をそのまま
 *    ブラウザの localStorage に置く（形は端末版のセーブファイルと同じ）。
 */

import * as C from "../sim/constants.ts";
import { Career, SAVE_VERSION, SaveError } from "../sim/career.ts";
import type { CareerTrainingResult, SaveData, SeasonSummary } from "../sim/career.ts";
import type { MatchEvent, MatchStatsOut, Replay } from "../sim/engine.ts";
import { ValueError } from "../sim/errors.ts";
import type { Fixture, StandingsRow, StoredMatchResult } from "../sim/league.ts";
import { ATTITUDES, FORMATIONS, POLICY_ACTIONS, POLICY_CONDITIONS, PolicyRule } from "../sim/model.ts";
import type { Player } from "../sim/model.ts";
import { PRESET_PLANS, TRAININGS_PER_PLAYER, defaultUserPlan } from "../sim/presets.ts";
import type { Plan } from "../sim/presets.ts";
import { pyRoundN } from "../sim/pymath.ts";
import { CARDS, FORBIDDEN_PAIRS, getCard, issueText, specialName } from "../sim/training.ts";

// 🔑 いま遊んでいるキャリア。ブラウザのタブ1つにつき1つ。
let career: Career | null = null;

/** 画面にそのまま出してよい日本語のエラー。 */
export class GameError extends Error {
  override name = "GameError";
}

function current(): Career {
  if (career === null) throw new GameError("まだゲームが始まっていません");
  return career;
}

// --------------------------------------------------------------- 立ち上げ

export interface CardInfo {
  label: string;
  visible_key: string;
  visible_gain: number;
  hidden_key: string;
  hidden_gain: number;
  issue: string;
}

export interface Bootstrap {
  formations: string[];
  attitudes: string[];
  default_plan: Plan;
  preset_plans: Record<string, Plan>;
  trainings_per_player: number;
  cards: Record<string, CardInfo>;
  forbidden_pairs: string[][];
  pitch: [number, number];
  players_on_pitch: number;
  policy_conditions: string[];
  policy_actions: string[];
  policy_max_rules: number;
  save_version: number;
  ticks_per_match: number;
}

/** 画面を組み立てるのに要る、変わらない情報をまとめて返す。 */
export function bootstrap(): Bootstrap {
  return {
    formations: Object.keys(FORMATIONS),
    attitudes: [...ATTITUDES],
    default_plan: defaultUserPlan(),
    preset_plans: Object.fromEntries(
      Object.entries(PRESET_PLANS).map(([name, plan]) => [name, { ...plan[0] }])),
    trainings_per_player: TRAININGS_PER_PLAYER,
    cards: Object.fromEntries(Object.entries(CARDS).map(([key, card]) => [key, {
      label: card.label,
      visible_key: card.visible_key,
      visible_gain: card.visible_gain,
      hidden_key: card.hidden_key,
      hidden_gain: card.hidden_gain,
      issue: issueText(key),
    }])),
    forbidden_pairs: [...FORBIDDEN_PAIRS].map((pair) => pair.split("+").sort()),
    pitch: [C.PITCH_X, C.PITCH_Y],
    players_on_pitch: C.PLAYERS_ON_PITCH,
    policy_conditions: [...POLICY_CONDITIONS],
    policy_actions: [...POLICY_ACTIONS],
    policy_max_rules: C.POLICY_MAX_RULES,
    save_version: SAVE_VERSION,
    ticks_per_match: C.TICKS_PER_MATCH,
  };
}

export function newGame(teamName: string, seed: number, formation: string,
                        plan: Plan | null = null): View {
  const name = (teamName ?? "").trim();
  if (!name) throw new GameError("チーム名を入れてください");
  career = Career.newGame(name, Math.trunc(Number(seed)), formation, plan);
  return view();
}

/**
 * localStorage から戻す。
 *
 * 🔴 欠けた項目を既定値で埋めない（`src/sim/career.ts` の方針）。
 *    埋めると「壊れたセーブで遊べてしまう」状態になり、
 *    どこから壊れたかを誰も追えなくなる。
 */
export function loadSave(raw: unknown): View {
  try {
    career = Career.fromDict(raw);
  } catch (e) {
    if (e instanceof SaveError || e instanceof ValueError || e instanceof TypeError) {
      throw new GameError(`セーブデータを読めません: ${e.message}`);
    }
    throw e;
  }
  return view();
}

export function hasGame(): boolean {
  return career !== null;
}

export function saveDict(): SaveData {
  // 🔑 画面側で値を書き換えても中身が変わらないよう、JSON を通した複製を渡す
  return JSON.parse(JSON.stringify(current().toDict())) as SaveData;
}

// ----------------------------------------------------------------- 画面の絵

export interface PlayerView {
  index: number;
  name: string;
  position: string;
  type: string;
  starter: boolean;
  visible: Record<string, number>;
  hidden: Record<string, number>;
  traits: Record<string, number>;
  roam_m: number;
  vision_m: number;
}

function playerView(index: number, p: Player, starter: boolean): PlayerView {
  return {
    index,
    name: p.name,
    position: p.position,
    type: p.typeName,          // 🔑 導出値。保存しない（D-07）
    starter,
    visible: p.visible,
    hidden: p.hidden,
    // 🔑 生まれ持った性質。特訓で動かないので、見える能力とは分けて出す
    traits: p.traits,
    roam_m: pyRoundN(p.roamM, 1),
    vision_m: pyRoundN(p.visionM, 1),
  };
}

export function squad(): PlayerView[] {
  const car = current();
  return [
    ...car.me.players.map((p, i) => playerView(i, p, true)),
    ...car.me.bench.map((p, j) => playerView(C.PLAYERS_ON_PITCH + j, p, false)),
  ];
}

export interface View {
  team: string;
  season: number;
  round: number;
  total_rounds: number;
  season_finished: boolean;
  rank: number;
  cards: Record<string, number>;
  card_total: number;
  next_fixture: Fixture | null;
  standings: StandingsRow[];
  squad: PlayerView[];
  tactics: { line_height: number; zone_width: number; attitude: string; formation: string };
  manager: { style: number; rigidity: number; substitution: number; selection: number };
  policy: { condition: string; action: string }[];
  history: SeasonSummary[];
  remaining: Fixture[][];
}

/** 画面が1回の描画で要るものを全部返す。 */
export function view(): View {
  const car = current();
  const me = car.me;
  const fixture = car.myNextMatch();
  return {
    team: car.user_team,
    season: car.season,
    round: car.round_index,
    total_rounds: car.totalRounds,
    season_finished: car.seasonFinished,
    rank: car.myRank(),
    cards: { ...car.cards },
    card_total: car.cardTotal(),
    next_fixture: fixture ? [fixture[0], fixture[1]] : null,
    standings: car.standings(),
    squad: squad(),
    tactics: {
      line_height: me.tactics.line_height,
      zone_width: me.tactics.zone_width,
      attitude: me.tactics.attitude,
      formation: me.tactics.formation,
    },
    manager: {
      style: me.manager.style,
      rigidity: me.manager.rigidity,
      substitution: me.manager.substitution,
      selection: me.manager.selection,
    },
    policy: me.policy.map((r) => ({ condition: r.condition, action: r.action })),
    history: [...car.history],
    remaining: car.schedule.slice(car.round_index).map((rnd) => rnd.map(([h, a]): Fixture => [h, a])),
  };
}

// ------------------------------------------------------------------- 操作

export interface PlayNextResult {
  view: View;
  round: number;
  of: number;
  score: [number, number];
  teams: [string, string];
  my_index: number;
  stats: MatchStatsOut[];
  events: MatchEvent[];
  replay: Replay;
  awarded: { key: string; label: string; issue: string }[];
  others: StoredMatchResult[];
}

/** 次の節を消化する。自チームの試合は**再生用の位置つき**で返る。 */
export function playNext(): PlayNextResult {
  const car = current();
  if (car.seasonFinished) throw new GameError("全節終了です。シーズンを締めてください");
  const outcome = car.playRound(true);
  const mine = outcome.mine;
  const match = mine.match;
  if (match.replay === undefined) throw new Error("再生用の位置が残っていない");
  return {
    view: view(),
    round: outcome.round,
    of: outcome.of,
    score: match.score,
    teams: match.teams,
    my_index: mine.my_index,
    stats: match.stats,
    events: match.events,
    replay: match.replay,
    awarded: mine.awarded.map((k) => ({ key: k, label: getCard(k).label, issue: issueText(k) })),
    others: outcome.others,
  };
}

export function train(playerIndex: number, cardKeys: string[]):
    { view: View; result: CareerTrainingResult; label: string } {
  const car = current();
  let result;
  try {
    result = car.trainPlayer(Math.trunc(Number(playerIndex)), cardKeys.map(String));
  } catch (e) {
    if (e instanceof ValueError) throw new GameError(e.message);
    throw e;
  }
  const label = cardKeys.length === 2 ? specialName(cardKeys[0]!, cardKeys[1]!)
                                      : getCard(cardKeys[0]!).label;
  return { view: view(), result, label };
}

/**
 * 先発と控えを入れ替える。
 *
 * 🔴 GK は GK としか入れ替えない。混ぜると `Team` の検査で落ちるが、
 *    画面側で先に弾いて**日本語で理由を出す**（例外の文面をそのまま見せない）。
 */
export function swapStarter(starterIndex: number, benchIndex: number): View {
  const me = current().me;
  if (!(starterIndex >= 0 && starterIndex < me.players.length)) {
    throw new GameError("先発の番号が範囲外です");
  }
  const benchSlot = benchIndex - C.PLAYERS_ON_PITCH;
  if (!(benchSlot >= 0 && benchSlot < me.bench.length)) throw new GameError("控えの番号が範囲外です");
  const outP = me.players[starterIndex]!;
  const inP = me.bench[benchSlot]!;
  if ((outP.position === "GK") !== (inP.position === "GK")) {
    throw new GameError("GK は GK としか入れ替えられません");
  }
  me.players[starterIndex] = inP;
  me.bench[benchSlot] = outP;
  return view();
}

export function setTactics(lineHeight: number, zoneWidth: number, attitude: string,
                           formation: string): View {
  const t = current().me.tactics;
  if (!(ATTITUDES as readonly string[]).includes(attitude)) throw new GameError(`未知の姿勢: ${attitude}`);
  if (!(formation in FORMATIONS)) throw new GameError(`未知のフォーメーション: ${formation}`);
  t.line_height = Math.max(1, Math.min(5, Math.trunc(Number(lineHeight))));
  t.zone_width = Math.max(1, Math.min(5, Math.trunc(Number(zoneWidth))));
  t.attitude = attitude;
  t.formation = formation;
  return view();
}

export function setManager(style: number, rigidity: number, substitution: number,
                           selection: number): View {
  const m = current().me.manager;
  const clamp = (v: number): number => Math.max(-2, Math.min(2, Math.trunc(Number(v))));
  m.style = clamp(style);
  m.rigidity = clamp(rigidity);
  m.substitution = clamp(substitution);
  m.selection = clamp(selection);
  return view();
}

/**
 * チーム方針を丸ごと差し替える。
 *
 * 🔴 未知の条件・行動を黙って捨てない。捨てるとプレイヤーは
 *    設定したつもりで効いていない状態になる。
 */
export function setPolicy(rules: { condition?: string; action?: string }[]): View {
  const car = current();
  if (rules.length > C.POLICY_MAX_RULES) {
    throw new GameError(`チーム方針は最大${C.POLICY_MAX_RULES}個です`);
  }
  const built: PolicyRule[] = [];
  for (const r of rules) {
    const cond = r.condition;
    const act = r.action;
    if (cond === undefined || !(POLICY_CONDITIONS as readonly string[]).includes(cond)) {
      throw new GameError(`未知の条件: ${String(cond)}`);
    }
    if (act === undefined || !(POLICY_ACTIONS as readonly string[]).includes(act)) {
      throw new GameError(`未知の行動: ${String(act)}`);
    }
    built.push(new PolicyRule(cond, act));
  }
  car.me.policy = built;
  return view();
}

export function finishSeason(): { view: View; summary: SeasonSummary } {
  const car = current();
  if (!car.seasonFinished) throw new GameError("まだ全節が終わっていません");
  const summary = car.finishSeason();
  return { view: view(), summary };
}

/** テストや「最初からやり直す」で、遊んでいるキャリアを捨てる。 */
export function reset(): void {
  career = null;
}
