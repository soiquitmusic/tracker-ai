// ===== compare.js — 持仓对比页 =====

import * as store from './store.js';
import { toast, showModal } from './utils.js';

let isRefreshing = false;
let cachedFundData = new Map();
let currentFilter = '全部';
let currentTypeFilter = '全部'; // 全部 / common / only-me / only-them
let leftSide = '_my_';   // '_my_' 或 followPerson.id
let rightSide = null;     // followPerson.id（自动取第一个）

// 内置筛选分类（与行情页一致）
const BUILTIN_FILTERS = {
  'QDII': ['QDII', 'qdii', '海外', '全球', '美国', '纳斯达克', '标普', '恒生', '港股'],
  '黄金': ['黄金', '有色', '贵金属', '金属'],
  '半导体': ['半导体', '芯片', '集成电路', '科技', '信息技术'],
};

export function initCompare() {
  window.addEventListener('holdings-changed', () => refreshCompare());
  renderPicker();
  renderFilters();
  renderCompare();
}

export function onCompareVisible() {
  renderPicker();
  refreshCompare();
}

// ---------- 人员选择 ----------

function getOptions() {
  const followList = store.getFollowList();
  const opts = [{ id: '_my_', name: '我的持仓' }];
  for (const p of followList) opts.push({ id: p.id, name: p.name || '关注人' });
  return opts;
}

function getHoldingsById(id) {
  if (id === '_my_') return store.getHoldings();
  const followList = store.getFollowList();
  const person = followList.find(p => p.id === id);
  return person?.items || [];
}

function getNameById(id) {
  if (id === '_my_') return '我';
  const followList = store.getFollowList();
  const person = followList.find(p => p.id === id);
  return person?.name || '对方';
}

function renderPicker() {
  const el = document.getElementById('compare-picker');
  const opts = getOptions();
  const followList = store.getFollowList();

  // 初始化 rightSide
  if (!rightSide && followList.length) rightSide = followList[0].id;

  const leftOptions = opts.map(o =>
    `<option value="${o.id}" ${o.id === leftSide ? 'selected' : ''}>${esc(o.name)}</option>`
  ).join('');
  const rightOptions = opts.map(o =>
    `<option value="${o.id}" ${o.id === rightSide ? 'selected' : ''}>${esc(o.name)}</option>`
  ).join('');

  el.innerHTML = `
    <select id="cmp-left-select" class="cmp-select">${leftOptions}</select>
    <span class="cmp-vs">vs</span>
    <select id="cmp-right-select" class="cmp-select">${rightOptions}</select>
    <button id="btn-cmp-go" class="btn icon-btn cmp-go-btn" title="确认">&#x25B6;</button>
    <button id="btn-refresh-compare" class="btn cmp-refresh-btn">刷新</button>
  `;

  document.getElementById('btn-cmp-go').onclick = () => {
    leftSide = document.getElementById('cmp-left-select').value;
    rightSide = document.getElementById('cmp-right-select').value;
    if (leftSide === rightSide) { toast('请选择两个不同的对象'); return; }
    refreshCompare();
  };
  document.getElementById('btn-refresh-compare').onclick = refreshCompare;
}

// ---------- 筛选 ----------

function getCustomFilters() {
  try { return JSON.parse(localStorage.getItem('overviewFilters')) || []; } catch { return []; }
}
function saveCustomFilters(list) { localStorage.setItem('overviewFilters', JSON.stringify(list)); }

function getAllFilters() {
  const custom = getCustomFilters();
  return { ...BUILTIN_FILTERS, ...Object.fromEntries(custom.map(f => [f.name, f.keywords])) };
}

