const SESSION_KEY = "clusterodx.admin.jwt";
let adminToken = null;
let validationAttempt = 0;

export const getAdminToken = () => adminToken;

export const setAdminToken = (token) => {
  adminToken = token;
  try { window.sessionStorage.setItem(SESSION_KEY, token); } catch (_) {}
};

export const cancelAdminValidation = () => { validationAttempt++; };

export const clearAdminToken = () => {
  cancelAdminValidation();
  adminToken = null;
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
};

export const getStartupToken = () => {
  const fragmentToken = consumeHashToken();
  if (fragmentToken) return fragmentToken;
  try { return window.sessionStorage.getItem(SESSION_KEY) || ""; } catch (_) { return ""; }
};

// A stale validation response must never restore a signed-out or newer session.
export const validateAdminToken = async (token) => {
  const attempt = ++validationAttempt;
  let response;
  try {
    response = await fetch("/r/auth/validate", {
      method: "post",
      cache: "no-cache",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (_) {
    if (attempt !== validationAttempt) return false;
    throw new Error("Unable to validate JWT. Try again.");
  }
  if (attempt !== validationAttempt) return false;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) clearAdminToken();
    throw new Error("JWT validation failed");
  }
  setAdminToken(token);
  return true;
};

export const extractHashToken = (hash = "") => {
  const hashValue = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(hashValue).get("token");
  return token ? token.trim() : "";
};

export const consumeHashToken = (windowObject = window) => {
  const token = extractHashToken(windowObject.location.hash);
  if (!token) return "";

  const { pathname, search } = windowObject.location;
  windowObject.history.replaceState(
    null,
    windowObject.document?.title || "",
    `${pathname}${search}`,
  );

  return token;
};
