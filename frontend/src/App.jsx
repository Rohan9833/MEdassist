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
      <section className="admin-card">
        <div className="admin-icon">M</div>

        <p className="eyebrow">MEDASSIST</p>
        <h1>Admin Control Panel</h1>

        <p className="subtitle">
          Secure access to your AI inference deployment.
        </p>

        {!token ? (
          <form onSubmit={handleLogin}>
            <label htmlFor="username">Admin login ID</label>

            <input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />

            <label htmlFor="password">Password</label>

            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />

            <button type="submit" disabled={loading}>
              {loading ? "Signing in..." : "Secure login"}
            </button>
          </form>
        ) : (
          <div className="dashboard">
            <div className="status">
              <span className="status-dot" />
              Authenticated
            </div>

            <h2>Deployment controller</h2>

            <p className="subtitle">
              Enter the ID of your existing Vast.ai instance. This panel does
              not create or destroy instances.
            </p>

            <button onClick={checkController} disabled={loading}>
              Check controller
            </button>

            <form onSubmit={lookupInstance}>
              <label htmlFor="instanceId">Vast.ai instance ID</label>

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
                {loading ? "Checking..." : "Verify instance"}
              </button>
            </form>

            {instance && (
              <section className="instances-section">
                <h3>Instance details</h3>

                <article className="instance-item">
                  <h4>{instance.gpu_name || "GPU name unavailable"}</h4>

                  <p>
                    <strong>Instance ID:</strong> {instance.id ?? instanceId}
                  </p>

                  <p>
                    <strong>Status:</strong>{" "}
                    {instance.actual_status || instance.cur_state || "Unknown"}
                  </p>

                  {instance.num_gpus != null && (
                    <p>
                      <strong>GPU count:</strong> {instance.num_gpus}
                    </p>
                  )}

                  {instance.cpu_cores != null && (
                    <p>
                      <strong>CPU cores:</strong> {instance.cpu_cores}
                    </p>
                  )}

                  {instance.gpu_ram != null && (
                    <p>
                      <strong>GPU RAM:</strong> {instance.gpu_ram}
                    </p>
                  )}

                  {instance.cpu_ram != null && (
                    <p>
                      <strong>CPU RAM:</strong> {instance.cpu_ram}
                    </p>
                  )}
                </article>

                <button
                  onClick={startPrepare}
                  disabled={prep?.status === "running" || loading}
                >
                  {prep?.status === "running"
                    ? "Preparing instance..."
                    : "Install requirements & download model"}
                </button>

                {prep && (
                  <section className="prepare-status" aria-live="polite">
                    <h3>Preparation status</h3>

                    <p>
                      <strong>Status:</strong> {prep.status}
                    </p>

                    <p>
                      <strong>Stage:</strong> {prep.stage || "Starting"}
                    </p>

                    <p>{prep.detail || "Waiting for status..."}</p>

                    {prep.status === "running" && (
                      <>
                        <progress
                          value={progress}
                          max="100"
                          style={{ width: "100%" }}
                        />
                        <p>{progress}%</p>
                      </>
                    )}

                    {prep.status === "done" && prep.model_ready && (
                      <button onClick={runTest} disabled={runningTest}>
                        {runningTest
                          ? "Testing inference..."
                          : "Connect / Run test"}
                      </button>
                    )}

                    {prep.status === "done" && prep.model_ready && (
                      <section className="connection-panel" aria-live="polite">
                        <h3>Chatbot connection</h3>

                        {connection?.connected ? (
                          <>
                            <p className="status">
                              <span className="status-dot" />
                              Connected — Qwen is ready
                            </p>

                            <p>
                              Local inference URL:{" "}
                              <code>http://127.0.0.1:18000</code>
                            </p>

                            <button
                              className="secondary"
                              onClick={disconnectChatbot}
                              disabled={connecting}
                            >
                              {connecting ? "Disconnecting..." : "Disconnect"}
                            </button>
                          </>
                        ) : (
                          <>
                            <p>
                              Connect your local MedAssist backend to the
                              running inference service.
                            </p>

                            <button
                              onClick={connectToChatbot}
                              disabled={connecting || runningTest}
                            >
                              {connecting
                                ? "Connecting to Qwen..."
                                : "Connect to MedAssist"}
                            </button>
                          </>
                        )}
                      </section>
                    )}

                    {prep.status === "failed" && (
                      <p role="alert">
                        Preparation failed. Review the backend terminal for
                        diagnostic details before retrying.
                      </p>
                    )}
                  </section>
                )}
              </section>
            )}

            <button className="secondary" onClick={handleLogout}>
              Log out
            </button>
          </div>
        )}

        {message && (
          <p className="message" role="status" aria-live="polite">
            {message}
          </p>
        )}

        <p className="footer">Private administrator access</p>
      </section>
    </main>
  );
}
