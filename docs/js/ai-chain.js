// ===== ai-chain.js — AI产业链趋势 =====

export async function renderAIContent(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    const data = await fetchJSON('./data/ai_chain/latest.json');
    if (!data || !data.modules || !data.modules.length) {
      container.innerHTML = '<div class="empty-hint">暂无数据，等待每日采集完成...</div>';
      return;
    }

    const history = await fetchJSON('./data/ai_chain/history.json');

    let html = '';

    // Summary header
    html += `<div style="padding:8px 0;font-size:12px;color:var(--text-soft);">更新: ${data.generatedAt || ''} · ${data.modules.length}个模块</div>`;

    // Top/Bottom rankings
    const rankings = data.rankings || {};
    const keyName = {};
    data.modules.forEach(m => keyName[m.key] = m.name);

    html += `<div class="trend-charts-row">`;
    html += rankingBox('top-industry', '🏆 产业评分 Top 5', rankings.topIndustry, keyName, data.modules, 'industryScore', '#3b82f6');
    html += rankingBox('top-rotation', '🔄 轮动空间 Top 5', rankings.topRotation, keyName, data.modules, 'rotationScore', '#10b981');
    html += rankingBox('bottom-rotation', '⚠️ 轮动风险 Bottom 5', rankings.bottomRotation, keyName, data.modules, 'rotationScore', '#ef4444');
    html += `</div>`;

    // Main table
    html += `<div class="trend-section"><table class="trend-table"><thead><tr>
      <th style="text-align:left;">模块</th>
      <th>产业评分</th>
      <th>市场评分</th>
      <th>轮动空间</th>
      <th>趋势</th>
      <th>信号</th>
    </tr></thead><tbody>`;

    const sorted = [...data.modules].sort((a, b) => b.rotationScore - a.rotationScore);
    for (const m of sorted) {
      const rotColor = m.rotationScore > 10 ? '#10b981' : m.rotationScore > 0 ? '#f59e0b' : '#ef4444';
      const trend = m.rotationScore > 5 ? '↑' : m.rotationScore < -5 ? '↓' : '→';
      const signalIcon = m.industrySignal === 'positive' ? '🟢' : m.industrySignal === 'negative' ? '🔴' : '⚪';
      html += `<tr>
        <td style="text-align:left;font-weight:500;">${m.name}</td>
        <td><b>${m.industryScore}</b></td>
        <td>${m.marketScore}</td>
        <td style="color:${rotColor};font-weight:600;">${m.rotationScore > 0 ? '+' : ''}${m.rotationScore}</td>
        <td>${trend}</td>
        <td>${signalIcon}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;

    // History chart
    if (history && history.length >= 2) {
      html += `<div class="trend-section" style="margin-top:8px;">
        <h4 style="margin:4px 0 6px;font-size:13px;">龙头模块趋势 (Top 3 Industry)</h4>
        <div id="ai-chain-timeline" style="height:220px;"></div>
      </div>`;
    }

    // Sources
    html += `<div class="trend-section trend-source" style="margin-top:12px;padding:8px;background:#f8fafc;border-radius:8px;">
      <small>📊 评分权重：产业周期 70% | 股市周期 30% | 轮动空间 = 产业 - 市场</small><br>
      <small>⚠️ 研究学习参考，非投资建议</small>
    </div>`;

    container.innerHTML = html;

    // Render timeline chart
    if (history && history.length >= 2 && window.echarts) {
      renderTimeline('ai-chain-timeline', history, data.rankings.topIndustry);
    }

  } catch (e) {
    container.innerHTML = '<div class="empty-hint">暂无数据</div>';
    console.error('AI chain error:', e);
  }
}

function rankingBox(id, title, keys, keyName, modules, scoreKey, color) {
  if (!keys || !keys.length) return '';
  const items = keys.map(k => {
    const m = modules.find(x => x.key === k);
    const s = m ? m[scoreKey] : 0;
    const sign = s > 0 && scoreKey === 'rotationScore' ? '+' : '';
    return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;">
      <span style="color:var(--text);">${keyName[k] || k}</span>
      <span style="font-weight:600;color:${color};">${sign}${s}</span>
    </div>`;
  }).join('');
  return `<div class="trend-chart-box"><h4 style="margin:0 0 6px;font-size:12px;color:${color};">${title}</h4>${items}</div>`;
}

function renderTimeline(containerId, history, topKeys) {
  const dom = document.getElementById(containerId);
  if (!dom || !topKeys || !topKeys.length) return;
  const chart = window.echarts.init(dom);
  const dates = history.map(h => h.date.slice(5));

  const series = topKeys.slice(0, 3).map(key => {
    const data = history.map(h => h.modules?.[key]?.i ?? null);
    const name = data.length > 0 ? key : key;
    return {
      name,
      type: 'line',
      data,
      smooth: true,
      symbol: 'none',
      lineStyle: { width: 2 },
    };
  });

  const option = {
    tooltip: { trigger: 'axis' },
    legend: { data: series.map(s => s.name), bottom: 0, textStyle: { fontSize: 11 } },
    grid: { left: 40, right: 16, top: 16, bottom: 36 },
    xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10, color: '#94a3b8' }, axisLine: { show: false } },
    yAxis: { type: 'value', min: 0, max: 100, splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { fontSize: 10 } },
    series,
  };
  chart.setOption(option);
  window.addEventListener('resize', () => chart.resize());
}

async function fetchJSON(path) {
  try {
    const resp = await fetch(path, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}
