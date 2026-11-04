(() => {
"use strict";
const data = window.PATTERNS_DATA || JSON.parse(document.getElementById("patterns-data").textContent);
const rows = Array.isArray(data.series) ? data.series : [];
const result = data.results || {};
const meta = data.meta || {};
const metrics = Array.isArray(data.metrics) ? data.metrics : [];
const entries = (data.grouping && data.grouping.entries) || [];
const entryByModel = new Map(entries.map(x => [String(x.model), x]));
const metricByKey = new Map(metrics.map(x => [x.key, x]));
const allCategories = (data.grouping && data.grouping.categories) || [];
const rules = Array.isArray(data.rules) ? data.rules : [];
const profiles = (data.forecast && data.forecast.profiles) || [];
const backtests = (data.forecast && data.forecast.backtests) || [];
const events = meta.calendar_events || [];
const sourceInsights = data.source_insights || {};
const PAGE_SIZE = 100;
const cache = new Map();
const metricDateWindows = new Map();
const domainLastPatterns = new Map();
const expandedEvidenceTitles = new Set();
const uiStorageKey="sales-patterns-ui:v2:"+[meta.sha256||meta.source_name||location.pathname,meta.date_start,meta.date_end].join("|");
let restoringRoute=false;
try{
  const saved=JSON.parse(sessionStorage.getItem(uiStorageKey)||"null");
  if(saved&&saved.version===2){
    for(const [key,value] of Object.entries(saved.metricDates||{}))if(value&&/^\d{4}-\d{2}-\d{2}$/.test(value.start)&&/^\d{4}-\d{2}-\d{2}$/.test(value.end)&&value.start<=value.end)metricDateWindows.set(key,value);
    for(const [key,value] of Object.entries(saved.domainPatterns||{}))if(typeof value==="string")domainLastPatterns.set(key,value);
  }
}catch(_){/* Browser storage may be unavailable for local files. URL state still works. */}
const numberFmt = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 1});
const integerFmt = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 0});
const pctFmt = new Intl.NumberFormat("zh-CN", {style:"percent", maximumFractionDigits:1});
const state = {
  page:"overview", pattern:"months", evidence:"daily", metric:"",
  category:"__ALL__", model:"__ALL__", stage:"",
  start:"", end:"", grain:"月", launchGrain:"周", compare:false, search:"", pageNo:0,
  forecastModel:"", forecastGrain:"月", profileKey:"",
  libraryTable:"rules", libraryMetric:"__ALL__", libraryCategory:"__ALL__", libraryStage:"__ALL__",libraryGrain:"__ALL__",
  sourceCurve:"", sourceHourMetric:"", sourceHourStage:""
};
const $ = id => document.getElementById(id);
const el = (tag, cls, text, parent) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (parent) parent.appendChild(n);
  return n;
};
const clear = n => { if (n) n.replaceChildren(); };
const dateOnly = v => v == null ? "" : String(v).slice(0, 10);
const num = v => typeof v === "number" && Number.isFinite(v) ? v : null;
const fmtNum = v => num(v) === null ? "—" : numberFmt.format(v);
const fmtInt = v => num(v) === null ? "—" : integerFmt.format(v);
const fmtPct = v => num(v) === null ? "—" : pctFmt.format(v);
const median = values => {
  const a = values.filter(v => num(v) !== null).sort((x,y) => x-y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
};
const quantile = (values, p) => {
  const a = values.filter(v => num(v) !== null).sort((x,y) => x-y);
  if (!a.length) return null;
  const k = (a.length - 1) * p, lo = Math.floor(k), hi = Math.min(lo+1, a.length-1);
  return a[lo] + (a[hi]-a[lo]) * (k-lo);
};
const unique = values => [...new Set(values.filter(v => v !== undefined && v !== null && String(v) !== ""))];
const safeArray = v => Array.isArray(v) ? v.map(String) : v == null ? [] : String(v).split(/[、,，;；]/).map(x => x.trim()).filter(Boolean);
const metricName = key => ({小订数量:"小订",留存大定:"留存大定",交车锁单:"锁单"}[key] || (metricByKey.get(key) || {}).label || key);
const metricSource = key => (metricByKey.get(key) || {}).source_label || key;
const categoryOf = model => {
  const x = entryByModel.get(String(model));
  return x && x.category ? String(x.category) : "未提供分类";
};
const isoAdd = (s, days) => {
  const d = dateOnly(s);
  if (!d) return "";
  const p = d.split("-").map(Number);
  const x = new Date(Date.UTC(p[0], p[1]-1, p[2] + days));
  return x.toISOString().slice(0,10);
};
const monthDays = (y,m) => new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
const isoWeekStart = d => {
  const wd = new Date(Date.UTC(Number(d.slice(0,4)), Number(d.slice(5,7))-1, Number(d.slice(8,10)))).getUTCDay();
  return isoAdd(d, -(wd === 0 ? 6 : wd-1));
};
const yearBounds = y => [String(y)+"-01-01", String(y)+"-12-31"];
const dateRangeDays = (a,b) => {
  if (!a || !b) return 0;
  return Math.max(0, Math.floor((Date.parse(b+"T00:00:00Z")-Date.parse(a+"T00:00:00Z"))/86400000)+1);
};
function setOptions(select, options, selected) {
  clear(select);
  select.disabled = !options.length;
  if (!options.length) { const o = el("option", "", "暂无可选项", select); o.value = ""; }
  for (const item of options) {
    const o = el("option", "", item.label, select);
    o.value = String(item.value);
  }
  if (options.some(x => String(x.value) === String(selected))) select.value = String(selected);
  else if (options.length) select.value = String(options[0].value);
}
function makeTable(container, headers, bodyRows, emptyText) {
  clear(container);
  const wrap = el("table", "data-table", null, container);
  const thead = el("thead", "", null, wrap), trh = el("tr", "", null, thead);
  headers.forEach(h => {const th=el("th", "", h, trh);th.scope="col";});
  container.tabIndex=0;container.setAttribute("role","region");container.setAttribute("aria-label","数据表，可横向滚动查看所有列");
  const tbody = el("tbody", "", null, wrap);
  if (!bodyRows.length) {
    const tr = el("tr", "", null, tbody), td = el("td", "table-empty", emptyText || "当前筛选没有可展示的合格样本。", tr);
    td.colSpan = headers.length;
    return;
  }
  for (const sourceRow of bodyRows) {
    const tr = el("tr", "", null, tbody);
    sourceRow.forEach((v, i) => {
      const cls = v && typeof v === "object" && "text" in v ? (v.cls || "") : "";
      const value = v && typeof v === "object" && "text" in v ? v.text : v;
      const td = el("td", cls, value == null ? "—" : value, tr);
      if (cls.includes("number")) td.title = String(value == null ? "" : value);
    });
  }
}
function emptyBox(container, title, detail) {
  clear(container);
  const box = el("div", "empty-state", null, container);
  el("strong", "", title, box);
  el("span", "", detail || "", box);
}
function optionRows(metric) {
  return rows.filter(r => r.metric === metric);
}
const metricBounds = new Map(metrics.map(m => {
  const dates = optionRows(m.key).map(r => dateOnly(r.date)).filter(Boolean).sort();
  return [m.key, dates.length ? [dates[0], dates[dates.length-1]] : ["",""]];
}));
const defaultMetric = metrics.find(m => m.key === "留存大定" && m.available) ||
                      metrics.find(m => m.available) || metrics.find(m => m.key === "留存大定") ||
                      metrics[0] || {key:"留存大定"};
state.metric = defaultMetric.key;
function scopeEntries(metric) {
  return entries.filter(x => safeArray(x.metrics).includes(metric) || optionRows(metric).some(r => String(r.model) === String(x.model)));
}
function scopedOptionRows(metric) {
  return optionRows(metric).filter(r => {
    const model = String(r.model || "");
    if (state.model !== "__ALL__" && model !== state.model) return false;
    if (state.model === "__ALL__" && state.category !== "__ALL__" && categoryOf(model) !== state.category) return false;
    return true;
  });
}
function scopedStages(metric) {
  if(metric==="小订数量")return optionRows(metric).length?["小订阶段"]:[];
  return unique(scopedOptionRows(metric).map(r => String(r.stage || "")).filter(Boolean)).sort((a,b)=>a.localeCompare(b,"zh-CN"));
}
function launchStageOptions() {
  const stages=scopedStages(state.metric);
  return ((state.page==="patterns"&&state.pattern==="launch")||state.page==="evidence")&&stages.includes("首销")&&stages.includes("平销")?stages.concat("首销及平销"):stages;
}
function stageMatches(row,kind) {
  if(state.metric==="小订数量")return ["小订","小订阶段","小订期"].includes(row.stage);
  const requested=String(state.stage||""),joint=requested==="首销及平销";
  if(kind==="launch_periods"){
    const stage=String(row.stage||"");
    return joint?["首销","平销","跨阶段"].includes(stage):stage===requested;
  }
  if(kind==="launch_pacing"){
    const current=String(row.current_stage||row.stage||""),previous=String(row.previous_stage||row.stage||"");
    if(current||previous){
      if(joint)return [current,previous].some(x=>["首销","平销","跨阶段"].includes(x));
      return current===requested&&previous===requested;
    }
  }
  if(joint)return ["首销","平销","跨阶段"].includes(String(row.stage||""));
  return row.stage===state.stage;
}
function matchingRows(baseRows, metric, useDate, kind) {
  const from = state.start, to = state.end;
  return baseRows.filter(r => {
    if (r.metric !== metric || !stageMatches(r,kind)) return false;
    const model = String(r.model || "");
    if (state.model !== "__ALL__" && model !== state.model) return false;
    if (state.model === "__ALL__" && state.category !== "__ALL__" && categoryOf(model) !== state.category) return false;
    if (useDate) {
      const d = dateOnly(r.date);
      if (d && ((from && d < from) || (to && d > to))) return false;
    }
    return true;
  });
}
function currentSeries(metric) {
  const key = [metric,state.category,state.model,state.stage,state.start,state.end].join("|");
  if (!cache.has("s:"+key)) cache.set("s:"+key, matchingRows(rows,metric,true));
  return cache.get("s:"+key);
}
function resultBase(name, metric) {
  const key = "r:"+name+"|"+metric+"|"+state.category+"|"+state.model+"|"+state.stage;
  if (!cache.has(key)) cache.set(key, matchingRows(result[name] || [], metric, false,name));
  return cache.get(key);
}
function setMetricSwitch() {
  document.querySelectorAll("[data-metric]").forEach(btn => {
    const m = metricByKey.get(btn.dataset.metric);
    const available = Boolean(m && m.available);
    btn.disabled = !available;
    btn.classList.toggle("is-selected", btn.dataset.metric === state.metric);
    btn.setAttribute("aria-pressed", btn.dataset.metric === state.metric ? "true" : "false");
    btn.title = available ? metricSource(btn.dataset.metric) : "原始数据未提供该指标";
  });
  $("metricSourceLabel").textContent = metricName(state.metric) + " · 源字段 " + metricSource(state.metric);
}
function updateFilters(resetDate) {
  clearDateError();
  const eligible = scopeEntries(state.metric);
  const categories = unique(eligible.map(x => x.category).filter(Boolean)).sort((a,b)=>a.localeCompare(b,"zh-CN"));
  const categoryOptions = [{value:"__ALL__",label:"全部分类"}].concat(categories.map(x=>({value:x,label:x})));
  if (!categoryOptions.some(o=>o.value===state.category)) state.category="__ALL__";
  setOptions($("categoryFilter"),categoryOptions,state.category);

  let models = eligible;
  if (state.category !== "__ALL__") models = models.filter(x=>String(x.category)===state.category);
  const modelOptions = [{value:"__ALL__",label:"全部车型"}].concat(unique(models.map(x=>String(x.model))).sort((a,b)=>a.localeCompare(b,"zh-CN")).map(x=>({value:x,label:x})));
  if (!modelOptions.some(o=>o.value===state.model)) state.model="__ALL__";
  setOptions($("modelFilter"),modelOptions,state.model);

  const stages = scopedStages(state.metric),stageOptions=launchStageOptions();
  const stagePref = stageOptions.includes(state.stage) ? state.stage : stages.includes("平销") ? "平销" : stages.includes("首销") ? "首销" : stages[0] || "";
  state.stage = stagePref;
  setOptions($("stageFilter"),stageOptions.map(x=>({value:x,label:x==="小订阶段"?"小订期":x})),stagePref);

  const bounds = metricBounds.get(state.metric) || ["",""];
  if (resetDate || !state.start || !state.end) {
    state.start = bounds[0]; state.end = bounds[1];
  } else {
    if (bounds[0] && state.start < bounds[0]) state.start=bounds[0];
    if (bounds[1] && state.end > bounds[1]) state.end=bounds[1];
    if (bounds[0] && state.end < bounds[0]) {state.start=bounds[0];state.end=bounds[1];}
    if (state.start > state.end) {state.start=bounds[0];state.end=bounds[1];}
  }
  $("dateStart").min = bounds[0]; $("dateStart").max = bounds[1];
  $("dateEnd").min = bounds[0]; $("dateEnd").max = bounds[1];
  $("dateStart").value = state.start; $("dateEnd").value = state.end;
  setMetricSwitch();
}
function inScope(row, metric) {
  if (row.metric !== metric || !stageMatches(row)) return false;
  const model=String(row.model||"");
  if (state.model!=="__ALL__" && model!==state.model) return false;
  if (state.model==="__ALL__" && state.category!=="__ALL__" && categoryOf(model)!==state.category) return false;
  return true;
}
function fullComparedPeriod(row, kind) {
  const s=dateOnly(row.start), e=dateOnly(row.end), ps=dateOnly(row.previous_start), pe=dateOnly(row.previous_end);
  if (!s || !e || !ps || !pe || !state.start || !state.end) return false;
  if (ps < state.start || pe > state.end || s < state.start || e > state.end) return false;
  if (kind==="周") return e===isoAdd(s,6) && ps===isoAdd(s,-7) && pe===isoAdd(ps,6);
  if (kind==="月") {
    const [y,m]=s.split("-").map(Number), prev=new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,10);
    return s===y+"-"+String(m).padStart(2,"0")+"-01" && e===y+"-"+String(m).padStart(2,"0")+"-"+String(monthDays(y,m)).padStart(2,"0") &&
           ps===prev && pe===isoAdd(s,-1);
  }
  if (kind==="年") {
    const y=Number(s.slice(0,4));
    return s===String(y)+"-01-01" && e===String(y)+"-12-31" && ps===String(y-1)+"-01-01" && pe===String(y-1)+"-12-31";
  }
  return true;
}
function comparisons(kind, metric) {
  return resultBase("period_comparisons",metric).filter(r =>
    r.kind===kind && r.status==="有效" &&
    !(Number(r.current_negative_days||0)>0 || Number(r.previous_negative_days||0)>0) &&
    num(r.daily_ratio)!==null && fullComparedPeriod(r,kind)
  );
}
function summary(rowsIn, field) {
  const byModel=new Map(),byPeriod=new Map();
  const periodKey=r=>{
    let p=dateOnly(r.start)||dateOnly(r.week);
    if(!p&&r.period!=null)p=String(r.period);
    if(!p&&r.cycle!=null)p=String(r.cycle);
    if(!p&&r.year!=null){
      if(r.month!=null)p=String(r.year)+"-"+String(r.month).padStart(2,"0");
      else if(r.holiday)p=String(r.year)+"|"+String(r.holiday);
      else p=String(r.year);
    }
    return p||"__all__";
  };
  let samples=0;
  for(const r of rowsIn){
    const value=num(r[field]);if(value===null)continue;
    const model=String(r.model||"");
    if(!byModel.has(model))byModel.set(model,[]);
    byModel.get(model).push(value);
    const p=periodKey(r);
    if(!byPeriod.has(p))byPeriod.set(p,new Map());
    const models=byPeriod.get(p);
    if(!models.has(model))models.set(model,[]);
    models.get(model).push(value);
    samples++;
  }
  const modelMedians=[...byModel.values()].map(median).filter(v=>v!==null);
  const periodMedians=[...byPeriod.values()].map(models=>median([...models.values()].map(median))).filter(v=>v!==null);
  return {typical:median(modelMedians),p25:quantile(periodMedians,.25),p75:quantile(periodMedians,.75),
          models:byModel.size,periods:byPeriod.size,samples};
}
function rangeCompleteRows(name,metric,kind) {
  const base=resultBase(name,metric);
  if (name==="weekly") return base.filter(r=>{
    const s=dateOnly(r.week), e=isoAdd(s,6);
    return s && s>=state.start && e<=state.end && Array.isArray(r.indexes) && r.indexes.length===7;
  });
  if (name==="monthly") return base.filter(r=>{
    const y=Number(r.year),m=Number(r.month),s=String(y)+"-"+String(m).padStart(2,"0")+"-01",e=String(y)+"-"+String(m).padStart(2,"0")+"-"+String(monthDays(y,m)).padStart(2,"0");
    return s>=state.start && e<=state.end;
  });
  if (name==="annual") return base.filter(r=>{
    const y=Number(r.year),[s,e]=yearBounds(y);
    return s>=state.start && e<=state.end && Array.isArray(r.indexes) && r.indexes.length===12 && r.status==="有效";
  });
  if (name==="lifecycle") return base.filter(r=>{
    const cyc=dateOnly(r.cycle), last=isoAdd(cyc,6);
    return cyc && cyc>=state.start && last<=state.end;
  });
  return base;
}
function currentEvents() {
  return events.filter(e=>{
    const s=isoAdd(e.start,-7),z=isoAdd(e.end,7);
    return s>=state.start && z<=state.end;
  });
}
function holidayRows(metric) {
  const valid=new Set(currentEvents().map(e=>String(e.year)+"|"+String(e.holiday)));
  return resultBase("holidays",metric).filter(r=>valid.has(String(r.year)+"|"+String(r.holiday)));
}
function activeComparisons(kind,metric) { return comparisons(kind,metric); }
function addKpi(grid,label,value,foot) {
  const card=el("article","kpi-card",null,grid),top=el("div","kpi-top",null,card);
  el("span","",label,top);el("i","kpi-bullet","",top);
  el("strong","kpi-value",value,card);el("small","kpi-foot",foot||"",card);
}
function sEl(tag,attrs,text) {
  const n=document.createElementNS("http://www.w3.org/2000/svg",tag);
  Object.keys(attrs||{}).forEach(k=>n.setAttribute(k,String(attrs[k])));
  if(text!==undefined)n.textContent=String(text);
  return n;
}
function chartEmpty(container,message) { clear(container);el("div","chart-empty",message,container); }
function makeTrendPoints(series, grain) {
  const buckets=new Map();
  for(const r of series){
    const d=dateOnly(r.date);if(!d)continue;
    let key=d;
    if(grain==="周")key=isoWeekStart(d);
    if(grain==="月")key=d.slice(0,7);
    if(grain==="年")key=d.slice(0,4);
    if(!buckets.has(key))buckets.set(key,{key,value:0,dates:new Set(),models:new Set(),negative:0});
    const b=buckets.get(key),v=num(r.value);
    if(v===null)continue;
    b.value+=v;b.dates.add(d);b.models.add(String(r.model));
    if(v<0)b.negative++;
  }
  return [...buckets.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(b=>{
    let expected=1;
    if(grain==="周")expected=7;
    else if(grain==="月"){const p=b.key.split("-").map(Number);expected=monthDays(p[0],p[1]);}
    else if(grain==="年")expected=new Date(Date.UTC(Number(b.key)+1,0,0)).getUTCDate();
    return {...b,observed:b.dates.size,expected};
  });
}
function renderLine(container,points,title,color,grain) {
  clear(container);el("div","chart-box-title",title,container);
  if(!points.length){chartEmpty(container,"当前车型、阶段和日期范围内没有观测。");return;}
  const w=Math.max(320,Math.min(850,container.clientWidth||(innerWidth<850?innerWidth-54:innerWidth-300))),h=250,left=60,right=22,top=12,bottom=43,pw=w-left-right,ph=h-top-bottom;
  const svg=sEl("svg",{viewBox:"0 0 "+w+" "+h,class:"chart-svg",role:"img","aria-label":title+"趋势图"});
  const values=points.map(p=>p.value),lo=Math.min(0,...values),hi=Math.max(0,...values);
  const span=(hi-lo)||1,pad=span*.08,min=lo<0?lo-pad:0,max=hi+pad;
  const y=v=>top+(max-v)/(max-min)*ph;
  for(let i=0;i<=4;i++){
    const val=max-(max-min)*i/4,yy=top+ph*i/4;
    svg.appendChild(sEl("line",{x1:left,y1:yy,x2:w-right,y2:yy,class:"chart-gridline"}));
    svg.appendChild(sEl("text",{x:left-8,y:yy+3,"text-anchor":"end",class:"chart-label"},integerFmt.format(val)));
  }
  svg.appendChild(sEl("line",{x1:left,y1:top+ph,x2:w-right,y2:top+ph,class:"chart-axis"}));
  const x=i=>points.length===1?left+pw/2:left+i*pw/(points.length-1);
  const d=points.map((p,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+y(p.value).toFixed(1)).join(" ");
  if(points.length>1){
    const area=sEl("path",{d:d+" L"+x(points.length-1).toFixed(1)+" "+y(0).toFixed(1)+" L"+x(0).toFixed(1)+" "+y(0).toFixed(1)+" Z",class:"chart-area"});
    area.style.fill=color;svg.appendChild(area);
  }
  const line=sEl("path",{d,class:"chart-series"});line.style.stroke=color;svg.appendChild(line);
  if(points.length<=32)points.forEach((p,i)=>{
    const point=sEl("circle",{cx:x(i),cy:y(p.value),r:3.3,class:"chart-point"});
    point.style.stroke=color;svg.appendChild(point);
  });
  const ticks=points.length<=8?points.map((_,i)=>i):[0,Math.round((points.length-1)/3),Math.round((points.length-1)*2/3),points.length-1];
  unique(ticks).forEach(i=>{
    const p=points[i],label=String(p.key).length>7?String(p.key).slice(0,7):String(p.key);
    svg.appendChild(sEl("text",{x:x(i),y:h-16,"text-anchor":i===0?"start":i===points.length-1?"end":"middle",class:"chart-label"},label));
  });
  container.appendChild(svg);
  const coverage=points.map(p=>p.observed+"/"+p.expected).filter(x=>x!=="1/1");
  const caption=el("div","chart-caption","");caption.textContent="观测周期 "+points.length+" 个；每点合计所选车型在该口径、阶段下的观测值。未观测日期不补零。"+(coverage.length?" 周/月/年内有效日期覆盖可能不完整。":"");
}
function chartTrend(series,grain){
  const pts=makeTrendPoints(series,grain);
  return pts;
}
function renderTrend(){
  if(state.metric==="小订数量"){state.compare=false;$("compareMetrics").checked=false;}
  $("compareMetrics").disabled=state.metric==="小订数量";
  const primary=currentSeries(state.metric),other=state.compare?currentSeries(state.metric==="留存大定"?"交车锁单":"留存大定"):[];
  const grid=$("trendCharts");clear(grid);
  grid.classList.toggle("is-comparison",state.compare);
  const legend=$("trendLegend");clear(legend);
  const theme=getComputedStyle(document.documentElement);
  const colorPrimary=theme.getPropertyValue("--blue2").trim(),colorOther=theme.getPropertyValue("--teal").trim();
  const a=el("span","legend-item",null,legend);el("i","legend-swatch","",a).style.background=colorPrimary;el("span","",metricName(state.metric)+"（"+metricSource(state.metric)+"）",a);
  if(state.compare){const key=state.metric==="留存大定"?"交车锁单":"留存大定";const b=el("span","legend-item",null,legend);el("i","legend-swatch","",b).style.background=colorOther;el("span","",metricName(key)+"（"+metricSource(key)+"）",b);}
  const one=el("div","chart-box","",grid);renderLine(one,chartTrend(primary,state.grain),metricName(state.metric)+" · "+state.stage,colorPrimary,state.grain);
  if(state.compare){const key=state.metric==="留存大定"?"交车锁单":"留存大定";const two=el("div","chart-box","",grid);renderLine(two,chartTrend(other,state.grain),metricName(key)+" · 同阶段 "+state.stage,colorOther,state.grain);}
  $("trendCaption").textContent="两个口径若同时对照，会分别使用各自纵轴，数值不会相加。分类汇总会受到不同日期车型覆盖变化影响。";
}
function groupedStats(rowsIn,field,keyFn,periodFn){
  const groups=new Map();
  for(const r of rowsIn){
    const key=keyFn(r),value=num(r[field]);if(value===null)continue;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(r);
  }
  return [...groups].map(([key,items])=>{
    const samples=items.map(r=>{
      const x={model:r.model,start:r.start,week:r.week,year:r.year,month:r.month,holiday:r.holiday,period:r.period,cycle:r.cycle};
      if(periodFn)x.start=periodFn(r);
      x[field]=r[field];
      return x;
    });
    const stats=summary(samples,field);
    return {key,median:stats.typical,p25:stats.p25,p75:stats.p75,n:stats.samples,models:stats.models,periods:stats.periods};
  }).sort((a,b)=>{
    const ma=String(a.key).match(/^(\d+)月$/),mb=String(b.key).match(/^(\d+)月$/);
    if(ma&&mb)return Number(ma[1])-Number(mb[1]);
    return String(a.key).localeCompare(String(b.key),"zh-CN");
  });
}
function drawBars(container,items,labelKey,valueKey,formatValue,kind,options={}){
  clear(container);
  const usable=items.filter(x=>num(x[valueKey])!==null);
  if(!usable.length){el("div","chart-empty","没有满足条件的可用样本。",container);return;}
  if(kind==="horizontal"){
    const max=Math.max(1,...usable.map(x=>Math.abs(x[valueKey])));
    usable.forEach(x=>{
      const row=el("div","bar-row",null,container);el("span","bar-label",x[labelKey],row);
      const track=el("div","bar-track","",row),fill=el("div","bar-fill","",track);fill.style.width=(Math.max(1,Math.abs(x[valueKey])/max*100))+"%";
      el("strong","bar-value",formatValue(x[valueKey]),row);
    });
    return;
  }
  const w=options.width||760,h=options.height||210,left=options.axes?52:34,right=8,top=12,bottom=42,pw=w-left-right,ph=h-top-bottom,max=Math.max(options.minimum??1,...usable.map(x=>x[valueKey]));
  const svg=sEl("svg",{viewBox:"0 0 "+w+" "+h,role:"img","aria-label":"规律对比柱状图"});
  for(let i=0;i<=3;i++){const yy=top+ph*i/3;svg.appendChild(sEl("line",{x1:left,y1:yy,x2:w-right,y2:yy,class:"chart-gridline"}));if(options.axes)svg.appendChild(sEl("text",{x:left-8,y:yy+3,"text-anchor":"end",class:"chart-label"},formatValue(max*(1-i/3))));}
  const step=pw/usable.length,bw=Math.min(36,step*.62);
  usable.forEach((x,i)=>{
    const bh=Math.max(1,x[valueKey]/max*ph),bx=left+i*step+(step-bw)/2,by=top+ph-bh;
    const rect=sEl("rect",{x:bx,y:by,width:bw,height:bh,rx:3,class:i%2&&!options.singleColor?"chart-bar is-teal":"chart-bar"});
    const title=sEl("title",{},String(x[labelKey])+": "+formatValue(x[valueKey])+(x.n?" · n="+x.n:""));rect.appendChild(title);svg.appendChild(rect);
    svg.appendChild(sEl("text",{x:bx+bw/2,y:h-17,"text-anchor":"middle",class:"chart-label"},String(x[labelKey])));
  });
  container.appendChild(svg);
}
function card(container,title,subtitle){
  const c=el("section","pattern-card",null,container);el("h3","",title,c);if(subtitle)el("p","",subtitle,c);return c;
}
function miniKpis(container,items){
  clear(container);items.forEach(x=>{const c=el("div","kpi-card",null,container),t=el("div","kpi-top","",c);el("span","",x.label,t);el("i","kpi-bullet","",t);el("strong","kpi-value",x.value,c);el("small","kpi-foot",x.foot||"",c);});
}
function monthSeasonRows(metric){
  const annual=state.stage==="平销"?rangeCompleteRows("annual",metric):[];
  const buckets=Array.from({length:12},()=>[]);
  annual.forEach(r=>r.indexes.forEach((v,i)=>{
    if(num(v)!==null)buckets[i].push({model:String(r.model),year:Number(r.year),start:String(r.year)+"-"+String(i+1).padStart(2,"0")+"-01",value:v});
  }));
  return buckets.map((items,i)=>{
    const stats=summary(items,"value");
    return {month:(i+1)+"月",monthNo:i+1,median:stats.typical,p25:stats.p25,p75:stats.p75,
      models:stats.models,years:stats.periods,n:stats.samples};
  });
}
function lifecycleRows(metric){
  return rangeCompleteRows("lifecycle",metric).filter(r=>num(r.d1_ratio)!==null&&num(r.first2_share)!==null);
}
function weeklyStats(metric){
  const valid=rangeCompleteRows("weekly",metric);
  const labels=["周一","周二","周三","周四","周五","周六","周日"];
  const weekday=labels.map((label,i)=>{
    const samples=valid.map(r=>({model:r.model,start:r.week,value:num(r.indexes[i])})).filter(r=>r.value!==null);
    const stats=summary(samples,"value");
    return {label,value:stats.typical,p25:stats.p25,p75:stats.p75,n:stats.samples,models:stats.models,periods:stats.periods};
  });
  return {valid,weekday};
}
function monthEndRows(metric){
  return rangeCompleteRows("monthly",metric).filter(r=>num(r.ratio)!==null);
}
function holidayPhaseRows(metric){
  const groups=new Map();
  for(const r of holidayRows(metric)){
    const key=String(r.year)+"|"+String(r.holiday)+"|"+String(r.model);
    if(!groups.has(key))groups.set(key,{year:r.year,holiday:r.holiday,model:r.model,rows:[]});
    groups.get(key).rows.push(r);
  }
  return [...groups.values()].map(g=>({
    event:String(g.year)+"年"+String(g.holiday),period:String(g.year)+"|"+String(g.holiday),
    holiday:g.holiday,year:g.year,model:g.model,
    before:median(g.rows.map(r=>num(r.before)).filter(v=>v!==null)),
    during:median(g.rows.map(r=>num(r.during)).filter(v=>v!==null)),
    after:median(g.rows.map(r=>num(r.after)).filter(v=>v!==null)),
    control_days:median(g.rows.map(r=>num(r.control_days)).filter(v=>v!==null)),
    n:g.rows.length
  }));
}
function holidayScopeLabel(){
  if(state.model!=="__ALL__") return String(state.model);
  if(state.category!=="__ALL__") return String(state.category);
  return "鸿蒙智行全部车型";
}
function holidayScopeModels(metric){
  return unique(currentSeries(metric).map(r=>String(r.model||"")).filter(Boolean));
}
function holidayDailyMap(row){
  if(!Array.isArray(row&&row.daily))return {map:null,reason:"缺少逐日基准"};
  const map=new Map();
  for(const item of row.daily){
    const d=dateOnly(item&&item.date),actual=num(item&&item.actual),expected=num(item&&item.expected);
    if(!d||actual===null||expected===null)return {map:null,reason:"逐日值不完整"};
    const previous=map.get(d);
    if(previous&&(previous.actual!==actual||previous.expected!==expected))return {map:null,reason:"逐日重复值冲突"};
    map.set(d,{actual,expected});
  }
  return {map,reason:""};
}
function holidayScopeRows(metric){
  const selected=holidayScopeModels(metric),selectedSet=new Set(selected),raw=holidayRows(metric),rows=[];
  for(const event of currentEvents()){
    const allEventRows=raw.filter(r=>Number(r.year)===Number(event.year)&&String(r.holiday)===String(event.holiday));
    const eventRows=allEventRows.filter(r=>selectedSet.has(String(r.model)));
    const byModel=new Map();
    for(const row of eventRows){const model=String(row.model);if(!byModel.has(model))byModel.set(model,[]);byModel.get(model).push(row);}
    const target=[...Array(dateRangeDays(isoAdd(event.start,-7),isoAdd(event.end,7)))].map((_,i)=>isoAdd(event.start,i-7));
    const validRows=[];let legacyMissingModels=0,noHistoryModels=0,invalidModels=0,conflictModels=0;
    const sameWindow=(left,right)=>target.every(d=>{
      const a=left.get(d),b=right.get(d);
      return a&&b&&a.actual===b.actual&&a.expected===b.expected;
    });
    for(const model of selected){
      const candidates=byModel.get(model)||[];
      if(!candidates.length){noHistoryModels++;continue;}
      const completeMaps=[];let legacyMissing=false,invalidCandidate=false,internalConflict=false;
      for(const row of candidates){
        const daily=holidayDailyMap(row);
        if(!daily.map){
          if(daily.reason==="缺少逐日基准")legacyMissing=true;
          else invalidCandidate=true;
          if(daily.reason==="逐日重复值冲突")internalConflict=true;
          continue;
        }
        if(target.every(d=>daily.map.has(d)&&daily.map.get(d).actual>=0&&daily.map.get(d).expected>0))completeMaps.push(daily.map);
        else invalidCandidate=true;
      }
      if(internalConflict){conflictModels++;continue;}
      if(completeMaps.length){
        const reference=completeMaps[0];
        if(completeMaps.every(map=>sameWindow(reference,map)))validRows.push({row:candidates[0],map:reference});
        else conflictModels++;
      }else if(legacyMissing)legacyMissingModels++;
      else if(invalidCandidate)invalidModels++;
      else invalidModels++;
    }
    const phaseAverage=(from,to)=>{
      let total=0,count=0;
      for(const d of target){if(d<from||d>to)continue;let actual=0,expected=0;
        for(const item of validRows){const value=item.map.get(d);if(!value){return null;}actual+=value.actual;expected+=value.expected;}
        if(expected<=0)return null;total+=actual/expected;count++;
      }
      return count?total/count:null;
    };
    const before=phaseAverage(isoAdd(event.start,-7),isoAdd(event.start,-1));
    const during=phaseAverage(event.start,event.end);
    const after=phaseAverage(isoAdd(event.end,1),isoAdd(event.end,7));
    const validCount=validRows.length,selectedCount=selected.length;
    let status="有效";
    if(!selectedCount)status="当前筛选无车型";
    else if(validCount<selectedCount){
      const notes=[];
      if(legacyMissingModels)notes.push("旧网页缺少逐日基准，请重新运行分析脚本（"+legacyMissingModels+"/"+selectedCount+"）");
      if(conflictModels)notes.push("逐日对照冲突 "+conflictModels+"/"+selectedCount);
      if(invalidModels)notes.push("日窗口不完整 "+invalidModels+"/"+selectedCount);
      if(noHistoryModels)notes.push("无历史对照 "+noHistoryModels+"/"+selectedCount);
      status=(validCount?"部分车型有完整对照（":"无完整节假日对照（")+validCount+"/"+selectedCount+")"+(notes.length?"；"+notes.join("；"):"");
    }
    rows.push({event:String(event.year)+"年"+String(event.holiday),period:String(event.year)+"|"+String(event.holiday),holiday:event.holiday,year:event.year,scope:holidayScopeLabel(),before,during,after,selected_models:selectedCount,valid_models:validCount,invalid_models:selectedCount-validCount,legacy_missing_models:legacyMissingModels,no_history_models:noHistoryModels,conflict_models:conflictModels,requires_daily:legacyMissingModels>0,status,n:validCount});
  }
  return rows;
}
function normalizeLaunchGrain(value){
  const text=String(value||"");
  if(text==="月"||text.toLowerCase()==="month")return "月";
  if(text==="周"||text.toLowerCase()==="week")return "周";
  return "";
}
function launchRows(name,metric){
  return resultBase(name,metric,false).filter(r=>{
    const grain=normalizeLaunchGrain(r.grain);
    return grain?grain===state.launchGrain:state.launchGrain==="周";
  });
}
function launchObservedStart(row){
  if(Object.prototype.hasOwnProperty.call(row,"observed_start"))return dateOnly(row.observed_start);
  return dateOnly(row.observedStart||row.actual_start||row.start);
}
function launchObservedEnd(row){
  if(Object.prototype.hasOwnProperty.call(row,"observed_end"))return dateOnly(row.observed_end);
  return dateOnly(row.observedEnd||row.actual_end||row.end);
}
function launchEvidenceInWindow(row){
  const start=launchObservedStart(row),end=launchObservedEnd(row);
  if(!start||!end)return false;
  return (!state.start||start>=state.start)&&(!state.end||end<=state.end);
}
function launchPeriodNo(row,index){
  const value=Number(row.period_no);
  return Number.isFinite(value)?value:null;
}
function launchPeriodTotal(row){
  return num(row.current);
}
function launchPeriodDaily(row){
  return num(row.daily_avg);
}
function launchPeriodValid(row){
  const daily=launchPeriodDaily(row),total=launchPeriodTotal(row),status=String(row.status||"");
  return (status==="有效"||status==="ok"||!status)&&daily!==null&&daily>=0&&total!==null&&total>=0;
}
function launchPeriodRows(metric){
  return launchRows("launch_periods",metric).filter(launchEvidenceInWindow);
}
function launchCurrentStart(row){return launchObservedStart(row)||dateOnly(row.current_start||row.start);}
function launchCurrentEnd(row){return launchObservedEnd(row)||dateOnly(row.current_end||row.end);}
function launchPreviousStart(row){return launchObservedStart(row)||dateOnly(row.previous_start||row.start);}
function launchPreviousEnd(row){return launchObservedEnd(row)||dateOnly(row.previous_end||row.end);}
function launchComparisonRows(metric){
  return launchRows("launch_pacing",metric).filter(launchEvidenceInWindow);
}
function launchComparisonDaily(row){
  const hasDailyRatio=Object.prototype.hasOwnProperty.call(row,"daily_ratio");
  const value=num(row.daily_ratio);if(hasDailyRatio)return value;
  if(String(row.status||"")!=="有效")return null;
  const current=launchPeriodTotal(row),previous=num(row.previous);
  const currentDays=num(row.current_days)??num(row.current_observed),previousDays=num(row.previous_days)??num(row.previous_observed);
  if(current!==null&&previous!==null&&previous>0&&currentDays!==null&&previousDays!==null&&currentDays>0&&previousDays>0)return (current/currentDays)/(previous/previousDays);
  return null;
}
function launchComparisonTotal(row){
  const hasRatio=Object.prototype.hasOwnProperty.call(row,"ratio");
  const value=num(row.ratio);if(hasRatio)return value;
  if(String(row.status||"")!=="有效")return null;
  const current=num(row.current),previous=num(row.previous);return current!==null&&previous!==null&&previous>0?current/previous:null;
}
function launchStageText(row){return String(row.stage||row.current_stage||"");}
function launchPeriodLabel(periodNo){return Number.isFinite(Number(periodNo))?"第"+periodNo+state.launchGrain:"—";}
function launchPeriodStats(rows){
  const bases=new Map();
  rows.forEach((row,index)=>{
    if(!launchPeriodValid(row))return;
    const key=[row.model,row.cycle,row.source].map(x=>String(x||"")).join("|");
    const periodNo=launchPeriodNo(row,index),daily=launchPeriodDaily(row);
    if(periodNo===null)return;
    if(periodNo===1&&daily>0&&!bases.has(key))bases.set(key,{periodNo,daily});
  });
  const buckets=new Map();
  rows.forEach((row,index)=>{
    if(!launchPeriodValid(row))return;
    const periodNo=launchPeriodNo(row,index),daily=launchPeriodDaily(row);
    if(periodNo===null)return;
    const key=String(periodNo);
    if(!buckets.has(key))buckets.set(key,{periodNo,daily:[],index:[],models:new Set(),records:0,stages:new Set()});
    const bucket=buckets.get(key);bucket.daily.push({model:row.model,cycle:row.cycle,value:daily});bucket.models.add(String(row.model));bucket.records++;bucket.stages.add(launchStageText(row));
    const base=bases.get([row.model,row.cycle,row.source].map(x=>String(x||"")).join("|"));
    if(base&&base.daily>0)bucket.index.push({model:row.model,cycle:row.cycle,value:daily/base.daily});
  });
  return [...buckets.values()].sort((a,b)=>a.periodNo-b.periodNo).map(bucket=>{
    const daily=summary(bucket.daily,"value"),index=summary(bucket.index,"value");
    return {...bucket,label:launchPeriodLabel(bucket.periodNo),dailyTypical:daily.typical,dailyP25:daily.p25,dailyP75:daily.p75,indexTypical:index.typical,indexP25:index.p25,indexP75:index.p75,models:bucket.models.size,n:bucket.records,indexModels:index.models,indexN:index.samples,stage:[...bucket.stages].filter(Boolean).join(" / ")||"—"};
  });
}
function launchComparisonStats(rows){
  const valid=rows.map(row=>({...row,dailyValue:launchComparisonDaily(row),totalValue:launchComparisonTotal(row)})).filter(row=>String(row.status||"")==="有效"&&row.dailyValue!==null);
  const groups=new Map();
  valid.forEach(row=>{
    const previous=Number(row.previous_period_no),current=Number(row.period_no),label=Number.isFinite(previous)&&Number.isFinite(current)?launchPeriodLabel(previous)+"→"+launchPeriodLabel(current):"相邻周期";
    if(!groups.has(label))groups.set(label,[]);groups.get(label).push(row);
  });
  const stats=[...groups.entries()].map(([label,items])=>{const daily=summary(items.map(r=>({model:r.model,cycle:r.cycle,value:r.dailyValue})),"value"),total=summary(items.map(r=>({model:r.model,cycle:r.cycle,value:r.totalValue})),"value");return {label,periodNo:Number(items[0].period_no),dailyTypical:daily.typical,dailyP25:daily.p25,dailyP75:daily.p75,totalTypical:total.typical,models:daily.models,n:daily.samples};}).sort((a,b)=>a.periodNo-b.periodNo);
  return {valid,stats};
}
const researchDomains={calendar:["months","week","holiday","cycles"],lifecycle:["launch","structure","hourly"],orders:["lags"]};
function patternDomain(pattern){return Object.keys(researchDomains).find(k=>researchDomains[k].includes(pattern))||"calendar";}
function patternAvailable(pattern){
  if(state.metric==="小订数量")return !["launch","holiday","lags"].includes(pattern);
  return !(pattern==="structure"&&state.metric==="交车锁单");
}
function renderResearchNavigation(){
  const domain=patternDomain(state.pattern);
  document.querySelectorAll("[data-domain]").forEach(b=>{
    const selected=b.dataset.domain===domain;
    b.classList.toggle("is-active",selected);b.setAttribute("aria-selected",String(selected));b.tabIndex=selected?0:-1;
    b.disabled=false;
  });
  document.querySelectorAll("[data-pattern]").forEach(b=>{
    b.hidden=patternDomain(b.dataset.pattern)!==domain;b.disabled=false;
    b.title=patternAvailable(b.dataset.pattern)?"":"当前口径不适用，点击查看说明";
    if(b.dataset.pattern==="structure")b.textContent=state.metric==="小订数量"?"小订进度与退订":"转化与订单结构";
  });
  const names={calendar:"研究日历",lifecycle:"阶段进度",orders:"订单关系"};
  const active=document.querySelector('[data-pattern="'+state.pattern+'"]');
  $("pageDescription").textContent="研究主题："+names[domain]+" · 当前专题："+(active?.textContent||"");
  const context=$("patternContext");if(context){
    clear(context);
    const scope=el("span","","以下按当前口径、车型、阶段和日期筛选；累计曲线不与逐日销量相加。",context);
    scope.className="research-scope";
    const evidence=el("button","button button-quiet","核对本专题证据",context);evidence.type="button";
    evidence.addEventListener("click",()=>openLibrary(({months:"monthProgress",week:"weekly",holiday:"holidays",cycles:"comparisons",launch:"launchPeriods",structure:"sourceCurves",hourly:"sourceHourly",lags:"lags"})[state.pattern]));
    const validate=el("button","button button-quiet","验证预测价值 →",context);validate.type="button";validate.addEventListener("click",()=>updatePage("forecast"));
  }
}
function lagRows(){
  if(state.metric==="小订数量")return [];
  return (result.lock_lags||[]).filter(r=>r.metric==="留存大定"&&stageMatches(r)&&modelInScope(r)&&recordInWindow(r));
}
function renderLagResearch(container){
  $("patternIntro").textContent="留存大定与锁单按同车型、阶段和批次配对，比较0—3天滞后。相关性只提供时序线索，不能解释为逐单转化率或锁单预测倍率。";
  const records=lagRows(),valid=records.filter(r=>num(r.level_corr)!==null);
  miniKpis($("patternKpis"),[{label:"覆盖车型",value:fmtInt(unique(valid.map(r=>r.model)).length),foot:"当前完整日期窗口"},{label:"配对序列",value:fmtInt(unique(valid.map(r=>[r.model,r.cycle,r.deposit_source,r.lock_source].join("|"))).length),foot:"来源和批次分别保留"},{label:"研究滞后",value:"0—3天",foot:"不同滞后使用共同日期"},{label:"结论边界",value:"时序线索",foot:"尚非预测有效证明"}]);
  const c=card(container,"锁单通常滞后留存大定几天？","先车型内汇总，再对车型取中位数；共同趋势可能同时抬高水平相关，需结合日变化相关核对。");
  const stats=[0,1,2,3].map(lag=>{const list=valid.filter(r=>Number(r.lag)===lag);return {lag,level:summary(list,"level_corr"),change:summary(list,"change_corr")};});
  const table=el("div","table-wrap","",c);makeTable(table,["滞后天数","水平相关中位数","日变化相关中位数","车型数","序列记录数"],stats.map(r=>[r.lag+"天",fmtNum(r.level.typical),fmtNum(r.change.typical),fmtInt(r.level.models),fmtInt(r.level.samples)]),"没有完整落在当前日期窗的配对序列。");
  if(!records.length)el("p","note-line","请检查日期窗是否覆盖整段配对序列。缺少任一口径时，不生成锁单关系。",c);
}
function renderPatternTabs(){
  renderResearchNavigation();
  document.querySelectorAll("[data-pattern]").forEach(b=>{b.classList.toggle("is-active",b.dataset.pattern===state.pattern);b.setAttribute("aria-selected",b.dataset.pattern===state.pattern?"true":"false");b.tabIndex=b.dataset.pattern===state.pattern?0:-1;});
  $("patternPanels").setAttribute("aria-labelledby","pattern-"+state.pattern);
  const container=$("patternPanels");clear(container);
  const launchControl=$("launchControls");if(launchControl)launchControl.hidden=state.pattern!=="launch";
  const trend=$("cycleTrend");if(trend){trend.hidden=state.pattern!=="cycles";if(!trend.hidden)renderTrend();}
  const metric=state.metric;
  const intro=$("patternIntro");
  if(!patternAvailable(state.pattern)){
    const reason=state.metric==="小订数量"?"小订仅在小订期研究；上市后首销/平销、节假日平销对照和留存大定到锁单关系不适用于小订口径。":"锁单没有小订转化或大定订单构成；可研究锁单节奏与留存大定到锁单的滞后。";
    intro.textContent=metricName(state.metric)+" · 当前专题不适用";
    clear($("patternKpis"));emptyBox(container,"当前口径不适用此专题",reason);
    const button=el("button","button button-quiet",state.metric==="小订数量"?"查看小订进度与退订":"查看锁单滞后",container);button.type="button";button.addEventListener("click",()=>activatePattern(state.metric==="小订数量"?"structure":"lags"));
    return;
  }
  if(state.pattern==="lags"){
    renderLagResearch(container);return;
  }
  if(state.pattern==="months"){
    intro.textContent="先看相邻月怎么变化，再看每月第7、14、21天通常完成了多少。完整年度才用于判断12个月季节性；留存大定、锁单及首销、平销分别计算。";
    const annual=monthSeasonRows(metric),mcomp=comparisons("月",metric),monthStats=groupedStats(mcomp,"daily_ratio",r=>Number(dateOnly(r.start).slice(5,7))+"月"),me=monthEndRows(metric),life=lifecycleRows(metric);
    const progress=resultBase("month_progress",metric).filter(r=>dateOnly(r.start)>=state.start&&dateOnly(r.end)<=state.end&&r.status==="有效");
    if(!mcomp.length&&!progress.length&&!me.length&&!annual.some(r=>r.n)){
      miniKpis($("patternKpis"),[{label:"当前观测车型",value:fmtInt(unique(currentSeries(metric).map(r=>r.model)).length),foot:"按当前口径与阶段"},{label:"完整月比较",value:"0",foot:"不以零散日推断月份规律"}]);
      emptyBox(container,"当前范围不足以判断月份规律",metric==="小订数量"?"小订期通常不足一个完整自然月。建议先研究小订D天进度和周内节奏；有完整月数据后，本专题自动提供1—12月比较。":"尚无完整相邻月、整月进度或完整年度样本。当前零散观测仍可在周期走势与数据证据中查看；内网完整历史进入后自动扩展。");
      const actions=el("div","library-actions","",container);
      for(const [pattern,label] of (metric==="小订数量"?[["structure","查看小订进度"],["week","研究周内节奏"]]:[["cycles","查看当前周期走势"],["launch","研究上市后节奏"]])){const button=el("button","button button-quiet",label,actions);button.type="button";button.addEventListener("click",()=>activatePattern(pattern));}
      return;
    }
    miniKpis($("patternKpis"),[
      {label:"相邻完整月比较",value:fmtInt(mcomp.length),foot:"车型周期记录"},
      {label:"月内进度样本",value:fmtInt(progress.filter(r=>r.checkpoint===7).length),foot:"完整、非负且总量大于0的车型月"},
      {label:"月内末7天样本",value:fmtInt(me.length),foot:"完整自然月"},
      {label:"完整年度",value:fmtInt(unique(rangeCompleteRows("annual",metric).map(r=>r.year)).length),foot:"不足时不绘制季节性空图"}
    ]);
    const dual=el("div","pattern-dual","",container);
    let c=card(dual,"相邻月：本月是上月的多少？","按日均排除月份天数影响；前后两个完整自然月都须落在当前日期范围内。");
    let chart=el("div","pattern-chart","",c);drawBars(chart,monthStats.filter(x=>x.median!==null),"key","median",fmtPct,"vertical");
    let monthTable=el("div","table-wrap","",c);makeTable(monthTable,["当前月份","P25","日均倍率中位数","P75","车型周期记录数","车型数"],Array.from({length:12},(_,i)=>{const x=monthStats.find(r=>r.key===(i+1)+"月");return x?[x.key,fmtPct(x.p25),fmtPct(x.median),fmtPct(x.p75),fmtInt(x.n),fmtInt(x.models)]:[(i+1)+"月","—","—","—","0","0"];}),"日期窗内没有完整的相邻自然月比较。");
    c=card(dual,"月内累计：到第几天完成了多少？","累计量 / 整月量，先车型内再车型等权取中位数。只看完整历史月，不用当前未完结月拟合。");
    const progressStats=[7,14,21].map(day=>{const samples=progress.filter(r=>r.checkpoint===day),s=summary(samples,"share"),pace=summary(samples,"pace");return {day,s,pace};});
    chart=el("div","pattern-chart bar-list","",c);drawBars(chart,progressStats.map(r=>({label:"第"+r.day+"天",value:r.s.typical})).filter(r=>r.value!==null),"label","value",fmtPct,"horizontal");
    const pt=el("div","table-wrap","",c);makeTable(pt,["截至日","累计占整月","历史P25","历史P75","相对日历进度","车型数","车型月样本"],progressStats.map(r=>["第"+r.day+"天",fmtPct(r.s.typical),fmtPct(r.s.p25),fmtPct(r.s.p75),fmtPct(r.pace.typical),fmtInt(r.s.models),fmtInt(r.s.samples)]),"没有完整、非负且总量大于0的自然月。");
    el("p","card-subtitle","相对日历进度=累计占比÷已过天数占比；100%代表均匀进度。未控制星期、节日和促销，只用来描述历史月内形状。",c);
    if(annual.some(r=>r.n>0)){
      c=card(container,"完整年度12月季节性指数","全年月均 = 100；只使用完整年度记录，不用环比替代季节性。");
      chart=el("div","pattern-chart","",c);drawBars(chart,annual.filter(x=>x.median!==null),"month","median",fmtNum,"vertical");
      const annualTable=el("div","table-wrap","",c);makeTable(annualTable,["月份","P25 指数","中位指数","P75 指数","车型数","年度数","车型年度记录数"],annual.filter(x=>x.n>0).map(x=>[x.month,fmtNum(x.p25),fmtNum(x.median),fmtNum(x.p75),fmtInt(x.models),fmtInt(x.years),fmtInt(x.n)]),"暂无完整年度样本。");
    }else el("p","pattern-intro","年度季节性暂缺完整自然年样本。这里保留不足说明，待内网完整历史数据进入后自动显示1—12月季节性。",container);
    c=card(container,"月内末7天与前段日均","来自完整月证据；倍率 >100% 表示月末7天日均较高。");
    let endTable=el("div","table-wrap","",c);makeTable(endTable,["车型","年份","月份","月末 / 前段日均","状态","来源批次"],me.map(r=>[r.model,r.year,String(r.month)+"月",fmtPct(r.ratio),r.status,r.source+" · "+r.cycle]),"当前阶段没有满足完整自然月的月末证据。");
  }else if(state.pattern==="week"){
    intro.textContent="按同车型、同指标、同阶段、同周期/来源的完整自然周读取周一至周日指数；周末比较使用周六、周日对工作日日均。月末只纳入完整自然月。";
    const w=weeklyStats(metric),ends=monthEndRows(metric),wkSummary=summary(w.valid.map(r=>({...r,start:r.week})),"ratio");
    const wkRatio=wkSummary.typical;
    miniKpis($("patternKpis"),[
      {label:"完整自然周",value:fmtInt(w.valid.length),foot:"车型周期样本"},
      {label:"周末 / 工作日日均",value:fmtPct(wkRatio),foot:fmtInt(wkSummary.samples)+"条车型周记录 · "+fmtInt(wkSummary.periods)+"周"},
      {label:"月末样本",value:fmtInt(ends.length),foot:"完整自然月"},
      {label:"适用阶段",value:state.stage,foot:"阶段分开，不做跨阶段混合"}
    ]);
    const dual=el("div","pattern-dual","",container);
    let c=card(dual,"周一至周日指数","整周日均 = 100；中位数按车型/完整周样本计算。");
    let chart=el("div","pattern-chart","",c);drawBars(chart,w.weekday.filter(x=>x.value!==null),"label","value",v=>fmtNum(v),"vertical");
    const tbl=el("div","table-wrap","",c);makeTable(tbl,["星期","P25 指数","中位指数","P75 指数","车型周记录数"],w.weekday.map(x=>[x.label,fmtNum(x.p25),fmtNum(x.value),fmtNum(x.p75),fmtInt(x.n)]),"所选日期窗没有完整周。");
    c=card(dual,"周末与工作日差异稳定吗？","每个完整普通周的周末日均 / 工作日日均；按车型等权描述历史分布。");
    const endTbl=el("div","table-wrap","",c);makeTable(endTbl,["P25","典型倍率","P75","车型数","完整周数"],[[fmtPct(wkSummary.p25),fmtPct(wkSummary.typical),fmtPct(wkSummary.p75),fmtInt(wkSummary.models),fmtInt(wkSummary.samples)]],"暂无完整周。");
  }else if(state.pattern==="launch"){
    const control=$("launchControls");if(control){control.hidden=false;$("launchGrain").value=state.launchGrain;}
    const stageLabel=state.stage==="首销及平销"?"首销及平销":state.stage||"当前阶段",canJoint=scopedStages(metric).includes("首销")&&scopedStages(metric).includes("平销");
    intro.textContent="上市后销量节奏取自首销开始后的实际周/月期间：周按首销日D1起每7天，月按首销日逐月对齐（月末日期截到当月末，不是自然月）。联合阶段展示首销、平销及跨阶段记录，单选阶段只保留对应完整期间。日均销量按完整、非负期间计算，留存大定与锁单严格分开。当前粒度："+state.launchGrain+"；当前阶段："+stageLabel+"。";
    const periods=launchPeriodRows(metric),periodStats=launchPeriodStats(periods),comparisons=launchComparisonRows(metric),comparisonStats=launchComparisonStats(comparisons),validComparisons=comparisonStats.valid;
    const allPeriodRows=launchRows("launch_periods",metric),allComparisonRows=launchRows("launch_pacing",metric);
    const periodModels=unique(periods.map(r=>String(r.model||""))).length,comparisonModels=unique(validComparisons.map(r=>String(r.model||""))).length;
    miniKpis($("patternKpis"),[
      {label:"完整上市期间",value:fmtInt(periodStats.reduce((a,r)=>a+r.n,0)),foot:"范围覆盖 "+periodModels+"个车型 · "+state.launchGrain+"粒度"},
      {label:"有效相邻比较",value:fmtInt(validComparisons.length),foot:comparisonModels+"个车型 · 日均比"},
      {label:"不可比记录",value:fmtInt(comparisons.length-validComparisons.length),foot:"缺日、负值、阶段或来源不一致"},
      {label:"分析阶段",value:stageLabel,foot:"日期范围："+state.start+" 至 "+state.end}
    ]);
    const noPeriodData=!allPeriodRows.length&&!allComparisonRows.length;
    const noWindowData=!periods.length&&!comparisons.length&&(allPeriodRows.length||allComparisonRows.length);
    const noCompleteWindow=periods.length&&!periodStats.length&&!validComparisons.length;
    const scopeNote=noPeriodData?"当前车型、分类和口径没有上市后期间记录；请检查首销日期或切换车型。":noWindowData?"当前日期范围排除了上市后期间或相邻比较记录；日期范围未自动扩大，请扩大日期范围或恢复当前口径日期。":noCompleteWindow?"当前日期范围没有完整可比期间，已有观测保留在下方证据中；日期范围未自动扩大。":"";
    const bounds=metricBounds.get(metric)||["",""];
    if(noWindowData||(noCompleteWindow&&(state.start>bounds[0]||state.end<bounds[1]))){
      const scopeGuide=el("div","pattern-intro",scopeNote,container);
      const restore=el("button","button button-quiet","恢复当前口径日期",scopeGuide);restore.type="button";restore.addEventListener("click",restorePatternDates);
    }
    if(canJoint&&state.stage!=="首销及平销"){
      const note=el("div","pattern-intro","当前阶段为“"+stageLabel+"”，仅使用该阶段的完整期间比较；联合查看首销到平销可切换为“首销及平销”。",container);
      const button=el("button","button button-quiet","切换到首销及平销",note);button.type="button";button.addEventListener("click",()=>setPatternStage("首销及平销"));
    }
    const dual=el("div","pattern-dual","",container);
    let c=card(dual,"上市第N"+state.launchGrain+"日均销量","各上市期间按完整天数计算日均，再按车型等权汇总；覆盖车型数/期间记录数会随期间变化。"+(scopeNote?" "+scopeNote:""));
    let chart=el("div","pattern-chart bar-list","",c);chart.style.maxHeight="420px";chart.style.marginBottom="16px";chart.tabIndex=0;chart.setAttribute("role","region");chart.setAttribute("aria-label","上市期间日均销量图，可上下滚动查看各上市周期");drawBars(chart,periodStats.filter(r=>r.dailyTypical!==null).map(r=>({label:r.label+" · "+r.models+"车",value:r.dailyTypical,n:r.n})),"label","value",fmtNum,"horizontal");
    let table=el("div","table-wrap","",c);makeTable(table,["上市期间","日均销量 P25","典型日均销量","P75","覆盖车型","期间记录"],periodStats.map(r=>[r.label,fmtNum(r.dailyP25),fmtNum(r.dailyTypical),fmtNum(r.dailyP75),fmtInt(r.models),fmtInt(r.n)]),scopeNote||"当前日期范围没有完整的上市期间；请扩大日期范围或恢复当前口径日期。");
    c=card(dual,"上市第N"+state.launchGrain+"首期相对指数","仅以同车型、同批次、同来源且完整非负的第1期日均为100%；没有合格第1期的批次不绘制相对指数。"+(scopeNote?" "+scopeNote:""));
    chart=el("div","pattern-chart bar-list","",c);chart.style.maxHeight="420px";chart.style.marginBottom="16px";chart.tabIndex=0;chart.setAttribute("role","region");chart.setAttribute("aria-label","上市期间首期相对指数图，可上下滚动查看各上市周期");drawBars(chart,periodStats.filter(r=>r.indexTypical!==null).map(r=>({label:r.label+" · "+r.indexModels+"车",value:r.indexTypical,n:r.indexN})),"label","value",fmtPct,"horizontal");
    table=el("div","table-wrap","",c);makeTable(table,["上市期间","P25","首期相对指数","P75","有效基期车型","有效指数记录"],periodStats.map(r=>[r.label,fmtPct(r.indexP25),fmtPct(r.indexTypical),fmtPct(r.indexP75),fmtInt(r.indexModels),fmtInt(r.indexN)]),scopeNote||"当前日期范围没有可用于首期相对指数的完整基期。");
    c=card(container,"相邻上市期间日均比","主看日均比；总量比作为证据同时保留。周/月期间的天数不同，不直接比较总量高低。"+(state.stage==="首销及平销"?" 当前联合阶段允许首销→平销的跨阶段比较，但不会塞入单阶段比较。":""));
    chart=el("div","pattern-chart bar-list","",c);chart.style.maxHeight="420px";chart.style.marginBottom="16px";chart.tabIndex=0;chart.setAttribute("role","region");chart.setAttribute("aria-label","相邻上市期间日均比图，可上下滚动查看各上市周期");drawBars(chart,comparisonStats.stats.filter(r=>r.dailyTypical!==null).map(r=>({label:r.label,value:r.dailyTypical,n:r.n})),"label","value",fmtPct,"horizontal");
    table=el("div","table-wrap","",c);makeTable(table,["相邻期间","P25 日均比","典型日均比","P75","车型数","有效记录"],comparisonStats.stats.map(r=>[r.label,fmtPct(r.dailyP25),fmtPct(r.dailyTypical),fmtPct(r.dailyP75),fmtInt(r.models),fmtInt(r.n)]),noPeriodData?scopeNote:"当前日期范围没有完整的相邻上市期间比较；请扩大日期范围或调整阶段。");
    const detail=card(container,"上市期间逐车型证据","保留上市期间、阶段、观测天数、应有天数、日均、批次与来源；完整性不足或负值不补倍率。" );
    const dt=el("div","table-wrap","",detail);
    makeTable(dt,["车型","上市期间","预期开始","预期结束","观测开始","观测结束","阶段","期间总量","观测/应有天数","日均","状态","批次 / 来源"],periods.map((r,i)=>[r.model,launchPeriodLabel(launchPeriodNo(r,i)),dateOnly(r.start),dateOnly(r.end),launchObservedStart(r),launchObservedEnd(r),launchStageText(r),fmtNum(launchPeriodTotal(r)),fmtInt(r.observed)+"/"+fmtInt(r.expected_days),fmtNum(launchPeriodDaily(r)),r.status||"—",String(r.cycle||"")+" · "+String(r.source||"")]),scopeNote||"当前日期范围没有上市期间证据。" );
    const compareDetail=card(container,"逐车型相邻期间证据","日均比用于节奏判断；总量比单列，阶段和来源切换会标记为不可比。" );
    const ct=el("div","table-wrap","",compareDetail);
    makeTable(ct,["车型","前一期间","当前期间","前阶段","当前阶段","前/当前总量","前/当前天数","总量比","日均比","状态","前→后来源"],comparisons.map(r=>[r.model,launchPeriodLabel(Number(r.previous_period_no)),launchPeriodLabel(Number(r.period_no)),r.previous_stage||r.stage||"—",r.current_stage||r.stage||"—",fmtNum(r.previous)+" / "+fmtNum(r.current),fmtInt(r.previous_days||r.previous_observed)+" / "+fmtInt(r.current_days||r.current_observed),fmtPct(launchComparisonTotal(r)),fmtPct(launchComparisonDaily(r)),r.status||"—",String(r.previous_source||r.source||"")+" → "+String(r.current_source||r.source||"")]),noPeriodData?scopeNote:"当前日期范围没有相邻期间证据。" );
  }else if(state.pattern==="structure"||state.pattern==="hourly"){
    renderSourcePatterns(container,state.pattern);
  }else if(state.pattern==="holiday"){
    intro.textContent="节假日只提供历史解释：与同星期节前/节后对照计算，不视为可直接外推的预测系数。当前日期窗需覆盖节前7日至节后7日；主分析限定平销阶段。";
    const holidayStageAvailable=scopedStages(metric).includes("平销");
    const hs=holidayPhaseRows(metric),scopeRows=holidayScopeRows(metric),selectedModels=holidayScopeModels(metric);
    miniKpis($("patternKpis"),[
      {label:"范围有效事件",value:fmtInt(scopeRows.filter(r=>r.status==="有效").length),foot:"当前筛选范围："+holidayScopeLabel()},
      {label:"有效车型·事件数",value:fmtInt(scopeRows.reduce((a,r)=>a+r.valid_models,0)),foot:"按节日事件累计；所选车型数："+fmtInt(selectedModels.length)},
      {label:"逐车型明细",value:fmtInt(holidayRows(metric).length),foot:"用于核对范围汇总"},
      {label:"适用阶段",value:"平销",foot:state.stage==="平销"?"当前选择为平销":"当前阶段无节日对照"}
    ]);
    const scopeCard=card(container,"当前筛选范围节假日指数","范围："+holidayScopeLabel()+"。每日先合计所选车型的实际值与同星期基准，再计算节前、节中、节后日均倍率；不会简单平均车型指数。");
    el("p","card-subtitle","每日指数＝当日销量÷同星期基准×100%；100%表示与基准持平，120%表示高20%。范围图先合计有效车型的实际与基准，再相除并按节前、节中、节后分别取日均。",scopeCard);
    const method=el("details","profile-detail","",scopeCard);
    const methodSummary=el("summary","","节假日指数怎么算",method);
    methodSummary.setAttribute("aria-controls","holiday-method-body");
    const methodBody=el("div","holiday-method-body","",method);methodBody.id="holiday-method-body";
    [
      "计算对象：留存大定（源字段“留存大定”）与锁单分开；单车型在同口径、平销阶段、批次和来源内计算。",
      "分段：节前为节日开始前7天，节中为节日起止日（含首尾），节后为结束后7天。",
      "同星期基准：从节日开始前第8—35天、节日结束后第8—35天，选取与目标日相同星期的普通日，取其销量的算术平均。排除节假日、调休工作日及任一节日前后7天，普通周末可入选。同星期至少4个有效对照日，且节日前后两侧都有；基准必须大于0。",
      "公式：每日指数＝当日销量÷同星期基准×100%；阶段指数＝该段每日指数的算术平均。0销量保留为有效值；100%持平，120%表示高20%，不是同比或环比。",
      "第一图·范围汇总：每日先合计有效车型的实际销量和各自基准，再相除，最后对该段每日指数取平均。例：某日A车型实际200辆、基准100辆，B车型实际900辆、基准900辆，范围指数＝（200+900）÷（100+900）×100%＝110%。不是车型指数简单平均，也不是整段销量合计除以整段基准合计。",
      "第二图·车型典型水平：同车型、同年、同节日的多批次/来源指数先取中位数；再对每个车型跨年的同名节日指数取中位数，最后在车型之间取中位数。图下表按年份和车型展示，第三张表保留原始批次/来源，不能将第二图视为全部车型销量加权结果。",
      "有效条件与筛选：左侧筛选决定参与车型和事件，日期需完整覆盖节前7天至节后7天；每个目标日须有非负销量，对照不足或基准为0时不补0。范围汇总中，同车型重复的逐日实际值与基准相同只计一次，冲突则剔除；部分车型有效时，请结合“有效车型/所选车型”和“状态”阅读。",
      "使用边界：同星期对照来自原始数据，可能在当前筛选日期窗外。由于包含节后对照，只用于解释历史，不作为未来预测系数。"
    ].forEach(text=>el("p","",text,methodBody));
    const scopeChart=el("div","pattern-chart bar-list","",scopeCard);
    scopeChart.style.maxHeight="420px";scopeChart.style.marginBottom="16px";
    scopeChart.tabIndex=0;scopeChart.setAttribute("role","region");scopeChart.setAttribute("aria-label","当前筛选范围节假日指数图，可上下滚动查看各年节日");
    const scopeBars=[];scopeRows.filter(r=>!r.requires_daily).forEach(r=>[["before","节前"],["during","节中"],["after","节后"]].forEach(([phase,label])=>scopeBars.push({label:r.event+" · "+label,value:r[phase]})));
    drawBars(scopeChart,scopeBars.filter(x=>num(x.value)!==null),"label","value",fmtPct,"horizontal");
    const scopeTable=el("div","table-wrap","",scopeCard);
     makeTable(scopeTable,["节日","年份","范围","节前指数","节中指数","节后指数","有效车型","所选车型","状态"],scopeRows.map(r=>[r.holiday,r.year,r.scope,fmtPct(r.before),fmtPct(r.during),fmtPct(r.after),fmtInt(r.valid_models),fmtInt(r.selected_models),r.status]),"当前日期窗没有可展示的节假日范围汇总；需覆盖节日前后各7日。若提示旧网页缺少逐日基准，请重新运行分析脚本。");
    if(!scopeRows.length&&!hs.length){
      clear(scopeChart);el("p","note-line","本范围尚无满足节前、节中、节后及同星期双侧对照要求的事件。保留上方计算说明；完整历史进入后自动展示，缺少对照时不生成指数。",scopeCard);
      return;
    }
    const c=card(container,"节前、节中、节后日均指数（逐车型）","条形为车型典型水平（中位数）；下方表按年份/车型保留明细，第三表保留原始批次/来源。");
    if(state.stage!=="平销"){
      const reason=holidayStageAvailable?"节假日对照仅基于“平销”阶段；当前为“"+state.stage+"”，不会跨阶段填补。":"当前筛选范围没有“平销”阶段数据；请切换车型或分类，或点击“重置”恢复完整范围。";
      const note=el("div","pattern-intro",reason,scopeCard);
      if(holidayStageAvailable){const button=el("button","button button-quiet","切换到平销阶段",note);button.type="button";button.addEventListener("click",()=>setPatternStage("平销"));}
      scopeCard.insertBefore(note,scopeChart);
    }
    const chart=el("div","pattern-chart bar-list","",c);
    chart.style.maxHeight="420px";
    chart.style.marginBottom="16px";
    chart.tabIndex=0;
    chart.setAttribute("role","region");
    chart.setAttribute("aria-label","逐车型节假日指数图，可上下滚动查看节日和阶段");
    const pRows=[];
    [["before","节前"],["during","节中"],["after","节后"]].forEach(([phase,label])=>groupedStats(hs,phase,r=>r.holiday,r=>r.period).forEach(x=>pRows.push({label:x.key+label,value:x.median,n:x.periods})));
    drawBars(chart,pRows.filter(x=>num(x.value)!==null),"label","value",fmtPct,"horizontal");
    const table=el("div","table-wrap","",c);makeTable(table,["节日","年份","车型","节前日均","节中日均","节后日均","控制日期数","车型批次/来源记录"],hs.map(r=>[r.holiday,r.year,r.model,fmtPct(r.before),fmtPct(r.during),fmtPct(r.after),fmtInt(r.control_days),fmtInt(r.n)]),"当前日期窗没有完整节假日对照；需覆盖节日前后各7日，且该年份节假日日历可用。");
    const detail=card(container,"节假日原始对照明细","逐条保留车型、阶段、批次和来源，用于核对上方范围汇总。");
    const detailTable=el("div","table-wrap","",detail);
    makeTable(detailTable,["节日","年份","车型","阶段","批次 / 周期","来源","节前日均指数","节中日均指数","节后日均指数","控制日期数"],holidayRows(metric).map(r=>[r.holiday,r.year,r.model,r.stage,r.cycle,r.source,fmtPct(r.before),fmtPct(r.during),fmtPct(r.after),fmtInt(r.control_days)]),"当前筛选没有完整的节假日原始对照记录。");
  }else{
    intro.textContent="周期变化率以当前周期与紧邻前一完整周期比较。百分比中位数按车型等权；P25/P75描述历史周期波动，不能直接解释为预测区间。";
    const kinds=["日","周","月","年"];
    const summaries=kinds.map(k=>({kind:k,rows:comparisons(k,metric),stats:summary(comparisons(k,metric),"daily_ratio"),total:summary(comparisons(k,metric),"ratio")}));
    miniKpis($("patternKpis"),summaries.map(x=>({label:x.kind+"周期典型日均倍率",value:fmtPct(x.stats.typical),foot:fmtInt(x.stats.periods)+"个周期 · "+fmtInt(x.stats.models)+"车型"})));
    const c=card(container,"按比较类型查看 P25 / 中位数 / P75","完整窗口条件：前一期与本期都须全部处于当前筛选日期内；倍率按日均标准化。");
    const table=el("div","table-wrap","",c);makeTable(table,["比较周期","总量比中位数","日均比 P25","日均比中位数","日均比 P75","车型数","完整日历周期","车型周期记录"],summaries.map(x=>[x.kind,fmtPct(x.total.typical),fmtPct(x.stats.p25),fmtPct(x.stats.typical),fmtPct(x.stats.p75),fmtInt(x.stats.models),fmtInt(x.stats.periods),fmtInt(x.stats.samples)]),"没有符合日期范围要求的相邻周期。");
    const trans=groupedStats(comparisons(state.grain,metric),"daily_ratio",r=>r.transition||"前期→本期");
    const c2=card(container,"当前周期的变化分布","当前趋势周期："+state.grain+"；显示实际样本可辨识的转换类别。");
    const bars=el("div","pattern-chart","",c2);drawBars(bars,trans.filter(x=>x.median!==null),"key","median",fmtPct,"vertical");
    const t2=el("div","table-wrap","",c2);makeTable(t2,["周期转换","P25","日均倍率中位数","P75","有效记录数"],trans.map(x=>[x.key,fmtPct(x.p25),fmtPct(x.median),fmtPct(x.p75),fmtInt(x.n)]),"没有足够的完整周期比较。");
  }
  const shortcuts={months:[["months","逐月数量、跨年方向与样本证据"],["annual","逐车型年度季节性"]],week:[["weekly","完整普通周明细"],["monthly","完整月末明细"]],launch:[["lifecycle","首周生命周期明细"]],holiday:[["holidays","全部指标节假日明细"]],cycles:[["deposits","下订指标分类维度规律"],["locks","锁单分类维度规律"],["comparisons","含不可比状态的周期明细"]]};
  const actions=el("div","library-actions","",container);
  for(const [key,label] of shortcuts[state.pattern]||[]){const button=el("button","button button-quiet",label,actions);button.type="button";button.addEventListener("click",()=>openLibrary(key));}
}
function sourceSelect(parent,label,values,key,preferred){
  const field=el("label","compact-select","",parent);el("span","",label,field);
  const select=el("select","","",field);select.setAttribute("aria-label",label);
  if(!values.includes(state[key]))state[key]=values.includes(preferred)?preferred:values[0]||"";
  setOptions(select,values.map(value=>({value,label:value})),state[key]);
  select.addEventListener("change",()=>{state[key]=select.value;renderPatterns();saveRoute(false);});
  return select;
}
function batchSamples(records){return records.map(r=>({...r,period:String(r.model)+"|"+String(r.cycle||r.anchor_date||r.date||r.source||"源表快照")}));}
function validSourceValue(row){return num(row.value)!==null&&row.value>=0&&/^(有效|通过)/.test(row.status||"");}
function sourceValue(value,unit){return /比例|率|占比|倍|ratio|percent/i.test(unit||"")?fmtPct(value):fmtNum(value);}
function renderPresaleResearch(container,curves){
  const eligible=curves.filter(r=>r.stage==="小订"&&/^小订/.test(r.curve||""));
  const available=unique(eligible.map(r=>r.curve));
  const valid=eligible.filter(validSourceValue),daily=currentSeries(state.metric);
  miniKpis($("patternKpis"),[{label:"小订观测车型",value:fmtInt(unique(daily.map(r=>r.model)).length),foot:"小订期逐日记录"},{label:"小订曲线",value:fmtInt(available.length),foot:"原始数量与累计比例分开"},{label:"有效曲线车型",value:fmtInt(unique(valid.map(r=>r.model)).length),foot:"当前日期范围"},{label:"用途",value:"进度参照",foot:"不自动当作转大定比例"}]);
  const c=card(container,"小订期走到第几天，通常完成了多少？","按各车型原始小订起始日对齐。选择数量、累计完成度或退订率，分别核对原始分母；D天覆盖可能不同。");
  const controls=el("div","source-controls","",c);sourceSelect(controls,"小订研究曲线",available,"sourceCurve","小订累计完成度");
  const selected=eligible.filter(r=>r.curve===state.sourceCurve),unit=selected[0]?.unit||"比例";
  const stats=groupedStats(batchSamples(selected.filter(validSourceValue)),"value",r=>Number(r.day),r=>r.period).sort((a,b)=>Number(a.key)-Number(b.key));
  const chart=el("div","pattern-chart bar-list","",c);chart.style.maxHeight="400px";
  drawBars(chart,stats.map(r=>({label:"D"+r.key+" · "+r.models+"车型",value:r.median})),"label","value",v=>sourceValue(v,unit),"horizontal");
  const table=el("div","table-wrap","",c);makeTable(table,["小订第N天","典型水平","P25","P75","车型数","记录数"],stats.map(r=>["D"+r.key,sourceValue(r.median,unit),sourceValue(r.p25,unit),sourceValue(r.p75,unit),fmtInt(r.models),fmtInt(r.n)]),"当前筛选没有可定位到小订期日期的有效曲线。请核对源表阶段起止日与日期范围。");
  const method=el("details","profile-detail","",c);el("summary","","分母与完整性如何判断",method);
  unique(selected.map(r=>[r.denominator_note,r.note,r.status].filter(Boolean).join("；"))).slice(0,8).forEach(text=>el("p","",text,method));
  if(!stats.length){const action=el("button","button button-quiet","核对小订逐日记录",c);action.type="button";action.addEventListener("click",()=>{state.evidence="daily";updatePage("evidence");});}
}
function renderSourcePatterns(container,kind){
  const curves=sourceScoped(sourceInsights.curves),early=sourceScoped(sourceInsights.early_launch),hourly=sourceScoped(sourceInsights.hourly);
  $("patternIntro").textContent=state.metric==="小订数量"?"研究小订期的累计进度、退订和分时节奏。各车型按原表阶段起点对齐D天，当前日期范围内的有效观测参与；累计值不跨日求和。":"订单结构是辅助研究，保留源表“大定、小转大、直接大定”的名称与分母，不替代留存大定。当前车型、阶段和日期共同限定样本。";
  if(kind==="structure"){
    if(state.metric==="小订数量"){
      renderPresaleResearch(container,curves);return;
    }
    miniKpis($("patternKpis"),[
      {label:"D1/D2覆盖车型",value:fmtInt(unique(early.map(r=>r.model)).length),foot:"源表已提供的首销指标"},
      {label:"转化与退订曲线",value:fmtInt(unique(curves.map(r=>r.curve)).length),foot:"分别保留原始分母与累计定义"},
      {label:"曲线覆盖车型",value:fmtInt(unique(curves.map(r=>r.model)).length),foot:"每个D日覆盖可能不同"},
      {label:"用途",value:"早期信号",foot:"历史描述，尚未检验预测增益"}
    ]);
    const c=card(container,"首销前两天：集中度与订单构成","D1、D2及合计按源表指标分开。比例先车型内再车型等权；不能据此重算留存大定。原始数量与分母见完整证据。");
    const keyFeatures=["D1占最终大定比例","D1+D2占最终大定比例","D2/D1大定比","D1小转大构成","D1直接大定构成","D1+D2小转大构成","D1+D2直接大定构成"];
    const passed=early.filter(validSourceValue),preferred=passed.filter(r=>keyFeatures.includes(r.feature));
    const groups=new Map();for(const row of preferred.length?preferred:passed){const key=String(row.metric||"")+" · "+String(row.feature||"");if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    const overview=[...groups].map(([label,items])=>({label,unit:items[0].unit,stats:summary(batchSamples(items),"value")}));
    const ratioRows=overview.filter(r=>/比例|率|占比|倍|ratio|percent/i.test(r.unit||""));
    const chart=el("div","pattern-chart bar-list","",c);chart.style.maxHeight="360px";
    drawBars(chart,ratioRows.filter(r=>r.stats.typical!==null).map(r=>({label:r.label,value:r.stats.typical})),"label","value",fmtPct,"horizontal");
    const table=el("div","table-wrap","",c);makeTable(table,["原始指标与特征","典型水平","批次P25","批次P75","车型数","有效记录"],overview.map(r=>[r.label,sourceValue(r.stats.typical,r.unit),sourceValue(r.stats.p25,r.unit),sourceValue(r.stats.p75,r.unit),fmtInt(r.stats.models),fmtInt(r.stats.samples)]),"当前车型没有通过源表核对的D1/D2指标。");
    const earlyAction=el("button","button button-quiet","核对逐车型D1/D2原值和分母",c);earlyAction.type="button";earlyAction.addEventListener("click",()=>openLibrary("sourceEarly"));
    const curveCard=card(container,"转化与退订：从D1到后续各日怎样变化？","直接使用源表每个D日的比例或数量；累计值不求和。各曲线的分母不同，必须分别查看。");
    const controls=el("div","source-controls","",curveCard);const names=unique(curves.map(r=>r.curve));sourceSelect(controls,"研究曲线",names,"sourceCurve","累计小订转化率");
    const selected=curves.filter(r=>r.curve===state.sourceCurve),unit=selected[0]?.unit||"比例";
    if(state.sourceCurve.includes("退订"))el("p","pattern-intro","源表小订期、首销期退订曲线属于小订退订观察，不是大定或锁单取消率；首销曲线D1可能含累计基期，不能和后续每日量直接相加。",curveCard);
    const stats=groupedStats(batchSamples(selected.filter(validSourceValue)),"value",r=>Number(r.day),r=>r.period).sort((a,b)=>Number(a.key)-Number(b.key));
    const curveChart=el("div","pattern-chart bar-list","",curveCard);curveChart.style.maxHeight="420px";
    drawBars(curveChart,stats.filter(r=>r.median!==null).map(r=>({label:"D"+r.key+" · "+r.models+"车",value:r.median})),"label","value",v=>sourceValue(v,unit),"horizontal");
    const curveTable=el("div","table-wrap","",curveCard);makeTable(curveTable,["D日","典型水平","批次P25","批次P75","车型数","有效记录"],stats.map(r=>["D"+r.key,sourceValue(r.median,unit),sourceValue(r.p25,unit),sourceValue(r.p75,unit),fmtInt(r.models),fmtInt(r.n)]),"当前车型没有该曲线的有效D日观测。");
    const detail=el("details","profile-detail","",curveCard);el("summary","","查看当前曲线的原始定义与状态",detail);
    unique(selected.map(r=>[r.stage,r.unit,r.note,r.denominator_note,r.status].filter(Boolean).join("；"))).slice(0,12).forEach(text=>el("p","",text,detail));
    const action=el("button","button button-quiet","查看逐车型原值与分母",curveCard);action.type="button";action.addEventListener("click",()=>openLibrary("sourceCurves"));
  }else{
    const c=card(container,"分时节奏：哪些时段订单更集中？","每个完整车型日的24小时数量之和作为分母。先车型内、再车型等权取中位数；不完整、重复冲突、负值或总量为0时不算份额。");
    const staged=hourly,available=unique(staged.map(r=>r.metric));
    state.sourceHourStage=state.stage;state.sourceHourMetric=state.metric;
    if(!available.includes(state.metric)){
      miniKpis($("patternKpis"),[{label:"当前口径",value:metricName(state.metric),foot:state.stage},{label:"有效车型日",value:"0",foot:"没有相同口径的分时源值"}]);
      emptyBox(c,"源表未提供当前口径的分时数据","当前选择为"+metricName(state.metric)+" · "+state.stage+"。不会使用大定、小转大等指标替代。可在数据证据中核对源表覆盖。");
      const button=el("button","button button-quiet","查看源表内容地图",c);button.type="button";button.addEventListener("click",()=>openLibrary("sourceInventory"));return;
    }
    const selected=staged.filter(r=>r.metric===state.sourceHourMetric),valid=selected.filter(r=>num(r.share)!==null);
    const days=unique(valid.map(r=>r.model+"|"+r.date+"|"+r.source));
    miniKpis($("patternKpis"),[
      {label:"当前分时指标",value:state.sourceHourMetric||"未提供",foot:"源表指标独立展示"},
      {label:"有效车型日",value:fmtInt(days.length),foot:"每个车型日24小时完整"},
      {label:"覆盖车型",value:fmtInt(unique(valid.map(r=>r.model)).length),foot:"不能外推到全部车型和平销期"},
      {label:"当前主口径",value:metricName(state.metric),foot:available.includes(state.metric)?"可切换对应源指标":"源表未提供该口径分时，当前为辅助指标"}
    ]);
    el("p","pattern-intro",available.includes(state.metric)?"仅展示当前口径和阶段的完整24小时样本。":"源表没有“"+metricName(state.metric)+"”的分时值。下方展示明确标注的辅助指标，不据此生成该口径的小时销量。",c);
    const stats=groupedStats(valid.map(r=>({...r,start:r.date})),"share",r=>Number(r.hour),r=>r.date).sort((a,b)=>Number(a.key)-Number(b.key));
    const chart=el("div","pattern-chart","",c);drawBars(chart,stats.map(r=>({label:r.key+"时",value:r.median})),"label","value",fmtPct,"vertical",{width:Math.max(760,chart.clientWidth),height:260,minimum:0.01,axes:true,singleColor:true});
    const table=el("div","table-wrap","",c);makeTable(table,["小时","典型份额","车型日P25","车型日P75","车型数","有效车型日"],stats.map(r=>[r.key+"时",fmtPct(r.median),fmtPct(r.p25),fmtPct(r.p75),fmtInt(r.models),fmtInt(r.n)]),"当前源指标没有完整有效的24小时记录。");
    const windows=card(container,"半天与晚间：三个时段的份额","各时段先在同一个车型日内相加，再比较车型等权中位数。不能把三个中位数当成同一辆车的一天。");
    const byDay=new Map();for(const r of valid){const key=r.model+"|"+r.date+"|"+r.source;if(!byDay.has(key))byDay.set(key,[]);byDay.get(key).push(r);}
    const bands=[["0—11时",0,11],["12—18时",12,18],["19—23时",19,23]].map(([label,from,to])=>{const samples=[...byDay.values()].filter(rs=>rs.length===24).map(rs=>({model:rs[0].model,start:rs[0].date,value:rs.filter(r=>r.hour>=from&&r.hour<=to).reduce((sum,r)=>sum+r.share,0)}));return {label,...summary(samples,"value")};});
    const bandsTable=el("div","table-wrap","",windows);makeTable(bandsTable,["时段","典型份额","P25","P75","车型数","车型日数"],bands.map(r=>[r.label,fmtPct(r.typical),fmtPct(r.p25),fmtPct(r.p75),fmtInt(r.models),fmtInt(r.samples)]),"没有完整分时样本。");
    const action=el("button","button button-quiet","查看分时原值、状态和来源",windows);action.type="button";action.addEventListener("click",()=>openLibrary("sourceHourly"));
  }
}

function renderCoverage(){
  const c=$("overviewCoverage");clear(c);
  const s=currentSeries(state.metric),dates=unique(s.map(r=>dateOnly(r.date))),models=unique(s.map(r=>r.model)),sources=unique(s.map(r=>r.source)),cycles=unique(s.map(r=>r.cycle));
  const facts=[
    ["来源工作簿",meta.source_name||"未提供"],
    ["指标源口径",metricSource(state.metric)],
    ["源数据日期",dateOnly(meta.date_start)+" 至 "+dateOnly(meta.date_end)],
    ["筛选后记录",fmtInt(s.length)],
    ["来源数",fmtInt(sources.length)],
    ["批次/周期数",fmtInt(cycles.length)],
    ["分类依据",(data.grouping&&data.grouping.reason)||"来自源工作簿车型属性"]
  ];
  facts.forEach(x=>{const span=el("span","coverage-item",null,c);el("strong","",x[0]+"：",span);el("span","",x[1],span);});
  const groups=new Map();for(const row of s){const name=categoryOf(row.model);if(!groups.has(name))groups.set(name,new Set());groups.get(name).add(row.model);}
  const groupBox=el("div","coverage-groups","",c);el("strong","","车型分类与覆盖",groupBox);
  [...groups].sort((a,b)=>b[1].size-a[1].size).forEach(([name,models])=>{const button=el("button","coverage-group",name+" · "+models.size+"车型",groupBox);button.type="button";button.addEventListener("click",()=>{state.category=name;state.model="__ALL__";updateFilters(false);refresh();});});
  const details=el("details","profile-detail","",c);el("summary","","数据与分析边界",details);(meta.notes||[]).forEach(n=>el("p","",n,details));
}
function renderKpis(){
  const c=$("overviewKpis");clear(c);
  const s=currentSeries(state.metric),total=s.reduce((a,r)=>a+(num(r.value)||0),0);
  const dates=unique(s.map(r=>dateOnly(r.date))),models=unique(s.map(r=>r.model));
  const days=dateRangeDays(state.start,state.end),sum=summary(comparisons(state.grain,state.metric),"daily_ratio");
  addKpi(c,"筛选内观测量",fmtNum(total),"保留源数据正负值；按当前单一阶段合计");
  addKpi(c,"车型覆盖",fmtInt(models.length),state.category==="__ALL__"?"当前动态车型分组":"分类："+state.category);
  addKpi(c,"有观测日期",fmtInt(dates.length)+" / "+fmtInt(days),"观察日期，不推断缺失日为零");
  addKpi(c,"完整"+state.grain+"比较周期",fmtInt(sum.periods),sum.models+"个车型 · "+sum.samples+"条车型周期样本");
}
function renderRangeNotice(){
  const s=currentSeries(state.metric),models=unique(s.map(r=>r.model)),dts=unique(s.map(r=>dateOnly(r.date)));
  const node=$("rangeNotice");
  node.classList.toggle("is-warning",!s.length);
  node.textContent=metricName(state.metric)+"（源："+metricSource(state.metric)+"） · "+(state.stage==="小订阶段"?"小订期":state.stage)+" · "+(state.category==="__ALL__"?"全部分类":state.category)+" · "+(state.model==="__ALL__"?"全部车型":state.model)+" · "+state.start+" 至 "+state.end+" · "+models.length+"车型 / "+s.length+"条日观测"+(!s.length?"；该范围没有可用观测。":"");
}
function renderOverview(){
  renderRuleFindings();renderSourceMap();renderRangeNotice();renderKpis();renderCoverage();
}

function modelInScope(r){
  return (state.model==="__ALL__"||String(r.model)===state.model)&&(state.category==="__ALL__"||categoryOf(r.model)===state.category);
}
function recordInWindow(r){
  const day=dateOnly(r.date||r.anchor_date);
  if(day)return /^\d{4}-\d{2}-\d{2}$/.test(day)&&day>=state.start&&day<=state.end;
  const from=dateOnly(r.previous_start||r.observed_start||r.target_start||r.start||r.week);
  let to=dateOnly(r.observed_end||r.target_end||r.end);
  if(!to&&r.week)to=isoAdd(dateOnly(r.week),6);
  if(!from&&r.year){
    const start=r.month?String(r.year)+"-"+String(r.month).padStart(2,"0")+"-01":String(r.year)+"-01-01";
    const end=r.month?isoAdd(start,monthDays(r.year,r.month)-1):String(r.year)+"-12-31";
    return start>=state.start&&end<=state.end;
  }
  return Boolean(from&&to&&from>=state.start&&to<=state.end);
}
function sourceScoped(records){
  return (records||[]).filter(r=>modelInScope(r)&&stageMatches(r)&&recordInWindow(r));
}
function renderSourceMap(){
  const container=$("sourceResearchMap");if(!container)return;clear(container);
  el("strong","","下一步研究什么？",container);
  el("p","card-subtitle",metricName(state.metric)+" · "+state.stage+"；选择业务问题进入对应专题，筛选范围会保留。",container);
  const grid=el("div","research-grid","",container);
  const options=state.metric==="小订数量"?[
    ["structure","小订进度和退订怎么变？","按小订D天对齐，比较累计完成度与退订"],
    ["hourly","小订集中在哪些小时？","当前小订期完整24小时样本"],
    ["week","一周中哪些天更高？","完整周、周末与工作日日均比较"],
    ["cycles","本周期是上周期的多少？","总量与日均分开，缺日不补零"]
  ]:[
    ["months","月份和月内进度怎么变？","1—12月、月末与累计进度"],
    ["holiday","节前、节中、节后有什么变化？","按筛选范围汇总，同星期作为对照"],
    ["launch","首销到平销如何变化？","按上市D天对齐，比较相邻周/月"],
    ["lags","留存大定到锁单滞后多久？","同车型、阶段与批次的0—3天相关"]
  ];
  for(const [pattern,title,detail] of options){const button=el("button","research-entry","",grid);button.type="button";el("strong","",title,button);el("span","",detail,button);button.addEventListener("click",()=>activatePattern(pattern));}
}

function renderRuleFindings(){
  const c=$("ruleFindings");clear(c);
  $("ruleScopeNote").textContent="随当前全部筛选重新统计。比例为车型等权中位数；历史重复与预测有效性分别判断。";
  const candidates=scopedFindings();
  const table=el("div","table-wrap","",c);
  makeTable(table,["研究问题","典型比例","历史波动 P25—P75","样本覆盖","判断"],candidates.map(r=>[r.title,fmtPct(r.stats.typical),fmtPct(r.stats.p25)+"—"+fmtPct(r.stats.p75),r.stats.models+"车型 / "+r.stats.samples+"记录 / "+r.years+"年",r.stats.models>=3&&r.years>=2?"跨车型跨年线索；待预测验证":"局部历史线索；待扩充验证"]),"当前范围还没有满足完整性要求的规律样本。可先研究阶段进度或核对数据覆盖。");
  const trs=table.querySelectorAll("tbody tr");candidates.forEach((r,i)=>{const td=trs[i]?.cells[0];if(!td)return;td.replaceChildren();const button=el("button","text-button",r.title,td);button.type="button";button.addEventListener("click",()=>activatePattern(r.pattern));});
  const note=el("p","note-line",meta.sample?"当前为样例数据，结果用于验证研究流程。":"跨车型同向仍需检查车型构成、年份和批次；以上不是已验证预测系数。",c);
}
function scopedFindings(){
  const items=[
    {pattern:"week",title:"周末日均是工作日的多少？",records:weeklyStats(state.metric).valid.map(r=>({...r,start:r.week})),field:"ratio"},
    {pattern:"months",title:"月末7天日均是前段的多少？",records:monthEndRows(state.metric),field:"ratio"},
    {pattern:"cycles",title:"本月日均是上月的多少？",records:comparisons("月",state.metric),field:"daily_ratio"}
  ];
  if(state.metric==="小订数量")items.unshift({pattern:"structure",title:"小订首日完成了全期的多少？",records:batchSamples(sourceScoped(sourceInsights.curves).filter(r=>r.curve==="小订累计完成度"&&Number(r.day)===1&&validSourceValue(r))),field:"value"});
  return items.map(r=>({...r,stats:summary(r.records,r.field),years:unique(r.records.map(x=>dateOnly(x.date||x.start||x.anchor_date).slice(0,4))).filter(Boolean).length})).filter(r=>r.stats.typical!==null).slice(0,4);
}

function libraryDefinitions(){
  const base=[["model","车型"],["metric","指标"],["stage","阶段"],["cycle","批次"],["source","来源"]];
  const ruleColumns=[["category","车型组"],["metric","指标"],["stage","阶段"],["pattern","规律"],["typical","典型比例","pct"],["p25","周期P25","pct"],["p75","周期P75","pct"],["models","车型数"],["samples","样本数"],["periods","周期数"],["years","年份数"],["conclusion","描述"],["train_ratio","历史比例","pct"],["validation_year","验证年度"],["validation_ratio","验证年度比例","pct"],["validation_status","验证情况"],["validation_note","验证说明"],["validation_models","共同验证车型数"],["validation_train_years","训练年数"],["detail_sheet","证据类型"]];
  const periodColumns=[["role","环节"],["metric","指标"],["stage","阶段"],["kind","周期"],["transition","周期转换"],["dimension","分类维度"],["category","类别"],["models","车型数"],["pairs","比较对数"],["periods","不同周期"],["years","年份数"],["ratio","总量比","pct"],["daily_ratio","日均比","pct"],["p25","周期P25","pct"],["p75","周期P75","pct"],["above100","高于100%占比","pct"],["yearly","分年日均比"],["evidence","证据说明"],["status","状态"]];
  const raw=(key)=>result[key]||[];
  const def=(key,title,records,columns,note)=>({key,title,records,columns,note});
  const launchFields=[["period_no","上市第N期"],["grain","上市粒度"],["start","开始"],["end","结束"],["observed_start","观测开始"],["observed_end","观测结束"],["current","本期观测量","num"],["daily_avg","日均量","num"],["observed","观测天数"],["expected_days","应有天数"],["status","状态"]];
  return [
    def("rules","规律汇总与跨年验证",rules,ruleColumns,"随当前筛选重算的车型等权中位数；历史分布与预测验证分开判断。"),
    def("months","各月变化证据",data.monthly_profiles||[],[["category","车型组"],["metric","指标"],["stage","阶段"],["month","月份"],["daymean","单车型日均中位数","num"],["models","完整月车型数"],["complete","完整车型月数"],["pairmodels","相邻月车型数"],["pairs","相邻月比较对数"],["periods","不同年月数"],["years","年份数"],["ratio","总量占上月","pct"],["daily","日均占上月","pct"],["above","上升占比","pct"],["yearly","分年日均比"],["conclusion","证据判断"]],"每组、指标和阶段均保留1—12月；1月比较上年12月。不同月份车型构成可能不同，不以月度绝对量直接判定淡旺季。"),
    def("deposits","下订周期规律",raw("period_summary").filter(r=>r.role!=="锁单"),periodColumns,"包含小订、大定、留存大定、小转大等本次实际存在的指标，分别统计，不相加。"),
    def("monthProgress","月内累计进度",raw("month_progress"),[...base,["year","年份"],["month","月份"],["checkpoint","截至第N天"],["current","整月观测量","num"],["cumulative","累计观测量","num"],["share","累计占整月","pct"],["calendar_share","日历进度","pct"],["pace","相对日历进度","pct"],["observed","观测天数"],["expected_days","自然月天数"],["start","月初"],["end","月末"],["status","状态"]],"整月完整、非负且总量大于0才计算累计占比。日历标准化只调整天数，不控制星期、节日或促销。"),
    def("locks","锁单周期规律",raw("period_summary").filter(r=>r.role==="锁单"),periodColumns,"按真实锁单日期独立统计，不将锁单统一提前3天。"),
    def("models","车型属性与分组",entries,[["model","车型"],["category","车型组"],["brand","品牌"],["segment","产品档位"],["energy","能源类型"],["stages","销售阶段"],["metrics","可用指标"]],(data.grouping||{}).reason||"仅取同一工作簿的原始车型属性。缺失与映射冲突保留。"),
    def("coverage","数据覆盖与方法",raw("coverage"),[["metric","指标"],["stage","阶段"],["models","车型数"],["observations","车型日数"],["dates","不同日期数"],["start","开始日期"],["end","结束日期"]],"随当前全局筛选统计覆盖。方法和日历来源见下方展开说明。"),
    def("audit","输入数据审计",Object.entries(meta.audit||{}).map(([check,count])=>({check,count})),[["check","检查项"],["count","记录数"]],"源表读取、来源择一、阶段判定、未结束或未来数据排除等检查计数；计数可能属于不同处理阶段，不可简单相加。"),
    def("sourceInventory","源工作簿内容地图",sourceInsights.inventory||[],[["sheet","工作表"],["rows","记录数"],["fields","原始字段"],["kind","数据类型"],["note","使用方式与边界"]],"只读取同一个汇总工作簿；来源列中的外部文件不打开。周汇总不和逐日数据重复叠加。"),
    def("sourceEarly","首销D1/D2指标",sourceInsights.early_launch||[],[["model","车型"],["metric","指标"],["feature","特征"],["value","原值","source"],["unit","单位"],["numerator","分子"],["denominator","分母"],["status","口径状态"],["source","来源"],["note","说明"]],"首销早期指标按源表定义，使用其明示的最终规模或分母；不是留存大定或锁单转化率。"),
    def("sourceCurves","转化与退订D曲线",sourceInsights.curves||[],[["model","车型"],["stage","源表阶段"],["curve","曲线"],["day","D日"],["value","原值","source"],["unit","单位"],["denominator_note","分母定义"],["status","状态"],["source","来源"],["note","说明"]],"每个D日直接读取原始曲线值；累计值不能跨D日求和，不能重复扣减留存大定。"),
    def("sourceHourly","分时数量与份额",sourceInsights.hourly||[],[["model","车型"],["metric","指标"],["stage","源表阶段"],["date","日期"],["hour","小时"],["value","小时量","num"],["share","占当日份额","pct"],["total","当日合计","num"],["status","状态"],["source","来源"]],"只有完整、非负、无重复冲突且合计大于0的24小时样本才计算份额。"),
    def("periodCoverage","周期有效性检查",raw("period_coverage"),[["role","环节"],["metric","指标"],["stage","阶段"],["kind","周期"],["total","全部比较数"],["valid","有效数"],["current_incomplete","本期不完整"],["previous_incomplete","前期不完整"],["negative","含负值"],["previous_zero","前期为零"]],"保留不可比原因，缺失和不可比不补成0%倍率。"),
    def("weekly","周内明细",raw("weekly"),[...base,["week","周一日期"],...[0,1,2,3,4,5,6].map((i)=>["indexes."+i,["周一","周二","周三","周四","周五","周六","周日"][i],"num"]),["ratio","周末/工作日","pct"]],"完整普通周；每日指数=该日销量/该周日均×100，100为周均水平。"),
    def("monthly","月内明细",raw("monthly"),[...base,["year","年份"],["month","月份"],["ratio","月末7天/其余日期","pct"],["status","状态"]],"完整自然月最后7天日均/其余日期日均；不补日期，前期为0时留空。"),
    def("annual","年度季节性明细",raw("annual"),[...base,["year","年份"],...Array.from({length:12},(_,i)=>["indexes."+i,(i+1)+"月指数","num"]),["status","状态"]],"完整自然年，各月日均/12个月日均的均值×100。指数100为年均水平，真实零月保留。"),
    def("holidays","节假日原始明细",raw("holidays"),[...base,["year","年份"],["holiday","节日"],["before","节前指数","pct"],["during","节中指数","pct"],["after","节后指数","pct"],["control_days","对照日期数"]],"平销完整节前7天、节中和节后7天，同星期双侧对照；包含节后数据，仅解释历史。"),
    def("lifecycle","首周生命周期",raw("lifecycle"),[...base,["d1_ratio","首日相对D3—D7","pct"],["first2_share","前两天占首周","pct"]],"D1—D7完整，按原始指标、阶段、批次和来源分别分析。"),
    def("launchPeriods","上市后周期观测",raw("launch_periods"),[...base,...launchFields],"以首销日为D1，周每7天，月按上市日逐月对齐；尾期不完整保留证据。"),
    def("launchPacing","上市后相邻周期",raw("launch_pacing"),[...base,["grain","粒度"],["pattern","比较"],["previous_stage","前期阶段"],["current_stage","本期阶段"],["previous_start","前期开始"],["previous_end","前期结束"],["start","本期开始"],["end","本期结束"],["previous","前期量","num"],["current","本期量","num"],["ratio","总量比","pct"],["daily_ratio","日均比","pct"],["previous_observed","前期有效日"],["previous_days","前期天数"],["current_observed","本期有效日"],["current_days","本期天数"],["previous_source","前期来源"],["status","状态"]],"同车型、批次、指标、来源，完整非负相邻周期才计算比例。"),
    def("lags","锁单滞后完整明细",raw("lock_lags"),[...base,["brand","品牌"],["segment","产品档位"],["energy","能源类型"],["lag","滞后天数"],["pairs","共同日期数"],["start","开始"],["end","结束"],["level_corr","水平相关","corr"],["change_corr","日变化相关","corr"],["change_pairs","变动对数"],["deposit_source","大定来源"],["lock_source","锁单来源"],["status","说明"]],"0—3天使用共同非负日期；相关性不是逐单转化率，也不是锁单预测系数。"),
    def("comparisons","周期比例完整明细",raw("period_comparisons"),[...base,["brand","品牌"],["segment","产品档位"],["energy","能源类型"],["role","环节"],["kind","周期"],["transition","周期转换"],["start","本期开始"],["end","本期结束"],["previous_start","前期开始"],["previous_end","前期结束"],["current","本期量","num"],["previous","前期量","num"],["current_days","本期天数"],["current_observed","本期有效日"],["previous_days","前期天数"],["previous_observed","前期有效日"],["ratio","总量比","pct"],["daily_ratio","日均比","pct"],["holiday_adjusted_days","假期调休日"],["current_negative_days","本期负值日"],["previous_negative_days","前期负值日"],["status","状态"]],"包括缺前期、缺日、前期为零和负值等不可比记录，保留完整前后日期。"),
    def("profiles","预测辅助完整记录",profiles,[...base,["grain","预测周期"],["cutoff","评估截至"],["target_start","目标开始"],["target_end","目标结束"],["baseline","基准预测","num"],["estimate","规律预测","num"],["factor","历史日均倍率","pct"],["p25","倍率P25","pct"],["p75","倍率P75","pct"],["train_samples","训练样本"],["test_samples","共同回测样本"],["wape","规律WAPE","pct"],["baseline_wape","基准WAPE","pct"],["bias","预测偏差","pct"],["status","适用状态"],["tail_note","尾期说明"],["evaluation_status","评估状态"],["method","规则方法"]],"预测状态、训练数量、基准得分和适用边界按同次后端计算保留；没有有效评分时不视为已验证。"),
    def("backtests","预测回测完整记录",backtests,[...base,["grain","周期"],["origin","评估截至"],["target_start","目标开始"],["target_end","目标结束"],["actual","实际量","num"],["baseline","基准预测","num"],["predicted","规律预测","num"],["train_samples","训练样本"]],"按同车型、指标、阶段、批次和来源保留每个留出窗口，不限当前选中的预测画像。")
  ];
}
const libraryTables=libraryDefinitions();
const fieldValue=(r,key)=>key.split(".").reduce((v,k)=>v==null?null:v[k],r);
function currentLibrary(){return libraryTables.find(t=>t.key===state.libraryTable)||libraryTables[0];}
function libraryColumns(table){
  if(table.columns.length)return ["sourceEarly","sourceCurves","sourceHourly"].includes(table.key)?table.columns.concat([["date_scope_note","日期归属说明"]]):table.columns;
  const labels={model:"车型",metric:"指标",stage:"阶段",cycle:"批次",source:"来源",grain:"预测周期",status:"状态",train_count:"训练样本数",backtest_count:"回测样本数",method:"方法",tail_note:"尾期说明",actual:"实际值",prediction:"预测值",baseline:"基准值",wape:"WAPE",baseline_wape:"基准WAPE",bias:"偏差",target_start:"目标开始",target_end:"目标结束",cutoff:"截至日期"};
  return unique(table.records.flatMap(r=>Object.keys(r))).map(k=>[k,labels[k]||k,/wape|bias/.test(k)?"pct":undefined]);
}
function libraryRows(){
  const table=currentLibrary();
  const grainMatches=r=>state.libraryGrain==="__ALL__"||(r.grain||r.kind)===state.libraryGrain;
  if(table.key==="rules")return scopedFindings().map(r=>({category:state.model!=="__ALL__"?state.model:state.category,metric:state.metric,stage:state.stage,pattern:r.title,typical:r.stats.typical,p25:r.stats.p25,p75:r.stats.p75,models:r.stats.models,samples:r.stats.samples,periods:r.stats.periods,years:r.years,conclusion:"当前范围描述",validation_status:"待预测验证",detail_sheet:r.pattern}));
  if(table.key==="coverage"){
    const series=currentSeries(state.metric),dates=series.map(r=>r.date).sort();
    return [{metric:state.metric,stage:state.stage,models:unique(series.map(r=>r.model)).length,observations:series.length,dates:unique(dates).length,start:dates[0],end:dates[dates.length-1]}];
  }
  if(["audit","sourceInventory"].includes(table.key))return table.records;
  if(table.key==="months")return Array.from({length:12},(_,i)=>{
    const list=comparisons("月",state.metric).filter(r=>Number(dateOnly(r.start).slice(5,7))===i+1),s=summary(list,"daily_ratio"),total=summary(list,"ratio");
    return {category:state.model!=="__ALL__"?state.model:state.category,metric:state.metric,stage:state.stage,month:i+1,models:s.models,pairmodels:s.models,pairs:s.samples,periods:s.periods,years:unique(list.map(r=>dateOnly(r.start).slice(0,4))).length,ratio:total.typical,daily:s.typical,conclusion:s.samples?"当前范围完整相邻月":"样本不足"};
  });
  if(table.key==="lags")return lagRows();
  if(table.key==="locks"&&state.metric!=="交车锁单")return [];
  if(table.key==="deposits"&&state.metric==="交车锁单")return [];
  if(["deposits","locks","periodCoverage"].includes(table.key)){
    const list=(result.period_comparisons||[]).filter(r=>inScope(r,state.metric)&&recordInWindow(r)&&grainMatches(r)),groups=new Map();
    for(const row of list){const key=[row.kind,row.transition||""].join("|");if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    return [...groups.values()].map(rs=>{const valid=rs.filter(r=>r.status==="有效"),s=summary(valid,"daily_ratio"),t=summary(valid,"ratio");return {metric:state.metric,stage:state.stage,role:metricName(state.metric),kind:rs[0].kind,transition:rs[0].transition,category:state.category,models:s.models,pairs:s.samples,periods:s.periods,ratio:t.typical,daily_ratio:s.typical,p25:s.p25,p75:s.p75,total:rs.length,valid:valid.length,current_incomplete:rs.filter(r=>r.status==="本期不完整").length,previous_incomplete:rs.filter(r=>r.status==="前期缺失或不完整").length,negative:rs.filter(r=>/负/.test(r.status||"")).length,previous_zero:rs.filter(r=>r.status==="前期为零").length,status:s.samples?"当前范围重算":"样本不足"};});
  }
  return table.records.filter(r=>{
    if(!grainMatches(r))return false;
    if(r.model&&!modelInScope(r))return false;
    if(!r.model&&r.category&&r.category!==(state.category==="__ALL__"?"全部车型":state.category))return false;
    if(table.key==="models")return safeArray(r.metrics).includes(state.metric)&&safeArray(r.stages).includes(state.stage);
    const auxiliary=["sourceEarly","sourceCurves","sourceHourly"].includes(table.key);
    if(!auxiliary&&r.metric&&r.metric!==state.metric)return false;
    if((["launchPeriods","launchPacing"].includes(table.key)||r.stage)&&!stageMatches(r,table.key==="launchPeriods"?"launch_periods":table.key==="launchPacing"?"launch_pacing":undefined))return false;
    if(auxiliary&&state.libraryMetric!=="__ALL__"&&(table.key==="sourceCurves"?r.curve:r.metric)!==state.libraryMetric)return false;
    if(auxiliary&&!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly(r.date||r.anchor_date)))return true;
    return recordInWindow(r);
  }).map(r=>["sourceEarly","sourceCurves","sourceHourly"].includes(table.key)?{...r,date_scope_note:!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly(r.date||r.anchor_date))?"日期未知，仅保留核对，不参与当前日期窗统计":"按原始日期或阶段起始日定位"}:r);
}
function renderLibraryControls(){
  $("libraryControls").hidden=state.evidence!=="library";
  if(state.evidence!=="library")return;
  const table=currentLibrary();state.libraryTable=table.key;
  setOptions($("libraryTable"),libraryTables.map(t=>({value:t.key,label:t.title})),table.key);
  const choices=(field)=>unique(table.records.map(r=>r[field]).filter(v=>typeof v==="string")).sort((a,b)=>a.localeCompare(b,"zh-CN"));
  for(const [field,id,key,label] of [["metric","libraryMetric","libraryMetric","全部指标"],["stage","libraryStage","libraryStage","全部阶段"],["category","libraryCategory","libraryCategory","全部分类"]]){
    const values=field==="category"?unique(table.records.map(r=>r.category||(r.model?categoryOf(r.model):null))).sort():field==="metric"&&table.key==="sourceCurves"?choices("curve"):choices(field);
    if(field==="metric"&&table.key==="sourceCurves"&&state.libraryMetric!=="__ALL__"&&!values.includes(state.libraryMetric))values.push(state.libraryMetric);
    setOptions($(id),[{value:"__ALL__",label},...values.map(v=>({value:v,label:v}))],state[key]);state[key]=$(id).value;
    $(id).closest("label").hidden=field!=="metric"||!["sourceEarly","sourceCurves","sourceHourly"].includes(table.key);
  }
  const grainControl=$("libraryGrain");
  const supportsGrain=["comparisons","launchPeriods","launchPacing","profiles","backtests","periodCoverage","deposits","locks"].includes(table.key);
  grainControl.closest("label").hidden=!supportsGrain;
  const grainValues=unique([...table.records.map(r=>r.grain||r.kind),state.libraryGrain==="__ALL__"?null:state.libraryGrain]).filter(v=>["日","周","月","年"].includes(v)).sort((a,b)=>["日","周","月","年"].indexOf(a)-["日","周","月","年"].indexOf(b));
  setOptions(grainControl,[{value:"__ALL__",label:"全部周期"},...grainValues.map(value=>({value,label:value}))],state.libraryGrain);
  if(!supportsGrain)state.libraryGrain="__ALL__";
  const scope=document.querySelector(".library-scope");if(scope)scope.textContent=["audit","sourceInventory"].includes(table.key)?"此表说明整份输入文件的结构与读取情况，没有口径或日期维度。":"随全局车型、阶段和日期范围筛选；周期记录须完整落窗。"+(["sourceEarly","sourceCurves","sourceHourly"].includes(table.key)?"辅助源表保留原指标名称，可在此选择源指标，不代表当前主口径。日期未知的记录单列状态保留核对，不参与图表。":"主指标为“"+metricName(state.metric)+"”。");
  const method=$("libraryMethods");clear(method);
  if(["coverage","audit","periodCoverage","models"].includes(table.key)){
    const detail=el("details","","",method);el("summary","","查看数据来源、方法与日历",detail);
    el("p","","来源："+(meta.source_name||"未提供")+"；工作表："+(meta.source_sheets||[]).join("、")+"；模式："+(meta.source_mode||"未提供")+"；SHA-256："+(meta.sha256||"未提供"),detail);
    (meta.notes||[]).forEach(n=>el("p","",n,detail));
    Object.entries(meta.calendar_sources||{}).forEach(([year,url])=>el("p","",year+"年日历来源："+url,detail));
  }
}
function openLibrary(key="rules"){
  const fromTopic=state.page==="patterns";
  state.libraryGrain=fromTopic&&["launchPeriods","launchPacing"].includes(key)?state.launchGrain:fromTopic&&key==="comparisons"?state.grain:"__ALL__";
  state.evidence="library";state.libraryTable=key;state.libraryMetric=key==="sourceHourly"?state.metric:key==="sourceCurves"&&fromTopic&&state.sourceCurve?state.sourceCurve:"__ALL__";state.libraryCategory="__ALL__";state.libraryStage="__ALL__";state.search="";state.pageNo=0;$("evidenceSearch").value="";
  document.querySelectorAll("[data-evidence]").forEach(b=>{const on=b.dataset.evidence==="library";b.classList.toggle("is-active",on);b.setAttribute("aria-pressed",String(on));});
  updatePage("evidence");
}
function renderPatterns(){
  renderPatternTabs();
  $("patternPanels").querySelectorAll(".pattern-card").forEach(node=>{
    const title=node.querySelector("h3,h2")?.textContent||"";
    if(/逐车型|原始对照明细/.test(title)){
      const detail=el("details","research-detail",""),summary=el("summary","",title,detail);
      node.parentNode.insertBefore(detail,node);detail.appendChild(node);
      detail.open=expandedEvidenceTitles.has(title);
      detail.addEventListener("toggle",()=>{if(detail.open)expandedEvidenceTitles.add(title);else expandedEvidenceTitles.delete(title);});
    }
  });
  document.querySelectorAll(".pattern-chart").forEach(node=>{
    node.tabIndex=0;node.setAttribute("role","region");node.setAttribute("aria-label","规律图表，可横向滚动查看全部内容");
    if(node.classList.contains("bar-list")){
      node.setAttribute("aria-label","横向条形图，可上下滚动查看全部内容");
    }
    node.classList.toggle("has-wide-chart",Boolean(node.querySelector("svg")));
  });
}
function forecastEligibleModels(){
  const base=matchingRows(rows,state.metric,false).map(r=>String(r.model));
  return unique(base).sort((a,b)=>a.localeCompare(b,"zh-CN"));
}
function profileId(p){return [p.model,p.metric,p.stage,p.cycle,p.source,p.grain,p.cutoff||p.as_of,p.target_start,p.target_end].join("|");}
function profileDisplayCutoff(p){return dateOnly(p.metric==="小订数量"?(p.last_observation||p.cutoff||p.as_of):(p.cutoff||p.as_of||p.last_observation));}
function fillForecastControls(){
  const candidates=forecastEligibleModels();
  if(!candidates.includes(state.forecastModel))state.forecastModel=candidates.includes(state.model)?state.model:(candidates[0]||"");
  setOptions($("forecastModel"),candidates.map(x=>({value:x,label:x})),state.forecastModel);
  const list=profiles.filter(p=>String(p.model)===state.forecastModel&&p.metric===state.metric&&p.stage===state.stage&&p.grain===state.forecastGrain);
  const opts=list.map(p=>({value:profileId(p),label:(p.cycle||"未分批")+" · "+(p.source||"未标来源")+" · "+(dateOnly(p.target_start)||"待定")+"～"+(dateOnly(p.target_end)||"待定")+" · "+(p.metric==="小订数量"?"小订观测至 ":"截止 ")+(profileDisplayCutoff(p)||"未知")}));
  state.profileKey=opts.some(x=>x.value===state.profileKey)?state.profileKey:(opts[0]?opts[0].value:"");
  setOptions($("forecastProfile"),opts,state.profileKey);
  const selected=opts.find(o=>o.value===state.profileKey);
  $("forecastProfile").title=selected?selected.label:"暂无匹配画像";
  $("forecastSelection").textContent=selected?state.forecastModel+" · "+metricName(state.metric)+" · "+state.stage+" · "+selected.label:"当前选择没有匹配的预测序列。";
  return list.find(p=>profileId(p)===state.profileKey)||null;
}
function profileStatus(status){
  return ({ok:"可用",insufficient_history:"历史训练样本不足",insufficient_backtest:"回测样本不足",no_complete_target_period:"目标周期尚未完整"}[status]||status||"未提供状态");
}
function scoreBacktests(profile) {
  if (!profile) return {windowRows:[], scored:[], samples:0, wape:null, baselineWape:null, bias:null, improvement:null, denominator:0, note:""};
  const sameSeries = backtests.filter(r =>
    String(r.model)===String(profile.model) && r.metric===profile.metric &&
    r.stage===profile.stage && r.grain===profile.grain &&
    r.cycle===profile.cycle && r.source===profile.source
  );
  const completeTarget = r => {
    const start=dateOnly(r.target_start), end=dateOnly(r.target_end);
    if (!start || !end || start>end) return false;
    if (profile.grain==="日") return start===end;
    if (profile.grain==="周") return isoWeekStart(start)===start && isoAdd(start,6)===end;
    if (profile.grain==="月") {
      const y=Number(start.slice(0,4)),m=Number(start.slice(5,7));
      return start===String(y)+"-"+String(m).padStart(2,"0")+"-01" &&
        end===String(y)+"-"+String(m).padStart(2,"0")+"-"+String(monthDays(y,m)).padStart(2,"0");
    }
    return true;
  };
  const windowRows=sameSeries.filter(r => {
    const start=dateOnly(r.target_start), end=dateOnly(r.target_end);
    return completeTarget(r) && start>=state.start && end<=state.end;
  });
  const scored=windowRows.filter(r =>
    r.status==="ok" && num(r.actual)!==null && num(r.predicted)!==null && num(r.baseline)!==null
  );
  const denominator=scored.reduce((sum,r)=>sum+Math.abs(r.actual),0);
  const modelError=scored.reduce((sum,r)=>sum+Math.abs(r.predicted-r.actual),0);
  const baselineError=scored.reduce((sum,r)=>sum+Math.abs(r.baseline-r.actual),0);
  const signedError=scored.reduce((sum,r)=>sum+(r.predicted-r.actual),0);
  const wape=denominator>0?modelError/denominator:null;
  const baselineWape=denominator>0?baselineError/denominator:null;
  const bias=denominator>0?signedError/denominator:null;
  const improvement=baselineWape>0?(baselineWape-wape)/baselineWape:null;
  let note="";
  if (!windowRows.length) note="所选日期范围内没有完整落窗的同序列回测目标期。";
  else if (!scored.length) note="完整目标期中没有同时满足 status=ok 且实际、规则预测、基准均为有限数值的评分样本。";
  else if (denominator===0) note="评分样本的实际绝对值之和为0，WAPE、偏差及相对改善率不可计算。";
  else if (baselineWape===0) note="所选窗口基准WAPE为0，相对改善率不可定义。";
  return {windowRows,scored,samples:scored.length,wape,baselineWape,bias,improvement,denominator,note};
}
function renderBacktest(profile, evaluation) {
  const chart=$("backtestChart"),table=$("backtestTableWrap");
  chart.tabIndex=0;chart.setAttribute("role","region");chart.setAttribute("aria-label","历史回测图，可横向滚动查看完整图表");
  if(!profile){
    chartEmpty(chart,"没有与当前选择完全匹配的预测画像。");
    makeTable(table,["目标期","实际","规则预测","基准预测","状态"],[],"当前没有可展示的同口径回测样本。");
    return;
  }
  const scored=evaluation.scored;
  const displayRows=scored.slice(-24);
  if(!scored.length){
    chartEmpty(chart,"当前日期范围内没有可评分的完整回测窗口。");
  }else{
    clear(chart);
    const legend=el("div","backtest-legend","",chart);
    [["实际","var(--teal)"],["规则预测","var(--blue2)"],["基准预测","var(--amber)"]].forEach(x=>{
      const z=el("span","",null,legend),i=el("i","", "",z);i.style.background=x[1];el("span","",x[0],z);
    });
    const w=780,h=190,L=48,R=12,T=12,B=30,pw=w-L-R,ph=h-T-B;
    const vals=scored.flatMap(r=>[num(r.actual),num(r.predicted),num(r.baseline)]).filter(v=>v!==null);
    const max=Math.max(1,...vals),min=Math.min(0,...vals),svg=sEl("svg",{viewBox:"0 0 "+w+" "+h,class:"backtest-svg",role:"img","aria-label":"所选日期窗口内历史回测实际与预测"});
    for(let i=0;i<4;i++){const yy=T+ph*i/3;svg.appendChild(sEl("line",{x1:L,y1:yy,x2:w-R,y2:yy,class:"chart-gridline"}));}
    const x=i=>scored.length===1?L+pw/2:L+i*pw/(scored.length-1),y=v=>T+(max-v)/(max-min||1)*ph;
    [["actual","backtest-actual"],["predicted","backtest-pred"],["baseline","backtest-base"]].forEach(([key,cl])=>{
      const points=scored.map((r,i)=>[x(i),y(r[key])]);
      if(points.length)svg.appendChild(sEl("path",{d:points.map((p,i)=>(i?"L":"M")+p[0]+","+p[1]).join(" "),class:cl}));
    });
    scored.forEach((r,i)=>{
      if(i===0||i===scored.length-1||scored.length<=10){
        const d=dateOnly(r.target_start),label=profile.grain==="月"?d.slice(0,7):d;
        svg.appendChild(sEl("text",{x:x(i),y:h-8,"text-anchor":"middle",class:"chart-label"},label));
      }
    });
    chart.appendChild(svg);
  }
  makeTable(table,["目标期","起点","实际","规则预测","基准预测","训练样本","状态"],
    displayRows.slice().reverse().map(r=>[
      dateOnly(r.target_start)+"～"+dateOnly(r.target_end),dateOnly(r.origin),
      fmtNum(r.actual),fmtNum(r.predicted),fmtNum(r.baseline),fmtInt(r.train_samples),profileStatus(r.status)
    ]),
    "当前没有同车型、同口径、同阶段、同批次/来源和同周期的有效回测记录。");
  const shown=Math.min(24,scored.length);
  const info=el("div","table-meta","评分窗口 "+fmtInt(evaluation.windowRows.length)+" 条；有效评分样本 "+fmtInt(evaluation.samples)+" 条；图表与表格使用同一有效样本集，表格展示最新 "+fmtInt(shown)+" 条。",table);
  table.insertBefore(info,table.firstChild);
}
function renderForecast() {
  const profile=fillForecastControls();
  const evaluation=profile?scoreBacktests(profile):null;
  const kpis=$("forecastKpis");clear(kpis);
  const empty=$("forecastEmpty");empty.hidden=true;
  if(profile){
    const cutoff=profileDisplayCutoff(profile),smallHistory=state.metric==="小订数量"&&!profile.target_start;
    const latestOutside=Boolean(cutoff&&((state.end&&cutoff>state.end)||(state.start&&cutoff<state.start)));
    const target=smallHistory?"小订期历史回测":latestOutside?"超出当前历史范围":profile.target_start&&profile.target_end?dateOnly(profile.target_start)+"～"+dateOnly(profile.target_end):"暂无完整目标期";
    [
      ["目标周期",target],
      ["基准",smallHistory||latestOutside?"—":fmtNum(profile.baseline)],
      ["规则估计",smallHistory||latestOutside||profile.status==="no_complete_target_period"?"—":fmtNum(profile.estimate)],
      ["所选窗 WAPE / 基准",fmtPct(evaluation.wape)+" / "+fmtPct(evaluation.baselineWape)]
    ].forEach(x=>{const c=el("div","forecast-kpi",null,kpis);el("span","",x[0],c);el("strong","",x[1],c);});
    const note=$("forecastProfileNote");
    if(smallHistory){
      note.textContent="小订期历史回测 · 本序列小订观测至 "+(cutoff||"未知日期")+"。未来目标期须完整落在已确认的小订期内；当前没有可用目标期，基准和估计留空。"+(profile.tail_note?" "+profile.tail_note:"")+" 日期筛选仅控制历史回测展示与评分。"+(evaluation.note?" "+evaluation.note:"");
      if(state.forecastGrain!=="日"){
        const button=el("button","button button-quiet","查看日回测",note);button.type="button";button.addEventListener("click",()=>{state.forecastGrain="日";state.profileKey="";$("forecastGrain").value="日";renderForecast();saveRoute(false);});
      }
    }else if(latestOutside){
      note.textContent="当前日期范围不含最新预测时点（"+cutoff+"），预测数值留空，以下仅显示所选历史回测。日期筛选控制历史展示和评分窗口；每个回测训练期仍可使用所选开始日期以前、且早于目标期的历史。"+(evaluation.note?" "+evaluation.note:"");
    }else{
      const imp=evaluation.improvement;
      note.textContent="状态："+profileStatus(profile.status)+" · "+(profile.method||"方法未提供")+
        " · 训练样本 "+fmtInt(profile.train_samples)+" · 所选窗口评分样本 "+fmtInt(evaluation.samples)+
        " · 窗口偏差 "+fmtPct(evaluation.bias)+
        (imp!==null?" · 相对基准WAPE改善 "+fmtPct(imp):"")+
        " · 日期筛选控制历史回测展示与评分；训练可使用开始日期以前、且早于各目标期的历史。"+
        (evaluation.note?" "+evaluation.note:"");
      if(profile.tail_note)note.textContent+=" "+profile.tail_note;
      if(profile.status==="no_complete_target_period")note.textContent+=" 当前截止点所在周期未完整，不将半周期冒称为下一个完整预测期。";
      if(profile.p25!==undefined||profile.p75!==undefined)note.textContent+=" 历史倍率P25～P75："+fmtPct(profile.p25)+"～"+fmtPct(profile.p75)+"，仅为历史波动。";
    }
  }else{
    ["目标周期","基准","规则估计","所选窗 WAPE / 基准"].forEach(x=>{const c=el("div","forecast-kpi",null,kpis);el("span","",x,c);el("strong","","—",c);});
    $("forecastProfileNote").textContent=state.forecastModel?"当前车型、口径、阶段与周期没有完全匹配的预测画像；不借用其他车型或阶段。":"该口径与阶段没有可用于回测的车型。";
    emptyBox(empty,"暂无可匹配的历史预测画像","可用右侧试算输入自己的可比日均或上期量，再选择一个倍率。");
    empty.hidden=false;
  }
  renderBacktest(profile,evaluation);
  updateTrial();
}
function updateTrial(){
  const mode=document.querySelector('input[name="trialMode"]:checked').value;
  const daily=mode==="daily";
  $("trialDaysField").hidden=!daily;
  $("trialBaseLabel").textContent=daily?"参考日均（辆 / 日）":"上期总量（辆）";
  $("trialFactorLabel").textContent=daily?"日均倍率":"总量倍率";
  const ids=daily?["trialBase","trialFactor","trialDays"]:["trialBase","trialFactor"];
  const labels={trialBase:"基准",trialFactor:"倍率",trialDays:"预测天数"};
  let error="",missing=false;
  for(const id of ["trialBase","trialFactor","trialDays"]){
    const input=$(id); input.removeAttribute("aria-invalid");
    if(!ids.includes(id))continue;
    const blank=input.value.trim()===""; const value=Number(input.value);
    const invalid=input.validity.badInput || (!blank&&(!Number.isFinite(value)||value<0||(id==="trialDays"&&(!Number.isInteger(value)||value<1))));
    if(invalid){input.setAttribute("aria-invalid","true");error=error||labels[id]+(id==="trialDays"?"必须是大于等于1的整数。":"必须是有限的非负数。");}
    if(blank){missing=true;if(input.validity.badInput)error=error||labels[id]+"请输入有效数字。";}
  }
  const out=$("trialResult"),errorNode=$("trialError");clear(out);el("span","","单一倍率试算",out);
  const base=Number($("trialBase").value),factor=Number($("trialFactor").value),days=Number($("trialDays").value);
  const total=daily?base*factor*days:base*factor;
  if(!missing&&!error&&!Number.isFinite(total))error="数值过大，请调小基准、倍率或天数。";
  errorNode.textContent=error;errorNode.hidden=!error;
  out.classList.toggle("is-invalid",Boolean(error));
  if(error||missing){el("strong","","—",out);el("small","",error?"请修正标出的输入后继续。":"填写基准、倍率"+(daily?"和整数天数":"")+"后显示试算结果。",out);return;}
  el("strong","",fmtNum(total)+" 辆",out);showUpdate(out);
  el("small","",daily?fmtNum(base)+" × "+fmtNum(factor)+" × "+fmtNum(days)+"天":"上期总量 "+fmtNum(base)+" × 总量倍率 "+fmtNum(factor),out);
}
function evidenceRows(){
  if(state.evidence==="library")return libraryRows();
  if(state.evidence==="daily")return currentSeries(state.metric);
  return lagRows();
}
function searchEvidence(list){
  const q=state.search.trim().toLocaleLowerCase();if(!q)return list;
  return list.filter(r=>Object.values(r).some(v=>String(v==null?"":v).toLocaleLowerCase().includes(q))||categoryOf(r.model).toLocaleLowerCase().includes(q));
}
function renderEvidence(){
  renderLibraryControls();
  const list=searchEvidence(evidenceRows());
  const pages=Math.max(1,Math.ceil(list.length/PAGE_SIZE));
  state.pageNo=Math.min(state.pageNo,pages-1);
  const wrap=$("evidenceTableWrap"),offset=state.pageNo*PAGE_SIZE,page=list.slice(offset,offset+PAGE_SIZE);
  $("evidenceMeta").textContent=state.evidence==="daily"?"按小订、留存大定或锁单中的当前口径展示；表内保留原始阶段、批次、来源和负值。筛选命中 "+fmtInt(list.length)+" 条记录。":"留存大定→交车锁单的0–3日共同日期相关性；不代表逐单转化率，也不作为锁单数量预测系数。筛选命中 "+fmtInt(list.length)+" 条记录。";
  if(state.evidence==="library"){
    const table=currentLibrary(),columns=libraryColumns(table);
    $("evidenceMeta").textContent=table.title+" · 当前范围命中 "+fmtInt(list.length)+" 条。"+table.note;
    makeTable(wrap,columns.map(c=>c[1]),page.map(r=>columns.map(([key,label,format])=>{
      const value=fieldValue(r,key),text=format==="source"?sourceValue(value,r.unit):format==="pct"?fmtPct(value):format==="num"?fmtNum(value):format==="corr"?(num(value)===null?"—":value.toFixed(3)):value==null?"—":Array.isArray(value)?value.join("、"):typeof value==="object"?JSON.stringify(value):String(value);
      return {text,cls:typeof value==="number"?"number"+(value<0?" negative":""):""};
    })),"当前资料没有匹配记录。可清除搜索或切换指标、分类、阶段；样本不足的类型仍保留入口。");
  }else if(state.evidence==="daily"){
    makeTable(wrap,["日期","车型","车型分类","指标口径","阶段","观测值","批次 / 周期","来源","生命周期"],
      page.map(r=>[{text:dateOnly(r.date)},{text:r.model},{text:categoryOf(r.model)},{text:metricName(r.metric)+" · "+metricSource(r.metric)},{text:r.stage},{text:fmtNum(r.value),cls:"number"+(num(r.value)<0?" negative":"")},{text:r.cycle},{text:r.source},{text:r.life==null?"—":"D"+r.life}]),
      state.search.trim()?"没有匹配“"+state.search.trim()+"”的记录。清除搜索后查看当前范围。":"当前范围没有逐日观测，可调整日期、车型或销售阶段。");
  }else{
    makeTable(wrap,["车型","分类","阶段","大定来源","锁单来源","滞后日","共同日期数","日期范围","水平相关","日变化相关","说明"],
      page.map(r=>[{text:r.model},{text:categoryOf(r.model)},{text:r.stage},{text:r.deposit_source},{text:r.lock_source},{text:fmtInt(r.lag),cls:"number"},{text:fmtInt(r.pairs),cls:"number"},{text:dateOnly(r.start)+"～"+dateOnly(r.end)},{text:fmtNum(r.level_corr),cls:"number"},{text:fmtNum(r.change_corr),cls:"number"},{text:r.status}]),
      "当前选择没有满足完整日期范围的留存大定与锁单配对样本。");
  }
  $("exportCsv").disabled=!list.length;
  $("exportCsv").title=list.length?"导出所有搜索命中的记录，不限当前页":"没有匹配记录可导出";
  $("evidencePageInfo").textContent="第 "+(state.pageNo+1)+" / "+pages+" 页 · 共 "+fmtInt(list.length)+" 条";
  $("prevPage").disabled=state.pageNo<=0;$("nextPage").disabled=state.pageNo+1>=pages;
}
function csvEscape(v){
  let x=v==null?"":String(v);
  if(typeof v==="string"&&/^[\s\uFEFF]*[=+\-@\t\r]/.test(x))x="'"+x;
  return '"'+x.replace(/"/g,'""')+'"';
}
function exportCsv(){
  const list=searchEvidence(evidenceRows());
  if(!list.length){announce("没有匹配记录可导出，请清除搜索或调整范围。");return;}
  let headers,items;
  if(state.evidence==="library"){
    const columns=libraryColumns(currentLibrary());headers=columns.map(c=>c[1]);items=list.map(r=>columns.map(([key])=>{const value=fieldValue(r,key);return Array.isArray(value)?value.join("、"):value!=null&&typeof value==="object"?JSON.stringify(value):value;}));
  }else if(state.evidence==="daily"){
    headers=["日期","车型","车型分类","指标源口径","阶段","观测值","批次周期","来源","生命周期"];
    items=list.map(r=>[dateOnly(r.date),r.model,categoryOf(r.model),metricSource(r.metric),r.stage,r.value,r.cycle,r.source,r.life==null?"":"D"+r.life]);
  }else{
    headers=["车型","车型分类","阶段","留存大定来源","锁单来源","滞后日","共同日期数","开始日期","结束日期","水平相关","日变化相关","状态"];
    items=list.map(r=>[r.model,categoryOf(r.model),r.stage,r.deposit_source,r.lock_source,r.lag,r.pairs,dateOnly(r.start),dateOnly(r.end),r.level_corr,r.change_corr,r.status]);
  }
  const content="\uFEFF"+[headers,...items].map(row=>row.map(csvEscape).join(",")).join("\r\n");
  const blob=new Blob([content],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=el("a");
  a.href=url;a.download=state.evidence==="library"?"销量规律_"+currentLibrary().title+".csv":"销量规律_"+(state.evidence==="daily"?metricName(state.metric):"留存大定锁单")+"_"+state.stage+"_"+(state.evidence==="daily"?"逐日明细":"留存大定锁单相关")+".csv";a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  announce("已生成 "+fmtInt(list.length)+" 条记录的 CSV，下载已交给浏览器。");
}
function updatePage(page,save=true){
  if(!["overview","patterns","forecast","evidence"].includes(page))page="overview";
  const previousPage=state.page,previousStage=state.stage;
  if(!["patterns","evidence"].includes(page)&&state.stage==="首销及平销")normalizeStageOutsideLaunch();
  state.page=page;
  if(page==="patterns"&&previousPage!=="patterns"&&save)syncPatternStage(state.pattern);
  if(previousPage!==page||previousStage!==state.stage){cache.clear();updateFilters(false);renderRangeNotice();}
  const info={
    overview:["研究首页","查看当前范围的发现与覆盖，选择下一步研究问题。"],
    patterns:["规律研究","日历、阶段进度与订单关系，各有独立研究范围和证据。"],
    forecast:["预测验证","比较同车型历史回测与简单基准，判断规律的预测价值。"],
    evidence:["数据证据","按当前范围核对原始观测、统计依据和完整性。"]
  }[page];
  $("pageTitle").textContent=info[0];$("pageDescription").textContent=info[1];
  document.querySelectorAll("[data-panel]").forEach(b=>{const on=b.dataset.panel===page;b.classList.toggle("is-active",on);b.setAttribute("aria-selected",on?"true":"false");b.tabIndex=on?0:-1;});
  document.querySelectorAll(".page-panel").forEach(p=>p.hidden=p.id!=="panel-"+page);
  if(page==="overview")renderOverview();if(page==="patterns")renderPatterns();if(page==="forecast")renderForecast();if(page==="evidence")renderEvidence();
  showUpdate($("panel-"+page));
  if(save){saveRoute(true);window.scrollTo({top:0});}
}
function refresh(resetPage=true){
  cache.clear();
  if(resetPage)state.pageNo=0;
  renderRangeNotice();
  if(state.page==="overview")renderOverview();
  if(state.page==="patterns")renderPatterns();
  if(state.page==="forecast")renderForecast();
  if(state.page==="evidence")renderEvidence();
  showUpdate($("panel-"+state.page));
  saveRoute(false);
}
function setReportMetadata(){
  $("generatedAt").textContent=meta.generated_at?("生成于 "+String(meta.generated_at).replace("T"," ").slice(0,16)):"";
  $("sourceBadge").textContent="数据源 · "+(meta.source_name||"未提供");
  $("footerSource").textContent="源文件："+(meta.source_name||"未提供")+" · 全量分析日期 "+dateOnly(meta.analysis_start||meta.date_start)+" 至 "+dateOnly(meta.analysis_end||meta.date_end)+" · SHA-256 "+(meta.sha256||"未提供");
}
const motionPreference=window.matchMedia("(prefers-reduced-motion: reduce)");
const runningMotion=new Map();
function showUpdate(node){
  if(!node||node.hidden)return;
  const previous=runningMotion.get(node);if(previous)previous.cancel();
  runningMotion.delete(node);
  if(motionPreference.matches||!node.animate)return;
  const animation=node.animate([{opacity:.78,transform:"translateY(4px)"},{opacity:1,transform:"translateY(0)"}],{duration:180,easing:"ease-out"});
  runningMotion.set(node,animation);
  animation.finished.then(()=>{if(runningMotion.get(node)===animation)runningMotion.delete(node);}).catch(()=>{});
}
motionPreference.addEventListener("change",()=>{if(motionPreference.matches){runningMotion.forEach(a=>a.cancel());runningMotion.clear();}});
let statusTimer;
function announce(message){
  const node=$("actionStatus");clearTimeout(statusTimer);
  node.textContent=message;node.classList.add("is-visible");
  statusTimer=setTimeout(()=>node.classList.remove("is-visible"),5000);
}
const routeKeys=["page","pattern","metric","category","model","stage","start","end","grain","launchGrain","compare","evidence","forecastModel","forecastGrain","profileKey","libraryTable","libraryMetric","libraryCategory","libraryStage","libraryGrain","sourceCurve","sourceHourMetric","sourceHourStage","search","pageNo"];
const routeDefaults={...state};
function saveRoute(push){
  if(restoringRoute)return;
  if(state.start&&state.end)metricDateWindows.set(state.metric,{start:state.start,end:state.end});
  if(state.page==="patterns")domainLastPatterns.set(state.metric+"|"+patternDomain(state.pattern),state.pattern);
  try{sessionStorage.setItem(uiStorageKey,JSON.stringify({version:2,metricDates:Object.fromEntries(metricDateWindows),domainPatterns:Object.fromEntries(domainLastPatterns)}));}catch(_){}
  const params=new URLSearchParams();routeKeys.forEach(k=>params.set(k,String(state[k])));
  const hash="#"+params.toString();
  if(location.hash!==hash)history[push?"pushState":"replaceState"](null,"",hash);
}
function restoreRoute(){
  restoringRoute=true;
  try{
  const hash=location.hash.slice(1),params=new URLSearchParams(hash);
  const routeHasStage=params.has("stage");
  routeKeys.forEach(k=>{state[k]=params.has(k)?k==="compare"?params.get(k)==="true":k==="pageNo"?Number(params.get(k)):params.get(k):routeDefaults[k];});
  if(!Number.isSafeInteger(state.pageNo)||state.pageNo<0)state.pageNo=0;
  if(!hash.includes("=")&&["overview","patterns","forecast","evidence"].includes(hash))state.page=hash;
  if(!metricByKey.get(state.metric)?.available)state.metric=defaultMetric.key;
  if(!["months","week","launch","holiday","cycles","structure","hourly","lags"].includes(state.pattern))state.pattern="months";
  if(!["daily","lags","library"].includes(state.evidence))state.evidence="daily";
  if(!["日","周","月","年"].includes(state.grain))state.grain="月";
  if(!["周","月"].includes(state.launchGrain))state.launchGrain="周";
  if(!["日","周","月"].includes(state.forecastGrain))state.forecastGrain="月";
  if(!["__ALL__","日","周","月","年"].includes(state.libraryGrain))state.libraryGrain="__ALL__";
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+"T00:00:00Z"))&&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
  if(!validDate(state.start)||!validDate(state.end)){state.start="";state.end="";}
  updateFilters(false);
  if(!routeHasStage&&state.page==="patterns")syncPatternStage(state.pattern);
  $("trendGrain").value=state.grain;$("compareMetrics").checked=state.compare;$("forecastGrain").value=state.forecastGrain;
  $("evidenceSearch").value=state.search;
  document.querySelectorAll("[data-evidence]").forEach(b=>{const on=b.dataset.evidence===state.evidence;b.classList.toggle("is-active",on);b.setAttribute("aria-pressed",String(on));});
  clearDateError();refresh(false);updatePage(state.page,false);
  }finally{restoringRoute=false;}
  saveRoute(false);
}
function clearDateError(){
  $("dateError").hidden=true;$("dateError").textContent="";
  ["dateStart","dateEnd"].forEach(id=>$(id).removeAttribute("aria-invalid"));
}
function applyDates(){
  clearDateError();const from=$("dateStart"),to=$("dateEnd");let error="";
  if(!from.value||!to.value)error="请填写开始和结束日期。";
  else if(!from.validity.valid||!to.validity.valid)error="日期须在原始数据覆盖范围内。";
  else if(from.value>to.value)error="开始日期不能晚于结束日期。";
  if(error){
    [from,to].forEach(input=>input.setAttribute("aria-invalid","true"));
    $("dateError").textContent=error+" 结果仍使用上次有效范围；请修正日期或重置。";$("dateError").hidden=false;return;
  }
  state.start=from.value;state.end=to.value;refresh();
}
function syncPatternStage(pattern){
  if(state.metric==="小订数量"){state.stage="小订阶段";return true;}
  const stages=scopedStages(state.metric);
  let target=pattern==="launch"?(stages.includes("首销")&&stages.includes("平销")?"首销及平销":stages.includes("首销")?"首销":stages.includes("平销")?"平销":""):pattern==="holiday"?"平销":pattern==="structure"?"首销":"";
  if(pattern==="hourly"){
    const sourceStages=unique((sourceInsights.hourly||[]).filter(r=>r.metric===state.metric&&modelInScope(r)).map(r=>r.stage));
    if(sourceStages.length&&!sourceStages.includes(state.stage))target=sourceStages.find(s=>stages.includes(s))||"";
  }
  if(!target||!stages.includes(target)&&target!=="首销及平销")return false;
  state.stage=target;
  const select=$("stageFilter");if(select)select.value=target;
  return true;
}
function normalizeStageOutsideLaunch(){
  const stages=scopedStages(state.metric),target=stages.includes("平销")?"平销":stages.includes("首销")?"首销":stages[0]||"";
  state.stage=target;const select=$("stageFilter");if(select)select.value=target;return target;
}
function setPatternStage(stage){
  const stages=scopedStages(state.metric),joint=stage==="首销及平销"&&state.page==="patterns"&&state.pattern==="launch"&&stages.includes("首销")&&stages.includes("平销");
  if(!joint&&!stages.includes(stage))return false;
  state.stage=stage;$("stageFilter").value=stage;refresh();return true;
}
function restorePatternDates(){
  const bounds=metricBounds.get(state.metric)||["",""];
  if(!bounds[0]||!bounds[1])return false;
  state.start=bounds[0];state.end=bounds[1];$("dateStart").value=state.start;$("dateEnd").value=state.end;clearDateError();refresh();return true;
}
function activatePattern(pattern){
  if(!Object.values(researchDomains).some(list=>list.includes(pattern)))return;
  const same=state.page==="patterns"&&state.pattern===pattern;
  if(same){showUpdate($("patternPanels"));announce("当前已是“"+(document.querySelector('[data-pattern="'+pattern+'"]')?.textContent||pattern)+"”，可在下方选择专题或查看证据。");return;}
  const previousStage=state.stage;
  if(state.pattern==="launch"&&pattern!=="launch"&&state.stage==="首销及平销")normalizeStageOutsideLaunch();
  state.pattern=pattern;state.page="patterns";
  if(patternAvailable(pattern))syncPatternStage(pattern);
  domainLastPatterns.set(state.metric+"|"+patternDomain(pattern),pattern);
  cache.clear();updateFilters(false);renderRangeNotice();updatePage("patterns",false);showUpdate($("patternPanels"));saveRoute(!same);
  if(state.stage!==previousStage)announce("已切换到“"+(state.stage==="小订阶段"?"小订期":state.stage)+"”阶段，保留当前车型和日期范围。");
  else announce("已切换到“"+(document.querySelector('[data-pattern="'+pattern+'"]')?.textContent||pattern)+"”。");
}
function bindTabs(container,selector,activate){
  container.addEventListener("keydown",event=>{
    const buttons=[...container.querySelectorAll(selector)].filter(b=>!b.hidden&&!b.disabled);
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key))return;
    const index=buttons.indexOf(event.target);if(index<0)return;
    event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(["ArrowRight","ArrowDown"].includes(event.key)?1:-1)+buttons.length)%buttons.length;
    buttons[next].focus();activate(buttons[next]);
  });
}
bindTabs(document.querySelector(".main-nav"),"[data-panel]",b=>updatePage(b.dataset.panel));
bindTabs(document.querySelector(".subnav"),"[data-pattern]",b=>activatePattern(b.dataset.pattern));
function activateDomain(domain){
  const patterns=researchDomains[domain]||[];
  const remembered=domainLastPatterns.get(state.metric+"|"+domain);
  const target=patterns.includes(state.pattern)?state.pattern:patterns.includes(remembered)?remembered:patterns.find(patternAvailable)||patterns[0];
  activatePattern(target);
}
bindTabs(document.querySelector(".subnav-domain"),"[data-domain]",b=>activateDomain(b.dataset.domain));
document.querySelectorAll("[data-domain]").forEach(b=>b.addEventListener("click",()=>activateDomain(b.dataset.domain)));
window.addEventListener("popstate",restoreRoute);window.addEventListener("hashchange",restoreRoute);
document.querySelector(".skip-link").addEventListener("click",e=>{e.preventDefault();$("mainContent").focus();});
$("toggleFilters").addEventListener("click",()=>{
  const collapsed=document.body.classList.toggle("filters-collapsed");
  $("toggleFilters").setAttribute("aria-expanded",String(!collapsed));
  $("toggleFilters").textContent=collapsed?"展开筛选":"收起筛选";
});
document.querySelector(".brand").addEventListener("click",e=>{e.preventDefault();updatePage("overview");});
document.querySelectorAll("[data-panel]").forEach(b=>b.addEventListener("click",()=>updatePage(b.dataset.panel)));
document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>{updatePage(b.dataset.go);$("pageTitle").focus({preventScroll:true});window.scrollTo({top:0});}));
document.querySelectorAll("[data-metric]").forEach(b=>b.addEventListener("click",()=>{
  if(b.disabled||state.metric===b.dataset.metric)return;
  metricDateWindows.set(state.metric,{start:state.start,end:state.end});
  state.metric=b.dataset.metric;
  const saved=metricDateWindows.get(state.metric);if(saved){state.start=saved.start;state.end=saved.end;}
  if(state.metric==="小订数量"){state.forecastGrain="日";state.profileKey="";$("forecastGrain").value="日";}
  if(!patternAvailable(state.pattern))state.pattern=state.metric==="小订数量"?"structure":"lags";
  if(state.pattern==="hourly")state.sourceHourMetric=state.metric;
  clearDateError();updateFilters(false);if(state.page==="patterns")syncPatternStage(state.pattern);
  if(!saved&&!currentSeries(state.metric).length&&scopedOptionRows(state.metric).some(r=>stageMatches(r))){
    const bounds=metricBounds.get(state.metric)||["",""];state.start=bounds[0];state.end=bounds[1];updateFilters(false);
    announce("当前日期没有该口径记录，已恢复此口径的有效日期范围。");
  }
  refresh();
}));
$("categoryFilter").addEventListener("change",e=>{state.category=e.target.value;state.model="__ALL__";updateFilters(false);refresh();});
$("modelFilter").addEventListener("change",e=>{state.model=e.target.value;updateFilters(false);refresh();});
$("stageFilter").addEventListener("change",e=>{state.stage=e.target.value;refresh();});
$("dateStart").addEventListener("change",applyDates);
$("dateEnd").addEventListener("change",applyDates);
$("resetFilters").addEventListener("click",()=>{metricDateWindows.clear();domainLastPatterns.clear();state.libraryGrain="__ALL__";state.metric=defaultMetric.key;state.category="__ALL__";state.model="__ALL__";state.stage="";state.start="";state.end="";state.grain="月";state.launchGrain="周";state.compare=false;$("trendGrain").value="月";$("launchGrain").value="周";$("compareMetrics").checked=false;$("evidenceSearch").value="";state.search="";state.pageNo=0;clearDateError();updateFilters(true);if(state.page==="patterns"&&(state.pattern==="launch"||state.pattern==="holiday"))syncPatternStage(state.pattern);refresh();announce("已恢复默认口径、车型和日期范围。");});
$("trendGrain").addEventListener("change",e=>{state.grain=e.target.value;refresh();});
$("compareMetrics").addEventListener("change",e=>{state.compare=e.target.checked;refresh();});
$("launchGrain").addEventListener("change",e=>{state.launchGrain=e.target.value;refresh();});
document.querySelectorAll("[data-pattern]").forEach(b=>b.addEventListener("click",()=>activatePattern(b.dataset.pattern)));
$("forecastModel").addEventListener("change",e=>{state.forecastModel=e.target.value;state.profileKey="";renderForecast();showUpdate($("forecastKpis"));saveRoute(false);});
$("forecastGrain").addEventListener("change",e=>{state.forecastGrain=e.target.value;state.profileKey="";renderForecast();showUpdate($("forecastKpis"));saveRoute(false);});
$("forecastProfile").addEventListener("change",e=>{state.profileKey=e.target.value;renderForecast();showUpdate($("forecastKpis"));saveRoute(false);});
document.querySelectorAll('input[name="trialMode"]').forEach(x=>x.addEventListener("change",updateTrial));
let trialTimer;["trialBase","trialDays","trialFactor"].forEach(id=>$(id).addEventListener("input",()=>{clearTimeout(trialTimer);trialTimer=setTimeout(updateTrial,120);}));
document.querySelectorAll("[data-evidence]").forEach(b=>b.addEventListener("click",()=>{
  state.evidence=b.dataset.evidence;state.pageNo=0;
  document.querySelectorAll("[data-evidence]").forEach(x=>{const on=x===b;x.classList.toggle("is-active",on);x.setAttribute("aria-pressed",on?"true":"false");});
  renderEvidence();showUpdate($("evidenceTableWrap"));saveRoute(false);
}));
let searchTimer;$("evidenceSearch").addEventListener("input",e=>{state.search=e.target.value;state.pageNo=0;saveRoute(false);clearTimeout(searchTimer);searchTimer=setTimeout(()=>{renderEvidence();showUpdate($("evidenceTableWrap"));saveRoute(false);},120);});
$("prevPage").addEventListener("click",()=>{state.pageNo=Math.max(0,state.pageNo-1);renderEvidence();showUpdate($("evidenceTableWrap"));saveRoute(false);});
$("nextPage").addEventListener("click",()=>{state.pageNo+=1;renderEvidence();showUpdate($("evidenceTableWrap"));saveRoute(false);});
$("exportCsv").addEventListener("click",exportCsv);
$("openLibrary").addEventListener("click",()=>openLibrary());
$("allRules").addEventListener("click",()=>updatePage("patterns"));
$("openMethods").addEventListener("click",()=>openLibrary("coverage"));
for(const key of ["libraryTable","libraryMetric","libraryCategory","libraryStage","libraryGrain"])$(key).addEventListener("change",e=>{
  state[key]=e.target.value;state.pageNo=0;
  if(key==="libraryTable"){state.libraryMetric="__ALL__";state.libraryCategory="__ALL__";state.libraryStage="__ALL__";state.libraryGrain="__ALL__";state.search="";$("evidenceSearch").value="";}
  renderEvidence();saveRoute(false);
});
let resizeTimer;window.addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>refresh(false),150);});
setReportMetadata();restoreRoute();
document.querySelectorAll("[data-metric]").forEach(b=>{if(b.dataset.metric==="交车锁单"&&!metrics.some(x=>x.key==="交车锁单"&&x.available))b.disabled=true;});
document.querySelectorAll("[data-pattern]").forEach(b=>{const on=b.dataset.pattern===state.pattern;b.classList.toggle("is-active",on);b.setAttribute("aria-selected",on?"true":"false");});
refresh(false);saveRoute(false);
})();
