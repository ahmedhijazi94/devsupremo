# Immutable scaffold 4.0.8 fixtures

These fixtures were produced from `git archive 3071f69596ab18e8c5a224c734af1227b22ec069`, the published engine release containing CLI 1.7.7 and scaffold 4.0.8. They must not be regenerated from the current scaffold.

- `validation-policy-4.0.8.json.gz` contains the original package metadata, lockfile, and generated file tree for public, solo, and team projects.
- `validation-files-4.0.8.json.gz` contains the original protected validator files for those three project types, so the current CLI is tested against actual old files without rewriting project rails.
- `validation-policy-releases/4.0.8.ts` freezes the released validation authority. Its canonical JSON SHA-256 is `fcff94f43c1d3b112ca1fd7ab7d8c6b80697c95fc8ace583e575813f82e4e223`.
- The validator fixture SHA-256 is `d90bae22025418d283135e6b3bf072a0a3d31bbdf2b7f6bbc5727208e564ead8`.

The tests accept intact archived projects and reject changes to validators, the trusted tool identity, and extra workflows. The new worker can therefore validate existing 4.0.8 project rails while keeping its original validation requirements.
