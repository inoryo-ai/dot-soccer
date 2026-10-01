"""公開・提出の前に機械で止める検査。

学習台帳（`ino_company/docs/loop-learnings.md`）の昇格ルールに従い、
このループで**実際に踏んだ失敗**を人の注意力に頼らず止める形にしている。

    python scripts/check_project.py

各検査は「どこから何件読んだか」を必ず出す（件数の無い検査は、
その検査が空振りしていないことを誰も確認できない）。
"""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
# 🔑 Windows の既定は cp932 で、日本語の検査結果が出力できずに落ちる。
#    差し替えられている（テストが捕まえている）場合は触らない
if isinstance(sys.stdout, io.TextIOWrapper):
    sys.stdout.reconfigure(encoding="utf-8")

from sim import constants as C  # noqa: E402
from sim.model import load_team  # noqa: E402
from sim.presets import check_no_clamping  # noqa: E402
from sim.training import CARDS, FORBIDDEN_PAIRS, SPECIAL_NAMES  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts"))
import measure  # noqa: E402

DUMMY_MARKERS = ("TODO", "FIXME", "XXX", "あとで直す", "仮の値", "ダミー", "0120-XXX")
failures: list[str] = []


def ok(msg: str) -> None:
    print(f"  ✅ {msg}")


def bad(msg: str) -> None:
    failures.append(msg)
    print(f"  ❌ {msg}")


def check_dummy_values() -> None:
    """未確定値・書き置きを残したまま提出しない（台帳: 黒瀬[2回]・機械化済み項目の移植）。"""
    # この検査自身は対象外（探す語そのものを持っているため、必ず自分に当たる）
    files = [f for f in sorted((ROOT / "sim").glob("*.py"))
             + sorted((ROOT / "scripts").glob("*.py"))
             if f.resolve() != Path(__file__).resolve()]
    print("[1] ダミー値・書き置きの検査 — "
          f"{ROOT / 'sim'} と {ROOT / 'scripts'} から {len(files)}ファイル")
    hits = []
    for f in files:
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            for marker in DUMMY_MARKERS:
                if marker in line:
                    hits.append(f"{f.name}:{i} {marker}")
    if hits:
        for h in hits:
            bad(f"未確定値が残っている: {h}")
    else:
        ok(f"{len(files)}ファイルに未確定値なし")


def check_constants_invariants() -> None:
    """定数どうしの関係が壊れていないか。どれも実際に踏んで初めて分かった条件。"""
    print("[2] 定数の不変条件 — sim/constants.py から 5項目")
    if C.PRESS_STANDOFF_M > C.TACKLE_RADIUS_M:
        ok(f"寄せの間合い {C.PRESS_STANDOFF_M}m > 奪い合いの距離 {C.TACKLE_RADIUS_M}m")
    else:
        bad(f"寄せの間合い {C.PRESS_STANDOFF_M}m が奪い合いの距離 {C.TACKLE_RADIUS_M}m の内側"
            "（全員が毎秒奪い合いに参加する。実測で1試合4,081回になった）")
    if C.TICKS_PER_MATCH == C.TICKS_PER_HALF * 2 == 5400:
        ok("90分 = 5400ティック（前後半 2700 ずつ）")
    else:
        bad(f"試合の長さが 5400 ティックでない: {C.TICKS_PER_MATCH}")
    if 0 < C.TYPE_THRESHOLD <= C.HIDDEN_MAX:
        ok(f"タイプ判定の閾値 {C.TYPE_THRESHOLD} が範囲内")
    else:
        bad(f"タイプ判定の閾値が異常: {C.TYPE_THRESHOLD}")
    if C.BATCH_WIN_RATE_WARN_LOW < 0.5 < C.BATCH_WIN_RATE_WARN_HIGH:
        ok(f"勝率警告は床 {C.BATCH_WIN_RATE_WARN_LOW:.0%} と天井 "
           f"{C.BATCH_WIN_RATE_WARN_HIGH:.0%} の両方を見ている")
    else:
        bad("勝率警告が片側しか見ていない（弱すぎるチームを見逃す）")
    if C.ACTION_CONTROL_TICKS >= 1 and C.TACKLE_COOLDOWN_TICKS >= 1:
        ok("1回の行動に秒数が設定されている")
    else:
        bad("行動が毎ティック起きる設定になっている（スタッツが現実離れする）")


