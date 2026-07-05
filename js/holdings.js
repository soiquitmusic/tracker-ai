// ===== holdings.js — 持仓页 =====

import * as store from './store.js';
import { PRESETS, streamChat } from './providers.js';
import { fileToBase64, compressImage, extractJSON, toast, showModal, searchFund, searchFundByKeyword, getDataSource, fetchWithDispatcher, computeProfitToday, computeCumulative, computeSinceAdded, recordDailyEarnings } from './utils.js';

let holdingSortState = 'none'; // none → desc → asc

const PARSE_PROMPT = `请从这张基金持仓截图中提取所有基金的信息，以 JSON 数组返回。

提取规则：
1. 每个基金包含以下字段：
   - name: 基金名称（如"易方达人工智能ETF联接A"）
   - market_value: 持有金额/市值（元，数字类型，通常是名称下方最大的数字）
   - holding_profit: 持有收益金额（元，数字类型，带正负号，如 6434.64 或 -988.19）
   - profit_ratio: 持有收益率（%，如 18.94 表示 18.94%，负数表示亏损）
   - code: 基金代码（6位数字，如果截图中没有代码留空字符串""）

2. 重要原则：
   - 注意区分"日收益"和"持有收益"，我们要的是"持有收益"（不是日收益）
   - 持有收益金额和持有收益率通常显示在同一列
   - 支付宝格式：名称/金额 | 日收益 | 持有收益 | 累计收益
   - 天天基金格式可能不同，请根据实际截图灵活识别
   - 看不到的字段设为 null，不要猜测或填 0
   - 金额要精确到小数点后两位

只返回纯 JSON 数组，不要包裹在 markdown 代码块中，不要加任何解释文字。`;

export function initHoldings() {
  document.getElementById('btn-add-holding').onclick = e => { e.stopPropagation(); openEditor(null, 'holdings'); };
  document.getElementById('btn-add-follow').onclick = () => openAddFollow();
  document.getElementById('btn-snap-my').onclick = e => { e.stopPropagation(); openSnapshotImport('holdings'); };
  document.getElementById('btn-refresh-holdings').onclick = refreshHoldings;
  document.getElementById('btn-sort-holdings').onclick = toggleHoldingSort;
  document.getElementById('btn-export-text').onclick = openExportText;

  // 我的持仓折叠
  setupCollapse('toggle-my-holdings', 'my-holdings-body');
  // 默认展开
  document.getElementById('my-holdings-body').classList.remove('collapsed');
  document.getElementById('toggle-my-holdings').classList.add('open');

  render();
  renderFollow();
}

function setupCollapse(headId, bodyId) {
  const head = document.getElementById(headId);
  const body = document.getElementById(bodyId);
  head.onclick = e => {
    if (e.target.closest('.btn')) return;
    body.classList.toggle('collapsed');
    head.classList.toggle('open');
  };
}

// ---------- 刷新行情 ----------

// 数据源1: fundgz（天天基金实时估值，通过调度器）
function fetchFundValuationGz(code) {
  return fetchWithDispatcher(code, 5000).then(data => {
    if (!data || !data.fundcode) return null;
    return {
      code: String(data.fundcode).trim(),
      name: data.name || '',
      dwjz: parseFloat(data.dwjz) || 0,
      gsz: parseFloat(data.gsz) || 0,
      gszzl: parseFloat(data.gszzl) || 0,
      gztime: data.gztime || '',
      jzrq: data.jzrq || '',
      source: 'fundgz',
    };
  });
}

// 数据源2: 东方财富 F10 净值历史（用于获取最新净值和上一交易日净值）
function fetchFundF10Nav(code) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 8000);
    const cbName = '_hf10_' + Date.now();

    function cleanup() {
      clearTimeout(timeout);
      delete window[cbName];
      const s = document.getElementById(cbName);
      if (s) s.remove();
    }

    window[cbName] = (data) => {
      cleanup();
      try {
        if (!data || typeof data !== 'string') { resolve(null); return; }
        // 解析 HTML 表格: <tr>...<td>日期</td><td>单位净值</td><td>累计净值</td><td>日增长率</td>...
        const rows = data.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
        const records = [];
        for (const row of rows) {
          const tds = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
          if (tds.length >= 4) {
            const date = tds[0].replace(/<[^>]+>/g, '').trim();
            const nav = parseFloat(tds[1].replace(/<[^>]+>/g, '').trim());
            const zzl = parseFloat(tds[3].replace(/<[^>]+>/g, '').replace('%', '').trim());
            if (date && !isNaN(nav) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
              records.push({ date, nav, zzl: isNaN(zzl) ? 0 : zzl });
            }
          }
        }
        if (records.length >= 2) {
          resolve({
            dwjz: records[0].nav,
            lastNav: records[1].nav,
            jzrq: records[0].date,
            zzl: records[0].zzl,
            yesterdayZzl: records[1].zzl,
            source: 'f10',
          });
        } else if (records.length === 1) {
          resolve({
            dwjz: records[0].nav,
            lastNav: 0,
            jzrq: records[0].date,
            zzl: records[0].zzl,
            source: 'f10',
          });
        } else {
          resolve(null);
        }
      } catch (e) { resolve(null); }
    };

    const script = document.createElement('script');
    script.id = cbName;
    // F10DataApi.aspx 不回调，而是设置 window.apidata
    script.src = `https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${encodeURIComponent(code)}&page=1&per=3&sdate=&edate=`;
    script.onload = () => {
      setTimeout(() => {
        try {
          const apidata = window.apidata;
          if (apidata && apidata.content) {
            const content = apidata.content;
            const rows = content.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
            const records = [];
            for (const row of rows) {
              const tds = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
              if (tds.length >= 4) {
                const date = tds[0].replace(/<[^>]+>/g, '').trim();
                const nav = parseFloat(tds[1].replace(/<[^>]+>/g, '').trim());
                if (date && !isNaN(nav) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
                  const zzl = parseFloat(tds[3].replace(/<[^>]+>/g, '').replace('%', '').trim());
                  records.push({ date, nav, zzl: isNaN(zzl) ? 0 : zzl });
                }
              }
            }
            if (records.length > 0) {
              cleanup();
              resolve({ dwjz: records[0].nav, lastNav: records.length>1?records[1].nav:0, jzrq: records[0].date, zzl: records[0].zzl, source: 'f10' });
            }
          }
        } catch(e) { /* ignore */ }
      }, 100);
    };
    script.onerror = () => { cleanup(); resolve(null); };
    document.head.appendChild(script);
  });
}

