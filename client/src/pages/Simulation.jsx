import { useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';
import RefreshButton from '../components/RefreshButton';

const scenarios = [
  ['parking_surge', 'Sudden increase of arrivals'],
  ['capacity_pressure', 'Hub near full capacity'],
  ['charger_outage', 'Charger outage'],
  ['charging_demand', 'Increased charging demand'],
  ['vehicle_imbalance', 'Vehicle concentration imbalance']
];
const scenarioName = type => scenarios.find(s => s[0] === type)?.[1] || type;

const metricLabels = {
  projectedPersonalSlotOccupancyPercent: 'Personal slot occupancy (%)',
  projectedSharedSlotOccupancyPercent: 'Shared slot occupancy (%)',
  unservedVehicles: 'Vehicles without a free slot',
  currentAvailableSharedVehicles: 'Available shared EVs (now)',
  projectedAvailableSharedVehicles: 'Available shared EVs (scenario)',
  currentAvailableChargers: 'Available chargers (now)',
  projectedAvailableChargers: 'Available chargers (scenario)',
  hubPowerLimitKw: 'Hub Power Limit (kW)',
  currentConcurrentChargingCapacity: 'Chargers running at once (now)',
  projectedConcurrentChargingCapacity: 'Chargers running at once (scenario)',
  currentChargingQueue: 'Charging queue (now)',
  projectedChargingQueue: 'Charging queue (scenario)',
  projectedLongestWaitMinutes: 'Longest wait (minutes)'
};

// The four numbers shown for the open run depend on the scenario.
function headlineMetrics(run) {
  const r = run.results;
  const slotPercent = r.affectedSlotType === 'Shared' ? r.projectedSharedSlotOccupancyPercent : r.projectedPersonalSlotOccupancyPercent;
  const wait = r.projectedLongestWaitMinutes === null ? 'No charger' : `${r.projectedLongestWaitMinutes ?? 0} min`;
  if (run.scenario_type === 'charger_outage' || run.scenario_type === 'charging_demand') {
    return [['Chargers running at once', r.projectedConcurrentChargingCapacity], ['Hub Power Limit', `${r.hubPowerLimitKw} kW`], ['Projected queue', r.projectedChargingQueue], ['Longest wait', wait]];
  }
  if (run.scenario_type === 'vehicle_imbalance') {
    return [['Shared slot occupancy', `${r.projectedSharedSlotOccupancyPercent}%`], ['Level', <StatusBadge key="l" value={r.occupancyLevel}/>], ['Shared EVs here (scenario)', r.projectedAvailableSharedVehicles], ['Without a free slot', r.unservedVehicles]];
  }
  return [[`${r.affectedSlotType} slot occupancy`, `${slotPercent}%`], ['Level', <StatusBadge key="l" value={r.occupancyLevel}/>], ['Without a free slot', r.unservedVehicles], ['Available shared EVs', r.currentAvailableSharedVehicles]];
}

const parameterChips = parameters => Object.entries({
  'Extra demand': parameters.demandDelta, 'Slot type': parameters.slotType, 'Chargers out': parameters.chargerOutageCount,
  'Power limit': parameters.powerLimitKw ? `${parameters.powerLimitKw} kW` : undefined,
  'Session estimate': parameters.estimatedSessionMinutes ? `${parameters.estimatedSessionMinutes} min` : undefined, Name: parameters.runName
}).filter(([, value]) => value !== undefined && value !== '');

export default function Simulation({ user }) {
  const canRun = ['Simulation Operator', 'Admin'].includes(user.role);
  const canConfirm = ['Operator', 'Admin'].includes(user.role);
  const [hubs, setHubs] = useState([]);
  const [hubId, setHubId] = useState('');
  const [scenarioType, setScenarioType] = useState('parking_surge');
  const [demandDelta, setDemandDelta] = useState(2);
  const [slotType, setSlotType] = useState('Personal');
  const [chargerOutageCount, setChargerOutageCount] = useState(1);
  const [powerLimitKw, setPowerLimitKw] = useState('');
  const [runs, setRuns] = useState([]);
  const [latestRun, setLatestRun] = useState(null);
  const [selectedRunIds, setSelectedRunIds] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [handoffs, setHandoffs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function load() {
    try {
      const [h, r, ho] = await Promise.all([api('/hubs'), api('/simulation/runs'), api('/simulation/handoffs')]);
      setHubs(h.hubs); setRuns(r.runs); setHandoffs(ho.handoffs);
      setHubId(prev => prev || h.hubs[0]?.id || '');
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  const isParking = ['parking_surge', 'capacity_pressure'].includes(scenarioType);
  const isCharging = ['charger_outage', 'charging_demand'].includes(scenarioType);

  async function runScenario(event) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess(''); setComparison(null);
    const body = { hubId, scenarioType };
    if (scenarioType !== 'charger_outage') body.demandDelta = Number(demandDelta);
    if (isParking) body.slotType = slotType;
    if (scenarioType === 'charger_outage') body.chargerOutageCount = Number(chargerOutageCount);
    if (isCharging && powerLimitKw !== '') body.powerLimitKw = Number(powerLimitKw);
    try {
      const result = await api('/simulation/runs', { method: 'POST', body });
      setLatestRun(result.run); setSuccess('Simulation run stored. Results are labelled Simulated; live operational state was not changed.');
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function openRun(id) {
    setError('');
    try { setLatestRun((await api(`/simulation/runs/${id}`)).run); }
    catch (err) { setError(err.message); }
  }
  const toggleRun = id => setSelectedRunIds(old => (old.includes(id) ? old.filter(x => x !== id) : [...old, id]));
  async function compareRuns() {
    setError(''); setSuccess('');
    try { setComparison((await api('/simulation/compare', { method: 'POST', body: { runIds: selectedRunIds } })).comparison); }
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
    const note = prompt('Short note about what was done in the receiving workflow (optional)', '');
    if (note === null) return;
    setError(''); setSuccess('');
    try {
      await api(`/simulation/handoffs/${id}/complete`, { method: 'POST', body: { completionNote: note } });
      setSuccess('Hand-off confirmed. The recommendation is now Applied.');
      if (latestRun) await openRun(latestRun.id);
      await load();
    } catch (err) { setError(err.message); }
  }

  return <>
    <SectionHeader eyebrow="STRATEGIC PLANNING · UC-023 / UC-024 / UC-025" title="What-if Simulation" description="Run isolated scenarios, compare stored results and hand recommendations to their matching operational workflows." action={<RefreshButton onClick={load}/>}/>
    <Feedback error={error} success={success}/>
    <div className={`simulation-layout ${canRun ? '' : 'single'}`}>
      {canRun && <section className="card-surface padded simulation-form-panel">
        <div className="section-mini-head"><div><span className="eyebrow">UC-023</span><h3>Run a scenario</h3></div><span className="mini-icon">◌</span></div>
        <form className="form-stack" onSubmit={runScenario}>
          <label>Baseline Hub<select value={hubId} onChange={e => setHubId(e.target.value)}>{hubs.map(h => <option value={h.id} key={h.id}>{h.name}</option>)}</select></label>
          <label>Scenario type<select value={scenarioType} onChange={e => setScenarioType(e.target.value)}>{scenarios.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {scenarioType !== 'charger_outage' && <label>{isParking ? 'Extra arriving vehicles' : scenarioType === 'charging_demand' ? 'Extra charging requests' : 'Extra vehicles concentrated here'}<input type="number" min="1" max="200" value={demandDelta} onChange={e => setDemandDelta(e.target.value)}/></label>}
          {isParking && <label>Slot type under pressure<select value={slotType} onChange={e => setSlotType(e.target.value)}><option>Personal</option><option>Shared</option></select></label>}
          {scenarioType === 'charger_outage' && <label>Chargers out of service<input type="number" min="1" max="20" value={chargerOutageCount} onChange={e => setChargerOutageCount(e.target.value)}/></label>}
          {isCharging && <label>Hub Power Limit to test (kW, optional)<input type="number" min="0" step="0.1" value={powerLimitKw} onChange={e => setPowerLimitKw(e.target.value)} placeholder="Use the Hub’s own limit"/></label>}
          <button className="button primary full" disabled={busy || !hubId}>{busy ? 'Simulating…' : 'Run isolated simulation'} <span>→</span></button>
        </form>
        <div className="rule-callout sim-callout"><strong>Simulation isolation</strong><span>Each run stores a baseline snapshot, its parameters, results and recommendations. Stored runs cannot be edited.</span><small>All outputs are labelled Simulated and remain separate from live operational data. Charging scenarios use the Hub Power Limit; run the same scenario with different limits and compare them.</small></div>
      </section>}
      <section className="card-surface padded run-results-panel">
        <div className="section-mini-head"><div><span className="eyebrow">SIMULATION OUTPUT</span><h3>{latestRun ? latestRun.results.scenarioName : 'Latest run results'}</h3></div>{latestRun && <StatusBadge value="Simulated"/>}</div>
        {!latestRun ? <EmptyState title="No run selected" description={canRun ? 'Run a scenario or open a saved run from the history list.' : 'Open a saved run from the history list.'}/> : <>
          <div className="sim-meta"><span>Run ID <strong>{latestRun.id.slice(0, 18)}</strong></span><span>Hub <strong>{latestRun.hub_name}</strong></span><span>Created <strong>{new Date(latestRun.created_at).toLocaleString()}</strong></span></div>
          <div className="chip-row">{parameterChips(latestRun.parameters).map(([label, value]) => <span className="chip" key={label}>{label} <b>{String(value)}</b></span>)}</div>
          <div className="result-summary">{latestRun.results.summary}</div>
          <div className="sim-metric-grid">{headlineMetrics(latestRun).map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div>
          <div className="subsection-title section-gap-small"><strong>Coordination recommendations</strong><span>{latestRun.recommendations.length} {latestRun.recommendations.length === 1 ? 'proposal' : 'proposals'}</span></div>
          <div className="recommendation-list">{latestRun.recommendations.map(rec => <div className="recommendation-card" key={rec.id}>
            <div className="recommendation-heading"><div><span className="rec-type">{rec.type.replaceAll('_', ' ')}</span><strong>{rec.title}</strong></div><StatusBadge value={rec.status}/></div>
            <p>{rec.description}</p><small>Projected benefit: {rec.projected_benefit}</small>
            {rec.status === 'Proposed' && canRun && <div className="button-row"><button className="button small primary" onClick={() => recommendationAction(rec.id, 'apply')}>Send to workflow</button><button className="button small ghost" onClick={() => recommendationAction(rec.id, 'decline')}>Decline</button></div>}
          </div>)}</div>
        </>}
      </section>
    </div>

    <div className="content-grid two-col section-gap">
      <section className="card-surface padded"><div className="subsection-title"><strong>Stored simulation runs</strong><span>{runs.length} stored {runs.length === 1 ? 'run' : 'runs'}</span></div>
        {runs.length === 0 ? <EmptyState title="No stored runs" description="Completed simulations will be listed here."/> : <div className="run-list">{runs.map(run => <div className="run-row" key={run.id}>
          <input type="checkbox" checked={selectedRunIds.includes(run.id)} onChange={() => toggleRun(run.id)} aria-label={`Select run ${run.id}`}/>
          <button className="run-open" onClick={() => openRun(run.id)}><strong>{run.hub_name}</strong><span>{scenarioName(run.scenario_type)}</span><small>{new Date(run.created_at).toLocaleString()} · {run.recommendation_count} recommendation(s)</small></button>
          <button className="button small ghost" onClick={() => openRun(run.id)}>Open</button>
        </div>)}</div>}
        {canRun && <div className="compare-action"><button className="button secondary full" disabled={selectedRunIds.length < 2} onClick={compareRuns}>Compare selected runs ({selectedRunIds.length})</button><small>Select at least two stored runs from the same Hub (at most 10).</small></div>}
      </section>
      <section className="card-surface padded"><div className="subsection-title"><strong>Workflow hand-offs</strong><span>UC-025</span></div>
        {handoffs.length === 0 ? <EmptyState title="No recommendations sent" description="Sending a proposed recommendation creates a pre-filled hand-off to its matching workflow."/> : <div className="handoff-list">{handoffs.map(h => <div className="handoff-card" key={h.id}>
          <div className="handoff-head"><strong>{h.recommendation_title}</strong><StatusBadge value={h.status === 'Completed' ? 'Applied' : 'Sent for Execution'}/></div>
          <span className="handoff-target">→ {h.target_workflow}{h.prefilled_payload?.targetHubName ? ` · target ${h.prefilled_payload.targetHubName}` : ''}</span>
          <small>{new Date(h.created_at).toLocaleString()}</small>
          <p>{h.status === 'Pending' ? 'Pending the receiving operational workflow. The recommendation is not yet Applied.' : 'The receiving workflow was confirmed as completed.'}</p>
          {h.status === 'Pending' && canConfirm && <button className="button small primary" onClick={() => completeHandoff(h.id)}>Confirm completed</button>}
        </div>)}</div>}
      </section>
    </div>

    {comparison && <section className="card-surface padded section-gap"><div className="subsection-title"><strong>Simulation comparison</strong><span>{comparison.runs.length} runs · Simulated</span></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Metric</th>{comparison.runs.map(run => <th key={run.id} className="num">{scenarioName(run.scenario_type)}<small>{parameterChips(run.parameters).filter(([label]) => label !== 'Name').map(([label, value]) => `${label} ${value}`).join(' · ') || '—'}</small><small>{new Date(run.created_at).toLocaleTimeString()}</small></th>)}</tr></thead>
        <tbody>{comparison.metrics.filter(m => metricLabels[m.metric])
          .map(m => ({ ...m, same: comparison.runs.every(run => m.values[run.id] === m.values[comparison.runs[0].id]) }))
          .sort((a, b) => Number(a.same) - Number(b.same))
          .map(m => <tr key={m.metric} className={m.same ? 'same' : ''}><td>{metricLabels[m.metric]}</td>
          {comparison.runs.map((run, index) => { const value = m.values[run.id]; const diff = m.differenceFromFirst[run.id];
            return <td className="num" key={run.id}>{value === null ? '—' : value}{index > 0 && diff ? <span className={`delta ${diff > 0 ? 'up' : 'down'}`}>{diff > 0 ? '+' : ''}{Math.round(diff * 10) / 10}</span> : null}</td>; })}
        </tr>)}</tbody>
      </table></div>
      <p className="helper-text">Metrics that differ between the runs come first; greyed rows are the same in every run. The change next to a value is the difference from the first run. Whether a higher or lower number is better depends on the metric.</p>
    </section>}
  </>;
}
