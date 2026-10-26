import { html, render } from "./lib/preact.html.mjs";
import { useState, useEffect, useCallback } from "./lib/hooks.module.js";
import { NodeList } from "./component/nodeList.mjs";
import { Header } from "./component/header.mjs";
import { RefreshButton } from "./component/refreshButton.mjs";
import { AddInstanceButton } from "./component/addInstanceButton.mjs";
import { clearAdminToken, getFetch } from "./common.fetch.js";
import { getStartupToken, validateAdminToken, cancelAdminValidation } from "./authToken.mjs";

const getInfoData = async () => {
  const res = await getFetch("/r/info");
  if (!res.ok) throw new Error("Unable to load ClusterODX information");
  return await res.json();
};
const getNodesData = async () => {
  const res = await getFetch("/r/node/list");
  if (!res.ok) throw new Error("Unable to load ClusterODX nodes");
  return await res.json();
};
const useNodes = () => {
  const [nodes, setNodes] = useState([]);
  const getData = () => {
    getNodesData().then((nextNodes) => setNodes(nextNodes)).catch(() => {});
  };

  return [nodes, getData];
};

const Login = ({ onAuthenticated }) => {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const authenticate = useCallback(async (value) => {
    if (!await validateAdminToken(value)) return;
    setToken("");
    onAuthenticated();
  }, [onAuthenticated]);

  const submit = async (event) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) {
      setError("Paste a Tapis JWT to continue.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await authenticate(value);
    } catch (loginError) {
      setError(loginError.message || "JWT validation failed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const value = getStartupToken();
    if (!value) return;

    setBusy(true);
    setError("");
    authenticate(value)
      .catch((loginError) => setError(loginError.message || "JWT validation failed"))
      .finally(() => setBusy(false));
    return cancelAdminValidation;
  }, [authenticate]);

  return html`
    <main class="container py-5">
      <div class="row justify-content-center">
        <div class="col-md-8 col-lg-6">
          <div class="card shadow-sm">
            <div class="card-body">
              <h2 class="card-title mb-3">ClusterODX admin login</h2>
              <p class="text-muted">Paste a Tapis JWT to administer this ClusterODX instance.</p>
              <form onSubmit=${submit}>
                <label class="form-label" for="tapis-jwt">Tapis JWT</label>
                <textarea
                  id="tapis-jwt"
                  class="form-control"
                  rows="6"
                  autocomplete="off"
                  spellcheck="false"
                  value=${token}
                  onInput=${(event) => setToken(event.currentTarget.value)}
                ></textarea>
                ${error && html`<div class="alert alert-danger mt-3" role="alert">${error}</div>`}
                <button class="btn btn-primary mt-3" type="submit" disabled=${busy}>
                  ${busy ? "Checking token…" : "Sign in"}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </main>
  `;
};

export default function App() {
  const [info, setInfo] = useState({ name: "", version: "" });
  const [nodes, getNodes] = useNodes();
  const [authenticated, setAuthenticated] = useState(false);

  const [autoRefresh, setAutoRefresh] = useState({ isAutoRefresh: false, intervalHandler: null });

  const loadDashboard = useCallback(() => {
    getInfoData().then((infoData) => setInfo(infoData)).catch(() => {});
    getNodes();
  }, []);

  useEffect(() => {
    const onAuthExpired = () => {
      setAuthenticated(false);
      setAutoRefresh({ isAutoRefresh: false, intervalHandler: null });
    };
    window.addEventListener("clusterodx-auth-expired", onAuthExpired);
    return () => window.removeEventListener("clusterodx-auth-expired", onAuthExpired);
  }, []);

  useEffect(() => {
    if (authenticated) loadDashboard();
  }, [authenticated, loadDashboard]);

  useEffect(() => {
    if (autoRefresh.isAutoRefresh) {
      const intervalHandler = setInterval(() => {
        getNodes();
      }, 5000);
      setAutoRefresh({ ...autoRefresh, intervalHandler });
    } else {
      if (autoRefresh.intervalHandler > 0) {
        clearInterval(autoRefresh.intervalHandler);
        setAutoRefresh({ ...autoRefresh, intervalHandler: null });
      }
    }
  }, [autoRefresh.isAutoRefresh]);

  if (!authenticated) {
    return html`<${Login} onAuthenticated=${() => setAuthenticated(true)} />`;
  }

  return html` <div class="container">
    <${Header}
      info=${info}
      onSignout=${() => {
        clearAdminToken();
        setAuthenticated(false);
      }}
    />
    <${NodeList} nodes=${nodes} getData=${getNodes} />

    <div id="btn-area">
      <${AddInstanceButton} getNodes=${getNodes} />
      <div style="flex-grow:1"></div>
      <${RefreshButton} autoRefresh=${autoRefresh} setAutoRefresh=${setAutoRefresh} />
    </div>
  </div>`;
}
