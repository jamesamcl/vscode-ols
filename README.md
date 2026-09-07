# OLS Term Hover

Hover over an ontology term identifier in **any** file and see its label, definition and synonyms from the [EMBL-EBI Ontology Lookup Service (OLS)](https://www.ebi.ac.uk/ols4).

Recognised identifier forms:

| Form | Example |
| --- | --- |
| IRI | `http://purl.obolibrary.org/obo/GO_0008150`, `http://www.ebi.ac.uk/efo/EFO_0000400` |
| CURIE | `GO:0008150`, `NCBITaxon:9606`, `EDAM:data_0006` |
| OBO short form | `GO_0008150`, `NCBITaxon_9606`, `EDAM_data_0006` |

Classes, properties (e.g. `RO:0002202`) and individuals are all supported. Obsolete terms are flagged, and terms only found through an importing ontology are marked as such. Each hover links to the term and its ontology in the OLS web UI.

## Commands

- **OLS: Open term at cursor in browser**
- **OLS: Clear term cache**
- **OLS: Refresh known ontology prefixes**

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ols.enabled` | `true` | Turn hovers on or off. |
| `ols.apiBaseUrl` | `https://www.ebi.ac.uk/ols4/api` | OLS REST API. Point at a local OLS4 instance if you run one. |
| `ols.webBaseUrl` | `https://www.ebi.ac.uk/ols4` | OLS web UI, used for links. |
| `ols.restrictToKnownPrefixes` | `true` | Only treat `PREFIX:123` / `PREFIX_123` as a term when the prefix belongs to an ontology in OLS. The list is fetched once a day. IRIs are always looked up. |
| `ols.extraPrefixes` | `[]` | Extra prefixes to recognise. |
| `ols.language` | `en` | Preferred label/definition language. |
| `ols.showDefinition` | `true` | Include the definition. |
| `ols.showSynonyms` | `true` | Include synonyms. |
| `ols.cacheTtlMinutes` | `60` | In-memory cache lifetime for lookups. |
| `ols.requestTimeoutMs` | `8000` | Request timeout. |

Diagnostics are written to the **OLS** output channel.

## Privacy

Every identifier you hover is sent to the OLS API configured in `ols.apiBaseUrl` (by default the public EMBL-EBI service, under the [EMBL-EBI terms of use](https://www.ebi.ac.uk/about/terms-of-use)). Nothing else is sent, and the extension collects no telemetry. If you work with identifiers from unpublished ontologies, point `ols.apiBaseUrl` at your own OLS instance.

## Publishing

Build the VSIX with `npm run package` and upload it at https://marketplace.visualstudio.com/manage under the **ols** publisher, or run `npx vsce publish` with a Marketplace personal access token.

## Development

```sh
npm install
npm test            # compiles, then runs unit tests + a live smoke test against OLS (OLS_LIVE=0 to skip)
npm run package     # builds vscode-ols-<version>.vsix
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

Install a built VSIX with `code --install-extension vscode-ols-0.1.0.vsix`, or via **Extensions: Install from VSIX...** in the command palette.
