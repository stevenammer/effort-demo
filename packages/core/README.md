# @effort/core

The thinking behind E.F.F.O.R.T., as a small library with no dependencies. It's plain ES modules, so it runs in Node and in a browser.

> Alpha. This is the first piece of the real app's logic to be published as a library. The interactive demo uses generated copies of the organizer and reader; drift checks protect those copies. The CLI also uses the shared continuity service.

## What's in it

| Module | What it does |
|---|---|
| `export` | Deterministic `effort-export/1` bundles, per-entry and manifest hashes, verification, add-only restore and quarantine preservation. |
| `capture` | Save-first records. `createCapture` keeps the exact original text and its SHA-256. `verifySaved` reads it back and re-hashes it, so you never say SAVED unless the saved bytes match. |
| `ef` | The organizer. Turns a pile of text into DO, WAITING ON, QUESTIONS, IDEAS and NOTES, keeping every exact quote. It's deterministic and conservative, with no model and no network. |
| `semantic` | The sentence classifier that `ef` uses. When it isn't sure, it says `unclear` instead of guessing. |
| `readable` | A safe reader for display. It never runs source HTML or fetches remote images. |
| `now` | Legacy recommendation ranking with a readable reason. It does not activate work or create commitments. |
| `continuity` | Explicit promotion, one chosen active commitment, exact source history, self-reported completion and hold/resume through atomic storage. |
| `states` | Neutral candidate/review and commitment vocabulary. |
| `interrupt` and `night` | Deterministic attention budgets, quiet hours and advisory night friction. |

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

### Continuity

`createContinuity` in `continuity.js` uses a single sealed derived record and
an adapter's atomic compare-and-swap. Callers inject hashing, time, and IDs.
Actions require `{ authority: 'human', commandId }`: this states the caller's
intent and is not identity authentication. Retry an uncertain result using the
same command ID and arguments. A checksum detects accidental corruption; it
is not a signature or proof of authorship. Captures and suggestions never
create commitments. Promotion requires an exact UTF-16 slice of a verified
capture, and activation is a separate deliberate action. Completion receipts
are self-reports. Source changes and invalid histories stop operations instead
of rewriting originals or repairing away history. Limits are 10,000 commands,
2,000 commitments, 2,000 return points, and 4 MiB encoded continuity state;
reaching a limit refuses the write without trimming records.

`interrupt.js` and `night.js` provide deterministic policies. Time and settings
are supplied by the caller; night friction is advisory and grants no authority.
Equal quiet start and end hours mean quiet hours are disabled. All other ranges
include the start hour and exclude the end hour, including overnight ranges.

Every persisted commitment source, including inactive and terminal history, is reverified before returning or changing continuity. A consumed return point rejects a new resume command; retries using its original command ID acknowledge the prior operation without selecting work again. Unknown version-1 state fields are refused rather than discarded.
