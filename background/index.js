// ═══════════════════════════════════════════════════════════════════════════
// Automated ASRS Operations v1.0 — Single-file Service Worker
// ═══════════════════════════════════════════════════════════════════════════

// CNG Inv Validator — merged in as a new UI tab. Its background logic
// (Quadron/Nexs/Grafana fetchers, the "validator" port) lives in its own
// file and is pulled in here via importScripts, sharing this worker's global
// scope. Auth reuses this file's own getJWT/getGrafanaSession/callGrafanaDS —
// see background/cng-validator.js for details.
importScripts("cng-validator.js");

// ── Constants ─────────────────────────────────────────────────────────────────
const PRIORITY      = { SD:"SD", P0:"P0", P1:"P1", P2:"P2", MANUAL:"MANUAL" };
const CONDITION     = { INSERTED:"inserted", RELEASED:"released", ALREADY_QUEUED:"already_queued", NOT_AVAILABLE:"not_available", SKIPPED:"skipped", IGNORED:"ignored_cooldown", RETRY:"retry" };
const CONDITION_META= {
  inserted:       { label:"Inserted into Queue",            logLevel:"op_ok",   color:"green",  countAsDone:true  },
  released:       { label:"Released from Quadron",          logLevel:"op_ok",   color:"green",  countAsDone:true  },
  already_queued: { label:"Already in Queue / In Movement", logLevel:"op_warn", color:"yellow", countAsDone:false },
  not_available:  { label:"Not Available",                  logLevel:"op_err",  color:"red",    countAsDone:false },
  skipped:        { label:"Manually Skipped",               logLevel:"skipped", color:"muted",  countAsDone:false },
  ignored_cooldown:{ label:"Ignored (Cooldown)",            logLevel:"ignored", color:"blue",   countAsDone:false },
};
const ALARM         = { FETCH:"qtp-fetch", CALL:"qtp-call", MANUAL:"qtp-manual", GRAFANA_LOCKED:"qtp-g-locked", GRAFANA_SUPER:"qtp-g-super" };
const STORE         = { CONFIG:"config", QUEUE:"queue", CALL_HISTORY:"callHistory", LOGS:"logs", AUTO_STATE:"autoState", RUN_STATE:"runState" };
const LIMITS        = { MAX_LOG_ENTRIES:5000, MAX_QUEUE_SIZE:2000, MAX_RETRIES:5, MIN_CALL_INTERVAL:3, STARVATION_THRESHOLD:10 };
const DEFAULTS      = { HOST:"https://192.168.24.230", ZONE:"", INSTANCE_CODE:"LK-069", CALL_INTERVAL:5, RETRY_DELAY:5, BATCH_SIZE:5, FETCH_INTERVAL:2, COOLDOWN_HOURS:1, SHEET_URL:"", GRAFANA_URL:"https://192.168.24.230", GRAFANA_AUTO:false, GRAFANA_LOCKED_INTERVAL:30, GRAFANA_SUPER_ENABLED:true, GRAFANA_SUPER_INTERVAL:60, ASRS_SOURCE:"sheet_dump", P0_MAX_TOTES:1, P1_MAX_TOTES:3 };
const TOTE_REGEX    = /^(TL|TS)[0-9]{10}$/;
const TOTE_EXTRACT  = /T[SL]\d{10}/g;
const MS_24H        = 24*60*60*1000;
const MAX_UI_LOG    = 500;
const MAX_AUTO_LOG  = 300;
const LOG_FLUSH_MS  = 500;
const WB_FLUSH_MS   = 30000;
const WB_FLUSH_MIN  = 5;

// ── Grafana SQL ───────────────────────────────────────────────────────────────
const SQL_LOCKED=`DECLARE @containerId AS VARCHAR(20) = '';
WITH ContainerTracker AS (SELECT container_data.* FROM (SELECT ct.*,ROW_NUMBER() over (PARTITION BY ct.container ORDER BY ct.updated_timestamp DESC) AS rn FROM lenskart_quadron.dbo.container_tracker ct) container_data WHERE container_data.rn=1),
LatestContainerTrackerWithInfo AS (SELECT ct.container,ct.tracker,lt.location,lt.updated_timestamp,e.entity,e.type,lz.[zone],s.id AS shuttle,s.health_status,pc.lock_status FROM ContainerTracker ct LEFT JOIN lenskart_quadron.dbo.location_tracker lt ON ct.tracker=lt.tracker LEFT JOIN lenskart_quadron.dbo.entity e ON e.entity=lt.location LEFT JOIN lenskart_quadron.dbo.location_zone lz ON lz.location=lt.location LEFT JOIN lenskart_quadron.dbo.shuttle s ON s.[zone]=lz.[zone] LEFT JOIN lenskart_quadron.dbo.product_container pc ON pc.id=ct.container),
LatestContainerTracker AS (SELECT t.tote_id,ct.tracker,ct.location,ct.updated_timestamp,ct.type,ct.[zone],ct.shuttle,ct.health_status,ct.lock_status FROM (SELECT DISTINCT SUBSTRING(container,1,12) AS tote_id FROM lenskart_wes.dbo.tote_details) t LEFT JOIN LatestContainerTrackerWithInfo ct ON t.tote_id=ct.container),
BinBlocked AS (SELECT bb.tracker,bb.status,ROW_NUMBER() OVER (PARTITION BY bb.tracker ORDER BY bb.updated_timestamp DESC) AS rn FROM lenskart_quadron.dbo.bin_blocked bb),
FinalContainerTracker AS (SELECT ct.tote_id AS [Container],ct.tracker AS [Tracker],CASE WHEN ct.location IS NULL OR(ct.location IS NOT NULL AND ct.location NOT LIKE '0%') THEN 'OUT' ELSE ct.location END AS [Location],ct.zone AS [Zone],ct.shuttle AS [Shuttle],CASE WHEN ct.health_status=0 THEN 'ERROR' WHEN ct.health_status=1 THEN 'HEALTHY' WHEN ct.health_status=2 THEN 'ACKNOWLEDGEMENT_AWAITING' END AS [Shuttle Health Status],CASE WHEN ct.lock_status=1 THEN 'YES' WHEN ct.lock_status=0 OR ct.lock_status IS NULL THEN 'NO' END AS [Stock_Check_Blocked],CASE WHEN bb.status=0 THEN 'YES' WHEN bb.status=1 OR bb.status IS NULL THEN 'NO' END AS [Bin Blocked],CASE WHEN ct.type=11 THEN 'YES' ELSE 'NO' END AS [Bad Tracker] FROM LatestContainerTracker ct LEFT JOIN BinBlocked bb ON ct.tracker=bb.tracker AND bb.rn=1)
SELECT Container,Tracker,Location,Zone,Shuttle FROM FinalContainerTracker WHERE Stock_Check_Blocked='Yes' AND(@containerId IS NULL OR @containerId='' OR Container=@containerId)`;

const SQL_SUPERVISOR=`SELECT DISTINCT LEFT(d.station,5) AS "StationID",d.station AS "Slot",so.id as "Fitting ID",s.[type],CASE WHEN d.minutes_elapsed BETWEEN 1 AND 59 THEN '0-1 hours' WHEN d.minutes_elapsed BETWEEN 60 AND 119 THEN '1-2 hours' WHEN d.minutes_elapsed BETWEEN 120 AND 179 THEN '2-3 hours' WHEN d.minutes_elapsed BETWEEN 180 AND 239 THEN '3-4 hours' ELSE '>4 hours' END AS TimeCategory,so.wave,so.order_id,sol.priority,d.minutes_elapsed,d.sku,d.tote,d.scanner,d.scan_time,d.[singleBin/doubleBin/containerStatus/shuttleHealth/networkStatus],d.[QueueTote/source/minutesElapsed],d.[Inventory/Borrower],d.quantity_left FROM master.dbo.supervisor_dashboard d INNER JOIN lenskart_gtp.dbo.station s ON s.id=LEFT(d.station,5) INNER JOIN lenskart_wes.dbo.sales_order so ON so.id=d.order_id INNER JOIN lenskart_wes.dbo.sales_order_line sol ON sol.order_id=so.id AND sol.sku=d.sku where d.quantity_left>0`;