// 数据源2: Sina 估值（JSONP，备用）
function fetchFundValuationSina(code) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 8000);
    const cbName = '_sinaV_' + Date.now();
    function cleanup() { clearTimeout(timeout); delete window[cbName]; const s = document.getElementById(cbName); if (s) s.remove(); }
    window[cbName] = (res) => {
      cleanup();
      try {
        if (!res?.result?.data?.networth || !Array.isArray(res.result.data.networth)) { resolve(null); return; }
        const networth = res.result.data.networth;
        const last = networth[networth.length - 1];
        const gRate = parseFloat(last.growthrate || last.growthrate2 || 0);
        const preNav = parseFloat(last.pre_nav || last.pre_nav2 || 0);
        resolve({
          code, name: '', dwjz: preNav || 0, gsz: preNav || 0,
          gszzl: gRate * 100, gztime: last.min_time ? `${last.pre_date} ${last.min_time}`.replace(/:(\d{2}):\d{2}$/, ':$1') : '',
          jzrq: last.pre_date || '', source: 'sina',
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

// 统一估值获取: 按用户数据源设置
async function fetchFundValuation(code) {
  const ds = getDataSource();
  if (ds === 2) {
    const sina = await fetchFundValuationSina(code);
    if (sina && sina.dwjz > 0) return sina;
  }
  // fundgz
  const gz = await fetchFundValuationGz(code);
  if (gz && gz.dwjz > 0) return gz;
  // Sina fallback
  if (ds !== 2) {
    const sina = await fetchFundValuationSina(code);
    if (sina && sina.dwjz > 0) return sina;
  }
  // j5 API fallback (支持 QDII，fundgz 无数据时使用 RZDF)
  const j5 = await fetchFundValuationJ5(code);
  if (j5) return j5;
  // F10 final fallback
  const f10 = await fetchFundF10Nav(code);
  if (f10) return { ...f10, gsz: 0, gszzl: 0, gztime: '' };
  return null;
}

async function fetchFundValuationJ5(code) {
  try {
    const r = await fetch('https://j5.dfcfw.com/sc/tfs/qt/v2.0.1/' + code + '.json');
    if (!r.ok) return null;
    const d = await r.json();
    const jf = (d.JJFX || {}).Datas || {};
    const rzdf = parseFloat(jf.RZDF) || 0;
    const dwjz = parseFloat(jf.DWJZ) || 0;
    if (!dwjz) return null;
    return {
      code, name: jf.SHORTNAME || '',
      dwjz, gsz: 0, gszzl: rzdf,
      gztime: jf.FSRQ || '', jzrq: jf.FSRQ || '',
      lastNav: 0, zzl: rzdf, source: 'j5',
    };
  } catch { return null; }
}

// 使用 asyncPool 控制并发（最多3个同时请求）
async function asyncPool(limit, items, fn) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function refreshHoldings() {
  const btn = document.getElementById('btn-refresh-holdings');
  btn.disabled = true;
  btn.classList.add('spinning');
  let updated = 0;

  const allCodes = [];
  // 收集我的持仓
  const myHoldings = store.getHoldings();
  const myMap = new Map(myHoldings.map(h => [h.code, h]));
  allCodes.push(...myHoldings.filter(h => h.code).map(h => h.code));

  // 收集关注持仓
  const followList = store.getFollowList();
  for (const person of followList) {
    for (const h of (person.items || [])) {
      if (h.code && !allCodes.includes(h.code)) allCodes.push(h.code);
    }
  }

  // 并发刷新所有唯一基金代码
  const cache = {}; // code → valuation data
  await asyncPool(3, allCodes, async (code) => {
    const data = await fetchFundValuation(code);
    if (data) cache[code] = data;
  });

  // 更新我的持仓
  for (const h of myHoldings) {
    if (!h.code) continue;
    const data = cache[h.code];
    if (!data) continue;

    // 补全名称
    if (data.name && !h.name) h.name = data.name;

    h.dwjz = data.dwjz || 0;
    h.lastNav = data.lastNav || 0;
    h.jzrq = data.jzrq || '';
    h.gsz = data.gsz || 0;
    h.gszzl = data.gszzl || 0;
    h.gztime = data.gztime || '';
    h.zzl = data.zzl || 0;

    // 自动补全份额（如果还没有）
    if (!h.share && h.cost > 0 && data.dwjz > 0) {
      const costNav = h.cost_nav || parseFloat(h.cost_nav) || 0;
      if (costNav > 0) {
        h.share = +(parseFloat(h.cost) / costNav).toFixed(2);
      }
    }

    // 计算市值和收益
    const share = parseFloat(h.share) || 0;
    const dwjz = parseFloat(h.dwjz) || 0;
    const cost = parseFloat(h.cost) || 0;

    if (share > 0 && dwjz > 0) {
      h.market_value = +(share * dwjz).toFixed(2);
      if (cost > 0) {
        h.profit = +(h.market_value - cost).toFixed(2);
        h.profit_ratio = +((h.market_value - cost) / cost * 100).toFixed(2);
      }
      // 今日收益
      const lastNav = parseFloat(h.lastNav) || 0;
      h.profit_today = computeProfitToday(h);
    }

    store.saveHolding(h);
    updated++;
  }

  // 更新关注持仓
  for (const person of followList) {
    let personUpdated = false;
    for (const h of (person.items || [])) {
      if (!h.code) continue;
      const data = cache[h.code];
      if (!data) continue;

      if (data.name && !h.name) h.name = data.name;
      h.dwjz = data.dwjz || 0;
      h.lastNav = data.lastNav || 0;
      h.jzrq = data.jzrq || '';
      h.gsz = data.gsz || 0;
      h.gszzl = data.gszzl || 0;
      h.gztime = data.gztime || '';
      h.zzl = data.zzl || 0;

      const share = parseFloat(h.share) || 0;
      const dwjz = parseFloat(h.dwjz) || 0;
      const cost = parseFloat(h.cost) || 0;

      if (share > 0 && dwjz > 0) {
        h.market_value = +(share * dwjz).toFixed(2);
        if (cost > 0) {
          h.profit = +(h.market_value - cost).toFixed(2);
          h.profit_ratio = +((h.market_value - cost) / cost * 100).toFixed(2);
        }
        const lastNav = parseFloat(h.lastNav) || 0;
        h.profit_today = computeProfitToday(h);
      }
      personUpdated = true;
      updated++;
    }
    if (personUpdated) store.saveFollowPerson(person);
  }

  btn.disabled = false;
  btn.classList.remove('spinning');
  render();
  renderFollow();
  toast(updated > 0 ? `已更新 ${updated} 只基金行情` : '未获取到行情数据');
}

// ---------- 我的持仓渲染 ----------

function toggleHoldingSort() {
  const btn = document.getElementById('btn-sort-holdings');
  if (holdingSortState === 'none') holdingSortState = 'desc';
  else if (holdingSortState === 'desc') holdingSortState = 'asc';
  else holdingSortState = 'none';
  btn.classList.remove('ov-sort-btn', 'desc', 'asc');
  if (holdingSortState !== 'none') {
    btn.classList.add('ov-sort-btn', holdingSortState);
  }
  render();
}

function sortHoldings(list) {
  if (holdingSortState === 'none') return list;
  const sorted = [...list].sort((a, b) => {
    const aProfit = parseFloat(a.profit || 0);
    const bProfit = parseFloat(b.profit || 0);
    return holdingSortState === 'desc' ? bProfit - aProfit : aProfit - bProfit;
  });
  return sorted;
}

function render() {
  const list = sortHoldings(store.getHoldings());
  const el = document.getElementById('holdings-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty-hint">暂无持仓，点击「+ 添加」或「📷 导入」</div>';
    return;
  }

  // 汇总
  const totalCost = list.reduce((s, h) => s + (parseFloat(h.cost) || 0), 0);
  const totalProfit = list.reduce((s, h) => s + (parseFloat(h.profit) || 0), 0);
  const totalToday = list.reduce((s, h) => s + (parseFloat(h.profit_today) || 0), 0);
  const totalRatio = totalCost > 0 ? (totalProfit / totalCost * 100) : 0;

  const summaryHTML = `<div class="holdings-summary">
    <div class="hs-item"><span class="hs-label">总成本</span><span class="hs-val">¥${totalCost.toFixed(0)}</span></div>
    <div class="hs-item"><span class="hs-label">持仓收益</span><span class="hs-val ${totalProfit>=0?'profit-pos':'profit-neg'}">${totalProfit>=0?'+':''}¥${totalProfit.toFixed(0)} <small>(${totalRatio>=0?'+':''}${totalRatio.toFixed(2)}%)</small></span></div>
    ${totalToday !== 0 ? `<div class="hs-item"><span class="hs-label">今日收益</span><span class="hs-val ${totalToday>=0?'profit-pos':'profit-neg'}">${totalToday>=0?'+':''}¥${totalToday.toFixed(2)}</span></div>` : ''}
  </div>`;

  el.innerHTML = summaryHTML + list.map(h => renderHoldingCard(h, 'holdings')).join('');
  bindCardActions(el, 'holdings');
}

function renderHoldingCard(h, target, diffInfo = null) {
  const share = parseFloat(h.share) || 0;
  const dwjz = parseFloat(h.dwjz) || 0;
  const cost = parseFloat(h.cost) || 0;
  const profit = parseFloat(h.profit) || 0;
  const profit_today = parseFloat(h.profit_today) || 0;
  const gszzl = parseFloat(h.gszzl) || 0;

  const mv = h.market_value ? `¥${Number(h.market_value).toFixed(2)}` : '—';
  const pr = h.profit_ratio != null && h.profit_ratio !== '' ? parseFloat(h.profit_ratio) : null;
  const prText = pr !== null ? `${pr >= 0 ? '+' : ''}${pr.toFixed(2)}%` : '—';
  const prClass = pr !== null ? (pr >= 0 ? 'profit-pos' : 'profit-neg') : '';

  const navText = dwjz > 0 ? dwjz.toFixed(4) : '—';
  const gsInfo = gszzl !== 0 ? ` 估值: <span class="${gszzl>=0?'profit-pos':'profit-neg'}">${gszzl>=0?'+':''}${gszzl.toFixed(2)}%</span>` : '';
  const gzTimeText = h.gztime ? ` <span style="font-size:10px;color:var(--text-soft);">${h.gztime.slice(-5)}</span>` : '';

  const shareText = share > 0 ? `${share.toFixed(2)} 份` : '—';
  const costNavText = share > 0 && cost > 0 ? `成本净值 ${(cost/share).toFixed(4)}` : '';
  const todayText = profit_today !== 0 ? ` 今日: <span class="${profit_today>=0?'profit-pos':'profit-neg'}">${profit_today>=0?'+':''}¥${profit_today.toFixed(2)}</span>` : '';

  let badgeHTML = '';
  if (diffInfo) {
    if (diffInfo.type === 'common') {
      badgeHTML = '<span class="diff-badge common">共同</span>';
    } else {
      badgeHTML = '<span class="diff-badge unique">独有</span>';
    }
  }

  return `
  <div class="holding-card">
    <div class="holding-info">
      <div class="holding-code">${badgeHTML}${esc(h.code)}</div>
      <div class="holding-name">${esc(h.name)}</div>
      <div class="holding-detail">
        <div>净值: ${navText}${gsInfo}${gzTimeText}</div>
        <div>份额: ${shareText} · 市值: ${mv}</div>
        <div>成本: ${cost>0 ? '¥'+cost.toFixed(2) : '—'}${costNavText ? ' ('+costNavText+')' : ''}${computeSinceAdded(h) !== null ? ' · <span class="'+(computeSinceAdded(h)>=0?'profit-pos':'profit-neg')+'">自添加'+(computeSinceAdded(h)>=0?'+':'')+computeSinceAdded(h).toFixed(2)+'%</span>' : ''}</div>
        <div>持仓收益: <span class="${prClass}">${prText}</span> · 累计: <span class="${computeCumulative(h)>=0?'profit-pos':'profit-neg'}">${computeCumulative(h)>=0?'+':''}¥${computeCumulative(h).toFixed(2)}</span>${todayText}${h.note ? ' · '+esc(h.note) : ''}</div>
      </div>
    </div>
    <div class="holding-actions">
      <button class="btn icon-btn" data-action="edit" data-id="${h.id}" data-target="${target}" title="编辑">&#9998;</button>
      <button class="btn icon-btn" data-action="delete" data-id="${h.id}" data-target="${target}" title="删除" style="color:var(--danger);">&#128465;</button>
    </div>
  </div>`;
}

function bindCardActions(el, target, personId) {
  el.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.onclick = () => {
      if (target === 'holdings') {
        const h = store.getHoldings().find(x => x.id === btn.dataset.id);
        if (h) openEditor(h, 'holdings');
      } else {
        const person = store.getFollowList().find(p => p.id === personId);
        const h = person?.items?.find(x => x.id === btn.dataset.id);
        if (h) openEditor(h, 'follow', personId);
      }
    };
  });
  el.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.onclick = () => {
      if (!confirm('确认删除？')) return;
      if (target === 'holdings') {
        store.deleteHolding(btn.dataset.id);
        render();
      } else {
        store.deleteFollowItem(personId, btn.dataset.id);
        renderFollow();
      }
      toast('已删除');
      window.dispatchEvent(new Event('holdings-changed'));
    };
  });
}

