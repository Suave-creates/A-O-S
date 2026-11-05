// background/logger.js — ES module
import { QTP_CONSTANTS } from '../shared/constants.js';
import { QTP_UTILS } from '../shared/utils.js';
import { QTP_STORAGE } from './storage.js';

const { CONDITION_META } = QTP_CONSTANTS;
const { generateId, formatDateTime, arrayToCSV } = QTP_UTILS;

let _buf=[], _timer=null;
const FLUSH_MS=3000;

function writeLog(level,message,meta={}) {
  const entry={id:generateId(),t:Date.now(),level,message,toteId:meta.toteId||null,zone:meta.zone||null,mode:meta.mode||null,priority:meta.priority||null,source:meta.source||null,condition:meta.condition||null,retries:meta.retries||0,apiMsg:meta.apiMsg||null,sessionId:meta.sessionId||null};
  _buf.push(entry);
  if(!_timer) _timer=setTimeout(flushBuffer,FLUSH_MS);
  return entry;
}
async function flushBuffer() { _timer=null; if(!_buf.length) return; const w=[..._buf]; _buf=[]; await QTP_STORAGE.appendLogs(w); }
async function flushNow() { if(_timer){clearTimeout(_timer);_timer=null;} if(!_buf.length) return; const w=[..._buf]; _buf=[]; await QTP_STORAGE.appendLogs(w); }

const logger = {
  info:(msg,meta={})=>writeLog('info',msg,meta),
  warn:(msg,meta={})=>writeLog('warn',msg,meta),
  debug:(msg,meta={})=>writeLog('debug',msg,meta),
  netErr:(msg,meta={})=>writeLog('net_err',msg,meta),
  toteSuccess:(t,z,c,m={})=>writeLog('op_ok',`[${t} → ${z}] ${CONDITION_META[c]?.label||c}`,{toteId:t,zone:z,condition:c,...m}),
  toteWarn:(t,z,c,m={})=>writeLog('op_warn',`[${t} → ${z}] ${CONDITION_META[c]?.label||c}`,{toteId:t,zone:z,condition:c,...m}),
  toteErr:(t,z,c,m={})=>writeLog('op_err',`[${t} → ${z}] ${CONDITION_META[c]?.label||c}`,{toteId:t,zone:z,condition:c,...m}),
  toteSkipped:(t,z,m={})=>writeLog('skipped',`⏭ [${t} → ${z}] Manually skipped`,{toteId:t,zone:z,condition:'skipped',...m}),
  toteIgnored:(t,z,r,m={})=>writeLog('ignored',`🕐 [${t} → ${z}] Cooldown — ${Math.ceil(r/60000)}m remaining`,{toteId:t,zone:z,condition:'ignored_cooldown',...m}),
  toteRetry:(t,z,msg,n,m={})=>writeLog('net_err',`⚠ [${t} → ${z}] ${msg} — Retry ${n}…`,{toteId:t,zone:z,retries:n,apiMsg:msg,...m}),
  toteAutoSkip:(t,z,n,m={})=>writeLog('net_err',`⏭ [${t} → ${z}] Auto-skipped after ${n} retries`,{toteId:t,zone:z,retries:n,condition:'skipped',...m}),
  sessionStart:(total,zone,ic,mode,sid)=>writeLog('info',`▶ Session started — ${total} totes → Zone ${zone} on ${ic} [${mode.toUpperCase()}]`,{zone,mode,sessionId:sid}),
  sessionStop:(called,total,mode,sid)=>writeLog('info',`■ Stopped — ${called}/${total} [${mode.toUpperCase()}]`,{mode,sessionId:sid}),
  sessionComplete:(called,total,mode,sid)=>writeLog('info',`✓ Complete — ${called}/${total} [${mode.toUpperCase()}]`,{mode,sessionId:sid}),
  fetchStart:()=>writeLog('info','↻ Fetching tote data from Google Sheets…'),
  fetchComplete:(n,t)=>writeLog('info',`↻ Fetch complete — ${n} new totes added (${t} total in queue)`),
  fetchError:(msg,n)=>writeLog('net_err',`↻ Fetch failed (attempt ${n}): ${msg}`),
  p0Preempt:(n)=>writeLog('warn',`🚨 P0 preemption — ${n} critical tote(s) moved to front`),
  queueEmpty:()=>writeLog('info','Queue empty — waiting for next fetch'),
  starvationRelief:(t)=>writeLog('info',`⚖ Starvation relief — P2 tote ${t} injected`),
  flushNow, writeLog,
};

async function searchLogs(filters={}) {
  await flushNow();
  let logs=await QTP_STORAGE.getLogs();
  if(filters.toteId)    logs=logs.filter(e=>e.toteId===filters.toteId);
  if(filters.level)     logs=logs.filter(e=>e.level===filters.level);
  if(filters.mode)      logs=logs.filter(e=>e.mode===filters.mode);
  if(filters.condition) logs=logs.filter(e=>e.condition===filters.condition);
  if(filters.sessionId) logs=logs.filter(e=>e.sessionId===filters.sessionId);
  if(filters.from)      logs=logs.filter(e=>e.t>=filters.from);
  if(filters.to)        logs=logs.filter(e=>e.t<=filters.to);
  if(filters.query){const q=filters.query.toLowerCase();logs=logs.filter(e=>(e.message&&e.message.toLowerCase().includes(q))||(e.toteId&&e.toteId.toLowerCase().includes(q)));}
  return logs.slice(-(filters.limit||200)).reverse();
}
async function exportLogsCSV() {
  await flushNow(); const logs=await QTP_STORAGE.getLogs();
  const hdr=["ID","Timestamp","Level","Message","Tote ID","Zone","Mode","Priority","Source","Condition","Retries","API Message","Session ID"];
  const rows=logs.map(e=>[e.id,formatDateTime(e.t),e.level,e.message,e.toteId||'',e.zone||'',e.mode||'',e.priority||'',e.source||'',e.condition||'',e.retries||0,e.apiMsg||'',e.sessionId||'']);
  return arrayToCSV([hdr,...rows]);
}
async function exportLogsJSON() {
  await flushNow(); const logs=await QTP_STORAGE.getLogs();
  return {exportedAt:new Date().toISOString(),totalEntries:logs.length,entries:logs.map(e=>({...e,timestampHuman:formatDateTime(e.t)}))};
}
async function getSessionSummary(sessionId) {
  await flushNow(); const logs=await QTP_STORAGE.getLogs();
  const s=sessionId?logs.filter(e=>e.sessionId===sessionId):logs;
  return {total:s.filter(e=>e.toteId&&e.condition).length,inserted:s.filter(e=>e.condition==='inserted').length,released:s.filter(e=>e.condition==='released').length,alreadyQueued:s.filter(e=>e.condition==='already_queued').length,notAvailable:s.filter(e=>e.condition==='not_available').length,skipped:s.filter(e=>e.condition==='skipped').length,ignored:s.filter(e=>e.condition==='ignored_cooldown').length,errors:s.filter(e=>e.level==='net_err').length};
}

export const QTP_LOGGER = {...logger,searchLogs,exportLogsCSV,exportLogsJSON,getSessionSummary,getLogs:QTP_STORAGE.getLogs,clearLogs:QTP_STORAGE.clearLogs,pruneLogs:QTP_STORAGE.pruneLogs};
