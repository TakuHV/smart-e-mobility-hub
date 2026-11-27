import { useEffect, useState } from 'react';

/*
 * DEMO ONLY — not part of the project scope.
 * Shows the whole app inside a phone-sized frame on a desktop screen. The app runs in an <iframe> of this same page
 * (?embedded=1), so its mobile layout and media queries react to the 390 px frame width exactly like on a real phone.
 */
const KEY = 'smh_phone_view';
export const isEmbedded = () => new URLSearchParams(window.location.search).has('embedded');

function usePhoneView() {
  const [on, setOn] = useState(() => localStorage.getItem(KEY) === '1');
  const set = value => { localStorage.setItem(KEY, value ? '1' : '0'); setOn(value); };
  return [on, set];
}

export default function PhoneViewHost({ children }) {
  const [phone, setPhone] = usePhoneView();
  const [wide, setWide] = useState(window.innerWidth > 900);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth > 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (isEmbedded()) return children;
  if (phone && wide) {
    return <div className="phone-stage">
      <div className="phone-demo-note"><b>DEMO ONLY</b> · phone view is a presentation aid, not part of the project scope</div>
      <div className="phone-device" aria-label="Phone preview">
        <div className="phone-notch"/>
        <iframe title="Phone preview" className="phone-screen" src={`${window.location.pathname}?embedded=1`}/>
      </div>
      <button className="button secondary" onClick={() => setPhone(false)}>Exit phone view</button>
    </div>;
  }
  return <>
    {children}
    {wide && <button className="phone-toggle" onClick={() => setPhone(true)} title="Demo only — not part of the project scope">📱 Phone view <small>demo only</small></button>}
  </>;
}
