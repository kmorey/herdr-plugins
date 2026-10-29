export function truncateMiddle(value, width) {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  const available = width - 1;
  const start = Math.ceil(available / 2);
  const end = Math.floor(available / 2);
  return `${value.slice(0, start)}…${value.slice(value.length - end)}`;
}
