import { useEffect, useState } from 'react';
import { db, IS_DEMO } from './db.js';
import { byId } from './byId.js';

// Our own products. An ad is filed under one: metrics.wc_product holds the
// name and the same name rides along as a tag, so the library's tag filter
// (and its server search) finds the ads of a product with no new query.

export const DEFAULT_PRODUCTS = ['Neck Pillow', 'Air Cushion Back', 'Anti Theft Bag', 'GPS Wallet Tracker'];
const EVENT = 'wc:products-changed';

const demoRows = () => DEFAULT_PRODUCTS.map((name, i) => ({ id: `demo-${i}`, name, sort: i + 1 }));

export async function loadProducts({ client = db } = {}) {
  if (IS_DEMO) return demoRows();
  try {
    const { data, error } = await client.from('products').select('id, name, sort').order('sort', { ascending: true }).order('name', { ascending: true });
    if (error || !Array.isArray(data)) return demoRows();
    return data;
  } catch {
    return demoRows();
  }
}

export function announceProducts() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

// [{ id, name, sort }], kept fresh when the Products page changes the list.
export function useProducts() {
  const [rows, setRows] = useState(demoRows);
  useEffect(() => {
    let live = true;
    const load = () => loadProducts().then((r) => live && setRows(r));
    load();
    window.addEventListener(EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(EVENT, load);
    };
  }, []);
  return rows;
}

export const productOf = (ad) => (typeof ad?.metrics?.wc_product === 'string' && ad.metrics.wc_product) || null;

// The tags and metrics an ad gets when it is filed under `name` (null = none).
// Every other product name is taken off its tags.
export function productPatch(ad, name, allNames = DEFAULT_PRODUCTS) {
  const names = new Set([...allNames, productOf(ad)].filter(Boolean));
  const tags = (ad.tags || []).filter((t) => !names.has(t));
  if (name) tags.push(name);
  const metrics = { ...(ad.metrics || {}) };
  if (name) metrics.wc_product = name;
  else delete metrics.wc_product;
  return { tags, metrics };
}

// -> the updated ad, or null when the save failed.
export async function setAdProduct(ad, name, allNames, { client = db } = {}) {
  const patch = productPatch(ad, name, allNames);
  try {
    const { error } = await byId(client.from('ads').update(patch), ad.id);
    if (error) return null;
  } catch {
    return null;
  }
  return { ...ad, ...patch };
}

export async function addProduct(name, sort, { client = db } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return { ok: false, message: 'Enter a name.' };
  const { error } = await client.from('products').insert({ name: clean, sort });
  if (error) return { ok: false, message: /duplicate|unique/i.test(error.message) ? 'That product already exists.' : error.message };
  announceProducts();
  return { ok: true };
}

// Renames a product and moves its ads over to the new name.
export async function renameProduct(row, name, allNames, { client = db } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return { ok: false, message: 'Enter a name.' };
  if (clean === row.name) return { ok: true };
  const { error } = await byId(client.from('products').update({ name: clean }), row.id);
  if (error) return { ok: false, message: /duplicate|unique/i.test(error.message) ? 'That product already exists.' : error.message };
  const { data: ads } = await client.from('ads').select('id, tags, metrics').eq('metrics->>wc_product', row.name);
  for (const ad of ads || []) await setAdProduct(ad, clean, [...allNames, row.name], { client });
  announceProducts();
  return { ok: true };
}

// Deletes a product. Its ads stay, filed under no product.
export async function deleteProduct(row, allNames, { client = db } = {}) {
  const { data: ads } = await client.from('ads').select('id, tags, metrics').eq('metrics->>wc_product', row.name);
  for (const ad of ads || []) await setAdProduct(ad, null, allNames, { client });
  const { error } = await byId(client.from('products').delete(), row.id);
  if (error) return { ok: false, message: error.message };
  announceProducts();
  return { ok: true };
}

export async function moveProduct(rows, index, dir, { client = db } = {}) {
  const j = index + dir;
  if (j < 0 || j >= rows.length) return;
  const order = rows.slice();
  const [item] = order.splice(index, 1);
  order.splice(j, 0, item);
  for (let i = 0; i < order.length; i++) {
    if (order[i].sort !== i + 1) await byId(client.from('products').update({ sort: i + 1 }), order[i].id);
  }
  announceProducts();
}
