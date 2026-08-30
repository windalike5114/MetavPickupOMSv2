import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  Clock3,
  ExternalLink,
  MapPin,
  RefreshCw,
  Route,
  Search,
  UserRound,
  Users
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../components/AuthProvider';

type VisitLocation = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt?: string;
};

type FieldVisit = {
  id: string;
  customerName: string;
  contactName?: string | null;
  purpose?: string | null;
  status: 'Active' | 'Completed';
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  checkInLocation?: VisitLocation | null;
  checkOutLocation?: VisitLocation | null;
  summary?: string | null;
  outcome?: string | null;
  nextAction?: string | null;
  salesUid: string;
  salesName: string;
  salesUsername?: string;
  hasPhoto?: boolean;
  photoDataUrl?: string;
};

type FieldVisitStats = {
  totalVisits: number;
  completedVisits: number;
  activeVisits: number;
  uniqueCustomers: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number;
  withPhoto: number;
  gpsVisits: number;
};

type SalesSummary = {
  salesUid: string;
  salesName: string;
  visitCount: number;
  completedCount: number;
  activeCount: number;
  totalDurationSeconds: number;
};

type DatePreset = 'today' | 'thisWeek' | 'lastWeek' | 'thisMonth';

const formatNzDate = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);

const dateFromNzInput = (value: string) => new Date(`${value}T00:00:00`);

const getPresetRange = (preset: DatePreset) => {
  const today = dateFromNzInput(formatNzDate(new Date()));
  const day = today.getDay();
  const mondayOffset = (day + 6) % 7;
  const start = new Date(today);
  const end = new Date(today);

  if (preset === 'today') return { start: formatNzDate(today), end: formatNzDate(today) };

  if (preset === 'thisWeek' || preset === 'lastWeek') {
    start.setDate(today.getDate() - mondayOffset + (preset === 'lastWeek' ? -7 : 0));
    end.setTime(start.getTime());
    end.setDate(start.getDate() + 6);
    return { start: formatNzDate(start), end: formatNzDate(end) };
  }

  start.setDate(1);
  end.setMonth(start.getMonth() + 1, 0);
  return { start: formatNzDate(start), end: formatNzDate(end) };
};

