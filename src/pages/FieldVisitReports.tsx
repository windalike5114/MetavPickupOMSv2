import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const getZoomFromBounds = (latSpan: number, lngSpan: number) => {
  const span = Math.max(latSpan, lngSpan);
  if (span <= 0.01) return 17;
  if (span <= 0.03) return 15;
  if (span <= 0.08) return 13;
  if (span <= 0.18) return 12;
  if (span <= 0.4) return 11;
  if (span <= 0.8) return 10;
  if (span <= 1.6) return 9;
  if (span <= 3.2) return 8;
  return 7;
};

const canUseFieldVisitReports = (roleTemplate?: string | null) => roleTemplate === 'Admin';

export const FieldVisitReports: React.FC = () => {
  const { token, profile } = useAuth();
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

  const selectedVisit = useMemo(() => {
    if (!filteredVisits.length) return null;
    return filteredVisits.find((visit) => visit.id === selectedVisitId) || filteredVisits[0];
  }, [filteredVisits, selectedVisitId]);

  useEffect(() => {
    if (!token || !selectedVisit?.id) {
      setSelectedVisitPhoto('');
      setPhotoLoading(false);
      return;
    }

    if (!selectedVisit.hasPhoto) {
      setSelectedVisitPhoto('');
      setPhotoLoading(false);
      return;
    }

    let cancelled = false;

    const loadVisitPhoto = async () => {
      setPhotoLoading(true);
      try {
        const response = await fetch(`/api/field-visits/${selectedVisit.id}`, {
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
  }, [selectedVisit?.hasPhoto, selectedVisit?.id, token]);

  const points = useMemo(
    () =>
      filteredVisits.filter(
        (visit) =>
          Number.isFinite(Number(visit.checkInLocation?.latitude)) &&
          Number.isFinite(Number(visit.checkInLocation?.longitude))
      ),
    [filteredVisits]
  );

  const bounds = useMemo(() => {
    if (!points.length) {
      return { minLat: -43, maxLat: -36, minLng: 172, maxLng: 175 };
    }

    let minLat = Number(points[0].checkInLocation?.latitude);
    let maxLat = minLat;
    let minLng = Number(points[0].checkInLocation?.longitude);
    let maxLng = minLng;

    points.forEach((visit) => {
      const lat = Number(visit.checkInLocation?.latitude);
      const lng = Number(visit.checkInLocation?.longitude);
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    });

    const latPadding = Math.max((maxLat - minLat) * 0.18, 0.01);
    const lngPadding = Math.max((maxLng - minLng) * 0.18, 0.01);

    return {
      minLat: minLat - latPadding,
      maxLat: maxLat + latPadding,
      minLng: minLng - lngPadding,
      maxLng: maxLng + lngPadding
    };
  }, [points]);

  const markerPosition = (visit: FieldVisit) => {
    const lat = Number(visit.checkInLocation?.latitude);
    const lng = Number(visit.checkInLocation?.longitude);
    const x = ((lng - bounds.minLng) / Math.max(bounds.maxLng - bounds.minLng, 0.0001)) * 100;
    const y = (1 - (lat - bounds.minLat) / Math.max(bounds.maxLat - bounds.minLat, 0.0001)) * 100;
    return {
      left: `${Math.min(95, Math.max(5, x))}%`,
      top: `${Math.min(92, Math.max(8, y))}%`
    };
  };

  const mapEmbedUrl = useMemo(() => {
    const selectedLocation = selectedVisit?.checkInLocation;
    if (selectedLocation && Number.isFinite(Number(selectedLocation.latitude)) && Number.isFinite(Number(selectedLocation.longitude))) {
      const lat = clamp(Number(selectedLocation.latitude), -47.5, -33.5);
      const lng = clamp(Number(selectedLocation.longitude), 165.5, 179.5);
      return `https://maps.google.com/maps?q=${lat},${lng}&z=15&hl=en&output=embed`;
    }

    if (points.length > 0) {
      const centerLat = clamp((bounds.minLat + bounds.maxLat) / 2, -47.5, -33.5);
      const centerLng = clamp((bounds.minLng + bounds.maxLng) / 2, 165.5, 179.5);
      const zoom = getZoomFromBounds(bounds.maxLat - bounds.minLat, bounds.maxLng - bounds.minLng);
      return `https://maps.google.com/maps?q=${centerLat},${centerLng}&z=${zoom}&hl=en&output=embed`;
    }

    return 'https://maps.google.com/maps?q=New%20Zealand&z=5&hl=en&output=embed';
  }, [bounds.maxLat, bounds.maxLng, bounds.minLat, bounds.minLng, points.length, selectedVisit]);

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
                <iframe
                  title="Field visit map"
                  src={mapEmbedUrl}
                  className="absolute inset-0 h-full w-full border-0"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
                <div className="absolute inset-0 bg-white/10" />
                <div className="absolute left-5 top-5 rounded-2xl border border-white/70 bg-white/90 px-4 py-3 shadow-sm backdrop-blur">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Date Range</p>
                  <p className="mt-1 text-sm font-black text-slate-800">
                    {startDate} to {endDate}
                  </p>
                </div>
                <div className="absolute right-5 top-5 rounded-2xl border border-white/70 bg-white/90 px-4 py-3 text-right shadow-sm backdrop-blur">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Map Mode</p>
                  <p className="mt-1 text-sm font-black text-slate-800">
                    {selectedVisit ? 'Selected Visit' : 'All Visible Visits'}
                  </p>
                </div>

                {points.length === 0 ? (
                  <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
                    <div className="rounded-3xl border border-slate-200 bg-white/95 p-8 shadow-sm">
                      <MapPin className="mx-auto h-9 w-9 text-slate-400" />
                      <p className="mt-3 font-black text-slate-800">No GPS visits in this range</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Try another date range or salesperson filter.
                      </p>
                    </div>
                  </div>
                ) : (
                  points.map((visit, index) => (
                    <button
                      key={visit.id}
                      type="button"
                      onClick={() => setSelectedVisitId(visit.id)}
                      className={`absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 px-2.5 py-1.5 text-xs font-black shadow-lg transition-all hover:scale-105 ${
                        selectedVisit?.id === visit.id
                          ? 'border-indigo-900 bg-indigo-600 text-white'
                          : visit.status === 'Active'
                          ? 'border-red-200 bg-red-500 text-white'
                          : 'border-white bg-emerald-500 text-white'
                      }`}
                      style={markerPosition(visit)}
                      title={`${visit.customerName} - ${visit.salesName}`}
                    >
                      {index + 1}
                    </button>
                  ))
                )}
              </div>
            </section>

            <aside className="space-y-5">
              <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-black text-slate-900">Selected Visit</h2>
                  {selectedVisit?.status && (
                    <span
                      className={`rounded-xl px-3 py-1 text-xs font-black uppercase tracking-wide ${
                        selectedVisit.status === 'Active'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {selectedVisit.status}
                    </span>
                  )}
                </div>

                {selectedVisit ? (
                  <div className="mt-4 space-y-4">
                    <div>
                      <p className="text-2xl font-black text-slate-900">{selectedVisit.customerName}</p>
                      <p className="mt-1 text-sm font-semibold text-slate-500">
                        {selectedVisit.salesName} · {formatVisitTime(selectedVisit.startedAt)}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <p className="text-xs font-bold text-slate-400">Duration</p>
                        <p className="mt-1 font-black text-slate-800">
                          {formatDuration(selectedVisit.durationSeconds)}
                        </p>
                      </div>
                      <div className="rounded-2xl bg-slate-50 p-3">
                        <p className="text-xs font-bold text-slate-400">Outcome</p>
                        <p className="mt-1 font-black text-slate-800">
                          {selectedVisit.outcome || selectedVisit.status}
                        </p>
                      </div>
                    </div>

                    {selectedVisit.purpose && (
                      <div className="rounded-2xl bg-indigo-50 p-3 text-sm font-semibold text-indigo-800">
                        Purpose: {selectedVisit.purpose}
                      </div>
                    )}

                    {selectedVisit.hasPhoto && (
                      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
                        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Visit Photo</p>
                          {photoLoading && <span className="text-xs font-semibold text-slate-500">Loading...</span>}
                        </div>
                        {selectedVisitPhoto ? (
                          <img
                            src={selectedVisitPhoto}
                            alt={`${selectedVisit.customerName} visit evidence`}
                            className="h-56 w-full bg-white object-cover"
                          />
                        ) : (
                          <div className="flex h-56 items-center justify-center bg-white px-4 text-center text-sm text-slate-400">
                            {photoLoading ? 'Loading visit photo...' : 'Visit photo is not available.'}
                          </div>
                        )}
                      </div>
                    )}

                    {selectedVisit.summary && (
                      <p className="text-sm leading-relaxed text-slate-600">{selectedVisit.summary}</p>
                    )}

                    {selectedVisit.nextAction && (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Next Action</p>
                        <p className="mt-1 text-sm font-semibold text-slate-700">
                          {selectedVisit.nextAction}
                        </p>
                      </div>
                    )}

                    <a
                      href={getMapUrl(selectedVisit.checkInLocation)}
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
