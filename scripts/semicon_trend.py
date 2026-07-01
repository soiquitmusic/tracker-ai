#!/usr/bin/env python3
"""
半导体设备趋势 — 每日采集 + 评分
运行方式: python scripts/semicon_trend.py          # 真实数据采集
         python scripts/semicon_trend.py --sample   # 生成示例数据（开发预览用）
输出: docs/data/trend/latest.json + docs/data/trend/history.json
"""

import json, os, sys, time, html
from datetime import datetime, timezone, timedelta, date
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

TZ_BJ = timezone(timedelta(hours=8))
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "trend")

# ─── 全局缓存（避免重复请求）───
_quote_cache = {}
_hist_cache = {}
_pe_cache = {}

# ─── Yahoo Finance ───

def yf_quote(ticker):
    if ticker in _quote_cache:
        return _quote_cache[ticker]
    try:
        import yfinance as yf
        data = yf.download(ticker, period="5d", progress=False, auto_adjust=True)
        if len(data) >= 2:
            c2, c1 = float(data["Close"].iloc[-2]), float(data["Close"].iloc[-1])
            r = {"price": round(c1, 2), "change_pct": round((c1 - c2) / c2 * 100, 2), "change": round(c1 - c2, 2)}
            _quote_cache[ticker] = r
            return r
    except Exception:
        pass
    time.sleep(1.5)  # 速率限制避让
    # v8 API fallback
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d"
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        d = json.loads(urlopen(req, timeout=10).read())
        closes = [c for c in d["chart"]["result"][0]["indicators"]["quote"][0]["close"] if c is not None]
        if len(closes) >= 2:
            c2, c1 = float(closes[-2]), float(closes[-1])
            chg_pct = round((c1 - c2) / c2 * 100, 2)
            # 合理性检查: 单日涨跌幅超过20%则丢弃（可能数据错误）
            if abs(chg_pct) > 20:
                return None
            r = {"price": round(c1, 2), "change_pct": chg_pct, "change": round(c1 - c2, 2)}
            _quote_cache[ticker] = r
            return r
    except Exception:
        pass
    return None

def yf_historical(ticker, period="1y"):
    cache_key = f"{ticker}:{period}"
    if cache_key in _hist_cache:
        return _hist_cache[cache_key]
    try:
        import yfinance as yf
        data = yf.download(ticker, period=period, progress=False, auto_adjust=True)
        r = [float(v) for v in data["Close"].values if v is not None]
        _hist_cache[cache_key] = r
        return r
    except Exception:
        return []

def yf_pe(ticker):
    if ticker in _pe_cache:
        return _pe_cache[ticker]
    try:
        import yfinance as yf
        tk = yf.Ticker(ticker)
        info = tk.info
        r = info.get("trailingPE") or info.get("forwardPE")
        _pe_cache[ticker] = r
        return r
    except Exception:
        return None

# ─── 东方财富 ───

def em_fetch(url):
    try:
        d = json.loads(urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10).read())
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def em_safe(d, *keys):
    """安全链式取值"""
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d

def em_pct(v):
    """东方财富 f3 是实际值×100，转为百分比"""
    if v is None:
        return None
    return float(v) / 100

