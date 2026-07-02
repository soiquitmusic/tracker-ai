// ===== trend-report.js — 报告渲染 =====

// 客户端生成简洁日报
export function renderReport(containerId, latest, history, _llmNarrative) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let html = '';

  // 简短的结论
  html += `<div class="trend-narrative" style="padding:10px 12px;">`;
  html += `<p style="margin-bottom:6px;"><strong>📋 今日结论</strong></p>`;
  const a_score = latest.moduleA?.score || 50;
  const b_score = latest.moduleB?.score || 50;
  const a_label = latest.moduleA?.label || '--';
  const b_label = latest.moduleB?.label || '--';
  html += `<p style="font-size:13px;line-height:1.6;">产业周期 <b>${a_score}</b> (${a_label}) · 股市周期 <b>${b_score}</b> (${b_label}) · 综合 <b>${latest.compositeScore}</b></p>`;

  // Top risers/fallers
  const all = [...(latest.moduleA?.subIndicators || []), ...(latest.moduleB?.subIndicators || [])];
  const top = all.filter(s => s.signal === 'positive').sort((a, b) => b.score - a.score);
  const bottom = all.filter(s => s.signal === 'negative').sort((a, b) => a.score - b.score);
  if (top.length) {
    html += `<p style="margin-top:6px;"><span style="color:#10b981;">▲</span> 强势: ${top.slice(0, 3).map(s => `${s.name}(${s.score})`).join(' ')}</p>`;
  }
  if (bottom.length) {
    html += `<p><span style="color:#ef4444;">▼</span> 承压: ${bottom.slice(0, 3).map(s => `${s.name}(${s.score})`).join(' ')}</p>`;
  }

  // 历史变化
  if (history && history.length >= 2) {
    const first = history[0];
    const chg = latest.compositeScore - first.compositeScore;
    const arrow = chg >= 0 ? '📈' : '📉';
    html += `<p style="margin-top:6px;font-size:12px;color:var(--text-soft);">${arrow} 近${history.length}天综合变化: ${chg > 0 ? '+' : ''}${chg.toFixed(1)}</p>`;
  }

  html += `</div>`;

  // Sub-indicator table
  html += `<div class="trend-section"><table class="trend-table"><thead><tr><th>指标</th><th>模块</th><th>评分</th><th>信号</th></tr></thead><tbody>`;
  for (const ind of all) {
    const icon = ind.signal === 'positive' ? '🟢' : ind.signal === 'negative' ? '🔴' : '⚪';
    html += `<tr><td>${ind.name}</td><td>${ind.module}</td><td><b>${ind.score}</b></td><td>${icon}</td></tr>`;
  }
  html += `</tbody></table></div>`;

  container.innerHTML = html;
}
