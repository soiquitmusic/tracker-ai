#!/usr/bin/env python3
"""
AI产业链趋势 — 每日采集 + 评分
16个模块，每个计算 Industry Score(70%) + Market Score(30%) + Rotation Score
运行方式: python scripts/ai_chain.py
输出: docs/data/ai_chain/latest.json + history.json
"""

import json, os, sys, time, html
from datetime import datetime, timezone, timedelta, date
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

TZ_BJ = timezone(timedelta(hours=8))
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "ai_chain")

# 复用 semicon_trend 的数据采集函数
_quote_cache = {}
_hist_cache = {}
_pe_cache = {}

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
    time.sleep(1.5)
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5d"
        d = json.loads(urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10).read())
        closes = [c for c in d["chart"]["result"][0]["indicators"]["quote"][0]["close"] if c is not None]
        if len(closes) >= 2:
            c2, c1 = float(closes[-2]), float(closes[-1])
            chg_pct = round((c1 - c2) / c2 * 100, 2)
            if abs(chg_pct) > 20:
                return None
            r = {"price": round(c1, 2), "change_pct": chg_pct, "change": round(c1 - c2, 2)}
            _quote_cache[ticker] = r
            return r
    except Exception:
        pass
    return None

def yf_historical(ticker, period="1y"):
    ck = f"{ticker}:{period}"
    if ck in _hist_cache:
        return _hist_cache[ck]
    try:
        import yfinance as yf
        data = yf.download(ticker, period=period, progress=False, auto_adjust=True)
        r = [float(v) for v in data["Close"].values if v is not None]
        _hist_cache[ck] = r
        return r
    except:
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
    except:
        return None

def em_fetch(url):
    try:
        d = json.loads(urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10).read())
        return d if isinstance(d, dict) else {}
    except:
        return {}

def em_safe(d, *keys):
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d

def em_pct(v):
    if v is None:
        return None
    return float(v) / 100

# RSS
FEEDS = [
    ("CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"),
    ("Reuters", "https://www.reutersagency.com/feed/"),
    ("Bloomberg", "https://feeds.bloomberg.com/markets/news.rss"),
    ("FT", "https://www.ft.com/rss/markets"),
    ("36氪", "https://36kr.com/feed"),
]

def fetch_news(keywords=None, max_items=20):
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
                                results.append({"source": label, "title": title})
                                break
                    else:
                        results.append({"source": label, "title": title})
                    if len(results) >= max_items:
                        return results
        except:
            continue
    return results

def clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))

# ====== 评分工具 ======

def stock_momentum(tickers, mult=10):
    """基于多个股票日涨跌幅的得分"""
    scores = []
    for t in tickers:
        q = yf_quote(t)
        if q:
            scores.append(50 + q["change_pct"] * mult)
    return sum(scores) / len(scores) if scores else 50

def stock_3m_momentum(tickers, mult=2):
    scores = []
    for t in tickers:
        hist = yf_historical(t, "3mo")
        if len(hist) >= 20:
            ret = (hist[-1] / hist[0] - 1) * 100
            scores.append(clamp(50 + ret * mult, 0, 100))
    return sum(scores) / len(scores) if scores else 50

def tech_score(tickers):
    """基于MA位置的技术评分"""
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
    return sum(scores) / len(scores) if scores else 50

def valuation_score(tickers):
    pe_list = []
    for t in tickers:
        pe = yf_pe(t)
        if pe and 0 < pe < 200:
            pe_list.append(pe)
    if not pe_list:
        return 50
    avg_pe = sum(pe_list) / len(pe_list)
    if avg_pe < 20: return 80
    if avg_pe < 30: return 70
    if avg_pe < 40: return 60
    if avg_pe < 60: return 40
    return 25

def news_score(keywords, max_n=20, mult=5, base=20):
    news = fetch_news(keywords, max_n)
    return min(len(news) * mult + base, 95), len(news)

def market_common(tickers, tech_tickers=None):
    """Module B 通用市场评分"""
    v = valuation_score(tickers)
    m = stock_momentum(tickers, 8)
    t = tech_score(tech_tickers or tickers)
    s = (v + m + t) / 3
    return clamp(s, 0, 100)

# ====== 16个模块评分 ======

MODULES = []

def module(key, name, industry_fn, market_fn, tickers, news_kw, parent=""):
    MODULES.append((key, name, industry_fn, market_fn, tickers, news_kw, parent))

# ---- Upstream ----

