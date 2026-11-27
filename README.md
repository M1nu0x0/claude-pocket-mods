# PocketMods

A Claude Code desktop mod: a pixel Pokémon lives over the chat in the Code tab. It walks on the top edge of the prompt box, jumps up onto message bubbles, code blocks and cards in the conversation, walks off their edges to drop back down, rests, and plays the sprite's own idle animation while standing. As the conversation scrolls, the ledges move with it, and the pet falls when one leaves from under it.

## Use

- `/pocket 25` picks a Pokémon by national dex number (1–1025), or one of PokéAPI's form numbers from 10001 on (megas, regional forms and the like). A number with no sprite says so.

The pet floats from a zero-width cell beside the prompt, so it draws over the conversation within the room the app gives floats above the prompt. A press on the pet picks it up; drag it and let go to drop it onto whatever is below.

Only the Claude Code desktop app is supported. The terminal, mobile and VS Code are not: `/pocket` is left out of the command menu in sessions the desktop app is not attached to, and nothing is drawn anywhere but the desktop app.

## How sprites arrive

Nothing Pokémon is bundled. On first use of a number, `hooks/sprite.py` (Python standard library only, `/usr/bin/python3`) downloads the Black/White animated sprite from the [PokéAPI sprites repository](https://github.com/PokeAPI/sprites) (falling back to the still sprite), decodes the GIF frames, keeps as many evenly spaced frames as fit the drawing's size limit (up to 12), and caches the pixels in the mod's store on your machine.

## Development

Commits run [Biome](https://biomejs.dev) lint and `tsc --noEmit` through [pre-commit](https://pre-commit.com). The type check reads the mod types in `.claude-plugin/types`, which `tsconfig.json` extends.

```sh
uv sync
uv run pre-commit install
uv run pre-commit run --all-files
```

## License and disclaimer

The code in this repository is MIT licensed (see `LICENSE`). The license covers this project's own code only and grants no rights to any third-party trademarks, artwork or data the mod fetches.

PocketMods is an unofficial, non-commercial fan project. It is not affiliated with, endorsed, sponsored or approved by Nintendo, Game Freak, Creatures Inc. or The Pokémon Company. "Pokémon" and all related names, characters and imagery are trademarks and copyrights of their respective owners. This project claims no ownership of, and asserts no rights over, any Pokémon intellectual property.

- This repository and the mod contain no Pokémon assets. Sprites are fetched at runtime from the [PokéAPI sprites repository](https://github.com/PokeAPI/sprites), whose images are copyright The Pokémon Company, and remain the property of their owners.
- PokéAPI is a separate community project. PocketMods is not affiliated with, or endorsed by, PokéAPI or its contributors.
- A fetched sprite is decoded into pixels and kept only in the mod's store on your own machine. The mod does not upload, share or redistribute it.
- The mod is free of charge, for personal, non-commercial use only.
- Rights holders with a concern can open an issue on this project's repository, and the project will respond promptly.

*Provided "as is", without warranty of any kind. This notice is not legal advice.*
