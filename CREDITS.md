# Credits and third-party notices

Helm's own code is licensed under the GNU GPL v3 (see [LICENSE](LICENSE) and [LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md)). The items below are
**not covered by the GPL**; each keeps its own license.

## Background photos (Unsplash License, not covered by the GPL)

The 23 bundled backgrounds in `ui/assets/backgrounds/` (and their `thumbs/`) are photos from
[Unsplash](https://unsplash.com), used under the [Unsplash License](https://unsplash.com/license). The
Unsplash License is not an open-source license: you may use, copy and modify the photos, but you may not
sell unaltered copies or compile them into a similar or competing photo service. Per-photo details,
including download dates, are in [ui/assets/backgrounds/CREDITS.md](ui/assets/backgrounds/CREDITS.md).

| File | Title | Photographer | Photo page |
| --- | --- | --- | --- |
| `stone.jpg` | Stone summit | Fabrizio Conti | https://unsplash.com/photos/grayscale-photography-of-mountain-with-smoke-_sK7own3aaw |
| `cloud-peaks.jpg` | Peaks in cloud | Andreas Kind | https://unsplash.com/photos/bUhzlj3gGso |
| `valley-fog.jpg` | Valley fog at dusk | Arindam Saha | https://unsplash.com/photos/PwzISwC2kLs |
| `forest.jpg` | Misty forest | Vulpyr Photography | https://unsplash.com/photos/a-forest-filled-with-lots-of-trees-covered-in-fog-wECBJIxVaNw |
| `misty-woods.jpg` | Misty woods | Tobias Tullius | https://unsplash.com/photos/PXXtq6bp6cs |
| `pine-slope.jpg` | Pine slope in mist | Dorel Gnatiuc | https://unsplash.com/photos/rlXgUH7Sh_I |
| `lake.jpg` | Quiet lake | Kevin Lien | https://unsplash.com/photos/green-trees-near-body-of-water-during-daytime-BB6BKzk1xFs |
| `misty-lake.jpg` | Misty lakeshore | Dustin Scarpitti | https://unsplash.com/photos/RdF3apSExR0 |
| `crater-lake.jpg` | Crater lake | Stephen Daws | https://unsplash.com/photos/9KREEQaN7gQ |
| `foggy-cliffs.jpg` | Foggy cliffs | Urban Vintage | https://unsplash.com/photos/DNXWtB33WWE |
| `rolling-wave.jpg` | Rolling wave | Silas Baisch | https://unsplash.com/photos/ceITO2rlDgc |
| `desert-dunes.jpg` | Rolling dunes | Wolfgang Hasselmann | https://unsplash.com/photos/pVr6wvUneMk |
| `night-dune.jpg` | Dune at night | Daniel Olah | https://unsplash.com/photos/6KQETG8J-zI |
| `crescent-moon.jpg` | Crescent moon | Jeremy Bishop | https://unsplash.com/photos/B3hNQbPSg0I |
| `night-fjord.jpg` | Fjord at night | Henry Gressmann | https://unsplash.com/photos/yZ9aHFVxLvc |
| `snow-peak.jpg` | Snow peak | Daniel Leone | https://unsplash.com/photos/g30P1zcOzXo |
| `snow-ridge.jpg` | Windswept ridge | Alessio Soggetti | https://unsplash.com/photos/IuSemNxGS88 |
| `tower-fog.jpg` | Tower above fog | Marleen Trommelen | https://unsplash.com/photos/IT4Za_Q_dTA |
| `city-valley.jpg` | Valley city at dusk | Alberto Restifo | https://unsplash.com/photos/HYA9Ak06qR8 |
| `sand-ripples.jpg` | Sand ripples | Sumner Mahaffey | https://unsplash.com/photos/7Y0NshQLohk |
| `dark-water.jpg` | Dark water | David Angel | https://unsplash.com/photos/NwH8vv448IY |
| `open-sea.jpg` | Open sea | yucar studios | https://unsplash.com/photos/cfR-V1QuEKw |
| `fog-flow.jpg` | Fog flow | Zetong Li | https://unsplash.com/photos/1GtQt88RLd8 |

## Vendored JavaScript (`ui/vendor/`)

Copied from npm by `tools/vendor.js`; each file keeps its original license header where it had one.

| File | Package | License |
| --- | --- | --- |
| `preact.js`, `preact-hooks.js` | preact 10.29.8 | MIT |
| `signals.js`, `signals-core.js` | @preact/signals 2.11.3, @preact/signals-core 1.14.4 | MIT |
| `htm.js` | htm 3.1.1 | Apache-2.0 |
| `marked.js` | marked 15.0.12 | MIT |
| `purify.js` | DOMPurify 3.4.16 | MPL-2.0 or Apache-2.0 |
| `diff.js` | diff (jsdiff) 7.0.0 | BSD-3-Clause |
| `hljs.js`, `hljs-powershell.js` | highlight.js 11.12.0 (@highlightjs/cdn-assets) | BSD-3-Clause |

## Fonts and marks

- No fonts are bundled. The UI uses the system font (Segoe UI) by name.
- The Helm wordmark is Manrope SemiBold (SIL Open Font License 1.1) converted to SVG outlines.
- Helm's icon and logo are Helm's own design.

## Claude Code and the Claude Agent SDK (proprietary, not included)

Helm drives your own installation of Claude Code through `@anthropic-ai/claude-agent-sdk`. That package,
its platform packages (which contain the `claude` executable) and Claude Code itself are proprietary
software of Anthropic PBC, used under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).
They are not part of this repository, are not covered by the GPL, and are never redistributed with Helm:
`npm install` downloads the SDK from npm under Anthropic's terms. `@anthropic-ai/sdk` is MIT-licensed.

Helm is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
