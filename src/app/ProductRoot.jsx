import ProductApp from './ProductApp.jsx';

export default function ProductRoot({ services }) {
  const productMode = services?.mode === 'product';

  if (!productMode) {
    throw new TypeError('Production root requires product services.');
  }

  return <ProductApp services={services} />;
}
