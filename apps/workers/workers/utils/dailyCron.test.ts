import cron from "node-cron";
import { describe, expect, it } from "vitest";

// node-cron (3.x) checks the clock once a second and, by default, fires only if
// one of those checks lands inside the matching second. A check that comes a
// little late therefore drops the whole day's digest/backup without a trace.
// The daily workers set `recoverMissedExecutions` to avoid that; these tests
// pin the library behaviour that setting relies on. They use the real clock:
// the event loop is blocked across the target second so no check can land in it.
async function stallAcrossMatchingSecond(
  recoverMissedExecutions: boolean,
): Promise<number> {
  const target = new Date(Date.now() + 2000);
  target.setMilliseconds(0);
  let fired = 0;
  const job = cron.schedule(
    `${target.getSeconds()} * * * * *`,
    () => {
      fired++;
    },
    { scheduled: false, recoverMissedExecutions },
  );
  job.start();
  const until = target.getTime() + 1500;
  while (Date.now() < until) {
    // busy-wait: simulates an event loop that is stalled past the matching second
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  job.stop();
  return fired;
}

describe("a cron whose clock check is late", () => {
  it("still fires when recoverMissedExecutions is on", async () => {
    expect(await stallAcrossMatchingSecond(true)).toBe(1);
  }, 10_000);

  it("is silently skipped when it is off (the bug the daily workers hit)", async () => {
    expect(await stallAcrossMatchingSecond(false)).toBe(0);
  }, 10_000);
});
