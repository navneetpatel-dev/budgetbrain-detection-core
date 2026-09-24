#!/usr/bin/env bash
# Records a Perfetto trace while N test SMS arrive with the app killed, then prints the numbers
# the budgets in plan §3.1 need. Requires: adb, a debug/dev-client build with the sms-detector
# module (task T2.1), and an emulator (SMS injection uses `adb emu sms send`).
#
#   perf/android/trace-headless-drain.sh [count] [sender]
set -euo pipefail
COUNT="${1:-5}"
SENDER="${2:-VMHDFCBK}"
PKG="app.budgetbrain.mobile"
OUT="headless-drain-$(date +%Y%m%d-%H%M%S).perfetto-trace"
DIR="$(cd "$(dirname "$0")" && pwd)"

adb shell am force-stop "$PKG"
adb push "$DIR/headless-drain.pbtxt" /data/misc/perfetto-configs/headless-drain.pbtxt >/dev/null
adb shell perfetto --txt -c /data/misc/perfetto-configs/headless-drain.pbtxt -o /data/misc/perfetto-traces/drain.trace --background
sleep 2

for i in $(seq 1 "$COUNT"); do
  adb emu sms send "$SENDER" "Rs.${i}00.00 debited from a/c **1234 on 23-09-26 to VPA shop${i}@okicici. Avl Bal Rs 9,000.00"
  sleep 1
done
# Non-financial SMS must not start JS at all (budget: 0 JS executions).
adb emu sms send "+15550100" "See you at 7?"

# WorkManager coalescing delay is 45 s; wait for the drain to finish.
sleep 55
adb shell pkill -INT perfetto || true
sleep 2
adb pull /data/misc/perfetto-traces/drain.trace "$OUT" >/dev/null
echo "Trace saved to $OUT. Open it in https://ui.perfetto.dev and record in plan §3.1:"
echo "  - number of HeadlessJsTaskService starts (budget: 1 per burst)"
echo "  - wall time of the TransactionDetectionDrain slice (budget: <= 3 s for 20 messages)"
echo "  - peak RSS of $PKG during the run"
echo "  - JS thread activity after the non-financial SMS (budget: none)"
