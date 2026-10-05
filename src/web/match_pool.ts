/**
 * 1節の試合を別スレッドで並べて回す（D-51）。
 *
 * 🔑 新エンジンは1試合に数秒かかる（2026-10-05 の計測で 3.8秒）。4試合を順に回すと十数秒、
 *    並べて回せば1試合ぶんの時間で済む。
 * 🔑 結果は渡した順に並べて返す。どのスレッドで回っても、同じチーム・同じ種なら同じ結果（決定論）。
 * 🔴 Worker が使えない環境では止める（黙って画面のスレッドで十数秒固まるより、理由を出すほうがよい）。
 */

import type { MatchResult } from "../sim/engine.ts";
import type { MatchTask } from "./match_worker.ts";

/** 同時に動かすスレッドの上限 */
const MAX_WORKERS = 4;

export function runMatches(tasks: readonly Omit<MatchTask, "id">[]): Promise<MatchResult[]> {
  if (typeof Worker === "undefined") {
    return Promise.reject(new Error("このブラウザでは試合を別スレッドで計算できません（Web Worker が使えない）"));
  }
  const width = Math.max(1, Math.min(tasks.length, MAX_WORKERS,
                                     globalThis.navigator?.hardwareConcurrency ?? MAX_WORKERS));
  const results: (MatchResult | undefined)[] = new Array(tasks.length);
  let next = 0;
  let done = 0;
  return new Promise<MatchResult[]>((resolve, reject) => {
    const workers: Worker[] = [];
    const finish = (err?: Error): void => {
      for (const w of workers) w.terminate();
      if (err !== undefined) reject(err);
      else resolve(results as MatchResult[]);
    };
    const feed = (w: Worker): void => {
      if (next >= tasks.length) return;
      const id = next++;
      w.postMessage({ ...tasks[id]!, id });
    };
    for (let k = 0; k < width; k++) {
      // 🔑 URL は組み立てで版の刻印が付く（`scripts/build_web.ts`）。付けないと古い写しが読まれる
      const w = new Worker(new URL("./match_worker.js", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ id: number; result?: MatchResult; error?: string }>): void => {
        const { id, result, error } = e.data;
        if (error !== undefined || result === undefined) {
          finish(new Error(`試合の計算に失敗しました: ${error ?? "結果が空"}`));
          return;
        }
        results[id] = result;
        done += 1;
        if (done === tasks.length) finish();
        else feed(w);
      };
      w.onerror = (e): void => finish(new Error(`試合の計算スレッドが止まりました: ${e.message}`));
      workers.push(w);
      feed(w);
    }
  });
}
