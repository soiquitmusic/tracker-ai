// ===== chat.js — 聊天页 =====

import * as store from './store.js';
import { streamChat } from './providers.js';
import { renderMarkdown, fileToBase64, compressImage, formatTime, toast } from './utils.js';

const DEFAULT_SYSTEM_PROMPT = '';

let currentConvId = null;
let isStreaming = false;
let pendingImages = [];
let abortController = null;

export function initChat() {
  document.getElementById('btn-toggle-sidebar').onclick = toggleSidebar;
  document.getElementById('sidebar-mask').onclick = toggleSidebar;
  document.getElementById('btn-new-conv').onclick = newConversation;
  document.getElementById('btn-send').onclick = sendMessage;
  document.getElementById('btn-pick-image').onclick = () => document.getElementById('chat-file-input').click();
  document.getElementById('chat-file-input').onchange = onFileChange;

  const input = document.getElementById('chat-input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', autoResize);

  window.addEventListener('profiles-changed', () => { refreshProfileSelect(); loadConversations(); });

  loadConversations();
  refreshProfileSelect();

  // 恢复上次对话
  const lastConvId = localStorage.getItem('lastConvId');
  if (lastConvId) {
    selectConversation(lastConvId);
  }
}

function toggleSidebar() {
  document.getElementById('chat-sidebar').classList.toggle('open');
  document.getElementById('sidebar-mask').classList.toggle('open');
}

