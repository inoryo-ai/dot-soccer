/**
 * 手で画面を触るための開発サーバー（`npm run dev`）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ要るのか
 * ─────────────────────────────────────────────────────────────
 * 本番の配信物は `web/dist/` で、`npm run build:web` を通さないと作られない。
 * つまり `web/style.css` を1色いじるたびに**ビルドして、それから再読み込み**になる。
 * 色や余白を合わせる作業は「変える→見る」を何十回も繰り返すので、
 * この往復が入ると**手で詰めるのが現実的でなくなる**。
 *
 * ここは `web/` を先に見て、無ければ `web/dist/` へ落とす。
 * - `style.css` / `index.html` / `lab.html` … → `web/` の**書いたそのもの**が出る（保存→再読み込みで即反映）
 * - `js/web/main.js` など組み立てたコード → `web/dist/` から出る
 *
 * 🔑 だから **CSS と HTML は手で触れて、TypeScript は触らなくてよい**状態になる。
 *    TypeScript を変えたときだけ `npm run build:web` を回す。
 *
 * 🔴 これは**開発用で、配信物ではない**。本番に出すのは必ず `web/dist/`
 *    （コメントを落とし、版の刻印を入れたもの）。ここを本番に使わないこと。
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "web");          // 手で書くほう（こちらを優先）
const DIST = join(ROOT, "web", "dist"); // 組み立てたほう（JS はここ）

const PORT = Number(process.env.PORT ?? 4174);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * URL をファイルの場所に直す。
 *
 * 🔴 `..` で上の階層へ出させない。開発用でも、自分の端末の
 *    どのファイルでも読める穴を開けない。
 */
function resolveFile(urlPath: string): string | null {
  const clean = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const rel = normalize(clean).replace(/^([/\\])+/, "");
  if (rel.startsWith("..")) return null;
  const name = rel === "" ? "index.html" : rel;

  for (const base of [SRC, DIST]) {
    const p = join(base, name);
    if (!p.startsWith(base)) continue;          // 正規化しても外へ出ていないか
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

createServer((req, res) => {
  const file = resolveFile(req.url ?? "/");
  if (file === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("見つかりません");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    /* 🔴 開発中はキャッシュさせない。残ると「直したのに変わらない」で時間を溶かす */
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
}).listen(PORT, () => {
  const has = existsSync(join(DIST, "js", "web", "main.js"));
  console.log(`手で触る用のサーバー: http://localhost:${PORT}/`);
  console.log(`  画面（CSS・HTML）: web/            ← 保存して再読み込みすれば即反映`);
  console.log(`  組み立てたコード : web/dist/       ← TypeScript を変えたときだけ build:web`);
  if (!has) {
    console.log("");
    console.log("⚠ web/dist にコードがありません。先に `npm run build:web` を1回だけ実行してください。");
  }
});
