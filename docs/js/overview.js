// ===== overview.js — 行情总览（横向滚动表格，参考 real-time-fund） =====

import * as store from './store.js';
import { toast, showModal, detectSectorFromHoldings, getDataSource } from './utils.js';

let refreshTimer = null;
let lastUpdateTime = null;
let fundRows = [];
let isRefreshing = false;
let periodCache = {}; // code → { periods, sector, ydayProfit }

// 列配置（可自定顺序和可见性）
const ALL_COLUMNS = [
  { key: 'name', label: '基金名称', visible: true, fixed: true },
  { key: 'sector', label: '关联板块', visible: true },
  { key: 'change', label: '最新涨幅', visible: true },
  { key: 'today', label: '当日收益', visible: true },
  { key: 'est', label: '盘中估值', visible: true },
  { key: 'profit', label: '持有收益', visible: true },
  { key: '1M', label: '近1月', visible: true },
  { key: '3M', label: '近3月', visible: true },
  { key: '6M', label: '近6月', visible: true },
  { key: '1Y', label: '近1年', visible: true },
  { key: 'amount', label: '持仓金额', visible: true },
  { key: 'nav', label: '估算净值', visible: true },
];

function getColumnConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('ovColumns'));
    if (saved && saved.length === ALL_COLUMNS.length) return saved;
  } catch { /* ignore */ }
  return ALL_COLUMNS;
}
function saveColumnConfig(cols) { localStorage.setItem('ovColumns', JSON.stringify(cols)); }

export function initOverview() {
  document.getElementById('btn-refresh-overview').onclick = refreshAll;
  document.getElementById('btn-sort-overview').onclick = openColumnSettings;
  document.getElementById('btn-sort-overview').textContent = '⚙️';
  window.addEventListener('holdings-changed', () => refreshAll());
  renderFilterBar();
  refreshAll();
}

// ===== 统一分类筛选栏（分组 + 赛道） =====
let currentGroupId = 'all';
let currentFilter = '全部';

function renderFilterBar() {
  const el = document.getElementById('overview-filters');
  if (!el) return;
  const groups = store.getGroups();
  const custom = getCustomFilters();
  const allCategories = ['全部', ...Object.keys(BUILTIN_FILTERS), ...custom.map(f => f.name), '其他'];

  let html = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">';

  // 分组（如果有）
  if (groups.length) {
    html += '<span style="font-size:10px;color:var(--text-soft);">分组</span>';
    const opts = [{ id: 'all', name: '全部' }, ...groups];
    html += opts.map(g => `<button class="ov-filter-btn ${g.id===currentGroupId?'active':''}" data-gid="${g.id}">${esc(g.name)}</button>`).join('');
    html += '<span style="color:#cbd5e1;margin:0 4px;">|</span>';
  }

  // 赛道分类
  html += '<span style="font-size:10px;color:var(--text-soft);">赛道</span>';
  html += allCategories.map(name => {
    const isCustom = custom.some(f => f.name === name);
    return `<button class="ov-filter-btn ${name===currentFilter?'active':''}" data-f="${esc(name)}">
      ${esc(name)}${isCustom ? `<span class="del-filter" data-del="${esc(name)}">×</span>` : ''}
    </button>`;
  }).join('');
  html += `<button class="ov-filter-btn add-filter" id="btn-add-filter">+</button>`;

  html += '</div>';
  el.innerHTML = html;

  // 事件绑定
  el.querySelectorAll('[data-gid]').forEach(btn => {
    btn.onclick = () => { currentGroupId = btn.dataset.gid; renderFilterBar(); refreshAll(true); };
  });
  el.querySelectorAll('[data-f]').forEach(btn => {
    btn.onclick = e => {
      if (e.target.classList.contains('del-filter')) {
        const name = e.target.dataset.del;
        saveCustomFilters(getCustomFilters().filter(f => f.name !== name));
        if (currentFilter === name) currentFilter = '全部';
        renderFilterBar(); renderTable(); return;
      }
      currentFilter = btn.dataset.f;
      renderFilterBar(); renderTable();
    };
  });
  const addBtn = el.querySelector('#btn-add-filter');
  if (addBtn) addBtn.onclick = openAddFilter;
}

