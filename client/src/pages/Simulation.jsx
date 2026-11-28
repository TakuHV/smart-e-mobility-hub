import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { virtualNow } from '../clock';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';
import RefreshButton from '../components/RefreshButton';

/*
 * What-if Simulation (UC-023 run, UC-024 compare, UC-025 recommendations).
 * Every number on this page is either the current baseline ("now") or a Simulated value; live data is never changed here.
 * Layout: left = scenario builder in three steps, right = result of the open run, below = tabs for saved runs,
 * comparison and hand-offs.
 */

const SCENARIOS = [
  { id: 'parking_surge', icon: '⇣', title: 'Arrival surge', text: 'More vehicles arrive at the Hub as it is now.' },
  { id: 'capacity_pressure', icon: '▣', title: 'Hub nearly full', text: 'The Hub starts almost full, then more vehicles arrive.' },
  { id: 'charging_demand', icon: '⚡', title: 'Charging rush', text: 'More charging requests; test other Scheduler weights.' },
  { id: 'charger_outage', icon: '⨯', title: 'Charger outage', text: 'Chosen chargers fail; test a lower Power Limit and weights.' },
  { id: 'vehicle_imbalance', icon: '⇄', title: 'Vehicle imbalance', text: 'Extra shared vehicles pile up at this Hub.' }
];
const scenarioInfo = type => SCENARIOS.find(s => s.id === type) || { icon: '◌', title: type, text: '' };

// Scheduler weight presets, in percent. "Current settings" comes from the server (configuration.json).
const WEIGHT_PRESETS = [
  { id: 'deadline', label: 'Deadline first', weights: { need: 20, urgency: 60, waiting: 20 } },
  { id: 'battery', label: 'Low battery first', weights: { need: 70, urgency: 10, waiting: 20 } },
  { id: 'fifo', label: 'Waited longest first', weights: { need: 20, urgency: 20, waiting: 60 } }
];
const WEIGHT_PARTS = [
  { key: 'need', label: 'Need', hint: 'lower battery ranks higher' },
  { key: 'urgency', label: 'Urgency', hint: 'closer usage time ranks higher' },
  { key: 'waiting', label: 'Waiting', hint: 'longer wait ranks higher' }
];
const toPercent = w => ({ need: Math.round(w.need * 100), urgency: Math.round(w.urgency * 100), waiting: Math.round(w.waiting * 100) });
const weightText = w => (w ? `${Math.round(w.need * 100)}/${Math.round(w.urgency * 100)}/${Math.round(w.waiting * 100)}` : undefined);

const STALE_BASELINE_MINUTES = 30; // demo-clock minutes after which a run's baseline is flagged as old before sending

// Comparison rows. `better` tells which direction is an improvement; null when it depends on the situation.
const METRICS = {
  projectedLateVehicles: { label: 'Vehicles not ready in time', better: 'lower', group: 'Charging' },
  projectedOnTimePercent: { label: 'Ready on time (%)', better: 'higher', group: 'Charging' },
  projectedAverageWaitMinutes: { label: 'Average wait (min)', better: 'lower', group: 'Charging' },
  projectedUrgentAverageWaitMinutes: { label: 'Average wait of urgent requests (min)', better: 'lower', group: 'Charging' },
  projectedLongestWaitMinutes: { label: 'Longest wait (min)', better: 'lower', group: 'Charging' },
  projectedChargingQueue: { label: 'Charging requests', better: null, group: 'Charging' },
  projectedConcurrentChargingCapacity: { label: 'Chargers running at once', better: 'higher', group: 'Charging' },
  hubPowerLimitKw: { label: 'Hub Power Limit (kW)', better: null, group: 'Charging' },
  configuredWeightsLateVehicles: { label: 'Not ready in time with configured weights', better: 'lower', group: 'Charging' },
  projectedPersonalSlotOccupancyPercent: { label: 'Personal slot occupancy (%)', better: 'lower', group: 'Parking' },
  projectedSharedSlotOccupancyPercent: { label: 'Shared slot occupancy (%)', better: 'lower', group: 'Parking' },
  unservedVehicles: { label: 'Vehicles without a free slot', better: 'lower', group: 'Parking' },
  projectedAvailableSharedVehicles: { label: 'Available shared EVs', better: null, group: 'Parking' },
  projectedAvailableChargers: { label: 'Available chargers', better: 'higher', group: 'Charging' }
};

const isCharging = type => type === 'charger_outage' || type === 'charging_demand';
const isParking = type => type === 'parking_surge' || type === 'capacity_pressure';
const minutes = value => {
  if (value === null) return 'Never';
  if (value === undefined) return '—';
  if (value < 60) return `${value} min`;
  return `${Math.floor(value / 60)} h ${value % 60 ? `${value % 60} min` : ''}`.trim();
};
const pct = value => (value === undefined || value === null ? '—' : `${value}%`);
const minutesSince = iso => (iso ? Math.round((virtualNow() - Date.parse(iso)) / 60000) : null);
const runTitle = run => run.run_name || run.parameters?.runName || scenarioInfo(run.scenario_type).title;

// Tone of a change: 'better', 'worse' or '' (same, unknown or no direction). null means "never" (worst) for waits.
function changeTone(now, then, better) {
  if (!better || now === undefined || then === undefined) return '';
  if (then === null && now !== null) return 'worse';
  if (now === null && then !== null) return 'better';
  if (typeof now !== 'number' || typeof then !== 'number' || now === then) return '';
  return (then > now) === (better === 'higher') ? 'better' : 'worse';
}