def get_a_share_data():
    result = {}
    r = em_fetch("https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f4,f12,f14&secids=1.000001,0.399001,0.399006,1.000688,100.HSI,100.HSTECH")
    em_map = {"1.000001": "上证指数", "0.399001": "深证成指", "0.399006": "创业板指",
               "1.000688": "科创50", "100.HSI": "恒生指数", "100.HSTECH": "恒生科技"}
    for item in (em_safe(r, "data", "diff") or []):
        name = em_map.get(item.get("f12", ""), item.get("f14", ""))
        if item.get("f2") is not None:
            result[name] = {"price": item.get("f2"), "chg_pct": em_pct(item.get("f3"))}
    r2 = em_fetch("https://push2.eastmoney.com/api/qt/kamt.kline/get?fields=f1,f2,f3,f4&klt=101")
    nv = em_safe(r2, "data", "s2n", "f1")
    sv = em_safe(r2, "data", "n2s", "f1")
    if nv is not None: result["北向资金"] = nv
    if sv is not None: result["南向资金"] = sv
    leaders = "0.300308,1.688256,1.688981,0.002371,1.688041,0.603501,0.603986,1.688012,0.002049,0.000977"
    ld_map = {"300308": "中际旭创", "688256": "寒武纪", "688981": "中芯国际", "002371": "北方华创",
               "688041": "海光信息", "603501": "韦尔股份", "603986": "兆易创新", "688012": "中微公司",
               "002049": "紫光国微", "000977": "浪潮信息"}
    r3 = em_fetch(f"https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f2,f3,f4,f12,f14&secids={leaders}")
    result["龙头"] = {}
    for item in (em_safe(r3, "data", "diff") or []):
        name = ld_map.get(item.get("f12", ""), item.get("f14", ""))
        if item.get("f2") is not None:
            result["龙头"][name] = {"price": item.get("f2"), "chg_pct": em_pct(item.get("f3"))}
    r4 = em_fetch("https://push2.eastmoney.com/api/qt/clist/get?fields=f2,f3,f4,f12,f14&pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fs=m:90+t3!bk:BK0988,BK0477,BK0478,BK0483")
    result["板块"] = []
    for item in (em_safe(r4, "data", "diff") or []):
        if item.get("f3") is not None:
            result["板块"].append({"name": item.get("f14"), "chg_pct": em_pct(item.get("f3"))})
    return result

# ─── RSS ───

FEEDS = [
    ("CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"),
    ("Reuters", "https://www.reutersagency.com/feed/"),
    ("Bloomberg", "https://feeds.bloomberg.com/markets/news.rss"),
    ("36氪", "https://36kr.com/feed"),
]

def fetch_news(keywords=None, max_items=30):
    results = []
    for label, url in FEEDS:
        try:
            tree = ET.fromstring(urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10).read())
            for item in (tree.findall(".//item") or tree.findall(".//entry")):
                t = item.find("title")
                if t is not None and t.text:
                    title = html.unescape(t.text.strip())
                    if len(title) <= 8:
                        continue
                    if keywords:
                        for kw in keywords:
                            if kw.lower() in title.lower():
                                results.append({"source": label, "title": title, "keyword": kw})
                                break
                    else:
                        results.append({"source": label, "title": title})
                    if len(results) >= max_items:
                        return results
        except Exception:
            continue
    return results

# ─── 评分引擎 ───

def clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))

def score_ai_demand():
    nvda = yf_quote("NVDA")
    nvda_score = 50 + (nvda["change_pct"] * 12 if nvda else 0)
    hs_tickers = ["MSFT", "AMZN", "META", "GOOGL"]
    hs_scores = []
    for t in hs_tickers:
        q = yf_quote(t)
        if q:
            hs_scores.append(50 + q["change_pct"] * 12)
    hs_avg = sum(hs_scores) / len(hs_scores) if hs_scores else 50
    news = fetch_news(["AI", "artificial intelligence", "NVIDIA", "GPU"], 8)
    news_score = min(len(news) * 10, 90)
    raw = nvda_score * 0.4 + hs_avg * 0.3 + news_score * 0.3
    return round(clamp(raw), 1), f"NVDA:{nvda_score:.0f} Hype:{hs_avg:.0f} News:{len(news)}"

def score_capex():
    fab_tickers = ["TSM", "INTC", "MU"]
    scores = []
    for t in fab_tickers:
        q = yf_quote(t)
        if q:
            scores.append(50 + q["change_pct"] * 10)
    stock_avg = sum(scores) / len(scores) if scores else 50
    news = fetch_news(["晶圆厂", "扩产", "fab", "产能", "foundry", "semiconductor", "chip plant"], 12)
    news_score = min(len(news) * 5 + 30, 90)
    if any("delay" in n["title"].lower() or "cut" in n["title"].lower() for n in news):
        news_score -= 10
    raw = stock_avg * 0.4 + news_score * 0.6
    return round(clamp(raw), 1), f"Stocks:{stock_avg:.0f} News:{news_score}({len(news)})"

