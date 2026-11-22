"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { BRAND, THEME_TOKEN_KEYS, type BrandManifest, type ThemeMode } from "@/generated/brand";
import { getBrandManifest } from "@/lib/host";
import { isTauri } from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspace";

export type SynthesisTemplateSectionSpec = {
  key: string;
  label: string;
  kind: "bullets" | "decisions" | "actions";
  description?: string;
};

export type RuntimeBrandManifest = BrandManifest & {
  copyrightYear?: number;
  synthesisTemplate?: {
    name: string;
    sections: SynthesisTemplateSectionSpec[];
  };
};

const BrandContext = createContext<RuntimeBrandManifest>(BRAND as RuntimeBrandManifest);

function isSafeRuntimeCssValue(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (/[{};<>\\]/.test(value)) return false;
  if (/@import|url\s*\(|expression\s*\(|javascript:/i.test(value)) return false;
  return true;
}

function cssVarName(tokenKey: string): string {
  return `--brand-${tokenKey.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

function applyRuntimeBrandCss(manifest: RuntimeBrandManifest, mode: ThemeMode) {
  const root = document.documentElement;
  if (isSafeRuntimeCssValue(manifest.theme?.radius)) {
    root.style.setProperty("--brand-radius", manifest.theme.radius);
  }
  if (isSafeRuntimeCssValue(manifest.theme?.fontSans)) {
    root.style.setProperty("--brand-font-sans", manifest.theme.fontSans);
  }
  if (isSafeRuntimeCssValue(manifest.theme?.fontMono)) {
    root.style.setProperty("--brand-font-mono", manifest.theme.fontMono);
  }

  const tokens = manifest.theme?.tokens?.[mode];
  if (!tokens) return;
  for (const key of THEME_TOKEN_KEYS) {
    const val = tokens[key];
    if (isSafeRuntimeCssValue(val)) {
      root.style.setProperty(cssVarName(key), val);
    }
  }
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState<RuntimeBrandManifest>(BRAND as RuntimeBrandManifest);
  const [overrideLoaded, setOverrideLoaded] = useState(false);
  const theme = useWorkspaceStore((state) => state.theme);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void getBrandManifest().then((live) => {
      if (cancelled || !live) return;
      const runtime = live as RuntimeBrandManifest;
      setBrand(runtime);
      setOverrideLoaded(true);
      if (runtime.productName && document.title) {
        document.title = runtime.productName;
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!overrideLoaded) return;
    const mode: ThemeMode = theme === "light" ? "light" : "dark";
    applyRuntimeBrandCss(brand, mode);
  }, [brand, overrideLoaded, theme]);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): RuntimeBrandManifest {
  return useContext(BrandContext);
}
