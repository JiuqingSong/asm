// MASM 词法分析：把一行源代码切成记号（token）

export type TokKind = 'id' | 'num' | 'str' | 'op';

export interface Token {
  kind: TokKind;
  /** 原文（id 已转小写存于 lower） */
  text: string;
  lower: string;
  /** 数值（num）或字符串内容（str，存于 text） */
  value: number;
  /** 在行内的列号（从 0 开始） */
  col: number;
}

export class AsmError extends Error {
  col: number;
  constructor(msg: string, col = -1) {
    super(msg);
    this.col = col;
  }
}

const ID_START = /[A-Za-z_@$?.]/;
const ID_CHAR = /[A-Za-z0-9_@$?]/;

/** 去掉行尾注释（分号之后，字符串内的分号除外） */
export function stripComment(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === ';') return line.slice(0, i);
  }
  return line;
}

export function parseNumber(s: string): number | null {
  const t = s.toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^([0-9][0-9a-f]*)h$/))) return parseInt(m[1], 16);
  if ((m = t.match(/^([01]+)[by]$/))) return parseInt(m[1], 2);
  if ((m = t.match(/^([0-7]+)[oq]$/))) return parseInt(m[1], 8);
  if ((m = t.match(/^([0-9]+)[dt]?$/))) return parseInt(m[1], 10);
  return null;
}

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  const s = stripComment(line);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    const col = i;
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < s.length && /[0-9A-Za-z]/.test(s[j])) j++;
      const text = s.slice(i, j);
      const v = parseNumber(text);
      if (v === null) throw new AsmError(`无法识别的数字：${text}`, col);
      out.push({ kind: 'num', text, lower: text.toLowerCase(), value: v, col });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, str = '';
      for (;;) {
        if (j >= s.length) throw new AsmError('字符串缺少结束引号', col);
        if (s[j] === c) {
          if (s[j + 1] === c) { str += c; j += 2; continue; }
          j++;
          break;
        }
        str += s[j++];
      }
      out.push({ kind: 'str', text: str, lower: str, value: 0, col });
      i = j;
      continue;
    }
    // 以点开头的标识符只在后面紧跟字母时成立（.model / .data）
    if (ID_START.test(c) && (c !== '.' || /[A-Za-z]/.test(s[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < s.length && ID_CHAR.test(s[j])) j++;
      const text = s.slice(i, j);
      out.push({ kind: 'id', text, lower: text.toLowerCase(), value: 0, col });
      i = j;
      continue;
    }
    if ('<>='.includes(c) && s[i + 1] === '=') {
      out.push({ kind: 'op', text: c + '=', lower: c + '=', value: 0, col });
      i += 2;
      continue;
    }
    if (',:[]()+-*/<>.=&!%'.includes(c)) {
      out.push({ kind: 'op', text: c, lower: c, value: 0, col });
      i++;
      continue;
    }
    throw new AsmError(`无法识别的字符：${c}`, col);
  }
  return out;
}