function autoResize() {
  const el = document.getElementById('chat-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

// ---------- Profile Select ----------

export function refreshProfileSelect() {
  const select = document.getElementById('chat-profile-select');
  const profiles = store.getProfiles();
  select.innerHTML = profiles.length
    ? profiles.map(p => `<option value="${p.id}" ${p.is_default?'selected':''}>${esc(p.name)}</option>`).join('')
    : '<option value="">无档案</option>';
}

function getSelectedProfile() {
  const select = document.getElementById('chat-profile-select');
  const profiles = store.getProfiles();
  return profiles.find(p => p.id === select.value) || store.getDefaultProfile();
}

// ---------- Conversations ----------

async function loadConversations() {
  const convs = await store.getConversations();
  const listEl = document.getElementById('conv-list');
  if (!convs.length) {
    listEl.innerHTML = '<div class="empty-hint" style="padding:16px;">点击「+ 新对话」开始</div>';
    return;
  }

  // 置顶的排前面，其余按时间排
  const pinned = convs.filter(c => c.pinned).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const unpinned = convs.filter(c => !c.pinned).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const sorted = [...pinned, ...unpinned];

  listEl.innerHTML = sorted.map(c => `
    <div class="conv-item ${c.id === currentConvId ? 'active' : ''} ${c.pinned ? 'pinned' : ''}" data-id="${c.id}">
      ${c.pinned ? '<span class="pin-badge">置顶</span>' : ''}
      <div class="conv-title">${esc(c.title)}</div>
      <div class="conv-meta">${formatTime(c.updatedAt)}</div>
      <div class="conv-actions">
        <button class="btn icon-btn" data-action="pin" data-id="${c.id}" title="${c.pinned ? '取消置顶' : '置顶'}" style="font-size:14px;">${c.pinned ? '📌' : '📍'}</button>
        <button class="btn icon-btn" data-action="rename" data-id="${c.id}" title="重命名" style="font-size:14px;">✏️</button>
        <button class="btn icon-btn" data-action="delete" data-id="${c.id}" title="删除" style="font-size:14px;">🗑️</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.conv-item').forEach(el => {
    el.onclick = e => {
      if (e.target.closest('[data-action]')) return;
      selectConversation(el.dataset.id);
      toggleSidebar();
    };
  });
  listEl.querySelectorAll('[data-action="pin"]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const conv = await store.getConversation(btn.dataset.id);
      if (conv) {
        await store.updateConversation(btn.dataset.id, { pinned: !conv.pinned });
        loadConversations();
      }
    };
  });
  listEl.querySelectorAll('[data-action="rename"]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const conv = await store.getConversation(btn.dataset.id);
      const name = prompt('新标题', conv?.title || '');
      if (name) { await store.updateConversation(btn.dataset.id, { title: name }); loadConversations(); }
    };
  });
  listEl.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      if (!confirm('确认删除此对话？')) return;
      await store.deleteConversation(btn.dataset.id);
      if (currentConvId === btn.dataset.id) {
        currentConvId = null;
        localStorage.removeItem('lastConvId');
        renderEmpty();
      }
      loadConversations();
    };
  });
}

async function newConversation() {
  const profile = getSelectedProfile();
  const conv = await store.createConversation('新对话', profile?.id);
  currentConvId = conv.id;
  localStorage.setItem('lastConvId', conv.id);
  await loadConversations();
  await renderMessages();
  toggleSidebar();
  enableInput(true);
}

async function selectConversation(id) {
  currentConvId = id;
  localStorage.setItem('lastConvId', id);
  await loadConversations();
  await renderMessages();
  enableInput(true);
}

// ---------- Messages ----------

async function renderMessages() {
  const el = document.getElementById('chat-messages');
  if (!currentConvId) { renderEmpty(); return; }

  const conv = await store.getConversation(currentConvId);
  document.getElementById('chat-title').textContent = conv?.title || '对话';

  const msgs = await store.getMessages(currentConvId);
  if (!msgs.length) {
    el.innerHTML = '<div class="empty-hint">发送第一条消息开始对话</div>';
    return;
  }

  el.innerHTML = msgs.map(m => {
    if (m.role === 'user') {
      let content = esc(m.content);
      const imgHTML = (m.attachments || [])
        .filter(a => a.type === 'image')
        .map(a => `<img src="data:${a.mime || 'image/png'};base64,${a.data}" style="max-width:200px;margin-top:6px;">`)
        .join('');
      return `<div class="msg user"><div class="bubble">${content}${imgHTML}</div></div>`;
    }
    if (m.role === 'assistant') {
      return `<div class="msg assistant"><div class="bubble">${renderMarkdown(m.content)}</div></div>`;
    }
    return '';
  }).join('');

  scrollBottom();
}

function renderEmpty() {
  document.getElementById('chat-messages').innerHTML = '<div class="empty-hint">选择或新建一个对话开始</div>';
  document.getElementById('chat-title').textContent = '基金AI助手';
  enableInput(false);
}

function scrollBottom() {
  const el = document.getElementById('chat-messages');
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function enableInput(on) {
  document.getElementById('chat-input').disabled = !on;
  document.getElementById('btn-send').disabled = !on;
}

// ---------- Image ----------

async function onFileChange(e) {
  const files = e.target.files;
  if (!files) return;
  const profile = getSelectedProfile();
  if (profile?.provider !== 'gemini') {
    toast('图片仅 Gemini 档案支持');
    e.target.value = '';
    return;
  }
  for (const f of Array.from(files)) {
    if (!f.type.startsWith('image/')) continue;
    const rawData = await fileToBase64(f);
    const { base64: data, mime } = await compressImage(rawData, f.type);
    pendingImages.push({ data, mime, preview: `data:${mime};base64,${data}` });
  }
  e.target.value = '';
  renderPendingImages();
}

function renderPendingImages() {
  const el = document.getElementById('pending-images');
  el.innerHTML = pendingImages.map((p, i) => `
    <div class="pending-img">
      <img src="${p.preview}">
      <button class="remove-img" data-idx="${i}">×</button>
    </div>
  `).join('');
  el.querySelectorAll('.remove-img').forEach(btn => {
    btn.onclick = () => { pendingImages.splice(+btn.dataset.idx, 1); renderPendingImages(); };
  });
}

// ---------- Send ----------

async function sendMessage() {
  if (isStreaming || !currentConvId) return;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text && !pendingImages.length) return;

  const profile = getSelectedProfile();
  if (!profile?.api_key) { toast('请先在设置页配置 API Key'); return; }

  isStreaming = true;
  enableInput(false);

  const attachments = pendingImages.map(p => ({ type: 'image', data: p.data, mime: p.mime }));
  input.value = '';
  input.style.height = 'auto';
  pendingImages = [];
  renderPendingImages();

  // 保存用户消息
  await store.addMessage(currentConvId, 'user', text, attachments);

  // 渲染用户消息
  const messagesEl = document.getElementById('chat-messages');
  const emptyHint = messagesEl.querySelector('.empty-hint');
  if (emptyHint) emptyHint.remove();

  let imgHTML = attachments.filter(a => a.type === 'image')
    .map(a => `<img src="data:${a.mime};base64,${a.data}" style="max-width:200px;margin-top:6px;">`).join('');
  messagesEl.insertAdjacentHTML('beforeend',
    `<div class="msg user"><div class="bubble">${esc(text)}${imgHTML}</div></div>`);

  // 添加 AI 占位气泡
  messagesEl.insertAdjacentHTML('beforeend',
    `<div class="msg assistant" id="streaming-msg"><div class="bubble typing">思考中…</div></div>`);
  scrollBottom();

  // 构造消息
  const history = await store.getMessages(currentConvId);
  const apiMsgs = buildApiMessages(history, profile);

  // 流式调用
  let fullText = '';
  const streamBubble = document.querySelector('#streaming-msg .bubble');

  try {
    for await (const chunk of streamChat(apiMsgs, profile)) {
      fullText += chunk;
      streamBubble.classList.remove('typing');
      streamBubble.innerHTML = renderMarkdown(fullText);
      scrollBottom();
    }
  } catch (e) {
    if (!fullText) {
      streamBubble.classList.remove('typing');
      streamBubble.parentElement.className = 'msg error';
      streamBubble.textContent = e.message;
    }
  }

  // 保存 AI 回复
  if (fullText) {
    await store.addMessage(currentConvId, 'assistant', fullText);
  }

  // 自动标题
  const conv = await store.getConversation(currentConvId);
  if (conv && (conv.title === '新对话' || !conv.title)) {
    const title = text.length > 25 ? text.slice(0, 25) + '…' : text;
    await store.updateConversation(currentConvId, { title });
    document.getElementById('chat-title').textContent = title;
    loadConversations();
  }

  // 清理
  const streamingMsg = document.getElementById('streaming-msg');
  if (streamingMsg) streamingMsg.removeAttribute('id');
  isStreaming = false;
  enableInput(true);
  document.getElementById('chat-input').focus();
}

function buildApiMessages(history, profile) {
  const customPrompt = store.getSystemPrompt();
  const msgs = [];

  // ====== System Prompt：技能框架 + 数据上下文 ======
  const contextBlocks = [];

  // 用户自定义人设（优先级最高）
  if (customPrompt) {
    contextBlocks.push(customPrompt);
  }

  // 四大技能框架
  contextBlocks.push(`你是一位专业的中国公募基金投资顾问，具备以下四大分析框架：

## 1. 郑希投资方法论（zhengxi-views）
基于易方达基金经理郑希（从业13.7年，年化24.7%）的公开投资方法：
- **景气度投资**：聚焦产业景气上行阶段，回避下行周期。关注ROE方向（上升拐点 > 绝对水平）
- **技术迭代**：AI正从"模型时代"进入"智能体Agent时代"，算力需求从训练转向推理
- **全球比较优势**：中国企业在光通信、PCB、半导体设备等领域具备全球竞争力
- **选股三件事**：产业空间 × 竞争格局 × 估值保护
- **卖出纪律**：产业逻辑破坏、估值透支2年以上、找到更好的标的

## 2. 量化筛选框架（mutual-fund-skills）
- **Calmar比率**：年化回报÷最大回撤绝对值，核心风险调整指标。>=8优秀，>=4良好，>=2一般，<1差
- **夏普比率**：超额收益÷波动率，衡量每单位风险的回报
- **回撤控制**：最大回撤>-30%良好，<-50%风险高
- **风格漂移**：持仓集中度>60%为高集中风格

## 3. 基金经理五维评价（fund-manager-eval）
- **资历**：从业年限、教育背景、赛道匹配度
- **业绩**：任期回报、Alpha归因（Beta驱动 vs 主动选股）、同类排名
- **风格稳定性**：持仓一致性、策略清晰度、跨基金表现相关性
- **风控**：最大回撤、压力测试、集中度风险
- **综合**：定性总结+关键判断，⭐评级（1-5星），定位（核心/卫星/观察/回避）

## 4. 策略回测框架（fund-strategy-backtest）
- **定投策略**：定期定额、智能定投（低位加码）
- **止盈策略**：目标收益止盈（+20%/+30%/+50%分批）、回撤止盈（从高点回撤-15%全出）
- **趋势策略**：Calmar>=8用趋势跟踪（20日均线），4-8用分批止盈，<4用定投或观望
- **补仓策略**：回撤超过-10%后分批补仓

## 输出原则
- 引用数据时注明来源（"根据你的持仓数据…"、"根据分析历史…"）
- 评分评级必须基于实际数据，不可凭空编造
- 不确定时明确说"数据不足，无法判断"
- 涉及具体操作建议时，必须声明"以上为分析框架推演，不构成投资建议"`);

  // 持仓数据上下文
  const holdings = store.getHoldings();
  if (holdings.length) {
    const lines = ['【我的持仓数据】'];
    const totalCost = holdings.reduce((s, h) => s + (parseFloat(h.cost) || 0), 0);
    const totalProfit = holdings.reduce((s, h) => s + (parseFloat(h.profit) || (parseFloat(h.market_value)||0) - (parseFloat(h.cost)||0)), 0);
    const totalToday = holdings.reduce((s, h) => s + (parseFloat(h.profit_today) || 0), 0);
    lines.push(`总成本: ¥${totalCost.toFixed(0)} | 总收益: ${totalProfit>=0?'+':''}¥${totalProfit.toFixed(0)} | 今日: ${totalToday>=0?'+':''}¥${totalToday.toFixed(2)}`);
    for (const h of holdings) {
      const share = parseFloat(h.share) || 0;
      const dwjz = parseFloat(h.dwjz) || 0;
      const cost = parseFloat(h.cost) || 0;
      const profit = parseFloat(h.profit) || 0;
      const profit_today = parseFloat(h.profit_today) || 0;
      const parts = [];
      if (share > 0) parts.push(`${share.toFixed(0)}份`);
      if (dwjz > 0) parts.push(`净值${dwjz.toFixed(4)}`);
      if (cost > 0) parts.push(`成本¥${cost.toFixed(0)}`);
      parts.push(`收益${profit>=0?'+':''}¥${profit.toFixed(0)}`);
      if (profit_today !== 0) parts.push(`今日${profit_today>=0?'+':''}¥${profit_today.toFixed(2)}`);
      lines.push(`- ${h.code} ${h.name} | ${parts.join(' | ')}`);
    }
    contextBlocks.push(lines.join('\n'));
  }

  // 分析历史数据上下文
  try {
    const analysisHistory = JSON.parse(localStorage.getItem('analysisHistory')) || [];
    if (analysisHistory.length > 0) {
      const lines = ['【分析页历史记录】（你在分析页查询过并评分过的基金）'];
      const recent = analysisHistory.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
      for (const h of recent) {
        const s = h.scores || {};
        const sm = h.summary || {};
        lines.push(`- ${h.code} ${h.name} | 综合: ${s.composite || sm.composite}/5 ${s.action || sm.action} | YTD ${sm.ytd != null ? (sm.ytd>=0?'+':'')+sm.ytd.toFixed(1)+'%' : '—'} | Calmar ${sm.calmar != null ? sm.calmar.toFixed(2) : '—'}${h.aiText ? ' | 有AI分析文本' : ''}`);
      }
      contextBlocks.push(lines.join('\n'));
    }
  } catch { /* ignore */ }

  // 关注人持仓上下文
  const followList = store.getFollowList();
  if (followList.length) {
    const lines = ['【关注人持仓】'];
    for (const person of followList) {
      const items = person.items || [];
      if (!items.length) continue;
      lines.push(`▸ ${person.name}: ${items.map(h => h.code + ' ' + h.name).join('、')}`);
    }
    contextBlocks.push(lines.join('\n'));
  }

  // 合并所有上下文为一个 system message
  const systemContent = contextBlocks.join('\n\n---\n\n');
  msgs.push({ role: 'system', content: systemContent });

  // 历史消息（最近20条避免太长）
  const recent = history.slice(-20);
  for (const m of recent) {
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: m.content, attachments: m.attachments || [] });
    } else if (m.role === 'assistant') {
      msgs.push({ role: 'assistant', content: m.content });
    }
  }

  return msgs;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
