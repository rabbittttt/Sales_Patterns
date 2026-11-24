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
