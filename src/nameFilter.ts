/**
 * Filtro de nomes exibidos na tela. Nome bloqueado => o eleitor aparece com o nome genérico.
 * Termos curtos (≤4 letras) só bloqueiam como palavra inteira, para não barrar nomes comuns
 * (ex.: "Lucas", "Curitiba"). Termos longos bloqueiam por trecho, mesmo com troca de letras por
 * números/símbolos (p0rr4 → porra). A lista é só um ponto de partida: acrescente termos em
 * `names.blocklist` na configuração.
 */
const DEFAULT_BLOCKLIST = [
  // palavrões e ofensas comuns
  'porra', 'caralho', 'merda', 'bosta', 'puta', 'puto', 'buceta', 'viado', 'fdp', 'pqp', 'vsf', 'tnc', 'cuzao', 'arrombado', 'babaca', 'otario', 'idiota', 'imbecil', 'retardado', 'mongol', 'vagabundo', 'vagabunda', 'desgracado', 'cacete', 'piranha', 'prostituta', 'foder', 'foda-se', 'fodase',
  // ofensas discriminatórias
  'macaco', 'crioulo', 'sapatao', 'bichona', 'traveco', 'nazista', 'hitler', 'estuprador', 'pedofilo',
  // xingamentos políticos (evitam briga na tela)
  'petralha', 'bolsominion', 'bolsonazi', 'mortadela', 'ladrao', 'genocida', 'corrupto', 'miliciano', 'assassino', 'comunista', 'fascista', 'lulaladrao',
];
const SHORT = 4;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '€': 'e' };

function deaccent(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
/** Troca símbolos/números por letras e remove separadores; colapsa letras repetidas. */
function squash(s: string): string {
  let out = '';
  for (const ch of deaccent(s)) out += LEET[ch] ?? ch;
  return out.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
}
const norm = (t: string) => squash(t);

const URLISH = /(https?:|www\.|\.com\b|\.br\b|\.net\b|t\.me|wa\.me|bit\.ly|@[a-z0-9_.]{3,}|\b\d{8,}\b)/i;

export function isBlockedName(name: string, extra: readonly string[] = []): boolean {
  if (URLISH.test(name)) return true;
  const terms = [...DEFAULT_BLOCKLIST, ...extra].map((t) => ({ raw: t, n: norm(t) })).filter((t) => t.n.length > 1);
  const words = deaccent(name).split(/[^a-z0-9@$!]+/).filter(Boolean).map(norm);
  const whole = norm(name);
  for (const t of terms) {
    if (t.n.length <= SHORT) {
      if (words.includes(t.n)) return true;
    } else if (whole.includes(t.n)) {
      return true;
    }
  }
  return false;
}
