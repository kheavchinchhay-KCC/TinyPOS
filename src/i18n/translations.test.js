import { describe, expect, it } from "vitest";
import {
  languageLabel,
  normalizeLanguage,
  translateUiText
} from "./translations.js";

describe("normalizeLanguage", () => {
  it("recognizes common Khmer language codes", () => {
    expect(normalizeLanguage("km")).toBe("km");
    expect(normalizeLanguage("kh")).toBe("km");
    expect(normalizeLanguage("Khmer")).toBe("km");
  });

  it("defaults to English for anything else, including empty input", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("")).toBe("en");
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage("fr")).toBe("en");
  });
});

describe("languageLabel", () => {
  it("returns the native label for each supported language", () => {
    expect(languageLabel("km")).toBe("ខ្មែរ");
    expect(languageLabel("en")).toBe("English");
  });
});

describe("translateUiText", () => {
  it("returns the source text unchanged when the language is English", () => {
    expect(translateUiText("Settings", "en")).toBe("Settings");
  });

  it("returns empty/blank input unchanged", () => {
    expect(translateUiText("", "km")).toBe("");
    expect(translateUiText(undefined, "km")).toBe("");
  });

  it("interpolates {{variables}} before translating", () => {
    expect(translateUiText("Hello {{name}}", "en", { name: "Dara" })).toBe("Hello Dara");
  });

  // Regression test: "Settings", "Staff", "Net profit" and others were
  // previously defined twice in the dictionary, so the actual translation
  // used at runtime depended on which duplicate happened to load last. This
  // pins down that each of these now resolves to exactly one, stable value.
  it("resolves previously-duplicated dictionary keys to a single stable translation", () => {
    const settings = translateUiText("Settings", "km");
    const staff = translateUiText("Staff", "km");
    expect(settings).toBe(translateUiText("Settings", "km"));
    expect(staff).toBe(translateUiText("Staff", "km"));
    // Both must actually be translated (not silently fall through to English).
    expect(settings).not.toBe("Settings");
    expect(staff).not.toBe("Staff");
  });
});