// The headline numbers of a run, each with its value "now" and in the scenario.
function headlineMetrics(run) {
  const r = run.results;
  if (isCharging(run.scenario_type)) {
    return [
      { label: 'Not ready in time', then: r.projectedLateVehicles, now: r.currentLateVehicles, better: 'lower',
        show: v => (v === undefined ? '—' : `${v}`), sub: r.projectedVehiclesWithUsageTime !== undefined ? `of ${r.projectedVehiclesWithUsageTime} with a usage time` : '' },
      { label: 'Average wait', then: r.projectedAverageWaitMinutes, now: r.currentAverageWaitMinutes, better: 'lower', show: minutes },
      { label: 'Longest wait', then: r.projectedLongestWaitMinutes, now: r.currentLongestWaitMinutes, better: 'lower', show: minutes },
      { label: 'Chargers at once', then: r.projectedConcurrentChargingCapacity, now: r.currentConcurrentChargingCapacity, better: 'higher',
        show: v => `${v ?? '—'}`, sub: `limit ${r.hubPowerLimitKw} kW` }
    ];
  }
  const shared = r.affectedSlotType === 'Shared' || run.scenario_type === 'vehicle_imbalance';
  const rows = [
    { label: `${shared ? 'Shared' : 'Personal'} occupancy`, then: shared ? r.projectedSharedSlotOccupancyPercent : r.projectedPersonalSlotOccupancyPercent,
      now: shared ? r.currentSharedSlotOccupancyPercent : r.currentPersonalSlotOccupancyPercent, better: 'lower', show: pct },
    { label: 'Level', then: r.occupancyLevel, now: r.currentOccupancyLevel, show: v => (v ? <StatusBadge value={v}/> : '—') },
    { label: 'Without a free slot', then: r.unservedVehicles, now: 0, better: 'lower', show: v => `${v ?? '—'}` }
  ];
  if (run.scenario_type === 'vehicle_imbalance') rows.push({ label: 'Shared EVs at this Hub', then: r.projectedAvailableSharedVehicles, now: r.currentAvailableSharedVehicles, show: v => `${v ?? '—'}` });
  return rows;
}

function parameterChips(p = {}) {
  return Object.entries({
    'Extra demand': p.demandDelta || undefined,
    'Slot type': p.slotType,
    'Starts at': p.startOccupancyPercent !== undefined ? `${p.startOccupancyPercent}%` : undefined,
    'Urgent share': p.urgentSharePercent !== undefined ? `${p.urgentSharePercent}%` : undefined,
    'Sample': p.demandSeed,
    'Chargers out': p.outageChargerCodes?.length ? p.outageChargerCodes.join(', ') : p.chargerOutageCount,
    'Power limit': p.powerLimitKw ? `${p.powerLimitKw} kW` : undefined,
    'Weights N/U/W': weightText(p.weights),
    'Session': p.estimatedSessionMinutes ? `${p.estimatedSessionMinutes} min` : undefined
  }).filter(([, value]) => value !== undefined && value !== '');
}

/* ---------------------------------------------------------------- small building blocks */

function Step({ number, title, children, aside }) {
  return <div className="sim-step">
    <div className="sim-step-head"><span className="sim-step-no">{number}</span><strong>{title}</strong>{aside}</div>
    {children}
  </div>;
}

function NumberField({ label, hint, value, onChange, min, max, step = 1, placeholder, suffix }) {
  return <label className="sim-field">
    <span>{label}</span>
    <div className="sim-number">
      <button type="button" onClick={() => onChange(String(Math.max(min, (Number(value) || 0) - step)))} aria-label={`Decrease ${label}`}>−</button>
      <input type="number" min={min} max={max} step={step} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}/>
      <button type="button" onClick={() => onChange(String(Math.min(max, (Number(value) || 0) + step)))} aria-label={`Increase ${label}`}>+</button>
      {suffix && <em>{suffix}</em>}
    </div>
    {hint && <small>{hint}</small>}
  </label>;
}

function HubSnapshot({ context }) {
  if (!context) return <div className="sim-snapshot loading">Loading the current state of the Hub…</div>;
  const { slots } = context;
  const tiles = [
    ['Personal slots', `${slots.Personal.free} free`, `${slots.Personal.percent}% used`],
    ['Shared slots', `${slots.Shared.free} free`, `${slots.Shared.percent}% used`],
    ['Chargers', `${context.concurrentChargingCapacity} / ${context.usableChargerCount}`, `limit ${context.hub.powerLimitKw} kW`],
    ['Charging queue', `${context.chargingQueue}`, 'live requests'],
    ['Shared EVs', `${context.availableSharedVehicles}`, 'available']
  ];
  return <div className="sim-snapshot">
    {tiles.map(([label, value, sub]) => <div key={label}><span>{label}</span><b>{value}</b><small>{sub}</small></div>)}
    {context.hub.status !== 'Open' && <div className="sim-snapshot-warn"><StatusBadge value={context.hub.status}/> This Hub is not open.</div>}
  </div>;
}

