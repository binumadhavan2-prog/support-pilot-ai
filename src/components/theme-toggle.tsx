"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { THEME_STORAGE_KEY as STORAGE_KEY } from "@/lib/theme";

/*
 * Light / dark / system theme. The choice lives in localStorage (a per-browser preference, not
 * account data); THEME_SCRIPT (lib/theme.ts) applies it before first paint.
 */

type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
const ICON = { system: Monitor, light: Sun, dark: Moon };
const CHANGE_EVENT = "theme-change";

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system"; // storage blocked (private mode, policies)
  }
}

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange); // another tab changed it
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function ThemeToggle() {
  // "system" on the server and during hydration; the real value right after.
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system" as Theme);

  // Keep following the OS while on "system", and re-apply after changes from another tab.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onOsChange = () => applyTheme("system");
    media.addEventListener("change", onOsChange);
    return () => media.removeEventListener("change", onOsChange);
  }, [theme]);

  function cycle() {
    const next = NEXT[theme];
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved; it still applies for this page view.
    }
    applyTheme(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  const Icon = ICON[theme];
  const label = `Theme: ${LABEL[theme]}. Switch to ${LABEL[NEXT[theme]]}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={cycle} aria-label={label}>
          <Icon aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