// ---------- 关注持仓渲染 ----------

function renderFollow() {
  const list = store.getFollowList();
  const container = document.getElementById('follow-sections');
  if (!list.length) {
    container.innerHTML = '';
    return;
  }

  // 构建我的持仓 code → holding 映射
  const myHoldings = store.getHoldings();
  const myMap = new Map(myHoldings.filter(h => h.code).map(h => [h.code, h]));

  container.innerHTML = list.map(person => {
    const items = person.items || [];

    // diff 计算
    const personCodes = new Set(items.filter(h => h.code).map(h => h.code));
    const commonCount = items.filter(h => h.code && myMap.has(h.code)).length;
    const onlyThemCount = items.filter(h => !h.code || !myMap.has(h.code)).length;
    const onlyMeCount = [...myMap.keys()].filter(c => !personCodes.has(c)).length;

    const summaryHTML = items.length ? `<div class="diff-summary">
      <span class="diff-common">共同 ${commonCount} 只</span>
      <span class="diff-only-them">仅${esc(person.name)} ${onlyThemCount} 只</span>
      <span class="diff-only-me">仅我 ${onlyMeCount} 只</span>
    </div>` : '';

    const cardsHTML = items.length
      ? items.map(h => {
          const mine = h.code ? myMap.get(h.code) : null;
          const diffInfo = mine ? { type: 'common', myHolding: mine } : { type: 'unique' };
          return renderHoldingCard(h, 'follow', diffInfo);
        }).join('')
      : '<div class="empty-hint" style="padding:8px;">暂无持仓数据</div>';

    return `
    <div class="section-collapse" data-person-id="${person.id}">
      <div class="section-collapse-head" data-toggle-person="${person.id}">
        <span class="collapse-label"><span class="collapse-arrow">▾</span> ${esc(person.name)}</span>
        <div class="collapse-actions" onclick="event.stopPropagation()">
          <button class="btn" data-action="snap-person" data-pid="${person.id}">📷</button>
          <button class="btn" data-action="add-fund" data-pid="${person.id}">+ 基金</button>
          <button class="btn" data-action="edit-person" data-pid="${person.id}">改名</button>
          <button class="btn danger" data-action="del-person" data-pid="${person.id}">删除</button>
        </div>
      </div>
      <div class="section-collapse-body collapsed" data-body-person="${person.id}">
        ${summaryHTML}
        <div class="holdings-list">${cardsHTML}</div>
      </div>
    </div>`;
  }).join('');

  // 绑定每个人的折叠 toggle
  container.querySelectorAll('[data-toggle-person]').forEach(head => {
    const pid = head.dataset.togglePerson;
    const body = container.querySelector(`[data-body-person="${pid}"]`);
    head.onclick = e => {
      if (e.target.closest('.collapse-actions')) return;
      body.classList.toggle('collapsed');
      head.classList.toggle('open');
    };
  });

  // 绑定📷导入
  container.querySelectorAll('[data-action="snap-person"]').forEach(btn => {
    btn.onclick = () => openSnapshotImport('follow:' + btn.dataset.pid);
  });

  // 绑定添加基金
  container.querySelectorAll('[data-action="add-fund"]').forEach(btn => {
    btn.onclick = () => openEditor(null, 'follow', btn.dataset.pid);
  });

  // 绑定改名
  container.querySelectorAll('[data-action="edit-person"]').forEach(btn => {
    btn.onclick = () => {
      const person = store.getFollowList().find(p => p.id === btn.dataset.pid);
      const name = prompt('修改名称', person?.name || '');
      if (name && name.trim()) {
        store.saveFollowPerson({ ...person, name: name.trim() });
        renderFollow();
      }
    };
  });

  // 绑定删除
  container.querySelectorAll('[data-action="del-person"]').forEach(btn => {
    btn.onclick = () => {
      if (!confirm('确认删除此人及其所有持仓数据？')) return;
      store.deleteFollowPerson(btn.dataset.pid);
      renderFollow();
      toast('已删除');
    };
  });

  // 绑定每个人内部的基金卡片操作
  container.querySelectorAll('.section-collapse[data-person-id]').forEach(secEl => {
    const pid = secEl.dataset.personId;
    const itemsEl = secEl.querySelector('.holdings-list');
    bindCardActions(itemsEl, 'follow', pid);
  });
}

