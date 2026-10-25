/** Development-only timing editor demonstrations. Importing this catalog changes no app state. */
export const POPUP_VARIANTS = Object.freeze([
  { id: 'accordion', name: 'accordion', description: 'original expansion with staged controls' },
  { id: 'quick', name: 'quick', description: 'shorter expansion and crisp reveals' },
  { id: 'soft', name: 'soft', description: 'slow expansion and gentle fades' },
  { id: 'rise', name: 'rise', description: 'controls travel out from the readout' },
  { id: 'settle', name: 'settle', description: 'controls grow into place' },
  { id: 'curtain', name: 'curtain', description: 'measured expansion with vertical unfolds' },
].map(variant => Object.freeze(variant)));
