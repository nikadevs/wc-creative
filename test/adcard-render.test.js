import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import AdCard from '../src/components/AdCard.jsx';

// A render of the card catches a broken component before it reaches the site.
describe('AdCard renders', () => {
  const ad = { id: 'a1', format: 'video', media_path: 'u/1.mp4', tags: [], metrics: { live: true, started_running: '2026-01-01T00:00:00.000Z', wc_product: 'Neck Pillow', ad_permalink: 'https://www.facebook.com/ads/library/?id=1' } };
  const products = [{ id: 'p1', name: 'Neck Pillow', sort: 1 }];

  it('with a product picker', () => {
    const out = renderToStaticMarkup(h(MemoryRouter, null, h(AdCard, { ad, products })));
    expect(out).toContain('aria-label="Product"');
    expect(out).toContain('Neck Pillow');
    expect(out).toContain('aria-label="Open Ad"');
  });

  it('without products, and in select mode', () => {
    expect(() => renderToStaticMarkup(h(MemoryRouter, null, h(AdCard, { ad })))).not.toThrow();
    expect(() => renderToStaticMarkup(h(MemoryRouter, null, h(AdCard, { ad, products, selectable: true })))).not.toThrow();
  });
});
