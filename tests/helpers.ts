/** テストの共通部品。 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Python 版が書き出した正解データ（`tests/golden/*.json`）を読む。 */
export function golden<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, "tests", "golden", `${name}.json`), "utf8")) as T;
}

/**
 * 記録に出てくる一時フォルダの名前を `<SAVE_DIR>` に置き換える。
 *
 * 🔴 **区切り文字も `/` へそろえる。** そろえないと正解データが OS に縛られる
 *    （Windows は `<SAVE_DIR>\s.json`、Mac/Linux は `<SAVE_DIR>/s.json` になり、
 *    片方で作った正解データが、もう片方では必ず1行ずれて落ちる）。
 * 🔑 置き換えた部分だけを直す。記録の他の場所にある `\` は触らない。
 * 🔑 正解データを作る側（`scripts/gen_golden.ts`）と照合する側（`tests/cli.test.ts`）が
 *    **同じこの関数を使う**。別々に書くとまたズレる。
 */
export function maskSaveDir(line: string, dir: string): string {
  return line.replaceAll(dir, "<SAVE_DIR>").replaceAll("<SAVE_DIR>\\", "<SAVE_DIR>/");
}
