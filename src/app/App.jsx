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
        <span className="status-pill">{services.platformRequirement}</span>
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
        <div aria-label={`Learner isolation: ${proofState.learnerIsolation}`}>
          <dt>Learner isolation</dt>
          <dd>{proofState.learnerIsolation}</dd>
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

function B3App({ services }) {
  const [proofState, setProofState] = useState(() =>
    services.controller.getState(),
  );
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    const subscription = services.controller.subscribe(setProofState);
    void services.controller.start().catch(() => undefined);
    return () => subscription.remove();
  }, [services]);

  const busy = actionPending ||
    proofState.status === 'purchasing' ||
    proofState.status === 'downloading';
  const runAction = (action) => {
    if (busy) return;
    setActionPending(true);
    void action()
      .catch(() => undefined)
      .finally(() => setActionPending(false));
  };

  return (
    <main className="shell b3-proof-shell">
      <section className="hero" aria-labelledby="b3-proof-title">
        <p className="eyebrow">Parent-only diagnostic</p>
        <h1 id="b3-proof-title">B3 sandbox proof</h1>
        <p className="intro">
          Store and signed spelling-pack checks for a grown-up tester.
        </p>
      </section>

      <section className="status-card proof-status" aria-live="polite">
        <div>
          <p className="label">Proof state</p>
          <h2>{proofState.status}</h2>
          <p className="proof-message">{proofState.message}</p>
        </div>
        <span className="status-pill">
          {proofState.packReady ? 'Pack ready' : 'Pack locked'}
        </span>
      </section>

      <section className="commerce-card" aria-labelledby="b3-product-title">
        <div>
          <p className="label">Sandbox product</p>
          <h2 id="b3-product-title">Full KS2 proof pack</h2>
          <p className="localised-price">{proofState.displayPrice}</p>
        </div>
        <div className="proof-actions" aria-label="Parent sandbox actions">
          <button
            type="button"
            disabled={busy || proofState.displayPrice === ''}
            onClick={() => runAction(services.controller.buy)}
          >
            Buy
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runAction(services.controller.restore)}
          >
            Restore
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runAction(services.controller.redownload)}
          >
            Redownload
          </button>
        </div>
      </section>

      <dl className="evidence-grid" aria-label="Signed pack evidence">
        <div>
          <dt>Manifest digest</dt>
          <dd>{proofState.digests.manifest}</dd>
        </div>
        <div>
          <dt>Archive digest</dt>
          <dd>{proofState.digests.archive}</dd>
        </div>
        <div>
          <dt>Install digest</dt>
          <dd>{proofState.digests.install ?? 'Not installed'}</dd>
        </div>
      </dl>
    </main>
  );
}

export default function App({ services }) {
  if (!services || typeof services !== 'object') {
    throw new TypeError('Application services are required.');
  }
  if (services.mode === 'b3-parent-proof') return <B3App services={services} />;
  if (services.mode === 'b2-native-proof') return <B2App services={services} />;
  return <B1App services={services} />;
}
