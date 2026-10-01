"""プリセット全チームの平均スタッツを実測し、**現実の相場と並べて機械で判定する**。

─────────────────────────────────────────────────────────────
🔴 なぜ「並べて出す」だけでは足りないのか
─────────────────────────────────────────────────────────────
以前のこの道具は数字を表にして出すだけで、妥当かどうかは人が見て決めていた。
ループ#1で「1試合の奪い合い4,081回・走行191km」という**桁で狂った値**が出たが、
例外は出ず試合も成立していたので、表を見た人が気づくまで分からなかった。

相場を知らないと「4,000回」が異常だと判断できない。
だから**期待レンジを持たせて、外れたら赤くする**。

🔴 期待レンジには必ず**出典**を書く。
   書けない数字は「監視のみ」に置き、判定に使わない（推測を基準にしない）。

使い方:
    python scripts/measure.py          # 3シードで測って判定（終了コードで可否）
    python scripts/measure.py 5        # シード数を増やす
"""

from __future__ import annotations

import copy
import io
import itertools
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
# 🔑 Windows の既定は cp932 で、日本語の表が出力できずに落ちる
if isinstance(sys.stdout, io.TextIOWrapper):
    sys.stdout.reconfigure(encoding="utf-8")

from sim.engine import play  # noqa: E402
from sim.presets import PRESET_ORDER, build_preset  # noqa: E402


@dataclass(frozen=True)
class Expected:
    """1指標の期待レンジ。**出典が無いものはここに置かない。**"""

    low: float
    high: float
    source: str

    def holds(self, value: float) -> bool:
        return self.low <= value <= self.high


# ------------------------------------------------------------------ 期待レンジ
#
# 🔴 ここの数字は「こうあってほしい」ではなく「現実のサッカーがこうである」。
#    変えるときは出典ごと変えること。出典なしで緩めたら、この道具は飾りになる。
#
# 出典:
#   [PL]   プレミアリーグ公式 — 決定率は 2003/04 以降の平均 10.30%、
#          2023/24 が記録的な高さで 11.88%
#          https://www.premierleague.com/en/news/4027257
#   [CIES] CIES Football Observatory 月報68 — 31リーグのフィールドプレーヤー
#          1チーム1試合あたり合計 99.9km。FIFA W杯2022 は総走行 108.1km
#          https://football-observatory.com/IMG/sites/mr/mr68/en/
#   [JL]   Jリーグ 1993年 180試合532得点＝2.96点/試合、1995年 364試合1,214得点＝3.34点/試合
#          （両チーム合計。1チームあたりは概ね 1.5 前後）
#          https://en.wikipedia.org/wiki/1993_J.League
EXPECTED: dict[str, Expected] = {
    "goals": Expected(
        1.0, 1.9,
        "[JL] 両チーム合計 2.96〜3.34点/試合 → 1チームあたり 1.5 前後"),
    "shots": Expected(
        9.0, 18.0,
        "[PL] 決定率 10.3% で 1.4点を取るのに要るシュート数から逆算（約13〜14本）"),
    "conversion_pct": Expected(
        8.0, 13.0,
        "[PL] 2003/04以降の平均 10.30%、2023/24 の最高 11.88%"),
    "distance_km": Expected(
        95.0, 115.0,
        "[CIES] 31リーグ平均 99.9km／FIFA W杯2022 総走行 108.1km（1チーム1試合）"),
    "possession_pct": Expected(
        35.0, 65.0,
        "定義上 両チームの合計が100%。どのチームも50%付近に収まるはず"),
}

