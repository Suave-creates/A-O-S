// background/scheduler.js — ES module
import { QTP_CONSTANTS } from '../shared/constants.js';
import { QTP_UTILS } from '../shared/utils.js';
import { QTP_STORAGE } from './storage.js';
import { QTP_CALLER } from './caller.js';
import { QTP_LOGGER } from './logger.js';
import { QTP_QUEUE } from './queue.js';

const { CONDITION, CONDITION_META, ALARM, LIMITS, AUTO_STATUS } = QTP_CONSTANTS;
const { generateId, minutesToMs, hoursToMs } = QTP_UTILS;

const autoState = {
  running:false,paused:false,status:AUTO_STATUS.IDLE,sessionId:null,config:null,
  currentBatch:[],batchIdx:0,retryCount:0,
  expectedNextBatch:null,actualNextBatch:null,
  stats:{called:0,alreadyQueued:0,notAvailable:0,skipped:0,ignored:0,errors:0,batchesRun:0},
  log:[],timerId:null,
};
const MAX_AUTO_LOG=300;

function autoLog(level,msg){autoState.log.push({t:Date.now(),level,msg});if(autoState.log.length>MAX_AUTO_LOG)autoState.log=autoState.log.slice(-MAX_AUTO_LOG);broadcastAutoState();}
function broadcastAutoState(){saveAutoStateToStorage();chrome.runtime.sendMessage({type:"AUTO_STATE_UPDATE",state:autoSnapshot()}).catch(()=>{});}
function autoSnapshot(){return{running:autoState.running,paused:autoState.paused,status:autoState.status,config:autoState.config,stats:{...autoState.stats},log:autoState.log,queue:QTP_QUEUE.snapshot(),nextBatchIn:getNextBatchMs(),sessionId:autoState.sessionId};}
function getNextBatchMs(){if(!autoState.running||autoState.paused||!autoState.expectedNextBatch)return null;return Math.max(0,autoState.expectedNextBatch-Date.now());}
async function saveAutoStateToStorage(){await QTP_STORAGE.saveAutoState({running:autoState.running,paused:autoState.paused,status:autoState.status,stats:autoState.stats,sessionId:autoState.sessionId,log:autoState.log,config:autoState.config,batchIdx:autoState.batchIdx,currentBatch:autoState.currentBatch,expectedNextBatch:autoState.expectedNextBatch});}

async function startAuto(config){
  if(autoState.running) await stopAuto();
  Object.assign(autoState,{config,running:true,paused:false,status:AUTO_STATUS.RUNNING,sessionId:generateId(),retryCount:0,currentBatch:[],batchIdx:0,stats:{called:0,alreadyQueued:0,notAvailable:0,skipped:0,ignored:0,errors:0,batchesRun:0}});
  QTP_LOGGER.sessionStart(QTP_QUEUE.totalSize(),config.zone,config.instanceCode,"auto",autoState.sessionId);
  autoLog("info",`▶ Auto session started — ${QTP_QUEUE.totalSize()} totes → Zone ${config.zone} [${config.instanceCode}]`);
  await runBatch();
}
async function stopAuto(){
  autoState.running=false;autoState.paused=false;autoState.status=AUTO_STATUS.IDLE;
  await chrome.alarms.clear(ALARM.CALL);
  if(autoState.timerId){clearTimeout(autoState.timerId);autoState.timerId=null;}
  QTP_LOGGER.sessionStop(autoState.stats.called,QTP_QUEUE.totalSize(),"auto",autoState.sessionId);
  autoLog("warn",`■ Stopped. Called:${autoState.stats.called} | Remaining:${QTP_QUEUE.totalSize()}`);
  await QTP_LOGGER.flushNow();broadcastAutoState();
}
async function pauseAuto(){
  if(!autoState.running||autoState.paused) return;
  autoState.paused=true;autoState.status=AUTO_STATUS.PAUSED;
  await chrome.alarms.clear(ALARM.CALL);
  if(autoState.timerId){clearTimeout(autoState.timerId);autoState.timerId=null;}
  autoLog("warn",`⏸ Paused. ${QTP_QUEUE.totalSize()} totes remaining.`);broadcastAutoState();
}
async function resumeAuto(){
  if(!autoState.running||!autoState.paused) return;
  autoState.paused=false;autoState.status=AUTO_STATUS.RUNNING;
  autoLog("info",`▶ Resumed. ${QTP_QUEUE.totalSize()} totes remaining.`);broadcastAutoState();
  if(autoState.currentBatch.length>0&&autoState.batchIdx<autoState.currentBatch.length)autoState.timerId=setTimeout(callNextInBatch,0);
  else await runBatch();
}
async function skipCurrentAuto(){
  if(!autoState.running||!autoState.currentBatch.length) return;
  const entry=autoState.currentBatch[autoState.batchIdx];if(!entry) return;
  const zoneTag=`Zone ${autoState.config.zone}`;
  if(autoState.timerId){clearTimeout(autoState.timerId);autoState.timerId=null;}
  autoState.retryCount=0;
  autoLog("skipped",`⏭ [${entry.toteId} → ${zoneTag}] Manually skipped.`);
  QTP_LOGGER.toteSkipped(entry.toteId,zoneTag,{mode:"auto",priority:entry.priority,sessionId:autoState.sessionId});
  await QTP_STORAGE.recordCall(entry.toteId,{zone:zoneTag,mode:"auto",priority:entry.priority,condition:"skipped",sessionId:autoState.sessionId});
  autoState.stats.skipped++;autoState.batchIdx++;
  autoState.timerId=setTimeout(callNextInBatch,0);broadcastAutoState();
}

