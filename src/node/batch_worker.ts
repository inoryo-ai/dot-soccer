/** 一括対戦のワーカー。受け取った試合の束を回して、結果の束を返す。 */

import { parentPort } from "node:worker_threads";

import { runOne } from "../sim/batch.ts";
import type { Job } from "../sim/batch.ts";

if (parentPort === null) throw new Error("ワーカーとして起動されていない");
const port = parentPort;
port.on("message", (jobs: Job[]) => {
  port.postMessage(jobs.map((job) => runOne(job)));
});