# --------------------------------------------------------------- 判定の仕方
#
# 🔴 **相場は「リーグの平均」なので、平均と比べる。**
#    2026-10-01 まではチーム1つずつを相場と比べていたが、これは測り方の間違い。
#    プリセット6チームは「1種類のカードだけ20回」という**極端な型**で、
#    シュートだけ20回積んだチームと、実在リーグの平均を直接比べても意味がない。
#    実測でも、どう調整しても6チームの幅（例: 決定率 7.8〜14.6%）が
#    相場の幅（8〜13%）より広くなり、**ゲーム側を壊さないと緑にならない**状態だった。
#
# 🔑 そのかわり2段構えにする。
#      ①**平均**が相場に入っているか  ← ゲーム全体が現実的か
#      ②**どのチームも壊れていないか** ← 相場の幅1つぶん外れたら壊れている
#    ②を入れないと、平均だけ合わせて中身がめちゃくちゃでも緑になる。
OUTLIER_MARGIN = 1.0                # 相場の幅の何倍まで外れてよいか（1つぶん）

# 🔴 既知の赤。**空にするのがバランス調整のループの終了条件。**
#    2026-10-01 のループ#5/#6 で空になった。増やすときは報告書に理由を書く。
KNOWN_RED: frozenset[str] = frozenset()

# 🔑 相場の裏付けが取れなかったもの。**判定には使わない**が、表には出す。
#    （出典を見つけたら EXPECTED へ移す。推測でレンジを置かないこと）
WATCH_ONLY = (
    "passes",
    "pass_success_pct",
    "tackles_won",
    "duels_lost_pct",
    "beaten_behind",
    "shots_against",
    "stamina_low_players",
)

RAW_KEYS = (
    "shots", "goals", "passes", "pass_success_pct", "duels", "duels_lost",
    "tackles_won", "distance_km", "beaten_behind", "possession_pct",
    "shots_against", "stamina_low_players",
)

LABELS = {
    "goals": "得点", "shots": "シュート", "conversion_pct": "決定率%",
    "shots_against": "被シュート", "passes": "パス", "pass_success_pct": "パス成功%",
    "tackles_won": "奪取", "duels_lost_pct": "競り負け%", "beaten_behind": "裏を取られ",
    "distance_km": "走行km", "possession_pct": "支配%", "stamina_low_players": "息切れ人数",
}


def measure(reps: int) -> tuple[dict[str, dict[str, float]], int]:
    """プリセット総当たりを走らせ、チームごとの平均値を返す。"""
    names = list(PRESET_ORDER)
    teams = {n: build_preset(n) for n in names}
    agg: dict[str, dict[str, list[float]]] = {n: {k: [] for k in RAW_KEYS} for n in names}
    n_matches = 0

    for home, away in itertools.combinations(names, 2):
        for seed_offset in range(reps):
            result = play(copy.deepcopy(teams[home]), copy.deepcopy(teams[away]),
                          1000 + seed_offset, log=False)
            n_matches += 1
            for i, n in enumerate((home, away)):
                for k in RAW_KEYS:
                    agg[n][k].append(result["stats"][i][k])

    out: dict[str, dict[str, float]] = {}
    for n in names:
        samples = agg[n]
        row = {k: statistics.mean(samples[k]) for k in RAW_KEYS}
        # 🔑 率は「平均の平均」ではなく合計から出す（試合ごとの本数が違うため）
        row["conversion_pct"] = 100.0 * sum(samples["goals"]) / max(1.0, sum(samples["shots"]))
        row["duels_lost_pct"] = (
            100.0 * sum(samples["duels_lost"]) / max(1.0, sum(samples["duels"])))
        out[n] = row
    return out, n_matches


def team_values(rows: dict[str, dict[str, float]], key: str) -> list[float]:
    return [row[key] for row in rows.values()]


def mean_of(rows: dict[str, dict[str, float]], key: str) -> float:
    return statistics.mean(team_values(rows, key))


def out_of_range(rows: dict[str, dict[str, float]]) -> set[str]:
    """**平均**が相場を外れている指標名の集合。"""
    return {key for key, exp in EXPECTED.items() if not exp.holds(mean_of(rows, key))}


