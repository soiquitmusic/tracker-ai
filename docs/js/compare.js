// ===== compare.js - 持仓对比（横向滚动表格） =====
import * as store from './store.js';
import { toast, showModal, fetchWithDispatcher } from './utils.js';

let isRefreshing = false, cachedFundData = {};
let currentFilter = '全部', currentTypeFilter = '全部';
let leftSide = '_my_', rightSide = null;

function getOpts(){ const fl=store.getFollowList(); return [{id:'_my_',name:'我的持仓'},...fl.map(p=>({id:p.id,name:p.name||'关注人'}))]; }
function getItems(id){ return id==='_my_'?store.getHoldings():(store.getFollowList().find(p=>p.id===id)?.items||[]); }
function getName(id){ return id==='_my_'?'我':(store.getFollowList().find(p=>p.id===id)?.name||'对方'); }

export function initCompare(){
  window.addEventListener('holdings-changed',()=>refreshCompare());
  const fl=store.getFollowList(); if(!rightSide&&fl.length)rightSide=fl[0].id;
  renderPicker(); renderCompare();
}
export function onCompareVisible(){ renderPicker(); refreshCompare(); }

function renderPicker(){
  const el=document.getElementById('compare-picker');
  if(!el)return;
  const opts=getOpts();
  el.innerHTML=`
    <select id="cl" class="cmp-select">${opts.map(o=>`<option value="${o.id}" ${o.id===leftSide?'selected':''}>${esc(o.name)}</option>`).join('')}</select>
    <span class="cmp-vs">vs</span>
    <select id="cr" class="cmp-select">${opts.map(o=>`<option value="${o.id}" ${o.id===rightSide?'selected':''}>${esc(o.name)}</option>`).join('')}</select>
    <button id="btn-cmp" class="btn primary" style="font-size:12px;padding:4px 10px;">对比</button>
    <button id="btn-cmp-ref" class="btn" style="font-size:12px;padding:4px 8px;">刷新</button>
  `;
  document.getElementById('btn-cmp').onclick=()=>{ leftSide=document.getElementById('cl').value; rightSide=document.getElementById('cr').value; if(leftSide===rightSide){toast('请选不同对象');return;} refreshCompare(); };
  document.getElementById('btn-cmp-ref').onclick=refreshCompare;
}

// 自定义分类
function getCustomFilters(){ try{return JSON.parse(localStorage.getItem('overviewFilters'))||[];}catch{return[];} }
function saveCustomFilters(l){localStorage.setItem('overviewFilters',JSON.stringify(l));}

function renderFilterBar(tc){
  const el=document.getElementById('compare-filters'); if(!el)return;
  const custom=getCustomFilters();
  const rt=getName(rightSide),lt=getName(leftSide);
  const total=(tc?.common||0)+(tc?.onlyMe||0)+(tc?.onlyThem||0);
  let h='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;">';
  h+=`<button class="ov-filter-btn ${currentTypeFilter==='全部'?'active':''}" data-tf="全部">全部 ${total}</button>`;
  h+=`<button class="ov-filter-btn ${currentTypeFilter==='common'?'active':''}" data-tf="common">共同 ${tc?.common||0}</button>`;
  h+=`<button class="ov-filter-btn ${currentTypeFilter==='onlyThem'?'active':''}" data-tf="onlyThem">仅${esc(rt)} ${tc?.onlyThem||0}</button>`;
  h+=`<button class="ov-filter-btn ${currentTypeFilter==='onlyMe'?'active':''}" data-tf="onlyMe">仅${esc(lt)} ${tc?.onlyMe||0}</button>`;
  h+='<span style="color:#cbd5e1;margin:0 4px;">|</span>';
  const cats=['全部',...custom.map(f=>f.name)];
  cats.forEach(n=>{ h+=`<button class="ov-filter-btn ${n===currentFilter?'active':''}" data-f="${esc(n)}">${esc(n)}</button>`; });
  h+='<button class="ov-filter-btn add-filter" id="btn-add-cf">+</button></div>';
  el.innerHTML=h;
  el.querySelectorAll('[data-tf]').forEach(b=>{ b.onclick=()=>{currentTypeFilter=b.dataset.tf;renderCompare();}; });
  el.querySelectorAll('[data-f]').forEach(b=>{ b.onclick=()=>{currentFilter=b.dataset.f;renderCompare();}; });
  const ab=el.querySelector('#btn-add-cf'); if(ab)ab.onclick=openAddFilter;
}

