# Evolabs verified AI packs

The release manifests in this directory contain upstream URLs, exact byte sizes,
SHA-256 digests, license notes, hardware gates, and activation metadata. Model
weights are deliberately **not** stored in the source archive or the NSIS App
installer.

- `models/anime-core.json` is the default first install and includes the pinned
  CUDA 12 runtime inside that versioned pack.
- `models/realistic-core.json` is optional and installed only on demand.
- Both model packs pin the same stable-diffusion.cpp CUDA 12 release artifact.
  Each installed pack remains self-contained so activation never escapes its
  version root.

The installer writes model versions to
`<engine-data-root>/models/<pack-id>/<version>`, writes a verified `pack.json`,
then atomically switches `<pack-id>/current.json`. A model pack is not considered
ready merely because its manifest exists.

Run `scripts/validate-distribution.ps1` before a release. Any changed upstream
artifact requires a new version, exact size, verified SHA-256, and a fresh
license review. Never replace a digest just to make a failed download pass.
