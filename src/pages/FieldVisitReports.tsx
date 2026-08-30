import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  ExternalLink,
  MapPin,
  RefreshCw
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

type SalesSummary = {
  salesUid: string;
  salesName: string;
  visitCount: number;
  completedCount: number;
  activeCount: number;
  totalDurationSeconds: number;
};

type VisitCluster = {
  visits: FieldVisit[];
  latitude: number;
  longitude: number;
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
const VISIT_CLUSTER_DISTANCE_PX = 42;

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
  const [visits, setVisits] = useState<FieldVisit[]>([]);
  const [sales, setSales] = useState<SalesSummary[]>([]);
  const [selectedVisitId, setSelectedVisitId] = useState('');
  const [selectedVisitPhoto, setSelectedVisitPhoto] = useState<string>('');
  const [photoLoading, setPhotoLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapFocusVersion, setMapFocusVersion] = useState(0);
  const [mapZoomVersion, setMapZoomVersion] = useState(0);
  const [error, setError] = useState('');

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
      setSales(data.sales || []);
      setSelectedVisitId((current) =>
        current && nextVisits.some((visit: FieldVisit) => visit.id === current) ? current : ''
      );
    } catch (err: any) {
      setError(err.message || 'Unable to load field visit report.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReport();
  }, [token, hasAccess, isAdmin, salesUid, startDate, endDate]);

  const filteredVisits = visits;

  const selectedVisit = useMemo(
    () => filteredVisits.find((visit) => visit.id === selectedVisitId) || null,
    [filteredVisits, selectedVisitId]
  );

  const detailVisit = useMemo(() => {
    if (selectedVisit) return selectedVisit;
    return filteredVisits[0] || null;
  }, [filteredVisits, selectedVisit]);

  const focusVisit = (visitId: string) => {
    setSelectedVisitId(visitId);
    setMapFocusVersion((previous) => previous + 1);
  };

  const showAllVisits = () => {
    setSelectedVisitId('');
    setMapFocusVersion((previous) => previous + 1);
  };

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

  const buildVisitClusters = (map: any, visits: FieldVisit[]): VisitCluster[] => {
    const zoom = typeof map.getZoom === 'function' ? map.getZoom() : 5;
    const projectedVisits = visits.map((visit) => ({
      visit,
      point: map.project(
        [
          Number(visit.checkInLocation?.latitude),
          Number(visit.checkInLocation?.longitude)
        ],
        zoom
      )
    }));

    const clusters: VisitCluster[] = [];

    projectedVisits.forEach(({ visit, point }) => {
      const existingCluster = clusters.find((cluster) => {
        const clusterPoint = map.project([cluster.latitude, cluster.longitude], zoom);
        const dx = clusterPoint.x - point.x;
        const dy = clusterPoint.y - point.y;
        return Math.sqrt(dx * dx + dy * dy) <= VISIT_CLUSTER_DISTANCE_PX;
      });

      if (!existingCluster) {
        clusters.push({
          visits: [visit],
          latitude: Number(visit.checkInLocation?.latitude),
          longitude: Number(visit.checkInLocation?.longitude)
        });
        return;
      }

      existingCluster.visits.push(visit);
      const clusterSize = existingCluster.visits.length;
      existingCluster.latitude =
        existingCluster.visits.reduce((sum, item) => sum + Number(item.checkInLocation?.latitude), 0) / clusterSize;
      existingCluster.longitude =
        existingCluster.visits.reduce((sum, item) => sum + Number(item.checkInLocation?.longitude), 0) / clusterSize;
    });

    return clusters;
  };

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
        map.on('zoomend', () => {
          setMapZoomVersion((previous) => previous + 1);
        });
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

    const clusters = buildVisitClusters(map, points);

    clusters.forEach((cluster) => {
      const containsSelectedVisit = !!selectedVisit && cluster.visits.some((visit) => visit.id === selectedVisit.id);
      const hasActiveVisit = cluster.visits.some((visit) => visit.status === 'Active');
      const isCluster = cluster.visits.length > 1;
      const markerColor = containsSelectedVisit
        ? '#4f46e5'
        : hasActiveVisit
        ? '#ef4444'
        : '#10b981';
      const borderColor = containsSelectedVisit ? '#312e81' : '#ffffff';
      const markerSize = isCluster ? 42 : 20;
      const markerLabel = isCluster ? String(cluster.visits.length) : '';
      const icon = L.divIcon({
        className: 'field-visit-marker',
        html: `<div style="width:${markerSize}px;height:${markerSize}px;border-radius:9999px;border:${isCluster ? 4 : 3}px solid ${borderColor};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:${isCluster ? 13 : 0}px;color:#fff;box-shadow:0 10px 25px rgba(15,23,42,.22);background:${markerColor};">${markerLabel}</div>`,
        iconSize: [markerSize, markerSize],
        iconAnchor: [markerSize / 2, markerSize / 2]
      });

      const marker = L.marker([cluster.latitude, cluster.longitude], { icon });
      marker.on('click', () => {
        if (!isCluster) {
          focusVisit(cluster.visits[0].id);
          return;
        }
        const currentIndex = selectedVisit ? cluster.visits.findIndex((visit) => visit.id === selectedVisit.id) : -1;
        const nextVisit = cluster.visits[(currentIndex + 1 + cluster.visits.length) % cluster.visits.length];
        focusVisit(nextVisit.id);
      });
      marker.bindTooltip(
        isCluster
          ? `${cluster.visits.length} visits in this area`
          : `${cluster.visits[0].customerName} · ${cluster.visits[0].salesName}`,
        { direction: 'top' }
      );
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
  }, [mapFocusVersion, mapZoomVersion, points, selectedVisit]);

  const setPreset = (preset: DatePreset) => {
    const range = getPresetRange(preset);
    setStartDate(range.start);
    setEndDate(range.end);
  };

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
        </div>
      </PageHeader>

      <div className="flex-1 overflow-hidden p-4 md:p-6">
        <div className="mx-auto flex h-full max-w-[1700px] flex-col gap-4">
          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
              {error}
            </div>
          )}

          <div className="grid min-h-0 flex-1 gap-4 grid-rows-[minmax(270px,.78fr)_minmax(340px,1.22fr)]">
            <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.45fr)_360px]">
            <section className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
                <div>
                  <h2 className="text-lg font-black text-slate-900">Visit Map</h2>
                  <p className="text-sm text-slate-500">
                    {filteredVisits.length} visit records in this range
                  </p>
                </div>
                <div className="rounded-2xl bg-slate-100 px-3 py-2 text-xs font-black uppercase tracking-wide text-slate-500">
                  Auckland Time
                </div>
              </div>

              <div className="relative min-h-0 flex-1 overflow-hidden bg-[linear-gradient(180deg,#f8fafc_0%,#eef2ff_100%)]">
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
                {points.length > 1 && (
                  <div className="absolute bottom-5 right-5 z-20">
                    <button
                      type="button"
                      onClick={showAllVisits}
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

            <aside className="min-h-0">
              <section className="flex h-full min-h-0 flex-col rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
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
                  <div className="mt-4 space-y-3">
                    <div>
                      <p className="text-xl font-black text-slate-900">{detailVisit.customerName}</p>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        {detailVisit.salesName} · {formatVisitTime(detailVisit.startedAt)}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-2xl bg-slate-50 p-2.5">
                        <p className="text-xs font-bold text-slate-400">Duration</p>
                        <p className="mt-1 font-black text-slate-800">
                          {formatDuration(detailVisit.durationSeconds)}
                        </p>
                      </div>
                      <div className="rounded-2xl bg-slate-50 p-2.5">
                        <p className="text-xs font-bold text-slate-400">Outcome</p>
                        <p className="mt-1 font-black text-slate-800">
                          {detailVisit.outcome || detailVisit.status}
                        </p>
                      </div>
                    </div>

                    {detailVisit.purpose && (
                      <div className="rounded-2xl bg-indigo-50 p-2.5 text-sm font-semibold text-indigo-800 line-clamp-2">
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
                            className="h-36 w-full bg-white object-cover"
                          />
                        ) : (
                          <div className="flex h-36 items-center justify-center bg-white px-4 text-center text-sm text-slate-400">
                            {photoLoading ? 'Loading visit photo...' : 'Visit photo is not available.'}
                          </div>
                        )}
                      </div>
                    )}

                    {detailVisit.summary && (
                      <div className="rounded-2xl border border-slate-200 bg-white p-3">
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Summary</p>
                        <p className="mt-1 text-sm leading-relaxed text-slate-600 line-clamp-4">{detailVisit.summary}</p>
                      </div>
                    )}

                    {detailVisit.nextAction && (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5">
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
            </aside>
            </div>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-lg font-black text-slate-900">Visit Records</h2>
                <p className="text-sm text-slate-500">
                  Click any row to refocus the map and load its visit details
                </p>
              </div>
              <CalendarDays className="h-5 w-5 text-slate-400" />
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wider text-slate-400">
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
                        onClick={() => focusVisit(visit.id)}
                      >
                        <td className="px-4 py-3">
                          <p className="font-black text-slate-900">{visit.customerName}</p>
                          {visit.contactName && <p className="text-xs text-slate-500">{visit.contactName}</p>}
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-700">{visit.salesName}</td>
                        <td className="px-4 py-3 text-slate-600">{formatVisitTime(visit.startedAt)}</td>
                        <td className="px-4 py-3 font-mono font-bold text-slate-700">
                          {formatDuration(visit.durationSeconds)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-xl bg-indigo-50 px-3 py-1 text-xs font-black text-indigo-700">
                            {visit.outcome || visit.status}
                          </span>
                        </td>
                        <td className="max-w-md px-4 py-3 text-slate-600">
                          <p className="line-clamp-1">{visit.summary || visit.purpose || '-'}</p>
                        </td>
                        <td className="px-4 py-3">
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
    </div>
  );
};
