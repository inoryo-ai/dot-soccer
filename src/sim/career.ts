/**
 * キャリア（ゲームとしての進行）。試合エンジンの上に「遊びのループ」を載せる層。
 *
 *     試合に出す → 課題が出る → 特訓カードをもらう → 選手を育てる → 次の節
 *
 * 画面（入出力）はここに書かない。`src/cli/ui.ts` と `src/web/` が対話を担当し、
 * この層は**状態と規則だけ**を持つ。分けているのは、対話を挟まずにテストから1シーズン
 * 最後まで歩けるようにするため（台帳「自分が作った導線を、自分で最初から最後まで一度歩く」）。
 *
 * 🔑 ファイルへの保存・読み込みは `src/node/files.ts` にある（ブラウザでは使えないため）。
 */

import { RuntimeError, ValueError } from "./errors.ts";
import * as C from "./constants.ts";
import { seedFor } from "./engine.ts";
import type { MatchResult } from "./engine.ts";
// 🔑 D-51: 試合は新エンジン（0.1秒・サイコロなし）。旧エンジン（engine.ts の play）はゲームから外した
import { playNew as play } from "./match/game.ts";
import { buildSchedule, standings } from "./league.ts";
import type { Fixture, StandingsRow, StoredMatchResult } from "./league.ts";
import { Team } from "./model.ts";
import type { TeamData } from "./model.ts";
import { ALL_PLAN_CARDS, LEAGUE_OPPONENTS, buildPreset, buildUserTeam } from "./presets.ts";
import type { Plan } from "./presets.ts";
import { CARDS, applyTraining, getCard } from "./training.ts";
import type { TrainingResult } from "./training.ts";
import { cmpStr } from "./pymath.ts";

// 🔴 **選手に生まれ持った性質（cover_range / vision_range）が増えたので版を上げた**
//    （2026-09-30・D-11）。欠けた項目を既定値で埋めない方針なので、
//    v1 のセーブは読めない＝「最初からやり直す」しかない。
//    デモ段階なので移行は作らない。作るなら、読めない理由を画面に出すだけでは足りず、
//    **何をすればよいか**まで書くこと（いまは `src/web/main.ts` が案内している）。
export const SAVE_VERSION = 2;
export const SAVE_KEYS = ["version", "seed", "user_team", "season", "round_index",
                          "cards", "results", "history", "teams"] as const;

/** セーブデータが読めない。既定値で埋めずに必ず落とす（壊れたまま遊ばせない）。 */
export class SaveError extends Error {
  override name = "SaveError";
}

export interface SeasonSummary {
  season: number;
  rank: number;
  table: StandingsRow[];
}

export interface MyMatch {
  match: MatchResult;
  record: StoredMatchResult;
  my_index: number;
  awarded: string[];
}

/** 1節の試合1つぶんの仕事（画面はこれを別スレッドで並べて回す・D-51） */
export interface RoundJob {
  home: string;
  away: string;
  seed: number;
  /** 自チームの試合（出来事とリプレイを残す） */
  mine: boolean;
}

export interface RoundOutcome {
  mine: MyMatch;
  others: StoredMatchResult[];
  round: number;
  of: number;
}

export interface CareerTrainingResult extends TrainingResult {
  player: string;
  visible_before: Record<string, number>;
  hidden_before: Record<string, number>;
}

export interface SaveData {
  version: number;
  seed: number;
  user_team: string;
  season: number;
  round_index: number;
  cards: Record<string, number>;
  results: StoredMatchResult[];
  history: SeasonSummary[];
  teams: Record<string, TeamData>;
}

/** 名前の並びを Python の dict と同じ「入れた順」で持つ（日程・保存の順に効く）。 */
export type TeamMap = Map<string, Team>;

export class Career {
  seed: number;
  user_team: string;
  teams: TeamMap;
  season = 1;
  round_index = 0;
  cards: Record<string, number> = {};
  results: StoredMatchResult[] = [];
  history: SeasonSummary[] = [];

  constructor(seed: number, userTeam: string, teams: TeamMap) {
    this.seed = seed;
    this.user_team = userTeam;
    this.teams = teams;
  }

  // ------------------------------------------------------------ 組み立て
  static newGame(teamName: string, seed: number, formation = "4-4-2",
                 plan: Plan | null = null): Career {
    const teams: TeamMap = new Map([[teamName, buildUserTeam(teamName, seed, formation, plan)]]);
    for (const name of LEAGUE_OPPONENTS) {
      if (name === teamName) throw new ValueError(`「${name}」はAIチームの名前なので使えない`);
      teams.set(name, buildPreset(name));
    }
    return new Career(seed, teamName, teams);
  }

  // ------------------------------------------------------------ 導出情報
  /** 日程を組む順。自チームを先頭に固定する（順を変えると日程が変わる）。 */
  get teamNames(): string[] {
    return [this.user_team, ...LEAGUE_OPPONENTS.filter((n) => n !== this.user_team)];
  }