const formatDuration = (seconds?: number | null) => {
  const safe = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const formatVisitTime = (value?: string | null) => {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-NZ', {
    timeZone: 'Pacific/Auckland',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const getMapUrl = (location?: VisitLocation | null) => {
  if (!location) return '#';
  return `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;
};

type LeafletLike = {
  map: (...args: any[]) => any;
  tileLayer: (...args: any[]) => any;
  layerGroup: (...args: any[]) => any;
  divIcon: (...args: any[]) => any;
  marker: (...args: any[]) => any;
  latLngBounds: (...args: any[]) => any;
};

declare global {
  interface Window {
    L?: LeafletLike;
  }
}

const canUseFieldVisitReports = (roleTemplate?: string | null) => roleTemplate === 'Admin';

const LEAFLET_CSS_ID = 'field-visit-leaflet-css';
const LEAFLET_SCRIPT_ID = 'field-visit-leaflet-script';

const ensureLeaflet = (): Promise<LeafletLike> =>
  new Promise((resolve, reject) => {
    if (window.L) {
      resolve(window.L);
      return;
    }

    if (!document.getElementById(LEAFLET_CSS_ID)) {
      const link = document.createElement('link');
      link.id = LEAFLET_CSS_ID;
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }

    const existingScript = document.getElementById(LEAFLET_SCRIPT_ID) as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(window.L as LeafletLike), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Unable to load map library.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = LEAFLET_SCRIPT_ID;
    script.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => resolve(window.L as LeafletLike);
    script.onerror = () => reject(new Error('Unable to load map library.'));
    document.body.appendChild(script);
  });

export const FieldVisitReports: React.FC = () => {
  const { token, profile } = useAuth();
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerLayerRef = useRef<any>(null);
  const initialRange = useMemo(() => getPresetRange('thisWeek'), []);
  const [startDate, setStartDate] = useState(initialRange.start);
  const [endDate, setEndDate] = useState(initialRange.end);
  const [salesUid, setSalesUid] = useState('all');
  const [search, setSearch] = useState('');
  const [visits, setVisits] = useState<FieldVisit[]>([]);
  const [stats, setStats] = useState<FieldVisitStats | null>(null);
  const [sales, setSales] = useState<SalesSummary[]>([]);
  const [selectedVisitId, setSelectedVisitId] = useState('');
  const [selectedVisitPhoto, setSelectedVisitPhoto] = useState<string>('');
  const [photoLoading, setPhotoLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [error, setError] = useState('');

  const deferredSearch = useDeferredValue(search);
  const isAdmin = profile?.roleTemplate === 'Admin';
  const hasAccess = canUseFieldVisitReports(profile?.roleTemplate);

  const loadReport = async () => {
    if (!token || !hasAccess) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ start: startDate, end: endDate });
      if (isAdmin && salesUid !== 'all') params.set('salesUid', salesUid);

      const response = await fetch(`/api/field-visits/report?${params.toString()}`, {
        headers: { 'x-v2-auth-token': `Bearer ${token}` }
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load field visit report.');

      const nextVisits = data.visits || [];
      setVisits(nextVisits);
      setStats(data.stats || null);
      setSales(data.sales || []);
      setSelectedVisitId((current) => {
        if (current && nextVisits.some((visit: FieldVisit) => visit.id === current)) return current;
        return nextVisits[0]?.id || '';
      });
    } catch (err: any) {
      setError(err.message || 'Unable to load field visit report.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReport();
  }, [token, hasAccess, isAdmin, salesUid, startDate, endDate]);

  const filteredVisits = useMemo(() => {
    const keyword = deferredSearch.trim().toLowerCase();
    if (!keyword) return visits;

    return visits.filter((visit) =>
      [
        visit.customerName,
        visit.contactName,
        visit.purpose,
        visit.summary,
        visit.outcome,
        visit.nextAction,
        visit.salesName
      ].some((value) => String(value || '').toLowerCase().includes(keyword))
    );
  }, [deferredSearch, visits]);

  const selectedVisit = useMemo(
    () => filteredVisits.find((visit) => visit.id === selectedVisitId) || null,
    [filteredVisits, selectedVisitId]
  );

  const detailVisit = useMemo(() => {
    if (selectedVisit) return selectedVisit;
    return filteredVisits[0] || null;
  }, [filteredVisits, selectedVisit]);

  useEffect(() => {
    if (!token || !detailVisit?.id) {
      setSelectedVisitPhoto('');
      setPhotoLoading(false);
      return;
    }

    if (!detailVisit.hasPhoto) {
      setSelectedVisitPhoto('');
      setPhotoLoading(false);
      return;
    }

    let cancelled = false;

    const loadVisitPhoto = async () => {
      setPhotoLoading(true);
      try {
        const response = await fetch(`/api/field-visits/${detailVisit.id}`, {
          headers: { 'x-v2-auth-token': `Bearer ${token}` }
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load visit photo.');
        if (!cancelled) setSelectedVisitPhoto(data.visit?.photoDataUrl || '');
      } catch (err: any) {
        if (!cancelled) {
          setSelectedVisitPhoto('');
          setError(err.message || 'Unable to load visit photo.');
        }
      } finally {
        if (!cancelled) setPhotoLoading(false);
      }
    };

    loadVisitPhoto();

    return () => {
      cancelled = true;
    };
  }, [detailVisit?.hasPhoto, detailVisit?.id, token]);

  const points = useMemo(
    () =>
      filteredVisits.filter(
        (visit) =>
          Number.isFinite(Number(visit.checkInLocation?.latitude)) &&
          Number.isFinite(Number(visit.checkInLocation?.longitude))
      ),
    [filteredVisits]
  );

  useEffect(() => {
    if (!hasAccess || !mapContainerRef.current || mapRef.current) return;

    let cancelled = false;

    const initMap = async () => {
      setMapLoading(true);
      try {
        const L = await ensureLeaflet();
        if (cancelled || !mapContainerRef.current) return;

        const map = L.map(mapContainerRef.current, {
          zoomControl: true,
          scrollWheelZoom: true
        }).setView([-41.2865, 174.7762], 5);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        const markerLayer = L.layerGroup().addTo(map);
        mapRef.current = map;
        markerLayerRef.current = markerLayer;
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Unable to initialize map.');
      } finally {
        if (!cancelled) setMapLoading(false);
      }
    };

    initMap();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      markerLayerRef.current = null;
    };
  }, [hasAccess]);

  useEffect(() => {
    if (!mapRef.current || !markerLayerRef.current || !window.L) return;

    const L = window.L;
    const map = mapRef.current;
    const markerLayer = markerLayerRef.current;
    markerLayer.clearLayers();

    if (!points.length) {
      map.setView([-41.2865, 174.7762], 5, { animate: true });
      return;
    }

    const latLngs = points.map((visit) => [
      Number(visit.checkInLocation?.latitude),
      Number(visit.checkInLocation?.longitude)
    ]);

    points.forEach((visit, index) => {
      const isSelected = selectedVisit?.id === visit.id;
      const statusClasses = isSelected
        ? 'background:#4f46e5;border-color:#312e81;color:#fff;'
        : visit.status === 'Active'
        ? 'background:#ef4444;border-color:#fecaca;color:#fff;'
        : 'background:#10b981;border-color:#ffffff;color:#fff;';

      const icon = L.divIcon({
        className: 'field-visit-marker',
        html: `<div style="width:34px;height:34px;border-radius:9999px;border:4px solid;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;box-shadow:0 10px 25px rgba(15,23,42,.22);${statusClasses}">${index + 1}</div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17]
      });

      const marker = L.marker(
        [Number(visit.checkInLocation?.latitude), Number(visit.checkInLocation?.longitude)],
        { icon }
      );
      marker.on('click', () => setSelectedVisitId(visit.id));
      marker.bindTooltip(`${visit.customerName} · ${visit.salesName}`, { direction: 'top' });
      marker.addTo(markerLayer);
    });

    if (selectedVisit?.checkInLocation) {
      map.flyTo(
        [
          Number(selectedVisit.checkInLocation.latitude),
          Number(selectedVisit.checkInLocation.longitude)
        ],
        15,
        { animate: true, duration: 0.8 }
      );
      return;
    }

    const bounds = L.latLngBounds(latLngs);
    map.fitBounds(bounds.pad(0.2), { animate: true, maxZoom: 13 });
  }, [points, selectedVisit]);

  const setPreset = (preset: DatePreset) => {
    const range = getPresetRange(preset);
    setStartDate(range.start);
    setEndDate(range.end);
  };

  const statCards = [
    {
      label: 'Total Visits',
      value: stats?.totalVisits || 0,
      helper: `${stats?.gpsVisits || 0} with GPS`,
      icon: Route,
      accent: 'bg-indigo-100 text-indigo-700'
    },
    {
      label: 'Customers',
      value: stats?.uniqueCustomers || 0,
      helper: `${stats?.withPhoto || 0} with photo`,
      icon: Users,
      accent: 'bg-emerald-100 text-emerald-700'
    },
    {
      label: 'Completed',
      value: stats?.completedVisits || 0,
      helper: `${stats?.activeVisits || 0} still active`,
      icon: BarChart3,
      accent: 'bg-amber-100 text-amber-700'
    },
    {
      label: 'Average Visit',
      value: formatDuration(stats?.averageDurationSeconds),
      helper: `${formatDuration(stats?.totalDurationSeconds)} total`,
      icon: Clock3,
      accent: 'bg-slate-100 text-slate-700'
    }
  ];

  if (!hasAccess) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-slate-50">
        <PageHeader
          title="Field Visit Reports"
          subtitle="Weekly route map and visit summary for sales fieldwork"
          icon={MapPin}
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
              <MapPin className="h-6 w-6" />
            </div>
            <h2 className="mt-4 text-2xl font-black text-slate-900">Field visit access required</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              This page is available to Admin accounts only.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50">
      <PageHeader
        title="Field Visit Reports"
        subtitle="Weekly route map and visit summary for sales fieldwork"
        icon={MapPin}
        maxWidth="max-w-[1700px]"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/field-visits"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50"
            >
              Open Field Visits
            </Link>
            <button
              onClick={loadReport}
              disabled={loading}
              className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        }
      >
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,.95fr)_260px]">
          <div className="rounded-3xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex flex-wrap gap-2">
              {(['today', 'thisWeek', 'lastWeek', 'thisMonth'] as DatePreset[]).map((preset) => (
                <button
                  key={preset}
                  onClick={() => setPreset(preset)}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-black uppercase tracking-wide text-slate-600 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                >
                  {preset === 'today'
                    ? 'Today'
                    : preset === 'thisWeek'
                    ? 'This Week'
                    : preset === 'lastWeek'
                    ? 'Last Week'
                    : 'This Month'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-3xl border border-slate-200 bg-white p-3 shadow-sm">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none focus:border-indigo-500 focus:bg-white"
            />
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700 outline-none focus:border-indigo-500 focus:bg-white"
            />
          </div>

          {isAdmin ? (
            <select
              value={salesUid}
              onChange={(e) => setSalesUid(e.target.value)}
              className="rounded-3xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm outline-none focus:border-indigo-500"
            >
              <option value="all">All salespeople</option>
              {sales.map((person) => (
                <option key={person.salesUid} value={person.salesUid}>
                  {person.salesName}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex items-center rounded-3xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="rounded-xl bg-indigo-100 p-2 text-indigo-700">
                <UserRound className="h-4 w-4" />
              </div>
              <div className="ml-3">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Viewing</p>
                <p className="text-sm font-black text-slate-900">{profile?.name || profile?.username}</p>
              </div>
            </div>
          )}
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-[1700px] space-y-5">
          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
              {error}
            </div>
          )}

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.22em] text-slate-400">Visit Summary</p>
                <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-900">
                  Review fieldwork by route, customer and salesperson
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  GPS points come from check-in records and stay read-only here.
                </p>
              </div>
              <div className="relative w-full lg:w-96">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search customer, purpose, summary..."
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-10 pr-4 text-sm outline-none focus:border-indigo-500 focus:bg-white"
                />
              </div>
            </div>
          </section>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {statCards.map((card) => (
              <section key={card.label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">{card.label}</p>
                    <p className="mt-3 text-3xl font-black tracking-tight text-slate-900">{card.value}</p>
                    <p className="mt-1 text-sm text-slate-500">{card.helper}</p>
                  </div>
                  <div className={`rounded-2xl p-3 ${card.accent}`}>
                    <card.icon className="h-5 w-5" />
                  </div>
                </div>
              </section>
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,.65fr)]">
            <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
                <div>
                  <h2 className="text-lg font-black text-slate-900">Visit Map</h2>
                  <p className="text-sm text-slate-500">
                    {filteredVisits.length} visit records in range
                  </p>
                </div>
                <div className="rounded-2xl bg-slate-100 px-3 py-2 text-xs font-black uppercase tracking-wide text-slate-500">
                  Auckland Time
                </div>
              </div>

              <div className="relative h-[520px] overflow-hidden bg-[linear-gradient(180deg,#f8fafc_0%,#eef2ff_100%)]">
                <div ref={mapContainerRef} className="absolute inset-0 h-full w-full" />
                <div className="pointer-events-none absolute inset-0 bg-white/5" />
                <div className="pointer-events-none absolute left-5 top-5 rounded-2xl border border-white/70 bg-white/90 px-4 py-3 shadow-sm backdrop-blur">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Date Range</p>
                  <p className="mt-1 text-sm font-black text-slate-800">
                    {startDate} to {endDate}
                  </p>
                </div>
                <div className="pointer-events-none absolute right-5 top-5 rounded-2xl border border-white/70 bg-white/90 px-4 py-3 text-right shadow-sm backdrop-blur">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Map Mode</p>
                  <p className="mt-1 text-sm font-black text-slate-800">
                    {selectedVisit ? 'Selected Visit' : 'All Visible Visits'}
                  </p>
                </div>
                {selectedVisit && points.length > 1 && (
                  <div className="absolute bottom-5 right-5 z-20">
                    <button
                      type="button"
                      onClick={() => setSelectedVisitId('')}
                      className="rounded-2xl border border-white/80 bg-white/95 px-4 py-2.5 text-sm font-black text-slate-800 shadow-sm backdrop-blur transition-colors hover:bg-white"
                    >
                      Show All Visits
                    </button>
                  </div>
                )}

                {mapLoading && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/60 backdrop-blur-[1px]">
                    <div className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 shadow-sm">
                      Loading map...
                    </div>
                  </div>
                )}

                {points.length === 0 ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
                    <div className="rounded-3xl border border-slate-200 bg-white/95 p-8 shadow-sm">
                      <MapPin className="mx-auto h-9 w-9 text-slate-400" />
                      <p className="mt-3 font-black text-slate-800">No GPS visits in this range</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Try another date range or salesperson filter.
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <aside className="space-y-5">
              <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-black text-slate-900">Selected Visit</h2>
                  {detailVisit?.status && (
                    <span
                      className={`rounded-xl px-3 py-1 text-xs font-black uppercase tracking-wide ${
                        detailVisit.status === 'Active'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {detailVisit.status}
                    </span>
                  )}
                </div>

                {detailVisit ? (
                  <div className="mt-4 space-y-4">
                    <div>
                      <p className="text-2xl font-black text-slate-900">{detailVisit.customerName}</p>
                      <p className="mt-1 text-sm font-semibold text-slate-500">
                        {detailVisit.salesName} · {formatVisitTime(detailVisit.startedAt)}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <p className="text-xs font-bold text-slate-400">Duration</p>
                        <p className="mt-1 font-black text-slate-800">
                          {formatDuration(detailVisit.durationSeconds)}
                        </p>
                      </div>
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <p className="text-xs font-bold text-slate-400">Outcome</p>
                        <p className="mt-1 font-black text-slate-800">
                          {detailVisit.outcome || detailVisit.status}
                        </p>
                      </div>
                    </div>

                    {detailVisit.purpose && (
                      <div className="rounded-2xl bg-indigo-50 p-3 text-sm font-semibold text-indigo-800">
                        Purpose: {detailVisit.purpose}
                      </div>
                    )}

                    {detailVisit.hasPhoto && (
                      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
                        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Visit Photo</p>
                          {photoLoading && <span className="text-xs font-semibold text-slate-500">Loading...</span>}
                        </div>
                        {selectedVisitPhoto ? (
                          <img
                            src={selectedVisitPhoto}
                            alt={`${detailVisit.customerName} visit evidence`}
                            className="h-56 w-full bg-white object-cover"
                          />
                        ) : (
                          <div className="flex h-56 items-center justify-center bg-white px-4 text-center text-sm text-slate-400">
                            {photoLoading ? 'Loading visit photo...' : 'Visit photo is not available.'}
                          </div>
                        )}
                      </div>
                    )}

                    {detailVisit.summary && (
                      <p className="text-sm leading-relaxed text-slate-600">{detailVisit.summary}</p>
                    )}

                    {detailVisit.nextAction && (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Next Action</p>
                        <p className="mt-1 text-sm font-semibold text-slate-700">
                          {detailVisit.nextAction}
                        </p>
                      </div>
                    )}

                    <a
                      href={getMapUrl(detailVisit.checkInLocation)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white transition-colors hover:bg-slate-800"
                    >
                      Open in Google Maps <ExternalLink className="h-4 w-4" />
                    </a>
                  </div>
                ) : (
                  <p className="mt-8 text-center text-sm text-slate-400">
                    Select a marker or record to inspect the visit.
                  </p>
                )}
              </section>

              {isAdmin && (
                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h2 className="text-lg font-black text-slate-900">Sales Summary</h2>
                    {salesUid !== 'all' && (
                      <button
                        type="button"
                        onClick={() => setSalesUid('all')}
                        className="text-xs font-black uppercase tracking-wide text-indigo-600"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="mt-4 space-y-3">
                    {sales.length === 0 ? (
                      <p className="py-6 text-center text-sm text-slate-400">
                        No sales activity in this range.
                      </p>
                    ) : (
                      sales.map((person) => (
                        <button
                          key={person.salesUid}
                          onClick={() => setSalesUid(person.salesUid)}
                          className={`flex w-full items-center justify-between rounded-2xl border p-3 text-left transition-colors ${
                            salesUid === person.salesUid
                              ? 'border-indigo-200 bg-indigo-50'
                              : 'border-slate-100 bg-slate-50 hover:border-indigo-200 hover:bg-indigo-50'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="rounded-xl bg-white p-2 text-indigo-600">
                              <UserRound className="h-4 w-4" />
                            </div>
                            <div>
                              <p className="font-black text-slate-900">{person.salesName}</p>
                              <p className="text-xs text-slate-500">
                                {person.completedCount} completed · {formatDuration(person.totalDurationSeconds)}
                              </p>
                            </div>
                          </div>
                          <span className="rounded-xl bg-white px-3 py-1 text-sm font-black text-slate-700">
                            {person.visitCount}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </section>
              )}
            </aside>
          </div>

          <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-lg font-black text-slate-900">Visit Records</h2>
                <p className="text-sm text-slate-500">
                  Personal weekly trace for Sales, full team overview for Admin
                </p>
              </div>
              <CalendarDays className="h-5 w-5 text-slate-400" />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-slate-50 text-xs font-black uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Sales</th>
                    <th className="px-4 py-3">Check In</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Outcome</th>
                    <th className="px-4 py-3">Summary</th>
                    <th className="px-4 py-3">Map</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                        Loading report...
                      </td>
                    </tr>
                  ) : filteredVisits.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                        No visits found.
                      </td>
                    </tr>
                  ) : (
                    filteredVisits.map((visit) => (
                      <tr
                        key={visit.id}
                        className={`cursor-pointer transition-colors hover:bg-slate-50 ${
                          selectedVisit?.id === visit.id ? 'bg-indigo-50/60' : ''
                        }`}
                        onClick={() => setSelectedVisitId(visit.id)}
                      >
                        <td className="px-4 py-4">
                          <p className="font-black text-slate-900">{visit.customerName}</p>
                          {visit.contactName && <p className="text-xs text-slate-500">{visit.contactName}</p>}
                        </td>
                        <td className="px-4 py-4 font-semibold text-slate-700">{visit.salesName}</td>
                        <td className="px-4 py-4 text-slate-600">{formatVisitTime(visit.startedAt)}</td>
                        <td className="px-4 py-4 font-mono font-bold text-slate-700">
                          {formatDuration(visit.durationSeconds)}
                        </td>
                        <td className="px-4 py-4">
                          <span className="rounded-xl bg-indigo-50 px-3 py-1 text-xs font-black text-indigo-700">
                            {visit.outcome || visit.status}
                          </span>
                        </td>
                        <td className="max-w-md px-4 py-4 text-slate-600">
                          <p className="line-clamp-2">{visit.summary || visit.purpose || '-'}</p>
                        </td>
                        <td className="px-4 py-4">
                          <a
                            href={getMapUrl(visit.checkInLocation)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            className="inline-flex items-center gap-1 rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-700 transition-colors hover:bg-slate-200"
                          >
                            Open <ExternalLink className="h-3 w-3" />
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
