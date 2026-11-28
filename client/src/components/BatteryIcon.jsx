// Battery icon (SVG). Colour rules:
//   charging                 -> green
//   not charging, below red  -> red    (class H, very low)
//   not charging, below amber-> orange (too low to book a shared vehicle)
//   not charging, otherwise  -> dark, no colour
// The percentage is always printed next to the icon so the colour is never the only signal.
export const BATTERY_RED_BELOW = 10;
export const BATTERY_AMBER_BELOW = 30;

export function batteryTone(level, charging, redBelow = BATTERY_RED_BELOW, amberBelow = BATTERY_AMBER_BELOW) {
  if (charging) return 'charging';
  if (level < redBelow) return 'red';
  if (level < amberBelow) return 'amber';
  return 'plain';
}

export default function BatteryIcon({ level, charging = false, redBelow, amberBelow, showText = true, size = 'md' }) {
  const value = Number.isFinite(Number(level)) ? Math.max(0, Math.min(100, Number(level))) : 0;
  const tone = batteryTone(value, charging, redBelow, amberBelow);
  const fillWidth = (44 * value) / 100;
  return <span className={`battery-icon ${tone} ${size}`} role="img" aria-label={`Battery ${Math.round(value)}%${charging ? ', charging' : ''}`}>
    <svg viewBox="0 0 64 30" aria-hidden="true">
      <rect className="shell" x="1.5" y="1.5" width="54" height="27" rx="7"/>
      <rect className="cap" x="58" y="10" width="4.5" height="10" rx="2"/>
      {value > 0 && <rect className="fill" x="6" y="6" width={Math.max(fillWidth, 3)} height="18" rx="4"/>}
      {charging && <path className="bolt" d="M31 4 L22 17 H29 L26 26 L37 12 H30 Z"/>}
    </svg>
    {showText && <b>{Math.round(value)}%</b>}
  </span>;
}
