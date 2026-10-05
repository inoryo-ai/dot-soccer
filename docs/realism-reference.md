# サッカーらしさの基準値（現実のプロサッカー）

試合エンジンが「それっぽい」ではなく**サッカーとして正しく動いているか**を確かめるための、現実の数字の一覧。
2026-10-05 作成（D-42 の準備）。

🔴 **ここの数字は「こうあってほしい」ではなく「現実のサッカーがこうである」。** 変えるときは出典ごと変える。
🔴 **出典を開いて原文を確かめた数字だけを載せる。** 孫引き・非査読・少数試合のものは「監視のみ」に置き、合否の判定に使わない。

## 0. 使ってよいデータ（このゲームは商用＝NFT ゲームとして扱う）

| データ | 規約 | 扱い |
|---|---|---|
| 論文・リーグ公式・データ会社の公開記事の**数字** | 事実を出典つきで引く | ✅ 使う（この文書の大半） |
| Wyscout 公開データ（Pappalardo ら 2019, figshare c.4415000） | **CC BY 4.0**（クレジット表示で商用可。2026-10-05 に figshare で全ファイル確認） | ✅ 使える。自前で集計する材料（§3） |
| Metrica Sports サンプル（位置データ3試合） | ライセンス記載なし。「責任を持って使う」「公開時は出典を書く」のみ | ⚠️ 使わない（使うなら先に問い合わせ） |
| StatsBomb オープンデータ | 利用規約 1.2.2「データおよび**派生した分析**の商用利用を禁止」 | ❌ 使わない。StatsBomb 由来の数字も載せない |

## 1. 出来事（パス・シュート・中断）

値は特記なければ **1チーム1試合あたり**。

### 判定に使う

| 指標 | 現実の値 | 出典 |
|---|---|---|
| パス数（試行） | 約 450〜490 本 | [CC23] 489.8（ビッグ5 2017/18〜20/21）、[OA26] PL 両チーム 893.4（2024-25）＝約447 |
| パス成功率 | 78〜81% | [CC23] 78%、[BF26] 上位 85.7 / 中位 80.5 / 下位 75.9（算出平均 80.7） |
| パス距離の構成 | ショート(4.6〜13.7m) 約36% / ミドル(13.7〜27.4m) 約40% / ロング(27.4m超) 約21% | [CC23]（FBref 区分。表の一部が崩れているので幅を広めに取る） |
| 距離別の成功率 | ショート 86% / ミドル 85% / ロング 59% | [CC23] |
| ロングボール（32m以上）の割合 | 全パスの約 10.5% | [OA26] PL 2024-25 |
| シュート数 | 12〜14 本（勝ち試合 14.4、負け試合 11.9） | [LP10] ラ・リーガ 2008-09、[BF26] 13.08、[OA24] PL 両チーム 25.3 |
| 枠内率 | 約 35% | [BF26] 4.59 / 13.08 |
| ボックス内からのシュートの割合 | 56〜68% | [RA17] PL 55.9% / BL 58.0%（2012-13）、[PL25] ボックス外 31.7%（2024/25） |
| 平均シュート距離 | 約 15 m | [OA24] 14.9 m（PL 2023-24） |
| 決定率（エリア内／外） | 内 13.6〜15.6% ／ 外 3.5〜4.2% | [RA17]、[PL25] 内 14.7% / 外 4.2% |
| 実プレー時間（ボールが動いている時間） | 54〜59 分（試合時間の約 55〜62%） | [LH17] 56:04±5:12（BL, TRACAB）、[PLBIP] 54:52〜58:37 |
| 中断から再開する回数（両チーム合計） | スローイン 36〜40 / FK 約33 / ゴールキック 15〜17 / CK 約10 | [SL12]、[OA26b] スローイン 35.8・GK 15.5、[OA26b] CK 10.2 |
| オフサイド | 2.4〜2.9 回 | [LP10] |
| セットプレーからの得点の割合（PK を除く） | 20〜28% | [OA26] PL 19.8〜28.3%、[LZ21] ビッグ5 21.4〜22.9% |
| タックル／インターセプト | 約 17 ／ 約 9 | [BF26] |

### 監視のみ（古い・非査読・定義が曖昧）

| 指標 | 値 | 出典・判定に使わない理由 |
|---|---|---|
| 1回の攻撃のパス本数 | 0本 43.6% / 1本 29.6% / 2本 15.5% / 3本 6.8%（3本以下 95.5%） | [RP71] 1957-58 年の手書き記録。古い |
| 平均パス長（リーグ平均） | 18.9〜21.1 m | [CIES] 非査読（InStat） |
| ポゼッションの回数（両チーム合計） | 約 252 回 | [AM24] 定義が曖昧 |
| 高い位置での奪取 | 13〜15 回 | [OA26] 定義も、1チームか両チームかも不明 |

