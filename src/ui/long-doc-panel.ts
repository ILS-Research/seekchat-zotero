/**
 * Size check and long-document strategies above the chat.
 *
 * Shows whether the whole document fits into the context. If not, the user
 * picks a strategy:
 *   1. vector   - embed the document into a local vector database (placeholder, no function yet)
 *   2. keywords - the model expands the question into search terms; best pages fill the budget (implemented)
 *   3. chapters - only selected chapters: sent whole if they fit, else searched with keywords (implemented)
 */
import { formatCount } from '../core/context/fit';
import { descendants, topSelected, type Outline, type OutlineNode } from '../core/context/outline';
import type { LongDocStrategy } from '../core/context/types';
import { IMPLEMENTED_STRATEGIES, type ChatSession } from '../core/session';
import { logError } from '../util/log';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

const STRATEGIES: { id: LongDocStrategy; label: string; description: string }[] = [
  {
    id: 'vector',
    label: 'Semantische Suche (Vektordatenbank)',
    description: 'Das Dokument wird einmal in Abschnitte zerlegt, per Embedding-Modell indexiert und lokal gespeichert. ' +
      'Fragen finden dann auch Stellen, die andere Wörter verwenden.',
  },
  {
    id: 'keywords',
    label: 'Stichwort-Erweiterung durch das Modell',
    description: 'Das Modell erzeugt zu jeder Frage Suchbegriffe (Synonyme, Fachbegriffe) in der Sprache des Dokuments. ' +
      'Die passendsten Seiten gehen mit, so viele in den Kontext passen – nur Seiten mit Treffern und ihre Nachbarn.',
  },
  {
    id: 'chapters',
    label: 'Nur in ausgewählten Kapiteln suchen',
    description: 'Kapitel im Inhaltsverzeichnis auswählen. Passen sie in den Kontext, gehen sie vollständig mit; ' +
      'sonst wird nur in ihnen nach den passendsten Seiten gesucht.',
  },
];

export class LongDocPanel {
  readonly root: HTMLElement;
  private session: ChatSession | null = null;
  private renderedKey = '';
  private outline: Outline | null = null;
  private outlineFor: ChatSession | null = null;

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
    this.renderedKey = '';
  }

  /** Called on every chat repaint; rebuilds the DOM only when its own state changed. */
  render(): void {
    const s = this.session;
    const key = !s ? 'none'
      : s.fitError ? `err:${s.fitError}`
      : !s.fit ? 'checking'
      : `${s.fit.fits}:${s.fit.budgetChars}:${s.strategy}:${this.outline ? 'o' : ''}`;
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
      this.root.append(this.el('div', 'seekchat-hint', 'Prüfe Dokumentgröße …'));
      return;
    }
    if (fit.fits) {
      this.root.append(this.el('div', 'seekchat-hint',
        `Passt vollständig in den Kontext: ~${formatCount(fit.totalTokens)} von ~${formatCount(fit.budgetTokens)} Tokens, ${fit.pageCount} Seiten.`));
      return;
    }
    this.root.classList.add('warning');
    this.root.append(
      this.el('div', 'seekchat-longdoc-title', 'Dokument zu groß für den Kontext'),
      this.el('div', '',
        `~${formatCount(fit.totalTokens)} Tokens (${fit.pageCount} Seiten), verfügbar ~${formatCount(fit.budgetTokens)} Tokens ` +
        `(Einstellung „PDF-Text pro Frage“). Pro Frage kann nur ein Teil gesendet werden. Vorgehen:`),
    );
    const list = this.el('div', 'seekchat-strategies');
    for (const st of STRATEGIES) list.append(this.renderStrategy(s, st));
    this.root.append(list);
    if (s.strategy === 'vector') this.root.append(this.renderVectorPanel());
    if (s.strategy === 'chapters') this.root.append(this.renderChapterPanel(s));
  }

  private renderStrategy(s: ChatSession, st: (typeof STRATEGIES)[number]): HTMLElement {
    const implemented = IMPLEMENTED_STRATEGIES.includes(st.id);
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
    text.append(this.el('b', '', st.label));
    if (!implemented) text.append(this.doc.createTextNode(' '), this.el('span', 'seekchat-badge', 'noch ohne Funktion'));
    text.append(this.el('div', 'seekchat-hint', st.description));
    row.append(radio, text);
    row.dataset.strategy = st.id;
    return row;
  }

  private renderVectorPanel(): HTMLElement {
    const box = this.el('div', 'seekchat-strategy-panel');
    const btn = this.el('button', '', 'Embedding-Index erstellen') as HTMLButtonElement;
    btn.disabled = true;
    box.append(btn, this.el('div', 'seekchat-hint',
      'Noch nicht umgesetzt. Bis dahin nutzen Fragen die Stichwort-Erweiterung.'));
    return box;
  }

  private renderChapterPanel(s: ChatSession): HTMLElement {
    const box = this.el('div', 'seekchat-strategy-panel');
    if (!this.outline || this.outlineFor !== s) {
      box.append(this.el('div', 'seekchat-hint', 'Lade Inhaltsverzeichnis …'));
      void this.loadOutline(s);
      return box;
    }
    const outline = this.outline;
    const sourceNote = outline.source === 'pdf' ? 'Inhaltsverzeichnis des PDFs'
      : outline.source === 'headings' ? 'aus Überschriften im Text erkannt (PDF ohne Inhaltsverzeichnis)'
      : 'PDF ohne erkennbare Kapitel, daher Seitenblöcke';
    const sum = this.el('div', 'seekchat-chapter-sum');
    const budget = s.fit?.budgetTokens ?? 0;
    const updateSum = () => {
      const tokens = topSelected(outline.nodes, s.selectedChapters).reduce((n, c) => n + c.tokens, 0);
      sum.textContent = !s.selectedChapters.size ? 'Noch kein Kapitel ausgewählt.'
        : tokens > budget ? `Ausgewählt: ~${formatCount(tokens)} Tokens, mehr als die ~${formatCount(budget)} verfügbaren: ` +
          'Es wird innerhalb der Auswahl gesucht.'
        : `Ausgewählt: ~${formatCount(tokens)} von ~${formatCount(budget)} Tokens, geht vollständig mit.`;
      sum.classList.toggle('over', tokens > budget);
    };
    const tree = this.el('ul', 'seekchat-chapters');
    for (const node of outline.nodes) tree.append(this.renderNode(s, node, updateSum));
    updateSum();
    box.append(this.el('div', 'seekchat-hint', `Quelle: ${sourceNote}.`), tree, sum);
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