def check_league_setup() -> None:
    """リーグが組めるか。奇数チームだと必ず1チームが休みになり消化試合数が揃わない。"""
    from sim.career import SAVE_VERSION
    from sim.presets import LEAGUE_OPPONENTS, PRESET_ORDER, build_preset, expected_ability_total
    n = len(LEAGUE_OPPONENTS) + 1                    # ＋自チーム
    print(f"[6] リーグ編成 — 自チーム＋AI {len(LEAGUE_OPPONENTS)}チーム = {n}チーム")
    if n % 2 == 0:
        ok(f"{n}チーム（偶数）＝全チームが同じ試合数を消化できる")
    else:
        bad(f"{n}チーム（奇数）＝日程が組めない")
    if LEAGUE_OPPONENTS[:len(PRESET_ORDER)] == PRESET_ORDER:
        ok(f"batch の勝率表は要件どおり {len(PRESET_ORDER)}チームのまま"
           "（リーグ用の追加に引きずられていない）")
    else:
        bad("batch のプリセット構成が変わっている（提出済みの勝率表と前提がずれる）")
    expected = expected_ability_total()
    off = [n2 for n2 in LEAGUE_OPPONENTS if build_preset(n2).ability_total() != expected]
    if off:
        bad(f"能力合計が揃っていないAIチーム: {off}")
    else:
        ok(f"AI {len(LEAGUE_OPPONENTS)}チームの能力合計が {expected} で一致")
    if isinstance(SAVE_VERSION, int) and SAVE_VERSION >= 1:
        ok(f"セーブ形式 v{SAVE_VERSION}")
    else:
        bad(f"セーブ形式の版が異常: {SAVE_VERSION}")


def check_data_files() -> None:
    """data/ の実物を読む。タイプ（導出値）が書かれていたら落とす（D-07）。"""
    paths = sorted((ROOT / "data").glob("*.json"))
    print(f"[3] チームJSONの検査 — {ROOT / 'data'} から {len(paths)}ファイル")
    if not paths:
        bad("data/ にチームJSONが1件も無い（`python -m sim presets` を実行する）")
        return
    players = 0
    for p in paths:
        raw = json.loads(p.read_text(encoding="utf-8"))
        for entry in raw["players"] + raw.get("bench", []):
            players += 1
            if "type" in entry:
                bad(f"{p.name}: 選手 {entry.get('name')} にタイプが保存されている（D-07違反）")
        try:
            team = load_team(p)
        except Exception as e:
            bad(f"{p.name}: 読み込めない: {e}")
            continue
        if len(team.players) != C.PLAYERS_ON_PITCH:
            bad(f"{p.name}: 先発が {len(team.players)}人")
    ok(f"{len(paths)}ファイル・{players}選手を実際に読んで検査した")


def check_special_names() -> None:
    keys = list(CARDS)
    all_pairs = {frozenset({a, b}) for i, a in enumerate(keys) for b in keys[i + 1:]}
    print(f"[4] スペシャル名の検査 — カード{len(keys)}枚の組み合わせ {len(all_pairs)}種")
    missing = all_pairs - set(SPECIAL_NAMES) - FORBIDDEN_PAIRS
    extra = set(SPECIAL_NAMES) & FORBIDDEN_PAIRS
    if missing:
        bad(f"名前の無い組み合わせ: {[sorted(m) for m in missing]}")
    if extra:
        bad(f"相反する組に名前が付いている: {[sorted(e) for e in extra]}")
    names = list(SPECIAL_NAMES.values())
    if len(names) != len(set(names)):
        bad("スペシャル名が重複している")
    if not missing and not extra and len(names) == len(set(names)):
        ok(f"{len(names)}種に固有の名前があり、相反{len(FORBIDDEN_PAIRS)}組は名前なし")


def check_presets() -> None:
    print("[5] プリセットの能力合計 — 6チーム")
    problems = check_no_clamping()
    if problems:
        for p in problems:
            bad(p)
    else:
        ok("6チームの能力合計が一致（特訓が上限で切られていない）")


