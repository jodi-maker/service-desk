import { beforeAll, describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

// Run the real browser refresh, API client and row mapper in a fresh VM. Only
// layout hydration is stubbed; this avoids loading the unrelated UI/router.
let bundle = '';
beforeAll(async () => {
  const web = resolve(import.meta.dir, '../../web/js').replaceAll('\\', '/');
  const build = await Bun.build({
    entrypoints: ['refresh-test-entry'], target: 'browser', format: 'iife',
    plugins: [{ name: 'refresh-test', setup(builder) {
      builder.onResolve({ filter: /^refresh-test-entry$/ }, () => ({ path: 'entry', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ loader: 'js', contents: `
        import { refreshCustomerAccount } from '${web}/customers/account-refresh.js';
        import { CUSTOMERS } from '${web}/core/data.js';
        import { setJwt, setWorkspaceId } from '${web}/core/api-client.js';
        Object.assign(globalThis, { refreshCustomerAccount, customers: CUSTOMERS, setJwt, setWorkspaceId });
      ` }));
      builder.onLoad({ filter: /layouts[\\/]index\.js$/ }, () => ({ loader: 'js', contents: 'export function hydrateLayouts() {}' }));
    } }],
  });
  if (!build.success) throw new Error(build.logs.join('\n'));
  bundle = await build.outputs[0].text();
});

function setup() {
  const storage = new Map<string, string>();
  let requests = 0;
  let complete!: (r: Response) => void;
  let now = 100_000;
  const context: any = {
    Date: class extends Date { static now() { return now; } },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: () => { requests++; return new Promise<Response>(r => { complete = r; }); },
  };
  runInNewContext(bundle, context);
  context.setJwt('session-A');
  context.setWorkspaceId('workspace-A');
  const customer: any = { id: 'M25', _uuid: 'customer-25', maestroUserId: 'player-25', vip: '', mobile: '', brand: '', jurisdiction: '' };
  context.customers.push(customer);
  let updated = 0;
  const errors: unknown[] = [];
  return {
    context, customer, errors,
    requests: () => requests,
    updated: () => updated,
    advance: () => { now += 61_000; },
    refresh: () => context.refreshCustomerAccount(customer, () => { updated++; }, (err: unknown) => errors.push(err)),
    respond: (status = 200) => complete(new Response(JSON.stringify(status === 200 ? { customer: {
      id: 'customer-25', maestro_user_id: 'player-25', first_name: 'Player', username: 'player25',
      brand: 'Account brand', vip_tier: 'Gold', jurisdiction: 'TR', mobile: '+90 555',
      mobiles: [{ id: 'mobile-25', value: '+90 555', is_primary: true }],
    } } : { error: 'Account service unavailable' }), { status })),
  };
}

describe('customer account refresh in the browser', () => {
  it('fills the displayed fields and contacts without requesting again on rerender', async () => {
    const h = setup();
    const pending = h.refresh();
    await h.refresh();
    expect(h.requests()).toBe(1);
    h.respond();
    await pending;
    expect(h.customer.vip).toBe('Gold');
    expect(h.customer.brand).toBe('Account brand');
    expect(h.customer.jurisdiction).toBe('TR');
    expect(h.customer.mobile).toBe('+90 555');
    expect(h.customer.mobiles[0].value).toBe('+90 555');
    expect(h.updated()).toBe(1);
    await h.refresh();
    expect(h.requests()).toBe(1);
  });

  it('discards an old response after a workspace or login change', async () => {
    for (const switchSession of [
      (ctx: any) => ctx.setWorkspaceId('workspace-B'),
      (ctx: any) => ctx.setJwt('session-B'),
      (ctx: any) => { ctx.customers.length = 0; },
    ]) {
      const h = setup();
      const pending = h.refresh();
      switchSession(h.context);
      h.respond();
      await pending;
      expect(h.customer.vip).toBe('');
      expect(h.updated()).toBe(0);
    }
  });

  it('does not overwrite an edit made while the account request was running', async () => {
    const h = setup();
    const pending = h.refresh();
    h.customer.mobile = '+44 manual';
    h.respond();
    await pending;
    expect(h.customer.mobile).toBe('+44 manual');
    expect(h.updated()).toBe(0);
  });

  it('reports failures, throttles rerenders and permits a later retry', async () => {
    const h = setup();
    const pending = h.refresh();
    h.respond(502);
    await pending;
    expect(h.errors).toHaveLength(1);
    expect(h.customer.vip).toBe('');
    await h.refresh();
    expect(h.requests()).toBe(1);
    h.advance();
    const retry = h.refresh();
    expect(h.requests()).toBe(2);
    h.respond();
    await retry;
    expect(h.customer.vip).toBe('Gold');
  });

  it('never requests data for demo, erased or merged customers', async () => {
    for (const extra of [{ _uuid: null }, { erased: true }, { mergedInto: 'M1' }, { _mergedIntoUuid: 'survivor' }]) {
      const h = setup();
      Object.assign(h.customer, extra);
      await h.refresh();
      expect(h.requests()).toBe(0);
    }
  });
});
