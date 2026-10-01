"""ブラウザへ配る一式を `web/dist/` に組み立てる。

─────────────────────────────────────────────────────────────
🔴 リポジトリをそのまま配信しない
─────────────────────────────────────────────────────────────
静的配信は「置いてあるものが全部公開される」。ルートごと配ると
`tests/` `scripts/` `saves/` まで公開される。
（カードショップEDENで実際に踏んだ形＝内部メモが `/cards/README.md` で公開されていた）

だから**配るものを1か所で明示的に決める**。ここに書いていないファイルは出ない。

🔑 `sim/` は**コピーする**。ブラウザからは Python のファイルを1つずつ取ってきて
   Pyodide のファイルシステムへ置くため、配信ディレクトリの下に無いと読めない。
   正本は `sim/` のままで、`dist` は毎回作り直す使い捨て（`.gitignore` 済み）。

    python scripts/build_web.py          # 組み立て
    python -m http.server -d web/dist 8000
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import sys
from pathlib import Path

# 🔑 Windows の既定は cp932 で、✅ や日本語の結果が出力できずに落ちる
#    （`scripts/check_project.py` と同じ理由）
if isinstance(sys.stdout, io.TextIOWrapper):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DIST = WEB / "dist"

# 🔴 ブラウザで動かすのに要る Python だけ。
#    `ui.py`（端末の対話画面）・`batch.py`・`__main__.py` は配らない。
#    配っても動かないうえ、読む人に「これも使われている」と誤解させる。
SIM_MODULES = (
    "__init__.py",
    "constants.py",
    "model.py",
    "training.py",
    "engine.py",
    "presets.py",
    "league.py",
    "career.py",
)

STATIC_FILES = ("index.html", "style.css", "sprites.js", "bridge.js", "pitch.js", "main.js")


def build() -> int:
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "py" / "sim").mkdir(parents=True)

    missing = [f for f in STATIC_FILES if not (WEB / f).exists()]
    if missing:
        print(f"❌ web/ に無いファイル: {missing}")
        return 1

    for name in STATIC_FILES:
        shutil.copy2(WEB / name, DIST / name)

    for name in SIM_MODULES:
        src = ROOT / "sim" / name
        if not src.exists():
            print(f"❌ sim/{name} が無い")
            return 1
        shutil.copy2(src, DIST / "py" / "sim" / name)

    shutil.copy2(WEB / "api.py", DIST / "py" / "api.py")

    # ----------------------------------------------------------- 版の刻印
    #
    # 🔴 **ブラウザは古いファイルを平気で使い回す。**
    #    2026-09-30 に実際に踏んだ: `model.py` だけキャッシュから読まれ、
    #    新しい `api.py` と混ざって `'Player' object has no attribute 'traits'` で落ちた。
    #    画面は普通に立ち上がるので、**混ざっていることに気づけない**。
    #
    # 🔑 中身から刻印を作り、取りに行くURLに付ける。
    #    中身が変われば刻印が変わり、**古い写しが選ばれる余地が無くなる**。
    #    「再読み込みしてください」と案内で済ませない（人は必ず忘れる）。
    digest = hashlib.sha256()
    for path in sorted(DIST.rglob("*")):
        if path.is_file():
            digest.update(path.read_bytes())
    stamp = digest.hexdigest()[:12]

    # 画面のファイル（js/css）にも刻印を付ける。同じ理由で混ざる。
    #
    # 🔑 後方参照（バックスラッシュ＋数字）を使わず、置き換えを関数で書く。
    #    置き換え文字列のエスケープは間違えやすく、**間違えても例外が出ない**。
    #    実際に制御文字が埋まり、`<script ="?v=...">` という壊れたタグを出したまま
    #    「組み立て成功」と表示していた（2026-09-30）。
    index = (DIST / "index.html").read_text(encoding="utf-8")
    index = re.sub(r'(src|href)="([\w.-]+\.(?:js|css))"',
                   lambda m: f'{m.group(1)}="{m.group(2)}?v={stamp}"', index)
    (DIST / "index.html").write_text(index, encoding="utf-8")

    manifest = {
        "stamp": stamp,
        "sim": list(SIM_MODULES),
        "top": ["api.py"],
    }
    (DIST / "py" / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    files = sorted(p.relative_to(DIST).as_posix() for p in DIST.rglob("*") if p.is_file())
    total = sum((DIST / f).stat().st_size for f in files)
    print(f"✅ web/dist を作った — {len(files)}ファイル / {total / 1024:.0f}KB")
    for f in files:
        print(f"   {f}")

    # 🔴 配ってはいけないものが混ざっていないか、その場で数える
    leaked = [f for f in files
              if f.startswith(("tests/", "scripts/", "saves/", "logs/", "out/"))
              or f.endswith((".pyc", ".json.bak"))
              or "__pycache__" in f]
    if leaked:
        print(f"❌ 配ってはいけないものが混ざっている: {leaked}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(build())
