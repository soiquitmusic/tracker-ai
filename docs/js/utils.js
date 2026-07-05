// ===== utils.js — 工具函数 =====

// ====== 行情计算公式 ======

// 统一当天收益 = C3 修复
export function computeProfitToday(h) {
  const share = h.share || 0;
  const mv = h.market_value || 0;
  const dwjz = h.dwjz || 0;
  const lastNav = h.lastNav || 0;
  const gszzl = h.gszzl || 0;
  // 1. 优先: (dwjz - lastNav) * share (精确净值差)
  if (lastNav > 0 && dwjz > 0) {
    return +((dwjz - lastNav) * share).toFixed(2);
  }
  // 2. 备选: gszzl 反推昨日价值
  if (gszzl !== 0 && mv > 0) {
    return +(mv - mv / (1 + gszzl / 100)).toFixed(2);
  }
  // 3. 兜底
  return 0;
}

// 累计收益 = 持有收益 + 已实现收益
export function computeCumulative(h) {
  const profit = h.profit || 0;
  const realized = h.realized_profit || 0;
  return +(profit + realized).toFixed(2);
}

// 累计收益率
export function computeCumulativeRate(h) {
  const cost = h.cost || 0;
  if (cost <= 0) return 0;
  const cum = computeCumulative(h);
  return +((cum / cost) * 100).toFixed(2);
}

// 自添加来收益
export function computeSinceAdded(h) {
  if (!h.addBaseNav || h.addBaseNav <= 0) return null;
  const nav = h.dwjz || h.gsz || 0;
  if (nav <= 0) return null;
  return +((nav / h.addBaseNav - 1) * 100).toFixed(2);
}

// 连涨连跌天数
export function computeConsecutiveTrend(navs) {
  if (!navs || navs.length < 2) return { type: null, days: 0 };
  const dir = navs[navs.length - 1] > navs[navs.length - 2] ? 'up' : 'down';
  let days = 1;
  for (let i = navs.length - 1; i >= 1; i--) {
    const cur = navs[i], prev = navs[i - 1];
    if ((dir === 'up' && cur <= prev) || (dir === 'down' && cur >= prev)) break;
    days++;
  }
  return { type: dir, days: days >= 3 ? days : 0 };
}

// 每日收益记录
export function recordDailyEarnings(code, earnings, dateStr) {
  try {
    const key = 'fundDailyEarnings';
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    const list = (all[code] || []).slice(-365);
    const today = dateStr || new Date().toISOString().slice(0, 10);
    const existing = list.find(e => e.date === today);
    if (existing) { existing.earnings = +earnings.toFixed(2); }
    else { list.push({ date: today, earnings: +earnings.toFixed(2) }); }
    all[code] = list;
    localStorage.setItem(key, JSON.stringify(all));
  } catch {}
}

// YTD 累计收益
export function computeYTD(code) {
  try {
    const all = JSON.parse(localStorage.getItem('fundDailyEarnings') || '{}');
    const list = all[code] || [];
    const year = new Date().getFullYear();
    return +list.filter(e => e.date.startsWith(String(year))).reduce((s, e) => s + e.earnings, 0).toFixed(2);
  } catch { return 0; }
}

// 近一周收益
export function computeNearWeek(navs) {
  if (!navs || navs.length < 7) return null;
  const cur = navs[navs.length - 1];
  const week = navs[navs.length - 7];
  if (week <= 0) return null;
  return +((cur / week - 1) * 100).toFixed(2);
}

// ====== 基础工具 ======

export function uuid() {
  return crypto.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if (sameDay) return time;
  if (isYesterday) return `昨天 ${time}`;
  return `${d.getMonth()+1}月${d.getDate()}日 ${time}`;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function renderMarkdown(text) {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');

  // Bold & italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m =>
    `<ul>${m}</ul>`);

  // Line breaks (outside pre blocks)
  html = html.replace(/\n/g, '<br>');
  // Clean up extra <br> around block elements
  html = html.replace(/<br>(<\/?(?:h[1-6]|ul|ol|li|pre|blockquote))/g, '$1');
  html = html.replace(/(<\/(?:h[1-6]|ul|ol|li|pre|blockquote)>)<br>/g, '$1');

  return html;
}

export function extractJSON(raw) {
  let str = raw.trim();
  const match = str.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match) str = match[1].trim();
  const start = str.indexOf('[');
  const end = str.lastIndexOf(']');
  if (start >= 0 && end > start) str = str.slice(start, end + 1);
  return JSON.parse(str);
}