// ── Utils ─────────────────────────────────────────────────────────────────────
function isValidToteId(id) { return !!id&&typeof id==="string"&&TOTE_REGEX.test(id.trim()); }
function hoursToMs(h)      { return h*3600000; }
function minutesToMs(m)    { return m*60000; }
// Gap between call STARTS = configured interval. Subtract the time the call
// itself took so the interval is the true cadence, not interval + fetch time.
function nextDelayMs(intervalSec, startedAt){ const want=(Number(intervalSec)||1)*1000; return Math.max(0, want-(Date.now()-startedAt)); }
function generateId()      { return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function formatTime(ts)    { return new Date(ts).toLocaleTimeString(); }
function formatDateTime(ts){ return new Date(ts).toLocaleString(); }
function isInCooldown(toteId,hist,coolMs){ if(!coolMs||coolMs<=0)return false;const e=hist&&hist[toteId];if(!e||!e.lastCalled)return false;return(Date.now()-e.lastCalled)<coolMs; }
function cooldownRemaining(toteId,hist,coolMs){ if(!isInCooldown(toteId,hist,coolMs))return 0;return hist[toteId].lastCalled+coolMs-Date.now(); }
function looksLikeJWT(v)   { if(!v||typeof v!=="string")return false;return/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(stripBearer(v)); }
function stripBearer(v)    { return v.replace(/^Bearer\s+/i,"").trim(); }
function getSubFromJWT(jwt){ try{return JSON.parse(atob(jwt.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).sub||"";}catch{return"";} }
function isJWTExpired(jwt) { try{const p=JSON.parse(atob(jwt.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));return!!p.exp&&p.exp<Math.floor(Date.now()/1000);}catch{return false;} }
function arrayToCSV(rows)  { return rows.map(r=>r.map(v=>{const s=v==null?"":String(v);return(s.includes(",")||s.includes('"')||s.includes("\n"))?'"'+s.replace(/"/g,'""')+'"':s;}).join(",")).join("\n"); }

// ── Storage ───────────────────────────────────────────────────────────────────
function makeConfig(c){
  c=c||{};
  return{host:c.host||DEFAULTS.HOST,zone:c.zone||DEFAULTS.ZONE,instanceCode:c.instanceCode||DEFAULTS.INSTANCE_CODE,callInterval:Number(c.callInterval)||DEFAULTS.CALL_INTERVAL,retryDelay:Number(c.retryDelay)||DEFAULTS.RETRY_DELAY,batchSize:Number(c.batchSize)||DEFAULTS.BATCH_SIZE,fetchInterval:Number(c.fetchInterval)||DEFAULTS.FETCH_INTERVAL,cooldownMinutes:c.cooldownMinutes!==undefined?Number(c.cooldownMinutes):(c.cooldownHours!==undefined?Number(c.cooldownHours)*60:DEFAULTS.COOLDOWN_HOURS*60),sheetUrl:c.sheetUrl||DEFAULTS.SHEET_URL,mode:c.mode||"manual",starvationThreshold:Number(c.starvationThreshold)||LIMITS.STARVATION_THRESHOLD,
  grafanaUrl:c.grafanaUrl||DEFAULTS.GRAFANA_URL,grafanaAuto:!!c.grafanaAuto,grafanaLockedInterval:Number(c.grafanaLockedInterval)||DEFAULTS.GRAFANA_LOCKED_INTERVAL,grafanaSuperEnabled:true,grafanaSuperInterval:Number(c.grafanaSuperInterval)||DEFAULTS.GRAFANA_SUPER_INTERVAL,
  asrsSource:c.asrsSource||DEFAULTS.ASRS_SOURCE,p0MaxTotes:Number(c.p0MaxTotes)||DEFAULTS.P0_MAX_TOTES,p1MaxTotes:Number(c.p1MaxTotes)||DEFAULTS.P1_MAX_TOTES};
}
async function getConfig(){ const{config}=await chrome.storage.local.get(STORE.CONFIG);return makeConfig(config); }
async function saveConfig(u){ const e=await getConfig();const m={...e,...u};await chrome.storage.local.set({[STORE.CONFIG]:makeConfig(m)});return m; }
async function getQueue_store(){ const{queue}=await chrome.storage.local.get(STORE.QUEUE);const q=queue||{};return{sd:Array.isArray(q.sd)?q.sd:[],p0:Array.isArray(q.p0)?q.p0:[],p1:Array.isArray(q.p1)?q.p1:[],p2:Array.isArray(q.p2)?q.p2:[],starvationCounter:Number(q.starvationCounter)||0}; }
async function saveQueue_store(q){ await chrome.storage.local.set({[STORE.QUEUE]:q}); }
async function getCallHistory(){ const{callHistory}=await chrome.storage.local.get(STORE.CALL_HISTORY);return callHistory&&typeof callHistory==="object"?callHistory:{}; }
async function recordCall(toteId,data){ const h=await getCallHistory();const e=h[toteId]||{count:0};h[toteId]={lastCalled:Date.now(),zone:data.zone||"",mode:data.mode||"manual",priority:data.priority||null,condition:data.condition||"",sessionId:data.sessionId||null,count:(e.count||0)+1};await chrome.storage.local.set({[STORE.CALL_HISTORY]:h}); }
async function pruneCallHistory(){ const h=await getCallHistory();const cut=Date.now()-MS_24H;const p={};for(const[id,e]of Object.entries(h))if(e.lastCalled>=cut)p[id]=e;await chrome.storage.local.set({[STORE.CALL_HISTORY]:p}); }
async function getLogs_store(){ const{logs}=await chrome.storage.local.get(STORE.LOGS);return Array.isArray(logs)?logs:[]; }
async function appendLogs_store(entries){ if(!entries||!entries.length)return;const logs=await getLogs_store();const m=[...logs,...entries];await chrome.storage.local.set({[STORE.LOGS]:m.length>LIMITS.MAX_LOG_ENTRIES?m.slice(-LIMITS.MAX_LOG_ENTRIES):m}); }
async function clearLogs_store(){ await chrome.storage.local.set({[STORE.LOGS]:[]}); }
async function pruneLogs_store(){ const logs=await getLogs_store();const cut=Date.now()-MS_24H;const f=logs.filter(e=>e.t>=cut);await chrome.storage.local.set({[STORE.LOGS]:f}); }
async function getAutoState_store(){ const{autoState}=await chrome.storage.local.get(STORE.AUTO_STATE);return autoState||{running:false,paused:false,status:"idle"}; }
async function saveAutoState_store(u){ const e=await getAutoState_store();await chrome.storage.local.set({[STORE.AUTO_STATE]:{...e,...u}}); }
async function getRunState(){ const{runState}=await chrome.storage.local.get(STORE.RUN_STATE);return runState||null; }
async function saveRunState(s){ await chrome.storage.local.set({[STORE.RUN_STATE]:s}); }

// ── Logger ─────────────────────────────────────────────────────────────────────
let _logBuf=[],_logTimer=null;
function writeLog(level,message,meta){ const e={id:generateId(),t:Date.now(),level,message,toteId:(meta&&meta.toteId)||null,zone:(meta&&meta.zone)||null,mode:(meta&&meta.mode)||null,priority:(meta&&meta.priority)||null,source:(meta&&meta.source)||null,condition:(meta&&meta.condition)||null,retries:(meta&&meta.retries)||0,apiMsg:(meta&&meta.apiMsg)||null,sessionId:(meta&&meta.sessionId)||null};_logBuf.push(e);if(!_logTimer)_logTimer=setTimeout(flushLogBuffer,LOG_FLUSH_MS);return e; }
async function flushLogBuffer(){ _logTimer=null;if(!_logBuf.length)return;const w=[..._logBuf];_logBuf=[];await appendLogs_store(w); }
async function flushLogsNow(){ if(_logTimer){clearTimeout(_logTimer);_logTimer=null;}if(!_logBuf.length)return;const w=[..._logBuf];_logBuf=[];await appendLogs_store(w); }
function logInfo(msg,meta){ return writeLog("info",msg,meta); }
function logWarn(msg,meta){ return writeLog("warn",msg,meta); }
function logNetErr(msg,meta){ return writeLog("net_err",msg,meta); }
function logOpOk(tote,zone,cond,meta){ return writeLog("op_ok",`[${tote} → ${zone}] ${(CONDITION_META[cond]||{}).label||cond}`,{toteId:tote,zone,condition:cond,...(meta||{})}); }
function logOpWarn(tote,zone,cond,meta){ return writeLog("op_warn",`[${tote} → ${zone}] ${(CONDITION_META[cond]||{}).label||cond}`,{toteId:tote,zone,condition:cond,...(meta||{})}); }
function logOpErr(tote,zone,cond,meta){ return writeLog("op_err",`[${tote} → ${zone}] ${(CONDITION_META[cond]||{}).label||cond}`,{toteId:tote,zone,condition:cond,...(meta||{})}); }
function logSkipped(tote,zone,meta){ return writeLog("skipped",`⏭ [${tote} → ${zone}] Manually skipped`,{toteId:tote,zone,condition:"skipped",...(meta||{})}); }
function logIgnored(tote,zone,rem,meta){ return writeLog("ignored",`[${tote} → ${zone}] Cooldown — ${Math.ceil(rem/60000)}m remaining`,{toteId:tote,zone,condition:"ignored_cooldown",...(meta||{})}); }
function logRetry(tote,zone,msg,n,meta){ return writeLog("net_err",`⚠ [${tote} → ${zone}] ${msg} — Retry ${n}…`,{toteId:tote,zone,retries:n,apiMsg:msg,...(meta||{})}); }
function logAutoSkip(tote,zone,n,meta){ return writeLog("net_err",`⏭ [${tote} → ${zone}] Auto-skipped after ${n} retries`,{toteId:tote,zone,retries:n,condition:"skipped",...(meta||{})}); }
function logSessionStart(total,zone,ic,mode,sid){ return writeLog("info",`▶ Session started — ${total} totes → Zone ${zone} on ${ic} [${mode.toUpperCase()}]`,{zone,mode,sessionId:sid}); }
function logSessionStop(called,total,mode,sid){ return writeLog("info",`■ Stopped — ${called}/${total} [${mode.toUpperCase()}]`,{mode,sessionId:sid}); }
function logSessionDone(called,total,mode,sid){ return writeLog("info",`✓ Complete — ${called}/${total} [${mode.toUpperCase()}]`,{mode,sessionId:sid}); }
async function searchLogs(filters){ await flushLogsNow();let logs=await getLogs_store();if(!filters)return logs.slice(-200).reverse();if(filters.toteId)logs=logs.filter(e=>e.toteId===filters.toteId);if(filters.level)logs=logs.filter(e=>e.level===filters.level);if(filters.mode)logs=logs.filter(e=>e.mode===filters.mode);if(filters.condition)logs=logs.filter(e=>e.condition===filters.condition);if(filters.from)logs=logs.filter(e=>e.t>=filters.from);if(filters.to)logs=logs.filter(e=>e.t<=filters.to);if(filters.query){const q=filters.query.toLowerCase();logs=logs.filter(e=>(e.message&&e.message.toLowerCase().includes(q))||(e.toteId&&e.toteId.toLowerCase().includes(q)));}return logs.slice(-(filters.limit||200)).reverse(); }
async function exportLogsCSV(){ await flushLogsNow();const logs=await getLogs_store();const hdr=["ID","Timestamp","Level","Message","Tote ID","Zone","Mode","Priority","Condition","Retries","API Msg","Session"];return arrayToCSV([hdr,...logs.map(e=>[e.id,formatDateTime(e.t),e.level,e.message,e.toteId||"",e.zone||"",e.mode||"",e.priority||"",e.condition||"",e.retries||0,e.apiMsg||"",e.sessionId||""])]); }

// ── Priority Queue ─────────────────────────────────────────────────────────────
const _pq={ SD:new Map(),[PRIORITY.P0]:new Map(),[PRIORITY.P1]:new Map(),[PRIORITY.P2]:new Map() };
let _pqStarvation=0,_pqPreempt=false,_pqLoaded=false,_pqTimer=null;
const PQ_LEVELS=["SD",PRIORITY.P0,PRIORITY.P1,PRIORITY.P2];

function pqHas(toteId){ return PQ_LEVELS.some(l=>_pq[l].has(toteId)); }
function pqSize(){ return PQ_LEVELS.reduce((s,l)=>s+_pq[l].size,0); }
function pqEmpty(){ return pqSize()===0; }
function pqShouldPreempt(){ return _pqPreempt&&(_pq["SD"].size>0||_pq[PRIORITY.P0].size>0); }
function pqSDCount(){ return _pq["SD"].size; }

function pqInsert(toteId,priority,source,meta){
  priority=priority||PRIORITY.P2;source=source||"Manual";meta=meta||{};
  if(!isValidToteId(toteId))return"invalid";
  if(pqHas(toteId))return"duplicate";
  if(pqSize()>=LIMITS.MAX_QUEUE_SIZE)return"full";
  const entry={toteId,priority,source,addedAt:Date.now(),pid:meta.pid||null,barcodeCount:meta.barcodeCount||null,entryId:generateId()};
  (_pq[priority]||_pq[PRIORITY.P2]).set(toteId,entry);
  if(priority===PRIORITY.P0||priority==="SD")_pqPreempt=true;
  pqPersist();return"inserted";
}
function pqInsertMany(totes,priority,source){ const r={inserted:0,duplicates:0,invalid:0,full:0};for(const t of totes){const id=typeof t==="string"?t:t.toteId;const o=pqInsert(id,priority,t.source||source,t.meta||{});r[o==="inserted"?"inserted":o==="duplicate"?"duplicates":o==="invalid"?"invalid":"full"]++;}return r; }
function pqUpdatePriority(toteId,newPriority,source,meta){
  // Relocate an already-queued tote to a different priority bucket if its
  // priority changed (e.g. Quadron reclassified a P2 tote as P0/P1 on a later
  // fetch). Also refreshes pid/barcodeCount/source intel. Returns true if the
  // tote actually moved buckets, false if it stayed put / wasn't found.
  newPriority=newPriority||PRIORITY.P2; if(!_pq[newPriority])newPriority=PRIORITY.P2; meta=meta||{};
  let curLvl=null,entry=null;
  for(const lvl of PQ_LEVELS){if(_pq[lvl].has(toteId)){curLvl=lvl;entry=_pq[lvl].get(toteId);break;}}
  if(!entry)return false;
  if(source)entry.source=source;
  if(meta.pid!=null)entry.pid=meta.pid;
  if(meta.barcodeCount!=null)entry.barcodeCount=meta.barcodeCount;
  if(curLvl===newPriority){pqPersist();return false;}
  _pq[curLvl].delete(toteId);
  entry.priority=newPriority;
  _pq[newPriority].set(toteId,entry);
  if(newPriority===PRIORITY.P0||newPriority==="SD")_pqPreempt=true;
  pqPersist();
  return true;
}
function pqNext(batchSize){ batchSize=batchSize||1;const batch=[];if(_pqStarvation>=LIMITS.STARVATION_THRESHOLD&&_pq[PRIORITY.P2].size>0){const t=_pq[PRIORITY.P2].values().next().value;if(t){batch.push(t);_pq[PRIORITY.P2].delete(t.toteId);}_pqStarvation=0;}for(const lvl of PQ_LEVELS){if(batch.length>=batchSize)break;for(const[id,e]of _pq[lvl]){if(batch.length>=batchSize)break;batch.push(e);_pq[lvl].delete(id);}}const hasP2=batch.some(e=>e.priority===PRIORITY.P2);if(!hasP2&&batch.length>0)_pqStarvation++;else if(hasP2)_pqStarvation=0;_pqPreempt=false;pqPersist();return batch; }
function pqRemove(toteId){ for(const lvl of PQ_LEVELS){if(_pq[lvl].has(toteId)){_pq[lvl].delete(toteId);pqPersist();return true;}}return false; }
function pqFlush(priority){ if(priority){if(_pq[priority])_pq[priority].clear();}else{PQ_LEVELS.forEach(l=>_pq[l].clear());_pqStarvation=0;_pqPreempt=false;}pqPersist(); }
function pqSnapshot(){ return{sd:[..._pq["SD"].values()],p0:[..._pq[PRIORITY.P0].values()],p1:[..._pq[PRIORITY.P1].values()],p2:[..._pq[PRIORITY.P2].values()],total:pqSize(),sdCount:_pq["SD"].size,p0Count:_pq[PRIORITY.P0].size,p1Count:_pq[PRIORITY.P1].size,p2Count:_pq[PRIORITY.P2].size,locked:(grafanaSt&&grafanaSt.breakdown)?grafanaSt.breakdown:null}; }
function pqPersist(){ if(_pqTimer)return;_pqTimer=setTimeout(async()=>{_pqTimer=null;await saveQueue_store({sd:[..._pq["SD"].values()],p0:[..._pq[PRIORITY.P0].values()],p1:[..._pq[PRIORITY.P1].values()],p2:[..._pq[PRIORITY.P2].values()],starvationCounter:_pqStarvation});},500); }
let _pqLoading=null;
async function pqLoad(){ if(_pqLoaded)return;if(_pqLoading)return _pqLoading;_pqLoading=(async()=>{const saved=await getQueue_store();if(saved){for(const e of saved.sd||[])if(isValidToteId(e.toteId))_pq["SD"].set(e.toteId,e);for(const e of saved.p0||[])if(isValidToteId(e.toteId))_pq[PRIORITY.P0].set(e.toteId,e);for(const e of saved.p1||[])if(isValidToteId(e.toteId))_pq[PRIORITY.P1].set(e.toteId,e);for(const e of saved.p2||[])if(isValidToteId(e.toteId))_pq[PRIORITY.P2].set(e.toteId,e);_pqStarvation=saved.starvationCounter||0;}_pqLoaded=true;_pqLoading=null;})();return _pqLoading; }

// ── Grafana Integration ────────────────────────────────────────────────────────
const grafanaSt={connected:false,lastLockedFetch:null,lastSuperFetch:null,lockedCount:0,superCount:0,errors:0,status:"idle",lastError:"",breakdown:{sd:0,p0:0,p1:0,p2:0,total:0}};

async function getGrafanaSession(host){
  try{
    // grafana_session cookie is set at /grafana/ path, not root — must check that path
    const byPath=await chrome.cookies.getAll({url:host+"/grafana/"});
    const c1=byPath.find(x=>x.name==="grafana_session");
    if(c1)return c1.value;
    // Fallback: search all cookies by name (catches any path variation)
    const byName=await chrome.cookies.getAll({name:"grafana_session"});
    if(byName.length>0)return byName[0].value;
    return null;
  }catch(e){return null;}
}
async function checkGrafanaConnection(host){ const s=await getGrafanaSession(host||DEFAULTS.GRAFANA_URL);grafanaSt.connected=!!s;broadcastGrafanaStatus();return{connected:!!s}; }

function buildGrafanaBody(datasourceUid,datasourceType,datasourceId,sql,fromMs,toMs){
  return{queries:[{refId:"A",datasource:{type:datasourceType,uid:datasourceUid},rawSql:sql,format:"table",datasourceId:datasourceId,intervalMs:60000,maxDataPoints:636}],range:{from:new Date(fromMs).toISOString(),to:new Date(toMs).toISOString(),raw:{from:"now-6h",to:"now"}},from:String(fromMs),to:String(toMs)};
}

async function callGrafanaDS(host,body){
  // Try direct SW fetch first (works if CORS permits)
  try{
    const r=await fetch(`${host}/grafana/api/ds/query`,{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},credentials:"include",body:JSON.stringify(body)});
    if(r.status===401)throw new Error("grafana_session expired — log into Grafana");
    if(!r.ok)throw new Error(`Grafana HTTP ${r.status}`);
    return await r.json();
  }catch(swErr){
    // Fall back to tab relay (same origin — no CORS)
    try{ return await callGrafanaViaTab(host,body); }
    catch(tabErr){ throw new Error((swErr.message||String(swErr))+" | tab: "+(tabErr.message||String(tabErr))); }
  }
}

async function callGrafanaViaTab(host,body){
  const u=new URL(host);
  // "*" matches http or https — an exact protocol mismatch would otherwise
  // report "no tab open" even with a valid, logged-in tab sitting right there.
  const tabs=await chrome.tabs.query({url:`*://${u.host}/grafana/*`});
  if(!tabs||!tabs.length)throw new Error(`No Grafana tab open. Open https://${u.host}/grafana/ and log in.`);
  const errors=[];
  for(const tab of tabs){
    try{
      const res=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",args:[`${host}/grafana/api/ds/query`,body],func:async(url,reqBody)=>{try{const r=await fetch(url,{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},credentials:"include",body:JSON.stringify(reqBody)});if(!r.ok)return{ok:false,status:r.status,error:`HTTP ${r.status}`};return{ok:true,data:await r.json()};}catch(e){return{ok:false,error:e.message||String(e)};}}});
      const result=res&&res[0]&&res[0].result;
      if(!result)throw new Error("Tab relay returned no result");
      if(!result.ok)throw new Error(result.error||"Grafana tab relay failed");
      return result.data;
    }catch(e){
      errors.push(`tab ${tab.id}: ${e.message||String(e)}`);
      // Try the next matching tab, if any, rather than failing on the first one.
    }
  }
  // Every matching tab failed. "Showing error page" specifically means Chrome
  // found the tab but it's displaying its own network-error interstitial, not
  // live Grafana content — that's a stale/failed page load, not a missing tab.
  if(errors.some(e=>/showing error page/i.test(e)))
    throw new Error(`Grafana tab is open but showing an error page (stale or failed load) — refresh that tab so it's actually displaying Grafana, then try again. [${errors.join("; ")}]`);
  throw new Error(errors.join("; ")||"Grafana tab relay failed");
}

async function fetchLockedTotesGrafana(host){
  const now=Date.now();
  const body=buildGrafanaBody("rerQ11pVk","mssql",1,SQL_LOCKED,now-6*3600000,now);
  const data=await callGrafanaDS(host,body);
  const values=data?.results?.A?.frames?.[0]?.data?.values;
  if(!values||!values[0])return[];
  return values[0].filter(id=>isValidToteId(id));
}

async function fetchSupervisorTotesGrafana(host){
  const now=Date.now();
  const body=buildGrafanaBody("A83AuthVz","mssql",2,SQL_SUPERVISOR,now-3600000,now);
  const data=await callGrafanaDS(host,body);
  const values=data?.results?.A?.frames?.[0]?.data?.values;
  if(!values)return[];

  // Supervisor Dump field indices (from API schema):
  //   [13] = singleBin/doubleBin/containerStatus/shuttleHealth/networkStatus
  //          e.g. "007-06-1-217-1-02///LOCKED/HEALTHY/"
  //          Only rows where this field contains "LOCKED" are SD candidates
  //
  //   [15] = Inventory/Borrower
  //          e.g. "007-06-1-217-1-02/TS0000003490-1/QUADRON/"
  //          The ACTUAL tote ID is embedded here (format: location/TOTE-PARTITION/QUADRON/)
  //          NOT in the [10] tote field which may be empty or show queue totes

  const toteSet=new Set();
  const statusVals=values[13]||[];
  const inventoryVals=values[15]||[];
  const rowCount=Math.max(statusVals.length,inventoryVals.length);

  for(let i=0;i<rowCount;i++){
    const status=String(statusVals[i]||"").toUpperCase();
    if(!status.includes("LOCKED"))continue; // only LOCKED container status rows

    // Extract tote ID from Inventory/Borrower field
    // Pattern: "location/TOTE_ID-PARTITION/QUADRON/" → extract TOTE_ID
    const invBorrower=String(inventoryVals[i]||"");
    if(!invBorrower)continue;
    const matches=invBorrower.match(TOTE_EXTRACT);
    if(matches)matches.forEach(t=>{ if(isValidToteId(t))toteSet.add(t); });
  }

  return[...toteSet];
}

// ── Supervisor Dashboard RCA ─────────────────────────────────────────────────
// Same SQL_SUPERVISOR query / datasource as fetchSupervisorTotesGrafana above,
// but pulls every column (not just the LOCKED-status subset) so each row can
// be run through the RCA rule engine below. Column order is fixed by the
// SELECT list in SQL_SUPERVISOR; indices are positional (same approach as the
// [13]/[15] extraction already verified above — NOT named-field access, since
// that behaviour hasn't been confirmed against this datasource).
const RCA_COL = {
  STATION_ID:0, SLOT:1, FITTING_ID:2, TYPE:3, TIME_CATEGORY:4, WAVE:5,
  ORDER_ID:6, PRIORITY:7, MINUTES_ELAPSED:8, SKU:9, TOTE:10, SCANNER:11,
  SCAN_TIME:12, CONTAINER_STATUS:13, QUEUE_TOTE:14, INVENTORY_BORROWER:15,
  QUANTITY_LEFT:16,
};

// Wraps SQL_SUPERVISOR as a subquery and filters on its own computed
// TimeCategory / type columns — this is the ONE place selection happens, so
// Grafana only ever returns the rows the user actually asked for, instead of
// the whole dashboard being pulled and discarded client-side. Filtering on
// the subquery's own output column (rather than re-deriving the TimeCategory
// CASE boundaries here) guarantees it matches SQL_SUPERVISOR's own bucketing
// exactly, with no risk of the two drifting out of sync.
function buildRcaSql(timeCategories, types){
  let sql = `SELECT * FROM (${SQL_SUPERVISOR}) AS sub WHERE 1=1`;
  const tc = (timeCategories||[]).filter(Boolean);
  if(tc.length){
    const inList = tc.map(t => `'${String(t).replace(/'/g,"''")}'`).join(",");
    sql += ` AND sub.TimeCategory IN (${inList})`;
  }
  const ty = (types||[]).map(t => String(t).replace(/[^A-Za-z0-9_\-]/g,"")).filter(Boolean);
  if(ty.length){
    const inList = ty.map(t => `'${t}'`).join(",");
    sql += ` AND sub.[type] IN (${inList})`;
  }
  return sql;
}

async function fetchSupervisorDashboardRows(host, timeCategories, types){
  const now=Date.now();
  const sql=buildRcaSql(timeCategories, types);
  const body=buildGrafanaBody("A83AuthVz","mssql",2,sql,now-3600000,now);
  const data=await callGrafanaDS(host,body);
  const values=data?.results?.A?.frames?.[0]?.data?.values;
  if(!values||!values[0])return[];
  const c=RCA_COL,n=values[0].length,out=[];
  for(let i=0;i<n;i++){
    out.push({
      stationId:values[c.STATION_ID]?.[i], slot:values[c.SLOT]?.[i],
      fittingId:values[c.FITTING_ID]?.[i], type:values[c.TYPE]?.[i],
      timeCategory:values[c.TIME_CATEGORY]?.[i], wave:values[c.WAVE]?.[i],
      orderId:values[c.ORDER_ID]?.[i], priority:values[c.PRIORITY]?.[i],
      minutesElapsed:values[c.MINUTES_ELAPSED]?.[i], sku:values[c.SKU]?.[i],
      tote:values[c.TOTE]?.[i], scanner:values[c.SCANNER]?.[i],
      scanTime:values[c.SCAN_TIME]?.[i], containerStatus:values[c.CONTAINER_STATUS]?.[i],
      queueTote:values[c.QUEUE_TOTE]?.[i], inventoryBorrower:values[c.INVENTORY_BORROWER]?.[i],
      quantityLeft:values[c.QUANTITY_LEFT]?.[i],
    });
  }
  return out;
}

// Grafana's /api/ds/query (JSON) path serializes scan_time as epoch-ms, and
// does so by treating the DB's naive IST datetime as if it were UTC — every
// value comes back 5:30 ahead of the real IST moment. Confirmed against live
// data on 2026-07-27 (user's clock: 6:20 PM; raw values corrected to
// 6:08-6:10 PM matched a batch of just-scanned totes exactly). This does NOT
// apply to Grafana's native "download panel as CSV" path, which already
// returns a correct plain IST string — only this JSON/epoch-ms path is wrong.
// If the underlying Grafana MSSQL datasource plugin is ever reconfigured or
// upgraded to serialize datetimes correctly, this offset must be removed or
// it will start UNDER-correcting by the same amount.
const GRAFANA_SCAN_TIME_TZ_FIX_MS = 5.5*3600000; // 19,800,000 ms = 5h30m

function rcaToMs(v){
  if(v==null||v==="")return null;
  const n=Number(v);
  if(!isNaN(n)&&n>1e10)return n-GRAFANA_SCAN_TIME_TZ_FIX_MS; // epoch ms, mislabeled UTC -> correct back to real IST instant
  const t=Date.parse(v);
  return isNaN(t)?null:t;
}

// RCA rule engine — evaluated top-down, FIRST match wins. To add a new
// condition later, just push another {code,label,test} entry; `f` gives you
// the pre-computed fields below so new rules stay one-liners.
const RCA_RULES=[
  { code:"NO_INVENTORY",    label:"No Inventory",
    test:f=>/NO-INVENTORY/.test(f.invBorrower) },
  { code:"BIN_BLOCKED",     label:"Bin Blocked",
    test:f=>f.status.includes("BIN_BLOCKED") },
  { code:"LOCKED",          label:"Locked",
    test:f=>f.status.includes("LOCKED") },
  { code:"SHUTTLE_OFFLINE", label:"Shuttle Offline",
    test:f=>f.status.includes("SHUTTLE_OFFLINE")||f.status.includes("UNHEALTHY") },
  // TNFT: Inventory/Borrower (col P) shows a REAL location prefix (any zone
  // code like "007-...", NOT the no-location "/..." pattern GTP/Outside-Tote
  // key off of) — tote-ID match against col K is NOT required (confirmed:
  // most real rows have K != the tote embedded in P, and that's normal, not
  // disqualifying). Two ways in: (a) a scan within the last 12h (widened from
  // an initial 2h — confirmed rows with a same-day-morning scan still
  // weren't catching at 2h), or (b) scanner AND container status (cols L, N)
  // are blank. Col O (queue-tote) is deliberately NOT required to be blank
  // here — confirmed rows with L/M/N genuinely blank still had a non-blank
  // col O, so requiring it blocked real TNFT matches. The 12h cutoff also
  // lines up cleanly with Outside Tote's >12h threshold below — together
  // they cover the full age range for a located, non-GTP tote with no exact
  // complaint.
  { code:"TNFT",             label:"TNFT",
    test:f=>{
      if(!f.hasLocation)return false;
      if(f.scanTimeEmpty)return f.scannerEmpty&&f.containerStatusEmpty;
      return f.ageMs!=null&&f.ageMs<=12*3600000;
    } },
  // GTP must be checked BEFORE the generic Outside-Tote pattern below: both
  // patterns lack a location prefix (e.g. "/TS.../GTP/" vs "/TS.../QUADRON/"),
  // so GTP needs to claim its rows first or Outside Tote would catch them too.
  { code:"GTP_TRANSIT",     label:"GTP In Transit",
    test:f=>/\/GTP\//.test(f.invBorrower)&&f.ageMs!=null&&f.ageMs<=3600000 },
  { code:"OUTSIDE_TOTE",    label:"Outside Tote",
    test:f=>(!f.status.trim()&&f.ageMs!=null&&f.ageMs>12*3600000)||/^\s*\//.test(f.invBorrowerRaw) },
];

function classifySupervisorRow(row){
  const invBorrowerRaw=String(row.inventoryBorrower||"");
  const scanMs=rcaToMs(row.scanTime);
  const f={
    status:String(row.containerStatus||"").toUpperCase(),
    invBorrower:invBorrowerRaw.toUpperCase(),
    invBorrowerRaw,
    ageMs:scanMs!=null?Date.now()-scanMs:null,
    hasLocation:invBorrowerRaw.trim()!==""&&!/^\//.test(invBorrowerRaw.trim()),
    scanTimeEmpty:!String(row.scanTime||"").trim(),
    scannerEmpty:!String(row.scanner||"").trim(),
    containerStatusEmpty:!String(row.containerStatus||"").trim(),
  };
  for(const rule of RCA_RULES){ if(rule.test(f))return{code:rule.code,label:rule.label}; }
  return{code:"UNCLASSIFIED",label:"Unclassified"};
}

async function rcaRun(host, timeCategories, types){
  host=(host||DEFAULTS.GRAFANA_URL).replace(/\/+$/,"");
  const rawRows=await fetchSupervisorDashboardRows(host, timeCategories, types);
  return rawRows.map(r=>{
    const rule=classifySupervisorRow(r);
    // Tote field can be blank on some rows — fall back to the ID embedded in
    // Inventory/Borrower (same TOTE_EXTRACT pattern used for the SD queue above).
    let resolvedTote=isValidToteId(r.tote)?String(r.tote).toUpperCase():"";
    if(!resolvedTote){
      const m=String(r.inventoryBorrower||"").match(TOTE_EXTRACT);
      if(m&&m[0])resolvedTote=m[0].toUpperCase();
    }
    return{...r,resolvedTote,rcaCode:rule.code,rcaLabel:rule.label};
  });
}

async function processWithTotesViaSheet(sheetUrl,lockedTotes,supervisorTotes){
  const resp=await fetch(sheetUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"processWithTotes",lockedTotes,supervisorTotes}),redirect:"follow"});
  if(!resp.ok)throw new Error(`Apps Script HTTP ${resp.status}`);
  const data=await resp.json();
  if(!data.ok)throw new Error(data.error||"processWithTotes returned ok:false");
  return data;
}

function assignPriorityLocally(lockedTotes,supervisorTotes){
  const sdSet=new Set(supervisorTotes.map(t=>String(t).toUpperCase()));
  return lockedTotes.map(id=>({toteId:id,priority:sdSet.has(id.toUpperCase())?"SD":PRIORITY.P2,source:sdSet.has(id.toUpperCase())?"Supervisor Dump":"Locked Tote Dump",pid:null,barcodeCount:null}));
}

async function runGrafanaFetchCycle(config){
  if(!config.grafanaUrl){return{ok:false,reason:"Grafana URL not set"};}
  grafanaSt.status="fetching";grafanaSt.errors=0;broadcastGrafanaStatus();
  let lockedTotes=[],supervisorTotes=[];

  try{
    lockedTotes=await fetchLockedTotesGrafana(config.grafanaUrl);
    grafanaSt.lastLockedFetch=Date.now();grafanaSt.lockedCount=lockedTotes.length;grafanaSt.connected=true;
    writeLog("info",`↻ Grafana locked totes: ${lockedTotes.length} fetched`);
  }catch(err){
    grafanaSt.errors++;grafanaSt.lastError=err.message||String(err);grafanaSt.connected=false;
    writeLog("net_err",`↻ Grafana locked fetch failed: ${err.message}`);
    broadcastGrafanaStatus();return{ok:false,reason:err.message};
  }

  if(config.grafanaSuperEnabled){
    try{
      const rawSupervisor=await fetchSupervisorTotesGrafana(config.grafanaUrl);
      // Cross-reference supervisor totes against locked tote dump (source of truth)
      // Only totes present in BOTH qualify for SD priority
      const lockedSet=new Set(lockedTotes.map(t=>t.toUpperCase()));
      supervisorTotes=rawSupervisor.filter(t=>lockedSet.has(t.toUpperCase()));
      grafanaSt.lastSuperFetch=Date.now();
      grafanaSt.superCount=supervisorTotes.length; // shows intersection, not raw count
      writeLog("info",`↻ Grafana supervisor: ${rawSupervisor.length} fetched, ${supervisorTotes.length} in locked dump → SD`);
    }catch(err){
      writeLog("net_err",`↻ Grafana supervisor fetch failed: ${err.message}`);
    }
  }

  // Prioritise — branch on asrsSource: "quadron_api" (live) or "sheet_dump" (GAS)
  let prioritised=[];
  let sheetCounts={sdCount:0,p0Count:0,p1Count:0,p2Count:0};

  if(config.asrsSource==="quadron_api"&&lockedTotes.length>0){
    // ── Quadron Live API path ─────────────────────────────────────────────
    try{
      writeLog("info","↻ ASRS source: Quadron API — fetching live inventory…");
      const invResult=await fetchInventoryDashboard(config.grafanaUrl||config.host,config.instanceCode);
      if(!invResult.ok) throw new Error(invResult.reason||"Inventory fetch failed");
      const{queue,counts}=buildPIDMapFromInventory(invResult.data,lockedTotes,supervisorTotes,config.p0MaxTotes,config.p1MaxTotes);
      prioritised=queue;
      sheetCounts={sdCount:counts.SD,p0Count:counts.P0,p1Count:counts.P1,p2Count:counts.P2};
      writeLog("info",`↻ Quadron PID map: SD:${counts.SD} P0:${counts.P0} P1:${counts.P1} P2:${counts.P2}${invResult.via==="tab"?" (via tab)":""}`);
    }catch(err){
      writeLog("warn",`↻ Quadron inventory failed, falling back to local priority: ${err.message}`);
      prioritised=assignPriorityLocally(lockedTotes,supervisorTotes);
    }
  }else if(config.sheetUrl&&lockedTotes.length>0){
    // ── Sheet Dump path (GAS processWithTotes) ────────────────────────────
    try{
      const r=await processWithTotesViaSheet(config.sheetUrl,lockedTotes,supervisorTotes);
      prioritised=r.queue||[];
      sheetCounts={sdCount:r.sdCount||0,p0Count:r.p0Count||0,p1Count:r.p1Count||0,p2Count:r.p2Count||0};
    }
    catch(err){writeLog("warn",`↻ Apps Script processWithTotes failed, using local priority: ${err.message}`);prioritised=assignPriorityLocally(lockedTotes,supervisorTotes);}
  }else{
    // ── Local fallback (SD/P2 only, no PID intel) ─────────────────────────
    prioritised=assignPriorityLocally(lockedTotes,supervisorTotes);
  }

  // Snapshot the locked-dump composition so the Queue panel reflects the real
  // current locked picture (refreshed each fetch) instead of the draining queue.
  { let _sd=0,_p0=0,_p1=0,_p2=0; for(const it of prioritised){const p=it.priority; if(p==="SD")_sd++; else if(p===PRIORITY.P0)_p0++; else if(p===PRIORITY.P1)_p1++; else _p2++;} grafanaSt.breakdown={sd:_sd,p0:_p0,p1:_p1,p2:_p2,total:lockedTotes.length}; }

  // Differential merge
  const currentIds=new Set(PQ_LEVELS.flatMap(l=>[..._pq[l].keys()]));
  const newIds=new Set(prioritised.map(t=>t.toteId));
  let cleared=0,inserted=0,kept=0,reprioritized=0;
  const insertedTotes=[],clearedTotes=[];

  // Remove totes no longer in Grafana (cleared before we called them)
  for(const id of currentIds){
    if(!newIds.has(id)){pqRemove(id);cleared++;clearedTotes.push(id);writeLog("info",`✓ Cleared from locked dump: ${id}`,{toteId:id});}
  }

  // Add new totes — and re-prioritise totes already queued whose priority changed.
  // Without the re-prioritise branch, a tote first inserted as P2 (e.g. by the
  // sheet/local fallback, which only emit SD/P2) would stay stuck in P2 forever
  // even after Quadron reclassifies it as P0/P1 on a subsequent fetch.
  for(const item of prioritised){
    if(!pqHas(item.toteId)){
      const o=pqInsert(item.toteId,item.priority,item.source||"Grafana",{pid:item.pid,barcodeCount:item.barcodeCount});
      if(o==="inserted"){inserted++;insertedTotes.push(item.toteId);}
    }else{
      if(pqUpdatePriority(item.toteId,item.priority,item.source||"Grafana",{pid:item.pid,barcodeCount:item.barcodeCount}))reprioritized++;
      kept++;
    }
  }

  grafanaSt.status="idle";broadcastGrafanaStatus();
  writeLog("info",`↻ Grafana sync complete — +${inserted} added, ~${reprioritized} re-prioritised, -${cleared} cleared, ${kept} kept. Queue: ${pqSize()}`);
  // Record tote lock/unlock (LOCKED/CLEARED) events to the sheet for tote-flow history
  if(config.sheetUrl&&(insertedTotes.length>0||clearedTotes.length>0)){
    const events=[
      ...insertedTotes.map(id=>({toteId:id,event:"LOCKED",timestamp:Date.now()})),
      ...clearedTotes.map(id=>({toteId:id,event:"CLEARED",timestamp:Date.now()}))
    ];
    sendToSheet(config.sheetUrl,"appendToteEvents",events).catch(()=>{});
  }
  broadcastFetch("running");
  broadcastAuto(); // update queue display in Auto tab
  await _resumeIfWaiting();
  return{ok:true,locked:lockedTotes.length,supervisor:supervisorTotes.length,inserted,cleared,kept,total:pqSize(),sdCount:sheetCounts.sdCount,p0Count:sheetCounts.p0Count,p1Count:sheetCounts.p1Count,p2Count:sheetCounts.p2Count};
}
// Wake a session that's idling with an empty queue (status "waiting") the moment
// a fetch cycle brings in new totes — this is what makes Bug-A's fix actually
// resume automatically instead of just avoiding the stop.
async function _resumeIfWaiting(){if(A.running&&!A.paused&&A.status==="waiting"&&A.currentBatch.length===0&&!pqEmpty()){aLog("info","▶ New totes arrived — resuming auto session.");await runBatch();}}

function broadcastGrafanaStatus(){
  // Persist fetch timestamps so they survive SW restarts
  chrome.storage.local.set({qtp_grafana_st:{
    lastLockedFetch:grafanaSt.lastLockedFetch,
    lastSuperFetch:grafanaSt.lastSuperFetch,
    lockedCount:grafanaSt.lockedCount,
    superCount:grafanaSt.superCount,
    breakdown:grafanaSt.breakdown
  }}).catch(()=>{}); chrome.runtime.sendMessage({type:"GRAFANA_STATUS",status:{...grafanaSt}}).catch(()=>{}); }

// ── Cycle Count Reconciliation (Discrepancy Marked + GTP Stock Check) ──────────
// Reuses buildGrafanaBody/callGrafanaDS/trFrameRows above — same datasource, same
// direct-fetch-then-tab-fallback auth path already proven by the Locked/Supervisor fetches.
const CC_DS_UID="rerQ11pVk", CC_DS_TYPE="mssql", CC_DS_ID=1;

const SQL_CC_DISCREPANCY=`use lenskart_gtp
SELECT * from verification_events ve where $__timeFilter((ve.create_time AT TIME ZONE 'India Standard Time'))`;

const SQL_CC_STOCKCHECK=`USE lenskart_gtp 

SELECT 
    scm.sku,
    scm.storer,
    scm.quantity,
    scm.type,
    sch.station,
    sch.[user],
    sch.container,
    CONVERT(VARCHAR(23), sch.create_time, 121) AS create_time
FROM 
    stock_check_material_history scm
RIGHT JOIN 
    stock_check_tote_history sch
    ON scm.reference = sch.id
WHERE 
    sch.create_time >= CAST(DATEADD(HOUR, 5, DATEADD(MINUTE, 30, $__timeFrom())) AS datetime)
    AND sch.create_time < CAST(DATEADD(HOUR, 5, DATEADD(MINUTE, 30, $__timeTo())) AS datetime)
ORDER BY sch.create_time DESC;`;

async function fetchCCDiscrepancy(host, fromMs, toMs){
  const body = buildGrafanaBody(CC_DS_UID, CC_DS_TYPE, CC_DS_ID, SQL_CC_DISCREPANCY, fromMs, toMs);
  const data = await callGrafanaDS(host, body);
  return trFrameRows(data).map(r => ({
    station: r.station, operationType: r.operation_type, user: r.user,
    container: r.container, eventType: r.type, discrepancyType: r.discrepancy_type,
    createTime: r.create_time,
  }));
}

async function fetchCCStockCheck(host, fromMs, toMs){
  const body = buildGrafanaBody(CC_DS_UID, CC_DS_TYPE, CC_DS_ID, SQL_CC_STOCKCHECK, fromMs, toMs);
  const data = await callGrafanaDS(host, body);
  return trFrameRows(data).map(r => ({
    sku: r.sku, storer: r.storer, quantity: r.quantity, resultType: r.type,
    station: r.station, user: r.user, container: r.container, createTime: r.create_time,
  }));
}

// ── ASRS Daily Report ────────────────────────────────────────────────────
// Shift windows (IST): A 06:00–14:00, B 14:00–22:00, C 22:00(dateStr)–06:00(dateStr+1).
// Both SQL_CC_STOCKCHECK (manual +5:30 DATEADD) and SQL_CC_DISCREPANCY (AT TIME
// ZONE) need the identical fromMs/toMs — verified numerically: passing the UTC
// instant equivalent to the desired IST wall-clock time makes both mechanisms
// land on exactly that IST boundary when comparing against their naive-IST
// create_time columns.
function istToParamMs(y,mo,d,h,mi){ return Date.UTC(y,mo-1,d,h,mi,0)-5.5*3600000; }
function shiftWindowsForDate(dateStr){
  const [y,mo,d]=dateStr.split("-").map(Number);
  const nextDay=new Date(Date.UTC(y,mo-1,d+1)); // JS normalizes day-overflow automatically
  const ny=nextDay.getUTCFullYear(),nmo=nextDay.getUTCMonth()+1,nd=nextDay.getUTCDate();
  return{
    A:{from:istToParamMs(y,mo,d,6,0), to:istToParamMs(y,mo,d,14,0)},
    B:{from:istToParamMs(y,mo,d,14,0),to:istToParamMs(y,mo,d,22,0)},
    C:{from:istToParamMs(y,mo,d,22,0),to:istToParamMs(ny,nmo,nd,6,0)},
  };
}
async function fetchCCForWindow(host,win){
  const[discRows,stockRows]=await Promise.all([fetchCCDiscrepancy(host,win.from,win.to),fetchCCStockCheck(host,win.from,win.to)]);
  return{discRows,stockRows};
}
// CC Done: deduped to distinct BASE totes (invBaseOf strips the -N partition
// suffix) — stockCheckRows come back per partition, sometimes per material
// line too, so counting raw rows would overcount the same physical tote.
// Discrepancies Marked / Stations Flagged: SHORT-type events only — ALRIGHT
// events aren't a discrepancy, they're a clean check.
function ccMetricsFor(discRows,stockRows){
  const shortDisc=discRows.filter(r=>r.discrepancyType==="SHORT");
  return{
    discrepancies:shortDisc.length,
    ccDone:new Set(stockRows.map(r=>invBaseOf(r.container))).size,
    ccStationsRan:new Set(stockRows.map(r=>r.station).filter(Boolean)).size,
    discrepancyStations:new Set(shortDisc.map(r=>r.station).filter(Boolean)).size,
  };
}

async function buildAsrsDailyReport(host,dateStr,caps){
  const windows=shiftWindowsForDate(dateStr);
  const[wA,wB,wC]=await Promise.all([fetchCCForWindow(host,windows.A),fetchCCForWindow(host,windows.B),fetchCCForWindow(host,windows.C)]);
  const mA=ccMetricsFor(wA.discRows,wA.stockRows),mB=ccMetricsFor(wB.discRows,wB.stockRows),mC=ccMetricsFor(wC.discRows,wC.stockRows);
  const combine=key=>({A:mA[key],B:mB[key],C:mC[key],Total:mA[key]+mB[key]+mC[key]});

  // Compaction / Tote Freed: NO data source found anywhere in this codebase
  // (verified via a full-repo search before writing this function) — zeros
  // with a flag rather than a fabricated query. Needs the real SQL/table
  // pointed out before these can be real numbers.
  const zeroShift=()=>({A:0,B:0,C:0,Total:0});

  // Tote Utilisation live fallback: reuses the EXACT same fetchAsrsDump +
  // computeToteUtilisation path the TOTE_UTILISATION handler itself uses
  // (sheet_dump source, matching that handler's own default), so this can
  // never disagree with the Tote Utilisation tab's own computation.
  let toteUtil=null,toteUtilError=null;
  try{
    const cfg=await getConfig();
    const dump=await fetchAsrsDump(cfg.sheetUrl);
    if(dump.ok)toteUtil=computeToteUtilisation(dump.rows,caps||{});
    else toteUtilError=dump.reason||"Sheet dump unavailable";
  }catch(e){ toteUtilError=e.message||String(e); }

  return{
    ok:true,dateStr,
    shifts:{
      compaction:zeroShift(),toteFreed:zeroShift(), // TODO: no known data source — see note above
      ccDone:combine("ccDone"),discrepancies:combine("discrepancies"),
      ccStationsRan:combine("ccStationsRan"),discrepancyStations:combine("discrepancyStations"),
    },
    live:{
      generatedAt:Date.now(),
      toteUtil,toteUtilError,
      // Aisle Occupancy: NO data source found anywhere in this codebase — see
      // note above. Empty/zero rather than fabricated.
      aisleOccupancy:["001","002","003","004","005","006"].map(a=>({aisle:a,value:0})),
      aisleOccupancyAvg:0,aisleLS:{},aisleLSAvg:{large:0,short:0},
    },
  };
}





async function sendToSheet(sheetUrl,action,data){
  const resp=await fetch(sheetUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,data})});
  return resp.json();
}


async function startGrafanaAlarms(cfg){
  const config=cfg;
  await chrome.alarms.clear(ALARM.GRAFANA_LOCKED);
  await chrome.alarms.clear(ALARM.GRAFANA_SUPER);
  const lm=Math.max(1,cfg.grafanaLockedInterval||30);
  await chrome.alarms.create(ALARM.GRAFANA_LOCKED,{delayInMinutes:lm,periodInMinutes:lm});
  if(cfg.grafanaSuperEnabled){
    const sm=Math.max(1,cfg.grafanaSuperInterval||60);
    await chrome.alarms.create(ALARM.GRAFANA_SUPER,{delayInMinutes:sm,periodInMinutes:sm});
  }
}
async function stopGrafanaAlarms(){ await chrome.alarms.clear(ALARM.GRAFANA_LOCKED);await chrome.alarms.clear(ALARM.GRAFANA_SUPER); }

// ── Quadron API Caller ─────────────────────────────────────────────────────────
async function getJWT(host){ const names=["Authorization","authorization","token","access_token","jwt","auth_token","id_token","JWT"];const skipCookies=["grafana_session","grafana_session_expiry"];try{const all=await chrome.cookies.getAll({url:host+"/concinity/"});for(const c of all)if(names.includes(c.name)&&!skipCookies.includes(c.name)&&looksLikeJWT(c.value))return stripBearer(c.value);for(const c of all)if(!skipCookies.includes(c.name)&&looksLikeJWT(c.value))return stripBearer(c.value);}catch(e){}try{const u=new URL(host);const tabs=await chrome.tabs.query({url:`${u.protocol}//${u.host}/concinity/*`});for(const tab of tabs){// Skip Grafana tabs — they contain Grafana auth tokens not Quadron JWTs
    if(tab.url&&tab.url.includes("/grafana"))continue;
    const res=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{const keys=["Authorization","authorization","token","access_token","jwt","auth_token","id_token","JWT"];const scan=s=>{for(const k of keys){const v=s.getItem(k);if(v)return v;}for(let i=0;i<s.length;i++){const v=s.getItem(s.key(i));if(v&&/^(Bearer\s+)?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.trim()))return v;}return null;};return scan(localStorage)||scan(sessionStorage);}});for(const r of res||[])if(r.result&&looksLikeJWT(r.result))return stripBearer(r.result);}}catch(e){}return null; }