  get schedule(): Fixture[][] {
    return buildSchedule(this.teamNames, C.LEAGUE_DOUBLE_ROUND);
  }

  get totalRounds(): number {
    return this.schedule.length;
  }

  get seasonFinished(): boolean {
    return this.round_index >= this.totalRounds;
  }

  get me(): Team {
    return this.team(this.user_team);
  }

  team(name: string): Team {
    const t = this.teams.get(name);
    if (t === undefined) throw new RuntimeError(`チーム「${name}」がいない`);
    return t;
  }

  standings(): StandingsRow[] {
    return standings(this.teamNames, this.results);
  }

  myRank(): number {
    for (const row of this.standings()) {
      if (row.team === this.user_team) return row.rank;
    }
    throw new RuntimeError("順位表に自チームがいない");
  }

  nextFixtures(): Fixture[] {
    if (this.seasonFinished) return [];
    return this.schedule[this.round_index]!;
  }

  myNextMatch(): Fixture | null {
    for (const [home, away] of this.nextFixtures()) {
      if (home === this.user_team || away === this.user_team) return [home, away];
    }
    return null;
  }

  cardTotal(): number {
    return Object.values(this.cards).reduce((a, b) => a + b, 0);
  }

  // ------------------------------------------------------------ 進行
  /**
   * 試合ごとに決定論的なシードを導出する（D-08）。
   *
   * 同じセーブ・同じ節・同じ試合なら必ず同じシード＝結果が再現する。
   */
  private matchSeed(roundIndex: number, matchIndex: number): number {
    return seedFor(this.seed, this.season, roundIndex * 16 + matchIndex, false);
  }

  /**
   * 現在の節を全試合消化する。戻り値は自チームの試合の詳細と他会場のスコア。
   *
   * 🔑 `withReplay=true` でも位置を残すのは**自チームの試合だけ**。
   *    他会場まで残すと1節あたり4試合分（約800KB）になり、
   *    画面で使わないデータが端末のセーブを押し出す。
   * 🔴 記録の有無で試合結果は変わらない（`tests/replay.test.ts`）。
   */
  playRound(withReplay = false): RoundOutcome {
    const jobs = this.roundJobs();
    return this.applyRound(jobs.map((j) =>
      play(this.team(j.home), this.team(j.away), j.seed, j.mine, withReplay && j.mine)));
  }

  /**
   * 次の節の試合の並び（まだ回さない）。🔑 新エンジンは1試合に数秒かかるので、画面はこれを
   * 別スレッドで並べて回し、結果を `applyRound` に渡す（D-51）。並びと種は `playRound` と同じ
   */
  roundJobs(): RoundJob[] {
    if (this.seasonFinished) throw new RuntimeError("シーズンは終わっている（finishSeason を呼ぶ）");
    return this.nextFixtures().map(([home, away], i) => ({
      home, away, seed: this.matchSeed(this.round_index, i),
      mine: home === this.user_team || away === this.user_team,
    }));
  }

  /** `roundJobs` の順に並んだ結果で、節を進める（結果・カード・順位） */
  applyRound(results: readonly MatchResult[]): RoundOutcome {
    const jobs = this.roundJobs();
    if (results.length !== jobs.length) throw new ValueError(`結果の数が試合の数と違う: ${results.length} / ${jobs.length}`);
    let myResult: MyMatch | null = null;
    const others: StoredMatchResult[] = [];
    for (const [i, { home, away, mine }] of jobs.entries()) {
      const res = results[i]!;
      if (res.teams[0] !== home || res.teams[1] !== away) {
        throw new ValueError(`${i}番目の結果が別の試合: ${res.teams.join(" - ")}（予定 ${home} - ${away}）`);
      }
      const record: StoredMatchResult = {
        home, away, home_goals: res.score[0], away_goals: res.score[1],
        round: this.round_index + 1,
      };
      this.results.push(record);
      if (mine) {
        const myIndex = home === this.user_team ? 0 : 1;
        const awarded = this.awardCards(res.issues[myIndex]!);
        myResult = { match: res, record, my_index: myIndex, awarded };
      } else {
        others.push(record);
      }
    }
    this.round_index += 1;
    if (myResult === null) throw new RuntimeError("自チームの試合が節に含まれていない（日程が壊れている）");
    return { mine: myResult, others, round: this.round_index, of: this.totalRounds };
  }

  private awardCards(issueKeys: string[]): string[] {
    const awarded: string[] = [];
    for (const key of issueKeys) {
      if (!(key in CARDS)) throw new ValueError(`未知のカード: ${key}`);
      if ((this.cards[key] ?? 0) >= C.MAX_CARD_STOCK) continue;
      this.cards[key] = (this.cards[key] ?? 0) + 1;
      awarded.push(key);
    }
    return awarded;
  }

