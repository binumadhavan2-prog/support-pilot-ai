/** localStorage key for the theme choice ("light" | "dark"; absent means follow the OS). */
export const THEME_STORAGE_KEY = "theme";

/**
 * Runs inline in <head> before the page paints, so the wrong theme never flashes. Kept in a plain
 * module: the root layout (a server component) can't read values exported by a client module.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;
