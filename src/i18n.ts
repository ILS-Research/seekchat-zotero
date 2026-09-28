/**
 * UI strings. English is the plugin's language; German (and later others) are
 * translations of the same keys. The locale follows Zotero's UI language and can
 * be forced with the pref extensions.zotero.seekchat.locale ("en", "de").
 *
 * Prompts sent to the model are English in code (prompt.ts); only the citation
 * marker the model is asked to use ([p. 12] / [S. 12]) follows the UI language.
 * The item pane section header and the context menu use Fluent (locale/*.ftl),
 * since Zotero reads those labels itself.
 */

const EN = {
  // Generic
  'common.newChat': 'New chat',
  'common.send': 'Send',
  'common.stop': 'Stop',
  'common.close': 'Close',
  'common.settings': '⚙ Settings',
  'common.saveMd': '⤓ Save chat as .md',
  'common.saveMdShort': '⤓ Chat as .md',
  'common.saveNote': 'Save chat as note',
  'common.saveNoteShort': 'Chat as note',
  'common.noteSaved': 'Note saved ✓',
  'common.saveFailed': 'Saving failed',
  'common.saveMdTitle': 'Save chat as Markdown',
  'common.noModel': 'No model selected – see Settings → SeekChat',
  'common.model': 'Model: {model}',
  'common.error': 'Error: {message}',
  'common.cancelled': '[cancelled]',
  'common.noAnswer': '(no answer received)',
  'common.notYet': 'not yet available',
  'common.untitled': 'Untitled',
  'common.untitledDoc': 'Untitled document',
  'common.etAl': ' et al.',

  // PDF chat section
  'pdf.placeholder': 'Question about the PDF … (Enter to send, Shift+Enter for a new line)',
  'pdf.target': 'PDF: {label}',
  'pdf.none': 'No PDF found for this item.',
  'pdf.reading': 'Reading PDF …',
  'pdf.missingFile': 'The PDF file is not on this computer (not synced/downloaded yet).',
  'pdf.noText': 'The PDF contains no text (scanned?). Please run OCR first.',
  'pdf.openPage': 'Open page {page} in the PDF',

  // Long documents
  'long.checking': 'Checking document size …',
  'long.fits': 'Fits into the context: ~{tokens} of ~{budget} tokens, {pages} pages.',
  'long.tooLarge': 'Document too large for the context',
  'long.tooLargeDetail': '~{tokens} tokens ({pages} pages), available ~{budget} tokens (setting "PDF text per question"). ' +
    'Only part of it can be sent per question. Approach:',
  'long.vector': 'Semantic search (vector database)',
  'long.vectorDesc': 'The document is split into passages once, embedded and stored locally. Questions then also find ' +
    'passages that use different words.',
  'long.keywords': 'Keyword expansion by the model',
  'long.keywordsDesc': 'For each question the model generates search terms (synonyms, technical terms) in the document\'s ' +
    'language. The best matching pages are sent, as many as fit – only pages with hits and their neighbours.',
  'long.chapters': 'Search selected chapters only',
  'long.chaptersDesc': 'Pick chapters in the table of contents. If they fit into the context they are sent whole; ' +
    'otherwise only they are searched for the best pages.',
  'long.buildIndex': 'Build embedding index',
  'long.vectorPending': 'Not implemented yet. Until then questions use the keyword expansion.',
  'long.loadingOutline': 'Loading table of contents …',
  'long.outlinePdf': 'table of contents of the PDF',
  'long.outlineHeadings': 'detected from headings in the text (PDF without table of contents)',
  'long.outlineBlocks': 'PDF without recognisable chapters, hence page blocks',
  'long.outlineSource': 'Source: {source}.',
  'long.noneSelected': 'No chapter selected yet.',
  'long.selectedOver': 'Selected: ~{tokens} tokens, more than the ~{budget} available: the selection is searched.',
  'long.selectedFits': 'Selected: ~{tokens} of ~{budget} tokens, sent whole.',

  // Meta lines and progress
  'meta.fullText': 'full text, {pages} pages',
  'meta.chaptersWhole': '{chapters} whole: {pageLabel} {range} of {pages} pages',
  'meta.excerpts': '{scope}excerpts: {pageLabel} {range} of {pages} pages ({how})',
  'meta.noHits': 'no hits, pages spread',
  'meta.hitPages': '{n} pages with hits',
  'meta.chapter': 'chapter {titles}',
  'meta.chapters': 'chapters {titles}',
  'meta.library': '{scope}: {sources}, {passages} (ZotSeek)',
  'meta.sources.one': '{n} source',
  'meta.sources.other': '{n} sources',
  'meta.passages.one': '{n} passage',
  'meta.passages.other': '{n} passages',
  'meta.withoutText': '{n} hits without text excerpt not used',
  'meta.overBudget': '{n} passages over the budget',
  'meta.language': 'Document language: {language} ({source})',
  'meta.languageMetadata': 'from metadata',
  'meta.languageModel': 'detected by the model',
  'meta.languageGuess': 'guessed',
  'meta.languageUnknown': 'Document language unknown, search terms in English and German.',
  'meta.keywords': 'Search terms: {keywords}',
  'meta.noKeywords': 'No search terms received, searching with the question only.',
  'meta.chaptersOver': 'Selection larger than the budget: searching within the chapters.',
  'meta.strategyFallback': 'Chosen strategy not available yet, using keyword expansion.',
  'meta.detectLanguage': 'Detecting document language …',
  'meta.makeKeywords': 'Generating search terms …',
  'meta.cancelled': 'cancelled',
  'meta.book': 'Book {i} of {n}',
  'meta.bookLeft': 'Book {i} of {n} · {left} remaining',
  'meta.bookWaiting': 'waiting',
  'meta.bookReading': 'reading PDF …',
  'meta.bookSkipped': 'not processed',
  'book.noMatch': 'No relevant passages found in this book.',
  'book.waiting': 'waiting …',

  // Errors
  'error.noModel': 'No chat model selected (SeekChat settings).',
  'error.noChapters': 'No chapters selected. Please tick chapters in the table of contents above.',
  'error.librarySearch': 'ZotSeek cannot search this library.',
  'error.noItems': 'No items selected.',
  'error.mixedLibraries': 'The selected items are in different libraries.',
  'error.onlyNoText': 'ZotSeek found only hits without text excerpt in {scope}. Is the indexing mode set to "full"?',
  'error.noPassages': 'ZotSeek found no matching passages in {scope}.',

  // ZotSeek availability
  'zotseek.notInstalled': 'The library chat needs the ZotSeek plugin. Without ZotSeek only the chat with single PDFs is available.',
  'zotseek.serverOff': 'The library chat needs Zotero\'s local HTTP server: Settings → Advanced → ' +
    '"Allow other applications on this computer to communicate with Zotero".',
  'zotseek.endpointOff': 'The library chat needs "AI Agent Access" in the ZotSeek settings.',
  'zotseek.noIndex': 'ZotSeek has not indexed anything yet. Please index the library in ZotSeek first (mode "full" for PDF contents).',
  'zotseek.error': 'ZotSeek search not reachable.',

  // Library chat window
  'lib.scope': 'Scope:',
  'lib.sources': 'Sources:',
  'lib.model': 'Model:',
  'lib.library': 'Library "{name}"',
  'lib.libraryDefault': 'Library',
  'lib.collection': 'Collection "{name}"',
  'lib.items.one': '{n} selected item',
  'lib.items.other': '{n} selected items',
  'lib.windowTitle': 'SeekChat – {scope}',
  'lib.placeholder': 'Question for the library … (Enter to send, Shift+Enter for a new line)',
  'lib.checking': 'Checking ZotSeek …',
  'lib.indexed': 'ZotSeek: {n} items indexed',
  'lib.sourceZotSeek': 'ZotSeek',
  'lib.sourceBooksKeywords': 'Books (keyword search, no index)',
  'lib.sourceBooksIndex': 'Books (own index)',
  'lib.zotseekNote': 'ZotSeek is built for papers: books only if "Exclude books" is off there, and PDF contents only in ' +
    'mode "full". At most 100–200 passages per item (for books usually only the first chapters); it stops at the first ' +
    'bibliography; PDFs without a parent item are missing. Whole books: chat with the PDF in the item pane, or the ' +
    'books source. An own index for books is planned.',
  'lib.booksSearching': 'Looking for books in this scope …',
  'lib.booksNone': 'No books with a PDF in this scope.',
  'lib.books.one': '{n} book with a PDF in this scope. Each book is asked separately like in the PDF chat ' +
    '(keyword search, 2–3 model calls per book) – about as long as a PDF question per book; "Stop" cancels.',
  'lib.books.other': '{n} books with a PDF in this scope. Each book is asked separately like in the PDF chat ' +
    '(keyword search, 2–3 model calls per book) – about as long as a PDF question per book; "Stop" cancels.',
  'lib.noSource': 'No source selected. Please tick ZotSeek or books under "Sources" above.',
  'lib.intro': 'Questions for {scope}. ',
  'lib.introZotSeek': 'ZotSeek provides the best matching passages, cited as [no., {pageLabel} x]. ',
  'lib.introBooks': 'Then each of the {n} books is asked separately, cited as [{pageLabel} x].',
  'lib.unavailable': 'The library chat is not possible right now (see above). The chat with single PDFs in the item pane still works.',
  'lib.searching': 'Searching the library …',
  'lib.showInLibrary': 'Show in library',
  'lib.openSourcePage': '{label}, open {pageLabel} {page}',
  'lib.showSource': 'Show {label} in the library',
  'lib.sourceList': 'Sources ({cited} of {total} cited)',
  'lib.note': 'note',
  'lib.tooltip': 'SeekChat: chat with the library (with ZotSeek)',

  // Coverage hint
  'cov.notSearchable': 'Not searchable: {parts}.',
  'cov.pdfs.one': '{n} PDF without parent item',
  'cov.pdfs.other': '{n} PDFs without parent item',
  'cov.books.one': '{n} book (ZotSeek "Exclude books" is on)',
  'cov.books.other': '{n} books (ZotSeek "Exclude books" is on)',
  'cov.abstractOnly': 'ZotSeek indexes titles and abstracts only (indexing mode "abstract"), no PDF contents.',

  // Export and notes
  'export.exported': 'Exported on {date}',
  'export.model': ' · Model: {model}',
  'export.question': 'Question {n}',
  'export.book': 'Book: {label}',
  'export.sources': 'Sources:',
  'export.request': 'Request {i} to the model: {purpose} ({params}; {chars} characters)',
  'export.params': 'model {model}, temperature {temperature}, max. {maxTokens} tokens',
  'export.numCtx': 'num_ctx {n}',
  'purpose.answer': 'Answer',
  'purpose.language': 'Language detection',
  'purpose.keywords': 'Search terms',

  // Limits
  'limits.configured': 'context {n} from the server configuration',
  'limits.maximum': 'context {n} (model maximum)',
  'limits.none': 'server reports no context size',
  'limits.manual': 'set manually',
  'limits.noModel': 'no model selected, manual values',
  'limits.unreachable': 'server not reachable',
  'limits.fallback': '{detail}, manual values',
  'limits.share': '{detail}, {percent} % of it',

  // Settings pane
  'prefs.server': 'Chat server',
  'prefs.provider': 'Interface:',
  'prefs.providerOllama': 'Ollama (native, context window adjustable)',
  'prefs.providerOpenai': 'OpenAI-compatible (/v1)',
  'prefs.baseUrl': 'Server URL:',
  'prefs.apiKey': 'API key (optional):',
  'prefs.test': 'Test connection',
  'prefs.model': 'Chat model:',
  'prefs.serverHelp': 'Ollama: server root, e.g. https://ollama.example.local. OpenAI-compatible: base including /v1, ' +
    'e.g. https://llm.example.local/v1. The API key is stored unencrypted in the Zotero settings.',
  'prefs.remoteTitle': 'Allowed remote hosts (caution)',
  'prefs.remoteHelp': 'Without an entry SeekChat only talks to a server on this computer (127.0.0.1, localhost). ' +
    'Hosts listed here (comma-separated, without http:// and port, e.g. ollama.example.local) receive with every ' +
    'question the text of the PDF or the selected pages, the question and the chat history. Whoever runs or ' +
    'administers this host or can read its logs can read these contents; with http:// instead of https:// also ' +
    'anyone on the network in between. Only list hosts in your own, trusted network that may receive this data.',
  'prefs.remoteHosts': 'Allowed hosts:',
  'prefs.remoteOn': 'Allowed: {hosts}. PDF text and questions to these hosts leave this computer.',
  'prefs.remoteOff': 'No remote hosts allowed: SeekChat stays on this computer.',
  'prefs.connecting': 'Connecting …',
  'prefs.connected': 'Connected, {n} model(s).',
  'prefs.connectedEmpty': 'Connected, but the server reports no models.',
  'prefs.answer': 'Answer and context',
  'prefs.temperature': 'Temperature (%):',
  'prefs.history': 'Previous questions sent:',
  'prefs.limitsAuto': 'Automatic from the model',
  'prefs.limitsManual': 'Manual',
  'prefs.numCtx': 'Context window:',
  'prefs.contextChars': 'PDF text per question:',
  'prefs.maxTokens': 'Max. answer length:',
  'prefs.refresh': 'Detect again',
  'prefs.asking': 'Asking the server …',
  'prefs.detected': 'Detected: {detail}.',
  'prefs.notDetected': 'Not detectable ({detail}).',
  'prefs.tokens': '{n} tokens',
  'prefs.chars': '{n} characters (~{tokens} tokens)',
  'prefs.autoHelp': 'SeekChat asks the server about the model: for Ollama num_ctx from the Modelfile, else the model\'s ' +
    'maximum context length (vLLM: max_model_len). It uses 80 % of that; the answer length is a tenth of it (at most ' +
    '12,288, and at most 80 % of num_predict), the rest minus room for prompt and history goes to the document text ' +
    '(~3.5 characters per token). If the server reports nothing, the manual values apply. Large values make answers slower.',
  'prefs.numCtxManual': 'Context window (tokens):',
  'prefs.contextCharsManual': 'PDF text per question (characters):',
  'prefs.maxTokensManual': 'Max. answer length (tokens):',
  'prefs.manualHelp': 'The context window only applies to Ollama (num_ctx); OpenAI-compatible servers set it themselves. ' +
    'Rule of thumb: PDF text (characters) ÷ 3.5 + answer length + history must fit into the context window. ' +
    'Longer PDFs are cut down to the pages that best match the question.',
  'prefs.systemPrompt': 'System prompt for the PDF chat (empty = default):',
  'prefs.library': 'Library chat (with ZotSeek)',
  'prefs.libraryTopK': 'Passages per question from ZotSeek:',
  'prefs.libraryHelp': 'How many matching passages ZotSeek returns per question (1–100). What fits into "PDF text per ' +
    'question" is sent. For collections and selected items SeekChat always fetches 100 and keeps the matching ones. ' +
    'The library chat needs ZotSeek with "AI Agent Access" and Zotero\'s local HTTP server.',

  // Citation marker the model is asked to use and that links show
  'cite.page': 'p.',
} as const;

