# Immutable scaffold 4.0.15 / 5.1.3 fixtures

Source commit: `ad6469919f66cdd94fb4d9664cc93d38f769e889`, the published engine release with CLI 1.12.0.

The manifest copies committed validation authority. The compressed fixture was generated in a temporary git archive of that commit, using only that release's generator, assets and CLI bytes. It contains protected files and package metadata for both stacks and all three project kinds. SHA-256: `50d8db7d7f1a28dd41628e598aa4dc10b7788fd5548f1a588a88bfcb2bd3bc36`.

Regression tests accept intact historical templates without rewriting them and reject modified validators, tool identity and additional workflows. Never regenerate these archives from current templates.
