/**
 * RaPiSys — automatic colours for the Network page's interfaces.
 *
 * Visible interfaces (everything but bridges) are coloured first, in name
 * order, so they never repeat while the palette lasts and keep the same colour
 * on every reload. Bridges/docker come after. Colours the user picked for
 * other interfaces are skipped while unused palette colours remain.
 */

export const NET_PALETTE = [
  '#00d4ff', '#a855f7', '#10b981', '#f97316', '#eab308', '#ec4899',
  '#38bdf8', '#84cc16', '#f43f5e', '#14b8a6', '#818cf8', '#fb923c',
];

/**
 * @param {{name: string, kind: string}[]} ifaces
 * @param {Record<string, string>} custom  iface -> user-picked #rrggbb
 * @returns {Record<string, string>} iface -> automatic colour (custom ones excluded)
 */
export function autoNetColors(ifaces, custom = {}, palette = NET_PALETTE) {
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const order = [
    ...ifaces.filter((i) => i.kind !== 'bridge').sort(byName),
    ...ifaces.filter((i) => i.kind === 'bridge').sort(byName),
  ].filter((i) => !custom[i.name]);
  const taken = new Set(Object.values(custom).map((c) => String(c).toLowerCase()));
  const free = palette.filter((c) => !taken.has(c));
  const out = {};
  order.forEach((i, k) => {
    out[i.name] = k < free.length ? free[k] : palette[(k - free.length) % palette.length];
  });
  return out;
}