def check_requirements_doc() -> None:
    """要件定義書が挙げているファイル・定数が実在するか。

    🔴 台帳「ドキュメントの『実装済み』表は自己申告。機械で検証できる形にする」。
       §13 の対応表は、書いた時点では正しくても**コードを動かすと黙って嘘になる**。
       だから「そこに書いてあるパス」と「コードにある名前」を実際に見に行く。

    🔑 ドラフトの二重管理も止める。`docs/requirements.md` が正本で、
       Downloads のドラフトは参照しない（本文の冒頭に明記）。
    """
    doc = ROOT / "docs" / "requirements.md"
    print(f"[8] 要件定義書の照合 — {doc.name}")
    if not doc.exists():
        bad("docs/requirements.md が無い（正本がドラフトのままになっている）")
        return

    text = doc.read_text(encoding="utf-8")

    # `sim/model.py` のような「拡張子つきのパス」だけを見る（日本語の説明は拾わない）
    paths = sorted(set(re.findall(r"`([A-Za-z0-9_./-]+\.(?:py|toml|md|json))`", text)))
    missing = [p for p in paths if not (ROOT / p).exists()]
    if missing:
        for p in missing:
            bad(f"要件定義書が挙げているファイルが無い: {p}")
    else:
        ok(f"挙げられている {len(paths)}ファイルすべてが実在する")

    # 本文が名指ししている定数が constants.py にあるか
    named = ["TYPE_THRESHOLD", "STOPPER_PRESS", "STRIKER_MARGIN", "ATTACK_TIE_BREAK",
             "ACTION_CONTROL_TICKS", "TACKLE_COOLDOWN_TICKS"]
    cited = [n for n in named if n in text]
    gone = [n for n in cited if not hasattr(C, n)]
    if gone:
        for n in gone:
            bad(f"要件定義書が名指しした定数が constants.py に無い: {n}")
    else:
        ok(f"名指しされた定数 {len(cited)}件すべてが constants.py にある")

    # 閾値は本文にも数字で書いてある。ズレたら本文が嘘になる
    if f"閾値は **{C.TYPE_THRESHOLD}**" in text:
        ok(f"本文の閾値 {C.TYPE_THRESHOLD} が TYPE_THRESHOLD と一致")
    else:
        bad(f"本文の閾値が TYPE_THRESHOLD({C.TYPE_THRESHOLD}) と食い違っている")


def check_web_build() -> None:
    """ブラウザへ配る一式が組み立てられ、**配ってはいけないものが混ざらない**こと。

    🔴 静的配信は「置いてあるものが全部公開される」。
       カードショップEDENでは内部メモが `/cards/README.md` で公開されていた。
       ここは同じ失敗を機械で止める場所。

    🔑 `sim/` を配信ディレクトリへコピーする作りなので、**コピー漏れも黙って起きる**
       （画面は出るのに import で落ちる）。組み立てを毎回実際に走らせて確かめる。
    """
    print("[10] ブラウザ配信物の組み立て — web/dist")
    proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_web.py")],
                          cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        tail = (proc.stdout or proc.stderr).strip().splitlines()[-5:]
        bad("web/dist を組み立てられない:\n      " + "\n      ".join(tail))
        return

    dist = ROOT / "web" / "dist"
    files = sorted(p.relative_to(dist).as_posix() for p in dist.rglob("*") if p.is_file())
    ok(f"{len(files)}ファイルを組み立てた")

    # ブラウザが読む Python が全部そろっているか（manifest とファイルの突き合わせ）
    manifest = json.loads((dist / "py" / "manifest.json").read_text(encoding="utf-8"))
    listed = [f"py/sim/{n}" for n in manifest["sim"]] + [f"py/{n}" for n in manifest["top"]]
    missing = [n for n in listed if n not in files]
    if missing:
        bad(f"一覧にあるのに配られていない: {missing}")
    else:
        ok(f"一覧の {len(listed)}ファイルがすべて配信物に入っている")

    # 🔴 端末の対話画面はブラウザでは動かない。配ると読む人が誤解する
    unwanted = [n for n in files if n.endswith(("ui.py", "batch.py", "__main__.py"))]
    if unwanted:
        bad(f"ブラウザで使わない Python が混ざっている: {unwanted}")
    else:
        ok("ブラウザで使わない Python（ui / batch / __main__）は入っていない")

    # 🔴 **版の刻印**（2026-09-30 に実際に踏んだ）。
    #    刻印が無いと、ブラウザが一部のファイルだけ古い写しを返し、
    #    新しいものと混ざった状態で動く（`model.py` だけ古くて
    #    `'Player' object has no attribute 'traits'` で落ちた）。
    #    画面は普通に立ち上がるので、混ざっていることに気づけない。
    stamp = manifest.get("stamp")
    if not stamp:
        bad("配信物に版の刻印が無い（ブラウザが古い写しを使い回す）")
        return
    index = (dist / "index.html").read_text(encoding="utf-8")
    unstamped = re.findall(r'(?:src|href)="([\w.-]+\.(?:js|css))"', index)
    if unstamped:
        bad(f"刻印の付いていない読み込みがある: {unstamped}")
    else:
        ok(f"版の刻印 {stamp} が index.html と一覧の両方に入っている")