def score_equipment_orders():
    a_data = get_a_share_data()
    leaders = a_data.get("龙头", {})
    chg_pcts = [v["chg_pct"] for v in leaders.values() if v.get("chg_pct") is not None]
    stock_avg = 50 + (sum(chg_pcts) / len(chg_pcts) * 10) if chg_pcts else 50
    news = fetch_news(["订单", "中标", "采购", "设备", "刻蚀", "薄膜", "CMP", "清洗", "检测"], 15)
    news_score = min(len(news) * 5 + 20, 100)
    sectors = a_data.get("板块", [])
    sector_boost = 0
    for s in sectors:
        if s.get("chg_pct") is not None and "半导体" in (s.get("name") or ""):
            sector_boost = float(s["chg_pct"]) * 2
    raw = stock_avg * 0.4 + news_score * 0.6 + sector_boost
    return round(clamp(raw), 1), f"Stocks:{stock_avg:.0f} News:{news_score}({len(news)}) Sector:{sector_boost:.0f}"

def score_profit_trend():
    tickers = ["NVDA", "TSM", "AMAT", "LRCX", "ASML"]
    scores = []
    for t in tickers:
        hist = yf_historical(t, "3mo")
        if len(hist) >= 20:
            ret = (hist[-1] / hist[0] - 1) * 100
            scores.append(clamp(50 + ret * 2, 0, 100))
    avg = sum(scores) / len(scores) if scores else 50
    return round(avg, 1), f"3M avg:{avg:.0f} ({len(scores)} stocks)"

def score_localization():
    news = fetch_news(["国产替代", "导入", "验证", "客户突破", "量产", "国产化", "自主可控"], 20)
    news_score = min(len(news) * 4 + 20, 100)
    a_data = get_a_share_data()
    leaders = a_data.get("龙头", {})
    chg_pcts = [v["chg_pct"] for v in leaders.values() if v.get("chg_pct") is not None]
    stock_avg = 50 + (sum(chg_pcts) / len(chg_pcts) * 10) if chg_pcts else 50
    raw = news_score * 0.6 + stock_avg * 0.4
    return round(clamp(raw), 1), f"News:{news_score}({len(news)}) Stocks:{stock_avg:.0f}"

def score_valuation():
    tickers = ["NVDA", "AMD", "AVGO", "MU", "TSM"]
    pe_list = []
    for t in tickers:
        pe = yf_pe(t)
        if pe and 0 < pe < 200:
            pe_list.append(pe)
    if not pe_list:
        return 50, "No PE data"
    avg_pe = sum(pe_list) / len(pe_list)
    if avg_pe < 20: s = 80
    elif avg_pe < 30: s = 70
    elif avg_pe < 40: s = 60
    elif avg_pe < 60: s = 40
    else: s = 25
    return s, f"Avg PE:{avg_pe:.1f} ({len(pe_list)} stocks)"

def score_capital_flow():
    a_data = get_a_share_data()
    north = a_data.get("北向资金", "--")
    if north != "--" and isinstance(north, (int, float)):
        n = float(north)
        s = 80 if n > 50 else 65 if n > 20 else 50 if n > 0 else 35 if n > -20 else 20
    else:
        s = 50
    return s, f"北向:{north}亿" if isinstance(north, (int, float)) else "暂无数据"

def score_earnings_reaction():
    tickers = ["NVDA", "AMD", "AVGO", "MU", "TSM"]
    pos = total = 0
    for t in tickers:
        q = yf_quote(t)
        if q:
            total += 1
            if q["change_pct"] > 0:
                pos += 1
    if total == 0:
        return 50, "No data"
    ratio = pos / total
    s = ratio * 80 + 10
    return round(clamp(s), 1), f"Up:{pos}/{total} ({ratio:.0%})"

def score_technical():
    tickers = ["^SOX", "NVDA"]
    scores = []
    for t in tickers:
        hist = yf_historical(t, "1y")
        if len(hist) < 120:
            continue
        cur = hist[-1]
        ma20 = sum(hist[-20:]) / 20
        ma60 = sum(hist[-60:]) / 60
        ma120 = sum(hist[-120:]) / 120
        s = 50
        if cur > ma20: s += 10
        if cur > ma60: s += 10
        if cur > ma120: s += 10
        if cur >= max(hist[-60:]) * 0.98: s += 10
        if cur <= min(hist[-60:]) * 1.02: s -= 20
        scores.append(clamp(s, 0, 100))
    avg = sum(scores) / len(scores) if scores else 50
    return round(avg, 1), f"MA:{avg:.0f} ({len(scores)} tickers)"