function WeightsEditor({ weights, onChange, configured }) {
  const sum = weights.need + weights.urgency + weights.waiting;
  const presets = [{ id: 'current', label: 'Current settings', weights: configured }, ...WEIGHT_PRESETS].filter(p => p.weights);
  const active = presets.find(p => WEIGHT_PARTS.every(({ key }) => p.weights[key] === weights[key]))?.id;
  return <div className="sim-weights">
    <div className="sim-presets">{presets.map(p => <button type="button" key={p.id} className={`sim-preset ${active === p.id ? 'active' : ''}`} onClick={() => onChange({ ...p.weights })}>
      {p.label}<small>{p.weights.need}/{p.weights.urgency}/{p.weights.waiting}</small>
    </button>)}</div>
    {WEIGHT_PARTS.map(({ key, label, hint }) => <label key={key} className="sim-slider">
      <span><b>{label}</b><em>{hint}</em><strong>{weights[key]}%</strong></span>
      <input type="range" min="0" max="100" step="5" value={weights[key]} onChange={e => onChange({ ...weights, [key]: Number(e.target.value) })}/>
    </label>)}
    <div className="sim-weight-bar" aria-hidden="true">
      {WEIGHT_PARTS.map(({ key }) => <i key={key} className={key} style={{ width: `${sum ? (weights[key] / sum) * 100 : 0}%` }}/>)}
    </div>
    <div className={`sim-weight-sum ${sum === 100 ? 'ok' : 'bad'}`}>{sum === 100 ? 'Total 100% ✓' : `Total ${sum}% — the three weights must add up to 100%`}</div>
  </div>;
}

function OccupancyBar({ current, projected, warning, critical }) {
  if (current === undefined || projected === undefined) return null;
  const level = projected >= critical ? 'critical' : projected >= warning ? 'warning' : 'normal';
  return <div className="sim-occupancy" aria-label={`Occupancy now ${current}%, scenario ${projected}%`}>
    <div className="sim-occupancy-track">
      <div className={`sim-occupancy-fill ${level}`} style={{ width: `${Math.min(100, projected)}%` }}/>
      <div className="sim-occupancy-now" style={{ width: `${Math.min(100, current)}%` }}/>
      <i style={{ left: `${warning}%` }} title={`Warning ${warning}%`}/>
      <i className="critical" style={{ left: `${critical}%` }} title={`Critical ${critical}%`}/>
    </div>
    <div className="sim-occupancy-legend"><span>Now {current}%</span><span>Warning {warning}% · Critical {critical}%</span><span>Scenario {projected}%</span></div>
  </div>;
}

// Who gets a charger when, in the simulated order. Shows why the weights matter: the same vehicles, another order.
function ChargingOrder({ timeline }) {
  const [all, setAll] = useState(false);
  if (!timeline?.length) return null;
  const rows = all ? timeline : timeline.slice(0, 10);
  return <div className="sim-order">
    <div className="subsection-title section-gap-small"><strong>Simulated charging order</strong><span>{timeline.filter(t => t.onTime === false).length} late · {timeline.length} requests</span></div>
    <div className="table-wrap"><table>
      <thead><tr><th>#</th><th>Request</th><th className="num">Battery</th><th className="num">Needed in</th><th className="num">Waits</th><th className="num">Full in</th><th>Ready in time?</th></tr></thead>
      <tbody>{rows.map((t, index) => <tr key={t.id} className={t.onTime === false ? 'late' : ''}>
        <td>{index + 1}</td>
        <td><strong>{t.label}</strong>{t.urgent && <span className="sim-tag urgent">urgent</span>}{t.alreadyCharging && <span className="sim-tag">already charging</span>}</td>
        <td className="num">{t.battery}%</td>
        <td className="num">{t.dueInMinutes === null ? '—' : minutes(t.dueInMinutes)}</td>
        <td className="num">{minutes(t.waitMinutes)}</td>
        <td className="num">{minutes(t.readyInMinutes)}</td>
        <td>{t.onTime === null ? <span className="muted-text">no usage time</span> : t.onTime ? <span className="sim-ok">✓ On time</span> : <span className="sim-late">✕ Late</span>}</td>
      </tr>)}</tbody>
    </table></div>
    {timeline.length > 10 && <button type="button" className="button small ghost sim-more" onClick={() => setAll(v => !v)}>{all ? 'Show first 10' : `Show all ${timeline.length}`}</button>}
  </div>;
}

/* ---------------------------------------------------------------- page */