async function checkAuth(host){ const jwt=await getJWT(host);if(!jwt)return{ok:false,reason:"no token"};if(isJWTExpired(jwt))return{ok:false,reason:"expired"};return{ok:true,sub:getSubFromJWT(jwt)}; }
function classifyResult(result){ if(!result)return{condition:CONDITION.RETRY,rawMsg:"No response"};const raw=(result.data&&(result.data.message||result.data.error))||"";const lo=raw.toLowerCase();const rawMsg=raw||`HTTP ${result.status}`;if(result.ok&&result.data&&result.data.success)return{condition:CONDITION.INSERTED,rawMsg};if(lo.includes("already in the queue")||lo.includes("already in queue")||lo.includes("in movement")||lo.includes("is in movement"))return{condition:CONDITION.ALREADY_QUEUED,rawMsg};if(lo.includes("released from quadron")||lo.includes("released"))return{condition:CONDITION.RELEASED,rawMsg};if(lo.includes("not available")||lo.includes("not found")||lo.includes("does not exist")||lo.includes("no data")||result.status===404||!result.data||lo==="")return{condition:CONDITION.NOT_AVAILABLE,rawMsg};return{condition:CONDITION.RETRY,rawMsg}; }
async function callTote(host,instanceCode,toteId,zone){ const jwt=await getJWT(host);if(!jwt)return{condition:CONDITION.RETRY,rawMsg:"No JWT — ensure you are logged in",via:null};const url=`${host}/quadron/dashboard/pull-crate`;const headers={"Accept":"application/json, text/plain, */*","Authorization":`Bearer ${jwt}`,"Content-Type":"application/json","Cache-Control":"no-cache, no-store, must-revalidate, pre-check=0","Pragma":"no-cache","Expires":"0","X-User-Info-Name":getSubFromJWT(jwt)||"","idempotency-key":"key-"+Date.now(),"instanceCode":instanceCode};const body=JSON.stringify({container:toteId,station:String(zone)});try{const resp=await fetch(url,{method:"POST",headers,body,credentials:"include"});let data=null;try{data=await resp.json();}catch(e){}return{...classifyResult({status:resp.status,ok:resp.ok,data}),via:"sw"};}catch(err){try{const _t=await fetchViaTab(host,url,headers,body);return{...classifyResult({status:_t.status,ok:_t.ok,data:_t.data}),via:"tab"};}catch(te){return{condition:CONDITION.RETRY,rawMsg:(err.message||String(err))+" | tab: "+(te.message||String(te)),via:"tab_failed"};}} }
async function fetchViaTab(host,url,headers,body){ const u=new URL(host);const tabs=await chrome.tabs.query({url:`${u.protocol}//${u.host}/concinity/*`});if(!tabs||!tabs.length)throw new Error(`No Concinity tab open. Open https://${u.host}/concinity/ and log in.`);const res=await chrome.scripting.executeScript({target:{tabId:tabs[0].id},world:"MAIN",args:[url,headers,body],func:async(url,headers,body)=>{try{const r=await fetch(url,{method:"POST",headers,body,credentials:"include"});let data=null;try{data=await r.json();}catch(e){}return{ok:r.ok,status:r.status,data};}catch(e){return{ok:false,status:0,error:e.message||String(e)};}}});const r=res&&res[0]&&res[0].result;if(!r)throw new Error("Tab relay returned no result.");if(r.error)throw new Error(r.error);return r; }