def score_sentiment():
    a_data = get_a_share_data()
    leaders = a_data.get("龙头", {})
    up = sum(1 for v in leaders.values() if v.get("chg_pct") is not None and v["chg_pct"] > 0)
    down = sum(1 for v in leaders.values() if v.get("chg_pct") is not None and v["chg_pct"] < 0)
    ratio = up / (up + down) if (up + down) > 0 else 0.5
    leader_score = ratio * 80 + 10
    sectors = a_data.get("板块", [])
    pos_s = sum(1 for s in sectors if s.get("chg_pct") is not None and s["chg_pct"] > 0)
    sector_ratio = pos_s / len(sectors) if sectors else 0.5
    sector_score = sector_ratio * 80 + 10
    news = fetch_news(["半导体", "AI", "芯片", "市场"], 8)
    news_score = min(len(news) * 8 + 20, 90)
    raw = leader_score * 0.4 + sector_score * 0.3 + news_score * 0.3
    return round(clamp(raw), 1), f"Leaders:{ratio:.0%} Sector:{sector_ratio:.0%} News:{len(news)}"

# ─── 聚合 ───

SCORERS = [
    ("ai_demand", score_ai_demand, "A", "AI需求", 25),
    ("semiconductor_capex", score_capex, "A", "资本开支", 20),
    ("equipment_orders", score_equipment_orders, "A", "设备订单", 20),
    ("profit_trend", score_profit_trend, "A", "盈利趋势", 15),
    ("localization", score_localization, "A", "国产替代", 20),
    ("valuation", score_valuation, "B", "估值水平", 20),
    ("capital_flow", score_capital_flow, "B", "资金流向", 20),
    ("earnings_reaction", score_earnings_reaction, "B", "财报反应", 20),
    ("technical_trend", score_technical, "B", "技术趋势", 20),
    ("market_sentiment", score_sentiment, "B", "市场情绪", 20),
]

def signal(v):
    if v >= 60: return "positive"
    if v <= 40: return "negative"
    return "neutral"

def label_industry(v):
    if v >= 75: return "过热"
    if v >= 55: return "扩张"
    if v >= 35: return "筑底"
    return "收缩"

def label_market(v):
    if v >= 70: return "Early"
    if v >= 55: return "Middle"
    if v >= 40: return "Late"
    return "Top"

def run_pipeline():
    today = date.today()
    print(f"[{today}] Starting daily collection...")

    results = []
    module_a_total = module_b_total = 0
    module_a_weight = module_b_weight = 0

    for key, scorer_fn, module, name_cn, weight in SCORERS:
        try:
            score, details = scorer_fn()
        except Exception as e:
            print(f"  !! {key} failed: {e}")
            score, details = 50, f"Error: {e}"
        sig = signal(score)
        results.append({
            "key": key, "name": name_cn, "module": module,
            "score": score, "signal": sig, "detail": details,
        })
        ok = "+" if sig != "negative" else "-"
        print(f"  [{ok}] {name_cn}: {score} ({sig}) - {details}")
        if module == "A":
            module_a_total += score * weight
            module_a_weight += weight
        else:
            module_b_total += score * weight
            module_b_weight += weight

    module_a = round(module_a_total / module_a_weight, 1) if module_a_weight else 50
    module_b = round(module_b_total / module_b_weight, 1) if module_b_weight else 50
    composite = round(module_a * 0.7 + module_b * 0.3, 1)
    a_label = label_industry(module_a)
    b_label = label_market(module_b)

    output = {
        "date": today.isoformat(),
        "generated_at": datetime.now(TZ_BJ).strftime("%Y-%m-%d %H:%M:%S"),
        "compositeScore": composite,
        "compositeLabel": f"A:{a_label} B:{b_label}",
        "moduleA": {"score": module_a, "label": a_label, "subIndicators": [r for r in results if r["module"] == "A"]},
        "moduleB": {"score": module_b, "label": b_label, "subIndicators": [r for r in results if r["module"] == "B"]},
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n[OK] latest.json saved")

    history_path = os.path.join(DATA_DIR, "history.json")
    history = []
    if os.path.exists(history_path):
        try:
            with open(history_path, "r", encoding="utf-8") as f:
                history = json.load(f)
        except Exception:
            history = []

    if not history or history[-1].get("date") != today.isoformat():
        history.append({
            "date": today.isoformat(),
            "compositeScore": composite,
            "moduleAScore": module_a,
            "moduleBScore": module_b,
            "moduleALabel": a_label,
            "moduleBLabel": b_label,
        })
        history = history[-365:]

    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)
    print(f"[OK] history.json updated ({len(history)} entries)")

    print(f"\n=== TODAY'S SCORES ===")
    print(f"Composite: {composite}")
    print(f"Industry A: {module_a} - {a_label}")
    print(f"Market B: {module_b} - {b_label}")
    return output

