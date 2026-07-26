This package includes embedded MPV native integration code originally copied from IPTVnator:

- Repository: https://github.com/4gray/iptvnator
- Commit: 06700b318ab84edf78e97bdd99dc76829cb4d633
- Commit title: feat(electron): add embedded mpv support for windows and linux (#1031)

Copied and adapted files include the native N-API addon sources, libmpv runtime staging
scripts, and packaging helpers under `native/` and `scripts/`. The addon has since been
rewritten from C++/Objective-C++ (node-gyp) to Rust/napi-rs with thin platform shims;
the attribution stands for the lineage.

IPTVnator is distributed under the MIT license. The original license text is preserved
in `LICENSE.md` next to this file.
