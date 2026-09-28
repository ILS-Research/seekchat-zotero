/**
 * Small, safe Markdown subset for model answers: paragraphs, headings (#–###),
 * bullet and numbered lists, **bold**, *italic*, `code`. Everything becomes DOM
 * nodes via textContent – no HTML from the model is ever interpreted.
 *
 * Citations are handed in as a splitter so page citations ([S. 12]) and source
 * citations ([2, S. 12]) stay clickable, also inside bold text ("**[1]**").
 */
const HTML_NS = 'http://www.w3.org/1999/xhtml';

export type InlinePiece = { type: 'text'; text: string } | { type: 'cite'; node: Node };

/** Splits plain text into text and ready-made citation nodes. */
export type CitationSplitter = (text: string) => InlinePiece[];

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'ul' | 'ol'; items: string[] };

/** Groups lines into blocks; pure, unit-tested. */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join('\n') });
    para = [];
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] });
    } else if (bullet || numbered) {
      flush();
      const type = bullet ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      const text = (bullet || numbered)![1];
      if (last && last.type === type) last.items.push(text);
      else blocks.push({ type, items: [text] });
    } else {
      const last = blocks[blocks.length - 1];
      // Continuation line of a list item (indented, directly after the list).
      if (!para.length && last && (last.type === 'ul' || last.type === 'ol') && /^\s{2,}\S/.test(raw)) {
        last.items[last.items.length - 1] += '\n' + line.trim();
      } else {
        para.push(line);
      }
    }
  }
  flush();
  return blocks;
}

export type InlineToken =
  | { type: 'text'; text: string; bold: boolean; italic: boolean; code: boolean }
  | { type: 'cite'; index: number; bold: boolean; italic: boolean };

/**
 * Emphasis over already split pieces: `**` toggles bold, a single `*`/`_` next to
 * a word toggles italic, backticks toggle code. Unbalanced markers stay text.
 */
export function tokenizeInline(pieces: InlinePiece[]): InlineToken[] {
  const out: InlineToken[] = [];
  let bold = false;
  let italic = false;
  let code = false;
  const all = pieces.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const count = (re: RegExp) => (all.match(re) || []).length;
  // Only toggle markers that come in pairs, so a lone "*" or "`" stays visible.
  const boldOk = count(/\*\*/g) % 2 === 0;
  const codeOk = count(/`/g) % 2 === 0;
  const italicOk = count(/(?<![*\w])[*_](?=[^\s*])|(?<=[^\s*])[*_](?![*\w])/g) % 2 === 0;
  const push = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === 'text' && last.bold === bold && last.italic === italic && last.code === code) last.text += text;
    else out.push({ type: 'text', text, bold, italic, code });
  };
  pieces.forEach((piece, index) => {
    if (piece.type === 'cite') {
      out.push({ type: 'cite', index, bold, italic });
      return;
    }
    const t = piece.text;
    let buf = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '`' && codeOk) {
        push(buf);
        buf = '';
        code = !code;
      } else if (code) {
        buf += c;
      } else if (c === '*' && t[i + 1] === '*') {
        // "**" is bold or, if unpaired, literal text – never two italic markers.
        if (boldOk) {
          push(buf);
          buf = '';
          bold = !bold;
        } else {
          buf += '**';
        }
        i++;
      } else if ((c === '*' || c === '_') && italicOk && isItalicMarker(t, i, italic)) {
        push(buf);
        buf = '';
        italic = !italic;
      } else {
        buf += c;
      }
    }
    push(buf);
  });
  return out;
}

/** An opening marker precedes a non-space, a closing one follows a non-space; never inside a word. */
function isItalicMarker(t: string, i: number, open: boolean): boolean {
  const prev = t[i - 1] ?? ' ';
  const next = t[i + 1] ?? ' ';
  return open ? /\S/.test(prev) && !/\w/.test(next) : !/\w/.test(prev) && /\S/.test(next);
}

function renderInline(doc: Document, parent: HTMLElement, text: string, split: CitationSplitter): void {
  const pieces = split(text);
  for (const tok of tokenizeInline(pieces)) {
    let node: Node;
    if (tok.type === 'cite') {
      node = (pieces[tok.index] as { node: Node }).node;
    } else {
      node = doc.createTextNode(tok.text);
      if (tok.code) {
        const c = doc.createElementNS(HTML_NS, 'code');
        c.append(node);
        node = c;
      }
    }
    if (tok.italic) {
      const em = doc.createElementNS(HTML_NS, 'em');
      em.append(node);
      node = em;
    }
    if (tok.bold) {
      const b = doc.createElementNS(HTML_NS, 'strong');
      b.append(node);
      node = b;
    }
    parent.append(node);
  }
}

/** Renders Markdown into a fragment of block elements. */
export function renderMarkdown(doc: Document, markdown: string, split: CitationSplitter): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const block of parseBlocks(markdown)) {
    if (block.type === 'ul' || block.type === 'ol') {
      const list = doc.createElementNS(HTML_NS, block.type) as HTMLElement;
      for (const item of block.items) {
        const li = doc.createElementNS(HTML_NS, 'li') as HTMLElement;
        renderInline(doc, li, item, split);
        list.append(li);
      }
      frag.append(list);
    } else {
      const tag = block.type === 'h' ? `h${Math.min(6, block.level + 3)}` : 'p';
      const el = doc.createElementNS(HTML_NS, tag) as HTMLElement;
      renderInline(doc, el, (block as { text: string }).text, split);
      frag.append(el);
    }
  }
  return frag;
}