// ── Quadron Inventory (dashboard data) ─────────────────────────────────────────
// Reuses the same JWT/auth path as the tote caller. The dashboard endpoint returns
// every tote partition for the facility; we fetch once and aggregate client-side,
// summing quantity across all partitions (and all material lines) per base tote.
// invBaseOf — strips partition suffix (e.g. TL0000003490-1 → TL0000003490)
function invBaseOf(id){ return String(id||"").trim().toUpperCase().replace(/-\d+\s*$/,""); }

// ── Quadron Inventory API ──────────────────────────────────────────────────────
// Used for live ASRS source mode — fetches full inventory from Concinity,
// then buildPIDMapFromInventory extracts SKU→tote groupings for priority assignment.
async function fetchInventoryDashboard(host,instanceCode){
  const jwt=await getJWT(host);
  if(!jwt) return {ok:false,reason:"No JWT — open and log into the Concinity app"};
  const url=`${host}/wes/inventory/dashboard/data`;
  const headers={"Accept":"application/json, text/plain, */*","Authorization":`Bearer ${jwt}`,"Content-Type":"application/json","Cache-Control":"no-cache, no-store, must-revalidate, pre-check=0","Pragma":"no-cache","Expires":"0","X-User-Info-Name":getSubFromJWT(jwt)||"","idempotency-key":"key-"+Date.now(),"instanceCode":instanceCode||DEFAULTS.INSTANCE_CODE};
  try{
    const resp=await fetch(url,{method:"GET",headers,credentials:"include"});
    if(resp.status===401||resp.status===403) throw new Error("auth HTTP "+resp.status);
    if(!resp.ok) throw new Error("HTTP "+resp.status);
    const data=await resp.json();
    return {ok:true,data,via:"sw"};
  }catch(err){
    try{ const r=await fetchInventoryViaTab(host,url,headers); return {ok:true,data:r,via:"tab"}; }
    catch(te){ return {ok:false,reason:(err.message||String(err))+" | tab: "+(te.message||String(te))}; }
  }
}
async function fetchInventoryViaTab(host,url,headers){
  const u=new URL(host); const tabs=await chrome.tabs.query({url:`${u.protocol}//${u.host}/concinity/*`});
  if(!tabs||!tabs.length) throw new Error(`No Concinity tab open. Open https://${u.host}/concinity/ and log in.`);
  const res=await chrome.scripting.executeScript({target:{tabId:tabs[0].id},world:"MAIN",args:[url,headers],func:async(url,headers)=>{
    try{const r=await fetch(url,{method:"GET",headers,credentials:"include"});if(!r.ok)return{__err:"HTTP "+r.status};return await r.json();}catch(e){return{__err:e.message||String(e)};}
  }});
  const r=res&&res[0]&&res[0].result;
  if(!r) throw new Error("Tab relay returned no result.");
  if(r&&r.__err) throw new Error(r.__err);
  return r;
}

