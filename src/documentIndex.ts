/**
 * Pure (vscode-independent) extraction of prefix declarations and term labels/definitions from
 * ontology source text, so terms a file defines can be shown without asking OLS.
 *
 * Supported:
 *   - Prefixes: OFN Prefix(obo:=<...>), Turtle @prefix, SPARQL PREFIX, Manchester Prefix:
 *   - Labels and definitions (rdfs:label, IAO:0000115):
 *       OFN      AnnotationAssertion([Annotation(...)] rdfs:label <subject> "label"@en)
 *       Turtle   <subject> rdfs:label "label" triples, including ; and , lists and [ ] nesting
 *       OBO      id: / name: / def: in [Term], [Typedef] and [Instance] stanzas
 */
import type { TermRef } from './detect';

const OBO_PURL = 'http://purl.obolibrary.org/obo/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const IAO_DEFINITION = `${OBO_PURL}IAO_0000115`;

/** Prefixes understood in every document: those OWL functional syntax predefines, plus obo. */
export const DEFAULT_PREFIXES: ReadonlyMap<string, string> = new Map([
  ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
  ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
  ['owl', 'http://www.w3.org/2002/07/owl#'],
  ['obo', OBO_PURL],
]);

export interface LocalTerm {
  label?: string;
  definition?: string;
}

export class DocumentIndex {
  /** Prefix name -> namespace IRI, including DEFAULT_PREFIXES unless the document redeclares them. */
  readonly prefixes = new Map<string, string>(DEFAULT_PREFIXES);
  /** Term IRI -> label and definition given in the document. */
  readonly terms = new Map<string, LocalTerm>();
  /** ID prefixes of the terms an OBO file defines (EX for EX:0000001), so they're detected even if OLS doesn't know them. */
  readonly idPrefixes = new Set<string>();

  private readonly ranks = new Map<string, number>();

  constructor(private readonly language: string) {}

  lookup(ref: TermRef): LocalTerm | undefined {
    switch (ref.kind) {
      case 'iri':
      case 'prefixedName':
        return this.terms.get(ref.id);
      case 'curie':
        return this.terms.get(`${OBO_PURL}${ref.prefix}_${ref.local}`);
      case 'shortForm':
        return this.terms.get(`${OBO_PURL}${ref.id}`);
    }
  }

  /** Expand an IRI reference (<...>) or prefixed name to an IRI. */
  expand(term: string): string | undefined {
    if (term.startsWith('<')) {
      return term.slice(1, -1);
    }
    const colon = term.indexOf(':');
    const namespace = colon < 0 ? undefined : this.prefixes.get(term.slice(0, colon));
    return namespace === undefined ? undefined : namespace + term.slice(colon + 1);
  }

  /** Record an annotation if it's a label or definition, keeping the value in the preferred language. */
  annotate(subject: string, property: string, value: string, lang?: string): void {
    const field = property === RDFS_LABEL ? 'label' : property === IAO_DEFINITION ? 'definition' : undefined;
    if (!field) {
      return;
    }
    // Preferred language first, then untagged, then anything else.
    const wanted = this.language.toLowerCase();
    const tag = lang?.toLowerCase();
    const rank = tag === undefined ? 1 : tag === wanted || tag.startsWith(`${wanted}-`) ? 2 : 0;
    const rankKey = `${field} ${subject}`;
    if ((this.ranks.get(rankKey) ?? -1) >= rank) {
      return;
    }
    this.ranks.set(rankKey, rank);
    const term = this.terms.get(subject) ?? {};
    term[field] = value;
    this.terms.set(subject, term);
  }
}

/** Index a document's prefixes and the labels and definitions it gives. `language` is the preferred label language. */
export function indexDocument(text: string, language: string): DocumentIndex {
  const index = new DocumentIndex(language);
  for (const m of text.matchAll(PREFIX_RE)) {
    index.prefixes.set(m[1] ?? '', m[2]);
  }
  if (/^\s*(?:<\?xml|<rdf:RDF)/.test(text)) {
    // RDF/XML and OWL/XML: labels aren't read.
  } else if (/^\s*Ontology\(/m.test(text)) {
    indexOfn(text, index);
  } else if (/^(?:format-version:|\[(?:Term|Typedef|Instance)\])/m.test(text)) {
    indexObo(text, index);
  } else if (!/^\s*(?:Ontology|Class|ObjectProperty):/m.test(text)) {
    // Anything but Manchester syntax is read as Turtle (which also covers SPARQL well enough).
    indexTurtle(text, index);
  }
  return index;
}

// OFN Prefix(obo:=<...>), Turtle @prefix obo: <...> ., SPARQL PREFIX obo: <...>, Manchester Prefix: obo: <...>
const PREFIX_RE = /(?:@prefix|\bPREFIX\b:?|\bPrefix\()\s*([A-Za-z][\w.-]*)?:\s*=?\s*<([^<>\s]*)>/gi;

const STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const NAME = String.raw`<[^<>\s]*>|(?:[A-Za-z][\w.-]*)?:[\w.-]*`;
const OBO_DEF = new RegExp(`^${STRING}`);

// AnnotationAssertion, skipping any axiom annotations, then property, subject and a literal value.
const OFN_ANNOTATION_ASSERTION = new RegExp(
  String.raw`AnnotationAssertion\(\s*(?:Annotation\((?:[^()"]|${STRING})*\)\s*)*(${NAME})\s+(${NAME})\s+(${STRING})(?:@([\w-]+))?`,
  'g',
);

function indexOfn(text: string, index: DocumentIndex): void {
  for (const m of text.matchAll(OFN_ANNOTATION_ASSERTION)) {
    const property = index.expand(m[1]);
    const subject = index.expand(m[2]);
    if (property && subject) {
      index.annotate(subject, property, unescapeString(m[3].slice(1, -1)), m[4]);
    }
  }
}

function indexObo(text: string, index: DocumentIndex): void {
  let id: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      id = undefined;
      continue;
    }
    const m = /^(id|name|def):\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    if (m[1] === 'id') {
      // Only prefixed IDs (EX:0000001) map to OBO PURLs; relation names like part_of don't.
      const prefixed = /^([A-Za-z][A-Za-z0-9_]*):(\S+)/.exec(m[2]);
      id = prefixed ? `${OBO_PURL}${prefixed[1]}_${prefixed[2]}` : undefined;
      if (prefixed) {
        index.idPrefixes.add(prefixed[1]);
      }
    } else if (id && m[1] === 'name') {
      // Drop a trailing comment and {qualifiers}.
      const name = m[2].replace(/\s+!.*$/, '').replace(/\s*\{[^}]*\}\s*$/, '').trim();
      index.annotate(id, RDFS_LABEL, unescapeString(name));
    } else if (id && m[1] === 'def') {
      const def = OBO_DEF.exec(m[2]);
      if (def) {
        index.annotate(id, IAO_DEFINITION, unescapeString(def[0].slice(1, -1)));
      }
    }
  }
}