## 2. 動き（陣形・走り方・速さ）

### 判定に使う

| 指標 | 現実の値 | 出典 |
|---|---|---|
| 守備時のチームの縦の長さ × 横幅（GK 除く10人） | 32.5±8.7 m × 37.3±4.8 m | [FO24a] BL 2020/21 153試合, TRACAB 25Hz |
| 守備時のライン間の距離 | DF–MF 10.2±3.8 m、MF–FW 13.3±4.2 m | [FO24a] |
| 1人あたりの総走行距離（ポジション別） | CB 9.4〜9.7 / SB 10.1〜10.3 / CM 10.5〜11.2 / WM 10.0〜10.5 / FW 9.5〜10.2 km | [LE26] ラ・リーガ 1608試合 TRACAB、[CO25] MLS 1243試合 Second Spectrum |
| スプリント回数（24 km/h 超） | CB 11.7 / SB 21.0 / CM 12.4 / WM 22.3 / FW 19.3 回 | [LE26] |
| 1試合の最高速度 | CB 30.7 / SB 31.8 / CM 29.8 / WM 31.9 / FW 31.9 km/h | [LE26] |
| シーズンを通した最高速度 | 32〜33 km/h（選手の 53.5% が 32.0〜33.9） | [DC20] ラ・リーガ 2017-18 475人 |
| PPDA（相手のパス数 ÷ 守備アクション数） | 8〜12 | [CA25] ビッグ5 2023-24、[ST24] |
| 相手の攻撃1回を守る時間 | 平均 21.7 秒。そのうちボールを奪えたのは 16.1% | [FO24b] BL 2020/21, TRACAB |

### 監視のみ

| 指標 | 値 | 理由 |
|---|---|---|
| 攻撃時の縦 × 横 | 36±7 × 41±10 m | [RG22] 孫引き（ラ・リーガ6試合） |
| ストレッチインデックス | 守備 7〜10 m ／ 攻撃 12〜16 m | [RG22] 孫引き |
| 最終ラインと自陣ゴールの距離 | 攻撃時 38±8 m、守備時は 6〜45 m（ボールの位置による） | [RG22] 孫引き。図から読み取った値 |
| 奪われてから奪い返すまで | 10〜14 秒 | [FO24b] 内の孫引き |

## 3. 物理の設定に使う値（判定ではなく、エンジンを作るときの材料）

| 値 | 現実 | 出典 |
|---|---|---|
| 最大加速度 ／ 最大減速度 | 4.4〜4.7 ／ −5.7〜−6.3 m/s² | [OL20] 2部1チーム GPS（補助） |
| 静止からの 10/20/30/40 m のタイム | 2.01 / 3.24 / 4.39 / 5.51 秒 | [HA19] ノルウェー代表のテスト |
| 最高速度に達するまで | 約 4 秒の加速（直前は約 10 km/h） | [SI25] |
| キックの球速 | インサイド 23.4 m/s ／ インステップ 28.0 m/s（全力キックは 18〜35 m/s） | [NU02] 実験室、[KK07] |
| GK の飛び込み | 体の中心が横へ 1.36〜1.54m、その平均の速さ 2.84〜3.18 m/s（ゴール中心から 3.5m 横のボールへ） | [SR22] PK の動作解析 |
| ボールの空気抵抗の係数 | 遅いとき 約0.43 ／ 速いとき（22〜30 m/s）約0.25。境目は 15〜21 m/s | [AS07] 風洞実験 |
| 芝の上での転がり | 高さ 1m の台から放して 4.0〜8.0m（FIFA Quality PRO の合格範囲） | [FIFA] 検索結果の要約で確認。PDF 本文は未読 |

**まだ出典がない（未確認）**: ボールを受けた瞬間の最寄りの相手までの距離／ボール保持者と最寄りの DF の距離／試合中のパス・シュートの球速／方向別（前・横・後ろ）のパス成功率／パス長の分布（査読論文）。
→ 方向別成功率とパス長の分布は、Wyscout 公開データ（CC BY 4.0）から自前で集計できる。

## 出典

