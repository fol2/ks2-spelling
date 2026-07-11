export default function App({ services }) {
  if (!services || services.native.capabilities.mode !== 'prototype-only') {
    throw new TypeError('The B1 shell requires prototype-only application services.');
  }

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="product-title">
        <p className="eyebrow">Local prototype</p>
        <h1 id="product-title">KS2 Spelling</h1>
        <p className="intro">
          A small, local-first foundation for practising statutory spelling.
        </p>
      </section>

      <section className="status-card" aria-labelledby="prototype-status">
        <div>
          <p className="label">Content available</p>
          <h2 id="prototype-status">
            Starter content: {services.starterContentCount} words
          </h2>
        </div>
        <span className="status-pill">Bundled locally</span>
      </section>

      <aside className="boundary" aria-label="B1 capability boundary">
        <p>Database / purchases / downloads: not enabled in B1</p>
      </aside>
    </main>
  );
}
