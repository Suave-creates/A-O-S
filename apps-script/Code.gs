// ═══════════════════════════════════════════════════════════════════════════
// QUADRON TOTE PULLER — Google Apps Script v3.1
// Single-pass architecture + Kill Switch
// ═══════════════════════════════════════════════════════════════════════════

var SHEETS = {
  ASRS_DUMP:      "ASRS Dump",
  LOCKED_DUMP:    "Locked Tote Dump",
  PID_INTEL:      "PID Intelligence",
  PRIORITY_QUEUE: "Priority Queue",
  CALL_HISTORY:   "Call History",
  CONFIG:         "Config",
};

var PROPS = {
  LAST_PROCESSED: "last_processed",
  LOCKED_COUNT:   "locked_count",
  QUEUE_COUNT:    "queue_count",
  ASRS_ROWS:      "asrs_rows",
  PID_COUNT:      "pid_count",
  ELAPSED_SEC:    "elapsed_sec",
};

var DEFAULT_P0_MAX_TOTES = 1;
var DEFAULT_P1_MAX_TOTES = 3;
var SHARED_SECRET = "";

// ═══════════════════════════════════════════════════════════════════════════
// HTTP ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════════════

function doGet(e) {
  try {
    if (!authenticate(e)) return errorResponse("Unauthorised");
    var action = (e.parameter && e.parameter.action) || "getQueue";
    switch (action) {
      case "getQueue":       return jsonResponse(getQueue());
      case "getStatus":      return jsonResponse(getStatus());
      case "getConfig":      return jsonResponse(getConfigData());
      case "processQueue":   return jsonResponse(processQueue());
      case "getAsrsDump":    return jsonResponse(getAsrsDump());
      case "ping":           return jsonResponse({ ok:true, ts:new Date().toISOString() });
      default:               return errorResponse("Unknown action: " + action);
    }
  } catch(err) { return errorResponse(err.message || String(err)); }
}

function doPost(e) {
  try {
    if (!authenticate(e)) return errorResponse("Unauthorised");
    var body   = JSON.parse(e.postData.contents);
    var action = body.action;
    switch (action) {
      case "logCall":          return jsonResponse(logCall(body));
      case "logBatch":         return jsonResponse(logBatch(body));
      case "markDone":         return jsonResponse(markDone(body));
      case "processWithTotes": return jsonResponse(processWithTotes(body));
      default:                 return errorResponse("Unknown action: " + action);
    }
  } catch(err) { return errorResponse(err.message || String(err)); }
}

// ═══════════════════════════════════════════════════════════════════════════
// KILL SWITCH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * isKillSwitchOn — reads the kill_switch value from Config.
 * Returns true if the value is "ON" (case-insensitive).
 * When ON, getQueue() returns an empty list so the extension calls nothing.
 */
function isKillSwitchOn() {
  var cfg = loadConfig();
  return String(cfg["kill_switch"] || "OFF").trim().toUpperCase() === "ON";
}

/**
 * setKillSwitch — sets the kill_switch value in the Config sheet.
 * Also colours the row red (ON) or green (OFF) for visibility.
 * @param {boolean} on
 */