export type Key = keyof typeof EN;

const DE: Record<Key, string> = {
  'common.newChat': 'Neuer Chat',
  'common.send': 'Senden',
  'common.stop': 'Stopp',
  'common.close': 'Schließen',
  'common.settings': '⚙ Einstellungen',
  'common.saveMd': '⤓ Chat als .md speichern',
  'common.saveMdShort': '⤓ Chat als .md',
  'common.saveNote': 'Verlauf als Notiz speichern',
  'common.saveNoteShort': 'Verlauf als Notiz',
  'common.noteSaved': 'Notiz gespeichert ✓',
  'common.saveFailed': 'Fehler beim Speichern',
  'common.saveMdTitle': 'Chat als Markdown speichern',
  'common.noModel': 'Kein Modell gewählt – siehe Einstellungen → SeekChat',
  'common.model': 'Modell: {model}',
  'common.error': 'Fehler: {message}',
  'common.cancelled': '[abgebrochen]',
  'common.noAnswer': '(keine Antwort erhalten)',
  'common.notYet': 'noch ohne Funktion',
  'common.untitled': 'Ohne Titel',
  'common.untitledDoc': 'Unbenanntes Dokument',
  'common.etAl': ' u. a.',

  'pdf.placeholder': 'Frage zum PDF … (Enter senden, Shift+Enter neue Zeile)',
  'pdf.target': 'PDF: {label}',
  'pdf.none': 'Kein PDF zu diesem Eintrag gefunden.',
  'pdf.reading': 'Lese PDF …',
  'pdf.missingFile': 'Die PDF-Datei ist auf diesem Rechner nicht vorhanden (noch nicht synchronisiert/heruntergeladen).',
  'pdf.noText': 'Das PDF enthält keinen Text (gescannt?). Bitte zuerst OCR ausführen.',
  'pdf.openPage': 'Seite {page} im PDF öffnen',

  'long.checking': 'Prüfe Dokumentgröße …',
  'long.fits': 'Passt vollständig in den Kontext: ~{tokens} von ~{budget} Tokens, {pages} Seiten.',
  'long.tooLarge': 'Dokument zu groß für den Kontext',
  'long.tooLargeDetail': '~{tokens} Tokens ({pages} Seiten), verfügbar ~{budget} Tokens (Einstellung „PDF-Text pro Frage“). ' +
    'Pro Frage kann nur ein Teil gesendet werden. Vorgehen:',
  'long.vector': 'Semantische Suche (Vektordatenbank)',
  'long.vectorDesc': 'Das Dokument wird einmal in Abschnitte zerlegt, per Embedding-Modell indexiert und lokal gespeichert. ' +
    'Fragen finden dann auch Stellen, die andere Wörter verwenden.',
  'long.keywords': 'Stichwort-Erweiterung durch das Modell',
  'long.keywordsDesc': 'Das Modell erzeugt zu jeder Frage Suchbegriffe (Synonyme, Fachbegriffe) in der Sprache des Dokuments. ' +
    'Die passendsten Seiten gehen mit, so viele in den Kontext passen – nur Seiten mit Treffern und ihre Nachbarn.',
  'long.chapters': 'Nur in ausgewählten Kapiteln suchen',
  'long.chaptersDesc': 'Kapitel im Inhaltsverzeichnis auswählen. Passen sie in den Kontext, gehen sie vollständig mit; ' +
    'sonst wird nur in ihnen nach den passendsten Seiten gesucht.',
  'long.buildIndex': 'Embedding-Index erstellen',
  'long.vectorPending': 'Noch nicht umgesetzt. Bis dahin nutzen Fragen die Stichwort-Erweiterung.',
  'long.loadingOutline': 'Lade Inhaltsverzeichnis …',
  'long.outlinePdf': 'Inhaltsverzeichnis des PDFs',
  'long.outlineHeadings': 'aus Überschriften im Text erkannt (PDF ohne Inhaltsverzeichnis)',
  'long.outlineBlocks': 'PDF ohne erkennbare Kapitel, daher Seitenblöcke',
  'long.outlineSource': 'Quelle: {source}.',
  'long.noneSelected': 'Noch kein Kapitel ausgewählt.',
  'long.selectedOver': 'Ausgewählt: ~{tokens} Tokens, mehr als die ~{budget} verfügbaren: Es wird innerhalb der Auswahl gesucht.',
  'long.selectedFits': 'Ausgewählt: ~{tokens} von ~{budget} Tokens, geht vollständig mit.',

  'meta.fullText': 'vollständiger Text, {pages} Seiten',
  'meta.chaptersWhole': '{chapters} vollständig: {pageLabel} {range} von {pages} Seiten',
  'meta.excerpts': '{scope}Auszüge: {pageLabel} {range} von {pages} Seiten ({how})',
  'meta.noHits': 'keine Treffer, verteilte Seiten',
  'meta.hitPages': '{n} Seiten mit Treffern',
  'meta.chapter': 'Kapitel {titles}',
  'meta.chapters': 'Kapitel {titles}',
  'meta.library': '{scope}: {sources}, {passages} (ZotSeek)',
  'meta.sources.one': '{n} Quelle',
  'meta.sources.other': '{n} Quellen',
  'meta.passages.one': '{n} Abschnitt',
  'meta.passages.other': '{n} Abschnitte',
  'meta.withoutText': '{n} Treffer ohne Textauszug nicht verwendet',
  'meta.overBudget': '{n} Abschnitte über dem Budget',
  'meta.language': 'Dokumentsprache: {language} ({source})',
  'meta.languageMetadata': 'aus Metadaten',
  'meta.languageModel': 'vom Modell erkannt',
  'meta.languageGuess': 'geschätzt',
  'meta.languageUnknown': 'Dokumentsprache unbekannt, Suchbegriffe auf Englisch und Deutsch.',
  'meta.keywords': 'Suchbegriffe: {keywords}',
  'meta.noKeywords': 'Keine Suchbegriffe erhalten, suche nur mit der Frage.',
  'meta.chaptersOver': 'Auswahl größer als das Budget: Suche innerhalb der Kapitel.',
  'meta.strategyFallback': 'Gewählte Strategie noch nicht verfügbar, nutze Stichwort-Erweiterung.',
  'meta.detectLanguage': 'Bestimme Dokumentsprache …',
  'meta.makeKeywords': 'Erzeuge Suchbegriffe …',
  'meta.cancelled': 'abgebrochen',
  'meta.book': 'Buch {i} von {n}',
  'meta.bookLeft': 'Buch {i} von {n} · noch {left} ausstehend',
  'meta.bookWaiting': 'wartet',
  'meta.bookReading': 'lese PDF …',
  'meta.bookSkipped': 'nicht mehr bearbeitet',
  'book.noMatch': 'Keine passenden Stellen in diesem Buch gefunden.',
  'book.waiting': 'wartet …',

  'error.noModel': 'Kein Chat-Modell gewählt (SeekChat-Einstellungen).',
  'error.noChapters': 'Keine Kapitel ausgewählt. Bitte oben im Inhaltsverzeichnis Kapitel ankreuzen.',
  'error.librarySearch': 'Diese Bibliothek kann ZotSeek nicht durchsuchen.',
  'error.noItems': 'Keine Einträge ausgewählt.',
  'error.mixedLibraries': 'Die ausgewählten Einträge liegen in verschiedenen Bibliotheken.',
  'error.onlyNoText': 'ZotSeek fand in {scope} nur Treffer ohne Textauszug. Ist der Indexierungsmodus auf „full“ gestellt?',
  'error.noPassages': 'ZotSeek fand in {scope} keine passenden Textstellen.',

  'zotseek.notInstalled': 'Chat über die Bibliothek braucht das Plugin ZotSeek. Ohne ZotSeek steht nur der Chat mit einzelnen PDFs zur Verfügung.',
  'zotseek.serverOff': 'Chat über die Bibliothek braucht Zoteros lokalen HTTP-Server: Einstellungen → Erweitert → ' +
    '„Anderen Anwendungen auf diesem Computer erlauben, mit Zotero zu kommunizieren“.',
  'zotseek.endpointOff': 'Chat über die Bibliothek braucht in den ZotSeek-Einstellungen „AI Agent Access“.',
  'zotseek.noIndex': 'ZotSeek hat noch nichts indexiert. Bitte zuerst in ZotSeek die Bibliothek indexieren (Modus „full“ für PDF-Inhalte).',
  'zotseek.error': 'ZotSeek-Suche nicht erreichbar.',

  'lib.scope': 'Umfang:',
  'lib.sources': 'Quellen:',
  'lib.model': 'Modell:',
  'lib.library': 'Bibliothek „{name}“',
  'lib.libraryDefault': 'Bibliothek',
  'lib.collection': 'Collection „{name}“',
  'lib.items.one': '{n} ausgewählter Eintrag',
  'lib.items.other': '{n} ausgewählte Einträge',
  'lib.windowTitle': 'SeekChat – {scope}',
  'lib.placeholder': 'Frage an die Bibliothek … (Enter senden, Shift+Enter neue Zeile)',
  'lib.checking': 'Prüfe ZotSeek …',
  'lib.indexed': 'ZotSeek: {n} Einträge indexiert',
  'lib.sourceZotSeek': 'ZotSeek',
  'lib.sourceBooksKeywords': 'Bücher (Stichwortsuche, ohne Index)',
  'lib.sourceBooksIndex': 'Bücher (eigener Index)',
  'lib.zotseekNote': 'ZotSeek ist für Paper gebaut: Bücher nur, wenn dort „Bücher ausschließen“ aus ist, und PDF-Inhalte nur im ' +
    'Modus „full“. Pro Eintrag höchstens 100–200 Abschnitte (bei Büchern meist nur die ersten Kapitel); Schluss ' +
    'beim ersten Literaturverzeichnis; PDFs ohne übergeordneten Eintrag fehlen. Ganze Bücher: Chat mit dem PDF ' +
    'im Eintragsbereich oder die Quelle Bücher. Ein eigener Index für Bücher ist geplant.',
  'lib.booksSearching': 'Suche Bücher im Umfang …',
  'lib.booksNone': 'Keine Bücher mit PDF in diesem Umfang.',
  'lib.books.one': '{n} Buch mit PDF in diesem Umfang. Jedes Buch wird einzeln befragt wie im PDF-Chat ' +
    '(Stichwortsuche, je Buch 2–3 Modellaufrufe) – das dauert pro Buch etwa so lange wie eine PDF-Frage; mit „Stopp“ abbrechbar.',
  'lib.books.other': '{n} Bücher mit PDF in diesem Umfang. Jedes Buch wird einzeln befragt wie im PDF-Chat ' +
    '(Stichwortsuche, je Buch 2–3 Modellaufrufe) – das dauert pro Buch etwa so lange wie eine PDF-Frage; mit „Stopp“ abbrechbar.',
  'lib.noSource': 'Keine Quelle ausgewählt. Bitte oben unter „Quellen“ ZotSeek oder Bücher anhaken.',
  'lib.intro': 'Fragen an {scope}. ',
  'lib.introZotSeek': 'ZotSeek liefert die passendsten Textstellen, zitiert als [Nr., {pageLabel} x]. ',
  'lib.introBooks': 'Danach wird jedes der {n} Bücher einzeln befragt, zitiert als [{pageLabel} x].',
  'lib.unavailable': 'Chat über die Bibliothek ist gerade nicht möglich (siehe oben). Der Chat mit einzelnen PDFs im ' +
    'Eintragsbereich funktioniert weiterhin.',
  'lib.searching': 'Suche in der Bibliothek …',
  'lib.showInLibrary': 'In der Bibliothek zeigen',
  'lib.openSourcePage': '{label}, {pageLabel} {page} öffnen',
  'lib.showSource': '{label} in der Bibliothek zeigen',
  'lib.sourceList': 'Quellen ({cited} von {total} zitiert)',
  'lib.note': 'Notiz',
  'lib.tooltip': 'SeekChat: Chat über die Bibliothek (mit ZotSeek)',

  'cov.notSearchable': 'Nicht durchsuchbar: {parts}.',
  'cov.pdfs.one': '{n} PDF ohne übergeordneten Eintrag',
  'cov.pdfs.other': '{n} PDFs ohne übergeordneten Eintrag',
  'cov.books.one': '{n} Buch (in ZotSeek „Bücher ausschließen“ an)',
  'cov.books.other': '{n} Bücher (in ZotSeek „Bücher ausschließen“ an)',
  'cov.abstractOnly': 'ZotSeek indexiert nur Titel und Abstracts (Indexierungsmodus „abstract“), keine PDF-Inhalte.',

  'export.exported': 'Exportiert am {date}',
  'export.model': ' · Modell: {model}',
  'export.question': 'Frage {n}',
  'export.book': 'Buch: {label}',
  'export.sources': 'Quellen:',
  'export.request': 'Anfrage {i} an das Modell: {purpose} ({params}; {chars} Zeichen)',
  'export.params': 'Modell {model}, Temperatur {temperature}, max. {maxTokens} Tokens',
  'export.numCtx': 'num_ctx {n}',
  'purpose.answer': 'Antwort',
  'purpose.language': 'Spracherkennung',
  'purpose.keywords': 'Suchbegriffe',

  'limits.configured': 'Kontext {n} laut Server-Konfiguration',
  'limits.maximum': 'Kontext {n} (Maximum des Modells)',
  'limits.none': 'Server meldet keine Kontextgröße',
  'limits.manual': 'manuell festgelegt',
  'limits.noModel': 'kein Modell gewählt, manuelle Werte',
  'limits.unreachable': 'Server nicht erreichbar',
  'limits.fallback': '{detail}, manuelle Werte',
  'limits.share': '{detail}, davon {percent} %',

  'prefs.server': 'Chat-Server',
  'prefs.provider': 'Schnittstelle:',
  'prefs.providerOllama': 'Ollama (nativ, Kontextfenster einstellbar)',
  'prefs.providerOpenai': 'OpenAI-kompatibel (/v1)',
  'prefs.baseUrl': 'Server-URL:',
  'prefs.apiKey': 'API-Key (optional):',
  'prefs.test': 'Verbindung testen',
  'prefs.model': 'Chat-Modell:',
  'prefs.serverHelp': 'Ollama: Server-Wurzel, z. B. https://ollama.example.local. OpenAI-kompatibel: Basis inkl. /v1, ' +
    'z. B. https://llm.example.local/v1. Der API-Key wird unverschlüsselt in den Zotero-Einstellungen gespeichert.',
  'prefs.remoteTitle': 'Erlaubte entfernte Hosts (Vorsicht)',
  'prefs.remoteHelp': 'Ohne Eintrag spricht SeekChat nur mit einem Server auf diesem Rechner (127.0.0.1, localhost). ' +
    'Hier eingetragene Hosts (kommagetrennt, ohne http:// und Port, z. B. ollama.example.local) erhalten bei jeder ' +
    'Frage den Text des PDFs bzw. der ausgewählten Seiten, die Frage und den bisherigen Chatverlauf. Wer diesen Host ' +
    'betreibt, administriert oder seine Logs lesen kann, kann diese Inhalte lesen; bei http:// statt https:// ' +
    'zusätzlich jeder im Netzwerk dazwischen. Nur Hosts im eigenen, vertrauenswürdigen Netz eintragen, an die diese ' +
    'Daten gehen dürfen.',
  'prefs.remoteHosts': 'Erlaubte Hosts:',
  'prefs.remoteOn': 'Freigegeben: {hosts}. PDF-Text und Fragen an diese Hosts verlassen diesen Rechner.',
  'prefs.remoteOff': 'Keine entfernten Hosts freigegeben: SeekChat bleibt auf diesem Rechner.',
  'prefs.connecting': 'Verbinde …',
  'prefs.connected': 'Verbunden, {n} Modell(e).',
  'prefs.connectedEmpty': 'Verbunden, aber der Server meldet keine Modelle.',
  'prefs.answer': 'Antwort und Kontext',
  'prefs.temperature': 'Temperatur (%):',
  'prefs.history': 'Mitgesendete Vorfragen:',
  'prefs.limitsAuto': 'Automatisch aus dem Modell',
  'prefs.limitsManual': 'Manuell',
  'prefs.numCtx': 'Kontextfenster:',
  'prefs.contextChars': 'PDF-Text pro Frage:',
  'prefs.maxTokens': 'Max. Antwortlänge:',
  'prefs.refresh': 'Neu ermitteln',
  'prefs.asking': 'Frage Server …',
  'prefs.detected': 'Ermittelt: {detail}.',
  'prefs.notDetected': 'Nicht ermittelbar ({detail}).',
  'prefs.tokens': '{n} Tokens',
  'prefs.chars': '{n} Zeichen (~{tokens} Tokens)',
  'prefs.autoHelp': 'SeekChat fragt den Server nach dem Modell: bei Ollama num_ctx aus der Modelldatei, sonst die maximale ' +
    'Kontextlänge des Modells (bei vLLM max_model_len). Davon nutzt es 80 %; die Antwortlänge ist ein Zehntel davon ' +
    '(höchstens 12.288 und höchstens 80 % von num_predict), der Rest abzüglich Platz für Prompt und Verlauf geht an den ' +
    'Dokumenttext (~3,5 Zeichen je Token). Meldet der Server nichts, gelten die manuellen Werte. Große Werte machen ' +
    'Antworten langsamer.',
  'prefs.numCtxManual': 'Kontextfenster (Tokens):',
  'prefs.contextCharsManual': 'PDF-Text pro Frage (Zeichen):',
  'prefs.maxTokensManual': 'Max. Antwortlänge (Tokens):',
  'prefs.manualHelp': 'Das Kontextfenster gilt nur für Ollama (num_ctx); bei OpenAI-kompatiblen Servern legt es der Server fest. ' +
    'Faustregel: PDF-Text (Zeichen) ÷ 3,5 + Antwortlänge + Verlauf muss ins Kontextfenster passen. ' +
    'Längere PDFs werden auf die zur Frage passendsten Seiten gekürzt.',
  'prefs.systemPrompt': 'System-Prompt für den PDF-Chat (leer = Standard):',
  'prefs.library': 'Chat über die Bibliothek (mit ZotSeek)',
  'prefs.libraryTopK': 'Abschnitte pro Frage von ZotSeek:',
  'prefs.libraryHelp': 'Wie viele passende Textabschnitte ZotSeek pro Frage liefert (1–100). Davon geht mit, was in „PDF-Text ' +
    'pro Frage“ passt. Bei Collections und ausgewählten Einträgen holt SeekChat immer 100 und behält die passenden. ' +
    'Der Chat über die Bibliothek braucht ZotSeek mit „AI Agent Access“ und Zoteros lokalen HTTP-Server.',

  'cite.page': 'S.',
};

