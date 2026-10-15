/**
 * Splits a command line the way a POSIX shell would for plain words and quotes:
 * `tap --text "Join room"` -> ['tap', '--text', 'Join room']. No variables, globs or escapes beyond \" and \\.
 */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} in: ${line}`);
  if (has || cur) words.push(cur);
  return words;
}