function openAddFilter(){
  showModal('新增分类','<div class="form-group"><label>名称</label><input id="fn" placeholder="如:医药"></div><div class="form-group"><label>关键词(逗号分隔)</label><input id="fk" placeholder="如:医药,医疗,生物"></div>',[
    {text:'取消',onClick:(_,c)=>c()},
    {text:'添加',cls:'primary',onClick:(m,c)=>{ const n=m.querySelector('#fn').value.trim(),k=m.querySelector('#fk').value.trim(); if(!n||!k){toast('必填');return;} const l=getCustomFilters(); if(l.some(f=>f.name===n)){toast('已存在');return;} l.push({name:n,keywords:k.split(/[,，]/).map(s=>s.trim()).filter(Boolean)}); saveCustomFilters(l); currentFilter=n; renderCompare(); c(); }}
  ]);
}

function matchFilter(f,fn){
  if(fn==='全部')return true;
  const af=Object.fromEntries(getCustomFilters().map(f=>[f.name,f.keywords]));
  return (af[fn]||[]).some(k=>f.name&&f.name.includes(k));
}

// 估值获取
function fetchGz(code){
  return fetchWithDispatcher(code, 5000);
}

async function refreshCompare(){
  if(isRefreshing)return; isRefreshing=true;
  const btn=document.getElementById('btn-cmp-ref'); if(btn){btn.disabled=true;btn.classList.add('spinning');}
  try{
    const li=getItems(leftSide),ri=getItems(rightSide);
    const lm=new Map(); li.forEach(h=>{if(h.code)lm.set(h.code,h);});
    const rm=new Map(); ri.forEach(h=>{if(h.code)rm.set(h.code,h);});
    const all=[...new Set([...lm.keys(),...rm.keys()])];
    cachedFundData={};
    for(const c of all){ const d=await fetchGz(c); if(d)cachedFundData[c]=d; }
  }finally{ if(btn){btn.disabled=false;btn.classList.remove('spinning');} isRefreshing=false; }
  renderCompare();
}

function renderCompare(){
  const se=document.getElementById('compare-summary'),le=document.getElementById('compare-list');
  const li=getItems(leftSide),ri=getItems(rightSide);
  const ln=getName(leftSide),rn=getName(rightSide);
  if(!leftSide||!rightSide){se.innerHTML='';le.innerHTML='<div class="empty-hint">请选择对比对象</div>';return;}
  if(!li.length&&!ri.length){se.innerHTML='';le.innerHTML=`<div class="empty-hint">双方均无持仓</div>`;return;}

  const lm=new Map(); li.forEach(h=>{if(h.code)lm.set(h.code,h);});
  const rm=new Map(); ri.forEach(h=>{if(h.code)rm.set(h.code,h);});
  const all=[...new Set([...lm.keys(),...rm.keys()])];
  const rows=[];

  for(const code of all){
    const l=lm.get(code),r=rm.get(code),fd=cachedFundData[code];
    const gszzl=fd?(parseFloat(fd.gszzl)||0):null, name=l?.name||r?.name||code;
    const lMV=l?(parseFloat(l.market_value)||0):0, lCost=l?(parseFloat(l.cost)||0):0;
    const rMV=r?(parseFloat(r.market_value)||0):0, rCost=r?(parseFloat(r.cost)||0):0;
    const lTP=gszzl!==null&&lMV>0?lMV*gszzl/(100+gszzl):0;
    const rTP=gszzl!==null&&rMV>0?rMV*gszzl/(100+gszzl):0;
    const lP=lMV-lCost,rP=rMV-rCost;
    const lPR=lCost>0?(lP/lCost*100):0,rPR=rCost>0?(rP/rCost*100):0;
    let type='common'; if(!l)type='onlyThem'; else if(!r)type='onlyMe';
    rows.push({code,name,type,gszzl,lMV,lCost,lP,lPR,lTP,rMV,rCost,rP,rPR,rTP});
  }

  const cf=rows.filter(r=>matchFilter(r,currentFilter));
  const tc={common:cf.filter(r=>r.type==='common').length,onlyMe:cf.filter(r=>r.type==='onlyMe').length,onlyThem:cf.filter(r=>r.type==='onlyThem').length};
  renderFilterBar(tc);

  let ft=cf;
  if(currentTypeFilter!=='全部')ft=ft.filter(r=>r.type===currentTypeFilter);
  ft.sort((a,b)=>{ const ad=a.lTP+a.rTP,bd=b.lTP+b.rTP; if((ad>=0)!==(bd>=0))return ad>=0?-1:1; return ad>=0?bd-ad:ad-bd; });

  let flMV=0,flC=0,flTP=0,flP=0, frMV=0,frC=0,frTP=0,frP=0;
  ft.forEach(r=>{flMV+=r.lMV;flC+=r.lCost;flTP+=r.lTP;flP+=r.lP;frMV+=r.rMV;frC+=r.rCost;frTP+=r.rTP;frP+=r.rP;});
  const flR=flC>0?(flP/flC*100):0,frR=frC>0?(frP/frC*100):0;

  se.innerHTML=`<div class="ov-summary-bar">
    <span><b>${esc(ln)}</b> 市值 ¥${flMV.toFixed(0)}</span>
    <span>收益 <b class="${flP>=0?'profit-pos':'profit-neg'}">${flP>=0?'+':''}¥${flP.toFixed(0)}</b> <small>${flR>=0?'+':''}${flR.toFixed(2)}%</small></span>
    <span>今日 <b class="${flTP>=0?'profit-pos':'profit-neg'}">${flTP>=0?'+':''}¥${flTP.toFixed(2)}</b></span>
    <span style="color:#cbd5e1;">|</span>
    <span><b>${esc(rn)}</b> 市值 ¥${frMV.toFixed(0)}</span>
    <span>收益 <b class="${frP>=0?'profit-pos':'profit-neg'}">${frP>=0?'+':''}¥${frP.toFixed(0)}</b> <small>${frR>=0?'+':''}${frR.toFixed(2)}%</small></span>
    <span>今日 <b class="${frTP>=0?'profit-pos':'profit-neg'}">${frTP>=0?'+':''}¥${frTP.toFixed(2)}</b></span>
  </div>`;

  if(!ft.length){le.innerHTML='<div class="empty-hint">该分类下无匹配基金</div>';return;}

  const tmv=ft.reduce((s,r)=>s+r.lMV+r.rMV,0)||1;
  le.innerHTML=`<div class="ov-table-wrap"><table class="ov-table"><thead><tr>
    <th class="ov-th-name">基金名称</th><th>类型</th><th class="ov-th-num">涨幅</th>
    <th class="ov-th-num">${esc(ln)}金额</th><th class="ov-th-num">${esc(ln)}收益</th><th class="ov-th-num">${esc(ln)}今日</th>
    <th class="ov-th-num">${esc(rn)}金额</th><th class="ov-th-num">${esc(rn)}收益</th><th class="ov-th-num">${esc(rn)}今日</th>
  </tr></thead><tbody>${ft.map(f=>renderRow(f,ln)).join('')}</tbody></table></div>`;
}

