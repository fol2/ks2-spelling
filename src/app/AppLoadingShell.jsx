/**
 * The very first paint, before any service exists.
 *
 * On a modern device this is on screen for a few hundred milliseconds, which
 * rules a spinner out: anything that turns would only ever flash. So it is a
 * title page instead — the same vellum, the same serif and the same tracked
 * kicker the game opens with, so the first frame already belongs to it. The
 * status line is the only part that reports state, and it says where the
 * practice lives as well as what is happening.
 */
export default function AppLoadingShell() {
  return (
    <main
      className="app-boot"
      aria-busy="true"
      aria-labelledby="app-loading-title"
    >
      <section className="app-boot-panel" aria-labelledby="app-loading-title">
        <p className="app-boot-kicker">KS2 Spelling</p>
        <h1 id="app-loading-title" className="app-boot-title">
          Getting ready
        </h1>
        <p className="app-boot-body" role="status">
          Preparing your spelling practice on this device.
        </p>
      </section>
    </main>
  );
}
