/**
 * Size check and long-document strategies above the chat.
 *
 * Shows whether the whole document fits into the context. If not, the user
 * picks a strategy:
 *   1. vector   - semantic search in an external index: SeekBook for books, ZotSeek for other PDFs;
 *                 greyed out with a button "hand it to SeekBook/ZotSeek" while the document is not in it
 *   2. keywords - the model expands the question into search terms; best pages fill the budget (implemented)
 *   3. chapters - only selected chapters: sent whole if they fit, else searched with keywords (implemented)
 */
import { t, type Key } from '../i18n';
import { formatCount } from '../core/context/fit';
import { descendants, topSelected, type Outline, type OutlineNode } from '../core/context/outline';
import type { LongDocStrategy } from '../core/context/types';
import { IMPLEMENTED_STRATEGIES, type ChatSession } from '../core/session';
import { logError } from '../util/log';
import { PdfContextProvider } from '../core/context/pdf-context';
import { addToIndex, indexState, type IndexState } from '../core/context/index-access';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

const STRATEGIES: { id: LongDocStrategy; label: Key; description: Key }[] = [
  {
    id: 'vector',
    label: 'long.vector',
    description: 'long.vectorDesc',
  },
  {
    id: 'keywords',
    label: 'long.keywords',
    description: 'long.keywordsDesc',
  },
  {
    id: 'chapters',
    label: 'long.chapters',
    description: 'long.chaptersDesc',
  },
];

export class LongDocPanel {
  readonly root: HTMLElement;
  private session: ChatSession | null = null;
  private renderedKey = '';
  private outline: Outline | null = null;
  private outlineFor: ChatSession | null = null;
  /** Semantic search: whether this PDF is in its index (SeekBook/ZotSeek); null while unknown. */
  private index: IndexState | null = null;
  private indexFor: ChatSession | null = null;
  private indexNote = '';

  constructor(private doc: Document) {
    this.root = this.el('div', 'seekchat-longdoc');
  }

