import * as vscode from 'vscode';
import { findTermAt, TermRef } from './detect';
import { OlsClient, OlsClientOptions, TermInfo } from './olsClient';

const PREFIX_CACHE_KEY = 'ols.knownPrefixes';
const PREFIX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
    cacheTtlMs: cfg.get<number>('cacheTtlMinutes', 60) * 60 * 1000,
  };
}

class PrefixRegistry {
  private fromOls: Map<string, string> | undefined;
  private loading: Promise<void> | undefined;

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

function ontologyWebUrl(ontologyId: string): string {
  return `${readOptions().webBaseUrl.replace(/\/+$/, '')}/ontologies/${encodeURIComponent(ontologyId)}`;
}

function termAtPosition(document: vscode.TextDocument, position: vscode.Position, prefixes: PrefixRegistry) {
  const line = document.lineAt(position.line).text;
  return findTermAt(line, position.character, { knownPrefixes: prefixes.current() });
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('OLS');
  const client = new OlsClient(readOptions);
  const prefixes = new PrefixRegistry(client, context.globalState);
  void prefixes.ensureLoaded();

  const hoverProvider: vscode.HoverProvider = {
    async provideHover(document, position, token) {
      if (!vscode.workspace.getConfiguration('ols').get<boolean>('enabled', true)) {
        return undefined;
      }
      const ref = termAtPosition(document, position, prefixes);
      if (!ref) {
        return undefined;
      }
      const range = new vscode.Range(position.line, ref.start, position.line, ref.end);

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
    vscode.languages.registerHoverProvider('*', hoverProvider),

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
      const ref = termAtPosition(editor.document, editor.selection.active, prefixes);
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
        prefixes.reset();
        void prefixes.ensureLoaded();
      }
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond the subscriptions disposed by VS Code.
}
