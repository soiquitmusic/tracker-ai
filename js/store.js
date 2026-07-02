// ===== store.js — 数据层 (localStorage + IndexedDB) =====

import { uuid } from './utils.js';

// ---------- localStorage helpers ----------

function getJSON(key, fallback = []) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch { return fallback; }
}
function setJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// ---------- Profiles ----------

export function getProfiles() { return getJSON('profiles', []); }

export function saveProfile(p) {
  const list = getProfiles();
  if (p.id) {
    const idx = list.findIndex(x => x.id === p.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...p };
    else list.push(p);
  } else {
    p.id = uuid();
    list.push(p);
  }
  if (p.is_default) list.forEach(x => { if (x.id !== p.id) x.is_default = false; });
  if (list.length === 1) list[0].is_default = true;
  setJSON('profiles', list);
  return p;
}

export function deleteProfile(id) {
  let list = getProfiles().filter(p => p.id !== id);
  if (list.length && !list.some(p => p.is_default)) list[0].is_default = true;
  setJSON('profiles', list);
}

export function getDefaultProfile() {
  const list = getProfiles();
  return list.find(p => p.is_default) || list[0] || null;
}

export function setDefaultProfile(id) {
  const list = getProfiles();
  list.forEach(p => { p.is_default = p.id === id; });
  setJSON('profiles', list);
}

// ---------- Holdings ----------

export function getSystemPrompt() {
  return localStorage.getItem('systemPrompt') || '';
}
export function setSystemPrompt(text) {
  localStorage.setItem('systemPrompt', text);
}

// ---------- Holdings (cont.) ----------

export function getHoldings() { return getJSON('holdings', []); }

export function saveHolding(h) {
  const list = getHoldings();
  if (h.id) {
    const idx = list.findIndex(x => x.id === h.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...h };
    else list.push(h);
  } else {
    h.id = uuid();
    list.push(h);
  }
  setJSON('holdings', list);
  return h;
}

export function deleteHolding(id) {
  setJSON('holdings', getHoldings().filter(h => h.id !== id));
}

export function importHoldings(items) {
  const list = getHoldings();
  for (const item of items) {
    // 优先按 id 匹配（更新模式），其次按 code
    const idx = item.id
      ? list.findIndex(h => h.id === item.id)
      : list.findIndex(h => h.code && h.code === item.code);
    if (idx >= 0) {
      Object.assign(list[idx], item);
    } else {
      item.id = item.id || uuid();
      list.push(item);
    }
  }
  setJSON('holdings', list);
}

// 数据迁移：旧 holding 结构 → 新结构（补充份额、净值等字段）
export function normalizeHolding(h) {
  if (!h) return h;
  // 已迁移
  if (h.share !== undefined && h.dwjz !== undefined) return h;

  const cost = parseFloat(h.cost) || 0;
  const mv = parseFloat(h.market_value) || 0;
  const ratio = parseFloat(h.profit_ratio) || 0;

  // 从旧数据推算份额
  let share = parseFloat(h.share) || 0;
  if (!share && cost > 0 && ratio !== 0) {
    // cost / (cost_nav) = share, 其中 cost_nav ≈ cost / (market_value / (1 + ratio/100))
    // 简化：如果 profit_ratio 可信，反推买入净值
    const costNav = ratio > -100 ? +(cost / (mv / (1 + ratio / 100))).toFixed(4) : 0;
    if (costNav > 0) share = +(cost / costNav).toFixed(2);
    else share = 0;
  }

  return {
    ...h,
    share,
    cost_nav: parseFloat(h.cost_nav) || (share > 0 ? +(cost / share).toFixed(4) : 0),
    dwjz: parseFloat(h.dwjz) || 0,
    lastNav: parseFloat(h.lastNav) || 0,
    jzrq: h.jzrq || '',
    gsz: parseFloat(h.gsz) || 0,
    gszzl: parseFloat(h.gszzl) || 0,
    gztime: h.gztime || '',
    zzl: parseFloat(h.zzl) || 0,
    addBaseNav: parseFloat(h.addBaseNav) || 0,
    addBaseDate: h.addBaseDate || '',
    profit: parseFloat(h.profit) || (cost > 0 ? mv - cost : 0),
    profit_today: parseFloat(h.profit_today) || 0,
  };
}

// ---------- 基金分组 ----------
// 分组: { id, name, codes: [] }

