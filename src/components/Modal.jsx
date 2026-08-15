let activeModalLocks = 0;
let previousModalBodyStyles = null;

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
  bodyClassName = "",
  closeDisabled = false
}) {
  const [mainBounds, setMainBounds] = useState(null);

  useEffect(() => {
    const main = document.querySelector(".shell > main");
    if (activeModalLocks === 0) {
      previousModalBodyStyles = {
        overflow: document.body.style.overflow,
        overscrollBehavior: document.body.style.overscrollBehavior,
        paddingRight: document.body.style.paddingRight
      };
      const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      document.documentElement.classList.add("tiny-pos-modal-open");
      document.body.classList.add("tiny-pos-modal-open");
      document.body.style.overflow = "hidden";
      document.body.style.overscrollBehavior = "none";
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
    }
    activeModalLocks += 1;

    function updateBounds() {
      if (!main) {
        setMainBounds(null);
        return;
      }
      const rect = main.getBoundingClientRect();
      setMainBounds({ left: Math.max(0, Math.round(rect.left)), width: Math.max(0, Math.round(rect.width)) });
    }

    updateBounds();
    const observer = main && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updateBounds)
      : null;
    observer?.observe(main);
    window.addEventListener("resize", updateBounds);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateBounds);
      activeModalLocks = Math.max(0, activeModalLocks - 1);
      if (activeModalLocks === 0) {
        document.documentElement.classList.remove("tiny-pos-modal-open");
        document.body.classList.remove("tiny-pos-modal-open");
        document.body.style.overflow = previousModalBodyStyles?.overflow || "";
        document.body.style.overscrollBehavior = previousModalBodyStyles?.overscrollBehavior || "";
        document.body.style.paddingRight = previousModalBodyStyles?.paddingRight || "";
        previousModalBodyStyles = null;
      }
    };
  }, []);

  function requestClose() {
    if (!closeDisabled) onClose?.();
  }

  const layerStyle = mainBounds
    ? { left: `${mainBounds.left}px`, width: `${mainBounds.width}px` }
    : undefined;

  const content = (
    <div className="modal-layer" style={layerStyle} role="presentation" onMouseDown={requestClose}>
      <section
        className={`modal-card ${wide ? "wide" : ""} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={requestClose}
            aria-label="Close"
            disabled={closeDisabled}
          >
            <X size={22} />
          </button>
        </header>
        <div className={`modal-body ${bodyClassName}`.trim()}>{children}</div>
      </section>
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(content, document.body);
}
