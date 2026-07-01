// ===== trend-charts.js — ECharts 图表渲染 =====

const COLORS = {
  positive: '#10b981',
  negative: '#ef4444',
  neutral: '#6b7280',
  moduleA: '#3b82f6',
  moduleB: '#f59e0b',
  composite: '#8b5cf6',
};

// 综合评分仪表盘（Gauge Chart）
export function renderGauge(containerId, score, label) {
  const dom = document.getElementById(containerId);
  if (!dom) return;
  const chart = window.echarts.init(dom);
  const option = {
    series: [{
      type: 'gauge',
      startAngle: 210,
      endAngle: -30,
      min: 0, max: 100,
      pointer: { show: true, length: '55%', width: 4 },
      progress: { show: true, width: 12, roundCap: true },
      axisLine: {
        lineStyle: {
          width: 12,
          color: [
            [0.35, COLORS.negative],
            [0.55, COLORS.neutral],
            [0.75, COLORS.moduleA],
            [1, COLORS.positive],
          ],
        },
      },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      detail: {
        fontSize: 28,
        fontWeight: 'bold',
        formatter: `{score}`,  // will be overridden
        offsetCenter: [0, '40%'],
        color: '#1e293b',
      },
      title: {
        offsetCenter: [0, '70%'],
        fontSize: 13,
        color: '#64748b',
      },
      data: [{ value: score, name: label || '' }],
    }],
  };
  chart.setOption(option);
  window.addEventListener('resize', () => chart.resize());
  return chart;
}

// 雷达图（10 维子指标）
export function renderRadar(containerId, indicators, module) {
  const dom = document.getElementById(containerId);
  if (!dom || !indicators.length) return;
  const chart = window.echarts.init(dom);
  const indicator = indicators.map(i => ({ name: i.name, max: 100 }));
  const data = indicators.map(i => i.score);
  const option = {
    radar: {
      indicator,
      shape: 'circle',
      center: ['50%', '50%'],
      radius: '65%',
      axisName: { color: '#475569', fontSize: 11 },
      splitArea: { areaStyle: { color: ['rgba(59,130,246,0.02)', 'rgba(59,130,246,0.05)'] } },
    },
    series: [{
      type: 'radar',
      data: [{ value: data, name: module || '' }],
      areaStyle: { color: module === 'A' ? 'rgba(59,130,246,0.2)' : 'rgba(245,158,11,0.2)' },
      lineStyle: { color: module === 'A' ? COLORS.moduleA : COLORS.moduleB, width: 2 },
      itemStyle: { color: module === 'A' ? COLORS.moduleA : COLORS.moduleB },
    }],
  };
  chart.setOption(option);
  window.addEventListener('resize', () => chart.resize());
  return chart;
}

// 趋势折线图
export function renderTrendLine(containerId, history) {
  const dom = document.getElementById(containerId);
  if (!dom || !history || !history.length) return;
  const chart = window.echarts.init(dom);
  const dates = history.map(h => h.date.slice(5));
  const option = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['综合', '产业周期', '股市周期'], bottom: 0, textStyle: { fontSize: 11 } },
    grid: { left: 40, right: 16, top: 20, bottom: 40 },
    xAxis: {
      type: 'category', data: dates,
      axisLabel: { fontSize: 10, color: '#94a3b8' },
      axisLine: { show: false },
    },
    yAxis: {
      type: 'value', min: 0, max: 100,
      splitLine: { lineStyle: { color: '#f1f5f9' } },
      axisLabel: { fontSize: 10 },
    },
    series: [
      {
        name: '综合', type: 'line', data: history.map(h => h.compositeScore),
        smooth: true, symbol: 'none',
        lineStyle: { color: COLORS.composite, width: 2.5 },
        areaStyle: { color: 'rgba(139,92,246,0.1)' },
      },
      {
        name: '产业周期', type: 'line', data: history.map(h => h.moduleAScore),
        smooth: true, symbol: 'none',
        lineStyle: { color: COLORS.moduleA, width: 2 },
      },
      {
        name: '股市周期', type: 'line', data: history.map(h => h.moduleBScore),
        smooth: true, symbol: 'none',
        lineStyle: { color: COLORS.moduleB, width: 2 },
      },
    ],
  };
  chart.setOption(option);
  window.addEventListener('resize', () => chart.resize());
  return chart;
}

// 子指标横向条图
export function renderIndicatorBars(containerId, indicators, moduleColor) {
  const dom = document.getElementById(containerId);
  if (!dom || !indicators.length) return;
  const chart = window.echarts.init(dom);
  const sorted = [...indicators].sort((a, b) => b.score - a.score);
  const option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: params => {
        const p = params[0];
        const ind = sorted[p.dataIndex];
        return `${ind.name}: ${ind.score}<br/>信号: ${ind.signal}<br/>权重: ${ind.weight}%`;
      },
    },
    grid: { left: 90, right: 40, top: 8, bottom: 8 },
    xAxis: { type: 'value', max: 100, axisLabel: { fontSize: 10 }, splitLine: { show: false } },
    yAxis: {
      type: 'category', data: sorted.map(i => i.name),
      axisLabel: { fontSize: 11, color: '#475569' },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [{
      type: 'bar', data: sorted.map(i => ({
        value: i.score,
        itemStyle: {
          color: i.signal === 'positive' ? COLORS.positive
               : i.signal === 'negative' ? COLORS.negative
               : moduleColor || COLORS.neutral,
          borderRadius: [0, 4, 4, 0],
        },
      })),
      barWidth: 14,
      label: { show: true, position: 'right', fontSize: 10, formatter: '{c}' },
    }],
  };
  chart.setOption(option);
  window.addEventListener('resize', () => chart.resize());
  return chart;
}
