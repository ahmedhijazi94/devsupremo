# Archived validation policy 4.0.4

Source commit: baf34b78cef2975ad89b43137fa01fa934d148ee (origin/main when archived).
Source manifest: packages/cli/src/generated/validation-policy.ts at that commit.
Source generator: src/lib/templates/project-files.ts at the same commit (template 4.0.4, bundled CLI 1.7.3).

The TypeScript release archive contains only values extracted from the committed manifest. Identical scripts, devDependencies and lock entries are stored once; every kind retains its complete files map. No current or future release is imported or used to derive this archive.

The fixture was produced by exporting the entire source commit with git archive into a temporary directory, linking the installed node_modules for TypeScript execution, and calling only that export's buildProjectFiles function for public, solo and team. Working directory, template assets, lockfile, security audit source and bundled CLI bytes came from the export. The bundled CLI was read as data and was not executed. No app, server, model, remote service or credentials were used.

Generation options: projectName="supremo-policy-4-0-4-fixture", description="", and each kind. The generator returned mode 100755 for the bundled CLI; omitted modes are represented as Git regular-file mode 100644. Blob hashes use Git SHA-1 over UTF-8 file content and its blob header.

## Fixture format

The gzip expands to JSON with schemaVersion, templateVersion, sourceCommit, generation, common and kinds. common contains the exact packageContent and lockContent strings, identical across all three kinds. kinds.public.tree, kinds.solo.tree and kinds.team.tree contain every generated file as {path, sha, mode}. Candidate reconstruction adds common, the chosen kind and its tree, plus caller-owned headSha and truncated fields.

Counts: public: 70 tree entries; solo: 79 tree entries; team: 81 tree entries. Each manifest protects 716 lock entries.

## Recorded verification

- All reconstructed manifests matched the original imported manifests using assert.deepStrictEqual, including version, kind, files, scripts, devDependencies and every lock entry.
- Each generated candidate passed the source commit's inspectValidationIntegrity with no failures.
- Package/lock strings matched across kinds before deduplication; generated file paths were unique; the compressed JSON round-tripped exactly.
- Fixture gzip SHA-256: b8b2424ee0ee8f42c9dc25192fc1a57c99f215498197dac48da2ec85e70991ae.
- Decompressed fixture JSON SHA-256: 35d167bde7d9fcbbf5df04881f00c05a84e59d039ede972547219f0ed7bf91d7.
- Original manifest source SHA-256: 2d9bd6a262c9296119f5629c52c612589d4bd85eaa3678bf2def6dff47d7a829.
- JSON.stringify(original imported manifest array) SHA-256: 861344ab9f225ebe667002a61194f65ae7df144cefdf2210d1c4321925e23904.
- JSON.stringify(reconstructed imported manifest array) SHA-256: 861344ab9f225ebe667002a61194f65ae7df144cefdf2210d1c4321925e23904.

Preserve these files when releasing newer templates; regenerate this historical fixture only from the source commit above. This archive preserves the engine's published authority and does not update any project.