// buildPIDMapFromInventory — client-side equivalent of GAS processWithTotes.
// Groups all ASRS totes by SKU (using materialDetails[].sku), then assigns
// SD/P0/P1/P2 priority to each locked tote based on how many totes share its
// worst-case SKU (fewest totes = most critical = highest priority).
function buildPIDMapFromInventory(data,lockedTotes,supervisorTotes,p0Max,p1Max){
  p0Max=p0Max||1; p1Max=p1Max||3;

  // Build supervisor set (base IDs)
  const supSet={};
  supervisorTotes.forEach(t=>{ supSet[invBaseOf(String(t))]=true; });

  // Build locked base-ID list (deduped, valid only)
  const lockedBases=[]; const seenLocked={};
  lockedTotes.forEach(rawId=>{
    const base=invBaseOf(String(rawId));
    if(isValidToteId(base)&&!seenLocked[base]){seenLocked[base]=true;lockedBases.push(base);}
  });

  // skuMap:  sku  → { totes:{baseToteId:true}, totalQty:N }
  // toteMap: base → { sku:true, ... }  (only for locked totes)
  const skuMap={}, toteMap={};

  if(Array.isArray(data)){
    for(const entry of data){
      const tid=entry&&entry.toteId; if(!tid) continue;
      const base=invBaseOf(tid);
      for(const md of (entry.materialDetails||[])){
        const sku=String(md.sku||"").trim(); if(!sku) continue;
        const qty=Number(md.quantity)||0;
        if(!skuMap[sku]) skuMap[sku]={totes:{},totalQty:0};
        skuMap[sku].totes[base]=true;
        skuMap[sku].totalQty+=qty;
        if(seenLocked[base]){
          if(!toteMap[base]) toteMap[base]={};
          toteMap[base][sku]=true;
        }
      }
    }
  }

  const queue=[]; const counts={SD:0,P0:0,P1:0,P2:0};

  for(const base of lockedBases){
    // SD: supervisor locked totes (cross-referenced against locked dump upstream)
    if(supSet[base]){
      queue.push({toteId:base,priority:"SD",source:"Supervisor Dump",pid:null,barcodeCount:null});
      counts.SD++; continue;
    }
    const skuList=toteMap[base]?Object.keys(toteMap[base]):[];
    if(!skuList.length){
      // Not found in inventory → default P2
      queue.push({toteId:base,priority:"P2",source:"Locked Tote Dump",pid:null,barcodeCount:0});
      counts.P2++; continue;
    }
    // Find worst SKU: fewest totes across ASRS = most critical
    let worstCount=Infinity,worstSku="",totalQty=0;
    for(const sku of skuList){
      const intel=skuMap[sku];
      const tc=intel?Object.keys(intel.totes).length:0;
      totalQty+=intel?intel.totalQty:0;
      if(tc<worstCount){worstCount=tc;worstSku=sku;}
    }
    const priority=worstCount<=p0Max?"P0":worstCount<=p1Max?"P1":"P2";
    queue.push({toteId:base,priority,source:"Quadron API",pid:worstSku,barcodeCount:totalQty});
    counts[priority]++;
  }

  const ORDER={SD:0,P0:1,P1:2,P2:3};
  queue.sort((a,b)=>(ORDER[a.priority]||3)-(ORDER[b.priority]||3));
  return{queue,counts};
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE CLICK PURGE ENGINE
// Pipeline: ASRS dump (sheet) → candidate pre-filter → blocked inventory per PID
// (NexS API) → blocked/non-blocked classification + safety floor → Quadron live
// API validation → purge dump + mismatch report. Export-only; does not touch the
// Auto queue. PID == SKU throughout.
// ═══════════════════════════════════════════════════════════════════════════
const NEXS_BASE              = "https://app.nexs.lenskart.com"; // blocked-inventory host
const PURGE_TOTE_MIN         = 1;    // tote inventory window (inclusive)
const PURGE_TOTE_MAX         = 7;
const PURGE_MIN_PID_TOTES    = 3;    // PID must have at least this many totes in ASRS
const PURGE_BLOCKED_MIN_TOTAL= 100;  // blocked path only: total PID inventory must exceed this
const PURGE_SAFETY_FLOOR     = 5;    // exclude PID when (totalPidInventory - blocked) <= this
const PURGE_BLOCKED_CONCURRENCY = 5; // parallel blocked-API calls

const purgeState = { running:false, last:null };

// Partition number from "PR1" | "_PR1" | "TL0000003490-1" | "1" → integer, or null.
// Only matches genuine partition tokens — NOT the trailing digits of a bare tote
// id like "TL0000003490" (which must return null, never 3490).
function purgePartitionNum(p){
  const s=String(p||"").trim();
  if(!s) return null;
  let m = s.match(/_PR(\d+)/i) || s.match(/(?:^|[^0-9])PR(\d+)/i) || s.match(/-(\d+)\s*$/) || s.match(/^(\d+)$/);
  return m ? parseInt(m[1],10) : null;
}
function emptyPurgeSummary(){ return {totalTotes:0,distinctTotes:0,candidateLines:0,largeTotes:0,smallTotes:0,totalInventory:0,blockedCount:0,nonBlockedCount:0,uniquePids:0,validatedCount:0,mismatchCount:0,blockedApiFails:0,apiSkippedLines:0,apiSkippedTotes:0,quadronAvailable:false}; }
function purgeRecommendation(s){
  return s==="MISSING_IN_QUADRON"?"Do not purge — verify physical presence"
       : s==="INVENTORY_MISMATCH"?"Recount before purge"
       : s==="PARTITION_MISMATCH"?"Verify partition mapping"
       : s==="EXCEEDS_PURGE_LIMIT"?"Exclude — Quadron qty exceeds purge limit"
       : "Review";
}
function purgeProgress(stage,done,total){ chrome.runtime.sendMessage({type:"PURGE_PROGRESS",stage,done,total}).catch(()=>{}); }

// Fetch raw ASRS dump rows from the Apps Script web app (getAsrsDump action)
async function fetchAsrsDump(sheetUrl){
  if(!sheetUrl) return {ok:false,reason:"No Apps Script URL set — configure it in the Auto tab first."};
  let resp;
  try{ resp=await fetch(`${sheetUrl}?action=getAsrsDump&ts=${Date.now()}`,{method:"GET",redirect:"follow",headers:{"Accept":"application/json"}}); }
  catch(e){ return {ok:false,reason:"ASRS dump fetch failed: "+(e.message||e)}; }
  if(!resp.ok) return {ok:false,reason:"ASRS dump HTTP "+resp.status};
  let d; try{ d=await resp.json(); }catch(e){ return {ok:false,reason:"ASRS dump returned invalid JSON"}; }
  if(!d.ok){
    let why=d.reason||d.error||"ASRS dump returned ok:false";
    if(/unknown action|unauthor/i.test(why)) why+=" — redeploy the Apps Script web app (Deploy → Manage deployments → Edit → New version) so the getAsrsDump action is live.";
    return {ok:false,reason:why};
  }
  return {ok:true,rows:d.rows||[]};
}

// Flatten the live Quadron inventory payload into the row shape that
// computeToteUtilisation consumes — one row per (tote-partition, SKU). SKU is
// the PID in this system (the purge index keys SKU == dump PID), so the same
// Frame/Lens rule applies. location is set to the clean base tote id so the
// strict TL/TS filter passes for real totes and rejects anything else.
function inventoryToUtilRows(data){
  const rows = [];
  if (!Array.isArray(data)) return rows;
  for (const entry of data){
    const tid = entry && entry.toteId; if (!tid) continue;
    const base = invBaseOf(tid);
    for (const md of (entry.materialDetails || [])){
      const sku = String(md.sku || "").trim(); if (!sku) continue;
      rows.push({ pid: sku, toteId: base, location: base, inventoryCount: Number(md.quantity) || 0 });
    }
  }
  return rows;
}

// ── Tote Utilisation ────────────────────────────────────────────────────────
// Client-side port of the GAS generateToteUtilisation(): reads the ASRS dump,
// derives tote type (TL=Large / TS=Small) and product type (PID<=999999=Frame,
// else Lens), flags mixed (Frame+Lens) totes, and computes per-category and
// per-tote utilisation against CONFIGURABLE capacities. Returns everything the
// UI needs to render the dashboard — no sheet writes.
function computeToteUtilisation(rows, caps){
  caps = caps || {};
  const CAP = {
    largeLens:  Number(caps.largeLens)  > 0 ? Number(caps.largeLens)  : 300,
    largeFrame: Number(caps.largeFrame) > 0 ? Number(caps.largeFrame) : 240,
    smallLens:  Number(caps.smallLens)  > 0 ? Number(caps.smallLens)  : 200,
    smallFrame: Number(caps.smallFrame) > 0 ? Number(caps.smallFrame) : 200
  };

  // STRICT tote-location rule: the whole location must be a TL/TS tote (optionally
  // with a _PRn partition suffix). This deliberately rejects decant stations,
  // buffers, fitting slots and any other location that merely *contains* a
  // tote-like substring — only real ASRS storage totes count toward utilisation.
  const STRICT_TOTE = /^(TL|TS)[0-9]{10}(?:_PR[0-9]+)?$/i;

  // Aggregate dump rows by base tote
  const toteMap = Object.create(null);   // toteId → { toteType, products:Set, quantity }
  const mixed   = new Set();
  let scanned = 0, excludedNonTote = 0;

  for (const r of rows) {
    scanned++;
    // Prefer the raw location for the strict check; fall back to toteId when an
    // older dump deployment doesn't return location (then decant can't be filtered).
    const rawLoc = (r.location != null && r.location !== "") ? String(r.location).trim().toUpperCase() : null;
    if (rawLoc != null) {
      if (!STRICT_TOTE.test(rawLoc)) { excludedNonTote++; continue; }   // decant / other → skip
    }

    const toteId = invBaseOf(r.toteId);
    if (!isValidToteId(toteId)) { excludedNonTote++; continue; }

    const qty   = Number(r.inventoryCount) || 0;
    const pidNum = parseInt(String(r.pid || "").trim(), 10);
    const productType = (!isNaN(pidNum) && pidNum <= 999999) ? "Frame" : "Lens";
    const toteType = toteId.startsWith("TL") ? "Large" : "Small";

    if (!toteMap[toteId]) {
      toteMap[toteId] = { toteId, toteType, products:new Set([productType]), quantity:0 };
    } else if (!toteMap[toteId].products.has(productType)) {
      toteMap[toteId].products.add(productType);
      mixed.add(toteId);
    }
    toteMap[toteId].quantity += qty;
  }

  const stats = {
    largeLens:  { totes:0, cap:0, qty:0, capPer:CAP.largeLens  },
    largeFrame: { totes:0, cap:0, qty:0, capPer:CAP.largeFrame },
    smallLens:  { totes:0, cap:0, qty:0, capPer:CAP.smallLens  },
    smallFrame: { totes:0, cap:0, qty:0, capPer:CAP.smallFrame }
  };
  const distribution = {1:0,2:0,3:0,4:0,5:0};
  const detail = [];   // per-tote rows (non-mixed)

  Object.values(toteMap).forEach(t => {
    if (mixed.has(t.toteId)) return;
    const productType = [...t.products][0] || "Lens";
    let key, capacity;
    if (t.toteType === "Large" && productType === "Lens")  { key="largeLens";  capacity=CAP.largeLens;  }
    else if (t.toteType === "Large")                       { key="largeFrame"; capacity=CAP.largeFrame; }
    else if (productType === "Lens")                       { key="smallLens";  capacity=CAP.smallLens;  }
    else                                                   { key="smallFrame"; capacity=CAP.smallFrame; }

    const utilisation = capacity > 0 ? t.quantity / capacity : 0;
    stats[key].totes++; stats[key].cap += capacity; stats[key].qty += t.quantity;
    if (t.quantity >= 1 && t.quantity <= 5) distribution[t.quantity]++;

    detail.push({ toteId:t.toteId, toteType:t.toteType, productType, quantity:t.quantity, capacity, utilisation });
  });

  const sum = (a,b)=>a+b;
  const cats = ["largeLens","largeFrame","smallLens","smallFrame"];
  const totals = {
    totes: cats.map(k=>stats[k].totes).reduce(sum,0),
    cap:   cats.map(k=>stats[k].cap).reduce(sum,0),
    qty:   cats.map(k=>stats[k].qty).reduce(sum,0)
  };
  totals.util = totals.cap > 0 ? totals.qty / totals.cap : 0;
  const distTotal = [1,2,3,4,5].map(k=>distribution[k]).reduce(sum,0);

  cats.forEach(k => { stats[k].util = stats[k].cap > 0 ? stats[k].qty / stats[k].cap : 0; });

  return {
    stats, totals, distribution, distTotal,
    mixed: [...mixed],
    mixedCount: mixed.size,
    detail,
    caps: CAP,
    pipeline: { scanned, excludedNonTote, mixed: mixed.size, counted: totals.totes },
    generatedAt: new Date().toISOString()
  };
}

// Blocked-inventory API for one PID — SW fetch (cookies) with logged-in-tab fallback
async function fetchBlockedInv(pid,facilityCode){
  const url=`${NEXS_BASE}/nexs/cid/api/v1/warehouseInventory/getConsolidatedInvInfo/${encodeURIComponent(pid)}`;
  const headers={"accept":"application/json, text/plain, */*","facility-code":facilityCode||"NXS1"};
  try{
    const r=await fetch(url,{method:"GET",headers,credentials:"include"});
    if(r.ok){ const j=await r.json(); return {ok:true,data:(j&&j.data)||{},via:"sw"}; }
  }catch(e){}
  try{
    const tabs=await chrome.tabs.query({url:`${NEXS_BASE}/*`});
    if(tabs&&tabs.length){
      const res=await chrome.scripting.executeScript({target:{tabId:tabs[0].id},world:"MAIN",args:[url,headers],func:async(url,headers)=>{
        try{const r=await fetch(url,{method:"GET",headers,credentials:"include"});if(!r.ok)return{__err:"HTTP "+r.status};return await r.json();}catch(e){return{__err:e.message||String(e)};}
      }});
      const j=res&&res[0]&&res[0].result;
      if(j&&!j.__err) return {ok:true,data:(j&&j.data)||{},via:"tab"};
      return {ok:false,reason:(j&&j.__err)||"tab relay returned nothing"};
    }
  }catch(e){ return {ok:false,reason:e.message||String(e)}; }
  return {ok:false,reason:`NexS unreachable — open & log into ${NEXS_BASE}`};
}

// Per-tote Quadron index from the inventory dashboard payload (for validation)
function buildQuadronIndex(data){
  const idx=Object.create(null); // base → {totalQty,partitions:Set,skuQty:{},skuPartition:{}}
  if(Array.isArray(data)){
    for(const entry of data){
      const tid=entry&&entry.toteId; if(!tid) continue;
      const base=invBaseOf(tid); const pnum=purgePartitionNum(tid);
      if(!idx[base]) idx[base]={totalQty:0,partitions:new Set(),skuQty:Object.create(null),skuPartition:Object.create(null)};
      if(pnum!=null) idx[base].partitions.add(pnum);
      for(const md of (entry.materialDetails||[])){
        const sku=String(md.sku||"").trim(); if(!sku) continue;
        const qty=Number(md.quantity)||0;
        idx[base].totalQty+=qty;
        idx[base].skuQty[sku]=(idx[base].skuQty[sku]||0)+qty;
        if(pnum!=null && idx[base].skuPartition[sku]==null) idx[base].skuPartition[sku]=pnum;
      }
    }
  }
  return idx;
}

// Validate a candidate tote against Quadron → {status, quadronQty, quadronPartition}
function purgeValidate(c,qidx,toteBarcodeMax){
  const limit=(toteBarcodeMax!=null && !isNaN(Number(toteBarcodeMax)))?Number(toteBarcodeMax):PURGE_TOTE_MAX;
  const q=qidx[c.toteId];
  if(!q) return {status:"MISSING_IN_QUADRON",quadronQty:null,quadronPartition:null};
  const qQty=q.skuQty[c.pid];
  if(qQty==null) return {status:"MISSING_IN_QUADRON",quadronQty:0,quadronPartition:null}; // tote present, SKU absent
  const qPart=(q.skuPartition[c.pid]!=null)?q.skuPartition[c.pid]:null;
  if(qQty>limit)                return {status:"EXCEEDS_PURGE_LIMIT",quadronQty:qQty,quadronPartition:qPart};
  if(qQty!==c.inventoryCount)    return {status:"INVENTORY_MISMATCH",quadronQty:qQty,quadronPartition:qPart};
  const cPart=purgePartitionNum(c.partition);
  if(qPart!=null && cPart!=null && qPart!==cPart) return {status:"PARTITION_MISMATCH",quadronQty:qQty,quadronPartition:qPart};
  return {status:"VALIDATED",quadronQty:qQty,quadronPartition:qPart};
}

async function runPurgeGenerate(opts){
  opts=opts||{};
  const sheetUrl=opts.sheetUrl, host=opts.host||DEFAULTS.HOST, instanceCode=opts.instanceCode||DEFAULTS.INSTANCE_CODE, facilityCode=opts.facilityCode||"NXS1";

  // 1 ── ASRS dump
  writeLog("info","⛏ Purge: reading ASRS dump…");
  const dump=await fetchAsrsDump(sheetUrl);
  if(!dump.ok) return {ok:false,reason:dump.reason};
  const rows=dump.rows;
  if(!rows.length) return {ok:false,reason:"ASRS dump returned 0 rows."};

  // 2 ── Aggregate per PID and per tote
  const pidAgg=Object.create(null), toteAgg=Object.create(null);
  for(const r of rows){
    const pid=String(r.pid||"").trim(); const tote=invBaseOf(r.toteId); const inv=Number(r.inventoryCount)||0;
    if(!pid||!isValidToteId(tote)) continue;
    if(!pidAgg[pid]) pidAgg[pid]={totes:new Set(),totalInventory:0};
    pidAgg[pid].totes.add(tote); pidAgg[pid].totalInventory+=inv;
    if(!toteAgg[tote]) toteAgg[tote]={rows:[],pids:new Set()};
    toteAgg[tote].rows.push({pid,partition:r.partition,inv}); toteAgg[tote].pids.add(pid);
  }

  // 3 ── Pre-filter on user-configurable ASRS criteria. Defaults preserve the
  //      original hardcoded behaviour; opts.filters lets the operator override.
  const numOr = (v, d) => (v === undefined || v === null || v === "" || isNaN(Number(v))) ? d : Number(v);
  const F = {
    toteBarcodeMax: numOr(opts.filters && opts.filters.toteBarcodeMax, PURGE_TOTE_MAX),          // tote total barcodes ≤ this
    partitionMax:   numOr(opts.filters && opts.filters.partitionMax,   1),                        // active partitions ≤ this
    pidInvMin:      numOr(opts.filters && opts.filters.pidInvMin,      PURGE_BLOCKED_MIN_TOTAL),  // PID total inv > this
    pidToteMin:     numOr(opts.filters && opts.filters.pidToteMin,     PURGE_MIN_PID_TOTES),      // PID in ≥ this many totes
    blockedMode:    ((opts.filters && opts.filters.blockedMode) || "both")                        // blocked | non_blocked | both
  };
  const pre=[];
  for(const tote in toteAgg){
    const t=toteAgg[tote];
    // Active partitions = distinct PIDs in the tote. The ASRS dump's partition
    // field is often blank, so counting it directly collapses every line to one
    // key and lets multi-partition totes slip through. Each PID occupies its own
    // partition (confirmed by Quadron's per-PID PR), so distinct-PID count is the
    // reliable measure. Collapsing by PID here also guarantees a tote can never
    // appear twice for the same PID.
    const byPid = Object.create(null);
    for(const row of t.rows){
      if(!byPid[row.pid]) byPid[row.pid]={pid:row.pid,partition:row.partition||"",inv:0};
      byPid[row.pid].inv += row.inv;
      if(!byPid[row.pid].partition && row.partition) byPid[row.pid].partition=row.partition;
    }
    const pidLines = Object.values(byPid);
    if(pidLines.length > F.partitionMax) continue;                          // Tote Partition: active partitions (distinct PIDs) ≤ N
    // Total Tote Barcode is the tote's combined barcode count across all its
    // PIDs/partitions — not a single PID-line. (At 1 partition these are equal.)
    const toteBarcodes = pidLines.reduce((s,l)=>s+l.inv,0);
    if(toteBarcodes < PURGE_TOTE_MIN || toteBarcodes > F.toteBarcodeMax) continue;  // Total Tote Barcode: 1..N (tote-level)
    for(const line of pidLines){
      const agg = pidAgg[line.pid];
      const pidTotes = agg ? agg.totes.size : 0;
      if(pidTotes < F.pidToteMin) continue;                                 // Total PID Tote: ≥ N
      if(!agg) continue;
      pre.push({toteId:tote,toteType:(tote.startsWith("TL")?"Large":"Small"),pid:line.pid,partition:line.partition,inventoryCount:line.inv,toteBarcodes,totalPidInventory:agg.totalInventory,totalPidTotes:pidTotes});
    }
  }
  writeLog("info",`⛏ Purge: ${pre.length} pre-candidates (barcode≤${F.toteBarcodeMax}, partitions≤${F.partitionMax}, PIDtotes≥${F.pidToteMin}; PIDinv>${F.pidInvMin} applies to blocked only; blocked=${F.blockedMode}) from ${rows.length} rows / ${Object.keys(toteAgg).length} totes.`);
  if(!pre.length) return {ok:true,summary:emptyPurgeSummary(),candidates:[],mismatches:[],pidBreakdown:[]};

  // 4 ── Blocked inventory per unique candidate PID
  const uniquePids=[...new Set(pre.map(c=>c.pid))];
  writeLog("info",`⛏ Purge: querying blocked inventory for ${uniquePids.length} PIDs…`);
  const blockedMap=Object.create(null);
  let done=0;
  for(let i=0;i<uniquePids.length;i+=PURGE_BLOCKED_CONCURRENCY){
    const batch=uniquePids.slice(i,i+PURGE_BLOCKED_CONCURRENCY);
    await Promise.all(batch.map(async pid=>{
      const r=await fetchBlockedInv(pid,facilityCode);
      blockedMap[pid]=r.ok?{ok:true,blocked:Number(r.data.blockedInventory)||0,total:Number(r.data.totalInventory)||0,available:Number(r.data.availableInventory)||0}:{ok:false,reason:r.reason};
    }));
    done+=batch.length; purgeProgress("blocked",done,uniquePids.length);
  }
  const apiFails=uniquePids.filter(p=>!blockedMap[p].ok);
  if(apiFails.length) writeLog("warn",`⛏ Purge: blocked API failed for ${apiFails.length}/${uniquePids.length} PIDs — those candidates skipped.`);

  // 5 ── Classify by blocked status + apply the Blocked-mode selector + thresholds
  const kept=[]; const apiSkipped=[];
  for(const c of pre){
    const b=blockedMap[c.pid];
    if(!b||!b.ok){ apiSkipped.push({toteId:c.toteId,pid:c.pid,toteType:c.toteType,inventoryCount:c.inventoryCount,reason:(b&&b.reason)||"blocked API failed"}); continue; }
    c.blockedInventory=b.blocked;
    // Final-validation figure for every candidate: how much of the PID remains
    // outside the blocked pool. For non-blocked (blocked=0) this equals PID total.
    c.availableInventory = c.totalPidInventory - b.blocked;
    const isBlocked = b.blocked > 0;
    if(F.blockedMode==="blocked" && !isBlocked) continue;        // keep only blocked
    if(F.blockedMode==="non_blocked" && isBlocked) continue;     // keep only non-blocked (0)
    if(isBlocked){
      if(c.totalPidInventory <= F.pidInvMin) continue;           // Total PID Inv > N — BLOCKED path only
      if(c.availableInventory <= PURGE_SAFETY_FLOOR) continue;   // safety net: don't purge near-depleted PIDs
      c.purgeType="BLOCKED";
    } else {
      c.purgeType="NON_BLOCKED";                                 // no PID-inv floor for non-blocked
    }
    kept.push(c);
  }
  const apiSkippedTotes=new Set(apiSkipped.map(s=>s.toteId)).size;
  writeLog("info",`⛏ Purge: ${kept.length} candidates after blocked rules + safety floor.`+(apiSkipped.length?` ${apiSkipped.length} line(s) / ${apiSkippedTotes} tote(s) could not be evaluated (blocked API).`:""));

  // 6 ── Quadron validation
  writeLog("info","⛏ Purge: fetching Quadron live inventory for validation…");
  const inv=await fetchInventoryDashboard(host,instanceCode);
  const quadronOk=inv.ok; const qidx=inv.ok?buildQuadronIndex(inv.data):null;
  if(!inv.ok) writeLog("warn","⛏ Purge: Quadron API unavailable — validation flagged unavailable. "+(inv.reason||""));

  const mismatches=[];
  for(const c of kept){
    if(!quadronOk){ c.quadronValidated=false; c.validationStatus="VALIDATION_UNAVAILABLE"; c.quadronQty=null; c.quadronPartition=null; c.notes=["Quadron API unavailable"]; continue; }
    const v=purgeValidate(c,qidx,F.toteBarcodeMax);
    c.validationStatus=v.status; c.quadronQty=v.quadronQty; c.quadronPartition=v.quadronPartition;
    c.quadronValidated=(v.status==="VALIDATED"); c.notes=[];
    // ASRS dump often leaves partition blank; backfill from Quadron (authoritative) for display
    if((!c.partition || c.partition==="") && c.quadronPartition!=null) c.partition="PR"+c.quadronPartition;
    if(v.status!=="VALIDATED"){
      mismatches.push({toteId:c.toteId,pid:c.pid,issueType:v.status,
        asrsValue:`qty ${c.inventoryCount} / ${c.partition||"—"}`,
        quadronValue:(v.quadronQty==null)?"—":`qty ${v.quadronQty} / ${v.quadronPartition==null?"—":("PR"+v.quadronPartition)}`,
        recommendedAction:purgeRecommendation(v.status)});
    }
  }
  writeLog("info",`⛏ Purge: validation complete — ${mismatches.length} mismatch(es) flagged.`);

  // 7 ── Summary + PID breakdown
  const distinctToteSet = new Set(kept.map(c=>c.toteId));
  const summary={
    totalTotes:kept.length,
    distinctTotes:distinctToteSet.size,
    candidateLines:kept.length,
    largeTotes:new Set(kept.filter(c=>c.toteType==="Large").map(c=>c.toteId)).size,
    smallTotes:new Set(kept.filter(c=>c.toteType==="Small").map(c=>c.toteId)).size,
    totalInventory:kept.reduce((s,c)=>s+c.inventoryCount,0),
    blockedCount:kept.filter(c=>c.purgeType==="BLOCKED").length,
    nonBlockedCount:kept.filter(c=>c.purgeType==="NON_BLOCKED").length,
    uniquePids:new Set(kept.map(c=>c.pid)).size,
    validatedCount:kept.filter(c=>c.quadronValidated).length,
    mismatchCount:mismatches.length,
    blockedApiFails:apiFails.length,
    apiSkippedLines:apiSkipped.length,
    apiSkippedTotes:apiSkippedTotes,
    quadronAvailable:quadronOk
  };
  const byPid=Object.create(null);
  for(const c of kept){
    if(!byPid[c.pid]) byPid[c.pid]={pid:c.pid,totesSelected:0,inventorySelected:0,blockedInventory:c.blockedInventory||0,totalPidInventory:c.totalPidInventory,availableInventory:(c.availableInventory!=null?c.availableInventory:(c.totalPidInventory-(c.blockedInventory||0)))};
    byPid[c.pid].totesSelected++; byPid[c.pid].inventorySelected+=c.inventoryCount;
  }
  const pidBreakdown=Object.values(byPid).sort((a,b)=>b.totesSelected-a.totesSelected);

  purgeState.last={summary,candidates:kept,mismatches,pidBreakdown,apiSkipped,filters:F,generatedAt:Date.now()};
  return {ok:true,summary,candidates:kept,mismatches,pidBreakdown,apiSkipped,filters:F};
}

// ── Fetcher (Sheet-based) ──────────────────────────────────────────────────────
const fetcherSt={lastFetchTime:null,lastFetchResult:null,fetchErrors:0,wbBuffer:[],wbTimer:null};
async function startFetchAlarm(mins){ const m=Math.max(1,mins||2);await chrome.alarms.clear(ALARM.FETCH);await chrome.alarms.create(ALARM.FETCH,{delayInMinutes:m,periodInMinutes:m}); }
async function stopFetchAlarm(){ await chrome.alarms.clear(ALARM.FETCH); }
async function onFetchAlarm(){ const cfg=await getConfig();if(!cfg.sheetUrl)return;const auto=await getAutoState_store();if(!auto.running)return;await runFetchCycle(cfg); }
async function runFetchCycle(cfg){ if(!cfg.sheetUrl)return{ok:false,reason:"No Apps Script URL"};let raw;try{raw=await fetchFromSheet(cfg.sheetUrl);}catch(err){fetcherSt.fetchErrors++;broadcastFetch("error");return{ok:false,reason:err.message};}fetcherSt.fetchErrors=0;if(raw.killed){writeLog("warn","Kill switch ON — queue serving halted");broadcastFetch("killed");return{ok:true,killed:true,inserted:0};}const hist=await getCallHistory();const coolMs=minutesToMs(cfg.cooldownMinutes||0);let inserted=0,duplicates=0;const allTotes=[...(raw.priorityTotes||[]),...(raw.toteQueue||[])];for(const item of allTotes){const toteId=String(item.toteId||"").trim().toUpperCase();const pri=item.priority||PRIORITY.P2;if(!isValidToteId(toteId))continue;if(pqHas(toteId)){duplicates++;continue;}if(coolMs>0&&isInCooldown(toteId,hist,coolMs))continue;const outcome=pqInsert(toteId,pri,item.source||"Sheet",{pid:item.pid||null});if(outcome==="inserted")inserted++;else if(outcome==="full")break;}fetcherSt.lastFetchTime=Date.now();fetcherSt.lastFetchResult={inserted,duplicates};broadcastFetch("running");await _resumeIfWaiting();return{ok:true,inserted,duplicates}; }
async function fetchFromSheet(url){ const resp=await fetch(`${url}?action=getQueue&ts=${Date.now()}`,{method:"GET",redirect:"follow",headers:{"Accept":"application/json"}});if(!resp.ok)throw new Error(`Apps Script HTTP ${resp.status}`);let data;try{data=await resp.json();}catch(e){throw new Error("Apps Script returned invalid JSON");}if(!data.ok)throw new Error(data.error||"Apps Script returned ok:false");return data; }
async function triggerProcessQueue(url){ if(!url)return{ok:false,reason:"No URL"};try{const r=await fetch(`${url}?action=processQueue&ts=${Date.now()}`,{method:"GET",redirect:"follow",headers:{"Accept":"application/json"}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}catch(e){return{ok:false,reason:e.message||String(e)};} }
async function getSheetStatus(url){ if(!url)return null;try{const r=await fetch(`${url}?action=getStatus&ts=${Date.now()}`,{method:"GET",redirect:"follow",headers:{"Accept":"application/json"}});if(!r.ok)return null;const d=await r.json();return d.ok?d:null;}catch(e){return null;} }
function queueWriteBack(entry){ fetcherSt.wbBuffer.push({...entry,timestamp:new Date().toISOString()});if(fetcherSt.wbBuffer.length>=WB_FLUSH_MIN){flushWriteBack();return;}if(!fetcherSt.wbTimer)fetcherSt.wbTimer=setTimeout(flushWriteBack,WB_FLUSH_MS); }
async function flushWriteBack(){ if(fetcherSt.wbTimer){clearTimeout(fetcherSt.wbTimer);fetcherSt.wbTimer=null;}if(!fetcherSt.wbBuffer.length)return;const cfg=await getConfig();if(!cfg.sheetUrl){fetcherSt.wbBuffer=[];return;}const entries=[...fetcherSt.wbBuffer];fetcherSt.wbBuffer=[];try{await fetch(cfg.sheetUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"logBatch",entries}),redirect:"follow"});}catch(err){logWarn("Write-back failed: "+err.message);} }
async function markDoneInSheet(toteId){ const cfg=await getConfig();if(!cfg.sheetUrl)return;try{await fetch(cfg.sheetUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"markDone",toteId,status:"Done"}),redirect:"follow"});}catch(e){} }
function broadcastFetch(status){ chrome.runtime.sendMessage({type:"FETCH_STATUS_UPDATE",status,lastFetchTime:fetcherSt.lastFetchTime,lastFetchResult:fetcherSt.lastFetchResult,fetchErrors:fetcherSt.fetchErrors}).catch(()=>{}); }

