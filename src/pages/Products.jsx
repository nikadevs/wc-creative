import React, { useState } from 'react';
import { ArrowUp, ArrowDown, Trash, Plus, Check } from '@phosphor-icons/react';
import { Page, PageHeader, Panel, inputCls } from '@/components/ui';
import { useProducts, addProduct, renameProduct, deleteProduct, moveProduct } from '@/lib/products';

function ProductRow({ row, index, rows, names }) {
  const [name, setName] = useState(row.name);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = name.trim() !== row.name;

  const save = async () => {
    setBusy(true);
    setError('');
    const res = await renameProduct(row, name, names);
    setBusy(false);
    if (!res.ok) setError(res.message);
  };
  const remove = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setBusy(true);
    const res = await deleteProduct(row, names);
    setBusy(false);
    if (!res.ok) setError(res.message);
  };
  const iconBtn = 'w-11 h-11 flex items-center justify-center rounded-full text-ink-soft hover:text-ink hover:bg-card-hi disabled:opacity-30';

  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
          aria-label="Product name"
          maxLength={80}
          className={`${inputCls} flex-1`}
        />
        {dirty && (
          <button type="button" onClick={save} disabled={busy} aria-label="Save name" className={iconBtn}>
            <Check size={20} weight="bold" />
          </button>
        )}
        <button type="button" onClick={() => moveProduct(rows, index, -1)} disabled={index === 0} aria-label="Move up" className={iconBtn}>
          <ArrowUp size={18} weight="bold" />
        </button>
        <button type="button" onClick={() => moveProduct(rows, index, 1)} disabled={index === rows.length - 1} aria-label="Move down" className={iconBtn}>
          <ArrowDown size={18} weight="bold" />
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label={armed ? 'Tap again to delete' : 'Delete product'}
          className={armed ? 'h-11 px-3 rounded-full bg-status-bad text-[#fff] text-small font-semibold' : iconBtn}
        >
          {armed ? 'Delete?' : <Trash size={18} weight="bold" />}
        </button>
      </div>
      {error && <p className="mt-1 text-small text-status-bad-text">{error}</p>}
    </li>
  );
}

// Our products: the list the library filter, the ad card and the extension
// all use. Renaming moves the product's ads to the new name; deleting keeps
// the ads, filed under no product.
export default function Products() {
  const rows = useProducts();
  const names = rows.map((r) => r.name);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const add = async (e) => {
    e.preventDefault();
    setError('');
    const res = await addProduct(name, rows.length + 1);
    if (!res.ok) setError(res.message);
    else setName('');
  };

  return (
    <Page id="products" width="narrow">
      <PageHeader title="Products" context="The products you file creatives under. The order here is the order everywhere." />
      <Panel>
        <ul className="px-4 lg:px-5 py-2 divide-y divide-line">
          {rows.map((row, i) => (
            <ProductRow key={`${row.id}-${row.name}`} row={row} index={i} rows={rows} names={names} />
          ))}
        </ul>
        <form onSubmit={add} className="px-4 lg:px-5 pb-4 pt-2 flex items-center gap-2 border-t border-line">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New product" aria-label="New product" maxLength={80} className={`${inputCls} flex-1`} />
          <button type="submit" className="h-11 px-4 inline-flex items-center gap-1.5 rounded-xl bg-accent text-black text-ui font-semibold">
            <Plus size={16} weight="bold" /> Add
          </button>
        </form>
        {error && <p className="px-5 pb-4 text-small text-status-bad-text">{error}</p>}
      </Panel>
    </Page>
  );
}
