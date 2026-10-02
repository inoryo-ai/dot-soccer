/**
 * 一括対戦を複数のスレッドで回す（Python 版の multiprocessing.Pool の代わり）。
 *
 * 🔑 シードは試合ごとに `seedFor` で決まるので、何本のスレッドでどの順に回しても
 *    集計結果は同じ（`tests/batch.test.ts` が並列と直列の一致を確かめる）。
 */

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

import { buildJobs, runBatchSerial, summarize } from "../sim/batch.ts";
import type { BatchSummary, Job, JobResult } from "../sim/batch.ts";
import { PRESET_ORDER } from "../sim/presets.ts";

const CHUNK = 8;

export async function runBatch(matchesPerPair: number, baseSeed: number,
                               workers: number | null = null,
                               teams: readonly string[] = PRESET_ORDER,
                               progress?: (done: number, total: number) => void,
): Promise<BatchSummary> {
  const n = workers ?? Math.max(1, availableParallelism() - 1);
  if (n <= 1) return runBatchSerial(matchesPerPair, baseSeed, teams, progress);

  const jobs = buildJobs(matchesPerPair, baseSeed, teams);
  const chunks: Job[][] = [];
  for (let i = 0; i < jobs.length; i += CHUNK) chunks.push(jobs.slice(i, i + CHUNK));

  const results: JobResult[] = [];
  let next = 0;
  let lastReported = 0;
  const url = new URL("./batch_worker.ts", import.meta.url);

  await Promise.all(Array.from({ length: Math.min(n, chunks.length) }, () =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(url);
      const feed = (): void => {
        if (next >= chunks.length) {
          void worker.terminate().then(() => resolve());
          return;
        }
        worker.postMessage(chunks[next++]);
      };
      worker.on("message", (done: JobResult[]) => {
        results.push(...done);
        if (progress) {
          // 50試合ごとに知らせる（Python 版と同じ間隔）
          while (results.length - lastReported >= 50) {
            lastReported += 50;
            progress(lastReported, jobs.length);
          }
        }
        feed();
      });
      worker.on("error", reject);
      feed();
    })));

  return summarize(results, teams, matchesPerPair, baseSeed);
}
