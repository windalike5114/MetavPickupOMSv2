import React, { useEffect, useMemo, useState } from 'react';
import { Camera, CheckCircle2, Clock3, LocateFixed, MapPin, Navigation, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider';
import { PageHeader } from '../components/PageHeader';

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
  checkInLocation: VisitLocation;
  checkOutLocation?: VisitLocation | null;
  summary?: string | null;
  outcome?: string | null;
  nextAction?: string | null;
  salesName: string;
  hasPhoto?: boolean;
  checkoutDistanceMeters?: number | null;
  checkoutMode?: 'OnSite' | 'RemoteOverride';
  checkoutExceptionReason?: string | null;
};

type LocationPermissionState = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported';

const formatDuration = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hours, minutes, secs].map(value => String(value).padStart(2, '0')).join(':');
};

const getLocation = () => new Promise<VisitLocation>((resolve, reject) => {
  if (!navigator.geolocation) {
    reject(new Error('This device does not support GPS location.'));
    return;
  }
  navigator.geolocation.getCurrentPosition(
    position => resolve({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: Math.round(position.coords.accuracy)
    }),
    error => reject(new Error(error.code === error.PERMISSION_DENIED
      ? 'Location permission was denied. Enable location access and try again.'
      : 'Unable to obtain your current location. Move outdoors and try again.')),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
});

const compressPhoto = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Unable to read the selected photo.'));
  reader.onload = () => {
    const image = new Image();
    image.onerror = () => reject(new Error('The selected image could not be opened.'));
    image.onload = () => {
      const maxSide = 1200;
      const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * ratio));
      canvas.height = Math.max(1, Math.round(image.height * ratio));
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.68);
      if (dataUrl.length > 700_000) {
        reject(new Error('Photo is still too large. Please use a lower-resolution photo.'));
        return;
      }
      resolve(dataUrl);
    };
    image.src = String(reader.result);
  };
  reader.readAsDataURL(file);
});

