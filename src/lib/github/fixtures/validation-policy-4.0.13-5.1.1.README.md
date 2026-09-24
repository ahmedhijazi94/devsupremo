# Immutable scaffold 4.0.13 / 5.1.1 fixtures

Source commit: `630cc8189629dff140c40abc8df13ac5c85884a5`, the published engine release with CLI 1.10.0.

`validation-policy-releases/4.0.13-5.1.1.ts` copies only the committed validation manifest from that release. Its canonical JSON SHA-256 is `c7a789933eb8ff1c6b265bff2c7c2258c0735e2f7da7d6d92fed49dcbe07b689`.

`validation-files-4.0.13-5.1.1.json.gz` contains the original protected files, package metadata, lockfile and `.npmrc` for both stacks and all three project kinds. It was generated inside a temporary `git archive` export of that commit, using that export's generator, template assets and bundled CLI bytes. No generated app or remote service was accessed. The compressed fixture SHA-256 is `a393ffd63046c2574bc0d742ae77f9fcbe2a87da58d550c394a72752e3fa088a`.

The release regression test verifies that the server and local worker accept intact archived projects without rewriting them, and reject altered validators, tool identity and additional workflows. These archives must not be regenerated from newer templates.