function renderFilters(typeCounts) {
  const el = document.getElementById('compare-filters');
  const custom = getCustomFilters();
  const allNames = ['全部', ...Object.keys(BUILTIN_FILTERS), ...custom.map(f => f.name), '其他'];

  const rightName = getNameById(rightSide);

  // 类型筛选按钮 — 带数量
  const tc = typeCounts || {};
  const totalCount = (tc.common || 0) + (tc['only-me'] || 0) + (tc['only-them'] || 0);
  const typeButtons = [
    { key: '全部', label: `全部 ${totalCount}` },
    { key: 'common', label: `共同 ${tc.common || 0}` },
    { key: 'only-them', label: `仅${esc(rightName)} ${tc['only-them'] || 0}` },
    { key: 'only-me', label: `仅${esc(getNameById(leftSide))} ${tc['only-me'] || 0}` },
  ];
  const typeBar = `<div class="cmp-type-filters">${typeButtons.map(t =>
    `<button class="ov-filter-btn ${t.key === currentTypeFilter ? 'active' : ''}" data-type-filter="${t.key}">${t.label}</button>`
  ).join('')}</div>`;

  // 分类筛选按钮
  const catBar = allNames.map(name => {
    const isCustom = custom.some(f => f.name === name);
    return `<button class="ov-filter-btn ${name === currentFilter ? 'active' : ''}" data-filter="${esc(name)}">
      ${esc(name)}${isCustom ? `<span class="del-filter" data-del="${esc(name)}">×</span>` : ''}
    </button>`;
  }).join('') + `<button class="ov-filter-btn add-filter" id="btn-add-cmp-filter">+</button>`;

  el.innerHTML = typeBar + catBar;

  // 类型筛选事件
  el.querySelectorAll('[data-type-filter]').forEach(btn => {
    btn.onclick = () => {
      currentTypeFilter = btn.dataset.typeFilter;
      renderFilters(typeCounts);
      renderCompare();
    };
  });

  // 分类筛选事件
  el.querySelectorAll('.ov-filter-btn[data-filter]').forEach(btn => {
    btn.onclick = e => {
      if (e.target.classList.contains('del-filter')) {
        const name = e.target.dataset.del;
        const list = getCustomFilters().filter(f => f.name !== name);
        saveCustomFilters(list);
        if (currentFilter === name) currentFilter = '全部';
        renderFilters();
        renderCompare();
        return;
      }
      currentFilter = btn.dataset.filter;
      renderFilters();
      renderCompare();
    };
  });

  const addBtn = el.querySelector('#btn-add-cmp-filter');
  if (addBtn) addBtn.onclick = openAddFilter;
}

function openAddFilter() {
  const bodyHTML = `
    <div class="form-group"><label>分类名称</label><input id="filter-name" placeholder="如：医药"></div>
    <div class="form-group"><label>关键词（逗号分隔）</label><input id="filter-keywords" placeholder="如：医药,医疗,生物"></div>
  `;
  showModal('新增筛选', bodyHTML, [
    { text: '取消', onClick: (_, c) => c() },
    { text: '添加', cls: 'primary', onClick: (m, c) => {
      const name = m.querySelector('#filter-name').value.trim();
      const kw = m.querySelector('#filter-keywords').value.trim();
      if (!name || !kw) { toast('名称和关键词必填'); return; }
      const keywords = kw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
      const list = getCustomFilters();
      if (list.some(f => f.name === name) || BUILTIN_FILTERS[name]) { toast('名称已存在'); return; }
      list.push({ name, keywords });
      saveCustomFilters(list);
      currentFilter = name;
      renderFilters();
      renderCompare();
      c();
    }},
  ]);
}

function matchFilter(fund, filterName) {
  if (filterName === '全部') return true;
  const allFilters = getAllFilters();
  if (filterName === '其他') {
    const allKeywords = Object.values(allFilters).flat();
    return !allKeywords.some(kw => fund.name && fund.name.includes(kw));
  }
  const keywords = allFilters[filterName];
  if (!keywords) return true;
  return keywords.some(kw => fund.name && fund.name.includes(kw));
}

// ---------- JSONP ----------

