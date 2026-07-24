import ProductApp from './ProductApp.jsx';

export default function ProductRoot({ services }) {
  if (services?.mode !== 'product') {
    throw new TypeError('Production root requires product services.');
  }
  return <ProductApp services={services} />;
}
