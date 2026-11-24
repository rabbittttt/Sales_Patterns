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
