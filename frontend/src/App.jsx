import { useEffect, useRef, useState } from "react";
import "./App.css";

const API_URL = import.meta.env.VITE_ADMIN_API_URL || "http://127.0.0.1:8100";

export default function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [instance, setInstance] = useState(null);
  const [prep, setPrep] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [runningTest, setRunningTest] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState(null);

  const pollRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function readResponse(response) {
    const text = await response.text();
    let data = {};

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("The server returned an unreadable response.");
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        setToken("");
        throw new Error(data.detail || "Session expired. Please log in again.");
      }

      throw new Error(
        data.detail || `Request failed (HTTP ${response.status}).`,
      );
    }

    return data;
  }

  function authHeaders() {
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  async function handleLogin(event) {
    event.preventDefault();
    setMessage("");
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await readResponse(response);

      if (!data.access_token) {
        throw new Error("Login response did not contain an access token.");
      }

      setToken(data.access_token);
      setPassword("");
      setMessage("Login successful. Admin controller is ready.");
    } catch (error) {
      setMessage(error.message || "Unable to connect to the controller.");
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    setToken("");
    setUsername("");
    setPassword("");
    setInstanceId("");
    setInstance(null);
    setPrep(null);
    setMessage("Logged out.");
  }

  async function checkController() {
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(`${API_URL}/admin/status`, {
        headers: authHeaders(),
      });

      const data = await readResponse(response);
      setMessage(`Authenticated as ${data.admin}. Controller is ready.`);
    } catch (error) {
      setMessage(error.message || "Controller check failed.");
    } finally {
      setLoading(false);
    }
  }

  async function lookupInstance(event) {
    event.preventDefault();
    setMessage("");
    setInstance(null);
    setPrep(null);

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    const id = instanceId.trim();

    if (!/^\d{1,12}$/.test(id)) {
      setMessage("Enter a valid numeric Vast.ai instance ID.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(
        `${API_URL}/admin/vast/instances/${encodeURIComponent(id)}`,
        { headers: authHeaders() },
      );

      const data = await readResponse(response);

      if (!data.instance || typeof data.instance !== "object") {
        throw new Error("Instance details were not returned.");
      }

      setInstance(data.instance);
      setMessage(`Successfully retrieved Vast.ai instance ${id}.`);
    } catch (error) {
      setMessage(error.message || "Failed to retrieve the instance.");
    } finally {
      setLoading(false);
    }
  }

  async function startPrepare() {
    const id = instanceId.trim();

    if (!instance || !id) return;

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    setPrep({
      status: "running",
      stage: "queued",
      progress: 0,
      detail: "Starting preparation...",
    });

    setMessage("");

    try {
      await readResponse(
        await fetch(`${API_URL}/admin/vast/instances/${id}/prepare`, {
          method: "POST",
          headers: authHeaders(),
        }),
      );

      async function pollStatus() {
        try {
          const data = await readResponse(
            await fetch(`${API_URL}/admin/vast/instances/${id}/prepare`, {
              headers: authHeaders(),
            }),
          );

          setPrep(data);

          if (data.status !== "running") {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }

            if (data.status === "done") {
              setMessage(
                "Preparation completed. Model readiness and generation test passed.",
              );
            } else if (data.status === "failed") {
              setMessage(data.detail || "Preparation failed.");
            }
          }
        } catch (error) {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }

          setMessage(error.message || "Could not retrieve preparation status.");
        }
      }

      await pollStatus();

      if (!pollRef.current) {
        // Start polling only if the job is still running.
        const statusResponse = await fetch(
          `${API_URL}/admin/vast/instances/${id}/prepare`,
          { headers: authHeaders() },
        );

        const statusData = await readResponse(statusResponse);

        if (statusData.status === "running") {
          pollRef.current = setInterval(pollStatus, 5000);
        }
      }
    } catch (error) {
      setPrep({
        status: "failed",
        stage: "failed",
        detail: error.message || "Could not start preparation.",
      });
      setMessage(error.message || "Could not start preparation.");
    }
  }

  async function runTest() {
    const id = instanceId.trim();

    if (!id || prep?.status !== "done" || !prep?.model_ready) {
      setMessage("Prepare the instance successfully before running the test.");
      return;
    }

    setRunningTest(true);
    setMessage("");

    try {
      const response = await fetch(
        `${API_URL}/admin/vast/instances/${id}/run`,
        {
          method: "POST",
          headers: authHeaders(),
        },
      );

      const data = await readResponse(response);

      setMessage(
        data.success
          ? "Connect / Run test passed successfully."
          : "The inference test did not pass.",
      );
    } catch (error) {
      setMessage(error.message || "Inference test failed.");
    } finally {
      setRunningTest(false);
    }
  }

  async function connectToChatbot() {
    const id = instanceId.trim();

    if (!id || prep?.status !== "done" || !prep?.model_ready) {
      setMessage("Prepare the instance successfully before connecting.");
      return;
    }

    setConnecting(true);
    setMessage("");
    setConnection(null);

    try {
      const response = await fetch(
        `${API_URL}/admin/vast/instances/${encodeURIComponent(id)}/connect`,
        {
          method: "POST",
          headers: authHeaders(),
        },
      );

      const data = await readResponse(response);

      if (!data.connected || data.health?.model_loaded !== true) {
        throw new Error(
          "The tunnel connected, but the remote model is not ready.",
        );
      }

      setConnection(data);
      setMessage(
        "Connected successfully! The remote Qwen model is ready for MedAssist.",
      );
    } catch (error) {
      setConnection(null);
      setMessage(error.message || "Could not connect to the inference server.");
    } finally {
      setConnecting(false);
    }
  }

  async function disconnectChatbot() {
    const id = instanceId.trim();

    if (!id) return;

    setConnecting(true);
    setMessage("");

    try {
      const response = await fetch(
        `${API_URL}/admin/vast/instances/${encodeURIComponent(id)}/disconnect`,
        {
          method: "POST",
          headers: authHeaders(),
        },
      );

      await readResponse(response);

      setConnection(null);
      setMessage("Inference tunnel disconnected.");
    } catch (error) {
      setMessage(error.message || "Could not disconnect the tunnel.");
    } finally {
      setConnecting(false);
    }
  }

  const progress = Math.max(0, Math.min(100, Number(prep?.progress || 0)));

  return (
    <main className="admin-page">
      <aside className="admin-sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">M</div>
          <div>
            <p className="brand-name">MedAssist</p>
            <p className="brand-subtitle">Admin Controller</p>
          </div>
        </div>

        <p className="sidebar-label">Workspace</p>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <div className="nav-item active" aria-current="page">
            <span className="nav-symbol" aria-hidden="true">⌂</span>
            Controller
          </div>
          {token && (
            <button className="nav-item" onClick={handleLogout}>
              <span className="nav-symbol" aria-hidden="true">↪</span>
              Log out
            </button>
          )}
        </nav>

        <div className="sidebar-bottom">
          <strong>Secure workspace</strong>
          Manage your AI inference deployment.
        </div>
      </aside>

      <section className="admin-main">
        <header className="page-heading">
          <div>
            <p className="heading-kicker">MEDASSIST / CONTROL CENTER</p>
            <h1>{token ? "Welcome back, Admin" : "Welcome to MedAssist"}</h1>
            <p className="subtitle">
              {token
                ? "Manage and prepare your existing Vast.ai instance."
                : "Sign in securely to manage your AI inference deployment."}
            </p>
          </div>
          <div className="online-pill">
            <span className="online-dot" />
            {token ? "Controller access" : "Secure login"}
          </div>
        </header>

        <section className="admin-card">
          {!token ? (
            <>
              <div className="login-heading">
                <div className="admin-icon" aria-hidden="true">↗</div>
                <div>
                  <h2>Admin login</h2>
                  <p className="subtitle">Sign in to continue to your controller.</p>
                </div>
              </div>

              <form className="login-form" onSubmit={handleLogin}>
                <label htmlFor="username">Admin login ID</label>
                <input
                  id="username"
                  autoComplete="username"
                  placeholder="Enter your admin login ID"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                />

                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />

                <button type="submit" disabled={loading}>
                  {loading ? "Signing in..." : "Secure login  →"}
                </button>
                <p className="form-note">
                  <span aria-hidden="true">●</span> Your session is authenticated by the MedAssist controller.
                </p>
              </form>
            </>
          ) : (
            <div className="dashboard">
              <div className="section-intro">
                <div className="admin-icon" aria-hidden="true">✓</div>
                <div>
                  <h2>Deployment controller</h2>
                  <p className="subtitle">
                    Check controller status, look up an existing instance, and prepare its model.
                    This panel does not create or destroy instances.
                  </p>
                </div>
              </div>

              <section className="controller-panel">
                <div className="panel-heading">
                  <div className="panel-icon" aria-hidden="true">⌁</div>
                  <div>
                    <h3>Check Controller</h3>
                    <p className="subtitle">Verify that the admin controller is running and accessible.</p>
                  </div>
                </div>
                <button onClick={checkController} disabled={loading}>
                  {loading ? "Checking controller..." : "Check Controller  →"}
                </button>
              </section>

              <form className="lookup-form" onSubmit={lookupInstance}>
                <div className="panel-heading">
                  <div className="panel-icon lookup-icon" aria-hidden="true">⌕</div>
                  <div>
                    <h3>Lookup Vast.ai Instance</h3>
                    <p className="subtitle">Enter an instance ID to retrieve its details.</p>
                  </div>
                </div>
                <label htmlFor="instanceId">Vast.ai instance ID</label>
                <div className="lookup-row">
                  <input
                    id="instanceId"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="Enter your instance ID"
                    value={instanceId}
                    onChange={(event) => setInstanceId(event.target.value)}
                    required
                  />
                  <button type="submit" disabled={loading}>
                    {loading ? "Looking up..." : "Get Instance Details"}
                  </button>
                </div>
              </form>

              {instance && (
                <section className="instances-section">
                  <div className="section-title-row">
                    <div>
                      <p className="section-eyebrow">INSTANCE OVERVIEW</p>
                      <h3>Instance details</h3>
                    </div>
                    <span className="instance-status">
                      <span className="online-dot" />
                      {instance.actual_status || instance.cur_state || "Status unknown"}
                    </span>
                  </div>

                  <article className="instance-item">
                    <div className="instance-hero">
                      <div className="instance-glyph" aria-hidden="true">▤</div>
                      <div>
                        <h4>{instance.gpu_name || "GPU name unavailable"}</h4>
                        <p>Instance #{instance.id ?? instanceId}</p>
                      </div>
                    </div>
                    <div className="instance-metrics">
                      <div>
                        <strong>GPU COUNT</strong>
                        <span>{instance.num_gpus ?? "—"}</span>
                      </div>
                      <div>
                        <strong>CPU CORES</strong>
                        <span>{instance.cpu_cores ?? "—"}</span>
                      </div>
                      <div>
                        <strong>GPU RAM</strong>
                        <span>{instance.gpu_ram ?? "—"}</span>
                      </div>
                      <div>
                        <strong>CPU RAM</strong>
                        <span>{instance.cpu_ram ?? "—"}</span>
                      </div>
                    </div>
                  </article>

                  <section className="prepare-card">
                    <div className="prepare-heading">
                      <div className="panel-heading">
                        <div className="panel-icon prepare-icon" aria-hidden="true">↗</div>
                        <div>
                          <h3>Prepare Instance</h3>
                          <p className="subtitle">Install requirements and download the model.</p>
                        </div>
                      </div>
                      <button
                        onClick={startPrepare}
                        disabled={prep?.status === "running" || loading}
                      >
                        {prep?.status === "running"
                          ? "Preparing instance..."
                          : "Prepare Instance  →"}
                      </button>
                    </div>

                    {prep && (
                      <section className="prepare-status" aria-live="polite">
                        <div className="section-title-row">
                          <div>
                            <p className="section-eyebrow">PREPARATION PROGRESS</p>
                            <h3>{prep.status === "done" ? "Preparation complete" : prep.status === "failed" ? "Preparation failed" : "Preparing your instance"}</h3>
                          </div>
                          <span className={`progress-value ${prep.status === "failed" ? "failed" : ""}`}>
                            {prep.status === "running" ? `${progress}%` : prep.status === "done" ? "100%" : prep.status}
                          </span>
                        </div>

                        <div className="progress-steps">
                          {["Queued", "Downloading", "Installing", "Configuring", "Testing", "Completed"].map((step, index) => {
                            const currentStage = (prep.stage || prep.status || "").toLowerCase();
                            const completed = prep.status === "done" || index < Math.max(0, ["queued", "downloading", "installing", "configuring", "testing", "completed"].indexOf(currentStage));
                            const active = prep.status === "running" && currentStage.includes(step.toLowerCase());
                            return (
                              <div key={step} className={`progress-step ${completed ? "completed" : ""} ${active ? "active" : ""}`}>
                                <span className="step-dot">{completed ? "✓" : index + 1}</span>
                                <span>{step}</span>
                              </div>
                            );
                          })}
                        </div>

                        <progress value={prep.status === "done" ? 100 : progress} max="100" />
                        <p className="prepare-detail">{prep.detail || "Waiting for status..."}</p>

                        {prep.status === "done" && prep.model_ready && (
                          <>
                            <button className="test-button" onClick={runTest} disabled={runningTest}>
                              {runningTest ? "Testing inference..." : "Connect / Run test"}
                            </button>
                            <section className="connection-panel" aria-live="polite">
                              <div className="section-title-row">
                                <div>
                                  <p className="section-eyebrow">CHATBOT SERVICE</p>
                                  <h3>Chatbot connection</h3>
                                </div>
                                {connection?.connected && (
                                  <span className="instance-status"><span className="online-dot" />Connected</span>
                                )}
                              </div>

                              {connection?.connected ? (
                                <>
                                  <p className="connection-ready">Qwen is ready for MedAssist.</p>
                                  <p>Local inference URL: <code>http://127.0.0.1:18000</code></p>
                                  <button className="secondary" onClick={disconnectChatbot} disabled={connecting}>
                                    {connecting ? "Disconnecting..." : "Disconnect"}
                                  </button>
                                </>
                              ) : (
                                <>
                                  <p className="subtitle">Connect your local MedAssist backend to the running inference service.</p>
                                  <button onClick={connectToChatbot} disabled={connecting || runningTest}>
                                    {connecting ? "Connecting to Qwen..." : "Connect to MedAssist"}
                                  </button>
                                </>
                              )}
                            </section>
                          </>
                        )}

                        {prep.status === "failed" && (
                          <p className="error-detail" role="alert">
                            Preparation failed. Review the backend terminal for diagnostic details before retrying.
                          </p>
                        )}
                      </section>
                    )}
                  </section>
                </section>
              )}

              <button className="secondary logout-button" onClick={handleLogout}>
                Log out
              </button>
            </div>
          )}

          {message && (
            <p className="message" role="status" aria-live="polite">
              <span className="message-mark" aria-hidden="true">✓</span>
              {message}
            </p>
          )}
        </section>

        <p className="footer">MedAssist · Private administrator access</p>
      </section>
    </main>
  );
}
