import * as vscode from 'vscode';
import { DetectOptions, findAllTerms, findTermAt, TermRef } from './detect';
import { DEFAULT_PREFIXES, DocumentIndex, indexDocument, LocalTerm } from './documentIndex';
import { OlsClient, OlsClientOptions, TermInfo } from './olsClient';

const PREFIX_CACHE_KEY = 'ols.knownPrefixes';
const PREFIX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ONTOLOGY_FILES = '**/*.{obo,ofn,omn,owl,owx,ttl,rq,sparql}';
const MAX_HINT_LABEL_LENGTH = 40;
const MAX_CONCURRENT_HINT_LOOKUPS = 4;

interface PrefixCache {
  apiBaseUrl: string;
  fetchedAt: number;
  entries: [string, string][];
}

let output: vscode.OutputChannel;

function readOptions(): OlsClientOptions {
  const cfg = vscode.workspace.getConfiguration('ols');
  return {
    apiBaseUrl: cfg.get<string>('apiBaseUrl', 'https://www.ebi.ac.uk/ols4/api'),
    webBaseUrl: cfg.get<string>('webBaseUrl', 'https://www.ebi.ac.uk/ols4'),
    language: cfg.get<string>('language', 'en') || 'en',
    timeoutMs: cfg.get<number>('requestTimeoutMs', 8000),
    // At least a minute, so inlay hints don't keep re-requesting the labels they've just fetched.
    cacheTtlMs: Math.max(1, cfg.get<number>('cacheTtlMinutes', 60)) * 60 * 1000,
  };
}

class PrefixRegistry {
  private fromOls: Map<string, string> | undefined;
  private loading: Promise<void> | undefined;
  private readonly loaded = new vscode.EventEmitter<void>();
  /** Fires when the prefix list has been fetched from OLS. */
  readonly onDidLoad = this.loaded.event;

  constructor(
    private readonly client: OlsClient,
    private readonly state: vscode.Memento,
  ) {}

  /** Returns the prefix map to use for detection, or undefined to accept any prefix. */
  current(): Map<string, string> | undefined {
    const cfg = vscode.workspace.getConfiguration('ols');
    if (!cfg.get<boolean>('restrictToKnownPrefixes', true)) {
      return undefined;
    }
    if (!this.fromOls) {
      void this.ensureLoaded();
      // Fall back to accepting any prefix until (or if) the list is available.
      return undefined;
    }
    const map = new Map(this.fromOls);
    for (const p of cfg.get<string[]>('extraPrefixes', [])) {
      if (p) {
        map.set(p.toLowerCase(), p);
      }
    }
    return map;
  }

