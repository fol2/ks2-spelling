import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import ProductApp from './ProductApp.jsx';
import { observeKeyboardInset } from './keyboard-inset.js';
import { installIOSDictationInputSession } from '../platform/keyboard/ios-dictation-input-session.js';
import './ios-dictation-input-session.css';

export default function ProductRoot({ services }) {
  const productMode = services?.mode === 'product';

  useEffect(() => {
    if (!productMode || Capacitor.getPlatform() !== 'ios') return undefined;
    const stopInset = observeKeyboardInset();
    const stopInputSession = installIOSDictationInputSession();
    return () => {
      stopInputSession();
      stopInset();
    };
  }, [productMode]);

  if (!productMode) {
    throw new TypeError('Production root requires product services.');
  }

  return <ProductApp services={services} />;
}
