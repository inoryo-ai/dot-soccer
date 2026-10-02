/**
 * ブラウザへ配る一式を `web/dist/` に組み立てる。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 リポジトリをそのまま配信しない
 * ─────────────────────────────────────────────────────────────
 * 静的配信は「置いてあるものが全部公開される」。ルートごと配ると
 * `tests/` `scripts/` `saves/` まで公開される。
 * （カードショップEDENで実際に踏んだ形＝内部メモが `/cards/README.md` で公開されていた）
 *
 * だから**配るものを1か所で明示的に決める**。ここに書いていないファイルは出ない。
 *
 * 🔑 TypeScript は `tsconfig.web.json` で JS に直す。入口（src/web/main.ts）から
 *    たどれるファイルだけが出るので、端末用の `src/node/` `src/cli/` は出ない。
 *
 *     node scripts/build_web.ts          # 組み立て
 *     npx serve web/dist                 # などで配信して確かめる
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
         writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");
export const DIST = join(WEB, "dist");

export const STATIC_FILES = ["index.html", "style.css"] as const;

/** ブラウザで使う JS（`web/dist/js/` の下）。ここに無いものが出たら組み立て失敗。 */
export const EXPECTED_JS = [
  "sim/career.js", "sim/constants.js", "sim/detmath.js", "sim/engine.js", "sim/errors.js",
  "sim/league.js", "sim/model.js", "sim/presets.js", "sim/pymath.js", "sim/pyrandom.js",
  "sim/sha512.js", "sim/training.js",
  "web/api.js", "web/city.js", "web/fx.js", "web/iso.js", "web/main.js", "web/pitch.js",
  "web/room.js", "web/sprites.js",
] as const;

/**
 * 配信物からコメントを落とす。
 *
 * 🔑 HTML は `<!-- ... -->`、CSS は `/* ... *​/` だけを消す。
 *    どちらも**入れ子にできない**ので、いちばん短く一致させれば足りる。
 * 🔴 CSS の文字列の中に `/*` を書くと巻き込まれる。この画面では使っていないが、
 *    使うことになったら、ここを素朴な正規表現のままにしない。
 *    （検査 [10] が「配信物に禁止語が無いか」を見ているので、壊れれば気づける）
 */
export function stripComments(src: string, name: string): string {
  const out = name.endsWith(".html")
    ? src.replace(/<!--[\s\S]*?-->/g, "")
    : src.replace(/\/\*[\s\S]*?\*\//g, "");
  /* 空行が大量に残ると、消したことで逆に読みにくい配信物になる */
  return out.replace(/\n{3,}/g, "\n\n").replace(/^\s*\n/, "");
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}

export function build(log: (line: string) => void = (l) => console.log(l)): number {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const missing = STATIC_FILES.filter((f) => !existsSync(join(WEB, f)));
  if (missing.length > 0) {
    log(`❌ web/ に無いファイル: ${JSON.stringify(missing)}`);
    return 1;
  }
  /* ─────────────────────────────────────────────────────────────
   * 🔴 配るものからコメントを落とす
   * ─────────────────────────────────────────────────────────────
   * `index.html` と `style.css` は**そのまま配信される**。書いたコメントは
   * 全部そのまま公開される。2026-10-02 に、取引先の名前が1件入ったまま
   * 公開する一歩手前まで行った（以前にも内部メモを公開した前例がある）。
   *
   * 🔑 **禁止語の一覧で見張らない。** 一覧を持つと、その一覧自体が
   *    「書いてはいけない名前の集まり」としてリポジトリに残る。
   *    そもそもコメントを載せなければ、コメントからは何も漏れない。
   * 🔑 JS 側は `tsconfig.web.json` の `removeComments` が同じことをする。
   *    手元のソースは何も変わらない（配るものだけが変わる）。
   */
  for (const name of STATIC_FILES) {
    const src = readFileSync(join(WEB, name), "utf8");
    writeFileSync(join(DIST, name), stripComments(src, name), "utf8");
  }

  try {
    execFileSync(process.execPath,
                 [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p",
                  join(ROOT, "tsconfig.web.json")],
                 { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    const out = (e as { stdout?: Buffer }).stdout?.toString() ?? String(e);
    log(`❌ TypeScript を JS に直せない:\n${out}`);
    return 1;
  }

  const jsDir = join(DIST, "js");
  const jsFiles = listFiles(jsDir).map((p) => relative(jsDir, p).split("\\").join("/"));
  const extra = jsFiles.filter((f) => !(EXPECTED_JS as readonly string[]).includes(f));
  const lacking = EXPECTED_JS.filter((f) => !jsFiles.includes(f));
  if (extra.length > 0 || lacking.length > 0) {
    log(`❌ 配る JS が想定と違う（多い: ${JSON.stringify(extra)} / 足りない: ${JSON.stringify(lacking)}）`);
    log("   入口からたどれるファイルが変わったら、EXPECTED_JS を見直す");
    return 1;
  }

  // ----------------------------------------------------------- 版の刻印
  //
  // 🔴 **ブラウザは古いファイルを平気で使い回す。**
  //    2026-09-30 に実際に踏んだ: `model.py` だけキャッシュから読まれ、
  //    新しい `api.py` と混ざって `'Player' object has no attribute 'traits'` で落ちた。
  //    画面は普通に立ち上がるので、**混ざっていることに気づけない**。
  //
  // 🔑 中身から刻印を作り、読み込むURLに付ける。中身が変われば刻印が変わり、
  //    **古い写しが選ばれる余地が無くなる**。JS どうしの import にも付ける
  //    （付けないと、入口だけ新しくて中の部品が古い、が起きる）。
  const digest = createHash("sha256");
  for (const p of listFiles(DIST)) digest.update(readFileSync(p));
  const stamp = digest.digest("hex").slice(0, 12);

  // 🔑 置き換えは関数で書く（置き換え文字列の $ の扱いを間違えても例外が出ないため）
  const indexPath = join(DIST, "index.html");
  let index = readFileSync(indexPath, "utf8");
  index = index.replace(/(src|href)="([\w./-]+\.(?:js|css))"/g,
                        (_m, attr: string, path: string) => `${attr}="${path}?v=${stamp}"`);
  writeFileSync(indexPath, index, "utf8");
  for (const f of jsFiles) {
    const p = join(jsDir, f);
    const src = readFileSync(p, "utf8").replace(
      /(\bfrom\s*|\bimport\s*\(?\s*)"(\.{1,2}\/[\w./-]+\.js)"/g,
      (_m, head: string, path: string) => `${head}"${path}?v=${stamp}"`);
    writeFileSync(p, src, "utf8");
  }
  writeFileSync(join(DIST, "manifest.json"),
                `${JSON.stringify({ stamp, js: EXPECTED_JS }, null, 2)}\n`, "utf8");

  const files = listFiles(DIST).map((p) => relative(DIST, p).split("\\").join("/"));
  const total = files.reduce((a, f) => a + statSync(join(DIST, f)).size, 0);
  log(`✅ web/dist を作った — ${files.length}ファイル / ${Math.round(total / 1024)}KB`);
  for (const f of files) log(`   ${f}`);

  // 🔴 配ってはいけないものが混ざっていないか、その場で数える
  const leaked = files.filter((f) => /^(tests|scripts|saves|logs|out|tools)\//.test(f)
                                     || f.endsWith(".ts") || f.endsWith(".py")
                                     || /(^|\/)(node|cli)\//.test(f));
  if (leaked.length > 0) {
    log(`❌ 配ってはいけないものが混ざっている: ${JSON.stringify(leaked)}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = build();
}