// ── Zone picker (weighted round-robin) ────────────────────────────────────────
function pickNextZone(config,credits){ if(!config.multiZone||!config.zones||config.zones.length===0)return{zone:config.zone,instanceCode:config.instanceCode};const active=config.zones.filter(z=>z.zone&&z.percentage>0);if(active.length===0)return{zone:config.zone,instanceCode:config.instanceCode};if(active.length===1)return{zone:active[0].zone,instanceCode:active[0].instanceCode};const totalWeight=active.reduce((s,z)=>s+z.percentage,0);for(const z of active){if(credits[z.id]===undefined)credits[z.id]=0;credits[z.id]+=z.percentage;}let best=active[0];for(const z of active)if(credits[z.id]>credits[best.id])best=z;credits[best.id]-=totalWeight;return{zone:best.zone,instanceCode:best.instanceCode}; }

// ── Auto Mode Scheduler ────────────────────────────────────────────────────────
const A={running:false,paused:false,status:"idle",sessionId:null,config:null,currentBatch:[],batchIdx:0,retryCount:0,expectedNext:null,stats:{called:0,alreadyQueued:0,notAvailable:0,skipped:0,ignored:0,batchesRun:0},log:[],timerId:null,zoneCredits:{},lastHeartbeatAt:null,awaitingHeartbeat:false,heartbeatDeadline:null,heartbeatFailsafeTimer:null};
function aLog(level,msg){A.log.push({t:Date.now(),level,msg});if(A.log.length>MAX_AUTO_LOG)A.log=A.log.slice(-MAX_AUTO_LOG);broadcastAuto();}
function broadcastAuto(){saveAutoState_store({running:A.running,paused:A.paused,status:A.status,stats:A.stats,sessionId:A.sessionId,log:A.log,config:A.config,batchIdx:A.batchIdx,currentBatch:A.currentBatch,expectedNext:A.expectedNext,lastHeartbeatAt:A.lastHeartbeatAt,awaitingHeartbeat:A.awaitingHeartbeat,heartbeatDeadline:A.heartbeatDeadline});chrome.runtime.sendMessage({type:"AUTO_STATE_UPDATE",state:autoSnap()}).catch(()=>{});}
function autoSnap(){return{running:A.running,paused:A.paused,status:A.status,config:A.config,stats:{...A.stats},log:A.log,queue:pqSnapshot(),nextBatchIn:A.expectedNext?Math.max(0,A.expectedNext-Date.now()):null,sessionId:A.sessionId,awaitingHeartbeat:A.awaitingHeartbeat,heartbeatDeadline:A.heartbeatDeadline,heartbeatMinutes:A.config?(A.config.heartbeatMinutes||10):null};}
async function autoStart(config){if(A.running)await autoStop();if(A.heartbeatFailsafeTimer){clearTimeout(A.heartbeatFailsafeTimer);A.heartbeatFailsafeTimer=null;}Object.assign(A,{config,running:true,paused:false,status:"running",sessionId:generateId(),retryCount:0,currentBatch:[],batchIdx:0,zoneCredits:{},log:[],stats:{called:0,alreadyQueued:0,notAvailable:0,skipped:0,ignored:0,batchesRun:0},lastHeartbeatAt:Date.now(),awaitingHeartbeat:false,heartbeatDeadline:null});logSessionStart(pqSize(),config.zone,config.instanceCode,"auto",A.sessionId);aLog("info",`▶ Auto started — ${pqSize()} totes → Zone ${config.zone}`);await runBatch();}
async function autoStop(){A.running=false;A.paused=false;A.status="idle";if(A.heartbeatFailsafeTimer){clearTimeout(A.heartbeatFailsafeTimer);A.heartbeatFailsafeTimer=null;}A.awaitingHeartbeat=false;A.heartbeatDeadline=null;await chrome.alarms.clear(ALARM.CALL);if(A.timerId){clearTimeout(A.timerId);A.timerId=null;}logSessionStop(A.stats.called,pqSize(),"auto",A.sessionId);aLog("warn",`■ Stopped. Called:${A.stats.called}`);await flushLogsNow();broadcastAuto();}
async function autoPause(){if(!A.running||A.paused)return;A.paused=true;A.status="paused";await chrome.alarms.clear(ALARM.CALL);if(A.timerId){clearTimeout(A.timerId);A.timerId=null;}aLog("warn","⏸ Paused.");broadcastAuto();}
async function autoResume(){if(!A.running||!A.paused)return;A.paused=false;A.status="running";aLog("info","▶ Resumed.");broadcastAuto();if(A.currentBatch.length>0&&A.batchIdx<A.currentBatch.length)A.timerId=setTimeout(callNextInBatch,0);else await runBatch();}
async function autoSkip(){if(!A.running||!A.currentBatch.length)return;const entry=A.currentBatch[A.batchIdx];if(!entry)return;const zt=`Zone ${A.config.zone}`;if(A.timerId){clearTimeout(A.timerId);A.timerId=null;}A.retryCount=0;aLog("skipped",`⏭ [${entry.toteId} → ${zt}] Manually skipped.`);logSkipped(entry.toteId,zt,{mode:"auto",priority:entry.priority,sessionId:A.sessionId});await recordCall(entry.toteId,{zone:zt,mode:"auto",priority:entry.priority,condition:"skipped",sessionId:A.sessionId});A.stats.skipped++;A.batchIdx++;A.timerId=setTimeout(callNextInBatch,0);broadcastAuto();}
function _hasLiveFeed(){return!!(A.config&&(A.config.grafanaAuto||A.config.sheetUrl));}
async function runBatch(){if(!A.running||A.paused)return;if(pqEmpty()){if(_hasLiveFeed()){A.status="waiting";A.currentBatch=[];A.batchIdx=0;A.expectedNext=null;await chrome.alarms.clear(ALARM.CALL);aLog("info","⏳ Queue empty — waiting for next live fetch to bring in more totes (session stays active).");broadcastAuto();return;}A.status="completed";aLog("info","✓ Queue empty — all totes processed.");await autoStop();return;}const batch=pqNext(A.config.batchSize||5);if(!batch.length){if(_hasLiveFeed()){A.status="waiting";A.currentBatch=[];A.batchIdx=0;A.expectedNext=null;await chrome.alarms.clear(ALARM.CALL);aLog("info","⏳ Queue drained — waiting for next live fetch.");broadcastAuto();return;}A.status="completed";await autoStop();return;}A.currentBatch=batch;A.batchIdx=0;A.retryCount=0;A.stats.batchesRun++;aLog("info",`📦 Batch ${A.stats.batchesRun} — ${batch.length} totes | ${pqSize()} remaining`);const intMins=A.config.batchIntervalMinutes||1;A.expectedNext=Date.now()+minutesToMs(intMins);if(intMins>=1)await chrome.alarms.create(ALARM.CALL,{delayInMinutes:Math.max(0.5,intMins)});A.timerId=setTimeout(callNextInBatch,0);}
async function callNextInBatch(){A.timerId=null;if(!A.running||A.paused)return;if(A.awaitingHeartbeat)return;const hbMin=A.config.heartbeatMinutes||10;if(A.lastHeartbeatAt&&(Date.now()-A.lastHeartbeatAt)>=hbMin*60000){A.awaitingHeartbeat=true;A.heartbeatDeadline=Date.now()+60000;aLog("warn",`⏸ Awaiting operator confirmation — ${hbMin}m elapsed since last check-in.`);A.heartbeatFailsafeTimer=setTimeout(async()=>{if(A.awaitingHeartbeat){aLog("warn","⏹ No confirmation received in 60s — auto-stopping for safety.");await autoStop();}},60000);return;}if(A.batchIdx>=A.currentBatch.length){aLog("info","✓ Batch complete.");A.currentBatch=[];A.batchIdx=0;broadcastAuto();const m=A.config.batchIntervalMinutes||1;if(m<1)A.timerId=setTimeout(runBatch,Math.max(1000,m*60000));return;}if(pqShouldPreempt()&&A.batchIdx>0){aLog("warn","🚨 SD/P0 preemption.");for(const e of A.currentBatch.slice(A.batchIdx))pqInsert(e.toteId,e.priority,e.source,{pid:e.pid,barcodeCount:e.barcodeCount});A.currentBatch=[];A.batchIdx=0;await runBatch();return;}const entry=A.currentBatch[A.batchIdx];const _zp=pickNextZone(A.config,A.zoneCredits);const zt=`Zone ${_zp.zone}`;const coolMs=minutesToMs(A.config.cooldownMinutes||0);if(coolMs>0){const hist=await getCallHistory();const rem=cooldownRemaining(entry.toteId,hist,coolMs);if(rem>0){logIgnored(entry.toteId,zt,rem,{mode:"auto",priority:entry.priority,sessionId:A.sessionId});aLog("ignored",`[${entry.toteId}] Cooldown ${Math.ceil(rem/60000)}m`);A.stats.ignored++;A.batchIdx++;A.timerId=setTimeout(callNextInBatch,500);broadcastAuto();return;}}const _t0=Date.now();const result=await callTote(A.config.host,_zp.instanceCode,entry.toteId,_zp.zone);if(result.condition===CONDITION.RETRY){A.retryCount++;if(A.retryCount>=LIMITS.MAX_RETRIES){aLog("net_err",`⏭ [${entry.toteId} → ${zt}] Auto-skipped.`);logAutoSkip(entry.toteId,zt,LIMITS.MAX_RETRIES,{mode:"auto",sessionId:A.sessionId});await recordCall(entry.toteId,{zone:zt,mode:"auto",priority:entry.priority,condition:"skipped",sessionId:A.sessionId});A.stats.skipped++;A.batchIdx++;A.retryCount=0;A.timerId=setTimeout(callNextInBatch,nextDelayMs(A.config.callInterval,_t0));}else{aLog("net_err",`⚠ [${entry.toteId} → ${zt}] ${result.rawMsg} — Retry ${A.retryCount}…`);logRetry(entry.toteId,zt,result.rawMsg,A.retryCount,{mode:"auto",sessionId:A.sessionId});A.timerId=setTimeout(callNextInBatch,(A.config.retryDelay||5)*1000);}broadcastAuto();return;}A.retryCount=0;const meta=CONDITION_META[result.condition]||{logLevel:"op_err",label:result.condition,countAsDone:false};aLog(meta.logLevel,`[${entry.toteId} → ${zt}] [${entry.priority}] ${meta.label}`+(result.via==="tab"?" (via tab)":""));if(meta.logLevel==="op_ok")logOpOk(entry.toteId,zt,result.condition,{mode:"auto",priority:entry.priority,source:entry.source,apiMsg:result.rawMsg,sessionId:A.sessionId});else if(meta.logLevel==="op_warn")logOpWarn(entry.toteId,zt,result.condition,{mode:"auto",priority:entry.priority,source:entry.source,apiMsg:result.rawMsg,sessionId:A.sessionId});else logOpErr(entry.toteId,zt,result.condition,{mode:"auto",priority:entry.priority,source:entry.source,apiMsg:result.rawMsg,sessionId:A.sessionId});await recordCall(entry.toteId,{zone:zt,mode:"auto",priority:entry.priority,condition:result.condition,sessionId:A.sessionId});queueWriteBack({toteId:entry.toteId,zone:zt,status:result.condition,priority:entry.priority,mode:"auto",source:entry.source||"",apiMessage:result.rawMsg||"",sessionId:A.sessionId});if(result.condition===CONDITION.INSERTED||result.condition===CONDITION.RELEASED){A.stats.called++;markDoneInSheet(entry.toteId);}else if(result.condition===CONDITION.ALREADY_QUEUED)A.stats.alreadyQueued++;else if(result.condition===CONDITION.NOT_AVAILABLE)A.stats.notAvailable++;A.batchIdx++;broadcastAuto();A.timerId=setTimeout(callNextInBatch,nextDelayMs(A.config.callInterval,_t0));}