async function runBatch(){
  if(!autoState.running||autoState.paused) return;
  if(QTP_QUEUE.isEmpty()){autoState.status=AUTO_STATUS.COMPLETED;autoLog("info","✓ Queue empty — all totes processed.");await stopAuto();return;}
  const now=Date.now();
  const drift=autoState.expectedNextBatch?Math.abs(now-autoState.expectedNextBatch):0;
  const batchSize=autoState.config.batchSize||5;
  const batch=QTP_QUEUE.next(batchSize);
  if(!batch.length){autoState.status=AUTO_STATUS.COMPLETED;autoLog("info","✓ Queue drained.");await stopAuto();return;}
  autoState.currentBatch=batch;autoState.batchIdx=0;autoState.retryCount=0;autoState.stats.batchesRun++;
  const pris=[...new Set(batch.map(e=>e.priority))].join("+");
  autoLog("info",`📦 Batch ${autoState.stats.batchesRun} — ${batch.length} totes [${pris}] | ${QTP_QUEUE.totalSize()} remaining`);
  const intMins=autoState.config.batchIntervalMinutes||1;
  autoState.expectedNextBatch=now+minutesToMs(intMins);
  if(intMins>=1){const corr=Math.max(0.5,intMins-(drift/60000));await chrome.alarms.create(ALARM.CALL,{delayInMinutes:corr});}
  autoState.timerId=setTimeout(callNextInBatch,0);
}

