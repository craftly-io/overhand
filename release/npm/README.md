# overhand

Mission control for your AI coding agents, on your own machine.

```sh
npx overhand start    # or: bunx overhand start
```

The first run downloads the Overhand release package for your machine from GitHub, checks its SHA-256 (and, with cosign
2.5 or newer installed, the release workflow's Sigstore signature on the sums) and keeps it in
`~/.overhand/npm/<version>`; every run after that starts it directly. Other ways to install, and the full docs:
<https://github.com/craftly-io/overhand>.

This package is only the launcher; the version on npm matches the GitHub release it runs.