def ind_ai_demand():
    nvda = yf_quote("NVDA")
    nvda_s = 50 + (nvda["change_pct"] * 12 if nvda else 0)
    hs = ["MSFT", "AMZN", "META", "GOOGL"]
    hs_s = stock_momentum(hs, 12)
    ns, n = news_score(["AI", "artificial intelligence", "GPT", "大模型", "LLM"], 10, 8, 20)
    return clamp(nvda_s * 0.4 + hs_s * 0.3 + ns * 0.3), f"NVDA:{nvda_s:.0f} Hyp:{hs_s:.0f} News:{n}"

def mkt_ai_demand():
    return market_common(["NVDA", "MSFT", "AMZN", "META", "GOOGL", "CRM"])

module("ai_demand", "AI 需求", ind_ai_demand, mkt_ai_demand,
       ["NVDA", "MSFT", "AMZN"], ["AI", "artificial intelligence", "GPT"])

def ind_gpu():
    nvda = yf_quote("NVDA")
    amd = yf_quote("AMD")
    nvda_s = 50 + (nvda["change_pct"] * 12 if nvda else 50)
    amd_s = 50 + (amd["change_pct"] * 10 if amd else 50)
    ns, n = news_score(["GPU", "NVIDIA", "H100", "B200", "shipment"], 8, 8, 20)
    return clamp(nvda_s * 0.5 + amd_s * 0.2 + ns * 0.3), f"NVDA:{nvda_s:.0f} AMD:{amd_s:.0f} News:{n}"

def mkt_gpu():
    return market_common(["NVDA", "AMD"], ["NVDA", "AMD"])

module("gpu", "GPU", ind_gpu, mkt_gpu, ["NVDA", "AMD"], ["GPU", "NVIDIA"])

def ind_asic():
    brcm = yf_quote("AVGO")
    mrvl = yf_quote("MRVL")
    brcm_s = 50 + (brcm["change_pct"] * 10 if brcm else 50)
    mrvl_s = 50 + (mrvl["change_pct"] * 10 if mrvl else 50)
    ns, n = news_score(["ASIC", "TPU", "Trainium", "custom chip", "Broadcom"], 8, 8, 20)
    return clamp(brcm_s * 0.5 + mrvl_s * 0.2 + ns * 0.3), f"AVGO:{brcm_s:.0f} MRVL:{mrvl_s:.0f} News:{n}"

def mkt_asic():
    return market_common(["AVGO", "MRVL"], ["AVGO", "MRVL"])

module("asic", "ASIC", ind_asic, mkt_asic, ["AVGO", "MRVL"], ["ASIC", "custom chip", "Broadcom"])

def ind_hbm():
    mu = yf_quote("MU")
    mu_s = 50 + (mu["change_pct"] * 10 if mu else 50)
    ns, n = news_score(["HBM", "high bandwidth memory", "SK Hynix", "memory"], 8, 8, 20)
    return clamp(mu_s * 0.5 + ns * 0.5), f"MU:{mu_s:.0f} News:{n}"

def mkt_hbm():
    return market_common(["MU"], ["MU", "NVDA"])

module("hbm", "HBM", ind_hbm, mkt_hbm, ["MU"], ["HBM", "high bandwidth memory"])

def ind_equipment():
    # 复用 semicon_trend 的设备评分逻辑
    return stock_momentum(["AMAT", "LRCX", "KLAC"], 10) * 0.6 + stock_3m_momentum(["AMAT", "LRCX", "KLAC"], 2) * 0.4, ""

def mkt_equipment():
    return market_common(["AMAT", "LRCX", "KLAC"], ["AMAT", "LRCX", "KLAC", "^SOX"])

module("equipment", "半导体设备", ind_equipment, mkt_equipment,
       ["AMAT", "LRCX", "KLAC"], ["semiconductor equipment", "wafer fab"])

def ind_materials():
    ns, n = news_score(["silicon wafer", "photoresist", "semiconductor material", "CMP", "电子气体"], 10, 6, 25)
    ms = stock_momentum(["AMAT", "LRCX"], 8)
    return clamp(ms * 0.4 + ns * 0.6), f"Stocks:{ms:.0f} News:{n}"

def mkt_materials():
    return market_common(["AMAT", "LRCX"], ["AMAT", "LRCX"])

module("materials", "半导体材料", ind_materials, mkt_materials,
       ["AMAT", "LRCX"], ["wafer", "photoresist", "CMP"])

def ind_eda():
    ns, n = news_score(["EDA", "Synopsys", "Cadence", "IP", "电子设计", "国产EDA"], 8, 8, 25)
    snps = yf_quote("SNPS")
    cdns = yf_quote("CDNS")
    s_s = 50 + (snps["change_pct"] * 10 if snps else 50)
    c_s = 50 + (cdns["change_pct"] * 10 if cdns else 50)
    return clamp(s_s * 0.4 + c_s * 0.2 + ns * 0.4), f"SNPS:{s_s:.0f} CDNS:{c_s:.0f} News:{n}"

