import { loadStarterSpellingCatalogue } from '../domain/spelling/index.js';
import { createB1FakeNativePorts } from '../platform/fakes/create-b1-fake-native-ports.js';
import { assertNativePortContract } from '../platform/native-port-contract.js';

export { createB2AppServices } from './create-b2-app-services.js';

export function createAppServices({ nativePorts = createB1FakeNativePorts() } = {}) {
  const starterCatalogue = loadStarterSpellingCatalogue();
  const native = assertNativePortContract(nativePorts);

  if (starterCatalogue.items.length !== 20) {
    throw new Error('The certified B1 Starter catalogue must contain exactly 20 words.');
  }

  return Object.freeze({
    native,
    starterContentCount: starterCatalogue.items.length,
  });
}
