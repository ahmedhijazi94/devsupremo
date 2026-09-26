# Immutable scaffold 4.0.14 / 5.1.2 fixtures

Source commit: `3dd9cef00ccaba3dfa415c2faa1a4777bea3ad1a`, the published engine release with CLI 1.11.0.

`validation-policy-releases/4.0.14-5.1.2.ts` copies only the committed validation manifest from that release. Its canonical JSON SHA-256 is `71030b49e191311aa2b37d9845f3cda0d643e2844377f6b8f45b6b031aa39e73`.

`validation-files-4.0.14-5.1.2.json.gz` contains the original protected files, package metadata, lockfile and `.npmrc` for both stacks and all three project kinds. It was generated inside a temporary `git archive` export of that commit, using that export's generator, template assets and bundled CLI bytes. No generated app or remote service was accessed. The compressed fixture SHA-256 is `c4f9905bcdfc95e5704fba1732f140465e8358c1d191087fad9fb04ec2e23ab7`.

The release regression test verifies that the server and local worker accept intact archived projects without rewriting them, and reject altered validators, tool identity and additional workflows. These archives must not be regenerated from newer templates.
