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
