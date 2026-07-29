import ProductApp from './ProductApp.jsx';
import { TrailMeadowPortal } from './trail/TrailMeadowPortal.jsx';

export default function ProductRoot({ services }) {
  const productMode = services?.mode === 'product';

  if (!productMode) {
    throw new TypeError('Production root requires product services.');
  }

  return (
    <>
      <ProductApp services={services} />
      <TrailMeadowPortal services={services} />
    </>
  );
}
