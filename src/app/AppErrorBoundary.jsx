import { Component } from 'react';

/**
 * Catches a render failure anywhere beneath it.
 *
 * Without this, React unmounts the whole tree on an uncaught render error and
 * the learner is left staring at a blank screen with nothing to act on and
 * nothing to report. The recovery screen says what happened in words a child
 * can act on, keeps the technical detail folded away for whoever is helping,
 * and offers the one recovery that always works: start the app again. Saved
 * progress is untouched — it lives in the local database, not in this tree.
 *
 * It shares the boot surface with the loading shell, which sits outside the
 * product surface on purpose: that one is locked to the viewport, and a stack
 * trace has to be able to scroll.
 */
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.restart = () => {
      // A reload rebuilds every service from the saved database, which is the
      // only recovery available once the React tree itself has gone.
      globalThis.location?.reload();
    };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The console is the only channel a device build has for this, and a
    // silent failure is what made the blank screen so hard to diagnose.
    console.error('KS2 Spelling failed to render.', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const detail = error?.stack || String(error?.message ?? error);
    return (
      <main className="app-boot" aria-labelledby="app-error-title">
        <section className="app-boot-panel" aria-labelledby="app-error-title">
          <p className="app-boot-kicker">KS2 Spelling</p>
          <h1 id="app-error-title" className="app-boot-title">
            Something went wrong
          </h1>
          <p className="app-boot-body" role="alert">
            Your practice is safe on this device. Start the app again to carry
            on from where you were.
          </p>
          <button
            type="button"
            className="button-primary press app-boot-action"
            onClick={this.restart}
          >
            Start again
          </button>
          <details className="app-boot-detail">
            <summary>What went wrong</summary>
            <pre>{detail}</pre>
          </details>
        </section>
      </main>
    );
  }
}