export function getGroups() { return getJSON('fundGroups', []); }
export function saveGroup(g) {
  const list = getGroups();
  if (g.id) { const idx = list.findIndex(x => x.id === g.id); if (idx >= 0) list[idx] = g; else list.push(g); }
  else { g.id = uuid(); list.push(g); }
  setJSON('fundGroups', list);
  return g;
}
export function deleteGroup(id) { setJSON('fundGroups', getGroups().filter(g => g.id !== id)); }
export function addFundToGroup(groupId, code) {
  const list = getGroups();
  const g = list.find(x => x.id === groupId);
  if (g && !g.codes.includes(code)) { g.codes.push(code); setJSON('fundGroups', list); }
}
export function removeFundFromGroup(groupId, code) {
  const list = getGroups();
  const g = list.find(x => x.id === groupId);
  if (g) { g.codes = g.codes.filter(c => c !== code); setJSON('fundGroups', list); }
}
export function getGroupFundCodes(groupId) {
  const g = getGroups().find(x => x.id === groupId);
  return g?.codes || [];
}

// ---------- 交易记录 ----------
// 每笔交易: { id, date, type:'buy'|'sell', share, price, amount, note }

export function addTrade(holdingId, trade) {
  const list = getHoldings();
  const h = list.find(x => x.id === holdingId);
  if (!h) return null;
  if (!h.trades) h.trades = [];
  trade.id = trade.id || uuid();
  h.trades.push(trade);
  recalcFromTrades(h);
  setJSON('holdings', list);
  return trade;
}

export function deleteTrade(holdingId, tradeId) {
  const list = getHoldings();
  const h = list.find(x => x.id === holdingId);
  if (!h) return;
  h.trades = (h.trades || []).filter(t => t.id !== tradeId);
  recalcFromTrades(h);
  setJSON('holdings', list);
}

// 从交易记录反算份额、成本、成本净值
function recalcFromTrades(h) {
  if (!h.trades || h.trades.length === 0) return;
  let totalShare = 0, totalCost = 0;
  for (const t of h.trades) {
    const share = parseFloat(t.share) || 0;
    const price = parseFloat(t.price) || 0;
    if (t.type === 'buy') {
      totalShare += share;
      totalCost += share * price;
    } else if (t.type === 'sell') {
      totalShare -= share;
      // 卖出按平均成本扣减
      const avgCost = totalShare > 0 ? totalCost / totalShare : 0;
      totalCost -= share * avgCost;
    }
  }
  h.share = Math.max(0, +totalShare.toFixed(2));
  h.cost = +totalCost.toFixed(2);
  h.cost_nav = h.share > 0 ? +(h.cost / h.share).toFixed(4) : 0;
}

export function getTrades(holdingId) {
  const h = getHoldings().find(x => x.id === holdingId);
  return h?.trades || [];
}

// 批量规范化所有持仓
export function normalizeAllHoldings() {
  const holdings = getHoldings();
  let changed = false;
  const normalized = holdings.map(h => {
    const nh = normalizeHolding(h);
    if (nh !== h) changed = true;
    return nh;
  });
  if (changed) setJSON('holdings', normalized);
  // 也处理关注列表
  const followList = getFollowList();
  let flChanged = false;
  for (const person of followList) {
    if (!person.items) continue;
    person.items = person.items.map(item => {
      const ni = normalizeHolding(item);
      if (ni !== item) flChanged = true;
      return ni;
    });
  }
  if (flChanged) setJSON('followList', followList);
}

// ---------- Follow List (关注持仓) ----------
// 结构: [{ id, name, items: [{ id, code, name, market_value, profit_ratio, cost, note }] }]

export function getFollowList() { return getJSON('followList', []); }

export function saveFollowPerson(person) {
  const list = getFollowList();
  if (person.id) {
    const idx = list.findIndex(x => x.id === person.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...person };
    else list.push(person);
  } else {
    person.id = uuid();
    if (!person.items) person.items = [];
    list.push(person);
  }
  setJSON('followList', list);
  return person;
}

export function deleteFollowPerson(id) {
  setJSON('followList', getFollowList().filter(p => p.id !== id));
}

export function saveFollowItem(personId, item) {
  const list = getFollowList();
  const person = list.find(p => p.id === personId);
  if (!person) return;
  if (!person.items) person.items = [];
  if (item.id) {
    const idx = person.items.findIndex(x => x.id === item.id);
    if (idx >= 0) person.items[idx] = { ...person.items[idx], ...item };
    else person.items.push(item);
  } else {
    item.id = uuid();
    person.items.push(item);
  }
  setJSON('followList', list);
  return item;
}