function setKillSwitch(on) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CONFIG);
  if (!sheet) { createDefaultConfig(ss); sheet = ss.getSheetByName(SHEETS.CONFIG); }

  var data   = sheet.getDataRange().getValues();
  var target = "kill_switch";

  for (var i = 1; i < data.length; i++) {
    var key = String(data[i][0] || "").trim().toLowerCase();
    if (key === target) {
      var row    = i + 1;
      var cell   = sheet.getRange(row, 2);
      cell.setValue(on ? "ON" : "OFF");
      // Colour the entire row to make kill switch state obvious
      var rowRange = sheet.getRange(row, 1, 1, 3);
      if (on) {
        rowRange.setBackground("#FEE2E2").setFontColor("#991B1B").setFontWeight("bold");
      } else {
        rowRange.setBackground("#DCFCE7").setFontColor("#166534").setFontWeight("normal");
      }
      return;
    }
  }
  // Not found — append it
  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1, 1, 3).setValues([[
    "kill_switch", on ? "ON" : "OFF", "Set to ON to immediately halt all tote serving"
  ]]);
  if (on) {
    sheet.getRange(newRow, 1, 1, 3).setBackground("#FEE2E2").setFontColor("#991B1B").setFontWeight("bold");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVE — fast read for extension polling (every 2 min)
// ═══════════════════════════════════════════════════════════════════════════

function getQueue() {
  // ── Kill switch check ────────────────────────────────────────────────────
  // This is the FIRST thing we check. If ON, return empty immediately.
  if (isKillSwitchOn()) {
    return {
      ok:        true,
      toteQueue: [],
      priorityTotes: [],
      totals:    { queue:0, combined:0 },
      killed:    true,
      warning:   "🛑 KILL SWITCH IS ON — tote serving halted. Go to Config sheet to resume.",
      meta:      getStatusMeta(),
    };
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PRIORITY_QUEUE);

  if (!sheet || sheet.getLastRow() < 2) {
    return {
      ok:true, toteQueue:[], priorityTotes:[], totals:{queue:0,combined:0},
      meta:getStatusMeta(),
      warning:"Priority Queue is empty. Paste locked totes and click QTP → Process Queue.",
    };
  }

  var data  = sheet.getRange(2, 1, sheet.getLastRow()-1, 10).getValues();
  var totes = [];

  for (var i = 0; i < data.length; i++) {
    var toteId = String(data[i][0]||"").trim().toUpperCase();
    var status = String(data[i][8]||"").trim().toLowerCase();
    if (!isValidToteId(toteId)) continue;
    if (status==="done"||status==="ignore"||status==="skip") continue;
    totes.push({
      toteId:       toteId,
      priority:     String(data[i][1]||"P2").trim().toUpperCase(),
      pid:          String(data[i][2]||"").trim(),
      totalBarcodes:parseInt(data[i][3])||0,
      toteCount:    parseInt(data[i][4])||0,
      partitions:   String(data[i][5]||"").trim(),
      source:       String(data[i][6]||"").trim(),
      reason:       String(data[i][7]||"").trim(),
      status:       status,
    });
  }

  return {
    ok:true, toteQueue:totes, priorityTotes:[],
    totals:{ queue:totes.length, combined:totes.length },
    meta:getStatusMeta(), fetchedAt:new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS QUEUE — single-pass engine (~20-35 sec, runs 4-5x per day)
// ═══════════════════════════════════════════════════════════════════════════

function processQueue() {
  var startTime = new Date().getTime();
  var ss        = SpreadsheetApp.getActiveSpreadsheet();

  // ── 1. Read Locked Tote Dump ──────────────────────────────────────────────
  var lockedSheet = ss.getSheetByName(SHEETS.LOCKED_DUMP);
  if (!lockedSheet || lockedSheet.getLastRow() < 2)
    return { ok:false, reason:"Locked Tote Dump is empty. Paste the locked tote export first." };

  var lockedData = lockedSheet.getDataRange().getValues();
  var lockedHdr  = normaliseHeaders(lockedData[0]);
  var toteColIdx = findColumnIndex(lockedHdr, ["container","tote id","toteid","tote","location"]);

  var lockedToteIds = Object.create(null);
  var lockedToteRows = [];
  var seenLocked = Object.create(null);

  for (var r = 1; r < lockedData.length; r++) {
    var rawId = toteColIdx >= 0 ? String(lockedData[r][toteColIdx]||"").trim() : "";
    if (!rawId) {
      for (var col = 0; col < lockedData[r].length; col++) {
        var cell = String(lockedData[r][col]||"").trim();
        if (cell.toUpperCase().match(/(TL|TS)/)) { rawId = cell; break; }
      }
    }
    var toteId   = extractToteId(rawId);
    var partition = extractPartition(rawId);
    if (!toteId || seenLocked[toteId]) continue;
    seenLocked[toteId] = true;
    lockedToteIds[toteId] = true;
    lockedToteRows.push({ toteId:toteId, partition:partition });
  }

  if (!lockedToteRows.length)
    return { ok:false, reason:"No valid tote IDs found in Locked Tote Dump." };

  // ── 2. Read ASRS Dump (single bulk read) ──────────────────────────────────
  var asrsSheet = ss.getSheetByName(SHEETS.ASRS_DUMP);
  if (!asrsSheet || asrsSheet.getLastRow() < 2)
    return { ok:false, reason:"ASRS Dump is empty. Paste the ASRS tote export first." };

  var asrsHeaders = normaliseHeaders(
    asrsSheet.getRange(1, 1, 1, asrsSheet.getLastColumn()).getValues()[0]
  );
  var pidCol     = findColumnIndex(asrsHeaders, ["pid"]);
  var locCol     = findColumnIndex(asrsHeaders, ["location"]);
  var barcodeCol = findColumnIndex(asrsHeaders, ["barcode_count","barcode count","barcodes"]);
  if (pidCol < 0)     pidCol = 0;
  if (locCol < 0)     locCol = 1;
  if (barcodeCol < 0) barcodeCol = 2;

  var asrsRowCount = asrsSheet.getLastRow() - 1;
  var asrsData     = asrsSheet.getRange(2, 1, asrsRowCount, asrsSheet.getLastColumn()).getValues();

  // ── 3. Build PID + tote maps in one pass ──────────────────────────────────
  var pidMap  = Object.create(null);
  var toteMap = Object.create(null);

  for (var i = 0; i < asrsData.length; i++) {
    var row      = asrsData[i];
    var pid      = String(row[pidCol]||"").trim();
    var location = String(row[locCol]||"").trim();
    var barcodes = parseInt(row[barcodeCol]) || 0;
    if (!pid || !location) continue;
    var parsed = parseToteFromLocation(location);
    if (!parsed) continue;
    var tId = parsed.toteId;

    if (!pidMap[pid]) pidMap[pid] = { totes:Object.create(null), totalBarcodes:0, partitionCount:0 };
    pidMap[pid].totes[tId] = true;
    pidMap[pid].totalBarcodes += barcodes;
    pidMap[pid].partitionCount++;

    if (lockedToteIds[tId]) {
      if (!toteMap[tId]) toteMap[tId] = Object.create(null);
      toteMap[tId][pid] = true;
    }
  }

  // ── 4. Assign priority per locked tote ───────────────────────────────────
  var cfg   = loadConfig();
  var p0Max = parseInt(cfg["p0_max_totes"] || DEFAULT_P0_MAX_TOTES);
  var p1Max = parseInt(cfg["p1_max_totes"] || DEFAULT_P1_MAX_TOTES);

  var outputRows = [[
    "Tote ID","Priority","PID(s)","Total Barcodes",
    "Totes Available for PID","Partition","Source","Priority Reason","Status","Processed At",
  ]];
  var intelRows = [["PID","Unique Totes","Partitions","Total Barcodes","Tote IDs","Priority Level"]];
  var intelPIDsSeen = Object.create(null);
  var stats = { p0:0, p1:0, p2:0, noPID:0, total:0 };

  for (var L = 0; L < lockedToteRows.length; L++) {
    var locked  = lockedToteRows[L];
    var pids    = toteMap[locked.toteId];
    var pidList = pids ? Object.keys(pids) : [];

    if (!pidList.length) {
      outputRows.push([locked.toteId,"P2","Not in ASRS",0,0,locked.partition,SHEETS.LOCKED_DUMP,"Tote not in ASRS — defaulting to P2","",now()]);
      stats.noPID++; stats.p2++; stats.total++;
      continue;
    }

    var worstToteCount = Infinity;
    var worstPID       = "";
    var totalBarcodes  = 0;
    var allPIDLabels   = [];

    for (var p = 0; p < pidList.length; p++) {
      var thisPID   = pidList[p];
      var intel     = pidMap[thisPID];
      var toteCount = intel ? Object.keys(intel.totes).length : 0;
      totalBarcodes += intel ? intel.totalBarcodes : 0;
      allPIDLabels.push(thisPID + " (" + toteCount + " totes)");
      if (toteCount < worstToteCount) { worstToteCount = toteCount; worstPID = thisPID; }

      if (!intelPIDsSeen[thisPID] && intel) {
        intelPIDsSeen[thisPID] = true;
        var toteIds = Object.keys(intel.totes);
        intelRows.push([thisPID, toteIds.length, intel.partitionCount, intel.totalBarcodes, toteIds.join(", "), assignPriority(toteIds.length, p0Max, p1Max)]);
      }
    }

    var priority = assignPriority(worstToteCount, p0Max, p1Max);
    var reason   = pidList.length === 1
      ? "PID " + worstPID + " has " + worstToteCount + " tote(s) in ASRS"
      : pidList.length + " PIDs — worst: PID " + worstPID + " → " + worstToteCount + " tote(s)";

    outputRows.push([locked.toteId, priority, allPIDLabels.join(", "), totalBarcodes, worstToteCount, locked.partition, SHEETS.LOCKED_DUMP, reason, "", now()]);
    stats[priority.toLowerCase()]++;
    stats.total++;
  }

  // ── 5. Write Priority Queue ───────────────────────────────────────────────
  var queueSheet = ss.getSheetByName(SHEETS.PRIORITY_QUEUE) || ss.insertSheet(SHEETS.PRIORITY_QUEUE);
  queueSheet.clearContents();
  if (outputRows.length > 0) {
    queueSheet.getRange(1, 1, outputRows.length, outputRows[0].length).setValues(outputRows);
    queueSheet.getRange(1, 1, 1, outputRows[0].length).setFontWeight("bold").setBackground("#1E293B").setFontColor("#FFFFFF");
    queueSheet.setFrozenRows(1);
    colourPriorityRows(queueSheet, outputRows);
  }

  // ── 6. Write PID Intelligence (visibility/audit tab) ─────────────────────
  if (intelRows.length > 1) {
    var intelSheet = ss.getSheetByName(SHEETS.PID_INTEL) || ss.insertSheet(SHEETS.PID_INTEL);
    intelSheet.clearContents();
    intelSheet.getRange(1, 1, intelRows.length, 6).setValues(intelRows);
    intelSheet.getRange(1, 1, 1, 6).setFontWeight("bold").setBackground("#1E293B").setFontColor("#FFFFFF");
    intelSheet.setFrozenRows(1);
  }

  // ── 7. Save metadata ──────────────────────────────────────────────────────
  var elapsed = Math.round((new Date().getTime() - startTime) / 1000);
  var props   = PropertiesService.getScriptProperties();
  props.setProperties({
    [PROPS.LAST_PROCESSED]: new Date().toISOString(),
    [PROPS.LOCKED_COUNT]:   String(lockedToteRows.length),
    [PROPS.QUEUE_COUNT]:    String(outputRows.length - 1),
    [PROPS.ASRS_ROWS]:      String(asrsRowCount),
    [PROPS.PID_COUNT]:      String(intelRows.length - 1),
    [PROPS.ELAPSED_SEC]:    String(elapsed),
  });

  return {
    ok:true, action:"processQueue",
    lockedTotes:  lockedToteRows.length,
    asrsRows:     asrsRowCount,
    pidsAnalysed: intelRows.length - 1,
    queueBuilt:   outputRows.length - 1,
    p0Count:      stats.p0,
    p1Count:      stats.p1,
    p2Count:      stats.p2,
    noPIDFound:   stats.noPID,
    elapsedSec:   elapsed,
    processedAt:  new Date().toISOString(),
    message: "Queue built: "+(outputRows.length-1)+" totes (P0:"+stats.p0+" P1:"+stats.p1+" P2:"+stats.p2+") in "+elapsed+"s",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════════════════

function getStatus() { return { ok:true, killed:isKillSwitchOn(), ...getStatusMeta() }; }

function getStatusMeta() {
  var props = PropertiesService.getScriptProperties();
  return {
    lastProcessed: props.getProperty(PROPS.LAST_PROCESSED) || null,
    lockedTotes:   props.getProperty(PROPS.LOCKED_COUNT)   || "0",
    queueTotes:    props.getProperty(PROPS.QUEUE_COUNT)    || "0",
    asrsRows:      props.getProperty(PROPS.ASRS_ROWS)      || "0",
    pidsAnalysed:  props.getProperty(PROPS.PID_COUNT)      || "0",
    elapsedSec:    props.getProperty(PROPS.ELAPSED_SEC)    || "0",
    killSwitch:    isKillSwitchOn() ? "ON" : "OFF",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// WRITE-BACK
// ═══════════════════════════════════════════════════════════════════════════

function logCall(body) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEETS.CALL_HISTORY,
    ["Tote ID","Zone","Status","Priority","Mode","Source","API Message","Timestamp","Session ID"]);
  sheet.appendRow([body.toteId||"",body.zone||"",body.status||"",body.priority||"",body.mode||"auto",body.source||"",body.apiMessage||"",
    Utilities.formatDate(new Date(),Session.getScriptTimeZone(),"dd/MM/yyyy HH:mm:ss"),body.sessionId||""]);
  return { ok:true };
}

function logBatch(body) {
  if (!body.entries || !body.entries.length) return { ok:true, written:0 };
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEETS.CALL_HISTORY,
    ["Tote ID","Zone","Status","Priority","Mode","Source","API Message","Timestamp","Session ID"]);
  var rows = body.entries.map(function(e) {
    return [e.toteId||"",e.zone||"",e.status||"",e.priority||"",e.mode||"auto",e.source||"",e.apiMessage||"",
      Utilities.formatDate(new Date(),Session.getScriptTimeZone(),"dd/MM/yyyy HH:mm:ss"),e.sessionId||""];
  });
  sheet.getRange(sheet.getLastRow()+1, 1, rows.length, 9).setValues(rows);
  return { ok:true, written:rows.length };
}

function markDone(body) {
  if (!body.toteId) return { ok:false, reason:"No toteId" };
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PRIORITY_QUEUE);
  if (!sheet || sheet.getLastRow() < 2) return { ok:true, marked:0 };
  var data   = sheet.getRange(2, 1, sheet.getLastRow()-1, 9).getValues();
  var marked = 0;
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === body.toteId.toUpperCase()) {
      sheet.getRange(i+2, 9).setValue(body.status || "Done");
      marked++;
    }
  }
  return { ok:true, marked:marked };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

function getConfigData() { return { ok:true, config:loadConfig() }; }

function loadConfig() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CONFIG);
  if (!sheet) return createDefaultConfig(ss);
  var data   = sheet.getDataRange().getValues();
  var config = {};
  for (var i = 1; i < data.length; i++) {
    var key = String(data[i][0]||"").trim().toLowerCase().replace(/\s+/g,"_");
    var val = String(data[i][1]||"").trim();
    if (key) config[key] = val;
  }
  return config;
}

