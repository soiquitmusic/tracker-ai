// ===== overview.js - 行情总览（横向滚动表格） =====
import * as store from './store.js';
import { toast, showModal, detectSectorFromHoldings } from './utils.js';

let refreshTimer = null, lastUpdateTime = null, fundRows = [], isRefreshing = false;
let currentGroupId = 'all', currentFilter = '全部';

const ALL_COLUMNS = [
  { key:'name', label:'基金名称', visible:true, fixed:true },
  { key:'sector', label:'关联板块', visible:true },
  { key:'change', label:'最新涨幅', visible:true },
  { key:'today', label:'当日收益', visible:true },
  { key:'est', label:'盘中估值', visible:true },
  { key:'profit', label:'持有收益', visible:true },
  { key:'1M', label:'近1月', visible:true },
  { key:'3M', label:'近3月', visible:true },
  { key:'6M', label:'近6月', visible:true },
  { key:'1Y', label:'近1年', visible:true },
  { key:'amount', label:'持仓金额', visible:true },
  { key:'nav', label:'估算净值', visible:true },
];

function getColumnConfig(){ try{ const s=JSON.parse(localStorage.getItem('ovColumns')); if(s&&s.length===ALL_COLUMNS.length)return s; }catch{} return ALL_COLUMNS; }
function saveColumnConfig(c){ localStorage.setItem('ovColumns',JSON.stringify(c)); }
function getCustomFilters(){ try{ return JSON.parse(localStorage.getItem('overviewFilters'))||[]; }catch{ return []; } }
function saveCustomFilters(l){ localStorage.setItem('overviewFilters',JSON.stringify(l)); }

export function initOverview(){
  document.getElementById('btn-refresh-overview').onclick = ()=>refreshAll();
  document.getElementById('btn-sort-overview').onclick = ()=>openColumnSettings();
  document.getElementById('btn-sort-overview').textContent = '⚙️';
  window.addEventListener('holdings-changed',()=>refreshAll());
  renderFilterBar(); refreshAll();
}
export function onOverviewVisible(){ refreshAll(); startAutoRefresh(); }
export function onOverviewHidden(){ stopAutoRefresh(); }

function startAutoRefresh(){ stopAutoRefresh(); refreshTimer=setInterval(()=>{if(isTradeTime())refreshAll(true);},30000); }
function stopAutoRefresh(){ if(refreshTimer){clearInterval(refreshTimer);refreshTimer=null;} }
function isTradeTime(){ const n=new Date(); if(n.getDay()===0||n.getDay()===6)return false; const t=n.getHours()*100+n.getMinutes(); return t>=930&&t<=1500; }

// ===== 数据获取 =====

async function fetchJ5Quick(code){
  try{
    const r=await fetch('https://j5.dfcfw.com/sc/tfs/qt/v2.0.1/'+code+'.json');
    if(!r.ok)return null;
    const d=await r.json();
    const jf=d.JJFX?.Datas||{};
    const jdzf=(d.JDZF||{}).Datas||[];
    const map={}; for(const it of jdzf){ const t=it.title,v=parseFloat(it.syl); if(t&&!isNaN(v))map[t]=v; }
    let sector='';
    try{ const st=(d.JJCCNEW?.data?.InverstPosition?.fundStocks||[]).slice(0,10); sector=detectSectorFromHoldings(st.map(s=>s.GPJC||'').filter(Boolean))[0]||''; }catch{}
    return { code,name:jf.SHORTNAME||'',dwjz:parseFloat(jf.DWJZ)||0,jzrq:'',gsz:0,gszzl:0,gztime:'',sector,
      periods:{'1M':map['1Y'],'3M':map['3Y'],'6M':map['6Y'],'1Y':map['1N'],'YTD':map['JN']} };
  }catch{ return null; }
}

let gzQ=Promise.resolve();
function fetchGz(code){
  return new Promise(resolve=>{
    gzQ=gzQ.then(()=>new Promise(done=>{
      const id='_ov_'+code; let settled=false;
      const finish=v=>{if(settled)return;settled=true;clearTimeout(tmr);const s=document.getElementById(id);if(s)s.remove();done();resolve(v);};
      const tmr=setTimeout(()=>finish(null),4000);
      window.jsonpgz=data=>finish(data||null);
      const s=document.createElement('script');s.id=id;
      s.src='https://fundgz.1234567.com.cn/js/'+code+'.js?rt='+Date.now();
      s.onerror=()=>finish(null); document.head.appendChild(s);
    }));
  });
}

async function fetchValuation(code){
  const j5=await fetchJ5Quick(code);
  if(!j5)return null;
  const gz=await fetchGz(code);
  if(gz){ j5.gsz=parseFloat(gz.gsz)||0; j5.gszzl=parseFloat(gz.gszzl)||0; j5.gztime=gz.gztime||''; j5.jzrq=gz.jzrq||''; if(gz.name&&!j5.name)j5.name=gz.name; }
  return j5;
}

