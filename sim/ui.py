"""対話式のゲーム画面（コマンド上で遊ぶ層）。

入出力は**引数で受ける**（`Console(reader, writer)`）。
こうしておくと、テストが人の代わりにキー入力を渡して全画面を最後まで歩ける。
学習台帳「自分が作った導線を、自分で最初から最後まで一度歩く」への対処。
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from pathlib import Path

from . import constants as C
from .career import Career, SaveError
from .league import format_standings
from .model import (
    ATTITUDES,
    FORMATIONS,
    POLICY_ACTIONS,
    POLICY_CONDITIONS,
    Manager,
    PolicyRule,
    Tactics,
)
from .presets import PRESET_PLANS, TRAININGS_PER_PLAYER, default_user_plan
from .training import CARDS, FORBIDDEN_PAIRS, special_name

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SAVE = ROOT / "saves" / "default.json"
RULE = "─" * 66


class Quit(Exception):
    """入力が尽きた（EOF）か、プレイヤーが終了を選んだ。"""


class Console:
    def __init__(self, reader: Callable[[], str] | None = None,
                 writer: Callable[[str], None] | None = None) -> None:
        self._reader = reader
        self._writer = writer

    def out(self, text: str = "") -> None:
        if self._writer is not None:
            self._writer(text)
        else:
            print(text)

    def read(self) -> str:
        if self._reader is not None:
            return self._reader()
        try:
            return input()
        except EOFError as e:
            raise Quit("入力が終了しました") from e

    def ask(self, prompt: str, default: str | None = None) -> str:
        suffix = f" [{default}]" if default else ""
        self.out(f"{prompt}{suffix}: ")
        try:
            value = self.read().strip()
        except Quit:
            raise
        if not value and default is not None:
            return default
        return value

    def ask_int(self, prompt: str, lo: int, hi: int, default: int | None = None) -> int:
        while True:
            raw = self.ask(f"{prompt}（{lo}〜{hi}）", str(default) if default is not None else None)
            try:
                value = int(raw)
            except ValueError:
                self.out(f"  ⚠ 数字で入れてください（{lo}〜{hi}）")
                continue
            if lo <= value <= hi:
                return value
            self.out(f"  ⚠ {lo}〜{hi} の範囲で入れてください")

    def choose(self, prompt: str, options: list[tuple[str, str]]) -> str:
        """options = [(選択キー, 表示), ...]。戻り値は選択キー。"""
        keys = {k for k, _ in options}
        while True:
            for key, label in options:
                self.out(f"  {key}) {label}")
            value = self.ask(prompt)
            if value in keys:
                return value
            self.out(f"  ⚠ {'/'.join(k for k, _ in options)} のどれかを入れてください")

    def pause(self) -> None:
        self.out("（Enterで続ける）")
        try:
            self.read()
        except Quit:
            raise


# ---------------------------------------------------------------- 表示部品


def format_squad(career: Career) -> str:
    lines = [f"{'#':>2} {'名前':<12}{'位':<4}{'タイプ':<12}"
             f"{'蹴':>4}{'速':>4}{'体':>4}{'技':>4}{'力':>4}  "
             f"{'ゾン/マン':>9}{'press':>6}{'sup':>5}{'ovl':>5}{'run':>5}{'wait':>5}"]
    squad = career.me.all_players
    for i, p in enumerate(squad):
        mark = "*" if i < C.PLAYERS_ON_PITCH else " "
        h = p.hidden
        lines.append(
            f"{i:>2}{mark}{p.name:<12}{p.position:<4}{p.type_name:<12}"
            f"{p.kick:>4}{p.speed:>4}{p.stamina:>4}{p.technique:>4}{p.physical:>4}  "
            f"{h['zone_man']:>+9}{h['press']:>6}{h['support']:>5}{h['overlap']:>5}"
            f"{h['run_space']:>5}{h['goal_wait']:>5}"
        )
    lines.append("  * = 先発11人 ／ ゾン(-)〜マン(+)")
    return "\n".join(lines)


def format_cards(career: Career) -> str:
    if not career.cards:
        return "  所持カード: なし（試合で課題が出るともらえます）"
    parts = [f"{CARDS[k].label}×{n}" for k, n in sorted(career.cards.items())]
    return "  所持カード: " + " / ".join(parts)


def format_tactics(career: Career) -> str:
    t = career.me.tactics
    m = career.me.manager
    lines = [
        f"  フォーメーション: {t.formation}",
        f"  ライン高さ: {t.line_height}  守備幅: {t.zone_width}  姿勢: {t.attitude}",
        f"  監督: 攻撃性{m.style:+d} 徹底{m.rigidity:+d}"
        f" 交代{m.substitution:+d} 起用{m.selection:+d}",
    ]
    if career.me.policy:
        lines.append("  チーム方針（上から順に判定）:")
        for i, r in enumerate(career.me.policy, 1):
            lines.append(f"    {i}. {r.condition} → {r.action}")
    else:
        lines.append("  チーム方針: なし")
    return "\n".join(lines)


def format_match_digest(career: Career, outcome: dict) -> str:
    mine = outcome["mine"]
    res = mine["match"]
    rec = mine["record"]
    i = mine["my_index"]
    opp_i = 1 - i
    home, away = rec["home"], rec["away"]
    lines = [RULE,
             f"第{rec['round']}節  {home} {rec['home_goals']} - {rec['away_goals']} {away}",
             RULE]
    goals = [e for e in res["events"] if e["type"] == "ゴール"]
    if goals:
        lines.append("  得点:")
        for g in goals:
            lines.append(f"    {g['time']}  {g['team']}  {g['player']}")
    else:
        lines.append("  得点なし")
    ms, os_ = res["stats"][i], res["stats"][opp_i]
    lines.append(f"  シュート {ms['shots']} - {os_['shots']}"
                 f"   支配率 {ms['possession_pct']}% - {os_['possession_pct']}%"
                 f"   パス成功 {ms['pass_success_pct']}% - {os_['pass_success_pct']}%")
    lines.append(f"  ボール奪取 {ms['tackles_won']} - {os_['tackles_won']}"
                 f"   オフサイド {ms['offsides']} - {os_['offsides']}"
                 f"   走行 {ms['distance_km']}km - {os_['distance_km']}km")
    subs = [e for e in res["events"] if e["type"] == "交代" and e["team"] == career.user_team]
    if subs:
        lines.append("  交代: " + " / ".join(e["detail"] for e in subs))
    fired = [e for e in res["events"]
             if e["type"] == "方針の発動" and e["team"] == career.user_team]
    if fired:
        lines.append(f"  チーム方針が発動: {len(fired)}回（{fired[0]['detail']} など）")
    if mine["awarded"]:
        lines.append("  🎴 特訓カードを獲得:")
        for key in mine["awarded"]:
            lines.append(f"    「{CARDS[key].label}」 ← {CARDS[key].issue}")
    else:
        lines.append("  課題なし（カードの獲得なし）")
    if outcome["others"]:
        lines.append("  他会場: " + " / ".join(
            f"{r['home']} {r['home_goals']}-{r['away_goals']} {r['away']}"
            for r in outcome["others"]))
    return "\n".join(lines)


# ---------------------------------------------------------------- ゲーム本体


class Game:
    def __init__(self, console: Console, save_path: str | Path = DEFAULT_SAVE) -> None:
        self.c = console
        self.save_path = Path(save_path)
        self.career: Career | None = None

    # ------------------------------------------------------------ 起動
    def run(self) -> int:
        self.c.out()
        self.c.out("=" * 66)
        self.c.out("  ドットサッカー育成ゲーム（MVP・コマンド版）")
        self.c.out("=" * 66)
        try:
            self._start()
            self._main_loop()
        except Quit as e:
            self.c.out(f"\n{e}")
            if self.career is not None:
                self._save(quiet=False)
            self.c.out("またお待ちしています。")
            return 0
        return 0

    def _start(self) -> None:
        if self.save_path.exists():
            self.c.out(f"\nセーブデータがあります: {self.save_path}")
            choice = self.c.choose("選んでください", [
                ("1", "続きから遊ぶ"),
                ("2", "新しく始める（今のセーブは上書きされます）"),
                ("0", "やめる"),
            ])
            if choice == "0":
                raise Quit("終了します。")
            if choice == "1":
                try:
                    self.career = Career.load(self.save_path)
                except SaveError as e:
                    self.c.out(f"  ⚠ 読み込めませんでした: {e}")
                    self.c.out("  新しく始めます。")
                else:
                    self.c.out(f"  {self.career.user_team} / "
                               f"{self.career.season}シーズン目 "
                               f"第{self.career.round_index + 1}節から")
                    return
        self.career = self._new_game()
        self._save(quiet=True)

    def _new_game(self) -> Career:
        self.c.out("\n--- 新しいチームを作ります ---")
        while True:
            name = self.c.ask("チーム名", "わがチーム")
            if not name:
                self.c.out("  ⚠ チーム名を入れてください")
                continue
            try:
                seed = self.c.ask_int("運の種（同じ数字なら同じ展開になります）", 1, 999999, 1)
                formations = list(FORMATIONS)
                self.c.out("  フォーメーション:")
                key = self.c.choose("番号", [(str(i + 1), f) for i, f in enumerate(formations)])
                formation = formations[int(key) - 1]
                plan = self._choose_initial_plan()
                return Career.new_game(name, seed, formation, plan)
            except ValueError as e:
                self.c.out(f"  ⚠ {e}")

    def _choose_initial_plan(self) -> dict[str, int]:
        self.c.out()
        self.c.out(f"  初期育成: 全選手に特訓を{TRAININGS_PER_PLAYER}回行います。")
        self.c.out("  （AIチームも同じ回数だけ育った状態で開幕します。"
                   "配分がチームの個性になります）")
        options = [(str(i + 1), f"{name}と同じ配分") for i, name in enumerate(PRESET_PLANS)]
        options.append(("9", "自分で配分する"))
        key = self.c.choose("選んでください", options)
        if key != "9":
            name = list(PRESET_PLANS)[int(key) - 1]
            plan = dict(PRESET_PLANS[name][0])
            self.c.out(f"  → {name}と同じ配分: "
                       + " / ".join(f"{CARDS[k].label}{v}回" for k, v in plan.items()))
            return plan
        return self._custom_plan()

    def _custom_plan(self) -> dict[str, int]:
        while True:
            plan: dict[str, int] = {}
            remaining = TRAININGS_PER_PLAYER
            keys = list(CARDS)
            for i, key in enumerate(keys):
                if remaining == 0:
                    break
                last = (i == len(keys) - 1)
                if last:
                    self.c.out(f"  「{CARDS[key].label}」に残り全部（{remaining}回）を割り当てます")
                    plan[key] = remaining
                    remaining = 0
                    break
                n = self.c.ask_int(f"「{CARDS[key].label}」に何回？ 残り{remaining}回",
                                   0, remaining, 0)
                if n:
                    plan[key] = n
                remaining -= n
            if remaining > 0:
                self.c.out(f"  ⚠ {remaining}回あまりました。もう一度配分してください。")
                continue
            if sum(plan.values()) != TRAININGS_PER_PLAYER:
                self.c.out("  ⚠ 合計が合いません。もう一度。")
                continue
            plan = {k: v for k, v in plan.items() if v > 0}
            if not plan:
                plan = default_user_plan()
            self.c.out("  → " + " / ".join(f"{CARDS[k].label}{v}回" for k, v in plan.items()))
            return plan

    # ------------------------------------------------------------ メイン
    def _main_loop(self) -> None:
        assert self.career is not None
        while True:
            car = self.career
            self.c.out()
            self.c.out(RULE)
            if car.season_finished:
                head = f"{car.season}シーズン目 — 全{car.total_rounds}節 終了"
            else:
                nxt = car.my_next_match()
                opponent = nxt[1] if nxt and nxt[0] == car.user_team else (nxt[0] if nxt else "—")
                where = "ホーム" if nxt and nxt[0] == car.user_team else "アウェー"
                head = (f"{car.season}シーズン目 第{car.round_index + 1}節/{car.total_rounds}"
                        f"  次の相手: {opponent}（{where}）")
            self.c.out(f"  {car.user_team}  {car.my_rank()}位  {head}")
            self.c.out(format_cards(car))
            self.c.out(RULE)
            options = [
                ("1", "シーズンを締める" if car.season_finished else "次の試合へ"),
                ("2", "選手と特訓"),
                ("3", "戦術を決める"),
                ("4", "順位表と日程"),
                ("5", "セーブする"),
                ("0", "セーブしてやめる"),
            ]
            key = self.c.choose("何をしますか", options)
            if key == "1":
                if car.season_finished:
                    self._screen_season_end()
                else:
                    self._screen_next_match()
            elif key == "2":
                self._screen_squad()
            elif key == "3":
                self._screen_tactics()
            elif key == "4":
                self._screen_table()
            elif key == "5":
                self._save(quiet=False)
            elif key == "0":
                self._save(quiet=False)
                raise Quit("終了します。")

    # ------------------------------------------------------------ 各画面
    def _screen_next_match(self) -> None:
        car = self.career
        assert car is not None
        fixture = car.my_next_match()
        if fixture is None:
            # 🔴 8チームの総当たりでは起きない。起きたら**日程が壊れている**ので、
            #    そう読める形で止める（None を添字で引くと TypeError になり、
            #    原因が日程だと誰にも分からない）
            raise RuntimeError(
                f"第{car.round_index + 1}節の日程に {car.user_team} の試合が無い")
        self.c.out()
        self.c.out(f"  第{car.round_index + 1}節: {fixture[0]} vs {fixture[1]}")
        self.c.out(format_tactics(car))
        if self.c.choose("この戦術で試合をしますか", [("1", "する"), ("2", "戦術を見直す")]) == "2":
            self._screen_tactics()
            return
        outcome = car.play_round()
        self.c.out(format_match_digest(car, outcome))
        self._save(quiet=True)
        self.c.out()
        self.c.out(format_standings(car.standings(), highlight=car.user_team))
        if car.season_finished:
            self.c.out()
            self.c.out("  ★ 全節終了です。メニューの「シーズンを締める」へ。")
        self.c.pause()

    def _screen_season_end(self) -> None:
        car = self.career
        assert car is not None
        summary = car.finish_season()
        self.c.out()
        self.c.out(RULE)
        self.c.out(f"  {summary['season']}シーズン目 終了 — {car.user_team} は "
                   f"{summary['rank']}位 / {len(car.team_names)}チーム")
        self.c.out(RULE)
        self.c.out(format_standings(summary["table"], highlight=car.user_team))
        self.c.out()
        self.c.out(f"  AIチームも1シーズンで{C.AI_TRAININGS_PER_SEASON}回ずつ特訓しました。")
        self.c.out(f"  → {car.season}シーズン目が始まります。")
        self._save(quiet=True)
        self.c.pause()

    def _screen_squad(self) -> None:
        car = self.career
        assert car is not None
        while True:
            self.c.out()
            self.c.out(format_squad(car))
            self.c.out(format_cards(car))
            key = self.c.choose("どうしますか", [
                ("1", "特訓する"), ("2", "先発を入れ替える"), ("0", "戻る")])
            if key == "0":
                return
            if key == "1":
                self._do_training()
            elif key == "2":
                self._swap_starter()

    def _do_training(self) -> None:
        car = self.career
        assert car is not None
        if not car.cards:
            self.c.out("  ⚠ 所持カードがありません。試合で課題が出るともらえます。")
            return
        squad = car.me.all_players
        idx = self.c.ask_int("誰を育てますか（#）", 0, len(squad) - 1, 0)
        stock = sorted(car.cards.items())
        self.c.out("  使えるカード:")
        for i, (k, n) in enumerate(stock, 1):
            card = CARDS[k]
            self.c.out(f"    {i}) {card.label}×{n}  "
                       f"（{card.visible_key}+{card.visible_gain} / "
                       f"{card.hidden_key}{card.hidden_gain:+d}）")
        first = self.c.ask_int("1枚目（番号）", 1, len(stock), 1)
        card_keys = [stock[first - 1][0]]
        if self.c.choose("2枚使ってスペシャルにしますか", [("1", "しない"), ("2", "する")]) == "2":
            second = self.c.ask_int("2枚目（番号）", 1, len(stock), 1)
            card_keys.append(stock[second - 1][0])
            pair = frozenset(card_keys)
            if len(pair) == 2 and pair in FORBIDDEN_PAIRS:
                self.c.out(f"  ⚠ {CARDS[card_keys[0]].label} と {CARDS[card_keys[1]].label} は"
                           "打ち消し合うので同時に使えません。")
                return
            if len(pair) == 1:
                self.c.out("  ⚠ スペシャルは違う2枚で作ります。")
                return
            self.c.out(f"  スペシャル: 「{special_name(*card_keys)}」")
        try:
            result = car.train_player(idx, card_keys)
        except ValueError as e:
            self.c.out(f"  ⚠ {e}")
            return
        player = car.me.all_players[idx]
        self.c.out(f"  ▷ {result['player']} に「{result['label']}」")
        for k, v in result["deltas"].items():
            before = result["visible_before"].get(k, result["hidden_before"].get(k))
            after = getattr(player, k)
            capped = "（上限）" if after - before < v else ""
            self.c.out(f"      {k}: {before} → {after} ({v:+d}){capped}")
        if result["before"] != result["after"]:
            self.c.out(f"      ★ タイプが変わった: {result['before']} → {result['after']}")
        else:
            self.c.out(f"      タイプ: {result['after']}（変化なし）")
        self._save(quiet=True)

    def _swap_starter(self) -> None:
        car = self.career
        assert car is not None
        a = self.c.ask_int("先発から外す選手（#）", 0, C.PLAYERS_ON_PITCH - 1, 0)
        out_p = car.me.players[a]
        # 控えのどれが入れられるかを先に見せる。控えの先頭はGKなので、
        # 番号だけ示して「好きに選べ」にすると必ずGKとの不一致を踏む。
        want_gk = out_p.position == "GK"
        candidates = [(C.PLAYERS_ON_PITCH + i, p) for i, p in enumerate(car.me.bench)
                      if (p.position == "GK") == want_gk]
        if not candidates:
            kind = "GK" if want_gk else "フィールド選手"
            self.c.out(f"  ⚠ 控えに入れ替えられる{kind}がいません。")
            return
        self.c.out(f"  {out_p.name}（{out_p.position}）と入れ替えられる控え:")
        for idx, p in candidates:
            self.c.out(f"    {idx}) {p.name}  {p.position}  {p.type_name}")
        b = self.c.ask_int("先発に入れる選手（#）", candidates[0][0], candidates[-1][0],
                           candidates[0][0])
        in_p = car.me.bench[b - C.PLAYERS_ON_PITCH]
        if (out_p.position == "GK") != (in_p.position == "GK"):
            self.c.out("  ⚠ GKはGKとだけ入れ替えられます（先発のGKは必ず1人）。")
            return
        car.me.players[a] = in_p
        car.me.bench[b - C.PLAYERS_ON_PITCH] = out_p
        self.c.out(f"  ▷ {out_p.name} ⇄ {in_p.name}")
        self._save(quiet=True)

    def _screen_tactics(self) -> None:
        car = self.career
        assert car is not None
        while True:
            self.c.out()
            self.c.out(format_tactics(car))
            key = self.c.choose("何を変えますか", [
                ("1", "フォーメーション"), ("2", "ライン高さ・守備幅・姿勢"),
                ("3", "チーム方針"), ("4", "監督の性格"), ("0", "戻る")])
            if key == "0":
                self._save(quiet=True)
                return
            t = car.me.tactics
            if key == "1":
                formations = list(FORMATIONS)
                pick = self.c.choose("番号", [(str(i + 1), f) for i, f in enumerate(formations)])
                car.me.tactics = Tactics(t.line_height, t.zone_width, t.attitude,
                                         formations[int(pick) - 1])
            elif key == "2":
                line = self.c.ask_int("ライン高さ（低い1〜高い5）", 1, 5, t.line_height)
                width = self.c.ask_int("守備幅（狭い1〜広い5）", 1, 5, t.zone_width)
                pick = self.c.choose("姿勢", [(str(i + 1), a) for i, a in enumerate(ATTITUDES)])
                car.me.tactics = Tactics(line, width, ATTITUDES[int(pick) - 1], t.formation)
            elif key == "3":
                self._edit_policy()
            elif key == "4":
                m = car.me.manager
                car.me.manager = Manager(
                    style=self.c.ask_int("攻撃性（守備的-2〜攻撃的+2）", -2, 2, m.style),
                    rigidity=self.c.ask_int("徹底度（弾力的-2〜徹底的+2）", -2, 2, m.rigidity),
                    substitution=self.c.ask_int(
                        "交代（消極的-2〜積極的+2）", -2, 2, m.substitution),
                    selection=self.c.ask_int("起用（安定感-2〜期待感+2）", -2, 2, m.selection),
                )

    def _edit_policy(self) -> None:
        car = self.career
        assert car is not None
        while True:
            self.c.out()
            if car.me.policy:
                for i, r in enumerate(car.me.policy, 1):
                    self.c.out(f"    {i}. {r.condition} → {r.action}")
            else:
                self.c.out("    （方針なし）")
            self.c.out(f"    最大{C.POLICY_MAX_RULES}個。"
                       "上から順に判定し、最初に当てはまった1つだけ実行。")
            key = self.c.choose("どうしますか", [
                ("1", "追加する"), ("2", "削除する"), ("0", "戻る")])
            if key == "0":
                return
            if key == "1":
                if len(car.me.policy) >= C.POLICY_MAX_RULES:
                    self.c.out(f"  ⚠ 方針は最大{C.POLICY_MAX_RULES}個です。")
                    continue
                self.c.out("  条件:")
                ci = self.c.choose("番号", [(str(i + 1), c)
                                           for i, c in enumerate(POLICY_CONDITIONS)])
                self.c.out("  行動:")
                ai = self.c.choose("番号", [(str(i + 1), a)
                                           for i, a in enumerate(POLICY_ACTIONS)])
                car.me.policy.append(PolicyRule(POLICY_CONDITIONS[int(ci) - 1],
                                                POLICY_ACTIONS[int(ai) - 1]))
            elif key == "2":
                if not car.me.policy:
                    continue
                n = self.c.ask_int("何番を削除しますか", 1, len(car.me.policy), 1)
                removed = car.me.policy.pop(n - 1)
                self.c.out(f"  ▷ 削除: {removed.condition} → {removed.action}")

    def _screen_table(self) -> None:
        car = self.career
        assert car is not None
        self.c.out()
        self.c.out(format_standings(car.standings(), highlight=car.user_team))
        self.c.out()
        remaining = car.schedule[car.round_index:]
        if remaining:
            self.c.out("  残りの日程（自チームのみ）:")
            for offset, rnd in enumerate(remaining):
                for home, away in rnd:
                    if car.user_team in (home, away):
                        where = "H" if home == car.user_team else "A"
                        opp = away if home == car.user_team else home
                        self.c.out(f"    第{car.round_index + offset + 1}節  {where}  {opp}")
        else:
            self.c.out("  残りの日程はありません。")
        if car.history:
            self.c.out()
            self.c.out("  過去の成績: " + " / ".join(
                f"{h['season']}季 {h['rank']}位" for h in car.history))
        self.c.pause()

    # ------------------------------------------------------------ 保存
    def _save(self, quiet: bool) -> None:
        if self.career is None:
            return
        path = self.career.save(self.save_path)
        if not quiet:
            self.c.out(f"  💾 セーブしました: {path}")


def play_game(save_path: str | Path = DEFAULT_SAVE,
              inputs: Iterable[str] | None = None,
              writer: Callable[[str], None] | None = None) -> int:
    """ゲームを起動する。`inputs` を渡すと無人で走る（テスト用）。"""
    if inputs is not None:
        it = iter(list(inputs))

        def reader() -> str:
            try:
                return next(it)
            except StopIteration as e:
                raise Quit("入力が終了しました") from e
        console = Console(reader=reader, writer=writer)
    else:
        from .__main__ import force_utf8_io  # 入出力の UTF-8 固定は1箇所にまとめる
        force_utf8_io()
        console = Console(writer=writer)
    return Game(console, save_path).run()
