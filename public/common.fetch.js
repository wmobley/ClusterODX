import { getAdminToken, clearAdminToken } from "./authToken.mjs";
export { setAdminToken, clearAdminToken } from "./authToken.mjs";

const authenticatedHeaders = (headers = {}) => {
  const result = { ...headers };
  const adminToken = getAdminToken();
  if (adminToken) result.Authorization = `Bearer ${adminToken}`;
  return result;
};

const authenticatedFetch = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: authenticatedHeaders(options.headers),
  });
  if (response.status === 401) {
    clearAdminToken();
    window.dispatchEvent(new Event("clusterodx-auth-expired"));
  }
  return response;
};

export const getFetch = async (url) => authenticatedFetch(url, {
  method: "get",
  cache: "no-cache",
});

export const postFetch = async (url, { body }) => {
  return await authenticatedFetch(url, {
    method: "post",
    cache: "no-cache",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
};

export const patchFetch = async (url, { body }) => {
  return await authenticatedFetch(url, {
    method: "get",
    cache: "no-cache",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
};

export const deleteFetch = async (url, { body }) => {
  return await authenticatedFetch(url, {
    method: "delete",
    cache: "no-cache",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
};