// ===== 筛选栏 =====

function renderFilterBar(){
  const el=document.getElementById('overview-filters'); if(!el)return;
  const groups=store.getGroups(); const custom=getCustomFilters();
  const cats=['全部',...custom.map(f=>f.name)];
  let h='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">';
  if(groups.length){ h+='<span style="font-size:10px;color:var(--text-soft);">分组</span>';
    [{id:'all',name:'全部'},...groups].forEach(g=>h+=`<button class="ov-filter-btn ${g.id===currentGroupId?'active':''}" data-gid="${g.id}">${esc(g.name)}</button>`);
    h+='<span style="color:#cbd5e1;margin:0 4px;">|</span>'; }
  h+='<span style="font-size:10px;color:var(--text-soft);">赛道</span>';
  cats.forEach(n=>{ const isC=custom.some(f=>f.name===n);
    h+=`<button class="ov-filter-btn ${n===currentFilter?'active':''}" data-f="${esc(n)}">${esc(n)}${isC?`<span class="del-filter" data-del="${esc(n)}">×</span>`:''}</button>`; });
  h+='<button class="ov-filter-btn add-filter" id="btn-add-filter">+</button></div>';
  el.innerHTML=h;
  el.querySelectorAll('[data-gid]').forEach(b=>{ b.onclick=()=>{currentGroupId=b.dataset.gid;renderFilterBar();refreshAll(true);}; });
  el.querySelectorAll('[data-f]').forEach(b=>{ b.onclick=e=>{ if(e.target.classList.contains('del-filter')){ saveCustomFilters(getCustomFilters().filter(f=>f.name!==e.target.dataset.del)); if(currentFilter===e.target.dataset.del)currentFilter='全部'; renderFilterBar();renderTable();return; } currentFilter=b.dataset.f;renderFilterBar();renderTable(); }; });
  const ab=el.querySelector('#btn-add-filter'); if(ab)ab.onclick=openAddFilter;
}

function openAddFilter(){
  showModal('新增分类','<div class="form-group"><label>名称</label><input id="fn" placeholder="如:医药"></div><div class="form-group"><label>关键词(逗号分隔)</label><input id="fk" placeholder="如:医药,医疗,生物"></div>',[
    {text:'取消',onClick:(_,c)=>c()},
    {text:'添加',cls:'primary',onClick:(m,c)=>{ const n=m.querySelector('#fn').value.trim(),k=m.querySelector('#fk').value.trim(); if(!n||!k){toast('名称和关键词必填');return;} const kw=k.split(/[,，]/).map(s=>s.trim()).filter(Boolean); const l=getCustomFilters(); if(l.some(f=>f.name===n)){toast('名称已存在');return;} l.push({name:n,keywords:kw}); saveCustomFilters(l); currentFilter=n; renderFilterBar();renderTable(); c(); }}
  ]);
}

function matchFilter(f,fn){
  if(fn==='全部')return true;
  const af=Object.fromEntries(getCustomFilters().map(f=>[f.name,f.keywords]));
  return (af[fn]||[]).some(k=>f.name&&f.name.includes(k));
}

// ===== 主刷新 =====

