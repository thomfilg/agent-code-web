// How long a saved sign-in lasts, from its longest-lived login cookie.
export function loginState(session, now = Date.now()) {
  if (session.sessionOnly || !session.expiresAt) return { level: "expired", days: null, text: "session cookie only — starts signed out" };
  const days = Math.floor((Date.parse(session.expiresAt) - now) / 86400000);
  if (days < 0) return { level: "expired", days, text: `expired ${new Date(session.expiresAt).toLocaleDateString()}` };
  if (days < 7) return { level: "expiring", days, text: `expires in ${days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`}` };
  return { level: "valid", days, text: `valid until ${new Date(session.expiresAt).toLocaleDateString()}` };
}
