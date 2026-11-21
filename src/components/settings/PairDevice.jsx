import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import Input from "../shared/Input.jsx";
import { authHeaders } from "../../services/auth.js";
import { formatDate } from "../../utils/formatters.js";
import "./PairDevice.css";

const SHOW_SECONDS = 120;

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: await authHeaders(), cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * Settings → Devices. "Pair a device" creates a token for that device alone
 * and shows it as a QR code ("llmui-pair:v1:" + JSON { url, token }, see
 * docs/api.md §2.2). The QR is dropped after SHOW_SECONDS or on Hide; the
 * server expires the token if nothing uses it within 10 minutes. Paired
 * devices are listed with their last use and can be revoked.
 */
export default function PairDevice() {
  const [name, setName] = useState("iPhone");
  const [qr, setQr] = useState(null); // { svg, url, name }
  const [left, setLeft] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [devices, setDevices] = useState(null);
  const [listError, setListError] = useState(null);

  const loadDevices = useCallback(async () => {
    try {
      setDevices((await api("/api/devices")).devices);
      setListError(null);
    } catch (err) {
      setListError(err.message);
    }
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const hide = useCallback(() => {
    setQr(null);
    setLeft(0);
    loadDevices();
  }, [loadDevices]);

  const pair = async () => {
    setError(null);
    setLoading(true);
    try {
      const body = await api("/api/devices", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      // The server knows the tailnet URL; if it doesn't, this page's own origin.
      const url = body.pairing.url || window.location.origin;
      const text = body.text || body.pairing.prefix + JSON.stringify({ url, token: body.token });
      const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
      setQr({ svg, url, name: body.device.name });
      setLeft(SHOW_SECONDS);
      loadDevices();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const revoke = async (device) => {
    if (!window.confirm(`Revoke ${device.name}? It will have to be paired again.`)) return;
    try {
      await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
    } catch (err) {
      setListError(err.message);
    }
    loadDevices();
  };

  // While the QR is up, refresh the list so "Never used" flips once the phone connects.
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
    const poll = setInterval(loadDevices, 3000);
    return () => {
      clearInterval(iv);
      clearInterval(poll);
    };
  }, [qr, hide, loadDevices]);

  const insecure = qr && !qr.url.startsWith("https://");

  return (
    <div className="settings-section">
      <label className="settings-label">Devices</label>
      <p className="settings-description">
        Pair the LLMUI iOS app by scanning a QR code. Each device gets its own token, which you can revoke here.
      </p>
      {!qr ? (
        <div className="pair-form">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Device name"
            maxLength={64}
            aria-label="Device name"
          />
          <button className="btn" onClick={pair} disabled={loading || !name.trim()}>
            {loading ? "Preparing…" : "Pair a device"}
          </button>
        </div>
      ) : (
        <div className="pair-card">
          <p className="pair-warning" role="alert">
            Anyone who scans this code gets full access to LLMUI as “{qr.name}”: your chats, models, images and machines.
            Only show it to your own phone. Revoke the device below if the code leaks.
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
      {error && <p className="settings-description pair-error">Couldn't pair: {error}</p>}

      {listError && <p className="settings-description pair-error">Couldn't load devices: {listError}</p>}
      {devices && devices.length === 0 && <p className="settings-description">No paired devices.</p>}
      {devices && devices.length > 0 && (
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id} className="device-row">
              <div className="device-info">
                <span className="device-name">{d.name}</span>
                <span className="device-used">
                  {d.lastUsedAt
                    ? `Last used ${formatDate(d.lastUsedAt).replace(/^Just now$/, "just now")}`
                    : "Never used (expires 10 minutes after pairing)"}
                </span>
              </div>
              <button className="btn btn-danger" onClick={() => revoke(d)}>Revoke</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
