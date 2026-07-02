// ===== app.js — 入口 =====

import { initChat, refreshProfileSelect } from './chat.js';
import { initHoldings } from './holdings.js';
import { initOverview, onOverviewVisible, onOverviewHidden } from './overview.js';
import { initCompare, onCompareVisible } from './compare.js';
import { initAnalysis, onAnalysisVisible } from './analysis.js';
import { initSettings } from './settings.js';

// Tab 切换
const tabs = document.querySelectorAll('.tab-btn');
const pages = document.querySelectorAll('.page');

function switchTab(tabName) {
  const prevTab = localStorage.getItem('activeTab');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  pages.forEach(p => p.classList.toggle('active', p.id === `page-${tabName}`));
  localStorage.setItem('activeTab', tabName);

  // 页面可见性回调
  if (tabName === 'overview') onOverviewVisible();
  else if (prevTab === 'overview') onOverviewHidden();
  if (tabName === 'analysis') onAnalysisVisible();
  if (tabName === 'compare') onCompareVisible();
}

tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// 初始化各页面
initChat(document.getElementById('page-chat'));
initHoldings(document.getElementById('page-holdings'));
initCompare(document.getElementById('page-compare'));
initOverview(document.getElementById('page-overview'));
initAnalysis();
initSettings(document.getElementById('page-settings'));

// 恢复上次 Tab（兼容旧值迁移）
let savedTab = localStorage.getItem('activeTab') || 'chat';
if (savedTab === 'briefing' || savedTab === 'qdii') savedTab = 'analysis';
if (savedTab === 'trend') savedTab = 'chat';
switchTab(savedTab);
