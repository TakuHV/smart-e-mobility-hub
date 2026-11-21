import { useEffect, useState } from 'react';
import { api } from '../api';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import { EmptyState, Feedback } from '../components/Feedback';

const scenarios = [
  ['parking_surge','Sudden increase of arrivals'],
  ['capacity_pressure','Hub near full capacity'],
  ['charger_outage','Charger outage'],
  ['charging_demand','Increased charging demand'],
  ['vehicle_imbalance','Vehicle concentration imbalance']
];

export default function Simulation() {
  const [hubs, setHubs] = useState([]);
  const [hubId, setHubId] = useState('hub-central');
  const [scenarioType, setScenarioType] = useState('parking_surge');
  const [demandDelta, setDemandDelta] = useState(2);
  const [chargerOutageCount, setChargerOutageCount] = useState(1);
  const [runs, setRuns] = useState([]);
  const [latestRun, setLatestRun] = useState(null);
  const [selectedRunIds, setSelectedRunIds] = useState([]);
  const [comparison, setComparison] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function load() {
    try {
      const [h,r,ho] = await Promise.all([api('/hubs'),api('/simulation/runs'),api('/simulation/handoffs')]);
      setHubs(h.hubs);setRuns(r.runs);setHandoffs(ho.handoffs);
      if (!hubId && h.hubs[0]) setHubId(h.hubs[0].id);
    } catch(err){setError(err.message);}
  }
  useEffect(()=>{load();},[]);

  async function runScenario(event) {
    event.preventDefault();setBusy(true);setError('');setSuccess('');setComparison([]);
    try {
      const result=await api('/simulation/runs',{method:'POST',body:{hubId,scenarioType,demandDelta:Number(demandDelta),chargerOutageCount:Number(chargerOutageCount)}});
      setLatestRun(result.run);setSuccess('Simulation run stored. Results are labelled Simulated; live operational state was not changed.');
      await load();
    } catch(err){setError(err.message);}
    finally{setBusy(false);}
  }
  async function openRun(id) {
    setError('');
    try {const result=await api(`/simulation/runs/${id}`);setLatestRun(result.run);}
    catch(err){setError(err.message);}
  }
  function toggleRun(id) {
    setSelectedRunIds(old => old.includes(id) ? old.filter(x=>x!==id) : [...old,id]);
  }
  async function compareRuns() {
    setError('');setSuccess('');
    try {const result=await api('/simulation/compare',{method:'POST',body:{runIds:selectedRunIds}});setComparison(result.comparison);}
    catch(err){setError(err.message);}
  }
  async function recommendationAction(id, action) {
    setError('');setSuccess('');
    try {
      const result=await api(`/simulation/recommendations/${id}/${action}`,{method:'POST',body:{}});
      setSuccess(action==='apply' ? result.note : 'Recommendation declined. No live resource state was changed.');
      if(latestRun) await openRun(latestRun.id);
      await load();
    } catch(err){setError(err.message);}
  }

  return <>
    <SectionHeader eyebrow="STRATEGIC PLANNING · UC-023 / UC-024 / UC-025" title="What-if Simulation" description="Run isolated scenarios, compare immutable results and hand recommendations to their matching operational workflows." action={<button className="button secondary" onClick={load}>↻ Refresh</button>}/>
    <Feedback error={error} success={success}/>
    <div className="simulation-layout">
      <section className="card-surface padded simulation-form-panel">
        <div className="section-mini-head"><div><span className="eyebrow">UC-023</span><h3>Run a scenario</h3></div><span className="mini-icon">◌</span></div>
        <form className="form-stack" onSubmit={runScenario}>
          <label>Baseline Hub<select value={hubId} onChange={e=>setHubId(e.target.value)}>{hubs.map(h=><option value={h.id} key={h.id}>{h.name}</option>)}</select></label>
          <label>Scenario type<select value={scenarioType} onChange={e=>setScenarioType(e.target.value)}>{scenarios.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
          <label>Additional demand / affected requests<input type="number" min="0" max="20" value={demandDelta} onChange={e=>setDemandDelta(e.target.value)}/></label>
          <label>Chargers unavailable in scenario<input type="number" min="0" max="5" value={chargerOutageCount} onChange={e=>setChargerOutageCount(e.target.value)}/></label>
          <button className="button primary full" disabled={busy || !hubId}>{busy?'Simulating…':'Run isolated simulation'} <span>→</span></button>
        </form>
        <div className="rule-callout sim-callout"><strong>Simulation isolation · BR-32 / BR-33</strong><span>Each run stores a baseline snapshot, parameters, results and recommendations. Stored runs cannot be edited.</span><small>All outputs are labelled Simulated and remain separate from live operational data.</small></div>
      </section>
      <section className="card-surface padded run-results-panel">
        <div className="section-mini-head"><div><span className="eyebrow">SIMULATION OUTPUT</span><h3>{latestRun ? latestRun.results.scenarioName : 'Latest run results'}</h3></div>{latestRun && <StatusBadge value="Simulated"/>}</div>
        {!latestRun ? <EmptyState title="No run selected" description="Run a scenario or open a saved run from the history list."/> : <>
          <div className="sim-meta"><span>Run ID <strong>{latestRun.id.slice(0,18)}</strong></span><span>Hub <strong>{latestRun.hub_name}</strong></span><span>Created <strong>{new Date(latestRun.created_at).toLocaleString()}</strong></span></div>
          <div className="result-summary">{latestRun.results.summary}</div>
          <div className="sim-metric-grid">
            <div><span>Personal slot occupancy</span><b>{latestRun.results.projectedPersonalSlotOccupancyPercent}%</b></div>
            <div><span>Available chargers</span><b>{latestRun.results.projectedAvailableChargers}</b></div>
            <div><span>Projected queue</span><b>{latestRun.results.projectedChargingQueue}</b></div>
            <div><span>Available shared EVs</span><b>{latestRun.results.currentAvailableSharedVehicles}</b></div>
          </div>
          <div className="subsection-title section-gap-small"><strong>Coordination recommendations</strong><span>{latestRun.recommendations.length} proposals</span></div>
          <div className="recommendation-list">{latestRun.recommendations.map(rec=><div className="recommendation-card" key={rec.id}>
            <div className="recommendation-heading"><div><span className="rec-type">{rec.type.replaceAll('_',' ')}</span><strong>{rec.title}</strong></div><StatusBadge value={rec.status}/></div>
            <p>{rec.description}</p><small>Projected benefit: {rec.projected_benefit}</small>
            {rec.status==='Proposed' && <div className="button-row"><button className="button small primary" onClick={()=>recommendationAction(rec.id,'apply')}>Send to workflow</button><button className="button small ghost" onClick={()=>recommendationAction(rec.id,'decline')}>Decline</button></div>}
          </div>)}</div>
        </>}
      </section>
    </div>

    <div className="content-grid two-col section-gap">
      <section className="card-surface padded"><div className="subsection-title"><strong>Stored simulation runs</strong><span>{runs.length} immutable runs</span></div>
        {runs.length===0 ? <EmptyState title="No stored runs" description="Your completed simulations will be listed here."/> : <div className="run-list">{runs.map(run=><div className="run-row" key={run.id}>
          <input type="checkbox" checked={selectedRunIds.includes(run.id)} onChange={()=>toggleRun(run.id)} aria-label={`Select run ${run.id}`}/>
          <button className="run-open" onClick={()=>openRun(run.id)}><strong>{run.hub_name}</strong><span>{scenarios.find(s=>s[0]===run.scenario_type)?.[1] || run.scenario_type}</span><small>{new Date(run.created_at).toLocaleString()} · {run.recommendation_count} recommendation(s)</small></button>
          <button className="button small ghost" onClick={()=>openRun(run.id)}>Open</button>
        </div>)}</div>}
        <div className="compare-action"><button className="button secondary full" disabled={selectedRunIds.length<2} onClick={compareRuns}>Compare selected runs ({selectedRunIds.length})</button><small>UC-024 requires at least two comparable stored runs from the same Hub in this MVP.</small></div>
      </section>
      <section className="card-surface padded"><div className="subsection-title"><strong>Workflow hand-offs</strong><span>UC-025</span></div>
        {handoffs.length===0 ? <EmptyState title="No recommendations sent" description="Sending a proposed recommendation creates a pre-filled hand-off to its matching workflow."/> : <div className="handoff-list">{handoffs.map(h=><div className="handoff-card" key={h.id}>
          <div className="handoff-head"><strong>{h.recommendation_title}</strong><StatusBadge value={h.status==='Completed'?'Applied':'Sent for Execution'}/></div>
          <span className="handoff-target">→ {h.target_workflow}</span>
          <small>{new Date(h.created_at).toLocaleString()}</small>
          <p>{h.status==='Pending'?'Pending the receiving operational workflow. The recommendation is not yet Applied.':'Receiving workflow was recorded as completed.'}</p>
        </div>)}</div>}
      </section>
    </div>
    {comparison.length>0 && <section className="card-surface padded section-gap"><div className="subsection-title"><strong>Simulation comparison</strong><span>{comparison.length} runs · Simulated</span></div>
      <div className="comparison-grid" style={{gridTemplateColumns:`repeat(${Math.min(comparison.length,3)},minmax(0,1fr))`}}>{comparison.map(run=><div className="comparison-card" key={run.id}><StatusBadge value="Simulated"/><h4>{scenarios.find(s=>s[0]===run.scenario_type)?.[1] || run.scenario_type}</h4><small>{run.hub_name} · {new Date(run.created_at).toLocaleString()}</small><div className="comparison-stat"><span>Personal occupancy</span><b>{run.results.projectedPersonalSlotOccupancyPercent}%</b></div><div className="comparison-stat"><span>Available chargers</span><b>{run.results.projectedAvailableChargers}</b></div><div className="comparison-stat"><span>Projected queue</span><b>{run.results.projectedChargingQueue}</b></div></div>)}</div>
    </section>}
  </>;
}
