import { db } from '../db.js';
import { byId } from '../byId.js';

// A hook taken out of the hook bank. The ad keeps its text; only the bank
// hides it (metrics.hook_hidden).
export const isHookHidden = (a) => a?.metrics?.hook_hidden === true;

// Hides the hooks of these ads from the bank. -> { ok, failed }
export async function hideHooks(list, { client = db } = {}) {
  let failed = 0;
  for (const a of list || []) {
    try {
      const { error } = await byId(client.from('ads').update({ metrics: { ...(a.metrics || {}), hook_hidden: true } }), a.id);
      if (error) failed++;
    } catch {
      failed++;
    }
  }
  return { ok: failed === 0, failed };
}