async function refreshAll(silent){
  if(isRefreshing)return; isRefreshing=true;
  const btn=document.getElementById('btn-refresh-overview'), te=document.getElementById('overview-time');
  if(btn)btn.disabled=true;
  try{
    let hs=store.getHoldings().map(h=>store.normalizeHolding(h));
    if(currentGroupId!=='all'){ const gc=store.getGroupFundCodes(currentGroupId); hs=hs.filter(h=>gc.includes(h.code)); }
    if(!hs.length){ document.getElementById('overview-summary').innerHTML=''; document.getElementById('overview-list').innerHTML='<div class="empty-hint">暂无持仓</div>'; if(te)te.textContent=''; fundRows=[]; return; }
    if(!silent)document.getElementById('overview-list').innerHTML='<div class="empty-hint">正在获取行情…</div>';

    const codes=[...new Set(hs.filter(h=>h.code).map(h=>h.code))];
    const results=await Promise.all(codes.map(c=>Promise.race([fetchValuation(c),new Promise(r=>setTimeout(()=>r(null),12000))])));
    const vm={}; codes.forEach((c,i)=>{if(results[i])vm[c]=results[i];});

    let tc=0,tp=0,tt=0; const rows=[];
    for(const h of hs){
      const v=h.code?vm[h.code]:null;
      const cost=parseFloat(h.cost)||0,share=parseFloat(h.share)||0;
      let dwjz=parseFloat(h.dwjz)||0,gsz=0,gszzl=0,gztime='',jzrq=h.jzrq||'';
      if(v){ dwjz=v.dwjz||dwjz; gsz=v.gsz||0; gszzl=v.gszzl||0; gztime=v.gztime||''; jzrq=v.jzrq||jzrq; if(!h.name&&v.name)h.name=v.name; }
      const ts=new Date().toISOString().slice(0,10),hasToday=jzrq===ts,ln=parseFloat(h.lastNav)||0;
      const mv=share>0&&dwjz>0?share*dwjz:(parseFloat(h.market_value)||0);
      let tdp=0;
      if(hasToday&&ln>0&&dwjz>0)tdp=(dwjz-ln)*share;
      else if(!hasToday&&share>0&&gszzl!==0)tdp=mv-mv/(1+gszzl/100);
      else if(ln>0&&dwjz>0)tdp=(dwjz-ln)*share;
      else tdp=parseFloat(h.profit_today)||0;
      const profit=cost>0?mv-cost:(parseFloat(h.profit)||0);
      let sector=(v?.sector)||''; if(!sector)sector=inferSector(h.name||'');
      const periods=v?.periods||{};
      tc+=cost; tp+=profit; tt+=tdp;
      h.dwjz=dwjz; h.gsz=gsz; h.gszzl=gszzl; h.gztime=gztime; h.jzrq=jzrq;
      h.market_value=mv; h.profit=profit; h.profit_today=tdp;
      rows.push({...h,mv,profit,todayProfit:tdp,gszzl,dwjz,gsz,jzrq,gztime,share,cost,sector,periods});
    }
    fundRows=rows;
    const tmv=tc+tp,tr=tc>0?(tp/tc*100):0;
    document.getElementById('overview-summary').innerHTML=`<div class="ov-summary-bar"><span>市值 <b>¥${tmv.toFixed(0)}</b></span><span>收益 <b class="${tp>=0?'profit-pos':'profit-neg'}">${tp>=0?'+':''}¥${tp.toFixed(0)}</b> <small>${tr>=0?'+':''}${tr.toFixed(2)}%</small></span><span>今日 <b class="${tt>=0?'profit-pos':'profit-neg'}">${tt>=0?'+':''}¥${tt.toFixed(2)}</b></span><span>成本 <b>¥${tc.toFixed(0)}</b></span></div>`;
    renderTable();
    lastUpdateTime=new Date(); if(te)te.textContent=`${lastUpdateTime.getHours().toString().padStart(2,'0')}:${lastUpdateTime.getMinutes().toString().padStart(2,'0')} 更新`;
    if(isTradeTime()&&!refreshTimer)startAutoRefresh();
  }catch(e){ console.error('refreshAll:',e); document.getElementById('overview-list').innerHTML='<div class="empty-hint">加载失败，请刷新重试</div>'; }
  finally{ isRefreshing=false; if(btn)btn.disabled=false; }
}

// ===== 表格 =====

function renderTable(){
  const el=document.getElementById('overview-list'); if(!fundRows.length){el.innerHTML='<div class="empty-hint">暂无持仓</div>';return;}
  let ft=fundRows.filter(f=>matchFilter(f,currentFilter));
  const cols=getColumnConfig().filter(c=>c.visible),tmv=ft.reduce((s,f)=>s+(f.mv||0),0);
  el.innerHTML=`<div class="ov-table-wrap"><table class="ov-table"><thead><tr>${cols.map(c=>{const isF=c.key==='name'?' ov-th-name':'';const isN=c.key!=='name'&&c.key!=='sector'?' ov-th-num':'';return`<th class="${isF}${isN}">${c.label}</th>`;}).join('')}</tr></thead><tbody>${ft.map(f=>renderRow(f,tmv,cols)).join('')}</tbody></table></div>`;
}

