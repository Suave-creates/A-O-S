// background/queue.js — ES module
import { QTP_CONSTANTS } from '../shared/constants.js';
import { QTP_UTILS } from '../shared/utils.js';
import { QTP_STORAGE } from './storage.js';

const { PRIORITY, LIMITS } = QTP_CONSTANTS;
const { isValidToteId, generateId } = QTP_UTILS;

const _q = { [PRIORITY.P0]:new Map(), [PRIORITY.P1]:new Map(), [PRIORITY.P2]:new Map() };
let _starvation=0, _preempt=false, _loaded=false;

function makeToteEntry(toteId,priority,source='Manual',meta={}) {
  return {toteId,priority,source,addedAt:Date.now(),pid:meta.pid||null,barcodeCount:meta.barcodeCount||null,notes:meta.notes||null,entryId:generateId()};
}
function has(toteId) { return _q[PRIORITY.P0].has(toteId)||_q[PRIORITY.P1].has(toteId)||_q[PRIORITY.P2].has(toteId); }
function totalSize() { return _q[PRIORITY.P0].size+_q[PRIORITY.P1].size+_q[PRIORITY.P2].size; }
function isEmpty() { return totalSize()===0; }
function shouldPreempt() { return _preempt&&_q[PRIORITY.P0].size>0; }

function insert(toteId,priority=PRIORITY.P2,source='Manual',meta={}) {
  if(!isValidToteId(toteId)) return 'invalid';
  if(has(toteId)) return 'duplicate';
  if(totalSize()>=LIMITS.MAX_QUEUE_SIZE) return 'full';
  const level=_q[priority]||_q[PRIORITY.P2];
  level.set(toteId,makeToteEntry(toteId,priority,source,meta));
  if(priority===PRIORITY.P0) _preempt=true;
  persistQueue();
  return 'inserted';
}
function insertMany(totes,priority=PRIORITY.P2,source='Manual') {
  const r={inserted:0,duplicates:0,invalid:0,full:0};
  for(const t of totes){const id=typeof t==='string'?t:t.toteId;const o=insert(id,priority,t.source||source,t.meta||{});r[o==='inserted'?'inserted':o==='duplicate'?'duplicates':o==='invalid'?'invalid':'full']++;}
  return r;
}
function next(batchSize=1) {
  const batch=[];
  let injectP2=false;
  if(_starvation>=LIMITS.STARVATION_THRESHOLD&&_q[PRIORITY.P2].size>0){injectP2=true;_starvation=0;}
  if(injectP2){const t=_q[PRIORITY.P2].values().next().value;if(t){batch.push(t);_q[PRIORITY.P2].delete(t.toteId);}}
  for(const lvl of [PRIORITY.P0,PRIORITY.P1,PRIORITY.P2]){
    if(batch.length>=batchSize) break;
    for(const [id,e] of _q[lvl]){if(batch.length>=batchSize) break;batch.push(e);_q[lvl].delete(id);}
  }
  const hasP2=batch.some(e=>e.priority===PRIORITY.P2);
  if(!hasP2&&batch.length>0) _starvation++; else if(hasP2) _starvation=0;
  _preempt=false;
  persistQueue();
  return batch;
}
function preempt(toteIds) { for(const id of toteIds) insert(id,PRIORITY.P0,'P0 Preemption'); _preempt=true; persistQueue(); }
function remove(toteId) { for(const lvl of Object.values(_q)){if(lvl.has(toteId)){lvl.delete(toteId);persistQueue();return true;}} return false; }
function flush(priority=null) {
  if(priority){if(_q[priority])_q[priority].clear();}
  else{_q[PRIORITY.P0].clear();_q[PRIORITY.P1].clear();_q[PRIORITY.P2].clear();_starvation=0;_preempt=false;}
  persistQueue();
}
function snapshot() {
  return {p0:[..._q[PRIORITY.P0].values()],p1:[..._q[PRIORITY.P1].values()],p2:[..._q[PRIORITY.P2].values()],total:totalSize(),p0Count:_q[PRIORITY.P0].size,p1Count:_q[PRIORITY.P1].size,p2Count:_q[PRIORITY.P2].size,starvationCounter:_starvation,preemptFlag:_preempt};
}

let _persistTimer=null;
function persistQueue() {
  if(_persistTimer) return;
  _persistTimer=setTimeout(async()=>{_persistTimer=null;await QTP_STORAGE.saveQueue({p0:[..._q[PRIORITY.P0].values()],p1:[..._q[PRIORITY.P1].values()],p2:[..._q[PRIORITY.P2].values()],starvationCounter:_starvation});},500);
}
async function loadQueue() {
  if(_loaded) return; _loaded=true;
  const saved=await QTP_STORAGE.getQueue();
  if(!saved) return;
  for(const e of saved.p0||[]) if(isValidToteId(e.toteId)) _q[PRIORITY.P0].set(e.toteId,e);
  for(const e of saved.p1||[]) if(isValidToteId(e.toteId)) _q[PRIORITY.P1].set(e.toteId,e);
  for(const e of saved.p2||[]) if(isValidToteId(e.toteId)) _q[PRIORITY.P2].set(e.toteId,e);
  _starvation=saved.starvationCounter||0;
}

export const QTP_QUEUE = { insert,insertMany,next,preempt,remove,has,isEmpty,totalSize,shouldPreempt,flush,snapshot,loadQueue };
