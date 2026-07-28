import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import ProductApp from './ProductApp.jsx';
import { observeKeyboardInset } from './keyboard-inset.js';
import './ios-dictation-input-session.css';

export default function ProductRoot({ services }) {
  const productMode = services?.mode === 'product';

  useEffect(() => {
    if (!productMode || Capacitor.getPlatform() !== 'ios') return undefined;
    // Keep one bounded iOS layout integration point, but the observer is now a
    // deliberate no-op: the authored round already reserves the keyboard area
    // and must not be compacted from visualViewport measurements.
    return observeKeyboardInset();
  }, [productMode]);

  if (!productMode) {
    throw new TypeError('Production root requires product services.');
  }

  return <ProductApp services={services} />;
}
