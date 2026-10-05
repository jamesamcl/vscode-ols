/**
 * Pure (vscode-independent) detection of ontology term identifiers in a line of text.
 *
 * Recognised forms:
 *   - IRIs:            http://purl.obolibrary.org/obo/GO_0008150, http://www.ebi.ac.uk/efo/EFO_0000400
 *   - CURIEs:          GO:0008150, NCBITaxon:9606, EDAM:data_0006, APOLLO_SV:00000001
 *   - OBO short forms: GO_0008150, NCBITaxon_9606, EDAM_data_0006, APOLLO_SV_00000001
 *   - Prefixed names:  obo:GO_0008150, ex:widget, using prefixes the document declares
 */

export type TermKind = 'iri' | 'curie' | 'shortForm' | 'prefixedName';

export interface TermRef {
  kind: TermKind;
  /**
   * The identifier as it should be sent to OLS (prefix casing normalised where known).
   * For a prefixed name this is the expanded IRI.
   */
  id: string;
  /** The text exactly as it appears in the document. */
  text: string;
  /** Start column (inclusive). */
  start: number;
  /** End column (exclusive). */
  end: number;
  prefix?: string;
  local?: string;
}

export interface DetectOptions {
  /**
   * Map of lower-cased prefix -> canonical prefix. When provided, CURIEs and short
   * forms are only recognised if their prefix is in the map. When undefined, any
   * prefix is accepted.
   */
  knownPrefixes?: Map<string, string>;
  /**
   * Prefixes declared by the document (Prefix(obo:=<...>) in OFN, @prefix in Turtle), as
   * prefix name -> namespace IRI. Names using them are expanded to IRIs, whether or not the
   * prefix is in knownPrefixes.
   */
  documentPrefixes?: ReadonlyMap<string, string>;
}

const IRI_RE = /https?:\/\/[^\s<>"'`\\\[\]{}|]+/g;
const IRI_TRAILING_PUNCT = /[.,;:!?'"]+$/;

// PREFIX:LOCAL where LOCAL ends with a digit (GO:0008150, NCIT:C12345, EDAM:data_0006). Not preceded by a word char,
// ':' (std::x), or '/' (URLs); not followed by a word char, ':' or '.word' (arXiv:2301.12345).
const CURIE_RE = /(?<![\w:/])([A-Za-z][A-Za-z0-9_]*):([A-Za-z0-9_]*\d)(?![\w:]|\.\w)/g;

// Underscore-separated token starting with a letter, containing at least one '_'
// and ending with a digit (GO_0008150, EDAM_data_0006).
const SHORT_FORM_RE = /(?<![\w:/])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?![\w:]|\.\w)/g;

// Turtle/OFN prefixed name (obo:GO_0008150, :widget). The local part may contain dots but not end with one.
const PREFIXED_NAME_RE = /(?<![\w:/.-])([A-Za-z][\w.-]*)?:(\w(?:[\w.-]*[\w-])?)(?![\w:])/g;

// RDF, RDFS, OWL and XSD vocabulary (rdfs:label, owl:Thing) isn't worth looking up.
const BUILTIN_NAMESPACES = [
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/2000/01/rdf-schema#',
  'http://www.w3.org/2002/07/owl#',
  'http://www.w3.org/2001/XMLSchema#',
  'http://www.w3.org/XML/1998/namespace',
];

function trimIri(text: string): string {
  let t = text.replace(IRI_TRAILING_PUNCT, '');
  // Drop unbalanced trailing parentheses, e.g. "(see http://x/y)".
  while (t.endsWith(')') && (t.match(/\(/g) ?? []).length < (t.match(/\)/g) ?? []).length) {
    t = t.slice(0, -1).replace(IRI_TRAILING_PUNCT, '');
  }
  return t;
}

function resolvePrefix(prefix: string, opts: DetectOptions): string | undefined {
  if (!opts.knownPrefixes) {
    return prefix;
  }
  return opts.knownPrefixes.get(prefix.toLowerCase());
}

function overlaps(refs: TermRef[], start: number, end: number): boolean {
  return refs.some((r) => start < r.end && end > r.start);
}

/** Find every term reference on a line, non-overlapping, ordered by start column. */
export function findAllTerms(line: string, opts: DetectOptions = {}): TermRef[] {
  const refs: TermRef[] = [];

  for (const m of line.matchAll(IRI_RE)) {
    const text = trimIri(m[0]);
    if (text.length <= 'http://'.length) {
      continue;
    }
    refs.push({ kind: 'iri', id: text, text, start: m.index!, end: m.index! + text.length });
  }

  if (opts.documentPrefixes) {
    for (const m of line.matchAll(PREFIXED_NAME_RE)) {
      const start = m.index!;
      const end = start + m[0].length;
      const namespace = opts.documentPrefixes.get(m[1] ?? '');
      if (namespace === undefined || overlaps(refs, start, end)) {
        continue;
      }
      const iri = namespace + m[2];
      if (BUILTIN_NAMESPACES.some((ns) => iri.startsWith(ns))) {
        continue;
      }
      refs.push({ kind: 'prefixedName', id: iri, text: m[0], start, end });
    }
  }

  for (const m of line.matchAll(CURIE_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (overlaps(refs, start, end)) {
      continue;
    }
    const canonical = resolvePrefix(m[1], opts);
    if (!canonical) {
      continue;
    }
    const local = m[2].replace(/_+$/, '');
    if (!/\d/.test(local)) {
      continue;
    }
    const text = `${m[1]}:${local}`;
    refs.push({
      kind: 'curie',
      id: `${canonical}:${local}`,
      text,
      start,
      end: start + text.length,
      prefix: canonical,
      local,
    });
  }

  for (const m of line.matchAll(SHORT_FORM_RE)) {
    const start = m.index!;
    const token = m[1];
    const end = start + token.length;
    if (overlaps(refs, start, end)) {
      continue;
    }
    const split = splitShortForm(token, opts);
    if (!split) {
      continue;
    }
    refs.push({
      kind: 'shortForm',
      id: `${split.prefix}_${split.local}`,
      text: token,
      start,
      end,
      prefix: split.prefix,
      local: split.local,
    });
  }

  return refs.sort((a, b) => a.start - b.start);
}

/**
 * Split an underscore token into prefix + local part. Prefixes may themselves
 * contain underscores (APOLLO_SV_00000001), so when a known-prefix map is given
 * every split point is tried; otherwise the first underscore is used.
 */
function splitShortForm(token: string, opts: DetectOptions): { prefix: string; local: string } | undefined {
  const segments = token.split('_');
  if (!/\d$/.test(token)) {
    return undefined;
  }
  for (let i = 1; i < segments.length; i++) {
    const rawPrefix = segments.slice(0, i).join('_');
    const local = segments.slice(i).join('_');
    if (!/\d/.test(local)) {
      break;
    }
    const canonical = resolvePrefix(rawPrefix, opts);
    if (canonical) {
      return { prefix: canonical, local };
    }
    if (!opts.knownPrefixes) {
      return { prefix: rawPrefix, local };
    }
  }
  return undefined;
}

/** Find the term reference (if any) that contains the given column. */
export function findTermAt(line: string, column: number, opts: DetectOptions = {}): TermRef | undefined {
  return findAllTerms(line, opts).find((r) => column >= r.start && column <= r.end);
}
