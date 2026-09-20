// Rows whose elapsed time keeps moving while the work behind them does.
//
// The terminal redraws a tool row only when something invalidates it — a new result update, an
// expansion toggle, a theme change — so an elapsed time measured against `Date.now()` advances
// in jumps, and a row that never receives another update freezes at the moment it was written.
// A live row therefore asks for its own redraw about once a second, which is what the browser's
// `useLiveNow` interval does on the other surface.
//
// A renderer is not a lifecycle owner, so both ends are handled here: the timer is cleared as
// soon as the row reports a settled state, and every timer this module started is cleared from
// `session_shutdown` through `stopLiveRedraw`. A settled row never starts one, so a long
// transcript of finished runs schedules nothing.

import type { RenderContext } from "./types.ts";

/** How often a live row redraws. Nothing on either surface has sub-second resolution. */
const TICK_MS = 1_000;

/** Where the row's own timer is kept, so a redraw finds the one it already started. */
const STATE_KEY = "liveRedrawTimer";

type Timer = ReturnType<typeof setInterval>;

const timers = new Set<Timer>();

function clear(timer: Timer): void {
  clearInterval(timer);
  timers.delete(timer);
}

/**
 * Keep redrawing this row while `live`, and stop as soon as it is not.
 *
 * Call it from the render slot that shows the elapsed time, with the liveness the payload it
 * just decoded reports. A row whose payload can never be updated — a background run's launch
 * card — stays live for as long as the session lasts: its elapsed time is then "how long since
 * this was launched", which is what its status line already says it is measuring.
 */
export function liveRedraw(ctx: RenderContext, live: boolean): void {
  const existing = ctx.state[STATE_KEY] as Timer | undefined;
  if (!live) {
    if (existing) {
      clear(existing);
      ctx.state[STATE_KEY] = undefined;
    }
    return;
  }
  if (existing) return;
  const timer = setInterval(() => ctx.invalidate(), TICK_MS);
  // A pending redraw must never be the reason the process stays alive.
  timer.unref?.();
  timers.add(timer);
  ctx.state[STATE_KEY] = timer;
}

/** Stop every live row. Extensions that render live rows call this on `session_shutdown`. */
export function stopLiveRedraw(): void {
  for (const timer of timers) clearInterval(timer);
  timers.clear();
}