function renderRow(f,tmv,cols){
  const mv=f.mv||0,gszzl=f.gszzl||0,pct=tmv>0?(mv/tmv*100):0,ratio=f.cost>0?(f.profit/f.cost*100):0,p=f.periods||{};
  const fmtP=v=>v!=null?`<span class="${v>=0?'profit-pos':'profit-neg'}">${v>=0?'+':''}${v.toFixed(1)}%</span>`:'<span class="na">—</span>';
  const R={
    name:()=>`<td class="ov-td-name"><div class="ov-td-name-top"><span class="ov-td-code">${esc(f.code)}</span><span class="ov-td-weight">${pct.toFixed(1)}%</span></div><div class="ov-td-name-text">${esc(f.name)}</div></td>`,
    sector:()=>`<td><span class="ov-sector-chip">${esc(f.sector||'—')}</span></td>`,
    change:()=>`<td class="ov-td-num ${gszzl>=0?'profit-pos':'profit-neg'}">${gszzl!==0?(gszzl>=0?'+':'')+gszzl.toFixed(2)+'%':'—'}</td>`,
    today:()=>{const c=f.todayProfit>=0?'profit-pos':'profit-neg';return`<td class="ov-td-num ${c}">${f.todayProfit!==0?(f.todayProfit>=0?'+':'')+'¥'+f.todayProfit.toFixed(2):'—'}</td>`;},
    est:()=>{const c=gszzl>=0?'profit-pos':'profit-neg';return`<td class="ov-td-num ${c}">${gszzl!==0?(gszzl>=0?'+':'')+gszzl.toFixed(2)+'%':'—'}</td>`;},
    profit:()=>`<td class="ov-td-num ${f.profit>=0?'profit-pos':'profit-neg'}"><div>${f.profit>=0?'+':''}¥${f.profit.toFixed(2)}</div><div class="ov-sub">${ratio>=0?'+':''}${ratio.toFixed(2)}%</div></td>`,
    '1M':()=>`<td class="ov-td-num">${fmtP(p['1M'])}</td>`,
    '3M':()=>`<td class="ov-td-num">${fmtP(p['3M'])}</td>`,
    '6M':()=>`<td class="ov-td-num">${fmtP(p['6M'])}</td>`,
    '1Y':()=>`<td class="ov-td-num">${fmtP(p['1Y'])}</td>`,
    amount:()=>`<td class="ov-td-num"><div>¥${mv.toFixed(0)}</div><div class="ov-sub">${(f.share||0)>0?(f.share||0).toFixed(0)+'份':''}</div></td>`,
    nav:()=>`<td class="ov-td-num"><div>${f.gsz>0?f.gsz.toFixed(4):(f.dwjz>0?f.dwjz.toFixed(4):'—')}</div><div class="ov-sub">${f.gztime?f.gztime.slice(-5):''}</div></td>`,
  };
  return`<tr class="ov-tr">${cols.map(c=>(R[c.key]||(()=>'<td>—</td>'))()).join('')}</tr>`;
}

// ===== 列设置 =====

function openColumnSettings(){
  const cols=getColumnConfig();
  const lh=cols.map((c,i)=>`<div class="col-setting-row" data-idx="${i}"><span class="col-drag-handle">⠿</span><label class="settings-toggle" style="flex:1;margin:0;"><input type="checkbox" ${c.visible?'checked':''} ${c.fixed?'disabled':''}>${c.label}${c.fixed?' (固定)':''}</label>${!c.fixed?`<button class="btn" style="font-size:10px;padding:2px 6px;" data-mv="${i}" data-dir="up">↑</button><button class="btn" style="font-size:10px;padding:2px 6px;" data-mv="${i}" data-dir="down">↓</button>`:''}</div>`).join('');
  showModal('列设置',`<div class="col-settings-list">${lh}</div>`,[
    {text:'重置',onClick:()=>{saveColumnConfig(ALL_COLUMNS);renderTable();}},
    {text:'确定',cls:'primary',onClick:(m,cl)=>{ const nc=[]; m.querySelectorAll('.col-setting-row').forEach(r=>{ const i=parseInt(r.dataset.idx),cb=r.querySelector('input'); if(i>=0&&i<cols.length)nc.push({...cols[i],visible:cb.checked}); }); if(nc.length){saveColumnConfig(nc);renderTable();} cl(); }}
  ]);
  setTimeout(()=>{ const mk=document.querySelector('.modal-mask'); if(!mk)return;
    mk.querySelectorAll('[data-mv]').forEach(b=>{ b.onclick=()=>{ const i=parseInt(b.dataset.mv),d=b.dataset.dir,cs=getColumnConfig(); if(cs[i].fixed)return; const si=d==='up'?i-1:i+1; if(si<0||si>=cs.length||cs[si].fixed)return; [cs[i],cs[si]]=[cs[si],cs[i]]; saveColumnConfig(cs); mk.remove(); openColumnSettings(); }; });
  },100);
}

function inferSector(n){ const nl=(n||'').toLowerCase(); if(/人工智能|ai/.test(nl))return'AI'; if(/半导体|芯片|集成电路/.test(nl))return'半导体'; if(/纳斯达克/.test(nl))return'美股'; if(/5g|通信/.test(nl))return'通信'; if(/机器人/.test(nl))return'机器人'; if(/信息|科技|互联网/.test(nl))return'科技'; if(/新能源|光伏/.test(nl))return'新能源'; if(/医药|医疗/.test(nl))return'医药'; if(/消费/.test(nl))return'消费'; if(/qdii|全球|海外/.test(nl))return'QDII'; return'其他'; }
function esc(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
