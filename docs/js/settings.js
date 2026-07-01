// ===== settings.js — 设置页 =====

import * as store from './store.js';
import { PRESETS, streamChat } from './providers.js';
import { toast, showModal, getDataSource, setDataSource } from './utils.js';

let container;

export function initSettings(el) {
  container = el;
  document.getElementById('btn-add-profile').onclick = () => openProfileEditor();
  document.getElementById('btn-export').onclick = doExport;
  document.getElementById('btn-import').onclick = () => document.getElementById('import-file-input').click();
  document.getElementById('import-file-input').onchange = doImport;
  document.getElementById('btn-clear-all').onclick = doClear;
  document.getElementById('btn-clear-cache').onclick = doClearCache;

  // AI 人设
  const promptInput = document.getElementById('system-prompt-input');
  promptInput.value = store.getSystemPrompt();
  document.getElementById('btn-save-prompt').onclick = () => {
    store.setSystemPrompt(promptInput.value.trim());
    toast('人设已保存');
  };

  // 数据源设置
  document.getElementById('ds-fundgz').checked = getDataSource() === 1;
  document.getElementById('ds-sina').checked = getDataSource() === 2;
  document.querySelectorAll('input[name="dataSource"]').forEach(r => {
    r.onchange = () => { if (r.checked) setDataSource(parseInt(r.value)); toast('数据源已切换'); };
  });

  // 分组管理
  document.getElementById('btn-add-group').onclick = () => {
    const name = prompt('分组名称', '');
    if (name && name.trim()) { store.saveGroup({ name: name.trim() }); renderGroupsList(); }
  };
  renderGroupsList();

  // 经理观点 AI 设置
  const mvUseHoldings = document.getElementById('setting-mv-use-holdings');
  if (mvUseHoldings) {
    try {
      const cfg = JSON.parse(localStorage.getItem('mvChatConfig') || '{}');
      mvUseHoldings.checked = !!cfg.useHoldings;
    } catch { mvUseHoldings.checked = false; }
    mvUseHoldings.onchange = () => {
      try {
        const cfg = JSON.parse(localStorage.getItem('mvChatConfig') || '{}');
        cfg.useHoldings = mvUseHoldings.checked;
        localStorage.setItem('mvChatConfig', JSON.stringify(cfg));
        toast(mvUseHoldings.checked ? '已允许AI访问持仓数据' : '已禁止AI访问持仓数据');
      } catch {}
    };
  }

  renderProfiles();
}

export function renderProfiles() {
  const list = store.getProfiles();
  const el = document.getElementById('profiles-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty-hint">还没有 AI 档案，点击「新建档案」添加</div>';
    return;
  }
  el.innerHTML = list.map(p => `
    <div class="profile-card ${p.is_default ? 'default' : ''}">
      <div class="profile-name">
        ${p.is_default ? '⭐ ' : ''}${esc(p.name)}
      </div>
      <div class="profile-meta">
        <span class="profile-badge">${esc(p.provider)}</span>
        ${p.skill ? '<span class="profile-badge" style="background:#fef3c7;color:#92400e;">Skill</span>' : ''}
        ${esc(p.model)} · ${p.api_key ? 'Key已配' : '未配Key'}
      </div>
      <div class="profile-actions">
        <button class="btn" data-action="edit" data-id="${p.id}">编辑</button>
        <button class="btn" data-action="test" data-id="${p.id}">测试</button>
        ${!p.is_default ? `<button class="btn" data-action="default" data-id="${p.id}">设为默认</button>` : ''}
        <button class="btn danger" data-action="delete" data-id="${p.id}">删除</button>
      </div>
    </div>
  `).join('');

  el.querySelectorAll('[data-action]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'edit') openProfileEditor(store.getProfiles().find(p => p.id === id));
      else if (action === 'test') testProfile(id);
      else if (action === 'default') { store.setDefaultProfile(id); renderProfiles(); toast('已设为默认'); }
      else if (action === 'delete') {
        if (confirm('确认删除此档案？')) { store.deleteProfile(id); renderProfiles(); toast('已删除'); }
      }
    };
  });
}

function openProfileEditor(existing) {
  const isEdit = !!existing;
  const p = existing || { name: '', provider: 'gemini', base_url: '', model: '', api_key: '', is_default: false };

  const presetsHTML = Object.entries(PRESETS).map(([k, v]) =>
    `<button class="preset-btn" data-preset="${k}">${k}</button>`
  ).join('');

  const bodyHTML = `
    <div class="preset-row">${presetsHTML}</div>
    <div class="form-group"><label>名称</label><input id="pf-name" value="${esc(p.name)}"></div>
    <div class="form-group">
      <label>Provider</label>
      <select id="pf-provider">
        <option value="gemini" ${p.provider==='gemini'?'selected':''}>Gemini</option>
        <option value="openai_compat" ${p.provider==='openai_compat'?'selected':''}>OpenAI 兼容</option>
        <option value="claude" ${p.provider==='claude'?'selected':''}>Claude</option>
      </select>
    </div>
    <div class="form-group"><label>Base URL</label><input id="pf-url" value="${esc(p.base_url)}" placeholder="API 地址"></div>
    <div class="form-group"><label>模型</label><input id="pf-model" value="${esc(p.model)}" placeholder="如 gemini-2.5-flash"></div>
    <div class="form-group"><label>API Key</label><input id="pf-key" type="password" value="${esc(p.api_key)}" placeholder="输入 API Key"></div>
    <div class="form-group"><label><input id="pf-default" type="checkbox" ${p.is_default?'checked':''}> 设为默认档案</label></div>
  `;

  const { modal, close } = showModal(isEdit ? '编辑档案' : '新建档案', bodyHTML, [
    { text: '取消', onClick: (_, c) => c() },
    { text: '保存', cls: 'primary', onClick: (m, c) => {
      const data = {
        id: existing?.id,
        name: m.querySelector('#pf-name').value.trim(),
        provider: m.querySelector('#pf-provider').value,
        base_url: m.querySelector('#pf-url').value.trim(),
        model: m.querySelector('#pf-model').value.trim(),
        api_key: m.querySelector('#pf-key').value.trim(),
        is_default: m.querySelector('#pf-default').checked,
      };
      if (!data.name) { toast('名称不能为空'); return; }
      store.saveProfile(data);
      renderProfiles();
      c();
      toast(isEdit ? '已更新' : '已创建');
      // 通知聊天页刷新 profile 选择框
      window.dispatchEvent(new Event('profiles-changed'));
    }},
  ]);

  // 预设按钮
  modal.querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      modal.querySelector('#pf-provider').value = preset.provider;
      modal.querySelector('#pf-url').value = preset.base_url;
      modal.querySelector('#pf-model').value = preset.model;
      if (!modal.querySelector('#pf-name').value) {
        modal.querySelector('#pf-name').value = btn.dataset.preset;
      }
    };
  });
}

