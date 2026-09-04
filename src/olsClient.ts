/**
 * Minimal client for the OLS4 REST API. Deliberately free of any 'vscode' import so
 * it can be exercised from plain Node tests.
 */
import type { TermRef } from './detect';

export interface OlsClientOptions {
  apiBaseUrl: string;
  webBaseUrl: string;
  language: string;
  timeoutMs: number;
  cacheTtlMs: number;
}

export type EntityType = 'class' | 'property' | 'individual';

export interface TermInfo {
  iri: string;
  curie?: string;
  shortForm?: string;
  label?: string;
  definitions: string[];
  synonyms: string[];
  ontologyId: string;
  type: EntityType;
  isObsolete: boolean;
  /** True when the term came from the ontology that defines it (rather than an importer). */
  isDefiningOntology: boolean;
  webUrl: string;
}

/** OLS4 v2 values may be a string, an object with a `value`, or an array of either. */
type OlsValue = string | { value?: unknown } | OlsValue[] | null | undefined;

function asStrings(v: OlsValue): string[] {
  if (v === null || v === undefined) {
    return [];
  }
  if (typeof v === 'string') {
    return [v];
  }
  if (Array.isArray(v)) {
    return v.flatMap(asStrings);
  }
  if (typeof v === 'object' && 'value' in v) {
    return asStrings(v.value as OlsValue);
  }
  return [];
}

function firstString(v: OlsValue): string | undefined {
  return asStrings(v)[0];
}

interface CacheEntry {
  expires: number;
  value: Promise<TermInfo | null>;
}

const NEGATIVE_TTL_MS = 5 * 60 * 1000;

export class OlsClient {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly getOptions: () => OlsClientOptions) {}

  clearCache(): void {
    this.cache.clear();
  }

  /** Look up a term reference, returning null when OLS knows nothing about it. */
  lookup(ref: TermRef): Promise<TermInfo | null> {
    const opts = this.getOptions();
    const key = `${opts.apiBaseUrl}|${opts.language}|${ref.kind}|${ref.id}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) {
      return cached.value;
    }

    const value = this.doLookup(ref, opts).then(
      (info) => {
        // Re-set with a shorter TTL for negatives so transient failures don't stick.
        this.cache.set(key, {
          expires: Date.now() + (info ? opts.cacheTtlMs : NEGATIVE_TTL_MS),
          value: Promise.resolve(info),
        });
        return info;
      },
      (err) => {
        this.cache.delete(key);
        throw err;
      },
    );
    this.cache.set(key, { expires: now + Math.max(opts.cacheTtlMs, NEGATIVE_TTL_MS), value });
    return value;
  }

  private async doLookup(ref: TermRef, opts: OlsClientOptions): Promise<TermInfo | null> {
    const param = ref.kind === 'iri' ? 'iri' : ref.kind === 'curie' ? 'curie' : 'shortForm';
    const base = `${opts.apiBaseUrl.replace(/\/+$/, '')}/v2/entities`;
    const params = new URLSearchParams({ [param]: ref.id, size: '1', lang: opts.language, includeObsoleteEntities: 'true' });

    // Prefer the ontology that defines the term; fall back to any ontology that imports it.
    const defining = await this.fetchEntities(`${base}?${params}&isDefiningOntology=true`, opts);
    if (defining.length > 0) {
      return this.toTermInfo(defining[0], true, opts);
    }
    const any = await this.fetchEntities(`${base}?${params}`, opts);
    if (any.length > 0) {
      return this.toTermInfo(any[0], false, opts);
    }
    return null;
  }

  private async fetchEntities(url: string, opts: OlsClientOptions): Promise<Record<string, OlsValue>[]> {
    const body = (await this.getJson(url, opts)) as { elements?: Record<string, OlsValue>[] } | null;
    return body?.elements ?? [];
  }

  /**
   * Fetch the prefixes of all ontologies in OLS. Returns a map of lower-cased
   * prefix -> canonical prefix, including both the ontology id and its preferred prefix.
   */
  async fetchPrefixes(): Promise<Map<string, string>> {
    const opts = this.getOptions();
    const base = `${opts.apiBaseUrl.replace(/\/+$/, '')}/ontologies`;
    const prefixes = new Map<string, string>();
    for (let page = 0, totalPages = 1; page < totalPages && page < 50; page++) {
      const body = (await this.getJson(`${base}?size=1000&page=${page}`, opts)) as {
        _embedded?: { ontologies?: { ontologyId?: string; config?: { preferredPrefix?: string } }[] };
        page?: { totalPages?: number };
      } | null;
      totalPages = body?.page?.totalPages ?? 1;
      for (const o of body?._embedded?.ontologies ?? []) {
        const preferred = o.config?.preferredPrefix;
        const id = o.ontologyId;
        if (preferred) {
          prefixes.set(preferred.toLowerCase(), preferred);
        }
        if (id && !prefixes.has(id.toLowerCase())) {
          prefixes.set(id.toLowerCase(), preferred ?? id);
        }
      }
    }
    if (prefixes.size === 0) {
      throw new Error(`OLS returned no ontologies from ${base}`);
    }
    return prefixes;
  }

  private async getJson(url: string, opts: OlsClientOptions): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'vscode-ols-hover' },
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`OLS request failed: ${res.status} ${res.statusText} (${url})`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private toTermInfo(e: Record<string, OlsValue>, isDefiningOntology: boolean, opts: OlsClientOptions): TermInfo {
    const types = asStrings(e.type);
    const type: EntityType = types.includes('property')
      ? 'property'
      : types.includes('individual')
        ? 'individual'
        : 'class';
    const iri = firstString(e.iri) ?? '';
    const ontologyId = firstString(e.ontologyId) ?? '';
    return {
      iri,
      curie: firstString(e.curie),
      shortForm: firstString(e.shortForm),
      label: firstString(e.label),
      definitions: asStrings(e.definition),
      synonyms: asStrings(e.synonym),
      ontologyId,
      type,
      isObsolete: (e.isObsolete as unknown) === true,
      isDefiningOntology,
      webUrl: termWebUrl(opts.webBaseUrl, ontologyId, type, iri),
    };
  }
}

/** OLS4 web UI URL for a term. The IRI is double-encoded, as the OLS4 frontend expects. */
export function termWebUrl(webBaseUrl: string, ontologyId: string, type: EntityType, iri: string): string {
  const section = type === 'property' ? 'properties' : type === 'individual' ? 'individuals' : 'classes';
  return `${webBaseUrl.replace(/\/+$/, '')}/ontologies/${encodeURIComponent(ontologyId)}/${section}/${encodeURIComponent(encodeURIComponent(iri))}`;
}
