const test = require('node:test');
const assert = require('node:assert/strict');
const { findAllTerms, findTermAt } = require('../out/detect');

const known = new Map([
  ['go', 'GO'],
  ['efo', 'EFO'],
  ['ncbitaxon', 'NCBITaxon'],
  ['edam', 'EDAM'],
  ['apollo_sv', 'APOLLO_SV'],
  ['mondo', 'MONDO'],
]);

function ids(line, opts) {
  return findAllTerms(line, opts).map((r) => `${r.kind}:${r.id}`);
}

test('detects CURIEs and OBO short forms with known prefixes', () => {
  assert.deepEqual(ids('term GO:0008150 and GO_0008150 here', { knownPrefixes: known }), [
    'curie:GO:0008150',
    'shortForm:GO_0008150',
  ]);
});

test('normalises prefix casing to the canonical OLS prefix', () => {
  const [a, b] = findAllTerms('go:0008150 ncbitaxon_9606', { knownPrefixes: known });
  assert.equal(a.id, 'GO:0008150');
  assert.equal(a.text, 'go:0008150');
  assert.equal(b.id, 'NCBITaxon_9606');
  assert.equal(b.text, 'ncbitaxon_9606');
});

test('ignores unknown prefixes when restricted, accepts them when not', () => {
  assert.deepEqual(ids('FOO:12345 FOO_12345', { knownPrefixes: known }), []);
  assert.deepEqual(ids('FOO:12345 FOO_12345'), ['curie:FOO:12345', 'shortForm:FOO_12345']);
});

test('handles prefixes containing underscores and locals with letters', () => {
  assert.deepEqual(ids('APOLLO_SV:00000001 APOLLO_SV_00000001 EDAM:data_0006 EDAM_data_0006', { knownPrefixes: known }), [
    'curie:APOLLO_SV:00000001',
    'shortForm:APOLLO_SV_00000001',
    'curie:EDAM:data_0006',
    'shortForm:EDAM_data_0006',
  ]);
});

test('detects IRIs and does not also match the short form inside them', () => {
  const line = 'see <http://purl.obolibrary.org/obo/GO_0008150> and http://www.ebi.ac.uk/efo/EFO_0000400.';
  assert.deepEqual(ids(line, { knownPrefixes: known }), [
    'iri:http://purl.obolibrary.org/obo/GO_0008150',
    'iri:http://www.ebi.ac.uk/efo/EFO_0000400',
  ]);
});

test('trims trailing punctuation and unbalanced parentheses from IRIs', () => {
  assert.deepEqual(ids('(http://purl.obolibrary.org/obo/GO_0008150), http://example.org/x(y)'), [
    'iri:http://purl.obolibrary.org/obo/GO_0008150',
    'iri:http://example.org/x(y)',
  ]);
});

test('does not match common false positives', () => {
  const noise = [
    'at 12:30 today',
    'std::vector<int> v;',
    'C:\\Users\\x',
    'sha256:abc123',
    'arXiv:2301.12345',
    'MY_CONSTANT_VALUE',
    'x_GO_0008150',          // preceded by a word char
    'GO:0008150x',           // followed by a word char
    'a:b:GO:0008150',        // chained colons
    'key: 12345',
  ];
  for (const line of noise) {
    assert.deepEqual(ids(line, { knownPrefixes: known }), [], line);
  }
});

test('findTermAt returns the reference containing the column, inclusive of its end', () => {
  const line = 'x = "MONDO:0005015"; # y';
  const start = line.indexOf('MONDO');
  assert.equal(findTermAt(line, start, { knownPrefixes: known }).id, 'MONDO:0005015');
  assert.equal(findTermAt(line, start + 5, { knownPrefixes: known }).id, 'MONDO:0005015');
  assert.equal(findTermAt(line, start + 'MONDO:0005015'.length, { knownPrefixes: known }).id, 'MONDO:0005015');
  assert.equal(findTermAt(line, 0, { knownPrefixes: known }), undefined);
  assert.equal(findTermAt(line, line.length, { knownPrefixes: known }), undefined);
});

test('reports correct ranges', () => {
  const line = 'GO:0008150, then GO_0016020!';
  const [a, b] = findAllTerms(line);
  assert.equal(line.slice(a.start, a.end), 'GO:0008150');
  assert.equal(line.slice(b.start, b.end), 'GO_0016020');
});