- [CC23] Cordón-Carmona ら 2023, Open Sports Sciences J. https://opensportssciencesjournal.com/VOLUME/16/ELOCATOR/e1875399X263057/FULLTEXT/
- [BF26] Belfritas ら 2026, Sci J Sport Perform. https://sjsp.aearedo.es/index.php/sjsp/article/view/technical-performance-english-premier-league-teams
- [OA26] Opta Analyst 2026-01-16. https://theanalyst.com/articles/premier-league-teams-still-more-direct-2025-26
- [OA26b] Opta Analyst 2026-09-27. https://theanalyst.com/articles/premier-league-rules-throw-ins-goal-kicks-ball-in-play
- [OA24] Opta Analyst 2024-03-29. https://theanalyst.com/articles/numbers-behind-premier-league-goal-explosion
- [PL25] プレミアリーグ公式 2025-03-29. https://www.premierleague.com/en/news/4272809
- [PLBIP] プレミアリーグ公式 2024-01-19. https://www.premierleague.com/en/news/3860720
- [LP10] Lago-Peñas ら 2010, JSSM. https://www.jssm.org/volume09/iss2/cap/jssm-09-288.pdf
- [RA17] Rathke 2017, J Hum Sport Exerc. https://rua.ua.es/handle/10045/68771
- [LH17] Link & Hoernig 2017, PLOS ONE. https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0179953
- [SL12] Siegle & Lames 2012, J Sports Sci. https://portal.fis.tum.de/en/publications/game-interruptions-in-elite-soccer/
- [LZ21] Li & Zhao 2021, Front Psychol. https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2020.619304/full
- [RP71] Reep, Pollard & Benjamin 1971, JRSS A. https://academic.oup.com/jrsssa/article/134/4/623/7104572
- [CIES] CIES Football Observatory. https://football-observatory.com/Length-of-passes-the-best-like-it-short
- [AM24] Aranda-Malavés ら 2024, Frontiers. https://pmc.ncbi.nlm.nih.gov/articles/PMC11491368/
- [FO24a] Forcher ら 2024, IJSSC. https://doi.org/10.1177/17479541231172695
- [FO24b] Forcher ら 2024, Science and Medicine in Football. https://doi.org/10.1080/24733938.2022.2158213
- [LE26] Lampre-Ezquerra ら 2026, Biol Sport. https://pmc.ncbi.nlm.nih.gov/articles/PMC13217389/
- [CO25] Collins ら 2025, PLOS ONE. https://pmc.ncbi.nlm.nih.gov/articles/PMC12551844/
- [DC20] Del Coso ら 2020, IJERPH. https://pmc.ncbi.nlm.nih.gov/articles/PMC7729782/
- [CA25] Campos ら 2025, Front Psychol. https://pmc.ncbi.nlm.nih.gov/articles/PMC12872852/
- [ST24] Stafylidis ら 2024, JFMK. https://pmc.ncbi.nlm.nih.gov/articles/PMC11204448/
- [RG22] Rico-González ら 2022, Biol Sport（系統的レビュー）. https://pmc.ncbi.nlm.nih.gov/articles/PMC8805357/
- [OL20] Oliva-Lozano ら 2020, PLOS ONE. https://pmc.ncbi.nlm.nih.gov/articles/PMC7410317/
- [HA19] Haugen ら 2019, PLOS ONE. https://pmc.ncbi.nlm.nih.gov/articles/PMC6655540/
- [SI25] Silva ら 2025, Biol Sport. https://pmc.ncbi.nlm.nih.gov/articles/PMC11694206/
- [NU02] Nunome ら 2002, MSSE. https://pubmed.ncbi.nlm.nih.gov/12471312/
- [KK07] Kellis & Katis 2007, JSSM. https://pubmed.ncbi.nlm.nih.gov/24149324/
- [SR22] Penalty feet positioning rule modification and laterality effect on soccer goalkeepers' diving kinematics, Scientific Reports 2022. https://pmc.ncbi.nlm.nih.gov/articles/PMC9630263/
- [AS07] Asai ら 2007, Sports Engineering 10:101-110. https://people.stfx.ca/smackenz/courses/HK474/Labs/Jump%20Float%20Lab/Asai%202007%20Fundamental%20aerodynamics%20of%20the%20soccer%20ball.pdf
- [FIFA] FIFA Quality Programme for Football Turf, Test Manual II. https://digitalhub.fifa.com/m/7e03cf23203765a2/original/FIFA-quality-programme-for-football-turf-Test-Manual-II-Test-Requirements-2015v-3-4.pdf
- Wyscout 公開データ: Pappalardo ら 2019, Sci Data. https://www.nature.com/articles/s41597-019-0247-7 ／ https://doi.org/10.6084/m9.figshare.c.4415000.v5（CC BY 4.0）
