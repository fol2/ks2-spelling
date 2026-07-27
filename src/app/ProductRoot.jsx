import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import ProductApp from './ProductApp.jsx';
import { observeKeyboardInset } from './keyboard-inset.js';
import './ios-dictation-input-session.css';

export default function ProductRoot({ services }) {
  const productMode = services?.mode === 'product';

  useEffect(() => {
    if (!productMode || Capacitor.getPlatform() !== 'ios') return undefined;
    // Inset observation stays app-wide so any focused field can publish the
    // covered height. The persistent dictation input itself is owned by
    // ProductApp and only mounts on Setup / Practice — leaving it on body for
    // every place (Words, Switch learner, Camp) blocked ordinary iOS keyboards.
    return observeKeyboardInset();
  }, [productMode]);

  if (!productMode) {
    throw new TypeError('Production root requires product services.');
  }

  return <ProductApp services={services} />;
}
