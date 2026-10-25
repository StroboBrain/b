/** Read finite, nonnegative CSS times; invalid or unitless values keep the caller's default. */
export function parseCssMilliseconds(source, fallback) {
  if (typeof source !== 'string') return fallback;
  const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/i.exec(source.trim());
  if (!match) return fallback;
  const milliseconds = Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
  return Number.isFinite(milliseconds) ? milliseconds : fallback;
}

export function readCssMilliseconds(style, property, fallback) {
  return parseCssMilliseconds(style?.getPropertyValue?.(property), fallback);
}
