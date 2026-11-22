"use client";

import { useEffect, type ReactNode } from "react";

import { BRAND_ID, DEFAULT_THEME_MODE, type ThemeMode } from "@/generated/brand";
import { useWorkspaceStore } from "@/stores/workspace";

const STORAGE_KEY = `${BRAND_ID}:theme`;

function applyDocumentTheme(mode: ThemeMode) {
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = mode;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useWorkspaceStore((state) => state.theme);
  const setTheme = useWorkspaceStore((state) => state.setTheme);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored === "dark" || stored === "light") {
      setTheme(stored);
    } else if (typeof window.matchMedia === "function") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setTheme(prefersDark ? "dark" : DEFAULT_THEME_MODE);
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      if (event.newValue === "dark" || event.newValue === "light") {
        setTheme(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setTheme]);

  useEffect(() => {
    const mode: ThemeMode = theme === "light" ? "light" : "dark";
    applyDocumentTheme(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Storage access is optional.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.defaultTheme = DEFAULT_THEME_MODE;
  }, []);

  return children;
}
