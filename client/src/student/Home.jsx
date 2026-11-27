import { useState } from 'react';
import { api } from '../api';
import { useLoad } from './ui';
import DemoClockBar from '../components/DemoClockBar';

export default function Home({ user, open }) {
  const [state, setState] = useState({ booking: null, parking: null, charging: null });
  useLoad(async () => {
    try {
      const [b, r, q] = await Promise.all([api('/vehicles/bookings'), api('/parking/reservations'), api('/charging/queue')]);
      setState({
        booking: b.bookings.find(x => ['Confirmed', 'In Progress', 'Overdue'].includes(x.status)) || null,
        parking: r.reservations.find(x => ['Confirmed', 'In Progress'].includes(x.status)) || null,
        charging: q.requests.find(x => x.user_id === user.id && ['Queued', 'Assigned', 'Charging'].includes(x.status)) || null
      });
    } catch { /* keep the last values */ }
  });
  const { booking, parking, charging } = state;
  const bookNote = booking ? (booking.status === 'Confirmed' ? 'Pick up now' : 'On a trip') : null;
  const parkNote = parking ? (parking.status === 'Confirmed' ? 'Reserved' : 'Parked') : null;
  const chargeNote = charging ? { Queued: 'In queue', Assigned: 'Go to charger', Charging: 'Charging' }[charging.status] : null;

  return <>
    <div className="stu-top" style={{ justifyContent: 'flex-end' }}><DemoClockBar user={user}/></div>
    {booking && <button className="stu-card highlight" style={{ textAlign: 'left', font: 'inherit', cursor: 'pointer' }} onClick={() => open('book')}>
      <b>{booking.status === 'Confirmed' ? `Your ${booking.plate} is waiting for you` : 'You are on a trip'}</b>
      <span>Tap to continue →</span>
    </button>}
    <h2>What do you need?</h2>
    <div className="tile-grid">
      <button className="tile book" onClick={() => open('book')}><span className="tile-icon">🛵</span><div><b>Book a vehicle</b>{bookNote && <div><span className="tile-note">{bookNote}</span></div>}</div></button>
      <button className="tile park" onClick={() => open('park')}><span className="tile-icon">🅿️</span><div><b>Park my vehicle</b>{parkNote && <div><span className="tile-note">{parkNote}</span></div>}</div></button>
      <button className="tile charge" onClick={() => open('charge')}><span className="tile-icon">⚡</span><div><b>Charge my vehicle</b>{chargeNote && <div><span className="tile-note">{chargeNote}</span></div>}</div></button>
      <button className="tile report" onClick={() => open('report')}><span className="tile-icon">🛟</span><div><b>Report a problem</b></div></button>
      <button className="tile hubs" onClick={() => open('hubs')}><span className="tile-icon">🗺️</span><div><b>View Hubs</b></div></button>
    </div>
  </>;
}