const TURTLE_TOKEN = new RegExp(
  [
    String.raw`(\s+|#[^\r\n]*)`, // 1: whitespace, comment
    String.raw`(<[^<>"{}|^\x60\\\s]*>)`, // 2: IRI
    // 3: string, 4: language tag (a datatype is matched and ignored)
    String.raw`("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')(?:@([A-Za-z]+(?:-[A-Za-z0-9]+)*)|\^\^(?:<[^<>\s]*>|(?:[A-Za-z][\w.-]*)?:[\w-]*(?:\.[\w-]+)*))?`,
    String.raw`(@[A-Za-z]+)`, // 5: @prefix, @base
    String.raw`((?:[A-Za-z][\w.-]*)?:(?:[\w-]+(?:\.[\w-]+)*)?)`, // 6: prefixed name
    String.raw`[+-]?\d+\.\d+(?:[eE][+-]?\d+)?`, // decimal, so its '.' doesn't end the statement
    String.raw`([;,.\[\]()])`, // 7: punctuation
    String.raw`([^\s;,.\[\]()<>"']+)`, // 8: a, true, numbers, _:b0, PREFIX, SPARQL variables, ...
  ].join('|'),
  'y',
);

interface TurtleFrame {
  state: 'subject' | 'predicate' | 'object' | 'afterObject' | 'collection';
  subject?: string;
  predicate?: string;
}

/**
 * Walk Turtle statements just far enough to see each subject, predicate and literal object.
 * Anything it doesn't understand resets it to the start of a statement.
 */
function indexTurtle(text: string, index: DocumentIndex): void {
  const stack: TurtleFrame[] = [{ state: 'subject' }];
  let inDirective = false;

  /** A term (IRI, prefixed name, literal, blank node, ...) in the current position. */
  const term = (iri: string | undefined, literal?: { value: string; lang?: string }) => {
    const frame = stack[stack.length - 1];
    switch (frame.state) {
      case 'subject':
      case 'afterObject': // missing '.': treat it as a new statement
        frame.subject = literal ? undefined : iri;
        frame.state = 'predicate';
        break;
      case 'predicate':
        frame.predicate = iri;
        frame.state = 'object';
        break;
      case 'object':
        if (literal && frame.subject && frame.predicate) {
          index.annotate(frame.subject, frame.predicate, literal.value, literal.lang);
        }
        frame.state = 'afterObject';
        break;
      // Members of a (collection) are ignored.
    }
  };

  for (let pos = 0; pos < text.length; ) {
    TURTLE_TOKEN.lastIndex = pos;
    const m = TURTLE_TOKEN.exec(text);
    if (!m) {
      pos++;
      continue;
    }
    pos = TURTLE_TOKEN.lastIndex;
    if (m[1] !== undefined) {
      continue;
    }
    const word = m[8] ?? m[5];
    if (word && /^@?(?:prefix|base)$/i.test(word)) {
      inDirective = true;
      continue;
    }
    if (inDirective) {
      // Prefixes were read up front; skip to the end of the directive's IRI.
      inDirective = m[2] === undefined;
      continue;
    }

    const frame = stack[stack.length - 1];
    if (m[2] !== undefined || m[6] !== undefined) {
      term(index.expand(m[2] ?? m[6]));
    } else if (m[3] !== undefined) {
      term(undefined, { value: unescapeString(m[3].replace(/^("""|'''|"|')([\s\S]*)\1$/, '$2')), lang: m[4] });
    } else if (m[7] === '[') {
      stack.push({ state: 'predicate' });
    } else if (m[7] === '(') {
      stack.push({ state: 'collection' });
    } else if ((m[7] === ']' || m[7] === ')') && stack.length > 1) {
      stack.pop();
      term(undefined);
    } else if (m[7] === ';' && (frame.state === 'afterObject' || frame.state === 'predicate')) {
      frame.state = 'predicate';
    } else if (m[7] === ',' && frame.state === 'afterObject') {
      frame.state = 'object';
    } else if (m[7] === '.') {
      stack.length = 1;
      stack[0] = { state: 'subject' };
    } else if (m[7] === undefined) {
      term(undefined); // a, numbers, booleans, blank node labels
    }
  }
}

function unescapeString(s: string): string {
  return s.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_, u4, u8, c) => {
    if (u4 || u8) {
      return String.fromCodePoint(parseInt(u4 ?? u8, 16));
    }
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c;
  });
}
