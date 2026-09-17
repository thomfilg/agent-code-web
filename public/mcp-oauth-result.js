// Remove the one-time authorization code from history. The opener polls the
// authenticated API; provider windows never get access to window.opener.
history.replaceState(null, "", location.pathname);
