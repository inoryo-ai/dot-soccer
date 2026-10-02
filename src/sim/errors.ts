/**
 * エラーの種類。Python 版の ValueError / RuntimeError の区別をそのまま持つ。
 *
 * 🔑 画面（`src/cli/ui.ts`・`src/web/api.ts`）は **ValueError だけ**を捕まえて
 *    「⚠ 〜」と案内する。それ以外（RuntimeError や想定外のエラー）は
 *    こちらの不具合なので、握りつぶさずにそのまま上へ投げる。
 */

/** 入力や設定の値が正しくない（画面に出して直してもらう）。 */
export class ValueError extends Error {
  override name = "ValueError";
}

/** 起きてはいけない状態（日程が壊れている等）。画面で握りつぶさない。 */
export class RuntimeError extends Error {
  override name = "RuntimeError";
}
