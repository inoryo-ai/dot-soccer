"""コマンドライン入口（要件定義書 §11）。

    python -m sim match data/team_a.json data/team_b.json --seed 1
    python -m sim train --card running --times 20
    python -m sim batch --matches 200 --seed 1
    python -m sim presets            # data/ のチームJSONを作り直す
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import constants as C
from .engine import play
from .model import Player, load_team
from .presets import PRESET_ORDER, ability_totals, check_no_clamping, write_data_files
from .training import CARDS, apply_training, issue_text, special_name

ROOT = Path(__file__).resolve().parent.parent


def _fmt_stats(name: str, s: dict) -> str:
    return (f"  {name}\n"
            f"    得点 {s['goals']}  シュート {s['shots']}  被シュート {s['shots_against']}\n"
            f"    支配率 {s['possession_pct']}%  パス {s['passes_completed']}/{s['passes']}"
            f" ({s['pass_success_pct']}%)\n"
            f"    ボール奪取 {s['tackles_won']}  奪い合い {s['duels']}回中 {s['duels_lost']}敗"
            f"  裏を取られた {s['beaten_behind']}\n"
            f"    走行距離 {s['distance_km']}km  スタミナ20%未満になった選手 "
            f"{s['stamina_low_players']}人")


def cmd_match(args: argparse.Namespace) -> int:
    team_a = load_team(args.team_a)
    team_b = load_team(args.team_b)
    started = time.perf_counter()
    res = play(team_a, team_b, args.seed, log=True)
    elapsed = time.perf_counter() - started

    print(f"== {res['teams'][0]} {res['score'][0]} - {res['score'][1]} {res['teams'][1]} ==")
    print(f"   seed={res['seed']}  {res['ticks']}ティック（90分）  実行 {elapsed:.2f}秒")
    print("\n[スタッツ]")
    for name, s in zip(res["teams"], res["stats"], strict=True):
        print(_fmt_stats(name, s))
    print("\n[課題（次にもらえる特訓カード）]")
    for name, issues in zip(res["teams"], res["issues"], strict=True):
        if issues:
            for key in issues:
                print(f"  {name}: {issue_text(key)}")
        else:
            print(f"  {name}: なし")

    log_dir = Path(args.log_dir) if args.log_dir else ROOT / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"match_seed{res['seed']}.json"
    payload = dict(res.items())
    with log_path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"\nログ: {log_path}（{len(res['events'])}件のイベント）")
    return 0


def cmd_train(args: argparse.Namespace) -> int:
    cards = list(args.card)
    if len(cards) not in (1, 2):
        print("--card は1回（通常）か2回（スペシャル）指定する", file=sys.stderr)
        return 2
    for c in cards:
        if c not in CARDS:
            print(f"未知のカード: {c}（使えるのは {', '.join(CARDS)}）", file=sys.stderr)
            return 2
    if len(cards) == 2:
        try:
            label = special_name(cards[0], cards[1])
        except ValueError as e:
            print(f"エラー: {e}", file=sys.stderr)
            return 2
    else:
        label = CARDS[cards[0]].label

    p = Player(name="検証くん", position="MF", kick=40, speed=40, stamina=40,
               technique=40, physical=40)
    print(f"== 特訓検証: {label} × {args.times}回 ==")
    print(f"   初期タイプ: {p.type_name}")
    head = ["回", "zone_man", "press", "support", "overlap", "run_space", "goal_wait", "タイプ"]
    print(" ".join(h.rjust(9) for h in head))
    changes = 0
    first_change = None
    prev = p.type_name
    for i in range(1, args.times + 1):
        r = apply_training(p, cards)
        h = p.hidden
        mark = "  ←変化" if r["after"] != prev else ""
        if r["after"] != prev:
            changes += 1
            if first_change is None:
                first_change = i
            prev = r["after"]
        row = [str(i)] + [str(h[k]) for k in
                          ("zone_man", "press", "support", "overlap", "run_space", "goal_wait")]
        print(" ".join(c.rjust(9) for c in row) + f" {p.type_name}{mark}")
    print(f"\n   タイプが変わった回数: {changes}回"
          f"（初回 {first_change if first_change else '—'}回目）")
    print(f"   最終タイプ: {p.type_name}")
    print("   見える能力: " + "  ".join(f"{k}={v}" for k, v in p.visible.items()))
    return 0


def cmd_train_all(args: argparse.Namespace) -> int:
    """完成条件の「6種カードのタイプ変化回数一覧」（実際は D-02 で7種）。"""
    print(f"== 全カードのタイプ変化回数（各 {args.times}回） ==")
    print(f"{'カード':<14}{'変化回数':>8}{'初回':>6}  最終タイプ")
    for key, card in CARDS.items():
        p = Player(name="検証くん", position="MF", kick=40, speed=40, stamina=40,
                   technique=40, physical=40)
        prev, changes, first = p.type_name, 0, None
        for i in range(1, args.times + 1):
            apply_training(p, [key])
            if p.type_name != prev:
                changes += 1
                first = first or i
                prev = p.type_name
        print(f"{card.label:<14}{changes:>8}{(first or '—'):>6}  {p.type_name}")
    return 0


def cmd_batch(args: argparse.Namespace) -> int:
    from .batch import format_table, run_batch, write_csv

    def progress(done: int, total: int) -> None:
        print(f"\r  {done}/{total} 試合 ...", end="", file=sys.stderr, flush=True)

    total = args.matches * (len(PRESET_ORDER) * (len(PRESET_ORDER) - 1) // 2)
    print(f"== 総当たり {len(PRESET_ORDER)}チーム / 各組{args.matches}試合 = {total}試合 ==")
    started = time.perf_counter()
    summary = run_batch(args.matches, args.seed, workers=args.workers, progress=progress)
    elapsed = time.perf_counter() - started
    print(f"\r  完了: {summary['total_matches']}試合 / {elapsed:.1f}秒"
          f"（1試合あたり {elapsed / max(1, summary['total_matches']) * 1000:.0f}ms）")
    print()
    print(format_table(summary))
    print()
    if summary["warnings"]:
        for w in summary["warnings"]:
            print(w)
    else:
        print(f"✅ 全チームの全体勝率が {C.BATCH_WIN_RATE_WARN_LOW:.0%}〜"
              f"{C.BATCH_WIN_RATE_WARN_HIGH:.0%} の範囲に収まっている")
    out = Path(args.out) if args.out else ROOT / "out" / "batch_winrate.csv"
    write_csv(summary, out)
    print(f"CSV: {out}")
    return 1 if summary["warnings"] and args.strict else 0


def cmd_play(args: argparse.Namespace) -> int:
    from .ui import DEFAULT_SAVE, play_game
    return play_game(args.save or DEFAULT_SAVE)


def cmd_presets(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir) if args.data_dir else ROOT / "data"
    written = write_data_files(data_dir)
    print(f"== プリセット書き出し: {len(written)}件 → {data_dir} ==")
    for p in written:
        print(f"  {p.name}")
    print("\n[能力合計（そろっているか）]")
    for name, total in ability_totals().items():
        print(f"  {name}: {total}")
    problems = check_no_clamping()
    if problems:
        for problem in problems:
            print(f"⚠ {problem}")
        return 1
    print("✅ 全チームの能力合計が一致（上限で切られていない）")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="sim", description="ドットサッカー 試合シミュレーター")
    sub = ap.add_subparsers(dest="command", required=True)

    m = sub.add_parser("match", help="1試合を実行する")
    m.add_argument("team_a")
    m.add_argument("team_b")
    m.add_argument("--seed", type=int, default=1)
    m.add_argument("--log-dir", default=None)
    m.set_defaults(func=cmd_match)

    t = sub.add_parser("train", help="特訓を繰り返してタイプ変化を見る")
    t.add_argument("--card", action="append", required=True,
                   help=f"カード名（{', '.join(CARDS)}）。2回指定するとスペシャル")
    t.add_argument("--times", type=int, default=20)
    t.set_defaults(func=cmd_train)

    ta = sub.add_parser("train-all", help="全カードのタイプ変化回数一覧")
    ta.add_argument("--times", type=int, default=20)
    ta.set_defaults(func=cmd_train_all)

    b = sub.add_parser("batch", help="プリセット総当たりの大量対戦")
    b.add_argument("--matches", type=int, default=200, help="各組の試合数")
    b.add_argument("--seed", type=int, default=1)
    b.add_argument("--workers", type=int, default=None, help="並列数（既定=CPU数-1）")
    b.add_argument("--out", default=None)
    b.add_argument("--strict", action="store_true", help="勝率警告があれば終了コード1")
    b.set_defaults(func=cmd_batch)

    g = sub.add_parser("play", help="ゲームとして遊ぶ（育成→試合→課題→特訓のループ）")
    g.add_argument("--save", default=None, help="セーブファイル（既定: saves/default.json）")
    g.set_defaults(func=cmd_play)

    p = sub.add_parser("presets", help="data/ のチームJSONを作り直す")
    p.add_argument("--data-dir", default=None)
    p.set_defaults(func=cmd_presets)

    return ap


def force_utf8_io() -> None:
    """標準入出力を UTF-8 に固定する。

    - 出力: Windows の既定コンソール（cp932）だと絵文字や記号で落ちる
    - 入力: 🔴 **stdin も直すこと。** 出力だけ直していたため、パイプで渡した
      日本語のチーム名が cp932 として読まれ「フェニックス」が「繝輔ぉ繝九ャ繧ｯ繧ｹ」になった。
      コンソール直結のとき Python は既に UTF-8 を使うので（PEP 528）、ここでの指定は無害。

    握りつぶし（errors="replace"）にはしない。UTF-8 で読み書きする、が正しい状態。
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    force_utf8_io()
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
