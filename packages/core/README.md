# @effort/core

The thinking behind E.F.F.O.R.T., as a small library with no dependencies. It's plain ES modules, so it runs in Node and in a browser.

> Alpha. This is the first piece of the real app's logic to be published as a library. The interactive demo uses a generated copy of these files, and a test fails if the copy drifts.

## What's in it

| Module | What it does |
|---|---|
| `capture` | Save-first records. `createCapture` keeps the exact original text and its SHA-256. `verifySaved` reads it back and re-hashes it, so you never say SAVED unless the saved bytes match. |
| `ef` | The organizer. Turns a pile of text into DO, WAITING ON, QUESTIONS, IDEAS and NOTES, keeping every exact quote. It's deterministic and conservative, with no model and no network. |
| `semantic` | The sentence classifier that `ef` uses. When it isn't sure, it says `unclear` instead of guessing. |
| `readable` | A safe reader for display. It never runs source HTML or fetches remote images. |
| `now` | Picks the one thing to do now, with a readable reason. Something you said you'd do wins over something that merely reads like a next step. |

## Use it

Hashing is passed in, so the same code works everywhere. In Node:

```js
import { createHash } from 'node:crypto';
import { createCapture, verifySaved } from '@effort/core/capture';
import { chooseNow } from '@effort/core/now';

const sha256 = async (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const record = await createCapture(
  { id: 'a1', text: 'Call the dentist about the invoice', createdAt: new Date().toISOString() },
  sha256,
);
await store.append(record);                       // any store with append and get
console.log(await verifySaved(store, 'a1', sha256)); // true only if the saved text still matches
console.log(chooseNow([record]).reason);
```

In a browser, pass a function that uses `crypto.subtle.digest` instead.

## The rules it keeps

- The original is never changed. Organizing is a view, not a rewrite.
- A save only counts after it's read back and the hash matches.
- Nothing becomes a commitment on its own. NOW comes from what you chose.

Storage adapters live in [`../storage`](../storage). A command line tool that uses all of this is in [`../../apps/cli`](../../apps/cli).

MIT licensed.