  private el(tag: string, cls?: string, text?: string): HTMLElement {
    const e = this.doc.createElementNS(HTML_NS, tag) as HTMLElement;
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  setSession(session: ChatSession | null): void {
    if (session === this.session) return;
    this.session = session;
    this.outline = null;
    this.outlineFor = null;
    this.index = null;
    this.indexFor = null;
    this.indexNote = '';
    this.renderedKey = '';
  }

  /** Index state of the session's PDF; re-read on each call (focus, button), repaints when it changed. */
  async refreshIndex(): Promise<void> {
    const s = this.session;
    if (!s || !(s.provider instanceof PdfContextProvider)) return;
    try {
      const state = await indexState(s.provider.attachment);
      if (this.session !== s) return;
      this.index = state;
      this.indexFor = s;
      // Not searchable (any more): questions must not wait on a strategy that cannot run.
      if (!state.ready && s.strategy === 'vector') s.setStrategy('keywords');
    } catch (e) {
      logError(e);
    }
    this.renderedKey = '';
    this.render();
  }

  /** Called on every chat repaint; rebuilds the DOM only when its own state changed. */
  render(): void {
    const s = this.session;
    const key = !s ? 'none'
      : s.fitError ? `err:${s.fitError}`
      : !s.fit ? 'checking'
      : `${s.fit.fits}:${s.fit.budgetChars}:${s.strategy}:${this.outline ? 'o' : ''}:${this.indexKey()}:${this.indexNote}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    this.root.replaceChildren();
    this.root.className = 'seekchat-longdoc';
    if (!s) return;
    if (s.fitError) {
      this.root.classList.add('error');
      this.root.append(this.el('div', '', s.fitError));
      return;
    }
    const fit = s.fit;
    if (!fit) {
      this.root.append(this.el('div', 'seekchat-hint', t('long.checking')));
      return;
    }
    if (fit.fits) {
      this.root.append(this.el('div', 'seekchat-hint',
        t('long.fits', { tokens: formatCount(fit.totalTokens), budget: formatCount(fit.budgetTokens), pages: fit.pageCount })));
      return;
    }
    this.root.classList.add('warning');
    this.root.append(
      this.el('div', 'seekchat-longdoc-title', t('long.tooLarge')),
      this.el('div', '', t('long.tooLargeDetail', { tokens: formatCount(fit.totalTokens), pages: fit.pageCount, budget: formatCount(fit.budgetTokens) })),
    );
    if (this.indexFor !== s) void this.refreshIndex();
    const list = this.el('div', 'seekchat-strategies');
    for (const st of STRATEGIES) list.append(this.renderStrategy(s, st));
    this.root.append(list);
    this.root.append(this.renderVectorPanel(s));
    if (s.strategy === 'chapters') this.root.append(this.renderChapterPanel(s));
  }

  private renderStrategy(s: ChatSession, st: (typeof STRATEGIES)[number]): HTMLElement {
    // The semantic search needs the PDF in SeekBook (books) or ZotSeek (other PDFs).
    const implemented = IMPLEMENTED_STRATEGIES.includes(st.id) && (st.id !== 'vector' || this.index?.ready === true);
    const row = this.el('label', implemented ? 'seekchat-strategy' : 'seekchat-strategy disabled');
    const radio = this.el('input') as HTMLInputElement;
    radio.type = 'radio';
    radio.name = `seekchat-strategy-${s.provider.key}`;
    radio.value = st.id;
    radio.checked = s.strategy === st.id;
    // Not yet implemented strategies are shown (so users know what is coming) but cannot be picked.
    radio.disabled = !implemented;
    if (implemented) radio.addEventListener('change', () => s.setStrategy(st.id));
    const text = this.el('span');
    text.append(this.el('b', '', t(st.label)));
    const desc = st.id === 'vector' && this.index ? t(this.index.kind === 'seekbook' ? 'long.vectorDescSeekBook' : 'long.vectorDescZotSeek') : t(st.description);
    text.append(this.el('div', 'seekchat-hint', desc));
    row.append(radio, text);
    row.dataset.strategy = st.id;
    return row;
  }

  private indexKey(): string {
    const i = this.index;
    return !i ? 'i?' : i.ready ? `i+${i.kind}` : `i-${i.kind}-${i.reason}`;
  }

  /** Under the strategies: where the semantic search runs, or why not and a button to hand the PDF over. */
  private renderVectorPanel(s: ChatSession): HTMLElement {
    const box = this.el('div', 'seekchat-strategy-panel seekchat-index-panel');
    const i = this.index;
    if (!i) {
      box.append(this.el('div', 'seekchat-hint', t('long.indexChecking')));
      return box;
    }
    const name = i.kind === 'seekbook' ? 'SeekBook' : 'ZotSeek';
    if (i.ready) {
      if (s.strategy === 'vector') box.append(this.el('div', 'seekchat-hint', t('long.indexReady', { index: name })));
      else return this.el('span');
      return box;
    }
    if (i.reason === 'unavailable') {
      box.append(this.el('div', 'seekchat-hint', t(i.kind === 'seekbook' ? 'long.noSeekBook' : 'long.noZotSeek')));
      return box;
    }
    box.append(this.el('div', 'seekchat-hint', t(i.reason === 'indexing' ? 'long.indexRunning' : 'long.notInIndex', { index: name })));
    if (i.reason === 'notIndexed') {
      if (i.canAdd) {
        const btn = this.el('button', 'seekchat-add-index', t(i.kind === 'seekbook' ? 'long.addSeekBook' : 'long.addZotSeek')) as HTMLButtonElement;
        btn.addEventListener('click', () => {
          btn.disabled = true;
          void (async () => {
            const ok = s.provider instanceof PdfContextProvider && await addToIndex(s.provider.attachment);
            this.indexNote = ok ? t('long.addStarted', { index: name }) : t('long.addFailed', { index: name });
            await this.refreshIndex();
          })();
        });
        box.append(btn);
      } else {
        box.append(this.el('div', 'seekchat-hint', t('long.addManually', { index: name })));
      }
    }
    if (this.indexNote) box.append(this.el('div', 'seekchat-hint', this.indexNote));
    return box;
  }

  private renderChapterPanel(s: ChatSession): HTMLElement {
    const box = this.el('div', 'seekchat-strategy-panel');
    if (!this.outline || this.outlineFor !== s) {
      box.append(this.el('div', 'seekchat-hint', t('long.loadingOutline')));
      void this.loadOutline(s);
      return box;
    }
    const outline = this.outline;
    const sourceNote = t(outline.source === 'pdf' ? 'long.outlinePdf' : outline.source === 'headings' ? 'long.outlineHeadings' : 'long.outlineBlocks');
    const sum = this.el('div', 'seekchat-chapter-sum');
    const budget = s.fit?.budgetTokens ?? 0;
    const updateSum = () => {
      const tokens = topSelected(outline.nodes, s.selectedChapters).reduce((n, c) => n + c.tokens, 0);
      const vars = { tokens: formatCount(tokens), budget: formatCount(budget) };
      sum.textContent = !s.selectedChapters.size ? t('long.noneSelected')
        : t(tokens > budget ? 'long.selectedOver' : 'long.selectedFits', vars);
      sum.classList.toggle('over', tokens > budget);
    };
    const tree = this.el('ul', 'seekchat-chapters');
    for (const node of outline.nodes) tree.append(this.renderNode(s, node, updateSum));
    updateSum();
    box.append(this.el('div', 'seekchat-hint', t('long.outlineSource', { source: sourceNote })), tree, sum);
    return box;
  }

  private renderNode(s: ChatSession, node: OutlineNode, onChange: () => void): HTMLElement {
    const li = this.el('li');
    const row = this.el('label', 'seekchat-chapter');
    const box = this.el('input') as HTMLInputElement;
    box.type = 'checkbox';
    box.checked = s.selectedChapters.has(node.id);
    const pages = node.pageStart === node.pageEnd ? `S. ${node.pageStart}` : `S. ${node.pageStart}–${node.pageEnd}`;
    row.append(box, this.el('span', 'seekchat-chapter-title', node.title),
      this.el('span', 'seekchat-chapter-meta', `${pages} · ~${formatCount(node.tokens)} Tokens`));
    li.append(row);
    let childList: HTMLElement | null = null;
    if (node.children.length) {
      childList = this.el('ul');
      for (const c of node.children) childList.append(this.renderNode(s, c, onChange));
      li.append(childList);
    }
    box.addEventListener('change', () => {
      // A chapter includes its sections: (un)checking it (un)checks all children.
      const ids = [node.id, ...descendants(node).map((d) => d.id)];
      for (const id of ids) box.checked ? s.selectedChapters.add(id) : s.selectedChapters.delete(id);
      childList?.querySelectorAll('input[type="checkbox"]').forEach((c: any) => { c.checked = box.checked; });
      onChange();
      s.chaptersChanged();
    });
    return li;
  }

  private async loadOutline(s: ChatSession): Promise<void> {
    try {
      const outline = await s.outline();
      if (this.session !== s) return;
      this.outline = outline;
      this.outlineFor = s;
      this.render();
    } catch (e) {
      logError(e);
    }
  }
}
