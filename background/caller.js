// background/caller.js — ES module
import { QTP_CONSTANTS } from '../shared/constants.js';
import { QTP_UTILS } from '../shared/utils.js';

const { CONDITION } = QTP_CONSTANTS;
const { looksLikeJWT, stripBearer, getSubFromJWT, isJWTExpired } = QTP_UTILS;

async function getJWT(host) {
  const names=["Authorization","authorization","token","access_token","jwt","auth_token","id_token","JWT"];
  try {
    const all=await chrome.cookies.getAll({url:host});
    for(const c of all) if(names.includes(c.name)&&looksLikeJWT(c.value)) return stripBearer(c.value);
    for(const c of all) if(looksLikeJWT(c.value)) return stripBearer(c.value);
  } catch(e){}
  try {
    const u=new URL(host); const tabs=await chrome.tabs.query({url:`${u.protocol}//${u.host}/*`});
    for(const tab of tabs) {
      const res=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
        const keys=["Authorization","authorization","token","access_token","jwt","auth_token","id_token","JWT"];
        const scan=s=>{for(const k of keys){const v=s.getItem(k);if(v)return v;} for(let i=0;i<s.length;i++){const v=s.getItem(s.key(i));if(v&&/^(Bearer\s+)?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.trim()))return v;} return null;};
        return scan(localStorage)||scan(sessionStorage);
      }});
      for(const r of res||[]) if(r.result&&looksLikeJWT(r.result)) return stripBearer(r.result);
    }
  } catch(e){}
  return null;
}

async function checkAuth(host) {
  const jwt=await getJWT(host);
  if(!jwt) return {ok:false,reason:"no token"};
  if(isJWTExpired(jwt)) return {ok:false,reason:"expired"};
  return {ok:true,sub:getSubFromJWT(jwt)};
}

async function callTote({host,instanceCode,toteId,zone}) {
  const jwt=await getJWT(host);
  if(!jwt) return {condition:CONDITION.RETRY,rawMsg:"No JWT — ensure you are logged in",via:null,authError:true};
  const url=`${host}/quadron/dashboard/pull-crate`;
  const headers={"Accept":"application/json, text/plain, */*","Authorization":`Bearer ${jwt}`,"Content-Type":"application/json","Cache-Control":"no-cache, no-store, must-revalidate, pre-check=0","Pragma":"no-cache","Expires":"0","X-User-Info-Name":getSubFromJWT(jwt)||"","idempotency-key":"key-"+Date.now(),"instanceCode":instanceCode};
  const body=JSON.stringify({container:toteId,station:String(zone)});
  try {
    const resp=await fetch(url,{method:"POST",headers,body,credentials:"include"});
    let data=null; try{data=await resp.json();}catch(e){}
    return {...classifyApiResult({status:resp.status,ok:resp.ok,data}),via:"sw"};
  } catch(err) {
    try { return {...await fetchViaTab(host,url,headers,body),via:"tab"}; }
    catch(te) { return {condition:CONDITION.RETRY,rawMsg:(err.message||String(err))+" | tab: "+(te.message||String(te)),via:"tab_failed"}; }
  }
}

async function fetchViaTab(host,url,headers,body) {
  const u=new URL(host); const tabs=await chrome.tabs.query({url:`${u.protocol}//${u.host}/*`});
  if(!tabs||!tabs.length) throw new Error(`No open tab on ${u.host}. Open the Quadron site.`);
  const res=await chrome.scripting.executeScript({target:{tabId:tabs[0].id},world:"MAIN",args:[url,headers,body],func:async(url,headers,body)=>{
    try{const r=await fetch(url,{method:"POST",headers,body,credentials:"include"});let data=null;try{data=await r.json();}catch(e){}return{ok:r.ok,status:r.status,data};}catch(e){return{ok:false,status:0,error:e.message||String(e)};}
  }});
  const r=res&&res[0]&&res[0].result;
  if(!r) throw new Error("Tab relay returned no result.");
  if(r.error) throw new Error(r.error);
  return r;
}

function classifyApiResult(result) {
  if(!result) return {condition:CONDITION.RETRY,rawMsg:"No response"};
  const raw=(result.data&&(result.data.message||result.data.error))||"";
  const lower=raw.toLowerCase(); const rawMsg=raw||`HTTP ${result.status}`;
  if(result.ok&&result.data&&result.data.success) return {condition:CONDITION.INSERTED,rawMsg};
  if(lower.includes("already in the queue")||lower.includes("already in queue")||lower.includes("in movement")||lower.includes("is in movement")||lower.includes("container is in movement")) return {condition:CONDITION.ALREADY_QUEUED,rawMsg};
  if(lower.includes("released from quadron")||lower.includes("released")) return {condition:CONDITION.RELEASED,rawMsg};
  if(lower.includes("not available")||lower.includes("not found")||lower.includes("does not exist")||lower.includes("no data")||result.status===404||!result.data||lower==="") return {condition:CONDITION.NOT_AVAILABLE,rawMsg};
  return {condition:CONDITION.RETRY,rawMsg};
}

export const QTP_CALLER = { getJWT, checkAuth, callTote, classifyApiResult };
