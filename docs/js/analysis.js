// ===== analysis.js — 基金多维度分析页 =====

import * as store from './store.js';
import { streamChat } from './providers.js';
import { renderMarkdown, toast, showModal, searchFundMulti, searchFund, searchFundLocal, loadFundDatabase, loadManagerDatabase, getManagerFunds, detectSectorFromHoldings, fetchWithDispatcher } from './utils.js';

// ---------- 状态 ----------
let selectedFund = null;       // { code, name }
let isAnalyzing = false;
let abortController = null;
let analysisHistory = [];
let lastOverlap = null;        // 最近一次分析的重合度数据，供AI按钮使用

// ---------- 初始化 ----------

export function initAnalysis(containerEl) {
  const searchInput = document.getElementById('analysis-search-input');
  const resultsEl = document.getElementById('analysis-search-results');
  const startBtn = document.getElementById('btn-analysis-start');
  const pickBtn = document.getElementById('btn-pick-holdings');
  const clearSelBtn = document.getElementById('btn-analysis-clear-selection');
  const clearHistoryBtn = document.getElementById('btn-clear-analysis-history');
  const clearSearchBtn = document.getElementById('btn-analysis-search-clear');
  const searchBtn = document.getElementById('btn-analysis-search');
  const toggleHistory = document.getElementById('toggle-analysis-history');

  loadFundDatabase();
  loadManagerDatabase();

  // 搜索按钮
  if (searchBtn) searchBtn.onclick = () => doSearch();

  // 输入实时搜索
  searchInput.addEventListener('input', () => onSearchInput(searchInput.value));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });

  // 清除按钮
  if (clearSearchBtn) clearSearchBtn.onclick = () => {
    searchInput.value = '';
    if (clearSearchBtn) clearSearchBtn.classList.remove('visible');
    if (resultsEl) resultsEl.style.display = 'none';
    searchInput.focus();
  };

  startBtn.onclick = () => startAnalysis();
  pickBtn.onclick = () => openHoldingsPicker();
  clearSelBtn.onclick = () => clearSelection();
  clearHistoryBtn.onclick = () => clearHistory();

  if (toggleHistory) {
    toggleHistory.onclick = (e) => {
      if (e.target.closest('button')) return;
      const body = document.getElementById('analysis-history-body');
      body.classList.toggle('collapsed');
      toggleHistory.classList.toggle('open');
    };
  }

  loadHistory();
  renderHistory();
}

export function onAnalysisVisible() {
  const input = document.getElementById('analysis-search-input');
  if (input) setTimeout(() => input.focus(), 100);
}

// ---------- 基金搜索 ----------

// 搜索按钮 — 弹搜索 modal（100%可靠，不依赖外部 DOM 定位）
function doSearch() {
  onSearchInput(document.getElementById('analysis-search-input').value);
}

function onSearchInput(value) {
  const kw = (value || '').trim();
  const resultsEl = document.getElementById('analysis-search-results');
  const clearBtn = document.getElementById('btn-analysis-search-clear');
  if (clearBtn) clearBtn.classList.toggle('visible', kw.length > 0);

  if (!kw || kw.length < 1) { if (resultsEl) resultsEl.style.display = 'none'; return; }
  if (!resultsEl) return;

  // 定位 dropdown 在搜索框下方
  const wrap = document.querySelector('.analysis-search-wrap');
  if (wrap) {
    const rect = wrap.getBoundingClientRect();
    resultsEl.style.top = (rect.bottom + 4) + 'px';
    resultsEl.style.left = rect.left + 'px';
    resultsEl.style.width = rect.width + 'px';
  }

  resultsEl.innerHTML = '<div class="analysis-search-res-item" style="justify-content:center;padding:12px;color:var(--text-soft);">搜索中…</div>';
  resultsEl.style.display = '';

  searchFundMulti(kw).then(results => {
    if (!results || results.length === 0) {
      resultsEl.innerHTML = '<div class="analysis-search-res-item" style="justify-content:center;padding:12px;color:var(--text-soft);">未找到匹配基金</div>';
      return;
    }
    resultsEl.innerHTML = results.slice(0, 20).map((r, i) => `
      <div class="analysis-search-res-item" data-idx="${i}">
        <div class="res-info">
          <span class="res-name">${esc(r.name)}</span>
          <span class="res-meta">
            <span class="res-code-badge">#${esc(r.code)}</span>
            ${r.type ? '<span class="res-type">'+esc(r.type.replace(/型$/,''))+'</span>' : ''}
          </span>
        </div>
        <span class="res-arrow">↩</span>
      </div>
    `).join('');
    resultsEl.querySelectorAll('.analysis-search-res-item').forEach(item => {
      item.onclick = () => {
        selectFund(results[parseInt(item.dataset.idx)]);
        resultsEl.style.display = 'none';
        document.getElementById('analysis-search-input').value = '';
        if (clearBtn) clearBtn.classList.remove('visible');
      };
    });
  }).catch(() => {
    resultsEl.innerHTML = '<div class="analysis-search-res-item" style="justify-content:center;padding:12px;color:var(--text-soft);">搜索失败</div>';
  });
}

// ---------- 持仓选择器 ----------

function openHoldingsPicker() {
  const holdings = store.getHoldings() || [];
  const followList = store.getFollowList() || [];

  // 收集所有唯一基金
  const fundMap = new Map();
  holdings.forEach(h => { if (h.code) fundMap.set(h.code, h); });
  followList.forEach(p => {
    (p.items || []).forEach(item => {
      if (item.code) fundMap.set(item.code, item);
    });
  });

  const funds = Array.from(fundMap.values());
  if (funds.length === 0) {
    toast('暂未添加持仓，请先在持仓页添加');
    return;
  }

  const listHTML = funds.map(f => `
    <div class="fund-picker-item" data-code="${esc(f.code)}" data-name="${esc(f.name || '')}">
      <span>${esc(f.name || '未知基金')}</span>
      <span class="fp-code">${esc(f.code)}</span>
    </div>
  `).join('');

  showModal('选择持仓基金', `<div class="fund-picker-list">${listHTML}</div>`, [
    { text: '取消', cls: '', onClick: () => {} }
  ]);

  // 延迟绑定事件（等 modal 渲染完成）
  setTimeout(() => {
    document.querySelectorAll('.fund-picker-item').forEach(item => {
      item.onclick = () => {
        selectFund({ code: item.dataset.code, name: item.dataset.name });
        // 关闭 modal
        const mask = document.querySelector('.modal-mask');
        if (mask) mask.remove();
      };
    });
  }, 50);
}

// ---------- 基金选择/清除 ----------

function selectFund(fund) {
  selectedFund = fund;
  const card = document.getElementById('analysis-selected-card');
  card.querySelector('.sel-name').textContent = fund.name;
  card.querySelector('.sel-code-mini').textContent = fund.code;
  card.style.display = '';

  const btn = document.getElementById('btn-analysis-start');
  btn.disabled = false;
  btn.textContent = '🔬 分析';

  document.getElementById('analysis-search-results').style.display = 'none';
}

function clearSelection() {
  selectedFund = null;
  document.getElementById('analysis-selected-card').style.display = 'none';
  const btn = document.getElementById('btn-analysis-start');
  btn.disabled = true;
  btn.textContent = '🔬 分析';
  document.getElementById('analysis-results').innerHTML = '<div class="empty-hint">选择一只基金，点击「分析」</div>';
}

// ---------- 基金数据获取 ----------

