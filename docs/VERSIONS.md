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
instead of pinning them. Since every push to master is a release, this does not come up
unless a release is pushed without its tag.

## Previewing

`/preview/` is the build of the `preview` branch, published so that a change can be
clicked through before it is public.

```
git push -f origin HEAD:preview       # from a feature branch or worktree
→ /preview/                           # refreshes within a minute
```

**The root does not move.** The deploy job checks out `master` whatever ref started it, so
a push to `preview` rebuilds and republishes the whole site with the public page unchanged.
That is a property of the workflow, not a habit to keep — `/preview/` is the only path a
preview push can affect.

It lives outside `/v/`, because everything in `/v/` is frozen forever and a preview is the
opposite: it changes without warning, and it disappears from the site on the next deploy
after the branch is deleted. Its pages carry `robots: noindex`, and `copy link` on a
preview points at the preview rather than at the root — a link to a draft should show the
draft. The masthead says `preview · open the current version`.

It is a public URL, not a private staging area. Anyone with the link can open it.

**Master only ever moves on a release.** Nothing lands there until Ondra has seen the
preview and says to deploy it, and it is tagged in the same push. So master is always
exactly at a tag, which is what keeps the root stamped with a version and its links
pinned; a root that is merely *near* a tag would call itself `dev` and stop pinning.

Promoting a preview is then the ordinary release: merge, tag, push, then delete the
branch.

```
git switch master && git merge <branch>
git tag -a v13 -m "One line saying what this release added"
git push origin master --atomic --follow-tags
git push origin --delete preview
```

A preview branch that does not build is survivable: the release script skips `/preview/`
and says so, and the site and the archive go out regardless.

## Two pages, two archives

This repository builds more than one page. `tools/build.mjs` lists them in `APPS`: each is
a shell, the module whose `boot` starts it, and the file it is written to.

| page | shell | entry | site path |
| --- | --- | --- | --- |
| the decision diagram | `dev.html` | `src/ui.js` | `/` |
| the automata tool | `aut-dev.html` | `src/aut-ui.js` | `/aut/` |

**Everything belonging to a page lives under that page's own base** — the build, its
archive, and its preview:

```
/            /v/<tag>/            /preview/
/aut/        /aut/v/<tag>/        /aut/preview/
```

That is not a filing preference. `archiveUrl` and `liveUrl` build their URLs *relative to
the page's own directory*, so a page served from `/aut/` already looks for `/aut/v/<tag>/`
and `/aut/preview/`. Laying the site out this way is what lets both pages share those two
functions untouched; the other arrangement, `/v/<tag>/aut/`, would mean rewriting them.

A tag older than a page cannot build it, since every ref is built by its own copy of
`tools/build.mjs`. Nothing insists that it can: whatever a tag's build script produced is
published and the rest is quietly absent, so a page's archive begins at the first release
that shipped it. Each page gets its own `/v/` index, and only once it has something to
index.

Both pages are built from the same tag and share one version sequence. `npm run build`
with no arguments builds every page; naming one builds only that one.

## How a build knows its own version

`tools/build.mjs` stamps `Q_VIS_VERSION` into a meta tag, defaulting to `dev`;
`tools/release.mjs` sets it from `git describe --tags --exact-match`, or to `preview` for
the preview branch. `ui.js` reads the
tag at run time and decides where a copied link should point — `archiveUrl` and `liveUrl`,
both pure functions of the current URL and the version, and both tested in
`tests/version.test.js`.

A build outside the release workflow, or a page opened from `file://`, has no archive to
point at, so it copies links to itself exactly as it always did.

## The older versions

`v1` to `v9` were tagged retroactively, at the commits that were deployed and worth
returning to. Links copied from those builds predate the whole scheme and still point at
the site root; the archive cannot fix that, but from `v10` on it holds.
