# Changelog

## [1.15.10](https://github.com/10ego/pi-pr-review/compare/v1.15.9...v1.15.10) (2026-08-28)


### Tests

* **review:** evaluate integrated topology on corpus v6 ([#105](https://github.com/10ego/pi-pr-review/issues/105)) ([df2288d](https://github.com/10ego/pi-pr-review/commit/df2288d33474b5d92e3db32e1dce78dc4906534a)), closes [#60](https://github.com/10ego/pi-pr-review/issues/60)

## [1.15.9](https://github.com/10ego/pi-pr-review/compare/v1.15.8...v1.15.9) (2026-08-28)


### Tests

* **review:** add seeded semantic quality benchmark ([#104](https://github.com/10ego/pi-pr-review/issues/104)) ([ed06cd1](https://github.com/10ego/pi-pr-review/commit/ed06cd15c0f9358dadf95c6fa3768810b7923eca)), closes [#59](https://github.com/10ego/pi-pr-review/issues/59)

## [1.15.8](https://github.com/10ego/pi-pr-review/compare/v1.15.7...v1.15.8) (2026-08-26)


### Bug Fixes

* **review:** harden extraction telemetry gate semantics ([#102](https://github.com/10ego/pi-pr-review/issues/102)) ([17967b7](https://github.com/10ego/pi-pr-review/commit/17967b7187660dc6ee0c204808142bb5d1b67e5d))

## [1.15.7](https://github.com/10ego/pi-pr-review/compare/v1.15.6...v1.15.7) (2026-08-25)


### Bug Fixes

* **review:** close prefixed completion bypasses ([#100](https://github.com/10ego/pi-pr-review/issues/100)) ([642d04b](https://github.com/10ego/pi-pr-review/commit/642d04badeb8665e19ddfbec26db68f147316ddb))

## [1.15.6](https://github.com/10ego/pi-pr-review/compare/v1.15.5...v1.15.6) (2026-08-25)


### Bug Fixes

* **review:** preserve legitimate completion prose ([#98](https://github.com/10ego/pi-pr-review/issues/98)) ([787e43f](https://github.com/10ego/pi-pr-review/commit/787e43fe44df7853c7cc52f8e491e307ed9cc8ec))

## [1.15.5](https://github.com/10ego/pi-pr-review/compare/v1.15.4...v1.15.5) (2026-08-25)


### Bug Fixes

* **review:** harden deep completion contracts ([#96](https://github.com/10ego/pi-pr-review/issues/96)) ([1834811](https://github.com/10ego/pi-pr-review/commit/18348114d10edaf917d317495cca023e0076de2b))

## [1.15.4](https://github.com/10ego/pi-pr-review/compare/v1.15.3...v1.15.4) (2026-08-25)


### Bug Fixes

* **package:** prevent duplicate extension declarations ([#94](https://github.com/10ego/pi-pr-review/issues/94)) ([950bb26](https://github.com/10ego/pi-pr-review/commit/950bb26e3ed7df460ec2db820b08b483f27a23ed))

## [1.15.3](https://github.com/10ego/pi-pr-review/compare/v1.15.2...v1.15.3) (2026-08-25)


### Bug Fixes

* **review:** harden the nonempty refusal check and document the contract ([#92](https://github.com/10ego/pi-pr-review/issues/92)) ([e8339a0](https://github.com/10ego/pi-pr-review/commit/e8339a029b1d12722f941339d1e8164e6d1ef09d))

## [1.15.2](https://github.com/10ego/pi-pr-review/compare/v1.15.1...v1.15.2) (2026-08-24)


### Bug Fixes

* **review:** declare and persist the deep completion contract ([#90](https://github.com/10ego/pi-pr-review/issues/90)) ([8dbe500](https://github.com/10ego/pi-pr-review/commit/8dbe500b9e86ae2758e42f0731c8692a468ac488))

## [1.15.1](https://github.com/10ego/pi-pr-review/compare/v1.15.0...v1.15.1) (2026-08-24)


### Bug Fixes

* **review:** give deep lanes a nonempty completion contract ([#88](https://github.com/10ego/pi-pr-review/issues/88)) ([3e2753c](https://github.com/10ego/pi-pr-review/commit/3e2753c707c6e69919fc682695c3d545a5f0739b))

## [1.15.0](https://github.com/10ego/pi-pr-review/compare/v1.14.5...v1.15.0) (2026-08-24)


### Features

* **review:** add deep single-pass review mode ([#86](https://github.com/10ego/pi-pr-review/issues/86)) ([6668c63](https://github.com/10ego/pi-pr-review/commit/6668c63797dc8de1cf154a6d46a1360a24cfb26d))

## [1.14.5](https://github.com/10ego/pi-pr-review/compare/v1.14.4...v1.14.5) (2026-08-24)


### Tests

* **extract:** complete the pi-tui mock to stop cross-file leakage ([#85](https://github.com/10ego/pi-pr-review/issues/85)) ([7c6dd99](https://github.com/10ego/pi-pr-review/commit/7c6dd9994d9770ad08f71711c4fe553a571b26cb))
* **extract:** cover the real subprocess path and add a dev-only gate tally ([#83](https://github.com/10ego/pi-pr-review/issues/83)) ([d40170b](https://github.com/10ego/pi-pr-review/commit/d40170b2b4def0dec9928cf9dbf543adb910eb84))

## [1.14.4](https://github.com/10ego/pi-pr-review/compare/v1.14.3...v1.14.4) (2026-08-23)


### Bug Fixes

* **extract:** refine summary-only dedupe and degraded path retention ([#81](https://github.com/10ego/pi-pr-review/issues/81)) ([ced7b38](https://github.com/10ego/pi-pr-review/commit/ced7b384d70796af73b9760582a1deb439baa413))

## [1.14.3](https://github.com/10ego/pi-pr-review/compare/v1.14.2...v1.14.3) (2026-08-23)


### Bug Fixes

* **extract:** degrade path-only locations to summary-only ([#79](https://github.com/10ego/pi-pr-review/issues/79)) ([7587eff](https://github.com/10ego/pi-pr-review/commit/7587effc1e6d12f77579fcbfa2281487c0458d5e))

## [1.14.2](https://github.com/10ego/pi-pr-review/compare/v1.14.1...v1.14.2) (2026-08-23)


### Bug Fixes

* **extract:** scan lane evidence past the synthesis findings framing ([#77](https://github.com/10ego/pi-pr-review/issues/77)) ([dfebc36](https://github.com/10ego/pi-pr-review/commit/dfebc3632910fdde46581d4a48d236d72c7046df))

## [1.14.1](https://github.com/10ego/pi-pr-review/compare/v1.14.0...v1.14.1) (2026-08-22)


### Bug Fixes

* **extract:** harden provenance and retained-binding handling from sample review ([#75](https://github.com/10ego/pi-pr-review/issues/75)) ([ff5206a](https://github.com/10ego/pi-pr-review/commit/ff5206ad94ec0a901c1a8398149d31445d49874b))

## [1.14.0](https://github.com/10ego/pi-pr-review/compare/v1.13.0...v1.14.0) (2026-08-22)


### Features

* **extract:** add model-assisted finding extraction for degraded reviews ([#73](https://github.com/10ego/pi-pr-review/issues/73)) ([e76ffab](https://github.com/10ego/pi-pr-review/commit/e76ffab827a97e08af1b80600bc69fc6f49451b1))

## [1.13.0](https://github.com/10ego/pi-pr-review/compare/v1.12.3...v1.13.0) (2026-08-20)


### Features

* **review:** render degraded syntheses as readable generic reviews ([#69](https://github.com/10ego/pi-pr-review/issues/69)) ([ee80cde](https://github.com/10ego/pi-pr-review/commit/ee80cdea6cddfd580a68bd6ab71b9625a1e06127))

## [1.12.3](https://github.com/10ego/pi-pr-review/compare/v1.12.2...v1.12.3) (2026-08-19)


### Bug Fixes

* **review:** make host lane truth authoritative for completeness ([#67](https://github.com/10ego/pi-pr-review/issues/67)) ([ad70fc3](https://github.com/10ego/pi-pr-review/commit/ad70fc3b6376f215bf045b980fef06bd87036bd1))

## [1.12.2](https://github.com/10ego/pi-pr-review/compare/v1.12.1...v1.12.2) (2026-08-19)


### Bug Fixes

* **review:** defer synthesis cap while review work runs ([#65](https://github.com/10ego/pi-pr-review/issues/65)) ([2bcdd93](https://github.com/10ego/pi-pr-review/commit/2bcdd93678755fc9c6b209c2357487a3912d026f))

## [1.12.1](https://github.com/10ego/pi-pr-review/compare/v1.12.0...v1.12.1) (2026-08-19)


### Documentation

* **review:** align publication guidance ([#63](https://github.com/10ego/pi-pr-review/issues/63)) ([fe019d3](https://github.com/10ego/pi-pr-review/commit/fe019d3729635d1ed7ba7fd1e72bc5983db87a01))

## [1.12.0](https://github.com/10ego/pi-pr-review/compare/v1.11.8...v1.12.0) (2026-08-19)


### Features

* **review:** make reviews lossless and bounded ([ce72012](https://github.com/10ego/pi-pr-review/commit/ce72012a306304ebc3c99c0a183312a2336af88d)), closes [#56](https://github.com/10ego/pi-pr-review/issues/56) [#57](https://github.com/10ego/pi-pr-review/issues/57) [#58](https://github.com/10ego/pi-pr-review/issues/58)

## [1.11.8](https://github.com/10ego/pi-pr-review/compare/v1.11.7...v1.11.8) (2026-08-05)


### Bug Fixes

* **review:** flatten verification tool schema ([#54](https://github.com/10ego/pi-pr-review/issues/54)) ([9438e83](https://github.com/10ego/pi-pr-review/commit/9438e83bfa9a9e0c6a1287d14646aa5a0431ade0))

## [1.11.7](https://github.com/10ego/pi-pr-review/compare/v1.11.6...v1.11.7) (2026-08-04)


### Bug Fixes

* **review:** preserve batch passes as JSON array ([#52](https://github.com/10ego/pi-pr-review/issues/52)) ([9778992](https://github.com/10ego/pi-pr-review/commit/977899296a2a676480145080fb358891908dbaab))

## [1.11.6](https://github.com/10ego/pi-pr-review/compare/v1.11.5...v1.11.6) (2026-08-04)


### Bug Fixes

* **review:** shorten published review comments ([#50](https://github.com/10ego/pi-pr-review/issues/50)) ([f900c10](https://github.com/10ego/pi-pr-review/commit/f900c10345054e683cee84ff1396b12050dbd3be))

## [1.11.5](https://github.com/10ego/pi-pr-review/compare/v1.11.4...v1.11.5) (2026-08-04)


### Tests

* **publish:** cover multiple review JSON outputs ([#48](https://github.com/10ego/pi-pr-review/issues/48)) ([cf0c926](https://github.com/10ego/pi-pr-review/commit/cf0c926ddcd646427b3c7d0d109a5b9955cb958a))

## [1.11.4](https://github.com/10ego/pi-pr-review/compare/v1.11.3...v1.11.4) (2026-07-28)


### Bug Fixes

* **publish:** fall back to light gh posting ([#46](https://github.com/10ego/pi-pr-review/issues/46)) ([c986737](https://github.com/10ego/pi-pr-review/commit/c98673750d9e447bf639f9f63f7fb4512e45ad68))

## [1.11.3](https://github.com/10ego/pi-pr-review/compare/v1.11.2...v1.11.3) (2026-07-22)


### Bug Fixes

* **publish:** downgrade self-approval to comment ([#44](https://github.com/10ego/pi-pr-review/issues/44)) ([f7c8b71](https://github.com/10ego/pi-pr-review/commit/f7c8b71ca587fb9551bbb24448e70de9733b135b))

## [1.11.2](https://github.com/10ego/pi-pr-review/compare/v1.11.1...v1.11.2) (2026-07-22)


### Bug Fixes

* **publish:** repair malformed reviews with light subagent ([#42](https://github.com/10ego/pi-pr-review/issues/42)) ([6bb2f1b](https://github.com/10ego/pi-pr-review/commit/6bb2f1b5d7c42ab0233be27b7fa75984eb0b6357))

## [1.11.1](https://github.com/10ego/pi-pr-review/compare/v1.11.0...v1.11.1) (2026-07-20)


### Bug Fixes

* **focus:** coalesce live viewer redraws ([#40](https://github.com/10ego/pi-pr-review/issues/40)) ([6553eb1](https://github.com/10ego/pi-pr-review/commit/6553eb1c0ade7881b220269b22adf22e4a5d7e59))

## [1.11.0](https://github.com/10ego/pi-pr-review/compare/v1.10.7...v1.11.0) (2026-07-17)


### Features

* submit APPROVE review event with configurable priority gate ([#35](https://github.com/10ego/pi-pr-review/issues/35)) ([ec47045](https://github.com/10ego/pi-pr-review/commit/ec47045245541c9182ac7e1b120765bbc5e77696))

## [1.10.7](https://github.com/10ego/pi-pr-review/compare/v1.10.6...v1.10.7) (2026-07-17)


### Bug Fixes

* **publish:** auto-heal a Markdown-fenced review JSON object ([#37](https://github.com/10ego/pi-pr-review/issues/37)) ([9ecdd05](https://github.com/10ego/pi-pr-review/commit/9ecdd05e8f00b56176c52f5ca50fcf55698bd2b8))

## [1.10.6](https://github.com/10ego/pi-pr-review/compare/v1.10.5...v1.10.6) (2026-07-17)


### Bug Fixes

* **publish:** simplify reliable review posting ([#31](https://github.com/10ego/pi-pr-review/issues/31)) ([7d93560](https://github.com/10ego/pi-pr-review/commit/7d935604b620a51b04708633da7c4dc0850d6096))

## [1.10.5](https://github.com/10ego/pi-pr-review/compare/v1.10.4...v1.10.5) (2026-07-17)


### Miscellaneous Chores

* **release:** harden Node 24 automation ([#32](https://github.com/10ego/pi-pr-review/issues/32)) ([6b670b3](https://github.com/10ego/pi-pr-review/commit/6b670b3a1e33f3f2392027ae79c159afd9738690))

## [1.10.4](https://github.com/10ego/pi-pr-review/compare/v1.10.3...v1.10.4) (2026-07-15)


### Bug Fixes

* **publish:** summarize findings without diff patches ([#29](https://github.com/10ego/pi-pr-review/issues/29)) ([bdee1ff](https://github.com/10ego/pi-pr-review/commit/bdee1ff024863019a2f357b04cffe944006a5726))

## [1.10.3](https://github.com/10ego/pi-pr-review/compare/v1.10.2...v1.10.3) (2026-07-15)


### Bug Fixes

* **publish:** retry invalid review output once ([#27](https://github.com/10ego/pi-pr-review/issues/27)) ([9689505](https://github.com/10ego/pi-pr-review/commit/968950579c4eeec0ac264dccf3bda9b1833df160))

## [1.10.2](https://github.com/10ego/pi-pr-review/compare/v1.10.1...v1.10.2) (2026-07-15)


### Bug Fixes

* **publish:** preserve findings with duplicate anchors ([#25](https://github.com/10ego/pi-pr-review/issues/25)) ([1df420f](https://github.com/10ego/pi-pr-review/commit/1df420f30b1dd1a74017c0442b2a880949d4b864))

## [1.10.1](https://github.com/10ego/pi-pr-review/compare/v1.10.0...v1.10.1) (2026-07-14)


### Bug Fixes

* **publish:** recognize direct review comment requests ([#23](https://github.com/10ego/pi-pr-review/issues/23)) ([83b003b](https://github.com/10ego/pi-pr-review/commit/83b003b6a37fab9c0ff32d482e41010dc9893afa))

## [1.10.0](https://github.com/10ego/pi-pr-review/compare/v1.9.0...v1.10.0) (2026-07-14)


### Features

* **release:** auto-merge release pull requests ([#21](https://github.com/10ego/pi-pr-review/issues/21)) ([56ea9a9](https://github.com/10ego/pi-pr-review/commit/56ea9a9585069193181c78700223cb659af72750))

## [1.9.0](https://github.com/10ego/pi-pr-review/compare/v1.8.0...v1.9.0) (2026-07-14)


### Features

* **review:** add constrained one-shot self-review ([#18](https://github.com/10ego/pi-pr-review/issues/18)) ([ab267c4](https://github.com/10ego/pi-pr-review/commit/ab267c40415731b2fbbea91c5b345153fa7b6132))

## [1.8.0](https://github.com/10ego/pi-pr-review/compare/v1.7.1...v1.8.0) (2026-07-14)


### Features

* add live subagent focus viewer ([#17](https://github.com/10ego/pi-pr-review/issues/17)) ([44f1020](https://github.com/10ego/pi-pr-review/commit/44f102067e974ca2a723611c6882019bac6dbb9c))

## [1.7.1](https://github.com/10ego/pi-pr-review/compare/v1.7.0...v1.7.1) (2026-07-14)


### Bug Fixes

* **publish:** handle direct review requests in extension ([#15](https://github.com/10ego/pi-pr-review/issues/15)) ([e27ffeb](https://github.com/10ego/pi-pr-review/commit/e27ffebb181687a7e38f5ce8f0045b5db76975f4))

## [1.7.0](https://github.com/10ego/pi-pr-review/compare/v1.6.6...v1.7.0) (2026-07-13)


### Features

* **review:** restrict tools to command loops ([#13](https://github.com/10ego/pi-pr-review/issues/13)) ([fbb579d](https://github.com/10ego/pi-pr-review/commit/fbb579d0ef9d550a9b21c125040cb8ba036564e1))

## [1.6.6](https://github.com/10ego/pi-pr-review/compare/v1.6.5...v1.6.6) (2026-07-13)


### Bug Fixes

* **publish:** persist completed review cache ([#10](https://github.com/10ego/pi-pr-review/issues/10)) ([e5a1f33](https://github.com/10ego/pi-pr-review/commit/e5a1f333ce6a4bbf624d889a0954bdd251e7d902))

## [1.6.5](https://github.com/10ego/pi-pr-review/compare/v1.6.4...v1.6.5) (2026-07-13)


### Bug Fixes

* **release:** verify root version metadata ([#9](https://github.com/10ego/pi-pr-review/issues/9)) ([ce4e36f](https://github.com/10ego/pi-pr-review/commit/ce4e36f1d2c3aa11b60f5d37564d48a8783e192c))

## [1.6.4](https://github.com/10ego/pi-pr-review/compare/v1.6.3...v1.6.4) (2026-07-13)


### Bug Fixes

* **release:** use release commits and simplify docs ([#7](https://github.com/10ego/pi-pr-review/issues/7)) ([4c89c4c](https://github.com/10ego/pi-pr-review/commit/4c89c4c67bf6300fd544fbc8ea9a99079fb1f8aa))

## [1.6.3](https://github.com/10ego/pi-pr-review/compare/v1.6.2...v1.6.3) (2026-07-13)


### Performance Improvements

* **review:** optimize parallel review execution ([#5](https://github.com/10ego/pi-pr-review/issues/5)) ([4ea1a76](https://github.com/10ego/pi-pr-review/commit/4ea1a7627f5c5fb7a8022a97fe2c24bb44643d2a))

## [1.6.2](https://github.com/10ego/pi-pr-review/compare/v1.6.1...v1.6.2) (2026-07-11)


### Miscellaneous Chores

* **release:** automate versioning and npm publishing ([585e961](https://github.com/10ego/pi-pr-review/commit/585e9616a85153a8edb03ec66acb7b75739706b0))
* **release:** version every conventional PR ([be175e8](https://github.com/10ego/pi-pr-review/commit/be175e811bca1a0e74bb8e56d5148da80d2207b0))
