# Archived validation policy 4.0.2

Source commit: ae3285a13b91d7b3931d8a80a7f0647dc4cb1c92.
Source manifest: packages/cli/src/generated/validation-policy.ts at that commit.
Source generator: src/lib/templates/project-files.ts at the same commit (template 4.0.2, bundled CLI 1.7.2).

The TypeScript release archive contains only values extracted from the committed manifest. Identical scripts, devDependencies and lock entries are stored once; every kind retains its own complete files map. No current or future release is imported or used to derive this archive.

The fixture was produced by exporting that entire commit with git archive into a temporary directory, linking the already installed node_modules for TypeScript execution, and calling only its buildProjectFiles function for public, solo and team. Working directory, template assets, lockfile, security audit source and bundled CLI bytes all came from that export. The bundled CLI was read as data and was not executed. No app, server, model, remote service or real credentials were used.

Generation options: projectName="supremo-policy-4-0-2-fixture", description="", and each kind. The generator returned mode 100755 for the bundled CLI; omitted modes are represented as Git regular-file mode 100644. Blob hashes use Git SHA-1 over the UTF-8 file content and its blob header.

## Fixture format

The gzip expands to JSON with schemaVersion, templateVersion, sourceCommit, generation, common and kinds. common contains the exact packageContent and lockContent strings (identical across all three kinds). kinds.public.tree, kinds.solo.tree and kinds.team.tree contain every generated file as {path, sha, mode}. Candidate reconstruction adds common, the chosen kind and its tree, plus caller-owned headSha and truncated fields.

Counts: public: 70 tree entries; solo: 79 tree entries; team: 81 tree entries. Each manifest protects 716 lock entries.

## Recorded verification

- assert.deepStrictEqual of all three reconstructed exported manifests against the original imported manifests passed, including version, kind, files, scripts, devDependencies and every lock entry.
- Each generated candidate passed the original commit's inspectValidationIntegrity with no failures.
- All package/lock strings matched across kinds before deduplication; generated file paths were unique; the compressed JSON round-tripped exactly.
- Fixture gzip SHA-256: 3ea04af2867bfdf7deb2223920bd8839da66d83d2cae57b1ddf38bbc4a2219ff.
- Decompressed fixture JSON SHA-256: 6c66278ce9415d71270215cc20c139da3a2a4aec072e202bd629b628edd91ae5.
- Original manifest source SHA-256: 2dd238809706415f531ce045190a5ea96f4d433b36f3344f48fae228740281a6.
- JSON.stringify(original imported manifest array) SHA-256: ac8079a1684751bcac5bbba1bdd6d4dea09d6f19a27691f58f6cd518090b11aa.
- JSON.stringify(reconstructed imported manifest array) SHA-256: ac8079a1684751bcac5bbba1bdd6d4dea09d6f19a27691f58f6cd518090b11aa.

Preserve these files when releasing newer templates; regenerate this historical fixture only from the source commit above.