// ── Auto Mode Heartbeat — operator confirmation ─────────────────────────────
// callNextInBatch() gates every tote call on this: once heartbeatMinutes has
// elapsed since the last confirmation, it stops calling and sets
// awaitingHeartbeat+heartbeatDeadline instead. The UI (safety-limiters.js)
// shows a modal when it sees that state and sends one of these two messages
// back. If neither arrives within 60s, the failsafe timer below auto-stops —
// this is the actual fix for "Auto Mode ran unattended with no kill switch":
// silence past the deadline now means stop, not continue.
async function autoHeartbeatConfirm(){
  if(!A.awaitingHeartbeat)return;
  if(A.heartbeatFailsafeTimer){clearTimeout(A.heartbeatFailsafeTimer);A.heartbeatFailsafeTimer=null;}
  A.awaitingHeartbeat=false;A.heartbeatDeadline=null;A.lastHeartbeatAt=Date.now();
  aLog("info","✓ Operator confirmed — resuming Auto Mode.");
  if(A.running&&!A.paused)A.timerId=setTimeout(callNextInBatch,0);
}
async function autoHeartbeatStop(){
  if(A.heartbeatFailsafeTimer){clearTimeout(A.heartbeatFailsafeTimer);A.heartbeatFailsafeTimer=null;}
  A.awaitingHeartbeat=false;A.heartbeatDeadline=null;
  await autoStop();
}
async function recoverAutoState(){const saved=await getAutoState_store();if(!saved||!saved.running)return;Object.assign(A,{running:saved.running,paused:saved.paused,status:saved.status,stats:saved.stats||A.stats,sessionId:saved.sessionId,config:saved.config,log:saved.log||[],batchIdx:saved.batchIdx||0,currentBatch:saved.currentBatch||[],expectedNext:saved.expectedNext||null,lastHeartbeatAt:saved.lastHeartbeatAt||Date.now(),awaitingHeartbeat:saved.awaitingHeartbeat||false,heartbeatDeadline:saved.heartbeatDeadline||null});aLog("info","↻ Auto session recovered.");if(A.paused)return;if(A.awaitingHeartbeat&&A.heartbeatDeadline){const remaining=A.heartbeatDeadline-Date.now();if(remaining<=0){aLog("warn","⏹ Heartbeat deadline passed while backgrounded — auto-stopping for safety.");await autoStop();}else{A.heartbeatFailsafeTimer=setTimeout(async()=>{if(A.awaitingHeartbeat){aLog("warn","⏹ No confirmation received in 60s — auto-stopping for safety.");await autoStop();}},remaining);broadcastAuto();}return;}if(A.currentBatch.length>0&&A.batchIdx<A.currentBatch.length){A.timerId=setTimeout(callNextInBatch,1000);return;}const _now=Date.now();if(!A.expectedNext||_now>=A.expectedNext){await runBatch();}else{const _remainMin=Math.max(0.5,(A.expectedNext-_now)/60000);await chrome.alarms.create(ALARM.CALL,{delayInMinutes:_remainMin});aLog("info",`↻ Recovered mid-wait — next batch in ~${Math.ceil(_remainMin)}m.`);broadcastAuto();}}

// ── Manual Mode ────────────────────────────────────────────────────────────────
const M={running:false,paused:false,total:0,done:0,currentIdx:0,totes:[],config:null,log:[],label:"",timerId:null,detailedLog:[],sessionId:null,retryCount:0,ticking:false,zoneCredits:{}};
function mPruneLog(){const cut=Date.now()-MS_24H;M.detailedLog=M.detailedLog.filter(e=>e.t>=cut);}
function mUiLog(level,msg){M.log.push({t:Date.now(),level,msg});if(M.log.length>MAX_UI_LOG)M.log=M.log.slice(-MAX_UI_LOG);mBroadcast();}
function mRecord(tote,condition,zone,rawMsg){const meta=CONDITION_META[condition]||{};M.detailedLog=M.detailedLog.filter(e=>e.tote!==tote);M.detailedLog.push({t:Date.now(),tote,zone,condition,label:meta.label||condition,color:meta.color||"red",rawMsg:rawMsg||"",mode:"manual"});}
function mBroadcast(){saveRunState({running:M.running,paused:M.paused,total:M.total,done:M.done,currentIdx:M.currentIdx,totes:M.totes,config:M.config,log:M.log,label:M.label,detailedLog:M.detailedLog,sessionId:M.sessionId,zoneCredits:M.zoneCredits||{}});chrome.runtime.sendMessage({type:"STATE_UPDATE",state:mSnap()}).catch(()=>{});}
function mSnap(){mPruneLog();return{running:M.running,paused:M.paused,total:M.total,done:M.done,log:M.log,label:M.label,detailedLog:M.detailedLog};}
function mSchedule(ms){if(M.timerId){clearTimeout(M.timerId);M.timerId=null;}M.timerId=setTimeout(mTick,ms);}
async function mTick(){if(M.ticking)return;M.ticking=true;M.timerId=null;if(!M.running||M.paused){M.ticking=false;return;}if(M.currentIdx>=M.totes.length){M.running=false;M.label="Completed";chrome.alarms.clear(ALARM.MANUAL);mUiLog("info",`✓ Finished — ${M.done}/${M.total} totes called.`);logSessionDone(M.done,M.total,"manual",M.sessionId);M.ticking=false;mBroadcast();return;}const toteId=M.totes[M.currentIdx];const{host,callInterval,retryDelay}=M.config;const _mzp=pickNextZone(M.config,M.zoneCredits);const zt=`Zone ${_mzp.zone}`;M.label=`Pulling ${toteId} → ${zt}`;mBroadcast();const _t0=Date.now();const result=await callTote(host,_mzp.instanceCode,toteId,_mzp.zone);if(result.condition===CONDITION.RETRY){M.retryCount=(M.retryCount||0)+1;if(M.retryCount>=LIMITS.MAX_RETRIES){mUiLog("net_err",`⏭ [${toteId} → ${zt}] Auto-skipped after ${LIMITS.MAX_RETRIES} retries.`);logAutoSkip(toteId,zt,LIMITS.MAX_RETRIES,{mode:"manual",sessionId:M.sessionId});mRecord(toteId,CONDITION.SKIPPED,zt,"Auto-skipped");M.currentIdx++;M.retryCount=0;M.ticking=false;mSchedule(nextDelayMs(callInterval,_t0));}else{mUiLog("net_err",`⚠ [${toteId} → ${zt}] ${result.rawMsg} — Retry ${M.retryCount}…`);logRetry(toteId,zt,result.rawMsg,M.retryCount,{mode:"manual",sessionId:M.sessionId});M.ticking=false;mSchedule(retryDelay*1000);}return;}M.retryCount=0;const meta=CONDITION_META[result.condition]||{logLevel:"op_err",label:result.condition,countAsDone:false};mUiLog(meta.logLevel,`[${toteId} → ${zt}] ${meta.label}`+(result.via==="tab"?" (via tab)":""));mRecord(toteId,result.condition,zt,result.rawMsg);if(meta.logLevel==="op_ok")logOpOk(toteId,zt,result.condition,{mode:"manual",apiMsg:result.rawMsg,sessionId:M.sessionId});else if(meta.logLevel==="op_warn")logOpWarn(toteId,zt,result.condition,{mode:"manual",apiMsg:result.rawMsg,sessionId:M.sessionId});else logOpErr(toteId,zt,result.condition,{mode:"manual",apiMsg:result.rawMsg,sessionId:M.sessionId});if(meta.countAsDone)M.done++;M.currentIdx++;M.ticking=false;mSchedule(nextDelayMs(callInterval,_t0));}
async function loadManualState(){const saved=await getRunState();if(saved){Object.assign(M,saved);if(!M.detailedLog)M.detailedLog=[];if(M.paused===undefined)M.paused=false;mPruneLog();if(M.running&&!M.paused){M.timerId=null;mSchedule(0);}}}

// ═══════════════════════════════════════════════════════════════════════════
// Tote Tracker (Tracker tab) — batch lookup across Tote Finder, Scanner Events,
// tracker_history (bad trackers) + NexS blocked-on-tote for Outside totes.
// One Grafana ds/query per concern (IN-list), not per tote.
// ═══════════════════════════════════════════════════════════════════════════
const TR_DS_UID = "rerQ11pVk", TR_DS_TYPE = "mssql", TR_DS_ID = 1;

function trSqlStrIn(ids){ return ids.map(s => `'${String(s).replace(/[^A-Za-z0-9_\-]/g,"")}'`).join(","); }
function trSqlNumIn(ids){ return ids.map(s => `'${String(s).replace(/[^0-9]/g,"")}'`).filter(s => s !== "''").join(","); }

function trStatusOf(loc){
  if(!loc) return "";
  const l = String(loc).toLowerCase();
  if(l.includes("_bt_")) return "Bad Tracker";
  if(l.includes("_bin") || l.includes("_bout")) return "Buffer";
  if(l.includes("out")) return "Outside Tote";
  if(/^00[4-9]/.test(l)) return "On Location";
  return "—";
}

// Grafana columnar frame → array of row objects
function trFrameRows(data){
  const f = data && data.results && data.results.A && data.results.A.frames && data.results.A.frames[0];
  if(!f) return [];
  const names = f.schema.fields.map(x => x.name);
  const cols = f.data.values || [];
  const n = (cols[0] || []).length, out = [];
  for(let i=0;i<n;i++){ const o={}; names.forEach((nm,ci)=>o[nm]=cols[ci][i]); out.push(o); }
  return out;
}

async function trGrafana(host, sql){
  const now = Date.now();
  const body = buildGrafanaBody(TR_DS_UID, TR_DS_TYPE, TR_DS_ID, sql, now - 7*86400000, now);
  return await callGrafanaDS(host, body);
}

function trProgress(done,total){ try{ const p=chrome.runtime.sendMessage({type:"TRACKER_PROGRESS",done,total}); if(p&&p.catch) p.catch(()=>{}); }catch(e){} }

async function trackerRun(totes, host, facility){
  host = (host || DEFAULTS.GRAFANA_URL).replace(/\/+$/,"");
  totes = [...new Set((totes||[]).map(t => String(t).trim().toUpperCase()).filter(Boolean))];
  if(!totes.length) return [];
  const inList = trSqlStrIn(totes);

  // 1) Tote Finder — latest row per container
  const finderSql = `SELECT tracker,container,location,lane,updated_timestamp FROM (`
    + `SELECT lt.tracker,ct.container,lt.location,lt.lane,lt.updated_timestamp,`
    + `ROW_NUMBER() OVER (PARTITION BY ct.container ORDER BY ct.created_time DESC) rn `
    + `FROM lenskart_quadron.dbo.location_tracker lt `
    + `JOIN lenskart_quadron.dbo.container_tracker ct ON ct.tracker=lt.tracker `
    + `WHERE ct.container IN (${inList})) x WHERE rn=1;`;

  // 2) Scanner Events — latest 5 per container
  const scanSql = `SELECT scanner,container,create_time,decision,decision_reason FROM (`
    + `SELECT se.scanner,se.container,se.create_time,se.decision,se.decision_reason,`
    + `ROW_NUMBER() OVER (PARTITION BY se.container ORDER BY se.create_time DESC) rn `
    + `FROM lenskart_gtp.dbo.scanner_events se `
    + `WHERE se.container IN (${inList})) x WHERE rn<=5 ORDER BY container,create_time DESC;`;

  const [finderData, scanData] = await Promise.all([trGrafana(host, finderSql), trGrafana(host, scanSql)]);
  const finderRows = trFrameRows(finderData), scanRows = trFrameRows(scanData);

  const finderByTote = Object.create(null);
  finderRows.forEach(r => { finderByTote[String(r.container).toUpperCase()] = r; });
  const scansByTote = Object.create(null);
  scanRows.forEach(r => { const k = String(r.container).toUpperCase(); (scansByTote[k] = scansByTote[k] || []).push(r); });

  // 3) Bad trackers → last good location (2nd destination, ordered by time DESC)
  const badTrackers = [];
  for(const t of totes){ const f = finderByTote[t]; if(f && trStatusOf(f.location) === "Bad Tracker" && f.tracker != null) badTrackers.push(f.tracker); }
  const lastGoodByTracker = Object.create(null);
  if(badTrackers.length){
    const tIn = trSqlNumIn([...new Set(badTrackers)]);
    if(tIn){
      const histSql = `SELECT tracker,destination,rn FROM (`
        + `SELECT th.tracker,th.destination,ROW_NUMBER() OVER (PARTITION BY th.tracker ORDER BY th.create_timestamp DESC) rn `
        + `FROM lenskart_quadron.dbo.tracker_history th WHERE th.tracker IN (${tIn})) x WHERE rn<=2;`;
      try{ trFrameRows(await trGrafana(host, histSql)).forEach(r => { if(Number(r.rn) === 2) lastGoodByTracker[String(r.tracker)] = r.destination; }); }catch(e){}
    }
  }

  // 4) Purge candidates (Outside + Bad Tracker) → blocked-on-tote via NexS and
  //    purge safety, both keyed off the tote's PIDs (Quadron inventory dashboard).
  const isCandStatus = s => s === "Outside Tote" || s === "Bad Tracker";
  const candidateTotes = totes.filter(t => finderByTote[t] && isCandStatus(trStatusOf(finderByTote[t].location)));
  const blockedByTote = Object.create(null);
  const purgeByTote = Object.create(null);   // tote → { safe:bool|null, min:count, unsafe:[{pid,count}] }
  if(candidateTotes.length){
    try{
      const cfg = await getConfig();
      const inv = await fetchInventoryDashboard(host, cfg.instanceCode);
      const skusByTote = Object.create(null);
      const totesPerSku = Object.create(null);   // sku → Set(base totes holding it, facility-wide)

      // Source A — live Quadron inventory (authoritative current distribution)
      if(inv.ok && Array.isArray(inv.data)){
        for(const e of inv.data){
          const b = invBaseOf(e.toteId); if(!b) continue;
          for(const md of (e.materialDetails || [])){
            const sku = String(md.sku||"").trim(); if(!sku) continue;
            (skusByTote[b] = skusByTote[b] || new Set()).add(sku);
            (totesPerSku[sku] = totesPerSku[sku] || new Set()).add(b);
          }
        }
      }

      // Source B — ASRS sheet dump, merged in as a FALLBACK. Outside totes (and
      // some bad-tracker totes) are out of the ASRS, so the live inventory has no
      // material lines for them and the decision would come back blank. The dump
      // still records their last-known PIDs, and it widens the facility-wide
      // PID→tote distribution so "critical PID" counts aren't under-stated.
      const stillUncovered = candidateTotes.some(t => { const s = skusByTote[invBaseOf(t)]; return !s || !s.size; });
      if(stillUncovered && cfg.sheetUrl){
        try{
          const dump = await fetchAsrsDump(cfg.sheetUrl);
          if(dump.ok && Array.isArray(dump.rows)){
            for(const row of dump.rows){
              const b = invBaseOf(row.toteId); const sku = String(row.pid||"").trim();
              if(!b || !sku) continue;
              (skusByTote[b] = skusByTote[b] || new Set()).add(sku);
              (totesPerSku[sku] = totesPerSku[sku] || new Set()).add(b);
            }
          }
        }catch(e){ /* dump is optional — inventory-only fallback */ }
      }

      // Source C — WES tote_details over Grafana SQL, for outside totes that have
      // LEFT the ASRS entirely (absent from both live inventory and the ASRS dump,
      // which only describe what's currently inside). tote_details retains a tote's
      // line items regardless of location, so it closes the remaining gaps. Two
      // queries: (1) the uncovered candidates' SKUs, (2) facility-wide tote-count
      // for those SKUs so "critical PID" isn't understated. Best-effort: if the
      // schema differs, it's caught and those rows simply stay blank (no regression).
      let uncoveredTotes = candidateTotes
        .filter(t => { const s = skusByTote[invBaseOf(t)]; return !s || !s.size; })
        .map(t => invBaseOf(t));
      uncoveredTotes = [...new Set(uncoveredTotes)];
      if(uncoveredTotes.length){
        try{
          const inListT = trSqlStrIn(uncoveredTotes);
          const sql1 = `SELECT SUBSTRING(td.container,1,12) AS tote_id, td.sku AS sku `
            + `FROM lenskart_wes.dbo.tote_details td `
            + `WHERE SUBSTRING(td.container,1,12) IN (${inListT}) AND td.sku IS NOT NULL`;
          const newSkus = new Set();
          trFrameRows(await trGrafana(host, sql1)).forEach(r => {
            const b = invBaseOf(r.tote_id); const sku = String(r.sku||"").trim();
            if(!b || !sku) return;
            (skusByTote[b] = skusByTote[b] || new Set()).add(sku);
            (totesPerSku[sku] = totesPerSku[sku] || new Set()).add(b);
            newSkus.add(sku);
          });
          if(newSkus.size){
            const inListS = trSqlStrIn([...newSkus]);
            const sql2 = `SELECT DISTINCT SUBSTRING(td.container,1,12) AS tote_id, td.sku AS sku `
              + `FROM lenskart_wes.dbo.tote_details td WHERE td.sku IN (${inListS})`;
            trFrameRows(await trGrafana(host, sql2)).forEach(r => {
              const b = invBaseOf(r.tote_id); const sku = String(r.sku||"").trim();
              if(!b || !sku) return;
              (totesPerSku[sku] = totesPerSku[sku] || new Set()).add(b);
            });
          }
        }catch(e){ /* tote_details schema may differ — best effort, gaps remain if it fails */ }
      }

      // Have we got at least one usable source?
      const haveData = Object.keys(skusByTote).length > 0;
      if(haveData){
        const uniq = new Set();
        candidateTotes.forEach(t => (skusByTote[invBaseOf(t)] || new Set()).forEach(s => uniq.add(s)));
        const skuList = [...uniq];
        const blockedBySku = Object.create(null);
        for(let i=0;i<skuList.length;i+=PURGE_BLOCKED_CONCURRENCY){
          const batch = skuList.slice(i, i+PURGE_BLOCKED_CONCURRENCY);
          await Promise.all(batch.map(async sku => { const r = await fetchBlockedInv(sku, facility); blockedBySku[sku] = r.ok ? (Number(r.data.blockedInventory)||0) : null; }));
          trProgress(Math.min(i+batch.length, skuList.length), skuList.length);
        }
        candidateTotes.forEach(t => {
          const skus = skusByTote[invBaseOf(t)] || new Set();
          // blocked = sum over the tote's PIDs
          let sum = 0, any = false;
          skus.forEach(s => { if(blockedBySku[s] != null){ sum += blockedBySku[s]; any = true; } });
          blockedByTote[t] = any ? sum : null;
          // purge safe/unsafe = min PID tote-count > 2 (a PID in only 1–2 totes => critical => unsafe)
          if(!skus.size){ purgeByTote[t] = { safe:null, min:null, unsafe:[] }; }
          else {
            let min = Infinity; const unsafe = [];
            skus.forEach(s => { const c = (totesPerSku[s] || new Set()).size; if(c < min) min = c; if(c <= 2) unsafe.push({ pid:s, count:c }); });
            unsafe.sort((a,b) => a.count - b.count);   // most critical (fewest totes) first
            purgeByTote[t] = { safe: min > 2, min, unsafe };
          }
        });
      }
    }catch(e){ /* leave blocked/purge as null → UI shows — */ }
  }

  // 5) Assemble (preserve input order)
  return totes.map(tote => {
    const f = finderByTote[tote] || null;
    const scans = (scansByTote[tote] || []).slice(0,5);
    const status = f ? trStatusOf(f.location) : "";
    let lastGood = ""; if(status === "Bad Tracker" && f) lastGood = lastGoodByTracker[String(f.tracker)] || "";
    const cand = isCandStatus(status);
    const blocked = cand ? (blockedByTote[tote] !== undefined ? blockedByTote[tote] : null) : undefined;
    const pg = cand ? (purgeByTote[tote] || { safe:null, min:null, unsafe:[] }) : undefined;
    return {
      tote,
      tracker: f ? f.tracker : "",
      location: f ? f.location : "",
      status, lastGood,
      lane: f ? f.lane : "",
      updated: f ? f.updated_timestamp : null,
      latestScan: scans[0] ? scans[0].create_time : null,
      scans: scans.map(s => ({ scanner: s.scanner, reason: s.decision_reason, decision: s.decision })),
      blocked,
      purgeSafe: pg ? pg.safe : undefined,
      pidToteMin: pg ? pg.min : undefined,
      unsafePids: pg ? pg.unsafe : undefined
    };
  });
}