function createDefaultConfig(ss) {
  var sheet = ss.getSheetByName(SHEETS.CONFIG) || ss.insertSheet(SHEETS.CONFIG);
  sheet.clearContents();
  var rows = [
    ["Key","Value","Description"],
    ["kill_switch",           "OFF",   "🛑 Set to ON to immediately halt all tote serving"],
    ["cooldown_minutes",      "60",    "Minutes before a called tote can be re-queued (0=off)"],
    ["batch_size",            "5",     "Totes per batch in auto mode"],
    ["batch_interval_minutes","1",     "Minutes between batches"],
    ["call_interval_seconds", "5",     "Seconds between individual tote calls"],
    ["p0_max_totes",          "1",     "PIDs with ≤ this many totes → P0 (Critical)"],
    ["p1_max_totes",          "3",     "PIDs with ≤ this many totes → P1 (High), else P2"],
    ["write_back_enabled",    "true",  "Write call results back to Call History"],
    ["starvation_threshold",  "10",    "P0/P1 batches before forcing a P2 call"],
  ];
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  sheet.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#1E293B").setFontColor("#FFFFFF");
  // Style kill_switch row distinctively
  sheet.getRange(2, 1, 1, 3).setFontWeight("bold").setBackground("#DCFCE7").setFontColor("#166534");
  sheet.setFrozenRows(1);
  var cfg = {};
  for (var i=1;i<rows.length;i++) cfg[rows[i][0].toLowerCase().replace(/\s+/g,"_")] = rows[i][1];
  return cfg;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-TRIGGER: fires when Locked Tote Dump changes
// ═══════════════════════════════════════════════════════════════════════════

function onEdit(e) {
  if (!e || !e.source) return;
  var sheetName = e.range.getSheet().getName();
  if (sheetName !== SHEETS.LOCKED_DUMP && sheetName !== SHEETS.ASRS_DUMP) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try { processQueue(); }
  catch(err) { Logger.log("onEdit error: " + err.message); }
  finally { lock.releaseLock(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM MENU
// ═══════════════════════════════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("⚡ QTP")
    .addItem("▶  Process Queue  (Locked Dump + ASRS → Priority Queue)", "runProcessQueueUI")
    .addSeparator()
    .addItem("🛑  HALT — Stop Serving Totes  (Kill Switch ON)",  "haltToteServing")
    .addItem("▶  RESUME — Resume Serving Totes  (Kill Switch OFF)", "resumeToteServing")
    .addSeparator()
    .addItem("📊  View Status",  "showStatus")
    .addToUi();
}

function runProcessQueueUI() {
  var ui = SpreadsheetApp.getUi();
  // Block if kill switch is on
  if (isKillSwitchOn()) {
    ui.alert("🛑 Kill Switch is ON", "Resume tote serving first before processing a new queue.\nUse QTP → RESUME.", ui.ButtonSet.OK);
    return;
  }
  ui.alert("Processing…","Reading ASRS dump and building priority queue.\nThis may take 20–30 seconds.",ui.ButtonSet.OK);
  var result = processQueue();
  if (result.ok) {
    ui.alert("✓ Queue Built",
      "Locked totes processed: " + result.lockedTotes + "\n" +
      "ASRS rows scanned: "      + result.asrsRows    + "\n" +
      "PIDs analysed: "          + result.pidsAnalysed + "\n\n" +
      "Priority Queue:\n" +
      "  🔴 P0 (Critical): "  + result.p0Count + "\n" +
      "  🟡 P1 (High): "     + result.p1Count + "\n" +
      "  🟢 P2 (Standard): " + result.p2Count + "\n" +
      (result.noPIDFound > 0 ? "  ⚪ Not in ASRS: " + result.noPIDFound + "\n":"") +
      "\n⏱ Processing time: " + result.elapsedSec + " seconds",
      ui.ButtonSet.OK);
  } else {
    ui.alert("Error", result.reason || "Unknown error", ui.ButtonSet.OK);
  }
}

function haltToteServing() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    "🛑 Halt Tote Serving",
    "This will immediately stop the extension from serving any totes.\n\n" +
    "The extension will continue polling but receive an empty queue.\n\n" +
    "Are you sure?",
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  setKillSwitch(true);
  ui.alert("🛑 Kill Switch is ON", "Tote serving has been halted.\nThe extension will stop calling totes on its next poll (within 2 minutes).\n\nUse QTP → RESUME to re-enable.", ui.ButtonSet.OK);
}

function resumeToteServing() {
  var ui = SpreadsheetApp.getUi();
  setKillSwitch(false);
  ui.alert("▶ Resumed", "Kill switch is OFF.\nTote serving will resume on the extension's next poll.", ui.ButtonSet.OK);
}

function showStatus() {
  var meta   = getStatusMeta();
  var killed = isKillSwitchOn();
  SpreadsheetApp.getUi().alert(
    (killed ? "🛑 HALTED — " : "✅ Active — ") + "QTP Status",
    "Kill Switch: " + (killed ? "🛑 ON (halted)" : "✅ OFF (active)") + "\n\n" +
    "Last processed: "    + (meta.lastProcessed || "Never") + "\n" +
    "ASRS rows scanned: " + meta.asrsRows     + "\n" +
    "PIDs analysed: "     + meta.pidsAnalysed + "\n" +
    "Locked totes: "      + meta.lockedTotes  + "\n" +
    "Queue totes: "       + meta.queueTotes   + "\n" +
    "Processing time: "   + meta.elapsedSec   + "s",
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function parseToteFromLocation(location) {
  var str    = String(location||"").trim().toUpperCase();
  var tMatch = str.match(/(T[LS])([0-9]{10})/);
  if (!tMatch) return null;
  var pMatch = str.match(/_PR([0-9]+)/);
  return { toteId:tMatch[1]+tMatch[2], partition:pMatch?"PR"+pMatch[1]:"" };
}
function extractToteId(raw) {
  var str   = String(raw||"").trim().toUpperCase();
  var direct = str.match(/^(T[LS][0-9]{10})$/);
  if (direct) return direct[1];
  var p = parseToteFromLocation(str);
  return p ? p.toteId : null;
}
function extractPartition(raw) {
  var p = parseToteFromLocation(String(raw||"").trim().toUpperCase());
  return p ? p.partition : "";
}
function isValidToteId(id) { return /^(TL|TS)[0-9]{10}$/.test(String(id||"").trim().toUpperCase()); }
function assignPriority(toteCount,p0Max,p1Max) { return toteCount<=p0Max?"P0":toteCount<=p1Max?"P1":"P2"; }
function normaliseHeaders(row) { return row.map(function(h){return String(h||"").trim().toLowerCase();}); }
function findColumnIndex(headers,candidates) { for(var c=0;c<candidates.length;c++){var i=headers.indexOf(candidates[c]);if(i>=0)return i;} return -1; }
function colourPriorityRows(sheet,rows) {
  for(var i=1;i<rows.length;i++){
    var p=String(rows[i][1]||"").trim().toUpperCase();
    sheet.getRange(i+1,1,1,rows[i].length).setBackground(p==="P0"?"#FEE2E2":p==="P1"?"#FEF9C3":"#F8FAFC");
  }
}
function now() { return Utilities.formatDate(new Date(),Session.getScriptTimeZone(),"dd/MM/yyyy HH:mm"); }
function getOrCreateSheet(ss,name,headers) {
  var sheet=ss.getSheetByName(name);
  if(!sheet){sheet=ss.insertSheet(name);sheet.appendRow(headers);sheet.getRange(1,1,1,headers.length).setFontWeight("bold").setBackground("#1E293B").setFontColor("#FFFFFF");sheet.setFrozenRows(1);}
  return sheet;
}
function authenticate(e) { if(!SHARED_SECRET) return true; return ((e.parameter&&e.parameter.secret)||"")=== SHARED_SECRET; }
function jsonResponse(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }
function errorResponse(msg) { return ContentService.createTextOutput(JSON.stringify({ok:false,error:msg})).setMimeType(ContentService.MimeType.JSON); }

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS WITH TOTES — Grafana-sourced tote list → prioritised queue
// Called by extension with locked totes and supervisor totes from Grafana API
// ═══════════════════════════════════════════════════════════════════════════

function processWithTotes(body) {
  var startTime = new Date().getTime();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var lockedTotesInput  = body.lockedTotes    || [];
  var supervisorTotesIn = body.supervisorTotes || [];

  if (!lockedTotesInput.length)
    return { ok:true, queue:[], queueSize:0, message:"No locked totes provided", elapsedMs:0 };

  // ── Build supervisor set (SD priority — above P0) ─────────────────────────
  var supervisorSet = Object.create(null);
  supervisorTotesIn.forEach(function(t) {
    supervisorSet[String(t).trim().toUpperCase()] = true;
  });

  // ── Build locked tote list from Grafana input ─────────────────────────────
  // Same structure processQueue uses, just sourced from API instead of sheet
  var lockedToteIds  = Object.create(null);
  var lockedToteRows = [];
  var seenLocked     = Object.create(null);

  lockedTotesInput.forEach(function(rawId) {
    var toteId = extractToteId(String(rawId || "").trim());
    if (!toteId || seenLocked[toteId]) return;
    seenLocked[toteId] = true;
    lockedToteIds[toteId] = true;
    lockedToteRows.push({ toteId: toteId, partition: "" });
  });

  if (!lockedToteRows.length)
    return { ok:false, reason:"No valid tote IDs in locked tote input." };

  // ── Read ASRS Dump (identical to processQueue) ────────────────────────────
  var asrsSheet = ss.getSheetByName(SHEETS.ASRS_DUMP);
  if (!asrsSheet || asrsSheet.getLastRow() < 2)
    return { ok:false, reason:"ASRS Dump is empty — paste the ASRS tote export first." };

  var asrsHeaders = normaliseHeaders(
    asrsSheet.getRange(1, 1, 1, asrsSheet.getLastColumn()).getValues()[0]
  );
  var pidCol     = findColumnIndex(asrsHeaders, ["pid"]);
  var locCol     = findColumnIndex(asrsHeaders, ["location"]);
  var barcodeCol = findColumnIndex(asrsHeaders, ["barcode_count","barcode count","barcodes"]);
  if (pidCol < 0)     pidCol = 0;
  if (locCol < 0)     locCol = 1;
  if (barcodeCol < 0) barcodeCol = 2;

  var asrsRowCount = asrsSheet.getLastRow() - 1;
  var asrsData     = asrsSheet.getRange(2, 1, asrsRowCount, asrsSheet.getLastColumn()).getValues();

  // ── Build PID map in one pass (identical to processQueue) ─────────────────
  var pidMap  = Object.create(null);
  var toteMap = Object.create(null); // locked tote → its PIDs

  for (var i = 0; i < asrsData.length; i++) {
    var row      = asrsData[i];
    var pid      = String(row[pidCol] || "").trim();
    var location = String(row[locCol] || "").trim();
    var barcodes = parseInt(row[barcodeCol]) || 0;
    if (!pid || !location) continue;
    var parsed = parseToteFromLocation(location);
    if (!parsed) continue;
    var tId = parsed.toteId;

    if (!pidMap[pid]) pidMap[pid] = { totes: Object.create(null), totalBarcodes: 0, partitionCount: 0 };
    pidMap[pid].totes[tId] = true;
    pidMap[pid].totalBarcodes += barcodes;
    pidMap[pid].partitionCount++;

    if (lockedToteIds[tId]) {
      if (!toteMap[tId]) toteMap[tId] = Object.create(null);
      toteMap[tId][pid] = true;
    }
  }

  // ── Config ─────────────────────────────────────────────────────────────────
  var cfg   = loadConfig();
  var p0Max = parseInt(cfg["p0_max_totes"] || DEFAULT_P0_MAX_TOTES);
  var p1Max = parseInt(cfg["p1_max_totes"] || DEFAULT_P1_MAX_TOTES);

  // ── Assign priority per locked tote (identical logic to processQueue) ──────
  var queue  = [];
  var counts = { SD:0, P0:0, P1:0, P2:0 };

  for (var L = 0; L < lockedToteRows.length; L++) {
    var locked  = lockedToteRows[L];
    var toteId  = locked.toteId;

    // Supervisor LOCKED totes → SD (highest priority, above P0)
    if (supervisorSet[toteId]) {
      queue.push({ toteId:toteId, priority:"SD", source:"Supervisor Dump", pid:null, barcodeCount:null });
      counts.SD++;
      continue;
    }

    var pids    = toteMap[toteId];
    var pidList = pids ? Object.keys(pids) : [];

    if (!pidList.length) {
      // Not in ASRS — default P2
      queue.push({ toteId:toteId, priority:"P2", source:"Locked Tote Dump", pid:null, barcodeCount:0 });
      counts.P2++;
      continue;
    }

    // Find worst PID (fewest ASRS totes — most critical)
    var worstToteCount = Infinity;
    var worstPID       = "";
    var totalBarcodes  = 0;

    for (var p = 0; p < pidList.length; p++) {
      var thisPID  = pidList[p];
      var intel    = pidMap[thisPID];
      var toteCount = intel ? Object.keys(intel.totes).length : 0;
      totalBarcodes += intel ? intel.totalBarcodes : 0;
      if (toteCount < worstToteCount) { worstToteCount = toteCount; worstPID = thisPID; }
    }

    var priority = assignPriority(worstToteCount, p0Max, p1Max);
    queue.push({ toteId:toteId, priority:priority, source:"Locked Tote Dump", pid:worstPID, barcodeCount:totalBarcodes });
    counts[priority]++;
  }

  // Sort: SD → P0 → P1 → P2
  var ORDER = { SD:0, P0:1, P1:2, P2:3 };
  queue.sort(function(a, b) { return (ORDER[a.priority]||3) - (ORDER[b.priority]||3); });

  var elapsed = Math.round(new Date().getTime() - startTime);
  Logger.log("processWithTotes: " + queue.length + " totes in " + elapsed + "ms | SD:" + counts.SD + " P0:" + counts.P0 + " P1:" + counts.P1 + " P2:" + counts.P2);

  // ── Write Priority Queue back to sheet ──────────────────────────────────────
  // Columns: Tote ID | Priority | PID | ASRS Tote Count | Source
  // This lets operators see why each tote got P0/P1/P2 (which PID has few totes)
  try {
    var pqSheet = ss.getSheetByName(SHEETS.PRIORITY_QUEUE);
    if (pqSheet) {
      pqSheet.clearContents();
      var headers = [["Tote ID", "Priority", "PID", "ASRS Tote Count", "Source"]];
      var rows = queue.map(function(t) {
        return [t.toteId, t.priority, t.pid || "", t.barcodeCount || "", t.source || ""];
      });
      var allRows = headers.concat(rows);
      if (allRows.length > 1) {
        pqSheet.getRange(1, 1, allRows.length, 5).setValues(allRows);
      }
    }
  } catch(e) {
    Logger.log("Priority Queue write-back failed: " + e.message);
  }

  return {
    ok:        true,
    queue:     queue,
    queueSize: queue.length,
    sdCount:   counts.SD,
    p0Count:   counts.P0,
    p1Count:   counts.P1,
    p2Count:   counts.P2,
    asrsRows:  asrsRowCount,
    elapsedMs: elapsed
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE CLICK PURGE — raw ASRS dump reader
// Returns every ASRS Dump row parsed to { pid, toteId, partition, inventoryCount }.
// The extension's Purge Engine aggregates these client-side (PID totals, tote
// counts, partition distribution) and cross-checks against the blocked API +
// Quadron live API. Same sheet + same column detection as processWithTotes().
// ═══════════════════════════════════════════════════════════════════════════
function getAsrsDump() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.ASRS_DUMP);
  if (!sheet || sheet.getLastRow() < 2)
    return { ok:false, reason:"ASRS Dump is empty. Paste the ASRS tote export first." };

  var headers    = normaliseHeaders(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  var pidCol     = findColumnIndex(headers, ["pid"]);
  var locCol     = findColumnIndex(headers, ["location"]);
  var barcodeCol = findColumnIndex(headers, ["barcode_count","barcode count","barcodes"]);
  if (pidCol < 0)     pidCol = 0;
  if (locCol < 0)     locCol = 1;
  if (barcodeCol < 0) barcodeCol = 2;

  var rowCount = sheet.getLastRow() - 1;
  var data     = sheet.getRange(2, 1, rowCount, sheet.getLastColumn()).getValues();
  var out      = [];

  for (var i = 0; i < data.length; i++) {
    var pid      = String(data[i][pidCol]||"").trim();
    var location = String(data[i][locCol]||"").trim();
    var barcodes = parseInt(data[i][barcodeCol]) || 0;
    if (!pid || !location) continue;
    var parsed = parseToteFromLocation(location);
    if (!parsed) continue;
    out.push({
      pid:            pid,
      toteId:         parsed.toteId,
      partition:      parsed.partition,   // e.g. "PR1" or ""
      inventoryCount: barcodes
    });
  }

  return { ok:true, rows:out, rowCount:out.length, generatedAt:new Date().toISOString() };
}
