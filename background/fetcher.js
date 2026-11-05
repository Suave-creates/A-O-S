// background/fetcher.js — ES module
import { QTP_CONSTANTS } from '../shared/constants.js';
import { QTP_UTILS } from '../shared/utils.js';
import { QTP_STORAGE } from './storage.js';
import { QTP_LOGGER } from './logger.js';
import { QTP_QUEUE } from './queue.js';

const { ALARM, PRIORITY, LIMITS } = QTP_CONSTANTS;
const { isValidToteId, isInCooldown, hoursToMs, minutesToMs } = QTP_UTILS;

const st={lastFetchTime:null,lastFetchResult:null,fetchErrors:0,totalFetches:0,writeBackBuffer:[],writeBackTimer:null};
const FLUSH_MS=30000, FLUSH_MIN=5;

async function startFetchAlarm(mins){const safe=Math.max(1,mins||2);await chrome.alarms.clear(ALARM.FETCH);await chrome.alarms.create(ALARM.FETCH,{delayInMinutes:safe,periodInMinutes:safe});QTP_LOGGER.info(`↻ Fetch alarm — every ${safe}m`);}
async function stopFetchAlarm(){await chrome.alarms.clear(ALARM.FETCH);}
async function handleFetchAlarm(){const cfg=await QTP_STORAGE.getConfig();if(!cfg.sheetUrl) return;const auto=await QTP_STORAGE.getAutoState();if(!auto.running) return;await runFetchCycle(cfg);}

async function runFetchCycle(config){
  if(!config.sheetUrl) return{ok:false,reason:"No Apps Script URL configured"};
  QTP_LOGGER.fetchStart();broadcastFetch("fetching");
  let raw;
  try{raw=await fetchFromAppsScript(config.sheetUrl);}
  catch(err){
    st.fetchErrors++;QTP_LOGGER.fetchError(err.message||String(err),st.fetchErrors);broadcastFetch("error",{error:err.message});
    if(st.fetchErrors>=3){const bk=Math.min(Math.pow(2,st.fetchErrors-2),30);await startFetchAlarm(bk);QTP_LOGGER.warn(`↻ Fetch backing off — retry in ${bk}m`);}
    return{ok:false,reason:err.message};
  }
  st.fetchErrors=0;if(config.fetchInterval) await startFetchAlarm(config.fetchInterval);
  const hist=await QTP_STORAGE.getCallHistory();
  const coolMs=hoursToMs(config.cooldownHours||0);
  const result=await processFetchedData(raw,hist,coolMs);
  st.lastFetchTime=Date.now();st.lastFetchResult=result;st.totalFetches++;
  QTP_LOGGER.fetchComplete(result.inserted,QTP_QUEUE.totalSize());
  if(result.p0Added>0) QTP_LOGGER.p0Preempt(result.p0Added);
  broadcastFetch("running",{lastFetchTime:st.lastFetchTime,lastFetchResult:result});
  return{ok:true,...result};
}

async function fetchFromAppsScript(url){
  const resp=await fetch(`${url}?action=getQueue&ts=${Date.now()}`,{method:"GET",redirect:"follow",headers:{"Accept":"application/json"}});
  if(!resp.ok) throw new Error(`Apps Script returned HTTP ${resp.status}`);
  let data;try{data=await resp.json();}catch(e){throw new Error("Apps Script returned invalid JSON");}
  if(!data.ok) throw new Error(data.error||"Apps Script returned ok:false");
  return data;
}

