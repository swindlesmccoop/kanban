# Kanban

I wanted a checklist-focused kanban without anything complicated like running a full database. Everything lives in one JSON file you can open in a text editor.

## Features
- Multiple boards, shown as tabs along the top (drag a tab to reorder)
- Cards you can drag around a board, or send to another board from the card's ⋯ menu
- Tasks inside cards, and subtasks inside tasks
  - Drag tasks between cards and subtasks between tasks using the dotted handles
- Card colours, notes, and "Clear completed"
- Live sync: change something on your phone and any other open device updates on its own
- Installable as a PWA, and keeps the last copy of your boards around for read-only viewing when offline
- Optional password

## Run it

### Compose
```bash
git clone https://github.com/swindlesmccoop/kanban
cd kanban
cp .env.example .env
docker compose up -d --build
```
The compose file expects an external Docker network named `proxynet` and publishes no host port, since it's meant to sit behind a reverse proxy such as Caddy. Installing it as an app on a phone needs HTTPS, which Caddy takes care of.
- To reach it directly while testing, add a `ports` entry (for example `"4050:4050"`) to a local copy of `compose.yaml`, then open `http://<host>:4050`.

## Configure
Everything is in `.env`; see `.env.example` for the full list.

- `APP_PASSWORD` turns on a login screen. Leave it blank if Caddy (or your LAN) already handles access. Logins last a year per device, and changing the password signs everything out.
- `PUID`/`PGID` should match your user, so the data file stays editable without sudo.

## Data
On first run, with no `data/kanban.json` yet, the app starts with the demo boards from `examples/kanban.json`, which show off every feature. Delete the boards you don't want, or delete `data/kanban.json` and restart to get them back.

Boards are stored in `data/kanban.json`. Order in the file is the order on screen:

```json
{
  "version": 1,
  "boards": [
    { "id": "b1a2b3c4", "name": "Home", "cards": [
      { "id": "c1a2b3c4", "title": "Shopping", "notes": "", "color": null, "tasks": [
        { "id": "t1a2b3c4", "text": "Walmart", "done": false, "subtasks": [
          { "id": "s1a2b3c4", "text": "Milk", "done": false }
        ] }
      ] }
    ] }
  ]
}
```

You can edit it by hand while the app is running; it notices within a second or so and reloads. Missing ids and fields get filled in, so a new card can be as short as `{ "title": "Ideas" }`. If the file doesn't parse, the app logs why and keeps what it had until you fix it. Card colours are `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink` or `null`.

To back up your boards, you only need to copy out the JSON file.

## Integration API
Other apps (e.g. Voice Notes, calling `http://kanban:4050` over `proxynet`) can file items with these JSON endpoints. Board names and card titles match trimmed and case-insensitively. Tasks are keyed by the caller's own id, stored on the task as `ext` and unique per board, so sending the same id twice never duplicates anything. If `APP_PASSWORD` is set, these need the login cookie like the rest of `/api`.

- `PUT /api/v1/boards/by-name/:name` finds or creates a board and returns `{ id, name, cards: [{ id, title }] }`.
- `GET /api/v1/boards/:id` returns the same shape.
- `PUT /api/v1/boards/:boardId/cards/by-title/:title` finds or creates a card and returns `{ id, title }`. Rename it with `PATCH /api/items/:id` and `{ "title": "..." }`.
- `PUT /api/v1/boards/:boardId/tasks/:ext` with `{ "cardId": "c...", "text": "...", "position": "top" | "bottom" }` creates the task (201) or updates it (200), returning `{ id, ext, cardId, created }`. A task already in that card keeps its place and done state and only gets new text; one in another card moves to `cardId` at `position`. `position` defaults to `bottom`.
- `DELETE /api/v1/boards/:boardId/tasks/:ext` removes the task and returns 204, also when it's already gone.

A missing board or card gives 404, bad input 400, both as `{ "error": "..." }`.
