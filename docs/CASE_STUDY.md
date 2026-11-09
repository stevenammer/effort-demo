# Case study: how a spec, an attack and a bug became a rule

I don't write most of this code. Agents do. My job is to say what done looks like, try to break what comes back, and decide what's safe to ship. This is one small example of that loop, start to finish.

## The spec

I wrote one rule early and never moved it: **the original is sacred.** Whatever you type gets saved first, read back, and checked against a SHA-256 hash before the app says SAVED. Organizing your thoughts is a view on top. It's never a rewrite. If anything fails, the box keeps your words.

That's easy to say. It's harder to hold when everything around it is trying to be helpful.

## The attack

Nobody tests a rule like that by clicking around. So I went and read how other note apps break. Logseq users had reported a graph download that came back truncated. Joplin documented how it restores history separately instead of overwriting the current note. Monica had a bug where a date landed on the wrong day.

I turned each report into a question about my own app. If a restore file is cut in half, does it wipe what's already here? If a date is impossible, what does the app quietly do with it? An upstream bug isn't proof my app has the same bug. It's just a good place to look. Those questions are all in [RED_TEAM.md](RED_TEAM.md).

## The defect

One of them found something real. JavaScript will happily take February 31st and turn it into March 3rd without telling you. My metadata check trusted that. So a malformed timestamp could slide through looking valid, and a time that never existed could end up deciding what order your thoughts showed up in.

It wasn't dramatic. It was the kind of thing that sits quietly for months and then rearranges someone's history.

## The fix

A strict date check shared by everything that touches a timestamp. A calendar-valid ISO time or nothing. Bad metadata gets quarantined, and the original text is untouched. Then the part I care about most: a test that fails without the fix. I don't count a fix until I've watched the test fail first.

Sorting had the same flavor of problem. Valid timestamps with different UTC offsets were being compared as plain text, which could put things in the wrong order. Now the app sorts by the real instant and keeps the exact original string.

## What I take from it

- A spec is only as good as the attack you point at it.
- Reading other people's bug reports is a cheap way to find your own.
- "Tests pass" tells you what the tests cover. It doesn't tell you what you forgot to ask.

The honest part: this is a public walkthrough with fictional data, not the app on my phone, and plenty is still unfinished. The [dev log](CURRENT_STATE.md) says what's verified and what isn't. I'd rather you see that than a clean demo.
