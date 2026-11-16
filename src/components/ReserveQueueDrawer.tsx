import { useEffect, useRef, useState } from 'react';
import { CalendarClock, RefreshCw, Send, X } from 'lucide-react';
import { DateTime } from 'luxon';
import type { CounterPickupReservation } from '../types';

type Props = {
  token: string;
  warehouse?: string | null;
  canManage: boolean;
  onClose: () => void;
  onSent: () => Promise<void>;
};

const zone = 'Pacific/Auckland';
const queueUrl = '/api/counter-pickups/reservations';
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50';
const primary = 'inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50';

export function ReserveQueueDrawer({ token, warehouse, canManage, onClose, onSent }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<CounterPickupReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState('');
  const [detailId, setDetailId] = useState('');
  const [change, setChange] = useState<{ id: string; action: 'extend' | 'release'; expiry: string } | null>(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const load = async () => {
      try {
        const response = await fetch(queueUrl, {
          headers: { 'x-v2-auth-token': 'Bearer ' + token, 'x-warehouse-id': warehouse || '' },
          signal: controller.signal,
          cache: 'no-store'
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Could not load reservations');
        if (!controller.signal.aborted) setRows(data.reservations);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load reservations');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [refresh, token, warehouse]);

  const update = async (id: string, action: 'send' | 'extend' | 'release', expiresAt?: string) => {
    if (busy) return;
    setBusy(id);
    setError('');
    setNotice('');
    try {
      const response = await fetch(queueUrl + '/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        headers: {
          'x-v2-auth-token': 'Bearer ' + token,
          'x-warehouse-id': warehouse || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ expiresAt })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not update reservation');
      if (action !== 'extend') setRows(previous => previous.filter(row => row.id !== id));
      setChange(null);
      setRefresh(previous => previous + 1);
      if (action === 'send') {
        setNotice(id + ' moved to Pending Pickup' + (data.pickupId ? ' as ' + data.pickupId : '') + '.');
        await onSent();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update reservation');
    } finally {
      setBusy('');
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="reserve-queue-title"
      onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-xl overflow-hidden border-l border-slate-200 bg-slate-50 text-slate-900 shadow-2xl backdrop:bg-slate-900/45"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <CalendarClock className="h-5 w-5 text-indigo-700" aria-hidden="true" />
          <h2 id="reserve-queue-title" className="flex-1 text-lg font-bold">Reserve Queue</h2>
          <button type="button" className={button} aria-label="Refresh reservations" disabled={loading || !!busy} onClick={() => setRefresh(value => value + 1)}>
            <RefreshCw className="h-4 w-4" />
          </button>
          <button type="button" className={button} aria-label="Close reserve queue" disabled={!!busy} onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
          {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
          {loading ? <p role="status" className="p-3 text-sm text-slate-600">Loading reservations…</p> : !error && rows.length === 0 && (
            <p role="status" className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600">No active reservations.</p>
          )}
          {!loading && rows.map(row => {
            const expiry = DateTime.fromISO(row.expiresAt).setZone(zone);
            const expired = expiry.toMillis() <= now;
            const editing = change?.id === row.id ? change : null;
            const items = row.items?.length ? row.items : [row];
            return (
              <article key={row.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold">Reservation {row.id}</h3>
                  {expired && <span className="rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">Expired</span>}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-slate-600">Warehouse</dt><dd className="font-semibold">{row.warehouseId}</dd></div>
                  <div><dt className="text-slate-600">Owner</dt><dd className="break-words font-semibold">{row.createdBy}</dd></div>
                  <div className="col-span-2"><dt className="text-slate-600">Reserved until (NZ)</dt><dd><time dateTime={row.expiresAt}>{expiry.toFormat('dd MMM yyyy, HH:mm')}</time></dd></div>
                </dl>
                <ul className="my-4 divide-y rounded-lg border border-slate-200 px-3 text-sm">
                  {items.map((item, index) => (
                    <li key={index} className="flex justify-between gap-3 py-2">
                      <div className="min-w-0 break-words"><p className="font-semibold">{item.sku}</p><p>{item.productName}</p>
                        {detailId === row.id && <p className="text-slate-600">Location {item.location || '—'}</p>}
                      </div>
                      <span aria-label={'Reserved quantity ' + item.qty} className="font-semibold tabular-nums">×{item.qty}</span>
                    </li>
                  ))}
                </ul>
                <p className="mb-3 whitespace-pre-wrap break-words text-sm">
                  <span className="font-semibold">Pickup note: </span>{row.pickupNote || row.comment || '—'}
                </p>
                {detailId === row.id && (
                  <dl className="mb-4 space-y-2 rounded-lg bg-slate-100 p-3 text-sm">
                    <div><dt className="font-semibold">Reserved at</dt><dd>{row.id} · {DateTime.fromISO(row.createdAt).setZone(zone).toFormat('dd MMM yyyy, HH:mm')}</dd></div>
                  </dl>
                )}
                <div className="flex items-start justify-between gap-2">
                  {canManage && (
                    <button type="button" className={primary} disabled={!!busy} onClick={() => void update(row.id, 'send')}>
                      <Send className="h-4 w-4" aria-hidden="true" /> Send to Pickup
                    </button>
                  )}
                  <details className="relative ml-auto">
                    <summary aria-label={'Actions for ' + row.id} className="cursor-pointer list-none rounded-lg border border-slate-300 px-3 py-1.5 text-lg font-bold">⋯</summary>
                    <div className="absolute right-0 z-10 mt-1 grid w-40 gap-1 rounded-lg border bg-white p-1.5 shadow-lg">
                      <button type="button" className="rounded px-2 py-2 text-left text-sm hover:bg-slate-100" onClick={event => {
                        event.currentTarget.closest('details')?.removeAttribute('open');
                        setDetailId(detailId === row.id ? '' : row.id);
                      }}>{detailId === row.id ? 'Hide request' : 'View request'}</button>
                      {canManage && (['extend', 'release'] as const).map(action => (
                        <button key={action} type="button" disabled={!!busy} className="rounded px-2 py-2 text-left text-sm hover:bg-slate-100 disabled:opacity-50" onClick={event => {
                          event.currentTarget.closest('details')?.removeAttribute('open');
                          const base = expired ? DateTime.now().setZone(zone) : expiry;
                          setChange({ id: row.id, action, expiry: base.plus({ hours: 24 }).toFormat("yyyy-MM-dd'T'HH:mm") });
                        }}>{action === 'extend' ? 'Extend reservation' : 'Release reservation'}</button>
                      ))}
                    </div>
                  </details>
                </div>
                {editing && (
                  <form className="mt-4 grid gap-3 rounded-lg border border-slate-200 p-3" onSubmit={event => {
                    event.preventDefault();
                    void update(row.id, editing.action, editing.expiry);
                  }}>
                    {editing.action === 'extend' ? (
                      <label className="grid gap-1 text-sm font-semibold">
                        New expiry (NZ time)
                        <input required type="datetime-local" value={editing.expiry} className="rounded-lg border border-slate-300 p-2" onChange={event => setChange({ ...editing, expiry: event.target.value })} />
                      </label>
                    ) : <p className="text-sm">Release all items in {row.id}?</p>}
                    <div className="flex justify-end gap-2">
                      <button type="button" className={button} disabled={!!busy} onClick={() => setChange(null)}>Cancel</button>
                      <button type="submit" className={primary} disabled={!!busy}>{editing.action === 'extend' ? 'Save expiry' : 'Release'}</button>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
