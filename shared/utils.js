// shared/utils.js — plain script for UI
const QTP_UTILS = {
  isValidToteId(id) { return !!id && typeof id==='string' && QTP_CONSTANTS.TOTE_ID_REGEX.test(id.trim()); },
  parseToteList(raw) {
    if (!raw) return [];
    return raw.split(/[\s,;\n\r\t]+/).map(s=>s.trim().toUpperCase()).filter(id=>QTP_UTILS.isValidToteId(id));
  },
  isInCooldown(toteId, callHistory, cooldownMs) {
    if (!cooldownMs||cooldownMs<=0) return false;
    const e=callHistory&&callHistory[toteId];
    if (!e||!e.lastCalled) return false;
    return (Date.now()-e.lastCalled)<cooldownMs;
  },
  cooldownRemainingMs(toteId, callHistory, cooldownMs) {
    if (!QTP_UTILS.isInCooldown(toteId,callHistory,cooldownMs)) return 0;
    return callHistory[toteId].lastCalled+cooldownMs-Date.now();
  },
  formatTime(ts)     { return new Date(ts).toLocaleTimeString(); },
  formatDateTime(ts) { return new Date(ts).toLocaleString(); },
  formatDuration(ms) {
    if(ms<=0) return "0s";
    const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
    const p=[];if(h>0)p.push(h+"h");if(m>0)p.push(m+"m");if(sec>0||!p.length)p.push(sec+"s");return p.join(" ");
  },
  hoursToMs(h)   { return h*60*60*1000; },
  minutesToMs(m) { return m*60*1000; },
  escapeCSVCell(v) {
    const s=v==null?"":String(v);
    return (s.includes(",")||s.includes('"')||s.includes("\n"))?'"'+s.replace(/"/g,'""')+'"':s;
  },
  generateId() { return Date.now().toString(36)+Math.random().toString(36).slice(2,7); },
  clamp(v,mn,mx) { return Math.min(Math.max(v,mn),mx); },
};
