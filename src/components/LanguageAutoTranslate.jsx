import { useEffect, useLayoutEffect, useRef } from "react";
import { useLanguage } from "../context/LanguageContext";
import {
  normalizeLanguage,
  recoverEnglishUiText,
  translateUiText
} from "../i18n/translations";

const textState = new WeakMap();
const attributeState = new WeakMap();

const TRANSLATABLE_SELECTOR = [
  "button",
  "option",
  "th",
  "label",
  "legend",
  "summary",
  "h1",
  "h2",
  "h3",
  "h4",
  ".side-label",
  ".eyebrow",
  ".muted",
  ".notice",
  ".empty-state",
  ".status-pill",
  ".quote-status",
  ".page-heading",
  ".panel-heading",
  ".panel-title-row",
  ".modal-heading",
  ".login",
  ".settings-tabs",
  ".metric-card",
  ".dashboard-metric-card",
  ".dashboard-alert-card",
  ".dashboard-register-banner",
  ".permission-route-denied",
  ".content",
  ".public-storefront",
  ".public-store-loading",
  ".modal-layer",
  ".modal-backdrop",
  ".modal-card",
  ".scanner-overlay",
  "[role='dialog']",
  "[data-i18n-auto]"
].join(",");

const SKIP_SELECTOR = [
  "script",
  "style",
  "code",
  "pre",
  "textarea",
  "[contenteditable='true']",
  "[data-i18n-skip]",
  ".no-translate"
].join(",");

const ATTRIBUTES = [
  "placeholder",
  "title",
  "aria-label"
];

const ENGLISH_TEXT = /[A-Za-z]/;
const KHMER_TEXT = /[\u1780-\u17ff]/;

function isUiText(value) {
  return ENGLISH_TEXT.test(value || "") || KHMER_TEXT.test(value || "");
}

function shouldTranslateText(node) {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest(SKIP_SELECTOR)) return false;
  if (!parent.closest(TRANSLATABLE_SELECTOR)) return false;
  return isUiText(node.nodeValue || "") || textState.has(node);
}

function stableEnglishSource(value) {
  const current = String(value ?? "");
  const recovered = recoverEnglishUiText(current);

  if (ENGLISH_TEXT.test(recovered)) return recovered;
  return current;
}

function renderTextNode(node, language) {
  if (!shouldTranslateText(node)) return;

  const current = node.nodeValue || "";
  let state = textState.get(node);

  if (!state) {
    state = {
      source: stableEnglishSource(current),
      rendered: current
    };
    textState.set(node, state);
  } else if (current !== state.rendered) {
    // React may render either the original English string or its Khmer t()
    // result. Recover and retain the English source instead of permanently
    // replacing it with Khmer, which previously made switching back require
    // leaving and reopening the page.
    const recovered = stableEnglishSource(current);
    if (isUiText(recovered)) state.source = recovered;
  }

  const translated = translateUiText(state.source, language);
  state.rendered = translated;

  if (current !== translated) {
    node.nodeValue = translated;
  }
}

function renderAttributes(element, language) {
  if (!(element instanceof HTMLElement)) return;
  if (element.closest(SKIP_SELECTOR)) return;

  let states = attributeState.get(element);
  if (!states) {
    states = new Map();
    attributeState.set(element, states);
  }

  for (const name of ATTRIBUTES) {
    if (!element.hasAttribute(name)) continue;

    const current = element.getAttribute(name) || "";
    let state = states.get(name);

    if (!state) {
      state = {
        source: stableEnglishSource(current),
        rendered: current
      };
      states.set(name, state);
    } else if (current !== state.rendered) {
      const recovered = stableEnglishSource(current);
      if (isUiText(recovered)) state.source = recovered;
    }

    const translated = translateUiText(state.source, language);
    state.rendered = translated;

    if (current !== translated) {
      element.setAttribute(name, translated);
    }
  }
}

function translateTree(root, language) {
  if (!root) return;

  if (root.nodeType === Node.TEXT_NODE) {
    renderTextNode(root, language);
    return;
  }

  if (!(root instanceof Element)) return;
  if (root.matches(SKIP_SELECTOR)) return;

  renderAttributes(root, language);

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
  );

  let node = walker.nextNode();

  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      renderTextNode(node, language);
    } else {
      renderAttributes(node, language);
    }

    node = walker.nextNode();
  }
}

export default function LanguageAutoTranslate() {
  const { language } = useLanguage();
  const languageRef = useRef(normalizeLanguage(language));
  const refreshFrame = useRef(0);
  const refreshTimers = useRef([]);

  const renderAll = () => {
    if (!document.body) return;
    translateTree(document.body, languageRef.current);
  };

  const schedulePasses = () => {
    window.cancelAnimationFrame(refreshFrame.current);
    refreshTimers.current.forEach((timer) => window.clearTimeout(timer));
    refreshTimers.current = [];

    renderAll();
    refreshFrame.current = window.requestAnimationFrame(renderAll);
    refreshTimers.current.push(window.setTimeout(renderAll, 32));
    refreshTimers.current.push(window.setTimeout(renderAll, 110));
    refreshTimers.current.push(window.setTimeout(renderAll, 280));
  };

  // Update the language reference in the layout phase. The single persistent
  // MutationObserver below then always handles React's current-page mutations
  // with the new language, never with a stale previous-language closure.
  useLayoutEffect(() => {
    languageRef.current = normalizeLanguage(language);
    schedulePasses();
  }, [language]);

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      const activeLanguage = languageRef.current;

      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          renderTextNode(mutation.target, activeLanguage);
          continue;
        }

        if (mutation.type === "attributes") {
          renderAttributes(mutation.target, activeLanguage);
          continue;
        }

        for (const node of mutation.addedNodes) {
          translateTree(node, activeLanguage);
        }
      }
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRIBUTES
    });

    const onRequestedRefresh = (event) => {
      languageRef.current = normalizeLanguage(
        event?.detail?.language || languageRef.current
      );
      schedulePasses();
    };

    window.addEventListener("tiny-pos-language-change", onRequestedRefresh);

    return () => {
      observer.disconnect();
      window.removeEventListener("tiny-pos-language-change", onRequestedRefresh);
      window.cancelAnimationFrame(refreshFrame.current);
      refreshTimers.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  return null;
}
