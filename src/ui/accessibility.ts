export function installAccessibility(): void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.documentElement.classList.toggle("reduce-motion", reduceMotion.matches);
  reduceMotion.addEventListener("change", () => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion.matches);
  });
}
