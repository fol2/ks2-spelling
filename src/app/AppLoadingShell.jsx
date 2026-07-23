export default function AppLoadingShell() {
  return (
    <main className="shell" aria-busy="true" aria-labelledby="app-loading-title">
      <section className="hero" aria-labelledby="app-loading-title">
        <p className="eyebrow">KS2 Spelling</p>
        <h1 id="app-loading-title">Getting ready</h1>
        <p className="intro" role="status">
          Preparing your local spelling practice.
        </p>
      </section>
    </main>
  );
}
