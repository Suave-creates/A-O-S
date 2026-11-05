// shared/constants.js — plain script for UI
const QTP_CONSTANTS = {
  PRIORITY: { P0:"P0", P1:"P1", P2:"P2", MANUAL:"MANUAL" },
  PRIORITY_WEIGHT: { P0:100, P1:50, P2:10, MANUAL:5 },
  CONDITION: {
    INSERTED:"inserted", RELEASED:"released",
    ALREADY_QUEUED:"already_queued", NOT_AVAILABLE:"not_available",
    SKIPPED:"skipped", IGNORED:"ignored_cooldown", RETRY:"retry",
  },
  CONDITION_META: {
    inserted:       { label:"Inserted into Queue",            logLevel:"op_ok",   color:"green",  move:true,  countAsDone:true,  isOp:true  },
    released:       { label:"Released from Quadron",          logLevel:"op_ok",   color:"green",  move:true,  countAsDone:true,  isOp:true  },
    already_queued: { label:"Already in Queue / In Movement", logLevel:"op_warn", color:"yellow", move:true,  countAsDone:false, isOp:true  },
    not_available:  { label:"Not Available",                  logLevel:"op_err",  color:"red",    move:true,  countAsDone:false, isOp:true  },
    skipped:        { label:"Manually Skipped",               logLevel:"skipped", color:"muted",  move:true,  countAsDone:false, isOp:false },
    ignored_cooldown:{ label:"Ignored (Cooldown)",            logLevel:"ignored", color:"blue",   move:true,  countAsDone:false, isOp:false },
  },
  MODE:        { MANUAL:"manual", AUTO:"auto" },
  AUTO_STATUS: { IDLE:"idle", FETCHING:"fetching", RUNNING:"running", PAUSED:"paused", ERROR:"error", COMPLETED:"completed" },
  ALARM:       { FETCH:"qtp-fetch", CALL:"qtp-call" },
  STORE:       { CONFIG:"config", QUEUE:"queue", CALL_HISTORY:"callHistory", LOGS:"logs", AUTO_STATE:"autoState", RUN_STATE:"runState" },
  LIMITS:      { MAX_LOG_ENTRIES:5000, MAX_QUEUE_SIZE:2000, MAX_RETRIES:5, MIN_CALL_INTERVAL:3, MIN_FETCH_INTERVAL:60, STARVATION_THRESHOLD:10 },
  DEFAULTS:    { HOST:"https://192.168.24.230", ZONE:"", INSTANCE_CODE:"LK-069", CALL_INTERVAL:5, RETRY_DELAY:5, BATCH_SIZE:5, FETCH_INTERVAL:2, COOLDOWN_HOURS:1, SHEET_URL:"" },
  TOTE_ID_REGEX: /^(TL|TS)[0-9]{10}$/,
};