async function testProfile(id) {
  const p = store.getProfiles().find(x => x.id === id);
  if (!p) return;
  toast('测试中…', 10000);
  try {
    const msgs = [
      { role: 'system', content: '用一句话回答' },
      { role: 'user', content: '你是哪个模型？请用中文一句话回答。' },
    ];
    let result = '';
    for await (const chunk of streamChat(msgs, p)) { result += chunk; }
    showModal('测试结果', `<p style="line-height:1.7">${esc(result)}</p>`, [
      { text: '关闭', onClick: (_, c) => c() },
    ]);
  } catch (e) {
    showModal('测试失败', `<p style="color:var(--danger);line-height:1.7">${esc(e.message)}</p>`, [
      { text: '关闭', onClick: (_, c) => c() },
    ]);
  }
}

async function doExport() {
  toast('导出中…');
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `fund-ai-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('导出完成');
}

async function doImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await store.importAll(data);
    renderProfiles();
    window.dispatchEvent(new Event('profiles-changed'));
    toast('导入完成');
  } catch (err) {
    toast('导入失败：' + err.message);
  }
  e.target.value = '';
}

async function doClear() {
  if (!confirm('确认清空所有数据？此操作不可恢复！')) return;
  await store.clearAll();
  renderProfiles();
  window.dispatchEvent(new Event('profiles-changed'));
  toast('已清空');
}

async function doClearCache() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
    localStorage.removeItem('app_version');
    window.location.reload();
  } catch (e) {
    toast('清除失败: ' + e.message);
  }
}

function renderGroupsList() {
  const el = document.getElementById('groups-list-settings');
  if (!el) return;
  const groups = store.getGroups();
  const holdings = store.getHoldings();
  if (!groups.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text-soft);">暂无分组</div>'; return; }
  el.innerHTML = groups.map(g => {
    const count = (g.codes || []).length;
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;">
      <span style="font-size:13px;font-weight:500;flex:1;">${esc(g.name)} <span style="font-size:11px;color:var(--text-soft);">${count}只</span></span>
      <button class="btn" style="font-size:10px;padding:2px 6px;" data-edit-group="${g.id}">管理基金</button>
      <button class="btn" style="font-size:10px;padding:2px 6px;" data-rename-group="${g.id}">改名</button>
      <button class="btn danger" style="font-size:10px;padding:2px 6px;" data-del-group="${g.id}">删除</button>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-edit-group]').forEach(btn => {
    btn.onclick = () => openGroupFundPicker(btn.dataset.editGroup);
  });
  el.querySelectorAll('[data-rename-group]').forEach(btn => {
    btn.onclick = () => {
      const g = store.getGroups().find(x => x.id === btn.dataset.renameGroup);
      const name = prompt('新名称', g?.name || '');
      if (name && name.trim()) { store.saveGroup({ ...g, name: name.trim() }); renderGroupsList(); }
    };
  });
  el.querySelectorAll('[data-del-group]').forEach(btn => {
    btn.onclick = () => {
      if (!confirm('确认删除分组？基金不会删除。')) return;
      store.deleteGroup(btn.dataset.delGroup);
      renderGroupsList();
    };
  });
}

function openGroupFundPicker(groupId) {
  const group = store.getGroups().find(g => g.id === groupId);
  if (!group) return;
  const holdings = store.getHoldings();
  const listHTML = holdings.map(h => {
    const inGroup = (group.codes || []).includes(h.code);
    return `<div class="fund-picker-item" style="${inGroup?'background:var(--primary-bg);':''}">
      <span>${esc(h.code)} ${esc(h.name)}</span>
      <button class="btn" style="font-size:10px;padding:2px 6px;">${inGroup ? '移除' : '加入'}</button>
    </div>`;
  }).join('');

  showModal(`管理分组: ${group.name}`, `<div class="fund-picker-list">${listHTML}</div>`, [
    { text: '关闭', onClick: (_, c) => c() },
  ]);

  setTimeout(() => {
    document.querySelectorAll('.fund-picker-item button').forEach((btn, i) => {
      btn.onclick = () => {
        const code = holdings[i]?.code;
        if (!code) return;
        if ((group.codes || []).includes(code)) {
          store.removeFundFromGroup(groupId, code);
        } else {
          store.addFundToGroup(groupId, code);
        }
        document.querySelector('.modal-mask')?.remove();
        openGroupFundPicker(groupId);
      };
    });
  }, 100);
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
