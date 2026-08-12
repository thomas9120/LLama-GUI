# Software Versioning Policy: Calendar Versioning (CalVer)

## 1. Core principle

Llama GUI uses Calendar Versioning (CalVer). A version communicates when a stable release was published rather than the size or type of its internal changes. The project aims to preserve backwards compatibility; any unavoidable compatibility impact must still be called out in the release notes.

## 2. Version and tag format

Stable releases use `YY.MM.Micro`, and their Git tags add a leading `v`:

```text
Version: 26.08.0
Tag:     v26.08.0
         |  |  |
         |  |  +-- Micro: sequential release number within the month
         |  +----- Month: two digits, zero-padded
         +-------- Year: last two digits
```

- `YY`: Last two digits of the UTC release year.
- `MM`: Two-digit UTC release month.
- `Micro`: Starts at `0` for the first stable release of the month and increases by one for each later release that month.

Release dates are calculated in UTC so a release near a month boundary has one unambiguous version.

## 3. Release channels

- **Nightly** follows every commit on `main`, including commits that have not been released yet. Nightly commits do not receive versions or consume Micro numbers.
- **Stable** follows the newest qualifying `vYY.MM.Micro` tag reachable from `main`.

Changes may remain available through Nightly for any desired testing period. When they are ready for Stable, the maintainer runs the manual **Create stable release** GitHub Actions workflow from `main`. The workflow tests the exact `main` commit, calculates the next CalVer version, builds the release archive, creates the tag, and publishes the GitHub Release.

If `main` advances while the workflow is testing, the release stops and must be run again. Failures before the final publish step do not create a tag and therefore do not consume a version number. If GitHub creates a tag or partial release but its asset upload fails, repair or remove that partial release before running the workflow again.

## 4. When to increment

### First release of a month

Reset Micro to `0`:

- `v26.07.2` followed by the first August 2026 release becomes `v26.08.0`.

### Additional releases in the same month

Increase the highest existing Micro number by one regardless of whether the release contains features, maintenance changes, or an emergency fix:

- `v26.08.0` becomes `v26.08.1`, then `v26.08.2`.

Only canonical `vYY.MM.Micro` tags participate in this calculation. Nightly commits, prereleases, old-style letter suffixes, and unrelated tags are ignored.

## 5. Examples

| UTC release date | Change type | Version | Tag |
| --- | --- | --- | --- |
| August 12, 2026 | First release of the month | `26.08.0` | `v26.08.0` |
| August 20, 2026 | Feature or fix | `26.08.1` | `v26.08.1` |
| September 2, 2026 | First release of the next month | `26.09.0` | `v26.09.0` |
