// background/storage.js — ES module
import { QTP_CONSTANTS } from '../shared/constants.js';
import { QTP_UTILS } from '../shared/utils.js';

const { STORE, DEFAULTS, LIMITS } = QTP_CONSTANTS;

function validateConfig(c) {
  if (!c||typeof c!=='object') return null;
  return {
    host:c.host||DEFAULTS.HOST, zone:c.zone||DEFAULTS.ZONE,
    instanceCode:c.instanceCode||DEFAULTS.INSTANCE_CODE,
    callInterval:Number(c.callInterval)||DEFAULTS.CALL_INTERVAL,
    retryDelay:Number(c.retryDelay)||DEFAULTS.RETRY_DELAY,
    batchSize:Number(c.batchSize)||DEFAULTS.BATCH_SIZE,
    fetchInterval:Number(c.fetchInterval)||DEFAULTS.FETCH_INTERVAL,
    cooldownHours:c.cooldownHours!==undefined?Number(c.cooldownHours):DEFAULTS.COOLDOWN_HOURS,
    sheetUrl:c.sheetUrl||DEFAULTS.SHEET_URL,
    mode:c.mode||'manual',
    starvationThreshold:Number(c.starvationThreshold)||LIMITS.STARVATION_THRESHOLD,
  };
}
function validateQueue(q) {
  if(!q||typeof q!=='object') return {p0:[],p1:[],p2:[],starvationCounter:0};
  return {p0:Array.isArray(q.p0)?q.p0:[],p1:Array.isArray(q.p1)?q.p1:[],p2:Array.isArray(q.p2)?q.p2:[],starvationCounter:Number(q.starvationCounter)||0};
}
function validateAutoState(s) {
  if(!s||typeof s!=='object') return {running:false,paused:false,status:'idle',lastFetch:null,nextCall:null,fetchErrors:0,sessionId:null,sessionStats:{called:0,skipped:0,ignored:0,errors:0,alreadyQueued:0,notAvailable:0}};
  return {running:!!s.running,paused:!!s.paused,status:s.status||'idle',lastFetch:s.lastFetch||null,nextCall:s.nextCall||null,fetchErrors:Number(s.fetchErrors)||0,sessionId:s.sessionId||null,sessionStats:s.sessionStats||{called:0,skipped:0,ignored:0,errors:0,alreadyQueued:0,notAvailable:0}};
}
async function getConfig() { const {config}=await chrome.storage.local.get(STORE.CONFIG); return validateConfig(config)||validateConfig({}); }
async function saveConfig(u) { const e=await getConfig(); const m={...e,...u}; await chrome.storage.local.set({[STORE.CONFIG]:validateConfig(m)}); return m; }
async function getQueue() { const {queue}=await chrome.storage.local.get(STORE.QUEUE); return validateQueue(queue); }
async function saveQueue(q) { await chrome.storage.local.set({[STORE.QUEUE]:validateQueue(q)}); }
async function getCallHistory() { const {callHistory}=await chrome.storage.local.get(STORE.CALL_HISTORY); return callHistory&&typeof callHistory==='object'?callHistory:{}; }
async function recordCall(toteId,{zone,mode,priority,condition,sessionId}) {
  const h=await getCallHistory(); const e=h[toteId]||{count:0};
  h[toteId]={lastCalled:Date.now(),zone:zone||'',mode:mode||'manual',priority:priority||null,condition:condition||'',sessionId:sessionId||null,count:(e.count||0)+1};
  await chrome.storage.local.set({[STORE.CALL_HISTORY]:h});
}
async function pruneCallHistory() {
  const h=await getCallHistory(); const cut=Date.now()-86400000; const p={};
  for(const [id,e] of Object.entries(h)) if(e.lastCalled>=cut) p[id]=e;
  await chrome.storage.local.set({[STORE.CALL_HISTORY]:p}); return p;
}
async function getLogs() { const {logs}=await chrome.storage.local.get(STORE.LOGS); return Array.isArray(logs)?logs:[]; }
async function appendLogs(entries) {
  if(!entries||!entries.length) return;
  const logs=await getLogs(); const merged=[...logs,...entries];
  await chrome.storage.local.set({[STORE.LOGS]:merged.length>LIMITS.MAX_LOG_ENTRIES?merged.slice(-LIMITS.MAX_LOG_ENTRIES):merged});
}
async function clearLogs() { await chrome.storage.local.set({[STORE.LOGS]:[]}); }
async function pruneLogs() { const logs=await getLogs(); const cut=Date.now()-86400000; const f=logs.filter(e=>e.t>=cut); await chrome.storage.local.set({[STORE.LOGS]:f}); return f; }
async function getAutoState() { const {autoState}=await chrome.storage.local.get(STORE.AUTO_STATE); return validateAutoState(autoState); }
async function saveAutoState(u) { const e=await getAutoState(); const m={...e,...u}; await chrome.storage.local.set({[STORE.AUTO_STATE]:m}); return m; }
async function getRunState() { const {runState}=await chrome.storage.local.get(STORE.RUN_STATE); return runState||null; }
async function saveRunState(s) { await chrome.storage.local.set({[STORE.RUN_STATE]:s}); }
async function resetSession() { await chrome.storage.local.remove([STORE.QUEUE,STORE.AUTO_STATE,STORE.RUN_STATE]); }

export const QTP_STORAGE = { getConfig,saveConfig,getQueue,saveQueue,getCallHistory,recordCall,pruneCallHistory,getLogs,appendLogs,clearLogs,pruneLogs,getAutoState,saveAutoState,getRunState,saveRunState,resetSession };
