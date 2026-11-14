# herdr-board: how changes get made

- The GitHub repo (origin, `RomainBdt/herdr-board`) is the source of truth.
- Changes are driven from a card: each card works in its own worktree on branch `card/<id>`, and is committed there.
- In the main checkout (this folder) you only test. Do not commit to `main` here, and do not leave edits here.
- To ship a change: push the card branch and open a pull request on the master repo. Once it is merged, pull `main` here.
- To get a change onto this machine, run `git pull --ff-only` on `main`. Never reset or discard local work without asking.
