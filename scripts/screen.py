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

    def daily_closes(self, code, frm, to):
        rows = self._get_all("/v2/equities/bars/daily",
                             {"code": code, "from": frm, "to": to})
        out = []
        for r in rows:
            d = r.get("Date")
            c = to_f(r.get("AdjC")) or to_f(r.get("C"))
            if d and c is not None:
                out.append({"date": d, "close": c})
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
    price_from = date_offset(cfg, 620)
    try:
        prices = jq.daily_closes(info["code"], price_from, as_of)
    except Exception as e:
        print("price err", info["code"], e, file=sys.stderr)
        prices = []
    price = prices[-1]["close"] if prices else None
    last_disc = max((s["disc"] for s in sts), default="-")
    return {
        "code": info["code"], "name": info["name"], "market": info["market"],
        "sector33": info["sector33"], "score": sc, "factors": fac,
        "quarterly": pts, "turnoverIndex": turn,
        "price": price, "target": (price * 2 if price else None),
        "minLot": (price * 100 if price else None),
        "forecastOP": forecast, "lastDisclosed": last_disc,
        "prices": prices,
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
    for off in range(cfg["lookbackDays"]):
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
def write_outputs(cfg, results, ran_at):
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
    light["results"] = [{k: v for k, v in r.items() if k != "prices"} for r in results]
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
    write_outputs(cfg, results, ran_at)
    try:
        send_email(cfg, results, ran_at)
    except Exception as e:
        print("メール送信失敗:", e, file=sys.stderr)
    print(f"完了: {len(results)}銘柄")


if __name__ == "__main__":
    main()