export function onOverviewVisible() { refreshAll(); startAutoRefresh(); }
export function onOverviewHidden() { stopAutoRefresh(); }

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => { if (isTradeTime()) refreshAll(true); }, 30000);
}
function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}
function isTradeTime() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const t = now.getHours() * 100 + now.getMinutes();
  return t >= 930 && t <= 1500;
}

// ===== 数据获取 =====

// fundgz JSONP 串行队列
let gzQueue = Promise.resolve();
function fetchValuationGz(code) {
  return new Promise((resolve) => {
    gzQueue = gzQueue.then(() => new Promise((done) => {
      const id = '_ovg_' + code;
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); const s = document.getElementById(id); if (s) s.remove(); done(); resolve(v); };
      const timer = setTimeout(() => finish(null), 5000);
      window.jsonpgz = (data) => finish(data || null);
      const script = document.createElement('script');
      script.id = id;
      script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
      script.onerror = () => finish(null);
      document.head.appendChild(script);
    }));
  });
}

// Sina 估值 JSONP
function fetchValuationSina(code) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 8000);
    const cbName = '_ovSina_' + Date.now();
    function cleanup() { clearTimeout(timeout); delete window[cbName]; const s = document.getElementById(cbName); if (s) s.remove(); }
    window[cbName] = (res) => {
      cleanup();
      try {
        const networth = res?.result?.data?.networth;
        if (!networth || !Array.isArray(networth)) { resolve(null); return; }
        const last = networth[networth.length - 1];
        const gRate = parseFloat(last.growthrate || last.growthrate2 || 0);
        resolve({
          fundcode: code, name: '', dwjz: parseFloat(last.pre_nav||last.pre_nav2)||0,
          gszzl: gRate * 100, gztime: last.min_time ? `${last.pre_date} ${last.min_time}`.replace(/:(\d{2}):\d{2}$/, ':$1') : '',
          jzrq: last.pre_date || '',
        });
      } catch { resolve(null); }
    };
    const script = document.createElement('script');
    script.id = cbName;
    script.src = `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=${code}&callback=${cbName}`;
    script.onerror = () => { cleanup(); resolve(null); };
    document.head.appendChild(script);
  });
}

// 按数据源设置获取估值
function fetchValuation(code) {
  const ds = getDataSource();
  return ds === 2 ? fetchValuationSina(code).then(r => r || fetchValuationGz(code)) : fetchValuationGz(code).then(r => r || fetchValuationSina(code));
}

