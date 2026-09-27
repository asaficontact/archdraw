# Contributing to reladraw

Thanks for looking. The most useful thing you can send is not code — it is a
diagram you tried to write and could not.

## What is most wanted

**Diagrams that the language cannot express.** This is the highest-value
contribution by a wide margin. reladraw is built on the claim that you can state
an arrangement in the terms a person would use out loud and get that arrangement
back. Every gap in that claim so far has been found by pushing a real diagram
through it, and each one produced a language change rather than a code fix. If
you sketched something and could not say it in `.reladraw`, open an issue with the
sketch and what you tried. That is a finding, not a support request.

**Bugs, with a reproduction.** The smallest `.reladraw` file that shows the problem,
the command you ran, and what you expected instead. Rendered output helps but
the source file is what matters.

**Feature requests.** Say what you were trying to draw. A request framed as a
diagram you wanted is far easier to act on than one framed as a syntax proposal,
because the syntax is the part I can work out and the need is the part I cannot.

**Questions about the design.** If something in [README.md](README.md) or
[SYNTAX.md](SYNTAX.md) is unconvincing or unclear, that is worth an issue too.

Open all of these as [GitHub issues](https://github.com/reladraw/reladraw/issues).

## About pull requests

Please open an issue rather than a pull request, at least for now.

reladraw is changing quickly. The language is still being designed, and the code underneath it gets reorganized often, sometimes several times a week. A patch written against today's code may not fit next week's, and I would rather not put anyone through several rounds of revising a pull request to chase a moving target.

If you do send one, thank you — it will be read. It shows exactly what you wanted and how you thought it should work, and that is useful. But don't be surprised, or feel bad, if the change lands written a different way. That is not a judgment on your code; it usually means it had to fit something else that was changing at the same time.

The problem you hit is the most valuable part. A clear issue describing what you were trying to do will usually get the fix in faster than a pull request would.

## Getting the code running

```
npm install
npm run build
node dist/cli.js examples/arch.reladraw -o out.svg
```

No runtime dependencies; TypeScript and Node 18+ are all that is needed.