def mkt_eda():
    return market_common(["SNPS", "CDNS"], ["SNPS", "CDNS", "^SOX"])

module("eda", "EDA / IP", ind_eda, mkt_eda, ["SNPS", "CDNS"], ["EDA", "Synopsys", "Cadence"])

# ---- Midstream ----

def ind_pcb():
    ns, n = news_score(["PCB", "printed circuit", "CCL", "高多层", "HDI"], 8, 8, 25)
    ms = stock_momentum(["TSM"], 8)
    return clamp(ms * 0.3 + ns * 0.7), f"TSM:{ms:.0f} News:{n}"

def mkt_pcb():
    return market_common(["TSM"], ["TSM", "^SOX"])

module("pcb", "PCB", ind_pcb, mkt_pcb, ["TSM"], ["PCB", "circuit board"])

def ind_optics():
    ns, n = news_score(["optical module", "光模块", "800G", "1.6T", "CPO", "LPO"], 10, 7, 20)
    ms = stock_momentum(["AVGO", "MRVL"], 10)
    return clamp(ms * 0.4 + ns * 0.6), f"Stocks:{ms:.0f} News:{n}"

def mkt_optics():
    return market_common(["AVGO", "MRVL", "LITE"], ["AVGO", "MRVL"])

module("optics", "光模块", ind_optics, mkt_optics, ["AVGO", "MRVL"], ["optical", "光模块", "CPO"])

def ind_cooling():
    ns, n = news_score(["liquid cooling", "液冷", "immersion", "cold plate", "CDU", "数据中心冷却"], 8, 8, 25)
    ms = stock_momentum(["MSFT", "AMZN"], 8)
    return clamp(ms * 0.3 + ns * 0.7), f"Stocks:{ms:.0f} News:{n}"

def mkt_cooling():
    return market_common(["MSFT", "AMZN"], ["MSFT", "AMZN", "NVDA"])

module("cooling", "液冷", ind_cooling, mkt_cooling, ["MSFT", "AMZN"], ["liquid cooling", "液冷"])

def ind_idc():
    ns, n = news_score(["data center", "数据中心", "AIDC", "rack", "算力", "colocation"], 10, 6, 25)
    ms = stock_momentum(["AMZN", "MSFT", "GOOGL"], 8)
    return clamp(ms * 0.4 + ns * 0.6), f"Hyperscaler:{ms:.0f} News:{n}"

def mkt_idc():
    return market_common(["AMZN", "MSFT", "GOOGL", "EQIX"], ["AMZN", "MSFT", "NVDA"])

module("idc", "IDC", ind_idc, mkt_idc, ["AMZN", "MSFT", "GOOGL"], ["data center", "数据中心"])

def ind_power():
    ns, n = news_score(["transformer", "UPS", "power", "储能", "grid", "electricity", "能源"], 10, 6, 25)
    ms = stock_momentum(["MSFT", "AMZN"], 8)
    return clamp(ms * 0.3 + ns * 0.7), f"Stocks:{ms:.0f} News:{n}"

def mkt_power():
    return market_common(["MSFT", "AMZN"], ["MSFT", "AMZN", "NVDA"])

module("power", "电力基础设施", ind_power, mkt_power, ["MSFT", "AMZN"], ["power", "transformer", "grid"])

# ---- Downstream ----

def ind_foundation():
    ns, n = news_score(["OpenAI", "GPT", "Claude", "Gemini", "Qwen", "DeepSeek", "foundation model", "大模型"], 12, 7, 20)
    ms = stock_momentum(["MSFT", "META", "GOOGL"], 10)
    return clamp(ms * 0.3 + ns * 0.7), f"Stocks:{ms:.0f} News:{n}"

def mkt_foundation():
    return market_common(["MSFT", "META", "GOOGL"], ["MSFT", "META", "NVDA"])

module("foundation", "基础模型", ind_foundation, mkt_foundation,
       ["MSFT", "META", "GOOGL"], ["model", "GPT", "Claude", "Gemini"])

def ind_agent():
    ns, n = news_score(["AI agent", "agent", "Copilot", "MCP", "autonomous", "AI助手", "智能体"], 10, 7, 25)
    ms = stock_momentum(["MSFT", "CRM", "NOW"], 8)
    return clamp(ms * 0.3 + ns * 0.7), f"Stocks:{ms:.0f} News:{n}"

