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