function renderRow(f,ln){
  const gc=f.gszzl>=0?'profit-pos':'profit-neg';
  const fc=(v)=>(v||0)>=0?'profit-pos':'profit-neg';
  const fm=(v,c)=>v!==0?`<span class="${c}">${v>=0?'+':''}¥${v.toFixed(2)}</span>`:'—';
  const typeBadge={common:'<span class="diff-badge common">共同</span>',onlyMe:'<span class="diff-badge unique">仅'+esc(ln)+'</span>',onlyThem:'<span class="diff-badge unique">仅对方</span>'};
  return`<tr class="ov-tr">
    <td class="ov-td-name"><div class="ov-td-name-top"><span class="ov-td-code">${esc(f.code)}</span></div><div class="ov-td-name-text">${esc(f.name)}</div></td>
    <td>${typeBadge[f.type]||''}</td>
    <td class="ov-td-num ${gc}">${f.gszzl!==null?(f.gszzl>=0?'+':'')+f.gszzl.toFixed(2)+'%':'—'}</td>
    <td class="ov-td-num">${f.lMV>0?'¥'+f.lMV.toFixed(0):'—'}</td>
    <td class="ov-td-num ${fc(f.lP)}"><div>${f.lP!==0?(f.lP>=0?'+':'')+'¥'+f.lP.toFixed(0):'—'}</div><div class="ov-sub">${f.lCost>0?(f.lPR>=0?'+':'')+f.lPR.toFixed(1)+'%':''}</div></td>
    <td class="ov-td-num">${fm(f.lTP,fc(f.lTP))}</td>
    <td class="ov-td-num">${f.rMV>0?'¥'+f.rMV.toFixed(0):'—'}</td>
    <td class="ov-td-num ${fc(f.rP)}"><div>${f.rP!==0?(f.rP>=0?'+':'')+'¥'+f.rP.toFixed(0):'—'}</div><div class="ov-sub">${f.rCost>0?(f.rPR>=0?'+':'')+f.rPR.toFixed(1)+'%':''}</div></td>
    <td class="ov-td-num">${fm(f.rTP,fc(f.rTP))}</td>
  </tr>`;
}

function esc(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