def mkt_agent():
    return market_common(["MSFT", "CRM", "NOW"], ["MSFT", "NVDA"])

module("agent", "AI Agent", ind_agent, mkt_agent,
       ["MSFT", "CRM", "NOW"], ["agent", "Copilot", "MCP"])

def ind_enterprise():
    ns, n = news_score(["enterprise AI", "Copilot", "CRM AI", "SAP", "Oracle", "企业AI", "数字化转型"], 10, 6, 25)
    ms = stock_momentum(["MSFT", "CRM", "ORCL"], 8)
    return clamp(ms * 0.3 + ns * 0.7), f"Stocks:{ms:.0f} News:{n}"

def mkt_enterprise():
    return market_common(["MSFT", "CRM", "ORCL", "ADBE"], ["MSFT", "NVDA"])

module("enterprise", "企业AI", ind_enterprise, mkt_enterprise,
       ["MSFT", "CRM", "ORCL"], ["enterprise AI", "Copilot", "SAP"])

def ind_apps():
    ns, n = news_score(["AI education", "AI healthcare", "AI video", "AI finance", "AI应用", "消费AI"], 10, 6, 25)
    ms = stock_momentum(["META", "GOOGL", "MSFT"], 8)
    return clamp(ms * 0.2 + ns * 0.8), f"Stocks:{ms:.0f} News:{n}"

def mkt_apps():
    return market_common(["META", "GOOGL", "MSFT", "SNAP"], ["META", "MSFT", "NVDA"])

module("apps", "AI 应用", ind_apps, mkt_apps,
       ["META", "GOOGL", "MSFT"], ["AI app", "AI video", "AI education"])

# ====== 主管线 ======

def signal(v):
    if v >= 60: return "positive"
    if v <= 40: return "negative"
    return "neutral"

def run():
    today = date.today()
    print(f"[{today}] AI产业链 开始采集评分 ({len(MODULES)}模块)...")

    results = []
    for key, name, ind_fn, mkt_fn, tickers, kw, parent in MODULES:
        try:
            ind_s, ind_d = ind_fn()
            mkt_s = mkt_fn()
            rot_s = round(ind_s - mkt_s, 1)
            ind_s = round(clamp(ind_s), 1)
            mkt_s = round(clamp(mkt_s), 1)
        except Exception as e:
            print(f"  !! {key} failed: {e}")
            ind_s, mkt_s, rot_s, ind_d = 50, 50, 0, f"Error"
        results.append({
            "key": key, "name": name, "parent": parent,
            "industryScore": ind_s, "marketScore": mkt_s,
            "rotationScore": rot_s,
            "industrySignal": signal(ind_s),
            "marketSignal": signal(mkt_s),
            "detail": ind_d,
        })
        trend = "↑" if rot_s > 5 else "↓" if rot_s < -5 else "→"
        print(f"  [{trend}] {name}: I={ind_s} M={mkt_s} R={rot_s:+}")

    # Rankings
    by_ind = sorted(results, key=lambda r: r["industryScore"], reverse=True)
    by_rot = sorted(results, key=lambda r: r["rotationScore"], reverse=True)

    output = {
        "date": today.isoformat(),
        "generatedAt": datetime.now(TZ_BJ).strftime("%Y-%m-%d %H:%M:%S"),
        "modules": results,
        "rankings": {
            "topIndustry": [r["key"] for r in by_ind[:5]],
            "topRotation": [r["key"] for r in by_rot[:5]],
            "bottomRotation": [r["key"] for r in by_rot[-5:]],
        }
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n[OK] AI chain latest.json saved")

    # Append history
    hist_path = os.path.join(DATA_DIR, "history.json")
    history = []
    if os.path.exists(hist_path):
        try:
            with open(hist_path, "r") as f:
                history = json.load(f)
        except: history = []

    if not history or history[-1].get("date") != today.isoformat():
        entry = {"date": today.isoformat(), "modules": {}}
        for r in results:
            entry["modules"][r["key"]] = {
                "i": r["industryScore"], "m": r["marketScore"], "r": r["rotationScore"],
            }
        history.append(entry)
        history = history[-365:]
        with open(hist_path, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
        print(f"[OK] AI chain history.json updated ({len(history)} days)")

    print(f"\n=== Top 5 Industry ===")
    for r in by_ind[:5]:
        print(f"  {r['name']}: {r['industryScore']}")
    print(f"=== Top 5 Rotation ===")
    for r in by_rot[:5]:
        print(f"  {r['name']}: {r['rotationScore']:+}")
    return output

if __name__ == "__main__":
    run()
