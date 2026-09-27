# Immutable scaffold 4.0.16 / 5.1.4 fixtures

Source commit: `7ba226f6bf6d5f97f35d128f96605236e33b6722`, the published engine release with CLI 1.12.1.

The manifest copies committed validation authority. The compressed fixture was generated in a temporary git archive of that commit, using only that release's generator, assets and CLI bytes. It contains protected files and package metadata for both stacks and all three project kinds. Each protected file was checked against that commit's manifest before archiving. SHA-256: `279d9c15a344b9fdfaeb1bec30beea6e1702c465da69198155e03a2ef246cfa6`.

Regression tests accept intact historical templates on the server and local worker without rewriting them and reject modified validators, tool identity and additional workflows. Never regenerate these archives from current templates.