// ── Message Handlers ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  (async()=>{
    if(msg.type==="HEARTBEAT"){if(M.running&&!M.paused&&!M.timerId&&!M.ticking&&M.currentIdx<M.totes.length)mSchedule(500);sendResponse({ok:true,running:M.running,paused:M.paused,idx:M.currentIdx});return;}
    if(msg.type==="GET_STATE"){sendResponse(mSnap());return;}
    if(msg.type==="CHECK_AUTH"){sendResponse(await checkAuth(msg.host));return;}
    if(msg.type==="START"){const cfg=msg.config;Object.assign(M,{config:cfg,totes:cfg.totes,total:cfg.totes.length,done:0,currentIdx:0,running:true,paused:false,label:"Starting…",retryCount:0,ticking:false,zoneCredits:{},sessionId:generateId()});M.log=[];M.detailedLog=[];mUiLog("info",`▶ Starting: ${M.total} totes → Zone ${cfg.zone}`);logSessionStart(M.total,cfg.zone,cfg.instanceCode,"manual",M.sessionId);chrome.alarms.create(ALARM.MANUAL,{periodInMinutes:1});mSchedule(0);sendResponse({ok:true});return;}
    if(msg.type==="STOP"){chrome.alarms.clear(ALARM.MANUAL);M.running=false;M.paused=false;if(M.timerId){clearTimeout(M.timerId);M.timerId=null;}M.label="Stopped";mUiLog("warn",`■ Stopped at ${M.currentIdx+1}/${M.total}.`);logSessionStop(M.done,M.total,"manual",M.sessionId);mBroadcast();sendResponse({ok:true});return;}
    if(msg.type==="MANUAL_PAUSE"){if(!M.running||M.paused){sendResponse({ok:false,reason:"not running or already paused"});return;}M.paused=true;if(M.timerId){clearTimeout(M.timerId);M.timerId=null;}M.label=`Paused at tote ${M.currentIdx+1}/${M.total}`;mUiLog("warn",`⏸ Paused — ${M.total-M.currentIdx} totes remaining.`);mBroadcast();sendResponse({ok:true});return;}
    if(msg.type==="MANUAL_RESUME"){if(!M.running||!M.paused){sendResponse({ok:false,reason:"not paused"});return;}M.paused=false;M.label="Resuming…";mUiLog("info",`▶ Resumed from tote ${M.currentIdx+1}/${M.total}.`);mBroadcast();mSchedule(0);sendResponse({ok:true});return;}
    if(msg.type==="SKIP_TOTE"){if(!M.running||M.paused||M.currentIdx>=M.totes.length){sendResponse({ok:false,reason:"not running"});return;}const toteId=M.totes[M.currentIdx];const zt=M.config?`Zone ${M.config.zone}`:"";if(M.timerId){clearTimeout(M.timerId);M.timerId=null;}M.retryCount=0;mUiLog("skipped",`⏭ [${toteId} → ${zt}] Manually skipped.`);logSkipped(toteId,zt,{mode:"manual",sessionId:M.sessionId});mRecord(toteId,CONDITION.SKIPPED,zt,"Manually skipped");M.currentIdx++;mSchedule(0);sendResponse({ok:true});return;}
    if(msg.type==="CLEAR_LOG"){M.log=[];mBroadcast();sendResponse({ok:true});return;}
    if(msg.type==="CLEAR_DETAILED_LOG"){M.detailedLog=[];mBroadcast();sendResponse({ok:true});return;}
    if(msg.type==="GET_DETAILED_LOG"){sendResponse({detailedLog:M.detailedLog});return;}
    if(msg.type==="SEARCH_LOGS"){sendResponse({logs:await searchLogs(msg.filters||{})});return;}
    if(msg.type==="EXPORT_LOGS_CSV"){sendResponse({csv:await exportLogsCSV()});return;}
    if(msg.type==="CLEAR_ALL_LOGS"){await clearLogs_store();sendResponse({ok:true});return;}
    if(msg.type==="SAVE_CONFIG"){await saveConfig(msg.config);sendResponse({ok:true});return;}
    if(msg.type==="GET_CONFIG"){sendResponse({config:await getConfig()});return;}
    if(msg.type==="TRACKER_RUN"){try{const rows=await trackerRun(msg.totes||[],msg.host,msg.facility||"NXS1");sendResponse({ok:true,rows});}catch(e){sendResponse({ok:false,reason:e.message||String(e)});}return;}
    if(msg.type==="RCA_RUN"){try{const rows=await rcaRun(msg.host,msg.timeCategories,msg.types);sendResponse({ok:true,rows});}catch(e){sendResponse({ok:false,reason:e.message||String(e)});}return;}
    if(msg.type==="TOTE_UTILISATION"){try{const cfg=await getConfig();const source=msg.source||"sheet_dump";let rows,via,unit;if(source==="quadron_api"){const host=cfg.grafanaUrl||cfg.host||DEFAULTS.HOST;const inv=await fetchInventoryDashboard(host,cfg.instanceCode);if(!inv.ok){sendResponse({ok:false,reason:inv.reason||"Quadron inventory unavailable"});return;}rows=inventoryToUtilRows(inv.data);via=inv.via;}else{const dump=await fetchAsrsDump(cfg.sheetUrl);if(!dump.ok){sendResponse({ok:false,reason:dump.reason});return;}rows=dump.rows;via="sheet";}const result=computeToteUtilisation(rows,msg.caps||{});sendResponse({ok:true,result,rowCount:rows.length,via,source});}catch(e){sendResponse({ok:false,reason:e.message||String(e)});}return;}
    if(msg.type==="AUTO_ADD_TOTES"){await pqLoad();const r=pqInsertMany(msg.totes,msg.priority||"P2",msg.source||"Manual");sendResponse({ok:true,result:r,queue:pqSnapshot()});return;}
    if(msg.type==="AUTO_GET_QUEUE"){await pqLoad();sendResponse({queue:pqSnapshot()});return;}
    if(msg.type==="AUTO_CLEAR_QUEUE"){await pqLoad();pqFlush(msg.priority||null);sendResponse({ok:true,queue:pqSnapshot()});return;}
    if(msg.type==="AUTO_REMOVE_TOTE"){await pqLoad();pqRemove(msg.toteId);sendResponse({ok:true,queue:pqSnapshot()});return;}
    if(msg.type==="PURGE_GENERATE"){
      if(purgeState.running){sendResponse({ok:false,reason:"Purge already running."});return;}
      purgeState.running=true;
      try{ sendResponse(await runPurgeGenerate(msg.opts||{})); }
      catch(e){ writeLog("net_err","Purge error: "+(e.message||e)); sendResponse({ok:false,reason:e.message||String(e)}); }
      finally{ purgeState.running=false; }
      return;
    }
    if(msg.type==="PURGE_GET_LAST"){ sendResponse({ok:true,last:purgeState.last}); return; }
    if(msg.type==="AUTO_START"){
      const cfg=msg.config;
      if(cfg.grafanaUrl){
        // Grafana mode — start Grafana alarms and do initial Grafana fetch
        await startGrafanaAlarms(cfg);
        await runGrafanaFetchCycle(cfg);
      } else if(cfg.sheetUrl){
        // Legacy sheet mode
        await startFetchAlarm(cfg.fetchInterval||2);
        await runFetchCycle(cfg);
      }
      await autoStart(cfg);
      sendResponse({ok:true,state:autoSnap()});
      return;
    }
    if(msg.type==="AUTO_STOP"){await autoStop();await stopFetchAlarm();await flushWriteBack();sendResponse({ok:true});return;}
    if(msg.type==="AUTO_PAUSE"){await autoPause();sendResponse({ok:true});return;}
    if(msg.type==="AUTO_RESUME"){await autoResume();sendResponse({ok:true});return;}
    if(msg.type==="AUTO_HEARTBEAT_CONFIRM"){await autoHeartbeatConfirm();sendResponse({ok:true});return;}
    if(msg.type==="AUTO_HEARTBEAT_STOP"){await autoHeartbeatStop();sendResponse({ok:true});return;}
    if(msg.type==="AUTO_SKIP_TOTE"){await autoSkip();sendResponse({ok:true});return;}
    if(msg.type==="AUTO_GET_STATE"){await pqLoad();sendResponse({state:autoSnap()});return;}
    if(msg.type==="AUTO_FETCH_NOW"){const cfg=await getConfig();const result=await runFetchCycle(cfg);sendResponse({ok:true,result,queue:pqSnapshot()});return;}
    if(msg.type==="PROCESS_QUEUE"){
      const cfg=await getConfig();
      if(cfg.grafanaUrl){
        // Grafana mode — fetch locked totes from Grafana API (Auto toggle only controls timer)
        writeLog("info","↻ Process Queue via Grafana API…");
        const result=await runGrafanaFetchCycle(cfg);
        sendResponse({ok:result.ok,result,queue:pqSnapshot()});
      } else {
        // Legacy sheet mode — read from Google Sheets Locked Tote Dump
        if(!cfg.sheetUrl){sendResponse({ok:false,reason:"No Apps Script URL configured"});return;}
        writeLog("info","↻ Process Queue via Google Sheets…");
        const result=await triggerProcessQueue(cfg.sheetUrl);
        if(result.ok)await runFetchCycle(cfg);
        sendResponse({ok:result.ok||false,result,queue:pqSnapshot()});
      }
      return;
    }
    if(msg.type==="GET_SHEET_STATUS"){const cfg=await getConfig();const status=cfg.sheetUrl?await getSheetStatus(cfg.sheetUrl):null;sendResponse({ok:true,status});return;}
    // ── Grafana messages ──
    if(msg.type==="GRAFANA_CHECK"){const cfg=await getConfig();const r=await checkGrafanaConnection(msg.host||cfg.grafanaUrl);sendResponse(r);return;}
    if(msg.type==="GRAFANA_FETCH_NOW"){const cfg=await getConfig();const result=await runGrafanaFetchCycle(cfg);sendResponse({ok:true,result,queue:pqSnapshot()});return;}
    if(msg.type==="GRAFANA_START_AUTO"){const cfg=await saveConfig({grafanaUrl:msg.grafanaUrl,grafanaAuto:true,grafanaLockedInterval:msg.lockedInterval||30,grafanaSuperEnabled:msg.superEnabled!==false,grafanaSuperInterval:msg.superInterval||60});await startGrafanaAlarms(cfg);const result=await runGrafanaFetchCycle(cfg);sendResponse({ok:true,result,queue:pqSnapshot()});return;}
    if(msg.type==="GRAFANA_STOP_AUTO"){await saveConfig({grafanaAuto:false});await stopGrafanaAlarms();sendResponse({ok:true});return;}
    if(msg.type==="GRAFANA_GET_STATUS"){sendResponse({ok:true,status:{...grafanaSt}});return;}
    // ── Cycle Count Reconciliation messages ──
    if(msg.type==="CC_FETCH"){
      try{
        const cfg=await getConfig();
        const host=msg.host||cfg.grafanaUrl||DEFAULTS.GRAFANA_URL;
        const fromMs=Number(msg.fromMs), toMs=Number(msg.toMs);
        if(!fromMs||!toMs||fromMs>=toMs){sendResponse({ok:false,reason:"Invalid time range"});return;}
        const [discrepancyRows,stockCheckRows]=await Promise.all([
          fetchCCDiscrepancy(host,fromMs,toMs),
          fetchCCStockCheck(host,fromMs,toMs),
        ]);
        sendResponse({ok:true,discrepancyRows,stockCheckRows});
      }catch(e){ sendResponse({ok:false,reason:e.message||String(e)}); }
      return;
    }
    if(msg.type==="ASRS_DAILY_REPORT"){
      try{
        const cfg=await getConfig();
        const host=msg.host||cfg.grafanaUrl||DEFAULTS.GRAFANA_URL;
        const dateStr=msg.dateStr;
        if(!dateStr||!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)){sendResponse({ok:false,reason:"Invalid dateStr (expected YYYY-MM-DD)"});return;}
        const report=await buildAsrsDailyReport(host,dateStr,msg.caps);
        sendResponse(report);
      }catch(e){ sendResponse({ok:false,reason:e.message||String(e)}); }
      return;
    }
    // Default: always respond so awaiting senders don't hang
    sendResponse({ok:false,reason:"Unknown message type: "+(msg.type||"undefined")});
  })();
  return true;
});

// ── Alarms ─────────────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async(alarm)=>{
  if(alarm.name===ALARM.CALL){if(!A.running||A.paused||A.timerId)return;A.expectedNext=Date.now();await runBatch();}
  if(alarm.name===ALARM.FETCH){await onFetchAlarm();}
  if(alarm.name===ALARM.MANUAL){if(M.running&&!M.paused&&!M.timerId&&!M.ticking&&M.currentIdx<M.totes.length){mUiLog("info","↻ Manual session resumed by keepalive.");mSchedule(0);}if(!M.running&&!M.paused)chrome.alarms.clear(ALARM.MANUAL);}
  if(alarm.name===ALARM.GRAFANA_LOCKED){const cfg=await getConfig();if(cfg.grafanaAuto)await runGrafanaFetchCycle(cfg);}
  if(alarm.name===ALARM.GRAFANA_SUPER){/* supervisor fetch is bundled into GRAFANA_LOCKED cycle */}
});

// ── Toolbar click ──────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async()=>{const url=chrome.runtime.getURL("ui/app.html");const tabs=await chrome.tabs.query({url});if(tabs.length>0){await chrome.tabs.update(tabs[0].id,{active:true});await chrome.windows.update(tabs[0].windowId,{focused:true});}else await chrome.tabs.create({url});});

// ── Startup ────────────────────────────────────────────────────────────────────
(async()=>{
  await pqLoad();
  await loadManualState();
  await pruneCallHistory();
  await pruneLogs_store();
  await recoverAutoState();
  try{const gs=await chrome.storage.local.get("qtp_grafana_st");if(gs.qtp_grafana_st)Object.assign(grafanaSt,gs.qtp_grafana_st);}catch(e){}
  const cfg=await getConfig();
  if(cfg.grafanaAuto&&cfg.grafanaUrl)await startGrafanaAlarms(cfg);
  if(cfg.sheetUrl){const auto=await getAutoState_store();if(auto.running)await startFetchAlarm(cfg.fetchInterval||2);}
  await checkGrafanaConnection(cfg.grafanaUrl||DEFAULTS.GRAFANA_URL);
})();
