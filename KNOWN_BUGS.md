# Known Bugs

---

`jj pr <revset>` is inherently brittle.

if a PR is to be added to the stack, it must be included along with all the other
stack members in `<revset>`.

we should do something like `jj pr create <cid> <cid> <cid>`

to start a stack with 3 change IDs.

followup `jj pr create <cid>` should understand the already created stack,
and know how to handle

---

`jj git push -c <cid>` creates a branch based on the `git_push_bookmark`:

```toml
[template-aliases]
'git_push_bookmark' = '"ta/push/" ++ change_id.short()'
```

imagine change with id `jklmno`.

this creates `ta/push/jklmno`.

if I move the bookmark to point to `mnopqr`, then `jj git push -c jklmno` is going to try
and recreate the bookmark with a name that already exists and points elsewhere.

this is sort of a bug / oversight / rough edge with `jj git push -c`. we should be resilient to it, by creating `ta/push/jklmno-2` (or similar).

---
