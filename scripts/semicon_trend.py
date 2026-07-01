#!/usr/bin/env python3
"""
半导体设备趋势 — 每日采集 + 评分（重构版）
===========================================
设计原则：
  - 产业评分 (Module A) = 仅使用基本面指标（新闻/订单/CapEx），禁止使用股价
  - 市场评分 (Module B) = 仅使用市场数据（估值/动量/技术），禁止使用产业新闻
运行方式: python scripts/semicon_trend.py
输出: docs/data/trend/latest.json + docs/data/trend/history.json
"""

import json, os, sys, time, html, re
from datetime import datetime, timezone, timedelta, date
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

TZ_BJ = timezone(timedelta(hours=8))
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "trend")

# ─── 全局缓存 ───
_quote_cache = {}
_hist_cache = {}
_pe_cache = {}

# ====== 数据采集工具（保持不变） ======

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
    except: pass
    time.sleep(1.5)
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d"
        d = json.loads(urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10).read())
        closes = [c for c in d["chart"]["result"][0]["indicators"]["quote"][0]["close"] if c is not None]
        if len(closes) >= 2:
            c2, c1 = float(closes[-2]), float(closes[-1])
            chg_pct = round((c1 - c2) / c2 * 100, 2)
            if abs(chg_pct) > 20: return None
            r = {"price": round(c1, 2), "change_pct": chg_pct, "change": round(c1 - c2, 2)}
            _quote_cache[ticker] = r
            return r
    except: pass
    return None

def yf_historical(ticker, period="1y"):
    ck = f"{ticker}:{period}"
    if ck in _hist_cache: return _hist_cache[ck]
    try:
        import yfinance as yf
        data = yf.download(ticker, period=period, progress=False, auto_adjust=True)
        r = [float(v) for v in data["Close"].values if v is not None]
        _hist_cache[ck] = r
        return r
    except: return []

def yf_pe(ticker):
    if ticker in _pe_cache: return _pe_cache[ticker]
    try:
        import yfinance as yf
        tk = yf.Ticker(ticker)
        info = tk.info
        r = info.get("trailingPE") or info.get("forwardPE")
        _pe_cache[ticker] = r
        return r
    except: return None

def em_fetch(url):
    try:
        d = json.loads(urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10).read())
        return d if isinstance(d, dict) else {}
    except: return {}

def em_safe(d, *keys):
    for k in keys:
        if not isinstance(d, dict): return None
        d = d.get(k)
    return d

def em_pct(v):
    return float(v) / 100 if v is not None else None

FEEDS = [
    ("CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"),
    ("Reuters", "https://www.reutersagency.com/feed/"),
    ("Bloomberg", "https://feeds.bloomberg.com/markets/news.rss"),
    ("FT", "https://www.ft.com/rss/markets"),
    ("WSJ", "https://feeds.a.dj.com/rss/RSSMarketsMain.xml"),
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
                    if len(title) <= 8: continue
                    if keywords:
                        for kw in keywords:
                            if kw.lower() in title.lower():
                                results.append({"source": label, "title": title})
                                break
                    else:
                        results.append({"source": label, "title": title})
                    if len(results) >= max_items: return results
        except: continue
    return results

def clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))

# ====== 新闻情感分析工具（Module A 专用） ======

POSITIVE_WORDS = [
    "expand", "expansion", "grow", "growth", "surge", "boost", "increase", "rise",
    "strong", "record", "新高", "增长", "扩张", "加速", "突破", "放量", "提升",
    "invest", "investment", "commit", "commitment", "plan", "announce",
    "approve", "approval", "launch", "introduce", "unveil", "partner",
    "win", "winning", "award", "order", "contract", "demand",
    "optimistic", "positive", "outlook", "upgrade", "bullish",
]

NEGATIVE_WORDS = [
    "cut", "cutting", "reduce", "reduction", "decline", "fall", "drop", "decrease",
    "delay", "delayed", "cancel", "cancellation", "slow", "slowdown", "weak",
    "下滑", "下降", "减少", "延迟", "取消", "放缓", "萎缩", "疲软",
    "risk", "risk", "uncertainty", "shortage", "shortfall", "miss",
    "downgrade", "bearish", "concern", "warning", "loss", "negative",
    "struggle", "struggling", "challenge", "difficult",
]

