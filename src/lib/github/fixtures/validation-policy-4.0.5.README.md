# Archived validation policy 4.0.5

Source commit: f4acc40aa55bee2371cfc4b9a3e8aa8c9c8504cc (origin/main when archived).
Source manifest: packages/cli/src/generated/validation-policy.ts at that commit.
Source generator: src/lib/templates/project-files.ts at the same commit (template 4.0.5, bundled CLI 1.7.4).

The TypeScript release archive contains only values extracted from the committed manifest. Identical scripts, devDependencies and lock entries are stored once; every kind retains its complete files map. No current or future release is imported or used to derive this archive.

The fixture was produced by exporting the entire source commit with git archive into a temporary directory, linking the installed node_modules for TypeScript execution, and calling only that export's buildProjectFiles function for public, solo and team. Working directory, template assets, lockfile, security audit source and bundled CLI bytes came from the export. The bundled CLI was read as data and was not executed. No app, server, model, remote service or credentials were used.

Generation options: projectName="supremo-policy-4-0-5-fixture", description="", and each kind. The generator returned mode 100755 for the bundled CLI; omitted modes are represented as Git regular-file mode 100644. Blob hashes use Git SHA-1 over UTF-8 file content and its blob header.

## Fixture format

The gzip expands to JSON with schemaVersion, templateVersion, sourceCommit, generation, common and kinds. common contains the exact packageContent and lockContent strings, identical across all three kinds. kinds.public.tree, kinds.solo.tree and kinds.team.tree contain every generated file as {path, sha, mode}. Candidate reconstruction adds common, the chosen kind and its tree, plus caller-owned headSha and truncated fields.

Counts: public: 70 tree entries; solo: 79 tree entries; team: 81 tree entries. Each manifest protects 716 lock entries.

The companion validation-files-4.0.5.json.gz fixture contains the exact contents of the 14 protected validators for each kind. It was generated from the same immutable export and generation options; every file's blob hash was checked against the original committed manifest before archiving. It contains schemaVersion, templateVersion, sourceCommit and kinds, with kinds[kind].files entries carrying path, content and the optional original Git mode. CLI regression tests combine these bytes with the package/lock strings above to verify old projects without updating their files. Neither the app implementation nor the bundled CLI is included in this companion fixture.

## Recorded verification

- All reconstructed manifests matched the original imported manifests using assert.deepStrictEqual, including version, kind, files, scripts, devDependencies and every lock entry.
- Each generated candidate passed the source commit's inspectValidationIntegrity with no failures.
- Package/lock strings matched across kinds before deduplication; generated file paths were unique; the compressed JSON round-tripped exactly.
- Fixture gzip SHA-256: 9cd940a85963f73a50e95566e889740f4798fadae662601147a6512c0b584047.
- Decompressed fixture JSON SHA-256: 8f389ce9eb4f9613a5ea83e9ef25805f7dd522b30139a0a7121fac93b4467e63.
- Original manifest source SHA-256: 5880549f413c1cfb7df1a5eb45d56bbe11866a3952fc3221b5ed3b5655002311.
- JSON.stringify(original imported manifest array) SHA-256: 43c6b61a351ca0c4b6f0f76e9bbeb660a5165f52863da722f37b68007c564be5.
- JSON.stringify(reconstructed imported manifest array) SHA-256: 43c6b61a351ca0c4b6f0f76e9bbeb660a5165f52863da722f37b68007c564be5.
- Companion validator-files gzip SHA-256: 47c794cbcd88c25fb0dc2950c455d13180d654aec9b7aa21bcbd14c21a781453.
- Decompressed companion validator-files JSON SHA-256: 1ce114bd4bb539450a5c578da82de23b30eadf4df9e6e3d56c3c321682da8068.

Preserve these files when releasing newer templates; regenerate this historical fixture only from the source commit above. This archive preserves the engine's published authority and does not update any project.
