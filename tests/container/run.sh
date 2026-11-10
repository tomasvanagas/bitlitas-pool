#!/bin/sh
# -----------------------------------------------------------
#  [*] run.sh — the test container's entrypoint
#
#  Runs Node's test runner over the suite from the pool's own
#  folder, the way the image runs the pool. Nothing is
#  started here: every test file builds its own world — a
#  redis-server, the fake daemon and wallet, the pools it
#  needs — under /tmp/bitlitas-pool-tests, so four files run
#  side by side without sharing a key or a port. Every
#  argument goes to node --test; without a test file among
#  them, the whole suite runs. When a test fails, the crash
#  logs the pools wrote are printed under the report, so an
#  unexpected crash shows its stack. Dockerfile.tests makes
#  this script the image's entrypoint. A file whose
#  modules leave timers running (the logger flushes every
#  few seconds) ends with its last test: --test-force-exit.
# -----------------------------------------------------------
set -e
cd /pool


# The whole suite unless a test file or folder is named; a
# folder stands for the test files under it
named=""
for arg in "$@"; do
    shift
    case "$arg" in
        -*) ;;
        *) named=1; [ -d "$arg" ] && arg="${arg%/}/**/*.test.js" ;;
    esac
    set -- "$@" "$arg"
done
[ -n "$named" ] || set -- "$@" 'tests/**/*.test.js'


# The suite; its failures come with the pools' crash logs
status=0
node --test --test-reporter=spec --test-concurrency=4 --test-force-exit "$@" || status=$?
if [ "$status" -ne 0 ]; then
    for log in /tmp/bitlitas-pool-tests/*/logs/*_crash.log; do
        [ -f "$log" ] || continue
        echo "--- $log"
        tail -n 20 "$log"
    done
fi
exit $status
