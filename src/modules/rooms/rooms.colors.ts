export const PLAYER_COLORS = [
  "#34d399", // Emerald
  "#38bdf8", // Sky
  "#f472b6", // Pink
  "#fb923c", // Orange
  "#a78bfa", // Violet
  "#facc15", // Yellow
  "#f87171", // Coral
  "#2dd4bf", // Teal
  "#818cf8", // Indigo
  "#a3e635", // Lime
] as const;

export type PlayerColor = (typeof PLAYER_COLORS)[number];

const COLOR_SET = new Set<string>(PLAYER_COLORS);

export function isValidPlayerColor(color: string): color is PlayerColor {
  return COLOR_SET.has(color.toLowerCase());
}

export function pickRandomAvailableColor(usedColors: Iterable<string>): PlayerColor {
  const taken = new Set<string>();
  for (const c of usedColors) {
    taken.add(c.toLowerCase());
  }
  const available = PLAYER_COLORS.filter((c) => !taken.has(c));
  const pool = available.length > 0 ? available : PLAYER_COLORS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