async function callNextInBatch(){
  autoState.timerId=null;
  if(!autoState.running||autoState.paused) return;
  if(autoState.batchIdx>=autoState.currentBatch.length){
    autoLog("info",`✓ Batch ${autoState.stats.batchesRun} complete. Waiting ${autoState.config.batchIntervalMinutes||1}m…`);
    autoState.currentBatch=[];autoState.batchIdx=0;broadcastAutoState();
    const intMins=autoState.config.batchIntervalMinutes||1;
    if(intMins<1) autoState.timerId=setTimeout(runBatch,Math.max(1000,intMins*60000));
    return;
  }
  if(QTP_QUEUE.shouldPreempt()&&autoState.batchIdx>0){
    const p0n=QTP_QUEUE.snapshot().p0Count;
    QTP_LOGGER.p0Preempt(p0n);autoLog("warn",`🚨 P0 preemption — ${p0n} critical totes.`);
    for(const e of autoState.currentBatch.slice(autoState.batchIdx))QTP_QUEUE.insert(e.toteId,e.priority,e.source,{pid:e.pid,barcodeCount:e.barcodeCount});
    autoState.currentBatch=[];autoState.batchIdx=0;await runBatch();return;
  }
  const entry=autoState.currentBatch[autoState.batchIdx];
  const {host,instanceCode,zone,callInterval,retryDelay}=autoState.config;
  const zoneTag=`Zone ${zone}`;
  const cooldownMs=hoursToMs(autoState.config.cooldownHours||0);
  if(cooldownMs>0){
    const hist=await QTP_STORAGE.getCallHistory();
    const rem=QTP_UTILS.cooldownRemainingMs(entry.toteId,hist,cooldownMs);
    if(rem>0){QTP_LOGGER.toteIgnored(entry.toteId,zoneTag,rem,{mode:"auto",priority:entry.priority,sessionId:autoState.sessionId});autoLog("ignored",`🕐 [${entry.toteId} → ${zoneTag}] Cooldown — ${Math.ceil(rem/60000)}m. Skipping.`);autoState.stats.ignored++;autoState.batchIdx++;autoState.timerId=setTimeout(callNextInBatch,500);broadcastAutoState();return;}
  }
  autoLog("info",`Calling [${entry.toteId} → ${zoneTag}] (${entry.priority}|${entry.source})`);
  const result=await QTP_CALLER.callTote({host,instanceCode,toteId:entry.toteId,zone});
  if(result.condition===CONDITION.RETRY){
    autoState.retryCount++;
    if(autoState.retryCount>=LIMITS.MAX_RETRIES){autoLog("net_err",`⏭ [${entry.toteId} → ${zoneTag}] Auto-skipped after ${LIMITS.MAX_RETRIES} retries.`);QTP_LOGGER.toteAutoSkip(entry.toteId,zoneTag,LIMITS.MAX_RETRIES,{mode:"auto",priority:entry.priority,sessionId:autoState.sessionId});await QTP_STORAGE.recordCall(entry.toteId,{zone:zoneTag,mode:"auto",priority:entry.priority,condition:"skipped",sessionId:autoState.sessionId});autoState.stats.skipped++;autoState.batchIdx++;autoState.retryCount=0;autoState.timerId=setTimeout(callNextInBatch,(callInterval||5)*1000);}
    else{autoLog("net_err",`⚠ [${entry.toteId} → ${zoneTag}] ${result.rawMsg} — Retry ${autoState.retryCount}/${LIMITS.MAX_RETRIES}…`);QTP_LOGGER.toteRetry(entry.toteId,zoneTag,result.rawMsg,autoState.retryCount,{mode:"auto",sessionId:autoState.sessionId});autoState.timerId=setTimeout(callNextInBatch,(retryDelay||5)*1000);}
    broadcastAutoState();return;
  }
  autoState.retryCount=0;
  const meta=CONDITION_META[result.condition];
  const via=result.via==="tab"?" (via tab)":"";
  autoLog(meta.logLevel,`[${entry.toteId} → ${zoneTag}] [${entry.priority}] ${meta.label}${via}`);
  if(meta.logLevel==="op_ok")QTP_LOGGER.toteSuccess(entry.toteId,zoneTag,result.condition,{mode:"auto",priority:entry.priority,source:entry.source,apiMsg:result.rawMsg,sessionId:autoState.sessionId});
  else if(meta.logLevel==="op_warn")QTP_LOGGER.toteWarn(entry.toteId,zoneTag,result.condition,{mode:"auto",priority:entry.priority,source:entry.source,apiMsg:result.rawMsg,sessionId:autoState.sessionId});
  else QTP_LOGGER.toteErr(entry.toteId,zoneTag,result.condition,{mode:"auto",priority:entry.priority,source:entry.source,apiMsg:result.rawMsg,sessionId:autoState.sessionId});
  await QTP_STORAGE.recordCall(entry.toteId,{zone:zoneTag,mode:"auto",priority:entry.priority,condition:result.condition,sessionId:autoState.sessionId});
  if(result.condition===CONDITION.INSERTED||result.condition===CONDITION.RELEASED)autoState.stats.called++;
  else if(result.condition===CONDITION.ALREADY_QUEUED)autoState.stats.alreadyQueued++;
  else if(result.condition===CONDITION.NOT_AVAILABLE)autoState.stats.notAvailable++;
  autoState.batchIdx++;broadcastAutoState();
  autoState.timerId=setTimeout(callNextInBatch,(callInterval||5)*1000);
}

async function handleCallAlarm(){if(!autoState.running||autoState.paused||autoState.timerId)return;autoState.actualNextBatch=Date.now();await runBatch();}
async function recoverAutoState(){
  const saved=await QTP_STORAGE.getAutoState();
  if(!saved||!saved.running) return;
  Object.assign(autoState,{running:saved.running,paused:saved.paused,status:saved.status,stats:saved.stats||autoState.stats,sessionId:saved.sessionId,config:saved.config,log:saved.log||[],batchIdx:saved.batchIdx||0,currentBatch:saved.currentBatch||[],expectedNextBatch:saved.expectedNextBatch||null});
  autoLog("info","↻ Auto session recovered after service worker restart.");
  if(!autoState.paused){if(autoState.currentBatch.length>0&&autoState.batchIdx<autoState.currentBatch.length)autoState.timerId=setTimeout(callNextInBatch,1000);else await runBatch();}
}

export const QTP_SCHEDULER = { startAuto,stopAuto,pauseAuto,resumeAuto,skipCurrentAuto,handleCallAlarm,recoverAutoState,autoSnapshot,getAutoState:()=>autoState };
