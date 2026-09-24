export function codexApprovalSettings(mode) {
  return {
    // Auto must be non-interactive. The native sandbox still fences writes and
    // network access; actions that need broader permissions fail back to the
    // agent instead of escaping into a user approval card.
    approvalPolicy: mode === "auto" ? "never" : "on-request",
    approvalsReviewer: mode === "auto" ? "auto_review" : "user",
  };
}