  /** 所持カードを使って選手を育てる。カードは消費される。 */
  trainPlayer(playerIndex: number, cardKeys: string[]): CareerTrainingResult {
    const squad = this.me.allPlayers;
    if (!(Number.isInteger(playerIndex) && playerIndex >= 0 && playerIndex < squad.length)) {
      throw new ValueError(`選手番号が範囲外: ${playerIndex}`);
    }
    if (!(cardKeys.length >= 1 && cardKeys.length <= 2)) {
      throw new ValueError("カードは1枚（通常）か2枚（スペシャル）");
    }
    const sameCardTwice = cardKeys.length === 2 && cardKeys[0] === cardKeys[1];
    if (sameCardTwice && (this.cards[cardKeys[0]!] ?? 0) < 2) {
      throw new ValueError(`「${getCard(cardKeys[0]!).label}」が2枚必要`);
    }
    for (const key of new Set(cardKeys)) {
      const need = cardKeys.filter((k) => k === key).length;
      if ((this.cards[key] ?? 0) < need) {
        throw new ValueError(`「${getCard(key).label}」の所持が足りない`);
      }
    }
    const player = squad[playerIndex]!;
    const visibleBefore = { ...player.visible };
    const hiddenBefore = { ...player.hidden };
    const result = applyTraining(player, cardKeys);     // 相反カードはここで弾かれる
    for (const key of cardKeys) {
      this.cards[key] = (this.cards[key] ?? 0) - 1;
      if (this.cards[key]! <= 0) delete this.cards[key];
    }
    return { ...result, player: player.name, visible_before: visibleBefore,
             hidden_before: hiddenBefore };
  }

  /** シーズンを締めて次シーズンへ。AIチームもここで成長する。 */
  finishSeason(): SeasonSummary {
    if (!this.seasonFinished) throw new RuntimeError("まだ全節が終わっていない");
    const table = this.standings();
    const summary: SeasonSummary = {
      season: this.season,
      rank: this.myRank(),
      // 🔑 順位表の行をそのまま持つ。以前は10項目を1つずつ書き写していたが、
      //    行の中身と同じものを作り直しているだけで、写し間違いの余地しか無かった
      table: [...table],
    };
    this.history.push(summary);
    this.growAiTeams();
    this.season += 1;
    this.round_index = 0;
    this.results = [];
    return summary;
  }

  /**
   * AIチームを自分の型に沿って成長させる。
   *
   * プレイヤーだけが育つと、2シーズン目以降が一方的になる。
   * 回数は全AIチームで同じ（`AI_TRAININGS_PER_SEASON`）にして、
   * **伸びる方向だけ**がチームごとに違う形にしている。
   */
  private growAiTeams(): void {
    for (const [name, team] of this.teams) {
      if (name === this.user_team) continue;
      const plan = ALL_PLAN_CARDS[name];
      if (plan === undefined) continue;
      const offset = (this.season - 1) * C.AI_TRAININGS_PER_SEASON;
      const picks: string[] = [];
      for (let i = 0; i < C.AI_TRAININGS_PER_SEASON; i++) {
        picks.push(plan[(offset + i) % plan.length]!);
      }
      for (const p of team.allPlayers) {
        if (p.position === "GK") continue;
        for (const cardKey of picks) applyTraining(p, [cardKey]);
      }
    }
  }

  // ------------------------------------------------------------ 保存
  toDict(): SaveData {
    const cards: Record<string, number> = {};
    for (const k of Object.keys(this.cards).sort(cmpStr)) cards[k] = this.cards[k]!;
    const teams: Record<string, TeamData> = {};
    for (const [name, team] of this.teams) teams[name] = team.toDict();
    return {
      version: SAVE_VERSION,
      seed: this.seed,
      user_team: this.user_team,
      season: this.season,
      round_index: this.round_index,
      cards,
      results: this.results,
      history: this.history,
      teams,
    };
  }

  static fromDict(d: unknown): Career {
    if (d === null || typeof d !== "object" || Array.isArray(d)) {
      throw new SaveError("セーブデータの形が違う（オブジェクトでない）");
    }
    const raw = d as Record<string, unknown>;
    const missing = SAVE_KEYS.filter((k) => !(k in raw));
    if (missing.length > 0) {
      throw new SaveError(`セーブデータに項目が足りない: ${JSON.stringify(missing)}`);
    }
    if (raw.version !== SAVE_VERSION) {
      throw new SaveError(
        `セーブデータの形式が違う（保存 v${String(raw.version)} / 対応 v${SAVE_VERSION}）`);
    }
    const data = raw as unknown as SaveData;
    const teams: TeamMap = new Map();
    for (const [name, t] of Object.entries(data.teams)) teams.set(name, Team.fromDict(t));
    if (!teams.has(data.user_team)) {
      throw new SaveError(`自チーム「${data.user_team}」がセーブデータに無い`);
    }
    for (const key of Object.keys(data.cards)) {
      if (!(key in CARDS)) throw new SaveError(`セーブデータに未知のカード: ${key}`);
    }
    const car = new Career(data.seed, data.user_team, teams);
    car.season = data.season;
    car.round_index = data.round_index;
    car.cards = { ...data.cards };
    car.results = [...data.results];
    car.history = [...data.history];
    return car;
  }
}
