import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { authHeaders } from "../../services/auth.js";
import "./PairDevice.css";

const SHOW_SECONDS = 120;

/**
 * Settings → Pair iPhone: a QR code holding "llmui-pair:v1:" + JSON
 * { url, token } (see docs/api.md). Rendered only after a click, and dropped
 * (QR and token both) after SHOW_SECONDS or on Hide.
 */
export default function PairDevice() {
  const [qr, setQr] = useState(null); // { svg, url }
  const [left, setLeft] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const hide = useCallback(() => {
    setQr(null);
    setLeft(0);
  }, []);

  const show = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/pairing", { headers: await authHeaders(), cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      // The server knows the tailnet URL; if it doesn't, this page's own origin.
      const url = body.url || window.location.origin;
      const text = body.prefix + JSON.stringify({ url, token: body.token });
      const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
      setQr({ svg, url });
      setLeft(SHOW_SECONDS);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!qr) return undefined;
    const iv = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          hide();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [qr, hide]);

  const insecure = qr && !qr.url.startsWith("https://");

  return (
    <div className="settings-section">
      <label className="settings-label">Pair iPhone</label>
      {!qr ? (
        <button className="btn" onClick={show} disabled={loading}>
          {loading ? "Preparing…" : "Pair iPhone"}
        </button>
      ) : (
        <div className="pair-card">
          <p className="pair-warning" role="alert">
            Anyone who scans this code gets full access to LLMUI: your chats, models, images and machines.
            Only show it to your own phone.
          </p>
          {/* Generated locally from our own payload by the qrcode library. */}
          <div className="pair-qr" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <div className="pair-meta">
            <span className="pair-url">{qr.url}</span>
            <span className="pair-countdown">
              Hides in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </span>
          </div>
          {insecure && (
            <p className="pair-warning">
              This URL isn't HTTPS, so the phone may not be able to use it. Set LLMUI_PUBLIC_URL on the server.
            </p>
          )}
          <button className="btn" onClick={hide}>Hide now</button>
        </div>
      )}
      {error && <p className="settings-description pair-error">Couldn't create a pairing code: {error}</p>}
      <p className="settings-description">
        Shows a QR code for the LLMUI iOS app with this server's address and access token. It disappears after 2 minutes.
      </p>
    </div>
  );
}