function fetchFundData(code) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 5000);
    function cleanup() {
      clearTimeout(timeout);
      const s = document.getElementById('_cmp_' + code);
      if (s) s.remove();
    }
    window.jsonpgz = (data) => { cleanup(); resolve(data || null); };
    const script = document.createElement('script');
    script.id = '_cmp_' + code;
    script.src = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(code)}.js?rt=${Date.now()}`;
    script.onerror = () => { cleanup(); resolve(null); };
    document.head.appendChild(script);
  });
}

// ---------- 刷新行情 ----------

async function refreshCompare() {
  if (isRefreshing) return;
  isRefreshing = true;

  const btn = document.getElementById('btn-refresh-compare');
  btn.disabled = true;
  btn.classList.add('spinning');

  try {
    const leftItems = getHoldingsById(leftSide);
    const rightItems = getHoldingsById(rightSide);

    const leftMap = new Map();
    for (const h of leftItems) { if (h.code) leftMap.set(h.code, h); }
    const rightMap = new Map();
    for (const h of rightItems) { if (h.code) rightMap.set(h.code, h); }

    const allCodes = new Set([...leftMap.keys(), ...rightMap.keys()]);

    for (const code of allCodes) {
      const data = await fetchFundData(code);
      if (data) cachedFundData.set(code, data);
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
    isRefreshing = false;
  }

  renderCompare();
}

// ---------- 渲染 ----------

function renderCompare() {
  const summaryEl = document.getElementById('compare-summary');
  const listEl = document.getElementById('compare-list');

  const leftItems = getHoldingsById(leftSide);
  const rightItems = getHoldingsById(rightSide);
  const leftName = getNameById(leftSide);
  const rightName = getNameById(rightSide);

  if (!leftSide || !rightSide) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = '<div class="empty-hint">请选择对比对象</div>';
    return;
  }

  if (!leftItems.length && !rightItems.length) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = `<div class="empty-hint">${esc(leftName)}和${esc(rightName)}都还没有持仓数据</div>`;
    return;
  }

  const leftMap = new Map();
  for (const h of leftItems) { if (h.code) leftMap.set(h.code, h); }
  const rightMap = new Map();
  for (const h of rightItems) { if (h.code) rightMap.set(h.code, h); }

  const allCodes = new Set([...leftMap.keys(), ...rightMap.keys()]);

  const rows = [];

  for (const code of allCodes) {
    const left = leftMap.get(code);
    const right = rightMap.get(code);
    const fd = cachedFundData.get(code);
    const gszzl = fd ? (parseFloat(fd.gszzl) || 0) : null;
    const name = left?.name || right?.name || code;

    const lMV = left ? (parseFloat(left.market_value) || 0) : 0;
    const lPR = left && left.profit_ratio != null ? parseFloat(left.profit_ratio) : null;
    const lTP = gszzl !== null && lMV > 0 ? lMV * gszzl / (100 + gszzl) : 0;

    const rMV = right ? (parseFloat(right.market_value) || 0) : 0;
    const rPR = right && right.profit_ratio != null ? parseFloat(right.profit_ratio) : null;
    const rTP = gszzl !== null && rMV > 0 ? rMV * gszzl / (100 + gszzl) : 0;

    let type = 'common';
    if (!left) type = 'only-them';
    else if (!right) type = 'only-me';

    rows.push({ code, name, type, gszzl, lMV, lPR, lTP, rMV, rPR, rTP });
  }

  // 先按分类筛选，统计各类型数量
  const catFiltered = rows.filter(r => matchFilter(r, currentFilter));
  const typeCounts = {
    'common': catFiltered.filter(r => r.type === 'common').length,
    'only-me': catFiltered.filter(r => r.type === 'only-me').length,
    'only-them': catFiltered.filter(r => r.type === 'only-them').length,
  };
  renderFilters(typeCounts);

  // 再按类型筛选
  let filteredRows = catFiltered;
  if (currentTypeFilter !== '全部') {
    filteredRows = filteredRows.filter(r => r.type === currentTypeFilter);
  }

  // 排序：先按今日涨跌分组（盈利在前，亏损在后），再按绝对值从大到小
  filteredRows.sort((a, b) => {
    const aTP = a.lTP + a.rTP;
    const bTP = b.lTP + b.rTP;
    // 盈利(>=0)排前面，亏损(<0)排后面
    if ((aTP >= 0) !== (bTP >= 0)) return aTP >= 0 ? -1 : 1;
    // 同为盈利：大的在前；同为亏损：绝对值大的在前（即更负的在后面）
    if (aTP >= 0) return bTP - aTP;
    return aTP - bTP;
  });

  // 筛选后摘要
  let fLTotal = 0, fLTotalCost = 0, fLTodayProfit = 0;
  let fRTotal = 0, fRTotalCost = 0, fRTodayProfit = 0;
  let fLCount = 0, fRCount = 0;

  for (const r of filteredRows) {
    fLTotal += r.lMV; fLTodayProfit += r.lTP;
    fRTotal += r.rMV; fRTodayProfit += r.rTP;
    if (r.lMV > 0) fLCount++;
    if (r.rMV > 0) fRCount++;
  }
  for (const r of filteredRows) {
    const left = leftMap.get(r.code);
    const right = rightMap.get(r.code);
    fLTotalCost += left ? (parseFloat(left.cost) || 0) : 0;
    fRTotalCost += right ? (parseFloat(right.cost) || 0) : 0;
  }

  const fLProfit = fLTotal - fLTotalCost;
  const fLProfitRatio = fLTotalCost > 0 ? (fLProfit / fLTotalCost * 100) : 0;
  const fRProfit = fRTotal - fRTotalCost;
  const fRProfitRatio = fRTotalCost > 0 ? (fRProfit / fRTotalCost * 100) : 0;

  const filterLabel = currentFilter !== '全部' ? '（' + esc(currentFilter) + '）' : '';

  summaryEl.innerHTML = `
    <div class="compare-col">
      <div class="compare-col-title">${esc(leftName)}${filterLabel}</div>
      <div class="compare-row"><span>总持有</span><span>¥${fLTotal.toFixed(0)}</span></div>
      <div class="compare-row"><span>总收益</span><span class="${fLProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${fLProfit >= 0 ? '+' : ''}¥${fLProfit.toFixed(0)} (${fLProfitRatio >= 0 ? '+' : ''}${fLProfitRatio.toFixed(1)}%)</span></div>
      <div class="compare-row"><span>今日预估</span><span class="${fLTodayProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${fLTodayProfit >= 0 ? '+' : ''}¥${fLTodayProfit.toFixed(2)}</span></div>
      <div class="compare-row"><span>持仓数</span><span>${fLCount} 只</span></div>
    </div>
    <div class="compare-col">
      <div class="compare-col-title">${esc(rightName)}${filterLabel}</div>
      <div class="compare-row"><span>总持有</span><span>¥${fRTotal.toFixed(0)}</span></div>
      <div class="compare-row"><span>总收益</span><span class="${fRProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${fRProfit >= 0 ? '+' : ''}¥${fRProfit.toFixed(0)} (${fRProfitRatio >= 0 ? '+' : ''}${fRProfitRatio.toFixed(1)}%)</span></div>
      <div class="compare-row"><span>今日预估</span><span class="${fRTodayProfit >= 0 ? 'profit-pos' : 'profit-neg'}">${fRTodayProfit >= 0 ? '+' : ''}¥${fRTodayProfit.toFixed(2)}</span></div>
      <div class="compare-row"><span>持仓数</span><span>${fRCount} 只</span></div>
    </div>
  `;

  if (!filteredRows.length) {
    listEl.innerHTML = '<div class="empty-hint">该分类下暂无基金</div>';
    return;
  }

  listEl.innerHTML = filteredRows.map(r => {
    const badgeClass = r.type === 'common' ? 'common' : 'unique';
    const badgeText = r.type === 'common' ? '共同' : (r.type === 'only-me' ? '仅' + esc(leftName) : '仅' + esc(rightName));
    const badgeStyle = r.type === 'only-them' ? 'background:#fce7f3;color:#be185d;' : '';

    const changeClass = r.gszzl !== null ? (r.gszzl >= 0 ? 'profit-pos' : 'profit-neg') : '';
    const changeText = r.gszzl !== null ? `${r.gszzl >= 0 ? '+' : ''}${r.gszzl.toFixed(2)}%` : '—';

    const lPct = fLTotal > 0 ? (r.lMV / fLTotal * 100) : 0;
    const lPrClass = r.lPR !== null ? (r.lPR >= 0 ? 'profit-pos' : 'profit-neg') : '';
    const lPrText = r.lPR !== null ? `${r.lPR >= 0 ? '+' : ''}${r.lPR.toFixed(2)}%` : '—';

    const rPct = fRTotal > 0 ? (r.rMV / fRTotal * 100) : 0;
    const rPrClass = r.rPR !== null ? (r.rPR >= 0 ? 'profit-pos' : 'profit-neg') : '';
    const rPrText = r.rPR !== null ? `${r.rPR >= 0 ? '+' : ''}${r.rPR.toFixed(2)}%` : '—';

    const leftCol = r.lMV > 0
      ? `<div><span class="cmp-col-label">${esc(leftName)}</span></div>
         <div>¥${r.lMV.toFixed(0)} <span style="color:var(--text-soft);font-size:10px;">(${lPct.toFixed(1)}%)</span></div>
         <div class="${lPrClass}" style="font-size:11px;">收益 ${lPrText}</div>
         <div class="${r.lTP >= 0 ? 'profit-pos' : 'profit-neg'}" style="font-size:11px;">今日 ${r.lTP >= 0 ? '+' : ''}¥${r.lTP.toFixed(2)}</div>`
      : `<div style="color:var(--text-soft);font-size:12px;">—</div>`;

    const rightCol = r.rMV > 0
      ? `<div><span class="cmp-col-label">${esc(rightName)}</span></div>
         <div>¥${r.rMV.toFixed(0)} <span style="color:var(--text-soft);font-size:10px;">(${rPct.toFixed(1)}%)</span></div>
         <div class="${rPrClass}" style="font-size:11px;">收益 ${rPrText}</div>
         <div class="${r.rTP >= 0 ? 'profit-pos' : 'profit-neg'}" style="font-size:11px;">今日 ${r.rTP >= 0 ? '+' : ''}¥${r.rTP.toFixed(2)}</div>`
      : `<div style="color:var(--text-soft);font-size:12px;">—</div>`;

    return `
    <div class="cmp-card">
      <div class="cmp-card-head">
        <span class="diff-badge ${badgeClass}" style="${badgeStyle}">${badgeText}</span>
        <span class="cmp-card-code">${esc(r.code)}</span>
        <span class="cmp-card-name">${esc(r.name)}</span>
        <span class="${changeClass}" style="font-size:11px;white-space:nowrap;">今日${changeText}</span>
      </div>
      <div class="cmp-cols">
        <div>${leftCol}</div>
        <div>${rightCol}</div>
      </div>
    </div>`;
  }).join('');
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