// j5 区间回报 + 板块（CORS fetch）
async function fetchPeriods(code) {
  if (periodCache[code]) return periodCache[code];
  try {
    const resp = await fetch(`https://j5.dfcfw.com/sc/tfs/qt/v2.0.1/${code}.json`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const jdzf = (data.JDZF || {}).Datas || [];

    const map = {};
    for (const item of jdzf) {
      const t = item.title;
      const v = parseFloat(item.syl);
      if (t && !isNaN(v)) map[t] = v;
    }
    const periods = {
      '1M': map['1Y'] != null ? map['1Y'] : null,
      '3M': map['3Y'] != null ? map['3Y'] : null,
      '6M': map['6Y'] != null ? map['6Y'] : null,
      '1Y': map['1N'] != null ? map['1N'] : null,
      'YTD': map['JN'] != null ? map['JN'] : null,
      '1W': null,
    };

    // 前十重仓股 → 关联板块
    let sector = '';
    try {
      const stocks = (data.JJCCNEW?.data?.InverstPosition?.fundStocks || []).slice(0, 10);
      const names = stocks.map(s => s.GPJC || s.GPDM || '').filter(Boolean);
      const sectors = detectSectorFromHoldings(names);
      sector = sectors.length > 0 ? sectors[0] : '';
    } catch { /* ignore */ }

    periodCache[code] = { periods, sector, ydayProfit: null };
    return periodCache[code];
  } catch { return null; }
}

// ===== 主刷新 =====

async function refreshAll(silent) {
  if (isRefreshing) return;
  isRefreshing = true;

  const btn = document.getElementById('btn-refresh-overview');
  const timeEl = document.getElementById('overview-time');
  btn.disabled = true;

  let holdings = store.getHoldings().map(h => store.normalizeHolding(h));
  // 分组筛选
  if (currentGroupId !== 'all') {
    const groupCodes = store.getGroupFundCodes(currentGroupId);
    holdings = holdings.filter(h => groupCodes.includes(h.code));
  }
  if (!holdings.length) {
    document.getElementById('overview-summary').innerHTML = '';
    document.getElementById('overview-list').innerHTML =
      '<div class="empty-hint">暂无持仓，请先在持仓页添加</div>';
    timeEl.textContent = '';
    fundRows = [];
    isRefreshing = false;
    btn.disabled = false;
    return;
  }

  if (!silent) {
    document.getElementById('overview-list').innerHTML = '<div class="empty-hint">正在获取行情…</div>';
  }

  // 并发获取 fundgz + 区间回报
  const codes = [...new Set(holdings.filter(h => h.code).map(h => h.code))];
  const [gzResults, periodResults] = await Promise.all([
    Promise.all(codes.map(c => fetchValuation(c))),
    Promise.all(codes.map(c => fetchPeriods(c).catch(() => null))),
  ]);

  const gzMap = {};
  codes.forEach((c, i) => { if (gzResults[i]) gzMap[c] = gzResults[i]; });
  codes.forEach((c, i) => { if (periodResults[i]) periodCache[c] = periodResults[i]; });

  // 构建行数据
  let totalCost = 0, totalProfit = 0, totalToday = 0;
  const rows = [];

  for (const h of holdings) {
    const gz = h.code ? gzMap[h.code] : null;
    const cost = parseFloat(h.cost) || 0;
    const share = parseFloat(h.share) || 0;

    // 更新估值
    let dwjz = parseFloat(h.dwjz) || 0;
    let gsz = 0, gszzl = 0, gztime = '', jzrq = h.jzrq || '';
    if (gz) {
      dwjz = parseFloat(gz.dwjz) || dwjz;
      gsz = parseFloat(gz.gsz) || 0;
      gszzl = parseFloat(gz.gszzl) || 0;
      gztime = gz.gztime || '';
      jzrq = gz.jzrq || jzrq;
      if (!h.name && gz.name) h.name = gz.name;
    }

    // 计算收益（参考 real-time-fund 逻辑）
    const todayStr = new Date().toISOString().slice(0, 10);
    const hasTodayNav = jzrq === todayStr;
    const lastNav = parseFloat(h.lastNav) || 0;
    const mv = share > 0 && dwjz > 0 ? share * dwjz : (parseFloat(h.market_value) || 0);

    // 当日收益：今天净值已公布→用结算值，未公布→用盘中估值算
    let todayProfit = 0;
    if (hasTodayNav && lastNav > 0 && dwjz > 0) {
      todayProfit = (dwjz - lastNav) * share;
    } else if (!hasTodayNav && share > 0 && gszzl !== 0) {
      todayProfit = mv - mv / (1 + gszzl / 100);
    } else if (lastNav > 0 && dwjz > 0) {
      todayProfit = (dwjz - lastNav) * share;
    } else {
      todayProfit = parseFloat(h.profit_today) || 0;
    }

    const profit = cost > 0 ? mv - cost : (parseFloat(h.profit) || 0);

    // 昨日收益: 从 periodCache 或计算
    const pd = h.code ? periodCache[h.code] : null;
    let ydayProfit = pd?.ydayProfit != null ? pd.ydayProfit : null;

    // 区间回报
    const periods = pd?.periods || {};

    // 关联板块（优先 j5 前十重仓股推断，回退名称关键词）
    let sector = (pd?.sector) || '';
    if (!sector) sector = inferSector(h.name || '');

    totalCost += cost;
    totalProfit += profit;
    totalToday += todayProfit;

    // 回存
    h.dwjz = dwjz; h.gsz = gsz; h.gszzl = gszzl;
    h.gztime = gztime; h.jzrq = jzrq;
    h.market_value = mv; h.profit = profit; h.profit_today = todayProfit;

    rows.push({ ...h, mv, profit, todayProfit, gszzl, dwjz, gsz, jzrq, gztime, share, cost, sector, periods });
  }

  fundRows = rows;

  // ===== 汇总栏 =====
  const totalMV = totalCost + totalProfit;
  const totalRatio = totalCost > 0 ? (totalProfit / totalCost * 100) : 0;
  document.getElementById('overview-summary').innerHTML = `
    <div class="ov-summary-grid">
      <div class="ov-summary-item">
        <div class="ov-summary-label">总市值</div>
        <div class="ov-summary-val">¥${totalMV.toFixed(0)}</div>
      </div>
      <div class="ov-summary-item">
        <div class="ov-summary-label">持仓收益</div>
        <div class="ov-summary-val ${totalProfit>=0?'profit-pos':'profit-neg'}">${totalProfit>=0?'+':''}¥${totalProfit.toFixed(0)}<small>(${totalRatio>=0?'+':''}${totalRatio.toFixed(2)}%)</small></div>
      </div>
      <div class="ov-summary-item">
        <div class="ov-summary-label">今日收益</div>
        <div class="ov-summary-val ${totalToday>=0?'profit-pos':'profit-neg'}">${totalToday>=0?'+':''}¥${totalToday.toFixed(2)}</div>
      </div>
      <div class="ov-summary-item">
        <div class="ov-summary-label">总成本</div>
        <div class="ov-summary-val">¥${totalCost.toFixed(0)}</div>
      </div>
    </div>
  `;

  renderTable();
  lastUpdateTime = new Date();
  timeEl.textContent = `${lastUpdateTime.getHours().toString().padStart(2,'0')}:${lastUpdateTime.getMinutes().toString().padStart(2,'0')} 更新`;
  if (isTradeTime() && !refreshTimer) startAutoRefresh();
  isRefreshing = false;
  btn.disabled = false;
}

// ===== 表格渲染（列可配置） =====

function renderTable() {
  const el = document.getElementById('overview-list');
  if (!fundRows.length) {
    el.innerHTML = '<div class="empty-hint">暂无持仓</div>';
    return;
  }

  // 赛道筛选
  let filtered = fundRows.filter(f => matchFilter(f, currentFilter));
  const cols = getColumnConfig().filter(c => c.visible);
  const totalMV = filtered.reduce((s, f) => s + (f.mv || 0), 0);

  el.innerHTML = `
  <div class="ov-table-wrap">
    <table class="ov-table">
      <thead><tr>
        ${cols.map(c => {
          const isFixed = c.key === 'name' ? ' ov-th-name' : '';
          const isNum = c.key !== 'name' && c.key !== 'sector' ? ' ov-th-num' : '';
          return `<th class="${isFixed}${isNum}">${c.label}</th>`;
        }).join('')}
      </tr></thead>
      <tbody>
        ${filtered.map(f => renderTableRow(f, totalMV, cols)).join('')}
      </tbody>
    </table>
  </div>`;
}

function renderTableRow(f, totalMV, cols) {
  const mv = f.mv || 0;
  const gszzl = f.gszzl || 0;
  const pct = totalMV > 0 ? (mv / totalMV * 100) : 0;
  const ratio = f.cost > 0 ? (f.profit / f.cost * 100) : 0;
  const p = f.periods || {};

  const fmtP = (v) => v != null ? `<span class="${v>=0?'profit-pos':'profit-neg'}">${v>=0?'+':''}${v.toFixed(1)}%</span>` : '<span class="na">—</span>';
  const fmtM = (v, c) => v !== 0 ? `<span class="${c}">${v>=0?'+':''}¥${v.toFixed(2)}</span>` : '<span class="na">—</span>';

  const cellRenderers = {
    name: () => `
      <td class="ov-td-name">
        <div class="ov-td-name-top"><span class="ov-td-code">${esc(f.code)}</span><span class="ov-td-weight">${pct.toFixed(1)}%</span></div>
        <div class="ov-td-name-text">${esc(f.name)}</div>
      </td>`,
    sector: () => `<td><span class="ov-sector-chip">${esc(f.sector || '—')}</span></td>`,
    change: () => `<td class="ov-td-num ${gszzl>=0?'profit-pos':'profit-neg'}">${gszzl!==0?(gszzl>=0?'+':'')+gszzl.toFixed(2)+'%':'—'}</td>`,
    today: () => `<td class="ov-td-num">${fmtM(f.todayProfit, f.todayProfit>=0?'profit-pos':'profit-neg')}</td>`,
    est: () => {
      const ec = f.gszzl >= 0 ? 'profit-pos' : 'profit-neg';
      return `<td class="ov-td-num ${ec}">${f.gszzl!==0?(f.gszzl>=0?'+':'')+f.gszzl.toFixed(2)+'%':'—'}</td>`;
    },
    profit: () => `<td class="ov-td-num ${f.profit>=0?'profit-pos':'profit-neg'}"><div>${f.profit>=0?'+':''}¥${f.profit.toFixed(2)}</div><div class="ov-sub">${ratio>=0?'+':''}${ratio.toFixed(2)}%</div></td>`,
    '1M': () => `<td class="ov-td-num">${fmtP(p['1M'])}</td>`,
    '3M': () => `<td class="ov-td-num">${fmtP(p['3M'])}</td>`,
    '6M': () => `<td class="ov-td-num">${fmtP(p['6M'])}</td>`,
    '1Y': () => `<td class="ov-td-num">${fmtP(p['1Y'])}</td>`,
    amount: () => `<td class="ov-td-num"><div>¥${mv.toFixed(0)}</div><div class="ov-sub">${(f.share||0)>0?(f.share||0).toFixed(0)+'份':''}</div></td>`,
    nav: () => `<td class="ov-td-num"><div>${f.gsz>0?f.gsz.toFixed(4):(f.dwjz>0?f.dwjz.toFixed(4):'—')}</div><div class="ov-sub">${f.gztime?f.gztime.slice(-5):''}</div></td>`,
  };

  return `<tr class="ov-tr">${cols.map(c => (cellRenderers[c.key] || (() => '<td>—</td>'))()).join('')}</tr>`;
}

// ===== 列设置 =====

function openColumnSettings() {
  const cols = getColumnConfig();
  const listHTML = cols.map((c, i) => `
    <div class="col-setting-row" data-idx="${i}">
      <span class="col-drag-handle">⠿</span>
      <label class="settings-toggle" style="flex:1;margin:0;">
        <input type="checkbox" ${c.visible ? 'checked' : ''} ${c.fixed ? 'disabled' : ''} data-idx="${i}">
        <span>${c.label}${c.fixed ? ' (固定)' : ''}</span>
      </label>
      ${!c.fixed ? `<button class="btn" style="font-size:10px;padding:2px 6px;" data-move="${i}" data-dir="up">↑</button><button class="btn" style="font-size:10px;padding:2px 6px;" data-move="${i}" data-dir="down">↓</button>` : ''}
    </div>
  `).join('');

  showModal('列设置', `<div class="col-settings-list">${listHTML}</div><div style="font-size:11px;color:var(--text-soft);margin-top:8px;">可上下调整顺序，取消勾选隐藏列。基金名称固定不可隐藏。</div>`, [
    { text: '重置默认', cls: '', onClick: () => { saveColumnConfig(ALL_COLUMNS); renderTable(); } },
    { text: '确定', cls: 'primary', onClick: (m, close) => {
      const cols = getColumnConfig();
      const rows = m.querySelectorAll('.col-setting-row');
      const newCols = [];
      rows.forEach(row => {
        const idx = parseInt(row.dataset.idx);
        const cb = row.querySelector('input[type=checkbox]');
        if (idx >= 0 && idx < cols.length) {
          newCols.push({ ...cols[idx], visible: cb.checked });
        }
      });
      if (newCols.length) { saveColumnConfig(newCols); renderTable(); }
      close();
    }},
  ]);

  // 绑定上下移动
  setTimeout(() => {
    const mask = document.querySelector('.modal-mask');
    if (!mask) return;
    mask.querySelectorAll('[data-move]').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.move);
        const dir = btn.dataset.dir;
        const cols = getColumnConfig();
        if (cols[idx].fixed) return;
        const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= cols.length) return;
        if (cols[swapIdx].fixed) return;
        [cols[idx], cols[swapIdx]] = [cols[swapIdx], cols[idx]];
        saveColumnConfig(cols);
        openColumnSettings(); // 重新打开刷新UI
        mask.remove();
      };
    });
  }, 100);
}

function inferSector(name) {
  const n = (name || '').toLowerCase();
  if (/人工智能|ai/.test(n)) return 'AI';
  if (/半导体|芯片|集成电路/.test(n)) return '半导体';
  if (/纳斯达克/.test(n)) return '美股';
  if (/5g|通信/.test(n)) return '5G通信';
  if (/机器人/.test(n)) return '机器人';
  if (/信息|科技|互联网/.test(n)) return '科技';
  if (/新能源|光伏/.test(n)) return '新能源';
  if (/医药|医疗/.test(n)) return '医药';
  if (/消费/.test(n)) return '消费';
  if (/混合|灵活/.test(n)) return '混合';
  if (/qdii|全球|海外/.test(n)) return 'QDII';
  return '其他';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
