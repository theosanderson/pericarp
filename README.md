# Pericarp

A cross-organism search UI for [Loculus](https://loculus.org) instances such as [Pathoplexus](https://pathoplexus.org).

Enter an instance's `/loculus-info` URL (e.g. `https://pathoplexus.org/loculus-info`). Pericarp reads every
organism's schema and LAPIS endpoint and runs a single query against all of them in parallel.

- Typed metadata filters on the union of all organisms' fields, with value autocomplete merged across organisms
- Identifier lookup: paste a list of accessions and find which organism each belongs to
- Organism-scoped nucleotide / amino-acid mutation filters, plus raw LAPIS advanced queries
- Views: merged records table (k-way merge sorted across organisms), breakdown by any field, timeline,
  mutations, and export (per-organism downloads, combined metadata, link-outs, API recipes)
- Query state lives in the URL, so searches can be shared; saved queries are stored locally

Everything runs in the browser and talks to LAPIS directly.

## Development

```sh
npm install
npm run dev      # serves on 0.0.0.0:9126
npm run build
```
