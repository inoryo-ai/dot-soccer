"""大量自動対戦（要件定義書 §11 `batch`）。

シードは `seed_for` で試合ごとに決定論的に導出する（D-08）ので、
並列度や実行順が変わっても結果は変わらない。
"""

from __future__ import annotations

import csv
import itertools
import os
from functools import cache
from pathlib import Path

from . import constants as C
from .engine import play, seed_for
from .model import Team
from .presets import PRESET_ORDER, build_preset


@cache
def _team(name: str) -> Team:
    """ワーカープロセスごとに1回だけ組み立てる（毎試合作り直すと遅い）。"""
    return build_preset(name)


def _fresh(name: str) -> Team:
    """試合ごとに状態を持ち込まないよう、選手を複製して渡す。"""
    import copy
    return copy.deepcopy(_team(name))


def run_one(job: tuple[int, str, str, int]) -> tuple[int, str, str, int, int]:
    """1試合。戻り値 = (pair_index, home, away, home_goals, away_goals)。"""
    pair_index, home, away, seed = job
    res = play(_fresh(home), _fresh(away), seed, log=False)
    return pair_index, home, away, res["score"][0], res["score"][1]


def build_jobs(matches_per_pair: int, base_seed: int,
               teams: tuple[str, ...] = PRESET_ORDER) -> list[tuple[int, str, str, int]]:
    jobs: list[tuple[int, str, str, int]] = []
    for pair_index, (a, b) in enumerate(itertools.combinations(teams, 2)):
        for m in range(matches_per_pair):
            swapped = (m % 2 == 1)          # ホーム・アウェー入替
            home, away = (b, a) if swapped else (a, b)
            jobs.append((pair_index, home, away, seed_for(base_seed, pair_index, m, swapped)))
    return jobs


def run_batch(matches_per_pair: int, base_seed: int, workers: int | None = None,
              teams: tuple[str, ...] = PRESET_ORDER, progress=None) -> dict:
    jobs = build_jobs(matches_per_pair, base_seed, teams)
    results: list[tuple[int, str, str, int, int]] = []
    if workers is None:
        workers = max(1, (os.cpu_count() or 2) - 1)

    if workers <= 1:
        for i, job in enumerate(jobs):
            results.append(run_one(job))
            if progress and (i + 1) % 50 == 0:
                progress(i + 1, len(jobs))
    else:
        from multiprocessing import Pool
        with Pool(processes=workers) as pool:
            for i, r in enumerate(pool.imap_unordered(run_one, jobs, chunksize=8)):
                results.append(r)
                if progress and (i + 1) % 50 == 0:
                    progress(i + 1, len(jobs))

    return summarize(results, teams, matches_per_pair, base_seed)


def summarize(results, teams: tuple[str, ...], matches_per_pair: int, base_seed: int) -> dict:
    record = {t: {"w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0} for t in teams}
    head = {t: {o: {"w": 0, "d": 0, "l": 0} for o in teams if o != t} for t in teams}
    for _pi, home, away, hg, ag in results:
        record[home]["gf"] += hg
        record[home]["ga"] += ag
        record[away]["gf"] += ag
        record[away]["ga"] += hg
        if hg > ag:
            record[home]["w"] += 1
            record[away]["l"] += 1
            head[home][away]["w"] += 1
            head[away][home]["l"] += 1
        elif hg < ag:
            record[away]["w"] += 1
            record[home]["l"] += 1
            head[away][home]["w"] += 1
            head[home][away]["l"] += 1
        else:
            record[home]["d"] += 1
            record[away]["d"] += 1
            head[home][away]["d"] += 1
            head[away][home]["d"] += 1

    warnings: list[str] = []
    overall: dict[str, float] = {}
    for t in teams:
        r = record[t]
        n = r["w"] + r["d"] + r["l"]
        rate = (r["w"] + 0.5 * r["d"]) / n if n else 0.0
        overall[t] = rate
        if rate > C.BATCH_WIN_RATE_WARN_HIGH:
            warnings.append(
                f"⚠ {t} の全体勝率 {rate:.1%} が上限 {C.BATCH_WIN_RATE_WARN_HIGH:.0%} を超えた")
        if rate < C.BATCH_WIN_RATE_WARN_LOW:
            warnings.append(
                f"⚠ {t} の全体勝率 {rate:.1%} が下限 {C.BATCH_WIN_RATE_WARN_LOW:.0%} を下回った")

    return {
        "teams": list(teams),
        "matches_per_pair": matches_per_pair,
        "total_matches": len(results),
        "base_seed": base_seed,
        "record": record,
        "head_to_head": head,
        "overall_rate": overall,
        "warnings": warnings,
    }


def write_csv(summary: dict, path: str | Path) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    teams = summary["teams"]
    with p.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["勝率表（行のチームから見た勝率／引分は0.5）"])
        w.writerow(["チーム", *teams, "全体勝率", "勝", "分", "敗", "得点", "失点"])
        for t in teams:
            row = [t]
            for o in teams:
                if o == t:
                    row.append("-")
                    continue
                h = summary["head_to_head"][t][o]
                n = h["w"] + h["d"] + h["l"]
                row.append(f"{(h['w'] + 0.5 * h['d']) / n:.3f}" if n else "-")
            r = summary["record"][t]
            row += [f"{summary['overall_rate'][t]:.3f}", r["w"], r["d"], r["l"], r["gf"], r["ga"]]
            w.writerow(row)
        w.writerow([])
        w.writerow(["総試合数", summary["total_matches"], "各組", summary["matches_per_pair"],
                    "シード", summary["base_seed"]])
        for msg in summary["warnings"]:
            w.writerow([msg])
    return p


def format_table(summary: dict) -> str:
    teams = summary["teams"]
    width = max(len(t) for t in teams) + 2
    lines = []
    header = "チーム".ljust(width) + "".join(t.center(width) for t in teams) + "全体勝率".rjust(10)
    lines.append(header)
    for t in teams:
        row = t.ljust(width)
        for o in teams:
            if o == t:
                row += "-".center(width)
                continue
            h = summary["head_to_head"][t][o]
            n = h["w"] + h["d"] + h["l"]
            row += (f"{(h['w'] + 0.5 * h['d']) / n:.3f}" if n else "-").center(width)
        row += f"{summary['overall_rate'][t]:.1%}".rjust(10)
        r = summary["record"][t]
        row += f"  ({r['w']}勝{r['d']}分{r['l']}敗 得{r['gf']}/失{r['ga']})"
        lines.append(row)
    return "\n".join(lines)