def analyze_sentiment(title):
    """对新闻标题做简单情感分析，返回 +1(正面) / 0(中性) / -1(负面)"""
    t = title.lower()
    pos = sum(1 for w in POSITIVE_WORDS if w in t)
    neg = sum(1 for w in NEGATIVE_WORDS if w in t)
    if pos > neg: return 1
    if neg > pos: return -1
    return 0

def news_score_by_sentiment(keywords, max_items=20, pos_weight=1.0, neg_weight=1.0):
    """
    基于新闻情感计算产业评分
    返回 (score, count, positive_count, negative_count, details)
    """
    news = fetch_news(keywords, max_items)
    if not news:
        return 50, 0, 0, 0, "无相关新闻"

    pos = neg = 0
    for n in news:
        s = analyze_sentiment(n["title"])
        if s > 0: pos += 1
        elif s < 0: neg += 1

    total = len(news)
    # 情感比例映射到 0-100
    if pos + neg > 0:
        ratio = (pos * pos_weight - neg * neg_weight) / (pos * pos_weight + neg * neg_weight)
        score = 50 + ratio * 40  # -1..+1 → 10..90
    else:
        score = 50  # 全部中性

    # 新闻数量加成：超过3条有增量信心
    volume_bonus = min(total * 1.5, 10) if pos >= neg else 0

    score = clamp(score + volume_bonus)
    return round(score, 1), total, pos, neg, f"总{total}条 正{pos} 负{neg}"

# ====== Module A: 产业评分（仅基本面，禁止股价） ======

def score_ai_demand():
    """
    AI需求评分
    数据源: AI基础设施/CapEx/大模型发布/企业AI应用新闻
    """
    # 1. Cloud CapEx / AI基础设施新闻
    capex_news = fetch_news([
        "CapEx", "capital expenditure", "AI infrastructure", "cloud investment",
        "AI server", "data center", "GPU cluster", "AI spending"
    ], 12)
    capex_pos = sum(1 for n in capex_news if analyze_sentiment(n["title"]) > 0)
    capex_neg = sum(1 for n in capex_news if analyze_sentiment(n["title"]) < 0)

    # 2. 大模型/AI进展新闻
    model_news = fetch_news([
        "OpenAI", "GPT", "Claude", "Gemini", "Qwen", "DeepSeek",
        "foundation model", "LLM", "AI model", "reasoning"
    ], 10)
    model_pos = sum(1 for n in model_news if analyze_sentiment(n["title"]) > 0)
    model_neg = sum(1 for n in model_news if analyze_sentiment(n["title"]) < 0)

    # 3. Enterprise AI adoption
    enterprise_news = fetch_news([
        "AI adoption", "enterprise AI", "AI agent", "Copilot",
        "AI integration", "AI deployment", "AI transform"
    ], 8)

    total = len(capex_news) + len(model_news) + len(enterprise_news)
    total_pos = capex_pos + model_pos
    total_neg = capex_neg + model_neg

    if total_pos + total_neg > 0:
        ratio = (total_pos - total_neg) / (total_pos + total_neg)
        score = 50 + ratio * 40
    else:
        score = 50

    volume_bonus = min(total * 1.2, 8) if total_pos >= total_neg else 0
    score = clamp(score + volume_bonus)
    return round(score, 1), f"CapEx新闻:{len(capex_news)} 模型新闻:{len(model_news)} 企业AI:{len(enterprise_news)} 正{total_pos}负{total_neg}"

def score_capex():
    """
    资本开支评分（纯新闻）
    数据源: 晶圆厂/CapEx/新工厂/扩产新闻
    """
    s, total, pos, neg, detail = news_score_by_sentiment([
        "fab", "fab expansion", "new fab", "chip plant", "semiconductor plant",
        "wafer fab", "capacity expansion", "capacity addition",
        "CapEx", "investment", "construction",
        "晶圆厂", "扩产", "产能", "投资建厂",
        "foundry", "TSMC", "Samsung", "Intel", "Micron",
    ], 20, pos_weight=1.2, neg_weight=1.5)

    # CapEx reduction/cut is especially negative
    neg_news = fetch_news(["CapEx cut", "CapEx reduction", "delay", "推迟", "缩减投资"], 5)
    if neg_news:
        s = max(s - 10, 0)

    return s, f"{detail}"

