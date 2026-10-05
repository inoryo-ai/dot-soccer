/**
 * 試合を1つ回す別スレッド（Web Worker・D-51）。
 *
 * 🔑 新エンジン（0.1秒・サイコロなし）は1試合に数秒かかる。画面のスレッドで回すと、その間ボタンも
 *    アニメーションも止まる。1節の4試合をここで並べて回す（`match_pool.ts`）。
 * 🔑 受け取るのはチームの辞書（`Team.toDict`）。同じ辞書・同じ種なら、画面のスレッドで回しても同じ結果（決定論）。
 * 🔴 ここもゲームの規則を1行も持たない。`playNew` を呼ぶだけ。
 */

import { playNew } from "../sim/match/game.ts";
import { Team } from "../sim/model.ts";
import type { TeamData } from "../sim/model.ts";

export interface MatchTask {
  id: number;
  home: TeamData;
  away: TeamData;
  seed: number;
  log: boolean;
  record: boolean;
}

/** Worker の中の自分（DOM の型には Worker 側の `postMessage` が無いので、使う形だけ書く） */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MatchTask>) => void) | null;
  postMessage(message: unknown): void;
};

ctx.onmessage = (e: MessageEvent<MatchTask>): void => {
  const t = e.data;
  try {
    const result = playNew(Team.fromDict(t.home), Team.fromDict(t.away), t.seed, t.log, t.record);
    ctx.postMessage({ id: t.id, result });
  } catch (err) {
    // 🔴 握りつぶさない。画面に理由を返す
    ctx.postMessage({ id: t.id, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
  }
};