def outliers(rows: dict[str, dict[str, float]]) -> list[str]:
    """壊れているチーム。相場の幅1つぶん外れたら、平均が合っていても壊れている。"""
    out = []
    for key, exp in EXPECTED.items():
        slack = (exp.high - exp.low) * OUTLIER_MARGIN
        for name, row in rows.items():
            v = row[key]
            if v < exp.low - slack or v > exp.high + slack:
                out.append(f"{name} の{LABELS[key]} {v:.2f}"
                           f"（許容 {exp.low - slack:.1f}〜{exp.high + slack:.1f}）")
    return out


def describe(rows: dict[str, dict[str, float]], key: str) -> str:
    exp = EXPECTED[key]
    values = team_values(rows, key)
    return (f"{LABELS[key]}: 平均 {mean_of(rows, key):.2f}"
            f" / 相場 {exp.low}〜{exp.high}（{exp.source}）"
            "\n      各チーム " + f"{min(values):.2f}〜{max(values):.2f}")


def judge(rows: dict[str, dict[str, float]]) -> tuple[list[str], list[str]]:
    """(止めるべき問題, 既知の赤のままの項目) を返す。

    🔴 止めるのは3つ。
       ①**平均が新しく外れた**（KNOWN_RED に無い）
       ②**相場に戻った**のに KNOWN_RED に残っている（消さないと次を見逃す）
       ③**壊れているチームがある**（平均が合っていても中身が壊れている）
    """
    outside = out_of_range(rows)

    blocking = [f"（平均が新しく外れた）{describe(rows, key)}"
                for key in sorted(outside - KNOWN_RED)]
    blocking += [f"（相場に戻った）{LABELS[key]}: KNOWN_RED から {key} を消すこと"
                 for key in sorted(KNOWN_RED - outside)]
    blocking += [f"（チームが壊れている）{item}" for item in outliers(rows)]
    still_red = [describe(rows, key) for key in sorted(outside & KNOWN_RED)]
    return blocking, still_red


def main(reps: int = 3) -> int:
    rows, n_matches = measure(reps)
    print(f"読んだ試合数: {n_matches}（プリセット{len(rows)}チーム総当たり × {reps}シード）\n")

    shown = ("goals", "shots", "conversion_pct", "shots_against", "passes",
             "pass_success_pct", "tackles_won", "duels_lost_pct", "beaten_behind",
             "distance_km", "possession_pct", "stamina_low_players")
    header = f"{'チーム':<10}" + "".join(f"{LABELS[k]:>12}" for k in shown)
    print(header)
    for name, row in rows.items():
        print(f"{name:<10}" + "".join(f"{row[k]:>12.2f}" for k in shown))

    outside = out_of_range(rows)
    print("\n--- 相場との照合（**平均**で判定・出典つき） ---")
    for key, exp in EXPECTED.items():
        values = team_values(rows, key)
        mark = "✅" if key not in outside else ("🟡" if key in KNOWN_RED else "🔴")
        print(f"  {mark} {LABELS[key]:<8} 平均 {mean_of(rows, key):>7.2f}"
              f"  相場 {exp.low}〜{exp.high}"
              f"  （各チーム {min(values):.2f}〜{max(values):.2f}）")
        print(f"       出典: {exp.source}")

    print(f"\n--- 監視のみ（相場の出典が取れていないので判定に使わない） ---\n"
          f"  {', '.join(LABELS[k] for k in WATCH_ONLY)}")

    blocking, still_red = judge(rows)

    if still_red:
        print(f"\n🟡 前から相場を外れたまま（バランス調整のループで直す）— {len(still_red)}件:")
        for item in still_red:
            print(f"    - {item}")

    if blocking:
        print(f"\n🔴 止めるべき変化が {len(blocking)}件:")
        for item in blocking:
            print(f"    - {item}")
        return 1

    print("\n✅ 平均はすべて相場の内側。壊れているチームも無し")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 3))