// Toast 通知
let toastEl = null;
let toastTimer = null;
export function toast(msg, duration = 2000) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// 模态框
export function showModal(title, bodyHTML, footerBtns = []) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<h3>${title}</h3><div class="modal-body">${bodyHTML}</div>`;
  if (footerBtns.length) {
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footerBtns.forEach(({ text, cls, onClick }) => {
      const btn = document.createElement('button');
      btn.className = `btn ${cls || ''}`;
      btn.textContent = text;
      btn.onclick = () => { onClick(modal, close); };
      footer.appendChild(btn);
    });
    modal.appendChild(footer);
  }
  mask.appendChild(modal);
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  root.appendChild(mask);

  function close() { root.removeChild(mask); }
  return { modal, close };
}

// ===== fundgz JSONP 调度器（解决 window.jsonpgz 全局冲突） =====

let _jsonpgzDispatcher = null;

function ensureJsonpgzDispatcher() {
  if (_jsonpgzDispatcher) return _jsonpgzDispatcher;
  const pending = new Map();

  window.jsonpgz = (json) => {
    if (!json || !json.fundcode) return;
    const code = String(json.fundcode).trim();
    const entry = pending.get(code);
    if (entry) {
      pending.delete(code);
      if (entry.cleanup) entry.cleanup();
      if (entry.onData) entry.onData(json);
    }
  };

  _jsonpgzDispatcher = {
    register(code, { onData, cleanup, timeout }) {
      if (pending.has(code)) {
        const old = pending.get(code);
        if (old.cleanup) old.cleanup();
      }
      pending.set(code, { onData, cleanup });
      if (timeout) setTimeout(() => {
        const e = pending.get(code);
        if (e === pending.get(code)) pending.delete(code);
      }, timeout);
    },
    unregister(code) { pending.delete(code); },
  };
  return _jsonpgzDispatcher;
}

export function fetchWithDispatcher(code, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const dispatcher = ensureJsonpgzDispatcher();
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v || null); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const id = '_fd_' + code;

    dispatcher.register(code, {
      onData: (data) => {
        finish(data);
      },
      cleanup: () => { clearTimeout(timer); const s = document.getElementById(id); if (s) s.remove(); },
      timeout: timeoutMs,
    });

    const script = document.createElement('script');
    script.id = id;
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    script.onerror = () => finish(null);
    document.head.appendChild(script);
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// 压缩图片：缩小尺寸 + 降低质量，返回 { base64, mime }
export function compressImage(base64Data, mime, maxWidth = 1200, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const outMime = 'image/jpeg';
      const dataUrl = canvas.toDataURL(outMime, quality);
      const comma = dataUrl.indexOf(',');
      resolve({ base64: dataUrl.slice(comma + 1), mime: outMime });
    };
    img.src = `data:${mime};base64,${base64Data}`;
  });
}

// ===== 全量基金数据库（从东方财富加载，缓存24h） =====

let fundDB = null;          // Map: code → { code, name, type }
let fundDBLoading = false;
let fundDBPromise = null;

export async function loadFundDatabase() {
  if (fundDB && fundDB.size > 0) return fundDB;
  if (fundDBPromise) return fundDBPromise;

  // 检查 localStorage 缓存
  try {
    const cached = JSON.parse(localStorage.getItem('fundDB'));
    if (cached && cached.data && cached.ts && (Date.now() - cached.ts < 24 * 3600 * 1000)) {
      fundDB = new Map(cached.data);
      return fundDB;
    }
  } catch { /* ignore */ }

  fundDBLoading = true;
  fundDBPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      fundDBLoading = false;
      fundDBPromise = null;
      resolve(fundDB || new Map());
    }, 15000);

    const cbName = '_fundDB_' + Date.now();
    window[cbName] = (data) => {
      clearTimeout(timeout);
      fundDBLoading = false;
      fundDBPromise = null;
      try {
        if (Array.isArray(data)) {
          const entries = data.map(d => [String(d[0]), { code: String(d[0]), name: String(d[2] || ''), type: String(d[3] || '') }]);
          fundDB = new Map(entries);
          // 缓存到 localStorage
          localStorage.setItem('fundDB', JSON.stringify({
            ts: Date.now(),
            data: entries.slice(0, 30000), // 限制缓存大小
          }));
        }
      } catch (e) { /* ignore */ }
      delete window[cbName];
      resolve(fundDB || new Map());
    };

    const script = document.createElement('script');
    script.src = 'https://fund.eastmoney.com/js/fundcode_search.js';
    script.onerror = () => {
      clearTimeout(timeout);
      fundDBLoading = false;
      fundDBPromise = null;
      delete window[cbName];
      resolve(fundDB || new Map());
    };
    // r 是 eastmoney 脚本的全局变量名
    script.onload = () => {
      setTimeout(() => {
        if (window.r && Array.isArray(window.r)) {
          window[cbName](window.r);
        }
      }, 200);
    };
    document.head.appendChild(script);
  });

  return fundDBPromise;
}

export function getFundDatabase() {
  return fundDB;
}

// 本地搜索基金（从全量数据库中模糊匹配）
export function searchFundLocal(keyword) {
  const db = fundDB;
  if (!db || db.size === 0) return [];

  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];

  const results = [];
  const isPureDigits = /^\d{6}$/.test(kw);

  for (const [code, fund] of db) {
    if (isPureDigits) {
      // 精确代码匹配
      if (code === kw) { results.push(fund); break; }
      if (code.startsWith(kw)) results.push(fund);
    } else {
      // 名称包含匹配
      const name = (fund.name || '').toLowerCase();
      if (name.includes(kw)) results.push(fund);
    }
    if (results.length >= 20) break;
  }

  return results;
}

// 基金代码搜索名称（通过调度器 + 本地DB fallback）
export function searchFund(code) {
  return new Promise((resolve) => {
    const db = fundDB;
    if (db && db.has(String(code).trim())) {
      const f = db.get(String(code).trim());
      resolve({ code: String(code).trim(), name: f.name });
      return;
    }
    fetchWithDispatcher(code, 4000).then(data => {
      if (data && data.name) resolve({ code: String(data.fundcode || code).trim(), name: data.name });
      else searchFundMulti(code).then(r => {
        const found = r.find(f => f.code === code);
        resolve(found || null);
      });
    });
  });
}

// 按关键词搜索基金（单条兼容，内部调用 searchFundMulti）
export function searchFundByKeyword(keyword) {
  return searchFundMulti(keyword).then(results => results[0] || null);
}

// ===== 数据源设置 =====
export function getDataSource() {
  return parseInt(localStorage.getItem('dataSource')) || 1; // 1=fundgz 2=Sina
}
export function setDataSource(v) {
  localStorage.setItem('dataSource', String(v));
}

// ===== 基金经理数据库（东方财富全市场经理API，缓存7天） =====

let managerDB = null;        // Map<MGRID, {name, company, fundCodes, fundNames, scale, totalReturn}>
let managerDBPromise = null;

export async function loadManagerDatabase() {
  if (managerDB && managerDB.size > 0) return managerDB;
  if (managerDBPromise) return managerDBPromise;

  // 检查 localStorage 缓存
  try {
    const cached = JSON.parse(localStorage.getItem('managerDB'));
    if (cached && cached.data && cached.ts && (Date.now() - cached.ts < 7 * 24 * 3600 * 1000)) {
      managerDB = new Map(cached.data);
      return managerDB;
    }
  } catch { /* ignore */ }

  managerDBPromise = (async () => {
    managerDB = new Map();
    // 先加载第1页确定总页数
    try {
      const firstPage = await fetchManagerPage(1, 100);
      if (firstPage && firstPage.data) {
        for (const entry of firstPage.data) {
          managerDB.set(entry[0], {
            name: entry[1], company: entry[3],
            fundCodes: (entry[4] || '').split(',').filter(Boolean),
            fundNames: (entry[5] || '').split(',').filter(Boolean),
            totalReturn: entry[7], scale: entry[10],
          });
        }
        const totalPages = Math.min(parseInt(firstPage.pages) || 1, 50); // 上限50页
        // 并行加载剩余页
        const remaining = [];
        for (let p = 2; p <= totalPages; p++) remaining.push(p);
        // 分批加载，每批5页并发
        for (let i = 0; i < remaining.length; i += 5) {
          const batch = remaining.slice(i, i + 5);
          const results = await Promise.all(batch.map(p => fetchManagerPage(p, 100)));
          for (const r of results) {
            if (r && r.data) {
              for (const entry of r.data) {
                managerDB.set(entry[0], {
                  name: entry[1], company: entry[3],
                  fundCodes: (entry[4] || '').split(',').filter(Boolean),
                  fundNames: (entry[5] || '').split(',').filter(Boolean),
                  totalReturn: entry[7], scale: entry[10],
                });
              }
            }
          }
        }
      }
    } catch (e) { console.warn('Manager DB load error:', e); }

    // 缓存到 localStorage
    if (managerDB.size > 0) {
      const entries = Array.from(managerDB.entries()).slice(0, 5000);
      localStorage.setItem('managerDB', JSON.stringify({ ts: Date.now(), data: entries }));
    }
    return managerDB;
  })();

  return managerDBPromise;
}

function fetchManagerPage(page, size) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 10000);
    const cbName = '_mgrPg_' + Date.now() + '_' + page;

    function cleanup() {
      clearTimeout(timeout);
      delete window[cbName];
      const s = document.getElementById(cbName);
      if (s) s.remove();
    }

    window[cbName] = (data) => {
      cleanup();
      if (data && Array.isArray(data.data)) {
        resolve(data);
      } else {
        resolve(null);
      }
    };

    const script = document.createElement('script');
    script.id = cbName;
    script.src = `https://fund.eastmoney.com/Data/FundDataPortfolio_Interface.aspx?dt=14&mc=returnjson&ft=jj&pn=${size}&pi=${page}&sc=desc&st=rise&callback=${cbName}`;
    script.onerror = () => { cleanup(); resolve(null); };
    document.head.appendChild(script);
  });
}

