# Draft Overlay

A free Windows overlay for MTG Arena drafts. It puts each card's 17Lands public stats right on the
pack while you pick, and pairs with the [23spells draft trainer](https://23spells.pages.dev) for your
record, run reviews and practice.

**Download:** [23spells.pages.dev/overlay](https://23spells.pages.dev/overlay), or the newest
`Draft-Overlay-Setup.exe` under [Releases](../../releases/latest). One click, no admin. It updates
itself after that.

Mac: not yet.

## What it does

- Reads Arena's own log file while you draft and shows card stats on each card in the pack
  (games-in-hand win rate, grade and pick order).
- Opens Arena sealed pools in the 23spells deck builder.
- Optional: connect it to a 23spells save to keep your drafts, games and record on any device.

## What it does not do

- It only reads the log file. No memory reading, no code injection, no clicking or typing for you.
- It never sends opponent names or Arena account IDs anywhere. Those stay on your PC.
- Nothing leaves your PC unless you connect it to 23spells. What is stored and how to delete it:
  [23spells.pages.dev/#privacy](https://23spells.pages.dev/#privacy).

## Setup

The installer opens a three-step setup window. You can reopen it from the tray icon
(**Setup and settings...**).

1. **Arena found.** Install MTG Arena and open it once.
2. **Detailed Logs on.** In Arena: **Options → View Account → Detailed Logs (Plugin Support)**,
   then restart Arena. ([Arena's instructions](https://mtgarena-support.wizards.com/hc/en-us/articles/360000726823-Creating-Log-Files-on-PC-Mac-Steam))
3. **Connect to 23spells** (optional).

Windows may say "Windows protected your PC" because the installer isn't signed yet. Click
**More info → Run anyway**.

## Run from source

```bash
npm install
npm start        # build and run
npm test
npm run dist     # build the installer into dist/ (no auto-update feed)
npm run release  # maintainers: bump, build and publish a GitHub release
```

Card stats come from 23spells by default. `scripts/build-stats.mjs` builds them locally from the
17Lands public files instead.

## Data and credits

- Card statistics are built from [17Lands public datasets](https://www.17lands.com/public_datasets),
  licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). 17Lands does not endorse this
  project.
- Card images and data from [Scryfall](https://scryfall.com).
- This project started from [17-buddy](https://github.com/ratek-20/17-buddy) by Filippo Favali (MIT).
  The original code and its architecture notes are kept in `src/` and `docs/`.

## License

[MIT](LICENSE). The license covers this source code only. It grants no rights to MTG Arena imagery,
Magic card content, trademarks, 17Lands data or other third-party materials.

Draft Overlay is unofficial Fan Content permitted under the
[Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not approved or endorsed
by Wizards. Portions of the materials used are property of Wizards of the Coast. © Wizards of the
Coast LLC.
