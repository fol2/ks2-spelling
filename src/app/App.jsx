import { useEffect, useState } from 'react';

function B1App({ services }) {
  if (services.native.capabilities.mode !== 'prototype-only') {
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

function B2App({ services }) {
  const [proofState, setProofState] = useState(() =>
    services.controller.getState(),
  );

  useEffect(() => {
    const subscription = services.controller.subscribe(setProofState);
    void services.controller.start().catch(() => undefined);
    return () => subscription.remove();
  }, [services]);

  const complete = proofState.status === 'B2 proof complete';

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="product-title">
        <p className="eyebrow">B2 persistence proof</p>
        <h1 id="product-title">KS2 Spelling</h1>
        <p className="intro">
          Local SQLite, transaction recovery and app lifecycle diagnostics.
        </p>
      </section>

      <section className="status-card proof-status" aria-live="polite">
        <div>
          <p className="label">Active proof phase</p>
          <h2>{proofState.status}</h2>
        </div>
        <span className="status-pill">Native local data</span>
      </section>

      <dl className="evidence-grid" aria-label="B2 persistence evidence">
        <div aria-label={`Database: ${services.databaseName}`}>
          <dt>Database</dt>
          <dd>{services.databaseName}</dd>
        </div>
        <div aria-label={`SQLite schema: ${services.schemaVersion}`}>
          <dt>SQLite schema</dt>
          <dd>{services.schemaVersion}</dd>
        </div>
        <div aria-label={`Learner isolation: ${services.learnerIsolation}`}>
          <dt>Learner isolation</dt>
          <dd>{services.learnerIsolation}</dd>
        </div>
        <div
          aria-label={`Lifecycle: ${
            complete ? 'pause, resume and relaunch verified' : 'proof in progress'
          }`}
        >
          <dt>Lifecycle</dt>
          <dd>{complete ? 'pause, resume and relaunch verified' : 'proof in progress'}</dd>
        </div>
      </dl>
    </main>
  );
}

export default function App({ services }) {
  if (!services || typeof services !== 'object') {
    throw new TypeError('Application services are required.');
  }
  if (services.mode === 'b2-native-proof') return <B2App services={services} />;
  return <B1App services={services} />;
}
