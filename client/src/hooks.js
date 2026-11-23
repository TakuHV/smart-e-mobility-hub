import { useEffect, useState } from 'react';

// true while the window matches the media query, for example useMediaQuery('(max-width: 760px)')
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = event => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery('(max-width: 760px)');

// After a successful action on a phone, return to the top of the page where the updated state and the message are.
export function scrollTopOnPhone() {
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
}
