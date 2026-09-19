// Partition 1 only: a requested idle policy is not proof that suspension is
// safe. The shipped SSH stdio transport cannot survive disconnection, and no
// admitted image/transport continuity coordinator exists yet. Flags, an EC2
// HibernationOptions field, or a backend.hibernate method cannot bypass this.
// A later partition must replace this denial with bound, revalidated backend,
// reconnectable transport and image admission evidence AND resume coordination.
export const HIBERNATION_UNAVAILABLE = "Hibernation is unavailable: reconnectable process transport and verified worker-image support are not installed. The worker was not stopped. Use Stop explicitly to shut it down.";

export function hibernationAdmission() {
  return { available: false, backend: false, transport: false, image: false, reason: HIBERNATION_UNAVAILABLE };
}

export function hibernationUnavailableError() {
  return Object.assign(new Error(HIBERNATION_UNAVAILABLE), { statusCode: 409, code: "HIBERNATION_UNAVAILABLE" });
}