export function getManagerFunds(mgrId) {
  if (!managerDB) return null;
  return managerDB.get(String(mgrId)) || null;
}

export function findManagerByName(name) {
  if (!managerDB) return null;
  for (const [id, mgr] of managerDB) {
    if (mgr.name === name) return { id, ...mgr };
  }
  return null;
}

// 从前十重仓股名称推断赛道（供 overview + analysis 共用）
export function detectSectorFromHoldings(topHoldings) {
  if (!topHoldings || topHoldings.length === 0) return [];
  const names = topHoldings.join(' ').toLowerCase();
  const sectors = [];
  if (/中芯|华虹|北方华创|中微|韦尔|兆易|长电|通富|晶合|澜起|寒武纪|海光|龙芯|卓胜微|圣邦|芯|半导体|芯片|晶圆|光刻|封测/.test(names)) sectors.push('半导体');
  if (/寒武纪|海光|算力|gpu|npu|tpu|ai芯片|人工智能|大模型|智能驾驶|自动驾驶|机器人/.test(names)) sectors.push('AI');
  if (/宁德|比亚迪|锂|光伏|阳光电源|通威|隆基|储能|风电|氢能|新能/.test(names)) sectors.push('新能源');
  if (/茅台|五粮液|美的|格力|海尔|伊利|蒙牛|消费|白酒|食品|家电/.test(names)) sectors.push('消费');
  if (/恒瑞|药明|迈瑞|爱尔|泰格|百济|信达|君实|医药|医疗|生物|基因|疫苗/.test(names)) sectors.push('医药');
  if (/中兴|烽火|通信|5g|光模块|光通信|光纤/.test(names)) sectors.push('通信');
  if (/腾讯|阿里|美团|百度|网易|字节|软件|saas|云计算|大数据|信息/.test(names)) sectors.push('互联网');
  if (/银行|保险|券商|证券|招商银行|平安|中信/.test(names)) sectors.push('金融');
  if (/军工|航天|航空|船舶|兵器|中航/.test(names)) sectors.push('军工');
  if (/机器人|自动化|伺服|减速器|传感器/.test(names)) sectors.push('机器人');
  return sectors;
}

// 按关键词搜索基金（直接抄 real-time-fund 的 searchFunds）
export function searchFundMulti(val) {
  const kw = String(val || '').trim();
  if (!kw) return Promise.resolve([]);

  return new Promise((resolve) => {
    const cbName = 'SuggestData_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const url = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' + encodeURIComponent(kw) + '&callback=' + cbName + '&_=' + Date.now();
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (document.body.contains(script)) script.remove();
      delete window[cbName];
      resolve([]);
    }, 10000);

    window[cbName] = (data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[cbName];
      if (document.body.contains(script)) script.remove();
      try {
        if (data && data.Datas && data.Datas.length > 0) {
          resolve(data.Datas.filter(d => d.CATEGORY === 700 || d.CATEGORY === '700' || d.CATEGORYDESC === '基金').slice(0, 20).map(d => ({ code: d.CODE, name: d.NAME, type: d.FundType || '' })));
        } else { resolve([]); }
      } catch { resolve([]); }
    };

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onerror = () => { if (!done) { done = true; clearTimeout(timer); delete window[cbName]; script.remove(); resolve([]); } };
    document.body.appendChild(script);
  });
}
