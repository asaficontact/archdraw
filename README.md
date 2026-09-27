# reladraw

reladraw is a text language for diagrams where you say where things go.

**[Try it in your browser →](https://reladraw.github.io/reladraw/)**

Here's a diagram drawn by hand in draw.io:

![The reference diagram, drawn by hand](https://raw.githubusercontent.com/reladraw/reladraw/main/examples/reference/arch.png)

And here's the same diagram written in reladraw ([`examples/arch.reladraw`](examples/arch.reladraw)).

![The same diagram, rendered from reladraw source](https://raw.githubusercontent.com/reladraw/reladraw/main/docs/arch-render.png)

The positions in the second picture come from statements like `above-left of cluster.hub`, rather than an algorithm automatically determining placement.

## Why not Mermaid or draw.io?

Mermaid, Graphviz and D2 let you declare boxes and connections, then determine positions for you. If you have a particular picture in mind, these aren't the right tool.

On the other hand, tools like draw.io or Excalidraw allow absolute placement, but that means much more effort, whether for humans clicking and dragging nodes around or agents recalculating coordinates and editing verbose XML source code files.

![The two ends of the spectrum, with reladraw between them](https://raw.githubusercontent.com/reladraw/reladraw/main/docs/gap.png)

reladraw sits between those two extremes, aiming to have the benefits of a diagram language, like Mermaid, but also having the expressiveness and custom placement that you can get with draw.io. Positions are relative, so you don't have to manually pick coordinates. For example:

```
node app "Web app"
node app.ui  "Interface"
node app.api "API"  below app.ui

node store "Database"  right of app  level with app

edge app.api -> store  "queries"  from: right  to: left
```

See also [SYNTAX.md](SYNTAX.md) and [examples/](examples/).

## Install

```
npm install -g reladraw
reladraw diagram.reladraw -o diagram.svg
```

Or from a clone, which also gets you the examples:

```
npm install && npm run build
node dist/cli.js examples/arch.reladraw -o out.svg
```

## Using it with an agent

To install a skill to let your agent know how to use reladraw:

```
npx skills add reladraw/reladraw -g
```

That installs it for every agent you use (Claude Code, Codex, Cursor, Copilot and others), each in its own skills directory. Leave off `-g` to install it into the current project only. To install it for just one agent, name it with `-a`:

```
npx skills add reladraw/reladraw -g -a claude-code
```

That gets you a copy of the skill at the time you run it, so you'll need to re-run that command to get the latest skill when there is a new release.

## Status

Version 0.8.0. It's early, but it works. There's a parser, a layout engine and an SVG renderer in TypeScript with no runtime dependencies, plus a command-line tool that turns a text file into a standalone SVG. The comparison at the top of this page is that tool run on [`examples/arch.reladraw`](examples/arch.reladraw).

The language isn't stable yet, so expect the syntax to change.

## License

Apache-2.0. See [LICENSE](LICENSE).

The license covers the code, not the name. It grants no rights to "reladraw", the project logo or the project's other marks. See [NOTICE](NOTICE).

## Contributing

Issues are welcome. Particularly helpful is a diagram you could not represent in reladraw. While the language is still changing quickly, an issue helps more than a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).