  ensureLoaded(force = false): Promise<void> {
    if (this.loading) {
      return this.loading;
    }
    const apiBaseUrl = readOptions().apiBaseUrl;
    if (!force) {
      const cached = this.state.get<PrefixCache>(PREFIX_CACHE_KEY);
      if (cached && cached.apiBaseUrl === apiBaseUrl && Date.now() - cached.fetchedAt < PREFIX_CACHE_TTL_MS) {
        this.fromOls = new Map(cached.entries);
        return Promise.resolve();
      }
    }
    this.loading = this.client
      .fetchPrefixes()
      .then(async (map) => {
        this.fromOls = map;
        this.loaded.fire();
        await this.state.update(PREFIX_CACHE_KEY, {
          apiBaseUrl,
          fetchedAt: Date.now(),
          entries: [...map.entries()],
        } satisfies PrefixCache);
        output.appendLine(`Loaded ${map.size} ontology prefixes from ${apiBaseUrl}`);
      })
      .catch((err) => {
        output.appendLine(`Could not load ontology prefixes from ${apiBaseUrl}: ${String(err)}. Accepting any prefix.`);
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  reset(): void {
    this.fromOls = undefined;
  }

  dispose(): void {
    this.loaded.dispose();
  }
}

function isOntologyDocument(document: vscode.TextDocument): boolean {
  const pattern = vscode.workspace.getConfiguration('ols').get<string>('ontologyFiles', DEFAULT_ONTOLOGY_FILES);
  return !!pattern && vscode.languages.match({ pattern }, document) > 0;
}

interface DocumentContext {
  /** Prefixes, labels and definitions from the document, for ontology files only. */
  index?: DocumentIndex;
  detect: DetectOptions;
}

/** What detection needs to know about a document, re-read when the document changes. */
class DocumentContexts {
  private readonly indexes = new Map<string, { version: number; index: DocumentIndex }>();

  constructor(private readonly prefixes: PrefixRegistry) {}

  get(document: vscode.TextDocument): DocumentContext {
    const index = isOntologyDocument(document) ? this.index(document) : undefined;
    const knownPrefixes = this.prefixes.current();
    if (knownPrefixes && index) {
      // Terms an OBO file defines are recognised even when their ontology isn't in OLS.
      for (const p of index.idPrefixes) {
        if (!knownPrefixes.has(p.toLowerCase())) {
          knownPrefixes.set(p.toLowerCase(), p);
        }
      }
    }
    return { index, detect: { knownPrefixes, documentPrefixes: index?.prefixes ?? DEFAULT_PREFIXES } };
  }

  forget(document: vscode.TextDocument): void {
    this.indexes.delete(document.uri.toString());
  }

  clear(): void {
    this.indexes.clear();
  }

  private index(document: vscode.TextDocument): DocumentIndex {
    const key = document.uri.toString();
    const cached = this.indexes.get(key);
    if (cached?.version === document.version) {
      return cached.index;
    }
    const index = indexDocument(document.getText(), readOptions().language);
    this.indexes.set(key, { version: document.version, index });
    return index;
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function buildHover(ref: TermRef, info: TermInfo): vscode.MarkdownString {
  const cfg = vscode.workspace.getConfiguration('ols');
  const md = new vscode.MarkdownString(undefined, true);

  const label = info.label ?? '(no label)';
  const idText = info.curie ?? info.shortForm ?? ref.text;
  const header = `**${escapeMd(label)}** &nbsp; \`${idText}\``;
  md.appendMarkdown(info.isObsolete ? `$(warning) ~~${escapeMd(label)}~~ \`${idText}\` &nbsp; _obsolete_` : header);
  md.appendMarkdown('\n\n');

  const parts = [`${info.type} in [${escapeMd(info.ontologyId)}](${ontologyWebUrl(info.ontologyId)})`];
  if (!info.isDefiningOntology) {
    parts.push('_imported, not the defining ontology_');
  }
  md.appendMarkdown(`${parts.join(' · ')}\n\n`);

  if (cfg.get<boolean>('showDefinition', true) && info.definitions.length > 0) {
    md.appendMarkdown(`${escapeMd(truncate(info.definitions[0], 600))}\n\n`);
  }
  if (cfg.get<boolean>('showSynonyms', true) && info.synonyms.length > 0) {
    const shown = info.synonyms.slice(0, 8).map((s) => escapeMd(truncate(s, 60)));
    const more = info.synonyms.length > 8 ? ` (+${info.synonyms.length - 8} more)` : '';
    md.appendMarkdown(`_Synonyms:_ ${shown.join(', ')}${more}\n\n`);
  }

  md.appendMarkdown(`[Open in OLS](${info.webUrl})`);
  return md;
}

function buildLocalHover(ref: TermRef, term: LocalTerm): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${escapeMd(term.label ?? '(no label)')}** &nbsp; \`${ref.text}\`\n\n_From this file_\n\n`);
  if (vscode.workspace.getConfiguration('ols').get<boolean>('showDefinition', true) && term.definition) {
    md.appendMarkdown(`${escapeMd(truncate(term.definition, 600))}\n\n`);
  }
  return md;
}

function ontologyWebUrl(ontologyId: string): string {
  return `${readOptions().webBaseUrl.replace(/\/+$/, '')}/ontologies/${encodeURIComponent(ontologyId)}`;
}

/** The term reference at a position, with its label and definition if the document gives them. */
function termAtPosition(document: vscode.TextDocument, position: vscode.Position, contexts: DocumentContexts) {
  const { index, detect } = contexts.get(document);
  const ref = findTermAt(document.lineAt(position.line).text, position.character, detect);
  return ref && { ref, local: index?.lookup(ref) };
}

/**
 * Shows each term's label after its identifier in ontology files. Labels the file gives are shown
 * straight away. With ols.inlayHints.lookUpInOls on, other terms are looked up in the background
 * and the hints refresh as their labels arrive.
 */
class LabelHintsProvider implements vscode.InlayHintsProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.changed.event;
  private readonly queue = new Map<string, TermRef>();
  private active = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly client: OlsClient,
    private readonly contexts: DocumentContexts,
  ) {}

  provideInlayHints(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): vscode.InlayHint[] {
    const cfg = vscode.workspace.getConfiguration('ols');
    if (!cfg.get<boolean>('inlayHints.enabled', true) || !isOntologyDocument(document)) {
      return [];
    }
    const lookUpInOls = cfg.get<boolean>('inlayHints.lookUpInOls', false);
    const { index, detect } = this.contexts.get(document);
    const hints: vscode.InlayHint[] = [];

    for (let line = range.start.line; line <= range.end.line && !token.isCancellationRequested; line++) {
      const text = document.lineAt(line).text;
      for (const ref of findAllTerms(text, detect)) {
        let label: string | undefined;
        let tooltip: vscode.MarkdownString | undefined;
        const local = index?.lookup(ref);
        if (local) {
          label = local.label;
          tooltip = buildLocalHover(ref, local);
        } else if (lookUpInOls) {
          const info = this.client.peek(ref);
          if (info === undefined) {
            this.enqueue(ref);
          } else if (info) {
            label = info.label;
            tooltip = buildHover(ref, info);
          }
        }
        // Skip labels the line already spells out, as in OBO's "is_a: EX:0000001 ! widget"
        // or OFN's AnnotationAssertion(rdfs:label obo:EX_0000001 "widget").
        if (!label || text.includes(label, ref.end)) {
          continue;
        }
        const hint = new vscode.InlayHint(new vscode.Position(line, ref.end), `‹${truncate(label, MAX_HINT_LABEL_LENGTH)}›`);
        hint.paddingLeft = true;
        hint.tooltip = tooltip;
        hints.push(hint);
      }
    }
    return hints;
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.changed.dispose();
  }

  private enqueue(ref: TermRef): void {
    this.queue.set(`${ref.kind}|${ref.id}`, ref);
    this.drain();
  }

  private drain(): void {
    for (const [key, ref] of this.queue) {
      if (this.active >= MAX_CONCURRENT_HINT_LOOKUPS) {
        return;
      }
      this.queue.delete(key);
      this.active++;
      this.client
        .lookup(ref)
        .then(
          (info) => {
            if (info) {
              this.scheduleRefresh();
            }
          },
          (err) => output.appendLine(`Lookup failed for ${ref.id}: ${String(err)}`),
        )
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }

  /** Refresh at most a few times a second while results arrive. */
  private scheduleRefresh(): void {
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined;
      this.changed.fire();
    }, 250);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('OLS');
  const client = new OlsClient(readOptions);
  const prefixes = new PrefixRegistry(client, context.globalState);
  const contexts = new DocumentContexts(prefixes);
  const hints = new LabelHintsProvider(client, contexts);
  void prefixes.ensureLoaded();

  const hoverProvider: vscode.HoverProvider = {
    async provideHover(document, position, token) {
      if (!vscode.workspace.getConfiguration('ols').get<boolean>('enabled', true)) {
        return undefined;
      }
      const term = termAtPosition(document, position, contexts);
      if (!term) {
        return undefined;
      }
      const { ref, local } = term;
      const range = new vscode.Range(position.line, ref.start, position.line, ref.end);
      // Terms the file labels itself are never sent to OLS.
      if (local) {
        return new vscode.Hover(buildLocalHover(ref, local), range);
      }

      let info: TermInfo | null;
      try {
        info = await client.lookup(ref);
      } catch (err) {
        output.appendLine(`Lookup failed for ${ref.id}: ${String(err)}`);
        return undefined;
      }
      if (token.isCancellationRequested) {
        return undefined;
      }
      if (!info) {
        // Random URLs are common; only report misses for identifier-shaped references.
        if (ref.kind === 'iri') {
          return undefined;
        }
        return new vscode.Hover(new vscode.MarkdownString(`\`${ref.id}\` — not found in OLS`), range);
      }
      return new vscode.Hover(buildHover(ref, info), range);
    },
  };

  context.subscriptions.push(
    output,
    prefixes,
    hints,
    vscode.languages.registerHoverProvider('*', hoverProvider),
    vscode.languages.registerInlayHintsProvider('*', hints),
    prefixes.onDidLoad(() => hints.refresh()),
    vscode.workspace.onDidCloseTextDocument((document) => contexts.forget(document)),

    vscode.commands.registerCommand('ols.clearCache', () => {
      client.clearCache();
      void vscode.window.setStatusBarMessage('OLS: term cache cleared', 3000);
    }),

    vscode.commands.registerCommand('ols.refreshPrefixes', async () => {
      prefixes.reset();
      await prefixes.ensureLoaded(true);
      void vscode.window.setStatusBarMessage('OLS: ontology prefixes refreshed', 3000);
    }),

    vscode.commands.registerCommand('ols.openTermAtCursor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const ref = termAtPosition(editor.document, editor.selection.active, contexts)?.ref;
      if (!ref) {
        void vscode.window.showInformationMessage('OLS: no ontology term identifier at the cursor.');
        return;
      }
      try {
        const info = await client.lookup(ref);
        if (!info) {
          void vscode.window.showInformationMessage(`OLS: ${ref.id} was not found in OLS.`);
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(info.webUrl));
      } catch (err) {
        void vscode.window.showErrorMessage(`OLS lookup failed: ${String(err)}`);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ols.apiBaseUrl') || e.affectsConfiguration('ols.language')) {
        client.clearCache();
        contexts.clear();
        prefixes.reset();
        void prefixes.ensureLoaded();
      }
      if (e.affectsConfiguration('ols')) {
        hints.refresh();
      }
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond the subscriptions disposed by VS Code.
}
