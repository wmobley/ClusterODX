import { html, render } from "./lib/preact.html.mjs";
import { useState, useEffect, useCallback, useRef } from "./lib/hooks.module.js";
import { TaskList } from "./component/taskList.mjs";
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
  const [nodes, setNodes] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState({ isAutoRefresh: false });
  const session = useRef({ active: false, generation: 0, request: 0 });

  const loadDashboard = useCallback(async () => {
    if (!session.current.active) return;
    const generation = session.current.generation;
    const request = ++session.current.request;
    const isCurrent = () => session.current.active &&
      generation === session.current.generation && request === session.current.request;
    setTaskLoading(true);
    const results = await Promise.allSettled([
      getInfoData(),
      getNodesData(),
      getFetch("/r/task/list").then(async (response) => {
        if (!response.ok) throw new Error("Unable to load tasks");
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error("Invalid task list");
        return rows;
      }),
    ]);
    if (!isCurrent()) return;
    if (results[0].status === "fulfilled") setInfo(results[0].value);
    if (results[1].status === "fulfilled") setNodes(results[1].value);
    if (results[2].status === "fulfilled") {
      setTasks(results[2].value);
      setTaskError("");
    } else {
      setTaskError("Unable to load tasks. Try refreshing; displayed tasks may be outdated.");
    }
    setTaskLoading(false);
  }, []);

  const resetDashboard = useCallback(() => {
    session.current.active = false;
    session.current.generation++;
    setAuthenticated(false);
    setAutoRefresh({ isAutoRefresh: false });
    setInfo({ name: "", version: "" });
    setNodes([]);
    setTasks([]);
    setTaskLoading(false);
    setTaskError("");
  }, []);

  const onAuthenticated = useCallback(() => {
    session.current.active = true;
    session.current.generation++;
    setAuthenticated(true);
  }, []);

  useEffect(() => {
    window.addEventListener("clusterodx-auth-expired", resetDashboard);
    return () => window.removeEventListener("clusterodx-auth-expired", resetDashboard);
  }, [resetDashboard]);

  useEffect(() => {
    if (!authenticated) return;
    loadDashboard();
    return () => {
      session.current.active = false;
      session.current.generation++;
    };
  }, [authenticated, loadDashboard]);

  useEffect(() => {
    if (!authenticated || !autoRefresh.isAutoRefresh) return;
    const interval = setInterval(loadDashboard, 5000);
    return () => clearInterval(interval);
  }, [authenticated, autoRefresh.isAutoRefresh, loadDashboard]);

  if (!authenticated) {
    return html`<${Login} onAuthenticated=${onAuthenticated} />`;
  }

  return html`<div class="container">
    <${Header}
      info=${info}
      onSignout=${() => {
        clearAdminToken();
        resetDashboard();
      }}
    />
    <${NodeList} nodes=${nodes} getData=${loadDashboard} />
    <div id="btn-area">
      <${AddInstanceButton} getNodes=${loadDashboard} />
      <div style="flex-grow:1"></div>
      <button class="btn btn-outline-primary mx-2" onClick=${loadDashboard}>Refresh</button>
      <${RefreshButton} autoRefresh=${autoRefresh} setAutoRefresh=${setAutoRefresh} />
    </div>
    <${TaskList} tasks=${tasks} loading=${taskLoading} error=${taskError} />
  </div>`;
}