def score_equipment_orders():
    """
    设备订单评分（纯新闻）
    数据源: 设备订单/中标/采购/验收/客户导入
    """
    s, total, pos, neg, detail = news_score_by_sentiment([
        "order", "订单", "中标",
        "equipment order", "semiconductor equipment",
        "purchase order", "procurement",
        "customer qualification", "qualified supplier",
        "production line", "mass production",
        "new customer", "customer approval",
        "刻蚀", "薄膜", "CMP", "清洗", "检测",
        "shipment", "delivery", "installation",
    ], 20, pos_weight=1.0, neg_weight=1.3)
    return s, detail

def score_profit_trend():
    """
    盈利趋势评分
    数据源: EPS指引/营收指引/季度财报新闻
    """
    s, total, pos, neg, detail = news_score_by_sentiment([
        "earnings", "EPS", "revenue", "profit",
        "财报", "营收", "净利润", "毛利率",
        "guidance", "outlook", "forecast",
        "beat", "exceed", "surprise",
        "upgrade", "positive outlook",
        "margin", "gross margin", "operating margin",
    ], 15, pos_weight=1.2, neg_weight=1.5)

    # 特别处理 downgrade/miss
    neg_news = fetch_news(["downgrade", "earnings miss", "profit warning", "revenue miss"], 5)
    if neg_news:
        s = max(s - 12, 0)

    return s, f"{detail}"

def score_localization():
    """
    国产替代评分（纯新闻）
    数据源: 国产替代/验证/量产/客户导入
    """
    s, total, pos, neg, detail = news_score_by_sentiment([
        "国产替代", "国产化", "自主可控",
        "导入", "验证", "客户突破", "客户导入",
        "量产", "批量生产", "规模化",
        "替代", "取代", "本土化",
        "domestic", "localization", "local supply",
        "supply chain", "self-sufficient",
    ], 20, pos_weight=1.0, neg_weight=1.2)
    return s, detail

# ====== Module B: 市场评分（仅市场数据） ======

def score_valuation():
    """估值评分 — 基于PE"""
    tickers = ["NVDA", "AMD", "AVGO", "MU", "TSM", "AMAT", "LRCX"]
    pe_list = []
    for t in tickers:
        pe = yf_pe(t)
        if pe and 0 < pe < 200:
            pe_list.append(pe)
    if not pe_list:
        return 50, "暂无PE数据"
    avg_pe = sum(pe_list) / len(pe_list)
    if avg_pe < 20: s = 85
    elif avg_pe < 30: s = 70
    elif avg_pe < 40: s = 55
    elif avg_pe < 60: s = 35
    else: s = 20
    return s, f"平均PE:{avg_pe:.1f}({len(pe_list)}只)"

def score_capital_flow():
    """资金流向 — 基于北向资金"""
    a_data = get_a_share_data()
    north = a_data.get("北向资金", "--")
    if north != "--" and isinstance(north, (int, float)):
        n = float(north)
        s = 80 if n > 50 else 65 if n > 20 else 50 if n > 0 else 35 if n > -20 else 20
    else:
        s = 50
    return s, f"北向:{north}亿" if isinstance(north, (int, float)) else "暂无数据"

def score_earnings_reaction():
    """
    财报反应评分（增强版）
    核心信号: "好财报却下跌" = 最负面
    """
    tickers = ["NVDA", "AMD", "AVGO", "MU", "TSM"]
    # 检测近期财报新闻
    earnings_news = fetch_news(["earnings", "财报", "results", "quarterly", "营收"], 10)

    # 检测股价反应
    pos_price = 0
    neg_price = 0
    for t in tickers:
        q = yf_quote(t)
        if q:
            if q["change_pct"] > 0:
                pos_price += 1
            else:
                neg_price += 1

    # 检测"好财报却下跌"信号
    beat_but_fall = 0
    for n in earnings_news:
        t = n["title"].lower()
        is_positive = analyze_sentiment(n["title"]) > 0
        is_negative_price = any(q and q["change_pct"] < -1 for ticker in tickers
                                 if (q := yf_quote(ticker)))
        if is_positive and is_negative_price:
            beat_but_fall += 1

    # 基础分来自涨跌比
    total = pos_price + neg_price
    if total == 0:
        return 50, "暂无数据"
    ratio = pos_price / total
    base = ratio * 80 + 10

    # 好财报却下跌：每出现一次减12分
    penalty = min(beat_but_fall * 12, 30)
    score = clamp(base - penalty)

    return round(score, 1), f"涨:{pos_price}/{total} 好财报下跌:{beat_but_fall}次 罚分:{penalty}"

