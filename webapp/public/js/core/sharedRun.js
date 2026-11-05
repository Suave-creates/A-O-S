// The latest run of a run-type screen (Outside Totes, CNG Validator, Bulk Tote Inv Check) is shared with everyone
// (operator decision 2026-11-04: what anyone loads is seen by everyone until someone runs it again). A screen
// follows its "shared.<panel>" live topic - only who / when / version - and reads the full result from
// <apiBase>/last when the version changes, then draws it as if it had run it itself.
const SharedRun = (() => {
  // follow(panel, apiBase, onLast) -> stop function. onLast(last) is skipped while isBusy() (this page's own run
  // is in progress - its own result arrives right after).
  function follow(panel, apiBase, onLast, isBusy = () => false) {
    let shown = 0;
    let reading = false;
    return Live.subscribe(`shared.${panel}`, async (evt) => {
      const v = evt.type === "data" && evt.data && evt.data.version;
      if (!v || v === shown || reading || isBusy()) return;
      reading = true;
      try {
        const last = await Api.get(`${apiBase}/last`);
        shown = last.version;
        onLast(last);
      } catch (e) {
        /* nothing run yet (404) or a transient error - the screen keeps what it shows */
      } finally {
        reading = false;
      }
    });
  }

  // "Run by E2 at 14:05" - shown with every shared result, so everyone knows whose run they are looking at
  const byLine = (last) => `run by ${last.runBy || "someone"} at ${Fmt.time(last.runAt)}`;

  return { follow, byLine };
})();