const LANGUAGE_NAMES: Record<string, Record<string, string>> = {
  en: {
    de: 'German', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', pl: 'Polish',
    cs: 'Czech', da: 'Danish', sv: 'Swedish', no: 'Norwegian', fi: 'Finnish', ru: 'Russian', tr: 'Turkish',
    zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  },
  de: {
    de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', nl: 'Niederländisch',
    pt: 'Portugiesisch', pl: 'Polnisch', cs: 'Tschechisch', da: 'Dänisch', sv: 'Schwedisch', no: 'Norwegisch',
    fi: 'Finnisch', ru: 'Russisch', tr: 'Türkisch', zh: 'Chinesisch', ja: 'Japanisch', ko: 'Koreanisch',
  },
};

const TABLES: Record<string, Record<Key, string>> = { en: EN, de: DE };

export type Locale = 'en' | 'de';

let forced: Locale | null = null;

/** For tests: force a locale (null = automatic again). */
export function setLocale(locale: Locale | null): void {
  forced = locale;
}

/** Pref "seekchat.locale" ("en", "de"), else Zotero's UI language; English for anything without a translation. */
export function currentLocale(): Locale {
  if (forced) return forced;
  const z = (globalThis as any).Zotero;
  let raw = '';
  try {
    raw = String(z?.Prefs?.get('seekchat.locale') || z?.locale || '');
  } catch {
    // outside Zotero (unit tests)
  }
  return raw.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const text = TABLES[currentLocale()][key] ?? EN[key];
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

/** Plural keys: `${base}.one` / `${base}.other`, with {n} set. */
export function tn(base: string, n: number, vars: Record<string, string | number> = {}): string {
  return t(`${base}.${n === 1 ? 'one' : 'other'}` as Key, { ...vars, n });
}

/** Language name in the UI language, e.g. "de" -> "German" / "Deutsch". */
export function languageName(code: string): string {
  return LANGUAGE_NAMES[currentLocale()][code] || LANGUAGE_NAMES.en[code] || code;
}

/** Quote marks of the UI language around a title. */
export function quoted(text: string): string {
  return currentLocale() === 'de' ? `„${text}“` : `"${text}"`;
}

export const I18N_TABLES = TABLES;