async function processFetchedData(raw,callHistory,cooldownMs){
  const result={fetched:0,inserted:0,duplicates:0,cooledDown:0,invalid:0,p0Added:0,p1Added:0,p2Added:0};
  const all=[...(raw.priorityTotes||[]),...(raw.toteQueue||[])];
  result.fetched=all.length;
  for(const item of all){
    const toteId=String(item.toteId||"").trim().toUpperCase();
    const priority=item.priority||PRIORITY.P2;
    if(!isValidToteId(toteId)){result.invalid++;continue;}
    if(QTP_QUEUE.has(toteId)){result.duplicates++;continue;}
    if(cooldownMs>0&&isInCooldown(toteId,callHistory,cooldownMs)){result.cooledDown++;continue;}
    const outcome=QTP_QUEUE.insert(toteId,priority,item.source||"Sheet",{pid:item.pid||null,barcodeCount:item.barcodeCount||null});
    if(outcome==="inserted"){result.inserted++;if(priority===PRIORITY.P0)result.p0Added++;else if(priority===PRIORITY.P1)result.p1Added++;else result.p2Added++;}
    else if(outcome==="duplicate")result.duplicates++;
    else if(outcome==="full"){QTP_LOGGER.warn(`Queue full (${LIMITS.MAX_QUEUE_SIZE}) — ${toteId} not added`);break;}
  }
  return result;
}

function queueWriteBack(entry){
  st.writeBackBuffer.push({...entry,timestamp:new Date().toISOString()});
  if(st.writeBackBuffer.length>=FLUSH_MIN){flushWriteBack();return;}
  if(!st.writeBackTimer) st.writeBackTimer=setTimeout(flushWriteBack,FLUSH_MS);
}
async function flushWriteBack(){
  if(st.writeBackTimer){clearTimeout(st.writeBackTimer);st.writeBackTimer=null;}
  if(!st.writeBackBuffer.length) return;
  const cfg=await QTP_STORAGE.getConfig();if(!cfg.sheetUrl){st.writeBackBuffer=[];return;}
  const entries=[...st.writeBackBuffer];st.writeBackBuffer=[];
  try{const r=await fetch(cfg.sheetUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"logBatch",entries}),redirect:"follow"});if(!r.ok) throw new Error(`HTTP ${r.status}`);QTP_LOGGER.debug(`Write-back: ${entries.length} entries sent`);}
  catch(err){QTP_LOGGER.warn(`Write-back failed (non-critical): ${err.message||String(err)}`);}
}
async function markDoneInSheet(toteId){
  const cfg=await QTP_STORAGE.getConfig();if(!cfg.sheetUrl) return;
  try{await fetch(cfg.sheetUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"markDone",toteId,status:"Done"}),redirect:"follow"});}
  catch(err){QTP_LOGGER.debug(`markDone failed for ${toteId}: ${err.message}`);}
}

async function getSheetStatus(sheetUrl){
  if(!sheetUrl) return null;
  try{const r=await fetch(`${sheetUrl}?action=getStatus&ts=${Date.now()}`,{method:"GET",redirect:"follow",headers:{"Accept":"application/json"}});if(!r.ok) return null;const d=await r.json();return d.ok?d:null;}
  catch(e){return null;}
}
async function triggerProcessQueue(sheetUrl){
  if(!sheetUrl) return{ok:false,reason:"No URL configured"};
  try{const r=await fetch(`${sheetUrl}?action=processQueue&ts=${Date.now()}`,{method:"GET",redirect:"follow",headers:{"Accept":"application/json"}});if(!r.ok) throw new Error(`HTTP ${r.status}`);return await r.json();}
  catch(e){return{ok:false,reason:e.message||String(e)};}
}

function broadcastFetch(status,extra={}){chrome.runtime.sendMessage({type:"FETCH_STATUS_UPDATE",status,lastFetchTime:st.lastFetchTime,lastFetchResult:st.lastFetchResult,fetchErrors:st.fetchErrors,...extra}).catch(()=>{});}
function getFetcherState(){return{lastFetchTime:st.lastFetchTime,lastFetchResult:st.lastFetchResult,fetchErrors:st.fetchErrors,totalFetches:st.totalFetches};}

export const QTP_FETCHER = { startFetchAlarm,stopFetchAlarm,handleFetchAlarm,runFetchCycle,queueWriteBack,flushWriteBack,markDoneInSheet,getSheetStatus,triggerProcessQueue,getFetcherState };
