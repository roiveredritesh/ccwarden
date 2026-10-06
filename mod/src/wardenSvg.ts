// F16: the desktop warden, one neutral still picture. The desktop keeps a Svg's first picture (Q27), so it
// never changes: the band's coloured text carries the mood, and a Text ⚑ beside it blinks when cold.

const OL = 'stroke="#1b1b1b" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"'

export const WARDEN_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="148" height="100" viewBox="0 0 148 100">',
  `<path d="M8 100 Q12 72 50 68 Q88 72 92 100 Z" fill="#2f5fd0" ${OL}/>`,
  `<path d="M40 70 L50 83 L60 70" fill="#1f3a8a" ${OL}/>`,
  `<circle cx="28" cy="87" r="5" fill="#f5c518" ${OL}/>`,
  '<path d="M92 52 q8 -11 16 0" fill="none" stroke="#555" stroke-width="2.5"/>',
  `<rect x="90" y="54" width="20" height="30" rx="4" fill="#2a2f36" ${OL}/>`,
  '<rect x="94" y="58" width="12" height="22" rx="2" fill="#3a4a55"/>',
  '<ellipse cx="100" cy="70" rx="4.5" ry="7.5" fill="#ffb000"/><ellipse cx="100" cy="72" rx="2" ry="3.5" fill="#fff3b0"/>',
  `<circle cx="90" cy="86" r="6" fill="#e0a878" ${OL}/>`,
  `<circle cx="50" cy="46" r="26" fill="#e0a878" ${OL}/>`,
  `<path d="M22 34 Q24 6 50 6 Q78 6 80 32 Q64 26 50 27 Q34 27 22 34 Z" fill="#1f3a8a" ${OL}/>`,
  `<path d="M18 36 Q50 27 82 34 L84 39 Q50 32 17 41 Z" fill="#111a3a" ${OL}/>`,
  `<circle cx="50" cy="17" r="5" fill="#f5c518" ${OL}/>`,
  `<path d="M35 38 Q41 35 47 38 M53 38 Q59 35 65 38" fill="none" ${OL}/>`,
  '<circle cx="41" cy="46" r="3" fill="#1b1b1b"/><circle cx="59" cy="46" r="3" fill="#1b1b1b"/>',
  '<path d="M50 56 Q38 51 31 56 Q26 60 28 52 M50 56 Q62 51 69 56 Q74 60 72 52" fill="none" stroke="#2b1a10" stroke-width="5" stroke-linecap="round"/>',
  `<path d="M44 63 Q50 68 56 63" fill="none" ${OL}/>`,
  '</svg>',
].join('')
