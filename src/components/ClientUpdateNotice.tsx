import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { CN_API_ONLY } from '../constants';
import { startWorkPolling } from '../lib/workHours';

const checkInterval = 60_000;

export function ClientUpdateNotice() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const buildId = document.querySelector<HTMLMetaElement>('meta[name="wms-build-id"]')?.content;
    if (!import.meta.env.PROD || !buildId || buildId === 'WMS_BUILD_ID_PENDING') return;

    let pending: AbortController | undefined;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const response = await fetch('/client-build.json', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const deployed = await response.json();
        if (!controller.signal.aborted && typeof deployed.id === 'string' && deployed.id) {
          setUpdateAvailable(deployed.id !== buildId);
        }
      } catch {
        // A temporary network error should not interrupt the current session.
      }
    };

    const isCn = CN_API_ONLY || /\/cn(?:\/|$)/.test(window.location.pathname);
    const stopPolling = startWorkPolling({ site: isCn ? 'cn' : 'nz', interval: checkInterval, load: check, loadOnMount: true });
    window.addEventListener('online', check);
    window.addEventListener('vite:preloadError', check);
    return () => {
      pending?.abort();
      stopPolling();
      window.removeEventListener('online', check);
      window.removeEventListener('vite:preloadError', check);
    };
  }, []);

  if (!updateAvailable) return null;
  const isCn = CN_API_ONLY || window.location.pathname.startsWith('/cn');
  return (
    <div className="fixed bottom-4 right-4 z-[120] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-lg sm:px-4">
      <span role="status">{isCn ? '有新版本可用，保存当前工作后更新。' : 'Update available. Save your work before reloading.'}</span>
      <button type="button" onClick={() => window.location.reload()} className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-blue-700 px-3 py-2 font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">
        <RefreshCw size={14} aria-hidden="true" />{isCn ? '更新页面' : 'Reload'}
      </button>
    </div>
  );
}