async function fetchFundData(code) {
  // 1. j5 API (CORS allowed)
  let j5data = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(
      `https://j5.dfcfw.com/sc/tfs/qt/v2.0.1/${encodeURIComponent(code)}.json`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (resp.ok) {
      j5data = await resp.json();
    }
  } catch (e) {
    console.warn('j5 fetch failed:', e.message);
  }

  // 2. 实时估值 (JSONP)
  let realtimeNAV = null;
  try {
    realtimeNAV = await fetchRealtimeNAV(code);
  } catch (e) {
    console.warn('fundgz fetch failed:', e.message);
  }

  return parseFundData(j5data, code, realtimeNAV);
}

function fetchRealtimeNAV(code) {
  return fetchWithDispatcher(code, 4000).then(data => {
    if (!data) return null;
    return {
      dwjz: parseFloat(data.dwjz) || 0,
      gsz: parseFloat(data.gsz) || 0,
      gszzl: parseFloat(data.gszzl) || 0,
      gztime: data.gztime || '',
    };
  });
}

function parseFundData(j5data, code, realtimeNAV) {
  if (!j5data) return null;

  const jjxq = (j5data.JJXQ || {}).Datas || {};
  const jjfx = (j5data.JJFX || {}).Datas || {};
  const jdzf = (j5data.JDZF || {}).Datas || [];
  const tssj = (j5data.TSSJ || {}).Datas || {};
  const hbcc = (j5data.HBCC || {}).Datas || {};
  const jjjlnew = (j5data.JJJLNEW || {}).Datas || [];
  const acrate = (j5data.ACRATE || {}).data || [];

  // Fund name
  const name = jjfx.SHORTNAME || jjxq.SHORTNAME || code;

  // Fund type
  const ftype = jjxq.FTYPE || '';
  const ftypeCode = jjfx.FUNDTYPE || '';

  // Company
  const company = jjxq.JJGS || '';

  // Scale (100M RMB)
  let scale = 0;
  try {
    const hbccDatas = Array.isArray(hbcc) ? hbcc : (hbcc.Datas || []);
    const scaleData = Array.isArray(hbccDatas) ? hbccDatas.find(d => d && d.JZC) : null;
    if (scaleData) scale = parseFloat(scaleData.JZC) || 0;
  } catch { scale = 0; }

  // Fee rate — j5 ACRATE.tpoint 是申购费率(如3.65%),不可用作管理费率
  // 管理费率需要从其他源获取，j5 JJXQ.SOURCERATE/RATE 通常为0（C类免申购费）
  // 暂标记为不可用，后续可从 fundf10 页面补充
  let fee = null;

  // Manager (j5 JJJLNEW 实际字段: MGRID, MGRNAME, TOTALDAYS, YIELDSE, PENAVGROWTH, DAYS, FEMPDATE, INVESTMENTIDEAR)
  let manager = '';
  let managerId = '';
  let managerExp = 0;
  let managerYield = null;
  let managerPenav = null;
  let managerDaysOnFund = 0;
  let managerStartDate = '';
  let managerIdea = '';
  try {
    const mgrArr = Array.isArray(jjjlnew) ? jjjlnew : [];
    if (mgrArr.length > 0) {
      const mgr = (mgrArr[0].MANGER || [])[0] || {};
      manager = mgr.MGRNAME || '';
      managerId = mgr.MGRID || '';
      managerExp = (parseInt(mgr.TOTALDAYS) || 0) / 365;
      managerYield = mgr.YIELDSE != null ? parseFloat(mgr.YIELDSE) : null;
      managerPenav = mgr.PENAVGROWTH != null ? parseFloat(mgr.PENAVGROWTH) : null;
      managerDaysOnFund = parseInt(mgr.DAYS) || 0;
      managerStartDate = mgr.FEMPDATE || '';
      managerIdea = mgr.INVESTMENTIDEAR || '';
    }
  } catch { /* ignore */ }

  // Performance: YTD, 1Y, 3Y
  let ytd = null, y1 = null, y3 = null;
  try {
    const jdzfArr = Array.isArray(jdzf) ? jdzf : [];
    const findPerf = (title) => {
      const item = jdzfArr.find(d => d && d.title === title);
      return item ? parseFloat(item.syl) : null;
    };
    ytd = findPerf('JN');
    y1 = findPerf('1N');
    y3 = findPerf('3N');
  } catch { /* ignore */ }

  // Max drawdown
  let mdd = null;
  try {
    const raw = parseFloat(tssj.MAXRETRA1 || tssj.MAXRETRA);
    if (!isNaN(raw)) mdd = -Math.abs(raw);  // ensure negative
  } catch { mdd = null; }

  // Calmar ratio
  let calmar = null;
  if (y1 != null && mdd != null && mdd !== 0) {
    calmar = Math.abs(y1 / mdd);
  }

  // Top holdings
  let topHoldings = [];
  try {
    const jjcc = (j5data.JJCCNEW || {}).data || {};
    const stocks = jjcc.InverstPosition?.fundStocks || [];
    topHoldings = stocks.slice(0, 10).map(s => s.GPJC || s.GPDM || '');
  } catch { topHoldings = []; }

  // NAV
  const nav = parseFloat(jjfx.DWJZ) || 0;

  // Category
  const category = inferCategory(name, ftype);

  const fundData = {
    code,
    name,
    company,
    type: ftype || ftypeCode,
    category,
    ytd,
    y1,
    y3,
    mdd,
    calmar,
    fee,
    scale,
    manager,
    managerId,
    managerExp,
    managerYield,
    managerPenav,
    managerDaysOnFund,
    managerStartDate,
    managerIdea,
    nav,
    gszzl: realtimeNAV?.gszzl ?? parseFloat(jjfx.RZDF) || null,
    gztime: realtimeNAV?.gztime ?? (parseFloat(jjfx.RZDF) ? jjfx.FSRQ || '' : ''),
    topHoldings,
  };

  return fundData;
}

function inferCategory(name, type) {
  const nl = (name + ' ' + (type || '')).toLowerCase();
  if (/人工智能|ai/.test(nl)) return 'AI/人工智能';
  if (/半导体|芯片|集成电路/.test(nl)) return '半导体/芯片';
  if (/纳斯达克/.test(nl)) return '美股科技';
  if (/5g|通信/.test(nl)) return '5G/通信';
  if (/机器人/.test(nl)) return '机器人';
  if (/信息产业|信息行业|科技|互联网/.test(nl)) return '信息产业/AI';
  if (/qdii|全球|海外|亚洲|大中华/.test(nl)) return '全球配置';
  if (/消费|质量|蓝筹/.test(nl)) return '消费/质量成长';
  if (/医疗|医药|健康/.test(nl)) return '医药健康';
  if (/新能源|光伏/.test(nl)) return '新能源';
  if (/数字|新经济/.test(nl)) return '数字经济/AI';
  if (/混合|灵活/.test(nl)) return '混合/灵活配置';
  return '其他';
}

