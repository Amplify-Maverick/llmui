import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import App from "./App.jsx";
import { ensureSession } from "./services/auth.js";

const root = createRoot(document.getElementById("root"));

function Refused({ message }) {
  return (
    <div style={{ padding: 32, maxWidth: 560, lineHeight: 1.5 }}>
      <h2>LLMUI can't sign this browser in</h2>
      <p>{message}</p>
      <p>Open it through the tailnet address (tailscale serve) while signed in to Tailscale, or from the server itself.</p>
    </div>
  );
}

// Get the session cookie before anything calls the API. Only a refusal (403)
// blocks the app; a network error leaves each request to report its own.
ensureSession()
  .then(
    () => null,
    (err) => (err.status === 403 ? err : null)
  )
  .then((refused) =>
    root.render(
      <StrictMode>{refused ? <Refused message={refused.message} /> : <App />}</StrictMode>
    )
  );
