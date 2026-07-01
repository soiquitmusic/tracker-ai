// ===== trend.js — 半导体设备趋势页 (GitHub Pages 版) =====
// 数据来源: docs/data/trend/latest.json + history.json (由 GitHub Actions 每日生成)

import { renderGauge, renderRadar, renderTrendLine, renderIndicatorBars } from './trend-charts.js';
import { renderReport } from './trend-report.js';

let refreshTimer = null;
let daysRange = 30;

export function initTrend() {
  document.getElementById('btn-trend-refresh')?.addEventListener('click', () => refresh());
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
  refreshTimer = setInterval(refresh, 300000); // 5 min
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function refresh() {
  const content = document.getElementById('trend-content');
  if (!content) return;
  content.innerHTML = '<div class="empty-hint">加载中...</div>';

  try {
    // 从 GitHub Pages 静态 JSON 读取
    const latest = await fetchJSON('./data/trend/latest.json');
    const historyAll = await fetchJSON('./data/trend/history.json');

    if (!latest) {
      content.innerHTML = '<div class="empty-hint">暂无数据，等待每日采集完成...</div>';
      return;
    }

    // 按天数过滤历史
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

    content.innerHTML = html;

    // Render gauges
    renderGauge('gauge-composite', latest.compositeScore, latest.compositeLabel);
    renderGauge('gauge-module-a', latest.moduleA.score, latest.moduleA.label);
    renderGauge('gauge-module-b', latest.moduleB.score, latest.moduleB.label);

    // Render radars
    renderRadar('radar-a', latest.moduleA.subIndicators, 'A');
    renderRadar('radar-b', latest.moduleB.subIndicators, 'B');

    // Render timeline
    if (history.length > 0) {
      renderTrendLine('timeline-chart', history);
    }

    // Render bars
    renderIndicatorBars('bars-a', latest.moduleA.subIndicators, '#3b82f6');
    renderIndicatorBars('bars-b', latest.moduleB.subIndicators, '#f59e0b');

    // Render report (client-generated summary)
    renderReport('trend-report-area', latest, history, '');

    // Bind day selector
    content.querySelectorAll('.trend-days-bar .ov-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        daysRange = parseInt(btn.dataset.days);
        refresh();
      });
    });

    // Update time
    const timeEl = document.getElementById('trend-last-update');
    if (timeEl) timeEl.textContent = `更新: ${latest.generatedAt || ''}`;

  } catch (e) {
    content.innerHTML = `<div class="empty-hint">暂无数据，等待每日采集完成...</div>`;
    console.error('Trend error:', e);
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