def check_fairness() -> None:
    """🔴 **どのチームにも勝ち筋と負け筋があるか**（要件 GD-05）。

    要件定義書は「大量の自動対戦で勝ちすぎるチームがなく、戦術の相性
    （じゃんけん関係）が生まれること」をMVPの核の1つに挙げている。
    ここが壊れると、育成の選択が無意味になる（強い型を選ぶだけのゲームになる）。

    🔑 `batch` の全試合を回すと1分近くかかるので、ここでは**少ない試合数**で
       明らかな一方通行だけを捕まえる。詳しく見るときは
       `python -m sim batch --matches 40` を使う。
    """
    from sim.batch import run_batch

    # 🔴 **試合数を削らない。** 1組6試合（=1チーム30試合）だと揺らぎが大きく、
    #    真の勝率35%のチームが28.3%と出て赤くなった（2026-10-01 実測）。
    #    揺らぎで落ちる検査は、そのうち誰も見なくなる。
    # 🔑 1組20試合＝1チーム100試合。約25秒。詳しく見るときは
    #    `python -m sim batch --matches 40`
    matches_per_pair = 20
    print(f"[7] 相性（じゃんけん関係） — 6チーム総当たり × {matches_per_pair}試合")
    summary = run_batch(matches_per_pair, base_seed=1)
    bad_teams = [f"{name} {rate:.1%}" for name, rate in summary["overall_rate"].items()
                 if not (C.BATCH_WIN_RATE_WARN_LOW <= rate <= C.BATCH_WIN_RATE_WARN_HIGH)]
    if bad_teams:
        bad("勝率が床30%〜天井70%を外れたチーム: " + ", ".join(bad_teams)
            + "（強い型を選ぶだけのゲームになっている）")
    else:
        lo = min(summary["overall_rate"].values())
        hi = max(summary["overall_rate"].values())
        ok(f"6チームの全体勝率が {lo:.0%}〜{hi:.0%}（床30%〜天井70%の内側）")


def check_tools() -> None:
    """lint と型チェックを**ここから呼ぶ**。

    🔴 ループ#1・#2 と2回続けて「次のループで入れる」と書いて入らなかった。
       台帳の昇格ルールは3回目で機械化を求めている。
       人が思い出して打つ限り、4回目も持ち越される。

    🔑 `ruff` / `mypy` は開発ツールなので「標準ライブラリのみ」（README）には触れない。
       実行時の制約と開発時の道具を混同していたのが、2回持ち越した原因。
    """
    print("[9] lint と型チェック — ruff / mypy")
    for label, argv in (("ruff", ["-m", "ruff", "check", "."]),
                        ("mypy", ["-m", "mypy"])):
        proc = subprocess.run([sys.executable, *argv], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8")
        if proc.returncode == 0:
            ok(f"{label} 問題なし")
        else:
            tail = (proc.stdout or proc.stderr).strip().splitlines()[-5:]
            bad(f"{label} が問題を報告した:\n      " + "\n      ".join(tail))


def check_stat_ranges() -> None:
    """実測スタッツを現実の相場と照合する（`scripts/measure.py`）。

    🔑 45試合まわして約18秒。提出前に毎回まわせる範囲なのでここに入れる。

    🔴 いま相場を外れている4項目は `measure.KNOWN_RED` に登録済みで、ここでは止めない
       （バランス調整のループの持ち物）。止めるのは**新しく外れたとき**と
       **相場に戻ったのに登録が残っているとき**だけ。
    """
    print("[11] 実測スタッツと現実の相場の照合 — プリセット総当たり")
    proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "measure.py")],
                          cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    known_red = len(measure.KNOWN_RED)
    if proc.returncode == 0:
        ok(f"新しく相場を外れた指標なし（既知の赤 {known_red}件は measure.py の KNOWN_RED）")
    else:
        tail = (proc.stdout or proc.stderr).strip().splitlines()[-8:]
        bad("実測が相場から外れた:\n      " + "\n      ".join(tail))


def main() -> int:
    print("=== dot-soccer 提出前検査 ===")
    check_dummy_values()
    check_constants_invariants()
    check_data_files()
    check_special_names()
    check_presets()
    check_league_setup()
    check_fairness()
    check_requirements_doc()
    check_tools()
    check_web_build()
    check_stat_ranges()
    print()
    if failures:
        print(f"❌ {len(failures)}件の問題があります")
        return 1
    print("✅ すべて問題なし")
    return 0


if __name__ == "__main__":
    sys.exit(main())
