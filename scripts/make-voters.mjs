// Gera 8 personagens ORIGINAIS (estilo chibi) em SVG, com pernas e braços animados.
// Uso: node scripts/make-voters.mjs   → public/assets/voters/voter_1.svg ... voter_8.svg
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = new URL('../public/assets/voters/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const LINE = '#2b2b2b';
const P = [
  { skin: '#8d5524', shirt: '#ffd23f', pants: '#2a6fdb', shoe: '#ffffff', hair: 'afro', hairC: '#1c1c1c', extra: [] },
  { skin: '#f1c27d', shirt: '#14a05a', pants: '#3b4a6b', shoe: '#e63946', hair: 'long', hairC: '#222222', extra: [] },
  { skin: '#c68642', shirt: '#ffffff', pants: '#444a5a', shoe: '#1d6fd8', hair: 'short', hairC: '#1c1c1c', extra: ['cap'] },
  { skin: '#ffdbac', shirt: '#9b5de5', pants: '#2b2b4a', shoe: '#ffd23f', hair: 'bun', hairC: '#e3b448', extra: ['glasses'] },
  { skin: '#e0ac69', shirt: '#f4a261', pants: '#5a4a3a', shoe: '#6b4423', hair: 'grey', hairC: '#e8e8e8', extra: ['glasses', 'mustache'] },
  { skin: '#6b4423', shirt: '#ff7aa8', pants: '#ffffff', shoe: '#14a05a', hair: 'pigtails', hairC: '#161616', extra: [] },
  { skin: '#f5cba7', shirt: '#ffffff', pants: '#2a6fdb', shoe: '#e63946', hair: 'curly', hairC: '#d2541e', extra: ['freckles', 'overalls'] },
  { skin: '#a0674b', shirt: '#9be15d', pants: '#3a3a3a', shoe: '#ff9f1c', hair: 'bald', hairC: '#1c1c1c', extra: ['beard', 'headband'] },
];
const R = (n) => `<animateTransform attributeName="transform" type="rotate" values="${n}" dur="0.5s" repeatCount="indefinite"/>`;

function hairBack(p) {
  const c = p.hairC;
  switch (p.hair) {
    case 'afro': return `<circle cx="60" cy="52" r="50" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'long': return `<path d="M14 66 Q10 20 60 14 Q110 20 106 66 L108 128 Q92 136 88 112 L32 112 Q28 136 12 128 Z" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'pigtails': return `<circle cx="14" cy="80" r="16" fill="${c}" stroke="${LINE}" stroke-width="4"/><circle cx="106" cy="80" r="16" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'bun': return `<circle cx="60" cy="10" r="14" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'curly': return `<g fill="${c}" stroke="${LINE}" stroke-width="4"><circle cx="22" cy="46" r="20"/><circle cx="98" cy="46" r="20"/><circle cx="60" cy="16" r="24"/><circle cx="34" cy="26" r="20"/><circle cx="86" cy="26" r="20"/></g>`;
    default: return '';
  }
}
function hairFront(p) {
  const c = p.hairC;
  switch (p.hair) {
    case 'afro': return `<path d="M20 52 Q60 20 100 52 Q92 30 60 28 Q28 30 20 52Z" fill="${c}"/>`;
    case 'long': return `<path d="M16 62 Q22 22 60 20 Q98 22 104 62 Q84 40 60 42 Q36 40 16 62Z" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'short': return `<path d="M16 60 Q18 20 60 18 Q102 20 104 60 Q90 38 60 40 Q30 38 16 60Z" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'bun': return `<path d="M16 60 Q18 22 60 20 Q102 22 104 60 Q80 36 60 44 Q40 36 16 60Z" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'grey': return `<path d="M16 66 Q16 36 34 30 Q40 40 36 56 Z M104 66 Q104 36 86 30 Q80 40 84 56 Z" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'pigtails': return `<path d="M16 60 Q18 20 60 18 Q102 20 104 60 Q80 38 60 46 Q40 38 16 60Z" fill="${c}" stroke="${LINE}" stroke-width="4"/>`;
    case 'curly': return `<path d="M24 58 Q60 30 96 58 Q90 40 60 38 Q30 40 24 58Z" fill="${c}"/>`;
    default: return '';
  }
}
function face(p) {
  const e = p.extra;
  let s = `<circle cx="60" cy="72" r="44" fill="${p.skin}" stroke="${LINE}" stroke-width="4"/>`;
  s += hairFront(p);
  if (e.includes('beard')) s += `<path d="M22 84 Q26 122 60 122 Q94 122 98 84 Q84 98 60 98 Q36 98 22 84Z" fill="${p.hairC}" stroke="${LINE}" stroke-width="4"/>`;
  // olhos (levemente voltados para a direita: o personagem caminha para a direita)
  s += `<ellipse cx="50" cy="74" rx="7" ry="9" fill="#fff" stroke="${LINE}" stroke-width="3"/><ellipse cx="78" cy="74" rx="7" ry="9" fill="#fff" stroke="${LINE}" stroke-width="3"/>`;
  s += `<circle cx="53" cy="76" r="4.5" fill="${LINE}"/><circle cx="81" cy="76" r="4.5" fill="${LINE}"/><circle cx="54.5" cy="74" r="1.6" fill="#fff"/><circle cx="82.5" cy="74" r="1.6" fill="#fff"/>`;
  s += `<path d="M52 96 Q66 108 80 96" fill="none" stroke="${LINE}" stroke-width="4" stroke-linecap="round"/>`;
  s += `<circle cx="38" cy="92" r="6" fill="#ff7a8a" opacity=".45"/><circle cx="92" cy="92" r="6" fill="#ff7a8a" opacity=".45"/>`;
  if (e.includes('freckles')) s += `<g fill="#a5532a"><circle cx="44" cy="88" r="1.8"/><circle cx="50" cy="90" r="1.8"/><circle cx="76" cy="90" r="1.8"/><circle cx="82" cy="88" r="1.8"/></g>`;
  if (e.includes('mustache')) s += `<path d="M50 94 Q66 88 82 94 Q66 100 50 94Z" fill="${p.hairC}" stroke="${LINE}" stroke-width="3"/>`;
  if (e.includes('glasses')) s += `<g fill="#ffffff55" stroke="${LINE}" stroke-width="3.5"><circle cx="50" cy="74" r="13"/><circle cx="78" cy="74" r="13"/><path d="M63 74 H65" /></g>`;
  if (e.includes('cap')) s += `<path d="M14 58 Q16 18 60 16 Q104 18 106 58 Z" fill="#e63946" stroke="${LINE}" stroke-width="4"/><path d="M96 56 Q124 54 126 64 Q108 66 92 62Z" fill="#c1121f" stroke="${LINE}" stroke-width="4"/>`;
  if (e.includes('headband')) s += `<path d="M18 54 Q60 40 102 54 L102 64 Q60 50 18 64Z" fill="#ffd23f" stroke="${LINE}" stroke-width="3.5"/>`;
  return s;
}
function svg(p, i) {
  const bib = p.extra.includes('overalls');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -18 136 228" width="136" height="228">
<ellipse cx="60" cy="204" rx="40" ry="6" fill="#000" opacity=".18"/>
<g transform="translate(0,0)">
 <g>${R('26 46 150;-26 46 150;26 46 150')}<rect x="36" y="150" width="20" height="40" rx="9" fill="${p.pants}" stroke="${LINE}" stroke-width="4"/><ellipse cx="50" cy="194" rx="17" ry="9" fill="${p.shoe}" stroke="${LINE}" stroke-width="4"/></g>
 <g>${R('-26 74 150;26 74 150;-26 74 150')}<rect x="64" y="150" width="20" height="40" rx="9" fill="${p.pants}" stroke="${LINE}" stroke-width="4"/><ellipse cx="78" cy="194" rx="17" ry="9" fill="${p.shoe}" stroke="${LINE}" stroke-width="4"/></g>
 <g>${R('-30 28 126;30 28 126;-30 28 126')}<rect x="20" y="124" width="14" height="34" rx="7" fill="${p.skin}" stroke="${LINE}" stroke-width="4"/></g>
 <rect x="30" y="112" width="60" height="50" rx="20" fill="${p.shirt}" stroke="${LINE}" stroke-width="4"/>
 ${bib ? `<rect x="42" y="126" width="36" height="36" rx="6" fill="${p.pants}" stroke="${LINE}" stroke-width="4"/>` : ''}
 <g>${R('30 92 126;-30 92 126;30 92 126')}<rect x="86" y="124" width="14" height="34" rx="7" fill="${p.skin}" stroke="${LINE}" stroke-width="4"/></g>
</g>
${hairBack(p)}
${face(p)}
</svg>`;
}
P.forEach((p, i) => writeFileSync(new URL(`voter_${i + 1}.svg`, OUT), svg(p, i)));
console.log(`${P.length} personagens gerados em ${OUT.pathname}`);
