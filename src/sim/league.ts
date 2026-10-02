/**
 * リーグの日程と順位表（ゲームとして遊べるようにするための層）。
 *
 * ここは**状態を持たない純関数だけ**にしている。日程・順位は結果から毎回導出する
 * （決定 D-07 と同じ理由。順位表を別に持つと、結果だけ直したときに食い違う）。
 */

import { ValueError } from "./errors.ts";
import { cmpStr, ljust, rjust } from "./pymath.ts";

export const WIN_POINTS = 3;
export const DRAW_POINTS = 1;

export type Fixture = [string, string];

// 1節あたりの試合数 = チーム数 / 2。チーム数は偶数でなければならない
// （奇数だと必ず1チームが休みになり、消化試合数が揃わない）。

/**
 * 総当たりの日程を作る（サークル法）。戻り値は [節][試合] = [ホーム, アウェー]。
 *
 * `double=true` なら後半戦でホームとアウェーを入れ替えた2回戦総当たりにする。
 */
export function buildSchedule(teams: readonly string[], double = true): Fixture[][] {
  if (teams.length < 2) throw new ValueError("リーグには2チーム以上が必要");
  if (teams.length % 2 !== 0) throw new ValueError(`チーム数は偶数でなければならない（今 ${teams.length}）`);

  const n = teams.length;
  let rotation = [...teams];
  const rounds: Fixture[][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Fixture[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = rotation[i]!;
      const b = rotation[n - 1 - i]!;
      // 節ごとにホームを入れ替えて、ホーム試合数を均す
      pairs.push((r + i) % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    rotation = [rotation[0]!, rotation[rotation.length - 1]!, ...rotation.slice(1, -1)];
  }

  if (double) {
    const second = rounds.map((rnd) => rnd.map(([home, away]): Fixture => [away, home]));
    rounds.push(...second);
  }
  return rounds;
}

export function matchesPerTeam(schedule: Fixture[][]): number {
  return schedule.length;
}

/** 順位表を作るのに要る**最小限**。これ以上を要求しない。 */
export interface MatchRecord {
  home: string;
  away: string;
  home_goals: number;
  away_goals: number;
}

/**
 * セーブに入る形（`Career.results` の1要素）。上に第何節かが付く。
 *
 * 🔑 順位表は `round` を読まない。読まないものを必須にすると、
 *    試しに順位表だけ作りたいときに嘘の値を埋めることになる。
 */
export interface StoredMatchResult extends MatchRecord {
  round: number;
}

/**
 * 順位表の1行。
 *
 * 🔑 `gd`（得失点差）と `rank` は導出値だが、**この関数の中で作ってその場で返すだけ**で
 *    どこにも保存しない。保存すると「結果を直したのに順位が古いまま」になる（D-07）。
 */
export interface StandingsRow {
  team: string;
  played: number;
  w: number;
  d: number;
  l: number;      // 敗。セーブ済みの履歴も同じ鍵なので名前を変えられない
  gf: number;
  ga: number;
  points: number;
  gd: number;
  rank: number;
}

/**
 * 結果から順位表を導出する。
 *
 * 並び順は 勝点 → 得失点差 → 得点 → チーム名（同値時も決定論的に決まる）。
 */
export function standings(teams: readonly string[], results: readonly MatchRecord[]): StandingsRow[] {
  const table = new Map<string, StandingsRow>();
  for (const t of teams) {
    table.set(t, { team: t, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, points: 0, gd: 0, rank: 0 });
  }
  for (const r of results) {
    const home = table.get(r.home);
    const away = table.get(r.away);
    if (home === undefined || away === undefined) {
      throw new ValueError(`順位表に無いチームの結果: ${r.home} vs ${r.away}`);
    }
    const hg = r.home_goals;
    const ag = r.away_goals;
    for (const [row, gf, ga] of [[home, hg, ag], [away, ag, hg]] as const) {
      row.played += 1;
      row.gf += gf;
      row.ga += ga;
    }
    if (hg > ag) {
      home.w += 1;
      away.l += 1;
      home.points += WIN_POINTS;
    } else if (hg < ag) {
      away.w += 1;
      home.l += 1;
      away.points += WIN_POINTS;
    } else {
      home.d += 1;
      away.d += 1;
      home.points += DRAW_POINTS;
      away.points += DRAW_POINTS;
    }
  }
  const rows = [...table.values()];
  for (const row of rows) row.gd = row.gf - row.ga;
  rows.sort((a, b) => (b.points - a.points) || (b.gd - a.gd) || (b.gf - a.gf)
                      || cmpStr(a.team, b.team));
  rows.forEach((row, i) => { row.rank = i + 1; });
  return rows;
}

const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

export function formatStandings(rows: readonly StandingsRow[], highlight: string | null = null): string {
  const width = Math.max(...rows.map((r) => [...r.team].length)) + 1;
  const lines = [
    `${rjust("順", 2)} ${ljust("チーム", width)}${rjust("試", 4)}${rjust("勝", 4)}${rjust("分", 4)}`
    + `${rjust("敗", 4)}${rjust("得", 5)}${rjust("失", 5)}${rjust("差", 5)}${rjust("点", 5)}`,
  ];
  for (const r of rows) {
    const mark = r.team === highlight ? "◆" : " ";
    lines.push(
      `${rjust(String(r.rank), 2)}${mark}${ljust(r.team, width)}${rjust(String(r.played), 4)}`
      + `${rjust(String(r.w), 4)}${rjust(String(r.d), 4)}${rjust(String(r.l), 4)}`
      + `${rjust(String(r.gf), 5)}${rjust(String(r.ga), 5)}${rjust(sign(r.gd), 5)}`
      + `${rjust(String(r.points), 5)}`,
    );
  }
  return lines.join("\n");
}
