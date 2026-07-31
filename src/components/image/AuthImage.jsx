import { useState, useEffect, useRef } from "react";
import { authHeaders } from "../../services/auth.js";

/**
 * An <img> wrapper that fetches the image with Authorization headers
 * and displays it via a blob URL. This is needed because <img src="...">
 * cannot send custom headers.
 */
export default function AuthImage({ src, alt = "", className = "", loading, ...rest }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState(false);
  const prevBlobUrl = useRef(null);

  useEffect(() => {
    if (!src) {
      setBlobUrl(null);
      setError(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(src, { headers: await authHeaders() });
        if (!response.ok) throw new Error("Failed to load image");
        const blob = await response.blob();
        if (cancelled) return;
        const newUrl = URL.createObjectURL(blob);
        if (prevBlobUrl.current) {
          URL.revokeObjectURL(prevBlobUrl.current);
        }
        prevBlobUrl.current = newUrl;
        setBlobUrl(newUrl);
        setError(false);
      } catch {
        if (!cancelled) {
          setBlobUrl(null);
          setError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    return () => {
      if (prevBlobUrl.current) {
        URL.revokeObjectURL(prevBlobUrl.current);
      }
    };
  }, []);

  if (!blobUrl) return null;

  return (
    <img
      src={blobUrl}
      alt={alt}
      className={className}
      {...rest}
    />
  );
}
