// The three main management accounts are pinned to the top of account lists; everyone else is sorted by name.
const MAIN = ['Admin', 'Operator', 'Simulation Operator'];
export const isMainAccount = u => MAIN.includes(u.full_name) && u.full_name === u.role;

export function sortAccounts(users) {
  const rank = u => (isMainAccount(u) ? MAIN.indexOf(u.full_name) : MAIN.length);
  return [...users].sort((a, b) => rank(a) - rank(b)
    || a.full_name.localeCompare(b.full_name, 'en', { sensitivity: 'base' })
    || a.role.localeCompare(b.role));
}
