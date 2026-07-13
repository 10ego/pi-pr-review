# Releasing

[Release Please](https://github.com/googleapis/release-please) watches conventional commits merged into `main`. It opens or updates a release PR containing the calculated version change, `CHANGELOG.md`, and release manifest. Its root Node strategy is the sole version writer: the generated PR keeps `package.json` and `.release-please-manifest.json` in sync. The generated PR title—and therefore its squash commit—uses `release(main): release <version>`. Merging that release PR creates a GitHub release and, after the test suite passes, publishes `pi-pr-review` to npm with signed provenance.

Pull-request CI verifies both root version fields remain equal. The publish job repeats that read-only check against the version emitted by Release Please, so an inconsistent release commit cannot publish; no feature PR should manually set a release version.

## Semver

The squash-merged PR title becomes the commit Release Please evaluates:

- `feat: ...` creates a minor release.
- `feat!: ...`, `fix!: ...`, or a `BREAKING CHANGE:` footer creates a major release.
- Every other allowed type—`fix:`, `perf:`, `revert:`, `chore:`, `docs:`, `refactor:`, `style:`, and `test:`—creates a patch release.

All changes to `main` must go through a pull request and use squash merging. The required `Validate PR title` check enforces the conventional title, and the required `Test` check runs the Bun test suite. Direct pushes, force pushes, branch deletion, and administrator bypass are disabled.

## One-time setup

1. Install the private [`nerv-ops`](https://github.com/settings/apps/nerv-ops) GitHub App on this repository with **Contents: read and write** and **Pull requests: read and write** permissions.
2. Add the App ID as the repository Actions variable `NERV_OPS_APP_ID`, and add a generated PEM private key as the repository Actions secret `NERV_OPS_PRIVATE_KEY`.
3. In the npm settings for [`pi-pr-review`](https://www.npmjs.com/package/pi-pr-review), add a GitHub Actions trusted publisher with:
   - organization/user: `10ego`
   - repository: `pi-pr-review`
   - workflow filename: `release-please.yml`
   - environment: leave blank
4. Use conventional titles for squash-merged PRs.

No npm token is stored in GitHub. The workflow exchanges the App credentials for a short-lived repository installation token and uses npm trusted publishing through GitHub OIDC.
