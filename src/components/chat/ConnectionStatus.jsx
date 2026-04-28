import { useState, useEffect, useCallback } from "react";
import { ollamaApi } from "../../services/ollamaApi.js";
import "./ConnectionStatus.css";

export default function ConnectionStatus() {
  const [status, setStatus] = useState("checking"); // checking, connected, disconnected
  const [retryCount, setRetryCount] = useState(0);

  const checkConnection = useCallback(async () => {
    setStatus("checking");
    const isConnected = await ollamaApi.checkConnection();
    setStatus(isConnected ? "connected" : "disconnected");
    return isConnected;
  }, []);

  useEffect(() => {
    checkConnection();

    // Check connection every 30 seconds
    const interval = setInterval(checkConnection, 30000);
    return () => clearInterval(interval);
  }, [checkConnection]);

  // Auto-retry on disconnect
  useEffect(() => {
    if (status === "disconnected") {
      const retryTimeout = setTimeout(async () => {
        const connected = await checkConnection();
        if (!connected && retryCount < 5) {
          setRetryCount((c) => c + 1);
        }
      }, 5000);
      return () => clearTimeout(retryTimeout);
    } else if (status === "connected") {
      setRetryCount(0);
    }
  }, [status, retryCount, checkConnection]);

  const handleRetry = () => {
    setRetryCount(0);
    checkConnection();
  };

  return (
    <div className={`connection-status status-${status}`}>
      <span className="connection-dot" />
      <span className="connection-text">
        {status === "checking" && "Checking..."}
        {status === "connected" && "Connected"}
        {status === "disconnected" && (
          <>
            Disconnected
            <button className="connection-retry" onClick={handleRetry}>
              Retry
            </button>
          </>
        )}
      </span>
    </div>
  );
}
