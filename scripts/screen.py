#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黒字転換2倍株スクリーニング (馬渕メソッド) — GitHub Actions 実行スクリプト
J-Quants API V2 から取得し、四半期の営業利益・経常利益の赤字→黒字転換を採点。
結果を docs/data/latest.json と history.json に出力し、(有効なら)メール送信する。

設定: リポジトリ直下の config.json
秘密情報(環境変数 / GitHub Secrets):
  JQUANTS_API_KEY    : J-Quants V2 の APIキー
  MAIL_APP_PASSWORD  : Gmail アプリパスワード(メール通知を使う場合)
"""
import os, json, time, smtplib, ssl, datetime, pathlib, sys
from email.mime.text import MIMEText
from email.header import Header
import urllib.request, urllib.parse, urllib.error

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
CONFIG_PATH = ROOT / "config.json"
JST = datetime.timezone(datetime.timedelta(hours=9))
API_BASE = "https://api.jquants.com"


# ----------------------------- 設定 -----------------------------
def load_config():
    cfg = {
        "scanMode": "codeList",            # codeList / recentDisclosures
        "codeList": ["6758", "7203", "9984", "4385", "3038"],
        "minScore": 40,
        "market": None,                    # "プライム"/"スタンダード"/"グロース"/None
        "fiscalMonth": None,               # 1..12 or None
        "themeKeyword": "",
        "budgetYen": 100000,
        "applyBudgetFilter": False,
        "requestsPerMinute": 5,            # Free:5 / Light:60 / Standard:120 / Premium:500
        "dataDelayDays": 90,               # 無料は約90日
        "lookbackDays": 60,
        "maxCandidates": 50,
        "email": {"enabled": False, "from": "", "to": ""},
    }
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception as e:
            print("config.json 読み込み失敗:", e, file=sys.stderr)
    return cfg


# ----------------------------- J-Quants V2 クライアント -----------------------------
class JQuants:
    def __init__(self, api_key, requests_per_minute=5):
        self.api_key = (api_key or "").strip()
        self.min_interval = 60.0 / max(1, requests_per_minute)
        self._last = 0.0

    def _throttle(self):
        wait = self.min_interval - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

    def _get_all(self, path, params):
        rows, pkey = [], None
        while True:
            self._throttle()
            q = dict(params)
            if pkey:
                q["pagination_key"] = pkey
            url = API_BASE + path + "?" + urllib.parse.urlencode(q)
            req = urllib.request.Request(url, headers={"x-api-key": self.api_key})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    j = json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                msg = e.read().decode("utf-8", "ignore")
                raise RuntimeError(f"HTTP {e.code}: {msg[:200]}")
            rows.extend(j.get("data", []))
            pkey = j.get("pagination_key")
            if not pkey:
                break
        return rows

    def master(self, code=None, as_of=None):
        params = {}
        if code:
            params["code"] = code
        if as_of:
            params["date"] = as_of
        out = {}
        for r in self._get_all("/v2/equities/master", params):
            c5 = r.get("Code", "")
            c = c5[:4] if len(c5) == 5 else c5
            out[c] = {
                "code": c, "name": r.get("CoName", c),
                "market": market_name(r.get("MktNm")),
                "sector17": r.get("S17Nm", "-"), "sector33": r.get("S33Nm", "-"),
            }
        return out

    def statements(self, code):
        return self._get_all("/v2/fins/summary", {"code": code})

    def disclosed_codes(self, date):
        s = set()
        for r in self._get_all("/v2/fins/summary", {"date": date}):
            c = r.get("Code", "")
            if c:
                s.add(c[:4] if len(c) == 5 else c)
        return list(s)

    def daily_bars(self, code, frm, to):
        """日次の四本値＋出来高(調整後優先)を取得。チャート分析(第4章)用。"""
        rows = self._get_all("/v2/equities/bars/daily",
                             {"code": code, "from": frm, "to": to})
        out = []
        for r in rows:
            d = r.get("Date")
            c = to_f(r.get("AdjC")) or to_f(r.get("C"))
            if not d or c is None:
                continue
            o = to_f(r.get("AdjO")) or to_f(r.get("O")) or c
            h = to_f(r.get("AdjH")) or to_f(r.get("H")) or c
            l = to_f(r.get("AdjL")) or to_f(r.get("L")) or c
            v = to_f(r.get("AdjVo")) or to_f(r.get("Vo")) or 0.0
            out.append({"date": d, "o": o, "h": h, "l": l, "c": c, "v": v})
        out.sort(key=lambda x: x["date"])
        return out

    def daily_closes(self, code, frm, to):
        return [{"date": b["date"], "close": b["c"]} for b in self.daily_bars(code, frm, to)]

    def index_bars(self, frm, to):
        """TOPIX指数の日次終値を取得。地合い判定(第6章)用。
        エンドポイント: /v2/indices/bars/daily/topix (項目: Date,O,H,L,C)。"""
        try:
            rows = self._get_all("/v2/indices/bars/daily/topix", {"from": frm, "to": to})
        except Exception:
            rows = []
        out = []
        for r in rows:
            d = r.get("Date")
            c = to_f(r.get("C"))
            if d and c is not None:
                out.append({"date": d, "c": c})
        out.sort(key=lambda x: x["date"])
        return out


def market_name(n):
    if not n:
        return "その他"
    for k in ("プライム", "スタンダード", "グロース"):
        if k in n:
            return k
    return "その他"


def to_f(v):
    if v is None or v == "" or v == "-":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ----------------------------- メソッド: 単独四半期 + 採点 -----------------------------
QNUM = {"1Q": 1, "2Q": 2, "3Q": 3, "4Q": 4, "FY": 4, "5Q": 5}


def parse_statement(r):
    disc = r.get("DiscDate")
    if not disc:
        return None
    return {
        "disc": disc,
        "ptype": r.get("CurPerType", ""),
        "periodEnd": r.get("CurPerEn") or r.get("CurFYEn") or disc,
        "fyEnd": r.get("CurFYEn") or disc,
        "sales": to_f(r.get("Sales")),
        "op": to_f(r.get("OP")),
        "ord": to_f(r.get("OdP")),
        "fop": to_f(r.get("FOP")),
        "opcf": to_f(r.get("CFO")),  # 営業CF(通期中心・四半期は空が多い)
    }


def single_quarter_points(sts):
    latest = {}
    for s in sts:
        if s["op"] is None:
            continue
        k = (s["fyEnd"], s["ptype"])
        if k not in latest or s["disc"] > latest[k]["disc"]:
            latest[k] = s
    arr = sorted(latest.values(), key=lambda s: (s["fyEnd"], QNUM.get(s["ptype"], 0)))
    pts = []
    prev_fy = None
    p_op = 0.0
    p_ord = None
    p_sales = None
    for s in arr:
        op = s["op"]
        new_fy = (s["fyEnd"] != prev_fy) or QNUM.get(s["ptype"], 0) == 1
        if new_fy:
            sop, sod = op, s["ord"]
            ss = s["sales"]
        else:
            sop = op - p_op
            sod = (s["ord"] - p_ord) if (s["ord"] is not None and p_ord is not None) else None
            ss = (s["sales"] - p_sales) if (s["sales"] is not None and p_sales is not None) else s["sales"]
        yy = s["periodEnd"][:7].replace("-", "/")
        pts.append({
            "label": f"{yy} {s['ptype']}", "periodEnd": s["periodEnd"],
            "quarter": QNUM.get(s["ptype"], 0),
            "op": sop, "ord": sod, "sales": ss,
        })
        prev_fy = s["fyEnd"]
        p_op = op
        p_ord = s["ord"]
        p_sales = s["sales"]
    return pts


def score_company(sts, window=6):
    all_pts = single_quarter_points(sts)
    forecast = None
    for s in sorted(sts, key=lambda x: x.get("disc", "")):
        f = to_f(s.get("fop")) if isinstance(s.get("fop"), str) else s.get("fop")
        if f is not None:
            forecast = f
    if len(all_pts) < 2:
        return 0.0, [], all_pts, -1, forecast
    pts = all_pts[-window:]
    op = [p["op"] for p in pts]
    od = [p["ord"] for p in pts]
    sales = [p["sales"] for p in pts]
    turn = -1
    for t in range(len(op) - 1, 0, -1):
        if op[t] > 0 and op[t - 1] <= 0:
            turn = t
            break
    if turn < 1:
        return 0.0, [{"title": "黒字転換シグナル", "detail": "直近に営業利益の赤字→黒字転換が見られません", "points": 0}], pts, -1, forecast
    sc = 0.0
    fac = []
    ord_turned = od[turn] is not None and od[turn - 1] is not None and od[turn] > 0 and od[turn - 1] <= 0
    if ord_turned:
        sc += 35
        fac.append({"title": "黒字転換", "detail": "営業利益・経常利益がともに赤字→黒字に転換", "points": 35})
    else:
        sc += 25
        note = "(経常利益は会計基準上なし)" if od[turn] is None else "(経常利益はまだ赤字)"
        fac.append({"title": "黒字転換", "detail": f"営業利益が赤字→黒字に転換 {note}", "points": 25})
    loss = 0
    i = turn - 1
    while i >= 0 and op[i] <= 0:
        loss += 1
        i -= 1
    b = min(loss * 5, 20)
    sc += b
    fac.append({"title": "継続赤字からの転換", "detail": f"転換前は{loss}四半期連続の営業赤字", "points": b})
    after = op[turn + 1:]
    if after:
        if all(x > 0 for x in after):
            sc += 10
            fac.append({"title": "転換後の継続", "detail": f"転換後{len(after)}四半期も黒字を維持", "points": 10})
        elif any(x <= 0 for x in after):
            sc -= 20
            fac.append({"title": "ダマシ注意", "detail": "転換後に営業赤字へ逆戻りあり(要注意)", "points": -20})
    if forecast is not None:
        if forecast > 0:
            sc += 15
            fac.append({"title": "通期予想", "detail": "通期営業利益予想が黒字=黒字継続が見込まれる", "points": 15})
        else:
            fac.append({"title": "通期予想", "detail": "通期営業利益予想は赤字(加点なし)", "points": 0})
    age = (len(op) - 1) - turn
    rec = {0: 15, 1: 10, 2: 5}.get(age, 0)
    sc += rec
    fac.append({"title": "早期性", "detail": ("最新四半期で転換(買い場の初動)" if age == 0 else f"転換は{age}四半期前"), "points": rec})
    if turn >= 1 and sales[turn] is not None and sales[turn - 1] is not None and sales[turn] > sales[turn - 1]:
        sc += 5
        fac.append({"title": "増収", "detail": "転換四半期は増収を伴う", "points": 5})
    sc = max(0.0, min(100.0, sc))
    return round(sc, 1), fac, pts, turn, forecast


# ----------------------------- メソッド: 買い時(第4章 チャート分析) -----------------------------
# 馬渕メソッド第4章「売買タイミングを見極めるチャート分析の基本」をアルゴリズム化。
#  移動平均線(5/25/75日)、ゴールデン/デッドクロス(安値圏で有効)、押し目買い、
#  もみ合いからの上放れ(出来高増)、移動平均乖離(過熱)、損切りライン(直近安値/75日線割れ)。
def _sma(a, n):
    if len(a) < n:
        return None
    return sum(a[-n:]) / n


def _sma_series(a, n):
    out = []
    for i in range(len(a)):
        if i + 1 < n:
            out.append(None)
        else:
            out.append(sum(a[i + 1 - n:i + 1]) / n)
    return out


def _pivots(highs, lows, w=5):
    """単純なスイング高値/安値(ピボット)の位置を返す。近接クラスタは統合。"""
    n = len(highs)
    rawmin, rawmax = [], []
    for i in range(w, n - w):
        if lows[i] == min(lows[i - w:i + w + 1]):
            rawmin.append(i)
        if highs[i] == max(highs[i - w:i + w + 1]):
            rawmax.append(i)

    def collapse(idxs, vals, take_min):
        out = []
        for i in idxs:
            if out and i - out[-1] <= w:
                if (take_min and vals[i] < vals[out[-1]]) or (not take_min and vals[i] > vals[out[-1]]):
                    out[-1] = i
            else:
                out.append(i)
        return out

    return collapse(rawmin, lows, True), collapse(rawmax, highs, False)


def _detect_patterns(highs, lows, closes):
    """第4章後半: Wボトム/逆三尊/三尊 を簡易検出。target=値幅観測(測定移動)。"""
    out = {}
    n = len(closes)
    if n < 40:
        return out
    look = min(n, 140)
    h, l, c = highs[-look:], lows[-look:], closes[-look:]
    mins, maxs = _pivots(h, l, 5)
    price = c[-1]
    # Wボトム: 直近2つの谷が同水準＋間の山(ネック)を現値が上抜け
    if len(mins) >= 2:
        m1, m2 = mins[-2], mins[-1]
        lo1, lo2 = l[m1], l[m2]
        if lo1 > 0 and abs(lo2 - lo1) / lo1 <= 0.06:
            between = [h[k] for k in maxs if m1 < k < m2]
            if between:
                neck = max(between)
                if price > neck:
                    out["double_bottom"] = True
                    out["target"] = neck + (neck - min(lo1, lo2))
    # 逆三尊: 3つの谷で中央が最安、両端が同水準、ネック超え
    if len(mins) >= 3:
        a, b, cc = mins[-3], mins[-2], mins[-1]
        if l[b] < l[a] and l[b] < l[cc] and abs(l[a] - l[cc]) / max(l[a], 1) <= 0.08:
            between = [h[k] for k in maxs if a < k < cc]
            if between:
                neck = max(between)
                if price > neck:
                    out["inverse_hs"] = True
                    out["target"] = neck + (neck - l[b])
    # 三尊(天井): 3つの山で中央が最高、ネック割れ
    if len(maxs) >= 3:
        a, b, cc = maxs[-3], maxs[-2], maxs[-1]
        if h[b] > h[a] and h[b] > h[cc] and abs(h[a] - h[cc]) / max(h[a], 1) <= 0.08:
            between = [l[k] for k in mins if a < k < cc]
            if between:
                neck = min(between)
                if price < neck:
                    out["head_shoulders"] = True
    return out


def timing_signal(bars):
    """日次OHLCV配列(昇順)から買い時シグナルを算出。
    返り値: signal(buy/dip/watch/avoid), label, score(0-100), checks[], ma{}, stopLoss, widthTarget"""
    res = {"signal": "watch", "label": "△様子見", "score": 0,
           "checks": [], "ma": {}, "stopLoss": None, "widthTarget": None}
    if not bars:
        res["checks"].append({"key": "data", "ok": False, "note": "株価データなし", "pts": 0})
        return res
    closes = [b["c"] for b in bars]
    vols = [b.get("v") or 0 for b in bars]
    lows = [b.get("l") if b.get("l") is not None else b["c"] for b in bars]
    highs = [b.get("h") if b.get("h") is not None else b["c"] for b in bars]
    n = len(closes)
    if n < 30:
        res["checks"].append({"key": "data", "ok": False, "note": "株価データ不足で買い時判定不可", "pts": 0})
        return res

    price = closes[-1]
    ma5, ma25, ma75 = _sma(closes, 5), _sma(closes, 25), _sma(closes, 75)
    ma25s, ma75s = _sma_series(closes, 25), _sma_series(closes, 75)
    res["ma"] = {"ma5": round(ma5, 1) if ma5 else None,
                 "ma25": round(ma25, 1) if ma25 else None,
                 "ma75": round(ma75, 1) if ma75 else None}
    checks = []
    score = 0

    # トレンド判定: 株価>75日線 かつ 25日線が上向き
    trend_up = False
    if ma25 and ma75 and len(ma25s) > 21 and ma25s[-21] is not None:
        trend_up = (price > ma75) and (ma25s[-1] > ma25s[-21])
    if trend_up:
        score += 25
        checks.append({"key": "trend", "ok": True, "note": "上昇トレンド（株価>75日線・25日線が上向き）", "pts": 25})
    else:
        checks.append({"key": "trend", "ok": False, "note": "明確な上昇トレンドではない", "pts": 0})

    # パーフェクトオーダー
    order = bool(ma5 and ma25 and ma75 and ma5 > ma25 > ma75)
    if order:
        score += 15
        checks.append({"key": "ma_order", "ok": True, "note": "パーフェクトオーダー（5日>25日>75日）", "pts": 15})

    # ゴールデンクロス(25日が75日を上抜け)を直近25日内で検出＋安値圏判定
    GC_WIN = 25
    gc = gc_low = False
    for i in range(max(1, n - GC_WIN), n):
        a0, a1 = ma25s[i - 1], ma25s[i]
        b0, b1 = ma75s[i - 1], ma75s[i]
        if None in (a0, a1, b0, b1):
            continue
        if a0 <= b0 and a1 > b1:
            gc = True
            if b1 and closes[i] <= b1 * 1.12:   # 安値圏: 75日線+12%以内でクロス
                gc_low = True
            break
    if gc and gc_low:
        score += 20
        checks.append({"key": "golden_cross", "ok": True, "note": "安値圏でゴールデンクロス（25日線が75日線を上抜け）", "pts": 20})
    elif gc:
        score += 8
        checks.append({"key": "golden_cross", "ok": True, "note": "ゴールデンクロスあり（高値圏のためダマシ注意）", "pts": 8})

    # デッドクロス(25日が75日を下抜け)を直近25日内で検出
    dc = False
    for i in range(max(1, n - GC_WIN), n):
        a0, a1 = ma25s[i - 1], ma25s[i]
        b0, b1 = ma75s[i - 1], ma75s[i]
        if None in (a0, a1, b0, b1):
            continue
        if a0 >= b0 and a1 < b1:
            dc = True
            break
    if dc:
        score -= 15
        checks.append({"key": "dead_cross", "ok": False, "note": "デッドクロス発生（売り/警戒シグナル）", "pts": -15})

    # 押し目: 上昇トレンド中、株価が25日線付近(-4%〜+3%)まで調整
    pullback = False
    if trend_up and ma25:
        dev25 = (price - ma25) / ma25
        if -0.04 <= dev25 <= 0.03:
            pullback = True
            score += 15
            checks.append({"key": "pullback", "ok": True, "note": "上昇トレンド中の押し目（25日線に接近）", "pts": 15})

    # もみ合いからの上放れ: 直近25日レンジ高値を出来高増で上抜け
    breakout = False
    RANGE_N = 25
    avgv = _sma(vols, 25) or 0
    if n > RANGE_N + 2:
        range_hi = max(highs[-(RANGE_N + 1):-1])
        vol_ok = (vols[-1] > avgv * 1.2) if avgv else False
        if price > range_hi and vol_ok:
            breakout = True
            score += 20
            checks.append({"key": "breakout", "ok": True, "note": "もみ合いを出来高増で上放れ", "pts": 20})

    # 出来高比(直近 / 25日平均)
    vr = (vols[-1] / avgv) if avgv else 0
    if avgv and vr >= 1.2:
        score += 10
        checks.append({"key": "volume", "ok": True, "note": "出来高増（25日平均比 %.1f倍）" % vr, "pts": 10})
    elif avgv:
        checks.append({"key": "volume", "ok": False, "note": "出来高は平常（25日平均比 %.1f倍）" % vr, "pts": 0})
    else:
        checks.append({"key": "volume", "ok": False, "note": "出来高データなし（デモ等）", "pts": 0})

    # 移動平均乖離(過熱)
    overheat = False
    if ma25:
        dev = (price - ma25) / ma25
        if dev > 0.15:
            overheat = True
            score -= 15
            checks.append({"key": "overheat", "ok": False, "note": "25日線から+%d%%乖離（過熱・高値掴み注意）" % round(dev * 100), "pts": -15})
        else:
            score += 5
            checks.append({"key": "overheat", "ok": True, "note": "過熱感は限定的", "pts": 5})

    # 損切りライン: 直近20日安値と75日線の高い方
    recent_low = min(lows[-20:])
    stop = max(recent_low, ma75) if ma75 else recent_low
    res["stopLoss"] = round(stop, 1)
    below_stop = price < stop
    if below_stop:
        score -= 20
        checks.append({"key": "stop", "ok": False, "note": "損切りライン（直近安値/75日線）を下回る", "pts": -20})
    else:
        score += 10
        checks.append({"key": "stop", "ok": True, "note": "損切りライン ¥%d を上回って推移" % int(stop), "pts": 10})

    # パターン認識(Wボトム/逆三尊/三尊)
    pat = _detect_patterns(highs, lows, closes)
    pattern_buy = pattern_sell = False
    if pat.get("double_bottom"):
        pattern_buy = True; score += 20
        checks.append({"key": "w_bottom", "ok": True, "note": "Wボトム成立（直近高値=ネックライン超え＝本格的な買いサイン）", "pts": 20})
        if pat.get("target"):
            res["widthTarget"] = round(pat["target"], 1)
    if pat.get("inverse_hs"):
        pattern_buy = True; score += 20
        checks.append({"key": "inv_hs", "ok": True, "note": "逆三尊成立（ネックライン超え＝上昇トレンド転換）", "pts": 20})
        if pat.get("target"):
            res["widthTarget"] = round(pat["target"], 1)
    if pat.get("head_shoulders"):
        pattern_sell = True; score -= 15
        checks.append({"key": "hs", "ok": False, "note": "三尊（天井のネックライン割れ＝本格的な売りサイン）", "pts": -15})

    # 値幅観測(参考): パターン未検出時は直近120日の値幅を現値に上乗せ
    if res["widthTarget"] is None:
        win = min(n, 120)
        try:
            sw = max(highs[-win:]) - min(lows[-win:])
            res["widthTarget"] = round(price + sw, 1)
        except Exception:
            pass

    score = max(0, min(100, score))
    res["score"] = round(score)
    res["checks"] = checks

    # 総合判定（Wボトム/逆三尊のネック超えは本格的な買いサインとして過熱より上位）
    if below_stop or dc or pattern_sell:
        res["signal"], res["label"] = "avoid", "×見送り"
    elif pattern_buy:
        res["signal"], res["label"] = "buy", "◎買い場"
    elif overheat:
        res["signal"], res["label"] = "watch", "△様子見（過熱）"
    elif breakout or (gc and gc_low):
        res["signal"], res["label"] = "buy", "◎買い場"
    elif pullback:
        res["signal"], res["label"] = "dip", "○押し目・初動"
    elif score >= 55 and trend_up:
        res["signal"], res["label"] = "dip", "○押し目・初動"
    else:
        res["signal"], res["label"] = "watch", "△様子見"
    return res



# ----------------------------- メソッド: IRシグナル(第5章 IR情報をフル活用) -----------------------------
# 馬渕メソッド第5章を点数化。
#  1) 通期営業利益予想(FOP)の「上方修正」検出(開示履歴の比較)
#  2) 進捗率(達成率) = 累計営業利益 ÷ 通期予想。四半期基準(1Q25%/2Q50%/3Q75%)と比較し上振れ判定
#  3) 営業利益と営業CFの乖離 = 危険信号(営業CFが取得できた場合のみ)
QBENCH = {1: 25, 2: 50, 3: 75, 4: 100}


def ir_signal(sts):
    out = {"signals": [], "upwardRevision": None, "progress": None, "cfDivergence": None}
    if not sts:
        return out
    ss = sorted(sts, key=lambda s: s.get("disc", ""))

    # 1) 上方修正: FOPの履歴を時系列で比較し、直近の変化(増額/減額)を検出
    fops = [s["fop"] for s in ss if s.get("fop") is not None]
    if len(fops) >= 2:
        last = fops[-1]
        prev = None
        for f in reversed(fops[:-1]):
            if f != last:
                prev = f
                break
        if prev is not None:
            if last > prev:
                out["upwardRevision"] = True
                out["signals"].append({"key": "revision", "ok": True,
                    "note": "通期営業利益予想が上方修正（前回予想から増額）", "pts": 20})
            elif last < prev:
                out["upwardRevision"] = False
                out["signals"].append({"key": "revision", "ok": False,
                    "note": "通期営業利益予想が下方修正（減額）", "pts": -15})

    # 2) 進捗率: 累計OPとFOPを持つ直近開示で算出
    cand = [s for s in ss if s.get("op") is not None and s.get("fop") not in (None, 0)]
    if cand:
        s = cand[-1]
        q = QNUM.get(s["ptype"], 0)
        if s["fop"] > 0 and q in QBENCH:
            prog = s["op"] / s["fop"] * 100
            out["progress"] = round(prog, 1)
            bench = QBENCH[q]
            if prog >= bench:
                out["signals"].append({"key": "progress", "ok": True,
                    "note": "進捗率%d%%（%s基準%d%%を上回る＝上振れ期待）" % (round(prog), s["ptype"], bench), "pts": 15})
            else:
                out["signals"].append({"key": "progress", "ok": False,
                    "note": "進捗率%d%%（%s基準%d%%に未達）" % (round(prog), s["ptype"], bench), "pts": 0})

    # 3) 営業利益と営業CFの乖離(取得できた場合のみ)
    cf = None
    for s in reversed(ss):
        if s.get("opcf") is not None and s.get("op") is not None:
            cf = s
            break
    if cf is not None:
        div = (cf["op"] > 0 and cf["opcf"] < cf["op"] * 0.3)
        out["cfDivergence"] = div
        if div:
            out["signals"].append({"key": "cf", "ok": False,
                "note": "営業利益に対し営業CFが著しく小さい（利益とCFの乖離＝危険信号）", "pts": -10})
        else:
            out["signals"].append({"key": "cf", "ok": True,
                "note": "営業CFは営業利益に概ね見合う", "pts": 5})
    return out



# ----------------------------- メソッド: 相場サイクル/地合い(第6章) -----------------------------
def market_regime(jq, as_of, frm):
    """指数(TOPIX)の長期移動平均からリスクオン/オフを判定(第6章)。
    取得できない場合は label=None として「本番環境で表示」とする。"""
    try:
        bars = jq.index_bars(frm, as_of)
    except Exception as e:
        print("index err", e, file=sys.stderr)
        bars = []
    if not bars or len(bars) < 60:
        return {"label": None, "index": "TOPIX", "value": None,
                "note": "指数データ未取得のため地合い判定は本番環境(J-Quants)で表示されます"}
    closes = [b["c"] for b in bars]
    last = closes[-1]
    nlong = 200 if len(closes) >= 200 else 75
    malong = _sma(closes, nlong)
    mas = _sma_series(closes, nlong)
    rising = (len(mas) > 21 and mas[-1] is not None and mas[-21] is not None and mas[-1] > mas[-21])
    if malong and last > malong and rising:
        return {"label": "リスクオン", "index": "TOPIX", "value": round(last, 1),
                "note": "TOPIXが長期線(%d日)の上・上向き（業績相場/緩和局面寄り＝買い場探しに追い風）" % nlong}
    if malong and last < malong and not rising:
        return {"label": "リスクオフ", "index": "TOPIX", "value": round(last, 1),
                "note": "TOPIXが長期線(%d日)の下・下向き（逆相場局面＝新規買いは慎重に）" % nlong}
    return {"label": "中立", "index": "TOPIX", "value": round(last, 1),
            "note": "TOPIXは長期線付近でもみ合い（局面の移行期）"}


def monthly_ohlc(daily):
    """日次OHLCV(キー d,o,h,l,c,v)を月次に集計。"""
    groups = {}
    order = []
    for b in daily:
        k = b["d"][:7]
        if k not in groups:
            groups[k] = []
            order.append(k)
        groups[k].append(b)
    out = []
    for k in order:
        arr = groups[k]
        out.append({"d": arr[-1]["d"], "o": arr[0]["o"],
                    "h": max(x["h"] for x in arr), "l": min(x["l"] for x in arr),
                    "c": arr[-1]["c"], "v": sum((x["v"] or 0) for x in arr)})
    return out


# ----------------------------- ウォッチリスト(jsonbin)取得 -----------------------------
def fetch_watch_codes():
    """jsonbin からウォッチリストを読み、銘柄コード一覧を返す。
    Secrets: JSONBIN_KEY (X-Master-Key) / JSONBIN_BIN (Bin ID)。未設定なら空。"""
    key = os.environ.get("JSONBIN_KEY", "").strip()
    bin_id = os.environ.get("JSONBIN_BIN", "").strip()
    if not (key and bin_id):
        return []
    url = "https://api.jsonbin.io/v3/b/%s/latest" % bin_id
    req = urllib.request.Request(url, headers={"X-Master-Key": key, "X-Bin-Meta": "false"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            obj = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print("watchlist取得失敗:", e, file=sys.stderr)
        return []
    if isinstance(obj, dict) and isinstance(obj.get("record"), dict):
        obj = obj["record"]
    if not isinstance(obj, dict):
        return []
    codes = []
    for k in obj.keys():
        c = str(k).strip()
        if c:
            codes.append(c[:4] if len(c) == 5 else c)
    return codes


def build_watch(jq, cfg, results):
    """ウォッチ銘柄の最新データ(現在値含む)を取得。ランキング(results)にあれば再利用。"""
    codes = fetch_watch_codes()
    if not codes:
        return []
    as_of = as_of_date(cfg)
    by = {r["code"]: r for r in results}
    out, seen = [], set()
    for code in codes:
        code = str(code).strip()
        if not code or code in seen:
            continue
        seen.add(code)
        if code in by:
            out.append(by[code])
            continue
        try:
            info = (jq.master(code=code, as_of=as_of) or {}).get(code) or {
                "code": code, "name": code, "market": "その他", "sector17": "-", "sector33": "-"}
            sts = [parse_statement(r) for r in jq.statements(code)]
            sts = [s for s in sts if s]
            out.append(build_scored(jq, cfg, info, sts))
        except Exception as e:
            print("watch err", code, e, file=sys.stderr)
    return out


# ----------------------------- 実行パイプライン -----------------------------
def as_of_date(cfg):
    d = datetime.datetime.now(JST) - datetime.timedelta(days=cfg["dataDelayDays"])
    return d.strftime("%Y-%m-%d")


def date_offset(cfg, days_before):
    d = datetime.datetime.now(JST) - datetime.timedelta(days=cfg["dataDelayDays"] + days_before)
    return d.strftime("%Y-%m-%d")


def build_scored(jq, cfg, info, sts):
    sc, fac, pts, turn, forecast = score_company(sts)
    as_of = as_of_date(cfg)
    price_from = date_offset(cfg, 1780)  # 月足5年表示用(Light保持5年以内に収める)
    try:
        bars = jq.daily_bars(info["code"], price_from, as_of)
    except Exception as e:
        print("price err", info["code"], e, file=sys.stderr)
        bars = []
    if not bars:  # 5年範囲が取得不可(保持期間/範囲制限)の場合は2年に縮めて再取得
        try:
            bars = jq.daily_bars(info["code"], date_offset(cfg, 730), as_of)
        except Exception as e:
            print("price retry err", info["code"], e, file=sys.stderr)
            bars = []
    daily = [{"d": b["date"], "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"]} for b in bars]
    ohlc = daily[-300:]            # 日足/週足表示用(直近約14か月)
    ohlcM = monthly_ohlc(daily)    # 月足表示用(5年・月次集計)
    price = bars[-1]["c"] if bars else None
    timing = timing_signal(bars)
    ir = ir_signal(sts)
    last_disc = max((s["disc"] for s in sts), default="-")
    return {
        "code": info["code"], "name": info["name"], "market": info["market"],
        "sector33": info["sector33"], "score": sc, "factors": fac,
        "quarterly": pts, "turnoverIndex": turn,
        "price": price, "target": (price * 2 if price else None),
        "minLot": (price * 100 if price else None),
        "forecastOP": forecast, "lastDisclosed": last_disc,
        "ohlc": ohlc,
        "ohlcM": ohlcM,
        "timing": timing,
        "ir": ir,
    }


def run_codelist(jq, cfg):
    as_of = as_of_date(cfg)
    out = []
    for code in cfg["codeList"]:
        code = str(code).strip()
        if not code:
            continue
        try:
            info = (jq.master(code=code, as_of=as_of) or {}).get(code) or {
                "code": code, "name": code, "market": "その他", "sector17": "-", "sector33": "-"}
            if cfg["market"] and info["market"] != cfg["market"]:
                continue
            kw = (cfg["themeKeyword"] or "").strip()
            if kw and not (kw in info["name"] or kw in info.get("sector17", "") or kw in info.get("sector33", "")):
                continue
            sts = [parse_statement(r) for r in jq.statements(code)]
            sts = [s for s in sts if s]
            if cfg["fiscalMonth"]:
                last = max(sts, key=lambda s: s["disc"], default=None)
                if last and month_of(last["fyEnd"]) != cfg["fiscalMonth"]:
                    continue
            out.append(build_scored(jq, cfg, info, sts))
        except Exception as e:
            print("codelist err", code, e, file=sys.stderr)
    return out


def run_recent(jq, cfg):
    as_of = as_of_date(cfg)
    codes, seen = [], set()
    start = datetime.datetime.now(JST) - datetime.timedelta(days=cfg["dataDelayDays"])
    lookback = cfg.get("lookbackDays") or 0
    if lookback < 1:
        lookback = 60
        print(f"lookbackDays<1 -> fallback to {lookback}", file=sys.stderr)
    for off in range(lookback):
        day = start - datetime.timedelta(days=off)
        if day.weekday() >= 5:
            continue
        try:
            for c in jq.disclosed_codes(day.strftime("%Y-%m-%d")):
                if c not in seen:
                    seen.add(c)
                    codes.append(c)
        except Exception as e:
            print("disc err", e, file=sys.stderr)
        if len(codes) >= cfg["maxCandidates"]:
            break
    out = []
    for code in codes[:cfg["maxCandidates"]]:
        try:
            info = (jq.master(code=code, as_of=as_of) or {}).get(code) or {
                "code": code, "name": code, "market": "その他", "sector17": "-", "sector33": "-"}
            if cfg["market"] and info["market"] != cfg["market"]:
                continue
            sts = [parse_statement(r) for r in jq.statements(code)]
            sts = [s for s in sts if s]
            sc, *_ = score_company(sts)
            if sc < cfg["minScore"]:
                continue
            out.append(build_scored(jq, cfg, info, sts))
        except Exception as e:
            print("recent err", code, e, file=sys.stderr)
    return out


def month_of(s):
    parts = (s or "").split("-")
    return int(parts[1]) if len(parts) >= 2 else None


def apply_filters_sort(cfg, lst):
    out = [s for s in lst if s["score"] >= cfg["minScore"]]
    if cfg["applyBudgetFilter"]:
        out = [s for s in out if (s["minLot"] is None or s["minLot"] <= cfg["budgetYen"])]
    out.sort(key=lambda s: s["score"], reverse=True)
    return out


# ----------------------------- 出力・メール -----------------------------
def write_outputs(cfg, results, ran_at, regime=None, watch=None):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    mode = cfg["scanMode"]
    summary_parts = [f"{len(results)}銘柄", f"スコア{int(cfg['minScore'])}+"]
    if cfg["market"]:
        summary_parts.append(f"市場:{cfg['market']}")
    if cfg["fiscalMonth"]:
        summary_parts.append(f"{cfg['fiscalMonth']}月決算")
    if (cfg["themeKeyword"] or "").strip():
        summary_parts.append(f"テーマ:{cfg['themeKeyword']}")
    if cfg["applyBudgetFilter"]:
        summary_parts.append(f"予算{int(cfg['budgetYen'])}円")
    record = {
        "date": ran_at.isoformat(),
        "mode": mode,
        "summary": " / ".join(summary_parts),
        "results": results,
        "regime": regime,
        "watch": watch or [],
    }
    (DATA_DIR / "latest.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    hist_path = DATA_DIR / "history.json"
    history = []
    if hist_path.exists():
        try:
            history = json.loads(hist_path.read_text(encoding="utf-8"))
        except Exception:
            history = []
    # 履歴は軽量化のため株価系列を省く
    light = dict(record)
    light.pop("watch", None)  # 履歴にはウォッチ枠を含めない
    light["results"] = [{k: v for k, v in r.items() if k not in ("prices", "ohlc", "ohlcM")} for r in results]
    history.insert(0, light)
    history = history[:30]
    hist_path.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")
    return record


def send_email(cfg, results, ran_at):
    ec = cfg.get("email", {})
    if not ec.get("enabled"):
        return
    pw = os.environ.get("MAIL_APP_PASSWORD", "").replace(" ", "")
    # メールアドレスは環境変数(Secrets)優先 → 無ければ config.json
    frm = os.environ.get("MAIL_FROM") or ec.get("from", "")
    to = os.environ.get("MAIL_TO") or ec.get("to", "")
    if not (pw and frm and to):
        print("メール設定が不足のため送信スキップ", file=sys.stderr)
        return
    subject = f"黒字転換2倍株 スクリーニング結果 {len(results)}件 - {ran_at.strftime('%Y/%m/%d %H:%M')}"
    lines = ["黒字転換2倍株 スクリーニング結果",
             f"実行: {ran_at.strftime('%Y年%m月%d日 %H:%M')} (JST)",
             f"方式: {cfg['scanMode']} / スコア{int(cfg['minScore'])}点以上",
             f"該当: {len(results)}銘柄", ""]
    if not results:
        lines.append("条件に該当する銘柄はありませんでした。")
    else:
        for i, s in enumerate(results[:30], 1):
            price = f"現在¥{int(s['price'])} → 目標¥{int(s['target'])}" if s.get("price") else "株価-"
            lines.append(f"{i}. [{int(s['score'])}点] {s['name']}({s['code']}) {s['market']}")
            lines.append(f"    {price}")
    lines += ["", "※ 黒字転換2倍株ファインダー(馬渕メソッド)による自動送信です。投資判断はご自身の責任で。"]
    msg = MIMEText("\n".join(lines), "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = frm
    msg["To"] = to
    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ctx) as smtp:
        smtp.login(frm, pw)
        smtp.sendmail(frm, [to], msg.as_string())
    print(f"メール送信: {to}")


def main():
    cfg = load_config()
    ran_at = datetime.datetime.now(JST)
    api_key = os.environ.get("JQUANTS_API_KEY", "")
    if not api_key:
        print("JQUANTS_API_KEY 未設定。デモ/空で出力します。", file=sys.stderr)
        write_outputs(cfg, [], ran_at)
        return
    jq = JQuants(api_key, cfg["requestsPerMinute"])
    raw = run_recent(jq, cfg) if cfg["scanMode"] == "recentDisclosures" else run_codelist(jq, cfg)
    results = apply_filters_sort(cfg, raw)
    try:
        regime = market_regime(jq, as_of_date(cfg), date_offset(cfg, 400))
    except Exception as e:
        print("regime err", e, file=sys.stderr)
        regime = None
    try:
        watch = build_watch(jq, cfg, results)
    except Exception as e:
        print("watch build err", e, file=sys.stderr)
        watch = []
    write_outputs(cfg, results, ran_at, regime, watch)
    try:
        send_email(cfg, results, ran_at)
    except Exception as e:
        print("メール送信失敗:", e, file=sys.stderr)
    print(f"完了: {len(results)}銘柄")


if __name__ == "__main__":
    main()
