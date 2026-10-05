const test = require('node:test');
const assert = require('node:assert/strict');
const { indexDocument } = require('../out/documentIndex');
const { findAllTerms } = require('../out/detect');

const OBO = 'http://purl.obolibrary.org/obo/';

function labels(index) {
  return Object.fromEntries([...index.terms].map(([iri, t]) => [iri.replace(OBO, 'obo:'), t.label]));
}

test('OFN: reads prefixes, labels (with axiom annotations) and definitions', () => {
  const index = indexDocument(
    `Prefix(:=<http://example.org/ex#>)
Prefix(obo:=<http://purl.obolibrary.org/obo/>)
Prefix(rdfs:=<http://www.w3.org/2000/01/rdf-schema#>)
Prefix(oboInOwl:=<http://www.geneontology.org/formats/oboInOwl#>)

Ontology(<http://purl.obolibrary.org/obo/ex.owl>
AnnotationAssertion(rdfs:label obo:EX_0000001 "device"@en)
AnnotationAssertion(Annotation(oboInOwl:hasDbXref "PMID:1 (see \\"x\\")") rdfs:label obo:EX_0000002 "widget"@en)
AnnotationAssertion(obo:IAO_0000115 obo:EX_0000002 "A small (moving) part.")
AnnotationAssertion(rdfs:label <http://example.org/ex#gadget> "gadget")
AnnotationAssertion(rdfs:label :gizmo "Gizmo"@de)
AnnotationAssertion(rdfs:label :gizmo "gizmo"@en)
AnnotationAssertion(rdfs:label :gizmo "Gizmo, untagged")
AnnotationAssertion(rdfs:comment obo:EX_0000001 "not a label")
)`,
    'en',
  );
  assert.equal(index.prefixes.get('obo'), OBO);
  assert.equal(index.prefixes.get(''), 'http://example.org/ex#');
  assert.deepEqual(labels(index), {
    'obo:EX_0000001': 'device',
    'obo:EX_0000002': 'widget',
    'http://example.org/ex#gadget': 'gadget',
    'http://example.org/ex#gizmo': 'gizmo',
  });
  assert.equal(index.terms.get(`${OBO}EX_0000002`).definition, 'A small (moving) part.');
});

test('Turtle: follows ; and , lists, blank nodes, collections and long strings', () => {
  const index = indexDocument(
    `@prefix obo: <http://purl.obolibrary.org/obo/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
PREFIX owl: <http://www.w3.org/2002/07/owl#>

###  http://purl.obolibrary.org/obo/EX_0000003
obo:EX_0000003 a owl:Class ;
    rdfs:subClassOf [ a owl:Restriction ;
                      owl:onProperty obo:BFO_0000051 ;
                      owl:someValuesFrom obo:EX_0000002 ] ;
    owl:equivalentClass [ owl:intersectionOf ( obo:EX_0000001 [ rdfs:label "not mine" ] ) ] ;
    obo:IAO_0000115 """A widget assembly.
Spans lines."""@en ;
    obo:EX_9999999 1.5, "x" ;
    rdfs:label "widget assembly"@en, "Widget-Baugruppe"@de .
<http://purl.obolibrary.org/obo/EX_0000002> rdfs:label 'widget' .
[] rdfs:label "anonymous" .
obo:EX_0000001 rdfs:label "device"^^<http://www.w3.org/2001/XMLSchema#string>.
`,
    'en',
  );
  assert.deepEqual(labels(index), {
    'obo:EX_0000003': 'widget assembly',
    'obo:EX_0000002': 'widget',
    'obo:EX_0000001': 'device',
  });
  assert.equal(index.terms.get(`${OBO}EX_0000003`).definition, 'A widget assembly.\nSpans lines.');
});

test('OBO: reads id, name and def, stripping comments and qualifiers', () => {
  const index = indexDocument(
    `format-version: 1.2
ontology: ex

[Term]
id: EX:0000001
name: device {source="x"} ! a comment
def: "A thing that does \\"stuff\\"." [PMID:1]

[Term]
id: EX:0000002
name: widget
is_a: EX:0000001 ! device

[Typedef]
id: part_of
name: part of
`,
    'en',
  );
  assert.deepEqual(labels(index), { 'obo:EX_0000001': 'device', 'obo:EX_0000002': 'widget' });
  assert.equal(index.terms.get(`${OBO}EX_0000001`).definition, 'A thing that does "stuff".');
  assert.deepEqual([...index.idPrefixes], ['EX']);
});

test('looks up detected references of every kind', () => {
  const index = indexDocument('[Term]\nid: EX:0000001\nname: device\n', 'en');
  const known = new Map([['ex', 'EX']]);
  const line = 'EX:0000001 EX_0000001 obo:EX_0000001 <http://purl.obolibrary.org/obo/EX_0000001>';
  const refs = findAllTerms(line, { knownPrefixes: known, documentPrefixes: index.prefixes });
  assert.deepEqual(
    refs.map((r) => [r.kind, index.lookup(r)?.label]),
    [
      ['curie', 'device'],
      ['shortForm', 'device'],
      ['prefixedName', 'device'],
      ['iri', 'device'],
    ],
  );
});

test('does not read labels from RDF/XML or Manchester syntax', () => {
  const xml = '<?xml version="1.0"?>\n<rdf:RDF><owl:Class rdf:about="http://x/A"><rdfs:label>a</rdfs:label></owl:Class></rdf:RDF>';
  const omn = 'Prefix: obo: <http://purl.obolibrary.org/obo/>\nOntology: <http://x>\nClass: obo:EX_1\n  Annotations: rdfs:label "x"';
  assert.equal(indexDocument(xml, 'en').terms.size, 0);
  const manchester = indexDocument(omn, 'en');
  assert.equal(manchester.terms.size, 0);
  assert.equal(manchester.prefixes.get('obo'), OBO);
});