def score_technical():
    """
    技术趋势评分（增强版）
    追踪更多指数: SOX + NVDA + 半导体ETF + A股半导体
    """
    # 美股技术面
    us_tickers = ["^SOX", "NVDA", "SMH"]
    scores = []
    for t in us_tickers:
        hist = yf_historical(t, "1y")
        if len(hist) < 120: continue
        cur = hist[-1]
        ma20 = sum(hist[-20:]) / 20
        ma60 = sum(hist[-60:]) / 60
        ma120 = sum(hist[-120:]) / 120
        s = 50
        if cur > ma20: s += 12
        if cur > ma60: s += 12
        if cur > ma120: s += 12
        if cur >= max(hist[-60:]) * 0.97: s += 10
        if cur <= min(hist[-60:]) * 1.03: s -= 20
        scores.append(clamp(s, 0, 100))

    # A股半导体技术面（用龙头股做代理）
    a_data = get_a_share_data()
    leaders = a_data.get("龙头", {})
    if leaders:
        up = sum(1 for v in leaders.values() if v.get("chg_pct") is not None and v["chg_pct"] > 0)
        down = sum(1 for v in leaders.values() if v.get("chg_pct") is not None and v["chg_pct"] < 0)
        a_score = 50 + ((up - down) / (up + down) * 20) if (up + down) > 0 else 50
        scores.append(clamp(a_score, 0, 100))

    avg = sum(scores) / len(scores) if scores else 50
    return round(avg, 1), f"SOX/NVDA均值:{avg:.0f}({len(scores)}个指数)"

def score_sentiment():
    """市场情绪评分"""
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

    # 只用成交额/行情相关的新闻，不用产业新闻
    news = fetch_news(["market rally", "sell-off", "volatility", "bull market", "bear market",
                        "反弹", "回调", "震荡", "放量"], 8)
    news_score = min(len(news) * 8 + 20, 90)

    raw = leader_score * 0.4 + sector_score * 0.3 + news_score * 0.3
    return round(clamp(raw), 1), f"龙头涨跌比:{ratio:.0%} 板块:{sector_ratio:.0%} 行情新闻:{len(news)}"

# ====== 东方财富数据（仅 Market B 使用） ======

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

# ====== 评分注册 ======

SCORERS = [
    # Module A — 产业评分（纯基本面/新闻）
    ("ai_demand", score_ai_demand, "A", "AI需求", 25),
    ("semiconductor_capex", score_capex, "A", "资本开支", 20),
    ("equipment_orders", score_equipment_orders, "A", "设备订单", 20),
    ("profit_trend", score_profit_trend, "A", "盈利趋势", 15),
    ("localization", score_localization, "A", "国产替代", 20),
    # Module B — 市场评分（纯市场数据）
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

# ====== 新的阶段标签 ======

def label_industry(v):
    """产业周期阶段（避免使用市场情绪术语）"""
    if v >= 80: return "Expansion"    # 扩张
    if v >= 60: return "Growth"        # 增长
    if v >= 40: return "Validation"    # 验证
    if v >= 20: return "Early"         # 早期
    return "Downturn"                   # 下行

def label_market(v):
    """股市周期阶段（不变）"""
    if v >= 70: return "Early"
    if v >= 55: return "Middle"
    if v >= 40: return "Late"
    return "Top"

# ====== 主管线 ======

def run_pipeline():
    today = date.today()
    print(f"[{today}] 开始采集（重构版: 产业纯基本面+市场纯行情）...")

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
        print(f"  [{ok}] {name_cn}: {score} ({sig}) — {details}")
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
            with open(history_path, "r") as f:
                history = json.load(f)
        except: history = []

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

    print(f"\n=== 今日评分 ===")
    print(f"综合: {composite} | 产业 A: {module_a} - {a_label} | 市场 B: {module_b} - {b_label}")
    print(f"---")
    print(f"产业评分基于: 新闻情感分析 (不含任何股价数据)")
    print(f"市场评分基于: PE/北向资金/技术指标/涨跌比/情绪 (不含产业新闻)")
    return output

if __name__ == "__main__":
    run_pipeline()
