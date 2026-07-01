// ===== trend.js — 趋势页主入口（含子Tab切换）=====
// 子Tab: 半导体设备 | AI产业链

import { renderGauge, renderRadar, renderTrendLine, renderIndicatorBars } from './trend-charts.js';
import { renderReport } from './trend-report.js';
import { renderAIContent } from './ai-chain.js';

let refreshTimer = null;
let daysRange = 30;
let activeSubTab = 'equipment';  // 'equipment' | 'ai-chain'

export function initTrend() {
  document.getElementById('btn-trend-refresh')?.addEventListener('click', () => refresh());
  // 恢复上次Tab
  activeSubTab = localStorage.getItem('trendSubTab') || 'equipment';
}

export function onTrendVisible() {
  refresh();
  startAutoRefresh();
}

export function onTrendHidden() {
  stopAutoRefresh();
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(refresh, 300000);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function refresh() {
  const content = document.getElementById('trend-content');
  if (!content) return;
  content.innerHTML = '';

  // Build sub-tab navigation
  let html = `<div class="trend-subtabs">
    <button class="trend-subtab ${activeSubTab === 'equipment' ? 'active' : ''}" data-tab="equipment">🔧 半导体设备</button>
    <button class="trend-subtab ${activeSubTab === 'ai-chain' ? 'active' : ''}" data-tab="ai-chain">🧠 AI产业链</button>
    <span style="margin-left:auto;font-size:11px;color:var(--text-soft);" id="trend-subtab-info"></span>
  </div>`;
  html += `<div id="trend-sub-content"></div>`;

  content.innerHTML = html;

  // Bind sub-tab clicks
  content.querySelectorAll('.trend-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSubTab = btn.dataset.tab;
      localStorage.setItem('trendSubTab', activeSubTab);
      refreshContent();
    });
  });

  refreshContent();
}

async function refreshContent() {
  if (activeSubTab === 'ai-chain') {
    await renderAIContent('trend-sub-content');
    const info = document.getElementById('trend-subtab-info');
    if (info) info.textContent = '产业评分(70%) | 市场评分(30%) | 轮动空间=产业-市场';
    return;
  }

  // === 半导体设备 ===
  const subContent = document.getElementById('trend-sub-content');
  if (!subContent) return;
  subContent.innerHTML = '<div class="empty-hint">加载中...</div>';

  try {
    const latest = await fetchJSON('./data/trend/latest.json');
    const historyAll = await fetchJSON('./data/trend/history.json');

    if (!latest) {
      subContent.innerHTML = '<div class="empty-hint">暂无数据，等待每日采集完成...</div>';
      return;
    }

    const history = historyAll ? historyAll.slice(-daysRange) : [];

    let html = '';

    // Top row: gauge cards
    html += `<div class="trend-gauges">
      <div id="gauge-composite" style="height:180px;width:33%;display:inline-block;vertical-align:top;"></div>
      <div id="gauge-module-a" style="height:180px;width:33%;display:inline-block;vertical-align:top;"></div>
      <div id="gauge-module-b" style="height:180px;width:33%;display:inline-block;vertical-align:top;"></div>
    </div>`;

    // Date range selector
    html += `<div class="trend-days-bar">
      ${[7, 30, 90, 365].map(d => `<button class="ov-filter-btn ${d === daysRange ? 'active' : ''}" data-days="${d}">${d}天</button>`).join('')}
      <span style="margin-left:auto;font-size:11px;color:var(--text-soft);">${latest.date || ''}</span>
    </div>`;

    // Charts row
    html += `<div class="trend-charts-row">
      <div class="trend-chart-box">
        <h4 style="margin:4px 0;font-size:13px;">产业周期 A 雷达</h4>
        <div id="radar-a" style="height:200px;"></div>
      </div>
      <div class="trend-chart-box">
        <h4 style="margin:4px 0;font-size:13px;">股市周期 B 雷达</h4>
        <div id="radar-b" style="height:200px;"></div>
      </div>
    </div>`;

    // Timeline
    if (history.length > 0) {
      html += `<div class="trend-section"><h4 style="margin:8px 0 4px;font-size:13px;">历史趋势</h4>
        <div id="timeline-chart" style="height:220px;"></div></div>`;
    }

    // Sub-indicator bars
    html += `<div class="trend-charts-row">
      <div class="trend-chart-box">
        <h4 style="margin:4px 0;font-size:13px;">产业周期子指标</h4>
        <div id="bars-a" style="height:200px;"></div>
      </div>
      <div class="trend-chart-box">
        <h4 style="margin:4px 0;font-size:13px;">股市周期子指标</h4>
        <div id="bars-b" style="height:200px;"></div>
      </div>
    </div>`;

    html += `<div id="trend-report-area"></div>`;

    // Sources
    html += `<div class="trend-section trend-source" style="margin-top:12px;padding:8px;background:#f8fafc;border-radius:8px;">
      <small>📊 数据来源：Yahoo Finance（美股）、东方财富（A股）、RSS（新闻）</small><br>
      <small>⚠️ 研究学习参考，非投资建议</small>
    </div>`;

    subContent.innerHTML = html;

    renderGauge('gauge-composite', latest.compositeScore, latest.compositeLabel);
    renderGauge('gauge-module-a', latest.moduleA.score, latest.moduleA.label);
    renderGauge('gauge-module-b', latest.moduleB.score, latest.moduleB.label);
    renderRadar('radar-a', latest.moduleA.subIndicators, 'A');
    renderRadar('radar-b', latest.moduleB.subIndicators, 'B');
    if (history.length > 0) renderTrendLine('timeline-chart', history);
    renderIndicatorBars('bars-a', latest.moduleA.subIndicators, '#3b82f6');
    renderIndicatorBars('bars-b', latest.moduleB.subIndicators, '#f59e0b');
    renderReport('trend-report-area', latest, history, '');

    subContent.querySelectorAll('.trend-days-bar .ov-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        daysRange = parseInt(btn.dataset.days);
        refreshContent();
      });
    });

    const timeEl = document.getElementById('trend-last-update');
    if (timeEl) timeEl.textContent = `更新: ${latest.generatedAt || ''}`;

  } catch (e) {
    subContent.innerHTML = '<div class="empty-hint">暂无数据</div>';
    console.error('Equipment trend error:', e);
  }
}

async function fetchJSON(path) {
  try {
    const resp = await fetch(path, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}
