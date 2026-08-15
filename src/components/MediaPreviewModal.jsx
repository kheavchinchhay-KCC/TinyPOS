import { Download, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import {
  PRODUCT_IMAGE_PLACEHOLDER,
  attachmentPreviewUrl,
  downloadMediaFile,
  normalizeMediaUrl
} from "../lib/media";

export default function MediaPreviewModal({
  open,
  src,
  title = "Image preview",
  downloadName = "tiny-pos-image",
  onClose
}) {
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState("loading");
  const [message, setMessage] = useState("");
  const source = useMemo(() => attachmentPreviewUrl(src), [src]);

  useEffect(() => {
    if (!open) return;
    setZoom(1);
    setStatus(source ? "loading" : "error");
    setMessage("");
  }, [open, source]);

  if (!open) return null;

  async function download() {
    try {
      setMessage("");
      await downloadMediaFile(normalizeMediaUrl(src), downloadName);
    } catch (error) {
      setMessage(error.message || "The image could not be downloaded.");
    }
  }

  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      className="media-preview-modal"
      bodyClassName="media-preview-modal-body"
    >
      <div className="media-preview-toolbar">
        <button type="button" className="secondary-button" onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))))}><ZoomOut size={18} />Zoom out</button>
        <strong>{Math.round(zoom * 100)}%</strong>
        <button type="button" className="secondary-button" onClick={() => setZoom((value) => Math.min(4, Number((value + 0.25).toFixed(2))))}><ZoomIn size={18} />Zoom in</button>
        <button type="button" className="secondary-button" onClick={() => setZoom(1)}><RotateCcw size={18} />Reset</button>
        <button type="button" className="primary-button" onClick={download}><Download size={18} />Download</button>
      </div>

      {message && <div className="notice error">{message}</div>}

      <div className="media-preview-stage">
        {status === "loading" && <span className="media-preview-spinner" aria-label="Loading image" />}
        <img
          src={["error", "fallback"].includes(status) ? PRODUCT_IMAGE_PLACEHOLDER : source}
          alt={title}
          style={{ transform: `scale(${zoom})` }}
          onLoad={() => setStatus((current) => current === "loading" ? "ready" : current)}
          onError={() => setStatus((current) => current === "error" ? "fallback" : "error")}
        />
      </div>
    </Modal>
  );
}