function openAddFollow() {
  const name = prompt('输入关注对象的名称');
  if (!name || !name.trim()) return;
  store.saveFollowPerson({ name: name.trim() });
  renderFollow();
  toast('已添加');
}

// ---------- 编辑器 ----------

function openEditor(existing, target, personId) {
  const isEdit = !!existing;
  const h = existing || { code: '', name: '', share: '', cost_nav: '', cost: '', note: '' };

  // 默认进入份额模式（如果有份额数据）或金额模式
  const hasShare = parseFloat(h.share) > 0;
  const defaultMode = hasShare ? 'share' : 'amount';

  const bodyHTML = `
    <div class="editor-mode-tabs">
      <button class="editor-mode-tab ${defaultMode==='amount'?'active':''}" data-mode="amount">金额模式</button>
      <button class="editor-mode-tab ${defaultMode==='share'?'active':''}" data-mode="share">份额模式</button>
    </div>
    <div class="form-group">
      <label>基金代码</label>
      <div style="display:flex;gap:8px;">
        <input id="h-code" value="${esc(h.code)}" placeholder="如 000001" style="flex:1;">
        <button id="h-search" class="btn" type="button">搜索</button>
      </div>
    </div>
    <div class="form-group"><label>基金名称</label><input id="h-name" value="${esc(h.name)}" placeholder="输入代码后自动搜索"></div>
    <div id="h-nav-info" style="font-size:11px;color:var(--text-soft);margin-bottom:8px;display:none;"></div>
    <!-- 金额模式字段 -->
    <div id="mode-amount" ${defaultMode==='share'?'style="display:none;"':''}>
      <div class="form-group"><label>持有金额（元）</label><input id="h-mv" type="number" step="0.01" value="${h.market_value||''}"></div>
      <div class="form-group"><label>持有收益率（%）</label><input id="h-pr" type="number" step="0.01" value="${h.profit_ratio!=null&&h.profit_ratio!==''?h.profit_ratio:''}"></div>
      <div class="form-group"><label>成本金额（元）<span style="font-size:11px;color:var(--text-soft);"> 自动 = 金额/(1+收益率%)</span></label><input id="h-cost-amt" value="${h.cost||''}" style="background:var(--bg);" readonly></div>
      <div class="form-group"><label>份额（份）<span style="font-size:11px;color:var(--text-soft);"> 自动 = 金额/最新净值</span></label><input id="h-share-amt" value="${parseFloat(h.share)>0?h.share:''}" style="background:var(--bg);" readonly></div>
    </div>
    <!-- 份额模式字段 -->
    <div id="mode-share" ${defaultMode==='amount'?'style="display:none;"':''}>
      <div class="form-group"><label>持有份额（份）</label><input id="h-share" type="number" step="0.01" value="${parseFloat(h.share)>0?parseFloat(h.share).toFixed(2):''}"></div>
      <div class="form-group"><label>成本净值<span style="font-size:11px;color:var(--text-soft);"> 买入时单位净值</span></label><input id="h-cost-nav" type="number" step="0.0001" value="${parseFloat(h.cost_nav)>0?parseFloat(h.cost_nav).toFixed(4):''}" placeholder="买入时的单位净值"></div>
      <div class="form-group"><label>成本金额（元）<span style="font-size:11px;color:var(--text-soft);"> 自动 = 份额×成本净值</span></label><input id="h-cost-share" value="${parseFloat(h.cost)>0?parseFloat(h.cost).toFixed(2):''}" style="background:var(--bg);" readonly></div>
      <div class="form-group"><label>当前市值（元）<span style="font-size:11px;color:var(--text-soft);"> 自动 = 份额×最新净值</span></label><input id="h-mv-share" value="${h.market_value||''}" style="background:var(--bg);" readonly></div>
    </div>
    <div class="form-group"><label>备注</label><input id="h-note" value="${esc(h.note||'')}"></div>
    <!-- 交易记录 -->
    <div class="form-group" style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;">
      <label style="display:flex;justify-content:space-between;align-items:center;">
        交易记录（不同时间买入/卖出）
        <button id="h-add-trade" class="btn" type="button" style="font-size:11px;padding:2px 8px;">+ 添加</button>
      </label>
      <div id="h-trades-list" style="font-size:11px;color:var(--text-soft);margin-top:4px;">
        ${renderTradesHTML(existing?.trades || [])}
      </div>
      <div id="h-trade-form" style="display:none;margin-top:8px;padding:8px;background:var(--bg);border-radius:6px;"></div>
      <div id="h-trade-total" style="font-size:11px;color:var(--text);margin-top:4px;font-weight:500;">
        ${renderTradeSummary(existing)}
      </div>
    </div>
  `;

  const title = target === 'follow'
    ? (isEdit ? '编辑关注基金' : '添加关注基金')
    : (isEdit ? '编辑持仓' : '添加持仓');

  let currentNav = parseFloat(h.dwjz) || 0; // 当前净值（编辑期间不变）

  const { modal, close } = showModal(title, bodyHTML, [
    { text: '取消', onClick: (_, c) => c() },
    { text: '保存', cls: 'primary', onClick: (m, c) => {
      const mode = m.querySelector('.editor-mode-tab.active')?.dataset?.mode || 'amount';
      const data = {
        id: existing?.id,
        code: m.querySelector('#h-code').value.trim(),
        name: m.querySelector('#h-name').value.trim(),
        note: m.querySelector('#h-note').value.trim(),
        dwjz: currentNav,
        lastNav: existing?.lastNav || 0,
        jzrq: existing?.jzrq || '',
        gsz: existing?.gsz || 0,
        gszzl: existing?.gszzl || 0,
        gztime: existing?.gztime || '',
        trades: h.trades || existing?.trades || [],
      };

      // 如果有交易记录，从交易记录反算份额和成本
      if (data.trades && data.trades.length > 0) {
        let totalShare = 0, totalCost = 0;
        for (const t of data.trades) {
          const s = parseFloat(t.share) || 0;
          const p = parseFloat(t.price) || 0;
          if (t.type !== 'sell') { totalShare += s; totalCost += s * p; }
          else { totalShare -= s; totalCost -= s * (totalShare > 0 ? totalCost/(totalShare+s) : 0); }
        }
        data.share = Math.max(0, +totalShare.toFixed(2));
        data.cost = +totalCost.toFixed(2);
        data.cost_nav = data.share > 0 ? +(data.cost / data.share).toFixed(4) : 0;
        data.market_value = currentNav > 0 ? +(data.share * currentNav).toFixed(2) : 0;
        data.profit = data.cost > 0 ? +(data.market_value - data.cost).toFixed(2) : 0;
        data.profit_ratio = data.cost > 0 ? +((data.market_value - data.cost) / data.cost * 100).toFixed(2) : 0;
      }

      if (mode === 'amount') {
        const mv = parseFloat(m.querySelector('#h-mv').value) || 0;
        const pr = parseFloat(m.querySelector('#h-pr').value) || 0;
        data.market_value = mv;
        data.profit_ratio = pr;
        data.cost = mv > 0 ? +(mv / (1 + pr / 100)).toFixed(2) : 0;
        data.share = mv > 0 && currentNav > 0 ? +(mv / currentNav).toFixed(2) : (parseFloat(h.share) || 0);
        data.cost_nav = data.share > 0 && data.cost > 0 ? +(data.cost / data.share).toFixed(4) : 0;
        data.profit = data.cost > 0 ? +(data.market_value - data.cost).toFixed(2) : 0;
      } else {
        data.share = parseFloat(m.querySelector('#h-share').value) || 0;
        data.cost_nav = parseFloat(m.querySelector('#h-cost-nav').value) || 0;
        data.cost = +(data.share * data.cost_nav).toFixed(2);
        data.market_value = currentNav > 0 ? +(data.share * currentNav).toFixed(2) : 0;
        data.profit = data.cost > 0 ? +(data.market_value - data.cost).toFixed(2) : 0;
        data.profit_ratio = data.cost > 0 ? +((data.market_value - data.cost) / data.cost * 100).toFixed(2) : 0;
      }

      if (!data.code || !data.name) { toast('代码和名称必填'); return; }
      if (!isEdit && currentNav > 0) {
        data.addBaseNav = currentNav;
        data.addBaseDate = new Date().toISOString().slice(0, 10);
      }
      if (target === 'follow') {
        store.saveFollowItem(personId, data);
        renderFollow();
      } else {
        store.saveHolding(data);
        render();
      }
      c();
      toast(isEdit ? '已更新' : '已添加');
      window.dispatchEvent(new Event('holdings-changed'));
    }},
  ]);

  // 模式切换
  modal.querySelectorAll('.editor-mode-tab').forEach(tab => {
    tab.onclick = () => {
      modal.querySelectorAll('.editor-mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.mode;
      modal.querySelector('#mode-amount').style.display = mode === 'amount' ? '' : 'none';
      modal.querySelector('#mode-share').style.display = mode === 'share' ? '' : 'none';
      // 同步计算
      if (mode === 'amount') calcAmount();
      else calcShare();
    };
  });

  // 金额模式：自动计算成本 = 金额 / (1 + 收益率%)
  function calcAmount() {
    if (!modal) return;
    const mv = parseFloat(modal.querySelector('#h-mv')?.value) || 0;
    const pr = parseFloat(modal.querySelector('#h-pr')?.value) || 0;
    const costInput = modal.querySelector('#h-cost-amt');
    const shareInput = modal.querySelector('#h-share-amt');
    const mvShareInput = modal.querySelector('#h-mv-share');
    if (mv > 0) {
      const cost = mv / (1 + pr / 100);
      if (costInput) costInput.value = cost.toFixed(2);
      if (currentNav > 0) {
        const share = mv / currentNav;
        if (shareInput) shareInput.value = share.toFixed(2);
        if (mvShareInput) mvShareInput.value = mv.toFixed(2);
      }
    } else {
      if (costInput) costInput.value = '';
      if (shareInput) shareInput.value = '';
    }
  }

  modal.querySelector('#h-mv')?.addEventListener('input', calcAmount);
  modal.querySelector('#h-pr')?.addEventListener('input', calcAmount);

  // 份额模式：自动计算成本 = 份额 × 成本净值
  function calcShare() {
    if (!modal) return;
    const share = parseFloat(modal.querySelector('#h-share')?.value) || 0;
    const costNav = parseFloat(modal.querySelector('#h-cost-nav')?.value) || 0;
    const costInput = modal.querySelector('#h-cost-share');
    const mvInput = modal.querySelector('#h-mv-share');
    const mvAmtInput = modal.querySelector('#h-mv');
    if (share > 0 && costNav > 0) {
      if (costInput) costInput.value = (share * costNav).toFixed(2);
    } else {
      if (costInput) costInput.value = '';
    }
    if (share > 0 && currentNav > 0) {
      if (mvInput) mvInput.value = (share * currentNav).toFixed(2);
      if (mvAmtInput) mvAmtInput.value = (share * currentNav).toFixed(2);
    } else {
      if (mvInput) mvInput.value = '';
    }
  }

  modal.querySelector('#h-share')?.addEventListener('input', calcShare);
  modal.querySelector('#h-cost-nav')?.addEventListener('input', calcShare);

  // 搜索基金名称
  // 获取最新净值：fundgz + F10双源，取日期最新的
  async function fetchLatestNav(code) {
    const [gz, f10] = await Promise.all([
      fetchFundValuationGz(code),
      fetchFundF10Nav(code),
    ]);

    // 取 dwjz 正常且日期更新的那个
    let best = null;
    if (gz && gz.dwjz > 0) best = { ...gz, source: 'fundgz' };
    if (f10 && f10.dwjz > 0) {
      if (!best || (f10.jzrq && (!best.jzrq || f10.jzrq >= best.jzrq))) {
        best = { ...f10, source: 'f10' };
      }
    }
    return best;
  }

  async function doSearch() {
    const code = modal.querySelector('#h-code').value.trim();
    if (!code) return;
    const nameInput = modal.querySelector('#h-name');
    const navInfo = modal.querySelector('#h-nav-info');
    nameInput.value = '搜索中…';
    const result = await searchFund(code);
    if (result && result.name) {
      nameInput.value = result.name;
      // 获取当前净值（fundgz + pingzhongdata双源）
      const navData = await fetchLatestNav(code);
      if (navData && navData.dwjz > 0) {
        currentNav = navData.dwjz;
        if (navInfo) {
          navInfo.style.display = '';
          navInfo.textContent = `当前净值：${navData.dwjz.toFixed(4)} (${navData.jzrq || ''}${navData.source ? ' · 来源:'+navData.source : ''})`;
        }
        calcAmount();
        calcShare();
      } else if (navInfo) {
        navInfo.style.display = '';
        navInfo.textContent = '⚠️ 未能获取最新净值，请手动输入份额和成本净值';
      }
    } else {
      nameInput.value = '';
      toast('未找到该基金，请手动填写名称');
    }
  }

  const searchBtn = modal.querySelector('#h-search');
  if (searchBtn) searchBtn.onclick = doSearch;
  modal.querySelector('#h-code')?.addEventListener('blur', () => {
    const nameInput = modal.querySelector('#h-name');
    if (!nameInput.value || nameInput.value === '搜索中…') {
      doSearch();
    }
  });

  // 交易记录：添加按钮
  const addTradeBtn = modal.querySelector('#h-add-trade');
  if (addTradeBtn) addTradeBtn.onclick = () => showTradeForm(modal, h);
  // 删除交易
  modal.querySelector('#h-trades-list')?.addEventListener('click', e => {
    const delBtn = e.target.closest('[data-del-trade]');
    if (!delBtn) return;
    const tradeId = delBtn.dataset.delTrade;
    h.trades = (h.trades || []).filter(t => t.id !== tradeId);
    modal.querySelector('#h-trades-list').innerHTML = renderTradesHTML(h.trades);
    modal.querySelector('#h-trade-total').innerHTML = renderTradeSummary(h);
  });

  // 如果编辑已有基金，显示净值信息
  if (isEdit && currentNav > 0) {
    const navInfo = modal.querySelector('#h-nav-info');
    if (navInfo) {
      navInfo.style.display = '';
      navInfo.textContent = `当前净值：${currentNav.toFixed(4)} (${h.jzrq || ''})${h.gszzl ? ' · 盘中估值：'+(h.gszzl>=0?'+':'')+h.gszzl.toFixed(2)+'%' : ''}`;
    }
  }
}

// ---------- 交易记录辅助函数 ----------

function renderTradesHTML(trades) {
  if (!trades || trades.length === 0) return '<div style="font-size:11px;color:var(--text-soft);">暂无交易记录，用上方编辑器直接设置份额和成本</div>';
  return trades.sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(t => {
    const isBuy = t.type !== 'sell';
    const sign = isBuy ? '+' : '-';
    const cls = isBuy ? 'profit-pos' : 'profit-neg';
    return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;border-bottom:1px solid #f1f5f9;">
      <span style="font-size:10px;">${t.date||'—'}</span>
      <span class="${cls}" style="font-weight:600;">${sign}${(parseFloat(t.share)||0).toFixed(2)}份</span>
      <span style="font-size:10px;">@${(parseFloat(t.price)||0).toFixed(4)}</span>
      <span style="font-size:10px;">¥${(parseFloat(t.amount)||0).toFixed(0)}</span>
      <button class="btn" style="font-size:9px;padding:0 4px;margin-left:auto;" data-del-trade="${t.id}">×</button>
    </div>`;
  }).join('') + '<div style="font-size:10px;color:var(--text-soft);margin-top:2px;">份额和成本净值由交易记录自动汇总</div>';
}

function renderTradeSummary(h) {
  if (!h || !h.trades || h.trades.length === 0) return '';
  const trades = h.trades;
  let totalShare = 0, totalCost = 0;
  for (const t of trades) {
    const s = parseFloat(t.share) || 0;
    const p = parseFloat(t.price) || 0;
    if (t.type !== 'sell') { totalShare += s; totalCost += s * p; }
    else { totalShare -= s; totalCost -= s * (totalShare > 0 ? totalCost / totalShare : 0); }
  }
  const avgCost = totalShare > 0 ? totalCost / totalShare : 0;
  return `汇总：${totalShare.toFixed(2)}份 · 成本 ¥${totalCost.toFixed(2)} · 均价 ${avgCost.toFixed(4)}`;
}

function showTradeForm(modal, existing) {
  const form = modal.querySelector('#h-trade-form');
  const today = new Date().toISOString().slice(0, 10);
  form.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:end;">
      <div><label style="font-size:10px;">日期</label><input id="tf-date" type="date" value="${today}" style="width:110px;font-size:12px;"></div>
      <div><label style="font-size:10px;">类型</label><select id="tf-type" style="width:70px;font-size:12px;"><option value="buy">买入</option><option value="sell">卖出</option></select></div>
      <div><label style="font-size:10px;">份额</label><input id="tf-share" type="number" step="0.01" placeholder="份数" style="width:80px;font-size:12px;"></div>
      <div><label style="font-size:10px;">净值</label><input id="tf-price" type="number" step="0.0001" value="${currentNav > 0 ? currentNav.toFixed(4) : ''}" placeholder="买入时净值" style="width:90px;font-size:12px;"></div>
      <button id="tf-confirm" class="btn primary" style="font-size:11px;padding:2px 8px;">确定</button>
      <button id="tf-cancel" class="btn" style="font-size:11px;padding:2px 8px;">取消</button>
    </div>
  `;
  form.style.display = '';

  form.querySelector('#tf-confirm').onclick = () => {
    const date = form.querySelector('#tf-date').value;
    const type = form.querySelector('#tf-type').value;
    const share = parseFloat(form.querySelector('#tf-share').value) || 0;
    const price = parseFloat(form.querySelector('#tf-price').value) || 0;
    if (!date || share <= 0 || price <= 0) { toast('请填写完整的交易信息'); return; }
    const trade = { id: 't' + Date.now(), date, type, share, price, amount: +(share * price).toFixed(2) };
    if (!existing.trades) existing.trades = [];
    existing.trades.push(trade);
    modal.querySelector('#h-trades-list').innerHTML = renderTradesHTML(existing.trades);
    modal.querySelector('#h-trade-total').innerHTML = renderTradeSummary(existing);
    form.style.display = 'none';
    // 同步更新份额和成本到编辑器字段
    let totalShare = 0, totalCost = 0;
    for (const t of existing.trades) {
      const s = parseFloat(t.share) || 0;
      const p = parseFloat(t.price) || 0;
      if (t.type !== 'sell') { totalShare += s; totalCost += s * p; }
      else { totalShare -= s; totalCost -= s * (totalShare > 0 ? totalCost/(totalShare+s) : 0); }
    }
    const avgCost = totalShare > 0 ? +(totalCost/totalShare).toFixed(4) : 0;
    const shareInput = modal.querySelector('#h-share');
    const costNavInput = modal.querySelector('#h-cost-nav');
    const costShareInput = modal.querySelector('#h-cost-share');
    const mvShareInput = modal.querySelector('#h-mv-share');
    if (shareInput) shareInput.value = totalShare.toFixed(2);
    if (costNavInput) costNavInput.value = avgCost.toFixed(4);
    if (costShareInput) costShareInput.value = totalCost.toFixed(2);
    if (mvShareInput && currentNav > 0) mvShareInput.value = (totalShare * currentNav).toFixed(2);
  };
  form.querySelector('#tf-cancel').onclick = () => { form.style.display = 'none'; };
}

// ---------- 截图导入 ----------

function openSnapshotImport(presetTarget) {
  const profiles = store.getProfiles().filter(p => p.api_key);
  if (!profiles.length) {
    toast('请先在设置页配置 AI 档案');
    return;
  }

  const profileOpts = profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  // 导入目标选项：我的持仓 + 各个关注的人
  const followList = store.getFollowList();
  const targetOpts = [
    `<option value="holdings"${presetTarget === 'holdings' ? ' selected' : ''}>我的持仓</option>`,
    ...followList.map(p => `<option value="follow:${p.id}"${presetTarget === 'follow:'+p.id ? ' selected' : ''}>${esc(p.name)} 的持仓</option>`),
  ].join('');

  const bodyHTML = `
    <div class="form-group" style="margin-bottom:12px;">
      <label>选择识别模型</label>
      <select id="snap-profile" style="width:100%;">${profileOpts}</select>
    </div>
    <div class="form-group" style="margin-bottom:12px;">
      <label>导入到</label>
      <select id="snap-target" style="width:100%;">${targetOpts}</select>
    </div>
    <div id="snap-upload" class="upload-area" style="margin-bottom:12px;">
      <div style="font-size:28px;">📷</div>
      <div style="margin-top:8px;">点击选择持仓截图</div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:4px;">支持支付宝/天天基金等 APP 的持仓页面截图</div>
    </div>
    <div id="snap-preview" style="display:none;text-align:center;margin-bottom:12px;"></div>
    <div id="snap-status" style="display:none;text-align:center;padding:20px;"></div>
    <div id="snap-result" style="display:none;"></div>
  `;

  const { modal, close } = showModal('截图导入持仓', bodyHTML, [
    { text: '关闭', onClick: (_, c) => c() },
  ]);

  const uploadArea = modal.querySelector('#snap-upload');
  const previewEl = modal.querySelector('#snap-preview');
  const statusEl = modal.querySelector('#snap-status');
  const resultEl = modal.querySelector('#snap-result');
  const fileInput = document.getElementById('snapshot-file-input');

  uploadArea.onclick = () => fileInput.click();

  fileInput.onchange = async e => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    fileInput.value = '';

    const selectedProfile = profiles.find(p => p.id === modal.querySelector('#snap-profile').value);
    if (!selectedProfile) { toast('请选择模型'); return; }

    const targetVal = modal.querySelector('#snap-target').value;

    const rawData = await fileToBase64(file);
    const { base64: data, mime } = await compressImage(rawData, file.type, 1024, 0.85);
    const preview = `data:${mime};base64,${data}`;

    uploadArea.style.display = 'none';
    previewEl.style.display = 'block';
    previewEl.innerHTML = `<img src="${preview}" style="max-width:100%;max-height:200px;border-radius:8px;">`;

    statusEl.style.display = 'block';
    statusEl.innerHTML = `<div class="typing" style="font-size:14px;">AI 正在识别截图…</div><div style="font-size:12px;color:var(--text-soft);margin-top:8px;">使用 ${esc(selectedProfile.name)}</div>`;

    try {
      const messages = [{
        role: 'user', content: PARSE_PROMPT,
        attachments: [{ type: 'image', data, mime }],
      }];
      let fullText = '';
      for await (const chunk of streamChat(messages, selectedProfile)) { fullText += chunk; }

      let items = [];
      try {
        items = extractJSON(fullText);
      } catch (parseErr) {
        statusEl.innerHTML = `<div style="color:var(--warn);">JSON 解析失败</div><div style="font-size:12px;color:var(--text-soft);margin-top:8px;max-height:150px;overflow:auto;text-align:left;white-space:pre-wrap;word-break:break-all;">${esc(fullText.slice(0, 500))}</div>`;
        return;
      }
      if (!items.length) {
        statusEl.innerHTML = `<div style="color:var(--warn);">未识别到任何基金</div><div style="font-size:12px;color:var(--text-soft);margin-top:8px;max-height:150px;overflow:auto;text-align:left;white-space:pre-wrap;word-break:break-all;">AI 回复：${esc(fullText.slice(0, 500))}</div>`;
        return;
      }

      // 自动反查：补全代码并匹配现有持仓
      statusEl.innerHTML = '<div class="typing" style="font-size:14px;">正在补全基金信息…</div>';
      const existingHoldings = targetVal.startsWith('follow:')
        ? (store.getFollowList().find(p => p.id === targetVal.slice(7))?.items || [])
        : store.getHoldings();

      // 去除平台差异词后精确匹配
      const NOISE_WORDS = ['发起', '发起式', '式'];
      function normalizeName(n) {
        let s = (n || '').trim();
        for (const w of NOISE_WORDS) s = s.replaceAll(w, '');
        return s;
      }

      for (const it of items) {
        let code = String(it.code || '').trim();
        const name = String(it.name || '').trim();
        const normalizedName = normalizeName(name);

        // 1) 先用去噪名称精确匹配现有持仓
        if (name) {
          const matched = existingHoldings.find(h => normalizeName(h.name) === normalizedName);
          if (matched) {
            it._matched = matched;
            it.code = matched.code;
            code = matched.code;
          }
        }

        // 2) 没匹配上，用名称反查代码
        if (!it._matched && !code && name) {
          const result = await searchFundByKeyword(name);
          if (result?.code) {
            code = result.code;
            it.code = code;
            // 再用代码试匹配
            const matched = existingHoldings.find(h => h.code === code);
            if (matched) it._matched = matched;
          }
        }

        // 3) 有代码但没匹配，再试代码匹配
        if (!it._matched && code) {
          const matched = existingHoldings.find(h => h.code === code);
          if (matched) it._matched = matched;
        }

        // 4) 有代码没名称，反查名称
        if (code && !name) {
          const result = await searchFund(code);
          if (result?.name) it.name = result.name;
        }

        // 5) 都没找到，标记警告
        if (!code && !it._matched) {
          it._noCode = true;
        }
      }

      // 自动计算成本: cost = market_value - holding_profit
      for (const it of items) {
        const mv = parseFloat(it.market_value);
        const hp = parseFloat(it.holding_profit);
        if (mv > 0 && hp != null && !isNaN(hp)) {
          it.cost = +(mv - hp).toFixed(2);
        } else {
          // fallback: 用 profit_ratio 反算
          const pr = parseFloat(it.profit_ratio);
          if (mv > 0 && pr != null && !isNaN(pr)) {
            it.cost = +(mv / (1 + pr / 100)).toFixed(2);
          }
        }
      }

      // 显示结果
      statusEl.style.display = 'none';
      resultEl.style.display = 'block';

      const hasExisting = items.some(it => it._matched);
      const modeLabel = hasExisting ? '识别到匹配项，将更新已有持仓' : '识别完成';

      resultEl.innerHTML = `
        <div style="font-size:12px;color:var(--text-soft);margin-bottom:8px;">${modeLabel}，共 ${items.length} 只基金</div>
        <table class="preview-table">
          <thead><tr><th><input type="checkbox" id="snap-all" checked></th><th>状态</th><th>名称</th><th>金额</th><th>成本</th><th>收益率</th></tr></thead>
          <tbody>${items.map((it, i) => {
            const pr = it.profit_ratio != null ? parseFloat(it.profit_ratio) : null;
            const prClass = pr !== null ? (pr >= 0 ? 'profit-pos' : 'profit-neg') : '';
            const prText = pr !== null ? `${pr >= 0 ? '+' : ''}${pr.toFixed(2)}%` : '—';
            const noCode = it._noCode;
            const isUpdate = !!it._matched;
            const statusBadge = noCode
              ? '<span style="color:var(--danger);font-size:11px;">未找到代码</span>'
              : isUpdate
                ? '<span style="color:var(--primary);font-size:11px;">更新</span>'
                : '<span style="color:var(--success);font-size:11px;">新增</span>';
            const oldMV = isUpdate ? `<div style="font-size:10px;color:var(--text-soft);text-decoration:line-through;">¥${parseFloat(it._matched.market_value||0).toFixed(0)}</div>` : '';
            const oldCost = isUpdate ? `<div style="font-size:10px;color:var(--text-soft);text-decoration:line-through;">¥${parseFloat(it._matched.cost||0).toFixed(0)}</div>` : '';
            return `
            <tr class="selected" data-idx="${i}">
              <td><input type="checkbox" class="snap-check" data-idx="${i}" checked></td>
              <td>${statusBadge}</td>
              <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(it.name || '')}${it.code ? '<div style="font-size:10px;color:var(--text-soft);">' + esc(it.code) + '</div>' : ''}</td>
              <td>${it.market_value ? '¥' + parseFloat(it.market_value).toFixed(0) : '—'}${oldMV}</td>
              <td>${it.cost ? '¥' + it.cost : '—'}${oldCost}</td>
              <td class="${prClass}">${prText}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        <div style="text-align:right;margin-top:12px;">
          <button id="snap-retry" class="btn" style="margin-right:8px;">重新上传</button>
          <button id="snap-confirm" class="btn primary">确认${hasExisting ? '更新' : '导入'}</button>
        </div>
      `;

      resultEl.querySelector('#snap-all').onchange = e => {
        resultEl.querySelectorAll('.snap-check').forEach(cb => { cb.checked = e.target.checked; });
      };
      resultEl.querySelectorAll('.snap-check').forEach(cb => {
        cb.onchange = () => { cb.closest('tr').classList.toggle('selected', cb.checked); };
      });
      resultEl.querySelector('#snap-retry').onclick = () => {
        uploadArea.style.display = ''; previewEl.style.display = 'none';
        statusEl.style.display = 'none'; resultEl.style.display = 'none';
      };
      resultEl.querySelector('#snap-confirm').onclick = () => {
        const selected = [];
        resultEl.querySelectorAll('.snap-check:checked').forEach(cb => {
          selected.push(items[+cb.dataset.idx]);
        });
        if (!selected.length) { toast('请至少选择一条'); return; }
        const importItems = selected.filter(it => it.code || it.name).map(it => {
          if (it._matched) {
            // 更新模式：只更新数值，保留原有 code/name/note/id
            return {
              id: it._matched.id,
              code: it._matched.code,
              name: it._matched.name,
              market_value: parseFloat(it.market_value) || 0,
              profit_ratio: it.profit_ratio != null ? parseFloat(it.profit_ratio) : 0,
              cost: parseFloat(it.cost) || 0,
              note: it._matched.note || '',
            };
          } else {
            // 新增模式：写入全部字段
            return {
              code: String(it.code || '').trim(),
              name: String(it.name || '').trim(),
              market_value: parseFloat(it.market_value) || 0,
              profit_ratio: it.profit_ratio != null ? parseFloat(it.profit_ratio) : 0,
              cost: parseFloat(it.cost) || 0,
              note: '',
            };
          }
        });

        if (targetVal.startsWith('follow:')) {
          const pid = targetVal.slice(7);
          store.importFollowItems(pid, importItems);
          renderFollow();
        } else {
          store.importHoldings(importItems);
          render();
        }

        close();
        const updatedCount = importItems.filter(x => x.id).length;
        const newCount = importItems.length - updatedCount;
        const msg = [updatedCount && `更新 ${updatedCount} 只`, newCount && `新增 ${newCount} 只`].filter(Boolean).join('，');
        toast(msg);
        window.dispatchEvent(new Event('holdings-changed'));
      };

    } catch (err) {
      statusEl.innerHTML = `<div style="color:var(--danger);">解析失败：${esc(err.message)}</div>
        <button class="btn" style="margin-top:10px;" onclick="this.closest('.modal-mask')?.remove()">关闭</button>`;
    }
  };
}

// ---------- 持仓文本导出 ----------

function openExportText() {
  const followList = store.getFollowList();
  const options = [
    '<option value="holdings">我的持仓</option>',
    ...followList.map(p => `<option value="follow:${p.id}">${esc(p.name)} 的持仓</option>`),
  ].join('');

  const bodyHTML = `
    <div class="form-group">
      <label>选择导出对象</label>
      <select id="export-target" style="width:100%;">${options}</select>
    </div>
    <div id="export-preview" style="margin-top:12px;">
      <label style="font-size:12px;color:var(--text-soft);">预览</label>
      <pre id="export-text" style="background:var(--bg);padding:10px;border-radius:6px;font-size:12px;line-height:1.6;max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin-top:4px;"></pre>
    </div>
  `;

  const { modal, close } = showModal('导出持仓文本', bodyHTML, [
    { text: '关闭', onClick: (_, c) => c() },
    { text: '复制到剪贴板', cls: 'primary', onClick: (m, c) => {
      const text = m.querySelector('#export-text').textContent;
      navigator.clipboard.writeText(text).then(() => {
        toast('已复制到剪贴板');
        c();
      }).catch(() => {
        // iOS fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('已复制到剪贴板');
        c();
      });
    }},
  ]);

  function updatePreview() {
    const val = modal.querySelector('#export-target').value;
    let items, title;
    if (val.startsWith('follow:')) {
      const pid = val.slice(7);
      const person = followList.find(p => p.id === pid);
      items = person?.items || [];
      title = person?.name || '关注对象';
    } else {
      items = store.getHoldings();
      title = '我的持仓';
    }
    const text = formatHoldingsText(items, title);
    modal.querySelector('#export-text').textContent = text;
  }

  modal.querySelector('#export-target').onchange = updatePreview;
  updatePreview();
}

function formatHoldingsText(items, title) {
  if (!items.length) return `${title}：暂无数据`;
  const totalCost = items.reduce((s, h) => s + (parseFloat(h.cost) || 0), 0);
  const totalProfit = items.reduce((s, h) => s + (parseFloat(h.profit) || (parseFloat(h.market_value)||0) - (parseFloat(h.cost)||0)), 0);
  const totalMV = totalCost + totalProfit;
  const totalRatio = totalCost > 0 ? (totalProfit / totalCost * 100) : 0;
  const totalToday = items.reduce((s, h) => s + (parseFloat(h.profit_today) || 0), 0);

  const lines = [`【${title}】 ${new Date().toLocaleDateString('zh-CN')}`,
    `总成本: ¥${totalCost.toFixed(2)} | 总市值: ¥${totalMV.toFixed(2)}`,
    `持仓收益: ${totalProfit >= 0 ? '+' : ''}¥${totalProfit.toFixed(2)} (${totalRatio >= 0 ? '+' : ''}${totalRatio.toFixed(2)}%)${totalToday ? ' | 今日: '+(totalToday>=0?'+':'')+'¥'+totalToday.toFixed(2) : ''}`,
    ''];

  for (const h of items) {
    const cost = parseFloat(h.cost) || 0;
    const share = parseFloat(h.share) || 0;
    const dwjz = parseFloat(h.dwjz) || 0;
    const mv = share > 0 && dwjz > 0 ? share * dwjz : (parseFloat(h.market_value) || 0);
    const profit = mv - cost;
    const ratio = cost > 0 ? (profit / cost * 100) : 0;
    const pct = totalMV > 0 ? (mv / totalMV * 100) : 0;
    const today = parseFloat(h.profit_today) || 0;

    lines.push(`${h.code} ${h.name}`);
    lines.push(`  份额: ${share>0?share.toFixed(2)+'份':'—'} | 市值: ¥${mv.toFixed(2)} (${pct.toFixed(1)}%) | 净值: ${dwjz>0?dwjz.toFixed(4):'—'}`);
    lines.push(`  成本: ¥${cost.toFixed(2)} | 收益: ${profit>=0?'+':''}¥${profit.toFixed(2)} (${ratio>=0?'+':''}${ratio.toFixed(2)}%)${today?' | 今日: '+(today>=0?'+':'')+'¥'+today.toFixed(2):''}`);
  }
  return lines.join('\n');
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