// 轻量获取某基金的持仓股票代码（仅用于重合度对比）
async function fetchFundStockCodes(code) {
  try {
    const resp = await fetch(`https://j5.dfcfw.com/sc/tfs/qt/v2.0.1/${code}.json`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const stocks = data?.JJCCNEW?.data?.InverstPosition?.fundStocks || [];
    return stocks.slice(0, 10).map(s => s.GPDM || '').filter(Boolean);
  } catch { return []; }
}

// 计算与用户持仓的股票级别重合度
async function calculatePortfolioOverlap(fundData) {
  const holdings = store.getHoldings() || [];
  const debug = [];

  debug.push(`持仓总数: ${holdings.length}`);
  const myStockNames = (fundData.topHoldings || []).slice(0, 10);
  debug.push(`本基金重仓股: ${myStockNames.join('、') || '(空)'}`);

  if (!holdings.length) return { result: null, debug };

  const result = {
    sameSector: [],
    totalHoldingValue: 0,
    overlapRatio: 0,
    concentrationRisk: false,
    stockOverlap: [],  // 重合的股票代码
  };

  // 本基金的前十重仓股代码
  const myStockCodes = new Set();
  try {
    const codes = await fetchFundStockCodes(fundData.code);
    codes.forEach(c => myStockCodes.add(c));
  } catch { /* ignore */ }
  debug.push(`本基金持仓股代码: ${[...myStockCodes].join(',') || '(空)'}`);

  // 从重仓股推断赛道（用于兜底）
  const targetSectors = detectSectorFromHoldings(fundData.topHoldings) || [];
  const targetName = (fundData.name || '').toLowerCase();
  debug.push(`检测赛道: ${targetSectors.join('、') || '(未识别)'}`);

  let totalMV = 0;
  let overlapMV = 0;
  const sharedStocks = new Set();

  // 并发获取用户所有持仓基金的重仓股（限5只）
  const userCodes = holdings.filter(h => h.code && h.code !== fundData.code).slice(0, 8);
  const userHoldingsData = await Promise.all(
    userCodes.map(async (h) => {
      const stocks = await fetchFundStockCodes(h.code);
      return { code: h.code, name: h.name, stocks, mv: parseFloat(h.market_value) || parseFloat(h.cost) || 0 };
    })
  );

  for (const h of holdings) {
    if (!h.code) continue;
    const mv = parseFloat(h.market_value) || parseFloat(h.cost) || 0;
    totalMV += mv;

    if (h.code === fundData.code) {
      result.sameSector.push({ code: h.code, name: h.name, reason: '本基金自身', stockOverlap: 0 });
      continue; // 不纳入重合度计算
    }

    const userData = userHoldingsData.find(d => d.code === h.code);
    const hName = (h.name || '').toLowerCase();

    // 方式1：股票代码级别重合
    let stockMatch = 0;
    if (userData && userData.stocks.length > 0 && myStockCodes.size > 0) {
      for (const sc of userData.stocks) {
        if (myStockCodes.has(sc)) { stockMatch++; sharedStocks.add(sc); }
      }
    }

    // 方式2：名称关键词兜底
    let reason = '';
    if (stockMatch > 0) {
      reason = `股票重合 ${stockMatch}/10`;
    } else {
      for (const sector of targetSectors) {
        const kw = sector.replace(/[/、]/g, '|');
        if (new RegExp(kw).test(hName)) { reason = sector; break; }
      }
      if (!reason) {
        const kw = detectSharedSectorKeywords(hName, targetName);
        if (kw) reason = kw;
      }
    }

    if (stockMatch > 0 || reason) {
      // 按股票实际重合比例加权：stockMatch/10 的持仓金额才算重合
      const weight = stockMatch > 0 ? stockMatch / 10 : 0.3; // 纯关键词匹配按30%估算
      overlapMV += mv * weight;
      result.sameSector.push({ code: h.code, name: h.name, reason: reason || '赛道重合', stockOverlap: stockMatch });
      debug.push(`重合: ${h.code} ${h.name} → ${reason} (股票重合${stockMatch}/10, 加权${(weight*100).toFixed(0)}%)`);
    } else {
      debug.push(`不重合: ${h.code} ${h.name} (无共同持股)`);
    }
  }

  result.stockOverlap = [...sharedStocks];
  result.totalHoldingValue = totalMV;
  // 重合度 = 加权重合金额 / 总金额（不含自身）
  const selfMV = parseFloat(holdings.find(h => h.code === fundData.code)?.market_value) || parseFloat(holdings.find(h => h.code === fundData.code)?.cost) || 0;
  const totalExSelf = totalMV - selfMV;
  result.overlapRatio = totalExSelf > 0 ? +(overlapMV / totalExSelf * 100).toFixed(1) : 0;
  result.concentrationRisk = result.overlapRatio > 30;
  // 统计各基金股票重合数
  const stockMatchSummary = result.sameSector
    .filter(f => f.stockOverlap > 0)
    .map(f => `${f.code}:${f.stockOverlap}/10`)
    .join(', ');
  debug.push(`共同持股代码: ${sharedStocks.size > 0 ? [...sharedStocks].join(',') : '无'}`);
  debug.push(`各基金股票重合: ${stockMatchSummary || '无'}`);
  const finalResult = result.sameSector.filter(f => f.stockOverlap > 0 || f.reason !== '本基金自身').length > 0 ? result : null;
  debug.push(`结果: ${finalResult ? '重合度 '+result.overlapRatio+'%' : '无重合'}`);
  return { result: finalResult, debug };
}

function detectSharedSectorKeywords(name1, name2) {
  const keywords = [
    ['ai', '人工智能'], ['半导体', '芯片', '集成电路'], ['纳斯达克', '美股'],
    ['5g', '通信'], ['机器人'], ['信息', '科技', '互联网'], ['新能源', '光伏'],
    ['医药', '医疗', '健康'], ['消费'], ['军工', '航天'], ['黄金', '贵金属'],
    ['数字'], ['混合', '灵活'],
  ];
  for (const group of keywords) {
    const m1 = group.some(k => name1.includes(k));
    const m2 = group.some(k => name2.includes(k));
    if (m1 && m2) return group[0];
  }
  return null;
}

function buildZxDesc(scores, fundData) {
  const holdingSectors = detectSectorFromHoldings(fundData.topHoldings);
  const sectorStr = holdingSectors.length > 0 ? holdingSectors.join('、') : (fundData.category || '未识别');
  const source = holdingSectors.length > 0 ? '（基于前十重仓股推断）' : '（基于基金名称匹配）';

  if (scores.scoreZx >= 4) {
    return `检测赛道：${sectorStr}${source}。处于AI算力/半导体核心赛道，产业景气上行，符合郑希方法论重仓标准。`;
  } else if (scores.scoreZx >= 3) {
    return `检测赛道：${sectorStr}${source}。赛道方向匹配科技主线，但景气强度或确定性不足，建议适度配置。`;
  } else if (scores.scoreZx >= 2) {
    return `检测赛道：${sectorStr}${source}。赛道偏离科技主线，或产业周期处于下行阶段，不建议重仓。`;
  }
  return `检测赛道：${sectorStr}${source}。赛道与郑希方法论核心方向背离，产业周期/景气度不支持持仓。`;
}

function buildOverlapHTML(overlap, fundData, debug) {
  // 调试面板（始终显示）
  const debugHTML = debug && debug.length ? `
    <details style="margin-top:8px;font-size:12px;color:var(--text-soft);">
      <summary style="cursor:pointer;font-weight:500;">调试信息</summary>
      <pre style="background:#f8fafc;padding:8px;border-radius:6px;margin-top:6px;white-space:pre-wrap;font-size:11px;line-height:1.6;">${debug.map(d => esc(d)).join('\n')}</pre>
    </details>` : '';

  const holdings = store.getHoldings() || [];
  if (!holdings.length) {
    return `
    <div class="analysis-fw-card" style="margin-top:4px;">
      <div class="fw-head">
        <div class="fw-icon" style="background:#f8fafc;">🔗</div>
        <div>
          <div class="fw-title">持仓重合度分析</div>
          <div class="fw-weight">需要先在持仓页添加基金</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:6px;">
        当前持仓为空，无法计算赛道重合度。请先在<a href="#" onclick="document.querySelector('[data-tab=holdings]').click()" style="color:var(--primary);">持仓页</a>添加基金。
      </div>
      ${debugHTML}
    </div>`;
  }
  if (!overlap) {
    return `
    <div class="analysis-fw-card" style="margin-top:4px;">
      <div class="fw-head">
        <div class="fw-icon" style="background:#f0fdf4;">🔗</div>
        <div>
          <div class="fw-title">持仓重合度分析</div>
          <div class="fw-weight">未检测到明显重合（股票级别）</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:6px;">
        实际比较了前十重仓股代码，未发现共同持仓。
      </div>
      ${debugHTML}
    </div>`;
  }

  const stockInfo = overlap.stockOverlap && overlap.stockOverlap.length > 0
    ? `<div style="margin-top:6px;font-size:11px;color:var(--text-soft);">共同持股代码: ${overlap.stockOverlap.map(c => esc(c)).join(', ')}</div>`
    : '';

  const items = overlap.sameSector.slice(0, 8);
  const more = overlap.sameSector.length > 8 ? ` +${overlap.sameSector.length - 8} 只` : '';

  let riskBadge = '';
  if (overlap.concentrationRisk) {
    riskBadge = `<div style="margin-top:8px;padding:8px 12px;background:#fef3c7;border-radius:8px;font-size:12px;color:#92400e;">
      ⚠️ 集中度风险：你的持仓中 ${overlap.overlapRatio}% 已投向相同赛道。综合评分已扣除 ${overlap.overlapRatio > 30 ? '+' + (overlap.overlapRatio/100*2).toFixed(1) : '0'} 分。
    </div>`;
  }

  return `
    <div class="analysis-fw-card" style="margin-top:4px;">
      <div class="fw-head">
        <div class="fw-icon" style="background:#f0fdf4;">🔗</div>
        <div>
          <div class="fw-title">持仓重合度分析</div>
          <div class="fw-weight">股票级别对比（前十重仓股代码）</div>
        </div>
      </div>
      <div style="margin-top:8px;font-size:13px;color:var(--text);">
        重合赛道占比：<b style="color:${overlap.concentrationRisk?'#dc2626':'#059669'};">${overlap.overlapRatio}%</b>
      </div>
      ${stockInfo}
      ${riskBadge}
      ${items.length > 0 ? `
      <div style="margin-top:10px;">
        <div style="font-size:12px;color:var(--text-soft);margin-bottom:6px;">重合基金：</div>
        ${items.map(f => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;border-bottom:1px solid #f1f5f9;">
            <span class="mgr-fund-chip" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534;" data-code="${esc(f.code)}" title="${esc(f.name)}">${esc(f.code)}</span>
            <span style="flex:1;">${esc(f.name)}</span>
            <span style="font-size:11px;color:var(--text-soft);">${f.reason}</span>
            ${f.stockOverlap > 0 ? `<span style="font-weight:600;color:#059669;font-size:12px;">${f.stockOverlap}/10</span>` : '<span style="font-size:11px;color:var(--text-soft);">—</span>'}
          </div>
        `).join('')}
      </div>` : ''}
      ${debugHTML}
    </div>
  `;
}

function computeScores(fundData, overlap) {
  const calmar = fundData.calmar || 0;

  // 量化框架 (35%) — Calmar 阈值
  let scoreQuant;
  if (calmar >= 8) scoreQuant = 5;
  else if (calmar >= 4) scoreQuant = 4;
  else if (calmar >= 2) scoreQuant = 3;
  else if (calmar >= 1) scoreQuant = 2;
  else scoreQuant = 1;

  // 质量框架 (30%) — 经理经验 + 规模 + 费率 + 回撤
  let scoreQual = 3; // base
  if (fundData.managerExp >= 8) scoreQual = Math.min(5, scoreQual + 1);
  else if (fundData.managerExp >= 5) { /* keep 3 */ }
  else if (fundData.managerExp >= 3) scoreQual = Math.max(1, scoreQual - 1);
  else if (fundData.managerExp > 0) scoreQual = Math.max(1, scoreQual - 1);
  if (fundData.fee != null && fundData.fee > 0 && fundData.fee <= 0.6) scoreQual = Math.min(5, scoreQual + 1);
  if (fundData.scale > 0 && fundData.scale < 2) scoreQual = Math.max(1, scoreQual - 1);
  if (fundData.mdd != null) {
    if (fundData.mdd > -30) scoreQual = Math.min(5, scoreQual + 1);
    else if (fundData.mdd < -50) scoreQual = Math.max(1, scoreQual - 1);
  }
  scoreQual = Math.max(1, Math.min(5, scoreQual));

  // 郑希框架 (35%) — 赛道匹配（优先重仓股推断 > 基金名称匹配）+ 规模/回撤
  let scoreZx = 3; // base
  const nl = (fundData.name || '').toLowerCase();
  const holdingSectors = detectSectorFromHoldings(fundData.topHoldings);
  const primarySector = holdingSectors ? holdingSectors[0] : null;

  // 优先用重仓股推断的赛道
  if (holdingSectors && holdingSectors.length > 0) {
    const top = holdingSectors[0];
    if (/半导体|芯片|ai|算力|人工智能/.test(top.toLowerCase())) scoreZx = Math.min(5, scoreZx + 2);
    else if (/5g|通信|互联网|软件|机器人|数字/.test(top.toLowerCase())) scoreZx = Math.min(5, scoreZx + 1);
    else scoreZx = Math.max(1, scoreZx - 1);
  } else {
    // 回退到基金名称匹配
    if (/ai|人工智能|半导体|芯片|集成电路|算力/.test(nl)) scoreZx = Math.min(5, scoreZx + 2);
    else if (/信息|5g|通信|数字|科技|互联网/.test(nl)) scoreZx = Math.min(5, scoreZx + 1);
    else scoreZx = Math.max(1, scoreZx - 1);
  }

  if (fundData.scale >= 5 && fundData.mdd != null && fundData.mdd > -50) {
    scoreZx = Math.min(5, scoreZx + 1);
  }
  scoreZx = Math.max(1, Math.min(5, scoreZx));

  // 综合评分
  let composite = +(scoreQuant * 0.35 + scoreQual * 0.30 + scoreZx * 0.35).toFixed(1);

  // 持仓重合度修正：高重合度降低综合评分（集中度风险）
  let overlapPenalty = 0;
  if (overlap && overlap.concentrationRisk) {
    overlapPenalty = Math.min(1.0, +(overlap.overlapRatio / 100 * 2).toFixed(1));
    composite = +(composite - overlapPenalty).toFixed(1);
    composite = Math.max(1.0, composite);
  }

  // 操作建议
  let action, actionLabel, actionColor;
  if (composite >= 4.0) { action = '加仓'; actionLabel = '强烈推荐/重仓持有'; actionColor = 'green'; }
  else if (composite >= 3.0) { action = '持有'; actionLabel = '推荐持有/适度配置'; actionColor = 'blue'; }
  else if (composite >= 2.0) { action = '减仓'; actionLabel = '谨慎持有/考虑减持'; actionColor = 'yellow'; }
  else { action = '清仓'; actionLabel = '建议清仓/回避'; actionColor = 'red'; }

  return { scoreQuant, scoreQual, scoreZx, composite, calmar, action, actionLabel, actionColor, overlapPenalty };
}

// ---------- 开始分析 ----------

async function startAnalysis() {
  if (isAnalyzing || !selectedFund) return;
  isAnalyzing = true;

  const startBtn = document.getElementById('btn-analysis-start');
  startBtn.disabled = true;
  startBtn.textContent = '分析中…';

  // 取消之前的请求
  if (abortController) abortController.abort();
  abortController = new AbortController();

  try {
    // 1. 加载中
    renderLoading();

    // 2. 获取数据
    const fundData = await fetchFundData(selectedFund.code);
    if (!fundData) {
      renderError('无法获取基金数据。请检查基金代码是否正确，或稍后重试。');
      return;
    }

    // 3. 计算持仓重合度（异步，拉取用户持仓基金的重仓股）
    const overlapData = await calculatePortfolioOverlap(fundData);
    lastOverlap = overlapData.result;

    // 4. 计算评分（传入重合度）
    const scores = computeScores(fundData, lastOverlap);

    // 5. 渲染静态部分（信息卡片 + 评分 + 重合度）
    renderFundResults(fundData, scores, lastOverlap, overlapData.debug);

    // 4.5 绑定经理在管基金 chip 点击 + 异步加载经理数据库
    bindManagerChipEvents();
    if (fundData.managerId) {
      loadManagerDatabase().then(() => {
        const section = document.getElementById('mgr-funds-section');
        if (section) {
          section.innerHTML = buildManagerFundsHTML(fundData) || '';
          bindManagerChipEvents();
        }
      });
    }

    // 5. 保存历史（不含AI文本，AI需要手动触发）
    saveToHistory(fundData, scores, '');
    renderHistory();

  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('Analysis error:', e);
    renderError('分析失败：' + (e.message || '未知错误'));
  } finally {
    isAnalyzing = false;
    startBtn.disabled = false;
    startBtn.textContent = '开始分析';
    abortController = null;
  }
}

// ---------- 渲染 ----------

function renderLoading() {
  const resultsEl = document.getElementById('analysis-results');
  resultsEl.innerHTML = `
    <div class="analysis-loading">
      <div class="analysis-spinner"></div>
      <span>正在获取基金数据…</span>
    </div>
  `;
}

function renderError(msg) {
  const resultsEl = document.getElementById('analysis-results');
  resultsEl.innerHTML = `<div class="analysis-error">⚠️ ${esc(msg)}</div>`;
}

function renderFundResults(fundData, scores, overlap, debug) {
  const resultsEl = document.getElementById('analysis-results');

  const name = esc(fundData.name);
  const code = esc(fundData.code);
  const catClass = scores.actionColor;

  // 实时估值行
  let liveRow = '';
  if (fundData.gszzl != null && fundData.gztime) {
    const sign = fundData.gszzl >= 0 ? '+' : '';
    const cls = fundData.gszzl >= 0 ? 'pos' : 'neg';
    liveRow = `<div class="analysis-metric">
      <span class="metric-label">盘中估值</span>
      <span class="metric-value ${cls}">${sign}${fundData.gszzl.toFixed(2)}% · ${esc(fundData.gztime.slice(-5))}</span>
    </div>`;
  }

  // 指标列表
  const metrics = [
    { l: '赛道分类', v: fundData.category || '—' },
    { l: '基金经理', v: fundData.manager || '—' },
    { l: '从业年限', v: fundData.managerExp ? fundData.managerExp.toFixed(1) + ' 年' : '—' },
    { l: '基金规模', v: fundData.scale ? fundData.scale.toFixed(1) + ' 亿' : '—' },
    { l: '管理费率', v: fundData.fee != null ? fundData.fee.toFixed(2) + '%' : '—' },
    { l: '最新净值', v: fundData.nav ? fundData.nav.toFixed(4) : '—' },
    { l: 'YTD 回报', v: fundData.ytd != null ? (fundData.ytd>=0?'+':'')+fundData.ytd.toFixed(2)+'%' : '—', c: fundData.ytd > 0 ? 'pos' : (fundData.ytd < 0 ? 'neg' : '') },
    { l: '近 1 年回报', v: fundData.y1 != null ? (fundData.y1>=0?'+':'')+fundData.y1.toFixed(2)+'%' : '—', c: fundData.y1 > 0 ? 'pos' : (fundData.y1 < 0 ? 'neg' : '') },
    { l: '近 3 年回报', v: fundData.y3 != null ? (fundData.y3>=0?'+':'')+fundData.y3.toFixed(2)+'%' : '—', c: fundData.y3 > 0 ? 'pos' : (fundData.y3 < 0 ? 'neg' : '') },
    { l: '最大回撤', v: fundData.mdd != null ? fundData.mdd.toFixed(2)+'%' : '—', c: fundData.mdd > -20 ? 'neg' : (fundData.mdd < -40 ? 'pos' : '') },
    { l: 'Calmar 比率', v: fundData.calmar != null ? fundData.calmar.toFixed(2) : '—' },
  ];

  const metricsHTML = metrics.map(m => {
    const cls = m.c || '';
    return `<div class="analysis-metric">
      <span class="metric-label">${esc(m.l)}</span>
      <span class="metric-value ${cls}">${esc(m.v)}</span>
    </div>`;
  }).join('');

  // 三个框架的卡片
  const frameworks = [
    {
      id: 'quant', icon: '📈', iconClass: 'quant',
      title: '量化框架', weight: '权重 35%',
      score: scores.scoreQuant,
      color: scores.scoreQuant >= 4 ? 'high' : scores.scoreQuant >= 3 ? 'mid' : scores.scoreQuant >= 2 ? 'low' : 'crit',
      desc: scores.scoreQuant >= 4 ? 'Calmar比率优秀，风险调整后收益出色，量化指标支持重仓配置。' :
            scores.scoreQuant >= 3 ? 'Calmar比率适中，风险收益比可接受，建议正常配置。' :
            scores.scoreQuant >= 2 ? 'Calmar比率偏低，风险收益不匹配，建议降低仓位。' :
            'Calmar比率很差，高回撤低收益，量化指标不支持持有。',
    },
    {
      id: 'qual', icon: '👤', iconClass: 'qual',
      title: '质量框架', weight: '权重 30%',
      score: scores.scoreQual,
      color: scores.scoreQual >= 4 ? 'high' : scores.scoreQual >= 3 ? 'mid' : scores.scoreQual >= 2 ? 'low' : 'crit',
      desc: scores.scoreQual >= 4 ? '经理经验丰富、规模适中、费率低、回撤控制好，基金综合质量高。' :
            scores.scoreQual >= 3 ? '基金质量总体可接受，关键维度无明显硬伤。' :
            scores.scoreQual >= 2 ? '部分维度存在短板（经理经验/规模/费率/回撤），需关注风险。' :
            '多个质量维度不及格，存在较大隐患，建议回避。',
    },
    {
      id: 'zx', icon: '🎯', iconClass: 'zx',
      title: '郑希框架', weight: '权重 35%',
      score: scores.scoreZx,
      color: scores.scoreZx >= 4 ? 'high' : scores.scoreZx >= 3 ? 'mid' : scores.scoreZx >= 2 ? 'low' : 'crit',
      desc: buildZxDesc(scores, fundData),
    },
  ];

  const frameworksHTML = frameworks.map(fw => {
    const pct = Math.round(fw.score / 5 * 100);
    return `
    <div class="analysis-fw-card">
      <div class="fw-head">
        <div class="fw-icon ${fw.id}">${fw.icon}</div>
        <div>
          <div class="fw-title">${fw.title}</div>
          <div class="fw-weight">${fw.weight}</div>
        </div>
        <div class="fw-score-big ${fw.color}">${fw.score}<small style="font-size:16px;font-weight:400;">/5</small></div>
      </div>
      <div class="analysis-fw-bar-wrap">
        <div class="analysis-fw-bar">
          <div class="analysis-fw-bar-fill ${fw.color}" style="width:${pct}%;"></div>
        </div>
        <span style="font-size:11px;color:var(--text-soft);">${pct}%</span>
      </div>
      <div class="analysis-fw-desc">${fw.desc}</div>
    </div>`;
  }).join('');

  // 综合判定
  const borderClass = scores.actionColor + '-border';
  const scoreColor = scores.composite >= 4 ? '#059669' : scores.composite >= 3 ? '#1e40af' : scores.composite >= 2 ? '#d97706' : '#dc2626';

  resultsEl.innerHTML = `
    <!-- 基金头部 -->
    <div class="analysis-fund-hero">
      <div class="hero-top">
        <span class="hero-name">${name}</span>
        <span class="hero-code">${code}</span>
        <span class="hero-badge ${catClass}">${scores.action} · ${scores.actionLabel}</span>
      </div>
      <div class="analysis-metrics-grid">
        ${liveRow || '<div class="analysis-metric"><span class="metric-label">基金公司</span><span class="metric-value">' + esc(fundData.company || '—') + '</span></div>'}
        <div class="analysis-metric metric-divider"></div>
        ${metricsHTML}
      </div>
    </div>

    <!-- 三大框架 -->
    <div class="analysis-frameworks">
      ${frameworksHTML}
    </div>

    <!-- 持仓重合度 -->
    ${buildOverlapHTML(overlap, fundData, debug)}

    <!-- 基金经理 -->
    <div class="analysis-fw-card" style="margin-top:4px;">
      <div class="fw-head">
        <div class="fw-icon" style="background:#faf5ff;">👔</div>
        <div>
          <div class="fw-title">基金经理：${esc(fundData.manager || '—')}</div>
          <div class="fw-weight">${esc(fundData.company || '')}${fundData.managerStartDate ? ' · ' + esc(fundData.managerStartDate) + ' 起管理' : ''}</div>
        </div>
      </div>
      <div class="analysis-metrics-grid" style="margin-top:8px;">
        <div class="analysis-metric"><span class="metric-label">从业年限</span><span class="metric-value">${fundData.managerExp ? fundData.managerExp.toFixed(1) + ' 年' : '—'}</span></div>
        <div class="analysis-metric"><span class="metric-label">任期回报</span><span class="metric-value ${(fundData.managerYield||0) > 0 ? 'pos' : 'neg'}">${fundData.managerYield != null ? (fundData.managerYield>=0?'+':'')+fundData.managerYield.toFixed(2)+'%' : '—'}</span></div>
        <div class="analysis-metric"><span class="metric-label">任期增长</span><span class="metric-value ${(fundData.managerPenav||0) > 0 ? 'pos' : 'neg'}">${fundData.managerPenav != null ? (fundData.managerPenav>=0?'+':'')+fundData.managerPenav.toFixed(2)+'%' : '—'}</span></div>
        <div class="analysis-metric"><span class="metric-label">管理本基金</span><span class="metric-value">${fundData.managerDaysOnFund ? (fundData.managerDaysOnFund/365).toFixed(1) + ' 年' : '—'}</span></div>
      </div>
      ${fundData.managerIdea ? `<div class="analysis-fw-desc" style="margin-top:10px;font-style:italic;">"${esc(fundData.managerIdea)}"</div>` : ''}
      <div id="mgr-funds-section">${buildManagerFundsHTML(fundData) || (fundData.managerId ? '<div style="margin-top:10px;font-size:11px;color:var(--text-soft);">在管基金加载中…</div>' : '')}</div>
      <div class="analysis-fw-desc" style="margin-top:8px;">经理评价由 AI 基于五维框架（资历·业绩·风格稳定性·风控·综合）生成。</div>
    </div>

    <!-- 综合判定 -->
    <div class="analysis-verdict ${borderClass}">
      <div class="verdict-label">综合评分</div>
      <div class="verdict-score-wrap">
        <span class="verdict-score" style="color:${scoreColor};">${scores.composite}</span>
        <span class="verdict-max">/ 5.0</span>
      </div>
      <div class="verdict-action ${scores.actionColor}">${scores.action}</div>
      <div class="verdict-explain">${scores.actionLabel}</div>
    </div>

    <!-- AI 分析 -->
    <div class="analysis-ai-card" id="analysis-ai-card">
      <div class="ai-head" style="justify-content:space-between;">
        <span>🤖 AI 深度分析</span>
        <button id="btn-ai-analyze" class="btn primary" style="font-size:12px;padding:4px 14px;">开始AI分析</button>
      </div>
      <div id="analysis-ai-content" class="analysis-ai-content" style="display:none;"></div>
      <div id="analysis-ai-placeholder" class="analysis-no-ai">点击「开始AI分析」由 AI 生成多维度深度解读和基金经理评价。</div>
    </div>
  `;

  // 绑定 AI 按钮
  setTimeout(() => {
    const aiBtn = document.getElementById('btn-ai-analyze');
    const aiContent = document.getElementById('analysis-ai-content');
    const aiPlaceholder = document.getElementById('analysis-ai-placeholder');
    if (aiBtn) {
      aiBtn.onclick = async () => {
        aiBtn.disabled = true;
        aiBtn.textContent = '分析中…';
        aiPlaceholder.style.display = 'none';
        aiContent.style.display = '';
        aiContent.innerHTML = '<div class="analysis-loading"><div class="analysis-spinner"></div></div>';

        const profile = store.getDefaultProfile();
        if (!profile || !profile.api_key) {
          aiContent.innerHTML = `<div class="analysis-no-ai">⚙️ 未配置默认 AI 档案。<br>请前往<a href="#" onclick="document.querySelector('[data-tab=settings]').click()" style="color:var(--primary);">设置页</a>添加 AI 档案并设为默认。</div>`;
          aiBtn.disabled = false;
          aiBtn.textContent = '开始AI分析';
          return;
        }

        await streamAIResponse(fundData, scores, lastOverlap, profile);
        aiBtn.style.display = 'none';

        // 保存 AI 文本到历史
        const aiText = aiContent.textContent || '';
        saveToHistory(fundData, scores, aiText);
        renderHistory();
      };
    }
  }, 100);
}

function bindManagerChipEvents() {
  document.querySelectorAll('.mgr-fund-chip').forEach(chip => {
    if (chip.dataset.bound) return;
    chip.dataset.bound = '1';
    chip.onclick = () => {
      selectFund({ code: chip.dataset.code, name: chip.title || chip.dataset.code });
      document.getElementById('analysis-results').scrollIntoView({ behavior: 'smooth' });
      startAnalysis();
    };
  });
}

function buildManagerFundsHTML(fundData) {
  if (!fundData.managerId) return '';

  const mgrData = getManagerFunds(fundData.managerId);
  if (!mgrData || !mgrData.fundCodes || mgrData.fundCodes.length === 0) return '';

  // 过滤掉当前基金（已经在分析了）
  const otherFunds = [];
  for (let i = 0; i < mgrData.fundCodes.length; i++) {
    if (mgrData.fundCodes[i] !== fundData.code) {
      otherFunds.push({
        code: mgrData.fundCodes[i],
        name: mgrData.fundNames[i] || mgrData.fundCodes[i],
      });
    }
  }

  if (otherFunds.length === 0) return '';

  const maxShow = 8;
  const shown = otherFunds.slice(0, maxShow);
  const more = otherFunds.length > maxShow ? ` +${otherFunds.length - maxShow} 只` : '';

  const itemsHTML = shown.map(f => `
    <span class="mgr-fund-chip" data-code="${esc(f.code)}" title="${esc(f.name)}">${esc(f.code)}</span>
  `).join('');

  return `
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">
      <div style="font-size:12px;color:var(--text-soft);margin-bottom:6px;">
        在管基金 <span style="font-weight:600;color:var(--text);">${otherFunds.length} 只</span>（点代码可分析）
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${itemsHTML}${more ? `<span style="font-size:11px;color:var(--text-soft);align-self:center;">${more}</span>` : ''}</div>
      <div style="font-size:10px;color:var(--text-soft);margin-top:4px;">
        ${mgrData.totalReturn ? '累计回报 ' + mgrData.totalReturn + ' · ' : ''}在管规模 ${mgrData.scale || '—'}
      </div>
    </div>
  `;
}

// ---------- AI 分析 ----------

function buildAnalysisPrompt(fundData, scores, overlap) {
  const holdings = store.getHoldings() || [];
  const followList = store.getFollowList() || [];
  let holdingsContext = '';
  if (holdings.length > 0) {
    const totalValue = holdings.reduce((s, h) => s + (parseFloat(h.market_value) || 0), 0);
    holdingsContext = `总持仓 ¥${totalValue.toFixed(0)}，共 ${holdings.length} 只基金。`;
    const matching = holdings.find(h => h.code === fundData.code);
    if (matching) {
      holdingsContext += ` 用户持有该基金 ¥${parseFloat(matching.market_value).toFixed(0)}，占比 ${matching.profit_ratio || '—'}%。`;
    }
  }

  const topNames = (fundData.topHoldings || []).slice(0, 10).join('、') || '无数据';

  // 持仓重合度信息
  let overlapInfo = '';
  if (overlap) {
    overlapInfo = `
**持仓重合度分析：**
- 与用户持仓的重合赛道占比：${overlap.overlapRatio}%
- 重合基金：${overlap.sameSector.map(f => f.code + ' ' + f.name).join('、') || '无'}
- ${overlap.concentrationRisk ? `⚠️ 集中度风险：用户持仓中 ${overlap.overlapRatio}% 已投向该赛道，本基金如追加将进一步提升集中度` : '✅ 该基金赛道与用户现有持仓重合度较低，可起到分散作用'}
- 算法已因重合度对综合评分扣除了 ${overlap.concentrationRisk ? '+' + (overlap.overlapRatio/100*2).toFixed(1) : '0'} 分`;
  }

  return {
    system: `你是一位专业的中国公募基金分析师，精通量化分析、基金经理评估和产业周期判断。

你正在评估一只基金，已有以下客观数据：

**基金概况：**
- 基金名称：${fundData.name} (${fundData.code})
- 基金公司：${fundData.company || '无数据'}
- 基金类型：${fundData.type || '无数据'}
- 投资赛道：${fundData.category}
- 基金规模：${fundData.scale ? fundData.scale.toFixed(1) + '亿元' : '无数据'}
- 管理费率：${fundData.fee != null ? fundData.fee.toFixed(2) + '%' : '无数据'}

**基金经理：**
- 姓名：${fundData.manager || '无数据'}
- 从业年限：${fundData.managerExp ? fundData.managerExp.toFixed(1) + '年' : '—'}
- 任期回报：${fundData.managerYield != null ? (fundData.managerYield>=0?'+':'')+fundData.managerYield.toFixed(2)+'%' : '—'}
- 任期净值增长：${fundData.managerPenav != null ? (fundData.managerPenav>=0?'+':'')+fundData.managerPenav.toFixed(2)+'%' : '—'}
- 管理本基金：${fundData.managerDaysOnFund ? (fundData.managerDaysOnFund/365).toFixed(1) + '年' : '—'}（${fundData.managerStartDate || '—'}起）
${fundData.managerIdea ? '- 投资理念：' + fundData.managerIdea : ''}

**业绩数据：**
- YTD回报：${fundData.ytd != null ? fundData.ytd.toFixed(2) + '%' : '无数据'}
- 近1年回报：${fundData.y1 != null ? fundData.y1.toFixed(2) + '%' : '无数据'}
- 近3年回报：${fundData.y3 != null ? fundData.y3.toFixed(2) + '%' : '无数据'}
- 最大回撤：${fundData.mdd != null ? fundData.mdd.toFixed(2) + '%' : '无数据'}
- Calmar比率：${fundData.calmar != null ? fundData.calmar.toFixed(2) : '无数据'}
- 前五大重仓：${topNames}

三框架评分（已由系统计算，你不能修改这些分数）：
1. 量化框架（Mutual-Fund，权重35%）：${scores.scoreQuant}/5分 —— 基于Calmar比率阈值
2. 质量框架（Investool，权重30%）：${scores.scoreQual}/5分 —— 基于经理经验/规模/费率/回撤控制
3. 郑希框架（权重35%）：${scores.scoreZx}/5分 —— 基于产业周期/赛道景气/投资方法论匹配
→ 综合评分：${scores.composite}/5分 → 调仓建议：${scores.actionLabel}

评分体系说明：
- 量化框架：Calmar>=8得5分，>=4得4分，>=2得3分，>=1得2分，<1得1分。衡量风险调整后收益。
- 质量框架：基准3分；基金经理>=8年+1，<3年-1；费率<=0.6%+1；规模<2亿（清盘风险）-1；最大回撤>-30%+1，<-50%-1。
- 郑希框架：基准3分；基于前十重仓股推断赛道（优先重仓股>基金名称）。AI/芯片/半导体/算力赛道+2分；信息/5G/通信/科技/互联网赛道+1分；其他方向-1分。规模>=5亿且回撤>-50%额外+1分。
${overlapInfo ? `\n${overlapInfo}\n` : ''}
请用专业但易懂的中文，严格基于以上提供的数据（不要编造未提供的信息），输出以下结构化分析：

## 一、基金概况
2-3句话简述基金定位、管理人和当前表现。

## 二、三框架深度解读

### 量化视角
说明该基金的Calmar比率含义，为什么得${scores.scoreQuant}分，量化框架下该基金的风险收益特征。（如果Calmar数据缺失，说明无法评估）

### 质量视角
说明经理经验、规模、费率、回撤控制等维度，为什么得${scores.scoreQual}分，客观评价该基金的质量特征。（如果关键数据缺失，说明数据不足）

### 郑希框架视角
从产业周期和赛道景气角度分析，为什么得${scores.scoreZx}分。分析该基金所处的产业阶段、渗透率水平和中国比较优势。

## 三、风险提示
列出2-3个具体的关键风险点（如有持仓重合度问题，必须作为一个风险点提及）。

## 四、调仓建议
基于综合评分和重合度分析，给出具体操作建议。如存在集中度风险，应明确建议减仓或合并重复持仓。

## 五、基金经理五维评价
基于以下五维框架，对${fundData.manager || '该'}经理进行深度评价：

| 维度 | 考察要点 |
|------|---------|
| 资历 | 从业年限(${fundData.managerExp ? fundData.managerExp.toFixed(1)+'年' : '—'})、管理本基金时长(${fundData.managerDaysOnFund ? (fundData.managerDaysOnFund/365).toFixed(1)+'年' : '—'})、赛道匹配度 |
| 业绩 | 任期回报(${fundData.managerYield != null ? (fundData.managerYield>=0?'+':'')+fundData.managerYield.toFixed(2)+'%' : '—'})、Alpha归因(Beta驱动还是主动选股)、同类排名 |
| 风格稳定性 | 持仓集中度、策略一致性、跨基金表现相关性 |
| 风控 | 最大回撤(${fundData.mdd != null ? fundData.mdd.toFixed(2)+'%' : '—'})、压力测试表现、是否被动型(无法控制回撤) |
| 综合 | 定性总结+关键判断。给出⭐评级(1-5星)并说明该经理在组合中的定位（核心仓位/卫星仓位/观察/回避） |

## 六、一句话总结

---
> ⚠️ 以上分析基于公开数据，不构成投资建议。评分采用多框架加权算法，包含量化指标、经理质量评估和产业周期分析，仅供参考。`,
    user: `请对"${fundData.name}" (${fundData.code})进行多维度分析。\n\n${holdingsContext}`,
  };
}

async function streamAIResponse(fundData, scores, overlap, profile) {
  const aiContent = document.getElementById('analysis-ai-content');
  if (!aiContent) return;

  const messages = buildAnalysisPrompt(fundData, scores, overlap);
  let fullText = '';

  try {
    for await (const chunk of streamChat(
      [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      profile
    )) {
      fullText += chunk;
      aiContent.innerHTML = renderMarkdown(fullText);
      aiContent.scrollTop = aiContent.scrollHeight;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('AI stream error:', e);
    if (fullText) {
      aiContent.innerHTML = renderMarkdown(fullText) +
        `<div class="analysis-error">⚠️ AI 输出中断：${esc(e.message)}</div>`;
    } else {
      aiContent.innerHTML = `<div class="analysis-error">⚠️ AI 分析失败：${esc(e.message)}</div>`;
    }
  }
}

// ---------- 历史记录 ----------

function loadHistory() {
  try {
    analysisHistory = JSON.parse(localStorage.getItem('analysisHistory')) || [];
  } catch {
    analysisHistory = [];
  }
}

function saveToHistory(fundData, scores, aiText) {
  loadHistory();
  const today = new Date().toISOString().slice(0, 10);
  // 去重同一天同一基金；如果有AI文本则更新
  const existing = analysisHistory.find(h => h.code === fundData.code && h.date === today);
  if (existing) {
    if (aiText) existing.aiText = aiText;
    existing.scores = {
      scoreQuant: scores.scoreQuant, scoreQual: scores.scoreQual, scoreZx: scores.scoreZx,
      composite: scores.composite, action: scores.action,
      actionLabel: scores.actionLabel, actionColor: scores.actionColor,
    };
    existing.summary = {
      composite: scores.composite, action: scores.action,
      ytd: fundData.ytd, y1: fundData.y1, mdd: fundData.mdd, calmar: fundData.calmar,
    };
    existing.timestamp = Date.now();
  } else {
    analysisHistory.push({
      code: fundData.code,
      name: fundData.name,
      scores: {
        scoreQuant: scores.scoreQuant, scoreQual: scores.scoreQual, scoreZx: scores.scoreZx,
        composite: scores.composite, action: scores.action,
        actionLabel: scores.actionLabel, actionColor: scores.actionColor,
      },
      timestamp: Date.now(),
      date: today,
      aiText: aiText || '',
      summary: {
        composite: scores.composite, action: scores.action,
        ytd: fundData.ytd, y1: fundData.y1, mdd: fundData.mdd, calmar: fundData.calmar,
      },
    });
  }

  // 保留最近 50 条
  analysisHistory = analysisHistory.slice(-50);
  localStorage.setItem('analysisHistory', JSON.stringify(analysisHistory));
}

function renderHistory() {
  loadHistory();
  const el = document.getElementById('analysis-history-list');
  const countEl = document.getElementById('analysis-history-count');
  if (!el) return;

  const sorted = [...analysisHistory].sort((a, b) => b.timestamp - a.timestamp);

  if (countEl) countEl.textContent = sorted.length ? `(${sorted.length})` : '';

  if (!sorted.length) {
    el.innerHTML = '<div class="empty-hint">暂无分析历史</div>';
    return;
  }

  el.innerHTML = sorted.map(h => {
    const d = new Date(h.timestamp);
    const dateStr = `${d.getFullYear()}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')}`;
    const actionColor = h.scores?.actionColor || 'blue';
    const ytdStr = h.summary.ytd != null ? (h.summary.ytd >= 0 ? '+' : '') + h.summary.ytd.toFixed(1) + '%' : '—';
    const y1Str = h.summary.y1 != null ? (h.summary.y1 >= 0 ? '+' : '') + h.summary.y1.toFixed(1) + '%' : '—';
    const mddStr = h.summary.mdd != null ? h.summary.mdd.toFixed(1) + '%' : '—';
    const calmarStr = h.summary.calmar != null ? h.summary.calmar.toFixed(2) : '—';
    const hasAI = h.aiText && h.aiText.length > 100;
    return `
      <div class="analysis-history-item" data-code="${esc(h.code)}" data-name="${esc(h.name)}" data-ai="${hasAI ? '1' : '0'}">
        <div class="analysis-history-head">
          <span class="analysis-history-name">${esc(h.name)}${hasAI ? ' 🤖' : ''}</span>
          <span class="analysis-history-date">${dateStr}</span>
        </div>
        <div class="analysis-history-row">
          <span>YTD ${ytdStr}</span><span class="his-dot"></span>
          <span>1年 ${y1Str}</span><span class="his-dot"></span>
          <span>回撤 ${mddStr}</span><span class="his-dot"></span>
          <span>Calmar ${calmarStr}</span>
          <span class="analysis-action-${actionColor}">${h.summary.composite}/5 ${h.summary.action}</span>
        </div>
      </div>
    `;
  }).join('');

  // 点击历史项重新分析
  el.querySelectorAll('.analysis-history-item').forEach(item => {
    item.onclick = () => {
      selectFund({ code: item.dataset.code, name: item.dataset.name });

      // 滚动到顶部
      document.getElementById('analysis-results').scrollIntoView({ behavior: 'smooth' });

      startAnalysis();
    };
  });
}

function clearHistory() {
  if (analysisHistory.length === 0) { toast('暂无分析历史'); return; }

  showModal('确认清空', '<p style="text-align:center;">确定要清空所有分析历史吗？此操作不可恢复。</p>', [
    {
      text: '确定清空', cls: 'danger', onClick: (modal, close) => {
        analysisHistory = [];
        localStorage.removeItem('analysisHistory');
        renderHistory();
        toast('分析历史已清空');
        close();
      }
    },
    { text: '取消', cls: '', onClick: (modal, close) => close() }
  ]);
}

// ---------- 工具函数 ----------

function esc(str) {
  if (!str) return '';
  const s = String(str);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
