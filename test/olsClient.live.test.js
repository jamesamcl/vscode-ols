// Live smoke test against the public OLS4 API. Skipped when OLS_LIVE=0.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OlsClient, termWebUrl } = require('../out/olsClient');

const skip = process.env.OLS_LIVE === '0';
const client = new OlsClient(() => ({
  apiBaseUrl: 'https://www.ebi.ac.uk/ols4/api',
  webBaseUrl: 'https://www.ebi.ac.uk/ols4',
  language: 'en',
  timeoutMs: 15000,
  cacheTtlMs: 60000,
}));

test('looks up a class by CURIE from its defining ontology', { skip }, async () => {
  const info = await client.lookup({ kind: 'curie', id: 'UBERON:0000955', text: 'UBERON:0000955', start: 0, end: 14 });
  assert.equal(info.label, 'brain');
  assert.equal(info.ontologyId, 'uberon');
  assert.equal(info.type, 'class');
  assert.equal(info.isDefiningOntology, true);
  assert.ok(info.definitions[0].startsWith('The brain'));
  assert.ok(info.synonyms.includes('encephalon'));
  assert.equal(
    info.webUrl,
    'https://www.ebi.ac.uk/ols4/ontologies/uberon/classes/http%253A%252F%252Fpurl.obolibrary.org%252Fobo%252FUBERON_0000955',
  );
});

test('looks up a property by short form and an obsolete term by IRI', { skip }, async () => {
  const ro = await client.lookup({ kind: 'shortForm', id: 'RO_0002202', text: 'RO_0002202', start: 0, end: 10 });
  assert.equal(ro.label, 'develops from');
  assert.equal(ro.type, 'property');

  const efo = await client.lookup({
    kind: 'iri', id: 'http://www.ebi.ac.uk/efo/EFO_0000400', text: '', start: 0, end: 0,
  });
  assert.equal(efo.ontologyId, 'efo');
  assert.equal(efo.isObsolete, true);
});

test('returns null for unknown identifiers and caches results', { skip }, async () => {
  const ref = { kind: 'curie', id: 'GO:9999999', text: 'GO:9999999', start: 0, end: 10 };
  assert.equal(await client.lookup(ref), null);
  assert.equal(client.lookup(ref), client.lookup(ref)); // same cached promise
});

test('looks up prefixed names by IRI and peeks at finished lookups', { skip }, async () => {
  const ref = {
    kind: 'prefixedName', id: 'http://purl.obolibrary.org/obo/BFO_0000051', text: 'obo:BFO_0000051', start: 0, end: 15,
  };
  assert.equal(client.peek(ref), undefined);
  const pending = client.lookup(ref);
  assert.equal(client.peek(ref), undefined);
  assert.equal((await pending).label, 'has part');
  assert.equal(client.peek(ref).label, 'has part');
});

test('fetches ontology prefixes', { skip }, async () => {
  const prefixes = await client.fetchPrefixes();
  assert.ok(prefixes.size > 100);
  assert.equal(prefixes.get('go'), 'GO');
  assert.equal(prefixes.get('ncbitaxon'), 'NCBITaxon');
});

test('builds web URLs per entity type', () => {
  assert.equal(
    termWebUrl('https://www.ebi.ac.uk/ols4/', 'ro', 'property', 'http://purl.obolibrary.org/obo/RO_0002202'),
    'https://www.ebi.ac.uk/ols4/ontologies/ro/properties/http%253A%252F%252Fpurl.obolibrary.org%252Fobo%252FRO_0002202',
  );
});
