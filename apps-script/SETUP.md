# Quadron Tote Puller — Google Sheets Setup Guide

## Overview

The system uses two raw data exports:

| Data Source | Update Frequency | Rows | Processing |
|---|---|---|---|
| ASRS Tote Dump | 2–3 times per day | 1,00,000+ | ~20–30 sec (background) |
| Locked Tote Dump | Every 2–3 hours | 10–1,500 | ~2–5 sec (auto-triggered) |

---

## Sheet Structure — 6 tabs

| Tab Name | Written by | Purpose |
|---|---|---|
| `ASRS Dump` | You (paste) | Raw ASRS export — 1L+ rows |
| `Locked Tote Dump` | You (paste) | Locked/discrepant totes |
| `PID Intelligence` | Script (auto) | Aggregated PID data — DO NOT EDIT |
| `Priority Queue` | Script (auto) | What extension reads — DO NOT EDIT |
| `Call History` | Extension (auto) | Call outcomes log — DO NOT EDIT |
| `Config` | You | Settings and thresholds |

---

## ASRS Dump — Required column format

Row 1 = headers. Columns required:
```
pid | location | barcode_count | last_updated_at
```

Location format the script expects:
```
NXS1-ASRS-TL0000018476_PR2
```
Script extracts ToteID (TL0000018476) and Partition (PR2) automatically.

## Locked Tote Dump — Flexible format

The script accepts any of:
- Column named `tote id` containing `TL0000018476`
- Column named `location` containing `NXS1-ASRS-TL0000018476_PR2`
- Any cell containing TL + 10 digits in any format

---

## Step 1 — Deploy the Apps Script

1. Open your Google Sheet
2. Click **Extensions → Apps Script**
3. Delete all existing code, paste entire `Code.gs` contents
4. Save (Ctrl+S)
5. Click **Deploy → New Deployment**
   - Type: Web App
   - Execute as: Me
   - Who has access: Anyone
6. Click **Deploy → Authorize access**
7. Copy the **Web App URL**
8. Paste into extension → Auto tab → Apps Script URL field

---

## Step 2 — Set up auto-trigger (once only)

After deploying, a **⚡ QTP** menu appears in your sheet toolbar.

Click: **⚡ QTP → Set Up Time Trigger**

This rebuilds PID Intelligence automatically at 6 AM daily. One-time setup.

---

## Daily Operating Procedure

**When new ASRS Dump arrives (2–3x/day):**
1. Paste into `ASRS Dump` tab
2. Click **⚡ QTP → 1. Build ASRS Intelligence**
3. Wait ~20–30 seconds for confirmation

**When new Locked Tote Dump arrives (every 2–3 hrs):**
1. Paste into `Locked Tote Dump` tab
2. Script auto-processes immediately (onEdit trigger)
3. Priority Queue updates automatically
4. Extension picks up new totes on next 2-min poll

---

## Priority Rules

| Totes in ASRS for this PID | Assigned Priority |
|---|---|
| 1 tote (only tote is locked) | **P0 — Critical** |
| 2–3 totes | **P1 — High** |
| 4+ totes | **P2 — Standard** |

Thresholds configurable in Config tab: `p0_max_totes` and `p1_max_totes`.

**Example:**
```
PID 134745 → 1 tote (TL0000018476) → locked → P0
PID 135212 → 3 totes (TL...7509, TL...7597, TL...0097) → any locked → P1
```

---

## Config Tab (auto-created, change Value column only)

| Key | Default | Description |
|---|---|---|
| cooldown_hours | 1 | Hours before re-queuing a called tote |
| batch_size | 5 | Totes per batch |
| batch_interval_minutes | 1 | Minutes between batches |
| call_interval_seconds | 5 | Seconds between tote calls |
| p0_max_totes | 1 | Tote count threshold for P0 |
| p1_max_totes | 3 | Tote count threshold for P1 |
| write_back_enabled | true | Write results to Call History |

---

## Troubleshooting

| Issue | Fix |
|---|---|
| "PID Intelligence not built" | Click QTP → Build ASRS Intelligence |
| "Priority Queue is empty" | Click QTP → Process Locked Totes |
| Totes showing wrong priority | Rebuild intelligence with fresh ASRS dump |
| Fetch fails in extension | Re-deploy script and update the URL |
| onEdit not triggering | Open Apps Script editor and re-authorise |
| Processing timeout on ASRS dump | Remove blank rows from the bottom of ASRS Dump tab |