export function deleteFollowItem(personId, itemId) {
  const list = getFollowList();
  const person = list.find(p => p.id === personId);
  if (!person) return;
  person.items = (person.items || []).filter(x => x.id !== itemId);
  setJSON('followList', list);
}

export function importFollowItems(personId, items) {
  const list = getFollowList();
  const person = list.find(p => p.id === personId);
  if (!person) return;
  if (!person.items) person.items = [];
  for (const item of items) {
    const idx = item.id
      ? person.items.findIndex(h => h.id === item.id)
      : person.items.findIndex(h => h.code && h.code === item.code);
    if (idx >= 0) {
      Object.assign(person.items[idx], item);
    } else {
      item.id = item.id || uuid();
      person.items.push(item);
    }
  }
  setJSON('followList', list);
}

// ---------- IndexedDB (conversations & messages) ----------

const DB_NAME = 'FundAIDB';
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('conversations')) {
        const cs = db.createObjectStore('conversations', { keyPath: 'id' });
        cs.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('conversationId', 'conversationId');
        ms.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return openDB().then(db => {
    const t = db.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    return { store: s, tx: t, db };
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Conversations
export async function getConversations() {
  const { store } = await tx('conversations');
  const all = await reqP(store.getAll());
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function createConversation(title = '新对话', profileId = null) {
  const conv = {
    id: uuid(), title, profileId,
    includeHoldings: true,
    skills: [], // 加载的 skill 名称列表
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  const { store } = await tx('conversations', 'readwrite');
  await reqP(store.put(conv));
  return conv;
}

export async function updateConversation(id, updates) {
  const { store } = await tx('conversations', 'readwrite');
  const conv = await reqP(store.get(id));
  if (!conv) return;
  Object.assign(conv, updates, { updatedAt: Date.now() });
  await reqP(store.put(conv));
  return conv;
}

export async function deleteConversation(id) {
  const { store: cs } = await tx('conversations', 'readwrite');
  await reqP(cs.delete(id));
  // 删除关联消息
  const { store: ms } = await tx('messages', 'readwrite');
  const idx = ms.index('conversationId');
  const msgs = await reqP(idx.getAll(id));
  for (const m of msgs) await reqP(ms.delete(m.id));
}

export async function getConversation(id) {
  const { store } = await tx('conversations');
  return reqP(store.get(id));
}

// Messages
export async function getMessages(conversationId) {
  const { store } = await tx('messages');
  const idx = store.index('conversationId');
  const all = await reqP(idx.getAll(conversationId));
  return all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function addMessage(conversationId, role, content, attachments = []) {
  const msg = {
    id: uuid(), conversationId, role, content,
    attachments, createdAt: Date.now(),
  };
  const { store } = await tx('messages', 'readwrite');
  await reqP(store.put(msg));
  // 更新会话时间
  await updateConversation(conversationId, {});
  return msg;
}

export async function deleteMessage(id) {
  const { store } = await tx('messages', 'readwrite');
  await reqP(store.delete(id));
}

// ---------- 数据导出/导入 ----------

export async function exportAll() {
  const convs = await getConversations();
  const allMsgs = [];
  for (const c of convs) {
    const msgs = await getMessages(c.id);
    allMsgs.push(...msgs);
  }
  return {
    profiles: getProfiles(),
    holdings: getHoldings(),
    followList: getFollowList(),
    conversations: convs,
    messages: allMsgs,
    exportedAt: new Date().toISOString(),
  };
}

export async function importAll(data) {
  if (data.profiles) setJSON('profiles', data.profiles);
  if (data.holdings) setJSON('holdings', data.holdings);
  if (data.followList) setJSON('followList', data.followList);
  if (data.conversations) {
    const { store } = await tx('conversations', 'readwrite');
    for (const c of data.conversations) await reqP(store.put(c));
  }
  if (data.messages) {
    const { store } = await tx('messages', 'readwrite');
    for (const m of data.messages) await reqP(store.put(m));
  }
}

export async function clearAll() {
  localStorage.removeItem('profiles');
  localStorage.removeItem('holdings');
  localStorage.removeItem('followList');
  localStorage.removeItem('settings');
  const db = await openDB();
  const t = db.transaction(['conversations', 'messages'], 'readwrite');
  t.objectStore('conversations').clear();
  t.objectStore('messages').clear();
}