if __name__ == "__main__":
    SAMPLE_MODE = "--sample" in sys.argv
    if SAMPLE_MODE:
        # 生成示例数据（不调用外部 API）
        import json, os
        today = date.today().isoformat()
        now = datetime.now(TZ_BJ).strftime("%Y-%m-%d %H:%M:%S")
        output = {
            "date": today,
            "generated_at": now,
            "compositeScore": 71.5,
            "compositeLabel": "A:扩张 B:Middle",
            "moduleA": {
                "score": 72.3, "label": "扩张",
                "subIndicators": [
                    {"key": "ai_demand", "name": "AI需求", "module": "A", "score": 92.0, "signal": "positive", "detail": "NVDA:+2.3% Hype:+1.8% News:12"},
                    {"key": "semiconductor_capex", "name": "资本开支", "module": "A", "score": 85.0, "signal": "positive", "detail": "TSMC:+1.2% Intel:-0.8% MU:+2.5%"},
                    {"key": "equipment_orders", "name": "设备订单", "module": "A", "score": 78.5, "signal": "positive", "detail": "北方华创:+3.2% 中微:+1.5% 订单新闻:8条"},
                    {"key": "profit_trend", "name": "盈利趋势", "module": "A", "score": 68.0, "signal": "positive", "detail": "3M平均:+4.2% EPS上修趋势"},
                    {"key": "localization", "name": "国产替代", "module": "A", "score": 44.0, "signal": "neutral", "detail": "导入验证新闻:4条"},
                ]
            },
            "moduleB": {
                "score": 69.7, "label": "Middle",
                "subIndicators": [
                    {"key": "valuation", "name": "估值水平", "module": "B", "score": 65.0, "signal": "positive", "detail": "NVDA PE:42 AMD PE:28 TSM PE:25"},
                    {"key": "capital_flow", "name": "资金流向", "module": "B", "score": 78.0, "signal": "positive", "detail": "北向资金:+85亿"},
                    {"key": "earnings_reaction", "name": "财报反应", "module": "B", "score": 82.0, "signal": "positive", "detail": "Up:4/5 (80%)"},
                    {"key": "technical_trend", "name": "技术趋势", "module": "B", "score": 72.0, "signal": "positive", "detail": "SOX站上MA20/MA60"},
                    {"key": "market_sentiment", "name": "市场情绪", "module": "B", "score": 51.0, "signal": "neutral", "detail": "龙头:60%上涨 板块:2/4上涨"},
                ]
            }
        }
        history = [
            {"date": (date.today() - timedelta(days=i)).isoformat(),
             "compositeScore": round(60 + 10 * (i / 30) + 5 * ((i % 7) - 3) / 3, 1),
             "moduleAScore": round(58 + 12 * (i / 30) + 4 * ((i % 5) - 2), 1),
             "moduleBScore": round(55 + 8 * (i / 30) + 6 * ((i % 4) - 1.5), 1),
             "moduleALabel": "扩张" if i < 25 else "筑底",
             "moduleBLabel": "Middle" if i < 20 else "Late",
            }
            for i in range(29, -1, -1)
        ]
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(os.path.join(DATA_DIR, "latest.json"), "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        with open(os.path.join(DATA_DIR, "history.json"), "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
        print(f"[OK] Sample data generated: {today}")
        print(f"  Composite: {output['compositeScore']}")
        print(f"  Industry A: {output['moduleA']['score']} - {output['moduleA']['label']}")
        print(f"  Market B: {output['moduleB']['score']} - {output['moduleB']['label']}")
        print(f"  History: {len(history)} days")
        sys.exit(0)

    run_pipeline()