export const FieldVisits: React.FC = () => {
  const { token, profile } = useAuth();
  const [visits, setVisits] = useState<FieldVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [customerName, setCustomerName] = useState('');
  const [contactName, setContactName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState('');
  const [summary, setSummary] = useState('');
  const [outcome, setOutcome] = useState('Follow-up');
  const [nextAction, setNextAction] = useState('');
  const [checkoutExceptionReason, setCheckoutExceptionReason] = useState('');
  const [showRemoteCheckout, setShowRemoteCheckout] = useState(false);
  const [checkoutDistanceHint, setCheckoutDistanceHint] = useState<{ distance: number; allowed: number } | null>(null);
  const [locationPermission, setLocationPermission] = useState<LocationPermissionState>('unknown');

  const activeVisit = useMemo(() => visits.find(visit => visit.status === 'Active'), [visits]);
  const completedVisits = useMemo(() => visits.filter(visit => visit.status === 'Completed'), [visits]);
  const hasAccess = !!profile;
  const canViewReports = profile?.roleTemplate === 'Admin';

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshLocationPermission = async () => {
    if (!navigator.geolocation) {
      setLocationPermission('unsupported');
      return 'unsupported';
    }

    if (!navigator.permissions?.query) {
      setLocationPermission('prompt');
      return 'prompt';
    }

    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      const syncPermission = () => setLocationPermission(permission.state as LocationPermissionState);
      syncPermission();
      permission.onchange = syncPermission;
      return permission.state as LocationPermissionState;
    } catch {
      setLocationPermission('prompt');
      return 'prompt';
    }
  };

  useEffect(() => {
    refreshLocationPermission();
  }, []);

  const request = async (path: string, options: RequestInit = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-v2-auth-token': `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      const error: any = new Error(data.error || 'Request failed');
      error.code = data.code;
      error.details = data.details;
      throw error;
    }
    return data;
  };

  const loadVisits = async () => {
    if (!token || !hasAccess) return;
    setLoading(true);
    setError('');
    try {
      const data = await request('/api/field-visits?mine=true');
      setVisits(data.visits || []);
    } catch (err: any) {
      setError(err.message || 'Unable to load visits.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadVisits(); }, [token]);

  if (!hasAccess) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-slate-50">
        <PageHeader
          title="Field Visits"
          subtitle="GPS check-in, site photo and visit duration"
          icon={MapPin}
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
              <MapPin className="h-6 w-6" />
            </div>
            <h2 className="mt-4 text-2xl font-black text-slate-900">Field visit access required</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              This page is available to signed-in users only.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const handlePhoto = async (file?: File) => {
    if (!file) return;
    setError('');
    try {
      setPhotoDataUrl(await compressPhoto(file));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const enableLocation = async () => {
    setBusy(true);
    setError('');
    try {
      const permission = await refreshLocationPermission();
      if (permission === 'unsupported') {
        setError('This device does not support GPS location.');
        return;
      }
      if (permission === 'denied') {
        setError('Location is blocked for this website. Open browser site settings and allow Location for acapickup.com, then refresh the page.');
        return;
      }
      await getLocation();
      setLocationPermission('granted');
    } catch (err: any) {
      await refreshLocationPermission();
      setError(err.message || 'Unable to request location permission.');
    } finally {
      setBusy(false);
    }
  };

  const checkIn = async () => {
    if (!customerName.trim()) return setError('Enter the customer name.');
    if (!photoDataUrl) return setError('Take a site photo before checking in.');
    setBusy(true);
    setError('');
    try {
      const location = await getLocation();
      setLocationPermission('granted');
      const data = await request('/api/field-visits/check-in', {
        method: 'POST',
        body: JSON.stringify({ customerName, contactName, purpose, photoDataUrl, location })
      });
      setVisits(previous => [data.visit, ...previous]);
      setCustomerName('');
      setContactName('');
      setPurpose('');
      setPhotoDataUrl('');
      setShowRemoteCheckout(false);
      setCheckoutExceptionReason('');
      setCheckoutDistanceHint(null);
    } catch (err: any) {
      await refreshLocationPermission();
      setError(err.message || 'Check-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const runCheckOut = async (allowRemoteCheckout = false) => {
    if (!activeVisit) return;
    if (!summary.trim()) return setError('Add a short visit summary before checking out.');
    if (allowRemoteCheckout && checkoutExceptionReason.trim().length < 8) {
      return setError('Enter a short reason before using remote check-out.');
    }
    setBusy(true);
    setError('');
    try {
      const location = await getLocation();
      setLocationPermission('granted');
      const data = await request(`/api/field-visits/${activeVisit.id}/check-out`, {
        method: 'POST',
        body: JSON.stringify({
          location,
          summary,
          outcome,
          nextAction,
          allowRemoteCheckout,
          exceptionReason: allowRemoteCheckout ? checkoutExceptionReason : ''
        })
      });
      setVisits(previous => previous.map(visit => visit.id === activeVisit.id ? data.visit : visit));
      setSummary('');
      setOutcome('Follow-up');
      setNextAction('');
      setShowRemoteCheckout(false);
      setCheckoutExceptionReason('');
      setCheckoutDistanceHint(null);
    } catch (err: any) {
      await refreshLocationPermission();
      if (err.code === 'VISIT_CHECKOUT_TOO_FAR') {
        const distance = Number(err?.details?.checkoutDistanceMeters || 0);
        const allowed = Number(err?.details?.allowedDistanceMeters || 0);
        setCheckoutDistanceHint({ distance, allowed });
        setShowRemoteCheckout(true);
        setError(`You are ${distance}m away from check-in. Move back within ${allowed}m, or use remote check-out with a reason.`);
      } else {
        setError(err.message || 'Check-out failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const checkOut = async () => runCheckOut(false);

  const remoteCheckOut = async () => runCheckOut(true);

  const elapsed = activeVisit ? Math.floor((now - Date.parse(activeVisit.startedAt)) / 1000) : 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-50">
      <PageHeader
        title="Field Visits"
        subtitle="GPS check-in, site photo and visit duration"
        icon={MapPin}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canViewReports && (
              <Link
                to="/field-visit-reports"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50"
              >
                Open Reports
              </Link>
            )}
            <button onClick={loadVisits} disabled={loading} className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 hover:bg-slate-50">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)]">
          <section className="space-y-5">
            <div className="rounded-3xl bg-gradient-to-br from-indigo-600 to-blue-700 p-5 text-white shadow-xl shadow-indigo-100">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-200">Sales fieldwork</p>
                  <h2 className="mt-2 text-xl font-black">{activeVisit ? activeVisit.customerName : 'Ready for your next visit'}</h2>
                  <p className="mt-1 text-sm text-indigo-100">{profile?.name || profile?.username}</p>
                </div>
                <div className="rounded-2xl bg-white/15 p-4 backdrop-blur"><Navigation className="h-8 w-8" /></div>
              </div>
              {activeVisit && (
                <div className="mt-6 flex items-end justify-between rounded-2xl border border-white/20 bg-black/10 p-4">
                  <div><p className="text-xs text-indigo-100">Visit duration</p><p className="mt-1 font-mono text-2xl font-black tracking-tight">{formatDuration(elapsed)}</p></div>
                  <div className="flex items-center gap-2 text-xs text-indigo-100"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-300" />Active</div>
                </div>
              )}
            </div>

            {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>}

            <div className="rounded-2xl border border-indigo-100 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className={`rounded-xl p-2 ${locationPermission === 'granted' ? 'bg-emerald-100 text-emerald-700' : locationPermission === 'denied' ? 'bg-red-100 text-red-700' : 'bg-indigo-100 text-indigo-700'}`}>
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-black text-slate-900">
                      {locationPermission === 'granted' ? 'Location access enabled' : 'Location access required'}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-500">
                      {locationPermission === 'denied'
                        ? 'Your browser has blocked GPS for this site. Open site settings, allow Location, then refresh.'
                        : locationPermission === 'unsupported'
                        ? 'This device or browser does not support GPS location.'
                        : 'Tap Enable Location before check-in so the browser can ask for GPS permission.'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={enableLocation}
                  disabled={busy || locationPermission === 'granted' || locationPermission === 'unsupported'}
                  className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {locationPermission === 'granted' ? 'Enabled' : 'Enable Location'}
                </button>
              </div>
            </div>

            {!activeVisit ? (
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                <h3 className="text-lg font-black text-slate-900">Start customer visit</h3>
                <p className="mt-1 text-sm text-slate-500">GPS and the site photo are captured when you check in.</p>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <label className="sm:col-span-2"><span className="mb-1.5 block text-xs font-bold text-slate-600">Customer *</span><input value={customerName} onChange={e => setCustomerName(e.target.value)} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-500" placeholder="Customer or company name" /></label>
                  <label><span className="mb-1.5 block text-xs font-bold text-slate-600">Contact</span><input value={contactName} onChange={e => setContactName(e.target.value)} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-500" placeholder="Person meeting" /></label>
                  <label><span className="mb-1.5 block text-xs font-bold text-slate-600">Purpose</span><input value={purpose} onChange={e => setPurpose(e.target.value)} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-500" placeholder="Quote, follow-up, demo..." /></label>
                </div>

                <label className="mt-5 block cursor-pointer rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 p-4 text-center hover:border-indigo-300 hover:bg-indigo-50">
                  {photoDataUrl ? <img src={photoDataUrl} alt="Visit evidence preview" className="mx-auto max-h-56 rounded-xl object-cover" /> : <><Camera className="mx-auto h-8 w-8 text-indigo-500" /><p className="mt-2 text-sm font-bold text-slate-700">Take site photo *</p><p className="text-xs text-slate-400">Camera opens on supported mobile devices</p></>}
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => handlePhoto(e.target.files?.[0])} />
                </label>

                <button onClick={checkIn} disabled={busy} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-5 py-4 font-black text-white shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-60">
                  <LocateFixed className="h-5 w-5" />{busy ? 'Getting location...' : 'GPS Check In'}
                </button>
              </div>
            ) : (
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                <div className="flex items-center gap-3"><div className="rounded-xl bg-emerald-100 p-2 text-emerald-700"><Clock3 className="h-5 w-5" /></div><div><h3 className="font-black text-slate-900">Complete visit</h3><p className="text-xs text-slate-500">Checked in {new Date(activeVisit.startedAt).toLocaleString()}</p></div></div>
                <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
                  Standard check-out must happen within 250m of the original check-in location.
                </div>
                <label className="mt-5 block"><span className="mb-1.5 block text-xs font-bold text-slate-600">Visit summary *</span><textarea value={summary} onChange={e => setSummary(e.target.value)} rows={4} className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-500" placeholder="What was discussed and agreed?" /></label>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label><span className="mb-1.5 block text-xs font-bold text-slate-600">Outcome</span><select value={outcome} onChange={e => setOutcome(e.target.value)} className="w-full rounded-xl border border-slate-200 px-4 py-3"><option>Follow-up</option><option>Quote requested</option><option>Opportunity</option><option>Order expected</option><option>No opportunity</option></select></label>
                  <label><span className="mb-1.5 block text-xs font-bold text-slate-600">Next action</span><input value={nextAction} onChange={e => setNextAction(e.target.value)} className="w-full rounded-xl border border-slate-200 px-4 py-3" placeholder="Call next Tuesday" /></label>
                </div>
                <button onClick={checkOut} disabled={busy} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-4 font-black text-white shadow-lg shadow-emerald-200 hover:bg-emerald-700 disabled:opacity-60"><CheckCircle2 className="h-5 w-5" />{busy ? 'Getting location...' : 'GPS Check Out'}</button>
                {(showRemoteCheckout || checkoutDistanceHint) && (
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-black text-slate-900">Remote check-out exception</p>
                        <p className="mt-1 text-xs leading-relaxed text-slate-500">
                          {checkoutDistanceHint
                            ? `Current distance: ${checkoutDistanceHint.distance}m. Allowed distance: ${checkoutDistanceHint.allowed}m.`
                            : 'Use this only when check-out cannot happen near the original check-in point.'}
                        </p>
                      </div>
                      <button type="button" onClick={() => setShowRemoteCheckout(previous => !previous)} className="text-xs font-black uppercase tracking-wide text-indigo-600">
                        {showRemoteCheckout ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {showRemoteCheckout && (
                      <div className="mt-4 space-y-3">
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-bold text-slate-600">Exception reason *</span>
                          <textarea
                            value={checkoutExceptionReason}
                            onChange={e => setCheckoutExceptionReason(e.target.value)}
                            rows={3}
                            className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-500"
                            placeholder="Why could the visit not be checked out near the original check-in point?"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={remoteCheckOut}
                          disabled={busy}
                          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-5 py-3 font-black text-slate-800 shadow-sm hover:bg-slate-100 disabled:opacity-60"
                        >
                          <CheckCircle2 className="h-5 w-5" />
                          {busy ? 'Getting location...' : 'Remote Check Out'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
            <div className="flex items-center justify-between"><div><h3 className="text-lg font-black text-slate-900">Visit history</h3><p className="text-sm text-slate-500">Your latest 100 visits</p></div><div className="rounded-xl bg-slate-100 p-2.5 text-slate-600"><Users className="h-5 w-5" /></div></div>
            <div className="mt-5 space-y-3">
              {loading ? <p className="py-10 text-center text-sm text-slate-400">Loading visits...</p> : completedVisits.length === 0 ? <p className="py-10 text-center text-sm text-slate-400">No completed visits yet.</p> : completedVisits.map(visit => (
                <article key={visit.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-3"><div><h4 className="font-black text-slate-900">{visit.customerName}</h4><p className="mt-0.5 text-xs text-slate-500">{new Date(visit.startedAt).toLocaleString()}</p></div><span className="rounded-lg bg-indigo-100 px-2.5 py-1 font-mono text-xs font-bold text-indigo-700">{formatDuration(visit.durationSeconds || 0)}</span></div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-lg bg-white px-2 py-1 text-slate-600">{visit.outcome || 'Completed'}</span>{visit.hasPhoto && <span className="rounded-lg bg-white px-2 py-1 text-slate-600">Photo ✓</span>}<a className="rounded-lg bg-white px-2 py-1 text-blue-600" href={`https://www.google.com/maps?q=${visit.checkInLocation.latitude},${visit.checkInLocation.longitude}`} target="_blank" rel="noreferrer"><MapPin className="mr-1 inline h-3 w-3" />Map</a></div>
                  {visit.summary && <p className="mt-3 text-sm leading-relaxed text-slate-600">{visit.summary}</p>}
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
