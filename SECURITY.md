# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through [GitHub's private vulnerability reporting](https://github.com/rashidul-hasan/drivedeck/security/advisories/new), or email Rashidul Hasan at rashidul69@gmail.com. You'll get a reply within a few days.

## The official package

The only official package is [`drivedeck`](https://www.npmjs.com/package/drivedeck) on npm, built from [github.com/rashidul-hasan/drivedeck](https://github.com/rashidul-hasan/drivedeck). Packages with similar names (`drive-deck`, `drivedeck-cli`, scoped copies and so on) are not from this project.

## How releases are protected

- **No one publishes from a laptop.** Every release is built and published by the [release workflow](.github/workflows/publish.yml) when a version tag is pushed. npm accepts releases only from that workflow (npm trusted publishing), and token-based publishing is turned off for the package, so a stolen password or token is not enough to publish a version.
- **Every release is signed.** Each version carries a provenance statement, signed through Sigstore, that names the exact commit and workflow run it was built from. It's shown under **Provenance** on the npm page.
- **Nothing runs on install and nothing else is downloaded.** DriveDeck has no dependencies and no install scripts. The package contains only `bin/`, `lib/`, `public/`, `README.md`, `LICENSE` and this file, which is checked before every release.
- **Releases need approval.** The release workflow runs in a protected environment that the maintainer has to approve, only for commits on `main`, with GitHub Actions pinned to exact commit hashes.

## Checking what you installed

Check that the package's signatures and provenance are valid:

```bash
npm install drivedeck
```

```bash
npm audit signatures
```

You should see `1 package has a verified registry signature` and `1 package has a verified attestation`. To see the commit a version was built from:

```bash
npm view drivedeck dist.attestations
```

If a version has no provenance, or it points anywhere other than `github.com/rashidul-hasan/drivedeck`, don't run it, and report it as described above.
