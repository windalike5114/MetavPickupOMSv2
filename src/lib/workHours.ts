import { DateTime } from 'luxon';

export type WorkSite = 'cn' | 'nz';

const hours = {
  cn: { zone: 'Asia/Shanghai', startHour: 7, startMinute: 0, endHour: 19 },
  nz: { zone: 'Pacific/Auckland', startHour: 8, startMinute: 30, endHour: 18 }
};

export function getWorkWindow(site: WorkSite, now = Date.now()) {
  const { zone, startHour, startMinute, endHour } = hours[site];
  const local = DateTime.fromMillis(now, { zone });
  const start = local.startOf('day').set({ hour: startHour, minute: startMinute });
  const end = local.startOf('day').set({ hour: endHour });
  if (local < start) return { open: false, boundary: start.toMillis() };
  if (local < end) return { open: true, boundary: end.toMillis() };
  return { open: false, boundary: start.plus({ days: 1 }).toMillis() };
}

const activityEvents = ['pointerdown', 'keydown', 'wheel'] as const;
const afterHoursCooldown = 60_000;

type WorkPollingOptions = {
  site: WorkSite;
  interval: number | ((idle: boolean) => number);
  load: (mode: 'initial' | 'background') => Promise<boolean | void>;
  loadOnMount?: boolean;
  whileHidden?: boolean;
  enabled?: () => boolean;
  requestPending?: () => boolean;
};

export function startWorkPolling({ site, interval, load, loadOnMount = false, whileHidden = false, enabled = () => true, requestPending }: WorkPollingOptions) {
  let stopped = false;
  let running = false;
  let timer: number | undefined;
  let activityTimer: number | undefined;
  let lastActivity = Date.now();
  let lastLoad = -Infinity;
  const isVisible = () => document.visibilityState === 'visible';
  const isIdle = () => Date.now() - lastActivity >= 120_000;
  const delay = () => typeof interval === 'function' ? interval(isIdle()) : interval;

  const schedule = () => {
    window.clearTimeout(timer);
    if (stopped || running || !enabled() || (!whileHidden && !isVisible())) return;
    const now = Date.now();
    const work = getWorkWindow(site, now);
    const due = work.open ? Math.min(work.boundary, lastLoad + delay()) : work.boundary;
    timer = window.setTimeout(() => {
      if (!getWorkWindow(site).open) { schedule(); return; }
      if (!work.open) lastActivity = Date.now();
      if (!work.open || Date.now() - lastLoad >= delay()) void run('background');
      else schedule();
    }, Math.max(0, due - now));
  };

  const run = async (mode: 'initial' | 'background') => {
    if (stopped || running || (mode !== 'initial' && (!enabled() || (!whileHidden && !isVisible())))) return;
    window.clearTimeout(timer);
    running = true;
    try {
      if (await load(mode)) lastActivity = Date.now();
    } catch (error) {
      console.error('Scheduled refresh failed:', error);
    } finally {
      running = false;
      lastLoad = Date.now();
      schedule();
    }
  };

  const onActivity = () => {
    if (!isVisible() || !enabled()) return;
    const wasIdle = isIdle();
    lastActivity = Date.now();
    if (getWorkWindow(site).open) {
      if (wasIdle) schedule();
      return;
    }
    if (running || activityTimer !== undefined || Date.now() - lastLoad < afterHoursCooldown) return;
    activityTimer = window.setTimeout(() => {
      activityTimer = undefined;
      if (isVisible() && !requestPending?.()) void run('background');
    }, 250);
  };

  const onVisibility = () => {
    if (isVisible() && getWorkWindow(site).open && enabled()) {
      lastActivity = Date.now();
      void run('background');
    } else schedule();
  };

  activityEvents.forEach(event => document.addEventListener(event, onActivity, { passive: true }));
  document.addEventListener('visibilitychange', onVisibility);
  if (loadOnMount) void run('initial');
  else schedule();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearTimeout(activityTimer);
    activityEvents.forEach(event => document.removeEventListener(event, onActivity));
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export function subscribeDuringWorkHours(site: WorkSite, subscribe: () => () => void, readOnce?: () => Promise<void>, readOnMount = true) {
  let timer: number | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastRead = -Infinity;

  const check = () => {
    window.clearTimeout(timer);
    const work = getWorkWindow(site);
    if (work.open && !unsubscribe) unsubscribe = subscribe();
    if (!work.open && unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
    timer = window.setTimeout(check, Math.max(0, work.boundary - Date.now()));
  };
  const onActivity = () => {
    if (!readOnce || document.visibilityState !== 'visible' || getWorkWindow(site).open || Date.now() - lastRead < afterHoursCooldown) return;
    lastRead = Date.now();
    void readOnce().catch(error => console.error('Requested refresh failed:', error));
  };

  check();
  if (readOnMount) onActivity();
  if (readOnce) activityEvents.forEach(event => document.addEventListener(event, onActivity, { passive: true }));
  document.addEventListener('visibilitychange', check);
  return () => {
    window.clearTimeout(timer);
    unsubscribe?.();
    if (readOnce) activityEvents.forEach(event => document.removeEventListener(event, onActivity));
    document.removeEventListener('visibilitychange', check);
  };
}
