// Global single-flight lock for PULL_QUADRON_TOTE dispatches specifically -
// not a generic app-wide lock, and not part of the capability itself. This
// module has zero knowledge of Quadron, capabilities, or the Query Manager;
// it is a plain, dependency-free async mutex, deliberately kept that way so
// it can be unit-tested in complete isolation.
//
// Guarantees at most one PULL_QUADRON_TOTE dispatch is ever in flight at a
// time, regardless of how many different callers - the standalone
// single-tote route, the Tote Pull Engine's session loop, or both at once -
// try to acquire it concurrently.
//
// `pending` is incremented SYNCHRONOUSLY inside withPullLock(), with no
// await between the check and the increment anywhere in this file - that is
// what makes isBusy() race-free even when two callers invoke withPullLock()
// back-to-back in the same synchronous tick (a real scenario in tests, and
// not impossible under real request scheduling either).

let pending = 0; // number of calls currently queued or actively running
let tail = Promise.resolve();

// Runs fn() once every previously-queued withPullLock() call has finished -
// queues and waits, never rejects merely because the lock is busy. Used by
// the Engine's own background sequential loop, where waiting is correct.
function withPullLock(fn) {
  pending++;
  const runAfterPrevious = tail.then(() => fn());
  // The chain itself must never reject, or every subsequent queued caller
  // would be stuck waiting on a rejected promise forever.
  tail = runAfterPrevious.then(
    () => {},
    () => {}
  );
  runAfterPrevious.then(
    () => {
      pending--;
    },
    () => {
      pending--;
    }
  );
  return runAfterPrevious;
}

// True the instant any withPullLock() call has been made and hasn't yet
// finished - checked by interactive callers (HTTP routes) that want to fail
// fast with a clear "try again shortly" instead of silently blocking.
function isBusy() {
  return pending > 0;
}

module.exports = { withPullLock, isBusy };
