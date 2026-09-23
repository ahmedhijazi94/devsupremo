# Immutable scaffold 4.0.12 / 5.1.0 fixtures

Source commit: `5ca0dd340eaa3ec7846bb816637cd31ec38cec0f`, the published engine release with CLI 1.9.0.

`validation-policy-releases/4.0.12-5.1.0.ts` copies only the committed validation manifest from that release. Its canonical JSON SHA-256 is `2d64da87947fcbda6437bee9125ce346ea979a972ad5ad3d2643f02a596e2102`.

`validation-files-4.0.12-5.1.0.json.gz` contains the original protected files, package metadata, lockfile and `.npmrc` for both stacks and all three project kinds. It was generated inside a temporary `git archive` export of that commit, using that export's generator, template assets and bundled CLI bytes. No generated app or remote service was accessed. The compressed fixture SHA-256 is `095599d3c7d89499ae657ce92ad3f4a0df57418c6c41a1bd7d09d7b3634171c3`.

The release regression test verifies that the server and local worker accept intact archived projects without rewriting them, and reject altered validators, tool identity and additional workflows. These archives must not be regenerated from newer templates.
