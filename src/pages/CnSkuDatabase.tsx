import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { useAuth } from '../components/AuthProvider';
import { PageHeader } from '../components/PageHeader';
import { useDebounce } from '../hooks/useDebounce';
import { hasPermission } from '../utils';
import type { SKU } from '../types';

export function CnSkuDatabase() {
  const { profile, token } = useAuth();
  const canView = hasPermission(profile, 'View SKU', profile?.email) && profile?.roleTemplate !== 'Warehouse';
  const [search, setSearch] = useState('');
  const term = useDebounce(search.trim(), 250);
  const [cursor, setCursor] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<SKU[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!token || !canView) return;
    if (term.length === 1) return;
    const controller = new AbortController();
    const params = new URLSearchParams(term ? { q: term, limit: '50' } : { after: cursor });
    if (!cursor) params.delete('after');
    const route = term ? 'search' : 'list';
    setLoading(true);
    setError(false);
    const load = async () => {
      try {
        const response = await fetch('/api/skus/' + route + '?' + params, {
          headers: { 'x-v2-auth-token': 'Bearer ' + token },
          signal: controller.signal
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error('SKU request failed');
        if (!controller.signal.aborted) {
          setRows(data.skus);
          setNextCursor(data.nextCursor ?? null);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [canView, cursor, term, token]);

  if (!canView) return <p className="p-6" role="status">You do not have permission to view SKU data.</p>;

  return (
    <section className="flex h-full flex-col overflow-auto">
      <PageHeader title="SKU 资料库" icon={Database} compact>
        <input
          aria-label="搜索 SKU 或参考号"
          placeholder="搜索 SKU 或参考号"
          className="w-full max-w-md rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
          value={search}
          onChange={event => { setSearch(event.target.value); setCursor(''); }}
        />
      </PageHeader>
      <div className="p-4 md:p-6">
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[580px] text-left text-sm text-slate-800">
            <thead className="bg-slate-100 text-slate-900">
              <tr>{['SKU', '商品名称', '参考号 1', '参考号 2'].map(title => <th key={title} className="px-4 py-3">{title}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading || error || term.length === 1 || rows.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-6" role="status">
                  {term.length === 1 ? '请输入至少两个字符' : loading ? '加载中…' : error ? '加载失败，请刷新页面重试' : '未找到 SKU'}
                </td></tr>
              ) : rows.map(sku => (
                <tr key={sku.id ?? sku.sku}>
                  <td className="px-4 py-3 font-semibold">{sku.sku}</td>
                  <td className="px-4 py-3">{sku.productName}</td>
                  <td className="px-4 py-3">{sku.ref1 || '—'}</td>
                  <td className="px-4 py-3">{sku.ref2 || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!term && !loading && !error && (
          <div className="mt-4 flex gap-2">
            {cursor && <button className="rounded-lg border bg-white px-3 py-2" onClick={() => setCursor('')}>返回首页</button>}
            {nextCursor && <button className="rounded-lg border bg-white px-3 py-2" onClick={() => setCursor(nextCursor)}>下一页</button>}
          </div>
        )}
      </div>
    </section>
  );
}
