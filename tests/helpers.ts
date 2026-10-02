/** テストの共通部品。 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Python 版が書き出した正解データ（`tests/golden/*.json`）を読む。 */
export function golden<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, "tests", "golden", `${name}.json`), "utf8")) as T;
}
