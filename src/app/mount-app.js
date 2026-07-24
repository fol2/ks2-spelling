export async function mountApp({
  root,
  createRoot,
  createServices,
  createFailureServices = null,
  renderLoading,
  renderApp,
  onPageHide,
}) {
  if (!root) throw new Error('KS2 Spelling root element is missing.');
  if (typeof createRoot !== 'function') {
    throw new TypeError('createRoot must be a function.');
  }
  if (typeof createServices !== 'function') {
    throw new TypeError('createServices must be a function.');
  }
  if (typeof renderLoading !== 'function') {
    throw new TypeError('renderLoading must be a function.');
  }
  if (typeof renderApp !== 'function') {
    throw new TypeError('renderApp must be a function.');
  }
  if (typeof onPageHide !== 'function') {
    throw new TypeError('onPageHide must be a function.');
  }

  const reactRoot = createRoot(root);
  // Paint a lightweight shell before native service initialisation so cold
  // launch is not blocked on database open, migration, seed and snapshot read.
  reactRoot.render(renderLoading());

  let services;
  try {
    services = await createServices();
  } catch (error) {
    if (typeof createFailureServices !== 'function') throw error;
    services = createFailureServices(error);
  }

  if (typeof services?.dispose === 'function') {
    onPageHide(
      () => void services.dispose().catch(() => undefined),
      { once: true },
    );
  }

  reactRoot.render(renderApp(services));
  return services;
}
