# Versions, and why old links keep working

A permalink carries the whole circuit, the input state and the view settings in its
fragment. That makes it self-contained, but not stable: what `#t=e&n=max` *means* is
decided by the build that reads it, and the meaning drifts. `n=max` picks a canonisation
rule that did not exist before v9. A view letter could be reused. The QASM dialect grows,
so a circuit that parses today may parse differently later.

So a released build does not ask a future build to interpret its links. **"copy link"
points at the frozen copy of the build that made it**, under `/v/<version>/`, and that
page never changes again.

```
https://quantum.fit.vut.cz/q-vis/v/v9/#c=…&t=e&n=max
                                  ^^^^ the build that wrote this link
```

The archived page says which version it is and offers the way back to the current one, so
nobody is stranded on an old build without noticing.

## What is archived

Every release tag — `v1`, `v2`, … — and nothing else. `tools/release.mjs` builds them all
on every deploy, each from its own source with its own `tools/build.mjs`, which is what
makes a copy faithful rather than merely old. The archive is therefore a function of the
repository alone: nothing is carried over from the previous publish, and a lost or
mangled deploy is repaired by running the workflow again.

`/v/` lists them. The site root is always the tip of `master`.

## Releasing

**Tag every deploy you want to be linkable.** An untagged build stamps itself `dev` and
copies plain links to the site root, which are as stable as the parameter format and no
more — fine for a work in progress, not for anything shared.

```
git tag -a v12 -m "One line saying what this release added"
git push origin master --atomic --follow-tags
```

The tag message is the description shown on `/v/`. Push the tag *with* the commit it
names: only `master` may deploy, so a tag push of its own is refused by the environment,
and the branch push is what rebuilds the archive. To tag a commit master has already moved
past, add the tag and then run the workflow by hand (Actions → CI → Run workflow).

Tag the commit you are deploying, not one behind it. The root build stamps itself with the
tag it is exactly at, and calls itself `dev` otherwise — an honest answer, since a build
one commit past `v11` is not `v11` — but a `dev` root copies plain links to the site root
instead of pinning them.

## How a build knows its own version

`tools/build.mjs` stamps `Q_VIS_VERSION` into a meta tag, defaulting to `dev`;
`tools/release.mjs` sets it from `git describe --tags --exact-match`. `ui.js` reads the
tag at run time and decides where a copied link should point — `archiveUrl` and `liveUrl`,
both pure functions of the current URL and the version, and both tested in
`tests/version.test.js`.

A build outside the release workflow, or a page opened from `file://`, has no archive to
point at, so it copies links to itself exactly as it always did.

## The older versions

`v1` to `v9` were tagged retroactively, at the commits that were deployed and worth
returning to. Links copied from those builds predate the whole scheme and still point at
the site root; the archive cannot fix that, but from `v10` on it holds.