export default function Simulation({ user }) {
  const canRun = ['Simulation Operator', 'Admin'].includes(user.role);
  const canConfirm = ['Operator', 'Admin'].includes(user.role);
  const [hubs, setHubs] = useState([]);
  const [hubId, setHubId] = useState('');
  const [context, setContext] = useState(null);
  const [scenarioType, setScenarioType] = useState('parking_surge');
  const [label, setLabel] = useState('');
  const [demandDelta, setDemandDelta] = useState('2');
  const [outageDemand, setOutageDemand] = useState('10');
  const [slotType, setSlotType] = useState('Personal');
  const [startOccupancyPercent, setStartOccupancyPercent] = useState(90);
  const [urgentSharePercent, setUrgentSharePercent] = useState(30);
  const [demandSeed, setDemandSeed] = useState(1);
  const [outageChargerIds, setOutageChargerIds] = useState([]);
  const [powerLimitKw, setPowerLimitKw] = useState('');
  const [weights, setWeights] = useState({ need: 50, urgency: 30, waiting: 20 });
  const [runs, setRuns] = useState([]);
  const [latestRun, setLatestRun] = useState(null);
  const [selectedRunIds, setSelectedRunIds] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [handoffs, setHandoffs] = useState([]);
  const [noteDrafts, setNoteDrafts] = useState({});
  const [tab, setTab] = useState('runs');
  const [filterHub, setFilterHub] = useState('');
  const [filterScenario, setFilterScenario] = useState('');
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const pendingOutage = useRef(null); // charger ids to restore after "Run again" switches Hub
  const resultRef = useRef(null);

  const configuredWeights = context?.defaults?.weights ? toPercent(context.defaults.weights) : null;

  async function load() {
    try {
      const [h, r, ho] = await Promise.all([api('/hubs'), api('/simulation/runs'), api('/simulation/handoffs')]);
      setHubs(h.hubs); setRuns(r.runs); setHandoffs(ho.handoffs);
      setHubId(prev => prev || h.hubs[0]?.id || '');
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function loadContext(id = hubId, { keepWeights = true } = {}) {
    if (!id || !canRun) return;
    setContext(null);
    try {
      const { baseline } = await api(`/simulation/baseline/${id}`);
      setContext(baseline);
      if (!keepWeights && baseline.defaults?.weights) setWeights(toPercent(baseline.defaults.weights));
      const wanted = pendingOutage.current;
      pendingOutage.current = null;
      const usable = baseline.chargers.filter(c => c.usable).map(c => c.id);
      setOutageChargerIds(wanted ? wanted.filter(cid => usable.includes(cid)) : usable.slice(-1));
    } catch (err) { setError(err.message); }
  }
  const firstContext = useRef(true);
  useEffect(() => { loadContext(hubId, { keepWeights: !firstContext.current }); if (hubId) firstContext.current = false; }, [hubId]);

  const weightSum = weights.need + weights.urgency + weights.waiting;
  const outageInvalid = scenarioType === 'charger_outage' && outageChargerIds.length === 0;
  const weightsInvalid = isCharging(scenarioType) && weightSum !== 100;

  async function runScenario(event) {
    event.preventDefault(); setError(''); setSuccess('');
    if (outageInvalid) { setError('Choose at least one charger to put out of service in the scenario.'); return; }
    if (weightsInvalid) { setError('The three Scheduler weights must add up to 100%.'); return; }
    setBusy(true); setComparison(null);
    const body = { hubId, scenarioType };
    if (label.trim()) body.label = label.trim();
    if (scenarioType !== 'charger_outage') body.demandDelta = Number(demandDelta);
    if (isParking(scenarioType)) body.slotType = slotType;
    if (scenarioType === 'capacity_pressure') body.startOccupancyPercent = Number(startOccupancyPercent);
    if (scenarioType === 'charger_outage') {
      body.outageChargerIds = outageChargerIds;
      body.demandDelta = Number(outageDemand) || 0;
      if (powerLimitKw !== '') body.powerLimitKw = Number(powerLimitKw);
    }
    if (isCharging(scenarioType)) {
      body.weights = { need: weights.need / 100, urgency: weights.urgency / 100, waiting: weights.waiting / 100 };
      if (scenarioType === 'charging_demand' || Number(outageDemand) > 0) { body.urgentSharePercent = Number(urgentSharePercent); body.demandSeed = Number(demandSeed); }
    }
    try {
      const result = await api('/simulation/runs', { method: 'POST', body });
      setLatestRun(result.run);
      setSuccess('Run stored. Results are Simulated; live operational data was not changed.');
      await Promise.all([load(), loadContext(hubId)]);
      if (window.matchMedia?.('(max-width: 1100px)').matches) resultRef.current?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function openRun(id) {
    setError(''); setOpening(true);
    try { setLatestRun((await api(`/simulation/runs/${id}`)).run); }
    catch (err) { setError(err.message); }
    finally { setOpening(false); }
  }

  // "Run again": copy a stored run's Hub, scenario and parameters into the form so only one value needs changing.
  function prefillFrom(run) {
    const p = run.parameters || {};
    setScenarioType(run.scenario_type);
    setLabel(p.runName ? `${p.runName} (copy)` : '');
    if (p.demandDelta !== undefined) (run.scenario_type === 'charger_outage' ? setOutageDemand : setDemandDelta)(String(p.demandDelta));
    if (p.slotType) setSlotType(p.slotType);
    if (p.startOccupancyPercent !== undefined) setStartOccupancyPercent(p.startOccupancyPercent);
    if (p.urgentSharePercent !== undefined) setUrgentSharePercent(p.urgentSharePercent);
    if (p.demandSeed !== undefined) setDemandSeed(p.demandSeed);
    if (p.weights) setWeights(toPercent(p.weights));
    setPowerLimitKw(p.powerLimitKw ?? '');
    if (run.hub_id !== hubId) { pendingOutage.current = p.outageChargerIds ?? null; setHubId(run.hub_id); }
    else if (p.outageChargerIds && context) {
      const usable = context.chargers.filter(c => c.usable).map(c => c.id);
      setOutageChargerIds(p.outageChargerIds.filter(cid => usable.includes(cid)));
    }
    setSuccess('The form holds this run’s settings. Change one value and run again, then compare the two runs.');
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  const selectedHubId = runs.find(r => r.id === selectedRunIds[0])?.hub_id;
  const toggleRun = id => setSelectedRunIds(old => (old.includes(id) ? old.filter(x => x !== id) : [...old, id].slice(0, 10)));
  async function compareRuns() {
    setError(''); setSuccess('');
    try { setComparison((await api('/simulation/compare', { method: 'POST', body: { runIds: selectedRunIds } })).comparison); setTab('compare'); }
    catch (err) { setError(err.message); }
  }

  async function recommendationAction(id, action) {
    setError(''); setSuccess('');
    try {
      const result = await api(`/simulation/recommendations/${id}/${action}`, { method: 'POST', body: {} });
      setSuccess(action === 'apply' ? result.note : 'Recommendation declined. No live resource state was changed.');
      if (latestRun) await openRun(latestRun.id);
      await load();
    } catch (err) { setError(err.message); if (latestRun) await openRun(latestRun.id); }
  }

  async function completeHandoff(id) {
    setError(''); setSuccess('');
    try {
      await api(`/simulation/handoffs/${id}/complete`, { method: 'POST', body: { completionNote: noteDrafts[id] || '' } });
      setNoteDrafts(old => { const next = { ...old }; delete next[id]; return next; });
      setSuccess('Hand-off confirmed. The recommendation is now Applied.');
      if (latestRun) await openRun(latestRun.id);
      await load();
    } catch (err) { setError(err.message); }
  }

  const filteredRuns = useMemo(() => runs.filter(r => (!filterHub || r.hub_id === filterHub) && (!filterScenario || r.scenario_type === filterScenario)), [runs, filterHub, filterScenario]);
  const visibleRuns = showAllRuns ? filteredRuns : filteredRuns.slice(0, 8);
  const pendingHandoffs = handoffs.filter(h => h.status === 'Pending').length;

  const r = latestRun?.results;
  const baselineAge = latestRun ? minutesSince(r.baselineCapturedAt || latestRun.created_at) : null;
  const baselineOld = baselineAge !== null && baselineAge > STALE_BASELINE_MINUTES;
  const resultIsForOtherInputs = canRun && latestRun && (latestRun.hub_id !== hubId || latestRun.scenario_type !== scenarioType);

  // One-line verdict at the top of the result, coloured by how serious it is.
  const verdict = (() => {
    if (!latestRun) return null;
    if (isCharging(latestRun.scenario_type)) {
      if (r.projectedLateVehicles === undefined) return { tone: 'neutral', text: 'Stored before vehicle-level charging results existed.' };
      if (r.projectedLongestWaitMinutes === null) return { tone: 'critical', text: 'Some requests never get a charger.' };
      if (r.projectedLateVehicles > 0) return { tone: r.projectedOnTimePercent < 80 ? 'critical' : 'warning', text: `${r.projectedLateVehicles} of ${r.projectedVehiclesWithUsageTime} vehicles would not be ready in time.` };
      if (!r.projectedChargingQueue) return { tone: 'neutral', text: 'No charging request to simulate — add charging demand.' };
      return { tone: 'normal', text: 'Every vehicle would be ready in time.' };
    }
    const level = r.occupancyLevel;
    if (r.unservedVehicles) return { tone: 'critical', text: `${r.unservedVehicles} vehicle(s) would find no free slot.` };
    return { tone: level === 'Critical' ? 'critical' : level === 'Warning' ? 'warning' : 'normal', text: `Occupancy stays ${level.toLowerCase()}.` };
  })();
  const affectedShared = r?.affectedSlotType === 'Shared' || latestRun?.scenario_type === 'vehicle_imbalance';
  const demandControls = scenarioType === 'charging_demand' || (scenarioType === 'charger_outage' && Number(outageDemand) > 0);

  return <>
    <SectionHeader eyebrow="STRATEGIC PLANNING · UC-023 / UC-024 / UC-025" title="What-if Simulation" description="Try a situation on a copy of a Hub’s current state, compare the runs and send a recommendation to the right workflow. Live data never changes here." action={<RefreshButton onClick={() => { load(); loadContext(); }}/>}/>
    <Feedback error={error} success={success}/>

    <div className={`simulation-layout ${canRun ? '' : 'single'}`}>
      {canRun && <section className="card-surface padded simulation-form-panel">
        <form onSubmit={runScenario} className="sim-builder">
          <Step number="1" title="Choose a Hub">
            <div className="sim-segment" role="radiogroup" aria-label="Baseline Hub">
              {hubs.map(h => <button type="button" role="radio" aria-checked={hubId === h.id} key={h.id} className={hubId === h.id ? 'active' : ''} onClick={() => setHubId(h.id)}>{h.name}</button>)}
            </div>
            <HubSnapshot context={context}/>
          </Step>

          <Step number="2" title="Choose a situation">
            <div className="sim-scenarios" role="radiogroup" aria-label="Scenario">
              {SCENARIOS.map(s => <button type="button" role="radio" aria-checked={scenarioType === s.id} key={s.id} className={`sim-scenario ${scenarioType === s.id ? 'active' : ''}`} onClick={() => setScenarioType(s.id)}>
                <span className="sim-scenario-icon">{s.icon}</span><strong>{s.title}</strong><small>{s.text}</small>
              </button>)}
            </div>
          </Step>

          <Step number="3" title="Set the assumptions">
            <div className="sim-fields">
              {scenarioType === 'capacity_pressure' && <label className="sim-field"><span>Hub starts at <b>{startOccupancyPercent}%</b> full</span>
                <input type="range" min="50" max="100" step="5" value={startOccupancyPercent} onChange={e => setStartOccupancyPercent(Number(e.target.value))}/>
                <small>Or fuller, if the Hub already is.</small></label>}
              {scenarioType !== 'charger_outage' && <NumberField
                label={isParking(scenarioType) ? 'Extra arriving vehicles' : scenarioType === 'charging_demand' ? 'Extra charging requests' : 'Extra shared vehicles at this Hub'}
                value={demandDelta} onChange={setDemandDelta} min={1} max={200}/>}
              {isParking(scenarioType) && <div className="sim-field"><span>Slot type under pressure</span>
                <div className="sim-segment small">{['Personal', 'Shared'].map(t => <button type="button" key={t} className={slotType === t ? 'active' : ''} onClick={() => setSlotType(t)}>{t}</button>)}</div></div>}

              {scenarioType === 'charger_outage' && <div className="sim-field"><span>Chargers out of service</span>
                {!context ? <small>Loading chargers…</small> : <div className="sim-charger-list">{context.chargers.map(c => <label key={c.id} className={`sim-charger ${outageChargerIds.includes(c.id) ? 'chosen' : ''} ${c.usable ? '' : 'disabled'}`}>
                  <input type="checkbox" disabled={!c.usable} checked={outageChargerIds.includes(c.id)} onChange={() => setOutageChargerIds(old => (old.includes(c.id) ? old.filter(x => x !== c.id) : [...old, c.id]))}/>
                  <b>{c.code}</b><small>{c.powerKw} kW{c.usable ? '' : ` · ${c.status}`}</small>
                </label>)}</div>}
                {outageInvalid && <small className="sim-error-text">Choose at least one charger.</small>}
              </div>}
              {scenarioType === 'charger_outage' && <NumberField label="Hub Power Limit during the outage" value={powerLimitKw} onChange={setPowerLimitKw} min={0.5} max={1000} step={0.5}
                placeholder={context ? `${context.hub.powerLimitKw}` : ''} suffix="kW" hint={context ? `Empty = the Hub’s own ${context.hub.powerLimitKw} kW.` : ''}/>}
              {scenarioType === 'charger_outage' && <NumberField label="Extra charging requests during the outage" value={outageDemand} onChange={setOutageDemand} min={0} max={200}
                hint="0 = only the live requests. Add demand to see who would be late."/>}

              {demandControls && <div className="sim-field"><span>Urgent requests: <b>{urgentSharePercent}%</b></span>
                <input type="range" min="0" max="100" step="10" value={urgentSharePercent} onChange={e => setUrgentSharePercent(Number(e.target.value))}/>
                <small>Urgent = needed within 2 hours after it could be fully charged.</small></div>}
              {demandControls && <div className="sim-field"><span>Demand sample</span>
                <div className="sim-seed"><b>#{demandSeed}</b><button type="button" className="button small ghost" onClick={() => setDemandSeed(s => (s % 9999) + 1)}>New sample</button></div>
                <small>Keep the same sample to compare weights fairly: the vehicles stay the same, only the order changes.</small></div>}
            </div>
          </Step>

          {isCharging(scenarioType) && <Step number="4" title="Scheduler weights" aside={<span className="sim-step-aside">how the queue is ranked</span>}>
            <WeightsEditor weights={weights} onChange={setWeights} configured={configuredWeights}/>
          </Step>}

          <div className="sim-run-bar">
            <input type="text" maxLength={80} value={label} onChange={e => setLabel(e.target.value)} placeholder="Run name (optional), e.g. Rush 20 · deadline first" aria-label="Run name"/>
            <button className="button primary full" disabled={busy || !hubId || outageInvalid || weightsInvalid}>{busy ? 'Simulating…' : 'Run simulation'} <span>→</span></button>
          </div>
        </form>
      </section>}

      <section className="card-surface padded run-results-panel" ref={resultRef}>
        {opening && <p className="helper-text">Opening the run…</p>}
        {!latestRun ? <div className="sim-empty-result">
          <EmptyState title="No result yet" description={canRun ? 'Pick a Hub and a situation on the left and press Run simulation, or open a saved run below.' : 'Open a saved run below.'}/>
          {canRun && <ol className="sim-howto"><li>Run one situation.</li><li>Press <b>Run again with changes</b> and change one value (for example the weights).</li><li>Tick both runs under <b>Saved runs</b> and compare.</li></ol>}
        </div> : <>
          <div className="sim-result-head">
            <div><span className="eyebrow">{scenarioInfo(latestRun.scenario_type).icon} {scenarioInfo(latestRun.scenario_type).title} · {latestRun.hub_name}</span><h3>{runTitle(latestRun)}</h3></div>
            <div className="sim-result-actions"><StatusBadge value="Simulated"/>{canRun && <button type="button" className="button small secondary" onClick={() => prefillFrom(latestRun)}>↻ Run again with changes</button>}</div>
          </div>
          {resultIsForOtherInputs && <div className="feedback is-warning sim-inline-note">This result is from an earlier run ({latestRun.hub_name} · {scenarioInfo(latestRun.scenario_type).title}), not from the settings now in the form.</div>}
          <div className={`sim-verdict ${verdict.tone}`}><strong>{verdict.text}</strong><span>{r.summary}</span></div>
          <div className="chip-row">{parameterChips(latestRun.parameters).map(([text, value]) => <span className="chip" key={text}>{text} <b>{String(value)}</b></span>)}<span className="chip muted-chip">Baseline {new Date(r.baselineCapturedAt || latestRun.created_at).toLocaleString()}</span></div>

          <div className="sim-kpis">{headlineMetrics(latestRun).map(m => {
            const tone = changeTone(m.now, m.then, m.better);
            return <div key={m.label} className={`sim-kpi ${tone}`}>
              <span>{m.label}</span>
              <b>{m.show(m.then)}</b>
              {m.sub && <small>{m.sub}</small>}
              <small className="sim-kpi-now">now {m.show(m.now)}{tone && <i>{tone === 'better' ? ' ▲ better' : ' ▼ worse'}</i>}</small>
            </div>;
          })}</div>

          {!isCharging(latestRun.scenario_type) && <OccupancyBar
            current={affectedShared ? r.currentSharedSlotOccupancyPercent : r.currentPersonalSlotOccupancyPercent}
            projected={affectedShared ? r.projectedSharedSlotOccupancyPercent : r.projectedPersonalSlotOccupancyPercent}
            warning={r.warningPercent ?? 80} critical={r.criticalPercent ?? 95}/>}

          {isCharging(latestRun.scenario_type) && r.weights && !r.usesConfiguredWeights && r.configuredWeightsLateVehicles !== undefined && <div className="sim-weight-compare">
            <div><span>Configured weights{configuredWeights ? ` ${configuredWeights.need}/${configuredWeights.urgency}/${configuredWeights.waiting}` : ''}</span><b>{r.configuredWeightsLateVehicles} late</b><small>avg wait {minutes(r.configuredWeightsAverageWaitMinutes)}</small></div>
            <em>→</em>
            <div className="tested"><span>Tested weights {weightText(r.weights)}</span><b>{r.projectedLateVehicles} late</b><small>avg wait {minutes(r.projectedAverageWaitMinutes)}</small></div>
          </div>}

          {isCharging(latestRun.scenario_type) && <ChargingOrder key={latestRun.id} timeline={r.chargingTimeline}/>}

          <div className="subsection-title section-gap-small"><strong>Recommendations</strong><span>{latestRun.recommendations.length} {latestRun.recommendations.length === 1 ? 'proposal' : 'proposals'}</span></div>
          {latestRun.recommendations.length === 0 && <p className="helper-text sim-no-action">No action needed: the situation shows no pressure that needs a workflow.</p>}
          {baselineOld && latestRun.recommendations.some(rec => rec.status === 'Proposed') && <div className="feedback is-warning sim-inline-note">This run’s baseline is about {baselineAge} minutes old. Sending checks the current state anyway; consider running the situation again first.</div>}
          <div className="recommendation-list">{latestRun.recommendations.map(rec => {
            const needsTarget = rec.type === 'REDIRECT_USERS' || rec.type === 'REDISTRIBUTE_VEHICLES';
            const noTarget = needsTarget && !rec.payload?.targetHubId;
            return <div className="recommendation-card" key={rec.id}>
              <div className="recommendation-heading"><div><span className="rec-type">{rec.payload?.kind === 'scheduler_weights' ? 'SCHEDULER WEIGHTS' : rec.type.replaceAll('_', ' ')}</span><strong>{rec.title}</strong></div><StatusBadge value={rec.status}/></div>
              <p>{rec.description}</p><small>Expected benefit: {rec.projected_benefit}</small>
              {rec.status === 'Proposed' && canRun && <div className="button-row">
                <button className="button small primary" disabled={noTarget} title={noTarget ? 'No Hub can receive vehicles or users in this scenario' : undefined} onClick={() => recommendationAction(rec.id, 'apply')}>Send to workflow</button>
                <button className="button small ghost" onClick={() => recommendationAction(rec.id, 'decline')}>Decline</button>
              </div>}
              {rec.status === 'Proposed' && noTarget && <small className="sim-manual">Manual review needed: there is no destination Hub to send to a workflow.</small>}
            </div>;
          })}</div>
        </>}
      </section>
    </div>

    <section className="card-surface padded section-gap sim-tabs-panel">
      <div className="sim-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'runs'} className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>Saved runs <span>{runs.length}</span></button>
        {canRun && <button role="tab" aria-selected={tab === 'compare'} className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}>Compare <span>{selectedRunIds.length}</span></button>}
        <button role="tab" aria-selected={tab === 'handoffs'} className={tab === 'handoffs' ? 'active' : ''} onClick={() => setTab('handoffs')}>Hand-offs {pendingHandoffs > 0 && <span className="alert">{pendingHandoffs}</span>}</button>
      </div>

      {tab === 'runs' && <>
        <div className="sim-runs-toolbar">
          <select value={filterHub} onChange={e => setFilterHub(e.target.value)} aria-label="Filter by Hub"><option value="">All Hubs</option>{hubs.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
          <select value={filterScenario} onChange={e => setFilterScenario(e.target.value)} aria-label="Filter by situation"><option value="">All situations</option>{SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
          {canRun && <button className="button primary" disabled={selectedRunIds.length < 2} onClick={compareRuns}>Compare {selectedRunIds.length || ''} selected</button>}
          {canRun && selectedRunIds.length > 0 && <button type="button" className="button ghost" onClick={() => setSelectedRunIds([])}>Clear</button>}
        </div>
        {canRun && <p className="helper-text sim-tip">Tick 2–10 runs of the same Hub to compare them. The first one you tick is the reference.</p>}
        {filteredRuns.length === 0 ? <EmptyState title="No saved runs" description={runs.length ? 'No run matches the filters.' : 'Runs you make are saved here.'}/> : <div className="run-list">{visibleRuns.map(run => {
          const otherHub = selectedHubId && run.hub_id !== selectedHubId;
          const order = selectedRunIds.indexOf(run.id);
          return <div className={`run-row ${latestRun?.id === run.id ? 'active' : ''} ${otherHub ? 'dimmed' : ''}`} key={run.id}>
            {canRun && <input type="checkbox" checked={order >= 0} disabled={otherHub && order < 0}
              title={otherHub ? 'Only runs of the same Hub can be compared' : undefined} onChange={() => toggleRun(run.id)} aria-label={`Select run ${runTitle(run)}`}/>}
            <span className="sim-run-icon">{scenarioInfo(run.scenario_type).icon}</span>
            <button className="run-open" onClick={() => openRun(run.id)}><strong>{runTitle(run)}{order === 0 && <span className="sim-tag">reference</span>}</strong><span>{run.hub_name} · {scenarioInfo(run.scenario_type).title}</span><small>{new Date(run.created_at).toLocaleString()} · {run.recommendation_count} recommendation(s)</small></button>
            <button className="button small ghost" onClick={() => openRun(run.id)}>Open</button>
          </div>;
        })}</div>}
        {filteredRuns.length > 8 && <button type="button" className="button small ghost sim-more" onClick={() => setShowAllRuns(v => !v)}>{showAllRuns ? 'Show fewer' : `Show all ${filteredRuns.length} runs`}</button>}
      </>}

      {tab === 'compare' && (!comparison ? <EmptyState title="Nothing compared yet" description="Go to Saved runs, tick two or more runs of the same Hub and press Compare."/> : <>
        <div className="table-wrap"><table className="sim-compare">
          <thead><tr><th>Metric</th>{comparison.runs.map((run, index) => <th key={run.id} className="num">{index === 0 && <span className="sim-tag">reference</span>}<div>{run.parameters?.runName || scenarioInfo(run.scenario_type).title}</div><small>{parameterChips(run.parameters).map(([text, value]) => `${text} ${value}`).join(' · ') || '—'}</small></th>)}</tr></thead>
          <tbody>{comparison.metrics.filter(m => METRICS[m.metric])
            .map(m => ({ ...m, same: comparison.runs.every(run => m.values[run.id] === m.values[comparison.runs[0].id]) }))
            .sort((a, b) => Number(a.same) - Number(b.same) || Object.keys(METRICS).indexOf(a.metric) - Object.keys(METRICS).indexOf(b.metric))
            .map(m => <tr key={m.metric} className={m.same ? 'same' : ''}><td>{METRICS[m.metric].label}{METRICS[m.metric].better && <small>{METRICS[m.metric].better} is better</small>}</td>
            {comparison.runs.map((run, index) => {
              const value = m.values[run.id];
              const first = m.values[comparison.runs[0].id];
              const diff = m.differenceFromFirst[run.id];
              const isWait = m.metric.endsWith('WaitMinutes');
              const tone = index > 0 ? changeTone(first, value, METRICS[m.metric].better) : '';
              const shown = value === null ? (isWait ? 'Never' : '—') : value ?? '—';
              return <td className="num" key={run.id}>{shown}{index > 0 && tone && <span className={`delta ${tone}`}>{diff ? `${diff > 0 ? '+' : ''}${Math.round(diff * 10) / 10}` : '✕'}</span>}</td>;
            })}
          </tr>)}</tbody>
        </table></div>
        <p className="helper-text">Differences from the reference: <span className="delta better">green</span> is better, <span className="delta worse">red</span> is worse, by the direction under each metric. Rows that are the same in every run are grey and at the bottom.</p>
      </>)}

      {tab === 'handoffs' && (handoffs.length === 0 ? <EmptyState title="No recommendations sent" description="Sending a recommendation creates a pre-filled hand-off to its workflow."/> : <div className="handoff-list sim-handoffs">{handoffs.map(h => <div className="handoff-card" key={h.id}>
        <div className="handoff-head"><strong>{h.recommendation_title}</strong><StatusBadge value={h.status === 'Completed' ? 'Applied' : 'Sent for Execution'}/></div>
        <span className="handoff-target">→ {h.target_workflow}{h.prefilled_payload?.targetHubName ? ` · target ${h.prefilled_payload.targetHubName}` : ''}</span>
        <small>{new Date(h.created_at).toLocaleString()}</small>
        <p>{h.status === 'Pending' ? 'Waiting for the receiving workflow. The recommendation is not Applied yet.' : 'The receiving workflow was confirmed as completed.'}</p>
        {h.status === 'Pending' && canConfirm && <div className="sim-handoff-confirm">
          <textarea rows={2} maxLength={500} placeholder="What was done in the receiving workflow (optional)" value={noteDrafts[h.id] || ''} onChange={e => setNoteDrafts(old => ({ ...old, [h.id]: e.target.value }))}/>
          <button className="button small primary" onClick={() => completeHandoff(h.id)}>Confirm completed</button>
        </div>}
      </div>)}</div>)}
    </section>
  </>;
}
